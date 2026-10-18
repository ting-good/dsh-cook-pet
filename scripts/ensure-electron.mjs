#!/usr/bin/env node
/**
 * 获取 Electron 运行时（桌面置顶窗需要）。
 *
 * ── 为什么需要这一步 ───────────────────────────────────────────────────────────
 * DSH 宿主进程是**纯 Node**（`process.versions.electron` 为 undefined），
 * 系统里通常也没有独立的 Electron 二进制，所以桌面 helper 必须自带一份。
 *
 * ── 怎么做到"用户不用敲命令" ───────────────────────────────────────────────────
 * 本脚本既可以被手动执行，也可以由**宿主插件在后台自动调用**（lib/index.js 里
 * 首次拉起桌面窗失败时触发一次，静默下载，下个 DSH 周期就能用）。
 * 所以它刻意**零依赖**：
 *   · 下载：Node 18+ 内置 `fetch`
 *   · 解压：win 用系统 `Expand-Archive`，mac/linux 用 `unzip`（都是系统自带）
 * 这样不需要 `@electron/get` 之类的运行时依赖，也就不破坏"无运行时依赖"这条发布约束。
 *
 * ── 策略 ───────────────────────────────────────────────────────────────────────
 *   1. 先找 4 类**已知位置**（手工指定 → 本插件下载处 → 别的插件下载处 → node_modules）
 *   2. 都没有才下载，默认走 npmmirror 镜像（国内可达），解压到 $DSH_HOME/electron
 *   3. 已存在的绝不重下（100+ MB，重复下载很痛）
 *
 * 环境变量：
 *   DSH_HOME                      DSH 主目录（默认 ~/.dsh）
 *   DSH_COOK_PET_ELECTRON         Electron 可执行文件路径（最高优先级）
 *   DSH_COOK_PET_ELECTRON_VERSION 版本（默认 43.3.0）
 *   DSH_COOK_PET_ELECTRON_MIRROR  镜像（默认 npmmirror）
 *
 * 用法：
 *   node scripts/ensure-electron.mjs           # 找或装，成功打印可执行文件路径
 *   node scripts/ensure-electron.mjs --check   # 只检查不下载（未就绪退出码 1）
 *   node scripts/ensure-electron.mjs --quiet   # 静默（供宿主自动调用）
 */

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const QUIET = process.argv.includes('--quiet');
const CHECK_ONLY = process.argv.includes('--check');
const say = (...a) => {
  if (!QUIET) console.log(...a);
};
const warn = (...a) => {
  if (!QUIET) console.error(...a);
};

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh');
const VERSION = process.env.DSH_COOK_PET_ELECTRON_VERSION || '43.3.0';
const MIRROR = (process.env.DSH_COOK_PET_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/').replace(
  /\/?$/,
  '/',
);
const TARGET_DIR = resolve(DSH_HOME, 'electron');

/** 当前平台下 Electron 可执行文件在解压目录里的相对路径 */
const ELECTRON_REL =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

/** 平台 → Electron 发布包名后缀 */
function artifactSuffix() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  if (process.platform === 'win32') return `win32-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  return `linux-${arch}`;
}

/**
 * 候选路径，按优先级排列。
 * 我们的目录放最前，其次复用别的插件已下载的那份 —— 同一台机器上
 * 两个插件没必要各下一份 100 MB 的 Electron。
 */
function candidates() {
  const list = [];
  if (process.env.DSH_COOK_PET_ELECTRON) list.push(process.env.DSH_COOK_PET_ELECTRON);
  list.push(join(TARGET_DIR, ELECTRON_REL));
  // 常见于其它 DSH 插件的下载位置（同一份 Electron 没必要各存一份 100 MB）
  list.push(join(DSH_HOME, 'electron', ELECTRON_REL));
  // 本机 node_modules 里装过 electron 的情况
  for (const base of [process.cwd(), DSH_HOME]) {
    list.push(join(base, 'node_modules', 'electron', 'dist', ELECTRON_REL));
  }
  return list;
}

/** 找一个已就绪的 Electron，找不到返回 undefined */
export function findExisting() {
  for (const p of candidates()) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

/** 用系统自带的解压能力（不引入任何 npm 依赖） */
function unzip(zipPath, destDir) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: QUIET ? 'ignore' : 'inherit', windowsHide: true },
    );
    return;
  }
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], {
    stdio: QUIET ? 'ignore' : 'inherit',
  });
}

/** 下载并解压 Electron；返回可执行文件路径 */
export async function download() {
  const url = `${MIRROR}v${VERSION}/electron-v${VERSION}-${artifactSuffix()}.zip`;
  say(`[ensure-electron] 未找到 Electron，开始下载 v${VERSION}（约 100 MB，镜像 ${MIRROR}）…`);
  say(`[ensure-electron] ${url}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') || 0);

  const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-cook-pet-electron-'));
  const zipPath = join(tmpDir, 'electron.zip');
  try {
    // 流式落盘 + 进度（100 MB 下得动，但用户需要知道它在动）
    let received = 0;
    let lastPct = -1;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      if (!QUIET && total > 0) {
        const pct = Math.floor((received / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          say(`[ensure-electron]   ${pct}%  (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`);
        }
      }
    });
    await pipeline(source, createWriteStream(zipPath));

    say(`[ensure-electron] 下载完成，解压到 ${TARGET_DIR} …`);
    mkdirSync(TARGET_DIR, { recursive: true });
    unzip(zipPath, TARGET_DIR);

    const exe = join(TARGET_DIR, ELECTRON_REL);
    if (!existsSync(exe)) throw new Error(`解压后未找到 ${ELECTRON_REL}`);
    say(`[ensure-electron] 完成：${exe}`);
    return exe;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const found = findExisting();
  if (found) {
    // 成功时**只**打印路径：宿主侧要把它当作返回值解析
    console.log(found);
    return 0;
  }
  if (CHECK_ONLY) {
    warn('[ensure-electron] Electron 未就绪（--check 模式不下载）');
    return 1;
  }
  try {
    const exe = await download();
    console.log(exe);
    return 0;
  } catch (e) {
    warn(`[ensure-electron] 失败：${e instanceof Error ? e.message : String(e)}`);
    warn('提示：可手工下载 Electron 后设置 DSH_COOK_PET_ELECTRON=<可执行文件路径>');
    return 1;
  }
}

// 仅在被直接执行时跑 main（被 import 时只导出函数）
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.slice(1))) {
  process.exit(await main());
}

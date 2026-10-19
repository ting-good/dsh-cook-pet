#!/usr/bin/env node
/**
 * 获取 Electron 运行时（桌面置顶窗需要）。
 *
 * ── 为什么需要这一步 ───────────────────────────────────────────────────────────
 * DSH 宿主进程是**纯 Node**（`process.versions.electron` 为 undefined），
 * 系统里通常也没有独立的 Electron 二进制，所以桌面 helper 必须自带一份。
 *
 * ── 怎么做到"用户不用敲命令" ───────────────────────────────────────────────────
 * 本脚本既可以被手动执行，也可以由**宿主插件在后台自动调用**（lib/desktop.js 里
 * 首次拉起桌面窗失败时触发一次，静默下载，下个 DSH 周期就能用）。
 * 所以它刻意**零依赖**：
 *   · 下载：Node 18+ 内置 `fetch`
 *   · 解压：win 用系统 `Expand-Archive`，mac/linux 用 `unzip`（都是系统自带）
 *
 * ── 下载的健壮性（v1.1：来自两位真实用户的安装反馈）───────────────────────────
 *   · 多镜像回退：npmmirror → registry.npmmirror → huaweicloud，逐个尝试
 *   · 有限重试：每个镜像 3 次，退避 2s/4s；全部失败才报错
 *   · 断点续传：进度落在 $DSH_HOME/electron/.download/*.part，
 *     重试/重跑都从已下载的字节继续（镜像均支持 Range，已实测 206）
 *   · 停滞超时：连续 60s 无数据判定卡死，主动放弃本次尝试（防挂死）
 *   · 完整性校验：下载字节数必须与 Content-Length/Range 总长一致才解压
 *   · 失败指引：**无论是否 --quiet**，最后都打印可照抄的手动安装步骤
 *     （宿主用 stdio:pipe 接管了 stderr，这些指引会进 DSH 的日志）
 *
 * ── 策略 ───────────────────────────────────────────────────────────────────────
 *   1. 先找 4 类**已知位置**（手工指定 → 本插件下载处 → 别的插件下载处 → node_modules）
 *   2. 都没有才下载；已存在的绝不重下（100+ MB，重复下载很痛）
 *
 * 环境变量：
 *   DSH_HOME                      DSH 主目录（默认 ~/.dsh）
 *   DSH_COOK_PET_ELECTRON         Electron 可执行文件路径（最高优先级，跳过下载）
 *   DSH_COOK_PET_ELECTRON_VERSION 版本（默认 43.3.0）
 *   DSH_COOK_PET_ELECTRON_MIRROR  自定义镜像前缀（设置后**只用**它；自动拼 v<版本>/）
 *
 * 用法：
 *   node scripts/ensure-electron.mjs           # 找或装，成功打印可执行文件路径
 *   node scripts/ensure-electron.mjs --check   # 只检查不下载（未就绪退出码 1）
 *   node scripts/ensure-electron.mjs --quiet   # 安静（供宿主自动调用；失败指引仍会打印）
 */

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

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
const TARGET_DIR = resolve(DSH_HOME, 'electron');
/** 断点续传的进度目录（藏在运行时目录下，成功后自动清理） */
const PART_DIR = join(TARGET_DIR, '.download');

/**
 * 镜像列表（已实测均支持 Range 断点续传，返回 206）。
 * {V} 是版本占位符 —— 不同镜像的目录风格不一样（npmmirror 带 v 前缀，华为云不带），
 * 所以存模板而不是拼死字符串。
 */
const DEFAULT_MIRRORS = [
  'https://npmmirror.com/mirrors/electron/v{V}/',
  'https://registry.npmmirror.com/-/binary/electron/v{V}/',
  'https://mirrors.huaweicloud.com/electron/{V}/',
];
/** 自定义镜像：设置后只用它（保持旧语义），按 `v<版本>/` 拼接 */
const MIRRORS = process.env.DSH_COOK_PET_ELECTRON_MIRROR
  ? [`${process.env.DSH_COOK_PET_ELECTRON_MIRROR.replace(/\/?$/, '/')}v{V}/`]
  : DEFAULT_MIRRORS;

/** 每个镜像的重试次数（3 次 × 3 个镜像 = 最多 9 次尝试，覆盖间歇性抽风） */
const ATTEMPTS_PER_MIRROR = 3;
/** 连续这么多毫秒没收到数据就判定卡死（防"永远挂着不动"） */
const STALL_TIMEOUT_MS = 60_000;

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

/** 本次要下载的 zip 文件名（带版本和平台，换版本不会误用旧进度） */
function artifactName() {
  return `electron-v${VERSION}-${artifactSuffix()}.zip`;
}

/** 镜像前缀模板 → 完整下载 URL */
function mirrorUrl(prefix) {
  return prefix.replace('{V}', VERSION) + artifactName();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * 从单个 URL 下载一次（带断点续传 + 停滞超时）。
 * 进度文件：$DSH_HOME/electron/.download/<artifact>.part —— 跨进程/跨次运行保留。
 * @returns {Promise<string>} 下载完成后的 zip 路径（未解压、未清理）
 */
async function downloadOnce(url) {
  mkdirSync(PART_DIR, { recursive: true });
  const partPath = join(PART_DIR, artifactName() + '.part');
  const offset = existsSync(partPath) ? statSync(partPath).size : 0;
  if (offset > 0) {
    say(`[ensure-electron] 断点续传：本地已有 ${(offset / 1048576).toFixed(1)} MB，从该处继续`);
  }

  const ac = new AbortController();
  let stallTimer = null;
  /** 每收到数据就重置停滞计时；连续 STALL_TIMEOUT_MS 无数据 → abort 本次尝试 */
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => ac.abort(new Error(`连续 ${STALL_TIMEOUT_MS / 1000}s 无数据，判定下载停滞`)),
      STALL_TIMEOUT_MS,
    );
  };

  try {
    armStall();
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      // 有本地进度时请求从 offset 开始 —— 镜像都支持 Range（实测 206）
      headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    let total = 0;
    let start = 0;
    if (res.status === 206) {
      // "bytes 123-456/7890" → 末段就是总长度；起点应等于我们请求的 offset
      const cr = String(res.headers.get('content-range') || '');
      total = Number(cr.split('/')[1]) || 0;
      start = offset;
      if (!cr.startsWith(`bytes ${offset}-`) && !cr.startsWith(`bytes=${offset}`)) {
        // 服务器没有按请求的偏移返回（罕见）→ 丢弃进度重新完整下载
        rmSync(partPath, { force: true });
        start = 0;
      }
    } else if (res.status === 200) {
      total = Number(res.headers.get('content-length') || 0);
      if (offset > 0) {
        say('[ensure-electron] 该镜像不支持断点续传，重新完整下载');
        rmSync(partPath, { force: true });
        start = 0;
      }
    } else if (res.status === 416) {
      // 本地进度已超过文件长度（通常是换了版本/文件）→ 删掉重来
      rmSync(partPath, { force: true });
      throw new Error('本地进度异常（416），已清除，将在重试时完整下载');
    }

    // 流式落盘 + 进度（append：续传时接着写；否则整写）
    let received = 0;
    let lastPct = -1;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      armStall();
      received += chunk.length;
      if (!QUIET && total > 0) {
        const pct = Math.floor(((start + received) / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          say(
            `[ensure-electron]   ${pct}%  (${((start + received) / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`,
          );
        }
      }
    });
    await pipeline(source, createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' }));

    // 完整性校验：字节数必须与服务器声明一致，否则视为不完整（保留进度供下次续传）
    const finalSize = statSync(partPath).size;
    if (total > 0 && finalSize !== total) {
      throw new Error(`下载不完整（${finalSize} / ${total} 字节），进度已保留`);
    }
    return partPath;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}

/** 下载并解压 Electron；返回可执行文件路径 */
export async function download() {
  let lastErr;
  for (const mirror of MIRRORS) {
    const url = mirrorUrl(mirror);
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MIRROR; attempt++) {
      try {
        const zipPath = await downloadOnce(url);

        // PowerShell 的 Expand-Archive 只认 .zip 扩展名，.part 会报
        // NotSupportedArchiveFileExtension —— 解压前先改回 .zip
        const properZip = zipPath.replace(/\.part$/, '.zip');
        renameSync(zipPath, properZip);

        say(`[ensure-electron] 下载完成，解压到 ${TARGET_DIR} …`);
        mkdirSync(TARGET_DIR, { recursive: true });
        try {
          unzip(properZip, TARGET_DIR);
        } catch (e) {
          // zip 损坏没法续传：删掉进度，让下一次重试完整重下
          rmSync(properZip, { force: true });
          throw new Error(`压缩包解压失败（可能下载损坏）：${e instanceof Error ? e.message : String(e)}`);
        }
        rmSync(properZip, { force: true });

        const exe = join(TARGET_DIR, ELECTRON_REL);
        if (!existsSync(exe)) throw new Error(`解压后未找到 ${ELECTRON_REL}`);
        say(`[ensure-electron] 完成：${exe}`);
        return exe;
      } catch (e) {
        lastErr = e;
        say(
          `[ensure-electron] 尝试失败（${attempt}/${ATTEMPTS_PER_MIRROR}，${url}）：` +
            (e instanceof Error ? e.message : String(e)),
        );
        if (attempt < ATTEMPTS_PER_MIRROR) await sleep(2000 * attempt);
      }
    }
  }
  throw new Error(
    `${MIRRORS.length} 个镜像 × ${ATTEMPTS_PER_MIRROR} 次尝试均失败：` +
      (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  );
}

/**
 * 失败后的手动安装指引。
 * ★ 刻意**不受 --quiet 影响**：宿主是用 quiet 模式拉起本脚本的，
 *   但失败时用户必须能看到怎么办 —— 否则就是一个无声消失的桌宠。
 * ★ 宿主侧（lib/desktop.js）用 stdio:pipe 接管了 stderr，
 *   这里打印的每一行都会进 DSH 的日志。
 */
function printManualHelp(err) {
  const self = fileURLToPath(import.meta.url);
  const url = mirrorUrl(MIRRORS[0]);
  const partPath = join(PART_DIR, artifactName() + '.part');
  const resumed = existsSync(partPath) ? statSync(partPath).size : 0;
  const bar = '─'.repeat(64);
  const lines = [
    '',
    bar,
    `[ensure-electron] ✗ 自动下载 Electron 失败：${err instanceof Error ? err.message : String(err)}`,
    resumed > 0
      ? `[ensure-electron] 已保留进度 ${(resumed / 1048576).toFixed(1)} MB，下次会自动断点续传`
      : null,
    '',
    '请任选一种手动方式（照抄即可）：',
    '',
    '  方式 1｜稍后重试（自动断点续传，无需任何清理）：',
    `     node "${self}"`,
    '',
    '  方式 2｜手动下载后解压（浏览器 / 下载工具）：',
    `     下载: ${url}`,
    `     解压到: ${TARGET_DIR}`,
    `     （解压后该目录下应直接存在 ${ELECTRON_REL}，然后重启 DSH）`,
    '',
    '  方式 3｜使用机器上已有的 Electron：',
    `     设置环境变量 DSH_COOK_PET_ELECTRON=<${ELECTRON_REL} 的完整路径>`,
    '',
    '  方式 4｜暂时不要桌面窗（DSH 本体不受影响）：',
    '     设置环境变量 DSH_COOK_PET_DESKTOP=0',
    bar,
    '',
  ];
  for (const l of lines) if (l !== null) console.error(l);
}

async function main() {
  const found = findExisting();
  if (found) {
    // 成功时**只**打印路径（手动运行时把它当返回值用）
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
    printManualHelp(e);
    return 1;
  }
}

// 仅在被直接执行时跑 main（被 import 时只导出函数）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}

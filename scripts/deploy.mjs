#!/usr/bin/env node
/**
 * 把**当前源码**装进正在运行的 DSH profile（`npm run deploy`）。
 *
 * ── 为什么需要这个脚本（这是本项目最耗时的一个坑）──────────────────────────────
 *
 * `dsh plugin add file:<目录>` 是 pnpm 的**复制语义**：它把包复制一份到
 * `profile/node_modules/dsh-cook-pet`，而不是做链接。于是：
 *
 *   改完源码不重新部署 → 运行中的 DSH 用的还是旧副本；
 *   现场表现是"代码明明改了却毫无变化"，而且**没有任何报错**。
 *
 * 更麻烦的是版本号不变时 pnpm 会跳过刷新，连重新 `add` 都可能拿到旧文件。
 *
 * 所以本脚本做三件事：
 *   1. 先**删掉** profile 里的旧副本（保证不吃旧文件）
 *   2. 再 `dsh plugin add file:<绝对路径>`
 *   3. **逐文件比对 sha256**，确认新的代码/素材确实进了部署副本
 *      —— 少一个文件就报错退出，不让问题拖到"重启后才发现没生效"
 *
 * 用法：
 *   node scripts/deploy.mjs                 # 装到 DSH_PROFILE（默认 desktop）
 *   node scripts/deploy.mjs --profile work  # 指定 profile
 *   node scripts/deploy.mjs --check         # 只检查"已装的是不是最新"，不改动任何东西
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));

/** 需要逐字节校验的文件（少一项就说明部署不完整） */
const MUST_MATCH = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/state.js',
  'lib/waiting.js',
  'lib/desktop.js',
  'runtime/electron-helper/main.js',
  'runtime/electron-helper/renderer.js',
  'runtime/electron-helper/preload.js',
  'runtime/electron-helper/index.html',
  'assets/icon.png',
  'assets/pet/idle.webm',
  'assets/pet/cook.webm',
  'assets/pet/serve.webm',
  'assets/pet/think.webm',
  'assets/pet/wink.webm',
  'assets/pet/spin.webm',
];

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const profileFlag = argv.indexOf('--profile');
const profile =
  (profileFlag !== -1 ? argv[profileFlag + 1] : undefined) ?? process.env.DSH_PROFILE ?? 'desktop';

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const profileDir = process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', profile);
const installedDir = join(profileDir, 'node_modules', 'dsh-cook-pet');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const sha256 = (file) => {
  const h = createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
};

function log(msg) {
  console.log('[deploy] ' + msg);
}

/** 找 DSH 的命令行入口；找不到返回 undefined 并说明怎么手工指定 */
function findDshCli() {
  if (process.env.DSH_BIN) {
    return existsSync(process.env.DSH_BIN) ? process.env.DSH_BIN : undefined;
  }
  // 1) PATH 上有 dsh
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (which.status === 0) {
    const first = String(which.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && existsSync(first)) return first;
  }
  // 2) 桌面版安装目录的几个常见位置
  const candidates = [
    'D:/Deepseek/resources/runtime/cli/bin/dsh.cmd',
    'C:/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'),
    join(dshHome, 'runtime/cli/bin/dsh.cmd'),
  ];
  return candidates.find((p) => p !== '' && existsSync(p));
}

/**
 * 比对源码与部署副本。返回问题列表（空数组 = 完全一致）。
 * @param {string} dir 部署副本目录
 */
function diffAgainst(dir) {
  const problems = [];
  for (const rel of MUST_MATCH) {
    const src = join(ROOT, rel);
    const dst = join(dir, rel);
    if (!existsSync(src)) {
      problems.push(`源码缺文件：${rel}`);
      continue;
    }
    if (!existsSync(dst)) {
      problems.push(`部署副本缺文件：${rel}`);
      continue;
    }
    if (statSync(src).size !== statSync(dst).size) {
      problems.push(`大小不一致：${rel}（部署副本是旧的）`);
      continue;
    }
    if (sha256(src) !== sha256(dst)) problems.push(`内容不一致：${rel}（部署副本是旧的）`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 1) --check：只看不装
// ---------------------------------------------------------------------------
if (checkOnly) {
  if (!existsSync(installedDir)) {
    log(`✗ ${profile} profile 里没有装 dsh-cook-pet（${installedDir}）`);
    process.exit(1);
  }
  const problems = diffAgainst(installedDir);
  if (problems.length === 0) {
    log(`✓ ${profile} 里装的就是当前源码`);
    process.exit(0);
  }
  log(`✗ ${profile} 里的副本与源码不一致（${problems.length} 项）：`);
  for (const p of problems) log('   - ' + p);
  log('跑 `npm run deploy` 重新部署。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2) 部署前先确认源码是完整的（素材没生成就别装，装了也是白屏）
// ---------------------------------------------------------------------------
const missing = MUST_MATCH.filter((rel) => !existsSync(join(ROOT, rel)));
if (missing.length > 0) {
  console.error('[deploy] ✗ 源码不完整，先补上这些再部署：');
  for (const m of missing) console.error('   - ' + m);
  if (missing.some((m) => m.startsWith('assets/pet/'))) {
    console.error('   （透明素材由 `npm run assets` 生成）');
  }
  process.exit(1);
}

const cli = findDshCli();
if (!cli) {
  console.error(
    '[deploy] ✗ 找不到 dsh 命令行入口。\n' +
      '  办法一：把 dsh 加进 PATH；\n' +
      '  办法二：设环境变量 DSH_BIN=<dsh 可执行文件或 .cmd 的绝对路径>；\n' +
      '  办法三：手工执行 `dsh plugin --profile ' +
      profile +
      ' add file:' +
      ROOT +
      '`（记得先删掉 ' +
      installedDir +
      '）',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3) 删旧副本 → 重新 add → 逐文件校验
// ---------------------------------------------------------------------------
if (existsSync(installedDir)) {
  log(`删除旧副本 ${installedDir}`);
  rmSync(installedDir, { recursive: true, force: true });
} else {
  log(`首次部署到 ${profile}`);
}

log(`执行：${cli} plugin --profile ${profile} add file:${ROOT}`);
// 用 shell 拼一整条命令：路径里可能有空格，而 spawnSync 传数组时不会帮我们加引号
const command =
  `"${cli}" plugin --profile "${profile}" add ` + `"file:${ROOT}"`;
const run = spawnSync(command, {
  shell: true,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE },
});
if (run.status !== 0) {
  console.error(`[deploy] ✗ add 失败（退出码 ${run.status}）。上面是 pnpm 的输出。`);
  process.exit(run.status ?? 1);
}

if (!existsSync(installedDir)) {
  console.error('[deploy] ✗ add 声称成功，但部署副本不存在：' + installedDir);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4) 逐文件校验：这才是"真的装进去了"的唯一证据
// ---------------------------------------------------------------------------
const problems = diffAgainst(installedDir);
if (problems.length > 0) {
  console.error('[deploy] ✗ 部署后校验失败（这正是"改了代码却毫无变化"的元凶）：');
  for (const p of problems) console.error('   - ' + p);
  console.error(
    '\n  常见原因：pnpm 因版本号没变而跳过复制。\n' +
      '  处理：把 package.json 的 version 改一下再重跑，或执行 `npm run deploy` 前手动删掉：\n' +
      '  ' +
      installedDir,
  );
  process.exit(1);
}

log('✓ 部署副本与源码逐文件一致');
log('');
log('下一步：刷新页面上（Ctrl+R）就能看到新的小厨娘；');
log('      桌面置顶窗需要重启 DSH 才会换成新 helper（或先设 DSH_COOK_PET_DESKTOP=0 只用浏览器里的）。');

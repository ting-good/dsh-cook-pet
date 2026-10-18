#!/usr/bin/env node
/**
 * 端到端验证桌面置顶窗（**不需要重启 DSH**）。
 *
 * 为什么需要这个脚本：桌面 helper 的失败几乎都是静默的 —— 窗口不出现、点击没反应、
 * 控制台干净；而且它只在"真机 + 真 Electron + 真素材"下才暴露。单测只能覆盖纯逻辑，
 * 这个脚本把整条链路真的跑一遍，并留下**看得见的证据**（截图）。
 *
 * 它做的事：
 *   1. 起一个本地 HTTP 服务假装宿主：
 *        GET /dsh-cook-pet/state       → 按固定节拍轮换 idle → cook → serve → think
 *        GET /dsh-cook-pet/asset/<名>  → 从 assets/pet 读 6 个 .webm（白名单，与真实宿主同契约）
 *   2. 按 lib/desktop.js 的 findElectron() 定位 Electron 可执行文件
 *      （$DSH_HOME/electron/electron.exe / DSH_COOK_PET_ELECTRON），spawn runtime/electron-helper。
 *      ★ spawn 前必须 delete ELECTRON_RUN_AS_NODE：DSH 桌面宿主自带它，
 *        透传会让 Electron 以纯 Node 模式启动、helper 秒退（设空串也会 abort）。
 *   3. 给 helper 设仅测试用的 DSH_COOK_PET_CAPTURE_DIR：主进程在 ready 后跟着 /state 轮换，
 *      每个状态用 webContents.capturePage() 截一张 PNG（正常运行时该变量为空，逻辑整体跳过）。
 *   4. 等 4 张截图齐了，收进 docs/verify/，并校验 PNG 头（尺寸 / 是否像空白图）。
 *
 * 用法：
 *   node scripts/verify-desktop.mjs
 *   node scripts/verify-desktop.mjs --screenshot-out docs/verify
 *   node scripts/verify-desktop.mjs --state-ms 5000 --timeout 120000
 *   node scripts/verify-desktop.mjs --keep-temp        # 保留 helper 原始截图目录（排查用）
 *
 * 退出码：0 = 4 个状态都截到；1 = 任何失败（缺 Electron / 缺素材 / 超时 / 空图）。
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findElectron } from '../lib/desktop.js';
import { DEFAULT_PET_HEIGHT } from '../lib/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const HELPER_DIR = join(PACKAGE_ROOT, 'runtime', 'electron-helper');
const ASSET_DIR = join(PACKAGE_ROOT, 'assets', 'pet');
const DEFAULT_OUT = join(PACKAGE_ROOT, 'docs', 'verify');

/** 与宿主契约一致的 4 个状态，按这个顺序轮换 */
const STATES = ['idle', 'cook', 'serve', 'think'];
/** 与 lib/state.js 的 STATE_ASSETS 对齐的 6 个透明素材（验证脚本独立成表，避免依赖宿主实现） */
const ASSET_FILES = ['idle.webm', 'cook.webm', 'serve.webm', 'think.webm', 'wink.webm', 'spin.webm'];

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    screenshotOut: DEFAULT_OUT,
    assetDir: ASSET_DIR,
    keepTemp: false,
    timeoutMs: 90_000,
    stateMs: 5_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error(`[verify-desktop] 参数 ${a} 缺少取值`);
        process.exit(1);
      }
      i += 1;
      return v;
    };
    if (a === '--screenshot-out') out.screenshotOut = resolve(next());
    else if (a === '--asset-dir') out.assetDir = resolve(next());
    else if (a === '--state-ms') out.stateMs = Math.max(1500, Number(next()) || out.stateMs);
    else if (a === '--timeout') out.timeoutMs = Math.max(10_000, Number(next()) || out.timeoutMs);
    else if (a === '--keep-temp') out.keepTemp = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`[verify-desktop] 未知参数：${a}（用 --help 看用法）`);
      process.exit(1);
    }
  }
  return out;
}

function printHelp() {
  console.log(
    [
      '用法：node scripts/verify-desktop.mjs [选项]',
      '',
      '  --screenshot-out <dir>  截图输出目录（默认 docs/verify）',
      '  --asset-dir <dir>       素材目录（默认 assets/pet；仅排障/占位验证时改）',
      '  --state-ms <ms>         假宿主每个状态停留多久（默认 5000）',
      '  --timeout <ms>          整体超时（默认 90000）',
      '  --keep-temp             保留 helper 原始截图目录，便于排查',
      '  -h, --help              显示本帮助',
    ].join('\n'),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log('[verify-desktop] ' + msg);
}

function fail(msg) {
  console.error('[verify-desktop] ✗ ' + msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 前置检查：Electron / 素材
// ---------------------------------------------------------------------------

function findElectronOrExplain() {
  const exe = findElectron();
  if (exe) return exe;
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
  console.error(
    [
      '[verify-desktop] ✗ 找不到 Electron 运行时，无法验证桌面窗。',
      '  已尝试的位置：',
      `    1) $DSH_COOK_PET_ELECTRON（当前：${process.env.DSH_COOK_PET_ELECTRON || '(未设置)'}）`,
      `    2) ${join(home, 'electron', 'electron.exe')}`,
      `    3) ${join(PACKAGE_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')}`,
      '  解决：先运行 `node scripts/ensure-electron.mjs` 下载，',
      '        或设置 DSH_COOK_PET_ELECTRON=<electron 可执行文件路径>。',
    ].join('\n'),
  );
  process.exit(1);
}

function checkAssets(dir) {
  if (!existsSync(dir)) {
    console.error(
      [
        `[verify-desktop] ✗ 缺少透明素材目录：${dir}`,
        '  本次验证的是"抠图直接浮起"，必须有 6 个带 alpha 的 .webm（共用同一裁切框）。',
        '  旧的不透明 mp4（assets/cook 或 assets/cook-已抠图）不能替代：它们没有 alpha 通道。',
        '  （若只是排查链路，可先用 --asset-dir 指向一个自造的占位素材目录。）',
      ].join('\n'),
    );
    process.exit(1);
  }
  const missing = ASSET_FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    console.error(
      [
        '[verify-desktop] ✗ 透明素材不完整，缺少：' + missing.join(', '),
        `  目录：${dir}`,
        '  等抠图管线把 6 个 .webm 产出后再跑本脚本（不要用旧 mp4 占位）。',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/**
 * 命中框一致性检查：素材管线会把每个动作的 alpha bbox 写进 assets/pet/manifest.json。
 * 桌面窗的点击穿透命中框靠 renderer.js 顶部的 PERSON_* 常量，两者必须对得上 ——
 * 对不上就会出现"人物边缘点不动"或"透明区域挡鼠标"，而且肉眼看截图看不出来。
 *
 * 这里只告警不失败：截图验证的是显示链路，命中框是另一条判定链；但日志里要留下证据。
 */
function checkHitRatios(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    log('提示：没有 manifest.json，跳过命中框常量一致性检查');
    return;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const idle = (manifest.actions || []).find((a) => a.name === 'idle');
    if (!idle || !Array.isArray(idle.bbox_frac) || idle.bbox_frac.length !== 4) {
      log('提示：manifest.json 里没有 idle.bbox_frac，跳过命中框常量检查');
      return;
    }
    const [left, top, width, height] = idle.bbox_frac;
    const src = readFileSync(join(HELPER_DIR, 'renderer.js'), 'utf8');
    const numOf = (name) => {
      const m = src.match(new RegExp(name + '\\s*=\\s*([0-9.]+)'));
      return m ? Number(m[1]) : null;
    };
    const code = {
      left: numOf('PERSON_LEFT_RATIO'),
      top: numOf('PERSON_TOP_RATIO'),
      width: numOf('PERSON_W_RATIO'),
      height: numOf('PERSON_H_RATIO'),
    };
    /** 常量 → bbox_frac 数组下标：[left, top, width, height] */
    const KEYS = [['left', 0], ['top', 1], ['width', 2], ['height', 3]];
    const off = [];
    for (const [key, index] of KEYS) {
      const value = code[key];
      if (value === null) off.push(`${key} 没找到`);
      else if (Math.abs(value - idle.bbox_frac[index]) > 0.02) {
        off.push(`${key}=${value} vs manifest ${idle.bbox_frac[index]}`);
      }
    }
    log(
      `命中框 manifest(idle bbox_frac)=[${left}, ${top}, ${width}, ${height}]；` +
        `renderer.js=[${code.left}, ${code.top}, ${code.width}, ${code.height}]`,
    );
    if (off.length) {
      log(`⚠ 命中框常量与 manifest 不一致（${off.join('；')}）—— 请更新 renderer.js 顶部 PERSON_*_RATIO`);
    } else {
      log('✓ 命中框常量与 manifest 一致');
    }
  } catch (error) {
    log('提示：manifest.json 解析失败，跳过命中框常量检查：' + (error?.message ?? error));
  }
}

// ---------------------------------------------------------------------------
// 假宿主：/state 轮换 + /asset/* 白名单
// ---------------------------------------------------------------------------

async function startFakeHost() {
  let counter = 1;
  let index = 0;
  const server = createServer((req, res) => {
    const raw = String(req.url || '/');
    const query = raw.indexOf('?');
    const path = query === -1 ? raw : raw.slice(0, query);

    if (path === '/dsh-cook-pet/state') {
      const body = JSON.stringify({ counter: counter++, state: STATES[index], desktop: true });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (path.startsWith('/dsh-cook-pet/asset/')) {
      let rel;
      try {
        rel = decodeURIComponent(path.slice('/dsh-cook-pet/asset/'.length));
      } catch {
        res.writeHead(400).end('bad asset name');
        return;
      }
      // 白名单挡掉路径穿越（真实宿主靠 state.js 的 ASSET_FILES 做同一件事）
      if (!ASSET_FILES.includes(rel)) {
        res.writeHead(404).end('unknown asset');
        return;
      }
      const file = join(args.assetDir, rel);
      if (!existsSync(file)) {
        res.writeHead(404).end('asset missing');
        return;
      }
      const buf = readFileSync(file);
      res.writeHead(200, {
        'content-type': 'video/webm',
        'content-length': buf.length,
        'cache-control': 'no-store',
      });
      res.end(buf);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  const rotation = setInterval(() => {
    index = (index + 1) % STATES.length;
  }, args.stateMs);
  if (rotation.unref) rotation.unref();

  const port = await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
  });
  return { server, rotation, port };
}

// ---------------------------------------------------------------------------
// spawn helper / 收截图 / 清理
// ---------------------------------------------------------------------------

function spawnHelper(electron, stateUrl, captureDir) {
  const env = { ...process.env };
  // ★ 必须 delete：DSH 桌面宿主自带 ELECTRON_RUN_AS_NODE，透传会让 Electron 以纯 Node 模式启动。
  //   设成空串也不行（Electron 会直接 abort）。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_COOK_PET_HOST_PID; // 别让脚本误继承宿主 PID，否则 helper 会因"宿主已死"自尽

  env.DSH_COOK_PET_STATE_URL = stateUrl;
  env.DSH_COOK_PET_ASSET_MODE = 'cutout';
  env.DSH_COOK_PET_PET_HEIGHT = String(DEFAULT_PET_HEIGHT); // 单一来源见 lib/state.js
  env.DSH_COOK_PET_CAPTURE_DIR = captureDir;
  // 显式指给 helper：正常运行时该变量不设置，helper 默认就用包根 assets/pet
  env.DSH_COOK_PET_ASSET_DIR = args.assetDir;

  const child = spawn(electron, [HELPER_DIR], {
    cwd: HELPER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = [];
  const collect = (buf) => {
    const text = String(buf);
    logs.push(text);
    if (logs.length > 200) logs.shift();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.on('error', (e) => logs.push('[spawn error] ' + (e instanceof Error ? e.message : String(e))));
  return { child, logs };
}

async function waitForCaptures(dir, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = STATES.every((s) => existsSync(join(dir, s + '.png')));
    if (done) return true;
    if (child.exitCode !== null) return false; // helper 提前退出（多半是启动失败）
    await sleep(300);
  }
  return false;
}

async function stopHelper(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  try {
    child.kill();
  } catch {
    /* 已经没了 */
  }
  const timeout = sleep(4000).then(() => 'timeout');
  if ((await Promise.race([exited.then(() => 'exited'), timeout])) === 'exited') return;
  // Windows 上 Electron 可能有子进程；taskkill /T 连整棵树一起收掉，避免留下孤儿窗口
  if (process.platform === 'win32') {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', resolveKill);
      killer.once('error', resolveKill);
    });
  }
}

/** 读 PNG 头（不依赖任何图像库）：宽、高、颜色类型 */
function pngInfo(file) {
  const buf = readFileSync(file);
  const signature = buf.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('不是合法 PNG：' + file);
  return {
    bytes: buf.length,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25], // 6 = RGBA（带 alpha），2 = RGB（透明信息已被压平）
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const electron = findElectronOrExplain();
  checkAssets(args.assetDir);
  checkHitRatios(args.assetDir);
  log(`Electron：${electron}`);
  log(`透明素材：${args.assetDir}`);

  const captureTempDir = join(tmpdir(), `dsh-cook-pet-capture-${process.pid}-${Date.now()}`);
  mkdirSync(captureTempDir, { recursive: true });
  mkdirSync(args.screenshotOut, { recursive: true });

  let host;
  let helper;
  try {
    host = await startFakeHost();
    const stateUrl = `http://127.0.0.1:${host.port}/dsh-cook-pet/state`;
    log(`假宿主已就绪：${stateUrl}（每 ${args.stateMs}ms 轮换 ${STATES.join(' → ')}）`);

    helper = spawnHelper(electron, stateUrl, captureTempDir);
    log(`已 spawn 桌面 helper（pid=${helper.child.pid}），等 4 个状态截图…`);

    const ok = await waitForCaptures(captureTempDir, helper.child, args.timeoutMs);
    if (!ok) {
      const tail = helper.logs.join('').split('\n').filter(Boolean).slice(-25).join('\n');
      console.error('[verify-desktop] ✗ 等待截图超时或 helper 提前退出。helper 日志（末尾）：');
      console.error(tail || '(无输出)');
      // 注意用 throw 而不是 process.exit：必须走 finally 关掉 helper / HTTP 服务，
      // 否则会在桌面上留下一个孤儿 Electron 窗口（process.exit 不会执行 finally）。
      throw new Error('等待截图超时或 helper 提前退出');
    }

    // 校验每张图：尺寸合理、不是几 KB 的空白图；同时记录是否保留了 alpha
    const results = [];
    let problems = 0;
    for (const state of STATES) {
      const src = join(captureTempDir, state + '.png');
      const info = pngInfo(src);
      const target = join(args.screenshotOut, state + '.png');
      copyFileSync(src, target);
      const problemsForState = [];
      if (info.width < 60 || info.height < 60) problemsForState.push(`尺寸异常 ${info.width}x${info.height}`);
      if (info.bytes < 3000) problemsForState.push(`文件只有 ${info.bytes}B，可能是空白图`);
      if (problemsForState.length) problems += 1;
      results.push({ state, target, ...info, problems: problemsForState });
      log(
        `  ${problemsForState.length ? '✗' : '✓'} ${state}.png  ${info.width}x${info.height}` +
          `  ${(info.bytes / 1024).toFixed(1)}KB  ${info.colorType === 6 ? 'RGBA（保留 alpha）' : 'RGB（alpha 被压平）'}` +
          (problemsForState.length ? '  ← ' + problemsForState.join('；') : ''),
      );
    }

    const noAlpha = results.filter((r) => r.colorType !== 6).length;
    if (noAlpha > 0) {
      log(
        `提示：${noAlpha}/4 张截图为 RGB（Windows 的 capturePage 可能把透明窗压平到黑底）。` +
          '这不影响"动作/状态是否正确"的验证，但若要看透明边缘，请以实机肉眼为准。',
      );
    }

    if (problems > 0) {
      throw new Error(`${problems} 张截图未通过校验（见上）`);
    }

    log(`✓ 4 个状态截图已写入 ${args.screenshotOut}`);
  } finally {
    if (helper) await stopHelper(helper.child);
    if (host) {
      clearInterval(host.rotation);
      await new Promise((resolveClose) => host.server.close(() => resolveClose()));
    }
    if (!args.keepTemp) {
      try {
        rmSync(captureTempDir, { recursive: true, force: true });
      } catch {
        /* 清不掉不影响验证结果 */
      }
    } else {
      log(`原始截图保留在：${captureTempDir}`);
    }
  }
}

main().catch((error) => {
  console.error('[verify-desktop] ✗ 未捕获异常：' + (error?.stack ?? error));
  process.exit(1);
});

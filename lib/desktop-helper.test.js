/**
 * 桌面 helper 进程管理的测试（不真的启动 Electron —— 那需要图形环境）
 *
 * 用假的可执行文件与假 spawn 验证管理逻辑：可用性判断、环境变量净化、
 * 熔断、停止时杀进程。**"必须删掉 ELECTRON_RUN_AS_NODE"这条尤其要有回归测试**：
 * 它的后果是 helper 秒退、桌宠不出现，而且报错信息极不直观。
 *
 * 运行：node --test lib/
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DesktopHelper, findElectron, MAX_RESTARTS } from './desktop.js';

/** 造一个假的"electron 可执行文件"，只为让 existsSync 通过 */
function fakeElectron() {
  const dir = mkdtempSync(join(tmpdir(), 'cookpet-electron-'));
  const exe = join(dir, process.platform === 'win32' ? 'electron.exe' : 'electron');
  writeFileSync(exe, '', 'utf8');
  return { dir, exe, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 一个**确定不存在**的 Electron 路径。
 * 注意不能图省事直接 new DesktopHelper({}) —— 那样会走 findElectron() 找到
 * 开发机上真实下载的 Electron，测试就测不到"缺失"分支了（本测试第一次就是这么写错的）。
 */
function missingElectron() {
  return join(tmpdir(), 'cookpet-definitely-missing-' + Date.now(), 'electron.exe');
}

test('findElectron：DSH_COOK_PET_ELECTRON 指定的路径优先', () => {
  const f = fakeElectron();
  const old = process.env.DSH_COOK_PET_ELECTRON;
  try {
    process.env.DSH_COOK_PET_ELECTRON = f.exe;
    assert.equal(findElectron(), f.exe);
  } finally {
    if (old === undefined) delete process.env.DSH_COOK_PET_ELECTRON;
    else process.env.DSH_COOK_PET_ELECTRON = old;
    f.cleanup();
  }
});

test('findElectron：路径不存在时返回 undefined（不抛错）', () => {
  // 用独立临时目录当 DSH_HOME，避免误命中真实下载的 Electron
  const dir = mkdtempSync(join(tmpdir(), 'cookpet-home-'));
  try {
    assert.equal(findElectron(dir, {}), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findElectron：$DSH_HOME/electron 下就位时能被找到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cookpet-home-'));
  const sub = join(dir, 'electron');
  mkdirSync(sub, { recursive: true });
  const exe = join(sub, process.platform === 'win32' ? 'electron.exe' : 'electron');
  writeFileSync(exe, '', 'utf8');
  try {
    assert.equal(findElectron(dir, {}), exe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('available()：Electron 缺失时返回 false', () => {
  const helper = new DesktopHelper({ electron: missingElectron() });
  assert.equal(helper.available(), false);
  assert.equal(helper.running(), false);
});

test('available()：helper 目录存在且 Electron 就位时返回 true', () => {
  const f = fakeElectron();
  try {
    const helper = new DesktopHelper({ electron: f.exe });
    assert.equal(helper.available(), true);
  } finally {
    f.cleanup();
  }
});

test('start()：Electron 缺失时返回 false 并给出可操作的提示', () => {
  const logs = [];
  const helper = new DesktopHelper({
    electron: missingElectron(),
    log: (m) => logs.push(m),
  });
  assert.equal(helper.start(), false);
  const text = logs.join('\n');
  // 现在的策略是"首次自动下载"，所以提示里要说明会自动准备，
  // 同时仍要给出手工兜底（指定已有 electron / 干脆关掉桌面窗）。
  assert.match(text, /自动下载|自动准备/, '提示里应说明会自动准备 Electron');
  assert.match(text, /DSH_COOK_PET_ELECTRON/, '提示里应给出手工指定路径的办法');
  assert.match(text, /DSH_COOK_PET_DESKTOP/, '提示里应给出"不要桌面窗"的开关');
});

test('★ 缺 Electron 时会发起后台自动准备（且不重复发起）', () => {
  // 用户不该为此敲命令：start() 失败后 ensureRuntime() 在后台把运行时装上。
  // 这里只验证"去重/放弃"的状态机，不真的触发下载（下载会写文件、耗时 100 MB）。
  const helper = new DesktopHelper({ electron: missingElectron(), log: () => {} });
  assert.equal(helper.start(), false, '缺运行时时 start 应失败');

  // _ensuring / _ensureFailed 是去重的两个闸门：任一为真都不应再发起。
  helper._ensuring = true;
  assert.equal(helper.ensureRuntime(), false, '已在进行中时不应重复发起');
  helper._ensuring = false;
  helper._ensureFailed = true;
  assert.equal(helper.ensureRuntime(), false, '已经失败过就不该无限重试下载');
  helper._ensureFailed = false;
  helper.stopped = true;
  assert.equal(helper.ensureRuntime(), false, '已停止的 helper 不应再发起下载');
});

test('★ 自动准备 Electron：命令拼装正确（脚本路径存在 + ELECTRON_RUN_AS_NODE=1）', () => {
  // 这条守的是"用户不用敲命令"这个承诺能不能真的跑起来。两个易错点：
  //  1. 脚本路径必须用 fileURLToPath 解析 —— URL.pathname 在 Windows 上带前导 `/`、
  //     且不还原百分号编码，拼进 argv 会找不到文件（静默失败，非常难查）。
  //  2. DSH 桌面宿主的 execPath 是 Electron，必须显式传 ELECTRON_RUN_AS_NODE=1
  //     才会以纯 Node 执行脚本；否则会去启动 Electron 而不是跑脚本。
  const calls = [];
  /** 假 spawn：记录调用并假装进程启动成功（不真的下载） */
  function fakeSpawn(cmd, args, opts) {
    const child = {
      exitCode: null,
      killed: false,
      on(event, cb) {
        if (event === 'exit') setImmediate(() => cb(1)); // 假装失败，避免触发真实后续逻辑
        return child;
      },
    };
    calls.push({ cmd, args, opts });
    return child;
  }
  const helper = new DesktopHelper({
    electron: missingElectron(),
    log: () => {},
    spawn: fakeSpawn,
  });
  assert.equal(helper.ensureRuntime(), true, '缺运行时且未失败过时应发起准备');

  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(calls.length, 1, '应只 spawn 一次');
      const { cmd, args, opts } = calls[0];
      assert.equal(cmd, process.execPath, '应复用当前运行时执行脚本');
      assert.ok(Array.isArray(args) && args.length >= 1, '应传入脚本路径');
      const script = args[0];
      assert.ok(existsSync(script), `脚本路径必须真实存在，实际 = ${script}`);
      assert.match(script, /scripts[\\/]ensure-electron\.mjs$/, '应指向 ensure-electron.mjs');
      assert.equal(opts.env.ELECTRON_RUN_AS_NODE, '1', 'Electron 宿主下必须显式以纯 Node 执行');
      assert.ok(args.includes('--quiet'), '自动触发时应安静模式，别往宿主日志刷进度');
      resolve();
    });
  });
});

test('stop() 后不再启动（stopped 是终态）', () => {
  const f = fakeElectron();
  try {
    const helper = new DesktopHelper({ electron: f.exe, log: () => {} });
    helper.stop();
    assert.equal(helper.start(), false, 'stop 之后不应再启动');
  } finally {
    f.cleanup();
  }
});

test('熔断阈值是有限的正整数（防止疯狂重启吃满 CPU）', () => {
  assert.ok(Number.isInteger(MAX_RESTARTS) && MAX_RESTARTS > 0 && MAX_RESTARTS <= 10, `实际 ${MAX_RESTARTS}`);
});

test('熔断：达到阈值后不再排新的重启', () => {
  const logs = [];
  const f = fakeElectron();
  try {
    const helper = new DesktopHelper({ electron: f.exe, log: (m) => logs.push(m) });
    // 人为塞满重启窗口
    const now = Date.now();
    helper.restarts = Array.from({ length: MAX_RESTARTS }, () => now);
    helper.scheduleRestart();
    assert.match(logs.join('\n'), /停止重启/, '超阈值应明确告知停止重启');
  } finally {
    f.cleanup();
  }
});

test('★ 环境变量净化：spawn 前必须删掉 ELECTRON_RUN_AS_NODE', () => {
  // 这是实测踩到的 P0：DSH 桌面宿主自带 ELECTRON_RUN_AS_NODE=1，
  // 透传给 Electron 会让它以纯 Node 模式启动 → require('electron') 失败、
  // 桌宠永远不出现，而且日志里只有一句莫名的 v24.x Node 版本号。
  // 通过注入假 spawn 断言传给子进程的环境里没有这个键。
  const f = fakeElectron();
  const oldRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  try {
    process.env.ELECTRON_RUN_AS_NODE = '1'; // 模拟 DSH 宿主的环境

    const fakeChild = {
      exitCode: null,
      killed: false,
      stdout: { on() {} },
      stderr: { on() {} },
      on() {},
      kill() {},
    };
    let captured = null;
    const helper = new DesktopHelper({
      electron: f.exe,
      stateUrl: 'http://127.0.0.1:1/x',
      log: () => {},
      spawn: (cmd, args, opts) => {
        captured = { cmd, args, opts };
        return fakeChild;
      },
    });
    assert.equal(helper.start(), true, '应启动成功');

    assert.ok(captured, '应调用过 spawn');
    assert.equal(captured.opts.env.ELECTRON_RUN_AS_NODE, undefined, 'ELECTRON_RUN_AS_NODE 必须被删除');
    assert.equal(captured.opts.env.DSH_COOK_PET_HOST_PID, String(process.pid), '应把宿主 PID 传下去');
    assert.equal(captured.opts.env.DSH_COOK_PET_STATE_URL, 'http://127.0.0.1:1/x');
    assert.equal(captured.opts.env.DSH_COOK_PET_PET_HEIGHT, '110', '应把宠物高度传下去');
    assert.ok(captured.args[0].endsWith('electron-helper'), '参数应是 helper 目录');
  } finally {
    if (oldRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = oldRunAsNode;
    f.cleanup();
  }
});

test('start() 会在 running() 为真时忽略重复调用', () => {
  const f = fakeElectron();
  try {
    let calls = 0;
    const fakeChild = {
      exitCode: null,
      killed: false,
      stdout: { on() {} },
      stderr: { on() {} },
      on() {},
      kill() {},
    };
    const helper = new DesktopHelper({
      electron: f.exe,
      log: () => {},
      spawn: () => {
        calls += 1;
        return fakeChild;
      },
    });
    helper.start();
    helper.start();
    assert.equal(calls, 1, '已在跑时不应重复 spawn');
  } finally {
    f.cleanup();
  }
});

test('★ 桌宠尺寸默认值必须两处一致（回归保护：改一处忘另一处会大小不一）', () => {
  // 这个尺寸决定桌面窗的窗口大小。历史上这几处写死过不同的值（150 / 110 / 138），
  // 改一处忘另一处就会出现"窗口大小和内容对不上"，而且不报错、很难发现。
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

  const stateSrc = read('lib/state.js');
  const m = stateSrc.match(/DEFAULT_PET_HEIGHT\s*=\s*(\d+)/);
  assert.ok(m, 'lib/state.js 应有 DEFAULT_PET_HEIGHT（尺寸的单一来源）');
  const canonical = Number(m[1]);

  // 桌面 helper（main.js 的兜底默认值）
  const mainSrc = read('runtime/electron-helper/main.js');
  const hm = mainSrc.match(/DSH_COOK_PET_PET_HEIGHT\)\s*\|\|\s*(\d+)/);
  assert.ok(hm, 'helper main.js 应有兜底默认值');
  assert.equal(Number(hm[1]), canonical, 'helper 的兜底默认值应与 DEFAULT_PET_HEIGHT 一致');

  // helper renderer 的兜底默认值
  const rSrc = read('runtime/electron-helper/renderer.js');
  const rm = rSrc.match(/cfg\.petHeight\s*\|\|\s*(\d+)/);
  assert.ok(rm, 'helper renderer 应有兜底默认值');
  assert.equal(Number(rm[1]), canonical, 'renderer 的兜底默认值应与 DEFAULT_PET_HEIGHT 一致');
});

test('尺寸档位包含默认值（右键循环能回到默认大小）', () => {
  // 右键切大小现在由桌面窗主进程实现（浏览器半侧已移除），档位在 main.js 的 SIZE_STEPS。
  const here = dirname(fileURLToPath(import.meta.url));
  const mainSrc = readFileSync(join(here, '..', 'runtime', 'electron-helper', 'main.js'), 'utf8');
  const sm = mainSrc.match(/const SIZE_STEPS\s*=\s*\[([^\]]+)\]/);
  assert.ok(sm, 'main.js 应有 SIZE_STEPS 档位表');
  const sizes = sm[1].split(',').map((s) => Number(s.trim()));
  assert.ok(sizes.length >= 2, `档位至少两档才谈得上"循环"，实际 ${JSON.stringify(sizes)}`);
  // 档位应递增（右键循环的顺序语义：越来越大）
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] > sizes[i - 1], `SIZE_STEPS 应递增，实际 ${JSON.stringify(sizes)}`);
  }
  // 默认尺寸必须在档位里，否则第一次右键会跳到意料之外的档
  const stateSrc = readFileSync(join(here, '..', 'lib', 'state.js'), 'utf8');
  const dm = stateSrc.match(/DEFAULT_PET_HEIGHT\s*=\s*(\d+)/);
  assert.ok(dm, 'lib/state.js 应有 DEFAULT_PET_HEIGHT');
  assert.ok(
    sizes.includes(Number(dm[1])),
    `SIZE_STEPS ${JSON.stringify(sizes)} 应包含默认值 ${dm[1]}`,
  );
});
/**
 * 桌面 helper 的纯逻辑单测（不需要 Electron / 图形环境）
 *
 * 覆盖三块最容易出错、且在真机上很难复现的逻辑：
 *   - pointer-target：点击穿透判定（尤其是"拖拽期间绝不穿透"这条）
 *   - topmost-watchdog：置顶重钉节拍
 *   - host-liveness：宿主死亡检测
 *
 * 运行：node --test lib/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostIsGone, isBrokenPipeError, parseHostPid } from '../runtime/electron-helper/host-liveness.js';
import {
  decideWindowIgnore,
  OFF_BODY_RELEASE_MS,
  pointerZone,
  POINTER_POLL_MS,
} from '../runtime/electron-helper/pointer-target.js';
import {
  shouldReassertTopmost,
  TOPMOST_WATCHDOG_TICK_MS,
} from '../runtime/electron-helper/topmost-watchdog.js';

// ---------------------------------------------------------------------------
// pointer-target
// ---------------------------------------------------------------------------

/** 100×100 的窗口，身体框在中间 40×40（相对内容区） */
const BOUNDS = { x: 1000, y: 500, width: 100, height: 100 };
const BODY = { l: 30, t: 30, r: 70, b: 70 };

test('pointerZone：窗外 / 宠物身上 / 余量区 三种分区', () => {
  assert.equal(pointerZone(BOUNDS, { x: 900, y: 500 }, BODY), 'outside');
  assert.equal(pointerZone(BOUNDS, { x: 1050, y: 550 }, BODY), 'body'); // 正中
  assert.equal(pointerZone(BOUNDS, { x: 1010, y: 510 }, BODY), 'margin'); // 左上角余量
});

test('光标在宠物身上 → 可交互（不穿透）', () => {
  assert.equal(decideWindowIgnore(BOUNDS, { x: 1050, y: 550 }, true, false, 0, BODY), false);
});

test('光标在窗外 → 穿透', () => {
  assert.equal(decideWindowIgnore(BOUNDS, { x: 1, y: 1 }, false, false, 0, BODY), true);
});

test('余量区：短暂停留保持现状，久留才让出', () => {
  const inMargin = { x: 1005, y: 505 };
  // 刚进余量区：保持"当前可交互"，不立刻翻回穿透（否则宠物边缘会反复横跳）
  assert.equal(decideWindowIgnore(BOUNDS, inMargin, false, false, 0, BODY), false);
  // 停留未超时：仍保持
  assert.equal(decideWindowIgnore(BOUNDS, inMargin, false, false, OFF_BODY_RELEASE_MS - 1, BODY), false);
  // 超时：让出，恢复穿透
  assert.equal(decideWindowIgnore(BOUNDS, inMargin, false, false, OFF_BODY_RELEASE_MS, BODY), true);
});

test('★ 拖拽期间（busy）绝不穿透，即使光标远在窗外', () => {
  // 这是最重要的一条：窗口比宠物大一圈，拖拽时光标很容易跑出窗口矩形。
  // 一旦因为"窗外"翻回穿透，渲染端的 pointermove/pointerup 会全断、宠物就"飞"了。
  const farAway = { x: -9999, y: -9999 };
  assert.equal(decideWindowIgnore(BOUNDS, farAway, true, true, 99999, BODY), false);
  assert.equal(decideWindowIgnore(BOUNDS, farAway, false, true, 99999, BODY), false);
});

test('busy 优先级高于位置判定（不因任何阈值被否决）', () => {
  // 位置判定里不许有任何"离得近才算"的容差 —— 那正是 bug 本身。
  for (const point of [
    { x: 1050, y: 550 },
    { x: 1001, y: 501 },
    { x: 0, y: 0 },
    { x: 99999, y: 99999 },
  ]) {
    assert.equal(decideWindowIgnore(BOUNDS, point, true, true, 0, BODY), false, JSON.stringify(point));
  }
});

test('渲染端还没上报身体框时，退回整个内容区（宁可暂时可交互，也不要点不动）', () => {
  assert.equal(decideWindowIgnore(BOUNDS, { x: 1050, y: 550 }, true, false, 0, null), false);
  assert.equal(pointerZone(BOUNDS, { x: 1001, y: 501 }, null), 'body');
});

test('轮询间隔是正数且足够短（60ms 级才能在宠物边缘及时翻转）', () => {
  assert.ok(POINTER_POLL_MS > 0 && POINTER_POLL_MS <= 100, `实际 ${POINTER_POLL_MS}ms`);
  assert.ok(OFF_BODY_RELEASE_MS >= 100, '余量区释放不应太短，否则边缘抖动');
});

// ---------------------------------------------------------------------------
// topmost-watchdog
// ---------------------------------------------------------------------------

test('置顶看门狗：周期性重钉，不是每拍都钉', () => {
  const ticks = [];
  for (let i = 1; i <= 12; i++) if (shouldReassertTopmost(i)) ticks.push(i);
  assert.deepEqual(ticks, [5, 10], '应在第 5、10 拍重钉（每 5 拍一次）');
  assert.equal(shouldReassertTopmost(0), false, '第 0 拍不钉');
  assert.equal(shouldReassertTopmost(NaN), false, '非法输入不钉');
});

test('看门狗节拍是秒级且为正', () => {
  assert.ok(TOPMOST_WATCHDOG_TICK_MS > 0 && TOPMOST_WATCHDOG_TICK_MS <= 5000);
});

// ---------------------------------------------------------------------------
// host-liveness
// ---------------------------------------------------------------------------

test('parseHostPid：只接受正整数，其它一律当"未提供"', () => {
  assert.equal(parseHostPid('1234'), 1234);
  assert.equal(parseHostPid(4321), 4321);
  assert.equal(parseHostPid(''), 0);
  assert.equal(parseHostPid('abc'), 0);
  assert.equal(parseHostPid('0'), 0);
  assert.equal(parseHostPid('-5'), 0);
  assert.equal(parseHostPid(undefined), 0);
});

test('isBrokenPipeError：认得 EPIPE 等宿主已死信号', () => {
  assert.equal(isBrokenPipeError({ code: 'EPIPE' }), true);
  assert.equal(isBrokenPipeError({ code: 'ERR_STREAM_DESTROYED' }), true);
  assert.equal(isBrokenPipeError({ code: 'ERR_IPC_CHANNEL_CLOSED' }), true);
  assert.equal(isBrokenPipeError(new Error('write EPIPE broken pipe')), true);
  assert.equal(isBrokenPipeError({ code: 'ENOENT' }), false);
  assert.equal(isBrokenPipeError(null), false);
});

test('hostIsGone：进程不存在才算"宿主已死"', () => {
  assert.equal(hostIsGone(1234, () => true), false, '进程活着 → 不该自尽');
  assert.equal(hostIsGone(1234, () => false), true, '进程没了 → 该自尽');
});

test('hostIsGone：未提供 PID 时永远返回 false（绝不误杀自己）', () => {
  assert.equal(hostIsGone(0, () => false), false);
  assert.equal(hostIsGone(undefined, () => false), false);
});

test('hostIsGone：探活函数抛错时保守当作"还活着"', () => {
  assert.equal(
    hostIsGone(1234, () => {
      throw new Error('探活失败');
    }),
    false,
  );
});

test('hostIsGone：EPERM（进程存在但无权限）算活着', () => {
  // 用真实 process.kill 语义：对不存在的 PID 抛 ESRCH，对无权限的抛 EPERM
  assert.equal(hostIsGone(process.pid), false, '自己肯定活着');
});

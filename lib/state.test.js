/**
 * 状态机单测（node --test，零依赖）
 *
 * 覆盖：四态迁移（idle/cook/serve/think）、被打断不庆祝、端菜自动回待机、
 * 托腮的进入/退出计数与兜底超时、多会话优先级、去抖（同状态不推进 counter）。
 *
 * 运行：node --test lib/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASSET_FILES,
  classifyTurnEnd,
  CookPetState,
  SERVE_HOLD_MS,
  STATES,
  STATE_ASSETS,
  THINK_MAX_MS,
} from './state.js';

/** 可控时钟：手动推进 now，让"端菜到期 / 托腮兜底"可被确定性测试 */
function makeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test('对外档位就是四个，且都配了素材', () => {
  assert.deepEqual([...STATES].sort(), ['cook', 'idle', 'serve', 'think']);
  for (const s of STATES) {
    assert.ok(STATE_ASSETS[s], `状态 ${s} 缺少素材映射`);
    assert.match(STATE_ASSETS[s], /\.webm$/, '素材应是带透明通道的 webm');
  }
  // 点击回应不是状态，但也要有素材
  assert.match(STATE_ASSETS.wink, /\.webm$/);
  assert.match(STATE_ASSETS.spin, /\.webm$/);
  // 白名单正好是 6 个，且不含路径分隔符（宿主路由靠它挡路径穿越）
  assert.equal(ASSET_FILES.length, 6);
  for (const f of ASSET_FILES) assert.ok(!f.includes('/') && !f.includes('\\'), `素材名不该带路径：${f}`);
});

test('turn/start 进入炒菜，turn/end completed 进入端菜', () => {
  const clock = makeClock();
  const s = new CookPetState(clock);
  assert.equal(s.snapshot().state, 'idle');

  s.startTask('s1');
  assert.equal(s.snapshot().state, 'cook');

  s.endTask('s1', 'completed');
  assert.equal(s.snapshot().state, 'serve');
});

test('被打断 / 出错一律不庆祝，直接回待机', () => {
  for (const kind of ['aborted', 'interrupted', 'blocked', 'forked', 'error', 'max-tokens', 'timeout', '']) {
    const s = new CookPetState(makeClock());
    s.startTask('s1');
    s.endTask('s1', kind);
    assert.equal(s.snapshot().state, 'idle', `reason.kind=${kind} 不该端菜`);
  }
});

test('只有 completed 算完成', () => {
  assert.equal(classifyTurnEnd('completed'), 'completed');
  assert.equal(classifyTurnEnd('aborted'), 'failed');
  assert.equal(classifyTurnEnd(undefined), 'failed');
});

test('端菜到点自动回待机', () => {
  const clock = makeClock();
  const s = new CookPetState(clock);
  s.startTask('s1');
  s.endTask('s1', 'completed');
  assert.equal(s.snapshot().state, 'serve');

  clock.advance(SERVE_HOLD_MS - 1);
  assert.equal(s.snapshot().state, 'serve', '还没到点应保持端菜');

  clock.advance(2);
  assert.equal(s.snapshot().state, 'idle', '过点应回待机');
});

// ---------------------------------------------------------------------------
// 托腮（think）
// ---------------------------------------------------------------------------

test('等用户开始时托腮，结束时回到原来的档位', () => {
  const clock = makeClock();
  const s = new CookPetState(clock);
  s.startTask('s1');
  assert.equal(s.snapshot().state, 'cook');

  s.beginWait('s1', 'approval');
  assert.equal(s.snapshot().state, 'think', '回合里等用户批准 → 托腮');

  s.endWait('s1');
  assert.equal(s.snapshot().state, 'cook', '用户答完应回到炒菜（回合还在跑）');
});

test('托腮与炒菜是两件事：等待计数归零后不会误判成端菜', () => {
  const clock = makeClock();
  const s = new CookPetState(clock);
  s.startTask('s1');
  s.beginWait('s1');
  clock.advance(60_000); // 用户在弹窗前犹豫了一分钟
  s.endWait('s1');
  assert.equal(s.snapshot().state, 'cook');
});

test('★ 并发等待用计数：先结束的那个不能把托腮提前清掉', () => {
  const s = new CookPetState(makeClock());
  s.startTask('s1');
  s.beginWait('s1', 'approval');
  s.beginWait('s1', 'question');
  assert.equal(s.snapshot().state, 'think');

  s.endWait('s1'); // 只答完一个
  assert.equal(s.snapshot().state, 'think', '还有一个在等，必须继续托腮');

  s.endWait('s1');
  assert.equal(s.snapshot().state, 'cook');
});

test('多余的 endWait 是安全的（不会把计数压成负数、也不会卡在托腮）', () => {
  const s = new CookPetState(makeClock());
  s.startTask('s1');
  s.beginWait('s1');
  s.endWait('s1');
  s.endWait('s1');
  s.endWait('s1');
  assert.equal(s.snapshot().state, 'cook');
});

test('★ 托腮兜底：结束事件漏收也不会永远托腮', () => {
  const clock = makeClock();
  const s = new CookPetState(clock);
  s.startTask('s1');
  s.beginWait('s1', 'question');
  assert.equal(s.snapshot().state, 'think');

  clock.advance(THINK_MAX_MS - 1);
  assert.equal(s.snapshot().state, 'think', '没到兜底时间应继续托腮');

  clock.advance(2);
  assert.equal(s.snapshot().state, 'cook', '过兜底时间应自愈回炒菜');
});

test('托腮的兜底时间远大于任何正常等待（别把正常等待掐断）', () => {
  assert.ok(THINK_MAX_MS >= 5 * 60 * 1000, `实际 ${THINK_MAX_MS}ms，太短会把正常等待掐断`);
});

test('★ 优先级：think > cook > serve > idle', () => {
  const clock = makeClock();

  // B 会话刚完成在端菜，A 会话在炒菜 → 显示炒菜
  const a = new CookPetState(clock);
  a.startTask('a');
  a.endTask('b', 'completed');
  assert.equal(a.snapshot().state, 'cook');

  // 再叠一个 C 会话在等用户 → 显示托腮
  a.beginWait('c', 'approval');
  assert.equal(a.snapshot().state, 'think', '有会话在等用户时，最优先显示托腮');

  // C 答完 → 回到 A 的炒菜
  a.endWait('c');
  assert.equal(a.snapshot().state, 'cook');

  // A 也完成了 → 端菜
  a.endTask('a', 'completed');
  assert.equal(a.snapshot().state, 'serve');
});

test('托腮期间另一个会话开始干活，托腮不被顶掉', () => {
  const s = new CookPetState(makeClock());
  s.beginWait('waiter', 'question');
  assert.equal(s.snapshot().state, 'think');
  s.startTask('worker');
  assert.equal(s.snapshot().state, 'think', '别人开工不该把"等你回话"盖掉');
});

test('新一轮 turn/start 会清掉上一轮残留的等待', () => {
  const s = new CookPetState(makeClock());
  s.beginWait('s1', 'question');
  assert.equal(s.snapshot().state, 'think');
  s.startTask('s1'); // 用户没答，直接发了新消息
  assert.equal(s.snapshot().state, 'cook');
});

test('重复的 turn/start 不重复推进 counter（防刷屏）', () => {
  const clock = makeClock();
  const s = new CookPetState(clock);
  s.startTask('s1');
  const c1 = s.snapshot().counter;
  s.startTask('s1');
  assert.equal(s.snapshot().counter, c1, '状态没变就不该推进 counter');
});

test('counter 严格递增：同一毫秒内连写两次也不同', () => {
  const s = new CookPetState(() => 5000); // 时钟故意不前进
  s.startTask('s1');
  const c1 = s.snapshot().counter;
  s.endTask('s1', 'completed');
  const c2 = s.snapshot().counter;
  s.startTask('s2');
  const c3 = s.snapshot().counter;
  assert.ok(c2 > c1, `${c2} 应大于 ${c1}`);
  assert.ok(c3 > c2, `${c3} 应大于 ${c2}`);
});

test('新一轮 turn/start 立刻打断庆祝', () => {
  const clock = makeClock();
  const s = new CookPetState(clock);
  s.startTask('s1');
  s.endTask('s1', 'completed');
  assert.equal(s.snapshot().state, 'serve');
  s.startTask('s1');
  assert.equal(s.snapshot().state, 'cook');
});

test('兜底纠偏：idleSession 清掉卡住的炒菜与托腮', () => {
  const s = new CookPetState(makeClock());
  s.startTask('s1');
  assert.equal(s.snapshot().state, 'cook');
  assert.equal(s.idleSession('s1'), true);
  assert.equal(s.snapshot().state, 'idle');
  assert.equal(s.idleSession('s1'), false, '已经没有该会话了，不该再报变化');

  // 托腮卡住（结束事件漏收）时也能靠 agent 空闲纠偏
  s.beginWait('s2', 'approval');
  assert.equal(s.snapshot().state, 'think');
  s.idleSession('s2');
  assert.equal(s.snapshot().state, 'idle');
});

// ---------------------------------------------------------------------------
// ★ 回归：端菜（举盘）不能被"空闲"事件秒杀
// ---------------------------------------------------------------------------

test('★ settleIdle 必须保留端菜：回合结束后紧跟着来的 idle 不能把报喜动作吃掉', () => {
  // 真实事件顺序（这是用户实际看到的问题）：
  //   turn/end(completed) → 端菜 5 秒 → agent/status(idle)
  // 如果 idle 处理把整条会话记录删掉，端菜会被瞬间清空：
  // 现场表现 = "炒菜 → 直接待机，根本看不到举盘"。
  const clock = makeClock();
  const s = new CookPetState(clock);
  s.startTask('s1');
  s.endTask('s1', 'completed');
  assert.equal(s.snapshot().state, 'serve', '回合完成应进入端菜');

  s.settleIdle('s1'); // ← 空闲事件紧跟其后到达
  assert.equal(s.snapshot().state, 'serve', '端菜必须保住，不能变待机');

  clock.advance(SERVE_HOLD_MS - 1);
  assert.equal(s.snapshot().state, 'serve', '端菜应走完它该有的停留时间');

  clock.advance(2);
  assert.equal(s.snapshot().state, 'idle', '到点才回待机');
});

test('settleIdle 仍然能清掉卡住的炒菜与托腮（兜底功能不能退化）', () => {
  const s = new CookPetState(makeClock());
  s.startTask('a');
  assert.equal(s.snapshot().state, 'cook');
  s.settleIdle('a');
  assert.equal(s.snapshot().state, 'idle', '卡住的炒菜应被清掉');

  s.beginWait('b', 'approval');
  assert.equal(s.snapshot().state, 'think');
  s.settleIdle('b');
  assert.equal(s.snapshot().state, 'idle', '卡住的托腮应被清掉');
});

test('settleIdle 不改动别的会话', () => {
  const s = new CookPetState(makeClock());
  s.startTask('a');
  s.startTask('b');
  s.settleIdle('a');
  assert.equal(s.snapshot().state, 'cook', 'b 还在跑，仍应显示炒菜');
});

test('nextDeadline：只在有计时状态时给出唤醒时刻', () => {  const clock = makeClock();
  const s = new CookPetState(clock);
  assert.equal(s.nextDeadline(), 0, '空闲时不需要唤醒');

  s.startTask('s1');
  assert.equal(s.nextDeadline(), 0, '炒菜不会自己结束，不排定时器');

  s.endTask('s1', 'completed');
  assert.equal(s.nextDeadline(), SERVE_HOLD_MS, '端菜到点要唤醒');

  clock.advance(SERVE_HOLD_MS);
  s.snapshot(); // 触发清理
  assert.equal(s.nextDeadline(), 0);

  s.beginWait('s2');
  assert.equal(s.nextDeadline(), THINK_MAX_MS, '托腮兜底也要唤醒');
});

test('会话记录不会无限增长（状态结束即回收）', () => {
  const clock = makeClock();
  const s = new CookPetState(clock);
  for (let i = 0; i < 100; i++) {
    s.startTask('s' + i);
    s.endTask('s' + i, 'completed');
  }
  clock.advance(SERVE_HOLD_MS + 1);
  s.snapshot();
  assert.equal(s.sessions.size, 0, `Session Map 应被回收干净，实际还有 ${s.sessions.size} 条`);
});

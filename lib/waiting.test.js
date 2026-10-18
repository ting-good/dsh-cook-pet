/**
 * 「等你回话」跟踪器的单测（node --test，零依赖）
 *
 * 这里测的是**真实状态机**上的效果，而不是 mock：托腮最终要看的是 state.snapshot().state。
 * 重点覆盖三类容易出错的地方：
 *   - 配对：`approval/asked` ↔ `approval/decided`、`tool/call` ↔ `tool/result`
 *   - 幂等/容错：同一请求重复到达、decided 找不到 asked、事件缺 id
 *   - 并发：两层等待叠在一起时，先结束的那个不能把后结束的也清掉
 *
 * 运行：node --test lib/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CookPetState } from './state.js';
import { createWaitingTracker, sessionIdOf, USER_INPUT_TOOLS, WaitingTracker } from './waiting.js';

const SESSION = { header: { id: 'sess-1' } };

/** 造一个"正在炒菜"的状态机 + 跟踪器（托腮最常见的上下文就是回合进行中） */
function setup() {
  const state = new CookPetState();
  state.startTask('sess-1');
  const tracker = createWaitingTracker({ state });
  /** 派发一条 session/event，语义与宿主一致 */
  const emit = (event, session = SESSION) => tracker.handleEvent(session, event);
  const current = () => state.snapshot().state;
  return { state, tracker, emit, current };
}

test('sessionIdOf：header.id 优先，其次 id，缺失时回 unknown', () => {
  assert.equal(sessionIdOf({ header: { id: 'a' }, id: 'b' }), 'a');
  assert.equal(sessionIdOf({ id: 'b' }), 'b');
  assert.equal(sessionIdOf({}), 'unknown');
  assert.equal(sessionIdOf(undefined), 'unknown');
});

test('工具名名单包含模型提问与计划模式', () => {
  assert.ok(USER_INPUT_TOOLS.includes('ask_user_question'));
  assert.ok(USER_INPUT_TOOLS.includes('exit_plan_mode'));
});

// ---------------------------------------------------------------------------
// 权限确认
// ---------------------------------------------------------------------------

test('approval/asked 进入托腮，approval/decided 退出', () => {
  const { emit, current } = setup();
  assert.equal(current(), 'cook');

  emit({ type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash' } });
  assert.equal(current(), 'think', '弹窗出现应立即托腮');

  emit({ type: 'approval/decided', data: { id: 'ap-1', outcome: 'allowed-once' } });
  assert.equal(current(), 'cook', '用户点完应回到炒菜');
});

test('拒绝（rejected）与取消（cancelled）同样会结束托腮', () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const { emit, current } = setup();
    emit({ type: 'approval/asked', data: { id: 'ap-x', toolName: 'write' } });
    assert.equal(current(), 'think');
    emit({ type: 'approval/decided', data: { id: 'ap-x', outcome } });
    assert.equal(current(), 'cook', `outcome=${outcome} 也应结束托腮`);
  }
});

test('同一 ApprovalRequestId 重复到达不重复计数', () => {
  const { emit, tracker, current } = setup();
  emit({ type: 'approval/asked', data: { id: 'ap-1' } });
  emit({ type: 'approval/asked', data: { id: 'ap-1' } });
  assert.equal(tracker.pending('sess-1'), 1, '重复事件不应把等待数叠加');

  emit({ type: 'approval/decided', data: { id: 'ap-1' } });
  assert.equal(current(), 'cook', '一次 decided 就该结束这一次等待');
});

test('decided 找不到对应 asked 时什么也不做（不误清别人的等待）', () => {
  const { emit, tracker, current } = setup();
  emit({ type: 'approval/asked', data: { id: 'ap-1' } });
  assert.equal(emit({ type: 'approval/decided', data: { id: 'other' } }), false);
  assert.equal(current(), 'think', '不该被无关的 decided 清掉');
  assert.equal(tracker.pending('sess-1'), 1);
});

test('载荷缺 id 时也能成对（自动生成唯一令牌）', () => {
  const { emit, tracker, current } = setup();
  emit({ type: 'approval/asked', data: { toolName: 'bash' } });
  emit({ type: 'approval/asked', data: { toolName: 'bash' } });
  assert.equal(tracker.pending('sess-1'), 2, '缺 id 的两次请求应各自成一条');
  assert.equal(current(), 'think');

  emit({ type: 'approval/decided', data: { outcome: 'allowed-once' } });
  assert.equal(tracker.pending('sess-1'), 1, '缺 id 的 decided 结束其中一条');
  assert.equal(current(), 'think', '还剩一条，继续托腮');

  emit({ type: 'approval/decided', data: { outcome: 'allowed-once' } });
  assert.equal(current(), 'cook');
});

// ---------------------------------------------------------------------------
// 选择题
// ---------------------------------------------------------------------------

test('ask_user_question 的 tool/call 进入托腮，tool/result 退出', () => {
  const { emit, current } = setup();
  emit({
    type: 'tool/call',
    data: { callId: 'call-9', name: 'ask_user_question', arguments: '{"questions":[]}' },
  });
  assert.equal(current(), 'think');

  emit({ type: 'tool/result', data: { message: { toolCallId: 'call-9', role: 'tool' } } });
  assert.equal(current(), 'cook');
});

test('普通工具调用不会让桌宠托腮（只有"等你选"才算）', () => {
  const { emit, current } = setup();
  for (const name of ['bash', 'read', 'write', 'todo_write', 'grep']) {
    emit({ type: 'tool/call', data: { callId: 'c-' + name, name } });
  }
  assert.equal(current(), 'cook');
});

test('其它工具的 tool/result 不会误清选择题的等待', () => {
  const { emit, current } = setup();
  emit({ type: 'tool/call', data: { callId: 'q-1', name: 'ask_user_question' } });
  emit({ type: 'tool/result', data: { message: { toolCallId: 'other-call' } } });
  assert.equal(current(), 'think', '不相关的 tool/result 不该结束托腮');
  emit({ type: 'tool/result', data: { message: { toolCallId: 'q-1' } } });
  assert.equal(current(), 'cook');
});

test('exit_plan_mode 也算"等你回话"', () => {
  const { emit, current } = setup();
  emit({ type: 'tool/call', data: { callId: 'p-1', name: 'exit_plan_mode' } });
  assert.equal(current(), 'think');
});

test('★ run_code 脚本里的提问（PTC 子调用）同样会托腮', () => {
  // 脚本里的子调用不产生 tool/call，只有这一对事件；漏了它就会静默地"提问期间还在炒菜"
  const { emit, current } = setup();
  emit({
    type: 'tool/ptc-dispatch-start',
    data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'sub-1', name: 'ask_user_question', arguments: '{}' },
  });
  assert.equal(current(), 'think');

  emit({ type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', subCallId: 'sub-1', isError: false } });
  assert.equal(current(), 'cook');
});

test('PTC 子调用里的普通工具不会让桌宠托腮', () => {
  const { emit, current } = setup();
  emit({ type: 'tool/ptc-dispatch-start', data: { subCallId: 'sub-2', name: 'bash' } });
  assert.equal(current(), 'cook');
});

test('blocked 不是"在等你"（本版实测它只来自 pre-step 拒绝）', () => {
  const state = new CookPetState();
  const tracker = createWaitingTracker({ state });
  state.startTask('sess-1');
  // 与 lib/index.js 的真实处理顺序一致：先走状态机的回合结束，再交给等待跟踪器
  state.endTask('sess-1', 'blocked');
  tracker.handleEvent(SESSION, { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } });
  assert.equal(state.snapshot().state, 'idle', 'blocked 应该静默回待机，不该托腮');
});

// ---------------------------------------------------------------------------
// 并发与生命周期
// ---------------------------------------------------------------------------

test('★ 权限确认与选择题同时挂着：先结束的不能把托腮提前清掉', () => {
  const { emit, tracker, current } = setup();
  emit({ type: 'approval/asked', data: { id: 'ap-1' } });
  emit({ type: 'tool/call', data: { callId: 'q-1', name: 'ask_user_question' } });
  assert.equal(tracker.pending('sess-1'), 2);
  assert.equal(current(), 'think');

  emit({ type: 'approval/decided', data: { id: 'ap-1' } });
  assert.equal(current(), 'think', '选择题还没答，必须继续托腮');

  emit({ type: 'tool/result', data: { message: { toolCallId: 'q-1' } } });
  assert.equal(current(), 'cook');
});

test('turn/end 会把该会话残留的等待一并作废', () => {
  const { state, emit, tracker, current } = setup();
  emit({ type: 'approval/asked', data: { id: 'ap-1' } });
  assert.equal(current(), 'think');

  // 宿主真实顺序：决定之后才是 turn/end；但即使 decided 丢了，turn/end 也必须兜住
  state.endTask('sess-1', 'completed');
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(tracker.pending('sess-1'), 0, '跟踪器里的令牌应被清空');
  assert.equal(current(), 'serve', '回合完成应端菜，而不是卡在托腮');
});

test('多会话互不干扰：A 在等，B 在炒菜 → 显示托腮；A 答完 → 回到 B 的炒菜', () => {
  const state = new CookPetState();
  const tracker = createWaitingTracker({ state });
  state.startTask('a');
  state.startTask('b');
  tracker.handleEvent({ header: { id: 'a' } }, { type: 'approval/asked', data: { id: 'ap-a' } });
  assert.equal(state.snapshot().state, 'think');

  tracker.handleEvent({ header: { id: 'a' } }, { type: 'approval/decided', data: { id: 'ap-a' } });
  assert.equal(state.snapshot().state, 'cook', 'B 还在炒菜');
});

test('子代理会话不触发托腮（它没有 GUI，不会真的等你）', () => {
  const state = new CookPetState();
  const tracker = createWaitingTracker({ state });
  state.startTask('sub');
  const subagent = { header: { id: 'sub', origin: 'subagent' } };
  tracker.handleEvent(subagent, { type: 'approval/asked', data: { id: 'ap-1' } });
  tracker.handleEvent(subagent, { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question' } });
  assert.equal(state.snapshot().state, 'cook', '子代理的等待不该让桌宠托腮');
  assert.equal(tracker.pending('sub'), 0);
});

test('普通 fork 会话（只有 parentSession、没有 origin）不被当成子代理', () => {
  const state = new CookPetState();
  const tracker = createWaitingTracker({ state });
  state.startTask('fork');
  const forked = { header: { id: 'fork', parentSession: 'root' } };
  tracker.handleEvent(forked, { type: 'approval/asked', data: { id: 'ap-1' } });
  assert.equal(state.snapshot().state, 'think', '主对话就是 fork 出来的，必须照常托腮');
});

test('clearSession 只清自己那一路', () => {
  const state = new CookPetState();
  const tracker = createWaitingTracker({ state });
  tracker.handleEvent({ header: { id: 'a' } }, { type: 'approval/asked', data: { id: '1' } });
  tracker.handleEvent({ header: { id: 'b' } }, { type: 'approval/asked', data: { id: '2' } });
  tracker.clearSession('a');
  assert.equal(tracker.pending('a'), 0);
  assert.equal(tracker.pending('b'), 1);
});

test('不认识的事件返回 false，不影响状态', () => {
  const { emit, current } = setup();
  for (const t of ['step/start', 'step/end', 'user/message', 'assistant/message', 'todo/write', '']) {
    assert.equal(emit({ type: t, data: {} }), false, `${t || '(空)'} 不该改变等待状态`);
  }
  assert.equal(current(), 'cook');
});

test('信号处理出错不会抛出（宿主事件派发不能被我们搞挂）', () => {
  // 故意给一个会炸的状态机：beginWait 抛异常
  const broken = {
    beginWait() {
      throw new Error('boom');
    },
    endWait() {
      throw new Error('boom');
    },
  };
  const tracker = new WaitingTracker({ state: broken });
  assert.doesNotThrow(() =>
    tracker.handleEvent(SESSION, { type: 'approval/asked', data: { id: 'x' } }),
  );
  assert.doesNotThrow(() =>
    tracker.handleEvent(SESSION, { type: 'approval/decided', data: { id: 'x' } }),
  );
});

test('onChange 只在真的发生变化时被调用（不刷屏）', () => {
  const state = new CookPetState();
  state.startTask('s1');
  let calls = 0;
  const tracker = createWaitingTracker({ state, onChange: () => { calls += 1; } });
  tracker.handleEvent(SESSION, { type: 'approval/asked', data: { id: 'ap-1' } });
  assert.equal(calls, 1);
  tracker.handleEvent(SESSION, { type: 'approval/asked', data: { id: 'ap-1' } }); // 重复
  assert.equal(calls, 1, '重复事件不该再触发回调');
  tracker.handleEvent(SESSION, { type: 'approval/decided', data: { id: 'ap-1' } });
  assert.equal(calls, 2);
});

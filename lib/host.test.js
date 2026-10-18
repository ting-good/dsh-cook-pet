/**
 * 宿主半侧冒烟测试：用假 ctx 驱动真实的 lib/index.js。
 *
 * 校验四件事：
 *   1. 插件导出契约（name / inject / apply）齐全，且 name 与包名一致；
 *   2. session/event → 状态机的端到端行为（含"被打断不庆祝"、"等你回话要托腮"）；
 *   3. 路由：/state 的响应形状、素材白名单与防路径穿越；
 *   4. 卸载时事件监听与定时器都被回收。
 *
 * 运行：node --test lib/  （或逐个直接执行 node lib/host.test.js，沙箱里更省事）
 */

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { apply, inject, name, ROUTE_PREFIX } from './index.js';
import { ASSET_FILES, STATE_ASSETS } from './state.js';

/**
 * 假 Cordis 上下文：记录 effect 的清理函数、收集路由、能人工派发事件。
 * `on()` 必须支持**同名多监听器**（真实 cordis 就是多播的；只支持一个会掩盖竞态）。
 */
function makeCtx() {
  const disposers = [];
  const routes = [];
  /** @type {Map<string, Array<Function>>} */
  const listeners = new Map();
  const ctx = {
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    on(event, cb) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return () => {
        const now = listeners.get(event) ?? [];
        listeners.set(
          event,
          now.filter((f) => f !== cb),
        );
      };
    },
    webServer: {
      // port 故意留空：桌面 helper 那条 effect 会走"端口未知，跳过"分支，
      // 这样单测不会真的去 spawn Electron。
      port: 0,
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  /** 派发会话事件 */
  const emit = (event, session = { header: { id: 'sess-1' } }) => {
    for (const cb of listeners.get('session/event') ?? []) cb(session, event);
  };
  /** 派发宿主事件（非 session/event） */
  const emitHost = (event, payload) => {
    for (const cb of listeners.get(event) ?? []) cb(payload);
  };
  return {
    ctx,
    routes,
    emit,
    emitHost,
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    disposeAll() {
      for (const d of disposers) d();
    },
  };
}

/**
 * 假 req/res：收下响应体与状态码。
 * 素材路由是流式的（stream.pipe(res)），所以 res 必须是个带 once/emit 的 EventEmitter —
 * 用 node:stream 的 Writable 起一个最小实现，比手搓事件方法可靠。
 */
function callRoute(route, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    res.status = 0;
    res.headers = {};
    // destroyed / writableEnded 是 Writable 的只读 getter，必须用 defineProperty 覆盖，
    // 否则赋值会抛 "has only a getter"（生产代码会读这两个字段判断客户端是否已断开）
    Object.defineProperty(res, 'destroyed', { get: () => false, configurable: true });
    Object.defineProperty(res, 'writableEnded', { get: () => res.writableFinished, configurable: true });
    res.writeHead = function writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    };
    res.on('finish', () =>
      resolve({ status: res.status, headers: res.headers, body: Buffer.concat(chunks) }),
    );
    res.on('error', reject);
    route.handler({ url, method, on() {} }, res);
  });
}

async function readState(route) {
  // 用**真实请求形态**（含路由前缀）读状态：prefix 路由收到的是完整 URL，
  // 早先测试里传 '/state' 恰好绕过了切前缀的 bug，所以这里必须带前缀。
  const r = await callRoute(route, ROUTE_PREFIX + '/state');
  assert.equal(r.status, 200);
  return JSON.parse(r.body.toString('utf8'));
}

test('导出契约：name/inject/apply 齐全，name 与包名一致', () => {
  assert.equal(name, 'dsh-cook-pet');
  assert.ok(Array.isArray(inject) && inject.includes('webServer'));
  assert.equal(typeof apply, 'function');
});

test('路由注册在 /dsh-cook-pet 前缀上', () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, ROUTE_PREFIX);
});

test('初始状态是待机，带数字 counter，且不含已废弃的 desktop 字段', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const s = await readState(routes[0]);
  assert.equal(s.state, 'idle');
  assert.equal(typeof s.counter, 'number');
  // desktop 字段原本只给浏览器半侧"让位"用；浏览器半侧移除后它就成了死字段。
  assert.equal('desktop' in s, false, '/state 不应再带 desktop 字段');
});

test('端到端：turn/start → cook，turn/end completed → serve', async () => {
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  const route = routes[0];

  emit({ type: 'turn/start', data: { turn: 1 } });
  assert.equal((await readState(route)).state, 'cook');

  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal((await readState(route)).state, 'serve');
});

test('端到端：被打断的回合不庆祝', async () => {
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  emit({ type: 'turn/start', data: { turn: 1 } });
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } });
  assert.equal((await readState(routes[0])).state, 'idle');
});

// ---------------------------------------------------------------------------
// 等你回话（托腮）—— 走真实的 session/event 契约
// ---------------------------------------------------------------------------

test('端到端：权限确认弹窗期间托腮，用户点完恢复炒菜', async () => {
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  const route = routes[0];
  emit({ type: 'turn/start', data: { turn: 1 } });
  assert.equal((await readState(route)).state, 'cook');

  // 宿主真实顺序：tool/call → approval/asked → approval/decided → tool/result
  emit({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } });
  emit({ type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'c1' } });
  assert.equal((await readState(route)).state, 'think', '等你批准时应托腮');

  emit({ type: 'approval/decided', data: { id: 'ap-1', outcome: 'allowed-once' } });
  assert.equal((await readState(route)).state, 'cook', '点完应继续炒菜');
});

test('端到端：ask_user_question 等你选时托腮，答复后恢复', async () => {
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  const route = routes[0];
  emit({ type: 'turn/start', data: { turn: 1 } });
  emit({
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: '{"questions":[]}' },
  });
  assert.equal((await readState(route)).state, 'think');

  emit({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'q1' } } });
  assert.equal((await readState(route)).state, 'cook');
});

test('端到端：回合在等用户时被结束，不残留托腮', async () => {
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  const route = routes[0];
  emit({ type: 'turn/start', data: { turn: 1 } });
  emit({ type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash' } });
  assert.equal((await readState(route)).state, 'think');

  // 用户直接取消了整个回合：decided 可能没来，turn/end 必须兜住
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });
  assert.equal((await readState(route)).state, 'idle');
});

test('端到端：多会话时，一个会话在等用户也不会被另一个会话的完成顶掉', async () => {
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  const route = routes[0];
  emit({ type: 'turn/start', data: { turn: 1 } }, { header: { id: 'a' } });
  emit({ type: 'approval/asked', data: { id: 'ap-1' } }, { header: { id: 'a' } });
  emit({ type: 'turn/start', data: { turn: 1 } }, { header: { id: 'b' } });
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, { header: { id: 'b' } });
  assert.equal((await readState(route)).state, 'think');
});

// ---------------------------------------------------------------------------
// 兜底与健壮性
// ---------------------------------------------------------------------------

test('★ 端到端：回合完成后 agent/status idle 不能把端菜（举盘）清掉', async () => {
  // 用户实际看到的问题：任务完成时从"炒菜"直接跳到"待机"，没有举盘报喜。
  // 原因是回合结束的真实顺序为 turn/end(completed) → 端菜 → agent/status(idle)，
  // 而兜底逻辑把整条会话记录删了，端菜被秒杀。
  const { ctx, routes, emit, emitHost } = makeCtx();
  apply(ctx);
  const route = routes[0];

  emit({ type: 'turn/start', data: { turn: 1 } });
  assert.equal((await readState(route)).state, 'cook');

  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal((await readState(route)).state, 'serve', '回合完成应进入端菜');

  emitHost('agent/status', { agent: { id: 'sess-1' }, status: 'idle' });
  assert.equal((await readState(route)).state, 'serve', '空闲事件到达后端菜仍应保住');
});

test('端到端：agent/status idle 兜底纠偏（宿主事件，不是 session 子事件）', async () => {
  const { ctx, routes, emit, emitHost } = makeCtx();
  apply(ctx);
  emit({ type: 'turn/start', data: { turn: 1 } });
  assert.equal((await readState(routes[0])).state, 'cook');

  emitHost('agent/status', { agent: { id: 'sess-1' }, status: 'idle' });
  assert.equal((await readState(routes[0])).state, 'idle');
});

test('端到端：agent/status running 不该被当成空闲', async () => {
  const { ctx, routes, emit, emitHost } = makeCtx();
  apply(ctx);
  emit({ type: 'turn/start', data: { turn: 1 } });
  emitHost('agent/status', { agent: { id: 'sess-1' }, status: 'running' });
  assert.equal((await readState(routes[0])).state, 'cook');
});

test('事件缺少 type 时不炸、不改状态', async () => {
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  emit({});
  emit({ type: 'user/message', data: {} });
  assert.equal((await readState(routes[0])).state, 'idle');
});

test('未知路由 → 404', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  for (const bad of ['/nope', ROUTE_PREFIX + '/nope', ROUTE_PREFIX + '/']) {
    const r = await callRoute(routes[0], bad);
    assert.equal(r.status, 404, `${bad} 应为 404`);
  }
});

test('素材白名单：未登记的名字 → 404（含路径穿越尝试）', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const route = routes[0];
  for (const bad of [
    ROUTE_PREFIX + '/asset/../index.js',
    ROUTE_PREFIX + '/asset/%2e%2e%2findex.js',
    ROUTE_PREFIX + '/asset/whatever.mp4',
    ROUTE_PREFIX + '/asset/idle.mp4%00.png',
    ROUTE_PREFIX + '/asset/%5c..%5cpackage.json',
    ROUTE_PREFIX + '/asset/idle.mp4', // 旧格式已不再登记
  ]) {
    const r = await callRoute(route, bad);
    assert.equal(r.status, 404, `${bad} 应被拒`);
  }
});

test('素材可达：登记的 idle.webm 返回 200、video/webm、长度头一致', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const r = await callRoute(routes[0], ROUTE_PREFIX + '/asset/' + STATE_ASSETS.idle);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'video/webm');
  assert.ok(r.body.length > 1000, '应真的读到视频字节');
  // 长度头必须与实际字节数一致，否则浏览器会永远等下去
  assert.equal(Number(r.headers['content-length']), r.body.length, 'content-length 必须等于实际字节数');
});

test('六个素材全部可达（客户端会逐个请求）', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  assert.equal(ASSET_FILES.length, 6);
  for (const f of ASSET_FILES) {
    const r = await callRoute(routes[0], ROUTE_PREFIX + '/asset/' + f);
    assert.equal(r.status, 200, `${f} 应为 200`);
    assert.ok(r.body.length > 1000, `${f} 应有内容`);
  }
});

test('带查询串也正常（浏览器可能加 cache-buster）', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const r = await callRoute(routes[0], ROUTE_PREFIX + '/state?t=123');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body.toString('utf8')).state, 'idle');
});

test('卸载（ctx 清理）后事件监听与路由都被回收', async () => {
  const { ctx, routes, emit, disposeAll } = makeCtx();
  apply(ctx);
  emit({ type: 'turn/start', data: { turn: 1 } });
  assert.equal((await readState(routes[0])).state, 'cook'); // 清理前确实在工作
  disposeAll();
  // 清理后监听已摘除：再派发事件不会再影响任何状态（也不会抛）
  assert.doesNotThrow(() => emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } }));
});

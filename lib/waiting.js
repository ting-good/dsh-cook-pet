/**
 * 「等你回话」的信号 —— 决定什么时候让桌宠托腮（think）。
 *
 * 托腮只对应两件事（用户明确要求的两个触发点）：
 *   1. **权限确认**：某个工具调用要你点「允许 / 拒绝」才能继续；
 *   2. **选择题**：模型用 `ask_user_question` 向你提问，等你在卡片里选。
 *
 * ── 为什么用 `session/event` 的子事件，而不是 `approval/request` 这类 waterfall ──
 *
 * 直觉上 waterfall 更"精确"：监听器拿到 `next()`，`await next()` 的区间正好是"用户还没答"。
 * 但在本机实测里行不通：GUI 的远端回答器会**认领**（claim）这两个 waterfall 请求，
 * 后注册的观察者根本收不到（除非 `{ prepend: true }` 抢到最前面）。而抢在最前面意味着
 * 一旦我们这段代码有任何问题，用户**批准不了、回答不了** —— 这个代价不能接受。
 *
 * 好在宿主把审批做成了**持久日志里的一对子事件**，天然成对、语义精确：
 *
 *   approval/asked   { id, toolName, callId?, reason? }     ← 弹窗出现
 *   approval/decided { id, outcome }                        ← 用户点了/被取消
 *
 *   outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
 *   （用户直接关掉、请求被 abort 时会补 `cancelled`，所以"有 asked 必有 decided"）
 *
 * 选择题同理，靠工具调用自身的一对事件配对：
 *
 *   tool/call   { callId, name: 'ask_user_question', arguments }
 *   tool/result { message: { toolCallId } }
 *
 * 但要**连脚本里的子调用一起管**：`run_code`（PTC）里发起的提问不产生 `tool/call`，
 * 而是 `tool/ptc-dispatch-start` ↔ `tool/ptc-dispatch`（`subCallId` 配对）。
 * 漏掉这一对的后果是静默的：你在脚本里的提问期间，桌宠照旧在炒菜，没人觉得不对。
 *
 * 目标事件都用**令牌（token）**配对而不是纯计数：
 *   同一个 `ApprovalRequestId` 重复到达不会重复计数；`decided` 找不到对应 `asked` 时也不会把
 *   别的等待误清掉（比如两层等待叠在一起时，先结束的那个不该把后结束的也抹掉）。
 *
 * 兜底（不指望它们，但必须有）：
 *   - `turn/start` / `turn/end`：该会话的等待全部作废（回合都换了，上一次等待肯定没了）；
 *   - `agent/status: idle`：由 lib/index.js 调 `state.idleSession()` 整体清掉；
 *   - `THINK_MAX_MS`：30 分钟自愈，防"日志里 decided 丢了 → 永远托腮"。
 *
 * ⚠️ `turn/end` 的 `reason.kind === 'blocked'` **不是**"在等你"（本版实测它只来自
 * agent/pre-step 的 reject，比如会话已归档），所以这里不把 blocked 当托腮。
 */

/**
 * 会话 id 的取法需要容错（不同版本字段位置有差异）。
 * `session/event` 的第一个实参是 `Session`，实测 `session.header.id` 与 `session.id` 同值。
 * @param {any} session
 * @returns {string}
 */
export function sessionIdOf(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown');
}

/**
 * 是不是子代理会话。
 *
 * 子代理没有绑定 GUI：它想问你问题时会在毫秒级内被判 `unavailable` / `DELEGATED_CALLER`，
 * 根本不会真的等你。若不过滤，界面上会闪一下"托腮"再跳走 —— 比不显示更烦人。
 *
 * 判据只能用 `header.origin === 'subagent'`：`header.parentSession` 的语义是"从哪条会话
 * fork 出来"，普通 fork 也带它（实测正在对话的主会话就带），用它判会把主对话一起过滤掉。
 * @param {any} session
 */
function isSubagentSession(session) {
  return session?.header?.origin === 'subagent';
}

/**
 * 会弹"等你选"卡片的工具名。
 *
 * - `ask_user_question`：模型主动提问（最常见）
 * - `exit_plan_mode`：计划模式下把方案交给你批准，本质也是"等你回话"
 *
 * 加名单而不是"凡是等待态都算"，是为了避免把普通长工具调用误判成托腮。
 * @type {readonly string[]}
 */
export const USER_INPUT_TOOLS = Object.freeze(['ask_user_question', 'exit_plan_mode']);

/** 令牌前缀：审批 / 普通提问 / 脚本子调用提问，分开便于排查 */
const TOKEN_APPROVAL = 'a:';
const TOKEN_QUESTION = 'q:';
const TOKEN_PTC = 'p:';

/**
 * 安全包装：信号处理出错绝不能让宿主事件派发挂掉。
 * 这是"托腮"这种纯装饰功能的基本原则 —— 它坏了也不能影响用户批准工具调用。
 */
function safeCall(fn) {
  try {
    fn();
  } catch (e) {
    console.warn('[dsh-cook-pet] 等待信号处理出错（已忽略）：', e);
  }
}

/**
 * 「等你回话」跟踪器。
 *
 * 用法（lib/index.js 里）：在**同一个** `session/event` 监听器里，
 * 先处理回合生命周期，再把事件交给 `handleEvent()`。
 * 这样只有一个监听器、顺序确定，也避免"两个监听器一个先清一个后加"的竞态。
 */
export class WaitingTracker {
  /**
   * @param {object} opts
   * @param {import('./state.js').CookPetState} opts.state 状态机
   * @param {() => void} [opts.onChange] 状态变化后的回调（用于重排看门狗定时器）
   */
  constructor({ state, onChange = () => {} }) {
    this.state = state;
    this.onChange = onChange;
    /** @type {Map<string, Set<string>>} sessionId → 该会话未结束的等待令牌 */
    this.tokens = new Map();
    /** 载荷里缺 id 时用的自增序号，保证令牌仍然唯一 */
    this.autoSeq = 0;
  }

  /** 该会话当前未结束的等待数（调试/测试用） */
  pending(sessionId) {
    return this.tokens.get(sessionId)?.size ?? 0;
  }

  /** 全局未结束的等待数（调试/测试用） */
  get pendingTotal() {
    let n = 0;
    for (const set of this.tokens.values()) n += set.size;
    return n;
  }

  /**
   * 开始一个等待。同一个令牌重复调用是幂等的。
   * @returns {boolean} 是否真的新增了一个等待
   */
  begin(sessionId, token, why) {
    let set = this.tokens.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.tokens.set(sessionId, set);
    }
    if (set.has(token)) return false; // 同一条请求重复到达：不重复计数
    set.add(token);
    safeCall(() => this.state.beginWait(sessionId, why));
    safeCall(() => this.onChange());
    return true;
  }

  /**
   * 结束一个等待。找不到对应令牌时什么也不做（绝不误清别人的等待）。
   * @returns {boolean} 是否真的结束了一个等待
   */
  end(sessionId, token) {
    const set = this.tokens.get(sessionId);
    if (set === undefined || !set.has(token)) return false;
    set.delete(token);
    if (set.size === 0) this.tokens.delete(sessionId);
    safeCall(() => this.state.endWait(sessionId));
    safeCall(() => this.onChange());
    return true;
  }

  /**
   * 结束该会话**所有**等待（回合开始/结束时调用）。
   * 只清自己的令牌与状态机计数，不影响别的会话。
   */
  clearSession(sessionId) {
    const set = this.tokens.get(sessionId);
    if (set === undefined) return 0;
    const n = set.size;
    this.tokens.delete(sessionId);
    // 状态机那边可能已经被 turn/start、turn/end、idleSession 清零了，
    // endWait 对多余调用是安全的（计数不会变负），这里补足次数只是保险。
    safeCall(() => {
      for (let i = 0; i < n; i++) this.state.endWait(sessionId);
    });
    safeCall(() => this.onChange());
    return n;
  }

  /** 清空全部（插件卸载时用） */
  dispose() {
    this.tokens.clear();
  }

  /**
   * 处理一条 `session/event`。不认识的事件返回 false（不影响调用方的判断）。
   * @param {any} session
   * @param {{type?: string, data?: any}} event
   * @returns {boolean} 这条事件是否改变了"等你回话"的状态
   */
  handleEvent(session, event) {
    const type = event?.type;
    if (!type) return false;
    // 子代理不会真的等你回话（它没有 GUI），别让界面闪一下托腮
    if (isSubagentSession(session)) return false;
    const sessionId = sessionIdOf(session);
    const data = event?.data ?? {};
    let changed = false;

    switch (type) {
      // ---- 权限确认 ----
      case 'approval/asked': {
        const id = data.id === undefined || data.id === null ? '' : String(data.id);
        const token = TOKEN_APPROVAL + (id !== '' ? id : 'auto:' + ++this.autoSeq);
        changed = this.begin(sessionId, token, 'approval');
        break;
      }
      case 'approval/decided': {
        const id = data.id === undefined || data.id === null ? '' : String(data.id);
        if (id !== '') {
          changed = this.end(sessionId, TOKEN_APPROVAL + id);
        } else {
          // 没有 id 就拿该会话任意一个审批令牌结束（保底，不让状态卡死）
          changed = this.endAnyApproval(sessionId);
        }
        break;
      }

      // ---- 选择题：普通工具调用 ----
      case 'tool/call': {
        const name = String(data.name ?? '');
        if (USER_INPUT_TOOLS.includes(name)) {
          const callId = String(data.callId ?? '');
          const token = TOKEN_QUESTION + (callId !== '' ? callId : 'auto:' + ++this.autoSeq);
          changed = this.begin(sessionId, token, 'question');
        }
        break;
      }
      case 'tool/result': {
        const callId = String(data?.message?.toolCallId ?? data?.callId ?? '');
        if (callId !== '') changed = this.end(sessionId, TOKEN_QUESTION + callId);
        break;
      }

      // ---- 选择题：`run_code` 脚本里发起的子调用 ----
      //
      // 脚本工具（run_code / PTC）里的子调用**不产生 tool/call**，而是这一对事件。
      // 漏掉它们的后果不是"报错"，而是"你在脚本里的提问期间桌宠一直炒菜"——
      // 沉默的漏报最难发现，所以这两个事件必须一起处理。
      case 'tool/ptc-dispatch-start': {
        const name = String(data.name ?? '');
        if (USER_INPUT_TOOLS.includes(name)) {
          const subCallId = String(data.subCallId ?? '');
          const token = TOKEN_PTC + (subCallId !== '' ? subCallId : 'auto:' + ++this.autoSeq);
          changed = this.begin(sessionId, token, 'question');
        }
        break;
      }
      case 'tool/ptc-dispatch': {
        const subCallId = String(data.subCallId ?? '');
        if (subCallId !== '') changed = this.end(sessionId, TOKEN_PTC + subCallId);
        break;
      }

      // ---- 回合换了，上一次等待必然作废 ----
      case 'turn/start':
      case 'turn/end':
        changed = this.clearSession(sessionId) > 0;
        break;
      default:
        break;
    }
    return changed;
  }

  /** 结束该会话任意一个审批等待（载荷缺 id 时的保底路径） */
  endAnyApproval(sessionId) {
    const set = this.tokens.get(sessionId);
    if (set === undefined) return false;
    for (const token of set) {
      if (token.startsWith(TOKEN_APPROVAL)) return this.end(sessionId, token);
    }
    return false;
  }
}

/** 便捷工厂（lib/index.js 用） */
export function createWaitingTracker(opts) {
  return new WaitingTracker(opts);
}

/**
 * 「照照」状态机（纯逻辑，零副作用，可单测）
 *
 * 四个档位 + 两个点击回应动作：
 *   idle   待机   —— 握着锅铲站着轻轻晃（没有任务）
 *   cook   炒菜   —— 颠锅炒菜（回合进行中）
 *   serve  端菜   —— 端盘报喜（回合成功完成，停留数秒后自动回待机）
 *   think  托腮   —— 手背抵着下巴歪头等你（等你批准权限 / 等你在选择题里回话）
 *   wink   点击回应之一（客户端本地随机选择，不进状态机）
 *   spin   点击回应之一
 *
 * 为什么"等你"要单独占一档，而不是复用 cook：
 *   炒菜表示"我在干活，别打扰我"，托腮表示"我卡在你这儿了，该你了"。
 *   这两件事的**紧迫性完全不同** —— 你切到别的应用去了，托腮是唯一会把你叫回来的信号。
 *   所以它的展示优先级最高（think > cook > serve > idle）：
 *   哪怕别的会话正在炒菜，只要有一个会话在等你，就先显示托腮。
 *
 * 设计要点：
 *   1. **不刷屏**：只有对外展示的状态真的变化才推进 counter（客户端靠 counter 判断要不要重放动画）。
 *   2. **多会话**：按会话记录各自档位，展示取优先级最高者。
 *   3. **等待必然结束**：托腮由"进入/退出"成对上报（用计数，允许并发等待），再加 THINK_MAX_MS 兜底，
 *      绝不出现"事件漏收 → 永远托腮"。宁可少托一会儿，也不要卡死在等待态。
 *   4. **被打断绝不庆祝**：turn/end 只有 completed 才端菜，其余一律静默回待机。
 */

/** 对外广播的档位（客户端按它切素材） */
export const STATES = ['idle', 'cook', 'serve', 'think'];

/**
 * 桌宠在桌面上的默认高度（px）—— **单一来源**。
 *
 * 这个值决定桌面置顶窗的初始窗口尺寸（用户右键切换过大小后，以记住的值为准），
 * helper 的兜底默认值必须与它一致。改这里即可整体缩放。
 *
 * 调参记录：初版 150 偏大 → 改 110（用户反馈"矩形框太大"）→
 * 用户看实际效果后要求"约现在的 1.25 倍" → 110 × 1.25 ≈ 138。
 */
export const DEFAULT_PET_HEIGHT = 138;

/** 端菜停留时长（ms）：到点自动回待机 */
export const SERVE_HOLD_MS = 5000;

/**
 * 托腮兜底上限（ms）：等待事件漏收时的自愈时间。
 *
 * 正常路径靠"开始/结束"成对上报结束托腮。但万一结束事件没来（宿主异常、会话被强杀），
 * 桌宠就会一直托着腮装死 —— 30 分钟后自动回待机；宁可少托一会儿，也不卡死。
 */
export const THINK_MAX_MS = 30 * 60 * 1000;

/** 展示优先级：数值大的赢 */
const PRIORITY = { think: 3, cook: 2, serve: 1, idle: 0 };

/**
 * turn/end 的 reason.kind → 是否算"任务完成"。
 * 只有 completed 才庆祝；aborted / interrupted / blocked / forked / error / max-tokens 一律不庆祝。
 * @param {string} kind
 * @returns {'completed' | 'failed'}
 */
export function classifyTurnEnd(kind) {
  return kind === 'completed' ? 'completed' : 'failed';
}

/**
 * 单个会话的活动记录。
 * @typedef {object} SessionEntry
 * @property {boolean} running  回合进行中（turn/start 起，turn/end 止）
 * @property {number} waiting   正在等待用户的次数（权限确认与选择题可能并发，故用计数）
 * @property {string} waitWhy   最近一次等待的原因（'approval' | 'question'，仅调试用）
 * @property {number} serveUntil 端菜到期时间戳（0 = 不在端菜）
 * @property {number} thinkUntil 托腮兜底到期时间戳（0 = 没在托腮）
 */

/**
 * 状态机。一个插件实例持有一个；进程内内存态，重启即回到待机。
 */
export class CookPetState {
  constructor(now = Date.now) {
    /** 严格递增的 counter（客户端据此判断"变了没有"） */
    this.counter = 0;
    /** 对外展示的状态 */
    this.state = 'idle';
    /** 每会话的活动记录：sessionId → SessionEntry */
    this.sessions = new Map();
    /** 注入时钟，便于测试 */
    this.now = now;
  }

  /** 下一个 counter：保证严格递增，重启也不会与客户端手里的旧值撞车 */
  next() {
    this.counter = Math.max(this.now(), this.counter + 1);
    return this.counter;
  }

  /** 取（或创建）某会话的记录 */
  entry(sessionId) {
    let e = this.sessions.get(sessionId);
    if (e === undefined) {
      e = { running: false, waiting: 0, waitWhy: '', serveUntil: 0, thinkUntil: 0 };
      this.sessions.set(sessionId, e);
    }
    return e;
  }

  /** 某会话当前该显示的档位（调用方负责先清过期字段） */
  phaseOf(e) {
    if (e.waiting > 0) return 'think';
    if (e.running) return 'cook';
    if (e.serveUntil !== 0) return 'serve';
    return 'idle';
  }

  /**
   * 重算对外展示状态：清理过期记录 → 逐会话求档位 → 取优先级最高者。
   * 只有对外状态真的变了才推进 counter。
   */
  recompute() {
    const t = this.now();
    let best = 'idle';
    for (const [id, e] of this.sessions) {
      // 计时类状态到点即失效（端菜播完 / 托腮兜底超时）
      if (e.waiting > 0 && e.thinkUntil !== 0 && t >= e.thinkUntil) {
        e.waiting = 0;
        e.thinkUntil = 0;
        e.waitWhy = '';
      }
      if (e.serveUntil !== 0 && t >= e.serveUntil) {
        e.serveUntil = 0;
      }
      // 既没在跑、也没在等、也不端菜 → 这条记录没意义了，删掉（避免 Map 无限增长）
      if (!e.running && e.waiting === 0 && e.serveUntil === 0) {
        this.sessions.delete(id);
        continue;
      }
      const p = this.phaseOf(e);
      if (PRIORITY[p] > PRIORITY[best]) best = p;
    }
    if (best === this.state) return false;
    this.state = best;
    this.next();
    return true;
  }

  /** 任务开始（turn/start）：该会话进入炒菜，并清掉上一轮残留的端菜与等待 */
  startTask(sessionId) {
    const e = this.entry(sessionId);
    e.running = true;
    e.serveUntil = 0; // 新一轮立刻打断庆祝
    e.waiting = 0; // 上一轮残留的等待一并清掉
    e.waitWhy = '';
    e.thinkUntil = 0;
    return this.recompute();
  }

  /** 任务结束（turn/end）：完成→端菜并开始计时；其余→该会话静默回空闲 */
  endTask(sessionId, kind) {
    if (classifyTurnEnd(kind) === 'completed') {
      const e = this.entry(sessionId);
      e.running = false;
      e.waiting = 0; // 回合已收口，等待随之失效
      e.waitWhy = '';
      e.thinkUntil = 0;
      e.serveUntil = this.now() + SERVE_HOLD_MS;
    } else {
      // 被打断 / 出错 / 阻塞：静默回待机，绝不庆祝
      this.sessions.delete(sessionId);
    }
    return this.recompute();
  }

  /**
   * 开始等待用户（权限确认弹窗 / ask_user_question 选择题）。
   *
   * 与 endWait 成对使用；用**计数**而非布尔：两次并发等待时，
   * 先结束的那个不能把状态提前清掉（否则会"用户还没答，桌宠已经在炒菜了"）。
   * @param {string} sessionId
   * @param {string} [why] 等待原因（'approval' | 'question' …），只用于调试
   */
  beginWait(sessionId, why = '') {
    const e = this.entry(sessionId);
    e.waiting += 1;
    e.waitWhy = why;
    e.thinkUntil = this.now() + THINK_MAX_MS;
    return this.recompute();
  }

  /**
   * 结束一次等待（用户答复了 / 请求被取消 / 弹窗被关掉）。
   * 多余的结束调用是安全的（不会把计数压成负数）。
   */
  endWait(sessionId) {
    const e = this.sessions.get(sessionId);
    if (e === undefined) return false;
    if (e.waiting > 0) e.waiting -= 1;
    if (e.waiting === 0) {
      e.waitWhy = '';
      e.thinkUntil = 0;
    }
    return this.recompute();
  }

  /**
   * 兜底纠偏：会话已空闲（`agent/status: idle`）→ 结束"进行中/在等你"的部分。
   *
   * ⚠️ **绝不能顺手把端菜一起清掉**。真实的回合结束顺序是：
   *     turn/end(completed) → 进入端菜 5 秒 → agent/status(idle)
   * 也就是"空闲"事件紧跟着端菜状态到达。如果这里把整条会话记录删掉，
   * 端菜（举盘）会**被瞬间秒杀**，画面上就是"炒菜 → 直接待机"，用户看不到报喜动作。
   * 所以这里只清 running/waiting，**保留 serveUntil 让端菜走完它该有的 5 秒**。
   */
  settleIdle(sessionId) {
    const e = this.sessions.get(sessionId);
    if (e === undefined) return false;
    let changed = false;
    if (e.running) {
      e.running = false;
      changed = true;
    }
    if (e.waiting > 0) {
      e.waiting = 0;
      e.thinkUntil = 0;
      e.waitWhy = '';
      changed = true;
    }
    if (!changed) return false;
    return this.recompute();
  }

  /** 硬清理：把该会话的记录整条删掉（插件卸载/极端兜底用；不要拿它处理普通的 idle 事件） */
  idleSession(sessionId) {
    return this.sessions.delete(sessionId) ? this.recompute() : false;
  }

  /**
   * 下一次需要定时唤醒的时刻（毫秒后）；无需唤醒返回 0。
   * 端菜到点要回待机、托腮兜底到点要自愈，二者取最早。
   */
  nextDeadline() {
    const t = this.now();
    let best = 0;
    for (const e of this.sessions.values()) {
      const candidates = [e.serveUntil, e.waiting > 0 ? e.thinkUntil : 0];
      for (const at of candidates) {
        if (at === 0) continue;
        const delay = Math.max(1, at - t);
        if (best === 0 || delay < best) best = delay;
      }
    }
    return best;
  }

  /** 当前快照（GET /state 的响应体主体） */
  snapshot() {
    this.recompute();
    return { counter: this.counter, state: this.state };
  }
}

/**
 * 端菜计时器需要被定时唤醒：下次需要检查的时刻（无需唤醒返回 0）。
 * 保留这个纯函数是为了让"唤醒时机"可被单独测试（定时器本身没法在单测里等待 5 秒）。
 */
export function nextServeDeadline(snapshotState, serveUntil, now) {
  if (snapshotState !== 'serve' || serveUntil === 0) return 0;
  return Math.max(1, serveUntil - now);
}

/**
 * 状态 → 素材文件名（客户端与宿主共用同一张表，避免两边各写一份走样）。
 *
 * 现在是**已抠好的透明 VP9 WebM**（带 alpha 通道），6 段共用同一裁切框，
 * 浏览器与 Electron 里都能直接透出背景，不再需要 CSS 裁切或卡片底。
 * 换素材时保持"按动作语义命名"这个约定即可。
 */
export const STATE_ASSETS = {
  idle: 'idle.webm',
  cook: 'cook.webm',
  serve: 'serve.webm',
  think: 'think.webm',
  wink: 'wink.webm',
  spin: 'spin.webm',
};

/** 全部素材文件名（宿主路由白名单用，防路径穿越） */
export const ASSET_FILES = Object.freeze(Object.values(STATE_ASSETS));

/** 素材目录名（宿主与桌面 helper 共用；换目录只改这一处） */
export const ASSET_DIR_NAME = 'pet';

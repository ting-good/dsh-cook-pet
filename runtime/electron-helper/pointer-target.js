'use strict';
/**
 * 点击穿透判定（纯函数，无 Electron 依赖，可单测）
 *
 * 背景：桌面窗默认**整窗点击穿透**（`setIgnoreMouseEvents(true, { forward: true })`），
 * 只有光标进入"宠物身体"范围时才翻回可交互。这样透明像素不会挡住下层应用，
 * 与浏览器 overlay（只有宠物本体可点）的行为严格对齐。
 *
 * 为什么需要这个模块：`forward: true` 依赖 Electron 的低级鼠标钩子把 mousemove
 * 转发进渲染端做命中判定，但**该钩子在 Windows 上会静默失效**（回调超时被系统摘掉、
 * 或被其它软件的钩子干扰）。失效后渲染端再也收不到鼠标移动 → 永远翻不回可交互 →
 * 宠物完全点不动。所以主进程必须自己按真实光标位置兜底轮询，本模块就是那个兜底判定。
 *
 * ⚠️ 拖拽期间（busy）：位置判定**完全不参与**，且**不能加任何"离得近才算"的容差**。
 * 原因是拖拽会让窗口跟随光标移动，窗口比宠物大一圈（四周余量），光标很容易跑到窗口外；
 * 一旦判成"窗外"就会翻回穿透，渲染端正在进行的 pointermove/pointerup 全部中断，
 * 鼠标还按着、宠物却按旧速度飞出去。那些容差正是这个 bug 本身。
 */

/** 命中框的输入区尺寸（用于把屏幕坐标换算成窗口内坐标） */
const POINTER_POLL_MS = 60;

/** 在"窗口内、但不在宠物身上"的余量区停留超过这个时长 → 恢复穿透 */
const OFF_BODY_RELEASE_MS = 400;

/**
 * 宠物身体的命中矩形（相对**窗口内容区**的像素坐标）。
 *
 * 窗口 = 宠物框 + 四周 margin 余量。渲染端按实际画面内容算出身体框后经 IPC 上报，
 * 主进程不猜 —— 因为素材尺寸/裁切比例都可能变，猜出来的框会和可见宠物错位。
 *
 * @param {{width:number,height:number}} bounds 窗口内容区尺寸
 * @param {{l:number,t:number,r:number,b:number}|null} input 渲染端上报的身体框（相对内容区）
 */
function bodyRect(bounds, input) {
  if (input && Number.isFinite(input.l)) {
    return {
      left: input.l,
      top: input.t,
      right: input.r,
      bottom: input.b,
    };
  }
  // 渲染端还没上报（首帧之前）：退回"整个内容区"，宁可暂时可交互也不要点不动
  return { left: 0, top: 0, right: bounds.width, bottom: bounds.height };
}

/**
 * 光标相对窗口的分区。
 * @returns {'outside'|'body'|'margin'}
 */
function pointerZone(bounds, point, input) {
  const inWindow =
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height;
  if (!inWindow) return 'outside';

  const r = bodyRect(bounds, input);
  const px = point.x - bounds.x;
  const py = point.y - bounds.y;
  const inBody = px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  return inBody ? 'body' : 'margin';
}

/**
 * 唯一判定：给定光标与当前状态，窗口**是否应该穿透**。
 *
 * 优先级（从高到低）：
 *   1. busy（渲染端正在拖拽）→ **不穿透**，位置判定被完全否决
 *   2. 光标在宠物身上          → 不穿透
 *   3. 光标在余量区            → 保持现状；非 busy 且连续停留 > 400ms 后恢复穿透
 *   4. 光标在窗口外            → 穿透
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口内容区屏幕坐标
 * @param {{x:number,y:number}} point 光标屏幕坐标（DIP）
 * @param {boolean} ignoring 当前是否穿透
 * @param {boolean} busy 渲染端是否正在拖拽
 * @param {number} offBodyMs 已在余量区连续停留的毫秒数
 * @param {{l:number,t:number,r:number,b:number}|null} input 渲染端上报的身体框
 * @returns {boolean} 目标穿透状态
 */
function decideWindowIgnore(bounds, point, ignoring, busy, offBodyMs = 0, input = null) {
  // 1. 拖拽租约最高优先级：绝不因位置判定被剥夺
  if (busy) return false;

  const zone = pointerZone(bounds, point, input);
  if (zone === 'outside') return true; // 窗外 → 穿透
  if (zone === 'body') return false; // 宠物身上 → 可交互
  // 3. 余量区：短暂停留保持现状（避免在宠物边缘反复横跳），久留则让出
  if (offBodyMs >= OFF_BODY_RELEASE_MS) return true;
  return ignoring;
}

module.exports = {
  POINTER_POLL_MS,
  OFF_BODY_RELEASE_MS,
  bodyRect,
  pointerZone,
  decideWindowIgnore,
};

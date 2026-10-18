'use strict';
/**
 * 置顶看门狗（纯函数，可单测）
 *
 * 为什么需要它：**Windows 上 `alwaysOnTop` 会"位在、带不在"**。
 * Electron 切换点击穿透时走 `SetWindowLong(GWL_EXSTYLE)` 读-改-写，
 * 这一步会把 `WS_EX_TOPMOST` 位又写回去；于是查询 `isAlwaysOnTop()` 永远为 true，
 * 但窗口实际上已经沉到其它窗口下面了 —— 桌宠"消失"，而代码看起来一切正常。
 *
 * 对策：定期**重新钉一次**置顶。注意必须用 `setAlwaysOnTop(true, 'screen-saver')`，
 * 光调 `moveTop()` 是无效的（它只改 z-order 不改扩展样式位，下一次翻转穿透又会掉）。
 */

/** 看门狗检查间隔 */
const TOPMOST_WATCHDOG_TICK_MS = 1000;

/** 每隔几次检查就强制重钉一次（1s × 5 = 5s） */
const REASSERT_EVERY_TICKS = 5;

/**
 * 这一拍要不要重钉置顶？
 *
 * 策略：不是每一拍都钉（那会让窗口频繁参与 z-order 竞争、可能压住用户的其它置顶窗），
 * 而是 **周期性强制重钉**。刻意不依赖 `win.isAlwaysOnTop()` 的返回值 —— 它在这个
 * 场景下不可信（见文件头注释）。
 *
 * @param {number} tick 已经过的拍数
 * @returns {boolean}
 */
function shouldReassertTopmost(tick) {
  return Number.isFinite(tick) && tick > 0 && tick % REASSERT_EVERY_TICKS === 0;
}

module.exports = { TOPMOST_WATCHDOG_TICK_MS, REASSERT_EVERY_TICKS, shouldReassertTopmost };

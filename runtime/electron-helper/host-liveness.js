'use strict';
/**
 * 宿主存活看护（纯函数，可单测）
 *
 * 为什么需要：helper 是宿主 spawn 出来的子进程。宿主退出后如果不自尽，
 * 桌宠会变成**孤儿窗口赖在桌面上**，而且它连的 HTTP 也没了、状态永远不更新。
 *
 * 两道防线：
 *   1. **管道断开**（首选，即时）：helper 的 stdout/stderr 是接给宿主的管道，
 *      宿主一死管道就断，读写会抛 EPIPE/ERR_STREAM_DESTROYED。这是最快的信号。
 *   2. **PID 探测**（兜底，秒级）：宿主 PID 经环境变量传进来，定期探活。
 *      管道在某些平台/场景下不一定立刻报错，PID 探测兜住这种情况。
 *
 * 注意：**不要**用 `process.exit()` 之外的花哨方式退出，也不要在退出前弹模态框
 * （宿主已死，弹框没人关，会留一个卡死的进程）。
 */

/** PID 探测间隔 */
const HOST_POLL_MS = 2000;

/**
 * 解析宿主 PID（环境变量传入，可能是空串/非数字）。
 * @returns {number} 合法正整数，或 0 表示"没提供，不启用 PID 探测"
 */
function parseHostPid(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 这个错误是不是"管道断了"（宿主已死） */
function isBrokenPipeError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = String(error.code ?? '');
  return (
    code === 'EPIPE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_IPC_CHANNEL_CLOSED' ||
    /broken pipe/i.test(String(error.message ?? ''))
  );
}

/**
 * 宿主进程是否已经没了。
 * @param {number} pid 宿主 PID（0 表示未提供）
 * @param {(pid:number)=>boolean} [isAlive] 探活函数（默认用 process.kill(pid,0)），便于测试注入
 * @returns {boolean} true = 宿主已死，helper 应当自尽
 */
function hostIsGone(pid, isAlive) {
  if (!Number.isInteger(pid) || pid <= 0) return false; // 没提供 PID → 不判断（不能误杀）
  const probe =
    isAlive ??
    ((p) => {
      try {
        // 信号 0 只做存在性与权限检查，不真的发信号
        process.kill(p, 0);
        return true;
      } catch (e) {
        // EPERM = 进程存在但没权限（仍然算活着）；ESRCH = 进程不存在
        return e && e.code === 'EPERM';
      }
    });
  try {
    return !probe(pid);
  } catch {
    // 探活函数本身抛错：保守起见当作"还活着"，不误杀
    return false;
  }
}

module.exports = { HOST_POLL_MS, parseHostPid, isBrokenPipeError, hostIsGone };

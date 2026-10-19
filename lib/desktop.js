/**
 * 桌面 helper 的进程管理（宿主侧）
 *
 * 职责：按需 spawn Electron helper（透明置顶窗），并在它异常退出时**有限度地**重启，
 * 宿主关闭时确保它一起退出（绝不留孤儿窗口）。
 *
 * 三个必须踩对的点：
 *
 * 1. **必须删掉 ELECTRON_RUN_AS_NODE**：DSH 桌面宿主自带这个环境变量，
 *    直接透传会让 Electron 以"纯 Node 模式"启动 → `require('electron')` 抛
 *    MODULE_NOT_FOUND、helper 秒退。注意要 **delete 这个键**，设成空串会让 Electron abort。
 *
 * 2. **熔断**：限制重启次数，否则 Electron 启动失败（未下载、显卡驱动问题等）时
 *    会变成"疯狂重启"的死循环，吃满 CPU。
 *
 * 3. **宿主退出即杀 helper**：挂在 ctx 的清理函数里，另外 helper 侧还有管道 + PID 两道看护兜底。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（本文件在 lib/ 下） */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** helper 目录 */
const HELPER_DIR = join(PACKAGE_ROOT, 'runtime', 'electron-helper');

/** 默认 Electron 版本（与 scripts/ensure-electron.mjs 保持一致） */
const DEFAULT_ELECTRON_VERSION = '43.3.0';

/** 重启熔断：窗口内最多重启几次，超过就放弃并保持静默 */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

/**
 * 定位 Electron 可执行文件。依次尝试：
 *   1. 环境变量 DSH_COOK_PET_ELECTRON（用户手工指定）
 *   2. $DSH_HOME/electron/electron.exe（scripts/ensure-electron.mjs 的下载位置）
 *   3. 包内 node_modules/electron/dist（如果随包安装了）
 *
 * @param {string} [dshHome] 覆盖 DSH_HOME（便于测试，不污染真实环境）
 * @param {NodeJS.ProcessEnv} [env] 覆盖环境变量（便于测试）
 * @returns {string|undefined}
 */
export function findElectron(dshHome, env = process.env) {
  const rel =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
        : 'electron';

  const home = dshHome ?? env.DSH_HOME ?? join(env.USERPROFILE || '', '.dsh');
  const candidates = [
    env.DSH_COOK_PET_ELECTRON,
    join(home, 'electron', rel),
    join(PACKAGE_ROOT, 'node_modules', 'electron', 'dist', rel),
  ].filter(Boolean);

  return candidates.find((p) => existsSync(p));
}

/**
 * 桌面 helper 的生命周期管理器。
 */
export class DesktopHelper {
  /**
   * @param {object} opts
   * @param {string|undefined} opts.electron 显式指定 Electron 路径
   * @param {number} opts.petHeight 宠物高度（px），决定窗口大小
   * @param {string} opts.stateUrl 宿主的 /state 地址，helper 轮询它来切动作
   * @param {'cutout'|'framed'} [opts.assetMode] 素材模式：透明抠图 / 带卡片底（默认 cutout）
   * @param {(msg:string)=>void} [opts.log]
   * @param {typeof spawn} [opts.spawn] 注入 spawn（便于测试环境变量净化逻辑）
   */
  constructor(opts) {
    this.electron = opts.electron ?? findElectron();
    this.petHeight = opts.petHeight ?? 110;
    this.stateUrl = opts.stateUrl ?? '';
    // 素材模式由宿主**统一传入**，helper 不自己猜（猜错了两边渲染就会不一样）
    this.assetMode = opts.assetMode === 'framed' ? 'framed' : 'cutout';
    this.log = opts.log ?? ((msg) => console.log('[dsh-cook-pet] ' + msg));
    this.spawn = opts.spawn ?? spawn;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.restarts = [];
    this.stopped = false;
    /** 后台"自动准备 Electron"的状态：进行中去重 / 失败后不再反复重试 */
    this._ensuring = false;
    this._ensureFailed = false;
  }

  /**
   * 是否具备启动条件。
   * 注意必须**检查 Electron 文件真的存在**，不能只判断路径字符串非空 ——
   * 否则配了个不存在的路径也会"看起来可用"，然后在 spawn 时才失败，
   * 报错点离原因很远（用户只看到"桌宠没出现"）。
   */
  available() {
    return Boolean(this.electron) && existsSync(this.electron) && existsSync(join(HELPER_DIR, 'main.js'));
  }

  /** 当前是否在跑 */
  running() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** 启动 helper（已在跑则忽略） */
  start() {
    if (this.stopped || this.running()) return false;
    if (!this.available()) {
      // 不在这里阻塞下载：交给 ensureRuntime() 在后台完成，下个周期自动重试。
      this.log(
        '桌面窗口暂不可用：还没准备好 Electron 运行时（首次会自动下载，约 100 MB）。' +
          '不想等可以设置 DSH_COOK_PET_ELECTRON 指向已有的 electron，或 DSH_COOK_PET_DESKTOP=0 只用页面内的照照。',
      );
      return false;
    }

    // ★ 必须删键而不是设空串：空串会让 Electron 直接 abort
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    env.DSH_COOK_PET_HOST_PID = String(process.pid);
    env.DSH_COOK_PET_PET_HEIGHT = String(this.petHeight);
    env.DSH_COOK_PET_STATE_URL = this.stateUrl;
    env.DSH_COOK_PET_ASSET_MODE = this.assetMode;

    let child;
    try {
      child = this.spawn(this.electron, [HELPER_DIR], {
        cwd: HELPER_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.log('启动桌面窗口失败：' + (e instanceof Error ? e.message : String(e)));
      return false;
    }

    this.child = child;
    child.stdout?.on('data', (buf) => {
      const text = String(buf).trim();
      if (text) this.log('[helper] ' + text);
    });
    child.stderr?.on('data', (buf) => {
      const text = String(buf).trim();
      if (text) this.log('[helper] ' + text);
    });
    child.on('error', (e) => {
      this.log('桌面窗口进程错误：' + (e instanceof Error ? e.message : String(e)));
    });
    child.on('exit', (code) => {
      const wasRunning = this.child === child;
      if (wasRunning) this.child = null;
      if (this.stopped || !wasRunning) return;
      this.log(`桌面窗口退出（code=${code}）`);
      this.scheduleRestart();
    });

    this.log('桌面窗口已启动，桌宠将浮在其它应用之上');
    return true;
  }

  /**
   * 后台自动准备 Electron 运行时（用户不需要敲任何命令）。
   *
   * 设计取舍：**不在宿主启动路径上同步下载**。100 MB 的下载会拖住 DSH 的启动，
   * 而桌宠是可选装饰 —— 所以这里 fire-and-forget：下载期间页面内的照照照常工作，
   * 下载完成后下一次 start() 就会成功（宿主每 30 秒重试一次）。
   *
   * 只在真正需要时触发一次（`_ensuring` 去重），失败也不重试下载（避免无限拉流量）。
   * @returns {boolean} 是否**新发起**了一次准备（false = 已在进行 / 已给过结论）
   */
  ensureRuntime() {
    if (this.stopped || this._ensuring || this._ensureFailed) return false;
    this._ensuring = true;

    this.log('首次使用桌面窗口：正在后台准备 Electron 运行时（约 100 MB，只做一次）…');
    const script = fileURLToPath(new URL('../scripts/ensure-electron.mjs', import.meta.url));

    // ★ 两个平台细节：
    //   1. 用 fileURLToPath 而不是 URL.pathname —— 后者在 Windows 上带前导 `/` 且
    //      对空格/中文的百分号编码不还原，直接拼进 argv 会找不到文件。
    //   2. DSH 桌面宿主本身跑在 Electron 里（execPath 是 DeepSeek Harness.exe），
    //      所以要显式给 ELECTRON_RUN_AS_NODE=1 才是"纯 Node"执行；
    //      纯 Node 宿主下这个变量给了也无害（Electron 才认它）。
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

    let child;
    try {
      // stdio 的 stderr 用 pipe：ensure-electron 在失败时会打印"手动安装指引"，
      // 必须把它接出来（转发到宿主 stderr → DSH 日志），否则用户只看到一个
      // 无声消失的桌宠，不知道是 Electron 下载失败、也不知道该怎么办。
      child = this.spawn(process.execPath, [script, '--quiet'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env,
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.log('[ensure-electron] ' + text);
      });
    } catch (e) {
      this._ensuring = false;
      this._ensureFailed = true;
      this.log('自动准备 Electron 失败：' + (e instanceof Error ? e.message : String(e)));
      return false;
    }

    child.on('error', (e) => {
      this._ensuring = false;
      this._ensureFailed = true;
      this.log('自动准备 Electron 失败：' + (e instanceof Error ? e.message : String(e)));
    });
    child.on('exit', (code) => {
      this._ensuring = false;
      if (code === 0) {
        // 重新定位：ensure-electron 把可执行文件装到了已知位置
        this.electron = findElectron();
        this.restarts = []; // 运行时到位了，重置熔断计数
        this.log('Electron 运行时已就绪，桌面窗口会在下一次重试时出现');
      } else {
        this._ensureFailed = true;
        // 具体的失败原因和 4 种手动补救方式已由上面的 stderr 转发打印过；
        // 这里只补一句"下次重试会断点续传"，避免用户以为要从头再来。
        this.log(
          '自动准备 Electron 失败（退出码 ' + code + '）。' +
            '进度已保留，稍后重启 DSH 或手动运行上面的「方式 1」命令即可断点续传。',
        );
      }
    });
    return true;
  }

  /** 有限度重启：超过熔断阈值就不再尝试，避免"疯狂重启"吃满 CPU */
  scheduleRestart() {
    // 若是因为缺少 Electron 而失败，先尝试把它装上，再排重启
    if (!this.available() && !this._ensureFailed) {
      this.ensureRuntime();
    }
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.log(
        `桌面窗口在 ${RESTART_WINDOW_MS / 1000}s 内已退出 ${this.restarts.length} 次，停止重启。` +
          '常见原因：Electron 未下载完整、显卡驱动问题。可查看上面的 [helper] 日志。',
      );
      return;
    }
    this.restarts.push(now);
    setTimeout(() => {
      if (!this.stopped) this.start();
    }, 1500);
  }

  /** 停止 helper（宿主卸载/退出时调用）。先温和要求退出，超时再强杀。 */
  stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch {
      /* 已经没了 */
    }
    // 3 秒还没退出就强杀，确保不留孤儿窗口
    const killer = setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
    }, 3000);
    if (killer.unref) killer.unref();
  }
}

export { DEFAULT_ELECTRON_VERSION, HELPER_DIR, MAX_RESTARTS, RESTART_WINDOW_MS };

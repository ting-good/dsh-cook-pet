/**
 * dsh-cook-pet 宿主侧插件
 *
 * 这是本插件**唯一的代码入口**（没有浏览器半侧：照照只以独立置顶窗存在）。
 *
 * 职责四件事：
 *   1. 监听 DSH 宿主事件（`session/event` + 一组"等你回话"的事件），用状态机聚合出
 *      「照照现在在干嘛」，写进一个纯内存的轮询状态 S；
 *   2. 在 DSH WebServer 上挂一个 `/dsh-cook-pet/` 前缀路由：
 *        GET /dsh-cook-pet/state          → S（桌面置顶窗轮询的唯一数据源）
 *        GET /dsh-cook-pet/asset/<名字>    → 包内 assets/pet 下的透明动画素材（白名单）
 *   3. 管理**桌面置顶窗** helper 进程（Electron），让它浮在其它应用之上；
 *      可用 DSH_COOK_PET_DESKTOP=0 关闭。
 *   4. 给"端菜自动回待机 / 托腮兜底自愈"排一个看门狗定时器（只在有计时状态时才排）。
 *
 * 为什么用「宿主聚合 + 前端轮询」而不是事件流：
 *   DSH 0.1.5 起浏览器侧的事件流 API（api.events.mux/host）已删除，
 *   现行的普遍做法是「宿主监听事件 → 写状态 → 前端轮询」。
 *   1s 一次的本地 GET 代价可以忽略，且不依赖 DSH 版本间会漂移的前端事件 API。
 *   桌面 helper 走 file:// 页面，所以用 127.0.0.1 的绝对地址来轮询。
 *
 * 契约（在本机 DSH 0.2.0-rc 系列上实测）：
 *   - 事件 `session/event`：emit 模式，回调签名 (session, event)
 *   - 事件 `agent/status`：emit 模式，回调签名 (payload: { agent, status })
 *   - 服务 `webServer`：register({ kind:'prefix', path, handler })
 *   - 生命周期：ctx.effect(fn, label) 的返回值即清理函数
 */

import { createReadStream, existsSync, fstatSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DesktopHelper } from './desktop.js';
import { ASSET_DIR_NAME, ASSET_FILES, CookPetState, DEFAULT_PET_HEIGHT } from './state.js';
import { createWaitingTracker, sessionIdOf } from './waiting.js';

/** 插件行 id：必须与 cordis.patch.yml 里的 id 一致 */
export const name = 'dsh-cook-pet';

/** 需要注入的服务：webServer（挂 HTTP 路由） */
export const inject = ['webServer'];

/** 路由前缀（宿主侧唯一对外地址；客户端与桌面 helper 都拼它） */
export const ROUTE_PREFIX = '/dsh-cook-pet';

/** 包根目录：lib/index.js 的上一级 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 动画素材目录（透明 webm，见 lib/state.js 的 ASSET_DIR_NAME） */
const ASSET_DIR = join(PACKAGE_ROOT, 'assets', ASSET_DIR_NAME);

/** 扩展名 → Content-Type */
const MIME = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

/**
 * 发送 JSON。
 * Cache-Control 必须是 no-store：状态是实时的，被缓存会让前端永远看到旧状态。
 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 流式返回素材文件。
 *
 * Content-Length 取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：
 * 二者之间文件若被替换/截断，声明的长度就会大于实际字节数，这个响应会**永不结束也不报错**
 * （浏览器表现为视频卡住、loadeddata 永不触发）。同一个 fd 的 fstat 与实际读出的字节天然一致。
 */
function sendFile(res, file) {
  const ext = file.slice(file.lastIndexOf('.'));
  const stream = createReadStream(file);
  stream.once('open', (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy();
      return;
    }
    try {
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': fstatSync(fd).size,
        // 素材装进包后不会变；换素材请换文件名或重启宿主
        'cache-control': 'public, max-age=86400',
      });
    } catch {
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    }
    stream.pipe(res);
  });
  // 读失败（文件被删/被占用）→ 立刻断连，让客户端马上看到失败而不是无限等待
  stream.on('error', () => res.destroy());
  // 客户端提前断开（切动作时高频发生）→ 停读，别把整个文件读完
  res.on('close', () => stream.destroy());
}

/** 解析素材相对名，确保它仍在 ASSET_DIR 内（防路径穿越） */
function resolveAsset(rel) {
  if (!rel) return undefined;
  const candidate = normalize(join(ASSET_DIR, rel));
  const rootWithSep = ASSET_DIR.endsWith(sep) ? ASSET_DIR : ASSET_DIR + sep;
  if (candidate !== ASSET_DIR && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/**
 * 桌宠高度（px）。环境变量 DSH_COOK_PET_PET_HEIGHT 可覆盖，默认取 state.js 的单一来源。
 * 合法范围与桌面窗的尺寸档位保持一致，避免手改出离谱的值。
 */
function petHeight() {
  const raw = Number(process.env.DSH_COOK_PET_PET_HEIGHT);
  if (Number.isFinite(raw) && raw >= 60 && raw <= 400) return Math.round(raw);
  return DEFAULT_PET_HEIGHT;
}

/**
 * 宿主插件主体。
 * @param {any} ctx Cordis 上下文（webServer 等 service 无静态类型）
 */
export function apply(ctx) {
  const state = new CookPetState();

  // 端菜到点回待机 / 托腮兜底自愈都靠这个看门狗。
  // 只在**确实有计时状态**时才排（空闲时一个定时器都不留，别让插件空转）。
  let timer = null;
  const disarm = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = () => {
    disarm();
    const delay = state.nextDeadline();
    if (delay === 0) return;
    timer = setTimeout(() => {
      timer = null;
      state.recompute(); // 到点：清掉过期的端菜/托腮
      arm(); // 可能还有下一个计时（比如两个会话各自端菜）
    }, delay);
    if (typeof timer.unref === 'function') timer.unref(); // 定时器不该阻止进程退出
  };

  // ---- 事件订阅：回合生命周期 + 等你回话（托腮）----
  //
  // 只挂**一个** `session/event` 监听器，顺序固定：先处理回合开始/结束，再把事件交给等待跟踪器。
  // 拆成两个监听器也能跑，但"谁先谁后"就不受控了 —— 回合结束已经清空等待，
  // 跟踪器却还在按自己的令牌计数，两边容易对不上。合成一处最省心。
  const waiting = createWaitingTracker({ state, onChange: arm });
  ctx.effect(() => {
    const disposeSession = ctx.on('session/event', (session, event) => {
      const type = event?.type;
      if (!type) return;
      const sessionId = sessionIdOf(session);
      if (type === 'turn/start') {
        state.startTask(sessionId);
        arm();
      } else if (type === 'turn/end') {
        state.endTask(sessionId, String(event?.data?.reason?.kind ?? ''));
        arm();
      }
      // 权限确认（approval/asked ↔ approval/decided）、
      // 选择题（tool/call ask_user_question ↔ tool/result）在这里变成"托腮"
      waiting.handleEvent(session, event);
    });
    return () => {
      disposeSession();
      waiting.dispose();
      disarm();
    };
  }, 'dsh-cook-pet: session events');

  // ---- 事件订阅：兜底纠偏（会话已空闲却还挂着炒菜/托腮）----
  //
  // 注意 `agent/status` 是**宿主事件**，不是 session/event 的子事件：
  // 早先按 `event.type === 'agent/status'` 写在 session/event 里，那条分支永远不会命中
  // （SessionEventMap 里没有这个类型），等于没有兜底。
  //
  // ⚠️ 这里必须用 `settleIdle` 而不是 `idleSession`：回合结束的真实顺序是
  //     turn/end(completed) → 端菜 5 秒 → agent/status(idle)
  // 空闲事件紧跟着端菜状态到达，若在这里整条删掉会话记录，**端菜（举盘）会被秒杀**，
  // 现场表现就是"炒菜 → 直接待机，看不到报喜动作"。
  ctx.effect(() => {
    const dispose = ctx.on('agent/status', (payload) => {
      if (String(payload?.status ?? '') !== 'idle') return;
      const sessionId = String(payload?.agent?.id ?? '');
      if (sessionId === '') return;
      if (state.settleIdle(sessionId)) {
        waiting.clearSession(sessionId);
        arm();
      }
    });
    return dispose;
  }, 'dsh-cook-pet: idle fallback');

  // ---- HTTP 路由：状态 + 素材 ----
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          try {
            // prefix 路由拿到的是**完整 URL（含前缀）**，先切掉前缀再匹配。
            // 注意不能先过 new URL()：它会把 `..` 归一化掉，等于帮攻击者绕过前缀判断，
            // 所以这里只在原始串上做「去查询串 + 去前缀」两步。
            const raw = String(req.url ?? '/');
            const query = raw.indexOf('?');
            let path = query === -1 ? raw : raw.slice(0, query);
            if (path.startsWith(ROUTE_PREFIX)) path = path.slice(ROUTE_PREFIX.length);
            if (path === '') path = '/';

            // 只暴露 /state 精确路径（不做 '/' 别名：那会让任何未匹配路径都返回状态）
            if (path === '/state') {
              // 只有桌面置顶窗一个消费者（本插件没有浏览器半侧），状态形状保持最小
              sendJson(res, 200, state.snapshot());
              return;
            }

            if (path.startsWith('/asset/')) {
              // decodeURIComponent 可能抛（畸形转义）→ 统一按 400 处理
              let rel;
              try {
                rel = decodeURIComponent(path.slice('/asset/'.length));
              } catch {
                res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('bad asset name');
                return;
              }
              // 白名单：只认 state.js 里登记过的素材名。
              // 名单匹配本身就挡掉了 `..`、子目录与绝对路径（含 Windows 上的 %5C 反斜杠），
              // 下面的 resolveAsset 是第二道防线（万一将来名单里出现带路径的名字）。
              if (!ASSET_FILES.includes(rel)) {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('unknown asset');
                return;
              }
              const file = resolveAsset(rel);
              if (file === undefined || !existsSync(file)) {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('asset missing');
                return;
              }
              sendFile(res, file);
              return;
            }

            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found');
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        },
      }),
    'dsh-cook-pet: routes',
  );

  // ---- 桌面置顶窗：spawn Electron helper ----
  //
  // 用 DSH_COOK_PET_DESKTOP=0 可关闭。这是**唯一的呈现方式**：
  // helper 轮询上面那两个路由拿状态与素材，所以状态一变它 1s 内就会跟着动。
  //
  // 首次使用缺 Electron 时，这里会**自动在后台下载**（约 100 MB、只做一次），
  // 用户不需要敲任何命令；下载期间页面内的照照照常工作。
  //
  // 地址：helper 走 file:// 页面、要跨 origin 访问宿主，所以用绝对地址（本机回环）。
  /** 自动准备 Electron 期间的重试定时器（卸载时要清掉，否则会留下定时器） */
  const retryTimers = [];
  if (process.env.DSH_COOK_PET_DESKTOP !== '0') {
    ctx.effect(() => {
      const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
      if (!port) {
        console.warn('[dsh-cook-pet] webServer 端口未知，跳过桌面窗口');
        return () => {};
      }
      const helper = new DesktopHelper({
        // 默认值来自 state.js 的 DEFAULT_PET_HEIGHT（单一来源）
        petHeight: petHeight(),
        stateUrl: `http://127.0.0.1:${port}${ROUTE_PREFIX}/state`,
        // 素材是抠好的透明 webm：桌面窗"无卡片底、直接浮起"
        assetMode: 'cutout',
      });
      // 稍等一拍再启动：等 webServer 真正开始监听、路由已挂上
      const startTimer = setTimeout(() => {
        // 先试一次；不可用时就**在后台自动下载** Electron，同时启动一个重试定时器。
        // 用户什么都不用敲：下载完（约 100 MB，只做一次）桌面窗会自动出现。
        if (!helper.start()) {
          helper.ensureRuntime();
          const retry = setInterval(() => {
            if (helper.start()) clearInterval(retry);
            // 下载失败或用户明确不要桌面窗时别无限重试
            else if (helper._ensureFailed) clearInterval(retry);
          }, 30_000);
          if (typeof retry.unref === 'function') retry.unref();
          retryTimers.push(retry);
        }
      }, 600);
      return () => {
        clearTimeout(startTimer);
        for (const t of retryTimers) clearInterval(t);
        retryTimers.length = 0;
        helper.stop();
      };
    }, 'dsh-cook-pet: desktop window');
  }
}

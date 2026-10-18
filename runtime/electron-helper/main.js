'use strict';
/**
 * dsh-cook-pet 桌面 helper 主进程
 *
 * 干什么：开一个**透明、无边框、置顶、跳过任务栏**的窗口，把桌宠渲染进去，
 * 让它在切换到你其它应用时依然浮在桌面上。
 *
 * 为什么是"局部小窗"而不是全屏透明画布：
 *   Windows 的 DWM 在「透明置顶窗 + 非穿透 + 已聚焦 + 完整盖住某个视频/动画窗口」四项齐备时，
 *   会把被盖住的窗口渲染成黑块。这个缺陷与窗口大小无关（26% 屏面积也能触发）。
 *   所以窗口只做成宠物那么大，宠物"移动"靠逐帧 setContentBounds 移动窗口实现。
 *
 * 点击穿透模型（三通道，缺一不可）：
 *   ① 默认整窗穿透 setIgnoreMouseEvents(true, { forward: true })
 *   ② 渲染端 mousemove 几何命中 → pet:set-interactive 翻转（正常路径）
 *   ③ 主进程 60ms 兜底轮询真实光标位置（**必需**：forward 的鼠标钩子在 Windows 上会静默失效）
 *   拖拽期间渲染端上报 pet:input-busy，主进程在 busy 时**绝不**翻回穿透——
 *   否则光标跑出窗口矩形就会中断拖拽，宠物按旧速度"飞"出去。
 *
 * 启动方式：由 DSH 宿主 spawn，见 src/host/helper-process 对应实现。
 *   环境变量：DSH_COOK_PET_HOST_PID（宿主 PID，用于宿主死后自尽）
 *             DSH_COOK_PET_PET_HEIGHT（宠物高度 px）
 *             DSH_COOK_PET_STATE_URL（宿主 /state 地址）
 *
 * ⚠️ 宿主必须删除 ELECTRON_RUN_AS_NODE 再 spawn，否则 Electron 会以纯 Node 模式启动，
 *    下面 require('electron') 直接失败（见开头的 try/catch 诊断）。
 */

let electronApi;
try {
  electronApi = require('electron');
} catch (error) {
  process.stderr.write(
    '[dsh-cook-pet helper] 启动失败：本进程被以「纯 Node 模式」拉起' +
      '（ELECTRON_RUN_AS_NODE=' +
      JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
      '）。该变量必须在 spawn 前 delete（设空串也会让 Electron abort）。\n',
  );
  process.exit(3);
}

const { app, BrowserWindow, ipcMain, screen } = electronApi;
const path = require('node:path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

/**
 * 素材目录的**绝对路径**。
 *
 * 为什么不让渲染端写相对路径：`file://` 页面里相对路径以 index.html 所在目录为基准，
 * 而本文件在 runtime/electron-helper/ 下、素材在包根的 assets/pet/，
 * 需要三层 `../`，极易数错（实测就写成了两层 → 桌面窗一片空白，且控制台只在
 * DevTools 里才能看到 404，主进程日志毫无线索）。
 * 这里直接算出绝对路径并用 pathToFileURL 转成 file:// URL 交给渲染端，彻底消除歧义。
 *
 * 素材位置：assets/pet 下 6 段带 alpha 的透明 VP9 WebM（idle/cook/serve/think/wink/spin），
 * 6 段共用同一裁切框，因此宽高完全相同。
 *
 * DSH_COOK_PET_ASSET_DIR 只给排障 / 占位素材验证用（scripts/verify-desktop.mjs 在素材
 * 还没产出时会指到临时目录）；正常宿主不设置，走的永远是包根 assets/pet。
 */
const ASSET_DIR = process.env.DSH_COOK_PET_ASSET_DIR
  ? path.resolve(process.env.DSH_COOK_PET_ASSET_DIR)
  : path.resolve(__dirname, '..', '..', 'assets', 'pet');
const ASSET_BASE_URL = pathToFileURL(ASSET_DIR).href + '/';

const { POINTER_POLL_MS, decideWindowIgnore } = require('./pointer-target.js');
const { TOPMOST_WATCHDOG_TICK_MS, shouldReassertTopmost } = require('./topmost-watchdog.js');
const { HOST_POLL_MS, hostIsGone, isBrokenPipeError, parseHostPid } = require('./host-liveness.js');

// ---------------------------------------------------------------------------
// 启动开关（必须在 app ready 之前）
// ---------------------------------------------------------------------------

// 免手势自动播放视频：桌宠是自动播放的，没有用户手势就会卡在第一帧
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 命名必须在任何 getPath('userData') 之前，否则位置文件会落到 Electron 的默认目录
app.setName('dsh-cook-pet-helper');

// Windows 上透明窗口有 DWM 合成缺陷，关掉硬件加速可以规避大部分花屏/黑块
if (process.platform === 'win32') app.disableHardwareAcceleration();

// ---------------------------------------------------------------------------
// 宿主存活看护
// ---------------------------------------------------------------------------

/** 宿主已死 → 立刻自尽，别留一个孤儿窗口赖在桌面上 */
function exitForDeadHost() {
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    /* 尽力而为 */
  }
  process.exit(0);
}

// 防线 1：管道断开（最快）
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => {
    if (isBrokenPipeError(e)) exitForDeadHost();
  });
}

// 防线 2：PID 探测（兜底）
const HOST_PID = parseHostPid(process.env.DSH_COOK_PET_HOST_PID);
if (HOST_PID > 0) {
  const t = setInterval(() => {
    if (hostIsGone(HOST_PID)) exitForDeadHost();
  }, HOST_POLL_MS);
  if (t.unref) t.unref();
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 窗口内容区高度（px）—— 桌宠在桌面上的高度基准。
 *  默认值由宿主经环境变量传入（单一来源见 lib/state.js 的 DEFAULT_PET_HEIGHT）。
 *  可被「右键切换大小」改写，并持久化到 position.json。 */
let PET_H = Math.max(60, Number(process.env.DSH_COOK_PET_PET_HEIGHT) || 138);
/** 右键可循环的尺寸档位（px）。递增，便于"再大一点/再小一点"的直觉。 */
const SIZE_STEPS = [110, 138, 190, 260];
/** 四周外扩余量：给拖拽留一点缓冲（占内容尺寸的比例） */
const MARGIN_RATIO = 0.12;

/**
 * 下一档尺寸：按档位循环。
 * 当前值不在档位里（例如被 DSH_COOK_PET_PET_HEIGHT 设成任意值）时，
 * 跳到**第一个比它大的档位**，都超了就回到最小 —— 保证每一次右键都有可见变化。
 */
function nextSize(current) {
  const i = SIZE_STEPS.indexOf(current);
  if (i >= 0) return SIZE_STEPS[(i + 1) % SIZE_STEPS.length];
  return SIZE_STEPS.find((s) => s > current) ?? SIZE_STEPS[0];
}

/**
 * 素材模式：'framed'（不透明，需要卡片底）| 'cutout'（透明，人物直接浮起）。
 * 由宿主统一传入（单一来源见 lib/state.js 的 ASSET_MODE），helper 不自己猜。
 *
 * 默认 'cutout'：现在包里的素材已经是 6 段带 alpha 的透明 WebM；
 * 只有显式传 DSH_COOK_PET_ASSET_MODE=framed 时才走旧的卡片底分支。
 */
const ASSET_MODE = process.env.DSH_COOK_PET_ASSET_MODE === 'framed' ? 'framed' : 'cutout';

/**
 * 内容区宽高比。**初始值只是占位**，真实值由渲染端在 loadedmetadata 时上报
 * （pet:aspect）后再调整窗口 —— 这样素材换成任何比例都不用改代码。
 *
 * 透明素材的裁切框是"6 个动作的并集"，整体接近 1:1，所以 cutout 模式先按 1:1 占位；
 * framed 旧素材是 16:9 整幅画面。占位只影响窗口出现后的头几帧，元数据一到就被实测值替换。
 *
 * 为什么必须自适应（这里踩过坑）：我最初把窗口写死成竖版 1:2.4，
 * 理由是"人物是竖版的"；但不透明素材是 16:9 横版，竖窗把画面按高度放大后
 * **只露出中间一条**，人物两侧全被切掉。窗口比例必须跟着素材走。
 */
let contentAspect = ASSET_MODE === 'cutout' ? 1 : 16 / 9;

/** 由内容高度与当前宽高比算出内容区尺寸 */
function contentSize() {
  return {
    w: Math.max(40, Math.round(PET_H * contentAspect)),
    h: PET_H,
  };
}

/** 由内容尺寸算出窗口尺寸（含四周余量） */
function windowSize() {
  const c = contentSize();
  const m = Math.round(PET_H * MARGIN_RATIO);
  return { w: c.w + m * 2, h: c.h + m * 2, margin: m };
}

const STATE_URL = process.env.DSH_COOK_PET_STATE_URL || '';

/**
 * 仅端到端验证脚本使用的截图目录（见 scripts/verify-desktop.mjs）。
 * 正常运行为空字符串，**不产生任何额外代码路径**（下面的截图逻辑整体跳过）。
 */
const CAPTURE_DIR = process.env.DSH_COOK_PET_CAPTURE_DIR || '';

// ---------------------------------------------------------------------------
// 位置持久化
// ---------------------------------------------------------------------------

function posFile() {
  return path.join(app.getPath('userData'), 'position.json');
}

/** 读上次的**比例位置**（rx/ry ∈ [0,1]）和尺寸。
 *  存比例而非绝对像素，换分辨率/多屏也不会跑丢；尺寸则直接存像素高度。 */
function readSavedPos() {
  try {
    const raw = JSON.parse(readFileSync(posFile(), 'utf8'));
    if (Number.isFinite(raw?.rx) && Number.isFinite(raw?.ry)) return raw;
  } catch {
    /* 首次运行 / 文件损坏：用默认位置 */
  }
  return null;
}

function saveSavedPos(rx, ry, h) {
  try {
    mkdirSync(path.dirname(posFile()), { recursive: true });
    // h 单独存当前宠物高度（右键改过的大小要能跨重启记住）
    writeFileSync(posFile(), JSON.stringify({ rx, ry, h: h ?? PET_H }), 'utf8');
  } catch {
    /* 存不了就算了，不打断交互 */
  }
}

// ---------------------------------------------------------------------------
// 状态镜像（Electron 没有 isIgnoringMouseEvents 取值 API，只能自己镜像）
// ---------------------------------------------------------------------------

let win = null;
const windowIgnore = new Map(); // win.id -> boolean
const inputBusy = new Map(); // win.id -> boolean
const offBodyMs = new Map(); // win.id -> number
const bodyRects = new Map(); // win.id -> {l,t,r,b}

/** 所有 setIgnoreMouseEvents 的唯一出口：状态与镜像永远一起更新，避免两条通道竞态 */
function setWindowIgnore(w, ignore) {
  if (!w || w.isDestroyed()) return;
  w.setIgnoreMouseEvents(ignore, { forward: true });
  windowIgnore.set(w.id, ignore);
}

// ---------------------------------------------------------------------------
// 建窗
// ---------------------------------------------------------------------------

function createPetWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = readSavedPos();
  // 恢复上次右键改过的尺寸（环境变量只决定"初始默认值"，用户的选择优先）
  if (Number.isFinite(saved?.h) && saved.h >= 60 && saved.h <= 400) PET_H = Math.round(saved.h);
  const size = windowSize();
  const x = saved
    ? Math.round(area.x + saved.rx * Math.max(0, area.width - size.w))
    : Math.round(area.x + area.width - size.w - 40);
  const y = saved
    ? Math.round(area.y + saved.ry * Math.max(0, area.height - size.h))
    : Math.round(area.y + area.height - size.h - 40);

  win = new BrowserWindow({
    width: size.w,
    height: size.h,
    x,
    y,
    show: false,
    useContentSize: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 只有点击回应与拖拽，不需要输入框 → 不抢焦点。
    // 但 focusable:false 会让 window.blur 不触发（拖拽兜底少一条），故保留可聚焦 + showInactive()
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // ① 提升到最高常规层级：screen-saver 高于普通置顶窗，能盖住多数浮层
  win.setAlwaysOnTop(true, 'screen-saver');
  // ② 跟随虚拟桌面切换（不加的话切个桌面桌宠就"消失"了）
  if (typeof win.setVisibleOnAllWorkspaces === 'function') {
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* 部分平台不支持，忽略 */
    }
  }
  // ③ 被遮挡时继续渲染（本需求单宠物用不太上，但代价极小、可避免"被自己遮挡即暂停"的怪象）
  win.webContents.setBackgroundThrottling(false);
  // ④ 屏蔽 Electron 默认右键菜单
  win.webContents.on('context-menu', (e) => e.preventDefault());

  // ⑤ 初始整窗穿透
  setWindowIgnore(win, true);

  // ⑥ 就绪后显示但**不抢焦点**
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  // 素材缺失要让宿主日志看得见 —— 否则表现为"窗口有了但一片空白"，毫无线索
  if (!existsSync(ASSET_DIR)) {
    process.stderr.write(`[dsh-cook-pet helper] 警告：素材目录不存在 ${ASSET_DIR}\n`);
  } else {
    const missing = ['idle.webm', 'cook.webm', 'serve.webm', 'think.webm', 'wink.webm', 'spin.webm'].filter(
      (f) => !existsSync(path.join(ASSET_DIR, f)),
    );
    if (missing.length) process.stderr.write(`[dsh-cook-pet helper] 警告：缺少素材 ${missing.join(', ')}\n`);
  }
  // 渲染端的资源加载失败（file:// 下 404）默认是静默的，这里显式报出来
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    process.stderr.write(`[dsh-cook-pet helper] 资源加载失败 ${url}（${code} ${desc}）\n`);
  });

  win.loadFile(path.join(__dirname, 'index.html')).catch((error) => {
    process.stderr.write(`[dsh-cook-pet helper] 页面加载失败：${error?.message ?? error}\n`);
    if (win && !win.isDestroyed()) win.destroy();
    process.exit(4);
  });

  win.on('closed', () => {
    windowIgnore.delete(win?.id);
    inputBusy.delete(win?.id);
    offBodyMs.delete(win?.id);
    bodyRects.delete(win?.id);
    win = null;
  });

  // 拖拽结束时把最终位置落盘（节流：拖动过程中不动磁盘）
  return win;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.on('pet:get-config', (event) => {
  event.returnValue = {
    // 绝对 file:// URL（见 ASSET_BASE_URL 的说明），渲染端直接拼文件名即可
    assetBase: ASSET_BASE_URL,
    stateUrl: STATE_URL,
    pollMs: 1000,
    petHeight: PET_H,
    // 窗口四周的拖拽余量（px）。画面区（#stage）内缩这个值，余量保持**真正透明** ——
    // 它只给拖拽留缓冲，不属于宠物画面；透明抠图下更不该在余量区画任何东西（旧版会在这里铺卡片底）。
    margin: windowSize().margin,
    assetMode: ASSET_MODE,
  };
});

ipcMain.on('pet:bounds', (event, pos) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w || w.isDestroyed()) return;
  if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return;
  const b = w.getContentBounds();
  if (b.x === pos.x && b.y === pos.y) return; // 去重：没变就不动窗口
  w.setContentBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height }, false);
  lastDragPos.set(w.id, { x: pos.x, y: pos.y });
});

/** 渲染端拖拽结束（busy=false）时落盘位置 */
const lastDragPos = new Map();

ipcMain.on('pet:body-rect', (event, rect) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w || w.isDestroyed()) return;
  bodyRects.set(w.id, rect);
});

/**
 * 渲染端上报素材的真实宽高比 → 调整窗口尺寸。
 *
 * 为什么要这一步：素材的宽高比是运行时才知道的（抠图前后差别很大：
 * 不透明素材是 16:9 整幅画面，抠好的透明素材可能是紧致竖版）。
 * 写死任何一个值都会在另一种素材下切掉人物，所以窗口比例由素材决定。
 */
ipcMain.on('pet:aspect', (event, aspect) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w || w.isDestroyed()) return;
  const a = Number(aspect);
  if (!Number.isFinite(a) || a <= 0.1 || a > 10) return; // 明显异常的值直接忽略
  if (Math.abs(a - contentAspect) < 0.01) return; // 没变就不动窗口（避免抖动）

  contentAspect = a;
  const size = windowSize();
  const b = w.getContentBounds();
  // 保持"右下角锚点"不变：窗口变宽/变高时向左上方向生长，视觉上宠物不会跳
  const nextX = b.x + b.width - size.w;
  const nextY = b.y + b.height - size.h;
  w.setContentBounds({ x: nextX, y: nextY, width: size.w, height: size.h }, false);

  const area = screen.getPrimaryDisplay().workArea;
  const clamped = clampToWorkArea(nextX, nextY, size.w, size.h, area);
  if (clamped.x !== nextX || clamped.y !== nextY) {
    w.setContentBounds({ x: clamped.x, y: clamped.y, width: size.w, height: size.h }, false);
  }
  process.stderr.write(
    `[dsh-cook-pet helper] 素材宽高比 ${a.toFixed(3)} → 窗口 ${size.w}x${size.h}\n`,
  );
});

/** 把窗口夹进工作区（不越过任务栏/屏幕边缘） */
function clampToWorkArea(x, y, w, h, area) {
  return {
    x: Math.min(Math.max(area.x, x), Math.max(area.x, area.x + area.width - w)),
    y: Math.min(Math.max(area.y, y), Math.max(area.y, area.y + area.height - h)),
  };
}

/**
 * 右键切换大小（110 → 138 → 190 → 260 → 110）。
 *
 * 为什么在这儿做：本插件只有桌面置顶窗一个界面，所以"改大小"必须由主进程改窗口尺寸，
 * 不能像网页那样只改 CSS。锚点取**右下角**：宠物是"站"在画面里的，
 * 放大时向左上生长，视觉上她不会跳位置。
 */
ipcMain.on('pet:cycle-size', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w || w.isDestroyed()) return;

  const before = w.getContentBounds();
  PET_H = nextSize(PET_H);
  const size = windowSize();

  // 右下角锚定：新窗口的右下角 = 旧窗口的右下角
  const wantX = before.x + before.width - size.w;
  const wantY = before.y + before.height - size.h;
  const area = screen.getDisplayMatching(before).workArea;
  const at = clampToWorkArea(wantX, wantY, size.w, size.h, area);
  w.setContentBounds({ x: at.x, y: at.y, width: size.w, height: size.h }, false);

  // 落盘：位置比例 + 新尺寸，重启后保持
  const rx = area.width > size.w ? (at.x - area.x) / (area.width - size.w) : 0;
  const ry = area.height > size.h ? (at.y - area.y) / (area.height - size.h) : 0;
  saveSavedPos(Math.min(1, Math.max(0, rx)), Math.min(1, Math.max(0, ry)), PET_H);

  // 余量是按比例算的，尺寸一变 MARGIN 也变 → 必须告诉渲染端重新内缩 #stage，
  // 否则命中框会与实际人物错位（表现为"看得到她但点不到"）。
  w.webContents.send('pet:size-changed', { petHeight: PET_H, margin: size.margin });
  process.stderr.write(`[dsh-cook-pet helper] 切换尺寸 → ${PET_H}px（窗口 ${size.w}x${size.h}）\n`);
});

ipcMain.on('pet:input-busy', (event, busy) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w || w.isDestroyed()) return;
  const was = inputBusy.get(w.id) === true;
  inputBusy.set(w.id, !!busy);
  // 拖拽结束：把最终位置写成比例，供下次启动恢复
  if (was && !busy) {
    const b = w.getContentBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const size = windowSize();
    const rx = area.width > size.w ? (b.x - area.x) / (area.width - size.w) : 0;
    const ry = area.height > size.h ? (b.y - area.y) / (area.height - size.h) : 0;
    saveSavedPos(Math.min(1, Math.max(0, rx)), Math.min(1, Math.max(0, ry)), PET_H);
  }
  // 只存标记，不直接翻转窗口：唯一出口仍是 setWindowIgnore（在轮询里按完整规则判定），
  // 否则会出现"两条通道抢着翻同一个窗口"的竞态
});
// ---------------------------------------------------------------------------
// 通道 B：主进程兜底轮询（Windows 上的救命通道）
// ---------------------------------------------------------------------------

let pointerTimer = null;
function startPointerPolling() {
  pointerTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getContentBounds();
    if (b.width < 8 || b.height < 8) return; // 尺寸尚未落定

    const ignoring = windowIgnore.get(win.id) !== false; // 读镜像，不用本地副本
    const busy = inputBusy.get(win.id) === true;
    const point = screen.getCursorScreenPoint();
    const rect = bodyRects.get(win.id) ?? null;

    // 余量区停留计时（只有"非 busy 且在窗口内但不在宠物身上"才累加）
    const inWindow =
      point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
    let off = offBodyMs.get(win.id) ?? 0;
    if (!busy && inWindow) off += POINTER_POLL_MS;
    else off = 0;
    offBodyMs.set(win.id, off);

    const next = decideWindowIgnore(b, point, ignoring, busy, off, rect);
    if (next !== ignoring) setWindowIgnore(win, next);
  }, POINTER_POLL_MS);
}

// ---------------------------------------------------------------------------
// 置顶看门狗
// ---------------------------------------------------------------------------

let watchdogTick = 0;
let watchdogTimer = null;
function startTopmostWatchdog() {
  watchdogTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    watchdogTick += 1;
    if (!shouldReassertTopmost(watchdogTick)) return;
    // Windows 上切换穿透会把 WS_EX_TOPMOST 位写回，导致"查询为 true 但已沉底"。
    // 定期重新钉一次，且必须带 'screen-saver' 层级（moveTop() 无效）。
    win.setAlwaysOnTop(true, 'screen-saver');
  }, TOPMOST_WATCHDOG_TICK_MS);
}

// ---------------------------------------------------------------------------
// 端到端验证：按状态截图（只有 DSH_COOK_PET_CAPTURE_DIR 存在时才启用）
// ---------------------------------------------------------------------------

/**
 * 截图模式要覆盖的 4 个宿主状态（think 是"等你回话"的持续状态）。
 * 只复用既有的 /state 契约，不额外引入 IPC。
 */
const CAPTURE_STATES = ['idle', 'cook', 'serve', 'think'];
/**
 * 检测到新状态后等多久再截：渲染端自己 1s 轮询一次 /state，加上双视频 180ms 的
 * cross-fade，最坏相位是"状态刚变、渲染端要等近 1s 才收到、再花 180ms 淡入"。
 * 900ms 会正好截在淡化中间（整只人半透明，实测踩到过）；1600ms 能稳稳越过这个相位。
 */
const CAPTURE_SETTLE_MS = 1600;
/** 整体超时：验证脚本默认每个状态停 5s，4 个状态一轮 20s，60s 足够跑完并重试 */
const CAPTURE_DEADLINE_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从宿主 /state 读当前状态（仅验证模式使用；正常运行由渲染端自己轮询） */
async function fetchHostState() {
  if (!STATE_URL) return '';
  try {
    const res = await fetch(STATE_URL, { cache: 'no-store' });
    if (!res.ok) return '';
    const data = await res.json();
    return String(data?.state ?? '');
  } catch {
    return '';
  }
}

/**
 * 截图循环：等渲染端真的切到某个状态、淡入完成后再 capturePage，每个状态存一张 PNG。
 *
 * 为什么由主进程读 /state 而不是让渲染端上报：渲染端已有双视频淡入的时序，
 * 再加一条 IPC 等于在正常路径上多一个分支；主进程读同一个 /state 更简单，
 * 且截图逻辑整体包在 CAPTURE_DIR 条件里，不影响正常运行。
 */
async function runCapture() {
  try {
    mkdirSync(CAPTURE_DIR, { recursive: true });
  } catch (error) {
    process.stderr.write(`[dsh-cook-pet helper] 截图目录创建失败：${error?.message ?? error}\n`);
    return;
  }
  process.stderr.write(`[dsh-cook-pet helper] 截图模式，输出目录 ${CAPTURE_DIR}\n`);
  const captured = new Set();
  const deadline = Date.now() + CAPTURE_DEADLINE_MS;
  while (Date.now() < deadline && captured.size < CAPTURE_STATES.length) {
    if (!win || win.isDestroyed()) return;
    const state = await fetchHostState();
    // 不在目标集合 / 已经截过 / 还没切到新状态：下一拍再看（轮换由验证脚本负责）
    if (!CAPTURE_STATES.includes(state) || captured.has(state)) {
      await sleep(250);
      continue;
    }
    await sleep(CAPTURE_SETTLE_MS);
    if (!win || win.isDestroyed()) return;
    try {
      const image = await win.webContents.capturePage();
      // 截图要花几十毫秒，期间状态可能刚好轮换：先确认它还是我们要的那个状态，
      // 否则 "cook.png" 里装着的可能是下一状态的过渡帧（验证脚本没法分辨）。
      if ((await fetchHostState()) !== state) {
        process.stderr.write(`[dsh-cook-pet helper] 状态已切走，丢弃 ${state} 的截图，稍后重试\n`);
        await sleep(250);
        continue;
      }
      const file = path.join(CAPTURE_DIR, state + '.png');
      writeFileSync(file, image.toPNG());
      captured.add(state);
      process.stderr.write(`[dsh-cook-pet helper] 已截图 ${state} → ${file}\n`);
    } catch (error) {
      // 截图偶发失败（窗口正在重绘等）不值得中断，下一拍照常重试
      process.stderr.write(`[dsh-cook-pet helper] 截图失败（${state}）：${error?.message ?? error}\n`);
      await sleep(250);
    }
  }
  process.stderr.write(`[dsh-cook-pet helper] 截图结束：${[...captured].join(', ') || '(无)'}\n`);
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

app.on('window-all-closed', () => {
  app.quit();
});

app.whenReady().then(() => {
  // 诊断日志：桌面窗出问题时，这里是唯一的线索来源（stderr 会被宿主转发到控制台）
  const size = windowSize();
  process.stderr.write(
    `[dsh-cook-pet helper] ready；窗口 ${size.w}x${size.h}` +
      `（内容 ${size.w - size.margin * 2}x${size.h - size.margin * 2}，余量 ${size.margin}，模式 ${ASSET_MODE}）\n`,
  );
  createPetWindow();
  startPointerPolling();
  startTopmostWatchdog();
  // 仅验证模式：窗口 ready-to-show 之后再开始等状态，避免第一张截到空白窗
  if (CAPTURE_DIR) {
    setTimeout(() => {
      runCapture().catch((error) => {
        process.stderr.write(`[dsh-cook-pet helper] 截图循环异常：${error?.stack ?? error}\n`);
      });
    }, 1200);
  }
});

app.on('before-quit', () => {
  if (pointerTimer) clearInterval(pointerTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  process.stderr.write('[dsh-cook-pet helper] quitting\n');
});

// 任何未捕获异常都要看得见 —— 否则 Electron 会静默退出，表现为"桌宠没出现"却毫无线索
process.on('uncaughtException', (e) => {
  process.stderr.write(`[dsh-cook-pet helper] uncaughtException: ${e?.stack ?? e}\n`);
  process.exit(5);
});
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[dsh-cook-pet helper] unhandledRejection: ${e?.stack ?? e}\n`);
});

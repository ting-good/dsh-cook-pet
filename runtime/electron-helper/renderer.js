'use strict';
/**
 * 桌面 helper 的渲染端（经典 script，非 ESM —— file:// 下 ESM 会被 CORS 拦）
 *
 * 这是照照**唯一的界面**：没有浏览器内嵌版本，桌宠只以这个置顶窗存在。
 *
 * 职责：
 *   1. 双 <video> 播放 6 个动作，按宿主状态 + 点击回应切换
 *   2. 命中判定：鼠标是否在宠物身上 → 上报主进程翻转穿透
 *   3. 拖拽：逐帧上报窗口位置（用 screenX/screenY 增量，不用 clientX）
 *   4. 点击：随机播 wink / spin，播完回当前状态
 *   5. 右键：请求主进程切换大小档位
 *   6. 上报身体命中框（供主进程判定穿透）与素材宽高比（供主进程调整窗口）
 *
 * 素材：assets/pet 下 6 段带 alpha 的透明 VP9 WebM（idle / cook / serve / think / wink / spin），
 * 6 段共用同一裁切框，所以宽高完全相同。窗口比例由素材决定，渲染端按 contain 铺满画面区。
 *
 * 与网页实现的关键差别：这里移动/缩放的是**整个窗口**（petBridge.setBounds /
 * petBridge.cycleSize），而不是 DOM 元素 —— 所以拖拽必须用屏幕坐标增量。
 */

(function () {
  var br = window.petBridge;

  // ---- 配置（主进程经 sendSync 给一次性配置） ----
  var cfg = (br && br.getConfig && br.getConfig()) || {};
  var ASSET_BASE = cfg.assetBase || '';
// 素材版本号：换素材时 +1，让 file:// 不走旧缓存（桌面窗启动时才把素材读进内存，改完要重启）
var ASSET_VERSION = '9';
  var STATE_URL = cfg.stateUrl || '';
  var POLL_MS = cfg.pollMs || 1000;
  var PET_H = cfg.petHeight || 138; // 人物目标高度（默认同 lib/state.js 的 DEFAULT_PET_HEIGHT）
  /** 窗口四周的透明余量（px）：画面区 #stage 内缩这么多，余量保持透明 */
  var MARGIN = cfg.margin || 0;

  // ---------------------------------------------------------------------------
  // 命中框比例（只在 currentBodyRect 里用，必须是"人物"而不是"整幅素材"的范围）
  // ---------------------------------------------------------------------------

  /**
   * 人物在**透明裁切框**里的位置与占比 —— 实测值，不是旧版"16:9 画面里人物占 65% 宽 / 97% 高"的经验值。
   *
   * 新素材的裁切框是 **6 个动作的并集**：wink 抬手、spin 跳起都会把框撑大，
   * 所以框里除人物外还有一圈透明留白，而且**不是顶边/居中对称**。命中框必须只盖人物：
   * 透明像素若吃掉鼠标，等于在桌面上放了一块看不见的挡板，整个"抠图浮起"就白做了。
   *
   * 实测依据（2026-10，素材同事逐帧扫描）：
   *   idle 人物 bbox 在原图 (428,19)–(857,702)；6 段 alpha 并集裁切框原图 x∈[280,1003]、y∈[0,720]
   *   （723×720，输出 514×512）。按裁切框归一化：
   *     left  =(428-280)/723 ≈ 0.205   top   = 19/720   ≈ 0.026
   *     width = (857-428)/723 ≈ 0.595  height= (702-19)/720 ≈ 0.950
   *   左 + 宽 = 0.7994，右侧余 ~0.20 —— 水平基本对称；垂直几乎贴底（0.976）。
   *
   * 命中框 = 绘制区域里按 (left, top, width, height) 内缩出的矩形，**不是"以画面中心内缩"**。
   * 不再额外加外扩容差：宁可人物透明边缘差几个像素点不到，也不要用透明像素挡住下层应用点击
   * （这正是透明窗存在的意义；点不到还能拖，挡住了下面就没法用）。
   *
   * 6 段素材共用同一个裁切框，因此同一组比例对全部动作成立。
   * ⚠️ 素材重新导出后必须按 manifest 重新实测、只改这四个数字，不要在别处再写一份比例。
   */
  var PERSON_LEFT_RATIO = 0.205;
  var PERSON_TOP_RATIO = 0.026;
  var PERSON_W_RATIO = 0.595;
  var PERSON_H_RATIO = 0.95;

  var ASSETS = {
    idle: 'idle.webm',
    cook: 'cook.webm',
    serve: 'serve.webm',
    think: 'think.webm',
    wink: 'wink.webm',
    spin: 'spin.webm',
  };
  /** 宿主状态集合：think 是"等你回话"的持续状态，不是点击插播 */
  var STATES = ['idle', 'cook', 'serve', 'think'];
  var CLICK_ACTIONS = ['wink', 'spin'];
  var CLICK_FALLBACK_MS = 6000;
  var DRAG_THRESHOLD = 5;

  var videoA = document.getElementById('vA');
  var videoB = document.getElementById('vB');
  var hit = document.getElementById('hit');
  var badge = document.getElementById('badge');

  // 把余量交给 CSS：#stage 内缩 MARGIN，四周留出真正透明的拖拽余量
  // （透明抠图下余量区不能画任何东西，否则就是一圈看得见的白边）
  document.documentElement.style.setProperty('--pet-margin', MARGIN + 'px');

  // ---- 状态 ----
  var state = 'idle'; // 宿主状态
  var clip = 'idle'; // 当前播放的动作
  var once = false; // true = 播一遍（点击回应）
  var frontIsA = true;
  var busy = false;
  var interactive = null; // 上报给主进程的穿透状态镜像（去重用）
  var dragging = false;
  var justDragged = false;
  var drag = null;
  var clickTimer = null;
  var replyEl = null; // 当前点击回应真正在播的元素（ended 只认它）
  var lastBodyRect = '';

  // ---- 视频切换（双缓冲，避免黑帧） ----
  function front() {
    return frontIsA ? videoA : videoB;
  }
  function back() {
    return frontIsA ? videoB : videoA;
  }

  /**
   * 装载并播放一个动作。
   * @returns {HTMLVideoElement} 真正在播的那个元素（调用方可以挂 ended）
   */
  function playClip(name, playOnce) {
    var f = front();
    if (f.dataset.clip === name && !playOnce) return f; // 已在播同一循环动作：不打断
    var b = back();
    b.dataset.clip = name;
    b.loop = !playOnce;
    b.src = ASSET_BASE + ASSETS[name] + '?v=' + ASSET_VERSION;
    try {
      b.load();
    } catch (e) {
      /* 某些实现下赋值 src 即可，忽略 */
    }
    var p = b.play();
    if (p && p.catch) p.catch(function () {});
    var promoted = false;
    function promote() {
      if (promoted) return;
      promoted = true;
      b.classList.add('is-front');
      f.classList.remove('is-front');
      frontIsA = !frontIsA;
    }
    b.addEventListener('canplay', promote, { once: true });
    b.addEventListener('playing', promote, { once: true });
    return b;
  }

  /** 播完回当前状态（点击回应用） */
  function returnToState() {
    once = false;
    replyEl = null;
    clip = state;
    playClip(state, false);
    renderBadge();
  }

  function playClickReply() {
    var pick = CLICK_ACTIONS[Math.floor(Math.random() * CLICK_ACTIONS.length)];
    once = true;
    clip = pick;
    var target = playClip(pick, true);
    replyEl = target;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(returnToState, CLICK_FALLBACK_MS);
    // 前台视频真的播完就立刻回去（ended 比定时器准）。
    // 只认本次点击的那个元素：连着点两下时，上一次的 ended 不能把这一次提前掐掉。
    target.addEventListener(
      'ended',
      function () {
        if (!once || replyEl !== target) return;
        returnToState();
      },
      { once: true },
    );
    // 点击回应不显示任何文字：只播动作，不弹角标/气泡。
  }

  // ---- 角标 ----
  /**
   * 宿主状态 → 角标文案。
   * **只有 think（托腮）显示「等你回话」**，其余状态一律无文字。
   * 桌宠平时不该有字挡画面，只有"轮到你了"值得出现一行提示。
   */
  function badgeText(s) {
    if (s === 'think') return '等你回话';
    return '';
  }

  function renderBadge() {
    if (!badge) return;
    var text = badgeText(state);
    badge.textContent = text;
    badge.classList.toggle('is-on', !!text);
  }

  // ---- 宿主状态轮询 ----
  function poll() {
    if (!STATE_URL) return;
    fetch(STATE_URL, { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (!data || typeof data.state !== 'string') return;
        if (STATES.indexOf(data.state) === -1) return; // 未知状态忽略，别把画面切成空白
        state = data.state;
        if (!once) {
          clip = state;
          playClip(state, false);
        }
        renderBadge();
      })
      .catch(function () {});
  }
  setInterval(poll, POLL_MS);
  poll();

  // ---- 身体命中框上报 ----
  /**
   * 计算宠物**实际可见身体**的矩形（相对窗口内容区）。
   *
   * 窗口宽高比由主进程按素材比例设定，视频 object-fit:contain 后基本正好填满画面区；
   * 这里仍按 contain 的算法算一遍，保证首帧（窗口还没调到位）也不会算错。
   *
   * 命中框 = 画面里的**人物范围**（PERSON_W/H_RATIO），而不是整幅素材画布：
   * 透明裁切框是 6 个动作的并集，框里还留着一圈透明区域，不能让它吃掉下层应用的点击。
   */
  function currentBodyRect() {
    var W = window.innerWidth;
    var H = window.innerHeight;
    var v = front();
    if (!v || v.videoWidth === 0) {
      // 视频元数据还没到：退回画面区（不是整个窗口，余量不算命中），宁可暂时可交互也不要点不动
      return { l: MARGIN, t: MARGIN, r: W - MARGIN, b: H - MARGIN };
    }

    // 画面区 = 窗口去掉四周余量后的区域；视频在画面区里 contain
    var areaW = Math.max(1, W - MARGIN * 2);
    var areaH = Math.max(1, H - MARGIN * 2);
    var scale = Math.min(areaW / v.videoWidth, areaH / v.videoHeight);
    var drawW = v.videoWidth * scale;
    var drawH = v.videoHeight * scale;
    var ox = MARGIN + (areaW - drawW) / 2;
    var oy = MARGIN + (areaH - drawH) / 2;

    // 命中框 = 绘制区域按 (left, top, width, height) 内缩（实测 bbox），不做居中假设。
    // 若素材实测给出别的偏移，只改上面的四个常量，不要另写一套几何。
    var personLeft = ox + drawW * PERSON_LEFT_RATIO;
    var personTop = oy + drawH * PERSON_TOP_RATIO;
    var personW = drawW * PERSON_W_RATIO;
    var personH = drawH * PERSON_H_RATIO;
    return {
      l: Math.max(0, Math.round(personLeft)),
      t: Math.max(0, Math.round(personTop)),
      r: Math.min(W, Math.round(personLeft + personW)),
      b: Math.min(H, Math.round(personTop + personH)),
    };
  }

  function reportBodyRect() {
    var rect = currentBodyRect();
    var key = rect.l + ',' + rect.t + ',' + rect.r + ',' + rect.b;
    if (key === lastBodyRect) return; // 去重：几何没变就不发 IPC
    lastBodyRect = key;
    if (br) br.setBodyRect(rect);
  }

  /** 上报素材真实宽高比，让主进程把窗口调成同样的比例 */
  function reportAspect() {
    var v = front();
    if (!v || v.videoWidth === 0 || v.videoHeight === 0) return;
    if (br && br.setAspect) br.setAspect(v.videoWidth / v.videoHeight);
  }

  function onVideoMeta() {
    reportAspect();
    reportBodyRect();
  }

  window.addEventListener('resize', reportBodyRect);
  videoA.addEventListener('loadedmetadata', onVideoMeta);
  videoB.addEventListener('loadedmetadata', onVideoMeta);
  // 视频加载失败要报出来：file:// 下 404 默认是静默的，表现为"窗口一片空白、毫无线索"
  function onVideoError(e) {
    var el = e && e.target;
    console.error('[dsh-cook-pet] 素材加载失败：' + (el && el.src ? el.src : '(未知)'));
  }
  videoA.addEventListener('error', onVideoError);
  videoB.addEventListener('error', onVideoError);

  // ---- 命中判定（通道 A：正常路径） ----
  function setInteractive(flag) {
    var next = !!flag;
    if (next === interactive) return; // 去重：值没变不发 IPC
    interactive = next;
    // 主进程才是唯一出口；这里只上报事实，不直接改窗口
  }

  document.addEventListener('mousemove', function (e) {
    // 兜底：拖拽中但按键已全部松开 → 说明 pointerup/pointercancel/lostpointercapture 全丢了，
    // 就地收尾。少了这条，一次丢失的 pointerup 会让 busy 永久为 true（穿透永不恢复）。
    if (dragging && e.buttons === 0) {
      endDrag(e);
      return;
    }
    if (dragging) return;
    var r = currentBodyRect();
    var inBody = e.clientX >= r.l && e.clientX <= r.r && e.clientY >= r.t && e.clientY <= r.b;
    setInteractive(inBody);
  });

  // ---- 拖拽（通道 B 的 busy 上报是关键） ----
  function syncBusy() {
    var next = dragging;
    if (next === busy) return;
    busy = next;
    if (br) br.setInputBusy(busy);
  }

  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    hit.setPointerCapture && hit.setPointerCapture(e.pointerId);
    // 记录【按下时的指针屏幕坐标】；窗口位置由主进程维护，我们只发增量
    drag = {
      active: true,
      sx: e.screenX,
      sy: e.screenY,
      baseX: window.screenX,
      baseY: window.screenY,
    };
    dragging = false; // 还没超过阈值
    syncBusy();
    // 按下就立刻占住输入租约：拖拽成立前也要，避免起手就被判成"窗外"
    busy = true;
    if (br) br.setInputBusy(true);
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag || !drag.active) return;
    var dx = e.screenX - drag.sx;
    var dy = e.screenY - drag.sy;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
    // 1:1 跟手（不做弹簧：本需求没有抛掷物理，直接跟手体验更好）
    if (br) br.setBounds(drag.baseX + dx, drag.baseY + dy);
  });

  function endDrag(e) {
    if (!drag) return;
    var wasDragging = dragging;
    drag.active = false;
    dragging = false;
    drag = null;
    syncBusy();
    if (br) br.setInputBusy(false);
    if (wasDragging) {
      justDragged = true;
      // 拖完浏览器还会派发一次 click，不屏蔽就会"拖一下就触发点击回应"
      setTimeout(function () {
        justDragged = false;
      }, 100);
    }
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', function () {
    endDrag();
  });

  document.addEventListener('click', function () {
    if (justDragged) return;
    playClickReply();
  });
  // Electron 会弹默认右键菜单，这里一律屏蔽；右键在桌宠上的语义是「切换大小」。
  // 真正的窗口缩放与持久化都在主进程（见 main.js 的 pet:cycle-size）——
  // 渲染端只发一个请求，不自己改尺寸，避免两边各算一套。
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (justDragged) return;
    if (br && br.cycleSize) br.cycleSize();
  });

  // 主进程改完窗口尺寸后推一次：余量是按比例算的，尺寸变了 MARGIN 也变，
  // 必须同步给 CSS 与命中框，否则会出现"看得见她但点不到"。
  if (br && br.onSizeChanged) {
    br.onSizeChanged(function (info) {
      if (!info || !(info.margin >= 0)) return;
      MARGIN = info.margin;
      document.documentElement.style.setProperty('--pet-margin', MARGIN + 'px');
      reportBodyRect();
    });
  }

  // ---- 初始化 ----
  // 首帧直接在 A 上装好 idle 并播：不依赖 playClip 的异步翻台，窗口一出现就有画面。
  // （B 留给第一次动作切换用）
  videoA.src = ASSET_BASE + ASSETS.idle + '?v=' + ASSET_VERSION;
  videoA.dataset.clip = 'idle';
  var initialPlay = videoA.play();
  if (initialPlay && initialPlay.catch) initialPlay.catch(function () {});
  // 首帧就上报一次身体框，让主进程能立刻正确判定
  reportBodyRect();
})();

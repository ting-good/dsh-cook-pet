'use strict';
/**
 * 桌面 helper 的 preload 桥（contextBridge）
 *
 * 渲染端不直接拿 Node（`nodeIntegration: false`），所有与主进程的往来都收口在这里。
 * 只暴露四个方法，都是"上报事实"，不含业务判断：
 *
 *   setBounds({x,y})      逐帧上报宠物窗口应处的屏幕位置（拖拽时每帧一次）
 *   setBodyRect(rect)     上报宠物身体命中框（相对窗口内容区），供主进程判定穿透
 *   setInputBusy(bool)    上报"渲染端正在使用输入"（拖拽中），主进程据此**否决**位置判定
 *   getConfig()           取一次性配置（宠物大小、宿主路由前缀等）
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  /** 宠物窗口位置（屏幕坐标，DIP）。主进程会去重，重复值不产生额外开销。 */
  setBounds(x, y) {
    ipcRenderer.send('pet:bounds', { x: Math.round(x), y: Math.round(y) });
  },

  /**
   * 宠物身体命中框（相对窗口内容区）。主进程用它把屏幕光标坐标换算成"是否在宠物身上"，
   * 所以必须是**实际可见身体**的框，不能是整张素材画布。
   */
  setBodyRect(rect) {
    ipcRenderer.send('pet:body-rect', {
      l: Math.round(rect.l),
      t: Math.round(rect.t),
      r: Math.round(rect.r),
      b: Math.round(rect.b),
    });
  },

  /** 拖拽开始/结束时各报一次；主进程在 busy 期间绝不把窗口翻回穿透 */
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },

  /**
   * 上报素材真实宽高比 → 主进程据此调整窗口尺寸。
   * 素材比例是运行时才知道的（抠图前后差别很大），写死任何一个值都会在另一种素材下切掉人物。
   */
  setAspect(aspect) {
    ipcRenderer.send('pet:aspect', aspect);
  },

  /** 一次性配置（主进程经额外参数传入） */
  getConfig() {
    return ipcRenderer.sendSync('pet:get-config');
  },

  /** 右键：请求主进程切到下一档尺寸（窗口尺寸+持久化都由主进程处理） */
  cycleSize() {
    ipcRenderer.send('pet:cycle-size');
  },

  /**
   * 尺寸变更回调。主进程改完窗口后推一次 {petHeight, margin}，
   * 渲染端据此重算 #stage 内缩与命中框 —— 否则余量比例变了，命中框会和人物错位。
   */
  onSizeChanged(cb) {
    ipcRenderer.on('pet:size-changed', (_e, info) => cb(info));
  },

  /** 宿主状态轮询回调注册（渲染端主动拉，主进程不推） */
  onState(cb) {
    ipcRenderer.on('pet:state', (_e, state) => cb(state));
  },
});

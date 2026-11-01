// tests/mock-canvas.js — 最小 Canvas2D mock，用于在 Node 里驱动渲染器并统计调用。
// 不是像素级 mock：只保证渲染器用到的 API 存在且调用可计数/可断言。

function makeCtx(calls) {
  const noop = () => {};
  const ctx = {
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    globalAlpha: 1,
    setTransform: () => { calls.setTransform++; },
    save: () => { calls.save++; },
    restore: () => { calls.restore++; },
    clearRect: () => { calls.clearRect++; },
    fillRect: () => { calls.fillRect++; },
    strokeRect: () => { calls.strokeRect++; },
    beginPath: () => { calls.beginPath++; },
    closePath: () => { calls.closePath++; },
    moveTo: () => { calls.moveTo++; },
    lineTo: () => { calls.lineTo++; },
    arc: () => { calls.arc++; },
    rect: () => { calls.rect++; },
    fill: () => { calls.fill++; },
    stroke: () => { calls.stroke++; },
    fillText: (text) => { calls.fillText++; calls.texts.push(String(text)); },
    measureText: (text) => ({ width: String(text).length * 6 }),
    translate: noop,
    scale: noop,
    rotate: noop,
  };
  return ctx;
}

/**
 * 创建 mock canvas。
 * @returns canvas 对象，额外带：
 *  - calls: 各 ctx 方法调用次数
 *  - listeners: Map<event, Set<handler>>
 *  - dispatch(type, event): 手动派发事件
 */
export function createMockCanvas(width = 320, height = 240) {
  const calls = {
    setTransform: 0, save: 0, restore: 0, clearRect: 0, fillRect: 0, strokeRect: 0,
    beginPath: 0, closePath: 0, moveTo: 0, lineTo: 0, arc: 0, rect: 0,
    fill: 0, stroke: 0, fillText: 0, texts: [],
  };
  const ctx = makeCtx(calls);
  const listeners = new Map();
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    calls,
    listeners,
    getContext(type) {
      if (type !== '2d') throw new Error(`mock canvas 只支持 2d，收到 ${type}`);
      return ctx;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      const set = listeners.get(type);
      if (set) set.delete(handler);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: canvas.clientWidth, height: canvas.clientHeight };
    },
    dispatch(type, event = {}) {
      const set = listeners.get(type);
      if (!set) return 0;
      const ev = { preventDefault() {}, ...event };
      for (const handler of [...set]) handler(ev);
      return set.size;
    },
    listenerCount(type) {
      return (listeners.get(type) || new Set()).size;
    },
  };
  ctx.canvas = canvas;
  return canvas;
}

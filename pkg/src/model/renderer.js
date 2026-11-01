// renderer.js — 无依赖 Canvas2D 软件 3D 渲染器。
//
// 设计要点：
// * 纯函数层（可单独在 Node 里回归）：buildScene / computeMeshMetrics / makeRotation /
//   computeFit(fitView) / createCamera / project(projectPoint) / projectVertices /
//   collectVisibleTriangles / sortTriangles / shadeIntensity / buildPalette / buildDepthShadeBatches。
// * 只有 createModelView 会接触 canvas / addEventListener / requestAnimationFrame，
//   model 模块不依赖 React，也不在顶层读取任何 DOM 全局。
// * 不使用 WebGL：小模型按三角形 painter 排序后逐面填充；大模型（> batchThreshold）
//   改为按"深度切片 + 明暗层"批量构建 Path，避免逐三角形 setStyle 的开销；
//   超过 maxTriangles 时抽样 + 关闭线框 + 提示，保证不卡死。
import { boundsOf } from './common.js';

/** 默认配置。 */
export const DEFAULT_OPTIONS = {
  background: '#11161d',
  grid: true,
  gridColor: 'rgba(255,255,255,0.08)',
  modelColor: [150, 170, 200],
  wireframe: false,
  wireframeColor: 'rgba(255,255,255,0.22)',
  cull: true,                 // 背面剔除（默认按 CCW 逆时针为正面）
  lightDir: [0.45, 0.8, 0.5], // 视空间方向光
  ambient: 0.3,
  diffuse: 0.7,
  shadeLevels: 32,
  fitPadding: 0.8,            // 自动适配留白：focal = min(w,h)*fitPadding
  dist: 3,                    // 相机在归一化空间中的距离（半径为 1）
  initialRotX: -0.5,
  initialRotY: 0.65,
  orbitSpeed: 0.008,          // rad / px
  zoomSpeed: 0.0014,
  minZoom: 0.15,
  maxZoom: 12,
  batchThreshold: 20000,      // 可见三角形超过该值 → 批量化绘制
  batchSlices: 64,            // 批量化绘制时的深度切片数
  maxTriangles: 300000,       // 超过 → 降级（抽样 + 关线框 + 提示）
  pixelRatio: 0,              // 0 = 自动取 devicePixelRatio（上限 2）
  observeResize: true,
  onNotice: null,             // (message: string) => void，降级提示
  onFrame: null,              // (stats) => void，每帧绘制完回调（调试/统计用）
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 把 parseModel 结果或裸 positions 归一成渲染用的 scene。 */
export function buildScene(model) {
  const raw = model?.triangles?.positions ?? model?.positions ?? model;
  let positions;
  if (raw instanceof Float32Array) positions = raw;
  else if (Array.isArray(raw)) positions = Float32Array.from(raw);
  else if (ArrayBuffer.isView(raw)) positions = Float32Array.from(raw);
  else throw new TypeError('buildScene: model 需要 triangles.positions 或 positions（Float32Array/数组）');

  if (positions.length === 0) throw new Error('buildScene: 模型不含任何三角形');
  if (positions.length % 9 !== 0) {
    throw new Error(`buildScene: positions 长度 ${positions.length} 不是 9 的整数倍，无法按三角形渲染`);
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error('buildScene: 模型顶点坐标包含 NaN/Infinity');
  }
  const metrics = computeMeshMetrics(positions);
  return {
    positions,
    count: positions.length / 9,
    // 兼容 "scene.triangles" 形式的消费方
    triangles: { positions, count: positions.length / 9 },
    metrics,
    bounds: { min: metrics.min, max: metrics.max },
  };
}

/** 包围盒 + 计数 + 取景半径。 */
export function computeMeshMetrics(positions) {
  const b = boundsOf(positions);
  return {
    min: b.min,
    max: b.max,
    center: b.center,
    radius: b.radius,
    triangleCount: Math.floor(positions.length / 9),
    vertexCount: positions.length / 3,
  };
}

/** 旋转矩阵（行主序 3x3）：先绕 Y 偏航，再绕 X 俯仰；模型空间 → 视空间。 */
export function makeRotation(rotX, rotY) {
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const cy = Math.cos(rotY), sy = Math.sin(rotY);
  return new Float32Array([
    cy, 0, sy,
    sx * sy, cx, -sx * cy,
    -cx * sy, sx, cx * cy,
  ]);
}

/** 旋转单个点（纯函数）。 */
export function rotatePoint(m, x, y, z) {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

/**
 * 自动适配：把包围盒映射为固定半径 1 的归一化空间，返回投影所需参数。
 * 屏幕偏移 = focal * zoom * (归一化坐标) / (dist - 归一化 z)
 */
export function computeFit(metrics, width, height, options = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const padding = options.fitPadding ?? 0.8;
  const radius = Math.max(metrics.radius || 0, 1e-6);
  return {
    width: w,
    height: h,
    cx: w / 2,
    cy: h / 2,
    center: metrics.center.slice(),
    radius,
    scale: 1 / radius,
    dist: options.dist ?? 3,
    focal: Math.min(w, h) * padding,
    zoom: 1,
    padding,
  };
}

/** fitView 是 computeFit 的语义化别名（对外纯函数层）。 */
export const fitView = computeFit;

/** 由视图状态 + fit 生成相机对象。 */
export function createCamera(viewState = {}, fit) {
  const rotX = viewState.rotX ?? -0.5;
  const rotY = viewState.rotY ?? 0.65;
  return {
    ...fit,
    rotX,
    rotY,
    zoom: clamp(viewState.zoom ?? 1, 0.05, 50),
    panX: viewState.panX ?? 0,
    panY: viewState.panY ?? 0,
    m: makeRotation(rotX, rotY),
  };
}

/** 投影单个世界坐标点；落在相机后方时返回 null。 */
export function projectPoint(camera, x, y, z) {
  const c = camera.center, s = camera.scale, m = camera.m;
  const px = (x - c[0]) * s;
  const py = (y - c[1]) * s;
  const pz = (z - c[2]) * s;
  const vx = m[0] * px + m[1] * py + m[2] * pz;
  const vy = m[3] * px + m[4] * py + m[5] * pz;
  const vz = m[6] * px + m[7] * py + m[8] * pz;
  const depth = camera.dist - vz;
  if (!(depth > 1e-4)) return null;
  const k = (camera.focal * camera.zoom) / depth;
  return { x: camera.cx + vx * k + camera.panX, y: camera.cy - vy * k + camera.panY, depth };
}

/** project 是 projectPoint 的别名（对外纯函数层，方便静态提取）。 */
export const project = projectPoint;

/**
 * 批量把三角形汤的顶点投影到屏幕空间。
 * @returns {{sx:Float32Array,sy:Float32Array,depth:Float32Array,valid:Uint8Array,count:number}}
 */
export function projectVertices(positions, camera) {
  const n = Math.floor(positions.length / 3);
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const depth = new Float32Array(n);
  const valid = new Uint8Array(n);
  const [c0, c1, c2] = camera.center;
  const s = camera.scale;
  const m = camera.m;
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  const { dist, cx, cy, panX, panY } = camera;
  const fz = camera.focal * camera.zoom;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const px = (positions[o] - c0) * s;
    const py = (positions[o + 1] - c1) * s;
    const pz = (positions[o + 2] - c2) * s;
    const vx = m0 * px + m1 * py + m2 * pz;
    const vy = m3 * px + m4 * py + m5 * pz;
    const vz = m6 * px + m7 * py + m8 * pz;
    const d = dist - vz;
    if (d > 1e-4) {
      const k = fz / d;
      sx[i] = cx + vx * k + panX;
      sy[i] = cy - vy * k + panY;
      depth[i] = d;
      valid[i] = 1;
    }
  }
  return { sx, sy, depth, valid, count: n };
}

/**
 * 收集可见三角形：视锥粗剔除（任一点在相机后则丢弃）+ 背面剔除 + 平面光照。
 * @returns {{triIndex:Uint32Array, depths:Float32Array, shades:Uint8Array, count:number,
 *   culled:number, clipped:number, total:number}}
 */
export function collectVisibleTriangles(scene, camera, projected, options = {}) {
  const positions = scene.positions ?? scene;
  const total = Math.floor(positions.length / 9);
  const { sx, sy, depth, valid } = projected;
  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const cull = options.cull !== false;
  const shadeLevels = Math.max(1, Math.floor(options.shadeLevels ?? 32));
  const light = normalizeVec(options.lightDir ?? [0.45, 0.8, 0.5]);
  const ambient = options.ambient ?? 0.3;
  const diffuse = options.diffuse ?? 0.7;
  const m = camera.m;
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  const [c0, c1, c2] = camera.center;
  const scale = camera.scale;

  const maxOut = Math.ceil(total / stride);
  const triIndex = new Uint32Array(maxOut);
  const depths = new Float32Array(maxOut);
  const shades = new Uint8Array(maxOut);
  let n = 0;
  let culled = 0;
  let clipped = 0;

  for (let t = 0; t < total; t += stride) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    if (!valid[i0] || !valid[i1] || !valid[i2]) { clipped++; continue; }

    // 模型空间面法线（用归一化坐标，等比例缩放不改变方向）
    const o0 = i0 * 3, o1 = i1 * 3, o2 = i2 * 3;
    const ax = (positions[o0] - c0) * scale;
    const ay = (positions[o0 + 1] - c1) * scale;
    const az = (positions[o0 + 2] - c2) * scale;
    const e1x = (positions[o1] - c0) * scale - ax;
    const e1y = (positions[o1 + 1] - c1) * scale - ay;
    const e1z = (positions[o1 + 2] - c2) * scale - az;
    const e2x = (positions[o2] - c0) * scale - ax;
    const e2y = (positions[o2 + 1] - c1) * scale - ay;
    const e2z = (positions[o2 + 2] - c2) * scale - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    // 转到视空间
    let vnx = m0 * nx + m1 * ny + m2 * nz;
    let vny = m3 * nx + m4 * ny + m5 * nz;
    let vnz = m6 * nx + m7 * ny + m8 * nz;
    if (cull && vnz <= 0) { culled++; continue; }

    const len = Math.hypot(vnx, vny, vnz);
    let intensity = ambient;
    if (len > 1e-12) {
      const d = (vnx * light[0] + vny * light[1] + vnz * light[2]) / len;
      intensity = ambient + diffuse * (d > 0 ? d : 0);
    }
    const shade = clamp(Math.round(intensity * shadeLevels), 0, shadeLevels);

    triIndex[n] = t;
    depths[n] = (depth[i0] + depth[i1] + depth[i2]) / 3;
    shades[n] = shade;
    n++;
  }

  return { triIndex, depths, shades, count: n, culled, clipped, total };
}

/**
 * 画家算法排序：桶排序（O(n + buckets)），返回"远 → 近"的绘制顺序。
 * 不使用 Array#sort 的 O(n log n)，30 万三角形时耗时约几毫秒。
 */
export function sortTriangles(depths, count, buckets = 4096) {
  const order = new Uint32Array(count);
  if (count <= 0) return order;
  if (count === 1) { order[0] = 0; return order; }
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const d = depths[i];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const nb = Math.max(2, Math.min(buckets | 0, 1 << 20));
  if (!(max > min)) {
    for (let i = 0; i < count; i++) order[i] = i;
    return order;
  }
  const counts = new Int32Array(nb);
  const scale = (nb - 1) / (max - min);
  for (let i = 0; i < count; i++) {
    const b = nb - 1 - Math.floor((depths[i] - min) * scale); // depth 越大（越远）→ 桶号越小
    counts[b]++;
  }
  const starts = new Int32Array(nb);
  let acc = 0;
  for (let b = 0; b < nb; b++) { starts[b] = acc; acc += counts[b]; }
  for (let i = 0; i < count; i++) {
    const b = nb - 1 - Math.floor((depths[i] - min) * scale);
    order[starts[b]++] = i;
  }
  return order;
}

/** sortTrianglesByDepth 是 sortTriangles 的别名。 */
export const sortTrianglesByDepth = sortTriangles;

/** 平面光照强度：ambient + diffuse * max(0, n·L)，视空间法线需已单位化。 */
export function shadeIntensity(normal, lightDir = [0.45, 0.8, 0.5], ambient = 0.3, diffuse = 0.7) {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(len > 1e-12)) return ambient;
  const L = normalizeVec(lightDir);
  const d = (normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2]) / len;
  return clamp(ambient + diffuse * (d > 0 ? d : 0), 0, 1);
}

/** 由基色 + 明暗层数生成调色板（索引 0..levels）。 */
export function buildPalette(rgb = [150, 170, 200], levels = 32) {
  const out = new Array(levels + 1);
  for (let i = 0; i <= levels; i++) {
    const f = i / levels;
    const r = Math.round(rgb[0] * f);
    const g = Math.round(rgb[1] * f);
    const b = Math.round(rgb[2] * f);
    out[i] = `rgb(${r},${g},${b})`;
  }
  return out;
}

/**
 * 大批量绘制的分桶：按深度切片、再按明暗层聚合，返回远 → 近的有序批次。
 * 相比逐三角形 fill，可把 30 万次 fillStyle/fill 压缩到最多 slices×levels 次。
 * @returns {Array<{slice:number, shade:number, indices:Uint32Array}>}
 */
export function buildDepthShadeBatches(depths, shades, count, options = {}) {
  const slices = Math.max(2, Math.floor(options.slices ?? 64));
  const levels = Math.max(1, Math.floor(options.shadeLevels ?? 32));
  if (count <= 0) return [];
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const d = depths[i];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const map = new Map();
  const scale = max > min ? (slices - 1) / (max - min) : 0;
  for (let i = 0; i < count; i++) {
    const slice = max > min ? slices - 1 - Math.floor((depths[i] - min) * scale) : 0;
    const shade = clamp(shades[i], 0, levels);
    const key = slice * (levels + 1) + shade;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(i);
  }
  const batches = [];
  for (const [key, arr] of map) {
    const slice = Math.floor(key / (levels + 1));
    const shade = key % (levels + 1);
    batches.push({ slice, shade, indices: Uint32Array.from(arr) });
  }
  batches.sort((a, b) => a.slice - b.slice || a.shade - b.shade);
  return batches;
}

// ---------------------------------------------------------------------------
// 交互式视图（唯一接触 canvas / 事件 / rAF 的部分）
// ---------------------------------------------------------------------------

/**
 * 创建可交互的 Canvas2D 3D 模型视图。
 * @param {{canvas: HTMLCanvasElement, model: object, options?: object}} params
 * @returns {{
 *   setModel(model:object):void, setOptions(partial:object):void,
 *   setWireframe(enabled:boolean):void, resetView():void,
 *   requestRender():void, renderNow():void, resize():void,
 *   getState():object, getInfo():object, destroy():void
 * }}
 */
export function createModelView({ canvas, model, options = {} } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createModelView: 需要提供 canvas');
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('createModelView: 无法获取 canvas 2d 上下文');

  const opts = Object.assign({}, DEFAULT_OPTIONS, options);
  const viewState = {
    rotX: clamp(opts.initialRotX, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001),
    rotY: opts.initialRotY,
    zoom: 1,
    panX: 0,
    panY: 0,
  };

  let scene = buildScene(model);
  let palette = buildPalette(opts.modelColor, opts.shadeLevels);
  let notice = '';
  let lastNoticeSent = '';
  let frames = 0;
  let disposed = false;
  let framePending = false;
  let rafHandle = 0;
  let lastStats = { triangles: scene.count, visible: 0, drawn: 0, culled: 0, clipped: 0, degraded: false, wireframe: false, batched: false };

  const removeFns = [];
  let drag = null;
  let dragRemovers = [];

  const raf = (cb) => {
    if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(cb);
    return globalThis.setTimeout(() => cb(Date.now()), 16);
  };
  const caf = (handle) => {
    if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle);
    else globalThis.clearTimeout(handle);
  };

  function on(target, type, handler, extra) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    target.addEventListener(type, handler, extra);
    const off = () => target.removeEventListener(type, handler, extra);
    removeFns.push(off);
    return off;
  }

  function effectiveDpr() {
    if (opts.pixelRatio > 0) return opts.pixelRatio;
    const raw = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
    return clamp(raw, 0.5, 2);
  }

  /** 同步 canvas 像素尺寸到 CSS 尺寸；返回 { w, h, dpr }（w/h 为 CSS 像素）。 */
  function syncSize() {
    let cssW = Number(canvas.clientWidth) || 0;
    let cssH = Number(canvas.clientHeight) || 0;
    let dpr;
    if (cssW > 0 && cssH > 0) {
      dpr = effectiveDpr();
    } else {
      // 无 CSS 布局信息（离屏/测试环境）：直接用 canvas 像素尺寸，不再乘 dpr
      cssW = canvas.width || 0;
      cssH = canvas.height || 0;
      dpr = 1;
    }
    if (cssW <= 0 || cssH <= 0) return { w: 0, h: 0, dpr };
    const pxW = Math.max(1, Math.round(cssW * dpr));
    const pxH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    return { w: cssW, h: cssH, dpr };
  }

  function currentCamera() {
    const size = syncSize();
    if (!size.w || !size.h) return null;
    const fit = computeFit(scene.metrics, size.w, size.h, opts);
    return createCamera(viewState, fit);
  }

  function drawGrid(camera) {
    const { min, max } = scene.metrics;
    const span = Math.max(max[0] - min[0], max[2] - min[2], scene.metrics.radius * 2, 1e-6);
    const step = span / 4;
    const y = min[1];
    const x0 = min[0] - (span - (max[0] - min[0])) / 2;
    const z0 = min[2] - (span - (max[2] - min[2])) / 2;
    ctx.strokeStyle = opts.gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const x = x0 + i * step;
      let a = projectPoint(camera, x, y, z0);
      let b = projectPoint(camera, x, y, z0 + span);
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      const z = z0 + i * step;
      a = projectPoint(camera, x0, y, z);
      b = projectPoint(camera, x0 + span, y, z);
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    }
    ctx.stroke();
  }

  function drawSolidSorted(camera, projected, visible, order) {
    const sx = projected.sx, sy = projected.sy;
    const triIndex = visible.triIndex;
    let last = -1;
    for (let k = 0; k < visible.count; k++) {
      const idx = order[k];
      const t = triIndex[idx];
      const shade = clamp(visible.shades[idx], 0, palette.length - 1);
      if (shade !== last) { ctx.fillStyle = palette[shade]; last = shade; }
      const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
      ctx.beginPath();
      ctx.moveTo(sx[i0], sy[i0]);
      ctx.lineTo(sx[i1], sy[i1]);
      ctx.lineTo(sx[i2], sy[i2]);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawSolidBatched(camera, projected, visible) {
    const sx = projected.sx, sy = projected.sy;
    const triIndex = visible.triIndex;
    const batches = buildDepthShadeBatches(visible.depths, visible.shades, visible.count, {
      slices: opts.batchSlices,
      shadeLevels: opts.shadeLevels,
    });
    let drawn = 0;
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      ctx.fillStyle = palette[clamp(batch.shade, 0, palette.length - 1)];
      ctx.beginPath();
      const ids = batch.indices;
      for (let k = 0; k < ids.length; k++) {
        const t = triIndex[ids[k]];
        const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
        ctx.moveTo(sx[i0], sy[i0]);
        ctx.lineTo(sx[i1], sy[i1]);
        ctx.lineTo(sx[i2], sy[i2]);
        ctx.closePath();
      }
      ctx.fill();
      drawn += ids.length;
    }
    return drawn;
  }

  function drawWireframe(projected, visible) {
    const sx = projected.sx, sy = projected.sy;
    const triIndex = visible.triIndex;
    ctx.strokeStyle = opts.wireframeColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < visible.count; k++) {
      const t = triIndex[k];
      const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
      ctx.moveTo(sx[i0], sy[i0]);
      ctx.lineTo(sx[i1], sy[i1]);
      ctx.lineTo(sx[i2], sy[i2]);
      ctx.closePath();
    }
    ctx.stroke();
  }

  function drawNotice(w, h) {
    if (!notice) return;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const pad = 8;
    ctx.font = '12px sans-serif';
    const textW = (typeof ctx.measureText === 'function' ? ctx.measureText(notice).width : notice.length * 6) + pad * 2;
    ctx.fillRect(8, h - 30, Math.min(textW, w - 16), 22);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(notice, 8 + pad, h - 14);
  }

  /** 一帧同步绘制。返回 false 表示画布尺寸为 0（未布局）。 */
  function drawFrame() {
    if (disposed) return false;
    const size = syncSize();
    if (!size.w || !size.h) return false;
    frames++;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, size.w, size.h);
    } else {
      ctx.clearRect(0, 0, size.w, size.h);
    }

    const fit = computeFit(scene.metrics, size.w, size.h, opts);
    const camera = createCamera(viewState, fit);

    if (opts.grid) drawGrid(camera);

    // 降级策略：三角形数超过 maxTriangles → 抽样 + 关闭线框 + 提示
    let stride = 1;
    let degraded = false;
    if (scene.count > opts.maxTriangles) {
      degraded = true;
      stride = Math.ceil(scene.count / opts.maxTriangles);
    }
    const projected = projectVertices(scene.positions, camera);
    const visible = collectVisibleTriangles(scene, camera, projected, {
      stride,
      cull: opts.cull,
      shadeLevels: opts.shadeLevels,
      lightDir: opts.lightDir,
      ambient: opts.ambient,
      diffuse: opts.diffuse,
    });

    const wireframe = !!opts.wireframe && !degraded;
    const batched = visible.count > opts.batchThreshold;
    let drawn = 0;
    if (batched) {
      drawn = drawSolidBatched(camera, projected, visible);
    } else {
      const order = sortTriangles(visible.depths, visible.count);
      drawSolidSorted(camera, projected, visible, order);
      drawn = visible.count;
    }
    if (wireframe) drawWireframe(projected, visible);

    const sampled = stride > 1 ? Math.ceil(scene.count / stride) : scene.count;
    if (degraded) {
      notice = `模型较大：${scene.count} 个三角形，已抽样显示约 ${sampled} 个（线框已关闭）`;
    } else {
      notice = '';
    }
    drawNotice(size.w, size.h);

    lastStats = {
      triangles: scene.count,
      sampled,
      visible: visible.count,
      drawn,
      culled: visible.culled,
      clipped: visible.clipped,
      degraded,
      batched,
      wireframe,
      stride,
      frames,
    };
    if (notice && notice !== lastNoticeSent && typeof opts.onNotice === 'function') {
      lastNoticeSent = notice;
      opts.onNotice(notice);
    }
    if (typeof opts.onFrame === 'function') opts.onFrame(lastStats);
    return true;
  }

  function requestRender() {
    if (disposed || framePending) return;
    framePending = true;
    rafHandle = raf(() => {
      framePending = false;
      rafHandle = 0;
      drawFrame();
    });
  }

  function renderNow() {
    if (disposed) return false;
    return drawFrame();
  }

  // ---- 事件处理 ----
  function localPoint(ev) {
    const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
    const left = rect ? rect.left : 0;
    const top = rect ? rect.top : 0;
    return { x: (ev.clientX ?? 0) - left, y: (ev.clientY ?? 0) - top };
  }

  function attachDrag() {
    const target = (typeof globalThis.window !== 'undefined' && globalThis.window &&
      typeof globalThis.window.addEventListener === 'function') ? globalThis.window : canvas;
    const move = (ev) => onPointerMove(ev);
    const up = (ev) => onPointerUp(ev);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    dragRemovers = [
      () => target.removeEventListener('pointermove', move),
      () => target.removeEventListener('pointerup', up),
      () => target.removeEventListener('pointercancel', up),
    ];
  }

  function detachDrag() {
    for (const off of dragRemovers) off();
    dragRemovers = [];
  }

  function onPointerDown(ev) {
    if (disposed) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    const point = localPoint(ev);
    const pan = ev.button === 2 || ev.button === 1 || ev.shiftKey === true;
    drag = { pan, lastX: point.x, lastY: point.y, pointerId: ev.pointerId };
    if (typeof canvas.setPointerCapture === 'function' && ev.pointerId !== undefined) {
      try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* 某些环境不支持，忽略 */ }
    }
    attachDrag();
  }

  function onPointerMove(ev) {
    if (!drag || disposed) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    const point = localPoint(ev);
    const dx = point.x - drag.lastX;
    const dy = point.y - drag.lastY;
    drag.lastX = point.x;
    drag.lastY = point.y;
    if (drag.pan) {
      viewState.panX += dx;
      viewState.panY += dy;
    } else {
      viewState.rotY += dx * opts.orbitSpeed;
      viewState.rotX = clamp(viewState.rotX + dy * opts.orbitSpeed, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
    }
    requestRender();
  }

  function onPointerUp(ev) {
    if (!drag) return;
    drag = null;
    detachDrag();
    if (ev && ev.pointerId !== undefined && typeof canvas.releasePointerCapture === 'function') {
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    }
    requestRender();
  }

  function onWheel(ev) {
    if (disposed) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    const delta = ev.deltaY || ev.deltaX || 0;
    const factor = Math.exp(-delta * opts.zoomSpeed);
    viewState.zoom = clamp(viewState.zoom * factor, opts.minZoom, opts.maxZoom);
    requestRender();
  }

  function onContextMenu(ev) {
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
  }

  function onDoubleClick() {
    resetView();
  }

  function resetView() {
    viewState.rotX = clamp(opts.initialRotX, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
    viewState.rotY = opts.initialRotY;
    viewState.zoom = 1;
    viewState.panX = 0;
    viewState.panY = 0;
    requestRender();
  }

  // ---- 公共 API ----
  on(canvas, 'pointerdown', onPointerDown);
  on(canvas, 'wheel', onWheel, { passive: false });
  on(canvas, 'contextmenu', onContextMenu);
  on(canvas, 'dblclick', onDoubleClick);

  if (canvas.style && typeof canvas.style === 'object' && 'touchAction' in canvas.style) {
    canvas.style.touchAction = 'none';
  }

  let resizeObserver = null;
  if (opts.observeResize && typeof globalThis.ResizeObserver === 'function') {
    resizeObserver = new globalThis.ResizeObserver(() => requestRender());
    resizeObserver.observe(canvas);
  } else if (typeof globalThis.window !== 'undefined' && globalThis.window &&
             typeof globalThis.window.addEventListener === 'function') {
    on(globalThis.window, 'resize', requestRender);
  }

  const api = {
    setModel(nextModel) {
      if (disposed) return;
      scene = buildScene(nextModel);
      lastStats = { ...lastStats, triangles: scene.count };
      requestRender();
    },
    setOptions(partial) {
      if (disposed || !partial) return;
      Object.assign(opts, partial);
      if (partial.modelColor) palette = buildPalette(opts.modelColor, opts.shadeLevels);
      requestRender();
    },
    setWireframe(enabled) {
      if (disposed) return;
      opts.wireframe = !!enabled;
      requestRender();
    },
    resetView,
    requestRender,
    renderNow,
    resize() { requestRender(); },
    getState() { return { ...viewState }; },
    getInfo() { return { ...lastStats, frames }; },
    getNotice() { return notice; },
    destroy() {
      if (disposed) return;
      disposed = true;
      if (framePending && rafHandle) caf(rafHandle);
      framePending = false;
      rafHandle = 0;
      detachDrag();
      drag = null;
      for (const off of removeFns) off();
      removeFns.length = 0;
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    },
  };

  requestRender();
  return api;
}

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

function normalizeVec(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-12)) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

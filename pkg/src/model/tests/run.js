// tests/run.js — 无依赖 Node 测试脚本。
// 运行：& 'C:\Program Files\nodejs\node.exe' dsh-preview-extra/pkg/src/model/tests/run.js
// 覆盖：STL(ascii/binary) / OBJ / PLY(ascii/binary) 解析与容错、detect3d 分派、
//       渲染器纯函数、mock canvas 渲染循环/交互/降级/destroy/重绘合并。

import { parseModel, sniffFormat, isSupportedModelFile, SUPPORTED_EXTENSIONS } from '../detect3d.js';
import { parseSTL } from '../stl.js';
import {
  buildScene,
  computeMeshMetrics,
  makeRotation,
  rotatePoint,
  computeFit,
  fitView,
  createCamera,
  projectPoint,
  projectVertices,
  collectVisibleTriangles,
  sortTriangles,
  sortTrianglesByDepth,
  shadeIntensity,
  buildPalette,
  buildDepthShadeBatches,
  createModelView,
} from '../renderer.js';
import {
  makeAsciiSTL,
  makeBinarySTL,
  makeOBJ,
  makeOBJPentagon,
  makeAsciiPLY,
  makeBinaryPLY,
  makeBigEndianPLYHeader,
  TETRA_BOUNDS,
  TETRA_TRIANGLES,
  OBJ_CUBE,
  OBJ_PENTAGON,
  PLY_EXPECTED,
} from './fixtures.js';
import { createMockCanvas } from './mock-canvas.js';

// ---------------------------------------------------------------------------
// 迷你断言库
// ---------------------------------------------------------------------------
function fail(message) { throw new Error(message); }
function ok(cond, message) { if (!cond) fail(message); }
function eq(actual, expected, message) {
  if (!Object.is(actual, expected)) fail(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function close(actual, expected, eps, message) {
  if (!(Math.abs(actual - expected) <= eps)) fail(`${message}：期望 ${expected} ± ${eps}，实际 ${actual}`);
}
function arrClose(actual, expected, eps, message) {
  if (!actual || actual.length !== expected.length) fail(`${message}：长度不一致`);
  for (let i = 0; i < expected.length; i++) {
    if (!(Math.abs(actual[i] - expected[i]) <= eps)) {
      fail(`${message}：第 ${i} 项期望 ${expected[i]}，实际 ${actual[i]}`);
    }
  }
}
function arrEq(actual, expected, message) {
  const a = Array.from(actual);
  if (a.length !== expected.length || a.some((v, i) => v !== expected[i])) {
    fail(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(a)}`);
  }
}
function throws(fn, pattern, message) {
  try {
    fn();
  } catch (err) {
    if (!pattern.test(err.message)) fail(`${message}：错误信息不匹配（${err.message}）`);
    return err;
  }
  return fail(`${message}：期望抛错但没有`);
}
function parseOk(filename, bytes, message = filename) {
  const model = parseModel(filename, bytes);
  if (model.error) fail(`${message}：解析失败 -> ${model.error}`);
  return model;
}
function parseErr(filename, bytes, message = filename) {
  const model = parseModel(filename, bytes);
  if (!model.error) fail(`${message}：期望解析失败，但成功了`);
  return model;
}
function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) fail(`${message}：未包含 "${needle}"（实际：${haystack}）`);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------
// 解析：STL
// ---------------------------------------------------------------------------
test('STL ASCII：三角形/顶点数、包围盒、面法线', () => {
  const bytes = makeAsciiSTL();
  const m = parseOk('tetra.stl', bytes);
  eq(m.format, 'stl', 'format');
  eq(m.variant, 'ascii', 'variant');
  eq(m.counts.triangles, TETRA_TRIANGLES, 'triangles');
  eq(m.counts.vertices, TETRA_TRIANGLES * 3, 'vertices');
  eq(m.triangles.positions instanceof Float32Array, true, 'positions 是 Float32Array');
  eq(m.triangles.count, TETRA_TRIANGLES, 'triangles.count');
  arrClose(m.bounds.min, TETRA_BOUNDS.min, 1e-6, 'bounds.min');
  arrClose(m.bounds.max, TETRA_BOUNDS.max, 1e-6, 'bounds.max');
  ok(Array.isArray(m.warnings), 'warnings 应为数组');
  ok(m.triangles.normals instanceof Float32Array, 'ASCII STL 应输出面法线');
  eq(m.triangles.normals.length, TETRA_TRIANGLES * 3, '法线数量（按三角形）');
});

test('STL 二进制：自动识别 + 三角形/包围盒', () => {
  const bytes = makeBinarySTL();
  const m = parseOk('tetra-binary.stl', bytes);
  eq(m.format, 'stl', 'format');
  eq(m.variant, 'binary', 'variant');
  eq(m.counts.triangles, TETRA_TRIANGLES, 'triangles');
  eq(m.counts.vertices, 12, 'vertices');
  arrClose(m.bounds.min, TETRA_BOUNDS.min, 1e-6, 'bounds.min');
  arrClose(m.bounds.max, TETRA_BOUNDS.max, 1e-6, 'bounds.max');
  eq(m.meta.declaredTriangles, TETRA_TRIANGLES, 'meta.declaredTriangles');
  ok(m.triangles.normals instanceof Float32Array, '二进制 STL 应输出面法线');
  eq(m.triangles.normals.length, TETRA_TRIANGLES * 3, '法线数量（按三角形）');
});

test('STL 二进制：头部计数偏小（容忍 + warning）', () => {
  const bytes = makeBinarySTL(undefined, { declaredCount: 2 });
  const m = parseOk('declared-2.stl', bytes);
  eq(m.counts.triangles, 2, 'triangles');
  ok(m.warnings.some((w) => w.includes('多余')), `应提示尾部多余数据：${m.warnings}`);
});

test('STL 二进制：截断文件给出可读错误', () => {
  const full = makeBinarySTL();
  const truncated = full.subarray(0, 84 + 50 * 2 + 10);
  const m = parseErr('truncated.stl', truncated);
  includes(m.error, '截断', 'truncated 错误');
});

test('STL 二进制：长度非 50 倍数给出可读错误', () => {
  const bytes = new Uint8Array(84 + 120); // 头部计数 0，尾部 120 字节（非 50 倍数）
  bytes.fill(0x20, 0, 80);
  const m = parseErr('badlen.stl', bytes);
  includes(m.error, '50', '长度错误');
});

test('STL ASCII：缺 facet 关键字给出可读错误', () => {
  const m = parseErr('bad-ascii.stl', new TextEncoder().encode('solid only-a-name\n'));
  includes(m.error, 'facet', '缺 facet 错误');
});

test('STL：空文件 / 未知内容给出可读错误', () => {
  includes(parseErr('empty.stl', new Uint8Array(0)).error, '空', '空文件');
  const garbage = new Uint8Array(200);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
  const m = parseErr('garbage.stl', garbage);
  ok(/无法识别|长度|50|截断/.test(m.error), `garbage 错误应可读：${m.error}`);
});

test('STL：Uint8Array 子视图（带 offset）也能解析', () => {
  const ascii = makeAsciiSTL();
  const padded = new Uint8Array(ascii.length + 16);
  padded.set(ascii, 7);
  const view = padded.subarray(7, 7 + ascii.length);
  const m = parseOk('offset.stl', view);
  eq(m.counts.triangles, TETRA_TRIANGLES, 'triangles');
});

test('STL：ArrayBuffer 入参 / 扩展名大写', () => {
  const buffer = makeBinarySTL().buffer;
  const m = parseOk('TETRA.STL', buffer);
  eq(m.counts.triangles, TETRA_TRIANGLES, 'triangles');
});

// ---------------------------------------------------------------------------
// 解析：OBJ
// ---------------------------------------------------------------------------
test('OBJ：v/vn/vt/f 各种写法、负索引、quad 扇形三角化', () => {
  const m = parseOk('cube.obj', makeOBJ());
  eq(m.format, 'obj', 'format');
  eq(m.counts.vertices, OBJ_CUBE.vertices, 'vertices');
  eq(m.counts.triangles, OBJ_CUBE.triangles, 'triangles');
  eq(m.meta.faces, 6, 'meta.faces');
  eq(m.meta.ngons, 6, 'meta.ngons（6 个四边形面都按 n-gon 统计）');
  arrClose(m.bounds.min, OBJ_CUBE.bounds.min, 1e-6, 'bounds.min');
  arrClose(m.bounds.max, OBJ_CUBE.bounds.max, 1e-6, 'bounds.max');
  // 第 5 个面（负索引）应解析为 v1,v5,v8：坐标 (0,0,0),(0,0,1),(0,1,1)
  const o = 8 * 9; // 前 4 个 quad = 8 个三角形
  arrClose(m.triangles.positions.subarray(o, o + 9), [0, 0, 0, 0, 0, 1, 0, 1, 1], 1e-6, '负索引面坐标');
});

test('OBJ：n-gon 扇形三角化（五边形 → 3 三角形）', () => {
  const m = parseOk('pentagon.obj', makeOBJPentagon());
  eq(m.counts.vertices, OBJ_PENTAGON.vertices, 'vertices');
  eq(m.counts.triangles, OBJ_PENTAGON.triangles, 'triangles');
  eq(m.meta.ngons, 1, 'meta.ngons');
  arrClose(m.bounds.max, OBJ_PENTAGON.bounds.max, 1e-6, 'bounds.max');
});

test('OBJ：非法索引 / 缺面给出可读错误', () => {
  const badIndex = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n');
  includes(parseErr('bad-index.obj', badIndex).error, '超出范围', '非法索引错误');
  const noFace = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\n');
  includes(parseErr('no-face.obj', noFace).error, 'f', '缺面错误');
});

// ---------------------------------------------------------------------------
// 解析：PLY
// ---------------------------------------------------------------------------
for (const [label, makeBytes, variant] of [
  ['ASCII', makeAsciiPLY, 'ascii'],
  ['binary_little_endian', makeBinaryPLY, 'binary-little-endian'],
]) {
  test(`PLY ${label}：vertex/face/n-gon/未知 element`, () => {
    const m = parseOk('pyramid.ply', makeBytes());
    eq(m.format, 'ply', 'format');
    eq(m.variant, variant, 'variant');
    eq(m.counts.vertices, PLY_EXPECTED.vertices, 'vertices');
    eq(m.counts.triangles, PLY_EXPECTED.triangles, 'triangles');
    arrClose(m.bounds.min, PLY_EXPECTED.bounds.min, 1e-6, 'bounds.min');
    arrClose(m.bounds.max, PLY_EXPECTED.bounds.max, 1e-6, 'bounds.max');
    ok(m.meta.elements.includes('edge'), '未知 element 应被记录并跳过');
    // 第一个面是 [0,3,2,1] → 第一个三角形顶点 0,3,2
    arrClose(m.triangles.positions.subarray(0, 9), [0, 0, 0, 0, 1, 0, 1, 1, 0], 1e-6, '首三角形坐标');
  });
}

test('PLY：binary_big_endian 给出可读错误', () => {
  const m = parseErr('be.ply', makeBigEndianPLYHeader());
  includes(m.error, 'binary_big_endian', '大端错误');
});

test('PLY：数据截断 / 魔数错误给出可读错误', () => {
  const ascii = makeAsciiPLY();
  const text = new TextDecoder().decode(ascii);
  const cut = text.slice(0, text.indexOf('end_header') + 'end_header'.length + 10);
  const m = parseErr('truncated.ply', new TextEncoder().encode(cut));
  includes(m.error, '提前结束', '截断错误');
  const bad = new TextEncoder().encode('not-a-ply file at all\n');
  includes(parseErr('bad.ply', bad).error, 'ply', '魔数错误');
});

// ---------------------------------------------------------------------------
// detect3d 分派 / 嗅探 / 错误形状
// ---------------------------------------------------------------------------
test('detect3d：按内容嗅探未知扩展名', () => {
  eq(sniffFormat(makeAsciiSTL()), 'stl-ascii', 'sniff ascii stl');
  eq(sniffFormat(makeBinarySTL()), 'stl-binary', 'sniff binary stl');
  eq(sniffFormat(makeAsciiPLY()), 'ply', 'sniff ply');
  eq(sniffFormat(makeOBJ()), 'obj', 'sniff obj');
  eq(sniffFormat(new Uint8Array([1, 2, 3, 4])), null, '无法嗅探');
  eq(parseOk('download.bin', makeAsciiSTL()).format, 'stl', '未知扩展名 → stl');
  eq(parseOk('blob.dat', makeBinaryPLY()).format, 'ply', '未知扩展名 → ply');
});

test('detect3d：暂不支持格式 / 完全未知格式 / 非法输入', () => {
  const zeros = new Uint8Array(64);
  includes(parseErr('model.3mf', zeros).error, '3MF', '3mf 提示');
  includes(parseErr('model.glb', zeros).error, 'GLB', 'glb 提示');
  includes(parseErr('mystery.bin', new Uint8Array([9, 9, 9, 9, 9, 9])).error, '无法识别', '未知格式');
  includes(parseErr('x.stl', 'not-bytes').error, '字节', '非法入参');
});

test('detect3d：失败结果形状稳定（error + 空 counts + bounds）', () => {
  const m = parseErr('bad.stl', new Uint8Array([1, 2, 3]));
  eq(m.counts.triangles, 0, 'counts.triangles');
  eq(m.triangles.count, 0, 'triangles.count');
  arrClose(m.bounds.min, [0, 0, 0], 1e-9, 'bounds.min');
  ok(typeof m.error === 'string' && m.error.length > 0, 'error 应为非空字符串');
});

test('detect3d：SUPPORTED_EXTENSIONS / isSupportedModelFile', () => {
  eq(SUPPORTED_EXTENSIONS.includes('stl'), true, '支持 stl');
  eq(isSupportedModelFile('a/b/c.STL'), true, '大写扩展名');
  eq(isSupportedModelFile('a.obj'), true, 'obj');
  eq(isSupportedModelFile('a.ply'), true, 'ply');
  eq(isSupportedModelFile('a.3mf'), false, '3mf 不支持');
  eq(isSupportedModelFile('noext'), false, '无扩展名');
});

// ---------------------------------------------------------------------------
// 渲染器纯函数层
// ---------------------------------------------------------------------------
const cubeModel = parseOk('cube.obj', makeOBJ());

test('buildScene：从 parseModel 结果构建 scene', () => {
  const scene = buildScene(cubeModel);
  eq(scene.count, OBJ_CUBE.triangles, 'count');
  eq(scene.positions.length, OBJ_CUBE.triangles * 9, 'positions.length');
  eq(scene.triangles.count, OBJ_CUBE.triangles, 'scene.triangles.count');
  arrClose(scene.bounds.min, [0, 0, 0], 1e-6, 'bounds.min');
  arrClose(scene.bounds.max, [1, 1, 1], 1e-6, 'bounds.max');
  throws(() => buildScene({ positions: new Float32Array(10) }), /9 的整数倍/, '非法长度');
  throws(() => buildScene({ positions: new Float32Array(0) }), /不含任何三角形/, '空模型');
  throws(() => buildScene(null), /positions|Float32Array/, '空入参');
});

test('computeMeshMetrics：包围盒中心/半径/计数', () => {
  const metrics = computeMeshMetrics(cubeModel.triangles.positions);
  arrClose(metrics.center, [0.5, 0.5, 0.5], 1e-6, 'center');
  close(metrics.radius, Math.sqrt(3) / 2, 1e-5, 'radius');
  eq(metrics.triangleCount, OBJ_CUBE.triangles, 'triangleCount');
  eq(metrics.vertexCount, OBJ_CUBE.triangles * 3, 'vertexCount');
});

test('makeRotation / rotatePoint：零旋转为单位矩阵', () => {
  const m = makeRotation(0, 0);
  arrClose(m, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-7, 'identity');
  arrClose(rotatePoint(m, 1.5, -2.5, 3.5), [1.5, -2.5, 3.5], 1e-7, 'rotatePoint identity');
  // 绕 Y 旋转 90°：(1,0,0) → (0,0,-1)
  const m90 = makeRotation(0, Math.PI / 2);
  arrClose(rotatePoint(m90, 1, 0, 0), [0, 0, -1], 1e-6, 'yaw 90');
});

test('computeFit / projectPoint：中心投影到画布中心，8 个角点都在视口内', () => {
  const metrics = computeMeshMetrics(cubeModel.triangles.positions);
  const fit = computeFit(metrics, 400, 300);
  eq(fitView, computeFit, 'fitView 为 computeFit 别名');
  eq(fit.focal, 240, 'focal = min(400,300)*0.8');
  close(fit.scale, 1 / (Math.sqrt(3) / 2), 1e-9, 'scale = 1/radius');
  const camera = createCamera({ rotX: 0, rotY: 0, zoom: 1 }, fit);
  const center = projectPoint(camera, 0.5, 0.5, 0.5);
  close(center.x, 200, 1e-6, 'center.x');
  close(center.y, 150, 1e-6, 'center.y');
  close(center.depth, 3, 1e-6, 'center.depth');
  const corners = [];
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) corners.push([x, y, z]);
  for (const c of corners) {
    const p = projectPoint(camera, c[0], c[1], c[2]);
    ok(p !== null, '角点不应被裁剪');
    ok(p.x >= 0 && p.x <= 400 && p.y >= 0 && p.y <= 300, `角点 (${c}) 投影落在视口内：(${p.x},${p.y})`);
  }
});

test('projectVertices：批量投影 + 相机后方点标记无效', () => {
  const metrics = computeMeshMetrics(cubeModel.triangles.positions);
  const camera = createCamera({ rotX: 0, rotY: 0, zoom: 1 }, computeFit(metrics, 400, 300));
  const projected = projectVertices(cubeModel.triangles.positions, camera);
  eq(projected.count, OBJ_CUBE.triangles * 3, '顶点数');
  let validCount = 0;
  for (let i = 0; i < projected.count; i++) validCount += projected.valid[i];
  eq(validCount, projected.count, '所有顶点都在相机前方');
  // 旋转到把模型推到相机后方：pan 不影响，直接检查 depth>0 约束
  const behind = { ...camera, dist: -1 };
  const p2 = projectVertices(cubeModel.triangles.positions, behind);
  let anyValid = 0;
  for (let i = 0; i < p2.count; i++) anyValid += p2.valid[i];
  eq(anyValid, 0, '相机后方所有点无效');
});

test('collectVisibleTriangles：背面剔除 / 光照分层', () => {
  const scene = buildScene(cubeModel);
  const camera = createCamera({ rotX: 0, rotY: 0, zoom: 1 }, computeFit(scene.metrics, 400, 300));
  const projected = projectVertices(scene.positions, camera);
  const visible = collectVisibleTriangles(scene, camera, projected, { cull: true, shadeLevels: 32 });
  eq(visible.count, 2, 'identity 视角下只有 +Z 面 2 个三角形可见');
  eq(visible.culled, OBJ_CUBE.triangles - 2, '背面剔除数量');
  eq(visible.clipped, 0, '无裁剪');
  for (let i = 0; i < visible.count; i++) {
    ok(visible.shades[i] >= 0 && visible.shades[i] <= 32, 'shade 在 0..32');
    ok(visible.depths[i] > 0, 'depth > 0');
  }
  const all = collectVisibleTriangles(scene, camera, projected, { cull: false, shadeLevels: 32 });
  eq(all.count, OBJ_CUBE.triangles, '关闭剔除后全部可见');
});

test('sortTriangles：画家算法远→近 + 别名', () => {
  eq(sortTrianglesByDepth, sortTriangles, 'sortTrianglesByDepth 别名');
  const order = sortTriangles(new Float32Array([3, 1, 2]), 3);
  arrEq(order, [0, 2, 1], '远→近顺序');
  const empty = sortTriangles(new Float32Array(0), 0);
  eq(empty.length, 0, '空输入');
  const same = sortTriangles(new Float32Array([2, 2, 2]), 3);
  eq(same.length, 3, '深度相同时不丢项');
  const depths = new Float32Array([5, 1, 3, 2, 4]);
  const o = sortTriangles(depths, depths.length);
  for (let i = 1; i < o.length; i++) {
    ok(depths[o[i - 1]] >= depths[o[i]] - 1e-6, '顺序应按深度非递增');
  }
});

test('shadeIntensity / buildPalette', () => {
  close(shadeIntensity([0, 0, 1], [0, 0, 1], 0.3, 0.7), 1, 1e-6, '正对光源');
  close(shadeIntensity([0, 0, -1], [0, 0, 1], 0.3, 0.7), 0.3, 1e-6, '背光只有环境光');
  const palette = buildPalette([100, 150, 200], 8);
  eq(palette.length, 9, '调色板长度');
  eq(palette[0], 'rgb(0,0,0)', '最暗');
  eq(palette[8], 'rgb(100,150,200)', '最亮');
});

test('buildDepthShadeBatches：批次 slice 递增、索引不丢', () => {
  const depths = new Float32Array([5, 1, 3, 2, 4]);
  const shades = new Uint8Array([1, 2, 3, 4, 5]);
  const batches = buildDepthShadeBatches(depths, shades, 5, { slices: 3, shadeLevels: 8 });
  let total = 0;
  let lastSlice = -1;
  for (const b of batches) {
    ok(b.slice >= lastSlice, 'slice 应远→近递增');
    lastSlice = b.slice;
    ok(b.shade >= 0 && b.shade <= 8, 'shade 范围');
    total += b.indices.length;
  }
  eq(total, 5, '索引总数不丢');
  eq(buildDepthShadeBatches(depths, shades, 0).length, 0, '空输入');
});

// ---------------------------------------------------------------------------
// 渲染器（mock canvas）
// ---------------------------------------------------------------------------
test('createModelView：渲染一帧，产生 fill/背景，统计正确', () => {
  const canvas = createMockCanvas(320, 240);
  const notices = [];
  const view = createModelView({
    canvas,
    model: cubeModel,
    options: { background: '#000', grid: true, onNotice: (m) => notices.push(m) },
  });
  eq(typeof view.renderNow, 'function', 'renderNow 存在');
  eq(view.renderNow(), true, 'renderNow 返回 true');
  eq(canvas.calls.fillRect >= 1, true, '应绘制背景');
  eq(canvas.calls.fill > 0, true, '应填充三角形');
  eq(canvas.calls.stroke >= 1, true, '应绘制地面网格');
  const info = view.getInfo();
  eq(info.triangles, OBJ_CUBE.triangles, 'info.triangles');
  ok(info.visible > 0 && info.visible <= OBJ_CUBE.triangles, `info.visible=${info.visible}`);
  eq(info.degraded, false, '未降级');
  eq(notices.length, 0, '未降级不应有提示');
  eq(canvas.listenerCount('pointerdown'), 1, '应挂 pointerdown');
  eq(canvas.listenerCount('wheel'), 1, '应挂 wheel');
  view.destroy();
});

test('createModelView：线框开关', () => {
  const canvas = createMockCanvas(320, 240);
  const view = createModelView({ canvas, model: cubeModel, options: { grid: false, wireframe: false } });
  view.renderNow();
  eq(canvas.calls.stroke, 0, '关闭线框时不应 stroke');
  view.setWireframe(true);
  view.renderNow();
  eq(canvas.calls.stroke >= 1, true, '开启线框后应 stroke');
  eq(view.getInfo().wireframe, true, 'info.wireframe');
  view.setWireframe(false);
  view.renderNow();
  eq(view.getInfo().wireframe, false, '关闭后 info.wireframe=false');
  view.destroy();
});

test('createModelView：拖拽旋转 / 滚轮缩放 / Shift 与右键平移', () => {
  const canvas = createMockCanvas(320, 240);
  const view = createModelView({ canvas, model: cubeModel, options: { grid: false } });
  const s0 = view.getState();

  canvas.dispatch('pointerdown', { button: 0, shiftKey: false, pointerId: 1, clientX: 20, clientY: 20 });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: 70, clientY: 50 });
  canvas.dispatch('pointerup', { pointerId: 1, clientX: 70, clientY: 50 });
  const s1 = view.getState();
  ok(s1.rotY !== s0.rotY && s1.rotX !== s0.rotX, '拖拽应改变旋转角');
  ok(Math.abs(s1.rotX) <= Math.PI / 2, 'rotX 应被夹紧');

  canvas.dispatch('wheel', { deltaY: -120 });
  const s2 = view.getState();
  ok(s2.zoom > s1.zoom, `滚轮上滚应放大（${s1.zoom} → ${s2.zoom}）`);
  canvas.dispatch('wheel', { deltaY: 400 });
  ok(view.getState().zoom < s2.zoom, '滚轮下滚应缩小');

  canvas.dispatch('pointerdown', { button: 0, shiftKey: true, pointerId: 2, clientX: 10, clientY: 10 });
  canvas.dispatch('pointermove', { pointerId: 2, clientX: 40, clientY: 35 });
  canvas.dispatch('pointerup', { pointerId: 2, clientX: 40, clientY: 35 });
  const s3 = view.getState();
  ok(s3.panX > s2.panX && s3.panY > s2.panY, 'Shift 拖拽应平移');

  canvas.dispatch('pointerdown', { button: 2, shiftKey: false, pointerId: 3, clientX: 0, clientY: 0 });
  canvas.dispatch('pointermove', { pointerId: 3, clientX: 10, clientY: 10 });
  canvas.dispatch('pointerup', { pointerId: 3, clientX: 10, clientY: 10 });
  ok(view.getState().panX > s3.panX, '右键拖拽应平移');

  view.resetView();
  const s4 = view.getState();
  eq(s4.zoom, 1, 'resetView 复位缩放');
  eq(s4.panX, 0, 'resetView 复位 panX');
  view.destroy();
});

test('createModelView：resize 同步 canvas 像素尺寸', () => {
  const canvas = createMockCanvas(320, 240);
  const view = createModelView({ canvas, model: cubeModel, options: { grid: false, pixelRatio: 1 } });
  view.renderNow();
  eq(canvas.width, 320, '初始宽度');
  canvas.clientWidth = 500;
  canvas.clientHeight = 400;
  view.renderNow();
  eq(canvas.width, 500, 'resize 后宽度');
  eq(canvas.height, 400, 'resize 后高度');
  view.destroy();
});

test('createModelView：超过 maxTriangles 降级（抽样 + 关线框 + 提示）', () => {
  const canvas = createMockCanvas(320, 240);
  const notices = [];
  const view = createModelView({
    canvas,
    model: cubeModel,
    options: { grid: false, wireframe: true, maxTriangles: 4, onNotice: (m) => notices.push(m) },
  });
  view.renderNow();
  const info = view.getInfo();
  eq(info.degraded, true, 'info.degraded');
  eq(info.wireframe, false, '降级时线框应关闭');
  eq(info.stride, 3, '抽样步长 = ceil(12/4)=3');
  eq(info.sampled, 4, '抽样后三角形数');
  eq(notices.length >= 1, true, '应触发 onNotice');
  includes(notices[0], '三角形', '提示文案');
  eq(canvas.calls.fill > 0, true, '降级后仍有填充');
  view.destroy();
});

test('createModelView：大模型走批量化绘制路径', () => {
  const canvas = createMockCanvas(320, 240);
  const view = createModelView({ canvas, model: cubeModel, options: { grid: false, batchThreshold: 1 } });
  view.renderNow();
  eq(view.getInfo().batched, true, 'info.batched');
  eq(canvas.calls.fill > 0, true, '批量路径应填充');
  view.destroy();
});

test('createModelView：0 尺寸画布不抛错', () => {
  const canvas = createMockCanvas(0, 0);
  const view = createModelView({ canvas, model: cubeModel });
  eq(view.renderNow(), false, '0 尺寸返回 false');
  eq(view.getInfo().frames, 0, '尚未绘制任何帧');
  view.destroy();
});

test('createModelView：destroy 移除监听并停止重绘', async () => {
  const canvas = createMockCanvas(200, 150);
  const view = createModelView({ canvas, model: cubeModel });
  eq(canvas.listenerCount('pointerdown'), 1, 'destroy 前有监听');
  view.destroy();
  eq(canvas.listenerCount('pointerdown'), 0, 'destroy 后监听移除');
  eq(canvas.listenerCount('wheel'), 0, 'wheel 监听移除');
  eq(view.renderNow(), false, 'destroy 后 renderNow 返回 false');
  canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 1, clientY: 1 }); // 不应抛错
  const frames = view.getInfo().frames;
  view.requestRender();
  await sleep(50);
  eq(view.getInfo().frames, frames, 'destroy 后 requestRender 不应再绘制');
});

test('createModelView：requestAnimationFrame 合并多次重绘请求', async () => {
  const canvas = createMockCanvas(200, 150);
  const view = createModelView({ canvas, model: cubeModel, options: { grid: false } });
  await sleep(50); // 等初始帧
  const base = view.getInfo().frames;
  ok(base >= 1, '初始帧应已绘制');
  view.requestRender();
  view.requestRender();
  view.requestRender();
  await sleep(80);
  eq(view.getInfo().frames, base + 1, '三次请求应合并为一帧');
  view.destroy();
});

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  let pass = 0;
  const failures = [];
  console.log('3D 模型解析 + Canvas2D 渲染器测试');
  console.log('='.repeat(60));
  for (const { name, fn } of tests) {
    try {
      await fn();
      pass++;
      console.log(`\u2713 ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`\u2717 ${name}`);
      console.log(`    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`);
    }
  }
  console.log('='.repeat(60));
  console.log(`结果：${pass}/${tests.length} 通过，${failures.length} 失败`);
  if (failures.length > 0) {
    console.log('失败用例：');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  }
  if (typeof process !== 'undefined' && process.exitCode === undefined) {
    process.exitCode = failures.length > 0 ? 1 : 0;
  }
}

await main();

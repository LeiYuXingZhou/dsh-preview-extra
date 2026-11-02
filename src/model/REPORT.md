# 3D 模型解析 + Canvas2D 软件渲染器（task-3 报告）

> 位置：`dsh-preview-extra/src/model/`
> 性质：纯 ESM，零第三方依赖，浏览器 / Node 24 均可运行；不碰 React、不在模块顶层读取 DOM 全局。
> 当前支持格式：**STL（binary/ascii）、OBJ、PLY（ascii / binary_little_endian）、glTF / GLB**；3MF 等仍给出"暂不支持"的可读错误。glTF 解析在 `src/formats/gltf.js`。

## 1. 文件清单（需要打进客户端 bundle 的只有前 6 个 .js）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `common.js` | 137 | 字节/文本解码、包围盒、平面法线、解析收尾（统一 Float32Array + 校验） |
| `stl.js` | 189 | 二进制/ASCII STL 自动识别、容错与可读错误 |
| `obj.js` | 123 | v/vn/vt/f（4 种索引写法、负索引）、n-gon 扇形三角化、忽略材质 |
| `ply.js` | 303 | ASCII + binary_little_endian、任意标量/list 属性、未知 element 跳过 |
| `detect3d.js` | 115 | 扩展名 + 内容嗅探分派；`parseModel` 统一出口（永不抛错，返回 `error`） |
| `renderer.js` | 748 | 纯函数层（投影/剔除/排序/适配/分批）+ `createModelView` 交互视图 |
| `package.json` | 6 | 只为 Node 把本目录 `.js` 识别为 ESM（浏览器/打包脚本可忽略） |
| `tests/run.js` / `fixtures.js` / `mock-canvas.js` | 546 / 237 / 87 | Node 测试，不打包 |

**打包依赖顺序**（若 lead 的 ESM→CJS 拼接脚本按文件内联）：`common.js` → `stl.js` / `obj.js` / `ply.js` → `detect3d.js`、`renderer.js`。
无 default export；所有 import 都是同目录 `./xxx.js`；无 `node:*`、无外部包。

## 2. 对外接口签名

### 2.1 解析入口 `detect3d.js`

```js
export const SUPPORTED_EXTENSIONS;              // ['stl','obj','ply']
export function isSupportedModelFile(filename); // -> boolean（仅看扩展名）
export function sniffFormat(bytes);             // -> 'ply'|'stl-ascii'|'stl-binary'|'obj'|null

export function parseModel(filename, bytes) -> {
  format: 'stl'|'obj'|'ply'|'unknown',
  variant?: 'binary'|'ascii'|'binary-little-endian'|'text',
  triangles: {
    positions: Float32Array,   // 三角形汤：每 9 个 float 一个三角形
    normals?: Float32Array,    // 按三角形的平面法线（长度 = 三角形数×3），OBJ/PLY 无
    count: number
  },
  bounds: { min: [x,y,z], max: [x,y,z] },
  counts: { vertices: number, triangles: number },
  warnings: string[],          // 始终是数组
  meta: object,
  error?: string               // 失败时存在；此时 counts 全 0、positions 为空
}
```
`parseModel` **除了入参完全非法之外不抛异常**，失败时返回 `error`（调用方直接展示该文案即可）。
`counts.vertices` 语义：源顶点数（STL 为三角形汤顶点 = 3×三角形数；OBJ/PLY 为文件内顶点数）。
`bytes` 接受 `Uint8Array` / `ArrayBuffer`（含带 byteOffset 的子视图）。

### 2.2 各格式解析器（可单独使用）

```js
// stl.js
export function parseSTL(bytes);          // 自动识别 binary / ascii
export function parseBinarySTL(bytes);
export function parseAsciiSTL(bytes);
export function isBinarySTL(bytes);       // boolean
export function looksLikeAsciiSTL(bytes); // boolean

// obj.js
export function parseOBJ(bytes);

// ply.js
export function parsePLY(bytes);
export function isPLY(bytes);
```
返回值统一为 `finishMesh` 的形状：`{format, variant, positions, normals|null, triangleCount, vertexCount, bounds, warnings, meta}`。

### 2.3 渲染器 `renderer.js`

纯函数层（Node 可单独回归，不接触 DOM）：

```js
export const DEFAULT_OPTIONS;            // 默认配置（背景、网格、颜色、光照、上限等）
export function buildScene(model);       // parseModel 结果/裸 positions -> {positions, count, triangles:{positions,count}, metrics, bounds}
export function computeMeshMetrics(positions); // -> {min,max,center,radius,triangleCount,vertexCount}
export function makeRotation(rotX, rotY);      // 行主序 3x3：先 Y 偏航再 X 俯仰
export function rotatePoint(m, x, y, z);
export function computeFit(metrics, width, height, options); // 自动适配参数
export const fitView;                    // computeFit 的别名
export function createCamera(viewState, fit);
export function projectPoint(camera, x, y, z);  // -> {x,y,depth}|null（相机后方为 null）
export const project;                    // projectPoint 的别名
export function projectVertices(positions, camera); // -> {sx,sy,depth,valid,count}
export function collectVisibleTriangles(scene, camera, projected, options);
        // -> {triIndex,depths,shades,count,culled,clipped,total}
export function sortTriangles(depths, count, buckets=4096); // 桶排序，远→近
export const sortTrianglesByDepth;       // sortTriangles 的别名
export function shadeIntensity(normal, lightDir, ambient, diffuse);
export function buildPalette(rgb, levels);
export function buildDepthShadeBatches(depths, shades, count, {slices, shadeLevels});
        // 大批量绘制用：按（深度切片, 明暗层）聚合，返回远→近批次
```

交互视图（唯一接触 canvas / 事件 / rAF 的部分）：

```js
export function createModelView({ canvas, model, options }) -> {
  setModel(model), setOptions(partial), setWireframe(bool),
  resetView(), requestRender(), renderNow(), resize(),
  getState(),   // {rotX,rotY,zoom,panX,panY}
  getInfo(),    // {triangles,sampled,visible,drawn,culled,clipped,degraded,batched,wireframe,stride,frames}
  getNotice(), destroy()
}
```
`options` 关键项：`background / grid / modelColor / wireframe / cull / lightDir / ambient / diffuse /
shadeLevels / fitPadding / initialRotX / initialRotY / orbitSpeed / zoomSpeed / minZoom / maxZoom /
batchThreshold(20000) / batchSlices(64) / maxTriangles(300000) / pixelRatio / onNotice(msg) / onFrame(stats)`。
`renderNow()` 是同步绘制（Node 测试用）；正常交互走 `requestRender()`（rAF 合并）。

### 2.4 集成示例（右侧栏插件侧）

```js
import { parseModel, SUPPORTED_EXTENSIONS } from './model/detect3d.js';
import { createModelView } from './model/renderer.js';

const model = parseModel(filename, bytes);      // bytes: Uint8Array
if (model.error) { showError(model.error); return; }
const view = createModelView({ canvas, model, options: { wireframe: false, grid: true } });
// 组件卸载时：view.destroy()
```
文件类型注册可用 `extensions: ['stl','obj','ply']`（`binaryExtensions` 同样三项，三者都是二进制安全的容器格式）。

## 3. 容错与可读错误示例

| 场景 | 错误文案（节选） |
| --- | --- |
| 二进制 STL 截断 | `STL 解析失败：文件被截断，头部声明 4 个三角形（需要 284 字节），实际只有 194 字节` |
| 二进制 STL 长度非 50 倍数 | `STL 解析失败：二进制数据段长度 120 字节不是 50 的整数倍（每个三角形固定 50 字节），文件可能损坏` |
| ASCII STL 缺 facet | `STL 解析失败：ASCII STL 缺少完整的 "facet"/"vertex" 关键字，无法解析` |
| OBJ 索引越界 | `OBJ 解析失败：第 4 行的顶点索引 4 超出范围（当前共 3 个顶点）` |
| PLY 大端 | `PLY 解析失败：暂不支持 binary_big_endian 字节序的 PLY（当前支持 ascii / binary_little_endian）` |
| 未知扩展名/内容 | `无法识别的 3D 模型格式（扩展名 ".bin" 未知，内容也不是 STL/OBJ/PLY）` |
| 3MF | `暂不支持 .3mf 格式（3MF）；当前支持 STL / OBJ / PLY / glTF / GLB` |
| 损坏的 GLB | `GLB 解析失败：…`（扩展名是 .glb 时走 glTF 解析，不再当成未支持格式） |

此外：头部三角形计数为 0 但长度自洽 → 按长度推断并 warning；尾部多余字节 → warning；ASCII 缺 `solid`/`facet` 但几何完整 → 仍解析并 warning；STL 头部法线为 0 向量 → 用几何法线补齐。

## 4. 测试

命令（工作目录 `C:\Users\you\Documents\daily`）：

```powershell
& 'C:\Program Files\nodejs\node.exe' dsh-preview-extra/src/model/tests/run.js
```

覆盖：手工构造的 ASCII STL / binary STL / OBJ（cube + pentagon + 错误样本）/ PLY ASCII / PLY binary_little_endian / 大端 PLY / 截断样本；解析数量、包围盒、三角化、负索引、错误文案；detect3d 嗅探与错误形状；渲染器纯函数（投影、适配、剔除、桶排序、光照、分批）；mock canvas 的渲染循环、线框开关、拖拽/滚轮/Shift/右键、resize、降级、批量化、0 尺寸、destroy、rAF 合并。

实际输出（2026-11-01，Node v24.15.0）：

```text
3D 模型解析 + Canvas2D 渲染器测试
============================================================
✓ STL ASCII：三角形/顶点数、包围盒、面法线
✓ STL 二进制：自动识别 + 三角形/包围盒
✓ STL 二进制：头部计数偏小（容忍 + warning）
✓ STL 二进制：截断文件给出可读错误
✓ STL 二进制：长度非 50 倍数给出可读错误
✓ STL ASCII：缺 facet 关键字给出可读错误
✓ STL：空文件 / 未知内容给出可读错误
✓ STL：Uint8Array 子视图（带 offset）也能解析
✓ STL：ArrayBuffer 入参 / 扩展名大写
✓ OBJ：v/vn/vt/f 各种写法、负索引、quad 扇形三角化
✓ OBJ：n-gon 扇形三角化（五边形 → 3 三角形）
✓ OBJ：非法索引 / 缺面给出可读错误
✓ PLY ASCII：vertex/face/n-gon/未知 element
✓ PLY binary_little_endian：vertex/face/n-gon/未知 element
✓ PLY：binary_big_endian 给出可读错误
✓ PLY：数据截断 / 魔数错误给出可读错误
✓ detect3d：按内容嗅探未知扩展名
✓ detect3d：暂不支持格式 / 完全未知格式 / 非法输入
✓ detect3d：失败结果形状稳定（error + 空 counts + bounds）
✓ detect3d：SUPPORTED_EXTENSIONS / isSupportedModelFile
✓ buildScene：从 parseModel 结果构建 scene
✓ computeMeshMetrics：包围盒中心/半径/计数
✓ makeRotation / rotatePoint：零旋转为单位矩阵
✓ computeFit / projectPoint：中心投影到画布中心，8 个角点都在视口内
✓ projectVertices：批量投影 + 相机后方点标记无效
✓ collectVisibleTriangles：背面剔除 / 光照分层
✓ sortTriangles：画家算法远→近 + 别名
✓ shadeIntensity / buildPalette
✓ buildDepthShadeBatches：批次 slice 递增、索引不丢
✓ createModelView：渲染一帧，产生 fill/背景，统计正确
✓ createModelView：线框开关
✓ createModelView：拖拽旋转 / 滚轮缩放 / Shift 与右键平移
✓ createModelView：resize 同步 canvas 像素尺寸
✓ createModelView：超过 maxTriangles 降级（抽样 + 关线框 + 提示）
✓ createModelView：大模型走批量化绘制路径
✓ createModelView：0 尺寸画布不抛错
✓ createModelView：destroy 移除监听并停止重绘
✓ createModelView：requestAnimationFrame 合并多次重绘请求
============================================================
结果：38/38 通过，0 失败
```

## 5. 性能（Node 24，本机；benchmark 脚本为临时脚本，已删除）

300,000 三角形 binary STL 全流程：

| 步骤 | 耗时 |
| --- | --- |
| `parseModel`（含校验/包围盒） | 48.3 ms |
| `buildScene` | 12.9 ms |
| `projectVertices`（90 万顶点） | 11.7 ms |
| `collectVisibleTriangles`（剔除 + 光照） | 20.9 ms |
| `sortTriangles`（4096 桶桶排序，O(n)） | 8.4 ms |
| `buildDepthShadeBatches`（64 切片 × 32 明暗层） | 14.8 ms |
| mock canvas 完整一帧（批量化路径，128 次 fill） | ~39.5 ms（CPU 侧，不含真实 canvas 光栅化） |
| 1,000,000 三角形 STL `parseModel` | 126.7 ms |

性能设计（回应"避免每帧 O(n log n) 排序过重"）：
- **排序不用 `Array#sort`**：`sortTriangles` 用计数/桶排序，O(n + buckets)，30 万三角形约 8 ms；深度相同或单三角形走线性回退。
- **大模型批量化绘制**：可见三角形 > `batchThreshold`（默认 2 万）时，不再逐三角形 `fill`，而是按"深度切片 × 明暗层"聚合为最多 `slices×levels` 个 Path 一次填充（30 万三角形 → 128 次 fill）。代价是同一深度切片内的遮挡顺序被弱化为批次顺序，深色/浅色交叠处可能有轻微画家误差（预览可接受，报告中已注明）。
- **超过 `maxTriangles`（默认 30 万）自动降级**：抽样（stride=ceil(n/300000)）+ 强制关闭线框 + `onNotice` 提示 + 画布左下角文字提示；不会一次性提交无限多三角形导致卡死。
- 重绘由 `requestAnimationFrame` 合并，仅在交互/尺寸变化时触发，不做常驻动画循环。
- 解析阶段只做一次 `Float32Array` 拷贝与一次包围盒遍历；不逐三角形分配对象。

## 6. 已知限制与风险

1. **PLY 只支持 `binary_little_endian` 和 `ascii`**；大端 PLY 返回可读错误。点云（无 face element）不支持预览，返回错误。
2. **OBJ 只取几何**：忽略材质（mtllib/usemtl）、贴图、曲线/曲面；法线/纹理坐标被解析但不参与渲染；渲染用平面着色（flat shading），不输出平滑法线。
3. **渲染是软件 painter 算法**：没有逐像素 Z-buffer。默认开启背面剔除（假设 CCW 为正面）；法线/绕序不一致的模型（部分 OBJ/扫描数据）可能被剔除掉部分面，可在 `options.cull=false` 关闭（代价是排序误差更明显）。同一深度切片内的遮挡顺序是近似的（见第 5 节）。
4. **无真实光照阴影/环境光遮蔽**：只有单方向光 + 环境光，视觉上偏"产品预览"而非写实渲染。
5. **交互仅鼠标/触控板语义**：拖拽旋转、滚轮缩放、Shift/右键/中键拖拽平移、双击复位。未做双指缩放/惯性/键盘操作；移动端触摸可用单指旋转但未专门优化。
6. **canvas 尺寸为 0（侧栏未布局/隐藏）时跳过绘制**，等 ResizeObserver 触发的下一帧；Node 测试里 `renderNow()` 会返回 false。
7. **三角形上限是软降级**：确实存在"抽样后模型看起来有空洞"的可能（密集网格抽样视觉上仍可辨识）；`renderBudget` 未单独设上限，降级后最多画 `maxTriangles` 个三角形。
8. **测试是 Node 内 mock canvas**：没有真实像素断言，只验证渲染循环不抛错、调用次数、状态与纯函数数值；真实浏览器视觉仍需在 GUI 里点开文件人工确认。
9. `src/model/package.json` 仅为 Node 测试加 `"type":"module"`；若 lead 的拼接脚本遍历目录，请只处理 6 个 `.js` 源文件，忽略该 package.json 与 `tests/`。
10. 后续可扩展：3MF（zip 容器，需 archive 模块）、GLB（二进制 JSON+buffer）、PLY 大端、点云（用点精灵）、OBJ 平滑法线/材质。

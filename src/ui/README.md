# `src/ui` — 浏览器端预览正文（dsh-preview-extra）

本目录实现右侧栏「文档预览」标签页里的 5 类自定义正文：3D 模型、压缩包、媒体、字体、字幕。
它们被 `src/client/main.js` 注册进 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`
提供的 `ctx.documentPreviews` 与 keyed 子 slot `sidebar.right.tab.document`。

| 文件 | 作用 |
|---|---|
| `views.js` | **唯一交付的运行时模块**。单文件、ESM 具名导出、无 JSX、无 default export；由 `scripts/build-client.mjs` 内联进 `lib/client.js` 的 factory 作用域。 |
| `smoke.mjs` | 开发期冒烟测试（假 React 运行时 + 真实 model/archive fixture），不属于运行时依赖，不会被 build 打包。 |

## 导出清单

| 导出 | 说明 |
|---|---|
| `previewLocales` | `{ zh, en }` 两套同 key 文案（95 个 key），注册到 locale 命名空间 `dshPreviewExtra`。 |
| `previewDefinitions` | 5 条预览定义：`{ id, titleKey, extensions, binaryExtensions?, loading:'bytes-complete', wrap:false }`。 |
| `previewCss` | 一段注入 `<style>` 的 CSS 字符串，类前缀 `dshpx-`，颜色走 `currentColor` / `color-mix`，适配明暗主题。 |
| `PREVIEW_IDS` | `{ model, archive, media, font, subtitle }` 的渲染器 id，避免与 client.js 里的字符串漂移。 |
| `previewBodies` | `id → 组件` 映射（等价于下面的 5 个组件，便于注册时按 id 查表）。 |
| `ModelPreviewBody` / `ArchivePreviewBody` / `MediaPreviewBody` / `FontPreviewBody` / `SubtitlePreviewBody` | 5 个 React 函数组件。 |
| `previewNamespace` | `'dshPreviewExtra'`。 |

### 平台自由变量

`react`、`jsxRuntime`、`primitives` 由 bundle factory（`scripts/build-client.mjs`）声明，
`views.js` **不 import 也不重新声明**它们；只 import 本包相对路径的
`../model/detect3d.js`、`../model/renderer.js`、`../archive/index.js`。
组件一律用 `react.createElement`（无 JSX）书写；`primitives.Button` 优先，
缺失时退回内置 `.dshpx-btn` 样式。

### 正文契约

所有预览的 `loading` 都是 `'bytes-complete'`，因此正文收到：

```js
props = {
  content: { kind: 'bytes', data: Uint8Array }, // 完整文件字节（Host 上限默认 32 MiB）
  resourceAddress, wrap, scrollportRef, addResource, setResources, useTabInfo, t,
}
```

根节点统一为 `height:100%; minHeight:0; display:flex; flexDirection:column`，
内部滚动区域自己管理；有内部滚动区时把 `props.scrollportRef` 挂在滚动元素上（目前 archive 详情、
font 样张、subtitle 列表/原文）。文件名优先取 `useTabInfo().tab.title`，否则解析
`resourceAddress` 的 basename。

## 定义与覆盖的扩展名

| id | 扩展名 | binaryExtensions | 说明 |
|---|---|---|---|
| `dsh-preview-extra/model` | stl, obj, ply | stl, ply | ASCII OBJ 保留「纯文本」候选 |
| `dsh-preview-extra/archive` | zip, jar, war, apk, tar, gz, tgz, bz2, xz, zst, 7z, rar | 全部 | 7z/rar/xz/bz2/zst 只显示可读「暂不支持」提示 |
| `dsh-preview-extra/media` | mp3, wav, ogg, oga, m4a, aac, flac, opus, mp4, webm, m4v, mov, mkv | 全部 | 浏览器原生解码器播放 |
| `dsh-preview-extra/font` | ttf, otf, woff, woff2 | 全部 | 用 FontFace 加载并渲染样张 |
| `dsh-preview-extra/subtitle` | srt, vtt, ass, ssa | — | 纯文本，保留「纯文本」候选 |

## 各正文行为

### `ModelPreviewBody`（STL / OBJ / PLY）

- `effect` 中 `setTimeout → parseModel(fileName, data)`，再经 `buildScene` 校验并归一成
  renderer 的 `{ format, positions, triangleCount, vertexCount, bounds, warnings }`。
- 成功后渲染 `<canvas>`，`createModelView({ canvas, model, options:{ onNotice } })`：
  拖拽旋转、滚轮缩放、右键/Shift 拖拽平移、双击重置（由 renderer 提供）。
- content 变化不重建视图，走 `view.setModel(model) + resetView()`；卸载时 `view.destroy()`。
- 工具栏：格式 / 三角形数 / 顶点数 / 包围盒尺寸；线框开关（`view.setWireframe`）、重置视角。
- 解析中 / 解析失败 / 文件为空都显示可读面板（含文件名与错误原因），不会白屏。
- 软上限 64 MiB；超过 20 万三角形提示可能变慢；renderer 自身在 >30 万三角形时抽样降级。

### `ArchivePreviewBody`（zip / tar / gz…）

- `listArchive(data, { filename })` 异步列举（带 cancelled 竞态保护）。
- `buildTree` + 可折叠目录树（顶层目录默认展开，单链根目录自动展开几层），
  行显示名称 / 大小 / 修改时间 / 压缩方法；>2000 条只渲染前 2000 条并提示。
- 点击文件条目 → `readEntry(data, entry)`：
  - `textualHint === 'text'`：最多 200KB、最多 8000 行，等宽 `pre` + 行号 gutter；
    解码用 `decodeTextBytes`（BOM/UTF-8/GBK），失败回退 `utf8OrLatin1`，显示编码。
  - `image`：Blob URL `<img>`，卸载/切换时 `URL.revokeObjectURL`。
  - `binary`：显示大小、MIME、提示「二进制条目，暂不支持内嵌预览」。
  - 加密条目：直接显示「已加密，无法预览」错误。
- `truncated` / `notes` / `hint` 以警告条显示；解析失败、`supported:false`（7z/rar/xz/bz2 等）
  显示提示面板；空压缩包显示空态。
- 归档读取器自身上限：5000 条目、单条目 32MB、累计解压 128MB；超限返回 truncated/notes。

### `MediaPreviewBody`（音频 / 视频）

- 按扩展名判断 audio / video 并给出近似 MIME；`URL.createObjectURL(new Blob([data], { type }))`。
- `<audio controls>` / `<video controls>` 撑满宽度（video `contain`），`preload='metadata'`。
- `onError` 显示「浏览器不支持该编码」+ 文件名/MIME/大小/编码建议；卸载与换文件时 revoke。
- 顶部显示文件名、大小、MIME；并提示播放由浏览器原生解码器负责（MKV/MOV/FLAC 视浏览器而定）。

### `FontPreviewBody`（TTF / OTF / WOFF / WOFF2）

- 按魔数识别格式：`00010000`/`true` → TTF、`OTTO` → OTF、`wOFF` → WOFF、`wOF2` → WOFF2、
  `ttcf` → TTC（可能加载失败，会显示错误）；扩展名与内容不一致时显示提示。
- `new FontFace('DshPreviewFont<seq>_<rand>', exactArrayBuffer(data))` → `load()` →
  `document.fonts.add()`；卸载/换文件时 `document.fonts.delete(face)`。
- 样张：文件名大字号 + 中英文 pangram + ASCII 字母表 + 数字/符号 + 12–48px 字号阶梯。
  未命中的字形会回退系统字体（CJK 需要字体本身含 CJK）。
- 环境无 `FontFace`/`document.fonts` 或字体损坏时显示错误面板。

### `SubtitlePreviewBody`（SRT / VTT / ASS / SSA）

- `decodeTextBytes`（BOM/UTF-8/GBK，最多 1MB）后按内容嗅探格式（`WEBVTT` / `[Script Info]` /
  `[Events]` / `-->`），再按扩展名兜底。
- 解析器：SRT/VTT 共用块解析（跳过 WEBVTT/NOTE/STYLE/REGION，去掉 HTML 标签）；
  ASS/SSA 解析 `[Events]` 的 `Format:` 与 `Dialogue:`（`\N` 换行、`{...}` 覆盖标签、Text 内含逗号）。
- 列表显示 序号 / 起止时间 / 文本，最多 3000 条并提示；可切换到「原始文本」。
- 顶部显示格式、条数、编码、总时长；无法解析的块以警告条计数；空结果显示空态与提示。

## 错误与健壮性

- 所有异步解析都有 `cancelled` 标志：卸载/切换 content 后不再 `setState`。
- Blob URL / FontFace / 3D view 都在 effect cleanup 中释放。
- 解析错误、读取错误、加密、格式不支持、环境不支持（无 Blob/URL/FontFace）都渲染
  `StatePanel` 可读面板（中文 + 英文混合），不会白屏。
- 大文件：3D 64MiB 软上限；归档文本 200KB；字幕 1MB；条目 2000 行；字幕条目 3000 条。
- 不支持默认导出；无 JSX；顶层不读取 DOM（只在 effect 内注入样式）。

## 已知限制

- `bytes-complete` 受 Host `maxFileBytes`（默认 32 MiB）限制，超限时正文根本不会挂载，
  由共享外壳显示「文件过大」；更大的文件需要改成 `renderer` 模式自行分窗读取。
- 归档：7z / RAR / xz / bzip2 / zstd 无法在纯 Web 环境解压，注册它们只是为了让内置预览
  不再把这些后缀当文本；实际显示「暂不支持」提示。嵌套归档、符号链接/稀疏文件不展开。
- 媒体：编解码完全取决于浏览器。Chromium/WebView2 通常能播 MP3/WAV/OGG/FLAC/MP4(H.264)/WebM，
  MKV、MOV、m4v、AAC 裸流、部分 FLAC/Opus 可能失败（会显示错误面板）。
- 字体：不做字体解析（不读取 name 表/字形表），没有可变字体轴、字重、字形表视图；
  TTC 集合与损坏字体由 FontFace 报错；样张中缺失字形按浏览器规则回退。
- 3D：软件 Canvas2D 渲染（无 WebGL），大模型会抽稀；视口保持深色背景（含网格），不随主题反转；
  暂不注册 3MF/GLB/glTF/FBX 等格式。
- 字幕：只做纯文本时间轴展示，不还原 ASS 定位/颜色/卡拉 OK 效果、不渲染 VTT 区域与样式；
  超长文件只解析前 1MB。
- 主题：颜色基于 `currentColor` 与 `color-mix()`（需要 Chromium/WebView2 支持），
  个别固定色（错误红、警告橙、3D 画布/视频黑底）不随主题变化。
- `wrap` prop 对 canvas/媒体/字体等正文无意义（定义里 `wrap:false`，不显示换行开关）。

## 验证

```powershell
# 语法
node --check src/ui/views.js

# 冒烟：假 React 运行时渲染 5 个 body，断言导出、locale key 对齐、
# 扩展名覆盖、tr key 存在，以及 model/archive(text/image/encrypted/unsupported/empty)/
# media/font/subtitle(srt/vtt/ass) 的主要状态
node src/ui/smoke.mjs

# 集成：views.js 能通过 scripts/build-client.mjs 组装进 lib/client.js（无 ESM 残留）
node scripts/build-client.mjs
```

当前结果：`node --check` 通过；`smoke.mjs` 输出
`smoke ok: exports, locales (95 keys), definitions, tr keys (70)` 及 5 类正文状态通过；
用 build 脚本的临时副本验证过 views.js 被正确转换（15 modules、生成物 `node --check` 通过）。

# dsh-preview-extra

给 DeepSeek Harness（DSH）右侧栏的**文档预览**加更多文件格式：3D 模型、压缩包、音视频、字体、字幕。
纯客户端插件，不改宿主、不联网、无第三方依赖；所有预览都注册进内置的
`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 文档 tab，因此和内置的
Markdown / 代码 / 图片 / PDF / Office 预览共享同一套打开方式、路径头、刷新与"打开方式"菜单。

> 说明：`.cpp` / `.h` / `.hpp` / `.cc` / `.cxx` / `.hxx` 等 C/C++ 文件**内置代码预览本来就支持**
> （语法高亮来自 `@deepseek-ai/dsh-util-code-language` 的语言表），本插件没有重复注册它们。
> 内置已覆盖的还有 make/cmake、Rust、Go、Java、Python 等几十种代码后缀。

## 新增支持的格式

| 类别 | 后缀 | 预览内容 |
| --- | --- | --- |
| 3D 模型 | `stl`（ASCII/二进制）、`obj`、`ply`（ASCII / binary_little_endian） | Canvas2D 软件渲染：拖拽旋转、滚轮缩放、右键/Shift 平移、双击复位、线框开关、包围盒/三角形/顶点统计；>30 万三角形自动抽样降级 |
| 压缩包 | `zip`、`jar`、`war`、`apk`、`tar`、`gz`、`tgz`、`tar.gz` | 条目树（名称/大小/时间/方法），点击条目查看文本（带行号，最多 200KB）、图片、或二进制说明；GBK 文件名兜底；防 zip bomb 限额 |
| 压缩包（仅识别） | `7z`、`rar`、`xz`、`bz2`、`zst` | 显示格式与"请先解压为 zip/tar"的提示（浏览器端没有对应解压 API） |
| 音频 | `mp3`、`wav`、`ogg`、`oga`、`m4a`、`aac`、`flac`、`opus` | 原生 `<audio>` 播放器；显示大小/MIME |
| 视频 | `mp4`、`webm`、`m4v`、`mov`、`mkv` | 原生 `<video>` 播放器；显示大小/MIME |
| 字体 | `ttf`、`otf`、`woff`、`woff2` | FontFace 加载后的样张：中英文 pangram、大小写字母表、标点、字号阶梯 |
| 字幕 | `srt`、`vtt`、`ass`、`ssa` | 时间轴字幕列表（起止时间 + 文本）、条数/编码/总时长，可切换原始文本 |

打开方式：右侧栏「文件」tab 里点任意文件；聊天里的文件卡片、交付物卡片也会走同一预览。

## 安装

插件已经从本仓库安装进当前 `desktop` profile（`~/.dsh/profiles/desktop`），**无需重启**：
profile 的 `cordis.patch.yml` 被热重载，`dsh-client-hmr` 会把新的客户端 bundle 推给已打开的页面。
如果界面没变化，按 F5 刷新页面即可。

给其它 profile 安装（例如 `web`）：

```powershell
# 1. 构建（只有改了 src 才需要）
& 'C:\Program Files\nodejs\node.exe' .\pkg\scripts\build-client.mjs

# 2. 拷进 profile 的 node_modules 并挂载 patch 行（幂等）
& 'C:\Program Files\nodejs\node.exe' .\scripts\install.mjs --profile-dir "$env:USERPROFILE\.dsh\profiles\web"
```

安装脚本做的事：
1. 把 `pkg/`（package.json + lib + cordis.patch.yml + README）复制到 `<profile>/node_modules/dsh-preview-extra`；
2. 在 `<profile>/cordis.patch.yml` 末尾追加一行 `- insert: - id: dsh-preview-extra / name: 'dsh-preview-extra'`。

## 卸载 / 回滚

```powershell
& 'C:\Program Files\nodejs\node.exe' .\scripts\install.mjs --profile-dir "$env:USERPROFILE\.dsh\profiles\desktop" --uninstall
```

当前 `desktop` profile 的原始 patch 已备份为
`C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml.bak-before-preview-extra`；
如需彻底还原：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-before-preview-extra" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-preview-extra" -Recurse -Force
```

## 限制

- **完整字节加载**：这些预览走 `loading: 'bytes-complete'`，受 DSH 宿主 `maxFileBytes` 32 MiB 限制；更大的文件会走内置的"无法预览 / 本地打开"空态。
- 压缩包内部限额：5000 条目 / 单条目 32 MB / 累计 128 MB；条目列表最多渲染 2000 行，条目文本最多 200 KB。
- `7z` / `rar` / `xz` / `bz2` / `zst` 只识别与提示，不解压（浏览器端没有这些解压 API）。
- 音视频编解码能力取决于浏览器（Chrome/Edge 支持最好；MKV/MOV 视封装与编码而定）。
- 3D 为 Canvas2D 软件渲染（无 WebGL 依赖）：三角形超过 30 万时抽样并关闭线框；PLY 只支持 `binary_little_endian`；不支持 3MF/GLB/FBX/STEP。
- 字幕只按文本时间轴显示：ASS/SSA 的样式、定位、特效忽略；解码上限 1 MB / 3000 条。
- 字体预览不解析字形表（不显示字体内部名称/字符覆盖率）；TTC 集合可能加载失败。
- 内置已支持的格式（Markdown、代码含 C/C++、图片、PDF、Office、Excel）不会被本插件重复注册。

## 开发

```
pkg/
  package.json            # dsh.client 声明：platform=web、exports["./client"]、inject 提示
  cordis.patch.yml        # 走 `dsh plugin add` 渠道时自动挂载的行（手动安装可忽略）
  lib/index.js            # 宿主半侧：no-op cordis 插件（配置/服务都在浏览器侧）
  lib/client.js           # 构建产物（不要手改）
  scripts/build-client.mjs# 手写"打包器"：把 src/** 的 ESM 拼成 __ModuleLoader__.load 的 factory
  src/client/main.js      # 浏览器入口：注册 5 个 preview + keyed body + locale + 样式
  src/ui/views.js         # 5 个预览组件 + 中英文案 + CSS + previewDefinitions
  src/model/              # STL/OBJ/PLY 解析 + Canvas2D 软件渲染器（纯 ESM，无 DOM 顶层依赖）
  src/archive/            # zip/tar/gzip 解析 + 魔数识别 + 限额（纯 ESM，无 Node API）
scripts/install.mjs       # 安装/卸载
tools/smoke.mjs           # 无浏览器冒烟：假 window/React/Cordis ctx，渲染全部 body
tools/cdp.mjs             # 无头 Chrome CDP 驱动（E2E 验证用）
notes/                    # 逆向出的 DSH 客户端插件契约与 documentpreview 扩展契约
```

常用命令：

```powershell
& 'C:\Program Files\nodejs\node.exe' .\pkg\scripts\build-client.mjs         # 构建 lib/client.js
& 'C:\Program Files\nodejs\node.exe' .\pkg\src\model\tests\run.js           # 38 项 3D 测试
& 'C:\Program Files\nodejs\node.exe' .\pkg\src\archive\tests\run-tests.mjs  # 28 项压缩包测试
& 'C:\Program Files\nodejs\node.exe' .\pkg\src\ui\smoke.mjs                 # UI 冒烟（假 React）
& 'C:\Program Files\nodejs\node.exe' .\tools\smoke.mjs                      # 组装后的 bundle 冒烟
& 'C:\Program Files\nodejs\node.exe' .\skeleton\verify.mjs .\pkg            # 契约静态校验 34/34
```

## 实现要点

- 浏览器 bundle 是**手写的 classic script**：`window.__ModuleLoader__.load({ id, factory })`，
  `id` 必须等于包名；`factory(require)` 里只 `require` 平台冻结表（react / react-dom /
  `@deepseek-ai/dsh-client-ui-primitives` 等 9 个 key），不引入任何动态包。
- 硬依赖只有 `slots` 服务；`documentPreviews` 与 `locale` 用 `ctx.inject([...])` 软等待——
  这样即使内置文档预览被禁用，本插件也只是休眠，不会把整页启动拖垮（DSH 页面 boot 是"全有或全无"）。
- 每个格式族的注册都是两处：`ctx.documentPreviews.register({ id, extensions, binaryExtensions,
  priority, title, loading, wrap })` + `ctx.slots.register("sidebar.right.tab.document", { key: id })`，
  两处都用同一个 id，且都包在 `ctx.effect` 里以便 HMR 回收。
- 全部解析器都是纯 JS / Web 标准 API（`DecompressionStream`、`TextDecoder`、`FontFace`、Blob URL），
  没有 Node 内置模块，也没有第三方依赖。

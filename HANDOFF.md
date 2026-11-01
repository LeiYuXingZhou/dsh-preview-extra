# HANDOFF — dsh-preview-extra

> 交接文档：给接手的 AI/开发者（如 Cursor）快速上手。先读本文件，再按需读
> [`notes/module-contract.md`](notes/module-contract.md)（DSH 客户端插件契约逆向）和
> [`notes/preview-api.md`](notes/preview-api.md)（documentpreview 扩展契约逆向）。
> 最后更新：2026-11-02，对应 commit `309df06`（仓库根目录即插件包）。

## 0. 一句话

给 **DeepSeek Harness 0.2.0-rc.2** 的右侧栏「文档预览」增加 5 类格式：
**3D 模型（STL/OBJ/PLY）**、**压缩包（zip/tar/gz，7z/rar/xz/bz2/zst 仅识别提示）**、
**音视频**、**字体**、**字幕**。纯客户端 cordis 插件，零第三方依赖、无网络请求，
已安装进本机 `desktop` profile 并完成真实 GUI E2E 验证。

- GitHub（公开）：<https://github.com/LeiYuXingZhou/dsh-preview-extra>
- 本地开发目录：`C:\Users\Administrator\Documents\daily\dsh-preview-extra`
- 安装进 DSH 的方式：**仓库根目录就是包**，DSH「设置 → 插件 → 添加插件」支持
  GitHub 地址 / 本地目录绝对路径 / npm 包名；包内 `cordis.patch.yml`（`dsh.bundle.patch`）
  会在安装时自动挂载 Loader 行。

## 1. 当前状态

| 项 | 状态 |
| --- | --- |
| 仓库 | public，`main` 分支，根目录即插件包（`package.json`/`lib`/`src`/`cordis.patch.yml` 在根） |
| 构建 | `node scripts/build-client.mjs` → `lib/client.js`（约 230 KiB，15 个内部模块，单文件） |
| 契约校验 | `node skeleton/verify.mjs .` → **34/34** |
| Bundle 冒烟 | `node tools/smoke.mjs` → 5 个 body 用真实 fixture 渲染，全过 |
| 3D 单测 | `node src/model/tests/run.js` → **38/38** |
| 压缩包单测 | `node src/archive/tests/run-tests.mjs` → 28/28 |
| UI 冒烟 | `node src/ui/smoke.mjs`（假 React）全过 |
| 真实 GUI E2E | 无头 Chrome + CDP 验证过 STL/ZIP/字体/WAV/SRT/7z，截图在 `shots/` |
| 本机 desktop profile | 目前是**手动挂载**（脚本复制包 + patch 行）；若改走 DSH GUI 安装需先卸载手动挂载，否则重复挂载会报错 |

## 2. 架构（DSH 0.2.0-rc.2 插件契约）

### 2.1 包结构（仓库根）

```
package.json          # name=dsh-preview-extra；type=module；main=lib/index.js；
                      # exports: "."→lib/index.js, "./client"→lib/client.js
                      # dsh.client: { platform:"web", inject:[...] }   ← 只影响加载顺序提示
                      # dsh.bundle: { patch:"./cordis.patch.yml" }    ← 安装时自动挂载
cordis.patch.yml      # - insert: [{ id: dsh-preview-extra, name: dsh-preview-extra }]
lib/index.js          # 宿主半侧：no-op cordis 插件（export function apply() {}）
lib/client.js         # 构建产物（不要手改；由 scripts/build-client.mjs 生成）
src/client/main.js    # 浏览器入口
src/ui/views.js       # 5 个预览组件 + 中英文案 + CSS + previewDefinitions
src/model/*           # STL/OBJ/PLY 解析 + Canvas2D 软件渲染器（纯 ESM）
src/archive/*         # zip/tar/gzip 解析 + 魔数识别 + 限额（纯 ESM）
scripts/build-client.mjs  # 手写"打包器"：src 的 ESM 拼成 __ModuleLoader__.load 的 factory
scripts/install.mjs       # 手动安装/卸载到任意 profile（复制包 + 追加 patch 行）
tools/smoke.mjs       # 无浏览器冒烟（vm + 假 window/React/Cordis ctx）
tools/cdp.mjs         # 无头 Chrome CDP 驱动（导航/求值/截图）
tools/probe-bundle.mjs# 用 mtime/ctime/size 复算 revision，探测某 DSH 实例是否已提供本包 bundle
tools/fixtures-gen.mjs# 生成 E2E 样例文件（STL/OBJ/PLY/ZIP/TAR/GZ/WAV/SRT…）
notes/                # 两份逆向契约文档（重要）
skeleton/             # 手写客户端插件最小骨架 + verify.mjs 契约校验器
shots/                # E2E 截图
```

### 2.2 浏览器 bundle 契约（关键，改之前必读）

`lib/client.js` 是**经典脚本**（不是 ESM）：

```js
window.__ModuleLoader__.load({
  id: "dsh-preview-extra",              // 必须 === package.json name
  factory: (require) => {
    var module = { exports: {} }, exports = module.exports;
    // 平台冻结表里只有 9 个 key 可同步 require：
    // react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis,
    // @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
    // @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
    exports.apply = apply;
    exports.inject = ["slots"];         // 这里是 cordis SERVICE 名，不是包名
    return module.exports;
  }
});
```

- 执行 bundle 只注册 factory；真正的模块体在插件 fiber 物化时才跑。
- 单个自包含文件即可，不需要 `require.async` chunk。
- **构建脚本不能打包第三方 npm 依赖**：`src/**` 里只允许相对路径 import 本地 ESM
  和平台表里的 `require`。要引入外部库（如 three.js、7z wasm）必须先换构建方案
  （esbuild/rolldown）或把源码内联进来。

### 2.3 注册一个预览类型（两处，同一 id，都要放在 ctx.effect 里）

```js
ctx.documentPreviews.register({
  id: "dsh-preview-extra/model",
  extensions: ["stl", "obj", "ply"],
  binaryExtensions: ["stl", "ply"],   // 必须是 extensions 子集；声明后该后缀失去"纯文本"候选
  priority: "extension",              // 只有 "builtin" 会被降档；"fallback" 实际等同 "extension"
  title: () => t("title.model"),
  loading: "bytes-complete",          // 三种：text-pages / bytes-complete / renderer
  wrap: false
});
ctx.slots.inject("sidebar.right.tab.document", () =>
  ctx.slots.register({ name: "sidebar.right.tab.document", key: definition.id, locale: NS }, Body)
);
```

正文组件拿到的 props：

```
{ content: { kind: "bytes", data: Uint8Array },   // bytes-complete 模式
  resourceAddress: "dsh-resource://file/<session>/<path>",
  wrap, scrollportRef, addResource, setResources,
  useTabInfo(),                                     // tab: id/title/contentId/signal/navigation
  t }                                               // 注册时传 locale 才会有
```

- 不要注册 `sidebar.right.pane.tab.title`（那是 tab 类型 id，不是渲染器 id）。
- 不需要 host 路由、不需要 Remote、不需要改文件分类表；`zip` 等后缀即使在内置
  「不支持预览」静态表里，只要有实现匹配就会自动接管。
- 宿主上限：`maxFileBytes` **32 MiB**（完整字节，超了正文不挂载，走内置空态）；
  `text-pages` 单页/窗口 2 MiB、5000 行。
- UI 里没有“下载/提取”按钮；压缩包内条目只能预览。

### 2.4 客户端插件生命周期 / 热更新

- `exports.inject = ["slots"]` 是硬依赖；`documentPreviews` 和 `locale` 用
  `ctx.inject([...], child => { ... })` **软等待**。原因：DSH 页面 boot 是“全有或全无”，
  硬注入缺失服务会让 fiber 永远 PENDING → 整页 “Failed to load plugins”。
- `apply` 外层做了 try/catch，保证注册失败不会拖垮整页。
- 热更新矩阵：
  - 改 profile 的 `cordis.patch.yml`（增删行）→ 2-3 秒配置 HMR 生效，无需刷新
  - 改 `lib/client.js`（含 `node scripts/build-client.mjs` 重建）→ client-hmr 每 500ms
    stat 一次，自动热替换
  - 改 `package.json` / `lib/index.js`（宿主半侧）→ **必须重启 DSH**（pkgMeta 缓存）
  - 同一个包被两个来源挂载会报 `resolves from multiple active Loader sources`，
    整个客户端图组不出来 —— 切换安装方式前务必先卸载旧挂载。

## 3. 本地开发 / 测试命令

```powershell
$node = 'C:\Program Files\nodejs\node.exe'
cd C:\Users\Administrator\Documents\daily\dsh-preview-extra

# 构建（改 src 后）
& $node .\scripts\build-client.mjs
# 契约校验（34/34）
& $node .\skeleton\verify.mjs .
# bundle 冒烟（无浏览器，假 React + 假 Cordis ctx）
& $node .\tools\smoke.mjs
# 解析器单测
& $node .\src\model\tests\run.js              # 38/38
& $node .\src\archive\tests\run-tests.mjs     # 28/28
# UI 冒烟（假 React）
& $node .\src\ui\smoke.mjs
# 生成 E2E 样例（会从系统字体目录拷贝一个 ttf；产物已被 .gitignore 排除）
& $node .\tools\fixtures-gen.mjs _fixtures
```

### 3.1 无浏览器冒烟做了什么

`tools/smoke.mjs` 用 Node `vm` 执行真实 `lib/client.js`，提供假
`window.__ModuleLoader__`、假 React 渲染器（够跑一轮 render + effect）、假 primitives、
假 Cordis ctx（记录 `documentPreviews.register` / `slots.register`），然后用 `_fixtures/`
里的真实文件字节渲染 5 个 body。**改完 bundle 先跑它**，比开浏览器快得多。

### 3.2 真实 GUI E2E（本机）

```powershell
# 1) 起一个隔离 DSH 实例（独立 DSH_HOME，端口 1891，不会碰你的正式 profile）
$env:DSH_HOME = 'C:\Users\Administrator\Documents\daily\_dsh_test'
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\Administrator\.dsh\acl-runner\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile test --no-open --port 1891
# 终端会打印 http://127.0.0.1:1891/?token=...

# 2) 无头 Chrome（需要先启动；CDP 端口 9333）
#    本机 Chrome: C:\Program Files\Google\Chrome\Application\chrome.exe
#    --headless=new --no-sandbox --remote-debugging-port=9333 --user-data-dir=<workspace>/_chrome_profile

# 3) CDP 驱动
& $node .\tools\cdp.mjs new "http://127.0.0.1:1891/?token=..."
& $node .\tools\cdp.mjs eval "document.body.innerText.slice(0,500)"
& $node .\tools\cdp.mjs shot .\shots\screen.png
```

注意：
- `_dsh_test/profiles/test/cordis.patch.yml` 里除了本插件的 insert 行，还有一行把
  `directory-picker` 换成 `@deepseek-ai/dsh-host-directory-picker-browse`（无头环境没有
  OS 目录选择器）。
- 该测试 profile 的默认工作区是 `C:\Users\Administrator\Documents\deepseek-harness\default-workspace`，
  测试文件放在它的 `_fixtures/` 下即可在「文件」tab 里点到。
- 本机直连 `github.com:443` 不通，需要代理：`git config --global http.proxy http://127.0.0.1:7877`
  （已设置；取消：`git config --global --unset http.proxy`）。

## 4. 安装 / 卸载

### 4.1 DSH GUI（推荐给最终用户）

设置 → 插件 → **添加插件**，粘贴 GitHub 地址或本地目录绝对路径：

```
https://github.com/LeiYuXingZhou/dsh-preview-extra
```

或

```
C:\Users\Administrator\Documents\daily\dsh-preview-extra
```

包内 `cordis.patch.yml` 会自动挂载，刷新页面生效。

### 4.2 手动脚本（当前 desktop profile 用的方式）

```powershell
& $node .\scripts\install.mjs --profile-dir "$env:USERPROFILE\.dsh\profiles\desktop"
& $node .\scripts\install.mjs --profile-dir "$env:USERPROFILE\.dsh\profiles\desktop" --uninstall
```

脚本做两件事：把包复制到 `<profile>/node_modules/dsh-preview-extra`；在
`<profile>/cordis.patch.yml` 末尾追加/移除 insert 行。
原始 patch 备份：`~/.dsh/profiles/desktop/cordis.patch.yml.bak-before-preview-extra`。

⚠️ 两种安装方式**不要同时用**（会重复挂载）。

## 5. 已知限制 / 已知问题

- 完整字节加载 32 MiB 上限；超出走内置“无法预览/本地打开”。
- 压缩包：5000 条目 / 单条目 32 MiB / 累计 128 MiB；列表最多渲染 2000 行，文本条目 200 KB。
- 7z / rar / xz / bz2 / zst：只识别 + 提示，不解压（浏览器无原生 API）。
- 加密 ZIP 条目显示错误；分卷 ZIP 未处理。
- 音视频编解码取决于浏览器；MKV/MOV 视封装与编码而定。
- 3D：Canvas2D 软件渲染（无 WebGL）；>30 万三角形抽样降级；PLY 仅 little-endian；
  不支持 3MF / GLB / GLTF / FBX / DAE / STEP。
- 字幕：ASS/SSA 样式、定位、特效忽略；1 MB / 3000 条上限。
- 字体：不解析 name 表，不显示字体内部名/字符覆盖；TTC 可能加载失败。
- `wrap` 对所有类型都是 false（正文自己管滚动）。
- 仓库 description / topics 尚未设置：token 只有 Contents 读写，没有 Metadata/Administration
  写权限，`PATCH /repos/...` 返回 403。需要在 GitHub 页面手动设置，或换 token 后再补。

## 6. 待办 / 可以继续做的方向（按价值排序）

1. **验证 GUI 安装路径**：先 `--uninstall` 手动挂载，再用「添加插件」GitHub URL 安装，
   确认 `dsh.bundle.patch` 自动挂载与后续升级流程；把步骤写回 README。
2. **补齐 3D 格式**：3MF（zip + XML，可复用 `src/archive/zip.js` 的思路）、GLB/GLTF（JSON +
   二进制 chunk）、可选 FBX/DAE。注意 3MF/GLB 需要改 `detect3d.js` 与 UI 的 mime/统计。
3. **压缩包增强**：7z/rar 解压（需引入 wasm，如 libarchive.js，但当前构建器不能打包依赖，
   要先升级构建方案）；zip 内图片/文本的“另存/复制”；分卷与加密更友好提示。
4. **新格式**：`.epub`（zip+XHTML 目录）、`.eml`（邮件头+正文）、`.sqlite`（表结构预览）、
   `.psd`（缩略图）、未知二进制的 hex 查看器、`.woff2` 的字体名解析。
5. **测试/CI**：把 `tools/smoke.mjs` + 解析器单测接进 GitHub Actions（Windows runner），
   加一个 `shot` 回归；把 E2E 的 CDP 脚本参数化。
6. **发布 npm 包**：让「添加插件」支持包名安装（需要 npm 账号 + token，
   `cnpm/npmmirror` 同步延迟即常见“冷静期”说的来源）。
7. **仓库元数据**：设置 description / topics（见 §5 最后一条）；给 package.json 加
   `repository` 已做，可补 `bugs`/`homepage`（已有）。

## 7. 交接注意事项（给接手的 AI/开发者）

- **改代码只改 `src/`**，然后 `node scripts/build-client.mjs` 生成 `lib/client.js`；
  `lib/client.js` 不要手改（它由拼接脚本生成，含 `window.__ModuleLoader__.load` 包装）。
- 构建器很严格：只支持**具名导出 + 相对路径 import**；不允许 `export default`、JSX、
  裸包 import。UI 里用 factory 提供的自由变量 `react` / `jsxRuntime` / `primitives`。
- 新增预览类型 = `src/ui/views.js` 里加一个 body 组件 + 一条 `previewDefinitions` 项，
  在 `src/client/main.js` 的 `BODY_BY_ID` 里登记 id；`id` 必须三处一致
  （documentPreviews id / slots key / BODY_BY_ID key）。
- 不要提交 `_fixtures/`、`_dsh_test/`、`shots` 之外的临时文件；`.gitignore` 已覆盖。
- 不要把 GitHub token 写进 `.git/config` 的 remote URL（本仓库曾用一次性 URL 推送）；
  本机推送需要代理，见 §3.2。
- 如果 DSH 版本升级（现在是 `0.2.0-rc.2`），先重跑 `skeleton/verify.mjs`，再核对
  `notes/module-contract.md` 里的接口是否变化；documentpreview 的 `ctx.documentPreviews`
  与 `loading` 语义是逆向出来的，升级后可能变。
- 安全：会话日志里出现过一次 PAT（推送时），**建议轮换**该 fine-grained token 并更新
  `~/.dsh/.env` 的 `GITHUB_PAT=`；仓库内容本身已做隐私清理（无密钥/会话/本机路径）。

## 8. 相关文档

- [`notes/module-contract.md`](notes/module-contract.md)：DSH 客户端插件加载契约（bundle 格式、
  平台 seed 表、`/plugins` 路由、HMR、踩坑清单，全部带 file:line）
- [`notes/preview-api.md`](notes/preview-api.md)：documentpreview 扩展契约（注册字段、
  `content` 三态、props、上限、空态）
- [`skeleton/README.md`](skeleton/README.md)：最小客户端插件骨架 + 校验器用法
- [`src/model/REPORT.md`](src/model/REPORT.md) / [`src/archive/REPORT.md`](src/archive/REPORT.md) /
  [`src/ui/README.md`](src/ui/README.md)：各模块接口、测试与限制

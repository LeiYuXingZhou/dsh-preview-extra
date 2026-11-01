# DSH 客户端插件加载契约（手写 bundle / 无构建工具）

> 溯源对象：本机安装的 DSH **0.2.0-rc.2**（Node v24.15.0，Windows），运行中的 profile 为
> **desktop**。所有结论都来自磁盘上的已发布产物或源码，行号对应当前安装版本。
>
> 路径缩写（下文所有 `path:line` 的根）：
>
> - `$ACL` = `C:\Users\Administrator\.dsh\acl-runner\node_modules\@deepseek-ai`
> - `$PROFILE` = `C:\Users\Administrator\.dsh\profiles\desktop`
> - `$WEB` = `$ACL\dsh-web-frontend\dist\assets\index-5SrrfWpU.js`（外壳，压缩成 128 行；引用行号 + 字节偏移）
> - `$PKG` = `C:\Users\Administrator\Documents\daily\dsh-preview-extra\pkg`（lead 的骨架）
>
> 配套产物：`skeleton/`（最小可跑包 + 校验器）、`notes/preview-api.md`（预览 API，task-1 产出）。

---

## 0. TL;DR

| 问题 | 结论 |
|---|---|
| bundle 形态 | **classic script**：`window.__ModuleLoader__.load({ id, factory: (require) => {...; return module.exports} })`，`exports.apply` / `exports.inject` / `exports.name` 即 Cordis 插件面 |
| id 与包名 | bundle 的 `id` **必须等于 package.json `name`**（浏览器模块身份 = 包名） |
| 入口路径 | 唯一来源：`package.json` 的 **`exports["./client"]`**；没有 `dsh.client.entry` 字段，也没有"约定 lib/client.js" |
| 单文件够不够 | **够**。`require.async("./client.<name>.js")` 可选；不用 chunk 完全合法 |
| factory 能 require 什么 | 冻结平台表 9 个 key（react/react-dom/jsx-runtime/cordis/store/slots/primitives/dockkit）+ `dsh.client.external` 声明的动态包 |
| `dsh.client.inject` | 只是**加载/预取元数据**（informational），不做 apply 排序；服务等待靠 `exports.inject`（服务名） |
| 宿主半侧 | **必需**，但可以 no-op（`export function apply() {}`）；它只是让 Loader 有条目、让扫描器能往上找到 package.json |
| 是否要 `dsh.bundle.patch` | 只有走 `dsh plugin add` 的 bundle 渠道才需要；手动往 profile patch 加 `- insert:` 行不需要 |
| 生效方式 | 新增行：profile 配置 HMR 开着就秒级热生效；改 `lib/client.js`：client-hmr 每 500ms stat 轮询后热替换；改 `package.json`/`lib/index.js`：**要重启 DSH** |
| 最大坑 | 初始页面加载时任一客户端插件 pending/失败 → 整个 shell 抛错，页面停在 “Failed to load plugins” |

---

## 1. 手写 bundle 的确切格式

### 1.1 文件形态与最小形状

发布出来的每个官方客户端 bundle 都是**经典脚本**（不是 ESM），形如
`$ACL/dsh-client-ui-brand-official/lib/client.js:1-46`：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-brand-official",   // === package.json name
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" }); // 可选
    let jsxRuntime = require("react/jsx-runtime");    // 平台 seed 表
    // ...模块体（组件、apply）...
    exports.apply = apply;
    exports.inject = inject;                          // 可选
    return module.exports;
  }
});
```

要点：

- 顶层**只应**出现 `window.__ModuleLoader__.load(...)` 这一句（前面可以有注释）；其它顶层
  语句会在脚本到达时就执行，破坏“注册 ≠ 执行”的惰性语义。**不能**有 ESM `import`/`export`
  语句（外壳用 `<script src>` 经典脚本加载，
  `$ACL/dsh-client-modules/lib/client.js:450-464`）。
- 执行 bundle 只**注册** factory，模块体副作用（含 CSS 注入）在物化时才跑：
  `$ACL/dsh-client-modules/lib/client.js:16-31`（文件头契约注释）、`:569-581`（register）。
- `Symbol.toStringTag` 是构建器习惯，不是契约；`exports.default` 也不会被当成插件
  （`unwrapExports`：`exports.default ?? exports`，`$ACL/cordis-plugin-loader/src/index.ts:200-208`）。
- 单个 chunk 也不需要：`skeleton/lib/client.js` 就是单文件实测样本。

### 1.2 `load()` 参数

`register(registration)` 只认三个字段（`$ACL/dsh-client-modules/lib/client.js:569-581`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 浏览器模块身份。`stripClientSuffix()` 会把结尾 `/client` 去掉（`$ACL/dsh-client-modules/lib/client.js:98-100`），所以 `"pkg"` 与 `"pkg/client"` 等价；推荐直接写包名 |
| `factory` | `(require) => any` | 返回该模块的 `module.exports`；同一 id 二次注册会抛 `duplicate factory registration`（`:573-576`） |
| `chunk` | string? | 仅 chunk 文件使用，值形如 `"client.pdf.js"`（`$ACL/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js:944-947`） |

HTML 里预置的是排队 facade：`create()` 之前 `load()` 只 push，boot 时清空队列并切成
live 注册（`$ACL/dsh-client-modules/lib/index.js:453-475` 注入的 queue 脚本 +
`lib/client.js:559-566`）。所以手写时**顺序无所谓**，但 id 必须对。

### 1.3 factory 返回值与 apply/inject 如何被消费

完整链路（客户端）：

1. 每个 graph row 变成 Cordis Loader 条目：
   `ClientEntries.create(loader, id)` → `loader.create({ name: id })`
   （`$ACL/dsh-client-modules/lib/client.js:353-361`；**不传 config**）。
2. Loader 的 `Entry._init` → `tree.import(name)` → `loader.internal.import(...)`
   （`$ACL/cordis-plugin-loader/src/config/entry.ts:221-236`、
   `$ACL/cordis-plugin-loader/src/config/tree.ts:111-129`）。
   浏览器里 `loader.internal` 就是 `ClientModuleSystem`（`$WEB` line 124, offset ~625688：
   `a.internal = e.modules`）。
3. `ClientModuleSystem.import` → `arriveGraphRow`（加载依赖 + 自己）→ `materialize`：
   `factory(makeRequire(...))` 得到 exports（`$ACL/dsh-client-modules/lib/client.js:743-757`、`:670-695`）。
4. `Loader.unwrapExports(exports)` → `exports.default ?? exports`
   （`$ACL/cordis-plugin-loader/src/index.ts:200-208`）。
5. `ctx.registry.plugin(plugin, config)`：cordis 认定“对象插件 = 带 `apply` 方法的对象”
   （`$ACL/cordis/src/registry.ts:9`、`:318-330`），读 `plugin.inject` 解析服务依赖
   （`:71-85`），随后 fiber 执行 `apply(ctx, config)`（`:330`；`fiber.ts:222-262`）。

因此手写 bundle 的“插件面”就是：

| export | 必需 | 语义 |
|---|---|---|
| `apply(ctx)` | 是 | 插件主体；`ctx` 为该 fiber 的 Cordis 上下文 |
| `inject` | 否 | **Cordis 服务名**数组（如 `["slots","locale"]`）；服务不出现时 fiber 保持 PENDING |
| `name` | 否 | 日志/诊断名，可省略 |
| 其它 export | 无所谓 | 只被 `require()` 它的 bundle 看到 |

注意：graph row **没有 config 字段**（`parseBootManifest` 只拷贝 `inject`/`external`/`immediately`，
`$ACL/dsh-client-modules/lib/client.js:108-173`），`apply` 的第二个参数永远是 `undefined`。
需要“配置”只能走宿主 `webserver/index-inject` 注入的全局量
（官方样板：`$ACL/dsh-client-ui-sidebar-documentpreview/lib/index.js:20-33` 注入
`__DSH_DOCUMENT_PREVIEW_CONFIG__`）、服务或 Remote RPC。

### 1.4 id 与包名（manifest name）的关系

- 宿主侧图的 row id = **最近的 package.json 的 `name`**（`nearestPackage`，
  `$ACL/dsh-client-modules/lib/index.js:774-790`；`graphRow(packageName, ...)`，`:883-890`）。
- 浏览器按 row id 调用 `loader.create({name: id})`，再按同一 id 物化 factory；
  脚本加载成功但没注册该 id 时报
  `bundle ... loaded without registering "<id>" via __ModuleLoader__.load`
  （`$ACL/dsh-client-modules/lib/client.js:624-640`）。
- `/plugins` URL、combo 列表、chunk 路由里出现的 id 也都是**包名**（见 §3.6）。
- Loader 行自己的 `id`（`cordis.patch.yml` 里的 `- id:`）与浏览器模块身份**无关**，
  只用于 Loader 树寻址；可以随便取，只要唯一。

### 1.5 单文件 / chunk / require.async

- 单文件（无 `require.async`）完全合法；所有官方小插件都这样。
- 只有源码里的动态 `import()` 经 tsdown 编译后才变成
  `require.async("./client.<name>.js")`（`$ACL/dsh-client-modules/README.zh.md:38`）。
- chunk 约束（若用）：文件必须与入口同目录、文件名匹配
  `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`
  （`$ACL/dsh-client-modules/lib/index.js:169`，浏览器侧同规则 `lib/client.js:470`），
  且注册时带 `chunk: "<文件名>"`；不能相对 `require` 别的产物（`README.zh.md:68`）。
- chunk 的 URL 由宿主按 row 派生：`/plugins/<pkg>/<fileName>?rev=<rev>`
  （`$ACL/dsh-client-modules/lib/index.js:219-230`、`:914-957`）。
- **skeleton 不用 chunk**：`skeleton/verify.mjs` 对无 `require.async` 的情况直接 SKIP 通过。

### 1.6 文件名 / 位置要求

- 唯一硬要求：`package.json` 有 `exports["./client"]`，值为字符串或 `{ default: string }`
  （`clientExportOf`，`$ACL/dsh-client-modules/lib/index.js:170-181`）；文件实际叫
  `lib/client.js` 也好、`dist/foo.js` 也好都行。
- 声明了 `dsh.client` 却没有 `exports["./client"]` 会**直接抛错**：
  `declares dsh.client but exports no "./client" bundle`（`:718-719`）。
- 文件缺失（忘记建 `lib/client.js`）在激活时聚合为
  `MissingClientBundleError`，整个 client-modules 服务构造失败（`:127-157`、`:811-822`）。
- 路由对外统一表现为 `<pkg>/client.js`，与真实文件名无关
  （`comboSearch()` 拼的是 `${id}/client.js`，`:203-209`）。
- source map 可选：入口旁 `<client>.js.map` 存在则用于 combo 的 indexed map，不存在则生成
  identity section（`:269-316`、`:336-360`）。手写不需要 map。

### 1.7 惰性执行与“重复注册”语义

- 脚本执行 = 注册 factory；factory 在条目首次 import/物化时才跑
  （`$ACL/dsh-client-modules/lib/client.js:16-31`）。
- 一条 batch 脚本按顺序注册多个包；同一 URL 的脚本**只执行一次**，重放会在第一个重复
  注册处停住，因此 batch 失败时缺失的 row 会回退到自己的单资源 URL
  （`$ACL/dsh-client-modules/README.zh.md:38`、`lib/client.js:610-641`）。
  对手写单文件包来说这条链路退化为“一个 URL 注册一个 factory”，很安全。

---

## 2. factory 的 `require` 能同步解析哪些模块

### 2.1 冻结平台表（PLATFORM_MODULES）——精确 9 个 key

外壳在 boot 时构造冻结表的闭包，并作为 `staticModules` 传给模块系统：

```js
// $WEB line 126（压缩后单行；该函数起始字节偏移 628285）
function rM(){return{
  react:Ef,
  "react/jsx-runtime":If,
  "react-dom":Rf,
  "react-dom/client":Df,
  "@deepseek-ai/cordis":sf,
  "@deepseek-ai/dsh-client-store":lh,
  "@deepseek-ai/dsh-client-ui-slots":hh,
  "@deepseek-ai/dsh-client-ui-primitives":sE,
  "@deepseek-ai/dsh-client-ui-dockkit":XS
}}
```

调用点：`staticModules: rM()`（同一行，偏移 630925）。文字说明见
`$ACL/dsh-client-modules/README.zh.md:46`（“PLATFORM_MODULES：React、Cordis 与静态 UI 库”）。

精确可用清单（**只能在 factory 里 `require` 这些名字**）：

| key | 实体 |
|---|---|
| `react` | React 18 |
| `react/jsx-runtime` | jsx/jsxs/Fragment（手写无需 JSX 编译时用它） |
| `react-dom` | react-dom |
| `react-dom/client` | createRoot |
| `@deepseek-ai/cordis` | Cordis（Service/Fiber 等） |
| `@deepseek-ai/dsh-client-store` | 客户端 store 原语 |
| `@deepseek-ai/dsh-client-ui-slots` | slot 纯注册表（SlotCore 等） |
| `@deepseek-ai/dsh-client-ui-primitives` | 静态 UI 原语库 |
| `@deepseek-ai/dsh-client-ui-dockkit` | 停靠 UI 库（本机 `@deepseek-ai` 安装里没有这个包，但 shell 的 seed 表里有该 key） |

补充事实：

- 头 4 个之外都是 `@deepseek-ai/*` 包，但它们在浏览器侧**不是**从 `/plugins` 加载的，
  而是外壳自带的静态模块；插件包**不需要也不应该**把 `dsh-client-ui-slots`、
  `dsh-client-store`、`dsh-client-ui-primitives` 写进 `dsh.client.external`。
- `@deepseek-ai/dsh-client-ui-dockkit` 虽然不在本机 `node_modules` 里（本机没装该包），
  但 key 存在于 seed 表，`require` 它能解析（值为 shell 内打包的实现）。
- 平台表**冻结**：没有 `@deepseek-ai/dsh-client-locale`、`dsh-client-ui-renderer`、
  `dsh-client-ui-conversation` 等动态包的 key。它们只能通过 `ctx` 服务/RPC 使用，
  不能被 `require`。

### 2.2 require 的解析顺序

`makeRequire(ownerId, edges)`（`$ACL/dsh-client-modules/lib/client.js:697-715`）：

1. `this.seed`（平台表）→ 命中直接返回；
2. `this.loadCache`（已物化模块）→ 返回 exports；
3. `this.factories`（已注册 factory）→ 递归物化；
4. 否则抛
   `require("<spec>") missed the module table — not a platform seed word, ...`
   （`:705`）。

`require.async(spec)`：非 `./` 开头走 `this.import(spec)`（异步拉 row 再物化）；
`./client.<name>.js` 走 chunk 加载（`:707-713`、`:717-742`）。

### 2.3 `dsh.client.external`：何时需要、失败点在哪

- 语义（`$ACL/dsh-client-modules/README.zh.md:34,46`）：external 只添加**平台表之外**的
  精确请求；每个请求解析到“指定的动态包 row”或“平台表精确键”。
- 协议字段只是字符串数组（`parseDshClient`，`$ACL/dsh-client-modules/lib/index.js:61-75`），
  宿主把它原样放进 graph row（`:394-404`、`:720-728`），浏览器用它**先把依赖 row 的
  factory 注册好**（`$ACL/dsh-client-modules/lib/client.js:643-661`）。
- 组合期校验只有：自请求、外部关系形成的环（`orderByModuleGraph`，
  `$ACL/dsh-client-modules/lib/index.js:415-437`）。
  README:46 说“组合阶段会拒绝缺失提供方”，**源码里没看到这一步**；实际缺失提供方会在
  factory 物化时以 require-miss 抛错。保守结论：别依赖组合期报错，external 只写真正
  `require` 的动态包。
- `external` 里写 `<pkg>/client` 与裸 `<pkg>` 等价（`stripClientSuffix`，`:98-100`、
  `orderByModuleGraph` 的 `rowsById.get(stripClientSuffix(name))`，`:426-429`）。

### 2.4 `dsh.client.inject`：informational，不做排序

- 只是字符串数组校验（`$ACL/dsh-client-modules/lib/index.js:66`），进 graph row
  （`:724`）和 boot wire（`$ACL/dsh-client-modules/lib/client.js:125-139`）。
- 浏览器侧唯一用途：`arriveGraphRow` 先把这些包 row 的 factory“到达”，以及 `prune()`
  保留它们（`$ACL/dsh-client-modules/lib/client.js:643-661`、`:801-823`）。
- **不是** apply 排序、**不会**让 `ctx.<service>` 变成可等待依赖。官方源码注释写得很直白：
  “`dsh.client.inject` edges are informational (loading/prefetch metadata, never apply
  sequencing)”（`$ACL/dsh-client-ui-workspace/lib/client.js:4101-4106`）。
- 它列的是**包名**；`exports.inject` 列的是**服务名**，两者别混。

### 2.5 我们的新包需要写哪些 declare

**skeleton（无预览依赖，只演示 slot + service）**

```json
"dsh": { "client": { "platform": "web",
  "inject": ["@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
             "@deepseek-ai/dsh-client-ui-renderer"] } }
```

`exports.inject = ["slots"]`（`"slots"` 由 `dsh-client-ui-renderer` 提供，见 §5）。

**真实预览插件（`$PKG`）建议**

```json
"dsh": { "client": { "platform": "web",
  "inject": ["@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
             "@deepseek-ai/dsh-client-ui-sidebar-right",
             "@deepseek-ai/dsh-client-ui-renderer",
             "@deepseek-ai/dsh-client-locale"] } }
```

- 不需要 `external`：只 require `react`、`react/jsx-runtime`（+ 可选 `primitives`），
  全部在平台表。
- `exports.inject` 建议 `["slots"]` 为硬依赖，`documentPreviews`/`locale` 用
  `ctx.inject([...])` 软等待（见 §5.3）。

---

## 3. 宿主侧：发现、定位、提供

实现全在 `$ACL/dsh-client-modules/lib/index.js`（Node 半侧）与
`$ACL/dsh-client-modules/lib/client.js`（浏览器半侧）。宿主服务名 `clientModules`。

### 3.1 扫描何时发生、是否增量

- `ClientModuleRegistry extends Service`，`static inject = ["loader"]`
  （`$ACL/dsh-client-modules/lib/index.js:506-507`）。
- 构造时：订阅 `internal/plugin`（fiber 构造/销毁）→ 把该 fiber 的**entry name** 标脏 →
  `queueMicrotask` 里 flush（`:527-539`）；同时把所有当前 entries 标脏、同步 compose +
  首次 flush（`:540-544`）。所以“首次扫描”和“稳态”共用同一实现。
- 之后每次 `internal/plugin` 只处理对应的那个 entry name（`processOne`，`:833-857`）；
  **没有全量重扫路径**（文件头注释 `:114-124`）。
- 因此：**新增 Loader 行会在宿主进程内被增量发现**，无需重启——前提是宿主 Loader 自己
  先新增了这个行（见 §6.1）。

### 3.2 从一个 Loader 条目到一个客户端包

`processOne(entryName)` 做的事（`:833-870`）：

1. 遍历 `ctx.loader.entries()`，取 `options.name === entryName`、`fiber !== undefined`、
   `!disabled` 的条目；
2. `resolveSource(entry)`：`loaderName = entry.options.name`，
   `baseUrl = entry.parent.tree.ctx.baseUrl`（没有 baseUrl 会抛错），
   调 `resolveMeta(loaderName, baseUrl)`；
3. `resolveMeta`（`:701-731`）：
   - `locatePkgJson`（`:743-773`）：
     - `cordis:` 内建 → 忽略；
     - **路径类**（`.` / `file:` / 绝对路径）：经 `loader.internal.resolveSync`（Node 24 是
       `v2` 形状 `resolveSync(baseUrl, {specifier, attributes})`）解析成 URL 后
       `nearestPackage(moduleUrl)` 向上找最近的 package.json；
     - **包名类**：要求是“裸包名”（`name` 或 `@scope/name`，见 `exactPackageSpecifier`
       `:82-88`），经同一个 Loader 解析后找最近的、`name` 匹配的 package.json；
     - 其它（子路径 specifier）→ 直接忽略；
   - 读 package.json → `parseDshClient(pkgName, pkg.dsh.client)`；
   - **`decl.platform !== "web"` 或不声明 → 这不是客户端包**（负结论也会缓存）；
   - `clientExportOf(pkgName, pkg.exports)` → 必须拿到 `exports["./client"]`，否则抛错；
   - 产出 `meta = { clientPath: join(dirname(pkgPath), clientRel), inject?, external: [], immediately }`。
4. `reconcilePackage(packageName)`（`:871-892`）：
   - 同一 packageName 有 **>1 个 active Loader source** → 抛
     `package ... resolves from multiple active Loader sources ...; remove one entry`；
   - 否则跑 `initialBundleSnapshot`（stat 基线 + 读字节）→ `artifactRevision` → 写 `table`。

**关键缓存**：`pkgMeta` 以 `baseUrl\0loaderName` 为 key 缓存到进程重启（`:701-705`；
文件头 `:114-124`），连“不是客户端包”的负结论也缓存。**改 package.json 的
`dsh.client`/`exports` 后不会自动重读**——必须重启 DSH（或让行以不同的
name/baseUrl 重新出现）。这条比“改 bundle 内容”严格得多，务必注意（§6.3、§7）。

### 3.3 `dsh.client` 的字段与校验规则（唯一权威 = `parseDshClient`）

`$ACL/dsh-client-modules/lib/index.js:61-75`：

```ts
dsh.client = {
  platform: string,        // 必须 === "web"，否则该包被当作非客户端包（:714-717）
  inject?: string[],       // 包名数组；元素必须是 string（:66）
  external?: string[],     // 包名/平台键数组；元素必须是 string（:67）
  immediately?: boolean,   // 启动时预取（:68；graphRow :401 / shell 预取见 §3.7）
}
```

- 无 schema、无未知字段拒绝：额外字段被忽略（`parseDshClient` 只挑上面 4 个）。
  因此 **`dsh.client.entry` 不存在也不会生效**——入口只来自 `exports["./client"]`。
- `dsh.client` 存在但不是 object / `platform` 不是 string / inject/external 含非 string /
  `immediately` 非 bool → 抛错，激活期聚合为 `ClientPackageCompositionError`。
- `platform` 目前只有 `"web"` 被接受；desktop 桌面外壳用的仍是 web 客户端，所以客户端包
  一律写 `"web"`。
- 组合包层字段是另一个键：`dsh.bundle.patch`（见 §4.3），与 `dsh.client` 平级。

### 3.4 客户端入口：没有 entry 字段、没有约定路径

- `exports["./client"]` 是**唯一**入口来源（`clientExportOf` `:170-181`；
  `resolveMeta` `:718-719`）。
- 值可以是 `"./lib/client.js"`，也可以是 `{ "default": "./lib/client.js" }`；
  其它形式抛错。
- 路径相对**package.json 所在目录**（`join(dirname(pkgPath), clientRel)`，`:723`）。
- 不存在“默认 lib/client.js”回退；也不存在 `dsh.client.entry`。
- 官方包普遍写 `lib/client.js` + `lib/client.<name>.js`（chunk），这只是构建惯例
  （`$ACL/dsh-client-ui-sidebar-documentpreview/package.json:85-90`）。

### 3.5 包名 = 浏览器模块身份；同名多源是错误

- row id 用 package.json `name`（§1.4）。
- 两个 active Loader 条目解析到同一包名 → 组合错误
  （`$ACL/dsh-client-modules/lib/index.js:871-877`），提示 “remove one entry”。
- 所以：**同一个包不要同时被 bundle patch 和手动 patch 挂两次**；也不要同时挂
  `pkg/` 与 `skeleton/` 的同名副本（skeleton 特意用了不同包名）。

### 3.6 revision 与 `/plugins` 路由

**revision**（`artifactRevision`，`:192-199`）：`sha1(mtimeMs, ctimeMs, size)` 前 12 位，
不比内容。改写 bundle（即使内容相同、只是 mtime 变）都会换 rev。未变化的产物在 Host
重启后 rev 不变（`:74` README）。

**组合与 URL**（`:203-230`、`:235-252`、`:325-379`）：

- combo 路由键：`/plugins/??<id1>/client.js,<id2>/client.js&rev=<comboRev>`
  —— id 就是**包名**，多个包用 `??` + 逗号拼；
- 每个 row 还有自己的单资源 combo：`/plugins/??<pkg>/client.js&rev=<rowRev>`
  （宿主为所有 row 都注册，作为 batch 失败时的回退，`:669-679`）；
- URL 长度上限 3 KiB，超过就分区成多个 batch（`:161`、`:235-252`）；
- 浏览器看到的是**文档相对**形式：去掉开头 `/`，即 `plugins/??...&rev=...`
  （`:210-218`）；
- combo rev = 有序 row rev 的哈希（`:325-328`）；source map 端点
  `...client.js.map&rev=...` 同规则。

**路由处理**（`:545-551`、`:958-978`）：

- 仅当 `webServer` 服务存在时注册 prefix 路由 `/plugins`（桌面/Web 都有
  `dsh-host-webserver`，见 `$ACL/dsh-web-app/cordis.patch.yml:169-177`）；
- `GET`/`HEAD`，其它 405；命中 `200` + `cache-control: public, max-age=31536000, immutable`；
  未知 URL/revision 一律 404；
- 响应 body 在**首次 GET 时**从 compose 时的字节快照惰性拼出，之后按 URL 缓存
  （`:649-693`、`:580-587`）。**bundle 内容变更只能通过 `rebuilt()` 进入图**
  （`:600-625`），否则旧 URL 会一直返回旧字节。若某个宿主半侧插件自己生成客户端产物，
  应在写完后调用 `ctx.clientModules.rebuilt(id)` 主动发布新 rev（`:600-625`、
  `:631-636` 的 `onRebuilt` 订阅面）。
- chunk 路由：`/plugins/<pkg>/<client.x.js>?rev=<rev>`，延迟到被请求才读文件
  （`:914-957`）；map 引用是裸文件名，相对脚本自身目录（`:220-230`）。

### 3.7 启动图与 `window.__DSH_BOOT__` 注入

`bootInjections(graph)`（`:453-498`）按顺序往 index `<head>` 注入：

1. 内联脚本：`window.__ModuleLoader__` 排队 facade（含 `create()`）；
2. `<link rel=preload>` / application batch 预取；
3. bootstrap batch：**只有** `@deepseek-ai/dsh-client-modules` 自己（`PARSER_PRELOAD_IDS`，
   `:438-441`）——它先物化出模块系统；
4. `window.__DSH_BOOT__ = graph` 全局量。

`graph` 形状（`:685-693`）：`{ rev, entries: [{id,url,rev,inject?,immediately?,external?}], batches: [{phase,url,rev,entries}] }`。
外壳（`$WEB` line 124，offset 625688 起）读它：`__ModuleLoader__.create({boot, staticModules, ...})`，
然后 `entries.start(loader, manifest)`，最后做一次**启动审计**：任何 entry 不 ACTIVE 都抛错，
页面显示 “Failed to load plugins”。`immediately: true` 的 row 会被外壳在外层 boot 前预取
（`$WEB` line 126 附近 `prefetchImmediateTier`，`ui-renderer` 就用了它：
`$ACL/dsh-client-ui-renderer/package.json:32-36` 的 `dsh.client.immediately=true`）。

---

## 4. 最小合法插件包

### 4.1 必需文件（纯客户端插件）

```
<pkg>/
  package.json          name/version/type=module/exports["./client"]/dsh.client
  lib/index.js          宿主半侧（no-op 可以，但必须有）
  lib/client.js         手写客户端 bundle
  cordis.patch.yml      （可选）作为 bundle 安装时的 insert 行
  README.md / verify.mjs（可选，工程用）
```

`package.json` 最小形（`skeleton/package.json`，实测通过）:

```json
{
  "name": "dsh-preview-extra-skeleton",
  "version": "0.0.1",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
        "@deepseek-ai/dsh-client-ui-renderer"
      ]
    }
  }
}
```

### 4.2 宿主半侧必需吗？——必需，但可以 no-op

- Loader 的每一行都要 `import(name)` 一个模块（`entry.ts:221-236`、`tree.ts:111-129`）；
  同时 client-modules 要靠这个模块的 URL 往上找 package.json（`nearestPackage`）。
- 不能用 `lib/client.js` 当宿主半侧：它顶层引用 `window.__ModuleLoader__`，Node 里 import 会炸。
- 所以宿主半侧至少要有 `export function apply() {}`；
  官方 `$ACL/dsh-cordis-client-runner/lib/index.js:1-11` 就是“纯浏览器能力 + 空 apply”的先例。
- 纯客户端预览插件**不需要**任何 host 侧路由/服务；`$PKG/lib/index.js:13-14` 的 no-op 是正确形状。

### 4.3 需要 `dsh.bundle.patch` / `cordis.patch.yml` 吗？

- **手动挂载**（编辑 profile 的 `cordis.patch.yml`）：不需要。`dsh.bundle.patch` 只有在
  包作为“profile bundle 层”被安装时才被读取（`$ACL/dsh-package-manifest/README.zh.md:46`；
  `$ACL/dsh-app-boot/README.zh.md:50` 解释 bundle patch 合并顺序）。
- **走 `dsh plugin add`**：需要 `dsh.bundle.patch`（字符串或有序数组），
  CLI 会把它加入 `dsh.profile.bundles` 并自动应用该 patch 层
  （`$ACL/dsh-plugin-manager/lib/index.js:226-255`；`$ACL/dsh-better-sidebar/package.json:42-45`
  是真实样例，其 `cordis.patch.yml:46-49` 就是一个 `insert`）。
- 两个渠道**不要同时用**（会双挂）。

### 4.4 插入 Loader 行的写法

profile 的 `cordis.patch.yml` 是“顶层 YAML 数组的 loader patch 项”（
`$PROFILE/cordis.patch.yml:1-2`；`$PROFILE/cordis.yml:1-4` 说明整棵树由 bundle + patch 组成）。
新增行 = 追加一个 `insert` 项：

```yaml
- insert:
    - id: dsh-preview-extra            # Loader 条目 id（唯一即可，与浏览器 id 无关）
      name: 'dsh-preview-extra'        # 宿主半侧模块 specifier
```

名字（`name`）有两种写法：

| 写法 | 前提 | 备注 |
|---|---|---|
| `name: 'dsh-preview-extra'` | profile 能解析到该包（进了 `~/.dsh/profiles/desktop/node_modules`，或 `dsh plugin add`） | 最自然；`$PKG/cordis.patch.yml:9-11` 用的就是这种 |
| `name: 'file:///C:/Users/.../pkg/lib/index.js'` | 无。包可以放在 workspace 里 | **无需安装**；`locatePkgJson` 的 pathLike 分支支持（`dsh-client-modules/lib/index.js:743-773`）。Node ESM 不接受裸 `C:\...`，必须 `file:///C:/...`。本会话不能写 `~/.dsh`，故未在运行实例实测；但已用等价逻辑模拟 `nearestPackage` + `clientExportOf`：从 `file:///.../skeleton/lib/index.js` 正确命中 `skeleton/package.json`（name=`dsh-preview-extra-skeleton`）→ `clientPath=<pkg>/lib/client.js`（存在）；Node 侧 `import.meta.resolve` 也原样返回该 URL |

本机现状：

- `$PROFILE/package.json:8-18` 的 bundles = `dsh-base`、`dsh-web-app`、`dsh-experimental-*`；
- `$PROFILE/node_modules` 里只有 `dshmarket`、`@copylee/dsh-computer-use`、`dsh-ops` 等，
  **没有** `@deepseek-ai/*`（那些从安装目录 `$ACL` 解析）——所以把 `pkg/` 用裸包名挂载
  需要额外的安装/junction 步骤；**file: URL 是最省事、对 workspace 之外零改动的路径**。

`disabled` 可用 `!!js` 表达式（样例 `$ACL/dsh-better-sidebar/cordis.patch.yml:47-49`）。

### 4.5 与 lead 现有 `$PKG` 的对照与修正建议

`$PKG` 已具备：`package.json`（`name=dsh-preview-extra`、`exports["./client"]`、
`dsh.client.platform=web` + 3 个 inject 包名）、`lib/index.js`（no-op，正确）、
`cordis.patch.yml`（`insert`）、以及一个**占位** `lib/client.js`（`exports.inject = []`，
`apply` 只写 `<html data-dsh-preview-extra="placeholder">`；用于先验证安装/路由链路，
真预览实现落地后替换）。用 `skeleton/verify.mjs` 实测：**30/30 通过**。待补/待改：

1. **占位 `lib/client.js` 换成真实现**：现在只有 DOM 标记，没有任何预览注册；
   真实实现时 `apply` 要按 §5.3 的软等待结构注册 `documentPreviews` + body slot，
   并 `require("react/jsx-runtime")`（平台表）。
2. `$PKG/package.json` 的 `dsh.client.inject` 建议补
   `@deepseek-ai/dsh-client-ui-renderer`（`ctx.slots` 的提供方，见 §5）。
3. 若用 `name: 'dsh-preview-extra'` 挂载，确认包在 profile 的解析范围内（§4.4）；
   否则改成 file: URL 行。
4. `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-ui-slots` 可加可不加（它是平台
   seed 模块、不是 Loader row，列了也只是 informational；官方 better-sidebar 列了它）。

---

## 5. 客户端 `ctx` 服务从哪来

### 5.1 服务 → provider 对照（本机 web 组合）

provider 的 Loader 行都在 `$ACL/dsh-web-app/cordis.patch.yml` 里（desktop profile 继承它）：

| 服务（`exports.inject` 里写这个） | provider 包 | 行 id（`dsh-web-app` patch） | 源码证据 |
|---|---|---|---|
| `slots` | `@deepseek-ai/dsh-client-ui-renderer` | `ui-renderer`（:251-252） | `$ACL/dsh-client-ui-renderer/lib/client.js:1320-1327`（`super(ctx,"slots")`）、`:1838-1850`（apply 里 install + provide uiRenderer） |
| `locale` | `@deepseek-ai/dsh-client-locale` | `locale`（:239-240） | `$ACL/dsh-client-locale/lib/client.js:1491`（inject）、`:1526`（`ctx.provide("locale")`）、`:1533`（`slots.installLocale`） |
| `documentPreviews` | `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | `ui-sidebar-documentpreview`（:272-275） | `$ACL/dsh-client-ui-sidebar-documentpreview/lib/client.js:6809`（`ctx.reflect.provide("documentPreviews", previews)`）、注册表实现 `:306-359` |
| `sidebarRightTabs` | `@deepseek-ai/dsh-client-ui-sidebar-right` | `ui-sidebar-right`（:264-266） | `$ACL/dsh-client-ui-sidebar-right/lib/client.js:9073`（`provide("sidebarRightTabs", tabs)`） |
| `modules` | `@deepseek-ai/dsh-client-modules` | `modules`（:207-212） | `$ACL/dsh-client-modules/lib/client.js:859-869` |
| `uiRenderer` | 同上 renderer | `ui-renderer` | `$ACL/dsh-client-ui-renderer/lib/client.js:1844` |

（`remote`/`remote.*`/`configForms`/`resources`/`sessions`/`connection` 等同样来自
`api-remotes`/`client-resources`/`ui-settings`/`ui-session`/`connection` 等行；查任意服务
用 `grep provide("<name>"`。）

### 5.2 `exports.inject`（服务名） vs `dsh.client.inject`（包名）

- `exports.inject = ["slots", "locale", "documentPreviews"]`：Cordis 服务依赖。
  服务不出现 → 该 fiber PENDING；**初始页面加载时 PENDING 会被启动审计判失败**，
  整页显示 “Failed to load plugins”（`$WEB` line 124/126，`eM()`）。
- `dsh.client.inject = ["@deepseek-ai/dsh-client-ui-sidebar-documentpreview", ...]`：
  包名，informational（§2.4）。它**不能**替代 `exports.inject`。
- 结论：拿 `ctx.documentPreviews` / `ctx.slots` / `ctx.locale` 不需要在 `dsh.client.inject`
  里列“精确包名”才“生效”；但按官方惯例两边都写：`dsh.client.inject` 写 provider 包名，
  `exports.inject` 写服务名。

### 5.3 硬注入的风险与软等待（强烈建议真实插件用）

`documentPreviews` 的 provider 行 `ui-sidebar-documentpreview` 虽然在默认组合里，
但用户/其它插件可以禁用该行。如果我们的插件把 `documentPreviews` 写进 `exports.inject`，
provider 缺失时我们的 row 永远 PENDING → **整个 GUI 启动失败**（不是我们自己不工作而已）。

官方做法：对“有则更好”的能力用 `ctx.inject([...], cb)` 起一个子 fiber，子 fiber pending
不影响 entry 的 ACTIVE 状态。证据：`$ACL/dsh-client-ui-chat/lib/client.js:12334-12335`
（`ctx.inject(["sidebarRightTabs"], (scope) => {...})`，sidebarRightTabs 是可选能力）。

建议结构（真实预览插件）：

```js
const inject = ["slots"]; // 硬：ui-renderer 在默认组合永远在

function apply(ctx) {
  ctx.inject(["documentPreviews"], (previewCtx) => {
    // 此时 documentPreviews 一定可用
    previewCtx.effect(() => previewCtx.documentPreviews.register({
      id: "dsh-preview-extra/model3d",
      extensions: ["stl", "obj", "ply"],
      priority: "extension",
      title: () => "3D Model",
      loading: "bytes-complete",
    }));
    // body 槽位注册也放这里：key 必须等于上面 register 的 id
    previewCtx.effect(() => previewCtx.slots.inject("sidebar.right.tab.document", () =>
      previewCtx.slots.register({ name: "sidebar.right.tab.document", key: "dsh-preview-extra/model3d" }, ModelBody)
    ));
  });
  ctx.inject(["locale"], (localeCtx) => localeCtx.effect(() => localeCtx.locale.register(NS, { zh, en })));
}
```

（`documentPreviews.register` 的完整字段/优先级/内容形状由 task-1 的
`notes/preview-api.md` 负责；这里只保证“服务从哪来、怎么等”。）

### 5.4 slot 声明等待：`ctx.slots.inject(key, cb)`

- `ctx.slots.inject(key, callback)` 在 slot **被声明**时执行 callback（返回 disposer），
  声明消失时回滚；它属于调用方 fiber，插件卸载自动清理
  （`$ACL/dsh-client-ui-renderer/lib/client.js:1343-1402`）。
- 所以注册到别人声明的 slot 不必假设 apply 顺序（这正是
  `$ACL/dsh-client-ui-workspace/lib/client.js:4101-4106` 说明的写法）。
- `sidebar.right.tab.document` 由 documentpreview 的 TextPreview 行声明为 `keyed` 子 slot
  （`$ACL/dsh-client-ui-sidebar-documentpreview/lib/client.js:6822-6851`，`:6828-6832`），
  它按 `key` 分派：**key 必须等于被选中的 `documentPreviews` 实现 id**
  （官方 code 预览：register id `.../code`（`:5086-5093`）与 slot `key: ID`（`:5094-5098`）一致）。
- 也就是说：**不需要手动保证 documentpreview 先加载**——两条门控天然成立：
  ① 用 `documentPreviews` 服务 → Cordis 等 provider；
  ② 用 `ctx.slots.inject` 等声明 → slot 声明出现才注册。
  唯一要注意的是别把 `documentPreviews` 写成硬 `exports.inject`（§5.3）。

---

## 6. 安装 / 热更新 / 验证

### 6.1 三条独立的“热”通道

| 通道 | 谁负责 | 覆盖什么 |
|---|---|---|
| A. profile 配置 HMR | `@deepseek-ai/dsh-hmr`（base 行 `hmr`） | profile `package.json`(bundles) 与用户 patch 文件变化 → 重新组合 Loader 树 |
| B. 客户端图 SSE | `@deepseek-ai/dsh-client-hmr`（web-app 行 `client-hmr`） | 新增/删除 row → 推 `graph` 帧给已打开页面 |
| C. bundle 重建轮询 | 同上 host 半侧 | 每个 row 的 `client.js` mtime/ctime/size 变化 → `rebuilt(id)` → `rebuilt` 帧 → 浏览器热替换 |

**A**：

- base 组合包在启动器提供 `profileContext` 时启用 `hmr`（`$ACL/dsh-base/cordis.patch.yml:27-32`：
  `disabled: !!js "!ctx.get('profileContext')"`，`config.root: []`）；
  “YAML 组合决定是否启用 HMR。随产品交付的 `web` 模板实时重载，其他随附模板只在启动时
  应用 patch”（`$ACL/dsh-app-boot/README.zh.md:50`）。
- 它监视 profile manifest 与两份用户 patch 文件，重新读取组合包层并应用
  （`$ACL/dsh-app-boot/README.zh.md:63`）；`root: []` 表示**只**保留配置监听、不监听
  源码模块（`$ACL/dsh-hmr/README.zh.md:27-34,43`）。
- 配置变化 → Loader 条目增删 → client-modules 的 `internal/plugin` 增量扫描
  （§3.1）→ `compose()` → `notifyGraphChanged` → client-hmr 推 graph 帧
  （`$ACL/dsh-client-hmr/lib/index.js:117-123,153`）→ 浏览器 `entries.sync`
  （`$ACL/dsh-client-modules/lib/client.js:276-282`）。
- 结论：**新增/删除行不需要重启 DSH，也不需要刷新页面**（约 2-3 秒：chokidar
  `awaitWriteFinish` 约 2s + debounce；`$ACL/dsh-hmr/README.zh.md:47`）。
- HMR 被禁用/不存在的宿主：配置变化“需要重启”（`$ACL/dsh-app-boot/README.zh.md:63`）。

**B/C**：

- client-hmr host 半侧每 `pollIntervalMs`（默认 **500**，`$ACL/dsh-client-hmr/lib/index.js:22`）
  stat 每个 graph row 的入口 bundle；变化时 `clientModules.rebuilt(id)`
  （`:48-62, 93-104`）——这就是为什么**改 `lib/client.js` 会热替换**。
- `rebuilt()` 重新 stat、重算 rev、重读字节、重 compose，并通知
  `onRebuilt`（`$ACL/dsh-client-modules/lib/index.js:600-625`）。
- 浏览器收到 `rebuilt` 帧：invalidate → 预取单资源 URL → 拆旧 fiber → 物化新 exports →
  `entry.refresh()`（`$ACL/dsh-client-modules/lib/client.js:298-327`、`:362-375`）；
  React 状态会丢、数据层（连接/会话）保留（`$ACL/dsh-client-hmr/README.zh.md:116`）。

### 6.2 生效矩阵（本机 desktop profile）

| 改动 | 需要 | 依据 |
|---|---|---|
| 往 profile patch **加/删 Loader 行** | 等 2-3s（配置 HMR）。HMR 关则重启 DSH。**不必刷新页面** | §6.1 A |
| 改 `lib/client.js` 内容 | 等 ≤1s（500ms 轮询）。不重启、不刷新 | §6.1 B/C |
| 改 `lib/index.js`（宿主半侧代码） | **重启 DSH**（Node ESM 模块缓存；`root: []` 不监听源码） | `$ACL/dsh-hmr/README.zh.md:43,88-90`；`$ACL/dsh-plugin-manager/README.zh.md:130` |
| 改 `package.json` 的 `dsh.client` / `exports` / 包名 | **重启 DSH**（pkgMeta 缓存到重启；入口路径也变了） | `$ACL/dsh-client-modules/lib/index.js:701-731` |
| 改包物理位置（file: URL 指向变化） | 重启 DSH（等价于换 source，旧行需删除重加） | 同上 |
| 首次挂载前 `lib/client.js` 不存在 | 别挂：激活期聚合错误；且 bundle 缺失的 row 不会进 graph，client-hmr 也就不会观察它，补文件后通常要重启 | `$ACL/dsh-client-modules/lib/index.js:127-157, 811-822, 600-625` |
| 页面已处于启动失败卡片 | 修好后 **F5 刷新页面**；启动审计只在页面 boot 时跑 | `$WEB` line 124/126 |

注：desktop profile 由应用持有（Electron 保留的 profile，通过 `loadProfileDirectory` 加载，
`$ACL/dsh-app-boot/README.zh.md:50`），启动器会提供 `profileContext`，按 base 组合包
的默认表达式 HMR 应处于启用状态；若实测不是，按“重启 DSH”处理即可。

### 6.3 挂载前的静态验证（无网络、无构建工具也能做）

1. **语法**：`node --check lib/client.js`（classic script）；宿主半侧直接 `import()`
   （verify.mjs 就是这么做的；`package.json` 的 `"type":"module"` 决定 `.js` 的解析模式）。
2. **契约**：跑 `skeleton/verify.mjs`（可指向任意包目录）：

   ```powershell
   & 'C:\Program Files\nodejs\node.exe' .\skeleton\verify.mjs
   & 'C:\Program Files\nodejs\node.exe' .\skeleton\verify.mjs 'C:\Users\Administrator\Documents\daily\dsh-preview-extra\pkg'
   ```

   本机实测：skeleton **37/37**、官方 `dsh-client-ui-brand-official` **33/33**、
   `$PKG`（占位 bundle）**30/30** 通过。
3. **手工清单**（等价于 verify.mjs 的核心断言）：
   - `JSON.parse(package.json)` 成功；`dsh.client.platform === "web"`；
   - `exports["./client"]` 指向的文件存在；
   - bundle 首句 `window.__ModuleLoader__.load({`；`id` === `name`；
   - 源码里所有 `require("...")` ∈ 平台 9 键 ∪ `dsh.client.external`；
   - `exports.inject` 覆盖 `ctx.<service>` 的使用；
   - host 半侧能 `import()` 且导出 `apply`。
4. **挂载后**（页面内 DevTools）：
   - Console 有我们 `apply` 打的日志；
   - `window.__DSH_BOOT__.entries` 含新包名；
   - 路由形态：`window.__DSH_BOOT__.entries.find(e=>e.id==="<pkg>").url` 形如
     `plugins/??<pkg>/client.js&rev=<12hex>`；
   - Settings → Plugins 页展示同步失败并可重试（`$ACL/dsh-client-modules/README.zh.md:42`）。
   注意：从进程外直接 `fetch http://127.0.0.1:1890/` 会 **401**
   （“dsh web authentication required”，本机实测），必须用带 token 的启动 URL 或页面内 fetch。

---

## 7. 风险 / 坑清单（按踩中概率排序）

1. **bundle `id` ≠ package.json `name`** → 浏览器
   `loaded without registering "<id>"`；页面启动失败。手写时把两者当同一个常量维护。
2. **初始页面 boot 是“全有或全无”**：任一 row 的 fiber 不是 ACTIVE（apply 抛错、
   pending 服务、脚本 404/语法错）→ shell 抛错，整页停在 “Failed to load plugins”。
   所以：先静态验证，再挂行；`apply` 内对可失败逻辑做 try/catch。
3. **忘记 `lib/client.js`**（或 exports 指错）：宿主激活期
   `client bundle not found; run pnpm run build before launch`（`:127-157`）。
4. **先挂坏包再修**：`pkgMeta` 把“不是客户端包/入口路径”缓存到重启（`:701-731`），
   且缺失 bundle 的 row 不进 graph、client-hmr 不观察它 → 修好 package.json/文件后
   **通常要重启 DSH**。务必先写全再挂。
5. **硬注入 `documentPreviews`/`locale`**：provider 行被禁用时我们的 row 永远 PENDING
   → 整页启动失败。用 `ctx.inject([...])` 软等待（§5.3）。
6. **`dsh.client.inject` 当成排序/服务声明**：它只是 informational（`:4101-4106`），
   真正的等待是 `exports.inject` + `ctx.slots.inject`。
7. **同一个包被挂两次**（bundle patch + 手动 patch，或两份同名副本）→
   `package ... resolves from multiple active Loader sources`，整个 client 图组不出来。
8. **`external` 写错/漏写**：动态包缺失时不会在组合期报错，直到 factory 物化时抛
   `require(...) missed the module table`（`client.js:697-715`）。我们的包应尽量只用平台表。
9. **`require` 平台表之外的官方包**（如 `require("@deepseek-ai/dsh-client-locale")`）→
   运行时 missing；这些只能通过 `ctx` 服务拿。
10. **以为 bundle 可以带 `import`/`export`**：外层是经典 `<script>`，会语法错误。
11. **相对 require 另一个 `client*.js`**：契约明确只支持自包含 chunk；手写单文件最省事。
12. **改 bundle 后页面仍显示旧 UI**：immutable URL + 响应缓存；正常由 client-hmr 的
    `rebuilt` 推新 rev。若 HMR 链路被动过（client-hmr 行禁用），需刷新页面甚至重启。
13. **删 bootstrap 模块（`@deepseek-ai/dsh-client-modules`）或替换它**：页面必须重载
    （`$ACL/dsh-client-modules/lib/client.js:541,786`）。
14. **file: URL 写成裸 Windows 路径**：Node ESM 不接受 `C:\...`，要 `file:///C:/...`。
15. **把包名挂载但 profile 解析不到**：Loader import 直接失败（行 fiber 都没有），
    现象是宿主日志/启动诊断里的 import 错误；用 file: URL 或先安装。
16. **`/plugins` 只存在于有 webserver 的宿主**：模块系统/`fetchBundle` 在无 web server 时
    仍可用，但路由不注册（`$ACL/dsh-client-modules/README.zh.md:78-80`、
    `lib/index.js:545-551`）。
17. **手写 bundle 里用了 `window.setTimeout`/`fetch`**：浏览器端可用，但官方 bundle 约定
    是走 `ctx` 服务/Remote；不影响加载契约，只影响 HMR 生命周期与安全模型。

---

## 8. 交付物 / 下一步

- `skeleton/`：最小可静态校验包（`package.json` + no-op host + 手写 client + patch + `verify.mjs` + README）。
  - `node skeleton/verify.mjs` → **37/37 通过**（本机 Node v24.15.0）。
  - 同一校验器对官方已构建 bundle（`dsh-client-ui-brand-official`）**33/33 通过**，
    说明它检验的是真实契约而不是只为 skeleton 定制。
- 装配（**留给 lead / 用户**，因为要写 `~/.dsh`，超出本会话 workspace-write 沙箱）：
  见 `skeleton/README.md` 的“方式 A（file: URL 挂载）”，核心只有一步：
  在 `$PROFILE/cordis.patch.yml` 末尾追加

  ```yaml
  - insert:
      - id: preview-extra-skeleton
        name: 'file:///C:/Users/Administrator/Documents/daily/skeleton/lib/index.js'
  ```

  更完整的 lead 操作序列（PowerShell，需对 `~/.dsh` 有写权限）：

  ```powershell
  $patch = 'C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml'
  Copy-Item $patch "$patch.bak-preview-extra"          # 1. 备份
  Get-Content $patch | Select-String 'preview-extra'   # 2. 确认没有同名行（应为空）
  Add-Content $patch @'

  - insert:
      - id: preview-extra-skeleton
        name: 'file:///C:/Users/Administrator/Documents/daily/skeleton/lib/index.js'
  '@
  # 3. 保存后 2-3 秒，在页面 Console 看：
  #    [dsh-preview-extra-skeleton] client bundle applied (v0.0.1)
  #    document.documentElement.dataset.dshPreviewExtraSkeleton  === "0.0.1"
  # 回滚：Copy-Item "$patch.bak-preview-extra" $patch
  ```

  保存 → 2-3 秒 → 页面 Console 出现 `[dsh-preview-extra-skeleton] client bundle applied`。
- 正式包 `$PKG` 的落地顺序建议：
  1. 把占位 `lib/client.js` 换成真实现（可先复制 skeleton 的骨架，改成真预览注册）；
  2. 按 §4.5 修 `package.json`；
  3. `node skeleton/verify.mjs <pkg 目录>` 全绿；
  4. 再让 lead 挂 profile patch（file: URL 或安装后的裸包名）。

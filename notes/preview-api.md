# DSH 右侧栏「文档预览」扩展 API 契约

> 目的：为 `dsh-preview-extra` 新增 3D 模型（stl/obj/ply）与压缩包（zip/tar/gz…）预览，给出**能照着写代码**的契约。
> 环境：DSH `0.2.0-rc.2`，只读官方包位于 `C:\Users\you\.dsh\acl-runner\node_modules\@deepseek-ai\`。
> 结论全部来自逐行阅读发布产物 `lib/client.js`（带完整 JSDoc、行号稳定），未做浏览器运行时验证；本文所有 `file:line` 中的 `file` 见下方缩写表。

## 缩写与权威文件

| 缩写 | 路径（相对 `...\node_modules\@deepseek-ai\`） |
|---|---|
| `DP` | `dsh-client-ui-sidebar-documentpreview`（内置文档预览本体，269 KB `lib/client.js`） |
| `SR` | `dsh-client-ui-sidebar-right`（右栏 tab 系统/标题/导航） |
| `SLOTS` | `dsh-client-ui-slots/lib/index.js`（slot 注册表核心，无 React） |
| `REN` | `dsh-client-ui-renderer/lib/client.js`（slot 渲染器：props 装配、locale/store 席位） |
| `LOC` | `dsh-client-locale/lib/client.js` |
| `PRIM` | `dsh-client-ui-primitives/lib/index.js` |
| `WF` | `dsh-api-workspace-files`（Host 文件读取、上限、错误码） |
| `OIA` | `dsh-client-ui-open-in-app/lib/client.js`（`actions` / `unpreviewable` 席位现有占用者） |
| `MOD` | `dsh-client-modules/lib/client.js`（手写 bundle / chunk 加载） |
| `FILES` | `dsh-client-ui-sidebar-files/lib/client.js`（Files tab） |
| `DELIV` | `dsh-client-ui-deliverables/lib/client.js` |
| `CHAT` | `dsh-client-ui-chat/lib/client.js` |

---

## 0. 结论速览（给实现者的最短路径）

1. 内置预览是**一个 tab 类型**（`kind: "text"`，id 为 documentpreview 包名，pattern `dsh-resource://file/**`，档位 `fallback`）。所有后缀都进同一个 tab，由 **`ctx.documentPreviews` 注册表**在 tab 内部决定用哪个渲染器（`DP/lib/client.js:1051-1088`、`:6811`）。
2. 新增一种预览 = **两处注册**，同一个 `id`：
   - 元数据 `ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority, title, loading, wrap? })`（`DP/lib/client.js:333-346`）；
   - 正文 `ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({ name: "sidebar.right.tab.document", key: id, locale? }, Body))`（`DP/lib/client.js:572-575`、`:1640-1644`）。
3. **不需要**注册 `ctx.sidebarRightTabs`、不需要新 tab 类型、不需要 icon/分类注册、不需要 Host remote（`loading` 为 `text-pages`/`bytes-complete` 时由内置共享读取器代读）。
4. `loading` 三选一：`'text-pages'`（分页文本）、`'bytes-complete'`（≤ Host `maxFileBytes`=**32 MiB** 的完整字节）、`'renderer'`（正文先挂载、自己读字节）。**必填**。
5. `bytes-complete` 正文拿到的 `content` 是 `{ kind: "bytes", data: Uint8Array }`，`data` 是**完整文件原始字节**（不是包装对象、不分页）；失败时正文根本不挂载，由共享空态显示。
6. `text-pages` 正文拿到 `{ kind: "text", pages:[{offset,text,lines}], text, eof }`，是**累计前缀**，会随翻页增长。
7. 内置「不支持预览」空态的二进制后缀白名单是**静态表** `UNVIEWABLE_BINARY_EXTENSIONS`（含 zip/gz/tar…），只有在**没有注册项匹配**时才生效；注册了同后缀渲染器即自动接管，无需也无法扩展该表（`DP/lib/client.js:370-443`、`:604-609`）。
8. 3D 模型建议 `bytes-complete`（≤32 MiB）；压缩包建议 v1 先 `bytes-complete`，若需 >32 MiB 再上 `renderer` + `readBytes({range})` 分窗读取。
9. 标题沿用内置：`sidebar.right.pane.tab.title` 的 key 是 **tab 类型 id**，不是我们的渲染器 id；不为新格式注册标题（也不存在按渲染器分派的标题 slot）。文件图标来自 `classifyFileType`，`.stl/.zip` 等映射为 `"other"` 通用图标（`PRIM/lib/index.js:6207-6211`、`:6122-6179`）。
10. 打开链路无需改动：Files tab 行、聊天文件链接、deliverables 卡片、changed-files 行最终都走 `ctx.sidebarRight.openResource(address)` / `tab.actions.openResource(...)` → `text` 类型中标 → 我们的渲染器匹配后缀 → 正文按 id 分派。

---

## 1. 全景：三层结构与依赖

```
sidebarRightTabs 注册表（SR 提供）
  └─ kind:"text" 类型（id = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview"，
     patterns:["dsh-resource://file/**"], priority:"fallback", canOpen=session 地址）  DP:1079-1088
       └─ sidebar.right.pane.tab 座位，key=类型 id → TextPreview（共享外壳）      DP:6822-6851
            ├─ ctx.documentPreviews 注册表（按后缀选渲染器）                      DP:306-358, 6808-6809
            ├─ 共享读取器 textFace：read(分页) / readBytes(完整)                  DP:1147-1260
            └─ sidebar.right.tab.document keyed 子 slot（key=渲染器 id）→ 我们的正文 DP:6827-6832, 971-985
```

- `ctx.documentPreviews` 是 documentpreview 插件在 `apply` 里 `ctx.reflect.provide("documentPreviews", previews)` 发布的反射服务（`DP/lib/client.js:6808-6810`）。第三方插件的 `exports.inject` 里写 `"documentPreviews"` 即可拿到 `ctx.documentPreviews`，并在服务未就绪时由 cordis 等待（服务机制见 `cordis/lib/index.js:800-824`、依赖刷新 `:832-851`）。
- documentpreview 自己也用同样方式依赖别人的服务：`inject = ["slots","locale","sidebarRightTabs","remote","remote.workspaceFiles","configForms","resources"]`（`DP/lib/client.js:6793-6801`）。注意 `sidebarRightTabs` 是 `SR` 通过 `reflect.provide` 发布的（`SR/lib/client.js:9073`）。
- 生命周期：**两处注册都必须由 `ctx.effect` 持有**；注册函数返回幂等 disposer（`DP/lib/client.js:333-346`、README.zh.md:35）。HMR/卸载时 effect 释放。

---

## 2. `ctx.documentPreviews.register` 完整字段

```ts
ctx.documentPreviews.register(definition: {
  id: string;                    // 必填，全局唯一
  extensions: string[];          // 必填，可含复合后缀 "tar.gz"；带不带前导点都行
  binaryExtensions?: string[];   // 可选，必须是 extensions 的子集
  priority?: "extension" | "builtin" | "fallback"; // 可选，默认 "extension"
  title: () => string;           // 必填，函数，菜单/回退文案用
  loading: "text-pages" | "bytes-complete" | "renderer"; // 必填
  wrap?: boolean;                // 可选，仅 true 时显示头部换行开关
}): () => void;                  // 幂等 disposer
```

来源：`DP/lib/client.js:326-346`。逐字段语义：

### 2.1 `id`（string，必填，唯一）
- 同一注册表内重复 `id` 直接 `throw`：`documentPreviews: duplicate implementation "<id>"`（`DP/lib/client.js:334`）。HMR 场景必须靠 effect 先释放旧注册。
- id 同时是：正文 keyed slot 的 `key`（`DP/lib/client.js:971-980` 的 `entryKey`）、「打开方式」菜单项 id（`:883-891`）、`sidebar.right.tab.document.action` 的 key（`:915-918`）。建议形如 `"<包名>/<格式>"`，如 `"dsh-preview-extra/model"`。

### 2.2 `extensions`（string[]，必填）
- 后缀匹配规则：对**解码后的文件名**取最后一段（`\`/`/` 都当分隔符）→ 转小写 → 逐个后缀去前导点后小写 → 判断文件名是否 `endsWith("." + ext)`；匹配长度取**最长后缀长度**（`DP/lib/client.js:256-276`）。
- 因此 `"tar.gz"` 这种复合后缀可用，且 `"tar.gz"` 命中比 `"gz"` 长，排序更优（见 2.4）。
- 匹配对象是 `hostFileOf(tab.contentId).path` 的解码路径（`DP/lib/client.js:600-606`），即地址里的 `%20` 等已解码；大小写不敏感。
- `extensions: []` 永不匹配（`matchingDocumentPreviews` 过滤 `length > 0`，`:292-293`）。内置「纯文本兜底」正是靠这个空数组 + 被 owner 特判追加（`:606-609`）。

### 2.3 `binaryExtensions`（string[]，可选）
- 校验：每个元素归一化后必须已出现在 `extensions`，否则 `throw`：`declares binary suffix "<ext>" outside its extensions`（`DP/lib/client.js:336`）。
- 唯一效果：**抑制「纯文本」候选**。注意判定是**全局按后缀**的：`binaryDocumentPath` 扫描**所有**注册项，只要有一个实现把该后缀列为 binary，纯文本候选就被抑制（`DP/lib/client.js:301-304`、`:606`）。候选构造逻辑（`DP/lib/client.js:604-614`）：
  - `matched.length > 0 && binaryDocumentPath(path)` → 只用匹配到的注册项；
  - 否则把内置纯文本兜底**追加**到候选末尾（即菜单里多一个「纯文本」项）。
- 语义忠告：
  - `zip/gz/tar/7z/rar`：声明为 binary（内容不可读文本，避免无意义候选）；
  - `stl/obj/ply`：**不要**声明。ASCII STL/OBJ/PLY 是可读文本，保留「纯文本」候选有实际价值；二进制 STL 若用户主动选纯文本，会因 UTF-8/NUL 校验得到 `workspace-file/not-text` 空态（不崩溃）。
- `binaryExtensions` **不影响**加载方式、不影响 tab 打开、不影响图标。

### 2.4 `priority` 与竞争语义（本 registry 与 `sidebarRightTabs` 不同！）
实现只有一处：

```js
rank: definition.priority === "builtin" ? 0 : 1
.sort((l, r) => r.rank - l.rank || r.length - l.length || l.order - r.order)
```
（`DP/lib/client.js:286-294`）

- **只有 `"builtin"` 是低档**；`"extension"`（默认）与 `"fallback"` **同档**（rank 1）。想压过内置渲染器请用 `"extension"`；写 `"fallback"` 不会得到「最低」语义（与 `sidebarRightTabs` 的三档语义不同，见 `SR/README.zh.md:86`）。
- 排序：档位高者先 → 匹配后缀更长者先 → 注册顺序早者先。
- **所有匹配项都保留**，不做覆盖删除；菜单（`candidates.length > 1` 时）列出全部备选（`DP/lib/client.js:870-898`），默认选中 `candidates[0]`。用户手选结果按 tab 存在共享 store 的 `rendererId`（`DP/lib/client.js:615`、`:1306-1309`）。
- 例：要接管 `.md`，注册 `priority:"extension"` 即可排在内置 Markdown（builtin）之前，但菜单里仍能看到内置项。
- `candidates(path)` 是公开读取口（`DP/lib/client.js:347-354`），但第三方拿不到 hook；tab 正文才有 `useDocumentPreviews`（`DP/lib/client.js:6847-6850`）。

### 2.5 `title`（`() => string`，必填）
- 只在**渲染时调用**：菜单按钮文案与 `title=` 属性（`DP/lib/client.js:876,881,885`）、正文 fallback 文案插值（`:983`）。传字符串会在调用时抛错。
- 因为每次渲染重新调用，返回 `() => t("...")` 可随语言切换实时更新（locale 切换会重渲染 outlet，见 `REN/lib/client.js:513-568`）。注意「注册时捕获的文案」不会更新（`LOC/README.zh.md:137`）。

### 2.6 `loading`（枚举，必填）
- 决定共享外壳怎么读文件以及正文何时挂载（`DP/lib/client.js:615-618`、`:661-665`）：
  - `text-pages`：调用 `loadPage(tab.id, file, 1, signal, version)`（`:663`）→ Host `read` 分页文本；
  - `bytes-complete`：调用 `loadAll(...)`（`:664`）→ Host `readBytes(sessionId, path, {}, signal)` 完整文件；
  - `renderer`：调用 `prepareRenderer(...)`（`:665`）→ **不读字节**，只把 `mode/rendererId/loadRevision` 置位，正文立即挂载、自己负责读。
- 缺失/非法值的后果：`mode === undefined` → 不发起任何读取，`state` 永远不存在 → 正文区永久显示 loading 提示（`:661-665` 的 early return、`:821-828`）。**必须显式给值**。
- 切换选中的渲染器时，若 loading 模式或 rendererId 变化，会 `actions.reset` 丢弃旧内容并重读（`DP/lib/client.js:1170-1181`、`:1229-1238`）。

### 2.7 `wrap`（boolean，可选）
- 仅当 `selected.wrap === true` 时在头部渲染换行开关（`DP/lib/client.js:899-914`）。
- 与正文收到的 `wrap` prop 无关：正文拿到的是共享 store 的当前 wrap 状态（默认 `true`，`DP/lib/client.js:1279`）；声明 `wrap:false` 只是不提供开关。
- 对 canvas/3D 视图填 `false`（或留空）即可。

---

## 3. 正文注册：`sidebar.right.tab.document`

### 3.1 精确形状

```js
ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document", () =>
  ctx.slots.register(
    {
      name: "sidebar.right.tab.document",
      key: MY_RENDERER_ID,          // keyed slot：必填，且等于 documentPreviews 的 id
      locale: "myNamespace",        // 可选：声明后正文收到 t(...)（需要 locale 插件）
      // store: defineStore(...),    // 可选：声明后正文收到 useStore / actions
      // inject: (sessionId, actions) => ({ ...业务 props/hooks }), // 可选：自定义注入
      // priority: 0,                 // 可选：同 key 冲突时的遮蔽优先级（数值小者渲染）
    },
    MyBodyComponent,
  )));
```

- `ctx.slots.inject(key, cb)`：等待父级把该 slot **声明**出来后再执行 `cb`，返回 disposer；父级声明生命周期变化会自动重建（`REN/lib/client.js:1335-1402`）。**必须**用它，因为 `sidebar.right.tab.document` 由 documentpreview 声明，直接 `register` 在声明前会抛 `slot "..." is not declared`（`SLOTS/lib/index.js:163-165`）。
- `register` 返回 disposer（`SLOTS/lib/index.js:237-242`）；外层再套 `ctx.effect` 是官方写法（`DP/lib/client.js:572-575`）。
- 槽位声明（documentpreview 侧，不可改）：`{ kind:"keyed", scope:"session", inject: { hooks: { tabInfo: documentTabInfoFactory } } }`（`DP/lib/client.js:6827-6832`）。**`useTabInfo` 由槽位声明注入，不需要我们声明**（factory 原样转发外壳的 `useTabInfo`：`:1500-1507`；渲染时传入 `hookContext: useTabInfo`：`:977-980`）。
- 需要**同一父声明下未被占用的 slot 名**才能加子 slot；我们不需要子 slot。
- 同 `key` 同 `priority` 重复注册直接 `throw`（`SLOTS/lib/index.js:176-179`）；不同 priority 可遮蔽（先按 priority 升序取每个 cell 的第一个，`entriesOfSlot` `:278-293`）。

`register` options 全集与消费方（`SLOTS/lib/index.js:204-219`；`REN/lib/client.js:715-746`）：

| option | 作用 |
|---|---|
| `name` | 必填，目标 slot 名 |
| `key` / `id` | keyed slot 用 `key`；list slot 用 `id`；single/chain 各自规则 |
| `order` | list slot 显示顺序（`SLOTS:221`） |
| `priority` | 遮蔽优先级，**数值小者先渲染**（`SLOTS:168,221`） |
| `locale` | 命名空间 → 组件收到 `t`（`REN:721-725`） |
| `store` | `defineStore` 句柄 → 组件收到 `useStore(selector)` 与 `actions`（`REN:726-731`） |
| `inject` | 函数 `(sessionId, actions) => face`；`face.props` 平铺进组件 props，`face.hooks` 变成 `use<Name>`（`REN:415-439`） |
| `children` | 声明子 slot → 组件收到 `renderSlot`（`REN:732-740`） |

### 3.2 正文组件收到的 props（精确来源与类型）

渲染时 props 的合并顺序（后者覆盖前者）：`{...kit, ...entry.inject(), ...slot声明.inject.props, ...slot hook factories, ...ownerProps}`（`REN/lib/client.js:752-789`）。逐项：

| prop | 类型 | 来源 | 说明 |
|---|---|---|---|
| `resourceAddress` | `string` | owner（`DP:972`） | 即 `tab.contentId`，形如 `dsh-resource://file/session/<sid>/<路径>`（地址文法 `DP:35-95`） |
| `content` | union \| `undefined` | owner（`DP:973`） | 见 3.3。共享模式下只有非空才挂载正文（`DP:971`） |
| `wrap` | `boolean` | owner（`DP:974`） | 共享 store 的换行状态，默认 `true`（`DP:1279`） |
| `scrollportRef` | `(el: HTMLElement \| null) => void` | owner（`DP:975`） | 正文内部滚动元素挂上它；挂载时恢复共享记录的 `scrollTop`，卸载后共享正文重新成为滚动主（`DP:650-659`） |
| `addResource` | `(address: string) => void` | owner（`DP:976`） | 把依赖文件加入本 tab 的 `ResourceGroup`（自动刷新会追踪） |
| `setResources` | `(addresses: string[]) => void` | owner（`DP:977`） | 替换依赖集合，**始终保留根 Resource** |
| `useTabInfo` | hook | 槽位声明注入（`DP:6831` + `:977-980`） | 返回 `{ sidebar:{expanded,fullscreen}, panel:{id}, tab }`；`tab` 形如 `{ id, kind:"text", contentId, title, visible, navigation:{revision,params}, signal:AbortSignal, actions, refreshShortcut }`（`SR/lib/client.js:8964-9001`；记录 schema `:4941-4946`） |
| `useResource` | keyed hook | 根标准席位（`dsh-client-resources/lib/client.js:170-177`） | `useResource(address) -> { status:"none"\|"loading"\|"live"\|"failed", value?: {absolutePath, version, bytes?}, failure? }` |
| `useSessions` / `useSessionStatus` | hook | 根标准席位（`dsh-client-ui-session/lib/client.js:469-475`） | 会话列表/状态 |
| `sessionId` / `useSession` / `useProjection` | prop / hook / keyed hook | session scope（`dsh-client-ui-session/lib/client.js:121-130`、`:476`） | 本 tab 所属会话 |
| `t` | `(key, params?) => string` | `entry.locale` 声明（`REN:721-725`） | 未声明 locale 则没有 |
| `renderSlot` | 函数 | 声明了 `children` 才有（`REN:732-740`） | 我们不需要 |
| `useStore` / `actions` | selector hook / actions 对象 | 声明了 `store` 才有（`REN:726-731`） | 我们不需要（v1） |
| 自定义 props | 由 `entry.inject()` 返回 | `REN:415-439` | 例如自己的加载 face、图标等 |

> 官方 README 对正文 props 的概述一致：`resourceAddress、content、wrap、scrollportRef、addResource、setResources` + 标准 `useTabInfo`/`useResource`（`DP/README.zh.md:35`）。

### 3.3 `content` 的三种确切结构

```ts
// loading: "bytes-complete"（DP/lib/client.js:765-768）
{ kind: "bytes", data: Uint8Array }          // data 就是完整文件原始字节，无包装、无版本字段

// loading: "text-pages"（DP/lib/client.js:769-775）
{
  kind: "text",
  pages: Array<{ offset: number; text: string; lines: number }>, // 累计页，按 offset 升序
  text: string,                               // pages 按 "\n" 连接（空白行页也参与）
  eof: boolean                                // 读到文件最后一行才为 true
}

// loading: "renderer"（DP/lib/client.js:750-763）
{
  kind: "renderer",
  revision: number,                           // 本次内容加载代次
  loaded: (version: string) => void,          // 成功：记录展示的源版本并结束 loading
  failed: () => void,                         // 失败：结束 loading、不记录成功版本（下次文件变化可重试）
  reload: () => void,                         // 请求重载：revision++，正文据此取消旧请求
}
```

关键事实与坑：

- **字节是 `Uint8Array` 本身**，不是 `{data}`/`Blob`/`ArrayBuffer` 包装。Host 的 `readBytes` 经 multipart 直接回原生 `Uint8Array<ArrayBuffer>`（`WF/README.zh.md:57`；`DP/README.zh.md:57`）；仅 `data` 被透传给正文（`DP:765-768`），**没有** `offset/eof/version/absolutePath`。需要版本/绝对路径时用 `useResource(resourceAddress).value`。
- **一次性完整字节，不分页**：`readBytes(sessionId, path, {}, signal)`（`DP:6817`）没有 `range`，受 Host `maxFileBytes`（默认 **32 MiB**）限制；**超限失败而不是截断**（`WF/lib/index.js:461-466`）。
- **失败/过大时 `content` 不存在，正文不挂载**：共享外壳在 `content === undefined` 时不渲染正文 slot（`DP:971`），失败信息由共享空态负责（见 §6）。
- `text-pages` 的 `offset` 是 **1 起算的行号**；`lines` 是该页行数；`text` 是该页各行以 `\n` 连接、末尾无换行（`WF/README.zh.md:42`；`DP:451-473`、`:1359-1370`）。正文只拿到**已加载的累计前缀**，不能主动“加载更多”（按钮/滚动由共享外壳做，`DP:967`、`:1019-1028`）。
- `renderer` 模式正文在**任何字节到达前**就挂载，必须自己：读文件 → 失败自己显示 → `loaded(version)`/`failed()` → 观察 `revision` 变化取消旧请求；被替换代次的报告会被忽略（`DP:1331-1342`）。共享头部「重新读取」在 renderer 模式下就是调 `content.reload()`（`DP:711-720`、`:723-738`）。
- 内容对象每次都是 memo 生成；`bytes` 的 `data` 引用在单次读取内稳定（`DP:749-785`）。

### 3.4 正文在共享外壳中的位置/样式

- 正文被渲染在共享 `.body` 容器内（`data-textpreview-body`），该容器 `overflow:auto` 且带**等宽字体、`white-space:pre`、行高等文本样式**（`DP:956-968`、`TextPreview.module.css` 内联 CSS `DP:491`）。自定义正文（尤其 canvas）需自己 `height:100%`、`min-height:0`，必要时覆盖 `white-space/font`。
- 共享头部（`data-textpreview-path` 路径、打开方式菜单、换行、重新加载、`actions`）属于 TextPreview，不在正文内；正文**不要**再画路径/重载按钮。
- 若正文有内部滚动元素，把 `scrollportRef` 绑上去；canvas 类视图通常不需要滚动，忽略即可（共享正文滚动位仍会被记录）。

---

## 4. 标题 slot：`sidebar.right.pane.tab.title`

- 声明方：`SR` 的 `rightbar.session` 入口声明了 `sidebar.right.pane.tab.title: { kind:"keyed", scope:"session", inject:{ hooks:{ tabInfo: tabInfoFactory } } }`（`SR/lib/client.js:9154-9163`）。
- **key 是 tab 类型定义 id**，不是渲染器 id：`renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, fallback, hookContext })`（`SR/lib/client.js:5519-5565`）。
- 内置 documentpreview 的注册（**已是我们要复用的实现**）：

```js
ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register(
  { name: "sidebar.right.pane.tab.title", key: TEXTPREVIEW_ID }, // TEXTPREVIEW_ID = 包名
  TextTitle,
));
```
（`DP/lib/client.js:6852-6855`）
`TextTitle` props：标准根/session 席位之外，关键是 `useTabInfo`（槽位声明注入）；未声明 `locale`，故无 `t`，也无 `store`/`children`。渲染内容 = `FileTypeIcon({ kind: classifyFileType(tab.title), size:16 })` + `tab.title`（`DP/lib/client.js:1042-1049`；props 合成规则 `REN:752-789`）。
- **不注册时的默认标题**：`content = fallback = tab.title`（`SR/lib/client.js:5587-5595`）——即打开时由类型 `title(address)` 捕获的文本；内置 `textDefinition.title = basenameOf(address)`（解码后的 basename，`DP:1066-1087`），并被包在 `<span class="tabTitle" data-sidebar-right-tab=…>` 中（`SR:5555-5565`）。
- 对我们的格式：**不要注册标题**。标题 slot 按 tab 类型（所有文件预览共用一个 `text` 类型）分派，不存在“按后缀/渲染器分派标题”的 slot；我们注册只会撞 key 或改变*所有*文件预览的标题。
  - 若确实想给自己格式换图标，唯一办法是用同一个 key（包名字符串）以 `priority: < 0` 遮蔽内置标题（`SLOTS:168,176-179` 的规则），但这会接管所有文件预览标题、需复刻 `basename+FileTypeIcon` 行为，**不建议**。
- 标题只影响 tab 条/浮窗 chip 文本，不影响 `documentPreviews.title`（后者只用于「打开方式」菜单与 fallback 文案）。

---

## 5. locale：`ctx.locale.register` / `bind`

- API（`LOC/lib/client.js:1387-1428`）：
  - `ctx.locale.register(ns, { zh, en })` 或逐语言 `ctx.locale.register(ns, "ja", dict)`；同一 `ns + locale` 重复注册 `throw`（`:1395`）。
  - `ctx.locale.bind(ns) -> t(key, params?)`，绑定函数**身份稳定**（同一 ns 复用，`:1414-1421`），适合放进 inject。
  - 查找：本 ns 沿语言 fallback 链 → `common` ns → 原样返回 key；`params` 用 `{name}` 插值（`:1423-1428`）。
- **是否必需**：不是。
  - 元数据 `title` 可返回字面字符串（`() => "3D 模型"`）；
  - 但正文 slot 只要声明了 `locale: ns`，slot 渲染器就要求 locale face 存在，否则抛 `SlotAssemblyError`（`REN/lib/client.js:721-725`）；所以**声明 locale 就必须在 `exports.inject` 里带 `"locale"`**，且运行环境要挂载 locale 插件（内置环境默认有）。
  - 想在正文里用 `t`，才声明 `locale`。
- **命名空间隔离**：没有中央注册表，靠约定 + 重复注册抛错保护。用包名派生的 ns（如 `"dshPreviewExtra"`），**不要**复用 `sidebarDocumentPreview`/`sidebarPdf`/`sidebarImage`/`documentHtml`/`documentMarkdown`/`sidebarOffice`/`sidebarExcel`/`sidebarCodePreview`（分别被内置渲染器占用，`DP:6788,1634,4862,4983,4114,5647,5859,5085`）。`common` 是跨插件公共 ns，别往里塞私有键。
- 注册/绑定要放在 effect 里（`DP:6812-6815`；`LOC/README.zh.md:38`）；locale 切换会让 slot 组件整体重渲染，但**注册时捕获**的字符串不会更新（`LOC/README.zh.md:137`）。`documentPreviews.title` 因为每次渲染调用，能实时更新。

---

## 6. 大小上限 / 分页常量 / 超限表现

### 6.1 Host 侧（真正生效的硬上限；`WF` 配置）
`WF/lib/index.js:380-388`，文档表格 `WF/README.zh.md:60-66`：

| 常量 | 默认 | 语义 |
|---|---|---|
| `maxBytes` | `2097152`（**2 MiB**） | 单个文本页 / 单个 `readBytes` **字节窗口**的上限（含）；超出以 `too-large` 失败，不截断（`WF/lib/index.js:234-244`、`:537-551`） |
| `maxFileBytes` | `33554432`（**32 MiB**） | `readBytes` **不带 range**（完整文件）的上限（含）；超出 `too-large`（`WF/lib/index.js:461-466`） |
| `maxLines` | `5000` | 文本页默认/最大行数 |
| `maxEntries` | `2000` | 目录列举上限 |

- 文本页还拒绝**无效 UTF-8 与 NUL 字节** → `workspace-file/not-text`（`WF/lib/index.js:429`、`:619-621`）。
- `renderer` 模式可自行发 `readBytes(sessionId, path, { range: { offset, length } }, signal)`：`offset` 0 起算、`length ≤ maxBytes`；**窗口不受 maxFileBytes 限制**（`WF/README.zh.md:48-50`）。

### 6.2 documentpreview 自身常量（与自定义渲染器基本无关，供参考）
- HTML 渲染器资源包：单资源 **4 MiB**、合计 **32 MiB**、最多 **64** 个资源（`DP/lib/client.js:3852-3854`、`:3871`、`:3896-3903`）。
- Excel 解析：`excel.maxBytes` 默认 **16 MiB**、`maxCells` 250000、`timeoutMs` 15000（`DP/lib/client.js:6780-6782`、`DP/README.zh.md:79-85`）。
- Office 缓存：`maxCachedEntries` 8、`maxCachedBytes` 64 MiB、`maxPending`/`maxReaders` 8/32（`DP/lib/client.js:6774-6778`、`DP/README.zh.md:98-104`）。
- 自定义渲染器**没有** documentpreview 级别的大小开关；`bytes-complete` 只受 Host `maxFileBytes` 限制。

### 6.3 超出后的 UI 表现（共享外壳，自动生效）
- 读取失败统一落到共享 store 的 `failure`（`DP:1371-1381`），本地化文案（`DP/lib/client.js:157-165`）：
  - `workspace-file/too-large` → `error.tooLarge`，插值 `limit`（经 `humanBytes` 显示为 `32 MB` 之类，`DP:146-150`、`:160`）；
  - `workspace-file/not-text` → `error.notText`；
  - `workspace-file/not-found` / `not-regular-file` → 各自文案；
  - 其它 → `error.unavailable` + message。
- 尚无内容时：整块空态 = `FileTypeIcon` + 文案 + 出口（`DP:996-1018`）。出口按 `emptyFailureRecourse`（`DP:173-180`）：
  - `not-text` / `too-large` → **open**：渲染 `sidebar.right.tab.document.unpreviewable` 子 slot（open-in-app 按钮）；
  - `not-found` / `not-regular-file` → **none**：只给说明；
  - 其它（载体/未分类失败）→ **retry** 按钮，点击走共享 `reload`。
- 已有内容后再失败：保留内容，在内容下方/上方出现提示条 + 重试（`DP:841-861`、`:986-995`）。
- `bytes-complete` 的 32 MiB 超限就在此路径：**正文不会挂载**，用户看到「单页内容超过 32 MB 上限」+ 本地打开按钮。若新格式文件普遍 >32 MiB，应改用 `renderer` + 分窗读取，否则该格式实际不可预览。

---

## 7. 「不支持预览」空态与头部动作席位

### 7.1 静态二进制白名单（决定“已知二进制容器不支持”）
- `UNVIEWABLE_BINARY_EXTENSIONS` 常量表（`DP/lib/client.js:370-435`）包含：视频/音频、**zip/gz/tgz/bz2/xz/zst/7z/rar/tar/jar**、Office 二进制、可执行/库、字体、`dmg/iso/img/sqlite/db/psd/ai/sketch/tiff/heic/avif` 等。
- 仅在**没有注册项匹配**时生效：

```js
const matched = matchingDocumentPreviews(definitions, file.path);
if (matched.length > 0 && binaryDocumentPath(definitions, file.path)) return matched;
if (matched.length === 0 && unviewable) return matched;   // [] → 空态
const fallback = definitions.find(d => d.id === PLAIN_BODY_ID);
return fallback ? [...matched, fallback] : matched;
```
（`DP/lib/client.js:604-614`；`unviewableBinaryPath` `:441-443`）
- 结论：**注册同后缀渲染器即自动接管**，不需要也不可以扩展该表；没注册的未知后缀走纯文本兜底（可能以 `not-text` 收场）。
- 空态 UI（`DP:786-820`）：`data-textpreview-state="unsupported"`，头部 `PathLabel` + `actions` 子 slot；正文 `FileTypeIcon` + `t("unsupportedFile")`（`DP:1466` = “该格式文件暂时无法预览”）+ `unpreviewable` 子 slot。**不会发起任何读取**。

### 7.2 头部动作席位 `sidebar.right.tab.document.actions`（list）
- 声明：`{ kind:"list", scope:"session" }`（`DP:6833-6836`）。
- 渲染位置：普通正文头部的共享控件之后（`DP:953`），以及 unsupported 空态头部（`DP:798`）。
- owner props：**`{ absolutePath: string }`**（`DP:641-643`；`absolutePath = meta.value?.absolutePath ?? current?.complete?.absolutePath`）——元数据未就绪时整个 slot 不渲染。list slot 无 hookContext/owner 之外的 props。
- 注册形状：`ctx.slots.register({ name:"sidebar.right.tab.document.actions", id:"<unique>", order?: number, locale?: ns, inject? }, Component)`；list 按 `order` 升序显示（`SLOTS:221`），同 id 同 priority 冲突抛错（`SLOTS:182-185`）。
- 现有占用者：`ui-open-in-app` 以 `id:"open-in-app"`、`locale:"open-in-app"`、`inject:pathInjected` 注册 `OpenPathAction`（`OIA:866-871`），已在替所有文件头部提供“在本地打开”。**我们无需重复注册**；若要加自己的头部按钮（如 3D 的线框切换），按上面形状注册，或优先用 `.action`（见 7.4）。

### 7.3 空态动作席位 `sidebar.right.tab.document.unpreviewable`（list）
- 声明：`{ kind:"list", scope:"session" }`（`DP:6837-6840`）。
- 渲染位置：unsupported 空态（`DP:815`），以及 `not-text`/`too-large` 失败的整块空态、占据“重试”位置（`DP:1006-1017` 中 `emptyFailureRecourse(...) === "open"` 分支）。
- owner props：同样 `{ absolutePath }`。
- 现有占用者：`ui-open-in-app` 的 `OpenPathEmptyAction`（大号“用应用打开”按钮，`OIA:872-877`、`:655-660`）。**无需重复注册**。

### 7.4 单渲染器头部动作 `sidebar.right.tab.document.action`（keyed，易忽略）
- 声明：`{ kind:"keyed", scope:"session", inject:{ hooks:{ tabInfo: documentTabInfoFactory } } }`（`DP:6841-6845`）。
- 渲染位置：共享头部的换行切换之后、重新加载之前，**仅当 `content !== undefined`**（`DP:915-918`）：

```js
renderSlot("sidebar.right.tab.document.action", { content }, { entryKey: selected.id, hookContext: useTabInfo })
```
- key = **我们渲染器的 id**；owner props = `{ content }`；另有 `useTabInfo`（槽位注入）与可选 `t`/`store`/`inject`。
- 用途示例：内置 Office 用它渲染“缺失字体”警告（`DP:5667-5672`）。如果 3D/压缩包需要头部开关（线框/分栏/解压上限提示），这是正确位置——**不要**画在正文里，因为共享头部不在正文控制范围内。

---

## 8. 最小可用骨架

> 下面是**可静态校验**的最小形态：注册 `.foo` 后缀 + `bytes-complete` 正文组件，用 `React.createElement`（无 JSX）。React 通过 `require("react")`/`require("react/jsx-runtime")` 解析（内置 bundle 同样写法：`DP/lib/client.js:7-11`）。
> bundle 外壳（`window.__ModuleLoader__.load({id, factory})`、`exports.apply/exports.inject`、package.json `dsh.client`、宿主半侧、cordis.patch.yml 挂载行）见同目录 `notes/module-contract.md`；这里只保证预览 API 部分正确。

```js
// lib/client.js（节选：预览扩展部分；bundle 外壳按 module-contract 补）
window.__ModuleLoader__.load({
  id: "dsh-preview-extra",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");            // 或 const { createElement: h, useMemo } = React;
    const h = React.createElement;

    const NS = "dshPreviewExtra";              // 私有 locale 命名空间
    const FOO_ID = "dsh-preview-extra/foo";    // 渲染器 id = 正文 slot 的 key

    const zh = { "foo.title": "Foo 预览" };
    const en = { "foo.title": "Foo preview" };

    /** 正文组件：loading 为 bytes-complete 时 content = { kind:"bytes", data: Uint8Array } */
    function FooBody(props) {
      const { content, t } = props;
      if (content.kind !== "bytes") return null;   // 防御：本实现的 loading 固定 bytes；若未来切 renderer 需分支
      const summary = React.useMemo(() => {
        const data = content.data;                 // 完整文件原始字节（Uint8Array）
        const head = Array.from(data.subarray(0, 32), (b) => b.toString(16).padStart(2, "0")).join(" ");
        return data.byteLength + " bytes\n" + head;
      }, [content.data]);
      return h("div", {
        "data-foo-preview": true,
        style: {
          boxSizing: "border-box", width: "100%", height: "100%", minHeight: 0,
          padding: 12, overflow: "auto", whiteSpace: "pre",
          fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
          fontSize: 12, color: "var(--dsw-alias-label-primary)",
        },
      }, summary);
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-preview-extra: locale");

      // 1) 渲染器元数据：.foo 后缀
      ctx.effect(() => ctx.documentPreviews.register({
        id: FOO_ID,
        extensions: ["foo"],
        priority: "extension",        // 默认档；要压过 builtin 也用它
        title: () => t("foo.title"),
        loading: "bytes-complete",    // v1 最省事：content.data 是完整字节
        wrap: false,
      }), "dsh-preview-extra: preview metadata");

      // 2) 正文：等 documentpreview 声明子 slot 后按 id 挂上去
      ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document", () =>
        ctx.slots.register(
          { name: "sidebar.right.tab.document", key: FOO_ID, locale: NS },
          FooBody,
        )), "dsh-preview-extra: preview body");
    }

    exports.apply = apply;
    exports.inject = ["documentPreviews", "slots", "locale"]; // cordis 依赖：服务未就绪则等待
    return module.exports;
  },
});
```

适配 3D/压缩包时只需替换 `extensions` 与正文实现：

```js
// 3D（bytes-complete）：
extensions: ["stl", "obj", "ply"], loading: "bytes-complete", wrap: false
// 正文：const model = parseModel(tab.title, content.data); createModelView({ container, model })
//   tab.title 是打开时的 basename（textDefinition.title=basenameOf，DP:1079-1087），可直接用于按扩展名分派；
//   也可自行从 resourceAddress 解析文件名（new URL + decodeURIComponent，地址文法 DP:35-95）。

// 压缩包 v1（bytes-complete，≤32 MiB）：
extensions: ["zip", "tar", "gz", "tgz"], binaryExtensions: ["zip", "tar", "gz", "tgz"],
loading: "bytes-complete", wrap: false
// 正文：listArchive(content.data) → 渲染条目表；tree 交互用组件内 useState。
```

若压缩包需要 >32 MiB / 只读中央目录（`renderer` 模式）额外要求：

```js
// 1) exports.inject 追加 "remote", "remote.workspaceFiles"
// 2) 正文拿 content = { kind:"renderer", revision, loaded, failed, reload }
// 3) 自己发分窗读取：ctx.remote.workspaceFiles.readBytes(file.sessionId, file.path,
//      { range: { offset, length } }, AbortSignal.any([controller.signal, tab.signal]))
//    每个 length ≤ Host maxBytes（默认 2 MiB）；窗口不受 maxFileBytes 限制（WF/README.zh.md:48-50）
// 4) 成功 content.loaded(meta.version)；失败自己渲染错误并 content.failed()；
//    effect 依赖 [content.revision] 并在 cleanup 里 abort；头部“重新读取”会调 content.reload()
```

### 8.1 源码模块如何进 bundle（无构建工具的现实约束）
仓库源码是 ESM（`pkg/src/**`），客户端 bundle 是 `__ModuleLoader__.load({id, factory})` + `require`。两种可落地方式：

1. **作者期拼接**：把 `src/model/*.js`、`src/archive/*.js` 去掉 `export`/`import` 后内联进 `lib/client.js` 的 factory 闭包（最简单，无运行时分块）。
2. **包内 chunk**（官方 PDF/Excel 的做法）：`require.async("./client.model.js")`；chunk 自己注册 `__ModuleLoader__.load({ id: "<owner 包名>", chunk: "client.model.js", factory })`（证据：`DP/lib/client.js:4883`、`DP/lib/client.pdf.js:944-946`；加载规则 `MOD/lib/client.js:470-486`、`:707-741`，文件名必须匹配 `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`，chunk 以 `ownerId/client.xxx.js` 为模块 id）。

> 注意：`require.async` 只能用于**相对 chunk**或已注册模块；第三方手写 bundle 不要 `require("./model")` 之类的相对同步引用（模块表里没有），也不要 `require("@deepseek-ai/dsh-util-workspace-path")` 除非 `notes/module-contract.md` 证明它在平台模块表里。文件名解析尽量用 `tab.title` 或自写 `new URL`+`decodeURIComponent`。

### 8.2 宿主半侧要不要写
要有一个可被 Loader 挂载的 cordis 插件入口（`package.json` 的 `main`/`exports`），可以是最小 no-op：

```js
// lib/index.js（Node 半侧；documentpreview 的宿主半侧也就只做 index-inject 配置注入，DP/lib/index.js:20-33）
export function apply() {}
```

（Loader 行如何插入、`package.json` 的 `dsh.client`/`exports` 形状、编辑 `cordis.patch.yml` —— 全部见 `notes/module-contract.md`，不在此重复。）

---

## 9. 预览如何被打开 & 是否需要文件分类/图标

### 9.1 打开链路（全部无需为本特性改代码）
| 入口 | 调用 | 证据 |
|---|---|---|
| Files tab 文件行 | `tab.actions.openResource(fileAddressFor(sessionId, state.root, path))` | `FILES/lib/client.js:650`；`fileAddressFor` `:410-417` |
| 聊天里的文件链接（点击） | `ctx.sidebarRight.openResource(url[, { params:{ line } }])` | `CHAT/lib/client.js:12423-12427` |
| deliverables「Presented」卡片（点击卡片/「在侧边栏预览」） | card `onClick=onPreview` → owner `openFile(path)` → 上面的 `ctx.sidebarRight.openResource` | `DELIV/lib/client.js:1539-1554`、`:1699-1701`；`CHAT:12423-12427` |
| changed-files 对比页单文件「在侧栏打开」 | `tab.actions.openResource(fileAddressFor(sessionId, cwd, file.path))` | `DELIV/lib/client.js:1948-1962` |
| 打开 changed-files 卡片本身 | `ctx.sidebarRight.openResource(changesReviewAddress(...), { params:{ index } })` | `DELIV/lib/client.js:2287` |

- `openResource` 的认领规则：地址先按 `sidebarRightTabs` 的 `patterns` + `priority`（extension > builtin > fallback）+ 匹配长度 + 注册顺序选类型，`canOpen` 可否决；`text` 类型 `pattern: "dsh-resource://file/**"`、`priority:"fallback"`、`canOpen = parseFileAddress(address)?.scope === "session"`（`DP:1080-1088`；`SR/README.zh.md:86,93`；认领实现 `SR/lib/client.js:5250-5298`）。**`absolute` scope 地址不可预览**。
- 打开后：tab record 以 `(kind, contentId)` 去重/聚焦；`params` 进入 `navigation.params`，`revision` 递增（`SR/README.zh.md:93`）；预览的 `{ line }` 只在 `text-pages` 模式被消费（`DP:683-695`、`DP/README.zh.md:124`）。

### 9.2 是否需要额外注册分类/图标？**不需要**
- 打开能力只由上面的 tab 类型 pattern 决定；任何 session 文件都能点开，二进制容器只是显示“不支持预览”空态（§7）。**`binaryExtensions` 只是渲染器元数据，不参与“能否被点击打开”**。
- 图标来自 `PRIM.classifyFileType(path|name, context?)`（`PRIM/lib/index.js:6194-6211`），映射表 `EXTENSION_TYPES`（`:6122-6179`）里没有 3D/压缩包类别 → 返回 `"other"`（通用文件图标）；`FileTypeIcon` 可用 `{ path }` 或 `{ kind }`（`:6409-6417`）。它被内置标题（`DP:1042-1049`）、空态（`DP:1006`）、文件树复用，**没有插件扩展点**。想换图标只能遮蔽标题 slot（§4，不建议），或改上游。
- 不需要：`ctx.resources` provider、`configForms`、Host remote（`bytes-complete` 场景）、`sidebarRightTabs` 注册。

---

## 10. 风险与坑清单（按踩坑概率排序）

1. **`loading` 忘填/填错** → 正文区永久 loading、无任何读取（`DP:615-618,661-665,821-828`）。
2. **只注册元数据、忘了正文** → 菜单里选它后显示「预览器 X 不可用」（`DP:981-984`），且两处 id 必须一致。
3. **HMR/重复注册**：同 `id` 重复 `documentPreviews.register` 抛错；同 key 同 priority 重复 `slots.register` 抛错（`DP:334`；`SLOTS:176-179`）。两处都要用 `ctx.effect` 包住，靠 disposer 释放。
4. **`binaryExtensions` 写错**：必须是 `extensions` 子集，否则加载期抛错（`DP:336`）；且一旦声明，该后缀的「纯文本」候选会消失——ASCII STL/OBJ/PLY 建议**不要**声明。
5. **priority 语义不同**：`documentPreviews` 只把 `"builtin"` 降档，`"fallback"` 与 `"extension"` 等效（`DP:286-294`）；需要压过内置用 `"extension"`。
6. **32 MiB 静默天花板**：`bytes-complete` 超过 Host `maxFileBytes`（默认 32 MiB）直接失败、正文不挂载；大压缩包必须走 `renderer` 分窗，且分窗自带复杂度和自绘错误 UI。
7. **`text-pages` 只给累计前缀**：正文无法自己“加载更多”，也不能假设 `eof`；只适合纯文本类展示。
8. **renderer 模式责任转移**：没有字节、没有失败 UI、没有版本记录——必须 `loaded(version)`/`failed()`/监听 `revision`/`tab.signal` 取消，否则自动刷新与重载语义失效（`DP:711-748`、`:1331-1342`）。
9. **正文容器样式继承**：共享 `.body` 是等宽 + `white-space:pre` + overflow auto；canvas 输出要自己撑满/清空背景/`min-height:0`。
10. **换行 prop 与声明解耦**：`wrap` prop 始终是 store 当前值（默认 true），`wrap:false` 只是不显示开关；bytes 类正文忽略即可。
11. **`useResource` 的 failure 与内容 failure 不同**：元数据观察失败只影响头部提示（`DP:841-850`），不阻塞已加载内容。
12. **`actions`/`unpreviewable` 的 owner prop 是 `{absolutePath}` 且可能缺席**（元数据/complete 都还不知道绝对路径时整个 slot 不渲染，`DP:641-643`）；别把它们当作可靠的常驻挂载点。
13. **`.action` 单渲染器 slot 只在 `content` 非空时渲染**（`DP:915`），首次加载阶段没有头部按钮位。
14. **locale**：声明了 `locale` 却没 `exports.inject: ["locale"]`/环境无 locale face → 渲染期 `SlotAssemblyError`；注册时捕获的文案不随切换更新，要用 `thunk()` 形式（`title: () => t(...)`）。
15. **`sidebar.right.tab.document` 声明依赖 documentpreview 插件存活**：对方插件未挂载/被禁用时，我们的 `slots.inject` 永远等待、`documentPreviews` 服务也不存在（`exports.inject` 会让插件保持 inactive，无报错）。部署时确认 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 在组合里（它是内置预览，正常都在）。
16. **E2E 缺口**：本文基于发布产物逐行阅读，未在浏览器里验证注册后 UI（无法启动/操作 GUI 的验证不在本任务范围）。实现完成后需在真实 GUI 里用 `.zip/.stl` 文件回归 §3.3 的三种 content 与 §6.3 的超限空态。
17. **chunk 依赖解析**：`require.async("./client.x.js")` 要求所有者是 boot graph 行且 URL 组合满足 `/??<id>/client.js&rev=` 形态（`MOD:480-486`），第三方包文件名/路径要按 `notes/module-contract.md` 落地，否则运行时报错。

---

## 11. `file:line` 速查索引

| 事实 | 位置 |
|---|---|
| `documentPreviews` 注册表实现（register/candidates/snapshot） | `DP/lib/client.js:306-359` |
| 注册校验（重复 id / binary 子集） | `DP/lib/client.js:333-346` |
| 后缀归一化与最长匹配 | `DP/lib/client.js:256-276` |
| 优先级/排序（只有 builtin 降档） | `DP/lib/client.js:286-294` |
| binary 路径判定 | `DP/lib/client.js:301-304` |
| unsupported 二进制静态表 | `DP/lib/client.js:370-443` |
| TextPreview 候选构造 / 选中 / 模式 | `DP/lib/client.js:604-618` |
| 正文 slot 渲染（owner props 全部） | `DP/lib/client.js:971-985` |
| content 三种结构 | `DP/lib/client.js:749-785` |
| 共享读取器（loadPage/loadAll/renderer/reload） | `DP/lib/client.js:1147-1260` |
| 共享 store 初值 / page / complete / failed / reset | `DP/lib/client.js:1267-1398` |
| renderer 模式窗口（loaded/failed/reload） | `DP/lib/client.js:750-763`；store `:1331-1342` |
| 失败文案与出路 | `DP/lib/client.js:157-180`；空态 `:986-1018` |
| unsupported 空态 + actions/unpreviewable | `DP/lib/client.js:786-820` |
| `.action` 单渲染器头部动作 | `DP/lib/client.js:915-918` |
| 头部 wrap 开关条件 | `DP/lib/client.js:899-914` |
| documentpreview 类型定义（pattern/canOpen/title） | `DP/lib/client.js:1051-1088` |
| 子 slot 声明（keyed/list/scope/inject） | `DP/lib/client.js:6822-6851` |
| 标题 slot 注册 + TextTitle | `DP/lib/client.js:6852-6855`、`:1042-1049` |
| renderer 文档正文注册样例（含 locale/store/inject/children） | `DP/lib/client.js:1640-1645`、`:4861-4879`、`:4981-5015`、`:5639-5700`、`:5080-5099` |
| locale 服务 register/bind/translate | `LOC/lib/client.js:1387-1428` |
| slot register/declare/inject/遮蔽 | `SLOTS/lib/index.js:163-243`；`REN/lib/client.js:1335-1402` |
| props 合成（kit→inject→slot inject→owner） | `REN/lib/client.js:752-789` |
| slot locale/store 席位 | `REN/lib/client.js:715-746` |
| useTabInfo 形状 | `SR/lib/client.js:8964-9001` |
| tab 记录字段 | `SR/lib/client.js:4941-4946` |
| 标题 slot 声明 / 标题 fallback | `SR/lib/client.js:9154-9163`、`:5587-5595` |
| `openResource` 导航语义 | `SR/README.zh.md:93`；认领 `SR/lib/client.js:5250-5298` |
| Host 上限常量 | `WF/lib/index.js:380-388`；`WF/README.zh.md:60-66` |
| Host 读取实现/错误 | `WF/lib/index.js:234-244`、`:429`、`:461-466`、`:537-551` |
| open-in-app 的四个 slot 注册 | `OIA/lib/client.js:860-887` |
| Files tab / 聊天 / deliverables 打开入口 | `FILES:650`；`CHAT:12423-12427`；`DELIV:1699-1701,1948-1962,2287` |
| classifyFileType / FileTypeIcon | `PRIM/lib/index.js:6194-6211`、`:6122-6179`、`:6409-6417` |
| chunk 注册与 require.async | `DP/lib/client.pdf.js:944-946`；`MOD/lib/client.js:470-486,707-741` |

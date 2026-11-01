# skeleton/ — 最小可静态校验的手写 DSH 客户端插件

这是一个**能真正被 DSH 加载**的最小第三方客户端插件包：一个 `package.json`、一个
no-op 宿主半侧、一个手写 `__ModuleLoader__.load(...)` 浏览器 bundle，没有构建工具、
没有 npm 依赖、没有网络。可直接复制为 `dsh-preview-extra/pkg/` 的基线。

契约细节与全部 `file:line` 依据见 [`../notes/module-contract.md`](../notes/module-contract.md)。

```
skeleton/
  package.json        dsh.client 声明 + exports["./client"]（入口来自这里，见 notes §3.4）
  lib/client.js       手写 bundle：注册、apply、slot 注册、service provide（可观察）
  lib/index.js        宿主半侧 no-op（行必须能 import 到一个包，见 notes §4.2）
  cordis.patch.yml    作为 bundle 安装时的 insert 行（手动挂载时抄进 profile patch）
  verify.mjs          静态 + 模拟校验器（node 24，零依赖）
```

## 1. 校验（先跑这个，再动 profile）

本机 Node 路径：`C:\Program Files\nodejs\node.exe`。**不要**把 node 输出接到
PowerShell 管道里（`| Select-Object` 会让 node.exe 报"拒绝访问"）；直接跑或用
`>` 重定向到文件后再读。

```powershell
& 'C:\Program Files\nodejs\node.exe' .\skeleton\verify.mjs
```

期望输出（2026-11 实测，Node v24.15.0）：

```
37/37 checks passed
OK — package satisfies the hand-written client-module contract.
```

它逐项检查：`package.json`/`dsh.client` 形状、`exports["./client"]` 可解析、
bundle 是 classic script 且 `id === package.json name`、只注册一次、
`require("...")` 全部落在冻结平台表或 `dsh.client.external` 内、
`exports.inject` 覆盖用到的 `ctx.*` 服务、模拟 `apply(ctx)` 不抛错且至少做一件
可观察的事、宿主半侧可 import 且导出 `apply`。

说明：这个沙箱禁止带管道的子进程，所以校验器用 `node:vm` 在进程内解析/执行；
在普通终端里等价的额外检查是 `node --check skeleton\lib\client.js`。

校验器也可指向任意已构建的官方 bundle（本机实测
`dsh-client-ui-brand-official` 33/33 通过）：

```powershell
& 'C:\Program Files\nodejs\node.exe' .\skeleton\verify.mjs 'C:\Users\Administrator\.dsh\acl-runner\node_modules\@deepseek-ai\dsh-client-ui-brand-official'
```

## 2. 装进 desktop profile（**留给 lead / 用户执行**；本目录只写 workspace）

运行中的 profile 是 `desktop`：`C:\Users\Administrator\.dsh\profiles\desktop\`，其
`package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml` 决定启用行。往 profile
写文件在 workspace 之外，本会话的 workspace-write 沙箱不允许，因此下面步骤要由
lead 用更宽权限执行，或交给用户手动做。

### 方式 A（推荐，零安装）：用 file: URL 挂载行

不需要把包复制进 `~/.dsh`，也不需要 pnpm；唯一改动是 profile patch 里加一条行。

1. 在 `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml` **末尾**追加
   （注意缩进：顶层数组项，`insert` 列表项用 4 空格）：

   ```yaml
   - insert:
       - id: preview-extra-skeleton
         name: 'file:///C:/Users/Administrator/Documents/daily/skeleton/lib/index.js'
   ```

   - `id` 是 Loader 条目 id，随便唯一即可；
   - `name` 这一段是**宿主半侧模块的 URL**，必须是 `file:///C:/...` 形式
     （Node ESM 不接受裸 Windows 路径 `C:\...`）；
   - 真正的浏览器模块 id 是 `package.json` 的 `name`
     （`dsh-preview-extra-skeleton`），不是这个 `id`。

2. 保存后约 2–3 秒生效（base 组合包默认启用 profile 配置 HMR，它会 watch 这个文件；
   `awaitWriteFinish` 有约 2 秒稳定窗口）。HMR 启用时无需重启 DSH、无需刷新页面；若该
   宿主的 `hmr` 行被禁用，则重启 DSH 后刷新页面。
3. 打开 GUI 的 DevTools Console，应看到：

   ```
   [dsh-preview-extra-skeleton] client bundle applied (v0.0.1)
   ```

   并且 `<html>` 上有 `data-dsh-preview-extra-skeleton="0.0.1"`，
   可在 Console 里验证：

   ```js
   window.__DSH_BOOT__.entries.map(e => e.id)          // 应含 "dsh-preview-extra-skeleton"
   document.documentElement.dataset.dshPreviewExtraSkeleton
   window.__ModuleLoader__                               // mode 已从 queue 变 live
   document.querySelectorAll('script[src*="plugins/??"]').length // 1+ 个 combo 脚本
   ```

   在页面内（同源）可以取自己的 bundle 看路由形态：

   ```js
   await (await fetch("plugins/??dsh-preview-extra-skeleton/client.js&rev=" +
     window.__DSH_BOOT__.entries.find(e => e.id === "dsh-preview-extra-skeleton").rev)).text()
   ```

### 方式 B：按包名挂载（包已在 profile 的解析范围内）

`name: 'dsh-preview-extra-skeleton'` 只有在 profile 能解析到该包时可用。最轻量的
无网络做法是把包目录做成 junction 放进 profile 的 node_modules（不推荐，pnpm 安装
可能清掉它）；正规做法是 `dsh plugin --profile desktop add <本地路径>`（需要 pnpm，
本机离线时不一定可行）。file: URL 方式没有这些前提，优先用方式 A。

### 卸载 / 回滚

删除 profile patch 里那条 `- insert:` 块（或把它 `disabled: true`），保存即卸载；
浏览器侧会回收该 fiber 注册的 slot/service。若 bundle 内容曾经出错并留下缓存，
再刷新一次页面。

## 3. 生效后能看到什么 / 看不到什么

- 能看到：Console 一行日志、`<html>` data 属性、`previewExtra` service
  （其他客户端插件可 `inject: ["previewExtra"]` 拿到
  `{ id, version }`）、一个等待 `sidebar.right.tab.document` 声明后注册的
  keyed body 槽位（骨架没有注册任何 preview 类型，所以这个 body 永远不会被选中，
  不会污染侧栏）。
- 看不到：任何新 tab / 新按钮。真实预览插件在 `apply` 里需要
  `ctx.documentPreviews.register({ id, extensions, ... })` 且用**同一个 id** 作为
  slot `key`；API 细节见 [`../notes/preview-api.md`](../notes/preview-api.md)。

## 4. 提成正式包时的改名清单

本骨架叫 `dsh-preview-extra-skeleton`，与 `dsh-preview-extra/pkg/` **不是**同一个包，
两者同时挂载不会冲突（包名不同）。若把它并入 `pkg/`：

1. `package.json` 的 `name` 改成 `dsh-preview-extra`；
2. `lib/client.js` 里 `load({ id: ... })` 的 id 改成**同一个**字符串
   （不一致 = 浏览器报 `loaded without registering "<id>"`）；
3. profile patch 的 `id`/`name` 指向新包，并删掉骨架那条行。

**绝不要同时挂载两个解析到同名包的行**：`dsh-client-modules` 会把"同一包名来自多个
active Loader source"当作组合错误，整个客户端图组不出来
（`dsh-client-modules/lib/index.js:871-877`）。

# dsh-preview-extra — DSH 右侧栏文档预览扩展

给 DSH（DeepSeek Harness 0.2.0-rc.2）右侧栏的**文档预览**加 5 类格式族：
**3D 模型（STL/OBJ/PLY）**、**压缩包（zip/tar/gz）**、**音视频**、**字体**、**字幕**。
纯客户端插件、零第三方依赖、无网络；已安装进当前 `desktop` profile 并完成真实 GUI 端到端验证。

## 状态

| 项目 | 结果 |
| --- | --- |
| 构建产物 | `pkg/lib/client.js`（约 230 KiB，15 个内部模块，单文件 classic script） |
| 契约静态校验 | `skeleton/verify.mjs` → **34/34** |
| 组装后冒烟（假 React + 假 Cordis ctx） | `tools/smoke.mjs` → 全部通过（5 个 body 用真实 fixture 渲染） |
| 解析器单测 | 3D **38/38**、压缩包 **28/28** |
| 真实 GUI E2E（无头 Chrome + CDP） | STL 3D、ZIP 条目树 + 条目文本、TTF 字体样张、WAV 播放器、SRT 字幕、7z 不支持提示 —— 全部正常，截图见 `shots/` |
| 当前 desktop profile | 已安装（`~/.dsh/profiles/desktop`），客户端 bundle 已由运行中的 DSH 在 `/plugins` 提供，页面刷新即可用 |

## 截图（真实 GUI，无头 Chrome + CDP 驱动）

| 3D 模型（STL） | 压缩包条目树 |
| --- | --- |
| ![STL 3D 预览](shots/03-stl-preview.png) | ![ZIP 条目树](shots/04-zip.png) |

| ZIP 内条目文本 | 音频播放器 |
| --- | --- |
| ![ZIP 条目文本](shots/05-zip-entry.png) | ![音频播放器](shots/07-audio.png) |

| SRT 字幕 | 7z 不支持提示 |
| --- | --- |
| ![SRT 字幕](shots/08-subtitle.png) | ![7z 提示](shots/06-7z-unsupported.png) |

## 目录

```
dsh-preview-extra/
  pkg/                  ← 可安装的插件包（package.json + lib + src + cordis.patch.yml + README）
  scripts/install.mjs   ← 安装/卸载到任意 profile（复制包 + 追加 patch 行）
  tools/smoke.mjs       ← 无浏览器冒烟：加载真实 bundle 并渲染 5 个 body
  tools/cdp.mjs         ← 无头 Chrome CDP 驱动（导航/求值/截图）
  tools/probe-bundle.mjs← 探测某个 DSH 实例是否已提供本插件 bundle
  tools/fixtures-gen.mjs← 生成 E2E 样例文件（STL/OBJ/PLY/ZIP/TAR/GZ/WAV/SRT…）
  notes/                ← 逆向文档：module-contract.md（客户端插件契约）、preview-api.md（预览扩展契约）
  skeleton/             ← 手写客户端插件最小骨架 + verify.mjs 契约校验器（来自契约调研）
  shots/                ← E2E 截图
```

`_fixtures/`（样例文件）与 `_dsh_test/`（隔离测试用 DSH_HOME）属于本地测试产物，已在 `.gitignore` 中排除，
需要时用 `tools/fixtures-gen.mjs` 重新生成。

## 快速使用

1. 在 DSH 右侧栏点「文件」tab（或聊天里的文件/交付物卡片）；
2. 点开以下任意文件即可看到新预览：`.stl`、`.obj`、`.ply`、`.zip`、`.tar`、`.tar.gz`、
   `.mp3`/`.wav`/`.mp4`/`.webm`、`.ttf`/`.otf`/`.woff2`、`.srt`/`.vtt`/`.ass`；
3. `.7z`/`.rar`/`.xz`/`.bz2`/`.zst` 会显示"暂不支持，请先解压为 zip/tar"的提示。

> `.cpp` / `.h` / `.hpp` / `.cc` / `.cxx` 等 C/C++ 后缀**内置代码预览本来就支持**（带语法高亮），
> 本插件没有重复注册它们。

## 重新构建 / 安装 / 回滚

```powershell
$node = 'C:\Program Files\nodejs\node.exe'
& $node .\pkg\scripts\build-client.mjs                    # 改过 src 后重新打包
& $node .\tools\smoke.mjs                                 # 冒烟
& $node .\skeleton\verify.mjs .\pkg                       # 契约校验
& $node .\scripts\install.mjs --profile-dir "$env:USERPROFILE\.dsh\profiles\desktop"           # 安装
& $node .\scripts\install.mjs --profile-dir "$env:USERPROFILE\.dsh\profiles\desktop" --uninstall # 卸载
```

desktop profile 的原始 patch 备份：
`~/.dsh/profiles/desktop/cordis.patch.yml.bak-before-preview-extra`。

## 测试用 DSH 实例（E2E）

```powershell
$env:DSH_HOME = 'C:\Users\Administrator\Documents\daily\_dsh_test'
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\Administrator\.dsh\acl-runner\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile test --no-open --port 1891
# 终端会打印带 token 的 URL；无头 Chrome 已可用 CDP 驱动：
& 'C:\Program Files\nodejs\node.exe' .\tools\cdp.mjs new "<带 token 的 URL>"
& 'C:\Program Files\nodejs\node.exe' .\tools\cdp.mjs eval "document.body.innerText.slice(0,500)"
& 'C:\Program Files\nodejs\node.exe' .\tools\cdp.mjs shot .\shots\screen.png
```

## 已知限制

- 完整字节加载受宿主 32 MiB 上限；超大文件走内置"无法预览/本地打开"。
- 压缩包：5000 条目 / 单条目 32 MB / 累计 128 MB 限额；文本条目最多 200 KB。
- 7z/rar/xz/bz2/zst 仅识别提示；分卷 ZIP、加密 ZIP 条目不可读（显示原因）。
- 音视频编解码依赖浏览器；MKV/MOV 视编码而定。
- 3D：Canvas2D 软件渲染，无 WebGL；>30 万三角形自动降级；PLY 仅 little-endian；不支持 3MF/GLB/FBX/STEP。
- 字幕：ASS/SSA 样式与定位忽略；1 MB / 3000 条上限。
- 字体：不解析字形表；TTC 可能加载失败。

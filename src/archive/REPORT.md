# 压缩包预览模块报告（task-4 / archive-reader）

无依赖、纯 ESM、浏览器与 Node 24 通用的归档解析模块，位于 `dsh-preview-extra/src/archive/`。
库代码只使用 Web 标准 API（`DecompressionStream` / `TextDecoder` / `Uint8Array` / `Date`），
**不 import 任何外部包、不 import `node:*`**，只有命名导出（无 `export default`、无 `export {}` 列表），
同目录相对路径 `from './xxx.js'`，便于 lead 的简易 ESM→CJS 拼接脚本静态提取。

## 1. 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 统一 API（list/read/buildTree + UI 辅助的具名再导出） |
| `zip.js` | EOCD / ZIP64 / 中央目录 / 条目解压（stored、deflate） |
| `tar.js` | ustar（含 prefix）、GNU 长名 `L`/`K`、PAX `x`/`g`、稀疏文件提示 |
| `gzip.js` | gzip 头解析（原始名、mtime）、gzip 解压 + 解压缓存 |
| `detect.js` | 魔数嗅探 + 扩展名兜底，返回 `{format, supported, hint}` |
| `util.js` | 字节读取、名称/文本解码（UTF-8/GBK/latin1）、CRC32、`formatBytes` |
| `inflate.js` | `DecompressionStream` 流式解压 + 字节上限（超限截断不抛错） |
| `tests/run-tests.mjs` | 28 项单元测试（纯手工构造 fixture） |
| `tests/fixtures.mjs` | zip/tar/gzip 构造器（测试专用，允许 `node:zlib`） |
| `tests/realworld-check.mjs` | 可选：真实归档 vs 系统工具解压结果逐字节比对 |

## 2. 接口签名

```js
// 列出条目；不支持/无法识别返回 supported:false + hint（不抛错）
listArchive(bytes, options?) -> Promise<{
  format: 'zip'|'tar'|'tar.gz'|'gzip'|'7z'|'rar'|'xz'|'bz2'|null,
  supported: boolean,
  hint: string,                 // 面向用户的提示（不支持格式时说明原因与替代方案）
  entries: Entry[],
  truncated: boolean,           // 条目数触顶 / 容器截断
  notes: string[],              // 截断、编码兜底、超限等可读说明
  totalEntries: number, declaredTotalBytes: number,
}>
// 解出单个条目；加密条目抛 ArchiveError(code='ENCRYPTED')
readEntry(bytes, entry, options?) -> Promise<{
  bytes: Uint8Array,
  truncated: boolean,
  textualHint: 'text'|'image'|'binary'|'empty'|'unknown',  // 给 UI 选文本/图片/下载视图
  mime: string|null,
  note?: string, crcOk?: boolean|null,
}>
readEntryText(bytes, entry, options?) -> Promise<{text, encoding, looksBinary, ...readEntry}>
buildTree(entries) -> {name, path, dir, size, mtime, children, entry}  // 根节点 path=''
formatBytes(n) -> string
utf8OrLatin1(bytes) -> string          // 合法 UTF-8 直出，否则 latin1 无损兜底
classifyContent(bytes) -> {kind: 'empty'|'text'|'image'|'binary', mime}
isProbablyText(bytes) -> boolean
decodeTextBytes(bytes, {maxBytes}) -> {text, encoding}
detect(bytes, filename?) -> {format, supported, hint, source, extension}
resetBudget(bytes)                     // 切换文件/同 buffer 重列时清空累计解压预算
DEFAULT_LIMITS = {maxEntries: 5000, maxEntryBytes: 32MB, maxTotalBytes: 128MB}
ArchiveError (class, 含 code: BAD_ZIP|BAD_GZIP|ENCRYPTED|UNSUPPORTED_METHOD|BAD_ENTRY
             |BAD_ENTRY_DATA|BAD_LOCAL_HEADER|PARSE_FAILED|NO_DECOMPRESSION …)
```

`Entry` 字段：
- 公共：`index, path, dir, size, compressedSize, mtime(ms|null), encrypted, method, container,`
  `type(tar 有 file/dir/symlink/hardlink/sparse/…), linkname, mode, nameEncoding, note?`
- zip 额外：`crc32, methodId, flags, utf8, localHeaderOffset, externalAttrs, zip64`
- 内部路由字段 `container`：`'zip' | 'tar' | 'gzip-tar' | 'gzip-raw'`（readEntry 依据它选择解压路径）

限制可用 `options.maxEntries / maxEntryBytes / maxTotalBytes` 或 `options.limits` 覆盖；
`readEntry` 的累计预算按 **同一 Uint8Array 对象** 记账（WeakMap），跨文件互不影响。

## 3. 实现要点

- **zip**：从尾部扫描 EOCD（先严格匹配注释长度正好到文件尾，再容忍尾部垃圾）；遇
  `0xFFFF/0xFFFFFFFF` 哨兵值时读 ZIP64 EOCD locator/record；CD 逐项解析
  （name/extra/comment、通用 flag：加密 0x0001、data descriptor 0x0008、UTF-8 0x0800，
  extAttr 的 DOS 目录位 0x10 与 Unix mode 目录位，DOS mtime + 扩展时间戳 0x5455 优先）；
  ZIP64 额外字段 `0x0001` 按「未压缩大小→压缩大小→本地头偏移→分卷号」顺序只消费哨兵项。
  `readEntry` 读本地头求真实数据起点，用 CD 的 `compressedSize` 切片（data descriptor 以 CD 为准），
  method 8 用 `DecompressionStream('deflate-raw')`，method 0 直读，并复核 CRC32。
- **tar**：512 字节块，双校验和（有符号/无符号）校验；`ustar` prefix 拼接；GNU `L`/`K` 长名/长链接；
  PAX `x`/`g` 记录解析（path/linkpath/size/mtime，size 同时决定数据区步长）；类型
  file/dir/symlink/hardlink/char/block/fifo/sparse；数据越界返回 truncated+notes 而非抛错。
- **gzip**：`1F 8B` 识别，解析 FEXTRA/FNAME/FCOMMENT/FHCRC 与 mtime；`DecompressionStream('gzip')` 解压；
  解压结果以 `ustar` 魔数判定是否为 tar（`.tar.gz`/`.tgz` → format `'tar.gz'`，否则单文件 `'gzip'`）。
  解压结果用 WeakMap 缓存，重复预览条目不重复解压容器。
- **detect**：zip(50 4B 03 04 / 空包 / 分卷)、gzip(1F 8B)、7z(37 7A BC AF 27 1C)、rar(52 61 72 21)、
  xz(FD 37 7A 58 5A 00)、bz2(42 5A 68)、tar(偏移 257 `ustar\0` 或 `ustar `)；魔数优先，扩展名兜底。
  7z/RAR/xz/bzip2 返回 `supported:false` + 中文 hint（说明浏览器端无内置解压 API）。
- **文本/文件名解码**：文件名先严格 UTF-8 判定（未置 0x800 也常是 UTF-8），失败再 GBK（中文 Windows
  工具常见），最后 latin1 兜底，并把 `nameEncoding` 写进入口、在 `notes` 汇总提示。
  文本预览按 BOM（UTF-8/UTF-16LE/BE）→ 严格 UTF-8 → GBK → latin1 解码。
- **防 zip bomb**：条目数 5000；单条解压 32MB（流式读取到上限即 `cancel()`，返回前缀 + `truncated`）；
  同一归档累计 128MB；`listArchive` 对声明总量超限追加 note。全部超限路径都不抛死。
- **mtime**：DOS 时间无时区，按本地时间解释以保持"墙上时间"与资源管理器一致；zip 若有 0x5455 扩展
  时间戳则优先（UTC 秒）；tar/PAX 用秒级（可带小数）时间戳。

## 4. 测试

命令（Windows / Node v24.15.0）：

```powershell
& 'C:\Program Files\nodejs\node.exe' dsh-preview-extra\pkg\src\archive\tests\run-tests.mjs
```

结果：**28/28 passed**（exit 0）。

```
archive module tests — Node v24.15.0
limits: maxEntries=5000, maxEntryBytes=32.0 MB, maxTotalBytes=128.0 MB

  ok   库代码只依赖 Web 标准 API（无 node:*、无 default export、同目录 .js import）
  ok   detect: zip / tar / gzip / tar.gz 魔数识别
  ok   detect: 7z / rar / xz / bz2 识别为不支持并给出 hint
  ok   detect: 无魔数时用扩展名兜底（.zip / .tar）
  ok   zip: stored 条目列举与读取（CRC 校验通过）
  ok   zip: deflate 条目解压后字节一致
  ok   zip: 目录条目（名字以 / 结尾 + MS-DOS 目录属性）
  ok   zip: 文件名 UTF-8 flag / 未置位 UTF-8 / GBK 兜底
  ok   zip: 加密条目只标记，readEntry 抛可读 ArchiveError(ENCRYPTED)
  ok   zip: 不支持的压缩方法给出可读错误
  ok   zip: data descriptor 场景以中央目录大小为准
  ok   zip: ZIP64 哨兵值 + 0x0001 扩展字段
  ok   空 zip: 0 条目不报错
  ok   tar: 目录 / 文件 / 符号链接条目，内容与 mtime 正确
  ok   tar: GNU 长名（L）与 PAX（x）路径覆盖
  ok   tar: ustar prefix 字段拼接长路径
  ok   tar: 归档被截断时返回 truncated + notes，不抛死
  ok   tar.gz: 自动解压并按 tar 列举、读取条目
  ok   gzip: 单文件（原始名 / mtime / 内容）
  ok   限制: 条目数上限 maxEntries
  ok   限制: 单条目解压上限 maxEntryBytes（返回截断而非抛错）
  ok   限制: 累计解压上限 maxTotalBytes
  ok   不支持的格式：listArchive 返回 supported:false + hint，不抛错
  ok   损坏的 zip：抛可读 ArchiveError(BAD_ZIP) 而不是崩溃
  ok   buildTree: 嵌套树结构 + 目录优先排序
  ok   readEntryText: UTF-8 文本解码 + 图片判定
  ok   utf8OrLatin1 / formatBytes / classifyContent 辅助函数
  ok   decodeTextBytes: GBK 字节兜底解码

28/28 passed
```

真实归档交叉验证（`tests/realworld-check.mjs` + 系统工具解压结果逐字节比对）：

| 归档 | 格式 | 条目 | 结果 |
| --- | --- | --- | --- |
| `car_shell/.../gltf2.schema.zip` (24KB) | zip | 33 | compared=33, mismatched=0, missing=0 |
| `_robotzip/robot.zip` (24MB, 中文文件名) | zip | 2 | compared=2, mismatched=0（GBK 文件名还原正确，见下） |
| `_downloads/rea-main.tar.gz` (8.4MB) | tar.gz | 3343 | compared=3036, mismatched=0, missing=0 |

robot.zip 特别值得记录：该 zip 的文件名是 **GBK 编码但未置 UTF-8 flag**。Windows 自带
`Expand-Archive` 会把它解成 `����1��2026���...docx`（U+FFFD 乱码）；本模块按 GBK 兜底解出
`附件1：2026年上海市青少年机器人知识与实践比赛规则.docx`，用 .NET `ZipFile` + CP936 解压后
文件名与内容均逐字节一致（compared=2, mismatched=0）。

## 5. 已知限制 / 风险

1. **不支持的压缩算法**：ZIP 内 method ≠ 0/8（bzip2/lzma/deflate64/zstd/xz/ppmd）只列举、
   `readEntry` 抛 `UNSUPPORTED_METHOD`；7z/RAR/xz/bzip2 整体只识别并给 hint，不能预览。
   加密 ZIP（含 AES）只标记、不解密。
2. **ZIP64 为"最小支持"**：EOCD 哨兵值 + 0x0001 扩展字段已覆盖；分卷/多磁盘 ZIP 未做拼接
   （`diskStart≠0` 只记录不处理），SFX（自解压 exe 前置数据）未做偏移修正。
3. **tar 稀疏文件（`S`）、设备/管道条目**只给提示；tar 尾部无结束零块时按"可能截断"提示，
   部分非标准写入器可能造成误报（不影响列举）。
4. **gzip**：仅保留首个 member（多 member 拼接的 `.gz` 只解析第一卷内容）；.tar.gz 的解压
   结果默认计入 128MB 预算，超大包会截断并在 notes 提示。
5. **内存**：`listArchive` 不复制归档字节；`.tar.gz` 需在内存中解出完整 tar（受 128MB 上限约束）；
   单条目上限 32MB 超出即截断。这些上限都可通过 `options` 调大（注意浏览器内存）。
6. **mtime**：DOS 时间按本地时区解释（体积小、显示直观），与 UTC 严格换算相差时区偏移；
   精确时间可用 zip 0x5455 扩展字段 / tar mtime。
7. **编码兜底**：GBK 依赖 `TextDecoder('gbk')`（现代浏览器与 Node full-icu 均支持）；不可用时
   退化为 latin1 并在 notes 说明。文件名中"既是合法 UTF-8 又是 GBK"的歧义按 UTF-8 处理。
8. **解压预算按字节对象记账**：若调用方每次传新的 `Uint8Array` 副本，累计 128MB 预算会重置
   （单条目上限仍生效）；需要跨调用控制总量时保留同一个 buffer，或调 `resetBudget` 主动重置。
9. 未做流式/分块读取（UI 场景整包字节已在内存）；未实现写盘、解压到目录等能力（只读预览）。

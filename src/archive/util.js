// archive/util.js — 字节读取、名称/文本解码、CRC32。
// 只依赖 Web 标准 API（TextDecoder / Uint8Array / Date），浏览器与 Node 24 通用。
// 注意：本目录下所有库文件都不得 import 'node:*'。

/** 归档解析错误：携带可读中文 message 与稳定的 code，便于 UI 分类展示。 */
export class ArchiveError extends Error {
  constructor(message, code = 'ARCHIVE_ERROR') {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

/** 把 Uint8Array / ArrayBuffer / 其它视图统一成 Uint8Array（不复制）。 */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input && typeof input.byteLength === 'number') return new Uint8Array(input);
  throw new ArchiveError('期望 Uint8Array 或 ArrayBuffer 作为归档数据', 'BAD_INPUT');
}

// —— 小端读取（ZIP / gzip 用） ——
export function readU16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
export function readU32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
/** 64 位小端 → Number（JS 安全整数上限 2^53；归档实际不会超过）。 */
export function readU64(b, o) {
  return readU32(b, o) + readU32(b, o + 4) * 0x100000000;
}

// —— 大端读取（tar 的 base-256 数值扩展用） ——
export function readU16BE(b, o) {
  return (b[o] << 8) | b[o + 1];
}
export function readU32BE(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export function concatBytes(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 按 UTF-8 解码，失败返回 null（fatal 模式可用来判定是否合法 UTF-8）。 */
const decoderCache = new Map();
export function getDecoder(label, fatal = false) {
  const key = `${label}|${fatal}`;
  if (decoderCache.has(key)) return decoderCache.get(key);
  let decoder;
  try {
    decoder = new TextDecoder(label, { fatal });
  } catch {
    decoder = null; // 环境不支持该编码（如部分精简 ICU 的 GBK）
  }
  decoderCache.set(key, decoder);
  return decoder;
}

function tryDecode(label, bytes, fatal) {
  const decoder = getDecoder(label, fatal);
  if (!decoder) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** 真 latin1（字节 → 同码点字符，不经过 windows-1252 映射）。 */
export function latin1(bytes) {
  let out = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return out;
}

/**
 * 归档条目名解码。
 * ZIP 规范：通用标志位 0x800 置位表示 UTF-8，否则名义上是 CP437。
 * 现实：大量工具不置位却写 UTF-8（甚至 GBK），所以策略是
 *   严格 UTF-8 成功 → 采用；否则 GBK（中文环境最常见）；再否则 latin1 兜底。
 * 返回 { name, encoding }，encoding 会写进 entry.nameEncoding，便于 UI 说明。
 */
export function decodeFileName(bytes, { utf8Flag = false } = {}) {
  const b = toBytes(bytes);
  if (b.length === 0) return { name: '', encoding: 'utf-8' };
  const asUtf8 = tryDecode('utf-8', b, true);
  if (asUtf8 !== null) return { name: asUtf8, encoding: 'utf-8' };
  if (utf8Flag) {
    // 标志位说 UTF-8 但字节非法：宽松解码，保住可读部分
    return { name: tryDecode('utf-8', b, false) ?? latin1(b), encoding: 'utf-8-lossy' };
  }
  const asGbk = tryDecode('gbk', b, true);
  if (asGbk !== null) return { name: asGbk, encoding: 'gbk' };
  return { name: latin1(b), encoding: 'latin1' };
}

/** 统一规范化条目路径：反斜杠转正斜杠、去掉 "./" 前缀、折叠重复斜杠。 */
export function normalizeEntryPath(raw) {
  let p = String(raw ?? '');
  p = p.replace(/\\/g, '/');
  p = p.replace(/^\.\/+/, '');
  p = p.replace(/\/{2,}/g, '/');
  const isDir = /\/$/.test(p);
  if (isDir) p = p.replace(/\/+$/, '');
  return { path: p, trailingSlash: isDir };
}

/** 文本预览解码：BOM 优先，其次严格 UTF-8，再 GBK，最后 latin1。 */
export function decodeTextBytes(input, { maxBytes = 4 * 1024 * 1024 } = {}) {
  let b = toBytes(input);
  if (b.length > maxBytes) b = b.subarray(0, maxBytes);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: tryDecode('utf-8', b.subarray(3), false) ?? '', encoding: 'utf-8' };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: tryDecode('utf-16le', b.subarray(2), false) ?? '', encoding: 'utf-16le' };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: tryDecode('utf-16be', b.subarray(2), false) ?? '', encoding: 'utf-16be' };
  }
  const asUtf8 = tryDecode('utf-8', b, true);
  if (asUtf8 !== null) return { text: asUtf8, encoding: 'utf-8' };
  const asGbk = tryDecode('gbk', b, true);
  if (asGbk !== null) return { text: asGbk, encoding: 'gbk' };
  return { text: latin1(b), encoding: 'latin1' };
}

/** 粗略判断字节内容是否适合按文本预览（含 NUL 或控制字符比例高 → 二进制）。 */
export function isProbablyText(input) {
  const b = toBytes(input);
  const n = Math.min(b.length, 4096);
  if (n === 0) return true;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return false; // UTF-16 文本会用 BOM 通道识别，这里按二进制处理
    if (c < 0x09) return false;
    if ((c > 0x0d && c < 0x20) || c === 0x7f) ctrl++;
  }
  return ctrl / n < 0.02;
}

/**
 * 轻量文本解码：合法 UTF-8 → UTF-8，否则 latin1（字节一一映射，不会丢字节）。
 * 给 UI 做“未知编码文本”的兜底展示；不尝试 GBK（那需要 decodeTextBytes）。
 */
export function utf8OrLatin1(input) {
  const b = toBytes(input);
  const strict = tryDecode('utf-8', b, true);
  return strict !== null ? strict : latin1(b);
}

const IMAGE_SIGNATURES = [
  { mime: 'image/png', sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', sig: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', sig: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', sig: [0x42, 0x4d] },
];

/**
 * 内容类型判定（给 UI 决定用文本 / 图片 / 下载态展示）。
 * @returns {{kind: 'empty'|'text'|'image'|'binary', mime: string|null}}
 */
export function classifyContent(input) {
  const b = toBytes(input);
  if (b.length === 0) return { kind: 'empty', mime: null };
  for (const item of IMAGE_SIGNATURES) {
    let hit = true;
    for (let i = 0; i < item.sig.length; i++) {
      if (b[i] !== item.sig[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { kind: 'image', mime: item.mime };
  }
  // WebP: "RIFF" + 4 字节长度 + "WEBP"
  if (b.length >= 12 && latin1(b.subarray(0, 4)) === 'RIFF' && latin1(b.subarray(8, 12)) === 'WEBP') {
    return { kind: 'image', mime: 'image/webp' };
  }
  // PDF 等文档虽然二进制，但预览器可按文本/专用渲染处理
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return { kind: 'binary', mime: 'application/pdf' };
  }
  return isProbablyText(b) ? { kind: 'text', mime: null } : { kind: 'binary', mime: null };
}

// —— CRC32（ZIP 校验用，查表实现） ——
let crcTable = null;
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}
export function crc32(bytes) {
  if (!crcTable) crcTable = makeCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 人类可读的大小，用于 notes / 错误信息。 */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '未知';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 目录树排序：目录优先，再按名称码点排序（跨环境结果稳定）。 */
export function compareTreeNodes(a, b) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

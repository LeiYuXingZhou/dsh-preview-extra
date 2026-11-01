// archive/tar.js — tar 解析：ustar（含 prefix）、GNU 长名（'L'/'K'）、PAX（'x'/'g'）。
// 只做只读列举与内容提取；遇到稀疏文件（'S'）给出提示，按普通文件尽力展示。

import { decodeFileName, formatBytes, latin1, normalizeEntryPath, toBytes } from './util.js';

const BLOCK = 512;

const TYPE_NAMES = {
  '0': 'file',
  '\0': 'file',
  '': 'file',
  '7': 'file', // contiguous
  '1': 'hardlink',
  '2': 'symlink',
  '3': 'char',
  '4': 'block',
  '5': 'dir',
  '6': 'fifo',
  D: 'dir',
  M: 'other',
  V: 'other',
  S: 'sparse',
};

/** 判断是否 tar：偏移 257 处有 "ustar" 魔数，或开头是连续的 0 块（空归档）。 */
export function isTar(input) {
  const b = toBytes(input);
  if (b.length >= 263) {
    const magic = latin1(b.subarray(257, 263));
    if (magic === 'ustar\0' || magic === 'ustar ') return true;
  }
  if (b.length >= 1024) return isZeroBlock(b.subarray(0, BLOCK)) && isZeroBlock(b.subarray(BLOCK, 2 * BLOCK));
  return false;
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/**
 * 计算 tar 头部校验和：校验和字段（148..156）按规范视为 8 个空格参与计算。
 * 同时返回无符号/有符号两种结果，兼容历史实现。
 */
function blockChecksum(block) {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const c = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += c;
    signed += c > 127 ? c - 256 : c;
  }
  return { unsigned, signed };
}

/** tar 数值字段：八进制 ASCII；若首字节高位为 1 则是 GNU base-256 大端数值。 */
function parseNumericField(block, offset, length) {
  if (block[offset] & 0x80) {
    let v = block[offset] & 0x7f;
    for (let i = 1; i < length; i++) v = v * 256 + block[offset + i];
    return v;
  }
  const s = latin1(block.subarray(offset, offset + length)).replace(/[\0 ]+$/g, '').trim();
  if (!s) return 0;
  const v = parseInt(s, 8);
  return Number.isFinite(v) ? v : 0;
}

/** 取 NUL 结尾的 tar 字符串字段并解码（UTF-8 优先，GBK/latin1 兜底）。 */
function decodeTarString(bytes) {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  let slice = bytes.subarray(0, end);
  // 字段可能用空格填充
  let tail = slice.length;
  while (tail > 0 && slice[tail - 1] === 0x20) tail--;
  slice = slice.subarray(0, tail);
  return decodeFileName(slice).name;
}

/** PAX 记录格式："<总长度> <key>=<value>\n"，值为 UTF-8。 */
function parsePaxPayload(data) {
  const out = Object.create(null);
  let p = 0;
  while (p < data.length) {
    let space = -1;
    const limit = Math.min(p + 12, data.length);
    for (let i = p; i < limit; i++) {
      if (data[i] === 0x20) {
        space = i;
        break;
      }
    }
    if (space < 0) break;
    const length = parseInt(latin1(data.subarray(p, space)), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const end = p + length;
    if (end > data.length) break;
    const body = data.subarray(space + 1, end > space + 1 && data[end - 1] === 0x0a ? end - 1 : end);
    const text = decodeFileName(body).name;
    const eq = text.indexOf('=');
    if (eq > 0) out[text.slice(0, eq)] = text.slice(eq + 1);
    p = end;
  }
  return out;
}

/**
 * 解析 tar 归档。
 * @param {Uint8Array} input
 * @param {{maxEntries?: number}} [options]
 * @returns {{entries: Array, notes: string[], truncated: boolean, endOfArchive: boolean}}
 */
export function parseTar(input, options = {}) {
  const bytes = toBytes(input);
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const entries = [];
  const notes = [];
  const paxState = { local: Object.create(null) };
  let globalPax = Object.create(null);
  let nextPath = null;
  let nextLink = null;
  let truncated = false;
  let endOfArchive = false;
  let p = 0;

  while (p + BLOCK <= bytes.length) {
    const block = bytes.subarray(p, p + BLOCK);
    if (isZeroBlock(block)) {
      endOfArchive = true;
      break;
    }

    const storedChecksum = parseNumericField(block, 148, 8);
    const sums = blockChecksum(block);
    if (storedChecksum !== sums.unsigned && storedChecksum !== sums.signed) {
      notes.push(`tar 头部校验失败（偏移 ${p}），疑似数据损坏，已停止解析`);
      truncated = true;
      break;
    }

    const typeFlag = String.fromCharCode(block[156] || 0x30);
    const declaredSize = parseNumericField(block, 124, 12);
    const mtimeSec = parseNumericField(block, 136, 12);
    const mode = parseNumericField(block, 100, 8);
    const dataOffset = p + BLOCK;
    const dataEnd = dataOffset + declaredSize;

    // 扩展头：只影响下一个条目，本身不进入列表
    if (typeFlag === 'x' || typeFlag === 'g') {
      const payload = bytes.subarray(dataOffset, Math.min(dataEnd, bytes.length));
      if (typeFlag === 'x') paxState.local = parsePaxPayload(payload);
      else globalPax = Object.assign(globalPax, parsePaxPayload(payload));
      p = dataOffset + Math.ceil(declaredSize / BLOCK) * BLOCK;
      continue;
    }
    if (typeFlag === 'L' || typeFlag === 'K') {
      const payload = bytes.subarray(dataOffset, Math.min(dataEnd, bytes.length));
      const name = decodeTarString(payload);
      if (typeFlag === 'L') nextPath = name;
      else nextLink = name;
      p = dataOffset + Math.ceil(declaredSize / BLOCK) * BLOCK;
      continue;
    }

    if (entries.length >= maxEntries) {
      truncated = true;
      notes.push(`条目数超过上限 ${maxEntries}，仅列出前 ${maxEntries} 项`);
      break;
    }

    const pax = Object.assign(Object.create(null), globalPax, paxState.local);
    paxState.local = Object.create(null);

    // PAX 可覆盖 size / mtime（大文件、精度更高）；size 影响数据区步长，必须用生效值
    let effectiveSize = declaredSize;
    if (pax.size && Number.isFinite(Number(pax.size))) effectiveSize = Number(pax.size);
    const nextOffset = dataOffset + Math.ceil(effectiveSize / BLOCK) * BLOCK;
    const effectiveEnd = dataOffset + effectiveSize;

    // 名称：PAX path > GNU 长名 > ustar prefix + name
    let name = nextPath || '';
    nextPath = null;
    if (!name) {
      const baseName = decodeTarString(block.subarray(0, 100));
      const prefix = decodeTarString(block.subarray(345, 500));
      name = prefix ? `${prefix}/${baseName}` : baseName;
    }
    if (pax.path) name = pax.path;

    let linkname = nextLink || decodeTarString(block.subarray(157, 257));
    nextLink = null;
    if (pax.linkpath) linkname = pax.linkpath;

    let mtime = mtimeSec * 1000 || null;
    if (pax.mtime !== undefined && Number.isFinite(Number(pax.mtime))) {
      mtime = Math.round(Number(pax.mtime) * 1000);
    }

    const type = TYPE_NAMES[typeFlag] || 'other';
    const normalized = normalizeEntryPath(name);
    const dir = type === 'dir' || normalized.trailingSlash;
    const entry = {
      index: entries.length,
      path: normalized.path,
      dir,
      size: dir ? 0 : effectiveSize,
      compressedSize: dir ? 0 : effectiveSize,
      mtime,
      encrypted: false,
      method: 'none',
      type,
      linkname: linkname || null,
      mode,
      dataOffset,
      container: 'tar',
    };
    if (type === 'sparse') entry.note = '稀疏文件：按普通文件展示，预览内容可能不完整';

    // 数据区越界 = 归档被截断：保留条目，标记截断后停止
    if (effectiveEnd > bytes.length) {
      notes.push(`条目「${entry.path}」的数据超出归档末尾，归档疑似被截断`);
      truncated = true;
      entries.push(entry);
      break;
    }
    entries.push(entry);
    p = nextOffset;
  }

  if (!endOfArchive && !truncated) {
    const tailStart = Math.min(p, bytes.length);
    const tailEnd = Math.min(bytes.length, tailStart + BLOCK);
    if (tailEnd > tailStart && !isZeroBlock(bytes.subarray(tailStart, tailEnd))) {
      notes.push('tar 归档尾部缺少结束标记（可能被截断或非标准写入器生成）');
    }
  }

  return { entries, notes, truncated, endOfArchive };
}

/**
 * 读取 tar 条目内容（入参 bytes 必须是条目 dataOffset 所对应的 tar 字节流：
 * 普通 .tar 就是原文件，.tar.gz 则是解压后的 tar 数据）。
 * @returns {{bytes: Uint8Array, truncated: boolean, note?: string}}
 */
export function readTarEntry(bytes, entry, options = {}) {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  if (entry.dir) return { bytes: new Uint8Array(0), truncated: false };
  if (entry.type === 'symlink' || entry.type === 'hardlink') {
    return { bytes: new Uint8Array(0), truncated: false, note: `这是指向「${entry.linkname || '?'}」的链接条目，没有文件内容` };
  }
  if (entry.type === 'char' || entry.type === 'block' || entry.type === 'fifo') {
    return { bytes: new Uint8Array(0), truncated: false, note: `这是设备/管道条目（${entry.type}），没有文件内容` };
  }

  const start = entry.dataOffset;
  if (!Number.isFinite(start) || start > bytes.length) {
    return { bytes: new Uint8Array(0), truncated: true, note: '条目数据超出归档末尾（归档被截断）' };
  }
  const available = bytes.length - start;
  const length = Math.max(0, Math.min(entry.size, available, maxBytes));
  const truncated = length < entry.size;
  return {
    bytes: bytes.subarray(start, start + length),
    truncated,
    note: truncated ? `内容被截断：声明 ${formatBytes(entry.size)}，实际取到 ${formatBytes(length)}` : undefined,
  };
}

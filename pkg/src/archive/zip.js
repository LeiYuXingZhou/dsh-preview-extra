// archive/zip.js — ZIP 解析：EOCD（含 ZIP64 最小支持）、中央目录、条目解压。
// 说明：
// - data descriptor（标志位 0x08）场景下，大小/CRC 一律以中央目录为准（与规范一致）。
// - 解 method 8 用 DecompressionStream('deflate-raw')，method 0 直读。
// - 加密条目只标记，readZipEntry 时给出可读错误（不做解密）。

import {
  ArchiveError,
  crc32,
  decodeFileName,
  formatBytes,
  normalizeEntryPath,
  readU16,
  readU32,
  readU64,
} from './util.js';
import { inflateBytes } from './inflate.js';

const SIG_LOCAL = 0x04034b50; // PK\x03\x04
const SIG_CD = 0x02014b50; // PK\x01\x02
const SIG_EOCD = 0x06054b50; // PK\x05\x06
const SIG_ZIP64_EOCD = 0x06064b50; // PK\x06\x06
const SIG_ZIP64_LOCATOR = 0x07064b50; // PK\x06\x07

const METHOD_NAMES = {
  0: 'stored',
  1: 'shrink',
  6: 'implode',
  8: 'deflate',
  9: 'deflate64',
  12: 'bzip2',
  14: 'lzma',
  93: 'zstd',
  95: 'xz',
  98: 'ppmd',
};

export function zipMethodName(id) {
  return METHOD_NAMES[id] || `method-${id}`;
}

const SIG_UTF8 = 0x0800;
const SIG_ENCRYPTED = 0x0001;
const SIG_STRONG_ENCRYPT = 0x0040;
const SIG_DATA_DESCRIPTOR = 0x0008;

/** 快速判断是否 ZIP（本地头 / 空包 EOCD / 分卷标记）。 */
export function isZip(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 4) return false;
  if (b[0] !== 0x50 || b[1] !== 0x4b) return false;
  return (
    (b[2] === 0x03 && b[3] === 0x04) || // 普通本地文件头
    (b[2] === 0x05 && b[3] === 0x06) || // 空归档
    (b[2] === 0x07 && b[3] === 0x08) // 分卷归档
  );
}

/**
 * 从尾部扫描 EOCD。先找“注释长度正好结尾”的严格匹配，找不到再放宽（容忍尾部垃圾字节）。
 * @returns {{offset: number}|null}
 */
export function findEocd(bytes) {
  const len = bytes.length;
  if (len < 22) return null;
  const min = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= min; i--) {
    if (readU32(bytes, i) !== SIG_EOCD) continue;
    if (i + 22 + readU16(bytes, i + 20) === len) return { offset: i, strict: true };
  }
  for (let i = len - 22; i >= min; i--) {
    if (readU32(bytes, i) === SIG_EOCD) return { offset: i, strict: false };
  }
  return null;
}

/** 解析 ZIP64 EOCD（EOCD 前 20 字节的 locator 指向 0x06064b50 记录）。 */
function readZip64Eocd(bytes, eocdOffset) {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0 || readU32(bytes, locatorOffset) !== SIG_ZIP64_LOCATOR) return null;
  const recordOffset = readU64(bytes, locatorOffset + 8);
  if (recordOffset + 56 > bytes.length || readU32(bytes, recordOffset) !== SIG_ZIP64_EOCD) return null;
  return {
    totalEntries: readU64(bytes, recordOffset + 32),
    cdSize: readU64(bytes, recordOffset + 40),
    cdOffset: readU64(bytes, recordOffset + 48),
  };
}

/** 解析 extra field，返回 Map<id, Uint8Array>。 */
export function parseExtraFields(extra) {
  const map = new Map();
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = readU16(extra, p);
    const size = readU16(extra, p + 2);
    const start = p + 4;
    if (start + size > extra.length) break; // 字段被截断，忽略剩余
    map.set(id, extra.subarray(start, start + size));
    p = start + size;
  }
  return map;
}

/** DOS 日期时间 → 毫秒时间戳。DOS 时间没有时区，按本地时间解释（显示墙上时间一致）。 */
export function dosDateTimeToMs(date16, time16) {
  const year = 1980 + ((date16 >> 9) & 0x7f);
  const month = ((date16 >> 5) & 0x0f) || 1;
  const day = (date16 & 0x1f) || 1;
  const hour = (time16 >> 11) & 0x1f;
  const minute = (time16 >> 5) & 0x3f;
  const second = (time16 & 0x1f) * 2;
  const d = new Date(year, month - 1, day, hour, minute, second);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 解析单个中央目录项。p 指向 0x02014b50 签名。 */
function parseCentralEntry(bytes, p, index) {
  const versionMadeBy = readU16(bytes, p + 4);
  const flags = readU16(bytes, p + 8);
  const methodId = readU16(bytes, p + 10);
  const time16 = readU16(bytes, p + 12);
  const date16 = readU16(bytes, p + 14);
  const crc = readU32(bytes, p + 16);
  let compressedSize = readU32(bytes, p + 20);
  let size = readU32(bytes, p + 24);
  const nameLen = readU16(bytes, p + 28);
  const extraLen = readU16(bytes, p + 30);
  const commentLen = readU16(bytes, p + 32);
  const diskStart = readU16(bytes, p + 34);
  const externalAttrs = readU32(bytes, p + 38);
  let localHeaderOffset = readU32(bytes, p + 42);

  const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
  const extra = bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
  const extras = parseExtraFields(extra);

  // ZIP64 扩展字段 0x0001：按 未压缩大小 / 压缩大小 / 本地头偏移 / 分卷号 的顺序，
  // 只有对应字段为 0xFFFFFFFF(或 0xFFFF) 时才出现。
  let zip64 = false;
  const z64 = extras.get(0x0001);
  if (z64) {
    let q = 0;
    if (size === 0xffffffff && q + 8 <= z64.length) {
      size = readU64(z64, q);
      q += 8;
      zip64 = true;
    }
    if (compressedSize === 0xffffffff && q + 8 <= z64.length) {
      compressedSize = readU64(z64, q);
      q += 8;
      zip64 = true;
    }
    if (localHeaderOffset === 0xffffffff && q + 8 <= z64.length) {
      localHeaderOffset = readU64(z64, q);
      q += 8;
      zip64 = true;
    }
  }

  const utf8Flag = (flags & SIG_UTF8) !== 0;
  const decoded = decodeFileName(rawName, { utf8Flag });
  const normalized = normalizeEntryPath(decoded.name);

  // 目录判定：名字以 '/' 结尾、MS-DOS 目录属性 0x10、或 Unix mode 是目录位。
  const unixMode = versionMadeBy >> 8 === 3 || versionMadeBy >> 8 === 19 ? externalAttrs >>> 16 : 0;
  const dir =
    normalized.trailingSlash || (externalAttrs & 0x10) !== 0 || (unixMode & 0xf000) === 0x4000;

  // 扩展时间戳 0x5455（Unix mtime，秒）优先于 DOS 时间。
  let mtime = dosDateTimeToMs(date16, time16);
  const ut = extras.get(0x5455);
  if (ut && ut.length >= 5 && (ut[0] & 0x01) !== 0) {
    const seconds = readU32(ut, 1);
    if (seconds > 0) mtime = seconds * 1000;
  }

  return {
    index,
    path: normalized.path,
    dir,
    size,
    compressedSize,
    crc32: crc,
    mtime,
    encrypted: (flags & (SIG_ENCRYPTED | SIG_STRONG_ENCRYPT)) !== 0,
    method: zipMethodName(methodId),
    methodId,
    flags,
    utf8: utf8Flag,
    nameEncoding: decoded.encoding,
    localHeaderOffset,
    externalAttrs,
    mode: unixMode,
    diskStart,
    zip64,
    container: 'zip',
  };
}

/**
 * 解析整个 ZIP 的中央目录。
 * @param {Uint8Array} input
 * @param {{maxEntries?: number}} [options]
 * @returns {{entries: Array, notes: string[], truncated: boolean, comment: string, zip64: boolean}}
 */
export function parseZip(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const notes = [];

  const eocd = findEocd(bytes);
  if (!eocd) {
    throw new ArchiveError('未找到 ZIP 的中央目录结束记录（EOCD），文件可能不是 ZIP 或已损坏', 'BAD_ZIP');
  }
  const eocdOffset = eocd.offset;
  let totalEntries = readU16(bytes, eocdOffset + 10);
  let cdSize = readU32(bytes, eocdOffset + 12);
  let cdOffset = readU32(bytes, eocdOffset + 16);
  const commentLen = readU16(bytes, eocdOffset + 20);
  let comment = '';
  if (commentLen > 0) {
    const end = Math.min(eocdOffset + 22 + commentLen, bytes.length);
    comment = decodeFileName(bytes.subarray(eocdOffset + 22, end)).name;
  }

  // ZIP64：任一尾部字段为哨兵值时读 ZIP64 EOCD。
  let zip64 = false;
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const z = readZip64Eocd(bytes, eocdOffset);
    if (z) {
      totalEntries = z.totalEntries;
      cdSize = z.cdSize;
      cdOffset = z.cdOffset;
      zip64 = true;
    } else {
      notes.push('ZIP64 结束记录缺失，已按普通 ZIP 尝试解析');
    }
  }

  if (cdOffset > bytes.length) {
    throw new ArchiveError('ZIP 中央目录偏移越界，文件可能被截断', 'BAD_ZIP');
  }
  if (cdOffset + cdSize > bytes.length) {
    notes.push('中央目录声明长度超出文件末尾，归档可能被截断');
  }

  const entries = [];
  let truncated = false;
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (entries.length >= maxEntries) {
      truncated = true;
      notes.push(`条目数超过上限 ${maxEntries}，仅列出前 ${maxEntries} 项`);
      break;
    }
    if (p + 46 > bytes.length) {
      if (i === 0) throw new ArchiveError('ZIP 中央目录数据不完整，文件可能被截断', 'BAD_ZIP');
      notes.push(`中央目录在第 ${i + 1} 项处提前结束，归档可能被截断`);
      truncated = true;
      break;
    }
    if (readU32(bytes, p) !== SIG_CD) {
      if (i === 0) throw new ArchiveError('ZIP 中央目录签名不正确，文件可能已损坏', 'BAD_ZIP');
      notes.push(`中央目录在第 ${i + 1} 项处格式异常，已停止解析`);
      truncated = true;
      break;
    }
    const nameLen = readU16(bytes, p + 28);
    const extraLen = readU16(bytes, p + 30);
    const cLen = readU16(bytes, p + 32);
    entries.push(parseCentralEntry(bytes, p, i));
    p += 46 + nameLen + extraLen + cLen;
  }

  if (!zip64 && entries.some((e) => e.zip64)) zip64 = true;
  return { entries, notes, truncated, comment, zip64, totalEntries };
}

/** 计算条目实际数据在文件中的起点（读本地文件头，取其 name/extra 长度）。 */
function localDataOffset(bytes, entry) {
  const off = entry.localHeaderOffset;
  if (!Number.isFinite(off) || off + 30 > bytes.length) {
    throw new ArchiveError(`条目「${entry.path}」的本地文件头偏移越界，归档可能被截断`, 'BAD_LOCAL_HEADER');
  }
  if (readU32(bytes, off) !== SIG_LOCAL) {
    throw new ArchiveError(`条目「${entry.path}」的本地文件头签名不正确（偏移 ${off}）`, 'BAD_LOCAL_HEADER');
  }
  const nameLen = readU16(bytes, off + 26);
  const extraLen = readU16(bytes, off + 28);
  const dataOffset = off + 30 + nameLen + extraLen;
  if (dataOffset > bytes.length) {
    throw new ArchiveError(`条目「${entry.path}」的数据偏移越界，归档可能被截断`, 'BAD_LOCAL_HEADER');
  }
  return dataOffset;
}

/**
 * 解出单个 ZIP 条目内容。
 * @returns {Promise<{bytes: Uint8Array, truncated: boolean, crcOk: boolean|null, note?: string}>}
 */
export async function readZipEntry(bytes, entry, options = {}) {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const verifyCrc = options.verifyCrc !== false;

  if (entry.encrypted) {
    throw new ArchiveError(
      `条目「${entry.path}」已加密，无法预览。请先解压并输入密码后再查看。`,
      'ENCRYPTED',
    );
  }
  if (entry.dir) return { bytes: new Uint8Array(0), truncated: false, crcOk: null };
  if (entry.methodId !== 0 && entry.methodId !== 8) {
    throw new ArchiveError(
      `条目「${entry.path}」使用了不支持的压缩方法：${entry.method}（当前仅支持 stored / deflate）`,
      'UNSUPPORTED_METHOD',
    );
  }

  const dataOffset = localDataOffset(bytes, entry);
  const rawEnd = dataOffset + entry.compressedSize;
  if (rawEnd > bytes.length) {
    throw new ArchiveError(
      `条目「${entry.path}」的压缩数据超出文件末尾（需要 ${formatBytes(entry.compressedSize)}，实际只剩 ${formatBytes(bytes.length - dataOffset)}），归档可能被截断`,
      'BAD_ENTRY_DATA',
    );
  }
  const raw = bytes.subarray(dataOffset, rawEnd);

  let result;
  if (entry.methodId === 0) {
    // stored：直接读取；理论上 compressedSize === size，异常时以 size 为准。
    let data = raw;
    let truncated = false;
    if (entry.size >= 0 && raw.length > entry.size) data = raw.subarray(0, entry.size);
    if (data.length > maxBytes) {
      data = data.subarray(0, Math.max(0, maxBytes));
      truncated = true;
    }
    if (entry.size > 0 && data.length < entry.size && data.length < maxBytes) {
      truncated = true;
    }
    result = { bytes: data, truncated, crcOk: null };
  } else {
    result = await inflateBytes(raw, 'deflate-raw', { maxBytes });
    if (!result.truncated && entry.size >= 0 && result.bytes.length !== entry.size) {
      result.note = `解压后大小 ${formatBytes(result.bytes.length)} 与中央目录声明 ${formatBytes(entry.size)} 不一致`;
    }
  }

  // CRC 校验：仅在完整解出时进行（截断时 CRC 必然不匹配）。
  if (verifyCrc && !result.truncated && entry.size > 0) {
    result.crcOk = crc32(result.bytes) === entry.crc32;
    if (!result.crcOk) result.note = (result.note ? result.note + '；' : '') + 'CRC32 校验不一致，内容可能已损坏';
  } else if (!('crcOk' in result)) {
    result.crcOk = null;
  }
  return result;
}

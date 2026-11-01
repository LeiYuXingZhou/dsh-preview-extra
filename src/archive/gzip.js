// archive/gzip.js — gzip 头部解析与流式解压（DecompressionStream('gzip')）。
// 用途：.gz 单文件，以及 .tar.gz / .tgz 的容器解压。

import { ArchiveError, decodeFileName, readU32, toBytes } from './util.js';
import { inflateBytes } from './inflate.js';

const FTEXT = 0x01;
const FHCRC = 0x02;
const FEXTRA = 0x04;
const FNAME = 0x08;
const FCOMMENT = 0x10;

export function isGzip(input) {
  const b = toBytes(input);
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * 解析 gzip 头，取出原始文件名与 mtime（RFC 1952）。
 * @returns {{mtime:number|null, originalName:string|null, comment:string|null, flags:number, os:number, headerSize:number}|null}
 */
export function parseGzipHeader(input) {
  const b = toBytes(input);
  if (!isGzip(b)) return null;
  if (b.length < 10) throw new ArchiveError('gzip 头部不完整（不足 10 字节）', 'BAD_GZIP');
  const method = b[2];
  if (method !== 8) {
    throw new ArchiveError(`不支持的 gzip 压缩方法 ${method}（仅支持 deflate=8）`, 'BAD_GZIP');
  }
  const flags = b[3];
  const mtimeSec = readU32(b, 4);
  const os = b[9];
  let p = 10;

  if (flags & FEXTRA) {
    if (p + 2 > b.length) throw new ArchiveError('gzip 扩展字段不完整', 'BAD_GZIP');
    const xlen = b[p] | (b[p + 1] << 8);
    p += 2 + xlen;
  }
  let originalName = null;
  if (flags & FNAME) {
    const end = p < b.length ? b.indexOf(0, p) : -1;
    if (end < 0) throw new ArchiveError('gzip 原始文件名字段不完整', 'BAD_GZIP');
    originalName = decodeFileName(b.subarray(p, end)).name;
    p = end + 1;
  }
  let comment = null;
  if (flags & FCOMMENT) {
    const end = p < b.length ? b.indexOf(0, p) : -1;
    if (end < 0) throw new ArchiveError('gzip 注释字段不完整', 'BAD_GZIP');
    comment = decodeFileName(b.subarray(p, end)).name;
    p = end + 1;
  }
  if (flags & FHCRC) p += 2;
  if (flags & FTEXT) {
    /* 纯文本提示，无需处理 */
  }
  if (p > b.length) throw new ArchiveError('gzip 头部字段越界', 'BAD_GZIP');

  return {
    mtime: mtimeSec > 0 ? mtimeSec * 1000 : null,
    originalName,
    comment,
    flags,
    os,
    headerSize: p,
  };
}

/** 解压 gzip，最多 maxBytes 字节。 */
export async function gunzip(input, options = {}) {
  const bytes = toBytes(input);
  if (!isGzip(bytes)) throw new ArchiveError('不是 gzip 数据（缺少 1F 8B 魔数）', 'BAD_GZIP');
  parseGzipHeader(bytes); // 先校验头部，错误信息更准确
  return inflateBytes(bytes, 'gzip', { maxBytes: options.maxBytes ?? Number.POSITIVE_INFINITY });
}

// 解压结果缓存：readEntry 每次调用都要重新解压 tar.gz 会很慢。
// 用 WeakMap 以输入字节对象为键，归档数据被回收时缓存自动释放。
const gzipCache = new WeakMap();

/**
 * 带缓存的 gunzip。完整解出的结果会被复用（截断结果不缓存，避免不同上限互相污染）。
 * @returns {Promise<{bytes: Uint8Array, truncated: boolean}>}
 */
export async function gunzipCached(input, options = {}) {
  const bytes = toBytes(input);
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  let slot = gzipCache.get(bytes);
  if (!slot) {
    slot = { full: null, pending: null };
    gzipCache.set(bytes, slot);
  }
  if (slot.full) return { bytes: slot.full, truncated: false };
  if (slot.pending) return slot.pending;

  const task = gunzip(bytes, { maxBytes })
    .then((res) => {
      if (!res.truncated) slot.full = res.bytes;
      slot.pending = null;
      return res;
    })
    .catch((err) => {
      slot.pending = null;
      throw err;
    });
  slot.pending = task;
  return task;
}

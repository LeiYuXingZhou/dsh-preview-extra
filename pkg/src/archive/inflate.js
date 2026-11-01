// archive/inflate.js — 用 Web 标准 DecompressionStream 做流式解压，带字节上限（防 zip bomb）。
// 浏览器与 Node 24 均内置 DecompressionStream（'deflate-raw' | 'deflate' | 'gzip'）。

import { ArchiveError, concatBytes, toBytes } from './util.js';

export function isDecompressionSupported() {
  return typeof DecompressionStream === 'function';
}

/**
 * 解压字节流，最多返回 maxBytes 字节。
 * @param {Uint8Array|ArrayBuffer} input 压缩数据
 * @param {'deflate-raw'|'deflate'|'gzip'} format
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<{bytes: Uint8Array, truncated: boolean}>}
 * 超限时返回已解出的前 maxBytes 字节并置 truncated=true（不抛错），
 * 这样调用方可以展示部分内容而不是整包失败。
 */
export async function inflateBytes(input, format = 'deflate-raw', options = {}) {
  const bytes = toBytes(input);
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  if (maxBytes <= 0) return { bytes: new Uint8Array(0), truncated: bytes.length > 0 };
  if (!isDecompressionSupported()) {
    throw new ArchiveError('当前环境不支持 DecompressionStream，无法解压压缩条目', 'NO_DECOMPRESSION');
  }

  let stream;
  try {
    stream = new DecompressionStream(format);
  } catch {
    throw new ArchiveError(`当前环境不支持 ${format} 解压`, 'NO_DECOMPRESSION');
  }

  const writer = stream.writable.getWriter();
  // 先写入全部压缩数据（不 await：读取端可能提前取消，写入随之失败，属正常情况）
  const writeDone = writer
    .write(bytes)
    .then(() => writer.close())
    .catch(() => {});

  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        const take = maxBytes - total;
        if (take > 0) chunks.push(value.subarray(0, take));
        total += take;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch (err) {
    throw new ArchiveError(`解压失败：${err?.message || '数据损坏'}`, 'INFLATE_FAILED');
  } finally {
    await writeDone;
  }

  return { bytes: concatBytes(chunks, total), truncated };
}

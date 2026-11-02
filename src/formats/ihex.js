// ihex.js — Intel HEX 记录解析。
// 支持数据记录、EOF、扩展段地址、扩展线性地址、起始地址（03/05），并校验每行 checksum。

import { decodeUtf8 } from './text.js';

const MAX_LINES = 400_000;
const MAX_RANGES = 64;

/**
 * @param {Uint8Array|ArrayBuffer|string} input
 */
export function parseIntelHex(input) {
  const blank = { records: 0, dataBytes: 0, start: null, end: null, entry: null, eof: false, ranges: [], errors: [], warnings: [] };
  let text;
  try {
    text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeUtf8(input);
  } catch (err) {
    return { ok: false, error: 'Intel HEX 解析失败：输入不是文本', ...blank };
  }
  const lines = text.split(/\r?\n/);
  const warnings = [];
  const errors = [];
  const chunks = [];
  let records = 0;
  let dataBytes = 0;
  let eof = false;
  let entry = null;
  let upper = 0;
  let segment = 0;
  let addressMode = 'none';
  let stopped = false;

  for (let index = 0; index < lines.length; index++) {
    if (stopped) break;
    const lineNo = index + 1;
    const line = lines[index].trim();
    if (!line) continue;
    if (!line.startsWith(':')) {
      errors.push({ line: lineNo, message: '不是以 : 开头的 Intel HEX 记录' });
      if (errors.length > 40) {
        warnings.push('错误太多，后面的行不再检查');
        break;
      }
      continue;
    }
    if (records >= MAX_LINES) {
      warnings.push(`记录超过 ${MAX_LINES} 条，只解析了前面的部分`);
      stopped = true;
      break;
    }
    const parsed = parseRecord(line, lineNo);
    if (parsed.error) {
      errors.push({ line: lineNo, message: parsed.error });
      continue;
    }
    records += 1;
    if (parsed.type === 0x00) {
      const base = addressMode === 'segment' ? (segment << 4) + parsed.address : (upper << 16) + parsed.address;
      chunks.push({ address: base >>> 0, data: parsed.data });
      dataBytes += parsed.data.length;
    } else if (parsed.type === 0x01) {
      eof = true;
    } else if (parsed.type === 0x02) {
      if (parsed.data.length !== 2) {
        errors.push({ line: lineNo, message: '扩展段地址记录长度应为 2' });
        continue;
      }
      segment = (parsed.data[0] << 8) | parsed.data[1];
      addressMode = 'segment';
      upper = 0;
    } else if (parsed.type === 0x04) {
      if (parsed.data.length !== 2) {
        errors.push({ line: lineNo, message: '扩展线性地址记录长度应为 2' });
        continue;
      }
      upper = (parsed.data[0] << 8) | parsed.data[1];
      addressMode = 'linear';
      segment = 0;
    } else if (parsed.type === 0x03) {
      if (parsed.data.length !== 4) {
        errors.push({ line: lineNo, message: '起始段地址记录长度应为 4' });
        continue;
      }
      const cs = (parsed.data[0] << 8) | parsed.data[1];
      const ip = (parsed.data[2] << 8) | parsed.data[3];
      entry = { kind: 'segment', address: ((cs << 4) + ip) >>> 0 };
    } else if (parsed.type === 0x05) {
      if (parsed.data.length !== 4) {
        errors.push({ line: lineNo, message: '起始线性地址记录长度应为 4' });
        continue;
      }
      const address = ((parsed.data[0] << 24) | (parsed.data[1] << 16) | (parsed.data[2] << 8) | parsed.data[3]) >>> 0;
      entry = { kind: 'linear', address };
    } else {
      warnings.push(`第 ${lineNo} 行：忽略未知记录类型 0x${parsed.type.toString(16).padStart(2, '0')}`);
    }
  }

  if (records === 0) {
    return { ok: false, error: '不是 Intel HEX（没有有效的 : 记录）', ...blank, errors, warnings };
  }
  if (!eof) warnings.push('文件没有结束记录（类型 01）');

  const ranges = mergeChunks(chunks);
  let start = null;
  let end = null;
  const shown = [];
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (start === null || range.address < start) start = range.address;
    const rangeEnd = range.address + range.data.length;
    if (end === null || rangeEnd > end) end = rangeEnd;
    if (i < MAX_RANGES) {
      shown.push({
        address: range.address,
        length: range.data.length,
        data: range.data,
      });
    }
  }
  if (ranges.length > MAX_RANGES) {
    warnings.push(`地址区间较多，列表只展示前 ${MAX_RANGES} 段`);
  }
  return {
    ok: true,
    records,
    dataBytes,
    start,
    end,
    entry,
    eof,
    ranges: shown,
    errors,
    warnings,
  };
}

/** 把一段字节格式化成 `地址  十六进制  ASCII` 行。 */
export function formatHexDump(bytes, base, maxBytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const count = Math.min(view.length, maxBytes == null ? view.length : maxBytes);
  const lines = [];
  for (let offset = 0; offset < count; offset += 16) {
    const slice = view.subarray(offset, Math.min(count, offset + 16));
    const hex = [];
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < slice.length) {
        const value = slice[i];
        hex.push(value.toString(16).padStart(2, '0'));
        ascii += value >= 32 && value < 127 ? String.fromCharCode(value) : '.';
      } else {
        hex.push('  ');
      }
    }
    const address = (base + offset) >>> 0;
    lines.push(`${address.toString(16).padStart(8, '0')}  ${hex.join(' ')}  ${ascii}`);
  }
  return lines;
}

function parseRecord(line, lineNo) {
  const hex = line.slice(1);
  if (hex.length < 10 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return { error: '记录里有非法十六进制或长度不对' };
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xff;
  if (sum !== 0) return { error: 'checksum 不正确' };
  const length = bytes[0];
  if (bytes.length !== length + 5) return { error: `声明长度 ${length} 与实际字节数不符` };
  const address = (bytes[1] << 8) | bytes[2];
  const type = bytes[3];
  return { address, type, data: bytes.subarray(4, 4 + length), line: lineNo };
}

function mergeChunks(chunks) {
  const ranges = [];
  for (const chunk of chunks) {
    writeChunk(ranges, chunk.address, chunk.data);
  }
  ranges.sort((a, b) => a.address - b.address);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.address <= last.address + last.data.length) {
      const start = last.address;
      const end = Math.max(last.address + last.data.length, range.address + range.data.length);
      const next = new Uint8Array(end - start);
      next.set(last.data, 0);
      next.set(range.data, range.address - start);
      last.data = next;
    } else {
      merged.push({ address: range.address, data: range.data });
    }
  }
  return merged;
}

function writeChunk(ranges, address, data) {
  for (const range of ranges) {
    const end = range.address + range.data.length;
    if (address >= range.address && address <= end) {
      const need = address + data.length;
      if (need > end) {
        const next = new Uint8Array(need - range.address);
        next.set(range.data, 0);
        range.data = next;
      }
      range.data.set(data, address - range.address);
      return;
    }
  }
  ranges.push({ address, data: Uint8Array.from(data) });
}

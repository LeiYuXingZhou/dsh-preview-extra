// archive/index.js — 压缩包预览统一 API（全部具名导出，无 default export）。
//
//   listArchive(bytes, options?)      -> { format, supported, entries, truncated, notes, hint }
//   readEntry(bytes, entry, options?) -> { bytes, truncated, textualHint, mime, note?, crcOk? }
//   readEntryText(bytes, entry, opts) -> { text, encoding, looksBinary, ...readEntry 结果 }
//   buildTree(entries)                -> 嵌套目录树（给 UI 用）
//   formatBytes(n) / utf8OrLatin1(bytes) / classifyContent(bytes) / isProbablyText(bytes)
//
// 约束：纯 ESM + Web 标准 API（DecompressionStream / TextDecoder / Uint8Array），不 import 任何外部包；
// 只读，不写磁盘；超限一律返回 truncated + notes，只有真正的数据损坏才抛 ArchiveError（可读中文信息）。

import {
  ArchiveError as BaseArchiveError,
  classifyContent as classifyContentImpl,
  compareTreeNodes,
  decodeTextBytes as decodeTextBytesImpl,
  formatBytes as formatBytesImpl,
  isProbablyText as isProbablyTextImpl,
  toBytes,
  utf8OrLatin1 as utf8OrLatin1Impl,
} from './util.js';
import { detect as detectFormat } from './detect.js';
import { parseZip, readZipEntry } from './zip.js';
import { parseTar, readTarEntry, isTar } from './tar.js';
import { gunzip, gunzipCached, isGzip, parseGzipHeader } from './gzip.js';

/** 防 zip bomb 默认上限（可通过 options 或 options.limits 覆盖）。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 5000, // 最多列出的条目数
  maxEntryBytes: 32 * 1024 * 1024, // 单次 readEntry 解压上限 32MB
  maxTotalBytes: 128 * 1024 * 1024, // 同一归档累计解压上限 128MB
});

// —— 供 UI / 打包脚本使用的具名再导出（显式清单，便于静态提取） ——
export const ArchiveError = BaseArchiveError;
export const detect = detectFormat;
export function formatBytes(n) {
  return formatBytesImpl(n);
}
export function utf8OrLatin1(input) {
  return utf8OrLatin1Impl(input);
}
export function classifyContent(input) {
  return classifyContentImpl(input);
}
export function isProbablyText(input) {
  return isProbablyTextImpl(input);
}
export function decodeTextBytes(input, options) {
  return decodeTextBytesImpl(input, options);
}

// 每个归档字节对象一份解压预算；WeakMap 保证归档被回收后预算自动释放。
const budgets = new WeakMap();
function getBudget(bytes) {
  let budget = budgets.get(bytes);
  if (!budget) {
    budget = { used: 0 };
    budgets.set(bytes, budget);
  }
  return budget;
}
/** 清空某归档的累计解压预算（切换文件、或在同一 buffer 上重新列举时调用）。 */
export function resetBudget(input) {
  budgets.delete(toBytes(input));
}

function resolveLimits(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  for (const key of ['maxEntries', 'maxEntryBytes', 'maxTotalBytes']) {
    if (options[key] != null) limits[key] = options[key];
  }
  return limits;
}

function finalize(format, entries, truncated, notes, det, limits) {
  const cleanNotes = notes.filter(Boolean);
  const declaredTotal = entries.reduce((sum, e) => sum + (e.dir ? 0 : e.size || 0), 0);
  if (declaredTotal > limits.maxTotalBytes) {
    cleanNotes.push(
      `归档解压后总大小约 ${formatBytes(declaredTotal)}，超过单次预览上限 ${formatBytes(limits.maxTotalBytes)}，超出部分条目可能无法完整预览`,
    );
  }
  const nonUtf8 = entries.filter((e) => e.nameEncoding && e.nameEncoding !== 'utf-8').length;
  if (nonUtf8 > 0) {
    cleanNotes.push(`${nonUtf8} 个文件名不是合法 UTF-8，已按 GBK / latin1 兜底解码`);
  }
  return {
    format,
    supported: true,
    hint: det.hint || '',
    entries,
    truncated: !!truncated,
    notes: cleanNotes,
    totalEntries: entries.length,
    declaredTotalBytes: declaredTotal,
    detect: det,
  };
}

/**
 * 列出归档条目（可能解压 gzip 容器，但不会解压各条目内容）。
 * 不支持的格式返回 supported:false + hint，不抛错。
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{filename?: string, format?: string, limits?: object, maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number}} [options]
 * @returns {Promise<{format: string|null, supported: boolean, entries: Array, truncated: boolean, notes: string[], hint: string}>}
 */
export async function listArchive(input, options = {}) {
  const bytes = toBytes(input);
  const limits = resolveLimits(options);
  getBudget(bytes);

  const det = options.format
    ? { format: options.format, supported: true, hint: '', source: 'option', extension: '' }
    : detectFormat(bytes, options.filename || '');

  if (!det.supported) {
    const hint = det.hint || '不支持的归档格式';
    return { format: det.format, supported: false, hint, entries: [], truncated: false, notes: [hint], detect: det };
  }

  try {
    if (det.format === 'zip') {
      const parsed = parseZip(bytes, { maxEntries: limits.maxEntries });
      return finalize('zip', parsed.entries, parsed.truncated, parsed.notes, det, limits);
    }

    if (det.format === 'tar') {
      const parsed = parseTar(bytes, { maxEntries: limits.maxEntries });
      return finalize('tar', parsed.entries, parsed.truncated, parsed.notes, det, limits);
    }

    if (det.format === 'gzip' || det.format === 'tar.gz') {
      if (!isGzip(bytes)) {
        throw new BaseArchiveError('文件扩展名是 gzip，但内容不是 gzip 数据（缺少 1F 8B 魔数）', 'BAD_GZIP');
      }
      const header = parseGzipHeader(bytes);
      const unpacked = await gunzip(bytes, { maxBytes: limits.maxTotalBytes });
      const notes = [];
      if (unpacked.truncated) {
        notes.push(`gzip 解压结果超过 ${formatBytes(limits.maxTotalBytes)} 上限，仅解析前一部分`);
      }

      if (isTar(unpacked.bytes)) {
        const parsed = parseTar(unpacked.bytes, { maxEntries: limits.maxEntries });
        // container 改为 gzip-tar：readEntry 需先解压容器再按 dataOffset 切片
        const entries = parsed.entries.map((e) => ({ ...e, container: 'gzip-tar' }));
        return finalize('tar.gz', entries, parsed.truncated, [...notes, ...parsed.notes], det, limits);
      }

      if (det.format === 'tar.gz') {
        notes.push('扩展名为 .tar.gz / .tgz，但解压结果不是 tar 归档，已按普通 gzip 文件处理');
      }
      const derivedName =
        (header && header.originalName) ||
        String(options.filename || '')
          .replace(/^.*[\\/]/, '')
          .replace(/\.(tar\.)?gz$/i, '') ||
        'gzip-content';
      const entry = {
        index: 0,
        path: derivedName,
        dir: false,
        size: unpacked.bytes.length,
        compressedSize: bytes.length,
        mtime: (header && header.mtime) || null,
        encrypted: false,
        method: 'gzip',
        type: 'file',
        container: 'gzip-raw',
      };
      return finalize('gzip', [entry], unpacked.truncated, notes, det, limits);
    }

    throw new BaseArchiveError(`不支持的归档格式：${det.format}`, 'UNSUPPORTED_FORMAT');
  } catch (err) {
    if (err instanceof BaseArchiveError) throw err;
    throw new BaseArchiveError(`解析归档失败：${err && err.message ? err.message : err}`, 'PARSE_FAILED');
  }
}

/**
 * 读取单个条目内容（按需解压）。
 * @param {Uint8Array|ArrayBuffer} input
 * @param {object} entry listArchive 返回的条目对象
 * @param {{limits?: object, maxEntryBytes?: number, maxTotalBytes?: number, verifyCrc?: boolean}} [options]
 * @returns {Promise<{bytes: Uint8Array, truncated: boolean, textualHint: string, mime: string|null, note?: string, crcOk?: boolean|null}>}
 * textualHint: 'text' | 'image' | 'binary' | 'empty' | 'unknown'，UI 据此选择文本/图片/下载视图。
 * 加密条目会抛 ArchiveError(code='ENCRYPTED')。
 */
export async function readEntry(input, entry, options = {}) {
  const bytes = toBytes(input);
  const limits = resolveLimits(options);

  if (!entry || typeof entry !== 'object') {
    throw new BaseArchiveError('无效的条目对象', 'BAD_ENTRY');
  }
  if (entry.dir) {
    return { bytes: new Uint8Array(0), truncated: false, textualHint: 'unknown', mime: null, note: '目录条目没有内容' };
  }

  const budget = getBudget(bytes);
  const remaining = Math.max(0, limits.maxTotalBytes - budget.used);
  const cap = Math.min(limits.maxEntryBytes, remaining);

  let result;
  switch (entry.container) {
    case 'zip':
      result = await readZipEntry(bytes, entry, { maxBytes: cap, verifyCrc: options.verifyCrc });
      break;
    case 'tar':
      result = readTarEntry(bytes, entry, { maxBytes: cap });
      break;
    case 'gzip-tar':
    case 'gzip-raw': {
      const unpacked = await gunzipCached(bytes, { maxBytes: limits.maxTotalBytes });
      if (entry.container === 'gzip-raw') {
        const length = Math.max(0, Math.min(entry.size, unpacked.bytes.length, cap));
        result = { bytes: unpacked.bytes.subarray(0, length), truncated: length < entry.size };
        if (result.truncated) {
          result.note = `内容被截断：声明 ${formatBytes(entry.size)}，实际取到 ${formatBytes(length)}`;
        }
      } else {
        result = readTarEntry(unpacked.bytes, entry, { maxBytes: cap });
      }
      break;
    }
    default:
      throw new BaseArchiveError(`条目「${entry.path}」缺少容器信息（container=${entry.container}）`, 'BAD_ENTRY');
  }

  if (!(result.bytes instanceof Uint8Array)) result.bytes = new Uint8Array(0);
  budget.used += result.bytes.length;

  // 单条目上限 / 累计预算命中时统一补充可读说明
  if (entry.size > cap) {
    result.truncated = true;
    if (!result.note) {
      result.note = `已截断：单条目上限 ${formatBytes(limits.maxEntryBytes)}，剩余累计预算 ${formatBytes(remaining)}`;
    }
  }

  const classification = classifyContentImpl(result.bytes);
  result.textualHint = classification.kind;
  result.mime = classification.mime;
  return result;
}

/**
 * 读取并解码为文本（默认最多 2MB，避免大文件卡住 UI）。
 * @returns {Promise<{text: string, encoding: string, looksBinary: boolean, truncated: boolean, bytes: Uint8Array}>}
 */
export async function readEntryText(input, entry, options = {}) {
  const limits = resolveLimits(options);
  const textLimit = options.textMaxBytes ?? 2 * 1024 * 1024;
  const readLimit = Math.min(limits.maxEntryBytes, textLimit);
  const result = await readEntry(input, entry, { ...options, maxEntryBytes: readLimit });
  const decoded = decodeTextBytesImpl(result.bytes, { maxBytes: textLimit });
  return {
    ...result,
    text: decoded.text,
    encoding: decoded.encoding,
    looksBinary: !isProbablyTextImpl(result.bytes),
  };
}

/**
 * 把扁平条目列表构建成嵌套目录树（目录优先，同级按名称排序）。
 * 只作为 UI 数据结构，不影响原始条目。
 * @returns {{name:string, path:string, dir:true, size:number, mtime:number|null, children:Array}}
 */
export function buildTree(entries) {
  const root = { name: '', path: '', dir: true, size: 0, mtime: null, children: [], entry: null };
  const map = new Map([['', root]]);

  for (const entry of entries || []) {
    const parts = String(entry.path || '').split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let parent = root;
    let base = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const path = base ? `${base}/${name}` : name;
      const isLeaf = i === parts.length - 1;
      let node = map.get(path);
      if (!node) {
        node = {
          name,
          path,
          dir: isLeaf ? !!entry.dir : true,
          size: isLeaf && !entry.dir ? entry.size || 0 : 0,
          mtime: isLeaf ? (entry.mtime ?? null) : null,
          children: [],
          entry: isLeaf ? entry : null,
        };
        map.set(path, node);
        parent.children.push(node);
      } else if (isLeaf) {
        // 同名条目可能既是文件又是隐式目录：以“有子节点”为准保持目录
        node.dir = !!entry.dir || node.children.length > 0;
        node.size = entry.size || 0;
        node.mtime = entry.mtime ?? null;
        node.entry = entry;
      }
      parent = node;
      base = path;
    }
  }

  const sortRecursive = (node) => {
    node.children.sort(compareTreeNodes);
    for (const child of node.children) sortRecursive(child);
  };
  sortRecursive(root);
  return root;
}

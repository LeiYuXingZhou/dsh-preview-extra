// archive/detect.js — 归档格式识别：魔数嗅探优先，扩展名兜底。
// 返回 { format, supported, hint, source, extension }，供 UI 决定“能否预览/为什么不能”。

import { toBytes } from './util.js';

/** 各格式的能力与提示文案（hint 直接面向用户）。 */
export const FORMAT_INFO = {
  zip: { supported: true, hint: '' },
  tar: { supported: true, hint: '' },
  gzip: { supported: true, hint: 'gzip 压缩数据（若内部是 tar 会自动按 tar 列出）' },
  'tar.gz': { supported: true, hint: 'gzip 压缩的 tar 归档，将自动解压后按 tar 列出' },
  '7z': {
    supported: false,
    hint: '暂不支持 7z 预览：浏览器端没有内置 7z 解压 API，请先解压为 zip/tar 后再预览',
  },
  rar: {
    supported: false,
    hint: '暂不支持 RAR 预览：RAR 使用专有压缩算法，无法在纯 Web 环境中解压，请先转换为 zip',
  },
  xz: {
    supported: false,
    hint: '暂不支持 xz 压缩：请先用系统工具解压为 .tar 或 .zip 后再预览',
  },
  bz2: {
    supported: false,
    hint: '暂不支持 bzip2 压缩：请先用系统工具解压为 .tar 或 .zip 后再预览',
  },
};

/** 扩展名 → 格式（只收归档类；docx/xlsx 等 Office 文件交给专门的预览器，不在此映射）。 */
export const EXT_TO_FORMAT = {
  zip: 'zip',
  jar: 'zip',
  apk: 'zip',
  epub: 'zip',
  cbz: 'zip',
  war: 'zip',
  xpi: 'zip',
  tar: 'tar',
  gz: 'gzip',
  tgz: 'tar.gz',
  'tar.gz': 'tar.gz',
  '7z': '7z',
  rar: 'rar',
  xz: 'xz',
  'tar.xz': 'xz',
  txz: 'xz',
  bz2: 'bz2',
  'tar.bz2': 'bz2',
  tbz2: 'bz2',
  tbz: 'bz2',
};

/** 取小写扩展名，支持 ".tar.gz" 这种双扩展名。 */
export function extensionOf(filename = '') {
  const base = String(filename).split(/[\\/]/).pop().toLowerCase();
  if (base.endsWith('.tar.gz')) return 'tar.gz';
  if (base.endsWith('.tar.xz')) return 'tar.xz';
  if (base.endsWith('.tar.bz2')) return 'tar.bz2';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

const MAGIC_CHECKS = [
  {
    format: 'zip',
    test: (b) =>
      b.length >= 4 &&
      b[0] === 0x50 &&
      b[1] === 0x4b &&
      ((b[2] === 0x03 && b[3] === 0x04) || // 普通/空包
        (b[2] === 0x05 && b[3] === 0x06) || // 空归档 EOCD
        (b[2] === 0x07 && b[3] === 0x08)), // 分卷
  },
  {
    format: 'gzip',
    test: (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b,
  },
  {
    format: '7z',
    test: (b) =>
      b.length >= 6 &&
      b[0] === 0x37 &&
      b[1] === 0x7a &&
      b[2] === 0xbc &&
      b[3] === 0xaf &&
      b[4] === 0x27 &&
      b[5] === 0x1c,
  },
  {
    format: 'rar',
    test: (b) => b.length >= 4 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21, // "Rar!"
  },
  {
    format: 'xz',
    test: (b) =>
      b.length >= 6 && b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58 && b[4] === 0x5a && b[5] === 0x00,
  },
  {
    format: 'bz2',
    test: (b) => b.length >= 3 && b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68, // "BZh"
  },
];

/** 嗅探魔数；返回格式字符串或 null。 */
export function sniffFormat(input) {
  const b = toBytes(input);
  for (const check of MAGIC_CHECKS) {
    if (check.test(b)) return check.format;
  }
  // tar 没有文件头魔数，靠偏移 257 的 "ustar"
  if (b.length >= 263 && b[257] === 0x75 && b[258] === 0x73 && b[259] === 0x74 && b[260] === 0x61 && b[261] === 0x72) {
    if (b[262] === 0x00 || b[262] === 0x20) return 'tar';
  }
  return null;
}

/**
 * 识别归档格式。
 * @param {Uint8Array|ArrayBuffer} input
 * @param {string} [filename] 用于扩展名兜底（魔数优先）
 * @returns {{format: string|null, supported: boolean, hint: string, source: 'magic'|'extension'|'none', extension: string}}
 */
export function detect(input, filename = '') {
  const bytes = toBytes(input);
  const ext = extensionOf(filename);
  const magic = sniffFormat(bytes);

  if (magic) {
    let format = magic;
    // gzip 容器若扩展名是 .tar.gz/.tgz，直接标记为 tar.gz（listArchive 仍会校验内容）
    if (magic === 'gzip' && (ext === 'tar.gz' || ext === 'tgz')) format = 'tar.gz';
    const info = FORMAT_INFO[format] || { supported: true, hint: '' };
    return { format, supported: info.supported, hint: info.hint, source: 'magic', extension: ext };
  }

  if (ext && EXT_TO_FORMAT[ext]) {
    const format = EXT_TO_FORMAT[ext];
    const info = FORMAT_INFO[format] || { supported: true, hint: '' };
    let hint = info.hint;
    if (format === 'tar') hint = '未检测到 tar 魔数（可能不是 ustar 格式），将尝试按 tar 解析';
    if (format === 'gzip' || format === 'tar.gz') hint = hint || '扩展名识别为 gzip 压缩数据';
    return { format, supported: info.supported, hint, source: 'extension', extension: ext };
  }

  return {
    format: null,
    supported: false,
    hint: '无法识别的归档格式：仅支持 zip / tar / tar.gz（.tgz）。7z、RAR、xz、bzip2 暂不支持预览。',
    source: 'none',
    extension: ext,
  };
}

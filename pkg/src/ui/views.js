// views.js — dsh-preview-extra 浏览器端预览正文（单文件、具名导出、无 JSX、无外部依赖）。
//
// 集成契约（由 bundle factory 作用域提供，禁止 import / 重新声明）：
//   react       React 18（createElement / useState / useEffect / useRef / useMemo / useCallback）
//   jsxRuntime  react/jsx-runtime（本文件用 react.createElement，保留自由变量由 factory 提供）
//   primitives  @deepseek-ai/dsh-client-ui-primitives（Button 等，缺失时有纯 DOM 兜底）
//
// 本文件只导出数据与 React 函数组件：
//   previewLocales / previewDefinitions / previewCss / PREVIEW_IDS / previewNamespace
//   ModelPreviewBody / ArchivePreviewBody / MediaPreviewBody / FontPreviewBody / SubtitlePreviewBody
//   previewBodies（id → 组件，方便 client.js 两处注册时避免字符串漂移）
//
// 所有预览都走 loading: 'bytes-complete'，正文从 props.content.data 取完整 Uint8Array。
// 每个异步解析都做了竞态 / 卸载保护；错误一律渲染可读面板，避免白屏。

import { parseModel } from '../model/detect3d.js';
import { buildScene, createModelView } from '../model/renderer.js';
import {
  buildTree,
  decodeTextBytes,
  detect as detectArchive,
  formatBytes,
  listArchive,
  readEntry,
  utf8OrLatin1,
} from '../archive/index.js';

const h = react.createElement;
const Prim = typeof primitives !== 'undefined' && primitives ? primitives : {};
const PrimButton = Prim.Button || null;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** locale 命名空间（client.js 注册 previewLocales 时使用）。 */
export const previewNamespace = 'dshPreviewExtra';

/** 预览渲染器 id（= documentPreviews 的 id = 正文 keyed slot 的 key）。 */
export const PREVIEW_IDS = Object.freeze({
  model: 'dsh-preview-extra/model',
  archive: 'dsh-preview-extra/archive',
  media: 'dsh-preview-extra/media',
  font: 'dsh-preview-extra/font',
  subtitle: 'dsh-preview-extra/subtitle',
});

/** 注入样式表的 id：client.js 与各 body 共享，重复注入会被跳过。 */
const CSS_STYLE_ID = 'dshpx-preview-extra-styles';

const TEXT_PREVIEW_BYTES = 200 * 1024; // 压缩包内文本条目最多展示前 200KB
const MAX_TEXT_LINES = 8000; // 行号渲染上限（防止超长单行文件撑爆 DOM）
const MAX_ARCHIVE_ROWS = 2000; // 条目列表最多渲染的行数
const MAX_SUBTITLE_CUES = 3000; // 字幕列表最多渲染的条数
const MAX_SUBTITLE_BYTES = 1024 * 1024; // 字幕解码上限 1MB
const MODEL_SOFT_LIMIT = 64 * 1024 * 1024; // 3D 模型软上限（Host 硬上限通常 32MiB）
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'];
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'm4v', 'mov', 'mkv'];
const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa'];
const EMPTY_ARRAY = [];

const AUDIO_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
};

const VIDEO_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

// ---------------------------------------------------------------------------
// 文案（previewLocales；client.js 用 ctx.locale.register(previewNamespace, {...})）
// ---------------------------------------------------------------------------

export const previewLocales = {
  zh: {
    'common.loading': '加载中…',
    'common.parsing': '解析中…',
    'common.error': '错误',
    'common.warning': '警告',
    'common.note': '提示',
    'common.size': '大小',
    'common.format': '格式',
    'common.name': '名称',
    'common.empty': '（空）',
    'common.unknown': '未知',
    'common.noData': '没有收到可预览的文件字节（content 不是 bytes 模式）',

    'title.model': '3D 模型',
    'model.parsing': '正在解析 3D 模型…',
    'model.failed': '无法解析 3D 模型',
    'model.noData': '没有收到模型文件内容',
    'model.triangles': '三角形',
    'model.vertices': '顶点',
    'model.bounds': '包围盒尺寸',
    'model.wireframe': '线框',
    'model.reset': '重置视角',
    'model.hint': '拖拽旋转 · 滚轮缩放 · 右键 / Shift 拖拽平移 · 双击重置视角',
    'model.large': '模型较大（{n} 个三角形），渲染可能较慢；超过上限时会自动抽样降级',
    'model.warnings': '解析警告',
    'model.dimensions': '{x} × {y} × {z}',

    'title.archive': '压缩包',
    'archive.loading': '正在读取压缩包…',
    'archive.failed': '无法解析压缩包',
    'archive.unsupported': '暂不支持该压缩格式',
    'archive.entries': '条目',
    'archive.totalEntries': '共 {n} 个条目',
    'archive.unpacked': '解压后大小',
    'archive.name': '名称',
    'archive.mtime': '修改时间',
    'archive.method': '方法',
    'archive.encrypted': '已加密，无法预览',
    'archive.dir': '目录',
    'archive.empty': '压缩包是空的',
    'archive.selectEntry': '选择上方条目查看内容',
    'archive.reading': '正在读取条目…',
    'archive.readFailed': '读取条目失败',
    'archive.textTruncated': '内容过长，仅显示前 {bytes}',
    'archive.binaryEntry': '二进制条目',
    'archive.binaryHint': '该条目是二进制内容，暂不支持内嵌预览；可在本地应用中打开。',
    'archive.image': '图片',
    'archive.imageTruncated': '图片内容被截断，可能无法完整显示',
    'archive.encoding': '编码',
    'archive.truncatedRows': '条目较多，列表仅渲染前 {n} 条',
    'archive.truncatedArchive': '归档条目超过上限，仅列出前 {n} 条',
    'archive.notes': '说明',
    'archive.detail': '内容预览',
    'archive.compressed': '压缩后',
    'archive.file': '文件',
    'archive.mtimeUnknown': '—',

    'title.media': '媒体',
    'media.audio': '音频',
    'media.video': '视频',
    'media.unsupported': '浏览器不支持该编码',
    'media.unsupportedHint': '浏览器无法解码此音频 / 视频编码。可尝试转换为 MP4(H.264) / WebM(VP9)，或使用本地应用打开。',
    'media.error': '媒体加载失败',
    'media.mime': 'MIME',
    'media.noData': '没有收到媒体文件内容',
    'media.hint': '播放由浏览器原生解码器负责；MKV / MOV / FLAC 等格式的支持取决于具体浏览器。',
    'media.ready': '使用下方控件播放',

    'title.font': '字体',
    'font.loading': '正在加载字体…',
    'font.failed': '字体加载失败',
    'font.unsupported': '当前环境不支持 FontFace API',
    'font.hint': '字体文件可能已损坏，或浏览器不支持该字体格式。',
    'font.format': '格式',
    'font.size': '大小',
    'font.sample': '样张',
    'font.latinPangram': 'The quick brown fox jumps over the lazy dog. 0123456789',
    'font.cjkPangram': '天地玄黄，宇宙洪荒；日月盈昃，辰宿列张。',
    'font.uppercase': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'font.lowercase': 'abcdefghijklmnopqrstuvwxyz',
    'font.digits': '0123456789 !@#$%^&*()[]{}<>/\\|~',
    'font.ladder': '字号阶梯',
    'font.fallbackNote': '字体缺少的字符会自动回退到系统字体显示；中文字形取决于字体本身是否包含 CJK。',
    'font.mismatch': '扩展名（.{ext}）与字体内容（{format}）不一致',
    'font.px': '{n}px',

    'title.subtitle': '字幕',
    'subtitle.loading': '正在解析字幕…',
    'subtitle.failed': '字幕解析失败',
    'subtitle.noData': '没有收到字幕文件内容',
    'subtitle.cues': '字幕条数',
    'subtitle.encoding': '编码',
    'subtitle.duration': '总时长',
    'subtitle.empty': '未解析到字幕条目',
    'subtitle.emptyHint': '文件可能不是 SRT / VTT / ASS / SSA 字幕，或格式不常见；可切换到「原始文本」查看。',
    'subtitle.raw': '原始文本',
    'subtitle.cueList': '字幕列表',
    'subtitle.tooManyCues': '字幕条数过多，仅显示前 {n} 条',
    'subtitle.truncated': '文件较大，仅解析了前 {bytes}',
    'subtitle.invalid': '解析时有 {n} 个块无法识别，已跳过',
    'subtitle.noCues': '（没有可显示的字幕）',
  },
  en: {
    'common.loading': 'Loading…',
    'common.parsing': 'Parsing…',
    'common.error': 'Error',
    'common.warning': 'Warning',
    'common.note': 'Note',
    'common.size': 'Size',
    'common.format': 'Format',
    'common.name': 'Name',
    'common.empty': '(empty)',
    'common.unknown': 'unknown',
    'common.noData': 'No file bytes received (content is not in bytes mode)',

    'title.model': '3D model',
    'model.parsing': 'Parsing 3D model…',
    'model.failed': 'Could not parse the 3D model',
    'model.noData': 'No model file content received',
    'model.triangles': 'Triangles',
    'model.vertices': 'Vertices',
    'model.bounds': 'Bounds',
    'model.wireframe': 'Wireframe',
    'model.reset': 'Reset view',
    'model.hint': 'Drag to rotate · Scroll to zoom · Right / Shift-drag to pan · Double-click to reset',
    'model.large': 'Large model ({n} triangles); rendering may be slow and is downsampled above the limit',
    'model.warnings': 'Parse warnings',
    'model.dimensions': '{x} × {y} × {z}',

    'title.archive': 'Archive',
    'archive.loading': 'Reading archive…',
    'archive.failed': 'Could not parse the archive',
    'archive.unsupported': 'This archive format is not supported yet',
    'archive.entries': 'Entries',
    'archive.totalEntries': '{n} entries',
    'archive.unpacked': 'Unpacked size',
    'archive.name': 'Name',
    'archive.mtime': 'Modified',
    'archive.method': 'Method',
    'archive.encrypted': 'Encrypted entries cannot be previewed',
    'archive.dir': 'Folder',
    'archive.empty': 'The archive is empty',
    'archive.selectEntry': 'Select an entry above to preview it',
    'archive.reading': 'Reading entry…',
    'archive.readFailed': 'Could not read the entry',
    'archive.textTruncated': 'Content is too long; showing the first {bytes}',
    'archive.binaryEntry': 'Binary entry',
    'archive.binaryHint': 'This entry is binary content and cannot be previewed inline; open it in the native app instead.',
    'archive.image': 'Image',
    'archive.imageTruncated': 'The image data was truncated and may not render completely',
    'archive.encoding': 'Encoding',
    'archive.truncatedRows': 'Too many entries; only the first {n} rows are rendered',
    'archive.truncatedArchive': 'The archive exceeds the entry limit; only the first {n} entries are listed',
    'archive.notes': 'Notes',
    'archive.detail': 'Entry preview',
    'archive.compressed': 'Compressed',
    'archive.file': 'File',
    'archive.mtimeUnknown': '—',

    'title.media': 'Media',
    'media.audio': 'Audio',
    'media.video': 'Video',
    'media.unsupported': 'This codec is not supported by the browser',
    'media.unsupportedHint': 'The browser cannot decode this audio/video codec. Try converting to MP4(H.264) / WebM(VP9) or open it in the native app.',
    'media.error': 'Could not load the media',
    'media.mime': 'MIME',
    'media.noData': 'No media file content received',
    'media.hint': 'Playback uses the browser’s native decoders; MKV / MOV / FLAC support depends on the browser.',
    'media.ready': 'Use the controls below to play',

    'title.font': 'Font',
    'font.loading': 'Loading font…',
    'font.failed': 'Could not load the font',
    'font.unsupported': 'FontFace API is not available in this environment',
    'font.hint': 'The font file may be corrupt, or the browser does not support this font format.',
    'font.format': 'Format',
    'font.size': 'Size',
    'font.sample': 'Sample',
    'font.latinPangram': 'The quick brown fox jumps over the lazy dog. 0123456789',
    'font.cjkPangram': '天地玄黄，宇宙洪荒；日月盈昃，辰宿列张。',
    'font.uppercase': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'font.lowercase': 'abcdefghijklmnopqrstuvwxyz',
    'font.digits': '0123456789 !@#$%^&*()[]{}<>/\\|~',
    'font.ladder': 'Size ladder',
    'font.fallbackNote': 'Missing glyphs fall back to system fonts; CJK rendering depends on whether the font contains CJK glyphs.',
    'font.mismatch': 'Extension (.{ext}) does not match the font content ({format})',
    'font.px': '{n}px',

    'title.subtitle': 'Subtitles',
    'subtitle.loading': 'Parsing subtitles…',
    'subtitle.failed': 'Could not parse the subtitles',
    'subtitle.noData': 'No subtitle file content received',
    'subtitle.cues': 'Cues',
    'subtitle.encoding': 'Encoding',
    'subtitle.duration': 'Duration',
    'subtitle.empty': 'No subtitle cues found',
    'subtitle.emptyHint': 'The file may not be SRT/VTT/ASS/SSA, or uses an uncommon variant; switch to “Raw text” to inspect it.',
    'subtitle.raw': 'Raw text',
    'subtitle.cueList': 'Cue list',
    'subtitle.tooManyCues': 'Too many cues; only the first {n} are rendered',
    'subtitle.truncated': 'Large file; only the first {bytes} were parsed',
    'subtitle.invalid': '{n} blocks could not be parsed and were skipped',
    'subtitle.noCues': '(no cues to display)',
  },
};

// ---------------------------------------------------------------------------
// 预览定义（client.js 直接展开给 ctx.documentPreviews.register）
// ---------------------------------------------------------------------------

export const previewDefinitions = [
  {
    id: PREVIEW_IDS.model,
    titleKey: 'title.model',
    extensions: ['stl', 'obj', 'ply'],
    // ASCII STL 也可是文本，但 PLY/STL 多为二进制：按二进制后缀抑制「纯文本」候选。
    binaryExtensions: ['stl', 'ply'],
    loading: 'bytes-complete',
    wrap: false,
  },
  {
    id: PREVIEW_IDS.archive,
    titleKey: 'title.archive',
    extensions: ['zip', 'jar', 'war', 'apk', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar'],
    binaryExtensions: ['zip', 'jar', 'war', 'apk', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar'],
    loading: 'bytes-complete',
    wrap: false,
  },
  {
    id: PREVIEW_IDS.media,
    titleKey: 'title.media',
    extensions: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'mp4', 'webm', 'm4v', 'mov', 'mkv'],
    binaryExtensions: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'mp4', 'webm', 'm4v', 'mov', 'mkv'],
    loading: 'bytes-complete',
    wrap: false,
  },
  {
    id: PREVIEW_IDS.font,
    titleKey: 'title.font',
    extensions: ['ttf', 'otf', 'woff', 'woff2'],
    binaryExtensions: ['ttf', 'otf', 'woff', 'woff2'],
    loading: 'bytes-complete',
    wrap: false,
  },
  {
    id: PREVIEW_IDS.subtitle,
    titleKey: 'title.subtitle',
    extensions: ['srt', 'vtt', 'ass', 'ssa'],
    // 字幕是纯文本，保留内置「纯文本」候选项。
    loading: 'bytes-complete',
    wrap: false,
  },
];

// ---------------------------------------------------------------------------
// 注入样式（类前缀 dshpx-；颜色全部走 currentColor / color-mix，跟随明暗主题）
// ---------------------------------------------------------------------------

export const previewCss = `
.dshpx-root {
  box-sizing: border-box;
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: inherit;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
}
.dshpx-root *, .dshpx-root *::before, .dshpx-root *::after { box-sizing: border-box; }
.dshpx-scroll {
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, currentColor 22%, transparent) transparent;
}
.dshpx-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.dshpx-scroll::-webkit-scrollbar-track { background: transparent; }
.dshpx-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, currentColor 18%, transparent);
  background-clip: padding-box;
  border: 2px solid transparent;
  border-radius: 999px;
}
.dshpx-scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, currentColor 32%, transparent); background-clip: padding-box; }

.dshpx-toolbar {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 10px;
  padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  background: color-mix(in srgb, currentColor 3%, transparent);
}
.dshpx-toolbar-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.dshpx-toolbar-right { margin-left: auto; justify-content: flex-end; }
.dshpx-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  white-space: nowrap;
  color: color-mix(in srgb, currentColor 62%, transparent);
}
.dshpx-stat b { font-weight: 600; color: currentColor; font-variant-numeric: tabular-nums; }
.dshpx-badge {
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  background: color-mix(in srgb, currentColor 5%, transparent);
  color: color-mix(in srgb, currentColor 78%, transparent);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.dshpx-badge[data-tone="accent"] {
  border-color: color-mix(in srgb, currentColor 32%, transparent);
  color: currentColor;
}
.dshpx-mono {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  font-variant-numeric: tabular-nums;
}
.dshpx-notice {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 5px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  background: color-mix(in srgb, currentColor 4%, transparent);
  color: color-mix(in srgb, currentColor 74%, transparent);
  font-size: 11px;
  line-height: 1.5;
}
.dshpx-notice[data-tone="warning"] {
  color: color-mix(in srgb, #d97706 55%, currentColor);
  background: color-mix(in srgb, #d97706 9%, transparent);
  border-bottom-color: color-mix(in srgb, #d97706 22%, transparent);
}
.dshpx-notice[data-tone="error"] {
  color: color-mix(in srgb, #e5484d 62%, currentColor);
  background: color-mix(in srgb, #e5484d 9%, transparent);
  border-bottom-color: color-mix(in srgb, #e5484d 24%, transparent);
}
.dshpx-notice-icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-size: 9px;
  font-weight: 700;
  opacity: 0.85;
}
.dshpx-notice-body { min-width: 0; }
.dshpx-notice-line + .dshpx-notice-line { margin-top: 2px; }

.dshpx-state {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 18px;
  text-align: center;
  overflow: auto;
}
.dshpx-state[data-tone="inline"] { padding: 16px 12px; }
.dshpx-state-badge {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 700;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent);
  color: color-mix(in srgb, currentColor 75%, transparent);
}
.dshpx-state[data-tone="error"] .dshpx-state-badge {
  color: color-mix(in srgb, #e5484d 70%, currentColor);
  border-color: color-mix(in srgb, #e5484d 38%, transparent);
  background: color-mix(in srgb, #e5484d 10%, transparent);
}
.dshpx-state[data-tone="warning"] .dshpx-state-badge {
  color: color-mix(in srgb, #d97706 62%, currentColor);
  border-color: color-mix(in srgb, #d97706 36%, transparent);
  background: color-mix(in srgb, #d97706 10%, transparent);
}
.dshpx-state-title { font-size: 13px; font-weight: 600; max-width: 46em; color: currentColor; }
.dshpx-state-detail {
  max-width: 48em;
  font-size: 11.5px;
  line-height: 1.6;
  color: color-mix(in srgb, currentColor 62%, transparent);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.dshpx-state-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 2px; }
.dshpx-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 16%, transparent);
  border-top-color: color-mix(in srgb, currentColor 62%, transparent);
  animation: dshpx-spin 0.9s linear infinite;
}
@keyframes dshpx-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dshpx-spinner { animation-duration: 2.4s; }
}

.dshpx-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
}
.dshpx-btn:hover { background: color-mix(in srgb, currentColor 11%, transparent); }
.dshpx-btn[data-active="true"] {
  background: color-mix(in srgb, currentColor 16%, transparent);
  border-color: color-mix(in srgb, currentColor 30%, transparent);
}
.dshpx-btn:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 42%, transparent); outline-offset: 1px; }
.dshpx-action[data-active="true"] {
  background: color-mix(in srgb, currentColor 15%, transparent) !important;
  border-color: color-mix(in srgb, currentColor 30%, transparent) !important;
}

.dshpx-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: color-mix(in srgb, currentColor 4%, transparent);
}
.dshpx-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
.dshpx-stage-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; }
.dshpx-canvas-hint {
  position: absolute;
  left: 8px;
  bottom: 8px;
  right: 8px;
  pointer-events: none;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(10, 14, 20, 0.55);
  color: #e8eef6;
  font-size: 10.5px;
  line-height: 1.5;
  opacity: 0.85;
  transition: opacity 0.2s ease;
}
.dshpx-stage:hover .dshpx-canvas-hint { opacity: 0.4; }

.dshpx-split { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.dshpx-list {
  flex: 0 0 42%;
  min-height: 96px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
.dshpx-list-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 10.5px;
  color: color-mix(in srgb, currentColor 52%, transparent);
  background: color-mix(in srgb, currentColor 8%, transparent);
  backdrop-filter: blur(3px);
}
.dshpx-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 23px;
  padding: 1px 10px 1px 4px;
  white-space: nowrap;
  font-size: 11.5px;
}
.dshpx-entry:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.dshpx-entry[data-active="true"] {
  background: color-mix(in srgb, currentColor 12%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, currentColor 42%, transparent);
}
.dshpx-entry[data-dir="true"] { cursor: pointer; }
.dshpx-entry[data-file="true"] { cursor: pointer; }
.dshpx-entry:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 38%, transparent); outline-offset: -2px; }
.dshpx-entry-chevron {
  flex: 0 0 12px;
  width: 12px;
  text-align: center;
  font-size: 9px;
  opacity: 0.6;
  transition: transform 0.12s ease;
}
.dshpx-entry[data-open="true"] .dshpx-entry-chevron { transform: rotate(90deg); }
.dshpx-entry-icon { flex: 0 0 auto; display: inline-flex; align-items: center; opacity: 0.8; }
.dshpx-entry-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dshpx-entry[data-dir="true"] .dshpx-entry-name { font-weight: 600; }
.dshpx-entry-size, .dshpx-entry-time, .dshpx-entry-method {
  flex: 0 0 auto;
  color: color-mix(in srgb, currentColor 55%, transparent);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.dshpx-entry-size { width: 66px; }
.dshpx-entry-time { width: 112px; }
.dshpx-entry-method { width: 54px; opacity: 0.72; }
.dshpx-tree-indent { flex: 0 0 auto; }
@media (max-width: 720px) {
  .dshpx-entry-time { display: none; }
  .dshpx-list-head .dshpx-entry-time { display: none; }
}

.dshpx-detail { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.dshpx-detail-head {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 4px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  background: color-mix(in srgb, currentColor 3%, transparent);
  font-size: 11px;
}
.dshpx-detail-path {
  min-width: 0;
  flex: 1 1 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
}
.dshpx-detail-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.dshpx-code-wrap { flex: 0 0 auto; min-height: 100%; display: flex; align-items: flex-start; }
.dshpx-gutter {
  position: sticky;
  left: 0;
  flex: 0 0 auto;
  margin: 0;
  padding: 6px 8px 10px 10px;
  border-right: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  background: color-mix(in srgb, currentColor 4%, transparent);
  color: color-mix(in srgb, currentColor 42%, transparent);
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.55;
  text-align: right;
  white-space: pre;
  user-select: none;
}
.dshpx-pre {
  margin: 0;
  padding: 6px 12px 10px 8px;
  flex: 1 1 auto;
  min-width: 0;
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre;
  tab-size: 2;
  user-select: text;
}
.dshpx-image-wrap {
  flex: 0 0 auto;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
}
.dshpx-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 4%, transparent);
}
.dshpx-kv { display: flex; flex-wrap: wrap; gap: 3px 10px; color: color-mix(in srgb, currentColor 62%, transparent); font-size: 11px; }

.dshpx-media-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  padding: 10px;
  overflow: auto;
}
.dshpx-media-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, currentColor 5%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 6px;
  overflow: hidden;
}
.dshpx-media {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: 100%;
  border: 0;
  background: #000;
}
.dshpx-media-audio { max-width: 560px; background: transparent; }

.dshpx-font-scroll { flex: 1 1 auto; min-height: 0; padding: 12px 16px 28px; }
.dshpx-font-hero {
  font-size: 30px;
  line-height: 1.3;
  word-break: break-word;
  margin-bottom: 10px;
  user-select: text;
}
.dshpx-font-section {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.dshpx-font-section-title {
  font-size: 10.5px;
  color: color-mix(in srgb, currentColor 48%, transparent);
  margin-bottom: 6px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.dshpx-font-line { font-size: 16px; line-height: 1.6; word-break: break-word; user-select: text; }
.dshpx-font-ladder-row { display: flex; align-items: baseline; gap: 10px; margin-top: 2px; }
.dshpx-font-ladder-size {
  flex: 0 0 44px;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  color: color-mix(in srgb, currentColor 45%, transparent);
}
.dshpx-font-ladder-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dshpx-cues { flex: 1 1 auto; min-height: 0; padding: 2px 0 12px; }
.dshpx-cue {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 4px 12px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 6%, transparent);
}
.dshpx-cue:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
.dshpx-cue-index {
  flex: 0 0 30px;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  line-height: 1.7;
  color: color-mix(in srgb, currentColor 38%, transparent);
}
.dshpx-cue-time {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.65;
  color: color-mix(in srgb, currentColor 50%, transparent);
  white-space: nowrap;
}
.dshpx-cue-body {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.dshpx-raw-pre {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 8px 12px 16px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre;
  tab-size: 2;
  user-select: text;
}
`;

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function cx() {
  let out = '';
  for (let i = 0; i < arguments.length; i++) {
    const part = arguments[i];
    if (!part) continue;
    out = out ? out + ' ' + part : String(part);
  }
  return out;
}

function interpolate(text, params) {
  if (!params || typeof text !== 'string') return text;
  return text.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
}

/**
 * 取本地化文案：优先使用 props.t（locale 命名空间已注册），
 * 其次回退 previewLocales.zh / en，最后落到 fallback。
 */
function tr(t, key, fallback, params) {
  let value = null;
  if (typeof t === 'function') {
    try {
      value = t(key, params);
    } catch (err) {
      value = null;
    }
  }
  if (typeof value !== 'string' || value === '' || value === key) {
    value = null;
    if (previewLocales.zh && typeof previewLocales.zh[key] === 'string') value = previewLocales.zh[key];
    else if (previewLocales.en && typeof previewLocales.en[key] === 'string') value = previewLocales.en[key];
    else value = fallback != null ? fallback : key;
  }
  return interpolate(value, params);
}

function messageOf(err) {
  if (!err) return tr(null, 'common.unknown', '未知错误 / Unknown error');
  if (typeof err === 'string') return err;
  const msg = err.message || err.reason || String(err);
  const code = err.code ? ' (' + err.code + ')' : '';
  return msg + code;
}

function bytesOf(content) {
  if (!content) return null;
  const data = content.data;
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function bytesText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  try {
    return formatBytes(n);
  } catch (err) {
    return String(n) + ' B';
  }
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatMtime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return (
    date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  );
}

function formatClock(ms, withMillis) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  const head = hours > 0
    ? hours + ':' + pad2(minutes) + ':' + pad2(seconds)
    : pad2(minutes) + ':' + pad2(seconds);
  return withMillis === false ? head : head + '.' + String(millis).padStart(3, '0');
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  let digits;
  if (abs >= 1000) digits = 0;
  else if (abs >= 100) digits = 1;
  else if (abs >= 1) digits = 2;
  else if (abs >= 0.01) digits = 3;
  else return value.toExponential(1);
  return String(parseFloat(value.toFixed(digits)));
}

function extensionOf(name) {
  const base = String(name || '').split(/[\\/]/).pop().toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = base.slice(dot + 1);
  return ext === 'tar' ? 'tar' : ext;
}

function baseNameOf(name) {
  return String(name || '').split(/[\\/]/).pop() || '';
}

function fileNameFromAddress(address) {
  if (typeof address !== 'string' || !address) return '';
  const clean = address.split(/[?#]/)[0];
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const raw = slash >= 0 ? clean.slice(slash + 1) : clean;
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// 共享 hooks
// ---------------------------------------------------------------------------
/** 注入一次 dshpx 样式表（多实例 / 多 tab 幂等；若 client.js 已注入则复用）。 */
function usePreviewStyles() {
  react.useEffect(() => {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById(CSS_STYLE_ID)) return;
    if (typeof document.querySelector === 'function' && document.querySelector('style[data-dsh-preview-extra]')) return;
    const style = document.createElement('style');
    style.id = CSS_STYLE_ID;
    style.setAttribute('data-dsh-preview-extra', '');
    style.textContent = previewCss;
    document.head.appendChild(style);
  }, []);
}

/** 安全调用槽位注入的 useTabInfo（不可用时返回 null，不阻断预览）。 */
function useTabInfoSafe(props) {
  const hook = props && props.useTabInfo;
  if (typeof hook === 'function') {
    try {
      const info = hook();
      if (info && info.tab) return info.tab;
    } catch (err) {
      // 槽位未就绪 / 特殊环境：忽略，使用 resourceAddress 兜底
    }
  }
  return null;
}

function useFileName(props) {
  const tab = useTabInfoSafe(props);
  const title = tab && typeof tab.title === 'string' ? tab.title : '';
  const address = props && props.resourceAddress;
  return react.useMemo(() => title || fileNameFromAddress(address) || 'file', [title, address]);
}

/** 稳定滚动容器回调：同时交给外部 scrollportRef 记录滚动位置。 */
function useScrollport(props) {
  const external = props && typeof props.scrollportRef === 'function' ? props.scrollportRef : null;
  const localRef = react.useRef(null);
  const attach = react.useCallback((el) => {
    localRef.current = el;
    if (external) external(el);
  }, [external]);
  return [localRef, attach];
}

// ---------------------------------------------------------------------------
// 共享展示组件
// ---------------------------------------------------------------------------

function Badge(props) {
  return h(
    'span',
    { className: 'dshpx-badge', 'data-tone': props.tone || undefined, title: props.title || undefined },
    props.children
  );
}

function Stat(props) {
  return h(
    'span',
    { className: cx('dshpx-stat', props.mono !== false && 'dshpx-mono'), title: props.title || undefined },
    props.label ? h('span', null, props.label) : null,
    h('b', null, props.value)
  );
}

function Notice(props) {
  const items = (Array.isArray(props.items) ? props.items : [props.items]).filter(Boolean);
  if (!items.length) return null;
  const tone = props.tone || 'note';
  return h(
    'div',
    { className: 'dshpx-notice', 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' },
    h('span', { className: 'dshpx-notice-icon', 'aria-hidden': 'true' }, tone === 'note' ? 'i' : '!'),
    h('div', { className: 'dshpx-notice-body' },
      items.map((item, index) => h('div', { key: index, className: 'dshpx-notice-line' }, item)))
  );
}

function StatePanel(props) {
  const tone = props.tone || 'info';
  let icon = null;
  if (tone === 'loading') icon = h('div', { className: 'dshpx-spinner', 'aria-hidden': 'true' });
  else if (tone === 'error') icon = h('div', { className: 'dshpx-state-badge', 'aria-hidden': 'true' }, '!');
  else if (tone === 'warning') icon = h('div', { className: 'dshpx-state-badge', 'aria-hidden': 'true' }, '!');
  else icon = h('div', { className: 'dshpx-state-badge', 'aria-hidden': 'true' }, 'i');
  return h(
    'div',
    { className: 'dshpx-state', 'data-tone': tone, 'data-role': props.role || undefined },
    icon,
    props.title ? h('div', { className: 'dshpx-state-title' }, props.title) : null,
    props.detail ? h('div', { className: 'dshpx-state-detail' }, props.detail) : null,
    props.actions ? h('div', { className: 'dshpx-state-actions' }, props.actions) : null,
    props.children || null
  );
}

/** primitives.Button 优先，缺失时退回纯 DOM 按钮。 */
function ActionButton(props) {
  const rest = {};
  for (const key in props) {
    if (key === 'variant' || key === 'active' || key === 'icon' || key === 'children') continue;
    rest[key] = props[key];
  }
  const className = cx('dshpx-action', props.className);
  if (props.active !== undefined) {
    rest['data-active'] = props.active ? 'true' : undefined;
    rest['aria-pressed'] = !!props.active;
  }
  if (PrimButton) {
    return h(PrimButton, Object.assign({}, rest, {
      variant: props.variant || 'ghost',
      size: 'sm',
      className,
      icon: props.icon,
    }), props.children);
  }
  return h('button', Object.assign({}, rest, { type: 'button', className: cx('dshpx-btn', props.className) }),
    props.icon || null, props.children);
}

// ---------------------------------------------------------------------------
// 3D 模型（STL / OBJ / PLY）
// ---------------------------------------------------------------------------

/** 把 parseModel 结果归一成 renderer 约定的 model 形状，并提前校验可渲染性。 */
function normalizeModelResult(raw) {
  const scene = buildScene(raw); // 空网格 / NaN / 长度非法都会抛出可读错误
  return {
    format: raw && raw.format ? raw.format : 'unknown',
    variant: raw && raw.variant ? raw.variant : '',
    positions: scene.positions,
    normals: raw && raw.triangles && raw.triangles.normals ? raw.triangles.normals : null,
    triangleCount: scene.count,
    vertexCount:
      raw && raw.counts && Number.isFinite(raw.counts.vertices) ? raw.counts.vertices : scene.metrics.vertexCount,
    bounds: {
      min: scene.metrics.min.slice(),
      max: scene.metrics.max.slice(),
    },
    warnings: raw && Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean) : [],
    meta: raw && raw.meta ? raw.meta : {},
  };
}

export function ModelPreviewBody(props) {
  usePreviewStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);

  const [phase, setPhase] = react.useState('parsing');
  const [model, setModel] = react.useState(null);
  const [error, setError] = react.useState('');
  const [notice, setNotice] = react.useState('');
  const [wireframe, setWireframe] = react.useState(false);

  const canvasRef = react.useRef(null);
  const viewRef = react.useRef(null);
  const mountedRef = react.useRef(false);
  const wireframeRef = react.useRef(false);

  react.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 解析放在宏任务里：先让 loading 面板渲染，再阻塞解析（大文件时体验更好）。
  react.useEffect(() => {
    if (!data) {
      setModel(null);
      setPhase('error');
      setError(tr(t, 'model.noData', '没有收到模型文件内容 / No model data'));
      return undefined;
    }
    let cancelled = false;
    setPhase('parsing');
    setError('');
    setNotice('');
    const timer = setTimeout(() => {
      if (cancelled) return;
      try {
        if (data.byteLength > MODEL_SOFT_LIMIT) {
          throw new Error(
            '模型文件过大 / file too large: ' + bytesText(data.byteLength) + ' > ' + bytesText(MODEL_SOFT_LIMIT)
          );
        }
        const parsed = parseModel(fileName, data);
        if (parsed && parsed.error) {
          setModel(null);
          setPhase('error');
          setError(String(parsed.error));
          return;
        }
        const normalized = normalizeModelResult(parsed);
        setModel(normalized);
        setPhase('ready');
      } catch (err) {
        setModel(null);
        setPhase('error');
        setError(messageOf(err));
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [data, fileName]);

  // 画布只创建一次；content 变化时走 view.setModel，避免重复绑定事件 / ResizeObserver。
  react.useEffect(() => {
    if (!model || phase !== 'ready') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    if (viewRef.current) {
      try {
        viewRef.current.setModel(model);
        viewRef.current.setWireframe(wireframeRef.current);
        viewRef.current.resetView();
      } catch (err) {
        setPhase('error');
        setError(messageOf(err));
      }
      return undefined;
    }
    try {
      const view = createModelView({
        canvas,
        model,
        options: {
          wireframe: wireframeRef.current,
          onNotice: (message) => {
            if (mountedRef.current) setNotice(String(message || ''));
          },
        },
      });
      viewRef.current = view;
      view.setWireframe(wireframeRef.current);
      view.resetView();
    } catch (err) {
      setPhase('error');
      setError(messageOf(err));
    }
    return undefined;
  }, [model, phase]);

  react.useEffect(() => {
    wireframeRef.current = wireframe;
    const view = viewRef.current;
    if (view) {
      try {
        view.setWireframe(wireframe);
      } catch (err) {
        // 视图已销毁 / 画布不可用：忽略
      }
    }
  }, [wireframe]);

  // 卸载必须 destroy()（释放 ResizeObserver / pointer 事件 / rAF）。
  react.useEffect(() => () => {
    const view = viewRef.current;
    viewRef.current = null;
    if (view) {
      try {
        view.destroy();
      } catch (err) {
        // ignore
      }
    }
  }, []);

  const summary = react.useMemo(() => {
    if (!model) return null;
    const dims = [
      model.bounds.max[0] - model.bounds.min[0],
      model.bounds.max[1] - model.bounds.min[1],
      model.bounds.max[2] - model.bounds.min[2],
    ];
    return {
      format: String(model.format || '').toUpperCase() || '3D',
      triangles: model.triangleCount,
      vertices: model.vertexCount,
      dimensions: tr(t, 'model.dimensions', '{x} × {y} × {z}', {
        x: formatNumber(dims[0]),
        y: formatNumber(dims[1]),
        z: formatNumber(dims[2]),
      }),
      large: model.triangleCount > 200000,
    };
  }, [model, t]);

  const notices = [];
  if (summary && summary.large) {
    notices.push(tr(t, 'model.large', '模型较大，渲染可能较慢', { n: summary.triangles }));
  }
  if (model && model.warnings.length) {
    for (let i = 0; i < model.warnings.length && i < 3; i++) {
      notices.push(tr(t, 'model.warnings', '解析警告') + ': ' + model.warnings[i]);
    }
  }
  if (notice) notices.push(notice);

  if (!data) {
    return h('div', { className: 'dshpx-root' },
      h(StatePanel, {
        tone: 'error',
        title: tr(t, 'model.noData', '没有收到模型文件内容'),
        detail: fileName,
      }));
  }

  let overlay = null;
  if (phase === 'parsing') {
    overlay = h(StatePanel, {
      tone: 'loading',
      title: tr(t, 'model.parsing', '正在解析 3D 模型…'),
      detail: fileName + ' · ' + bytesText(data.byteLength),
    });
  } else if (phase === 'error') {
    overlay = h(StatePanel, {
      tone: 'error',
      title: tr(t, 'model.failed', '无法解析 3D 模型'),
      detail: fileName + '\n' + error,
    });
  }

  return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'model' },
    h('div', { className: 'dshpx-toolbar' },
      h('div', { className: 'dshpx-toolbar-group' },
        h(Badge, { tone: 'accent' }, summary ? summary.format : '3D'),
        summary ? h(Stat, { label: tr(t, 'model.triangles', '三角形'), value: summary.triangles }) : null,
        summary ? h(Stat, { label: tr(t, 'model.vertices', '顶点'), value: summary.vertices }) : null,
        summary
          ? h(Stat, { label: tr(t, 'model.bounds', '包围盒'), value: summary.dimensions, title: summary.dimensions })
          : null),
      h('div', { className: 'dshpx-toolbar-group dshpx-toolbar-right' },
        h(ActionButton, {
          active: wireframe,
          onClick: () => setWireframe((value) => !value),
          title: tr(t, 'model.wireframe', '线框'),
          disabled: !summary,
        }, tr(t, 'model.wireframe', '线框')),
        h(ActionButton, {
          onClick: () => {
            const view = viewRef.current;
            if (view) {
              try {
                view.resetView();
              } catch (err) {
                // ignore
              }
            }
          },
          title: tr(t, 'model.reset', '重置视角'),
          disabled: !summary,
        }, tr(t, 'model.reset', '重置视角')))),
    notices.length ? h(Notice, { tone: 'warning', items: notices }) : null,
    h('div', { className: 'dshpx-stage' },
      h('canvas', {
        ref: canvasRef,
        className: 'dshpx-canvas',
        'aria-label': fileName,
        style: { visibility: phase === 'ready' ? 'visible' : 'hidden' },
      }),
      overlay ? h('div', { className: 'dshpx-stage-overlay' }, overlay) : null,
      phase === 'ready' ? h('div', { className: 'dshpx-canvas-hint' }, tr(t, 'model.hint', '拖拽旋转 · 滚轮缩放')) : null));
}

// ---------------------------------------------------------------------------
// 媒体（音频 / 视频）
// ---------------------------------------------------------------------------

function mediaKindOf(ext, fileName) {
  const normalized = String(ext || '').toLowerCase();
  if (VIDEO_EXTENSIONS.indexOf(normalized) >= 0) return 'video';
  if (AUDIO_EXTENSIONS.indexOf(normalized) >= 0) return 'audio';
  if (/\.(mp4|webm|mov|mkv|m4v)$/i.test(String(fileName || ''))) return 'video';
  return 'audio';
}

function mediaMimeOf(ext, kind) {
  const normalized = String(ext || '').toLowerCase();
  const table = kind === 'video' ? VIDEO_MIME : AUDIO_MIME;
  return table[normalized] || (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
}

export function MediaPreviewBody(props) {
  usePreviewStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);
  const ext = extensionOf(fileName);
  const kind = mediaKindOf(ext, fileName);
  const mime = mediaMimeOf(ext, kind);

  const [url, setUrl] = react.useState(null);
  const [error, setError] = react.useState(null);

  react.useEffect(() => {
    setUrl(null);
    setError(null);
    if (!data) return undefined;
    if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setError({
        kind: 'unsupported',
        message: tr(t, 'media.unsupported', '浏览器不支持该编码'),
      });
      return undefined;
    }
    let objectUrl = null;
    try {
      objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
      setUrl(objectUrl);
    } catch (err) {
      setError({ kind: 'runtime', message: messageOf(err) });
    }
    return () => {
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (err) {
          // ignore
        }
      }
    };
  }, [data, mime]);

  const handleError = () => {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (err) {
        // ignore
      }
    }
    setUrl(null);
    setError({ kind: 'unsupported', message: tr(t, 'media.unsupported', '浏览器不支持该编码') });
  };

  const toolbar = h('div', { className: 'dshpx-toolbar' },
    h('div', { className: 'dshpx-toolbar-group' },
      h(Badge, { tone: 'accent' }, kind === 'video' ? tr(t, 'media.video', '视频') : tr(t, 'media.audio', '音频')),
      h(Badge, null, data ? bytesText(data.byteLength) : '—'),
      h(Badge, null, mime),
      h(Stat, { value: fileName, title: fileName })));

  if (!data) {
    return h('div', { className: 'dshpx-root' },
      toolbar,
      h(StatePanel, { tone: 'error', title: tr(t, 'media.noData', '没有收到媒体文件内容'), detail: fileName }));
  }

  let content;
  if (error) {
    content = h(StatePanel, {
      tone: 'error',
      title: error.kind === 'unsupported' ? tr(t, 'media.unsupported', '浏览器不支持该编码') : tr(t, 'media.error', '媒体加载失败'),
      detail: [
        fileName,
        'MIME: ' + mime,
        tr(t, 'common.size', '大小') + ': ' + bytesText(data.byteLength),
        error.message || '',
        tr(t, 'media.unsupportedHint', '浏览器无法解码此音频 / 视频编码。'),
      ].filter(Boolean).join('\n'),
    });
  } else if (!url) {
    content = h(StatePanel, { tone: 'loading', title: tr(t, 'common.loading', '加载中…'), detail: fileName });
  } else {
    content = h('div', { className: 'dshpx-media-stage' },
      h(kind === 'video' ? 'video' : 'audio', {
        src: url,
        controls: true,
        preload: 'metadata',
        className: cx('dshpx-media', kind === 'audio' && 'dshpx-media-audio'),
        onError: handleError,
        'aria-label': fileName,
        title: fileName,
      }, tr(t, 'media.ready', '使用下方控件播放')));
  }

  return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'media' },
    toolbar,
    h(Notice, { tone: 'note', items: [tr(t, 'media.hint', '播放由浏览器原生解码器负责')] }),
    h('div', { className: 'dshpx-media-wrap' }, content));
}

// ---------------------------------------------------------------------------
// 字体（TTF / OTF / WOFF / WOFF2）
// ---------------------------------------------------------------------------

let fontInstanceSeq = 0;

/** 按文件头魔数识别字体格式（不依赖扩展名）。 */
function fontFormatOf(data) {
  if (!data || data.length < 4) return { format: 'unknown', label: '' };
  const tag = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (tag === 'OTTO') return { format: 'otf', label: 'OTTO' };
  if (tag === 'wOFF') return { format: 'woff', label: 'wOFF' };
  if (tag === 'wOF2') return { format: 'woff2', label: 'wOF2' };
  if (tag === 'true') return { format: 'ttf', label: 'true' };
  if (tag === 'ttcf') return { format: 'ttc', label: 'ttcf' };
  if (data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0) return { format: 'ttf', label: '00010000' };
  const hex = [];
  for (let i = 0; i < Math.min(4, data.length); i++) hex.push(data[i].toString(16).padStart(2, '0'));
  return { format: 'unknown', label: hex.join(' ') };
}

/** FontFace 需要精确的 ArrayBuffer：子视图不能把 underlying buffer 的无关字节一起传进去。 */
function exactArrayBuffer(data) {
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
  }
  return data;
}

export function FontPreviewBody(props) {
  usePreviewStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);
  const ext = extensionOf(fileName);

  const [phase, setPhase] = react.useState('loading');
  const [family, setFamily] = react.useState('');
  const [error, setError] = react.useState('');
  const [, attachScroll] = useScrollport(props);

  const info = react.useMemo(() => fontFormatOf(data), [data]);

  react.useEffect(() => {
    let cancelled = false;
    let face = null;
    setFamily('');
    setError('');
    if (!data) {
      setPhase('nodata');
      return undefined;
    }
    setPhase('loading');
    if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
      setPhase('error');
      setError(tr(t, 'font.unsupported', '当前环境不支持 FontFace API'));
      return undefined;
    }
    fontInstanceSeq += 1;
    const nextFamily = 'DshPreviewFont' + fontInstanceSeq + '_' + Math.random().toString(36).slice(2, 8);
    try {
      face = new FontFace(nextFamily, exactArrayBuffer(data));
    } catch (err) {
      setPhase('error');
      setError(messageOf(err));
      return undefined;
    }
    face.load().then((loaded) => {
      if (cancelled) return;
      try {
        document.fonts.add(loaded);
      } catch (err) {
        setPhase('error');
        setError(messageOf(err));
        return;
      }
      setFamily(nextFamily);
      setPhase('ready');
    }).catch((err) => {
      if (!cancelled) {
        setPhase('error');
        setError(messageOf(err));
      }
    });
    return () => {
      cancelled = true;
      if (face) {
        try {
          document.fonts.delete(face);
        } catch (err) {
          // ignore
        }
      }
    };
  }, [data]);

  const toolbar = h('div', { className: 'dshpx-toolbar' },
    h('div', { className: 'dshpx-toolbar-group' },
      h(Badge, { tone: 'accent' }, info.format === 'unknown' ? tr(t, 'common.unknown', '未知') : info.format.toUpperCase()),
      ext ? h(Badge, null, '.' + ext) : null,
      h(Badge, null, data ? bytesText(data.byteLength) : '—'),
      h(Stat, { value: fileName, title: fileName })));

  if (!data) {
    return h('div', { className: 'dshpx-root' },
      toolbar,
      h(StatePanel, {
        tone: 'error',
        title: tr(t, 'common.noData', '没有收到可预览的文件字节（content 不是 bytes 模式）'),
        detail: fileName,
      }));
  }

  if (phase === 'loading') {
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'font' },
      toolbar,
      h(StatePanel, {
        tone: 'loading',
        title: tr(t, 'font.loading', '正在加载字体…'),
        detail: fileName + ' · ' + bytesText(data.byteLength),
      }));
  }

  if (phase === 'error' || phase === 'nodata') {
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'font' },
      toolbar,
      h(StatePanel, {
        tone: 'error',
        title: tr(t, 'font.failed', '字体加载失败'),
        detail: [fileName, '格式 / format: ' + (info.format === 'unknown' ? (info.label || '?') : info.format), error,
          tr(t, 'font.hint', '字体文件可能已损坏，或浏览器不支持该字体格式。')].filter(Boolean).join('\n'),
      }));
  }

  const familyStack = '"' + family + '", ui-sans-serif, system-ui, "Microsoft YaHei", "PingFang SC", sans-serif';
  const knownFontExts = ['ttf', 'otf', 'woff', 'woff2'];
  const mismatch = ext && knownFontExts.indexOf(ext) >= 0 && info.format !== 'unknown' && info.format !== ext;
  const notices = [];
  if (mismatch) {
    notices.push(tr(t, 'font.mismatch', '扩展名与字体内容不一致', { ext, format: info.format }));
  }
  notices.push(tr(t, 'font.fallbackNote', '字体缺少的字符会回退到系统字体显示。'));

  const sampleLines = [
    ['font.latinPangram', 'The quick brown fox jumps over the lazy dog. 0123456789', 18],
    ['font.cjkPangram', '天地玄黄，宇宙洪荒；日月盈昃，辰宿列张。', 18],
    ['font.uppercase', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 16],
    ['font.lowercase', 'abcdefghijklmnopqrstuvwxyz', 16],
    ['font.digits', '0123456789 !@#$%^&*()[]{}<>/\\|~', 16],
  ];
  const ladder = [12, 16, 20, 24, 32, 48];

  const sampleSection = h('div', { className: 'dshpx-font-section' },
    h('div', { className: 'dshpx-font-section-title' }, tr(t, 'font.sample', '样张')),
    sampleLines.map((item) => h('div', {
      key: item[0],
      className: 'dshpx-font-line',
      style: { fontFamily: familyStack, fontSize: item[2] + 'px' },
    }, tr(t, item[0], item[1]))));

  const ladderSection = h('div', { className: 'dshpx-font-section' },
    h('div', { className: 'dshpx-font-section-title' }, tr(t, 'font.ladder', '字号阶梯')),
    ladder.map((size) => h('div', { key: 'ladder-' + size, className: 'dshpx-font-ladder-row' },
      h('span', { className: 'dshpx-font-ladder-size' }, tr(t, 'font.px', '{n}px', { n: size })),
      h('span', {
        className: 'dshpx-font-ladder-text',
        style: { fontFamily: familyStack, fontSize: size + 'px', lineHeight: 1.35 },
      }, tr(t, 'font.latinPangram', 'The quick brown fox jumps over the lazy dog.')))));

  return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'font' },
    toolbar,
    h(Notice, { tone: 'note', items: notices }),
    h('div', { className: 'dshpx-font-scroll dshpx-scroll', ref: attachScroll },
      h('div', { className: 'dshpx-font-hero', style: { fontFamily: familyStack }, title: fileName }, baseNameOf(fileName)),
      sampleSection,
      ladderSection));
}

// ---------------------------------------------------------------------------
// 压缩包（zip / tar / gz / tgz；7z / rar / xz / bz2 / zst 给出可读提示）
// ---------------------------------------------------------------------------

/** 目录默认展开策略：展开顶层目录；若只有一条单链根目录则继续展开几层。 */
function initialExpandedPaths(tree) {
  const expanded = new Set();
  if (!tree || !tree.children || !tree.children.length) return expanded;
  let level = tree.children;
  for (let depth = 0; depth < 4; depth++) {
    let onlyDir = null;
    for (const node of level) {
      if (node.dir) expanded.add(node.path);
    }
    if (level.length === 1 && level[0].dir) onlyDir = level[0];
    if (!onlyDir || !onlyDir.children || !onlyDir.children.length) break;
    level = onlyDir.children;
  }
  return expanded;
}

/** 按展开状态把目录树压平成可见行（迭代实现，避免深层目录爆栈）。 */
function flattenVisibleTree(root, expanded, limit) {
  const rows = [];
  if (!root || !root.children) return rows;
  const stack = [];
  for (let i = root.children.length - 1; i >= 0; i--) stack.push({ node: root.children[i], depth: 0 });
  while (stack.length && rows.length < limit) {
    const item = stack.pop();
    rows.push(item);
    const node = item.node;
    if (node.dir && expanded.has(node.path) && node.children && node.children.length) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], depth: item.depth + 1 });
      }
    }
  }
  return rows;
}

function ArchiveEntryRow(props) {
  const node = props.node;
  const depth = props.depth || 0;
  const isDir = !!node.dir;
  const entry = node.entry;
  const open = isDir && props.open;
  let icon = null;
  if (Prim.FileTypeIcon) {
    try {
      icon = h(Prim.FileTypeIcon, { path: node.path, size: 14 });
    } catch (err) {
      icon = null;
    }
  }
  const activate = () => props.onActivate(node);
  return h('div', {
    className: 'dshpx-entry',
    'data-dir': isDir ? 'true' : undefined,
    'data-file': !isDir ? 'true' : undefined,
    'data-open': open ? 'true' : undefined,
    'data-active': !isDir && props.active ? 'true' : undefined,
    role: 'treeitem',
    'aria-expanded': isDir ? open : undefined,
    tabIndex: 0,
    title: node.path,
    onClick: activate,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    },
  },
    h('span', { className: 'dshpx-tree-indent', style: { width: depth * 14 + 'px' } }),
    h('span', { className: 'dshpx-entry-chevron', 'aria-hidden': 'true' }, isDir ? '\u25B8' : ''),
    icon ? h('span', { className: 'dshpx-entry-icon' }, icon) : null,
    h('span', { className: 'dshpx-entry-name' }, node.name),
    h('span', { className: 'dshpx-entry-size' }, isDir ? '—' : bytesText(node.size || 0)),
    h('span', { className: 'dshpx-entry-time' }, isDir ? '' : formatMtime(node.mtime)),
    h('span', { className: 'dshpx-entry-method' }, isDir ? '' : entry && entry.method ? String(entry.method) : ''));
}

export function ArchivePreviewBody(props) {
  usePreviewStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);

  const [listState, setListState] = react.useState({ status: data ? 'loading' : 'empty' });
  const [selected, setSelected] = react.useState(null);
  const [expanded, setExpanded] = react.useState(() => new Set());
  const [detail, setDetail] = react.useState({ status: 'idle' });
  const [detailScrollRef, attachDetailScroll] = useScrollport(props);

  // 列举归档（异步 + 竞态取消）。
  react.useEffect(() => {
    if (!data) {
      setListState({ status: 'empty' });
      return undefined;
    }
    let cancelled = false;
    setListState({ status: 'loading' });
    setSelected(null);
    setDetail({ status: 'idle' });
    (async () => {
      try {
        const result = await listArchive(data, { filename: fileName });
        if (cancelled) return;
        if (!result || result.supported === false) {
          setListState({ status: 'unsupported', result: result || null });
        } else {
          setListState({ status: 'ready', result });
        }
      } catch (err) {
        if (cancelled) return;
        let detected = null;
        try {
          detected = detectArchive(data, fileName);
        } catch (detectErr) {
          detected = null;
        }
        setListState({ status: 'error', error: messageOf(err), detected });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, fileName]);

  const entries = listState.status === 'ready' && listState.result && listState.result.entries
    ? listState.result.entries
    : EMPTY_ARRAY;
  const shownEntries = react.useMemo(
    () => (entries.length > MAX_ARCHIVE_ROWS ? entries.slice(0, MAX_ARCHIVE_ROWS) : entries),
    [entries]
  );
  const tree = react.useMemo(() => (shownEntries.length ? buildTree(shownEntries) : null), [shownEntries]);

  // 新归档到达：重置展开状态、选中项与内容区。
  react.useEffect(() => {
    setExpanded(initialExpandedPaths(tree));
    setSelected(null);
    setDetail({ status: 'idle' });
  }, [tree]);

  const rows = react.useMemo(
    () => (tree ? flattenVisibleTree(tree, expanded, MAX_ARCHIVE_ROWS + 500) : EMPTY_ARRAY),
    [tree, expanded]
  );

  const togglePath = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const activateNode = (node) => {
    if (!node) return;
    if (node.dir) {
      togglePath(node.path);
      return;
    }
    if (node.entry) setSelected(node.entry);
  };

  // 读取单个条目（文本 / 图片 / 二进制 / 加密错误），卸载与切换时取消并 revoke Blob URL。
  react.useEffect(() => {
    if (!selected || !data) return undefined;
    let cancelled = false;
    let objectUrl = null;
    setDetail({ status: 'loading', entry: selected });
    (async () => {
      try {
        if (selected.encrypted) {
          if (!cancelled) {
            setDetail({
              status: 'error',
              entry: selected,
              error: tr(t, 'archive.encrypted', '该条目已加密，无法预览 / encrypted entry'),
            });
          }
          return;
        }
        const result = await readEntry(data, selected);
        if (cancelled) return;
        const hint = result.textualHint;
        if (hint === 'text') {
          const limit = Math.min(TEXT_PREVIEW_BYTES, result.bytes.length);
          const slice = result.bytes.subarray(0, limit);
          let decoded = null;
          try {
            decoded = decodeTextBytes(slice, { maxBytes: TEXT_PREVIEW_BYTES });
          } catch (decodeErr) {
            decoded = null;
          }
          const text = decoded && typeof decoded.text === 'string' ? decoded.text : utf8OrLatin1(slice);
          const allLines = text ? text.split('\n') : [];
          const truncatedLines = allLines.length > MAX_TEXT_LINES;
          const lines = truncatedLines ? allLines.slice(0, MAX_TEXT_LINES) : allLines;
          const gutter = [];
          for (let i = 1; i <= lines.length; i++) gutter.push(String(i));
          setDetail({
            status: 'text',
            entry: selected,
            text: lines.join('\n'),
            gutter: gutter.join('\n'),
            lineCount: lines.length,
            encoding: decoded ? decoded.encoding : 'unknown',
            truncated: !!result.truncated || result.bytes.length > limit || truncatedLines,
            note: result.note || '',
            totalBytes: selected.size,
          });
        } else if (hint === 'image') {
          if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            setDetail({
              status: 'binary',
              entry: selected,
              mime: result.mime || '',
              note: result.note || '',
              bytes: result.bytes.length,
              truncated: !!result.truncated,
            });
            return;
          }
          const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mime || 'application/octet-stream' }));
          if (cancelled) {
            try {
              URL.revokeObjectURL(url);
            } catch (revokeErr) {
              // ignore
            }
            return;
          }
          objectUrl = url;
          setDetail({
            status: 'image',
            entry: selected,
            url,
            mime: result.mime || '',
            truncated: !!result.truncated,
            note: result.note || '',
          });
        } else if (hint === 'empty') {
          setDetail({ status: 'empty', entry: selected });
        } else {
          setDetail({
            status: 'binary',
            entry: selected,
            mime: result.mime || '',
            note: result.note || '',
            bytes: result.bytes.length,
            truncated: !!result.truncated,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setDetail({
            status: 'error',
            entry: selected,
            error: messageOf(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (err) {
          // ignore
        }
      }
    };
  }, [selected, data]);

  // 切换条目时把内容区滚回顶部。
  react.useEffect(() => {
    const el = detailScrollRef.current;
    if (el && el.scrollTop) el.scrollTop = 0;
  }, [selected]);

  // ---- 面板 ----
  if (!data) {
    return h('div', { className: 'dshpx-root' },
      h(StatePanel, {
        tone: 'error',
        title: tr(t, 'common.noData', '没有收到可预览的文件字节'),
        detail: fileName,
      }));
  }

  if (listState.status === 'loading') {
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'archive' },
      h(StatePanel, {
        tone: 'loading',
        title: tr(t, 'archive.loading', '正在读取压缩包…'),
        detail: fileName + ' · ' + bytesText(data.byteLength),
      }));
  }

  if (listState.status === 'error') {
    const detected = listState.detected;
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'archive' },
      h(StatePanel, {
        tone: 'error',
        title: tr(t, 'archive.failed', '无法解析压缩包'),
        detail: [fileName, listState.error, detected && detected.format ? tr(t, 'common.format', '格式') + ': ' + detected.format : '',
          detected && detected.hint ? detected.hint : ''].filter(Boolean).join('\n'),
      }));
  }

  if (listState.status === 'unsupported') {
    const result = listState.result;
    const hint = (result && (result.hint || (result.notes && result.notes[0]))) || '';
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'archive' },
      h(StatePanel, {
        tone: 'warning',
        title: tr(t, 'archive.unsupported', '暂不支持该压缩格式'),
        detail: [fileName, result && result.format ? tr(t, 'common.format', '格式') + ': ' + result.format : '', hint]
          .filter(Boolean).join('\n'),
      }));
  }

  if (listState.status === 'empty') {
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'archive' },
      h(StatePanel, { tone: 'info', title: tr(t, 'archive.empty', '压缩包是空的'), detail: fileName }));
  }

  const result = listState.result || {};

  if (entries.length === 0) {
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'archive' },
      h(StatePanel, {
        tone: 'info',
        title: tr(t, 'archive.empty', '压缩包是空的'),
        detail: [fileName, result.format ? tr(t, 'common.format', '格式') + ': ' + String(result.format).toUpperCase() : '']
          .filter(Boolean).join('\n'),
      }));
  }

  const notices = [];
  if (result.truncated) {
    notices.push(tr(t, 'archive.truncatedArchive', '归档条目超过上限，仅列出前 {n} 条', { n: entries.length }));
  }
  if (entries.length > shownEntries.length) {
    notices.push(tr(t, 'archive.truncatedRows', '条目较多，列表仅渲染前 {n} 条', { n: shownEntries.length }));
  }
  if (result.hint) notices.push(result.hint);
  if (result.notes && result.notes.length) {
    for (let i = 0; i < result.notes.length && i < 4; i++) notices.push(result.notes[i]);
  }

  const toolbar = h('div', { className: 'dshpx-toolbar' },
    h('div', { className: 'dshpx-toolbar-group' },
      result.format ? h(Badge, { tone: 'accent' }, String(result.format).toUpperCase()) : null,
      h(Stat, { label: tr(t, 'archive.entries', '条目'), value: entries.length }),
      Number.isFinite(result.declaredTotalBytes)
        ? h(Stat, { label: tr(t, 'archive.unpacked', '解压后'), value: bytesText(result.declaredTotalBytes) })
        : null,
      h(Stat, { value: fileName, title: fileName })));

  const list = h('div', { className: 'dshpx-list dshpx-scroll', role: 'tree', 'aria-label': fileName },
    h('div', { className: 'dshpx-list-head' },
      h('span', { className: 'dshpx-entry-chevron', 'aria-hidden': 'true' }),
      h('span', { className: 'dshpx-entry-name' }, tr(t, 'archive.name', '名称')),
      h('span', { className: 'dshpx-entry-size' }, tr(t, 'common.size', '大小')),
      h('span', { className: 'dshpx-entry-time' }, tr(t, 'archive.mtime', '修改时间')),
      h('span', { className: 'dshpx-entry-method' }, tr(t, 'archive.method', '方法'))),
    rows.map((row) =>
      h(ArchiveEntryRow, {
        key: row.node.path || row.node.name + ':' + row.depth,
        node: row.node,
        depth: row.depth,
        open: expanded.has(row.node.path),
        active: !!selected && !!(row.node.entry && selected.path === row.node.entry.path),
        onActivate: activateNode,
      })));

  let detailHeader = null;
  let detailBody = null;

  if (!selected) {
    detailBody = h('div', { className: 'dshpx-detail-body dshpx-scroll', ref: attachDetailScroll },
      h(StatePanel, {
        tone: 'info',
        role: 'inline',
        title: tr(t, 'archive.selectEntry', '选择上方条目查看内容'),
        detail: fileName,
      }));
  } else {
    const entry = selected;
    detailHeader = h('div', { className: 'dshpx-detail-head' },
      h('span', { className: 'dshpx-detail-path', title: entry.path }, entry.path),
      h(Badge, null, tr(t, 'common.size', '大小') + ' ' + bytesText(entry.size)),
      entry.compressedSize != null
        ? h('span', { className: 'dshpx-kv' }, tr(t, 'archive.compressed', '压缩后') + ' ' + bytesText(entry.compressedSize))
        : null,
      h('span', { className: 'dshpx-kv' }, tr(t, 'archive.mtime', '修改时间') + ' ' + formatMtime(entry.mtime)),
      entry.method ? h(Badge, null, String(entry.method)) : null,
      entry.encrypted ? h(Badge, { tone: 'accent' }, tr(t, 'archive.encrypted', '已加密')) : null);

    if (detail.status === 'loading' || detail.status === 'idle') {
      detailBody = h(StatePanel, {
        tone: 'loading',
        role: 'inline',
        title: tr(t, 'archive.reading', '正在读取条目…'),
        detail: entry.path,
      });
    } else if (detail.status === 'error') {
      detailBody = h(StatePanel, {
        tone: 'error',
        role: 'inline',
        title: tr(t, 'archive.readFailed', '读取条目失败'),
        detail: entry.path + '\n' + detail.error,
      });
    } else if (detail.status === 'empty') {
      detailBody = h(StatePanel, {
        tone: 'info',
        role: 'inline',
        title: tr(t, 'common.empty', '（空）'),
        detail: entry.path,
      });
    } else if (detail.status === 'image') {
      detailBody = h('div', { className: 'dshpx-image-wrap' },
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', maxWidth: '100%' } },
          h('img', {
            className: 'dshpx-image',
            src: detail.url,
            alt: entry.path,
            onError: () => setDetail({ status: 'error', entry, error: tr(t, 'archive.readFailed', '读取条目失败') }),
          }),
          (detail.truncated || detail.note)
            ? h('div', { className: 'dshpx-kv' },
                detail.note || tr(t, 'archive.imageTruncated', '图片内容被截断，可能无法完整显示'))
            : null));
    } else if (detail.status === 'text') {
      detailBody = h('div', { className: 'dshpx-code-wrap' },
        h('pre', { className: 'dshpx-gutter', 'aria-hidden': 'true' }, detail.gutter),
        h('pre', { className: 'dshpx-pre' }, detail.text));
    } else if (detail.status === 'binary') {
      detailBody = h(StatePanel, {
        tone: 'info',
        role: 'inline',
        title: tr(t, 'archive.binaryEntry', '二进制条目'),
        detail: [
          entry.path,
          tr(t, 'common.size', '大小') + ': ' + bytesText(detail.bytes || entry.size),
          detail.mime ? 'MIME: ' + detail.mime : '',
          detail.truncated ? tr(t, 'archive.imageTruncated', '内容被截断') : '',
          detail.note || '',
          tr(t, 'archive.binaryHint', '该条目是二进制内容，暂不支持内嵌预览。'),
        ].filter(Boolean).join('\n'),
      });
    }

    if (detail.status === 'text') {
      const textNotices = [];
      if (detail.truncated) {
        textNotices.push(tr(t, 'archive.textTruncated', '内容过长，仅显示前 {bytes}', {
          bytes: bytesText(TEXT_PREVIEW_BYTES),
        }));
      }
      if (detail.note) textNotices.push(detail.note);
      detailBody = h('div', { className: 'dshpx-detail-body dshpx-scroll', ref: attachDetailScroll },
        textNotices.length ? h(Notice, { tone: 'warning', items: textNotices }) : null,
        detailBody);
    } else {
      detailBody = h('div', { className: 'dshpx-detail-body dshpx-scroll', ref: attachDetailScroll }, detailBody);
    }
  }

  return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'archive' },
    toolbar,
    notices.length ? h(Notice, { tone: 'warning', items: notices }) : null,
    h('div', { className: 'dshpx-split' }, list, h('div', { className: 'dshpx-detail' }, detailHeader, detailBody)));
}

// ---------------------------------------------------------------------------
// 字幕（SRT / VTT / ASS / SSA）
// ---------------------------------------------------------------------------

/** 'HH:MM:SS,mmm' | 'MM:SS.mmm' | 'H:MM:SS.cc' → 毫秒。 */
function parseClockToMs(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const hours = match[1] !== undefined ? parseInt(match[1], 10) : 0;
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  let millis = 0;
  if (match[4] !== undefined) millis = Math.round(parseFloat('0.' + match[4]) * 1000);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** 去字幕标记：HTML 标签、ASS 覆盖标签、ASS 换行、常见实体。 */
function cleanCueText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** SRT / WebVTT 共用块解析（两者时间轴与块结构足够接近；VTT header/NOTE 会跳过）。 */
function parseSrtVttCues(text) {
  const cues = [];
  const warnings = [];
  const blocks = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    if (/^\s*WEBVTT/i.test(block)) continue;
    if (/^\s*(NOTE|STYLE|REGION)\b/i.test(block)) continue;
    const lines = block.split('\n');
    let timeIndex = -1;
    for (let i = 0; i < lines.length && i < 3; i++) {
      if (lines[i].indexOf('-->') >= 0) {
        timeIndex = i;
        break;
      }
    }
    if (timeIndex < 0) {
      warnings.push('block');
      continue;
    }
    const halves = lines[timeIndex].split('-->');
    const start = parseClockToMs((halves[0] || '').trim());
    const endToken = (halves[1] || '').trim().split(/\s+/)[0];
    const end = parseClockToMs(endToken);
    if (start === null || end === null) {
      warnings.push('time');
      continue;
    }
    const body = lines.slice(timeIndex + 1).join('\n');
    cues.push({ start, end, text: cleanCueText(body), style: '' });
  }
  return { cues, warnings };
}

/** 按前 n-1 个逗号分割，最后一段保留剩余内容（ASS 的 Text 字段可含逗号）。 */
function splitLimited(value, count) {
  const parts = [];
  let rest = String(value == null ? '' : value);
  for (let i = 0; i < count - 1; i++) {
    const comma = rest.indexOf(',');
    if (comma < 0) {
      parts.push(rest);
      return parts;
    }
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return parts;
}

/** ASS / SSA 的 [Events] 解析。 */
function parseAssCues(text) {
  const cues = [];
  const warnings = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let section = '';
  let formatFields = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.charAt(0) === '[' && line.charAt(line.length - 1) === ']') {
      section = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    if (section !== 'events') continue;
    if (/^format\s*:/i.test(line)) {
      formatFields = line.slice(line.indexOf(':') + 1).split(',').map((part) => part.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const value = line.slice(line.indexOf(':') + 1).trim();
    const fields = formatFields || [
      'layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text',
    ];
    const parts = splitLimited(value, fields.length);
    const readField = (name) => {
      const index = fields.indexOf(name);
      return index >= 0 && index < parts.length ? parts[index] : null;
    };
    const start = parseClockToMs(readField('start'));
    const end = parseClockToMs(readField('end'));
    if (start === null || end === null) {
      warnings.push('time');
      continue;
    }
    cues.push({
      start,
      end,
      text: cleanCueText(readField('text') || ''),
      style: readField('style') || '',
    });
  }
  return { cues, warnings };
}

function detectSubtitleFormat(text, ext) {
  const head = String(text || '').slice(0, 8192);
  if (/^\s*WEBVTT/i.test(head)) return 'vtt';
  if (/\[Script Info\]/i.test(head)) {
    if (/ScriptType\s*:\s*v4\.00\+/i.test(head)) return 'ass';
    return ext === 'ass' ? 'ass' : 'ssa';
  }
  if (/\[Events\]/i.test(head)) return 'ass';
  const normalized = String(ext || '').toLowerCase();
  if (normalized === 'ass' || normalized === 'ssa') return normalized;
  if (/-->/.test(head)) return normalized === 'vtt' ? 'vtt' : 'srt';
  return SUBTITLE_EXTENSIONS.indexOf(normalized) >= 0 ? normalized : 'srt';
}

function parseSubtitleText(text, format) {
  if (format === 'ass' || format === 'ssa') return parseAssCues(text);
  return parseSrtVttCues(text); // SRT 与 VTT 共用
}

export function SubtitlePreviewBody(props) {
  usePreviewStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);

  const [state, setState] = react.useState({ status: data ? 'loading' : 'empty' });
  const [viewMode, setViewMode] = react.useState('cues');
  const [, attachScroll] = useScrollport(props);

  react.useEffect(() => {
    if (!data) {
      setState({ status: 'empty' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const limit = Math.min(MAX_SUBTITLE_BYTES, data.byteLength);
        const slice = data.subarray(0, limit);
        const decoded = decodeTextBytes(slice, { maxBytes: MAX_SUBTITLE_BYTES });
        if (cancelled) return;
        const text = decoded && typeof decoded.text === 'string' ? decoded.text : utf8OrLatin1(slice);
        const format = detectSubtitleFormat(text, extensionOf(fileName));
        const parsed = parseSubtitleText(text, format);
        const allCues = parsed.cues || [];
        const totalCues = allCues.length;
        const cues = totalCues > MAX_SUBTITLE_CUES ? allCues.slice(0, MAX_SUBTITLE_CUES) : allCues;
        setState({
          status: 'ready',
          format,
          encoding: decoded ? decoded.encoding : 'unknown',
          text,
          cues,
          totalCues,
          truncated: data.byteLength > limit,
          warnings: parsed.warnings || [],
        });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', error: messageOf(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, fileName]);

  const duration = react.useMemo(() => {
    if (state.status !== 'ready' || !state.cues || !state.cues.length) return null;
    let end = 0;
    for (const cue of state.cues) {
      if (cue.end > end) end = cue.end;
    }
    return end;
  }, [state]);

  const ready = state.status === 'ready';
  const toolbar = h('div', { className: 'dshpx-toolbar' },
    h('div', { className: 'dshpx-toolbar-group' },
      ready ? h(Badge, { tone: 'accent' }, String(state.format || '').toUpperCase()) : null,
      ready ? h(Stat, { label: tr(t, 'subtitle.cues', '字幕条数'), value: state.totalCues }) : null,
      ready ? h(Badge, null, tr(t, 'subtitle.encoding', '编码') + ' ' + state.encoding) : null,
      duration != null
        ? h(Stat, { label: tr(t, 'subtitle.duration', '总时长'), value: formatClock(duration, false) })
        : null,
      h(Stat, { value: fileName, title: fileName })),
    h('div', { className: 'dshpx-toolbar-group dshpx-toolbar-right' },
      h(ActionButton, {
        active: viewMode === 'cues',
        disabled: !ready,
        onClick: () => setViewMode('cues'),
      }, tr(t, 'subtitle.cueList', '字幕列表')),
      h(ActionButton, {
        active: viewMode === 'raw',
        disabled: !ready,
        onClick: () => setViewMode('raw'),
      }, tr(t, 'subtitle.raw', '原始文本'))));

  if (!data || state.status === 'empty') {
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'subtitle' },
      toolbar,
      h(StatePanel, { tone: 'error', title: tr(t, 'subtitle.noData', '没有收到字幕文件内容'), detail: fileName }));
  }

  if (state.status === 'loading') {
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'subtitle' },
      toolbar,
      h(StatePanel, {
        tone: 'loading',
        title: tr(t, 'subtitle.loading', '正在解析字幕…'),
        detail: fileName + ' · ' + bytesText(data.byteLength),
      }));
  }

  if (state.status === 'error') {
    return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'subtitle' },
      toolbar,
      h(StatePanel, {
        tone: 'error',
        title: tr(t, 'subtitle.failed', '字幕解析失败'),
        detail: fileName + '\n' + state.error,
      }));
  }

  const notices = [];
  if (state.truncated) {
    notices.push(tr(t, 'subtitle.truncated', '文件较大，仅解析了前 {bytes}', { bytes: bytesText(MAX_SUBTITLE_BYTES) }));
  }
  if (state.totalCues > state.cues.length) {
    notices.push(tr(t, 'subtitle.tooManyCues', '字幕条数过多，仅显示前 {n} 条', { n: state.cues.length }));
  }
  if (state.warnings && state.warnings.length) {
    notices.push(tr(t, 'subtitle.invalid', '解析时有 {n} 个块无法识别，已跳过', { n: state.warnings.length }));
  }

  let body;
  if (viewMode === 'raw') {
    body = h('pre', { className: 'dshpx-raw-pre dshpx-scroll', ref: attachScroll }, state.text || '');
  } else if (!state.cues.length) {
    body = h(StatePanel, {
      tone: 'info',
      title: tr(t, 'subtitle.empty', '未解析到字幕条目'),
      detail: tr(t, 'subtitle.emptyHint', '文件可能不是 SRT / VTT / ASS / SSA 字幕。') + '\n' + fileName,
    });
  } else {
    body = h('div', { className: 'dshpx-cues dshpx-scroll', ref: attachScroll, role: 'list', 'aria-label': fileName },
      state.cues.map((cue, index) =>
        h('div', { key: index, className: 'dshpx-cue', role: 'listitem' },
          h('span', { className: 'dshpx-cue-index', 'aria-hidden': 'true' }, index + 1),
          h('span', { className: 'dshpx-cue-time' }, formatClock(cue.start) + ' → ' + formatClock(cue.end)),
          h('span', { className: 'dshpx-cue-body' }, cue.text || tr(t, 'subtitle.noCues', '（没有可显示的字幕）')))));
  }

  return h('div', { className: 'dshpx-root', 'data-dshpx-body': 'subtitle' },
    toolbar,
    notices.length ? h(Notice, { tone: 'warning', items: notices }) : null,
    body);
}

// ---------------------------------------------------------------------------
// 导出映射：client.js 用 previewBodies[definition.id] 做正文 slot 注册
// ---------------------------------------------------------------------------

export const previewBodies = {
  [PREVIEW_IDS.model]: ModelPreviewBody,
  [PREVIEW_IDS.archive]: ArchivePreviewBody,
  [PREVIEW_IDS.media]: MediaPreviewBody,
  [PREVIEW_IDS.font]: FontPreviewBody,
  [PREVIEW_IDS.subtitle]: SubtitlePreviewBody,
};

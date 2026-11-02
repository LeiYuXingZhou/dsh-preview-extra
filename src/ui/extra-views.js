// extra-views.js — TOML / Intel HEX / JCAMP-DX / VCD / KiCad / DFU 的预览正文。
// 和 views.js 一样：具名导出、无 JSX、无 default export；react 由 bundle factory 注入。

import { parseToml } from '../formats/toml.js';
import { formatHexDump, parseIntelHex } from '../formats/ihex.js';
import { parseJcamp } from '../formats/jcamp.js';
import { parseVcd } from '../formats/vcd.js';
import { parseKicad } from '../formats/kicad.js';
import { parseDfu } from '../formats/dfu.js';
import { decodeUtf8 } from '../formats/text.js';

const h = react.createElement;

export const EXTRA_PREVIEW_IDS = Object.freeze({
  toml: 'dsh-preview-extra/toml',
  ihex: 'dsh-preview-extra/ihex',
  jcamp: 'dsh-preview-extra/jcamp',
  vcd: 'dsh-preview-extra/vcd',
  kicad: 'dsh-preview-extra/kicad',
  dfu: 'dsh-preview-extra/dfu',
});

export const extraLocales = {
  zh: {
    'title.toml': 'TOML',
    'title.ihex': 'Intel HEX',
    'title.jcamp': 'JCAMP-DX',
    'title.vcd': 'VCD 波形',
    'title.kicad': 'KiCad',
    'title.dfu': 'DFU',
    'extra.failed': '无法解析',
    'extra.empty': '文件是空的',
    'extra.loading': '正在解析…',
    'toml.keys': '键',
    'toml.tables': '表',
    'toml.arrays': '表数组',
    'toml.empty': '没有解析到键',
    'toml.root': '根表',
    'toml.type': '类型',
    'toml.value': '值',
    'toml.line': '行',
    'ihex.records': '记录',
    'ihex.bytes': '数据',
    'ihex.span': '地址范围',
    'ihex.entry': '入口',
    'ihex.none': '无',
    'ihex.address': '地址',
    'ihex.length': '长度',
    'ihex.errors': '{n} 条记录有错误',
    'jcamp.points': '数据点',
    'jcamp.range': '范围',
    'jcamp.empty': '没有可绘制的谱图数据',
    'jcamp.downsampled': '点数较多，图上做了保峰抽样（{shown} / {total}）',
    'vcd.signals': '信号',
    'vcd.end': '结束时间',
    'vcd.timescale': '时间刻度',
    'vcd.more': '只画出前 {n} 条信号',
    'vcd.empty': '没有信号跳变',
    'kicad.wires': '导线',
    'kicad.symbols': '符号',
    'kicad.tracks': '走线',
    'kicad.vias': '过孔',
    'kicad.pads': '焊盘',
    'kicad.footprints': '封装',
    'kicad.hint': '滚轮缩放 · 拖拽平移 · 双击复位',
    'kicad.sch': '原理图',
    'kicad.pcb': '电路板',
    'dfu.vendor': '厂商',
    'dfu.product': '产品',
    'dfu.bcd': 'DFU 版本',
    'dfu.payload': '载荷',
    'dfu.crcOk': 'CRC 通过',
    'dfu.crcBad': 'CRC 不匹配',
    'dfu.address': '地址',
    'dfu.size': '大小',
    'dfu.alt': '备用设置',
    'dfu.target': '目标',
    'dfu.plain': '单镜像',
  },
  en: {
    'title.toml': 'TOML',
    'title.ihex': 'Intel HEX',
    'title.jcamp': 'JCAMP-DX',
    'title.vcd': 'VCD waveform',
    'title.kicad': 'KiCad',
    'title.dfu': 'DFU',
    'extra.failed': 'Could not parse',
    'extra.empty': 'The file is empty',
    'extra.loading': 'Parsing…',
    'toml.keys': 'Keys',
    'toml.tables': 'Tables',
    'toml.arrays': 'Table arrays',
    'toml.empty': 'No keys found',
    'toml.root': 'Root',
    'toml.type': 'Type',
    'toml.value': 'Value',
    'toml.line': 'Line',
    'ihex.records': 'Records',
    'ihex.bytes': 'Data',
    'ihex.span': 'Address span',
    'ihex.entry': 'Entry',
    'ihex.none': 'none',
    'ihex.address': 'Address',
    'ihex.length': 'Length',
    'ihex.errors': '{n} records have errors',
    'jcamp.points': 'Points',
    'jcamp.range': 'Range',
    'jcamp.empty': 'No spectrum samples to plot',
    'jcamp.downsampled': 'Downsampled for display, keeping peaks ({shown} / {total})',
    'vcd.signals': 'Signals',
    'vcd.end': 'End',
    'vcd.timescale': 'Timescale',
    'vcd.more': 'Only the first {n} signals are drawn',
    'vcd.empty': 'No value changes',
    'kicad.wires': 'Wires',
    'kicad.symbols': 'Symbols',
    'kicad.tracks': 'Tracks',
    'kicad.vias': 'Vias',
    'kicad.pads': 'Pads',
    'kicad.footprints': 'Footprints',
    'kicad.hint': 'Scroll to zoom · Drag to pan · Double-click to reset',
    'kicad.sch': 'Schematic',
    'kicad.pcb': 'Board',
    'dfu.vendor': 'Vendor',
    'dfu.product': 'Product',
    'dfu.bcd': 'DFU version',
    'dfu.payload': 'Payload',
    'dfu.crcOk': 'CRC ok',
    'dfu.crcBad': 'CRC mismatch',
    'dfu.address': 'Address',
    'dfu.size': 'Size',
    'dfu.alt': 'Alt',
    'dfu.target': 'Target',
    'dfu.plain': 'Single image',
  },
};

export const extraDefinitions = [
  { id: EXTRA_PREVIEW_IDS.toml, titleKey: 'title.toml', extensions: ['toml'], loading: 'bytes-complete', wrap: false },
  { id: EXTRA_PREVIEW_IDS.ihex, titleKey: 'title.ihex', extensions: ['hex'], loading: 'bytes-complete', wrap: false },
  { id: EXTRA_PREVIEW_IDS.jcamp, titleKey: 'title.jcamp', extensions: ['jdx', 'dx'], loading: 'bytes-complete', wrap: false },
  { id: EXTRA_PREVIEW_IDS.vcd, titleKey: 'title.vcd', extensions: ['vcd'], loading: 'bytes-complete', wrap: false },
  {
    id: EXTRA_PREVIEW_IDS.kicad,
    titleKey: 'title.kicad',
    extensions: ['kicad_sch', 'kicad_pcb'],
    loading: 'bytes-complete',
    wrap: false,
  },
  {
    id: EXTRA_PREVIEW_IDS.dfu,
    titleKey: 'title.dfu',
    extensions: ['dfu'],
    binaryExtensions: ['dfu'],
    loading: 'bytes-complete',
    wrap: false,
  },
];

export const extraCss = `
.dshpx-doc { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 12px 18px; }
.dshpx-section { margin: 0 0 14px; }
.dshpx-section-title {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 650;
  color: color-mix(in srgb, currentColor 68%, transparent);
}
.dshpx-grid { width: 100%; border-collapse: collapse; }
.dshpx-grid th, .dshpx-grid td {
  text-align: left;
  padding: 3px 10px 3px 0;
  border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent);
  vertical-align: top;
}
.dshpx-grid th {
  font-size: 10.5px;
  font-weight: 600;
  color: color-mix(in srgb, currentColor 55%, transparent);
}
.dshpx-cell-key { font-weight: 600; white-space: nowrap; }
.dshpx-cell-type { color: color-mix(in srgb, currentColor 50%, transparent); white-space: nowrap; }
.dshpx-cell-value { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
.dshpx-plot { flex: 1 1 auto; width: 100%; min-height: 0; display: block; touch-action: none; }
.dshpx-hex {
  margin: 4px 0 0;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre;
}
`;

let bundledCss = extraCss;

/** views.js 在拼好完整样式后调用，让正文在宿主没注入样式时也能补上。 */
export function bindPreviewCss(css) {
  if (typeof css === 'string' && css) bundledCss = css;
}

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
    value = (extraLocales.zh && extraLocales.zh[key]) || fallback || key;
  }
  if (!params || typeof value !== 'string') return value;
  return value.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
}

function bytesOf(content) {
  if (!content || content.data == null) return null;
  const data = content.data;
  if (data instanceof Uint8Array) return data;
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function useFileName(props) {
  const hook = props && props.useTabInfo;
  let title = '';
  if (typeof hook === 'function') {
    try {
      const info = hook();
      if (info && info.tab && typeof info.tab.title === 'string') title = info.tab.title;
    } catch (err) {
      title = '';
    }
  }
  if (title) return title;
  const address = props && typeof props.resourceAddress === 'string' ? props.resourceAddress : '';
  if (!address) return 'file';
  const clean = address.split(/[?#]/)[0];
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return clean.slice(slash + 1) || 'file';
}

function useExtraStyles() {
  react.useEffect(() => {
    if (typeof document === 'undefined' || !document.head || typeof document.getElementById !== 'function') return undefined;
    if (document.getElementById('dshpx-preview-extra-styles')) return undefined;
    if (typeof document.querySelector === 'function' && document.querySelector('style[data-dsh-preview-extra]')) return undefined;
    const style = document.createElement('style');
    style.id = 'dshpx-preview-extra-styles';
    style.setAttribute('data-dsh-preview-extra', '');
    style.textContent = bundledCss;
    document.head.appendChild(style);
    return undefined;
  }, []);
}

function useParsed(data, parse) {
  const [state, setState] = react.useState({ phase: 'loading', doc: null, error: '' });
  react.useEffect(() => {
    if (!data) {
      setState({ phase: 'error', doc: null, error: '' });
      return undefined;
    }
    let live = true;
    setState({ phase: 'loading', doc: null, error: '' });
    const timer = setTimeout(() => {
      if (!live) return;
      try {
        const doc = parse(data);
        if (!doc || doc.ok === false) {
          setState({ phase: 'error', doc: null, error: (doc && doc.error) || '' });
        } else {
          setState({ phase: 'ready', doc, error: '' });
        }
      } catch (err) {
        setState({ phase: 'error', doc: null, error: err && err.message ? err.message : String(err) });
      }
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [data]);
  return state;
}

function Badge(props) {
  return h('span', { className: 'dshpx-badge', 'data-tone': props.tone || 'accent' }, props.children);
}

function Stat(props) {
  return h('span', { className: 'dshpx-stat dshpx-mono' },
    props.label ? h('span', null, props.label) : null,
    h('b', null, props.value));
}

function Notice(props) {
  const items = (Array.isArray(props.items) ? props.items : [props.items]).filter(Boolean);
  if (!items.length) return null;
  return h('div', { className: 'dshpx-notice', 'data-tone': props.tone || 'note', role: 'status' },
    h('span', { className: 'dshpx-notice-icon', 'aria-hidden': 'true' }, props.tone === 'warning' ? '!' : 'i'),
    h('div', { className: 'dshpx-notice-body' },
      items.map((item, index) => h('div', { key: index, className: 'dshpx-notice-line' }, item))));
}

function StatePanel(props) {
  const tone = props.tone || 'info';
  const icon = tone === 'loading'
    ? h('div', { className: 'dshpx-spinner', 'aria-hidden': 'true' })
    : h('div', { className: 'dshpx-state-badge', 'aria-hidden': 'true' }, tone === 'error' ? '!' : 'i');
  return h('div', { className: 'dshpx-state', 'data-tone': tone },
    icon,
    props.title ? h('div', { className: 'dshpx-state-title' }, props.title) : null,
    props.detail ? h('div', { className: 'dshpx-state-detail' }, props.detail) : null);
}

function Frame(props) {
  return h('div', { className: 'dshpx-root', 'data-dshpx-body': props.kind },
    h('div', { className: 'dshpx-toolbar' },
      h('div', { className: 'dshpx-toolbar-group' }, props.toolbar || null),
      props.toolbarRight ? h('div', { className: 'dshpx-toolbar-group dshpx-toolbar-right' }, props.toolbarRight) : null),
    props.notices && props.notices.length ? h(Notice, { tone: props.noticeTone || 'warning', items: props.notices }) : null,
    props.children);
}

function bytesText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function hexAddr(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function Table(props) {
  return h('table', { className: 'dshpx-grid' },
    props.head ? h('thead', null, h('tr', null, props.head.map((label, index) => h('th', { key: index }, label)))) : null,
    h('tbody', null, props.rows));
}

export function TomlPreviewBody(props) {
  useExtraStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);
  const state = useParsed(data, (bytes) => parseToml(decodeUtf8(bytes)));
  if (!data || state.phase === 'error') {
    return h(Frame, { kind: 'toml', toolbar: h(Badge, null, 'TOML') },
      h(StatePanel, {
        tone: 'error',
        title: tr(t, 'extra.failed', '无法解析'),
        detail: `${fileName}\n${state.error || tr(t, 'extra.empty', '文件是空的')}`,
      }));
  }
  if (state.phase !== 'ready') {
    return h(Frame, { kind: 'toml', toolbar: h(Badge, null, 'TOML') },
      h(StatePanel, { tone: 'loading', title: tr(t, 'extra.loading', '正在解析…'), detail: fileName }));
  }
  const doc = state.doc;
  const sections = doc.sections.length
    ? doc.sections
    : [];
  return h(Frame, {
    kind: 'toml',
    notices: doc.warnings,
    toolbar: [
      h(Badge, { key: 'b' }, 'TOML'),
      h(Stat, { key: 'k', label: tr(t, 'toml.keys', '键'), value: doc.counts.keys }),
      h(Stat, { key: 'tb', label: tr(t, 'toml.tables', '表'), value: doc.counts.tables }),
      h(Stat, { key: 'a', label: tr(t, 'toml.arrays', '表数组'), value: doc.counts.arrays }),
    ],
  }, sections.length
    ? h('div', { className: 'dshpx-doc dshpx-scroll' }, sections.map((section) =>
      h('section', { key: section.header || 'root', className: 'dshpx-section' },
        h('h3', { className: 'dshpx-section-title' }, section.header || tr(t, 'toml.root', '根表')),
        section.rows.length
          ? h(Table, {
            head: [tr(t, 'common.name', '名称'), tr(t, 'toml.type', '类型'), tr(t, 'toml.value', '值'), tr(t, 'toml.line', '行')],
            rows: section.rows.map((item, index) => h('tr', { key: index },
              h('td', { className: 'dshpx-cell-key' }, item.key),
              h('td', { className: 'dshpx-cell-type' }, item.type),
              h('td', { className: 'dshpx-cell-value' }, item.text),
              h('td', { className: 'dshpx-cell-type' }, item.line))),
          })
          : null)))
    : h(StatePanel, { tone: 'info', title: tr(t, 'toml.empty', '没有解析到键'), detail: fileName }));
}

export function HexPreviewBody(props) {
  useExtraStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);
  const state = useParsed(data, parseIntelHex);
  if (!data || state.phase === 'error') {
    return h(Frame, { kind: 'ihex', toolbar: h(Badge, null, 'HEX') },
      h(StatePanel, { tone: 'error', title: tr(t, 'extra.failed', '无法解析'), detail: `${fileName}\n${state.error || ''}` }));
  }
  if (state.phase !== 'ready') {
    return h(Frame, { kind: 'ihex', toolbar: h(Badge, null, 'HEX') },
      h(StatePanel, { tone: 'loading', title: tr(t, 'extra.loading', '正在解析…'), detail: fileName }));
  }
  const doc = state.doc;
  const notices = doc.warnings.slice();
  if (doc.errors.length) notices.unshift(tr(t, 'ihex.errors', '{n} 条记录有错误', { n: doc.errors.length }));
  const entry = doc.entry ? `${hexAddr(doc.entry.address)} (${doc.entry.kind})` : tr(t, 'ihex.none', '无');
  const span = doc.start == null ? '—' : `${hexAddr(doc.start)} – ${hexAddr((doc.end || 1) - 1)}`;
  return h(Frame, {
    kind: 'ihex',
    notices,
    toolbar: [
      h(Badge, { key: 'b' }, 'HEX'),
      h(Stat, { key: 'r', label: tr(t, 'ihex.records', '记录'), value: doc.records }),
      h(Stat, { key: 'd', label: tr(t, 'ihex.bytes', '数据'), value: bytesText(doc.dataBytes) }),
      h(Stat, { key: 's', label: tr(t, 'ihex.span', '地址范围'), value: span }),
      h(Stat, { key: 'e', label: tr(t, 'ihex.entry', '入口'), value: entry }),
    ],
  }, h('div', { className: 'dshpx-doc dshpx-scroll' },
    doc.ranges.map((range) => h('section', { key: range.address, className: 'dshpx-section' },
      h('h3', { className: 'dshpx-section-title' },
        `${hexAddr(range.address)} · ${bytesText(range.length)}`),
      h('pre', { className: 'dshpx-hex' }, formatHexDump(range.data, range.address, 160).join('\n')))),
    doc.errors.length
      ? h('section', { className: 'dshpx-section' },
        h('h3', { className: 'dshpx-section-title' }, tr(t, 'common.error', '错误')),
        h('pre', { className: 'dshpx-hex' }, doc.errors.slice(0, 12).map((item) => `${item.line}: ${item.message}`).join('\n')))
      : null));
}

export function JcampPreviewBody(props) {
  useExtraStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);
  const state = useParsed(data, parseJcamp);
  const canvasRef = react.useRef(null);
  react.useEffect(() => {
    if (!state.doc || state.phase !== 'ready') return undefined;
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.getContext !== 'function') return undefined;
    const draw = () => paintSpectrum(canvas, state.doc);
    draw();
    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(draw);
      observer.observe(canvas);
    }
    return () => { if (observer) observer.disconnect(); };
  }, [state.doc, state.phase]);
  if (!data || state.phase === 'error') {
    return h(Frame, { kind: 'jcamp', toolbar: h(Badge, null, 'JCAMP') },
      h(StatePanel, { tone: 'error', title: tr(t, 'extra.failed', '无法解析'), detail: `${fileName}\n${state.error || ''}` }));
  }
  if (state.phase !== 'ready') {
    return h(Frame, { kind: 'jcamp', toolbar: h(Badge, null, 'JCAMP') },
      h(StatePanel, { tone: 'loading', title: tr(t, 'extra.loading', '正在解析…'), detail: fileName }));
  }
  const doc = state.doc;
  const notices = doc.warnings.slice();
  if (doc.downsampled) {
    notices.unshift(tr(t, 'jcamp.downsampled', '点数较多，图上做了保峰抽样', { shown: doc.plotted, total: doc.total }));
  }
  const range = doc.total
    ? `${formatNum(doc.xMin)} … ${formatNum(doc.xMax)}`
    : '—';
  return h(Frame, {
    kind: 'jcamp',
    notices,
    noticeTone: 'note',
    toolbar: [
      h(Badge, { key: 'b' }, doc.dataType ? doc.dataType.split(/\s+/)[0] : 'JCAMP'),
      h(Stat, { key: 'p', label: tr(t, 'jcamp.points', '数据点'), value: doc.total }),
      h(Stat, { key: 'x', label: doc.xUnits || tr(t, 'jcamp.range', '范围'), value: range }),
      doc.yUnits ? h(Stat, { key: 'y', label: 'Y', value: doc.yUnits }) : null,
      doc.title ? h(Stat, { key: 't', label: tr(t, 'common.name', '名称'), value: doc.title }) : null,
    ],
  }, doc.total
    ? h('canvas', { ref: canvasRef, className: 'dshpx-plot', 'aria-label': fileName })
    : h(StatePanel, { tone: 'info', title: tr(t, 'jcamp.empty', '没有可绘制的谱图数据'), detail: fileName }));
}

export function VcdPreviewBody(props) {
  useExtraStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);
  const state = useParsed(data, parseVcd);
  const canvasRef = react.useRef(null);
  react.useEffect(() => {
    if (!state.doc || state.phase !== 'ready') return undefined;
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.getContext !== 'function') return undefined;
    const draw = () => paintVcd(canvas, state.doc);
    draw();
    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(draw);
      observer.observe(canvas);
    }
    return () => { if (observer) observer.disconnect(); };
  }, [state.doc, state.phase]);
  if (!data || state.phase === 'error') {
    return h(Frame, { kind: 'vcd', toolbar: h(Badge, null, 'VCD') },
      h(StatePanel, { tone: 'error', title: tr(t, 'extra.failed', '无法解析'), detail: `${fileName}\n${state.error || ''}` }));
  }
  if (state.phase !== 'ready') {
    return h(Frame, { kind: 'vcd', toolbar: h(Badge, null, 'VCD') },
      h(StatePanel, { tone: 'loading', title: tr(t, 'extra.loading', '正在解析…'), detail: fileName }));
  }
  const doc = state.doc;
  const notices = doc.warnings.slice();
  const drawn = Math.min(doc.signals.length, 40);
  if (doc.signals.length > drawn) notices.push(tr(t, 'vcd.more', '只画出前 {n} 条信号', { n: drawn }));
  const endLabel = doc.timescale ? `${doc.endTime} × ${doc.timescale.text}` : String(doc.endTime);
  return h(Frame, {
    kind: 'vcd',
    notices,
    toolbar: [
      h(Badge, { key: 'b' }, 'VCD'),
      h(Stat, { key: 's', label: tr(t, 'vcd.signals', '信号'), value: doc.signals.length }),
      h(Stat, { key: 'e', label: tr(t, 'vcd.end', '结束时间'), value: endLabel }),
      doc.timescale ? h(Stat, { key: 'ts', label: tr(t, 'vcd.timescale', '时间刻度'), value: doc.timescale.text }) : null,
    ],
  }, h('div', { className: 'dshpx-doc dshpx-scroll' },
    h('canvas', {
      ref: canvasRef,
      className: 'dshpx-plot',
      'aria-label': fileName,
      style: { height: `${Math.max(160, 28 + drawn * 26)}px`, minHeight: '160px' },
    })));
}

export function KicadPreviewBody(props) {
  useExtraStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);
  const state = useParsed(data, parseKicad);
  const canvasRef = react.useRef(null);
  react.useEffect(() => {
    if (!state.doc || state.phase !== 'ready') return undefined;
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.getContext !== 'function') return undefined;
    return mountKicad(canvas, state.doc);
  }, [state.doc, state.phase]);
  if (!data || state.phase === 'error') {
    return h(Frame, { kind: 'kicad', toolbar: h(Badge, null, 'KiCad') },
      h(StatePanel, { tone: 'error', title: tr(t, 'extra.failed', '无法解析'), detail: `${fileName}\n${state.error || ''}` }));
  }
  if (state.phase !== 'ready') {
    return h(Frame, { kind: 'kicad', toolbar: h(Badge, null, 'KiCad') },
      h(StatePanel, { tone: 'loading', title: tr(t, 'extra.loading', '正在解析…'), detail: fileName }));
  }
  const doc = state.doc;
  const stats = doc.stats || {};
  const kindLabel = doc.kind === 'pcb' ? tr(t, 'kicad.pcb', '电路板') : tr(t, 'kicad.sch', '原理图');
  const toolbar = [h(Badge, { key: 'b' }, kindLabel)];
  if (doc.kind === 'sch') {
    toolbar.push(h(Stat, { key: 'w', label: tr(t, 'kicad.wires', '导线'), value: stats.wires || 0 }));
    toolbar.push(h(Stat, { key: 's', label: tr(t, 'kicad.symbols', '符号'), value: stats.symbols || 0 }));
  } else {
    toolbar.push(h(Stat, { key: 't', label: tr(t, 'kicad.tracks', '走线'), value: stats.tracks || 0 }));
    toolbar.push(h(Stat, { key: 'v', label: tr(t, 'kicad.vias', '过孔'), value: stats.vias || 0 }));
    toolbar.push(h(Stat, { key: 'p', label: tr(t, 'kicad.pads', '焊盘'), value: stats.pads || 0 }));
    toolbar.push(h(Stat, { key: 'f', label: tr(t, 'kicad.footprints', '封装'), value: stats.footprints || 0 }));
  }
  return h(Frame, {
    kind: 'kicad',
    notices: doc.warnings,
    toolbar,
    toolbarRight: h('span', { className: 'dshpx-stat' }, tr(t, 'kicad.hint', '滚轮缩放 · 拖拽平移 · 双击复位')),
  }, h('canvas', { ref: canvasRef, className: 'dshpx-plot', 'aria-label': doc.title || fileName }));
}

export function DfuPreviewBody(props) {
  useExtraStyles();
  const t = props.t;
  const fileName = useFileName(props);
  const data = bytesOf(props.content);
  const state = useParsed(data, parseDfu);
  if (!data || state.phase === 'error') {
    return h(Frame, { kind: 'dfu', toolbar: h(Badge, null, 'DFU') },
      h(StatePanel, { tone: 'error', title: tr(t, 'extra.failed', '无法解析'), detail: `${fileName}\n${state.error || ''}` }));
  }
  if (state.phase !== 'ready') {
    return h(Frame, { kind: 'dfu', toolbar: h(Badge, null, 'DFU') },
      h(StatePanel, { tone: 'loading', title: tr(t, 'extra.loading', '正在解析…'), detail: fileName }));
  }
  const doc = state.doc;
  const rows = [];
  doc.targets.forEach((target, targetIndex) => {
    const label = target.name || (doc.dfuse ? `${tr(t, 'dfu.target', '目标')} ${targetIndex + 1}` : tr(t, 'dfu.plain', '单镜像'));
    target.elements.forEach((element, elementIndex) => {
      rows.push(h('tr', { key: `${targetIndex}-${elementIndex}` },
        h('td', null, label),
        h('td', { className: 'dshpx-cell-type' }, target.alt),
        h('td', { className: 'dshpx-cell-value' }, hexAddr(element.address)),
        h('td', { className: 'dshpx-cell-value' }, bytesText(element.size)),
        h('td', null, h('pre', { className: 'dshpx-hex' }, formatHexDump(element.preview, element.address, 32).join('\n')))));
    });
  });
  return h(Frame, {
    kind: 'dfu',
    notices: doc.warnings,
    noticeTone: doc.crcOk ? 'note' : 'warning',
    toolbar: [
      h(Badge, { key: 'b' }, doc.dfuse ? 'DfuSe' : 'DFU'),
      h(Stat, { key: 'v', label: tr(t, 'dfu.vendor', '厂商'), value: doc.vendor }),
      h(Stat, { key: 'p', label: tr(t, 'dfu.product', '产品'), value: doc.product }),
      h(Stat, { key: 'd', label: tr(t, 'dfu.bcd', 'DFU 版本'), value: doc.bcdDfu }),
      h(Stat, { key: 'n', label: tr(t, 'dfu.payload', '载荷'), value: bytesText(doc.payloadBytes) }),
      h(Stat, { key: 'c', label: 'CRC', value: doc.crcOk ? tr(t, 'dfu.crcOk', 'CRC 通过') : tr(t, 'dfu.crcBad', 'CRC 不匹配') }),
    ],
  }, h('div', { className: 'dshpx-doc dshpx-scroll' },
    h(Table, {
      head: [
        tr(t, 'dfu.target', '目标'),
        tr(t, 'dfu.alt', '备用设置'),
        tr(t, 'dfu.address', '地址'),
        tr(t, 'dfu.size', '大小'),
        tr(t, 'common.format', '格式'),
      ],
      rows,
    })));
}

export const extraBodies = {
  [EXTRA_PREVIEW_IDS.toml]: TomlPreviewBody,
  [EXTRA_PREVIEW_IDS.ihex]: HexPreviewBody,
  [EXTRA_PREVIEW_IDS.jcamp]: JcampPreviewBody,
  [EXTRA_PREVIEW_IDS.vcd]: VcdPreviewBody,
  [EXTRA_PREVIEW_IDS.kicad]: KicadPreviewBody,
  [EXTRA_PREVIEW_IDS.dfu]: DfuPreviewBody,
};

function formatNum(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000 || abs === 0) return String(Math.round(value));
  if (abs >= 1) return value.toFixed(2);
  return value.toExponential(2);
}

function themeColor(canvas) {
  try {
    if (typeof getComputedStyle === 'function') {
      const color = getComputedStyle(canvas).color;
      if (color) return color;
    }
  } catch (err) {
    // 无 DOM 样式时用浅色描边
  }
  return '#d5d8de';
}

function paintSpectrum(canvas, doc) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const width = Math.max(280, canvas.clientWidth || 640);
  const height = Math.max(180, canvas.clientHeight || 280);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const color = themeColor(canvas);
  const left = 52;
  const right = 12;
  const top = 16;
  const bottom = 28;
  const plotW = Math.max(10, width - left - right);
  const plotH = Math.max(10, height - top - bottom);
  const x0 = doc.xMin;
  const x1 = doc.xMax === doc.xMin ? doc.xMin + 1 : doc.xMax;
  const y0 = doc.yMin;
  const y1 = doc.yMax === doc.yMin ? doc.yMin + 1 : doc.yMax;
  const xOf = (value) => left + ((value - x0) / (x1 - x0)) * plotW;
  const yOf = (value) => top + (1 - (value - y0) / (y1 - y0)) * plotH;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const y = top + (plotH * i) / 4;
    ctx.moveTo(left, y);
    ctx.lineTo(left + plotW, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (let i = 0; i < doc.x.length; i++) {
    const x = xOf(doc.x[i]);
    const y = yOf(doc.y[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = color;
  ctx.fillText(formatNum(y1), 4, top + 10);
  ctx.fillText(formatNum(y0), 4, top + plotH);
  ctx.fillText(formatNum(x0), left, height - 8);
  const endLabel = formatNum(x1);
  ctx.fillText(endLabel, Math.max(left, left + plotW - endLabel.length * 7), height - 8);
  ctx.globalAlpha = 1;
}

function paintVcd(canvas, doc) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const width = Math.max(320, canvas.clientWidth || 720);
  const shown = doc.signals.slice(0, 40);
  const rowH = 26;
  const axisH = 22;
  const height = axisH + shown.length * rowH + 8;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const color = themeColor(canvas);
  const labelW = 148;
  const plotW = Math.max(20, width - labelW - 10);
  const end = Math.max(doc.endTime, 1);
  const xOf = (time) => labelW + (time / end) * plotW;
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.65;
  ctx.fillText(doc.timescale ? `0` : '0', labelW, 14);
  const endText = String(doc.endTime);
  ctx.fillText(endText, width - 10 - endText.length * 7, 14);
  ctx.globalAlpha = 1;
  shown.forEach((signal, index) => {
    const mid = axisH + index * rowH + rowH / 2;
    const name = signal.scope ? `${signal.scope}.${signal.name}` : signal.name;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = color;
    ctx.fillText(name.length > 22 ? `${name.slice(0, 21)}…` : name, 8, mid + 4);
    ctx.globalAlpha = 0.18;
    ctx.fillRect(labelW, mid + 8, plotW, 1);
    ctx.globalAlpha = 1;
    const changes = signal.changes;
    if (!changes.length) return;
    const level = (value) => {
      const flag = String(value).toLowerCase();
      if (flag === '1') return mid - 7;
      if (flag === '0') return mid + 7;
      return mid;
    };
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    let y = level(changes[0].v);
    ctx.moveTo(xOf(changes[0].t), y);
    for (let i = 0; i < changes.length; i++) {
      const next = changes[i + 1];
      const x = xOf(next ? next.t : end);
      ctx.lineTo(x, y);
      if (next) {
        y = level(next.v);
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    if (signal.width > 1) {
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.globalAlpha = 0.8;
      for (let i = 0; i < changes.length; i++) {
        const start = xOf(changes[i].t);
        const stop = xOf(changes[i + 1] ? changes[i + 1].t : end);
        if (stop - start < 28) continue;
        const raw = String(changes[i].v).replace(/^[brs]/i, '');
        ctx.fillText(raw.slice(0, 12), start + 3, mid - 8);
      }
      ctx.globalAlpha = 1;
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    }
  });
}

function mountKicad(canvas, doc) {
  const view = { zoom: 1, panX: 0, panY: 0 };
  let drag = null;
  const paint = () => paintKicad(canvas, doc, view);
  const onWheel = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const factor = event && event.deltaY > 0 ? 0.9 : 1.1;
    view.zoom = Math.min(48, Math.max(0.25, view.zoom * factor));
    paint();
  };
  const onDown = (event) => {
    drag = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY };
    if (typeof canvas.setPointerCapture === 'function' && event.pointerId != null) {
      try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
    }
  };
  const onMove = (event) => {
    if (!drag) return;
    view.panX = drag.panX + (event.clientX - drag.x);
    view.panY = drag.panY + (event.clientY - drag.y);
    paint();
  };
  const onUp = () => { drag = null; };
  const onDbl = () => {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    paint();
  };
  const offs = [];
  const listen = (type, fn, options) => {
    if (typeof canvas.addEventListener !== 'function') return;
    canvas.addEventListener(type, fn, options);
    offs.push(() => {
      if (typeof canvas.removeEventListener === 'function') canvas.removeEventListener(type, fn, options);
    });
  };
  listen('wheel', onWheel, { passive: false });
  listen('pointerdown', onDown);
  listen('pointermove', onMove);
  listen('pointerup', onUp);
  listen('pointercancel', onUp);
  listen('dblclick', onDbl);
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(paint);
    observer.observe(canvas);
  }
  paint();
  return () => {
    if (observer) observer.disconnect();
    for (const off of offs) off();
  };
}

function paintKicad(canvas, doc, view) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const width = Math.max(280, canvas.clientWidth || 640);
  const height = Math.max(200, canvas.clientHeight || 420);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const bounds = doc.bounds;
  const pad = 24;
  const worldW = Math.max(1e-6, bounds.maxX - bounds.minX);
  const worldH = Math.max(1e-6, bounds.maxY - bounds.minY);
  const fit = Math.min((width - pad * 2) / worldW, (height - pad * 2) / worldH) * view.zoom;
  const ox = (width - worldW * fit) / 2 + view.panX;
  const oy = (height - worldH * fit) / 2 + view.panY;
  const mapX = (x) => ox + (x - bounds.minX) * fit;
  const mapY = (y) => doc.yDown
    ? oy + (y - bounds.minY) * fit
    : oy + (bounds.maxY - y) * fit;
  const theme = themeColor(canvas);
  const colorOf = (value) => (value === 'theme' ? theme : value);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const buckets = new Map();
  for (const primitive of doc.primitives) {
    if (primitive.type !== 'line') continue;
    const widthPx = Math.max(1, (primitive.width || 0.15) * fit);
    const key = `${colorOf(primitive.color)}|${widthPx.toFixed(2)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { color: colorOf(primitive.color), width: widthPx, pts: [] };
      buckets.set(key, bucket);
    }
    bucket.pts.push(mapX(primitive.x1), mapY(primitive.y1), mapX(primitive.x2), mapY(primitive.y2));
  }
  for (const bucket of buckets.values()) {
    ctx.beginPath();
    ctx.strokeStyle = bucket.color;
    ctx.lineWidth = bucket.width;
    const pts = bucket.pts;
    for (let i = 0; i < pts.length; i += 4) {
      ctx.moveTo(pts[i], pts[i + 1]);
      ctx.lineTo(pts[i + 2], pts[i + 3]);
    }
    ctx.stroke();
  }
  for (const primitive of doc.primitives) {
    if (primitive.type === 'poly') {
      ctx.beginPath();
      const pts = primitive.points;
      for (let i = 0; i < pts.length; i += 2) {
        const x = mapX(pts[i]);
        const y = mapY(pts[i + 1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      if (primitive.fill) {
        ctx.fillStyle = colorOf(primitive.color);
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = colorOf(primitive.color);
        ctx.lineWidth = Math.max(1, (primitive.width || 0.15) * fit);
        ctx.stroke();
      }
    } else if (primitive.type === 'circle') {
      ctx.beginPath();
      ctx.arc(mapX(primitive.x), mapY(primitive.y), Math.max(0.8, primitive.r * fit), 0, Math.PI * 2);
      if (primitive.fill) {
        ctx.fillStyle = colorOf(primitive.color);
        ctx.fill();
      } else {
        ctx.strokeStyle = colorOf(primitive.color);
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
    }
  }
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = theme;
  for (const primitive of doc.primitives) {
    if (primitive.type !== 'text') continue;
    if ((primitive.size || 1) * fit < 7) continue;
    ctx.fillText(String(primitive.text), mapX(primitive.x) + 2, mapY(primitive.y) - 2);
  }
}

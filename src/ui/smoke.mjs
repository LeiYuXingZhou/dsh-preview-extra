// _smoke.mjs — 临时冒烟测试（不属于交付物，验证后删除）。
// 用假 React 运行时在 Node 里渲染 views.js 的各个 body，断言导出 / 文案 / 扩展名 / 主要交互状态。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// ---- 假 React 运行时 -------------------------------------------------------
let current = null;
const sameDeps = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};
class Runtime {
  constructor() {
    this.slots = [];
    this.index = 0;
    this.pending = [];
  }
  begin() {
    this.index = 0;
    this.pending = [];
  }
  useState(initial) {
    const i = this.index++;
    if (!(i in this.slots)) this.slots[i] = typeof initial === 'function' ? initial() : initial;
    const self = this;
    const set = (next) => {
      self.slots[i] = typeof next === 'function' ? next(self.slots[i]) : next;
    };
    return [this.slots[i], set];
  }
  useRef(initial) {
    const i = this.index++;
    if (!(i in this.slots)) this.slots[i] = { current: initial };
    return this.slots[i];
  }
  useMemo(fn, deps) {
    const i = this.index++;
    const prev = this.slots[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    const value = fn();
    this.slots[i] = { value, deps };
    return value;
  }
  useCallback(fn, deps) {
    return this.useMemo(() => fn, deps);
  }
  useEffect(fn, deps) {
    const i = this.index++;
    this.pending.push({ i, fn, deps });
  }
  commitEffects() {
    for (const effect of this.pending) {
      const key = 'effect:' + effect.i;
      const prev = this.slots[key];
      if (prev && sameDeps(prev.deps, effect.deps)) continue;
      if (prev && typeof prev.cleanup === 'function') prev.cleanup();
      const cleanup = effect.fn();
      this.slots[key] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
    }
  }
  cleanupAll() {
    for (const key of Object.keys(this.slots)) {
      if (!key.startsWith('effect:')) continue;
      const slot = this.slots[key];
      if (slot && typeof slot.cleanup === 'function') {
        try {
          slot.cleanup();
        } catch (err) {
          // ignore
        }
      }
    }
  }
}

const fakeReact = {
  createElement(type, props, ...children) {
    const next = Object.assign({}, props);
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    return { type, props: next, key: props && props.key };
  },
  useState: (...args) => current.useState(...args),
  useRef: (...args) => current.useRef(...args),
  useMemo: (...args) => current.useMemo(...args),
  useCallback: (...args) => current.useCallback(...args),
  useEffect: (...args) => current.useEffect(...args),
  Fragment: 'Fragment',
};
globalThis.react = fakeReact;
globalThis.jsxRuntime = { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: 'Fragment' };
globalThis.primitives = {};

const views = await import('./views.js');

// ---- 断言工具 --------------------------------------------------------------
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node.type) visit(node);
  walk(node.props && node.props.children, visit);
}
function findAll(tree, type) {
  const out = [];
  walk(tree, (el) => {
    if (el.type === type) out.push(el);
    else if (typeof el.type === 'function' && el.type.name === type) out.push(el);
  });
  return out;
}
function findAllByClass(tree, className) {
  const out = [];
  walk(tree, (el) => {
    const cls = el.props && el.props.className;
    if (typeof cls === 'string' && cls.split(/\s+/).indexOf(className) >= 0) out.push(el);
  });
  return out;
}
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') {
    // 共享展示组件都是无 hook 的纯函数组件，可以直接展开取文本。
    if (typeof node.type === 'function') {
      try {
        return textOf(node.type(node.props));
      } catch (err) {
        return '';
      }
    }
    return textOf(node.props && node.props.children);
  }
  return '';
}
async function mount(component, props) {
  const rt = new Runtime();
  let tree = null;
  const render = () => {
    current = rt;
    rt.begin();
    tree = component(props);
    rt.commitEffects();
    current = null;
  };
  render();
  return {
    rt,
    render,
    async settle(rounds = 12) {
      for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setTimeout(resolve, 12));
        render();
      }
    },
    unmount() {
      rt.cleanupAll();
    },
    get tree() {
      return tree;
    },
  };
}
const tabProps = (title) => ({ useTabInfo: () => ({ tab: { title, contentId: 'x', signal: undefined } }) });

// ---- 静态契约 --------------------------------------------------------------
for (const name of [
  'previewLocales',
  'previewDefinitions',
  'previewCss',
  'ModelPreviewBody',
  'ArchivePreviewBody',
  'MediaPreviewBody',
  'FontPreviewBody',
  'SubtitlePreviewBody',
  'previewBodies',
  'PREVIEW_IDS',
  'previewNamespace',
]) {
  assert.ok(name in views, 'missing export ' + name);
}
assert.equal(views.default, undefined, 'must not have default export');

const zh = views.previewLocales.zh;
const en = views.previewLocales.en;
const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
assert.deepEqual(zhKeys, enKeys, 'zh/en locale keys must match');
for (const key of zhKeys) assert.equal(typeof zh[key], 'string', 'zh text ' + key);

const source = [
  readFileSync(new URL('./views.js', import.meta.url), 'utf8'),
  readFileSync(new URL('./extra-views.js', import.meta.url), 'utf8'),
].join('\n');
const usedKeys = new Set();
for (const match of source.matchAll(/tr\((?:t|null)\s*,\s*'([A-Za-z0-9_.]+)'/g)) usedKeys.add(match[1]);
for (const key of usedKeys) {
  assert.ok(key in zh, 'tr key missing in zh: ' + key);
  assert.ok(key in en, 'tr key missing in en: ' + key);
}

const required = {
  model: ['stl', 'obj', 'ply'],
  archive: ['zip', 'jar', 'war', 'apk', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar'],
  media: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'mp4', 'webm', 'm4v', 'mov', 'mkv'],
  font: ['ttf', 'otf', 'woff', 'woff2'],
  subtitle: ['srt', 'vtt', 'ass', 'ssa'],
  toml: ['toml'],
  ihex: ['hex'],
  jcamp: ['jdx', 'dx'],
  vcd: ['vcd'],
  kicad: ['kicad_sch', 'kicad_pcb'],
  dfu: ['dfu'],
};
for (const [group, extensions] of Object.entries(required)) {
  const def = views.previewDefinitions.find((item) => item.id === views.PREVIEW_IDS[group]);
  assert.ok(def, 'missing definition ' + group);
  assert.equal(def.loading, 'bytes-complete');
  assert.equal(def.wrap, false);
  assert.ok(def.titleKey && typeof def.titleKey === 'string');
  for (const ext of extensions) assert.ok(def.extensions.indexOf(ext) >= 0, group + ' missing .' + ext);
  for (const ext of def.binaryExtensions || []) {
    assert.ok(def.extensions.indexOf(ext) >= 0, group + ' binaryExtensions subset: ' + ext);
  }
}
assert.deepEqual(Object.keys(views.previewBodies).sort(), views.previewDefinitions.map((d) => d.id).sort());

// ---- fixtures --------------------------------------------------------------
const { makeAsciiSTL } = await import('../model/tests/fixtures.js');
const { buildZip } = await import('../archive/tests/fixtures.mjs');

// ---- Model -----------------------------------------------------------------
{
  const data = makeAsciiSTL();
  const view = await mount(views.ModelPreviewBody, {
    content: { kind: 'bytes', data },
    ...tabProps('tetra.stl'),
    t: undefined,
    wrap: true,
  });
  await view.settle();
  assert.equal(findAll(view.tree, 'canvas').length, 1, 'model canvas');
  assert.ok(!findAll(view.tree, 'StatePanel').some((el) => el.props.tone === 'error'), 'model should not error');
  const text = textOf(view.tree);
  assert.ok(text.includes('三角形') || text.includes('Triangles'), 'model stats present');
  view.unmount();

  const bad = await mount(views.ModelPreviewBody, {
    content: { kind: 'bytes', data: new TextEncoder().encode('garbage-not-a-model') },
    ...tabProps('broken.stl'),
    t: undefined,
  });
  await bad.settle();
  const errorPanel = findAll(bad.tree, 'StatePanel').find((el) => el.props.tone === 'error');
  assert.ok(errorPanel, 'bad model shows error panel');
  bad.unmount();
}

// ---- Archive ---------------------------------------------------------------
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
{
  const zip = new Uint8Array(buildZip([
    { name: 'docs/hello.txt', data: 'hello archive\n第二行\n', method: 0 },
    { name: 'docs/pic.png', data: pngBytes, method: 8 },
    { name: 'bin/blob.bin', data: new Uint8Array([0, 1, 2, 0, 255, 254, 0]), method: 0 },
    { name: 'secret.txt', data: 'top secret', method: 0, encrypt: true },
  ]));
  const view = await mount(views.ArchivePreviewBody, {
    content: { kind: 'bytes', data: zip },
    ...tabProps('bundle.zip'),
    t: undefined,
  });
  await view.settle();

  let rowEls = [];
  walk(view.tree, (el) => {
    if (el.type && el.type.name === 'ArchiveEntryRow') rowEls.push(el);
  });
  assert.ok(rowEls.length >= 4, 'archive rows rendered, got ' + rowEls.length);

  const rowByName = (name) => rowEls.find((el) => el.props.node && el.props.node.name === name);
  const helloRow = rowByName('hello.txt');
  assert.ok(helloRow, 'hello row');
  helloRow.props.onActivate(helloRow.props.node);
  await view.settle();
  const pre = findAllByClass(view.tree, 'dshpx-pre')[0];
  assert.ok(pre, 'text preview pre');
  assert.ok(textOf(pre).includes('hello archive'), 'text preview content');
  const gutter = findAllByClass(view.tree, 'dshpx-gutter')[0];
  assert.ok(gutter && textOf(gutter).startsWith('1\n2'), 'line numbers');

  // image entry
  walk(view.tree, () => {});
  let picRow = null;
  walk(view.tree, (el) => {
    if (el.type && el.type.name === 'ArchiveEntryRow' && el.props.node && el.props.node.name === 'pic.png') picRow = el;
  });
  assert.ok(picRow, 'pic row after rerender');
  picRow.props.onActivate(picRow.props.node);
  await view.settle();
  const img = findAll(view.tree, 'img')[0];
  assert.ok(img && String(img.props.src).startsWith('blob:'), 'image preview blob url');

  // encrypted entry
  let secretRow = null;
  walk(view.tree, (el) => {
    if (el.type && el.type.name === 'ArchiveEntryRow' && el.props.node && el.props.node.name === 'secret.txt') secretRow = el;
  });
  assert.ok(secretRow, 'secret row');
  secretRow.props.onActivate(secretRow.props.node);
  await view.settle();
  const encPanel = findAll(view.tree, 'StatePanel').find((el) => el.props.tone === 'error');
  assert.ok(encPanel, 'encrypted entry error panel');
  view.unmount();
}

// unsupported format
{
  const view = await mount(views.ArchivePreviewBody, {
    content: { kind: 'bytes', data: new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 1, 2, 3]) },
    ...tabProps('x.7z'),
    t: undefined,
  });
  await view.settle();
  const panel = findAll(view.tree, 'StatePanel')[0];
  assert.ok(panel && panel.props.tone === 'warning', 'unsupported archive panel');
  view.unmount();
}

// empty archive
{
  const view = await mount(views.ArchivePreviewBody, {
    content: { kind: 'bytes', data: new Uint8Array(buildZip([])) },
    ...tabProps('empty.zip'),
    t: undefined,
  });
  await view.settle();
  assert.ok(textOf(view.tree).includes('空'), 'empty archive panel');
  view.unmount();
}

// ---- Media -----------------------------------------------------------------
{
  const view = await mount(views.MediaPreviewBody, {
    content: { kind: 'bytes', data: new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0]) },
    ...tabProps('song.mp3'),
    t: undefined,
  });
  await view.settle();
  assert.equal(findAll(view.tree, 'audio').length, 1, 'audio element');
  const audio = findAll(view.tree, 'audio')[0];
  audio.props.onError();
  await view.settle();
  assert.ok(findAll(view.tree, 'StatePanel').some((el) => el.props.tone === 'error'), 'media error panel');
  view.unmount();

  const video = await mount(views.MediaPreviewBody, {
    content: { kind: 'bytes', data: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]) },
    ...tabProps('clip.mp4'),
    t: undefined,
  });
  await video.settle();
  assert.equal(findAll(video.tree, 'video').length, 1, 'video element');
  video.unmount();
}

// ---- Font ------------------------------------------------------------------
{
  const view = await mount(views.FontPreviewBody, {
    content: { kind: 'bytes', data: new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    ...tabProps('MyFont.ttf'),
    t: undefined,
  });
  await view.settle();
  const panel = findAll(view.tree, 'StatePanel').find((el) => el.props.tone === 'error');
  assert.ok(panel, 'font error panel without document');
  assert.ok(textOf(panel).includes('字体'), 'font error text');
  view.unmount();
}

// ---- Subtitle --------------------------------------------------------------
const srt = `1
00:00:01,000 --> 00:00:03,500
Hello world
line two

2
00:00:04,000 --> 00:00:06,000
<i>Second</i> cue
`;
{
  const view = await mount(views.SubtitlePreviewBody, {
    content: { kind: 'bytes', data: new TextEncoder().encode(srt) },
    ...tabProps('movie.srt'),
    t: undefined,
  });
  await view.settle();
  assert.equal(findAllByClass(view.tree, 'dshpx-cue').length, 2, 'srt cue rows');
  assert.ok(textOf(view.tree).includes('00:01.000'), 'srt cue time');
  assert.ok(textOf(view.tree).includes('Second cue'), 'srt html stripped');
  let rawBtn = null;
  walk(view.tree, (el) => {
    if (el.type && typeof el.type === 'function' && el.type.name === 'ActionButton' && textOf(el.props.children).includes('原始文本')) {
      rawBtn = el;
    }
  });
  assert.ok(rawBtn, 'raw toggle button');
  rawBtn.props.onClick();
  await view.settle();
  assert.ok(findAllByClass(view.tree, 'dshpx-raw-pre').length === 1, 'raw text view');
  view.unmount();
}

const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.500\nHi VTT\n\n00:03.000 --> 00:04.000 align:start\nSecond\n';
{
  const view = await mount(views.SubtitlePreviewBody, {
    content: { kind: 'bytes', data: new TextEncoder().encode(vtt) },
    ...tabProps('movie.vtt'),
    t: undefined,
  });
  await view.settle();
  assert.equal(findAllByClass(view.tree, 'dshpx-cue').length, 2, 'vtt cue rows');
  assert.ok(textOf(view.tree).toUpperCase().includes('VTT'), 'vtt format badge');
  view.unmount();
}

const ass = `[Script Info]
ScriptType: v4.00+
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello\\NASS, with comma
`;
{
  const view = await mount(views.SubtitlePreviewBody, {
    content: { kind: 'bytes', data: new TextEncoder().encode(ass) },
    ...tabProps('movie.ass'),
    t: undefined,
  });
  await view.settle();
  assert.equal(findAllByClass(view.tree, 'dshpx-cue').length, 1, 'ass cue rows');
  assert.ok(textOf(view.tree).includes('ASS, with comma'), 'ass text kept comma');
  view.unmount();
}

// ---- no-content guard ------------------------------------------------------
for (const [name, Component] of [
  ['model', views.ModelPreviewBody],
  ['archive', views.ArchivePreviewBody],
  ['media', views.MediaPreviewBody],
  ['font', views.FontPreviewBody],
  ['subtitle', views.SubtitlePreviewBody],
  ['toml', views.previewBodies[views.PREVIEW_IDS.toml]],
  ['ihex', views.previewBodies[views.PREVIEW_IDS.ihex]],
  ['jcamp', views.previewBodies[views.PREVIEW_IDS.jcamp]],
  ['vcd', views.previewBodies[views.PREVIEW_IDS.vcd]],
  ['kicad', views.previewBodies[views.PREVIEW_IDS.kicad]],
  ['dfu', views.previewBodies[views.PREVIEW_IDS.dfu]],
]) {
  const view = await mount(Component, { content: undefined, ...tabProps('x'), t: undefined });
  await view.settle(3);
  assert.ok(view.tree, name + ' body renders with no content');
  assert.ok(findAll(view.tree, 'StatePanel').length >= 1, name + ' no-content panel');
  view.unmount();
}

const textOfBytes = (value) => new TextEncoder().encode(value);
{
  const samples = [
    ['toml', 'app.toml', 'title = "demo"\ncount = 2\n[server]\nport = 8080\n'],
    ['ihex', 'fw.hex', ':0400000001020304F2\n:00000001FF\n'],
    ['jcamp', 'spec.jdx', '##TITLE=Demo\n##XUNITS=1/CM\n##YUNITS=ABSORBANCE\n##XFACTOR=1\n##YFACTOR=1\n##DELTAX=1\n##XYDATA=(X++(Y..Y))\n400 1 2 3\n##END=\n'],
    ['vcd', 'wave.vcd', '$timescale 1 ns $end\n$scope module top $end\n$var wire 1 ! clk $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#10\n1!\n'],
    ['kicad', 'board.kicad_sch', '(kicad_sch (version 20231120) (wire (pts (xy 0 0) (xy 10 0))))'],
    ['dfu', 'fw.dfu', null],
  ];
  for (const [group, fileName, text] of samples) {
    let bytes = text == null ? null : textOfBytes(text);
    if (group === 'dfu') {
      const { crc32 } = await import('../formats/dfu.js');
      const payload = Uint8Array.from([1, 2, 3, 4]);
      const body = new Uint8Array(payload.length + 12);
      body.set(payload, 0);
      const view = new DataView(body.buffer);
      view.setUint16(payload.length + 2, 0x1234, true);
      view.setUint16(payload.length + 4, 0xabcd, true);
      view.setUint16(payload.length + 6, 0x0110, true);
      body[payload.length + 8] = 0x55;
      body[payload.length + 9] = 0x46;
      body[payload.length + 10] = 0x44;
      body[payload.length + 11] = 16;
      bytes = new Uint8Array(body.length + 4);
      bytes.set(body, 0);
      new DataView(bytes.buffer).setUint32(body.length, crc32(body), true);
    }
    const Component = views.previewBodies[views.PREVIEW_IDS[group]];
    const view = await mount(Component, {
      content: { kind: 'bytes', data: bytes },
      ...tabProps(fileName),
      t: undefined,
    });
    await view.settle();
    assert.ok(!findAll(view.tree, 'StatePanel').some((el) => el.props.tone === 'error'), group + ' should parse');
    const textOut = textOf(view.tree);
    if (group === 'toml') assert.ok(textOut.includes('8080'), 'toml port');
    if (group === 'ihex') assert.ok(textOut.includes('0x00000000') || textOut.toLowerCase().includes('00000000'), 'hex address');
    if (group === 'jcamp') assert.ok(textOut.includes('Demo') || textOut.includes('1/CM'), 'jcamp meta');
    if (group === 'vcd') assert.ok(textOut.includes('clk') || textOut.includes('1 ns'), 'vcd meta');
    if (group === 'kicad') assert.ok(textOut.includes('原理图') || textOut.includes('导线'), 'kicad kind');
    if (group === 'dfu') assert.ok(textOut.includes('0xABCD') || textOut.includes('0x1234'), 'dfu ids');
    view.unmount();
  }
}

console.log('smoke ok: exports, locales (' + zhKeys.length + ' keys), definitions, tr keys (' + usedKeys.size + ')');
console.log('smoke ok: model / archive(text,image,encrypted,unsupported,empty) / media / font / subtitle(srt,vtt,ass)');

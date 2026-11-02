// kicad.js — KiCad 6+ 的 .kicad_sch / .kicad_pcb（S 表达式）。
// 原理图把符号库图形变换到图纸坐标（符号 Y 向上，图纸 Y 向下）；
// 电路板保留 Y 向上的毫米坐标，由视图再翻转到屏幕。

import { decodeUtf8 } from './text.js';

const MAX_PRIMITIVES = 20_000;

const PCB_COLORS = {
  'F.Cu': '#d35b4a',
  'B.Cu': '#3d7ec9',
  'In1.Cu': '#3d7ec9',
  'In2.Cu': '#3d7ec9',
  'F.SilkS': '#d8c15a',
  'B.SilkS': '#b7a24a',
  'F.Mask': '#8a4a62',
  'B.Mask': '#4a5a8a',
  'F.Paste': '#b0b0b0',
  'B.Paste': '#909090',
  'F.CrtYd': '#c080c0',
  'B.CrtYd': '#9080b0',
  'Edge.Cuts': '#f2f2f2',
  'F.Fab': '#8d8d8d',
  'B.Fab': '#7a7a7a',
  'Dwgs.User': '#7aa0b8',
  'Cmts.User': '#7aa0b8',
};

/**
 * @param {Uint8Array|ArrayBuffer|string} input
 */
export function parseKicad(input) {
  const blank = emptyDocument();
  let text;
  try {
    text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeUtf8(input);
  } catch (err) {
    return { ok: false, error: 'KiCad 解析失败：输入不是文本', ...blank };
  }
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('(kicad_sch') && !trimmed.startsWith('(kicad_pcb')) {
    return { ok: false, error: '不是 KiCad 新版原理图（kicad_sch）或电路板（kicad_pcb）', ...blank };
  }
  let root;
  try {
    root = parseSexpr(text);
  } catch (err) {
    return { ok: false, error: `KiCad 解析失败：${err.message || err}`, ...blank };
  }
  if (!Array.isArray(root)) return { ok: false, error: 'KiCad 解析失败：根节点不是 S 表达式', ...blank };
  try {
    if (root[0] === 'kicad_sch') return parseSchematic(root);
    if (root[0] === 'kicad_pcb') return parseBoard(root);
  } catch (err) {
    return { ok: false, error: `KiCad 解析失败：${err.message || err}`, ...blank };
  }
  return { ok: false, error: '不是 KiCad 新版原理图或电路板', ...blank };
}

/** 给测试和排错用的 S 表达式解析器。返回嵌套数组，数字会转成 number。 */
export function parseSexpr(text) {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  const parseAtom = () => {
    if (text[i] === '"') {
      i += 1;
      let value = '';
      while (i < text.length) {
        const ch = text[i++];
        if (ch === '"') break;
        if (ch === '\\' && i < text.length) {
          const next = text[i++];
          value += next === 'n' ? '\n' : next;
        } else value += ch;
      }
      return value;
    }
    const start = i;
    while (i < text.length && text[i] !== '(' && text[i] !== ')' && !/\s/.test(text[i])) i += 1;
    const raw = text.slice(start, i);
    if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw);
    return raw;
  };
  const parseNode = () => {
    skip();
    if (text[i] !== '(') throw new Error(`第 ${lineOf(text, i)} 行附近期望「(」`);
    i += 1;
    const node = [];
    while (true) {
      skip();
      if (i >= text.length) throw new Error('S 表达式没有结束');
      if (text[i] === ')') {
        i += 1;
        return node;
      }
      if (text[i] === '(') node.push(parseNode());
      else node.push(parseAtom());
    }
  };
  skip();
  return parseNode();
}

function emptyDocument() {
  return {
    kind: '',
    version: '',
    title: '',
    paper: '',
    stats: {},
    primitives: [],
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    yDown: true,
    warnings: [],
  };
}

function child(node, name) {
  if (!Array.isArray(node)) return null;
  for (let i = 1; i < node.length; i++) {
    const item = node[i];
    if (Array.isArray(item) && item[0] === name) return item;
  }
  return null;
}

function children(node, name) {
  const out = [];
  if (!Array.isArray(node)) return out;
  for (let i = 1; i < node.length; i++) {
    const item = node[i];
    if (Array.isArray(item) && item[0] === name) out.push(item);
  }
  return out;
}

function readAt(node) {
  const at = child(node, 'at');
  if (!at) return { x: 0, y: 0, rot: 0 };
  return { x: num(at[1]), y: num(at[2]), rot: num(at[3]) };
}

function num(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isHidden(node) {
  const effects = child(node, 'effects');
  if (!effects) return false;
  const hide = child(effects, 'hide');
  return !!(hide && (hide[1] === 'yes' || hide[1] === true));
}

function strokeWidth(node, fallback) {
  const stroke = child(node, 'stroke');
  const width = stroke && child(stroke, 'width');
  const value = width ? num(width[1]) : fallback;
  return value > 0 ? value : fallback;
}

function layerOf(node, fallback) {
  const layer = child(node, 'layer');
  if (!layer) return fallback;
  return String(layer[1] || fallback);
}

function xyList(node) {
  return children(node, 'xy').map((item) => [num(item[1]), num(item[2])]);
}

function paperOf(root) {
  const paper = child(root, 'paper');
  if (!paper) return '';
  if (typeof paper[2] === 'number') return `${paper[1]} ${paper[2]}×${paper[3] || ''}`.trim();
  return String(paper[1] || '');
}

function titleOf(root) {
  const block = child(root, 'title_block');
  const title = block && child(block, 'title');
  return title && typeof title[1] === 'string' ? title[1] : '';
}

function versionOf(root) {
  const version = child(root, 'version');
  return version ? String(version[1] ?? '') : '';
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line += 1;
  return line;
}

function createSink() {
  const primitives = [];
  const warnings = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const push = (primitive) => {
    if (primitives.length >= MAX_PRIMITIVES) return false;
    primitives.push(primitive);
    if (primitive.type === 'line') {
      include(primitive.x1, primitive.y1);
      include(primitive.x2, primitive.y2);
    } else if (primitive.type === 'poly') {
      for (let i = 0; i < primitive.points.length; i += 2) include(primitive.points[i], primitive.points[i + 1]);
    } else if (primitive.type === 'circle') {
      include(primitive.x - primitive.r, primitive.y - primitive.r);
      include(primitive.x + primitive.r, primitive.y + primitive.r);
    } else if (primitive.type === 'text') {
      include(primitive.x, primitive.y);
    }
    return true;
  };
  return {
    primitives,
    warnings,
    push,
    bounds() {
      if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      if (maxX - minX < 1e-6) maxX = minX + 1;
      if (maxY - minY < 1e-6) maxY = minY + 1;
      return { minX, minY, maxX, maxY };
    },
    limited() {
      return primitives.length >= MAX_PRIMITIVES;
    },
  };
}

function parseSchematic(root) {
  const sink = createSink();
  const libs = new Map();
  const libRoot = child(root, 'lib_symbols');
  if (libRoot) {
    for (const symbol of children(libRoot, 'symbol')) {
      const name = typeof symbol[1] === 'string' ? symbol[1] : '';
      if (name) libs.set(name, symbol);
    }
  }
  const stats = { wires: 0, buses: 0, symbols: 0, labels: 0, junctions: 0 };
  for (const item of root.slice(1)) {
    if (!Array.isArray(item) || sink.limited()) continue;
    if (item[0] === 'wire' || item[0] === 'bus') {
      const pts = child(item, 'pts');
      const points = pts ? xyList(pts) : [];
      const color = item[0] === 'bus' ? '#e0a050' : 'theme';
      const width = item[0] === 'bus' ? 0.45 : 0.18;
      for (let i = 1; i < points.length; i++) {
        sink.push({ type: 'line', x1: points[i - 1][0], y1: points[i - 1][1], x2: points[i][0], y2: points[i][1], color, width });
      }
      if (item[0] === 'wire') stats.wires += 1;
      else stats.buses += 1;
    } else if (item[0] === 'junction') {
      const at = readAt(item);
      sink.push({ type: 'circle', x: at.x, y: at.y, r: 0.35, color: 'theme', fill: true });
      stats.junctions += 1;
    } else if (item[0] === 'no_connect') {
      const at = readAt(item);
      const d = 0.6;
      sink.push({ type: 'line', x1: at.x - d, y1: at.y - d, x2: at.x + d, y2: at.y + d, color: '#d35b4a', width: 0.15 });
      sink.push({ type: 'line', x1: at.x - d, y1: at.y + d, x2: at.x + d, y2: at.y - d, color: '#d35b4a', width: 0.15 });
    } else if (item[0] === 'label' || item[0] === 'global_label' || item[0] === 'hierarchical_label' || item[0] === 'text') {
      const at = readAt(item);
      const text = typeof item[1] === 'string' ? item[1] : '';
      if (text && !isHidden(item)) {
        sink.push({ type: 'text', x: at.x, y: at.y, text, size: 1.27, color: 'theme' });
        stats.labels += 1;
      }
    } else if (item[0] === 'polyline' || item[0] === 'rectangle' || item[0] === 'circle' || item[0] === 'arc') {
      drawGraphic(item, (x, y) => [x, y], sink, 'theme', 0.15);
    } else if (item[0] === 'sheet') {
      const at = readAt(item);
      const size = child(item, 'size');
      const w = size ? num(size[1]) : 20;
      const h = size ? num(size[2]) : 20;
      sink.push({
        type: 'poly',
        points: [at.x, at.y, at.x + w, at.y, at.x + w, at.y + h, at.x, at.y + h],
        color: '#c9a0e0',
        fill: false,
        width: 0.3,
      });
      const name = children(item, 'property').find((prop) => prop[1] === 'Sheetname');
      if (name && typeof name[2] === 'string') sink.push({ type: 'text', x: at.x + 1, y: at.y + 2, text: name[2], size: 1.27, color: 'theme' });
    } else if (item[0] === 'symbol' && typeof item[1] !== 'string') {
      drawSymbolInstance(item, libs, sink, stats);
    }
  }
  if (sink.limited()) sink.warnings.push(`图元超过 ${MAX_PRIMITIVES}，只画了前面的部分`);
  if (sink.primitives.length === 0) sink.warnings.push('原理图里没有可绘制的导线或符号');
  return {
    ok: true,
    kind: 'sch',
    version: versionOf(root),
    title: titleOf(root),
    paper: paperOf(root),
    stats,
    primitives: sink.primitives,
    bounds: sink.bounds(),
    yDown: true,
    warnings: sink.warnings,
  };
}

function drawSymbolInstance(instance, libs, sink, stats) {
  const libId = child(instance, 'lib_id');
  const name = libId ? String(libId[1] || '') : '';
  const at = readAt(instance);
  const unitNode = child(instance, 'unit');
  const unit = unitNode ? num(unitNode[1]) || 1 : 1;
  const mirrorNode = child(instance, 'mirror');
  const mirror = mirrorNode ? String(mirrorNode[1] || '') : '';
  const xf = (x, y) => symbolToSheet(x, y, at, mirror);
  const lib = libs.get(name);
  if (lib) {
    for (const part of children(lib, 'symbol')) {
      const partName = typeof part[1] === 'string' ? part[1] : '';
      const parsed = parseUnitName(name, partName);
      if (parsed && parsed.unit !== 0 && parsed.unit !== unit) continue;
      if (parsed && parsed.style !== 0 && parsed.style !== 1) continue;
      for (const graphic of part.slice(1)) {
        if (!Array.isArray(graphic)) continue;
        if (graphic[0] === 'pin') drawPin(graphic, xf, sink);
        else drawGraphic(graphic, xf, sink, '#c5d0dc', 0.12);
      }
    }
  } else if (name) {
    sink.warnings.push(`符号库里没有 ${name}，只标出了位号`);
    sink.push({ type: 'circle', x: at.x, y: at.y, r: 1.2, color: '#c5d0dc', fill: false });
  }
  for (const prop of children(instance, 'property')) {
    if (isHidden(prop)) continue;
    const key = prop[1];
    const value = prop[2];
    if ((key === 'Reference' || key === 'Value') && typeof value === 'string' && value && value !== '~') {
      const pos = readAt(prop);
      // 属性坐标已经是图纸坐标，不要再做符号变换。
      sink.push({ type: 'text', x: pos.x, y: pos.y, text: value, size: 1.27, color: 'theme' });
    }
  }
  stats.symbols += 1;
}

function parseUnitName(parent, childName) {
  const prefix = `${parent}_`;
  if (!childName.startsWith(prefix)) return null;
  const match = /^(\d+)_(\d+)$/.exec(childName.slice(prefix.length));
  if (!match) return null;
  return { unit: Number(match[1]), style: Number(match[2]) };
}

/**
 * 符号坐标（Y 向上）→ 原理图坐标（Y 向下）。
 * 先镜像，再按文件里的逆时针角度旋转，最后翻转 Y。
 */
export function symbolToSheet(x, y, at, mirror) {
  let px = x;
  let py = y;
  if (mirror === 'x') px = -px;
  else if (mirror === 'y') py = -py;
  const rad = (at.rot || 0) * Math.PI / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const rx = px * c - py * s;
  const ry = px * s + py * c;
  return [at.x + rx, at.y - ry];
}

function drawPin(pin, xf, sink) {
  const at = readAt(pin);
  const lengthNode = child(pin, 'length');
  const length = lengthNode ? num(lengthNode[1]) : 2.54;
  const rad = at.rot * Math.PI / 180;
  const x0 = at.x - Math.cos(rad) * length;
  const y0 = at.y - Math.sin(rad) * length;
  const a = xf(x0, y0);
  const b = xf(at.x, at.y);
  sink.push({ type: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], color: '#7dcea0', width: 0.12 });
}

function drawGraphic(node, xf, sink, color, width) {
  if (!Array.isArray(node)) return;
  const kind = node[0];
  if (kind === 'rectangle' || kind === 'rect') {
    const start = child(node, 'start');
    const end = child(node, 'end');
    if (!start || !end) return;
    const corners = [
      xf(num(start[1]), num(start[2])),
      xf(num(end[1]), num(start[2])),
      xf(num(end[1]), num(end[2])),
      xf(num(start[1]), num(end[2])),
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      sink.push({ type: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], color, width: strokeWidth(node, width) });
    }
  } else if (kind === 'polyline' || kind === 'fp_poly') {
    const pts = child(node, 'pts');
    const points = pts ? xyList(pts) : xyList(node);
    const mapped = points.map((point) => xf(point[0], point[1]));
    for (let i = 1; i < mapped.length; i++) {
      sink.push({
        type: 'line',
        x1: mapped[i - 1][0],
        y1: mapped[i - 1][1],
        x2: mapped[i][0],
        y2: mapped[i][1],
        color,
        width: strokeWidth(node, width),
      });
    }
  } else if (kind === 'circle' || kind === 'fp_circle') {
    const center = child(node, 'center');
    const radius = child(node, 'radius');
    if (!center || !radius) return;
    const c = xf(num(center[1]), num(center[2]));
    const edge = xf(num(center[1]) + num(radius[1]), num(center[2]));
    const r = Math.hypot(edge[0] - c[0], edge[1] - c[1]);
    sink.push({ type: 'circle', x: c[0], y: c[1], r, color, fill: false });
  } else if (kind === 'arc' || kind === 'fp_arc') {
    const start = child(node, 'start');
    const mid = child(node, 'mid');
    const end = child(node, 'end');
    if (!start || !mid || !end) return;
    const samples = sampleArc(
      [num(start[1]), num(start[2])],
      [num(mid[1]), num(mid[2])],
      [num(end[1]), num(end[2])],
      16
    );
    const mapped = samples.map((point) => xf(point[0], point[1]));
    for (let i = 1; i < mapped.length; i++) {
      sink.push({
        type: 'line',
        x1: mapped[i - 1][0],
        y1: mapped[i - 1][1],
        x2: mapped[i][0],
        y2: mapped[i][1],
        color,
        width: strokeWidth(node, width),
      });
    }
  }
}

function parseBoard(root) {
  const sink = createSink();
  const stats = { tracks: 0, vias: 0, footprints: 0, pads: 0, graphics: 0 };
  for (const item of root.slice(1)) {
    if (!Array.isArray(item) || sink.limited()) continue;
    if (item[0] === 'segment') {
      const start = child(item, 'start');
      const end = child(item, 'end');
      if (!start || !end) continue;
      const layer = layerOf(item, 'F.Cu');
      const widthNode = child(item, 'width');
      sink.push({
        type: 'line',
        x1: num(start[1]),
        y1: num(start[2]),
        x2: num(end[1]),
        y2: num(end[2]),
        color: PCB_COLORS[layer] || '#888',
        width: widthNode ? num(widthNode[1]) || 0.2 : 0.2,
      });
      stats.tracks += 1;
    } else if (item[0] === 'arc' && child(item, 'layer')) {
      const start = child(item, 'start');
      const mid = child(item, 'mid');
      const end = child(item, 'end');
      if (start && mid && end) {
        const layer = layerOf(item, 'F.Cu');
        const samples = sampleArc(
          [num(start[1]), num(start[2])],
          [num(mid[1]), num(mid[2])],
          [num(end[1]), num(end[2])],
          12
        );
        const widthNode = child(item, 'width');
        const width = widthNode ? num(widthNode[1]) || 0.2 : 0.2;
        for (let i = 1; i < samples.length; i++) {
          sink.push({
            type: 'line',
            x1: samples[i - 1][0],
            y1: samples[i - 1][1],
            x2: samples[i][0],
            y2: samples[i][1],
            color: PCB_COLORS[layer] || '#888',
            width,
          });
        }
        stats.tracks += 1;
      }
    } else if (item[0] === 'via') {
      const at = readAt(item);
      const size = child(item, 'size');
      const r = (size ? num(size[1]) : 0.8) / 2;
      sink.push({ type: 'circle', x: at.x, y: at.y, r, color: '#6c6', fill: true });
      const drill = child(item, 'drill');
      if (drill) sink.push({ type: 'circle', x: at.x, y: at.y, r: num(drill[1]) / 2, color: '#1b1f24', fill: true });
      stats.vias += 1;
    } else if (item[0] === 'footprint' || item[0] === 'module') {
      drawFootprint(item, sink, stats);
    } else if (item[0] === 'gr_line' || item[0] === 'gr_rect' || item[0] === 'gr_circle' || item[0] === 'gr_arc' || item[0] === 'gr_poly') {
      drawBoardGraphic(item, sink);
      stats.graphics += 1;
    } else if (item[0] === 'zone') {
      const polygon = child(item, 'polygon');
      const pts = polygon && child(polygon, 'pts');
      const points = pts ? xyList(pts) : [];
      if (points.length >= 2) {
        const flat = [];
        const limit = Math.min(points.length, 400);
        for (let i = 0; i < limit; i++) flat.push(points[i][0], points[i][1]);
        sink.push({ type: 'poly', points: flat, color: '#5a7a5a', fill: false, width: 0.15 });
      }
    }
  }
  if (sink.limited()) sink.warnings.push(`图元超过 ${MAX_PRIMITIVES}，只画了前面的部分`);
  if (sink.primitives.length === 0) sink.warnings.push('电路板里没有可绘制的走线、封装或板框');
  return {
    ok: true,
    kind: 'pcb',
    version: versionOf(root),
    title: titleOf(root),
    paper: '',
    stats,
    primitives: sink.primitives,
    bounds: sink.bounds(),
    yDown: false,
    warnings: sink.warnings,
  };
}

function drawBoardGraphic(item, sink) {
  const layer = layerOf(item, 'Edge.Cuts');
  const color = PCB_COLORS[layer] || '#cccccc';
  const kind = item[0];
  if (kind === 'gr_line') {
    const start = child(item, 'start');
    const end = child(item, 'end');
    if (!start || !end) return;
    sink.push({
      type: 'line',
      x1: num(start[1]),
      y1: num(start[2]),
      x2: num(end[1]),
      y2: num(end[2]),
      color,
      width: strokeWidth(item, 0.15),
    });
  } else if (kind === 'gr_rect') {
    const start = child(item, 'start');
    const end = child(item, 'end');
    if (!start || !end) return;
    const x0 = num(start[1]), y0 = num(start[2]), x1 = num(end[1]), y1 = num(end[2]);
    const points = [x0, y0, x1, y0, x1, y1, x0, y1];
    sink.push({ type: 'poly', points, color, fill: false, width: strokeWidth(item, 0.15) });
  } else if (kind === 'gr_circle') {
    const center = child(item, 'center');
    const radius = child(item, 'radius');
    if (!center || !radius) return;
    sink.push({ type: 'circle', x: num(center[1]), y: num(center[2]), r: num(radius[1]), color, fill: false });
  } else if (kind === 'gr_arc') {
    const start = child(item, 'start');
    const mid = child(item, 'mid');
    const end = child(item, 'end');
    if (!start || !mid || !end) return;
    const samples = sampleArc(
      [num(start[1]), num(start[2])],
      [num(mid[1]), num(mid[2])],
      [num(end[1]), num(end[2])],
      16
    );
    for (let i = 1; i < samples.length; i++) {
      sink.push({
        type: 'line',
        x1: samples[i - 1][0],
        y1: samples[i - 1][1],
        x2: samples[i][0],
        y2: samples[i][1],
        color,
        width: strokeWidth(item, 0.15),
      });
    }
  } else if (kind === 'gr_poly') {
    const pts = child(item, 'pts');
    const points = pts ? xyList(pts) : [];
    const flat = [];
    for (const point of points) flat.push(point[0], point[1]);
    if (flat.length >= 4) sink.push({ type: 'poly', points: flat, color, fill: false, width: strokeWidth(item, 0.15) });
  }
}

function drawFootprint(item, sink, stats) {
  const at = readAt(item);
  const layer = layerOf(item, 'F.Cu');
  const fp = {
    x: at.x,
    y: at.y,
    rot: at.rot * Math.PI / 180,
    back: layer.startsWith('B.'),
  };
  const map = (x, y) => footprintPoint(x, y, fp);
  stats.footprints += 1;
  for (const node of item.slice(1)) {
    if (!Array.isArray(node) || sink.limited()) continue;
    if (node[0] === 'pad') {
      drawPad(node, fp, sink);
      stats.pads += 1;
    } else if (node[0] === 'fp_line') {
      const start = child(node, 'start');
      const end = child(node, 'end');
      if (!start || !end) continue;
      const a = map(num(start[1]), num(start[2]));
      const b = map(num(end[1]), num(end[2]));
      const layerName = layerOf(node, 'F.SilkS');
      sink.push({
        type: 'line',
        x1: a[0],
        y1: a[1],
        x2: b[0],
        y2: b[1],
        color: PCB_COLORS[layerName] || '#d8c15a',
        width: strokeWidth(node, 0.12),
      });
    } else if (node[0] === 'fp_rect' || node[0] === 'fp_circle' || node[0] === 'fp_poly' || node[0] === 'fp_arc') {
      const layerName = layerOf(node, 'F.SilkS');
      drawGraphic(node, map, sink, PCB_COLORS[layerName] || '#d8c15a', 0.12);
    } else if (node[0] === 'fp_text' && typeof node[2] === 'string' && !isHidden(node)) {
      const pos = readAt(node);
      const point = map(pos.x, pos.y);
      sink.push({ type: 'text', x: point[0], y: point[1], text: node[2], size: 0.8, color: 'theme' });
    }
  }
}

function drawPad(pad, fp, sink) {
  const shape = typeof pad[3] === 'string' ? pad[3] : 'rect';
  const at = readAt(pad);
  const size = child(pad, 'size');
  const w = size ? num(size[1]) : 0.5;
  const h = size ? num(size[2] != null ? size[2] : size[1]) : 0.5;
  const localRot = at.rot * Math.PI / 180;
  if (shape === 'circle' || (shape === 'oval' && Math.abs(w - h) < 1e-6)) {
    const c = footprintPoint(at.x, at.y, fp);
    const edge = footprintPoint(at.x + w / 2, at.y, fp);
    sink.push({ type: 'circle', x: c[0], y: c[1], r: Math.hypot(edge[0] - c[0], edge[1] - c[1]), color: '#e6c07b', fill: true });
    return;
  }
  const hw = w / 2;
  const hh = h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const c = Math.cos(localRot);
  const s = Math.sin(localRot);
  const points = [];
  for (const [x, y] of corners) {
    const lx = at.x + x * c - y * s;
    const ly = at.y + x * s + y * c;
    const world = footprintPoint(lx, ly, fp);
    points.push(world[0], world[1]);
  }
  sink.push({ type: 'poly', points, color: '#e6c07b', fill: true, width: 0 });
}

/** 封装局部坐标 → 板坐标。背面封装先镜像 X，再逆时针旋转。 */
export function footprintPoint(x, y, fp) {
  let lx = x;
  let ly = y;
  if (fp.back) lx = -lx;
  const c = Math.cos(fp.rot);
  const s = Math.sin(fp.rot);
  return [fp.x + lx * c - ly * s, fp.y + lx * s + ly * c];
}

function sampleArc(start, mid, end, steps) {
  const circle = circleFrom3(start, mid, end);
  if (!circle) return [start, mid, end];
  const a0 = Math.atan2(start[1] - circle.y, start[0] - circle.x);
  const am = Math.atan2(mid[1] - circle.y, mid[0] - circle.x);
  const a1 = Math.atan2(end[1] - circle.y, end[0] - circle.x);
  let sweep = normalize(a1 - a0);
  const midSweep = normalize(am - a0);
  if (midSweep > sweep) sweep -= Math.PI * 2;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const angle = a0 + (sweep * i) / steps;
    points.push([circle.x + circle.r * Math.cos(angle), circle.y + circle.r * Math.sin(angle)]);
  }
  return points;
}

function normalize(angle) {
  const tau = Math.PI * 2;
  let value = angle % tau;
  if (value < 0) value += tau;
  return value;
}

function circleFrom3(a, b, c) {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const [x3, y3] = c;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return null;
  const x = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const y = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  return { x, y, r: Math.hypot(x1 - x, y1 - y) };
}

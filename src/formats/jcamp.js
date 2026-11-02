// jcamp.js — JCAMP-DX 谱图（.jdx / .dx）。
// 读取 ## 标记的 LDR，画出 (X++(Y..Y))、 (XY..XY) 和 PEAK TABLE。
// Y 值支持 ASCII 与 SQZ/DIF/DUP（PAC）压缩。NTUPLES 多页数据只展示表头。

import { decodeUtf8 } from './text.js';

const MAX_POINTS = 200_000;
const PLOT_POINTS = 8_000;

const SQZ = { '@': 0, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, a: -1, b: -2, c: -3, d: -4, e: -5, f: -6, g: -7, h: -8, i: -9 };
const DIF = { '%': 0, J: 1, K: 2, L: 3, M: 4, N: 5, O: 6, P: 7, Q: 8, R: 9, j: -1, k: -2, l: -3, m: -4, n: -5, o: -6, p: -7, q: -8, r: -9 };
const DUP = { S: 1, T: 2, U: 3, V: 4, W: 5, X: 6, Y: 7, Z: 8, s: 9 };

/**
 * @param {Uint8Array|ArrayBuffer|string} input
 */
export function parseJcamp(input) {
  const blank = blankResult();
  let text;
  try {
    text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeUtf8(input);
  } catch (err) {
    return { ok: false, error: 'JCAMP-DX 解析失败：输入不是文本', ...blank };
  }
  if (!/^\s*##/m.test(text) && !text.includes('\n##')) {
    return { ok: false, error: '不是 JCAMP-DX（找不到 ## 标记）', ...blank };
  }
  const records = splitRecords(text);
  const headers = [];
  const warnings = [];
  let data = null;
  let form = '';
  for (const record of records) {
    if (record.key === 'END' || record.key === '') continue;
    if (record.key === 'XYDATA' || record.key === 'XYPOINTS' || record.key === 'PEAKTABLE' || record.key === 'DATATABLE') {
      const split = splitForm(record.lines);
      form = split.form || (record.key === 'PEAKTABLE' || record.key === 'XYPOINTS' ? 'XY..XY' : 'X++(Y..Y)');
      data = { key: record.key, form, lines: split.data };
      continue;
    }
    if (record.key === 'NTUPLES') warnings.push('NTUPLES 多页数据没有展开，只显示表头');
    const value = record.lines.join(' ').trim();
    if (headers.length < 48 && value) headers.push({ key: record.rawKey, value: value.slice(0, 240) });
  }

  const lookup = (name) => {
    const found = records.find((record) => record.key === name);
    return found ? found.lines.join(' ').trim() : '';
  };
  const number = (name) => {
    const raw = lookup(name);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const result = {
    ok: true,
    title: lookup('TITLE'),
    dataType: lookup('DATATYPE'),
    xUnits: lookup('XUNITS'),
    yUnits: lookup('YUNITS'),
    origin: lookup('ORIGIN'),
    owner: lookup('OWNER'),
    jcamp: lookup('JCAMP-DX') || lookup('JCAMP'),
    npoints: number('NPOINTS'),
    firstX: number('FIRSTX'),
    lastX: number('LASTX'),
    deltaX: number('DELTAX'),
    xFactor: number('XFACTOR') ?? 1,
    yFactor: number('YFACTOR') ?? 1,
    headers,
    warnings,
    x: new Float64Array(0),
    y: new Float64Array(0),
    xMin: 0,
    xMax: 0,
    yMin: 0,
    yMax: 0,
    plotted: 0,
    total: 0,
    downsampled: false,
  };

  if (!data) {
    if (lookup('TITLE') || lookup('JCAMP-DX') || lookup('DATATYPE')) {
      result.warnings.push('有 JCAMP 表头，但没有 XYDATA / PEAK TABLE 数据');
      return result;
    }
    return { ok: false, error: '不是可识别的 JCAMP-DX 谱图', ...blank, headers, warnings };
  }

  const points = decodeData(data, result, warnings);
  result.total = points.x.length;
  if (result.npoints != null && result.npoints !== points.x.length) {
    warnings.push(`NPOINTS=${result.npoints}，实际解析到 ${points.x.length} 个点`);
  }
  const plot = downsample(points.x, points.y, PLOT_POINTS);
  result.x = plot.x;
  result.y = plot.y;
  result.plotted = plot.x.length;
  result.downsampled = plot.downsampled;
  if (plot.x.length > 0) {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < plot.x.length; i++) {
      const x = plot.x[i];
      const y = plot.y[i];
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    result.xMin = xMin;
    result.xMax = xMax;
    result.yMin = yMin;
    result.yMax = yMax;
  } else {
    result.warnings.push('数据段是空的');
  }
  return result;
}

function blankResult() {
  return {
    title: '',
    dataType: '',
    xUnits: '',
    yUnits: '',
    origin: '',
    owner: '',
    jcamp: '',
    npoints: null,
    firstX: null,
    lastX: null,
    deltaX: null,
    xFactor: 1,
    yFactor: 1,
    headers: [],
    warnings: [],
    x: new Float64Array(0),
    y: new Float64Array(0),
    xMin: 0,
    xMax: 0,
    yMin: 0,
    yMax: 0,
    plotted: 0,
    total: 0,
    downsampled: false,
  };
}

function splitRecords(text) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('$$')) continue;
    if (trimmed.startsWith('##')) {
      if (current) records.push(current);
      const body = trimmed.slice(2);
      const eq = body.indexOf('=');
      const rawKey = (eq >= 0 ? body.slice(0, eq) : body).trim();
      const key = rawKey.replace(/[\s._-]/g, '').toUpperCase();
      const value = eq >= 0 ? body.slice(eq + 1).trim() : '';
      current = { key, rawKey, lines: value ? [value] : [] };
    } else if (current) {
      current.lines.push(trimmed);
    }
  }
  if (current) records.push(current);
  return records;
}

function splitForm(lines) {
  if (lines.length === 0) return { form: '', data: [] };
  const first = lines[0].trim();
  const match = /^\((.+)\)\s*$/.exec(first);
  if (match) return { form: match[1].replace(/\s+/g, '').toUpperCase(), data: lines.slice(1) };
  return { form: '', data: lines };
}

function decodeData(data, meta, warnings) {
  const xs = [];
  const ys = [];
  const paired = data.form.includes('XY') && !data.form.includes('X++');
  const delta = meta.deltaX != null
    ? meta.deltaX
    : (meta.firstX != null && meta.lastX != null && meta.npoints && meta.npoints > 1
      ? (meta.lastX - meta.firstX) / (meta.npoints - 1)
      : 1);
  for (const line of data.lines) {
    if (xs.length >= MAX_POINTS) {
      warnings.push(`点数超过 ${MAX_POINTS}，后面的点已跳过`);
      break;
    }
    const values = decodeLine(line);
    if (values.length === 0) continue;
    if (paired) {
      for (let i = 0; i + 1 < values.length && xs.length < MAX_POINTS; i += 2) {
        xs.push(values[i] * meta.xFactor);
        ys.push(values[i + 1] * meta.yFactor);
      }
    } else {
      const x0 = values[0] * meta.xFactor;
      for (let i = 1; i < values.length && xs.length < MAX_POINTS; i++) {
        xs.push(x0 + (i - 1) * delta);
        ys.push(values[i] * meta.yFactor);
      }
    }
  }
  return { x: xs, y: ys };
}

/** 一行混排的 ASCII 数字和 PAC（SQZ/DIF/DUP），返回绝对值序列。 */
export function decodeLine(line) {
  const values = [];
  let last = 0;
  let lastDif = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) {
      const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(line.slice(i));
      if (!match) {
        i += 1;
        continue;
      }
      const value = Number(match[0]);
      if (Number.isFinite(value)) {
        lastDif = values.length === 0 ? 0 : value - last;
        last = value;
        values.push(value);
      }
      i += match[0].length;
      continue;
    }
    const token = readPac(line, i);
    if (!token) {
      i += 1;
      continue;
    }
    if (token.mode === 'abs') {
      lastDif = values.length === 0 ? 0 : token.value - last;
      last = token.value;
      values.push(last);
    } else if (token.mode === 'dif') {
      lastDif = token.value;
      last += token.value;
      values.push(last);
    } else {
      for (let extra = 1; extra < token.value; extra++) {
        last += lastDif;
        values.push(last);
      }
    }
    i = token.next;
  }
  return values;
}

function readPac(line, index) {
  const first = line[index];
  let mode = null;
  let digit = null;
  if (Object.prototype.hasOwnProperty.call(SQZ, first)) {
    mode = 'abs';
    digit = SQZ[first];
  } else if (Object.prototype.hasOwnProperty.call(DIF, first)) {
    mode = 'dif';
    digit = DIF[first];
  } else if (Object.prototype.hasOwnProperty.call(DUP, first)) {
    mode = 'dup';
    digit = DUP[first];
  } else {
    return null;
  }
  let value = Math.abs(digit);
  const negative = digit < 0;
  let cursor = index + 1;
  while (cursor < line.length) {
    const ch = line[cursor];
    let next = null;
    if (mode === 'dup') {
      if (Object.prototype.hasOwnProperty.call(DUP, ch)) next = DUP[ch];
    } else if (mode === 'abs') {
      if (Object.prototype.hasOwnProperty.call(SQZ, ch)) next = Math.abs(SQZ[ch]);
    } else if (Object.prototype.hasOwnProperty.call(DIF, ch)) {
      next = Math.abs(DIF[ch]);
    }
    if (next == null) break;
    value = value * 10 + next;
    cursor += 1;
  }
  if (negative) value = -value;
  return { mode, value, next: cursor };
}

function downsample(xs, ys, maxPoints) {
  if (xs.length <= maxPoints) {
    return { x: Float64Array.from(xs), y: Float64Array.from(ys), downsampled: false };
  }
  const buckets = Math.floor(maxPoints / 2);
  const outX = new Float64Array(buckets * 2);
  const outY = new Float64Array(buckets * 2);
  const size = xs.length / buckets;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * size);
    const end = Math.max(start + 1, Math.min(xs.length, Math.floor((bucket + 1) * size)));
    let minIndex = start;
    let maxIndex = start;
    for (let i = start; i < end; i++) {
      if (ys[i] < ys[minIndex]) minIndex = i;
      if (ys[i] > ys[maxIndex]) maxIndex = i;
    }
    const first = Math.min(minIndex, maxIndex);
    const second = Math.max(minIndex, maxIndex);
    outX[bucket * 2] = xs[first];
    outY[bucket * 2] = ys[first];
    outX[bucket * 2 + 1] = xs[second];
    outY[bucket * 2 + 1] = ys[second];
  }
  return { x: outX, y: outY, downsampled: true };
}

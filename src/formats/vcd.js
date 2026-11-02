// vcd.js — IEEE 1364 Value Change Dump。抽出时间刻度、作用域和每个信号的跳变，供波形图使用。

import { decodeUtf8 } from './text.js';

const MAX_CHANGES = 80_000;
const MAX_PER_SIGNAL = 6_000;
const MAX_CHARS = 8_000_000;

const UNIT_SECONDS = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };

/**
 * @param {Uint8Array|ArrayBuffer|string} input
 */
export function parseVcd(input) {
  const blank = { timescale: null, date: '', version: '', signals: [], endTime: 0, warnings: [], truncated: false };
  let text;
  try {
    text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeUtf8(input);
  } catch (err) {
    return { ok: false, error: 'VCD 解析失败：输入不是文本', ...blank };
  }
  const warnings = [];
  let truncated = false;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    truncated = true;
    warnings.push('文件较大，只解析了前 8 MB');
  }
  if (!text.includes('$var') && !text.includes('$timescale') && !text.includes('$scope')) {
    return { ok: false, error: '不是 VCD（找不到 $var / $scope / $timescale）', ...blank };
  }

  const byId = new Map();
  const signals = [];
  const scope = [];
  let timescale = { value: 1, unit: 'ns', text: '1 ns', seconds: 1e-9 };
  let date = '';
  let version = '';
  let time = 0;
  let changes = 0;
  let i = 0;

  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  const readWord = () => {
    skipWs();
    const start = i;
    while (i < text.length && !/\s/.test(text[i])) i += 1;
    return text.slice(start, i);
  };
  const readUntilEnd = () => {
    const marker = text.indexOf('$end', i);
    if (marker < 0) {
      const rest = text.slice(i);
      i = text.length;
      return rest;
    }
    const body = text.slice(i, marker);
    i = marker + 4;
    return body;
  };
  const record = (id, value) => {
    const signal = byId.get(id);
    if (!signal) return;
    if (signal.changes.length >= MAX_PER_SIGNAL) {
      signal.clipped = true;
      return;
    }
    const list = signal.changes;
    if (list.length > 0 && list[list.length - 1].t === time) list[list.length - 1].v = value;
    else list.push({ t: time, v: value });
    changes += 1;
    if (changes >= MAX_CHANGES) truncated = true;
  };
  const parseChange = () => {
    const ch = text[i];
    if (ch === 'b' || ch === 'B' || ch === 'r' || ch === 'R' || ch === 's' || ch === 'S') {
      i += 1;
      let value = '';
      while (i < text.length && !/\s/.test(text[i])) value += text[i++];
      const id = readWord();
      record(id, ch.toLowerCase() + value);
      return;
    }
    if (ch === '0' || ch === '1' || ch === 'x' || ch === 'X' || ch === 'z' || ch === 'Z') {
      const value = ch;
      i += 1;
      let id = '';
      while (i < text.length && !/\s/.test(text[i])) id += text[i++];
      record(id, value);
      return;
    }
    while (i < text.length && text[i] !== '\n') i += 1;
  };

  while (i < text.length && !truncated) {
    skipWs();
    if (i >= text.length) break;
    if (text[i] === '#') {
      i += 1;
      const raw = readWord();
      const next = Number(raw);
      if (Number.isFinite(next)) time = next;
      continue;
    }
    if (text[i] === '$') {
      const keyword = readWord().slice(1).toLowerCase();
      if (keyword === 'end' || keyword === 'dumpall' || keyword === 'dumpon' || keyword === 'dumpoff') continue;
      if (keyword === 'dumpvars') {
        while (i < text.length) {
          skipWs();
          if (text.startsWith('$end', i)) {
            i += 4;
            break;
          }
          if (i >= text.length) break;
          parseChange();
        }
        continue;
      }
      if (keyword === 'scope') {
        const body = readUntilEnd().trim().split(/\s+/);
        scope.push(body[1] || body[0] || '');
        continue;
      }
      if (keyword === 'upscope') {
        readUntilEnd();
        scope.pop();
        continue;
      }
      if (keyword === 'var') {
        const parts = readUntilEnd().trim().split(/\s+/).filter(Boolean);
        if (parts.length >= 3) {
          const id = parts[2];
          const name = parts.slice(3).join(' ') || id;
          if (!byId.has(id)) {
            const signal = {
              id,
              name,
              scope: scope.join('.'),
              type: parts[0],
              width: Number(parts[1]) || 1,
              changes: [],
              clipped: false,
            };
            byId.set(id, signal);
            signals.push(signal);
          }
        }
        continue;
      }
      if (keyword === 'timescale') {
        const body = readUntilEnd().trim();
        const match = /(\d+)\s*(fs|ps|ns|us|ms|s)/i.exec(body.replace(/\s+/g, ''));
        if (match) {
          const value = Number(match[1]);
          const unit = match[2].toLowerCase();
          timescale = { value, unit, text: `${value} ${unit}`, seconds: value * (UNIT_SECONDS[unit] || 1) };
        }
        continue;
      }
      if (keyword === 'date') {
        date = readUntilEnd().trim();
        continue;
      }
      if (keyword === 'version') {
        version = readUntilEnd().trim().slice(0, 160);
        continue;
      }
      readUntilEnd();
      continue;
    }
    parseChange();
  }

  if (signals.length === 0) {
    return { ok: false, error: 'VCD 里没有 $var 信号', ...blank, warnings };
  }
  let endTime = time;
  for (const signal of signals) {
    if (signal.changes.length > 0) {
      const last = signal.changes[signal.changes.length - 1].t;
      if (last > endTime) endTime = last;
    }
    if (signal.clipped) warnings.push(`信号 ${signal.name} 的跳变过多，只保留了前 ${MAX_PER_SIGNAL} 次`);
  }
  if (truncated && !warnings.some((item) => item.includes('8 MB'))) {
    warnings.push(`跳变超过 ${MAX_CHANGES} 次，波形只画到已解析的部分`);
  }
  return {
    ok: true,
    timescale,
    date,
    version,
    signals,
    endTime,
    warnings,
    truncated,
  };
}

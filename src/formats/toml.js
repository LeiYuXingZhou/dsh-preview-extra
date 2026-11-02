// toml.js — TOML v1.0 子集解析，产出可直接画成表格的章节。
// 覆盖：注释、字面量/多行字符串、整数（含 0x/0o/0b 与下划线）、浮点、布尔、
// 日期时间、数组、内联表、[表]、[[表数组]]、点分键。失败时带行号，不抛异常。

import { decodeUtf8 } from './text.js';

const MAX_CHARS = 2_000_000;

/**
 * @param {Uint8Array|ArrayBuffer|string} input
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   line?: number,
 *   sections: { header: string, rows: { key: string, type: string, text: string, line: number }[] }[],
 *   counts: { keys: number, tables: number, arrays: number },
 *   warnings: string[]
 * }}
 */
export function parseToml(input) {
  const empty = { sections: [], counts: { keys: 0, tables: 0, arrays: 0 }, warnings: [] };
  let text;
  try {
    text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeUtf8(input);
  } catch (err) {
    return { ok: false, error: 'TOML 解析失败：输入不是文本', ...empty };
  }
  const warnings = [];
  if (text.length > MAX_CHARS) {
    return {
      ok: false,
      error: `TOML 文件过大（${text.length} 字符），结构化预览最多处理 ${MAX_CHARS} 字符`,
      ...empty,
    };
  }
  if (text.trim() === '') {
    return { ok: true, ...empty, warnings };
  }
  try {
    const parser = new Parser(text);
    parser.parse();
    const sections = [];
    let keys = 0;
    let tables = 0;
    let arrays = 0;
    collect(parser.root, '', sections, (entry) => {
      if (entry.kind === 'value') keys += 1;
      else if (entry.kind === 'table' && entry.explicit) tables += 1;
      else if (entry.kind === 'array-of-tables') arrays += entry.items.length;
    });
    return { ok: true, sections, counts: { keys, tables, arrays }, warnings };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      line: err && err.line,
      ...empty,
      warnings,
    };
  }
}

function makeTable() {
  return { kind: 'table', explicit: false, closed: false, entries: new Map() };
}

function collect(table, path, out, count) {
  const rows = [];
  for (const [key, entry] of table.entries) {
    count(entry);
    if (entry.kind === 'value') {
      rows.push({ key, type: entry.type, text: entry.text, line: entry.line });
    }
  }
  if (rows.length > 0 || (table.explicit && path)) {
    out.push({ header: path, rows });
  }
  for (const [key, entry] of table.entries) {
    const childPath = path ? `${path}.${key}` : key;
    if (entry.kind === 'table') collect(entry, childPath, out, count);
    else if (entry.kind === 'array-of-tables') {
      entry.items.forEach((item, index) => collect(item, `${childPath}[${index}]`, out, count));
    }
  }
}

class Parser {
  constructor(text) {
    this.text = text;
    this.pos = 0;
    this.line = 1;
    this.column = 1;
    this.root = makeTable();
    this.current = this.root;
  }

  parse() {
    while (!this.eof()) {
      this.skipEmpty();
      if (this.eof()) break;
      if (this.peek() === '[') this.parseHeader();
      else {
        const line = this.line;
        const parts = this.parseKey();
        this.skipSpace();
        this.expect('=');
        const value = this.parseValue();
        this.assign(parts, {
          kind: 'value',
          type: value.type,
          text: value.text,
          line,
        });
        this.finishLine();
      }
    }
  }

  eof() {
    return this.pos >= this.text.length;
  }

  peek() {
    return this.pos < this.text.length ? this.text[this.pos] : '';
  }

  peekAt(offset) {
    const i = this.pos + offset;
    return i < this.text.length ? this.text[i] : '';
  }

  get() {
    const ch = this.text[this.pos++];
    if (ch === '\n') {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  error(message) {
    const err = new Error(`第 ${this.line} 行：${message}`);
    err.line = this.line;
    err.column = this.column;
    return err;
  }

  expect(ch) {
    if (this.peek() !== ch) throw this.error(`期望「${ch}」`);
    this.get();
  }

  skipSpace() {
    while (this.peek() === ' ' || this.peek() === '\t') this.get();
  }

  skipComment() {
    if (this.peek() !== '#') return;
    while (!this.eof() && this.peek() !== '\n') this.get();
  }

  skipEmpty() {
    while (!this.eof()) {
      this.skipSpace();
      if (this.peek() === '#') {
        this.skipComment();
        continue;
      }
      if (this.peek() === '\r') {
        this.get();
        if (this.peek() === '\n') this.get();
        continue;
      }
      if (this.peek() === '\n') {
        this.get();
        continue;
      }
      break;
    }
  }

  finishLine() {
    this.skipSpace();
    if (this.peek() === '#') this.skipComment();
    if (this.eof()) return;
    if (this.peek() === '\n') {
      this.get();
      return;
    }
    if (this.peek() === '\r') {
      this.get();
      if (this.peek() === '\n') this.get();
      return;
    }
    throw this.error('这一行末尾还有无法识别的内容');
  }

  parseHeader() {
    this.expect('[');
    const array = this.peek() === '[';
    if (array) this.get();
    const parts = this.parseKey();
    this.skipSpace();
    this.expect(']');
    if (array) {
      this.skipSpace();
      this.expect(']');
    }
    this.finishLine();
    if (array) this.openArrayTable(parts);
    else this.openTable(parts);
  }

  descend(node, key) {
    const entry = node.entries.get(key);
    if (!entry) return null;
    if (entry.kind === 'array-of-tables') {
      if (entry.items.length === 0) throw this.error(`表数组「${key}」是空的`);
      return entry.items[entry.items.length - 1];
    }
    if (entry.kind === 'table') {
      if (entry.closed) throw this.error(`「${key}」是已经关闭的内联表`);
      return entry;
    }
    throw this.error(`「${key}」已经有值，不能再当作表`);
  }

  openTable(parts) {
    let node = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      let next = this.descend(node, key);
      if (!next) {
        next = makeTable();
        node.entries.set(key, next);
      }
      node = next;
    }
    const key = parts[parts.length - 1];
    const existing = node.entries.get(key);
    if (!existing) {
      const table = makeTable();
      table.explicit = true;
      node.entries.set(key, table);
      this.current = table;
      return;
    }
    if (existing.kind !== 'table') throw this.error(`不能把「${key}」重新定义成表`);
    if (existing.explicit) throw this.error(`表「${parts.join('.')}」重复定义`);
    if (existing.closed) throw this.error(`不能重新打开内联表「${parts.join('.')}」`);
    existing.explicit = true;
    this.current = existing;
  }

  openArrayTable(parts) {
    let node = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      let next = this.descend(node, key);
      if (!next) {
        next = makeTable();
        node.entries.set(key, next);
      }
      node = next;
    }
    const key = parts[parts.length - 1];
    let existing = node.entries.get(key);
    if (!existing) {
      existing = { kind: 'array-of-tables', items: [] };
      node.entries.set(key, existing);
    } else if (existing.kind !== 'array-of-tables') {
      throw this.error(`不能把「${key}」重新定义成表数组`);
    }
    const table = makeTable();
    table.explicit = true;
    existing.items.push(table);
    this.current = table;
  }

  assign(parts, valueNode) {
    let node = this.current;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      let next = node.entries.get(key);
      if (!next) {
        next = makeTable();
        node.entries.set(key, next);
      } else if (next.kind === 'array-of-tables') {
        if (next.items.length === 0) throw this.error(`表数组「${key}」是空的`);
        next = next.items[next.items.length - 1];
      } else if (next.kind !== 'table') {
        throw this.error(`「${key}」已经有值，不能再嵌套`);
      } else if (next.closed) {
        throw this.error(`「${key}」是已经关闭的内联表`);
      }
      node = next;
    }
    const key = parts[parts.length - 1];
    if (node.entries.has(key)) throw this.error(`重复的键「${key}」`);
    node.entries.set(key, valueNode);
  }

  parseKey() {
    const parts = [];
    while (true) {
      this.skipSpace();
      parts.push(this.parseKeySegment());
      this.skipSpace();
      if (this.peek() === '.') {
        this.get();
        continue;
      }
      break;
    }
    return parts;
  }

  parseKeySegment() {
    const ch = this.peek();
    if (ch === '"' || ch === "'") {
      const parsed = this.parseString(ch === "'");
      return String(parsed.value);
    }
    let name = '';
    while (/[A-Za-z0-9_-]/.test(this.peek())) name += this.get();
    if (!name) throw this.error('缺少键名');
    return name;
  }

  parseValue() {
    this.skipSpaceAndBreaks();
    const ch = this.peek();
    if (ch === '"') return this.parseString(false);
    if (ch === "'") return this.parseString(true);
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseInlineTable();
    if (ch === 't' || ch === 'f') return this.parseBool();
    if (ch === '+' || ch === '-' || ch === 'i' || ch === 'n' || ch === '.' || (ch >= '0' && ch <= '9')) {
      return this.parseNumberOrDate();
    }
    throw this.error('无法识别的值');
  }

  skipSpaceAndBreaks() {
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.get();
        continue;
      }
      if (ch === '#') {
        this.skipComment();
        continue;
      }
      break;
    }
  }

  parseBool() {
    if (this.text.startsWith('true', this.pos) && !/[A-Za-z0-9_-]/.test(this.peekAt(4))) {
      this.pos += 4;
      this.column += 4;
      return { type: 'bool', value: true, text: 'true' };
    }
    if (this.text.startsWith('false', this.pos) && !/[A-Za-z0-9_-]/.test(this.peekAt(5))) {
      this.pos += 5;
      this.column += 5;
      return { type: 'bool', value: false, text: 'false' };
    }
    throw this.error('无法识别的值');
  }

  parseNumberOrDate() {
    const date = this.matchDate();
    if (date) {
      this.pos += date.length;
      this.column += date.length;
      const type = date.includes('T') || date.includes(' ') ? 'datetime' : date.includes(':') ? 'time' : 'date';
      return { type, value: date, text: date };
    }
    return this.parseNumber();
  }

  matchDate() {
    const rest = this.text.slice(this.pos, this.pos + 40);
    const match = /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(rest);
    if (!match) return null;
    const after = this.text[this.pos + match[0].length];
    if (after && /[A-Za-z0-9_]/.test(after)) return null;
    return match[0];
  }

  parseNumber() {
    const start = this.pos;
    const startCol = this.column;
    let sign = '';
    if (this.peek() === '+' || this.peek() === '-') sign = this.get();
    const word = (this.peek() + this.peekAt(1) + this.peekAt(2)).toLowerCase();
    if (word === 'inf' || word === 'nan') {
      this.get();
      this.get();
      this.get();
      const raw = this.text.slice(start, this.pos);
      if (word === 'nan') return { type: 'float', value: NaN, text: raw };
      const value = sign === '-' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      return { type: 'float', value, text: raw };
    }
    if (sign === '' && this.peek() === '0' && /[xob]/.test(this.peekAt(1))) {
      const baseChar = this.get() && this.get();
      const base = baseChar === 'x' ? 16 : baseChar === 'o' ? 8 : 2;
      const digits = this.readDigits(base);
      if (!digits) throw this.error('进制数字缺少数位');
      const raw = this.text.slice(start, this.pos);
      if (!/^(?:0[xob])[0-9A-Fa-f_]+$/.test(raw) || raw.includes('__') || raw.endsWith('_')) {
        throw this.error('进制数字里的下划线不合法');
      }
      return { type: 'integer', value: parseInt(digits, base), text: raw };
    }
    let rawBody = '';
    let sawDot = false;
    let sawExp = false;
    const takeDigits = () => {
      let any = false;
      if (this.peek() === '_') throw this.error('数字不能以下划线开头');
      while (/[0-9_]/.test(this.peek())) {
        const ch = this.get();
        rawBody += ch;
        if (ch !== '_') any = true;
      }
      return any;
    };
    if (!takeDigits() && this.peek() !== '.') throw this.error('无法识别的数字');
    if (this.peek() === '.') {
      sawDot = true;
      rawBody += this.get();
      if (!takeDigits()) throw this.error('小数点后缺少数位');
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      sawExp = true;
      rawBody += this.get();
      if (this.peek() === '+' || this.peek() === '-') rawBody += this.get();
      if (!takeDigits()) throw this.error('指数部分缺少数位');
    }
    const raw = this.text.slice(start, this.pos);
    if (raw.includes('__') || /_\./.test(raw) || /\._/.test(raw) || raw.endsWith('_')) {
      throw this.error('数字里的下划线不合法');
    }
    const value = Number(raw.replace(/_/g, ''));
    if (!Number.isFinite(value) && raw.replace(/_/g, '') !== '0') {
      // 超大整数仍按整数文本保留
    }
    this.column = startCol + (this.pos - start);
    return {
      type: sawDot || sawExp ? 'float' : 'integer',
      value,
      text: raw,
    };
  }

  readDigits(base) {
    const pattern = base === 16 ? /[0-9A-Fa-f_]/ : base === 8 ? /[0-7_]/ : /[01_]/;
    let digits = '';
    while (pattern.test(this.peek())) {
      const ch = this.get();
      if (ch !== '_') digits += ch;
    }
    return digits;
  }

  parseString(literal) {
    const quote = literal ? "'" : '"';
    this.expect(quote);
    if (this.peek() === quote && this.peekAt(1) === quote) {
      this.get();
      this.get();
      return this.parseMultiline(literal);
    }
    let value = '';
    while (!this.eof()) {
      const ch = this.get();
      if (ch === quote) return { type: 'string', value, text: displayString(value) };
      if (ch === '\n' || ch === '\r') throw this.error('字符串没有结束');
      if (!literal && ch === '\\') value += this.parseEscape(false);
      else value += ch;
    }
    throw this.error('字符串没有结束');
  }

  parseMultiline(literal) {
    const quote = literal ? "'" : '"';
    if (this.peek() === '\r') this.get();
    if (this.peek() === '\n') this.get();
    let value = '';
    while (!this.eof()) {
      if (this.peek() === quote && this.peekAt(1) === quote && this.peekAt(2) === quote) {
        this.get();
        this.get();
        this.get();
        // 结尾可以多写 1～2 个引号，它们属于内容
        return { type: 'string', value, text: displayString(value) };
      }
      const ch = this.get();
      if (!literal && ch === '\\') {
        if (this.peek() === '\r' || this.peek() === '\n') {
          if (this.peek() === '\r') this.get();
          if (this.peek() === '\n') this.get();
          while (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\n' || this.peek() === '\r') this.get();
          continue;
        }
        value += this.parseEscape(true);
      } else {
        value += ch;
      }
    }
    throw this.error('多行字符串没有结束');
  }

  parseEscape() {
    const ch = this.get();
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.prototype.hasOwnProperty.call(simple, ch)) return simple[ch];
    if (ch === 'u' || ch === 'U') {
      const width = ch === 'u' ? 4 : 8;
      const hex = this.text.slice(this.pos, this.pos + width);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) throw this.error('Unicode 转义不完整');
      this.pos += width;
      this.column += width;
      const code = parseInt(hex, 16);
      if (code > 0x10ffff) throw this.error('Unicode 码点超出范围');
      return String.fromCodePoint(code);
    }
    throw this.error(`非法转义 \\${ch}`);
  }

  parseArray() {
    this.expect('[');
    const items = [];
    while (true) {
      this.skipSpaceAndBreaks();
      if (this.peek() === ']') {
        this.get();
        break;
      }
      items.push(this.parseValue());
      this.skipSpaceAndBreaks();
      if (this.peek() === ',') {
        this.get();
        continue;
      }
      if (this.peek() === ']') {
        this.get();
        break;
      }
      throw this.error('数组元素之间需要逗号');
    }
    const shown = items.slice(0, 32).map((item) => item.text);
    const suffix = items.length > 32 ? `, … +${items.length - 32}` : '';
    return {
      type: 'array',
      value: items.map((item) => item.value),
      text: `[${shown.join(', ')}${suffix}]`,
    };
  }

  parseInlineTable() {
    this.expect('{');
    const pairs = [];
    const seen = new Set();
    while (true) {
      this.skipSpaceAndBreaks();
      if (this.peek() === '}') {
        this.get();
        break;
      }
      const parts = this.parseKey();
      const name = parts.join('.');
      if (seen.has(name)) throw this.error(`内联表里重复的键「${name}」`);
      seen.add(name);
      this.skipSpace();
      this.expect('=');
      const value = this.parseValue();
      pairs.push(`${name} = ${value.text}`);
      this.skipSpaceAndBreaks();
      if (this.peek() === ',') {
        this.get();
        continue;
      }
      if (this.peek() === '}') {
        this.get();
        break;
      }
      throw this.error('内联表字段之间需要逗号');
    }
    return { type: 'inline-table', value: null, text: `{ ${pairs.join(', ')} }` };
  }
}

function displayString(value) {
  const clipped = value.length > 240 ? `${value.slice(0, 240)}…` : value;
  return JSON.stringify(clipped);
}

#!/usr/bin/env node
/**
 * build-client.mjs — the whole "bundler" for this plugin.
 *
 * This machine has no network and no esbuild/rolldown/tsdown, and the installed
 * DSH (0.2.0-rc.2) only needs one hand-written artifact: `lib/client.js`, a
 * classic script that calls `window.__ModuleLoader__.load({ id, factory })`.
 * Rather than hand-maintaining one giant file, the browser source lives as
 * ordinary ESM modules under `src/`, and this script concatenates them into the
 * factory body with a tiny, intentionally strict module registry.
 *
 * Supported import forms (relative paths only; multi-line import lists are
 * joined automatically):
 *   import { a, b as c } from './x.js'
 *   import * as ns from './x.js'
 *   export { a as b } from './x.js'
 * and export forms:
 *   export function f() / export async function f()
 *   export const x = / export let x = / export var x =
 *   export class C
 *   export { a, b as c }
 * Anything else (default export, bare specifiers) fails the build loudly instead
 * of producing a subtly broken bundle.
 *
 * Usage: node scripts/build-client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const srcRoot = path.join(pkgRoot, 'src');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const entryId = 'client/main.js';
const outFile = path.join(pkgRoot, 'lib', 'client.js');

const idOf = (abs) => path.relative(srcRoot, abs).split(path.sep).join('/');

const modules = new Map(); // id -> transformed source

const IMPORT_NAMED = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?$/;
const IMPORT_STAR = /^import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"];?$/;
const IMPORT_SIDE = /^import\s*['"]([^'"]+)['"];?$/;
const EXPORT_FROM = /^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?$/;
const EXPORT_LIST = /^export\s*\{([^}]*)\};?$/;
const EXPORT_FN = /^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const EXPORT_CLASS = /^export\s+class\s+([A-Za-z_$][\w$]*)/;
const EXPORT_DECL = /^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** Join a possibly multi-line `import`/`export ... from` statement. */
function takeStatement(lines, start) {
  let text = lines[start].trim();
  let i = start;
  while (i + 1 < lines.length && !isComplete(text) && i - start < 40) {
    i += 1;
    text += ' ' + lines[i].trim();
  }
  return { text, end: i };
}

function isComplete(text) {
  if (/^import\s*['"][^'"]+['"];?$/.test(text)) return true;
  if (/^import\s*\*/.test(text)) return /from\s*['"][^'"]+['"];?$/.test(text);
  if (/^import\s*\{/.test(text)) return /from\s*['"][^'"]+['"];?$/.test(text);
  if (/^export\s*\{/.test(text)) {
    if (/^export\s*\{[^}]*\}\s*;?$/.test(text)) return true;
    return /from\s*['"][^'"]+['"];?$/.test(text);
  }
  return true;
}

function readModule(abs) {
  const id = idOf(abs);
  if (modules.has(id)) return id;
  if (!fs.existsSync(abs)) throw new Error(`[build] missing module: ${id} (looked for ${abs})`);
  modules.set(id, transform(id, fs.readFileSync(abs, 'utf8'), abs));
  return id;
}

function transform(id, raw, abs) {
  const dir = path.dirname(abs);
  const lines = raw.split(/\r?\n/);
  const prelude = [];
  const exportNames = [];
  const body = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (/^import\b/.test(trimmed) || /^export\s*\{/.test(trimmed)) {
      const { text, end } = takeStatement(lines, i);
      i = end;
      let m;
      if ((m = IMPORT_NAMED.exec(text))) {
        const target = resolveLocal(id, dir, m[2]);
        const clause = clauseOf(m[1]);
        prelude.push(`const { ${clause} } = __require(${JSON.stringify(target)});`);
      } else if ((m = IMPORT_STAR.exec(text))) {
        prelude.push(`const ${m[1]} = __require(${JSON.stringify(resolveLocal(id, dir, m[2]))});`);
      } else if ((m = IMPORT_SIDE.exec(text))) {
        prelude.push(`__require(${JSON.stringify(resolveLocal(id, dir, m[1]))});`);
      } else if ((m = EXPORT_FROM.exec(text))) {
        const target = resolveLocal(id, dir, m[2]);
        const ns = `__re${prelude.length}`;
        prelude.push(`const ${ns} = __require(${JSON.stringify(target)});`);
        for (const entry of exportList(m[1])) exportNames.push({ exported: entry.exported, local: `${ns}.${entry.local}` });
      } else if ((m = EXPORT_LIST.exec(text))) {
        for (const entry of exportList(m[1])) exportNames.push(entry);
      } else {
        throw new Error(`[build] ${id}: unsupported import/export form: ${text}`);
      }
      continue;
    }

    if (trimmed.startsWith('export ')) {
      let m;
      if ((m = EXPORT_FN.exec(trimmed))) {
        exportNames.push({ exported: m[2], local: m[2] });
        body.push(lines[i].replace(/^export\s+/, ''));
        continue;
      }
      if ((m = EXPORT_CLASS.exec(trimmed))) {
        exportNames.push({ exported: m[1], local: m[1] });
        body.push(lines[i].replace(/^export\s+/, ''));
        continue;
      }
      if ((m = EXPORT_DECL.exec(trimmed))) {
        exportNames.push({ exported: m[2], local: m[2] });
        body.push(lines[i].replace(/^export\s+/, ''));
        continue;
      }
      if (/^export\s+default/.test(trimmed)) {
        throw new Error(`[build] ${id}: default export is not supported; use named exports`);
      }
      // Any other `export` line is an error (unknown form).
      throw new Error(`[build] ${id}: unsupported export form: ${trimmed}`);
    }

    body.push(lines[i]);
  }

  const tail = exportNames
    .map((e) => `\t__exports[${JSON.stringify(e.exported)}] = ${e.local};`)
    .join('\n');

  return [
    `__modules[${JSON.stringify(id)}] = function (module, exports, require) {`,
    '\t"use strict";',
    '\tconst __exports = exports;',
    ...prelude.map((line) => '\t' + line),
    body.join('\n'),
    tail,
    '};',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function clauseOf(list) {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [imported, local] = part.split(/\s+as\s+/);
      return imported === local || local === undefined ? imported : `${imported}: ${local}`;
    })
    .join(', ');
}

function exportList(list) {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [local, exported] = part.split(/\s+as\s+/);
      return { local, exported: exported ?? local };
    });
}

function resolveLocal(id, dir, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    throw new Error(`[build] ${id}: only relative imports are supported, got ${spec}`);
  }
  return readModule(path.resolve(dir, spec));
}

// ---- collect the module graph from the entry ----
readModule(path.join(srcRoot, entryId));

const body = [...modules.entries()].map(([, src]) => src).join('\n\n');

const wrapper = `/**
 * dsh-preview-extra — browser bundle (generated by scripts/build-client.mjs; do not edit).
 *
 * Loaded as a classic script by @deepseek-ai/dsh-client-modules: this call only
 * registers the factory, and the factory body runs when the plugin fiber is
 * materialized. Platform modules stay external and are resolved by the shell's
 * frozen module table; the Node half of the plugin is lib/index.js.
 */
window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// Frozen platform table entries (see the shell's static module table).
		var react = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var __modules = Object.create(null);
		var __cache = Object.create(null);
		function __require(id) {
			if (__cache[id] !== void 0) return __cache[id];
			var factory = __modules[id];
			if (factory === void 0) throw new Error("dsh-preview-extra: unknown module " + id);
			var mod = { exports: {} };
			__cache[id] = mod.exports;
			factory(mod, mod.exports, __require);
			__cache[id] = mod.exports;
			return mod.exports;
		}

${body
  .split('\n')
  .map((line) => '\t\t' + line)
  .join('\n')}

		var __entry = __require(${JSON.stringify(entryId)});
		exports.apply = __entry.apply;
		exports.inject = __entry.inject;
		return module.exports;
	}
});
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, wrapper, 'utf8');
const size = fs.statSync(outFile).size;
console.log(`[build] wrote ${path.relative(pkgRoot, outFile)} (${(size / 1024).toFixed(1)} KiB, ${modules.size} modules)`);

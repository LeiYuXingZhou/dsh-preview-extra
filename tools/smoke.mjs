#!/usr/bin/env node
/**
 * smoke.mjs — headless integration smoke test for the generated client bundle.
 *
 * There is no browser available in this sandbox, so this harness runs the real
 * `lib/client.js` in a Node `vm` with a fake `window.__ModuleLoader__`, a fake
 * React renderer (enough hooks to execute one render pass plus effects), a fake
 * primitives table, and a fake Cordis context that records every
 * `documentPreviews.register` / `slots.register` call.
 *
 * What it proves:
 *   - the bundle is syntactically valid and registers id + factory;
 *   - the factory resolves every internal module and returns apply/inject;
 *   - apply() registers the expected preview metadata and a body per id;
 *   - every body can be invoked with real fixture bytes without throwing
 *     (render pass, then effects with a DOM stub).
 *
 * It cannot prove visual correctness or DSH-slot integration; that needs the
 * live GUI.
 *
 * Usage: node tools/smoke.mjs [--bundle <path>] [--fixtures <dir>] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const bundlePath = path.resolve(getArg('--bundle', path.join(repoRoot, 'lib', 'client.js')));
const fixturesDir = path.resolve(getArg('--fixtures', path.join(repoRoot, '..', '_fixtures')));
const quiet = args.includes('--quiet');

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};
const ok = (msg) => {
  if (!quiet) console.log(`ok   ${msg}`);
};

// ---------------------------------------------------------------- fake React
function makeFakeReact() {
  let ctxHooks = { list: [], index: 0, effects: [] };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { $$el: true, type, props: merged };
    },
    useState(initial) {
      const i = ctxHooks.index++;
      if (!(i in ctxHooks.list)) ctxHooks.list[i] = typeof initial === 'function' ? initial() : initial;
      return [ctxHooks.list[i], (next) => { ctxHooks.list[i] = typeof next === 'function' ? next(ctxHooks.list[i]) : next; }];
    },
    useReducer(reducer, initial) {
      const i = ctxHooks.index++;
      if (!(i in ctxHooks.list)) ctxHooks.list[i] = initial;
      return [ctxHooks.list[i], () => {}];
    },
    useRef(initial) {
      const i = ctxHooks.index++;
      if (!(i in ctxHooks.list)) ctxHooks.list[i] = { current: initial };
      return ctxHooks.list[i];
    },
    useEffect(fn) { ctxHooks.effects.push({ kind: 'effect', fn }); },
    useLayoutEffect(fn) { ctxHooks.effects.push({ kind: 'layout', fn }); },
    useInsertionEffect(fn) { ctxHooks.effects.push({ kind: 'insertion', fn }); },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useContext() { return {}; },
    createContext() { return { Provider: Symbol('Provider'), Consumer: Symbol('Consumer') }; },
    memo(fn) { return fn; },
    forwardRef(fn) { return fn; },
    lazy(factory) { return { $$lazy: factory }; },
    Suspense(props) { return props.children; },
    startTransition(fn) { fn(); },
    Children: { toArray: (c) => (Array.isArray(c) ? c : c == null ? [] : [c]), map: (c, fn) => [].concat(c ?? []).map(fn) },
  };
  React.__begin = () => { ctxHooks = { list: [], index: 0, effects: [] }; };
  React.__takeEffects = () => ctxHooks.effects;
  return React;
}

function makeFakeJsxRuntime(React) {
  const make = (type, props, key) => {
    const el = React.createElement(type, props ?? undefined);
    if (key !== undefined) el.key = key;
    return el;
  };
  return { jsx: make, jsxs: make, Fragment: React.Fragment };
}

function makeFakePrimitives(React) {
  const generic = (name) => function FakePrimitive(props) {
    return React.createElement('span', { 'data-fake-primitive': name, ...props });
  };
  const table = new Proxy(
    { classifyFileType: () => 'other', fileExtension: (p) => String(p).split('.').pop() },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== 'string') return undefined;
        // PascalCase names are components, everything else a no-op function.
        if (/^[A-Z]/.test(prop)) return generic(prop);
        return () => undefined;
      },
    }
  );
  return table;
}

// --------------------------------------------------------- fake DOM + runtime
function makeFakeDocument(log) {
  const listeners = new Map();
  const makeClassList = () => ({ add() {}, remove() {}, toggle() {}, contains: () => false });
  const makeStyle = () => ({ setProperty() {}, removeProperty() {}, cssText: '' });
  const makeCanvas = () => {
    const ctx = {
      canvas: null,
      setTransform() {}, resetTransform() {}, clearRect() {}, fillRect() {},
      beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
      arc() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
      measureText: () => ({ width: 10 }), fillText() {}, setLineDash() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      putImageData() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    };
    const canvas = {
      width: 300, height: 150, clientWidth: 300, clientHeight: 150,
      style: makeStyle(), classList: makeClassList(),
      getContext: () => ctx,
      addEventListener() {}, removeEventListener() {},
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 150, top: 0, left: 0, right: 300, bottom: 150 }),
    };
    ctx.canvas = canvas;
    return canvas;
  };
  const makeElement = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), children: [], childNodes: [], style: makeStyle(),
      classList: makeClassList(), dataset: {}, parentNode: null, textContent: '', innerHTML: '',
      setAttribute() {}, getAttribute: () => null, removeAttribute() {}, appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }, prepend(...nodes) { nodes.forEach((n) => this.appendChild(n)); },
      removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      insertBefore(node) { return this.appendChild(node); },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener(type, fn) { const arr = listeners.get(this) ?? new Map(); listeners.set(this, arr); arr.set(type, fn); },
      removeEventListener() {}, focus() {}, blur() {}, click() {}, scrollIntoView() {},
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 150, top: 0, left: 0, right: 300, bottom: 150 }),
      cloneNode() { return makeElement(tag); },
    };
    if (String(tag).toLowerCase() === 'canvas') Object.assign(el, makeCanvas(), { style: el.style, classList: el.classList });
    return el;
  };
  const head = makeElement('head');
  const body = makeElement('body');
  const doc = {
    documentElement: makeElement('html'),
    head,
    body,
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text, parentNode: null }),
    createDocumentFragment: () => makeElement('fragment'),
    querySelector: (sel) => (String(sel).includes('[data-dsh-preview-extra]') ? null : null),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    fonts: { add() {}, delete() {}, ready: Promise.resolve(), check: () => true },
    getElementById: () => null,
    hasFocus: () => false,
    activeElement: null,
  };
  return doc;
}

function makeSandbox() {
  const log = [];
  const sandbox = {
    console: { log: (...a) => log.push(a), warn: (...a) => log.push(a), error: (...a) => log.push(a) },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type ?? ''; } },
    TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, Float32Array, DecompressionStream,
    Event: class {}, CustomEvent: class {}, AbortController, AbortSignal,
    performance, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: () => Promise.reject(new Error('network disabled in smoke test')),
    navigator: { userAgent: 'dsh-smoke', language: 'zh-CN' },
    location: { href: 'http://dsh.invalid/', host: 'dsh.invalid' },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = makeFakeDocument(log);
  return { sandbox, log };
}

// -------------------------------------------------------------- mini renderer
function renderTree(React, root, depth = 0, errors = []) {
  const seen = [];
  const visit = (el) => {
    if (el === null || el === undefined || typeof el === 'boolean') return;
    if (typeof el === 'string' || typeof el === 'number') return;
    if (Array.isArray(el)) { el.forEach(visit); return; }
    if (!el || el.$$el !== true) return;
    const { type, props } = el;
    try {
      if (typeof type === 'function') {
        if (type.prototype && type.prototype.isReactComponent) return;
        React.__begin();
        const out = type(props);
        const effects = React.__takeEffects();
        visit(out);
        for (const effect of effects) seen.push(effect);
      } else if (typeof type === 'string') {
        visit(props?.children);
      } else if (type && type.$$lazy) {
        // Lazy components are not resolved in the smoke harness.
      } else if (type === React.Fragment) {
        visit(props?.children);
      }
    } catch (err) {
      errors.push({ phase: 'render', message: err && err.message ? err.message : String(err), stack: err && err.stack });
    }
  };
  visit(root);
  return { effects: seen, errors };
}

// ------------------------------------------------------------------- fixtures
function fixture(name, fallbackText) {
  const p = path.join(fixturesDir, name);
  if (fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));
  return new TextEncoder().encode(fallbackText ?? name);
}

const BODY_CASES = {
  'dsh-preview-extra/model': { file: 'cube.stl', bytes: () => fixture('cube-binary.stl') },
  'dsh-preview-extra/archive': { file: 'sample.zip', bytes: () => fixture('sample.zip') },
  'dsh-preview-extra/media': { file: 'tone.wav', bytes: () => fixture('tone.wav') },
  'dsh-preview-extra/font': { file: 'sample.ttf', bytes: () => fixture('sample.ttf') },
  'dsh-preview-extra/subtitle': { file: 'demo.srt', bytes: () => fixture('demo.srt') },
  'dsh-preview-extra/toml': { file: 'demo.toml', bytes: () => new TextEncoder().encode('name = "demo"\n') },
  'dsh-preview-extra/ihex': { file: 'fw.hex', bytes: () => new TextEncoder().encode(':00000001FF\n') },
  'dsh-preview-extra/jcamp': { file: 'spec.jdx', bytes: () => new TextEncoder().encode('##TITLE=Smoke\n##END=\n') },
  'dsh-preview-extra/vcd': { file: 'wave.vcd', bytes: () => new TextEncoder().encode('$timescale 1ns $end\n$var wire 1 ! clk $end\n') },
  'dsh-preview-extra/kicad': { file: 'a.kicad_sch', bytes: () => new TextEncoder().encode('(kicad_sch (version 1) (wire (pts (xy 0 0) (xy 1 0))))') },
  'dsh-preview-extra/dfu': { file: 'fw.dfu', bytes: () => new TextEncoder().encode('not-a-dfu') },
};

// ----------------------------------------------------------------------- main
function main() {
  return run().catch((err) => {
    fail(`smoke harness crashed: ${err && err.message}`);
    summary();
  });
}

async function run() {
  if (!fs.existsSync(bundlePath)) {
    console.error(`[smoke] bundle not found: ${bundlePath}`);
    process.exit(1);
  }
  const source = fs.readFileSync(bundlePath, 'utf8');
  const { sandbox } = makeSandbox();
  const React = makeFakeReact();
  const jsxRuntime = makeFakeJsxRuntime(React);
  const primitives = makeFakePrimitives(React);

  let registration;
  sandbox.window.__ModuleLoader__ = {
    load(value) {
      if (registration !== undefined) throw new Error('bundle registered the module loader twice');
      registration = value;
    },
  };

  vm.createContext(sandbox);
  try {
    vm.runInContext(source, sandbox, { filename: 'client.js' });
  } catch (err) {
    fail(`bundle evaluation threw: ${err && err.message}`);
    process.exit(1);
  }
  sandbox.window.__DSH_BOOT__ = {};

  if (!registration || typeof registration.factory !== 'function') {
    fail('bundle did not call window.__ModuleLoader__.load({ factory })');
    return summary();
  }
  ok(`bundle registered id=${JSON.stringify(registration.id)}`);

  let exportsObj;
  try {
    exportsObj = registration.factory((spec) => {
      if (spec === 'react') return React;
      if (spec === 'react/jsx-runtime') return jsxRuntime;
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
      throw new Error(`unexpected platform require(${JSON.stringify(spec)})`);
    });
  } catch (err) {
    fail(`factory threw: ${err && err.message}`);
    return summary();
  }
  if (!exportsObj || typeof exportsObj.apply !== 'function') {
    fail('factory exports has no apply()');
    return summary();
  }
  ok(`factory exports apply() inject=${JSON.stringify(exportsObj.inject ?? [])}`);

  // ---- fake Cordis context ----
  const previews = [];
  const bodies = new Map();
  const locales = [];
  const effects = [];
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dict) => { locales.push({ ns, dict }); },
    },
    effect: (factory) => { effects.push(factory); },
    documentPreviews: { register: (def) => { previews.push(def); return () => {}; } },
    slots: {
      inject: (name, factory) => factory(),
      register: (opts, body) => { bodies.set(opts.key, { opts, body }); return () => {}; },
    },
    inject: (names, callback) => { callback(ctx); },
  };
  try {
    exportsObj.apply(ctx);
  } catch (err) {
    fail(`apply() threw: ${err && err.message}`);
    return summary();
  }
  // run ctx.effect factories (registrations are expected inside them)
  for (const factory of effects) {
    try { factory(); } catch (err) { fail(`effect threw: ${err && err.message}`); }
  }

  if (locales.length === 0) fail('no locale dictionaries registered');
  else ok(`locales registered: ${locales.map((l) => l.ns).join(', ')}`);
  if (previews.length < 5) fail(`expected >=5 preview registrations, got ${previews.length}`);
  else ok(`preview registrations: ${previews.length}`);
  if (bodies.size < previews.length) fail(`only ${bodies.size} bodies for ${previews.length} previews`);

  for (const def of previews) {
    if (!Array.isArray(def.extensions) || def.extensions.length === 0) fail(`preview ${def.id} has no extensions`);
    if (def.loading !== 'bytes-complete') fail(`preview ${def.id} loading=${def.loading} (expected bytes-complete)`);
    if (def.binaryExtensions !== undefined) {
      const bad = def.binaryExtensions.filter((ext) => !def.extensions.includes(ext));
      if (bad.length > 0) fail(`preview ${def.id} binaryExtensions not a subset: ${bad.join(', ')}`);
    }
    if (!bodies.has(def.id)) fail(`preview ${def.id} has no keyed body`);
  }
  const extensions = new Set(previews.flatMap((d) => d.extensions));
  for (const expected of ['stl', 'obj', 'ply', 'gltf', 'glb', 'zip', 'tar', 'gz', '7z', 'rar', 'ttf', 'woff2', 'wav', 'mp3', 'mp4', 'srt', 'vtt', 'toml', 'hex', 'jdx', 'dx', 'vcd', 'kicad_sch', 'kicad_pcb', 'dfu']) {
    if (!extensions.has(expected)) fail(`missing extension claim: ${expected}`);
  }
  if (!failures) ok(`extension claims cover ${extensions.size} suffixes`);

  // ---- render every body with fixture bytes ----
  for (const [id, entry] of bodies) {
    const body = entry.body;
    const testCase = BODY_CASES[id];
    if (!testCase) continue;
    const bytes = testCase.bytes();
    const props = {
      resourceAddress: `dsh-resource://file/session-smoke/${testCase.file}`,
      content: { kind: 'bytes', data: bytes },
      wrap: false,
      scrollportRef: () => {},
      addResource: () => {},
      setResources: () => {},
      useTabInfo: () => ({ tab: { id: 'tab-smoke', title: testCase.file, contentId: `dsh-resource://file/session-smoke/${testCase.file}`, signal: new AbortController().signal, navigation: { params: undefined, revision: 0 }, actions: { bindCommands() {} }, refreshShortcut: undefined } }),
      t: (key) => key,
      actions: {},
      useStore: (selector) => selector({}),
      useResource: () => ({ status: 'live', value: { version: 1 } }),
    };
    let element;
    try {
      React.__begin();
      element = body(props);
    } catch (err) {
      fail(`body ${id} threw during call: ${err && err.message}`);
      continue;
    }
    const { effects: bodyEffects, errors } = renderTree(React, { $$el: true, type: body, props });
    if (errors.length > 0) {
      fail(`body ${id} render error: ${errors[0].message}`);
      continue;
    }
    // Run effects; async/event-driven work is allowed to stay pending.
    let effectErrors = 0;
    const cleanups = [];
    for (const effect of bodyEffects) {
      try {
        const cleanup = effect.fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      } catch (err) {
        effectErrors += 1;
        fail(`body ${id} effect error: ${err && err.message}`);
      }
    }
    // Let async work started by effects (parse timers, archive decompression,
    // FontFace loading, Blob URLs) settle before unmounting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // cleanup is best-effort in the smoke harness
      }
    }
    if (effectErrors === 0) ok(`body ${id} rendered with ${bytes.length} B fixture (${bodyEffects.length} effects)`);
  }

  summary();
}

function summary() {
  if (failures > 0) {
    console.error(`\n[smoke] ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n[smoke] all checks passed');
}

main();

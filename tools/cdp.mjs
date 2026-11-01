#!/usr/bin/env node
/**
 * cdp.mjs — tiny Chrome DevTools Protocol driver for verifying the DSH web GUI.
 *
 * The DSH file sandbox cannot start a browser process itself (Chromium's mojo
 * IPC uses named pipes), so the Chrome instance is launched once under a wider
 * sandbox mode and this driver talks to it over TCP. Node 24 ships a global
 * WebSocket, so no dependencies are needed.
 *
 * Commands:
 *   node tools/cdp.mjs list
 *   node tools/cdp.mjs new <url>
 *   node tools/cdp.mjs nav <url> [targetId]
 *   node tools/cdp.mjs eval <js-expression> [targetId]
 *   node tools/cdp.mjs shot <path.png> [targetId] [--full]
 *
 * `targetId` defaults to the first page target. Expressions are evaluated with
 * awaitPromise and returned by value.
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT ?? 9333);
const BASE = `http://127.0.0.1:${PORT}`;

const [command, ...rest] = process.argv.slice(2);

async function listTargets() {
  const res = await fetch(`${BASE}/json/list`);
  if (!res.ok) throw new Error(`/json/list ${res.status}`);
  return (await res.json()).filter((t) => t.type === 'page');
}

async function pickTarget(explicit) {
  const pages = await listTargets();
  if (pages.length === 0) throw new Error('no page targets; open a tab first');
  if (explicit) {
    const found = pages.find((p) => p.id === explicit) ?? pages.find((p) => p.url.includes(explicit));
    if (found) return found;
  }
  return pages[0];
}

class Session {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (event) => reject(new Error(`websocket error: ${event.message ?? 'unknown'}`)));
    });
    this.ws.addEventListener('message', (event) => {
      const data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      if (data.id !== undefined && this.pending.has(data.id)) {
        const { resolve, reject, timer } = this.pending.get(data.id);
        this.pending.delete(data.id);
        clearTimeout(timer);
        if (data.error) reject(new Error(`${data.error.message} (${data.error.code})`));
        else resolve(data.result);
      }
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function withSession(target, fn) {
  if (!target.webSocketDebuggerUrl) throw new Error('target has no webSocketDebuggerUrl');
  const session = new Session(target.webSocketDebuggerUrl);
  await session.ready;
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

async function main() {
  if (!command) {
    console.error('usage: node tools/cdp.mjs <list|new|nav|eval|shot> ...');
    process.exit(2);
  }

  if (command === 'list') {
    const pages = await listTargets();
    for (const page of pages) console.log(JSON.stringify({ id: page.id, url: page.url, title: page.title }));
    return;
  }

  if (command === 'new') {
    const url = rest[0] ?? 'about:blank';
    const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`/json/new ${res.status}`);
    const target = await res.json();
    console.log(JSON.stringify({ id: target.id, url: target.url }));
    return;
  }

  if (command === 'nav') {
    const url = rest[0];
    const target = await pickTarget(rest[1]);
    await withSession(target, async (session) => {
      await session.send('Page.enable');
      await session.send('Page.navigate', { url });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    console.log(`navigated ${url}`);
    return;
  }

  if (command === 'eval') {
    const expression = rest[0];
    const target = await pickTarget(rest[1]);
    const result = await withSession(target, (session) =>
      session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
    );
    if (result.exceptionDetails) {
      console.error(JSON.stringify(result.exceptionDetails, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(result.result?.value ?? result.result ?? null, null, 2));
    return;
  }

  if (command === 'shot') {
    const outPath = path.resolve(rest[0] ?? 'shot.png');
    const full = rest.includes('--full');
    const target = await pickTarget(rest[1]);
    const data = await withSession(target, async (session) => {
      const params = { format: 'png' };
      if (full) {
        const metrics = await session.send('Page.getLayoutMetrics');
        const size = metrics.cssContentSize ?? metrics.contentSize;
        params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
        params.captureBeyondViewport = true;
      }
      const shot = await session.send('Page.captureScreenshot', params, 60000);
      return shot.data;
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    console.log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
    return;
  }

  console.error(`unknown command: ${command}`);
  process.exit(2);
}

main().catch((err) => {
  console.error(`[cdp] ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * probe-bundle.mjs — check that a running DSH instance already serves this
 * plugin's client bundle. Replicates the host's metadata revision rule
 * (framed sha1 over mtimeMs/ctimeMs/size) so the exact `/plugins` URL can be
 * requested without a browser token.
 *
 * Usage: node tools/probe-bundle.mjs [--base http://127.0.0.1:1890] [--file <client.js>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const base = arg('--base', 'http://127.0.0.1:1890');
const file = path.resolve(arg('--file', path.join(repoRoot, 'pkg', 'lib', 'client.js')));

function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0');
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
  return hash.digest('hex').slice(0, 12);
}

const st = fs.statSync(file);
const rev = framedHash('plugin-artifact', [String(st.mtimeMs), String(st.ctimeMs), String(st.size)]);
const url = `${base}/plugins/??dsh-preview-extra/client.js&rev=${rev}`;
const res = await fetch(url);
const body = await res.arrayBuffer();
console.log(JSON.stringify({ file, base, rev, url, status: res.status, bytes: body.byteLength }, null, 2));
if (res.status !== 200) {
  console.error('[probe] the running instance does not serve this revision (row not mounted, or bundle replaced since).');
  process.exit(1);
}

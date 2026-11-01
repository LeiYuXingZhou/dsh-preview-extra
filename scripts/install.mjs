#!/usr/bin/env node
/**
 * install.mjs — mount dsh-preview-extra into a DSH profile without pnpm.
 *
 * Two steps, both idempotent:
 *   1. copy the package into <profile>/node_modules/dsh-preview-extra (the
 *      profile-local resolution anchor the Loader searches first);
 *   2. add one `insert` row to <profile>/cordis.patch.yml, the profile's
 *      hot-reloaded user patch layer.
 *
 * Usage:
 *   node scripts/install.mjs --profile-dir <dir> [--dry-run] [--uninstall]
 *
 * `--dry-run` prints what would change. `--uninstall` removes the copied
 * package and the mount row again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', 'pkg');
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const PKG_NAME = pkgJson.name;

function parseArgs(argv) {
  const args = { dryRun: false, uninstall: false, profileDir: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--uninstall') args.uninstall = true;
    else if (a === '--profile-dir') args.profileDir = argv[++i] ?? '';
    else if (a.startsWith('--profile-dir=')) args.profileDir = a.slice('--profile-dir='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.profileDir) throw new Error('missing --profile-dir <dir>');
  return args;
}

const { dryRun, uninstall, profileDir } = parseArgs(process.argv.slice(2));
const profile = path.resolve(profileDir);
if (!fs.existsSync(path.join(profile, 'package.json'))) {
  console.error(`[install] ${profile} does not look like a DSH profile (no package.json)`);
  process.exit(1);
}
const target = path.join(profile, 'node_modules', PKG_NAME);
const patchFile = path.join(profile, 'cordis.patch.yml');

const PATCH_BLOCK = [
  '# dsh-preview-extra: extra right-sidebar document previews (3D models,',
  '# archives, media, fonts, subtitles). Added by scripts/install.mjs.',
  '- insert:',
  `    - id: ${PKG_NAME}`,
  `      name: '${PKG_NAME}'`,
].join('\n');

const FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'lib'];
const hasMount = (text) => new RegExp(`^\\s*-?\\s*id:\\s*['"]?${PKG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm').test(text);

function copyPackage() {
  if (dryRun) {
    console.log(`[dry-run] would copy ${pkgRoot} -> ${target}`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of FILES) {
    const from = path.join(pkgRoot, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(target, entry), { recursive: true });
  }
  console.log(`[install] copied package to ${target}`);
}

function ensureMount() {
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  if (hasMount(original)) {
    console.log('[install] mount row already present in cordis.patch.yml');
    return;
  }
  const stripped = original
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .trim();
  const next = stripped === '[]' || stripped === ''
    ? (original.replace(/^\s*\[\]\s*$/m, '').trimEnd() ? original.replace(/^\s*\[\]\s*$/m, '').trimEnd() + '\n' : '') + PATCH_BLOCK + '\n'
    : original.trimEnd() + '\n' + PATCH_BLOCK + '\n';
  if (dryRun) {
    console.log(`[dry-run] would append mount row to ${patchFile}:\n${PATCH_BLOCK}`);
    return;
  }
  fs.writeFileSync(patchFile, next, 'utf8');
  console.log(`[install] mount row added to ${patchFile}`);
}

function removeMount() {
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  if (!hasMount(original)) {
    console.log('[uninstall] no mount row found');
  } else {
    const cleaned = original
      .split(/\r?\n/)
      .filter((line) => !line.includes(PKG_NAME) || !/^\s*-?\s*(id|name):/.test(line))
      .join('\n');
    // also drop the insert header comment block we added
    const lines = cleaned.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('dsh-preview-extra: extra right-sidebar')) {
        while (i < lines.length && !/^\s*- insert:/.test(lines[i])) i++;
        if (i < lines.length) i++; // skip '- insert:'
        while (i + 1 < lines.length && /^\s{4,}-/.test(lines[i + 1])) i++;
        continue;
      }
      out.push(lines[i]);
    }
    const text = out.join('\n').trimEnd() + '\n';
    if (!dryRun) fs.writeFileSync(patchFile, text, 'utf8');
    console.log('[uninstall] mount row removed');
  }
  if (fs.existsSync(target)) {
    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    console.log(`[uninstall] removed ${target}`);
  }
}

if (uninstall) {
  removeMount();
} else {
  copyPackage();
  ensureMount();
  console.log('[install] done. Long-lived DSH surfaces hot-reload the patch layer; a page refresh loads the new client bundle.');
  console.log('[install] verify: the right Sidebar should preview .stl/.obj/.ply, .zip/.tar/.gz, .ttf/.woff2, audio/video and .srt/.vtt files.');
}

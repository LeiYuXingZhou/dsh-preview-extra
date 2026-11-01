// tests/realworld-check.mjs — 用真实归档 + 系统工具（Expand-Archive / tar.exe）做交叉验证。
// 用法：
//   node tests/realworld-check.mjs <archive>                 # 只列举摘要
//   node tests/realworld-check.mjs <archive> <extractDir>    # 与系统工具解压结果逐字节比对
// 说明：这是可选的实机验证（不属于单元测试），依赖外部工具先解压好目录。

import fs from 'node:fs';
import path from 'node:path';

import { formatBytes, listArchive, readEntry } from '../index.js';

const [archivePath, extractDir] = process.argv.slice(2);
if (!archivePath) {
  console.error('用法: node realworld-check.mjs <archive> [extractDir]');
  process.exit(2);
}

const bytes = new Uint8Array(fs.readFileSync(archivePath));
const res = await listArchive(bytes, { filename: path.basename(archivePath) });

console.log(`\n=== ${path.basename(archivePath)} (${formatBytes(bytes.length)}) ===`);
console.log(`format=${res.format} supported=${res.supported} entries=${res.entries.length} truncated=${res.truncated}`);
if (res.hint) console.log(`hint=${res.hint}`);
if (res.notes.length) console.log(`notes=${JSON.stringify(res.notes)}`);
console.log(
  `declared uncompressed total=${formatBytes(res.declaredTotalBytes || 0)}`,
);
for (const entry of res.entries.slice(0, 6)) {
  const mtime = entry.mtime ? new Date(entry.mtime).toISOString() : '?';
  console.log(
    `  ${entry.dir ? 'D' : 'F'} ${entry.path} size=${entry.size} method=${entry.method} mtime=${mtime}${entry.encrypted ? ' [encrypted]' : ''}`,
  );
}
if (res.entries.length > 6) console.log(`  ... 其余 ${res.entries.length - 6} 项省略`);

// 解压上限内逐条校验；调用方给 extractDir 时与外部工具结果比对
if (extractDir) {
  const extracted = new Map();
  const walk = (dir, base) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      const rel = base ? `${base}/${item.name}` : item.name;
      if (item.isDirectory()) {
        extracted.set(`${rel}/`, null);
        walk(abs, rel);
      } else {
        extracted.set(rel, fs.readFileSync(abs));
      }
    }
  };
  walk(extractDir, '');

  let compared = 0;
  let missing = 0;
  let mismatched = 0;
  let readTruncated = 0;
  for (const entry of res.entries) {
    if (entry.dir || entry.encrypted) continue;
    // 归档可能有单一根目录（如 GitHub 的 rea-main/），而外部工具按内容解压到目标目录
    let expected = extracted.get(entry.path);
    if (expected === undefined) expected = extracted.get(entry.path.replace(/^[^/]+\//, ''));
    if (!expected) {
      missing++;
      if (missing <= 10) console.log(`  MISSING in extraction: ${entry.path}`);
      continue;
    }
    const got = await readEntry(bytes, entry);
    if (got.truncated) readTruncated++;
    const actualBuf = Buffer.from(got.bytes);
    // 超过单条目上限的条目只比前缀
    const cmpLen = Math.min(actualBuf.length, expected.length);
    if (actualBuf.length !== expected.length || !actualBuf.equals(expected.subarray(0, cmpLen))) {
      mismatched++;
      if (mismatched <= 10) console.log(`  MISMATCH: ${entry.path} (ours=${actualBuf.length}, extracted=${expected.length})`);
    }
    compared++;
  }
  if (missing > 10) console.log(`  ... 另有 ${missing - 10} 个缺失项未逐条打印`);
  console.log(
    `cross-check: compared=${compared} mismatched=${mismatched} missing=${missing} readTruncated=${readTruncated}`,
  );
  if (mismatched || missing || readTruncated) process.exitCode = 1;
}

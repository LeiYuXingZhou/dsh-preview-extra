// tests/run-tests.mjs — 压缩包解析模块的 Node 24 测试脚本（无第三方依赖）。
// 运行：node dsh-preview-extra/pkg/src/archive/tests/run-tests.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LIMITS,
  ArchiveError,
  buildTree,
  classifyContent,
  decodeTextBytes,
  detect,
  formatBytes,
  listArchive,
  readEntry,
  readEntryText,
  utf8OrLatin1,
} from '../index.js';
import { buildGzip, buildTar, buildZip } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB_FILES = ['index.js', 'zip.js', 'tar.js', 'gzip.js', 'detect.js', 'util.js', 'inflate.js'];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const readText = (bytes) => Buffer.from(bytes).toString('utf8');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

// ---------------------------------------------------------------- 静态约束

test('库代码只依赖 Web 标准 API（无 node:*、无 default export、同目录 .js import）', () => {
  for (const file of LIB_FILES) {
    const src = fs.readFileSync(path.join(here, '..', file), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `${file} 不应 import node:*`);
    assert.doesNotMatch(src, /\brequire\s*\(/, `${file} 不应使用 require()`);
    assert.doesNotMatch(src, /process\.(env|versions|platform|argv|exit)/, `${file} 不应使用 Node 专有 API`);
    assert.doesNotMatch(src, /export\s+default/, `${file} 应只用具名导出`);
    for (const match of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^\.\/[^/]+\.js$/, `${file} 的 import "${match[1]}" 必须是同目录相对 .js`);
    }
  }
});

// ---------------------------------------------------------------- detect

test('detect: zip / tar / gzip / tar.gz 魔数识别', () => {
  const zip = buildZip([{ name: 'a.txt', data: 'hi' }]);
  const zipDet = detect(zip, 'a.zip');
  assert.equal(zipDet.format, 'zip');
  assert.equal(zipDet.supported, true);
  assert.equal(zipDet.source, 'magic');

  const tar = buildTar([{ name: 'a.txt', data: 'hi' }]);
  const tarDet = detect(tar, 'a.tar');
  assert.equal(tarDet.format, 'tar');
  assert.equal(tarDet.source, 'magic');

  const gz = buildGzip('hello', { originalName: 'hello.txt' });
  assert.equal(detect(gz, 'x.gz').format, 'gzip');

  const tgz = buildGzip(tar, { originalName: 'a.tar' });
  const tgzDet = detect(tgz, 'a.tgz');
  assert.equal(tgzDet.format, 'tar.gz');
  assert.equal(tgzDet.supported, true);
});

test('detect: 7z / rar / xz / bz2 识别为不支持并给出 hint', () => {
  const cases = [
    ['7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x00])],
    ['rar', Buffer.from('Rar!\x1a\x07\x00', 'latin1')],
    ['xz', Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x00])],
    ['bz2', Buffer.from([0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26])],
  ];
  for (const [format, bytes] of cases) {
    const det = detect(bytes, `file.${format}`);
    assert.equal(det.format, format);
    assert.equal(det.supported, false);
    assert.ok(det.hint.length > 0, `${format} 应带 hint`);
  }
  const unknown = detect(Buffer.from('hello world, definitely not an archive'), 'a.bin');
  assert.equal(unknown.format, null);
  assert.equal(unknown.supported, false);
});

test('detect: 无魔数时用扩展名兜底（.zip / .tar）', () => {
  const fakeZip = detect(Buffer.from('not really a zip but named as one'), 'x.zip');
  assert.equal(fakeZip.format, 'zip');
  assert.equal(fakeZip.source, 'extension');
  const fakeTar = detect(Buffer.from('not really a tar'), 'x.tar');
  assert.equal(fakeTar.format, 'tar');
  assert.equal(fakeTar.source, 'extension');
});

// ---------------------------------------------------------------- zip

test('zip: stored 条目列举与读取（CRC 校验通过）', async () => {
  const files = [
    { name: 'hello.txt', data: 'Hello 世界\n' },
    { name: 'bin/data.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
  ];
  const zip = buildZip(files);
  const res = await listArchive(zip);
  assert.equal(res.format, 'zip');
  assert.equal(res.entries.length, 2);
  assert.equal(res.entries[0].path, 'hello.txt');
  assert.equal(res.entries[0].size, Buffer.byteLength(files[0].data));
  assert.equal(res.entries[0].method, 'stored');
  assert.equal(res.entries[0].dir, false);
  assert.ok(res.entries[0].mtime > 0);

  const r = await readEntry(zip, res.entries[0]);
  assert.equal(readText(r.bytes), files[0].data);
  assert.equal(r.truncated, false);
  assert.equal(r.crcOk, true);
  assert.equal(r.textualHint, 'text');
  assert.equal(r.mime, null);

  const r2 = await readEntry(zip, res.entries[1]);
  assert.deepEqual([...r2.bytes], [...files[1].data]);
  assert.equal(r2.textualHint, 'binary');
});

test('zip: deflate 条目解压后字节一致', async () => {
  const payload = '压缩测试 abcdefghij '.repeat(500);
  const zip = buildZip([{ name: 'big.txt', data: payload, method: 8 }]);
  const res = await listArchive(zip);
  const entry = res.entries[0];
  assert.equal(entry.method, 'deflate');
  assert.ok(entry.compressedSize < entry.size, 'deflate 应显著变小');
  const r = await readEntry(zip, entry);
  assert.equal(readText(r.bytes), payload);
  assert.equal(r.crcOk, true);
});

test('zip: 目录条目（名字以 / 结尾 + MS-DOS 目录属性）', async () => {
  const zip = buildZip([
    { name: 'docs/', data: '', dir: true, externalAttrs: 0x10 },
    { name: 'docs/a.txt', data: 'A' },
  ]);
  const res = await listArchive(zip);
  assert.equal(res.entries[0].path, 'docs');
  assert.equal(res.entries[0].dir, true);
  assert.equal(res.entries[0].size, 0);
  const r = await readEntry(zip, res.entries[0]);
  assert.equal(r.bytes.length, 0);
  assert.equal(r.textualHint, 'unknown');
});

test('zip: 文件名 UTF-8 flag / 未置位 UTF-8 / GBK 兜底', async () => {
  // 1) 置位 0x800，名字是 UTF-8
  let res = await listArchive(buildZip([{ name: '中文/说明.txt', data: 'x', utf8: true }]));
  assert.equal(res.entries[0].path, '中文/说明.txt');
  assert.equal(res.entries[0].nameEncoding, 'utf-8');

  // 2) 未置位但实际是 UTF-8（大量工具如此）
  res = await listArchive(buildZip([{ name: Buffer.from('中文.txt', 'utf8'), data: 'x', flags: 0 }]));
  assert.equal(res.entries[0].path, '中文.txt');
  assert.equal(res.entries[0].nameEncoding, 'utf-8');

  // 3) 未置位的中文 Windows GBK 文件名："测试.txt" = B2 E2 CA D4
  const gbkName = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0x2e, 0x74, 0x78, 0x74]);
  res = await listArchive(buildZip([{ name: gbkName, data: 'x', flags: 0 }]));
  assert.ok(res.entries[0].path.endsWith('.txt'));
  if (res.entries[0].nameEncoding === 'gbk') {
    assert.equal(res.entries[0].path, '测试.txt');
  } else {
    // 环境缺少 GBK 解码器时退化为 latin1，且 notes 里说明
    assert.equal(res.entries[0].nameEncoding, 'latin1');
    assert.ok(res.notes.some((n) => n.includes('UTF-8')));
  }
});

test('zip: 加密条目只标记，readEntry 抛可读 ArchiveError(ENCRYPTED)', async () => {
  const zip = buildZip([{ name: 'secret.txt', data: 'top secret', encrypt: true }]);
  const res = await listArchive(zip);
  assert.equal(res.entries[0].encrypted, true);
  await assert.rejects(
    () => readEntry(zip, res.entries[0]),
    (err) => {
      assert.ok(err instanceof ArchiveError);
      assert.equal(err.code, 'ENCRYPTED');
      assert.match(err.message, /加密/);
      return true;
    },
  );
});

test('zip: 不支持的压缩方法给出可读错误', async () => {
  const zip = buildZip([{ name: 'x.bin', data: 'abc', method: 12 }]); // 12 = bzip2
  const res = await listArchive(zip);
  assert.equal(res.entries[0].method, 'bzip2');
  await assert.rejects(() => readEntry(zip, res.entries[0]), /不支持的压缩方法/);
});

test('zip: data descriptor 场景以中央目录大小为准', async () => {
  const payload = 'data-descriptor-payload '.repeat(20);
  const zip = buildZip([{ name: 'dd.txt', data: payload, method: 8, dataDescriptor: true }]);
  const res = await listArchive(zip);
  assert.equal(res.entries[0].size, Buffer.byteLength(payload));
  const r = await readEntry(zip, res.entries[0]);
  assert.equal(readText(r.bytes), payload);
  assert.equal(r.truncated, false);
});

test('zip: ZIP64 哨兵值 + 0x0001 扩展字段', async () => {
  const payload = 'zip64-content';
  const zip = buildZip([{ name: 'z64.txt', data: payload, zip64: true }], { zip64Eocd: true });
  const res = await listArchive(zip);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].path, 'z64.txt');
  assert.equal(res.entries[0].size, payload.length);
  const r = await readEntry(zip, res.entries[0]);
  assert.equal(readText(r.bytes), payload);
});

test('空 zip: 0 条目不报错', async () => {
  const res = await listArchive(buildZip([]));
  assert.equal(res.supported, true);
  assert.equal(res.format, 'zip');
  assert.equal(res.entries.length, 0);
});

// ---------------------------------------------------------------- tar

test('tar: 目录 / 文件 / 符号链接条目，内容与 mtime 正确', async () => {
  const tar = buildTar([
    { name: 'docs', dir: true, mtime: 1700000000 },
    { name: 'docs/readme.txt', data: 'hello tar\n', mtime: 1700000001 },
    { name: 'link-to-readme', type: '2', linkname: 'docs/readme.txt' },
  ]);
  const res = await listArchive(tar);
  assert.equal(res.format, 'tar');
  assert.equal(res.entries.length, 3);

  const readme = res.entries[1];
  assert.equal(readme.path, 'docs/readme.txt');
  assert.equal(readme.size, 10);
  assert.equal(readme.mtime, 1700000001 * 1000);
  assert.equal(readme.type, 'file');
  assert.equal(readText((await readEntry(tar, readme)).bytes), 'hello tar\n');

  const link = res.entries[2];
  assert.equal(link.type, 'symlink');
  assert.equal(link.linkname, 'docs/readme.txt');
  const linkRead = await readEntry(tar, link);
  assert.equal(linkRead.bytes.length, 0);
  assert.match(linkRead.note, /链接/);

  const dir = res.entries[0];
  assert.equal(dir.dir, true);
  assert.equal((await readEntry(tar, dir)).bytes.length, 0);
});

test('tar: GNU 长名（L）与 PAX（x）路径覆盖', async () => {
  const longPath = `very/long/path/${'x'.repeat(120)}/deep.txt`;
  const tar = buildTar([{ name: longPath, data: 'L-data', longName: true }]);
  const res = await listArchive(tar);
  assert.equal(res.entries[0].path, longPath);
  assert.equal(readText((await readEntry(tar, res.entries[0])).bytes), 'L-data');

  const paxPath = `pax/${'y'.repeat(110)}/pax.txt`;
  const paxTar = buildTar([
    { name: 'placeholder.txt', data: 'P-data', pax: { path: paxPath, mtime: '1700000123.5' } },
  ]);
  const paxRes = await listArchive(paxTar);
  assert.equal(paxRes.entries[0].path, paxPath);
  assert.equal(paxRes.entries[0].mtime, 1700000123500);
  assert.equal(readText((await readEntry(paxTar, paxRes.entries[0])).bytes), 'P-data');
});

test('tar: ustar prefix 字段拼接长路径', async () => {
  const dir = 'a'.repeat(120);
  const full = `${dir}/f.txt`;
  const tar = buildTar([{ name: full, data: 'prefix-data' }]);
  const res = await listArchive(tar);
  assert.equal(res.entries[0].path, full);
  assert.equal(readText((await readEntry(tar, res.entries[0])).bytes), 'prefix-data');
});

test('tar: 归档被截断时返回 truncated + notes，不抛死', async () => {
  const tar = buildTar([
    { name: 'a.txt', data: 'A'.repeat(2000), mtime: 1700000000 },
    { name: 'b.txt', data: 'B' },
  ]);
  const cut = tar.subarray(0, 512 + 512 + 100);
  const res = await listArchive(cut);
  assert.equal(res.truncated, true);
  assert.ok(res.notes.some((n) => n.includes('截断')));
  const r = await readEntry(cut, res.entries[0]);
  assert.equal(r.truncated, true);
  assert.equal(r.bytes.length, cut.length - 512);
});

// ---------------------------------------------------------------- gzip / tar.gz

test('tar.gz: 自动解压并按 tar 列举、读取条目', async () => {
  const tar = buildTar([
    { name: 'a.txt', data: 'tgz-A' },
    { name: 'dir/b.txt', data: 'tgz-B' },
  ]);
  const gz = buildGzip(tar, { originalName: 'bundle.tar', mtime: 1700000200 });
  const res = await listArchive(gz, { filename: 'bundle.tgz' });
  assert.equal(res.format, 'tar.gz');
  assert.equal(res.entries.length, 2);
  assert.equal(res.entries[0].path, 'a.txt');
  assert.equal(readText((await readEntry(gz, res.entries[1])).bytes), 'tgz-B');
  // 二次读取走 gzip 解压缓存，结果仍一致
  assert.equal(readText((await readEntry(gz, res.entries[1])).bytes), 'tgz-B');
});

test('gzip: 单文件（原始名 / mtime / 内容）', async () => {
  const gz = buildGzip('single file content', { originalName: 'notes.txt', mtime: 1700000300 });
  const res = await listArchive(gz, { filename: 'notes.txt.gz' });
  assert.equal(res.format, 'gzip');
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].path, 'notes.txt');
  assert.equal(res.entries[0].mtime, 1700000300 * 1000);
  assert.equal(res.entries[0].method, 'gzip');
  const r = await readEntry(gz, res.entries[0]);
  assert.equal(readText(r.bytes), 'single file content');
});

// ---------------------------------------------------------------- 限制 / 安全

test('限制: 条目数上限 maxEntries', async () => {
  const zip = buildZip([
    { name: 'a.txt', data: '0' },
    { name: 'b.txt', data: '1' },
    { name: 'c.txt', data: '2' },
  ]);
  const res = await listArchive(zip, { maxEntries: 2 });
  assert.equal(res.entries.length, 2);
  assert.equal(res.truncated, true);
  assert.ok(res.notes.some((n) => n.includes('上限')));
});

test('限制: 单条目解压上限 maxEntryBytes（返回截断而非抛错）', async () => {
  const payload = '0123456789'.repeat(10); // 100 字节
  const zip = buildZip([{ name: 'big.txt', data: payload, method: 8 }]);
  const res = await listArchive(zip, { maxEntryBytes: 10 });
  const r = await readEntry(zip, res.entries[0], { maxEntryBytes: 10 });
  assert.equal(r.bytes.length, 10);
  assert.equal(r.truncated, true);
  assert.match(r.note, /截断/);
});

test('限制: 累计解压上限 maxTotalBytes', async () => {
  const zip = buildZip([
    { name: 'a.txt', data: 'a'.repeat(60) },
    { name: 'b.txt', data: 'b'.repeat(60) },
  ]);
  const res = await listArchive(zip, { maxTotalBytes: 100 });

  const r1 = await readEntry(zip, res.entries[0], { maxTotalBytes: 100 });
  assert.equal(r1.bytes.length, 60);
  assert.equal(r1.truncated, false);

  const r2 = await readEntry(zip, res.entries[1], { maxTotalBytes: 100 });
  assert.equal(r2.bytes.length, 40);
  assert.equal(r2.truncated, true);
  assert.match(r2.note, /截断/);
});

test('不支持的格式：listArchive 返回 supported:false + hint，不抛错', async () => {
  const sevenZip = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x00]);
  const res = await listArchive(sevenZip, { filename: 'x.7z' });
  assert.equal(res.supported, false);
  assert.equal(res.format, '7z');
  assert.equal(res.entries.length, 0);
  assert.ok(res.notes[0].includes('7z'));
});

test('损坏的 zip：抛可读 ArchiveError(BAD_ZIP) 而不是崩溃', async () => {
  const bogus = Buffer.from('this is definitely not a zip file, just some padding bytes here');
  await assert.rejects(
    () => listArchive(bogus, { filename: 'broken.zip' }),
    (err) => {
      assert.ok(err instanceof ArchiveError);
      assert.equal(err.code, 'BAD_ZIP');
      assert.match(err.message, /ZIP/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- UI 辅助

test('buildTree: 嵌套树结构 + 目录优先排序', async () => {
  const zip = buildZip([
    { name: 'b.txt', data: 'b' },
    { name: 'a/z.txt', data: 'z' },
    { name: 'a/c.txt', data: 'c' },
    { name: 'a/', data: '', dir: true, externalAttrs: 0x10 },
  ]);
  const res = await listArchive(zip);
  const tree = buildTree(res.entries);
  assert.equal(tree.dir, true);
  assert.deepEqual(
    tree.children.map((n) => n.name),
    ['a', 'b.txt'],
  );
  const a = tree.children[0];
  assert.equal(a.dir, true);
  assert.deepEqual(
    a.children.map((n) => n.name),
    ['c.txt', 'z.txt'],
  );
  assert.equal(a.children[0].entry.path, 'a/c.txt');
});

test('readEntryText: UTF-8 文本解码 + 图片判定', async () => {
  const text = '第一行\nsecond line\n';
  const zip = buildZip([
    { name: 'note.md', data: text },
    { name: 'img.png', data: PNG_BYTES },
  ]);
  const res = await listArchive(zip);

  const t = await readEntryText(zip, res.entries[0]);
  assert.equal(t.text, text);
  assert.equal(t.encoding, 'utf-8');
  assert.equal(t.looksBinary, false);

  const img = await readEntryText(zip, res.entries[1]);
  assert.equal(img.looksBinary, true);
  assert.equal(img.textualHint, 'image');
  assert.equal(img.mime, 'image/png');
});

test('utf8OrLatin1 / formatBytes / classifyContent 辅助函数', () => {
  assert.equal(utf8OrLatin1(Buffer.from('中文', 'utf8')), '中文');
  assert.equal(utf8OrLatin1(Buffer.from([0x41, 0xff, 0x42])), 'A\u00ffB');

  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(NaN), '未知');

  assert.equal(classifyContent(Buffer.from('plain text')).kind, 'text');
  assert.equal(classifyContent(PNG_BYTES).kind, 'image');
  assert.equal(classifyContent(Buffer.from([0, 1, 2, 3])).kind, 'binary');
  assert.equal(classifyContent(new Uint8Array(0)).kind, 'empty');
});

test('decodeTextBytes: GBK 字节兜底解码', () => {
  // "测试" 的 GBK 编码
  const gbk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);
  const decoded = decodeTextBytes(gbk);
  if (decoded.encoding === 'gbk') assert.equal(decoded.text, '测试');
  else assert.equal(decoded.encoding, 'latin1');
});

// ---------------------------------------------------------------- 运行

console.log(`archive module tests — Node ${process.version}`);
console.log(`limits: maxEntries=${DEFAULT_LIMITS.maxEntries}, maxEntryBytes=${formatBytes(DEFAULT_LIMITS.maxEntryBytes)}, maxTotalBytes=${formatBytes(DEFAULT_LIMITS.maxTotalBytes)}\n`);

let passed = 0;
const failures = [];
for (const item of tests) {
  try {
    await item.fn();
    passed++;
    console.log(`  ok   ${item.name}`);
  } catch (err) {
    failures.push({ name: item.name, err });
    console.log(`  FAIL ${item.name}`);
    console.log(`       ${err && err.message ? err.message : err}`);
  }
}

console.log(`\n${passed}/${tests.length} passed`);
if (failures.length > 0) {
  console.log('\nfailure details:');
  for (const failure of failures) {
    console.log(`\n--- ${failure.name}\n${failure.err && failure.err.stack ? failure.err.stack : failure.err}`);
  }
  process.exitCode = 1;
}

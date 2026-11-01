// Generate preview fixtures under _fixtures/ for the dsh-preview-extra E2E run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.resolve(process.argv[2] ?? '_fixtures');
fs.mkdirSync(out, { recursive: true });
const put = (name, data) => {
  const p = path.join(out, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  console.log(name, Buffer.isBuffer(data) || data instanceof Uint8Array ? data.length + ' B' : String(data).length + ' chars');
};

// ---------- STL (ASCII + binary) ----------
const tris = [
  // a unit cube (12 triangles), same as many STL demos
  [[0,0,0],[0,1,0],[1,0,0]], [[0,1,0],[1,1,0],[1,0,0]],
  [[0,0,0],[1,0,0],[0,0,1]], [[1,0,0],[1,0,1],[0,0,1]],
  [[0,0,0],[0,0,1],[0,1,0]], [[0,0,1],[0,1,1],[0,1,0]],
  [[1,0,0],[1,1,0],[1,1,1]], [[1,0,0],[1,1,1],[1,0,1]],
  [[0,1,0],[0,1,1],[1,1,1]], [[0,1,0],[1,1,1],[1,1,0]],
  [[0,0,1],[1,0,1],[1,1,1]], [[0,0,1],[1,1,1],[0,1,1]],
];
const ascii = ['solid cube'];
for (const [a,b,c] of tris) {
  ascii.push('  facet normal 0 0 0', '    outer loop');
  for (const v of [a,b,c]) ascii.push(`      vertex ${v.join(' ')}`);
  ascii.push('    endloop', '  endfacet');
}
ascii.push('endsolid cube');
put('cube.stl', ascii.join('\n') + '\n');

const header = Buffer.alloc(80);
header.write('dsh-preview-extra binary STL fixture', 0, 'ascii');
const count = Buffer.alloc(4);
count.writeUInt32LE(tris.length, 0);
const binParts = [header, count];
for (const [a,b,c] of tris) {
  const rec = Buffer.alloc(50);
  rec.writeFloatLE(0,0); rec.writeFloatLE(0,4); rec.writeFloatLE(0,8);
  let o = 12;
  for (const v of [a,b,c]) { for (const n of v) { rec.writeFloatLE(n, o); o += 4; } }
  rec.writeUInt16LE(0, 48);
  binParts.push(rec);
}
put('cube-binary.stl', Buffer.concat(binParts));

// ---------- OBJ ----------
const obj = ['# dsh fixture', 'o cube'];
const verts = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
for (const v of verts) obj.push(`v ${v.join(' ')}`);
obj.push('vn 0 0 1');
for (const f of [[1,2,3,4],[5,8,7,6],[1,5,6,2],[2,6,7,3],[3,7,8,4],[5,1,4,8]]) obj.push('f ' + f.join(' '));
put('cube.obj', obj.join('\n') + '\n');

// ---------- PLY (ascii) ----------
const plyFaces = [[0,1,2],[0,2,3],[4,5,6],[4,6,7]];
const ply = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z',
  'element face 4', 'property list uchar int vertex_indices', 'end_header'];
for (const v of verts) ply.push(v.join(' '));
for (const f of plyFaces) ply.push('3 ' + f.join(' '));
put('quad.ply', ply.join('\n') + '\n');

// ---------- ZIP ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(data);
    const crc = crc32(raw);
    const comp = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(0, 14);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, nameBuf, comp]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(localFull);
    offset += localFull.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const zip = makeZip([
  { name: 'readme.txt', data: 'dsh-preview-extra archive fixture\n第二行：中文内容用于检查 UTF-8 文件名与文本解码。\n', deflate: true },
  { name: 'src/main.cpp', data: '#include <iostream>\nint main(){ std::cout << "hello"; }\n', deflate: false },
  { name: 'nested/bin.dat', data: Buffer.from(Array.from({ length: 256 }, (_, i) => i)), deflate: true },
]);
put('sample.zip', zip);

// ---------- TAR + TAR.GZ ----------
function makeTar(entries) {
  const chunks = [];
  for (const { name, data, dir } of entries) {
    const raw = dir ? Buffer.alloc(0) : Buffer.from(data);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write((dir ? '5' : '0'), 156, 1, 'ascii');
    h.write('0000644\0', 100, 8, 'ascii');
    h.write(raw.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write('ustar\0' + '00', 257, 8, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(h, raw);
    const pad = (512 - (raw.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
const tar = makeTar([
  { name: 'docs/', dir: true },
  { name: 'docs/notes.md', data: '# tar fixture\n- one\n- two\n' },
  { name: 'main.cpp', data: 'int main(){return 0;}\n' },
]);
put('sample.tar', tar);
put('sample.tar.gz', zlib.gzipSync(tar));
put('readme.txt.gz', zlib.gzipSync(Buffer.from('single-file gzip fixture\n中文内容\n')));

// ---------- 7z / rar magic-only (unsupported panel) ----------
put('fake.7z', Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0, 4, 1, 2, 3, 4]));
put('fake.rar', Buffer.concat([Buffer.from('Rar!\x1A\x07\x00', 'latin1'), Buffer.alloc(64, 1)]));

// ---------- WAV ----------
function makeWav(seconds = 1.5, freq = 440) {
  const rate = 44100;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
put('tone.wav', makeWav());

// ---------- subtitles ----------
put('demo.srt', `1\n00:00:00,000 --> 00:00:02,500\n你好，这是 SRT 字幕示例。\n\n2\n00:00:02,500 --> 00:00:05,000\nSecond cue, with a line above.\n`);
put('demo.vtt', `WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello from WebVTT\n\n00:00:02.500 --> 00:00:05.000\n第二段\n`);
put('demo.ass', `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour\nStyle: Default,Arial,20,&H00FFFFFF\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:02.50,Default,你好 ASS\n`);

// ---------- font: copy a system font ----------
for (const candidate of ['C:\\Windows\\Fonts\\consola.ttf', 'C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\segoeui.ttf']) {
  if (fs.existsSync(candidate)) {
    fs.copyFileSync(candidate, path.join(out, 'sample.ttf'));
    console.log('sample.ttf copied from', candidate, fs.statSync(candidate).size + ' B');
    break;
  }
}

// image inside a workspace for archive-context sanity
put('notes.md', '# fixture workspace\n用于在 Files 面板里点开各种测试文件。\n');
console.log('done ->', out);

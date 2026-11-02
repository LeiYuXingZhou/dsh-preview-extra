// formats/tests/run.mjs — TOML / Intel HEX / glTF / JCAMP-DX / VCD / KiCad / DFU
// 运行：node src/formats/tests/run.mjs

import { parseToml } from '../toml.js';
import { parseIntelHex } from '../ihex.js';
import { parseGltfMesh } from '../gltf.js';
import { parseModel } from '../../model/detect3d.js';
import { decodeLine, parseJcamp } from '../jcamp.js';
import { parseVcd } from '../vcd.js';
import { footprintPoint, parseKicad, symbolToSheet } from '../kicad.js';
import { crc32, parseDfu } from '../dfu.js';

let passed = 0;
let failed = 0;

function fail(message) {
  throw new Error(message);
}
function ok(cond, message) {
  if (!cond) fail(message || 'assertion failed');
}
function eq(actual, expected, message) {
  if (!Object.is(actual, expected)) fail(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function close(actual, expected, eps, message) {
  if (!(Math.abs(actual - expected) <= eps)) fail(`${message}：期望 ${expected} ± ${eps}，实际 ${actual}`);
}
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err && err.message ? err.message : err}`);
  }
}

function row(doc, header, key) {
  const section = doc.sections.find((item) => item.header === header);
  if (!section) return null;
  return section.rows.find((item) => item.key === key) || null;
}

test('TOML：标量、数组、内联表、点分键和表', () => {
  const doc = parseToml(`
# comment
title = "say \\"hi\\""
count = 1_000
hex = 0x10
flag = true
when = 1979-05-27T07:32:00Z
items = [1, 2, { name = "a" }]
server.port = 8080

[database]
host = 'localhost'

[[fruit]]
name = "apple"

[[fruit]]
name = "pear"
`);
  ok(doc.ok, doc.error);
  eq(row(doc, '', 'title').text, '"say \\"hi\\""', 'string');
  eq(row(doc, '', 'count').text, '1_000', 'int');
  eq(row(doc, '', 'hex').type, 'integer', 'hex type');
  eq(row(doc, '', 'flag').text, 'true', 'bool');
  eq(row(doc, '', 'when').type, 'datetime', 'datetime');
  eq(row(doc, '', 'items').type, 'array', 'array');
  eq(row(doc, 'server', 'port').text, '8080', 'dotted key');
  eq(row(doc, 'database', 'host').text, '"localhost"', 'literal string displayed as json');
  eq(row(doc, 'fruit[0]', 'name').text, '"apple"', 'aot 0');
  eq(row(doc, 'fruit[1]', 'name').text, '"pear"', 'aot 1');
  eq(doc.counts.keys, 10, 'key count');
});

test('TOML：重复键和非法文件给出行号', () => {
  const dup = parseToml('a = 1\na = 2\n');
  ok(!dup.ok, 'duplicate should fail');
  ok(dup.error.includes('第 2 行'), dup.error);
  const bad = parseToml('not toml at all');
  ok(!bad.ok, 'bare word should fail');
});

test('Intel HEX：线性地址、数据合并、入口和 checksum', () => {
  const doc = parseIntelHex(`
:020000040001F9
:0400000001020304F2
:040002000A0B0C0DCC
:0400000500004000B7
:00000001FF
`);
  ok(doc.ok, doc.error);
  eq(doc.eof, true, 'eof');
  eq(doc.entry.kind, 'linear', 'entry kind');
  eq(doc.entry.address, 0x4000, 'entry address');
  eq(doc.ranges.length, 1, 'one range');
  eq(doc.ranges[0].address, 0x10000, 'base');
  eq(doc.dataBytes, 8, 'two data records');
  const data = doc.ranges[0].data;
  eq(data[0], 0x01, 'first byte kept');
  eq(data[2], 0x0a, 'overlap overwritten');
  eq(data[5], 0x0d, 'extended byte');
  eq(data.length, 6, 'merged length');
});

test('Intel HEX：坏 checksum 被记下来，空文件失败', () => {
  const bad = parseIntelHex(':00000001FE\n:00000001FF\n');
  ok(bad.ok, bad.error);
  eq(bad.errors.length, 1, 'one bad record');
  eq(bad.eof, true, 'good eof still seen');
  const none = parseIntelHex('hello');
  ok(!none.ok, 'not hex');
});

function triangleGlb({ translation = null } = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const bin = new Uint8Array(42);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), 36);
  const node = { mesh: 0 };
  if (translation) node.translation = translation;
  const json = {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [node],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 42 }],
  };
  return packGlb(json, bin);
}

function packGlb(jsonObj, bin) {
  const json = new TextEncoder().encode(JSON.stringify(jsonObj));
  const jsonPad = (4 - (json.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + json.length + jsonPad + 8 + bin.length + binPad;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = 12;
  view.setUint32(offset, json.length + jsonPad, true);
  view.setUint32(offset + 4, 0x4e4f534a, true);
  out.set(json, offset + 8);
  out.fill(0x20, offset + 8 + json.length, offset + 8 + json.length + jsonPad);
  offset += 8 + json.length + jsonPad;
  view.setUint32(offset, bin.length + binPad, true);
  view.setUint32(offset + 4, 0x004e4942, true);
  out.set(bin, offset + 8);
  return out;
}

test('glTF：GLB 三角形和节点平移', () => {
  const mesh = parseGltfMesh(triangleGlb({ translation: [10, 0, 0] }));
  eq(mesh.format, 'glb', 'format');
  eq(mesh.triangleCount, 1, 'one triangle');
  close(mesh.positions[0], 10, 1e-5, 'translated x');
  close(mesh.positions[3], 11, 1e-5, 'translated x2');
  close(mesh.positions[7], 1, 1e-5, 'y');
  const wrapped = parseModel('piece.glb', triangleGlb());
  eq(wrapped.format, 'glb', 'parseModel format');
  eq(wrapped.counts.triangles, 1, 'parseModel triangles');
  ok(!wrapped.error, wrapped.error || 'no error');
});

test('glTF：data URI 和三角形带', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const bin = new Uint8Array(positions.buffer);
  let binary = '';
  for (let i = 0; i < bin.length; i++) binary += String.fromCharCode(bin[i]);
  const uri = `data:application/octet-stream;base64,${btoa(binary)}`;
  const json = JSON.stringify({
    asset: { version: '2.0' },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ uri, byteLength: bin.length }],
  });
  const mesh = parseGltfMesh(new TextEncoder().encode(json));
  eq(mesh.format, 'gltf', 'json gltf');
  eq(mesh.triangleCount, 2, 'strip makes 2 triangles');
});

test('glTF：坏 GLB 和外部 buffer 有可读错误', () => {
  let message = '';
  try {
    parseGltfMesh(new Uint8Array(64));
  } catch (err) {
    message = err.message;
  }
  ok(message.includes('GLB'), message);
  const json = JSON.stringify({
    asset: { version: '2.0' },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ uri: 'mesh.bin', byteLength: 36 }],
  });
  try {
    parseGltfMesh(new TextEncoder().encode(json));
    fail('external buffer should throw');
  } catch (err) {
    ok(String(err.message).includes('外部'), err.message);
  }
});

test('JCAMP-DX：XYDATA 与 PAC', () => {
  const doc = parseJcamp(`##TITLE=Demo
##JCAMP-DX=5.00
##DATA TYPE=INFRARED SPECTRUM
##XUNITS=1/CM
##YUNITS=TRANSMITTANCE
##XFACTOR=1.0
##YFACTOR=1.0
##FIRSTX=400
##LASTX=402
##DELTAX=1
##NPOINTS=3
##XYDATA=(X++(Y..Y))
400 10 20 30
##END=
`);
  ok(doc.ok, doc.error);
  eq(doc.title, 'Demo', 'title');
  eq(doc.xUnits, '1/CM', 'x units');
  eq(doc.total, 3, 'points');
  close(doc.x[0], 400, 1e-9, 'x0');
  close(doc.y[1], 20, 1e-9, 'y1');
  close(doc.x[2], 402, 1e-9, 'x2');
  const pac = decodeLine('400 AJ');
  eq(pac[0], 400, 'pac x');
  eq(pac[1], 1, 'sqz A');
  eq(pac[2], 2, 'dif J');
});

test('JCAMP-DX：峰表和非法文件', () => {
  const peaks = parseJcamp(`##TITLE=Peaks
##PEAK TABLE=(XY..XY)
10 1 20 2
##END=
`);
  ok(peaks.ok, peaks.error);
  eq(peaks.total, 2, 'two peaks');
  close(peaks.x[1], 20, 1e-9, 'peak x');
  const bad = parseJcamp('just text');
  ok(!bad.ok, 'not jcamp');
});

test('VCD：时间刻度、总线和跳变', () => {
  const doc = parseVcd(`$timescale 1 ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 4 " data [3:0] $end
$upscope $end
$enddefinitions $end
$dumpvars
0!
b0000 "
$end
#10
1!
#20
b1010 "
`);
  ok(doc.ok, doc.error);
  eq(doc.timescale.text, '1 ns', 'timescale');
  eq(doc.signals.length, 2, 'two signals');
  eq(doc.signals[0].scope, 'top', 'scope');
  eq(doc.signals[0].changes.map((item) => item.v).join(','), '0,1', 'clk');
  eq(doc.signals[1].changes[1].v, 'b1010', 'bus');
  eq(doc.signals[1].changes[1].t, 20, 'bus time');
  eq(doc.endTime, 20, 'end');
  ok(!parseVcd('nope').ok, 'not vcd');
});

const SCH = `(kicad_sch
  (version 20231120)
  (paper "A4")
  (title_block (title "Demo"))
  (lib_symbols
    (symbol "Device:R"
      (symbol "Device:R_0_1"
        (rectangle (start -1 -2) (end 1 2))
        (pin passive line (at 0 3 90) (length 1)
          (name "1" (effects (font (size 1 1))))
          (number "1" (effects (font (size 1 1))))
        )
      )
    )
  )
  (wire (pts (xy 10 7) (xy 10 10)))
  (symbol
    (lib_id "Device:R")
    (at 10 10 0)
    (unit 1)
    (property "Reference" "R1" (at 12 10 0))
    (property "Value" "10k" (at 12 8 0))
  )
)`;

test('KiCad 原理图：符号针脚变换后和导线相接', () => {
  const pin = symbolToSheet(0, 3, { x: 10, y: 10, rot: 0 }, '');
  close(pin[0], 10, 1e-9, 'pin x');
  close(pin[1], 7, 1e-9, 'pin y');
  const doc = parseKicad(SCH);
  ok(doc.ok, doc.error);
  eq(doc.kind, 'sch', 'kind');
  eq(doc.title, 'Demo', 'title');
  eq(doc.stats.symbols, 1, 'one symbol');
  const wire = doc.primitives.find((item) => item.type === 'line' && item.x1 === 10 && item.y1 === 7 && item.x2 === 10 && item.y2 === 10);
  ok(wire, 'wire kept');
  const pinLine = doc.primitives.find((item) => item.color === '#7dcea0');
  ok(pinLine, 'pin drawn');
  close(pinLine.x2, 10, 1e-6, 'pin end x');
  close(pinLine.y2, 7, 1e-6, 'pin end y');
  const ref = doc.primitives.find((item) => item.type === 'text' && item.text === 'R1');
  ok(ref, 'reference');
  eq(ref.x, 12, 'reference stays in sheet space');
});

test('KiCad 电路板：走线、过孔、焊盘和背面镜像', () => {
  const doc = parseKicad(`(kicad_pcb
  (version 20240108)
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1))
  (via (at 10 0) (size 0.8) (drill 0.4))
  (footprint "R" (layer "F.Cu") (at 5 5 90)
    (pad "1" smd rect (at 1 0) (size 0.5 0.6))
    (fp_line (start -1 -0.5) (end 1 -0.5) (layer "F.SilkS"))
  )
  (footprint "R" (layer "B.Cu") (at 0 0 0)
    (pad "1" smd rect (at 1 0) (size 0.4 0.4))
  )
  (gr_line (start 0 0) (end 0 20) (layer "Edge.Cuts"))
)`);
  ok(doc.ok, doc.error);
  eq(doc.kind, 'pcb', 'kind');
  eq(doc.yDown, false, 'pcb y up');
  eq(doc.stats.tracks, 1, 'track');
  eq(doc.stats.vias, 1, 'via');
  eq(doc.stats.pads, 2, 'pads');
  const rotated = footprintPoint(1, 0, { x: 5, y: 5, rot: Math.PI / 2, back: false });
  close(rotated[0], 5, 1e-6, 'rot x');
  close(rotated[1], 6, 1e-6, 'rot y');
  const mirrored = footprintPoint(1, 0, { x: 0, y: 0, rot: 0, back: true });
  close(mirrored[0], -1, 1e-6, 'mirror x');
  const silk = doc.primitives.find((item) => item.color === '#d8c15a' && item.type === 'line');
  ok(silk, 'silk line');
  ok(!parseKicad('(kicad_sch').ok, 'truncated sexpr fails');
});

function buildDfu() {
  const payload = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
  const body = new Uint8Array(payload.length + 12);
  body.set(payload, 0);
  const view = new DataView(body.buffer);
  view.setUint16(payload.length, 0x0100, true);
  view.setUint16(payload.length + 2, 0x1234, true);
  view.setUint16(payload.length + 4, 0xabcd, true);
  view.setUint16(payload.length + 6, 0x011a, true);
  body[payload.length + 8] = 0x55;
  body[payload.length + 9] = 0x46;
  body[payload.length + 10] = 0x44;
  body[payload.length + 11] = 16;
  const crc = crc32(body);
  const file = new Uint8Array(body.length + 4);
  file.set(body, 0);
  new DataView(file.buffer).setUint32(body.length, crc, true);
  return file;
}

test('DFU：后缀、CRC 和 DfuSe 元素地址', () => {
  const plain = parseDfu(buildDfu());
  ok(plain.ok, plain.error);
  eq(plain.vendor, '0xABCD', 'vendor');
  eq(plain.product, '0x1234', 'product');
  eq(plain.bcdDfu, '1.1a', 'bcd dfu');
  eq(plain.crcOk, true, 'crc');
  eq(plain.dfuse, false, 'not dfuse');
  eq(plain.targets[0].elements[0].size, 4, 'payload');
  eq(plain.targets[0].elements[0].preview[0], 0x10, 'first byte');

  const element = Uint8Array.from([1, 2, 3, 4]);
  const targetHeader = 274;
  const prefix = 11;
  const suffix = 16;
  const total = prefix + targetHeader + 8 + element.length + suffix;
  const file = new Uint8Array(total);
  const view = new DataView(file.buffer);
  file.set(new TextEncoder().encode('DfuSe'), 0);
  file[5] = 1;
  view.setUint32(6, total, true);
  file[10] = 1;
  file.set(new TextEncoder().encode('Target'), prefix);
  file[prefix + 6] = 2;
  view.setUint32(prefix + 7, 1, true);
  file.set(new TextEncoder().encode('App'), prefix + 11);
  view.setUint32(prefix + 266, element.length, true);
  view.setUint32(prefix + 270, 1, true);
  let cursor = prefix + targetHeader;
  view.setUint32(cursor, 0x08000000, true);
  view.setUint32(cursor + 4, element.length, true);
  file.set(element, cursor + 8);
  const suffixAt = total - 16;
  view.setUint16(suffixAt + 2, 0x0001, true);
  view.setUint16(suffixAt + 4, 0x0483, true);
  view.setUint16(suffixAt + 6, 0x011a, true);
  file[suffixAt + 8] = 0x55;
  file[suffixAt + 9] = 0x46;
  file[suffixAt + 10] = 0x44;
  file[suffixAt + 11] = 16;
  view.setUint32(total - 4, crc32(file.subarray(0, total - 4)), true);
  const dfuse = parseDfu(file);
  ok(dfuse.ok, dfuse.error);
  eq(dfuse.dfuse, true, 'dfuse');
  eq(dfuse.vendor, '0x0483', 'st vendor');
  eq(dfuse.targets[0].name, 'App', 'target name');
  eq(dfuse.targets[0].alt, 2, 'alt');
  eq(dfuse.targets[0].elements[0].address, 0x08000000, 'address');
  eq(dfuse.crcOk, true, 'dfuse crc');
  ok(!parseDfu(new Uint8Array(20)).ok, 'no signature');
});

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);

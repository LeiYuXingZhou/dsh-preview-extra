// tests/fixtures.js — 手工生成最小 STL / OBJ / PLY fixture（只依赖 Web 标准 TextEncoder）。
// 所有 fixture 的期望值都在这里导出，测试只做断言，避免测试与实现"互相抄"。

export const TETRA_VERTS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// 4 个面，全部为外法线（CCW）
export const TETRA_TRIS = [
  [[0, 0, 0], [0, 1, 0], [1, 0, 0]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
];
export const TETRA_BOUNDS = { min: [0, 0, 0], max: [1, 1, 1] };
export const TETRA_TRIANGLES = 4;

//
// ---------- STL ----------
//

const fmt = (n) => {
  const s = Number(n.toFixed(6));
  return String(s);
};

function triNormal(t) {
  const [a, b, c] = t;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** 生成 ASCII STL 字节。 */
export function makeAsciiSTL(tris = TETRA_TRIS, name = 'tetra') {
  const lines = [`solid ${name}`];
  for (const t of tris) {
    const n = triNormal(t);
    lines.push(`  facet normal ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`);
    lines.push('    outer loop');
    for (const v of t) lines.push(`      vertex ${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

/** 生成二进制 STL 字节；opts.declaredCount 可故意写错用于容错测试。 */
export function makeBinarySTL(tris = TETRA_TRIS, opts = {}) {
  const header = opts.header ?? 'binary stl fixture';
  const declared = opts.declaredCount ?? tris.length;
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  for (let i = 0; i < Math.min(header.length, 80); i++) u8[i] = header.charCodeAt(i) & 0x7f;
  dv.setUint32(80, declared, true);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const o = 84 + i * 50;
    const n = triNormal(t);
    dv.setFloat32(o, n[0], true);
    dv.setFloat32(o + 4, n[1], true);
    dv.setFloat32(o + 8, n[2], true);
    for (let k = 0; k < 3; k++) {
      dv.setFloat32(o + 12 + k * 12, t[k][0], true);
      dv.setFloat32(o + 16 + k * 12, t[k][1], true);
      dv.setFloat32(o + 20 + k * 12, t[k][2], true);
    }
    dv.setUint16(o + 48, 0, true); // attribute byte count
  }
  return u8;
}

//
// ---------- OBJ ----------
//

const CUBE_VERTS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

/**
 * 立方体 OBJ：8 顶点 / 6 个四边形面（12 三角形）。
 * 面写法覆盖：v、v/vt、v//vn、v/vt/vn、负索引。
 */
export const OBJ_CUBE = {
  vertices: 8,
  faces: 6,
  triangles: 12,
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  text: [
    '# obj fixture: cube',
    'mtllib cube.mtl',
    'o Cube',
    'g top',
    ...CUBE_VERTS.map((v) => `v ${v[0]} ${v[1]} ${v[2]}`),
    'vt 0 0',
    'vt 1 0',
    'vt 1 1',
    'vt 0 1',
    'vn 0 0 1',
    'vn 0 1 0',
    'usemtl none',
    'f 1 4 3 2',                 // bottom z=0（外法线 -Z）
    'f 5/1 6/2 7/3 8/4',         // top z=1
    'f 1//1 2//1 6//1 5//1',     // front y=0
    'f 4/1/1 8/2/1 7/3/1 3/4/1', // back y=1
    'f -8 -4 -1 -5',             // left x=0（负索引 = 1,5,8,4）
    'f 2 3 7 6',                 // right x=1
    's off',
    '',
  ].join('\n'),
};

export function makeOBJ() {
  return new TextEncoder().encode(OBJ_CUBE.text);
}

/** 纯 n-gon（五边形）OBJ：5 顶点 → 3 个三角形。 */
export const OBJ_PENTAGON = {
  vertices: 5,
  triangles: 3,
  bounds: { min: [0, 0, 0], max: [1, 1, 0] },
};

export function makeOBJPentagon() {
  const text = [
    'v 0 0 0',
    'v 1 0 0',
    'v 1 1 0',
    'v 0 1 0',
    'v 0.5 0.5 0',
    'f 1 2 3 4 5',
    '',
  ].join('\n');
  return new TextEncoder().encode(text);
}

//
// ---------- PLY ----------
//

export const PLY_VERTS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0.5, 0.5, 1],
];
// 1 个四边形底面（→2 三角形）+ 4 个侧面三角形 = 6 三角形
export const PLY_FACES = [
  [0, 3, 2, 1],
  [0, 1, 4],
  [1, 2, 4],
  [2, 3, 4],
  [3, 0, 4],
];
export const PLY_EXPECTED = {
  vertices: 5,
  triangles: 6,
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
};

const PLY_EDGES = [
  [0, 1],
  [1, 2],
  [2, 3],
];

const PLY_HEADER_LINES = [
  'ply',
  'comment fixture: square pyramid',
  'element vertex 5',
  'property float x',
  'property float y',
  'property float z',
  'property uchar red',            // 额外标量属性，验证解析器跳过
  'element face 5',
  'property list uchar int vertex_indices',
  'element edge 3',                // 未知 element，验证解析器跳过
  'property int vertex1',
  'property int vertex2',
];

/** 生成 ASCII PLY 字节。 */
export function makeAsciiPLY() {
  const lines = [...PLY_HEADER_LINES.slice(0, 1), 'format ascii 1.0', ...PLY_HEADER_LINES.slice(1), 'end_header'];
  /** @type {string[]} */
  const body = [];
  for (const v of PLY_VERTS) body.push(`${v[0]} ${v[1]} ${v[2]} 128`);
  for (const f of PLY_FACES) body.push(`${f.length} ${f.join(' ')}`);
  for (const e of PLY_EDGES) body.push(`${e[0]} ${e[1]}`);
  return new TextEncoder().encode(lines.join('\n') + '\n' + body.join('\n') + '\n');
}

/** 生成 binary_little_endian PLY 字节。 */
export function makeBinaryPLY() {
  const header = [
    ...PLY_HEADER_LINES.slice(0, 1),
    'format binary_little_endian 1.0',
    ...PLY_HEADER_LINES.slice(1),
    'end_header',
  ].join('\n') + '\n';
  const headerBytes = new TextEncoder().encode(header);
  const vertexSize = 3 * 4 + 1; // float x3 + uchar
  const faceSize = PLY_FACES.reduce((sum, f) => sum + 1 + f.length * 4, 0);
  const edgeSize = PLY_EDGES.length * 8;
  const body = new ArrayBuffer(PLY_VERTS.length * vertexSize + faceSize + edgeSize);
  const dv = new DataView(body);
  let o = 0;
  for (const v of PLY_VERTS) {
    dv.setFloat32(o, v[0], true); o += 4;
    dv.setFloat32(o, v[1], true); o += 4;
    dv.setFloat32(o, v[2], true); o += 4;
    dv.setUint8(o, 128); o += 1;
  }
  for (const f of PLY_FACES) {
    dv.setUint8(o, f.length); o += 1;
    for (const id of f) { dv.setInt32(o, id, true); o += 4; }
  }
  for (const e of PLY_EDGES) {
    dv.setInt32(o, e[0], true); o += 4;
    dv.setInt32(o, e[1], true); o += 4;
  }
  const out = new Uint8Array(headerBytes.length + body.byteLength);
  out.set(headerBytes, 0);
  out.set(new Uint8Array(body), headerBytes.length);
  return out;
}

/** 大端 PLY（仅 header，用于断言"不支持"的可读错误）。 */
export function makeBigEndianPLYHeader() {
  const text = [
    'ply',
    'format binary_big_endian 1.0',
    'element vertex 1',
    'property float x',
    'property float y',
    'property float z',
    'element face 1',
    'property list uchar int vertex_indices',
    'end_header',
    '',
  ].join('\n');
  return new TextEncoder().encode(text);
}

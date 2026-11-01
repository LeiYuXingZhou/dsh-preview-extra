// obj.js — Wavefront OBJ 解析（无依赖）。
// 支持 v / vn / vt / f，f 的 v、v/vt、v//vn、v/vt/vn 四种写法，负索引，n-gon 扇形三角化。
// 忽略 mtllib / usemtl / o / g / s / l / p 等语句；多 object/group 合并输出。
import { decodeText, finishMesh, toUint8 } from './common.js';

/** 解析 OBJ 顶点索引；token 可能是 "3"、"-1"、"3/4"、"3//5"、"3/4/5"。 */
function parseVertexIndex(token, vertexCount, lineNo, what = '顶点') {
  const raw = token.split('/')[0];
  if (!raw) throw new Error(`OBJ 解析失败：第 ${lineNo} 行出现空的${what}索引（"${token}"）`);
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new Error(`OBJ 解析失败：第 ${lineNo} 行的${what}索引 "${raw}" 不是整数`);
  }
  const value = Number.parseInt(raw, 10);
  if (value === 0) throw new Error(`OBJ 解析失败：第 ${lineNo} 行的${what}索引不能为 0（OBJ 索引从 1 开始）`);
  const index = value < 0 ? vertexCount + value : value - 1; // 负索引：相对当前已定义顶点
  if (index < 0 || index >= vertexCount) {
    throw new Error(
      `OBJ 解析失败：第 ${lineNo} 行的${what}索引 ${value} 超出范围（当前共 ${vertexCount} 个${what}）`
    );
  }
  return index;
}

/**
 * 解析 OBJ。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns 同 finishMesh：positions 为三角形汤，法线输出为 null（渲染端按面重算平面法线）
 */
export function parseOBJ(bytes) {
  const u8 = toUint8(bytes);
  const text = decodeText(u8).replace(/^\uFEFF/, '');
  const lines = text.split(/\r\n|\r|\n/);

  const verts = [];       // 扁平 x,y,z
  const normalsList = [];
  const texcoords = [];
  const positions = [];   // 三角形汤
  const warnings = [];
  let faceCount = 0;
  let ngonCount = 0;
  let ignoredStatements = 0;

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].trim();
    if (!line) continue;
    // 行内注释
    const hash = line.indexOf('#');
    if (hash === 0) continue;
    if (hash > 0) line = line.slice(0, hash).trim();
    if (!line) continue;

    // 行尾反斜杠续行（数据文件里少见，但标准允许）
    let full = line;
    while (/\\$/.test(full) && li + 1 < lines.length) {
      full = full.slice(0, -1) + ' ' + lines[++li].trim();
    }
    const parts = full.split(/\s+/);
    const kw = parts[0].toLowerCase();

    if (kw === 'v') {
      if (parts.length < 4) throw new Error(`OBJ 解析失败：第 ${li + 1} 行 v 顶点至少需要 3 个坐标`);
      const x = Number(parts[1]), y = Number(parts[2]), z = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`OBJ 解析失败：第 ${li + 1} 行 v 顶点坐标不是有效数字`);
      }
      verts.push(x, y, z);
    } else if (kw === 'vn') {
      if (parts.length < 4) throw new Error(`OBJ 解析失败：第 ${li + 1} 行 vn 法线至少需要 3 个分量`);
      const x = Number(parts[1]), y = Number(parts[2]), z = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`OBJ 解析失败：第 ${li + 1} 行 vn 法线不是有效数字`);
      }
      normalsList.push(x, y, z);
    } else if (kw === 'vt') {
      if (parts.length < 3) throw new Error(`OBJ 解析失败：第 ${li + 1} 行 vt 纹理坐标至少需要 2 个分量`);
      const u = Number(parts[1]), v = Number(parts[2]);
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        throw new Error(`OBJ 解析失败：第 ${li + 1} 行 vt 纹理坐标不是有效数字`);
      }
      texcoords.push(u, v);
    } else if (kw === 'f') {
      const vertexCount = verts.length / 3;
      if (parts.length < 4) {
        throw new Error(`OBJ 解析失败：第 ${li + 1} 行 f 面至少需要 3 个顶点（当前 ${parts.length - 1} 个）`);
      }
      const idx = [];
      for (let k = 1; k < parts.length; k++) {
        idx.push(parseVertexIndex(parts[k], vertexCount, li + 1));
      }
      if (idx.length < 3) {
        throw new Error(`OBJ 解析失败：第 ${li + 1} 行 f 面有效顶点不足 3 个`);
      }
      // n-gon 扇形三角化：v0-vk-vk+1
      if (idx.length > 3) ngonCount++;
      for (let k = 1; k < idx.length - 1; k++) {
        const a = idx[0] * 3, b = idx[k] * 3, c = idx[k + 1] * 3;
        positions.push(verts[a], verts[a + 1], verts[a + 2]);
        positions.push(verts[b], verts[b + 1], verts[b + 2]);
        positions.push(verts[c], verts[c + 1], verts[c + 2]);
      }
      faceCount++;
    } else if (kw === 'o' || kw === 'g' || kw === 's' || kw === 'usemtl' || kw === 'mtllib' ||
               kw === 'l' || kw === 'p' || kw === 'vp' || kw === 'cstype' || kw === 'deg' ||
               kw === 'bmat' || kw === 'step' || kw === 'curv' || kw === 'curv2' || kw === 'surf' ||
               kw === 'parm' || kw === 'trim' || kw === 'hole' || kw === 'scrv' || kw === 'sp' ||
               kw === 'end' || kw === 'con' || kw === 'mg' || kw === 'bevel' || kw === 'c_interp' ||
               kw === 'd_interp' || kw === 'lod' || kw === 'shadow_obj' || kw === 'trace_obj' ||
               kw === 'ctech' || kw === 'stech') {
      ignoredStatements++;
    } else {
      ignoredStatements++;
    }
  }

  if (verts.length === 0) throw new Error('OBJ 解析失败：文件中没有 "v" 顶点数据');
  if (positions.length === 0) throw new Error('OBJ 解析失败：文件中没有 "f" 面数据，无法生成三角形');
  if (texcoords.length > 0) warnings.push('已忽略纹理坐标（vt）与材质（mtllib/usemtl）');
  if (ignoredStatements > 0 && texcoords.length === 0) {
    warnings.push(`已忽略 ${ignoredStatements} 条非几何语句（材质/分组/曲线等）`);
  }

  return finishMesh({
    format: 'obj',
    variant: 'text',
    positions,
    normals: null,
    vertexCount: verts.length / 3,
    warnings,
    meta: { faces: faceCount, ngons: ngonCount, texcoords: texcoords.length / 2, fileNormals: normalsList.length / 3 },
  });
}

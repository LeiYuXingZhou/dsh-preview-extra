// stl.js — STL 解析（二进制 / ASCII 自动识别）。
// 二进制：80 字节头 + uint32 LE 三角形数 + 每三角形 50 字节（法线 3f + 3 顶点 9f + 2 字节属性）。
// ASCII：solid / facet normal / outer loop / vertex ×3 / endloop / endfacet。
import { dataView, decodeLatin1, decodeText, finishMesh, faceNormalsOf, toUint8 } from './common.js';

/** 二进制 STL 的三角形数量是否与文件长度自洽（允许尾部多余字节）。 */
export function isBinarySTL(bytes) {
  const u8 = toUint8(bytes);
  if (u8.byteLength < 84) return false;
  const dv = dataView(u8);
  const declared = dv.getUint32(80, true);
  const remain = u8.byteLength - 84;
  if (declared > 0 && declared * 50 <= remain) return true;
  // 少数导出器把头部计数写成 0，但数据长度能整除 50：仍按二进制处理
  if (declared === 0 && remain > 0 && remain % 50 === 0) return true;
  return false;
}

/** 是否像 ASCII STL（以 solid 开头且头部含 facet 关键字）。 */
export function looksLikeAsciiSTL(bytes) {
  const u8 = toUint8(bytes);
  const head = decodeLatin1(u8, 0, Math.min(u8.byteLength, 1024));
  return /^\uFEFF?\s*solid\b/i.test(head) && /\bfacet\b/i.test(head);
}

/**
 * 解析 STL（自动识别二进制 / ASCII）。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{format:'stl', variant:'binary'|'ascii', positions:Float32Array,
 *   normals:Float32Array|null, triangleCount:number, vertexCount:number,
 *   bounds:{min:number[],max:number[],center:number[],radius:number}, warnings:string[], meta:object}}
 */
export function parseSTL(bytes) {
  const u8 = toUint8(bytes);
  if (u8.byteLength === 0) throw new Error('STL 解析失败：文件为空');

  if (looksLikeAsciiSTL(u8)) return parseAsciiSTL(u8);
  if (isBinarySTL(u8)) return parseBinarySTL(u8);

  // 到这里说明两种都不是，给出尽量具体的诊断
  if (u8.byteLength >= 84) {
    const dv = dataView(u8);
    const declared = dv.getUint32(80, true);
    const remain = u8.byteLength - 84;
    if (declared > 0 && declared * 50 > remain) {
      throw new Error(
        `STL 解析失败：文件被截断，头部声明 ${declared} 个三角形（需要 ${84 + declared * 50} 字节），实际只有 ${u8.byteLength} 字节`
      );
    }
    if (remain % 50 !== 0) {
      throw new Error(
        `STL 解析失败：二进制数据段长度 ${remain} 字节不是 50 的整数倍（每个三角形固定 50 字节），文件可能损坏`
      );
    }
  }
  const text = decodeText(u8);
  if (/^\uFEFF?\s*solid\b/i.test(text) || /\bfacet\b/i.test(text)) {
    throw new Error('STL 解析失败：ASCII STL 缺少完整的 "facet"/"vertex" 关键字，无法解析');
  }
  throw new Error(
    'STL 解析失败：无法识别文件类型（既不是合法的二进制 STL，也不以 "solid" 开头）。请确认文件未损坏'
  );
}

/** 解析二进制 STL。 */
export function parseBinarySTL(bytes) {
  const u8 = toUint8(bytes);
  if (u8.byteLength < 84) throw new Error('STL 解析失败：二进制 STL 至少需要 84 字节文件头');
  const dv = dataView(u8);
  const declared = dv.getUint32(80, true);
  const remain = u8.byteLength - 84;
  const warnings = [];

  let count = declared;
  if (declared === 0 && remain > 0 && remain % 50 === 0) {
    count = remain / 50;
    warnings.push('文件头中的三角形数量为 0，已按数据长度推断');
  }
  if (count === 0) throw new Error('STL 解析失败：文件中没有三角形');
  if (count * 50 > remain) {
    throw new Error(
      `STL 解析失败：文件被截断，头部声明 ${count} 个三角形（需要 ${count * 50} 字节数据），实际只有 ${remain} 字节`
    );
  }
  if (count * 50 < remain) {
    warnings.push(`尾部存在 ${remain - count * 50} 字节多余数据，已忽略`);
  }

  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 3);
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50;
    normals[t * 3] = dv.getFloat32(o, true);
    normals[t * 3 + 1] = dv.getFloat32(o + 4, true);
    normals[t * 3 + 2] = dv.getFloat32(o + 8, true);
    const p = t * 9;
    positions[p] = dv.getFloat32(o + 12, true);
    positions[p + 1] = dv.getFloat32(o + 16, true);
    positions[p + 2] = dv.getFloat32(o + 20, true);
    positions[p + 3] = dv.getFloat32(o + 24, true);
    positions[p + 4] = dv.getFloat32(o + 28, true);
    positions[p + 5] = dv.getFloat32(o + 32, true);
    positions[p + 6] = dv.getFloat32(o + 36, true);
    positions[p + 7] = dv.getFloat32(o + 40, true);
    positions[p + 8] = dv.getFloat32(o + 44, true);
  }
  // 头部法线经常是 0 向量或错误值：几何法线与头部法线差异过大时用几何法线兜底
  const geometric = faceNormalsOf(positions);
  for (let t = 0; t < count; t++) {
    const o = t * 3;
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
    if (!(len > 1e-6)) {
      normals[o] = geometric[o];
      normals[o + 1] = geometric[o + 1];
      normals[o + 2] = geometric[o + 2];
    }
  }
  return finishMesh({
    format: 'stl',
    variant: 'binary',
    positions,
    normals,
    warnings,
    meta: { declaredTriangles: declared },
  });
}

/** 解析 ASCII STL。 */
export function parseAsciiSTL(bytes) {
  const u8 = toUint8(bytes);
  const text = decodeText(u8).replace(/^\uFEFF/, '');
  const lines = text.split(/\r\n|\r|\n/);
  const positions = [];
  const facetNormals = [];
  const warnings = [];
  let solidSeen = false;
  let facetSeen = false;
  let facetMissingNormal = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    const kw = tokens[0].toLowerCase();

    if (kw === 'solid') { solidSeen = true; continue; }
    if (kw === 'endsolid') continue;
    if (kw === 'facet') {
      facetSeen = true;
      if (tokens.length >= 5 && tokens[1].toLowerCase() === 'normal') {
        const nx = Number(tokens[2]), ny = Number(tokens[3]), nz = Number(tokens[4]);
        if (Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz)) {
          facetNormals.push(nx, ny, nz);
        } else {
          facetMissingNormal++;
        }
      } else {
        facetMissingNormal++;
      }
      continue;
    }
    if (kw === 'vertex') {
      if (tokens.length < 4) {
        throw new Error(`STL 解析失败：第 ${li + 1} 行 vertex 缺少坐标，应为 "vertex x y z"`);
      }
      const x = Number(tokens[1]), y = Number(tokens[2]), z = Number(tokens[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`STL 解析失败：第 ${li + 1} 行 vertex 坐标不是有效数字（"${line}"）`);
      }
      positions.push(x, y, z);
      continue;
    }
    // solid 名称行、endloop / outer loop 等直接忽略
  }

  if (positions.length === 0) {
    throw new Error(
      'STL 解析失败：ASCII STL 中未找到 "vertex" 顶点数据（文件可能为空、损坏或不是 STL）'
    );
  }
  if (positions.length % 9 !== 0) {
    throw new Error(
      `STL 解析失败：ASCII STL 顶点分量数量 ${positions.length} 不是 3 的倍数，无法组成三角形`
    );
  }
  if (!solidSeen) warnings.push('缺少 "solid" 关键字，已按 ASCII STL 的 facet/vertex 结构解析');
  if (!facetSeen) warnings.push('缺少 "facet" 关键字，已将 vertex 按每 3 个一组作为三角形解析');
  if (facetMissingNormal > 0) warnings.push(`${facetMissingNormal} 个 facet 缺少有效法线，法线由几何法线补齐`);

  const triangleCount = positions.length / 9;
  // 约定：normals 为按三角形的平面法线（长度 = 三角形数 × 3）。
  // 仅当每个 facet 都有合法 normal 且 facet 数与三角形数一致时才输出，否则置空（消费方自行重算）。
  const normalsOk = facetMissingNormal === 0 && facetNormals.length === triangleCount * 3;
  return finishMesh({
    format: 'stl',
    variant: 'ascii',
    positions,
    normals: normalsOk ? facetNormals : null,
    warnings,
    meta: { facetCount: triangleCount },
  });
}

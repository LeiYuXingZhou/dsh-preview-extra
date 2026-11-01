// common.js — 3D 模型解析共用工具。
// 纯 ESM，无第三方依赖；只用 Web 标准 API（TextDecoder/DataView/TypedArray），
// 浏览器与 Node 18+ 均可直接运行。

/** 把 Buffer / ArrayBuffer / TypedArray 统一成 Uint8Array 视图（不复制）。 */
export function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('需要 Uint8Array 或 ArrayBuffer');
}

/** 在字节视图上建 DataView（自动处理子视图的 byteOffset）。 */
export function dataView(bytes) {
  const u8 = toUint8(bytes);
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

/** 按 Latin-1 解码一段字节（用于文件头等二进制文本，绝不会因非法 UTF-8 抛错）。 */
export function decodeLatin1(bytes, start = 0, end = bytes.length) {
  const u8 = toUint8(bytes);
  const s = Math.min(end, u8.length);
  let out = '';
  const CHUNK = 0x2000;
  for (let i = start; i < s; i += CHUNK) {
    const sub = u8.subarray(i, Math.min(i + CHUNK, s));
    out += String.fromCharCode.apply(null, sub);
  }
  return out;
}

/** 按 UTF-8 解码（非法字节替换为 U+FFFD，不抛错；用于 ASCII 类模型文件）。 */
export function decodeText(bytes) {
  const u8 = toUint8(bytes);
  if (typeof TextDecoder === 'function') {
    return new TextDecoder('utf-8', { fatal: false }).decode(u8);
  }
  return decodeLatin1(u8);
}

/**
 * 计算三角形汤（positions 为每 3 个 float 一个顶点、每 9 个 float 一个三角形）的包围盒。
 * @param {Float32Array|Float64Array|number[]} positions
 * @returns {{min:number[], max:number[], center:number[], radius:number}}
 *   radius = 包围盒中心到 8 个角点的最大距离（用于自动适配/投影取景）
 */
export function boundsOf(positions) {
  const n = positions.length;
  if (n < 3) return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 0 };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let r2 = 0;
  for (let i = 0; i < n; i += 3) {
    const dx = positions[i] - center[0];
    const dy = positions[i + 1] - center[1];
    const dz = positions[i + 2] - center[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], center, radius: Math.sqrt(r2) };
}

/** 由三角形汤计算每个三角形的几何法线（单位化；退化三角形给 0 向量）。 */
export function faceNormalsOf(positions) {
  const triCount = Math.floor(positions.length / 9);
  const normals = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    else { nx = ny = nz = 0; }
    normals[t * 3] = nx; normals[t * 3 + 1] = ny; normals[t * 3 + 2] = nz;
  }
  return normals;
}

/**
 * 各解析器的收尾：统一转 Float32Array、校验、算包围盒、组装元信息。
 * 解析器内部可先攒普通数组，这里只做一次拷贝。
 */
export function finishMesh({ format, variant, positions, normals = null, vertexCount, warnings = [], meta = {} }) {
  const pos = positions instanceof Float32Array ? positions : new Float32Array(positions);
  if (pos.length === 0) throw new Error(`${format.toUpperCase()} 解析失败：未解析到任何顶点数据`);
  if (pos.length % 9 !== 0) {
    throw new Error(
      `${format.toUpperCase()} 解析失败：顶点分量数量 ${pos.length} 不是 9 的整数倍，无法组成三角形`
    );
  }
  for (let i = 0; i < pos.length; i++) {
    if (!Number.isFinite(pos[i])) {
      throw new Error(`${format.toUpperCase()} 解析失败：第 ${Math.floor(i / 3) + 1} 个顶点坐标包含非有限数值`);
    }
  }
  const triangleCount = pos.length / 9;
  // 约定：normals 是按三角形的平面法线（长度 = 三角形数 × 3）。
  // 也容忍按顶点给的法线（长度 = 顶点分量数），此时取每个三角形首顶点法线。
  let norm = null;
  if (normals) {
    if (normals.length === triangleCount * 3) {
      norm = normals instanceof Float32Array ? normals : new Float32Array(normals);
    } else if (normals.length === pos.length) {
      norm = new Float32Array(triangleCount * 3);
      for (let t = 0; t < triangleCount; t++) {
        norm[t * 3] = normals[t * 9];
        norm[t * 3 + 1] = normals[t * 9 + 1];
        norm[t * 3 + 2] = normals[t * 9 + 2];
      }
    }
    if (norm) {
      for (let i = 0; i < norm.length; i++) {
        if (!Number.isFinite(norm[i])) { norm = null; break; }
      }
    }
  }
  return {
    format,
    variant,
    positions: pos,
    normals: norm,
    triangleCount,
    vertexCount: vertexCount ?? triangleCount * 3,
    bounds: boundsOf(pos),
    warnings,
    meta,
  };
}

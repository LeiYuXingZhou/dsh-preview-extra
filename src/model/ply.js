// ply.js — PLY 解析（ASCII 与 binary_little_endian）。
// 支持 element vertex / face 及任意标量属性、list 属性；其它 element（edge 等）会被正确跳过。
// binary_big_endian 暂不支持（给出可读错误）。
import { decodeLatin1, dataView, finishMesh, toUint8 } from './common.js';

// PLY 标量类型：size + DataView 读取函数
const TYPES = {
  char: { size: 1, get: (dv, o) => dv.getInt8(o) },
  int8: { size: 1, get: (dv, o) => dv.getInt8(o) },
  uchar: { size: 1, get: (dv, o) => dv.getUint8(o) },
  uint8: { size: 1, get: (dv, o) => dv.getUint8(o) },
  short: { size: 2, get: (dv, o) => dv.getInt16(o, true) },
  int16: { size: 2, get: (dv, o) => dv.getInt16(o, true) },
  ushort: { size: 2, get: (dv, o) => dv.getUint16(o, true) },
  uint16: { size: 2, get: (dv, o) => dv.getUint16(o, true) },
  int: { size: 4, get: (dv, o) => dv.getInt32(o, true) },
  int32: { size: 4, get: (dv, o) => dv.getInt32(o, true) },
  uint: { size: 4, get: (dv, o) => dv.getUint32(o, true) },
  uint32: { size: 4, get: (dv, o) => dv.getUint32(o, true) },
  float: { size: 4, get: (dv, o) => dv.getFloat32(o, true) },
  float32: { size: 4, get: (dv, o) => dv.getFloat32(o, true) },
  double: { size: 8, get: (dv, o) => dv.getFloat64(o, true) },
  float64: { size: 8, get: (dv, o) => dv.getFloat64(o, true) },
};

const INT_TYPES = new Set(['char', 'int8', 'uchar', 'uint8', 'short', 'int16', 'ushort', 'uint16', 'int', 'int32', 'uint', 'uint32']);

function typeInfo(type) {
  const info = TYPES[type];
  if (!info) throw new Error(`PLY 解析失败：不支持的属性类型 "${type}"`);
  return info;
}

/** 是否以 "ply" 魔数开头。 */
export function isPLY(bytes) {
  const u8 = toUint8(bytes);
  if (u8.byteLength < 4) return false;
  return u8[0] === 0x70 && u8[1] === 0x6c && u8[2] === 0x79; // "ply"
}

/** 解析 PLY。 */
export function parsePLY(bytes) {
  const u8 = toUint8(bytes);
  if (!isPLY(u8)) throw new Error('PLY 解析失败：文件头缺少 "ply" 魔数');
  const header = readHeader(u8);
  const format = header.format;
  let positions;
  let faces;
  let warnings = [];

  if (format === 'ascii') {
    const r = parseAsciiBody(u8, header);
    positions = r.positions; faces = r.faces; warnings = r.warnings;
  } else if (format === 'binary_little_endian') {
    const r = parseBinaryBody(u8, header);
    positions = r.positions; faces = r.faces; warnings = r.warnings;
  } else if (format === 'binary_big_endian') {
    throw new Error('PLY 解析失败：暂不支持 binary_big_endian 字节序的 PLY（当前支持 ascii / binary_little_endian）');
  } else {
    throw new Error(`PLY 解析失败：未知的 format "${format}"（应为 ascii / binary_little_endian / binary_big_endian）`);
  }

  const vertexCount = positions.length / 3;
  const triIndices = triangulateFaces(faces, vertexCount, warnings);
  const triPositions = new Float32Array(triIndices.length * 3);
  for (let i = 0; i < triIndices.length; i++) {
    const vi = triIndices[i] * 3;
    triPositions[i * 3] = positions[vi];
    triPositions[i * 3 + 1] = positions[vi + 1];
    triPositions[i * 3 + 2] = positions[vi + 2];
  }
  return finishMesh({
    format: 'ply',
    variant: format === 'ascii' ? 'ascii' : 'binary-little-endian',
    positions: triPositions,
    normals: null,
    vertexCount,
    warnings,
    meta: { encoding: format, elements: header.elements.map((e) => e.name), faceCount: faces.length },
  });
}

/** 读取并校验 ASCII 头。返回 { format, elements, headerEnd } */
function readHeader(u8) {
  const elements = [];
  let format = null;
  let headerEnd = -1;
  let offset = 0;
  let lineNo = 0;
  while (offset < u8.byteLength) {
    let nl = -1;
    for (let i = offset; i < u8.byteLength; i++) {
      if (u8[i] === 0x0a) { nl = i; break; }
    }
    const end = nl >= 0 ? nl : u8.byteLength;
    let line = decodeLatin1(u8, offset, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    offset = nl >= 0 ? nl + 1 : u8.byteLength;
    lineNo++;
    if (lineNo === 1) {
      if (line.trim() !== 'ply') throw new Error('PLY 解析失败：文件头第一行必须是 "ply"');
      continue;
    }
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const kw = tokens[0].toLowerCase();
    if (kw === 'end_header') { headerEnd = offset; break; }
    if (kw === 'comment' || kw === 'obj_info') continue;
    if (kw === 'format') {
      if (tokens.length < 2) throw new Error('PLY 解析失败：format 行缺少编码类型');
      format = tokens[1].toLowerCase();
    } else if (kw === 'element') {
      const count = Number.parseInt(tokens[2], 10);
      if (tokens.length < 3 || !Number.isInteger(count) || count < 0) {
        throw new Error(`PLY 解析失败：element "${tokens[1]}" 的数量无效（"${tokens[2]}"）`);
      }
      elements.push({ name: tokens[1], count, properties: [] });
    } else if (kw === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new Error('PLY 解析失败：property 出现在 element 之前');
      if ((tokens[1] || '').toLowerCase() === 'list') {
        if (tokens.length < 5) throw new Error(`PLY 解析失败：list 属性定义不完整（"${line.trim()}"）`);
        const countType = tokens[2].toLowerCase();
        const itemType = tokens[3].toLowerCase();
        typeInfo(countType); typeInfo(itemType);
        if (!INT_TYPES.has(countType)) throw new Error(`PLY 解析失败：list 的计数类型 "${countType}" 必须是整数类型`);
        el.properties.push({ list: true, countType, itemType, name: tokens[4] });
      } else {
        if (tokens.length < 3) throw new Error(`PLY 解析失败：property 定义不完整（"${line.trim()}"）`);
        const type = tokens[1].toLowerCase();
        typeInfo(type);
        el.properties.push({ list: false, type, name: tokens[2] });
      }
    }
  }
  if (headerEnd < 0) throw new Error('PLY 解析失败：未找到 "end_header"，文件头不完整');
  if (!format) throw new Error('PLY 解析失败：缺少 format 行（应为 ascii 或 binary_little_endian）');

  const vertexEl = elements.find((e) => e.name === 'vertex');
  if (!vertexEl) throw new Error('PLY 解析失败：缺少 element vertex');
  if (!vertexEl.properties.some((p) => !p.list && p.name === 'x') ||
      !vertexEl.properties.some((p) => !p.list && p.name === 'y') ||
      !vertexEl.properties.some((p) => !p.list && p.name === 'z')) {
    throw new Error('PLY 解析失败：vertex 元素缺少 x / y / z 属性');
  }
  if (vertexEl.count > 50_000_000) throw new Error('PLY 解析失败：顶点数量过大，拒绝解析');
  const faceEl = elements.find((e) => e.name === 'face');
  if (!faceEl) throw new Error('PLY 解析失败：缺少 element face（点云暂不支持 3D 预览）');
  const listProp = faceEl.properties.find((p) => p.list && (p.name === 'vertex_indices' || p.name === 'vertex_index')) ||
    faceEl.properties.find((p) => p.list);
  if (!listProp) throw new Error('PLY 解析失败：face 元素缺少顶点索引 list 属性（vertex_indices）');
  if (!INT_TYPES.has(listProp.itemType)) {
    throw new Error(`PLY 解析失败：face 顶点索引类型 "${listProp.itemType}" 必须是整数类型`);
  }
  return { format, elements, headerEnd, vertexEl, faceEl, listProp };
}

function parseBinaryBody(u8, header) {
  const dv = dataView(u8);
  const positions = [];
  const faces = [];
  const warnings = [];
  let offset = header.headerEnd;

  for (const el of header.elements) {
    // 最小记录长度：list 至少 1 个元素
    let minRecordSize = 0;
    for (const p of el.properties) {
      minRecordSize += p.list ? typeInfo(p.countType).size + typeInfo(p.itemType).size : typeInfo(p.type).size;
    }
    if (el.count > 0 && offset + el.count * minRecordSize > dv.byteLength) {
      throw new Error(
        `PLY 解析失败：二进制数据长度不足，${el.name} 元素需要 ${el.count} 条记录，剩余 ${dv.byteLength - offset} 字节`
      );
    }
    const isVertex = el.name === 'vertex';
    const isFace = el.name === 'face';
    const xIdx = isVertex ? el.properties.findIndex((p) => !p.list && p.name === 'x') : -1;
    const yIdx = isVertex ? el.properties.findIndex((p) => !p.list && p.name === 'y') : -1;
    const zIdx = isVertex ? el.properties.findIndex((p) => !p.list && p.name === 'z') : -1;
    const listIdx = isFace ? el.properties.indexOf(header.listProp) : -1;

    for (let i = 0; i < el.count; i++) {
      let x = 0, y = 0, z = 0;
      for (let pi = 0; pi < el.properties.length; pi++) {
        const prop = el.properties[pi];
        if (prop.list) {
          const info = typeInfo(prop.countType);
          if (offset + info.size > dv.byteLength) throw new Error(`PLY 解析失败：数据在 ${el.name} 元素处提前结束`);
          const n = info.get(dv, offset);
          offset += info.size;
          if (!Number.isInteger(n) || n < 0) {
            throw new Error(`PLY 解析失败：${el.name} 元素第 ${i + 1} 条记录的 list 长度无效（${n}）`);
          }
          const itemInfo = typeInfo(prop.itemType);
          const bytesNeeded = n * itemInfo.size;
          if (offset + bytesNeeded > dv.byteLength) {
            throw new Error(`PLY 解析失败：数据在 ${el.name} 元素处提前结束`);
          }
          if (isFace && pi === listIdx) {
            const ids = new Array(n);
            for (let k = 0; k < n; k++) { ids[k] = itemInfo.get(dv, offset); offset += itemInfo.size; }
            faces.push(ids);
          } else {
            offset += bytesNeeded; // 跳过其它 list
          }
        } else {
          const info = typeInfo(prop.type);
          if (offset + info.size > dv.byteLength) throw new Error(`PLY 解析失败：数据在 ${el.name} 元素处提前结束`);
          const value = info.get(dv, offset);
          offset += info.size;
          if (isVertex) {
            if (pi === xIdx) x = value;
            else if (pi === yIdx) y = value;
            else if (pi === zIdx) z = value;
          }
        }
      }
      if (isVertex) positions.push(x, y, z);
    }
  }
  if (positions.length === 0) throw new Error('PLY 解析失败：vertex 元素为空');
  return { positions, faces, warnings };
}

function parseAsciiBody(u8, header) {
  const body = decodeLatin1(u8, header.headerEnd);
  const tokens = [];
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const hash = line.indexOf('#');
    if (hash > 0) line = line.slice(0, hash).trim();
    if (!line) continue;
    for (const part of line.split(/\s+/)) if (part) tokens.push(part);
  }
  let cursor = 0;
  const readNumber = (elName) => {
    if (cursor >= tokens.length) {
      throw new Error(`PLY 解析失败：数据在 ${elName} 元素处提前结束（token 不足）`);
    }
    const raw = tokens[cursor++];
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`PLY 解析失败：${elName} 元素中出现非法数值 "${raw}"`);
    return value;
  };
  const readCount = (elName) => {
    const n = readNumber(elName);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`PLY 解析失败：${elName} 元素中的 list 长度不是非负整数（${n}）`);
    }
    return n;
  };

  const positions = [];
  const faces = [];
  const warnings = [];
  for (const el of header.elements) {
    const isVertex = el.name === 'vertex';
    const isFace = el.name === 'face';
    const xIdx = isVertex ? el.properties.findIndex((p) => !p.list && p.name === 'x') : -1;
    const yIdx = isVertex ? el.properties.findIndex((p) => !p.list && p.name === 'y') : -1;
    const zIdx = isVertex ? el.properties.findIndex((p) => !p.list && p.name === 'z') : -1;
    const listIdx = isFace ? el.properties.indexOf(header.listProp) : -1;
    for (let i = 0; i < el.count; i++) {
      let x = 0, y = 0, z = 0;
      for (let pi = 0; pi < el.properties.length; pi++) {
        const prop = el.properties[pi];
        if (prop.list) {
          const n = readCount(el.name);
          if (isFace && pi === listIdx) {
            const ids = new Array(n);
            for (let k = 0; k < n; k++) ids[k] = readNumber(el.name);
            faces.push(ids);
          } else {
            for (let k = 0; k < n; k++) readNumber(el.name);
          }
        } else {
          const value = readNumber(el.name);
          if (isVertex) {
            if (pi === xIdx) x = value;
            else if (pi === yIdx) y = value;
            else if (pi === zIdx) z = value;
          }
        }
      }
      if (isVertex) positions.push(x, y, z);
    }
  }
  if (positions.length === 0) throw new Error('PLY 解析失败：vertex 元素为空');
  return { positions, faces, warnings };
}

/** 面索引校验 + 扇形三角化（n-gon → n-2 个三角形），返回顶点索引三元组数组。 */
function triangulateFaces(faces, vertexCount, warnings) {
  const indices = [];
  let badFaces = 0;
  let ngons = 0;
  for (let f = 0; f < faces.length; f++) {
    const ids = faces[f];
    if (ids.length < 3) { badFaces++; continue; }
    if (ids.length > 3) ngons++;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (!Number.isInteger(id) || id < 0 || id >= vertexCount) {
        throw new Error(
          `PLY 解析失败：第 ${f + 1} 个面的顶点索引 ${id} 超出范围（vertex 数量 ${vertexCount}）`
        );
      }
    }
    for (let k = 1; k < ids.length - 1; k++) {
      indices.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  if (badFaces > 0) warnings.push(`${badFaces} 个面的顶点数少于 3，已跳过`);
  if (ngons > 0) warnings.push(`${ngons} 个 n-gon 面已扇形三角化`);
  return indices;
}

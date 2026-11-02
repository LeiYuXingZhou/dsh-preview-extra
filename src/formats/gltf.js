// gltf.js — glTF 2.0 / GLB 解析，输出三角形汤（可交给 model/renderer）。
// 支持：GLB JSON+BIN、data URI 内嵌 buffer、节点 TRS/矩阵、三角形 / 扇 / 带、
// accessor 的 stride / normalized / sparse。外部 .bin 无法在单文件预览里打开。

import { finishMesh, toUint8 } from '../model/common.js';
import { decodeUtf8 } from './text.js';

const MAX_TRIANGLES = 350_000;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const COMPONENTS = {
  5120: { size: 1, read: (view, offset) => view.getInt8(offset), norm: (v) => Math.max(v / 127, -1) },
  5121: { size: 1, read: (view, offset) => view.getUint8(offset), norm: (v) => v / 255 },
  5122: { size: 2, read: (view, offset) => view.getInt16(offset, true), norm: (v) => Math.max(v / 32767, -1) },
  5123: { size: 2, read: (view, offset) => view.getUint16(offset, true), norm: (v) => v / 65535 },
  5125: { size: 4, read: (view, offset) => view.getUint32(offset, true), norm: (v) => v },
  5126: { size: 4, read: (view, offset) => view.getFloat32(offset, true), norm: (v) => v },
};

const COMPONENT_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** 文件头是不是 GLB（magic = glTF，小端 0x46546C67）。 */
export function isGlb(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : null;
  return !!u8 && u8.byteLength >= 12 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46;
}

/**
 * 解析 glTF / GLB，返回 finishMesh 的形状。失败抛出带「GLB」或「glTF」字样的 Error。
 * @param {Uint8Array|ArrayBuffer} bytes
 */
export function parseGltfMesh(bytes) {
  const u8 = toUint8(bytes);
  if (u8.byteLength === 0) throw new Error('GLB 解析失败：文件为空');
  if (u8.byteLength > 64 * 1024 * 1024) throw new Error('GLB 解析失败：文件超过 64 MiB');

  let jsonText;
  let bin = null;
  let variant = 'gltf';
  if (isGlb(u8)) {
    variant = 'glb';
    const container = readGlb(u8);
    jsonText = container.json;
    bin = container.bin;
  } else {
    jsonText = decodeUtf8(u8);
    if (!jsonText.trimStart().startsWith('{')) {
      throw new Error('GLB 解析失败：文件头不是 glTF 魔数，也不是 glTF JSON');
    }
  }

  let gltf;
  try {
    gltf = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`${variant === 'glb' ? 'GLB' : 'glTF'} 解析失败：JSON 块无法解析`);
  }
  if (!gltf || typeof gltf !== 'object') {
    throw new Error(`${variant === 'glb' ? 'GLB' : 'glTF'} 解析失败：JSON 根节点不是对象`);
  }

  const warnings = [];
  const version = gltf.asset && gltf.asset.version ? String(gltf.asset.version) : '';
  if (version && !version.startsWith('2')) warnings.push(`glTF 版本 ${version}，按 2.0 尝试解析`);

  const buffers = loadBuffers(gltf, bin, warnings);
  const positions = [];
  let vertexCount = 0;
  let stopped = false;
  const seen = new Set();

  const emit = (meshIndex, world) => {
    if (stopped) return;
    const mesh = gltf.meshes && gltf.meshes[meshIndex];
    if (!mesh || !Array.isArray(mesh.primitives)) return;
    for (const primitive of mesh.primitives) {
      if (stopped) return;
      try {
        const added = emitPrimitive(gltf, buffers, primitive, world, positions, warnings);
        vertexCount += added.vertices;
        if (positions.length / 9 >= MAX_TRIANGLES) stopped = true;
      } catch (err) {
        warnings.push(err && err.message ? err.message : String(err));
      }
    }
  };

  const walk = (nodeIndex, parent) => {
    if (stopped || seen.has(nodeIndex)) return;
    const node = gltf.nodes && gltf.nodes[nodeIndex];
    if (!node) return;
    seen.add(nodeIndex);
    const world = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) emit(node.mesh, world);
    if (node.skin !== undefined) warnings.push('文件包含蒙皮，预览显示绑定姿势');
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) walk(child, world);
  };

  const sceneIndex = Number.isInteger(gltf.scene) ? gltf.scene : 0;
  const scene = gltf.scenes && gltf.scenes[sceneIndex];
  if (scene && Array.isArray(scene.nodes) && scene.nodes.length > 0) {
    for (const nodeIndex of scene.nodes) walk(nodeIndex, IDENTITY);
  } else if (Array.isArray(gltf.nodes) && gltf.nodes.length > 0) {
    const childSet = new Set();
    for (const node of gltf.nodes) {
      for (const child of node.children || []) childSet.add(child);
    }
    gltf.nodes.forEach((_, index) => {
      if (!childSet.has(index)) walk(index, IDENTITY);
    });
  } else if (Array.isArray(gltf.meshes)) {
    gltf.meshes.forEach((_, index) => emit(index, IDENTITY));
  }

  if (positions.length === 0) {
    const external = warnings.find((item) => item.includes('外部'));
    throw new Error(external || `${variant === 'glb' ? 'GLB' : 'glTF'} 解析失败：没有可渲染的三角形网格`);
  }
  if (stopped) warnings.push(`三角形超过 ${MAX_TRIANGLES}，只渲染了前面的部分`);
  if ((gltf.animations || []).length > 0) warnings.push('文件包含动画，预览只显示默认姿势');

  const uniqueWarnings = [];
  for (const warning of warnings) {
    if (warning && !uniqueWarnings.includes(warning)) uniqueWarnings.push(warning);
  }

  return finishMesh({
    format: variant === 'glb' ? 'glb' : 'gltf',
    variant,
    positions,
    vertexCount,
    warnings: uniqueWarnings,
    meta: {
      version: version || '2.0',
      generator: gltf.asset && gltf.asset.generator ? String(gltf.asset.generator) : '',
      meshes: (gltf.meshes || []).length,
      materials: (gltf.materials || []).length,
      animations: (gltf.animations || []).length,
      images: (gltf.images || []).length,
      nodes: (gltf.nodes || []).length,
    },
  });
}

function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const length = view.getUint32(8, true);
  if (version < 2) throw new Error(`GLB 解析失败：不支持的容器版本 ${version}`);
  if (length > bytes.byteLength) throw new Error('GLB 解析失败：声明的长度超出文件');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= bytes.byteLength && offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > bytes.byteLength) throw new Error('GLB 解析失败：chunk 超出文件');
    if (chunkType === 0x4e4f534a) json = decodeUtf8(bytes.subarray(start, end));
    else if (chunkType === 0x004e4942) bin = bytes.subarray(start, end);
    offset = end;
  }
  if (!json) throw new Error('GLB 解析失败：缺少 JSON chunk');
  return { json, bin };
}

function loadBuffers(gltf, bin, warnings) {
  const list = Array.isArray(gltf.buffers) ? gltf.buffers : [];
  return list.map((buffer, index) => {
    if (buffer && typeof buffer.uri === 'string' && buffer.uri) {
      const embedded = decodeDataUri(buffer.uri);
      if (!embedded) {
        const name = buffer.uri.length > 80 ? `${buffer.uri.slice(0, 80)}…` : buffer.uri;
        warnings.push(`buffer ${index} 引用了外部文件（${name}），单文件预览读不到它。请改用 .glb 或 data URI`);
        return null;
      }
      return embedded;
    }
    if (index === 0 && bin) return bin;
    if ((buffer && buffer.byteLength) > 0) warnings.push(`buffer ${index} 没有内嵌数据`);
    return null;
  });
}

function decodeDataUri(uri) {
  const match = /^data:[^,]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri);
  if (!match) return null;
  const clean = match[1].replace(/\s/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  if (typeof atob !== 'function') return null;
  let binary;
  try {
    binary = atob(padded);
  } catch (err) {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.map(Number);
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return composeTrs(t, r, s);
}

function composeTrs(t, r, s) {
  const x = r[0], y = r[1], z = r[2], w = r[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function multiply(parent, local) {
  const out = new Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] =
        parent[row] * local[column * 4] +
        parent[4 + row] * local[column * 4 + 1] +
        parent[8 + row] * local[column * 4 + 2] +
        parent[12 + row] * local[column * 4 + 3];
    }
  }
  return out;
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function emitPrimitive(gltf, buffers, primitive, world, out, warnings) {
  const mode = primitive.mode === undefined ? 4 : primitive.mode;
  if (mode !== 4 && mode !== 5 && mode !== 6) {
    warnings.push(`跳过了非三角形图元（mode ${mode}）`);
    return { vertices: 0 };
  }
  const attributes = primitive.attributes || {};
  if (attributes.POSITION === undefined) throw new Error('图元缺少 POSITION');
  const position = readAccessor(gltf, buffers, gltf.accessors[attributes.POSITION]);
  if (position.components < 3) throw new Error('POSITION 不是 VEC3');
  let indices = null;
  if (primitive.indices !== undefined) {
    indices = readAccessor(gltf, buffers, gltf.accessors[primitive.indices]);
  }
  const count = indices ? indices.count : position.count;
  const at = (index) => (indices ? indices.data[index] : index);
  let written = 0;
  const push = (ia, ib, ic) => {
    if (out.length / 9 >= MAX_TRIANGLES) return false;
    if (ia >= position.count || ib >= position.count || ic >= position.count) return true;
    const a = transformPoint(world, position.data[ia * position.components], position.data[ia * position.components + 1], position.data[ia * position.components + 2]);
    const b = transformPoint(world, position.data[ib * position.components], position.data[ib * position.components + 1], position.data[ib * position.components + 2]);
    const c = transformPoint(world, position.data[ic * position.components], position.data[ic * position.components + 1], position.data[ic * position.components + 2]);
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    written += 1;
    return true;
  };
  if (mode === 4) {
    for (let i = 0; i + 2 < count; i += 3) {
      if (!push(at(i), at(i + 1), at(i + 2))) break;
    }
  } else if (mode === 5) {
    for (let i = 0; i + 2 < count; i++) {
      const ok = i % 2 === 0
        ? push(at(i), at(i + 1), at(i + 2))
        : push(at(i + 1), at(i), at(i + 2));
      if (!ok) break;
    }
  } else {
    for (let i = 1; i + 1 < count; i++) {
      if (!push(at(0), at(i), at(i + 1))) break;
    }
  }
  return { vertices: position.count };
}

function readAccessor(gltf, buffers, accessor) {
  if (!accessor || typeof accessor !== 'object') throw new Error('accessor 不存在');
  const components = COMPONENT_COUNT[accessor.type];
  const component = COMPONENTS[accessor.componentType];
  if (!components || !component) throw new Error(`不支持的 accessor（${accessor.type} / ${accessor.componentType}）`);
  const count = accessor.count | 0;
  if (count < 0 || count > 5_000_000) throw new Error('accessor 数量异常');
  const data = new Float32Array(count * components);
  if (accessor.bufferView !== undefined) {
    readView(gltf, buffers, accessor.bufferView, accessor.byteOffset || 0, count, components, component, accessor.normalized === true, data);
  }
  if (accessor.sparse && accessor.sparse.count > 0) {
    applySparse(gltf, buffers, accessor, data, components);
  }
  return { data, count, components };
}

function readView(gltf, buffers, viewIndex, extraOffset, count, components, component, normalized, target) {
  const view = gltf.bufferViews && gltf.bufferViews[viewIndex];
  if (!view) throw new Error('bufferView 不存在');
  const buffer = buffers[view.buffer];
  if (!buffer) throw new Error('外部 buffer 缺失');
  const stride = view.byteStride || component.size * components;
  const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const base = (view.byteOffset || 0) + extraOffset;
  for (let index = 0; index < count; index++) {
    for (let channel = 0; channel < components; channel++) {
      const offset = base + index * stride + channel * component.size;
      if (offset < 0 || offset + component.size > buffer.byteLength) throw new Error('accessor 超出 buffer');
      let value = component.read(dataView, offset);
      if (normalized) value = component.norm(value);
      target[index * components + channel] = value;
    }
  }
}

function applySparse(gltf, buffers, accessor, target, components) {
  const sparse = accessor.sparse;
  const count = sparse.count | 0;
  if (count < 0 || count > accessor.count) throw new Error('sparse accessor 数量异常');
  const indexAccessor = {
    bufferView: sparse.indices.bufferView,
    byteOffset: sparse.indices.byteOffset || 0,
    componentType: sparse.indices.componentType,
    count,
    type: 'SCALAR',
    normalized: false,
  };
  const valueAccessor = {
    bufferView: sparse.values.bufferView,
    byteOffset: sparse.values.byteOffset || 0,
    componentType: accessor.componentType,
    count,
    type: accessor.type,
    normalized: accessor.normalized === true,
  };
  const indices = readAccessor(gltf, buffers, indexAccessor);
  const values = readAccessor(gltf, buffers, valueAccessor);
  for (let i = 0; i < count; i++) {
    const slot = indices.data[i];
    if (slot < 0 || slot >= accessor.count) continue;
    for (let channel = 0; channel < components; channel++) {
      target[slot * components + channel] = values.data[i * components + channel];
    }
  }
}

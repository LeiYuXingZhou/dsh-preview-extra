// detect3d.js — 3D 模型格式识别与统一入口。
// 按扩展名分派，并用内容嗅探兜底（扩展名缺失/错误时仍可识别）。
import { decodeLatin1, toUint8 } from './common.js';
import { isBinarySTL, parseSTL } from './stl.js';
import { parseOBJ } from './obj.js';
import { isPLY, parsePLY } from './ply.js';

/** 当前支持的扩展名（供插件注册 documentPreviews 使用）。 */
export const SUPPORTED_EXTENSIONS = ['stl', 'obj', 'ply'];

/** 预留但暂不支持的格式，给出友好提示而不是"未知格式"。 */
const UNSUPPORTED = {
  '3mf': '3MF', glb: 'GLB', gltf: 'glTF', '3ds': '3DS', fbx: 'FBX', dae: 'DAE',
  off: 'OFF', amf: 'AMF', stp: 'STEP', step: 'STEP', iges: 'IGES', x3d: 'X3D', wrl: 'VRML',
};

function extensionOf(filename) {
  if (typeof filename !== 'string') return '';
  const clean = filename.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return '';
  return clean.slice(dot + 1).toLowerCase();
}

/**
 * 纯内容嗅探（不看扩展名）。
 * @returns {'ply'|'stl-ascii'|'stl-binary'|'obj'|null}
 */
export function sniffFormat(bytes) {
  const u8 = toUint8(bytes);
  if (u8.byteLength < 3) return null;
  if (isPLY(u8)) return 'ply';
  const head = decodeLatin1(u8, 0, Math.min(u8.byteLength, 4096)).replace(/^\uFEFF/, '');
  const lower = head.toLowerCase();
  if (/^\s*solid\b/.test(lower) && /\bfacet\b/.test(lower)) return 'stl-ascii';
  if (isBinarySTL(u8)) return 'stl-binary';
  if (/(^|\n)\s*v\s+[-+0-9.]/.test(head) && /(^|\n)\s*f\s+[-+0-9-]/.test(head)) return 'obj';
  if (/^\s*solid\b/.test(lower)) return 'stl-ascii'; // 缺 facet：交给 stl 解析器报可读错误
  return null;
}

/**
 * 统一入口：解析 3D 模型。不会抛出（除入参完全非法外），失败时返回带 error 的对象。
 *
 * @param {string} filename 文件名或路径（用于扩展名分派，可为空）
 * @param {Uint8Array|ArrayBuffer} bytes 文件字节
 * @returns {{
 *   format: 'stl'|'obj'|'ply'|'unknown',
 *   variant?: string,
 *   triangles: { positions: Float32Array, normals?: Float32Array, count: number },
 *   bounds: { min: number[], max: number[] },
 *   counts: { vertices: number, triangles: number },
 *   warnings?: string[],
 *   meta?: object,
 *   error?: string
 * }}
 * 说明：counts.vertices 为源顶点数（STL 是三角形汤顶点数 = 3×三角形数；OBJ/PLY 是文件内顶点数）。
 */
export function parseModel(filename, bytes) {
  const ext = extensionOf(filename);

  let u8;
  try {
    u8 = toUint8(bytes);
  } catch (err) {
    return fail('unknown', `3D 模型解析失败：输入不是有效的字节数据（${err.message}）`, ext);
  }
  if (u8.byteLength === 0) return fail('unknown', '3D 模型解析失败：文件为空', ext);

  let format = null;
  const sniffed = sniffFormat(u8);

  // 已知但暂不支持的格式：明确提示（不尝试按内容硬解）
  if (ext in UNSUPPORTED) {
    return fail('unknown', `暂不支持 .${ext} 格式（${UNSUPPORTED[ext]}）；当前支持 STL / OBJ / PLY`, ext);
  }
  if (ext === 'stl') format = 'stl';
  else if (ext === 'obj') format = 'obj';
  else if (ext === 'ply') format = 'ply';
  else if (sniffed === 'ply') format = 'ply';
  else if (sniffed === 'stl-ascii' || sniffed === 'stl-binary') format = 'stl';
  else if (sniffed === 'obj') format = 'obj';

  if (!format) {
    const hint = ext ? `扩展名 ".${ext}" 未知` : '文件没有扩展名';
    return fail('unknown', `无法识别的 3D 模型格式（${hint}，内容也不是 STL/OBJ/PLY）`, ext);
  }

  try {
    let raw;
    if (format === 'stl') raw = parseSTL(u8);
    else if (format === 'obj') raw = parseOBJ(u8);
    else raw = parsePLY(u8);

    return {
      format: raw.format,
      variant: raw.variant,
      triangles: {
        positions: raw.positions,
        ...(raw.normals ? { normals: raw.normals } : {}),
        count: raw.triangleCount,
      },
      bounds: { min: raw.bounds.min, max: raw.bounds.max },
      counts: { vertices: raw.vertexCount, triangles: raw.triangleCount },
      warnings: raw.warnings,
      meta: raw.meta,
    };
  } catch (err) {
    return fail(format, err && err.message ? err.message : String(err), ext);
  }
}

function fail(format, message, ext) {
  return {
    format,
    triangles: { positions: new Float32Array(0), count: 0 },
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    counts: { vertices: 0, triangles: 0 },
    warnings: [],
    meta: { extension: ext || '' },
    error: message,
  };
}

/** 文件名是否是本模块支持的 3D 模型（仅看扩展名，用于文件列表图标/预览注册）。 */
export function isSupportedModelFile(filename) {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(filename));
}

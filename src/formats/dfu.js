// dfu.js — USB DFU 后缀，以及 ST DfuSe（"DfuSe" + Target）多镜像容器。
// CRC 是去掉最后 4 字节后的标准 CRC-32。

import { toBytes } from './text.js';

/**
 * @param {Uint8Array|ArrayBuffer} input
 */
export function parseDfu(input) {
  const blank = {
    vendor: '',
    product: '',
    vendorId: 0,
    productId: 0,
    bcdDevice: '',
    bcdDfu: '',
    crcOk: false,
    crc: 0,
    dfuse: false,
    dfuseVersion: 0,
    targets: [],
    payloadBytes: 0,
    warnings: [],
  };
  let bytes;
  try {
    bytes = toBytes(input);
  } catch (err) {
    return { ok: false, error: 'DFU 解析失败：输入不是字节', ...blank };
  }
  if (bytes.byteLength < 16) return { ok: false, error: '文件太小，不是 DFU', ...blank };
  const signature = ascii(bytes, bytes.byteLength - 8, 3);
  if (signature !== 'UFD') return { ok: false, error: '不是 DFU 文件（末尾没有 UFD 后缀）', ...blank };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const suffix = bytes.byteLength - 16;
  const bLength = bytes[bytes.byteLength - 5];
  const warnings = [];
  if (bLength !== 16) warnings.push(`DFU 后缀 bLength=${bLength}，规范值是 16`);
  const crc = view.getUint32(bytes.byteLength - 4, true);
  const crcCalc = crc32(bytes.subarray(0, bytes.byteLength - 4));
  const bcdDevice = view.getUint16(suffix, true);
  const productId = view.getUint16(suffix + 2, true);
  const vendorId = view.getUint16(suffix + 4, true);
  const bcdDfu = view.getUint16(suffix + 6, true);

  let targets = [];
  let dfuse = false;
  let dfuseVersion = 0;
  if (ascii(bytes, 0, 5) === 'DfuSe') {
    dfuse = true;
    const parsed = parseDfuse(bytes, view, suffix, warnings);
    if (!parsed.ok) return { ok: false, error: parsed.error, ...blank, warnings };
    targets = parsed.targets;
    dfuseVersion = parsed.version;
  } else {
    const payload = bytes.subarray(0, suffix);
    targets = [{
      name: '',
      alt: 0,
      named: false,
      elements: [{ address: 0, size: payload.byteLength, preview: payload.subarray(0, 48) }],
    }];
  }
  let payloadBytes = 0;
  for (const target of targets) {
    for (const element of target.elements) payloadBytes += element.size;
  }
  return {
    ok: true,
    vendor: hex4(vendorId),
    product: hex4(productId),
    vendorId,
    productId,
    bcdDevice: formatBcd(bcdDevice),
    bcdDfu: formatBcd(bcdDfu),
    crcOk: crc === crcCalc,
    crc,
    crcCalc,
    dfuse,
    dfuseVersion,
    targets,
    payloadBytes,
    warnings,
  };
}

/** IEEE CRC-32，DFU 后缀 dwCRC 用的就是它。 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseDfuse(bytes, view, suffix, warnings) {
  if (bytes.byteLength < 11 + 16) return { ok: false, error: 'DfuSe 文件头不完整' };
  const version = bytes[5];
  const imageSize = view.getUint32(6, true);
  const targetCount = bytes[10];
  if (imageSize !== bytes.byteLength) warnings.push(`DfuSe 声明长度 ${imageSize}，文件实际 ${bytes.byteLength} 字节`);
  if (targetCount > 32) return { ok: false, error: `DfuSe target 数量异常（${targetCount}）` };
  let offset = 11;
  const targets = [];
  for (let index = 0; index < targetCount; index++) {
    if (offset + 274 > suffix) return { ok: false, error: 'DfuSe target 头超出文件' };
    if (ascii(bytes, offset, 6) !== 'Target') return { ok: false, error: 'DfuSe target 签名不是 Target' };
    const alt = bytes[offset + 6];
    const named = view.getUint32(offset + 7, true) !== 0;
    const name = decodeName(bytes.subarray(offset + 11, offset + 11 + 255));
    const elementCount = view.getUint32(offset + 270, true);
    offset += 274;
    if (elementCount > 64) return { ok: false, error: `DfuSe 镜像元素数量异常（${elementCount}）` };
    const elements = [];
    for (let n = 0; n < elementCount; n++) {
      if (offset + 8 > suffix) return { ok: false, error: 'DfuSe 元素头超出文件' };
      const address = view.getUint32(offset, true);
      const size = view.getUint32(offset + 4, true);
      offset += 8;
      if (offset + size > suffix) return { ok: false, error: 'DfuSe 元素数据超出文件' };
      elements.push({
        address,
        size,
        preview: bytes.subarray(offset, offset + Math.min(size, 48)),
      });
      offset += size;
    }
    targets.push({ name, alt, named, elements });
  }
  return { ok: true, version, targets };
}

function decodeName(bytes) {
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  const slice = bytes.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(slice).trim();
  } catch (err) {
    return ascii(slice, 0, slice.length).trim();
  }
}

function ascii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length && offset + i < bytes.length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function hex4(value) {
  return `0x${(value & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

function formatBcd(value) {
  const hi = ((value >> 8) & 0xff).toString(16);
  const lo = (value & 0xff).toString(16).padStart(2, '0');
  return `${hi}.${lo}`;
}

// text.js — 各文本格式共用的字节解码。纯 Web API，浏览器和 Node 都能跑。

/** 把 Buffer / ArrayBuffer / TypedArray 收成 Uint8Array（不复制已有的 Uint8Array）。 */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('需要 Uint8Array 或 ArrayBuffer');
}

/** UTF-8 解码，非法字节替换为 U+FFFD，并去掉 BOM。 */
export function decodeUtf8(input) {
  const bytes = toBytes(input);
  const text = typeof TextDecoder === 'function'
    ? new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    : String.fromCharCode.apply(null, bytes.subarray(0, Math.min(bytes.length, 0x8000)));
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

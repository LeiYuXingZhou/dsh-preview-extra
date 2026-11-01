// tests/fixtures.mjs — 手工构造 zip / tar / gzip 测试数据。
// 只在测试里使用 node:zlib / Buffer；库代码本身不依赖 node:*（有静态检查断言）。

import zlib from 'node:zlib';

export function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}
export function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
export function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

export function zipCrc32(data) {
  return zlib.crc32(data) >>> 0;
}

function dosFields(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = ((date.getFullYear() - 1980) & 0x7f) << 9 | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

/**
 * 构造 zip。
 * file 支持字段：
 *   name(string|Buffer)、data(string|Buffer)、method(0|8)、flags、utf8、encrypt、
 *   dataDescriptor、zip64、externalAttrs、dir、dos({time,date})
 */
export function buildZip(files, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dos = options.dos ?? dosFields(new Date(2024, 0, 2, 3, 4, 6));

  for (const file of files) {
    const nameBuf = Buffer.isBuffer(file.name) ? file.name : Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '', 'utf8');
    const method = file.method ?? 0;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zipCrc32(data);

    let flags = file.flags ?? 0;
    if (file.encrypt) flags |= 0x0001;
    if (file.utf8) flags |= 0x0800;
    if (file.dataDescriptor) flags |= 0x0008;
    const dd = file.dataDescriptor === true;
    const z64 = file.zip64 === true;
    const { time, date } = file.dos ?? dos;

    // 本地头：data descriptor 场景大小/CRC 写 0（真实值只在中央目录）
    const localExtra = z64
      ? Buffer.concat([u16(0x0001), u16(16), u64(data.length), u64(compressed.length)])
      : Buffer.alloc(0);
    const localCrc = dd ? 0 : crc;
    const localCsize = dd ? 0 : z64 ? 0xffffffff : compressed.length;
    const localSize = dd ? 0 : z64 ? 0xffffffff : data.length;

    const localParts = [
      u32(0x04034b50),
      u16(z64 ? 45 : 20),
      u16(flags),
      u16(method),
      u16(time),
      u16(date),
      u32(localCrc),
      u32(localCsize),
      u32(localSize),
      u16(nameBuf.length),
      u16(localExtra.length),
      nameBuf,
      localExtra,
      compressed,
    ];
    if (dd) localParts.push(u32(0x08074b50), u32(crc), u32(compressed.length), u32(data.length));

    const local = Buffer.concat(localParts);
    const extAttrs = file.externalAttrs ?? (file.dir ? 0x10 : 0);
    const versionMadeBy = file.versionMadeBy ?? ((3 << 8) | 20); // Unix + 2.0

    if (z64) {
      const cdExtra = Buffer.concat([u16(0x0001), u16(24), u64(data.length), u64(compressed.length), u64(offset)]);
      centrals.push(
        Buffer.concat([
          u32(0x02014b50),
          u16(versionMadeBy),
          u16(45),
          u16(flags),
          u16(method),
          u16(time),
          u16(date),
          u32(crc),
          u32(0xffffffff),
          u32(0xffffffff),
          u16(nameBuf.length),
          u16(cdExtra.length),
          u16(0),
          u16(0),
          u16(0),
          u32(extAttrs),
          u32(0xffffffff),
          nameBuf,
          cdExtra,
        ]),
      );
    } else {
      centrals.push(
        Buffer.concat([
          u32(0x02014b50),
          u16(versionMadeBy),
          u16(20),
          u16(flags),
          u16(method),
          u16(time),
          u16(date),
          u32(crc),
          u32(compressed.length),
          u32(data.length),
          u16(nameBuf.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(extAttrs),
          u32(offset),
          nameBuf,
        ]),
      );
    }
    locals.push(local);
    offset += local.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const parts = [...locals, cdBuf];

  if (options.zip64Eocd) {
    const z64Record = Buffer.concat([
      u32(0x06064b50),
      u64(44),
      u16(45),
      u16(45),
      u32(0),
      u32(0),
      u64(files.length),
      u64(files.length),
      u64(cdBuf.length),
      u64(offset),
    ]);
    const z64Locator = Buffer.concat([u32(0x07064b50), u32(0), u64(offset + cdBuf.length), u32(1)]);
    const eocd = Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(0xffff),
      u16(0xffff),
      u32(0xffffffff),
      u32(0xffffffff),
      u16(comment.length),
      comment,
    ]);
    parts.push(z64Record, z64Locator, eocd);
  } else {
    parts.push(
      Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(files.length),
        u16(files.length),
        u32(cdBuf.length),
        u32(offset),
        u16(comment.length),
        comment,
      ]),
    );
  }
  return Buffer.concat(parts);
}

// —— tar ——

function octal(value, fieldWidth) {
  return value.toString(8).padStart(fieldWidth - 1, '0') + '\0';
}

function tarHeader({ name = '', size = 0, type = '0', mode = 0o644, mtime = 1700000000, linkname = '', prefix = '' }) {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0, 'utf8');
  buf.write(octal(mode, 8), 100, 'binary');
  buf.write(octal(0, 8), 108, 'binary');
  buf.write(octal(0, 8), 116, 'binary');
  buf.write(octal(size, 12), 124, 'binary');
  buf.write(octal(mtime, 12), 136, 'binary');
  buf.fill(0x20, 148, 156); // 校验和字段先填空格
  buf.write(type, 156, 'binary');
  if (linkname) buf.write(linkname.slice(0, 100), 157, 'binary');
  buf.write('ustar', 257, 'binary');
  Buffer.from([0x00, 0x30, 0x30]).copy(buf, 262); // magic "ustar\0" + version "00"
  buf.write('root', 265, 'binary');
  buf.write('root', 297, 'binary');
  if (prefix) buf.write(prefix.slice(0, 155), 345, 'utf8');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'binary');
  return buf;
}

function pad512(data) {
  const rest = data.length % 512;
  if (rest === 0) return data;
  return Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, 'utf8');
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return Buffer.from(`${len}${body}`, 'utf8');
}

function paxPayload(records) {
  return Buffer.concat(Object.entries(records).map(([k, v]) => paxRecord(k, v)));
}

/**
 * 构造 tar。
 * file 支持字段：name、data、dir、type('0'|'5'|'2'...)、mode、mtime、linkname、
 *   longName(用 GNU 'L' 头)、pax({path?, mtime?, size?} 用 PAX 'x' 头)
 */
export function buildTar(files, options = {}) {
  const parts = [];
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '', 'utf8');
    const name = file.name;

    if (file.longName) {
      const longData = Buffer.concat([Buffer.from(name, 'utf8'), Buffer.from([0])]);
      parts.push(tarHeader({ name: '././@LongLink', size: longData.length, type: 'L' }), pad512(longData));
    }
    if (file.pax) {
      const payload = paxPayload(file.pax);
      parts.push(tarHeader({ name: 'PaxHeader', size: payload.length, type: 'x' }), pad512(payload));
    }

    let headerName = name;
    let prefix = '';
    if (!file.longName && Buffer.byteLength(name) > 100) {
      const idx = name.lastIndexOf('/');
      if (idx > 0 && idx <= 155 && Buffer.byteLength(name.slice(idx + 1)) <= 100) {
        prefix = name.slice(0, idx);
        headerName = name.slice(idx + 1);
      }
    }

    const type = file.type ?? (file.dir ? '5' : '0');
    parts.push(
      tarHeader({
        name: headerName,
        size: file.dir ? 0 : data.length,
        type,
        mode: file.mode ?? 0o644,
        mtime: file.mtime ?? 1700000000,
        linkname: file.linkname ?? '',
        prefix,
      }),
    );
    if (!file.dir && data.length) parts.push(pad512(data));
  }
  parts.push(Buffer.alloc(1024)); // 结束块
  return Buffer.concat(parts);
}

// —— gzip ——

/**
 * 手写 gzip（含 FNAME/FCOMMENT/mtime），避免依赖 zlib 的头部实现细节。
 * @param {Buffer|string} data
 * @param {{originalName?: string|null, comment?: string|null, mtime?: number, extra?: Buffer|null}} [options]
 */
export function buildGzip(data, options = {}) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const name = options.originalName ?? null;
  const comment = options.comment ?? null;
  const mtime = options.mtime ?? 0;
  let flags = 0;
  if (options.extra) flags |= 0x04;
  if (name) flags |= 0x08;
  if (comment) flags |= 0x10;

  const header = [
    Buffer.from([0x1f, 0x8b, 0x08, flags]),
    u32(mtime),
    Buffer.from([0x00, 0xff]), // XFL, OS
  ];
  if (options.extra) header.push(u16(options.extra.length), options.extra);
  if (name) header.push(Buffer.from(name, 'utf8'), Buffer.from([0]));
  if (comment) header.push(Buffer.from(comment, 'utf8'), Buffer.from([0]));

  const trailer = Buffer.concat([u32(zipCrc32(body)), u32(body.length & 0xffffffff)]);
  return Buffer.concat([...header, zlib.deflateRawSync(body), trailer]);
}

/** 便捷：把任意字节包装成只含一个条目的 tar（用于制造 .tar.gz）。 */
export function tarWithFiles(files) {
  return buildTar(files);
}

export { u32be };

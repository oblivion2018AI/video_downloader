'use strict';
const crypto = require('crypto');

// gorgon_84 常量
const G84 = Buffer.from([0x4a, 0x16, 0x47, 0x6c, 0x84, 0x04]);
const XG_SEED = 320;
const MSSDK_VERSION = 67503104; // 0x04060400

function rc4Xg(data, key) {
  // 注意：这是被改造过的 RC4 —— S[i] = S[j] 是单向赋值，不做交换
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) % 256;
    S[i] = S[j];
  }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i += 1;
    const x = S[i];
    j += x;
    const y = S[j & 0xff];
    S[i] = y;
    out[k] = data[k] ^ S[(y + y) & 0xff];
  }
  return out;
}

const REV8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, r = 0;
  for (let b = 0; b < 8; b++) { r = (r << 1) | (v & 1); v >>= 1; }
  REV8[i] = r;
}

// x-ss-stub: body 的 MD5（大写十六进制）
function xssStub(body, dataType) {
  if (!body) return '';
  let buf;
  if (typeof body === 'string') buf = Buffer.from(body, 'utf8');
  else if (Buffer.isBuffer(body)) buf = body;
  else buf = Buffer.from(JSON.stringify(body), 'utf8');
  return crypto.createHash('md5').update(buf).digest('hex').toUpperCase();
}

// 核心：生成 X-Gorgon
// bodyObj   : 请求体对象（或 null）
// queryStr  : 最终发送的 URL 查询串（必须与实际请求一致）
// khronos   : Unix 秒
// xgRand    : 0..0xFFFF
function encryptGorgon(bodyObj, queryStr, khronos, xgRand) {
  const bodyMd5 = bodyObj ? xssStub(bodyObj).toLowerCase() : '';

  const parts = [];
  parts.push(crypto.createHash('md5').update(queryStr, 'utf8').digest().subarray(0, 4));
  parts.push(bodyMd5 ? Buffer.from(bodyMd5, 'hex').subarray(0, 4) : Buffer.from([0, 0, 0, 0]));
  parts.push(Buffer.from([0, 0, 0, 0]));
  const ver = Buffer.alloc(4); ver.writeUInt32LE(MSSDK_VERSION >>> 0, 0); parts.push(ver);
  const kh = Buffer.alloc(4); kh.writeUInt32BE(khronos >>> 0, 0); parts.push(kh);
  const data = Buffer.concat(parts);

  const key = Buffer.from([
    G84[0],
    XG_SEED & 0xff,
    G84[1],
    (xgRand >> 8) & 0xff,
    G84[2],
    G84[3],
    (XG_SEED >> 8) & 0xff,
    xgRand & 0xff,
  ]);

  const out = rc4Xg(data, key);
  for (let i = 0; i < out.length; i++) {
    const sw = out[i];
    out[i] = ((sw >> 4) | (sw << 4)) & 0xff;
    // Python: a 默认取 out[0]，仅当存在下一字节时取 out[i+1]
    let a = out[0];
    if (i + 1 < out.length) a = out[i + 1];
    a ^= out[i];
    a = REV8[a & 0xff];
    out[i] = (~(a ^ 20)) & 0xff;
  }

  const ret = Buffer.concat([
    G84.subarray(G84.length - 2),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(xgRand, 0); return b; })(),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(XG_SEED, 0); return b; })(),
    out,
  ]);
  return ret.toString('hex');
}

module.exports = { encryptGorgon, xssStub, rc4Xg };

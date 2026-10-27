'use strict';
// Port of flurl/extra.py — custom MD5 variants, AES_V3, hash_f13 and branch logic.
const crypto = require('crypto');
const { sm3 } = require('./sm3');
const { SV, SV2, S_BOX, INV_S_BOX, BRANCH_2_ORDERS } = require('./tables');

const MASK64 = (1n << 64n) - 1n;

function u32(x) { return x >>> 0; }

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }

function leftCircularShift(k, bits) {
  bits = ((bits % 32) + 32) % 32;
  const kk = u32(k);
  const upper = u32(kk << bits);
  return u32(upper | (kk >>> (32 - bits)));
}
const rol = leftCircularShift;

function ror32(value, count) {
  count = ((count % 32) + 32) % 32;
  value = u32(value);
  if (count === 0) return value;
  return u32((value >>> count) | (value << (32 - count)));
}

function ror(value, count) {
  let v = BigInt(value) & MASK64;
  count = ((count % 64) + 64) % 64;
  if (count === 0) return v;
  const low = (v << BigInt(64 - count)) & MASK64;
  return (low | (v >> BigInt(count))) & MASK64;
}

function rl8(x, k) {
  k = ((k % 8) + 8) % 8;
  return u32((x << k) | (x >>> (8 - k))) & 0xff;
}

// ===== get_key_hash =====
function get_key_hash(key, rand) {
  const toHash = Buffer.alloc(68);
  key.copy(toHash, 0, 0, 32);
  toHash.writeUInt32LE(u32(rand), 32);
  key.copy(toHash, 36, 0, 32);

  const d1 = (rand >>> 16) & 0xff;
  let d2 = u32((d1 << 11) | (rand >>> 24));
  d2 = u32(d2 ^ ((d1 >>> 5) ^ d1));
  d2 = u32(~d2);

  const seed = Buffer.alloc(4);
  seed.writeUInt32LE(d2, 0);
  return { hash: sm3(toHash), seed };
}

// ===== block / matrix helpers =====
function blockDivide(block, chunks) {
  const size = Math.floor(block.length / chunks);
  const out = new Array(chunks);
  for (let i = 0; i < chunks; i++) out[i] = block.readUInt32LE(i * size);
  return out;
}

function bytes2matrix(text) {
  const rows = [];
  for (let i = 0; i < text.length; i += 4) rows.push([text[i], text[i + 1], text[i + 2], text[i + 3]]);
  return rows;
}
function matrix2bytes(matrix) {
  const out = [];
  for (let i = 0; i < matrix.length; i++) for (let j = 0; j < 4; j++) out.push(matrix[i][j] & 0xff);
  return Buffer.from(out);
}
function xorBytes(a, b) {
  const n = Math.min(a.length, b.length);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] ^ b[i]) & 0xff;
  return out;
}
function addRoundKey(s, k) {
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s[i][j] ^= k[i][j];
}
function addRoundKeyCon(s, k, con) {
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s[i][j] ^= k[i][con[j]];
}
function mixSingleColumn(a, i) {
  const t = a[0][i] ^ a[1][i] ^ a[2][i] ^ a[3][i];
  const u = a[0][i];
  a[0][i] ^= t ^ xtime(a[0][i] ^ a[1][i]);
  a[1][i] ^= t ^ xtime(a[1][i] ^ a[2][i]);
  a[2][i] ^= t ^ xtime(a[2][i] ^ a[3][i]);
  a[3][i] ^= t ^ xtime(a[3][i] ^ u);
}
function mixColumnsState(s) {
  for (let i = 0; i < 4; i++) mixSingleColumn(s, i);
}

// ===== custom MD5 (fixed-table) =====
function F(X, Y, Z) { return u32((X & Y) | (~X & Z)); }
function G(X, Y, Z) { return u32((X & Z) | (Y & ~Z)); }
function H(X, Y, Z) { return u32(X ^ Y ^ Z); }
function I(X, Y, Z) { return u32(Y ^ (X | ~Z)); }
function FF(a, b, c, d, M, s, t) { return u32(b + leftCircularShift(u32(a + F(b, c, d) + M + t), s)); }
function GG(a, b, c, d, M, s, t) { return u32(b + leftCircularShift(u32(a + G(b, c, d) + M + t), s)); }
function HH(a, b, c, d, M, s, t) { return u32(b + leftCircularShift(u32(a + H(b, c, d) + M + t), s)); }
function II(a, b, c, d, M, s, t) { return u32(b + leftCircularShift(u32(a + I(b, c, d) + M + t), s)); }

function sum_md5(data) {
  let checkSum = 0x20220420;
  for (let i = 0; i < 12; i++) {
    let temp;
    if (i % 2 === 0) {
      temp = u32((checkSum >>> 3) ^ checkSum);
      checkSum = u32(data[i] ^ (checkSum << 7));
    } else {
      temp = u32((checkSum >>> 5) ^ checkSum);
      checkSum = u32(data[i] | (checkSum << 11));
      checkSum = u32(checkSum ^ 0xffffffff);
    }
    checkSum = u32(checkSum ^ temp);
  }
  checkSum = u32(checkSum | 4);
  checkSum = u32(checkSum ^ 0x1000000);
  return checkSum;
}

function md5sum(msg) {
  const A0 = 0x79e0f2fb, B0 = 0xc8b52570, C0 = 0xebc2f8cd, D0 = 0x7c104d93;
  let a = A0, b = B0, c = C0, d = D0;
  const M = blockDivide(msg.subarray(0, 64), 16);

  a = FF(a, b, c, d, M[0], 7, SV[0]);
  d = FF(d, a, b, c, M[13], 12, SV[1]);
  c = FF(c, d, a, b, M[14], 17, SV[2]);
  b = FF(b, c, d, a, M[12], 22, SV[3]);
  a = FF(a, b, c, d, M[11], 7, SV[4]);
  d = FF(d, a, b, c, M[10], 12, SV[5]);
  c = FF(c, d, a, b, M[9], 17, SV[6]);
  b = FF(b, c, d, a, M[7], 22, SV[7]);
  a = FF(a, b, c, d, M[8], 7, SV[8]);
  d = FF(d, a, b, c, M[6], 12, SV[9]);
  c = FF(c, d, a, b, M[5], 17, SV[10]);
  b = FF(b, c, d, a, M[4], 22, SV[11]);
  a = FF(a, b, c, d, M[3], 7, SV[12]);
  d = FF(d, a, b, c, M[2], 12, SV[13]);
  c = FF(c, d, a, b, M[1], 17, SV[14]);
  b = FF(b, c, d, a, M[15], 22, SV[15]);

  a = GG(a, b, c, d, M[0], 5, SV[16]);
  d = GG(d, a, b, c, M[5], 9, SV[17]);
  c = GG(c, d, a, b, M[10], 14, SV[18]);
  b = GG(b, c, d, a, M[1], 20, SV[19]);
  a = GG(a, b, c, d, M[12], 5, SV[20]);
  d = GG(d, a, b, c, M[11], 9, SV[21]);
  c = GG(c, d, a, b, M[15], 14, SV[22]);
  b = GG(b, c, d, a, M[2], 20, SV[23]);
  a = GG(a, b, c, d, M[9], 5, SV[24]);
  d = GG(d, a, b, c, M[13], 9, SV[25]);
  c = GG(c, d, a, b, M[3], 14, SV[26]);
  b = GG(b, c, d, a, M[8], 20, SV[27]);
  a = GG(a, b, c, d, M[6], 5, SV[28]);
  d = GG(d, a, b, c, M[7], 9, SV[29]);
  c = GG(c, d, a, b, M[4], 14, SV[30]);
  b = GG(b, c, d, a, M[14], 20, SV[31]);

  a = HH(a, b, c, d, M[8], 4, SV[32]);
  d = HH(d, a, b, c, M[5], 11, SV[33]);
  c = HH(c, d, a, b, M[12], 16, SV[34]);
  b = HH(b, c, d, a, M[13], 23, SV[35]);
  a = HH(a, b, c, d, M[1], 4, SV[36]);
  d = HH(d, a, b, c, M[12], 11, SV[37]);
  c = HH(c, d, a, b, M[7], 16, SV[38]);
  b = HH(b, c, d, a, M[14], 23, SV[39]);
  a = HH(a, b, c, d, M[10], 4, SV[40]);
  d = HH(d, a, b, c, M[0], 11, SV[41]);
  c = HH(c, d, a, b, M[2], 16, SV[42]);
  b = HH(b, c, d, a, M[6], 23, SV[43]);
  a = HH(a, b, c, d, M[4], 4, SV[44]);
  d = HH(d, a, b, c, M[11], 11, SV[45]);
  c = HH(c, d, a, b, M[15], 16, SV[46]);
  b = HH(b, c, d, a, M[3], 23, SV[47]);

  a = II(a, b, c, d, M[8], 6, SV[48]);
  d = II(d, a, b, c, M[6], 10, SV[49]);
  c = II(c, d, a, b, M[15], 15, SV[50]);
  b = II(b, c, d, a, M[5], 21, SV[51]);
  a = II(a, b, c, d, M[14], 6, SV[52]);
  d = II(d, a, b, c, M[9], 10, SV[53]);
  c = II(c, d, a, b, M[10], 15, SV[54]);
  b = II(b, c, d, a, M[2], 21, SV[55]);
  a = II(a, b, c, d, M[2], 6, SV[56]);
  d = II(d, a, b, c, M[13], 10, SV[57]);
  c = II(c, d, a, b, M[7], 15, SV[58]);
  b = II(b, c, d, a, M[12], 21, SV[59]);
  a = II(a, b, c, d, M[4], 6, SV[60]);
  d = II(d, a, b, c, M[1], 10, SV[61]);
  c = II(c, d, a, b, M[11], 15, SV[62]);
  b = II(b, c, d, a, M[3], 21, SV[63]);

  const A = u32(u32(A0 + a) ^ 0x19be4866);
  const B = u32(u32(B0 + b) ^ 0xe85986b4);
  const C = u32(u32(C0 + c) ^ 0xe19b326e);
  const D = u32(u32(D0 + d) ^ 0x71d1d7d4);

  const result = Buffer.alloc(20);
  result.writeUInt32LE(A, 0);
  result.writeUInt32LE(B, 4);
  result.writeUInt32LE(C, 8);
  result.writeUInt32LE(D, 12);
  result.writeUInt32LE(sum_md5(result.subarray(0, 16)), 16);
  return result;
}

function md5sum_v3(msg, count_v2, orders, count_v1) {
  let count = count_v2 & 0xff;
  const sv = new Array(64);
  for (let i = 0; i < 64; i++) sv[i] = ror32(SV2[i], count_v1);

  const start = [
    ror32(0x79e0f2fb, count), ror32(0xc8b52570, count),
    ror32(0xebc2f8cd, count), ror32(0x7c104d93, count),
  ];
  count = (count_v2 + 6) & 0xff;
  const end = [
    ror32(0x19be4866, count), ror32(0xe85986b4, count),
    ror32(0xe19b326e, count), ror32(0x71d1d7d4, count),
  ];

  const A0 = start[0], B0 = start[1], C0 = start[2], D0 = start[3];
  let a = A0, b = B0, c = C0, d = D0;
  const M = blockDivide(msg.subarray(0, 64), 16);

  const o1 = orders.subarray(0, 16);
  const o2 = orders.subarray(16, 32);
  const o3 = orders.subarray(32, 48);
  const o4 = orders.subarray(48, 64);

  a = FF(a, b, c, d, M[o1[0]], 7, sv[0]);
  d = FF(d, a, b, c, M[o1[1]], 12, sv[1]);
  c = FF(c, d, a, b, M[o1[2]], 17, sv[2]);
  b = FF(b, c, d, a, M[o1[3]], 22, sv[3]);
  a = FF(a, b, c, d, M[o1[4]], 7, sv[4]);
  d = FF(d, a, b, c, M[o1[5]], 12, sv[5]);
  c = FF(c, d, a, b, M[o1[6]], 17, sv[6]);
  b = FF(b, c, d, a, M[o1[7]], 22, sv[7]);
  a = FF(a, b, c, d, M[o1[8]], 7, sv[8]);
  d = FF(d, a, b, c, M[o1[9]], 12, sv[9]);
  c = FF(c, d, a, b, M[o1[10]], 17, sv[10]);
  b = FF(b, c, d, a, M[o1[11]], 22, sv[11]);
  a = FF(a, b, c, d, M[o1[12]], 7, sv[12]);
  d = FF(d, a, b, c, M[o1[13]], 12, sv[13]);
  c = FF(c, d, a, b, M[o1[14]], 17, sv[14]);
  b = FF(b, c, d, a, M[o1[15]], 22, sv[15]);

  a = GG(a, b, c, d, M[o2[0]], 5, sv[16]);
  d = GG(d, a, b, c, M[o2[1]], 9, sv[17]);
  c = GG(c, d, a, b, M[o2[2]], 14, sv[18]);
  b = GG(b, c, d, a, M[o2[3]], 20, sv[19]);
  a = GG(a, b, c, d, M[o2[4]], 5, sv[20]);
  d = GG(d, a, b, c, M[o2[5]], 9, sv[21]);
  c = GG(c, d, a, b, M[o2[6]], 14, sv[22]);
  b = GG(b, c, d, a, M[o2[7]], 20, sv[23]);
  a = GG(a, b, c, d, M[o2[8]], 5, sv[24]);
  d = GG(d, a, b, c, M[o2[9]], 9, sv[25]);
  c = GG(c, d, a, b, M[o2[10]], 14, sv[26]);
  b = GG(b, c, d, a, M[o2[11]], 20, sv[27]);
  a = GG(a, b, c, d, M[o2[12]], 5, sv[28]);
  d = GG(d, a, b, c, M[o2[13]], 9, sv[29]);
  c = GG(c, d, a, b, M[o2[14]], 14, sv[30]);
  b = GG(b, c, d, a, M[o2[15]], 20, sv[31]);

  a = HH(a, b, c, d, M[o3[0]], 4, sv[32]);
  d = HH(d, a, b, c, M[o3[1]], 11, sv[33]);
  c = HH(c, d, a, b, M[o3[2]], 16, sv[34]);
  b = HH(b, c, d, a, M[o3[3]], 23, sv[35]);
  a = HH(a, b, c, d, M[o3[4]], 4, sv[36]);
  d = HH(d, a, b, c, M[o3[5]], 11, sv[37]);
  c = HH(c, d, a, b, M[o3[6]], 16, sv[38]);
  b = HH(b, c, d, a, M[o3[7]], 23, sv[39]);
  a = HH(a, b, c, d, M[o3[8]], 4, sv[40]);
  d = HH(d, a, b, c, M[o3[9]], 11, sv[41]);
  c = HH(c, d, a, b, M[o3[10]], 16, sv[42]);
  b = HH(b, c, d, a, M[o3[11]], 23, sv[43]);
  a = HH(a, b, c, d, M[o3[12]], 4, sv[44]);
  d = HH(d, a, b, c, M[o3[13]], 11, sv[45]);
  c = HH(c, d, a, b, M[o3[14]], 16, sv[46]);
  b = HH(b, c, d, a, M[o3[15]], 23, sv[47]);

  a = II(a, b, c, d, M[o4[0]], 6, sv[48]);
  d = II(d, a, b, c, M[o4[1]], 10, sv[49]);
  c = II(c, d, a, b, M[o4[2]], 15, sv[50]);
  b = II(b, c, d, a, M[o4[3]], 21, sv[51]);
  a = II(a, b, c, d, M[o4[4]], 6, sv[52]);
  d = II(d, a, b, c, M[o4[5]], 10, sv[53]);
  c = II(c, d, a, b, M[o4[6]], 15, sv[54]);
  b = II(b, c, d, a, M[o4[7]], 21, sv[55]);
  a = II(a, b, c, d, M[o4[8]], 6, sv[56]);
  d = II(d, a, b, c, M[o4[9]], 10, sv[57]);
  c = II(c, d, a, b, M[o4[10]], 15, sv[58]);
  b = II(b, c, d, a, M[o4[11]], 21, sv[59]);
  a = II(a, b, c, d, M[o4[12]], 6, sv[60]);
  d = II(d, a, b, c, M[o4[13]], 10, sv[61]);
  c = II(c, d, a, b, M[o4[14]], 15, sv[62]);
  b = II(b, c, d, a, M[o4[15]], 21, sv[63]);

  const A = u32(u32(A0 + a) ^ end[0]);
  const B = u32(u32(B0 + b) ^ end[1]);
  const C = u32(u32(C0 + c) ^ end[2]);
  const D = u32(u32(D0 + d) ^ end[3]);

  const result = Buffer.alloc(20);
  result.writeUInt32LE(A, 0);
  result.writeUInt32LE(B, 4);
  result.writeUInt32LE(C, 8);
  result.writeUInt32LE(D, 12);
  result.writeUInt32LE(sum_md5(result.subarray(0, 16)), 16);
  return result;
}

// ===== hash_f13 =====
function get_iv(iv, data) {
  for (let i = 0; i < data.length; i++) {
    if ((i & 1) === 0) {
      iv = u32((iv >>> 4) ^ iv ^ (iv << 6) ^ data[i]);
    } else {
      iv = u32(~((iv >>> 7) ^ iv ^ (data[i] | (iv << 12))));
    }
  }
  return iv;
}

const B0_TT01 = [0xc4a78580, 0xb3c0fd39, 0xc58c5686, 0xc9aa3ba7, 0xf5a7adf2, 0x963c2ed1];
const B0_TT02 = [
  0xebb64faf, 0x7aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
  0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
  0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
  0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
  0x617ce2a6, 0xe423417e, 0xa40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x5b23bb3,
  0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
  0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
  0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x284ba7, 0x8387cfa, 0x5fb37586,
];
const B0_SEED = [0xfa, 0x45, 0x61, 0xd7];

function branch0_xor(data, base, di, tt03, round, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10) {
  const d = data.slice();
  for (let i = 0; i < round; i++) {
    let offset = base + i;
    const n0 = di[offset & 127];

    const n1 = ((d[x3] ^ d[x4]) & d[x1]) ^ d[x3];
    const n2 = rol(d[x1], 26) ^ rol(d[x1], 21) ^ rol(d[x1], 7);
    offset = offset & 63;
    const n3 = tt03[offset];
    const n4 = u32(n0 + n1 + n2 + n3 + d[x5]);
    const n5 = rol(d[x2], 30) ^ rol(d[x2], 19) ^ rol(d[x2], 10);
    const n6 = (d[x2] & d[x6]) | ((d[x2] | d[x6]) & d[x7]);
    const n7 = u32(n5 + n6);
    const o = d[x9];

    const rot = [d[7], d[0], d[1], d[2], d[3], d[4], d[5], d[6]];
    for (let k = 0; k < 8; k++) d[k] = rot[k];
    d[x10] = u32(n7 + n4);
    d[x8] = u32(o + n4);
  }
  return d;
}

function branch_0(iv_v0, khronos, query_sm3, body_md5_bytes, ts_bytes) {
  const iv_v1 = B0_TT01[iv_v0];
  const count_v1 = (iv_v1 + khronos + 1) & 0xff;
  const count_v2_0 = u32(iv_v1 + khronos);

  const tt03 = new Array(64);
  for (let i = 0; i < 64; i++) tt03[i] = ror32(B0_TT02[i], count_v1);

  const n0 = (count_v2_0 + 2) & 7;
  const pad = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) pad[i] = ((B0_SEED[i] * 257) >>> n0) & 0xff;

  const suffix = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xa0]);
  const data = Buffer.concat([query_sm3, body_md5_bytes, ts_bytes, pad, suffix]);

  const di = new Array(data.length / 4);
  for (let i = 0; i < di.length; i++) di[i] = data.readUInt32BE(i * 4);

  let di0 = di[0];
  for (let i = 0; i < 112; i++) {
    const di1 = di[i + 1];
    const di14 = di[i + 14];
    const r_di1 = rol(di1, 14) ^ rol(di1, 25) ^ (di1 >>> 3);
    const r_di2 = rol(di14, 13) ^ rol(di14, 15) ^ (di14 >>> 10);
    di0 = u32(di0 + di[i + 9] + r_di1 + r_di2);
    di.push(di0);
    di0 = di1;
  }

  const c2 = count_v2_0 & 0xff;
  const initValue = [
    ror32(0x7aba4fc8, c2), ror32(0x67166507, c2), ror32(0x6403fa00, c2), ror32(0x340f512f, c2),
    ror32(984304912, c2), ror32(3005047866, c2), ror32(2874125293, c2), ror32(2152413264, c2),
  ];

  let v_j;
  if (iv_v0 === 5) v_j = branch0_xor(initValue, iv_v1, di, tt03, 100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5);
  else if (iv_v0 === 4) v_j = branch0_xor(initValue, iv_v1, di, tt03, 96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4);
  else if (iv_v0 === 3) v_j = branch0_xor(initValue, iv_v1, di, tt03, 99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6);
  else if (iv_v0 === 2) v_j = branch0_xor(initValue, iv_v1, di, tt03, 96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5);
  else if (iv_v0 === 1) v_j = branch0_xor(initValue, iv_v1, di, tt03, 96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4);
  else v_j = branch0_xor(initValue, iv_v1, di, tt03, 101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3);

  const raw = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) raw.writeUInt32BE(u32(v_j[i] + initValue[i]), i * 4);
  return finalizeHash(raw);
}

// ===== branch 1 =====
let BRANCH_ONE_TABLE = null;
function getBranchOneTable() {
  if (BRANCH_ONE_TABLE === null) {
    const fs = require('fs');
    const path = require('path');
    BRANCH_ONE_TABLE = fs.readFileSync(path.join(__dirname, 'branch_one.bin'));
  }
  return BRANCH_ONE_TABLE;
}

function get_branch_1_table_f(iv_v0) {
  const table = getBranchOneTable();
  const base = iv_v0 << 14;
  return (x) => table.readBigUInt64LE(base + x);
}

function r00(r0, r1, r2, r3, r4, r5, r6, r7, tt, table_f) {
  let x = table_f(Number((r0 >> 56n) * 8n));
  const r1i = Number((r1 >> 45n) & 2040n);
  if (tt > 0n) x = x ^ tt;
  x = x ^ table_f(r1i + 2048);

  const r2i = Number((r2 >> 37n) & 2040n);
  x = x ^ table_f(r2i + 4096);
  const r3i = Number((r3 >> 29n) & 2040n);
  x = x ^ table_f(r3i + 6144);
  const r4i = Number((r4 >> 21n) & 2040n);
  x = x ^ table_f(r4i + 8192);
  const r5i = Number((r5 >> 13n) & 2040n);
  x = x ^ table_f(r5i + 10240);
  const r6i = Number((r6 >> 8n) & 255n);
  x = x ^ table_f(r6i * 8 + 12288);
  const r7i = Number(r7 & 255n);
  x = x ^ table_f(r7i * 8 + 14336);
  return x & MASK64;
}

function swap_v0(src, src_xor, tt2, table_f, order1, typ) {
  const da0 = new Array(8);
  const ha0 = src_xor.slice();
  for (let i = 0; i < 8; i++) da0[i] = src[order1[i]] ^ src_xor[i];

  for (let round = 0; round < 10; round++) {
    const rr = new Array(8);
    for (let k = 0; k < 8; k++) {
      const idx = (a) => ha0[(k + a) % 8];
      rr[k] = r00(idx(0), idx(1), idx(2), idx(3), idx(4), idx(5), idx(6), idx(7), 0n, table_f);
    }
    rr[7] = (rr[7] ^ tt2[round + 1]) & MASK64;

    const d = da0.slice();
    for (let k = 0; k < 8; k++) {
      const idx = (a) => d[(k + a) % 8];
      da0[k] = r00(idx(0), idx(1), idx(2), idx(3), idx(4), idx(5), idx(6), idx(7), rr[k], table_f);
    }
    for (let k = 0; k < 8; k++) ha0[k] = rr[k];
  }

  if (typ === undefined || typ === null) {
    src[0] = (da0[0] ^ src_xor[0] ^ src[0]) & MASK64;
    src[1] = (da0[7] ^ src_xor[1] ^ src[1]) & MASK64;
    src[2] = (da0[6] ^ src_xor[2] ^ src[2]) & MASK64;
    src[3] = (da0[5] ^ src_xor[3] ^ src[3]) & MASK64;
    src[4] = (da0[4] ^ src_xor[4] ^ src[4]) & MASK64;
    src[5] = (da0[3] ^ src_xor[5] ^ src[5]) & MASK64;
    src[6] = (da0[2] ^ src_xor[6] ^ src[6]) & MASK64;
    src[7] = (da0[1] ^ src_xor[7] ^ src[7]) & MASK64;
  } else {
    src[0] = (da0[7] ^ typ[1]) & MASK64;
    src[1] = (da0[6] ^ typ[2]) & MASK64;
    src[2] = (da0[5] ^ typ[3]) & MASK64;
    src[3] = (da0[4] ^ typ[4]) & MASK64;
    src[4] = (da0[3] ^ typ[5]) & MASK64;
    src[5] = (da0[2] ^ typ[6]) & MASK64;
    src[6] = (da0[1] ^ typ[7] ^ src[7]) & MASK64;
    src[7] = (da0[0] ^ typ[0]) & MASK64;
  }
  return src;
}

const B1_TT1 = [0x808a9c79, 0xf079807e, 0xbadf79c5, 0xa785d3ff, 0x82d8438c];
const B1_ORDERS = Buffer.from([
  0x05, 0x07, 0x01, 0x02, 0x04, 0x00, 0x06, 0x03,
  0x00, 0x05, 0x02, 0x04, 0x01, 0x03, 0x07, 0x06,
  0x05, 0x07, 0x02, 0x04, 0x01, 0x06, 0x03, 0x00,
  0x03, 0x00, 0x02, 0x04, 0x06, 0x07, 0x01, 0x05,
  0x04, 0x05, 0x00, 0x03, 0x06, 0x02, 0x01, 0x07,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const B1_TT1_64 = [
  0x87aeea5dab37cd6bn, 0x7ff48becb4f54087n, 0xb0724c06706bbd5dn, 0x1fe5dfb1143e328dn,
  0x1a2331d00af4f1f2n, 0xcaff7131bb1e71ban, 0x33385e1042752218n, 0xff01ed65d4a441fbn,
  0xadb1ec8828c80e8n, 0x62475d12f4e06fe7n, 0xbd0b238da4fe72n,
];

function branch_1(iv_v0, khronos, query_sm3, body_md5_bytes, ts_bytes) {
  const iv_v1a = B1_TT1[iv_v0];
  let c_v1 = (iv_v1a + khronos) & 0xff;
  c_v1 = ror(BigInt(khronos), c_v1);

  const order1 = [];
  const base = iv_v0 * 8;
  for (let i = 0; i < 8; i++) order1[i] = B1_ORDERS[base + i];

  const iv_v1b = (iv_v1a + khronos + 1) & 63;
  const tt2 = new Array(11);
  for (let i = 0; i < 11; i++) tt2[i] = ror(B1_TT1_64[i], iv_v1b);

  const tail = Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const toSign = Buffer.concat([query_sm3, body_md5_bytes, ts_bytes, tail]);

  const src = new Array(toSign.length / 8);
  for (let i = 0; i < src.length; i++) src[i] = toSign.readBigUInt64BE(i * 8);

  const srcXor = new Array(8).fill(c_v1);
  const tableF = get_branch_1_table_f(iv_v0);

  let swap = swap_v0(src, srcXor, tt2, tableF, order1, null);

  const data = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 416n];
  const srcXor2 = [swap[4], swap[3], swap[2], swap[1], swap[0], swap[7], swap[6], swap[5]];
  swap = swap_v0(data, srcXor2, tt2, tableF, order1, swap);

  const raw = Buffer.alloc(32);
  let n = 0;
  for (let i = 7; i >= 0; i--) {
    const pp = Buffer.alloc(8);
    pp.writeBigUInt64LE(swap[i] & MASK64, 0);
    raw[n + 0] = pp[1];
    raw[n + 1] = pp[3];
    raw[n + 2] = pp[5];
    raw[n + 3] = pp[6];
    n += 4;
  }
  return finalizeHash(raw);
}

// ===== branch 2 =====
const B2_T001 = [0x8980f29b, 0xeb549c7f, 0xb08726db, 0xd40cb5e6, 0xe8f559e4];
const B2_SEED = [0x84, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8];

function branch_2(iv, khronos, query_sm3, body_md5_bytes, ts_bytes) {
  const n00 = ((iv & (15 - 2)) * 86);
  const iv_v0 = ((n00 >> 15) & 0xff) + ((n00 >> 8) & 0xff);

  const n1 = B2_T001[iv_v0];
  const count_v1 = (n1 + khronos + 1) & 0xff;
  const count_v2 = u32(n1 + khronos);

  const n0 = (count_v2 + 5) & 7;
  const pad = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) pad[i] = ((B2_SEED[i] * 257) >>> n0) & 0xff;

  const data = Buffer.concat([query_sm3, body_md5_bytes, ts_bytes, pad, Buffer.from([0xa0, 0x01, 0x00, 0x00])]);
  const idx = iv_v0 << 6;
  let orders = null;
  // BRANCH_2_ORDERS is a flat 320-byte table; slice 64 entries as bytes
  const all = BRANCH_2_ORDERS;
  orders = all.subarray(idx, idx + 64);
  return md5sum_v3(data, count_v2, orders, count_v1);
}

function finalizeHash(raw32) {
  const out = Buffer.alloc(20);
  for (let i = 0; i < 16; i++) out[i] = raw32[i] ^ raw32[i + 16];
  out.writeUInt32LE(sum_md5(out.subarray(0, 16)), 16);
  return out;
}

function hash_f13(query_sm3, body_md5_bytes, ts_bytes, khronos) {
  let iv = get_iv(0x20230928, query_sm3);
  iv = get_iv(iv, body_md5_bytes);
  iv = get_iv(iv, ts_bytes);

  const iv_v0 = ((iv & 15) * 171) >> 9;
  const branch = (iv & 15) - ((iv_v0 * 3) & 0xff);
  if (branch === 0) return branch_0(iv_v0, khronos, query_sm3, body_md5_bytes, ts_bytes);
  if (branch === 1) return branch_1(iv_v0, khronos, query_sm3, body_md5_bytes, ts_bytes);
  if (branch === 2) return branch_2(iv, khronos, query_sm3, body_md5_bytes, ts_bytes);
  throw new Error('no branch: ' + branch);
}

// ===== AES_V3 =====
const AES_R_CON = [[1, 0, 2, 3], [1, 3, 0, 2], [0, 1, 3, 2], [1, 0, 2, 3]];
const AES_R_CON2 = [[1, 0, 2, 3], [2, 0, 3, 1], [0, 1, 3, 2], [1, 0, 2, 3]];
const AES_R_ORDERS = [
  [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
  [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
  [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
  [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
];

class AES_V3 {
  constructor(aesKey, khronos) {
    this.wordSize = khronos & 3;
    this.aesKey = aesKey;
    this.sBox = S_BOX.subarray(this.wordSize << 8);
    this.invSBox = INV_S_BOX.subarray(this.wordSize << 8);
    this.masterKey = this._expandKey();
    this.keyMatrices = bytes2matrix(this.masterKey);
    this.con = AES_R_CON[this.wordSize];
    this.con2 = AES_R_CON2[this.wordSize];
    this.order = AES_R_ORDERS[this.wordSize];
  }

  _expandKey() {
    const initValues = [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f];
    const initValue = initValues[this.wordSize];
    let mk = Buffer.alloc(4);
    mk.writeUInt32LE(initValue >>> 0, 0);
    mk = Buffer.concat([mk, mk, mk, mk]);
    mk = xorBytes(mk, this.aesKey);
    mk = Buffer.concat([mk, Buffer.alloc(32)]);

    let rounds = 8;
    for (let i = 4; i < 12; i++) {
      const idx = 4 * (i - 1);
      let k0 = mk[idx], k1 = mk[idx + 1], k2 = mk[idx + 2], k3 = mk[idx + 3];

      if ((i & 3) === 0) {
        const k00 = ((initValue >>> (rounds & 24)) ^ this.sBox[k1]) & 0xff;
        k1 = this.sBox[k2];
        k2 = this.sBox[k3];
        k3 = this.sBox[k0];
        k0 = k00 & 0xff;
      }
      rounds += 2;

      mk[idx + 4] = (k0 ^ mk[idx - 12]) & 0xff;
      mk[idx + 5] = (k1 ^ mk[idx - 11]) & 0xff;
      mk[idx + 6] = (k2 ^ mk[idx - 10]) & 0xff;
      mk[idx + 7] = (k3 ^ mk[idx - 9]) & 0xff;
    }
    return mk;
  }

  static sumData(data) {
    const key = Buffer.alloc(32);
    for (let i = 0; i < 31; i++) {
      const idx = i * 8;
      const n0 = (data[idx] >> 4) & 2;
      const n1 = n0 | (data[idx + 1] & 64);
      const n2 = n1 | ((data[idx + 2] >> 2) & 1);
      const n3 = n2 | ((data[idx + 3] << 3) & -128);
      const n4 = n3 | ((data[idx + 4] >> 1) & 4);
      const n5 = n4 | ((data[idx + 5] << 3) & 16);
      const n6 = n5 | ((data[idx + 6] << 5) & 32);
      const n7 = n6 | ((data[idx + 7] >> 4) & 8);
      key[i] = n7 & 0xff;
    }
    key[31] = 1;
    return key;
  }

  static mixColumnsMethod(data, key) {
    const out = Buffer.from(data);
    for (let i = 0; i < 31; i++) {
      const kk = key[i];
      const idx = i * 8;
      out[idx + 0] = (out[idx + 0] & -33) | ((kk << 4) & 0xff & 32);
      out[idx + 1] = (out[idx + 1] & -65) | (kk & 64);
      out[idx + 2] = (out[idx + 2] & -5) | ((kk * 4) & 4);
      out[idx + 3] = (out[idx + 3] & -17) | ((kk >> 3) & 16);
      out[idx + 4] = (out[idx + 4] & -9) | ((kk + kk) & 8);
      out[idx + 5] = (out[idx + 5] & -3) | ((kk >> 3) & 2);
      out[idx + 6] = (out[idx + 6] & -2) | ((kk >> 5) & 1);
      out[idx + 7] = (out[idx + 7] & 127) | ((kk << 4) & 0xff & -128);
    }
    return out;
  }

  encrypt(data, iv) {
    const plaintext = AES_V3.sumData(data);
    const blocks = [];
    let previous = iv;
    for (let off = 0; off < plaintext.length; off += 16) {
      const block = plaintext.subarray(off, off + 16);
      const x = xorBytes(block, previous);
      const enc = this.encryptBlock(x);
      blocks.push(enc);
      previous = enc;
    }
    const key = Buffer.concat(blocks);
    const mixed = AES_V3.mixColumnsMethod(data, key);
    return Buffer.concat([key.subarray(key.length - 1), mixed]);
  }

  encryptBlock(plaintext) {
    const state = bytes2matrix(plaintext);
    addRoundKeyCon(state, this.keyMatrices.slice(0, 4), this.con2);

    for (let i = 1; i < 3; i++) {
      this.subBytes(state);
      this.shiftRows(state);
      if (i === 1) {
        this.shiftRowsCon(state, this.con2);
        mixColumnsState(state);
      }
      addRoundKeyCon(state, this.keyMatrices.slice(i * 4), this.con2);
    }
    addRoundKey(state, this.keyMatrices.slice(4));
    return matrix2bytes(state);
  }

  subBytes(s) {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s[i][j] = this.sBox[s[i][j]];
    const t = [s[this.con2[0]], s[this.con2[1]], s[this.con2[2]], s[this.con2[3]]];
    s[0] = t[0]; s[1] = t[1]; s[2] = t[2]; s[3] = t[3];
  }

  shiftRows(s) {
    const bs = matrix2bytes(s);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s[i][j] = bs[this.order[i * 4 + j]];
  }

  shiftRowsCon(s, c) {
    for (let i = 0; i < 4; i++) {
      const t = [s[i][c[0]], s[i][c[1]], s[i][c[2]], s[i][c[3]]];
      s[i][0] = t[0]; s[i][1] = t[1]; s[i][2] = t[2]; s[i][3] = t[3];
    }
  }
}

module.exports = {
  u32, xtime, leftCircularShift, rol, ror32, ror, rl8,
  get_key_hash, md5sum, md5sum_v3, sum_md5, hash_f13,
  branch_0, branch_1, branch_2, branch0_xor, get_iv,
  AES_V3, B1_ORDERS, B2_T001, BRANCH_2_ORDERS,
  _internal: { r00, swap_v0, get_branch_1_table_f, blockDivide },
};

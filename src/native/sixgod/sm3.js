'use strict';
// SM3 (GB/T 32905-2016) — pure JS port of gmssl.sm3.sm3_hash.

const IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

function rotl(x, n) {
  n &= 31;
  if (n === 0) return x >>> 0;
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function p0(x) {
  return (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
}

function p1(x) {
  return (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
}

function ff(x, y, z, j) {
  if (j < 16) return (x ^ y ^ z) >>> 0;
  return ((x & y) | (x & z) | (y & z)) >>> 0;
}

function gg(x, y, z, j) {
  if (j < 16) return (x ^ y ^ z) >>> 0;
  return ((x & y) | (~x & z)) >>> 0;
}

/**
 * Hash a Buffer/string and return a 32-byte Buffer.
 * @param {Buffer|string} input
 * @returns {Buffer}
 */
function sm3(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const bitLen = BigInt(buf.length) * 8n;

  let total = buf.length + 1;
  while (total % 64 !== 56) total++;
  const msg = Buffer.alloc(total + 8);
  buf.copy(msg);
  msg[buf.length] = 0x80;
  msg.writeBigUInt64BE(bitLen, total);

  const V = IV.slice();
  const W = new Array(68);
  const W1 = new Array(64);

  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = msg.readUInt32BE(off + i * 4);
    for (let i = 16; i < 68; i++) {
      const x = (W[i - 16] ^ W[i - 9] ^ rotl(W[i - 3], 15)) >>> 0;
      W[i] = (p1(x) ^ rotl(W[i - 13], 7) ^ W[i - 6]) >>> 0;
    }
    for (let i = 0; i < 64; i++) W1[i] = (W[i] ^ W[i + 4]) >>> 0;

    let A = V[0], B = V[1], C = V[2], D = V[3];
    let E = V[4], F = V[5], G = V[6], H = V[7];

    for (let j = 0; j < 64; j++) {
      const T = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const A12 = rotl(A, 12);
      const SS1 = rotl((A12 + E + rotl(T, j)) >>> 0, 7);
      const SS2 = (SS1 ^ A12) >>> 0;
      const TT1 = (ff(A, B, C, j) + D + SS2 + W1[j]) >>> 0;
      const TT2 = (gg(E, F, G, j) + H + SS1 + W[j]) >>> 0;
      D = C;
      C = rotl(B, 9);
      B = A;
      A = TT1;
      H = G;
      G = rotl(F, 19);
      F = E;
      E = p0(TT2);
    }

    V[0] = (V[0] ^ A) >>> 0;
    V[1] = (V[1] ^ B) >>> 0;
    V[2] = (V[2] ^ C) >>> 0;
    V[3] = (V[3] ^ D) >>> 0;
    V[4] = (V[4] ^ E) >>> 0;
    V[5] = (V[5] ^ F) >>> 0;
    V[6] = (V[6] ^ G) >>> 0;
    V[7] = (V[7] ^ H) >>> 0;
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32BE(V[i], i * 4);
  return out;
}

module.exports = { sm3 };

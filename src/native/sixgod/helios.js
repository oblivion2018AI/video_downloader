'use strict';
// Port of flurl/helios.py
const crypto = require('crypto');

const MASK64 = (1n << 64n) - 1n;

function ror(value, count) {
  let v = BigInt(value) & MASK64;
  count = ((count % 64) + 64) % 64;
  if (count === 0) return v;
  const low = (v << BigInt(64 - count)) & MASK64;
  return (low | (v >> BigInt(count))) & MASK64;
}

const HEX_TABLE = '0123456789abcdef';

function bytes2matrix8(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 8) out.push(text.readBigUInt64LE(i));
  return out;
}

function encryptHeliosInput(hashTable, inData) {
  let data0 = inData.readBigUInt64LE(0);
  let data1 = inData.readBigUInt64LE(8);
  for (let i = 0; i < 0x22; i++) {
    const hash1 = hashTable[i];
    data1 = hash1 ^ ((data0 + ror(data1, 8)) & MASK64);
    data1 &= MASK64;
    data0 = data1 ^ ror(data0, 61);
    data0 &= MASK64;
  }
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(data0, 0);
  out.writeBigUInt64LE(data1, 8);
  return out;
}

function pkcs7Pad(buf, blockSize) {
  const pad = blockSize - (buf.length % blockSize);
  const p = Buffer.alloc(pad, pad);
  return Buffer.concat([buf, p]);
}

/**
 * @param {number} khronos
 * @param {number} [rand]
 * @returns {string} base64
 */
function encrypt_helios(khronos, rand, rng) {
  rand = rand || (rng ? rng(0, 0xffffffff) : Math.floor(Math.random() * 0x100000000));
  const data = Buffer.concat([u32le(rand), Buffer.from('8662', 'utf8')]);
  const keySum = crypto.createHash('md5').update(data).digest();

  const keys = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    const v1 = keySum[i];
    keys[2 * i] = HEX_TABLE.charCodeAt(v1 >> 4);
    keys[2 * i + 1] = HEX_TABLE.charCodeAt(v1 & 15);
  }

  const hashTable = [];
  hashTable.push(keys.readBigUInt64LE(0));

  const km = bytes2matrix8(keys);
  let bufferB0 = km[0];
  let bufferB8 = km[1];
  const queue = [km[2], km[3]];

  for (let i = 0; i < 0x22; i++) {
    const x9 = bufferB0;
    let x8 = bufferB8;
    x8 = ror(x8, 8);
    x8 = (x8 + x9) & MASK64;
    x8 = (x8 ^ BigInt(i)) & MASK64;
    queue.push(x8);

    x8 = (x8 ^ ror(x9, 61)) & MASK64;
    hashTable.push(x8);

    bufferB0 = x8;
    bufferB8 = queue[0];
    queue.shift();
  }

  const inData = pkcs7Pad(Buffer.from(`${khronos}-1588093228-8662`, 'utf8'), 16);
  const outs = [];
  for (let off = 0; off < inData.length; off += 16) {
    outs.push(encryptHeliosInput(hashTable, inData.subarray(off, off + 16)));
  }
  const out = Buffer.concat([data.subarray(0, 4), Buffer.concat(outs)]);
  return out.toString('base64');
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

module.exports = { encrypt_helios, ror, pkcs7Pad };

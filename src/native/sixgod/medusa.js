'use strict';
// Port of flurl/medusa.py — x-medusa request signature.
const { sm3 } = require('./sm3');
const { get_key_hash, md5sum, hash_f13, rl8, AES_V3 } = require('./extra');
const { xssstubHashMd5Hex } = require('./header');
const { serializeMedusa } = require('./proto');

const MASK64 = (1n << 64n) - 1n;

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n) & MASK64, 0);
  return b;
}

const CONFIG = {
  fix: Buffer.from([0x35]),
  aesKey: Buffer.from('f1593376766ea98d34f31b057a9d5be4', 'hex'),
  aesIv: Buffer.from('1fe109a4125283f418de9e051a969e12', 'hex'),
  signKey: Buffer.from('8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5', 'hex'),
};

function xmxor_two(data, key) {
  const enc = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    const index = (i * 4) & 28;
    const d0 = key[index];
    const d1 = key[index + 1];
    let d2 = (rl8(data[i], 4) + d0) ^ d1;
    d2 = (~d2) & 0xff;
    d2 = rl8(d2, 3) & 0xff;
    d2 = (d2 + d1) & 0xff;
    d2 = ((d2 & 0xff) ^ d0) & 0xff;
    enc[data.length - i - 1] = (~d2) & 0xff;
  }
  return enc;
}

function xmxor(data, key) {
  const d = xmxor_two(data, key);
  const lastFlag = d[d.length - 1] ^ d[d.length - 2];
  const data0 = d[0];

  d[0] = ((~lastFlag) + d[0]) & 0xff;
  d[1] = ((d[0] ^ d[d.length - 1] ^ 254) + d[1]) & 0xff;
  d[2] = (d[2] + (((lastFlag - data0) ^ rl8(d[1], 3) ^ 2))) & 0xff;

  for (let i = 0; i < d.length - 4; i++) {
    const temp = rl8(d[i + 2], 3) ^ d[i + 1] ^ (i + 3);
    d[i + 3] = ((~temp) + d[i + 3]) & 0xff;
  }

  d[d.length - 1] ^= d[d.length - 2];

  let sum = 0;
  for (let i = 0; i < d.length - 1; i++) sum += d[i + 1];
  d[0] = ((d[0] ^ d[1]) + sum) & 0xff;
  return d;
}

function gen_medusa_proto(url, urlParams, devices, data, khronos, lanusk, dataType, rng) {
  const xgSeed = 320;
  const bodyMd5 = xssstubHashMd5Hex(data, dataType).toLowerCase();
  const bodyMd5Bytes = bodyMd5 ? Buffer.from(bodyMd5, 'hex') : Buffer.alloc(16);
  const tsBytes = u32le(khronos);
  const queryStr = url.split('?')[1];
  const querySm3 = sm3(queryStr);

  let lanuskHash;
  let pskVersion;
  let queryBodyHashSm3;
  if (lanusk && lanusk.length > 0) {
    const lanuskSm3 = sm3(Buffer.concat([Buffer.from(lanusk, 'hex'), tsBytes]));
    lanuskHash = md5sum(Buffer.concat([
      lanuskSm3, bodyMd5Bytes,
      Buffer.from('8496779ddb6dbcb6d4150bf880010000', 'hex'),
    ]));
    pskVersion = '1';
    queryBodyHashSm3 = sm3(Buffer.concat([Buffer.from(queryStr, 'utf8'), bodyMd5Bytes, Buffer.from('1', 'utf8')]));
  } else {
    lanuskHash = Buffer.alloc(0);
    pskVersion = 'none';
    queryBodyHashSm3 = sm3(Buffer.concat([Buffer.from(queryStr, 'utf8'), bodyMd5Bytes, Buffer.from('none', 'utf8')]));
  }

  const queryBodyTsHash = hash_f13(querySm3, bodyMd5Bytes, tsBytes, khronos);

  const deviceId = String(devices.device_id || urlParams.device_id || urlParams.did || '');
  const versionName = devices.version_name || urlParams.version_name;
  const osVersion = devices.os_version || urlParams.os_version;
  const deviceModel = devices.device_model || urlParams.device_type;
  const deviceBrand = devices.device_brand || urlParams.device_brand;
  const deviceManufacturer = devices.device_manufacturer || devices.device_brand || urlParams.device_brand;

  const medusa = {
    magic: Buffer.from('f7e85ffad7d7dc3bd62ac87057cf6118', 'hex'),
    version: 3,
    rand: rng(0, 0xffffffff),
    ms_app_id: '8662',
    device_id: deviceId,
    license_id: '1588093228',
    app_version: versionName,
    sdk_version_str: 'v04.06.04-ml-android',
    sdk_version: 67503104,
    xg_seed_bytes: u64le(xgSeed),
    time: khronos,
    query_body_ts_hash: queryBodyTsHash,
    query_sm3: querySm3.subarray(0, 6),
    request: { sign_count: 111, report_count: 10, setting_count: 694367, unknown4: 0, unknown5: 586952199 },
    sec_device_token: 'AXYQOS6n2m60x1fVZHIrH3iol',
    time2: khronos,
    lanusk_hash: lanuskHash,
    query_body_hash_sm3: queryBodyHashSm3,
    psk_version: pskVersion,
    call_type: 312,
    env: null,
    unknown24: '{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}',
    original: undefined,
  };

  medusa.env = {
    launch_time: rng(100, 120),
    unknown2: 146331399,
    unknown3: 146331396,
    unknown5: 7,
    version: 'v04.06.04.03-bugfix',
    pid: rng(10001, 12000),
    device: {
      d1: 1, collect_stat: 2, aid: '8662', device_id: deviceId,
      sec_device_token: 'Ai6svO3PyrwDOUSmO6ZcResxu', app_version: '!noperm!',
      battery: -888888, battery2: -888888, battery_health: 3, battery_changed: -888888,
      network: '!notset!', tz: 'Asia/Shanghai,8', lan: 'zh_CN', cpu: 4,
      sdcard: 255.24993896484375, sdcard_used: 35.58599090576172,
      memory: 3.467449188232422, memory2: 3.467449188232422,
      data: 255.1754913330078, data_used: 42.17544174194336,
      os_version: osVersion, brightness: 41, volume: 36,
      ts: 1728388016635, ts2: 1728388016635, ts3: 1728388016635, ts4: 1728388016637,
      usb: -1, hw_version: deviceModel, brand: deviceBrand, board: deviceModel,
      product_name: deviceModel, product_device: deviceManufacturer,
      product_manufacturer: deviceBrand, hardware: deviceBrand, unknown38: 31,
    },
    report: {
      time: devices.report_time || Math.floor(Date.now() / 1000),
      state: -2, code: 200, times: 0, unknown6: 0,
    },
    app_version: versionName,
  };

  const protoBytes = serializeMedusa(medusa);
  return { protoBytes, querySm3, queryBodyTsHash };
}

/**
 * @returns {string} base64 x-medusa
 */
function gen_medusa(url, urlParams, devices, data, khronos, lanusk, opts) {
  opts = opts || {};
  const rng = opts.rng || defaultRng;
  const dataType = opts.dataType;

  const { protoBytes, querySm3, queryBodyTsHash } =
    gen_medusa_proto(url, urlParams, devices, data, khronos, lanusk, dataType, rng);

  const hashRand = opts.hashRand || rng(0, 0xffffffff);
  const xmRand = opts.xmRand || rng(0, 0xffffffff);

  const { hash: key, seed } = get_key_hash(CONFIG.signKey, hashRand);

  let d = xmxor(Buffer.from(protoBytes), key);
  d = Buffer.concat([u64le(320n), d]);
  d = Buffer.from(d).reverse();
  for (let i = 0; i < d.length; i++) d[i] = (d[i] ^ seed[3 - (i & 3)]) & 0xff;

  const hashRandBytes = u32le(hashRand);
  let checkBit = (querySm3[0] & 63) << 14;
  checkBit = (checkBit | 0x18000001) >>> 0;
  checkBit = (checkBit | ((queryBodyTsHash[0] & 63) << 8)) >>> 0;

  d = Buffer.concat([CONFIG.fix, u32le(xmRand), u32le(checkBit), d, hashRandBytes.subarray(2, 4)]);

  d = new AES_V3(CONFIG.aesKey, khronos).encrypt(d, CONFIG.aesIv);

  const version = Buffer.from('03000000f7e85ffad7d7dc3bd62ac87057cf6118', 'hex');
  const versionOr = Buffer.alloc(20);
  for (let i = 0; i < 20; i += 4) {
    versionOr.writeUInt32LE((version.readUInt32LE(i) ^ (khronos >>> 0)) >>> 0, i);
  }

  d = Buffer.concat([versionOr, hashRandBytes.subarray(0, 2), u16le(256), d]);
  return d.toString('base64');
}

function defaultRng(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

module.exports = { gen_medusa, gen_medusa_proto, xmxor, xmxor_two, defaultRng, CONFIG };

'use strict';
// Minimal protobuf writer matching betterproto 2.0.0b6 serialization semantics
// (fields emitted in ascending field-number order; proto3 defaults skipped).

function varint(n) {
  let v = BigInt(n);
  if (v < 0n) v &= (1n << 64n) - 1n;
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function tag(fieldNo, wireType) {
  return varint((fieldNo << 3) | wireType);
}

function zigzag32(n) {
  n = n | 0;
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

function zigzag64(n) {
  const v = BigInt(n);
  return (v << 1n) ^ (v >> 63n);
}

class PB {
  constructor() { this.parts = []; }
  raw(b) { this.parts.push(b); }
  sint32(fn, n) {
    n = n | 0;
    if (n === 0) return;
    this.raw(tag(fn, 0));
    this.raw(varint(BigInt(zigzag32(n))));
  }
  sint64(fn, n) {
    if (BigInt(n) === 0n) return;
    this.raw(tag(fn, 0));
    this.raw(varint(zigzag64(n)));
  }
  float(fn, n) {
    if (n === 0) return;
    const b = Buffer.alloc(4);
    b.writeFloatLE(n, 0);
    this.raw(tag(fn, 5));
    this.raw(b);
  }
  str(fn, s) {
    if (!s) return;
    const b = Buffer.from(String(s), 'utf8');
    this.raw(tag(fn, 2));
    this.raw(varint(b.length));
    this.raw(b);
  }
  bytes(fn, b) {
    if (!b || b.length === 0) return;
    this.raw(tag(fn, 2));
    this.raw(varint(b.length));
    this.raw(b);
  }
  message(fn, sub) {
    if (sub === null || sub === undefined) return;
    const b = Buffer.isBuffer(sub) ? sub : sub.toBuffer();
    this.raw(tag(fn, 2));
    this.raw(varint(b.length));
    this.raw(b);
  }
  toBuffer() { return Buffer.concat(this.parts); }
}

function serializeRequest(r) {
  const w = new PB();
  w.sint32(1, r.sign_count);
  w.sint32(2, r.report_count);
  w.sint32(3, r.setting_count);
  w.sint32(4, r.unknown4);
  w.sint32(5, r.unknown5);
  return w.toBuffer();
}

function serializeDevice(d) {
  const w = new PB();
  w.sint32(1, d.d1);
  w.sint32(2, d.collect_stat);
  w.str(3, d.aid);
  w.str(4, d.device_id);
  w.str(5, d.sec_device_token);
  w.str(6, d.app_version);
  w.sint32(7, d.battery);
  w.sint32(8, d.battery2);
  w.sint32(9, d.battery_health);
  w.sint32(10, d.battery_changed);
  w.str(11, d.network);
  w.str(12, d.tz);
  w.str(13, d.lan);
  w.sint32(14, d.cpu);
  w.str(15, d.resolution);
  w.float(16, d.sdcard);
  w.float(17, d.sdcard_used);
  w.float(18, d.memory);
  w.float(19, d.memory2);
  w.float(20, d.data);
  w.float(21, d.data_used);
  w.str(22, d.os_version);
  w.sint32(23, d.brightness);
  w.sint32(24, d.volume);
  w.sint64(25, d.ts);
  w.sint64(26, d.ts2);
  w.sint64(27, d.ts3);
  w.sint64(28, d.ts4);
  w.sint32(29, d.usb);
  w.str(30, d.hw_version);
  w.str(31, d.brand);
  w.str(32, d.board);
  w.str(33, d.product_name);
  w.str(34, d.product_device);
  w.str(35, d.product_manufacturer);
  w.str(36, d.hardware);
  w.sint32(38, d.unknown38);
  w.sint32(40, d.unknown40);
  return w.toBuffer();
}

function serializeReport(r) {
  const w = new PB();
  w.sint64(1, r.time);
  w.sint32(2, r.state);
  w.sint32(4, r.code);
  w.sint32(5, r.times);
  w.sint32(6, r.unknown6);
  return w.toBuffer();
}

function serializeEnv(e) {
  const w = new PB();
  w.sint32(1, e.launch_time);
  w.sint32(2, e.unknown2);
  w.sint32(3, e.unknown3);
  w.sint32(5, e.unknown5);
  w.str(6, e.version);
  w.sint32(7, e.pid);
  w.message(12, serializeDevice(e.device));
  w.message(13, serializeReport(e.report));
  w.str(14, e.app_version);
  w.sint32(15, e.unknown15);
  w.sint32(16, e.unknown16);
  w.sint32(18, e.unknown18);
  w.sint32(19, e.unknown19);
  w.sint32(20, e.unknown20);
  w.sint32(21, e.unknown21);
  return w.toBuffer();
}

function serializeMedusa(m) {
  const w = new PB();
  w.bytes(1, m.magic);
  w.sint32(2, m.version);
  w.sint32(3, m.rand);
  w.str(4, m.ms_app_id);
  w.str(5, m.device_id);
  w.str(6, m.license_id);
  w.str(7, m.app_version);
  w.str(8, m.sdk_version_str);
  w.sint32(9, m.sdk_version);
  w.bytes(10, m.xg_seed_bytes);
  w.sint32(12, m.time);
  w.bytes(13, m.query_body_ts_hash);
  w.bytes(14, m.query_sm3);
  w.message(15, serializeRequest(m.request));
  w.str(16, m.sec_device_token);
  w.sint32(17, m.time2);
  w.bytes(18, m.lanusk_hash);
  w.bytes(19, m.query_body_hash_sm3);
  w.str(20, m.psk_version);
  w.sint32(21, m.call_type);
  w.message(23, serializeEnv(m.env));
  w.str(24, m.unknown24);
  w.str(26, m.original);
  return w.toBuffer();
}

module.exports = {
  varint, zigzag32, zigzag64, PB,
  serializeMedusa,
};

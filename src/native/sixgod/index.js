'use strict';
// Port of flurl/core.py — assembles the full six-god request signature.
const { encryptGorgon } = require('../xgorgon');
const { encrypt_helios } = require('./helios');
const { getParamsEncrypturl, urlEncode, xssstubHashMd5Hex } = require('./header');
const { gen_medusa, defaultRng } = require('./medusa');

function b64U32(n, littleEndian) {
  const b = Buffer.alloc(4);
  if (littleEndian) b.writeUInt32LE(n >>> 0, 0);
  else b.writeUInt32BE(n >>> 0, 0);
  return b.toString('base64');
}

/**
 * @param {object} opts
 * @param {string} opts.surl        base url without query
 * @param {object} [opts.params]    query params (insertion order matters)
 * @param {object} [opts.devices]   device descriptors
 * @param {object} [opts.data]      request body object
 * @param {string} [opts.common]
 * @param {object} [opts.header]    base headers
 * @param {string} [opts.lanusk]
 * @param {function} [opts.rng]     deterministic rng(a,b) for tests
 * @param {number} [opts.now]       fixed unix seconds for tests
 * @returns {{ headers: object, url: string }}
 */
function coreSixgod(opts) {
  const { surl, params, devices, data, common, header, lanusk } = opts;
  const useRng = opts.rng || defaultRng;
  const headerIn = header || {};

  if (devices && data) {
    for (const [k, v] of Object.entries(devices)) {
      if (k in data) data[k] = v;
    }
  }

  const dataType = headerIn['content-type'] || headerIn['Content-Type'];
  const xgRand = useRng(0, 0xffff);

  const { eurl, urlParams, xCommon } = getParamsEncrypturl(surl, params, devices, common, opts.now);
  const khronos = opts.now === undefined ? Math.floor(Date.now() / 1000) : opts.now;

  const gorgon = encryptGorgon(data, urlEncode(urlParams), khronos, xgRand, dataType);
  const helios = encrypt_helios(khronos, 0, useRng);
  const medusa = gen_medusa(eurl, urlParams, devices, data, khronos, lanusk || '', { dataType, rng: useRng });

  const signHeader = {
    'x-ladon': b64U32(khronos, false),
    'x-khronos': String(khronos),
    'x-argus': b64U32(khronos, true),
    'x-gorgon': gorgon,
    'x-helios': helios,
    'x-medusa': medusa,
  };
  if (data) signHeader['x-ss-stub'] = xssstubHashMd5Hex(data, dataType);

  const headers = {};
  for (const [k, v] of Object.entries(headerIn)) headers[String(k).toLowerCase()] = v;
  Object.assign(headers, signHeader);
  if (devices) {
    headers['x-tt-dt'] = devices['x_tt_dt'] || '';
    headers['user-agent'] = devices.ua || '';
  }
  if (xCommon) headers['x-common-params-v2'] = xCommon;

  return { headers, url: eurl };
}

module.exports = { coreSixgod };

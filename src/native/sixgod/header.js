'use strict';
// Port of flurl/header.py — url encoding, param merging and x-ss-stub.
const crypto = require('crypto');

function quotePlus(value) {
  let e = encodeURIComponent(String(value));
  // Python quote_plus encodes ! ' ( ) ; encodeURIComponent leaves them raw.
  e = e.replace(/[!'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return e;
}

function urlEncode(data) {
  const parts = [];
  for (const k of Object.keys(data)) {
    parts.push(`${quotePlus(k)}=${quotePlus(data[k])}`);
  }
  return parts.join('&');
}

function extractUrlParams(url) {
  const params = {};
  const q = url.includes('?') ? url.split('?')[1] : url;
  if (!q) return params;
  for (const part of q.split('&')) {
    const i = part.indexOf('=');
    const k = i >= 0 ? part.slice(0, i) : part;
    const v = i >= 0 ? part.slice(i + 1) : '';
    let dv = v;
    try { dv = decodeURIComponent(v); } catch (_) { dv = v; }
    params[k] = dv;
  }
  return params;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

/**
 * @returns {{ eurl: string, urlParams: object, xCommon: string }}
 */
function getParamsEncrypturl(url, params, devices, common, now) {
  let xCommon = {};
  let xParams;

  if (params) {
    xParams = Object.assign({}, params);
    if (common) {
      xCommon = extractUrlParams(common);
      Object.assign(xParams, xCommon);
    }
    if (devices) {
      for (const [k, v] of Object.entries(devices)) {
        if (k in xParams) xParams[k] = v;
        if (k in xCommon) xCommon[k] = v;
        else if ('did' in xParams && k === 'device_id') xParams['did'] = v;
      }
    }
  } else {
    xParams = extractUrlParams(url);
    if (common) {
      xCommon = extractUrlParams(common);
      Object.assign(xParams, xCommon);
    }
    if (devices) {
      for (const [k, v] of Object.entries(devices)) {
        if (k in xParams) xParams[k] = v;
        if (k in xCommon) xCommon[k] = v;
        else if ('did' in xParams && k === 'device_id') xParams['did'] = v;
      }
    }
  }

  const ts = now === undefined ? nowSec() : now;
  xParams['ts'] = ts;
  xParams['_rticket'] = now === undefined ? Date.now() : now * 1000;
  if (Object.keys(xCommon).length) {
    xCommon['ts'] = ts;
    xCommon['_rticket'] = now === undefined ? Date.now() : now * 1000;
  }

  const eurl = url.includes('?')
    ? url.split('?')[0] + '?' + urlEncode(xParams)
    : url + '?' + urlEncode(xParams);

  return { eurl, urlParams: xParams, xCommon: urlEncode(xCommon) };
}

function xssstubHashMd5Hex(data, dataType) {
  if (!data) return '';
  if (dataType === 'md5') return data;
  const md5 = crypto.createHash('md5');
  if (typeof data === 'string') {
    md5.update(Buffer.from(data, 'utf8'));
  } else if (Buffer.isBuffer(data)) {
    md5.update(data);
  } else if (dataType === 'application/json; charset=UTF-8') {
    md5.update(Buffer.from(JSON.stringify(data), 'utf8'));
  } else {
    md5.update(Buffer.from(urlEncode(data), 'utf8'));
  }
  return md5.digest('hex').toUpperCase();
}

module.exports = { quotePlus, urlEncode, extractUrlParams, getParamsEncrypturl, xssstubHashMd5Hex };

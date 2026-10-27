/**
 * hongguo.js - 红果短剧 API 客户端
 *
 * 基于逆向分析结果重写，核心链路：
 *   解析链接 -> series_id -> 剧集列表 -> 取播放直链(main_url + spade_a)
 *
 * 相比原实现的关键修正：
 *   1. 设备指纹不再全球硬编码共用 —— 首次运行随机生成并持久化到本地（每台机器不同）
 *   2. 请求签名失败（空响应/限流）采用自适应退避重试，而不是固定 1~2s
 *   3. deriveKey 增加格式校验，失败时给出明确报错
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { coreSixgod } = require('./sixgod');

const API = 'https://api5-normal-sinfonlineb.fqnovel.com';

// ===== 设备指纹（本地随机生成 + 持久化，见 实现参考.md §3 填坑 #1）=====
let DEVICE = null;
let deviceFile = null;

const DEVICE_TEMPLATES = [
  { device_type: '2509FPN0BC', device_brand: 'XIAOMI', resolution: '1280*2772', dpi: '520' },
  { device_type: 'SM-N9860', device_brand: 'Samsung', resolution: '900*1600', dpi: '320' },
  { device_type: 'Pixel 6', device_brand: 'Google', resolution: '1080*2400', dpi: '420' },
  { device_type: 'IN2023', device_brand: 'OnePlus', resolution: '1440*3216', dpi: '515' },
  { device_type: 'M2012K11AC', device_brand: 'XIAOMI', resolution: '1080*2400', dpi: '440' },
];

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}
function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 初始化设备指纹。configDir 下若无 device.json 则随机生成一份并落盘，
 * 之后每次启动复用同一身份（ behaves like a real installed app）。
 */
function initDevice(configDir) {
  deviceFile = path.join(configDir, 'device.json');
  try {
    if (fs.existsSync(deviceFile)) {
      const d = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
      if (d && d.iid && d.device_id && d.device_type) {
        DEVICE = d;
        return DEVICE;
      }
    }
  } catch (_) {}
  const tpl = pickOne(DEVICE_TEMPLATES);
  DEVICE = {
    iid: String(randInt(4e15, 9e15)),
    device_id: String(randInt(4e15, 9e15)),
    cdid: crypto.randomUUID(),
    device_type: tpl.device_type,
    device_brand: tpl.device_brand,
    resolution: tpl.resolution,
    dpi: tpl.dpi,
  };
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(deviceFile, JSON.stringify(DEVICE, null, 2), 'utf8');
  } catch (_) {}
  return DEVICE;
}

function buildSignedUa() {
  return `com.phoenix.read/71532 (Linux; U; Android 9; zh_CN; ${DEVICE.device_type}; Build/PQ3A.190605.07291804)`;
}

/** 手动指定设备指纹（供测试 / 设置里刷新身份用） */
function setDevice(dev) {
  if (dev && dev.iid && dev.device_id) {
    DEVICE = dev;
    if (deviceFile) {
      try { fs.writeFileSync(deviceFile, JSON.stringify(DEVICE, null, 2), 'utf8'); } catch (_) {}
    }
  }
}

function getDevice() {
  return DEVICE;
}

function buildBaseParams() {
  return {
    iid: DEVICE.iid,
    device_id: DEVICE.device_id,
    ac: 'wifi',
    channel: 'oppo_8662_64',
    aid: '8662',
    app_name: 'novelread',
    version_code: '71532',
    version_name: '7.1.5.32',
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    device_type: DEVICE.device_type,
    device_brand: DEVICE.device_brand,
    language: 'zh',
    os_api: '28',
    os_version: '9',
    manifest_version_code: '71532',
    resolution: DEVICE.resolution,
    dpi: DEVICE.dpi,
    update_version_code: '71532',
    host_abi: 'arm64-v8a',
    dragon_device_type: 'phone',
    pv_player: '71532',
    compliance_status: '0',
    need_personal_recommend: '1',
    player_so_load: '1',
    is_android_pad_screen: '0',
  };
}

function buildDevices() {
  return {
    device_id: DEVICE.device_id,
    iid: DEVICE.iid,
    install_id: DEVICE.iid,
    device_brand: DEVICE.device_brand,
    device_model: DEVICE.device_type,
    device_type: DEVICE.device_type,
    device_manufacturer: DEVICE.device_brand,
    os_version: '9',
    version_name: '7.1.5.32',
    ua: buildSignedUa(),
  };
}

function buildSignHeaders() {
  return {
    'User-Agent': buildSignedUa(),
    'Accept': 'application/json; charset=utf-8,application/x-protobuf',
    'Content-Type': 'application/json; charset=UTF-8',
    'x-xs-from-web': '0',
    'x-ss-req-ticket': String(Date.now()),
    'x-tt-request-tag': 't=0;n=0',
    'sdk-version': '2',
    'passport-sdk-version': '50561',
    'x-vc-bdturing-sdk-version': '3.7.2.cn',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带六神签名的 POST 请求（自适应退避：空响应视为被限流，按 1s/3s/6s 重试）
 * 服务端要求 X-Gorgon / X-Khronos / X-SS-STUB / X-Ladon / X-Argus / X-Helios / X-Medusa，
 * 缺任一签名会被静默拒绝（HTTP 200 但响应体为空）。签名必须与实际发送内容完全一致，
 * 因此每次重试都要重新计算签名。
 */
async function signedPost(apiPath, body, opts) {
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const bodyStr = JSON.stringify(body);
      const { url, headers } = coreSixgod({
        surl: API + apiPath,
        params: buildBaseParams(),
        devices: buildDevices(),
        data: body,
        header: buildSignHeaders(),
        lanusk: '',
      });
      const res = await axios.post(url, bodyStr, {
        headers,
        timeout: 25000,
        responseType: 'text',
        validateStatus: () => true,
      });
      const txt = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      if (!txt || !txt.trim()) throw new Error('接口返回为空（可能被风控限流）');
      const parsed = JSON.parse(txt);
      if (opts && opts.returnRaw) return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) await sleep(1000 * (attempt === 0 ? 1 : 3));
    }
  }
  throw lastErr || new Error('请求失败');
}

/**
 * 带六神签名的 GET 请求（自适应退避）
 */
async function signedGet(apiPath, extraParams, retries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const params = { ...buildBaseParams(), _rticket: String(Date.now()), ...(extraParams || {}) };
      const { url, headers } = coreSixgod({
        surl: API + apiPath,
        params,
        devices: buildDevices(),
        header: buildSignHeaders(),
        lanusk: '',
      });
      const res = await axios.get(url, {
        headers,
        timeout: 20000,
        responseType: 'text',
        validateStatus: () => true,
      });
      const txt = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      if (!txt || !txt.trim()) throw new Error('接口返回为空（可能被风控拦截，请稍后重试）');
      return JSON.parse(txt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await sleep(1000 * (attempt + 1) * 2);
    }
  }
  throw lastErr || new Error('请求失败');
}

const UA = 'com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)';
const VIDEO_REFERER = 'https://novelquickapp.com/';

const DETAIL_BIZ_PARAM = {
  detail_page_version: 0,
  disable_digg_stat: false,
  image_shrink_datas_str:
    'W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1hZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjcyLCJzaHJpbmtfdHlwZSI6NH1d\n',
  need_all_video_definition: false,
  need_mp4_align: false,
  screen_width_px: '900',
  source: 7,
  use_os_player: false,
  use_server_dns: false,
};

const MODEL_BIZ_PARAM = {
  detail_page_version: 0,
  device_level: 3,
  disable_digg_stat: false,
  need_all_video_definition: true,
  need_mp4_align: false,
  use_os_player: false,
  use_server_dns: false,
  video_platform: 1024,
};

/**
 * 从任意文本中提取分享链接 / series_id
 *  支持：纯数字 ID、纯链接、带引导文案的长文本（如「复制这段文字，打开红果短剧查看…」）
 */
function extractInput(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('输入内容为空');

  // 1) 纯数字 series_id
  if (/^\d{6,}$/.test(text)) return { type: 'id', value: text };

  // 2) 文本中的链接（含未带协议头的短链）
  const urlMatch = text.match(/https?:\/\/[^\s，,、"'）)】\]<>]+/i);
  if (urlMatch) return { type: 'url', value: urlMatch[0] };

  const shortMatch = text.match(
    /\b(?:novelquickapp|fanqienovel|fqnovel|hongguo)\.[a-z.]+\/[^\s，,、"'）)】\]<>]+/i
  );
  if (shortMatch) return { type: 'url', value: 'https://' + shortMatch[0] };

  // 3) 文本里直接夹带的 video_series_id / series_id / video_id
  const idMatch =
    text.match(/video_series_id=(\d+)/) ||
    text.match(/series_id["':=\s]+(\d{6,})/) ||
    text.match(/video_id["':=\s]+(\d{6,})/);
  if (idMatch) return { type: 'id', value: idMatch[1] };

  // 4) 长文本中的长数字串（最后一个），大概率是剧集 ID
  const digits = text.match(/\d{15,25}/g);
  if (digits && digits.length) return { type: 'id', value: digits[digits.length - 1] };

  throw new Error('未能从输入内容中识别出短剧链接或 ID');
}

/**
 * 分享链接 -> series_id
 */
async function resolveSeriesId(shareUrl) {
  const { type, value } = extractInput(shareUrl);
  if (type === 'id') return value;

  let res;
  try {
    res = await axios.get(value, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 9; SM-N9860) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.152 Mobile Safari/537.36',
      },
      timeout: 25000,
      maxRedirects: 10,
    });
  } catch (err) {
    // 短链跳转异常时，仍尝试从错误响应的地址里解析
    const badUrl = (err && err.request && err.request.res && err.request.res.responseUrl) || (err && err.config && err.config.url) || '';
    const m = String(badUrl).match(/video_series_id=(\d+)/);
    if (m) return m[1];
    throw new Error('链接请求失败: ' + err.message);
  }

  const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || res.config?.url || value;
  let m = finalUrl.match(/video_series_id=(\d+)/) || finalUrl.match(/[?&]series_id=(\d+)/);
  if (m) return m[1];

  m = finalUrl.match(/schemeParams[^&]*/);
  if (m) {
    let raw = m[0];
    try {
      raw = decodeURIComponent(decodeURIComponent(raw));
    } catch (_) {}
    const jm = raw.match(/"(?:video_id|series_id|video_series_id)"\s*:\s*"?(\d+)"?/);
    if (jm) return jm[1];
  }

  const bodyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
  m =
    bodyText.match(/video_series_id=(\d+)/) ||
    bodyText.match(/"(?:video_id|video_series_id|series_id)"\s*:\s*"?(\d+)"?/);
  if (m) return m[1];

  // 兜底：最终地址或响应体中的长数字
  const digits = (finalUrl + ' ' + bodyText).match(/\d{17,20}/g);
  if (digits && digits.length) return digits[0];

  throw new Error('无法从链接解析 series_id: ' + finalUrl);
}

/** 中文/阿拉伯数字转整数（合集标题里的「第十一集」这类） */
function cnToNumber(input) {
  const s = String(input || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? d[m[1]] : 1) * 10 + (m[2] ? d[m[2]] : 0);
  if (s.length === 1 && s in d) return d[s];
  return 0;
}

/** 清理合集成员标题：统一收敛成「第一集」这类 */
function cleanAlbumEpTitle(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const m = t.match(/第\s*[\d零一二三四五六七八九十百千]+\s*集/);
  if (m) return m[0].replace(/\s+/g, '');
  return t.length > 24 ? t.slice(0, 24) : t;
}

/** 用户投稿合集（P-UGC album）信息：单条视频分享背后通常挂一个合集 */
async function fetchAlbumInfo(albumId) {
  const raw = await signedPost('/novel/player/album_detail/v1/', { album_id: String(albumId) }, { returnRaw: true });
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const ad = (j && j.data && j.data.album_data) || {};
  const list = ad.video_detail_list || [];
  const base = list
    .map((m, i) => {
      const v = (m.video_list || [])[0] || {};
      const sid = String(m.series_id_str || m.series_id || '');
      const rawTitle = String(m.series_title || '');
      const numMatch = rawTitle.match(/第\s*([\d零一二三四五六七八九十百]+)\s*集/);
      return {
        vid: String(v.vid || sid),
        seq: i + 1,
        realIndex: numMatch ? cnToNumber(numMatch[1]) : 0,
        title: cleanAlbumEpTitle(rawTitle),
        cover: m.series_cover || v.cover || '',
        content_type: String(m.content_type || '1001'),
        duration: Number(v.duration || m.duration || 0),
        series_id: sid,
      };
    })
    .filter((x) => x.vid);

  // 标题里的真实集数优先；重号则退回顺序号
  const usedIdx = new Set();
  const members = base.map((x) => {
    let idx = x.realIndex && !usedIdx.has(x.realIndex) ? x.realIndex : x.seq;
    while (usedIdx.has(idx)) idx += 1;
    usedIdx.add(idx);
    return { ...x, vid_index: idx };
  });

  return {
    album_id: String(ad.album_id_str || albumId),
    title: ad.title || '',
    episode_count: Number(ad.episode_cnt) || list.length || 0,
    cover: ad.cover || '',
    intro: ad.intro || '',
    members,
  };
}

/**
 * 获取整部剧集列表
 */
async function fetchEpisodeList(seriesId) {
  // 用原始文本解析：related_album_id 是 19 位大整数，JSON.parse 会丢精度
  const raw = await signedPost(
    '/novel/player/multi_video_detail/v1/',
    { biz_param: DETAIL_BIZ_PARAM, series_id: seriesId },
    { returnRaw: true }
  );
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!j || j.code !== 0) {
    throw new Error('detail API 失败: ' + JSON.stringify(j || {}).slice(0, 200));
  }
  const d = j.data || {};
  const sid = Object.keys(d)[0];
  if (!sid) throw new Error('未获取到剧集数据');

  const vd = d[sid]?.video_data || {};
  const vl = vd.video_list || [];
  const eps = vl.map((item) => ({
    vid: String(item.vid),
    vid_index: item.vid_index || 0,
    title: item.title || '',
    series_id: String(item.series_id || sid),
    series_title: vd.series_title || '',
    cover: vd.series_cover || vd.cover_url || item.cover_url || '',
  }));
  eps.sort((a, b) => a.vid_index - b.vid_index);

  // 接口给每个分集返回的 title 其实是整部剧的剧情简介（各集相同且很长），统一清空
  const allSameTitle = eps.length > 1 && eps.every((e) => e.title === eps[0].title);
  eps.forEach((e) => {
    if (!e.title) return;
    if (allSameTitle || e.title.length > 30) e.title = '';
  });

  // ===== 单条视频（P-UGC 用户投稿）识别 =====
  const albumMatch = /"related_album_id":(\d+)/.exec(typeof raw === 'string' ? raw : '');
  const relatedAlbumId = albumMatch ? albumMatch[1] : '';
  const isSinglePugc = eps.length === 1 && !Number(vd.episode_cnt) && !!relatedAlbumId;

  let relatedAlbum = null;
  if (isSinglePugc) {
    try {
      relatedAlbum = await fetchAlbumInfo(relatedAlbumId);
    } catch (_) {
      relatedAlbum = { album_id: relatedAlbumId, title: '', episode_count: 0, cover: '', intro: '', members: [] };
    }
  }

  let episodes = eps;
  let fromAlbum = false;
  if (isSinglePugc && relatedAlbum && Array.isArray(relatedAlbum.members) && relatedAlbum.members.length > 1) {
    episodes = relatedAlbum.members.map((m) => ({
      vid: m.vid,
      vid_index: m.vid_index,
      title: m.title,
      series_id: m.series_id || m.vid,
      series_title: relatedAlbum.title || vd.series_title || '',
      cover: m.cover || relatedAlbum.cover || '',
      content_type: m.content_type,
      duration: m.duration,
    }));
    fromAlbum = true;
  } else {
    episodes = eps.map((e) => ({ ...e, content_type: String(vd.content_type || '') }));
  }

  const stripBookMark = (s) => String(s || '').replace(/^《/, '').replace(/》$/, '').trim();

  return {
    series_id: String(sid),
    series_title: fromAlbum
      ? stripBookMark(relatedAlbum.title) || vd.series_title || '未命名短剧'
      : vd.series_title || '未命名短剧',
    cover: (fromAlbum && relatedAlbum.cover) || vd.series_cover || vd.cover_url || (eps[0] && eps[0].cover) || '',
    total: episodes.length,
    episodes,
    is_single_pugc: isSinglePugc,
    from_album: fromAlbum,
  };
}

// ===== 短剧搜索 =====
const SEARCH_PATH = '/reading/bookapi/search/tab/v1/';
const SUGGEST_PATH = '/reading/bookapi/search/suggest/v1/';
const SEARCH_CACHE_TTL = 3 * 60 * 1000;
const searchCache = new Map();

function trimSearchCache() {
  if (searchCache.size <= 60) return;
  const keys = Array.from(searchCache.keys()).slice(0, searchCache.size - 60);
  keys.forEach((k) => searchCache.delete(k));
}

/** 把搜索接口返回的 cell 归一化成前端可用的短剧卡片 */
function normalizeSearchCell(cell) {
  if (!cell) return null;
  const vd = Array.isArray(cell.video_data) ? cell.video_data[0] : null;
  if (!vd) return null;

  const detail = vd.video_detail || {};
  const seriesId = String(detail.series_id_str || vd.series_id || cell.book_id || '');
  if (!/^\d{6,}$/.test(seriesId)) return null;

  const title =
    detail.series_title ||
    vd.title ||
    (cell.search_high_light && cell.search_high_light.title && cell.search_high_light.title.text) ||
    vd.raw_book_name ||
    '未命名短剧';

  const tags = [];
  const pushTag = (t) => {
    const s = String(t || '').trim();
    if (s && !tags.includes(s) && tags.length < 5) tags.push(s);
  };
  try {
    const schema = JSON.parse(detail.category_schema || vd.category_schema || '[]');
    schema.forEach((it) => pushTag(it && it.name));
  } catch (_) {}
  if (Array.isArray(vd.rec_tags)) {
    vd.rec_tags.forEach((t) => {
      if (t && typeof t.content === 'string' && !/万|亿|收藏|热度/.test(t.content)) pushTag(t.content);
    });
  }

  return {
    series_id: seriesId,
    title: String(title).trim(),
    cover: detail.series_cover || vd.cover || '',
    total: parseInt(detail.episode_cnt || vd.episode_cnt, 10) || 0,
    play_count: parseInt(vd.play_cnt || detail.series_play_cnt, 10) || 0,
    score: vd.score || '',
    intro: detail.series_intro || '',
    actors: detail.role || '',
    tags,
    first_vid: detail.first_vid || vd.vid || '',
  };
}

/**
 * 按关键词搜索短剧。
 * 填坑：遍历所有 tab 合并去重（不再只依赖 tab_type===11）；
 *       hasMore 读取服务端真实 has_more 字段。
 */
async function searchSeries(keyword, opts = {}) {
  const q = String(keyword || '').trim();
  if (!q) throw new Error('请输入搜索关键词');
  if (q.length > 40) throw new Error('搜索关键词过长');

  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  const cacheKey = `${q}@${offset}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.t < SEARCH_CACHE_TTL) return cached.v;

  const j = await signedGet(SEARCH_PATH, { query: q, offset: String(offset) });
  if (!j || (j.code !== undefined && j.code !== 0)) {
    throw new Error('搜索接口异常: ' + JSON.stringify(j || {}).slice(0, 160));
  }

  const tabs = Array.isArray(j.search_tabs) ? j.search_tabs : [];
  const items = [];
  const seen = new Set();
  let serverHasMore = false;
  for (const tab of tabs) {
    const cells = Array.isArray(tab && tab.data) ? tab.data : [];
    if (tab && (tab.has_more === 1 || tab.has_more === true)) serverHasMore = true;
    for (const cell of cells) {
      const item = normalizeSearchCell(cell);
      if (!item || seen.has(item.series_id)) continue;
      seen.add(item.series_id);
      items.push(item);
    }
  }

  const result = {
    keyword: q,
    items,
    rawCount: items.length,
    nextOffset: offset + items.length,
    hasMore: serverHasMore && items.length > 0,
  };

  searchCache.set(cacheKey, { t: Date.now(), v: result });
  trimSearchCache();
  return result;
}

/** 搜索关键词联想 */
async function searchSuggest(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  const j = await signedGet(SUGGEST_PATH, { query: q }, 1);
  const list = j && j.data && Array.isArray(j.data.query_result) ? j.data.query_result : [];
  return list.filter((x) => typeof x === 'string' && x.trim()).slice(0, 10);
}

/** 单条视频流的清晰度评分 */
function streamScore(v) {
  const meta = v.video_meta || {};
  const defStr = String(meta.definition || '');
  let defNum = 0;
  const m = defStr.match(/(\d+)\s*p/i);
  if (m) {
    defNum = parseInt(m[1], 10);
  } else {
    const map = { '4k': 2160, '2k': 1440, fhd: 1080, fullhd: 1080, hd: 720, sd: 480, ld: 360 };
    defNum = map[defStr.toLowerCase()] || 0;
  }
  const w = parseInt(meta.vwidth, 10) || 0;
  const h = parseInt(meta.vheight, 10) || 0;
  const bitrate = parseInt(meta.bitrate || meta.real_bitrate, 10) || 0;
  return { defNum, pixels: w * h, bitrate };
}

/** 解析单个 video_model JSON，选流：清晰度标签 > 像素 > 编码 > 码率 */
function parseModelVideo(vm) {
  if (typeof vm !== 'string') return [null, null, null];
  let vmj;
  try {
    vmj = JSON.parse(vm);
  } catch (e) {
    return [null, null, null];
  }
  const vl = vmj.video_list || [];
  const rank = (codec) => {
    if (['h265', 'h264', 'h265_hvc1', 'hevc', 'hvc1', 'avc1'].includes(codec)) return 0;
    if (codec === 'bytevc1') return 1;
    return 2;
  };
  const cmp = (a, b) => {
    if (a.defNum !== b.defNum) return a.defNum - b.defNum;
    if (a.pixels !== b.pixels) return a.pixels - b.pixels;
    if (a.codecRank !== b.codecRank) return b.codecRank - a.codecRank;
    return a.bitrate - b.bitrate;
  };
  let best = null;
  let bestScore = null;
  for (const v of vl) {
    if (!v.main_url) continue;
    const codec = (v.video_meta && v.video_meta.codec_type) || '';
    const ei = v.encrypt_info || {};
    const s = { ...streamScore(v), codecRank: rank(codec) };
    if (!bestScore || cmp(s, bestScore) > 0) {
      bestScore = s;
      best = [v.main_url, ei.spade_a || null, codec];
    }
  }
  return best || [null, null, null];
}

/** 取播放流：content_type 决定内容池（官方剧 1004、用户投稿 1001），按优先级自动回退 */
const PLAY_CONTENT_TYPES = ['1004', '1001', '1003', '1002'];
let lastGoodContentType = '1004';

function buildContentTypeOrder(ct) {
  const first = ct ? String(ct) : lastGoodContentType;
  const rest = PLAY_CONTENT_TYPES.filter((x) => x !== first);
  return [first, ...rest];
}

async function fetchPlayUrlSingle(vid, contentType) {
  const order = buildContentTypeOrder(contentType);
  for (const ct of order) {
    try {
      const j = await signedPost('/novel/player/multi_video_model/v1/', {
        biz_param: MODEL_BIZ_PARAM,
        mixed_video_id_map: { [ct]: [vid] },
      });
      if (!j || j.code !== 0) continue;
      const item = (j.data || {})[vid] || {};
      const [playUrl, spadeA, codec] = parseModelVideo(item.video_model);
      if (!playUrl) continue;
      lastGoodContentType = ct;
      return { url: playUrl, spadeA, codec, content_type: ct };
    } catch (e) {
      // 换下一种类型继续试
    }
  }
  return { url: null, spadeA: null, codec: null, content_type: null };
}

/** FFmpeg 兼容 Base64 解码 */
function avBase64Decode(s) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const table = {};
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  const dst = [];
  let i = 0;
  while (i + 4 <= s.length) {
    const vals = [];
    let ok = true;
    for (let j = 0; j < 4; j++) {
      const c = s.charCodeAt(i + j);
      if (c in table) {
        vals.push(table[c]);
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) {
      let v = 0;
      for (let j2 = 0; j2 < vals.length; j2++) {
        v = (v << 6) | vals[j2];
      }
      if (vals.length === 3) {
        dst.push((v >> 10) & 0xff);
        dst.push((v >> 2) & 0xff);
      } else if (vals.length === 2) {
        dst.push((v >> 4) & 0xff);
      }
      break;
    }
    const v = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
    dst.push((v >> 16) & 0xff);
    dst.push((v >> 8) & 0xff);
    dst.push(v & 0xff);
    i += 4;
  }
  return Buffer.from(dst);
}

/**
 * spade_a -> 16 字节 AES Key（带格式校验，失败返回 null 而不是产出错误 key）
 */
function deriveKey(spadeA) {
  if (!spadeA) return null;
  const buf = avBase64Decode(spadeA);
  const L = buf.length;
  if (L < 3) return null;

  const key0 = buf[0] ^ buf[1] ^ buf[2];
  const x27 = key0 - 0x30;
  const w22 = L - key0 + 0x2f;
  if (x27 < 2 || w22 < 2 || w22 > L - 1) return null;

  const x21 = Buffer.from(buf.subarray(1, 1 + w22));
  let w11 = 0x55,
    w12 = 0xfa,
    w10 = 0xeb;
  for (let i = 0; i < x21.length; i++) {
    const w13 = x21[i];
    const pc = i.toString(2).split('1').length - 1;
    const w14 = (i & 1) === 0 ? w12 : w11;
    if ((i & 1) === 1) {
      w11 = w13;
    } else {
      w12 = w13;
    }
    x21[i] = (w10 - pc + (w14 ^ x21[i])) & 0xff;
  }

  const c0 = x21[0];
  let hval = 0;
  if (0x30 <= c0 && c0 <= 0x39) {
    hval = c0 - 0x30;
  } else if (0x61 <= c0 && c0 <= 0x7a) {
    hval = c0 - 0x57;
  } else {
    return null;
  }

  const w9 = w22 - hval;
  if (w9 < 2) return null;

  const strA = x21.subarray(1, 1 + w9 - 1).toString('ascii');
  if (strA.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(strA)) return null;
  return Buffer.from(strA, 'hex');
}

/** AES-128-ECB（仅用于生成 CTR 密钥流） */
function aes128EcbEncrypt(key16, data) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key16, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** CENC-AES-CTR 解密单个样本 */
function decryptSample(key, nonce, cipher) {
  if (!cipher || cipher.length === 0) return Buffer.alloc(0);
  const nblocks = Math.ceil(cipher.length / 16);
  const full = Buffer.alloc(nblocks * 16);
  for (let k = 0; k < nblocks; k++) {
    nonce.copy(full, k * 16, 0, 8);
    full.writeBigUInt64BE(BigInt(k), k * 16 + 8);
  }
  const ks = aes128EcbEncrypt(key, full);
  const plain = Buffer.alloc(cipher.length);
  for (let i = 0; i < cipher.length; i++) {
    plain[i] = cipher[i] ^ ks[i];
  }
  return plain;
}

/** MP4 Box 结构解析 */
function parseBoxes(data, start, end) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = data.readUInt32BE(off);
    const typ = data.subarray(off + 4, off + 8).toString('latin1');
    let hdr = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) break;
    let children = null;
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta'].includes(typ)) {
      children = parseBoxes(data, off + hdr, off + size);
    }
    boxes.push({ typ, off, size, hdr, children });
    off += size;
  }
  return boxes;
}

/** 重建 moov box（去掉加密盒、改写 sample entry、修正 stco） */
function rebuildMoov(data, moovOff, moovSize, top) {
  const moovBox = top.find((b) => b.typ === 'moov');
  if (!moovBox) throw new Error('no moov box');

  function clone(box) {
    return {
      typ: box.typ,
      off: box.off,
      size: box.size,
      hdr: box.hdr,
      children: box.children ? box.children.map(clone) : null,
    };
  }

  function prune(box) {
    if (!box.children) return box;
    const keep = [];
    for (const c of box.children) {
      if (['senc', 'saio', 'saiz', 'sgpd', 'sbgp'].includes(c.typ)) continue;
      keep.push(prune(c));
    }
    box.children = keep;
    return box;
  }

  const tree = prune(clone(moovBox));

  function* walkChildren(box) {
    for (const c of box.children || []) {
      yield c;
      for (const x of walkChildren(c)) yield x;
    }
  }

  const patches = {};
  for (const b of walkChildren(tree)) {
    if (b.typ === 'stsd') {
      const content = b.off + 8;
      const count = data.readUInt32BE(content + 4);
      let p = content + 8;
      const entries = [];
      for (let i = 0; i < count; i++) {
        let esize = data.readUInt32BE(p);
        const etyp = data.subarray(p + 4, p + 8).toString('latin1');
        if (etyp === 'encv' || etyp === 'enca') {
          const newType = etyp === 'encv' ? 'hvc1' : 'mp4a';
          const hdrSize = etyp === 'encv' ? 78 : 28;
          const entry = Buffer.alloc(8 + hdrSize);
          entry.writeUInt32BE(0, 0);
          entry.write(newType, 4, 4, 'latin1');
          data.copy(entry, 8, p + 8, p + 8 + hdrSize);

          let entryExtra = Buffer.alloc(0);
          let q = p + 8 + hdrSize;
          while (q + 8 <= p + esize) {
            let s2 = data.readUInt32BE(q);
            const t2 = data.subarray(q + 4, q + 8).toString('latin1');
            if (s2 === 1) {
              s2 = Number(data.readBigUInt64BE(q + 8));
            } else if (s2 === 0) {
              s2 = p + esize - q;
            }
            if (t2 !== 'sinf') {
              entryExtra = Buffer.concat([entryExtra, data.subarray(q, q + s2)]);
            }
            q += s2;
          }
          const fullEntry = Buffer.concat([entry, entryExtra]);
          fullEntry.writeUInt32BE(fullEntry.length, 0);
          entries.push(fullEntry);
        } else {
          entries.push(data.subarray(p, p + esize));
        }
        p += esize;
      }
      const stsdHdr = Buffer.alloc(16);
      data.copy(stsdHdr, 0, b.off, content + 8);
      stsdHdr.writeUInt32BE(entries.length, 12);
      const fullStsd = Buffer.concat([stsdHdr, ...entries]);
      fullStsd.writeUInt32BE(fullStsd.length, 0);
      patches[b.off] = fullStsd;
    }
  }

  function serialize(box) {
    if (!box.children) {
      return patches[box.off] || data.subarray(box.off, box.off + box.size);
    }
    const body = Buffer.concat(box.children.map(serialize));
    const hdrb = Buffer.alloc(box.hdr);
    data.copy(hdrb, 0, box.off, box.off + box.hdr);
    if (box.hdr === 8) {
      hdrb.writeUInt32BE(8 + body.length, 0);
    } else {
      hdrb.writeUInt32BE(1, 0);
      hdrb.writeBigUInt64BE(BigInt(16 + body.length), 8);
    }
    return Buffer.concat([hdrb, body]);
  }

  const first = serialize(tree);
  const delta = moovSize - first.length;

  for (const b of walkChildren(tree)) {
    if (b.typ === 'stco') {
      const nc = data.readUInt32BE(b.off + 12);
      for (let i = 0; i < nc; i++) {
        const v = data.readUInt32BE(b.off + 16 + i * 4);
        if (v >= delta) {
          data.writeUInt32BE(v - delta, b.off + 16 + i * 4);
        }
      }
    }
  }

  return serialize(tree);
}

/**
 * 解密 MP4 文件并保存（CENC-AES-CTR 逐样本 + moov 重写）
 */
function decryptMp4File(srcPath, dstPath, key) {
  const data = fs.readFileSync(srcPath);
  const total = data.length;
  const top = parseBoxes(data, 0, total);
  const moov = top.find((b) => b.typ === 'moov');
  if (!moov) throw new Error('no moov box found in MP4');

  function getBox(boxes, typ) {
    return (boxes || []).find((b) => b.typ === typ);
  }

  function* walkBoxes(boxes) {
    for (const b of boxes) {
      if (b.children) {
        for (const x of walkBoxes(b.children)) yield x;
      }
      yield b;
    }
  }

  const stbls = Array.from(walkBoxes(top)).filter((b) => b.typ === 'stbl');
  const trackInfo = [];
  for (const stbl of stbls) {
    const stsz = getBox(stbl.children, 'stsz');
    const stco = getBox(stbl.children, 'stco');
    const stsc = getBox(stbl.children, 'stsc');
    const senc = getBox(stbl.children, 'senc');
    if (!stsz || !stco || !stsc) continue;

    const ss = data.readUInt32BE(stsz.off + 12);
    const n = data.readUInt32BE(stsz.off + 16);
    let sizes = [];
    if (ss === 0) {
      for (let i = 0; i < n; i++) {
        sizes.push(data.readUInt32BE(stsz.off + 20 + i * 4));
      }
    } else {
      sizes = new Array(n).fill(ss);
    }

    const nc = data.readUInt32BE(stco.off + 12);
    const chunkOffs = [];
    for (let i = 0; i < nc; i++) {
      chunkOffs.push(data.readUInt32BE(stco.off + 16 + i * 4));
    }

    const ns = data.readUInt32BE(stsc.off + 12);
    const stscTab = [];
    for (let i = 0; i < ns; i++) {
      stscTab.push([
        data.readUInt32BE(stsc.off + 16 + i * 12),
        data.readUInt32BE(stsc.off + 20 + i * 12),
        data.readUInt32BE(stsc.off + 24 + i * 12),
      ]);
    }

    const ivs = [];
    if (senc) {
      const sc = data.readUInt32BE(senc.off + 12);
      for (let i = 0; i < sc; i++) {
        ivs.push(data.subarray(senc.off + 16 + i * 8, senc.off + 24 + i * 8));
      }
    }

    const chunkSpc = {};
    for (let i = 0; i < stscTab.length; i++) {
      const fc = stscTab[i][0];
      const spc = stscTab[i][1];
      const nxt = i + 1 < stscTab.length ? stscTab[i + 1][0] : nc + 1;
      for (let ci = fc - 1; ci < nxt - 1; ci++) {
        chunkSpc[ci] = spc;
      }
    }

    const sampleOffs = [];
    let si = 0;
    for (let ci = 0; ci < nc; ci++) {
      let off = chunkOffs[ci];
      const spc = chunkSpc[ci] || 1;
      for (let s = 0; s < spc; s++) {
        if (si >= n) break;
        sampleOffs.push(off);
        off += sizes[si];
        si++;
      }
    }

    trackInfo.push({ sizes, offs: sampleOffs, ivs, stco });
  }

  for (const ti of trackInfo) {
    for (let i = 0; i < ti.offs.length; i++) {
      const off = ti.offs[i];
      const sz = ti.sizes[i];
      if (off + sz > total) continue;
      if (i < ti.ivs.length) {
        const nonce = ti.ivs[i].subarray(0, 8);
        const cipher = data.subarray(off, off + sz);
        const plain = decryptSample(key, nonce, cipher);
        plain.copy(data, off);
      }
    }
  }

  const newMoov = rebuildMoov(data, moov.off, moov.size, top);
  const out = [];
  let off = 0;
  while (off < total) {
    let size = data.readUInt32BE(off);
    const typ = data.subarray(off + 4, off + 8).toString('latin1');
    let hdr = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = total - off;
    }
    if (typ === 'moov') {
      out.push(newMoov);
    } else {
      out.push(data.subarray(off, off + size));
    }
    off += size;
  }

  fs.writeFileSync(dstPath, Buffer.concat(out));
}

module.exports = {
  initDevice,
  setDevice,
  getDevice,
  resolveSeriesId,
  fetchEpisodeList,
  fetchPlayUrlSingle,
  searchSeries,
  searchSuggest,
  signedPost,
  signedGet,
  deriveKey,
  decryptMp4File,
  extractInput,
  VIDEO_REFERER,
  UA,
};

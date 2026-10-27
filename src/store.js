/**
 * store.js - 单 JSON 文件持久化（设置 + 下载任务）
 */
const fs = require('fs');
const path = require('path');

let dataFile = null;
let cache = null;
let writing = false;
let pendingFlush = false;

function loadCache() {
  if (!dataFile) throw new Error('store 未初始化');
  if (cache) return cache;
  try {
    if (fs.existsSync(dataFile)) {
      cache = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
  } catch (e) {
    console.error('[Store] 读取数据文件失败，使用空数据:', e.message);
  }
  if (!cache || typeof cache !== 'object') cache = {};
  if (!Array.isArray(cache.tasks)) cache.tasks = [];
  if (!cache.settings || typeof cache.settings !== 'object') cache.settings = {};
  if (!Array.isArray(cache.history)) cache.history = [];   // 解析历史
  if (!cache.records || typeof cache.records !== 'object') cache.records = {}; // 下载记录
  return cache;
}

function flush() {
  // 异步写盘：大批量任务时避免同步 IO 卡住主进程导致界面卡顿
  if (!dataFile || writing) {
    if (writing) pendingFlush = true;
    return;
  }
  writing = true;
  const json = JSON.stringify(cache || {}); // 紧凑格式，体积比缩进格式小数倍
  const tmp = dataFile + '.tmp';
  fs.mkdir(path.dirname(dataFile), { recursive: true }, () => {
    fs.writeFile(tmp, json, 'utf8', (err1) => {
      if (err1) {
        writing = false;
        console.error('[Store] 写入数据文件失败:', err1.message);
        return;
      }
      fs.rename(tmp, dataFile, () => {
        writing = false;
        if (pendingFlush) {
          pendingFlush = false;
          flush();
        }
      });
    });
  });
}

function init(filePath) {
  dataFile = filePath;
  loadCache();
}

function getSettings() {
  return loadCache().settings;
}

function saveSettings(settings) {
  loadCache().settings = settings || {};
  flush();
}

function getTasks() {
  return loadCache().tasks;
}

function saveTasks(tasks) {
  loadCache().tasks = tasks || [];
  flush();
}

// ==================== 解析历史 ====================
function getHistory() {
  return loadCache().history;
}

function addHistory(entry) {
  const h = loadCache().history;
  const idx = h.findIndex((x) => x.seriesId === entry.seriesId);
  if (idx >= 0) h.splice(idx, 1); // 同一部剧提到最前
  h.unshift(entry);
  if (h.length > 30) h.length = 30; // 最多保留 30 条
  flush();
}

// ==================== 下载记录（按短剧聚合，永久保存） ====================
function getRecords() {
  return loadCache().records;
}

function recordDownload(seriesId, patch) {
  const recs = loadCache().records;
  const key = String(seriesId || '');
  if (!key) return;
  const rec = recs[key] || { seriesId: key, count: 0, firstAt: Date.now() };
  Object.assign(rec, patch);
  rec.count = (rec.count || 0) + 1;
  rec.lastAt = Date.now();
  recs[key] = rec;
  flush();
}

module.exports = {
  init, getSettings, saveSettings, getTasks, saveTasks,
  getHistory, addHistory, getRecords, recordDownload,
};

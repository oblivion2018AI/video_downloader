/**
 * main.js - 红果短剧下载器 主进程
 *
 * 功能：
 *   1. 解析（分享链接 / 长文本 / series_id -> 全剧集列表）
 *   2. 下载队列：并发数可调（1-10）、断点续传（.part + Range）、失败自动轮询重试
 *   3. 下载管理：暂停/继续/重试/删除（单个+批量）、清空已完成/失败、打开所在文件夹
 *   4. 文件组织：下载目录/短剧标题/短剧标题_第NNN集.mp4
 *   5. 封面 HEIC -> JPEG dataURL 代理
 *
 * 无广告、无外链弹窗、无遥测；数据全部本地存储。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const heicDecode = require('heic-decode');
const jpeg = require('jpeg-js');

const hongguo = require('./src/native/hongguo');
const store = require('./src/store');

let mainWindow = null;

// ==================================================================
// 设置
// ==================================================================
function defaultSettings() {
  return {
    root: path.join(app.getPath('downloads'), '红果短剧'),
    max_concurrent: 3,   // 同时下载个数 1-10
    max_retries: 5,      // 失败后自动轮询重试次数
  };
}

let maxConcurrent = 3;
let maxRetries = 5;

function getSettings() {
  const saved = store.getSettings() || {};
  const merged = { ...defaultSettings(), ...saved };
  const mc = parseInt(merged.max_concurrent, 10);
  merged.max_concurrent = Number.isInteger(mc) && mc >= 1 && mc <= 10 ? mc : 3;
  const mr = parseInt(merged.max_retries, 10);
  merged.max_retries = Number.isInteger(mr) && mr >= 0 && mr <= 20 ? mr : 5;
  if (!merged.root || !String(merged.root).trim()) merged.root = defaultSettings().root;
  maxConcurrent = merged.max_concurrent;
  maxRetries = merged.max_retries;
  return merged;
}

// 净化文件夹/文件名
function sanitizeName(name) {
  return (
    String(name || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 80) || '未命名短剧'
  );
}

// ==================================================================
// 下载任务
// ==================================================================
// status: pending | downloading | paused | retrying | failed | completed
let tasks = [];
let saveTimer = null;

function loadTasks() {
  const saved = store.getTasks() || [];
  tasks = saved.map((t) => {
    // 启动时把上次中断的任务统一置为「已暂停」，保留 .part 断点可继续
    if (t.status === 'downloading' || t.status === 'pending' || t.status === 'retrying') {
      return { ...t, status: 'paused', pauseReason: '应用关闭时中断，可继续下载' };
    }
    return t;
  });
}

function persistTasks() {
  const serializable = tasks.map((t) => {
    const { writer, cancelSource, ...rest } = t;
    delete rest._lastBytes;
    delete rest._lastTs;
    return rest;
  });
  try {
    store.saveTasks(serializable);
  } catch (e) {
    console.error('[Store] 保存任务失败:', e.message);
  }
}

function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistTasks();
  }, 500);
}

// ==================================================================
// 快照推送（结构性变化 -> 全量快照；下载进度 -> 单任务轻量事件）
// ==================================================================
let snapshotTimer = null;
function emitSnapshotSoon() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    sendToRenderer('tasks-snapshot', { tasks: serializeTasks(), settings: getSettings() });
  }, 350);
}

function serializeTasks() {
  return tasks.map((t) => {
    const { writer, cancelSource, ...rest } = t;
    delete rest._lastBytes;
    delete rest._lastTs;
    return rest;
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function emitProgress(task, force) {
  const now = Date.now();
  if (!force && task._lastTs && now - task._lastTs < 400) return;
  const dt = now - (task._lastTs || now);
  const dBytes = task.receivedBytes - (task._lastBytes == null ? task.receivedBytes : task._lastBytes);
  const instSpeed = dt > 0 ? Math.max(0, dBytes / (dt / 1000)) : 0;
  // 指数平滑速度
  task.speed = task.speed == null ? instSpeed : Math.round(task.speed * 0.6 + instSpeed * 0.4);
  task._lastTs = now;
  task._lastBytes = task.receivedBytes;
  sendToRenderer('task-progress', {
    id: task.id,
    status: task.status,
    progress: task.progress,
    receivedBytes: task.receivedBytes,
    totalBytes: task.totalBytes,
    speed: task.speed || 0,
    nextRetryAt: task.nextRetryAt || 0,
    retries: task.retries || 0,
  });
}

// ==================================================================
// 下载泵（并发 maxConcurrent）
// ==================================================================
let activeDownloads = 0;

function processQueue() {
  while (activeDownloads < maxConcurrent) {
    const task = tasks.find((t) => t.status === 'pending');
    if (!task) break;
    activeDownloads++;
    executeDownload(task)
      .catch((err) => console.error('[Download] 任务异常:', err && err.message))
      .finally(() => {
        activeDownloads = Math.max(0, activeDownloads - 1);
        // 微延迟避免同步递归风暴
        setImmediate(processQueue);
      });
  }
}

function setTaskStatus(task, status, extra) {
  task.status = status;
  if (extra) Object.assign(task, extra);
  emitSnapshotSoon();
}

// ==================================================================
// 失败轮询重试：失败 -> 等待退避间隔 -> 自动重新入队；超过上限 -> failed
// ==================================================================
const retryTimer = setInterval(() => {
  const now = Date.now();
  let woke = false;
  for (const t of tasks) {
    if (t.status === 'retrying' && t.nextRetryAt && now >= t.nextRetryAt) {
      t.nextRetryAt = 0;
      setTaskStatus(t, 'pending');
      woke = true;
    }
  }
  if (woke) {
    persistTasks();
    processQueue();
  }
}, 1000);

function scheduleRetry(task, errMsg) {
  task.lastError = errMsg;
  task.retries = (task.retries || 0) + 1;
  if (task.retries <= maxRetries) {
    const delay = Math.min(60000, 5000 * Math.pow(2, task.retries - 1)); // 5s/10s/20s/40s/60s
    task.nextRetryAt = Date.now() + delay;
    task.error = `${errMsg}（第 ${task.retries}/${maxRetries} 次自动重试，${Math.round(delay / 1000)}s 后）`;
    console.error(`[自动重试 ${task.retries}/${maxRetries}] 《${task.seriesTitle}》第${task.vidIndex}集：${errMsg} —— ${Math.round(delay / 1000)}s 后自动重试（任务仍在「下载中」列表）`);
    setTaskStatus(task, 'retrying');
    persistTasks();
  } else {
    task.nextRetryAt = 0;
    task.error = `${errMsg}（已自动重试 ${maxRetries} 次仍失败）`;
    console.error(`[最终失败] 《${task.seriesTitle}》第${task.vidIndex}集：${errMsg} —— 已移入「下载失败」列表`);
    setTaskStatus(task, 'failed');
    task.finishedAt = Date.now();
    persistTasks();
    maybeNotifyAllDone();
  }
}

// ==================================================================
// 全部下载结束通知（系统通知 + 页内提示）
// ==================================================================
let allDoneNotified = false;
function maybeNotifyAllDone() {
  if (tasks.some((t) => ['downloading', 'pending', 'retrying'].includes(t.status))) {
    allDoneNotified = false; // 又有新任务在跑，重置通知标记
    return;
  }
  // 还有暂停中的任务不算结束（等用户手动继续后再判断）
  if (tasks.some((t) => t.status === 'paused')) return;
  if (allDoneNotified) return;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const fail = tasks.filter((t) => t.status === 'failed').length;
  if (done + fail === 0) return;
  allDoneNotified = true;
  const summary = fail > 0
    ? `成功 ${done} 个，失败 ${fail} 个（可在「下载失败」里重试）`
    : `共 ${done} 个视频全部下载完成`;
  if (Notification.isSupported()) {
    try {
      const n = new Notification({ title: '红果短剧下载器', body: `全部下载任务已结束：${summary}` });
      n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
      n.show();
    } catch (e) { /* 通知失败不影响主流程 */ }
  }
  sendToRenderer('all-finished', { done, fail });
  console.log(`[通知] 全部下载任务已结束：${summary}`);
}

// ==================================================================
// 单任务执行（流式下载 + Range 断点续传 + 解密）
// ==================================================================
async function executeDownload(task) {
  if (task.status !== 'pending' || task.removed) return;
  const { vid, seriesTitle, vidIndex, contentType } = {
    vid: task.vid,
    seriesTitle: task.seriesTitle,
    vidIndex: task.vidIndex,
    contentType: task.contentType,
  };

  try {
    setTaskStatus(task, 'downloading');
    task.startedAt = task.startedAt || Date.now();
    emitProgress(task, true);

    // 1. 取播放直链 + 加密信息
    const playInfo = await hongguo.fetchPlayUrlSingle(vid, contentType);
    if (task.removed) return;
    if (task.pauseRequested) return doPause(task);
    if (!playInfo || !playInfo.url) {
      throw new Error('未获取到有效播放地址（接口可能限流）');
    }

    // 2. 目录与文件名：下载目录/剧名/剧名_第NNN集.mp4
    const settings = getSettings();
    const seriesFolder = sanitizeName(seriesTitle);
    const downloadDir = path.join(settings.root, seriesFolder);
    fs.mkdirSync(downloadDir, { recursive: true });

    const idxStr = String(vidIndex).padStart(3, '0');
    const finalPath = path.join(downloadDir, `${seriesFolder}_第${idxStr}集.mp4`);
    const tmpPath = finalPath + '.part';
    task.savePath = finalPath;
    task.dir = downloadDir;

    // 目标已存在且大小合格 -> 直接完成（重复入队保护）
    if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 100 * 1024) {
      finishTask(task, finalPath);
      return;
    }

    if (task.pauseRequested) return doPause(task);

    // 3. 流式下载（支持 Range 断点续传）
    const startByte = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
    const CancelToken = axios.CancelToken;
    const source = CancelToken.source();
    task.cancelSource = source;

    const requestOnce = (extraHeaders) =>
      axios({
        method: 'GET',
        url: playInfo.url,
        responseType: 'stream',
        headers: {
          'User-Agent': hongguo.UA,
          'Accept-Encoding': 'identity',
          ...(startByte > 0 ? { Range: `bytes=${startByte}-` } : {}),
          ...extraHeaders,
        },
        timeout: 60000,
        maxRedirects: 5,
        cancelToken: source.token,
      });

    let response;
    try {
      response = await requestOnce({});
    } catch (err) {
      if (axios.isCancel(err)) throw err;
      const status = err.response && err.response.status;
      if (status === 403 || status === 401) {
        response = await requestOnce({ Referer: hongguo.VIDEO_REFERER });
      } else {
        throw err;
      }
    }

    if (task.removed) return;
    if (task.pauseRequested) {
      try { response.data.destroy(); } catch (_) {}
      return doPause(task);
    }

    // 服务器不支持 Range（返回 200 而不是 206）-> 从头下载
    let appendMode = false;
    let baseBytes = startByte;
    if (startByte > 0 && response.status !== 206) {
      baseBytes = 0;
      appendMode = false;
    } else if (startByte > 0 && response.status === 206) {
      appendMode = true;
    }

    const contentLength = parseInt(response.headers['content-length'], 10) || 0;
    const totalBytes = contentLength ? baseBytes + contentLength : 0;
    task.totalBytes = totalBytes;

    const writer = fs.createWriteStream(tmpPath, { flags: appendMode ? 'a' : 'w' });
    task.writer = writer;
    task.receivedBytes = baseBytes;
    task._lastBytes = baseBytes;
    task._lastTs = 0;

    response.data.on('data', (chunk) => {
      task.receivedBytes += chunk.length;
      task.progress = totalBytes ? Math.min(99, Math.floor((task.receivedBytes / totalBytes) * 100)) : 0;
      emitProgress(task, false);
    });

    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
      response.data.on('aborted', () => reject(new Error('连接中断')));
    });
    delete task.writer;
    delete task.cancelSource;

    if (task.removed) return;
    if (task.pauseRequested) return doPause(task);

    const downloaded = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
    if (downloaded === 0) throw new Error('下载内容为空');

    // 4. 解密（spade_a -> AES key -> CENC-AES-CTR）
    if (playInfo.spadeA) {
      const key = hongguo.deriveKey(playInfo.spadeA);
      if (!key) {
        throw new Error('Key 派生失败（加密信息格式变更，spade_a 长度 ' + String(playInfo.spadeA).length + '）');
      }
      hongguo.decryptMp4File(tmpPath, finalPath, key);
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    } else {
      try {
        fs.renameSync(tmpPath, finalPath);
      } catch (_) {
        fs.copyFileSync(tmpPath, finalPath);
        try { fs.unlinkSync(tmpPath); } catch (__) {}
      }
    }

    if (task.removed) {
      try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (_) {}
      return;
    }

    finishTask(task, finalPath);
  } catch (error) {
    delete task.writer;
    delete task.cancelSource;

    if (task.removed) return;
    if (task.pauseRequested || axios.isCancel(error) || (error && error.code === 'ERR_CANCELED')) {
      return doPause(task);
    }
    scheduleRetry(task, error.message || '未知错误');
    emitProgress(task, true);
  }
}

function finishTask(task, finalPath) {
  task.status = 'completed';
  task.progress = 100;
  task.speed = 0;
  task.finishedAt = Date.now();
  delete task.error;
  delete task.pauseRequested;
  persistTasks();
  emitSnapshotSoon();
  emitProgress(task, true);
  sendToRenderer('download-completed', { id: task.id, path: finalPath });
  // 下载记录（按短剧聚合，供「下载记录」页展示）
  try {
    store.recordDownload(task.seriesId, {
      title: task.seriesTitle || '',
      cover: task.cover || '',
      dir: path.dirname(finalPath),
    });
  } catch (e) { /* 记录失败不影响下载 */ }
  maybeNotifyAllDone();
}

// 暂停：保留 .part 断点，等待继续
function doPause(task) {
  delete task.pauseRequested;
  task.status = 'paused';
  task.speed = 0;
  task.pauseReason = '已暂停（保留断点）';
  persistTasks();
  emitSnapshotSoon();
  emitProgress(task, true);
}

// ==================================================================
// 批量操作
// ==================================================================
function findTask(id) {
  return tasks.find((t) => t.id === id);
}

// 暂停（取消下载，保留断点）
function pauseTask(task) {
  if (!task) return false;
  if (!['pending', 'downloading', 'retrying'].includes(task.status)) return false;
  task.pauseRequested = true;
  const qi = queueIndexOf(task.id);
  if (qi !== -1) removeFromQueue(task.id);
  if (task.status === 'pending' || task.status === 'retrying') {
    // 还没开始跑，直接置为暂停
    task.nextRetryAt = 0;
    doPause(task);
  } else if (task.cancelSource) {
    try { task.cancelSource.cancel('用户暂停'); } catch (_) {}
    if (task.writer) { try { task.writer.destroy(); } catch (_) {} }
  }
  return true;
}

// 简单队列（pending 任务直接扫 tasks 表，无需独立队列数组）
function queueIndexOf() {
  return -1;
}
function removeFromQueue() {}

// 继续/重试：清除断点状态重新入队（保留 .part 以便续传）
function resumeTask(task) {
  if (!task) return false;
  if (!['paused', 'failed', 'retrying'].includes(task.status)) return false;
  task.status = 'pending';
  task.retries = 0;
  task.nextRetryAt = 0;
  delete task.error;
  delete task.pauseRequested;
  delete task.pauseReason;
  task.speed = 0;
  emitSnapshotSoon();
  persistTasks();
  return true;
}

// 删除：取消下载 + 清理 .part + 从列表移除（不删除已完成的视频文件）
function removeTask(id) {
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  const task = tasks[idx];
  task.removed = true;
  task.pauseRequested = true;
  if (task.cancelSource) {
    try { task.cancelSource.cancel('用户删除任务'); } catch (_) {}
  }
  if (task.writer) {
    try { task.writer.destroy(); } catch (_) {}
  }
  // 清理未完成断点文件
  if (task.savePath) {
    const part = String(task.savePath) + '.part';
    try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch (_) {}
  }
  tasks.splice(idx, 1);
  return true;
}

// ==================================================================
// 封面代理（HEIC -> JPEG dataURL，带内存缓存）
// ==================================================================
const coverCache = new Map();
const COVER_CACHE_LIMIT = 120;

async function fetchCoverDataUrl(url) {
  const src = String(url || '').trim();
  if (!src || !/^https?:\/\//i.test(src)) return '';
  if (coverCache.has(src)) return coverCache.get(src);

  const res = await axios.get(src, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': hongguo.UA, Accept: 'image/*' },
  });
  const buf = Buffer.from(res.data);
  const contentType = String(res.headers['content-type'] || '').toLowerCase();
  let dataUrl;

  const isHeic =
    contentType.includes('heic') || contentType.includes('heif') || /\.heic(\?|$)/i.test(src);
  if (isHeic) {
    const image = await heicDecode({ buffer: buf });
    const encoded = jpeg.encode(
      { data: Buffer.from(image.data), width: image.width, height: image.height },
      72
    );
    dataUrl = 'data:image/jpeg;base64,' + encoded.data.toString('base64');
  } else if (contentType.includes('png')) {
    dataUrl = 'data:image/png;base64,' + buf.toString('base64');
  } else if (contentType.includes('webp')) {
    dataUrl = 'data:image/webp;base64,' + buf.toString('base64');
  } else if (contentType.includes('gif')) {
    dataUrl = 'data:image/gif;base64,' + buf.toString('base64');
  } else {
    dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
  }

  if (coverCache.size > COVER_CACHE_LIMIT) {
    coverCache.delete(coverCache.keys().next().value);
  }
  coverCache.set(src, dataUrl);
  return dataUrl;
}

// ==================================================================
// IPC
// ==================================================================
ipcMain.handle('hongguo-resolve', async (_e, input) => {
  try {
    const seriesId = await hongguo.resolveSeriesId(input);
    const data = await hongguo.fetchEpisodeList(seriesId);
    // 记录解析历史（供输入框下拉展示）
    try {
      store.addHistory({
        seriesId: String(data.series_id || seriesId),
        title: data.series_title || '',
        total: data.total || 0,
        input: String(input || '').slice(0, 500),
        time: Date.now(),
      });
    } catch (e) { /* 历史记录失败不影响解析 */ }
    return { success: true, data };
  } catch (error) {
    console.error('[Resolve] 解析失败:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('hongguo-search', async (_e, payload) => {
  try {
    const { keyword, offset } = payload || {};
    const data = await hongguo.searchSeries(keyword, { offset });
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('hongguo-download-batch', async (_e, payload) => {
  try {
    const { seriesId, seriesTitle, episodes } = payload || {};
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return { success: false, error: '未选择集数' };
    }

    const cleanTitle = sanitizeName(seriesTitle);
    const existingByVid = new Map();
    for (const t of tasks) {
      if (t.vid) existingByVid.set(String(t.vid), t);
    }

    const batchId = 'batch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    let added = 0;
    let skipped = 0;

    for (const ep of episodes) {
      const vidKey = String(ep.vid);
      const dup = existingByVid.get(vidKey);
      if (dup) {
        const busy = ['pending', 'downloading', 'paused', 'retrying'].includes(dup.status);
        const done = dup.status === 'completed' && dup.savePath && fs.existsSync(dup.savePath);
        if (busy || done) {
          skipped++;
          continue;
        }
      }

      const task = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
        batchId,
        seriesId: String(seriesId || ep.series_id || ''),
        seriesTitle: cleanTitle,
        vid: String(ep.vid),
        vidIndex: Number(ep.vid_index) || 0,
        epTitle: String(ep.title || ''),
        contentType: String(ep.content_type || ''),
        cover: ep.cover || '',
        title: `《${cleanTitle}》第${String(ep.vid_index).padStart(3, '0')}集`,
        status: 'pending',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        speed: 0,
        retries: 0,
        addedAt: Date.now(),
      };
      tasks.unshift(task);
      existingByVid.set(vidKey, task);
      added++;
    }

    persistTasks();
    emitSnapshotSoon();
    processQueue();

    if (added === 0) {
      return { success: false, error: `选中的 ${skipped} 集已在下载列表中或已完成` };
    }
    return { success: true, count: added, skipped };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-tasks', () => ({
  tasks: serializeTasks(),
  settings: getSettings(),
}));

ipcMain.handle('pause-tasks', (_e, ids) => {
  let n = 0;
  for (const id of ids || []) if (pauseTask(findTask(id))) n++;
  emitSnapshotSoon();
  return { success: true, count: n };
});

ipcMain.handle('resume-tasks', (_e, ids) => {
  let n = 0;
  for (const id of ids || []) if (resumeTask(findTask(id))) n++;
  persistTasks();
  emitSnapshotSoon();
  processQueue();
  return { success: true, count: n };
});

// resume-all：继续所有暂停的
ipcMain.handle('resume-all', () => {
  let n = 0;
  for (const t of tasks) if (resumeTask(t)) n++;
  persistTasks();
  emitSnapshotSoon();
  processQueue();
  return { success: true, count: n };
});

ipcMain.handle('remove-tasks', (_e, ids) => {
  let n = 0;
  for (const id of ids || []) if (removeTask(id)) n++;
  persistTasks();
  emitSnapshotSoon();
  return { success: true, count: n };
});

ipcMain.handle('clear-completed', () => {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.status !== 'completed');
  persistTasks();
  emitSnapshotSoon();
  return { success: true, count: before - tasks.length };
});

ipcMain.handle('clear-failed', () => {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.status !== 'failed');
  persistTasks();
  emitSnapshotSoon();
  return { success: true, count: before - tasks.length };
});

ipcMain.handle('get-settings', () => getSettings());

ipcMain.handle('save-settings', (_e, patch) => {
  try {
    const merged = { ...getSettings(), ...(patch || {}) };
    store.saveSettings(merged);
    const s = getSettings();
    emitSnapshotSoon();
    processQueue(); // 并发数变化后立即填充并发位
    return { success: true, settings: s };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-folder', async (_e, taskId) => {
  const task = findTask(taskId);
  if (!task) return { success: false, error: '任务不存在' };
  // 只打开文件所在文件夹，不定位/打开文件本身
  const dir = task.savePath ? path.dirname(task.savePath) : (task.dir || '');
  if (dir && fs.existsSync(dir)) {
    await shell.openPath(dir);
    return { success: true };
  }
  return { success: false, error: '文件夹尚未创建，开始下载后自动生成' };
});

ipcMain.handle('resolve-cover', async (_e, url) => {
  try {
    const dataUrl = await fetchCoverDataUrl(url);
    return { success: !!dataUrl, dataUrl };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 打开下载根目录
ipcMain.handle('open-root', async () => {
  const dir = getSettings().root;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 目录已存在 */ }
  await shell.openPath(dir);
  return { success: true };
});

// 打开任意本地目录（下载记录页用）
ipcMain.handle('open-path', async (_e, dir) => {
  if (dir && fs.existsSync(dir)) {
    await shell.openPath(dir);
    return { success: true };
  }
  return { success: false, error: '目录不存在' };
});

// 解析历史
ipcMain.handle('get-history', () => ({ history: store.getHistory() }));

// 下载记录（按下载时间倒序）
ipcMain.handle('get-records', () => ({
  records: Object.values(store.getRecords()).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)),
}));

// 应用信息（关于页版本号）
ipcMain.handle('get-app-info', () => ({
  name: '红果短剧下载器',
  version: app.getVersion(),
  electron: process.versions.electron || '',
}));

// ==================================================================
// 窗口与生命周期
// ==================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: '红果短剧下载器',
    autoHideMenuBar: true,
    backgroundColor: '#fdf3f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const dataDir = path.join(app.getPath('userData'), 'hongguo-drama-downloader');
    fs.mkdirSync(dataDir, { recursive: true });
    store.init(path.join(dataDir, 'data.json'));
    hongguo.initDevice(dataDir);
    loadTasks();
    getSettings();
    createWindow();
    emitSnapshotSoon();
    processQueue();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  clearInterval(retryTimer);
  persistTasks();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

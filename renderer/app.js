/**
 * app.js - 红果短剧下载器 渲染进程逻辑
 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ==================== 全局状态 ====================
const state = {
  view: 'download',            // download | manage
  series: null,                // 解析结果
  selectedEps: new Set(),      // 选中的集数 (vid_index)
  doneVids: new Set(),         // 已下载完成的 vid（本剧集范围内）
  tasks: [],                   // 全部下载任务
  settings: {},
  activeTab: 'active',         // active | completed | failed
  selectedTasks: new Set(),    // 勾选的任务 id
  collapsedGroups: new Set(),  // 折叠的短剧分组 key
};

// ==================== 工具 ====================
function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtSpeed(n) {
  return n > 0 ? fmtBytes(n) + '/s' : '';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function statusBadge(t) {
  switch (t.status) {
    case 'downloading': return '<span class="badge badge-dl">下载中</span>';
    case 'pending': return '<span class="badge badge-wait">排队中</span>';
    case 'paused': return '<span class="badge badge-pause">已暂停</span>';
    case 'retrying': return '<span class="badge badge-retry">重试中</span>';
    case 'completed': return '<span class="badge badge-done">已完成</span>';
    case 'failed': return '<span class="badge badge-fail">失败</span>';
    default: return '';
  }
}

function isActive(t) {
  return ['downloading', 'pending', 'paused', 'retrying'].includes(t.status);
}

/**
 * 解析范围输入："1-30 或 1,5,10" / "1-30,15" / "1~10 5"
 * 支持 中英文逗号、「或」「,」「-」「~」、空格分隔
 */
function parseRange(text, max) {
  const t = String(text || '').trim();
  if (!t) return null;
  const result = new Set();
  const parts = t.split(/[或,，\s]+/).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^(\d+)\s*[-~到]\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) {
        if (i >= 1 && i <= max) result.add(i);
      }
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= max) result.add(n);
    }
  }
  return result;
}

// ==================== 封面缓存 ====================
const coverCache = new Map();
async function coverUrl(url, imgEl) {
  if (!url) return;
  if (coverCache.has(url)) {
    if (imgEl) imgEl.src = coverCache.get(url);
    return;
  }
  const res = await window.api.resolveCover(url);
  if (res && res.success && res.dataUrl) {
    coverCache.set(url, res.dataUrl);
    if (imgEl && imgEl.isConnected) imgEl.src = res.dataUrl;
  }
}

// ==================== 视图切换 ====================
function switchView(view) {
  state.view = view;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#viewDownload').hidden = view !== 'download';
  $('#viewManage').hidden = view !== 'manage';
  $('#viewRecords').hidden = view !== 'records';
  if (view === 'manage') syncView();
  if (view === 'records') renderRecords();
}

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

// ==================== 解析 ====================
async function doResolve() {
  const input = $('#inputLink').value.trim();
  const msg = $('#resolveMsg');
  if (!input) {
    showMsg('请先输入短剧链接或 ID', 'err');
    return;
  }
  const btn = $('#btnResolve');
  btn.disabled = true;
  btn.textContent = '解析中…';
  showMsg('正在解析，请稍候…', 'ok');
  try {
    const res = await window.api.resolve(input);
    if (!res.success) throw new Error(res.error || '解析失败');
    state.series = res.data;
    state.selectedEps = new Set(res.data.episodes.map((e) => e.vid_index));
    // 标记已在下载列表/已完成的集数
    state.doneVids = new Set(
      state.tasks.filter((t) => t.status === 'completed' && t.seriesId === String(res.data.series_id)).map((t) => t.vid)
    );
    renderSeries();
    showMsg(`解析成功：《${res.data.series_title}》共 ${res.data.total} 集`, 'ok');
  } catch (err) {
    showMsg('解析失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '▤ 解析短剧';
  }
}

function showMsg(text, type) {
  const msg = $('#resolveMsg');
  msg.hidden = false;
  msg.className = 'msg ' + (type || 'ok');
  msg.textContent = text;
}

function renderSeries() {
  const s = state.series;
  if (!s) return;
  $('#seriesCard').hidden = false;
  $('#seriesTitle').textContent = `《${s.series_title}》`;
  $('#seriesTotal').textContent = s.total;
  $('#seriesId').textContent = s.series_id;
  const cover = $('#seriesCover');
  cover.src = '';
  coverUrl(s.cover, cover);
  renderEpGrid();
  updateSelectedCount();
}

function renderEpGrid() {
  const s = state.series;
  if (!s) return;
  const grid = $('#epGrid');
  const frag = document.createDocumentFragment();
  for (const ep of s.episodes) {
    const div = document.createElement('div');
    const checked = state.selectedEps.has(ep.vid_index);
    const done = state.doneVids.has(ep.vid);
    div.className = 'ep-item' + (checked ? ' checked' : '') + (done ? ' done' : '');
    div.innerHTML = `
      <div class="ep-num"><span class="ep-check">${checked ? '✓' : ''}</span>第 ${String(ep.vid_index).padStart(2, '0')} 集</div>
      <div class="ep-sub">${done ? '已下载' : (esc(ep.title) || '短剧视频，规…')}</div>`;
    div.addEventListener('click', () => {
      if (state.selectedEps.has(ep.vid_index)) state.selectedEps.delete(ep.vid_index);
      else state.selectedEps.add(ep.vid_index);
      renderEpGrid();
      updateSelectedCount();
    });
    frag.appendChild(div);
  }
  grid.replaceChildren(frag);
}

function updateSelectedCount() {
  $('#btnDownloadSelected').textContent = `⬇ 下载选中集数 (${state.selectedEps.size})`;
}

// 选择操作（全选/反选/取消）
$$('.chip[data-sel]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const s = state.series;
    if (!s) return;
    const mode = btn.dataset.sel;
    if (mode === 'all') {
      s.episodes.forEach((e) => state.selectedEps.add(e.vid_index));
    } else if (mode === 'none') {
      state.selectedEps.clear();
    } else if (mode === 'invert') {
      s.episodes.forEach((e) => {
        if (state.selectedEps.has(e.vid_index)) state.selectedEps.delete(e.vid_index);
        else state.selectedEps.add(e.vid_index);
      });
    }
    renderEpGrid();
    updateSelectedCount();
  });
});

// 快捷范围（前10/前30/后30）
$$('.chip[data-range]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const s = state.series;
    if (!s) return;
    const idxs = s.episodes.map((e) => e.vid_index).sort((a, b) => a - b);
    const mode = btn.dataset.range;
    let pick;
    if (mode === 'first10') pick = idxs.slice(0, 10);
    else if (mode === 'first30') pick = idxs.slice(0, 30);
    else if (mode === 'last30') pick = idxs.slice(-30);
    state.selectedEps = new Set(pick);
    renderEpGrid();
    updateSelectedCount();
  });
});

// 范围筛选应用
$('#btnApplyRange').addEventListener('click', () => {
  const s = state.series;
  if (!s) return;
  const set = parseRange($('#inputRange').value, s.total);
  if (!set || set.size === 0) {
    showMsg('范围格式不正确，示例：1-30 或 1,5,10', 'err');
    return;
  }
  state.selectedEps = set;
  renderEpGrid();
  updateSelectedCount();
  showMsg(`已按范围选中 ${set.size} 集`, 'ok');
});

// 下载选中
$('#btnDownloadSelected').addEventListener('click', async () => {
  const s = state.series;
  if (!s || state.selectedEps.size === 0) {
    showMsg('请先勾选要下载的集数', 'err');
    return;
  }
  const episodes = s.episodes.filter((e) => state.selectedEps.has(e.vid_index));
  const res = await window.api.downloadBatch({
    seriesId: s.series_id,
    seriesTitle: s.series_title,
    episodes,
  });
  if (res.success) {
    showMsg(`已加入下载队列 ${res.count} 集${res.skipped ? `（${res.skipped} 集已在列表中跳过）` : ''}`, 'ok');
    switchView('manage');
  } else {
    showMsg(res.error || '加入队列失败', 'err');
  }
});

$('#btnGotoManage').addEventListener('click', () => switchView('manage'));
$('#btnResolve').addEventListener('click', doResolve);
$('#inputLink').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doResolve();
});

// ==================== 下载管理 ====================
function tasksByTab() {
  return state.tasks.filter((t) => (state.activeTab === 'active' ? isActive(t) : t.status === state.activeTab));
}

function counts() {
  let active = 0, done = 0, fail = 0;
  for (const t of state.tasks) {
    if (isActive(t)) active++;
    else if (t.status === 'completed') done++;
    else if (t.status === 'failed') fail++;
  }
  return { active, done, fail };
}

function setVis(sel, show) {
  const el = $(sel);
  if (el) el.hidden = !show;
}

function renderStats() {
  const c = counts();
  $('#tabActive').textContent = c.active;
  $('#tabDone').textContent = c.done;
  $('#tabFail').textContent = c.fail;
  $('#navActiveCount').hidden = c.active === 0;
  $('#navActiveCount').textContent = c.active;
  const vis = tasksByTab();
  const selInTab = vis.filter((t) => state.selectedTasks.has(t.id)).length;
  $('#statSelected').textContent = selInTab;
  $('#btnRetrySel').textContent = `↻ 重试选中 (${selInTab})`;
  $('#btnRemoveSel').textContent = `🗑 删除选中 (${selInTab})`;

  // 运行中 / 暂停中（全局统计）
  const runningIds = state.tasks
    .filter((t) => ['downloading', 'pending', 'retrying'].includes(t.status))
    .map((t) => t.id);
  const pausedCnt = state.tasks.filter((t) => t.status === 'paused').length;

  // 工具栏按需显示规则：
  //   选中操作   -> 有勾选才显示
  //   全部暂停   -> 仅「下载中」标签页且有正在下载/排队的任务
  //   全部继续   -> 仅有已暂停任务时显示
  //   停止全部   -> 有正在下载/排队的任务时显示
  //   清空已完成 -> 仅「已完成」标签页
  //   清空失败   -> 仅「下载失败」标签页
  const showSel = selInTab > 0;
  // 「暂停选中下载」只对正在下载/排队的选中任务有意义；「取消选中下载」只对未完成的选中任务有意义
  const selActiveCnt = vis.filter(
    (t) => state.selectedTasks.has(t.id) && ['downloading', 'pending', 'retrying'].includes(t.status)
  ).length;
  const selUnfinishedCnt = vis.filter(
    (t) => state.selectedTasks.has(t.id) && t.status !== 'completed'
  ).length;
  $('#btnPauseSelDl').textContent = `‖ 暂停选中下载 (${selActiveCnt})`;
  $('#btnCancelSelDl').textContent = `✕ 取消选中下载 (${selUnfinishedCnt})`;
  const showPauseAll = state.activeTab === 'active' && runningIds.length > 0;
  const showResumeAll = pausedCnt > 0;
  const showStopAll = runningIds.length > 0;
  const showClearDone = state.activeTab === 'completed' && c.done > 0;
  const showClearFail = state.activeTab === 'failed' && c.fail > 0;

  setVis('#btnRetrySel', showSel);
  setVis('#btnPauseSelDl', showSel);
  setVis('#btnCancelSelDl', showSel);
  setVis('#btnRemoveSel', showSel);
  setVis('#btnCancelSel', showSel);
  setVis('#tbDivider', showSel);
  setVis('#btnPauseAll', showPauseAll);
  setVis('#btnResumeAll', showResumeAll);
  setVis('#btnStopAll', showStopAll);
  setVis('#btnClearDone', showClearDone);
  setVis('#btnClearFail', showClearFail);
  $('#toolbar').hidden = !(showSel || showPauseAll || showResumeAll || showStopAll || showClearDone || showClearFail);

  // 总选框三态：全选 / 半选 / 未选
  const master = $('#checkAll');
  if (master) {
    master.checked = vis.length > 0 && selInTab === vis.length;
    master.indeterminate = selInTab > 0 && selInTab < vis.length;
  }
}

// ==================== 增量渲染引擎（解决大批量任务卡顿） ====================
// 只在结构变化时增删/移动 DOM；进度类变化原地刷新对应条目，不整表重建 800+ 节点。
const listEl = $('#taskList');
const groupEls = new Map();    // 分组 key -> {wrap, body, countEl, chkEl}
const itemEls = new Map();     // 任务 id -> DOM 节点
let currentGroups = new Map(); // 分组 key -> 当前标签页内任务 id 列表

function reconcileChildren(parent, desired) {
  for (let i = 0; i < desired.length; i++) {
    if (parent.children[i] !== desired[i]) {
      parent.insertBefore(desired[i], parent.children[i] || null);
    }
  }
  while (parent.children.length > desired.length) {
    parent.removeChild(parent.lastChild);
  }
}

function makeGroupEl(key, firstTask) {
  const wrap = document.createElement('div');
  wrap.className = 'group' + (state.collapsedGroups.has(key) ? ' collapsed' : '');
  wrap.dataset.key = key;
  wrap.innerHTML = `
    <div class="group-head">
      <span class="group-arrow">▼</span>
      <div class="task-check group-check" data-act="checkgroup" title="全选 / 取消全选该短剧"></div>
      <img class="group-cover" alt="">
      <div class="group-name">《${esc(firstTask.seriesTitle)}》</div>
      <div class="group-progress"></div>
    </div>
    <div class="group-body"></div>`;
  wrap.querySelector('.group-head').addEventListener('click', (e) => {
    if (e.target.closest('[data-act]')) return; // 勾选框单独处理，不触发折叠
    if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
    else state.collapsedGroups.add(key);
    wrap.classList.toggle('collapsed');
  });
  wrap.querySelector('[data-act="checkgroup"]').addEventListener('click', (e) => {
    e.stopPropagation();
    const ids = currentGroups.get(key) || [];
    const allSel = ids.length > 0 && ids.every((id) => state.selectedTasks.has(id));
    if (allSel) ids.forEach((id) => state.selectedTasks.delete(id));
    else ids.forEach((id) => state.selectedTasks.add(id));
    syncView();
  });
  coverUrl(firstTask.cover, wrap.querySelector('.group-cover'));
  return {
    wrap,
    body: wrap.querySelector('.group-body'),
    countEl: wrap.querySelector('.group-progress'),
    chkEl: wrap.querySelector('.group-check'),
  };
}

function statusTextSummary(arr) {
  const dl = arr.filter((t) => t.status === 'downloading').length;
  const wait = arr.filter((t) => t.status === 'pending').length;
  const pause = arr.filter((t) => t.status === 'paused').length;
  const retry = arr.filter((t) => t.status === 'retrying').length;
  const parts = [];
  if (dl) parts.push(`下载中 ${dl}`);
  if (wait) parts.push(`排队 ${wait}`);
  if (retry) parts.push(`重试 ${retry}`);
  if (pause) parts.push(`已暂停 ${pause}`);
  return parts.join(' · ') || '等待中';
}

function refreshGroupHead(key, visibleArr) {
  const g = groupEls.get(key);
  if (!g) return;
  // 进度按整部剧统计（含其他标签页里的集数）
  const all = state.tasks.filter((t) => (t.seriesId || t.seriesTitle) === key);
  const doneAll = all.filter((t) => t.status === 'completed').length;
  let txt;
  if (state.activeTab === 'completed') {
    txt = `${doneAll}/${all.length} 集 · 全部完成`;
  } else if (state.activeTab === 'failed') {
    txt = `${doneAll}/${all.length} 集 · 失败 ${visibleArr.length}`;
  } else {
    txt = `${doneAll}/${all.length} 集 · ${statusTextSummary(visibleArr)}`;
  }
  if (g.countEl.dataset.txt !== txt) {
    g.countEl.dataset.txt = txt;
    g.countEl.textContent = txt;
  }
  const ids = currentGroups.get(key) || [];
  const selCnt = ids.filter((id) => state.selectedTasks.has(id)).length;
  const allSel = ids.length > 0 && selCnt === ids.length;
  g.chkEl.classList.toggle('checked', allSel);
  g.chkEl.classList.toggle('some', selCnt > 0 && !allSel);
  g.chkEl.textContent = allSel ? '✓' : (selCnt > 0 ? '–' : '');
}

// 确保条目节点存在且最新；状态没变时只轻量刷新数字，几乎零重排
function ensureItemEl(t) {
  let el = itemEls.get(t.id);
  if (!el || el.dataset.status !== t.status) {
    const fresh = renderTaskItem(t);
    if (el) el.replaceWith(fresh);
    itemEls.set(t.id, fresh);
    return fresh;
  }
  refreshItemDyn(t, el);
  return el;
}

function refreshItemDyn(t, el) {
  const checked = state.selectedTasks.has(t.id);
  const chk = el.querySelector('.task-check');
  if (chk.classList.contains('checked') !== checked) {
    chk.classList.toggle('checked', checked);
    chk.textContent = checked ? '✓' : '';
  }
  const sig = `${t.progress || 0}|${t.receivedBytes || 0}|${t.speed || 0}|${t.error || ''}`;
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    const sub = el.querySelector('.task-sub');
    if (sub) sub.innerHTML = taskSub(t);
    const fill = el.querySelector('.task-bar-fill');
    const pct = el.querySelector('.task-pct');
    if (fill) {
      fill.style.width = (t.progress || 0) + '%';
      fill.className = 'task-bar-fill' + (t.status === 'failed' ? ' fail' : '');
    }
    if (pct) pct.textContent = (t.progress || 0) + '%';
  }
}

// 总入口：把当前标签页 DOM 同步到与数据一致（增量）
function syncView() {
  renderStats();
  const items = tasksByTab();

  if (items.length === 0) {
    listEl.replaceChildren();
    const tip = document.createElement('div');
    tip.className = 'empty-tip';
    tip.textContent = state.activeTab === 'active' ? '暂无下载任务，去「视频下载」解析添加吧' : '这里空空如也';
    listEl.appendChild(tip);
    groupEls.clear();
    currentGroups = new Map();
    return;
  }

  // 三个标签页统一：按短剧分组 + 折叠（增量同步）
  const groups = new Map();
  for (const t of items) {
    const key = t.seriesId || t.seriesTitle;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const arr of groups.values()) arr.sort((a, b) => (a.vidIndex || 0) - (b.vidIndex || 0));

  currentGroups = new Map();
  const desiredWraps = [];
  for (const [key, arr] of groups) {
    let g = groupEls.get(key);
    if (!g) {
      g = makeGroupEl(key, arr[0]);
      groupEls.set(key, g);
    }
    desiredWraps.push(g.wrap);
    currentGroups.set(key, arr.map((t) => t.id));
    reconcileChildren(g.body, arr.map((t) => ensureItemEl(t)));
    refreshGroupHead(key, arr);
  }
  reconcileChildren(listEl, desiredWraps);
  for (const key of Array.from(groupEls.keys())) {
    if (!groups.has(key)) groupEls.delete(key);
  }
}

// 进度条 DOM 片段
function barHtml(pct, cls) {
  return `<div class="task-bar-wrap">
    <div class="task-bar"><div class="task-bar-fill${cls || ''}" style="width:${pct}%"></div></div>
    <span class="task-pct">${pct}%</span>
  </div>`;
}

// 单条目操作按钮（按状态显示）
function taskActions(t) {
  const active = ['downloading', 'pending', 'retrying'].includes(t.status);
  const ops = [];
  if (active) {
    ops.push(`<button class="act-btn act-pause" data-act="pause" title="暂停下载（保留进度，可继续）">暂停下载</button>`);
  }
  if (t.status === 'paused') {
    ops.push(`<button class="act-btn act-resume" data-act="resume" title="从断点继续下载">继续下载</button>`);
  }
  if (t.status === 'failed') {
    ops.push(`<button class="act-btn act-resume" data-act="resume" title="重新尝试下载">重试下载</button>`);
  }
  if (t.status !== 'completed') {
    ops.push(`<button class="act-btn act-cancel" data-act="cancel" title="取消并移除此任务（清理断点，保留已下好的文件）">取消</button>`);
  }
  ops.push(`<button class="act-btn act-folder" data-act="open" title="打开文件所在文件夹">打开文件夹</button>`);
  if (t.status === 'completed') {
    ops.push(`<button class="act-btn act-remove" data-act="remove" title="从列表移除（不删除视频文件）">移除</button>`);
  }
  return ops.join('');
}

// 单条目副信息（进度 / 视频大小 / 速度 / 失败原因）
function taskSub(t) {
  if (t.status === 'completed') {
    return `${statusBadge(t)} <span class="t-size">视频大小 ${fmtBytes(t.totalBytes) || '—'}</span>`;
  }
  if (t.status === 'failed') {
    return `${statusBadge(t)} <span class="task-err">${esc(t.error || '未知错误')}</span>`;
  }
  const sizeTxt = t.totalBytes
    ? `${fmtBytes(t.receivedBytes)} / ${fmtBytes(t.totalBytes)}`
    : (t.receivedBytes ? fmtBytes(t.receivedBytes) : '获取中…');
  const speed = t.status === 'downloading' ? fmtSpeed(t.speed) : '';
  return `${statusBadge(t)} <span class="t-size">${sizeTxt}</span>${speed ? ` <span class="t-speed">${speed}</span>` : ''}`;
}

function renderTaskItem(t) {
  const div = document.createElement('div');
  div.className = 'task-item' + (isActive(t) ? ' is-active' : '');
  div.dataset.id = t.id;
  div.dataset.status = t.status;

  const checked = state.selectedTasks.has(t.id);
  const pct = t.progress || 0;
  const barCls = t.status === 'completed' ? ' done' : t.status === 'failed' ? ' fail' : '';

  div.innerHTML = `
    <div class="task-check ${checked ? 'checked' : ''}" data-act="check">${checked ? '✓' : ''}</div>
    <img class="task-cover" alt="">
    <div class="task-main">
      <div class="task-title">${esc(t.title)}</div>
      <div class="task-sub">${taskSub(t)}</div>
      ${t.status === 'completed' ? '' : barHtml(pct, barCls)}
    </div>
    <div class="task-ops">${taskActions(t)}</div>`;
  div.dataset.sig = `${t.progress || 0}|${t.receivedBytes || 0}|${t.speed || 0}|${t.error || ''}`;

  coverUrl(t.cover, div.querySelector('.task-cover'));

  // 统一事件委托：data-act 按钮 + 点击空白打开文件夹
  div.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    if (actEl) {
      handleTaskAct(t.id, actEl.dataset.act);
      return;
    }
    window.api.openFolder(t.id);
  });

  return div;
}

// 单条目操作分发
function handleTaskAct(id, act) {
  switch (act) {
    case 'check':
      if (state.selectedTasks.has(id)) state.selectedTasks.delete(id);
      else state.selectedTasks.add(id);
      syncView();
      break;
    case 'pause':   // 暂停下载：保留断点
      window.api.pauseTasks([id]);
      break;
    case 'resume':  // 继续 / 重试下载
      window.api.resumeTasks([id]);
      break;
    case 'cancel':  // 取消：终止并移除此任务
      window.api.removeTasks([id]);
      state.selectedTasks.delete(id);
      break;
    case 'open':    // 打开文件位置
      window.api.openFolder(id);
      break;
    case 'remove':  // 从已完成列表移除（保留文件）
      window.api.removeTasks([id]);
      state.selectedTasks.delete(id);
      break;
  }
}

// Tab 切换
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.activeTab = tab.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('active', x === tab));
    syncView();
  });
});

// 总选框：全选 / 取消全选当前列表
$('#checkAll').addEventListener('change', (e) => {
  const vis = tasksByTab();
  if (e.target.checked) vis.forEach((t) => state.selectedTasks.add(t.id));
  else vis.forEach((t) => state.selectedTasks.delete(t.id));
  syncView();
});

// ==================== 批量操作 ====================
function selectedIdsInTab() {
  return tasksByTab().filter((t) => state.selectedTasks.has(t.id)).map((t) => t.id);
}

$('#btnRetrySel').addEventListener('click', async () => {
  const ids = selectedIdsInTab();
  if (!ids.length) return;
  await window.api.resumeTasks(ids); // paused/failed -> 重新入队
});
$('#btnRemoveSel').addEventListener('click', async () => {
  const ids = selectedIdsInTab();
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 个任务吗？（未完成的断点会一并清理，已下载的视频文件保留）`)) return;
  await window.api.removeTasks(ids);
  ids.forEach((id) => state.selectedTasks.delete(id));
});
// 暂停选中下载：仅暂停选中里正在下载/排队/重试的任务
$('#btnPauseSelDl').addEventListener('click', () => {
  const ids = selectedIdsInTab().filter((id) => {
    const t = state.tasks.find((x) => x.id === id);
    return t && ['downloading', 'pending', 'retrying'].includes(t.status);
  });
  if (ids.length) window.api.pauseTasks(ids);
});
// 取消选中下载：仅取消选中里未完成的任务（已完成的选择不受影响）
$('#btnCancelSelDl').addEventListener('click', () => {
  const ids = selectedIdsInTab().filter((id) => {
    const t = state.tasks.find((x) => x.id === id);
    return t && t.status !== 'completed';
  });
  if (!ids.length) return;
  if (!confirm(`确定取消选中的 ${ids.length} 个下载吗？（清理断点，已下载好的视频文件保留）`)) return;
  window.api.removeTasks(ids);
  ids.forEach((id) => state.selectedTasks.delete(id));
});
$('#btnCancelSel').addEventListener('click', () => {
  state.selectedTasks.clear();
  syncView();
});
// 全部暂停：下载中标签页使用，暂停所有下载中/排队/重试任务（保留断点）
$('#btnPauseAll').addEventListener('click', () => {
  const ids = state.tasks
    .filter((t) => ['downloading', 'pending', 'retrying'].includes(t.status))
    .map((t) => t.id);
  if (ids.length) window.api.pauseTasks(ids);
});
$('#btnResumeAll').addEventListener('click', async () => {
  await window.api.resumeAll();
});
// 停止全部：终止所有未完成任务并从列表移除（等同逐条「取消」的全局版）
$('#btnStopAll').addEventListener('click', () => {
  const ids = state.tasks
    .filter((t) => ['downloading', 'pending', 'retrying'].includes(t.status))
    .map((t) => t.id);
  if (!ids.length) return;
  if (!confirm(`确定停止全部下载吗？将取消 ${ids.length} 个未完成任务（清理断点，已下载好的视频文件保留）`)) return;
  window.api.removeTasks(ids);
  state.selectedTasks.clear();
});
$('#btnClearDone').addEventListener('click', async () => {
  await window.api.clearCompleted();
  state.selectedTasks.clear();
});
$('#btnClearFail').addEventListener('click', async () => {
  await window.api.clearFailed();
  state.selectedTasks.clear();
});

// ==================== 设置 ====================
let settingsBound = false;
function bindSettings() {
  if (settingsBound) return; // 只绑定一次，避免重复弹窗 bug
  settingsBound = true;
  const sel = $('#concSelect');
  sel.addEventListener('change', async () => {
    const res = await window.api.saveSettings({ max_concurrent: parseInt(sel.value, 10) });
    if (res.success) state.settings = res.settings;
  });

  $('#btnChooseRoot').addEventListener('click', async () => {
    const dir = await window.api.selectFolder();
    if (!dir) return;
    const res = await window.api.saveSettings({ root: dir });
    if (res.success) {
      state.settings = res.settings;
      $('#rootPath').textContent = state.settings.root;
      $('#rootPath').title = state.settings.root;
    }
  });

  if (state.settings.root) {
    $('#rootPath').textContent = state.settings.root;
    $('#rootPath').title = state.settings.root;
  }
}

// ==================== 事件订阅 ====================
window.api.onSnapshot(({ tasks, settings }) => {
  state.tasks = tasks || [];
  state.settings = settings || {};
  bindSettings();
  $('#rootPath').textContent = state.settings.root || '-';
  $('#rootPath').title = state.settings.root || '';
  if ($('#concSelect').value !== String(state.settings.max_concurrent)) {
    $('#concSelect').value = String(state.settings.max_concurrent || 3);
  }
  // 清理已移除任务的节点缓存
  const live = new Set(state.tasks.map((t) => t.id));
  for (const id of Array.from(itemEls.keys())) {
    if (!live.has(id)) itemEls.delete(id);
  }
  // 更新已下载标记
  if (state.series) {
    state.doneVids = new Set(
      state.tasks.filter((t) => t.status === 'completed' && t.seriesId === String(state.series.series_id)).map((t) => t.vid)
    );
  }
  if (state.view === 'manage') syncView();
  else renderStats();
});

window.api.onTaskProgress((p) => {
  const t = state.tasks.find((x) => x.id === p.id);
  if (!t) return;
  t.status = p.status;
  t.progress = p.progress;
  t.receivedBytes = p.receivedBytes;
  t.totalBytes = p.totalBytes;
  t.speed = p.speed;
  t.retries = p.retries;
  if (p.nextRetryAt) t.nextRetryAt = p.nextRetryAt;
  if (state.view === 'manage') syncView();
  else renderStats();
});

window.api.onDownloadCompleted(({ id }) => {
  const t = state.tasks.find((x) => x.id === id);
  if (t) {
    t.status = 'completed';
    t.progress = 100;
    if (state.series && t.seriesId === String(state.series.series_id)) {
      state.doneVids.add(t.vid);
      if (state.view === 'download') renderEpGrid();
    }
  }
  if (state.view === 'manage') syncView();
});

// ==================== 全部下载结束提示（系统通知 + 页内提示条） ====================
window.api.onAllFinished(({ done, fail }) => {
  showToast(fail > 0
    ? `⚠ 全部下载任务已结束：成功 ${done} 个，失败 ${fail} 个（可在「下载失败」里重试）`
    : `✔ 全部下载任务已结束：共 ${done} 个视频全部下载完成`);
});

let toastTimer = null;
function showToast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  // 触发过渡动画
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 8000);
}

// ==================== 解析历史下拉 ====================
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const histPanel = $('#histPanel');
$('#btnHist').addEventListener('click', async () => {
  if (!histPanel.hidden) { histPanel.hidden = true; return; }
  const res = await window.api.getHistory();
  const hist = res.history || [];
  if (!hist.length) {
    histPanel.innerHTML = '<div class="hist-empty">暂无解析记录</div>';
  } else {
    histPanel.replaceChildren(...hist.map((h) => {
      const item = document.createElement('div');
      item.className = 'hist-item';
      item.innerHTML = `
        <div class="hist-title">《${esc(h.title || h.seriesId)}》</div>
        <div class="hist-sub">${h.total || 0} 集 · ${fmtTime(h.time)}</div>`;
      item.addEventListener('click', () => {
        $('#inputLink').value = h.seriesId;
        histPanel.hidden = true;
        doResolve();
      });
      return item;
    }));
  }
  histPanel.hidden = false;
});
// 点击面板外自动收起
document.addEventListener('click', (e) => {
  if (!histPanel.hidden && !e.target.closest('.input-row')) histPanel.hidden = true;
});

// ==================== 下载记录页 ====================
async function renderRecords() {
  const res = await window.api.getRecords();
  const records = res.records || [];
  const list = $('#recordList');
  if (!records.length) {
    list.innerHTML = '<div class="empty-tip">还没有下载记录，去「视频下载」添加任务吧</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of records) {
    const div = document.createElement('div');
    div.className = 'record-item';
    div.innerHTML = `
      <img class="record-cover" alt="">
      <div class="record-main">
        <div class="record-title">《${esc(r.title || r.seriesId)}》</div>
        <div class="record-meta">
          <span>下载时间：<b>${fmtTime(r.lastAt)}</b></span>
          <span>已下载：<b>${r.count || 0}</b> 集</span>
        </div>
        <div class="record-dir" title="${esc(r.dir || '')}">存放目录：${esc(r.dir || '-')}</div>
      </div>
      <div class="record-ops">
        <button class="act-btn act-folder" data-act="open">打开目录</button>
        <button class="act-btn act-resolve" data-act="resolve">短剧解析</button>
      </div>`;
    coverUrl(r.cover, div.querySelector('.record-cover'));
    div.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'open') window.api.openPath(r.dir);
      if (act.dataset.act === 'resolve') {
        $('#inputLink').value = r.seriesId;
        switchView('download');
        doResolve();
      }
    });
    frag.appendChild(div);
  }
  list.replaceChildren(frag);
}

// ==================== 关于弹窗 ====================
$('#btnAbout').addEventListener('click', async () => {
  try {
    const info = await window.api.getAppInfo();
    $('#aboutVersion').textContent = 'v' + info.version;
  } catch (e) { /* 保持默认版本号 */ }
  $('#aboutModal').hidden = false;
});
$('#btnAboutClose').addEventListener('click', () => { $('#aboutModal').hidden = true; });
$('#aboutModal').addEventListener('click', (e) => {
  if (e.target.id === 'aboutModal') $('#aboutModal').hidden = true;
});

// ==================== 打开下载根目录 ====================
$('#btnOpenRoot').addEventListener('click', () => window.api.openRoot());

// ==================== 启动 ====================
(async function init() {
  const res = await window.api.getTasks();
  state.tasks = res.tasks || [];
  state.settings = res.settings || {};
  bindSettings();
  $('#concSelect').value = String(state.settings.max_concurrent || 3);
  if (state.settings.root) {
    $('#rootPath').textContent = state.settings.root;
    $('#rootPath').title = state.settings.root;
  }
  renderStats();
})();

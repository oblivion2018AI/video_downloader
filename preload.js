const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 解析 / 搜索
  resolve: (input) => ipcRenderer.invoke('hongguo-resolve', input),
  search: (payload) => ipcRenderer.invoke('hongguo-search', payload),
  downloadBatch: (payload) => ipcRenderer.invoke('hongguo-download-batch', payload),

  // 封面（HEIC -> JPEG dataURL）
  resolveCover: (url) => ipcRenderer.invoke('resolve-cover', url),

  // 设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // 下载管理
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  pauseTasks: (ids) => ipcRenderer.invoke('pause-tasks', ids),
  resumeTasks: (ids) => ipcRenderer.invoke('resume-tasks', ids),
  resumeAll: () => ipcRenderer.invoke('resume-all'),
  removeTasks: (ids) => ipcRenderer.invoke('remove-tasks', ids),
  clearCompleted: () => ipcRenderer.invoke('clear-completed'),
  clearFailed: () => ipcRenderer.invoke('clear-failed'),
  openFolder: (taskId) => ipcRenderer.invoke('open-folder', taskId),
  openRoot: () => ipcRenderer.invoke('open-root'),
  openPath: (dir) => ipcRenderer.invoke('open-path', dir),
  getHistory: () => ipcRenderer.invoke('get-history'),
  getRecords: () => ipcRenderer.invoke('get-records'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // 事件
  onSnapshot: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('tasks-snapshot', listener);
    return () => ipcRenderer.removeListener('tasks-snapshot', listener);
  },
  onTaskProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('task-progress', listener);
    return () => ipcRenderer.removeListener('task-progress', listener);
  },
  onDownloadCompleted: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-completed', listener);
    return () => ipcRenderer.removeListener('download-completed', listener);
  },
  onAllFinished: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('all-finished', listener);
    return () => ipcRenderer.removeListener('all-finished', listener);
  },
});

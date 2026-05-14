// Preload：暴露安全的 IPC API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gura', {
  // 项目
  pickProject: () => ipcRenderer.invoke('project:pick'),
  openProject: (p) => ipcRenderer.invoke('project:open', p),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  currentProject: () => ipcRenderer.invoke('project:current'),
  hasPrdFiles: () => ipcRenderer.invoke('project:has-prd'),

  // CLI
  listCli: () => ipcRenderer.invoke('cli:list'),
  rescanCli: () => ipcRenderer.invoke('cli:rescan'),
  addCli: (entry) => ipcRenderer.invoke('cli:add', entry),
  removeCli: (id) => ipcRenderer.invoke('cli:remove', id),
  setActiveCli: (id) => ipcRenderer.invoke('cli:set-active', id),
  getActiveCli: () => ipcRenderer.invoke('cli:get-active'),
  testCli: (id) => ipcRenderer.invoke('cli:test', id),
  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),

  // 应用信息 / 设置
  appInfo: () => ipcRenderer.invoke('app:info'),
  setZoom: (f) => ipcRenderer.invoke('app:set-zoom', f),
  getZoom: () => ipcRenderer.invoke('app:get-zoom'),
  showInFolder: (p) => ipcRenderer.invoke('app:show-in-folder', p),
  openPath: (p) => ipcRenderer.invoke('app:open-path', p),

  // 首次启动引导
  firstRunCheck: () => ipcRenderer.invoke('first-run:check'),
  firstRunAck: () => ipcRenderer.invoke('first-run:ack'),

  // 聊天（一次性）
  chatSend: (sessionId, prompt) => ipcRenderer.invoke('chat:send', { sessionId, prompt }),
  chatCancel: (sessionId) => ipcRenderer.invoke('chat:cancel', sessionId),
  onChatStream: (cb) => {
    ipcRenderer.removeAllListeners('chat:stream');
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat:stream', h);
    return () => ipcRenderer.removeListener('chat:stream', h);
  },

  // 终端（PTY）
  termSpawn: (sessionId) => ipcRenderer.invoke('term:spawn', { sessionId }),
  termWrite: (sessionId, data) => ipcRenderer.invoke('term:write', { sessionId, data }),
  termResize: (sessionId, cols, rows) => ipcRenderer.invoke('term:resize', { sessionId, cols, rows }),
  termKill: (sessionId) => ipcRenderer.invoke('term:kill', sessionId),
  onTermData: (cb) => {
    ipcRenderer.removeAllListeners('term:data');
    const h = (_e, data) => cb(data);
    ipcRenderer.on('term:data', h);
    return () => ipcRenderer.removeListener('term:data', h);
  },
  onTermExit: (cb) => {
    ipcRenderer.removeAllListeners('term:exit');
    const h = (_e, data) => cb(data);
    ipcRenderer.on('term:exit', h);
    return () => ipcRenderer.removeListener('term:exit', h);
  }
});

// Gura Desktop — Electron 主进程
// 负责：启动内嵌 server.mjs、创建窗口、IPC 桥接 CLI 检测/聊天

process.on('unhandledRejection', r => console.error('[main] unhandledRejection:', r));
process.on('uncaughtException', e => console.error('[main] uncaughtException:', e));

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, fork } = require('child_process');
const os = require('os');

// 资源路径：开发态在项目根目录，打包后在 process.resourcesPath/app
// 判断：app.isPackaged 是 electron 提供的标准方法（npm start 时是 false）
const isDev = !app.isPackaged;
const APP_RES = isDev
  ? path.resolve(__dirname, '..')
  : path.join(process.resourcesPath, 'app');

const GURA_HOME = path.join(os.homedir(), '.gura');
if (!fs.existsSync(GURA_HOME)) fs.mkdirSync(GURA_HOME, { recursive: true });

const RECENT_FILE = path.join(GURA_HOME, 'recent-projects.json');
const CONFIG_FILE = path.join(GURA_HOME, 'config.json');

function readJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return def; }
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// ----- 状态 -----
let mainWindow = null;
let serverProcess = null;
let currentProject = null;
const SERVER_PORT = 7334;

// 选定 CLI（全局唯一，聊天和自动化都用）
function getActiveCli() {
  const cfg = readJson(CONFIG_FILE, {});
  return cfg.activeCli || 'claude';
}
function setActiveCli(id) {
  const cfg = readJson(CONFIG_FILE, {});
  cfg.activeCli = id;
  writeJson(CONFIG_FILE, cfg);
}

// ----- 内嵌 server.mjs -----
async function startServer(projectPath) {
  if (serverProcess) {
    const old = serverProcess;
    serverProcess = null;
    try { old.kill(); } catch {}
    // 等待旧进程退出释放端口
    await new Promise(r => { old.on('exit', r); setTimeout(r, 3000); });
  }
  const serverScript = path.join(APP_RES, 'server.mjs');
  if (!fs.existsSync(serverScript)) {
    dialog.showErrorBox('启动失败', `找不到 server.mjs: ${serverScript}`);
    return;
  }
  // 用 node 子进程启动（也可以 fork，但 server.mjs 是 ESM，fork 不友好）
  const nodeBin = process.execPath; // Electron 自带 Node 运行时
  // 探测 gura-engine 二进制（如果已打包）
  const platDir = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  const engineName = process.platform === 'win32' ? 'gura-engine.exe' : 'gura-engine';
  const engineBin = path.join(__dirname, 'bin', platDir, engineName);
  const engineEnv = fs.existsSync(engineBin) ? { GURA_ENGINE_BIN: engineBin } : {};

  serverProcess = spawn(nodeBin, [serverScript, '--port', String(SERVER_PORT), '--project', projectPath], {
    cwd: projectPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GURA_HOME,
      GURA_STATS_FILE: path.join(GURA_HOME, 'gura-stats.json'),
      ...engineEnv
    },
    stdio: 'pipe'
  });
  serverProcess.stdout.on('data', d => console.log('[server]', d.toString().trim()));
  serverProcess.stderr.on('data', d => console.error('[server]', d.toString().trim()));
  serverProcess.on('exit', code => {
    console.log('[server] exited:', code);
    serverProcess = null;
  });
}

// ----- 项目选择 -----
function pushRecent(p) {
  const list = readJson(RECENT_FILE, []);
  const filtered = list.filter(x => x !== p);
  filtered.unshift(p);
  writeJson(RECENT_FILE, filtered.slice(0, 5));
}

async function pickProject() {
  const ret = await dialog.showOpenDialog(mainWindow, {
    title: '选择 GACoding 项目目录',
    properties: ['openDirectory']
  });
  if (ret.canceled || !ret.filePaths.length) return null;
  return ret.filePaths[0];
}

let _openingProject = false;
async function openProject(projectPath) {
  if (_openingProject) return;
  _openingProject = true;
  try {
  if (!projectPath || !fs.existsSync(projectPath)) {
    dialog.showErrorBox('打开失败', '路径不存在: ' + projectPath);
    return;
  }
  currentProject = projectPath;
  pushRecent(projectPath);
  await startServer(projectPath);
  // 等服务器起来再加载
  const ready = await waitForServer();
  if (!ready) {
    dialog.showErrorBox('启动超时', '内嵌服务器未能在 5 秒内就绪，请重试。');
    return;
  }
  if (mainWindow) mainWindow.loadURL(`http://localhost:${SERVER_PORT}/p`);
  } finally { _openingProject = false; }
}

function waitForServer(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const http = require('http');
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${SERVER_PORT}/api/status`, res => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      });
      req.setTimeout(500, () => req.destroy());
    };
    tick();
  });
}

// ----- 创建窗口 -----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'GACoding — AI 自动化 Coding 系统',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    titleBarStyle: 'default'  // 不要 hiddenInset，避免红绿灯覆盖 ui.html 顶部栏
  });

  // DevTools：只有显式设置 GURA_DEVTOOLS=1 才打开，避免日常使用时弹一个窗
  if (process.env.GURA_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 拦截页面加载完成事件，注入聊天面板（只针对 server.mjs 服务的页面，不针对 launcher.html）
  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    console.log('[main] did-finish-load:', url);
    if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
      injectChatPanel();
    }
    // 恢复保存的 zoom
    try {
      const cfg = readJson(CONFIG_FILE, {});
      if (typeof cfg.zoomFactor === 'number') {
        mainWindow.webContents.setZoomFactor(cfg.zoomFactor);
      }
    } catch {}
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 启动画面：项目选择器
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'launcher.html'));
}

function injectChatPanel() {
  const R = path.join(__dirname, 'renderer');
  const css = fs.readFileSync(path.join(R, 'chat-panel.css'), 'utf-8');
  const html = fs.readFileSync(path.join(R, 'chat-panel.html'), 'utf-8');
  const js = fs.readFileSync(path.join(R, 'chat-panel.js'), 'utf-8');
  // 本地 xterm 资源（避免 CDN）
  let xtermCss = '', xtermJs = '', xtermFitJs = '';
  try {
    xtermCss = fs.readFileSync(path.join(R, 'vendor', 'xterm.min.css'), 'utf-8');
    xtermJs = fs.readFileSync(path.join(R, 'vendor', 'xterm.min.js'), 'utf-8');
    xtermFitJs = fs.readFileSync(path.join(R, 'vendor', 'xterm-addon-fit.min.js'), 'utf-8');
  } catch (e) {
    console.warn('[inject] xterm 本地资源缺失，终端模式将不可用：', e.message);
  }
  const code = `
    (function() {
      if (window.__guraChatInjected) return;
      window.__guraChatInjected = true;
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(css + '\n' + xtermCss)};
      document.head.appendChild(style);
      const wrap = document.createElement('div');
      wrap.innerHTML = ${JSON.stringify(html)};
      document.body.appendChild(wrap);
      window.__guraXtermJs = ${JSON.stringify(xtermJs)};
      window.__guraXtermFitJs = ${JSON.stringify(xtermFitJs)};
      ${js}
    })();
  `;
  mainWindow.webContents.executeJavaScript(code).catch(err => console.error('inject error', err));
}

// ----- 菜单 -----
function buildMenu() {
  const tpl = [
    ...(process.platform === 'darwin' ? [{
      label: 'GACoding',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }
      ]
    }] : []),
    {
      label: '项目',
      submenu: [
        { label: '打开项目…', accelerator: 'CmdOrCtrl+O', click: async () => {
            const p = await pickProject();
            if (p) openProject(p);
        }},
        { label: '返回项目选择', click: () => {
            if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'renderer', 'launcher.html'));
        }},
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { label: '编辑', submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ]},
    { label: '视图', submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' }
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ----- IPC -----
const cliDetector = require('./cli-detector');
const cliRegistry = require('./cli-registry');
const chatRunner = require('./chat-runner');

ipcMain.handle('project:pick', async () => pickProject());
ipcMain.handle('project:open', async (_e, p) => { await openProject(p); return true; });
ipcMain.handle('project:recent', () => readJson(RECENT_FILE, []));
ipcMain.handle('project:current', () => currentProject);
ipcMain.handle('project:has-prd', () => {
  if (!currentProject) return { md: false, json: false };
  const md = fs.existsSync(path.join(currentProject, 'tasks')) &&
    fs.readdirSync(path.join(currentProject, 'tasks')).some(f => f.startsWith('prd-') && f.endsWith('.md'));
  const j = fs.existsSync(path.join(currentProject, 'scripts', 'gura', 'prd.json'));
  return { md, json: j };
});

ipcMain.handle('cli:list', async () => {
  const detected = await cliDetector.detectAll();
  const custom = cliRegistry.list();
  return { detected, custom, active: getActiveCli() };
});
ipcMain.handle('cli:rescan', async () => cliDetector.detectAll());
ipcMain.handle('cli:add', (_e, entry) => cliRegistry.add(entry));
ipcMain.handle('cli:remove', (_e, id) => cliRegistry.remove(id));
ipcMain.handle('cli:set-active', (_e, id) => { setActiveCli(id); return true; });
ipcMain.handle('cli:get-active', () => getActiveCli());

// 应用信息：版本 / 配置文件路径 / 当前项目
ipcMain.handle('app:info', () => {
  let pkgVersion = '';
  try {
    pkgVersion = require(path.join(APP_RES, 'package.json')).version || '';
  } catch {}
  return {
    version: app.getVersion ? app.getVersion() : pkgVersion,
    pkgVersion,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    guraHome: GURA_HOME,
    configFile: CONFIG_FILE,
    recentFile: RECENT_FILE,
    currentProject,
    appResources: APP_RES
  };
});

// 缩放（字体大小通过 zoom 统一控制，简单可靠）
ipcMain.handle('app:set-zoom', (_e, factor) => {
  const f = Math.max(0.6, Math.min(1.6, Number(factor) || 1));
  if (mainWindow) mainWindow.webContents.setZoomFactor(f);
  const cfg = readJson(CONFIG_FILE, {});
  cfg.zoomFactor = f;
  writeJson(CONFIG_FILE, cfg);
  return f;
});
ipcMain.handle('app:get-zoom', () => {
  const cfg = readJson(CONFIG_FILE, {});
  return typeof cfg.zoomFactor === 'number' ? cfg.zoomFactor : 1;
});

// 在 Finder / Explorer 中打开配置目录或路径
function isAllowedPath(p) {
  if (!p) return false;
  const resolved = path.resolve(p);
  return resolved.startsWith(GURA_HOME) || (currentProject && resolved.startsWith(path.resolve(currentProject)));
}
ipcMain.handle('app:show-in-folder', (_e, p) => {
  try {
    if (isAllowedPath(p) && fs.existsSync(p)) { shell.showItemInFolder(p); return true; }
  } catch {}
  return false;
});
ipcMain.handle('app:open-path', (_e, p) => {
  try { if (isAllowedPath(p)) { shell.openPath(p); return true; } } catch {}
  return false;
});

// 测试 CLI 连通：跑一次 <bin> <chatTemplate ping> 看 returncode + 输出
// 用来一键识别"装了但没登录"、"API 额度耗尽"等情况
ipcMain.handle('cli:test', async (_e, id) => {
  const started = Date.now();
  try {
    const detected = await cliDetector.detectAll();
    const custom = cliRegistry.list();
    const cli = [...detected, ...custom].find(c => c.id === id);
    if (!cli) return { ok: false, hint: '找不到 CLI 配置', ms: 0 };
    const tpl = cli.chatTemplate || ['{prompt}'];
    const args = tpl.map(t => t.replace(/\{prompt\}/g, 'ping'));
    const bin = cli.path || cli.bin;
    return await new Promise((resolve) => {
      const child = spawn(bin, args, {
        cwd: os.homedir(),
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
      });
      let stdout = '', stderr = '';
      let killed = false;
      // 大多数 CLI 接受一次性 prompt 就会开始干活/登录检查；未登录的会立刻报错退出
      try { child.stdin.end(); } catch {}
      child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 8192) stdout = stdout.slice(-8192); });
      child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch {}
      }, 20_000);
      child.on('error', err => {
        clearTimeout(timer);
        resolve({ ok: false, hint: `启动失败: ${err.message}`, ms: Date.now() - started });
      });
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        const combined = (stdout + '\n' + stderr).trim();
        // 关键词识别
        const low = combined.toLowerCase();
        const loginKeywords = ['not logged in', 'please run /login', 'unauthorized', 'authentication', 'api key', 'please sign in', 'login required'];
        const quotaKeywords = ['rate limit', 'quota exceeded', 'insufficient credit', 'payment required'];
        const loginIssue = loginKeywords.find(k => low.includes(k));
        const quotaIssue = quotaKeywords.find(k => low.includes(k));
        if (killed) {
          return resolve({ ok: false, hint: '超时 20s（可能在等 OAuth / 网络慢）', ms, stdout, stderr });
        }
        if (loginIssue) return resolve({ ok: false, hint: '未登录 / 授权失败', detail: combined.slice(-300), ms, stdout, stderr });
        if (quotaIssue) return resolve({ ok: false, hint: '额度 / 速率限制', detail: combined.slice(-300), ms, stdout, stderr });
        if (code !== 0) return resolve({ ok: false, hint: `退出码 ${code}${sig ? ' sig=' + sig : ''}`, detail: combined.slice(-300), ms, stdout, stderr });
        return resolve({ ok: true, hint: '连通正常', ms, stdout, stderr });
      });
    });
  } catch (e) {
    return { ok: false, hint: `异常: ${e.message || e}`, ms: Date.now() - started };
  }
});

// 判断是否首次启动：~/.gura/config.json 没有 onboardingDone 标记即为首次
ipcMain.handle('first-run:check', () => {
  const cfg = readJson(CONFIG_FILE, {});
  return { firstRun: !cfg.onboardingDone };
});
ipcMain.handle('first-run:ack', () => {
  const cfg = readJson(CONFIG_FILE, {});
  cfg.onboardingDone = true;
  cfg.onboardedAt = new Date().toISOString();
  writeJson(CONFIG_FILE, cfg);
  return true;
});

ipcMain.handle('chat:send', async (e, { sessionId, prompt }) => {
  return chatRunner.sendOneShot(sessionId, prompt, currentProject, getActiveCli(), (chunk) => {
    e.sender.send('chat:stream', { sessionId, chunk });
  });
});
ipcMain.handle('chat:cancel', (_e, sessionId) => chatRunner.cancel(sessionId));

ipcMain.handle('term:spawn', (e, { sessionId }) => {
  return chatRunner.spawnPty(sessionId, currentProject, getActiveCli(), (data) => {
    e.sender.send('term:data', { sessionId, data });
  }, (code) => {
    e.sender.send('term:exit', { sessionId, code });
  });
});
ipcMain.handle('term:write', (_e, { sessionId, data }) => chatRunner.writePty(sessionId, data));
ipcMain.handle('term:resize', (_e, { sessionId, cols, rows }) => chatRunner.resizePty(sessionId, cols, rows));
ipcMain.handle('term:kill', (_e, sessionId) => chatRunner.killPty(sessionId));

ipcMain.handle('dialog:pickExecutable', async () => {
  const ret = await dialog.showOpenDialog(mainWindow, {
    title: '选择 CLI 可执行文件',
    properties: ['openFile']
  });
  if (ret.canceled || !ret.filePaths.length) return null;
  return ret.filePaths[0];
});

// ----- App 生命周期 -----
app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  // macOS: 不 kill server，用户可能 activate 重新打开窗口
  if (process.platform !== 'darwin') {
    if (serverProcess) { try { serverProcess.kill(); } catch {} }
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess) { try { serverProcess.kill(); } catch {} }
  chatRunner.killAll();
});

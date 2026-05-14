// Chat Runner：管理与 CLI 的对话会话
// - sendOneShot: 一次性 prompt → 流式收 stdout 推送给渲染层
// - spawnPty/writePty/resizePty/killPty: 交互式终端模式（需要 node-pty）

const { spawn } = require('child_process');
const path = require('path');
const cliDetector = require('./cli-detector');
const cliRegistry = require('./cli-registry');

// 复用 cli-detector 中的 PATH 修复（macOS Electron GUI PATH 不完整问题）
const { resolveShellEnv } = require('./cli-detector');

let pty = null;
try { pty = require('node-pty'); } catch (e) {
  console.warn('[chat-runner] node-pty 未安装，终端模式不可用：', e.message);
}

const oneShotSessions = new Map(); // sessionId -> child
const ptySessions = new Map();     // sessionId -> pty

// CLI 检测缓存（30s TTL）
let _cliCache = null;
let _cliCacheTime = 0;
const CLI_CACHE_TTL = 30000;

async function resolveCli(activeId) {
  const now = Date.now();
  if (!_cliCache || now - _cliCacheTime > CLI_CACHE_TTL) {
    const detected = await cliDetector.detectAll();
    const custom = cliRegistry.list();
    _cliCache = [...detected, ...custom];
    _cliCacheTime = now;
  }
  return _cliCache.find(c => c.id === activeId) || _cliCache[0] || null;
}

function buildArgs(template, prompt) {
  return template.map(t => t.replace(/\{prompt\}/g, prompt));
}

async function sendOneShot(sessionId, prompt, cwd, activeCliId, onChunk) {
  const cli = await resolveCli(activeCliId);
  if (!cli) {
    onChunk({ type: 'error', text: '未检测到可用的 CLI，请在设置中添加。' });
    onChunk({ type: 'done', code: 1 });
    return { ok: false };
  }
  const shellEnv = await resolveShellEnv();
  const args = buildArgs(cli.chatTemplate, prompt);
  const child = spawn(cli.path || cli.bin, args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...shellEnv, FORCE_COLOR: '0', NO_COLOR: '1' }
  });
  oneShotSessions.set(sessionId, child);

  // 一次性模式：prompt 已经通过参数传入，stdin 没有任何内容要喂。
  // 如果不主动关闭，像 codex exec 这种会读 stdin 的 CLI 会卡死等 EOF。
  try { child.stdin.end(); } catch {}

  child.stdout.on('data', d => onChunk({ type: 'stdout', text: d.toString() }));
  child.stderr.on('data', d => onChunk({ type: 'stderr', text: d.toString() }));
  let ended = false;
  child.on('error', err => {
    if (ended) return;
    ended = true;
    oneShotSessions.delete(sessionId);
    onChunk({ type: 'error', text: String(err.message || err) });
    onChunk({ type: 'done', code: 1 });
  });
  child.on('close', code => {
    if (ended) return;
    ended = true;
    oneShotSessions.delete(sessionId);
    onChunk({ type: 'done', code });
  });
  return { ok: true, pid: child.pid, cli: cli.id };
}

function cancel(sessionId) {
  const c = oneShotSessions.get(sessionId);
  if (!c) return false;
  try { c.kill('SIGTERM'); } catch {}
  oneShotSessions.delete(sessionId);
  return true;
}

async function spawnPty(sessionId, cwd, activeCliId, onData, onExit) {
  if (!pty) {
    onData('node-pty 未安装，无法启动终端模式。请运行 npm install 后重试。\r\n');
    onExit(1);
    return { ok: false };
  }
  const cli = await resolveCli(activeCliId);
  if (!cli) {
    onData('未检测到可用 CLI。\r\n');
    onExit(1);
    return { ok: false };
  }
  const shellEnv = await resolveShellEnv();
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
  // 在 shell 中启动 CLI（无参数，进入其交互模式）
  const term = pty.spawn(cli.path || cli.bin, cli.ptyArgs || [], {
    name: 'xterm-256color',
    cols: 100, rows: 30,
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...shellEnv }
  });
  ptySessions.set(sessionId, term);
  term.onData(d => onData(d));
  term.onExit(({ exitCode }) => {
    ptySessions.delete(sessionId);
    onExit(exitCode);
  });
  return { ok: true, pid: term.pid, cli: cli.id };
}

function writePty(sessionId, data) {
  const t = ptySessions.get(sessionId);
  if (!t) return false;
  t.write(data);
  return true;
}

function resizePty(sessionId, cols, rows) {
  const t = ptySessions.get(sessionId);
  if (!t) return false;
  try { t.resize(cols, rows); } catch {}
  return true;
}

function killPty(sessionId) {
  const t = ptySessions.get(sessionId);
  if (!t) return false;
  try { t.kill(); } catch {}
  ptySessions.delete(sessionId);
  return true;
}

function killAll() {
  for (const c of oneShotSessions.values()) { try { c.kill(); } catch {} }
  oneShotSessions.clear();
  for (const t of ptySessions.values()) { try { t.kill(); } catch {} }
  ptySessions.clear();
}

module.exports = { sendOneShot, cancel, spawnPty, writePty, resizePty, killPty, killAll };

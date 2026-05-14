#!/usr/bin/env node
// Gura — AI Coding Progress Inspector Server
// 零依赖 Node.js 服务器：REST API + SSE + 静态文件

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, watch as fsWatch, cpSync, statSync, rmdirSync } from 'node:fs';

function atomicWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, filepath);
}
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '7334');
const PROJECT = process.argv.find((_, i, a) => a[i - 1] === '--project') || process.cwd();
const STATUS_DIR = join(PROJECT, '.pi');
const STATUS_FILE = join(STATUS_DIR, 'status.json');

// --- 状态文件操作 ---

function ensureStatusFile() {
  if (!existsSync(STATUS_DIR)) mkdirSync(STATUS_DIR, { recursive: true });
  if (!existsSync(STATUS_FILE)) {
    writeFileSync(STATUS_FILE, JSON.stringify({
      project: 'Untitled', tasks: [], logs: [], createdAt: new Date().toISOString()
    }, null, 2));
  }
}

function readStatus() {
  try { return JSON.parse(readFileSync(STATUS_FILE, 'utf-8')); }
  catch { return { project: 'Error', tasks: [], logs: [] }; }
}

// --- Gura 状态机（持久化到文件）---
const GURA_STATE_FILE = join(STATUS_DIR, 'gura-state.json');
function readGuraState() {
  try { return JSON.parse(readFileSync(GURA_STATE_FILE, 'utf-8')); }
  catch { return { iteration: 0, maxIterations: 50, phase: 'idle', currentStory: null, startedAt: null }; }
}
function writeGuraState(s) { atomicWrite(GURA_STATE_FILE, JSON.stringify(s, null, 2)); }
let guraState = readGuraState();

function readPrd() {
  const f = join(PROJECT, 'scripts', 'gura', 'prd.json');
  try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return null; }
}

// PRD 历史快照：写入前调用，避免 AI 误改覆盖丢失
const PRD_HISTORY_DIR = join(PROJECT, '.gura', 'prd-history');
function snapshotPrd(prdStr) {
  if (!prdStr || prdStr === 'null') return;
  try {
    if (!existsSync(PRD_HISTORY_DIR)) mkdirSync(PRD_HISTORY_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    atomicWrite(join(PRD_HISTORY_DIR, `prd-${ts}.json`), prdStr);
    // 仅保留最近 30 份，旧的清掉避免磁盘膨胀
    const all = readdirSync(PRD_HISTORY_DIR).filter(f => f.startsWith('prd-') && f.endsWith('.json')).sort();
    while (all.length > 30) {
      try { unlinkSync(join(PRD_HISTORY_DIR, all.shift())); } catch {}
    }
  } catch (e) { console.warn('[prd-history] snapshot failed:', e.message); }
}

// === 会话归档系统 ===
// 每次打开项目自动归档旧会话，确保每次进入都是全新状态
const SESSION_DIR = join(PROJECT, '.gura', 'sessions');

// 判断当前项目是否有活跃会话（有 prd.json 或者 status.json 包含 tasks）
function hasActiveSession() {
  const prd = readPrd();
  if (prd && prd.userStories && prd.userStories.length > 0) return true;
  try {
    const status = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
    if (status.tasks && status.tasks.length > 0) return true;
  } catch {}
  return false;
}

// 归档当前会话到 .gura/sessions/<timestamp>/
function archiveCurrentSession() {
  if (!hasActiveSession()) return null;

  const prd = readPrd();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const projectName = (prd && prd.project) || 'Untitled';
  // 目录名：时间戳_项目名（取前30字符，去特殊字符）
  const safeName = projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 30);
  const sessionName = `${ts}__${safeName}`;
  const sessionDir = join(SESSION_DIR, sessionName);

  try {
    mkdirSync(sessionDir, { recursive: true });

    // 保存 prd.json
    const prdPath = join(PROJECT, 'scripts', 'gura', 'prd.json');
    if (existsSync(prdPath)) {
      cpSync(prdPath, join(sessionDir, 'prd.json'));
    }

    // 保存 prd-*.md
    const tasksDir = join(PROJECT, 'tasks');
    if (existsSync(tasksDir)) {
      const mdFiles = readdirSync(tasksDir).filter(f => f.startsWith('prd-') && f.endsWith('.md'));
      if (mdFiles.length) {
        mkdirSync(join(sessionDir, 'tasks'), { recursive: true });
        mdFiles.forEach(f => cpSync(join(tasksDir, f), join(sessionDir, 'tasks', f)));
      }
    }

    // 保存 status.json + gura-state.json
    if (existsSync(STATUS_FILE)) cpSync(STATUS_FILE, join(sessionDir, 'status.json'));
    if (existsSync(GURA_STATE_FILE)) cpSync(GURA_STATE_FILE, join(sessionDir, 'gura-state.json'));

    // 保存 run-log.jsonl
    if (existsSync(RUN_LOG_FILE)) cpSync(RUN_LOG_FILE, join(sessionDir, 'run-log.jsonl'));

    // 写元数据
    const meta = {
      project: projectName,
      createdAt: ts.replace(/T.*/, '').replace(/-/g, '/'),
      storiesCount: (prd && prd.userStories) ? prd.userStories.length : 0,
      archivedAt: new Date().toISOString()
    };
    try {
      const status = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
      const passed = (status.tasks || []).filter(t => t.status === 'passed').length;
      const total = (status.tasks || []).length;
      meta.progress = `${passed}/${total}`;
      meta.allPassed = passed === total && total > 0;
    } catch {}
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));

    console.log(`[session] 已归档会话: ${sessionName}`);
    return sessionName;
  } catch (e) {
    console.warn('[session] 归档失败:', e.message);
    return null;
  }
}

// 清空当前工作区（归档后调用）
function clearWorkspace() {
  // 清空 prd.json
  const prdPath = join(PROJECT, 'scripts', 'gura', 'prd.json');
  try { if (existsSync(prdPath)) unlinkSync(prdPath); } catch {}

  // 清空 prd-*.md
  const tasksDir = join(PROJECT, 'tasks');
  try {
    if (existsSync(tasksDir)) {
      readdirSync(tasksDir).filter(f => f.startsWith('prd-') && f.endsWith('.md'))
        .forEach(f => { try { unlinkSync(join(tasksDir, f)); } catch {} });
    }
  } catch {}

  // 重置 status.json
  writeFileSync(STATUS_FILE, JSON.stringify({
    project: 'Untitled', tasks: [], logs: [], createdAt: new Date().toISOString()
  }, null, 2));

  // 重置 gura-state.json
  const freshState = { iteration: 0, maxIterations: 50, phase: 'idle', currentStory: null, startedAt: null };
  writeGuraState(freshState);
  Object.assign(guraState, freshState);

  // 清空 run-log
  try { if (existsSync(RUN_LOG_FILE)) unlinkSync(RUN_LOG_FILE); } catch {}

  console.log('[session] 工作区已清空，准备新会话');
}

// 列出所有历史会话
function listSessions() {
  try {
    if (!existsSync(SESSION_DIR)) return [];
    return readdirSync(SESSION_DIR)
      .filter(d => {
        try { return statSync(join(SESSION_DIR, d)).isDirectory(); } catch { return false; }
      })
      .sort().reverse() // 最新的在前
      .map(d => {
        let meta = {};
        try { meta = JSON.parse(readFileSync(join(SESSION_DIR, d, 'meta.json'), 'utf-8')); } catch {}
        return { name: d, ...meta };
      })
      .slice(0, 50); // 最多 50 条
  } catch { return []; }
}

// 恢复某个历史会话
function restoreSession(sessionName) {
  const sessionDir = join(SESSION_DIR, sessionName);
  if (!existsSync(sessionDir)) return false;

  // 先归档当前的（如果有的话）
  archiveCurrentSession();

  try {
    // 恢复 prd.json
    const prdSrc = join(sessionDir, 'prd.json');
    if (existsSync(prdSrc)) {
      const prdDst = join(PROJECT, 'scripts', 'gura', 'prd.json');
      mkdirSync(dirname(prdDst), { recursive: true });
      cpSync(prdSrc, prdDst);
    }

    // 恢复 prd-*.md
    const tasksSrc = join(sessionDir, 'tasks');
    if (existsSync(tasksSrc)) {
      const tasksDst = join(PROJECT, 'tasks');
      mkdirSync(tasksDst, { recursive: true });
      readdirSync(tasksSrc).forEach(f => cpSync(join(tasksSrc, f), join(tasksDst, f)));
    }

    // 恢复 status.json
    const statusSrc = join(sessionDir, 'status.json');
    if (existsSync(statusSrc)) cpSync(statusSrc, STATUS_FILE);

    // 恢复 gura-state.json
    const stateSrc = join(sessionDir, 'gura-state.json');
    if (existsSync(stateSrc)) {
      cpSync(stateSrc, GURA_STATE_FILE);
      Object.assign(guraState, readGuraState());
    }

    console.log(`[session] 已恢复会话: ${sessionName}`);
    broadcast();
    return true;
  } catch (e) {
    console.warn('[session] 恢复失败:', e.message);
    return false;
  }
}
function listPrdHistory() {
  try {
    if (!existsSync(PRD_HISTORY_DIR)) return [];
    return readdirSync(PRD_HISTORY_DIR)
      .filter(f => f.startsWith('prd-') && f.endsWith('.json'))
      .sort().reverse()
      .map(f => ({ name: f, mtime: f.replace(/^prd-|\.json$/g, '') }));
  } catch { return []; }
}
function readPrdHistoryItem(name) {
  if (!/^prd-[\w\-T.]+\.json$/.test(name)) return null;
  try { return readFileSync(join(PRD_HISTORY_DIR, name), 'utf-8'); } catch { return null; }
}

function readPrdMd() {
  try {
    const tasksDir = join(PROJECT, 'tasks');
    if (!existsSync(tasksDir)) return '';
    const files = readdirSync(tasksDir).filter(f => f.startsWith('prd-') && f.endsWith('.md')).sort();
    if (!files.length) return '';
    return readFileSync(join(tasksDir, files[files.length - 1]), 'utf-8');
  } catch { return ''; }
}

function readProgress() {
  const f = join(PROJECT, 'scripts', 'gura', 'progress.txt');
  try { return readFileSync(f, 'utf-8'); } catch { return ''; }
}

const STATS_FILE = process.env.GURA_STATS_FILE || join(__dirname, 'gura-stats.json');

function readStats() {
  try {
    const s = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    // 兜底字段（老存档没有 hp/mood 等，给默认值）
    if (typeof s.hp !== 'number') s.hp = 100;
    if (typeof s.mood !== 'number') s.mood = 80;
    if (typeof s.passedStories !== 'number') s.passedStories = 0;
    if (typeof s.failedStories !== 'number') s.failedStories = 0;
    return s;
  }
  catch {
    return {
      name: 'Gura', level: 1, exp: 0, gold: 0,
      totalMinutes: 0, projectsCompleted: 0, totalIterations: 0,
      hp: 100, mood: 80, passedStories: 0, failedStories: 0
    };
  }
}

function writeStats(data) {
  atomicWrite(STATS_FILE, JSON.stringify(data, null, 2));
}

// 任务状态变化 → 角色属性变化（HP / 心情 / 金币 / 经验）
// 让游戏化真正跟实际产出挂钩，不再是纯装饰
function applyStatsDelta(prevTasks, newTasks) {
  if (!Array.isArray(newTasks) || !newTasks.length) return;
  const prevMap = Object.fromEntries((prevTasks || []).map(t => [t.id, t]));
  const stats = readStats();
  let dirty = false;

  for (const t of newTasks) {
    const p = prevMap[t.id];
    const prevStatus = p && p.status;
    const prevRetry = (p && p.retryCount) || 0;
    const curStatus = t.status;
    const curRetry = t.retryCount || 0;

    // 任务通过：大奖励
    if (prevStatus !== 'passed' && curStatus === 'passed') {
      stats.exp = (stats.exp || 0) + 20;
      stats.gold = (stats.gold || 0) + 10;
      stats.hp = Math.min(100, (stats.hp || 0) + 5);
      stats.mood = Math.min(100, (stats.mood || 0) + 8);
      stats.passedStories = (stats.passedStories || 0) + 1;
      dirty = true;
    }
    // 任务失败：扣血扣心情
    if (prevStatus !== 'failed' && curStatus === 'failed') {
      stats.hp = Math.max(0, (stats.hp || 0) - 12);
      stats.mood = Math.max(0, (stats.mood || 0) - 15);
      stats.failedStories = (stats.failedStories || 0) + 1;
      dirty = true;
    }
    // blocked：仅小幅扣心情（用户知道这个限制是已知的）
    if (prevStatus !== 'blocked' && curStatus === 'blocked') {
      stats.mood = Math.max(0, (stats.mood || 0) - 5);
      dirty = true;
    }
    // 重试次数增加：每次小扣心情
    if (curRetry > prevRetry) {
      stats.mood = Math.max(0, (stats.mood || 0) - 3 * (curRetry - prevRetry));
      dirty = true;
    }
  }

  // 整体完成度奖励：所有任务都 passed → 项目通关
  if (newTasks.length && newTasks.every(t => t.status === 'passed')) {
    const wasComplete = (prevTasks || []).length && (prevTasks || []).every(t => t.status === 'passed');
    if (!wasComplete) {
      stats.projectsCompleted = (stats.projectsCompleted || 0) + 1;
      stats.gold = (stats.gold || 0) + 50;
      stats.exp = (stats.exp || 0) + 100;
      stats.hp = 100; // 通关满血
      stats.mood = 100;
      dirty = true;
    }
  }

  // 等级推进：每 100 exp +1 级，最多 100 级
  while ((stats.exp || 0) >= 100 && (stats.level || 1) < 100) {
    stats.exp -= 100;
    stats.level = (stats.level || 1) + 1;
    stats.gold = (stats.gold || 0) + 20; // 升级奖金
    dirty = true;
  }

  if (dirty) writeStats(stats);
}

// === 任务执行历史（.gura/run-log.jsonl）===
// 每条 story 状态迁移、retry、launch/unlock/complete 各记一行 JSON
const RUN_LOG_DIR = join(PROJECT, '.gura');
const RUN_LOG_FILE = join(RUN_LOG_DIR, 'run-log.jsonl');

function appendRunLog(event) {
  try {
    if (!existsSync(RUN_LOG_DIR)) mkdirSync(RUN_LOG_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    // 追加模式：多进程写也安全（每行是原子写入<PIPE_BUF）
    writeFileSync(RUN_LOG_FILE, line, { flag: 'a' });
  } catch (e) { console.warn('[run-log] append failed:', e.message); }
}

function readRunLog(limit = 200) {
  try {
    if (!existsSync(RUN_LOG_FILE)) return [];
    const content = readFileSync(RUN_LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    return tail
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse(); // 最近在前
  } catch { return []; }
}

// 检测 story 状态迁移 + retry 增加，分别落一行
function logStoryTransitions(prevTasks, newTasks, prdUserStories) {
  if (!Array.isArray(newTasks) || !newTasks.length) return;
  const prevMap = Object.fromEntries((prevTasks || []).map(t => [t.id, t]));
  const titleMap = Object.fromEntries((prdUserStories || []).map(s => [s.id, s.title || '']));
  for (const t of newTasks) {
    const p = prevMap[t.id] || {};
    const from = p.status || 'new';
    const to = t.status;
    if (from !== to) {
      appendRunLog({
        type: 'story_transition',
        storyId: t.id,
        storyTitle: titleMap[t.id] || t.name || '',
        from, to,
        retry: t.retryCount || 0,
        iteration: (guraState && guraState.iteration) || 0,
        notes: t.notes || t.error || null
      });
    }
    const prevRetry = p.retryCount || 0;
    const curRetry = t.retryCount || 0;
    if (curRetry > prevRetry) {
      appendRunLog({
        type: 'story_retry',
        storyId: t.id,
        storyTitle: titleMap[t.id] || t.name || '',
        retry: curRetry,
        iteration: (guraState && guraState.iteration) || 0,
        notes: t.notes || t.error || null
      });
    }
  }
  // 整体通关：上一次不全过、这一次全过 → 记一条 project_complete
  if (newTasks.length && newTasks.every(t => t.status === 'passed')) {
    const wasComplete = (prevTasks || []).length && (prevTasks || []).every(t => t.status === 'passed');
    if (!wasComplete) {
      appendRunLog({
        type: 'project_complete',
        stories: newTasks.length,
        iteration: (guraState && guraState.iteration) || 0
      });
    }
  }
}

function buildFullState() {
  const base = readStatus();
  const prd = readPrd();
  const prdMd = readPrdMd();
  const progress = readProgress();
  const stats = readStats();
  // 动态标记当前 story 为 running
  if (base.tasks && (guraState.phase === 'developing' || guraState.phase === 'validating')) {
    let target = guraState.currentStory;
    // currentStory 为空时，推断第一个未完成的 story
    if (!target && prd && prd.userStories) {
      const next = prd.userStories.find(s => !s.passes && !s.blocked);
      if (next) target = next.id;
    }
    if (target) {
      for (const t of base.tasks) {
        if (t.id === target && t.status !== 'passed' && t.status !== 'blocked' && t.status !== 'failed') {
          t.status = 'running';
        }
      }
      if (!guraState.currentStory) guraState.currentStory = target;
    }
  }
  return { ...base, gura: guraState, prd: prd, prdMd: prdMd, progress: progress, stats: stats };
}

function writeStatus(data) {
  // 写前先读旧状态，用来检测任务状态翻转（passed/failed/blocked/retry）
  let prevTasks = null;
  try { prevTasks = JSON.parse(readFileSync(STATUS_FILE, 'utf-8')).tasks || []; } catch {}
  atomicWrite(STATUS_FILE, JSON.stringify(data, null, 2));
  try { applyStatsDelta(prevTasks, data.tasks || []); } catch (e) { console.warn('[stats] delta failed:', e.message); }
  // run-log：story 状态变化 → 追加到 .gura/run-log.jsonl
  try {
    const userStories = (readPrd() || {}).userStories || [];
    logStoryTransitions(prevTasks, data.tasks || [], userStories);
  } catch (e) { console.warn('[run-log] transitions failed:', e.message); }
  broadcast();
}

// --- SSE ---

const clients = new Set();

function broadcast() {
  const data = JSON.stringify(buildFullState());
  for (const res of clients) {
    try { res.write(`data: ${data}\n\n`); } catch { clients.delete(res); }
  }
}

// watch 状态文件变更
ensureStatusFile();

// === 启动时自动归档旧会话 ===
// 每次服务器启动（即打开项目时）如果有残留的旧任务，自动归档并清空
if (hasActiveSession()) {
  console.log('[session] 检测到旧会话，自动归档...');
  archiveCurrentSession();
  clearWorkspace();
}

// --- HTTP 服务器 ---

function parseBody(req, maxBytes = 1048576) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); resolve({}); return; }
      body += c;
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // SSE endpoint
  if (path === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify(buildFullState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // REST API
  if (path === '/api/status' && req.method === 'GET') {
    return json(res, readStatus());
  }

  if (path === '/api/init' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = {
      project: body.project || 'Untitled',
      tasks: (body.tasks || []).map((t, i) => ({
        id: t.id || `T-${i + 1}`,
        name: t.name || t,
        status: 'pending', // pending | running | passed | failed
        error: null,
        startedAt: null,
        finishedAt: null
      })),
      logs: [{ time: new Date().toISOString(), msg: `项目初始化: ${body.project || 'Untitled'}` }],
      createdAt: new Date().toISOString()
    };
    writeStatus(data);
    return json(res, { ok: true });
  }

  if (path === '/api/task' && req.method === 'PUT') {
    const body = await parseBody(req);
    const data = readStatus();
    const task = data.tasks.find(t => t.id === body.id);
    if (!task) return json(res, { error: 'task not found' }, 404);
    const now = new Date().toISOString();
    if (body.status) {
      task.status = body.status;
      if (body.status === 'running') task.startedAt = now;
      if (body.status === 'passed' || body.status === 'failed') task.finishedAt = now;
    }
    if (body.error !== undefined) task.error = body.error;
    if (body.startedAt !== undefined) task.startedAt = body.startedAt;
    if (body.finishedAt !== undefined) task.finishedAt = body.finishedAt;
    data.logs.push({ time: now, msg: `[${task.id}] ${task.name} → ${task.status}${body.error ? ': ' + body.error : ''}` });
    writeStatus(data);
    return json(res, { ok: true });
  }

  if (path === '/api/log' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = readStatus();
    data.logs.push({ time: new Date().toISOString(), msg: body.msg || '' });
    writeStatus(data);
    return json(res, { ok: true });
  }

  // Gura 状态机 API
  if (path === '/api/gura/state' && req.method === 'PUT') {
    const body = await parseBody(req);
    if (body.iteration !== undefined) guraState.iteration = body.iteration;
    if (body.maxIterations !== undefined) guraState.maxIterations = body.maxIterations;
    if (body.phase !== undefined) guraState.phase = body.phase;
    if (body.currentStory !== undefined) guraState.currentStory = body.currentStory;
    if (body.startedAt !== undefined) guraState.startedAt = body.startedAt;
    writeGuraState(guraState);
    broadcast();
    return json(res, { ok: true });
  }

  if (path === '/api/gura/state' && req.method === 'GET') {
    return json(res, buildFullState());
  }

  // 从 prd.json 同步任务到 Pi 状态
  if (path === '/api/gura/sync' && req.method === 'POST') {
    const prd = readPrd();
    if (!prd) return json(res, { error: 'prd.json not found' }, 404);
    const stories = prd.userStories || [];
    const existingTasks = readStatus().tasks || [];
    const existingMap = Object.fromEntries(existingTasks.map(t => [t.id, t]));
    const data = {
      project: prd.project || 'Gura Project',
      tasks: stories.map(s => {
        const isRunning = guraState.currentStory === s.id && (guraState.phase === 'developing' || guraState.phase === 'validating');
        const prev = existingMap[s.id];
        return {
          id: s.id,
          name: s.title || s.description,
          status: s.blocked ? 'blocked' : s.passes ? 'passed' : isRunning ? 'running' : 'pending',
          error: s.notes || null,
          startedAt: prev?.startedAt || null,
          finishedAt: prev?.finishedAt || null,
          acceptanceCriteria: s.acceptanceCriteria || [],
          retryCount: s.retryCount || 0,
          blocked: s.blocked || false,
          notes: s.notes || '',
          priority: s.priority || 0
        };
      }),
      logs: readStatus().logs || [],
      createdAt: new Date().toISOString()
    };
    writeStatus(data);
    return json(res, { ok: true, synced: stories.length });
  }

  // PRD 文档读取（扫描 tasks/ 目录下的 prd-*.md）
  if (path === '/api/prd/list' && req.method === 'GET') {
    const tasksDir = join(PROJECT, 'tasks');
    try {
      const all = existsSync(tasksDir) ? readdirSync(tasksDir).filter(f => f.startsWith('prd-') && f.endsWith('.md')) : [];
      const prds = all.map(f => ({ name: f, content: readFileSync(join(tasksDir, f), 'utf-8') }));
      return json(res, { prds });
    } catch { return json(res, { prds: [] }); }
  }

  // PRD + prd.json 完整数据
  if (path === '/api/prd/review' && req.method === 'GET') {
    const prd = readPrd();
    let prdMd = '';
    try {
      const tasksDir = join(PROJECT, 'tasks');
      if (existsSync(tasksDir)) {
        const files = readdirSync(tasksDir).filter(f => f.startsWith('prd-') && f.endsWith('.md')).sort();
        if (files.length) prdMd = readFileSync(join(tasksDir, files[files.length - 1]), 'utf-8');
      }
    } catch {}
    return json(res, { prdMd, prdJson: prd });
  }

  // PRD 历史快照列表
  if (path === '/api/prd/history' && req.method === 'GET') {
    return json(res, { history: listPrdHistory() });
  }

  // 读取某个历史快照
  if (path.startsWith('/api/prd/history/') && req.method === 'GET') {
    const name = decodeURIComponent(path.slice('/api/prd/history/'.length));
    const content = readPrdHistoryItem(name);
    if (!content) return json(res, { error: 'not found' }, 404);
    try { return json(res, { name, prd: JSON.parse(content) }); }
    catch { return json(res, { error: 'corrupt snapshot' }, 500); }
  }

  // 回滚到某份快照
  if (path === '/api/prd/rollback' && req.method === 'POST') {
    const body = await parseBody(req);
    const name = body && body.name;
    const content = name && readPrdHistoryItem(name);
    if (!content) return json(res, { error: 'snapshot not found' }, 404);
    try {
      JSON.parse(content); // 校验
      // 当前内容先快照一次再覆盖，给"回滚"操作本身留个返回点
      const cur = JSON.stringify(readPrd());
      if (cur && cur !== 'null') snapshotPrd(cur);
      atomicWrite(join(PROJECT, 'scripts', 'gura', 'prd.json'), content);
      return json(res, { ok: true });
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  // Story 确认 API
  if (path === '/api/prd/confirm' && req.method === 'POST') {
    const body = await parseBody(req);
    const prd = readPrd();
    if (!prd) return json(res, { error: 'prd.json not found' }, 404);
    // body.confirmed = ['US-001','US-002',...] 已确认的story id列表
    if (body.confirmed) {
      prd._confirmedStories = body.confirmed;
      const prdPath = join(PROJECT, 'scripts', 'gura', 'prd.json');
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));
    }
    return json(res, { ok: true });
  }

  // 字体文件
  if (path === '/Zpix.ttf') {
    try {
      const font = readFileSync(join(__dirname, 'Zpix.ttf'));
      res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'public, max-age=604800' });
      return res.end(font);
    } catch { res.writeHead(404); return res.end('Not Found'); }
  }

  // 头像图片
  if (path.startsWith('/avatars/') || path.startsWith('/backgrounds/')) {
    const imgPath = resolve(__dirname, '.' + decodeURIComponent(path));
    if (!imgPath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      const img = readFileSync(imgPath);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(img);
    } catch {
      res.writeHead(404);
      return res.end('Not Found');
    }
  }

  // 读取/更新 stats
  if (path === '/api/stats' && req.method === 'GET') {
    return json(res, readStats());
  }
  if (path === '/api/stats' && req.method === 'PUT') {
    const body = await parseBody(req);
    const cur = readStats();
    Object.assign(cur, body);
    // 等级计算
    const expForLevel = (lv) => lv <= 10 ? 100 : lv <= 20 ? 200 : lv <= 30 ? 300 : lv <= 40 ? 400 : lv <= 50 ? 500 : lv <= 60 ? 700 : lv <= 70 ? 900 : lv <= 80 ? 1200 : lv <= 90 ? 1600 : 2000;
    while (cur.level < 100 && cur.exp >= expForLevel(cur.level)) {
      cur.exp -= expForLevel(cur.level);
      cur.level++;
    }
    if (cur.level >= 100) { cur.level = 100; }
    writeStats(cur);
    broadcast();
    return json(res, cur);
  }

  // 暂停 Gura 执行
  if (path === '/api/gura/pause' && req.method === 'POST') {
    const sigDir = join(PROJECT, '.pi');
    if (!existsSync(sigDir)) mkdirSync(sigDir, { recursive: true });
    writeFileSync(join(sigDir, 'gura.pause'), '1');
    return json(res, { ok: true, action: 'paused' });
  }

  // 恢复 Gura 执行
  if (path === '/api/gura/resume' && req.method === 'POST') {
    const f = join(PROJECT, '.pi', 'gura.pause');
    if (existsSync(f)) unlinkSync(f);
    return json(res, { ok: true, action: 'resumed' });
  }

  // 跳过当前 story
  if (path === '/api/gura/skip' && req.method === 'POST') {
    const sigDir = join(PROJECT, '.pi');
    if (!existsSync(sigDir)) mkdirSync(sigDir, { recursive: true });
    writeFileSync(join(sigDir, 'gura.skip'), '1');
    return json(res, { ok: true, action: 'skip' });
  }

  // 在访达中打开项目目录
  if (path === '/api/gura/open-project' && req.method === 'POST') {
    spawn('open', [PROJECT], { detached: true, stdio: 'ignore' }).unref();
    return json(res, { ok: true, path: PROJECT });
  }

  // 获取项目路径
  if (path === '/api/gura/project-path' && req.method === 'GET') {
    return json(res, { path: PROJECT });
  }

  // 解锁/取消启动：暂停引擎 + 把未跑完的任务（running/failed/blocked）回滚为 pending
  // 注意：passed 的任务不动 —— 那是真实产出，不应丢失
  if (path === '/api/gura/unlock' && req.method === 'POST') {
    const sigDir = join(PROJECT, '.pi');
    if (!existsSync(sigDir)) mkdirSync(sigDir, { recursive: true });
    try { writeFileSync(join(sigDir, 'gura.pause'), '1'); } catch {}
    // 重写 status.json：未通过的 story 全部回到 pending
    let resetCount = 0, keptPassed = 0;
    try {
      const data = readStatus();
      if (data.tasks && data.tasks.length) {
        data.tasks.forEach(t => {
          if (t.status !== 'passed') {
            if (t.status !== 'pending') resetCount++;
            t.status = 'pending';
            t.startedAt = null;
            t.finishedAt = null;
          } else {
            keptPassed++;
          }
        });
        writeStatus(data); // 内部会触发 logStoryTransitions
      }
    } catch {}
    // 同步重置 gura-state.json
    try {
      const s = readGuraState();
      s.phase = 'idle';
      s.currentStory = null;
      writeGuraState(s);
      Object.assign(guraState, s);
    } catch {}
    appendRunLog({ type: 'unlock', resetCount, keptPassed });
    return json(res, { ok: true });
  }

  // 启动 Gura 执行引擎
  if (path === '/api/gura/launch' && req.method === 'POST') {
    const body = await parseBody(req);
    const agent = body.agent || 'claude';
    // 启动前清理残留信号文件
    try { unlinkSync(join(PROJECT, '.pi', 'gura.skip')); } catch {}
    try { unlinkSync(join(PROJECT, '.pi', 'gura.pause')); } catch {}
    // 优先用桌面版打包的 gura-engine 二进制（环境变量 GURA_ENGINE_BIN 由 Electron 主进程注入）
    // 找不到则回退到系统 python3 + gura.py（原网页版行为）
    const engineBin = process.env.GURA_ENGINE_BIN;
    let cmd, args;
    if (engineBin && existsSync(engineBin)) {
      cmd = engineBin; args = [agent];
    } else {
      const guraScript = join(__dirname, 'gura.py');
      cmd = 'python3'; args = [guraScript, agent];
    }
    const child = spawn(cmd, args, { cwd: PROJECT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // 把引擎的 stderr 捕获下来：启动即死的情况（比如不是 git 仓库）能在 UI 看到原因
    let earlyErr = '';
    let earlyExited = false;
    child.stderr.on('data', d => {
      const text = d.toString();
      earlyErr += text;
      // 保留最后 4KB 避免爆内存
      if (earlyErr.length > 4096) earlyErr = earlyErr.slice(-4096);
      process.stderr.write('[engine] ' + text);
    });
    child.stdout.on('data', d => process.stdout.write('[engine] ' + d.toString()));
    child.on('exit', (code, sig) => {
      earlyExited = true;
      // 10 秒内死亡视为启动失败，写一条执行日志 + run-log 事件，避免 UI 看起来卡死
      const tag = code === 0 ? 'engine-exit' : 'engine-crash';
      const summary = (earlyErr || '').trim().slice(-800) || `exit code=${code}`;
      try {
        const data = readStatus();
        data.logs = data.logs || [];
        data.logs.push({ time: new Date().toISOString(), msg: `[${tag}] ${cmd} exit=${code}${sig ? ' sig=' + sig : ''}` });
        if (summary) data.logs.push({ time: new Date().toISOString(), msg: '[engine-stderr] ' + summary });
        writeStatus(data);
      } catch {}
      appendRunLog({ type: 'engine_exit', code, signal: sig, cmd, stderr: summary });
    });
    child.unref();
    const stories = ((readPrd() || {}).userStories || []).length;
    appendRunLog({ type: 'launch', agent, pid: child.pid, engine: cmd, stories });
    return json(res, { ok: true, pid: child.pid, agent, engine: cmd });
  }

  // 任务执行历史
  if (path === '/api/gura/run-log' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(2000, parseInt(url.searchParams.get('limit')) || 200));
    return json(res, { items: readRunLog(limit) });
  }

  // === 会话管理 API ===

  // 列出所有历史会话
  if (path === '/api/session/list' && req.method === 'GET') {
    return json(res, { sessions: listSessions() });
  }

  // 手动归档当前会话（开始新项目前调用）
  if (path === '/api/session/new' && req.method === 'POST') {
    const archived = archiveCurrentSession();
    clearWorkspace();
    broadcast();
    return json(res, { ok: true, archived });
  }

  // 恢复某个历史会话
  if (path === '/api/session/restore' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.name) return json(res, { error: 'missing session name' }, 400);
    const ok = restoreSession(body.name);
    if (!ok) return json(res, { error: 'session not found or restore failed' }, 404);
    return json(res, { ok: true });
  }

  // 删除某个历史会话
  if (path === '/api/session/delete' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.name) return json(res, { error: 'missing session name' }, 400);
    const dir = join(SESSION_DIR, body.name);
    if (!existsSync(dir)) return json(res, { error: 'not found' }, 404);
    try {
      // 递归删除会话目录
      const rmRec = (p) => {
        if (!existsSync(p)) return;
        if (statSync(p).isDirectory()) {
          readdirSync(p).forEach(f => rmRec(join(p, f)));
          try { rmdirSync(p); } catch {}
        } else {
          unlinkSync(p);
        }
      };
      rmRec(dir);
      return json(res, { ok: true });
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  // 测试页
  if (path === '/test') {
    const state = JSON.stringify(buildFullState());
    const testHtml = `<!DOCTYPE html><html><head><style>body{background:#111;color:#fff;font-family:monospace}.card{border:2px solid #4ade80;padding:10px;margin:10px;background:#222}</style></head><body>
<h2>Tasks from API:</h2><div id="out"></div>
<script>
fetch('/api/gura/state').then(r=>r.json()).then(d=>{
  document.getElementById('out').innerHTML=d.tasks.map(t=>'<div class="card"><b>'+t.id+'</b> '+t.name+' ['+t.status+']</div>').join('');
});
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(testHtml);
  }

  // 前端页面
  if (path === '/' || path === '/p') {
    try {
      const html = readFileSync(join(__dirname, 'ui.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end('ui.html not found');
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\x1b[36m⬡ Gura — Progress Inspector\x1b[0m`);
  console.log(`  面板: http://localhost:${PORT}/p`);
  console.log(`  项目: ${PROJECT}`);
  console.log(`  状态: ${STATUS_FILE}`);

  let lastPrd = '', lastProg = '', lastGura = '', lastPrdMd = '';

  // 真正干活的同步函数：检查变化 → 写状态 → 广播
  function syncAndBroadcast() {
    // 同步 gura-state.json 到内存
    const diskGura = readGuraState();
    const diskGuraStr = JSON.stringify(diskGura);
    if (diskGuraStr !== lastGura) {
      lastGura = diskGuraStr;
      Object.assign(guraState, diskGura);
    }
    const prdStr = JSON.stringify(readPrd());
    const prog = readProgress();
    const prdMd = readPrdMd();
    if (prdMd !== lastPrdMd) lastPrdMd = prdMd;
    if (prdStr !== lastPrd || prog !== lastProg) {
      // PRD 变了 → 写入历史快照（同一时刻多次 watch 事件只生成一份）
      if (prdStr !== lastPrd && prdStr && prdStr !== 'null' && lastPrd !== '') {
        snapshotPrd(prdStr);
      } else if (prdStr !== lastPrd && prdStr && prdStr !== 'null' && lastPrd === '') {
        // 首次出现也存一份作为起点
        snapshotPrd(prdStr);
      }
      lastPrd = prdStr; lastProg = prog;
      const prdData = readPrd();
      if (prdData && prdData.userStories) {
        // currentStory 推进
        if (guraState.phase === 'developing' || guraState.phase === 'validating') {
          const curStory = prdData.userStories.find(s => s.id === guraState.currentStory);
          if (curStory && (curStory.passes || curStory.blocked)) {
            const next = prdData.userStories.find(s => !s.passes && !s.blocked);
            if (next) {
              guraState.currentStory = next.id;
              writeGuraState(guraState);
            }
          }
        }
        const data = readStatus();
        if (data.tasks && data.tasks.length) {
          prdData.userStories.forEach(s => {
            const task = data.tasks.find(t => t.id === s.id);
            if (task) {
              const isActive = guraState.currentStory === s.id && (guraState.phase === 'developing' || guraState.phase === 'validating');
              if (isActive) task.status = 'running';
              else if (s.blocked) task.status = 'blocked';
              else if (s.passes) task.status = 'passed';
              else if (task.status !== 'failed') task.status = 'pending';
              task.notes = s.notes || '';
              task.retryCount = s.retryCount || 0;
              task.blocked = s.blocked || false;
            }
          });
          writeStatus(data); // 内部会调 broadcast()
          return;
        }
      }
    }
    broadcast();
  }

  // fs.watch 即时触发 + 50ms 去抖（AI 写文件那一刻立刻广播，肉眼无延迟）
  let debounceTimer = null;
  const scheduleSync = () => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; syncAndBroadcast(); }, 50);
  };

  // 监听项目根（用于 tasks/、scripts/、.pi/ 子目录的新建/改动）
  // 用 non-recursive watch 避开 node_modules 风暴；目录被 watch 即可捕获其下文件 create/modify
  const watchSafely = (p) => {
    try {
      if (!existsSync(p)) return null;
      return fsWatch(p, { persistent: true }, () => scheduleSync());
    } catch (e) { console.warn('[watch] failed:', p, e.message); return null; }
  };

  // 兜底：项目根总是存在；子目录可能晚出现 → 每秒探测一次未挂载的 watcher
  const watchers = new Set();
  const targets = [
    PROJECT,
    join(PROJECT, 'tasks'),
    join(PROJECT, 'scripts', 'gura'),
    STATUS_DIR
  ];
  const mounted = new Map();
  setInterval(() => {
    for (const p of targets) {
      if (mounted.has(p)) continue;
      // 父目录得先存在才能 watch，scripts/gura 这种需要等
      if (!existsSync(p)) continue;
      const w = watchSafely(p);
      if (w) { mounted.set(p, w); watchers.add(w); }
    }
  }, 1000);
  // 首次挂载
  for (const p of targets) {
    if (existsSync(p)) {
      const w = watchSafely(p);
      if (w) { mounted.set(p, w); watchers.add(w); }
    }
  }

  // 心跳兜底（处理 fs.watch 在某些 FS / 容器里漏事件的情况）
  setInterval(syncAndBroadcast, 3000);
});

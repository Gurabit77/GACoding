// CLI 自动检测：通用 AI Coding CLI 发现机制
// 设计原则：不依赖硬编码列表，自动扫描用户安装目录中的所有可执行文件，
// 通过分析 --help / --version 输出来智能识别 AI coding CLI。
// 同时维护一份「已知模板」提供最优的 chatTemplate 配置。

const { spawn } = require('child_process');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileP = promisify(execFile);
const path = require('path');
const fs = require('fs');
const os = require('os');

// ========== 已知 CLI 模板（仅用于提供最优 chatTemplate / 颜色） ==========
// 如果扫描发现的 CLI 匹配到这里的 bin 名，就用对应模板；
// 否则用通用模板（{prompt}）。
const CLI_TEMPLATES = {
  'claude':       { name: 'Claude Code',    chatTemplate: ['--print', '--dangerously-skip-permissions', '{prompt}'], color: '#cc785c' },
  'kiro-cli':     { name: 'Kiro CLI',       chatTemplate: ['chat', '--no-interactive', '-a', '{prompt}'], color: '#7c3aed' },
  'codex':        { name: 'OpenAI Codex',   chatTemplate: ['exec', '--dangerously-bypass-approvals-and-sandbox', '{prompt}'], color: '#10a37f' },
  'cursor-agent': { name: 'Cursor Agent',   chatTemplate: ['-p', '{prompt}'], color: '#000000' },
  'gemini':       { name: 'Gemini CLI',     chatTemplate: ['-p', '{prompt}'], color: '#4285f4' },
  'aider':        { name: 'Aider',          chatTemplate: ['--no-pretty', '--yes', '--message', '{prompt}'], color: '#f59e0b' },
  'hermes':       { name: 'Hermes Agent',   chatTemplate: ['chat', '--yolo', '{prompt}'], color: '#e74c3c' },
  'opencode':     { name: 'OpenCode',       chatTemplate: ['{prompt}'], color: '#6366f1' },
  'mimo':         { name: 'MiMo Code',      chatTemplate: ['--print', '{prompt}'], color: '#ff6b6b' },
  'amp':          { name: 'Amp',            chatTemplate: ['{prompt}'], color: '#00bcd4' },
  'cline':        { name: 'Cline',          chatTemplate: ['{prompt}'], color: '#2196f3' },
  'continue':     { name: 'Continue',       chatTemplate: ['{prompt}'], color: '#9c27b0' },
  'copilot':      { name: 'GitHub Copilot', chatTemplate: ['{prompt}'], color: '#000000' },
  'gh-copilot':   { name: 'GitHub Copilot', chatTemplate: ['{prompt}'], color: '#000000' },
  'goose':        { name: 'Goose',          chatTemplate: ['{prompt}'], color: '#ff9800' },
  'plandex':      { name: 'Plandex',        chatTemplate: ['{prompt}'], color: '#4caf50' },
  'mentat':       { name: 'Mentat',         chatTemplate: ['{prompt}'], color: '#795548' },
  'roo':          { name: 'Roo Code',       chatTemplate: ['{prompt}'], color: '#607d8b' },
  'void':         { name: 'Void',           chatTemplate: ['{prompt}'], color: '#9e9e9e' },
  'sweep':        { name: 'Sweep',          chatTemplate: ['{prompt}'], color: '#673ab7' },
  'gpt-engineer': { name: 'GPT-Engineer',   chatTemplate: ['{prompt}'], color: '#3f51b5' },
  'smol':         { name: 'Smol Developer', chatTemplate: ['{prompt}'], color: '#e91e63' },
  'teamo':        { name: 'Teamo',          chatTemplate: ['{prompt}'], color: '#009688' },
};

// 确定不是 AI CLI 的可执行文件名（加速扫描，避免误判）
const SKIP_BINS = new Set([
  // 系统/开发工具
  'node', 'npm', 'npx', 'corepack', 'python', 'python3', 'pip', 'pip3',
  'git', 'vim', 'nano', 'less', 'more', 'cat', 'ls', 'cd', 'cp', 'mv', 'rm',
  'grep', 'find', 'sed', 'awk', 'curl', 'wget', 'ssh', 'scp', 'tar', 'zip',
  'unzip', 'make', 'gcc', 'g++', 'clang', 'rustc', 'cargo', 'go', 'java',
  'ruby', 'perl', 'php', 'lua', 'swift', 'kotlin', 'scala', 'docker',
  'kubectl', 'helm', 'terraform', 'ansible', 'brew', 'apt', 'yum', 'dnf',
  // 包管理器/运行时
  'bun', 'bunx', 'deno', 'yarn', 'pnpm', 'volta', 'fnm', 'nvm', 'rbenv',
  'pyenv', 'pipx', 'pipenv', 'poetry', 'pdm', 'uv', 'rye',
  // 常见工具
  'jq', 'yq', 'fzf', 'bat', 'exa', 'fd', 'rg', 'ripgrep', 'delta', 'lazygit',
  'tmux', 'screen', 'htop', 'tree', 'dust', 'duf', 'procs', 'bottom', 'zoxide',
  'starship', 'fig', 'nushell', 'fish', 'zsh', 'bash',
  // 编辑器
  'code', 'subl', 'atom', 'cursor', 'nvim', 'helix',
  // 网络工具
  'lt', 'ngrok', 'localtunnel', 'serve', 'http-server',
  // electron/构建相关
  'electron', 'electron-builder', 'tsc', 'esbuild', 'vite', 'webpack',
  'rollup', 'turbo', 'nx', 'lerna',
]);

// AI/Coding CLI 识别关键词（出现在 --help 或 --version 输出中）
const AI_KEYWORDS = [
  // 核心 AI 相关
  'ai ', 'ai-', 'llm', 'gpt', 'claude', 'openai', 'anthropic', 'gemini',
  'copilot', 'codex', 'coding assistant', 'code assistant', 'ai coding',
  'ai agent', 'ai assistant', 'language model', 'large language',
  // 功能特征
  'prompt', 'chat', 'interactive session', 'non-interactive',
  'code generation', 'code review', 'code completion',
  'pair program', 'agentic', 'autonomous coding',
  // 已知产品名
  'aider', 'cursor', 'cline', 'continue', 'sweep', 'mentat',
  'plandex', 'smol', 'goose', 'hermes', 'kiro', 'mimo',
  'opencode', 'teamo', 'roo', 'amp', 'void',
];

// ========== PATH 修复 ==========

let _resolvedEnv = null;

function readMacOSSystemPaths() {
  const paths = [];
  try {
    const content = fs.readFileSync('/etc/paths', 'utf-8');
    content.split('\n').map(s => s.trim()).filter(Boolean).forEach(p => paths.push(p));
  } catch {}
  try {
    const dir = '/etc/paths.d';
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(f => {
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf-8');
          content.split('\n').map(s => s.trim()).filter(Boolean).forEach(p => paths.push(p));
        } catch {}
      });
    }
  } catch {}
  return paths;
}

function getUserDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.yarn', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.npm', 'bin'),
    path.join(home, 'go', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/pkg/env/active/bin',
    '/opt/pmk/env/global/bin',
    '/usr/local/lib/node_modules/.bin',
  ].filter(d => {
    try { return fs.existsSync(d); } catch { return false; }
  });
}

function getNvmBin() {
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    if (!fs.existsSync(nvmDir)) return [];
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    return versions.slice(0, 3).map(v => path.join(nvmDir, v, 'bin')).filter(d => fs.existsSync(d));
  } catch { return []; }
}

async function resolveShellEnv() {
  if (_resolvedEnv) return _resolvedEnv;

  const allPaths = new Set();

  if (process.platform === 'darwin') {
    readMacOSSystemPaths().forEach(p => allPaths.add(p));
  }

  getUserDirs().forEach(p => allPaths.add(p));
  getNvmBin().forEach(p => allPaths.add(p));
  (process.env.PATH || '').split(path.delimiter).filter(Boolean).forEach(p => allPaths.add(p));

  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || '/bin/zsh';
    try {
      const { stdout } = await execFileP(shell, ['-ilc', 'echo "___GURA_PATH___$PATH"'], {
        timeout: 3000,
        env: { HOME: os.homedir(), TERM: 'dumb', USER: os.userInfo().username, PATH: [...allPaths].join(path.delimiter) }
      });
      const marker = '___GURA_PATH___';
      const idx = stdout.indexOf(marker);
      if (idx >= 0) {
        const shellPath = stdout.slice(idx + marker.length).split(/\r?\n/)[0].trim();
        if (shellPath) {
          shellPath.split(path.delimiter).filter(Boolean).forEach(p => allPaths.add(p));
        }
      }
    } catch {}
  }

  console.log('[cli-detector] PATH 包含', allPaths.size, '个目录');
  _resolvedEnv = { PATH: [...allPaths].join(path.delimiter) };
  return _resolvedEnv;
}

function resetEnvCache() {
  _resolvedEnv = null;
}

// ========== 通用发现机制 ==========

// 获取用户级 bin 目录中的所有可执行文件
function listUserExecutables() {
  const dirs = getUserDirs();
  const executables = []; // [{ bin, fullPath, dir }]

  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        // 跳过明确非 AI CLI 的
        const baseName = entry.replace(/\.exe$/i, '');
        if (SKIP_BINS.has(baseName)) continue;
        // 跳过带括号的符号链接描述（如 "bash (kiro-cli-term)"）
        if (entry.includes('(') || entry.includes(')')) continue;
        // 跳过以点开头的隐藏文件
        if (entry.startsWith('.')) continue;
        // 跳过 python 版本文件（python3.11 等）
        if (/^python\d/.test(entry)) continue;
        // 跳过 -desktop / -term 后缀（GUI / 终端包装器，不是独立 CLI）
        if (/-desktop$|-term$/.test(baseName)) continue;

        const fullPath = path.join(dir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) continue;
          // 检查可执行权限
          if (process.platform !== 'win32' && !(stat.mode & 0o111)) continue;
          executables.push({ bin: baseName, fullPath, dir });
        } catch {}
      }
    } catch {}
  }

  return executables;
}

// 探测版本
async function probeVersion(binPath) {
  const env = await resolveShellEnv();
  try {
    const { stdout, stderr } = await execFileP(binPath, ['--version'], {
      timeout: 5000,
      env: { ...process.env, ...env }
    });
    return ((stdout || '') + (stderr || '')).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

// 探测 --help 输出，判断是否是 AI coding CLI
async function probeIsAiCli(binPath) {
  const env = await resolveShellEnv();
  // 尝试 --help 和 --version 两种方式
  for (const args of [['--help'], ['--version'], ['-h']]) {
    try {
      const { stdout, stderr } = await execFileP(binPath, args, {
        timeout: 3000,
        env: { ...process.env, ...env }
      });
      const combined = ((stdout || '') + ' ' + (stderr || '')).toLowerCase();
      // 检查是否包含 AI 相关关键词
      const matchCount = AI_KEYWORDS.filter(kw => combined.includes(kw)).length;
      if (matchCount >= 2) {
        // 至少匹配 2 个关键词才认为是 AI CLI（避免误判）
        return { isAi: true, output: combined.slice(0, 500), matchCount };
      }
    } catch {}
  }
  return { isAi: false };
}

// 随机生成美观的颜色（基于 bin 名 hash，保证同一 CLI 颜色稳定）
function generateColor(binName) {
  let hash = 0;
  for (let i = 0; i < binName.length; i++) {
    hash = ((hash << 5) - hash + binName.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

// 从 --help 输出中推断 chatTemplate
function inferChatTemplate(helpOutput) {
  if (!helpOutput) return ['{prompt}'];
  const low = helpOutput.toLowerCase();

  // 尝试推断常见模式
  if (low.includes('--print') && low.includes('--dangerously-skip-permissions'))
    return ['--print', '--dangerously-skip-permissions', '{prompt}'];
  if (low.includes('--print') && low.includes('non-interactive'))
    return ['--print', '{prompt}'];
  if (low.includes('exec') && low.includes('--dangerously-bypass'))
    return ['exec', '--dangerously-bypass-approvals-and-sandbox', '{prompt}'];
  if (low.includes('--no-interactive') && low.includes('-a'))
    return ['chat', '--no-interactive', '-a', '{prompt}'];
  if (low.includes('--yolo'))
    return ['chat', '--yolo', '{prompt}'];
  if (low.includes('--message'))
    return ['--message', '{prompt}'];
  if (low.includes('--no-pretty') && low.includes('--yes'))
    return ['--no-pretty', '--yes', '--message', '{prompt}'];
  if (low.includes('-p') && (low.includes('prompt') || low.includes('print')))
    return ['-p', '{prompt}'];

  // 默认
  return ['{prompt}'];
}

// ========== 主检测逻辑 ==========

async function detectAll() {
  resetEnvCache();
  const env = await resolveShellEnv();

  // 第 1 步：收集所有用户 bin 目录中的可执行文件
  const executables = listUserExecutables();
  console.log('[cli-detector] 扫描到', executables.length, '个候选可执行文件');

  // 第 2 步：先检测已知模板中的 CLI（快速路径）
  const knownBins = Object.keys(CLI_TEMPLATES);
  const foundIds = new Set();
  const results = [];

  // 已知 CLI：直接 which 或文件扫描，不需要探测 --help
  const knownChecks = knownBins.map(async (bin) => {
    const tpl = CLI_TEMPLATES[bin];
    // 先从 executables 里找
    let found = executables.find(e => e.bin === bin);
    if (!found) {
      // 尝试 which
      try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const { stdout } = await execFileP(cmd, [bin], {
          timeout: 3000,
          env: { ...process.env, ...env }
        });
        const p = stdout.split(/\r?\n/)[0].trim();
        if (p) found = { bin, fullPath: p, dir: path.dirname(p) };
      } catch {}
    }
    if (!found) return null;

    const version = await probeVersion(found.fullPath);
    if (!version) return null; // --version 失败说明可能不是真的 CLI

    foundIds.add(bin);
    return {
      id: bin,
      name: tpl.name,
      bin: bin,
      path: found.fullPath,
      version,
      versionArgs: ['--version'],
      chatTemplate: tpl.chatTemplate,
      ptyArgs: [],
      color: tpl.color,
      source: 'detected'
    };
  });

  const knownResults = (await Promise.all(knownChecks)).filter(Boolean);
  results.push(...knownResults);

  // 第 3 步：对未匹配的可执行文件，用 AI 关键词探测（通用发现）
  // 过滤掉：已知 CLI 的子命令/变体（如 kiro-cli-chat 是 kiro-cli 的变体）
  const foundBins = [...foundIds];
  const unknownExes = executables.filter(e => {
    if (foundIds.has(e.bin) || knownBins.includes(e.bin)) return false;
    // 跳过已检测到的 CLI 的子命令变体
    // 例如：kiro-cli 已检测 → 跳过 kiro-cli-chat, kiro-cli-term
    // 例如：mimo 已检测 → 跳过 mimo-bun, mimo-code
    for (const fb of foundBins) {
      if (e.bin.startsWith(fb + '-') || e.bin.startsWith(fb + '_')) return false;
    }
    // 反向：如果 e.bin 是某个已知模板的前缀变体也跳过
    for (const kb of knownBins) {
      if (e.bin.startsWith(kb + '-') || e.bin.startsWith(kb + '_')) return false;
    }
    return true;
  });

  // 并发但限制数量，避免同时启动太多进程
  const CONCURRENCY = 5;
  const discoveredVersions = new Set(results.map(r => r.version)); // 去重用
  for (let i = 0; i < unknownExes.length; i += CONCURRENCY) {
    const batch = unknownExes.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (exe) => {
      try {
        const probe = await probeIsAiCli(exe.fullPath);
        if (!probe.isAi) return null;

        const version = await probeVersion(exe.fullPath);
        // 去重：如果版本输出和已有 CLI 完全一样，说明是同一个工具的不同入口
        if (version && discoveredVersions.has(version)) return null;

        const chatTemplate = inferChatTemplate(probe.output);

        console.log(`[cli-detector] 🔍 发现 AI CLI: ${exe.bin} (${probe.matchCount} 关键词匹配)`);
        if (version) discoveredVersions.add(version);
        return {
          id: exe.bin,
          name: exe.bin.charAt(0).toUpperCase() + exe.bin.slice(1),
          bin: exe.bin,
          path: exe.fullPath,
          version: version || 'unknown',
          versionArgs: ['--version'],
          chatTemplate,
          ptyArgs: [],
          color: generateColor(exe.bin),
          source: 'discovered'
        };
      } catch {
        return null;
      }
    }));
    results.push(...batchResults.filter(Boolean));
  }

  console.log('[cli-detector] 最终检测到', results.length, '个 AI CLI');
  return results;
}

// 向后兼容：KNOWN_CLIS 导出（转换自 CLI_TEMPLATES）
const KNOWN_CLIS = Object.entries(CLI_TEMPLATES).map(([bin, tpl]) => ({
  id: bin,
  name: tpl.name,
  bin,
  versionArgs: ['--version'],
  chatTemplate: tpl.chatTemplate,
  ptyArgs: [],
  color: tpl.color
}));

module.exports = { detectAll, KNOWN_CLIS, resolveShellEnv };

// 用户自定义 CLI 注册表：~/.gura/cli-registry.json
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FILE = path.join(os.homedir(), '.gura', 'cli-registry.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch { return []; }
}
function write(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function list() {
  return read().map(e => ({ ...e, source: 'custom' }));
}

function add(entry) {
  // entry: { name, path, chatTemplate(string[]), color? }
  if (!entry || !entry.name || !entry.path) throw new Error('需要 name 和 path');
  const resolved = path.resolve(entry.path);
  if (!fs.existsSync(resolved)) throw new Error('路径不存在: ' + entry.path);
  if (entry.chatTemplate) {
    if (!Array.isArray(entry.chatTemplate)) throw new Error('chatTemplate 必须是数组');
    if (!entry.chatTemplate.some(t => t.includes('{prompt}'))) throw new Error('chatTemplate 必须包含 {prompt} 占位符');
  }
  const id = entry.id || ('custom-' + crypto.randomBytes(3).toString('hex'));
  const item = {
    id,
    name: String(entry.name).slice(0, 50),
    bin: resolved,
    path: resolved,
    versionArgs: entry.versionArgs || ['--version'],
    chatTemplate: entry.chatTemplate || ['{prompt}'],
    ptyArgs: entry.ptyArgs || [],
    color: entry.color || '#888'
  };
  const all = read();
  const idx = all.findIndex(x => x.id === id);
  if (idx >= 0) all[idx] = item; else all.push(item);
  write(all);
  return item;
}

function remove(id) {
  const all = read().filter(x => x.id !== id);
  write(all);
  return true;
}

module.exports = { list, add, remove };

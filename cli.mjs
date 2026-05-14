#!/usr/bin/env node
// Gura CLI — 命令行更新任务状态
// 用法: pi init "项目名" "任务1" "任务2" ...
//       pi start T-1
//       pi pass T-1
//       pi fail T-1 "错误信息"
//       pi log "自定义日志"
//       pi status
//       pi serve [--port 7334]

import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PI_PORT || '7334');
const [,, cmd, ...args] = process.argv;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = request({ hostname: '127.0.0.1', port: PORT, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', () => reject(new Error('服务器未运行，请先执行: pi serve')));
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  if (!cmd || cmd === 'help') {
    console.log(`\x1b[36m⬡ Gura — Progress Inspector CLI\x1b[0m

  pi serve [--port 7334]           启动面板服务器
  pi init "项目" "任务1" "任务2"    初始化项目任务
  pi start <task-id>               标记任务开始
  pi pass <task-id>                标记任务通过
  pi fail <task-id> ["错误信息"]    标记任务失败
  pi log "消息"                    添加日志
  pi status                        查看当前状态`);
    return;
  }

  if (cmd === 'serve') {
    const portArg = args.indexOf('--port');
    const port = portArg >= 0 ? args[portArg + 1] : '7334';
    const projectArg = args.indexOf('--project');
    const project = projectArg >= 0 ? args[projectArg + 1] : process.cwd();
    const child = execFile('node', [join(__dirname, 'server.mjs'), '--port', port, '--project', project], { stdio: 'inherit' });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    return;
  }

  try {
    if (cmd === 'init') {
      const [project, ...tasks] = args;
      await api('POST', '/api/init', { project, tasks });
      console.log(`✓ 初始化 ${tasks.length} 个任务`);
    } else if (cmd === 'start') {
      await api('PUT', '/api/task', { id: args[0], status: 'running' });
      console.log(`▸ ${args[0]} running`);
    } else if (cmd === 'pass') {
      await api('PUT', '/api/task', { id: args[0], status: 'passed' });
      console.log(`✓ ${args[0]} passed`);
    } else if (cmd === 'fail') {
      await api('PUT', '/api/task', { id: args[0], status: 'failed', error: args[1] || '' });
      console.log(`✗ ${args[0]} failed`);
    } else if (cmd === 'log') {
      await api('POST', '/api/log', { msg: args.join(' ') });
      console.log(`📝 logged`);
    } else if (cmd === 'status') {
      const data = await api('GET', '/api/status');
      const passed = data.tasks?.filter(t => t.status === 'passed').length || 0;
      const total = data.tasks?.length || 0;
      console.log(`\x1b[36m${data.project}\x1b[0m  ${passed}/${total}`);
      data.tasks?.forEach(t => {
        const icon = { pending: '○', running: '▸', passed: '✓', failed: '✗' }[t.status] || '?';
        const color = { pending: '37', running: '33', passed: '32', failed: '31' }[t.status] || '37';
        console.log(`  \x1b[${color}m${icon}\x1b[0m ${t.id} ${t.name}`);
      });
    } else {
      console.error(`未知命令: ${cmd}，执行 pi help 查看帮助`);
    }
  } catch (e) {
    console.error(`\x1b[31m${e.message}\x1b[0m`);
  }
}

main();

// Gura 聊天面板逻辑 —— 在 ui.html 加载完成后被 main.js 注入
// 依赖：window.gura（由 preload.js 暴露）

(function() {
  const $ = (s) => document.querySelector(s);
  const body = $('#gcp-body');
  const panel = $('#gura-chat-panel');
  const toggle = $('#gura-chat-toggle');
  const input = $('#gcp-input');
  const sendBtn = $('#gcp-send');
  const cancelBtn = $('#gcp-cancel');
  const hint = $('#gcp-hint');
  const cliSel = $('#gcp-cli-select');
  const addBtn = $('#gcp-cli-add');
  const rescanBtn = $('#gcp-cli-rescan');
  const inputWrap = $('#gcp-input-wrap');
  const termWrap = $('#gura-term-wrap');
  const closeBtn = $('#gcp-close');
  const modeBar = $('.gcp-mode-bar');
  const modeBtns = document.querySelectorAll('#gura-chat-panel .gcp-mode');
  const newChatBtn = $('#gcp-newchat');

  // ----- 三态模式：chat（闲聊）/ project（项目流程）/ term（终端）-----
  // mode 替代了原来的 scene + chat/term 两轴
  let mode = 'chat';                   // 'chat' | 'project' | 'term'
  let scene = 'chat';                  // 派生量：'chat'|'project'，term 模式时维持上一次的 ai-scene
  let conversation = [];               // [{role:'user'|'assistant', text}]
  let projectIntroSent = false;        // 项目模式是否已发过 system prompt

  const PROJECT_SYSTEM_PROMPT = `你现在是 Gura 自动化 Coding 系统的【项目规划助理】，工作在用户当前打开的项目目录下。

# 🚨 最关键的硬性规则（违反 = 任务失败）

**你在本次会话中【只能】创建/修改这两个文件，且必须写在【项目根目录】下：**
1. \`<项目根>/tasks/prd-<slug>.md\` —— 产品需求文档
2. \`<项目根>/scripts/gura/prd.json\` —— Gura 可执行的 user story 列表

**严禁做以下事情：**
- ❌ 不要创建任何应用代码文件（\`.ts\` \`.tsx\` \`.js\` \`.jsx\` \`.py\` \`.go\` \`.html\` \`.css\` \`vite.config.*\` \`tsconfig.*\` \`package.json\` 等）。**代码由后续的 Gura Builder 自动生成，不是你的工作。**
- ❌ 不要在项目根下创建子目录作为"新项目"（如 \`my-app/\` \`frontend/\` \`backend/\`）。项目根目录本身就是项目，你只在它下面写 \`tasks/\` 和 \`scripts/gura/\` 两个子目录。
- ❌ 不要执行 \`npm init\` \`git init\` \`mkdir 新项目名\` 之类的命令。
- ❌ 在 Phase 1（需求澄清）期间，**禁止写任何文件**。只能用文字回复用户问题。

# 完整流程（必须按顺序）

## Phase 1 · 需求澄清（不写文件）
- 用户第一条消息通常是模糊的功能描述。**主动提问**澄清，但只问"产品方向、功能取舍、核心体验"层面的关键问题（一次 1-3 个）。
- 技术决策（用什么栈、怎么拆模块）你自己定，写进 PRD 的"技术栈"章节，**不要问用户**。
- 用户回答后，**挖掘隐含需求**——分析使用场景，列出"用户说的需求 + 你额外建议的需求"让用户一次性确认。
- 若还有拿不准的点，继续问，直到需求清晰。
- **本阶段绝对不写任何文件**，纯对话。

## Phase 2 · 写 PRD（只写一个 .md 文件）
确认需求后，**写入** \`<项目根>/tasks/prd-<slug>.md\`（\`<slug>\` 是项目名的小写连字符形式）。结构：
\`\`\`markdown
# <项目名> PRD
## 项目概述
## 目标用户
## 功能模块
## 用户故事（每条含验收标准）
## 技术栈
## Non-Goals（已拒绝的需求和原因）
\`\`\`
写完后只回复一句话："已生成 PRD：tasks/prd-xxx.md，包含 N 个 user story。即将转成 prd.json…"

## Phase 3 · 生成 prd.json（只写一个 .json 文件）
**写入** \`<项目根>/scripts/gura/prd.json\`（\`scripts/gura/\` 目录不存在就一并创建）。格式严格如下：
\`\`\`json
{
  "project": "项目名",
  "branchName": "gura/<feature-name>",
  "userStories": [
    {
      "id": "US-001",
      "title": "story 标题",
      "description": "作为...我需要...",
      "acceptanceCriteria": ["验收标准1","验收标准2"],
      "references": [],
      "priority": 1,
      "passes": false,
      "notes": "",
      "retryCount": 0,
      "blocked": false
    }
  ]
}
\`\`\`
- id 从 US-001 递增
- priority: 1=P0最高 5=P4最低
- passes/blocked 始终 false，retryCount 始终 0

## Phase 4 · 完成（停止）
写完 prd.json 后回复："✅ Gura 项目准备就绪。左侧'PRD 审核'区已显示 N 个 user story。确认无误后点击底部'全部确认后启动 Gura'即可开始自动编码。"
**然后立即停止。** 不要再写任何文件，不要主动开始编码，等用户在 UI 上点启动按钮。

# 工作规则
- 写文件时使用【绝对路径】，基于本消息开头提供的"项目根"路径拼接
- **不要把整个 PRD 或 JSON 粘贴到回复里**——写文件就够了，回复只说"已写入哪个文件 + 一句话总结"
- Phase 2 → Phase 3 → Phase 4 **自动连续完成**，中间不要等用户确认
- 如果用户在描述里要求"直接开始写代码"，礼貌拒绝："我是项目规划助理，先把 PRD 和 prd.json 做出来，后续 Gura Builder 会自动写代码。"

现在开始 Phase 1。等用户的第一条消息。`;

  // 切换到三态之一。term 走 PTY 路径，chat/project 走 AI 路径
  async function setMode(m) {
    if (m === mode) return;
    const prev = mode;
    mode = m;

    // 视觉态：mode-bar 滑块 + 按钮 active
    if (modeBar) {
      modeBar.classList.remove('mode-chat', 'mode-project', 'mode-term');
      modeBar.classList.add('mode-' + m);
    }
    modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    panel.classList.toggle('term-mode', m === 'term');

    if (m === 'term') {
      // 进入终端：隐藏聊天体+输入框，显示 xterm
      inputWrap.style.display = 'none';
      body.style.display = 'none';
      termWrap.classList.add('show');
      try {
        await ensureXterm();
        if (!termSession) {
          termSession = 'term-' + Date.now();
          const r = await window.gura.termSpawn(termSession);
          if (!r.ok && xterm) {
            xterm.write('\x1b[31m启动终端失败：' + (r.error || '未知错误') + '\x1b[0m\r\n');
            termSession = null;
          }
        }
        setTimeout(() => fitAddon && fitAddon.fit(), 100);
      } catch (e) { console.warn('term init failed', e); }
      return;
    }

    // 从 term 回到 AI 模式：复原 UI
    inputWrap.style.display = '';
    body.style.display = '';
    termWrap.classList.remove('show');

    // 更新 AI 场景
    scene = m; // 'chat' | 'project'

    if (m === 'project') {
      input.placeholder = '描述你想做的项目… (Enter 发送)';
      if (!projectIntroSent) {
        appendMsg('system', '⬢ 项目模式已激活。直接描述你想做的项目，AI 会引导你完成需求 → PRD → prd.json 全流程。');
      }
    } else {
      input.placeholder = '输入消息… (Enter 发送，Shift+Enter 换行)';
      // 仅在从其他模式切回时提示一次，避免噪音
      if (prev !== 'chat') appendMsg('system', '💬 切到闲聊模式（不触发项目流程）。');
    }
  }
  modeBtns.forEach(b => b.onclick = () => setMode(b.dataset.mode));

  newChatBtn.onclick = () => {
    conversation = [];
    projectIntroSent = false;
    body.innerHTML = '';
    appendMsg('system', '已开始新会话。');
  };

  // 折叠/展开
  toggle.onclick = () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) { input.focus(); toggle.classList.remove('has-update'); }
  };
  closeBtn.onclick = () => panel.classList.remove('open');

  // ----- CLI 列表 -----
  let cliList = [];
  async function refreshCliList() {
    try {
      if (!window.gura) { console.error('[chat-panel] window.gura 不存在，preload 未生效'); return; }
      const { detected, custom, active } = await window.gura.listCli();
      cliList = [...detected, ...custom];
      cliSel.innerHTML = cliList.length
        ? cliList.map(c => `<option value="${c.id}">${c.name} ${c.source==='custom'?'⚙':''} (${c.version || c.path || ''})</option>`).join('')
        : '<option value="">未检测到 CLI</option>';
      if (active && cliList.find(c => c.id === active)) cliSel.value = active;
      hint.textContent = cliList.length ? `${cliList.length} 个可用` : '请添加 CLI';
      console.log('[chat-panel] CLI 扫描完成:', { detected: detected.length, custom: custom.length });
    } catch (e) {
      console.error('[chat-panel] refreshCliList 出错：', e);
      cliSel.innerHTML = '<option value="">扫描失败：'+ (e.message||e) +'</option>';
    }
  }
  cliSel.onchange = async () => {
    await window.gura.setActiveCli(cliSel.value);
    appendMsg('system', `已切换到：${cliSel.options[cliSel.selectedIndex].text}`);
  };
  rescanBtn.onclick = async () => {
    rescanBtn.textContent = '…';
    await window.gura.rescanCli();
    await refreshCliList();
    rescanBtn.textContent = '↻';
  };

  // ----- 添加自定义 CLI 模态 -----
  const modal = $('#gcp-add-modal');
  addBtn.onclick = () => modal.classList.add('open');
  $('#m-cancel').onclick = () => modal.classList.remove('open');
  $('#m-browse').onclick = async () => {
    const p = await window.gura.pickExecutable();
    if (p) $('#m-path').value = p;
  };
  $('#m-save').onclick = async () => {
    const name = $('#m-name').value.trim();
    const p = $('#m-path').value.trim();
    const tpl = $('#m-template').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!name || !p) { alert('请填写名称和路径'); return; }
    if (!tpl.length) { alert('请填写调用模板'); return; }
    await window.gura.addCli({ name, path: p, chatTemplate: tpl });
    modal.classList.remove('open');
    $('#m-name').value = ''; $('#m-path').value = ''; $('#m-template').value = '';
    await refreshCliList();
  };

  // ----- 消息渲染 -----
  function appendMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'gcp-msg ' + role;
    const r = document.createElement('div');
    r.className = 'role';
    r.textContent = role === 'user' ? '我' : role === 'bot' ? cliSel.options[cliSel.selectedIndex]?.text || 'AI' : role === 'err' ? '错误' : '系统';
    div.appendChild(r);
    const t = document.createElement('div');
    t.textContent = text;
    t.className = 'text';
    div.appendChild(t);
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return t;
  }

  // ----- 一次性聊天 -----
  let activeSession = null;
  let activeTextNode = null;
  let activeRawBuf = '';

  // 把 CLI 的 TUI 装饰/状态行过滤掉，只保留真正的回复
  function sanitizeOutput(raw) {
    // 1. 去 ANSI 转义码 (\x1b[...m 颜色，\x1b]...\x07 OSC，\x1b[K 清行等)
    let t = raw
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b[=>]/g, '');
    // 2. CR 行覆盖：spinner 类输出，保留 \r 后的最后一段
    t = t.replace(/^.*\r(?!\n)/gm, '');
    // 3. 按行过滤
    const skip = [
      /^\s*[\u2800-\u28ff⠀-⣿]+/,                 // 盲文 spinner 字符开头
      /^\s*[✓✔×✖]\s*\d+\s*of\s*\d+\s*hook/i,    // ✓ 1 of 1 hooks finished
      /\d+\s*of\s*\d+\s*hooks?\s*finished/i,
      /All tools are now trusted/i,
      /Agents can sometimes do unexpected things/i,
      /Learn more at https?:\/\/kiro\.dev/i,
      /^▸\s*Credits/i,
      /^\s*Credits:\s*[\d.]+\s*•\s*Time:/i,
      /^\s*\[?DEBUG\]?/i,
    ];
    const lines = t.split('\n').filter(line => {
      const s = line.trim();
      if (!s) return true; // 保留空行（后面合并）
      return !skip.some(re => re.test(s));
    });
    let out = lines.join('\n');
    // 4. 去掉行首 "> " 提示符
    out = out.replace(/^>\s+/gm, '');
    // 5. 合并 3+ 空行
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    return out;
  }

  // 记录每轮发起前的 PRD 落地情况，done 时对比
  let preTurnPrdState = { md: false, json: false };

  window.gura.onChatStream(({ sessionId, chunk }) => {
    if (sessionId !== activeSession) return;
    if (chunk.type === 'stdout' || chunk.type === 'stderr') {
      if (!activeTextNode) activeTextNode = appendMsg('bot', '');
      activeRawBuf += chunk.text;
      // 整段重渲染（每次 chunk 都重新过滤），避免跨 chunk 切断的转义码出问题
      activeTextNode.textContent = sanitizeOutput(activeRawBuf);
      body.scrollTop = body.scrollHeight;
    } else if (chunk.type === 'error') {
      appendMsg('err', chunk.text);
    } else if (chunk.type === 'done') {
      // 把 AI 完整回复存入对话历史
      if (activeRawBuf) {
        const cleaned = sanitizeOutput(activeRawBuf);
        if (cleaned) conversation.push({ role: 'assistant', text: cleaned });
      }
      hint.textContent = chunk.code === 0 ? '完成' : `退出码 ${chunk.code}`;
      sendBtn.style.display = ''; cancelBtn.style.display = 'none';
      activeSession = null; activeTextNode = null; activeRawBuf = '';

      // 项目模式 done 后：探一次 PRD 文件，看 AI 这一轮有没有真的落盘
      if (scene === 'project') {
        window.gura.hasPrdFiles().then(post => {
          const justWroteMd = !preTurnPrdState.md && post.md;
          const justWroteJson = !preTurnPrdState.json && post.json;
          if (justWroteJson && justWroteMd) {
            appendMsg('system', '✓ PRD 已落盘 — 切到左侧"PRD 审核"查看，确认后点底部按钮启动 Gura。');
          } else if (justWroteJson) {
            appendMsg('system', '✓ prd.json 已落盘。');
          } else if (justWroteMd) {
            appendMsg('system', '✓ tasks/prd-*.md 已落盘。');
          }
          // 面板未打开 → 给悬浮按钮一个小红点
          if (justWroteJson || justWroteMd) {
            if (!panel.classList.contains('open')) toggle.classList.add('has-update');
          }
        }).catch(() => {});
      }
    }
  });

  // 构造最终发给 CLI 的 prompt：项目模式注入系统提示词 + 历史
  async function buildPrompt(userText) {
    const projectPath = await window.gura.currentProject();
    const prdState = await window.gura.hasPrdFiles().catch(() => ({ md: false, json: false }));
    const parts = [];
    if (scene === 'project') {
      if (!projectIntroSent) {
        parts.push(PROJECT_SYSTEM_PROMPT);
        parts.push('');
        parts.push(`【项目根（你只能在此目录下写文件，不要在子目录创建新项目）】\n${projectPath || '（未打开项目）'}`);
        parts.push(`【你只能写两个文件】`);
        parts.push(`  - ${projectPath}/tasks/prd-<slug>.md`);
        parts.push(`  - ${projectPath}/scripts/gura/prd.json`);
        parts.push('');
        projectIntroSent = true;
      } else if (prdState.json && prdState.md) {
        // PRD 已落地 → 极简上下文，不再复述全部规则，省 token + 不烦人
        parts.push(`【项目根】${projectPath}（PRD 已就绪，仅讨论或修订 prd.json/prd-*.md，不要写代码）`);
        parts.push('');
      } else {
        parts.push(`【提醒】Gura 项目模式。项目根：${projectPath}。只允许写 ${projectPath}/tasks/prd-*.md 和 ${projectPath}/scripts/gura/prd.json，禁止写代码文件、禁止创建子项目目录。`);
        parts.push('');
      }
    }
    // 历史对话（最多保留最近 10 轮，避免 token 爆炸）
    const recent = conversation.slice(-20);
    for (const m of recent) {
      parts.push(`${m.role === 'user' ? '【用户】' : '【你】'}${m.text}`);
    }
    parts.push(`【用户】${userText}`);
    return parts.join('\n\n');
  }

  async function sendChat() {
    const text = input.value.trim();
    if (!text) return;
    if (!cliSel.value) { appendMsg('err', '请先选择或添加 CLI'); return; }
    appendMsg('user', text);
    conversation.push({ role: 'user', text });
    input.value = '';
    activeSession = 'chat-' + Date.now();
    activeTextNode = null; activeRawBuf = '';
    sendBtn.style.display = 'none'; cancelBtn.style.display = '';
    hint.textContent = mode === 'project' ? '⬢ 项目流程中…' : '生成中…';
    // snapshot 发送前的 PRD 落地状态，供 done 时对比
    if (scene === 'project') {
      preTurnPrdState = await window.gura.hasPrdFiles().catch(() => ({ md: false, json: false }));
    }
    const fullPrompt = await buildPrompt(text);
    await window.gura.chatSend(activeSession, fullPrompt);
  }
  sendBtn.onclick = sendChat;
  cancelBtn.onclick = async () => {
    if (activeSession) await window.gura.chatCancel(activeSession);
    hint.textContent = '已取消';
    sendBtn.style.display = ''; cancelBtn.style.display = 'none';
    activeSession = null;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // ----- 终端模式（按需加载 xterm） -----
  let termSession = null;
  let xterm = null;
  let fitAddon = null;

  async function ensureXterm() {
    if (xterm) return xterm;
    // 使用主进程注入的本地 xterm 资源（离线可用）
    if (!window.Terminal && window.__guraXtermJs) {
      const s = document.createElement('script');
      s.textContent = window.__guraXtermJs; document.head.appendChild(s);
    }
    if (!window.FitAddon && window.__guraXtermFitJs) {
      const s = document.createElement('script');
      s.textContent = window.__guraXtermFitJs; document.head.appendChild(s);
    }
    if (!window.Terminal) {
      appendMsg('err', 'xterm 资源加载失败，请检查 electron/renderer/vendor/');
      throw new Error('xterm not available');
    }
    xterm = new window.Terminal({
      fontFamily: 'Menlo, Consolas, monospace', fontSize: 12,
      theme: { background: '#000', foreground: '#fff' }, convertEol: true
    });
    fitAddon = new window.FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(document.getElementById('gura-term'));
    setTimeout(() => fitAddon.fit(), 100);
    xterm.onData(d => { if (termSession) window.gura.termWrite(termSession, d); });
    window.addEventListener('resize', () => {
      try { fitAddon.fit(); if (termSession) window.gura.termResize(termSession, xterm.cols, xterm.rows); } catch {}
    });
    window.gura.onTermData(({ sessionId, data }) => {
      if (sessionId === termSession && xterm) xterm.write(data);
    });
    window.gura.onTermExit(({ sessionId, code }) => {
      if (sessionId === termSession && xterm) {
        xterm.write(`\r\n\x1b[33m[已退出，code=${code}]\x1b[0m\r\n`);
        termSession = null;
      }
    });
    return xterm;
  }

  // 初始：默认闲聊模式，CLI 列表懒加载
  refreshCliList();
  // 渲染 mode-bar 初始指示器位置
  if (modeBar) modeBar.classList.add('mode-chat');

  // ----- 对外 API：让 ui.html 的空态引导卡能驱动聊天面板 -----
  window.guraChatPanel = {
    open() {
      panel.classList.add('open');
      toggle.classList.remove('has-update');
      // 打开即收起脉冲（引导完成）
      toggle.classList.remove('onboard-pulse');
      setTimeout(() => input && input.focus(), 50);
    },
    close() { panel.classList.remove('open'); },
    isOpen() { return panel.classList.contains('open'); },
    setMode(m) { return setMode(m); },
    prefill(text) {
      if (!input) return;
      input.value = text;
      // 把光标放到末尾，方便用户继续改
      try { input.setSelectionRange(text.length, text.length); } catch {}
      input.focus();
    },
    // 呼叫注意力：脉冲 chat 按钮
    setPulse(on) {
      if (!toggle) return;
      toggle.classList.toggle('onboard-pulse', !!on);
    }
  };
})();

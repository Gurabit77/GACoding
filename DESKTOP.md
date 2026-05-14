# Gura 桌面版 · 开发与打包说明

> 这是基于 Electron 的 Gura 桌面版本，UI 与原网页版完全一致，并新增了：
> - 启动器（项目选择 + 最近项目）
> - 右侧 AI 对话面板（聊天气泡 + xterm.js 嵌入终端 双模式）
> - 本地 CLI 自动扫描（claude / kiro / codex / cursor-agent / gemini / aider）
> - 手动添加自定义 CLI
> - 选定的 CLI 同时决定聊天和 Builder/Validator 自动化流程

---

## 目录结构

```
项目根/
├── electron/                  ← 桌面版新增（不动原有文件）
│   ├── main.js                Electron 主进程
│   ├── preload.js             contextBridge
│   ├── cli-detector.js        which/where 探测已知 CLI
│   ├── cli-registry.js        读写 ~/.gura/cli-registry.json
│   ├── chat-runner.js         child_process + node-pty
│   ├── package.json           electron / electron-builder / node-pty
│   └── renderer/
│       ├── launcher.html      启动后的项目选择页
│       ├── chat-panel.html    聊天面板 DOM（被注入到 ui.html）
│       ├── chat-panel.css
│       └── chat-panel.js
├── server.mjs                 ← 原文件，被 Electron 子进程启动
├── ui.html                    ← 原文件，被注入聊天面板
├── gura.py                    ← 已修改：读取 ~/.gura/config.json 决定 CLI
└── ...（其余原文件保持不动）
```

用户运行时数据：`~/.gura/`
- `config.json` — `{ "activeCli": "claude" }`
- `cli-registry.json` — 手动添加的 CLI 列表
- `recent-projects.json` — 最近打开的 5 个项目

---

## 开发运行

```bash
cd electron
npm install
npm start          # 启动 Electron 开发态
# 或 npm run dev   # 带 --dev 标记
```

第一次启动会弹出"选择项目目录"界面，选完会：
1. 在该目录启动 `server.mjs`（端口 7334）
2. 加载 `http://localhost:7334/p`
3. 注入聊天面板 + CLI 选择器

---

## 打包成 macOS dmg

```bash
cd electron
npm run dist:mac
```

产物在 `electron/dist/`：
- `Gura-1.0.0-arm64.dmg`（Apple Silicon）
- `Gura-1.0.0.dmg`（Intel）

**关于 Python 依赖**：默认情况下 `gura.py` 依赖系统 Python3。要做到"开箱即用"，用提供的脚本把 gura.py 编译成单文件二进制：

```bash
pip install pyinstaller
cd electron
./scripts/build-gura-engine.sh
# 产物输出到 electron/bin/mac/gura-engine（Mac）或 electron/bin/win/gura-engine.exe（Win）
```

打包好后：
- `main.js` 启动 server.mjs 时会自动检测 `electron/bin/<platform>/gura-engine` 是否存在
- 存在则注入环境变量 `GURA_ENGINE_BIN`，`server.mjs` 优先用二进制
- 不存在则回退到 `python3 gura.py`

要把二进制打进最终 .dmg/.exe，在 `electron/package.json` 的 `build.extraResources` 里加：
```json
{ "from": "bin/${os}", "to": "app/bin" }
```

---

## 打包成 Windows exe

在 Windows 机器或 CI 上：

```bash
cd electron
npm install
npm run dist:win
```

产物：`electron/dist/Gura Setup 1.0.0.exe`（NSIS 安装器）

**Windows 注意点**：
- `node-pty` 在 Win 上需要预编译二进制，npm 装包时会自动下载
- `which` 命令在 Win 上是 `where`，`cli-detector.js` 已做兼容
- 默认 shell 是 PowerShell

---

## 新功能使用

### 顶部 AI 对话面板

1. 启动后右下角有一个 💬 圆形按钮，点开抽出对话面板
2. 顶部下拉框列出所有检测到的 CLI（带 ⚙ 的是手动添加的）
3. 点 `＋` 添加自定义 CLI：
   - 名称：任意
   - 路径：可执行文件绝对路径（有"浏览…"按钮）
   - 调用模板：一行一个参数，`{prompt}` 是占位符
     - 例：`-p` 一行，`{prompt}` 一行
4. 点 `↻` 重新扫描 PATH

### 切换聊天 / 终端模式

- **聊天模式**（默认）：输入 → 调用 `cli -p "..."` → 流式渲染消息气泡
- **终端模式**：点"终端"按钮，启动 PTY 嵌入式终端，完整 TUI 体验

### CLI 决定自动化流程

下拉里选的 CLI 会同时作用于 Builder/Validator 循环：
- 选择写入 `~/.gura/config.json`
- `gura.py` 启动时读取它（不传 argv 时）
- 若选的是自定义 CLI，`gura.py` 会从 `~/.gura/cli-registry.json` 拿到 chatTemplate

---

## 已知 TODO

- [x] ~~PyInstaller 把 gura.py 打成二进制，去掉系统 Python 依赖~~（脚本已提供：`electron/scripts/build-gura-engine.sh`）
- [x] ~~xterm.js 改成本地资源（目前是 CDN）~~（已下载到 `electron/renderer/vendor/`，由主进程内联注入）
- [ ] 代码签名 + 公证（macOS notarization, Win Authenticode）
- [ ] 自动更新（electron-updater）
- [ ] 聊天历史持久化到 ~/.gura/chat-history/
- [ ] markdown 渲染（目前是纯文本气泡）

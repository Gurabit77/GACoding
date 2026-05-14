---
name: pi-agent-tasklist
description: "Gura — AI 自动化 Coding 系统。需求拆分 → Builder+Validator 自动循环 → 星露谷风格实时面板。触发词：gura, 自动化coding, 自动开发"
version: 3.0.0
tags: [gura, automation, coding, progress, visualization]
triggers: [gura, 自动化coding, 自动开发, 进度, 面板]
---

# Gura — AI 自动化 Coding 系统

## 完整流程

```
用户描述需求 → prd skill 提问澄清 → 生成 PRD
→ gura skill 转成 prd.json（拆分小 story）
→ 用户审核确认
→ gura.sh 一键启动
→ Builder 写代码 → Validator 验证 → 循环直到全部完成
→ 面板实时看进度
```

## 一键启动

```bash
./gura.sh /你的项目路径
```

前提：项目里有 `scripts/gura/prd.json`

## 分步使用

### 1. 生成 PRD（prd skill）
告诉 AI 你的需求，它会提问澄清后生成 PRD 文档到 `tasks/prd-xxx.md`

### 2. 转成 prd.json（gura skill）
把 PRD 转成 Gura 可执行的 JSON 格式，保存到 `scripts/gura/prd.json`

### 3. 一键启动
```bash
./gura.sh /你的项目路径
```

## 面板功能
- 星露谷四季背景 + 天气粒子（齿轮设置）
- 16 个动漫角色代表每个 story
- 实时状态：DEVELOPING → VALIDATING → IDLE
- 验收标准、Validator 反馈、重试次数、blocked 状态
- progress.txt 实时日志
- 迭代计数器 + 耗时

## Commands
- `/prime` — 分析项目结构，建立代码库理解
- `/plan-feature <功能>` — 深度功能规划
- `/create-rules` — 生成 AGENTS.md 全局规则

## 文件结构
```
GuraAICoding/
├── gura.sh              # 一键启动
├── gura.py              # 执行引擎（Builder+Validator 循环）
├── BUILDER.md           # Builder Agent 指令
├── VALIDATOR.md         # Validator Agent 指令
├── server.mjs           # HTTP 服务器 + SSE
├── cli.mjs              # 命令行工具
├── ui.html              # 星露谷风格面板
├── skills/
│   ├── prd/SKILL.md     # 需求→PRD
│   ├── gura/SKILL.md    # PRD→prd.json
│   ├── gura/scripts/repair_prd_json.py
│   └── agent-browser/SKILL.md
├── commands/            # prime/plan-feature/create-rules
├── avatars/             # 16 个角色像素画
└── backgrounds/         # 8 张四季背景图
```

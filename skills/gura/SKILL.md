---
name: gura
description: "将 PRD 转换为 prd.json 格式，供 Gura 自主 agent 系统使用。触发词：将prd转成prd.json, 转prd.json"
---

# Gura PRD Converter

将 PRD 转换为 Gura 可执行的 prd.json 格式，并自动准备项目环境。

---

## 工作流程

### 1. 读取 PRD

获取 PRD（从 `tasks/prd-*.md` 文件或用户提供的文本）。

### 2. 自动创建项目结构

如果项目目录不存在或未初始化：
- 创建项目目录
- `git init` + 初始 commit（`chore: initial project setup`）
- 创建 `scripts/gura/` 目录

如果项目已存在但没有 `scripts/gura/`：
- 只创建 `scripts/gura/` 目录

### 3. 转换为 prd.json

保存到 `项目根目录/scripts/gura/prd.json`：

```json
{
  "project": "项目名称",
  "branchName": "gura/feature-name",
  "userStories": [
    {
      "id": "US-001",
      "title": "Story 标题",
      "description": "作为...我需要...",
      "acceptanceCriteria": ["验收标准1", "验收标准2"],
      "references": ["参考链接或资料"],
      "priority": 1,
      "passes": false,
      "notes": "",
      "retryCount": 0,
      "blocked": false
    }
  ]
}
```

### 4. 转换规则

- 每个 User Story 对应一个 JSON 对象
- priority 按 PRD 中的顺序递增（1, 2, 3...）
- acceptanceCriteria 从 PRD 的 Acceptance Criteria 逐条提取
- references 从 PRD 中提取该 story 相关的参考链接、设计参考、技术文档
- branchName 格式：`gura/` + 项目名的 kebab-case
- passes、notes、retryCount、blocked 初始化为默认值

### 5. 自动衔接启动

转换完成后：
1. 告诉用户 prd.json 已生成，显示 story 数量
2. 问用户：「要启动 Gura 自动开发吗？选择 Agent：Claude / Kiro / Codex」
3. 用户确认后执行：`./gura.sh 项目路径`

---

**注意：** 如果 prd.json 已存在，先备份为 prd.json.bak 再覆盖。

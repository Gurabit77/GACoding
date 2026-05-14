# Gura 最终整体验证指令

你是最终验证 Agent。所有 User Story 已单独完成并通过各自的验证。你的职责是进行**整体回归测试**，确保所有功能组合在一起仍然正常工作。

## 你的任务

### 1. 读取项目状态

- 读取 `scripts/gura/prd.json`，了解所有已完成的 story
- 读取 `scripts/gura/progress.txt`，了解实现细节

### 2. 运行全量质量检查

按顺序执行，任何一步失败都记录但继续：

```
1. Typecheck: npm run typecheck 或 tsc --noEmit
2. Lint: npm run lint（如果有）
3. 全量测试: npm test（如果有）
4. Build: npm run build（如果有）
```

### 3. 回归验证

检查每个已通过的 story 是否仍然正常：

- 逐个检查 prd.json 中 `passes: true` 的 story
- 对每个 story 的关键验收标准做快速验证
- 重点关注：后面的 story 是否破坏了前面 story 的功能

### 4. 端到端流程验证

如果项目有 UI（检查是否有 agent-browser 可用）：

- 启动开发服务器（复用已有的，不要重复启动）
- 用 agent-browser 走一遍完整用户流程
- 截图保存到 `screenshots/final-validation/`

### 5. 输出报告

在 `scripts/gura/progress.txt` 末尾追加：

```
## 最终整体验证 - [日期时间]
### 质量检查
- Typecheck: ✅/❌
- Lint: ✅/❌
- Tests: ✅/❌
- Build: ✅/❌

### 回归验证
- US-001: ✅ 仍然正常
- US-002: ✅ 仍然正常
- US-003: ❌ [具体问题]

### 端到端验证
- [流程描述]: ✅/❌

### 结论
[整体评估：全部通过 / 存在问题需要修复]
---
```

## 重要约束

- 你只负责验证和报告，不修复代码
- 如果发现回归问题，详细记录但不要修改 prd.json 的 passes 状态
- 浏览器验证时复用已有服务，不要随意 kill 进程

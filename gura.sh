#!/usr/bin/env bash
# Gura 一键启动
# 用法: gura [项目路径] [--agent codex]
# 默认项目路径为当前目录

set -e
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${1:-$(pwd)}"
AGENT="${3:-claude}"
PORT=7334
PRD="$PROJECT/scripts/gura/prd.json"

echo -e "\033[36m⬡ Gura\033[0m"
echo "  项目: $PROJECT"

# 检查 prd.json
if [ ! -f "$PRD" ]; then
  echo -e "\033[31m❌ 未找到 $PRD\033[0m"
  echo "  请先用 prd skill 生成 prd.json，或手动放到 scripts/gura/ 下"
  exit 1
fi

# 杀旧进程
lsof -ti:$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 0.5

# 启动 Gura 服务器
nohup node "$SKILL_DIR/server.mjs" --project "$PROJECT" --port $PORT > /tmp/gura.log 2>&1 &
PI_PID=$!
sleep 1

if ! kill -0 $PI_PID 2>/dev/null; then
  echo -e "\033[31m❌ Gura 服务器启动失败\033[0m"
  cat /tmp/gura.log
  exit 1
fi

echo "  面板: http://localhost:$PORT/p"

# 同步 prd.json 到面板
curl -s -X POST "http://127.0.0.1:$PORT/api/gura/sync" > /dev/null
echo "  同步: $(python3 -c "import json;d=json.load(open('$PRD'));print(len(d.get('userStories',[])))" 2>/dev/null || echo '?') 个 story"

# 打开浏览器
open "http://localhost:$PORT/p" 2>/dev/null || true

# 启动 Gura 执行引擎
echo -e "\033[36m  启动 Gura...\033[0m"
echo ""
python3 "$SKILL_DIR/gura.py" $AGENT

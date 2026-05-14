#!/usr/bin/env bash
# 用 PyInstaller 把 gura.py 编译成单文件二进制
# 产物：electron/bin/<platform>/gura-engine[.exe]
set -e

cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$PLATFORM" in
  darwin*) OUTDIR="bin/mac" ;;
  linux*) OUTDIR="bin/linux" ;;
  mingw*|msys*|cygwin*) OUTDIR="bin/win" ;;
  *) OUTDIR="bin/$PLATFORM" ;;
esac

mkdir -p "$OUTDIR"

# 检查 pyinstaller
if ! command -v pyinstaller &> /dev/null; then
  echo "❌ pyinstaller 未安装，请先：pip install pyinstaller"
  exit 1
fi

echo "→ 用 PyInstaller 打包 $ROOT/gura.py"
pyinstaller \
  --onefile \
  --name gura-engine \
  --distpath "$OUTDIR" \
  --workpath "/tmp/gura-pyi-build" \
  --specpath "/tmp/gura-pyi-spec" \
  --clean \
  "$ROOT/gura.py"

echo "✅ 输出: $(pwd)/$OUTDIR/gura-engine"
ls -lh "$OUTDIR/"

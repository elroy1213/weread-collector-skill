#!/usr/bin/env bash
# 小白一键入口：启动「采集专用 Chrome」并引导登录微信读书。
# 用法：  ./scripts/start-chrome.sh
# 做什么：先检查环境（Node、Chrome），再起一个独立的 Chrome（不影响你日常用的那个），
#         打开微信读书，引导你扫码登录。支持 macOS / Linux / Windows(Git Bash)。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDP_PORT="${WEREAD_CDP_PORT:-9222}"
CDP_URL="${WEREAD_CDP_URL:-http://127.0.0.1:${CDP_PORT}}"
# 采集专用 Chrome 的数据目录：放在用户主目录，不进项目、不污染日常 Chrome，登录态会一直保留
PROFILE_DIR="${WEREAD_CHROME_PROFILE:-$HOME/.weread-collector/chrome-profile}"
OS="$(uname -s 2>/dev/null || echo Unknown)"

echo "────────────────────────────────────────"
echo "  微信读书公众号采集 · 第一步：启动并登录"
echo "────────────────────────────────────────"

# ── 第 0 步：先检查 Node.js（后面所有脚本都靠它）──
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没检测到 Node.js，但本项目所有脚本都靠它运行。"
  echo ""
  echo "👉 请先安装 Node.js（版本要 ≥ 20）："
  echo "     · 任何系统：去官网 https://nodejs.org/ 下载 LTS 版，一路「下一步」装完"
  echo "     · Mac：也可以运行  brew install node"
  echo ""
  echo "   装完后【关掉这个终端重新打开】，再运行本命令。"
  exit 1
fi
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  echo "⚠️  你的 Node.js 版本是 $(node -v)，太旧了（需要 ≥ 20）。请先升级再试。"
  exit 1
fi
echo "✅ Node.js 已就绪（$(node -v)）"

# ── 第 1 步：找到 Chrome（跨平台）──
CHROME_BIN=""
if [ -n "${WEREAD_CHROME_APP:-}" ]; then
  CHROME_BIN="$WEREAD_CHROME_APP"
else
  case "$OS" in
    Darwin)
      [ -d "/Applications/Google Chrome.app" ] && CHROME_BIN="/Applications/Google Chrome.app"
      ;;
    Linux)
      for c in google-chrome google-chrome-stable chromium chromium-browser chrome; do
        if command -v "$c" >/dev/null 2>&1; then CHROME_BIN="$c"; break; fi
      done
      ;;
    MINGW*|CYGWIN*|MSYS*|Windows_NT)
      for p in "/c/Program Files/Google/Chrome/Application/chrome.exe" \
               "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
               "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"; do
        if [ -f "$p" ]; then CHROME_BIN="$p"; break; fi
      done
      ;;
  esac
fi
if [ -z "$CHROME_BIN" ]; then
  echo "❌ 没找到 Chrome 浏览器（当前系统：$OS）。"
  echo "👉 请先安装 Google Chrome：https://www.google.com/chrome/"
  echo "   如果已装但找不到，设置环境变量 WEREAD_CHROME_APP 指向它再试。"
  exit 1
fi
echo "✅ 找到 Chrome"

# ── 第 2 步：启动采集专用 Chrome（已在跑则复用；没有则用 playwright 起独立实例）──
if curl -fsS --max-time 3 "${CDP_URL}/json/version" >/dev/null 2>&1; then
  echo "✅ 采集专用 Chrome 已经在运行。"
else
  echo "🚀 正在启动采集专用 Chrome（独立窗口，不影响你日常浏览器）..."
  mkdir -p "$PROFILE_DIR"
  # 用 playwright launchPersistentContext 起独立 Chrome：调试端口一定生效，
  # 不受你日常 Chrome 是否在运行的影响（macOS 单实例机制会让 open/直接调二进制的调试端口失效）。
  nohup node "$SCRIPT_DIR/launch-chrome.js" > "$PROFILE_DIR/launch.log" 2>&1 &
  disown  # 关键：让 launch 进程脱离本脚本，否则脚本结束（尤其 exec 时）会把它和 Chrome 一起杀掉
  ok=0
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 1 "${CDP_URL}/json/version" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then
    echo "❌ 采集 Chrome 启动超时（40 秒）。最近日志："
    tail -6 "$PROFILE_DIR/launch.log" 2>/dev/null
    exit 1
  fi
  echo "✅ Chrome 已启动。"
fi

# ── 第 3 步：检测 / 引导登录（交给 node 脚本，输出友好提示）──
node "$SCRIPT_DIR/check-login.js"

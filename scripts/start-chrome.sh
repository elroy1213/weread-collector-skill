#!/usr/bin/env bash
# 小白一键入口：启动「采集专用 Chrome」并引导登录微信读书。
# 用法：  ./scripts/start-chrome.sh
# 做什么：起一个独立的 Chrome（不影响你日常用的那个），打开微信读书，引导你扫码登录。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDP_PORT="${WEREAD_CDP_PORT:-9222}"
CDP_URL="${WEREAD_CDP_URL:-http://127.0.0.1:${CDP_PORT}}"
# 采集专用 Chrome 的数据目录：放在用户主目录，不进项目、不污染日常 Chrome，登录态会一直保留
PROFILE_DIR="${WEREAD_CHROME_PROFILE:-$HOME/.weread-collector/chrome-profile}"
CHROME_APP="${WEREAD_CHROME_APP:-/Applications/Google Chrome.app}"

echo "────────────────────────────────────────"
echo "  微信读书公众号采集 · 第一步：启动并登录"
echo "────────────────────────────────────────"

# 0. 检查 Chrome 是否安装
if [ ! -d "$CHROME_APP" ]; then
  echo "❌ 没找到 Chrome 浏览器（路径：$CHROME_APP）"
  echo "👉 请先安装 Google Chrome，或设置环境变量 WEREAD_CHROME_APP 指向你的 Chrome。"
  exit 1
fi

# 1. 如果采集 Chrome 已经在跑，直接复用
if curl -fsS --max-time 3 "${CDP_URL}/json/version" >/dev/null 2>&1; then
  echo "✅ 采集专用 Chrome 已经在运行。"
else
  echo "🚀 正在启动采集专用 Chrome（会弹出一个新的 Chrome 窗口）..."
  mkdir -p "$PROFILE_DIR"
  open -na "$CHROME_APP" --args \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="${CDP_PORT}" \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "https://weread.qq.com/" >/dev/null 2>&1
  # 等待它就绪（最多 30 秒）
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 1 "${CDP_URL}/json/version" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then
    echo "❌ Chrome 启动超时。请手动打开 Chrome 后重试。"
    exit 1
  fi
  echo "✅ Chrome 已启动。"
fi

# 2. 检测 / 引导登录（交给 node 脚本，输出友好提示）
NODE_BIN="${NODE_BIN:-node}"
exec "$NODE_BIN" "$SCRIPT_DIR/check-login.js"

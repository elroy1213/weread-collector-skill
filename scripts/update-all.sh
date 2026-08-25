#!/bin/bash
# 一键增量更新：扫码登录后跑这一条，全自动完成
#   1. 检查登录态（失效则提示扫码并等待）
#   2. discover 重跑：新关注的公众号自动 merge 进 registry（sources.json）
#   3. 逐源增量抓取新文章（mp 公开页路径，含 ~→_ 修复 + 图片拦截 + 断点续传）
#   4. 汇总报告（每源新增/失败）
#
# 用法: ./scripts/update-all.sh [--source=公众号名] [--limit=N]
#   不带参数：更新 registry 里全部源
#   --source=海外独角兽：只更新指定源
#   --limit=N：每源最多新抓 N 篇（默认不限）
#
# 新用户注意：第一次用还没有 sources.json 时，本脚本第 2 步会自动生成它
# （发现你微信读书里全部公众号并整理成清单）。
set -e
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

# 仓库根目录（脚本在 scripts/ 下）
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCES_JSON="$REPO_DIR/sources.json"
CDP_PORT="${WEREAD_CDP_PORT:-9222}"
PY=python3

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  微信读书公众号 · 一键增量更新"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 0: 确保采集 Chrome 在跑 ──
if ! curl --noproxy "*" -fsS --max-time 2 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo ""
  echo "🚀 [0/4] 启动采集专用 Chrome..."
  cd "$REPO_DIR"
  WEREAD_CDP_PORT=$CDP_PORT nohup node scripts/launch-chrome.js > /tmp/weread-launch.log 2>&1 &
  for i in $(seq 1 30); do
    curl --noproxy "*" -fsS --max-time 1 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 && { echo "✅ Chrome 就绪（第${i}秒）"; break; }
    sleep 1
    [ "$i" = "30" ] && { echo "❌ Chrome 启动失败，看日志 /tmp/weread-launch.log"; exit 1; }
  done
else
  echo "✅ [0/4] Chrome 已在运行"
fi

# ── Step 1: 登录态检查（API 探活，不看页面渲染）──
echo ""
echo "🔐 [1/4] 检查微信读书登录态..."
cd "$REPO_DIR"
if node scripts/check-login.js 2>&1 | grep -q "已登录"; then
  echo "✅ 已登录"
else
  echo "⚠️  登录态失效，请按提示扫码（脚本会等你）"
  node scripts/check-login.js || { echo "❌ 登录超时，请重跑本命令"; exit 1; }
fi

# ── Step 2: discover 合并新增公众号（新用户首次跑会生成 sources.json）──
echo ""
echo "🔍 [2/4] 发现你的公众号（新增自动合并进清单）..."
if [ -f "$SOURCES_JSON" ]; then
  BEFORE=$($PY -c "import json;print(len(json.load(open('$SOURCES_JSON')).get('sources',[])))" 2>/dev/null || echo 0)
else
  BEFORE=0
  echo "  （首次使用：还没有清单，这一步会为你生成 sources.json）"
fi
node scripts/discover_sources_cdp.js --config="$SOURCES_JSON" 2>&1 | tail -3 || echo "⚠️ discover 未成功，继续使用现有清单"
AFTER=$($PY -c "import json;print(len(json.load(open('$SOURCES_JSON')).get('sources',[])))" 2>/dev/null || echo 0)
echo "✅ 公众号清单: $BEFORE → $AFTER 个源（新增 $((AFTER-BEFORE)) 个）"

# ── Step 3: 逐源增量抓取 ──
echo ""
echo "📥 [3/4] 逐源增量抓取新文章..."
node scripts/update-sources.js --config="$SOURCES_JSON" "$@" 2>&1 | tee /tmp/weread-update.log

# ── Step 4: 汇总 ──
echo ""
echo "📊 [4/4] 完成。日志: /tmp/weread-update.log"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

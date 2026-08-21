#!/usr/bin/env node
// 登录检测 + 扫码引导（小白友好版）。
// 连上采集专用 Chrome，检查微信读书是否登录；未登录则清晰引导扫码并等待。
const { loadPlaywright } = require("./resolve_playwright");
const { chromium } = loadPlaywright();

const CDP_URL = process.env.WEREAD_CDP_URL || "http://127.0.0.1:9222";
const WAIT_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(page, endpoint) {
  return page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: "include" });
    const t = await r.text();
    let p;
    try { p = JSON.parse(t); } catch { p = { parseError: true }; }
    return { httpOk: r.ok, payload: p };
  }, endpoint);
}

async function isLoggedIn(page) {
  const shelf = await fetchJson(page, "/web/shelf/sync?synckey=0&teenmode=0&album=1");
  return shelf.payload.errCode !== -2010;
}

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    // 区分「完全没启动」和「端口有响应但连不上（Chrome 状态异常）」，给不同的下一步。
    let portAlive = false;
    try {
      const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2500) });
      portAlive = r.ok;
    } catch (_) {}
    if (portAlive) {
      console.log("❌ 调试端口有响应，但连不上这个 Chrome（它的状态可能异常了）。");
      console.log("👉 解决办法：把这个采集 Chrome 完全关掉，再运行 ./scripts/start-chrome.sh 重启一个。");
    } else {
      console.log("❌ 没找到正在运行的采集专用 Chrome。");
      console.log("👉 解决办法：先运行 ./scripts/start-chrome.sh 启动它。");
    }
    process.exit(2);
  }
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("no-context");
    const page = context.pages().find((p) => p.url().startsWith("https://weread.qq.com/")) || (await context.newPage());
    await page.goto("https://weread.qq.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);

    if (await isLoggedIn(page)) {
      console.log("✅ 微信读书已登录，可以开始抓取了。");
      return;
    }

    console.log("🔑 还没登录微信读书。");
    console.log("👉 请切换到刚打开的 Chrome 窗口，用【微信扫码】登录。");
    console.log("   我会在这里等你，登录成功会自动继续（最多等 5 分钟）...");
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (await isLoggedIn(page)) {
        console.log("✅ 登录成功！现在可以开始抓取了。");
        return;
      }
    }
    console.log("❌ 等了 5 分钟还没登录成功。请重新运行本命令再试一次。");
    process.exit(3);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.log("❌ 出错了：" + String(e.message || e));
  process.exit(1);
});

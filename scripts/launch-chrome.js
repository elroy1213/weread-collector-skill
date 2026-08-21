#!/usr/bin/env node
// 后台常驻：用 playwright launchPersistentContext 启动「采集专用 Chrome」。
// 为什么用这种方式而不是 open/直接调二进制？
//   macOS 的 Chrome 是单实例机制——只要已有一个 Chrome 在跑，新启动的 Chrome 的
//   --remote-debugging-port 不会生效。launchPersistentContext 由 playwright 自己管理进程，
//   能起真正独立的实例，调试端口一定生效，完全不受你日常 Chrome 是否在运行的影响。
// 登录态存在 PROFILE_DIR，下次启动自动保留，不用重新扫码。
const os = require("node:os");
const path = require("node:path");
const { loadPlaywright } = require("./resolve_playwright");
const { chromium } = loadPlaywright();

const CDP_PORT = process.env.WEREAD_CDP_PORT || "9222";
const PROFILE_DIR = process.env.WEREAD_CHROME_PROFILE || path.join(os.homedir(), ".weread-collector", "chrome-profile");

const COMMON_ARGS = [
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${CDP_PORT}`,
  "--no-first-run",
  "--no-default-browser-check",
];

async function launch() {
  // 优先用系统 Chrome（体验和你日常用的一致）；没有则回退到 playwright 内置浏览器。
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      args: COMMON_ARGS,
    });
  } catch (e) {
    console.log("⚠️  没找到系统 Chrome，改用内置浏览器（chromium）...");
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: COMMON_ARGS,
    });
  }
}

(async () => {
  const context = await launch();
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://weread.qq.com/").catch(() => {});
  console.log(`✅ 采集专用 Chrome 已启动（调试端口 ${CDP_PORT}）`);
  console.log(`   登录数据保存在：${PROFILE_DIR}`);
  // 常驻，持有这个 Chrome；采集脚本会通过调试端口连上它。
  await new Promise(() => {});
})().catch((e) => {
  const msg = String(e.message || e).split("\n")[0];
  console.error("❌ 启动采集 Chrome 失败：" + msg);
  if (/Executable doesn't exist|browserType.launch/i.test(String(e.message || e))) {
    console.error("👉 内置浏览器还没下载。请在项目目录运行：npx playwright install chromium");
  }
  process.exit(1);
});

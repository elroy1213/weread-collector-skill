#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { loadPlaywright } = require("./resolve_playwright");
const { chromium } = loadPlaywright();

const CDP_URL = process.env.WEREAD_CDP_URL || "http://127.0.0.1:9222";
const CONFIG_PATH = path.resolve(process.argv.find((item) => item.startsWith("--config="))?.slice(9) || "outputs/sources.json");
const DRY_RUN = process.argv.includes("--dry-run");

function parseBookId(readerUrl) {
  const pathname = new URL(readerUrl).pathname;
  const marker = "5758535f";
  const start = pathname.indexOf(marker);
  if (start < 0) return null;
  const run = pathname.slice(start + marker.length);
  let length = 0;
  while (/^3[0-9]$/.test(run.slice(length, length + 2))) length += 2;
  return length ? `MP_WXS_${Buffer.from(run.slice(0, length), "hex").toString("ascii")}` : null;
}

async function collectReaderLinks(page) {
  let stablePasses = 0;
  let previousCount = 0;
  const found = new Map();
  for (let pass = 0; pass < 24 && stablePasses < 3; pass += 1) {
    await page.waitForTimeout(700);
    const links = await page.locator('a[href*="/web/mp/reader/"]').evaluateAll((elements) => elements.map((element) => ({
      name: element.querySelector(".title")?.getAttribute("title") || (element.innerText || "").trim(),
      readerUrl: element.href,
    })));
    for (const link of links) found.set(link.readerUrl, link);
    if (found.size === previousCount) stablePasses += 1;
    else stablePasses = 0;
    previousCount = found.size;
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight || 800, 700)));
  }
  return [...found.values()];
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP Chrome 没有可用的浏览器上下文");
    const page = context.pages().find((candidate) => candidate.url().startsWith("https://weread.qq.com/")) || await context.newPage();
    await page.goto("https://weread.qq.com/web/shelf", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const archive = page.locator("a.shelfArchive, a[href*='/web/shelf/archive/']").first();
    if (!(await archive.count())) {
      console.error(JSON.stringify({
        ok: false,
        reasonCode: "archive_navigation_not_found",
        message: "未找到完整项目库/归档入口；为避免把首页小书架误当成全部来源，未修改 sources.json。",
        configPath: CONFIG_PATH,
      }, null, 2));
      process.exitCode = 5;
      return;
    }
    await archive.click();
    await page.waitForTimeout(1200);
    const archiveUrl = await page.url();
    const discovered = await collectReaderLinks(page);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const configExists = fs.existsSync(CONFIG_PATH);
    const previous = configExists ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : { version: 2, timeZone: "Asia/Shanghai" };
    if (!discovered.length) {
      const loginRequired = /登录|扫码|微信登录|login/i.test(bodyText);
      console.error(JSON.stringify({
        ok: false,
        reasonCode: loginRequired ? "login_required" : "no_sources_found",
        message: loginRequired ? "微信读书尚未登录，请先在此 Chrome 中扫码登录。" : "未发现公众号 reader 链接，未修改现有 sources.json。",
        configPath: CONFIG_PATH,
        existingSourceCount: Array.isArray(previous.sources) ? previous.sources.length : 0,
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    const sources = discovered.map((source) => ({ ...source, type: "wechat_official_account", collection: "项目库", bookId: parseBookId(source.readerUrl), latestUpdateAt: null, latestUpdateStatus: "pending_reader_refresh" }));
    const invalidBookIds = sources.filter((source) => !source.bookId).map((source) => ({ name: source.name, readerUrl: source.readerUrl }));
    if (invalidBookIds.length) {
      console.error(JSON.stringify({
        ok: false,
        reasonCode: "invalid_book_ids",
        message: "发现了 reader 链接，但无法按当前规则解析 Book ID；未修改 sources.json。",
        configPath: CONFIG_PATH,
        invalidBookIds,
      }, null, 2));
      process.exitCode = 4;
      return;
    }
    const oldById = new Map((previous.sources || []).map((source) => [source.bookId, source]));
    const discoveredById = new Map(sources.map((source) => [source.bookId, source]));
    for (const source of previous.sources || []) {
      if (!discoveredById.has(source.bookId) && source.collection !== "项目库") discoveredById.set(source.bookId, source);
    }
    const merged = [...discoveredById.values()].map((source) => ({ ...source, latestUpdateAt: oldById.get(source.bookId)?.latestUpdateAt || source.latestUpdateAt || null, latestUpdateStatus: oldById.get(source.bookId)?.latestUpdateAt || source.latestUpdateAt ? "verified" : "pending_reader_refresh" }));
    if (configExists && Array.isArray(previous.sources) && previous.sources.length > merged.length) {
      console.error(JSON.stringify({
        ok: false,
        reasonCode: "discovery_shrank",
        message: `本次发现 ${merged.length} 个来源，少于现有 ${previous.sources.length} 个；为避免渲染失败导致误删，未修改 sources.json。`,
        configPath: CONFIG_PATH,
        discoveredCount: merged.length,
        existingSourceCount: previous.sources.length,
      }, null, 2));
      process.exitCode = 3;
      return;
    }
    const nextConfig = {
      ...previous,
      generatedAt: new Date().toISOString(),
      sources: merged,
      discovery: {
        ...(previous.discovery || {}),
        archiveUrl,
        discoveredAt: new Date().toISOString(),
        discoveredCount: discovered.length,
        invalidBookIds: [],
        projectLibraryCount: merged.length,
        accountCount: merged.length,
      },
    };
    if (configExists) fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
    if (DRY_RUN) {
      console.log(JSON.stringify({
        ok: true,
        dryRun: true,
        archiveUrl,
        discoveredCount: discovered.length,
        sources: merged.map(({ name, bookId, readerUrl }) => ({ name, bookId, readerUrl })),
      }, null, 2));
      return;
    }
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(nextConfig, null, 2) + "\n");
    fs.renameSync(temporary, CONFIG_PATH);
    fs.chmodSync(CONFIG_PATH, 0o600);
    console.log(JSON.stringify({ ok: true, configPath: CONFIG_PATH, discoveredCount: merged.length, invalidBookIds: [] }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.stack || error) }, null, 2));
  process.exitCode = 1;
});

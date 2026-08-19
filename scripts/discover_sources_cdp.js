#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { loadPlaywright } = require("./resolve_playwright");
const { chromium } = loadPlaywright();

const CDP_URL = process.env.WEREAD_CDP_URL || "http://127.0.0.1:9222";
const CONFIG_PATH = path.resolve(process.argv.find((item) => item.startsWith("--config="))?.slice(9) || "outputs/sources.json");

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

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP Chrome 没有可用的浏览器上下文");
    const page = context.pages().find((candidate) => candidate.url().startsWith("https://weread.qq.com/")) || await context.newPage();
    await page.goto("https://weread.qq.com/web/shelf", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);
    const archive = page.locator("a.shelfArchive").first();
    if (await archive.count()) {
      await archive.click();
      await page.waitForTimeout(600);
    }
    const discovered = await page.locator('a[href*="/web/mp/reader/"]').evaluateAll((elements) => elements.map((element) => ({
      name: element.querySelector(".title")?.getAttribute("title") || (element.innerText || "").trim(),
      readerUrl: element.href,
    })));
    const sources = discovered.map((source) => ({ ...source, type: "wechat_official_account", collection: "项目库", bookId: parseBookId(source.readerUrl), latestUpdateAt: null, latestUpdateStatus: "pending_reader_refresh" }));
    const previous = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : { version: 2, timeZone: "Asia/Shanghai" };
    const oldById = new Map((previous.sources || []).map((source) => [source.bookId, source]));
    const discoveredById = new Map(sources.map((source) => [source.bookId, source]));
    for (const source of previous.sources || []) {
      if (!discoveredById.has(source.bookId) && source.collection !== "项目库") discoveredById.set(source.bookId, source);
    }
    const merged = [...discoveredById.values()].map((source) => ({ ...source, latestUpdateAt: oldById.get(source.bookId)?.latestUpdateAt || source.latestUpdateAt || null, latestUpdateStatus: oldById.get(source.bookId)?.latestUpdateAt || source.latestUpdateAt ? "verified" : "pending_reader_refresh" }));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...previous, generatedAt: new Date().toISOString(), sources: merged, discovery: { ...(previous.discovery || {}), projectLibraryCount: merged.length, accountCount: merged.length } }, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, configPath: CONFIG_PATH, discoveredCount: merged.length, invalidBookIds: merged.filter((source) => !source.bookId).map((source) => source.name) }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.stack || error) }, null, 2));
  process.exitCode = 1;
});

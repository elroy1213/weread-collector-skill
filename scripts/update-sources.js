#!/usr/bin/env node
// 逐源增量抓取核心：对 registry 里每个源
//   1. 调 mp/articles 索引拿最新文章列表（接口失效则明确标记）
//   2. 对比该源已有输出（断点续传，已抓的 id 跳过）
//   3. 新文章走 mp.weixin.qq.com/s/<id> 公开页抓正文（~→_ 修复 + 图片拦截）
//   4. 更新源 latestUpdateAt 游标；失败三分类进清单
const fs = require("node:fs");
const path = require("node:path");

const CDP_HTTP = process.env.WEREAD_CDP_URL || "http://127.0.0.1:9222";
// 输出目录：默认 <仓库根>/outputs（可用 WEREAD_DATA_DIR 覆盖）
const DATA_DIR = process.env.WEREAD_DATA_DIR || path.join(__dirname, "..", "outputs");
const NAV_TIMEOUT_MS = 25000;
const INTERVAL_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const p = `--${name}=`;
  const v = process.argv.find((x) => x.startsWith(p));
  return v == null ? fallback : v.slice(p.length);
}
const CONFIG = arg("config", path.join(__dirname, "..", "sources.json"));
const ONLY_SOURCE = arg("source", "");
const LIMIT = parseInt(arg("limit", "0"), 10);
const slugify = (name) => name.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const safeName = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "_");

async function connect() {
  const r = await fetch(CDP_HTTP + "/json");
  const tabs = await r.json();
  let page = tabs.find((t) => t.type === "page" && t.url.includes("weread.qq.com") && !t.url.includes("mp/reader"));
  if (!page) page = tabs.find((t) => t.type === "page" && !t.url.includes("mp.weixin.qq.com"));
  if (!page) page = tabs.find((t) => t.type === "page");
  if (!page) throw new Error("没有可用页面");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws error")); });
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["*qpic.cn*", "*mmbiz.qpic.cn*", "*wx_fmt*", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"] });
  return { send, close: () => ws.close() };
}

const EXTRACT = `(()=>{const c=document.querySelector('#js_content');const t=document.querySelector('#activity-name');const acct=document.querySelector('#js_name');const pt=document.querySelector('#publish_time');const imgs=c?[...c.querySelectorAll('img')].map(i=>i.getAttribute('data-src')||i.getAttribute('src')||'').filter(Boolean):[];return {title:t?t.innerText.trim():document.title,account:acct?acct.innerText.trim():'',publishTime:pt?pt.innerText.trim():'',contentText:c?c.innerText.trim():'',imageUrls:[...new Set(imgs)]};})()`;

// 调 mp/articles 索引（需登录态；失效返回 null）
async function indexArticles(cdp, bookId, maxPages = 20) {
  const all = new Map();
  for (let offset = 0; offset < maxPages * 10; offset += 10) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async()=>{const r=await fetch('/web/mp/articles?bookId=${bookId}&offset=${offset}',{credentials:'include'});return await r.json();})()`,
      awaitPromise: true, returnByValue: true,
    });
    const j = r.result.value;
    if (!j || j.errCode) return { error: `errCode ${j && j.errCode}`, articles: [...all.values()] };
    const reviews = j.reviews || [];
    if (!reviews.length) break;
    for (const rv of reviews) {
      const subs = rv.subReviews && rv.subReviews.length ? rv.subReviews : [rv];
      for (const s of subs) {
        const mp = (s.review && s.review.mpInfo) || {};
        const id = mp.originalId || s.reviewId;
        if (!id || !mp.title) continue;
        if (!all.has(id)) all.set(id, { id, title: mp.title, publishedAt: Number((s.review && s.review.createTime) || rv.createTime || 0) });
      }
    }
    if (reviews.length < 10) break;
  }
  return { articles: [...all.values()] };
}

async function fetchOne(cdp, a) {
  const url = `https://mp.weixin.qq.com/s/${a.id.replace(/~/g, "_")}`;
  await cdp.send("Page.navigate", { url });
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(900);
    const r = await cdp.send("Runtime.evaluate", { expression: EXTRACT, returnByValue: true });
    const v = r.result.value;
    if (v && v.contentText && v.contentText.length > 20) {
      return { id: a.id, title: v.title || a.title, account: v.account, publishTime: v.publishTime, publishedAt: a.publishedAt, url, contentText: v.contentText, imageUrls: v.imageUrls, status: "ok" };
    }
  }
  return { id: a.id, title: a.title, publishedAt: a.publishedAt, url, status: "failed", reason: "content_not_found" };
}

async function main() {
  const registry = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const sources = registry.sources.filter((s) => s.bookId && (!ONLY_SOURCE || s.name === ONLY_SOURCE));
  console.log(`待更新源: ${sources.length} 个${ONLY_SOURCE ? `（仅 ${ONLY_SOURCE}）` : ""}`);

  const cdp = await connect();
  const summary = [];
  for (const src of sources) {
    const dir = path.join(DATA_DIR, `weread-content-${slugify(src.name)}`, "full-articles");
    fs.mkdirSync(dir, { recursive: true });
    const have = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));
    process.stdout.write(`\n[${src.name}] 索引中...`);
    const idx = await indexArticles(cdp, src.bookId);
    if (idx.error) {
      console.log(` ⚠️ 索引接口失效（${idx.error}），跳过。可用 discover 或等接口恢复后重试`);
      summary.push({ name: src.name, status: "index_failed", newOk: 0, newFailed: 0 });
      continue;
    }
    const fresh = idx.articles.filter((a) => !have.has(safeName(a.id)));
    const todo = LIMIT > 0 ? fresh.slice(0, LIMIT) : fresh;
    console.log(` 共 ${idx.articles.length} 篇，新增 ${fresh.length} 篇${LIMIT > 0 ? `（本批限 ${todo.length}）` : ""}`);
    let ok = 0, failed = 0, newest = 0;
    for (const a of todo) {
      let rec;
      try { rec = await fetchOne(cdp, a); }
      catch (e) { rec = { id: a.id, title: a.title, publishedAt: a.publishedAt, status: "failed", reason: String(e.message || e).split("\n")[0] }; }
      fs.writeFileSync(path.join(dir, `${safeName(a.id)}.json`), JSON.stringify(rec, null, 2));
      if (rec.status === "ok") { ok++; newest = Math.max(newest, a.publishedAt || 0); } else failed++;
      await sleep(INTERVAL_MS);
    }
    if (newest > 0) {
      src.latestUpdateAt = new Date(newest * 1000).toISOString();
      src.latestUpdateStatus = "ok";
    }
    summary.push({ name: src.name, status: "done", newOk: ok, newFailed: failed, total: idx.articles.length });
  }

  // 原子化写回 registry（更新游标）
  const tmp = CONFIG + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, CONFIG);

  console.log("\n===== 汇总 =====");
  for (const s of summary) console.log(`  ${s.name}: ${s.status === "done" ? `新增成功 ${s.newOk} / 失败 ${s.newFailed}（共 ${s.total} 篇）` : "索引失效"}`);
  cdp.close();
  process.exit(0);
}

main().catch((e) => { console.error("❌", String(e.stack || e)); process.exit(1); });

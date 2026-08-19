const fs = require("node:fs");
const path = require("node:path");
const { loadPlaywright } = require("./resolve_playwright");
const { chromium } = loadPlaywright();

const CDP_URL = process.env.WEREAD_CDP_URL || "http://127.0.0.1:9222";
const BOOK_ID = process.env.WEREAD_BOOK_ID || "MP_WXS_3237097376";
const SOURCE_NAME = process.env.WEREAD_SOURCE_NAME || "博云";
const SOURCE_SLUG = process.env.WEREAD_SOURCE_SLUG || BOOK_ID.toLowerCase();
const API_URL = "https://weread.qq.com/";
const OUTPUT_DIR = process.env.WEREAD_OUTPUT_DIR || path.join(__dirname, "../outputs/weread-boyun-content");
const ARTICLE_DIR = path.join(OUTPUT_DIR, "articles");
const MEDIA_DIR = path.join(OUTPUT_DIR, "media");
const DIAGNOSTICS_FILE = path.join(OUTPUT_DIR, "diagnostics.json");
const CACHE_VERSION = 2;
const PAGE_SIZE = 20;
const MAX_PAGES = 30;
const API_INTERVAL_MS = 1200;
const ARTICLE_INTERVAL_MS = 1800;
const LOGIN_WAIT_MS = 5 * 60 * 1000;
const ARTICLE_WAIT_MS = 30 * 1000;
const TIME_ZONE = "Asia/Shanghai";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value == null ? fallback : value.slice(prefix.length);
}

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`日期必须是 YYYY-MM-DD：${value}`);
  return value;
}

function todayInShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function rangeEpoch(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00+08:00`) / 1000;
  const toExclusive = Date.parse(`${toDate}T00:00:00+08:00`) / 1000 + 24 * 60 * 60;
  return { from, toExclusive };
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function classifyFailure(data, error) {
  const body = String(data?.bodyTextSnippet || "");
  const title = String(data?.title || "");
  const message = String(error || "");
  if (body.includes("参数错误")) {
    return {
      reasonCode: "invalid_article_url",
      reason: "微信公众号原文页返回“参数错误”，原文 ID 可能已失效、文章已删除或被下架。",
    };
  }
  if (message.includes("Execution context was destroyed")) {
    return {
      reasonCode: "navigation_race",
      reason: "页面跳转期间读取 DOM，已通过重试处理。",
    };
  }
  if (title === "微信公众平台" && !data?.contentHtml) {
    return {
      reasonCode: "invalid_or_blocked_page",
      reason: "页面标题退化为“微信公众平台”且没有正文，可能是失效链接或微信页面拦截。",
    };
  }
  return {
    reasonCode: "content_not_found",
    reason: "页面未出现可读取的正文区域，需要人工检查页面状态。",
  };
}

function normalizeImageUrl(value) {
  if (!value || value.startsWith("data:")) return "";
  return value.startsWith("//") ? `https:${value}` : value;
}

function imageExtension(url, contentType) {
  const match = String(url).match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/);
  if (match) return `.${match[1].toLowerCase()}`;
  const type = String(contentType || "").split(";")[0].toLowerCase();
  const known = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg" };
  return known[type] || ".bin";
}

async function downloadImages(article, articleDir) {
  const urls = [...new Set((article.imageUrls || []).map(normalizeImageUrl).filter(Boolean))];
  const results = [];
  fs.mkdirSync(articleDir, { recursive: true });
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
          referer: article.url,
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const fileName = `${String(index + 1).padStart(3, "0")}${imageExtension(url, response.headers.get("content-type"))}`;
      const filePath = path.join(articleDir, fileName);
      fs.writeFileSync(filePath, bytes);
      results.push({ url, status: "downloaded", localPath: path.relative(OUTPUT_DIR, filePath), bytes: bytes.length, contentType: response.headers.get("content-type") || "" });
    } catch (error) {
      results.push({ url, status: "error", error: String(error) });
    }
  }
  return results;
}

function readDiagnostics() {
  if (!fs.existsSync(DIAGNOSTICS_FILE)) return { version: 1, runs: [], lessons: [] };
  try { return JSON.parse(fs.readFileSync(DIAGNOSTICS_FILE, "utf8")); } catch (_) { return { version: 1, runs: [], lessons: [] }; }
}

function pageState(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    path: location.pathname,
    bodyTextLength: document.body ? document.body.innerText.length : 0,
    hasLoginButton: Array.from(document.querySelectorAll("button")).some(
      (button) => button.innerText.trim() === "登录"
    ),
  }));
}

async function fetchJson(apiPage, endpoint) {
  return apiPage.evaluate(async (url) => {
    const result = await fetch(url, { credentials: "include" });
    const text = await result.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = { parseError: true, text: text.slice(0, 1000) };
    }
    return { httpOk: result.ok, httpStatus: result.status, payload };
  }, endpoint);
}

async function ensureLogin(apiPage) {
  await apiPage.goto(API_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  let shelf = await fetchJson(apiPage, "/web/shelf/sync?synckey=0&teenmode=0&album=1");
  if (shelf.payload.errCode !== -2010) return shelf;

  console.log("专用 Chrome 尚未恢复微信读书登录态，请扫码；脚本最多等待 5 分钟。 ");
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    shelf = await fetchJson(apiPage, "/web/shelf/sync?synckey=0&teenmode=0&album=1");
    if (shelf.payload.errCode !== -2010) return shelf;
  }
  throw new Error("等待微信读书登录态恢复超时（5 分钟）");
}

function flatten(payload) {
  const byId = new Map();
  for (const group of payload.reviews || []) {
    for (const subReview of group.subReviews || []) {
      const review = subReview.review || {};
      const mpInfo = review.mpInfo || {};
      const originalId = mpInfo.originalId || "";
      const reviewId = review.reviewId || "";
      const id = originalId || reviewId;
      if (!id || !mpInfo.title) continue;
      byId.set(id, {
        id,
        title: mpInfo.title,
        publishedAt: Number(review.createTime || group.createTime || 0),
        reviewId,
        url: originalId ? `https://mp.weixin.qq.com/s/${originalId}` : "",
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.publishedAt - a.publishedAt);
}

async function collectIndex(apiPage, from, toExclusive) {
  const byId = new Map();
  let previousNewCount = -1;
  let pages = 0;
  for (let offset = 0; pages < MAX_PAGES; offset += PAGE_SIZE) {
    if (pages > 0) await sleep(API_INTERVAL_MS);
    const response = await fetchJson(apiPage, `/web/mp/articles?bookId=${encodeURIComponent(BOOK_ID)}&offset=${offset}`);
    if (!response.httpOk || response.payload.errCode) {
      throw new Error(`${SOURCE_NAME}文章接口异常：offset=${offset}, HTTP=${response.httpStatus}, errCode=${response.payload.errCode || "无"}`);
    }
    const items = flatten(response.payload);
    let newCount = 0;
    for (const item of items) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
        newCount += 1;
      }
    }
    pages += 1;
    const oldest = items.at(-1)?.publishedAt || 0;
    console.log(`索引页 ${pages}: offset=${offset}, 返回 ${items.length} 篇, 新增 ${newCount} 篇`);
    if (!items.length || newCount === 0 || (oldest && oldest < from)) break;
    previousNewCount = newCount;
    void previousNewCount;
  }
  return [...byId.values()]
    .filter((item) => item.publishedAt >= from && item.publishedAt < toExclusive)
    .sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id));
}

function readCached(id) {
  const file = path.join(ARTICLE_DIR, `${safeFileName(id)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value.cacheVersion === CACHE_VERSION && value.status === "ok" && (value.contentText?.trim() || value.contentHtml?.trim()) ? value : null;
  } catch (_) {
    return null;
  }
}

async function scrapeArticle(articlePage, item) {
  if (!item.url) return { ...item, cacheVersion: CACHE_VERSION, status: "missing_url", reasonCode: "missing_article_url", reason: "索引没有提供微信公众号原文链接。", contentText: "", contentHtml: "" };
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await articlePage.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(1000);
      const deadline = Date.now() + ARTICLE_WAIT_MS;
      let data = null;
      while (Date.now() < deadline) {
        data = await articlePage.evaluate(() => {
          const content = document.querySelector("#js_content");
          const bodyText = document.body?.innerText || "";
          const title = document.querySelector("#activity-name")?.innerText?.trim() || document.title || "";
          const account = document.querySelector("#js_name")?.innerText?.trim() || "";
          const publishedAtText = document.querySelector("#publish_time")?.innerText?.trim() || "";
          const imageUrls = [...(content?.querySelectorAll("img") || [])]
            .map((image) => image.getAttribute("data-src") || image.getAttribute("src") || "")
            .filter(Boolean);
          return {
            title,
            account,
            publishedAtText,
            contentHtml: content?.innerHTML || "",
            contentText: content?.innerText || "",
            imageUrls,
            contentKind: content?.innerText?.trim() ? "text_and_media" : (imageUrls.length ? "image_only" : "empty"),
            pageUrl: location.href,
            bodyTextLength: bodyText.length,
            bodyTextSnippet: bodyText.slice(0, 500),
            htmlSnippet: document.documentElement?.outerHTML?.slice(0, 2000) || "",
          };
        });
        if (data.contentText.trim() || data.contentHtml.trim()) break;
        await sleep(800);
      }
      if (!data || (!data.contentText.trim() && !data.contentHtml.trim())) {
        const diagnosis = classifyFailure(data);
        return {
          ...item,
          cacheVersion: CACHE_VERSION,
          status: "content_not_found",
          error: diagnosis.reason,
          ...diagnosis,
          ...data,
          attempts: attempt,
        };
      }
      return {
        ...item,
        cacheVersion: CACHE_VERSION,
        status: "ok",
        scrapedAt: new Date().toISOString(),
        ...data,
        reasonCode: data.contentKind === "image_only" ? "image_only_content" : "ok",
        reason: data.contentKind === "image_only" ? "正文由图片组成，已保存 HTML、图片 URL，并在下载阶段保存本地副本。" : "正文文本和 HTML 已提取。",
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  const diagnosis = classifyFailure(null, lastError);
  return { ...item, cacheVersion: CACHE_VERSION, status: "error", error: diagnosis.reason, ...diagnosis, rawError: String(lastError), contentText: "", contentHtml: "", attempts: 3 };
}

async function main() {
  const fromDate = dateOnly(arg("from", "2026-04-01"));
  const toDate = dateOnly(arg("to", todayInShanghai()));
  const { from, toExclusive } = rangeEpoch(fromDate, toDate);
  if (from >= toExclusive) throw new Error("起始日期必须早于截止日期");
  fs.mkdirSync(ARTICLE_DIR, { recursive: true });

  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP Chrome 没有可用的浏览器上下文");
    const pages = context.pages();
    const apiPage = pages.find((page) => page.url().startsWith("https://weread.qq.com/")) || await context.newPage();
    const articlePage = pages.find((page) => page.url().includes("mp.weixin.qq.com")) || await context.newPage();
    const shelf = await ensureLogin(apiPage);
    const indexed = await collectIndex(apiPage, from, toExclusive);
    console.log(`日期范围 ${fromDate} 至 ${toDate}，共 ${indexed.length} 篇待处理`);

    const articles = [];
    for (let index = 0; index < indexed.length; index += 1) {
      const item = indexed[index];
      const cached = readCached(item.id);
      if (cached) {
        console.log(`[${index + 1}/${indexed.length}] 已复用 ${item.title}`);
        articles.push(cached);
        continue;
      }
      if (index > 0) await sleep(ARTICLE_INTERVAL_MS);
      console.log(`[${index + 1}/${indexed.length}] 抓取 ${item.title}`);
      const result = await scrapeArticle(articlePage, item);
      if (result.status === "ok" && result.imageUrls?.length) {
        result.media = await downloadImages(result, path.join(MEDIA_DIR, safeFileName(item.id)));
        result.mediaSummary = {
          total: result.media.length,
          downloaded: result.media.filter((media) => media.status === "downloaded").length,
          failed: result.media.filter((media) => media.status !== "downloaded").length,
        };
        result.contentHtmlLocal = result.contentHtml;
        for (const media of result.media.filter((entry) => entry.status === "downloaded")) {
          const localReference = `../${media.localPath}`;
          result.contentHtmlLocal = result.contentHtmlLocal.split(media.url).join(localReference);
          result.contentHtmlLocal = result.contentHtmlLocal.split(media.url.replace(/^https:/, "")).join(localReference);
        }
      } else if (result.status === "ok") {
        result.media = [];
        result.mediaSummary = { total: 0, downloaded: 0, failed: 0 };
        result.contentHtmlLocal = result.contentHtml;
      }
      fs.writeFileSync(path.join(ARTICLE_DIR, `${safeFileName(item.id)}.json`), JSON.stringify(result, null, 2) + "\n");
      articles.push(result);
    }

    articles.sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id));
    const completedAt = new Date().toISOString();
    const output = {
      ok: articles.every((article) => article.status === "ok"),
      source: { name: SOURCE_NAME, bookId: BOOK_ID },
      range: { from: fromDate, to: toDate, timeZone: TIME_ZONE },
      generatedAt: completedAt,
      shelfStatus: { httpOk: shelf.httpOk, httpStatus: shelf.httpStatus, errCode: shelf.payload.errCode || null },
      articleCount: articles.length,
      successCount: articles.filter((article) => article.status === "ok").length,
      failedCount: articles.filter((article) => article.status !== "ok").length,
      scope: "按发布时间过滤；正文来自微信公众号原文页 #js_content；保留 contentHtml、contentText、imageUrls，并下载可访问的图片到 media/",
      articles,
    };
    const outputFile = path.join(OUTPUT_DIR, `${SOURCE_SLUG}-content-${fromDate}-to-${toDate}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2) + "\n");
    const markdown = [
      `# ${SOURCE_NAME}公众号文章（${fromDate}至${toDate}）`,
      "",
      `共 ${articles.length} 篇，成功抓取正文 ${output.successCount} 篇。`,
      "",
      ...articles.flatMap((article) => [
        `## ${new Date(article.publishedAt * 1000).toLocaleString("zh-CN", { timeZone: TIME_ZONE })} ${article.title}`,
        "",
        `- 状态：${article.status}`,
        `- 原文：${article.url || ""}`,
        article.publishedAtText ? `- 原文页面时间：${article.publishedAtText}` : "",
        "",
        article.contentText || (article.contentKind === "image_only"
          ? `> 该文章正文为图片，已保留原始 HTML 和图片地址：${(article.imageUrls || []).join(" ")}\n> 本地图片：${(article.media || []).filter((media) => media.status === "downloaded").map((media) => media.localPath).join(" ") || "下载失败，请查看 JSON 中的 media 字段"}`
          : `> 未抓到正文：${article.error || "未知原因"}`),
        "",
      ]),
    ].join("\n");
    const markdownFile = path.join(OUTPUT_DIR, `${SOURCE_SLUG}-content-${fromDate}-to-${toDate}.md`);
    fs.writeFileSync(markdownFile, markdown, "utf8");
    const diagnostics = readDiagnostics();
    const reasonCounts = articles.reduce((counts, article) => {
      const code = article.reasonCode || article.status || "unknown";
      counts[code] = (counts[code] || 0) + 1;
      return counts;
    }, {});
    diagnostics.runs.push({
      generatedAt: completedAt,
      range: { from: fromDate, to: toDate },
      articleCount: articles.length,
      successCount: output.successCount,
      failedCount: output.failedCount,
      reasonCounts,
      failures: articles.filter((article) => article.status !== "ok").map((article) => ({
        id: article.id,
        title: article.title,
        status: article.status,
        reasonCode: article.reasonCode,
        reason: article.reason,
        bodyTextSnippet: article.bodyTextSnippet,
        pageUrl: article.pageUrl,
      })),
    });
    diagnostics.lessons = [
      { code: "invalid_article_url", lesson: "原文页出现“参数错误”时，优先判定为原文 ID 失效、文章删除或下架，不归因于抓取上限。" },
      { code: "image_only_content", lesson: "#js_content 纯图片时 contentText 为空，但 contentHtml 和 imageUrls 仍是有效正文。" },
      { code: "navigation_race", lesson: "微信公众号页面跳转期间读取 DOM 会触发 Execution context was destroyed，必须重试导航。" },
      { code: "rate_limit_check", lesson: "若发生限流，应同时记录 HTTP 状态、验证码/风控页面文本和连续失败范围，不能仅凭 content_not_found 推断。" },
    ];
    fs.writeFileSync(DIAGNOSTICS_FILE, JSON.stringify(diagnostics, null, 2) + "\n");
    console.log(JSON.stringify({
      ok: output.ok,
      outputFile,
      markdownFile,
      diagnosticsFile: DIAGNOSTICS_FILE,
      articleCount: output.articleCount,
      successCount: output.successCount,
      failedCount: output.failedCount,
      failed: articles.filter((article) => article.status !== "ok").map((article) => ({ id: article.id, title: article.title, status: article.status, error: article.error })),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(String(error.stack || error));
  process.exitCode = 1;
});

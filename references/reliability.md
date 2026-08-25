# Reliability Contract

The system is reliable only when each stage has an observable contract. Do not report “success” from a single happy-path article.

## Discovery contract

Input: a user-confirmed, logged-in WeRead Chrome session.

Output:

- a non-empty set of reader URLs from the full archive;
- one valid unique `MP_WXS_<digits>` Book ID per source;
- discovery count, archive URL, invalid-ID list, and timestamp;
- an atomic local registry update or an explicit no-write failure.

Failure states:

- `login_required`: user must scan the QR code;
- `archive_navigation_not_found`: the full collection entry was not found;
- `no_sources_found`: page rendered but no reader links appeared;
- `invalid_book_ids`: reader links exist but the URL format changed;
- `discovery_shrank`: fewer sources appeared than the previous registry.

## Collection contract

For each source, record:

- requested date range and timezone;
- index page count and article count;
- successful, cached, terminally unavailable, and retry-exhausted articles;
- reason codes and visible page evidence for failures;
- media URL count and download count.

`ok: true` means the source-level run completed and its output was written. It does not mean every WeChat article was available. Article-level failures remain part of the output.

## Operational metrics

Track these over time:

- `discoveredCount` and change from the previous discovery;
- `newArticleCount`, `cachedArticleCount`, and `failedArticleCount`;
- `invalid_article_url`, `content_not_found`, `navigation_race`, and rate-limit counts;
- oldest article reached during index pagination;
- last successful source cursor.

The tail matters. A run that is 99% successful but silently drops the same source every day is not reliable. Keep the failure and make the next action obvious.

---

# 实战已知坑（Field-known pitfalls）

> 来自 2026-08 海外独角兽 435 篇全量采集的实战记录。每条都是真实踩过的坑，含现象、根因、处理。
> 最终战绩：407/435 成功（93.6%），失败 28 篇（23 服务端空壳 + 5 纯图片消息）。

## 1. `~` 编码坑（最重要，影响 1/3 文章）

- **现象**：部分文章拼 `https://mp.weixin.qq.com/s/<originalId>` 返回「参数错误」拦截页（约 31KB、无正文、无 og:title）。
- **根因**：微信读书 `mpInfo.originalId` 用 `~` 编码 base64url 的 `_`。带 `~` 的 id 直接拼链接，微信服务端统一拒绝。
- **处理**：**URL 构造必须 `id.replace(/~/g, "_")`**（采集、补抓、失败清单链接、诊断全部适用）。本号 435 篇中 126 篇含 `~`，修复后成功率从 ~55% 升至 92%。
- **诊断方法**：`curl -A <浏览器UA> <链接>`，返回含「参数错误」且 HTML 约 31KB 即中此坑。

## 2. mp 文章是 SSR，curl 可作为 Chrome 的降级通道

- **现象**：Chrome 采集中个别文章抓不到（超时/临时风控），但 `curl` 能拿到完整 HTML。
- **根因**：mp.weixin.qq.com 文章页正文（#js_content）是服务端渲染，curl 拿到初始 HTML 即可解析。
- **处理**：失败先 curl 诊断再决定是否放弃。curl 能拿到正文时，直接解析 js_content 提取文本 + 图片 URL 补回（本次救回 7/7 篇）。

## 3. 服务端空壳（不可达，放弃类）

- **现象**：页面返回约 31KB 空框架（仅有标点、底部按钮），页面 title 为空，正文数据完全不在 HTML 里。
- **根因**：文章已删除 / 设为私密 / 仅微信环境内可见（本次 23 篇几乎全是同一专栏系列）。
- **处理**：curl 诊断确认为空壳后标记 terminally unavailable，进失败清单，不无限重试。唯一可选项：请用户在微信 App 内验证可见性。

## 4. 纯图片 / 视频消息（非失败，跳过类）

- **现象**：页面有 og:title 但 js_content 为空（innerText < 20 字）。
- **根因**：「分享图片」、海报、视频号消息，文字版天然不存在。
- **处理**：识别为特殊格式，不进重试队列，清单注明「纯图片/视频消息」。

## 5. 图片加载 OOM（进程被杀 exit 137）

- **现象**：连接已加载大文章的 mp 页面后，Node 进程被 OOM 杀掉（exit 137）。
- **根因**：微信文章页图片大量加载撑爆内存。
- **处理**：连接后立即 `Network.setBlockedURLs` 拦截图片/媒体（`*qpic.cn*`、`*.png/jpg/gif/webp` 等）；图片 URL 仍可从 DOM `data-src` 收集。工作页选轻量页面，避开已加载大文章的页面。

## 6. 浏览器级 CDP 异常、页面级 CDP 可用

- **现象**：playwright `connectOverCDP` 30 秒超时，但 curl `/json/version` 正常。
- **根因**：个别 Chrome 实例的浏览器级 WebSocket 握手不响应（可能是长期运行后的异常状态）。
- **处理**：用裸 WebSocket 直连 `/json` 里页面的 `webSocketDebuggerUrl`（页面级 CDP），绕过浏览器级接口，可正常 `Page.navigate` / `Runtime.evaluate` / `Network.setBlockedURLs`。终极解法：重启该 Chrome 实例。

## 7. 登录态「假登录」

- **现象**：weread.qq.com 页面显示书架/头像（缓存渲染），但 API 返回 `errCode: -2012`（登录超时）或 `-2041`。
- **根因**：cookie 还在但 session token 已失效。
- **处理**：以 API 探活（如 `/web/shelf/sync`）为登录态唯一判据，不看页面渲染。失效则重新扫码。

## 8. mp/articles 索引接口失效

- **现象**：`/web/mp/articles?bookId=...` 返回 `errCode: -2041`；reader 页变空壳（文章列表不渲染）。
- **根因**：微信读书接口变更。
- **处理**：索引层若已留有完整文章 ID 列表（如 full_index.json），可直接改走 `mp.weixin.qq.com/s/<id>` 公开页抓正文（无需微信读书登录态）；索引重新发现需用 discover 流程在登录态下重建。

## 9. 归档页虚拟滚动导致 discover 漏项

- **现象**：首次 discover 只发现 50 个公众号（实际 69 个）。
- **根因**：归档页是虚拟滚动列表，快速滚动会跳过未渲染项；且「链接数稳定」判定被虚拟化干扰。
- **处理**（已修入 `collectReaderLinks`）：慢速小步滚动（每步 ~350px + 380ms）+ 累计 Map 收集所有见过的链接 + 以「滚动位置连续不变」为停止条件。

## 10. macOS Chrome 单实例机制

- **现象**：用户日常 Chrome 在运行时，`open -na` 或直接调二进制启动的采集 Chrome，`--remote-debugging-port` 不生效（30 秒超时）。
- **根因**：macOS Chrome 单实例，新启动请求被合并到现有进程。
- **处理**：用 playwright `launchPersistentContext` 起真正独立的实例（见 scripts/launch-chrome.js），调试端口一定生效，且不受用户 Chrome 影响。

## 11. 文件名以 `-` 开头的 shell 陷阱

- **现象**：批量处理时 `rm "$f"` / `grep ... $f` 报 "illegal option"（微信文章 id 可能以 `-` 开头）。
- **处理**：批量文件操作用 python（`os.remove`）或 `rm -- "$f"` / `rm "./$f"`。

## 12. 环境后台任务存活（WorkBuddy/沙箱类环境）

- **现象**：后台任务（Chrome + 采集器）在命令结束或跨对话轮次后被环境清理，采集中断。
- **处理**：Chrome 启动与采集器放同一后台任务（一体化 wrapper）；采集器必须断点续传（按已有输出文件跳过）；长任务分批次（每批 N 篇），任务被清理后重启续跑。

## 失败原因诊断 SOP（通用）

对新出现的失败文章，按此顺序诊断（见 outputs 侧 diagnose-failed.py 实现）：

1. `curl -A <浏览器UA> https://mp.weixin.qq.com/s/<id:~→_>` 看 HTML：
   - 含「参数错误」→ id 编码问题（检查是否漏了 `~→_` 替换）
   - 含「该内容已被发布者删除 / 此内容因违规无法查看」→ 被删/违规，放弃
   - 含「环境异常 / 完成验证 / 操作频繁」→ 风控，稍后重试 + 降低频率
   - 有 og:title 且 js_content 非空 → curl 可提取，直接补回
   - 有 og:title 但 js_content 空 → 纯图片/视频消息，跳过
   - 页面 title 空 + 正文全空（约 31KB 框架）→ 服务端空壳，标记 terminally unavailable
2. 只有 curl 完全拿不到时才动用登录态 Chrome 验证。

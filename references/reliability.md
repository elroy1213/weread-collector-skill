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

## 8. mp/articles 索引接口失效（web 端已废弃，且间歇性假恢复）

- **现象**：`/web/mp/articles?bookId=...` 返回 `errCode: -2041`（errMsg 空白）；reader 页变空壳（文章列表不渲染，不发数据请求）。
- **根因**：微信读书 web 端在 2026-08 下线了「公众号书架」功能，接口迁到 App 端。不是风控封号、不是登录态问题（`/web/shelf/sync` 仍正常返回书架数据）。
- **⚠️ 间歇性假恢复（2026-08-26 实测）**：8/26 下午该接口曾短暂恢复，能翻页拿到完整历史（海外独角兽 offset 0→430，435 篇，最早 2021-06-16）；但**次日（8/27）又全部回到 -2041**，且冷却 60s、换回 weread 首页、先访问 reader 页均无法恢复。判断为「灰度窗口」或「每日配额」型临时放行，**不可作为稳定依赖**。
- **处理**：
  - 正文抓取改走 `mp.weixin.qq.com/s/<id>` 公开页（不依赖微信读书，稳定可用）。
  - 文章列表/篇数稳定方案用 App 端新接口（见文末「微信读书接口规则（2026-08）」）。**注意：该接口翻页到底能拿完整历史**（非仅 2 年，见易错点第 2 条），只是要慢速 + 重试穿透风控。
  - **完整历史**只能靠「存量」：早前抓好的 full_index.json（如海外独角兽 435 篇），或等 mp/articles 临时窗口出现时抓紧抓。不要假设它能随时拉全量完整历史。
- **教训**：接口「恢复」必须隔天复测确认，单次成功不能写死为「已恢复」。

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

---

# 微信读书接口规则（2026-08 更新）

> 微信读书 2026-08 把「公众号」功能从 web 端迁到 App 端后，接口体系变了。以下规则来自 2026-08-26 实测，防止下次再踩。

## 接口迁移总览

| 用途 | 旧（web 端，已废弃） | 新（App 端） |
|---|---|---|
| 文章列表/篇数 | `/web/mp/articles?bookId=...` → -2041 | `/api/v2/platform/mps/<bookId>/articles?page=N` |
| 文章链接 → 公众号 | — | `POST /api/v2/platform/wxs2mp` body `{url}` |
| 登录 | 微信读书扫码 | `/api/v2/login/platform` → uuid+scanUrl → 轮询拿 vid+token |

新接口在 web 端（weread.qq.com）直接调是 404，需要走中转服务 `https://weread.111965.xyz`（wewe-rss 作者维护的第三方，转发 App 端签名接口）或自行逆向 App 签名。

## 新接口调用（中转服务版）

```
# 1. 登录：拿 uuid + 扫码链接
GET /api/v2/login/platform → {"uuid","scanUrl"}
# 2. 用户扫码后轮询结果
GET /api/v2/login/platform/<uuid> → {"vid","token","username"}
# 3. 查文章列表（headers: xid=vid, Authorization: Bearer token）
GET /api/v2/platform/mps/<bookId>/articles?page=N → [{id,title,picUrl,publishTime,url}]
# 4. 文章链接转正确 mpId（可选）
POST /api/v2/platform/wxs2mp  body {"url":"https://mp.weixin.qq.com/s/<id>"} → [{id,name,cover}]
```

返回的 `id` 即 `mp.weixin.qq.com/s/<id>` 的正文链接 id，可直接喂给正文采集器。

## 易错点（务必记住，含 2026-08-27 血泪教训）

1. **page 从 0 开始**：`page=0` 是最新一页，page 递增拿更早历史。传 `page=1` 会跳过第一页（可能误判为「无文章」）。
2. **风控限流 ≠ 没数据**：频繁调用会返回空 `[]`（不是没数据！）。需 ≥5 秒间隔 + 空返回自动重试（4-8 次）。**翻页到底能拿到完整历史**（海外独角兽翻到 2021-11、XbotPark 到 2021-05、董科含到 2014-12），不存在「只保留 2 年」的边界——之前「2 年边界」是风控误判，已纠正。
3. **bookId 数字 = biz 解码数字（正常时）**：`bookId` 的 `MP_WXS_` 后缀数字，正常应等于公众号 `__biz` base64 解码后的数字（海外独角兽、锦秋集、通义实验室均验证）。**若两者不一致，优先怀疑 bookId 解析错了**，而不是「没收录」。
4. **bookId 位数检查（2026-08-27 关键教训）**：bookId 数字**非 10 位 → 大概率解析时多了一位**。实例：锦秋集 bookId 被解析成 `MP_WXS_38877766437`（11 位，多一个 7），真实是 `MP_WXS_3887776643`（10 位）；通义实验室同理 `39116210340`→`3911621034`。用错位 bookId 调接口会返回空/No book found，导致误判「微信读书没收录」。**发现某号拉不到文章，第一步先数 bookId 位数，再对比 biz 解码数字。**
5. **"No book found" ≠ 没收录**：wxs2mp 用转载文章链接反查，可能因 biz 对不上返回 `No book found`。但更常见的「空」原因是** bookId 位数错了**（见第 4 条）。
6. **web 端收录范围 > App 端**：RockFlow Universe App 端 0 篇、web 端 178 篇；董科含 App 端风控、web 端 109 篇。**判断「没收录」必须 web + App 双端验证**，且优先用 web 端 `mp/articles`（收录更全，但接口间歇性可用）。

## bookId 正确性自检（两重校验）

1. **位数校验**：`bookId` 去 `MP_WXS_` 后数字应为 **10 位**。非 10 位 → 几乎必是解析错位，把最后一位去掉重试（或从 `biz` 解码反推正确值）。
2. **readerUrl 校验**：`bookId` 数字串做 hex 编码，应出现在 `readerUrl` 里。若两者不一致，说明 bookId 与 readerUrl 脱节，需重新 discover。
3. **biz 交叉校验**：从任意一篇该号文章的 `__biz`（base64）解码得数字，应等于 bookId 数字。不等 → bookId 错。

## 隐私提醒

中转服务 `weread.111965.xyz` 是第三方（wewe-rss 作者自建），扫码登录后 token 会经过它，有效期很长。使用前应向用户明确此隐私风险，验证/采集完成后建议不再复用该 token。

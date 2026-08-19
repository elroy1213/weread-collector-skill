---
name: weread-collector
description: "Discover and maintain a logged-in WeRead public-account source registry, then fetch WeChat article indexes, full text, HTML, and media through a local CDP Chrome session. Use when the user asks to enumerate WeRead-followed public accounts, map MP_WXS book IDs, refresh latest-update metadata, scrape articles by date, or diagnose missing/blocked WeChat content."
---

# WeRead Collector

Use the source registry as the only source-selection input. Do not hardcode a publisher name or Book ID in a run.

## Repository and schedule boundaries

- Keep the user's real `sources.json`, article output, media, diagnostics, and any Chrome profile outside the Git repository. Use `sources.example.json` only as a schema example.
- Install the bundled Node dependency with `npm install` in the Skill directory, or set `WEREAD_PLAYWRIGHT_MODULE` to an existing Playwright installation. Never rely on a machine-specific absolute module path.
- GitHub is for versioning and validation. Scheduled collection must run on the user's Mac or a trusted self-hosted runner that has an already-authenticated Chrome profile; GitHub-hosted runners cannot access the user's WeRead login session.
- Run one source at a time, persist per-article cache and diagnostics, and alert on failures rather than replacing the local registry.
- For recurring execution, read [references/scheduling.md](references/scheduling.md). Use Codex desktop automation with Direct Chrome, or the bundled incremental runner with an authenticated local CDP Chrome. Do not schedule authenticated collection on GitHub-hosted runners.

## Execution Modes

Prefer **Direct Chrome mode** for interactive work. Use the Codex Chrome browser control skill to open `https://weread.qq.com/web/shelf/archive/1786504693`, read the visible `/web/mp/reader/` links, and open a reader page to read its directory and article body. This mode does not require a terminal or local CDP port and reuses the user's logged-in Chrome session. Use one tab sequentially, wait for the directory to render, and retry a page before classifying it as unavailable.

Use **CDP mode** for deterministic batch jobs that need the API index, article cache, media downloads, and diagnostics. CDP requires a Chrome instance with remote debugging at `WEREAD_CDP_URL`; it is optional for direct reading.

## Workflow

1. Validate the registry before browser work:

   ```bash
   node <skill-dir>/scripts/validate_sources.js \
     --config=/absolute/path/to/sources.json
   ```

2. For direct mode, use the user's connected Chrome session and confirm the archive page visibly contains the expected public-account links. For CDP mode, ensure a Chrome instance with remote debugging is available at `WEREAD_CDP_URL` (default `http://127.0.0.1:9222`) and already signed in to `weread.qq.com`. Do not try to bypass login or CAPTCHA.

3. Select one source explicitly with `--source=<name>` or `--book-id=<MP_WXS_...>`. Use a narrow date window for a smoke test, then expand the range.

4. Reuse article cache files. A cached item is reusable only when its cache version, status, and non-empty content are valid. Preserve failures and diagnostics; do not silently drop them.

5. Treat these outcomes differently:
   - `invalid_article_url`: the WeChat original ID is invalid/deleted/unpublished.
   - `navigation_race`: retry navigation, then record the retry count.
   - `rate_limited_or_blocked`: record HTTP status and visible risk-control text.
   - `content_not_found`: the page rendered without a readable `#js_content`; keep the URL and page evidence.
   - image-only content: retain HTML, image URLs, and downloaded media even when text is empty.

## Commands

The bundled CDP runner is `scripts/weread-content-cdp.js`, resolved relative to this `SKILL.md`. It accepts:

```text
--config=<sources.json>       source registry (default: outputs/sources.json)
--source=<name>               exact source name
--book-id=<MP_WXS_...>        alternative source selector
--from=YYYY-MM-DD             inclusive publication date
--to=YYYY-MM-DD               inclusive publication date
--output-dir=<dir>            output root (default: outputs/weread-content)
--smoke-test                  validate config and CDP connectivity without scraping articles
```

Example:

```bash
WEREAD_CDP_URL=http://127.0.0.1:9222 \
node <skill-dir>/scripts/weread-content-cdp.js \
  --config=outputs/sources.json --source=博云 \
  --from=2026-08-10 --to=2026-08-18
```

The command writes a JSON result, Markdown transcript, per-article cache, downloaded media, and diagnostics. A non-zero exit code means the run did not complete; inspect the JSON summary before retrying.

For recurring multi-source CDP runs, call `scripts/run_incremental.js` once instead of repeatedly invoking the single-source runner. It maintains a local cursor per Book ID, overlaps the previous two days, serializes sources, prevents concurrent runs, and writes `state/last-run.json`. Preview its plan with `--dry-run` before the first real run.

For a direct Chrome run, do not invoke the CDP runner. Read the archive and reader DOM through the browser-control skill, then write the extracted structured result with the normal file tools. Keep the same source schema and failure reason codes so direct and CDP runs remain interchangeable.

## Stability Rules

- Use one API page and one article page per run; throttle index and article requests.
- Retry navigation races up to three times with backoff.
- Stop index pagination when the API returns no items, no new IDs, or an item older than the requested range.
- Keep source discovery separate from article scraping. A stale or missing latest-update timestamp must not remove a source from the registry.
- Never interpret an empty homepage mini-shelf as the complete collection; full sources come from the configured archive discovery result.
- Advance the incremental cursor after the index and output complete, even if a few articles are terminally unavailable; keep those failures in diagnostics. Do not advance the cursor after a fatal source-level error.

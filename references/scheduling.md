# Scheduling

## Codex desktop automation

Use Direct Chrome mode when a scheduled Codex task can access the user's connected and logged-in Chrome. The task prompt should name `$weread-collector`, give the absolute local `sources.json` path, request an incremental scan through today, require sequential one-tab processing, and require a summary of failed sources. Keep state and outputs outside the Skill repository.

Suggested task intent:

```text
Use $weread-collector in Direct Chrome mode. Read my local sources.json, collect new WeRead public-account articles through today, reuse existing article cache, process one source at a time, preserve diagnostics, and report only new articles plus failed sources. Do not submit forms or bypass login/CAPTCHA.
```

## Local unattended CDP batch

Use `scripts/run_incremental.js` when Chrome is deliberately running with remote debugging and WeRead is already authenticated. The runner:

- processes sources sequentially;
- overlaps two days by default to avoid boundary misses;
- writes state atomically after each source;
- prevents concurrent runs with a lock file;
- continues after an individual source fails;
- advances a source cursor only after its index run completes;
- preserves per-article failures in output and diagnostics.

Example:

```bash
WEREAD_CDP_URL=http://127.0.0.1:9222 \
node <skill-dir>/scripts/run_incremental.js \
  --config=/private/path/sources.json \
  --state=/private/path/state/incremental.json \
  --output-dir=/private/path/outputs/weread-content
```

Preview without connecting to Chrome:

```bash
node <skill-dir>/scripts/run_incremental.js \
  --config=/private/path/sources.json \
  --state=/private/path/state/incremental.json \
  --dry-run
```

Useful options:

- `--source=name` may be repeated or contain comma-separated names.
- `--from=YYYY-MM-DD` overrides saved cursors.
- `--to=YYYY-MM-DD` defaults to today in Asia/Shanghai.
- `--initial-days=7` controls the first-run lookback.
- `--overlap-days=2` controls the recurring overlap.
- `--limit=N` supports bounded smoke tests.

Do not schedule the authenticated scrape on a GitHub-hosted runner. GitHub Actions should validate the repository only. A trusted self-hosted runner is acceptable only if its Chrome profile and local output paths are protected.

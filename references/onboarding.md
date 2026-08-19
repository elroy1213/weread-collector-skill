# First-Run Onboarding

The registry belongs to the WeRead user, not to this Skill. Every installation starts empty.

## 1. User signs in

Use Direct Chrome mode for the first run:

1. Open `https://weread.qq.com/` in the user's connected Chrome.
2. If WeRead shows a QR code or login screen, stop and ask the user to scan it with WeChat and confirm when the home page is visible.
3. Do not read, export, or store cookies, local storage, passwords, QR payloads, or browser profile files.
4. Verify that the signed-in page has the user's shelf/archive navigation before discovery.

This is a deliberate human-in-the-loop boundary. The Skill can reuse a logged-in browser session, but it must not manufacture authentication.

## 2. Discover this user's sources

Open the full archive by following the signed-in page's visible navigation, not by guessing or reusing an archive ID. Do not assume the homepage mini-shelf is complete. Collect every reader URL after the archive has finished rendering; if the archive is lazy-loaded, scroll it until the link count is stable across several passes. Derive each `MP_WXS_<digits>` Book ID from its reader URL. The source name and reader URL are user-specific metadata.

The first discovery must fail closed when zero reader links are found. An empty result can mean login failure, the wrong shelf, a rendering timeout, or a changed WeRead UI. Never replace a non-empty registry with `sources: []`.

## 3. Persist a local registry

Save the merged registry to a user-owned path, for example:

```text
~/Library/Application Support/Codex/weread-collector/sources.json
```

On Linux, use an equivalent user data directory. The path should be supplied explicitly to the Skill. Create a timestamped backup before replacing an existing registry and write the new JSON atomically. Restrict the file to the current user where the platform supports it.

Persist only operational metadata:

```json
{
  "version": 2,
  "timeZone": "Asia/Shanghai",
  "generatedAt": "2026-08-19T00:00:00.000Z",
  "sources": [
    {
      "name": "Example account",
      "type": "wechat_official_account",
      "collection": "项目库",
      "bookId": "MP_WXS_1234567890",
      "readerUrl": "https://weread.qq.com/web/mp/reader/example",
      "latestUpdateAt": null,
      "latestUpdateStatus": "pending_reader_refresh"
    }
  ]
}
```

Do not put cookies, access tokens, article bodies, image files, or browser profile paths in `sources.json`. Book IDs are identifiers, not credentials, but the list of followed accounts can still be sensitive; keep the registry local by default.

## 4. Reuse and refresh

- Article collection reads this registry; it never assumes a fixed count such as 51.
- A normal daily run uses the saved Book IDs and only checks new/overlapping dates.
- Re-run discovery when the user asks to refresh followed accounts, when a source disappears, or when WeRead's archive changes.
- Merge by `bookId`; preserve existing `latestUpdateAt`, cache references, and diagnostics unless the new discovery has stronger evidence.
- If discovery returns fewer sources than before, report the difference and require an explicit confirmation before deleting sources. A transient rendering failure must not unsubscribe a source in local state.
- Record discovery evidence (`archiveUrl`, `discoveredCount`, `invalidBookIds`, `discoveredAt`) alongside the registry so a later run can explain why the source set changed.

## 5. CDP variant

If the user deliberately runs Chrome with remote debugging, `scripts/discover_sources_cdp.js` can perform the same discovery after the user has completed QR login in that Chrome profile. It must be given an explicit local `--config` path. If it reports `login_required` or `no_sources_found`, fix the browser state and rerun discovery; do not proceed to article scraping.

For the first CDP run, use `--dry-run` first. Inspect the discovered count, names, and Book IDs. Only rerun without `--dry-run` after the user confirms that the set looks like their full archive.

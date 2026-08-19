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

# SiteDesk static PWA: what was verified

## Device notifications + bell (added 2026-09-13)

- `node --check app.js`: clean after all changes.
- 23 new unit tests (`/tmp/sd-pages-notif-test.js`, re-runnable), all passing:
  - `feedItem`: id prefix `ev_`, ISO timestamp, audience/title/body/link fields, link defaults to null, ids unique
  - `feedAppendCap`: prepends newest, does not mutate input, caps at 200, handles null feed
  - `feedNewItems`: audience filter (all / me / other logins), skips seen ids, skips items without id, returns oldest-first for popup order
  - `capSeenIds`: dedupes and caps the stored seen list at 500
  - `timeAgo`: just now / min / hr / day buckets and date fallback, empty on invalid ts
- All 25 pre-existing tests still pass (no regressions).
- DOM id cross-check: `bellBtn`, `bellBadge`, `notifAsk`, `btnNotifEnable`, `btnNotifLater`, `view-notifs`, `btnRefreshFeed`, `notifList`, `ancTitle`, `ancBody`, `btnAnnounce` all present in index.html and wired in app.js.
- Em/en dash scan over every shipped file (index.html, app.js, styles.css, manifest.webmanifest, icon.svg, data/users.json, TESTING.md): 0 violations.
- Anti-spam rules in code: first feed fetch seeds last-seen silently (no popup storm); popups only for items newer than last-seen; max 5 popups per fetch; feed read on sign-in, bell-panel open, and manual refresh only, no polling loops; `new Notification` only fires when permission is granted.

## Automated checks (all passing)

- `node --check app.js`: clean, no syntax errors.
- 25 unit tests against the real exported functions in app.js (`/tmp/sd-pages-test.js`, re-runnable):
  - base64 UTF-8 encode/decode roundtrip, including non-Latin text (Arabic business name)
  - `normLead`: full key set, alternate keys (`id`/`name`/`maps_url`), null input, missing name returns null
  - `normSites`: `{sites: [...]}` wrapper handling, duplicate slug removal
  - `isExpired`: future expiry false, past expiry true, missing expiry treated as expired
  - `telHref`: 10-digit gets +1, 11-digit starting with 1 kept, empty returns empty
  - `smsHref`: correct `sms:+1...?body=` encoding
  - `directionsUrl`: exact Google Maps search URL with encoded address
  - `newClaimDoc`: status claimed, claimed_by set, outcome null, expiry exactly 45 min after claimed_at
  - `newIntakeDoc`: id prefix, status open, claim link, creator recorded
  - `claimPath` / `intakePath` shapes
  - `ghErrorMessage`: plain-English text for 401, 403, 404, 422, and fallback
  - `shuffle` preserves all elements
- Em/en dash scan over every shipped file: 0 violations (code and UI text).
- JSON validity: `manifest.webmanifest` and `data/users.json` parse.
- Cross-check: all 40 element ids referenced in app.js exist in index.html (one, `btnUnlock`, is injected dynamically by the claim lookup and wired immediately after, which is correct at runtime). All `data-copy` and nav targets resolve.

## What was NOT tested (needs a real browser + repo)

- Actual GitHub API calls (auth, claim race 422, PUT/DELETE with sha). The request shapes follow the Contents and Git Trees APIs exactly, but live behavior needs a token and a test repo.
- PWA install flow and service worker (no service worker shipped on purpose, see below).
- The `sites.json` fetch from `location.origin`, which assumes the app is served from the domain root (custom domain). On `*.github.io/bjvfi/sitedesk/` the catalog and preview links would need the `/bjvfi` base path.

## Cut or stubbed, and why

- No service worker: a worker that caches aggressively could serve stale claim state and cause double-claim confusion. The app works offline-ish by being dependency-free (no CDNs); live data always needs network anyway.
- My-claims discovery scans the git tree then fetches each claim file. That is O(n) requests, fine for a small caller team; cached per session with a Refresh button. No polling anywhere.
- Expired claims are treated as open client-side. Re-claiming an expired claim overwrites the file with a fresh 45-minute window.
- Admin claim list is slug lookup plus unlock, not a full table, to keep request counts minimal.
- Push notifications, email, and SMS sending are out of scope for a zero-backend build. What ships instead: an in-app notification center plus built-in browser popups (`new Notification`, no VAPID, no keys, no service worker, no third party). Events are stored in `sitedesk/data/feed.json` in the repo (newest first, capped at 200). SMS uses `sms:` links with prefilled drafts; scripts are copyable text.
- The sign-in screen asks for a fine-grained PAT with Contents read/write on the repo. The token lives in localStorage only and is never displayed or logged.

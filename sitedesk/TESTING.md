# SiteDesk frontend rebuild: what was verified

Rebuilt 2026-09-13 in `~/workspace/sitedesk-pages/sitedesk/`. Static frontend, local files only, nothing pushed.

## Security warning: shared token scoping

`config.js` ships `SITEDESK_DATA_TOKEN` in the client, visible to anyone who inspects the app. Scope it to ONLY the `iamnottaiiii/sitedesk-data` repo with Contents read+write and NOTHING else. Caller access is still gated by PBKDF2 passwords in `users.json` verified client-side. The token, passwords, and hashes are never logged, never displayed, and never sent anywhere except `api.github.com`.

## What was verified

- `node --check app.js` and `node --check config.js`: both pass.
- Unit tests (`/tmp/sitedesk-tests.js`, 40 assertions, all pass):
  - Lead normalizer uses SHORT keys as primary: realistic entry `{"s":"x-y","n":"X Y","c":"Plumber","p":"(555) 123-4567","a":"123 Main St"}` asserts slug `x-y`, name `X Y`, category `Plumber`, phone digits `5551234567`, address `123 Main St`. This was the critical queue bug: the old normalizer read long keys first, so every entry parsed to null and the queue showed zero leads.
  - Long keys still work as fallbacks; short keys win when both are present; null/empty entries never produce null fields.
  - `siteUrlFor` prefers an embedded url key, falls back to `https://bjvfi.com/<slug>/` (URL structure assumed, not confirmed against the live site).
  - PBKDF2 roundtrip against the real format `pbkdf2$600000$<salt-b64>$<hash-b64>` (SHA-256, 256-bit, timing-safe compare): correct password verifies, wrong password / garbage format / tampered hash all reject.
  - Feed cap at 200 keeps newest-first order; claim expiry math (45 min window); `tel:`/`sms:`/directions URL builders; shuffle preserves the set; `esc` escapes markup; plain-English GitHub error messages for 401/403/404/422; countdown formatting; generated passwords are 16 chars from the unambiguous alphabet (no 0/O/1/l).
- DOM cross-check: every id referenced in `app.js` (51 refs) exists in `index.html` or is created dynamically by `app.js` render functions. Zero missing.
- Dash scan: no em dashes or en dashes in any file (UI strings or comments). Separators use the middle dot.
- `styles.css` is byte-identical to the original `<style>` block from `/tmp/orig-style.html` (diff clean). All original classes present: `:root` variables, `.void-shell` texture/vignette, `.top` header with fade mask, `.brand` + `.bell` with amber dot, `.card` with fade-edge/soft-bleed/radial mask, `.btn` variants (light, ghost, danger, call, sms), `.bottom-nav` 64px tab bar, `.toast` (light), `.lead-row`, `.statrow/.stat`, `.chiprow/.chip`, `.pick`, `.copybox`, `.phone-line`, `.timer`, `.timeline`, `.badge` variants, `.modal-back/.modal`, `.home-void/.home-mark`, `.install-gate/.notif-gate`, `.notif-banner`.
- Network surface: only `https://api.github.com/repos/iamnottaiiii/sitedesk-data` (auth header `Bearer SITEDESK_DATA_TOKEN`), `https://bjvfi.com/sites.json` (no auth), plus the Google Fonts CDN from `index.html`. No polling loops; feed is fetched on login, on Alerts open, and via manual refresh.

## Not verified live (needs a browser + real token)

- Actual GitHub read/write roundtrips (claims, intakes, users.json, feed.json), 422 race on claim create, admin create-user flow, and the one-time notif-gate permission prompt. The data repo was not touched.
- No service worker was added: aggressive caching could serve stale claim state and cause double-claim confusion.

# SiteDesk — Node.js edition (no Cloudflare)

Your SiteDesk caller desk, running on **plain Node.js**. No Cloudflare Workers,
no D1, no R2. It uses the exact same app code (`worker.js`) — the only change is
a small HTTP adapter (`server.js`) that feeds real web `Request` objects into the
worker's `fetch()`, which Node 18+ supports natively.

## What stays the same
- **Database:** Turso (libSQL) over HTTPS — already platform-agnostic. Your
  existing `sitedesk` Turso DB works as-is. No migration.
- **Lead catalog:** pulled live from your GitHub repo
  (`iamnottaiiii/bjvfi/main/sites.json`).
- **Image uploads:** stored in Turso (the `assets` table), replacing R2.
- **All features:** auth, lead queue, intakes, inbox, payouts, reports, drafts,
  notifications, web push, CSV exports — unchanged.

## Run it
```bash
# 1. Set your Turso token (the one from `turso db tokens create sitedesk`)
export TURSO_TOKEN="your-turso-token"

# 2. Start
node server.js
# → SiteDesk running on http://0.0.0.0:3000
```

## Environment variables
| Var | Purpose | Default |
|-----|---------|---------|
| `TURSO_TOKEN` | **Required.** Turso DB auth token | — |
| `TURSO_URL` | Turso DB URL | baked-in `https://sitedesk-notai.aws-ap-northeast-1.turso.io` |
| `PORT` | HTTP port | `3000` |
| `HOST` | Bind host | `0.0.0.0` |
| `HEAD_EMAIL` | Head/admin email (auto-approves) | `iamnottaiii@gmail.com` |
| `SITE_ORIGIN` | Base domain for lead site URLs | `https://bjvfi.com` |
| `MONTHLY_PRICE` | Monthly price in templates | `27` |
| `MAX_ACTIVE_LEADS` | Lead cap per caller | `5` |
| `APP_PUBLIC_URL` | Public URL for notification links | — |
| `RESEND_API_KEY` | Email via Resend (optional) | — |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | SMS (optional) | — |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push (optional) | — |
| `SYNC_INTERVAL_MINUTES` | Lead-catalog sync interval | `360` (6h) |
| `DISABLE_SYNC` | Set `1` to disable scheduled sync | — |

## Deploy anywhere (no Cloudflare)
This is a standard Node HTTP server, so it runs on any Node host:

- **Render** — new Web Service, build `npm install`, start `node server.js`, add
  `TURSO_TOKEN` as an env var.
- **Railway** — new service, start command `node server.js`, add `TURSO_TOKEN`.
- **Fly.io** — `fly launch`, set `TURSO_TOKEN` secret.
- **VPS / any box** — `node server.js` behind nginx/Caddy.

The scheduled lead sync runs in-process (every 6h by default) — no cron needed.

## Files
- `worker.js` — your original app (unchanged).
- `server.js` — the Node HTTP adapter + scheduled sync.
- `package.json` — minimal, no dependencies (Node 18+ built-ins only).

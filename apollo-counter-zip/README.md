# Apollo Counter

Self-hosted service: paste an Apollo.io search URL → get back the `pipeline_total` count.
Deploys to Coolify (or any Docker host) in minutes.

---

## How It Works

```
First ever run (or after IP change):
  Playwright logs in → Apollo shows OTP screen
  → fetches code from Gmail IMAP → submits
  → Apollo writes "trusted device" cookie to /data/browser-profile (on disk)

All subsequent runs (same server IP):
  Playwright logs in → Apollo recognises the saved profile → NO OTP
  → extracts cookies + CSRF token → caches in memory (60 min)
  → calls Apollo API with parsed URL filters → returns { "count": 2220 }
```

**The browser profile is persisted as a Docker volume** — OTP is only ever needed once per server IP. Container restarts, redeployments, and session TTL renewals all skip OTP automatically.

---

## Environment Variables

Copy `.env.example` → `.env`:

```env
# Apollo login
APOLLO_EMAIL=you@example.com
APOLLO_PASSWORD=yourpassword

# IMAP (reads OTP from the same inbox)
IMAP_PROVIDER=gmail          # gmail | google-workspace | outlook | hotmail
IMAP_PASSWORD=xxxx-xxxx-xxxx-xxxx

# Server
PORT=3000
API_SECRET=long-random-secret
SESSION_TTL_MINUTES=60
```

### IMAP Password by provider

| Provider | What to use | Where to get it |
|---|---|---|
| **Gmail** (@gmail.com) | App Password | [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) — also enable IMAP in Gmail Settings → Forwarding and POP/IMAP |
| **Google Workspace** | App Password | Same as Gmail — set `IMAP_PROVIDER=google-workspace` |
| **Outlook / Hotmail** | Your Outlook password (or App Password if 2FA is on) | [account.microsoft.com/security](https://account.microsoft.com/security) |
| **Other IMAP** | Set `IMAP_HOST`, `IMAP_PORT`, `IMAP_PASSWORD` | Ask your email provider |

---

## Deploy on Coolify

1. Push this repo to GitHub / GitLab
2. Coolify → **New Resource** → **Dockerfile**
3. Add environment variables in the Coolify UI (copy from `.env.example`)
4. Under **Advanced** → set **Shared Memory** to `256mb` (Chromium requires it)
5. Under **Volumes** → add a persistent volume: container path `/data/browser-profile`
   *(this saves the trusted-device cookie so OTP is only needed once)*
6. Deploy — **first startup will ask for OTP** (~30–90s), all future startups skip it
7. Set health check path to `/health`

> **To force a fresh OTP** (e.g. after changing server IP): delete the volume in Coolify and redeploy.

---

## API

### POST /count
```bash
curl -X POST https://your-server/count \
  -H "Content-Type: application/json" \
  -H "x-api-secret: your-secret" \
  -d '{"url": "https://app.apollo.io/#/people?page=1&personTitles[]=ceo..."}'

# Response:
{ "count": 2220 }
```

### GET /count
```bash
curl "https://your-server/count?url=https%3A%2F%2Fapp.apollo.io%2F%23..." \
  -H "x-api-secret: your-secret"
```

### GET /session-status
```json
{ "active": true, "expiresInMinutes": 47, "apolloEmail": "you@example.com" }
```

### POST /invalidate-session
Force re-login on next request.

### GET /health
```json
{ "ok": true, "uptime": 3600 }
```

---

## Web UI

Visit `https://your-server/` — paste URL, press the button, see the count.

The session status indicator in the header shows whether a cached login exists.

---

## Local Development

```bash
cp .env.example .env
# Fill in .env

npm install
npx playwright install chromium --with-deps
npm run dev
```

---

## Timing

| Scenario | Time |
|---|---|
| Session cached (normal) | 2–5 seconds |
| Re-login, no OTP | 15–25 seconds |
| Re-login + OTP from inbox | 30–90 seconds |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `IMAP_PASSWORD not set` | Set `IMAP_PASSWORD` in `.env` |
| `OTP not received within 120s` | Check Gmail has IMAP enabled; verify App Password is correct |
| `Login failed — stuck on /login` | Wrong `APOLLO_EMAIL` or `APOLLO_PASSWORD` |
| `CSRF token not found` | Try `POST /invalidate-session` to force a fresh login |
| OTP appears on **every** restart | Volume not mounted — add `/data/browser-profile` as a persistent volume in Coolify |
| Docker Chromium crash | Ensure shared memory ≥ 256mb |
| Want to force a new OTP (IP changed) | Delete the `browser-profile` volume in Coolify and redeploy |

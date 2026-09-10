# Discord Multi-Token Messenger

An automated Discord messaging bot that manages **multiple Discord account tokens** from one place, with scheduled/looping messages and a modern web dashboard.

- 🔑 **Add unlimited account tokens** — single add or bulk paste, each validated via `GET /users/@me` and shown with its username
- ✅ **Check-all button** re-validates every token (spots locked/invalid ones without re-pasting)
- 💬 **Messaging tasks** — each task sends from one account to one channel, rotating through messages (random or round-robin), every N seconds with optional jitter
- 🧪 **One-click test sends** to verify a token + channel pairing
- 🚪 **Server joiner** — paste one invite link, every active account joins one-by-one with delays; per-account results + a live progress bar
- 🧩 **CaptchaAI key in Settings** — when Discord answers a join with a captcha challenge, it's solved with your key and retried; every step streams to the log
- 📊 **Progress tracking** — header stats (tokens / tasks / messages sent), per-task send counts, join operations with ✅/❌ breakdowns, and a filterable live log
- 🐳 **Coolify-ready** — `Dockerfile` + `docker-compose.yml` + [`COOLIFY.md`](COOLIFY.md); listens on `0.0.0.0:$PORT`, health check at `/health`
- 📜 **Live activity log** (SSE) showing sends, errors, and rate-limit backoffs
- 🔒 Tokens are stored server-side only; the API/UI only ever shows masked previews
- ⏳ Built-in minimum-interval guard + `429` backoff so you don't hammer the Discord API

## Quick start

```bash
cp .env.example .env   # set PORT if needed
npm install
npm start
# open http://localhost:3000
```

Optional: preload tokens on boot (comma-separated):

```bash
DISCORD_TOKENS=tokenA,tokenB npm start
```

## Getting account tokens

1. Open Discord in your **browser** and log into the account.
2. Press **Ctrl+Shift+I** (DevTools) → **Application** tab → **Local Storage** → `https://discord.com` → copy the `token` value (strip any quotes).
3. Paste it into the dashboard (or bulk-paste many at once, comma/newline separated). Each account shows up with its username; use **Check all** anytime to find locked or expired ones.
4. Copy the target **channel ID** (Discord Settings → Advanced → Developer Mode → right-click channel → Copy ID) and create a task picking the account + channel.

> ⚠️ **Heads up:** automating user accounts violates Discord's Terms of Service and can get accounts locked or banned. Never share tokens — each one gives full access to its account. Keep intervals generous and don't use this for spam.

## How it works

- No gateway connection needed — everything goes through Discord's HTTPS REST API (`/api/v10`), so dozens of tokens stay lightweight.
- Token validation: `GET /users/@me` with the raw account token (bot `Bot <token>` prefix tried as fallback, reported as `bot` vs `account` badge).
- Sending: `POST /channels/:id/messages`. Tasks run as per-task timeout loops: `interval + random(0, jitter)`. HTTP `429` responses trigger a `retry_after`-based backoff.
- Persistence: JSON file at `STORE_PATH` (default `./data/store.json`, git-ignored). In-memory live logs (last 500) stream over SSE at `/api/events`.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/tokens` | List tokens (masked) |
| `POST` | `/api/tokens` | Add one (`{"token"}`) or many (`{"tokens":[]}`) |
| `POST` | `/api/tokens/revalidate` | Re-check all stored tokens, marks invalid ones |
| `DELETE` | `/api/tokens/:id` | Remove token (its tasks are paused) |
| `GET` | `/api/tasks` | List tasks |
| `POST` | `/api/tasks` | Create task |
| `PUT` | `/api/tasks/:id` | Update task |
| `POST` | `/api/tasks/:id/toggle` | Pause/resume |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `POST` | `/api/send-test` | Immediate send (`tokenId`, `channelId`, `message`) |
| `POST` | `/api/tokens/join-all` | All active accounts join an invite (`{"invite"}`), returns operation with live progress |
| `GET` | `/api/operations` | Recent bulk operations with per-account results |
| `GET` | `/api/stats` | Totals: tokens, tasks, messages sent, captcha status |
| `GET` / `PUT` | `/api/settings` | CaptchaAI key (stored server-side, returned masked) |
| `GET` | `/api/logs?limit=` | Recent logs |
| `GET` | `/api/events` | SSE live log stream |

Task body:

```json
{
  "name": "Announcements loop",
  "tokenId": "tok_abc123",
  "channelId": "123456789012345678",
  "messages": ["Hello!", "Reminder: read #rules"],
  "rotation": "random",
  "intervalSeconds": 60,
  "jitterSeconds": 15,
  "enabled": true
}
```

Constraints: `intervalSeconds ≥ MIN_INTERVAL_SECONDS` (default 5), messages ≤ 2000 chars, max 50 messages per task.

## Deploy (Coolify)

See [`COOLIFY.md`](COOLIFY.md) — build from the `Dockerfile` on port `3000`, point your Coolify domain at it, mount `/app/data` so tokens survive redeploys.

```bash
docker compose up --build -d  # local Docker equivalent
```

## Safety tips

- Keep intervals generous (minutes, not seconds) for public servers.
- Use one bot per server/community where possible instead of many accounts in one channel.
- Never commit `.env` or `data/store.json` — both are git-ignored.

# Discord Multi-Token Messenger

An automated Discord messaging bot that manages **multiple Discord tokens** from one place, with scheduled/looping messages and a modern web dashboard.

- 🔑 **Add unlimited tokens** — single add or bulk paste, with validation via `GET /users/@me`
- 💬 **Messaging tasks** — each task targets one channel, rotates through messages (random or round-robin), and sends every N seconds with optional jitter
- 🧪 **One-click test sends** to verify a token + channel pairing
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

## Getting bot tokens (recommended)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → New Application → **Bot** → Reset Token → copy it.
2. Enable the **Message Content Intent** only if your bot needs to read messages (sending does not require privileged intents).
3. Invite the bot to your server: OAuth2 → URL Generator → scopes `bot` (+ `applications.commands` if needed) → Bot Permissions → **Send Messages** (and View Channel) → open the URL.
4. Paste the token into the dashboard. Copy the target **channel ID** (Discord Settings → Advanced → Developer Mode → right-click channel → Copy ID) and create a task.

> ⚠️ **User tokens / self-bots:** automating a normal user account violates Discord's Terms of Service and risks a permanent ban. This project accepts raw user tokens for migration/testing convenience and flags them with a `user` badge + warning, but you should use **bot tokens**.

## How it works

- No gateway connection needed — everything goes through Discord's HTTPS REST API (`/api/v10`), so dozens of tokens stay lightweight.
- Token validation: `GET /users/@me`, trying `Bot <token>` first, then raw token (detects `bot` vs `user` auth).
- Sending: `POST /channels/:id/messages`. Tasks run as per-task timeout loops: `interval + random(0, jitter)`. HTTP `429` responses trigger a `retry_after`-based backoff.
- Persistence: JSON file at `STORE_PATH` (default `./data/store.json`, git-ignored). In-memory live logs (last 500) stream over SSE at `/api/events`.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/tokens` | List tokens (masked) |
| `POST` | `/api/tokens` | Add one (`{"token"}`) or many (`{"tokens":[]}`) |
| `DELETE` | `/api/tokens/:id` | Remove token (its tasks are paused) |
| `GET` | `/api/tasks` | List tasks |
| `POST` | `/api/tasks` | Create task |
| `PUT` | `/api/tasks/:id` | Update task |
| `POST` | `/api/tasks/:id/toggle` | Pause/resume |
| `DELETE` | `/api/tasks/:id` | Delete task |
| `POST` | `/api/send-test` | Immediate send (`tokenId`, `channelId`, `message`) |
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

## Safety tips

- Keep intervals generous (minutes, not seconds) for public servers.
- Use one bot per server/community where possible instead of many accounts in one channel.
- Never commit `.env` or `data/store.json` — both are git-ignored.

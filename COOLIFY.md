# Deploying with Coolify (using its domain)

Coolify can build this repo straight from the `Dockerfile` and put it behind
the domain you configure — no extra setup in the app required.

## One-time setup in Coolify

1. **New Resource → Application** → pick this git repo + the branch
   (`cursor/discord-multitoken-bot-ba0a` for now, `main` after merge).
2. **Build Pack: Dockerfile**. (Nixpacks also works, but Dockerfile is exact.)
3. **Port: `3000`** — the app listens on `0.0.0.0:$PORT` and serves the
   dashboard + API on `/`. Health check path is `/health`.
4. **Domain:** in the application → *Domains* tab, add yours
   (e.g. `https://msgs.example.com`). Coolify terminates TLS and proxies to
   the container; nothing to configure in the app.
5. **Persistent storage:** mount a volume at `/app/data` so `store.json`
   (tokens, tasks, settings) survives redeploys. Without it, a redeploy
   wipes your token list.
6. **Environment variables** (all optional):

   | Variable | Default | What it does |
   |---|---|---|
   | `PORT` | `3000` | Port the app listens on (Coolify usually injects this) |
   | `STORE_PATH` | `./data/store.json` | Where tokens/tasks/settings persist |
   | `MIN_INTERVAL_SECONDS` | `5` | Floor for task intervals (raise to `30`+ on big fleets) |
   | `JOIN_DELAY_SECONDS` | `8` | Pause between accounts during server joins |
   | `DISCORD_TOKENS` | empty | Comma-separated tokens to preload on first boot |
   | `CAPTCHAAI_API_URL` | empty | Override for the CaptchaAI-compatible solver endpoint |

7. Hit **Deploy**, then open your domain. Add tokens + your CaptchaAI key
   in the dashboard — everything else is in-app.

## Notes for Coolify

- The dashboard's live log uses **Server-Sent Events** (`/api/events`).
  Coolify's default proxy passes these through; if you sit behind an extra
  CDN/proxy, make sure response buffering is off for that path.
- Redeploys keep `STORE_PATH` only if the `/app/data` volume exists.
  Back up `store.json` before major changes — it holds your tokens.
- Keep the app on its own subdomain; it has no auth gate, so anyone with
  the URL can control your accounts. Protect it (Coolify password / VPN /
  IP allowlist) if it is internet-facing.

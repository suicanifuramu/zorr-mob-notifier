# zorr-mob-notifier

Zorr spawn feed and desktop alerts, with the game's Fredoka One font and
icons rendered from its original Canvas functions. The web app runs on
Cloudflare Pages + Pages Functions; the Discord reader runs on this VPS.

```
Discord → main.py + SQLite → nginx/HTTPS → Pages Functions → browser filters → desktop notification
```

## Web app

Add up to 100 rules for a petal, a mob, or all mobs with a chosen variant.
Petal rules only select a petal. Mob and variant rules can set the variant and
minimum mob rarity, which defaults to Omega for new rules. Petal and mob pickers
show searchable icon grids. Conditions within a rule are AND, rules are OR.
Rules and notification preferences stay in the browser. The server receives no
personal filter settings.

Petal rules cover all variants and mob rarities; old saved petal rules are loaded
without their former variant or rarity restrictions. Matching includes generated
eggs, Magic/Arcane replacements, variant extras, and the possible Flash candidates.
It matches **possible drops**, not
confirmed drops or a player's luck/buffs. Tiny rates are not rounded to zero.
The data snapshot is 2026-10-21 (`1K580MS96.js`): 179 mobs, 575 petal definitions,
18 variants. Unknown spawn names are skipped and counted in the authenticated
status endpoint so a game update cannot silently become a guessed match.

Enable notifications using the button on the page. The page must remain open;
closing it stops receipt of events. Initial history and old reconnect events do
not notify. Notifications are deduplicated across tabs through an atomic
IndexedDB transaction; in storage-restricted browsers the fallback is per tab.
The service worker handles notification clicks; it is not a Web Push service.

## Local web development

```sh
npm ci
uv sync --frozen
# Add a random API_TOKEN to .env, for example with secrets.token_urlsafe(48).
# Copy the same value into BOT_API_TOKEN in .dev.vars; never commit either file.
cp .dev.vars.example .dev.vars
npm run build
uv run python main.py --serve
# In another terminal:
npm run dev
```

Open `http://localhost:4173`. For an isolated synthetic stream use `--demo`
instead of `--serve`; it uses `var/demo.sqlite3`, never the production database.
The browser labels this stream as demo data. Browser notifications require HTTPS
or localhost and a browser that supports the Notifications API.

## VPS deployment

The production API is `https://zorr-mob-notifier.info.gf`. DNS must point to this
VPS. `API_TOKEN` is required; the application binds to `127.0.0.1:8090` behind
nginx. It reads its settings only from the project's `.env` file.

```sh
bash deploy/install-vps.sh zorr-mob-notifier.info.gf
sudo systemctl status zorr-mob-notifier.service
sudo journalctl -u zorr-mob-notifier.service -f
# After changing Python code or .env:
sudo systemctl restart zorr-mob-notifier.service
```

The installer creates a systemd service, an nginx virtual host with buffering
disabled, and a Certbot certificate with automatic renewal. Repeated runs retain
Certbot's TLS configuration. Existing virtual hosts are preserved.

The bot saves up to 2,000 structured spawn events in `var/spawns.sqlite3`.
`GET /api/stream` supports `Last-Event-ID` / `?after=` for SSE resumption;
`GET /api/events?after=` offers the same snapshot/delta protocol as JSON.
Browsers use SSE first, then automatically fall back to five-second polling if
a proxy buffers the stream or heartbeats stop. Both paths filter locally and
deduplicate notifications using the same cursor and event keys.
`GET /api/status` reports Discord connectivity and parser failures. All three require
`Authorization: Bearer <API_TOKEN>`. `/healthz` is a public liveness endpoint.
The API publishes spawn metadata and links, not arbitrary channel messages,
author details, or Discord credentials.

## Cloudflare Pages — GitHub integration

Connect `suicanifuramu/zorr-mob-notifier`, production branch `main`, with:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Build output | `dist` |
| Root directory | `/` |
| Node version | `.node-version` (`24.21.0`) |
| `BOT_API_URL` | `https://zorr-mob-notifier.info.gf` |
| `BOT_API_TOKEN` | Same secret as VPS `API_TOKEN` |

Set `BOT_API_TOKEN` as an encrypted secret for production and preview Functions;
keep Discord's token on the VPS. The Functions proxy supplies the API bearer
token, so it is never sent to the browser. Subsequent pushes to `main` trigger
Cloudflare builds automatically. The frontend build only reads prepared data and
images; it does not need Discord, the research repositories, or game servers.

The helper `uv run python scripts/cloudflare-project.py --account ACCOUNT_ID
create` creates this Git-integrated project through the Cloudflare API after
`npx wrangler login --device`. It reads Wrangler's OAuth credentials and the bot
API secret from private files, without printing them. Use `inspect` or `status`
for the configured source and deployments. It refuses to replace an unrelated
or Direct Upload project.

## Validation and game data refresh

```sh
npm test
npm run test:python
npm run build
```

The tests cover the real spawn announcement forms, all current mob names,
crafted/defeated exclusion, persistent deduplication, SSE history/replay/reset,
authenticated proxy behavior, and petal/mob/variant filter semantics.

Prepared data is in `data/`, images and the font in `public/assets/`. To regenerate
them from the audited local research outputs, run `npm run assets`. This manual
step uses Chromium and the original Canvas functions; it does not connect to
the game server. Review and re-extract a new game version before refreshing.
The browser receives only image atlases and the compact catalog, not the game
runtime. Asset filenames are content-hashed by the normal build.

Game artwork, data, and font retain their respective licenses. The original
Fredoka One SIL Open Font License is included in `public/licenses/` and served
at `/licenses/Fredoka-One-OFL.txt`. Notification icons use
[Lucide](https://lucide.dev/); its license is served at
`/licenses/Lucide.txt`. The upstream
[zorr-assembler](https://github.com/suicanifuramu/zorr-assembler) is MIT licensed;
its game's generated assets are excluded from that license. Platform references:
[Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/),
[Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/),
[browser notifications](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification).

## Original console reader

Reads messages from Discord channel `1541811459913416764` (guild `1331301490538840144`)
through a **user account** using [discord.py-self](https://github.com/dolfies/discord.py-self).

> Self-bot: this uses your own user token and violates Discord's Terms of Service.
> Use a throwaway account that is already a member of the guild.

## Setup

```bash
uv sync
cp .env.example .env
# then edit .env and set DISCORD_TOKEN=...
chmod 600 .env
```

Get the token from the browser DevTools: open Discord in the web client, look at
a request to `/api/v9/...`, and copy the `authorization` header value.
Never commit it, never share it (`.env` is gitignored).

## Run

```bash
uv run python main.py                 # last 20 messages, then live stream
uv run python main.py --limit 100     # bigger backfill
uv run python main.py --no-backfill   # live stream only
uv run python main.py -v              # debug logs
```

Each line is printed as:

```
[2026-10-21 15:04:12] username (123456789012345678): hello
```

Attachments, embeds and stickers are noted in `[...]` after the text.

## Env vars

Read **only** from `.env` in the project root. Real environment variables are ignored.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | – | user token (required) |
| `GUILD_ID` | `1331301490538840144` | guild to filter on |
| `CHANNEL_ID` | `1541811459913416764` | channel to read |

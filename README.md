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
It matches **possible drops**, not confirmed drops or a player's luck/buffs.
Drop rates follow the in-game gallery: each roll is rounded to two decimals and
rows that round to zero are omitted, so the app never shows a rarity the game
hides. Opening a spawn's drop list shows one row per possible petal, with the
same rounded rarity variants and base rates the game displays. A petal reached by
more than one roll shows each rate separately, and Flash-only candidates are
marked conditional; separate rolls are not combined into one aggregate
chance. Rates are base rates before personal bonuses. The data snapshot is
2026-10-21 (`1K580MS96.js`): 179 mobs, 575 petal definitions, 18 variants. Unknown
spawn names are skipped and counted in the authenticated status endpoint so a
game update cannot silently become a guessed match.

On the first visit the page asks for notification permission once. Browsers may
ignore or auto-dismiss a permission prompt that was not triggered by a click, so
the bell offers a click-triggered retry; Safari requires that click. The bell
shows `BellRing` while alerts are on, `Bell` when permission is granted but
alerts are off, and `BellOff` when the browser has blocked or does not support
notifications. Turning alerts off replaces the notice immediately. After a
block, allow notifications in the browser's site settings and reload; the page
cannot show the native prompt again after a denial.

The page must remain open; closing it stops receipt of events. Initial history
and old reconnect events do not notify. Notifications are deduplicated across
tabs through an atomic IndexedDB transaction; in storage-restricted browsers the
fallback is per tab. The service worker handles notification clicks; it is not a
Web Push service.

A spawn announcement is edited in place by the game when the mob dies. That
edit marks the same feed row dead without moving it: the row keeps its original
key, ID, and spawn time, shows a large X and strikethrough, and reads
`Dead by ＠username` or simply `Dead` when the game omitted the killer. Killer
names are literal game usernames, so underscores and similar characters are
preserved. A defeat alert uses the edit time as the death time and its own
notification key, so a spawn and its later death each alert once. Kills are
matched only by the exact Discord message ID, never by mob name or timing.

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

The installed unit starts with `--limit 500` so startup history reconciliation
covers roughly 1.5 hours of announcements at the observed rate; mobs have been
seen alive for over an hour. Editing the service template does not update an
already installed unit: re-run the installer or change `ExecStart` in
`/etc/systemd/system/zorr-mob-notifier.service` and run
`sudo systemctl daemon-reload && sudo systemctl restart zorr-mob-notifier`.
The console reader keeps its smaller default (`--limit 20`).

The bot keeps up to 2,000 current spawn records in `var/spawns.sqlite3`. A
death mutates its spawn record in place; a separate bounded change log (4,000
revisions) supplies the monotonic delivery cursor, so a death never creates a
second feed row and its stable ID and key never change. Old databases migrate
automatically on startup: each existing row becomes its initial `spawn` change
at the same cursor ID, preserving stable IDs, sparse ID gaps, and client
cursors. Existing files are never reset.
`GET /api/stream` supports `Last-Event-ID` / `?after=` for SSE resumption;
`GET /api/events?after=` offers the same snapshot/delta protocol as JSON.
Snapshots contain current records (with `type`, `dead`, `sequence`, `killedBy`,
and `killedAt`); deltas are flat spawn/death change records ordered by change
cursor. An expired cursor produces a silent snapshot with `reset: true`.
Browsers use SSE first, then automatically fall back to five-second polling if
a proxy buffers the stream or heartbeats stop. Both paths filter locally and
deduplicate notifications using the same cursor, stable keys, and event types.
`GET /api/status` reports Discord connectivity, parser failures, and the last
spawn/death times. All three require `Authorization: Bearer <API_TOKEN>`.
`/healthz` is a public liveness endpoint.
The API publishes spawn/death metadata and links, not arbitrary channel
messages, author details, or Discord credentials.

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

The tests cover the real spawn and defeat announcement forms, all current mob
names, crafted/unknown exclusion, exact-message death correlation, killer
parsing, persistent deduplication without resurrection, old-schema migration,
retention/cursor resets, and SSE history/replay/reset. They also cover
authenticated proxy behavior and petal/mob/variant filter semantics.

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
uv run python main.py --limit 500     # reconcile recent deaths (~1.5h of announcements)
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

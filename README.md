# zorr-mob-notifier

A spawn feed and desktop-alert web app for Zorr. It reads spawn and defeat
announcements from one Discord channel, serves them through an authenticated
event API, and filters them in the browser. The frontend runs on Cloudflare
Pages + Pages Functions; the Discord reader runs on any small always-on host.

This is an unofficial fan project. It is not affiliated with the game's
developers.

```
Discord → main.py + SQLite → nginx/HTTPS → Pages Functions → browser filters → desktop notification
```

## Quick start (demo, no Discord account)

Requirements: Node.js from [.node-version](.node-version) (24.21.0), Python
3.11 or newer, and [uv](https://docs.astral.sh/uv/).

```sh
npm ci
uv sync --frozen
cp .env.example .env

# Generate a random API token and put it in API_TOKEN in .env.
uv run python -c "import secrets; print(secrets.token_urlsafe(48))"

cp .dev.vars.example .dev.vars
# Put the same value in BOT_API_TOKEN in .dev.vars.

npm run build
uv run python main.py --demo
```

In another terminal:

```sh
npm run dev
```

Open `http://localhost:4173`. `npm run dev` serves the built `dist/` output
through Wrangler, so run `npm run build` after frontend changes. The demo
publishes synthetic spawns every few seconds, uses `var/demo.sqlite3`, and
never connects to Discord. The page labels this stream as demo data.

`API_TOKEN` is required for `--serve` and `--demo` because those modes expose
the HTTP API. A plain reader (no `--serve`) does not need it. Use a random value
generated locally; no example file contains a real token.

## Live Discord reader

Copy `.env.example` to `.env` and fill in:

- `DISCORD_TOKEN`: the user token of the account that can read the channel.
- `GUILD_ID` and `CHANNEL_ID`: the numeric IDs of the Discord guild and channel.
- `API_TOKEN`: a random secret, only when you use `--serve` or `--demo`.

```sh
uv run python main.py                 # last 20 messages, then live stream
uv run python main.py --limit 500     # reconcile recent deaths (~1.5h of announcements)
uv run python main.py --no-backfill   # live stream only
uv run python main.py -v              # debug logs
uv run python main.py --serve         # live reader plus the authenticated API
```

The reader validates the token and IDs before connecting to Discord and exits
with an actionable message when something is missing. Settings are read only
from `.env` in the project root; real environment variables are ignored. Keep
`.env` private (`chmod 600 .env`) and never commit it.

The reader uses [discord.py-self](https://github.com/dolfies/discord.py-self)
with a user account token. Self-bot use can conflict with Discord's Terms of
Service; review those terms and only operate an account you are authorized to
use.

For a server install, `deploy/install-vps.sh` creates a systemd service, an
nginx virtual host with buffering disabled, and a Certbot certificate:

```sh
bash deploy/install-vps.sh bot.example.com
sudo systemctl status zorr-mob-notifier.service
sudo journalctl -u zorr-mob-notifier.service -f
# After changing Python code or .env:
sudo systemctl restart zorr-mob-notifier.service
```

The installed unit runs `--serve --limit 500`, keeps the API on
`127.0.0.1:8090` behind nginx, and retains Certbot's TLS configuration on
repeated installer runs. Editing the service template does not update an
already installed unit; re-run the installer or update `ExecStart` and reload
systemd. The console reader keeps the smaller default of 20 messages.

## What the page does

Add up to 100 rules for petals, mobs, or all mobs with chosen variants. Each
rule can include several petals or mobs: click to replace the selection,
Ctrl/⌘-click to add or remove one, Shift-click to select a visible range, or
press and hold an icon with a mouse, finger, or pen and then tap more. Selected
icons stay listed above the search results in a bounded, scrollable strip, so
changing the search never hides or clears them.
Mob and variant rules choose variants from a checklist and can combine several;
All variants is the default. Petal rules ignore variants and rarity. Mob and
variant rules set the minimum mob rarity, which defaults to Omega for new rules.
Conditions within a rule are AND; rules are OR. Filter settings and notification
preferences stay in the browser; the server receives no personal filter
settings.

Matching includes generated eggs, Magic/Arcane replacements, variant extras,
and possible Flash candidates. It matches **possible drops**, not confirmed
drops or a player's luck and buffs. Drop rates follow the in-game gallery: each
roll is rounded to two decimals and rows that round to zero are omitted, so the
app never shows a rarity the game hides. Opening a spawn's drop list shows one
row per possible petal with the game's rounded rates. A petal reached by more
than one roll shows each rate separately, Flash-only candidates are marked
conditional, and separate rolls are not combined into one aggregate chance.
Rates are base rates before personal bonuses.

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

On the first visit the page asks for notification permission once. Browsers may
ignore or auto-dismiss a permission prompt that was not triggered by a click, so
the bell offers a click-triggered retry; Safari requires that click. The bell
shows `BellRing` while alerts are on, `Bell` when permission is granted but
alerts are off, and `BellOff` when the browser has blocked or does not support
notifications. After a denial, allow notifications in the browser's site
settings and reload; the page cannot show the native prompt again.

## Event API

The bot keeps up to 2,000 current spawn records in `var/spawns.sqlite3`. A death
mutates its spawn record in place; a separate bounded change log (4,000
revisions) supplies the monotonic delivery cursor. A death never creates a
second feed row, and its stable ID and key never change. Old databases migrate
automatically on startup: each existing row becomes its initial `spawn` change
at the same cursor ID, preserving stable IDs, sparse ID gaps, and client
cursors. Existing files are never reset.

- `GET /api/stream` supports `Last-Event-ID` and `?after=` for SSE resumption.
- `GET /api/events?after=` offers the same snapshot/delta protocol as JSON.
- `GET /api/status` reports Discord connectivity, parser failures, and the last
  spawn/death times.
- `GET /healthz` is a public liveness endpoint.

All three `/api/*` endpoints require `Authorization: Bearer <API_TOKEN>`.
Snapshots contain current records (`type`, `dead`, `sequence`, `killedBy`,
`killedAt`); deltas are flat spawn/death change records ordered by change
cursor. An expired cursor produces a silent snapshot with `reset: true`.
Browsers use SSE first, then fall back to five-second polling if a proxy buffers
the stream or heartbeats stop. Both paths filter locally and deduplicate
notifications using the same cursor, stable keys, and event types.

The API publishes spawn/death metadata and links, not arbitrary channel
messages, author details, or Discord credentials. Keep `DISCORD_TOKEN` and
`API_TOKEN` on the server. The Pages Function adds the API bearer token
server-side, so it is never sent to the browser.

## Cloudflare Pages

Connect your fork of this repository to Pages with:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `/` |
| Node version | `.node-version` (24.21.0) |

Set these environment variables on the Pages project for both production and
preview deployments:

| Variable | Value | Type |
| --- | --- | --- |
| `BOT_API_URL` | Public origin of your bot, for example `https://bot.example.com` | encrypted secret (`secret_text`) |
| `BOT_API_TOKEN` | Same secret as the reader's `API_TOKEN` | encrypted secret (`secret_text`) |

In the Pages dashboard, choose **Encrypt** for both variables in both
production and preview. `BOT_API_URL` is not a credential, but it is stored as a
secret binding on purpose: Cloudflare treats the tracked `wrangler.toml` as the
source of truth for plaintext variables, and a `[vars]` block would overwrite the
deployment-specific URL on the next deploy. Keeping the URL as a secret keeps it
out of `wrangler.toml` and out of this repository.

`BOT_API_URL` must be HTTPS. Plain HTTP is accepted only for loopback hosts
(`127.0.0.1`, `localhost`, `::1`) during local development. No production bot
URL is committed to `wrangler.toml`; each fork sets its own. Keep
`BOT_API_TOKEN` server-side and separate from the browser build.

The helper can create or inspect the Pages project through the Cloudflare API
after `npx wrangler login --device`:

```sh
uv run python scripts/cloudflare-project.py --account ACCOUNT_ID \
  --repo OWNER/REPO --bot-api-url https://bot.example.com create

uv run python scripts/cloudflare-project.py --account ACCOUNT_ID status
uv run python scripts/cloudflare-project.py --account ACCOUNT_ID inspect
```

`--project` defaults to `zorr-mob-notifier`; use `--project YOUR_NAME` for a
fork. `--repo OWNER/REPO` is required for `create`; pass your fork's owner and
name. `create` reads the API secret from the local `.env` and never prints or
accepts secrets in argv. It creates both Pages variables as encrypted secret
bindings for production and preview, and refuses to replace a project connected
to a different repository or a Direct Upload project. `status`, `inspect`,
`retry`, and `logs` work against an existing project. Changing environment
variables in the Pages dashboard does not require changing this repository;
verify them before relying on a deployment.

Subsequent pushes to `main` trigger Cloudflare builds automatically. The
frontend build only reads prepared data and images; it does not need Discord,
the research snapshot, or game servers.

## Validation

```sh
npm test
npm run test:python
npm run build
```

The Python tests cover the real spawn and defeat announcement forms, all current
mob names, crafted/unknown exclusion, exact-message death correlation, killer
parsing, persistent deduplication without resurrection, old-schema migration,
retention and cursor resets, SSE history/replay/reset, and live-configuration
validation. The JavaScript tests cover authenticated proxy behavior and
petal/mob/variant filter semantics, notification state, and asset frame
resolution.

## Data and asset refresh

Prepared data is in `data/`; images and the font are in `public/assets/`. Normal
builds, tests, and deployments consume these files and do not need the research
snapshot.

`npm run assets` is a separate manual refresh. It requires the ignored local
`research/` inputs used for the audited snapshot:

- `research/extracted-game.json`
- `research/mob-drops.json`
- `research/variant-drops.json`
- `research/extracted-runtime.js`
- `research/zorr-deobfuscator/deobfuscated/1K580MS96-deobfuscated.js`, produced
  from the source snapshot recorded in `data/assets-source.json`

It also needs Chromium through `@sparticuz/chromium` and the original Canvas
painting functions. These research files are not included in a clean clone, so
the asset refresh is not reproducible from this repository alone. The script
fails instead of falling back to guessed data; review and re-extract a new game
version before refreshing.

The committed snapshot is from 2026-10-21 and records its source script,
SHA-256, and font hash in `data/assets-source.json`: 179 mobs, 575 petal
definitions, and 18 variants. Unknown spawn names are skipped and counted in
the authenticated status endpoint so a game update cannot silently become a
guessed match. The browser receives only image atlases and the compact catalog,
not the game runtime. Asset filenames are content-hashed by the normal build.

## Licenses and third-party material

The original source code in this repository is MIT licensed; see
[LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and are served under
`/licenses/`.

- Fredoka One is licensed under the SIL Open Font License 1.1
  (`public/licenses/Fredoka-One-OFL.txt`).
- Lucide icons are ISC licensed (`public/licenses/Lucide.txt`).
- The GitHub mark comes from Primer Octicons, MIT licensed
  (`public/licenses/Octicons.txt`).
- Parts of the markup and Canvas painting approach are adapted from
  [zorr-assembler](https://github.com/suicanifuramu/zorr-assembler), MIT
  licensed.

Game artwork and catalog data are derived from the game client and are not
covered by the MIT license. Their snapshot provenance is recorded in
`data/assets-source.json`, and no additional license is granted for them here.
Rights remain with the respective game rights holders. Review the applicable
terms before redistributing those files or deploying this project publicly.

Platform references:
[Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/),
[Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/),
[browser notifications](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification).

## Environment variables

Settings in `.env` are read only from that file; real environment variables are
ignored. Pages variables are read by the Functions runtime from the Cloudflare
project environment.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | live reader | – | Discord user token |
| `GUILD_ID` | live reader | – | guild to filter on |
| `CHANNEL_ID` | live reader | – | channel to read |
| `API_TOKEN` | `--serve`, `--demo` | – | bearer token for the event API |
| `BOT_HOST` | no | `127.0.0.1` | API bind address |
| `BOT_PORT` | no | `8090` | API bind port |
| `DATABASE_PATH` | no | `var/spawns.sqlite3` | SQLite database path |
| `BOT_API_URL` | Pages | – | public bot origin used by Functions (encrypted secret binding) |
| `BOT_API_TOKEN` | Pages | – | API bearer token used by Functions (encrypted secret binding) |

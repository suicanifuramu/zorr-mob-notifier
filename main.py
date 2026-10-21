"""Read messages from a single Discord channel using a user account (discord.py-self).

Reads the channel's recent history, then streams new messages to stdout.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path

import discord
from dotenv import dotenv_values
from aiohttp import web

from notifier.api import SpawnService, create_app
from notifier.store import EventStore

ENV_FILE = Path(__file__).resolve().parent / ".env"
_env = dotenv_values(ENV_FILE)


class ConfigError(Exception):
    """Missing or malformed local settings."""


_ASCII_DECIMAL = re.compile(r"[0-9]+")


def _parse_id(raw) -> int | None:
    """Return a positive ASCII-decimal ID, or None when the value is malformed.

    str.isdigit() accepts characters such as Unicode superscripts that int()
    rejects, so match ASCII digits explicitly and never let int() raise here.
    """
    text = str(raw or "").strip()
    if not _ASCII_DECIMAL.fullmatch(text):
        return None
    try:
        value = int(text)
    except ValueError:  # Extremely long digit strings exceed int()'s limit.
        return None
    return value if value > 0 else None


def _settings_int(name: str) -> int:
    """Read an optional numeric setting for module defaults and tests."""
    return _parse_id(_env.get(name)) or 0


GUILD_ID = _settings_int("GUILD_ID")
CHANNEL_ID = _settings_int("CHANNEL_ID")

log = logging.getLogger("zorr-mob-notifier")


def resolve_live_config(values) -> tuple[str, int, int]:
    """Validate the settings required to connect to Discord.

    Takes a mapping instead of reading the module-level .env snapshot so unit
    tests can run without a .env file or real Discord IDs.
    """
    token = str(values.get("DISCORD_TOKEN") or "").strip().strip("'\"")
    if not token:
        raise ConfigError(
            f"DISCORD_TOKEN is not set in {ENV_FILE}. Copy .env.example to .env and "
            "fill in the user token for the account that can read the channel."
        )
    ids: list[int] = []
    for name in ("GUILD_ID", "CHANNEL_ID"):
        value = _parse_id(values.get(name))
        if value is None:
            raise ConfigError(
                f"{name} must be set to a positive numeric Discord ID in {ENV_FILE}. "
                "Copy .env.example to .env and fill in GUILD_ID and CHANNEL_ID."
            )
        ids.append(value)
    return token, ids[0], ids[1]


def require_api_token(values) -> str:
    """Validate API_TOKEN for the modes that expose the HTTP API."""
    token = str(values.get("API_TOKEN") or "").strip().strip("'\"")
    if not token:
        raise ConfigError(
            f"API_TOKEN is not set in {ENV_FILE}. It is required for --serve and --demo. "
            'Generate one with: uv run python -c "import secrets; print(secrets.token_urlsafe(48))"'
        )
    return token


def format_embed(embed: discord.Embed) -> str:
    parts: list[str] = []
    if embed.title:
        parts.append(embed.title)
    if embed.description:
        parts.append(embed.description)
    for field in embed.fields:
        parts.append(f"{field.name}: {field.value}")
    if embed.url:
        parts.append(embed.url)
    if embed.image and embed.image.url:
        parts.append(embed.image.url)
    return " / ".join(parts)


def format_message(message: discord.Message) -> str:
    stamp = message.created_at.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    body = message.content or ""

    extras: list[str] = []
    if message.attachments:
        names = ", ".join(a.filename for a in message.attachments)
        extras.append(f"{len(message.attachments)} attachment(s): {names}")
    if message.stickers:
        extras.append(f"{len(message.stickers)} sticker(s)")
    if extras:
        body = f"{body} [{' | '.join(extras)}]".strip()

    embeds = [text for text in (format_embed(e) for e in message.embeds) if text]
    if embeds:
        body = " ".join(filter(None, [body, " || ".join(embeds)]))

    return f"[{stamp}] {message.author} ({message.author.id}): {body}"


class ChannelReader(discord.Client):
    def __init__(
        self, *, limit: int, backfill: bool, service: SpawnService | None = None,
        guild_id: int = GUILD_ID, channel_id: int = CHANNEL_ID,
    ) -> None:
        super().__init__()
        self.limit = limit
        self.backfill = backfill
        self.guild_id = guild_id
        self.channel_id = channel_id
        self._channel: discord.abc.Messageable | None = None
        self._history_done = False
        self.service = service

    async def on_ready(self) -> None:
        if self.service:
            self.service.connected = True
        log.info("Logged in as %s (%s)", self.user, getattr(self.user, "id", "?"))
        if self._channel is not None:
            # Reconnect: channel is already resolved, do not replay history.
            return

        channel = self.get_channel(self.channel_id)
        if channel is None:
            try:
                channel = await self.fetch_channel(self.channel_id)
            except discord.NotFound:
                log.error("Channel %s not found or not visible.", self.channel_id)
                await self.close()
                return
            except discord.Forbidden:
                log.error("No access to channel %s.", self.channel_id)
                await self.close()
                return

        self._channel = channel
        guild = getattr(channel, "guild", None)
        if guild is not None and guild.id != self.guild_id:
            log.warning(
                "Channel %s belongs to guild %s, not %s.",
                self.channel_id, guild.id, self.guild_id,
            )
        log.info(
            "Watching #%s in %s", getattr(channel, "name", self.channel_id), guild or "DM"
        )

        if self.backfill and not self._history_done:
            self._history_done = True
            await self.dump_history(channel)

        log.info("Streaming new messages. Ctrl-C to stop.")
        if self.service:
            self.service.backfill_complete = True

    async def dump_history(self, channel: discord.abc.Messageable) -> None:
        print(f"--- last {self.limit} messages ---")
        count = 0
        messages = [message async for message in channel.history(limit=self.limit)]
        for message in reversed(messages):
            print(format_message(message), flush=True)
            if self.service:
                self.service.ingest(message, historical=True)
            count += 1
        print(f"--- {count} message(s) ---")

    async def on_message(self, message: discord.Message) -> None:
        guild = getattr(message, "guild", None)
        if guild is None or guild.id != self.guild_id:
            return
        if message.channel.id != self.channel_id:
            return

        print(format_message(message), flush=True)
        if self.service:
            self.service.ingest(message)

    async def on_message_edit(self, before: discord.Message, after: discord.Message) -> None:
        # Some announcements arrive before their embed is populated. Cached
        # messages (including the in-place "Mob Defeated!" edit) arrive here;
        # uncached edits are handled by on_raw_message_edit.
        if self.service and getattr(after.guild, "id", None) == self.guild_id and after.channel.id == self.channel_id:
            changes = self.service.ingest(after)
            if changes and any(change.get("type") == "death" for change in changes):
                log.info("Recorded death for message %s", after.id)

    async def on_raw_message_edit(self, payload: discord.RawMessageUpdateEvent) -> None:
        # Announcement messages are not cached after a restart or when they
        # predate the gateway session, so history() cannot populate the cache.
        # Fetch the configured channel's current revision instead of trusting
        # the possibly partial gateway payload.
        if not self.service or payload.channel_id != self.channel_id:
            return
        if payload.guild_id is not None and payload.guild_id != self.guild_id:
            return
        if getattr(payload, "cached_message", None) is not None:
            return  # on_message_edit already handles cached messages
        channel = self._channel or self.get_channel(self.channel_id)
        if channel is None:
            try:
                channel = await self.fetch_channel(self.channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException) as exc:
                log.warning("Cannot fetch channel %s for an edited message: %s", self.channel_id, exc)
                return
            self._channel = channel
        try:
            message = await channel.fetch_message(payload.message_id)
        except (discord.NotFound, discord.Forbidden) as exc:
            log.warning("Cannot fetch edited message %s: %s", payload.message_id, exc)
            return
        except discord.HTTPException as exc:
            log.warning("Discord rejected the edited message fetch for %s: %s", payload.message_id, exc)
            return
        if getattr(getattr(message, "channel", None), "id", None) != self.channel_id:
            return

        changes = self.service.ingest(message)
        if changes:
            log.info("Recorded %s update for message %s", changes[-1].get("type", "spawn"), message.id)

    async def on_resumed(self) -> None:
        if self.service:
            self.service.connected = True

    async def on_disconnect(self) -> None:
        if self.service:
            self.service.connected = False
        log.warning("Disconnected, reconnecting...")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--limit", type=int, default=20,
        help="messages to backfill on start (default 20; the installed service uses 500 "
             "to reconcile recent deaths)",
    )
    parser.add_argument(
        "--no-backfill", action="store_true", help="skip the history dump on start"
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    parser.add_argument(
        "--serve", action="store_true",
        help="serve authenticated spawn API on BOT_HOST:BOT_PORT (requires API_TOKEN)",
    )
    parser.add_argument(
        "--demo", action="store_true",
        help="serve a separate synthetic demo feed without Discord (requires API_TOKEN)",
    )
    return parser.parse_args()


async def run(args: argparse.Namespace) -> None:
    # Validate everything before connecting to Discord or starting a listener so
    # a missing setting fails immediately with an actionable message.
    live = None if args.demo else resolve_live_config(_env)
    api_token = require_api_token(_env) if (args.serve or args.demo) else None
    service = None
    runner = None
    demo_task = None
    if args.serve or args.demo:
        database = "var/demo.sqlite3" if args.demo else (_env.get("DATABASE_PATH") or "var/spawns.sqlite3")
        service = SpawnService(EventStore(ENV_FILE.parent / database), demo=args.demo)
        app = create_app(service, api_token)
        runner = web.AppRunner(app, access_log=None, shutdown_timeout=2)
        await runner.setup()
        host = _env.get("BOT_HOST") or "127.0.0.1"
        port = int(_env.get("BOT_PORT") or "8090")
        await web.TCPSite(runner, host, port).start()
        log.info("Spawn API listening at http://%s:%s", host, port)

    client = None
    try:
        if args.demo:
            service.connected = True
            service.backfill_complete = True
            async def demo():
                examples = ["An Omega Rock has spawned!", "A Demonic Omega Tumbleweed has spawned!", "A Magic Super Ladybug has spawned!", "An Angelic Omega Dragon has spawned!"]
                i = 0
                while True:
                    stamp = datetime.now(timezone.utc)
                    for event in service.parser.parse([examples[i % len(examples)]], message_id=f"demo-{stamp.timestamp()}", created_at=stamp, source="demo"):
                        service.publish(event)
                    i += 1
                    await asyncio.sleep(12)
            demo_task = asyncio.create_task(demo())
            await demo_task
        else:
            client = ChannelReader(
                limit=max(1, min(args.limit, 1000)), backfill=not args.no_backfill,
                service=service, guild_id=live[1], channel_id=live[2],
            )
            await client.start(live[0])
    finally:
        if demo_task:
            demo_task.cancel()
            with suppress(asyncio.CancelledError):
                await demo_task
        if client:
            await client.close()
        if runner:
            await runner.cleanup()
        if service:
            service.store.close()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("discord").setLevel(
        logging.DEBUG if args.verbose else logging.WARNING
    )

    try:
        asyncio.run(run(args))
    except ConfigError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

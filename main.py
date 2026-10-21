"""Read messages from a single Discord channel using a user account (discord.py-self).

Reads the channel's recent history, then streams new messages to stdout.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
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

GUILD_ID = int(_env.get("GUILD_ID") or "1331301490538840144")
CHANNEL_ID = int(_env.get("CHANNEL_ID") or "1541811459913416764")

log = logging.getLogger("zorr-mob-notifier")


def load_token() -> str:
    token = (_env.get("DISCORD_TOKEN") or "").strip().strip("'\"")
    if token:
        return token

    sys.exit(
        f"DISCORD_TOKEN is not set in {ENV_FILE}. Copy .env.example to .env and "
        "put your user token in it: DISCORD_TOKEN=..."
    )


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
    def __init__(self, *, limit: int, backfill: bool, service: SpawnService | None = None) -> None:
        super().__init__()
        self.limit = limit
        self.backfill = backfill
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

        channel = self.get_channel(CHANNEL_ID)
        if channel is None:
            try:
                channel = await self.fetch_channel(CHANNEL_ID)
            except discord.NotFound:
                log.error("Channel %s not found or not visible.", CHANNEL_ID)
                await self.close()
                return
            except discord.Forbidden:
                log.error("No access to channel %s.", CHANNEL_ID)
                await self.close()
                return

        self._channel = channel
        guild = getattr(channel, "guild", None)
        if guild is not None and guild.id != GUILD_ID:
            log.warning(
                "Channel %s belongs to guild %s, not %s.", CHANNEL_ID, guild.id, GUILD_ID
            )
        log.info(
            "Watching #%s in %s", getattr(channel, "name", CHANNEL_ID), guild or "DM"
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
        if guild is None or guild.id != GUILD_ID:
            return
        if message.channel.id != CHANNEL_ID:
            return

        print(format_message(message), flush=True)
        if self.service:
            self.service.ingest(message)

    async def on_message_edit(self, before: discord.Message, after: discord.Message) -> None:
        # Some announcements arrive before their embed is populated. Cached
        # messages (including the in-place "Mob Defeated!" edit) arrive here;
        # uncached edits are handled by on_raw_message_edit.
        if self.service and getattr(after.guild, "id", None) == GUILD_ID and after.channel.id == CHANNEL_ID:
            changes = self.service.ingest(after)
            if changes and any(change.get("type") == "death" for change in changes):
                log.info("Recorded death for message %s", after.id)

    async def on_raw_message_edit(self, payload: discord.RawMessageUpdateEvent) -> None:
        # Announcement messages are not cached after a restart or when they
        # predate the gateway session, so history() cannot populate the cache.
        # Fetch the configured channel's current revision instead of trusting
        # the possibly partial gateway payload.
        if not self.service or payload.channel_id != CHANNEL_ID:
            return
        if payload.guild_id is not None and payload.guild_id != GUILD_ID:
            return
        if getattr(payload, "cached_message", None) is not None:
            return  # on_message_edit already handles cached messages
        channel = self._channel or self.get_channel(CHANNEL_ID)
        if channel is None:
            try:
                channel = await self.fetch_channel(CHANNEL_ID)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException) as exc:
                log.warning("Cannot fetch channel %s for an edited message: %s", CHANNEL_ID, exc)
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
        if getattr(getattr(message, "channel", None), "id", None) != CHANNEL_ID:
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
    parser.add_argument("--serve", action="store_true", help="serve authenticated spawn API on BOT_HOST:BOT_PORT")
    parser.add_argument("--demo", action="store_true", help="serve a separate synthetic demo feed without Discord")
    return parser.parse_args()


async def run(args: argparse.Namespace) -> None:
    service = None
    runner = None
    demo_task = None
    if args.serve or args.demo:
        database = "var/demo.sqlite3" if args.demo else (_env.get("DATABASE_PATH") or "var/spawns.sqlite3")
        service = SpawnService(EventStore(ENV_FILE.parent / database), demo=args.demo)
        app = create_app(service, (_env.get("API_TOKEN") or "").strip())
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
            client = ChannelReader(limit=max(1, min(args.limit, 1000)), backfill=not args.no_backfill, service=service)
            await client.start(load_token())
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
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

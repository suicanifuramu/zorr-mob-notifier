import asyncio
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import discord
from aiohttp.test_utils import TestClient, TestServer

import main
from main import ChannelReader
from notifier.api import SpawnService, create_app
from notifier.parser import SpawnParser, message_texts
from notifier.store import EventStore

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "discord-lifecycle.json").read_text()
)["fixtures"]
UTC = timezone.utc


def parse_time(value):
    return datetime.fromisoformat(value)


def fake_embed(data):
    thumbnail = data.get("thumbnail") or {}
    return SimpleNamespace(
        type=data.get("type"), title=data.get("title"), description=data.get("description"),
        color=data.get("color"), fields=[], url=data.get("url"), image=None,
        thumbnail=SimpleNamespace(
            url=thumbnail.get("url"), width=thumbnail.get("width"),
            height=thumbnail.get("height"),
        ),
    )


def fake_message(data):
    edited = data.get("edited_timestamp")
    message_id = int(data["id"])
    return SimpleNamespace(
        id=message_id,
        channel=SimpleNamespace(id=main.CHANNEL_ID),
        guild=SimpleNamespace(id=main.GUILD_ID),
        content=data.get("content", ""),
        embeds=[fake_embed(embed) for embed in data.get("embeds", [])],
        attachments=[], stickers=[], mentions=[],
        created_at=parse_time(data["timestamp"]),
        edited_at=parse_time(edited) if edited else None,
        jump_url=f"https://discord.com/channels/{main.GUILD_ID}/{main.CHANNEL_ID}/{message_id}",
        author=SimpleNamespace(id=1, name="announcer"),
    )


def spawn_event(parser, message_id="1", text="A Demonic Omega Tumbleweed has spawned!",
                *, created_at=None, historical=False):
    return parser.parse(
        [text], message_id=message_id,
        created_at=created_at or datetime(2026, 10, 21, 12, 0, tzinfo=UTC),
        historical=historical,
    )[0]


def death_event(parser, message_id="1", text="A Demonic Omega Tumbleweed was defeated by @Alice with 10% damage!",
                *, created_at=None, edited_at=None, historical=False):
    return parser.parse_death(
        [text], message_id=message_id,
        created_at=created_at or datetime(2026, 10, 21, 12, 0, tzinfo=UTC),
        edited_at=edited_at or datetime(2026, 10, 21, 12, 10, tzinfo=UTC),
        historical=historical,
    )[0]


class ParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parser = SpawnParser()

    def test_real_spawn_announcement_forms(self):
        cases = [
            ("An Omega Gravestone has spawned!", "gravestone", 8, "normal"),
            ("A Demonic Omega Tumbleweed has spawned!", "tumbleweed", 8, "demonic"),
            ("A Bloody Omega White Hole has spawned!", "white_hole", 8, "bloody"),
            ("A Super Gift has spawned!", "gift", 7, "normal"),
            ("**A Magic Omega Fly has spawned!**", "fly", 8, "magic"),
        ]
        for text, mob, rarity, variant in cases:
            with self.subTest(text=text):
                got = spawn_event(self.parser, text=text)
                self.assertEqual((got["mob"], got["rarity"], got["variant"]), (mob, rarity, variant))
                self.assertEqual((got["type"], got["dead"], got["killedBy"]), ("spawn", False, None))

    def test_spawn_parser_rejects_crafts_defeats_and_unknown_identities(self):
        for text in [
            "A Sweet Omega Dragon was defeated by @player!",
            "x2 Super Bone crafted by @player!",
            "An Omega Unknown New Mob has spawned!",
            "An UnknownVariant Omega Rock has spawned!",
            "Mob Spawned!",
        ]:
            self.assertEqual(
                self.parser.parse([text], message_id="x", created_at=datetime.now(UTC)), [],
                text,
            )

    def test_death_parser_uses_edited_time_and_spawn_time(self):
        got = death_event(self.parser, message_id="42")
        self.assertEqual(got["key"], "42:0")
        self.assertEqual(got["type"], "death")
        self.assertTrue(got["dead"])
        self.assertEqual(got["createdAt"], "2026-10-21T12:00:00Z")
        self.assertEqual(got["killedAt"], "2026-10-21T12:10:00Z")
        self.assertEqual(got["killedBy"], "Alice")
        self.assertFalse(got["historical"])

    def test_known_killer_fixture(self):
        fixture = FIXTURES["edit_known_killer"]
        expected = fixture["expected"]
        message = fake_message(fixture["after"])
        got = self.parser.parse_death(
            message_texts(message), message_id=str(message.id),
            created_at=message.created_at, edited_at=message.edited_at,
        )[0]
        self.assertEqual(got["mob"], expected["mob"])
        self.assertEqual(got["rarity"], expected["rarity"])
        self.assertEqual(got["variant"], expected["variant"])
        self.assertEqual(got["name"], expected["name"])
        self.assertEqual(got["killedBy"], "user_name")
        self.assertEqual(got["createdAt"], expected["spawnedAt"])
        self.assertEqual(got["killedAt"], "2026-10-21T12:05:00Z")
        self.assertTrue(got["dead"])

    def test_unknown_killer_fixture_has_no_killer(self):
        fixture = FIXTURES["edit_unknown_killer"]
        message = fake_message(fixture["after"])
        got = self.parser.parse_death(
            message_texts(message), message_id=str(message.id),
            created_at=message.created_at, edited_at=message.edited_at,
        )[0]
        self.assertIsNone(got["killedBy"])
        self.assertEqual(got["name"], "Omega Urchin")
        self.assertEqual(got["createdAt"], "2026-10-21T12:42:22.613000Z")
        self.assertEqual(got["killedAt"], "2026-10-21T12:54:40.571000Z")

    def test_killer_underscores_are_preserved_and_damage_suffix_removed(self):
        fixture = FIXTURES["killer_underscores"]
        message = fake_message(fixture["message"])
        got = self.parser.parse_death(
            message_texts(message), message_id=str(message.id),
            created_at=message.created_at, edited_at=message.edited_at,
        )[0]
        self.assertEqual(got["killedBy"], "_DNA_")
        got = death_event(
            self.parser, text="An Omega Urchin was defeated by @Ryan_xu with 1% damage!"
        )
        self.assertEqual(got["killedBy"], "Ryan_xu")
        # No damage clause must not eat trailing underscores from the name.
        got = death_event(
            self.parser, text="An Omega Urchin was defeated by @_DNA_!"
        )
        self.assertEqual(got["killedBy"], "_DNA_")

    def test_death_parser_rejects_crafts_and_unknown_identities(self):
        for text in [
            "A Sweet Omega Dragon has spawned!",
            "x2 Super Bone crafted by @player!",
            "An Omega Unknown New Mob was defeated!",
            "An UnknownVariant Omega Rock was defeated!",
            "Mob Defeated!",
            "Mob Spawned!",
        ]:
            self.assertEqual(
                self.parser.parse_death(
                    [text], message_id="x", created_at=datetime.now(UTC),
                    edited_at=datetime.now(UTC),
                ), [],
                text,
            )

    def test_embeds_and_duplicate_content(self):
        description = "A Charged Omega Mantis has spawned!"
        message = SimpleNamespace(
            content=description,
            embeds=[SimpleNamespace(title="Mob Spawned!", description=description, fields=[])],
        )
        result = self.parser.parse(message_texts(message), message_id="z",
                                   created_at=datetime.now(UTC), historical=True)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["historical"])

    def test_every_catalog_mob_name(self):
        for mob in self.parser.mobs.values():
            got = spawn_event(self.parser, text=f"An Omega {mob['name']} has spawned!")
            self.assertEqual(got["mob"], mob["slug"])


class StoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parser = SpawnParser()

    def test_persistence_deduplication_and_retention(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.db"
            store = EventStore(path, retention=3)
            first = store.add_spawn(spawn_event(self.parser, "one"))
            self.assertIsNone(store.add_spawn(spawn_event(self.parser, "one")))
            store.close()
            store = EventStore(path, retention=3)
            second = store.add_spawn(spawn_event(self.parser, "two"))
            self.assertGreater(second["sequence"], first["sequence"])
            self.assertGreater(second["id"], first["id"])
            for message_id in ["three", "four", "five"]:
                store.add_spawn(spawn_event(self.parser, message_id))
            self.assertEqual(len(store.latest(100)), 3)
            self.assertEqual(store.after(second["sequence"])[-1]["messageId"], "five")
            store.close()

    def test_old_schema_migration_preserves_id_cursor_and_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            legacy = sqlite3.connect(path)
            legacy.execute(
                "CREATE TABLE spawns (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)"
            )
            for spawn_id, message_id in [(1, "1"), (5, "5"), (9, "9")]:
                payload = {
                    "key": f"{message_id}:0", "messageId": message_id, "mob": "rock",
                    "rarity": 8, "variant": "normal", "name": "Omega Rock",
                    "createdAt": "2026-10-21T12:00:00Z", "historical": True,
                    "source": "discord", "sourceUrl": "",
                }
                legacy.execute(
                    "INSERT INTO spawns(id, event_key, payload) VALUES (?,?,?)",
                    (spawn_id, payload["key"], json.dumps(payload)),
                )
            legacy.commit()
            legacy.close()

            store = EventStore(path, retention=10)
            self.assertEqual(store.cursor, 9)
            self.assertEqual(store.first_id, 1)
            latest = store.latest(10)
            self.assertEqual([event["id"] for event in latest], [1, 5, 9])
            self.assertEqual([event["sequence"] for event in latest], [1, 5, 9])
            self.assertTrue(all(event["type"] == "spawn" for event in latest))
            self.assertTrue(all(event["dead"] is False for event in latest))
            self.assertEqual([change["sequence"] for change in store.after(0)], [1, 5, 9])
            store.close()

            store = EventStore(path, retention=10)
            self.assertEqual(store.cursor, 9)
            self.assertEqual(len(store.after(0)), 3, "restart must not duplicate migration changes")
            added = store.add_spawn(spawn_event(self.parser, "10"))
            self.assertGreater(added["id"], 9)
            self.assertGreater(added["sequence"], 9)
            self.assertEqual(store.after(9)[-1]["messageId"], "10")
            store.close()

    def test_death_mutates_same_record_and_stale_payloads_do_not_resurrect(self):
        store = EventStore(":memory:")
        spawn = store.add_spawn(spawn_event(self.parser, "m"))
        death = store.add_death(death_event(self.parser, "m"))
        self.assertEqual(death["id"], spawn["id"])
        self.assertEqual(death["key"], "m:0")
        self.assertGreater(death["sequence"], spawn["sequence"])
        self.assertEqual(death["createdAt"], spawn["createdAt"])
        self.assertIsNone(store.add_death(death_event(self.parser, "m")))
        self.assertIsNone(store.add_spawn(spawn_event(self.parser, "m")))
        rows = store.latest(10)
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["dead"])
        self.assertEqual(rows[0]["killedBy"], "Alice")
        store.close()

    def test_death_sequence_above_spawn_id_does_not_skip_later_spawns(self):
        store = EventStore(":memory:")
        first = store.add_spawn(spawn_event(self.parser, "a"))
        death = store.add_death(death_event(self.parser, "a"))
        second = store.add_spawn(spawn_event(self.parser, "b"))
        self.assertEqual(death["id"], first["id"])
        self.assertGreater(death["sequence"], first["sequence"])
        self.assertGreater(second["sequence"], death["sequence"])
        self.assertEqual(
            [change["messageId"] for change in store.after(first["sequence"])], ["a", "b"]
        )
        self.assertEqual(
            [change["sequence"] for change in store.after(first["sequence"])],
            [death["sequence"], second["sequence"]],
        )
        store.close()

    def test_death_of_historical_spawn_is_fresh_and_keeps_spawn_time(self):
        store = EventStore(":memory:")
        spawn = store.add_spawn(spawn_event(self.parser, "old", historical=True))
        death = store.add_death(death_event(
            self.parser, "old", historical=False,
            created_at=datetime(2026, 10, 21, 12, 0, tzinfo=UTC),
            edited_at=datetime(2026, 10, 21, 21, 42, tzinfo=UTC),
        ))
        self.assertFalse(death["historical"])
        self.assertEqual(death["createdAt"], spawn["createdAt"])
        self.assertEqual(death["killedAt"], "2026-10-21T21:42:00Z")
        self.assertTrue(store.latest(10)[0]["dead"])
        store.close()

    def test_late_killer_correction_updates_state_without_resetting_death_time(self):
        store = EventStore(":memory:")
        store.add_spawn(spawn_event(self.parser, "m"))
        first = store.add_death(death_event(
            self.parser, "m", text="An Omega Tumbleweed was defeated!",
            edited_at=datetime(2026, 10, 21, 12, 10, tzinfo=UTC),
        ))
        self.assertIsNone(first["killedBy"])
        corrected = store.add_death(death_event(
            self.parser, "m", text="An Omega Tumbleweed was defeated by @Ryan_xu with 33% damage!",
            edited_at=datetime(2026, 10, 21, 12, 12, tzinfo=UTC),
        ))
        self.assertEqual(corrected["killedBy"], "Ryan_xu")
        self.assertEqual(corrected["killedAt"], "2026-10-21T12:10:00Z")
        self.assertGreater(corrected["sequence"], first["sequence"])
        self.assertIsNone(store.add_death(death_event(
            self.parser, "m", text="An Omega Tumbleweed was defeated by @Ryan_xu with 33% damage!",
            edited_at=datetime(2026, 10, 21, 12, 12, tzinfo=UTC),
        )))
        self.assertEqual(store.latest(10)[0]["killedBy"], "Ryan_xu")
        store.close()

    def test_first_observed_death_creates_dead_projection_only(self):
        store = EventStore(":memory:")
        death = store.add_death(death_event(
            self.parser, "late", text="An Omega Urchin was defeated!",
            created_at=datetime(2026, 10, 21, 12, 42, tzinfo=UTC),
            edited_at=datetime(2026, 10, 21, 12, 54, tzinfo=UTC),
            historical=True,
        ))
        self.assertEqual(death["key"], "late:0")
        self.assertEqual(death["createdAt"], "2026-10-21T12:42:00Z")
        self.assertTrue(death["dead"])
        changes = store.after(0)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["type"], "death")
        rows = store.latest(10)
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["dead"])
        store.close()

    def test_retention_counts_rows_and_bounds_change_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bounded.db"
            legacy = sqlite3.connect(path)
            legacy.execute(
                "CREATE TABLE spawns (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)"
            )
            for spawn_id in [1, 100]:
                payload = {
                    "key": f"legacy-{spawn_id}:0", "messageId": f"legacy-{spawn_id}",
                    "mob": "rock", "rarity": 8, "variant": "normal", "name": "Omega Rock",
                    "createdAt": "2026-10-21T12:00:00Z", "historical": True,
                    "source": "discord", "sourceUrl": "",
                }
                legacy.execute(
                    "INSERT INTO spawns(id, event_key, payload) VALUES (?,?,?)",
                    (spawn_id, payload["key"], json.dumps(payload)),
                )
            legacy.commit()
            legacy.close()

            store = EventStore(path, retention=2)
            added = store.add_spawn(spawn_event(self.parser, "new"))
            self.assertEqual(len(store.latest(100)), 2, "retention is row count, not id arithmetic")
            self.assertEqual([event["messageId"] for event in store.latest(100)], ["legacy-100", "new"])
            self.assertGreater(added["id"], 100)
            for index, killer in enumerate(["A", "B", "C", "D", "E"]):
                store.add_death(death_event(
                    self.parser, "new", text=f"An Omega Rock was defeated by @{killer} with 1% damage!",
                    edited_at=datetime(2026, 10, 21, 12, 10 + index, tzinfo=UTC),
                ))
            changes = store.after(0)
            self.assertLessEqual(len(changes), store.change_retention)
            self.assertGreater(store.first_id, 1)
            self.assertGreaterEqual(store.cursor, added["sequence"])
            store.close()


async def frame(response):
    lines = []
    while True:
        line = (await asyncio.wait_for(response.content.readline(), 2)).decode().strip()
        if not line:
            if any(s.startswith("data:") for s in lines):
                break
            lines = []
        else:
            lines.append(line)
    return {"event": next(s[7:] for s in lines if s.startswith("event: ")),
            "data": json.loads(next(s[6:] for s in lines if s.startswith("data: ")))}


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = EventStore(":memory:", retention=3)
        self.service = SpawnService(self.store)
        self.service.connected = True
        self.client = TestClient(TestServer(create_app(self.service, "private-test-token", heartbeat=0.05)))
        await self.client.start_server()
        self.headers = {"Authorization": "Bearer private-test-token"}

    async def asyncTearDown(self):
        await self.client.close()
        self.store.close()

    def spawn(self, message_id, historical=False):
        return self.service.publish(spawn_event(self.service.parser, message_id, historical=historical))

    def death(self, message_id, historical=False):
        return self.service.publish(death_event(self.service.parser, message_id, historical=historical))

    async def test_requires_bearer_and_rejects_invalid_cursor(self):
        self.assertEqual((await self.client.get("/api/status")).status, 401)
        self.assertEqual((await self.client.get("/api/status?token=private-test-token")).status, 401)
        self.assertEqual((await self.client.get("/healthz")).status, 200)
        self.assertEqual((await self.client.get("/api/stream?after=bad", headers=self.headers)).status, 400)

    async def test_snapshot_broadcast_and_death_resume(self):
        old = self.spawn("history", historical=True)
        response = await self.client.get("/api/stream", headers=self.headers)
        self.assertIn("text/event-stream", response.headers["Content-Type"])
        initial = await frame(response)
        self.assertEqual(initial["event"], "snapshot")
        self.assertTrue(initial["data"]["events"][0]["historical"])
        self.assertEqual(initial["data"]["events"][0]["sequence"], old["sequence"])
        await frame(response)  # status
        fresh = self.spawn("new")
        live = await frame(response)
        self.assertEqual(live["event"], "spawn")
        self.assertEqual(live["data"]["id"], fresh["id"])
        self.assertEqual(live["data"]["sequence"], fresh["sequence"])
        death = self.death("new")
        live = await frame(response)
        self.assertEqual(live["event"], "death")
        self.assertEqual(live["data"]["id"], fresh["id"], "stable id never moves")
        self.assertEqual(live["data"]["sequence"], death["sequence"])
        response.close()

        resumed = await self.client.get(
            "/api/stream", headers={**self.headers, "Last-Event-ID": str(old["sequence"])}
        )
        replay = await frame(resumed)
        self.assertTrue(replay["data"]["replay"])
        self.assertEqual(replay["data"]["id"], fresh["id"])
        resumed.close()

        resumed_death = await self.client.get(
            "/api/stream", headers={**self.headers, "Last-Event-ID": str(fresh["sequence"])}
        )
        replay = await frame(resumed_death)
        self.assertEqual(replay["event"], "death")
        self.assertEqual(replay["data"]["type"], "death")
        self.assertEqual(replay["data"]["sequence"], death["sequence"])
        resumed_death.close()

    async def test_polling_snapshot_delta_and_death_replay(self):
        spawn = self.spawn("history", historical=True)
        response = await self.client.get("/api/events", headers=self.headers)
        initial = await response.json()
        self.assertTrue(initial["snapshot"])
        self.assertEqual(initial["cursor"], spawn["sequence"])
        self.assertEqual(initial["events"][0]["id"], spawn["id"])
        fresh = self.spawn("live")
        response = await self.client.get(f"/api/events?after={spawn['sequence']}", headers=self.headers)
        delta = await response.json()
        self.assertFalse(delta["snapshot"])
        self.assertEqual([e["id"] for e in delta["events"]], [fresh["id"]])
        self.assertEqual([e["sequence"] for e in delta["events"]], [fresh["sequence"]])
        self.assertFalse(delta["events"][0]["historical"])

        death = self.death("live")
        response = await self.client.get(f"/api/events?after={fresh['sequence']}", headers=self.headers)
        delta = await response.json()
        self.assertFalse(delta["snapshot"])
        self.assertEqual(len(delta["events"]), 1)
        self.assertEqual(delta["events"][0]["id"], fresh["id"])
        self.assertEqual(delta["events"][0]["sequence"], death["sequence"])
        self.assertEqual(delta["events"][0]["type"], "death")
        self.assertEqual(delta["events"][0]["killedAt"], death["killedAt"])

        response = await self.client.get("/api/events", headers=self.headers)
        snapshot = await response.json()
        self.assertEqual(len(snapshot["events"]), 2)
        record = next(event for event in snapshot["events"] if event["id"] == fresh["id"])
        self.assertTrue(record["dead"])
        self.assertEqual(record["key"], fresh["key"])
        self.assertEqual(record["sequence"], death["sequence"])
        response = await self.client.get("/api/events?after=999", headers=self.headers)
        self.assertTrue((await response.json())["snapshot"])

    async def test_expired_cursor_resets_to_silent_snapshot(self):
        for i in range(8):
            self.spawn(str(i))
        self.assertGreater(self.store.first_id, 1)
        for cursor in ["1", "999"]:
            response = await self.client.get(f"/api/stream?after={cursor}", headers=self.headers)
            data = await frame(response)
            self.assertEqual(data["event"], "snapshot")
            self.assertTrue(data["data"]["reset"])
            response.close()

    async def test_status_reports_death_fields(self):
        self.spawn("s")
        self.death("s")
        response = await self.client.get("/api/status", headers=self.headers)
        status = await response.json()
        self.assertIn("lastDeathAt", status)
        self.assertIn("unparsedDeaths", status)
        self.assertEqual(status["cursor"], self.store.cursor)

    async def test_ingest_defeated_message_creates_no_spawn_alert(self):
        fixture = FIXTURES["edit_unknown_killer"]
        message = fake_message(fixture["after"])
        changes = self.service.ingest(message)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["type"], "death")
        self.assertEqual(len(self.service.store.after(0)), 1)
        self.assertEqual(self.service.last_spawn_at, None)
        self.assertEqual(self.service.last_death_at, changes[0]["killedAt"])


class RawEditTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.service = SimpleNamespace(ingest=Mock(return_value=[{"type": "death"}]))
        self.reader = ChannelReader(limit=1, backfill=False, service=self.service)
        self.message = fake_message(FIXTURES["edit_known_killer"]["after"])
        self.channel = SimpleNamespace(
            id=main.CHANNEL_ID, fetch_message=AsyncMock(return_value=self.message)
        )
        self.reader._channel = self.channel
        self.payload = SimpleNamespace(
            channel_id=main.CHANNEL_ID, message_id=self.message.id,
            guild_id=main.GUILD_ID, cached_message=None,
        )

    async def test_uncached_edit_fetches_configured_channel_message(self):
        await self.reader.on_raw_message_edit(self.payload)
        self.channel.fetch_message.assert_awaited_once_with(self.message.id)
        self.service.ingest.assert_called_once_with(self.message)

    async def test_cached_edit_is_left_to_on_message_edit(self):
        self.payload.cached_message = SimpleNamespace(id=self.message.id)
        await self.reader.on_raw_message_edit(self.payload)
        self.channel.fetch_message.assert_not_awaited()
        self.service.ingest.assert_not_called()

    async def test_other_channel_and_guild_are_ignored(self):
        other = SimpleNamespace(**{**self.payload.__dict__, "channel_id": 5})
        await self.reader.on_raw_message_edit(other)
        other_guild = SimpleNamespace(**{**self.payload.__dict__, "guild_id": 6})
        await self.reader.on_raw_message_edit(other_guild)
        self.channel.fetch_message.assert_not_awaited()
        self.service.ingest.assert_not_called()

    async def test_missing_or_forbidden_message_is_graceful(self):
        for error in [
            discord.NotFound(SimpleNamespace(status=404, reason="Not Found"), "Not Found"),
            discord.Forbidden(SimpleNamespace(status=403, reason="Forbidden"), "Forbidden"),
        ]:
            self.channel.fetch_message.side_effect = error
            await self.reader.on_raw_message_edit(self.payload)
        self.service.ingest.assert_not_called()

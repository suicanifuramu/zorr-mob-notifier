import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from aiohttp.test_utils import TestClient, TestServer

from notifier.api import SpawnService, create_app
from notifier.parser import SpawnParser, message_texts
from notifier.store import EventStore


def event(parser, text="A Demonic Omega Tumbleweed has spawned!", key="1", historical=False):
    return parser.parse([text], message_id=key, created_at=datetime.now(timezone.utc), historical=historical)[0]


class ParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parser = SpawnParser()

    def test_real_announcement_forms(self):
        cases = [
            ("An Omega Gravestone has spawned!", "gravestone", 8, "normal"),
            ("A Demonic Omega Tumbleweed has spawned!", "tumbleweed", 8, "demonic"),
            ("A Bloody Omega White Hole has spawned!", "white_hole", 8, "bloody"),
            ("A Super Gift has spawned!", "gift", 7, "normal"),
            ("**A Magic Omega Fly has spawned!**", "fly", 8, "magic"),
        ]
        for text, mob, rarity, variant in cases:
            with self.subTest(text=text):
                got = event(self.parser, text)
                self.assertEqual((got["mob"], got["rarity"], got["variant"]), (mob, rarity, variant))

    def test_no_defeat_craft_or_unknown_mob(self):
        for text in ["A Sweet Omega Dragon was defeated by @player!", "x2 Super Bone crafted by @player!", "An Omega Unknown New Mob has spawned!", "An UnknownVariant Omega Rock has spawned!", "Mob Spawned!"]:
            self.assertEqual(self.parser.parse([text], message_id="x", created_at=datetime.now(timezone.utc)), [])

    def test_embeds_and_duplicate_content(self):
        description = "A Charged Omega Mantis has spawned!"
        message = SimpleNamespace(content=description, embeds=[SimpleNamespace(title="Mob Spawned!", description=description, fields=[])])
        result = self.parser.parse(message_texts(message), message_id="z", created_at=datetime.now(timezone.utc), historical=True)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["historical"])

    def test_every_catalog_mob_name(self):
        for mob in self.parser.mobs.values():
            got = event(self.parser, f"An Omega {mob['name']} has spawned!")
            self.assertEqual(got["mob"], mob["slug"])


class StoreTests(unittest.TestCase):
    def test_persistence_deduplication_and_retention(self):
        parser = SpawnParser()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.db"
            store = EventStore(path, retention=3)
            first = store.add(event(parser, key="one"))
            self.assertIsNone(store.add(event(parser, key="one")))
            store.close()
            store = EventStore(path, retention=3)
            second = store.add(event(parser, key="two"))
            self.assertGreater(second["id"], first["id"])
            for key in ["three", "four", "five"]:
                store.add(event(parser, key=key))
            self.assertLessEqual(len(store.latest(100)), 3)
            self.assertEqual(store.after(second["id"])[-1]["messageId"], "five")
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

    async def test_requires_bearer_and_rejects_invalid_cursor(self):
        self.assertEqual((await self.client.get("/api/status")).status, 401)
        self.assertEqual((await self.client.get("/api/status?token=private-test-token")).status, 401)
        self.assertEqual((await self.client.get("/healthz")).status, 200)
        self.assertEqual((await self.client.get("/api/stream?after=bad", headers=self.headers)).status, 400)

    async def test_snapshot_broadcast_and_resume(self):
        old = self.service.publish(event(self.service.parser, key="history", historical=True))
        response = await self.client.get("/api/stream", headers=self.headers)
        self.assertIn("text/event-stream", response.headers["Content-Type"])
        initial = await frame(response)
        self.assertEqual(initial["event"], "snapshot")
        self.assertTrue(initial["data"]["events"][0]["historical"])
        await frame(response)  # status
        fresh = self.service.publish(event(self.service.parser, key="new"))
        live = await frame(response)
        self.assertEqual(live["event"], "spawn")
        self.assertEqual(live["data"]["id"], fresh["id"])
        response.close()
        resumed = await self.client.get("/api/stream", headers={**self.headers, "Last-Event-ID": str(old["id"])})
        replay = await frame(resumed)
        self.assertTrue(replay["data"]["replay"])
        self.assertEqual(replay["data"]["id"], fresh["id"])
        resumed.close()

    async def test_polling_snapshot_delta_and_cursor_reset(self):
        first = self.service.publish(event(self.service.parser, key="history", historical=True))
        response = await self.client.get("/api/events", headers=self.headers)
        initial = await response.json()
        self.assertTrue(initial["snapshot"])
        self.assertEqual(initial["cursor"], first["id"])
        fresh = self.service.publish(event(self.service.parser, key="live"))
        response = await self.client.get(f"/api/events?after={first['id']}", headers=self.headers)
        delta = await response.json()
        self.assertFalse(delta["snapshot"])
        self.assertEqual([e["id"] for e in delta["events"]], [fresh["id"]])
        self.assertFalse(delta["events"][0]["historical"])
        response = await self.client.get("/api/events?after=999", headers=self.headers)
        self.assertTrue((await response.json())["snapshot"])

    async def test_expired_and_future_cursor_reset_to_silent_snapshot(self):
        for i in range(5):
            self.service.publish(event(self.service.parser, key=str(i)))
        for cursor in ["1", "999"]:
            response = await self.client.get(f"/api/stream?after={cursor}", headers=self.headers)
            data = await frame(response)
            self.assertEqual(data["event"], "snapshot")
            self.assertTrue(data["data"]["reset"])
            response.close()

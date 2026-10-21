"""Authenticated, reconnectable SSE API for the Pages Functions proxy."""
from __future__ import annotations

import asyncio
import json
import secrets
from datetime import datetime, timezone

from aiohttp import web

from .parser import SpawnParser, message_texts
from .store import EventStore


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class SpawnService:
    def __init__(self, store: EventStore, *, demo: bool = False) -> None:
        self.store = store
        self.parser = SpawnParser()
        self.listeners: set[asyncio.Queue] = set()
        self.connected = False
        self.demo = demo
        self.started_at = now()
        self.last_message_at = None
        self.last_spawn_at = None
        self.backfill_complete = False
        self.unparsed_spawns = 0

    def status(self) -> dict:
        return {"connected": self.connected, "demo": self.demo, "startedAt": self.started_at,
                "lastMessageAt": self.last_message_at, "lastSpawnAt": self.last_spawn_at,
                "backfillComplete": self.backfill_complete, "cursor": self.store.cursor,
                "unparsedSpawns": self.unparsed_spawns}

    def ingest(self, message, *, historical: bool = False) -> None:
        self.last_message_at = now()
        texts = message_texts(message)
        events = self.parser.parse(texts, message_id=str(message.id), created_at=message.created_at,
                                   source_url=message.jump_url, historical=historical)
        if not events and any("has spawned" in text.lower() for text in texts):
            self.unparsed_spawns += 1
        for event in events:
            self.publish(event)

    def publish(self, event: dict) -> dict | None:
        event = self.store.add(event)
        if not event:
            return None
        self.last_spawn_at = event["createdAt"]
        for queue in tuple(self.listeners):
            if queue.full():
                # Disconnect a slow reader, which can resume from its persisted cursor.
                queue.get_nowait()
                queue.put_nowait(None)
                self.listeners.discard(queue)
            else:
                queue.put_nowait(event)
        return event


def sse(event: str, data: dict, cursor: int | None = None) -> bytes:
    prefix = f"id: {cursor}\n" if cursor is not None else ""
    return (prefix + f"event: {event}\ndata: " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode()


def create_app(service: SpawnService, token: str, *, heartbeat: float = 15) -> web.Application:
    if not token:
        raise ValueError("API_TOKEN is required for --serve")

    @web.middleware
    async def authenticate(request, handler):
        if request.path != "/healthz":
            supplied = request.headers.get("Authorization", "")
            if not secrets.compare_digest(supplied.encode(), ("Bearer " + token).encode()):
                return web.json_response({"error": "Unauthorized"}, status=401, headers={"Cache-Control": "no-store"})
        return await handler(request)

    app = web.Application(middlewares=[authenticate])

    async def health(_):
        return web.json_response({"ok": True})

    async def status(_):
        return web.json_response(service.status(), headers={"Cache-Control": "no-store"})

    async def stream(request):
        raw = request.headers.get("Last-Event-ID") or request.query.get("after", "0")
        if not raw.isdecimal() or len(raw) > 16:
            raise web.HTTPBadRequest(text="Invalid cursor")
        after = int(raw)
        if len(service.listeners) >= 1000:
            raise web.HTTPServiceUnavailable(text="Stream capacity reached")
        queue: asyncio.Queue = asyncio.Queue(maxsize=128)
        service.listeners.add(queue)
        response = web.StreamResponse(headers={
            "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform",
            "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
        })
        try:
            await response.prepare(request)
            await response.write(b"retry: 5000\n\n")
            current = service.store.cursor
            expired = after > current or (after and after < service.store.first_id - 1)
            if not after or expired:
                await response.write(sse("snapshot", {"events": service.store.latest(), "cursor": current,
                                                          "reset": bool(expired), "status": service.status()}, current))
                after = current
            else:
                for event in service.store.after(after):
                    await response.write(sse("spawn", {**event, "replay": True}, event["id"]))
                    after = event["id"]
            await response.write(sse("status", service.status()))
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=heartbeat)
                    if event is None:
                        break
                    if event["id"] > after:
                        await response.write(sse("spawn", event, event["id"]))
                        after = event["id"]
                except asyncio.TimeoutError:
                    await response.write(sse("status", service.status()))
        except (ConnectionResetError, ConnectionError):
            pass
        finally:
            service.listeners.discard(queue)
        return response

    app.router.add_get("/healthz", health)
    app.router.add_get("/api/status", status)
    app.router.add_get("/api/stream", stream)
    return app

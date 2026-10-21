"""Bounded persistent event history. SQLite sequence IDs survive restarts."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path


class EventStore:
    def __init__(self, path: str | Path, *, retention: int = 2000) -> None:
        self.retention = retention
        if str(path) != ":memory:":
            path = Path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        if str(path) != ":memory:":
            Path(path).chmod(0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS spawns (id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)")
        self.db.commit()

    @property
    def cursor(self) -> int:
        return self.db.execute("SELECT COALESCE(MAX(id),0) FROM spawns").fetchone()[0]

    @property
    def first_id(self) -> int:
        return self.db.execute("SELECT COALESCE(MIN(id),0) FROM spawns").fetchone()[0]

    def add(self, event: dict) -> dict | None:
        with self.db:
            cursor = self.db.execute("INSERT OR IGNORE INTO spawns(event_key,payload) VALUES (?,?)", (event["key"], json.dumps(event, ensure_ascii=False)))
            if not cursor.rowcount:
                return None
            event = {**event, "id": cursor.lastrowid}
            self.db.execute("DELETE FROM spawns WHERE id <= ?", (event["id"] - self.retention,))
            return event

    def latest(self, limit: int = 100) -> list[dict]:
        rows = self.db.execute("SELECT id,payload FROM spawns ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{**json.loads(payload), "id": i} for i, payload in reversed(rows)]

    def after(self, cursor: int) -> list[dict]:
        rows = self.db.execute("SELECT id,payload FROM spawns WHERE id > ? ORDER BY id", (cursor,)).fetchall()
        return [{**json.loads(payload), "id": i} for i, payload in rows]

    def close(self) -> None:
        self.db.close()

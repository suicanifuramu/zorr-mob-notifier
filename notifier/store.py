"""Bounded spawn/death/restart state with a monotonic change cursor.

The ``spawns`` table keeps the current projection of every retained spawn
(spawned or defeated). The ``restarts`` table keeps the latest restart
announcement per Discord message. The ``changes`` table is an append-only,
bounded log used as the delivery cursor. A death mutates the existing spawn row
and appends a change; it never creates a second row or reuses the stable event
key. A restart edit updates its row in place and keeps the original key/time.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

SCHEMA_VERSION = "1"


def _defaults(payload: dict) -> dict:
    """Backfill lifecycle fields for a projection written by an older build."""
    payload.setdefault("type", "spawn")
    payload.setdefault("dead", False)
    payload.setdefault("killedBy", None)
    payload.setdefault("killedAt", None)
    return payload


def _flat(payload: dict) -> dict:
    return {key: value for key, value in payload.items() if key not in ("id", "sequence")}


class EventStore:
    def __init__(self, path: str | Path, *, retention: int = 2000,
                 restart_retention: int = 100) -> None:
        self.retention = max(1, retention)
        self.restart_retention = max(1, restart_retention)
        # Keep enough change history to cover every retained projection even
        # when deaths append additional revisions.
        self.change_retention = self.retention * 2
        memory = str(path) == ":memory:"
        if not memory:
            path = Path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        if not memory:
            Path(path).chmod(0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS spawns (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "spawn_id INTEGER NOT NULL, event_key TEXT NOT NULL, payload TEXT NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS restarts (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)"
        )
        self.db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.execute("CREATE INDEX IF NOT EXISTS changes_event_key ON changes(event_key)")
        self._migrate()
        self.db.commit()

    # -- schema migration -------------------------------------------------

    def _migrate(self) -> None:
        """Convert legacy rows once, preserving their stable IDs and cursors.

        Old databases stored one row per spawn with no changelog. Each row
        becomes the initial spawn change at the same numeric cursor (IDs can be
        sparse because the old retention deleted by ID range).
        """
        with self.db:
            marker = self.db.execute(
                "SELECT value FROM meta WHERE key = 'schema_version'"
            ).fetchone()
            if marker is None:
                rows = self.db.execute(
                    "SELECT id, event_key, payload FROM spawns ORDER BY id"
                ).fetchall()
                for spawn_id, event_key, raw in rows:
                    payload = _defaults(json.loads(raw))
                    payload["sequence"] = spawn_id
                    self.db.execute(
                        "INSERT OR IGNORE INTO changes(id, spawn_id, event_key, payload) "
                        "VALUES (?,?,?,?)",
                        (spawn_id, spawn_id, event_key, json.dumps(_flat(payload), ensure_ascii=False)),
                    )
                    self.db.execute(
                        "UPDATE spawns SET payload = ? WHERE id = ?",
                        (json.dumps(payload, ensure_ascii=False), spawn_id),
                    )
                self.db.execute(
                    "INSERT INTO meta(key, value) VALUES ('schema_version', ?)",
                    (SCHEMA_VERSION,),
                )
            else:
                # A rollback to the old build can append rows without lifecycle
                # fields; repair them without resetting the cursor.
                self._repair_legacy_rows()

    def _repair_legacy_rows(self) -> None:
        rows = self.db.execute("SELECT id, event_key, payload FROM spawns ORDER BY id").fetchall()
        for spawn_id, event_key, raw in rows:
            payload = json.loads(raw)
            if "sequence" in payload and "type" in payload:
                continue
            payload = _defaults(payload)
            sequence = self.db.execute(
                "INSERT INTO changes(spawn_id, event_key, payload) VALUES (?,?,?)",
                (spawn_id, event_key, json.dumps(_flat(payload), ensure_ascii=False)),
            ).lastrowid
            payload["sequence"] = sequence
            self.db.execute(
                "UPDATE spawns SET payload = ? WHERE id = ?",
                (json.dumps(payload, ensure_ascii=False), spawn_id),
            )
        self._prune_changes()

    # -- helpers ----------------------------------------------------------

    def _prune_spawns(self) -> None:
        # Keep the newest projections by actual row count. Sparse historical
        # IDs make "id <= cursor - retention" incorrect.
        self.db.execute(
            "DELETE FROM spawns WHERE id < "
            "(SELECT id FROM spawns ORDER BY id DESC LIMIT 1 OFFSET ?)",
            (self.retention - 1,),
        )

    def _prune_changes(self) -> None:
        self.db.execute(
            "DELETE FROM changes WHERE id < "
            "(SELECT id FROM changes ORDER BY id DESC LIMIT 1 OFFSET ?)",
            (self.change_retention - 1,),
        )

    def _prune_restarts(self) -> None:
        rows = self.db.execute("SELECT id, payload FROM restarts").fetchall()
        if len(rows) <= self.restart_retention:
            return
        items = [
            (restart_id, json.loads(payload).get("createdAt") or "")
            for restart_id, payload in rows
        ]
        items.sort(key=lambda item: (item[1], item[0]), reverse=True)
        for restart_id, _ in items[self.restart_retention:]:
            self.db.execute("DELETE FROM restarts WHERE id = ?", (restart_id,))

    def _append_change(self, spawn_id: int, event_key: str, payload: dict) -> dict:
        clean = _flat(payload)
        sequence = self.db.execute(
            "INSERT INTO changes(spawn_id, event_key, payload) VALUES (?,?,?)",
            (spawn_id, event_key, json.dumps(clean, ensure_ascii=False)),
        ).lastrowid
        self._prune_changes()
        return {**clean, "id": spawn_id, "sequence": sequence}

    def _write_projection(self, spawn_id: int, payload: dict) -> None:
        self.db.execute(
            "UPDATE spawns SET payload = ? WHERE id = ?",
            (json.dumps(payload, ensure_ascii=False), spawn_id),
        )

    def _write_restart_projection(self, restart_id: int, payload: dict) -> None:
        self.db.execute(
            "UPDATE restarts SET payload = ? WHERE id = ?",
            (json.dumps(payload, ensure_ascii=False), restart_id),
        )

    # -- writes -----------------------------------------------------------

    def add(self, event: dict) -> dict | None:
        """Backward-compatible entry point; dispatches by event type."""
        if event.get("type") == "restart":
            return self.add_restart(event)
        return self.add_death(event) if event.get("type") == "death" else self.add_spawn(event)

    def add_spawn(self, event: dict) -> dict | None:
        """Record a spawn. Duplicates and stale spawn payloads are ignored."""
        with self.db:
            row = self.db.execute(
                "SELECT id, payload FROM spawns WHERE event_key = ?", (event["key"],)
            ).fetchone()
            if row is not None:
                # Repeated spawn ingest (duplicate edits, backfill) is a no-op,
                # and a dead projection is terminal: never resurrect it.
                return None
            projection = _defaults(_flat(event))
            projection.update({"type": "spawn", "dead": False, "killedBy": None, "killedAt": None})
            spawn_id = self.db.execute(
                "INSERT INTO spawns(event_key, payload) VALUES (?,?)",
                (event["key"], json.dumps(projection, ensure_ascii=False)),
            ).lastrowid
            change = self._append_change(spawn_id, event["key"], projection)
            projection["sequence"] = change["sequence"]
            self._write_projection(spawn_id, projection)
            self._prune_spawns()
            return {**projection, "id": spawn_id}

    def add_restart(self, event: dict) -> dict | None:
        """Record a server restart, updating the projection on later edits.

        Repeated identical ingests (history plus a live duplicate) are no-ops.
        An edited announcement can add maps or regions; those changes share the
        original stable key, id, and createdAt.
        """
        key = event["key"]
        incoming = _flat(event)
        with self.db:
            row = self.db.execute(
                "SELECT id, payload FROM restarts WHERE event_key = ?", (key,)
            ).fetchone()
            if row is not None:
                restart_id, raw = row
                existing = json.loads(raw)
                if incoming == {k: v for k, v in existing.items() if k not in ("id", "sequence")}:
                    return None
                merged = {**existing, **incoming}
                merged["key"] = existing.get("key", key)
                merged["createdAt"] = existing.get("createdAt") or incoming.get("createdAt")
                change = self._append_change(restart_id, key, merged)
                merged["sequence"] = change["sequence"]
                self._write_restart_projection(restart_id, merged)
                return {**merged, "id": restart_id}

            projection = _flat(event)
            restart_id = self.db.execute(
                "INSERT INTO restarts(event_key, payload) VALUES (?,?)",
                (key, json.dumps(projection, ensure_ascii=False)),
            ).lastrowid
            change = self._append_change(restart_id, key, projection)
            projection["sequence"] = change["sequence"]
            self._write_restart_projection(restart_id, projection)
            self._prune_restarts()
            return {**projection, "id": restart_id}

    def add_death(self, event: dict) -> dict | None:
        """Mark a spawn dead in place, or project a death seen without a spawn."""
        with self.db:
            row = self.db.execute(
                "SELECT id, event_key, payload FROM spawns WHERE event_key = ?", (event["key"],)
            ).fetchone()
            if row is None:
                # First observation is already defeated (e.g. a spawn older
                # than the retained window). Publish only the death revision so
                # no fictitious live spawn alert is emitted.
                projection = _defaults(_flat(event))
                projection.update({"type": "death", "dead": True})
                spawn_id = self.db.execute(
                    "INSERT INTO spawns(event_key, payload) VALUES (?,?)",
                    (event["key"], json.dumps(projection, ensure_ascii=False)),
                ).lastrowid
                change = self._append_change(spawn_id, event["key"], projection)
                projection["sequence"] = change["sequence"]
                self._write_projection(spawn_id, projection)
                self._prune_spawns()
                return {**projection, "id": spawn_id}

            spawn_id, event_key, raw = row
            existing = _defaults(json.loads(raw))
            merged = self._merge_death(existing, event)
            if merged is None:
                return None
            merged["historical"] = bool(event.get("historical"))
            change = self._append_change(spawn_id, event_key, merged)
            merged["sequence"] = change["sequence"]
            self._write_projection(spawn_id, merged)
            return {**merged, "id": spawn_id}

    def _merge_death(self, existing: dict, event: dict) -> dict | None:
        incoming = _flat(event)
        if existing.get("dead"):
            # A correction may add a killer, but the death time and identity
            # stay fixed. Repeated identical edits are no-ops.
            changed = False
            killer = incoming.get("killedBy")
            if killer and killer != existing.get("killedBy"):
                existing["killedBy"] = killer
                changed = True
            killed_at = incoming.get("killedAt")
            if killed_at and not existing.get("killedAt"):
                existing["killedAt"] = killed_at
                changed = True
            if not changed:
                return None
            return existing
        merged = {**existing, **incoming}
        # The stable spawn identity and spawn time never move on death.
        merged["createdAt"] = existing.get("createdAt") or incoming.get("createdAt")
        merged["type"] = "death"
        merged["dead"] = True
        merged["killedBy"] = incoming.get("killedBy") or existing.get("killedBy")
        merged["killedAt"] = existing.get("killedAt") or incoming.get("killedAt")
        return merged

    # -- reads ------------------------------------------------------------

    @property
    def cursor(self) -> int:
        return self.db.execute("SELECT COALESCE(MAX(id),0) FROM changes").fetchone()[0]

    @property
    def first_id(self) -> int:
        return self.db.execute("SELECT COALESCE(MIN(id),0) FROM changes").fetchone()[0]

    def latest(self, limit: int = 100) -> list[dict]:
        """Current projections (one row per message), oldest spawn ID first."""
        rows = self.db.execute(
            "SELECT id, payload FROM spawns ORDER BY id DESC LIMIT ?", (max(1, limit),)
        ).fetchall()
        return [{**json.loads(payload), "id": spawn_id} for spawn_id, payload in reversed(rows)]

    def latest_restarts(self, limit: int = 100) -> list[dict]:
        """Current restart projections, newest restart first."""
        rows = self.db.execute("SELECT id, payload FROM restarts").fetchall()
        items = [{**json.loads(payload), "id": restart_id} for restart_id, payload in rows]
        items.sort(key=lambda event: (event.get("createdAt") or "", event["id"]), reverse=True)
        return items[:max(1, limit)]

    def after(self, cursor: int) -> list[dict]:
        """Flat change records newer than the change cursor, chronologically."""
        rows = self.db.execute(
            "SELECT id, spawn_id, payload FROM changes WHERE id > ? ORDER BY id", (cursor,)
        ).fetchall()
        return [
            {**json.loads(payload), "id": spawn_id, "sequence": sequence}
            for sequence, spawn_id, payload in rows
        ]

    def close(self) -> None:
        self.db.close()

"""Parse mob spawn and death announcements.

The game edits a spawn announcement in place when the mob dies: the title
changes from "Mob Spawned!" to "Mob Defeated!" and the description gains a
killer (or not). Crafted and lobby announcements are never events.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

CATALOG_PATH = Path(__file__).resolve().parent.parent / "data" / "catalog.json"


def normalized_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def message_texts(message) -> list[str]:
    texts = [message.content or ""]
    for embed in message.embeds:
        texts.extend([embed.title or "", embed.description or ""])
        for field in embed.fields:
            texts.extend([field.name, field.value])
    return texts


def _clean(text: str, *, keep_underscores: bool) -> str:
    """Drop custom emoji and markdown emphasis that wraps announcement text.

    Killer names are literal game usernames and may contain underscores
    (``@_DNA_``), so death parsing must not strip ``_`` from the text. For
    spawn parsing the historical behaviour (strip all emphasis characters) is
    kept.
    """
    clean = re.sub(r"<a?:\w+:\d+>", " ", text)
    if keep_underscores:
        clean = clean.replace("**", "").replace("`", "").replace("~~", "")
        # Emphasis may wrap the whole sentence: "**A ... defeated!**". Do not
        # strip underscores here: they are part of literal killer usernames.
        clean = clean.strip().strip("*~ \t")
    else:
        clean = re.sub(r"[*_`~]", "", clean)
    return clean


def _timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class SpawnParser:
    def __init__(self, catalog: dict | None = None) -> None:
        catalog = catalog or json.loads(CATALOG_PATH.read_text())
        self.mobs = {normalized_name(m["name"]): m for m in catalog["mobs"]}
        self.rarities = {r["name"].lower(): r for r in catalog["rarities"]}
        self.variants = {v["name"].lower(): v for v in catalog["variants"]}
        variant_names = "|".join(re.escape(v["name"]) for v in catalog["variants"])
        rarity_names = "|".join(re.escape(r["name"]) for r in catalog["rarities"])
        self.pattern = re.compile(
            rf"^\s*(?:An?\s+)?(?:(?P<variant>{variant_names})\s+)?"
            rf"(?P<rarity>{rarity_names})\s+(?P<mob>[^\n!]+?)\s+has\s+spawned[!.]?",
            re.IGNORECASE | re.MULTILINE,
        )
        self.death_pattern = re.compile(
            rf"^\s*(?:An?\s+)?(?:(?P<variant>{variant_names})\s+)?"
            rf"(?P<rarity>{rarity_names})\s+(?P<mob>[^\n!]+?)\s+was\s+defeated"
            rf"(?:\s+by\s+(?P<killer>[@＠][^\n]+?))?"
            rf"\s*[!.]?\s*$",
            re.IGNORECASE | re.MULTILINE,
        )
        self.damage_suffix = re.compile(
            r"\s+with\s+\d+(?:\.\d+)?\s*%\s*damage\s*[!.]?\s*$", re.IGNORECASE
        )

    def _identity(self, match: re.Match, message_id: str, created_at: datetime,
                  source_url: str, historical: bool, source: str) -> dict | None:
        mob = self.mobs.get(normalized_name(match["mob"]))
        if not mob:
            return None
        rarity = self.rarities[match["rarity"].lower()]
        variant = self.variants[(match["variant"] or "Normal").lower()]
        prefix = "" if variant["slug"] == "normal" else variant["name"] + " "
        return {
            "messageId": str(message_id), "mob": mob["slug"],
            "rarity": rarity["id"], "variant": variant["slug"],
            "name": f"{prefix}{rarity['name']} {mob['name']}",
            "createdAt": _timestamp(created_at), "historical": historical,
            "source": source, "sourceUrl": source_url,
        }

    def parse(self, texts: list[str], *, message_id: str, created_at: datetime,
              source_url: str = "", historical: bool = False, source: str = "discord") -> list[dict]:
        events: list[dict] = []
        seen = set()
        for text in texts:
            clean = _clean(text, keep_underscores=False)
            for match in self.pattern.finditer(clean):
                mob = self.mobs.get(normalized_name(match["mob"]))
                if not mob:
                    continue
                rarity = self.rarities[match["rarity"].lower()]
                variant = self.variants[(match["variant"] or "Normal").lower()]
                identity = (mob["slug"], rarity["id"], variant["slug"])
                if identity in seen:
                    continue
                seen.add(identity)
                base = self._identity(match, message_id, created_at, source_url, historical, source)
                if base is None:
                    continue
                events.append({
                    "key": f"{message_id}:{len(events)}", **base,
                    "type": "spawn", "dead": False, "killedBy": None, "killedAt": None,
                })
        return events

    def parse_death(self, texts: list[str], *, message_id: str, created_at: datetime,
                    edited_at: datetime | None = None, source_url: str = "",
                    historical: bool = False, source: str = "discord") -> list[dict]:
        """Parse an in-place "Mob Defeated!" edit of a spawn announcement.

        ``created_at`` stays the original spawn time; the death time comes from
        the edit timestamp. The killer is a literal ``@name`` game username:
        underscores are preserved and the trailing damage clause is removed.
        An announcement without a ``by`` clause has no known killer.
        """
        events: list[dict] = []
        seen = set()
        for text in texts:
            clean = _clean(text, keep_underscores=True)
            for match in self.death_pattern.finditer(clean):
                mob = self.mobs.get(normalized_name(match["mob"]))
                if not mob:
                    continue
                rarity = self.rarities[match["rarity"].lower()]
                variant = self.variants[(match["variant"] or "Normal").lower()]
                identity = (mob["slug"], rarity["id"], variant["slug"])
                if identity in seen:
                    continue
                seen.add(identity)
                base = self._identity(match, message_id, created_at, source_url, historical, source)
                if base is None:
                    continue
                killer = None
                if match["killer"]:
                    killer = self.damage_suffix.sub("", match["killer"]).strip()
                    killer = killer.lstrip("@＠").strip() or None
                events.append({
                    "key": f"{message_id}:{len(events)}", **base,
                    "type": "death", "dead": True, "killedBy": killer,
                    "killedAt": _timestamp(edited_at or created_at),
                })
        return events

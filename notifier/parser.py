"""Parse spawn announcements, never crafted/defeated announcements."""
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

    def parse(self, texts: list[str], *, message_id: str, created_at: datetime,
              source_url: str = "", historical: bool = False, source: str = "discord") -> list[dict]:
        events = []
        seen = set()
        for text in texts:
            clean = re.sub(r"<a?:\w+:\d+>", " ", text)
            clean = re.sub(r"[*_`~]", "", clean)
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
                prefix = "" if variant["slug"] == "normal" else variant["name"] + " "
                stamp = created_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                events.append({
                    "key": f"{message_id}:{len(events)}", "messageId": str(message_id),
                    "mob": mob["slug"], "rarity": rarity["id"], "variant": variant["slug"],
                    "name": f"{prefix}{rarity['name']} {mob['name']}",
                    "createdAt": stamp, "historical": historical, "source": source,
                    "sourceUrl": source_url,
                })
        return events

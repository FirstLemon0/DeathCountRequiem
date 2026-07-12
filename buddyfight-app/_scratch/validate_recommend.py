#!/usr/bin/env python3
"""Validate the 3 generated recommend-* deck files + decksets.json entries.

Checks per deck:
  - recipe total >= 50
  - each cardId count <= 4
  - each cardId exists in data/cards/*.json
  - buddy id is one of the monster ids in recipe
  - flag exists in data/flags.json
  - flag fit: every card's world is in flag.allowedWorlds, or card.world == "ジェネリック",
    or card has deckAnyFlag set (special flags not tied to a world)

Also cross-checks the 3 deck files' total card count against
_scratch/recommend-parsed.json's corresponding entries.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DECKS_DIR = ROOT / "data" / "decks"
DECKSETS = ROOT / "data" / "decksets.json"
FLAGS = ROOT / "data" / "flags.json"
CARDS_DIR = ROOT / "data" / "cards"
PARSED = ROOT / "_scratch" / "recommend-parsed.json"

DECK_FILES = [
    "recommend-201506-ultra-hissatsu.json",
    "recommend-201507-galaxy-burst.json",
    "recommend-201508-w-hero-wars.json",
    "recommend-201604-hanate-hissatsuryu.json",
    "recommend-201605-buddy-collection.json",
]


def load_cards():
    by_id = {}
    for fn in CARDS_DIR.glob("*.json"):
        data = json.loads(fn.read_text(encoding="utf-8"))
        cards = data["cards"] if isinstance(data, dict) and "cards" in data else data
        for c in cards:
            by_id[c["id"]] = c
    return by_id


def load_flags():
    data = json.loads(FLAGS.read_text(encoding="utf-8"))
    return {f["id"]: f for f in data["flags"]}


def main():
    errors = []
    warnings = []

    cards_by_id = load_cards()
    flags_by_id = load_flags()

    parsed = json.loads(PARSED.read_text(encoding="utf-8"))
    parsed_by_key = {d["key"]: d for d in parsed if d.get("buildable")}

    decksets = json.loads(DECKSETS.read_text(encoding="utf-8"))
    decksets_by_id = {s["id"]: s for s in decksets["sets"]}

    total_decks = 0

    for fname in DECK_FILES:
        path = DECKS_DIR / fname
        if not path.exists():
            errors.append(f"[{fname}] missing file")
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        decks = data.get("decks", [])
        for deck in decks:
            total_decks += 1
            did = deck["id"]
            label = f"[{fname} / {did}]"

            # recipe total
            recipe = deck["recipe"]
            recipe_total = sum(count for _, count in recipe)
            if recipe_total < 50:
                errors.append(f"{label} recipe total = {recipe_total} (expected >=50)")

            # per-card count <= 4, existence
            seen_ids = set()
            for cid, count in recipe:
                if cid in seen_ids:
                    errors.append(f"{label} duplicate cardId in recipe: {cid}")
                seen_ids.add(cid)
                if count > 4:
                    errors.append(f"{label} cardId {cid} count={count} > 4")
                if cid not in cards_by_id:
                    errors.append(f"{label} cardId {cid} not found in data/cards/*.json")

            # buddy is a monster in recipe
            buddy = deck["buddy"]
            if buddy not in seen_ids:
                errors.append(f"{label} buddy {buddy} not present in recipe")
            else:
                bc = cards_by_id.get(buddy)
                if bc and bc.get("type") not in ("monster", "impactMonster"):
                    # 必殺モンスターのバディ指定は公式レシピに実在（201605_5等）。builder.js も
                    # ["monster","impactMonster"] を許容しており、エンジンは effectiveCardType で正規化する。
                    errors.append(f"{label} buddy {buddy} is not a monster (got {bc.get('type')})")

            # flag exists
            flag_id = deck["flag"]
            flag = flags_by_id.get(flag_id)
            if flag is None:
                errors.append(f"{label} flag {flag_id} not found in data/flags.json")
                continue

            allowed_worlds = set(flag.get("allowedWorlds") or [])
            allowed_attributes = set(flag.get("allowedAttributes") or [])

            # flag fit check
            # Regular flags gate by world (allowedWorlds); special flags (e.g.
            # 百鬼夜行/天国/地獄/カオス/雷帝軍) gate by card attribute instead
            # (allowedAttributes) — see memory "special-flags-not-worlds".
            for cid, _count in recipe:
                c = cards_by_id.get(cid)
                if c is None:
                    continue  # already reported above
                world = c.get("world")
                attrs = set(c.get("attributes") or [])
                any_flag = c.get("deckAnyFlag")
                if world == "ジェネリック" or any_flag:
                    continue
                if allowed_worlds and world in allowed_worlds:
                    continue
                if allowed_attributes and (attrs & allowed_attributes):
                    continue
                errors.append(
                    f"{label} card {cid} ({c.get('name')}) world={world!r} attrs={sorted(attrs)} "
                    f"not compatible with flag {flag_id} "
                    f"allowedWorlds={sorted(allowed_worlds)} allowedAttributes={sorted(allowed_attributes)} "
                    f"and no deckAnyFlag"
                )

        # cross-check vs parsed.json entries for this group, by matching deck ids
        for deck in decks:
            key = deck["id"].replace("recommend-", "").replace("-", "_", 1)
            # id like recommend-201506-1 -> key 201506_1
            parsed_entry = parsed_by_key.get(key)
            if parsed_entry is None:
                warnings.append(f"[{fname} / {deck['id']}] no matching parsed.json key {key!r}")
                continue
            expected_total = parsed_entry["total"]
            recipe_total = sum(count for _, count in deck["recipe"])
            if recipe_total != expected_total:
                errors.append(
                    f"[{fname} / {deck['id']}] recipe total {recipe_total} != parsed.json total {expected_total}"
                )

    # decksets.json entries present
    expected_set_ids = [
        "recommend-201506-ultra-hissatsu",
        "recommend-201507-galaxy-burst",
        "recommend-201508-w-hero-wars",
    ]
    for sid in expected_set_ids:
        if sid not in decksets_by_id:
            errors.append(f"decksets.json missing entry {sid}")
        else:
            s = decksets_by_id[sid]
            if s.get("category") != "developer":
                errors.append(f"decksets.json {sid} category={s.get('category')!r} (expected 'developer')")
            if s.get("series") != "100":
                errors.append(f"decksets.json {sid} series={s.get('series')!r} (expected '100')")

    print(f"validated {total_decks} decks across {len(DECK_FILES)} files")

    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for w in warnings:
            print(" -", w)

    if errors:
        print(f"\n{len(errors)} ERROR(s):")
        for e in errors:
            print(" -", e)
        sys.exit(1)
    else:
        print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()

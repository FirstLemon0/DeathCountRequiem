#!/usr/bin/env python3
"""Generate recommend-* deck files + decksets.json entries from
_scratch/recommend-parsed.json (buildable entries only).

Re-runnable: overwrites the 3 deck files and rewrites decksets.json
(replacing any prior recommend-* entries) each time it's run.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARSED = ROOT / "_scratch" / "recommend-parsed.json"
DECKS_DIR = ROOT / "data" / "decks"
DECKSETS = ROOT / "data" / "decksets.json"

# group definition: output file stem -> (keys in order, decksets meta)
GROUPS = [
    {
        "file": "recommend-201506-ultra-hissatsu.json",
        "keys": ["201506_1", "201506_2", "201506_3", "201506_4"],
        "set_id": "recommend-201506-ultra-hissatsu",
        "set_name": "開発チームおすすめ「ウルトラ!! 必殺パック」",
        "releaseOrder": 510,
    },
    {
        "file": "recommend-201507-galaxy-burst.json",
        "keys": ["201507_1", "201507_2", "201507_3", "201507_4"],
        "set_id": "recommend-201507-galaxy-burst",
        "set_name": "開発チームおすすめ「ギャラクシー・バースト」",
        "releaseOrder": 520,
    },
    {
        "file": "recommend-201508-w-hero-wars.json",
        "keys": ["201508_1", "201508_2"],
        "set_id": "recommend-201508-w-hero-wars",
        "set_name": "開発チームおすすめ「Wヒーロー大戦」",
        "releaseOrder": 530,
    },
    {
        "file": "recommend-201604-hanate-hissatsuryu.json",
        "keys": [f"201604_{i}" for i in range(1, 6)],
        "set_id": "recommend-201604-hanate-hissatsuryu",
        "set_name": "開発チームおすすめ「放て！必殺竜!!」",
        "releaseOrder": 540,
        "series": "DDD",
    },
    {
        "file": "recommend-201605-buddy-collection.json",
        "keys": [f"201605_{i}" for i in range(1, 26)],
        "set_id": "recommend-201605-buddy-collection",
        "set_name": "開発チームおすすめ「バディファイト コレクション」",
        "releaseOrder": 550,
        "series": "DDD",
        "name_prefix_flag": True,
    },
]

CATEGORY = "developer"
SERIES = "100"

TITLE_NAME_RE = re.compile(r"「([^」]*)」")


def extract_name(title: str) -> str:
    matches = TITLE_NAME_RE.findall(title)
    if not matches:
        raise ValueError(f"no 「」 found in title: {title!r}")
    return matches[-1]


def build_recipe(cards):
    """cards: list of {name, no, count, id}. Merge duplicate ids (sum counts),
    preserving order of first appearance."""
    order = []
    totals = {}
    for c in cards:
        cid = c["id"]
        if cid not in totals:
            order.append(cid)
            totals[cid] = 0
        totals[cid] += c["count"]
    return [[cid, totals[cid]] for cid in order]


def main():
    parsed = json.loads(PARSED.read_text(encoding="utf-8"))
    by_key = {d["key"]: d for d in parsed if d.get("buildable")}

    new_set_entries = []

    for group in GROUPS:
        decks = []
        for key in group["keys"]:
            entry = by_key[key]
            deck_id = "recommend-" + key.replace("_", "-")
            name = extract_name(entry["title"])
            if group.get("name_prefix_flag"):
                name = f"【{entry['flagName']}】{name}"
            recipe = build_recipe(entry["cards"])
            decks.append(
                {
                    "id": deck_id,
                    "name": name,
                    "flag": entry["flagId"],
                    "buddy": entry["buddyId"],
                    "recipe": recipe,
                }
            )

        out = {"schemaVersion": 1, "decks": decks}
        out_path = DECKS_DIR / group["file"]
        out_path.write_text(
            json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"wrote {out_path} ({len(decks)} decks)")

        new_set_entries.append(
            {
                "id": group["set_id"],
                "name": group["set_name"],
                "file": f"data/decks/{group['file']}",
                "category": CATEGORY,
                "series": group.get("series", SERIES),
                "releaseOrder": group["releaseOrder"],
            }
        )

    decksets = json.loads(DECKSETS.read_text(encoding="utf-8"))
    recommend_ids = {g["set_id"] for g in GROUPS}
    decksets["sets"] = [
        s for s in decksets["sets"] if s["id"] not in recommend_ids
    ] + new_set_entries
    DECKSETS.write_text(
        json.dumps(decksets, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"updated {DECKSETS} (+{len(new_set_entries)} recommend sets)")


if __name__ == "__main__":
    main()

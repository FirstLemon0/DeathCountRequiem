#!/usr/bin/env python3
"""Parse the 2016 recommend recipe pages (201604_1..5, 201605_1..25) from
_scratch/recipes/*.html, cross-check against the stored parse in
_scratch/recommend-parsed.json, resolve card ids against the current card DB
(no -> id first, normalized unique name as fallback), and rewrite
recommend-parsed.json entries for those keys (ids filled, buddyId, buildable).

Usage: python3 _scratch/parse_recommend_2016.py [--dry-run]
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECIPES = ROOT / "_scratch" / "recipes"
PARSED = ROOT / "_scratch" / "recommend-parsed.json"
CARDS_DIR = ROOT / "data" / "cards"
FLAGS = ROOT / "data" / "flags.json"

KEYS = (
    [f"201604_{i}" for i in range(1, 6)]
    + [f"201605_{i}" for i in range(1, 26)]
    + [f"201606_{i}" for i in range(1, 8)]  # 超ヒーロー大戦Z（D-EB02実装後に追加・旧解析なし）
)


def norm_name(s):
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"\s+", "", s)
    s = s.replace("“", '"').replace("”", '"').replace("’", "'")
    s = s.replace("〜", "~").replace("～", "~")
    return s


def load_db():
    by_no = {}
    by_name = {}
    name_of = {}
    for fn in sorted(CARDS_DIR.glob("*.json")):
        data = json.loads(fn.read_text(encoding="utf-8"))
        cards = data["cards"] if isinstance(data, dict) and "cards" in data else data
        for c in cards:
            no = c.get("no")
            if no and no not in by_no:
                by_no[no] = c["id"]
            by_name.setdefault(norm_name(c["name"]), []).append(c["id"])
            name_of[c["id"]] = norm_name(c["name"])
    return by_no, by_name, name_of


IMG_SET_PREFIX = {
    "deb": "D-EB", "dbt": "D-BT", "dsd": "D-SD",
    "hbt": "H-BT", "heb": "H-EB", "hss": "H-SS", "htd": "H-TD",
    "hsd": "H-SD", "hpp": "H-PP",
}


def no_from_img(base):
    """images/card/<base>.png -> official card no. e.g. deb_01_0014_m -> D-EB01/0014,
    dbt_01_0002_w_m -> D-BT01/0002, pr_0147_m -> PR/0147, dcr_0006_m -> D-CR/0006."""
    parts = base.split("_")
    while parts and parts[-1] in ("m", "w"):
        parts.pop()
    if len(parts) == 3 and parts[0] in IMG_SET_PREFIX:
        return f"{IMG_SET_PREFIX[parts[0]]}{parts[1]}/{parts[2]}"
    if len(parts) == 2 and parts[0] == "pr":
        return f"PR/{parts[1]}"
    if len(parts) == 2 and parts[0] == "dcr":
        return f"D-CR/{parts[1]}"
    return None


def parse_page(path):
    html = path.read_text(encoding="utf-8")
    title_m = re.search(r'<h3>(.*?)</h3>', html, re.S)
    title = re.sub(r"<[^>]+>", "", title_m.group(1)).strip() if title_m else None

    fb = re.search(r'<table class="flag_buddy">(.*?)</table>', html, re.S)
    ths = re.findall(r"<th[^>]*>(.*?)</th>", fb.group(1), re.S)
    flag_name = re.sub(r"<[^>]+>", "", ths[0]).strip()
    buddy_name = re.sub(r"<[^>]+>", "", ths[1]).strip()
    buddy_td = re.search(r'<td class="buddy">(.*?)</td>', fb.group(1), re.S)
    buddy_no_m = re.search(r"cardno=([A-Z0-9\-]+/\d+)", buddy_td.group(1))
    if buddy_no_m:
        buddy_no = buddy_no_m.group(1)
    else:
        img_m = re.search(r"images/card/([a-z0-9_]+)\.png", buddy_td.group(1))
        buddy_no = no_from_img(img_m.group(1)) if img_m else None

    cards = []
    for li in re.findall(r"<li>(.*?)</li>", html, re.S):
        cnt_m = re.search(r'class="cardx(\d+)"', li)
        name_m = re.search(r"<h5><span>(.*?)</span></h5>", li, re.S)
        if not (cnt_m and name_m):
            continue
        no_m = re.search(r"cardno=([A-Z0-9\-]+/\d+)", li)
        if no_m:
            no = no_m.group(1)
        else:
            img_m = re.search(r"images/card/([a-z0-9_]+)\.png", li)
            no = no_from_img(img_m.group(1)) if img_m else None
        cards.append(
            {
                "name": re.sub(r"<[^>]+>", "", name_m.group(1)).strip(),
                "no": no,
                "count": int(cnt_m.group(1)),
            }
        )
    return {
        "title": title,
        "flagName": flag_name,
        "buddyName": buddy_name,
        "buddyNo": buddy_no,
        "cards": cards,
        "total": sum(c["count"] for c in cards),
    }


def main():
    dry = "--dry-run" in sys.argv
    by_no, by_name, name_of = load_db()
    flags = {f["name"]: f["id"] for f in json.loads(FLAGS.read_text(encoding="utf-8"))["flags"]}

    parsed = json.loads(PARSED.read_text(encoding="utf-8"))
    by_key = {d["key"]: d for d in parsed}

    errors = []
    for key in KEYS:
        page = parse_page(RECIPES / f"{key}.html")
        old = by_key.get(key)
        if old is None:
            # 旧解析に無い新規キー（201606〜）: フレッシュ解析からエントリを新設。
            # 2重解析の突合はできないが、total=50・全ID解決・buddy在中・validate_recommend で担保する。
            old = {
                "key": key,
                "title": page["title"],
                "url": f"https://fc-buddyfight.com/recipe/recommend/{key}",
                "flagName": page["flagName"],
                "flagId": None,
                "buddyName": page["buddyName"],
                "buddyId": None,
                "cards": [],
                "total": page["total"],
                "missing": [],
                "buildable": False,
            }
            parsed.append(old)
            by_key[key] = old
        else:
            # --- cross-check fresh parse vs stored parse (by name+count; stored 201605 lacks no) ---
            if page["flagName"] != old["flagName"]:
                errors.append(f"{key}: flagName mismatch {page['flagName']!r} vs {old['flagName']!r}")
            if norm_name(page["buddyName"]) != norm_name(old["buddyName"]):
                errors.append(f"{key}: buddyName mismatch {page['buddyName']!r} vs {old['buddyName']!r}")
            fresh = {norm_name(c["name"]): c["count"] for c in page["cards"]}
            stored = {norm_name(c["name"]): c["count"] for c in old["cards"]}
            if fresh != stored:
                only_f = {k: v for k, v in fresh.items() if stored.get(k) != v}
                only_s = {k: v for k, v in stored.items() if fresh.get(k) != v}
                errors.append(f"{key}: card list mismatch fresh-only={only_f} stored-only={only_s}")
            if page["total"] != old.get("total"):
                errors.append(f"{key}: total mismatch fresh={page['total']} stored={old.get('total')}")
        if page["total"] != 50:
            errors.append(f"{key}: total {page['total']} != 50")

        # fresh parse carries the more complete `no` (img-derived); make it canonical
        old["cards"] = page["cards"]

        # --- resolve ids (no -> id, but only if the name agrees: official pages
        # occasionally mislabel a cardno, e.g. 201604_4 踊るぜ！アスモダイ as D-BT01/0013) ---
        unresolved = []
        for c in old["cards"]:
            cid = by_no.get(c["no"])
            if cid is not None and name_of.get(cid) != norm_name(c["name"]):
                cid = None  # official cardno typo -> resolve by name instead
            if cid is None:
                names = by_name.get(norm_name(c["name"]), [])
                if len(set(names)) == 1:
                    cid = names[0]
                elif len(set(names)) > 1:
                    # multiple prints of same name; pick deterministic first
                    cid = sorted(set(names))[0]
            if cid is None:
                unresolved.append(f"{c['no']} {c['name']}")
            else:
                c["id"] = cid
        if unresolved:
            errors.append(f"{key}: unresolved cards: {unresolved}")
            continue

        # buddy: resolve by page buddyNo, must be in recipe
        buddy_id = by_no.get(page["buddyNo"])
        if buddy_id is None:
            names = by_name.get(norm_name(page["buddyName"]), [])
            buddy_id = names[0] if len(set(names)) == 1 else None
        recipe_ids = {c["id"] for c in old["cards"]}
        if buddy_id not in recipe_ids:
            # buddy print may differ from the print used in the list: match by name within recipe
            cand = [c["id"] for c in old["cards"] if norm_name(c["name"]) == norm_name(page["buddyName"])]
            if cand:
                buddy_id = cand[0]
        if buddy_id is None or buddy_id not in recipe_ids:
            errors.append(f"{key}: buddy unresolved ({page['buddyName']} {page['buddyNo']} -> {buddy_id})")
            continue
        old["buddyId"] = buddy_id

        flag_id = flags.get(page["flagName"])
        if flag_id is None:
            errors.append(f"{key}: unknown flag {page['flagName']!r}")
            continue
        if old.get("flagId") is None:
            old["flagId"] = flag_id
        elif old.get("flagId") != flag_id:
            errors.append(f"{key}: flagId mismatch stored={old.get('flagId')} derived={flag_id}")

        old["missing"] = []
        old["buildable"] = True
        print(f"{key}: OK ({len(old['cards'])} kinds / {page['total']} cards, flag={flag_id}, buddy={buddy_id})")

    if errors:
        print("\n=== ERRORS ===")
        for e in errors:
            print(" -", e)
        sys.exit(1)

    if not dry:
        PARSED.write_text(json.dumps(parsed, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"\nupdated {PARSED}")
    print("=== parse+match OK (30 recipes) ===")


if __name__ == "__main__":
    main()

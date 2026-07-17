// デッキ共有コード（BFD1）の共通ロジック。ブラウザ(classic script)とNode(CommonJS)の両方で使う
// デュアル環境モジュール。builder.js の encodeDeckShareCode/decodeDeckShareCode/toBase64Url/
// fromBase64Url（builder.js:938-964）と同一ロジック。builder.js 自体はここでは編集しない
// （builder.js 側の切替は別班が行う）。
//
// ブラウザでは <script src="deck-code.js"></script> でグローバル関数を定義する。
// Node（server/authoritative-server.js 等）では require("./deck-code") で同じ関数群を得る。

// ---- base64url（UTF-8安全）。ブラウザは btoa/atob、Node には無いため Buffer にフォールバック ----
function toBase64Url(str) {
  const escaped = unescape(encodeURIComponent(str));
  const b64 = typeof btoa === "function" ? btoa(escaped) : Buffer.from(escaped, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(code) {
  let b = String(code || "").replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  const escaped = typeof atob === "function" ? atob(b) : Buffer.from(b, "base64").toString("binary");
  return decodeURIComponent(escape(escaped));
}

// deck: {name, flag, buddy, recipe:[[cardId,count],...]}
function encodeDeckShareCode(deck) {
  const d = deck || {};
  const payload = [1, d.name || "", d.flag || "", d.buddy || "", d.recipe || []]; // [version, name, flag, buddy, recipe]
  return "BFD1." + toBase64Url(JSON.stringify(payload));
}

// 構造的な復号のみ行う（base64/JSON破損は例外）。ver/flag/recipe 等の意味論チェックは
// validateDeckCodePayload に委ねる（サーバ側は保存前に必ず validateDeckCodePayload を通す）。
function decodeDeckShareCode(code) {
  const body = String(code || "").trim().replace(/^BFD1\./, "");
  let arr;
  try {
    arr = JSON.parse(fromBase64Url(body));
  } catch {
    throw new Error("共有コードをデコードできません");
  }
  if (!Array.isArray(arr) || arr.length < 5) {
    throw new Error("共有コードの形式が不正です");
  }
  const [ver, name, flag, buddy, recipe] = arr;
  return { ver, name, flag, buddy, recipe };
}

// E-PR10(PR/0343等 limitWith): 「『A』と『B』は合わせてN枚までデッキに入れられる」というデッキ構築制約用。
// カードは投入上限の「グループ名」を、自分の name ではなく limitWith の値で数える（グループ名 = limitWith || name）。
// この関数は cards 配列（{id,name,limitWith} を持てば十分）から「id→グループ名」の写像を作る。
//   ・limitWith を1枚も含まなければ null を返す（＝グループ制約なし＝完全後方互換）。
//   ・返り値を validateDeckCodePayload の opts.limitGroups に渡すと、グループ合計>上限(4)を弾く。
// PR側カードだけが limitWith を持ち、本流側（竜気百倍 等）は無改変。両者が同一グループ名に落ちて合算される。
function buildLimitGroups(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const linkedNames = new Set();
  for (const card of list) {
    if (card && card.limitWith) linkedNames.add(card.limitWith);
  }
  if (linkedNames.size === 0) return null; // limitWith 皆無＝グループ制約なし（後方互換）
  const map = Object.create(null);
  for (const card of list) {
    if (!card || !card.id) continue;
    const key = card.limitWith || card.name;
    if (key && linkedNames.has(key)) map[card.id] = key;
  }
  return map;
}

// payload: decodeDeckShareCode() の戻り値（{ver,name,flag,buddy,recipe}）。
// opts.cardIds / opts.flagIds: Set<string> または string[]（実在チェック用の全カード/全フラッグID集合）。
// 戻り値: {ok:true, normalized:{name,flag,buddy,recipe}} | {ok:false, reason}
// 保存の下限枚数（50枚以上）はここでは検証しない＝作りかけのWIPデッキも保存可とする。
function validateDeckCodePayload(payload, opts) {
  const options = opts || {};
  const cardIds = options.cardIds instanceof Set ? options.cardIds : new Set(options.cardIds || []);
  const flagIds = options.flagIds instanceof Set ? options.flagIds : new Set(options.flagIds || []);
  // E-XC3(X-CP01/0043 キャノンボール隊): deckUnlimitedCopies なカードIDの集合。ここに含まれるIDは同名投入上限が
  // Infinity（4枚超を許容）。未指定＝空集合＝全カード従来どおり4枚上限（完全後方互換）。
  const unlimitedCardIds =
    options.unlimitedCardIds instanceof Set ? options.unlimitedCardIds : new Set(options.unlimitedCardIds || []);
  // E-PR10(limitWith): id→グループ名の写像（buildLimitGroups の出力）。未指定/null＝グループ制約を課さない
  // ＝共有コード検証は従来どおり（完全後方互換）。ここでのグループ上限は per-ID と同じフラット4（この検証は
  // フラッグ非依存の粗い構造ゲートで deckAnyFlag のホーム/非ホーム上限も課さないため、グループも4で統一）。
  const limitGroups =
    options.limitGroups && typeof options.limitGroups === "object" ? options.limitGroups : null;

  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "invalid payload" };
  }
  if (payload.ver !== 1) {
    return { ok: false, reason: "未対応の共有コードバージョン" };
  }
  const name = payload.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 60) {
    return { ok: false, reason: "デッキ名は1〜60字で指定してください" };
  }
  const flag = payload.flag;
  if (typeof flag !== "string" || !flag || !flagIds.has(flag)) {
    return { ok: false, reason: "不明なフラッグです" };
  }
  let buddy = payload.buddy;
  if (buddy === undefined || buddy === "" || buddy === null) {
    buddy = null;
  } else if (typeof buddy !== "string" || !cardIds.has(buddy)) {
    return { ok: false, reason: "不明なバディです" };
  }
  if (!Array.isArray(payload.recipe)) {
    return { ok: false, reason: "recipe の形式が不正です" };
  }
  const normalizedRecipe = [];
  const seenIds = new Set();
  let totalCount = 0;
  for (const entry of payload.recipe) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return { ok: false, reason: "recipe のエントリ形式が不正です" };
    }
    const [id, countRaw] = entry;
    if (typeof id !== "string" || !id || !cardIds.has(id)) {
      return { ok: false, reason: `不明なカードです: ${id}` };
    }
    if (seenIds.has(id)) {
      return { ok: false, reason: `カードIDが重複しています: ${id}` };
    }
    const count = Number(countRaw);
    const maxCopies = unlimitedCardIds.has(id) ? Infinity : 4; // E-XC3: 無制限投入カードは上限なし
    if (!Number.isInteger(count) || count < 1 || count > maxCopies) {
      return { ok: false, reason: `カード枚数が不正です: ${id}` };
    }
    seenIds.add(id);
    normalizedRecipe.push([id, count]);
    totalCount += count;
  }
  if (normalizedRecipe.length > 100) {
    return { ok: false, reason: "デッキのカード種類数が上限(100種)を超えています" };
  }
  if (totalCount > 200) {
    return { ok: false, reason: "デッキの合計枚数が上限(200枚)を超えています" };
  }
  // E-PR10(limitWith): 「AとBは合わせて4枚まで」のグループ合計を検証（limitGroups 未指定＝空＝スキップ＝後方互換）。
  if (limitGroups) {
    const groupTotals = new Map();
    for (const [id, count] of normalizedRecipe) {
      const key = limitGroups[id];
      if (key == null) continue; // グループ非所属のカードは従来どおり per-ID のみ
      groupTotals.set(key, (groupTotals.get(key) || 0) + count);
    }
    for (const [key, sum] of groupTotals) {
      if (sum > 4) {
        return { ok: false, reason: `『${key}』グループは合わせて4枚までです（${sum}枚）` };
      }
    }
  }
  return {
    ok: true,
    normalized: { name, flag, buddy, recipe: normalizedRecipe },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    toBase64Url,
    fromBase64Url,
    encodeDeckShareCode,
    decodeDeckShareCode,
    validateDeckCodePayload,
    buildLimitGroups,
  };
}

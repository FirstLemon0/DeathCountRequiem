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

// payload: decodeDeckShareCode() の戻り値（{ver,name,flag,buddy,recipe}）。
// opts.cardIds / opts.flagIds: Set<string> または string[]（実在チェック用の全カード/全フラッグID集合）。
// 戻り値: {ok:true, normalized:{name,flag,buddy,recipe}} | {ok:false, reason}
// 保存の下限枚数（50枚以上）はここでは検証しない＝作りかけのWIPデッキも保存可とする。
function validateDeckCodePayload(payload, opts) {
  const options = opts || {};
  const cardIds = options.cardIds instanceof Set ? options.cardIds : new Set(options.cardIds || []);
  const flagIds = options.flagIds instanceof Set ? options.flagIds : new Set(options.flagIds || []);

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
    if (!Number.isInteger(count) || count < 1 || count > 4) {
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
  };
}

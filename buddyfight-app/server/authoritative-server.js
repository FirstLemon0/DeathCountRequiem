// 権威ネット対戦サーバー（P1）。
// サーバが唯一のエンジン(engine-host)を保持し、クライアントは「アクション送信＋
// サーバ配信viewの描画」のみ（シンクライアント）。手札・山札は役割別に伏せ字化して配信。
// 現 netplay-server.js（中継方式）とは別エンドポイント /auth/* で提供する。
//
// 選択ダイアログ/じゃんけん/任意能力ゲート等のプロンプトは該当席のクライアントへ往復させる
// （engine の __serverPrompt → dispatchPrompt → SSE prompt_request → POST /prompt で再開）。
// 宛先席が不在/未接続・60秒無応答の時だけ engine 側の既定値（先頭min枚等）で自動解決する。
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { GameRoom } = require("./engine-host");
const roomStore = require("./room-store");
const replayStore = require("./replay-store");
const { engineVersion } = require("./engine-version");
const userStore = require("./user-store");
const deckCode = require("../deck-code");

const rootDir = path.resolve(__dirname, "..");
// 永続データ(P4)の保存先。token を含むため web root の外に置く（静的配信で漏らさない）。
const dataDir = process.env.AUTH_DATA_DIR || path.resolve(rootDir, "..", "buddyfight-auth-data");
const persistTimers = new Map(); // roomId -> debounce timer
const persistChains = new Map(); // roomId -> 永続化の直列化チェーン(Promise)

// ---- ユーザー登録＋マイデッキ（新規）関連の定数 ----
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日・利用のたびスライド延長
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 10; // 同一IPで10回/10分（register/login）
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const portArgIndex = process.argv.findIndex((arg) => arg === "--port" || arg === "-p");
const hostArgIndex = process.argv.findIndex((arg) => arg === "--host" || arg === "-h");
const port =
  Number(process.env.PORT) || (portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 4174);
const host = process.env.HOST || (hostArgIndex >= 0 ? process.argv[hostArgIndex + 1] : "127.0.0.1");

const rooms = new Map();
const roomTtlMs = 6 * 60 * 60 * 1000;
const ROOM_TTL_HOURS = Number(process.env.ROOM_TTL_HOURS) || 48; // 永続層(room-store)の古いスナップショット掃除
const ROOM_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REPLAY_TTL_DAYS = Number(process.env.REPLAY_TTL_DAYS) || 30; // 保存済みリプレイの古い共有を掃除

// ---- 濫用対策の上限（F3/F9）。env で変更可。スモークは LIMITS を直接書き換えて検証する（読むのは呼出時） ----
function envInt(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}
const LIMITS = {
  jsonBodyBytes: envInt("JSON_BODY_LIMIT_BYTES", 64 * 1024), // 全APIのJSON本文上限（部屋/ユーザーAPIとも数KBで足りる）
  maxRooms: envInt("MAX_ROOMS", 200), // 同時に存在できる部屋（ロビー含む）
  maxActiveGames: envInt("MAX_ACTIVE_GAMES", 16), // 同時に盤面(GameRoom≒1局30MB超)を持てる部屋
  maxMembersPerRoom: envInt("MAX_MEMBERS_PER_ROOM", 12), // 1部屋の参加者（対戦2＋観戦）
  lobbyIdleTtlMs: envInt("LOBBY_IDLE_TTL_MINUTES", 30) * 60 * 1000, // 未開始＆全員オフラインの部屋の寿命
  maxRestoreRooms: envInt("MAX_RESTORE_ROOMS", 200), // 起動時に復元する部屋の上限（新しい順）
  rateWindowMs: RATE_LIMIT_WINDOW_MS,
  rate: {
    auth: RATE_LIMIT_MAX, // register/login（従来値）
    create: envInt("RATE_ROOM_CREATE_MAX", 30), // 部屋作成/IP/10分
    join: envInt("RATE_ROOM_JOIN_MAX", 120), // 参加/IP/10分
    start: envInt("RATE_ROOM_START_MAX", 60), // 対戦開始/IP/10分
  },
};
const NAME_MAX = 24; // 部屋の表示名（登録名と同じ上限）
const DECK_NAME_MAX = 60; // デッキ名（共有コード検証と同じ上限）
const DECK_ID_MAX = 128;
const LABEL_MAX = 64;
const DECK_CODE_MAX = 16 * 1024;

function clampText(value, max) {
  if (typeof value !== "string") return "";
  const s = value.trim();
  return s.length > max ? s.slice(0, max) : s;
}

// ROOM_STORE_BACKEND 未指定なら USER_STORE_BACKEND を継承（ユーザーDBが turso なら部屋も turso）。
function resolveRoomStoreBackend() {
  return process.env.ROOM_STORE_BACKEND || process.env.USER_STORE_BACKEND || "file";
}

// REPLAY_STORE_BACKEND 未指定なら ROOM_STORE_BACKEND→USER_STORE_BACKEND を継承（room-store と同型の継承鎖）。
function resolveReplayStoreBackend() {
  return (
    process.env.REPLAY_STORE_BACKEND ||
    process.env.ROOM_STORE_BACKEND ||
    process.env.USER_STORE_BACKEND ||
    "file"
  );
}

// 2026-10-09 オーナー裁定「リプレイについてはバージョンアップ時に前のは消していい」:
// 保存済みリプレイのうちエンジン版（recording.engineVersion）が現行（index.html の ENGINE_VERSION）と違うもの
// （版の無い旧形式を含む）は再生できないので、ストア初期化時（＝サーバ起動時）に削除する。取り残し（削除失敗・
// 別版インスタンスが後から保存した等）は GET /replay/:id が 410、/auth/replays が非表示で扱う。
function isCurrentVersionReplayBlob(blob) {
  return replayStore.blobEngineVersion(blob) === engineVersion();
}

async function pruneOldVersionReplays() {
  try {
    const removed = await replayStore.pruneOtherVersions(engineVersion());
    if (removed) {
      console.log(`[replay-store] 旧バージョン（現行 ${engineVersion()} 以外）のリプレイを ${removed} 件削除しました`);
    }
  } catch (error) {
    // 掃除の失敗で保存/取得まで止めない（旧版は GET 410・一覧非表示で扱われる）。
    console.warn(`[replay-store] 旧バージョンのリプレイ削除に失敗: ${error.message}`);
  }
}

// リプレイストアの遅延初期化（memoize）。直接起動時は main が先に呼ぶが、require 経路（スモーク/e2e）でも
// 保存/取得ルートが最初に踏まれた時に必ず初期化されるようにする（userStore と同型）。
let replayStoreInitPromise = null;
function ensureReplayStoreInitialized() {
  if (!replayStoreInitPromise && typeof replayStore.isInitialized === "function" && replayStore.isInitialized()) {
    replayStoreInitPromise = Promise.resolve();
  }
  if (!replayStoreInitPromise) {
    replayStoreInitPromise = replayStore
      .init({
        backend: resolveReplayStoreBackend(),
        dataDir,
        tursoUrl: process.env.TURSO_DATABASE_URL,
        tursoToken: process.env.TURSO_AUTH_TOKEN,
      })
      .then(() => pruneOldVersionReplays())
      .catch((error) => {
        replayStoreInitPromise = null; // 失敗時は次のリクエストで再試行できるように
        throw error;
      });
  }
  return replayStoreInitPromise;
}

// 公開共有URL用のリプレイID（推測困難・ファイル名/URL安全な base64url）。
function randomReplayId() {
  return crypto.randomBytes(12).toString("base64url");
}

// デッキ一覧（プリセット）の遅延キャッシュ。
let deckListCache = null;
async function getDeckList() {
  if (deckListCache) {
    return deckListCache;
  }
  const probe = new GameRoom();
  deckListCache = await probe.loadData();
  return deckListCache;
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webmanifest": "application/manifest+json",
};

function randomId(size = 4) {
  return crypto.randomBytes(size).toString("hex").toUpperCase();
}

// 応答ヘッダ送出済み（SSE 開通後の例外など）なら JSON は書けない。二重 writeHead で例外を重ねず、
// 未終了なら閉じるだけにする（F2）。
function responseAlreadyStarted(res) {
  if (!res.headersSent && !res.writableEnded) return false;
  try {
    if (!res.writableEnded) res.end();
  } catch {
    /* 既に壊れたソケットは無視 */
  }
  return true;
}

function sendJson(res, statusCode, payload, extraHeaders = null) {
  if (responseAlreadyStarted(res)) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// JSON 本文の読込。上限超過=413 / 壊れたJSON・オブジェクト以外=400（statusCode 付き例外→最上位で応答）。
// 旧実装は 20MB まで受理しており、巨大な deck.custom 等を素通ししていた（F2/F3/F9）。
function readJson(req, limit = LIMITS.jsonBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.pause(); // 以降は読まない（応答後に Connection: close で切る）
        reject(httpError(413, "request too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        reject(httpError(400, "invalid json"));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        reject(httpError(400, "JSON object expected"));
        return;
      }
      resolve(parsed);
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

// ---- ユーザー登録＋マイデッキ（新規） ----
// この節のヘルパ・ルートは /auth/register|login|logout|me|mydecks*|admin/* のみが対象。
// 既存の部屋API(/auth/rooms/*)は同一オリジンのまま無改変（CORSヘッダも付けない）。

function sendJsonCors(res, statusCode, payload) {
  if (responseAlreadyStarted(res)) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE",
  });
  res.end(body);
}
function sendNoContentCors(res, statusCode = 204) {
  if (responseAlreadyStarted(res)) return;
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE",
  });
  res.end();
}

function isUserApiPath(pathname) {
  return (
    pathname === "/auth/dbhealth" ||
    pathname === "/auth/register" ||
    pathname === "/auth/login" ||
    pathname === "/auth/logout" ||
    pathname === "/auth/me" ||
    pathname === "/auth/mydecks" ||
    pathname.startsWith("/auth/mydecks/") ||
    pathname === "/auth/replays" ||
    pathname === "/auth/matches" ||
    pathname === "/auth/matches/stats" ||
    pathname === "/auth/admin/users" ||
    pathname === "/auth/admin/reset-password" ||
    pathname.startsWith("/auth/admin/users/")
  );
}

// ユーザーストアの遅延初期化（memoize）。直接起動時は main ブロックが先に呼ぶが、
// モジュール require 経路（スモーク・e2e が server を import して listen する使い方）でも
// ユーザールートが最初に踏まれた時に必ず初期化されるようにする。
let userStoreInitPromise = null;
function ensureUserStoreInitialized() {
  if (!userStoreInitPromise && typeof userStore.isInitialized === "function" && userStore.isInitialized()) {
    // スモーク/e2e が独自の dataDir で手動 init 済みの場合は尊重（上書き再初期化しない）
    userStoreInitPromise = Promise.resolve();
  }
  if (!userStoreInitPromise) {
    userStoreInitPromise = (async () => {
      await userStore.init({
        backend: process.env.USER_STORE_BACKEND || "file",
        dataDir: path.join(dataDir, "user"),
        tursoUrl: process.env.TURSO_DATABASE_URL,
        tursoToken: process.env.TURSO_AUTH_TOKEN,
      });
      await ensureAdminUser();
      await userStore.gcSessions(Date.now());
    })().catch((error) => {
      userStoreInitPromise = null; // 失敗時は次のリクエストで再試行できるように
      throw error;
    });
  }
  return userStoreInitPromise;
}

// scrypt(N=16384,r=8,p=1) パスワードハッシュ。形式 "s1$<saltB64>$<hashB64>"。
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `s1$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function verifyPassword(password, passHash) {
  const parts = String(passHash || "").split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  try {
    const salt = Buffer.from(parts[1], "base64");
    const expected = Buffer.from(parts[2], "base64");
    const actual = crypto.scryptSync(String(password), salt, expected.length, SCRYPT_PARAMS);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Authorization: Bearer <token> を検証し、成功時はセッションをスライド延長してユーザーを返す。
async function authenticateRequest(req) {
  const header = req.headers["authorization"] || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const tokenHash = hashToken(match[1].trim());
  const session = await userStore.getSession(tokenHash);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt <= now) {
    await userStore.deleteSession(tokenHash);
    return null;
  }
  const user = await userStore.getUserById(session.userId);
  if (!user) return null;
  await userStore.putSession({ tokenHash, userId: user.id, expiresAt: now + SESSION_TTL_MS });
  return user;
}

// 部屋の作成/参加時に Bearer からログインユーザーIDを best-effort で解決する（D5・戦績用）。
// 認証やユーザーDBが不通でも部屋参加自体は絶対に失敗させない＝失敗時は null（未ログイン扱い）。
async function resolveOptionalUserId(req) {
  try {
    await ensureUserStoreInitialized();
    const user = await authenticateRequest(req);
    return user ? user.id : null;
  } catch {
    return null;
  }
}

// レート制限（プロセス内カウンタで十分な個人運用規模）。bucket ごとに別勘定:
//   auth=register/login（同一IPで10回/10分）, create/join/start=部屋API（F3。上限は LIMITS.rate）。
const rateLimitHits = new Map(); // `${bucket}|${ip}` -> timestamps[]
function checkRateLimit(ip, bucket = "auth") {
  const now = Date.now();
  const max = LIMITS.rate[bucket] ?? RATE_LIMIT_MAX;
  const key = `${bucket}|${ip}`;
  const arr = (rateLimitHits.get(key) || []).filter((t) => now - t < LIMITS.rateWindowMs);
  if (arr.length >= max) {
    rateLimitHits.set(key, arr);
    return false;
  }
  arr.push(now);
  rateLimitHits.set(key, arr);
  return true;
}
// 窓を過ぎたエントリを捨てる（F6: IP ごとに Map が単調増加しないように定期掃除）。
function pruneRateLimitHits(now = Date.now()) {
  for (const [key, arr] of rateLimitHits) {
    const live = arr.filter((t) => now - t < LIMITS.rateWindowMs);
    if (live.length === 0) rateLimitHits.delete(key);
    else if (live.length !== arr.length) rateLimitHits.set(key, live);
  }
}
setInterval(() => pruneRateLimitHits(), 5 * 60 * 1000).unref();

// 逆プロキシ越しの接続元（F6）。env TRUST_PROXY:
//   未設定/0/false = X-Forwarded-For を信用しない（socket の接続元のみ。直結運用の既定）
//   true/1         = 直前の1段（Render/fly.io 等の前段プロキシ）を信用
//   N(整数)        = 直前のN段を信用
// 信用するのは「右端から N 段」だけ。それより左＝クライアントが自由に書ける部分は使わない
// （偽の X-Forwarded-For を送ってもレート制限/キックブロックを回避できない）。
function trustedProxyHops() {
  const raw = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "no" || raw === "off") return 0;
  if (raw === "true" || raw === "yes" || raw === "on") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 0;
}
function clientIp(req) {
  const remote = req?.socket?.remoteAddress || "unknown";
  const hops = trustedProxyHops();
  if (!hops) return remote;
  const header = req.headers?.["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : String(header || ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!forwarded.length) return remote;
  // chain = [client?, ..., proxy(n-1), 接続元]。末尾から hops 個が信頼プロキシ＝その直前が最初の非信頼ホップ。
  const chain = [...forwarded, remote];
  const picked = chain[Math.max(0, chain.length - 1 - hops)] || remote;
  return picked.slice(0, 64);
}

// デッキ保存の検証用データ（全カードID・全フラッグID）。getDeckList と同様の遅延キャッシュ方式だが、
// engine-host(GameRoom) 経由ではなく data/ 配下を直接読む（GameRoom.loadData はデッキ一覧のみを返し
// カード/フラッグの全量を公開していないため）。
let deckValidationCache = null;
async function getDeckValidationSets() {
  if (deckValidationCache) return deckValidationCache;
  const cardIds = new Set();
  const flagIds = new Set();
  const unlimitedCardIds = new Set(); // E-XC3: deckUnlimitedCopies なカードID（同名4枚超を許容）
  const limitCardMeta = []; // E-PR10(limitWith): buildLimitGroups 用の {id,name,limitWith}
  const buddyCountRules = {}; // audit2(b080-10): id→deckLimitUnlessBuddyCount（俺のバディ！）
  const cardNames = {}; // audit2(b080-10): id→カード名（バディの同名枚数集計用）
  const stripBom = (text) => text.replace(/^﻿/, "");
  try {
    const cardsets = JSON.parse(stripBom(fs.readFileSync(path.join(rootDir, "data", "cardsets.json"), "utf8")));
    for (const set of cardsets.sets || []) {
      if (!set.file) continue;
      try {
        const data = JSON.parse(stripBom(fs.readFileSync(path.join(rootDir, set.file), "utf8")));
        for (const card of data.cards || []) {
          if (card.type === "flag" && card.deckable !== true) continue; // R7: deckable flag はデッキ投入可
          if (card.id) cardIds.add(card.id);
          if (card.id && card.deckUnlimitedCopies) unlimitedCardIds.add(card.id); // E-XC3
          if (card.id) limitCardMeta.push({ id: card.id, name: card.name, limitWith: card.limitWith }); // E-PR10
          if (card.id) cardNames[card.id] = card.name;
          if (card.id && card.deckLimitUnlessBuddyCount) buddyCountRules[card.id] = card.deckLimitUnlessBuddyCount;
        }
      } catch (error) {
        console.warn(`[user-store] カードセット読込失敗: ${set.file}: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`[user-store] cardsets.json 読込失敗: ${error.message}`);
  }
  try {
    const flagsData = JSON.parse(stripBom(fs.readFileSync(path.join(rootDir, "data", "flags.json"), "utf8")));
    for (const flag of flagsData.flags || []) {
      if (flag.id) flagIds.add(flag.id);
      for (const alias of flag.aliases || []) flagIds.add(alias);
    }
  } catch (error) {
    console.warn(`[user-store] flags.json 読込失敗: ${error.message}`);
  }
  // E-PR10(limitWith): id→グループ名の写像（limitWith 皆無なら null＝グループ制約なし＝後方互換）。
  const limitGroups = deckCode.buildLimitGroups(limitCardMeta);
  deckValidationCache = { cardIds, flagIds, unlimitedCardIds, limitGroups, buddyCountRules, cardNames };
  return deckValidationCache;
}

// 部屋に持ち込まれる deck（{id, name?, custom?}）の検証・正規化（F2）。作成/参加/setDeck/復元の全入口で通す。
// custom（play.js が builder の自作デッキを同梱する定義）は共有コードと同じ validateDeckCodePayload で検証する:
//   実在カード/フラッグ・同名4枚(deckUnlimitedCopies は例外)・limitWith グループ4枚・100種/合計200枚・名前60字。
//   ※50枚ちょうどの下限は課さない（builder は作りかけデッキも保存でき、従来も開始できたため挙動を変えない）。
// 旧実装は custom を無検証で engine へ渡し、recipe [[id,1e6]] で開始時に数秒〜十数秒イベントループを塞ぎ、
// 永続化の JSON.stringify でプロセスごと落ちた。正規化後は既知フィールドのみ（余計なキーを持ち込ませない）。
// 戻り値: { deck } | { error }
async function normalizeRoomDeck(deck) {
  if (deck === undefined || deck === null || deck === "" || deck === false) return { deck: null }; // 旧実装の if (body.deck) 互換
  if (typeof deck !== "object" || Array.isArray(deck)) return { error: "デッキの指定が不正です" };
  const id = typeof deck.id === "string" ? deck.id.trim() : "";
  if (!id || id.length > DECK_ID_MAX) return { error: "デッキIDが不正です" };
  const name = clampText(deck.name, DECK_NAME_MAX);
  if (deck.custom === undefined || deck.custom === null) {
    return { deck: name ? { id, name } : { id } };
  }
  const custom = deck.custom;
  if (typeof custom !== "object" || Array.isArray(custom)) return { error: "自作デッキの形式が不正です" };
  const sets = await getDeckValidationSets();
  const result = deckCode.validateDeckCodePayload(
    {
      ver: 1,
      name: clampText(custom.name, DECK_NAME_MAX) || name || id.slice(0, DECK_NAME_MAX),
      flag: custom.flag,
      buddy: custom.buddy,
      recipe: custom.recipe,
    },
    sets,
  );
  if (!result.ok) return { error: `自作デッキが不正です: ${String(result.reason).slice(0, 160)}` };
  const n = result.normalized;
  // engine は deck.id で deckProfiles から引くため custom.id は必ず deck.id に揃える。
  return {
    deck: { id, name: name || n.name, custom: { id, name: n.name, flag: n.flag, buddy: n.buddy, recipe: n.recipe } },
  };
}

// env ADMIN_USER_NAME/ADMIN_USER_PASSWORD があれば起動時に管理者を確保する。
// 【F5・セキュリティ】同名の「一般ユーザー」が既にいても自動昇格しない。登録は誰でもできるため、
// 攻撃者が管理者名を先回り登録しておくと、旧実装（存在すれば is_admin=1 に昇格）では再起動後に
// 攻撃者の既存セッションがそのまま管理者になった。昇格はスキップし大きく警告する
// （運用者がその一般ユーザーを削除/改名してから再起動すれば、正規の管理者が作られる）。
// 既存の管理者はパスワードが env と異なる時だけ更新し、その際は全セッションを失効させる
// （旧パスワードで得たトークンを無効化。同一パスなら再起動のたびにログアウトさせない）。
async function ensureAdminUser() {
  const name = process.env.ADMIN_USER_NAME;
  const password = process.env.ADMIN_USER_PASSWORD;
  if (!name || !password) return;
  const existing = await userStore.getUserByName(name);
  if (existing) {
    if (!existing.isAdmin) {
      console.warn(
        `[admin] 警告: ADMIN_USER_NAME="${name}" と同名の一般ユーザーが既に存在するため、管理者への昇格を行いません。` +
          "第三者による先回り登録の可能性があります。そのユーザーを削除/改名してから再起動してください。",
      );
      return;
    }
    if (!verifyPassword(password, existing.passHash)) {
      await userStore.setPassword(existing.id, hashPassword(password));
      await userStore.deleteSessionsByUser(existing.id);
    }
    return;
  }
  await userStore.createUser({ name, passHash: hashPassword(password), isAdmin: true });
}

// ---- 部屋・メンバー・席モデル ----

function createRoom() {
  let roomId = randomId(3);
  while (rooms.has(roomId)) {
    roomId = randomId(3);
  }
  const room = {
    id: roomId,
    members: new Map(), // clientId -> member
    seats: [null, null], // [P1 clientId, P2 clientId]
    game: null,
    started: false,
    busy: false, // applyAction 実行中フラグ（プロンプト往復ホールド中の再入を防ぐ）
    pendingPrompts: new Map(), // requestId -> { resolve, timer, clientId }（プロンプト往復の待機）
    promptSeq: 0, // prompt_request の連番（クライアントの順序整合用）
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // 部屋を立てた人（ホスト）。キックの権限者。ホストが抜けたら最古の残存メンバーへ委譲する
    //（誰もキックできない部屋が残らないように）。
    hostClientId: null,
    // キックされた相手の即再入室を防ぐ一時ブロック。key -> 解除時刻(ms)。
    // clientId は参加のたびに新規発行されるため鍵にならない。ログイン中は userId、未ログインは接続元アドレスで抑える。
    kickBlocks: new Map(),
  };
  rooms.set(roomId, room);
  return room;
}

// キック後の再入室ブロックの鍵（ログインユーザーは userId、未ログインは接続元アドレス）。
const KICK_BLOCK_MS = 2 * 60 * 1000;
// addr は clientIp(req)（TRUST_PROXY 設定時は X-Forwarded-For の非信頼ホップ。F6）。
function kickBlockKeys(addr, userId) {
  const keys = [];
  if (userId) keys.push(`user:${userId}`);
  if (addr) keys.push(`addr:${addr}`);
  return keys;
}
function isKickBlocked(room, req, userId) {
  const now = Date.now();
  const mine = kickBlockKeys(clientIp(req), userId);
  for (const [key, until] of room.kickBlocks || []) {
    if (until <= now) {
      room.kickBlocks.delete(key); // 期限切れは掃除
      continue;
    }
    if (mine.includes(key)) {
      return Math.ceil((until - now) / 1000);
    }
  }
  return 0;
}

// ---- 永続化(P4・再起動耐性) ----
// room を plain スナップショットへ（sse/game/vm/関数は除外。token は含むため dataDir は web root 外）。
function snapshotRoom(room) {
  return {
    version: 1,
    id: room.id,
    seats: room.seats,
    started: room.started,
    hostClientId: room.hostClientId || null,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    members: [...room.members.values()].map((m) => ({
      clientId: m.clientId,
      token: m.token,
      name: m.name,
      role: m.role,
      deck: m.deck || null,
      userId: m.userId || null, // D5: 復元後の対戦でも席→ユーザーの戦績記録を続けられるように保つ
    })),
    state: room.started && room.game ? room.game.api.getState() : null,
  };
}

// 同一部屋の永続化を発行順に直列化する。turso backend では save/delete が fetch(数十〜数百ms)で、
// 直列化しないと (a) 同時飛行した save の完了順が入れ替わり古いスナップショットが新しいものを
// 上書きする、(b) 部屋削除より後に save が着地して削除済みの部屋がDBに復活する。
// file backend は同期書込みで実害が無いが、経路を分けず同じチェーンに乗せる。
function enqueuePersist(roomId, task) {
  const prev = persistChains.get(roomId) || Promise.resolve();
  const next = prev
    .then(task)
    .catch((error) => {
      console.warn(`[persist] room ${roomId} の永続化に失敗: ${error.message}`);
    })
    .then(() => {
      if (persistChains.get(roomId) === next) persistChains.delete(roomId);
    });
  persistChains.set(roomId, next);
  return next;
}

function persistNow(room) {
  // 閉じた部屋は保存しない。飛行中の /action が await 中に別の /abort・/leave で部屋が消えた後、
  // /action 再開時のこの persistNow が delete より後に save を積むと、閉じたはずの部屋がストアに
  // 復活する（チェーンは同一部屋なので delete→save の順で着地する）。closed 印で確実に弾く。
  if (room.closed) return;
  // busy(applyAction 途中)はライブ state の途中変異を拾うため保存しない＝整合する確定局面のみ保存。
  if (room.busy) {
    schedulePersist(room);
    return;
  }
  // スナップショットは busy=false のこの瞬間に**値ごと凍結**する（deep-clone）。snapshotRoom は
  // getState() の live 参照を載せるだけで、直列化は save 内の JSON.stringify まで遅延する。file backend は
  // save が同期でチェーンが microtask で drain しきるため安全だが、turso backend では前段 save の fetch が
  // 滞留する間に別アクションが busy=true で state を途中変異させ、遅延実行時の live state（effect 解決途中）を
  // 保存しうる。捕捉時に clone しておけば file/turso 両方で「busy=false の瞬間の局面」が保証される。
  // F2: 直列化の失敗（巨大/循環データ等）でリクエストやタイマーごとプロセスを落とさない。保存は諦めて警告のみ。
  let snapshot;
  try {
    snapshot = JSON.parse(JSON.stringify(snapshotRoom(room)));
  } catch (error) {
    console.warn(`[persist] room ${room.id} のスナップショット作成に失敗（保存をスキップ）: ${error.message}`);
    return;
  }
  enqueuePersist(room.id, () => roomStore.save(room.id, snapshot));
}

// 部屋を閉じて忘れる（中断・空退出・TTL掃除の共通処理）。closed 印を先に立ててから rooms から外し、
// 削除をチェーン末尾へ積む。飛行中アクションの遅延 save は persistNow の closed ガードで弾かれる。
function closeAndForgetRoom(room, roomId) {
  const id = roomId != null ? roomId : room && room.id;
  if (room) room.closed = true;
  rooms.delete(id);
  persistDelete(id);
}

function schedulePersist(room) {
  if (persistTimers.has(room.id)) return;
  const timer = setTimeout(() => {
    persistTimers.delete(room.id);
    try {
      persistNow(room);
    } catch (error) {
      // タイマー内の例外は uncaughtException になりプロセスが落ちるため、ここで握って警告する。
      console.warn(`[persist] room ${room.id} の遅延保存に失敗: ${error && error.message}`);
    }
  }, 200);
  timer.unref?.();
  persistTimers.set(room.id, timer);
}

// 部屋の破棄。保留中のデバウンスを先に止めてから削除をチェーン末尾に積む
// （止めないと 200ms 後に persistNow が走り、削除済みの部屋を保存し直してしまう）。
function persistDelete(roomId) {
  const timer = persistTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(roomId);
  }
  return enqueuePersist(roomId, () => roomStore.delete(roomId));
}

// 指定部屋の永続化チェーンが空になるまで待つ（テスト用。連鎖中に積まれた分も待つ）。
async function flushPersist(roomId) {
  let guard = 0;
  while (persistChains.has(roomId) && guard < 100) {
    guard += 1;
    await persistChains.get(roomId);
  }
}

// 起動時に永続ファイルから rooms を再構築・局面復元（members は sse=null で再接続待機）。
// F3: 復元数に上限を設ける（新しい順に maxRestoreRooms 部屋・うち盤面持ちは maxActiveGames まで）。
// 呼び元（main）は期限切れを pruneExpired で先に掃除してから呼ぶ。
async function restoreRooms() {
  const snaps = (await roomStore.loadAll())
    .filter((snap) => snap && typeof snap.id === "string")
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  let restoredGames = 0;
  let skipped = 0;
  for (const snap of snaps) {
    if (rooms.has(snap.id)) continue; // 生きている部屋をスナップショットで上書きしない（起動時は空なので無関係）
    if (rooms.size >= LIMITS.maxRestoreRooms) {
      skipped += 1;
      continue;
    }
    const wantsGame = Boolean(snap.started && snap.state);
    if (wantsGame && restoredGames >= LIMITS.maxActiveGames) {
      skipped += 1;
      continue;
    }
    try {
      // 旧版で無検証のまま保存された deck/name もここで正規化する（不正な custom は持ち込みを外す）。
      const members = [];
      for (const m of (snap.members || []).slice(0, LIMITS.maxMembersPerRoom)) {
        const normalized = await normalizeRoomDeck(m.deck);
        if (normalized.error) {
          console.warn(`[restore] room ${snap.id} member ${m.clientId} のデッキを破棄: ${normalized.error}`);
        }
        members.push({ ...m, name: clampText(m.name, NAME_MAX) || "プレイヤー", deck: normalized.deck || null, sse: null });
      }
      const room = {
        id: snap.id,
        members: new Map(members.map((m) => [m.clientId, m])),
        seats: snap.seats || [null, null],
        game: null,
        // state 欠損（started:true なのに state:null）の破損スナップショットを「開始済みだが盤面なし」の
        // ゾンビ部屋として復元しない。遊べも畳めもせず TTL まで残るため、未開始扱いに落とす。
        started: Boolean(snap.started && snap.state),
        busy: false,
        pendingPrompts: new Map(),
        promptSeq: 0,
        createdAt: snap.createdAt || Date.now(),
        updatedAt: snap.updatedAt || Date.now(),
        // 旧スナップショット（hostClientId 無し）は最初のメンバーをホストとみなす（後方互換）。
        hostClientId: snap.hostClientId || (snap.members || [])[0]?.clientId || null,
        kickBlocks: new Map(), // 再起動でブロックは解除（短期の抑止なので永続化しない）
      };
      if (snap.started && snap.state) {
        const customDecks = [];
        for (const seatId of room.seats) {
          const m = room.members.get(seatId);
          if (m && m.deck && m.deck.custom) customDecks.push(m.deck.custom);
        }
        // record:true は復元時には効かない（記録は startGame の replayStartRecording で始まるが復元は
        // setState 復元のため）。整合性のため startGame と同じオプションを渡すが、復元された対戦は
        // getRecording()=null となり /replay 保存では 409（記録なし）になる。
        const game = new GameRoom({ record: true, customDecks, onPrompt: (req) => dispatchPrompt(room, req) });
        await game.loadData();
        game.api.setState(snap.state);
        game.started = true;
        room.game = game;
        restoredGames += 1;
      }
      rooms.set(room.id, room);
    } catch (error) {
      console.warn(`[restore] room ${snap?.id} の復元に失敗（スキップ）: ${error.message}`);
    }
  }
  if (skipped) {
    console.warn(`[restore] 上限(部屋${LIMITS.maxRestoreRooms}/対戦${LIMITS.maxActiveGames})超過のため ${skipped} 部屋を復元しませんでした`);
  }
}

function addMember(room, { name, userId = null, remoteAddress = null }) {
  const clientId = randomId(6);
  const token = randomId(16);
  // userId: 参加時に Bearer が有効だった場合のログイン済みユーザーID（未ログインは null）。
  // 決着時に席へ紐づくログインユーザーへ戦績を記録するために控える（D5）。
  // remoteAddress: キック後の再入室ブロックの鍵に使う（clientId は参加のたび新規で鍵にならない）。
  const member = { clientId, token, name: clampText(name, NAME_MAX) || "プレイヤー", role: null, deck: null, sse: null, userId, remoteAddress };
  // 既定の席割り: 1人目=seat0, 2人目=seat1, 以降=観戦（あとで変更可）
  if (!room.seats[0]) {
    room.seats[0] = clientId;
    member.role = 0;
  } else if (!room.seats[1]) {
    room.seats[1] = clientId;
    member.role = 1;
  } else {
    member.role = "spectator";
  }
  room.members.set(clientId, member);
  room.updatedAt = Date.now();
  return member;
}

function memberByToken(room, token) {
  for (const member of room.members.values()) {
    if (member.token === token) {
      return member;
    }
  }
  return null;
}

function vacateSeatOf(room, clientId) {
  if (room.seats[0] === clientId) room.seats[0] = null;
  if (room.seats[1] === clientId) room.seats[1] = null;
}

// ホストが部屋を去った時、最古の残存メンバーへホストを委譲する。
// 委譲しないと「誰もキックできない部屋」になり、居座りを排除する手段が消える。
function reassignHostIfNeeded(room) {
  if (room.hostClientId && room.members.has(room.hostClientId)) {
    return;
  }
  const next = room.members.keys().next(); // Map は挿入順＝参加順
  room.hostClientId = next.done ? null : next.value;
}

// 役割変更（参加順と独立に P1/P2/観戦 を割り当て）。
function assignRole(room, member, role) {
  if (room.started) {
    return { error: "ゲーム開始後は役割変更できません" };
  }
  if (role === "spectator") {
    vacateSeatOf(room, member.clientId);
    member.role = "spectator";
    return { ok: true };
  }
  const seat = Number(role);
  if (![0, 1].includes(seat)) {
    return { error: "不正な役割" };
  }
  if (room.seats[seat] && room.seats[seat] !== member.clientId) {
    return { error: `席${seat + 1}は使用中です（占有者が観戦に移ると空きます）` };
  }
  vacateSeatOf(room, member.clientId);
  room.seats[seat] = member.clientId;
  member.role = seat;
  return { ok: true };
}

function swapSeats(room) {
  if (room.started) {
    return { error: "ゲーム開始後は入替できません" };
  }
  const [a, b] = room.seats;
  room.seats = [b, a];
  if (a) room.members.get(a).role = 1;
  if (b) room.members.get(b).role = 0;
  return { ok: true };
}

// F7: ロビーの「席入替」「開始」を操作できるのは対戦席の本人かホスト（観戦者は不可）。
function canControlLobby(room, member) {
  return member.role === 0 || member.role === 1 || member.clientId === room.hostClientId;
}

// F3: 盤面(GameRoom)を保持している部屋の数（開始処理中も含める）。
function countActiveGames() {
  let n = 0;
  for (const room of rooms.values()) {
    if (room.game || room.starting) n += 1;
  }
  return n;
}

// 行動可能席か（クライアントの selectFieldCard 許可条件と同等）。
// action = { type, params, game } を渡すと、保留の無い局面での非ターン席の【対抗】使用も判定する
// （rule-counter-5・ver2.05 ②【対抗】の流れ 6.）。非ターン席に許すのは type:"use" のうち、エンジンの
// game.canUseOffTurnCounter が「今【対抗】として使える」と答えた選択だけ。draw/charge/call/attack/endTurn/
// フェイズ移行・【対抗】でない use は従来どおり拒否する（ルール判定はエンジン側 finder に委ね、ここで複製しない）。
function canActorActNow(state, seat, action = null) {
  if (!Number.isInteger(seat)) return false;
  if (state.winner) return false;
  if (state.pendingAttack) {
    return [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(seat);
  }
  if (state.pendingAction) {
    return seat === state.pendingAction.responder;
  }
  if (seat === state.active) return true;
  return Boolean(
    action &&
      action.type === "use" &&
      typeof action.game?.canUseOffTurnCounter === "function" &&
      action.game.canUseOffTurnCounter(seat, action.params || {}),
  );
}

// ---- 配信 ----

function lobbyPayload(room, you) {
  return {
    type: "lobby",
    roomId: room.id,
    started: room.started,
    you: you ? { clientId: you.clientId, role: you.role, isHost: you.clientId === room.hostClientId } : null,
    seats: room.seats,
    hostClientId: room.hostClientId || null,
    members: [...room.members.values()].map((m) => ({
      clientId: m.clientId,
      name: m.name,
      role: m.role,
      deck: m.deck ? { id: m.deck.id, name: m.deck.name || null } : null,
      online: Boolean(m.sse),
      isHost: m.clientId === room.hostClientId,
    })),
  };
}

// キック等でメンバーを外す時、その人のSSEを明示的に閉じる（開いたままだと切断検知まで生き残り、
// 以後のブロードキャストが「もういない相手」へ書き続ける）。
function closeSseOf(member) {
  if (!member?.sse) return;
  const res = member.sse;
  member.sse = null;
  try {
    if (typeof res.__bfCleanup === "function") res.__bfCleanup(); // ハートビート停止（F8）
    res.end();
  } catch (error) {
    /* 既に閉じている場合は無視 */
  }
}

function writeSse(res, message) {
  res.write("event: message\n");
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

function viewPayloadFor(room, member, label) {
  if (!room.game) {
    return null;
  }
  const role = member.role === 0 || member.role === 1 ? member.role : "spectator";
  return { type: "view", role, label: label || "", state: room.game.viewFor(role) };
}

function broadcastLobby(room) {
  for (const member of room.members.values()) {
    if (member.sse) {
      writeSse(member.sse, lobbyPayload(room, member));
    }
  }
}

function broadcastView(room, label) {
  for (const member of room.members.values()) {
    if (member.sse) {
      const payload = viewPayloadFor(room, member, label);
      if (payload) {
        writeSse(member.sse, payload);
      }
    }
  }
}

// 往復プロンプトの宛先席を状態から推定する。
// 防御中（対抗/ソウルガード等）の選択は応答側、それ以外は手番（能動）側。
// 効果解決中は pendingAction/Attack は resolvePendingAction 冒頭で既にクリアされるため
// active に落ちる（例: コール時の登場能力の選択は、解決を駆動する応答側ではなく
// カードを出した手番プレイヤー＝能力の主体へ届く）。actingSeat に宛てると手番側の
// 手札候補が応答側へ漏れるため、ここは必ず状態から推定する。
function inferPromptSeat(state) {
  if (!state) return null;
  if (state.pendingAction) return state.pendingAction.responder;
  if (state.pendingAttack) return state.counterHandOwner ?? state.pendingAttack.defender;
  return state.active;
}

// ---- プロンプト往復 ----
// エンジン（chooseCardEntries 等）が __serverPrompt(req) を await したとき呼ばれる。
// 該当席のクライアントへ prompt_request を送り、/prompt 応答（または60sタイムアウト）まで
// 解決しない Promise を返す。applyAction はこの Promise が解決するまでホールドされる。
function dispatchPrompt(room, req) {
  // 宛先席: 明示 promptSeat(req.targetSeat) 優先 → 状態推定 → 最終的に actingSeat。
  const state = room.game && room.game.api ? room.game.api.getState() : null;
  const targetSeat = req.targetSeat ?? inferPromptSeat(state) ?? room.game?.actingSeat;
  let target = null;
  for (const member of room.members.values()) {
    if (member.role === targetSeat) {
      target = member;
      break;
    }
  }
  // 宛先が居ない/SSE未接続なら即 null（必須選択は engine 側 resolveServerSelection が先頭min枚を自動採用）。
  if (!target || !target.sse) {
    return Promise.resolve(null);
  }
  const requestId = `prompt-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  room.promptSeq += 1;
  // 再接続時に再配信できるよう payload を保持（送信内容は不変・後方互換）。
  const payload = {
    type: "prompt_request",
    requestId,
    seq: room.promptSeq,
    kind: req.kind,
    title: req.title,
    lead: req.lead,
    min: req.min,
    max: req.max,
    allowCancel: req.allowCancel,
    searchable: req.searchable,
    candidates: req.candidates,
    // 対抗窓改修: 誘発/ライフリンクの対抗窓（kind:"counterWindow"）の公開情報（種別・発生源名・窓ID）。候補は応答席にだけ届く。
    ...(req.kind === "counterWindow" ? { counterWindow: req.counterWindow || null } : {}),
  };
  if (req.kind === "counterWindow") {
    // 窓は操作の途中（誘発の解決前）で開く。応答席の盤面が操作開始前のままにならないよう、最新 view を全員へ配る
    // （viewFor が席別に伏せる）。待つ側には「相手が対抗を検討中」だけを知らせる（何を持っているかは送らない）。
    broadcastView(room, "対抗確認");
    notifyCounterWindow(room, targetSeat, true);
  }
  return new Promise((resolve) => {
    const finish = (value) => {
      if (req.kind === "counterWindow") {
        notifyCounterWindow(room, targetSeat, false);
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      room.pendingPrompts.delete(requestId);
      finish(null); // 対抗窓は無応答＝パス
    }, 60 * 1000);
    room.pendingPrompts.set(requestId, { resolve: finish, timer, clientId: target.clientId, payload });
    writeSse(target.sse, payload);
  });
}

// 対抗窓改修: 応答席以外（相手席・観戦）へ、窓の開閉だけを知らせる。
function notifyCounterWindow(room, responderSeat, open) {
  for (const member of room.members.values()) {
    if (member.sse && member.role !== responderSeat) {
      writeSse(member.sse, { type: "counter_window", open: Boolean(open), responder: responderSeat });
    }
  }
}

// ---- API ----

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, rooms: rooms.size });
    return true;
  }

  // GET /replay/:id  （公開共有: 保存済みリプレイの recording を返す。認証不要・CORS付き）。
  // 保存は「決着後のみ」なので、共有URLを踏んでもシード漏洩で進行中対戦を先読みされる恐れはない。
  if (req.method === "GET" && parts[0] === "replay" && parts[1]) {
    try {
      await ensureReplayStoreInitialized();
    } catch (error) {
      sendJsonCors(res, 503, {
        error: "リプレイ保管に接続できません",
        detail: String(error && error.message ? error.message : error),
      });
      return true;
    }
    const blob = await replayStore.load(parts[1]);
    if (!blob || !blob.replay) {
      sendJsonCors(res, 404, { error: "リプレイが見つかりません" });
      return true;
    }
    if (!isCurrentVersionReplayBlob(blob)) {
      // 旧エンジン版の記録は再生できない（現行エンジンは旧セマンティクスを持たない）。実体は次回起動時の掃除で消える。
      sendJsonCors(res, 410, { error: "このリプレイは旧バージョンのため再生できません", gone: "old-version" });
      return true;
    }
    sendJsonCors(res, 200, { id: parts[1], recording: blob.replay });
    return true;
  }

  // ---- ユーザー登録＋マイデッキ（新規）。CORS対象はこの節のパスのみ ----
  if (req.method === "OPTIONS" && isUserApiPath(url.pathname)) {
    sendNoContentCors(res, 204);
    return true;
  }
  if (isUserApiPath(url.pathname)) {
    // require 経路（スモーク/e2e）でも初期化漏れにならないよう、ユーザールートは必ず初期化を待つ。
    // 初期化（Turso接続・スキーマ作成）が失敗したら、CORS付き503で「本当の理由」をブラウザに返す
    // （CORS無しの500だとブラウザが読めず「接続できません」に化けて原因不明になるため）。
    try {
      await ensureUserStoreInitialized();
    } catch (error) {
      if (url.pathname === "/auth/dbhealth") {
        // F13: 未認証の診断には失敗理由（Turso ホスト等を含みうる）を出さない。詳細はサーバログで確認する。
        console.warn(`[dbhealth] ユーザーDB初期化失敗: ${error && error.message}`);
        sendJsonCors(res, 503, { ok: false });
        return true;
      }
      sendJsonCors(res, 503, {
        error: "ユーザーDBに接続できません",
        detail: String(error && error.message ? error.message : error),
        backend: process.env.USER_STORE_BACKEND || "file",
      });
      return true;
    }
  }

  // 接続診断: デプロイ先URL/ローカルでブラウザから開くだけで、実DB往復の成否が確認できる（一次切り分け用）。
  // F13: 未認証/一般ユーザーには {ok} だけを返す。バックエンド種別・Turso ホスト・dataDir 絶対パス・件数・
  // 失敗理由の詳細は管理者（Bearer の isAdmin）にだけ返す（旧実装は認証不要で全部出していた）。
  if (req.method === "GET" && url.pathname === "/auth/dbhealth") {
    let isAdmin = false;
    try {
      const caller = await authenticateRequest(req);
      isAdmin = Boolean(caller && caller.isAdmin);
    } catch {
      isAdmin = false;
    }
    if (!isAdmin) {
      try {
        await userStore.ping();
        sendJsonCors(res, 200, { ok: true });
      } catch (error) {
        console.warn(`[dbhealth] ping 失敗: ${error && error.message}`);
        sendJsonCors(res, 503, { ok: false });
      }
      return true;
    }
    // room-store は起動直後(require経路のスモーク等)だと未initの場合があるため個別に try する
    // （既存キー(ok/backend/...)は壊さず、roomBackend/roomCountを追加するだけ）。
    let roomInfo = { roomBackend: resolveRoomStoreBackend(), roomCount: null, roomError: null };
    try {
      if (roomStore.isInitialized()) {
        const info = await roomStore.ping();
        roomInfo = { roomBackend: info.backend, roomCount: info.roomCount, roomError: null };
      } else {
        roomInfo.roomError = "room-store 未初期化";
      }
    } catch (error) {
      roomInfo.roomError = String(error && error.message ? error.message : error);
    }
    let replayInfo = { replayBackend: resolveReplayStoreBackend(), replayCount: null, replayError: null };
    try {
      if (replayStore.isInitialized()) {
        const info = await replayStore.ping();
        replayInfo = { replayBackend: info.backend, replayCount: info.count, replayError: null };
      } else {
        replayInfo.replayError = "replay-store 未初期化";
      }
    } catch (error) {
      replayInfo.replayError = String(error && error.message ? error.message : error);
    }
    try {
      const info = await userStore.ping();
      sendJsonCors(res, 200, { ok: true, ...info, ...roomInfo, ...replayInfo });
    } catch (error) {
      sendJsonCors(res, 503, {
        ok: false,
        backend: process.env.USER_STORE_BACKEND || "file",
        error: String(error && error.message ? error.message : error),
        ...roomInfo,
        ...replayInfo,
      });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/register") {
    if (!checkRateLimit(clientIp(req))) {
      sendJsonCors(res, 429, { error: "しばらくしてから再試行してください" });
      return true;
    }
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || name.length > 24) {
      sendJsonCors(res, 400, { error: "名前は1〜24字で指定してください" });
      return true;
    }
    if (password.length < 4) {
      sendJsonCors(res, 400, { error: "パスワードは4字以上で指定してください" });
      return true;
    }
    const existing = await userStore.getUserByName(name);
    if (existing) {
      sendJsonCors(res, 409, { error: "その名前は既に使われています" });
      return true;
    }
    const user = await userStore.createUser({ name, passHash: hashPassword(password), isAdmin: false });
    if (!user) {
      sendJsonCors(res, 409, { error: "その名前は既に使われています" });
      return true;
    }
    const token = generateToken();
    await userStore.putSession({ tokenHash: hashToken(token), userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
    sendJsonCors(res, 201, { token, name: user.name, isAdmin: user.isAdmin });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    if (!checkRateLimit(clientIp(req))) {
      sendJsonCors(res, 429, { error: "しばらくしてから再試行してください" });
      return true;
    }
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = name ? await userStore.getUserByName(name) : null;
    if (!user || !verifyPassword(password, user.passHash)) {
      sendJsonCors(res, 401, { error: "名前またはパスワードが違います" });
      return true;
    }
    const token = generateToken();
    await userStore.putSession({ tokenHash: hashToken(token), userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
    sendJsonCors(res, 200, { token, name: user.name, isAdmin: user.isAdmin });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const header = req.headers["authorization"] || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match) {
      await userStore.deleteSession(hashToken(match[1].trim()));
    }
    sendNoContentCors(res, 204);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/me") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    const deckCount = await userStore.countDecks(user.id);
    sendJsonCors(res, 200, { name: user.name, isAdmin: user.isAdmin, deckCount });
    return true;
  }

  // GET /auth/replays  （自分が保存したリプレイ一覧。Bearer 必須。未ログイン保存=userId:null は出さない）。
  if (req.method === "GET" && url.pathname === "/auth/replays") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    try {
      await ensureReplayStoreInitialized();
    } catch (error) {
      sendJsonCors(res, 503, {
        error: "リプレイ保管に接続できません",
        detail: String(error && error.message ? error.message : error),
      });
      return true;
    }
    // F11: 全体の直近200件から絞ると他人の保存が多い時に自分の古いリプレイが消えるため、保存者で引く。
    const recent = await replayStore.listByUser(user.id, 200);
    const mine = recent
      // 旧エンジン版のリプレイは再生できないので一覧に出さない（起動時の削除の取り残し対策）。
      .filter((entry) => entry.recording && entry.recording.userId === user.id && isCurrentVersionReplayBlob(entry.recording))
      .map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        roomId: entry.recording.roomId || null,
        // 一覧は軽量メタのみ（recording 本体は共有URL /replay/:id で取得する）。
        steps: Array.isArray(entry.recording.replay?.steps) ? entry.recording.replay.steps.length : 0,
      }));
    sendJsonCors(res, 200, { replays: mine });
    return true;
  }

  // GET /auth/matches/stats  （自分のデッキ別勝敗・勝率。Bearer 必須）。※/matches より前に判定する。
  if (req.method === "GET" && url.pathname === "/auth/matches/stats") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    const stats = await userStore.matchStats(user.id);
    sendJsonCors(res, 200, { stats });
    return true;
  }

  // GET /auth/matches  （自分の対戦履歴。新しい順。Bearer 必須）。
  if (req.method === "GET" && url.pathname === "/auth/matches") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const matches = await userStore.listMatches(user.id, limit);
    sendJsonCors(res, 200, { matches });
    return true;
  }

  // POST /auth/matches  （ローカル対戦の自己申告を記録。Bearer 必須）。
  // 【セキュリティ】source は必ず "client" に固定する。同一 fightId に権威記録(source:"server")が既にあれば
  // user-store 側が上書きを拒む＝クライアント申告で勝敗を盛れない（勝敗はサーバが state から判定する）。
  if (req.method === "POST" && url.pathname === "/auth/matches") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await readJson(req);
    if (body.outcome !== "win" && body.outcome !== "loss") {
      sendJsonCors(res, 400, { error: "outcome は win / loss で指定してください" });
      return true;
    }
    // 許可フィールドのみ渡す（seed / token 等は user-store 側でも弾かれるが、ここでも渡さない）。
    const match = await userStore.putMatch(user.id, {
      fightId: body.fightId,
      finishedAt: body.finishedAt,
      outcome: body.outcome,
      reason: body.reason,
      firstSeat: body.firstSeat,
      turnCount: body.turnCount,
      deckId: body.deckId,
      opponentDeckId: body.opponentDeckId,
      replayId: body.replayId,
      source: "client", // 必ずクライアント申告として保存（body.source は無視）
    });
    sendJsonCors(res, 201, { match });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/mydecks") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    const decks = await userStore.listDecks(user.id);
    sendJsonCors(res, 200, { decks });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/mydecks") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await readJson(req);
    if (typeof body.code !== "string" || body.code.length > DECK_CODE_MAX) {
      sendJsonCors(res, 400, { error: "共有コードが不正です" });
      return true;
    }
    let payload;
    try {
      payload = deckCode.decodeDeckShareCode(body.code);
    } catch (error) {
      sendJsonCors(res, 400, { error: `共有コードが不正です: ${error.message}` });
      return true;
    }
    const { cardIds, flagIds, unlimitedCardIds, limitGroups, buddyCountRules, cardNames } = await getDeckValidationSets();
    const result = deckCode.validateDeckCodePayload(payload, {
      cardIds,
      flagIds,
      unlimitedCardIds,
      limitGroups,
      buddyCountRules,
      cardNames,
    });
    if (!result.ok) {
      sendJsonCors(res, 400, { error: result.reason });
      return true;
    }
    const limit = Number(process.env.USER_DECK_LIMIT) || 500;
    const count = await userStore.countDecks(user.id);
    if (count >= limit) {
      sendJsonCors(res, 409, { error: "マイデッキの保存上限に達しています" });
      return true;
    }
    // F9: 表示名は共有コード検証と同じ60字に丸める（name だけ無制限に溜められないように）。
    const name = clampText(body.name, DECK_NAME_MAX) || result.normalized.name;
    const cardCount = result.normalized.recipe.reduce((sum, [, c]) => sum + c, 0);
    const deck = await userStore.putDeck(user.id, {
      name,
      code: String(body.code),
      flag: result.normalized.flag,
      buddy: result.normalized.buddy,
      cardCount,
      position: count,
    });
    sendJsonCors(res, 201, { deck });
    return true;
  }

  // PUT/DELETE /auth/mydecks/:id
  if ((req.method === "PUT" || req.method === "DELETE") && /^\/auth\/mydecks\/[^/]+$/.test(url.pathname)) {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    const deckId = decodeURIComponent(url.pathname.slice("/auth/mydecks/".length));
    const existing = await userStore.getDeck(user.id, deckId);
    if (!existing) {
      sendJsonCors(res, 404, { error: "デッキが見つかりません" });
      return true;
    }
    if (req.method === "DELETE") {
      await userStore.deleteDeck(user.id, deckId);
      sendNoContentCors(res, 204);
      return true;
    }
    const body = await readJson(req);
    const patch = { id: existing.id };
    if (clampText(body.name, DECK_NAME_MAX)) {
      patch.name = clampText(body.name, DECK_NAME_MAX); // F9
    }
    if (typeof body.position === "number" && Number.isFinite(body.position)) {
      patch.position = body.position;
    }
    if (typeof body.code === "string" && body.code.length > DECK_CODE_MAX) {
      sendJsonCors(res, 400, { error: "共有コードが不正です" });
      return true;
    }
    if (typeof body.code === "string" && body.code) {
      let payload;
      try {
        payload = deckCode.decodeDeckShareCode(body.code);
      } catch (error) {
        sendJsonCors(res, 400, { error: `共有コードが不正です: ${error.message}` });
        return true;
      }
      const { cardIds, flagIds, unlimitedCardIds, limitGroups, buddyCountRules, cardNames } = await getDeckValidationSets();
      const result = deckCode.validateDeckCodePayload(payload, {
        cardIds,
        flagIds,
        unlimitedCardIds,
        limitGroups,
        buddyCountRules,
        cardNames,
      });
      if (!result.ok) {
        sendJsonCors(res, 400, { error: result.reason });
        return true;
      }
      patch.code = body.code;
      patch.flag = result.normalized.flag;
      patch.buddy = result.normalized.buddy;
      patch.cardCount = result.normalized.recipe.reduce((sum, [, c]) => sum + c, 0);
      if (typeof body.name !== "string" || !body.name.trim()) {
        patch.name = result.normalized.name;
      }
    }
    const deck = await userStore.putDeck(user.id, { ...existing, ...patch });
    sendJsonCors(res, 200, { deck });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/admin/users") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    if (!user.isAdmin) {
      sendJsonCors(res, 403, { error: "forbidden" });
      return true;
    }
    const users = await userStore.listUsers();
    sendJsonCors(res, 200, { users });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/auth/admin/reset-password") {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    if (!user.isAdmin) {
      sendJsonCors(res, 403, { error: "forbidden" });
      return true;
    }
    const body = await readJson(req);
    const targetName = typeof body.name === "string" ? body.name.trim() : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (newPassword.length < 4) {
      sendJsonCors(res, 400, { error: "パスワードは4字以上で指定してください" });
      return true;
    }
    const target = targetName ? await userStore.getUserByName(targetName) : null;
    if (!target) {
      sendJsonCors(res, 404, { error: "ユーザーが見つかりません" });
      return true;
    }
    await userStore.setPassword(target.id, hashPassword(newPassword));
    await userStore.deleteSessionsByUser(target.id);
    sendNoContentCors(res, 204);
    return true;
  }

  if (req.method === "DELETE" && /^\/auth\/admin\/users\/[^/]+$/.test(url.pathname)) {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJsonCors(res, 401, { error: "unauthorized" });
      return true;
    }
    if (!user.isAdmin) {
      sendJsonCors(res, 403, { error: "forbidden" });
      return true;
    }
    const targetName = decodeURIComponent(url.pathname.slice("/auth/admin/users/".length));
    if (targetName.toLowerCase() === user.name.toLowerCase()) {
      sendJsonCors(res, 400, { error: "自分自身は削除できません" });
      return true;
    }
    const target = await userStore.getUserByName(targetName);
    if (!target) {
      sendJsonCors(res, 404, { error: "ユーザーが見つかりません" });
      return true;
    }
    await userStore.deleteUser(target.id);
    sendNoContentCors(res, 204);
    return true;
  }

  // GET /auth/decks  （ロビーのデッキ選択用。プリセット一覧）
  if (req.method === "GET" && url.pathname === "/auth/decks") {
    sendJson(res, 200, { decks: await getDeckList() });
    return true;
  }

  // POST /auth/rooms  （部屋作成＋作成者を席0で参加）
  if (req.method === "POST" && url.pathname === "/auth/rooms") {
    // F3: 部屋の乱造でメモリ/永続層を食い潰させない（IPごとのレート制限＋総数上限）。
    if (!checkRateLimit(clientIp(req), "create")) {
      sendJson(res, 429, { error: "部屋の作成が多すぎます。しばらくしてから再試行してください" });
      return true;
    }
    if (rooms.size >= LIMITS.maxRooms) {
      sendJson(res, 503, { error: "サーバーが混雑しています（部屋数の上限）。しばらくしてから再試行してください" });
      return true;
    }
    const body = await readJson(req);
    const deckResult = await normalizeRoomDeck(body.deck); // F2
    if (deckResult.error) {
      sendJson(res, 400, { error: deckResult.error });
      return true;
    }
    const userId = await resolveOptionalUserId(req); // D5: ログイン中なら席に userId を紐づける
    const room = createRoom();
    const member = addMember(room, { name: body.name, userId, remoteAddress: clientIp(req) });
    room.hostClientId = member.clientId; // 部屋を立てた人がホスト（キックの権限者）
    member.deck = deckResult.deck;
    schedulePersist(room);
    sendJson(res, 201, { roomId: room.id, clientId: member.clientId, token: member.token, role: member.role, isHost: true });
    return true;
  }

  if (parts[0] !== "auth" || parts[1] !== "rooms" || !parts[2]) {
    return false;
  }
  const room = rooms.get(parts[2]);
  if (!room) {
    sendJson(res, 404, { error: "room not found" });
    return true;
  }

  // POST /auth/rooms/:id/join
  // 冪等: 既にこの部屋のメンバーなら新しい席を作らず、その人の membership をそのまま返す。
  // 「参加」を2回押す・戻る/リロード後にもう一度押す、で観戦者が増殖して席が埋まり、
  // 開始ゲート（両席＋両者デッキ）が満たせなくなる事故を防ぐ。
  if (req.method === "POST" && parts[3] === "join") {
    if (!checkRateLimit(clientIp(req), "join")) {
      sendJson(res, 429, { error: "参加の試行が多すぎます。しばらくしてから再試行してください" });
      return true;
    }
    const body = await readJson(req);
    // F2: deck は「指定があれば」検証する（未指定=既存のデッキを維持）。
    let joinDeck;
    if (body.deck !== undefined && body.deck !== null) {
      const deckResult = await normalizeRoomDeck(body.deck);
      if (deckResult.error) {
        sendJson(res, 400, { error: deckResult.error });
        return true;
      }
      joinDeck = deckResult.deck;
    }
    const userId = await resolveOptionalUserId(req); // D5
    // ① 自分のトークンを持っている＝この部屋に既にいる（所持自体が本人証明）。
    let member = body.token ? memberByToken(room, body.token) : null;
    // ② ログイン中なら同じユーザーの席を再利用する（別タブ/別端末からの重複参加も1人分に畳む）。
    //    userId は Bearer 検証済みなので、既存トークンを返しても他人になりすませない。
    if (!member && userId) {
      member = [...room.members.values()].find((m) => m.userId && m.userId === userId) || null;
    }
    if (member) {
      if (clampText(body.name, NAME_MAX)) member.name = clampText(body.name, NAME_MAX);
      // 開始後の再参加ではデッキを差し替えない（盤面は開始時のデッキで確定済み。F7）。
      if (joinDeck && !room.started) member.deck = joinDeck;
      room.updatedAt = Date.now();
      broadcastLobby(room);
      schedulePersist(room);
      sendJson(res, 200, {
        roomId: room.id,
        clientId: member.clientId,
        token: member.token,
        role: member.role,
        isHost: member.clientId === room.hostClientId,
        rejoined: true, // クライアントは「すでに参加済み」を案内できる
      });
      return true;
    }
    // キック直後の再入室はしばらく断る（ホストのキックが無意味にならないように）。
    const blockedFor = isKickBlocked(room, req, userId);
    if (blockedFor > 0) {
      sendJson(res, 403, { error: `この部屋からキックされています（あと約${blockedFor}秒で再参加できます）` });
      return true;
    }
    // F3: 1部屋の参加者数に上限（観戦者の無限増殖でロビー配信/永続化が肥大化しないように）。
    if (room.members.size >= LIMITS.maxMembersPerRoom) {
      sendJson(res, 409, { error: `この部屋は満員です（最大${LIMITS.maxMembersPerRoom}人）` });
      return true;
    }
    member = addMember(room, { name: body.name, userId, remoteAddress: clientIp(req) });
    reassignHostIfNeeded(room); // 復元直後などホスト不在の部屋なら最初の参加者がホストになる
    if (joinDeck && !room.started) {
      member.deck = joinDeck;
    }
    broadcastLobby(room);
    schedulePersist(room);
    sendJson(res, 200, {
      roomId: room.id,
      clientId: member.clientId,
      token: member.token,
      role: member.role,
      isHost: member.clientId === room.hostClientId,
    });
    return true;
  }

  // POST /auth/rooms/:id/kick  （ホストが他のメンバーを部屋から出す）
  // 権限: ホストのみ。自分自身は対象にできない。
  // タイミング: 観戦者はいつでも可。対戦席の人は「未開始 or 決着後」のみ
  //   （進行中に席の人を消すと、投了を代理で押すのと同じになり勝敗が歪むため）。
  if (req.method === "POST" && parts[3] === "kick") {
    const body = await readJson(req);
    const caller = memberByToken(room, body.token);
    if (!caller) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    if (caller.clientId !== room.hostClientId) {
      sendJson(res, 403, { error: "部屋を立てた人だけがキックできます" });
      return true;
    }
    if (room.busy) {
      sendJson(res, 409, { error: "他の操作を処理中です（少し待って再試行してください）" });
      return true;
    }
    const target = room.members.get(String(body.clientId || ""));
    if (!target) {
      sendJson(res, 404, { error: "対象が見つかりません（すでに退出しています）" });
      return true;
    }
    if (target.clientId === caller.clientId) {
      sendJson(res, 400, { error: "自分はキックできません（退出は「部屋を出る」）" });
      return true;
    }
    const gameState = room.started && room.game ? room.game.api.getState() : null;
    const inGame = Boolean(room.started && room.game && gameState && gameState.winner == null);
    const targetIsPlayer = target.role === 0 || target.role === 1;
    if (inGame && targetIsPlayer) {
      sendJson(res, 409, {
        error: "対戦中の対戦者はキックできません（「試合を中断」で勝敗を残さず終われます）",
      });
      return true;
    }
    // 当人へ通知してから外す（外した後だと SSE が閉じていて届かない）。
    if (target.sse) {
      writeSse(target.sse, { type: "kicked", text: `部屋 ${room.id} から退出させられました` });
    }
    // 同じ相手がすぐ入り直せるとキックの意味が無いので、しばらく再入室を断る。
    for (const key of kickBlockKeys(target.remoteAddress, target.userId)) {
      room.kickBlocks.set(key, Date.now() + KICK_BLOCK_MS);
    }
    vacateSeatOf(room, target.clientId);
    room.members.delete(target.clientId);
    closeSseOf(target);
    reassignHostIfNeeded(room);
    room.updatedAt = Date.now();
    if (room.members.size === 0) {
      closeAndForgetRoom(room);
      sendJson(res, 200, { ok: true, kicked: target.clientId, roomClosed: true });
      return true;
    }
    broadcastLobby(room);
    for (const other of room.members.values()) {
      if (other.sse) {
        writeSse(other.sse, { type: "notice", text: `${target.name}が部屋から退出させられました` });
      }
    }
    persistNow(room);
    sendJson(res, 200, { ok: true, kicked: target.clientId });
    return true;
  }

  // POST /auth/rooms/:id/leave  （部屋から退出）。ロビー中=単純退出／対戦中の対戦者=投了／決着後・観戦者=退出のみ。
  if (req.method === "POST" && parts[3] === "leave") {
    const body = await readJson(req);
    const member = memberByToken(room, body.token);
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    // アクション適用/プロンプト往復ホールド中は state を触らせない（/replay と同じ確定性ゲート）。クライアントはリトライ。
    if (room.busy) {
      sendJson(res, 409, { error: "他の操作を処理中です（少し待って再試行してください）" });
      return true;
    }
    const gameState = room.started && room.game ? room.game.api.getState() : null;
    const inGame = Boolean(room.started && room.game && gameState && gameState.winner == null);
    const isPlayer = member.role === 0 || member.role === 1;
    if (inGame && isPlayer) {
      // 対戦中の対戦者の退出＝投了。退出者の負け＝相手の勝ちで決着させ、戦績に記録する。
      // declareForfeit が winner/winnerSeat/winReason を単一 seat から立てるので名前↔席は必ず整合する。
      room.game.declareForfeit(member.role);
      room.updatedAt = Date.now();
      // 決着記録は退出者を members/seats から外す前に行う。外した後だと退出者=ログインユーザーの
      // 敗戦が記録されない（maybeRecordMatch は room.seats→member.userId で席のユーザーを引くため）。
      // state.matchResult を読んで席のユーザーへ記録（勝者=win/敗者=loss。二重記録は room.matchRecorded ガード）。
      await maybeRecordMatch(room);
      // 退出者は members から削除し席を空ける。相手は「勝ち」表示のまま部屋に残す（相手も後で /leave するか TTL で掃除）。
      vacateSeatOf(room, member.clientId);
      room.members.delete(member.clientId);
      reassignHostIfNeeded(room); // ホストが投了退出しても、残った人がキックできる状態を保つ
      // 残るメンバーへ勝者viewを配信し、対戦者へ「相手退出＝あなたの勝ち」を通知（token/伏せ札/seed は載せない＝テキストのみ）。
      broadcastView(room, "相手が退出しました");
      for (const other of room.members.values()) {
        if (other.sse && (other.role === 0 || other.role === 1)) {
          writeSse(other.sse, { type: "notice", text: "相手が退出しました（あなたの勝ちです）" });
        }
      }
      persistNow(room); // 決着後の確定局面を保存（相手が再接続しても勝者viewを復元できる）
      sendJson(res, 200, { ok: true, left: true, forfeited: true });
      return true;
    }
    // ロビー中・決着後・観戦者＝単純退出（投了は起きない）。メンバーが0人になった部屋は閉じる。
    vacateSeatOf(room, member.clientId);
    room.members.delete(member.clientId);
    reassignHostIfNeeded(room); // ホストが抜けたら最古の残存メンバーへ委譲
    if (room.members.size === 0) {
      closeAndForgetRoom(room);
    } else {
      broadcastLobby(room);
      persistNow(room);
    }
    sendJson(res, 200, { ok: true, left: true });
    return true;
  }

  // POST /auth/rooms/:id/abort  （試合中断＝勝敗を残さず部屋を閉じる）。対戦者のみ・片側の操作で成立（相手の同意は不要）。
  if (req.method === "POST" && parts[3] === "abort") {
    const body = await readJson(req);
    const member = memberByToken(room, body.token);
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    if (member.role !== 0 && member.role !== 1) {
      sendJson(res, 403, { error: "観戦者は中断できません" });
      return true;
    }
    // /leave と同じく処理中は 409（クライアントがリトライ）。
    if (room.busy) {
      sendJson(res, 409, { error: "他の操作を処理中です（少し待って再試行してください）" });
      return true;
    }
    const gameState = room.started && room.game ? room.game.api.getState() : null;
    if (!(room.started && room.game && gameState && gameState.winner == null)) {
      sendJson(res, 409, { error: "中断できる対戦がありません" });
      return true;
    }
    // 勝敗は記録しない（matchRecordCheckpoint を呼ばない・winner を立てない＝アボート）。
    // 全メンバー（観戦者含む）へ中断を通知してから部屋を閉じる。
    for (const m of room.members.values()) {
      if (m.sse) {
        writeSse(m.sse, { type: "aborted", text: "試合が中断されました" });
      }
    }
    closeAndForgetRoom(room);
    sendJson(res, 200, { ok: true, aborted: true });
    return true;
  }

  // POST /auth/rooms/:id/replay  （決着済み対戦のリプレイを保存し {id} を返す。部屋メンバーのみ・進行中は409・冪等）
  if (req.method === "POST" && parts[3] === "replay") {
    const body = await readJson(req);
    const member = memberByToken(room, body.token);
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    if (!room.started || !room.game) {
      sendJson(res, 409, { error: "ゲーム未開始" });
      return true;
    }
    // 【最重要・セキュリティ】アクション適用中（プロンプト往復のホールド含む）は保存しない＝busy=false の確定局面のみ。
    // state.winner は決着中に「立って戻り得る（可逆）」: ライフリンクのダメージで一旦 winner が立ち、対抗の
    // ライフリンク相殺 clearWinnerIfNoCurrentLoss(src/11) が life を戻すと winner を null に戻す。この相殺の可否を
    // 問う往復プロンプトの間 room.busy=true になり、その瞬間に相手が /replay を叩くと winner!=null をすり抜けて
    // 進行中対戦の seed をリプレイJSON経由で共有URLへ漏らせてしまう（B1 で塞いだシード漏洩の復活）。
    // persistNow と同じく busy 中は拒否し、決着が確定した安定局面でのみ保存する。
    if (room.busy) {
      sendJson(res, 409, { error: "他の操作を処理中です（決着が確定してから保存できます）" });
      return true;
    }
    // リプレイJSONには seed が必須で入る。決着後のみ許可し、クライアントを信用せずサーバで強制する（state.winner）。
    const gameState = room.game.api.getState();
    if (!gameState || gameState.winner == null) {
      sendJson(res, 409, { error: "対戦が決着してから保存できます（進行中は共有できません）" });
      return true;
    }
    // 冪等: 既に保存済みなら同じ id を返す（再送しても複製しない）。
    if (room.savedReplayId) {
      sendJson(res, 200, { id: room.savedReplayId });
      return true;
    }
    // 保存対象は必ず getRecording() の戻り値のみ。部屋スナップショット全体は member.token を含み漏洩する。
    const recording = room.game.getRecording();
    if (!recording) {
      sendJson(res, 409, { error: "この対戦は記録されていません（復元された対戦などは保存できません）" });
      return true;
    }
    try {
      await ensureReplayStoreInitialized();
    } catch (error) {
      sendJson(res, 503, {
        error: "リプレイ保管に接続できません",
        detail: String(error && error.message ? error.message : error),
      });
      return true;
    }
    // 保存者の userId は任意の Bearer から（部屋メンバー認可は token 済み）。未ログインなら null＝一覧に出さない。
    let userId = null;
    try {
      await ensureUserStoreInitialized();
      const user = await authenticateRequest(req);
      if (user) userId = user.id;
    } catch {
      /* ユーザーDB不通でもリプレイ保存自体は続行（userId=null で保存） */
    }
    const id = randomReplayId();
    await replayStore.save(id, { replay: recording, userId, roomId: room.id, savedAt: Date.now() });
    room.savedReplayId = id;
    await backfillMatchReplayId(room, id); // D5: この対戦の戦績に replayId を後付け（履歴→再生の導線）
    sendJson(res, 201, { id });
    return true;
  }

  // GET /auth/rooms/:id/me?token=...  （再接続前のトークン生存確認。EventSourceでは403を読めないため）
  if (req.method === "GET" && parts[3] === "me") {
    const member = memberByToken(room, url.searchParams.get("token"));
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    sendJson(res, 200, { roomId: room.id, clientId: member.clientId, role: member.role, started: room.started });
    return true;
  }

  // GET /auth/rooms/:id/sync?token=...  （SSE非依存のフォールバック取得。
  // 逆プロキシ(Render等)でSSEがバッファ/切断され lobby/view が届かない環境でも、
  // クライアントがポーリングで現在のロビー＋自分のviewを取得して同期できるようにする）。
  if (req.method === "GET" && parts[3] === "sync") {
    const member = memberByToken(room, url.searchParams.get("token"));
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    const lobby = { ...lobbyPayload(room, member), type: "lobby" };
    const view = viewPayloadFor(room, member, "sync");
    sendJson(res, 200, { lobby, view: view || null });
    return true;
  }

  // GET /auth/rooms/:id/events?token=...
  if (req.method === "GET" && parts[3] === "events") {
    const token = url.searchParams.get("token");
    const member = memberByToken(room, token);
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    // 逆プロキシ/CDN(Render等)はSSEの最初の数KBをバッファして即時flushしないことがある。
    // 大きめの初回コメント(パディング)を流してバッファ閾値を超えさせ、hello/view を即届かせる。
    res.write(`:${" ".repeat(2048)}\n\n`);
    // F8: 同じメンバーの旧SSEを閉じてから差し替える（1メンバー1本に制限）。旧実装は前の応答を開いたまま
    // 参照だけ捨てたため、同一 token で開き直すたびに接続とハートビート interval が漏れ続けた。
    // 旧接続へは retry を極大にしてから閉じる＝旧タブの EventSource が自動再接続して新タブと奪い合わない。
    if (member.sse && member.sse !== res) {
      const prev = member.sse;
      try {
        prev.write("retry: 86400000\n\n");
        writeSse(prev, { type: "notice", text: "別の画面で同じ席に接続したため、この画面への配信を停止しました" });
      } catch {
        /* 既に切れている旧接続は無視 */
      }
      closeSseOf(member);
    }
    member.sse = res;
    room.updatedAt = Date.now();
    // キープアライブ: アイドルSSEはモバイル回線/逆プロキシ(Render/fly.io等)に切られやすく、
    // バッファ環境では view 等の単発メッセージが次の書き込みまで届かないため、15秒ごとにコメント行を送る
    // （EventSource は無視。再接続の頻発を抑止＋バッファflushを促す）。
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);
    heartbeat.unref?.();
    res.__bfCleanup = () => clearInterval(heartbeat);
    res.on("close", () => clearInterval(heartbeat));
    // hello: 現在のロビー＋（開始済みなら）自分のview（type は最後に置いて上書き防止）
    writeSse(res, { ...lobbyPayload(room, member), type: "hello" });
    const view = viewPayloadFor(room, member, "現局面");
    if (view) {
      writeSse(res, view);
    }
    // 切断中に在席していた未応答プロンプトを再配信（ホールド中 applyAction のデッドロック回避）。
    for (const pending of room.pendingPrompts.values()) {
      if (pending.clientId === member.clientId && pending.payload) {
        writeSse(res, pending.payload);
      }
    }
    broadcastLobby(room); // 他メンバーへ online 状態を反映
    req.on("close", () => {
      clearInterval(heartbeat);
      if (member.sse === res) {
        member.sse = null;
      }
      broadcastLobby(room);
    });
    return true;
  }

  // POST /auth/rooms/:id/lobby  （役割変更・席入替・デッキ選択・開始）
  if (req.method === "POST" && parts[3] === "lobby") {
    const body = await readJson(req);
    const member = memberByToken(room, body.token);
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    if (body.action === "assign") {
      const result = assignRole(room, member, body.role);
      if (result.error) {
        sendJson(res, 409, result);
        return true;
      }
    } else if (body.action === "swapSeats") {
      // F7: 席入替は対戦者本人かホストのみ（観戦者が勝手に席を入れ替えられないように）。
      if (!canControlLobby(room, member)) {
        sendJson(res, 403, { error: "席の入替は対戦者かホストだけが行えます" });
        return true;
      }
      const result = swapSeats(room);
      if (result.error) {
        sendJson(res, 409, result);
        return true;
      }
    } else if (body.action === "setDeck") {
      // F7: 開始後のデッキ差し替えは無意味かつ復元時の混線源なので拒否。F2: 中身は必ず検証する。
      if (room.started) {
        sendJson(res, 409, { error: "ゲーム開始後はデッキを変更できません" });
        return true;
      }
      const deckResult = await normalizeRoomDeck(body.deck);
      if (deckResult.error) {
        sendJson(res, 400, { error: deckResult.error });
        return true;
      }
      member.deck = deckResult.deck;
    } else if (body.action === "start") {
      if (room.started) {
        sendJson(res, 409, { error: "already started" });
        return true;
      }
      // F7: 開始できるのは対戦者本人かホストのみ（観戦者による勝手な開始を防ぐ）。
      if (!canControlLobby(room, member)) {
        sendJson(res, 403, { error: "対戦の開始は対戦者かホストだけが行えます" });
        return true;
      }
      if (!room.seats[0] || !room.seats[1]) {
        sendJson(res, 409, { error: "両席が埋まっていません" });
        return true;
      }
      // F7: play.js の開始ゲートと同じく両者のデッキ確定を必須にする（未確定だと engine が既定デッキで黙って始める）。
      const seatMembers = room.seats.map((id) => room.members.get(id));
      if (seatMembers.some((m) => !m || !m.deck)) {
        sendJson(res, 409, { error: "両者のデッキが確定していません" });
        return true;
      }
      if (room.busy || room.starting) {
        sendJson(res, 409, { error: "他の操作を処理中です" });
        return true;
      }
      // F3: 開始（=GameRoom 生成。1局30MB超・数百ms）の連打と同時対局数を抑える。
      if (!checkRateLimit(clientIp(req), "start")) {
        sendJson(res, 429, { error: "開始の試行が多すぎます。しばらくしてから再試行してください" });
        return true;
      }
      if (countActiveGames() >= LIMITS.maxActiveGames) {
        sendJson(res, 503, { error: "サーバーが混雑しています（同時対戦数の上限）。しばらくしてから再試行してください" });
        return true;
      }
      // 開始処理（loadData の await）中の二重開始で GameRoom が2つ作られないよう印を立てる。
      room.starting = true;
      try {
        await startGame(room);
      } catch (error) {
        sendJson(res, 500, { error: `開始に失敗: ${error.message}` });
        return true;
      } finally {
        room.starting = false;
      }
      broadcastLobby(room);
      broadcastView(room, "ゲーム開始");
      persistNow(room); // 開始直後の確定局面を保存
      sendJson(res, 200, { ok: true, started: true });
      return true;
    } else {
      sendJson(res, 400, { error: "unknown lobby action" });
      return true;
    }
    broadcastLobby(room);
    schedulePersist(room); // 役割変更/席入替/デッキ選択を保存
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /auth/rooms/:id/action  （操作を適用→役割別view配信）
  if (req.method === "POST" && parts[3] === "action") {
    const body = await readJson(req);
    const member = memberByToken(room, body.token);
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    if (!room.started || !room.game) {
      sendJson(res, 409, { error: "ゲーム未開始" });
      return true;
    }
    if (member.role !== 0 && member.role !== 1) {
      sendJson(res, 403, { error: "観戦者は操作できません" });
      return true;
    }
    const state = room.game.api.getState();
    // 別アクションの処理中（プロンプト往復のホールド含む）は先に弾く。下の可否判定は busy 中に
    // エンジンの finder を走らせない（ホールド中の applyAction が触っている state.selected を乱さない）。
    if (room.busy) {
      sendJson(res, 409, { error: "他の操作を処理中です" });
      return true;
    }
    if (!canActorActNow(state, member.role, { type: body.type, params: body.params || {}, game: room.game })) {
      const offTurnIdle = !state.winner && !state.pendingAttack && !state.pendingAction && member.role !== state.active;
      sendJson(res, 409, {
        error: offTurnIdle
          ? "相手のターン中は、今使える【対抗】のカード・能力しか使えません"
          : "今あなたの操作番ではありません",
      });
      return true;
    }
    // 攻撃/効果の「解決」は対抗ウィンドウを担当する席（防御側/応答側）のみが送れる。
    // 攻撃側が resolve を送って防御側の対抗窓を飛ばすのを防ぐ（中継版 src/07 の解決ガード相当）。
    if (body.type === "resolve" && (state.pendingAttack || state.pendingAction)) {
      const resolver = inferPromptSeat(state);
      if (member.role !== resolver) {
        sendJson(res, 409, { error: "対抗確認を担当する相手席の解決を待っています。" });
        return true;
      }
    }
    // selected.owner は行動席と一致していなければ受理しない（自分のカードでのみ行動＝相手の場/ドロップ能力の誤発動を防ぐ）。
    // 設計上チート対策は非目標だが、正規クライアント play.js は常に owner=mySeat を送る（相手参照は effectTarget/attackTarget 経由）ため通常プレイに影響しない安全な多重防御。
    const selectedOwner = body.params?.selected?.owner;
    if ((selectedOwner === 0 || selectedOwner === 1) && selectedOwner !== member.role) {
      sendJson(res, 403, { error: "他プレイヤーのカードでは操作できません" });
      return true;
    }
    // 別アクションの処理中（プロンプト往復のホールド含む）は受理しない。
    // 同一エンジンへの applyAction 再入＝vm state 破壊を防ぐ。応答は /prompt 経由で行う。
    if (room.busy) {
      sendJson(res, 409, { error: "他の操作を処理中です" });
      return true;
    }
    room.busy = true;
    try {
      await room.game.applyAction(member.role, body.type, body.params || {});
    } catch (error) {
      sendJson(res, 400, { error: `アクション失敗: ${error.message}` });
      return true;
    } finally {
      room.busy = false;
    }
    room.updatedAt = Date.now();
    // F9: label はクライアント任意文字列で全員へ配信されるため長さを丸める。
    broadcastView(room, clampText(typeof body.label === "string" && body.label ? body.label : String(body.type || ""), LABEL_MAX));
    await maybeRecordMatch(room); // D5: 決着していれば席のログインユーザーへ戦績を記録（best-effort・内部で握る）
    persistNow(room); // busy=false 確定後の最新局面を保存（往復ホールド後もここで保存される）
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /auth/rooms/:id/prompt  （往復プロンプトへの応答 → ホールド中の applyAction を再開）
  if (req.method === "POST" && parts[3] === "prompt") {
    const body = await readJson(req);
    const member = memberByToken(room, body.token);
    if (!member) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    const pending = room.pendingPrompts.get(body.requestId);
    if (!pending) {
      sendJson(res, 409, { error: "unknown or expired prompt" });
      return true;
    }
    // 宛先本人のみ応答可（他席/観戦者の横取り防止）。
    if (pending.clientId && member.clientId !== pending.clientId) {
      sendJson(res, 403, { error: "not your prompt" });
      return true;
    }
    clearTimeout(pending.timer);
    room.pendingPrompts.delete(body.requestId);
    pending.resolve(body.response);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function startGame(room) {
  // 両席メンバーのデッキを集約（カスタムは deck.custom に定義を載せて持ち寄り）。
  const seat0 = room.members.get(room.seats[0]);
  const seat1 = room.members.get(room.seats[1]);
  // 両席が同一の自作デッキ（共有コード由来で id が同一）を持ち寄ると、engine が deck.id で
  // デッキ解決する際に2件が衝突して両席が同じ定義に混線しうる。席1側の id を一意化する。
  // deck.id と custom.id は照合に両方使うため同時に書き換える（engine-host.startGame 参照）。
  if (seat0?.deck?.custom && seat1?.deck?.custom && seat0.deck.id === seat1.deck.id) {
    const uniqueId = `${seat1.deck.id}__seat1`;
    seat1.deck = { ...seat1.deck, id: uniqueId, custom: { ...seat1.deck.custom, id: uniqueId } };
  }
  const customDecks = [];
  for (const m of [seat0, seat1]) {
    if (m.deck && m.deck.custom) {
      customDecks.push(m.deck.custom);
    }
  }
  // B3: record:true で実対戦を記録する（決着後に /replay で保存できるように）。記録オフ時のオーバーヘッドは
  // B2 で担保済み・オン時のメモリ増は「操作数×数百バイト」程度（1ゲーム概ね数十〜200KB）。
  const game = new GameRoom({ record: true, customDecks, onPrompt: (req) => dispatchPrompt(room, req) });
  await game.loadData();
  const deckIds = [seat0.deck?.id, seat1.deck?.id];
  // B1: 先攻は部屋作成者(seat0)固定を廃止し、シード乱数で決める（GameRoom がシードを生成・記録）。
  game.startGame(deckIds, { firstSeat: "random" });
  room.game = game;
  room.started = true;
}

// D5(戦績): 決着を state から検知し、席に紐づくログイン済みユーザーへ記録する。勝敗はサーバが判定し
// クライアント申告は信用しない（source:"server"）。未ログイン席は黙って飛ばす。1対戦1回（room.matchRecorded）。
// fightId keyed の upsert なので、万一二重に呼ばれても複製しない。
async function maybeRecordMatch(room) {
  if (!room || room.matchRecorded || !room.game) return;
  let st;
  try {
    st = room.game.api.getState();
  } catch {
    return;
  }
  const mr = st && st.matchResult;
  if (!mr) return; // 未決着（engine の決着フックが state.matchResult を確定させるまで何もしない）
  if (room.matchRecorded) return; // 既に記録済み（冪等ガード）。
  try {
    await ensureUserStoreInitialized();
  } catch {
    return; // ユーザーDB不通なら**フラグを立てず**スキップ＝次の機会（次アクション等）に再試行させる。
  }
  const deckIds = Array.isArray(mr.deckIds) ? mr.deckIds : [null, null];
  let eligible = 0; // 記録対象（ログイン済み席）の数
  let recorded = 0; // 実際に書けた数
  for (const seat of [0, 1]) {
    const member = room.members.get(room.seats[seat]);
    if (!member || member.userId == null) continue; // 未ログイン席は記録しない
    eligible += 1;
    const record = {
      fightId: st.fightId || null,
      finishedAt: Date.now(),
      outcome: seat === mr.winnerSeat ? "win" : "loss",
      reason: mr.reason,
      firstSeat: mr.firstSeat,
      turnCount: mr.turnCount,
      deckId: deckIds[seat] ?? null,
      opponentDeckId: deckIds[1 - seat] ?? null,
      replayId: room.savedReplayId || null,
      source: "server", // 権威判定＝クライアント申告(source:"client")に勝つ
    };
    try {
      await userStore.putMatch(member.userId, record);
      recorded += 1;
    } catch (error) {
      console.warn(`[match] room ${room.id} seat ${seat} の戦績記録に失敗: ${error.message}`);
    }
  }
  // matchRecorded は「記録すべき席が全部書けた」時だけ立てる（全員未ログイン＝eligible0 も完了扱い）。
  // DB 一時不通で書けなかった席が残る場合はフラグを立てず、次の機会に再試行させる。
  // putMatch は (userId, fightId) 冪等 upsert なので、成功済みの席を再試行しても二重記録にならない。
  if (recorded === eligible) {
    room.matchRecorded = true;
    room.decidedFightId = st.fightId || null;
  }
}

// D5: リプレイ保存後に、その対戦の戦績レコードへ replayId を後付けする（決着時は未確定のため）。
async function backfillMatchReplayId(room, replayId) {
  if (!room || !room.game) return;
  let fightId = room.decidedFightId || null;
  if (!fightId) {
    try {
      fightId = room.game.api.getState()?.fightId || null;
    } catch {
      fightId = null;
    }
  }
  if (!fightId) return;
  try {
    await ensureUserStoreInitialized();
  } catch {
    return;
  }
  for (const seat of [0, 1]) {
    const member = room.members.get(room.seats[seat]);
    if (!member || member.userId == null) continue;
    try {
      await userStore.setMatchReplayId(member.userId, fightId, replayId);
    } catch {
      /* best-effort */
    }
  }
}

// ---- 静的配信の許可リスト（F4） ----
// 旧実装はリポジトリ直下を丸ごと配信しており、HANDOFF.md/CLAUDE.md/server/*.js/_scratch/**/.gitignore 等の
// 内部資料・サーバソースまで取得できた。配信はページが実際に読むファイルだけに限る:
//   ・直下: ユーザー向けページ(*.html)と、それらが <script>/<link> で読むクライアント js/css
//     （index/play/replay は ENGINE_VERSION ローダで src/* ＋ deck-picker/deck-code/user-api(+play.js) を読む。
//      builder/gallery は builder.js/gallery.js/deck-code.js/deck-picker.js/user-api.js と各 css を手書き ?v= で読む。
//      netplay.html は旧中継版だが e2e の読込確認対象なので残す＝読むのは src/* と styles.css のみ）
//   ・src/*.js（直下のみ）・data/**（カードJSON・imgpack・画像）
// それ以外（*.md・ドットで始まるパス・server/ tools/ tests/ e2e/ docs/ _scratch/ 等）は配信しない。
// ページが新しいファイルを読むようになったら、ここに足すこと（足し忘れは 404 で即気付ける）。
const STATIC_ROOT_FILES = new Set([
  "index.html",
  "play.html",
  "replay.html",
  "builder.html",
  "gallery.html",
  "netplay.html",
  "play.js",
  "builder.js",
  "gallery.js",
  "deck-picker.js",
  "deck-code.js",
  "user-api.js",
  "styles.css",
  "builder.css",
  "gallery.css",
]);
const STATIC_DATA_EXTS = new Set([".json", ".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg"]);
// 明示拒否（403）にする危険パス。許可リスト外は通常 404 だが、これらは「あるが見せない」ことを明確にする。
const STATIC_DENY_DIRS = new Set(["server", "tools", "tests", "e2e", "docs", "_scratch", "node_modules"]);

// requestPath（先頭 / 付き・デコード済み）→ "allow" | "deny" | "missing"
function staticAccess(requestPath) {
  const rel = requestPath.replace(/^\/+/, "");
  const segments = rel.split("/");
  if (!rel || segments.some((seg) => seg === "" || seg === "." || seg === "..")) return "deny";
  if (segments.some((seg) => seg.startsWith("."))) return "deny"; // .git/ .gitignore .env 等
  if (/\.md$/i.test(rel)) return "deny";
  if (STATIC_DENY_DIRS.has(segments[0])) return "deny";
  if (segments.length === 1) return STATIC_ROOT_FILES.has(rel) ? "allow" : "missing";
  if (segments[0] === "src") return segments.length === 2 && rel.endsWith(".js") ? "allow" : "missing";
  if (segments[0] === "data") {
    return STATIC_DATA_EXTS.has(path.extname(rel).toLowerCase()) ? "allow" : "missing";
  }
  return "missing";
}

function serveStatic(req, res, url) {
  // 権威サーバのクライアントは play.html（手札秘匿のシンクライアント）。
  // ルート直打ち時は play.html を返す（netplay.html は中継版=netplay-server.js 用で /auth/* に繋がらない）。
  let requestPath;
  try {
    requestPath = url.pathname === "/" ? "/play.html" : decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { error: "bad request" }); // 壊れた %エンコード
    return;
  }
  if (requestPath.includes("\0") || requestPath.includes("\\")) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  const filePath = path.resolve(rootDir, `.${requestPath}`);
  if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  // 永続データ(token を含む)は静的配信しない（dataDir を誤って root 内に置いた場合の二重防御）。
  if (filePath === dataDir || filePath.startsWith(dataDir + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  const access = staticAccess(path.relative(rootDir, filePath).split(path.sep).join("/"));
  if (access === "deny") {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  if (access !== "allow") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const ext = path.extname(filePath);
    const headers = { "Content-Type": contentTypes[ext] || "application/octet-stream" };
    // キャッシュ方針（初期ロード最適化 D2）:
    // - *.html はローダ本体。ENGINE_VERSION 更新を即反映させるため常に再検証させる（no-cache）。
    // - data/**（カードJSON・imgpack）と ?v= 付きアセットは内容がURLで固定される＝長期immutable。
    //   ?v= 付きは builder.js/deck-picker 等・src モジュール（?v=ENGINE_VERSION）も含む。
    if (ext === ".html") {
      headers["Cache-Control"] = "no-cache";
    } else if (requestPath.startsWith("/data/") || url.searchParams.has("v")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  let url = null;
  try {
    // F1: URL 解析も try の内側で、Host ヘッダは使わない（固定ベース）。旧実装は try の外で
    // `http://${req.headers.host}` を解析しており、`Host: [` のような壊れたヘッダ1本でプロセスごと落ちた。
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    if (await handleApi(req, res, url)) {
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    // 本文の上限超過(413)・壊れたJSON(400)は statusCode 付きで来る。413 は残りの本文を読まずに切断する。
    const status = error && error.statusCode;
    if (status) {
      if (status === 413) res.on("finish", () => req.destroy());
      const payload = { error: error.message };
      if (url && isUserApiPath(url.pathname)) sendJsonCors(res, status, payload);
      else sendJson(res, status, payload, status === 413 ? { Connection: "close" } : null);
      return;
    }
    // ユーザーAPI経路の例外（Turso往復失敗など）は CORS 付き 503 で本当の理由を返す
    // （別オリジン配信のbuilder/index から fetch した時、CORS無し500だとブラウザが本文を読めず
    //  原因不明の「接続できません」になるため）。それ以外は従来どおり 500。
    if (url && isUserApiPath(url.pathname)) {
      sendJsonCors(res, 503, { error: "ユーザーDB処理に失敗しました", detail: error.message });
    } else {
      sendJson(res, 500, { error: error.message });
    }
  }
});
// 不正な HTTP（壊れたリクエスト行等）はソケット単位で 400 を返して閉じる（既定でも落ちないが明示）。
server.on("clientError", (error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  else socket.destroy();
});

// 部屋の掃除（1分ごと）:
//   ・未開始かつ全員オフラインで LIMITS.lobbyIdleTtlMs（既定30分）放置 → 閉じる（F3: 作るだけの部屋を溜めない）
//   ・全員オフラインで roomTtlMs（6時間）放置 → 閉じる（従来どおり）
function sweepRooms(now = Date.now()) {
  let closed = 0;
  for (const [roomId, room] of rooms) {
    const anyOnline = [...room.members.values()].some((m) => m.sse);
    if (anyOnline || room.busy || room.starting) continue;
    const idle = now - room.updatedAt;
    if ((!room.started && idle > LIMITS.lobbyIdleTtlMs) || idle > roomTtlMs) {
      closeAndForgetRoom(room, roomId); // 孤児スナップショットも掃除（飛行中の save は closed ガードで弾く）
      closed += 1;
    }
  }
  return closed;
}
setInterval(() => sweepRooms(), 60 * 1000).unref();

// 最終防衛線（直接起動時のみ登録。スモーク等の require 経路ではテスト失敗を握り潰さないよう登録しない）。
// リクエスト処理中の取りこぼし例外でプロセスごと落ちて全対局が消えるのを防ぐため、ログを残して継続する。
// ただし短時間に多発する場合は状態破損の恐れがあるので終了し、外側の再起動（Render/fly.io/bat）に任せる。
function installProcessGuards() {
  const recent = [];
  const note = (kind, error) => {
    console.error(`[guard] ${kind}:`, error && error.stack ? error.stack : error);
    const now = Date.now();
    recent.push(now);
    while (recent.length && now - recent[0] > 60 * 1000) recent.shift();
    if (recent.length > 20) {
      console.error("[guard] 1分間に未処理例外が20件を超えたため、状態破損を避けて終了します");
      process.exit(1);
    }
  };
  process.on("unhandledRejection", (reason) => note("unhandledRejection", reason));
  process.on("uncaughtException", (error) => note("uncaughtException", error));
}

// 指定ポートが使用中/予約(EADDRINUSE/EACCES)なら次のポートへ自動フォールバック。
// 起動成功後、--open 指定時は実際のポートで既定ブラウザを開く。
function startServer(srv, listenHost, startPort, { openBrowser = false, attempts = 25 } = {}) {
  let attempt = 0;
  const tryListen = () => {
    const tryPort = startPort + attempt;
    const onError = (err) => {
      if ((err.code === "EADDRINUSE" || err.code === "EACCES") && attempt < attempts - 1) {
        attempt += 1;
        console.warn(`ポート ${tryPort} は使えません(${err.code})。${startPort + attempt} を試します...`);
        setTimeout(tryListen, 0);
      } else {
        console.error(`サーバー起動に失敗しました: ${err.code || err.message}`);
        process.exit(1);
      }
    };
    srv.once("error", onError);
    srv.listen(tryPort, listenHost, () => {
      srv.removeListener("error", onError);
      const shownHost = listenHost === "0.0.0.0" ? "（このPCのIPアドレス）" : listenHost;
      const url = `http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${tryPort}/play.html`;
      console.log("============================================");
      console.log(` Buddyfight 権威サーバー 起動: ${url}`);
      console.log(` (LAN公開時は http://${shownHost}:${tryPort}/play.html)`);
      console.log(" この窓を閉じるとサーバーが止まります。");
      console.log("============================================");
      if (openBrowser) {
        openInBrowser(url);
      }
    });
  };
  tryListen();
}

function openInBrowser(url) {
  try {
    const { spawn } = require("child_process");
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* ブラウザ自動オープンは best-effort。失敗してもサーバーは動く。 */
  }
}

if (require.main === module) {
  installProcessGuards();
  // 直接起動時のみ永続層を初期化し rooms を復元（モジュール import 経路＝スモークでは復元しない）。
  (async () => {
    try {
      await roomStore.init({
        backend: resolveRoomStoreBackend(),
        dataDir,
        tursoUrl: process.env.TURSO_DATABASE_URL,
        tursoToken: process.env.TURSO_AUTH_TOKEN,
      });
      // F3: 期限切れを先に掃除してから復元する（古い部屋まで一旦メモリへ載せない）。復元数は restoreRooms が上限で抑える。
      const maxAgeMs = ROOM_TTL_HOURS * 60 * 60 * 1000;
      const pruned = await roomStore.pruneExpired(maxAgeMs);
      if (pruned) console.log(`[room-store] 期限切れの部屋スナップショットを ${pruned} 件削除しました`);
      await restoreRooms();
      setInterval(() => {
        roomStore
          .pruneExpired(maxAgeMs)
          .then((n) => {
            if (n) console.log(`[room-store] 期限切れの部屋スナップショットを ${n} 件削除しました`);
          })
          .catch((error) => console.warn(`[room-store] pruneExpired失敗: ${error.message}`));
      }, ROOM_PRUNE_INTERVAL_MS).unref();
    } catch (error) {
      console.warn(`[restore] 永続層の初期化/復元に失敗（新規起動として続行）: ${error.message}`);
    }
    try {
      await ensureReplayStoreInitialized();
      const replayMaxAgeMs = REPLAY_TTL_DAYS * 24 * 60 * 60 * 1000;
      const prunedReplays = await replayStore.pruneExpired(replayMaxAgeMs);
      if (prunedReplays) console.log(`[replay-store] 期限切れのリプレイを ${prunedReplays} 件削除しました`);
      setInterval(() => {
        replayStore
          .pruneExpired(replayMaxAgeMs)
          .then((n) => {
            if (n) console.log(`[replay-store] 期限切れのリプレイを ${n} 件削除しました`);
          })
          .catch((error) => console.warn(`[replay-store] pruneExpired失敗: ${error.message}`));
      }, ROOM_PRUNE_INTERVAL_MS).unref();
    } catch (error) {
      console.warn(`[replay-store] 初期化に失敗（リプレイ保存は無効のまま続行）: ${error.message}`);
    }
    try {
      await ensureUserStoreInitialized();
      setInterval(() => {
        userStore.gcSessions(Date.now()).catch((error) => console.warn(`[user-store] gcSessions失敗: ${error.message}`));
      }, 24 * 60 * 60 * 1000).unref();
    } catch (error) {
      console.warn(`[user-store] 初期化に失敗（ユーザー機能は無効のまま続行）: ${error.message}`);
    }
    startServer(server, host, port, { openBrowser: process.argv.includes("--open") });
  })();
}

module.exports = {
  server,
  rooms,
  createRoom,
  addMember,
  assignRole,
  canActorActNow,
  startGame,
  startServer,
  snapshotRoom,
  restoreRooms,
  persistNow,
  persistDelete,
  flushPersist,
  closeAndForgetRoom, // 部屋復活レースの回帰検証用（スモーク）
  maybeRecordMatch, // D5(戦績): 決着記録の直接検証用（スモーク）
  // 以下は堅牢化(F1〜F13)の回帰検証用（スモーク）
  LIMITS,
  sweepRooms,
  clientIp,
  staticAccess,
  normalizeRoomDeck,
  ensureAdminUser,
  rateLimitHits,
  pruneRateLimitHits,
};

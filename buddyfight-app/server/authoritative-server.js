// 権威ネット対戦サーバー（P1）。
// サーバが唯一のエンジン(engine-host)を保持し、クライアントは「アクション送信＋
// サーバ配信viewの描画」のみ（シンクライアント）。手札・山札は役割別に伏せ字化して配信。
// 現 netplay-server.js（中継方式）とは別エンドポイント /auth/* で提供する。
//
// 注意(P1後続): 選択ダイアログ/じゃんけん等のプロンプトは現状サーバ側で自動解決
// （engine-host の window.prompt/confirm）。本来はアクティブ/応答プレイヤーへ往復させる。
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { GameRoom } = require("./engine-host");
const roomStore = require("./room-store");
const replayStore = require("./replay-store");
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
};

function randomId(size = 4) {
  return crypto.randomBytes(size).toString("hex").toUpperCase();
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid json"));
      }
    });
  });
}

// ---- ユーザー登録＋マイデッキ（新規） ----
// この節のヘルパ・ルートは /auth/register|login|logout|me|mydecks*|admin/* のみが対象。
// 既存の部屋API(/auth/rooms/*)は同一オリジンのまま無改変（CORSヘッダも付けない）。

function sendJsonCors(res, statusCode, payload) {
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

// register/login のレート制限（同一IPで10回/10分。プロセス内カウンタで十分な個人運用規模）。
const rateLimitHits = new Map(); // ip -> timestamps[]
function checkRateLimit(ip) {
  const now = Date.now();
  const arr = (rateLimitHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) {
    rateLimitHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  rateLimitHits.set(ip, arr);
  return true;
}
function clientIp(req) {
  return req.socket?.remoteAddress || "unknown";
}

// デッキ保存の検証用データ（全カードID・全フラッグID）。getDeckList と同様の遅延キャッシュ方式だが、
// engine-host(GameRoom) 経由ではなく data/ 配下を直接読む（GameRoom.loadData はデッキ一覧のみを返し
// カード/フラッグの全量を公開していないため）。
let deckValidationCache = null;
async function getDeckValidationSets() {
  if (deckValidationCache) return deckValidationCache;
  const cardIds = new Set();
  const flagIds = new Set();
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
  deckValidationCache = { cardIds, flagIds };
  return deckValidationCache;
}

// env ADMIN_USER_NAME/ADMIN_USER_PASSWORD があれば起動時に管理者を確保（存在すればパス更新+is_admin=1）。
async function ensureAdminUser() {
  const name = process.env.ADMIN_USER_NAME;
  const password = process.env.ADMIN_USER_PASSWORD;
  if (!name || !password) return;
  const passHash = hashPassword(password);
  const existing = await userStore.getUserByName(name);
  if (existing) {
    await userStore.setPassword(existing.id, passHash);
    await userStore.setAdmin(existing.id, true);
  } else {
    await userStore.createUser({ name, passHash, isAdmin: true });
  }
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
  };
  rooms.set(roomId, room);
  return room;
}

// ---- 永続化(P4・再起動耐性) ----
// room を plain スナップショットへ（sse/game/vm/関数は除外。token は含むため dataDir は web root 外）。
function snapshotRoom(room) {
  return {
    version: 1,
    id: room.id,
    seats: room.seats,
    started: room.started,
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
  const snapshot = JSON.parse(JSON.stringify(snapshotRoom(room)));
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
    persistNow(room);
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
async function restoreRooms() {
  for (const snap of await roomStore.loadAll()) {
    try {
      const room = {
        id: snap.id,
        members: new Map((snap.members || []).map((m) => [m.clientId, { ...m, sse: null }])),
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
      }
      rooms.set(room.id, room);
    } catch (error) {
      console.warn(`[restore] room ${snap?.id} の復元に失敗（スキップ）: ${error.message}`);
    }
  }
}

function addMember(room, { name, userId = null }) {
  const clientId = randomId(6);
  const token = randomId(16);
  // userId: 参加時に Bearer が有効だった場合のログイン済みユーザーID（未ログインは null）。
  // 決着時に席へ紐づくログインユーザーへ戦績を記録するために控える（D5）。
  const member = { clientId, token, name: name || "プレイヤー", role: null, deck: null, sse: null, userId };
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

// 行動可能席か（クライアントの selectFieldCard 許可条件と同等）。
function canActorActNow(state, seat) {
  if (!Number.isInteger(seat)) return false;
  if (state.winner) return false;
  if (state.pendingAttack) {
    return [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(seat);
  }
  if (state.pendingAction) {
    return seat === state.pendingAction.responder;
  }
  return seat === state.active;
}

// ---- 配信 ----

function lobbyPayload(room, you) {
  return {
    type: "lobby",
    roomId: room.id,
    started: room.started,
    you: you ? { clientId: you.clientId, role: you.role } : null,
    seats: room.seats,
    members: [...room.members.values()].map((m) => ({
      clientId: m.clientId,
      name: m.name,
      role: m.role,
      deck: m.deck ? { id: m.deck.id, name: m.deck.name || null } : null,
      online: Boolean(m.sse),
    })),
  };
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
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      room.pendingPrompts.delete(requestId);
      resolve(null);
    }, 60 * 1000);
    room.pendingPrompts.set(requestId, { resolve, timer, clientId: target.clientId, payload });
    writeSse(target.sse, payload);
  });
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
      sendJsonCors(res, 503, {
        error: "ユーザーDBに接続できません",
        detail: String(error && error.message ? error.message : error),
        backend: process.env.USER_STORE_BACKEND || "file",
      });
      return true;
    }
  }

  // 接続診断: デプロイ先URL/ローカルでブラウザから開くだけで、バックエンド種別と実DB往復の成否・
  // 失敗理由が確認できる（登録できない時の一次切り分け用）。認証不要・データは返さない。
  if (req.method === "GET" && url.pathname === "/auth/dbhealth") {
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
    const recent = await replayStore.listRecent(200);
    const mine = recent
      .filter((entry) => entry.recording && entry.recording.userId === user.id)
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
    let payload;
    try {
      payload = deckCode.decodeDeckShareCode(body.code);
    } catch (error) {
      sendJsonCors(res, 400, { error: `共有コードが不正です: ${error.message}` });
      return true;
    }
    const { cardIds, flagIds } = await getDeckValidationSets();
    const result = deckCode.validateDeckCodePayload(payload, { cardIds, flagIds });
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
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : result.normalized.name;
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
    if (typeof body.name === "string" && body.name.trim()) {
      patch.name = body.name.trim();
    }
    if (typeof body.position === "number" && Number.isFinite(body.position)) {
      patch.position = body.position;
    }
    if (typeof body.code === "string" && body.code) {
      let payload;
      try {
        payload = deckCode.decodeDeckShareCode(body.code);
      } catch (error) {
        sendJsonCors(res, 400, { error: `共有コードが不正です: ${error.message}` });
        return true;
      }
      const { cardIds, flagIds } = await getDeckValidationSets();
      const result = deckCode.validateDeckCodePayload(payload, { cardIds, flagIds });
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
    const body = await readJson(req);
    const room = createRoom();
    const userId = await resolveOptionalUserId(req); // D5: ログイン中なら席に userId を紐づける
    const member = addMember(room, { name: body.name, userId });
    if (body.deck) {
      member.deck = body.deck;
    }
    schedulePersist(room);
    sendJson(res, 201, { roomId: room.id, clientId: member.clientId, token: member.token, role: member.role });
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
  if (req.method === "POST" && parts[3] === "join") {
    const body = await readJson(req);
    const userId = await resolveOptionalUserId(req); // D5
    const member = addMember(room, { name: body.name, userId });
    if (body.deck) {
      member.deck = body.deck;
    }
    broadcastLobby(room);
    schedulePersist(room);
    sendJson(res, 200, { roomId: room.id, clientId: member.clientId, token: member.token, role: member.role });
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
      const result = swapSeats(room);
      if (result.error) {
        sendJson(res, 409, result);
        return true;
      }
    } else if (body.action === "setDeck") {
      member.deck = body.deck || null;
    } else if (body.action === "start") {
      if (room.started) {
        sendJson(res, 409, { error: "already started" });
        return true;
      }
      if (!room.seats[0] || !room.seats[1]) {
        sendJson(res, 409, { error: "両席が埋まっていません" });
        return true;
      }
      try {
        await startGame(room);
      } catch (error) {
        sendJson(res, 500, { error: `開始に失敗: ${error.message}` });
        return true;
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
    if (!canActorActNow(state, member.role)) {
      sendJson(res, 409, { error: "今あなたの操作番ではありません" });
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
    broadcastView(room, body.label || body.type);
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

function serveStatic(req, res, url) {
  // 権威サーバのクライアントは play.html（手札秘匿のシンクライアント）。
  // ルート直打ち時は play.html を返す（netplay.html は中継版=netplay-server.js 用で /auth/* に繋がらない）。
  const requestPath = url.pathname === "/" ? "/play.html" : decodeURIComponent(url.pathname);
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (await handleApi(req, res, url)) {
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    // ユーザーAPI経路の例外（Turso往復失敗など）は CORS 付き 503 で本当の理由を返す
    // （別オリジン配信のbuilder/index から fetch した時、CORS無し500だとブラウザが本文を読めず
    //  原因不明の「接続できません」になるため）。それ以外は従来どおり 500。
    if (isUserApiPath(url.pathname)) {
      sendJsonCors(res, 503, { error: "ユーザーDB処理に失敗しました", detail: error.message });
    } else {
      sendJson(res, 500, { error: error.message });
    }
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const anyOnline = [...room.members.values()].some((m) => m.sse);
    if (!anyOnline && now - room.updatedAt > roomTtlMs) {
      closeAndForgetRoom(room, roomId); // 孤児スナップショットも掃除（飛行中の save は closed ガードで弾く）
    }
  }
}, 10 * 60 * 1000).unref();

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
  // 直接起動時のみ永続層を初期化し rooms を復元（モジュール import 経路＝スモークでは復元しない）。
  (async () => {
    try {
      await roomStore.init({
        backend: resolveRoomStoreBackend(),
        dataDir,
        tursoUrl: process.env.TURSO_DATABASE_URL,
        tursoToken: process.env.TURSO_AUTH_TOKEN,
      });
      await restoreRooms();
      const maxAgeMs = ROOM_TTL_HOURS * 60 * 60 * 1000;
      const pruned = await roomStore.pruneExpired(maxAgeMs);
      if (pruned) console.log(`[room-store] 期限切れの部屋スナップショットを ${pruned} 件削除しました`);
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
};

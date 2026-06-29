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

const rootDir = path.resolve(__dirname, "..");
// 永続データ(P4)の保存先。token を含むため web root の外に置く（静的配信で漏らさない）。
const dataDir = process.env.AUTH_DATA_DIR || path.resolve(rootDir, "..", "buddyfight-auth-data");
const persistTimers = new Map(); // roomId -> debounce timer
const portArgIndex = process.argv.findIndex((arg) => arg === "--port" || arg === "-p");
const hostArgIndex = process.argv.findIndex((arg) => arg === "--host" || arg === "-h");
const port =
  Number(process.env.PORT) || (portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 4174);
const host = process.env.HOST || (hostArgIndex >= 0 ? process.argv[hostArgIndex + 1] : "127.0.0.1");

const rooms = new Map();
const roomTtlMs = 6 * 60 * 60 * 1000;

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
    })),
    state: room.started && room.game ? room.game.api.getState() : null,
  };
}

function persistNow(room) {
  // busy(applyAction 途中)はライブ state の途中変異を拾うため保存しない＝整合する確定局面のみ保存。
  if (room.busy) {
    schedulePersist(room);
    return;
  }
  try {
    roomStore.save(room.id, snapshotRoom(room));
  } catch (error) {
    console.warn(`[persist] room ${room.id} の保存に失敗: ${error.message}`);
  }
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

// 起動時に永続ファイルから rooms を再構築・局面復元（members は sse=null で再接続待機）。
async function restoreRooms() {
  for (const snap of roomStore.loadAll()) {
    try {
      const room = {
        id: snap.id,
        members: new Map((snap.members || []).map((m) => [m.clientId, { ...m, sse: null }])),
        seats: snap.seats || [null, null],
        game: null,
        started: Boolean(snap.started),
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
        const game = new GameRoom({ customDecks, onPrompt: (req) => dispatchPrompt(room, req) });
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

function addMember(room, { name }) {
  const clientId = randomId(6);
  const token = randomId(16);
  const member = { clientId, token, name: name || "プレイヤー", role: null, deck: null, sse: null };
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

  // GET /auth/decks  （ロビーのデッキ選択用。プリセット一覧）
  if (req.method === "GET" && url.pathname === "/auth/decks") {
    sendJson(res, 200, { decks: await getDeckList() });
    return true;
  }

  // POST /auth/rooms  （部屋作成＋作成者を席0で参加）
  if (req.method === "POST" && url.pathname === "/auth/rooms") {
    const body = await readJson(req);
    const room = createRoom();
    const member = addMember(room, { name: body.name });
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
    const member = addMember(room, { name: body.name });
    if (body.deck) {
      member.deck = body.deck;
    }
    broadcastLobby(room);
    schedulePersist(room);
    sendJson(res, 200, { roomId: room.id, clientId: member.clientId, token: member.token, role: member.role });
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
  const game = new GameRoom({ customDecks, onPrompt: (req) => dispatchPrompt(room, req) });
  await game.loadData();
  const deckIds = [seat0.deck?.id, seat1.deck?.id];
  game.startGame(deckIds);
  room.game = game;
  room.started = true;
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
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    });
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
    sendJson(res, 500, { error: error.message });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const anyOnline = [...room.members.values()].some((m) => m.sse);
    if (!anyOnline && now - room.updatedAt > roomTtlMs) {
      rooms.delete(roomId);
      roomStore.delete(roomId); // 孤児スナップショットも掃除
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
      roomStore.init({ dataDir });
      await restoreRooms();
    } catch (error) {
      console.warn(`[restore] 永続層の初期化/復元に失敗（新規起動として続行）: ${error.message}`);
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
};

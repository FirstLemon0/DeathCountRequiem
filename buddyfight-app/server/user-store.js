// ユーザー登録＋マイデッキ保管のドメインAPIアダプタ。room-store.js と対をなす流儀
// （init/差し替えバックエンド・tmp→rename・.bad退避）で、file / turso の2バックエンドを
// 同一I/Fの背後に隠す。呼び元(authoritative-server.js)は backend を意識しない。
//
// file バックエンド: dataDir/users.json（users+sessions）と dataDir/userdecks/<userId>.json。
// turso バックエンド: fetch のみで libSQL HTTP API v2 (POST {url}/v2/pipeline) を叩く（依存追加なし）。
//
// パスワードのハッシュ化・トークン生成/検証は呼び元(authoritative-server.js)の責務。
// ここは「渡された passHash / tokenHash をそのまま保存・照合する」ストレージ層に徹する。
const fs = require("fs");
const path = require("path");

let backend = "file";

// ---- file backend state ----
let fileDir = null;
let usersState = null; // { nextId, users:[{id,name,passHash,isAdmin,createdAt}], sessions:[{tokenHash,userId,expiresAt}] }
const deckStateCache = new Map(); // userId -> { nextId, decks:[...] }
const matchStateCache = new Map(); // userId -> { matches:[...] }（戦績 D5）

// 戦績レコードの保持上限（ユーザーあたり）。古いものから捨てる。
const MATCH_LIMIT_PER_USER = 1000;

// 戦績レコードの許可フィールドのみを通す（seed / token 等が万一渡っても保存されないための防御）。
// 【セキュリティ】戦績は一覧APIで他人にも見え得るため、seed（進行中対戦の先読みに使える）と
// member.token は絶対に保存しない。source は "server"(権威判定) / "client"(自己申告) のみ。
function sanitizeMatchRecord(record) {
  const rec = record || {};
  return {
    fightId: rec.fightId != null ? String(rec.fightId) : null,
    finishedAt: Number.isFinite(Number(rec.finishedAt)) ? Number(rec.finishedAt) : Date.now(),
    outcome: rec.outcome === "win" ? "win" : "loss",
    reason: typeof rec.reason === "string" ? rec.reason : "unknown",
    firstSeat: rec.firstSeat === 0 || rec.firstSeat === 1 ? rec.firstSeat : null,
    turnCount: Number.isFinite(Number(rec.turnCount)) ? Number(rec.turnCount) : 0,
    deckId: rec.deckId != null ? String(rec.deckId) : null,
    opponentDeckId: rec.opponentDeckId != null ? String(rec.opponentDeckId) : null,
    replayId: rec.replayId != null ? String(rec.replayId) : null,
    source: rec.source === "server" ? "server" : "client",
  };
}

// 戦績（デッキ別）の集計。file / turso 共通ロジック。
function aggregateDeckStats(matches) {
  const map = new Map();
  for (const m of matches || []) {
    const key = m.deckId == null ? "__unknown__" : String(m.deckId);
    if (!map.has(key)) {
      map.set(key, { deckId: m.deckId ?? null, wins: 0, losses: 0 });
    }
    const row = map.get(key);
    if (m.outcome === "win") row.wins += 1;
    else row.losses += 1;
  }
  const rows = [...map.values()].map((row) => {
    const total = row.wins + row.losses;
    return { ...row, total, winRate: total > 0 ? row.wins / total : 0 };
  });
  rows.sort((a, b) => b.total - a.total || b.winRate - a.winRate);
  return rows;
}

// ---- turso backend state ----
let tursoUrl = null;
let tursoToken = null;

// ===================== 共通ユーティリティ =====================

function usersFilePath() {
  return path.join(fileDir, "users.json");
}
function userDecksFilePath(userId) {
  return path.join(fileDir, "userdecks", `${userId}.json`);
}
function userMatchesFilePath(userId) {
  return path.join(fileDir, "matches", `${userId}.json`);
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // アトミック差し替え（書込み途中の半端ファイルを読ませない）
}

function loadJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.warn(`[user-store] 破損ファイルをスキップ: ${file}: ${error.message}`);
    try {
      fs.renameSync(file, `${file}.bad`);
    } catch {
      /* noop */
    }
    return fallback;
  }
}

function loadUsersState() {
  if (usersState) return usersState;
  usersState = loadJsonSafe(usersFilePath(), { nextId: 1, users: [], sessions: [] });
  usersState.users = usersState.users || [];
  usersState.sessions = usersState.sessions || [];
  usersState.nextId = usersState.nextId || 1;
  return usersState;
}
function saveUsersState() {
  atomicWriteJson(usersFilePath(), usersState);
}

function loadDeckState(userId) {
  const key = Number(userId);
  let state = deckStateCache.get(key);
  if (state) return state;
  state = loadJsonSafe(userDecksFilePath(key), { nextId: 1, decks: [] });
  state.decks = state.decks || [];
  state.nextId = state.nextId || 1;
  deckStateCache.set(key, state);
  return state;
}
function saveDeckState(userId) {
  atomicWriteJson(userDecksFilePath(Number(userId)), deckStateCache.get(Number(userId)));
}

function deckOf(userId, deckId) {
  const state = loadDeckState(userId);
  return state.decks.find((d) => String(d.id) === String(deckId)) || null;
}

function loadMatchState(userId) {
  const key = Number(userId);
  let state = matchStateCache.get(key);
  if (state) return state;
  state = loadJsonSafe(userMatchesFilePath(key), { matches: [] });
  state.matches = state.matches || [];
  matchStateCache.set(key, state);
  return state;
}
function saveMatchState(userId) {
  atomicWriteJson(userMatchesFilePath(Number(userId)), matchStateCache.get(Number(userId)));
}

// ===================== file backend =====================

const fileImpl = {
  async ping() {
    // ファイルバックエンド: データディレクトリが読み書きできるかを確認（実書き込みはしない）。
    fs.accessSync(fileDir, fs.constants.R_OK | fs.constants.W_OK);
    return { backend: "file", dataDir: fileDir, userCount: loadUsersState().users.length };
  },
  async getUserByName(name) {
    const state = loadUsersState();
    const lower = String(name || "").toLowerCase();
    return state.users.find((u) => String(u.name).toLowerCase() === lower) || null;
  },
  async getUserById(id) {
    const state = loadUsersState();
    return state.users.find((u) => u.id === Number(id)) || null;
  },
  async createUser({ name, passHash, isAdmin }) {
    const state = loadUsersState();
    const existing = await fileImpl.getUserByName(name);
    if (existing) return null;
    const user = { id: state.nextId++, name, passHash, isAdmin: Boolean(isAdmin), createdAt: Date.now() };
    state.users.push(user);
    saveUsersState();
    return { ...user };
  },
  async setPassword(userId, passHash) {
    const state = loadUsersState();
    const user = state.users.find((u) => u.id === Number(userId));
    if (!user) return false;
    user.passHash = passHash;
    saveUsersState();
    return true;
  },
  async setAdmin(userId, isAdmin) {
    const state = loadUsersState();
    const user = state.users.find((u) => u.id === Number(userId));
    if (!user) return false;
    user.isAdmin = Boolean(isAdmin);
    saveUsersState();
    return true;
  },
  async deleteUser(userId) {
    const state = loadUsersState();
    const idx = state.users.findIndex((u) => u.id === Number(userId));
    if (idx === -1) return false;
    state.users.splice(idx, 1);
    state.sessions = state.sessions.filter((s) => s.userId !== Number(userId));
    saveUsersState();
    deckStateCache.delete(Number(userId));
    matchStateCache.delete(Number(userId));
    try {
      fs.unlinkSync(userDecksFilePath(userId));
    } catch {
      /* 無ければ無視 */
    }
    try {
      fs.unlinkSync(userMatchesFilePath(userId));
    } catch {
      /* 無ければ無視 */
    }
    return true;
  },
  async listUsers() {
    const state = loadUsersState();
    const out = [];
    for (const u of state.users) {
      out.push({ name: u.name, isAdmin: Boolean(u.isAdmin), createdAt: u.createdAt, deckCount: loadDeckState(u.id).decks.length });
    }
    return out;
  },

  async getSession(tokenHash) {
    const state = loadUsersState();
    const s = state.sessions.find((x) => x.tokenHash === tokenHash);
    return s ? { userId: s.userId, expiresAt: s.expiresAt } : null;
  },
  async putSession({ tokenHash, userId, expiresAt }) {
    const state = loadUsersState();
    const idx = state.sessions.findIndex((s) => s.tokenHash === tokenHash);
    const rec = { tokenHash, userId: Number(userId), expiresAt };
    if (idx === -1) state.sessions.push(rec);
    else state.sessions[idx] = rec;
    saveUsersState();
  },
  async deleteSession(tokenHash) {
    const state = loadUsersState();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.tokenHash !== tokenHash);
    if (state.sessions.length !== before) saveUsersState();
  },
  async deleteSessionsByUser(userId) {
    const state = loadUsersState();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.userId !== Number(userId));
    if (state.sessions.length !== before) saveUsersState();
  },
  async gcSessions(now = Date.now()) {
    const state = loadUsersState();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.expiresAt > now);
    if (state.sessions.length !== before) saveUsersState();
  },

  async listDecks(userId) {
    const state = loadDeckState(userId);
    return [...state.decks].sort((a, b) => a.position - b.position || a.id - b.id);
  },
  async getDeck(userId, deckId) {
    return deckOf(userId, deckId);
  },
  async putDeck(userId, deck) {
    const state = loadDeckState(userId);
    const now = Date.now();
    if (deck.id) {
      const idx = state.decks.findIndex((d) => String(d.id) === String(deck.id));
      if (idx === -1) return null;
      const updated = { ...state.decks[idx], ...deck, id: state.decks[idx].id, updatedAt: now };
      state.decks[idx] = updated;
      saveDeckState(userId);
      return { ...updated };
    }
    const id = state.nextId++;
    const created = {
      id,
      name: deck.name,
      code: deck.code,
      flag: deck.flag ?? null,
      buddy: deck.buddy ?? null,
      cardCount: deck.cardCount ?? 0,
      position: deck.position ?? state.decks.length,
      createdAt: now,
      updatedAt: now,
    };
    state.decks.push(created);
    saveDeckState(userId);
    return { ...created };
  },
  async deleteDeck(userId, deckId) {
    const state = loadDeckState(userId);
    const idx = state.decks.findIndex((d) => String(d.id) === String(deckId));
    if (idx === -1) return false;
    state.decks.splice(idx, 1);
    saveDeckState(userId);
    return true;
  },
  async countDecks(userId) {
    return loadDeckState(userId).decks.length;
  },

  // ---- 戦績 (D5) ----
  // 同一 fightId は upsert する。ただし権威記録(source:"server")はクライアント申告(source:"client")で
  // 上書きさせない（自己申告で勝率を盛れないように＝勝敗はサーバが state から判定する）。
  async putMatch(userId, record) {
    const rec = sanitizeMatchRecord(record);
    const state = loadMatchState(userId);
    if (rec.fightId) {
      const idx = state.matches.findIndex((m) => m.fightId === rec.fightId);
      if (idx >= 0) {
        const existing = state.matches[idx];
        if (existing.source === "server" && rec.source !== "server") {
          return { ...existing }; // 権威記録はクライアント申告で上書き不可
        }
        state.matches[idx] = { ...existing, ...rec };
        saveMatchState(userId);
        return { ...state.matches[idx] };
      }
    }
    state.matches.push(rec);
    if (state.matches.length > MATCH_LIMIT_PER_USER) {
      state.matches.splice(0, state.matches.length - MATCH_LIMIT_PER_USER); // 古いものから捨てる
    }
    saveMatchState(userId);
    return { ...rec };
  },
  async listMatches(userId, limit = 100) {
    const state = loadMatchState(userId);
    const sorted = [...state.matches].sort((a, b) => b.finishedAt - a.finishedAt);
    return sorted.slice(0, Math.max(0, Number(limit) || 0));
  },
  async matchStats(userId) {
    return aggregateDeckStats(loadMatchState(userId).matches);
  },
  async countMatches(userId) {
    return loadMatchState(userId).matches.length;
  },
  // リプレイ保存後に replayId を後付けする（決着時は replayId 未確定のため）。
  async setMatchReplayId(userId, fightId, replayId) {
    if (!fightId) return false;
    const state = loadMatchState(userId);
    const m = state.matches.find((x) => x.fightId === String(fightId));
    if (!m) return false;
    m.replayId = replayId != null ? String(replayId) : null;
    saveMatchState(userId);
    return true;
  },
};

// ===================== turso backend（libSQL HTTP API v2。fetchのみ・依存追加なし） =====================

function normalizeTursoUrl(u) {
  // Turso の URL は libsql:// で配布される。HTTP pipeline は https:// で叩く。
  // ws(s):// 表記や scheme 無しのホスト名、末尾スラッシュも許容して https:// に正規化する。
  let s = String(u || "").trim();
  s = s.replace(/^libsql:\/\//i, "https://").replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  if (!/^https?:\/\//i.test(s)) {
    s = "https://" + s; // scheme 無し（ホスト名だけ貼られた）場合の保険
  }
  return s.replace(/\/+$/, "");
}

function tursoArg(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (typeof value === "number" && Number.isInteger(value)) return { type: "integer", value: String(value) };
  if (typeof value === "number") return { type: "float", value };
  return { type: "text", value: String(value) };
}

function tursoCellValue(cell) {
  if (!cell || cell.type === "null") return null;
  if (cell.type === "integer" || cell.type === "float") return Number(cell.value);
  return cell.value;
}

function tursoRows(result) {
  const cols = (result?.cols || []).map((c) => c.name);
  return (result?.rows || []).map((row) => {
    const obj = {};
    row.forEach((cell, i) => {
      obj[cols[i]] = tursoCellValue(cell);
    });
    return obj;
  });
}

// statements: [{sql, args}] を1パイプラインで送る。ネットワーク/5xx失敗はリトライ1回→失敗は例外。
async function tursoPipeline(statements) {
  const url = `${normalizeTursoUrl(tursoUrl)}/v2/pipeline`;
  const body = {
    requests: [
      ...statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args || []).map(tursoArg) } })),
      { type: "close" },
    ],
  };
  const headers = { Authorization: `Bearer ${tursoToken}`, "Content-Type": "application/json" };
  const attempt = async () => {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const error = new Error(`turso http ${res.status}: ${text.slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  };
  let json;
  try {
    json = await attempt();
  } catch (error) {
    const retryable = !error.status || error.status >= 500;
    if (!retryable) throw error;
    json = await attempt();
  }
  const results = json.results || [];
  for (const r of results) {
    if (r.type === "error") {
      throw new Error(`turso error: ${r.error?.message || JSON.stringify(r.error)}`);
    }
  }
  return results;
}

async function tursoExec(sql, args = []) {
  const [result] = await tursoPipeline([{ sql, args }]);
  return result?.response?.result || { rows: [], cols: [] };
}

async function initTursoSchema() {
  await tursoPipeline([
    {
      sql: `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS decks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        flag TEXT,
        buddy TEXT,
        card_count INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    },
    { sql: `CREATE INDEX IF NOT EXISTS idx_decks_user ON decks(user_id, position)` },
    {
      sql: `CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        fight_id TEXT,
        finished_at INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        first_seat INTEGER,
        turn_count INTEGER,
        deck_id TEXT,
        opponent_deck_id TEXT,
        replay_id TEXT,
        source TEXT NOT NULL DEFAULT 'client'
      )`,
    },
    // 同一ユーザー×同一 fightId は1件（upsert の衝突キー）。
    { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_user_fight ON matches(user_id, fight_id)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_matches_user ON matches(user_id, finished_at)` },
  ]);
}

function rowToUser(row) {
  return { id: row.id, name: row.name, passHash: row.pass_hash, isAdmin: Boolean(row.is_admin), createdAt: row.created_at };
}
function rowToDeck(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    flag: row.flag ?? null,
    buddy: row.buddy ?? null,
    cardCount: row.card_count ?? 0,
    position: row.position ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function rowToMatch(row) {
  return {
    fightId: row.fight_id ?? null,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    reason: row.reason ?? "unknown",
    firstSeat: row.first_seat === 0 || row.first_seat === 1 ? row.first_seat : null,
    turnCount: row.turn_count ?? 0,
    deckId: row.deck_id ?? null,
    opponentDeckId: row.opponent_deck_id ?? null,
    replayId: row.replay_id ?? null,
    source: row.source === "server" ? "server" : "client",
  };
}

const tursoImpl = {
  async ping() {
    // Turso: 実DBへ往復（SELECT 1）して接続・認証・スキーマ健全性を確認する。
    const r = await tursoExec("SELECT 1 AS ok", []);
    const rows = tursoRows(r);
    const usersRows = tursoRows(await tursoExec("SELECT COUNT(*) AS c FROM users", []));
    return {
      backend: "turso",
      host: normalizeTursoUrl(tursoUrl),
      roundtrip: rows.length ? Number(rows[0].ok) : null,
      userCount: usersRows.length ? Number(usersRows[0].c) : null,
    };
  },
  async getUserByName(name) {
    const result = await tursoExec("SELECT id, name, pass_hash, is_admin, created_at FROM users WHERE name = ?", [String(name || "")]);
    const rows = tursoRows(result);
    return rows.length ? rowToUser(rows[0]) : null;
  },
  async getUserById(id) {
    const result = await tursoExec("SELECT id, name, pass_hash, is_admin, created_at FROM users WHERE id = ?", [Number(id)]);
    const rows = tursoRows(result);
    return rows.length ? rowToUser(rows[0]) : null;
  },
  async createUser({ name, passHash, isAdmin }) {
    const existing = await tursoImpl.getUserByName(name);
    if (existing) return null;
    const now = Date.now();
    const result = await tursoExec("INSERT INTO users (name, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?)", [
      name,
      passHash,
      isAdmin ? 1 : 0,
      now,
    ]);
    const id = Number(result.last_insert_rowid);
    return { id, name, passHash, isAdmin: Boolean(isAdmin), createdAt: now };
  },
  async setPassword(userId, passHash) {
    await tursoExec("UPDATE users SET pass_hash = ? WHERE id = ?", [passHash, Number(userId)]);
    return true;
  },
  async setAdmin(userId, isAdmin) {
    await tursoExec("UPDATE users SET is_admin = ? WHERE id = ?", [isAdmin ? 1 : 0, Number(userId)]);
    return true;
  },
  async deleteUser(userId) {
    const id = Number(userId);
    await tursoPipeline([
      { sql: "DELETE FROM matches WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM decks WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM users WHERE id = ?", args: [id] },
    ]);
    return true;
  },
  async listUsers() {
    const result = await tursoExec("SELECT id, name, pass_hash, is_admin, created_at FROM users");
    const users = tursoRows(result).map(rowToUser);
    const out = [];
    for (const u of users) {
      const countResult = await tursoExec("SELECT COUNT(*) as c FROM decks WHERE user_id = ?", [u.id]);
      const rows = tursoRows(countResult);
      out.push({ name: u.name, isAdmin: u.isAdmin, createdAt: u.createdAt, deckCount: rows.length ? Number(rows[0].c) : 0 });
    }
    return out;
  },

  async getSession(tokenHash) {
    const result = await tursoExec("SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?", [tokenHash]);
    const rows = tursoRows(result);
    return rows.length ? { userId: rows[0].user_id, expiresAt: rows[0].expires_at } : null;
  },
  async putSession({ tokenHash, userId, expiresAt }) {
    await tursoExec(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at`,
      [tokenHash, Number(userId), expiresAt],
    );
  },
  async deleteSession(tokenHash) {
    await tursoExec("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
  },
  async deleteSessionsByUser(userId) {
    await tursoExec("DELETE FROM sessions WHERE user_id = ?", [Number(userId)]);
  },
  async gcSessions(now = Date.now()) {
    await tursoExec("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  },

  async listDecks(userId) {
    const result = await tursoExec("SELECT * FROM decks WHERE user_id = ? ORDER BY position ASC, id ASC", [Number(userId)]);
    return tursoRows(result).map(rowToDeck);
  },
  async getDeck(userId, deckId) {
    const result = await tursoExec("SELECT * FROM decks WHERE user_id = ? AND id = ?", [Number(userId), Number(deckId)]);
    const rows = tursoRows(result);
    return rows.length ? rowToDeck(rows[0]) : null;
  },
  async putDeck(userId, deck) {
    const now = Date.now();
    if (deck.id) {
      const existing = await tursoImpl.getDeck(userId, deck.id);
      if (!existing) return null;
      const merged = { ...existing, ...deck };
      await tursoExec(
        `UPDATE decks SET name = ?, code = ?, flag = ?, buddy = ?, card_count = ?, position = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
        [merged.name, merged.code, merged.flag ?? null, merged.buddy ?? null, merged.cardCount ?? 0, merged.position ?? 0, now, Number(userId), Number(deck.id)],
      );
      return { ...merged, updatedAt: now };
    }
    const position = deck.position ?? (await tursoImpl.countDecks(userId));
    const result = await tursoExec(
      `INSERT INTO decks (user_id, name, code, flag, buddy, card_count, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(userId), deck.name, deck.code, deck.flag ?? null, deck.buddy ?? null, deck.cardCount ?? 0, position, now, now],
    );
    const id = Number(result.last_insert_rowid);
    return {
      id,
      name: deck.name,
      code: deck.code,
      flag: deck.flag ?? null,
      buddy: deck.buddy ?? null,
      cardCount: deck.cardCount ?? 0,
      position,
      createdAt: now,
      updatedAt: now,
    };
  },
  async deleteDeck(userId, deckId) {
    const result = await tursoExec("DELETE FROM decks WHERE user_id = ? AND id = ?", [Number(userId), Number(deckId)]);
    return true && result !== undefined;
  },
  async countDecks(userId) {
    const result = await tursoExec("SELECT COUNT(*) as c FROM decks WHERE user_id = ?", [Number(userId)]);
    const rows = tursoRows(result);
    return rows.length ? Number(rows[0].c) : 0;
  },

  // ---- 戦績 (D5) ----
  async putMatch(userId, record) {
    const rec = sanitizeMatchRecord(record);
    const uid = Number(userId);
    if (rec.fightId) {
      const existingRows = tursoRows(
        await tursoExec("SELECT * FROM matches WHERE user_id = ? AND fight_id = ?", [uid, rec.fightId]),
      );
      if (existingRows.length) {
        const existing = rowToMatch(existingRows[0]);
        if (existing.source === "server" && rec.source !== "server") {
          return existing; // 権威記録はクライアント申告で上書き不可
        }
      }
      // fight_id 有り: UNIQUE(user_id, fight_id) で upsert。
      await tursoExec(
        `INSERT INTO matches (user_id, fight_id, finished_at, outcome, reason, first_seat, turn_count, deck_id, opponent_deck_id, replay_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, fight_id) DO UPDATE SET
           finished_at = excluded.finished_at, outcome = excluded.outcome, reason = excluded.reason,
           first_seat = excluded.first_seat, turn_count = excluded.turn_count, deck_id = excluded.deck_id,
           opponent_deck_id = excluded.opponent_deck_id, replay_id = excluded.replay_id, source = excluded.source`,
        [uid, rec.fightId, rec.finishedAt, rec.outcome, rec.reason, rec.firstSeat, rec.turnCount, rec.deckId, rec.opponentDeckId, rec.replayId, rec.source],
      );
    } else {
      await tursoExec(
        `INSERT INTO matches (user_id, fight_id, finished_at, outcome, reason, first_seat, turn_count, deck_id, opponent_deck_id, replay_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uid, null, rec.finishedAt, rec.outcome, rec.reason, rec.firstSeat, rec.turnCount, rec.deckId, rec.opponentDeckId, rec.replayId, rec.source],
      );
    }
    // 1ユーザーあたり MATCH_LIMIT_PER_USER 件で頭打ち（file backend と挙動を揃える。turso 側は
    // これが無いと戦績行が無制限に増え、件数・集計の母数が backend 間でズレる）。古いものから捨てる。
    await tursoExec(
      `DELETE FROM matches WHERE user_id = ? AND rowid NOT IN (
         SELECT rowid FROM matches WHERE user_id = ? ORDER BY finished_at DESC, rowid DESC LIMIT ?
       )`,
      [uid, uid, MATCH_LIMIT_PER_USER],
    );
    return { ...rec };
  },
  async listMatches(userId, limit = 100) {
    const result = await tursoExec(
      "SELECT * FROM matches WHERE user_id = ? ORDER BY finished_at DESC LIMIT ?",
      [Number(userId), Math.max(0, Number(limit) || 0)],
    );
    return tursoRows(result).map(rowToMatch);
  },
  async matchStats(userId) {
    const result = await tursoExec("SELECT * FROM matches WHERE user_id = ?", [Number(userId)]);
    return aggregateDeckStats(tursoRows(result).map(rowToMatch));
  },
  async countMatches(userId) {
    const result = await tursoExec("SELECT COUNT(*) as c FROM matches WHERE user_id = ?", [Number(userId)]);
    const rows = tursoRows(result);
    return rows.length ? Number(rows[0].c) : 0;
  },
  async setMatchReplayId(userId, fightId, replayId) {
    if (!fightId) return false;
    await tursoExec("UPDATE matches SET replay_id = ? WHERE user_id = ? AND fight_id = ?", [
      replayId != null ? String(replayId) : null,
      Number(userId),
      String(fightId),
    ]);
    return true;
  },
};

// ===================== 公開I/F（backend で振り分け） =====================

function impl() {
  return backend === "turso" ? tursoImpl : fileImpl;
}

let initialized = false;

module.exports = {
  async init({ backend: b = "file", dataDir, tursoUrl: url, tursoToken: token } = {}) {
    backend = b === "turso" ? "turso" : "file";
    initialized = false;
    if (backend === "file") {
      fileDir = dataDir;
      fs.mkdirSync(fileDir, { recursive: true });
      usersState = null;
      deckStateCache.clear();
    } else {
      tursoUrl = url;
      tursoToken = token;
      if (!tursoUrl || !tursoToken) {
        throw new Error("turso backend には tursoUrl / tursoToken が必要です");
      }
      await initTursoSchema();
    }
    initialized = true;
  },
  // init 済みか（authoritative-server の遅延初期化が、スモーク等の手動 init を上書きしないための照会用）
  isInitialized() {
    return initialized;
  },
  backend() {
    return backend;
  },

  ping: (...args) => impl().ping(...args),
  getUserByName: (...args) => impl().getUserByName(...args),
  getUserById: (...args) => impl().getUserById(...args),
  createUser: (...args) => impl().createUser(...args),
  setPassword: (...args) => impl().setPassword(...args),
  setAdmin: (...args) => impl().setAdmin(...args),
  deleteUser: (...args) => impl().deleteUser(...args),
  listUsers: (...args) => impl().listUsers(...args),

  getSession: (...args) => impl().getSession(...args),
  putSession: (...args) => impl().putSession(...args),
  deleteSession: (...args) => impl().deleteSession(...args),
  deleteSessionsByUser: (...args) => impl().deleteSessionsByUser(...args),
  gcSessions: (...args) => impl().gcSessions(...args),

  listDecks: (...args) => impl().listDecks(...args),
  getDeck: (...args) => impl().getDeck(...args),
  putDeck: (...args) => impl().putDeck(...args),
  deleteDeck: (...args) => impl().deleteDeck(...args),
  countDecks: (...args) => impl().countDecks(...args),

  // 戦績 (D5)
  putMatch: (...args) => impl().putMatch(...args),
  listMatches: (...args) => impl().listMatches(...args),
  matchStats: (...args) => impl().matchStats(...args),
  countMatches: (...args) => impl().countMatches(...args),
  setMatchReplayId: (...args) => impl().setMatchReplayId(...args),
};

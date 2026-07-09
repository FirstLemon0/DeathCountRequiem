// 差し替え可能な部屋スナップショット永続バックエンド（P4・再起動耐性）。
// authoritative-server から room の plain snapshot を受け取り、room毎に保存/列挙/削除する。
// file(既定) / turso の2バックエンドを同一I/Fの背後に隠す。呼び元は backend を意識しない。
// 実装様式は user-store.js の turso バックエンド（libSQL HTTP pipeline を fetch のみで叩く・
// 依存追加なし・normalizeTursoUrl・5xxリトライ1回）に厳密に倣う。user-store.js の既存挙動には
// 一切触れないため、turso HTTP ヘルパはあえて共通化せずこちらに複製している（変更の影響範囲を
// user-store.js に及ぼさないための意図的な選択）。
//
// file バックエンド: dataDir/rooms/<roomId>.json（1ファイル1部屋。書式は据え置き）。
// turso バックエンド: rooms(id, snapshot, updated_at) テーブルに1行1部屋。
//
// 公開I/F（init/save/delete/loadAll）は旧シグネチャを維持。ping/pruneExpired は今回の新規追加。
// 注意: snapshot は member.token を含むため、保存先(dataDir/DB)は web root の外・アプリ外に置くこと。
const fs = require("fs");
const path = require("path");

let backend = "file";
let initialized = false;

// ---- file backend state ----
let fileDir = null;

// ---- turso backend state ----
let tursoUrl = null;
let tursoToken = null;

function fileOf(roomId) {
  return path.join(fileDir, `${roomId}.json`);
}

// ===================== file backend =====================

const fileImpl = {
  async ping() {
    fs.accessSync(fileDir, fs.constants.R_OK | fs.constants.W_OK);
    let roomCount = 0;
    try {
      roomCount = fs.readdirSync(fileDir).filter((n) => n.endsWith(".json")).length;
    } catch {
      /* dataDir が読めない場合は 0 のまま（access チェックで既に例外化されているはず） */
    }
    return { backend: "file", dataDir: fileDir, roomCount };
  },
  async save(roomId, snapshot) {
    if (!fileDir) return;
    const file = fileOf(roomId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, file); // アトミック差し替え（書込み途中の半端ファイルを読ませない）
  },
  async delete(roomId) {
    if (!fileDir) return;
    try {
      fs.unlinkSync(fileOf(roomId));
    } catch {
      /* 無ければ無視 */
    }
  },
  async loadAll() {
    if (!fileDir) return [];
    let names = [];
    try {
      names = fs.readdirSync(fileDir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const file = path.join(fileDir, name);
      try {
        out.push(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        console.warn(`[room-store] 破損スナップショットをスキップ: ${name}`);
        try {
          fs.renameSync(file, `${file}.bad`);
        } catch {
          /* noop */
        }
      }
    }
    return out;
  },
  async pruneExpired(maxAgeMs) {
    if (!fileDir) return 0;
    let names = [];
    try {
      names = fs.readdirSync(fileDir).filter((n) => n.endsWith(".json"));
    } catch {
      return 0;
    }
    const now = Date.now();
    let removed = 0;
    for (const name of names) {
      const file = path.join(fileDir, name);
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(file);
          removed += 1;
        }
      } catch {
        /* 統計/削除の途中で消えていれば無視 */
      }
    }
    return removed;
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
      sql: `CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    },
  ]);
}

const tursoImpl = {
  async ping() {
    // Turso: 実DBへ往復（SELECT 1）して接続・認証・スキーマ健全性を確認する。
    const r = await tursoExec("SELECT 1 AS ok", []);
    const rows = tursoRows(r);
    const countRows = tursoRows(await tursoExec("SELECT COUNT(*) AS c FROM rooms", []));
    return {
      backend: "turso",
      host: normalizeTursoUrl(tursoUrl),
      roundtrip: rows.length ? Number(rows[0].ok) : null,
      roomCount: countRows.length ? Number(countRows[0].c) : null,
    };
  },
  async save(roomId, snapshot) {
    const now = Date.now();
    await tursoExec(
      `INSERT INTO rooms (id, snapshot, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
      [String(roomId), JSON.stringify(snapshot), now],
    );
  },
  async delete(roomId) {
    await tursoExec("DELETE FROM rooms WHERE id = ?", [String(roomId)]);
  },
  async loadAll() {
    const result = await tursoExec("SELECT id, snapshot FROM rooms", []);
    const rows = tursoRows(result);
    const out = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.snapshot));
      } catch (error) {
        console.warn(`[room-store] 破損スナップショットをスキップ(turso id=${row.id}): ${error.message}`);
      }
    }
    return out;
  },
  async pruneExpired(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const countRows = tursoRows(await tursoExec("SELECT COUNT(*) AS c FROM rooms WHERE updated_at < ?", [cutoff]));
    const count = countRows.length ? Number(countRows[0].c) : 0;
    if (count > 0) {
      await tursoExec("DELETE FROM rooms WHERE updated_at < ?", [cutoff]);
    }
    return count;
  },
};

// ===================== 公開I/F（backend で振り分け） =====================

function impl() {
  return backend === "turso" ? tursoImpl : fileImpl;
}

module.exports = {
  async init({ backend: b = "file", dataDir, tursoUrl: url, tursoToken: token } = {}) {
    backend = b === "turso" ? "turso" : "file";
    initialized = false;
    if (backend === "file") {
      // 部屋は dataDir 直下ではなく rooms/ サブディレクトリに隔離する。pruneExpired は *.json を
      // 削除して回るため、資格情報(turso.conf)やユーザーDB(user/)と同じ階層に向けたくない。
      // 直下に *.json を置く別機能が将来増えても、部屋の掃除に巻き込まれない。
      fileDir = path.join(dataDir, "rooms");
      fs.mkdirSync(fileDir, { recursive: true });
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
  isInitialized() {
    return initialized;
  },
  backend() {
    return backend;
  },
  dir() {
    return fileDir;
  },

  ping: (...args) => impl().ping(...args),
  save: (...args) => impl().save(...args),
  delete: (...args) => impl().delete(...args),
  loadAll: (...args) => impl().loadAll(...args),
  pruneExpired: (...args) => impl().pruneExpired(...args),
};

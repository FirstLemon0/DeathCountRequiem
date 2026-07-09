// 差し替え可能なリプレイ永続バックエンド（B3・保存/共有URL）。
// authoritative-server から「決着済み対戦のリプレイblob」を受け取り、id毎に保存/取得/列挙/削除する。
// file(既定) / turso の2バックエンドを同一I/Fの背後に隠す。呼び元は backend を意識しない。
// 構造は room-store.js と同型（1行1JSON blob。user-store.js は正規化スキーマで過剰なため採らない）。
// 実装様式は room-store.js / user-store.js の turso バックエンド（libSQL HTTP pipeline を fetch のみで叩く・
// 依存追加なし・normalizeTursoUrl・5xxリトライ1回）に厳密に倣う。稼働中の user-store/room-store の挙動へ
// 一切影響を与えないため、turso HTTP ヘルパはあえて共通化せずこちらに複製している（意図的な選択）。
//
// file バックエンド: dataDir/replays/<id>.json（1ファイル1リプレイ）。直下ではなく replays/ に隔離する。
//   pruneExpired が *.json を削除して回るため、資格情報(turso.conf)やユーザーDB(user/)・部屋(rooms/)と
//   同じ階層に削除ループを向けない（room-store と同じ理由）。
// turso バックエンド: replays(id, recording, created_at) テーブルに1行1リプレイ。
//
// 保存する blob（recording引数）は authoritative-server 側で GameRoom.getRecording() の戻り値だけを
// 包んだもの（member.token を含まない）。この層は blob の中身を解釈しない（純粋な KV ストア）。
const fs = require("fs");
const path = require("path");

let backend = "file";
let initialized = false;

// ---- file backend state ----
let fileDir = null;

// ---- turso backend state ----
let tursoUrl = null;
let tursoToken = null;

function fileOf(id) {
  return path.join(fileDir, `${id}.json`);
}

// ===================== file backend =====================

const fileImpl = {
  async ping() {
    fs.accessSync(fileDir, fs.constants.R_OK | fs.constants.W_OK);
    let count = 0;
    try {
      count = fs.readdirSync(fileDir).filter((n) => n.endsWith(".json")).length;
    } catch {
      /* dataDir が読めない場合は 0 のまま（access チェックで既に例外化されているはず） */
    }
    return { backend: "file", dataDir: fileDir, count };
  },
  async save(id, recording) {
    if (!fileDir) return;
    const file = fileOf(id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(recording));
    fs.renameSync(tmp, file); // アトミック差し替え（書込み途中の半端ファイルを読ませない）
  },
  async load(id) {
    if (!fileDir) return null;
    try {
      return JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
    } catch {
      return null; // 無い/壊れている場合は null（未存在と同じ扱い）
    }
  },
  async delete(id) {
    if (!fileDir) return;
    try {
      fs.unlinkSync(fileOf(id));
    } catch {
      /* 無ければ無視 */
    }
  },
  async listRecent(limit = 50) {
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
        // created_at は mtime を採る（file backend は blob に時刻を持たせず room-store と同型に保つ）。
        const createdAt = fs.statSync(file).mtimeMs;
        const recording = JSON.parse(fs.readFileSync(file, "utf8"));
        out.push({ id: name.replace(/\.json$/, ""), createdAt, recording });
      } catch {
        /* 壊れたファイルは列挙から除外 */
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out.slice(0, Math.max(0, limit));
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
      sql: `CREATE TABLE IF NOT EXISTS replays (
        id TEXT PRIMARY KEY,
        recording TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    },
  ]);
}

const tursoImpl = {
  async ping() {
    // Turso: 実DBへ往復（SELECT 1）して接続・認証・スキーマ健全性を確認する。
    const r = await tursoExec("SELECT 1 AS ok", []);
    const rows = tursoRows(r);
    const countRows = tursoRows(await tursoExec("SELECT COUNT(*) AS c FROM replays", []));
    return {
      backend: "turso",
      host: normalizeTursoUrl(tursoUrl),
      roundtrip: rows.length ? Number(rows[0].ok) : null,
      count: countRows.length ? Number(countRows[0].c) : null,
    };
  },
  async save(id, recording) {
    const now = Date.now();
    await tursoExec(
      `INSERT INTO replays (id, recording, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET recording = excluded.recording, created_at = excluded.created_at`,
      [String(id), JSON.stringify(recording), now],
    );
  },
  async load(id) {
    const result = await tursoExec("SELECT recording FROM replays WHERE id = ?", [String(id)]);
    const rows = tursoRows(result);
    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].recording);
    } catch {
      return null;
    }
  },
  async delete(id) {
    await tursoExec("DELETE FROM replays WHERE id = ?", [String(id)]);
  },
  async listRecent(limit = 50) {
    const result = await tursoExec(
      "SELECT id, recording, created_at FROM replays ORDER BY created_at DESC LIMIT ?",
      [Math.max(0, limit)],
    );
    const rows = tursoRows(result);
    const out = [];
    for (const row of rows) {
      try {
        out.push({ id: row.id, createdAt: Number(row.created_at), recording: JSON.parse(row.recording) });
      } catch {
        /* 壊れた行は列挙から除外 */
      }
    }
    return out;
  },
  async pruneExpired(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const countRows = tursoRows(await tursoExec("SELECT COUNT(*) AS c FROM replays WHERE created_at < ?", [cutoff]));
    const count = countRows.length ? Number(countRows[0].c) : 0;
    if (count > 0) {
      await tursoExec("DELETE FROM replays WHERE created_at < ?", [cutoff]);
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
      // リプレイは dataDir 直下ではなく replays/ サブディレクトリに隔離する。pruneExpired は *.json を
      // 削除して回るため、資格情報(turso.conf)・ユーザーDB(user/)・部屋(rooms/)と同じ階層に向けたくない。
      fileDir = path.join(dataDir, "replays");
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
  load: (...args) => impl().load(...args),
  delete: (...args) => impl().delete(...args),
  listRecent: (...args) => impl().listRecent(...args),
  pruneExpired: (...args) => impl().pruneExpired(...args),
};

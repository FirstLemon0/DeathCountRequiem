// user-store の turso バックエンドを、libSQL HTTP API v2 (/v2/pipeline) を忠実に喋る
// ローカルモックサーバ（node:sqlite 実体）で実測するスモーク。
// 実 Turso への接続が塞がれた環境（社内フィルタ等）でも、アダプタのプロトコル実装
// （リクエスト形・args型付け・cols/rows デコード・last_insert_rowid）を検証できる。
// node:sqlite が無い Node (<22) では skip して正常終了する。
"use strict";

const http = require("node:http");
const assert = require("node:assert");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  console.log("node:sqlite が無いため skip（Node 22+ で実行してください）");
  console.log("=== user-store turso-mock smoke OK (skipped) ===");
  process.exit(0);
}

const userStore = require("./user-store.js");

const MOCK_TOKEN = "mock-turso-token";

function jsToCell(value) {
  if (value === null || value === undefined) return { type: "null", value: null };
  if (typeof value === "bigint") return { type: "integer", value: String(value) };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer", value: String(value) } : { type: "float", value };
  }
  return { type: "text", value: String(value) };
}

function cellToJs(cell) {
  if (!cell || cell.type === "null") return null;
  if (cell.type === "integer") return Number(cell.value);
  if (cell.type === "float") return Number(cell.value);
  return String(cell.value);
}

async function main() {
  const db = new DatabaseSync(":memory:");
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v2/pipeline", `URLは/v2/pipeline (実際 ${req.url})`);
        assert.equal(req.headers.authorization, `Bearer ${MOCK_TOKEN}`, "Bearerヘッダ");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(Array.isArray(body.requests), "requests配列");
        requestCount += 1;
        const results = [];
        for (const request of body.requests) {
          if (request.type === "close") {
            results.push({ type: "ok", response: { type: "close" } });
            continue;
          }
          assert.equal(request.type, "execute");
          const { sql, args = [] } = request.stmt;
          try {
            const prepared = db.prepare(sql);
            const jsArgs = args.map(cellToJs);
            let rows = [];
            let cols = [];
            let info = { changes: 0, lastInsertRowid: 0 };
            if (/^\s*select/i.test(sql)) {
              const objRows = prepared.all(...jsArgs);
              cols = objRows.length > 0 ? Object.keys(objRows[0]).map((n) => ({ name: n })) : [];
              rows = objRows.map((r) => Object.values(r).map(jsToCell));
            } else {
              info = prepared.run(...jsArgs);
            }
            results.push({
              type: "ok",
              response: {
                type: "execute",
                result: {
                  cols,
                  rows,
                  affected_row_count: Number(info.changes || 0),
                  last_insert_rowid: String(info.lastInsertRowid || 0),
                },
              },
            });
          } catch (error) {
            results.push({ type: "error", error: { message: String(error.message) } });
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ baton: null, results }));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  await userStore.init({
    backend: "turso",
    tursoUrl: `http://127.0.0.1:${port}`,
    tursoToken: MOCK_TOKEN,
  });

  // --- ユーザーCRUD（COLLATE NOCASE 含む） ---
  const user = await userStore.createUser({ name: "Taro", passHash: "s1$abc$def", isAdmin: false });
  assert.ok(user && user.id > 0, "createUser がidを返す");
  const fetched = await userStore.getUserByName("tARO");
  assert.equal(fetched.name, "Taro", "NOCASEで取得できる");
  assert.equal(fetched.passHash, "s1$abc$def");
  const dup = await userStore.createUser({ name: "TARO", passHash: "x", isAdmin: false });
  assert.equal(dup, null, "重複はnull");
  await userStore.setAdmin(user.id, true);
  assert.equal((await userStore.getUserByName("taro")).isAdmin, true, "setAdmin");
  await userStore.setPassword(user.id, "s1$new$hash");
  assert.equal((await userStore.getUserByName("taro")).passHash, "s1$new$hash", "setPassword");

  // --- セッション ---
  const now = Date.now();
  await userStore.putSession({ tokenHash: "h1", userId: user.id, expiresAt: now + 1000 });
  assert.equal((await userStore.getSession("h1")).userId, user.id, "putSession/getSession");
  await userStore.putSession({ tokenHash: "h2", userId: user.id, expiresAt: now - 1000 });
  await userStore.gcSessions(now);
  assert.equal(await userStore.getSession("h2"), null, "期限切れはgcで消える");
  assert.ok(await userStore.getSession("h1"), "有効セッションは残る");

  // --- デッキCRUD ---
  const deck = await userStore.putDeck(user.id, {
    name: "テストデッキ", code: "BFD1.dGVzdA", flag: "dragon-world", buddy: "bt01-0001", cardCount: 50, position: 0,
  });
  assert.ok(deck.id > 0, "putDeck 新規");
  const deck2 = await userStore.putDeck(user.id, {
    name: "二個目", code: "BFD1.dGVzdDI", flag: "katana-world", buddy: null, cardCount: 52, position: 1,
  });
  let list = await userStore.listDecks(user.id);
  assert.equal(list.length, 2, "listDecks 2件");
  assert.equal(list[0].name, "テストデッキ", "position順");
  assert.equal(list[1].cardCount, 52, "cardCountがNumberで往復");
  await userStore.putDeck(user.id, { id: deck.id, name: "改名", code: deck.code ?? "BFD1.dGVzdA", position: 2 });
  const got = await userStore.getDeck(user.id, deck.id);
  assert.equal(got.name, "改名", "更新");
  assert.equal(await userStore.countDecks(user.id), 2, "countDecks");
  await userStore.deleteDeck(user.id, deck2.id);
  list = await userStore.listDecks(user.id);
  assert.equal(list.length, 1, "delete後1件");

  // --- listUsers / deleteUser ---
  const users = await userStore.listUsers();
  assert.ok(users.some((u) => u.name === "Taro"), "listUsers");
  await userStore.deleteUser(user.id);
  assert.equal(await userStore.getUserByName("taro"), null, "deleteUser");
  assert.equal(await userStore.getSession("h1"), null, "deleteUserでセッションも消える");

  assert.ok(requestCount >= 5, `パイプライン往復が実際に発生 (${requestCount}回)`);
  server.close();
  console.log(`（パイプライン往復 ${requestCount} 回・libSQLプロトコル準拠を実測）`);
  console.log("=== user-store turso-mock smoke OK ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

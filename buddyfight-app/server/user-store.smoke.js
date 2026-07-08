// server/user-store.js の headless スモーク。
// 1) file バックエンドのドメインAPIを直接叩く（init→createUser→session put/get/期限切れgc→
//    デッキCRUD(put/list/get/更新/position/delete/上限)→admin相当のupsert）。
// 2) authoritative-server.js の HTTP層（/auth/register|login|logout|me|mydecks*|admin/*）を
//    実際に http.request で叩く（レート制限・CORS preflightも含む）。
// 3) env TURSO_DATABASE_URL/TURSO_AUTH_TOKEN が両方あれば turso バックエンドでも同じCRUDを1周。
// 実行: node server/user-store.smoke.js
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");

const userStore = require("./user-store");
const deckCode = require("../deck-code");

// td01-strong-dragon の実データから拾った有効な flag/buddy/card id（フィクスチャに依存しないよう
// data/decks/td01-strong-dragon.json の中身をそのまま使う。カードsetは data/cardsets.json 経由で
// authoritative-server.js の getDeckValidationSets が読むのと同じファイルなので実在保証される）。
const SAMPLE_DECK = {
  name: "スモーク用テストデッキ",
  flag: "dragon-world",
  buddy: "gigant-sword-dragon",
  recipe: [
    ["gigant-sword-dragon", 2],
    ["jamadhar-dragon", 4],
    ["rising-flare-dragon", 4],
    ["extreme-sword-dragon", 3],
    ["thousand-rapier-dragon", 4],
  ],
};
const SAMPLE_CODE = deckCode.encodeDeckShareCode(SAMPLE_DECK);

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-user-store-"));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

async function testFileBackendDomainApi() {
  await withTmpDir(async (dir) => {
    await userStore.init({ backend: "file", dataDir: dir });
    assert.equal(userStore.backend(), "file");

    // --- users ---
    assert.equal(await userStore.getUserByName("alice"), null, "未登録は null");
    const alice = await userStore.createUser({ name: "Alice", passHash: "s1$aa$bb", isAdmin: false });
    assert.ok(alice.id, "createUser は id を発番");
    const dup = await userStore.createUser({ name: "alice", passHash: "s1$cc$dd", isAdmin: false });
    assert.equal(dup, null, "大文字小文字を無視して重複は null");
    const byName = await userStore.getUserByName("ALICE");
    assert.equal(byName.id, alice.id, "name比較は小文字化");
    await userStore.setPassword(alice.id, "s1$ee$ff");
    assert.equal((await userStore.getUserById(alice.id)).passHash, "s1$ee$ff", "setPassword");
    await userStore.setAdmin(alice.id, true);
    assert.equal((await userStore.getUserById(alice.id)).isAdmin, true, "setAdmin");
    console.log("[ok] file: users CRUD（重複はnull・大文字小文字無視）");

    // --- sessions ---
    const tokenHash = "deadbeef";
    assert.equal(await userStore.getSession(tokenHash), null);
    await userStore.putSession({ tokenHash, userId: alice.id, expiresAt: Date.now() + 10000 });
    const session = await userStore.getSession(tokenHash);
    assert.equal(session.userId, alice.id, "putSession/getSession 往復");
    await userStore.putSession({ tokenHash, userId: alice.id, expiresAt: Date.now() - 1 }); // 期限切れに書き換え
    await userStore.gcSessions(Date.now());
    assert.equal(await userStore.getSession(tokenHash), null, "gcSessions で期限切れを削除");
    const tokenHash2 = "cafebabe";
    await userStore.putSession({ tokenHash: tokenHash2, userId: alice.id, expiresAt: Date.now() + 10000 });
    await userStore.deleteSession(tokenHash2);
    assert.equal(await userStore.getSession(tokenHash2), null, "deleteSession");
    await userStore.putSession({ tokenHash: tokenHash2, userId: alice.id, expiresAt: Date.now() + 10000 });
    await userStore.deleteSessionsByUser(alice.id);
    assert.equal(await userStore.getSession(tokenHash2), null, "deleteSessionsByUser");
    console.log("[ok] file: sessions put/get/delete/期限切れgc");

    // --- decks ---
    assert.equal(await userStore.countDecks(alice.id), 0);
    const created = await userStore.putDeck(alice.id, {
      name: "デッキ1",
      code: SAMPLE_CODE,
      flag: SAMPLE_DECK.flag,
      buddy: SAMPLE_DECK.buddy,
      cardCount: 15,
      position: 0,
    });
    assert.ok(created.id, "putDeck(新規) は id を発番");
    assert.equal(await userStore.countDecks(alice.id), 1);
    const created2 = await userStore.putDeck(alice.id, { name: "デッキ2", code: SAMPLE_CODE, flag: SAMPLE_DECK.flag, buddy: null, cardCount: 15, position: 1 });
    let list = await userStore.listDecks(alice.id);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((d) => d.id), [created.id, created2.id], "listDecks は position 順");
    const fetched = await userStore.getDeck(alice.id, created.id);
    assert.equal(fetched.code, SAMPLE_CODE, "getDeck は code を含む");
    const updated = await userStore.putDeck(alice.id, { ...fetched, name: "デッキ1改", position: 5 });
    assert.equal(updated.name, "デッキ1改");
    list = await userStore.listDecks(alice.id);
    assert.equal(list[list.length - 1].id, created.id, "position更新で並び順が変わる");
    const delOk = await userStore.deleteDeck(alice.id, created2.id);
    assert.equal(delOk, true);
    assert.equal(await userStore.countDecks(alice.id), 1);
    assert.equal(await userStore.getDeck(alice.id, created2.id), null, "削除後は取得できない");
    console.log("[ok] file: decks put(新規/更新)/list(position順)/get(code含む)/delete/countDecks");

    // --- 上限に近い挙動の確認（putDeckが素直に増える）＋ deleteUser でデッキファイルごと消える ---
    for (let i = 0; i < 5; i += 1) {
      await userStore.putDeck(alice.id, { name: `追加${i}`, code: SAMPLE_CODE, flag: SAMPLE_DECK.flag, buddy: null, cardCount: 15, position: 10 + i });
    }
    assert.equal(await userStore.countDecks(alice.id), 6, "追加5件+既存1件");
    const decksFile = path.join(dir, "userdecks", `${alice.id}.json`);
    assert.ok(fs.existsSync(decksFile), "デッキファイルが存在する");
    await userStore.deleteUser(alice.id);
    assert.equal(await userStore.getUserById(alice.id), null, "deleteUser でユーザー削除");
    assert.ok(!fs.existsSync(decksFile), "deleteUser でユーザーのデッキファイルも削除");
    console.log("[ok] file: deleteUser でユーザー+デッキ+セッションを一括削除");

    // --- 管理者相当のupsert（authoritative-server.ensureAdminUser と同等の手順を直接確認） ---
    const admin1 = await userStore.createUser({ name: "admin", passHash: "s1$x$y", isAdmin: true });
    assert.equal(admin1.isAdmin, true);
    const existingAdmin = await userStore.getUserByName("admin");
    await userStore.setPassword(existingAdmin.id, "s1$new$hash");
    await userStore.setAdmin(existingAdmin.id, true);
    const reloaded = await userStore.getUserById(existingAdmin.id);
    assert.equal(reloaded.passHash, "s1$new$hash");
    assert.equal(reloaded.isAdmin, true);
    console.log("[ok] file: 管理者確保（存在すればパス更新+is_admin=1）相当の手順が成立");
  });
}

// ---- deck-code.js のバリデーション単体確認（実データの cardIds/flagIds を使う） ----
async function testDeckCodeValidation() {
  const rootDir = path.resolve(__dirname, "..");
  const cardIds = new Set();
  const flagIds = new Set();
  const cardsets = JSON.parse(fs.readFileSync(path.join(rootDir, "data", "cardsets.json"), "utf8"));
  for (const set of cardsets.sets) {
    const data = JSON.parse(fs.readFileSync(path.join(rootDir, set.file), "utf8"));
    for (const card of data.cards || []) {
      if (card.type !== "flag" && card.id) cardIds.add(card.id);
    }
  }
  const flagsData = JSON.parse(fs.readFileSync(path.join(rootDir, "data", "flags.json"), "utf8"));
  for (const flag of flagsData.flags || []) {
    flagIds.add(flag.id);
    for (const alias of flag.aliases || []) flagIds.add(alias);
  }
  assert.ok(cardIds.has(SAMPLE_DECK.buddy), "テストフィクスチャのbuddyが実在カード");

  const okPayload = deckCode.decodeDeckShareCode(SAMPLE_CODE);
  const okResult = deckCode.validateDeckCodePayload(okPayload, { cardIds, flagIds });
  assert.equal(okResult.ok, true, "実在カード/フラッグの正常デッキはok");
  assert.equal(okResult.normalized.recipe.length, 5);

  // 50枚未満のWIPデッキも保存可（下限は検証しない）
  const wipCode = deckCode.encodeDeckShareCode({ ...SAMPLE_DECK, recipe: [["gigant-sword-dragon", 2]] });
  const wipResult = deckCode.validateDeckCodePayload(deckCode.decodeDeckShareCode(wipCode), { cardIds, flagIds });
  assert.equal(wipResult.ok, true, "50枚未満のWIPデッキも保存可");

  // 不正: 未知のフラッグ
  const badFlagCode = deckCode.encodeDeckShareCode({ ...SAMPLE_DECK, flag: "no-such-flag" });
  assert.equal(deckCode.validateDeckCodePayload(deckCode.decodeDeckShareCode(badFlagCode), { cardIds, flagIds }).ok, false, "未知フラッグは拒否");

  // 不正: 未知のカード
  const badCardCode = deckCode.encodeDeckShareCode({ ...SAMPLE_DECK, recipe: [["no-such-card", 2]] });
  assert.equal(deckCode.validateDeckCodePayload(deckCode.decodeDeckShareCode(badCardCode), { cardIds, flagIds }).ok, false, "未知カードは拒否");

  // 不正: 1種5枚（上限4枚超）
  const overCountCode = deckCode.encodeDeckShareCode({ ...SAMPLE_DECK, recipe: [["gigant-sword-dragon", 5]] });
  assert.equal(deckCode.validateDeckCodePayload(deckCode.decodeDeckShareCode(overCountCode), { cardIds, flagIds }).ok, false, "1種5枚は拒否");

  // 不正: ver違い
  const badVer = { ver: 2, name: "x", flag: SAMPLE_DECK.flag, buddy: null, recipe: [] };
  assert.equal(deckCode.validateDeckCodePayload(badVer, { cardIds, flagIds }).ok, false, "ver!==1は拒否");

  // ラウンドトリップ: encode→decode→normalizedが元と一致
  const rt = deckCode.validateDeckCodePayload(deckCode.decodeDeckShareCode(SAMPLE_CODE), { cardIds, flagIds });
  assert.deepEqual(rt.normalized.recipe, SAMPLE_DECK.recipe, "encode→decode→validateのラウンドトリップでrecipeが一致");
  assert.equal(rt.normalized.flag, SAMPLE_DECK.flag);
  assert.equal(rt.normalized.buddy, SAMPLE_DECK.buddy);

  console.log("[ok] deck-code: validateDeckCodePayload（正常/WIP許容/未知flag・未知card・枚数超過・ver不一致を拒否/ラウンドトリップ）");
  return { cardIds, flagIds };
}

// ---- HTTP層（authoritative-server.js を実際に listen して叩く） ----
async function testHttpLayer() {
  await withTmpDir(async (dir) => {
    await userStore.init({ backend: "file", dataDir: dir });
    process.env.ADMIN_USER_NAME = "";
    process.env.ADMIN_USER_PASSWORD = "";

    // authoritative-server はモジュール読み込み時に require("./user-store") で同一シングルトンを
    // 掴む（Nodeのモジュールキャッシュ）ため、上の userStore.init が authoritative-server 内部からも
    // 見える。require.main !== module のため、この import では roomStore/userStore の自動初期化は
    // 走らない（起動時IIFEはスキップされる）。
    delete require.cache[require.resolve("./authoritative-server")];
    const { server } = require("./authoritative-server");

    const PORT = Number(process.env.SMOKE_USER_STORE_PORT || 4193);
    const BASE = `http://127.0.0.1:${PORT}`;

    function request(method, pathname, { body, token } = {}) {
      return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const headers = { "Content-Type": "application/json" };
        if (data) headers["Content-Length"] = data.length;
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const req = http.request(`${BASE}${pathname}`, { method, headers }, (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: buf ? JSON.parse(buf) : null }));
        });
        req.on("error", reject);
        if (data) req.end(data);
        else req.end();
      });
    }

    await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
    try {
      // CORS preflight
      const preflight = await new Promise((resolve, reject) => {
        const req = http.request(`${BASE}/auth/register`, { method: "OPTIONS" }, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res));
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(preflight.statusCode, 204, "OPTIONS preflight は204");
      assert.equal(preflight.headers["access-control-allow-origin"], "*", "CORS allow-origin");
      console.log("[ok] http: CORS preflight (OPTIONS /auth/register) → 204 + Allow-Origin:*");

      // register
      const reg = await request("POST", "/auth/register", { body: { name: "たろう", password: "1234" } });
      assert.equal(reg.status, 201, "register 201");
      assert.ok(reg.json.token, "register はtokenを返す");
      assert.equal(reg.json.name, "たろう");
      assert.equal(reg.headers["access-control-allow-origin"], "*");

      // register 重複
      const regDup = await request("POST", "/auth/register", { body: { name: "たろう", password: "5678" } });
      assert.equal(regDup.status, 409, "重複登録は409");

      // login 失敗
      const badLogin = await request("POST", "/auth/login", { body: { name: "たろう", password: "wrong" } });
      assert.equal(badLogin.status, 401, "誤パスワードは401");

      // login 成功
      const login = await request("POST", "/auth/login", { body: { name: "たろう", password: "1234" } });
      assert.equal(login.status, 200);
      const token = login.json.token;
      assert.ok(token, "login はtokenを返す");

      // /auth/me
      const me = await request("GET", "/auth/me", { token });
      assert.equal(me.status, 200);
      assert.equal(me.json.name, "たろう");
      assert.equal(me.json.deckCount, 0);
      console.log("[ok] http: register→login→/auth/me（トークン検証）");

      // /auth/mydecks POST（実カードidのBFD1コード）
      const postDeck = await request("POST", "/auth/mydecks", { token, body: { name: "テストデッキ", code: SAMPLE_CODE } });
      assert.equal(postDeck.status, 201, "mydecks POST 201");
      assert.ok(postDeck.json.deck.id, "作成デッキのid");
      assert.equal(postDeck.json.deck.code, SAMPLE_CODE, "保存されたcodeが一致");
      const deckId = postDeck.json.deck.id;

      // 不正コードは400
      const badDeckCode = deckCode.encodeDeckShareCode({ ...SAMPLE_DECK, flag: "no-such-flag" });
      const postBad = await request("POST", "/auth/mydecks", { token, body: { code: badDeckCode } });
      assert.equal(postBad.status, 400, "未知フラッグのdeckは400");

      // GET一覧
      const list = await request("GET", "/auth/mydecks", { token });
      assert.equal(list.status, 200);
      assert.equal(list.json.decks.length, 1);
      assert.equal(list.json.decks[0].code, SAMPLE_CODE, "一覧にcodeを含む");
      console.log("[ok] http: POST /auth/mydecks（実カードBFD1コード検証）→ 201、GET一覧にcode含む");

      // PUT（名前変更）
      const put = await request("PUT", `/auth/mydecks/${deckId}`, { token, body: { name: "改名デッキ" } });
      assert.equal(put.status, 200);
      assert.equal(put.json.deck.name, "改名デッキ");
      console.log("[ok] http: PUT /auth/mydecks/:id（部分更新）");

      // DELETE
      const del = await request("DELETE", `/auth/mydecks/${deckId}`, { token });
      assert.equal(del.status, 204, "delete 204");
      const listAfter = await request("GET", "/auth/mydecks", { token });
      assert.equal(listAfter.json.decks.length, 0, "削除後は0件");
      console.log("[ok] http: DELETE /auth/mydecks/:id");

      // 管理者を別途作成してadmin系を確認。ログイン経由ではなくセッションを直接発行して検証する
      // （passHashの中身はここでは検証しないため、実際のhashPassword形式に一致させる必要はない）。
      const adminUser = await userStore.createUser({ name: "kanri", passHash: "s1$dummy$dummy", isAdmin: true });
      const adminToken = crypto.randomBytes(32).toString("base64url");
      const adminTokenHash = crypto.createHash("sha256").update(adminToken).digest("hex");
      await userStore.putSession({ tokenHash: adminTokenHash, userId: adminUser.id, expiresAt: Date.now() + 60000 });

      const nonAdminTry = await request("GET", "/auth/admin/users", { token });
      assert.equal(nonAdminTry.status, 403, "非adminは403");

      const adminList = await request("GET", "/auth/admin/users", { token: adminToken });
      assert.equal(adminList.status, 200);
      assert.ok(adminList.json.users.some((u) => u.name === "たろう"), "admin一覧にユーザーが含まれる");
      console.log("[ok] http: GET /auth/admin/users（管理者のみ許可・403ガード）");

      const resetRes = await request("POST", "/auth/admin/reset-password", { token: adminToken, body: { name: "たろう", newPassword: "9999" } });
      assert.equal(resetRes.status, 204, "reset-password 204");
      // リセット後、旧トークンは失効（deleteSessionsByUser）
      const meAfterReset = await request("GET", "/auth/me", { token });
      assert.equal(meAfterReset.status, 401, "パスワードリセットで旧セッションは失効");
      const reLogin = await request("POST", "/auth/login", { body: { name: "たろう", password: "9999" } });
      assert.equal(reLogin.status, 200, "新パスワードでログインできる");
      console.log("[ok] http: POST /auth/admin/reset-password（旧セッション失効＋新パスワードでログイン可）");

      const selfDeleteTry = await request("DELETE", "/auth/admin/users/kanri", { token: adminToken });
      assert.equal(selfDeleteTry.status, 400, "管理者の自己削除は400");
      const deleteUserRes = await request("DELETE", "/auth/admin/users/たろう", { token: adminToken });
      assert.equal(deleteUserRes.status, 204, "admin による対象ユーザー削除は204");
      const goneUser = await userStore.getUserByName("たろう");
      assert.equal(goneUser, null, "削除されたユーザーはstoreから消える");
      console.log("[ok] http: DELETE /auth/admin/users/:name（自己削除拒否＋削除実行）");

      // logout
      const logoutRes = await request("POST", "/auth/logout", { token: adminToken });
      assert.equal(logoutRes.status, 204);
      const meAfterLogout = await request("GET", "/auth/me", { token: adminToken });
      assert.equal(meAfterLogout.status, 401, "logout後はセッション失効");
      console.log("[ok] http: POST /auth/logout（セッション失効）");

      // レート制限: register 同一IPで11回目は429（このプロセスでは既に2回叩いているので残り8回+1）
      let lastStatus = 0;
      for (let i = 0; i < 9; i += 1) {
        const r = await request("POST", "/auth/register", { body: { name: `rate${i}`, password: "1234" } });
        lastStatus = r.status;
      }
      assert.equal(lastStatus, 429, "同一IPで11回目のregisterは429");
      console.log("[ok] http: レート制限（同一IP register 11回目で429）");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

// ---- turso backend（envがあれば同じCRUDを1周） ----
async function testTursoBackendIfConfigured() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) {
    console.log("turso: skipped");
    return;
  }
  await userStore.init({ backend: "turso", tursoUrl: url, tursoToken: token });
  assert.equal(userStore.backend(), "turso");
  const uniqueName = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await userStore.createUser({ name: uniqueName, passHash: "s1$aa$bb", isAdmin: false });
  assert.ok(user.id, "turso: createUser");
  const dup = await userStore.createUser({ name: uniqueName.toUpperCase(), passHash: "s1$cc$dd", isAdmin: false });
  assert.equal(dup, null, "turso: 重複はnull（大文字小文字無視）");
  await userStore.setPassword(user.id, "s1$ee$ff");
  assert.equal((await userStore.getUserById(user.id)).passHash, "s1$ee$ff", "turso: setPassword");

  const tokenHash = crypto.randomBytes(16).toString("hex");
  await userStore.putSession({ tokenHash, userId: user.id, expiresAt: Date.now() + 10000 });
  assert.equal((await userStore.getSession(tokenHash)).userId, user.id, "turso: session put/get");
  await userStore.deleteSession(tokenHash);
  assert.equal(await userStore.getSession(tokenHash), null, "turso: session delete");

  const deck = await userStore.putDeck(user.id, { name: "turso-deck", code: SAMPLE_CODE, flag: SAMPLE_DECK.flag, buddy: SAMPLE_DECK.buddy, cardCount: 15, position: 0 });
  assert.ok(deck.id, "turso: putDeck(新規)");
  const list = await userStore.listDecks(user.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].code, SAMPLE_CODE, "turso: listDecksはcode含む");
  const updated = await userStore.putDeck(user.id, { ...deck, name: "turso-deck-renamed" });
  assert.equal(updated.name, "turso-deck-renamed", "turso: putDeck(更新)");
  const delOk = await userStore.deleteDeck(user.id, deck.id);
  assert.equal(delOk, true, "turso: deleteDeck");
  assert.equal(await userStore.countDecks(user.id), 0, "turso: countDecks");

  await userStore.deleteUser(user.id);
  assert.equal(await userStore.getUserByName(uniqueName), null, "turso: deleteUser");
  console.log("[ok] turso: users/sessions/decks CRUD 1周（作成→更新→削除）");
}

(async () => {
  try {
    await testFileBackendDomainApi();
    await testDeckCodeValidation();
    await testHttpLayer();
    await testTursoBackendIfConfigured();
    console.log("\n=== user-store smoke OK ===");
    process.exit(0);
  } catch (error) {
    console.error("SMOKE FAILED:", error);
    process.exit(1);
  }
})();

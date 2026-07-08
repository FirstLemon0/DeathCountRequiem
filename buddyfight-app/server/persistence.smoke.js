// 永続化(P4・再起動耐性)の headless スモーク（サーバ起動不要）。
// 1) 局面 state の JSON 往復(getState→serialize→setState→getState)で局面が一致＋復元側で applyAction が継続できる。
// 2) room-store.js の save/loadAll/delete 往復が deep-equal。
// 実行: node server/persistence.smoke.js
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { GameRoom } = require("./engine-host");
const roomStore = require("./room-store");

(async () => {
  // --- 1) 局面 state の JSON 往復で復元・継続 ---
  const a = new GameRoom();
  const profiles = await a.loadData();
  a.startGame([profiles[0].id, profiles[1].id]); // phase=charge, active=0
  const original = a.api.getState();
  const serialized = JSON.parse(JSON.stringify(original)); // 永続層に書くのと同じ形

  const b = new GameRoom();
  await b.loadData();
  b.api.setState(JSON.parse(JSON.stringify(serialized))); // 別インスタンスへ復元
  const restored = b.api.getState();
  // 永続層に書くのは serialized 形。setState→getState がそれを無損失で保つことを確認
  // （live state は undefined 値キーを持ち得るため厳密比較は serialized 同士で行う）。
  assert.deepEqual(restored, serialized, "JSON往復(serialize→setState→getState)で局面が無損失");

  // 復元側で applyAction(継続手)が例外なく進む（charge→main は選択不要）。
  await b.applyAction(0, "main", {});
  assert.equal(b.api.getState().phase, "main", "復元側で applyAction(main) が継続できる");
  console.log("[ok] 局面 state の JSON 往復で復元・手番継続");

  // --- 2) room-store の save/loadAll/delete 往復 ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-auth-"));
  try {
    roomStore.init({ dataDir: dir });
    const snapshot = {
      version: 1,
      id: "ABC",
      seats: ["c1", "c2"],
      started: true,
      createdAt: 1,
      updatedAt: 2,
      members: [
        { clientId: "c1", token: "tok1", name: "A", role: 0, deck: { id: profiles[0].id } },
        { clientId: "c2", token: "tok2", name: "B", role: 1, deck: { id: profiles[1].id } },
      ],
      state: serialized,
    };
    roomStore.save("ABC", snapshot);
    const all = roomStore.loadAll();
    assert.equal(all.length, 1, "loadAll で1件");
    assert.deepEqual(all[0], snapshot, "save→loadAll が deep-equal（メタ＋局面＋token）");
    roomStore.delete("ABC");
    assert.equal(roomStore.loadAll().length, 0, "delete で0件");
    console.log("[ok] room-store save/loadAll/delete 往復");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n=== persistence smoke OK ===");
  process.exit(0);
})().catch((error) => {
  console.error("SMOKE FAILED:", error);
  process.exit(1);
});

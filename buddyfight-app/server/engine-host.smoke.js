// walking skeleton 実証スモーク:
// サーバ側で「エンジン起動→実データ読込→newGame→アクション→役割別の伏せ字view」が
// 通ることを確認する。実行: node server/engine-host.smoke.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { GameRoom } = require("./engine-host");

const repoRoot = path.resolve(__dirname, "..");
function loadFlagRaw(id) {
  const flagsRaw = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "data/flags.json"), "utf8").replace(/^﻿/, ""),
  );
  const flag = (flagsRaw.flags || []).find((f) => f.id === id);
  assert.ok(flag, `flag ${id} exists in data/flags.json`);
  return flag;
}

(async () => {
  const room = new GameRoom();

  // 1) 実データ読込
  const profiles = await room.loadData();
  assert.ok(profiles.length >= 2, "デッキプロファイルが2つ以上読み込めること");
  const deckIds = [profiles[0].id, profiles[1].id];
  console.log(`[load] デッキ ${profiles.length} 種。使用: ${deckIds.join(" vs ")}`);

  // 2) newGame（サーバがシャッフル・配牌）
  const state = room.startGame(deckIds);
  assert.equal(state.players.length, 2, "プレイヤー2人");
  const [p0, p1] = state.players;
  console.log(
    `[newGame] phase=${state.phase} active=${state.active} ` +
      `P0(${p0.name}) hand=${p0.hand.length} deck=${p0.deck.length} / ` +
      `P1(${p1.name}) hand=${p1.hand.length} deck=${p1.deck.length}`,
  );
  assert.ok(p0.hand.length > 0 && p1.hand.length > 0, "両者に初期手札が配られること");
  assert.ok(p0.hand[0].name, "配牌された手札カードに実体（name）があること");

  // 3) アクション駆動（charge フェイズ → main へ）
  const before = state.phase;
  const afterState = await room.applyAction(0, "main");
  console.log(`[action main] phase ${before} -> ${afterState.phase}`);
  assert.equal(before, "charge", "初期は charge フェイズ");
  assert.equal(afterState.phase, "main", "main へ遷移（アクションが権威stateを変えた）");

  // 4) 役割別 view の伏せ字
  const view0 = room.viewFor(0);
  const view1 = room.viewFor(1);
  const viewSpec = room.viewFor("spectator");

  // seat0 視点: 自分(P0)の手札は実体、相手(P1)の手札は伏せ字、両山札は伏せ字（枚数は保持）
  assert.ok(view0.players[0].hand[0].name, "seat0視点: 自分の手札は見える");
  assert.ok(view0.players[1].hand.every((c) => c.hidden && !c.name), "seat0視点: 相手の手札は非公開");
  assert.equal(view0.players[1].hand.length, p1.hand.length, "相手手札の枚数は保持");
  assert.ok(view0.players[0].deck.every((c) => c.hidden) && view0.players[1].deck.every((c) => c.hidden), "両山札は非公開");
  assert.equal(view0.players[0].deck.length, afterState.players[0].deck.length, "自山札の枚数は保持");

  // seat1 視点: 対称
  assert.ok(view1.players[1].hand[0].name, "seat1視点: 自分の手札は見える");
  assert.ok(view1.players[0].hand.every((c) => c.hidden && !c.name), "seat1視点: 相手の手札は非公開");

  // 観戦視点: 全公開
  assert.ok(viewSpec.players[0].hand[0].name && viewSpec.players[1].hand[0].name, "観戦: 両者の手札が見える");

  console.log(
    `[view] seat0: 自手札=見える 相手手札=${view0.players[1].hand.length}枚(伏字) / ` +
      `観戦: 両手札見える`,
  );

  // 5) 秘匿の最終確認: seat0 の view の「非公開ゾーン」（相手手札・相手山札・自山札）に相手手札の
  //    カード名が一切現れないこと。view 全体の部分一致だと、相手手札名がたまたま相手の公開ゾーン名
  //    （バディ名／フラッグ名／場札名）と一致した時に誤検知して flaky になる（レビュー r3 M2）。
  //    公開ゾーンは走査対象から外し、伏字であるべき非公開ゾーンだけを構造的に検査する（決定的）。
  const hiddenPilesJson = JSON.stringify([view0.players[1].hand, view0.players[1].deck, view0.players[0].deck]);
  const leak = p1.hand.some((c) => c.name && hiddenPilesJson.includes(c.name));
  assert.ok(!leak, "seat0のviewで相手の非公開ゾーン(手札/山札)に相手手札のカード名が漏れていない");

  // 6) Z2(S-UB-C03/0095他・公式裁定Q2629/Q2630)秘匿: バディゾーンの裏向きカードは所有者本人のみ表を
  //    見られる。相手席/観戦席からは常に伏せる（枚数のみ公開）。
  //    Z13(S-UB-C03/0066他)秘匿: 場のfaceDownMonster:trueカードは誰から見ても名前/属性/rulesを伏せる。
  {
    const liveState = room.api.getState();
    const buddyCard = { instanceId: "buddy-face-down-1", name: "秘匿カードの名前", type: "monster" };
    liveState.players[0].buddyZoneFaceDown = [buddyCard];
    liveState.players[1].buddyZoneFaceDown = [];
    const faceDownMonster = {
      instanceId: "face-down-monster-1",
      name: "秘匿モンスターの名前",
      type: "monster",
      currentType: "monster",
      faceDownMonster: true,
      power: 10000,
      defense: 1000,
      critical: 3,
      size: 0,
      attributes: ["あの子"],
      rules: ["秘密のルール文"],
      soul: [],
    };
    liveState.players[0].field.left = faceDownMonster;
    room.api.setState(liveState);

    const bView0 = room.viewFor(0);
    const bView1 = room.viewFor(1);
    const bViewSpec = room.viewFor("spectator");

    // 自席(seat0)からはバディゾーンの中身が見える（Q2629: 所有者本人は表を見られる）。
    assert.deepEqual(bView0.players[0].buddyZoneFaceDown, [buddyCard], "Z2秘匿: 自席からは自分のバディゾーンが見える");
    // 相手席(seat1)からは伏せ字（枚数のみ、中身は{hidden:true}）。
    assert.ok(
      bView1.players[0].buddyZoneFaceDown.every((c) => c.hidden && !c.name),
      "Z2秘匿: 相手席からは相手のバディゾーンが伏せられる",
    );
    assert.equal(bView1.players[0].buddyZoneFaceDown.length, 1, "Z2秘匿: 枚数は相手席でも保持される（Q2630）");
    // 観戦席からは手札と違い両者とも伏せる（本製品固有の厳格な扱い）。
    assert.ok(
      bViewSpec.players[0].buddyZoneFaceDown.every((c) => c.hidden && !c.name),
      "Z2秘匿: 観戦席からもバディゾーンは伏せられる（手札より厳格）",
    );

    // faceDownMonsterは自席/相手席/観戦のいずれからも名前・属性・rulesが伏せられ、上書き後ステのみ見える。
    for (const [label, view] of [["seat0", bView0], ["seat1", bView1], ["spectator", bViewSpec]]) {
      const masked = view.players[0].field.left;
      assert.equal(masked.name, "（裏向き）", `Z13秘匿(${label}): 名前が伏せられる`);
      assert.equal(masked.faceDownMonster, true, `Z13秘匿(${label}): faceDownMonsterフラグは維持`);
      assert.equal(masked.power, 10000, `Z13秘匿(${label}): 上書き後の攻撃力のみ見える`);
      assert.deepEqual(masked.attributes, [], `Z13秘匿(${label}): 属性は伏せられる`);
      assert.equal(JSON.stringify(view).includes("秘密のルール文"), false, `Z13秘匿(${label}): rules文が漏れない`);
    }
    console.log("[secrecy] Z2バディゾーン(自席=見える/相手席・観戦=伏字) / Z13裏向きモンスター(誰から見てもマスク) いずれも確認");
  }

  // 7) T12(subc03-final-verdict.md §7-1・r4仕様): S-UB-C03フラッグ「アイドルマスター シンデレラ
  //    ガールズ劇場」のターン終了誘発(Z1/Z2)を、合成カード直叩きの effects-regression
  //    (testSubc03Engine)ではなく、権威サーバ経路（applyAction("endTurn")のdispatch → 権威state →
  //    viewFor）で確認する。プロンプト往復が要らないこと(0件)も併せて検証する。
  {
    let promptCount = 0;
    const room2 = new GameRoom({ onPrompt: (request) => { promptCount += 1; return request?.options?.[0]?.value ?? null; } });
    await room2.loadData();
    room2.startGame(deckIds);

    const live = room2.api.getState();
    live.phase = "final";
    live.active = 0;
    live.selected = null;
    live.counterHandOwner = null;

    // player0: フラッグをcinderella-girls-theaterへ差し替え、場にバディを1体、他ゾーンは
    // 無関係な誘発(手札トリガー等)を排除するため空にした最小構成にする。
    const cinderellaFlag = JSON.parse(JSON.stringify(loadFlagRaw("cinderella-girls-theater")));
    const buddyCard = {
      instanceId: "t12-buddy-1",
      name: "T12テストバディ",
      type: "monster",
      currentType: "monster",
      power: 1000,
      defense: 1000,
      critical: 1,
      size: 1,
      attributes: [],
      keywords: [],
      used: false,
      soul: [],
    };
    // このフラッグの誘発は「ライフ+1／カード1枚を引く／デッキ上から1枚を裏向きでバディゾーンへ」の
    // 3効果を順に実行する。draw(2番目の効果)がまずデッキ最上段(=配列末尾)を1枚hand へpopし、
    // putTopDeckToBuddyZoneFaceDown(3番目)がその次の1枚をpopしてbuddyZoneFaceDownへ移す。
    // よって「山札を2枚pushし、後にpushした方をdraw用の最上段」にしておけば両方の行き先を検証できる。
    const deckSecondCard = {
      instanceId: "t12-decksecond-1",
      name: "T12山札2枚目",
      type: "monster",
      currentType: "monster",
      power: 1000,
      defense: 1000,
      critical: 1,
      size: 1,
      attributes: [],
      keywords: [],
      used: false,
      soul: [],
    };
    const deckTopCard = {
      instanceId: "t12-decktop-1",
      name: "T12山札トップ",
      type: "monster",
      currentType: "monster",
      power: 1000,
      defense: 1000,
      critical: 1,
      size: 1,
      attributes: [],
      keywords: [],
      used: false,
      soul: [],
    };
    live.players[0].flag = cinderellaFlag;
    live.players[0].buddy = { name: "T12テストバディ" };
    live.players[0].field.left = null;
    live.players[0].field.center = buddyCard;
    live.players[0].field.right = null;
    if (live.players[0].field.item !== undefined) live.players[0].field.item = null;
    live.players[0].buddyZoneFaceDown = [];
    live.players[0].hand = [];
    live.players[0].deck.push(deckSecondCard, deckTopCard);
    // player1: 実デッキ由来のフラッグ/手札が無関係な誘発(相手ターン反応等)を起こさないよう、
    // このシナリオでは中立化する(T12の主眼はplayer0のフラッグ誘発の権威サーバ経路)。
    live.players[1].flag = null;
    live.players[1].hand = [];

    const beforeLife = live.players[0].life;
    const beforeHandLen = live.players[0].hand.length;
    const beforeDeckLen = live.players[0].deck.length;
    const beforeBuddyZoneLen = live.players[0].buddyZoneFaceDown.length;
    room2.api.setState(live);

    const afterState = await room2.applyAction(0, "endTurn");
    assert.equal(afterState.players[0].life, beforeLife + 1, "T12: サーバ経路endTurnでフラッグ誘発によりライフ+1");
    assert.equal(afterState.players[0].hand.length, beforeHandLen + 1, "T12: 手札+1(ドロー)");
    assert.equal(
      afterState.players[0].hand[0]?.instanceId,
      "t12-decktop-1",
      "T12: ドローで引いたのはデッキ最上段のカード自身",
    );
    assert.equal(
      afterState.players[0].buddyZoneFaceDown.length,
      beforeBuddyZoneLen + 1,
      "T12: デッキ上から1枚が裏向きでバディゾーンに置かれる",
    );
    // draw(1枚) + putTopDeckToBuddyZoneFaceDown(1枚)の2効果でデッキは合計2枚減る。
    assert.equal(afterState.players[0].deck.length, beforeDeckLen - 2, "T12: デッキが2枚減る(ドロー1+バディゾーン移動1)");
    assert.equal(
      afterState.players[0].buddyZoneFaceDown[0].instanceId,
      "t12-decksecond-1",
      "T12: バディゾーンへ移動したのはドロー後の新たな最上段カード",
    );

    const viewOpponent = room2.viewFor(1);
    assert.ok(
      viewOpponent.players[0].buddyZoneFaceDown.every((c) => c.hidden && !c.name),
      "T12: 相手視点(viewFor)ではフラッグ誘発で増えたバディゾーンの1枚も伏字",
    );
    assert.equal(viewOpponent.players[0].buddyZoneFaceDown.length, 1, "T12: 相手視点でも枚数は保持される");
    assert.equal(promptCount, 0, "T12: 権威サーバ経路のendTurn dispatchでプロンプト往復は発生しない(0件)");

    console.log(
      "[T12] フラッグturnEnd誘発を権威サーバ経路(applyAction endTurn)で確認: " +
        "life+1/hand+1/buddyZoneFaceDown+1/相手視点で伏字/prompt0件",
    );
  }

  console.log("\n=== engine-host walking skeleton OK ===");
})().catch((error) => {
  console.error("SMOKE FAILED:", error);
  process.exit(1);
});

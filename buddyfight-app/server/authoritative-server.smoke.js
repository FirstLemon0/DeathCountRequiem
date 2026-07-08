// 権威サーバーの headless 2クライアント結合スモーク。
// 実サーバーを起動し、HTTP/SSE で2人分のフロー（作成/参加→開始→役割別view→
// アクション→秘匿→手番ガード）を検証する。実行: node server/authoritative-server.smoke.js
const assert = require("node:assert/strict");
const http = require("node:http");
const { server, rooms } = require("./authoritative-server");
const { GameRoom } = require("./engine-host");

const PORT = Number(process.env.SMOKE_PORT || 4191);
const BASE = `http://127.0.0.1:${PORT}`;

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      `${BASE}${pathname}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : {} }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// SSE 受信コレクタ。messages[] に貯め、waitFor で待つ。
function openSse(roomId, token) {
  const client = { messages: [], _waiters: [], close: null };
  const req = http.get(`${BASE}/auth/rooms/${roomId}/events?token=${token}`, (res) => {
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const msg = JSON.parse(line.slice(6));
          client.messages.push(msg);
          client._waiters = client._waiters.filter((w) => !w.try(msg));
        }
      }
    });
  });
  client.close = () => req.destroy();
  client.waitFor = (pred, ms = 4000) =>
    new Promise((resolve, reject) => {
      const existing = client.messages.find(pred);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error("SSE waitFor timeout")), ms);
      client._waiters.push({
        try: (msg) => {
          if (pred(msg)) {
            clearTimeout(timer);
            resolve(msg);
            return true;
          }
          return false;
        },
      });
    });
  return client;
}

(async () => {
  // 有効なプリセットデッキIDを取得
  const tmp = new GameRoom();
  const profiles = await tmp.loadData();
  const deck0 = profiles[0].id;
  const deck1 = profiles[1].id;

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  try {
    // 1) A が部屋作成（席0）
    const a = (await post("/auth/rooms", { name: "A", deck: { id: deck0 } })).json;
    assert.equal(a.role, 0, "作成者は席0");
    const sseA = openSse(a.roomId, a.token);
    await sseA.waitFor((m) => m.type === "hello");

    // 2) B が参加（席1）
    const b = (await post(`/auth/rooms/${a.roomId}/join`, { name: "B", deck: { id: deck1 } })).json;
    assert.equal(b.role, 1, "参加者は席1");
    const sseB = openSse(a.roomId, b.token);
    await sseB.waitFor((m) => m.type === "hello");

    // ロビーに2人いること
    const lobbyA = await sseA.waitFor((m) => m.type === "lobby" && m.members.length === 2);
    assert.deepEqual(lobbyA.seats, [a.clientId, b.clientId], "席割り [A,B]");

    // 3) 開始
    const startRes = await post(`/auth/rooms/${a.roomId}/lobby`, { token: a.token, action: "start" });
    assert.equal(startRes.status, 200, "開始成功");

    // 4) 役割別 view 受信（秘匿確認）
    const viewA = await sseA.waitFor((m) => m.type === "view");
    const viewB = await sseB.waitFor((m) => m.type === "view");
    assert.equal(viewA.role, 0);
    assert.equal(viewB.role, 1);
    assert.ok(viewA.state.players[0].hand[0].name, "A視点: 自手札は見える");
    assert.ok(viewA.state.players[1].hand.every((c) => c.hidden && !c.name), "A視点: 相手手札は非公開");
    assert.ok(viewB.state.players[1].hand[0].name, "B視点: 自手札は見える");
    assert.ok(viewB.state.players[0].hand.every((c) => c.hidden && !c.name), "B視点: 相手手札は非公開");
    // Bの手札カードの instanceId（一意）は A視点 view のどこにも現れない＝漏れていない。
    // （カード名は A/B のデッキ間で重複しうるため instanceId で判定し、誤検知＝フレークを防ぐ）
    const oppHandIds = viewB.state.players[1].hand.map((c) => c.instanceId);
    const aViewStr = JSON.stringify(viewA.state);
    assert.ok(oppHandIds.every((id) => id && !aViewStr.includes(id)), "A視点のviewにBの手札(instanceId)が漏れていない");
    // 山札・ゲージ(face-down)も非公開
    assert.ok(viewA.state.players[1].gauge.every((c) => c.hidden && !c.name), "A視点: 相手ゲージは非公開");
    assert.ok(viewA.state.players[0].deck.every((c) => c.hidden) && viewA.state.players[1].deck.every((c) => c.hidden), "A視点: 両山札は枚数のみ");
    assert.ok(viewA.state.players[0].gauge.some((c) => !c.hidden) || viewA.state.players[0].gauge.length === 0, "A視点: 自分のゲージは見える");

    // 4b) 選択アクション（charge: params.selected が反映されるか＝play.js→サーバ契約）
    const handId = viewA.state.players[0].hand[0].instanceId;
    const beforeGauge = viewA.state.players[0].gauge.length;
    const chargeRes = await post(`/auth/rooms/${a.roomId}/action`, {
      token: a.token,
      type: "charge",
      params: { selected: { source: "hand", owner: 0, instanceId: handId } },
    });
    assert.equal(chargeRes.status, 200, "charge(選択あり)成功");
    const viewCharge = await sseA.waitFor(
      (m) => m.type === "view" && m.state.players[0].gauge.length > beforeGauge,
    );
    assert.ok(viewCharge, "charge でゲージ増加（params.selected が反映された）");

    // 5) 相手クライアント(B)へも更新が配信され、秘匿が維持される
    const viewBupdate = await sseB.waitFor(
      (m) => m.type === "view" && m.state.players[0].gauge.length > beforeGauge,
    );
    assert.ok(viewBupdate.state.players[1].hand[0].name, "B視点: 自手札は見える（更新後も）");
    assert.ok(viewBupdate.state.players[0].hand.every((c) => c.hidden && !c.name), "B視点: 相手手札は伏字のまま（更新後も）");

    // 6) 手番ガード（B が A の手番に操作 → 409）
    const badAct = await post(`/auth/rooms/${a.roomId}/action`, { token: b.token, type: "main" });
    assert.equal(badAct.status, 409, "非手番の操作は拒否(409)");

    // 7) 観戦者は全公開
    const c = (await post(`/auth/rooms/${a.roomId}/join`, { name: "C(観戦)" })).json;
    assert.equal(c.role, "spectator", "3人目は観戦");
    const sseC = openSse(a.roomId, c.token);
    const viewC = await sseC.waitFor((m) => m.type === "view");
    assert.ok(viewC.state.players[0].hand[0].name && viewC.state.players[1].hand[0].name, "観戦: 両手札見える");

    console.log("[ok] 作成/参加/席割り → 開始 → 役割別view(秘匿) → 選択アクション(charge) → 相手へ配信(秘匿維持) → 手番ガード → 観戦全公開");
    sseA.close(); sseB.close(); sseC.close();

    // 8) プロンプト往復（選択ダイアログ）: アスモダイ登場効果を往復解決。
    //    席0 = td07（チャンピオンレスラー・アスモダイ収録）。setState で決定的盤面を組み、
    //    call(seat0) → resolve(seat1) の解決中に連続発火する選択（任意能力の発動可否→手札破棄→
    //    相手場破壊）が「能力主体=seat0」へ往復することを検証する。宛先は actingSeat(=resolve した
    //    seat1) ではなく状態推定(inferPromptSeat→active=seat0)で解決されるため、seat0 の手札候補が
    //    seat1 へ漏れない（＝手札秘匿の証明も兼ねる）。
    const ASMO_DECK = "td07-asmodai-gathering";
    if (!profiles.some((p) => p.id === ASMO_DECK)) {
      throw new Error(`前提デッキ ${ASMO_DECK} が見つかりません`);
    }
    const a2 = (await post("/auth/rooms", { name: "A2", deck: { id: ASMO_DECK } })).json;
    const sseA2 = openSse(a2.roomId, a2.token);
    await sseA2.waitFor((m) => m.type === "hello");
    const b2 = (await post(`/auth/rooms/${a2.roomId}/join`, { name: "B2", deck: { id: deck1 } })).json;
    const sseB2 = openSse(a2.roomId, b2.token);
    await sseB2.waitFor((m) => m.type === "hello");
    await post(`/auth/rooms/${a2.roomId}/lobby`, { token: a2.token, action: "start" });
    await sseA2.waitFor((m) => m.type === "view");

    // --- 決定的盤面を setState で構築（in-process: rooms 経由でエンジンへ直接アクセス）---
    const room2 = rooms.get(a2.roomId);
    const g = room2.game;
    const st = g.api.getState();
    const P0 = st.players[0];
    const P1 = st.players[1];
    const fieldZones = ["left", "center", "right", "item", "set1", "set2"];
    // アスモダイを席0の手札 先頭へ（hand/deck のどこにあっても確実に手札へ）
    const findAsmo = (pile) => pile.findIndex((card) => card.name === "チャンピオンレスラー・アスモダイ");
    let asmo = null;
    let ai = findAsmo(P0.hand);
    if (ai >= 0) asmo = P0.hand.splice(ai, 1)[0];
    else { ai = findAsmo(P0.deck); if (ai >= 0) asmo = P0.deck.splice(ai, 1)[0]; }
    assert.ok(asmo, "席0にアスモダイが存在する");
    for (const z of fieldZones) P0.field[z] = null; // 席0の場は空（size3 をセンターへ）
    P0.hand.unshift(asmo);
    while (P0.gauge.length < 3 && P0.deck.length) P0.gauge.push(P0.deck.shift()); // コールコスト(ゲージ2)
    // 相手の場に破壊候補のバニラモンスター2体（破壊時の余計な往復を避けるため能力なしを選ぶ）
    const vanilla = P1.deck.filter((card) => card.type === "monster" && (!card.abilities || card.abilities.length === 0));
    assert.ok(vanilla.length >= 2, "席1デッキに能力なしモンスターが2体以上");
    const [tgt1, tgt2] = vanilla;
    P1.deck = P1.deck.filter((card) => card !== tgt1 && card !== tgt2);
    for (const z of fieldZones) P1.field[z] = null;
    P1.field.left = tgt1;
    P1.field.right = tgt2;
    Object.assign(st, {
      active: 0, phase: "main", pendingAction: null, pendingAttack: null,
      resolvingPending: false, winner: null, attacksThisTurn: 0, turnCount: 3,
    });
    g.api.setState(st);

    const asmoId = asmo.instanceId;

    // call 宣言（seat0）。即 pendingAction(kind:call, responder:seat1) で 200 が返る。
    const callRes = await post(`/auth/rooms/${a2.roomId}/action`, {
      token: a2.token, type: "call",
      params: { selected: { source: "hand", owner: 0, instanceId: asmoId }, callZone: "center" },
    });
    assert.equal(callRes.status, 200, "アスモダイ コール宣言成功");

    // resolve（seat1）= 対抗せず解決 → 解決中に登場効果の selectCards が連続発火しホールド。
    //   /action(resolve) は全プロンプト応答まで返らない（ホールド設計）。await せず保持。
    let resolveDone = null;
    const resolveP = post(`/auth/rooms/${a2.roomId}/action`, { token: b2.token, type: "resolve" })
      .then((r) => { resolveDone = r; return r; });

    // 往復プロンプトを順に処理する。アスモダイ登場効果は3連:
    //   ①任意能力の発動可否（使う/使わない）→「使う」 ②手札破棄（自手札, 1枚）③相手場破壊（zone付き, 1枚）。
    // すべて能力主体 seat0(sseA2) に届くこと（seat1 受信ゼロ）が秘匿の証明。
    const answered = new Set();
    let discardPick = null;
    let destroyPick = null;
    let gateSeen = false;
    let promptCount = 0;
    while (resolveDone === null && promptCount < 12) {
      const next = await Promise.race([
        sseA2.waitFor((m) => m.type === "prompt_request" && !answered.has(m.requestId), 8000)
          .then((p) => ({ p }))
          .catch(() => ({ none: true })),
        resolveP.then(() => ({ done: true })),
      ]);
      if (next.done || next.none) break;
      const p = next.p;
      answered.add(p.requestId);
      promptCount += 1;
      const useGate = p.candidates.find((cd) => cd.card && (cd.card.name === "使う" || cd.card.name === "はい"));
      let chosen;
      if (useGate) {
        gateSeen = true;
        chosen = useGate.choiceIndex; // 任意能力を発動する
      } else if (p.candidates.some((cd) => cd.zone)) {
        destroyPick = p.candidates[0]; // 相手の場（zone付き）= 破壊対象
        chosen = destroyPick.choiceIndex;
      } else {
        discardPick = p.candidates[0]; // 自手札 = 破棄対象
        chosen = discardPick.choiceIndex;
      }
      await post(`/auth/rooms/${a2.roomId}/prompt`, {
        token: a2.token, requestId: p.requestId, response: { selectedIndexes: [chosen] },
      });
    }
    await resolveP;
    assert.equal(resolveDone.status, 200, "resolve 完了(200)＝全プロンプト応答後にホールドが解けた");
    assert.ok(gateSeen, "任意能力の発動可否プロンプトが seat0 へ届いた");
    assert.ok(discardPick, "手札破棄プロンプトが seat0 へ届いた");
    assert.ok(destroyPick, "相手場破壊プロンプトが seat0 へ届いた");

    // 結果検証（往復した選択がエンジンへ正しく反映）
    const after = g.api.getState();
    assert.equal(after.players[0].field.center?.instanceId, asmoId, "アスモダイがセンターにコールされた");
    assert.ok(after.players[0].drop.some((cd) => cd.instanceId === discardPick.card.instanceId), "選んだ手札がドロップへ（手札破棄が反映）");
    assert.ok(!after.players[0].hand.some((cd) => cd.instanceId === discardPick.card.instanceId), "破棄した手札は手札から消えた");
    assert.ok(after.players[1].drop.some((cd) => cd.instanceId === destroyPick.card.instanceId), "選んだ相手モンスターが破壊されドロップへ");
    // すべてのプロンプトは seat0 のみへ届いた＝seat1 へ手札候補が漏れていない（秘匿の証明）
    assert.ok(!sseB2.messages.some((m) => m.type === "prompt_request"), "プロンプトは seat1 へ送られていない（手札秘匿）");

    console.log("[ok] プロンプト往復: アスモダイ登場効果（任意→手札破棄→相手場破壊）を seat0 へ3連往復解決（ホールド/秘匿維持）");
    sseA2.close(); sseB2.close();

    // 9) じゃんけん往復（cross-seat 逐次往復）: 能動側の効果が「自分→相手」の順で両プレイヤーに
    //    じゃんけんを問う。promptSeat により各プレイヤー自身の席へ振り分く（seat0 の選択は sseA3、
    //    seat1 の選択は sseB3）ことを検証。決定的化のため attackStart トリガーのじゃんけん能力を
    //    seat0 の場のカードへ注入し、seat0=グー / seat1=チョキ で seat0 勝利（ライフ+2）を確認。
    const a3 = (await post("/auth/rooms", { name: "A3", deck: { id: deck0 } })).json;
    const sseA3 = openSse(a3.roomId, a3.token);
    await sseA3.waitFor((m) => m.type === "hello");
    const b3 = (await post(`/auth/rooms/${a3.roomId}/join`, { name: "B3", deck: { id: deck1 } })).json;
    const sseB3 = openSse(a3.roomId, b3.token);
    await sseB3.waitFor((m) => m.type === "hello");
    await post(`/auth/rooms/${a3.roomId}/lobby`, { token: a3.token, action: "start" });
    await sseA3.waitFor((m) => m.type === "view");

    const g3 = rooms.get(a3.roomId).game;
    const st3 = g3.api.getState();
    const fz3 = ["left", "center", "right", "item", "set1", "set2"];
    // seat0 デッキのモンスター1体に attackStart じゃんけん能力を注入し、場へ配置（決定的化）。
    const mi = st3.players[0].deck.findIndex((card) => card.type === "monster");
    assert.ok(mi >= 0, "席0デッキにモンスターがある");
    const rpsMonster = st3.players[0].deck.splice(mi, 1)[0];
    rpsMonster.abilities = [
      { id: "smoke-rps", kind: "triggered", event: "attackStart", effects: [{ op: "gainLife", amount: 2, rockPaperScissors: true }] },
    ];
    for (const z of fz3) { st3.players[0].field[z] = null; st3.players[1].field[z] = null; }
    st3.players[0].field.left = rpsMonster;
    Object.assign(st3, {
      active: 0, phase: "main", pendingAction: null, pendingAttack: null,
      resolvingPending: false, winner: null, attacksThisTurn: 0, turnCount: 3,
    });
    g3.api.setState(st3);
    const lifeBefore = g3.api.getState().players[0].life;

    // attackPhase（seat0）→ attackStart トリガー → じゃんけん（自分→相手の2往復）でホールド。
    let rpsDone = null;
    const rpsActP = post(`/auth/rooms/${a3.roomId}/action`, { token: a3.token, type: "attackPhase" })
      .then((r) => { rpsDone = r; return r; });

    // 1問目: seat0 自身のじゃんけん（sseA3 に届く）→ グー(rock, choiceIndex 0)。
    const rps1 = await sseA3.waitFor((m) => m.type === "prompt_request", 8000);
    assert.equal(rps1.candidates.length, 3, "じゃんけん候補は3手");
    await post(`/auth/rooms/${a3.roomId}/prompt`, {
      token: a3.token, requestId: rps1.requestId, response: { selectedIndexes: [0] },
    });
    // 2問目: 相手 seat1 のじゃんけん（sseB3 に届く＝promptSeat で相手席へ正しく振り分け）→ チョキ(scissors, choiceIndex 1)。
    const rps2 = await sseB3.waitFor((m) => m.type === "prompt_request", 8000);
    await post(`/auth/rooms/${a3.roomId}/prompt`, {
      token: b3.token, requestId: rps2.requestId, response: { selectedIndexes: [1] },
    });

    const rpsRes = await rpsActP;
    assert.equal(rpsRes.status, 200, "attackPhase 完了(200)＝じゃんけん往復後にホールドが解けた");
    assert.equal(rpsDone.status, 200, "rpsDone も 200");
    const afterRps = g3.api.getState();
    assert.equal(afterRps.players[0].life, lifeBefore + 2, "seat0 はじゃんけんに勝ち(グー>チョキ)ライフ+2");
    // routing: seat0 の選択は sseA3 のみ、seat1 の選択は sseB3 のみ（cross-seat 振り分けの証明）。
    assert.equal(sseA3.messages.filter((m) => m.type === "prompt_request").length, 1, "seat0 へは自分のじゃんけんのみ");
    assert.equal(sseB3.messages.filter((m) => m.type === "prompt_request").length, 1, "seat1 へは相手のじゃんけんのみ");

    console.log("[ok] じゃんけん往復: 能動側の効果で seat0→seat1 の順に各自席へ cross-seat 振り分け往復、勝敗(ライフ+2)反映");
    sseA3.close(); sseB3.close();

    // 10) cross-seat 選択の宛先確定（promptSeat 供給）: 相手の誘発能力が能動側ターンに発火したとき、
    //     その選択が「能力主体=相手席」へ届く（能動側へ漏れない）ことを検証＝防御/対抗側選択の宛先確定の根。
    //     seat1 場札へ opponentEnter 選択能力を注入し、seat0 が bare モンスターをコール→解決中に発火する
    //     seat1 の手札選択が sseB4(seat1) のみへ届き、sseA4(seat0) には来ない（手札候補の漏洩なし）ことを確認。
    const a4 = (await post("/auth/rooms", { name: "A4", deck: { id: deck0 } })).json;
    const sseA4 = openSse(a4.roomId, a4.token);
    await sseA4.waitFor((m) => m.type === "hello");
    const b4 = (await post(`/auth/rooms/${a4.roomId}/join`, { name: "B4", deck: { id: deck1 } })).json;
    const sseB4 = openSse(a4.roomId, b4.token);
    await sseB4.waitFor((m) => m.type === "hello");
    await post(`/auth/rooms/${a4.roomId}/lobby`, { token: a4.token, action: "start" });
    await sseA4.waitFor((m) => m.type === "view");

    const g4 = rooms.get(a4.roomId).game;
    const st4 = g4.api.getState();
    const fz4 = ["left", "center", "right", "item", "set1", "set2"];
    // seat0: enter 能力なしモンスターをコールできるよう手札先頭へ＋ゲージ確保（登場時に余計な往復を出さない）。
    const callMonIdx = st4.players[0].deck.findIndex((c) => c.type === "monster" && (!c.abilities || c.abilities.length === 0));
    assert.ok(callMonIdx >= 0, "席0デッキに能力なしモンスターがある");
    const callMon = st4.players[0].deck.splice(callMonIdx, 1)[0];
    for (const z of fz4) { st4.players[0].field[z] = null; st4.players[1].field[z] = null; }
    st4.players[0].hand.unshift(callMon);
    while (st4.players[0].gauge.length < 3 && st4.players[0].deck.length) st4.players[0].gauge.push(st4.players[0].deck.shift());
    // seat1: opponentEnter 選択能力（自手札を1枚捨てる）を注入したカードを場へ（context.owner=seat1）。
    const watcher = st4.players[1].deck.shift();
    watcher.abilities = [{
      id: "smoke-oppEnter", kind: "triggered", event: "opponentEnter",
      script: [
        { op: "selectCards", var: "x", from: "hand", controller: "self", amount: 1, min: 1, max: 1, title: "相手誘発: 手札を1枚捨てる", lead: "捨てる手札を1枚選んでください。" },
        { op: "moveSelected", var: "x", to: "drop" },
      ],
    }];
    st4.players[1].field.left = watcher;
    Object.assign(st4, {
      active: 0, phase: "main", pendingAction: null, pendingAttack: null,
      resolvingPending: false, winner: null, attacksThisTurn: 0, turnCount: 3,
    });
    g4.api.setState(st4);

    // seat0 が bare モンスターをコール → pendingAction(responder=seat1)。
    const callRes4 = await post(`/auth/rooms/${a4.roomId}/action`, {
      token: a4.token, type: "call",
      params: { selected: { source: "hand", owner: 0, instanceId: callMon.instanceId }, callZone: "center" },
    });
    assert.equal(callRes4.status, 200, "bare モンスター コール宣言成功");
    // seat1 が resolve → 解決中に seat1 の opponentEnter 選択が発火しホールド。
    let xseatDone = null;
    const xseatResolveP = post(`/auth/rooms/${a4.roomId}/action`, { token: b4.token, type: "resolve" })
      .then((r) => { xseatDone = r; return r; });

    // 相手誘発の選択は seat1(sseB4) に届く（promptSeat=context.owner=seat1）。
    const xprompt = await sseB4.waitFor((m) => m.type === "prompt_request", 8000);
    assert.ok(xprompt.candidates.length >= 1, "相手誘発の選択候補がある（seat1 の手札）");
    const xpick = xprompt.candidates[0];
    await post(`/auth/rooms/${a4.roomId}/prompt`, {
      token: b4.token, requestId: xprompt.requestId, response: { selectedIndexes: [xpick.choiceIndex] },
    });
    await xseatResolveP;
    assert.equal(xseatDone.status, 200, "resolve 完了(200)");
    // 核心: 能動側 seat0 は相手誘発の選択プロンプトを一切受信していない（seat1 の手札候補が漏れていない）。
    assert.ok(!sseA4.messages.some((m) => m.type === "prompt_request"), "seat0 へは相手誘発の選択が届かない（promptSeat で seat1 へ振り分け＝手札漏れ防止）");
    assert.ok(sseB4.messages.some((m) => m.type === "prompt_request"), "seat1 へ自分の誘発選択が届いた");
    const afterX = g4.api.getState();
    assert.ok(afterX.players[1].drop.some((c) => c.instanceId === xpick.card.instanceId), "seat1 の選んだ手札がドロップへ");

    console.log("[ok] cross-seat 宛先確定: 相手誘発(opponentEnter)の選択が seat1 のみへ届き seat0 へ漏れない（promptSeat 供給）");
    sseA4.close(); sseB4.close();

    // 11) 攻撃→防御(対抗)→解決 end-to-end（戦闘核）。
    //   11a: seat0 が本体攻撃 → seat1 が resolve → seat1 ライフが攻撃側の critical 分減少。
    //   11b: seat0 が攻撃 → seat1 が field 対抗(nullifyAttack) を使用 → 攻撃無効化（ライフ不変）。
    const fz5 = ["left", "center", "right", "item", "set1", "set2"];

    // --- 11a: 基本攻撃でダメージ ---
    {
      const a5 = (await post("/auth/rooms", { name: "A5", deck: { id: deck0 } })).json;
      const sseA5 = openSse(a5.roomId, a5.token);
      await sseA5.waitFor((m) => m.type === "hello");
      const b5 = (await post(`/auth/rooms/${a5.roomId}/join`, { name: "B5", deck: { id: deck1 } })).json;
      const sseB5 = openSse(a5.roomId, b5.token);
      await sseB5.waitFor((m) => m.type === "hello");
      await post(`/auth/rooms/${a5.roomId}/lobby`, { token: a5.token, action: "start" });
      await sseA5.waitFor((m) => m.type === "view");

      const g5 = rooms.get(a5.roomId).game;
      const st5 = g5.api.getState();
      const ai5 = st5.players[0].deck.findIndex((c) => c.type === "monster");
      const attacker5 = st5.players[0].deck.splice(ai5, 1)[0];
      attacker5.used = false;
      for (const z of fz5) { st5.players[0].field[z] = null; st5.players[1].field[z] = null; }
      st5.players[0].field.center = attacker5;
      Object.assign(st5, { active: 0, phase: "attack", pendingAttack: null, pendingAction: null, resolvingPending: false, winner: null, attacksThisTurn: 0, turnCount: 3 });
      g5.api.setState(st5);
      const lifeBefore5 = g5.api.getState().players[1].life;
      const crit5 = attacker5.critical;
      const atk5 = await post(`/auth/rooms/${a5.roomId}/action`, {
        token: a5.token, type: "attack",
        params: { selected: { source: "field", owner: 0, zone: "center", instanceId: attacker5.instanceId }, attackTarget: "fighter" },
      });
      assert.equal(atk5.status, 200, "本体攻撃 宣言成功");
      assert.ok(g5.api.getState().pendingAttack, "pendingAttack 生成（防御ウィンドウ）");
      const res5 = await post(`/auth/rooms/${a5.roomId}/action`, { token: b5.token, type: "resolve" });
      assert.equal(res5.status, 200, "防御側 resolve 成功");
      assert.equal(g5.api.getState().players[1].life, lifeBefore5 - crit5, "本体へ critical 分のダメージが通った");
      sseA5.close(); sseB5.close();
    }

    // --- 11b: 防御側の field 対抗で攻撃無効化 ---
    {
      const a6 = (await post("/auth/rooms", { name: "A6", deck: { id: deck0 } })).json;
      const sseA6 = openSse(a6.roomId, a6.token);
      await sseA6.waitFor((m) => m.type === "hello");
      const b6 = (await post(`/auth/rooms/${a6.roomId}/join`, { name: "B6", deck: { id: deck1 } })).json;
      const sseB6 = openSse(a6.roomId, b6.token);
      await sseB6.waitFor((m) => m.type === "hello");
      await post(`/auth/rooms/${a6.roomId}/lobby`, { token: a6.token, action: "start" });
      await sseA6.waitFor((m) => m.type === "view");

      const g6 = rooms.get(a6.roomId).game;
      const st6 = g6.api.getState();
      const ai6 = st6.players[0].deck.findIndex((c) => c.type === "monster");
      const attacker6 = st6.players[0].deck.splice(ai6, 1)[0];
      attacker6.used = false;
      const ci6 = st6.players[1].deck.findIndex((c) => c.type === "monster");
      const counter6 = st6.players[1].deck.splice(ci6, 1)[0];
      // 防御側の場札へ「対抗タイミングで攻撃を無効化する」起動能力を注入。
      counter6.abilities = [{
        id: "smoke-counter", kind: "activated", timing: ["counter"],
        conditions: [{ op: "pendingAttackDefenderIsSelf" }], effects: [{ op: "nullifyAttack" }],
      }];
      for (const z of fz5) { st6.players[0].field[z] = null; st6.players[1].field[z] = null; }
      st6.players[0].field.center = attacker6;
      st6.players[1].field.left = counter6;
      Object.assign(st6, { active: 0, phase: "attack", pendingAttack: null, pendingAction: null, resolvingPending: false, winner: null, attacksThisTurn: 0, turnCount: 3 });
      g6.api.setState(st6);
      const lifeBefore6 = g6.api.getState().players[1].life;
      const atk6 = await post(`/auth/rooms/${a6.roomId}/action`, {
        token: a6.token, type: "attack",
        params: { selected: { source: "field", owner: 0, zone: "center", instanceId: attacker6.instanceId }, attackTarget: "fighter" },
      });
      assert.equal(atk6.status, 200, "攻撃宣言成功");
      assert.equal(g6.api.getState().counterHandOwner, 1, "防御側(seat1)に対抗ウィンドウ");
      // seat1 が field 対抗を使用 → nullifyAttack で pendingAttack が即クリアされる。
      const cnt6 = await post(`/auth/rooms/${a6.roomId}/action`, {
        token: b6.token, type: "use",
        params: { selected: { source: "field", owner: 1, zone: "left", instanceId: counter6.instanceId } },
      });
      assert.equal(cnt6.status, 200, "防御側 field 対抗の使用成功");
      assert.ok(!g6.api.getState().pendingAttack, "対抗で攻撃が無効化され pendingAttack がクリアされた");
      assert.equal(g6.api.getState().players[1].life, lifeBefore6, "無効化によりダメージ0（ライフ不変）");
      sseA6.close(); sseB6.close();
    }

    console.log("[ok] 攻撃→防御→解決: 本体攻撃で critical 分ダメージ／防御側 field 対抗(nullifyAttack)で無効化");

    // 12) soulguard 確認往復（破壊時の同期 window.confirm を async 化して所有者へ往復）。
    //   seat0 が seat1 の soulguard モンスターを攻撃破壊しようとすると「ソウルガードを使うか？」が
    //   所有者 seat1 へ往復する。「使わない」→破壊／「使う」→場残り(ソウル-1)。従来オンラインでは
    //   自動 true で常にソウルガード発動だったのを、プレイヤーが選べるようにした実証。
    const buildSoulguardBoard = (g) => {
      const st = g.api.getState();
      const ai = st.players[0].deck.findIndex((c) => c.type === "monster");
      const attacker = st.players[0].deck.splice(ai, 1)[0];
      attacker.used = false; attacker.power = 99999; attacker.critical = 2;
      const si = st.players[1].deck.findIndex((c) => c.type === "monster");
      const sg = st.players[1].deck.splice(si, 1)[0];
      const soulCard = st.players[1].deck.shift();
      sg.used = false; sg.defense = 1000; sg.keywords = ["soulguard"]; sg.soul = [soulCard];
      for (const z of fz5) { st.players[0].field[z] = null; st.players[1].field[z] = null; }
      st.players[0].field.center = attacker; st.players[1].field.center = sg;
      Object.assign(st, { active: 0, phase: "attack", pendingAttack: null, pendingAction: null, resolvingPending: false, winner: null, attacksThisTurn: 0, turnCount: 3 });
      g.api.setState(st);
      return { attackerId: attacker.instanceId, sg };
    };
    const runSoulguardCase = async (label, deckPair, declineSoulguard) => {
      const a = (await post("/auth/rooms", { name: label + "A", deck: { id: deckPair[0] } })).json;
      const sseA = openSse(a.roomId, a.token); await sseA.waitFor((m) => m.type === "hello");
      const b = (await post(`/auth/rooms/${a.roomId}/join`, { name: label + "B", deck: { id: deckPair[1] } })).json;
      const sseB = openSse(a.roomId, b.token); await sseB.waitFor((m) => m.type === "hello");
      await post(`/auth/rooms/${a.roomId}/lobby`, { token: a.token, action: "start" });
      await sseA.waitFor((m) => m.type === "view");
      const g = rooms.get(a.roomId).game;
      const { attackerId, sg } = buildSoulguardBoard(g);
      await post(`/auth/rooms/${a.roomId}/action`, { token: a.token, type: "attack", params: { selected: { source: "field", owner: 0, zone: "center", instanceId: attackerId }, attackTarget: "center" } });
      let done = null;
      const rp = post(`/auth/rooms/${a.roomId}/action`, { token: b.token, type: "resolve" }).then((r) => { done = r; return r; });
      const prompt = await sseB.waitFor((m) => m.type === "prompt_request", 8000);
      assert.ok(/ソウルガード/.test(prompt.title), "ソウルガード確認が届いた");
      // 確認は所有者 seat1(sseB) のみへ。攻撃側 seat0(sseA) には来ない。
      assert.ok(!sseA.messages.some((m) => m.type === "prompt_request"), `${label}: 確認は所有者 seat1 のみ（seat0 に漏れない）`);
      // 候補 [使う, 使わない] → 使わない=choiceIndex1 / 使う=choiceIndex0
      const choice = declineSoulguard ? 1 : 0;
      await post(`/auth/rooms/${a.roomId}/prompt`, { token: b.token, requestId: prompt.requestId, response: { selectedIndexes: [choice] } });
      await rp;
      assert.equal(done.status, 200, `${label}: resolve 完了(200)`);
      sseA.close(); sseB.close();
      return g.api.getState();
    };

    // 12a: 使わない → 破壊
    {
      const st = await runSoulguardCase("SG-decline", [deck0, deck1], true);
      assert.ok(!st.players[1].field.center, "12a: ソウルガードを使わなかったので破壊（センター空）");
    }
    // 12b: 使う → 場残り・ソウル-1
    {
      const st = await runSoulguardCase("SG-use", [deck0, deck1], false);
      assert.ok(st.players[1].field.center, "12b: ソウルガードを使ったので場に残る");
      assert.equal(st.players[1].field.center.soul.length, 0, "12b: ソウルが1枚ドロップへ（1→0）");
    }

    console.log("[ok] soulguard 確認往復: 所有者へ往復し『使わない→破壊／使う→場残り(ソウル-1)』を選択可能（旧: 自動true）");

    // 13) 再接続(C): /me トークン生存確認 ＋ 同トークンで SSE 貼り直し→hello+view 再受信。
    {
      const a = (await post("/auth/rooms", { name: "RC1-A", deck: { id: deck0 } })).json;
      const sseA = openSse(a.roomId, a.token); await sseA.waitFor((m) => m.type === "hello");
      const b = (await post(`/auth/rooms/${a.roomId}/join`, { name: "RC1-B", deck: { id: deck1 } })).json;
      const sseB = openSse(a.roomId, b.token); await sseB.waitFor((m) => m.type === "hello");
      // /me: 生存トークン=200・不正=403
      const meOk = await fetch(`${BASE}/auth/rooms/${a.roomId}/me?token=${a.token}`);
      assert.equal(meOk.status, 200, "/me 生存トークンは200");
      const meBad = await fetch(`${BASE}/auth/rooms/${a.roomId}/me?token=DEADBEEF`);
      assert.equal(meBad.status, 403, "/me 不正トークンは403");
      await post(`/auth/rooms/${a.roomId}/lobby`, { token: a.token, action: "start" });
      await sseA.waitFor((m) => m.type === "view");
      // 切断→同トークンで再接続→hello+view 再受信
      sseA.close();
      const sseA2 = openSse(a.roomId, a.token);
      await sseA2.waitFor((m) => m.type === "hello", 6000);
      const reView = await sseA2.waitFor((m) => m.type === "view", 6000);
      assert.ok(reView.state.players[0].hand[0].name, "再接続後に自席viewが再受信できる（同席復帰）");
      sseA2.close(); sseB.close();
    }
    console.log("[ok] 再接続(C): /me 生存確認 ＋ 同トークン再接続で hello+view 再受信（同席復帰）");

    // 14) 再接続(C) プロンプト再送＝デッドロック回避: 往復プロンプト在席中に宛先SSEを切断→
    //     同トークン再接続で同一 requestId の prompt_request が再配信され、/prompt 応答で applyAction が
    //     60sタイムアウトに落ちず完走することを検証（soulguard 確認往復を流用）。
    {
      const a = (await post("/auth/rooms", { name: "RC2-A", deck: { id: deck0 } })).json;
      const sseA = openSse(a.roomId, a.token); await sseA.waitFor((m) => m.type === "hello");
      const b = (await post(`/auth/rooms/${a.roomId}/join`, { name: "RC2-B", deck: { id: deck1 } })).json;
      let sseB = openSse(a.roomId, b.token); await sseB.waitFor((m) => m.type === "hello");
      await post(`/auth/rooms/${a.roomId}/lobby`, { token: a.token, action: "start" });
      await sseA.waitFor((m) => m.type === "view");
      const g = rooms.get(a.roomId).game;
      const { attackerId } = buildSoulguardBoard(g); // seat0=攻撃側 / seat1=soulguardモンスター
      await post(`/auth/rooms/${a.roomId}/action`, {
        token: a.token, type: "attack",
        params: { selected: { source: "field", owner: 0, zone: "center", instanceId: attackerId }, attackTarget: "center" },
      });
      let resolveDone = null;
      const resolveP = post(`/auth/rooms/${a.roomId}/action`, { token: b.token, type: "resolve" })
        .then((r) => { resolveDone = r; return r; });
      // soulguard 確認は所有者 seat1 へ。受信後、応答せずに切断する。
      const prompt = await sseB.waitFor((m) => m.type === "prompt_request", 8000);
      assert.ok(/ソウルガード/.test(prompt.title), "soulguard プロンプト受信");
      sseB.close(); // 在席プロンプトを残したまま切断
      // 同トークンで再接続 → 同一 requestId の prompt_request が再配信される
      sseB = openSse(a.roomId, b.token);
      const resent = await sseB.waitFor((m) => m.type === "prompt_request" && m.requestId === prompt.requestId, 8000);
      assert.ok(resent, "再接続で同一 requestId の prompt_request が再配信される");
      // 「使わない(=choiceIndex1)」で応答 → resolve が完走（60sタイムアウトに落ちない）
      await post(`/auth/rooms/${a.roomId}/prompt`, { token: b.token, requestId: resent.requestId, response: { selectedIndexes: [1] } });
      await resolveP;
      assert.equal(resolveDone.status, 200, "再接続応答後に resolve が完走（デッドロック回避）");
      sseA.close(); sseB.close();
    }
    console.log("[ok] 再接続(C) プロンプト再送: 切断→再接続で同一 prompt 再配信→応答で完走（デッドロック回避）");

    // 15) 自作(カスタム)デッキ持ち込み（play.js が deck.custom を送る経路）。
    //   席0 が別世界の実デッキを「自作」として custom 同梱で送信 → サーバが収集しエンジン localStorage へ注入
    //   → 開始後 席0 のフラッグが自作デッキ由来（フォールバックのビルトインでない）ことで実使用を確認。
    {
      const fullProfiles = tmp.api.getDeckProfiles();
      const base0 = fullProfiles[0];
      const base1 = fullProfiles.find((p) => p.flag !== base0.flag);
      assert.ok(base1, "フラッグの異なる2デッキが存在");
      const custom = JSON.parse(JSON.stringify(base1));
      custom.id = "custom-smoke-deck-1";
      custom.name = "自作スモークデッキ";

      const a6 = (await post("/auth/rooms", { name: "A6", deck: { id: custom.id, name: custom.name, custom } })).json;
      const sseA6 = openSse(a6.roomId, a6.token);
      await sseA6.waitFor((m) => m.type === "hello");
      const b6 = (await post(`/auth/rooms/${a6.roomId}/join`, { name: "B6", deck: { id: base0.id } })).json;
      const sseB6 = openSse(a6.roomId, b6.token);
      await sseB6.waitFor((m) => m.type === "hello");
      // ロビー配信に custom 定義(recipe)が漏れていないこと（相手へは id/name のみ）
      const lobbyB6 = await sseB6.waitFor((m) => m.type === "lobby" || m.type === "hello");
      const lobbyStr = JSON.stringify(lobbyB6);
      assert.ok(!lobbyStr.includes("recipe") && !lobbyStr.includes("custom-smoke-deck-1\",\"recipe"), "ロビー配信に custom recipe を載せない");

      await post(`/auth/rooms/${a6.roomId}/lobby`, { token: a6.token, action: "start" });
      const viewA6 = await sseA6.waitFor((m) => m.type === "view");
      const flag0 = viewA6.state.players[0].flag.id;
      const flag1 = viewA6.state.players[1].flag.id;
      assert.equal(flag0, base1.flag, "席0フラッグ=自作デッキ由来（エンジンが custom を実使用）");
      assert.notEqual(flag0, base0.flag, "フォールバック(ビルトイン)ではない");
      assert.equal(flag1, base0.flag, "席1=ビルトイン");
      sseA6.close(); sseB6.close();
    }
    console.log("[ok] 自作デッキ持ち込み(E/④): deck.custom 送信→サーバ収集→エンジン注入→開始で実使用（recipe はロビー非漏洩）");

    // 16) 自作デッキ id 衝突回避（共有コード由来で両席が同一 id を持ち寄っても混線しない）。
    //   両席が id="dup-collide" の別世界デッキを送る → サーバが席1側を一意化 → 開始後それぞれ別フラッグ。
    {
      const fullProfiles = tmp.api.getDeckProfiles();
      const A = fullProfiles[0];
      const B = fullProfiles.find((p) => p.flag !== A.flag);
      const customA = JSON.parse(JSON.stringify(A)); customA.id = "dup-collide"; customA.name = "衝突A";
      const customB = JSON.parse(JSON.stringify(B)); customB.id = "dup-collide"; customB.name = "衝突B";

      const a7 = (await post("/auth/rooms", { name: "A7", deck: { id: customA.id, name: customA.name, custom: customA } })).json;
      const sseA7 = openSse(a7.roomId, a7.token);
      await sseA7.waitFor((m) => m.type === "hello");
      const b7 = (await post(`/auth/rooms/${a7.roomId}/join`, { name: "B7", deck: { id: customB.id, name: customB.name, custom: customB } })).json;
      const sseB7 = openSse(a7.roomId, b7.token);
      await sseB7.waitFor((m) => m.type === "hello");
      await post(`/auth/rooms/${a7.roomId}/lobby`, { token: a7.token, action: "start" });
      const viewA7 = await sseA7.waitFor((m) => m.type === "view");
      const f0 = viewA7.state.players[0].flag.id;
      const f1 = viewA7.state.players[1].flag.id;
      assert.equal(f0, A.flag, "席0=衝突A由来のフラッグ");
      assert.equal(f1, B.flag, "席1=衝突B由来のフラッグ（同一idでも別デッキに解決＝混線しない）");
      assert.notEqual(f0, f1, "両席のフラッグが異なる（id衝突で同一デッキに潰れていない）");
      sseA7.close(); sseB7.close();
    }
    console.log("[ok] 自作デッキ id 衝突回避(④/other-3): 同一 id を両席持ち寄っても席別に一意化し別デッキへ解決");

    console.log("\n=== authoritative-server walking skeleton OK ===");
    cleanup(0);
  } catch (error) {
    console.error("SMOKE FAILED:", error);
    cleanup(1);
  }
})();

function cleanup(code) {
  try {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    server.close();
  } catch {
    /* noop */
  }
  process.exit(code);
}

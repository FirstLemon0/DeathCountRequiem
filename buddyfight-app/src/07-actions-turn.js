// ==========================================================================
// buddyfight モジュール 07 — 選択・手番アクション・コール・フェイズ・保留解決・バディ
// 旧 app.js L2180-2806 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function selectHandCard(instanceId) {
  if (typeof aiShouldLockHumanControls === "function" && aiShouldLockHumanControls()) {
    return; // CPU対戦: CPUの手番/思考中は人間のカード選択を受け付けない（state.selected 汚染防止）
  }
  const owner = handOwnerIndex();
  const player = state.players[owner];
  const card = player.hand.find((candidate) => candidate.instanceId === instanceId);
  state.selected = card ? { source: "hand", owner, instanceId } : null;
  state.linkAttackers = [];
  // バディコール宣言は「宣言したカード自身の選択し直し」では維持する
  // （メニュー方式では宣言→再タップ→コール、と同カードを選び直すため。別カード選択では従来どおり破棄）。
  if (state.buddyCallDeclared !== card?.instanceId) {
    state.buddyCallDeclared = null;
  }
  render();
}

function selectFieldCard(owner, zone) {
  if (typeof aiShouldLockHumanControls === "function" && aiShouldLockHumanControls()) {
    return false; // CPU対戦: CPUの手番/思考中は人間のカード選択を受け付けない
  }
  const player = state.players[owner];
  const card = player.field[zone];
  if (!card) {
    return false;
  }
  const canSelect =
    (!hasPendingResolution() && owner === state.active) ||
    (state.pendingAttack &&
      [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(owner)) ||
    (state.pendingAction && owner === state.pendingAction.responder);
  if (!canSelect) {
    return false;
  }
  state.selected = { source: "field", owner, zone, instanceId: card.instanceId };
  state.buddyCallDeclared = null;
  render();
  return true;
}

function getSelectedCard() {
  if (!state.selected) {
    return null;
  }
  const player = state.players[state.selected.owner];
  if (state.selected.source === "hand") {
    return player.hand.find((card) => card.instanceId === state.selected.instanceId) || null;
  }
  if (state.selected.source === "drop") {
    // ドロップからの起動能力（権威版: setSelected で source:"drop" を渡す）。
    return player.drop.find((card) => card.instanceId === state.selected.instanceId) || null;
  }
  return player.field[state.selected.zone];
}

function removeSelectedFromHand() {
  if (state.selected?.source !== "hand") {
    return null;
  }
  const player = state.players[state.selected.owner];
  const cardIndex = player.hand.findIndex(
    (card) => card.instanceId === state.selected.instanceId,
  );
  if (cardIndex < 0) {
    return null;
  }
  return player.hand.splice(cardIndex, 1)[0];
}

// E-Y1(奇襲): 選択中のドロップ札を取り出す（奇襲コール＝ドロップからこのカード自身をコール）。
function removeSelectedFromDrop() {
  if (state.selected?.source !== "drop") {
    return null;
  }
  const player = state.players[state.selected.owner];
  const cardIndex = player.drop.findIndex((card) => card.instanceId === state.selected.instanceId);
  if (cardIndex < 0) {
    return null;
  }
  return player.drop.splice(cardIndex, 1)[0];
}

async function drawAction() {
  if (state.winner || hasPendingResolution() || state.drewThisTurn) {
    return;
  }
  if (state.phase !== "draw") {
    addLog("ドローはドローフェイズでのみ行えます。");
    return;
  }
  expireTransientResponseWindows();
  await runPhaseStartTriggers("turnStart", state.active);
  await runPhaseStartTriggers("drawStart", state.active);
  // FE2(0124 ガエン): ドローステップ自体も封じる。drawCards が封鎖ログを出すので二重ログを避ける。
  const drawBanned = drawBanActive(state.active);
  drawCards(activePlayer(), 1);
  state.drewThisTurn = true;
  state.phase = "charge";
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  if (!drawBanned) {
    addLog(`${activePlayer().name}はカードを1枚引きました。`);
  }
  render();
}

async function chargeAction() {
  if (
    state.winner ||
    hasPendingResolution() ||
    state.chargedThisTurn ||
    state.selected?.source !== "hand" ||
    state.selected.owner !== state.active
  ) {
    return;
  }
  if (state.phase !== "charge") {
    addLog("チャージ&ドローはチャージフェイズでのみ行えます。");
    return;
  }
  const card = removeSelectedFromHand();
  if (!card) {
    return;
  }
  expireTransientResponseWindows();
  // FE2(0124 ガエン): チャージ自体（ゲージ送り）は可能だが、引くことはできない。
  const drawBanned = drawBanActive(state.active);
  activePlayer().gauge.push(card);
  drawCards(activePlayer(), 1);
  state.chargedThisTurn = true;
  state.phase = "main";
  state.selected = null;
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  // 「相手のゲージにカードが置かれた時」誘発（爆雷 コールドラゴン メギトス 0020）。
  await runFieldEventTriggers("gaugePlaced", state.active, card, null, { count: 1 });
  await runPhaseStartTriggers("mainStart", state.active);
  addLog(
    drawBanned
      ? `${activePlayer().name}は${card.name}をチャージしました（効果でカードを引けません）。`
      : `${activePlayer().name}は${card.name}をチャージし、1枚引きました。`,
  );
  render();
}

async function goMainPhase() {
  if (state.winner || hasPendingResolution() || state.phase !== "charge") {
    return;
  }
  expireTransientResponseWindows();
  state.phase = "main";
  state.selected = null;
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  await runPhaseStartTriggers("mainStart", state.active);
  addLog(`${activePlayer().name}はメインフェイズに入りました。`);
  render();
}

// 「このカードは1ターンにN枚だけコールできる」(竜騎士 トモエ 0012 等) のコール回数制限。
// 同名カードがこのターンに既に callLimitPerTurn 回コールされていれば true（=これ以上コール不可）。
function isCallCountLimitedThisTurn(owner, card) {
  const limit = card?.callLimitPerTurn;
  if (!limit) {
    return false;
  }
  const counts = state.calledCardNamesThisTurn?.[owner] || {};
  return (counts[card.name] || 0) >= limit;
}

// コール宣言が成立した（コスト支払い済み）カードを、このターンのコール回数として記録する。
// 無効化されても「コールした」ことに変わりはないため、宣言成立時点で加算する。
function recordCardCalledThisTurn(owner, card) {
  if (!card?.callLimitPerTurn) {
    return;
  }
  state.calledCardNamesThisTurn ||= [{}, {}];
  const counts = (state.calledCardNamesThisTurn[owner] ||= {});
  counts[card.name] = (counts[card.name] || 0) + 1;
}

// 必殺モンスター(DDD)のコール可否（共通ゲート）。「必殺モンスターは1ターンに1枚、君の
// ファイナルフェイズにのみコールできる」（カード注記）は、通常コール・バディコール・特殊コール・
// 効果によるコール（src/14 の callSelected 系）の全てに掛かる。非 impactMonster は常に許可（既存挙動不変）。
// E3(D-SS03/0020 革命者 ゼータ・0028/0029 ジェムクローン): 必殺モンスターの「1ターンに1枚」コール上限を
// データ駆動で引き上げる。既定 cap=1（＝従来の `< 1` と完全に等価＝挙動不変）。場札/装備アイテムの継続
// raiseImpactCallCap（controller/conditions 走査＝restrictOwnCall と同流儀）を反映する。
//  - unlimited:true → Infinity（ゼータは equipSelf でアイテム化し、装備中の継続 raiseImpactCallCap{unlimited:true}
//    で自席の必殺コールが無制限になる。ジェムクローンの手札必殺 重ねコール連鎖も同ゲート解放で通る）。
//  - それ以外 → amount(既定1) を加算。
// raiseImpactCallCap を持つ既存カードは0件（新op）＝常に cap=1＝後方互換。
// F1(D-SS03/0028・0029 ジェムクローン): stackOnly:true の cap 解放は「重ねコール(stackCallSelected)判定のみ」に
// 効かせる。通常/バディ/効果コールの必殺 cap には効かない（原文に「1ターンに何回でもコール」文は無く、ゼータ0020
// だけが無制限＝stackOnly 無しで全コールに効く）。呼び出し側が options.stackCall=true を渡した時のみ stackOnly を算入。
function impactCallCap(owner, options = {}) {
  let cap = 1;
  state.players.forEach((player, pIdx) => {
    zones.forEach((zone) => {
      const source = player.field[zone];
      activeContinuousEffects(source).forEach((effect) => {
        if (effect.op !== "raiseImpactCallCap") return;
        if (effect.controller === "self" && pIdx !== owner) return;
        if (effect.controller === "opponent" && pIdx === owner) return;
        // stackOnly は重ねコール判定(options.stackCall)でのみ算入する。通常コール経路では無視＝cap 据え置き。
        if (effect.stackOnly && !options.stackCall) return;
        // context に owner/zone を渡し、発生源基準の条件（sourceZoneIn:["item"] 等＝ゼータ「変身中のみ」）を正しく評価する。
        if (effect.conditions?.length && !checkCardConditions(effect.conditions, pIdx, { card: source, zone, owner: pIdx })) return;
        if (effect.unlimited) {
          cap = Infinity;
        } else if (cap !== Infinity) {
          cap += effect.amount ?? 1;
        }
      });
    });
  });
  return cap;
}

function impactMonsterCallAllowed(owner, card, options = {}) {
  if (card?.type !== "impactMonster") {
    return true;
  }
  const underPerTurnLimit = (state.impactMonsterCallsThisTurn?.[owner] || 0) < impactCallCap(owner, options);
  // 0008 デュエルズィーガー等: カード自身の特殊コール文（「〜が破壊された時…コールしてよい」）が成立している
  // 場合は、必殺モンスター一般注記の「自分のファイナルフェイズのみ」ゲートを免除する（カードテキスト優先原則。
  // ライフリンク相殺の逆転コールは相手ターンの破壊で窓が開くため）。1ターン1枚の上限カウンタは維持する。
  // E-PR7(PR/0285 デアデビル“リターン”): 対話 callMonster だけでなく script 系 call op（callSelected*ForScript
  // 全6経路）も、DSL 側 step.specialCall:true で opt-in するとこの免除を受けられる。既存 script call カードは
  // step.specialCall 非保持＝options.specialCall は Boolean(undefined)=false ＝厳格ゲートのまま（挙動不変）。
  if (options.specialCall) {
    return underPerTurnLimit;
  }
  return (
    state.phase === "final" &&
    owner === state.active &&
    underPerTurnLimit
  );
}

// X6(D-BT01/0064): ターン限定コール制限（restrictCallThisTurn）は効果によるコールにも掛かる。
// 通常コールは isCallRestricted（src/18）が同リストを参照する。effect-call 5op はこのヘルパーで判定する。
function turnCallRestrictionBlocks(owner, card) {
  return (state.callRestrictionsThisTurn || []).some(
    (restriction) => restriction.owner === owner && !matchesCardFilter(card, restriction.allowFilter || {}),
  );
}

function recordImpactMonsterCall(owner, card) {
  if (card?.type !== "impactMonster") {
    return;
  }
  state.impactMonsterCallsThisTurn ||= [0, 0];
  state.impactMonsterCallsThisTurn[owner] = (state.impactMonsterCallsThisTurn[owner] || 0) + 1;
}

async function callMonster(zone) {
  const selectedCard = getSelectedCard();
  const selectedOwner = state.selected?.owner;
  const specialCallOpportunity = specialCallOpportunityForCard(selectedOwner, selectedCard);
  // E-Y1(奇襲): 奇襲コールはドロップから行う（落ちた本人カードを【コールコスト】で場へ戻す）。
  // 他の特殊コール（破壊時逆転コール等）は従来どおり手札から。
  const isAmbushCall = state.selected?.source === "drop" && specialCallOpportunity?.reason === "ambush";
  const player = state.players[selectedOwner ?? state.active];
  // 必殺モンスター(DDD)は自分のファイナルフェイズにのみコール可。通常モンスターは従来通りメインのみ。
  const callPhase = selectedCard?.type === "impactMonster" ? "final" : "main";
  if (
    (state.winner && !specialCallOpportunity) ||
    (hasPendingResolution() && !specialCallOpportunity) ||
    (state.phase !== callPhase && !specialCallOpportunity) ||
    (state.selected?.source !== "hand" && !isAmbushCall) ||
    (!specialCallOpportunity && state.selected.owner !== state.active) ||
    !selectedCard ||
    !isCallableMonster(selectedCard) ||
    !fieldZones.includes(zone)
  ) {
    return;
  }
  if (!validateCardCanBeUsedByOwner(selectedOwner, selectedCard)) {
    return;
  }
  // 通常コール禁止（特定カードの効果でのみ場に出せる。アルティメット・カードバーン等）。
  if (selectedCard.cannotCallNormally) {
    addLog(`${selectedCard.name}は通常のコールでは場に出せません（特定の効果でのみ）。`);
    return;
  }
  // 必殺モンスターの共通ゲート（1ターン1枚・自分のファイナルフェイズのみ）。
  // ただし specialCallOpportunity（破壊時特殊コール等）が成立している場合は phase/active 要求を免除する
  //（カード自身の特殊コール文が一般注記のファイナル限定に優先＝カードテキスト優先原則。0008 デュエルズィーガーの
  //  相手ターン破壊→逆転コール）。1ターン1枚の上限カウンタ・消費は維持する。
  if (
    selectedCard.type === "impactMonster" &&
    !impactMonsterCallAllowed(selectedOwner, selectedCard, { specialCall: Boolean(specialCallOpportunity) })
  ) {
    addLog("必殺モンスターは1ターンに1枚、自分のファイナルフェイズにのみコールできます。");
    return;
  }
  const stackTarget = selectedCard.callStack ? getStackCallTarget(player, selectedCard) : null;
  // callStack.optional は原文が「モンスター１枚"まで"の上に重ね」型（重ねずに通常コールも可）。
  // 重ね先が選ばれていない/居ない場合は stackTarget=null のまま通常コールとして続行する
  // （actualZone は下で zone に落ち、costs.call は通常コール経路で従来どおり課金される）。
  // optional 無し（重ね必須型）は従来どおり重ね先未解決ならブロック（後方互換）。
  if (selectedCard.callStack && !stackTarget && !selectedCard.callStack.optional) {
    addLog(`${selectedCard.name}は、重ねる対象を効果対象から選んでください。`);
    return;
  }
  if (!checkCardConditions(selectedCard.callConditions, selectedOwner)) {
    addLog(`${selectedCard.name}のコール条件を満たしていません。`);
    return;
  }
  if (isCallRestricted(selectedOwner, selectedCard)) {
    // 継続コール制限（戦神機 GIZAI天王『搭乗中は《戦神機》以外をコールできない』等）。
    addLog(`${selectedCard.name}は今コールできません。`);
    return;
  }
  if (isCallCountLimitedThisTurn(selectedOwner, selectedCard)) {
    // 「このカードは1ターンにN枚だけコールできる」(竜騎士 トモエ 0012 等)。同名でこのターンの上限に達していれば不可。
    addLog(`${selectedCard.name}はこのターンこれ以上コールできません。`);
    return;
  }
  const actualZone = stackTarget?.zone || zone;
  if (
    (selectedCard.callZones && !selectedCard.callZones.includes(actualZone)) ||
    (selectedCard.cannotCallZones || []).includes(actualZone)
  ) {
    addLog(`${selectedCard.name}は${zoneLabel(actualZone)}にコールできません。`);
    return;
  }
  if (actualZone === "center" && isCenterCallPrevented(selectedOwner, selectedCard)) {
    addLog(`${selectedCard.name}はセンターにコールできません。`);
    return;
  }
  expireTransientResponseWindows({ preserveSpecialCallOpportunity: specialCallOpportunity });
  const declaredBuddyCall = isBuddyCallDeclared(player, selectedCard);
  const deckBeforeCost = player.deck.length;
  const lifeBeforeCost = player.life;
  const payment = await payCardCostWithSelection(player, selectedCard, "call", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = isAmbushCall ? removeSelectedFromDrop() : removeSelectedFromHand();
  // 非同期誘発レース(fuzzer seed915): queueTriggerMicrotask の誘発（例: D-BT01/0045 スラスターズ・レスポンスの
  // discardHand コスト）は fire-and-forget で、宣言フローの await 境界（コスト支払い中のプロンプト等）に割り込み
  // 手札を書き換えうる。冒頭検証後〜ここまでの間に選択カードが手札/ドロップを離れていたら null が返る。
  // null のまま beginPendingAction すると card.name/card.conditionalSize で二重クラッシュ→pump 停止（進行不能）
  // になるため、chargeAction/useMagicalGoodbyeCounterCard と同じ前例に倣い宣言を中止する（カードは移動済みの
  // 正規ゾーンに保存されている＝保存則は保たれる）。
  if (!card) {
    addLog(`${selectedCard.name}が${isAmbushCall ? "ドロップゾーン" : "手札"}にないため、コールを中止しました。`);
    return;
  }
  beginPendingAction({
    kind: "call",
    owner: selectedOwner,
    responder: 1 - selectedOwner,
    card,
    phase: state.phase,
    targetZone: actualZone,
    stackTarget: stackTarget ? { owner: stackTarget.owner, zone: stackTarget.zone } : null,
    declaredBuddyCall,
    // E-Y1(奇襲): このコールが『奇襲』ルート由来か。resolvePendingCall→resolveOnEnter で
    // card.calledViaAmbush を立て、allyAmbushEnter を放送する。
    viaAmbush: isAmbushCall,
    effectTargetValue: elements.effectTarget.value,
  });
  if (specialCallOpportunity) {
    specialCallOpportunity.used = true;
  }
  recordCardCalledThisTurn(selectedOwner, card);
  // 必殺モンスターの「1ターンに1枚」は宣言成立（コスト支払い済み）時点で消費する（無効化されても戻らない）。
  recordImpactMonsterCall(selectedOwner, card);
  addLog(`${player.name}は${card.name}を${zoneLabel(actualZone)}にコール宣言しました。対抗確認を行ってください。`);
  render();
  await resolveDeclarationIfGameEnded(deckBeforeCost, lifeBeforeCost, player);
}

// 保存則: 宣言のコスト支払いで自分が敗北条件に落ちた（このコストで山札が0/ライフが0以下）場合、pending 解決を
// 待たずに即解決して札を正規のゾーンへ着地させる。winner 成立後は pump/UI が対抗解決を回さないため、
// removeSelectedFromHand で抜いた札(＋そのソウル)が pendingAction.card に宙吊りのまま物理消失する
// （fuzzer 終局時保存則の恒久漏れ・seed12/337/51/722）。決着済みで対抗の意味が無いこの局面のみ、既存の
// resolvePendingResolution 経路をそのまま使って着地させる（コール→場・装備→アイテム枠・魔法→解決後ドロップ等）。
// 支払いで実際にデッキ/ライフがしきい値を跨いだ時だけ発火＝空デッキ前提テスト等の無変化ケースは従来どおり不変。
// （このコスト以外の要因で既に敗北状態だった宣言＝別カードが先にデッキを0にした後の宣言は、宣言時点では
//  deckBeforeCost が既に0で跨がないためここでは拾えない。決着でループを抜けた後の宙吊り札は aiPump 末尾の
//  安全網が resolvePendingResolution で着地させる＝fuzzer seed302/685。空デッキ前提の内部テストは pump を
//  回さないため影響を受けない。宣言時点で deck/life が既に0でも winner 未成立なら発火しない＝従来どおり不変。）
async function resolveDeclarationIfGameEnded(deckBeforeCost, lifeBeforeCost, player) {
  if (
    state.winner &&
    state.pendingAction &&
    ((deckBeforeCost > 0 && player.deck.length === 0) || (lifeBeforeCost > 0 && player.life <= 0))
  ) {
    await resolvePendingResolution();
  }
}

function specialCallOpportunityForCard(owner, card) {
  if (owner === undefined || owner === null || !card) {
    return null;
  }
  // E-Y1(奇襲): 判定の直前に安全網の reconcile を回す（ドロップへ落ちた裏向き奇襲札を確実に登録）。
  // 冪等・faceDown はオプトインなので既存挙動は不変。
  reconcileFaceDownSoulDrops();
  // E-Y1(奇襲): 『奇襲』keyword を持つ札は、ドロップに落ちた本人 instance の奇襲コール権を優先評価する。
  // callConditions を必要とせず keyword 駆動で成立（B4/B5 は keywords:["ambush"] を付けるだけ）。
  if (hasKeyword(card, "ambush")) {
    const ambush = findAmbushOpportunity(owner, card);
    if (ambush) {
      return ambush;
    }
  }
  // 旧 specialCallOnDestroyed は desugarCardFlags で callConditions へ統一済みのため、
  // ここでは callConditions の specialCall/temporaryCall 系エントリのみを評価する。
  const condition = (card.callConditions || []).find((entry) =>
    ["specialCallOpportunityMatches", "temporaryCallOpportunityMatches"].includes(entry.op),
  );
  return condition ? findSpecialCallOpportunity(owner, condition) : null;
}

async function resolvePendingCall(action) {
  const player = state.players[action.owner];
  const card = action.card;
  if (action.nullified) {
    player.drop.push(card);
    addLog(`${card.name}のコールは無効化され、ドロップゾーンに置かれました。`);
    return;
  }
  const stackTarget = action.stackTarget
    ? getFieldTarget(action.stackTarget.owner, action.stackTarget.zone)
    : null;
  if (action.stackTarget && !stackTarget) {
    player.drop.push(card);
    addLog(`${card.name}を重ねる対象が場を離れたため、ドロップゾーンに置かれました。`);
    return;
  }
  const actualZone = action.targetZone;
  if (stackTarget) {
    stackFieldCardAsSoul(player, actualZone, card);
  } else if (player.field[actualZone]) {
    const replaced = player.field[actualZone];
    dropFieldCardByRule(player, actualZone);
    addLog(`${zoneLabel(actualZone)}にいた${replaced.name}をルール処理でドロップに置きました。`);
    player.field[actualZone] = card;
  } else {
    player.field[actualZone] = card;
  }
  card.conditionalSize = null; // 再コール時は前回のサイズ上書き(アンノウン0029等)をリセット
  enforceSizeLimit(player, actualZone);
  state.phase = action.phase || "main";
  state.selected = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  if (action.declaredBuddyCall) {
    player.partnerCalled = true;
    player.life += 1;
    addLog(`${player.name}は${card.name}を${zoneLabel(actualZone)}にバディコールし、ライフを1回復しました。`);
  } else {
    addLog(`${player.name}は${card.name}を${zoneLabel(actualZone)}にコールしました。`);
  }
  if (card.destroyAtEndOfTurn) {
    card.destroyAtEndOfTurnOwner = action.owner;
  }
  // 通常コールは手札発。奇襲コールはドロップ発（E-Y1）。
  // enteredFromZoneIn 条件（「手札から登場した時」H-PP01/0031 等）のためにスタンプする。
  card.enteredFromZone = action.viaAmbush ? "drop" : "hand";
  await resolveOnEnter(card, player, getTargetInfoFromValue(action.effectTargetValue), {
    ambush: Boolean(action.viaAmbush),
  });
}

function getStackCallTarget(player, card) {
  const target = getEffectTargetInfo();
  if (!target || target.owner !== state.players.indexOf(player)) {
    return null;
  }
  if (!fieldZones.includes(target.zone) || effectiveCardType(target.card) !== "monster") {
    return null;
  }
  const nameIncludes = card.callStack?.nameIncludes;
  if (nameIncludes && !target.card.name.includes(nameIncludes)) {
    return null;
  }
  const stackAttribute = card.callStack?.attribute;
  if (stackAttribute && !(target.card.attributes || []).includes(stackAttribute)) {
    return null;
  }
  // attributeIn: 複数属性のいずれか（《ワイダーサカー》か《百鬼》の上に重ねる 0052）。
  const stackAttributeIn = card.callStack?.attributeIn;
  if (Array.isArray(stackAttributeIn) && !stackAttributeIn.some((a) => (target.card.attributes || []).includes(a))) {
    return null;
  }
  // filter: 汎用フィルタ(matchesCardFilter)で重ね先を絞る（baseSizeGte 等。H-EB04/0010 等）。既存キーと併用可。
  const stackFilter = card.callStack?.filter;
  if (stackFilter && !matchesCardFilter(target.card, stackFilter)) {
    return null;
  }
  return target;
}

function stackFieldCardAsSoul(player, zone, card) {
  const baseCard = player.field[zone];
  card.soul ||= [];
  if (baseCard) {
    card.soul.push(...(baseCard.soul || []));
    baseCard.soul = [];
    card.soul.push(baseCard);
  }
  player.field[zone] = card;
}

function enforceSizeLimit(player, latestZone) {
  const limit = fieldSizeLimit(player);
  while (getFieldSize(player) > limit) {
    const dropZone = fieldZones.find((zone) => zone !== latestZone && player.field[zone]);
    if (!dropZone) {
      break;
    }
    const dropped = player.field[dropZone];
    dropFieldCardByRule(player, dropZone);
    addLog(`サイズ合計が${limit}を超えたため、${dropped.name}をルール処理でドロップに置きました。`);
  }
}

async function resolveOnEnter(card, player, storedTarget = null, options = {}) {
  const owner = state.players.indexOf(player);
  const zone = findFieldCardSlot(card)?.zone;
  recordEnteredEventWindow(card, owner, zone);
  // E-Y1(奇襲): この登場が『奇襲』ルート由来かを card に刻む（毎登場ごとに明示代入＝過去の奇襲登場が
  // 後の通常登場に残らない stale 防止）。calledViaAmbush 条件op（0003/0033/0036/0064/0092/0094）が参照する。
  card.calledViaAmbush = Boolean(options.ambush);
  // onEnter:"destroy-opponent-size2" は desugarCardFlags で構造化 triggered/enter ability へ
  // 変換済みのため、専用ハードコード分岐は不要。すべて runTriggeredAbilities が処理する。
  await runTriggeredAbilities(card, "enter", {
    card,
    player,
    owner,
    zone,
    // FE4: 自身の "enter" 放送にも entered* を供給（ally/opponent/ambush/equip/set 経路は供給済み＝欠落の是正）。
    // enteredCardMatches（0113 ポーン。context.enteredCard 参照）・enteredZoneIn（bf-h-bt04-0069/0071
    // レフト/ライト登場。context.enteredZone 参照）が自己登場でも正しく判定できる。enteredCard は
    // 既存の `context.enteredCard || context.card` フォールバック（15/13）と同値のため他カードの挙動は不変。
    enteredCard: card,
    enteredOwner: owner,
    enteredZone: zone,
    target: storedTarget || null,
    // 「カードの効果で登場した時」条件（enteredByEffect。H-PP01/0044）用。
    // 通常コール経路（resolvePendingCall/arriveCard）は false、script のコール系は true を渡す。
    enteredByEffect: Boolean(options.byEffect),
    // E-XU2(X-UB01/0021 ミセリア): 「『仮面剣士 キリ』の効果で登場した時」用。効果コール経路が
    // 発生源カード（context.card＝キリ）を options.enterCauseCard として渡す。通常コール／未指定は null＝
    // enteredByCardNamed/enterCauseMatches は false（既存カードの enter 誘発は挙動不変・オプトイン）。
    enterCauseCard: options.enterCauseCard || null,
  });
  await runAllyEnterTriggers(card, owner, zone);
  // E-Y1(奇襲): 「君のモンスターが『奇襲』で登場した時」の場イベント allyAmbushEnter（0039 飛翔刃）。
  // 場全体へ放送。奇襲登場でない通常登場では発火しない＝既存挙動不変（オプトイン）。
  if (options.ambush) {
    await runFieldEventTriggers("ambushEnter", owner, card, zone, {
      __excludeSourceInstanceId: card.instanceId,
      enteredCard: card,
      enteredOwner: owner,
      enteredZone: zone,
    });
  }
}

async function runAllyEnterTriggers(enteredCard, owner, enteredZone) {
  for (const triggerOwner of [owner, 1 - owner]) {
    const event = triggerOwner === owner ? "allyEnter" : "opponentEnter";
    for (const zone of zones) {
      const sourceCard = state.players[triggerOwner]?.field?.[zone];
      if (!sourceCard || sourceCard.instanceId === enteredCard.instanceId) {
        continue;
      }
      await runTriggeredAbilities(sourceCard, event, {
        card: sourceCard,
        player: state.players[triggerOwner],
        owner: triggerOwner,
        zone,
        enteredCard,
        enteredOwner: owner,
        enteredZone,
        target: { owner, zone: enteredZone, card: enteredCard, __fromEvent: true },
      });
    }
    // ドロップゾーンの登場誘発（triggerZones:["drop"]|fromDropZone を持つ能力のみ）。戦闘員 ネバッド 0023 等。
    const isDropEnter = (ability) =>
      ability.kind === "triggered" &&
      ability.event === event &&
      (ability.fromDropZone || (ability.triggerZones || []).includes("drop"));
    for (const sourceCard of [...(state.players[triggerOwner]?.drop || [])]) {
      if (sourceCard.instanceId === enteredCard.instanceId || !(sourceCard.abilities || []).some(isDropEnter)) {
        continue;
      }
      await runTriggeredAbilities(sourceCard, event, {
        card: sourceCard,
        player: state.players[triggerOwner],
        owner: triggerOwner,
        zone: "drop",
        enteredCard,
        enteredOwner: owner,
        enteredZone,
        target: { owner, zone: enteredZone, card: enteredCard, __fromEvent: true },
        __abilityFilter: isDropEnter,
      });
    }
  }
}

async function runFieldEventTriggers(eventBase, eventOwner, eventCard, eventZone, details = {}) {
  // __excludeSourceInstanceId: イベントの発生源カード自身をリスナーから除外する
  // （設置魔法が自分の設置=「使った時」に自己反応しないように。連鎖を狙え！等）。
  const { __excludeSourceInstanceId, ...detailRest } = details;
  for (const triggerOwner of [eventOwner, 1 - eventOwner]) {
    const event = triggerOwner === eventOwner ? `ally${capitalizeAscii(eventBase)}` : `opponent${capitalizeAscii(eventBase)}`;
    for (const zone of zones) {
      const sourceCard = state.players[triggerOwner]?.field?.[zone];
      if (!sourceCard) {
        continue;
      }
      if (__excludeSourceInstanceId && sourceCard.instanceId === __excludeSourceInstanceId) {
        continue;
      }
      await runTriggeredAbilities(sourceCard, event, {
        card: sourceCard,
        player: state.players[triggerOwner],
        owner: triggerOwner,
        zone,
        eventCard: {
          card: eventCard,
          owner: eventOwner,
          zone: eventZone,
          source: "field",
        },
        eventFieldCard: eventCard,
        eventOwner,
        eventZone,
        target: { owner: eventOwner, zone: eventZone, card: eventCard, __fromEvent: true },
        ...detailRest,
      });
    }
  }
}

function capitalizeAscii(value = "") {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
}

// 「相手のゲージにカードが置かれた時」誘発（爆雷 メギトス 0020）を microtask で発火する。
// 同期のゲージ配置ヘルパー（デッキ/ソウル/自身をゲージへ）からも安全に呼べるよう非同期化。
// リスナーが無ければ何もしない（gaugePlaced に反応する場札が無い時は空振り）。
function queueGaugePlacedTriggers(chargingOwner, cards = []) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [cards].filter(Boolean);
  if (list.length === 0) {
    return;
  }
  const hasListener = [0, 1].some((playerIndex) =>
    zones.some((zone) => {
      const c = state.players[playerIndex]?.field?.[zone];
      // 自身/ソウル/爆雷継承(inheritSoulAbilities)まで見ないと、ソウルの爆雷を継承したホスト(ヤミゲドウ等)を取りこぼす。
      return (
        cardHasTriggeredListener(c, "allyGaugePlaced") || cardHasTriggeredListener(c, "opponentGaugePlaced")
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runFieldEventTriggers("gaugePlaced", chargingOwner, list[0], null, { count: list.length });
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

// E5(D-BT04/0039 サクシヲン・0098 ノルド): 「デッキのカードがドロップゾーンに置かれた時」の場ブロードキャスト。
// eventOwner=デッキ所有者（listener から見て ally=自分のデッキ／opponent=相手のデッキ）。details.millCause に
// 起因（byEffect/byCost・sourceOwner=どちらの席のカードか・sourceCard）を運び、リスナー側は条件op
// eventMillCauseMatches（src/13）で「君のカードの効果で」を照合する。同期のミル経路（コスト等）からも
// 安全に呼べるよう microtask で発火（queueGaugePlacedTriggers と同型）。
// 既存カードに ally/opponentDeckMilled リスナーは無い＝hasListener が常に偽＝既存挙動完全不変。
function queueDeckMilledTriggers(deckOwner, cards = [], cause = null) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [cards].filter(Boolean);
  if (list.length === 0) {
    return;
  }
  // E8(D-CBT/PR-0330 追撃者 アビゲール): デッキ→ドロップのミル枚数をデッキ所有者(deckOwner席)ごとに
  // ターン内集計する（deckMilledThisTurn 条件・src/13 が参照）。ここは全ミル経路が合流する deckMilled の
  // 唯一の発火点であり（funnel putCardsToDropWithTrigger も、それを経由しない直接ミル経路
  // ―src/15 eachPlayerTopDeckToDrop… / lookTop… / 置換ミル等― も最終的にここへ来る）、下の hasListener
  // 早期returnより「前」に置くことで、deckMilled リスナーが場に居るか否かに依らず常時カウントする。
  // ―― 0330 本体が場に居なかった時点で起きたミルの履歴も条件opが見るため（cause 不問。効果起因/コスト
  // 起因/置換を区別しない）。state 常駐で room 復元(JSON往復)後も保たれ、clearTurnModifiers(src/11) が
  // ターン境界でリセットする。既存 state に無くても安全なようガード付き ||= で初期化。
  state.turnDeckMilled ||= [0, 0];
  state.turnDeckMilled[deckOwner] = (state.turnDeckMilled[deckOwner] || 0) + list.length;
  const hasListener = [0, 1].some((playerIndex) =>
    zones.some((zone) => {
      const c = state.players[playerIndex]?.field?.[zone];
      return (
        cardHasTriggeredListener(c, "allyDeckMilled") || cardHasTriggeredListener(c, "opponentDeckMilled")
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runFieldEventTriggers("deckMilled", deckOwner, list[0], null, { count: list.length, millCause: cause });
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

// E9(D-CBT/0109 シェイクハンズ・ドラゴン): 「(場のカードが)カードの効果でスタンドした時」の場ブロードキャスト。
// stoodEntries = [{ owner, zone, card, cause }]（cause は makeEffectCause 由来の効果起因。details.standCause で
// リスナーへ届き、条件op eventStandCauseMatches が照合する）。呼び出し元は効果スタンド経路のみ
// （standTarget/standAll=src/15・standSelected=src/14。レスト→スタンドへ実際に遷移したカードだけを渡す）。
// ターン開始の standPlayer(src/11)・多回攻撃キーワードのスタンド(src/10)からは呼ばない＝0109 の原文
// 「君のカードの効果でスタンドした時」に合わせ、フェイズ/ルール処理スタンドでは発火させない（毎ターン誤爆防止）。
// 同期経路からも安全なよう microtask 発火・リスナー不在なら何もしない（queueGaugePlacedTriggers と同型）。
// 複数枚は「1本の」microtask チェーン内で逐次 await する（E5 の教訓: チェーンを複数立てると await 交錯で
// named-once/limit の二重計上レースになる。src/15:moveTopDeckToDrop の注記参照）。
// 既存カードに ally/opponentStand リスナーは無い＝hasListener が常に偽＝既存挙動完全不変。
function queueStandTriggers(stoodEntries) {
  const list = (Array.isArray(stoodEntries) ? stoodEntries : [stoodEntries]).filter((entry) => entry && entry.card);
  if (list.length === 0) {
    return;
  }
  // E-PR16(PR/0470): このターン中に「効果で」スタンドしたカードの owner/instanceId を履歴に記帳。
  // queueStandTriggers は効果スタンド専用の choke point（standTarget/standAll=src/15・standSelected=src/14）で、
  // ターン開始 standPlayer・多回攻撃キーワードのスタンドは通らない＝原文「効果でスタンド」に一致。hasListener の
  // 早期 return より前に置き、ally/opponentStand リスナー不在（既存カードは全て不在）でも確実に記帳する。
  // 素の instanceId 文字列配列＝JSON 直列化可（room 復元/リプレイで往復）。クリアは clearTurnModifiers。
  state.standedByEffectThisTurn = state.standedByEffectThisTurn || [[], []];
  for (const entry of list) {
    if (!Number.isInteger(entry.owner) || !entry.card?.instanceId) {
      continue;
    }
    const bucket = state.standedByEffectThisTurn[entry.owner] || (state.standedByEffectThisTurn[entry.owner] = []);
    if (!bucket.includes(entry.card.instanceId)) {
      bucket.push(entry.card.instanceId);
    }
  }
  const hasListener = [0, 1].some((playerIndex) =>
    zones.some((zone) => {
      const c = state.players[playerIndex]?.field?.[zone];
      return cardHasTriggeredListener(c, "allyStand") || cardHasTriggeredListener(c, "opponentStand");
    }),
  );
  if (!hasListener) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      for (const entry of list) {
        await runFieldEventTriggers("stand", entry.owner, entry.card, entry.zone ?? null, {
          standCause: entry.cause || null,
        });
      }
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

// FE1(D-CBT/0090 コルンバ・ファクト “青光”): 「君の手札がドロップゾーンに置かれた時」の場ブロードキャスト。
// deckMilled(E5) と同型で、手札→ドロップの唯一の合流点 discardHandCardsToDrop(src/11) から呼ばれる。
// discardOwner=手札を捨てたプレイヤー席（listener から見て ally=自分の手札／opponent=相手の手札が置かれた）。
// details.discardCause に E6 の捨て起因（byEffect/byCost・sourceOwner・sourceCard）を載せ、必要なら listener 側が
// 条件op eventDiscardCauseMatches で「〜の効果で」を照合できる（0090 は cause 不問＝原文に発生源限定が無い）。
// バッチ発火: 1回の捨てアクション（discardHandCardsToDrop の1呼び出し）で1回だけ発火する。複数枚同時捨ても
// list[0] を eventCard・count を details に載せて1発（0090 の named-once{turn} と合わせ、原文「1ターンに1回」の
// 二重計上を避ける）。既存の per-card discardedFromHand（捨てられたカード自身の自己参照誘発・src/11
// queueDiscardedFromHandTriggers）はこの場ブロードキャストとは独立に不変。同期の捨て経路（コスト等）からも
// 安全なよう microtask で発火（queueDeckMilledTriggers/queueStandTriggers と同型）。
// 既存カードに ally/opponentHandDiscarded リスナーは無い＝hasListener が常に偽＝既存挙動完全不変。
function queueHandDiscardedTriggers(discardOwner, cards = [], cause = null) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [cards].filter(Boolean);
  if (list.length === 0) {
    return;
  }
  const hasListener = [0, 1].some((playerIndex) =>
    zones.some((zone) => {
      const c = state.players[playerIndex]?.field?.[zone];
      return (
        cardHasTriggeredListener(c, "allyHandDiscarded") || cardHasTriggeredListener(c, "opponentHandDiscarded")
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runFieldEventTriggers("handDiscarded", discardOwner, list[0], null, {
        count: list.length,
        discardCause: cause,
      });
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

async function restFieldCard(owner, zone, card = state.players[owner]?.field?.[zone], details = {}) {
  if (!card || card.used) {
    return false;
  }
  card.used = true;
  await runFieldEventTriggers("rest", owner, card, zone, details);
  // E-XC4(X-CP01/0068 ギアーズランス):「君の場の《竜騎士》がカードの効果でレストした時」。効果起因(reason:"effect")の
  // レストに限り restedByEffect を放送する（allyRestedByEffect/opponentRestedByEffect）。攻撃宣言レスト(reason:"attack")
  // やターン開始の自動処理では発火しない（details.reason で分岐）。hasListener ゲート＝既存リスナー0件で挙動完全不変。
  if (details.reason === "effect" && fieldHasRestedByEffectListener()) {
    await runFieldEventTriggers("restedByEffect", owner, card, zone, details);
  }
  return true;
}

// E-XC4: restedByEffect リスナーが盤面に1枚でもあるか（放送前の軽量ゲート。既存0件なら常に偽＝素通り不変）。
function fieldHasRestedByEffectListener() {
  return [0, 1].some((seat) =>
    zones.some((zone) => {
      const c = state.players[seat]?.field?.[zone];
      return (
        cardHasTriggeredListener(c, "allyRestedByEffect") ||
        cardHasTriggeredListener(c, "opponentRestedByEffect")
      );
    }),
  );
}

async function moveFieldCard(owner, fromZone, toZone, details = {}) {
  const player = state.players[owner];
  const card = player?.field?.[fromZone];
  if (!card || !zones.includes(toZone) || player.field[toZone]) {
    return false;
  }
  player.field[fromZone] = null;
  player.field[toZone] = card;
  await runFieldEventTriggers("move", owner, card, toZone, {
    fromZone,
    ...details,
  });
  // E-Y2(X-BT01/0010 ゴルディオン・ハルバード): 「このカードがセンターに『移動』した時」。
  // 移動先がセンターの時だけ、移動したカード自身の movedToCenter 誘発を1回発火する。
  // 移動後もセンターに在ることを再確認（move イベントの解決中に除去/再配置され得るため）。
  // movedToCenter を持つ既存カードは0件＝hasListener ゲートで既存挙動は完全不変（オプトイン）。
  if (
    toZone === "center" &&
    player.field.center?.instanceId === card.instanceId &&
    (card.abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "movedToCenter")
  ) {
    await runTriggeredAbilities(card, "movedToCenter", {
      card,
      player,
      owner,
      zone: "center",
      fromZone,
    });
  }
  return true;
}

async function runPhaseStartTriggers(event, turnOwner = state.active) {
  for (const owner of [turnOwner, 1 - turnOwner]) {
    for (const zone of zones) {
      const card = state.players[owner]?.field?.[zone];
      if (!card) {
        continue;
      }
      await runTriggeredAbilities(card, event, {
        card,
        player: state.players[owner],
        owner,
        zone,
        turnOwner,
      });
    }
  }
  // ドロップゾーンのフェイズ開始誘発（triggerZones:["drop"] / fromDropZone を持つ能力のみ）。
  // 例: ドーン伯爵0005(ターン開始時に自己蘇生) / 村雨0013(メイン開始時に手札へ)。
  const isDropTrigger = (ability) =>
    ability.kind === "triggered" &&
    ability.event === event &&
    (ability.fromDropZone || (ability.triggerZones || []).includes("drop"));
  for (const owner of [turnOwner, 1 - turnOwner]) {
    for (const card of [...(state.players[owner]?.drop || [])]) {
      if (!(card.abilities || []).some(isDropTrigger)) {
        continue;
      }
      await runTriggeredAbilities(card, event, {
        card,
        player: state.players[owner],
        owner,
        zone: "drop",
        turnOwner,
        __abilityFilter: isDropTrigger,
      });
    }
  }
  // Z1(S-UB-C03/0095): フラッグの誘発能力。フラッグは場のカードではなく zones 走査(上)にも
  // ドロップ走査にも乗らないため、両プレイヤーの player.flag を末尾で別途走査する。
  // フラッグは能力無効化を受けない（公式裁定Q2220: ∞ the Chaos ∞ 先例）ため、runTriggeredAbilities
  // 冒頭の isAbilitiesNullified(card) ガードは card.type==="flag" で常にスキップされる（05-stats.js）。
  // turnEnd は両者に配送される（下のendTurn()参照）ため、フラッグ側DSLの
  // conditions:[{op:"turnOwnerIsSelf"}] で自ターンのみ発火させる（エンジン特殊分岐を作らない）。
  for (const owner of [turnOwner, 1 - turnOwner]) {
    const flag = state.players[owner]?.flag;
    if (flag?.abilities?.length) {
      await runTriggeredAbilities(flag, event, {
        card: flag,
        player: state.players[owner],
        owner,
        turnOwner,
      });
    }
  }
}

function beginPendingAction(action) {
  state.pendingAction = {
    ...action,
    counterUsed: {
      [action.owner]: null,
      [action.responder]: null,
    },
    nullified: false,
  };
  state.counterHandOwner = action.responder;
  state.selected = null;
  state.linkAttackers = [];
}

async function resolvePendingResolution() {
  if (state.resolvingPending) {
    return;
  }
  if (isNetworkConnected() && networkSession.seat !== networkResolutionSeat()) {
    updateNetworkStatus("対抗確認を担当する相手席の解決を待っています。");
    return;
  }
  expireTransientResponseWindows();
  state.resolvingPending = true;
  render();
  try {
    if (state.pendingAction) {
      await resolvePendingAction();
      return;
    }
    if (state.pendingAttack) {
      await resolvePendingAttack();
    }
  } finally {
    state.resolvingPending = false;
    // Z6(S-UB-C03/0054): endFinalPhase効果op(15-ability-effects.js)が立てたstate.pendingEndTurnを、
    // 対抗確認(pendingAction)の解決が完全にアンワインドしたこの地点で消費してターンを終える。
    // 必殺技はファイナルフェイズでのみ使用できる(08-card-use.js)ため、この時点でstate.phaseは
    // 既に"final"のはず。useCardAction側の即時解決(counterTiming)経路にも同じ消費フックがあるが、
    // 消費時にフラグをfalseへ戻すため二重発火はしない。
    if (state.pendingEndTurn) {
      state.pendingEndTurn = false;
      if (!state.winner && !hasPendingResolution() && state.phase === "final") {
        await endTurn();
      }
    }
    render();
  }
}

function networkResolutionSeat() {
  if (state.pendingAction) {
    return state.pendingAction.responder;
  }
  if (state.pendingAttack) {
    return state.pendingAttack.defender;
  }
  return null;
}

async function resolvePendingAction() {
  const action = state.pendingAction;
  if (!action) {
    return;
  }
  state.pendingAction = null;
  state.counterHandOwner = null;
  state.selected = null;
  state.linkAttackers = [];
  if (action.kind === "call") {
    await resolvePendingCall(action);
  }
  if (action.kind === "spell") {
    await resolvePendingSpell(action);
  }
  if (action.kind === "impact") {
    await resolvePendingSpell(action);
  }
  if (action.kind === "setSpell") {
    await resolvePendingSetSpell(action);
  }
  if (action.kind === "equip") {
    await resolvePendingEquip(action);
  }
  if (action.kind === "ability") {
    await resolvePendingAbility(action);
  }
}

async function resolvePendingEquip(action) {
  const player = state.players[action.owner];
  if (action.nullified) {
    player.drop.push(action.card);
    addLog(`${action.card.name}の装備は無効化され、ドロップゾーンに置かれました。`);
    return;
  }
  await equipCardDirect(player, action.card);
}

async function resolvePendingSpell(action) {
  const player = state.players[action.owner];
  if (action.nullified) {
    player.drop.push(action.card);
    addLog(`${action.card.name}は無効化され、ドロップゾーンに置かれました。`);
    return;
  }
  const context = {
    card: action.card,
    ability: action.ability,
    player,
    owner: action.owner,
    target: getTargetInfoFromValue(action.effectTargetValue),
    costDiscardedCards: action.costDiscardedCards || [], // E-PR6: 宣言時に捨てたコスト札を解決の条件へ持ち越す
  };
  await executeAbilityBody(context);
  if (!context.cardMoved) {
    player.drop.push(action.card);
  }
  markAbilityLimit(action.owner, action.card, action.ability || {});
  addLog(`${action.card.name}を解決しました。`);
  // 「君が魔法を使った時」の場全体誘発（allySpellCast/opponentSpellCast）。設置カード等が反応（ルヴィア 0004）。
  if (effectiveCardType(action.card) === "spell") {
    await runFieldEventTriggers("spellCast", action.owner, action.card, null, { spellCard: action.card });
  }
}

async function resolvePendingAbility(action) {
  const player = state.players[action.owner];
  if (action.nullified) {
    markAbilityLimit(action.owner, action.card, action.ability || {});
    // 手札発動(変身/搭乗等)が無効化された場合、宣言時に手札から抜いた本体はドロップへ置く。
    if (action.fromHand) {
      player.drop.push(action.card);
      addLog(`${action.card.name}は無効化され、ドロップゾーンに置かれました。`);
    } else {
      addLog(`${pendingActionLabel(action)}は無効化されました。`);
    }
    return;
  }
  // 手札発動: 宣言時に手札から抜いた本体を一旦ドロップへ置く（equipSelf 等が回収/着地する。
  // 何も移動しない効果なら「使った起動能力カード」としてドロップに残る＝手札発動パスと同順序）。
  if (action.fromHand) {
    player.drop.push(action.card);
  }
  const context = {
    card: action.card,
    ability: action.ability,
    player,
    owner: action.owner,
    zone: action.zone,
    hostCard: action.hostCard || null,
    hostOwner: action.hostOwner,
    hostZone: action.hostZone,
    target: getTargetInfoFromValue(action.effectTargetValue),
    costDiscardedCards: action.costDiscardedCards || [], // E-PR6: 手札発動起動能力でも捨てたコスト札を解決へ持ち越す
  };
  const bodyResult = await executeAbilityBody(context);
  // 手札発動の callSelfFromHand 中断（コール先選択キャンセル等）は宣言不成立として手札へ戻す。
  if (action.fromHand) {
    const usesCallSelf =
      Array.isArray(action.ability?.script) && action.ability.script.some((step) => step?.op === "callSelfFromHand");
    if (bodyResult === false && usesCallSelf) {
      const onField = [...fieldZones, ...setZones, "item"].some(
        (zone) => player.field[zone]?.instanceId === action.card.instanceId,
      );
      const dropIndex = player.drop.findIndex((c) => c.instanceId === action.card.instanceId);
      if (!onField && dropIndex >= 0) {
        player.drop.splice(dropIndex, 1);
        player.hand.push(action.card);
        addLog(`${action.card.name}のコールを取りやめ、手札に戻しました。`);
        markAbilityLimit(action.owner, action.card, action.ability || {});
        state.phase = action.phase || state.phase;
        return;
      }
    }
  }
  markAbilityLimit(action.owner, action.card, action.ability || {});
  state.phase = action.phase || state.phase;
  addLog(`${pendingActionLabel(action)}を解決しました。`);
}

async function resolvePendingSetSpell(action) {
  const player = state.players[action.owner];
  if (action.nullified) {
    player.drop.push(action.card);
    addLog(`${action.card.name}は無効化され、ドロップゾーンに置かれました。`);
    return;
  }
  if (player.field[action.zone]) {
    player.drop.push(action.card);
    addLog(`${action.card.name}を配置する場所がなくなったため、ドロップゾーンに置かれました。`);
    return;
  }
  await placeSetSpellDirect(player, action.card, action.zone);
  // 設置魔法も「使う」に含まれる（“爆雷”等の spellCast 誘発。H-PP01/0021 レビュー指摘）。
  // 無効化/置き場なしの早期 return では発火しない＝通常魔法と同じ対称性。
  // 魔法のみ（『設置』持ち必殺技では発火しない=resolvePendingSpellと同じガード）。
  // 置いた設置カード自身は自己反応しない（連鎖を狙え！が自分で1ソウル貯めない）。
  if (effectiveCardType(action.card) === "spell") {
    await runFieldEventTriggers("spellCast", action.owner, action.card, null, {
      spellCard: action.card,
      __excludeSourceInstanceId: action.card.instanceId,
    });
  }
}

function clearPendingAction(returnPhase = "main") {
  state.pendingAction = null;
  state.counterHandOwner = null;
  state.phase = returnPhase || "main";
  state.selected = null;
  state.linkAttackers = [];
}

// 場のカードの継続 grantNullifyImmunity が、指定 owner のカード card に無効化耐性を付与しているか。
// 例: 戦乙女 全知のアルヴィドル「君の使うカード名に「大魔法」を含むカードは、無効化されない」。
function grantedNullifyImmunity(card, owner) {
  if (!card) {
    return false;
  }
  return state.players.some((player, sourceOwner) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return activeContinuousEffects(source).some((e) => {
        if (e.op !== "grantNullifyImmunity") return false;
        if (e.controller === "self" && owner !== sourceOwner) return false;
        if (e.controller === "opponent" && owner === sourceOwner) return false;
        if (e.filter && !matchesCardFilter(card, e.filter)) return false;
        // E-X4(出荷済みバグ修正・E-X3 と同型): 継続エントリの conditions を評価する。従来この関数
        // （アクション無効化耐性＝nullifyPendingAction 経路）だけが conditions を黙殺し、能力無効化側の
        // grantedProtectionBlocks(kind:nullify・src/05:828)は読むという非対称だった。該当4枚: S-UB-C03/0001
        // 島村卯月「アイドル3種類以上なら」・0008 高垣楓「他の《アイドル》があるなら」＋idolrare クローン
        // ir001/ir008 が条件不問で常時耐性化していた。sibling と同じ走査規約＝発生源席 sourceOwner 視点・
        // context{card:source, zone}で評価。conditions 無しエントリ（既存4件）は完全不変＝後方互換。
        if (e.conditions && !checkCardConditions(e.conditions, sourceOwner, { card: source, zone })) return false;
        return true;
      });
    }),
  );
}

// カード自身の cannotBeNullified を評価する。true（従来の無条件形）に加え、
// {conditions:[...]} の条件付き形を許容（太陽の盾「君の場に《太陽竜》2枚以上があるなら無効化されない」等）。
function cardCannotBeNullified(card, owner) {
  const flag = card?.cannotBeNullified;
  if (!flag) {
    return false;
  }
  if (flag === true) {
    return true;
  }
  return checkCardConditions(flag.conditions || [], owner, { card });
}

function nullifyPendingAction(sourceName = "効果") {
  if (!state.pendingAction) {
    return false;
  }
  const action = state.pendingAction;
  if (cardCannotBeNullified(action.card, action.owner) || grantedNullifyImmunity(action.card, action.owner)) {
    addLog(`${action.card.name}は無効化されません。`);
    return false;
  }
  action.nullified = true;
  addLog(`${sourceName}で${pendingActionLabel(action)}を無効化しました。`);
  return true;
}

function pendingActionLabel(action = state.pendingAction) {
  if (!action) {
    return "行動";
  }
  // 診断ログ(diagnosticContext)からも呼ばれるため、card 欠落の異常 pendingAction でも絶対に throw しない
  //（ここが投げると「一次エラーの記録中に二次クラッシュして一次原因が隠れる」＝seed915 で実害）。
  const cardName = action.card?.name || "カード";
  if (action.kind === "call") {
    return `${cardName}のコール`;
  }
  if (action.kind === "ability") {
    return `${cardName}の能力`;
  }
  if (action.kind === "equip") {
    return `${cardName}の装備`;
  }
  return `${cardName}の使用`;
}

function pendingResponderOwner() {
  if (state.pendingAttack) {
    return state.pendingAttack.defender;
  }
  return state.pendingAction?.responder ?? state.active;
}

function partnerCall() {
  const player = activePlayer();
  const selectedCard = getSelectedCard();
  if (!canDeclareBuddyCall(player, selectedCard)) {
    return;
  }
  if (state.buddyCallDeclared === selectedCard.instanceId) {
    state.buddyCallDeclared = null;
    addLog("バディコール宣言を解除しました。");
  } else {
    state.buddyCallDeclared = selectedCard.instanceId;
    addLog(`${selectedCard.name}を次のコールでバディコールとして宣言します。`);
  }
  render();
}

function canDeclareBuddyCall(player, card) {
  return Boolean(
    !state.winner &&
      !hasPendingResolution() &&
      state.phase === "main" &&
      !player.partnerCalled &&
      state.selected?.source === "hand" &&
      state.selected.owner === state.active &&
      card &&
      isCallableMonster(card) &&
      isBuddyCard(player, card),
  );
}

function isBuddyCallDeclared(player, card) {
  return Boolean(
    state.buddyCallDeclared === card?.instanceId &&
      !player.partnerCalled &&
      isBuddyCard(player, card),
  );
}

function isBuddyCard(player, card) {
  return Boolean(player.buddy && card?.name === player.buddy.name);
}

function isCallableMonster(card) {
  return ["monster", "impactMonster"].includes(card?.type);
}


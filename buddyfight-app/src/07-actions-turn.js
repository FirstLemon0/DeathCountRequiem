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
  drawCards(activePlayer(), 1);
  state.drewThisTurn = true;
  state.phase = "charge";
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  addLog(`${activePlayer().name}はカードを1枚引きました。`);
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
  addLog(`${activePlayer().name}は${card.name}をチャージし、1枚引きました。`);
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
function impactMonsterCallAllowed(owner, card) {
  if (card?.type !== "impactMonster") {
    return true;
  }
  return (
    state.phase === "final" &&
    owner === state.active &&
    (state.impactMonsterCallsThisTurn?.[owner] || 0) < 1
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
  const player = state.players[selectedOwner ?? state.active];
  // 必殺モンスター(DDD)は自分のファイナルフェイズにのみコール可。通常モンスターは従来通りメインのみ。
  const callPhase = selectedCard?.type === "impactMonster" ? "final" : "main";
  if (
    (state.winner && !specialCallOpportunity) ||
    (hasPendingResolution() && !specialCallOpportunity) ||
    (state.phase !== callPhase && !specialCallOpportunity) ||
    state.selected?.source !== "hand" ||
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
  // specialCallOpportunity（破壊時特殊コール等）でも免除しない＝カード注記は無限定のため。
  if (selectedCard.type === "impactMonster" && !impactMonsterCallAllowed(selectedOwner, selectedCard)) {
    addLog("必殺モンスターは1ターンに1枚、自分のファイナルフェイズにのみコールできます。");
    return;
  }
  const stackTarget = selectedCard.callStack ? getStackCallTarget(player, selectedCard) : null;
  if (selectedCard.callStack && !stackTarget) {
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
  const payment = await payCardCostWithSelection(player, selectedCard, "call", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  beginPendingAction({
    kind: "call",
    owner: selectedOwner,
    responder: 1 - selectedOwner,
    card,
    phase: state.phase,
    targetZone: actualZone,
    stackTarget: stackTarget ? { owner: stackTarget.owner, zone: stackTarget.zone } : null,
    declaredBuddyCall,
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
}

function specialCallOpportunityForCard(owner, card) {
  if (owner === undefined || owner === null || !card) {
    return null;
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
  // 通常コールは常に手札発（callMonster が source==="hand" をガード済み）。
  // enteredFromZoneIn 条件（「手札から登場した時」H-PP01/0031 等）のためにスタンプする。
  card.enteredFromZone = "hand";
  await resolveOnEnter(card, player, getTargetInfoFromValue(action.effectTargetValue));
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
  // onEnter:"destroy-opponent-size2" は desugarCardFlags で構造化 triggered/enter ability へ
  // 変換済みのため、専用ハードコード分岐は不要。すべて runTriggeredAbilities が処理する。
  await runTriggeredAbilities(card, "enter", {
    card,
    player,
    owner,
    zone,
    target: storedTarget || null,
    // 「カードの効果で登場した時」条件（enteredByEffect。H-PP01/0044）用。
    // 通常コール経路（resolvePendingCall/arriveCard）は false、script のコール系は true を渡す。
    enteredByEffect: Boolean(options.byEffect),
  });
  await runAllyEnterTriggers(card, owner, zone);
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

async function restFieldCard(owner, zone, card = state.players[owner]?.field?.[zone], details = {}) {
  if (!card || card.used) {
    return false;
  }
  card.used = true;
  await runFieldEventTriggers("rest", owner, card, zone, details);
  return true;
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
  if (action.kind === "call") {
    return `${action.card.name}のコール`;
  }
  if (action.kind === "ability") {
    return `${action.card.name}の能力`;
  }
  if (action.kind === "equip") {
    return `${action.card.name}の装備`;
  }
  return `${action.card.name}の使用`;
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


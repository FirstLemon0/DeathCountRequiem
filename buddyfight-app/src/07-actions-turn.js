// ==========================================================================
// buddyfight モジュール 07 — 選択・手番アクション・コール・フェイズ・保留解決・バディ
// 旧 app.js L2180-2806 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function selectHandCard(instanceId) {
  const owner = handOwnerIndex();
  const player = state.players[owner];
  const card = player.hand.find((candidate) => candidate.instanceId === instanceId);
  state.selected = card ? { source: "hand", owner, instanceId } : null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  render();
}

function selectFieldCard(owner, zone) {
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

async function callMonster(zone) {
  const selectedCard = getSelectedCard();
  const selectedOwner = state.selected?.owner;
  const specialCallOpportunity = specialCallOpportunityForCard(selectedOwner, selectedCard);
  const player = state.players[selectedOwner ?? state.active];
  if (
    (state.winner && !specialCallOpportunity) ||
    (hasPendingResolution() && !specialCallOpportunity) ||
    (state.phase !== "main" && !specialCallOpportunity) ||
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

async function resolveOnEnter(card, player, storedTarget = null) {
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
        target: { owner, zone: enteredZone, card: enteredCard },
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
        target: { owner, zone: enteredZone, card: enteredCard },
        __abilityFilter: isDropEnter,
      });
    }
  }
}

async function runFieldEventTriggers(eventBase, eventOwner, eventCard, eventZone, details = {}) {
  for (const triggerOwner of [eventOwner, 1 - eventOwner]) {
    const event = triggerOwner === eventOwner ? `ally${capitalizeAscii(eventBase)}` : `opponent${capitalizeAscii(eventBase)}`;
    for (const zone of zones) {
      const sourceCard = state.players[triggerOwner]?.field?.[zone];
      if (!sourceCard) {
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
        target: { owner: eventOwner, zone: eventZone, card: eventCard },
        ...details,
      });
    }
  }
}

function capitalizeAscii(value = "") {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
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
}

function clearPendingAction(returnPhase = "main") {
  state.pendingAction = null;
  state.counterHandOwner = null;
  state.phase = returnPhase || "main";
  state.selected = null;
  state.linkAttackers = [];
}

function nullifyPendingAction(sourceName = "効果") {
  if (!state.pendingAction) {
    return false;
  }
  const action = state.pendingAction;
  if (action.card?.cannotBeNullified) {
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


// ==========================================================================
// buddyfight モジュール 08 — カード使用(呪文/アイテム/インパクト/対抗/着任)
// 旧 app.js L2807-3326 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
async function useCardAction() {
  const selectedCard = getSelectedCard();
  if (state.winner || !selectedCard) {
    return;
  }
  const usesCounterEventWindow = Boolean(
    (state.counterEventWindow || state.destroyedEventWindow || state.enteredEventWindow) &&
      state.selected?.source === "hand" &&
      canUseCounterPlayCard(selectedCard),
  );
  if (!usesCounterEventWindow) {
    expireTransientResponseWindows();
  }
  if (state.selected?.source === "field") {
    await useFieldAbilityAction(selectedCard);
    return;
  }
  if (state.selected?.source === "drop") {
    // ドロップからの起動能力（墓場のDJ 0014 / ギシンギュウキ EB03/0002 等）。権威版の "use" 経路もここへ。
    await useDropAbilityAction(state.selected.owner, selectedCard);
    return;
  }
  if (state.selected?.source !== "hand") {
    return;
  }
  if (!validateCardCanBeUsedByOwner(state.selected.owner, selectedCard)) {
    return;
  }
  if (state.pendingAction) {
    await usePendingActionCounterCard(selectedCard);
    return;
  }
  if (state.pendingAttack) {
    await useCounterCard(selectedCard);
    return;
  }
  if (canUseCounterPlayCard(selectedCard)) {
    await useCounterPlayCard(selectedCard);
    expireTransientResponseWindows();
    return;
  }
  if (state.phase !== "main" && selectedCard.type !== "impact") {
    addLog("コール、装備、通常魔法の使用はメインフェイズでのみ行えます。");
    return;
  }
  if (selectedCard.type === "impact" && state.phase !== "final") {
    addLog("必殺技はファイナルフェイズでのみ使用できます。");
    return;
  }
  if (state.selected.owner !== state.active) {
    return;
  }
  if (hasKeyword(selectedCard, "arrival")) {
    await arriveCard(selectedCard);
    return;
  }
  const handAbility = findUsableHandAbility(selectedCard);
  if (handAbility) {
    await useHandAbilityAction(selectedCard, handAbility);
    return;
  }
  if (hasKnownHandAbility(selectedCard)) {
    addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner));
    return;
  }
  if (selectedCard.type === "item") {
    await equipItem(selectedCard);
    return;
  }
  if (selectedCard.type === "spell") {
    // preventControllerSpellUse: 場に本フラグを持つ自分のカードがあると魔法を使えない（騎甲竜王シュヴァリアス 0016）。
    if (controllerSpellUsePrevented(state.selected.owner)) {
      addLog("あなたは今、魔法を使えません。");
      return;
    }
    await castSpell(selectedCard);
    return;
  }
  if (selectedCard.type === "impact") {
    await castImpact(selectedCard);
  }
}

// 場に preventControllerSpellUse フラグを持つ自分のカードがあると、そのコントローラーは魔法を使えない（0016）。
function controllerSpellUsePrevented(owner) {
  return zones.some((zone) => {
    const card = state.players[owner]?.field?.[zone];
    return card?.preventControllerSpellUse && !isAbilitiesNullified(card);
  });
}

// この card を「追加アイテム」として（主枠を空けずに）装備できるか。
// 通常アイテムは1枚だが、装備中アイテムの allowExtraItemEquip か、この card 自身の allowExtraItemEquip が
// 相手側アイテムに一致する場合、空きスロットへ追加装備できる（虎の槍ペア 0019/0045 等）。
function canEquipAsExtraItem(player, card) {
  if (firstEmptyItemZone(player) === null) {
    return false; // 空きスロットが無い
  }
  const equipped = equippedItems(player);
  if (equipped.length === 0) {
    return false; // まだ1枚も装備していない → 通常装備（主枠）
  }
  const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const grantedByEquipped = equipped.some((it) =>
    asList(it.allowExtraItemEquip).some((rule) => matchesCardFilter(card, rule.filter || {})),
  );
  const grantedBySelf = asList(card.allowExtraItemEquip).some((rule) =>
    equipped.some((it) => matchesCardFilter(it, rule.filter || {})),
  );
  return grantedByEquipped || grantedBySelf;
}

// 共通: 既にソース(手札/ドロップ等)から取り出したカードをアイテムとして装備する。
// equipItem(手札からの通常装備) と script op useSelectedCard(ドロップからの装備) で共有。
async function equipCardDirect(player, card) {
  const owner = state.players.indexOf(player);
  let targetZone;
  if (canEquipAsExtraItem(player, card)) {
    // 追加アイテム: 主枠を空けず、空いているスロットへ装備する。
    targetZone = firstEmptyItemZone(player);
  } else {
    // 通常アイテム: 主枠(item)に装備。既に主枠が埋まっていれば装備変更 or ドロップ。
    if (player.field.item) {
      if (hasKeyword(card, "equipChange") && !player.oncePerTurn["equipChange"]) {
        player.hand.push(player.field.item);
        player.field.item = null;
        player.oncePerTurn["equipChange"] = true;
        addLog(`${card.name}の『装備変更』で装備中のアイテムを手札に戻しました。`);
      } else {
        dropFieldCardByRule(player, "item");
      }
    }
    targetZone = "item";
  }
  card.currentType = "item";
  player.field[targetZone] = card;
  if (card.destroyAtEndOfTurn) {
    card.destroyAtEndOfTurnOwner = owner;
  }
  player.arrivalCardId = null;
  await resolveOnEnter(card, player);
  addLog(`${player.name}は${card.name}を装備しました。`);
  // バディギフト: バディにできるアイテム(canBeBuddy)を自分のバディとして初めて場に出したとき、ライフ+1。
  if (card.canBeBuddy && isBuddyCard(player, card) && !player.partnerCalled) {
    player.partnerCalled = true;
    player.life += 1;
    addLog(`${player.name}はバディの${card.name}を装備し、バディギフトでライフを1回復しました。`);
  }
  // アイテム装備完了を場イベントとして通知（allyEquip/opponentEquip）。相手の装備に反応するカード（影鼬 0087）用。
  await runFieldEventTriggers("equip", owner, card, targetZone, {
    enteredCard: card,
    enteredZone: targetZone,
  });
}

// 共通: 既に取り出した設置(set)カードを設置ゾーンに配置する。
// resolvePendingSetSpell(通常設置) と script op useSelectedCard(ドロップからの設置) で共有。
async function placeSetSpellDirect(player, card, zone) {
  const owner = state.players.indexOf(player);
  card.currentType = card.type;
  player.field[zone] = card;
  addLog(`${player.name}は${card.name}を配置しました。`);
  await runFieldEventTriggers("set", owner, card, zone, {
    enteredCard: card,
    enteredZone: zone,
  });
}

async function equipItem(selectedCard) {
  const player = activePlayer();
  // 通常装備禁止（特定カードの能力経由のみ装備可。アクワルタ・グワルナフ等）。
  // 効果による装備(useSelectedCard→equipCardDirect)はこの制限を通さないためバイパスされる。
  if (selectedCard.equipOnlyByAbility) {
    addLog(`${selectedCard.name}は特定の能力からのみ装備できます。`);
    return;
  }
  if (
    selectedCard.equipConditions &&
    !checkCardConditions(selectedCard.equipConditions, state.active)
  ) {
    addLog(`${selectedCard.name}の装備条件を満たしていません。`);
    return;
  }
  const payment = await payCardCostWithSelection(player, selectedCard, "equip", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  // 装備も対抗確認を挟む（コール/呪文/起動能力と同様）。相手が対抗を使わなければ解決で装備が確定。
  beginPendingAction({
    kind: "equip",
    owner: state.active,
    responder: 1 - state.active,
    card,
    phase: state.phase,
  });
  addLog(`${player.name}は${card.name}の装備を宣言しました。対抗確認を行ってください。`);
  render();
}

async function arriveCard(selectedCard) {
  const player = activePlayer();
  const ability = findKeywordAbility(selectedCard, "arrival");
  const payment = await payStructuredCostWithSelection(player, ability?.cost || selectedCard.costs?.arrival || [], {
    sourceCard: selectedCard,
    selectedCard,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  if (player.field.item) {
    dropFieldCardByRule(player, "item");
  }
  const card = removeSelectedFromHand();
  card.currentType = "item";
  card.arrived = true;
  player.field.item = card;
  if (card.destroyAtEndOfTurn) {
    card.destroyAtEndOfTurnOwner = state.active;
  }
  player.arrivalCardId = card.instanceId;
  state.selected = null;
  state.phase = "main";
  state.linkAttackers = [];
  addLog(`${player.name}は${card.name}を着任しました。`);
  render();
}

async function castSpell(selectedCard) {
  if (hasKeyword(selectedCard, "set")) {
    await castSetSpell(selectedCard);
    return;
  }
  const ability = findUsableHandAbility(selectedCard);
  if (ability) {
    await useHandAbilityAction(selectedCard, ability);
    return;
  }
  if (selectedCard.name === "ウープス！") {
    await castOops(selectedCard);
    return;
  }
  if (hasKnownHandAbility(selectedCard)) {
    addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner));
    return;
  }
  addLog("このカードの使用処理はまだ実装されていません。");
}

function hasKnownHandAbility(card) {
  return (card?.abilities || []).some((ability) => canUseAbilityFromHand(ability));
}

function handAbilityUnavailableReason(card, owner, options = {}) {
  const abilities = (card?.abilities || []).filter((ability) => canUseAbilityFromHand(ability));
  if (abilities.length === 0) {
    return "このカードの使用処理はまだ実装されていません。";
  }
  const ability = abilities[0];
  if (!handAbilityTimingMatches(ability, options)) {
    if (isCounterAbility(ability)) {
      return `${card.name}は【対抗】で使うカードです。`;
    }
    return `${card.name}は今のフェイズでは使えません。`;
  }
  if (isAbilityLimitUsed(owner, card, ability)) {
    const limit = normalizedAbilityLimit(ability);
    if (limit?.scope === "turn") {
      return `${card.name}はこのターンすでに使っています。`;
    }
    if (limit?.scope === "fight") {
      return `${card.name}はこのファイト中すでに使っています。`;
    }
    return `${card.name}は使用回数制限により使えません。`;
  }
  if (!checkAbilityConditions(ability, owner)) {
    return `${card.name}の使用条件を満たしていません。`;
  }
  if (ability.target && targetCandidatesFromSpec(ability.target, owner, { card, ability }).length === 0) {
    return `${card.name}の対象にできるカードがありません。`;
  }
  const player = state.players[owner];
  const costSteps = adjustedCostSteps(
    player,
    card,
    abilityCostPurpose(ability),
    abilityCostSteps(card, ability),
  );
  const canPay = canPayStructuredCost(player, costSteps, {
    sourceCard: card,
    selectedCard: card,
    allowInteractiveSelection: true,
  });
  if (!canPay.ok) {
    return canPay.reason;
  }
  return `${card.name}は現在の状態では使えません。`;
}

async function castSetSpell(selectedCard) {
  const player = activePlayer();
  if (!checkCardConditions(selectedCard.useConditions || [], state.active, { card: selectedCard, owner: state.active })) {
    addLog(`${selectedCard.name}の使用条件を満たしていません。`);
    return;
  }
  const zone = setZones.find((candidate) => !player.field[candidate]);
  if (!zone) {
    addLog("配置魔法ゾーンが空いていません。");
    return;
  }
  if (selectedCard.uniqueSet && setZones.some((candidate) => player.field[candidate]?.id === selectedCard.id)) {
    addLog(`${selectedCard.name}はすでに配置されています。`);
    return;
  }
  if ((player.setLockedIdsThisTurn || []).includes(selectedCard.id)) {
    addLog(`${selectedCard.name}はそのターン中は設置できません。`);
    return;
  }
  const payment = await payCardCostWithSelection(player, selectedCard, "cast", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  beginPendingAction({
    kind: "setSpell",
    owner: state.active,
    responder: 1 - state.active,
    card,
    phase: state.phase,
    zone,
  });
  addLog(`${player.name}は${card.name}の配置を宣言しました。対抗確認を行ってください。`);
  render();
}

async function useCounterPlayCard(selectedCard) {
  const ability = findUsableHandAbility(selectedCard, { counterOnly: true });
  if (!ability) {
    if (hasKnownHandAbility(selectedCard)) {
      addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner, { counterOnly: true }));
      return;
    }
    addLog("このタイミングで使える【対抗】能力ではありません。");
    return;
  }
  await useHandAbilityAction(selectedCard, ability);
}

function canUseCounterPlayCard(selectedCard) {
  return Boolean(
    !state.pendingAttack &&
      state.selected?.source === "hand" &&
      selectedCard &&
      isCounterPlayTiming() &&
      findUsableHandAbility(selectedCard, { counterOnly: true }),
  );
}

async function castOops(selectedCard) {
  const owner = state.selected.owner;
  const player = state.players[owner];
  const ability = (selectedCard.abilities || []).find((candidate) => candidate.id === "oops-counter");
  if (!ability || !canUseOopsTiming()) {
    addLog("ウープス！は【対抗】で使うカードです。");
    return;
  }
  const target = await chooseAbilityTarget(selectedCard, ability, owner);
  if (!target) {
    addLog("ウープス！で手札に戻す場のカードを選んでください。");
    return;
  }
  const costSteps = adjustedCostSteps(player, selectedCard, "cast", abilityCostSteps(selectedCard, ability));
  const payment = await payStructuredCostWithSelection(player, costSteps, {
    sourceCard: selectedCard,
    selectedCard,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  player.drop.push(card);
  if (state.pendingAttack || state.pendingAction) {
    markCounterUsed(owner, selectedCounterKind(card));
  }
  addLog(`${player.name}は${card.name}を【対抗】で使いました。`);
  await executeAbilityBody({
    card,
    ability,
    player,
    owner,
    target,
  });
  state.selected = null;
  state.linkAttackers = [];
  render();
}

function canUseOopsTiming() {
  return Boolean(state.pendingAttack || state.pendingAction || isCounterPlayTiming());
}


async function castImpact(selectedCard) {
  if (hasKeyword(selectedCard, "set")) {
    await castSetSpell(selectedCard);
    return;
  }
  const player = activePlayer();
  const ability = findUsableHandAbility(selectedCard);
  if (ability) {
    await useHandAbilityAction(selectedCard, ability);
    return;
  }
  if (hasKnownHandAbility(selectedCard)) {
    addLog(handAbilityUnavailableReason(selectedCard, state.players.indexOf(player)));
    return;
  }
  addLog("この必殺技の処理はまだ実装されていません。");
}

async function useCounterCard(selectedCard) {
  const caster = state.players[state.selected.owner];
  if (!canUseCounterEffect(state.selected.owner, selectedCard.effect || selectedCounterKind(selectedCard))) {
    addLog("2018年6月以前ルールでは、この攻撃中に使える【対抗】は各ファイター1回までです。ドラゴエナジーのみ、カード指定により複数使用できます。");
    return;
  }
  if (isMagicalGoodbyeCard(selectedCard)) {
    await useMagicalGoodbyeCounterCard(selectedCard, caster);
    return;
  }
  const ability = findUsableHandAbility(selectedCard);
  if (ability) {
    await useHandAbilityAction(selectedCard, ability, {
      counterKind: selectedCounterKind(selectedCard),
      counterTiming: true,
    });
    return;
  }
  if (selectedCard.name === "ウープス！") {
    await castOops(selectedCard);
    return;
  }
  if (hasKnownHandAbility(selectedCard)) {
    addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner));
    return;
  }
  addLog("このカードは今の攻撃中に使えるカウンターではありません。");
}

async function usePendingActionCounterCard(selectedCard) {
  const action = state.pendingAction;
  const owner = state.selected?.owner;
  if (!action || owner !== action.responder) {
    addLog("この行動への対抗は、相手側だけが使えます。");
    return;
  }
  if (!canUseCounterEffect(owner, selectedCounterKind(selectedCard))) {
    addLog("2018年6月以前ルールでは、この行動への【対抗】は各ファイター1回までです。");
    return;
  }
  if (isMagicalGoodbyeCard(selectedCard)) {
    await useMagicalGoodbyeCounterCard(selectedCard, state.players[owner]);
    return;
  }
  const ability = findUsableHandAbility(selectedCard, { counterOnly: true });
  if (!ability) {
    if (selectedCard.name === "ウープス！") {
      await castOops(selectedCard);
      return;
    }
    if (hasKnownHandAbility(selectedCard)) {
      addLog(handAbilityUnavailableReason(selectedCard, owner, { counterOnly: true }));
      return;
    }
    addLog("この行動に対して使える【対抗】能力ではありません。");
    return;
  }
  await useHandAbilityAction(selectedCard, ability, {
    counterKind: selectedCounterKind(selectedCard),
    counterTiming: true,
  });
}

function selectedCounterKind(card) {
  // counterKind 宣言を最優先（dragoenergy は desugar で counterKind="dragoenergy" を付与）。
  // 旧 id/effect 直書きは廃止し、データ駆動の宣言フィールドへ一般化した。
  if (card?.counterKind) {
    return card.counterKind;
  }
  return hasKeyword(card, "reversal") ? "reversal" : "other";
}

function isMagicalGoodbyeCard(card) {
  return (card?.abilities || []).some((ability) => ability.id === "magical-goodbye-counter");
}

function magicalGoodbyeAbility(card) {
  return (card?.abilities || []).find((ability) => ability.id === "magical-goodbye-counter");
}

function canUseMagicalGoodbye(owner, card) {
  const ability = magicalGoodbyeAbility(card);
  return Boolean(
    ability &&
      handAbilityTimingMatches(ability) &&
      checkAbilityConditions(ability, owner) &&
      targetCandidatesFromSpecForOwner(ability.target, owner, { card, ability }).length > 0,
  );
}

async function useMagicalGoodbyeCounterCard(selectedCard, caster) {
  const owner = state.selected.owner;
  const ability = magicalGoodbyeAbility(selectedCard);
  if (!ability || !handAbilityTimingMatches(ability)) {
    addLog(`${selectedCard.name}はこのタイミングでは使えません。`);
    return;
  }
  if (!checkAbilityConditions(ability, owner)) {
    addLog(`${selectedCard.name}の使用条件を満たしていません。`);
    return;
  }
  const targets = targetCandidatesFromSpecForOwner(ability.target, owner, { card: selectedCard, ability });
  if (targets.length === 0) {
    addLog(`${selectedCard.name}で手札に戻せるサイズ2以下のモンスターが場にありません。`);
    return;
  }
  const selected = await chooseCardEntries(targets, {
    title: `${selectedCard.name}の対象`,
    lead: "手札に戻すサイズ2以下のモンスターを選んでください。",
    min: 1,
    max: 1,
    forceDialog: true,
  });
  const target = selected?.[0];
  if (!target) {
    addLog(`${selectedCard.name}の対象を選んでください。`);
    return;
  }
  const payment = await payStructuredCostWithSelection(caster, ability.cost || [], {
    sourceCard: selectedCard,
    selectedCard,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const usedCard = removeSelectedFromHand();
  if (!usedCard) {
    addLog(`${selectedCard.name}が手札にありません。`);
    return;
  }
  caster.drop.push(usedCard);
  if (hasPendingResolution()) {
    markCounterUsed(owner, selectedCounterKind(usedCard));
  }
  addLog(`${caster.name}は${usedCard.name}を【対抗】で使いました。`);
  returnFieldTargetToHand(target, usedCard.name);
  markAbilityLimit(owner, usedCard, ability);
  state.selected = null;
  state.linkAttackers = [];
  render();
}

// 場を離れて手札/山札へ移るカードは、場依存の一時状態（レスト/戦闘・ターン修整/付与キーワード/変身状態等）を失う。
// これをリセットしないと、レスト状態のまま手札に戻ったカードが再コール時もレストのまま＝攻撃できない等の不整合が起きる
// （ブーメラン・ドラゴン等、バトル終了時に自身を手札へ戻すカードで顕在化）。
function resetLeftFieldCardState(card) {
  if (!card) {
    return;
  }
  card.used = false;
  card.battlePowerBonus = 0;
  card.battleDefenseBonus = 0;
  card.battleCriticalBonus = 0;
  card.turnPowerBonus = 0;
  card.turnDefenseBonus = 0;
  card.turnCriticalBonus = 0;
  card.temporaryKeywords = [];
  card.turnKeywords = [];
  card.turnSuppressedKeywords = [];
  card.counterattack = false;
  card.doubleAttackUsed = false;
  card.preventNextDestroyCount = 0;
  card.preventNextDestroyEffects = [];
  card.additionalNames = [];
  card.destroyReaction = null;
  card.scheduledStatBonus = [];
  card.conditionalSize = null;
  card.currentType = card.baseType || card.type;
}

function returnFieldTargetToHand(target, sourceName = "効果") {
  const ownerPlayer = state.players[target.owner];
  const returned = ownerPlayer?.field[target.zone];
  if (!returned) {
    addLog(`${sourceName}の対象はすでに場にありません。`);
    return null;
  }
  if (cannotReturnToHand(returned)) {
    addLog(`${returned.name}は手札に戻せません。`);
    return null;
  }
  ownerPlayer.drop.push(...(returned.soul || []));
  returned.soul = [];
  ownerPlayer.field[target.zone] = null;
  if (target.zone === "item" && ownerPlayer.arrivalCardId === returned.instanceId) {
    ownerPlayer.arrivalCardId = null;
  }
  resetLeftFieldCardState(returned);
  ownerPlayer.hand.push(returned);
  applyLifeLink(returned, target.owner);
  addLog(`${sourceName}で${returned.name}を手札に戻しました。`);
  handleDestroyedDuringPending({ owner: target.owner, zone: target.zone });
  // 「場のモンスターが手札に戻った時」誘発（D・R・システム等）。発生源は既に場から外れている。
  queueMonsterReturnedTriggers(returned, target.owner, target.zone);
  return returned;
}


// ==========================================================================
// buddyfight モジュール 08 — カード使用(呪文/アイテム/インパクト/対抗/着任)
// 旧 app.js L2807-3326 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
async function useCardAction() {
  // R-BR4(ブラウザレビュー eb01-B2 発見・R-BR2 の拡張): クリック起点アクションの検証失敗パス
  // （castSetSpell の uniqueSet/ゾーン満杯、equipItem/castSpell/castImpact のコスト不足・条件不成立 等）は
  // addLog だけして早期 return し render() を呼ばないため、理由が画面 #logList に出ず「無反応」に見えた。
  // src/08 内に同型が多数あるため個別 render ではなく単一の finally で確実に画面へ反映する（表示のみ・
  // 検証失敗は state 未変更なので安全・成功パスの二重 render は冪等で無害）。src/13 側は R-BR2 で対応済み。
  try {
    return await useCardActionImpl();
  } finally {
    if (typeof render === "function") {
      render();
    }
  }
}

async function useCardActionImpl() {
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
  if (canUseCounterPlayCard(selectedCard) && !hasMainAndCounterHandChoice(selectedCard)) {
    // 「今この瞬間に main 能力と counter 能力の両方が使える」1枚（X-BT02/0013 支配者の特権 等の
    // 「次の2つから1つを選んで使う。・…／・【対抗】…」型）は、counter 最優先ショートカットを取らず
    // 下流の findUsableHandAbilities チューザ（下記）に選ばせる。片方だけ使える通常の対抗札はここで単一発火。
    await useCounterPlayCard(selectedCard);
    expireTransientResponseWindows();
    return;
  }
  if (state.phase !== "main" && selectedCard.type !== "impact") {
    // F8(D-SS03/0020 革命者ゼータ『必殺変身』): timing が現在フェイズを明示する手札起動能力
    // （timing:["final"] 等）はメイン外でも使える。timing 省略＝メイン扱いの通常魔法/起動は
    // 従来どおりこのゲートで止める。非カウンター能力は自分の手番のみ（メイン経路の active 検査と同等）。
    if (state.selected.owner === state.active) {
      const phaseAbility = findUsableHandAbility(selectedCard, { explicitPhase: state.phase });
      if (phaseAbility) {
        await useHandAbilityAction(selectedCard, phaseAbility);
        return;
      }
      if (hasExplicitPhaseHandAbility(selectedCard, state.phase)) {
        // 該当フェイズ明示の能力はあるが今は使えない（回数制限/条件/コスト等）→ 具体的な理由を出す。
        addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner, { explicitPhase: state.phase }));
        return;
      }
    }
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
  // 手札から使える能力を「全件」集める。複数あれば選択、1件は即実行（変身/搭乗の装備と別の起動能力が
  // 同時に使えるカード対応）。0件でも、下記の装備/魔法/必殺技の本来のアクションは遮らない。
  const handAbilities = findUsableHandAbilities(selectedCard);
  if (handAbilities.length > 0) {
    const handAbility =
      handAbilities.length === 1
        ? handAbilities[0]
        : await chooseHandAbility(selectedCard, handAbilities, state.selected.owner);
    if (handAbility) {
      await useHandAbilityAction(selectedCard, handAbility);
    }
    return;
  }
  // 使える手札能力が0件の場合: 「既知だが今使えない能力」（例: メイン中の対抗限定変身＝条件不成立）で
  // 装備/魔法/必殺技の本来のアクションを遮らない。まず本来のアクションを試し、それも無い時だけ
  // 最後に「使えない理由」を出す（下の hasKnownHandAbility ブロック）。
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
  if (selectedCard.type !== "impact") {
    // 装備/魔法/必殺技のいずれでもない（例: 手札の対抗限定変身しか持たないモンスターをメインで押した）。
    // 下流アクションが無いので、既知だが使えない能力の理由を説明して終わる（従来挙動）。
    if (hasKnownHandAbility(selectedCard)) {
      addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner));
    }
    return;
  }
  await castImpact(selectedCard);
  // Z6(S-UB-C03/0054): endFinalPhase効果op(15-ability-effects.js)が立てた state.pendingEndTurn を、
  // カード使用の解決が完全にアンワインドしたこの地点で消費してターンを終える。必殺技はファイナルフェイズ
  // でのみ使用できる(上のcastImpact到達条件)ため、この時点でstate.phaseは既に"final"のはず。
  if (state.pendingEndTurn) {
    state.pendingEndTurn = false;
    if (!state.winner && !hasPendingResolution() && state.phase === "final") {
      await endTurn();
    }
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
async function equipCardDirect(player, card, options = {}) {
  const owner = state.players.indexOf(player);
  let targetZone;
  // E-XB53(X-CBT02/0062 選ばれし者へ「《英雄》のアイテム2枚までを装備」): options.allowExtra は既存装備がある
  // かぎり主枠を奪わず空きスロットへ並存装備させる（canEquipAsExtraItem/allowExtraItemEquip 機構の一時流用＝
  // 印字ルール付与を待たずこの装備1回だけ追加枠扱いにする）。1枚目は equippedItems 0＝主枠、2枚目以降が追加枠。
  const useExtraSlot =
    canEquipAsExtraItem(player, card) ||
    (options.allowExtra && equippedItems(player).length > 0 && firstEmptyItemZone(player) !== null);
  if (useExtraSlot) {
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
  await resolveOnEnter(card, player, null, { byEffect: Boolean(options.byEffect) });
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
  const deckBeforeCost = player.deck.length;
  const lifeBeforeCost = player.life;
  const payment = await payCardCostWithSelection(player, selectedCard, "equip", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  // 非同期誘発レースで選択カードが手札を離れていたら宣言中止（callMonster と同型・fuzzer seed915）。
  if (!card) {
    addLog(`${selectedCard.name}が手札にないため、装備を中止しました。`);
    return;
  }
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
  // 保存則: 装備コストの damageSelf 等でこの宣言と同時に決着した場合、pending を宙吊りにせず即着地させる
  // （fuzzer 恒久漏れ・seed337/722「五角竜剣 王牙」「吸血剣 ブラッディフェイト」）。詳細は src/07 の同ヘルパー参照。
  await resolveDeclarationIfGameEnded(deckBeforeCost, lifeBeforeCost, player);
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
  // 非同期誘発レースで選択カードが手札を離れていたら着任中止（callMonster と同型・fuzzer seed915）。
  if (!card) {
    addLog(`${selectedCard.name}が手札にないため、着任を中止しました。`);
    return;
  }
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
  // E-XB49①(X-CBT01/0008 逆天戦艦 サツキG「君が『着任』した時、〜」): 着任を場イベントとして配信する。
  // 攻撃(runAttackDeclarationTriggers)と同じ慣例＝着任カード自身へ event:"arrived"、場全体へ allyArrived/opponentArrived。
  // リスナー（triggered ability の event:"arrived"/"allyArrived"）が無い既存カードは空振り＝挙動不変。
  await runTriggeredAbilities(card, "arrived", { card, player, owner: state.active, zone: "item" });
  await runFieldEventTriggers("arrived", state.active, card, "item");
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

// F8: timing が指定フェイズを明示する手札起動能力を持つか（非メインフェイズの useCardAction ゲート用）。
function hasExplicitPhaseHandAbility(card, phase) {
  return (card?.abilities || []).some(
    (ability) => canUseAbilityFromHand(ability) && (ability.timing || []).includes(phase),
  );
}

function handAbilityUnavailableReason(card, owner, options = {}) {
  const abilities = (card?.abilities || []).filter((ability) => canUseAbilityFromHand(ability));
  if (abilities.length === 0) {
    return "このカードの使用処理はまだ実装されていません。";
  }
  // F1: カードレベルの useConditions 不成立（findUsableHandAbility と同じゲート）を先に報告する。
  if (!checkCardConditions(card.useConditions || [], owner, { card, owner })) {
    return `${card.name}の使用条件を満たしていません。`;
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
  if (selectedCard.uniqueSet && setZones.some((candidate) => player.field[candidate]?.name === selectedCard.name)) { // レビュー修正(D-BT01/0066): 「1枚だけ設置できる」は同名制限（再録混載でも1枚）
    addLog(`${selectedCard.name}はすでに配置されています。`);
    return;
  }
  if ((player.setLockedIdsThisTurn || []).includes(selectedCard.id)) {
    addLog(`${selectedCard.name}はそのターン中は設置できません。`);
    return;
  }
  const deckBeforeCost = player.deck.length;
  const lifeBeforeCost = player.life;
  const payment = await payCardCostWithSelection(player, selectedCard, "cast", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  // 非同期誘発レースで選択カードが手札を離れていたら配置中止（callMonster と同型・fuzzer seed915）。
  if (!card) {
    addLog(`${selectedCard.name}が手札にないため、配置を中止しました。`);
    return;
  }
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
  // 保存則: 設置コストの putTopDeckToDrop 等でこの宣言と同時に決着した場合、pending を宙吊りにせず即着地させる
  // （callMonster/equipItem と同型）。詳細は src/07 の resolveDeclarationIfGameEnded 参照。
  await resolveDeclarationIfGameEnded(deckBeforeCost, lifeBeforeCost, player);
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

// 「次の2つから1つを選んで使う。・…（main）／・【対抗】…（counter）」型の手札カードで、今この瞬間に
// main 能力と counter 能力の両方が使えるか。true なら useCardAction は canUseCounterPlayCard の
// counter 最優先ショートカットを止め、下流の findUsableHandAbilities チューザ（chooseHandAbility）へ委ねて
// 選ばせる——「場の起動能力が複数なら選ばせる」(findUsableFieldAbilities) と同じ規則の手札版。
// 手番プレイヤー（owner===active）の自分のプレイ窓に限定する: 手札の非対抗能力（通常魔法/起動）は
// 下流 useCardAction の owner===active ゲートで自分の手番でしか使えないため、相手手番の対抗窓では main は
// 実際には使えず、そこでチューザを出すと単発クリックの対抗が不発になる（byte互換のため非能動側は従来経路）。
function hasMainAndCounterHandChoice(selectedCard) {
  if (state.selected?.owner !== state.active) {
    return false;
  }
  const abilities = findUsableHandAbilities(selectedCard);
  return (
    abilities.some((ability) => isCounterAbility(ability)) &&
    abilities.some((ability) => !isCounterAbility(ability))
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
  // 非同期誘発レースで選択カードが手札を離れていたら使用中止（callMonster と同型・fuzzer seed915）。
  if (!card) {
    addLog(`${selectedCard.name}が手札にないため、使用を中止しました。`);
    return;
  }
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
    promptSeat: owner, // 使用者の席へ（CPU対戦/権威サーバの誤配送防止）
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
  // E-PR11(PR/0389)/E-PR12(PR/0381): そのターン中だけ付与した一時トリガー能力/攻撃耐性を離場時に解除
  //（turnKeywords と同寿命。手札/デッキ/ゲージ帰還など resetLeftFieldCardState を通る離場で消える）。
  card.grantedTempAbilities = [];
  card.grantedTempAttackResistances = [];
  // E-PR15(PR/0461): そのターン中だけ付与した一時ワールド名を離場時に解除（turnKeywords と同寿命）。
  card.turnWorlds = [];
  // E-PR17(PR/0478): そのターン中だけ付与した一時破壊耐性を離場時に解除（turnKeywords と同寿命）。
  card.grantedTempDestroyImmunities = [];
  card.counterattack = false;
  card.doubleAttackUsed = false;
  card.preventNextDestroyCount = 0;
  card.preventNextDestroyEffects = [];
  // gainNameAsSelected（ターンスコープの追加カード名）は場を離れたら失うが、印字の恒久additionalNames
  // (0022の「武神竜王 デュエルズィーガー」等)はベースライン(printedAdditionalNames)へ復元し消さない。
  card.additionalNames = [...(card.printedAdditionalNames || [])];
  card.destroyReaction = null;
  card.scheduledStatBonus = [];
  card.conditionalSize = null;
  // G5(D-EB01/0023): 「場を離れるまで」付与されたファイナル攻撃可フラグを離場時に解除する
  // （conditionalSize と同じ「場在中のみ」寿命。印字カードは type/canAttackInFinalPhase 側で判定するため無関係）。
  card.grantedFinalPhaseAttack = false;
  card.currentType = card.baseType || card.type;
  // r3 L4(S-UB-C03/0066): 裏向きトークン化(faceDownMonster)による印字値の恒久上書きも、
  // 場を離れたタイミングで印字値へ復元する（restoreFaceDownMonsterPrintがno-opガード付き）。
  restoreFaceDownMonsterPrint(card);
}

function returnFieldTargetToHand(target, sourceName = "効果", details = {}) {
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
  // Z9(S-UB-C03/0072): 「次に場から離れる場合、そのカードを場に残す」。
  if (returned.preventNextLeaveFieldCount > 0) {
    returned.preventNextLeaveFieldCount -= 1;
    addLog(`${returned.name}は効果により場に残りました。`);
    return null;
  }
  // X9(D-BT01/0131): コスト付き離場置換（単体の手札戻しもカバー）。
  if (tryLeaveFieldReplacementSync(returned, target.owner)) {
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
  // Z14(b)(S-UB-C03/0017): details.returnCause があれば伝播（「君のカードの効果で」判定用）。
  queueMonsterReturnedTriggers(returned, target.owner, target.zone, details);
  // E-XV6(X-UB02/0015): 戻ったカード自身の「このカードが手札に戻った時」自己誘発（場→手札の単体 funnel。
  // 効果 returnToHand/returnSelfToHand(場)・コスト returnPendingTargetToHand・破壊置換の手札戻しを全て被覆）。
  queueReturnedToHandTriggers(returned, target.owner, "field");
  return returned;
}


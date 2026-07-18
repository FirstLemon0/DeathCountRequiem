// ==========================================================================
// buddyfight モジュール 13 — 能力探索・使用・条件判定
// 旧 app.js L5706-6486 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
// 手札から今使える能力を「すべて」返す（変身/搭乗の装備と別の起動/対抗が同時に使える等、複数ある時は
// useCardAction が選択させる。findUsableFieldAbilities の手札版）。単数形 findUsableHandAbility は先頭を返す薄いラッパ。
function findUsableHandAbilities(card, options = {}) {
  // F1(D-EB02): カードレベルの useConditions（「〜なら使える」）を通常の手札キャスト経路でも評価する。
  // 従来は castSetSpell（設置・src/08）でのみ評価され、通常の魔法/必殺技/対抗では無視されていた
  //（bf-s-ub-c03-0052/0053/0054/0093 のゲートが不発だった）。全手札キャスト経路
  //（useCardAction/castSpell/castImpact/useCounterCard/useCounterPlayCard/render/AI）はここを通る。
  const useOwner = state.selected?.owner ?? state.active;
  if (!checkCardConditions(card.useConditions || [], useOwner, { card, owner: useOwner })) {
    return [];
  }
  return (card.abilities || []).filter((ability) => {
    if (!canUseAbilityFromHand(ability)) {
      return false;
    }
    if (ability.fromFieldOnly) {
      return false;
    }
    if (ability.fromSoulOnly) {
      return false;
    }
    if (!handAbilityTimingMatches(ability, options)) {
      return false;
    }
    if (isAbilityLimitUsed(state.selected.owner, card, ability)) {
      return false;
    }
    if (ability.target && !ability.target.allowMissingTarget && targetCandidatesFromSpec(ability.target, state.selected.owner, { card, ability }).length === 0) {
      return false;
    }
    return (
      checkAbilityConditions(ability, state.selected.owner) &&
      canSatisfyAbilityScript(card, ability, state.selected.owner)
    );
  });
}

// 互換: 従来の単数形は先頭候補を返す（内部委譲。全既存呼び出し元はこれを使い続けられる）。
function findUsableHandAbility(card, options = {}) {
  return findUsableHandAbilities(card, options)[0];
}

// 手札のカードに使える能力が複数ある時、どれを使うか選ばせる（場の chooseFieldAbility の手札版）。
// 例: 変身/搭乗の装備と、別の起動能力が同時に使えるカード。ラベルは fieldAbilityLabel を共有し、
// equipSelf 系は「このカードを装備する（変身／搭乗）」・その他は ability.label/名前を出す。
async function chooseHandAbility(card, abilities, owner = state.selected?.owner ?? state.active) {
  if (globalThis.__BUDDYFIGHT_TEST__ && typeof globalThis.__forcedHandAbilityId === "string") {
    return abilities.find((ability) => ability.id === globalThis.__forcedHandAbilityId) || abilities[0];
  }
  const selected = await chooseCardEntries(
    abilities.map((ability) => ({
      ability,
      card: {
        name: fieldAbilityLabel(card, ability),
        type: "choice",
      },
    })),
    {
      title: `${card.name}の能力`,
      lead: "使う能力を選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
      allowCancel: true,
      purpose: "ability-pick", // CPU対戦(src/22): 先頭選択で解決＝無限ループしない
      promptSeat: owner,
    },
  );
  return selected?.[0]?.ability || null;
}

function canUseAbilityFromHand(ability) {
  if (!ability || ability.fromFieldOnly || ability.fromSoulOnly) {
    return false;
  }
  if (["spell", "impact"].includes(ability.kind)) {
    return true;
  }
  return ability.kind === "activated" && ability.fromHandOnly;
}

function handAbilityTimingMatches(ability, options = {}) {
  if (options.counterOnly) {
    return isCounterAbility(ability) && (isCounterPlayTiming() || Boolean(state.pendingAction || state.pendingAttack));
  }
  if (state.pendingAction) {
    return isCounterAbility(ability);
  }
  if (state.pendingAttack) {
    return isCounterAbility(ability);
  }
  // F8(D-SS03/0020 『必殺変身』): explicitPhase 指定時は「timing がそのフェイズを明示する」能力のみ真。
  // 非メインフェイズの useCardAction 経路が使う——timing 省略（＝メイン扱い）の魔法/起動能力を
  // メイン外で誤って通さないための限定モード。対抗系は上の pending 分岐と通常経路が従来どおり担う。
  if (options.explicitPhase) {
    return (ability.timing || []).includes(options.explicitPhase);
  }
  return abilityTimingIncludes(ability, state.phase) || (isCounterAbility(ability) && isCounterPlayTiming());
}

function isCounterAbility(ability) {
  return abilityTimingIncludes(ability, "counter");
}

// 条件 op "sourceIsBuddy": このカード（条件評価の主体）がバディモンスターか。
// 登録バディとの同名判定（isBuddyCard）に加え、treatAsBuddyThisTurn の一時付与（turnTreatAsBuddy）も真とする。
function sourceIsBuddyCondition(owner, context) {
  const card = context?.card;
  if (!card) {
    return false;
  }
  if (card.turnTreatAsBuddy) {
    return true;
  }
  return isBuddyCard(state.players[owner], card);
}

function isCounterOnlyHandCard(card) {
  const handAbilities = (card?.abilities || []).filter((ability) => canUseAbilityFromHand(ability));
  return handAbilities.length > 0 && handAbilities.every((ability) => isCounterAbility(ability));
}

function abilityCostPurpose(ability) {
  if (["spell", "impact"].includes(ability?.kind)) {
    return "cast";
  }
  return ability?.kind || "cast";
}

function abilityCostSteps(card, ability) {
  const purpose = abilityCostPurpose(ability);
  return ability?.cost || card?.costs?.[purpose] || [];
}

function isCounterPlayTiming() {
  return !hasPendingResolution() && ["draw", "charge", "main", "attack", "final"].includes(state.phase);
}

async function useHandAbilityAction(card, ability, options = {}) {
  const owner = state.selected.owner;
  const player = state.players[owner];
  const target = await targetForAbilityUse(card, ability, owner);
  if (ability.target && !target && !ability.target.allowMissingTarget && !ability.allowMissingTarget) {
    // allowMissingTarget（対象0でも使用可・後段効果だけ解決する宣言的フラグ。finder側 src/13:23 と対）
    // が無い場合のみ、対象未選択で中断する。
    addLog(`${card.name}の対象を選んでください。`);
    return;
  }
  const costSteps = adjustedCostSteps(
    player,
    card,
    abilityCostPurpose(ability),
    abilityCostSteps(card, ability),
  );
  const deckBeforeCost = player.deck.length;
  const lifeBeforeCost = player.life;
  const payment = await payStructuredCostWithSelection(player, costSteps, {
    sourceCard: card,
    selectedCard: card,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const usedCard = removeSelectedFromHand();
  // 非同期誘発レースで選択カードが手札を離れていたら使用中止（callMonster と同型・fuzzer seed915）。
  if (!usedCard) {
    addLog(`${card.name}が手札にないため、使用を中止しました。`);
    return;
  }
  if (!options.counterTiming && ["spell", "impact"].includes(ability.kind)) {
    markAbilityLimit(owner, usedCard, ability);
    beginPendingAction({
      kind: ability.kind,
      owner,
      responder: 1 - owner,
      card: usedCard,
      ability,
      phase: state.phase,
      // E-PR6(PR/0281 ルア・ノヴァ): 使用コストで捨てたカードを解決時の条件(costDiscardedCardMatches)へ渡す。
      costDiscardedCards: payment.discarded || [],
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : elements.effectTarget.value,
    });
    addLog(`${player.name}は${usedCard.name}の使用を宣言しました。対抗確認を行ってください。`);
    render();
    // 保存則: 使用コストの putTopDeckToDrop で山切れ／自傷でライフ0 等でこの宣言と同時に決着した場合、pending を
    // 宙吊りにせず即着地させる（fuzzer 恒久漏れ・seed51「シャドウ・クルセイダー」）。詳細は src/07 の同ヘルパー参照。
    await resolveDeclarationIfGameEnded(deckBeforeCost, lifeBeforeCost, player);
    return;
  }
  // 手札発動の起動能力（変身/搭乗の hand版 等、kind:"activated"）も宣言時に相手へ対抗機会を与える。
  // 場発動(useFieldAbilityAction)は既に対抗ウィンドウを開くが、手札発動は spell/impact 以外で
  // 即解決していた（＝変身時に対抗確認が出ない）ため、activated も pendingAction 経由にする。
  // fromHand で resolvePendingAbility 側がカードのドロップ着地/ロールバックを扱う。
  if (
    !options.counterTiming &&
    ability.kind === "activated" &&
    !isCounterAbility(ability) &&
    !ability.noCounterWindow && // E-XB56②: 「相手は【対抗】できず」= 宣言時に対抗ウィンドウを開かず即時解決へ落とす（下の即時解決経路が後続処理を担う）。未指定は従来どおり。
    !hasPendingResolution()
  ) {
    markAbilityLimit(owner, usedCard, ability);
    beginPendingAction({
      kind: "ability",
      owner,
      responder: 1 - owner,
      card: usedCard,
      ability,
      phase: state.phase,
      fromHand: true,
      costDiscardedCards: payment.discarded || [], // E-PR6: 手札発動起動能力でも使用コストの捨て札を解決へ伝播
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : elements.effectTarget.value,
    });
    addLog(`${player.name}は${usedCard.name}の能力を宣言しました。対抗確認を行ってください。`);
    render();
    // 保存則: 手札発動(変身/搭乗等)のコストでこの宣言と同時に決着した場合も pending を宙吊りにせず即着地させる。
    await resolveDeclarationIfGameEnded(deckBeforeCost, lifeBeforeCost, player);
    return;
  }
  player.drop.push(usedCard);
  if (options.counterKind) {
    markCounterUsed(owner, options.counterKind);
  }
  if (options.counterTiming) {
    addLog(`${player.name}は${usedCard.name}を【対抗】で使いました。`);
  }
  const context = {
    card: usedCard,
    ability,
    player,
    owner,
    target,
    costDiscardedCards: payment.discarded || [], // E-PR6: 即時解決経路（対抗窓を挟まない）でも捨て札を渡す
  };
  const bodyResult = await executeAbilityBody(context);
  // callSelfFromHand(手札の自身コール)を含む能力で、スクリプトが中断(コール先選択キャンセル等)し
  // 発生源カードがドロップに取り残された場合は、宣言不成立として手札へ戻す(カード喪失を防ぐ)。
  const usesCallSelf = Array.isArray(ability.script) && ability.script.some((s) => s?.op === "callSelfFromHand");
  if (bodyResult === false && usesCallSelf) {
    const onField = zones.some(
      (z) => player.field[z]?.instanceId === usedCard.instanceId,
    );
    const dropIndex = player.drop.findIndex((c) => c.instanceId === usedCard.instanceId);
    if (!onField && dropIndex >= 0) {
      player.drop.splice(dropIndex, 1);
      player.hand.push(usedCard);
      addLog(`${usedCard.name}のコールを取りやめ、手札に戻しました。`);
      state.selected = null;
      state.linkAttackers = [];
      render();
      return;
    }
  }
  markAbilityLimit(owner, usedCard, ability);
  // 「君が魔法を使った時」の場全体誘発（allySpellCast/opponentSpellCast）。
  // 通常のメインフェイズ魔法解決(resolvePendingSpell)では発火済みだが、このブロック（対抗タイミングでの
  // 手札魔法の即時解決等）ではこれまで未発火だった（決戦の地 ヴィーグリーズ 0053 等が取りこぼす）。
  // usedCard は直前で player.drop に積んでおり、場のカードとして自分自身を拾うことはないため
  // 自己反応の心配はない（既存の resolvePendingSpell と同じ安全性）。
  if (effectiveCardType(usedCard) === "spell") {
    recordSpellCastThisTurn(owner); // E-XB9: 対抗/即時手札魔法解決経路もターン内魔法使用回数へ算入
    await runFieldEventTriggers("spellCast", owner, usedCard, null, { spellCard: usedCard });
  }
  state.selected = null;
  state.linkAttackers = [];
  // E-XB42(X-BT04/0099 endCurrentTurn): 手札起動能力の即時解決経路（対抗窓を挟まない）で立った「現在ターン終了」
  // 予約もこの unwind 点で消費する（field 版と対）。pending 中は保留され後の resolvePendingResolution で終える。
  // 予約が無ければ no-op（後方互換）。
  await maybeEndPendingCurrentTurn();
  render();
}

// loc を渡すと場以外（ドロップ等）からの起動にも使える。loc={owner, zone, inDrop, abilities?}。
// 省略時は state.selected を参照（従来の場の起動能力）。
async function useFieldAbilityAction(card, loc = null) {
  const owner = loc ? loc.owner : state.selected.owner;
  const zone = loc ? loc.zone : state.selected.zone;
  const inDrop = Boolean(loc?.inDrop);
  let usableAbilities =
    loc?.abilities || (inDrop ? findUsableDropAbilities(card, owner) : findUsableFieldAbilities(card, owner));
  // ソウル一覧から「この能力を使う」と名指しされた場合はそれに絞る（権威版は state.selected に載せて送る）。
  // 絞った結果が空なら（条件が変わった等）絞らず従来どおり全候補から選ばせる。
  const wantedAbilityId = loc?.abilityId ?? state.selected?.abilityId;
  const wantedSoulInstanceId = loc?.soulInstanceId ?? state.selected?.soulInstanceId;
  if (wantedAbilityId) {
    const narrowed = usableAbilities.filter(
      (ability) =>
        ability.id === wantedAbilityId &&
        (!wantedSoulInstanceId || ability.soulSourceCard?.instanceId === wantedSoulInstanceId),
    );
    if (narrowed.length > 0) {
      usableAbilities = narrowed;
    }
  }
  if (usableAbilities.length === 0) {
    // 理由（タイミング/1ターン1回/使用条件）を説明できるなら、それを出す。
    // 「ありません」だけだと、ソウルの能力が壊れているのか条件未達なのかユーザーが判別できない。
    const reasons = inDrop ? [] : describeUnusableFieldAbilities(card, owner);
    if (reasons.length > 0) {
      reasons.forEach((reason) => addLog(reason));
    } else {
      addLog(inDrop ? "今使えるドロップからの起動能力はありません。" : "今使える起動能力はありません。");
    }
    return;
  }
  const ability =
    usableAbilities.length === 1 ? usableAbilities[0] : await chooseFieldAbility(card, usableAbilities, owner);
  if (!ability) {
    return; // 能力選択がキャンセルされた
  }
  const player = state.players[owner];
  const sourceCard = ability.fromSoul ? ability.soulSourceCard : card;
  const target = await targetForAbilityUse(sourceCard, ability, owner);
  if (ability.target && !target) {
    addLog(`${card.name}の対象を選んでください。`);
    return;
  }
  if (
    hasPendingResolution() &&
    (!isCounterAbility(ability) || !canUseCounterEffect(owner, selectedCounterKind(card)))
  ) {
    addLog("この攻撃中に使える【対抗】能力ではありません。");
    return;
  }
  const usesGaugeCost = abilityCostSteps(sourceCard, ability).some((step) => step.op === "payGauge" && step.amount > 0);
  const includeOpponentGauge = Boolean(
    ability.kind === "activated" &&
      usesGaugeCost &&
      player.nextActivatedCostMayUseOpponentGauge
  );
  const payment = await payStructuredCostWithSelection(player, abilityCostSteps(sourceCard, ability), {
    sourceCard,
    selectedCard: sourceCard,
    ability,
    includeOpponentGauge,
    // E3(D-BT04/0033 グラトス): discardSoulToDeckBottom{amountFrom:{source:"targetStat"}} が、
    // 先に選んだ効果対象の打撃力を最小支払い量として読めるよう渡す（専用キー＝dropOwnMonster 等の
    // 既存 context.target 解決経路には触れない）。owner は controller 解決の整合用。
    effectTargetForCost: target,
    owner,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  if (includeOpponentGauge) {
    player.nextActivatedCostMayUseOpponentGauge = false;
  }
  if (ability.soulSpellCast) {
    // E-XB45: 使用コスト支払い済み。ソウルの魔法を「使用」として spell の pendingAction へ流す（対抗窓→resolvePendingSpell）。
    await finalizeSoulSpellCast(card, sourceCard, ability, owner, player, target);
    return;
  }
  addAbilityUseLog(player, sourceCard, ability);
  // E-XB56②(X-UB03/0001 ギアゴッド ver.1ØØØØ『逆天殺ReBOOT』の「相手は【対抗】できず」): ability.noCounterWindow が立つと
  // 宣言時の対抗ウィンドウ(pendingAction)を開かず、下の即時解決経路へ落とす。即時解決経路は executeAbilityBody→markAbilityLimit→
  // maybeEndPendingCurrentTurn→render を賄うため自席の後続処理は不変。triggered 型 preventOpponentCounterThisTurn では
  // 「宣言そのもの」を遡れない（対抗ウィンドウが閉じた後にしか効かない）ため、宣言前バリアとして ability レベルにゲートする。
  // 未指定（既存カード全て）は false 扱いで従来どおり対抗ウィンドウを開く＝後方互換。
  if (!hasPendingResolution() && !isCounterAbility(ability) && !ability.noCounterWindow) {
    beginPendingAction({
      kind: "ability",
      owner,
      responder: 1 - owner,
      card: sourceCard,
      ability,
      phase: state.phase,
      zone,
      hostCard: ability.fromSoul ? card : null,
      hostOwner: ability.fromSoul ? owner : null,
      hostZone: ability.fromSoul ? zone : null,
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : "",
    });
    addLog(`${player.name}は${sourceCard.name}の能力を宣言しました。対抗確認を行ってください。`);
    render();
    return;
  }
  await executeAbilityBody({
    card: sourceCard,
    ability,
    player,
    owner,
    zone,
    hostCard: card,
    hostOwner: owner,
    hostZone: zone,
    target,
  });
  if (hasPendingResolution() && isCounterAbility(ability)) {
    markCounterUsed(owner, selectedCounterKind(card));
  }
  markAbilityLimit(owner, sourceCard, ability);
  state.selected = null;
  state.linkAttackers = [];
  // E-XB42(X-BT04/0099 endCurrentTurn): 対抗窓を挟まず即時解決した場の起動能力（0099 逆天殺 の即時 counter 等、
  // hasPendingResolution が偽のイベント窓経路）で立った「現在ターン終了」予約をこの unwind 点で消費する。
  // pending 中（通常の対抗中）は maybeEndPendingCurrentTurn が保留し、後の resolvePendingResolution で終える。
  // 予約が無ければ no-op（後方互換）。useDropAbilityAction はこの関数へ委譲するためドロップ起動も同時に賄う。
  await maybeEndPendingCurrentTurn();
  render();
}

// E-XB45(エルシニアス): ソウルの魔法を「使用」として確定させる。使用コストは呼び出し元(useFieldAbilityAction)で支払い済み。
// ソウルからホスト外へ抜き（＝使用後の行き先はドロップ。原文「魔法を使う」＝通常魔法と同じく解決後ドロップゾーンへ）、
// spell の pendingAction を開いて相手へ対抗機会を与える。resolvePendingSpell(src/07)が本体解決・ドロップ着地・
// 「君が魔法を使った時」(spellCast)誘発・named-once 記帳を賄う（手札魔法と同一の解決経路＝忠実）。
async function finalizeSoulSpellCast(hostCard, spellCard, ability, owner, player, target) {
  const soul = hostCard.soul || [];
  const idx = soul.findIndex((c) => c.instanceId === spellCard.instanceId);
  if (idx < 0) {
    // 非同期誘発レースでソウルから抜けていたら中止（callMonster と同型のガード）。
    addLog(`${spellCard.name}がソウルにないため、使用を中止しました。`);
    return;
  }
  const removed = soul.splice(idx, 1)[0];
  // named-once（「1ターンに1回だけ使える」）は宣言＝コスト支払い済みのこの時点で記帳（手札魔法 src/13:177 と同順序）。
  markAbilityLimit(owner, removed, ability);
  beginPendingAction({
    kind: "spell",
    owner,
    responder: 1 - owner,
    card: removed,
    ability,
    phase: state.phase,
    // E-XB50(X-CBT01/0030 秘剣 斬流雷牙「『秘剣 絶命陣』のソウルから使われていたなら」): soul-cast の
    // ホストカードを spell の pendingAction へ伝搬し、解決時に castFromSoulHostMatches で照合できるようにする。
    // resolvePendingSpell が action.hostCard を context.hostCard へ渡す。ホストは場札＝両席可視でT13安全。
    hostCard,
    effectTargetValue: target ? encodeTarget(target.owner, target.zone) : "",
  });
  addLog(`${player.name}は${removed.name}（${hostCard.name}のソウル）の使用を宣言しました。対抗確認を行ってください。`);
  render();
}

async function targetForAbilityUse(card, ability, owner) {
  if (!ability.target) {
    return getEffectTargetInfo();
  }
  const current = getEffectTargetInfo();
  if (current && targetMatchesSpec(current, ability.target, owner, { card, ability })) {
    return current;
  }
  return chooseAbilityTarget(card, ability, owner);
}

function addAbilityUseLog(player, card, ability) {
  if (isFieldActivatedAbility(ability)) {
    addLog(`${player.name}は${card.name}の【起動】を使いました。`);
  }
}

function fieldAbilityUsable(card, ability, owner, timing) {
  if (ability.fromHandOnly) {
    return false;
  }
  if (!isFieldActivatedAbility(ability)) {
    return false;
  }
  if (!abilityTimingIncludes(ability, timing)) {
    return false;
  }
  if (isAbilityLimitUsed(owner, card, ability)) {
    return false;
  }
  if (ability.target && !ability.target.allowMissingTarget && targetCandidatesFromSpec(ability.target, owner, { card, ability }).length === 0) {
    return false;
  }
  return (
    // context.card を渡す（対抗ウィンドウ中は state.selected が攻撃側等の別カードになり得るため、
    // pendingBattleInvolvesSelf 等の「このカード」系条件が発生源カードを正しく参照できるように）。
    checkAbilityConditions(ability, owner, { card }) &&
    canSatisfyAbilityScript(card, ability, owner, { zone: state.selected?.zone })
  );
}

// 使用可能な場の起動能力を「すべて」返す（直接＋ソウル）。
// 変身/搭乗(モンスタースペースからの装備)と別の【起動】が同時に使える場合など、
// 複数ある時は useFieldAbilityAction で選択させる。
function findUsableFieldAbilities(card, owner = state.selected?.owner ?? state.active) {
  if (isAbilitiesNullified(card)) {
    return []; // 能力無効化(凍てつく星辰)されたカードの起動能力は使えない
  }
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  const direct = (card.abilities || []).filter((ability) => fieldAbilityUsable(card, ability, owner, timing));
  return [...direct, ...findUsableSoulAbilities(card, owner, timing), ...findCastableSoulSpells(card, owner, timing)];
}

function findUsableFieldAbility(card, owner = state.selected?.owner ?? state.active) {
  return findUsableFieldAbilities(card, owner)[0] || null;
}

// ドロップゾーンのカードが持つ、ドロップから発動できる起動能力（fromDropZone:true）で今使えるものを返す。
// 例: 墓場のDJ ブネ(BT03/0014)・炎王の舎弟リッキー(BT03/0018)・百鬼将ギシンギュウキ(EB03/0002)。
// 場のカードと違い state.selected を使わず、対象カードがドロップにある前提で条件(sourceZoneIn:[drop]等)を評価する。
function findUsableDropAbilities(card, owner) {
  if (isAbilitiesNullified(card)) {
    return [];
  }
  // 手番/応答者ガード（場の起動と同じ規約）: 対抗ウィンドウ中は攻撃/行動の当事者のみ、平時は手番プレイヤーのみ。
  const mayAct = state.pendingAttack
    ? [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(owner)
    : state.pendingAction
      ? owner === state.pendingAction.responder
      : owner === state.active;
  if (!mayAct) {
    return [];
  }
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  return (card.abilities || []).filter(
    (ability) =>
      ability.kind === "activated" &&
      ability.fromDropZone &&
      !ability.fromHandOnly &&
      abilityTimingIncludes(ability, timing) &&
      !isAbilityLimitUsed(owner, card, ability) &&
      (!ability.target ||
        targetCandidatesFromSpec(ability.target, owner, { card, ability, zone: "drop" }).length > 0) &&
      checkAbilityConditions(ability, owner, { card, owner, zone: "drop" }) &&
      canSatisfyAbilityScript(card, ability, owner, { zone: "drop" }),
  );
}

// ドロップのカードの起動能力を発動する（UIのドロップ一覧から呼ぶ）。
async function useDropAbilityAction(owner, card) {
  const usableAbilities = findUsableDropAbilities(card, owner);
  if (usableAbilities.length === 0) {
    addLog("今使えるドロップからの起動能力はありません。");
    return false;
  }
  await useFieldAbilityAction(card, { owner, zone: "drop", inDrop: true, abilities: usableAbilities });
  return true;
}

// ドロップに、今 owner が発動できる起動能力を持つカードがあるか（UIでボタンを出すかの判定）。
function hasUsableDropAbility(owner) {
  return (state.players[owner]?.drop || []).some((card) => findUsableDropAbilities(card, owner).length > 0);
}

function findUsableSoulAbilities(hostCard, owner, timing) {
  const result = [];
  for (const soulSourceCard of hostCard?.soul || []) {
    for (const ability of soulSourceCard.soulAbilities || []) {
      const soulAbility = {
        ...ability,
        fromSoul: true,
        soulSourceCard,
      };
      if (!isFieldActivatedAbility(soulAbility)) {
        continue;
      }
      if (!abilityTimingIncludes(soulAbility, timing)) {
        continue;
      }
      if (isAbilityLimitUsed(owner, soulSourceCard, soulAbility)) {
        continue;
      }
      if (
        !checkAbilityConditions(soulAbility, owner, {
          card: soulSourceCard,
          hostCard,
          hostOwner: owner,
          hostZone: findFieldCardSlot(hostCard)?.zone,
        })
      ) {
        continue;
      }
      result.push(soulAbility);
    }
  }
  return result;
}

function findUsableSoulAbility(hostCard, owner, timing) {
  return findUsableSoulAbilities(hostCard, owner, timing)[0] || null;
}

// E-XB45(X-CBT02/0075 “死灰魔導” エルシニアス): 「君はこのカードのソウルにある《病》の魔法を【使用コスト】を払って使える」。
// fromDropZone 活性（墓場のDJ 0014）の兄弟＝「fromSoulOf(ホスト)」型のキャスト経路。host が top-level フィールド
// soulSpellCast:{filter} を持つとき、ソウル内の filter 一致「魔法カード」を、その魔法自身の spell 能力（使用コスト＋効果）で
// キャスト可能にする。合成能力を { ...spellAbility, fromSoul, soulSpellCast, soulSourceCard } として返し、
// useFieldAbilityAction が spell の pendingAction（＝対抗窓・解決後ドロップ着地・spellCast 誘発・named-once 記帳）へ流す。
// 未設定（soulSpellCast を持たない既存の全ホスト）は即空配列＝バイト不変（後方互換）。host 無効化時は呼び出し元
// findUsableFieldAbilities が [] を返すため、この経路も自動的に停止する（能力無効化＝soul-cast も不可）。
function findCastableSoulSpells(hostCard, owner, timing) {
  const spec = hostCard?.soulSpellCast;
  if (!spec) {
    return [];
  }
  // 通常魔法はターンプレイヤーのメインフェイズのみ使用可（対抗窓/攻撃・ファイナルフェイズでは出さない）。
  // 病の魔法（大魔法群・ワールド・パンデミック）は全てメイン魔法のため、この主枠に限定する（counter 魔法の soul-cast は将来対応）。
  if (timing !== "main" || owner !== state.active) {
    return [];
  }
  const result = [];
  for (const soulCard of hostCard.soul || []) {
    if (spec.filter && !matchesCardFilter(soulCard, spec.filter)) {
      continue;
    }
    const spellAbility = (soulCard.abilities || []).find((ability) => ability.kind === "spell");
    if (!spellAbility) {
      continue;
    }
    // カードレベルの useConditions（例: 8枚以上）も手札キャストと同様にゲートする。
    if (!checkCardConditions(soulCard.useConditions || [], owner, { card: soulCard, owner })) {
      continue;
    }
    const synthetic = { ...spellAbility, fromSoul: true, soulSpellCast: true, soulSourceCard: soulCard };
    if (isAbilityLimitUsed(owner, soulCard, synthetic)) {
      continue; // named-once（「1ターンに1回だけ使える」）は spell の name ベースキー＝手札/ソウル複製で合算（既存規約）
    }
    if (
      synthetic.target &&
      !synthetic.target.allowMissingTarget &&
      targetCandidatesFromSpec(synthetic.target, owner, { card: soulCard, ability: synthetic }).length === 0
    ) {
      continue;
    }
    if (!checkAbilityConditions(synthetic, owner, { card: soulCard, owner })) {
      continue;
    }
    if (!canSatisfyAbilityScript(soulCard, synthetic, owner, {})) {
      continue;
    }
    result.push(synthetic);
  }
  return result;
}

// 場のカードに使える起動能力が複数ある時、どれを使うか選ばせる。
// 例: モンスタースペースのキャプテン・アンサーは「変身で装備」と「アンサークエスチョン」の両方が使える。
async function chooseFieldAbility(card, abilities, owner) {
  if (globalThis.__BUDDYFIGHT_TEST__ && typeof globalThis.__forcedFieldAbilityId === "string") {
    return abilities.find((ability) => ability.id === globalThis.__forcedFieldAbilityId) || abilities[0];
  }
  const selected = await chooseCardEntries(
    abilities.map((ability) => ({
      ability,
      card: {
        name: fieldAbilityLabel(card, ability),
        type: "choice",
      },
    })),
    {
      // 対抗窓では対抗能力も並ぶため「起動能力」と決め打ちしない（ソウルの対抗を選ぶ場面がある）。
      title: `${card.name}の能力`,
      lead: "使う能力を選んでください（ソウルの能力もここに並びます）。",
      min: 1,
      max: 1,
      forceDialog: true,
      allowCancel: true,
      purpose: "ability-pick", // CPU対戦(src/22): 複数の起動能力からの選択
      promptSeat: owner,
    },
  );
  return selected?.[0]?.ability || null;
}

// 「今使える起動能力はありません。」だけだと、能力が壊れているのか条件を満たしていないだけなのかが
// 分からない（ソウルの能力は特に、ホストのカードしか見えないので原因が追えない）。宣言されている
// 起動/対抗能力を1つずつ見て、最初に引っかかったゲート（タイミング / 1ターン1回 / 使用条件）を返す。
// カード名のハードコードはせず、条件 op から汎用に説明する（説明できない op は理由なしで従来文言）。
const ABILITY_TIMING_LABELS = { ...phaseLabels, counter: "対抗" };
const ABILITY_ZONE_LABELS = {
  hand: "手札",
  drop: "ドロップ",
  left: "モンスタースペース",
  center: "モンスタースペース",
  right: "モンスタースペース",
  item: "アイテム枠",
  item2: "アイテム枠",
  item3: "アイテム枠",
  item4: "アイテム枠",
};

function describeAbilityCondition(condition) {
  if (!condition || typeof condition !== "object") {
    return null;
  }
  if (condition.op === "lifeLte") return `自分のライフ${condition.amount}以下`;
  if (condition.op === "lifeGte") return `自分のライフ${condition.amount}以上`;
  if (condition.op === "lifeCount") {
    const who = condition.controller === "opponent" ? "相手" : "自分";
    const cmp = condition.cmp === "lte" ? "以下" : condition.cmp === "eq" ? "ちょうど" : "以上";
    const amount = condition.amount ?? 0;
    return condition.cmp === "eq" ? `${who}のライフが${amount}` : `${who}のライフ${amount}${cmp}`;
  }
  if (condition.op === "phaseIs") return `${ABILITY_TIMING_LABELS[condition.phase] || condition.phase}フェイズ中`;
  if (condition.op === "turnOwnerIsSelf") return "自分のターン中";
  if (condition.op === "turnOwnerIsOpponent") return "相手のターン中";
  if (condition.op === "reversalUsedThisFight") return "このファイト中に『逆天』を使っていること";
  if (condition.op === "deckMilledThisTurn") {
    const who = condition.deckOwner === "opponent" ? "相手" : "自分";
    const n = condition.amount ?? 1;
    return `このターン中、${who}のデッキのカードが${n > 1 ? `${n}枚以上` : ""}ドロップに置かれていること`;
  }
  if (condition.op === "damageTakenThisTurn") {
    const who = condition.damageOwner === "opponent" ? "相手" : "自分";
    const n = condition.amount ?? 1;
    return `このターン中、${who}が${n > 1 ? `${n}以上の` : ""}ダメージを受けていること`;
  }
  if (condition.op === "gaugePlacedThisTurnLte") {
    const who = condition.controller === "opponent" ? "相手" : "自分";
    const n = condition.amount ?? 0;
    return n <= 0 ? `このターン中、${who}のゲージにカードが置かれていないこと` : `このターン中、${who}のゲージに置かれたカードが${n}枚以下であること`;
  }
  if (condition.op === "hostMatches") return "装備している（搭乗/変身）カードの条件";
  if (condition.op === "sourceStanding") return "このカードがスタンドしていること";
  if (condition.op === "sourceZoneIn") {
    // left/center/right や item/item2… は同じ表示名に畳む（「モンスタースペース・モンスタースペース…」を防ぐ）。
    const zoneNames = [
      ...new Set((condition.zones || []).map((zone) => ABILITY_ZONE_LABELS[zone] || zone)),
    ].join("・");
    return zoneNames ? `このカードが${zoneNames}にあること` : null;
  }
  return null;
}

// ability の発生源表示名（ソウルの能力はソウルのカード名を出す。ホスト名だけでは何の能力か分からない）。
function abilitySourceLabel(card, ability) {
  return ability.fromSoul && ability.soulSourceCard?.name
    ? `ソウルの${ability.soulSourceCard.name}`
    : card.name;
}

// 使えない理由の説明を配列で返す（説明できるものが無ければ空配列＝呼び元は従来の文言に落とす）。
// options.soulCard を渡すと、そのソウルカードが持つ能力の理由だけに絞る（ソウル詳細シート用）。
function describeUnusableFieldAbilities(card, owner, options = {}) {
  if (isAbilitiesNullified(card)) {
    return [`${card.name}の能力は無効化されています。`];
  }
  const onlySoulCard = options.soulCard || null;
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  const declared = [
    ...(onlySoulCard ? [] : (card.abilities || []).filter(isFieldActivatedAbility).map((ability) => ({ ...ability }))),
    ...(card.soul || [])
      .filter((soulCard) => !onlySoulCard || soulCard.instanceId === onlySoulCard.instanceId)
      .flatMap((soulCard) =>
        (soulCard.soulAbilities || [])
          .filter(isFieldActivatedAbility)
          .map((ability) => ({ ...ability, fromSoul: true, soulSourceCard: soulCard })),
      ),
  ];
  // 宣言されている能力を**すべて**説明する。最初の1件で打ち切ると、ホスト自身の能力の理由だけを出して
  // 肝心のソウルの能力に触れない（＝ユーザーが探している能力の理由が出ない）。
  const reasons = [];
  for (const ability of declared) {
    const who = abilitySourceLabel(card, ability);
    const kindLabel = isCounterAbility(ability) ? "対抗能力" : "起動能力";
    if (!abilityTimingIncludes(ability, timing)) {
      const allowed = (ability.timing || []).map((t) => ABILITY_TIMING_LABELS[t] || t).join("・");
      reasons.push(
        allowed
          ? `${who}の${kindLabel}は今のタイミングでは使えません（${allowed}）。`
          : `${who}の${kindLabel}は今のタイミングでは使えません。`,
      );
      continue;
    }
    if (isAbilityLimitUsed(owner, ability.soulSourceCard || card, ability)) {
      reasons.push(`${who}の${kindLabel}はこのターン既に使用しています。`);
      continue;
    }
    const conditionContext = ability.fromSoul
      ? {
          card: ability.soulSourceCard,
          hostCard: card,
          hostOwner: owner,
          hostZone: findFieldCardSlot(card)?.zone,
        }
      : { card };
    const failing = (ability.conditions || []).find(
      (condition) => !checkCardConditions([condition], owner, conditionContext),
    );
    if (failing) {
      const desc = describeAbilityCondition(failing);
      reasons.push(
        desc
          ? `${who}の${kindLabel}は使用条件を満たしていません（${desc}）。`
          : `${who}の${kindLabel}は使用条件を満たしていません。`,
      );
    }
  }
  // 同一文言（同じカードの同型能力が複数など）は畳む。多すぎるとログが埋まるので上限3件。
  return [...new Set(reasons)].slice(0, 3);
}

function fieldAbilityLabel(card, ability) {
  if (ability.label) {
    return ability.label;
  }
  const isEquipSelf =
    (ability.effects || []).some((effect) => effect.op === "equipSelf") ||
    (ability.script || []).some((step) => step.op === "equipSelf");
  if (isEquipSelf) {
    return "このカードを装備する（変身／搭乗）";
  }
  const base = ability.name || (isCounterAbility(ability) ? "対抗能力" : "起動能力");
  // ソウルの能力は発生源（ソウルにあるカード）を明示する。ホスト（武器/変身元）の名前しか出さないと、
  // ホスト自身の能力とソウルの能力が同じ「起動能力」ラベルで並び、どちらがソウルのものか選べない
  // （アーマナイト系＝武器のソウルに入って起動/対抗を与えるカードで顕在化）。
  if (ability.fromSoul && ability.soulSourceCard?.name) {
    return `ソウル: ${ability.soulSourceCard.name} の${base}`;
  }
  return base;
}

function isFieldActivatedAbility(ability) {
  return ability.kind === "activated" || hasAbilityKeyword(ability, "reversal");
}

function abilityTimingIncludes(ability, phase) {
  const timings = ability.timing || [];
  if (timings.length === 0 || timings.includes(phase)) {
    return true;
  }
  // 2018年6月以前ルール: 【対抗】を持つカード/能力は自分のメインフェイズでも使える
  return phase === "main" && timings.includes("counter");
}

function checkAbilityConditions(ability, owner, context = {}) {
  return checkCardConditions(ability.conditions, owner, context);
}

function checkCardConditions(conditions = [], owner, context = {}) {
  return (conditions || []).every((condition) => checkCondition(condition, owner, context));
}

function hasBuddyOnField(player) {
  return zones.some((zone) => {
    const card = player.field[zone];
    return card && player.buddy && card.name === player.buddy.name;
  });
}

// 「○○がいるとして扱う」系: 場のカードが countsAsFieldMonster を宣言していれば、
// 仮想モンスター(card風オブジェクト)として返す。場の在否を問う条件（presence/count）のみが参照し、
// 対象選択や継続バフ（実カードを要する処理）には含めない。
function phantomFieldMonsters(player) {
  if (!player) {
    return [];
  }
  const phantoms = [];
  zones.forEach((zone) => {
    const spec = player.field[zone]?.countsAsFieldMonster;
    if (!spec) {
      return;
    }
    (Array.isArray(spec) ? spec : [spec]).forEach((entry) => {
      phantoms.push({
        type: "monster",
        currentType: "monster",
        attributes: entry.attributes || (entry.attribute ? [entry.attribute] : []),
        size: entry.size || 0,
        power: entry.power || 0,
        critical: entry.critical || 0,
        defense: entry.defense || 0,
        name: entry.name || `${player.field[zone].name}(扱い)`,
        __phantom: true,
      });
    });
  });
  return phantoms;
}

function checkCondition(condition, owner, context = {}) {
  const player = state.players[owner];
  const opponent = state.players[1 - owner];
  if (condition.op === "all") {
    return (condition.conditions || []).every((child) => checkCondition(child, owner, context));
  }
  if (condition.op === "any") {
    return (condition.conditions || []).some((child) => checkCondition(child, owner, context));
  }
  if (condition.op === "not") {
    return !checkCondition(condition.condition || {}, owner, context);
  }
  if (condition.op === "calledViaAmbush") {
    // E-Y1(X-BT01 奇襲): この登場が『奇襲』ルート由来か（context.card=登場カード自身）。
    // 0003/0033/0064/0092「登場した時…さらに奇襲で登場していたなら」の script ifCondition や、
    // 0036/0094「奇襲で登場した時…」の ability.conditions ゲートで参照する。
    // calledViaAmbush は resolveOnEnter で毎登場ごとに明示代入され、通常登場では false（既存挙動不変）。
    return Boolean(context.card?.calledViaAmbush);
  }
  if (condition.op === "declaredNameInZone") {
    // declareCardName で宣言したカード名が、指定の山(既定:相手の手札)に存在するか。
    const declaredName = context.declaredCardName ?? context.vars?.declaredCardName;
    if (!declaredName) {
      return false;
    }
    const side = condition.controller === "opponent" ? opponent : player;
    if (!side) {
      return false;
    }
    const pile = condition.pile || "hand";
    let cards;
    if (pile === "field") {
      cards = zones.map((z) => side.field[z]).filter(Boolean);
    } else if (pile === "soul") {
      cards = zones.flatMap((z) => side.field[z]?.soul || []);
    } else {
      cards = side[pile] || [];
    }
    return cards.some((card) => card.name === declaredName);
  }
  if (condition.op === "confirmPrompt") {
    // メタ的な自己申告条件（例: ギャラホルンの「君が小学生なら」）を確認ポップアップで判定。
    // 何度も評価されると複数回ポップアップするため、ability.conditions ではなく script の ifCondition 内で使うこと。
    // B3: リプレイ再生中は記録済みの真偽値を返す／記録中は同期で控える（確認UIは変えない）。
    if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
      return replayNextConfirm();
    }
    let answer;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      answer = Boolean(window.confirm(condition.prompt || "この効果を使いますか？"));
    } else {
      answer = Boolean(condition.default);
    }
    if (typeof replayRecordConfirm === "function") {
      replayRecordConfirm(answer);
    }
    return answer;
  }
  if (condition.op === "cardCount" || condition.op === "cardCountGte" || condition.op === "cardCountLte") {
    // 汎用枚数条件: controller(self/opponent/both/either) × pile(field/center/item/drop/hand/deck/gauge/soul) × filter × distinct × cmp
    const cmp = condition.cmp || (condition.op === "cardCountLte" ? "lte" : "gte");
    const pile = condition.pile || "field";
    // amount:0 は「ちょうど0枚 / 0枚以下」= 有意な閾値（0049「自場モンスター0体なら」等）。
    // || 1 だと 0 が 1 に潰れて eq/lte が壊れるため ?? で 0 を保持する。
    const amount = condition.amount ?? 1;
    // 指定プレイヤー群のカードを1配列に集めフィルタ後の枚数を返す（複数側渡すと合算＝both 意味論）。
    const countForSides = (sideList) => {
      let matched = [];
      sideList.forEach((pl) => {
        if (!pl) return;
        let cards = [];
        if (pile === "field") cards.push(...zones.map((z) => pl.field[z]).filter(Boolean), ...phantomFieldMonsters(pl));
        else if (pile === "item") cards.push(...equippedItems(pl)); // 複数装備を全てカウント（「アイテム2枚装備なら」0042等）
        else if (pile === "center") { if (pl.field[pile]) cards.push(pl.field[pile]); }
        else if (pile === "soul") cards.push(...zones.flatMap((z) => pl.field[z]?.soul || []));
        // E-XB46(X-CBT02 病5枚 0015/0027/0030/0032/0076「君の場のアイテムのソウルに《病》の魔法N枚以上」):
        // アイテムゾーンのソウルだけを合算する（既存 pile:"soul" は全ゾーン横断＝モンスター/設置/アイテムの
        // ソウルを混ぜる。itemSoul は itemZones のソウルに限定＝「アイテムのソウル」の正確カウント）。
        else if (pile === "itemSoul") cards.push(...itemZones.flatMap((z) => pl.field[z]?.soul || []));
        else cards.push(...(pl[pile] || []));
        if (condition.excludeSource && context.card) {
          cards = cards.filter((c) => c.instanceId !== context.card.instanceId);
        }
        // E-PR3: filter.buddy を場外(ドロップ/手札/デッキ/ゲージ)でも判定できるよう pile 所有者を渡す
        // （E-XC15 と同型。both/either はここで側ごとに正しい所有者で照合。field/soul/center は
        //  findFieldCardSlot で所有者特定できるため owner は無視＝挙動不変）。
        const plOwner = state.players.indexOf(pl);
        matched.push(...cards.filter((c) => matchesCardFilter(c, condition.filter || {}, { owner: plOwner })));
      });
      if (condition.distinct === "distinctByName") {
        return new Set(matched.map((c) => c.name)).size;
      }
      // E1(D-SS03/0039 旧世界の破壊神 アジ・ダハーカ): ワールドの種類数。2ワールド持ちカードは
      // cardWorlds() で両ワールドを算入（union）。既存 distinctByName / 未指定（枚数）は完全に不変。
      if (condition.distinct === "distinctByWorld") {
        return new Set(matched.flatMap((c) => cardWorlds(c))).size;
      }
      return matched.length;
    };
    const meets = (n) => (cmp === "lte" ? n <= amount : cmp === "eq" ? n === amount : n >= amount);
    // E2(D-EB03): controller:"either" は各側を個別集計し、いずれか一方でも cmp を満たせば真
    // （max/OR 意味論。「君か相手のドロップが N枚以上」0004。both＝合算 とは別値）。
    if (condition.controller === "either") {
      return [player, opponent].some((pl) => pl && meets(countForSides([pl])));
    }
    const sides = condition.controller === "opponent" ? [opponent]
      : condition.controller === "both" ? [player, opponent] : [player];
    return meets(countForSides(sides));
  }
  if (condition.op === "attackingAlone") {
    return getPendingAttackers().length === 1;
  }
  if (condition.op === "targetMatches") {
    const ref = condition.ref ? resolveEffectReference(condition.ref, context) : context.target;
    if (!ref?.card) {
      return false;
    }
    // レビュー修正(D-BT01/0091): matchesCardFilter は zone を解釈しないため、ゾーン条件はここで判定する
    // （「そのカードがセンターにいるなら、かわりに〜」の排他分岐用）。
    if (condition.zone && ref.zone !== condition.zone) {
      return false;
    }
    if (condition.zoneNot && ref.zone === condition.zoneNot) {
      return false;
    }
    return matchesCardFilter(ref.card, condition.filter || {});
  }
  if (condition.op === "sourceIsBuddy") {
    return sourceIsBuddyCondition(owner, context);
  }
  if (condition.op === "enteredByEffect") {
    // 「このカードがカードの効果で登場した時」（enter誘発のconditionsで使う。H-PP01/0044）。
    return Boolean(context.enteredByEffect);
  }
  if (condition.op === "enteredByCardNamed") {
    // E-XU2(X-UB01/0021 ミセリア): 「『仮面剣士 キリ』の効果で登場した時」。登場の発生源カード名で弁別する。
    // matchesCardFilter の name 判定（additionalNames 込み）を再利用。発生源未追跡（通常コール等）は false。
    return Boolean(context.enterCauseCard) && matchesCardFilter(context.enterCauseCard, { name: condition.name });
  }
  if (condition.op === "enterCauseMatches") {
    // 汎用形: 登場の発生源カードを filter で判定（属性/種別等での弁別に使う）。
    return Boolean(context.enterCauseCard) && matchesCardFilter(context.enterCauseCard, condition.filter || {});
  }
  if (condition.op === "turnOwnerIsSelf") {
    return (context.turnOwner ?? state.active) === owner;
  }
  if (condition.op === "turnOwnerIsOpponent") {
    return (context.turnOwner ?? state.active) !== owner;
  }
  if (condition.op === "reversalUsedThisFight") {
    // E-XB41/R20(X-BT04/0069 天晶への覚醒): 「このファイト中、君が『逆天』を使っているなら使える」。
    // 逆天(reversal)を使うと markAbilityLimit(src/15) が state.fightLimits[owner].reversal を記帳する
    //（normalizedAbilityLimit の既定 scope:"fight"/key:"reversal"）。逆天殺は明示 limit.key:"reversalKill" で
    // 別プールに記帳されるため本 op は false になる（R9/R20 の「逆天と逆天殺は独立プール」規約）。
    // useConditions / ability.conditions / effect.conditions のいずれからも checkCardConditions 経由で評価される。
    return Boolean(state.fightLimits?.[owner]?.reversal);
  }
  if (condition.op === "phaseIs") {
    return (state.pendingAction?.phase || state.phase) === condition.phase;
  }
  if (condition.op === "lifeLte") {
    return player.life <= condition.amount;
  }
  if (condition.op === "lifeGte") {
    // E12(D-CBT): describeAbilityCondition に表示文言だけ存在し評価分岐が無かった（未知opは末尾
    // return true＝常時成立に落ちる罠）。既存カード使用0件＝挙動不変。lifeLte の鏡。
    return player.life >= (condition.amount ?? 1);
  }
  if (condition.op === "opponentLifeLte") {
    return opponent.life <= condition.amount;
  }
  if (condition.op === "lifeCount") {
    // E-XB13(X-CP03/0011 大連鎖凶骨 サーティーン): ライフ枚数の汎用比較。controller(self/opponent) × cmp(gte/lte/eq) × amount。
    // 既存 lifeLte/lifeGte(self専用)・opponentLifeLte(相手≤のみ) では表現できない「相手のライフがちょうど13」等の
    // 等値・相手側 gte を1opで賄う（cardCount の life 版＝pile 列挙に life が無い穴を埋める）。既存カード使用0件＝挙動不変。
    const target = condition.controller === "opponent" ? opponent : player;
    const cmp = condition.cmp || "gte";
    const amount = condition.amount ?? 0;
    const n = target.life;
    return cmp === "lte" ? n <= amount : cmp === "eq" ? n === amount : n >= amount;
  }
  if (condition.op === "revealedMatches") {
    // E-XC1(X-CP02 コスモドラグーン reveal-gate): 直前に revealTopCard で公開したカード(context.revealedCard)が
    // filter に一致するか。script の ifCondition と effects[] の effect.conditions の両方に context 経由で届く
    //（ifConditionForScript は checkCondition(cond, owner, context)、effect ゲートは checkCardConditions(...,{...context}) を通す）。
    // 公開カードはデッキ上に残っている(peek)ので matchesCardFilter の属性/名称照合はゾーンに依存せず成立する。
    return context.revealedCard ? matchesCardFilter(context.revealedCard, condition.filter || {}) : false;
  }
  if (condition.op === "ownLifeGreaterThanOpponent") {
    // E-XC5(X-CP02/0013 ヴァルカン):「君のライフが相手より多いなら」＝self>opponent の厳密大なり（同値は不成立）。
    // lifeDifferenceGte(opponent−self≥N＝相手優位方向)の鏡＝自優位方向。効果列途中の評価は直前増減を反映した現在値。
    return player.life > opponent.life;
  }
  if (condition.op === "lifeDifferenceGte") {
    // E9(D-BT03/0013 餓狼深気功): 「相手のライフが君のライフより amount 以上多いなら」＝
    // (相手ライフ − 自ライフ) >= amount の相対差分条件（owner基準。既存 lifeLte/opponentLifeLte は
    // 固定値比較のみで差分は表現不可だった）。効果列の途中で評価される場合は直前の増減を反映した現在値。
    return opponent.life - player.life >= (condition.amount ?? 1);
  }
  if (condition.op === "pileCountDifferenceGte") {
    // E-PR5(PR/0332 キラーオーダー): 「相手の<pile>が君の<pile>より amount 以上多いなら」＝
    // (相手の pile 枚数 − 自分の pile 枚数) >= amount。lifeDifferenceGte（直上）の pile 汎化で、向き
    // (opponent − self)・命名(…DifferenceGte)を踏襲する。pile 既定 gauge。filter 指定時は両側とも一致
    // カードのみ数える（cardCount と同じ pile 解決・matchesCardFilter）。効果列の途中で評価される場合は
    // 直前の増減を反映した現在値（「2枚ゲージに置く。さらに〜多いなら」の後段ゲート）。既存カードはこの op を
    // 持たない＝挙動不変（新規 op・DB使用は PR/0332 のみ）。
    const diffPile = condition.pile || "gauge";
    const countPile = (pl) => {
      if (!pl) return 0;
      let cards;
      if (diffPile === "field") cards = [...zones.map((z) => pl.field[z]).filter(Boolean), ...phantomFieldMonsters(pl)];
      else if (diffPile === "item") cards = equippedItems(pl);
      else if (diffPile === "center") cards = pl.field.center ? [pl.field.center] : [];
      else if (diffPile === "soul") cards = zones.flatMap((z) => pl.field[z]?.soul || []);
      else cards = pl[diffPile] || [];
      return condition.filter ? cards.filter((c) => matchesCardFilter(c, condition.filter)).length : cards.length;
    };
    return countPile(opponent) - countPile(player) >= (condition.amount ?? 1);
  }
  if (condition.op === "costDiscardedCardMatches") {
    // E-PR6(PR/0281 ルア・ノヴァ): 「このカードの【使用コスト】で捨てたカードが filter に一致するなら」。
    // useHandAbilityAction が payStructuredCostWithSelection の payment.discarded を context.costDiscardedCards
    // として伝播する（宣言→対抗窓→解決を跨ぐため pendingAction 経由でも保持）。1枚でも一致すれば真（some）。
    // 捨てたカードはドロップに在るが matchesCardFilter は在ゾーン非依存で world/属性等を照合する。
    // 既存カードはこの op を持たない＝挙動不変（新規 op・DB使用は PR/0281 のみ）。
    return (context.costDiscardedCards || []).some((c) => matchesCardFilter(c, condition.filter || {}));
  }
  if (condition.op === "deckMilledThisTurn") {
    // E8(D-CBT/PR-0330 追撃者 アビゲール):「このターン中、<deckOwner>のデッキのカードがドロップに
    // 置かれているなら」。state.turnDeckMilled[席] はデッキ所有者ごとのターン内ミル枚数
    // （queueDeckMilledTriggers=deckMilled 発火点で常時集計・clearTurnModifiers でリセット・src/07/11）。
    // deckOwner を owner 視点で席へ解決する（"opponent"=相手のデッキ / 既定 "self"=自分のデッキ）。
    // amount 既定=1（「1枚以上置かれているなら」）。
    const milledSeat = condition.deckOwner === "opponent" ? 1 - owner : owner;
    return (state.turnDeckMilled?.[milledSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "gaugePlacedThisTurnLte") {
    // E-XB12(X-CP03/0069 影雄 グラウ):「このターン中、<controller>のゲージにカードが置かれていないなら」。
    // state.gaugePlacedThisTurn[席]=席別のターン内ゲージ流入枚数（noteGaugePlaced=全ゲージ流入点で集計・
    // clearTurnModifiers でリセット・src/07/11）。controller を owner 視点で席へ解決（"opponent"=相手 / 既定 self）。
    // amount 既定=0（「置かれていないなら」= 0枚以下）。deckMilledThisTurn(E8)と同型・?. ガードで旧state 非throw。
    const gaugeSeat = condition.controller === "opponent" ? 1 - owner : owner;
    return (state.gaugePlacedThisTurn?.[gaugeSeat] || 0) <= (condition.amount ?? 0);
  }
  if (condition.op === "damageTakenThisTurn") {
    // E-X2(X-SD02/0016 クリスタル・フローレス・シュート！):「このターン中、<damageOwner>がダメージを受けているなら」。
    // state.turnDamageTaken[席]=席別のターン内被ダメージ累積（applyDamageToPlayer=全ダメージ funnel の実適用点で
    // 軽減/無効化後の実ダメージのみ加算・src/04。payLife 等コスト直減算は funnel 外＝非計上）。damageOwner を owner
    // 視点で席へ解決（"opponent"=相手 / 既定 "self"=自分）。amount 既定=1（「1以上受けているなら」）。0016 の
    // 「君がダメージを受けていなくて」は {op:"not", condition:{op:"damageTakenThisTurn"}} で否定合成する
    // （self が0ダメージ＝真）。deckMilledThisTurn(E8)と同型・?. ガードで旧state 非throw。
    const damagedSeat = condition.damageOwner === "opponent" ? 1 - owner : owner;
    return (state.turnDamageTaken?.[damagedSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "spellCastThisTurnGte") {
    // E-XB9(X-SS03/0017 セフィロトの講義):「このターン中、<controller>が魔法を使っているなら」。
    // state.spellsCastThisTurn[席]=席別のターン内魔法使用回数（recordSpellCastThisTurn=全 spellCast funnel で
    // 加算・clearTurnModifiers でリセット・src/07/11）。controller を owner 視点で席へ解決（"opponent"=相手 /
    // 既定 "self"=自分）。amount 既定=1（「1回以上使っているなら」）。deckMilledThisTurn(E8)と同型・?. ガードで旧state 非throw。
    const casterSeat = condition.controller === "opponent" ? 1 - owner : owner;
    return (state.spellsCastThisTurn?.[casterSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "handDiscardedByEffectThisTurnMatches") {
    // E-XB10(X-SS03/0048 シャインブレイド・ジョーカー):「このターン中、カードの効果で <controller> の手札の
    // カードが捨てられているなら」。state.turnHandDiscardedByEffect[席]=席別のターン内「効果で捨てられた手札枚数」
    // （discardHandCardsToDrop=手札→ドロップの唯一合流点で cause.byEffect のみ加算＝コスト捨て/byCost は非計上。
    // clearTurnModifiers でリセット・src/11）。controller を owner 視点で席へ解決（"opponent"=相手 / 既定 "self"=自分）。
    // amount 既定=1。E8 deckMilledThisTurn の鏡・?. ガードで旧state 非throw。
    const discardedSeat = condition.controller === "opponent" ? 1 - owner : owner;
    return (state.turnHandDiscardedByEffect?.[discardedSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "ownCenterEmpty") {
    return !player.field.center;
  }
  if (condition.op === "ownCenterHasAttribute") {
    return Boolean(player.field.center?.attributes?.includes(condition.attribute));
  }
  if (condition.op === "bothCentersEmpty") {
    return !player.field.center && !opponent.field.center;
  }
  if (condition.op === "opponentCenterEmpty") {
    return !opponent.field.center;
  }
  if (condition.op === "ownDropCardCountGte") {
    return player.drop.filter((card) => matchesCardFilter(card, condition.filter || {})).length >= (condition.amount || 1);
  }
  if (condition.op === "sourceZoneIn") {
    const sourceZone = context.zone ?? state.selected?.zone;
    const sourceOwner = context.owner ?? state.selected?.owner;
    return sourceOwner === owner && condition.zones?.includes(sourceZone);
  }
  if (condition.op === "pendingBattleInvolvesSelf") {
    // S-UB-C03/0083「このカードのバトル中」: 発生源カードが進行中のバトル(pendingAttack)の
    // 攻撃側 or 防御対象に含まれているときのみ真。fieldAbilityUsable が context.card を渡す。
    const source = context.card || getSelectedCard();
    return Boolean(source?.instanceId && pendingBattleCardIds().has(source.instanceId));
  }
  if (condition.op === "sourceStanding") {
    const source = context.card || getSelectedCard();
    return Boolean(source && !source.used);
  }
  if (condition.op === "sourceSoulHasAttribute") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).some((card) => card.attributes?.includes(condition.attribute));
  }
  if (condition.op === "sourceSoulCountGte") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).length >= condition.amount;
  }
  if (condition.op === "sourceSoulMatchingCountGte") {
    // 発生源のソウルのうち filter 一致の枚数が amount 以上か（0030の勝利条件系）。
    const source = context.card || getSelectedCard();
    const n = (source?.soul || []).filter((card) => matchesCardFilter(card, condition.filter || {})).length;
    return n >= (condition.amount || 1);
  }
  if (condition.op === "sourceSoulHasSameSizeAsEntered") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).some((card) => (card.size || 0) === (context.enteredCard?.size || 0));
  }
  if (condition.op === "selfStatGte" || condition.op === "selfStatLte") {
    // E-XB51②(X-CBT01/0074 轟天覇王拳 ドラグランブル「このカードの攻撃力が10000以上なら」): 発生源カード自身の
    // 現在値（visible stat＝印字＋バトル/ターン/継続バフ）の閾値判定。bare event:"attack" 等の文脈で
    // context.card（＝攻撃したこのカード）を安全に読む。stat: power(攻撃力)/defense(防御力)/critical(打撃力)。
    // powerGte が matchesTargetFilter 経由で sameInstanceAsSource を解釈しない穴を埋める source 限定版。
    const source = condition.ref ? resolveEffectReference(condition.ref, context)?.card : (context.card || getSelectedCard());
    if (!source) return false;
    const stat = condition.stat || "power";
    const value = stat === "defense" ? visibleDefense(source) : stat === "critical" ? visibleCritical(source) : visiblePower(source);
    const amount = condition.amount ?? 0;
    return condition.op === "selfStatLte" ? value <= amount : value >= amount;
  }
  if (condition.op === "sourceSoulWorldCountGte") {
    // E-XB47(X-CBT01/0038 ぶんぶく師匠 本気モード！): 「このカードのソウルのカードのワールド名がN種類以上なら」。
    // 発生源カード自身のソウルの distinct ワールド種類数（cardWorlds() で2ワールド持ちは両ワールドを算入＝
    // cardCount の distinct:"distinctByWorld"／amountFrom distinctWorldCount と同ロジックの source 限定版）。
    // 場の全モンスターのソウルを合算する pile:"soul" 系と違い、context.card のソウルだけを見る。
    const source = context.card || getSelectedCard();
    const n = new Set((source?.soul || []).flatMap((card) => cardWorlds(card))).size;
    return n >= (condition.amount || 1);
  }
  if (condition.op === "hostMatches") {
    return Boolean(
      context.hostCard &&
        matchesTargetFilter(
          context.hostCard,
          context.hostOwner ?? owner,
          context.hostZone,
          condition.filter || {},
        ),
    );
  }
  if (condition.op === "castFromSoulHostMatches") {
    // E-XB50(X-CBT01/0030 秘剣 斬流雷牙「このカードが『秘剣 絶命陣』のソウルから使われていたなら」):
    // E-XB45 soul-cast のホスト（finalizeSoulSpellCast→pendingAction.hostCard→resolvePendingSpell の
    // context.hostCard）を filter で照合する。通常の手札魔法（hostCard 無し）は false ＝当該条項が発火しない
    // （後方互換: 手札から使った 0030 はこの節を満たさず、ゲージ加速の追加報酬を得ない）。nameIncludes 等対応。
    return Boolean(context.hostCard && matchesCardFilter(context.hostCard, condition.filter || {}));
  }
  if (condition.op === "enteredCardMatches") {
    if (condition.excludeSource && context.enteredCard?.instanceId === context.card?.instanceId) {
      return false;
    }
    // sameInstanceAsSource 等の相対キー(設置時の自己限定など)を解釈するため relative 版で評価。
    return Boolean(context.enteredCard && matchesRelativeCardFilter(context.enteredCard, condition.filter || {}, context));
  }
  if (condition.op === "enteredZoneIn") {
    return condition.zones?.includes(context.enteredZone);
  }
  if (condition.op === "ownFieldMonsterAttributeSizeGte") {
    const real = fieldZones.some((zone) => {
      const card = player.field[zone];
      return (
        card &&
        effectiveCardType(card) === "monster" &&
        card.attributes?.includes(condition.attribute) &&
        (card.size || 0) >= condition.size
      );
    });
    return (
      real ||
      phantomFieldMonsters(player).some(
        (p) => p.attributes.includes(condition.attribute) && (p.size || 0) >= condition.size,
      )
    );
  }
  if (condition.op === "ownFieldHasBuddy") {
    return hasBuddyOnField(player);
  }
  if (condition.op === "buddyMatches") {
    // 登録バディモンスター（場の有無に関係なく）がフィルタに一致するか。
    return Boolean(player?.buddy && matchesCardFilter(player.buddy, condition.filter || {}));
  }
  if (condition.op === "ownFieldHasAttribute") {
    return (
      zones.some((zone) => player.field[zone]?.attributes?.includes(condition.attribute)) ||
      phantomFieldMonsters(player).some((p) => p.attributes.includes(condition.attribute))
    );
  }
  if (condition.op === "ownAttributeAttackDestroyedCountGte") {
    // このターン、自分の指定attributeの攻撃で破壊した相手モンスター数 >= amount。
    const count = state.attackDestroyedByAttribute?.[owner]?.[condition.attribute] || 0;
    return count >= (condition.amount || 1);
  }
  if (condition.op === "flagNameIs") {
    // E12(D-SS02/0005 未来占星術): ターン限定エイリアス（addTurnFlagNameAlias「フラッグは「X」としても扱う」）
    // も真とする。エイリアスは flagNameIs 専用で、カード使用可否(canUseCardForFlag)には効かない。
    // E-XB44: フラッグが裏（flagFaceDown）ならフラッグ名は成立しない（機能停止＝フラッグに書かれた条件を満たさない）。
    if (state.players[owner]?.flagFaceDown) {
      return false;
    }
    return (
      state.players[owner]?.flag?.name === condition.name ||
      (state.turnFlagNameAliases?.[owner] || []).includes(condition.name)
    );
  }
  if (condition.op === "ownHandCountGte") {
    return player.hand.length >= condition.amount;
  }
  if (condition.op === "ownFieldCardExists") {
    const candidateZones = condition.zones || zones;
    return (
      candidateZones.some((zone) => {
        const card = player.field[zone];
        return card && matchesTargetFilter(card, owner, zone, condition.filter || {});
      }) ||
      // zones を限定していない（場全体を問う）場合のみ仮想モンスターも参照する
      (!condition.zones && phantomFieldMonsters(player).some((p) => matchesCardFilter(p, condition.filter || {})))
    );
  }
  if (condition.op === "ownOtherFieldCardExists") {
    const candidateZones = condition.zones || zones;
    return candidateZones.some((zone) => {
      const card = player.field[zone];
      return (
        card &&
        card.instanceId !== context.card?.instanceId &&
        matchesTargetFilter(card, owner, zone, condition.filter || {})
      );
    });
  }
  if (condition.op === "ownFieldCardCountGte") {
    const candidateZones = condition.zones || zones;
    return candidateZones.filter((zone) => {
      const card = player.field[zone];
      return card && matchesTargetFilter(card, owner, zone, condition.filter || {});
    }).length >= condition.amount;
  }
  if (condition.op === "opponentFieldCardCountLte") {
    const candidateZones = condition.zones || zones;
    return candidateZones.filter((zone) => {
      const card = opponent.field[zone];
      return card && matchesTargetFilter(card, 1 - owner, zone, condition.filter || {});
    }).length <= condition.amount;
  }
  if (condition.op === "ownDropAttributeCountGte") {
    return player.drop.filter((card) => card.attributes?.includes(condition.attribute)).length >= condition.amount;
  }
  if (condition.op === "ownDropAttributeSumCountGte") {
    // 指定属性のいずれかを持つドロップの札数（和集合＝両属性持ちは1枚として数える）が amount 以上か。
    const attrs = condition.attributes || [];
    const total = player.drop.filter((card) =>
      attrs.some((attr) => card.attributes?.includes(attr)),
    ).length;
    return total >= condition.amount;
  }
  if (condition.op === "enteredFromZoneIn") {
    // コールされたカードの発生元ゾーンを判定（resolvePendingCall="hand"、scriptコール系=entry.source を記録）。
    const entered = context.enteredCard || context.card || getSelectedCard();
    return Boolean(entered && (condition.zones || []).includes(entered.enteredFromZone));
  }
  if (condition.op === "eventCardIsSource") {
    // フィールドイベント（allyMove/allyDealDamage 等）の主体カードが能力の発生源自身か。
    const eventCard =
      context.eventCard?.card || context.eventFieldCard || context.destroyedCard || context.enteredCard;
    return Boolean(eventCard && context.card && eventCard.instanceId === context.card.instanceId);
  }
  if (condition.op === "eventDestroyerIsSelf") {
    // opponentDestroyed/allyDestroyed 誘発時、破壊を起こした側が listener(owner) 自身か（「君のカードで破壊された時」0030）。
    return context.destroyCause?.sourceOwner === owner;
  }
  if (condition.op === "eventDestroyerMatches") {
    // opponentDestroyed/allyDestroyed 誘発時、破壊を起こした側(sourceCard)が controller/filter に一致するか。
    // 「君の場の《ヒーロー》が相手のモンスターを破壊した時」等。battle破壊=attacker、効果破壊=makeEffectCause の context.card が sourceCard。
    const cause = context.destroyCause;
    if (!cause?.sourceCard) return false;
    if (condition.controller === "self" && cause.sourceOwner !== owner) return false;
    if (condition.controller === "opponent" && cause.sourceOwner === owner) return false;
    return matchesCardFilter(cause.sourceCard, condition.filter || {});
  }
  if (condition.op === "eventDestroyCauseMatches") {
    // 破壊の原因で誘発を絞る（相手のカードで/効果で/発生源種別）。
    // context.destroyCause は自身の destroyed / ally|opponentDestroyed の双方で参照可能。
    // バトル破壊は byBattle のみ(byEffect/sourceType 無し)なので、byEffect や sourceType 指定の条件は自動的に不成立になる。
    const cause = context.destroyCause;
    if (!cause) return false;
    if (condition.byEffect && !cause.byEffect) return false;
    if (condition.byOpponent && !cause.byOpponent) return false;
    if (condition.sourceType && cause.sourceType !== condition.sourceType) return false;
    return true;
  }
  if (condition.op === "eventRestCauseMatches") {
    // Z14(a)(S-UB-C03/0014): 相手のカードが「君のカードの効果で」レストした時、を判定する。
    // context.restCause は restTarget(15)/restSelectedForScript(14) が makeEffectCause で伝播する。
    // 攻撃レスト(reason:"attack")は restCause を伝播しないため自動的に不成立になる（対象外仕様）。
    const cause = context.restCause;
    if (!cause?.byEffect) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventStandCauseMatches") {
    // E9(D-CBT/0109 シェイクハンズ・ドラゴン): ally/opponentStand 誘発時、スタンドの起因を照合する。
    // context.standCause は queueStandTriggers（効果スタンド経路のみ・src/07）が伝播する。
    // ターン開始スタンド(standPlayer)・多回攻撃キーワードのスタンド(src/10)はそもそもブロードキャスト
    // されないため自動的に不成立（rest の reason:"attack" 対象外と同思想）。eventRestCauseMatches の鏡。
    const cause = context.standCause;
    if (!cause?.byEffect) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventReturnCauseMatches") {
    // Z14(b)(S-UB-C03/0017): 相手の場のカードが「君のカードの効果で」手札に戻った時、を判定する。
    // context.returnCause は returnToHand/returnAllToHand(15)・returnFieldTargetToHand(08)が伝播する。
    const cause = context.returnCause;
    if (!cause?.byEffect) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventMillCauseMatches") {
    // E5(D-BT04/0039 サクシヲン・0098 ノルド): ally/opponentDeckMilled 誘発時、ミルの起因を照合する。
    // context.millCause は queueDeckMilledTriggers（デッキ→ドロップの各ミル経路）が伝播する。
    // 既定は「効果によるミル」（byEffect）のみ。allowCost:true でコスト起因（byCost）も許容。
    // sourceController:"self"=「君のカードの効果で」（起因席が listener 自身）。filter は起因カード照合。
    const cause = context.millCause;
    if (!cause) return false;
    if (!(cause.byEffect || (condition.allowCost && cause.byCost))) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventDiscardCauseMatches") {
    // E6(D-BT04/0104 戦闘詩人 レポーティング): discardedFromHand 誘発時、捨ての起因を照合する。
    // context.discardCause は discardHandCardsToDrop（src/11）へ各経路が渡す（効果op=makeEffectCause／
    // コストstep=byCost。ターン終了時などルール由来の捨ては cause 無し＝不成立）。
    // ★DB では「捨ててよい。捨てたら」型（公式には効果）を cost step でエンコードしている（D-EB02 戦闘詩人
    // トーキング等）ため、この型を拾うリスナーは allowCost:true を併用する（残差: 純粋な【使用コスト】の
    // 手札捨てとの弁別は不可＝過発火し得るが、該当 filter を持つ実カードでは実害なし）。
    const cause = context.discardCause;
    if (!cause) return false;
    if (!(cause.byEffect || (condition.allowCost && cause.byCost))) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventAttackersInclude") {
    // Z14(f)(S-UB-C03/0022,0029): この攻撃(連携含む)の攻撃者一覧に filter 一致のカードが含まれるか。
    // context.attackers は runAttackDeclarationTriggers(09)の"attack"誘発コンテキストに乗る（本Batch0で追加）。
    // 未指定時（"attack"イベント以外からの参照等）は state.pendingAttack から補完する。
    const attackers = context.attackers || getPendingAttackers();
    return attackers.some((a) => {
      if (condition.excludeSelf && a.card?.instanceId === context.card?.instanceId) return false;
      return matchesCardFilter(a.card, condition.filter || {});
    });
  }
  if (condition.op === "attacksThisTurnGte") {
    // Z7(S-UB-C03/0047,0052): このターン中に行われた攻撃回数(state.attacksThisTurn、グローバル・
    // ターン切替でリセット)がamount以上か。連携攻撃は1回と数える（09-attack.js の加算箇所と同一カウンタ）。
    return (state.attacksThisTurn || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "lastDestroySucceeded") {
    // 直前の destroy op が実際に破壊を成立させたか（ソウルガード/破壊耐性で生存した場合は false）。
    // 「破壊し、そうしたら…」の報酬効果を破壊成立時のみ実行するためのゲート。
    return Boolean(context.lastDestroyed);
  }
  if (condition.op === "opponentCalledFromHand") {
    // E-XV4(X-UB02/0059 エフゴ・アタック): 直前の opponentMayCallFromHand で相手が実際にコールを成立させたか。
    // 「コールしたら、君はゲージ１を払ってよい。払ったら、このカードを手札に戻す」の後続分岐ゲート
    // （lastDestroySucceeded と同じ context フラグ方式。辞退/候補なし/コスト不能なら false）。
    return Boolean(context.opponentCalledFromHand);
  }
  if (condition.op === "damageSourceLabelIs") {
    // opponentDamagedByEffect 誘発時、ダメージ発生源能力のラベル(“爆雷”等)一致を判定（爆雷連鎖）。
    return context.damageSourceLabel === condition.label;
  }
  if (condition.op === "movedToDropMatches") {
    // この解決中に context.movedToDrop へ置かれたカードのいずれかが filter に一致するか（moveTopDeckToDrop 等）。
    return (context.movedToDrop || []).some((card) => matchesCardFilter(card, condition.filter || {}));
  }
  if (condition.op === "milledContains") {
    // G1(D-EB01/0050): 直前のミル(context.milled)に filter 一致カードが含まれるか
    //（「その中にモンスターがあるなら」）。context.movedToDrop（累積）ではなく最新ミルのみを見る。
    return (context.milled || []).some((card) => matchesCardFilter(card, condition.filter || {}));
  }
  if (condition.op === "milledMatchCountGte") {
    // E7(D-BT03/0011/0051): 直前のミル(context.milled)に filter 一致カードが amount 枚以上あるか
    //（「その中に…モンスター２枚以上があるなら」）。milledContains(1枚以上)の閾値一般形で、
    // 文脈規約も同じ（movedToDrop 累積ではなく最新ミルのみ）。amount 省略時は1＝milledContains と同義。
    const milledMatched = (context.milled || []).filter((card) => matchesCardFilter(card, condition.filter || {})).length;
    return milledMatched >= (condition.amount ?? 1);
  }
  if (condition.op === "milledDistinctAttributeCountGte") {
    // G1(D-EB01/0029): 直前のミル(context.milled)に含まれるカードの「属性」の異なり数が amount 以上か
    //（「その中のカードの属性が4種類以上なら…」。段階判定は effect.conditions に amount:4/6/9 を並べる）。
    const attrs = new Set();
    (context.milled || []).forEach((card) => {
      (card.attributes || []).forEach((attribute) => attrs.add(attribute));
    });
    return attrs.size >= condition.amount;
  }
  if (condition.op === "ownItemIsMonster") {
    // 君のアイテム枠のカードが（元）モンスター＝『変身』か『搭乗』している状態か（equipSelfはcurrentTypeのみitem化）。
    return equippedItems(player).some((item) => item.currentType === "item" && item.type === "monster");
  }
  if (condition.op === "monstersDestroyedThisTurnGte") {
    // このターン中に破壊された controller 側モンスターの総数（攻撃・効果問わず）が amount 以上か。
    const counts = state.monstersDestroyedThisTurn || [0, 0];
    const idx = condition.controller === "opponent" ? 1 - owner : owner;
    return (counts[idx] || 0) >= condition.amount;
  }
  if (condition.op === "destroyedThisTurnMatchingCountGte") {
    // このターン中に controller 側で破壊されたカードのうち filter に一致する枚数が amount 以上か
    // （H-EB04/0021「このターン2体以上どくろ武者破壊」等）。破壊時に凍結したサイズ(sizeAtDestroy)で判定する。
    const idx = condition.controller === "opponent" ? 1 - owner : owner;
    const entries = state.destroyedCardsThisTurn?.[idx] || [];
    const matched = entries.filter((entry) =>
      matchesCardFilter(entry.card, condition.filter || {}, { effectiveSizeOverride: entry.sizeAtDestroy }),
    ).length;
    return matched >= condition.amount;
  }
  if (condition.op === "standedByEffectThisTurnMatches") {
    // E-PR16(PR/0470 ボーナス節): このターン中に controller 側の場のカードが「効果で」スタンドしたか。
    // destroyedThisTurnMatchingCountGte の sibling。記帳は queueStandTriggers(src/07)＝効果スタンド専用経路
    // （通常のターン開始スタンド/多回攻撃スタンドは含まれない）。原文「相手の場のカードが〜」に忠実なよう、
    // 記帳した instanceId が現在も controller の場に在るものだけを数える（場を離れたカードは対象外）。
    // filter 省略時は種別不問（PR/0470 は controller だけを見る）。amount 省略時は1枚以上。
    const idx = condition.controller === "opponent" ? 1 - owner : owner;
    const ids = state.standedByEffectThisTurn?.[idx] || [];
    if (ids.length === 0) {
      return false;
    }
    const controllerPlayer = state.players[idx];
    const matched = zones
      .map((zone) => controllerPlayer?.field?.[zone])
      .filter((card) => card && ids.includes(card.instanceId) && matchesCardFilter(card, condition.filter || {}))
      .length;
    return matched >= (condition.amount || 1);
  }
  if (condition.op === "isFirstBattleEndWindow") {
    // 「(相手のターン中、)1回目のバトル終了時に使える」(ヴァイシュタッツ 0095) の近似。
    // アプリの対抗ウィンドウはバトル解決前(pendingAttack中)のため、1回目のバトル(attacksThisTurn===1)の
    // 対抗ウィンドウで true を返す（厳密な「バトル終了時」より僅かに早いが、アタックフェイズ終了の意図は満たす）。
    return Boolean(state.pendingAttack) && (state.attacksThisTurn || 0) === 1;
  }
  if (condition.op === "isNthBattleEndWindow") {
    // E-XB35(X-BT04/0092 フェイズシール・チェイン): 「相手のアタックフェイズ中、N回目のバトル終了時に使える」。
    // isFirstBattleEndWindow(N=1) の一般化。対抗ウィンドウはバトル解決前(pendingAttack中)のため、N回目のバトルの
    // 対抗ウィンドウ（attacksThisTurn===N）で true。連携攻撃は1回と数える（09-attack の加算箇所と同一カウンタ）。
    // amount 省略時は1＝isFirstBattleEndWindow と同義。
    const n = condition.amount ?? 1;
    return Boolean(state.pendingAttack) && (state.attacksThisTurn || 0) === n;
  }
  if (condition.op === "ownDropDistinctAttributeCountGte") {
    const names = new Set(
      player.drop
        .filter((card) => card.attributes?.includes(condition.attribute))
        .map((card) => card.name),
    );
    return names.size >= condition.amount;
  }
  if (condition.op === "ownDropHasCardName") {
    return player.drop.some((card) => card.name === condition.name);
  }
  if (condition.op === "ownDropHasCard") {
    return player.drop.some((card) => matchesCardFilter(card, condition.filter || {}));
  }
  if (condition.op === "ownDropDistinctCardCountGte") {
    const names = new Set(
      player.drop
        .filter((card) => matchesCardFilter(card, condition.filter || {}))
        .map((card) => card.name),
    );
    return names.size >= condition.amount;
  }
  if (condition.op === "recentLifeLinkMatches") {
    return Boolean(findRecentLifeLinkEvent(owner, condition));
  }
  if (["specialCallOpportunityMatches", "temporaryCallOpportunityMatches"].includes(condition.op)) {
    return Boolean(findSpecialCallOpportunity(owner, condition));
  }
  if (condition.op === "movedToDropHasSameSizeAsEntered") {
    return (context.movedToDrop || []).some((card) => (card.size || 0) === (context.enteredCard?.size || 0));
  }
  if (condition.op === "opponentHandCountLte") {
    return opponent.hand.length <= condition.amount;
  }
  if (condition.op === "opponentHandCountGte") {
    return opponent.hand.length >= condition.amount;
  }
  if (condition.op === "damageSourceMatches") {
    return Boolean(context.damageSource?.card && matchesCardFilter(context.damageSource.card, condition.filter || {}));
  }
  if (condition.op === "eventCardMatches") {
    const eventCard = context.eventCard?.card || context.destroyedCard || context.enteredCard;
    return Boolean(eventCard && matchesCardFilter(eventCard, condition.filter || {}));
  }
  if (condition.op === "eventCardInFrontOfSource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        context.eventOwner !== sourceSlot.owner &&
        context.eventZone === oppositeFieldZone(sourceSlot.zone),
    );
  }
  if (condition.op === "pendingAttackByOpponentItem") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && effectiveCardType(attacker.card) === "item",
    );
  }
  if (condition.op === "pendingAttackByOpponentMonster") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && effectiveCardType(attacker.card) === "monster",
    );
  }
  if (condition.op === "pendingAttackByOpponentCardMatches") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "pendingAttackBySource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        getPendingAttackers().some((attacker) => sameSlot(attacker, sourceSlot)),
    );
  }
  if (condition.op === "selfIsNullifiedAttacker") {
    // D-SS03/0022 複製黒竜 アビゲール「このカードの攻撃が無効化された時」の自己限定用。
    // allyAttackNullified は「君の場のカードの攻撃が無効化された時」を場全体へ配送する（発火時点では
    // nullifyPendingAttack が既に clearPendingAttack 済み＝pendingAttack は null なので pendingAttackBySource は使えない）。
    // 直前の無効化された攻撃の攻撃側スロットを state.lastAttackOutcome.attackers に凍結してあるので、
    // それに context.card（=この listener）のスロットが含まれるかで「自分の攻撃が無効化された時」だけに絞る。
    const outcome = state.lastAttackOutcome;
    if (!outcome?.nullified) {
      return false;
    }
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(sourceSlot && (outcome.attackers || []).some((slot) => sameSlot(slot, sourceSlot)));
  }
  if (condition.op === "nullifiedAttackerMatches") {
    // E-XB30(X-SS04/0033 第2能力・X-BT02/0052 忠実化): 「君の場の《妖精》の攻撃が無効化された時」等、無効化された
    // 攻撃者にサブタイプ/ゾーン限定がある allyAttackNullified 誘発のゲート。allyAttackNullified は
    // fireAllyAttackNullifiedTriggers(src/10)が無効化された攻撃側プレイヤーの場札全てへ一律配送するブロードキャストで、
    // context には「どのカードが無効化された攻撃者か」の情報が乗らない（selfIsNullifiedAttacker は「自分自身が攻撃者か」・
    // lastAttackNullified は陣営 self/opponent のみ判定でカード filter は評価しない）。ここでは直前の無効化攻撃の攻撃側
    // スロット(state.lastAttackOutcome.attackers＝{owner,zone} 凍結)を場札へ解決し、filter/zone 一致の攻撃者が
    // いるかを判定する。攻撃無効化ではカードは移動しない（nullifyPendingAttack が used=true にするのみ）ため、発火時点で
    // スロットの札はなお攻撃者本人。zone=攻撃元ゾーン限定（0033「センターのモンスター」）・filter=カード条件一致
    // （0052「《妖精》」）。allyAttackNullified は攻撃側の場札のみへ配送されるため attackers[].owner は必ず listener の
    // owner＝「君の場の」限定は自然に満たされる（別途 owner ゲートは不要）。
    const outcome = state.lastAttackOutcome;
    if (!outcome?.nullified) {
      return false;
    }
    return (outcome.attackers || []).some((slot) => {
      if (condition.zone && slot.zone !== condition.zone) {
        return false;
      }
      const attackerCard = state.players[slot.owner]?.field?.[slot.zone];
      return Boolean(attackerCard && matchesCardFilter(attackerCard, condition.filter || {}));
    });
  }
  if (condition.op === "lastAttackNullified") {
    // E-Y5(X-BT01/0088 軍師の計略): 「(君の)攻撃が無効化されたバトルの終了時に使える」を、発生源スロット
    // 非依存で判定する（0088 は手札の対抗呪文＝findFieldCardSlot は常に偽のため selfIsNullifiedAttacker は使えない）。
    // 窓管理: lastAttackOutcome は次の攻撃解決(finishPendingAttack/nullifyPendingAttack)で必ず上書きされ、
    // 無効化されなかったバトルでは nullified:false になる＝「次の攻撃成立後/無効化なしのバトル後」は自然に不可。
    // 加えて turnCount で同ターンに限定し、攻撃無しでターンを跨いで真のまま残らないようにする。
    const outcome = state.lastAttackOutcome;
    if (!outcome?.nullified || outcome.turnCount !== state.turnCount) {
      return false;
    }
    const controller = condition.attackerController || "self";
    if (controller === "any") {
      return true;
    }
    // attackers スロットの owner で攻撃側の陣営を判定（self=owner の攻撃・opponent=相手の攻撃）。
    return (outcome.attackers || []).some((slot) =>
      controller === "opponent" ? slot.owner !== owner : slot.owner === owner,
    );
  }
  if (condition.op === "lastAttackTargetMatches") {
    // E-PR13(PR/0382 使用タイミング「君のセンターのモンスターが攻撃されたバトルの終了時に使える」):
    // 直前に解決したバトルの被攻撃側(state.lastAttackOutcome.targetOwner/targetZone)を owner/zone で判定する。
    // lastAttackNullified(E-Y5/0088)と同系統・同窓管理: lastAttackOutcome は次の攻撃解決で必ず上書きされ、
    // turnCount で同ターンに限定する（攻撃無しでターンを跨いで真のまま残らない）。useConditions から使う。
    const outcome = state.lastAttackOutcome;
    if (!outcome || outcome.turnCount !== state.turnCount) {
      return false;
    }
    // owner: 被攻撃側の陣営（self=owner の被攻撃・opponent=相手の被攻撃）。fighter 攻撃(targetZone=null)は
    // zone 指定で自然に外れる。owner 未指定は陣営不問。
    if (condition.owner === "self" && outcome.targetOwner !== owner) {
      return false;
    }
    if (condition.owner === "opponent" && outcome.targetOwner === owner) {
      return false;
    }
    if (condition.zone && outcome.targetZone !== condition.zone) {
      return false;
    }
    if (Array.isArray(condition.zoneIn) && !condition.zoneIn.includes(outcome.targetZone)) {
      return false;
    }
    return true;
  }
  if (condition.op === "pendingAttackIncludesOtherMatching") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return getPendingAttackers().some(
      (attacker) =>
        (!sourceSlot || !sameSlot(attacker, sourceSlot)) &&
        matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "pendingAttackTargetMatches") {
    const target = getPendingBattleTargetInfo(state.pendingAttack);
    return Boolean(target?.card && matchesTargetFilter(target.card, target.owner, target.zone, condition.filter || {}));
  }
  if (condition.op === "linkAttackWithBuddy") {
    const attack = context.attack || state.pendingAttack;
    const attackers = (attack?.attackers || [])
      .map((slot) => ({ ...slot, card: state.players[slot.owner]?.field?.[slot.zone] }))
      .filter(({ card }) => card);
    return (
      attackers.length > 1 &&
      attackers.some(({ owner: attackerOwner, card }) => card.name === state.players[attackerOwner]?.buddy?.name)
    );
  }
  if (condition.op === "pendingActionIsOpponent") {
    return Boolean(state.pendingAction && state.pendingAction.owner !== owner);
  }
  if (condition.op === "pendingActionKind") {
    return state.pendingAction?.kind === condition.kind;
  }
  if (condition.op === "pendingActionCardType") {
    return Boolean(state.pendingAction?.card && effectiveCardType(state.pendingAction.card) === condition.cardType);
  }
  if (condition.op === "pendingActionCardSizeLte") {
    return (state.pendingAction?.card?.size || 0) <= condition.amount;
  }
  if (condition.op === "pendingActionCardMatches") {
    // E11(D-CBT/0053 秘剣 滅竜陣): pendingAction 中のカードを matchesCardFilter でフル照合する汎用条件
    // （「相手が属性に「竜」か「ドラゴン」を含むモンスターをコールした時」= filter.attributeIncludesAny）。
    // 既存 pendingActionCardType/pendingActionCardSizeLte の一般化（cardType/attribute*/world/sizeIn 等の
    // 全 filter 語彙が使える）。既存カード使用0件＝挙動不変。
    return Boolean(state.pendingAction?.card && matchesCardFilter(state.pendingAction.card, condition.filter || {}));
  }
  if (condition.op === "pendingAttackTargetIs") {
    // 「相手のモンスター全てと相手に攻撃する」全体攻撃はファイターも攻撃対象に含むため、
    // fighter 指定の被弾条件（古竜の盾等）はこの攻撃にも反応できる。
    if (condition.targetType === "fighter" && state.pendingAttack?.attackAllIncludesFighter) {
      return true;
    }
    return state.pendingAttack?.targetType === condition.targetType;
  }
  if (condition.op === "pendingAttackTargetZone") {
    return state.pendingAttack?.targetZone === condition.zone;
  }
  if (condition.op === "pendingAttackNotLink") {
    return Boolean(state.pendingAttack && (state.pendingAttack.attackers?.length || 0) <= 1);
  }
  if (condition.op === "pendingAttackIsLink") {
    return Boolean(state.pendingAttack && (state.pendingAttack.attackers?.length || 0) > 1);
  }
  if (condition.op === "pendingAttackTargetIsSource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        state.pendingAttack &&
        state.pendingAttack.targetOwner === sourceSlot.owner &&
        state.pendingAttack.targetZone === sourceSlot.zone,
    );
  }
  if (condition.op === "pendingAttackDefenderIsSelf") {
    return state.pendingAttack?.defender === owner;
  }
  if (condition.op === "pendingAttackExists") {
    // F3(D-SS02/0005): 進行中の攻撃(state.pendingAttack)が有れば真（陣営不問）。手札対抗呪文を『自分の攻撃中』
    // にも使えるようにするゲート。pendingAttackDefenderIsSelf は防御側限定＝自ターンの攻撃コンボを封じてしまうため、
    // 「攻撃が進行中か」だけを見る。攻撃の無いメインフェイズでは偽になり、isCounterPlayTiming の先取り経路が
    // 対抗分岐を main で覆い隠す（draw 分岐を潰す）のを防ぐ。
    return Boolean(state.pendingAttack);
  }
  if (condition.op === "pendingActionResponderIsSelf") {
    // 相手が宣言したカード/効果(呪文・必殺技・起動能力等)の解決前の対抗窓で、自分が応答側(responder)か。
    // 黒竜の盾0101 のように「戦闘だけでなく相手の効果/必殺技のダメージにも対抗する」札を、
    // pendingAction 窓で使えるようにするための判定（preventNextDamage は解決前にセットされ、
    // 直後の効果解決の applyDamageToPlayer で消費される）。
    return state.pendingAction?.responder === owner;
  }
  if (condition.op === "lastDamageSourceMatches") {
    const event = state.counterEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    const sources = event.sources || (event.source ? [event.source] : []);
    return sources.some((source) => {
      if (condition.controller === "self" && source.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && source.owner === owner) {
        return false;
      }
      return Boolean(source.card && matchesCardFilter(source.card, condition.filter || {}));
    });
  }
  if (condition.op === "selfReceivedDamage") {
    // 「君がダメージを受けた時に使える」（五角の誓い H-BT03/0025 等）。
    // 戦闘ダメージ応答窓(counterEventWindow.kind==="damageDealt")で、自分が被弾者(defender)かつダメージ>0のとき真。
    const event = state.counterEventWindow;
    return Boolean(
      event &&
        event.turnCount === state.turnCount &&
        event.kind === "damageDealt" &&
        event.defender === owner &&
        (event.damage || 0) > 0,
    );
  }
  if (condition.op === "damageDealtThisTurnMatches") {
    // 既定は直近のダメージイベント(lastDamageEvent)のみを参照する（【対抗】応答ウィンドウ用途。
    // 「君が《武器》で相手にダメージを与えた時に使える」等はその戦闘の直後に使う想定）。
    // anyTimeThisTurn:true のカード（竜撃奥義 デュアル・ムービングフォース＝必殺技＝ファイナルフェイズで使用）は
    // 「武器がダメージを与えたターン中」を判定するため、当該ターンの全ダメージイベント(turnDamageEvents)を走査する。
    // lastDamageEvent は毎戦闘で上書きされ、武器ダメージの後に別のダメージが入ると発生源を見失うため。
    const events = condition.anyTimeThisTurn
      ? (state.turnDamageEvents && state.turnDamageEvents.length
          ? state.turnDamageEvents
          : state.lastDamageEvent
            ? [state.lastDamageEvent]
            : [])
      : state.lastDamageEvent
        ? [state.lastDamageEvent]
        : [];
    return events.some((event) => {
      if (!event || event.turnCount !== state.turnCount) {
        return false;
      }
      const sources = event.sources || (event.source ? [event.source] : []);
      return sources.some((source) => {
        if (condition.controller === "self" && source.owner !== owner) {
          return false;
        }
        if (condition.controller === "opponent" && source.owner === owner) {
          return false;
        }
        return Boolean(source.card && matchesCardFilter(source.card, condition.filter || {}));
      });
    });
  }
  if (condition.op === "lastEnteredCardMatches") {
    const event = state.enteredEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    return (event.entries || []).some((entry) => {
      if (condition.controller === "self" && entry.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && entry.owner === owner) {
        return false;
      }
      if (condition.zone && entry.zone !== condition.zone) {
        return false;
      }
      return Boolean(entry.card && matchesCardFilter(entry.card, condition.filter || {}));
    });
  }
  if (condition.op === "eventAttackersMatch") {
    return (context.attackers || []).some(
      (attacker) => attacker?.card && matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "sourceSoulCountGte") {
    return (context.card?.soul || []).length >= (condition.amount || 1);
  }
  if (condition.op === "lastDestroyedCardMatches") {
    const event = state.destroyedEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    return (event.entries || []).some((entry) => {
      if (condition.controller === "self" && entry.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && entry.owner === owner) {
        return false;
      }
      // X7(D-BT01/0114): 「君のカードの効果で破壊した時」= 効果破壊のみ・破壊した側の照合。
      if (condition.causeByEffect && !entry.cause?.byEffect) {
        return false;
      }
      if (condition.destroyerController === "self" && entry.cause?.destroyerOwner !== owner) {
        return false;
      }
      if (condition.destroyerController === "opponent" && entry.cause?.destroyerOwner === owner) {
        return false;
      }
      // サイズは破壊された瞬間の値(sizeAtDestroy)で判定（破壊後に conditionalSize をクリアしても不変）。
      return Boolean(
        entry.card &&
          matchesCardFilter(entry.card, condition.filter || {}, { effectiveSizeOverride: entry.sizeAtDestroy }),
      );
    });
  }
  if (condition.op === "eventReasonIs") {
    // X8(D-BT01/0082): 発火イベントの理由（rest の reason:"effect"/"attack" 等）を照合する。
    return (context.reason || null) === condition.reason;
  }
  if (condition.op === "hasArrival") {
    return Boolean(player.arrivalCardId);
  }
  if (condition.op === "ownItemHasAttribute") {
    return equippedItems(player).some((item) => item.attributes?.includes(condition.attribute));
  }
  if (condition.op === "ownItemStanding") {
    return equippedItems(player).some((item) => !item.used);
  }
  if (condition.op === "ownItemSoulCountGte") {
    // 君のアイテム（filter/attribute一致、既定は装備中アイテム）のソウル枚数が amount 以上か。
    // 例: アーマナイト・イブリース「君の《武器》のソウルが３枚以上なら貫通」。
    const amount = condition.amount ?? 1;
    const filter = condition.filter || (condition.attribute ? { attribute: condition.attribute } : {});
    return equippedItems(player).some(
      (item) => effectiveCardType(item) === "item" && matchesCardFilter(item, filter) && (item.soul?.length || 0) >= amount,
    );
  }
  if (condition.op === "buddyCalled") {
    // 君がバディをコール済みか。バディゾーンのカードを【レスト】にする＝バディコール済みの印であり、
    // 本アプリではバディコール宣言時に立つ player.partnerCalled がそのフラグ（src/07 で設定）。
    return Boolean(player.partnerCalled);
  }
  if (condition.op === "selectedStatSumLte") {
    // E-Z1(X-SS01/0003 荒ぶる五角竜王 天武): script の ifCondition 内で使う。直前の selectCards が
    // context.vars[var] に入れた「選んだカード群」の stat（既定 power=攻撃力）の現在値（バフ込み・
    // visibleFieldStat）を合計し、amount 以下なら真。「選んだカードの攻撃力の合計が15000以下なら、
    // 選んだカード全てを破壊する」のゲート専用（真なら then の destroySelected を実行）。
    // stat（power/defense/critical）を持たないカードは visibleFieldStat が 0 を返す＝合計に非寄与。
    // 選択0枚（"好きな枚数"＝0枚可）は合計0＝真になり得るが、後続 destroySelected は空選択で no-op。
    // scriptSelection(src/14)/visibleFieldStat(src/15) は連結グローバルで実行時に参照可能。
    const selection = scriptSelection({ var: condition.var }, context);
    const stat = condition.stat || "power";
    const sum = selection.reduce((total, entry) => total + visibleFieldStat(entry?.card, stat), 0);
    return sum <= (condition.amount ?? 0);
  }
  return true;
}


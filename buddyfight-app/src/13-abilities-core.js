// ==========================================================================
// buddyfight モジュール 13 — 能力探索・使用・条件判定
// 旧 app.js L5706-6486 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function findUsableHandAbility(card, options = {}) {
  // F1(D-EB02): カードレベルの useConditions（「〜なら使える」）を通常の手札キャスト経路でも評価する。
  // 従来は castSetSpell（設置・src/08）でのみ評価され、通常の魔法/必殺技/対抗では無視されていた
  //（bf-s-ub-c03-0052/0053/0054/0093 のゲートが不発だった）。全手札キャスト経路
  //（useCardAction/castSpell/castImpact/useCounterCard/useCounterPlayCard/render/AI）はここを通る。
  const useOwner = state.selected?.owner ?? state.active;
  if (!checkCardConditions(card.useConditions || [], useOwner, { card, owner: useOwner })) {
    return undefined;
  }
  return (card.abilities || []).find((ability) => {
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
  const payment = await payStructuredCostWithSelection(player, costSteps, {
    sourceCard: card,
    selectedCard: card,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const usedCard = removeSelectedFromHand();
  if (!options.counterTiming && ["spell", "impact"].includes(ability.kind)) {
    markAbilityLimit(owner, usedCard, ability);
    beginPendingAction({
      kind: ability.kind,
      owner,
      responder: 1 - owner,
      card: usedCard,
      ability,
      phase: state.phase,
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : elements.effectTarget.value,
    });
    addLog(`${player.name}は${usedCard.name}の使用を宣言しました。対抗確認を行ってください。`);
    render();
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
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : elements.effectTarget.value,
    });
    addLog(`${player.name}は${usedCard.name}の能力を宣言しました。対抗確認を行ってください。`);
    render();
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
    await runFieldEventTriggers("spellCast", owner, usedCard, null, { spellCard: usedCard });
  }
  state.selected = null;
  state.linkAttackers = [];
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
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  if (includeOpponentGauge) {
    player.nextActivatedCostMayUseOpponentGauge = false;
  }
  addAbilityUseLog(player, sourceCard, ability);
  if (!hasPendingResolution() && !isCounterAbility(ability)) {
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
  return [...direct, ...findUsableSoulAbilities(card, owner, timing)];
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
  if (condition.op === "phaseIs") return `${ABILITY_TIMING_LABELS[condition.phase] || condition.phase}フェイズ中`;
  if (condition.op === "turnOwnerIsSelf") return "自分のターン中";
  if (condition.op === "turnOwnerIsOpponent") return "相手のターン中";
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
    // 汎用枚数条件: controller(self/opponent/both) × pile(field/center/item/drop/hand/deck/gauge/soul) × filter × distinct × cmp
    const cmp = condition.cmp || (condition.op === "cardCountLte" ? "lte" : "gte");
    const sides = condition.controller === "opponent" ? [opponent]
      : condition.controller === "both" ? [player, opponent] : [player];
    const pile = condition.pile || "field";
    let cards = [];
    sides.forEach((pl) => {
      if (!pl) return;
      if (pile === "field") cards.push(...zones.map((z) => pl.field[z]).filter(Boolean), ...phantomFieldMonsters(pl));
      else if (pile === "item") cards.push(...equippedItems(pl)); // 複数装備を全てカウント（「アイテム2枚装備なら」0042等）
      else if (pile === "center") { if (pl.field[pile]) cards.push(pl.field[pile]); }
      else if (pile === "soul") cards.push(...zones.flatMap((z) => pl.field[z]?.soul || []));
      else cards.push(...(pl[pile] || []));
    });
    if (condition.excludeSource && context.card) {
      cards = cards.filter((c) => c.instanceId !== context.card.instanceId);
    }
    const matched = cards.filter((c) => matchesCardFilter(c, condition.filter || {}));
    const n = condition.distinct === "distinctByName"
      ? new Set(matched.map((c) => c.name)).size
      : matched.length;
    // amount:0 は「ちょうど0枚 / 0枚以下」= 有意な閾値（0049「自場モンスター0体なら」等）。
    // || 1 だと 0 が 1 に潰れて eq/lte が壊れるため ?? で 0 を保持する。
    const amount = condition.amount ?? 1;
    return cmp === "lte" ? n <= amount : cmp === "eq" ? n === amount : n >= amount;
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
  if (condition.op === "turnOwnerIsSelf") {
    return (context.turnOwner ?? state.active) === owner;
  }
  if (condition.op === "turnOwnerIsOpponent") {
    return (context.turnOwner ?? state.active) !== owner;
  }
  if (condition.op === "phaseIs") {
    return (state.pendingAction?.phase || state.phase) === condition.phase;
  }
  if (condition.op === "lifeLte") {
    return player.life <= condition.amount;
  }
  if (condition.op === "opponentLifeLte") {
    return opponent.life <= condition.amount;
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
    return state.players[owner]?.flag?.name === condition.name;
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
  if (condition.op === "isFirstBattleEndWindow") {
    // 「(相手のターン中、)1回目のバトル終了時に使える」(ヴァイシュタッツ 0095) の近似。
    // アプリの対抗ウィンドウはバトル解決前(pendingAttack中)のため、1回目のバトル(attacksThisTurn===1)の
    // 対抗ウィンドウで true を返す（厳密な「バトル終了時」より僅かに早いが、アタックフェイズ終了の意図は満たす）。
    return Boolean(state.pendingAttack) && (state.attacksThisTurn || 0) === 1;
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
  return true;
}


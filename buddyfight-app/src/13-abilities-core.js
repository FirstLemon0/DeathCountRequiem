// ==========================================================================
// buddyfight モジュール 13 — 能力探索・使用・条件判定
// 旧 app.js L5706-6486 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function findUsableHandAbility(card, options = {}) {
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
    if (ability.target && targetCandidatesFromSpec(ability.target, state.selected.owner, { card, ability }).length === 0) {
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
  if (ability.target && !target) {
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
    const onField = [...fieldZones, ...setZones, "item"].some(
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
  state.selected = null;
  state.linkAttackers = [];
  render();
}

async function useFieldAbilityAction(card) {
  const owner = state.selected.owner;
  const usableAbilities = findUsableFieldAbilities(card, owner);
  if (usableAbilities.length === 0) {
    addLog("今使える起動能力はありません。");
    return;
  }
  const ability =
    usableAbilities.length === 1 ? usableAbilities[0] : await chooseFieldAbility(card, usableAbilities, owner);
  if (!ability) {
    return; // 能力選択がキャンセルされた
  }
  const zone = state.selected.zone;
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
  if (ability.target && targetCandidatesFromSpec(ability.target, owner, { card, ability }).length === 0) {
    return false;
  }
  return (
    checkAbilityConditions(ability, owner) &&
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
      title: `${card.name}の起動能力`,
      lead: "使う能力を選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
      allowCancel: true,
      promptSeat: owner,
    },
  );
  return selected?.[0]?.ability || null;
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
  return ability.name || "起動能力";
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
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      return Boolean(window.confirm(condition.prompt || "この効果を使いますか？"));
    }
    return Boolean(condition.default);
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
      else if (pile === "center" || pile === "item") { if (pl.field[pile]) cards.push(pl.field[pile]); }
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
    const amount = condition.amount || 1;
    return cmp === "lte" ? n <= amount : cmp === "eq" ? n === amount : n >= amount;
  }
  if (condition.op === "attackingAlone") {
    return getPendingAttackers().length === 1;
  }
  if (condition.op === "targetMatches") {
    const ref = condition.ref ? resolveEffectReference(condition.ref, context) : context.target;
    return Boolean(ref?.card && matchesCardFilter(ref.card, condition.filter || {}));
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
  if (condition.op === "damageDealtThisTurnMatches") {
    // このターン中にダメージを与えた発生源を見る（応答ウィンドウが閉じても残る lastDamageEvent を参照）。
    // 竜撃奥義 デュアル・ムービングフォース（必殺技＝ファイナルフェイズで使用）が
    // 「武器がダメージを与えたターン中」を判定するために使う。
    const event = state.lastDamageEvent;
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
      return Boolean(entry.card && matchesCardFilter(entry.card, condition.filter || {}));
    });
  }
  if (condition.op === "hasArrival") {
    return Boolean(player.arrivalCardId);
  }
  if (condition.op === "ownItemHasAttribute") {
    return Boolean(player.field.item?.attributes?.includes(condition.attribute));
  }
  if (condition.op === "ownItemStanding") {
    return Boolean(player.field.item && !player.field.item.used);
  }
  if (condition.op === "ownItemSoulCountGte") {
    // 君のアイテム（filter/attribute一致、既定は装備中アイテム）のソウル枚数が amount 以上か。
    // 例: アーマナイト・イブリース「君の《武器》のソウルが３枚以上なら貫通」。
    const amount = condition.amount ?? 1;
    const filter = condition.filter || (condition.attribute ? { attribute: condition.attribute } : {});
    const item = player.field.item;
    return Boolean(item && effectiveCardType(item) === "item" && matchesCardFilter(item, filter) && (item.soul?.length || 0) >= amount);
  }
  if (condition.op === "buddyCalled") {
    // 君がバディをコール済みか。バディゾーンのカードを【レスト】にする＝バディコール済みの印であり、
    // 本アプリではバディコール宣言時に立つ player.partnerCalled がそのフラグ（src/07 で設定）。
    return Boolean(player.partnerCalled);
  }
  return true;
}


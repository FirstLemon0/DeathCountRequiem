// ==========================================================================
// buddyfight モジュール 17 — 効果対象算出・フィルタ・ターゲット解決
// 旧 app.js L9479-9885 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function renderEffectTargets() {
  const previous = elements.effectTarget.value;
  const selectedCard = getSelectedCard();
  const targets = effectTargetCandidates(selectedCard);
  elements.effectTarget.innerHTML = "";

  if (targets.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "効果対象なし";
    elements.effectTarget.append(option);
    elements.effectTarget.disabled = true;
    return;
  }

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "効果対象を選択";
  elements.effectTarget.append(placeholder);

  targets.forEach((target) => {
    const option = document.createElement("option");
    option.value = encodeTarget(target.owner, target.zone);
    option.textContent = `${state.players[target.owner].name} ${zoneLabel(target.zone)}：${target.card.name}`;
    elements.effectTarget.append(option);
  });
  elements.effectTarget.disabled = false;
  if (targets.some((target) => encodeTarget(target.owner, target.zone) === previous)) {
    elements.effectTarget.value = previous;
  } else {
    elements.effectTarget.value = "";
  }
}

function effectTargetCandidates(selectedCard) {
  if (!selectedCard) {
    return [];
  }
  if (cardCostRequiresOwnMonsterTarget(selectedCard)) {
    const owner = state.selected?.owner ?? state.active;
    const dropStep = Object.values(selectedCard?.costs || {})
      .flat()
      .find((step) => step.op === "dropOwnMonster");
    const stepFilter = dropStep?.filter || {};
    const excludeSelf = Boolean(dropStep?.excludeSource || stepFilter.excludeSource);
    return allFieldTargets(
      (card, targetOwner, zone) =>
        targetOwner === owner &&
        fieldZones.includes(zone) &&
        effectiveCardType(card) === "monster" &&
        (!excludeSelf || card.instanceId !== selectedCard?.instanceId) &&
        matchesCardFilter(card, stepFilter),
    );
  }
  if (selectedCard.callStack && state.selected?.source === "hand") {
    const nameIncludes = selectedCard.callStack.nameIncludes;
    const stackAttribute = selectedCard.callStack.attribute;
    const stackAttributeIn = selectedCard.callStack.attributeIn;
    // filter: 汎用フィルタ(matchesCardFilter)で重ね先候補を絞る（baseSizeGte 等。H-EB04/0010 等）。
    // 既存の nameIncludes/attribute/attributeIn とは併用可（両方指定時はAND）。
    const stackFilter = selectedCard.callStack.filter;
    return allFieldTargets(
      (card, owner) =>
        owner === state.active &&
        effectiveCardType(card) === "monster" &&
        (!nameIncludes || card.name.includes(nameIncludes)) &&
        (!stackAttribute || (card.attributes || []).includes(stackAttribute)) &&
        (!Array.isArray(stackAttributeIn) ||
          stackAttributeIn.some((a) => (card.attributes || []).includes(a))) &&
        (!stackFilter || matchesCardFilter(card, stackFilter)),
    );
  }
  const genericAbility = firstTargetedAbilityForCurrentTiming(selectedCard);
  if (genericAbility?.target) {
    return targetCandidatesFromSpec(genericAbility.target, state.selected?.owner ?? state.active, {
      card: selectedCard,
      ability: genericAbility,
    });
  }
  return [];
}

function cardCostRequiresOwnMonsterTarget(card) {
  return Object.values(card?.costs || {})
    .flat()
    .some((step) => step.op === "dropOwnMonster");
}

function allFieldTargets(predicate) {
  const targets = [];
  state.players.forEach((player, owner) => {
    zones.forEach((zone) => {
      const card = player.field[zone];
      if (card && predicate(card, owner, zone)) {
        targets.push({ owner, zone, card });
      }
    });
  });
  return targets;
}

// 場の対象集合を scope(self/opponent/all)・filter・zones・excludeSource で一元的に収集する。
// destroy{scope} / modifyStats{scope} など全体対象 op の共通基盤（旧 destroyAll/modifyStatsAll の述語を統一）。
function collectFieldTargets(spec, context) {
  const scope = spec.scope || "all";
  const zoneList = Array.isArray(spec.zones) ? spec.zones : null;
  return allFieldTargets((card, owner, zone) => {
    if (zoneList && !zoneList.includes(zone)) {
      return false;
    }
    if (scope === "self" && owner !== context.owner) {
      return false;
    }
    if (scope === "opponent" && owner === context.owner) {
      return false;
    }
    if (spec.excludeSource && card.instanceId === context.card?.instanceId) {
      return false;
    }
    return matchesTargetFilter(card, owner, zone, spec.filter || {});
  });
}

function firstTargetedAbilityForCurrentTiming(card) {
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  return (card.abilities || []).find((ability) => {
    if (!ability.target || !abilityTimingIncludes(ability, timing)) {
      return false;
    }
    if (state.selected?.source === "field") {
      return isFieldActivatedAbility(ability);
    }
    return canUseAbilityFromHand(ability);
  });
}

function targetCandidatesFromSpec(targetSpec, owner = state.selected?.owner ?? state.active, context = {}) {
  return targetCandidatesFromSpecForOwner(targetSpec, owner, context);
}

function targetMatchesSpec(target, targetSpec, specOwner, context = {}) {
  if (!target?.card || !targetSpec) {
    return false;
  }
  if (Array.isArray(targetSpec.anyOf)) {
    return targetSpec.anyOf.some((spec) => targetMatchesSpec(target, spec, specOwner, context));
  }
  if (!targetSourceConditionMatches(targetSpec, context)) {
    return false;
  }
  if (targetSpec.type === "fieldCard") {
    if (targetSpec.controller === "self" && target.owner !== specOwner) {
      return false;
    }
    if (targetSpec.controller === "opponent" && target.owner === specOwner) {
      return false;
    }
    return (
      targetAllowedByAbility(target.card, context) &&
      matchesTargetFilter(target.card, target.owner, target.zone, targetSpec.filter)
    );
  }
  if (targetSpec.type === "battleCard") {
    return targetCandidatesFromSpecForOwner(targetSpec, specOwner, context).some((candidate) =>
      sameSlot(candidate, target),
    );
  }
  return false;
}

function targetCandidatesFromSpecForOwner(targetSpec, specOwner, context = {}) {
  if (Array.isArray(targetSpec?.anyOf)) {
    return uniqueTargetEntries(
      targetSpec.anyOf.flatMap((spec) => targetCandidatesFromSpecForOwner(spec, specOwner, context)),
    );
  }
  if (!targetSpec || !targetSourceConditionMatches(targetSpec, context)) {
    return [];
  }
  if (targetSpec.type === "battleCard") {
    const pending = state.pendingAttack;
    if (!pending) {
      return [];
    }
    let targets = [];
    if (!targetSpec.role || targetSpec.role === "attacker") {
      targets.push(...getPendingAttackers());
    }
    if (!targetSpec.role || targetSpec.role === "defender") {
      const battleTarget = getPendingBattleTargetInfo(pending);
      if (battleTarget) {
        targets.push(battleTarget);
      }
    }
    return targets.filter(
      (target) =>
        (!targetSpec.controller ||
          (targetSpec.controller === "self" ? target.owner === specOwner : target.owner !== specOwner)) &&
        targetAllowedByAbility(target.card, context) &&
        matchesTargetFilter(target.card, target.owner, target.zone, targetSpec.filter),
    );
  }
  if (targetSpec.type === "fieldCard") {
    return allFieldTargets((card, owner, zone) => {
      if (targetSpec.controller === "self" && owner !== specOwner) {
        return false;
      }
      if (targetSpec.controller === "opponent" && owner === specOwner) {
        return false;
      }
      if (targetSpec.excludeSource && card.instanceId === context.card?.instanceId) {
        return false;
      }
      return targetAllowedByAbility(card, context) && matchesTargetFilter(card, owner, zone, targetSpec.filter);
    });
  }
  return [];
}

function targetAllowedByAbility(card, context = {}) {
  if (!cannotReturnToHand(card)) {
    return true;
  }
  return !(context.ability?.effects || []).some(
    (effect) => effect.op === "returnToHand" && effect.target === "$target",
  );
}

function cannotReturnToHand(card) {
  if (!card) {
    return false;
  }
  if (card.cannotReturnToHand) {
    return true;
  }
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return false;
  }
  const fieldPrevents = state.players.some((player) =>
    zones.some((zone) => {
      const sourceCard = player.field[zone];
      return (sourceCard?.continuous || []).some(
        (effect) =>
          effect.op === "preventReturnToHand" &&
          continuousEffectApplies(effect, card, sourceCard),
      );
    }),
  );
  // Z4(e)(S-UB-C03/0043(b)): 【対抗】等でそのターン（＋次ターン等）限定に付与される手札戻し耐性
  // （state.turnProtections、05-stats.js）。既存の恒久 preventReturnToHand とは独立レイヤ。
  return fieldPrevents || soulContinuousGrantsOp(card, "preventReturnToHand") || cardProtectedFrom(card, "returnToHand");
}

function targetSourceConditionMatches(targetSpec, context = {}) {
  if (targetSpec.sourceSoulCountGte !== undefined) {
    return (context.card?.soul?.length || 0) >= targetSpec.sourceSoulCountGte;
  }
  return true;
}

function uniqueTargetEntries(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    const key = `${target.owner}:${target.zone}:${target.card?.instanceId || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function matchesTargetFilter(card, owner, zone, filter = {}) {
  if (!matchesCardFilter(card, filter)) {
    return false;
  }
  if (filter.buddy && card.name !== state.players[owner]?.buddy?.name) {
    return false;
  }
  if (filter.zone && zone !== filter.zone) {
    return false;
  }
  if (filter.zoneIn && !filter.zoneIn.includes(zone)) {
    return false;
  }
  if (filter.zoneNot && zone === filter.zoneNot) {
    return false;
  }
  return true;
}

function matchesCardFilter(card, filter = {}, options = {}) {
  if (!card) {
    return false;
  }
  // options.effectiveSizeOverride: 「その瞬間の実効サイズ」を凍結して判定するための上書き。
  // 破壊時イベント窓(lastDestroyedCardMatches)が、破壊後に conditionalSize をクリアしても
  // 破壊された瞬間のサイズで判定できるようにするために使う。
  const sizeOf = options.effectiveSizeOverride !== undefined ? options.effectiveSizeOverride : effectiveSize(card);
  if (Array.isArray(filter.anyOf) && filter.anyOf.length > 0) {
    const rest = { ...filter };
    delete rest.anyOf;
    return filter.anyOf.some((candidate) => matchesCardFilter(card, { ...rest, ...candidate }, options));
  }
  if (filter.cardType && !cardTypeMatches(card, filter.cardType)) {
    return false;
  }
  // F2(D-SS03/0011): cardTypeNot — 印字(raw)の card.type と一致するカードを除外する。effectiveCardType の
  // 正規化(impactMonster→monster)を通さないため「必殺モンスター以外」を cardTypeNot:"impactMonster" で表現できる
  // （cardType:"monster" では impactMonster も monster に正規化されて含まれてしまう）。
  if (filter.cardTypeNot && card.type === filter.cardTypeNot) {
    return false;
  }
  // X18(D-BT01/0027): 『角王』を持つカード = deckAnyFlag:true（角王アイコンの内部表現。builder と同じ判定）。
  if (filter.deckAnyFlag !== undefined && Boolean(card.deckAnyFlag) !== Boolean(filter.deckAnyFlag)) {
    return false;
  }
  if (filter.cardTypeIn && !filter.cardTypeIn.some((wanted) => cardTypeMatches(card, wanted))) {
    return false;
  }
  // E1: 2ワールド持ちカードは、いずれかのワールドが filter.world に一致すれば通す（cardWorlds）。
  if (filter.world && !cardWorlds(card).includes(filter.world)) {
    return false;
  }
  if (filter.powerLte !== undefined && visiblePower(card) > filter.powerLte) {
    return false;
  }
  if (filter.powerGte !== undefined && visiblePower(card) < filter.powerGte) {
    return false;
  }
  if (filter.defenseLte !== undefined && visibleDefense(card) > filter.defenseLte) {
    return false;
  }
  if (filter.defenseGte !== undefined && visibleDefense(card) < filter.defenseGte) {
    return false;
  }
  if (filter.criticalGte !== undefined && visibleCritical(card) < filter.criticalGte) {
    return false;
  }
  if (filter.criticalLte !== undefined && visibleCritical(card) > filter.criticalLte) {
    return false;
  }
  if (filter.sizeLte !== undefined && sizeOf > filter.sizeLte) {
    return false;
  }
  if (filter.sizeGte !== undefined && sizeOf < filter.sizeGte) {
    return false;
  }
  if (filter.sizeIn && !filter.sizeIn.includes(sizeOf)) {
    return false;
  }
  // basePower*: 印字（元々の）攻撃力を見る。powerLte/Gte は visiblePower(バフ込み)なので別途。
  if (filter.basePower !== undefined && (card.power || 0) !== filter.basePower) {
    return false;
  }
  if (filter.basePowerGte !== undefined && (card.power || 0) < filter.basePowerGte) {
    return false;
  }
  if (filter.basePowerLte !== undefined && (card.power || 0) > filter.basePowerLte) {
    return false;
  }
  // baseSize: 印字（元々の）サイズを見る（サイズ継続修整を無視し effectiveSize 再入を回避）。
  if (filter.baseSize !== undefined && (card.size || 0) !== filter.baseSize) {
    return false;
  }
  // baseSizeLte: 印字サイズの上限（D-BT01/0131「サイズ2以下の《百鬼》」。effectiveSize 再入を避ける）。
  if (filter.baseSizeLte !== undefined && (card.size || 0) > filter.baseSizeLte) {
    return false;
  }
  if (filter.baseSizeGte !== undefined && (card.size || 0) < filter.baseSizeGte) {
    return false;
  }
  if (
    filter.hasAbilityLabel !== undefined &&
    !(card.abilities || []).concat(card.soulAbilities || []).some((ability) => ability.label === filter.hasAbilityLabel)
  ) {
    return false;
  }
  if (filter.mounted !== undefined) {
    // mounted: 『搭乗』/『変身』しているカード（印字はモンスターだが currentType が item ＝装備枠に装備中）。
    const isMounted = card.currentType === "item" && card.type === "monster";
    if (filter.mounted !== isMounted) {
      return false;
    }
  }
  // Z3(S-UB-C03/0028): grantAttribute 継続による付与属性込みの実効属性（effectiveAttributes、05-stats.js）。
  // filter が属性系キーを1つも持たない大多数の呼び出しでは effectiveAttributes を一切呼ばない
  // （matchesCardFilterは超高頻度に呼ばれるため、無関係なfilterでも継続走査が走るのを避ける）。
  if (filter.attribute || filter.attributeIn || filter.attributeIncludes || filter.attributeIncludesAny) {
    const attributesOf = effectiveAttributes(card);
    if (filter.attribute && !attributesOf?.includes(filter.attribute)) {
      return false;
    }
    if (filter.attributeIn && !filter.attributeIn.some((attribute) => attributesOf?.includes(attribute))) {
      return false;
    }
    if (filter.attributeIncludes && !attributesOf?.some((attribute) => attribute.includes(filter.attributeIncludes))) {
      return false;
    }
    if (
      filter.attributeIncludesAny &&
      !filter.attributeIncludesAny.some((needle) => attributesOf?.some((attribute) => attribute.includes(needle)))
    ) {
      return false;
    }
  }
  // 追加のカード名(gainNameAsSelected 等)も名前判定に含める。
  const cardNames = card.additionalNames?.length ? [card.name, ...card.additionalNames] : [card.name];
  // E1(D-SS01/0024・0044「このカードは『○○』としても扱う」): カード級 alsoNames を、下の名称述語
  // (name/nameIn/nameIncludes とその否定形 nameNot/nameNotIncludes)の照合にだけ加えるエイリアス。
  // 公式裁定「カード名は〜としても扱う」の filter 照合限定実装で、他の名前参照
  // (buddy 判定・デッキ構築の同名4枚制限・displayName・instanceId・script の sameNameAsVar 等)には
  // 一切波及させない。alsoNames 未指定なら matchNames === cardNames なので既存挙動は完全に不変。
  const matchNames = card.alsoNames?.length ? [...cardNames, ...card.alsoNames] : cardNames;
  // Z1(S-UB-C03): filter.buddy — 対象がその所有者の登録バディ(同名)であるか。継続の requireBuddy と
  // 同じ判定(turnTreatAsBuddyも許容)だが、matchesCardFilter は owner を引数に取らないため
  // findFieldCardSlot で対象自身の所有者を特定する（場外のカードは buddy 判定不能=false）。
  if (filter.buddy !== undefined) {
    const buddySlot = findFieldCardSlot(card);
    // 場のカードは在場スロットで所有者を特定する。E-XC15(X-CP01/0061 バディカモン！): 場外(デッキ/手札)の
    // カードは findFieldCardSlot が null になり従来は常に非バディ扱いだった。options.owner が渡されていれば
    // その所有者の登録バディ名で判定してフォールバックする（searchDeckToHand{filter:{buddy:true}} 等で
    // owner を明示した呼び出しのみ有効＝owner を渡さない既存呼び出しは従来どおり＝挙動不変）。
    const buddyOwner = buddySlot ? buddySlot.owner : options.owner;
    const isBuddy =
      buddyOwner !== undefined &&
      buddyOwner !== null &&
      (card.turnTreatAsBuddy || cardNames.includes(state.players[buddyOwner]?.buddy?.name));
    if (Boolean(filter.buddy) !== isBuddy) {
      return false;
    }
  }
  if (filter.name && !matchNames.includes(filter.name)) {
    return false;
  }
  if (filter.nameIn && !filter.nameIn.some((n) => matchNames.includes(n))) {
    return false;
  }
  if (filter.nameIncludes && !matchNames.some((n) => n.includes(filter.nameIncludes))) {
    return false;
  }
  if (filter.nameNot && matchNames.includes(filter.nameNot)) {
    return false;
  }
  // nameNotIncludes（S-UB-C03/0008/0037/0039「[キャラ名]以外」）: 部分一致の否定。本弾のカード名は
  // 「肩書き＋キャラ名」形式のため、キャラ名を含むカード(＝当人)を除外するには部分一致でなければならない。
  // E1: 否定形も matchNames（別名含む）で判定＝「X以外」が別名Xのカードを正しく除外する。
  if (filter.nameNotIncludes && matchNames.some((n) => n.includes(filter.nameNotIncludes))) {
    return false;
  }
  if (filter.keyword && !hasKeyword(card, filter.keyword)) {
    return false;
  }
  if (filter.standing !== undefined && Boolean(card.used) === Boolean(filter.standing)) {
    return false;
  }
  if (filter.soulCountLte !== undefined && (card.soul?.length || 0) > filter.soulCountLte) {
    return false;
  }
  if (filter.soulCountGte !== undefined && (card.soul?.length || 0) < filter.soulCountGte) {
    return false;
  }
  // FE3/A7(D-BT04/0115 オリジン・ブレイカー): soulHasMatching — 候補カードのソウルに、指定 filter に
  //   一致する札が1枚以上あるか（「ソウルに『ジェムクローン』を含む必殺モンスター」等を厳密表現）。
  //   soul は raw 走査で足りる（有限）。既存カードは未使用キー＝後方互換。outer options（effectiveSizeOverride 等）は
  //   ソウル札に持ち込まない（別カードの実効値なので誤判定を避ける）。
  if (filter.soulHasMatching) {
    const soulFilter = filter.soulHasMatching.filter || filter.soulHasMatching;
    if (!(card.soul || []).some((s) => matchesCardFilter(s, soulFilter))) {
      return false;
    }
  }
  return true;
}

function matchingCardsFromPile(pile, filter = {}) {
  return (pile || []).filter((card) => matchesCardFilter(card, filter));
}

function takeMatchingCards(pile, filter = {}, amount = 1, excludedCard = null) {
  const movedCards = [];
  for (let index = pile.length - 1; index >= 0 && movedCards.length < amount; index -= 1) {
    const card = pile[index];
    if (card.instanceId === excludedCard?.instanceId) {
      continue;
    }
    if (matchesCardFilter(card, filter)) {
      movedCards.push(pile.splice(index, 1)[0]);
    }
  }
  return movedCards;
}

function encodeTarget(owner, zone) {
  return `${owner}:${zone}`;
}

function getEffectTargetInfo() {
  return getTargetInfoFromValue(elements.effectTarget.value);
}

function getTargetInfoFromValue(value) {
  if (!value) {
    return null;
  }
  const [ownerText, zone] = value.split(":");
  const owner = Number(ownerText);
  return getFieldTarget(owner, zone);
}

function getFieldTarget(owner, zone) {
  const card = state.players[owner]?.field[zone];
  return card ? { owner, zone, card } : null;
}


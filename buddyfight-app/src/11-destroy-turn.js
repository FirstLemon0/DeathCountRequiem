// ==========================================================================
// buddyfight モジュール 11 — 攻撃可否・破壊・トリガー・ソウルガード/ライフリンク・ターン終了・勝敗
// 旧 app.js L4391-5147 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function canDeclareAttack(attacker) {
  if (!attacker?.card) {
    return false;
  }
  const player = state.players[attacker.owner];
  if (
    state.monsterAttackForbidden?.[attacker.owner] &&
    effectiveCardType(attacker.card) === "monster"
  ) {
    // ignoreAttackForbidden は「グレイプニル」の効果のみ無視できる（マーナガルム/魔狼フェンリル）。
    // デイ・オブ・ザ・ドラゴン等の他の攻撃禁止は無視できないため、禁止の発生源を確認する。
    const sources = state.monsterAttackForbiddenSources?.[attacker.owner] || [];
    const ignored = hasKeyword(attacker.card, "ignoreAttackForbidden") ? ["グレイプニル"] : [];
    // 場の継続 ignoreNamedAttackForbid（ヴァイキングソード0081: 君のモンスターは「デイ・オブ・ザ・ドラゴン」の攻撃禁止効果を受けない）
    zones.forEach((zone) => {
      activeContinuousEffects(player?.field?.[zone]).forEach((effect) => {
        if (effect.op === "ignoreNamedAttackForbid" && effect.sourceName) {
          ignored.push(effect.sourceName);
        }
      });
    });
    const blocked = sources.length === 0 || sources.some((src) => !ignored.includes(src));
    if (blocked) {
      return false;
    }
  }
  if (
    effectiveCardType(attacker.card) === "item" &&
    player?.field.center &&
    !hasKeyword(attacker.card, "canAttackWithCenter") &&
    // canAttackWithSize3Center: センターがサイズ3のモンスターの時だけ武器攻撃を許可（0069）。
    !(hasKeyword(attacker.card, "canAttackWithSize3Center") && (player.field.center.size || 0) === 3)
  ) {
    return false;
  }
  if ((attacker.card.cannotAttackZones || []).includes(attacker.zone)) {
    // 「このカードはレフトとライトに攻撃できない」(武装騎神 デュナミス 0001)等。
    return false;
  }
  if (attacker.card.cannotAttackThisTurn && !hasKeyword(attacker.card, "ignoreAttackForbidden")) {
    // 「そのターン中、そのモンスターは攻撃できない」(グレイプニルのソウルコール等)。
    // レスト(used)と異なりスタンドしても解除されず、ターン終了(clearTurnModifiers)でのみクリアされる。
    // ただし「グレイプニルの効果を受けない」カード(魔狼フェンリル/マーナガルム=ignoreAttackForbidden)は記載通り攻撃できる。
    return false;
  }
  if (!checkCardConditions(attacker.card.attackConditions || [], attacker.owner, {
    card: attacker.card,
    zone: attacker.zone,
  })) {
    return false;
  }
  return true;
}

function sameSlot(left, right) {
  return left?.owner === right?.owner && left?.zone === right?.zone;
}

function oppositeFieldZone(zone) {
  if (zone === "left") {
    return "right";
  }
  if (zone === "right") {
    return "left";
  }
  return zone;
}

function getPendingTarget() {
  return getPendingBattleTargetInfo()?.card || null;
}

function getPendingBattleTargetInfo(pending = state.pendingAttack) {
  if (!pending) {
    return null;
  }
  if (pending.targetType === "monster") {
    const card = state.players[pending.targetOwner]?.field[pending.targetZone];
    return card ? { owner: pending.targetOwner, zone: pending.targetZone, card } : null;
  }
  if (pending.targetType === "fighter") {
    const card = state.players[pending.defender]?.field.item;
    return isDefenseItem(card) ? { owner: pending.defender, zone: "item", card } : null;
  }
  if (pending.targetType === "item") {
    const card = state.players[pending.targetOwner]?.field[pending.targetZone];
    return isDefenseItem(card) ? { owner: pending.targetOwner, zone: pending.targetZone, card } : null;
  }
  return null;
}

function isDefenseItem(card) {
  return Boolean(card && effectiveCardType(card) === "item" && visibleDefense(card) > 0);
}

function isPendingBattleCard(targetInfo) {
  if (!targetInfo) {
    return false;
  }
  if (getPendingAttackers().some((attacker) => sameSlot(attacker, targetInfo))) {
    return true;
  }
  const battleTarget = getPendingBattleTargetInfo();
  return Boolean(battleTarget && sameSlot(battleTarget, targetInfo));
}

function makeEffectCause(context, victimOwner) {
  // 効果による破壊の発生源情報（破壊耐性 destroyImmunity・「君のカードで破壊された時」の判定に使う）
  return {
    byEffect: true,
    byOpponent: victimOwner !== context.owner,
    sourceOwner: context.owner, // 破壊を起こした側（「君のカードで」= sourceOwner が listener と一致）
    sourceType: context.card ? effectiveCardType(context.card) : null,
    sourceCard: context.card || null,
  };
}

// 場のカードの継続 grantDestroyImmunity が、対象 card に破壊耐性を付与しているか。
// 例: 星神アストライオス「君のレフトとライトの《星》は破壊されない」。controller/zoneIn/filter/from でデータ駆動。
function grantedDestroyImmunityBlocks(card, cause) {
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) return false;
  return state.players.some((player, sourceOwner) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return activeContinuousEffects(source).some((e) => {
        if (e.op !== "grantDestroyImmunity") return false;
        if (e.controller === "self" && targetSlot.owner !== sourceOwner) return false;
        if (e.controller === "opponent" && targetSlot.owner === sourceOwner) return false;
        if (e.excludeSource && source.instanceId === card.instanceId) return false;
        if (e.zoneIn && !e.zoneIn.includes(targetSlot.zone)) return false;
        if (e.filter && !matchesCardFilter(card, e.filter)) return false;
        if (e.from) {
          if (e.from.byBattle && !cause.byBattle) return false;
          if (e.from.byEffect && !cause.byEffect) return false;
          if (e.from.byOpponent && !cause.byOpponent) return false;
        }
        return true;
      });
    }),
  );
}

// 【対抗】等でそのターン中だけ付与された、ゾーン限定の破壊耐性（state.turnDestroyImmunity）。
// 例: ドラゴニック・フォースフィールド「このターン中、君のレフトとライトのモンスターは破壊されない」。
function turnDestroyImmunityBlocks(card) {
  const list = state.turnDestroyImmunity;
  if (!list || !list.length) return false;
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) return false;
  return list.some((entry) => {
    if (entry.owner !== targetSlot.owner) return false;
    if (entry.zoneIn && !entry.zoneIn.includes(targetSlot.zone)) return false;
    if (entry.filter && !matchesCardFilter(card, entry.filter)) return false;
    return true;
  });
}

function destroyImmunityBlocks(card, cause, owner) {
  if (!cause) return false;
  if (grantedDestroyImmunityBlocks(card, cause)) return true;
  if (
    soulContinuousGrantsOp(card, "grantDestroyImmunity", (e) => {
      if (e.from) {
        if (e.from.byBattle && !cause.byBattle) return false;
        if (e.from.byEffect && !cause.byEffect) return false;
        if (e.from.byOpponent && !cause.byOpponent) return false;
      }
      return true;
    })
  ) {
    return true;
  }
  if (turnDestroyImmunityBlocks(card)) return true;
  const imm = card.destroyImmunity;
  if (!imm) return false;
  const entries = Array.isArray(imm) ? imm : [imm];
  const zone = findFieldCardSlot(card)?.zone;
  return entries.some((e) => {
    // 旧 object 形（発生源種別の固定bool）。いずれも効果破壊(byEffect)前提のためバトル破壊では発火しない。
    if (e.fromEffect && cause.byEffect) return true;
    if (e.fromOpponentEffect && cause.byEffect && cause.byOpponent) return true;
    if (e.fromSpell && cause.byEffect && cause.sourceType === "spell") return true;
    if (e.fromImpact && cause.byEffect && cause.sourceType === "impact") return true;
    // 新 form（from条件 × byFilter（破壊元カード） × conditions（被破壊側owner基準））
    if (e.from || e.byFilter || e.conditions) {
      // バトル破壊耐性は from.byBattle を明示した耐性のみが対象（既存の効果破壊耐性に誤適用しない）。逆も同様。
      if (cause.byBattle && !(e.from && e.from.byBattle)) return false;
      if (!cause.byBattle && e.from && e.from.byBattle) return false;
      if (e.from) {
        if (e.from.byEffect && !cause.byEffect) return false;
        if (e.from.byOpponent && !cause.byOpponent) return false;
        if (e.from.sourceType && cause.sourceType !== e.from.sourceType) return false;
      }
      if (e.byFilter && !(cause.sourceCard && matchesCardFilter(cause.sourceCard, e.byFilter))) return false;
      if (e.conditions && !checkCardConditions(e.conditions, owner, { card, zone, owner })) return false;
      return true;
    }
    return false;
  });
}

// 破壊時誘発がこのカード自身のソウルを参照するか（from:"soul"）。
// true の場合、ソウルのドロップ送りを誘発解決後まで遅延させる（グレイプニル等）。
function destroyTriggerUsesSoul(card) {
  const scan = (node) => {
    if (Array.isArray(node)) {
      return node.some(scan);
    }
    if (node && typeof node === "object") {
      if (node.from === "soul") {
        return true;
      }
      return Object.values(node).some(scan);
    }
    return false;
  };
  return (card.abilities || []).some(
    (ability) => ability.kind === "triggered" && ability.event === "destroyed" && scan(ability),
  );
}

async function destroyFieldCard(owner, zone, options = {}) {
  const player = state.players[owner];
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  // 汎用破壊耐性: 旧 {fromEffect/fromOpponentEffect/fromSpell/fromImpact} と
  // 新 [{from:{byEffect,byOpponent,sourceType}, byFilter, conditions}] の両対応
  if (!options.ignoreDestroyImmunity && options.cause && destroyImmunityBlocks(card, options.cause, owner)) {
    addLog(`${card.name}は${options.cause.byBattle ? "攻撃" : "効果"}では破壊されません。`);
    return null;
  }
  if (!options.ignoreDestroyReplacement && (await applyDestroyReplacement(card, owner, options))) {
    // 置換が成立した場合、カードは破壊されていない（破壊数・破壊時誘発・貫通判定に数えない）
    return null;
  }
  if (!options.ignoreDestroyReplacement && (await applyAllyDestroyReplacement(card, owner, options))) {
    // 味方を庇う置換（別カードを犠牲にして card を場に残す）が成立した。
    return null;
  }
  if (!options.ignoreDestroyReplacement && card.preventNextDestroyCount > 0) {
    card.preventNextDestroyCount -= 1;
    const replacement = card.preventNextDestroyEffects?.shift();
    const countsAsDestroyed = Boolean(replacement?.countsAsDestroyed);
    if (replacement?.gainLife && !isLifeGainByEffectPrevented(replacement.owner ?? owner)) {
      state.players[replacement.owner ?? owner].life += replacement.gainLife;
      addLog(`${replacement.source || card.name}の効果で${state.players[replacement.owner ?? owner].name}のライフを${replacement.gainLife}回復しました。`);
    }
    if (replacement?.grantKeyword) {
      card.turnKeywords ||= [];
      card.turnKeywords.push(replacement.grantKeyword);
    }
    queuePreventNextDestroyReplacementEffects(card, owner, replacement);
    addLog(`${card.name}は効果により場に残りました。`);
    if (countsAsDestroyed) {
      recordSpecialCallOpportunity(card, owner, zone, options);
      queueDestroyedTriggers(card, owner, zone, options.cause);
      return card;
    }
    return null;
  }
  if (!options.ignoreSoulguard && canUseSoulguard(card) && (await shouldUseSoulguard(card, owner))) {
    const soulCard = card.soul.pop();
    player.drop.push(soulCard);
    addLog(`${card.name}はソウルガードで場に残りました。`);
    return null;
  }
  const moveSoulTo = card.onDestroy?.moveSoulTo || (card.returnSoulToHandOnDestroy ? "hand" : null);
  if (moveSoulTo === "hand" && (card.soul || []).length > 0) {
    // 「破壊される場合、ソウル全てを手札に加える」。ソウルがドロップへ移る前に回収。
    const recovered = card.soul.length;
    player.hand.push(...card.soul);
    card.soul = [];
    addLog(`${card.name}が破壊され、ソウル${recovered}枚を手札に加えました。`);
  } else if (destroyTriggerUsesSoul(card)) {
    // 破壊時能力がソウルを参照するため、ドロップ送りは queueDestroyedTriggers の解決後まで遅延。
  } else {
    player.drop.push(...(card.soul || []));
    card.soul = [];
  }
  player.drop.push(card);
  player.field[zone] = null;
  if (!options.suppressDestroyedTriggers) {
    // 破壊で場からドロップへ（movedToDrop 誘発）。「能力全てを無効化してから破壊」(ラグナロク型)では発火しない。
    queueMovedToDropTriggers(card, owner, "field");
  }
  // このターン中に破壊されたカードの記録（destroyedThisTurnMatchingCountGte 用）。モンスター以外も記録する。
  // sizeAtDestroy は recordDestroyedEventWindow と同じ frozenSizeAtDestroy で算出（conditionalSize未クリアのこの時点）。
  // wasMonster は破壊時点の実効カード種を凍結（monstersDestroyedThisTurn の導出元）。
  state.destroyedCardsThisTurn = state.destroyedCardsThisTurn || [[], []];
  state.destroyedCardsThisTurn[owner].push({
    card,
    sizeAtDestroy: frozenSizeAtDestroy(card),
    wasMonster: effectiveCardType(card) === "monster",
  });
  syncMonstersDestroyedThisTurn();
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  if (!options.suppressLifeLink) {
    applyLifeLink(card, owner);
  }
  recordDestroyedEventWindow(card, owner);
  // 破壊されてドロップへ行ったカードは、場限定のサイズ上書き(conditionalSize=大首領アンノウン0029等)を解除する。
  // 破壊された瞬間のサイズは destroyedEventWindow に凍結済みなので対抗札(lastDestroyedCardMatches)は不変。
  // ドロップ滞在中のサイズ参照(ドロップからのサイズ指定コール等)が印字サイズで正しく判定される。
  card.conditionalSize = null;
  recordSpecialCallOpportunity(card, owner, zone, options);
  // suppressDestroyedTriggers: 「(場のモンスターの)能力全てを無効化してから破壊」(大魔法 ラグナロク 0030)では、
  // 破壊されたモンスター“自身”の破壊時/場離れ誘発は能力ごと無効化されているため発火させない。
  if (!options.suppressDestroyedTriggers) {
    queueDestroyedTriggers(card, owner, zone, options.cause);
    queueLeaveFieldTriggers(card, owner, zone);
  } else if ((card.soul || []).length > 0) {
    // 破壊時誘発を通さないため、遅延させたソウル(destroyTriggerUsesSoul)の回収を自前で行いソウル残留を防ぐ。
    player.drop.push(...card.soul);
    card.soul = [];
  }
  // 味方破壊時誘発は「破壊されたモンスター自身の能力」ではないため、能力無効化(ラグナロク)でも抑制しない。
  // 非モンスター(呪文/アイテム)の『味方が破壊された時』反応が正しく発火する（近似: 他モンスターの同種反応も発火し得る）。
  queueAllyDestroyedTriggers(card, owner, zone, options.cause);
  queueDestroyReactionTriggers(card);
  return card;
}

// setPreventNextDestroy の replacement.effects を、破壊が場残留に置換された直後に解決する
// （H-EB04/0052 等: 破壊されても場に残す＋追加効果）。attachDestroyReaction/queueDestroyReactionTriggers と
// 同形の microtask パターンを踏襲し、destroyFieldCard の同期経路中に effect 実行で再入しないようにする。
function queuePreventNextDestroyReplacementEffects(card, owner, replacement) {
  const effects = replacement?.effects;
  if (!Array.isArray(effects) || effects.length === 0) {
    return;
  }
  const effectOwner = replacement.owner ?? owner;
  Promise.resolve()
    .then(async () => {
      const player = state.players[effectOwner];
      const context = { card, player, owner: effectOwner };
      for (const effect of effects) {
        await executeAbilityEffect(effect, context);
      }
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

// attachDestroyReaction で付与された遅延リアクション（このカードが破壊された時、付与者が effects を解決）を発火。
// microtask で遅延実行（destroyFieldCard は同期経路も含むため）。ターン跨ぎは clearTurnModifiers 側で解除。
function queueDestroyReactionTriggers(card) {
  const reaction = card?.destroyReaction;
  if (!reaction) {
    return;
  }
  card.destroyReaction = null;
  Promise.resolve()
    .then(async () => {
      const player = state.players[reaction.owner];
      const context = { card, player, owner: reaction.owner };
      for (const effect of reaction.effects) {
        await executeAbilityEffect(effect, context);
      }
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

// 「場から離れた時」(allyLeaveField/opponentLeaveField) の誘発。現状は破壊経路から発火する
// （攻撃フェイズの自軍モンスター破壊が主要ケース。不可視の断罪銃 0012）。listener がある時のみ。
function queueLeaveFieldTriggers(card, owner, zone) {
  const hasListener = [0, 1].some((playerIndex) =>
    zones.some((fieldZone) => {
      const sourceCard = state.players[playerIndex]?.field?.[fieldZone];
      return (
        sourceCard &&
        (sourceCard.abilities || []).some(
          (ability) =>
            ability.kind === "triggered" &&
            (ability.event === "allyLeaveField" || ability.event === "opponentLeaveField"),
        )
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runFieldEventTriggers("leaveField", owner, card, zone);
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

// 味方を庇う破壊置換: 場の別カード(replacer)が allyDestroyReplacement を持ち、破壊されようとする card が
// その filter / from(原因) に一致するなら、replacer のコスト(既定 dropSource=自身をドロップ)を払って card を場に残す。
// 例: ドラゴントゥース・ウォリアー「君の場のサイズ３のモンスターが破壊される場合、このカードをドロップに置いてよい。置いたら場に残す」。
async function applyAllyDestroyReplacement(card, owner, options = {}) {
  if (options.ignoreDestroyReplacement) {
    return false;
  }
  const player = state.players[owner];
  for (const zone of zones) {
    const replacer = player.field[zone];
    if (!replacer || replacer.instanceId === card.instanceId) {
      continue;
    }
    const rule = replacer.allyDestroyReplacement;
    if (!rule) {
      continue;
    }
    if (rule.filter && !matchesCardFilter(card, rule.filter)) {
      continue;
    }
    if (rule.from) {
      if (rule.from.byBattle && !options.cause?.byBattle) continue;
      if (rule.from.byEffect && !options.cause?.byEffect) continue;
      if (rule.from.byOpponent && !options.cause?.byOpponent) continue;
    }
    const cost = adjustedCostSteps(player, replacer, "destroyReplacement", rule.cost || [{ op: "dropSource" }]);
    if (!canPayStructuredCost(player, cost, { sourceCard: replacer, selectedCard: replacer }).ok) {
      continue;
    }
    if (rule.optional && !(await confirmChoiceAsync(owner, `${replacer.name}を置いて${card.name}を場に残しますか？`, { purpose: "destroy-replacement" }))) {
      continue;
    }
    const payment = payStructuredCost(player, cost, { sourceCard: replacer, selectedCard: replacer });
    if (!payment.ok) {
      continue;
    }
    if (rule.saveTo) {
      // 破壊のかわりに saveTo（手札等）へ移す（紅蓮のリング 0031「そのアイテムを手札に戻す」）。
      const slot = findFieldCardSlot(card);
      if (slot) {
        player.drop.push(...(card.soul || []));
        card.soul = [];
        card.currentType = card.baseType || card.type;
        player.field[slot.zone] = null;
        (player[rule.saveTo] ||= []).push(card);
      }
      addLog(`${replacer.name}を置いて${card.name}は${rule.saveTo === "hand" ? "手札" : rule.saveTo}に移りました。`);
      return true;
    }
    addLog(`${replacer.name}を置いて${card.name}は場に残りました。`);
    return true;
  }
  return false;
}

async function applyDestroyReplacement(card, owner, options = {}) {
  const replacement = card.destroyReplacement;
  if (!replacement || options.ignoreDestroyReplacement) {
    return false;
  }
  const player = state.players[owner];
  if (!checkCardConditions(replacement.conditions || [], owner, {
    card,
    owner,
    zone: findFieldCardSlot(card)?.zone,
  })) {
    return false;
  }
  const replacementCost = adjustedCostSteps(player, card, "destroyReplacement", replacement.cost || []);
  if (!canPayStructuredCost(player, replacementCost, {
    sourceCard: card,
    selectedCard: card,
  }).ok) {
    return false;
  }
  if (replacement.optional && !(await confirmChoiceAsync(owner, `${card.name}の破壊置換を使いますか？`, { purpose: "destroy-replacement" }))) {
    return false;
  }
  const payment = payStructuredCost(player, replacementCost, {
    sourceCard: card,
    selectedCard: card,
  });
  if (!payment.ok) {
    return false;
  }
  if (replacement.gainLife && !isLifeGainByEffectPrevented(owner)) {
    player.life += replacement.gainLife;
  }
  if (replacement.to === "gauge") {
    const slot = findFieldCardSlot(card);
    if (slot) {
      player.drop.push(...(card.soul || []));
      card.soul = [];
      player.field[slot.zone] = null;
      player.gauge.push(card);
      queueGaugePlacedTriggers(owner, [card]); // 相手のゲージにカードが置かれた時（0020）
    }
    addLog(`${card.name}は破壊置換によりゲージに置かれました。`);
    return true;
  }
  addLog(`${card.name}は破壊置換により場に残りました。`);
  return true;
}

function recordSpecialCallOpportunity(destroyedCard, owner, zone, options = {}) {
  state.specialCallOpportunities ||= [];
  const lifeLinkEvent = findRecentLifeLinkEvent(owner, {
    sameTurn: true,
    filter: { name: destroyedCard.name },
  });
  state.specialCallOpportunities.push({
    owner,
    destroyedCard: compactCardForLog(destroyedCard),
    destroyedName: destroyedCard.name,
    destroyedZone: zone,
    turnCount: state.turnCount,
    phase: state.phase,
    reason: options.reason || "destroyed",
    lifeLinkEventId: lifeLinkEvent?.id || null,
    expired: false,
  });
  if (state.specialCallOpportunities.length > 20) {
    state.specialCallOpportunities.splice(0, state.specialCallOpportunities.length - 20);
  }
}

function findSpecialCallOpportunity(owner, spec = {}) {
  const events = state.specialCallOpportunities || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!specialCallOpportunityMatches(event, owner, spec)) {
      continue;
    }
    return event;
  }
  return null;
}

function specialCallOpportunityMatches(event, owner, spec = {}) {
  if (!event || event.used || event.expired) {
    return false;
  }
  if (spec.sameTurn !== false && event.turnCount !== state.turnCount) {
    return false;
  }
  if (spec.kind && spec.kind !== event.reason) {
    return false;
  }
  if (spec.controller === "opponent") {
    if (event.owner === owner) {
      return false;
    }
  } else if (spec.controller !== "any" && event.owner !== owner) {
    return false;
  }
  return matchesCardFilter(event.destroyedCard, spec.filter || {});
}

// 破壊された瞬間の実効サイズを凍結する共通算出（この後カードがドロップへ行っても、破壊時サイズを
// 参照する判定 (lastDestroyedCardMatches / destroyedThisTurnMatchingCountGte) が破壊時のサイズで判定できる）。
// 呼び出し時点で card は既に場から外れており effectiveSize は場外扱いで印字サイズを返すため、
// conditionalSize の上書き(granter在場)は直接適用して破壊時サイズを求める。
function frozenSizeAtDestroy(card) {
  const override = card.conditionalSize;
  // unconditional（「場から離れるまでサイズ0」H-PP01/0013 等）は granter 不在でも有効。
  // src/05 effectiveSize の判定 (override.unconditional || granterOnField(...)) と同形に揃える。
  return override && (override.unconditional || granterOnField(override.granterInstanceId))
    ? Math.max(0, override.size || 0)
    : effectiveSize(card);
}

// monstersDestroyedThisTurn（このターン破壊されたモンスター数・所有者別）を destroyedCardsThisTurn から導出し、
// state.monstersDestroyedThisTurn へ書き戻す（並走していた2トラッカーの一本化）。
// 読み出し側 src/13 の monstersDestroyedThisTurnGte は state プロパティを直接参照するため（src/13 は編集対象外）、
// 導出結果を同プロパティに反映して互換を保つ。破壊記録の push 直後とターン境界リセット直後に呼ぶ。
function syncMonstersDestroyedThisTurn() {
  state.monstersDestroyedThisTurn = (state.destroyedCardsThisTurn || [[], []]).map(
    (entries) => (entries || []).filter((entry) => entry.wasMonster).length,
  );
}

function recordDestroyedEventWindow(card, owner) {
  const sizeAtDestroy = frozenSizeAtDestroy(card);
  const entry = { card, owner, sizeAtDestroy };
  if (state.destroyedEventWindow && state.destroyedEventWindow.turnCount === state.turnCount) {
    state.destroyedEventWindow.entries.push(entry);
    return;
  }
  state.destroyedEventWindow = {
    kind: "destroyed",
    entries: [entry],
    turnCount: state.turnCount,
  };
}

function recordEnteredEventWindow(card, owner, zone) {
  if (state.enteredEventWindow && state.enteredEventWindow.turnCount === state.turnCount) {
    state.enteredEventWindow.entries.push({ card, owner, zone });
    return;
  }
  state.enteredEventWindow = {
    kind: "entered",
    entries: [{ card, owner, zone }],
    turnCount: state.turnCount,
  };
}

function expireTransientResponseWindows(options = {}) {
  const preserved = options.preserveSpecialCallOpportunity;
  (state.specialCallOpportunities || []).forEach((event) => {
    if (!event.used && !event.expired && event !== preserved) {
      event.expired = true;
    }
  });
  state.counterEventWindow = null;
  state.destroyedEventWindow = null;
  state.enteredEventWindow = null;
}

function queueDestroyedTriggers(card, owner, zone, cause = null) {
  if (!(card.abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "destroyed")) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runTriggeredAbilities(card, "destroyed", {
        card,
        player: state.players[owner],
        owner,
        zone,
        destroyCause: cause,
      });
      // 破壊時能力で使われなかったソウルはドロップへ（destroyFieldCard で遅延した分の回収）。
      if ((card.soul || []).length > 0) {
        state.players[owner].drop.push(...card.soul);
        card.soul = [];
      }
      render();
    })
    .catch((error) => {
      console.error(error);
      addLog(`${card.name}の破壊時能力の処理中にエラーが発生しました。`);
      render();
    });
}

// queue*Triggers 系 microtask の共通定型: winner決着済みならスキップ→runner実行→render。
// エラー時は console.error＋（errorLabel があれば）ログ表示＋render（3関数に散っていた定型の集約。挙動不変）。
function queueTriggerMicrotask(runner, { errorLabel } = {}) {
  Promise.resolve()
    .then(async () => {
      if (state.winner) {
        return;
      }
      await runner();
      render();
    })
    .catch((error) => {
      console.error(error);
      if (errorLabel) {
        addLog(errorLabel);
      }
      render();
    });
}

// 「このカードが場かデッキからドロップゾーンに置かれた時」の誘発（H-SS01 リーゼントホーン等）。
// fromZone: "field" | "deck"。ability.fromZones（省略時は両方）で絞る。
// 対応経路: 破壊(destroyFieldCard)・ルール/効果ドロップ(dropFieldCardByRule)・mill(moveTopDeckToDrop)・
// script の moveSelected(to:"drop")。コストstep由来のドロップ等は対象外（意図的近似）。
function queueMovedToDropTriggers(card, owner, fromZone) {
  const matches = (ability) =>
    ability.kind === "triggered" &&
    ability.event === "movedToDrop" &&
    (!ability.fromZones || ability.fromZones.includes(fromZone));
  if (!(card.abilities || []).some(matches)) {
    return;
  }
  queueTriggerMicrotask(
    () =>
      runTriggeredAbilities(card, "movedToDrop", {
        card,
        player: state.players[owner],
        owner,
        zone: "drop",
        fromZone,
        __abilityFilter: matches,
      }),
    { errorLabel: `${card.name}のドロップ時能力の処理中にエラーが発生しました。` },
  );
}

// 「このカードが（場かドロップから）ソウルに入った時」の誘発（H-SS01 竜装機 チャージャー等）。
// fromZone: "field" | "drop" | "hand"。ability.fromZones（省略時は全部）で絞る。
// 対応経路: 星合体/ソウル投入 script（moveSelfToSelectedSoul/moveSelectedToSelectedSoul）・
// moveSelfToTargetSoul・コストの putDropToSoul/putOwnFieldCardsToSoul。
function queueEnteredSoulTriggers(card, owner, fromZone, hostCard) {
  const matches = (ability) =>
    ability.kind === "triggered" &&
    ability.event === "enteredSoul" &&
    (!ability.fromZones || ability.fromZones.includes(fromZone));
  if (!(card.abilities || []).some(matches)) {
    return;
  }
  queueTriggerMicrotask(
    () =>
      runTriggeredAbilities(card, "enteredSoul", {
        card,
        player: state.players[owner],
        owner,
        zone: "soul",
        fromZone,
        hostCard,
        __abilityFilter: matches,
      }),
    { errorLabel: `${card.name}のソウル投入時能力の処理中にエラーが発生しました。` },
  );
}

// 「（相手が）カードを引いた時」の誘発。drawCards（通常ドロー含む全経路）から1枚ごとに呼ばれ、
// runFieldEventTriggers("drew") が allyDrew / opponentDrew を両者の場札へ動的配送する（H-BT04/0008 爆雷等）。
// listener が無ければ何もしない（既存挙動への影響ゼロ）。
function queueDrewTriggers(drawerOwner) {
  if (!Array.isArray(state?.players)) {
    return;
  }
  // listener 検出は cardHasTriggeredListener に統一（自身の abilities／ソウル札の soulAbilities／
  // inheritSoulAbilities 経由の継承爆雷=EB03ヤミゲドウ×H-BT04/0008 まで見る。queueGaugePlacedTriggers と同じ検出）。
  const hasListener = state.players.some((player) =>
    zones.some((zone) => {
      const card = player?.field?.[zone];
      return (
        cardHasTriggeredListener(card, "allyDrew") || cardHasTriggeredListener(card, "opponentDrew")
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  queueTriggerMicrotask(() => runFieldEventTriggers("drew", drawerOwner), {
    errorLabel: "ドロー時能力の処理中にエラーが発生しました。",
  });
}

// 設置カードの「このカードのソウルがなくなった時、このカードをドロップゾーンに置く」
// （card.dropWhenSoulEmpty:true。H-BT04/0025 雷破の構え等）。ソウル消費コストの支払い後に呼ぶ。
function maybeDropSetWhenSoulEmpty(card, owner) {
  if (!card?.dropWhenSoulEmpty || (card.soul || []).length > 0) {
    return;
  }
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return;
  }
  const dropped = dropFieldCardByRule(state.players[slot.owner], slot.zone);
  if (dropped) {
    addLog(`${dropped.name}はソウルがなくなったためドロップゾーンに置かれました。`);
  }
}

// 「君がダメージを受けた時」の誘発。ダメージを受けたプレイヤー自身の場札の
// kind:"triggered" event:"damageReceived" を発火する（BT03の五角/角王ダメージ受け系の中核）。
// applyDamageToPlayer(同期)から呼ぶため microtask で遅延実行。listener が無ければ何もしない。
function queueDamageReceivedTriggers(owner, amount, options = {}) {
  const player = state.players[owner];
  if (!player) {
    return;
  }
  const hasListener = zones.some((zone) => {
    const card = player.field[zone];
    return card && (card.abilities || []).some((a) => a.kind === "triggered" && a.event === "damageReceived");
  });
  if (!hasListener) {
    return;
  }
  const damageSourceLabel = options.sourceAbilityLabel || null;
  const byAttack = Boolean(options.byAttack);
  Promise.resolve()
    .then(async () => {
      if (state.winner) {
        return;
      }
      for (const zone of zones) {
        const card = player.field[zone];
        if (!card) {
          continue;
        }
        await runTriggeredAbilities(card, "damageReceived", {
          card,
          player,
          owner,
          zone,
          damageAmount: amount,
          byAttack,
          damageSourceLabel,
          // ability.nonAttackOnly / byAttackOnly でダメージ種別を絞れる（H-BT04/0053「攻撃以外のダメージ」等）。
          __abilityFilter: (ability) =>
            (!ability.nonAttackOnly || !byAttack) && (!ability.byAttackOnly || byAttack),
        });
      }
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

// 「君の場の(他の)モンスターが破壊された時」など、場の他カードが反応する破壊フィールドイベント。
// 破壊されたカード自身の destroyed 誘発(queueDestroyedTriggers)とは別に、ally/opponent Destroyed を
// 場の全枠(set枠含む)へ配送する。設置呪文「飢えたるヤミゲドウ」等が set ゾーンで反応するための経路。
// 反応するカードが場に無ければ何もしない。発火対象はモンスターに限らず(条件 eventCardMatches で絞る)。
function queueAllyDestroyedTriggers(card, owner, zone, cause = null) {
  const hasListener = [0, 1].some((playerIndex) =>
    zones.some((fieldZone) => {
      const sourceCard = state.players[playerIndex]?.field?.[fieldZone];
      return (
        sourceCard &&
        (sourceCard.abilities || []).some(
          (ability) =>
            ability.kind === "triggered" &&
            (ability.event === "allyDestroyed" || ability.event === "opponentDestroyed"),
        )
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runFieldEventTriggers("destroyed", owner, card, zone, { destroyCause: cause });
      render();
    })
    .catch((error) => {
      console.error(error);
      addLog(`${card?.name ?? "カード"}の破壊フィールド誘発の処理中にエラーが発生しました。`);
      render();
    });
}

// 「場のモンスターが手札/デッキに戻った時」の誘発（D・R・システム / 竜剣 ドラムソード等、場の他カードが反応）。
// 復帰処理は同期関数のため、破壊/手札破棄の誘発と同じくマイクロタスクで非同期発火する。
function queueMonsterReturnedTriggers(card, owner, zone) {
  if (effectiveCardType(card) !== "monster") {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runFieldEventTriggers("monsterReturned", owner, card, zone);
      render();
    })
    .catch((error) => {
      console.error(error);
      addLog(`${card?.name ?? "カード"}の復帰誘発の処理中にエラーが発生しました。`);
      render();
    });
}

function queueDiscardedFromHandTriggers(card, owner) {
  if (!(card.abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "discardedFromHand")) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runTriggeredAbilities(card, "discardedFromHand", { card, player: state.players[owner], owner });
      render();
    })
    .catch((error) => {
      console.error(error);
      addLog(`${card.name}の手札破棄時能力の処理中にエラーが発生しました。`);
      render();
    });
}

// 手札のカードをドロップへ送り、「手札から捨てられた時」誘発を発火させる共通経路。
function discardHandCardsToDrop(player, cards) {
  const owner = state.players.indexOf(player);
  cards.forEach((card) => {
    player.drop.push(card);
    queueDiscardedFromHandTriggers(card, owner);
  });
}

// 使用中カード(inUse)を除く手札を全て手札から取り除いて返す（discardAllHandコスト用）。
// removePileEntriesの{index,card}形式を経由せず直接splice。手札0でも空配列を返す。
function removeInUseHandExcept(player, inUse) {
  const removed = [];
  for (let i = player.hand.length - 1; i >= 0; i -= 1) {
    if (inUse && player.hand[i].instanceId === inUse.instanceId) {
      continue;
    }
    removed.unshift(player.hand.splice(i, 1)[0]);
  }
  return removed;
}

function dropFieldCardByRule(player, zone) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  player.drop.push(...(card.soul || []));
  card.soul = [];
  player.drop.push(card);
  player.field[zone] = null;
  queueMovedToDropTriggers(card, state.players.indexOf(player), "field"); // 効果/ルールで場からドロップへ
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, state.players.indexOf(player));
  return card;
}

function canUseSoulguard(card) {
  return hasKeyword(card, "soulguard") && (card.soul?.length || 0) > 0;
}

// 「はい/いいえ」の確認を、権威サーバでは該当プレイヤー(owner)へ往復で問う。
// 往復は既存の選択ダイアログ(chooseCardEntries の2択)を再利用するため、サーバ/クライアント
// 双方とも追加の prompt 種別を要しない。ブラウザ/中継/テストは従来の同期 window.confirm を維持
// （＝後方互換。回帰テストは window.confirm 経路のまま挙動不変）。
async function confirmChoiceAsync(owner, message, options = {}) {
  if (globalThis.__BUDDYFIGHT_SERVER__ && typeof globalThis.__serverPrompt === "function") {
    const selected = await chooseCardEntries(
      [
        { key: "yes", card: { name: options.yesLabel || "使う", rules: [], attributes: [], keywords: [], costs: {} } },
        { key: "no", card: { name: options.noLabel || "使わない", rules: [], attributes: [], keywords: [], costs: {} } },
      ],
      { title: message, lead: options.lead || "", min: 1, max: 1, forceDialog: true, allowCancel: false, promptSeat: owner },
    );
    return selected?.[0]?.key === "yes";
  }
  if (typeof aiShouldAnswerPrompt === "function" && aiShouldAnswerPrompt(owner)) {
    // CPU対戦: CPU席宛の確認は src/22-ai.js が答える（window.confirm を人間に出さない）。
    return aiAnswerConfirm(owner, message, options);
  }
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(message);
  }
  return true;
}

async function shouldUseSoulguard(card, owner) {
  const useSoulguard = await confirmChoiceAsync(owner, `${card.name}の『ソウルガード』を使いますか？`, { purpose: "soulguard" });
  if (!useSoulguard) {
    addLog(`${card.name}の『ソウルガード』を使いませんでした。`);
  }
  return useSoulguard;
}

function lifeLinkAmount(card) {
  const keywords = [
    ...(card?.keywords || []),
    ...(card?.temporaryKeywords || []),
    ...(card?.turnKeywords || []),
  ];
  const match = keywords.map(String).find((keyword) => /^lifeLink\d+$/i.test(keyword));
  return match ? Number(match.replace(/\D/g, "")) : 0;
}

function hasInstantLifeLink(card) {
  const keywords = [
    ...(card?.keywords || []),
    ...(card?.temporaryKeywords || []),
    ...(card?.turnKeywords || []),
  ].map(String);
  return keywords.some((keyword) =>
    ["lifeLinkLose", "lifeLinkDeath", "lifeLinkInstantDeath", "lifeLinkSokushi", "lifeLink即死"].includes(keyword),
  );
}

function applyLifeLink(card, owner) {
  let amount = lifeLinkAmount(card);
  const instantDefeat = hasInstantLifeLink(card);
  if ((!amount && !instantDefeat) || owner < 0) {
    return null;
  }
  // そのターン中ライフリンクを無効化するフラグ（護竜王アミュレイ 0063 suppressLifeLinkThisTurn）。
  if (state.suppressLifeLinkThisTurn?.[owner]) {
    addLog(`${state.players[owner].name}の場のカードの『ライフリンク』はこのターン無効化されています。`);
    return recordLifeLinkEvent(card, owner, { amount: 0, instantDefeat: false });
  }
  // 継続 nullifyLifeLink による無効化（百鬼将イヨノラセツリュウ 0001「ドロップ10枚以上で場のこのカードのライフリンク無効」）。
  if (isLifeLinkNullifiedBy(card, owner)) {
    addLog(`${card.name}の『ライフリンク』は効果により無効化されています。`);
    return recordLifeLinkEvent(card, owner, { amount: 0, instantDefeat: false });
  }
  const event = recordLifeLinkEvent(card, owner, { amount, instantDefeat });
  if (instantDefeat) {
    if (!state.winner) {
      state.winner = state.players[1 - owner]?.name || null;
    }
    addLog(`${card.name}'s Life Link causes defeat for ${state.players[owner].name}.`);
    return event;
  }
  // 継続 reduceLifeLinkDamage による軽減（護竜王 0111「filter一致カードのライフリンクで受けるダメージをN減らす」）。
  amount = Math.max(0, amount - lifeLinkDamageReductionFor(owner, card));
  event.amount = amount;
  event.appliedDamage = amount > 0 ? applyDamageToPlayer(owner, amount, { log: false }) : 0;
  if (amount > 0) {
    addLog(`${card.name}のライフリンクにより${state.players[owner].name}に${amount}ダメージ。`);
  }
  return event;
}

// 継続 nullifyLifeLink（conditions/filter一致で対象カードのライフリンクを無効化）が card に効いているか。
function isLifeLinkNullifiedBy(card, owner) {
  return zones.some((zone) => {
    const source = state.players[owner]?.field?.[zone];
    return activeContinuousEffects(source).some((effect) => {
      if (effect.op !== "nullifyLifeLink") {
        return false;
      }
      return continuousEffectApplies(effect, card, source);
    });
  });
}

// reduceLifeLinkDamage 継続を持つ場札から、owner が card のライフリンクで受けるダメージの軽減量を返す。
function lifeLinkDamageReductionFor(owner, linkCard) {
  let reduction = 0;
  zones.forEach((zone) => {
    const source = state.players[owner]?.field?.[zone];
    activeContinuousEffects(source).forEach((effect) => {
      if (effect.op !== "reduceLifeLinkDamage" || effect.controller === "opponent") {
        return;
      }
      if (effect.filter && Object.keys(effect.filter).length && !matchesCardFilter(linkCard, effect.filter)) {
        return;
      }
      reduction += effect.amount || 0;
    });
  });
  return reduction;
}

function recordLifeLinkEvent(card, owner, details = {}) {
  state.lifeLinkEvents ||= [];
  const event = {
    id: createInstanceId(),
    card,
    cardId: card?.id || "",
    cardInstanceId: card?.instanceId || "",
    cardName: card?.name || "",
    owner,
    amount: details.amount || 0,
    appliedDamage: 0,
    instantDefeat: Boolean(details.instantDefeat),
    canceled: false,
    turnCount: state.turnCount,
  };
  state.lifeLinkEvents.push(event);
  if (state.lifeLinkEvents.length > 20) {
    state.lifeLinkEvents.splice(0, state.lifeLinkEvents.length - 20);
  }
  return event;
}

function findRecentLifeLinkEvent(owner, spec = {}) {
  const events = state.lifeLinkEvents || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (lifeLinkEventMatches(event, owner, spec)) {
      return event;
    }
  }
  return null;
}

function lifeLinkEventMatches(event, owner, spec = {}) {
  if (!event || event.canceled) {
    return false;
  }
  if (spec.sameTurn !== false && event.turnCount !== state.turnCount) {
    return false;
  }
  if (spec.controller === "opponent") {
    if (event.owner === owner) {
      return false;
    }
  } else if (spec.controller !== "any" && event.owner !== owner) {
    return false;
  }
  return matchesCardFilter(event.card, spec.filter || {});
}

function cancelRecentLifeLink(owner, spec = {}, sourceName = "") {
  const event = findRecentLifeLinkEvent(owner, spec);
  if (!event) {
    return null;
  }
  event.canceled = true;
  if (event.appliedDamage > 0) {
    state.players[event.owner].life += event.appliedDamage;
  }
  clearWinnerIfNoCurrentLoss();
  addLog(`${sourceName || event.cardName} canceled ${event.cardName}'s Life Link.`);
  return event;
}

function findLifeLinkEventForCallOpportunity(owner, spec = {}) {
  const opportunity = findSpecialCallOpportunity(owner, spec);
  if (!opportunity) {
    return null;
  }
  if (opportunity.lifeLinkEventId) {
    const byId = (state.lifeLinkEvents || []).find(
      (event) => event.id === opportunity.lifeLinkEventId && !event.canceled,
    );
    if (byId) {
      return byId;
    }
  }
  return findRecentLifeLinkEvent(owner, {
    ...spec,
    filter: spec.filter || { name: opportunity.destroyedName },
  });
}

function cancelCallOpportunityLifeLink(owner, spec = {}, sourceName = "") {
  const opportunity = findSpecialCallOpportunity(owner, spec);
  const event = findLifeLinkEventForCallOpportunity(owner, spec);
  if (!opportunity || !event) {
    return null;
  }
  opportunity.lifeLinkCanceled = true;
  event.canceled = true;
  if (event.appliedDamage > 0) {
    state.players[event.owner].life += event.appliedDamage;
  }
  clearWinnerIfNoCurrentLoss();
  addLog(`${sourceName || event.cardName} canceled ${event.cardName}'s Life Link.`);
  return event;
}

function clearWinnerIfNoCurrentLoss() {
  if (!state.winner) {
    return;
  }
  const stillLost = state.players.some((player) => player.life <= 0 || player.deck.length === 0);
  if (!stillLost) {
    state.winner = null;
  }
}

async function endTurn() {
  if (state.winner || hasPendingResolution()) {
    return;
  }
  if (state.phase !== "final") {
    addLog("ターン終了はファイナルフェイズの終了時に行います。");
    return;
  }
  expireTransientResponseWindows();
  const endingOwner = state.active;
  await runPhaseStartTriggers("turnEnd", endingOwner);
  await runEndTurnEffects(state.active);
  clearDamagePreventionForTurn(endingOwner);
  clearTurnModifiers();
  state.monsterAttackForbidden = [false, false];
  state.monsterAttackForbiddenSources = [[], []];
  // 「そのターン中」限定のライフ0セーフガード（実は生きていた！）はターン終了で失効。
  state.players.forEach((player) => {
    player.lifeZeroSafeguard = null;
  });
  // 「1ターンに1回」はターンごとにリセットされる。相手ターン中に【対抗】で使った turn 制限が
  // 自分の次のターンへ持ち越さないよう、ターン境界で両プレイヤー分をクリアする。
  state.players.forEach((player) => {
    player.oncePerTurn = {};
  });
  if (state.extraTurnOwner === endingOwner) {
    state.extraTurnOwner = null;
    state.active = endingOwner;
    addLog(`${state.players[endingOwner].name}の追加ターンを開始します。`);
  } else {
    state.active = opponentIndex();
  }
  state.turnCount += 1;
  standPlayer(activePlayer());
  state.phase = "draw";
  state.selected = null;
  state.counterHandOwner = null;
  state.chargedThisTurn = false;
  state.drewThisTurn = false;
  state.attacksThisTurn = 0;
  state.attackDestroyedByAttribute = [{}, {}]; // 属性別の攻撃撃破数(このターン)をリセット
  state.destroyedCardsThisTurn = [[], []]; // このターン破壊されたカード記録(destroyedThisTurnMatchingCountGte用)をリセット
  syncMonstersDestroyedThisTurn(); // monstersDestroyedThisTurn は destroyedCardsThisTurn からの導出（リセットで[0,0]になる）
  state.calledCardNamesThisTurn = [{}, {}]; // 「1ターンにN枚だけコール」(竜騎士 トモエ 0012 等)のカウンタをリセット
  state.suppressLifeLinkThisTurn = [false, false]; // ライフリンク無効化(ターンスコープ)をリセット
  state.attackRedirectThisTurn = [null, null]; // 攻撃再誘導(ターンスコープ)をリセット
  state.opponentCounterLockThisTurn = []; // 対抗ロック(ターンスコープ)をリセット
  state.turnDestroyImmunity = []; // ターン限定の破壊耐性(対抗フォースフィールド等)をリセット
  state.lastDamageTaken = [0, 0];
  state.turnDamageEvents = []; // 「武器がダメージを与えたターン中」判定用の蓄積をターン境界でクリア
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  addLog(`${activePlayer().name}のターンです。`);
  render();
}

function clearDamagePreventionForTurn(endingOwner) {
  (state.damagePrevention || []).forEach((entries, owner) => {
    state.damagePrevention[owner] = (entries || []).filter(
      (entry) => entry.untilTurnOwner !== endingOwner,
    );
  });
}

async function runEndTurnEffects(endingOwner) {
  // 複数破壊を逐次解決する（破壊順序・破壊時誘発キューの順序保持のため for-of。並列化禁止）。
  for (const [owner, player] of state.players.entries()) {
    for (const zone of zones) {
      const card = player.field[zone];
      if (card?.destroyAtEndOfTurnOwner === endingOwner) {
        const destroyedName = card.name;
        card.destroyAtEndOfTurnOwner = null;
        const destroyed = await destroyFieldCard(owner, zone, { ignoreSoulguard: true });
        if (destroyed) {
          addLog(`${destroyedName}はターン終了時の効果で破壊されました。`);
        }
      } else if (card?.putToGaugeAtEndOfTurnOwner === endingOwner) {
        // 「ターン終了時、そのモンスターを君のゲージに置く」。ソウルはドロップへ、本体をゲージへ。
        const destOwner = card.putToGaugeAtEndOfTurnOwner;
        card.putToGaugeAtEndOfTurnOwner = null;
        player.field[zone] = null;
        if ((card.soul || []).length > 0) {
          player.drop.push(...card.soul);
          card.soul = [];
        }
        state.players[destOwner].gauge.push(card);
        queueGaugePlacedTriggers(destOwner, [card]); // 相手のゲージにカードが置かれた時（0020）
        addLog(`${card.name}はターン終了時の効果でゲージに置かれました。`);
      }
    }
  }
}

function clearTurnModifiers() {
  state.spiritStrikeDamageBonus = [0, 0]; // 霊撃ブースト（ターンスコープ）をリセット
  // ターン終了時のプレイヤー単位ゾーン一括移動の予約を消費（scheduleZoneMoveAtTurnEnd。H-PP01/0060）。
  (state.turnEndZoneMoves || []).forEach((move) => {
    const movePlayer = state.players[move.owner];
    if (!movePlayer || !Array.isArray(movePlayer[move.from]) || !Array.isArray(movePlayer[move.to])) {
      return;
    }
    const movedCards = movePlayer[move.from].splice(0);
    movePlayer[move.to].push(...movedCards);
    if (movedCards.length > 0) {
      addLog(`${move.sourceName}の効果で${movePlayer.name}の${move.from === "gauge" ? "ゲージ" : move.from}全て（${movedCards.length}枚）を${move.to === "drop" ? "ドロップゾーン" : move.to}に置きました。`);
    }
  });
  state.turnEndZoneMoves = [];
  // 「捨てたカードの能力全てをターン中得る」(gainSelectedCardAbilitiesForTurn) のコピー(__turnCopy)を除去。
  // ホストが場を離れた場合や権威サーバのstate再構築で参照が切れた場合にも確実に剥がすため、
  // 参照リストではなく両者の全パイル（場＋ソウル・手札・ドロップ・デッキ・ゲージ）を走査する。
  // 場以外のカードに残った turnKeywords 等のターンスコープ付与もここで掃除する（場は下の既存クリアが担う）。
  state.players.forEach((player) => {
    const piles = [player.hand || [], player.drop || [], player.deck || [], player.gauge || []];
    zones.forEach((zone) => {
      const fieldCard = player.field[zone];
      if (fieldCard) {
        piles.push([fieldCard], fieldCard.soul || []);
      }
    });
    piles.flat().forEach((card) => {
      if (card?.abilities?.some((ability) => ability.__turnCopy)) {
        card.abilities = card.abilities.filter((ability) => !ability.__turnCopy);
      }
      if (card?.continuous?.some((effect) => effect.__turnCopy)) {
        card.continuous = card.continuous.filter((effect) => !effect.__turnCopy);
      }
      if (card?.turnKeywords?.length && !zones.some((zone) => player.field[zone] === card)) {
        card.turnKeywords = []; // 場を離れたカードに残ったターンスコープキーワードの残留防止
      }
      if (card?.turnTreatAsBuddy) {
        // ターン中に場を離れた（ドロップ/手札/ソウル等の）カードに treatAsBuddyThisTurn が
        // 永続化しないよう全パイルで解除（場のカードは下の既存クリアと重複するが無害）。
        card.turnTreatAsBuddy = false;
      }
    });
  });
  state.players.forEach((player) => {
    player.nextActivatedCostMayUseOpponentGauge = false;
    player.setLockedIdsThisTurn = []; // 「そのターン中は『設置』できない」ロック(発進準備OK！等)をターン終了で解除
    zones.forEach((zone) => {
      const card = player.field[zone];
      if (card) {
        card.turnPowerBonus = 0;
        card.turnDefenseBonus = 0;
        card.turnCriticalBonus = 0;
        card.turnKeywords = [];
        card.turnSuppressedKeywords = [];
        card.preventNextDestroyCount = 0;
        card.preventNextDestroyEffects = []; // 未発火の破壊置換effect(反撃付与等)が翌ターンへ残留しないようクリア
        card.cannotAttackThisTurn = false; // 「そのターン中攻撃できない」(グレイプニル等)をターン終了で解除
        card.turnTreatAsBuddy = false; // 「バディモンスターとして扱う」(treatAsBuddyThisTurn)をターン終了で解除
        // gainNameAsSelected（追加のカード名・ターンスコープ）をリセット。ただし印字の恒久additionalNames
        // (0022の「武神竜王 デュエルズィーガー」等)はベースライン(printedAdditionalNames)へ復元し消さない。
        card.additionalNames = [...(card.printedAdditionalNames || [])];
        if (card.destroyReaction?.duration === "turn") {
          card.destroyReaction = null; // attachDestroyReaction（そのターン中のみ）を解除
        }
        // scheduledStatBonus（nextOwnTurnEnd 等）: expireOwner のターン終了で失効。
        // セットした相手ターンの終了ではまだ失効させず、次の expireOwner ターン終了で消す（armed フラグで1回遅延）。
        if (card.scheduledStatBonus?.length) {
          card.scheduledStatBonus = card.scheduledStatBonus.filter((b) => {
            if (b.expireOwner !== state.active) {
              return true; // 相手のターン終了では失効しない
            }
            if (b.armed) {
              return false; // expireOwner のターン終了（2回目）で失効
            }
            b.armed = true; // expireOwner のターン終了（1回目）はまだ保持
            return true;
          });
        }
      }
    });
  });
}

function standPlayer(player) {
  zones.forEach((zone) => {
    const card = player.field[zone];
    if (card) {
      // preventStandNextTurn（甲蠍 堅牢砦 0042「次の相手のスタートフェイズ中、相手のアイテムはスタンドできない」）。
      // 該当カードは1回だけスタンドをスキップ（used=trueのまま）してフラグ消費。
      if (card.preventStandOnce) {
        card.preventStandOnce = false;
        addLog(`${card.name}は効果により【スタンド】できません。`);
      } else {
        card.used = false;
      }
      card.battlePowerBonus = 0;
      card.battleDefenseBonus = 0;
      card.battleCriticalBonus = 0;
      card.counterattack = false;
      card.doubleAttackUsed = false;
      card.tripleAttackStandCount = 0;
    }
  });
}

function resolveLifeZeroReplacements() {
  state.players.forEach((player, owner) => {
    if (player.life > 0) {
      return;
    }
    const replacementSlot = [...setZones, "item", ...fieldZones]
      .map((zone) => ({ zone, card: player.field[zone] }))
      .find(
        ({ card }) =>
          card?.lifeZeroReplacement &&
          // soulCost 型はソウルが足りる時だけ置換候補になる（不足時は次の敗北処理へ）
          (!card.lifeZeroReplacement.soulCost ||
            (card.soul || []).length >= (card.lifeZeroReplacement.soulCost.amount || 1)),
      );
    if (!replacementSlot) {
      // プレイヤー単位の一回限りセーフガード（実は生きていた！）。場札の置換が無い場合に消費する。
      if (player.lifeZeroSafeguard) {
        const safeguard = player.lifeZeroSafeguard;
        player.lifeZeroSafeguard = null;
        player.life = safeguard.life || 1;
        addLog(`${player.name}は「実は生きていた！」でライフが${player.life}になりました。`);
        // 追加効果（蒼舞天滝陣 0037: 手札全捨て＋相手にダメージ2）を同期実行する。
        // resolveLifeZeroReplacements は同期経路のため、ここでは applyDamageToPlayer 等の非同期を使わず
        // ライフ/手札の直接操作のみ対応する（相手ライフ0は後続の checkWinner 本体が捕捉する）。
        for (const eff of safeguard.effects || []) {
          if (eff.op === "discardAllHand") {
            const discarded = player.hand.splice(0);
            player.drop.push(...discarded);
            if (discarded.length) addLog(`${player.name}は手札を全て捨てました。`);
          } else if (eff.op === "dealDamage") {
            const receiver = eff.player === "opponent" ? state.players[1 - owner] : player;
            receiver.life -= eff.amount || 0;
            addLog(`${player.name}の効果で${receiver.name}に${eff.amount || 0}ダメージ！`);
          } else if (eff.op === "gainLife") {
            player.life += eff.amount || 0;
          }
        }
      }
      return;
    }
    const { zone, card } = replacementSlot;
    const replacement = card.lifeZeroReplacement;
    if (replacement.sacrificeFilter) {
      // 『搭乗』しているカード等1枚を生贄に破壊してライフを守る（ブレイブフォート 0029）。
      // 生贄が無ければ守れない（発生源も破壊しない）。
      const sac = zones
        .map((z) => ({ z, c: player.field[z] }))
        .find(({ z, c }) => c && z !== zone && matchesCardFilter(c, replacement.sacrificeFilter));
      if (!sac) {
        return;
      }
      dropFieldCardByRule(player, sac.z);
      dropFieldCardByRule(player, zone);
      player.life = replacement.life || 1;
      if ((replacement.draw || 0) > 0 && !isDrawByEffectPrevented(state.players.indexOf(player))) {
        drawCards(player, replacement.draw || 0);
      }
      addLog(`${card.name}の効果で${sac.c.name}を破壊し、${player.name}のライフは${player.life}になりました。`);
      return;
    }
    if (replacement.soulCost) {
      // 「このカードのソウルN枚を捨ててよい。捨てたら、君のライフはlifeになる」型
      // （カード自身は場に残る。H-BT04/0001 カイザー・ドラム“固い絆”）。任意だが有利な置換のため自動使用（既存置換と同仕様）。
      const soulAmount = replacement.soulCost.amount || 1;
      for (let index = 0; index < soulAmount; index += 1) {
        const soulCard = card.soul.pop();
        if (soulCard) {
          player.drop.push(soulCard);
        }
      }
      player.life = replacement.life || 1;
      addLog(`${card.name}の効果でソウル${soulAmount}枚を捨て、${player.name}のライフは${player.life}になりました。`);
      return;
    }
    let hasRequiredSoul = true;
    if (replacement.soulFilter) {
      const soulCards = card.soul?.splice(0) || [];
      player.drop.push(...soulCards);
      hasRequiredSoul = soulCards.some((soulCard) =>
        matchesCardFilter(soulCard, replacement.soulFilter || {}),
      );
    }
    let topDeckCard = null;
    if (replacement.topDeckFilter) {
      topDeckCard = player.deck.pop() || null;
      if (topDeckCard) {
        player.drop.push(topDeckCard);
      } else {
        declareDeckLoss(player);
      }
      hasRequiredSoul = Boolean(topDeckCard && matchesCardFilter(topDeckCard, replacement.topDeckFilter));
    }
    dropFieldCardByRule(player, zone);
    if (!hasRequiredSoul) {
      addLog(`${card.name}のソウルに条件を満たすカードがないため、ライフを守れませんでした。`);
      return;
    }
    player.life = replacement.life || 1;
    if ((replacement.draw || 0) > 0 && !isDrawByEffectPrevented(state.players.indexOf(player))) {
      drawCards(player, replacement.draw || 0);
    }
    addLog(`${card.name}の効果で${player.name}のライフは${player.life}になりました。`);
  });
}

function checkWinner() {
  resolveLifeZeroReplacements();
  state.players.forEach((player, index) => {
    if (player.life <= 0 && !state.winner) {
      state.winner = state.players[1 - index].name;
      addLog(`${state.winner}の勝利です。`);
    }
    if (player.deck.length === 0 && !state.winner) {
      state.winner = state.players[1 - index].name;
      addLog(`${player.name}のデッキが0枚のため、${state.winner}の勝利です。`);
    }
  });
}

function declareDeckLoss(player) {
  if (!state?.players || state.winner) {
    return;
  }
  const loserIndex = state.players.indexOf(player);
  if (loserIndex < 0) {
    return;
  }
  state.winner = state.players[1 - loserIndex].name;
  addLog(`${player.name}のデッキが0枚のため、${state.winner}の勝利です。`);
}


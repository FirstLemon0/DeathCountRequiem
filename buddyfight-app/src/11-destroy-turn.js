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
    const blocked = sources.length === 0 || sources.some((src) => !ignored.includes(src));
    if (blocked) {
      return false;
    }
  }
  if (
    effectiveCardType(attacker.card) === "item" &&
    player?.field.center &&
      !hasKeyword(attacker.card, "canAttackWithCenter")
  ) {
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
  // 効果による破壊の発生源情報（破壊耐性 destroyImmunity の判定に使う）
  return {
    byEffect: true,
    byOpponent: victimOwner !== context.owner,
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

function destroyImmunityBlocks(card, cause, owner) {
  if (!cause) return false;
  if (grantedDestroyImmunityBlocks(card, cause)) return true;
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
    if (replacement?.gainLife) {
      state.players[replacement.owner ?? owner].life += replacement.gainLife;
      addLog(`${replacement.source || card.name}の効果で${state.players[replacement.owner ?? owner].name}のライフを${replacement.gainLife}回復しました。`);
    }
    addLog(`${card.name}は効果により場に残りました。`);
    if (countsAsDestroyed) {
      recordSpecialCallOpportunity(card, owner, zone, options);
      queueDestroyedTriggers(card, owner, zone);
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
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, owner);
  recordDestroyedEventWindow(card, owner);
  recordSpecialCallOpportunity(card, owner, zone, options);
  queueDestroyedTriggers(card, owner, zone);
  queueAllyDestroyedTriggers(card, owner, zone);
  return card;
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
    const cost = rule.cost || [{ op: "dropSource" }];
    if (!canPayStructuredCost(player, cost, { sourceCard: replacer, selectedCard: replacer }).ok) {
      continue;
    }
    if (rule.optional && !(await confirmChoiceAsync(owner, `${replacer.name}を置いて${card.name}を場に残しますか？`))) {
      continue;
    }
    const payment = payStructuredCost(player, cost, { sourceCard: replacer, selectedCard: replacer });
    if (!payment.ok) {
      continue;
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
  if (!canPayStructuredCost(player, replacement.cost || [], {
    sourceCard: card,
    selectedCard: card,
  }).ok) {
    return false;
  }
  if (replacement.optional && !(await confirmChoiceAsync(owner, `${card.name}の破壊置換を使いますか？`))) {
    return false;
  }
  const payment = payStructuredCost(player, replacement.cost || [], {
    sourceCard: card,
    selectedCard: card,
  });
  if (!payment.ok) {
    return false;
  }
  if (replacement.gainLife) {
    player.life += replacement.gainLife;
  }
  if (replacement.to === "gauge") {
    const slot = findFieldCardSlot(card);
    if (slot) {
      player.drop.push(...(card.soul || []));
      card.soul = [];
      player.field[slot.zone] = null;
      player.gauge.push(card);
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

function recordDestroyedEventWindow(card, owner) {
  if (state.destroyedEventWindow && state.destroyedEventWindow.turnCount === state.turnCount) {
    state.destroyedEventWindow.entries.push({ card, owner });
    return;
  }
  state.destroyedEventWindow = {
    kind: "destroyed",
    entries: [{ card, owner }],
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

function queueDestroyedTriggers(card, owner, zone) {
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

// 「君の場の(他の)モンスターが破壊された時」など、場の他カードが反応する破壊フィールドイベント。
// 破壊されたカード自身の destroyed 誘発(queueDestroyedTriggers)とは別に、ally/opponent Destroyed を
// 場の全枠(set枠含む)へ配送する。設置呪文「飢えたるヤミゲドウ」等が set ゾーンで反応するための経路。
// 反応するカードが場に無ければ何もしない。発火対象はモンスターに限らず(条件 eventCardMatches で絞る)。
function queueAllyDestroyedTriggers(card, owner, zone) {
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
      await runFieldEventTriggers("destroyed", owner, card, zone);
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

function dropFieldCardByRule(player, zone) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  player.drop.push(...(card.soul || []));
  card.soul = [];
  player.drop.push(card);
  player.field[zone] = null;
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
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(message);
  }
  return true;
}

async function shouldUseSoulguard(card, owner) {
  const useSoulguard = await confirmChoiceAsync(owner, `${card.name}の『ソウルガード』を使いますか？`);
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
  const amount = lifeLinkAmount(card);
  const instantDefeat = hasInstantLifeLink(card);
  if ((!amount && !instantDefeat) || owner < 0) {
    return null;
  }
  const event = recordLifeLinkEvent(card, owner, { amount, instantDefeat });
  if (instantDefeat) {
    if (!state.winner) {
      state.winner = state.players[1 - owner]?.name || null;
    }
    addLog(`${card.name}'s Life Link causes defeat for ${state.players[owner].name}.`);
    return event;
  }
  event.appliedDamage = applyDamageToPlayer(owner, amount, { log: false });
  addLog(`${card.name}のライフリンクにより${state.players[owner].name}に${amount}ダメージ。`);
  return event;
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
  activePlayer().oncePerTurn = {};
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
  state.lastDamageTaken = [0, 0];
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
        addLog(`${card.name}はターン終了時の効果でゲージに置かれました。`);
      }
    }
  }
}

function clearTurnModifiers() {
  state.spiritStrikeDamageBonus = [0, 0]; // 霊撃ブースト（ターンスコープ）をリセット
  state.players.forEach((player) => {
    player.nextActivatedCostMayUseOpponentGauge = false;
    zones.forEach((zone) => {
      const card = player.field[zone];
      if (card) {
        card.turnPowerBonus = 0;
        card.turnDefenseBonus = 0;
        card.turnCriticalBonus = 0;
        card.turnKeywords = [];
        card.turnSuppressedKeywords = [];
        card.preventNextDestroyCount = 0;
      }
    });
  });
}

function standPlayer(player) {
  zones.forEach((zone) => {
    const card = player.field[zone];
    if (card) {
      card.used = false;
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
    const replacementSlot = [...setZones, "item"]
      .map((zone) => ({ zone, card: player.field[zone] }))
      .find(({ card }) => card?.lifeZeroReplacement);
    if (!replacementSlot) {
      // プレイヤー単位の一回限りセーフガード（実は生きていた！）。場札の置換が無い場合に消費する。
      if (player.lifeZeroSafeguard) {
        const safeguard = player.lifeZeroSafeguard;
        player.lifeZeroSafeguard = null;
        player.life = safeguard.life || 1;
        addLog(`${player.name}は「実は生きていた！」でライフが${player.life}になりました。`);
      }
      return;
    }
    const { zone, card } = replacementSlot;
    const replacement = card.lifeZeroReplacement;
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
    drawCards(player, replacement.draw || 0);
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


// ==========================================================================
// buddyfight モジュール 04 — ドロー/ダメージ/ゲージ/コスト支払い
// 旧 app.js L881-1758 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function drawCards(player, count = 1, shouldLog = true) {
  for (let index = 0; index < count; index += 1) {
    if (player.deck.length === 0) {
      if (shouldLog) {
        addLog(`${player.name}のデッキが0枚です。`);
      }
      declareDeckLoss(player);
      return;
    }
    const card = player.deck.pop();
    if (card) {
      player.hand.push(card);
      if (player.deck.length === 0) {
        if (shouldLog) {
          addLog(`${player.name}のデッキが0枚になりました。`);
        }
        declareDeckLoss(player);
        return;
      }
    }
  }
}

function applyDamageToPlayer(owner, amount = 0, options = {}) {
  const player = state.players[owner];
  if (!player || amount <= 0) {
    return 0;
  }
  state.damagePrevention ||= [[], []];
  state.damagePrevention[owner] ||= [];
  let remaining = amount;
  // 軽減/無効の無視判定: 名称配列(後方互換) または attackResistances由来の filter エントリ
  const ignoreNames = options.ignoreNamedPreventions
    || (options.ignoreNamedPrevention ? [options.ignoreNamedPrevention] : []);
  const resistEntries = options.resistEntries || [];
  const isPreventionResisted = (prevention) =>
    ignoreNames.some((n) => (prevention.source || "").includes(n)) ||
    resistEntries.some((e) => resistanceFilterMatches(e.filter, prevention.sourceCard, prevention.source));
  const queue = state.damagePrevention[owner];
  let i = 0;
  while (!options.ignorePrevention && remaining > 0 && i < queue.length) {
    const prevention = queue[i];
    if (isPreventionResisted(prevention)) {
      // この攻撃には適用しない（キューには残す）
      i += 1;
      continue;
    }
    const reduction = prevention.preventAll ? remaining : Math.min(remaining, prevention.amount || 0);
    remaining -= reduction;
    if (!prevention.preventAll) {
      prevention.amount = Math.max(0, (prevention.amount || 0) - reduction);
    }
    if (reduction > 0) {
      addLog(`${prevention.source || "効果"}により${player.name}へのダメージを${reduction}減らしました。`);
    }
    if (prevention.preventAll || prevention.amount <= 0 || prevention.once !== false) {
      queue.splice(i, 1);
    } else {
      i += 1;
    }
  }
  if (remaining > 0) {
    player.life -= remaining;
    // 受けたダメージ量を記録（豪胆逆怒などの「受けたダメージと同じ数値分」効果が参照する）
    state.lastDamageTaken ||= [0, 0];
    state.lastDamageTaken[owner] = remaining;
    if (options.log !== false && options.sourceName) {
      addLog(`${options.sourceName}により${player.name}に${remaining}ダメージを与えました。`);
    }
    checkWinner();
  }
  return remaining;
}

function addNextDamagePrevention(owner, prevention) {
  state.damagePrevention ||= [[], []];
  state.damagePrevention[owner] ||= [];
  state.damagePrevention[owner].push({
    untilTurnOwner: state.active,
    once: true,
    ...prevention,
  });
}

function spendGauge(player, amount = 0) {
  if (player.gauge.length < amount) {
    return false;
  }
  const spent = player.gauge.splice(player.gauge.length - amount, amount);
  player.drop.push(...spent);
  return true;
}

function canSpendGaugePool(player, amount = 0, options = {}) {
  if (player.gauge.length >= amount) {
    return true;
  }
  const owner = state.players.indexOf(player);
  const opponent = state.players[1 - owner];
  return Boolean(options.includeOpponent && player.gauge.length + (opponent?.gauge.length || 0) >= amount);
}

function spendGaugePool(player, amount = 0, options = {}) {
  if (!canSpendGaugePool(player, amount, options)) {
    return false;
  }
  const ownAmount = Math.min(player.gauge.length, amount);
  spendGauge(player, ownAmount);
  const remaining = amount - ownAmount;
  if (remaining > 0) {
    const owner = state.players.indexOf(player);
    const opponent = state.players[1 - owner];
    spendGauge(opponent, remaining);
    addLog(`${player.name}は相手のゲージ${remaining}枚をコストに使いました。`);
  }
  return true;
}

function canPayCost(player, cost = {}, selectedCard) {
  const gauge = cost.gauge || 0;
  const discard = cost.discard || 0;
  if (player.gauge.length < gauge) {
    return { ok: false, reason: "ゲージが足りません。" };
  }
  const availableHand = player.hand.filter((card) => card.instanceId !== selectedCard?.instanceId);
  if (availableHand.length < discard) {
    return { ok: false, reason: "コストで捨てる手札が足りません。" };
  }
  return { ok: true, discarded: discard > 0 ? availableHand.slice(-discard) : [] };
}

function payCost(player, cost = {}, selectedCard) {
  const payment = canPayCost(player, cost, selectedCard);
  if (!payment.ok) {
    return payment;
  }
  if (!spendGauge(player, cost.gauge || 0)) {
    return { ok: false, reason: "ゲージが足りません。" };
  }
  (payment.discarded || []).forEach((card) => {
    const index = player.hand.findIndex((candidate) => candidate.instanceId === card.instanceId);
    if (index >= 0) {
      player.drop.push(player.hand.splice(index, 1)[0]);
    }
  });
  return { ok: true, discarded: payment.discarded || [] };
}

async function payCostWithSelection(player, cost = {}, selectedCard) {
  const payment = canPayCost(player, cost, selectedCard);
  if (!payment.ok) {
    return payment;
  }
  const discard = cost.discard || 0;
  let selected = [];
  if (discard <= 0) {
    selected = [];
  } else {
    const candidates = player.hand
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => card.instanceId !== selectedCard?.instanceId);
    selected = await chooseCardEntries(candidates, {
      title: "コストで捨てる手札",
      lead: `手札からコストで捨てるカードを${discard}枚選んでください。`,
      min: discard,
      max: discard,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
    });
    if (!selected || selected.length < discard) {
      return { ok: false, reason: "コストで捨てる手札を選んでください。" };
    }
  }
  if (!spendGauge(player, cost.gauge || 0)) {
    return { ok: false, reason: "ゲージが足りません。" };
  }
  const discarded = removePileEntries(player.hand, selected);
  player.drop.push(...discarded);
  if (discarded.length > 0) {
    addLog(`${player.name}はコストで${discarded.map((card) => card.name).join("、")}を捨てました。`);
  }
  return { ok: true, discarded };
}

function canPayCardCost(player, card, purpose, selectedCard = card, context = {}) {
  const structuredCost = cardCostSteps(player, card, purpose, context);
  if (structuredCost.exists) {
    return canPayStructuredCost(player, structuredCost.steps, {
      ...context,
      sourceCard: context.sourceCard || card,
      selectedCard,
    });
  }
  const legacyKey = {
    call: "callCost",
    cast: "castCost",
    equip: "equipCost",
  }[purpose];
  return canPayCost(player, adjustedLegacyCost(player, card, purpose, card[legacyKey]), selectedCard);
}

function payCardCost(player, card, purpose, selectedCard = card, context = {}) {
  const structuredCost = cardCostSteps(player, card, purpose, context);
  if (structuredCost.exists) {
    return payStructuredCost(player, structuredCost.steps, {
      ...context,
      sourceCard: context.sourceCard || card,
      selectedCard,
    });
  }
  const legacyKey = {
    call: "callCost",
    cast: "castCost",
    equip: "equipCost",
  }[purpose];
  return payCost(player, adjustedLegacyCost(player, card, purpose, card[legacyKey]), selectedCard);
}

async function payCardCostWithSelection(player, card, purpose, selectedCard = card, context = {}) {
  const structuredCost = cardCostSteps(player, card, purpose, context);
  if (structuredCost.exists) {
    return payStructuredCostWithSelection(player, structuredCost.steps, {
      ...context,
      sourceCard: context.sourceCard || card,
      selectedCard,
    });
  }
  const legacyKey = {
    call: "callCost",
    cast: "castCost",
    equip: "equipCost",
  }[purpose];
  return payCostWithSelection(player, adjustedLegacyCost(player, card, purpose, card[legacyKey]), selectedCard);
}

function cardCostSteps(player, card, purpose, context = {}) {
  const rawCost = card.costs?.[purpose] ?? context.cost;
  if (!Array.isArray(rawCost)) {
    return { exists: false, steps: [] };
  }
  return {
    exists: true,
    steps: adjustedCostSteps(player, card, purpose, rawCost),
  };
}

function fieldCostReductions(player) {
  // 場のカードが供給する汎用コスト軽減（costReduction:[{purpose,filter,payOp,amount}]）を集約
  const out = [];
  zones.forEach((zone) => {
    const c = player.field[zone];
    (c?.costReduction || []).forEach((r) => out.push(r));
  });
  return out;
}

function costReductionApplies(reduction, card, purpose) {
  return (reduction.purpose || "cast") === purpose && matchesCardFilter(card, reduction.filter || {});
}

function adjustedLegacyCost(player, card, purpose, cost = {}) {
  const adjusted = { ...(cost || {}) };
  fieldCostReductions(player).forEach((r) => {
    if (!costReductionApplies(r, card, purpose)) return;
    const key = r.payOp === "payLife" ? "life" : "gauge";
    if ((adjusted[key] || 0) > 0) adjusted[key] = Math.max(0, adjusted[key] - (r.amount || 1));
  });
  return adjusted;
}

function adjustedCostSteps(player, card, purpose, costSteps = []) {
  const steps = deepClone(costSteps || []);
  fieldCostReductions(player).forEach((r) => {
    if (!costReductionApplies(r, card, purpose)) return;
    const payOp = r.payOp || "payGauge";
    const step = steps.find((st) => st.op === payOp && (st.amount || 0) > 0);
    if (step) step.amount = Math.max(0, step.amount - (r.amount || 1));
  });
  return steps.filter((step) => step.amount === undefined || step.amount > 0);
}

function hasFieldKeyword(player, keyword) {
  return zones.some((zone) => {
    const card = player.field[zone];
    return card && hasKeyword(card, keyword);
  });
}

function canPayStructuredCost(player, costSteps = [], context = {}) {
  const selectedCard = context.selectedCard;
  const includeOpponentGauge = Boolean(context.includeOpponentGauge);
  const applicableCostSteps = costSteps.filter((step) => costStepApplies(player, step, context));
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge" && !canSpendGaugePool(player, amount, { includeOpponent: includeOpponentGauge })) {
      return { ok: false, reason: "ゲージが足りません。" };
    }
    if (step.op === "discardHand") {
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      if (availableHand.length < amount) {
        return { ok: false, reason: "コストで捨てる手札が足りません。" };
      }
    }
    if (step.op === "putHandToSoul") {
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      const minimum = step.min ?? amount;
      if (availableHand.length < minimum) {
        return { ok: false, reason: "ソウルに入れる手札が足りません。" };
      }
    }
    if (step.op === "putCardToSoul") {
      const candidates = cardToSoulCostCandidates(player, step, selectedCard);
      const minimum = step.min ?? amount;
      if (candidates.length < minimum) {
        return { ok: false, reason: "ソウルに入れるカードが足りません。" };
      }
    }
    if (step.op === "payLife" && player.life <= amount) {
      return { ok: false, reason: "ライフが足りません。" };
    }
    if (["cancelRecentLifeLink", "cancelLifeLink"].includes(step.op)) {
      const owner = state.players.indexOf(player);
      if (!findRecentLifeLinkEvent(owner, step)) {
        return { ok: false, reason: "Life Link to cancel was not found." };
      }
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      const owner = state.players.indexOf(player);
      if (!findSpecialCallOpportunity(owner, step)) {
        return { ok: false, reason: "Special call opportunity was not found." };
      }
      if (!findLifeLinkEventForCallOpportunity(owner, step)) {
        return { ok: false, reason: "Life Link to cancel was not found." };
      }
    }
    if (step.op === "putTopDeckToSoul" && player.deck.length < amount) {
      return { ok: false, reason: "ソウルに入れるデッキ枚数が足りません。" };
    }
    if (step.op === "putDropToSoul" && matchingCardsFromPile(player.drop, step.filter).length < (step.min ?? amount)) {
      return { ok: false, reason: "ソウルに入れるドロップのカードが足りません。" };
    }
    if (step.op === "discardSoul" && (context.sourceCard?.soul?.length || 0) < amount) {
      return { ok: false, reason: "ソウルが足りません。" };
    }
    if (step.op === "dropSource" && !findFieldCardSlot(context.sourceCard)) {
      return { ok: false, reason: "コストでドロップゾーンに置くカードが場にありません。" };
    }
    if (step.op === "dropOwnMonster") {
      const explicitTarget = getDropOwnMonsterCostTarget(player, context);
      const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
      const candidates = explicitTarget ? [explicitTarget] : dropOwnMonsterCostCandidates(player, step.filter, excludeId);
      if (candidates.length < amount || (!explicitTarget && !context.allowInteractiveSelection)) {
        return { ok: false, reason: "コストでドロップに置く自分のモンスターを選んでください。" };
      }
    }
    if (step.op === "returnPendingTargetToHand") {
      const owner = state.players.indexOf(player);
      const target = getPendingBattleTargetInfo(state.pendingAttack);
      if (
        !target?.card ||
        target.owner !== owner ||
        cannotReturnToHand(target.card) ||
        !matchesTargetFilter(target.card, target.owner, target.zone, step.filter || {})
      ) {
        return { ok: false, reason: "コストで手札に戻す対象のモンスターがいません。" };
      }
    }
    if (step.op === "putOwnFieldCardsToGauge") {
      const candidates = ownFieldCostCandidates(player, step.filter);
      if (candidates.length < amount) {
        return { ok: false, reason: "コストでゲージに置く自分の場のカードが足りません。" };
      }
    }
  }
  return { ok: true };
}

function getDropOwnMonsterCostTarget(player, context = {}) {
  const owner = state.players.indexOf(player);
  const target = context.costTarget || context.target || getEffectTargetInfo();
  if (
    target &&
    target.owner === owner &&
    fieldZones.includes(target.zone) &&
    effectiveCardType(target.card) === "monster"
  ) {
    return target;
  }
  return null;
}

function dropOwnMonsterCostCandidates(player, filter = {}, excludeInstanceId = null) {
  const owner = state.players.indexOf(player);
  return fieldZones
    .map((zone) => ({ owner, zone, card: player.field[zone], source: "field" }))
    .filter(
      ({ card, zone }) =>
        card &&
        card.instanceId !== excludeInstanceId &&
        matchesTargetFilter(card, owner, zone, { cardType: "monster", ...filter }),
    );
}

function ownFieldCostCandidates(player, filter = {}) {
  const owner = state.players.indexOf(player);
  return zones
    .map((zone) => ({ owner, zone, card: player.field[zone], source: "field" }))
    .filter(({ card, zone }) => card && matchesTargetFilter(card, owner, zone, filter));
}

function cardToSoulCostCandidates(player, step = {}, selectedCard = null, reservedHandIds = new Set()) {
  const owner = state.players.indexOf(player);
  const sources = step.sources || (step.from ? [step.from] : ["hand"]);
  const candidates = [];
  sources.forEach((source) => {
    const pile = player[source];
    if (!Array.isArray(pile)) {
      return;
    }
    pile.forEach((card, index) => {
      if (card.instanceId === selectedCard?.instanceId) {
        return;
      }
      if (source === "hand" && reservedHandIds.has(card.instanceId)) {
        return;
      }
      if (!matchesCardFilter(card, step.filter || {})) {
        return;
      }
      candidates.push({
        card,
        index,
        owner,
        source,
        note: scriptSourceLabel(source),
      });
    });
  });
  return candidates;
}

function costStepApplies(player, step = {}, context = {}) {
  if (!step.conditions?.length) {
    return true;
  }
  const owner = state.players.indexOf(player);
  return checkCardConditions(step.conditions, owner, {
    ...context,
    card: context.sourceCard || context.selectedCard,
  });
}

function moveCostEntriesToSoul(player, entries, sourceCard) {
  const bySource = new Map();
  entries.forEach((entry) => {
    const group = bySource.get(entry.source) || [];
    group.push(entry);
    bySource.set(entry.source, group);
  });
  const movedCards = [];
  bySource.forEach((group, source) => {
    const pile = player[source];
    if (!Array.isArray(pile)) {
      return;
    }
    movedCards.push(...removePileEntries(pile, group));
    if (source === "deck") {
      shuffleInPlace(pile);
      addLog(`${player.name}はデッキをシャッフルしました。`);
    }
  });
  if (movedCards.length > 0) {
    sourceCard.soul ||= [];
    sourceCard.soul.push(...movedCards);
    addLog(`${player.name}はコストで${movedCards.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`);
  }
  return movedCards;
}

function chooseCostEntriesSync(candidates, options = {}) {
  const amount = options.max ?? options.amount ?? 1;
  if ((candidates || []).length <= amount) {
    return (candidates || []).slice(0, amount);
  }
  return fallbackCardEntrySelection(candidates, {
    min: options.min ?? amount,
    max: amount,
    title: options.title || "コストのカード選択",
  });
}

function payStructuredCost(player, costSteps = [], context = {}) {
  const payment = canPayStructuredCost(player, costSteps, context);
  if (!payment.ok) {
    return payment;
  }
  const sourceCard = context.sourceCard;
  const selectedCard = context.selectedCard;
  const includeOpponentGauge = Boolean(context.includeOpponentGauge);
  const applicableCostSteps = costSteps.filter((step) => costStepApplies(player, step, context));
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge") {
      spendGaugePool(player, amount, { includeOpponent: includeOpponentGauge });
    }
    if (step.op === "discardHand") {
      const candidates = player.hand
        .map((card, index) => ({ card, index }))
        .filter(
          ({ card }) =>
            card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
        );
      const selected = chooseCostEntriesSync(candidates, {
        amount,
        min: amount,
        max: amount,
        title: `${sourceCard?.name || "コスト"}で捨てる手札`,
      });
      discardHandCardsToDrop(player, removePileEntries(player.hand, selected || []));
    }
    if (step.op === "putHandToSoul") {
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      availableHand.slice(-amount).forEach((card) => {
        const index = player.hand.findIndex((candidate) => candidate.instanceId === card.instanceId);
        if (index >= 0) {
          sourceCard.soul ||= [];
          sourceCard.soul.push(player.hand.splice(index, 1)[0]);
        }
      });
    }
    if (step.op === "putCardToSoul") {
      const candidates = cardToSoulCostCandidates(player, step, selectedCard).slice(0, amount);
      moveCostEntriesToSoul(player, candidates, sourceCard);
    }
    if (step.op === "payLife") {
      player.life -= amount;
    }
    if (step.op === "returnPendingTargetToHand") {
      const target = getPendingBattleTargetInfo(state.pendingAttack);
      if (target?.card) {
        returnFieldTargetToHand(target, sourceCard?.name || "効果");
      }
    }
    if (["cancelRecentLifeLink", "cancelLifeLink"].includes(step.op)) {
      cancelRecentLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      cancelCallOpportunityLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "putTopDeckToSoul") {
      moveTopDeckToSoul(player, sourceCard, amount);
    }
    if (step.op === "putDropToSoul") {
      moveDropToSoul(player, sourceCard, amount, step.filter);
    }
    if (step.op === "putOwnFieldCardsToSoul") {
      moveFieldCardsToSoul(player, sourceCard, step.filter);
    }
    if (step.op === "discardSoul") {
      for (let index = 0; index < amount; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.drop.push(soulCard);
        }
      }
    }
    if (step.op === "dropSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        dropFieldCardByRule(player, slot.zone);
      }
    }
    if (step.op === "dropOwnMonster") {
      const target = getEffectTargetInfo();
      if (target && target.owner === state.players.indexOf(player) && fieldZones.includes(target.zone)) {
        const dropped = dropFieldCardByRule(player, target.zone);
        if (dropped) {
          addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
        }
      }
    }
    if (step.op === "putOwnFieldCardsToGauge") {
      ownFieldCostCandidates(player, step.filter)
        .slice(0, amount)
        .forEach((target) => putFieldCardToGauge(player, target.zone));
    }
  }
  checkWinner();
  return { ok: true };
}

async function payStructuredCostWithSelection(player, costSteps = [], context = {}) {
  const payment = canPayStructuredCost(player, costSteps, {
    ...context,
    allowInteractiveSelection: true,
  });
  if (!payment.ok) {
    return payment;
  }
  const applicableCostSteps = costSteps.filter((step) => costStepApplies(player, step, context));
  const selectedCard = context.selectedCard;
  const reservedHandIds = new Set();
  const handDiscards = [];
  const handToSoulSelections = [];
  const reservedCostZones = new Set();
  const dropOwnMonsterSelections = [];
  const fieldToGaugeSelections = [];
  const cardToSoulSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "discardHand") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = player.hand
      .map((card, index) => ({ card, index }))
      .filter(
        ({ card }) =>
          card.instanceId !== selectedCard?.instanceId &&
          !reservedHandIds.has(card.instanceId) &&
          matchesCardFilter(card, step.filter || {}),
      );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}で捨てる手札`,
      lead: `手札からコストで捨てるカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストで捨てる手札を選んでください。" };
    }
    selected.forEach(({ card }) => reservedHandIds.add(card.instanceId));
    handDiscards.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putHandToSoul") {
      continue;
    }
    const amount = step.amount || step.max || 1;
    const minimum = step.min ?? amount;
    const maximum = Math.min(step.max ?? amount, amount);
    const candidates = player.hand
      .map((card, index) => ({ card, index }))
      .filter(
        ({ card }) =>
          card.instanceId !== selectedCard?.instanceId &&
          !reservedHandIds.has(card.instanceId) &&
          matchesCardFilter(card, step.filter || {}),
      );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でソウルに入れる手札`,
      lead: `手札からソウルに入れるカードを${minimum}～${maximum}枚選んでください。`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: "コストでソウルに入れる手札を選んでください。" };
    }
    selected.forEach(({ card }) => reservedHandIds.add(card.instanceId));
    handToSoulSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "dropOwnMonster") {
      continue;
    }
    const amount = step.amount || 1;
    const explicitTarget = getDropOwnMonsterCostTarget(player, context);
    if (explicitTarget && !reservedCostZones.has(`${explicitTarget.owner}:${explicitTarget.zone}`)) {
      reservedCostZones.add(`${explicitTarget.owner}:${explicitTarget.zone}`);
      dropOwnMonsterSelections.push([explicitTarget]);
      continue;
    }
    const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
    const candidates = dropOwnMonsterCostCandidates(player, step.filter, excludeId).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でドロップに置くモンスター`,
      lead: `場の自分のモンスターを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストでドロップに置く自分のモンスターを選んでください。" };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    dropOwnMonsterSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putOwnFieldCardsToGauge") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = ownFieldCostCandidates(player, step.filter).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でゲージに置くカード`,
      lead: `自分の場からゲージに置くカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストでゲージに置く自分の場のカードを選んでください。" };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    fieldToGaugeSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putCardToSoul") {
      continue;
    }
    const amount = step.amount || step.max || 1;
    const minimum = step.min ?? amount;
    const maximum = Math.min(step.max ?? amount, amount);
    const candidates = cardToSoulCostCandidates(player, step, selectedCard, reservedHandIds);
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でソウルに入れるカード`,
      lead: `指定された領域からソウルに入れるカードを${minimum}～${maximum}枚選んでください。`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: "コストでソウルに入れるカードを選んでください。" };
    }
    selected
      .filter((entry) => entry.source === "hand")
      .forEach(({ card }) => reservedHandIds.add(card.instanceId));
    cardToSoulSelections.push(selected);
  }

  const sourceCard = context.sourceCard;
  const includeOpponentGauge = Boolean(context.includeOpponentGauge);
  let discardStepIndex = 0;
  let handToSoulStepIndex = 0;
  let cardToSoulStepIndex = 0;
  let dropOwnMonsterStepIndex = 0;
  let fieldToGaugeStepIndex = 0;
  const discarded = [];
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge") {
      spendGaugePool(player, amount, { includeOpponent: includeOpponentGauge });
    }
    if (step.op === "discardHand") {
      const movedCards = removePileEntries(player.hand, handDiscards[discardStepIndex] || []);
      discardStepIndex += 1;
      discardHandCardsToDrop(player, movedCards);
      discarded.push(...movedCards);
      if (movedCards.length > 0) {
        addLog(`${player.name}はコストで${movedCards.map((card) => card.name).join("、")}を捨てました。`);
      }
    }
    if (step.op === "putHandToSoul") {
      const movedCards = removePileEntries(player.hand, handToSoulSelections[handToSoulStepIndex] || []);
      handToSoulStepIndex += 1;
      sourceCard.soul ||= [];
      sourceCard.soul.push(...movedCards);
      if (movedCards.length > 0) {
        addLog(`${player.name}はコストで${movedCards.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`);
      }
    }
    if (step.op === "putCardToSoul") {
      moveCostEntriesToSoul(player, cardToSoulSelections[cardToSoulStepIndex] || [], sourceCard);
      cardToSoulStepIndex += 1;
    }
    if (step.op === "payLife") {
      player.life -= amount;
    }
    if (step.op === "returnPendingTargetToHand") {
      const target = getPendingBattleTargetInfo(state.pendingAttack);
      if (target?.card) {
        returnFieldTargetToHand(target, sourceCard?.name || "効果");
      }
    }
    if (["cancelRecentLifeLink", "cancelLifeLink"].includes(step.op)) {
      cancelRecentLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      cancelCallOpportunityLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "putTopDeckToSoul") {
      moveTopDeckToSoul(player, sourceCard, amount);
    }
    if (step.op === "putDropToSoul") {
      moveDropToSoul(player, sourceCard, amount, step.filter);
    }
    if (step.op === "putOwnFieldCardsToSoul") {
      moveFieldCardsToSoul(player, sourceCard, step.filter);
    }
    if (step.op === "discardSoul") {
      for (let index = 0; index < amount; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.drop.push(soulCard);
        }
      }
    }
    if (step.op === "dropSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        dropFieldCardByRule(player, slot.zone);
      }
    }
    if (step.op === "dropOwnMonster") {
      const selectedTargets = dropOwnMonsterSelections[dropOwnMonsterStepIndex] || [];
      dropOwnMonsterStepIndex += 1;
      selectedTargets.forEach((target) => {
        const dropped = dropFieldCardByRule(player, target.zone);
        if (dropped) {
          addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
        }
      });
    }
    if (step.op === "putOwnFieldCardsToGauge") {
      const selectedTargets = fieldToGaugeSelections[fieldToGaugeStepIndex] || [];
      fieldToGaugeStepIndex += 1;
      selectedTargets.forEach((target) => putFieldCardToGauge(player, target.zone));
    }
  }
  checkWinner();
  return { ok: true, discarded };
}

function moveTopDeckToSoul(player, card, amount = 1) {
  card.soul ||= [];
  for (let index = 0; index < amount; index += 1) {
    const soulCard = player.deck.pop();
    if (soulCard) {
      card.soul.push(soulCard);
    }
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
}

function moveTopDeckToGauge(player, amount = 1) {
  for (let index = 0; index < amount; index += 1) {
    const gaugeCard = player.deck.pop();
    if (gaugeCard) {
      player.gauge.push(gaugeCard);
    }
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
}

function moveDropToSoul(player, card, amount = 1, filter = {}) {
  card.soul ||= [];
  const movedCards = takeMatchingCards(player.drop, filter, amount);
  if (movedCards.length > 0) {
    card.soul.push(...movedCards);
    addLog(`${movedCards.map((soulCard) => soulCard.name).join("、")}を${card.name}のソウルに入れました。`);
  }
}

// 君の場の filter 一致カード全てを、発生源カード(card)のソウルに入れる（コスト用）。
// 例: マセマティック「君の場の《カルテットファイブ》のモンスター全てをこのカードのソウルに入れる」。
function moveFieldCardsToSoul(player, card, filter = {}) {
  card.soul ||= [];
  const moved = [];
  zones.forEach((zone) => {
    const fieldCard = player.field[zone];
    if (fieldCard && fieldCard.instanceId !== card.instanceId && matchesCardFilter(fieldCard, filter)) {
      player.field[zone] = null;
      moved.push(fieldCard);
    }
  });
  if (moved.length > 0) {
    card.soul.push(...moved);
    addLog(`${moved.map((c) => c.name).join("、")}を${card.name}のソウルに入れました。`);
  }
}

function putFieldCardToGauge(player, zone) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  player.drop.push(...(card.soul || []));
  card.soul = [];
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, state.players.indexOf(player));
  player.gauge.push(card);
  addLog(`${card.name}をコストでゲージに置きました。`);
  return card;
}


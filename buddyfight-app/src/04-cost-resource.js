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
      // 「（相手が）カードを引いた時」誘発（1枚ごと。H-BT04/0008）。
      // createPlayer の初期手札ドロー時は state.players 未構築のため発火しない（indexOf が -1）。
      const drawerIndex = Array.isArray(state?.players) ? state.players.indexOf(player) : -1;
      if (drawerIndex >= 0) {
        queueDrewTriggers(drawerIndex);
      }
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
  // 継続 damageReceivedReduction（装備者が受けるダメージを amount 減らす。
  // nonAttackOnly:true は攻撃以外のダメージ限定(マグナグレイス0011)、既定は全ダメージ(0056)）。
  if (!options.ignorePrevention) {
    const cap = damageReceivedReductionFor(owner, Boolean(options.byAttack), remaining);
    if (cap) {
      const reduced = Math.max(0, remaining - cap.amount);
      if (reduced !== remaining) {
        addLog(`${cap.source || "効果"}により${player.name}が受けるダメージを${remaining - reduced}減らしました。`);
      }
      remaining = reduced;
    }
  }
  // 継続 preventOpponentEffectDamage: 「君は相手のカードの効果でダメージを受けない」恒常（H-BT04/0109）。
  // 攻撃ダメージ(byAttack)と自分発のダメージ（コストの damageSelf 等 sourceOwner===owner）には効かない。
  if (
    !options.ignorePrevention &&
    !options.byAttack &&
    Number.isInteger(options.sourceOwner) &&
    options.sourceOwner !== owner
  ) {
    const guardCard = zones
      .map((zone) => player.field[zone])
      .find((fieldCard) => fieldCard && activeContinuousEffects(fieldCard).some((e) => e.op === "preventOpponentEffectDamage"));
    if (guardCard) {
      addLog(`${guardCard.name}の効果で${player.name}は相手の効果によるダメージを受けません。`);
      return 0;
    }
  }
  if (remaining <= 0) {
    return 0;
  }
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
    if (prevention.onlyAttack && !options.byAttack) {
      // 「攻撃によって受けるダメージ」限定の防止は、攻撃以外のダメージには適用しない（キューには残す）。
      i += 1;
      continue;
    }
    if (prevention.threshold && remaining < prevention.threshold) {
      // 「N以上のダメージを受ける時」限定の軽減は、N未満のダメージには適用しない（キューには残す）。
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
    // once!==false: 一度きり（消費）。once:false の preventAll/残量ありは消費せずターン中持続。
    const exhausted = !prevention.preventAll && (prevention.amount || 0) <= 0;
    if (prevention.once !== false || exhausted) {
      queue.splice(i, 1);
    } else {
      i += 1;
    }
  }
  // 非致死ダメージ: options.floorLife 指定時、このダメージで受け手のライフが floorLife 未満になるなら floorLife で止める。
  // （ミネウチでござる 0109「このダメージで相手のライフが0になるなら、かわりに相手のライフは1になる」）。
  if (options.floorLife !== undefined && remaining > 0) {
    const maxLoss = Math.max(0, player.life - options.floorLife);
    if (remaining > maxLoss) {
      remaining = maxLoss;
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
    // 効果/必殺技ダメージの後にも「ダメージを受けた時」対抗窓(counterEventWindow)を開く。
    // 戦闘ダメージは runDamageDealtTriggers 側でより詳細に設定するためここでは開かない(byAttack)。
    // 発生源 owner が判っている効果ダメージのみ対象（コスト/ライフリンク等の発生源不明ダメージでは開かない＝安全）。
    // これにより黒竜の盾(解決前予防)や五角竜王ドラム等の被弾時対抗が、戦闘に限らず正しいタイミングで機能する。
    if (!options.byAttack && options.sourceOwner !== undefined) {
      openDamageReceivedCounterWindow(owner, remaining, options);
    }
    checkWinner();
    // 「君がダメージを受けた時」誘発（五角竜王ドラム等）。同期経路のため microtask で遅延発火。
    queueDamageReceivedTriggers(owner, remaining, options);
  }
  return remaining;
}

// 効果/必殺技ダメージ後の「ダメージを受けた時」対抗窓。発生源(カード/owner)を凍結して counterEventWindow へ。
// lastDamageSourceMatches(相手カード由来判定) / selfReceivedDamage(被弾者判定) がこの窓で真になる。
function openDamageReceivedCounterWindow(defender, damage, options = {}) {
  if (damage <= 0) {
    return;
  }
  const src = { card: options.sourceCard || null, owner: options.sourceOwner, zone: null, source: "field" };
  const event = {
    kind: "damageDealt",
    source: src,
    sources: [src],
    sourceCard: options.sourceCard ? compactCardForLog(options.sourceCard) : null,
    sourceOwner: options.sourceOwner,
    defender,
    damage,
    turnCount: state.turnCount,
    phase: state.phase,
  };
  // 被弾側の対抗窓(lastDamageSourceMatches/selfReceivedDamage)だけを開く。
  // 攻撃側視点の単発参照 state.lastDamageEvent や turnDamageEvents は戦闘専用のまま触らない
  // （戦闘ダメージ→効果ダメージが連続した時に、直前戦闘の「与ダメージ」参照カードを潰さないため）。
  state.counterEventWindow = event;
}

// 継続 damageReceivedReduction を持つ場札から、owner が受けるダメージの軽減設定（最も減らせる1件）を返す。
// nonAttackOnly:true は byAttack===false の時のみ適用（攻撃以外限定。マグナグレイス0011）。既定は全ダメージ(0056)。
function damageReceivedReductionFor(owner, byAttack, incomingDamage = Infinity) {
  let best = null;
  zones.forEach((zone) => {
    const source = state.players[owner]?.field?.[zone];
    activeContinuousEffects(source).forEach((effect) => {
      if (effect.op !== "damageReceivedReduction" || effect.controller === "opponent") {
        return;
      }
      if (effect.nonAttackOnly && byAttack) {
        return; // 攻撃以外限定の軽減は攻撃ダメージには効かない
      }
      if (effect.threshold && incomingDamage < effect.threshold) {
        return; // 「N以上のダメージを受ける場合」限定の軽減はN未満には効かない（0056）
      }
      const amount = effect.amount || 0;
      if (amount > 0 && (!best || amount > best.amount)) {
        best = { amount, source: source.name };
      }
    });
  });
  return best;
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
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
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
  if ((reduction.purpose || "cast") !== purpose || !matchesCardFilter(card, reduction.filter || {})) {
    return false;
  }
  // フェイズ/状況限定のコスト軽減（0070: アタックフェイズ中のみ魔法ゲージ-2）。
  if (reduction.conditions && !checkCardConditions(reduction.conditions, state.active, {})) {
    return false;
  }
  return true;
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
  let gaugeNeeded = 0;
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge") {
      // 複数の payGauge ステップは同じゲージを二重に当てにできない。累計で判定する
      // （例: [payGauge3, payGauge4] はゲージ7が必要。各3/4を別々に見て通してはいけない）。
      gaugeNeeded += amount;
      if (!canSpendGaugePool(player, gaugeNeeded, { includeOpponent: includeOpponentGauge })) {
        return { ok: false, reason: "ゲージが足りません。" };
      }
    }
    if (step.op === "setLife") {
      // 「君のライフをNにする」コスト。減少になる時のみ支払い可（増加はコストにならない）。
      const target = step.life ?? step.amount ?? player.life;
      if (player.life <= target) {
        return { ok: false, reason: "ライフが足りません。" };
      }
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
    if (step.op === "discardSoulToDeckBottom" && (context.sourceCard?.soul?.length || 0) < amount) {
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
    if (step.op === "dropOwnFieldCard") {
      const candidates = ownFieldCostCandidates(player, step.filter);
      if (candidates.length < amount) {
        return { ok: false, reason: "コストでドロップに置く自分の場のカードが足りません。" };
      }
    }
    if (step.op === "dropOwnFieldOrSoulCard") {
      // 「君の場の◯◯1枚か、君の場のカードのソウルにある◯◯1枚をドロップに置く」（H-SS01 テラフォーミング等）。
      const candidates = ownFieldOrSoulCostCandidates(player, step.filter);
      if (candidates.length < amount) {
        return { ok: false, reason: "コストでドロップに置くカード（場かソウル）が足りません。" };
      }
    }
    if (step.op === "putSelectedOwnFieldCardsToSoul") {
      const candidates = ownFieldCostCandidates(player, step.filter).filter(
        (candidate) => candidate.card.instanceId !== context.sourceCard?.instanceId,
      );
      if (candidates.length < (step.min ?? 1)) {
        return { ok: false, reason: "コストでソウルに入れる自分の場のカードが足りません。" };
      }
    }
    if (step.op === "lookTopSelectToSoulRestToDrop" && player.deck.length < 1) {
      return { ok: false, reason: "見るデッキのカードがありません。" };
    }
    if (step.op === "destroyOwnMonster") {
      const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
      const candidates = ownFieldCostCandidates(player, { cardType: "monster", ...(step.filter || {}) }).filter(
        (candidate) => candidate.card.instanceId !== excludeId,
      );
      if (candidates.length < amount) {
        return { ok: false, reason: "コストで破壊する自分のモンスターがいません。" };
      }
    }
    if (step.op === "destroySource" && !findFieldCardSlot(context.sourceCard)) {
      return { ok: false, reason: "コストで破壊するこのカードが場にありません。" };
    }
    if (step.op === "returnOwnFieldCardToHand") {
      const candidates = returnFieldCostCandidates(player, step);
      const minimum = step.min ?? amount;
      if (candidates.length < minimum) {
        return { ok: false, reason: "コストで手札に戻す自分の場のカードが足りません。" };
      }
    }
  }
  return { ok: true };
}

// returnOwnFieldCardToHand 用の候補（zones 指定があればそのゾーンのみ、既定は全場）。
function returnFieldCostCandidates(player, step = {}) {
  const owner = state.players.indexOf(player);
  const allowedZones = step.zones && step.zones.length ? step.zones : zones;
  return allowedZones
    .map((zone) => ({ owner, zone, card: player.field[zone], source: "field" }))
    .filter(({ card, zone }) => card && matchesTargetFilter(card, owner, zone, step.filter || {}));
}

// 場のカードを手札へ戻す（ソウルはドロップ・currentTypeを基底へ）。コスト用。
function returnFieldCardToHandCost(player, zone) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  player.drop.push(...(card.soul || []));
  card.soul = [];
  player.field[zone] = null;
  resetLeftFieldCardState(card);
  player.hand.push(card);
  addLog(`${card.name}をコストで手札に戻しました。`);
  return card;
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

// 「場の filter 一致カード」＋「場のカードのソウルにある filter 一致カード」を横断したコスト候補
// （dropOwnFieldOrSoulCard 用。H-SS01 テラフォーミング等）。
function ownFieldOrSoulCostCandidates(player, filter = {}) {
  const owner = state.players.indexOf(player);
  const candidates = [];
  zones.forEach((zone) => {
    const fieldCard = player.field[zone];
    if (!fieldCard) {
      return;
    }
    if (matchesCardFilter(fieldCard, filter)) {
      candidates.push({ owner, zone, card: fieldCard, source: "field" });
    }
    (fieldCard.soul || []).forEach((soulCard) => {
      if (matchesCardFilter(soulCard, filter)) {
        candidates.push({ owner, zone, card: soulCard, source: "soul", hostCard: fieldCard, note: `${fieldCard.name}のソウル` });
      }
    });
  });
  return candidates;
}

function payDropOwnFieldOrSoulTarget(player, target) {
  if (target.source === "soul" && target.hostCard) {
    const index = (target.hostCard.soul || []).findIndex((card) => card.instanceId === target.card.instanceId);
    if (index >= 0) {
      player.drop.push(target.hostCard.soul.splice(index, 1)[0]);
      addLog(`${target.card.name}をコストでドロップゾーンに置きました。`);
    }
    return;
  }
  const dropped = dropFieldCardByRule(player, target.zone);
  if (dropped) {
    addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
  }
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
    if (step.op === "discardAllHand") {
      // 使用中のカードを除く手札を全て捨てるコスト（オールド・ラング・サイン 0029）。手札0でも支払い可。
      const removed = removeInUseHandExcept(player, selectedCard);
      discardHandCardsToDrop(player, removed);
      if (removed.length > 0) {
        addLog(`${player.name}はコストで手札を全て捨てました。`);
      }
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
    if (step.op === "damageSelf") {
      applyDamageToPlayer(state.players.indexOf(player), amount, { sourceName: sourceCard?.name, byAttack: false });
    }
    if (step.op === "setLife") {
      player.life = step.life ?? step.amount ?? player.life;
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
      maybeDropSetWhenSoulEmpty(sourceCard, state.players.indexOf(player)); // 設置のソウル切れ自壊（H-BT04/0025）
    }
    if (step.op === "discardSoulToDeckBottom") {
      for (let index = 0; index < amount; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.deck.unshift(soulCard);
        }
      }
    }
    if (step.op === "dropSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        dropFieldCardByRule(player, slot.zone);
      }
    }
    if (step.op === "destroySource") {
      // 同期経路: 破壊誘発/ソウルガードは反映されない近似（destroyOwnMonster 同期経路と同ポリシー）。
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        const dropped = dropFieldCardByRule(player, slot.zone);
        if (dropped) addLog(`${dropped.name}をコストで破壊しました。`);
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
    if (step.op === "dropOwnFieldCard") {
      ownFieldCostCandidates(player, step.filter)
        .slice(0, amount)
        .forEach((target) => {
          const dropped = dropFieldCardByRule(player, target.zone);
          if (dropped) {
            addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
          }
        });
    }
    if (step.op === "dropOwnFieldOrSoulCard") {
      // 非対話経路では先頭 amount 枚を自動選択（場札→ルールドロップ／ソウル札→ホストのソウルから除去）。
      ownFieldOrSoulCostCandidates(player, step.filter)
        .slice(0, amount)
        .forEach((target) => payDropOwnFieldOrSoulTarget(player, target));
    }
    if (step.op === "putSelectedOwnFieldCardsToSoul") {
      // 非対話経路では最小枚数だけ自動選択してソウルへ。
      const selected = ownFieldCostCandidates(player, step.filter)
        .filter((candidate) => candidate.card.instanceId !== sourceCard?.instanceId)
        .slice(0, step.min ?? 1);
      moveSelectedFieldCardsToSoul(player, sourceCard, selected);
    }
    if (step.op === "lookTopSelectToSoulRestToDrop") {
      // 非対話経路では見た先頭 amount 枚をソウルにする。
      lookTopSelectToSoulRestToDrop(player, sourceCard, step.count || 1, step.amount || 1);
    }
    if (step.op === "destroyOwnMonster") {
      // 非対話経路: 先頭の候補を破壊。ソウルガード/破壊時誘発は同期のため反映されない近似。
      const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
      const target = ownFieldCostCandidates(player, { cardType: "monster", ...(step.filter || {}) }).find(
        (candidate) => candidate.card.instanceId !== excludeId,
      );
      if (target) {
        const dropped = dropFieldCardByRule(player, target.zone);
        if (dropped) addLog(`${dropped.name}をコストで破壊しました。`);
      }
    }
    if (step.op === "returnOwnFieldCardToHand") {
      returnFieldCostCandidates(player, step)
        .slice(0, step.min ?? amount)
        .forEach((target) => returnFieldCardToHandCost(player, target.zone));
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
  const dropOwnFieldSelections = [];
  const dropOwnFieldOrSoulSelections = [];
  const putSelectedFieldSoulSelections = [];
  const lookTopSoulSelections = [];
  const destroyOwnMonsterSelections = [];
  const returnFieldToHandSelections = [];
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
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
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
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
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
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
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
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストでゲージに置く自分の場のカードを選んでください。" };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    fieldToGaugeSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "dropOwnFieldCard") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = ownFieldCostCandidates(player, step.filter).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でドロップに置くカード`,
      lead: `自分の場からドロップゾーンに置くカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストでドロップに置く自分の場のカードを選んでください。" };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    dropOwnFieldSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "dropOwnFieldOrSoulCard") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = ownFieldOrSoulCostCandidates(player, step.filter).filter(
      (candidate) => candidate.source !== "field" || !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でドロップに置くカード`,
      lead: `自分の場か、場のカードのソウルからドロップゾーンに置くカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストでドロップに置くカードを選んでください。" };
    }
    selected.forEach((candidate) => {
      if (candidate.source === "field") {
        reservedCostZones.add(`${candidate.owner}:${candidate.zone}`);
      }
    });
    dropOwnFieldOrSoulSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putSelectedOwnFieldCardsToSoul") {
      continue;
    }
    const candidates = ownFieldCostCandidates(player, step.filter).filter(
      (candidate) =>
        candidate.card.instanceId !== context.sourceCard?.instanceId &&
        !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const minimum = step.min ?? 1;
    const maximum = Math.min(step.max ?? candidates.length, candidates.length);
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でソウルに入れる場のカード`,
      lead: `自分の場からソウルに入れるカードを${minimum}枚以上選んでください。`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: "コストでソウルに入れる自分の場のカードを選んでください。" };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    putSelectedFieldSoulSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "lookTopSelectToSoulRestToDrop") {
      continue;
    }
    const count = step.count || 1;
    const amount = step.amount || 1;
    const revealed = [];
    for (let index = 0; index < count && player.deck.length > 0; index += 1) {
      revealed.push(player.deck.pop());
    }
    const pickCount = Math.min(amount, revealed.length);
    const selected = await chooseCardEntries(
      revealed.map((card) => ({ card })),
      {
        title: `${context.sourceCard?.name || "コスト"}: デッキ上${revealed.length}枚を見る`,
        lead: `ソウルに入れる${pickCount}枚を選んでください（残りはドロップゾーンに置かれます）。`,
        min: pickCount,
        max: pickCount,
        forceDialog: true,
        promptSeat: state.players.indexOf(player),
        purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      },
    );
    const soulSelected = selected && selected.length ? selected.map((entry) => entry.card) : revealed.slice(0, pickCount);
    lookTopSoulSelections.push({ revealed, soulSelected });
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "destroyOwnMonster") {
      continue;
    }
    const amount = step.amount || 1;
    const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
    const candidates = ownFieldCostCandidates(player, { cardType: "monster", ...(step.filter || {}) }).filter(
      (candidate) =>
        candidate.card.instanceId !== excludeId &&
        !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}で破壊する自分のモンスター`,
      lead: `コストで破壊する自分の場のモンスターを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストで破壊する自分のモンスターを選んでください。" };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    destroyOwnMonsterSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "returnOwnFieldCardToHand") {
      continue;
    }
    const amount = step.amount || 1;
    const minimum = step.min ?? amount;
    const candidates = returnFieldCostCandidates(player, step).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const maximum = Math.min(step.max ?? amount, candidates.length);
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}で手札に戻すカード`,
      lead: `自分の場から手札に戻すカードを${minimum}〜${maximum}枚選んでください。`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      allowCancel: minimum === 0,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
    });
    if (!selected || selected.length < minimum) {
      if (minimum > 0) {
        return { ok: false, reason: "コストで手札に戻す自分の場のカードを選んでください。" };
      }
    }
    (selected || []).forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    returnFieldToHandSelections.push(selected || []);
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
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
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
  let dropOwnFieldStepIndex = 0;
  let dropOwnFieldOrSoulStepIndex = 0;
  let putSelectedFieldSoulStepIndex = 0;
  let lookTopSoulStepIndex = 0;
  let destroyOwnMonsterStepIndex = 0;
  let returnFieldToHandStepIndex = 0;
  const discarded = [];
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge") {
      spendGaugePool(player, amount, { includeOpponent: includeOpponentGauge });
    }
    if (step.op === "discardAllHand") {
      const removed = removeInUseHandExcept(player, selectedCard);
      discardHandCardsToDrop(player, removed);
      if (removed.length > 0) {
        addLog(`${player.name}はコストで手札を全て捨てました。`);
      }
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
    if (step.op === "damageSelf") {
      applyDamageToPlayer(state.players.indexOf(player), amount, { sourceName: sourceCard?.name, byAttack: false });
    }
    if (step.op === "setLife") {
      player.life = step.life ?? step.amount ?? player.life;
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
      maybeDropSetWhenSoulEmpty(sourceCard, state.players.indexOf(player)); // 設置のソウル切れ自壊（H-BT04/0025）
    }
    if (step.op === "discardSoulToDeckBottom") {
      for (let index = 0; index < amount; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.deck.unshift(soulCard);
        }
      }
    }
    if (step.op === "dropSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        dropFieldCardByRule(player, slot.zone);
      }
    }
    if (step.op === "destroySource") {
      // このカード自身をコストで「破壊」する（破壊時誘発・ソウルガード・ライフリンクが正しく発生）。
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        const dropped = await destroyFieldCard(slot.owner, slot.zone, { cause: { byEffect: true }, ignoreDestroyReplacement: true });
        if (dropped) addLog(`${dropped.name}をコストで破壊しました。`);
      }
    }
    if (step.op === "putSelectedOwnFieldCardsToSoul") {
      moveSelectedFieldCardsToSoul(player, sourceCard, putSelectedFieldSoulSelections[putSelectedFieldSoulStepIndex] || []);
      putSelectedFieldSoulStepIndex += 1;
    }
    if (step.op === "destroyOwnMonster") {
      const targets = destroyOwnMonsterSelections[destroyOwnMonsterStepIndex] || [];
      destroyOwnMonsterStepIndex += 1;
      for (const target of targets) {
        const dropped = await destroyFieldCard(target.owner, target.zone, { cause: { byEffect: true }, ignoreDestroyReplacement: true });
        if (dropped) addLog(`${dropped.name}をコストで破壊しました。`);
      }
    }
    if (step.op === "returnOwnFieldCardToHand") {
      const targets = returnFieldToHandSelections[returnFieldToHandStepIndex] || [];
      returnFieldToHandStepIndex += 1;
      targets.forEach((target) => returnFieldCardToHandCost(player, target.zone));
    }
    if (step.op === "lookTopSelectToSoulRestToDrop") {
      const pick = lookTopSoulSelections[lookTopSoulStepIndex] || { revealed: [], soulSelected: [] };
      lookTopSoulStepIndex += 1;
      lookTopSelectToSoulRestToDrop(player, sourceCard, step.count || 1, step.amount || 1, pick.revealed, pick.soulSelected);
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
    if (step.op === "dropOwnFieldCard") {
      const selectedTargets = dropOwnFieldSelections[dropOwnFieldStepIndex] || [];
      dropOwnFieldStepIndex += 1;
      selectedTargets.forEach((target) => {
        const dropped = dropFieldCardByRule(player, target.zone);
        if (dropped) {
          addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
        }
      });
    }
    if (step.op === "dropOwnFieldOrSoulCard") {
      const selectedTargets = dropOwnFieldOrSoulSelections[dropOwnFieldOrSoulStepIndex] || [];
      dropOwnFieldOrSoulStepIndex += 1;
      selectedTargets.forEach((target) => payDropOwnFieldOrSoulTarget(player, target));
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
  const placed = [];
  for (let index = 0; index < amount; index += 1) {
    const gaugeCard = player.deck.pop();
    if (gaugeCard) {
      player.gauge.push(gaugeCard);
      placed.push(gaugeCard);
    }
  }
  queueGaugePlacedTriggers(state.players.indexOf(player), placed); // 相手のゲージにカードが置かれた時（0020）
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
}

function moveDropToSoul(player, card, amount = 1, filter = {}) {
  card.soul ||= [];
  const movedCards = takeMatchingCards(player.drop, filter, amount);
  if (movedCards.length > 0) {
    card.soul.push(...movedCards);
    movedCards.forEach((soulCard) => queueEnteredSoulTriggers(soulCard, state.players.indexOf(player), "drop", card));
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
    moved.forEach((soulCard) => queueEnteredSoulTriggers(soulCard, state.players.indexOf(player), "field", card));
    addLog(`${moved.map((c) => c.name).join("、")}を${card.name}のソウルに入れました。`);
  }
}

// 選択された自分の場のカード（entries: {zone} を含む）を発生源のソウルへ入れる（putSelectedOwnFieldCardsToSoul用）。
function moveSelectedFieldCardsToSoul(player, sourceCard, entries = []) {
  sourceCard.soul ||= [];
  const moved = [];
  entries.forEach(({ zone }) => {
    const fieldCard = player.field[zone];
    if (fieldCard && fieldCard.instanceId !== sourceCard.instanceId) {
      player.field[zone] = null;
      moved.push(fieldCard);
    }
  });
  if (moved.length > 0) {
    sourceCard.soul.push(...moved);
    addLog(`${moved.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`);
  }
  return moved;
}

// デッキ上から count 枚を見て、soulCards をソウルへ、残りをドロップへ（lookTopSelectToSoulRestToDrop用）。
// revealed 未指定時はここでデッキ上から count 枚めくる。soulCards 未指定時は先頭 amount 枚をソウルにする。
function lookTopSelectToSoulRestToDrop(player, sourceCard, count = 1, amount = 1, revealed = null, soulCards = null) {
  const cards = revealed || [];
  if (!revealed) {
    for (let index = 0; index < count && player.deck.length > 0; index += 1) {
      cards.push(player.deck.pop());
    }
  }
  sourceCard.soul ||= [];
  const soulPick = soulCards || cards.slice(0, amount);
  const soulSet = new Set(soulPick.map((card) => card.instanceId));
  const toSoul = cards.filter((card) => soulSet.has(card.instanceId));
  const toDrop = cards.filter((card) => !soulSet.has(card.instanceId));
  sourceCard.soul.push(...toSoul);
  player.drop.push(...toDrop);
  if (toSoul.length > 0) {
    addLog(`${toSoul.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`);
  }
  if (toDrop.length > 0) {
    addLog(`残りの${toDrop.map((card) => card.name).join("、")}をドロップゾーンに置きました。`);
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
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


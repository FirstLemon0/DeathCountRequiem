// ==========================================================================
// buddyfight モジュール 05 — サイズ・ステータス・常時効果(継続バフ)
// 旧 app.js L1759-1957 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function getFieldSize(player) {
  return fieldZones.reduce((total, zone) => total + (player.field[zone]?.size || 0), 0);
}

// このカードの能力(abilities/continuous/soulContinuous/keywords)が、場のいずれかの
// nullifyAbilities 継続(凍てつく星辰)によって無効化されているか。nullifyImmune のカードは対象外。
// card は場札 or ソウル内カード(ソウルの場合はホストの所有者・"soul"位置で判定)。
function isAbilitiesNullified(card) {
  if (!card || card.nullifyImmune || !state?.players?.length) return false;
  let cardOwner;
  let location = "field";
  const slot = findFieldCardSlot(card);
  if (slot) {
    cardOwner = slot.owner;
  } else {
    // ソウル内カード: そのソウルを持つホスト(場札)を探す
    let host = null;
    for (let p = 0; p < state.players.length && !host; p += 1) {
      for (const zone of zones) {
        const fc = state.players[p].field[zone];
        if (fc?.soul?.some((s) => s.instanceId === card.instanceId)) {
          host = { owner: p };
          break;
        }
      }
    }
    if (!host) return false;
    cardOwner = host.owner;
    location = "soul";
  }
  const fieldNullified = state.players.some((player, nullifierOwner) =>
    zones.some((zone) => {
      const src = player.field[zone];
      return (src?.continuous || []).some((e) => {
        if (e.op !== "nullifyAbilities") return false;
        const ownerOk =
          e.controller === "opponent" ? cardOwner !== nullifierOwner
          : e.controller === "self" ? cardOwner === nullifierOwner
          : true;
        if (!ownerOk) return false;
        if (e.zones && !e.zones.includes(location)) return false;
        if (e.filter && Object.keys(e.filter).length && !matchesCardFilter(card, e.filter)) return false;
        if (e.conditions && !checkCardConditions(e.conditions, nullifierOwner, { card: src, zone })) return false;
        return true;
      });
    }),
  );
  return fieldNullified || isNullifiedByBattlingHostSoul(card);
}

// soulContinuous nullifyBattlingMonsterAbilities（星合体 竜装機アーティライガー 0072）:
// card が、ソウルに当該効果を持つモンスター(ホスト=ネオドラゴン)とバトルしており、
// card の元々の(印字)サイズが originalSizeLte 以下なら、card の能力を全て無効化する。
// 効果元の竜装機は nullifyImmune のためここで isAbilitiesNullified を再帰呼び出しせず判定する。
function isNullifiedByBattlingHostSoul(card) {
  const pending = state.pendingAttack;
  if (!pending || !card) {
    return false;
  }
  const attackerSlots = getPendingAttackerSlots(pending);
  const attackerCards = attackerSlots
    .map((slot) => state.players[slot.owner]?.field?.[slot.zone])
    .filter(Boolean);
  const targetCard =
    pending.targetType === "monster" ? state.players[pending.targetOwner]?.field?.[pending.targetZone] : null;
  const isAttacker = attackerCards.some((c) => c.instanceId === card.instanceId);
  const isTarget = Boolean(targetCard && targetCard.instanceId === card.instanceId);
  const hosts = [];
  if (isAttacker && targetCard) {
    hosts.push(targetCard);
  }
  if (isTarget) {
    hosts.push(...attackerCards);
  }
  return hosts.some((host) =>
    (host.soul || []).some((soulCard) =>
      (soulCard.soulContinuous || []).some(
        (effect) =>
          effect.op === "nullifyBattlingMonsterAbilities" &&
          (card.size || 0) <= (effect.originalSizeLte ?? Infinity),
      ),
    ),
  );
}

// 付与元カードの継続効果配列を返す。能力無効化(凍てつく星辰)されたカードは空配列。
// 各所で `(card.continuous || [])` を直接走査している箇所をこれに置き換えると、
// 無効化されたカードの継続効果(grantKeyword/preventCenterCall/attackRedirect 等)が一律オフになる。
// ※ isAbilitiesNullified 自身は nullifyAbilities 継続を生で走査するため、これを使ってはならない(無限再帰回避)。
function activeContinuousEffects(sourceCard) {
  if (!sourceCard || isAbilitiesNullified(sourceCard)) {
    return [];
  }
  return sourceCard.continuous || [];
}

function fieldSizeLimit(player) {
  const base = player?.flag?.maxFieldSize ?? 3;
  // 場のカードの継続 grantFieldSizeLimit(controller:self 既定)による上限加算（ドラゴンスローン「サイズの合計が4になるまで」等）。
  let bonus = 0;
  zones.forEach((zone) => {
    activeContinuousEffects(player?.field?.[zone]).forEach((effect) => {
      if (effect.op === "grantFieldSizeLimit" && (effect.controller === undefined || effect.controller === "self")) {
        bonus += effect.amount || 1;
      }
    });
  });
  return base + bonus;
}

function canAddSize(player, card) {
  return getFieldSize(player) + (card.size || 0) <= fieldSizeLimit(player);
}

function visiblePower(card) {
  return Math.max(0,
    (card?.power || 0) +
    (card?.battlePowerBonus || 0) +
    (card?.turnPowerBonus || 0) +
    continuousPowerBonus(card)
  );
}

function visibleDefense(card) {
  return Math.max(0,
    (card?.defense || 0) +
    (card?.battleDefenseBonus || 0) +
    (card?.turnDefenseBonus || 0) +
    continuousDefenseBonus(card)
  );
}

function visibleCritical(card) {
  return Math.max(0,
    (card?.critical || 0) +
    (card?.battleCriticalBonus || 0) +
    (card?.turnCriticalBonus || 0) +
    continuousCriticalBonus(card)
  );
}

// 継続効果のドロップ枚数参照分（旧 modifyStatsByDropAttributeCount と
// 新 modifyStats{amountFrom:{source:"dropAttributeCount"}} を統一）。statKey の単価×枚数。
function continuousDropStatAmount(effect, statKey, player) {
  let filter;
  let max;
  let per;
  if (effect.op === "modifyStatsByDropAttributeCount") {
    filter = effect.dropFilter || { attribute: effect.attribute };
    max = effect.max;
    per = effect[{ power: "powerPerCard", defense: "defensePerCard", critical: "criticalPerCard" }[statKey]] ?? effect[statKey] ?? 0;
  } else if (effect.op === "modifyStats" && effect.amountFrom?.source === "dropAttributeCount") {
    const af = effect.amountFrom;
    filter = af.filter || { attribute: af.attribute };
    max = af.max;
    per = af.per?.[statKey] ?? 0;
  } else {
    return 0;
  }
  if (!per) {
    return 0;
  }
  const count = player.drop.filter((dropCard) => matchesCardFilter(dropCard, filter)).length;
  const capped = max !== undefined ? Math.min(count, max) : count;
  return capped * per;
}

// 継続 modifyStats の amountFrom:{source:"soulCount"|"soulStatSum"} 分を算出（sourceCard 自身のソウル参照）。
// - soulCount: filter一致のソウル枚数 × per[statKey]（max で上限）。例: アーマナイト・アークエンジェル「ソウル1枚につき攻撃力+3000」。
// - soulStatSum: filter一致のソウルの stat 合計を applyTo の各statに加算。例: デンジャラス・クレイドル「打撃力はソウルの《武器》の打撃力合計分」。
function continuousSoulStatAmount(effect, statKey, sourceCard) {
  if (effect.op !== "modifyStats" || !effect.amountFrom) {
    return 0;
  }
  const af = effect.amountFrom;
  const soul = sourceCard?.soul || [];
  const matched = af.filter ? soul.filter((s) => matchesCardFilter(s, af.filter)) : soul;
  if (af.source === "soulCount") {
    const per = af.per?.[statKey] ?? 0;
    if (!per) {
      return 0;
    }
    const count = af.max !== undefined ? Math.min(matched.length, af.max) : matched.length;
    return count * per;
  }
  if (af.source === "soulStatSum") {
    const applyTo = af.applyTo || (af.stat ? [af.stat] : []);
    if (!applyTo.includes(statKey)) {
      return 0;
    }
    const statName = af.stat || statKey;
    return matched.reduce((sum, s) => sum + (s[statName] || 0), 0);
  }
  return 0;
}

// 場・ソウルの継続 modifyStats（定数 by と amountFrom:dropAttributeCount/soulCount/soulStatSum）から statKey の合計補正値を算出。
function continuousStatBonus(card, statKey) {
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return 0;
  }
  const player = state.players[slot.owner];
  let bonus = 0;
  zones.forEach((zone) => {
    const sourceCard = player.field[zone];
    (sourceCard?.continuous || []).forEach((effect) => {
      if (!continuousEffectApplies(effect, card, sourceCard)) {
        return;
      }
      if (effect.op === "modifyStats") {
        bonus += effect[statKey] || 0;
      }
      bonus += continuousDropStatAmount(effect, statKey, player);
      bonus += continuousSoulStatAmount(effect, statKey, sourceCard);
    });
  });
  // 相手側からの越境継続（opposingFront / controller:"opponent" の明示デバフ）も評価する。
  // 自陣バフ（controller 無指定の通常継続）は越境適用しないようゲートする。
  const crossOwner = 1 - slot.owner;
  const crossField = state.players[crossOwner]?.field || {};
  zones.forEach((zone) => {
    const sourceCard = crossField[zone];
    (sourceCard?.continuous || []).forEach((effect) => {
      if (!(effect.opposingFront || effect.controller === "opponent")) {
        return;
      }
      if (!continuousEffectApplies(effect, card, sourceCard)) {
        return;
      }
      if (effect.op === "modifyStats") {
        bonus += effect[statKey] || 0;
      }
      bonus += continuousDropStatAmount(effect, statKey, state.players[crossOwner]);
      bonus += continuousSoulStatAmount(effect, statKey, sourceCard);
    });
  });
  soulContinuousEffects(card, slot.owner).forEach(({ effect, sourceCard }) => {
    if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, slot.owner)) {
      return;
    }
    if (effect.op === "modifyStats") {
      bonus += effect[statKey] || 0;
    }
  });
  return bonus;
}

function continuousPowerBonus(card) {
  return continuousStatBonus(card, "power");
}

function continuousDefenseBonus(card) {
  return continuousStatBonus(card, "defense");
}

function continuousCriticalBonus(card) {
  return continuousStatBonus(card, "critical");
}

function soulContinuousEffects(card, owner) {
  if (!card?.soul?.length) {
    return [];
  }
  return card.soul.flatMap((sourceCard) =>
    (sourceCard.soulContinuous || []).map((effect) => ({ sourceCard, effect, owner })),
  );
}

function continuousEffectAppliesFromSoul(effect, targetCard, sourceCard, owner) {
  if (isAbilitiesNullified(sourceCard)) {
    return false; // 能力無効化されたソウル内カードの付与は適用しない
  }
  if (!matchesCardFilter(targetCard, effect.filter || {})) {
    return false;
  }
  if (effect.requireBuddy && targetCard.name !== state.players[owner]?.buddy?.name) {
    return false;
  }
  if (effect.sourceName && sourceCard?.name !== effect.sourceName) {
    return false;
  }
  return true;
}

function continuousEffectApplies(effect, targetCard, sourceCard) {
  if (isAbilitiesNullified(sourceCard)) {
    return false; // 能力無効化された付与元の継続効果は適用しない
  }
  if (effect.excludeSource && sourceCard?.instanceId === targetCard?.instanceId) {
    return false;
  }
  if (effect.filter?.sameInstanceAsSource && targetCard?.instanceId !== sourceCard?.instanceId) {
    return false;
  }
  if (effect.filter?.sameNameAsSource && targetCard?.name !== sourceCard?.name) {
    return false;
  }
  if (effect.filter?.sameIdAsSource && targetCard?.id !== sourceCard?.id) {
    return false;
  }
  const sourceSlot = findFieldCardSlot(sourceCard);
  const targetSlot = findFieldCardSlot(targetCard);
  if (effect.opposingFront) {
    // 「このカードの前の相手のモンスター」= 物理的に正面(ミラー列: 左↔右, 中央↔中央)・相手側の1枚にのみ適用。
    // 盤面は相手列が逆順描画のため、正面は同名zoneではなく oppositeFieldZone で対応付ける。
    if (
      !sourceSlot ||
      !targetSlot ||
      sourceSlot.owner === targetSlot.owner ||
      targetSlot.zone !== oppositeFieldZone(sourceSlot.zone)
    ) {
      return false;
    }
  }
  if (effect.controller && sourceSlot && targetSlot) {
    if (effect.controller === "self" && targetSlot.owner !== sourceSlot.owner) {
      return false;
    }
    if (effect.controller === "opponent" && targetSlot.owner === sourceSlot.owner) {
      return false;
    }
  }
  if (effect.conditions?.length) {
    if (!sourceSlot) {
      return false;
    }
    if (!checkCardConditions(effect.conditions, sourceSlot.owner, {
      card: sourceCard,
      zone: sourceSlot.zone,
      targetCard,
    })) {
      return false;
    }
  }
  // requireBuddy: 対象が、その対象の所有者が登録したバディ(同名)である場合のみ適用。
  // 「君の場のバディモンスターは〜を得る」等の継続付与で使う（soulContinuous 側と同仕様）。
  if (effect.requireBuddy) {
    if (!targetSlot || targetCard?.name !== state.players[targetSlot.owner]?.buddy?.name) {
      return false;
    }
  }
  return matchesCardFilter(targetCard, effect.filter || {});
}


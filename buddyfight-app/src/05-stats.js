// ==========================================================================
// buddyfight モジュール 05 — サイズ・ステータス・常時効果(継続バフ)
// 旧 app.js L1759-1957 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function getFieldSize(player) {
  return fieldZones.reduce((total, zone) => total + (player.field[zone]?.size || 0), 0);
}

function fieldSizeLimit(player) {
  return player?.flag?.maxFieldSize ?? 3;
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

// 場・ソウルの継続 modifyStats（定数 by と amountFrom:dropAttributeCount）から statKey の合計補正値を算出。
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
  return matchesCardFilter(targetCard, effect.filter || {});
}


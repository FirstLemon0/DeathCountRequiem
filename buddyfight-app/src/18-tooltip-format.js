// ==========================================================================
// buddyfight モジュール 18 — ツールチップ・ラベル整形・キーワード判定
// 旧 app.js L9886-10271 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function renderLog() {
  elements.logList.innerHTML = "";
  state.log.forEach((entry) => {
    const item = document.createElement("li");
    item.textContent = entry;
    elements.logList.append(item);
  });
}

function showCardTooltip(card, event) {
  const tooltipHost = elements.cardSheet?.open
    ? elements.cardSheet
    : elements.selectionDialog?.open
      ? elements.selectionDialog
      : document.body;
  if (tooltipHost?.append && elements.cardTooltip.parentElement !== tooltipHost) {
    tooltipHost.append(elements.cardTooltip);
  }
  elements.cardTooltip.innerHTML = cardTooltipHtml(card);
  elements.cardTooltip.setAttribute("aria-hidden", "false");
  elements.cardTooltip.classList.add("visible");
  moveCardTooltip(event);
}

function moveCardTooltip(event) {
  if (!elements.cardTooltip.classList.contains("visible")) {
    return;
  }
  const rect = elements.cardTooltip.getBoundingClientRect();
  const sourceRect = event.currentTarget?.getBoundingClientRect?.();
  const fallbackX = sourceRect ? sourceRect.right : 20;
  const fallbackY = sourceRect ? sourceRect.top : 20;
  const cursorX = typeof event.clientX === "number" ? event.clientX : fallbackX;
  const cursorY = typeof event.clientY === "number" ? event.clientY : fallbackY;
  const x = Math.min(window.innerWidth - rect.width - 14, cursorX + 16);
  const y = Math.min(window.innerHeight - rect.height - 14, cursorY + 16);
  elements.cardTooltip.style.left = `${Math.max(10, x)}px`;
  elements.cardTooltip.style.top = `${Math.max(10, y)}px`;
}

function hideCardTooltip() {
  elements.cardTooltip?.classList.remove("visible");
  elements.cardTooltip?.setAttribute("aria-hidden", "true");
  if (document.body?.append && elements.cardTooltip?.parentElement !== document.body) {
    document.body.append(elements.cardTooltip);
  }
}

function cardTooltipHtml(card) {
  const soulNames = stackedCardNames(card);
  const soulList = soulNames.length
    ? `<div class="tooltip-rules tooltip-soul">
        <strong>下に重なっているカード</strong>
        <ul>${soulNames.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul>
      </div>`
    : "";
  const rows = [
    ["カード番号", card.no],
    ["製品", card.productName],
    ["種類", typeLabel(card)],
    ["ワールド", card.world],
    ["属性", card.attributes?.join(" / ") || "-"],
    ["サイズ", statLabel(card.size)],
    ["攻撃力", statLabel(visiblePower(card))],
    ["打撃力", statLabel(visibleCritical(card))],
    ["防御力", statLabel(visibleDefense(card))],
    ["ソウル", String(card.soul?.length || 0)],
    ["レアリティ", card.rarity],
    ["コスト", costLabel(card)],
  ];
  return `
    <div class="tooltip-head">
      <strong>${escapeHtml(card.name)}</strong>
      <span>${escapeHtml(card.no || "")}</span>
    </div>
    <dl>
      ${rows
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "-")}</dd></div>`)
        .join("")}
    </dl>
    <div class="tooltip-rules">
      <strong>効果</strong>
      <ul>
        ${cardRules(card).map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}
      </ul>
    </div>
    ${soulList}
  `;
}

function effectImplementationLabel(card) {
  return cardRules(card).join(" ");
}

function cardRules(card) {
  return card.rules?.length ? card.rules : ["能力なし。"];
}

function effectiveCardType(card) {
  return card.currentType || card.type;
}

function typeLabel(card) {
  const current = effectiveCardType(card);
  if (card.baseType && card.baseType !== current) {
    return `${typeLabels[card.baseType]} / ${typeLabels[current]}扱い`;
  }
  return typeLabels[current];
}

function costLabel(card) {
  const structured = primaryStructuredCost(card);
  if (structured?.length) {
    return structured.map(costStepLabel).join(" / ");
  }
  const cost = primaryCost(card);
  if (!cost) {
    return "-";
  }
  const labels = [];
  if (cost.gauge) {
    labels.push(`ゲージ${cost.gauge}`);
  }
  if (cost.discard) {
    labels.push(`手札${cost.discard}`);
  }
  return labels.join(" / ") || "-";
}

function primaryStructuredCost(card) {
  return card.costs?.call || card.costs?.cast || card.costs?.equip || card.costs?.arrival || null;
}

function costStepLabel(step) {
  const amount = step.amount || 1;
  return {
    payGauge: `ゲージ${amount}`,
    discardHand: `手札${amount}`,
    payLife: `ライフ${amount}`,
    cancelRecentLifeLink: "ライフリンク無効化",
    cancelLifeLink: "ライフリンク無効化",
    cancelCallOpportunityLifeLink: "ライフリンク無効化",
    putTopDeckToSoul: `デッキ上${amount}枚をソウル`,
    putDropToSoul: `ドロップ${amount}枚をソウル`,
    putTopDeckToGauge: `デッキ上${amount}枚をゲージ`,
    discardSoul: `ソウル${amount}枚を捨てる`,
    dropOwnMonster: `自分のモンスター${amount}枚をドロップ`,
    putHandToSoul: `手札${amount}枚をソウル`,
    putOwnFieldCardsToGauge: `自分の場のカード${amount}枚をゲージ`,
  }[step.op] || step.op;
}

function primaryCost(card) {
  if (hasCost(card.callCost)) {
    return card.callCost;
  }
  if (hasCost(card.castCost)) {
    return card.castCost;
  }
  if (hasCost(card.equipCost)) {
    return card.equipCost;
  }
  return null;
}

function hasCost(cost = {}) {
  return Boolean(cost.gauge || cost.discard);
}

function statLabel(value) {
  return value || value === 0 ? String(value) : "-";
}

function targetLabel(pending) {
  if (pending.targetType === "fighter") {
    return `${state.players[pending.defender].name}本体`;
  }
  const card = state.players[pending.targetOwner].field[pending.targetZone];
  return card ? `${zoneLabel(pending.targetZone)}の${card.name}` : zoneLabel(pending.targetZone);
}

function handPlayerRole(owner) {
  if (state.pendingAction) {
    return owner === state.pendingAction.owner ? "行動側" : "対抗側";
  }
  if (!state.pendingAttack) {
    return "";
  }
  return owner === state.pendingAttack.attackerOwner ? "攻撃側" : "防御側";
}

function hasKeyword(card, keyword) {
  if (!card) {
    return false;
  }
  if (keyword === "lifeLink") {
    return lifeLinkAmount(card) > 0 || hasInstantLifeLink(card);
  }
  if (isKeywordPrevented(card, keyword)) {
    return false;
  }
  if (
    (card.turnSuppressedKeywords || []).some((candidate) =>
      keywordAliases(keyword).includes(candidate),
    )
  ) {
    return false;
  }
  if (keyword === "counterattack" && card.counterattack) {
    return true;
  }
  const aliases = keywordAliases(keyword);
  const slot = findFieldCardSlot(card);
  // 能力無効化(凍てつく星辰)中は、このカード自身のキーワード/能力由来のキーワードは無効。
  // 他カードからの付与(continuous/soulContinuous)は付与元の無効化判定(continuousEffectApplies側)に委ねる。
  const ownNullified = isAbilitiesNullified(card);
  return (
    (!ownNullified && (card.keywords || []).some((candidate) => aliases.includes(candidate))) ||
    (!ownNullified && (card.temporaryKeywords || []).some((candidate) => aliases.includes(candidate))) ||
    (!ownNullified && (card.turnKeywords || []).some((candidate) => aliases.includes(candidate))) ||
    (slot &&
      state.players.some((player) =>
        zones.some((zone) => {
          const sourceCard = player.field[zone];
          return (sourceCard?.continuous || []).some(
            (effect) =>
              effect.op === "grantKeyword" &&
              aliases.includes(effect.keyword) &&
              continuousEffectApplies(effect, card, sourceCard),
          );
        }),
      )) ||
    (slot &&
      soulContinuousEffects(card, slot.owner).some(
        ({ effect, sourceCard }) =>
          effect.op === "grantKeyword" &&
          aliases.includes(effect.keyword) &&
          continuousEffectAppliesFromSoul(effect, card, sourceCard, slot.owner),
      )) ||
    (!ownNullified &&
      (card.abilities || []).some(
        (ability) => hasAbilityKeyword(ability, keyword) && passiveAbilityConditionsMet(card, ability),
      ))
  );
}

// センターへのモンスターコールを禁止する継続効果（爆斧 リクドウ斬魔・決戦闘技 MAJI斬魔）
// controller:"self" は発生源の持ち主のみ対象、未指定は両者。sizeLte でサイズ上限を指定可。
function isCenterCallPrevented(callerOwner, card) {
  return state.players.some((player, pIdx) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return activeContinuousEffects(source).some((effect) => {
        if (effect.op !== "preventCenterCall") {
          return false;
        }
        if (effect.controller === "self" && pIdx !== callerOwner) {
          return false;
        }
        if (effect.sizeLte !== undefined && (card.size ?? 0) > effect.sizeLte) {
          return false;
        }
        return true;
      });
    }),
  );
}

function isKeywordPrevented(card, keyword) {
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return false;
  }
  const aliases = keywordAliases(keyword);
  return state.players.some((player) =>
    zones.some((zone) => {
      const sourceCard = player.field[zone];
      return (sourceCard?.continuous || []).some(
        (effect) =>
          effect.op === "preventKeyword" &&
          aliases.includes(effect.keyword) &&
          continuousEffectApplies(effect, card, sourceCard),
      );
    }),
  );
}

function passiveAbilityConditionsMet(card, ability) {
  if (!ability.conditions?.length) {
    return true;
  }
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return false;
  }
  return ability.conditions.every((condition) => {
    if (condition.op === "sourceZoneIn") {
      return condition.zones?.includes(slot.zone);
    }
    return checkCondition(condition, slot.owner, {
      card,
      owner: slot.owner,
      zone: slot.zone,
    });
  });
}

function findFieldCardSlot(card) {
  if (!state?.players || !card) {
    return null;
  }
  for (const [owner, player] of state.players.entries()) {
    for (const zone of zones) {
      if (player.field[zone]?.instanceId === card.instanceId) {
        return { owner, zone };
      }
    }
  }
  return null;
}

function hasAbilityKeyword(ability, keyword) {
  const aliases = keywordAliases(keyword);
  return aliases.includes(ability.keyword) || aliases.includes(ability.kind);
}

function findKeywordAbility(card, keyword) {
  return (card.abilities || []).find((ability) => hasAbilityKeyword(ability, keyword));
}

function keywordAliases(keyword) {
  return {
    arrival: ["arrival", "着任"],
    reversal: ["reversal", "逆天"],
    soulguard: ["soulguard", "ソウルガード"],
    canAttackWithCenter: ["canAttackWithCenter", "センター攻撃可"],
    canAttackFighterThroughCenter: ["canAttackFighterThroughCenter", "センター越し本体攻撃"],
    dropOpponentMonsterSoulOnAttack: ["dropOpponentMonsterSoulOnAttack", "攻撃時ソウル落とし"],
    cannotBeLinkAttacked: ["cannotBeLinkAttacked", "連携攻撃されない"],
    move: ["move", "移動"],
    penetrate: ["penetrate", "貫通"],
    doubleAttack: ["doubleAttack", "2回攻撃", "２回攻撃"],
    tripleAttack: ["tripleAttack", "3回攻撃", "３回攻撃"],
    lifeLink: ["lifeLink"],
  }[keyword] || [keyword];
}

// 1攻撃中に何度でも使える例外カウンター種別（同一 kind を連続使用する限り無制限）。
// 旧来は "dragoenergy" を id/effect 直書きで判定していたが、種別名の集合として一般化した。
const REPEATABLE_COUNTER_KINDS = new Set(["dragoenergy"]);

function isRepeatableCounterKind(kind) {
  return Boolean(kind) && REPEATABLE_COUNTER_KINDS.has(kind);
}

function canUseCounterEffect(owner, effect) {
  const pending = state.pendingAttack || state.pendingAction;
  if (!pending) {
    return false;
  }
  const usedKind = pending.counterUsed?.[owner];
  if (!usedKind) {
    return true;
  }
  // 直前と同一の repeatable 種別（=ドラゴエナジー等）かつ攻撃中のみ再使用を許可。
  return Boolean(state.pendingAttack && usedKind === effect && isRepeatableCounterKind(effect));
}

function markCounterUsed(owner, kind) {
  const pending = state.pendingAttack || state.pendingAction;
  if (!pending) {
    return;
  }
  pending.counterUsed = {
    ...(pending.counterUsed || {}),
    [owner]: kind,
  };
}

function zoneLabel(zone) {
  return {
    left: "レフト",
    center: "センター",
    right: "ライト",
    set1: "配置魔法1",
    set2: "配置魔法2",
    item: "アイテム",
  }[zone];
}


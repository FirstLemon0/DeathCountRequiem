// ==========================================================================
// buddyfight モジュール 05 — サイズ・ステータス・常時効果(継続バフ)
// 旧 app.js L1759-1957 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function getFieldSize(player) {
  return fieldZones.reduce((total, zone) => total + effectiveSize(player.field[zone]), 0);
}

// ── 実効サイズ/実効属性のパス内メモ化 ──────────────────────────────────
// effectiveSize / effectiveAttributes は「盤面を書き換えない同期評価」の間は純関数
// （＝同じカード・同じ盤面なら常に同じ値）。ところが cardCount ゲート継続
// （「君の場に《アイドル》が3種類以上あるなら〜」S-UB-C03/0001 等）を持つカードが並ぶと、
//   matchesCardFilter → effectiveSize(→continuousStatBonus→continuousEffectApplies
//     →checkCardConditions(cardCount)→再び matchesCardFilter) ／ matchesCardFilter → effectiveAttributes
// の相互再帰が「カードごとに毎回ゼロから」走る。カード単位の再入ガード(sizeEvaluationStack/
// grantAttributeEvaluationStack)は同一カードの無限再帰は止めるが、異なるカード間の指数的
// ファンアウト(深さ≒盤面枚数・幅≒ゲート継続数×枚数)は止められず、アイドルを並べると1手の
// 採点/戦闘解決/描画が数十秒に膨らむ（effectiveAttributes 実測1670万回）。
// そこで「最外の評価が始まってから返るまで＝盤面が不変な1パス」だけ結果をメモ化して指数を多項式に落とす。
// 最外の呼び出しが返る境界（＝次の評価では盤面が変わり得る）でメモを必ず捨てるため、
// 古い値を盤面変更を跨いで使い回すことはない。再入ガードで印字値に打ち切った近似値は
// メモに入れない（完全値のみ格納）ので、メモ経由でも従来と同じ値を返す。
let statMemoDepth = 0;
const statMemoSize = new Map(); // card → effectiveSize（完全値のみ）
const statMemoAttributes = new Map(); // card → effectiveAttributes（完全値のみ）
function statMemoBegin() {
  statMemoDepth += 1;
}
function statMemoEnd() {
  statMemoDepth -= 1;
  if (statMemoDepth <= 0) {
    statMemoDepth = 0;
    statMemoSize.clear();
    statMemoAttributes.clear();
  }
}

// 継続 modifyStats の size 増減を反映した実効サイズ（従者ガープ0013「サイズを1減らす」等）。最小0。
// 再入ガード: サイズ条件(ownFieldCardExists の filter.sizeIn 等)の評価が、このカード自身の
// effectiveSize を再帰呼び出しして無限ループになるのを防ぐ（サイズ参照の自己言及を印字サイズで打ち切る）。
// キーは instanceId ではなく**カードオブジェクト自体**にする。任意能力の「使う/使わない」など
// instanceId を持たない疑似カードでもガードが効くようにするため（instanceId 基準だとガードが
// 素通りし、サイズ条件を持つ継続効果＝S-UB-C03フラッグ等がある場で無限再帰→クリック不能になった）。
const sizeEvaluationStack = new Set();
function effectiveSize(card) {
  if (!card) {
    return 0;
  }
  statMemoBegin();
  try {
    const cached = statMemoSize.get(card);
    if (cached !== undefined) {
      return cached;
    }
    // conditionalSize: 付与元カード(granterInstanceId)が場にある間、サイズを固定値に上書きする
    // （大首領アンノウン 0029「そのカードはアンノウンが場にいるならサイズ0」）。
    // 上書きは「そのカード自身が場にいる」時だけ有効。ドロップ/ソウル等の場外では印字サイズを見る
    // （非破壊でドロップへ行った札が古いサイズ0を引きずらない。破壊時サイズは destroyedEventWindow の
    //  sizeAtDestroy で別途凍結済み。findFieldCardSlot は override がある時のみ呼ぶので負荷は無い）。
    const override = card.conditionalSize;
    const overrideActive =
      Boolean(override) &&
      (override.unconditional || granterOnField(override.granterInstanceId)) &&
      Boolean(findFieldCardSlot(card));
    const baseSize = overrideActive ? override.size || 0 : card.size || 0;
    if (sizeEvaluationStack.has(card)) {
      // 再入時は印字サイズで打ち切る近似値。完全値ではないのでメモには入れない。
      return Math.max(0, baseSize);
    }
    sizeEvaluationStack.add(card);
    try {
      const value = Math.max(0, baseSize + continuousStatBonus(card, "size"));
      statMemoSize.set(card, value);
      return value;
    } finally {
      sizeEvaluationStack.delete(card);
    }
  } finally {
    statMemoEnd();
  }
}

// 指定インスタンスIDのカードがいずれかのプレイヤーの場（モンスター/アイテム枠）にあるか。
function granterOnField(instanceId) {
  if (!instanceId) {
    return false;
  }
  return state.players.some((player) => zones.some((zone) => player.field[zone]?.instanceId === instanceId));
}

// このカードの能力(abilities/continuous/soulContinuous/keywords)が、場のいずれかの
// nullifyAbilities 継続(凍てつく星辰)によって無効化されているか。nullifyImmune のカードは対象外。
// card は場札 or ソウル内カード(ソウルの場合はホストの所有者・"soul"位置で判定)。
// Z4(d)(S-UB-C03): grantNullifyImmunity 継続の保護判定中に isAbilitiesNullified が再入した時、
// 「無効化されていない」扱いで打ち切るためのフラグ（保護元カード自身の継続走査が
// activeContinuousEffects→isAbilitiesNullified を再帰的に辿るため、無限再帰を防ぐ）。
// 0024(諸星きらり・全体無効化＋nullifyImmune) vs 0001(アイドル無効化耐性) の競合は
// 「されない」側が勝つ（0001側のcardProtectedFrom判定が先に評価されfalseで確定するため）。
let evaluatingNullifyProtection = false;
function isAbilitiesNullified(card) {
  if (!card || card.nullifyImmune || !state?.players?.length) return false;
  // フラッグは能力無効化を受けない（公式裁定Q2220: ∞ the Chaos ∞ 先例）。フラッグは場のzonesにも
  // 誰のソウルにも存在しないため、下の探索は本来どのみち host が見つからず false になるが、
  // 将来の実装変更（フラッグを走査対象に含める等）に備えて明示的に免除しておく。
  if (card.type === "flag") return false;
  if (!evaluatingNullifyProtection) {
    evaluatingNullifyProtection = true;
    try {
      if (cardProtectedFrom(card, "nullify")) return false;
    } finally {
      evaluatingNullifyProtection = false;
    }
  }
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
        // Z10(S-UB-C03/0089): battleOpponentOnly は「このカードとバトルしている相手」限定の無効化。
        // pendingAttack が無い、または card が付与元(nullifierOwner側)から見て対戦相手でなければ適用しない。
        if (e.battleOpponentOnly && !isBattlingOpponentOf(card, cardOwner, nullifierOwner)) return false;
        return true;
      });
    }),
  );
  return fieldNullified || isNullifiedByBattlingHostSoul(card);
}

// Z10: card(cardOwner側) が、nullifierOwner側のカードとバトル中（pendingAttackの攻撃側/防御側の対応関係）にあるか。
// 0089「このカードとバトルしている相手のキャラの能力全てを無効化する」の判定に使う。
function isBattlingOpponentOf(card, cardOwner, nullifierOwner) {
  const pending = state.pendingAttack;
  if (!pending || cardOwner === nullifierOwner) {
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
  if (!isAttacker && !isTarget) {
    return false;
  }
  // card が攻撃側なら nullifierOwner側は防御対象(targetCard)、card が防御側なら nullifierOwner側は攻撃側のいずれか。
  if (isAttacker) {
    return Boolean(targetCard) && pending.targetOwner === nullifierOwner;
  }
  return attackerSlots.some((slot) => slot.owner === nullifierOwner);
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
  if (!sourceCard) {
    return [];
  }
  // フラッグの継続は能力無効化を受けない（Q2220）。isAbilitiesNullified 自体も type:"flag" で
  // 常に false を返すが、呼び出し順に依存しない明示ガードとしてここでも早期リターンする。
  if (sourceCard.type === "flag") {
    return sourceCard.continuous || [];
  }
  if (isAbilitiesNullified(sourceCard)) {
    return [];
  }
  // X19(D-BT01/0131): 起動効果が付与したターン限定の継続（turnContinuous）を印字継続に合流する。
  if (sourceCard.turnContinuous?.length) {
    return [...(sourceCard.continuous || []), ...sourceCard.turnContinuous];
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

// nextOwnTurnEnd 等の遅延失効ボーナス（scheduledStatBonus）の指定 stat 合計。
function scheduledStatBonusAmount(card, stat) {
  return (card?.scheduledStatBonus || []).reduce((sum, b) => sum + (b[stat] || 0), 0);
}

function visiblePower(card) {
  return Math.max(0,
    (card?.power || 0) +
    (card?.battlePowerBonus || 0) +
    (card?.turnPowerBonus || 0) +
    scheduledStatBonusAmount(card, "power") +
    continuousPowerBonus(card)
  );
}

function visibleDefense(card) {
  return Math.max(0,
    (card?.defense || 0) +
    (card?.battleDefenseBonus || 0) +
    (card?.turnDefenseBonus || 0) +
    scheduledStatBonusAmount(card, "defense") +
    continuousDefenseBonus(card)
  );
}

function visibleCritical(card) {
  return Math.max(0,
    (card?.critical || 0) +
    (card?.battleCriticalBonus || 0) +
    (card?.turnCriticalBonus || 0) +
    scheduledStatBonusAmount(card, "critical") +
    continuousCriticalBonus(card)
  );
}

// 継続効果のドロップ枚数参照分（旧 modifyStatsByDropAttributeCount と
// 新 modifyStats{amountFrom:{source:"dropAttributeCount"}} を統一）。statKey の単価×枚数。
function continuousDropStatAmount(effect, statKey, player) {
  let filter;
  let max;
  let per;
  let distinct;
  if (effect.op === "modifyStatsByDropAttributeCount") {
    filter = effect.dropFilter || { attribute: effect.attribute };
    max = effect.max;
    per = effect[{ power: "powerPerCard", defense: "defensePerCard", critical: "criticalPerCard" }[statKey]] ?? effect[statKey] ?? 0;
  } else if (effect.op === "modifyStats" && effect.amountFrom?.source === "dropAttributeCount") {
    const af = effect.amountFrom;
    filter = af.filter || { attribute: af.attribute };
    max = af.max;
    per = af.per?.[statKey] ?? 0;
    distinct = af.distinct; // 「1種類につき」＝同名を1枚として数える（0041）
  } else {
    return 0;
  }
  if (!per) {
    return 0;
  }
  const matching = player.drop.filter((dropCard) => matchesCardFilter(dropCard, filter));
  const count = distinct ? new Set(matching.map((c) => c.name)).size : matching.length;
  const capped = max !== undefined ? Math.min(count, max) : count;
  return capped * per;
}

// 継続 modifyStats の amountFrom:{source:"soulCount"|"soulStatSum"} 分を算出（sourceCard 自身のソウル参照）。
// - soulCount: filter一致のソウル枚数 × per[statKey]（max で上限）。例: アーマナイト・アークエンジェル「ソウル1枚につき攻撃力+3000」。
// - soulStatSum: filter一致のソウルの stat 合計を applyTo の各statに加算。例: デンジャラス・クレイドル「打撃力はソウルの《武器》の打撃力合計分」。
// X11a(D-BT01/0059): 「このカードのサイズの数値分、攻撃力+1000…」= 実効サイズ×per の継続バフ。
// effectiveSize は conditionalSize（アリスのサイズ変更）を反映するため、変更後のサイズで追随する。
function continuousSelfSizeAmount(effect, statKey, sourceCard) {
  if (effect.op !== "modifyStats" || effect.amountFrom?.source !== "selfSize") {
    return 0;
  }
  const per = effect.amountFrom.per?.[statKey] ?? 0;
  return per ? effectiveSize(sourceCard) * per : 0;
}

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

// 継続 modifyStats の amountFrom:{source:"fieldSoulCount"} 分（自分の場の全カードのソウル枚数×per。H-BT04/0020）。
function continuousFieldSoulStatAmount(effect, statKey, player) {
  if (effect.op !== "modifyStats" || effect.amountFrom?.source !== "fieldSoulCount") {
    return 0;
  }
  const af = effect.amountFrom;
  const per = af.per?.[statKey] ?? 0;
  if (!per) {
    return 0;
  }
  let count = 0;
  zones.forEach((zone) => {
    (player.field[zone]?.soul || []).forEach((soulCard) => {
      if (!af.filter || matchesCardFilter(soulCard, af.filter)) {
        count += 1;
      }
    });
  });
  if (af.max !== undefined) {
    count = Math.min(count, af.max);
  }
  return count * per;
}

// Z3(S-UB-C03/0028): 継続 modifyStats の amountFrom:{source:"fieldCardCount"} 分
// （指定controllerの場の filter 一致カード枚数 × per[statKey]。max で上限）。効果op側(resolveAmountFrom)
// には既に実在するが、継続側にはこのヘルパーで配線する。controller は「発生源カードの所有者(sourceOwner)」
// を基準に self/opponent を解決する（0028「お互いの場の《眼鏡》枚数分、打撃力+1」＝self枠とopponent枠の
// 2本の継続を並べて表現）。属性は grantAttribute 付与込みの effectiveAttributes を見る matchesCardFilter。
function continuousFieldCardStatAmount(effect, statKey, sourceOwner, sourceCard) {
  if (effect.op !== "modifyStats" || effect.amountFrom?.source !== "fieldCardCount") {
    return 0;
  }
  const af = effect.amountFrom;
  const per = af.per?.[statKey] ?? 0;
  if (!per) {
    return 0;
  }
  const countOwner = af.controller === "opponent" ? 1 - sourceOwner : sourceOwner;
  let count = 0;
  zones.forEach((zone) => {
    const c = state.players[countOwner]?.field?.[zone];
    // E10(D-BT03/0091 ビッグマミー): excludeSource=発生源自身を数えない（「このカード以外の…1枚につき」。
    // 条件op cardCount の excludeSource と同型。未指定は従来どおり全数＝後方互換）。
    if (af.excludeSource && c && c.instanceId === sourceCard?.instanceId) {
      return;
    }
    if (c && matchesCardFilter(c, af.filter || {})) {
      count += 1;
    }
  });
  if (af.max !== undefined) {
    count = Math.min(count, af.max);
  }
  return count * per;
}

// E8(D-BT03/0031 ケルベロス): 継続 modifyStats の amountFrom:{source:"fieldCardStat"} 分
// （指定controllerの場の指定zone[既定item]の filter 一致カード1枚の visible stat × per[statKey]）。
// 効果op側(resolveAmountFrom src/15)と同意味論で、継続なのでライブ参照（武器の打撃力変動に追随）。
// 再帰安全性: 参照先カード(武器)の visible stat 評価が発生源の継続を再走査しても、
// continuousEffectApplies の filter（sameInstanceAsSource 等）が武器自身に一致しなければこの
// helper は呼ばれない（0031 は自己限定 filter＝安全）。参照先自身へ per を配る自己参照形
// （武器が自分の stat 分自分を強化する等）は書かないこと（無限再帰）。メモ化は continuousStatBonus
// の statMemoBegin/End スコープを共有（visibleFieldStat 内の effectiveSize/attributes 評価が同居可）。
function continuousFieldCardStatValueAmount(effect, statKey, sourceOwner) {
  if (effect.op !== "modifyStats" || effect.amountFrom?.source !== "fieldCardStat") {
    return 0;
  }
  const af = effect.amountFrom;
  const per = af.per?.[statKey] ?? 0;
  if (!per) {
    return 0;
  }
  const owner = af.controller === "opponent" ? 1 - sourceOwner : sourceOwner;
  const zone = af.zone || "item";
  const fieldCard = state.players[owner]?.field?.[zone];
  if (!fieldCard || !matchesTargetFilter(fieldCard, owner, zone, af.sourceFilter || af.filter || {})) {
    return 0;
  }
  return visibleFieldStat(fieldCard, af.stat || "power") * per;
}

// Z1(S-UB-C03/0095): 継続 modifyStats の amountFrom:{source:"buddyZoneCount"} 分
// （自分のバディゾーン裏向き枚数 × per[statKey]。max で上限）。continuousFieldSoulStatAmount と同形。
function continuousBuddyZoneStatAmount(effect, statKey, player) {
  if (effect.op !== "modifyStats" || effect.amountFrom?.source !== "buddyZoneCount") {
    return 0;
  }
  const af = effect.amountFrom;
  const per = af.per?.[statKey] ?? 0;
  if (!per) {
    return 0;
  }
  let count = (player.buddyZoneFaceDown || []).length;
  if (af.max !== undefined) {
    count = Math.min(count, af.max);
  }
  return count * per;
}

// Z1: フラッグ継続の適用可否。フラッグは findFieldCardSlot を持たないため continuousEffectApplies
// （sourceSlot/controller 判定が sourceSlot 前提）をそのまま流用できない。フラッグ継続は常に
// 「自分の場」のみを対象とする（呼び出し元で既に owner=card所有者 に限定済みのため controller 判定は不要）。
function continuousEffectAppliesForFlag(effect, targetCard, owner) {
  if (effect.conditions?.length && !checkCardConditions(effect.conditions, owner, { card: targetCard })) {
    return false;
  }
  return matchesCardFilter(targetCard, effect.filter || {});
}

// 場・ソウルの継続 modifyStats（定数 by と amountFrom:dropAttributeCount/soulCount/soulStatSum）から statKey の合計補正値を算出。
function continuousStatBonus(card, statKey) {
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return 0;
  }
  // continuousStatBonus 自体は結果をメモ化しない（this の値は effectiveSize 側でメモ化される）が、
  // この評価中に走る effectiveSize/effectiveAttributes のメモ有効範囲を継続評価の全体に広げる
  // ことで、cardCount ゲート越しの兄弟カード参照が同一パスのメモを共有できるようにする。
  statMemoBegin();
  try {
  const player = state.players[slot.owner];
  let bonus = 0;
  zones.forEach((zone) => {
    const sourceCard = player.field[zone];
    // X19(D-BT01/0131): turnContinuous も合流（activeContinuousEffects と同等。無効化判定は
    // continuousEffectApplies 側の isAbilitiesNullified が担う）。
    [...(sourceCard?.continuous || []), ...(sourceCard?.turnContinuous || [])].forEach((effect) => {
      if (!continuousEffectApplies(effect, card, sourceCard)) {
        return;
      }
      if (effect.op === "modifyStats") {
        bonus += effect[statKey] || 0;
      }
      bonus += continuousDropStatAmount(effect, statKey, player);
      bonus += continuousSoulStatAmount(effect, statKey, sourceCard);
      bonus += continuousSelfSizeAmount(effect, statKey, sourceCard); // X11a(D-BT01/0059)
      bonus += continuousFieldSoulStatAmount(effect, statKey, player);
      bonus += continuousFieldCardStatAmount(effect, statKey, slot.owner, sourceCard);
      bonus += continuousFieldCardStatValueAmount(effect, statKey, slot.owner); // E8(D-BT03/0031)
    });
  });
  // Z1(S-UB-C03/0095): フラッグの継続効果。フラッグは zones 走査に乗らない（player.field ではなく
  // player.flag に実体がある）ため専用ブロックで評価する。フラッグは能力無効化を受けない(Q2220)ため
  // isAbilitiesNullified は経由しない（activeContinuousEffects と異なりフラッグ自体はここでは
  // sourceCard として使わず、flag.continuous を直接読む）。
  if (player.flag?.type === "flag" && player.flag.continuous?.length) {
    player.flag.continuous.forEach((effect) => {
      if (!continuousEffectAppliesForFlag(effect, card, slot.owner)) {
        return;
      }
      if (effect.op === "modifyStats") {
        bonus += effect[statKey] || 0;
      }
      bonus += continuousBuddyZoneStatAmount(effect, statKey, player);
    });
  }
  // 相手側からの越境継続（opposingFront / controller:"opponent" の明示デバフ）も評価する。
  // 自陣バフ（controller 無指定の通常継続）は越境適用しないようゲートする。
  const crossOwner = 1 - slot.owner;
  const crossField = state.players[crossOwner]?.field || {};
  zones.forEach((zone) => {
    const sourceCard = crossField[zone];
    [...(sourceCard?.continuous || []), ...(sourceCard?.turnContinuous || [])].forEach((effect) => {
      // F4(bt05-0060 ワン・トゥ・ワン): controller:"both"（「君と相手の場の〜」）も越境適用する。
      // 従来は "opponent"/opposingFront のみ越境し、"both" は自陣側にしか効いていなかった。
      if (!(effect.opposingFront || effect.controller === "opponent" || effect.controller === "both")) {
        return;
      }
      if (!continuousEffectApplies(effect, card, sourceCard)) {
        return;
      }
      if (effect.op === "modifyStats") {
        const raw = effect[statKey] || 0;
        // Z4(c)(S-UB-C03/0056): grantStatDecreaseImmunity は「相手のカードの効果で減らない」
        // ＝越境デバフ(このループ)限定で保護する。自陣の負デルタ(上のown側ループ)は対象外。
        bonus += raw < 0 && statDecreaseProtected(card, statKey) ? 0 : raw;
      }
      bonus += continuousDropStatAmount(effect, statKey, state.players[crossOwner]);
      bonus += continuousSoulStatAmount(effect, statKey, sourceCard);
      bonus += continuousSelfSizeAmount(effect, statKey, sourceCard); // X11a(D-BT01/0059)
    });
  });
  soulContinuousEffects(card, slot.owner).forEach(({ effect, sourceCard }) => {
    // F2(D-EB02/0033): fieldWide:true の stat 効果は下の「場全体スキャン」で評価する（二重加算防止）。
    if (effect.fieldWide) {
      return;
    }
    if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, slot.owner)) {
      return;
    }
    if (effect.op === "modifyStats") {
      bonus += effect[statKey] || 0;
    }
  });
  // F2(D-EB02/0033 リリックオーバー): soulContinuous の modifyStats{fieldWide:true} は、ホスト自身
  // だけでなく「ホストのコントローラーの場全体」（filter適用）に乗る（「君の場の〜全て」型）。
  // 既定（fieldWide 無し）は従来どおりホスト自身のみ＝既存16枚（一竜当千・竜装機系 等）の挙動は不変。
  // FIX6(r3-軽微3): E2 の fieldHasLeaveFieldReplacer と同型の軽量事前ゲート。fieldWide のソウル
  // modifyStats が盤面に1枚も無ければ、場全体スキャン（soulContinuousEffects の割当＋
  // continuousEffectAppliesFromSoul の評価）を丸ごとスキップする。ゲート条件はループ内ガードと
  // 同値（fieldWide かつ modifyStats）＝スキップ時の寄与は必ず0のため挙動不変・定数倍削減のみ。
  if (fieldHasFieldWideSoulBonus(player)) {
    zones.forEach((hostZone) => {
      const host = player.field[hostZone];
      if (!host?.soul?.length) {
        return;
      }
      soulContinuousEffects(host, slot.owner).forEach(({ effect, sourceCard }) => {
        if (!effect.fieldWide || effect.op !== "modifyStats") {
          return;
        }
        if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, slot.owner)) {
          return;
        }
        bonus += effect[statKey] || 0;
      });
    });
  }
  return bonus;
  } finally {
    statMemoEnd();
  }
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

// FIX6(r3-軽微3): continuousStatBonus の F2 場全体スキャン用の軽量事前ゲート。
// player の場のいずれかのホストのソウルに「fieldWide:true の modifyStats」soulContinuous が
// あるときだけ true。割当・フィルタ評価を伴わない純粋な構造走査＋早期 return（.some）で、
// fieldWide を使うカード（現状 D-EB02/0033 リリックオーバー1枚のみ）が場に無い大多数の盤面では
// F2 ループを丸ごと省ける。E2 の fieldHasLeaveFieldReplacer と同じ発想。
function fieldHasFieldWideSoulBonus(player) {
  if (!player) {
    return false;
  }
  return zones.some((zone) => {
    const host = player.field[zone];
    return Boolean(
      host?.soul?.some((sourceCard) =>
        (sourceCard.soulContinuous || []).some(
          (effect) => effect.fieldWide && effect.op === "modifyStats",
        ),
      ),
    );
  });
}

function continuousEffectAppliesFromSoul(effect, targetCard, sourceCard, owner) {
  if (isAbilitiesNullified(sourceCard)) {
    return false; // 能力無効化されたソウル内カードの付与は適用しない
  }
  if (!matchesCardFilter(targetCard, effect.filter || {})) {
    return false;
  }
  if (
    effect.requireBuddy &&
    !targetCard.turnTreatAsBuddy && // treatAsBuddyThisTurn（バディ扱い）も許容（H-BT04/0016×0065）
    targetCard.name !== state.players[owner]?.buddy?.name
  ) {
    return false;
  }
  if (effect.sourceName && sourceCard?.name !== effect.sourceName) {
    return false;
  }
  // conditions: 場側 continuousEffectApplies と同仕様の条件ゲート（D-SD02 ストレングス
  // 「君のセンターにモンスターがいなくて〜」等）。owner はホストの持ち主（=「君」）。
  if (effect.conditions?.length) {
    if (!checkCardConditions(effect.conditions, owner, { card: sourceCard, targetCard })) {
      return false;
    }
  }
  return true;
}

// ソウル内カードの soulContinuous（preventReturnToHand / grantDestroyImmunity 等）が、
// フィールドカード card に op を付与しているか。controller(self/opponent) で対象側を絞り、
// continuousEffectAppliesFromSoul（能力無効化・filter・requireBuddy）で適用可否を判定する。
// causeCheck: 破壊耐性の from 条件など追加判定が要る op 用（省略時は常に true）。
function soulContinuousGrantsOp(card, op, causeCheck) {
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) {
    return false;
  }
  return state.players.some((player, hostOwner) =>
    zones.some((zone) => {
      const host = player.field[zone];
      return soulContinuousEffects(host, hostOwner).some(({ effect, sourceCard }) => {
        if (effect.op !== op) {
          return false;
        }
        // R2(D-EB02/0033 リリックオーバー): hostOnly=このソウルが乗っているカード(host)自身だけを対象にする
        //（公式「そのカードは破壊されない」＝ホスト限定。pp01-0012 のような場全体付与にしない）。
        if (effect.hostOnly && host?.instanceId !== card.instanceId) {
          return false;
        }
        if (effect.controller === "opponent" && targetSlot.owner === hostOwner) {
          return false;
        }
        if ((!effect.controller || effect.controller === "self") && targetSlot.owner !== hostOwner) {
          return false;
        }
        if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, hostOwner)) {
          return false;
        }
        return causeCheck ? causeCheck(effect) : true;
      });
    }),
  );
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
      // C7(D-EB02/0007・0018・0037): 発生源の owner/zone を明示する。sourceZoneIn 等の
      // 「発生源の在ゾーン」条件は context.owner/zone を見るため、継続評価(state.selected 非依存)でも
      // 正しく自己ゲートできるようにする（zone は従前どおり・owner を補完）。
      owner: sourceSlot.owner,
      zone: sourceSlot.zone,
      targetCard,
    })) {
      return false;
    }
  }
  // requireBuddy: 対象が、その対象の所有者が登録したバディ(同名)である場合のみ適用。
  // 「君の場のバディモンスターは〜を得る」等の継続付与で使う（soulContinuous 側と同仕様）。
  if (effect.requireBuddy) {
    if (
      !targetSlot ||
      (!targetCard?.turnTreatAsBuddy && targetCard?.name !== state.players[targetSlot.owner]?.buddy?.name)
    ) {
      return false;
    }
  }
  // targetZones: 対象の盤面ゾーン(left/center/right)で絞る（万竜不当 0047「レフトとライトのモンスター」）。
  if (Array.isArray(effect.targetZones)) {
    if (!targetSlot || !effect.targetZones.includes(targetSlot.zone)) {
      return false;
    }
  }
  return matchesCardFilter(targetCard, effect.filter || {});
}

// ==========================================================================
// Z4(S-UB-C03): 第三者付与型の耐性ゲート拡張（レスト/ソウル破棄/能力無効化/ステータス減少/ターン限定）。
// 既存の破壊(grantedDestroyImmunityBlocks)/手札戻し(preventReturnToHand)ゲートとは独立レイヤで、
// 同型のパターン（場の継続 grant*Immunity を controller/zoneIn/filter/conditions/from で判定）を
// 一般化している。既存カードはこれらの新op(grantRestImmunity等)を一切持たないため、
// 場に該当継続が無ければ常に false を返し（高速パス）、既存1,917枚の挙動には影響しない。
// ==========================================================================
const PROTECTION_OP_BY_KIND = {
  rest: "grantRestImmunity",
  soulDiscard: "grantSoulDiscardImmunity",
  nullify: "grantNullifyImmunity",
};

// Z4(a)(b)(d): 場の継続 grant*Immunity が対象カードに恒久的な耐性を与えているか。
function grantedProtectionBlocks(card, kind, cause) {
  const op = PROTECTION_OP_BY_KIND[kind];
  if (!op) {
    return false;
  }
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) {
    return false;
  }
  return state.players.some((player, sourceOwner) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return activeContinuousEffects(source).some((e) => {
        if (e.op !== op) return false;
        if (e.controller === "self" && targetSlot.owner !== sourceOwner) return false;
        if (e.controller === "opponent" && targetSlot.owner === sourceOwner) return false;
        if (e.excludeSource && source?.instanceId === card.instanceId) return false;
        if (e.zoneIn && !e.zoneIn.includes(targetSlot.zone)) return false;
        if (e.filter && !matchesCardFilter(card, e.filter)) return false;
        if (e.conditions && !checkCardConditions(e.conditions, sourceOwner, { card: source, zone })) return false;
        if (e.from && cause) {
          if (e.from.byEffect && !cause.byEffect) return false;
          if (e.from.byOpponent && !cause.byOpponent) return false;
        }
        return true;
      });
    }),
  );
}

// Z4(e): 【対抗】等でそのターン(または複数ターン)限定に付与される保護（state.turnProtections）。
// エントリ形: {kinds:["rest"|"nullify"|"returnToHand"], owner, scope, filter, zoneIn, remainingTurnEnds}。
// destroy専用の既存 state.turnDestroyImmunity/grantTurnDestroyImmunity は移行せずそのまま使う。
function turnProtectionBlocks(card, kind) {
  const list = state.turnProtections;
  if (!list || !list.length) {
    return false;
  }
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) {
    return false;
  }
  return list.some((entry) => {
    if (!entry.kinds?.includes(kind)) return false;
    if (entry.scope === "self" && targetSlot.owner !== entry.owner) return false;
    if (entry.scope === "opponent" && targetSlot.owner === entry.owner) return false;
    if (entry.zoneIn && !entry.zoneIn.includes(targetSlot.zone)) return false;
    if (entry.filter && !matchesCardFilter(card, entry.filter)) return false;
    return true;
  });
}

// Z4 共通ゲート: レスト/ソウル破棄/能力無効化の第三者付与型耐性（恒久＋ターン限定）を判定する。
// kind: "rest" | "soulDiscard" | "nullify"。cause は makeEffectCause(context, victimOwner) 形（省略可）。
function cardProtectedFrom(card, kind, cause = {}) {
  if (grantedProtectionBlocks(card, kind, cause)) {
    return true;
  }
  if (turnProtectionBlocks(card, kind)) {
    return true;
  }
  return false;
}

// Z4(c)(S-UB-C03/0056): grantStatDecreaseImmunity{stats,scope,filter,conditions} が
// statKey の（相手発の）デバフから card を保護しているか。呼び出し元(continuousStatBonusの
// crossOwnerループ)が既に「相手ソースからの負デルタ」に限定して呼ぶため、from判定は不要。
function statDecreaseProtected(card, statKey) {
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) {
    return false;
  }
  return state.players.some((player, sourceOwner) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return activeContinuousEffects(source).some((e) => {
        if (e.op !== "grantStatDecreaseImmunity") return false;
        if (!(e.stats || []).includes(statKey)) return false;
        if (e.controller === "self" && targetSlot.owner !== sourceOwner) return false;
        if (e.controller === "opponent" && targetSlot.owner === sourceOwner) return false;
        if (e.filter && !matchesCardFilter(card, e.filter)) return false;
        if (e.conditions && !checkCardConditions(e.conditions, sourceOwner, { card: source, zone })) return false;
        return true;
      });
    }),
  );
}

// Z3(S-UB-C03/0028): 場の継続 grantAttribute が card に印字属性以外の属性を付与しているか考慮した、
// 実効属性配列を返す。grantAttribute 継続が場に1つも無ければ即 card.attributes を返す（高速パス。
// 既存1,917枚のホットパスを汚さない）。再入ガード: grantAttribute 自身の filter/conditions 評価は
// 印字属性のみで判定する（付与元カード自身が「対象は《眼鏡》」等を名乗る自己言及の無限再帰を回避）。
const grantAttributeEvaluationStack = new Set();
function effectiveAttributes(card) {
  if (!card) {
    return [];
  }
  statMemoBegin();
  try {
    const cached = statMemoAttributes.get(card);
    if (cached !== undefined) {
      return cached;
    }
    const printed = card.attributes || [];
    // 再入ガードは関数冒頭で確定させる（matchesCardFilterはこの関数を経由するため、
    // 下の高速パス判定自体が isAbilitiesNullified 経由で matchesCardFilter→effectiveAttributes を
    // 再帰し得る。ガードを後回しにすると同一カードの多重再入で無限再帰し得るため先に確保する）。
    // 再入時は印字属性で打ち切る近似値。完全値ではないのでメモには入れない。
    if (card.instanceId && grantAttributeEvaluationStack.has(card.instanceId)) {
      return printed;
    }
    if (card.instanceId) {
      grantAttributeEvaluationStack.add(card.instanceId);
    }
    try {
      // 高速パス判定: 継続の生配列を直接見る（activeContinuousEffects経由だとisAbilitiesNullifiedが
      // 他カードのnullifyAbilities filterを介してmatchesCardFilter→effectiveAttributesを誘発し得るため、
      // ここでは意図的に無効化判定を経由しない生スキャンにする。既存1,917枚は誰も grantAttribute を
      // 持たないため、この生スキャンは通常 false で即 return する＝ホットパスは実質無コスト）。
      const hasAnyGrant = state?.players?.some((player) =>
        zones.some((zone) => (player.field[zone]?.continuous || []).some((e) => e.op === "grantAttribute")),
      );
      if (!hasAnyGrant) {
        statMemoAttributes.set(card, printed);
        return printed;
      }
      const granted = [];
      const targetSlot = findFieldCardSlot(card);
      state.players.forEach((player, sourceOwner) => {
        zones.forEach((zone) => {
          const source = player.field[zone];
          activeContinuousEffects(source).forEach((e) => {
            if (e.op !== "grantAttribute") return;
            if (e.scope === "self" && (!targetSlot || targetSlot.owner !== sourceOwner)) return;
            if (e.scope === "opponent" && (!targetSlot || targetSlot.owner === sourceOwner)) return;
            if (e.zones && targetSlot && !e.zones.includes(targetSlot.zone)) return;
            if (e.filter && Object.keys(e.filter).length && !matchesCardFilter(card, e.filter)) return;
            if (e.conditions && !checkCardConditions(e.conditions, sourceOwner, { card: source, zone })) return;
            const names = e.attributes || (e.attribute ? [e.attribute] : []);
            names.forEach((name) => {
              if (!granted.includes(name)) granted.push(name);
            });
          });
        });
      });
      const result = granted.length === 0 ? printed : [...printed, ...granted.filter((name) => !printed.includes(name))];
      statMemoAttributes.set(card, result);
      return result;
    } finally {
      if (card.instanceId) {
        grantAttributeEvaluationStack.delete(card.instanceId);
      }
    }
  } finally {
    statMemoEnd();
  }
}


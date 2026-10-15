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
  // E-XB54b(X-UB03/0019 ∞ the Chaos ∞): フラッグが攻撃者になれるのは印字 canAttackAsFlag を持つフラッグだけ
  // （∞ the Chaos ∞ は「君のセンターにモンスターがいても攻撃できる」＝自センター占有はゲートしない。フラッグは
  //  item/monster ではないため以降の武器センターブロック/攻撃禁止(monster限定)にも掛からない）。裏フラッグは機能停止。
  // 通常フラッグ（canAttackAsFlag 無し）や既存の全対戦はこの分岐に到達しない（攻撃者は常に場札）＝バイト不変。
  if (effectiveCardType(attacker.card) === "flag") {
    return Boolean(attacker.card.canAttackAsFlag) && !player?.flagFaceDown;
  }
  // E-XB28(X-BT03/0102 逆天③): 「次の君のターン中、君の場のカードは攻撃できない」。ターンスキップ予約の消費時に
  // 立つ、この席のこのターン限定・無条件の攻撃禁止（原文「場のカード」＝モンスター/アイテム両種が対象。
  // ignore 系キーワードでも解除しない）。既存対戦では常に false＝素通り（後方互換）。
  if (state.fieldAttackBanThisTurn?.[attacker.owner]) {
    return false;
  }
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
    // 印字 size でなく effectiveSize で判定（継続サイズ修整で3になった/でなくなったセンターを正しく扱う）。
    !(hasKeyword(attacker.card, "canAttackWithSize3Center") && effectiveSize(player.field.center) === 3)
  ) {
    return false;
  }
  if ((attacker.card.cannotAttackZones || []).includes(attacker.zone)) {
    // 「このカードはレフトとライトに攻撃できない」(武装騎神 デュナミス 0001)等。
    return false;
  }
  if (attacker.card.cannotAttackThisTurn && !cannotAttackThisTurnIgnored(attacker, player)) {
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

// cannotAttackThisTurn（カード単位の攻撃禁止）を無視できるか。発生源名（cannotAttackThisTurnSources）が記録されて
// いれば、ignoreAttackForbidden（=「グレイプニル」）と場の継続 ignoreNamedAttackForbid（モンスターのみ）が無視する名前
// 以外の発生源が1つでも残る限り禁止（ドラゴトラップ等はフェンリルでも攻撃できない）。発生源未記録の旧状態は従来どおり
// ignoreAttackForbidden で解除する（後方互換）。
function cannotAttackThisTurnIgnored(attacker, player) {
  const sources = attacker.card.cannotAttackThisTurnSources || [];
  if (sources.length === 0) {
    return hasKeyword(attacker.card, "ignoreAttackForbidden");
  }
  const ignored = hasKeyword(attacker.card, "ignoreAttackForbidden") ? ["グレイプニル"] : [];
  if (effectiveCardType(attacker.card) === "monster") {
    zones.forEach((zone) => {
      activeContinuousEffects(player?.field?.[zone]).forEach((effect) => {
        if (effect.op === "ignoreNamedAttackForbid" && effect.sourceName) {
          ignored.push(effect.sourceName);
        }
      });
    });
  }
  return sources.every((source) => ignored.includes(source));
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
    // E2: 宣言時の攻撃対象が場を離れ、別のカードが同じエリアに入っていても、それは攻撃対象ではない（null＝対象消失）。
    const card = pendingAttackTargetCard(pending);
    return card ? { owner: pending.targetOwner, zone: pending.targetZone, card } : null;
  }
  if (pending.targetType === "fighter") {
    // 防御力を持つ装備アイテムは主枠(item)だけでなく追加枠(item2/3/4)にあってもファイターへの攻撃を肩代わりする
    // （ver2.05 に装備の主枠/追加枠の区別は無い）。以前は field.item(主枠)のみ参照し、追加装備(栄光の剣
    // オーダーエッジ→栄光の盾 オーダーガード等)の防御アイテムが item2 にあると防御判定に載らず素通しで被弾して
    // いた。全アイテム枠を走査し、防御力が最大の防御アイテムを返す（複数防御アイテム装備＝降魔王剣 レヴァンティン
    // 経由。防御は受動的でスロット順に依存すべきでない＝エンジンの複数アイテム閾値 Math.max 規約 src/15:3544 と整合。
    // 以前は「最初に見つけた防御アイテム」を返しスロット順で被ダメが変わっていた・第9回メカレビュー是正）。
    const defender = state.players[pending.defender];
    let best = null;
    for (const zone of itemZones) {
      const card = defender?.field?.[zone];
      if (isDefenseItem(card) && (best === null || visibleDefense(card) > visibleDefense(best.card))) {
        best = { owner: pending.defender, zone, card };
      }
    }
    return best;
  }
  if (pending.targetType === "item") {
    const card = pendingAttackTargetCard(pending);
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
// options.ignoreOwn: 「能力全てを無効化し、破壊する」の翻訳。対象カード自身が発生源の継続は、能力無効化中と
// 同じく cannotBeNullified / __turnEffect のものだけを評価する（他カード発の耐性は従来どおり評価）。
function grantedDestroyImmunityBlocks(card, cause, options = {}) {
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) return false;
  return state.players.some((player, sourceOwner) => {
    // 継続の発生源: 場のモンスター(zones)＋フラッグ(player.flag)。フラッグ発の grantDestroyImmunity
    // （the-chaos「サイズ30以上のモンスターは相手の効果で破壊されない」等）は player.flag に実体があり
    // zones 走査に乗らないため明示的に加える。既存フラッグは grantDestroyImmunity 継続を持たない＝後方互換。
    const sources = zones.map((zone) => ({ source: player.field[zone], zone }));
    // E-XB44(ワールド・パンデミック): 裏フラッグ（flagFaceDown）は grantDestroyImmunity 継続の発生源にならない（機能停止）。
    if (player.flag?.type === "flag" && !player.flagFaceDown) {
      sources.push({ source: player.flag, zone: null });
    }
    return sources.some(({ source, zone }) =>
      activeContinuousEffects(source).some((e) => {
        if (e.op !== "grantDestroyImmunity") return false;
        if (options.ignoreOwn && source === card && !e.cannotBeNullified && !e.__turnEffect) return false;
        if (e.controller === "self" && targetSlot.owner !== sourceOwner) return false;
        if (e.controller === "opponent" && targetSlot.owner === sourceOwner) return false;
        if (e.excludeSource && source.instanceId === card.instanceId) return false;
        if (e.zoneIn && !zoneListIncludes(e.zoneIn, targetSlot.zone)) return false;
        if (e.filter && !matchesCardFilter(card, e.filter)) return false;
        if (e.from) {
          if (e.from.byBattle && !cause.byBattle) return false;
          if (e.from.byEffect && !cause.byEffect) return false;
          if (e.from.byOpponent && !cause.byOpponent) return false;
        }
        // E-X3(出荷済みバグ修正): 継続エントリの conditions を評価する。従来この関数だけが conditions を黙殺し、
        // 条件付き耐性が条件不問で常時発動していた（該当6枚: S-UB-C03/0003「アイドル3種以上なら」・0022「神谷奈緒が
        // いるなら」・0025「小日向美穂がいるなら」＋idolrare クローン ir003/ir022/ir025）。sibling の
        // grantedProtectionBlocks(src/05:828)/statDecreaseProtected(src/05:890)/soulguardNullifiedFor(src/11)と同じ
        // 走査規約＝発生源席 sourceOwner 視点・context{card:source, zone, owner}で評価。conditions 無しエントリ
        // （既存12件＋X-SD の turnOwnerIs* を条件に持つ全ソース型バッツ/アトラ）は完全不変＝後方互換。
        if (e.conditions && !checkCardConditions(e.conditions, sourceOwner, { card: source, zone, owner: sourceOwner })) {
          return false;
        }
        return true;
      }),
    );
  });
}

// 【対抗】等でそのターン中だけ付与された、ゾーン限定の破壊耐性（state.turnDestroyImmunity）。
// 例: ドラゴニック・フォースフィールド「このターン中、君のレフトとライトのモンスターは破壊されない」。
// entry.from（{byEffect,byOpponent,byBattle}）を持つエントリは cause と照合する（「相手のカードの効果で破壊されない」等）。
// from 無しの既存エントリは従来どおり原因を問わず防ぐ（後方互換）。cause 未指定の呼び出しも従来どおり。
function turnDestroyImmunityBlocks(card, cause) {
  const list = state.turnDestroyImmunity;
  if (!list || !list.length) return false;
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) return false;
  return list.some((entry) => {
    if (entry.owner !== targetSlot.owner) return false;
    if (entry.zoneIn && !zoneListIncludes(entry.zoneIn, targetSlot.zone)) return false;
    if (entry.filter && !matchesCardFilter(card, entry.filter)) return false;
    if (entry.from && cause) {
      if (entry.from.byBattle && !cause.byBattle) return false;
      if (entry.from.byEffect && !cause.byEffect) return false;
      if (entry.from.byOpponent && !cause.byOpponent) return false;
    }
    return true;
  });
}

// コストとしての「自分の場のカードを破壊する」が、そのカードの破壊耐性/離場防止で実行できないか。
// コスト破壊は payStructuredCostWithSelection が cause:{byEffect:true}・ignoreDestroyReplacement:true で
// destroyFieldCard を呼ぶため、それと同じ条件で「破壊が成立しないカード」を事前に弾く。
// 第13回メカレビュー: 以前は canPay も対話候補も耐性を見ず、耐性持ちしか場にいない状態でも支払い成立と
// 判定され、destroyFieldCard が null を返して何も破壊されないのに効果だけ通っていた（コスト踏み倒し）。
// ソウルガードは「破壊を置換してソウル1枚を失う」＝コストは払われたと数えるので除外対象にしない。
// 公式Q&A No.1933「【使用コスト】や【コールコスト】はカードの効果ではない」・No.1007/1000/850（コストの破壊は「効果で破壊
// された時」を誘発しない）: 真の【コスト】の破壊は効果の破壊ではない。原因は byCost:true・byEffect:false で表し、
// 「（相手の）カードの効果で破壊されない」（from.byEffect）耐性はコストの破壊を防がない（＝そのカードでコストを払える）。
// 原因を問わない「破壊されない」は従来どおり防ぐ。payerOwner＝コストを払う席、victimOwner＝破壊される側。
function makeCostDestroyCause(payerOwner, sourceCard, victimOwner = payerOwner) {
  return {
    byCost: true,
    byEffect: false,
    byOpponent: victimOwner !== payerOwner,
    sourceOwner: payerOwner,
    sourceType: sourceCard ? effectiveCardType(sourceCard) : null,
    sourceCard: sourceCard || null,
  };
}

// cause 省略時は真の【コスト】の破壊（makeCostDestroyCause 相当）。“C・ドレイン”等の asEffect（効果の破壊）は
// 呼び出し側が効果の原因（byEffect:true）を渡す。
function costDestroyBlocked(card, owner, cause = { byCost: true, byEffect: false, byOpponent: false }) {
  if (!card) {
    return true;
  }
  if (destroyImmunityBlocks(card, cause, owner)) {
    return true;
  }
  // Z9(場に残す)/preventNextDestroy(破壊されない置換)も破壊を成立させない＝コストとして払えない。
  if ((card.preventNextLeaveFieldCount || 0) > 0 || (card.preventNextDestroyCount || 0) > 0) {
    return true;
  }
  return false;
}

// options.ignoreOwn: 対象自身の能力（印字/一時付与/自身発の継続）による耐性だけを無視する（「能力全てを無効化し、
// 破壊する」）。他カード発の継続・ソウル・ターン耐性は引き続き評価する。
function destroyImmunityBlocks(card, cause, owner, options = {}) {
  if (!cause) return false;
  if (grantedDestroyImmunityBlocks(card, cause, options)) return true;
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
  if (turnDestroyImmunityBlocks(card, cause)) return true;
  const zone = findFieldCardSlot(card)?.zone;
  // E-PR17(PR/0478): そのターン中だけ選択カードへ付与した一時破壊耐性（card.grantedTempDestroyImmunities）。
  // 印字 card.destroyImmunity の新 form と同じ {from:{byEffect,byOpponent,...}} 判定で読む（同ヘルパー共用）。
  // E-PR11/12 の grantedTempAbilities/grantedTempAttackResistances と対の state 常駐一時付与。掃除は同寿命
  // （clearTurnModifiers/resetLeftFieldCardState）。既存カードは未設定＝この分岐を踏まず挙動完全不変。
  // 能力無効化(凍てつく星辰)中は、このカード自身の印字/一時付与の破壊耐性(『相手の効果で破壊されない』等)も無効に
  // なる。hasKeyword の ownNullified と同じ扱い（他カード発 grantedDestroyImmunity/soulContinuous/turn は上で判定
  // 済み＝ここから下は自カード分のみ）。以前は印字 destroyImmunity が isAbilitiesNullified を見ておらず、能力無効化
  // されたカードが相手効果破壊を防ぎ続けていた（キーワード由来耐性は hasKeyword 経由で正しく消えるのに非対称）。
  if (options.ignoreOwn || isAbilitiesNullified(card)) {
    return false;
  }
  const tempImm = card.grantedTempDestroyImmunities;
  if (Array.isArray(tempImm) && tempImm.some((e) => destroyImmunityEntryBlocks(e, card, cause, owner, zone))) {
    return true;
  }
  const imm = card.destroyImmunity;
  if (!imm) return false;
  const entries = Array.isArray(imm) ? imm : [imm];
  return entries.some((e) => destroyImmunityEntryBlocks(e, card, cause, owner, zone));
}

// 破壊耐性エントリ1件が cause による破壊を防ぐか。card.destroyImmunity（印字）と
// card.grantedTempDestroyImmunities（E-PR17 の一時付与）で共用。旧 object 形と新 form の両対応
// （元 destroyImmunityBlocks 内 entries.some コールバックをそのまま関数化＝挙動バイト等価）。
function destroyImmunityEntryBlocks(e, card, cause, owner, zone) {
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
  if (
    (card.abilities || []).some(
      (ability) => ability.kind === "triggered" && ability.event === "destroyed" && scan(ability),
    )
  ) {
    return true;
  }
  // 第13回メカレビュー: ソウル札の soulAbilities / inheritSoulAbilities が『破壊された時』を“提供”している場合も、
  // ソウルを先にドロップへ流すと runTriggeredAbilities が能力自体を見つけられず不発になる。誘発がソウルを
  // 参照する場合(from:"soul")と同様、解決後までソウルのドロップ送りを遅延する。
  if (
    (card.soul || []).some((soulCard) =>
      (soulCard?.soulAbilities || []).some((ability) => ability.kind === "triggered" && ability.event === "destroyed"),
    )
  ) {
    return true;
  }
  return inheritedSoulAbilitiesFor(card, "destroyed").length > 0;
}

// E-XB37(X-BT04/0051 氷血皇 ヴァン・グレイシア): 離場置換の成立後（コスト支払い→場残し）に replacement.effects
// を「発生源カード基準」の context で実行する（「捨てたら、このカードを場に残し、相手にダメージ1！」の後段）。
// effects 未指定の既存 leaveFieldReplacement 使用カードは空ループで一切走らない＝挙動不変（後方互換）。
async function runLeaveFieldReplacementEffects(card, owner) {
  const effects = card?.leaveFieldReplacement?.effects;
  if (!Array.isArray(effects) || effects.length === 0) {
    return;
  }
  const slot = findFieldCardSlot(card); // 場に残った発生源のゾーン（damage 等の context 基準）。
  const context = { card, owner, zone: slot?.zone, player: state.players[owner] };
  for (const effect of effects) {
    await executeAbilityEffect(effect, context);
  }
}

// X9(D-BT01/0131): 「このカードが場から離れる時、[コスト]を払ってよい。払ったら、このカードを場に残す」。
// 主経路（破壊 destroyFieldCard・全体手札戻し returnAllToHand）は非同期版を使い、確認は confirmChoiceAsync
//（権威サーバ往復・CPU seam・リプレイ記録を完備）、支払いは対話経路（payStructuredCostWithSelection）。
// 単体手札戻し（returnFieldTargetToHand=同期関数）だけは同期版で近似する（意図的近似・実装メモ参照）。
async function tryLeaveFieldReplacement(card, owner) {
  const replacement = card?.leaveFieldReplacement;
  if (!replacement || card.__leaveReplacementResolving || isAbilitiesNullified(card)) {
    return false;
  }
  const player = state.players[owner];
  const cost = replacement.cost || [];
  if (!canPayStructuredCost(player, cost, { sourceCard: card }).ok) {
    return false;
  }
  card.__leaveReplacementResolving = true;
  try {
    if (replacement.optional !== false) {
      const answer = await confirmChoiceAsync(owner, `${card.name}のコストを払って場に残しますか？`, {
        yesLabel: "コストを払って場に残す",
        noLabel: "場を離れる",
      });
      if (!answer) {
        return false;
      }
    }
    const paid = await payStructuredCostWithSelection(player, cost, { sourceCard: card });
    if (!paid.ok) {
      return false;
    }
  } finally {
    card.__leaveReplacementResolving = false;
  }
  addLog(`${card.name}はコストを払って場に残りました。`);
  // E-XB37: 場残し成立後の後段効果（0051「相手にダメージ1」等）。effects 未指定なら no-op（後方互換）。
  await runLeaveFieldReplacementEffects(card, owner);
  return true;
}

function tryLeaveFieldReplacementSync(card, owner) {
  const replacement = card?.leaveFieldReplacement;
  if (!replacement || card.__leaveReplacementResolving || isAbilitiesNullified(card)) {
    return false;
  }
  const player = state.players[owner];
  const cost = replacement.cost || [];
  if (!canPayStructuredCost(player, cost, { sourceCard: card }).ok) {
    return false;
  }
  if (replacement.optional !== false) {
    let answer;
    if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
      answer = replayNextConfirm();
    } else if (typeof aiShouldAnswerPrompt === "function" && aiShouldAnswerPrompt(owner)) {
      // CPU席の選択は src/22-ai.js が同期で答える（人間に CPU の判断を代行させない＝R6 ai-prompts-routed）。
      answer = aiAnswerConfirmSync(owner, `${card.name}のコストを払って場に残しますか？`, { purpose: "leaveFieldReplacement" });
      if (typeof replayRecordConfirm === "function") {
        replayRecordConfirm(answer);
      }
    } else if (typeof appChoiceUiAvailable === "function" && appChoiceUiAvailable()) {
      // ブラウザ: 同期経路では確認UIを待てないため、権威サーバと同じ既定（残す）で確定する（ネイティブ確認は出さない）。
      // 単体の手札戻しは非同期の入口（returnFieldTargetToHandAsync）で先にアプリ内UIで確認済み＝ここへは来ない。
      answer = true;
      if (typeof replayRecordConfirm === "function") {
        replayRecordConfirm(answer);
      }
    } else if (typeof window !== "undefined" && typeof window.confirm === "function") {
      answer = Boolean(window.confirm(`${card.name}のコストを払って場に残しますか？`));
      if (typeof replayRecordConfirm === "function") {
        replayRecordConfirm(answer);
      }
    } else {
      answer = true; // 非対話環境の既定: 残す（フィニッシャー保持が自然な既定）
    }
    if (!answer) {
      return false;
    }
  }
  card.__leaveReplacementResolving = true;
  try {
    const paid = payStructuredCost(player, cost, { sourceCard: card });
    if (!paid.ok) {
      return false;
    }
  } finally {
    card.__leaveReplacementResolving = false;
  }
  addLog(`${card.name}はコストを払って場に残りました。`);
  // E-XB37: 場残し成立後の後段効果。同期経路（単体手札戻し＝既存の意図的近似）でも発生源基準で発火する。
  // dealDamage 等の同期 op は executeAbilityEffect の body が同期実行される時点で解決する（await 前に適用済み）。
  runLeaveFieldReplacementEffects(card, owner);
  return true;
}

// setPreventNextDestroy{optional:true}（「次に破壊される場合、場に残せる」＝任意）: 消費する置換エントリが optional なら
// 持ち主に確認する（confirmChoiceAsync＝権威サーバ往復・CPU seam・リプレイ記録対応）。拒否なら false＝カウンタを消費せず
// 通常の破壊へ進む。optional でないエントリ（既存の「場に残す」強制形）は確認なしで true＝従来どおり。
async function acceptOptionalPreventNextDestroy(card, owner) {
  const replacement = card.preventNextDestroyEffects?.[0];
  if (!replacement?.optional) {
    return true;
  }
  return Boolean(
    await confirmChoiceAsync(owner, `${card.name}を場に残しますか？`, {
      yesLabel: "場に残す",
      noLabel: "破壊される",
      purpose: "preventNextDestroy",
    }),
  );
}

// 2026-10-09 オーナー裁定R11: 破壊が置換（ソウルガード・「破壊される/場を離れる場合、かわりに〜」・場に残す効果）で
// 置き換わった時、呼び出し側が options.outcome（任意のオブジェクト）を渡していれば outcome.replaced に種別を書く。
// 『貫通』は outcome.replaced を見て「攻撃はヒットし破壊は成功している（場に残るだけ）」としてダメージを通す
// （src/10 resolvePendingAttack/resolveMultiMonsterAttack）。破壊耐性（「破壊されない」）は置換ではないので書かない。
// noteDestroyReplaced 自体は null を返す＝場を離れて別の場所へ移る置換（ゲージ・手札・ソウルへ）用。
// 場に残る置換は下の destroyedInPlace（2026-10-09 オーナー裁定「ソウルガードで場に残っても破壊は成功している」）。
function noteDestroyReplaced(options, kind) {
  if (options?.outcome && typeof options.outcome === "object") {
    options.outcome.replaced = kind;
  }
  return null;
}

// 2026-10-09 オーナー裁定「破壊の後、ソウルによって場に残るなので破壊は成功している」（ライフリンクは除く）。
// 破壊が『ソウルガード』や「破壊される/場から離れる場合、〜。そうしたら場に残す」型の置換で“場に残った”時は、
// 破壊は成立したものとして扱う: 戻り値はそのカード（＝「破壊したら」lastDestroySucceeded・destroyedCount・
// 「攻撃で破壊した時」・反撃で破壊した時・lastDestroyedCards が数える）、破壊記録（このターン破壊された数・
// destroyedEventWindow＝「破壊された時に使える」【対抗】・ファイト中の破壊記録・破壊した側の数）、
// 「破壊された時」（自身・味方/相手・attachDestroyReaction・破壊時の特殊コール権）を発生させる。
// 場を離れていないので、離場系（ライフリンク・「場から離れた時」・movedToDrop・ソウルのドロップ送り・
// 一時状態リセット・型/サイズの復元）は行わない。outcome.replaced（R11 貫通）に加え outcome.destroyedInPlace=true。
// 自身の「破壊された時」のうち「このカードを手札に戻す/ソウルに入れる」等の“破壊されたこのカード自身を移す”能力は、
// このカードがドロップに無い（場に残っている）ため発動しない（destroyedTriggerMovesSelf）。
function destroyedInPlace(card, owner, zone, options, kind) {
  noteDestroyReplaced(options, kind);
  const player = state.players[owner];
  if (!card || !player || player.field[zone] !== card) {
    // 置換の解決中に場を離れた/差し替わった（TOCTOU）。この破壊の結果としては何も起こさない（従来の null）。
    return null;
  }
  if (options?.outcome && typeof options.outcome === "object") {
    options.outcome.destroyedInPlace = true;
  }
  const typeAtDestroy = effectiveCardType(card);
  const wasMonsterAtDestroy = typeAtDestroy === "monster";
  state.destroyedCardsThisTurn = state.destroyedCardsThisTurn || [[], []];
  state.destroyedCardsThisTurn[owner].push({ card, sizeAtDestroy: frozenSizeAtDestroy(card), wasMonster: wasMonsterAtDestroy, zone });
  syncMonstersDestroyedThisTurn();
  if (wasMonsterAtDestroy) {
    const destroyerOwner = options?.cause?.sourceOwner;
    if (destroyerOwner === 0 || destroyerOwner === 1) {
      state.destroyedByOwnerThisTurn = state.destroyedByOwnerThisTurn || [0, 0];
      state.destroyedByOwnerThisTurn[destroyerOwner] += 1;
    }
  }
  recordDestroyedEventWindow(card, owner, options?.cause || null, typeAtDestroy, zone);
  recordSpecialCallOpportunity(card, owner, zone, options || {});
  if (!options?.suppressDestroyedTriggers && !isAbilitiesNullified(card)) {
    queueDestroyedTriggers(card, owner, zone, options?.cause || null, { inPlace: true });
  }
  queueAllyDestroyedTriggers(card, owner, zone, options?.cause || null, typeAtDestroy);
  queueDestroyReactionTriggers(card);
  return card;
}

// 「破壊された時」の能力が“破壊されたこのカード自身”を別の場所へ移すもの（ドロップからの回収を前提とする）か。
// 場に残った破壊（destroyedInPlace）では、このカードはドロップに無いので発動させない（場のこのカードを移す誤動作の防止）。
const DESTROYED_SELF_MOVE_OPS = new Set([
  "returnSelfToHand",
  "moveSelfToSelectedSoul",
  "moveSelfToTargetSoul",
  "putSelfToGauge",
  "returnSelfToDeckBottom",
  "equipSelf",
  "moveSelfToBuddyZoneFaceDown",
]);
function destroyedTriggerMovesSelf(ability) {
  const scan = (node) => {
    if (Array.isArray(node)) {
      return node.some(scan);
    }
    if (node && typeof node === "object") {
      if (typeof node.op === "string" && DESTROYED_SELF_MOVE_OPS.has(node.op)) {
        return true;
      }
      return Object.values(node).some(scan);
    }
    return false;
  };
  return scan([ability?.cost, ability?.effects, ability?.script]);
}

async function destroyFieldCard(owner, zone, options = {}) {
  const player = state.players[owner];
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  // 汎用破壊耐性: 旧 {fromEffect/fromOpponentEffect/fromSpell/fromImpact} と
  // 新 [{from:{byEffect,byOpponent,sourceType}, byFilter, conditions}] の両対応
  // ignoreOwnDestroyImmunity: 「能力全てを無効化し、破壊する」＝対象自身の能力由来の耐性だけ無視（他カード発の耐性は有効）。
  if (
    !options.ignoreDestroyImmunity &&
    options.cause &&
    destroyImmunityBlocks(card, options.cause, owner, { ignoreOwn: Boolean(options.ignoreOwnDestroyImmunity) })
  ) {
    addLog(`${card.name}は${options.cause.byBattle ? "攻撃" : "効果"}では破壊されません。`);
    return null;
  }
  // Z9(S-UB-C03/0072): 「次に場から離れる場合、そのカードを場に残す」。preventNextDestroy等の
  // 個別置換より先に消費する（destroy専用の各種置換より汎用度が高いため優先）。
  if (!options.ignoreDestroyReplacement && card.preventNextLeaveFieldCount > 0) {
    card.preventNextLeaveFieldCount -= 1;
    addLog(`${card.name}は効果により場に残りました。`);
    return destroyedInPlace(card, owner, zone, options, "preventNextLeaveField");
  }
  // X9(D-BT01/0131): コスト付き離場置換（破壊もカバー。成立時は破壊されていない）。
  if (!options.ignoreDestroyReplacement && (await tryLeaveFieldReplacement(card, owner))) {
    return destroyedInPlace(card, owner, zone, options, "leaveFieldReplacement");
  }
  const destroyReplacementResult = options.ignoreDestroyReplacement ? false : await applyDestroyReplacement(card, owner, options);
  if (destroyReplacementResult) {
    // 置換が成立した。場に残る型は「破壊は成功・場に残る」（destroyedInPlace）、ゲージへ置く型（"moved"）は破壊されていない
    // （破壊数・破壊時誘発に数えない。貫通は R11 で outcome.replaced を見る）。
    return destroyReplacementResult === "moved"
      ? noteDestroyReplaced(options, "destroyReplacement")
      : destroyedInPlace(card, owner, zone, options, "destroyReplacement");
  }
  const allyDestroyReplacementResult = options.ignoreDestroyReplacement ? false : await applyAllyDestroyReplacement(card, owner, options);
  if (allyDestroyReplacementResult) {
    // 味方を庇う置換（別カードを犠牲にして card を場に残す）が成立した。手札/発生源のソウルへ移す型（"moved"）は破壊されていない。
    return allyDestroyReplacementResult === "moved"
      ? noteDestroyReplaced(options, "allyDestroyReplacement")
      : destroyedInPlace(card, owner, zone, options, "allyDestroyReplacement");
  }
  // E2(D-EB02/0031): 味方を庇う離場置換（破壊も離場の一種。相手効果=byEffect のみ庇う。戦闘破壊は byBattle のため不発）。
  if (!options.ignoreDestroyReplacement && fieldHasLeaveFieldReplacer(owner) && (await applyAllyLeaveFieldReplacement(card, owner, options.cause))) {
    return destroyedInPlace(card, owner, zone, options, "allyLeaveFieldReplacement");
  }
  // E4(D-SS03/0029 バリアブル・ビット): ソウル内カードによる離場置換（破壊=戦闘/効果をカバー。from 無しで全離場）。
  if (!options.ignoreDestroyReplacement && soulHasLeaveFieldReplacer(card) && (await applySoulLeaveFieldReplacement(card, owner, options.cause))) {
    return destroyedInPlace(card, owner, zone, options, "soulLeaveFieldReplacement");
  }
  if (!options.ignoreDestroyReplacement && card.preventNextDestroyCount > 0 && (await acceptOptionalPreventNextDestroy(card, owner))) {
    card.preventNextDestroyCount -= 1;
    const replacement = card.preventNextDestroyEffects?.shift();
    if (replacement?.gainLife && !isLifeGainByEffectPrevented(replacement.owner ?? owner)) {
      state.players[replacement.owner ?? owner].life += replacement.gainLife;
      addLog(`${replacement.source || card.name}の効果で${state.players[replacement.owner ?? owner].name}のライフを${replacement.gainLife}回復しました。`);
      // F5第5経路(第10回メカレビュー): 同一解決内『致死→preventNextDestroy回復』でライフが正へ戻るなら、ライフ0由来の
      // 暫定敗北(winReason='life')を巻き戻す（gainLife op src/15:691 等と一貫。呼ばないと winner=相手のまま誤決着）。
      clearWinnerIfNoCurrentLoss();
    }
    // E2(D-BT02/0110 我らは不死なり): mode:"returnToHand" は破壊を「場に残す」ではなく「手札へ戻す」に
    // 置換する。正規の単体手札戻し経路(returnFieldTargetToHand)へ委譲し、F5 の複製バグを再発させない
    // （ソウルのドロップ送り・ゾーンクリア・ライフリンク・「手札に戻った時」誘発込み）。effects(デッキ上→
    // ゲージ等)は手札戻しの後に microtask で解決する。手札へ移る（場に残らない）ので破壊としては数えない。
    if (replacement?.returnToHand) {
      queuePreventNextDestroyReplacementEffects(card, owner, replacement);
      await returnFieldTargetToHandAsync({ owner, zone }, replacement.source || card.name);
      return noteDestroyReplaced(options, "preventNextDestroy");
    }
    if (replacement?.grantKeyword) {
      card.turnKeywords ||= [];
      card.turnKeywords.push(replacement.grantKeyword);
    }
    queuePreventNextDestroyReplacementEffects(card, owner, replacement);
    addLog(`${card.name}は効果により場に残りました。`);
    // 2026-10-09 オーナー裁定: 場に残っても破壊は成功している（旧 countsAsDestroyed フラグ＝使用0件は既定化して吸収）。
    return destroyedInPlace(card, owner, zone, options, "preventNextDestroy");
  }
  // TOCTOU再検証(E12): ソウルガード確認(await)中に、並行する別の破壊フローが同じカードのソウルガードを先に
  // 使い切る/場から動かすことがある（同一カードへの破壊2本が同時進行）。以前は再確認せず card.soul.pop() し、
  // 2本目が undefined を drop へ積んで以降の全フェイズが TypeError で進行不能になっていた(seed300769)。
  // await 後に「まだ同じ場所に居るか」「ソウルが残っているか」を確かめ、場を離れていればこの破壊は不発、
  // ソウルが尽きていればソウルガードは使えない＝通常の破壊へ進む（逐次処理した場合と同じ結果）。
  let soulguardAccepted = false;
  if (!options.ignoreSoulguard && canUseSoulguard(card)) {
    soulguardAccepted = await shouldUseSoulguard(card, owner);
    if (soulguardAccepted && player.field[zone] !== card) {
      return null;
    }
  }
  if (soulguardAccepted && canUseSoulguard(card)) {
    // ソウルガードでドロップに置くソウルは、ソウルが2枚以上なら持ち主が選ぶ（1枚なら自動）。
    // 以前は常に先頭(最後に入れた)ソウルを pop していた。promptSeat=owner＝自分のソウル(自席には公開)から選ぶ。
    let soulCard;
    if (card.soul.length > 1) {
      const picked = await chooseCardEntries(
        card.soul.map((soul) => ({ card: soul })),
        {
          title: "ソウルガード：ドロップに置くソウルを選ぶ",
          lead: `${card.name}のソウルから、ドロップに置く1枚を選んでください。`,
          min: 1,
          max: 1,
          forceDialog: true,
          allowCancel: false,
          promptSeat: owner,
        },
      );
      if (player.field[zone] !== card) {
        return null;
      }
      const pickedId = picked?.[0]?.card?.instanceId;
      const idx = card.soul.findIndex((soul) => soul.instanceId === pickedId);
      soulCard = idx >= 0 ? card.soul.splice(idx, 1)[0] : card.soul.pop();
    } else {
      soulCard = card.soul.pop();
    }
    if (soulCard) {
      player.drop.push(soulCard);
      addLog(`${card.name}はソウルガードで場に残りました。`);
      // E1(D-BT02/0065): ソウルガードでソウル1枚がドロップへ移り、card は場に残る。
      // 「（サイズ3の《竜王番長》の）ソウルがドロップゾーンに置かれた時」の soulCardDropped を発火する。
      queueSoulCardDroppedTriggers(card, owner, 1);
      // 2026-10-09 オーナー裁定: ソウルガードで場に残っても破壊は成功している（ライフリンクは発生しない）。
      return destroyedInPlace(card, owner, zone, options, "soulguard");
    }
    // ソウル選択(await)中にソウルが尽きた＝ソウルガード不成立。通常の破壊へ進む。
  }
  // TOCTOU再検証: 上の離場置換/破壊置換/ソウルガード等のawait中に、並行する別の除去がこのカードを
  // 既に場から動かしていることがある（例: 起動能力のコスト捨てで誘発した破壊(ロータ0049)と能力本体の
  // 破壊(ブラッディ・キング0014)が同一カードへ同時進行）。entry時のnullチェックだけでは両方が通過し、
  // 両方が drop.push(card) して同一instanceの複製（card-conservation違反）になる。ここで除去の直前に
  // 「対象がまだこの場所に居る同一カードか」を再確認し、離れて/差し替わっていたらこの破壊は不発とする。
  if (player.field[zone] !== card) {
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
    // ホスト破壊でソウルがドロップへ落ちた＝ソウル札の『(ホストの)ソウルからドロップに置かれた時』(selfDroppedFromSoul・
    // 竜装機ソービット等)を発火する。reconcileFaceDownSoulDrops は冪等・opt-in(__soulHostタグ札のみ反応)。
    // 以前はホスト破壊経路が reconcile を呼ばず、並行トリガーが無いと selfDroppedFromSoul が黙って落ちていた。
    reconcileFaceDownSoulDrops();
  }
  // ライフリンクは能力無効化(凍てつく星辰/諸星きらり等)で消える（ソウルガード/反撃と同じキーワード由来能力＝
  // hasKeyword の ownNullified で無効化される類と対称）。ただし applyLifeLink(下)の時点では card は既に場外
  // （直下で field[zone]=null）で isAbilitiesNullified=false になるため、場を離れる直前のここで捕捉しておく。
  const lifeLinkNullifiedAtDestroy = isAbilitiesNullified(card);
  // rule-zones-3: 破壊時点の型（変身/搭乗/着任で装備中はアイテム扱い）。ドロップでは印字の型に戻すが（関数末尾）、
  // 破壊/場離れ誘発・破壊イベント窓はこの時点の型で照合する（eventCardTypeAtLeave / typeAtDestroy）。
  const typeAtDestroy = effectiveCardType(card);
  player.drop.push(card);
  player.field[zone] = null;
  // r3 L4(S-UB-C03/0066): 裏向きトークン化による印字値の恒久上書きの復元(restoreFaceDownMonsterPrint)は、
  // 破壊記録(destroyedCardsThisTurn/destroyedEventWindow の sizeAtDestroy)と applyLifeLink がトークンの
  // 場での状態(サイズ0・キーワード無し=lifelink無し)を見られるよう、この関数の末尾まで遅延する（第10回メカレビュー）。
  // 破壊されたカード“自身”の誘発は、破壊時点で能力を無効化されていたなら発火しない
  // （runTriggeredAbilities は isAbilitiesNullified ゲートを持つが、microtask 実行時には card が既に場外で
  //  false を返すため素通りしていた＝ライフリンクと同型の後追い判定バグ。第13回メカレビュー）。
  const selfTriggersSuppressed = options.suppressDestroyedTriggers || lifeLinkNullifiedAtDestroy;
  if (!selfTriggersSuppressed) {
    // 破壊で場からドロップへ（movedToDrop 誘発）。「能力全てを無効化してから破壊」(ラグナロク型)では発火しない。
    queueMovedToDropTriggers(card, owner, "field");
  }
  // このターン中に破壊されたカードの記録（destroyedThisTurnMatchingCountGte 用）。モンスター以外も記録する。
  // sizeAtDestroy は recordDestroyedEventWindow と同じ frozenSizeAtDestroy で算出（conditionalSize未クリアのこの時点）。
  // wasMonster は破壊時点の実効カード種を凍結（monstersDestroyedThisTurn の導出元）。
  state.destroyedCardsThisTurn = state.destroyedCardsThisTurn || [[], []];
  const wasMonsterAtDestroy = effectiveCardType(card) === "monster";
  state.destroyedCardsThisTurn[owner].push({
    card,
    sizeAtDestroy: frozenSizeAtDestroy(card),
    wasMonster: wasMonsterAtDestroy,
    zone, // pt-fix-d: 破壊時ゾーン（destroyedThisTurnMatchingCountGte の zoneIn）
  });
  syncMonstersDestroyedThisTurn();
  // E-XB70(X2-SP/0044 ランペイジ・ブラスター・レッドヒート！): 破壊“した”側（destroyer）の席別モンスター破壊数を
  // 累計する。破壊者は cause.sourceOwner（戦闘=攻撃側席・効果=発生源席）。この行に到達するのは各種置換/ソウルガードを
  // 通過した“実破壊”のみ＝実際に破壊したモンスターだけを数える。sourceOwner を持たない破壊（ルール上のドロップ等は
  // そもそも destroyFieldCard を通らない／cause 無しの破壊）は加算しない＝帰属不明分は数えない忠実側。
  if (wasMonsterAtDestroy) {
    const destroyerOwner = options.cause?.sourceOwner;
    if (destroyerOwner === 0 || destroyerOwner === 1) {
      state.destroyedByOwnerThisTurn = state.destroyedByOwnerThisTurn || [0, 0];
      state.destroyedByOwnerThisTurn[destroyerOwner] += 1;
    }
  }
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  if (!options.suppressLifeLink && !lifeLinkNullifiedAtDestroy) {
    applyLifeLink(card, owner);
  }
  recordDestroyedEventWindow(card, owner, options.cause, typeAtDestroy, zone);
  // 破壊されてドロップへ行ったカードは、場限定のサイズ上書き(conditionalSize=大首領アンノウン0029等)を解除する。
  // 破壊された瞬間のサイズは destroyedEventWindow に凍結済みなので対抗札(lastDestroyedCardMatches)は不変。
  // ドロップ滞在中のサイズ参照(ドロップからのサイズ指定コール等)が印字サイズで正しく判定される。
  card.conditionalSize = null;
  recordSpecialCallOpportunity(card, owner, zone, options);
  // suppressDestroyedTriggers: 「(場のモンスターの)能力全てを無効化してから破壊」(大魔法 ラグナロク 0030)では、
  // 破壊されたモンスター“自身”の破壊時/場離れ誘発は能力ごと無効化されているため発火させない。
  // 自身の『破壊された時』は、ラグナロク型(suppressDestroyedTriggers)に加え、破壊時点で能力を無効化されていた
  // 場合も発火しない（selfTriggersSuppressed）。どちらの場合も、遅延させたソウル(destroyTriggerUsesSoul)は
  // 誘発側で回収されないため自前でドロップへ流してソウル残留＝保存則違反を防ぐ。
  if (!selfTriggersSuppressed) {
    queueDestroyedTriggers(card, owner, zone, options.cause);
  } else if ((card.soul || []).length > 0) {
    player.drop.push(...card.soul);
    card.soul = [];
    reconcileFaceDownSoulDrops(); // ソウル札の selfDroppedFromSoul（ホスト能力無効化中でもソウル札自身の能力は生きる）
  }
  // queueLeaveFieldTriggers は“他のカード”の allyLeaveField/opponentLeaveField 放送なので、破壊されたカード自身の
  // 能力無効化では抑制しない（ラグナロク型の suppressDestroyedTriggers だけが従来どおり止める＝既存挙動を維持）。
  if (!options.suppressDestroyedTriggers) {
    queueLeaveFieldTriggers(card, owner, zone, { eventCardTypeAtLeave: typeAtDestroy });
  }
  // 味方破壊時誘発は「破壊されたモンスター自身の能力」ではないため、能力無効化(ラグナロク)でも抑制しない。
  // 非モンスター(呪文/アイテム)の『味方が破壊された時』反応が正しく発火する（近似: 他モンスターの同種反応も発火し得る）。
  queueAllyDestroyedTriggers(card, owner, zone, options.cause, typeAtDestroy);
  queueDestroyReactionTriggers(card);
  // rule-zones-3: ver2.05『変身』『搭乗』『着任』「装備されている間は…アイテムとして扱います」＝ドロップでは印字の型。
  card.currentType = card.baseType || card.type;
  // 裏向きトークン(《あの子》/晴明/ビリ・キナータ)はドロップ到達後に実カードへ復元する。破壊記録・applyLifeLink・
  // 破壊時誘発はトークンの場での状態(サイズ0/キーワード無し)で処理済み。同期の後続処理より後・return 直前で復元する。
  restoreFaceDownMonsterPrint(card);
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
  scheduleTriggerJob(async () => {
      const player = state.players[effectOwner];
      const context = { card, player, owner: effectOwner };
      for (const effect of effects) {
        await executeAbilityEffect(effect, context);
      }
      render();
    }, (error) => {
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
  scheduleTriggerJob(async () => {
      const player = state.players[reaction.owner];
      const context = { card, player, owner: reaction.owner };
      for (const effect of reaction.effects) {
        await executeAbilityEffect(effect, context);
      }
      render();
    }, (error) => {
      console.error(error);
      render();
    });
}

// 「場から離れた時」(allyLeaveField/opponentLeaveField) の誘発。現状は破壊経路から発火する
// （攻撃フェイズの自軍モンスター破壊が主要ケース。不可視の断罪銃 0012）。listener がある時のみ。
// details: runFieldEventTriggers へ渡す追加文脈（例 eventCardTypeAtLeave=離場時点の型。省略時は従来どおり）。
function queueLeaveFieldTriggers(card, owner, zone, details = {}) {
  // 離場した発生源の「そのターン中」解決済み継続を退避（発生源が場を離れても効果は続く）。
  if (card?.turnContinuous?.length) {
    detachTurnContinuousFromLeavingCard(card, owner);
  }
  // 「場から離れた時に使える」札(lastLeftFieldCardMatches)用の離場窓。破壊・手札戻し・ソウル入り・ドロップ/デッキ/
  // ゲージ送りの全離場がこの関数を通る（リスナーの有無に関係なく記録する）。
  recordLeftFieldEventWindow(card, owner, zone, details.eventCardTypeAtLeave || null);
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
  scheduleTriggerJob(async () => {
      await runFieldEventTriggers("leaveField", owner, card, zone, details);
      render();
    }, (error) => {
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
    // 庇う置換は replacer の■能力。能力を無効化されていれば使えない（allyLeaveFieldReplacement と同基準）。
    if (!replacer || replacer.instanceId === card.instanceId || isAbilitiesNullified(replacer)) {
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
    // E-XB62(X2-BT01/0076 オルコスソード・ドラゴン②): redirectTo:"sourceSoul" は「破壊されてドロップに置かれる」を
    //   「発生源（replacer）のソウルに入れる」へ置換する（庇い＝カードは破壊されず replacer のソウルへ移る）。コスト無し
    //   （replacer 自身のドロップ送り＝dropSource は起こさない）ため既定コストを空にする。saveTo/場残しの既定 dropSource とは別扱い。
    const defaultCost = rule.redirectTo ? [] : [{ op: "dropSource" }];
    const cost = adjustedCostSteps(player, replacer, "destroyReplacement", rule.cost || defaultCost);
    if (!canPayStructuredCost(player, cost, { sourceCard: replacer, selectedCard: replacer }).ok) {
      continue;
    }
    const confirmMessage = rule.redirectTo === "sourceSoul"
      ? `${card.name}を${replacer.name}のソウルに入れますか？`
      : `${replacer.name}を置いて${card.name}を場に残しますか？`;
    if (rule.optional && !(await confirmChoiceAsync(owner, confirmMessage, { purpose: "destroy-replacement" }))) {
      continue;
    }
    let payment = payCostAsk(player, cost, { sourceCard: replacer, selectedCard: replacer }); // 選択が要るコストは本人に問う
    if (payment?.then) payment = await payment;
    if (!payment.ok) {
      continue;
    }
    if (rule.redirectTo === "sourceSoul") {
      // 第三者被破壊カード card を、発生源 replacer のソウルへ移す（破壊のかわり＝ドロップに置かれない）。
      // card 自身のソウルは通常の破壊同様ドロップへ（ソウル札は自分のソウルを持てない＝保存則）。enteredSoul/
      // ソウル加入誘発は putCardsToSoulWithTrigger（funnel）で正しく発火する。card は破壊/離場としては数えない。
      const slot = findFieldCardSlot(card);
      if (slot) {
        const lifeLinkNullifiedAtLeave = isAbilitiesNullified(card); // 離場直前に捕捉（能力無効化中はライフリンク無し）
        player.drop.push(...(card.soul || []));
        card.soul = [];
        reconcileFaceDownSoulDrops(); // ソウル札の公開・selfDroppedFromSoul（他の離場経路と同基準）
        card.currentType = card.baseType || card.type;
        player.field[slot.zone] = null;
        restoreFaceDownMonsterPrint(card);
        putCardsToSoulWithTrigger(replacer, owner, [card], "field");
        // field→soul は『場を離れる』＝ライフリンク発火する（ver2.05: ライフリンクは破壊でなく離場で誘発／
        // ソウルは場に含まれないので field→soul は離場。公式Q&A「重ねコールで下敷きになりソウルへ入るカードの
        // ライフリンクは発動」準拠）。上コメントの「破壊/離場としては数えない」は destroy カウント等の話で、
        // 離場そのものは現に起きているためライフリンクは別途発火する。ソウルガードの『場に残す』とは別物。
        applyLifeLink(card, owner, { nullifiedAtLeave: lifeLinkNullifiedAtLeave });
        // 「場から離れた時」誘発も同様に発火（redirectで場を離れる＝destroyFieldCard の 511 には到達しないので二重なし）。
        queueLeaveFieldTriggers(card, owner, slot.zone);
      }
      addLog(`${card.name}は破壊されず${replacer.name}のソウルに入りました。`);
      return "moved";
    }
    if (rule.saveTo) {
      // 破壊のかわりに saveTo（手札等）へ移す（紅蓮のリング 0031「そのアイテムを手札に戻す」）。
      const slot = findFieldCardSlot(card);
      if (slot) {
        player.drop.push(...(card.soul || []));
        card.soul = [];
        const typeAtLeave = effectiveCardType(card);
        card.currentType = card.baseType || card.type;
        player.field[slot.zone] = null;
        (player[rule.saveTo] ||= []).push(card);
        recordLeftFieldEventWindow(card, owner, slot.zone, typeAtLeave); // 破壊のかわりに手札等へ＝場を離れた
      }
      addLog(`${replacer.name}を置いて${card.name}は${rule.saveTo === "hand" ? "手札" : rule.saveTo}に移りました。`);
      return "moved";
    }
    addLog(`${replacer.name}を置いて${card.name}は場に残りました。`);
    return true;
  }
  return false;
}

// E2 高速ゲート: owner の場に allyLeaveFieldReplacement を持つカードが1枚でもあるか(同期・軽量)。
// これを満たす時だけ async の applyAllyLeaveFieldReplacement を await する。持たない場合(既存の全カード)は
// await を挿さず従来のマイクロタスク順序を厳密に保つ(手札戻し等の誘発タイミングを崩さない)。
function fieldHasLeaveFieldReplacer(owner) {
  const player = state.players[owner];
  if (!player) {
    return false;
  }
  return zones.some((zone) => player.field[zone]?.allyLeaveFieldReplacement);
}

// E2(D-EB02/0031「バリア発動！」): 味方を庇う離場置換。場の別カード(replacer, 設置魔法等)が
// allyLeaveFieldReplacement を持ち、相手の効果で場を離れようとする card がその filter/from に一致するなら、
// replacer のコスト(既定 dropSource=自身をドロップ)を払って card を場に残す(移動をキャンセル)。
// allyDestroyReplacement が「破壊」だけを庇うのに対し、こちらは手札戻し/ドロップ/ゲージ送り等の
// 「効果による離場」全般を庇う。戦闘破壊は cause.byBattle のみ(byEffect 無し)のため from.byEffect で対象外。
// 相手効果の離場は全て executeAbilityEffect / destroyFieldCard の async 経路を通るため async 版のみでよい。
// rule は単体オブジェクトでも配列でも可（DSL は {allyLeaveFieldReplacement:[{...}]} を想定）。
async function applyAllyLeaveFieldReplacement(card, owner, cause) {
  if (!card) {
    return false;
  }
  const player = state.players[owner];
  for (const zone of zones) {
    const replacer = player.field[zone];
    if (!replacer || replacer.instanceId === card.instanceId || isAbilitiesNullified(replacer)) {
      continue;
    }
    const rules = replacer.allyLeaveFieldReplacement;
    if (!rules) {
      continue;
    }
    for (const rule of Array.isArray(rules) ? rules : [rules]) {
      if (rule.filter && !matchesCardFilter(card, rule.filter)) {
        continue;
      }
      if (rule.from) {
        if (rule.from.byBattle && !cause?.byBattle) continue;
        if (rule.from.byEffect && !cause?.byEffect) continue;
        if (rule.from.byOpponent && !cause?.byOpponent) continue;
      }
      const cost = adjustedCostSteps(player, replacer, "leaveFieldReplacement", rule.cost || [{ op: "dropSource" }]);
      if (!canPayStructuredCost(player, cost, { sourceCard: replacer, selectedCard: replacer }).ok) {
        continue;
      }
      if (rule.optional && !(await confirmChoiceAsync(owner, `${replacer.name}を置いて${card.name}を場に残しますか？`, { purpose: "leavefield-replacement" }))) {
        continue;
      }
      let payment = payCostAsk(player, cost, { sourceCard: replacer, selectedCard: replacer }); // 選択が要るコストは本人に問う
      if (payment?.then) payment = await payment;
      if (!payment.ok) {
        continue;
      }
      addLog(`${replacer.name}を置いて${card.name}は場に残りました。`);
      return true;
    }
  }
  return false;
}

// E4 高速ゲート: 場を離れようとする card 自身のソウルに soulLeaveFieldReplacement を持つカードが
// 1枚でもあるか(同期・軽量)。これを満たす時だけ async の applySoulLeaveFieldReplacement を await する。
// 持たない場合(既存の全カード=使用0件)は await を挿さず従来のマイクロタスク順序を厳密に保つ。
function soulHasLeaveFieldReplacer(card) {
  return Array.isArray(card?.soul) && card.soul.some((soulCard) => soulCard?.soulLeaveFieldReplacement);
}

// E4(D-SS03/0029「ジェムクローン "バリアブル・ビット"」): ソウル内カードによる離場置換。
// 「このカードがソウルにある必殺モンスターが場から離れる場合、ソウルのこのカードをドロップに置いてよい。
// 置いたら、そのカードを場に残す」。場を離れようとする card(ホスト) のソウルに soulLeaveFieldReplacement を持つ
// カード(replacer)があれば、その replacer(ソウルの当該1枚) を身代わりにドロップへ置き、ホストを場に残す。
// ally 版(applyAllyLeaveFieldReplacement)が「場の別カードが庇う」のに対し、こちらは「ホスト自身のソウルに
// 埋まった別カードが身代わりになる」。破壊(戦闘/効果)・バウンス・ゲージ送り・ドロップ送り全ての離場をカバー
// (既定 from フィルタ無し)。1離場につきソウル1枚消費(成立で即帰り)、別々の離場イベントなら残る replacer で連続置換可。
// rule は単体でも配列でも可。任意(既定 optional)。
async function applySoulLeaveFieldReplacement(card, owner, cause) {
  if (!card || !Array.isArray(card.soul) || card.soul.length === 0 || card.__soulLeaveReplacementResolving) {
    return false;
  }
  const player = state.players[owner];
  if (!player) {
    return false;
  }
  // 二重プロンプト/二重消費防止(X9 tryLeaveFieldReplacement 同様): 同一ホストへの並行離場で再入させない。
  card.__soulLeaveReplacementResolving = true;
  try {
    for (const replacer of [...card.soul]) {
      const rules = replacer?.soulLeaveFieldReplacement;
      if (!rules || isAbilitiesNullified(replacer)) {
        continue;
      }
      for (const rule of Array.isArray(rules) ? rules : [rules]) {
        // hostFilter: 庇う対象ホストの絞り。0029 は「ソウルにある“必殺モンスター”が離れる場合」なので
        // {cardType:"impactMonster"}（稀に非必殺モンスターのソウルへ入った場合は発動しない=原文どおり）。
        if (rule.hostFilter && !matchesCardFilter(card, rule.hostFilter)) {
          continue;
        }
        if (rule.from) {
          if (rule.from.byBattle && !cause?.byBattle) continue;
          if (rule.from.byEffect && !cause?.byEffect) continue;
          if (rule.from.byOpponent && !cause?.byOpponent) continue;
        }
        // 追加コスト(既定=無し。replacer 自身のドロップ送りがコスト本体)。
        const cost = adjustedCostSteps(player, replacer, "leaveFieldReplacement", rule.cost || []);
        if (cost.length && !canPayStructuredCost(player, cost, { sourceCard: replacer, selectedCard: replacer }).ok) {
          continue;
        }
        if (rule.optional !== false) {
          const answer = await confirmChoiceAsync(
            owner,
            `${replacer.name}をドロップに置いて${card.name}を場に残しますか？`,
            { purpose: "soul-leavefield-replacement", yesLabel: "ソウルを置いて場に残す", noLabel: "場を離れる" },
          );
          if (!answer) {
            continue;
          }
        }
        // TOCTOU 再検証: await(確認)中にホストが既に場を離れ/別カードに差し替わっていないか、replacer が
        // まだこのソウルに居るかを再確認する。差し替わっていたら誤発動しない(過去 destroyFieldCard の
        // player.field[zone] !== card ガードと同趣旨)。
        const slot = findFieldCardSlot(card);
        if (!slot || slot.owner !== owner) {
          return false; // ホストが場に居ない=既に離場済み。庇う対象が無い。
        }
        const idx = card.soul.indexOf(replacer);
        if (idx < 0) {
          continue; // replacer が既に消費/移動済み。
        }
        if (cost.length) {
          let paid = payCostAsk(player, cost, { sourceCard: replacer, selectedCard: replacer }); // 選択が要るコストは本人に問う
          if (paid?.then) paid = await paid;
          if (!paid.ok) {
            continue;
          }
        }
        // 支払いの選択(await)を挟んだ場合に備え、replacer の位置を取り直す（TOCTOU）。
        const idxNow = card.soul.indexOf(replacer);
        if (idxNow < 0) {
          continue;
        }
        card.soul.splice(idxNow, 1);
        putCardsToDropWithTrigger(player, owner, [replacer], "soul");
        // ホスト存命のままソウル1枚がドロップへ → soulCardDropped 誘発(整合)。
        queueSoulCardDroppedTriggers(card, owner, 1);
        addLog(`${replacer.name}をドロップに置いて${card.name}は場に残りました。`);
        return true;
      }
    }
    return false;
  } finally {
    card.__soulLeaveReplacementResolving = false;
  }
}

async function applyDestroyReplacement(card, owner, options = {}) {
  const replacement = card.destroyReplacement;
  // 「このカードが破壊される場合〜」は card の■能力。能力無効化中は使えない（ソウルガード/leaveFieldReplacement と同基準）。
  if (!replacement || options.ignoreDestroyReplacement || isAbilitiesNullified(card)) {
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
  // 統合 follow-up: 手札を捨てる等の選択が要るコスト（8枚）は本人に問う（同期の支払いは先頭から自動＝既定でしか決められない）。
  let payment = payCostAsk(player, replacementCost, {
    sourceCard: card,
    selectedCard: card,
  });
  if (payment?.then) payment = await payment;
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
      reconcileFaceDownSoulDrops(); // ソウル札の selfDroppedFromSoul/奇襲公開（他のソウル→ドロップ経路と同基準）
      player.field[slot.zone] = null;
      player.gauge.push(card);
      // 場→ゲージ＝『場を離れた』＝「場から離れた時」誘発(不可視の断罪銃 等)を発火する（redirectTo:sourceSoul:710 と
      // 同型・非破壊離場。applyDestroyReplacement が true を返すと destroyFieldCard:408 が null 返しで通常離場サイト
      // :558 に到達しないため二重発火なし・第9回メカレビュー是正）。
      queueLeaveFieldTriggers(card, owner, slot.zone);
      queueGaugePlacedTriggers(owner, [card]); // 相手のゲージにカードが置かれた時（0020）
    }
    addLog(`${card.name}は破壊置換によりゲージに置かれました。`);
    return "moved"; // 場を離れてゲージへ＝破壊されていない（destroyedInPlace にしない）
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
    // X7(D-BT01/0070): 破壊要因（効果/バトル・破壊した側）。「君のカードの効果で相手のモンスターを破壊した時」の照合用。
    cause: options.cause
      ? {
          byEffect: Boolean(options.cause.byEffect),
          byBattle: Boolean(options.cause.byBattle),
          destroyerOwner: options.cause.sourceOwner ?? null,
        }
      : null,
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
  // X7(D-BT01/0070): 破壊要因の照合（causeByEffect=効果破壊のみ・destroyerController=破壊した側が自分/相手）。
  if (spec.causeByEffect && !event.cause?.byEffect) {
    return false;
  }
  if (spec.destroyerController === "self" && event.cause?.destroyerOwner !== owner) {
    return false;
  }
  if (spec.destroyerController === "opponent" && event.cause?.destroyerOwner === owner) {
    return false;
  }
  // E-XB22(X-BT03/0111 PCM ギアゴッドVIII「君のセンターのモンスターが破壊された時」): 破壊が起きたゾーンの照合。
  // recordSpecialCallOpportunity(816)が記録した event.destroyedZone を、spec.zone(単一)/spec.zoneIn(配列・既存の
  // zone/zoneIn 作法)と突き合わせる。zone/zoneIn 未指定は全ゾーン許容＝既存カード(デュエルズィーガー系・
  // temporaryCallOpportunityMatches 全9件は zone 無し)は挙動不変（後方互換）。
  if (spec.zone && event.destroyedZone !== spec.zone) {
    return false;
  }
  if (Array.isArray(spec.zoneIn) && !zoneListIncludes(spec.zoneIn, event.destroyedZone)) {
    return false;
  }
  return matchesCardFilter(event.destroyedCard, spec.filter || {});
}

// ==========================================================================
// E-Y1(X-BT01 カタナW《暗殺鬼》): 『奇襲』(Ambush) — 裏向きソウル→ドロップの追跡と特殊コール権。
// ==========================================================================
// 裏向き(faceDown)でソウルに入ったカードは markSoulCardsFaceDown(src/15) で faceDown/__soulHost が付く。
// そのカードがドロップへ落ちたら「公開」される＝faceDown を解除し、
//  (a) 『奇襲』keyword 持ちなら drop からの特殊コール権(reason:"ambush")を記録、
//  (b) selfDroppedFromSoul 誘発(0067 袖の下)を自己に発火する。
// ドロップの札は公開情報のため、この時点で名前をログ/opportunity に載せても秘匿は破れない
// （秘匿はソウル在中のみ＝viewFor が担保）。冪等: faceDown を解除するので再走査でスキップされる。
// 呼び出し点: 主要な soul→drop 経路（queueSoulCardDroppedTriggers・destroyFieldCard のソウル一括ドロップ）
// で eager に呼び、specialCallOpportunityForCard(src/07) で lazy に呼ぶ安全網も張る（同ターン内の取りこぼし救済）。
function reconcileFaceDownSoulDrops() {
  if (!Array.isArray(state?.players)) {
    return;
  }
  state.players.forEach((player, owner) => {
    (player?.drop || []).forEach((card) => {
      // 裏向き(奇襲)札、または E-XC12(X-CP02/0029) の表向き自己離脱リスナー付き札(__soulHost タグ)を処理する。
      // どちらのタグも持たない通常のドロップ札は素通り（既存挙動不変）。
      const wasFaceDown = card?.faceDown === true;
      if (!card || (!wasFaceDown && !card.__soulHost)) {
        return;
      }
      const soulHost = card.__soulHost || null;
      // 公開/タグ消し: ソウルを離れてドロップへ置かれたので裏向きは解ける（以後 viewFor でも伏せない）。
      // 冪等: タグを消すので再走査でスキップされる。
      if (wasFaceDown) {
        card.faceDown = false;
      }
      delete card.__soulHost;
      // (b) 自己ドロップ誘発。requireFaceDown 付き(0067 奇襲)は表向き落下(wasFaceDown=false)では発火しない。
      //     hostFilter は queue 側で __soulHost スナップショットと照合する。
      queueSelfDroppedFromSoulTriggers(card, owner, { faceDown: wasFaceDown, host: soulHost });
      // (a) 『奇襲』特殊コール権は裏向き札のみ（表向き通常ソウル札は対象外）。
      if (wasFaceDown && hasKeyword(card, "ambush")) {
        recordAmbushOpportunity(card, owner);
      }
    });
  });
}

// 『奇襲』特殊コール権を記録する（instance 単位・同ターン限定）。ドロップへ落ちた本人カードを、
// その【コールコスト】を払って場へ戻せる（callMonster が source:"drop" を許容＝src/07）。
function recordAmbushOpportunity(card, owner) {
  state.specialCallOpportunities ||= [];
  const already = state.specialCallOpportunities.some(
    (event) =>
      event.reason === "ambush" &&
      event.instanceId === card.instanceId &&
      !event.used &&
      !event.expired &&
      event.turnCount === state.turnCount,
  );
  if (already) {
    return;
  }
  state.specialCallOpportunities.push({
    owner,
    reason: "ambush",
    instanceId: card.instanceId, // このカード自身のみコールできる（destroyed 型の name filter とは別軸）
    destroyedName: card.name, // ドロップの札＝公開情報（秘匿は破れない）
    turnCount: state.turnCount,
    phase: state.phase,
    cause: null,
    expired: false,
  });
  if (state.specialCallOpportunities.length > 20) {
    state.specialCallOpportunities.splice(0, state.specialCallOpportunities.length - 20);
  }
  addLog(`${state.players[owner].name}は「${card.name}」を『奇襲』でコールできます。`);
}

// 『奇襲』コール権を、コールしようとしている本人カード(instance)について探す（src/07 が使う）。
function findAmbushOpportunity(owner, card) {
  const events = state.specialCallOpportunities || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.reason === "ambush" &&
      !event.used &&
      !event.expired &&
      event.owner === owner &&
      event.instanceId === card.instanceId &&
      event.turnCount === state.turnCount
    ) {
      return event;
    }
  }
  return null;
}

// selfDroppedFromSoul(0067 袖の下): 「このカードが場の(裏向きの)ソウルからドロップゾーンに置かれた時」の
// 自己誘発。ability.requireFaceDown（裏向き限定）・ability.hostFilter（落ちる直前のホストの公開スナップショット
// を照合＝「《暗殺鬼》のソウルから」）でゲートする。listener が無ければ何もしない（既存挙動不変＝オプトイン）。
function queueSelfDroppedFromSoulTriggers(card, owner, info = {}) {
  const matches = (ability) =>
    ability.kind === "triggered" &&
    ability.event === "selfDroppedFromSoul" &&
    (!ability.requireFaceDown || info.faceDown === true) &&
    (!ability.hostFilter || (info.host && matchesCardFilter(info.host, ability.hostFilter)));
  if (!(card.abilities || []).some(matches)) {
    return;
  }
  queueTriggerMicrotask(
    () =>
      runTriggeredAbilities(card, "selfDroppedFromSoul", {
        card,
        player: state.players[owner],
        owner,
        zone: "drop",
        __abilityFilter: matches,
      }),
    { errorLabel: `${card.name}のソウル落下時能力の処理中にエラーが発生しました。`, owner },
  );
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

// 効果が読むサイズ（amountFrom targetStat/selfStat の stat:"size"）は、修整可能特性としての「現在のサイズ」＝
// 場に在るなら実効サイズ(continuous/conditionalSize込み)、破壊直後の参照(destroy→サイズ読み)なら破壊時に凍結した
// 実効サイズ(destroyedEventWindow.sizeAtDestroy)、それ以外(場外・非破壊)は effectiveSize(=印字)。印字 card.size を
// 直読みしていた resolveAmountFrom の取りこぼしを是正する（第11回メカレビュー・lastDestroyedCardMatches と同じ凍結参照）。
function effectiveOrFrozenSize(card) {
  if (!card) {
    return 0;
  }
  if (findFieldCardSlot(card)) {
    return effectiveSize(card);
  }
  const window = state.destroyedEventWindow;
  if (window && window.turnCount === state.turnCount) {
    const entry = (window.entries || []).find((e) => e.card === card);
    if (entry && typeof entry.sizeAtDestroy === "number") {
      return entry.sizeAtDestroy;
    }
  }
  return effectiveSize(card);
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

function recordDestroyedEventWindow(card, owner, cause = null, typeAtDestroy = null, zone = null) {
  const sizeAtDestroy = frozenSizeAtDestroy(card);
  // audit2(b029-2): ファイト単位の破壊記録（destroyedThisFightMatchingCountGte 用）。カード参照ではなく破壊時点の
  // 値のスナップショットを積む（ターン終了でクリアしない・JSON 直列化のみで room/replay 往復）。
  if (owner === 0 || owner === 1) {
    state.fightDestroyed = state.fightDestroyed || [[], []];
    state.fightDestroyed[owner].push({
      name: card.name,
      alsoNames: Array.isArray(card.alsoNames) ? [...card.alsoNames] : undefined,
      size: sizeAtDestroy,
      attributes: [...(card.attributes || [])],
      world: card.world,
      worlds: Array.isArray(card.worlds) ? [...card.worlds] : undefined,
      type: typeAtDestroy || card.type,
      turnCount: state.turnCount,
    });
  }
  // X7(D-BT01/0114): 破壊要因を窓に保存（lastDestroyedCardMatches の causeByEffect/destroyerController 用）。
  const entry = {
    card,
    owner,
    sizeAtDestroy,
    typeAtDestroy, // rule-zones-3: 破壊時点の型（ドロップでは印字の型へ戻るため凍結）。null=従来どおり現在の型
    zone, // audit2(b078-5): 破壊時に居たゾーン（lastDestroyedCardMatches の zoneIn/zoneNot 用）。null=未記録
    cause: cause
      ? { byEffect: Boolean(cause.byEffect), byBattle: Boolean(cause.byBattle), destroyerOwner: cause.sourceOwner ?? null }
      : null,
  };
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

// 離場一般の応答窓（destroyedEventWindow の非破壊版）。typeAtLeave＝離場時点の型（変身等は離場後に印字の型へ戻る）。
function recordLeftFieldEventWindow(card, owner, zone, typeAtLeave = null) {
  if (!card) {
    return;
  }
  const entry = { card, owner, zone, typeAtLeave: typeAtLeave || effectiveCardType(card) };
  if (state.leftFieldEventWindow && state.leftFieldEventWindow.turnCount === state.turnCount) {
    state.leftFieldEventWindow.entries.push(entry);
    return;
  }
  state.leftFieldEventWindow = {
    kind: "leftField",
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
  state.leftFieldEventWindow = null;
}

function queueDestroyedTriggers(card, owner, zone, cause = null, details = {}) {
  // E-XB25(R22): 早期リターンのガードは印字 abilities だけでなく一時付与 grantedTempAbilities も見る。
  // runTriggeredAbilities は両方を走査する（src/14）のに、ここが card.abilities のみ参照していたため、
  // 「破壊された時」の triggered が付与のみ（印字に destroyed 無し）のカードでは microtask が queue されず
  // 発火しなかった（E-PR11 の完全性バグ。0071 ブラック・プロボックの破壊時「デッキ上→ゲージ＋ライフ+1」の直接原因）。
  // 既存カードは grantedTempAbilities 未設定＝この項は常に空＝挙動不変（後方互換）。
  const hasDestroyedTrigger = (abilities) =>
    (abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "destroyed");
  // 第13回メカレビュー: ソウル札の soulAbilities / inheritSoulAbilities で継承した『破壊された時』も
  // runTriggeredAbilities は実行するのに、この早期リターンが印字 abilities しか見ておらず microtask 自体が
  // queue されず不発だった（queueGaugePlacedTriggers が使う cardHasTriggeredListener と同基準へ揃える）。
  if (
    !hasDestroyedTrigger(card.abilities) &&
    !hasDestroyedTrigger(card.grantedTempAbilities) &&
    !cardHasTriggeredListener(card, "destroyed")
  ) {
    return;
  }
  const job = async (skipAbilities = false) => {
    // skipAbilities: 攻撃の★ルール処理★で決着済み（battleTriggerHold 解放時に winner 成立）なら能力は解決しない。
    if (!skipAbilities) {
      await runTriggeredAbilities(card, "destroyed", {
        card,
        player: state.players[owner],
        owner,
        zone,
        destroyCause: cause,
        // 2026-10-09 オーナー裁定: 場に残った破壊（destroyedInPlace）では“このカード自身を移す”能力は発動しない。
        ...(details.inPlace ? { destroyedInPlace: true, __abilityFilter: (ability) => !destroyedTriggerMovesSelf(ability) } : {}),
      });
    }
    // 破壊時能力で使われなかったソウルはドロップへ（destroyFieldCard で遅延した分の回収）。
    // 場に残った破壊（details.inPlace）ではソウルはカードと共に場に残る。
    if (!details.inPlace && (card.soul || []).length > 0) {
      state.players[owner].drop.push(...card.soul);
      card.soul = [];
      reconcileFaceDownSoulDrops(); // 遅延ソウル落下でも selfDroppedFromSoul を発火（destroyTriggerUsesSoul 経路の網羅）
    }
    render();
  };
  const onError = (error) => {
    console.error(error);
    addLog(`${card.name}の破壊時能力の処理中にエラーが発生しました。`);
    render();
  };
  if (battleTriggerHold) {
    holdBattleTriggerRunner(() => job(Boolean(state.winner)).catch(onError), owner);
    return;
  }
  scheduleTriggerJob(() => job(false), onError, owner);
}

// ルールver2.05 p.13 アタックフェイズ: 3.1 破壊 → 3.2.1『貫通』 → 3.3 ★ルール処理★ → 3.4 プレイタイミング
//（「ダメージを与えた時」「モンスターを破壊した時」に発動する能力はここで解決）／p.23 自動能力は待機状態になり
// プレイタイミングで解決。攻撃による破壊〜貫通の間に queue された誘発（破壊された時/場を離れた時 等）を
// battleTriggerHold に溜め、貫通とルール処理の後で releaseBattleTriggers が順に解決する。
// クロージャを持つため state には置かない（microtask 方式と同じく一時的な実行待ち列）。
let battleTriggerHold = null;

function holdBattleTriggers() {
  const previous = battleTriggerHold;
  battleTriggerHold = [];
  return previous;
}

async function releaseBattleTriggers(previous) {
  const held = battleTriggerHold || [];
  battleTriggerHold = previous;
  // rule-counter-8(対抗窓改修): 同時に待機状態になった自動能力をターンファイターのものから解決する
  // （④2.1.1/2.1.2）。runner.__triggerOwner を持たないもの（場全体への配信等）は発生順のまま非ターン側と同列。
  const ordered = orderTriggerJobsByTurn(held, (runner) => runner.__triggerOwner);
  for (const runner of ordered) {
    await runner();
  }
}

// 誘発 job 列を「ターンファイターの job（発生順）→ それ以外（発生順）」へ安定に並べ替える。
function orderTriggerJobsByTurn(list, ownerOf) {
  const active = state?.active;
  const first = [];
  const rest = [];
  for (const item of list) {
    (ownerOf(item) === active ? first : rest).push(item);
  }
  return [...first, ...rest];
}

// battleTriggerHold へ積む runner に発動者席を添える（releaseBattleTriggers の並べ替え用）。
function holdBattleTriggerRunner(runner, owner) {
  if (owner === 0 || owner === 1) {
    runner.__triggerOwner = owner;
  }
  battleTriggerHold.push(runner);
}

// ==========================================================================
// 対抗窓改修（rule-counter-1/8・rule-damage-4・rule-keywords-10）: 誘発の待機キューと単一ドライバ。
// 設計の正: docs/対抗窓改修_設計_2026-10-08.md
// 遅延誘発（旧 microtask）は待機キューへ積み、能力本体の解決中(abilityBodyDepth>0)は待たせ、
// 解決し終えた静止点から1つずつ（ターンファイター優先で）解決する（④2.1〜2.3・2.3.1）。
// キューはクロージャ（state 外）。静止点（applyAction 後・部屋保存時）では必ず空。
// ==========================================================================
const triggerDriver = { queue: [], running: false, scheduled: false, seq: 0, lifeZeroSacrificePending: new Set(), lifeZeroSkip: null };

// 遅延誘発 job を予約する。run: async () => void、onError: 例外時、owner: 発動者席（不明なら null）。
function scheduleTriggerJob(run, onError, owner = null) {
  const handleError =
    typeof onError === "function"
      ? onError
      : (error) => {
          console.error(error);
        };
  triggerDriver.seq += 1;
  triggerDriver.queue.push({ run, onError: handleError, owner, seq: triggerDriver.seq });
  kickTriggerDriver();
}

// ドライバを（次の microtask で）起こす。能力本体の解決中や実行中は何もしない（終わった側が起こす）。
function kickTriggerDriver() {
  if (triggerDriver.running || triggerDriver.scheduled || triggerDriver.queue.length === 0) {
    return;
  }
  triggerDriver.scheduled = true;
  Promise.resolve().then(drainTriggerQueue);
}

function triggerHoldDepth() {
  return typeof triggerResolutionHold === "number" ? triggerResolutionHold : 0;
}

function triggerBodyDepth() {
  return typeof abilityBodyDepth === "number" ? abilityBodyDepth : 0;
}

async function drainTriggerQueue() {
  triggerDriver.scheduled = false;
  if (triggerDriver.running || triggerBodyDepth() > 0 || triggerHoldDepth() > 0) {
    return; // 本体/自動能力の解決中は待たせる（executeAbilityBody・runTriggeredAbilities の終わりで kick される）
  }
  triggerDriver.running = true;
  try {
    while (triggerDriver.queue.length > 0) {
      const ordered = orderTriggerJobsByTurn(triggerDriver.queue, (job) => job.owner);
      const next = ordered[0];
      triggerDriver.queue.splice(triggerDriver.queue.indexOf(next), 1);
      try {
        await next.run();
      } catch (error) {
        try {
          next.onError(error);
        } catch (_handlerError) {
          // onError 自体の失敗は握る（ドライバを止めない）
        }
      }
    }
  } finally {
    triggerDriver.running = false;
    if (triggerDriver.queue.length > 0 && triggerBodyDepth() === 0 && triggerHoldDepth() === 0) {
      kickTriggerDriver();
    }
  }
}

// 新しい対戦の開始時にキューを捨てる（前の対戦の残りを持ち越さない）。
function resetTriggerDriver() {
  triggerDriver.queue = [];
  triggerDriver.running = false;
  triggerDriver.scheduled = false;
  triggerDriver.lifeZeroSacrificePending = new Set();
}

// queue*Triggers 系 microtask の共通定型: winner決着済みならスキップ→runner実行→render。
// エラー時は console.error＋（errorLabel があれば）ログ表示＋render（3関数に散っていた定型の集約。挙動不変）。
function queueTriggerMicrotask(runner, { errorLabel, owner = null } = {}) {
  const job = async () => {
    if (state.winner) {
      return;
    }
    await runner();
    // E-Y1(奇襲): あらゆる誘発解決後に、ドロップへ落ちた裏向きソウル札を公開＋奇襲コール権/自己ドロップ誘発を消化する
    // 共通の安全網（破壊のソウル一括ドロップ・手札/デッキ戻し等、個別 soul→drop 経路を全て網羅する）。
    // faceDown は新フラグでオプトイン挿入時のみ立つため、既存カード/対戦では常に空振り＝挙動完全不変。
    reconcileFaceDownSoulDrops();
    render();
  };
  const onError = (error) => {
    console.error(error);
    if (errorLabel) {
      addLog(errorLabel);
    }
    render();
  };
  // 攻撃の破壊〜貫通/ルール処理の間は battleTriggerHold に溜め、プレイタイミングで解決する（ver2.05 p.13 3.4）。
  if (battleTriggerHold) {
    holdBattleTriggerRunner(() => job().catch(onError), owner);
    return;
  }
  scheduleTriggerJob(job, onError, owner);
}

// pt-fix-c(b) オーナー裁定: 【コールコスト】/【使用コスト】等の“宣言のコスト”で場のカードがドロップに置かれた時も
// 「（場の）このカードがドロップゾーンに置かれた時」は誘発する（ver2.05 ④ 自動能力＝示された事象の発生で発動・
// 待機状態。コストを除外する規定は無い。Q&A No.1284: 【コールコスト】で誘発した能力は待機し、コールの後で解決。
// Q&A No.665: 【使用コスト】でドロップに置いたモンスターの『ライフリンク』は発動。対して「カードの効果で破壊
// された時」はコストでは不発＝No.1007/1000 は“効果で”の限定ゆえ）。誘発は事象の時点で待機し、宣言（コール/魔法/
// 装備/設置/起動）の解決後に解決する＝コスト支払い中に積んだ movedToDrop 系を控え、pendingAction に持たせて
// resolvePendingAction の後で放つ（state に置く＝部屋保存/リプレイでも失われない。カード実体ではなく instanceId）。
// 効果本体の解決中（abilityBodyDepth/triggerResolutionHold>0）の支払いは控えない＝従来どおり待機キューへ（本体の後で解決）。
let costDropCaptureDepth = 0;

function costDropCaptureActive() {
  return costDropCaptureDepth > 0 && triggerBodyDepth() === 0 && triggerHoldDepth() === 0;
}

function holdCostDropTrigger(kind, card, owner, fromZone) {
  if (!card?.instanceId) {
    return false;
  }
  state.heldCostDropTriggers ||= [];
  state.heldCostDropTriggers.push({ kind, instanceId: card.instanceId, owner, fromZone });
  return true;
}

// 控えている（まだ pendingAction に渡していない）コスト由来ドロップ誘発を取り出す。
function takeHeldCostDropTriggers() {
  const held = state.heldCostDropTriggers || [];
  if (state.heldCostDropTriggers) {
    delete state.heldCostDropTriggers;
  }
  return held;
}

// 控えた誘発を待機キューへ放つ（宣言の解決後／宣言に至らなかった時）。カードはドロップ（無ければ全域）から引き直す。
function releaseCostDropTriggers(entries) {
  (entries || []).forEach((entry) => {
    const player = state.players[entry.owner];
    if (!player) {
      return;
    }
    const card =
      player.drop.find((c) => c?.instanceId === entry.instanceId) || findCardInstanceAnywhere(entry.instanceId);
    if (!card) {
      return;
    }
    if (entry.kind === "field") {
      queueMovedToDropFieldTriggersNow(card, entry.owner, entry.fromZone);
    } else {
      queueMovedToDropTriggersNow(card, entry.owner, entry.fromZone);
    }
  });
}

function releaseHeldCostDropTriggers() {
  if (state.heldCostDropTriggers?.length) {
    releaseCostDropTriggers(takeHeldCostDropTriggers());
  }
}

function findCardInstanceAnywhere(instanceId) {
  for (const player of state.players) {
    const piles = [player.drop, player.hand, player.deck, player.gauge];
    for (const pile of piles) {
      const hit = (pile || []).find((c) => c?.instanceId === instanceId);
      if (hit) {
        return hit;
      }
    }
    for (const zone of Object.keys(player.field || {})) {
      const fieldCard = player.field[zone];
      if (fieldCard?.instanceId === instanceId) {
        return fieldCard;
      }
      const soulHit = (fieldCard?.soul || []).find((c) => c?.instanceId === instanceId);
      if (soulHit) {
        return soulHit;
      }
    }
  }
  return null;
}

// コスト支払い（payStructuredCost/WithSelection）を囲む。失敗時、または外側の解決中でない最上位の支払いが
// 宣言に至らなかった場合に備え、失敗なら即放つ（成功時は beginPendingAction/executeAbilityBody が引き取る）。
function enterCostDropCapture() {
  costDropCaptureDepth += 1;
}

function exitCostDropCapture(result) {
  costDropCaptureDepth = Math.max(0, costDropCaptureDepth - 1);
  if (costDropCaptureDepth === 0 && !(result && result.ok)) {
    releaseHeldCostDropTriggers();
  }
}

// 「このカードが場かデッキからドロップゾーンに置かれた時」の誘発（H-SS01 リーゼントホーン等）。
// fromZone: "field" | "deck"。ability.fromZones（省略時は両方）で絞る。
// 対応経路: 破壊(destroyFieldCard)・ルール/効果ドロップ(dropFieldCardByRule)・mill(moveTopDeckToDrop)・
// script の moveSelected(to:"drop")・宣言のコストstep（pt-fix-c(b): 宣言の解決後まで控える＝上記）。
function queueMovedToDropTriggers(card, owner, fromZone) {
  if (costDropCaptureActive() && fromZone === "field" && movedToDropSelfMatcherHits(card, fromZone)) {
    holdCostDropTrigger("self", card, owner, fromZone);
    return;
  }
  queueMovedToDropTriggersNow(card, owner, fromZone);
}

function movedToDropSelfMatcherHits(card, fromZone) {
  return (card?.abilities || []).some(
    (ability) =>
      ability.kind === "triggered" &&
      ability.event === "movedToDrop" &&
      (!ability.fromZones || zoneListIncludes(ability.fromZones, fromZone)),
  );
}

function queueMovedToDropTriggersNow(card, owner, fromZone) {
  const matches = (ability) =>
    ability.kind === "triggered" &&
    ability.event === "movedToDrop" &&
    (!ability.fromZones || zoneListIncludes(ability.fromZones, fromZone));
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
    { errorLabel: `${card.name}のドロップ時能力の処理中にエラーが発生しました。`, owner },
  );
}

// E-XB57(X-UB03/0010 虹色特権): 「（場の）カードがドロップゾーンに置かれた時」の **field-wide** ブロードキャスト。
// 上の queueMovedToDropTriggers はドロップへ落ちたカード“自身”の movedToDrop 自己誘発だが、こちらは場の**他**の
// カードが反応する ally/opponentMovedToDrop を場全体（set 枠含む）へ配送する（allyDestroyed/queueAllyDestroyedTriggers の
// 非破壊版・鏡）。
// 【重複発火の分担（設計固定）】破壊由来のドロップは既存の allyDestroyed/opponentDestroyed(queueAllyDestroyedTriggers)が
//   担当する。この broadcast は destroyFieldCard からは呼ばない＝**非破壊のドロップ移動のみ**（コスト/効果由来。dropFieldCardByRule と
//   putCardsToDropWithTrigger の fromZone==="field")。したがって 1回のドロップが destroyed と movedToDrop の両方を発火することは無い
//   （破壊→allyDestroyed のみ／非破壊→movedToDrop のみ）。「破壊された時」と「（非破壊で）ドロップに置かれた時」を両方拾いたい
//   カード（0010 等）は両イベントの listener を別 ability として持ち、shared limit で 1ターン1回に束ねる。
// fromZone は "field" のみ対象（デッキ→ドロップのミルは「場からドロップに置かれた時」の語義に該当しないため配送しない）。
// リスナー(ally/opponentMovedToDrop)を持つ場札が無ければ何もしない＝既存カードは配送ゼロで挙動完全不変。
function queueMovedToDropFieldTriggers(card, owner, fromZone) {
  if (fromZone !== "field" || !card) {
    return;
  }
  if (costDropCaptureActive()) {
    // pt-fix-c(b): 宣言のコストで場からドロップ＝場の他カードの「ドロップに置かれた時」も宣言の解決後まで控える
    // （リスナーが居る時だけ控える＝既存対戦の state は不変）。
    if (movedToDropFieldListenerExists()) {
      holdCostDropTrigger("field", card, owner, fromZone);
    }
    return;
  }
  queueMovedToDropFieldTriggersNow(card, owner, fromZone);
}

function movedToDropFieldListenerExists() {
  return [0, 1].some((playerIndex) =>
    zones.some((fieldZone) => {
      const sourceCard = state.players[playerIndex]?.field?.[fieldZone];
      return (
        cardHasTriggeredListener(sourceCard, "allyMovedToDrop") ||
        cardHasTriggeredListener(sourceCard, "opponentMovedToDrop")
      );
    }),
  );
}

function queueMovedToDropFieldTriggersNow(card, owner, fromZone) {
  if (fromZone !== "field" || !card) {
    return;
  }
  const hasListener = movedToDropFieldListenerExists();
  if (!hasListener) {
    return;
  }
  scheduleTriggerJob(async () => {
      await runFieldEventTriggers("movedToDrop", owner, card, "drop", { fromZone });
      render();
    }, (error) => {
      console.error(error);
      addLog(`${card?.name ?? "カード"}のドロップ移動フィールド誘発の処理中にエラーが発生しました。`);
      render();
    });
}

// 「このカードが（場かドロップから）ソウルに入った時」の誘発（H-SS01 竜装機 チャージャー等）。
// fromZone: "field" | "drop" | "hand"。ability.fromZones（省略時は全部）で絞る。
// 対応経路: 星合体/ソウル投入 script（moveSelfToSelectedSoul/moveSelectedToSelectedSoul）・
// moveSelfToTargetSoul・コストの putDropToSoul/putOwnFieldCardsToSoul。
function enteredSoulAbilityMatcher(fromZone) {
  return (ability) =>
    ability.kind === "triggered" &&
    ability.event === "enteredSoul" &&
    (!ability.fromZones || zoneListIncludes(ability.fromZones, fromZone));
}

function queueEnteredSoulTriggers(card, owner, fromZone, hostCard) {
  const matches = enteredSoulAbilityMatcher(fromZone);
  if (!(card.abilities || []).some(matches)) {
    return;
  }
  // ホストがまだ場に無い（コール/装備/設置のコストで手札等のホストのソウルに入った）場合、誘発はその行動が
  // 終わってホストが場に置かれてから解決する（ver2.05: 行動の途中で誘発した自動能力は待機し、行動の完了後に
  // 解決する）。「そのカードの攻撃力＋4000」等がホストの登場時リセットで消えないよう、登場時に flush する。
  // 直列化（部屋保存/リプレイ）に card 実体を二重保持しないよう instanceId で控える。
  // 控えるのはコールされるモンスターのホストだけ（場に置かれる全コール経路が resetEnteringFieldCardState を通る）。
  // アイテム/設置魔法/フラッグ等のホストは従来どおり即時に積む（後方互換）。
  if (hostCard && hostCard.type === "monster" && !findFieldCardSlot(hostCard) && !state.players.some((p) => p?.flag === hostCard)) {
    hostCard.deferredEnteredSoulTriggers ||= [];
    hostCard.deferredEnteredSoulTriggers.push({ instanceId: card.instanceId, owner, fromZone });
    return;
  }
  queueEnteredSoulTriggersNow(card, owner, fromZone, hostCard, matches);
}

// 登場するホスト(card)に控えた enteredSoul 誘発を解決待ちへ積む（resetEnteringFieldCardState から呼ぶ）。
// 控えたソウル札がまだこのホストのソウルに居る時だけ発火する。
function flushDeferredEnteredSoulTriggers(hostCard) {
  const deferred = hostCard?.deferredEnteredSoulTriggers;
  if (!deferred?.length) {
    return;
  }
  hostCard.deferredEnteredSoulTriggers = [];
  deferred.forEach(({ instanceId, owner, fromZone }) => {
    const soulCard = (hostCard.soul || []).find((c) => c.instanceId === instanceId);
    if (soulCard) {
      queueEnteredSoulTriggersNow(soulCard, owner, fromZone, hostCard, enteredSoulAbilityMatcher(fromZone));
    }
  });
}

function queueEnteredSoulTriggersNow(card, owner, fromZone, hostCard, matches) {
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
    { errorLabel: `${card.name}のソウル投入時能力の処理中にエラーが発生しました。`, owner },
  );
}

// E1(D-BT02/0065 舎弟見習い ヘルパー・成): 「君の場のサイズ3の《竜王番長》のソウルがドロップゾーンに
// 置かれた時」の fieldEvent。「ホスト(hostCard)が場に残ったまま、そのソウルがドロップへ移った」経路から
// 呼ぶ。「そのモンスターのソウルに入れる」対象が要るため、ホストが場に残っている時だけ発火する
// （破壊等でホスト自身が場を離れる soul→drop 経路からは呼ばない）。
// runFieldEventTriggers が ally/opponentSoulCardDropped を場全体へ配送し、リスナー(0065)は
// eventCardMatches で発生源ホスト(size3・竜王番長)を絞り、moveSelfToTargetSoul($target)で自身を注ぐ。
// 配線済み経路（F2: 同パック0062の【起動】discardSoul等が判明し全経路へ拡張）:
//   ソウルガード(src/11)／soulCost破壊置換(src/11)／discardSoul コスト×2(src/04)／
//   dropOwnFieldCardSoul コスト×2(src/04)／dropOwnFieldOrSoulCard のソウル枝(src/04)／
//   dropSelectedSoul・discardSelfSoul・moveSoulToDrop script(src/14)／dropTargetSoul・dropAllSoulAtZone(src/15)／
//   攻撃キーワードのソウルドロップ×2(src/09)。
//   ホスト自身が同時に離場する経路（destroyFieldCard のソウル一括ドロップ・dropFieldCardByRule・
//   手札/デッキ/ゲージ戻し・detachFieldCardForMove・soulFilter置換等）と、宛先がドロップでない
//   discardSoulToDeckBottom/moveSoulToGauge は意図的に対象外。
// 二重ガード: (1)呼出時=ホスト在場チェック（無ければ即不発）、(2)発火時=再検証（queue後の同期処理で
//   ホストが自壊/破壊/差し替えされたら不発。destroyAttackedMonsterWithSoulDrop の直後破壊や
//   設置のソウル切れ自壊 maybeDropSetWhenSoulEmpty との競合を安全化）。
function queueSoulCardDroppedTriggers(hostCard, hostOwner, count = 1) {
  if (!hostCard || count <= 0 || !Array.isArray(state?.players)) {
    return;
  }
  // E-Y1(奇襲): ソウル→ドロップの主要経路。listener 有無に関わらず、落ちた裏向き札の公開・
  // 特殊コール権記録・selfDroppedFromSoul をここで先に消化する（ホスト在否は問わない＝下の early return より前）。
  reconcileFaceDownSoulDrops();
  const slot = findFieldCardSlot(hostCard);
  if (!slot) {
    return; // ホストが場を離れていれば発火しない（対象「そのモンスター」が存在しない）。
  }
  // listener 検出は cardHasTriggeredListener に統一（自身/ソウル札/継承爆雷まで見る。queueDrewTriggers と同型）。
  const hasListener = state.players.some((player) =>
    zones.some((zone) => {
      const listener = player?.field?.[zone];
      return (
        cardHasTriggeredListener(listener, "allySoulCardDropped") ||
        cardHasTriggeredListener(listener, "opponentSoulCardDropped")
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  queueTriggerMicrotask(
    () => {
      // 発火時再検証(TOCTOU): queue後の同期処理でホストが離場/差し替わっていたら不発
      // （例: destroyAttackedMonsterWithSoulDrop のソウルドロップ→直後破壊、設置のソウル切れ自壊）。
      const current = state.players[hostOwner]?.field?.[slot.zone];
      if (!current || current.instanceId !== hostCard.instanceId) {
        return;
      }
      return runFieldEventTriggers("soulCardDropped", hostOwner, hostCard, slot.zone, { count });
    },
    { errorLabel: `${hostCard.name}のソウルがドロップに置かれた時の能力の処理中にエラーが発生しました。` },
  );
}

// E-XB24(X-BT03/0019 エグゼキューション・グラウンド): 「君の《黒竜》にソウルが入った時」の場ブロードキャスト
// （allySoulCardDropped の鏡）。ソウルが流入したホスト(hostCard)を eventCard として場全体へ
// allySoulCardAdded / opponentSoulCardAdded を配送する。リスナーは eventCardMatches でホスト（黒竜等）を絞る。
// 入ったソウル札は details.enteredSoulCard で運ぶ（主体は「ソウルを得たホスト」なので eventCard=host＝dropped 鏡と対称）。
// ソウル流入の全経路（コスト put*ToSoul／効果 putTopDeckToSoul 等／script move soul・itemSoul／重ねコール stack／
// soul 継承）から呼ぶ。funnel putCardsToSoulWithTrigger からも直接 .soul.push する各所からも呼ぶ（発火漏れ防止）。
// listener 検出は cardHasTriggeredListener に統一（queueSoulCardDroppedTriggers と同型）。listener が無ければ
// 何もしない＝既存カードに soulCardAdded リスナーは無く挙動完全不変（後方互換）。
function queueSoulCardAddedTriggers(hostCard, hostOwner, count = 1, enteredSoulCard = null) {
  if (!hostCard || count <= 0 || !Array.isArray(state?.players)) {
    return;
  }
  const hasListener = state.players.some((player) =>
    zones.some((zone) => {
      const listener = player?.field?.[zone];
      return (
        cardHasTriggeredListener(listener, "allySoulCardAdded") ||
        cardHasTriggeredListener(listener, "opponentSoulCardAdded")
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  queueTriggerMicrotask(
    () => {
      // 発火時再検証(TOCTOU): queue後の同期処理でホストが離場/差し替わっていたら不発（コール中の一時状態や
      // 直後の破壊/差し替えとの競合を安全化。queueSoulCardDroppedTriggers と同型）。ホスト現在位置から配送する。
      const slot = findFieldCardSlot(hostCard);
      if (!slot) {
        return;
      }
      return runFieldEventTriggers("soulCardAdded", slot.owner, hostCard, slot.zone, { count, enteredSoulCard });
    },
    { errorLabel: `${hostCard.name}のソウルに入った時の能力の処理中にエラーが発生しました。` },
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
  // 誘発の発生時点のフェイズを記録する（phaseIs はこれを優先評価）。チャージ＆ドロー（ver2.05 スタートフェイズ 3.2）は
  // drawCards の直後に同期で state.phase="main" へ切り替わり、誘発は microtask で後から評価されるため、
  // 「スタートフェイズ以外に手札が増えた時」(H-PP01/0024 BAR キング・ソロモン)の除外が効かなかった。
  const eventPhase = state.phase;
  queueTriggerMicrotask(() => runFieldEventTriggers("drew", drawerOwner, undefined, undefined, { eventPhase }), {
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
  // 第13回メカレビュー: ソウル発(soulAbilities)/爆雷継承(inheritSoulAbilities)の『君がダメージを受けた時』も
  // 拾う（cardHasTriggeredListener は queueGaugePlacedTriggers と同じ判定＝兄弟 queue と基準を揃える）。
  const hasListener = zones.some((zone) => cardHasTriggeredListener(player.field[zone], "damageReceived"));
  if (!hasListener) {
    return;
  }
  const damageSourceLabel = options.sourceAbilityLabel || null;
  const byAttack = Boolean(options.byAttack);
  scheduleTriggerJob(async () => {
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
    }, (error) => {
      console.error(error);
      render();
    });
}

// 「君の場の(他の)モンスターが破壊された時」など、場の他カードが反応する破壊フィールドイベント。
// 破壊されたカード自身の destroyed 誘発(queueDestroyedTriggers)とは別に、ally/opponent Destroyed を
// 場の全枠(set枠含む)へ配送する。設置呪文「飢えたるヤミゲドウ」等が set ゾーンで反応するための経路。
// 反応するカードが場に無ければ何もしない。発火対象はモンスターに限らず(条件 eventCardMatches で絞る)。
function queueAllyDestroyedTriggers(card, owner, zone, cause = null, typeAtDestroy = null) {
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
  scheduleTriggerJob(async () => {
      await runFieldEventTriggers("destroyed", owner, card, zone, {
        destroyCause: cause,
        ...(typeAtDestroy ? { eventCardTypeAtLeave: typeAtDestroy } : {}),
      });
      render();
    }, (error) => {
      console.error(error);
      addLog(`${card?.name ?? "カード"}の破壊フィールド誘発の処理中にエラーが発生しました。`);
      render();
    });
}

// 「場のモンスターが手札/デッキに戻った時」の誘発（D・R・システム / 竜剣 ドラムソード等、場の他カードが反応）。
// 復帰処理は同期関数のため、破壊/手札破棄の誘発と同じくマイクロタスクで非同期発火する。
// E-XV6(X-UB02/0015 制服戦士 ドクターフリル): 「このカードが手札に戻った時」の**自己発火**イベント
// （returnedToHand）。movedToDrop/discardedFromHand と同型＝戻ったカード自身の abilities へ直接
// runTriggeredAbilities する（既存の allyCardReturned/monsterReturned 系は場全体ブロードキャストで、
// 戻ったカード自身は放送時点で場に居らずリスナーになれない＝受け皿欠落の恒久解）。
// fromZone: "field"（場→手札の全 funnel＝returnFieldTargetToHand / returnAllToHand）| "drop"
// （returnSelfToHand のドロップ回収枝）。ability.fromZones（省略時は全ゾーン）で絞る（例
// {event:"returnedToHand", fromZones:["field"]}＝「場から手札に戻った時」のみ）。
// hasListener ゲート＝リスナーを持たない既存カード（DB 走査で使用0件＝機械実証）は一切 queue されず挙動不変。
function queueReturnedToHandTriggers(card, owner, fromZone) {
  const matches = (ability) =>
    ability.kind === "triggered" &&
    ability.event === "returnedToHand" &&
    (!ability.fromZones || zoneListIncludes(ability.fromZones, fromZone));
  if (!(card?.abilities || []).some(matches)) {
    return;
  }
  queueTriggerMicrotask(
    () =>
      runTriggeredAbilities(card, "returnedToHand", {
        card,
        player: state.players[owner],
        owner,
        fromZone,
        __abilityFilter: matches,
      }),
    { errorLabel: `${card.name}の手札復帰時能力の処理中にエラーが発生しました。`, owner },
  );
}

// details.eventCardTypeAtLeave: 離場時点の型（変身/搭乗/着任で装備中だけアイテム扱いのカードは、離場後に印字の型へ
// 戻るため、呼び出し側が離場直前に捕捉して渡す。省略時は従来どおり現在の型で判定）。
// details.returnedTo: "deck"＝場からデッキ（上/下）へ戻った（rule-zones-7）。「手札かデッキに戻った時」と書かれた
// リスナー（ability.returnedToZones に "deck" を含むもの）だけが反応し、cardReturned（「手札に戻った時」専用）は
// 発火しない。省略時＝手札（従来どおり全 monsterReturned/cardReturned リスナーが対象）。
function queueMonsterReturnedTriggers(card, owner, zone, details = {}) {
  const typeAtLeave = details.eventCardTypeAtLeave || effectiveCardType(card);
  const toDeck = details.returnedTo === "deck";
  scheduleTriggerJob(async () => {
      if (typeAtLeave === "monster") {
        // Z14(b)(S-UB-C03/0017): details.returnCause を "monsterReturned" 誘発コンテキストへ伝播する。
        await runFieldEventTriggers(
          "monsterReturned",
          owner,
          card,
          zone,
          toDeck
            ? {
                ...details,
                __abilityFilter: (ability) =>
                  Array.isArray(ability.returnedToZones) && ability.returnedToZones.includes("deck"),
              }
            : details,
        );
      }
      if (toDeck) {
        render();
        return;
      }
      // レビュー修正(D-BT01/0096/0100/0107): 「場のカードが手札に戻った時」= カード種を問わない cardReturned も
      // 発火（新イベント・既存カードにリスナー無し＝後方互換。details は複製して汚染を避ける）。
      await runFieldEventTriggers("cardReturned", owner, card, zone, { ...details });
      render();
    }, (error) => {
      console.error(error);
      addLog(`${card?.name ?? "カード"}の復帰誘発の処理中にエラーが発生しました。`);
      render();
    });
}

// E6(D-BT04/0104 戦闘詩人 レポーティング): cause = 捨ての起因（効果op は makeEffectCause／コストstep は
// {byCost,...}。未指定＝ルール由来等は cause 無し）。context.discardCause として誘発へ伝播し、リスナー側は
// 条件op eventDiscardCauseMatches（src/13）で「〜カードの効果で捨てられた時」を照合する。
// cause を照合しない既存の discardedFromHand リスナーは context キーが増えるだけ＝挙動不変。
function queueDiscardedFromHandTriggers(card, owner, cause = null) {
  if (!(card.abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "discardedFromHand")) {
    return;
  }
  scheduleTriggerJob(async () => {
      await runTriggeredAbilities(card, "discardedFromHand", { card, player: state.players[owner], owner, discardCause: cause });
      render();
    }, (error) => {
      console.error(error);
      addLog(`${card.name}の手札破棄時能力の処理中にエラーが発生しました。`);
      render();
    });
}

// 手札のカードをドロップへ送り、「手札から捨てられた時」誘発を発火させる共通経路。
// ここは手札→ドロップの唯一の合流点なので、FE1(D-CBT/0090) の場ブロードキャスト
// ally/opponentHandDiscarded（deckMilled=E5 と同型）もここから1回だけ発火する。
function discardHandCardsToDrop(player, cards, cause = null) {
  const owner = state.players.indexOf(player);
  // E-XB10(X-SS03/0048 シャインブレイド・ジョーカー): 「このターン中、カードの効果で君の手札のカードが
  // 捨てられているなら」用のターン内カウンタ。手札→ドロップの唯一合流点で、効果起因（cause.byEffect）の
  // 捨て枚数のみ席別に加算する。コスト起因（byCost）や単なる移動は含めない＝バディファイトの慣例で
  // 【使用コスト】の捨て札は「効果で捨てられた」に含めない（コストは効果でない）。E8 turnDeckMilled の鏡。
  if (cause?.byEffect && cards.length > 0) {
    state.turnHandDiscardedByEffect ||= [0, 0];
    state.turnHandDiscardedByEffect[owner] = (state.turnHandDiscardedByEffect[owner] || 0) + cards.length;
  }
  cards.forEach((card) => {
    player.drop.push(card);
    queueDiscardedFromHandTriggers(card, owner, cause); // per-card 自己参照（不変）
  });
  // FE1: 手札がドロップに置かれた事実を場のカードへブロードキャスト（バッチ1回・cause は E6 の捨て起因を継承）。
  queueHandDiscardedTriggers(owner, cards, cause);
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
  // 注: X9 の離場置換はここ（ルール処理ドロップ）には配線しない。コール先の明け渡しやサイズ超過処理で
  // カードが残ると上書き消失/無限ループを招くため、既存 Z9(preventNextLeaveFieldCount) と同じく
  // 破壊＋手札戻しのみカバーする（意図的近似・D-BT01実装メモ参照）。
  const lifeLinkNullifiedAtLeave = isAbilitiesNullified(card); // 離場直前に捕捉（能力無効化中はライフリンク無し）
  const typeAtLeave = effectiveCardType(card); // rule-zones-3: 場離れ誘発はこの時点の型で照合
  player.drop.push(...(card.soul || []));
  card.soul = [];
  // ルール処理で場からドロップ＝ソウル札もドロップへ落ちる。破壊経路(destroyFieldCard:505)と同様、裏向き奇襲札の
  // 公開・selfDroppedFromSoul(ヴィーガー等)・奇襲コール権を発火する（冪等・__soulHost/faceDown 札のみ反応）。
  reconcileFaceDownSoulDrops();
  player.drop.push(card);
  player.field[zone] = null;
  // r3 L4(S-UB-C03/0066): destroyFieldCardと同様、裏向きトークンの印字値をドロップ到達時に復元する。
  restoreFaceDownMonsterPrint(card);
  queueMovedToDropTriggers(card, state.players.indexOf(player), "field"); // 効果/ルールで場からドロップへ（自己誘発）
  queueMovedToDropFieldTriggers(card, state.players.indexOf(player), "field"); // E-XB57: 非破壊のドロップ移動→ally/opponentMovedToDrop（場全体）
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, state.players.indexOf(player), { nullifiedAtLeave: lifeLinkNullifiedAtLeave });
  // E10: ルール処理でドロップへ置かれるのも『場を離れる』。他カードの allyLeaveField/opponentLeaveField 放送を
  // 破壊・手札戻し経路と同様に行う（以前はこの経路だけ放送が無く、場離れ誘発が黙って落ちていた）。
  queueLeaveFieldTriggers(card, state.players.indexOf(player), zone, { eventCardTypeAtLeave: typeAtLeave });
  // rule-zones-3: 装備中だけアイテム扱い（変身/搭乗/着任）の型をドロップでは印字の型へ戻す。
  card.currentType = card.baseType || card.type;
  return card;
}

function canUseSoulguard(card) {
  return hasKeyword(card, "soulguard") && (card.soul?.length || 0) > 0 && !soulguardNullifiedFor(card);
}

// Z15(S-UB-C03/0011): 場の継続 nullifySoulguard が card のソウルガードを無効化しているか。
// 既存の ignoreSoulguard（destroy オプション。特定破壊オプションでの一時無視）とは別レイヤで、
// 常時「相手のカード全ての『ソウルガード』を無効化する」型の付与を扱う。
function soulguardNullifiedFor(card) {
  const targetSlot = findFieldCardSlot(card);
  if (!targetSlot) {
    return false;
  }
  return state.players.some((player, sourceOwner) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return activeContinuousEffects(source).some((e) => {
        if (e.op !== "nullifySoulguard") return false;
        if (e.controller === "self" && targetSlot.owner !== sourceOwner) return false;
        if (e.controller === "opponent" && targetSlot.owner === sourceOwner) return false;
        if (e.filter && !matchesCardFilter(card, e.filter)) return false;
        if (e.conditions && !checkCardConditions(e.conditions, sourceOwner, { card: source, zone })) return false;
        return true;
      });
    }),
  );
}

// 「はい/いいえ」の確認を、権威サーバでは該当プレイヤー(owner)へ往復で問う。
// 往復は既存の選択ダイアログ(chooseCardEntries の2択)を再利用するため、サーバ/クライアント
// 双方とも追加の prompt 種別を要しない。ブラウザ（ローカル対戦）はアプリ内の選択UI（スマホ=ドック／PC=モーダル）
// で問う（プレイテスト T8: ネイティブ window.confirm を廃止）。DOM の無いテスト環境だけ従来の window.confirm
// （＝回帰テストは window.confirm 経路のまま挙動不変）。
async function confirmChoiceAsync(owner, message, options = {}) {
  // B3: リプレイ再生中は記録済みの真偽値を返す（UI/往復を出さない）。確認は seam(chooseCardEntries)とは
  // 別種の応答として記録キューに載っているため、ここで消費する（選択応答と混線しない）。
  if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
    // R1: 順序配信。配信を要求順・macrotask 境界に揃える（src/23）。
    return replayPlaybackConfirmAsync();
  }
  // R1: 記録中は応答枠を要求時の step に確保する（追跡オフなら null＝下の従来経路そのまま）。
  const replayTicket = typeof replayReservePrompt === "function" ? replayReservePrompt() : null;
  let answer;
  try {
  if (globalThis.__BUDDYFIGHT_SERVER__ && typeof globalThis.__serverPrompt === "function") {
    // 権威サーバ: 該当プレイヤーへ2択を往復で問う。既存の選択ダイアログ往復を再利用するが、記録は
    // 「確認応答(真偽値)」へ一本化するため、記録フック付きの chooseCardEntries ではなく素の Impl を呼ぶ
    // （seam に選択として二重記録させない）。再生時は上の replayNextConfirm で {confirm} を消費する。
    const selected = await chooseCardEntriesImpl(
      [
        { key: "yes", card: { name: options.yesLabel || "使う", rules: [], attributes: [], keywords: [], costs: {} } },
        { key: "no", card: { name: options.noLabel || "使わない", rules: [], attributes: [], keywords: [], costs: {} } },
      ],
      { title: message, lead: options.lead || "", min: 1, max: 1, forceDialog: true, allowCancel: false, promptSeat: owner },
    );
    answer = selected?.[0]?.key === "yes";
  } else if (typeof aiShouldAnswerPrompt === "function" && aiShouldAnswerPrompt(owner)) {
    // CPU対戦: CPU席宛の確認は src/22-ai.js が答える（window.confirm を人間に出さない）。
    answer = await aiAnswerConfirm(owner, message, options);
  } else if (typeof appChoiceUiAvailable === "function" && appChoiceUiAvailable()) {
    answer = await showConfirmChoiceDialog(message, options);
  } else if (typeof window !== "undefined" && typeof window.confirm === "function") {
    answer = window.confirm(message);
  } else {
    answer = options.defaultAnswer ?? true;
  }
  } catch (error) {
    if (replayTicket) replayAbandonPrompt(replayTicket);
    throw error;
  }
  if (replayTicket) {
    return replayDeliverPrompt(replayTicket, answer, replayConfirmResponse);
  }
  // B3: 記録中なら確認応答として控える（ローカル/サーバ/CPU いずれの経路も同一キューへ一本化）。
  if (typeof replayRecordConfirm === "function") {
    replayRecordConfirm(answer);
  }
  return answer;
}

async function shouldUseSoulguard(card, owner) {
  const useSoulguard = await confirmChoiceAsync(owner, `${card.name}の『ソウルガード』を使いますか？`, { purpose: "soulguard" });
  if (!useSoulguard) {
    addLog(`${card.name}の『ソウルガード』を使いませんでした。`);
  }
  return useSoulguard;
}

// rule-zones-1: ver2.05 ④『ソウルガード』「場から離れる場合、ソウル１枚をドロップゾーンに置くことで場に残すことが
// できます。『ソウルガード』は置換効果です。」＝破壊に限らず、効果による手札戻し・デッキ/ゲージ/ドロップ置きでも使える。
// destroyFieldCard（破壊）と同じ確認・ソウル選択（2枚以上なら持ち主が選ぶ）を行う。true=場に残った（または確認中に
// 既に場を離れた）＝呼び出し側は移動しない。コストの支払い・★ルール処理★による移動では呼ばない（置換するとコスト/
// ルール処理そのものが成立しなくなるため。裁定未確認の範囲は従来どおり）。
async function trySoulguardOnLeave(card, owner, zone) {
  const player = state.players[owner];
  if (!card || !player || player.field[zone] !== card || !canUseSoulguard(card)) {
    return false;
  }
  if (!(await shouldUseSoulguard(card, owner))) {
    return false;
  }
  if (player.field[zone] !== card) {
    return true;
  }
  if (!canUseSoulguard(card)) {
    return false;
  }
  let soulCard;
  if (card.soul.length > 1) {
    const picked = await chooseCardEntries(
      card.soul.map((soul) => ({ card: soul })),
      {
        title: "ソウルガード：ドロップに置くソウルを選ぶ",
        lead: `${card.name}のソウルから、ドロップに置く1枚を選んでください。`,
        min: 1,
        max: 1,
        forceDialog: true,
        allowCancel: false,
        promptSeat: owner,
      },
    );
    if (player.field[zone] !== card) {
      return true;
    }
    const pickedId = picked?.[0]?.card?.instanceId;
    const idx = card.soul.findIndex((soul) => soul.instanceId === pickedId);
    soulCard = idx >= 0 ? card.soul.splice(idx, 1)[0] : card.soul.pop();
  } else {
    soulCard = card.soul.pop();
  }
  if (!soulCard) {
    return false;
  }
  player.drop.push(soulCard);
  addLog(`${card.name}はソウルガードで場に残りました。`);
  queueSoulCardDroppedTriggers(card, owner, 1);
  return true;
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

// options.nullifiedAtLeave: 場を離れる直前に isAbilitiesNullified(card) が真だったか。ライフリンクはキーワード由来の
// 能力なので能力無効化(凍てつく星辰等)で消える（第7回#3の裁定）。applyLifeLink の時点では card は既に場外で
// isAbilitiesNullified が false になるため、各離場サイトが「離れる直前の値」を捕捉して渡す。破壊経路
// (destroyFieldCard:552)は従来どおり呼び出し自体をゲートしており、非破壊離場もこのオプションで同基準に揃える
// （第12回メカレビュー: 破壊だけ抑止・非破壊は発動という剥奪の非対称を是正）。
function applyLifeLink(card, owner, options = {}) {
  if (options.nullifiedAtLeave) {
    return null; // 能力無効化中＝ライフリンク自体が無い（破壊経路の非呼び出しと同じ扱い＝イベントも記録しない）
  }
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
  // 対抗窓改修(rule-damage-4・rule-keywords-10): 「『ライフリンク』に対して【対抗】を使用することができます」。
  // ライフリンクは常に待機キュー（攻撃の破壊〜貫通の間は battleTriggerHold）へ積み、他の誘発と同じ
  // 順序規則（ターンファイター優先・能力本体の解決後）で解決する。窓を開くか（＝使える【対抗】を持つ席がいるか）は
  // 解決時の判定だけに使い、ダメージの順序は手札の中身に左右されない（独立レビュー H1: 勝者反転の是正）。
  // 保留中は勝敗が決まらない。打ち消し系は保留中のイベントを直接打ち消せる。
  deferLifeLinkForCounterWindow(card, owner, event, { amount, instantDefeat });
  return event;
}

// 保留したライフリンクの解決（ダメージ/即敗北の適用）。
function applyLifeLinkDamageNow(card, owner, event, { amount, instantDefeat }, damageOptions = { log: false }) {
  if (instantDefeat) {
    // E-XB1(X-BT02/0113): 「ファイトに敗北しない」保護中は即死ライフリンクでも敗北しない
    //（一度免れた即死は再誘発しない＝期限失効後の checkWinner はライフ0/デッキ0 のみ再判定する）。
    if (isSeatLossPrevented(owner)) {
      addLog(`${state.players[owner].name}は「ファイトに敗北しない」効果により、${card.name}の即死ライフリンクによる敗北を免れています。`);
      return event;
    }
    if (!state.winner) {
      state.winner = state.players[1 - owner]?.name || null;
      state.winnerSeat = 1 - owner; // D5(戦績): ライフリンクによる即敗北（効果起因）
      state.winReason = "effect";
    }
    addLog(`${card.name}のライフリンクにより${state.players[owner].name}は敗北しました。`);
    return event;
  }
  // 継続 reduceLifeLinkDamage による軽減（護竜王 0111「filter一致カードのライフリンクで受けるダメージをN減らす」）。
  amount = Math.max(0, amount - lifeLinkDamageReductionFor(owner, card));
  event.amount = amount;
  event.appliedDamage = amount > 0 ? applyDamageToPlayer(owner, amount, damageOptions) : 0;
  if (amount > 0) {
    addLog(`${card.name}のライフリンクにより${state.players[owner].name}に${amount}ダメージ。`);
  }
  return event;
}

// 保留したライフリンクを待機キュー（攻撃の破壊〜貫通の間は battleTriggerHold）へ積む。解決時に
// ターンファイター→非ターンファイターの順で（各自、使える【対抗】がある時だけ）窓を開き、打ち消されていなければ適用する。
function deferLifeLinkForCounterWindow(card, owner, event, { amount, instantDefeat }) {
  event.pending = true;
  const job = async () => {
    let announced = false;
    try {
      const turnSeat = state.active === 0 || state.active === 1 ? state.active : owner;
      for (const seat of [turnSeat, 1 - turnSeat]) {
        if (event.canceled || state.winner) {
          break;
        }
        const options = counterWindowOptionsIfOpen(seat, card?.instanceId ? [card.instanceId] : null);
        if (!options) {
          continue;
        }
        if (!announced) {
          announced = true; // 窓が実際に開く時だけ告知する
          addLog(`${card.name}のライフリンクが発動しました（【対抗】の確認後に解決します）。`);
        }
        const shown = Math.max(0, amount - lifeLinkDamageReductionFor(owner, card));
        await runCounterWindowFor(seat, options, {
          kind: "lifeLink",
          sourceName: card.name,
          sourceInstanceId: card.instanceId || null,
          sourceOwner: owner,
          damagedSeat: owner,
          damage: instantDefeat ? null : shown,
          instantDefeat,
          lead: instantDefeat
            ? `${card.name}のライフリンク（即死）で${state.players[owner].name}は敗北します。先に【対抗】を使えます。`
            : `${card.name}のライフリンクで${state.players[owner].name}は${shown}ダメージを受けます。先に【対抗】を使えます。`,
        });
      }
    } finally {
      event.pending = false;
    }
    if (event.canceled) {
      return; // 打ち消し（cancelRecentLifeLink 等）は保留中のイベントを直接打ち消す＝ダメージは発生しない
    }
    // 決着後でもダメージ自体は適用する（従来の同期適用と同じ。勝者は先に確定した側のまま＝checkWinner は上書きしない）。
    // 任意コスト付きの軽減（メラク等）は、適用の前に本人へ非同期で問う（要らなければ await しない＝tick 不変）。
    const lifeLinkDamageOptions = { log: false };
    if (!instantDefeat) {
      const reducedAmount = Math.max(0, amount - lifeLinkDamageReductionFor(owner, card));
      if (reducedAmount > 0 && damageNeedsAsyncDecision(owner, reducedAmount, lifeLinkDamageOptions)) {
        await prepareDamageDecisions(owner, reducedAmount, lifeLinkDamageOptions);
      }
    }
    applyLifeLinkDamageNow(card, owner, event, { amount, instantDefeat }, lifeLinkDamageOptions);
    render();
  };
  const onError = (error) => {
    console.error(error);
    addLog(`${card.name}のライフリンクの処理中にエラーが発生しました。`);
    render();
  };
  if (battleTriggerHold) {
    holdBattleTriggerRunner(() => job().catch(onError), owner);
    return;
  }
  scheduleTriggerJob(job, onError, owner);
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
  // E5'(D-EB03/0043): matchInstanceIds があれば、そのインスタンスのイベントに限定する
  // （空配列は「一致なし」＝取消 no-op。直前に戻したカード以外の同ターンイベントの誤取消を防ぐ）。
  // 無指定（従来のカード全て）は従来挙動＝後方互換。
  if (Array.isArray(spec.matchInstanceIds) && !spec.matchInstanceIds.includes(event.cardInstanceId)) {
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
  addLog(`${sourceName || event.cardName}の効果で${event.cardName}のライフリンクを打ち消しました。`);
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
  addLog(`${sourceName || event.cardName}の効果で${event.cardName}のライフリンクを打ち消しました。`);
  return event;
}

function clearWinnerIfNoCurrentLoss() {
  if (!state.winner) {
    return;
  }
  // 巻き戻せるのはライフ0/デッキ0 由来の暫定敗北だけ。効果による確定敗北（winGame の "effect"・
  // E-XB32 予約敗北の "scheduledLoss"）はライフ/デッキ条件で表せないため、ここで誤って解除しない
  // （winReason が life/deckout 以外なら即 return）。既存の巻き戻し経路は winReason が常に life/deckout の
  // 場面でのみ呼ばれるため挙動不変（防御的な追加ガード）。
  if (state.winReason && state.winReason !== "life" && state.winReason !== "deckout") {
    return;
  }
  // E-XB1(X-BT02/0113): 「ファイトに敗北しない」保護中の席は現在の敗北条件に数えない
  // （checkWinner のゲートと同じ判定。未設定時は isSeatLossPrevented=false ＝従来と完全一致）。
  const stillLost = state.players.some(
    (player, index) => (player.life <= 0 || player.deck.length === 0) && !isSeatLossPrevented(index),
  );
  if (!stillLost) {
    state.winner = null;
    state.winnerSeat = null; // D5(戦績): 巻き戻し時は勝者席・理由も消す（決着フックは pending 解消後に再判定）
    state.winReason = null;
  }
}

// E-XB1(X-BT02/0113 アステリズム・エフェクト): 席 seat が「ファイトに敗北しない」保護下にあるか。
// state.lossPrevention[seat] に有効エントリがあれば true。敗北確定点（checkWinner の life<=0/deck0・
// declareDeckLoss・applyLifeLink の即死ライフリンク）がこれを見て、保護中の席の敗北を保留する。
// 保護は endTurn の expireLossPreventionForTurnStart が「相手ターン開始時」に必ず除去する（延命ループ無し）。
// 未設定（従来の全カード/セーブ）は optional chaining で false ＝敗北判定はバイト単位で従来一致。
function isSeatLossPrevented(seat) {
  return (state?.lossPrevention?.[seat]?.length || 0) > 0;
}

// E-XB1: ターン境界（endTurn）で「次の相手ターンの開始時まで」保護の期限を判定して除去する。
// untilTurnStartOf（＝保護席の相手）が active になり、かつ turnCount が付与時より真に進んだ最初の
// ターン開始時に失効する（付与が相手ターン中の【対抗】でも、現ターンでは失効せず次の相手ターンで失効）。
// 除去が起きたら checkWinner を再実行し、ライフ0/デッキ0 のまま延命していた席をその場で敗北確定させる。
function expireLossPreventionForTurnStart() {
  if (!Array.isArray(state.lossPrevention)) {
    return;
  }
  let expired = false;
  state.lossPrevention.forEach((entries, seat) => {
    const list = Array.isArray(entries) ? entries : [];
    const kept = list.filter(
      (entry) => !(state.active === entry.untilTurnStartOf && state.turnCount > entry.sinceTurnCount),
    );
    if (kept.length !== list.length) {
      expired = true;
    }
    state.lossPrevention[seat] = kept;
  });
  if (expired) {
    checkWinner();
    // E-XB32: 保護失効で「期限到来済みだが保留中(due)」の予約敗北を再判定して確定させる。
    applyDueScheduledLosses();
  }
}

// E-XB32(X-BT04/0002 ドラゴウーノ): 「次の君のターン終了時、君はファイトに敗北する」の確定点。
// finishAndAdvanceTurn がターン終了処理の中で endingOwner を渡して呼ぶ。予約席の自ターン終了時
// （turnCount>sinceTurnCount）に発火する。lossPrevention(E-XB1)で保護中なら消費せず due:true を立てて保留し、
// 保護失効時に applyDueScheduledLosses が再判定する。既存対戦は scheduledLoss が常に null＝この関数は素通り。
function maybeApplyScheduledLoss(endingOwner) {
  const entry = state.scheduledLoss?.[endingOwner];
  if (!entry) {
    return;
  }
  // 「次の」君のターンに限定（予約した相手ターン中は endingOwner!=seat で来ないが、防御的に真に大なりで判定）。
  if (!(state.turnCount > entry.sinceTurnCount)) {
    return;
  }
  if (isSeatLossPrevented(endingOwner)) {
    entry.due = true; // 期限到来済み・保護解除待ち（消費しない）。
    return;
  }
  state.scheduledLoss[endingOwner] = null; // 消費（ワンショット）。
  applyScheduledLossNow(endingOwner);
}

// E-XB32: 保護が外れた「due(期限到来済み)」の予約敗北を確定させる（expireLossPreventionForTurnStart から呼ぶ）。
function applyDueScheduledLosses() {
  if (!Array.isArray(state.scheduledLoss)) {
    return;
  }
  state.scheduledLoss.forEach((entry, seat) => {
    if (entry && entry.due && !isSeatLossPrevented(seat)) {
      state.scheduledLoss[seat] = null;
      applyScheduledLossNow(seat);
    }
  });
}

// E-XB32: 予約敗北の実行（seat がファイトに敗北＝相手の勝ち）。winReason="scheduledLoss" は
// clearWinnerIfNoCurrentLoss で巻き戻らない確定敗北（ライフ/デッキ条件では表せないため）。
function applyScheduledLossNow(seat) {
  if (state.winner) {
    return; // 既に決着済み。
  }
  state.winner = state.players[1 - seat]?.name || null;
  state.winnerSeat = 1 - seat;
  state.winReason = "scheduledLoss";
  addLog(`${state.players[seat]?.name}は効果でファイトに敗北しました。`);
}

async function endTurn() {
  if (state.winner || hasPendingResolution()) {
    return;
  }
  if (state.phase !== "final") {
    addLog("ターン終了はファイナルフェイズの終了時に行います。");
    return;
  }
  await finishAndAdvanceTurn();
}

// E-XB42(X-BT04/0099 endCurrentTurn): 効果op が立てた「現在ターン終了」予約を、解決チェーンが完全にアンワインドした
// 地点で1回だけ消費し、現在のターン(state.active)を終える。効果解決の途中で finishAndAdvanceTurn を直接呼ぶと、
// 呼び出し元(resolvePendingAttack/executeAbilityBody 等)の後続処理がターン交代後の state を前提外に触る／turnEnd 誘発が
// 再入する恐れがあるため、endFinalPhase(pendingEndTurn) と同じ「予約フラグ→unwind 点でドレイン」方式を一般化する。
// endTurn の final フェイズ入口ガードは通さず finishAndAdvanceTurn へ直行する（相手ターン中の counter/main 起動でも
// 「そのターン」を終える）。消費点は resolvePendingResolution(07) の finally と各起動能力アクション(13) の末尾。
// hasPendingResolution/resolvingPending が真の間はまだ解決中＝終了を保留し、外側の unwind 点で再試行する。
// 予約が無ければ即 return＝endCurrentTurn 未使用の全既存経路は完全に不変（後方互換）。
async function maybeEndPendingCurrentTurn() {
  if (!state.pendingCurrentTurnEnd) {
    return;
  }
  if (state.winner) {
    // 決着済みなら予約は無効化（勝敗確定が優先・次ターンへ持ち越さない）。
    state.pendingCurrentTurnEnd = false;
    return;
  }
  if (hasPendingResolution() || state.resolvingPending) {
    // まだ解決チェーンの途中＝ここでは終了せず保留（外側の unwind 点で再試行する）。
    return;
  }
  state.pendingCurrentTurnEnd = false; // 消費（finishAndAdvanceTurn 呼び出し前にクリア＝再入時の二重発火防止）
  await finishAndAdvanceTurn();
}

// endTurn の本体（ターン終了処理→次ターンへ遷移→新ターン設定）。入口ガード(phase/winner/pending)は endTurn 側。
// E-XB28(X-BT03/0102 逆天③): ターンスキップ予約の消費が「開始したターンを即終了して次へ」を表すため、
// スキップ時はこの関数を末尾で再帰呼び出しする。予約は消費型ワンショット（消費前に null 化＝再帰は予約数=最大2席で
// 必ず停止・無限延命/再帰スキップなし）。既存対戦では予約が常に空＝再帰せず従来と完全に同一（後方互換）。
async function finishAndAdvanceTurn() {
  expireTransientResponseWindows();
  const endingOwner = state.active;
  await runPhaseStartTriggers("turnEnd", endingOwner);
  await runEndTurnEffects(state.active);
  // E-XB32(X-BT04/0002 ドラゴウーノ): 「次の君のターン終了時、君はファイトに敗北する」。ターン終了処理の一環として
  // 予約敗北を確定する（保護中なら保留＝maybeApplyScheduledLoss 内で判定）。既存対戦は scheduledLoss=null で素通り。
  maybeApplyScheduledLoss(endingOwner);
  clearDamagePreventionForTurn(endingOwner);
  clearTurnModifiers();
  state.monsterAttackForbidden = [false, false];
  state.monsterAttackForbiddenSources = [[], []];
  state.fieldAttackBanThisTurn = [false, false]; // E-XB28: 「このターン中、場のカードは攻撃できない」を境界でクリア
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
  state.counterWindowPass = [null, null]; // 対抗窓改修: 「このターンはパス」はターン終了まで
  standPlayer(activePlayer());
  state.phase = "draw";
  state.selected = null;
  state.counterHandOwner = null;
  state.chargedThisTurn = false;
  state.drewThisTurn = false;
  state.attacksThisTurn = 0;
  state.attacksThisTurnBySeat = [0, 0]; // E-XB40(X-BT04/0008): 席別攻撃回数を attacksThisTurn と同時リセット
  // Z6(S-UB-C03/0054): endFinalPhase の保留フラグは通常はファイナルフェイズ解決で消費済みだが、
  // 勝敗確定等で消費されず残った場合に次ターンへ持ち越さないよう、ターン境界で明示クリアする（防御的）。
  state.pendingEndTurn = false;
  // E-XB42(X-BT04/0099 endCurrentTurn): 現在ターン終了予約も同様に境界でクリア。通常は maybeEndPendingCurrentTurn が
  // 消費するが、勝敗確定やドレイン点未到達で残った場合に次ターンへ漏らさない（防御的・後方互換=通常は常に false）。
  state.pendingCurrentTurnEnd = false;
  state.attackDestroyedByAttribute = [{}, {}]; // 属性別の攻撃撃破数(このターン)をリセット
  state.destroyedCardsThisTurn = [[], []]; // このターン破壊されたカード記録(destroyedThisTurnMatchingCountGte用)をリセット
  syncMonstersDestroyedThisTurn(); // monstersDestroyedThisTurn は destroyedCardsThisTurn からの導出（リセットで[0,0]になる）
  state.destroyedByOwnerThisTurn = [0, 0]; // E-XB70(X2-SP/0044): 破壊者席別のターン内モンスター破壊数もターン境界でリセット
  state.calledCardNamesThisTurn = [{}, {}]; // 「1ターンにN枚だけコール」(竜騎士 トモエ 0012 等)のカウンタをリセット
  state.impactMonsterCallsThisTurn = [0, 0]; // 必殺モンスター「1ターンに1枚」コール数をリセット
  state.callsThisTurn = [0, 0]; // E-XB7(X-SS03/0060): ターン内の総コール枚数（席別）をリセット
  state.suppressLifeLinkThisTurn = [false, false]; // ライフリンク無効化(ターンスコープ)をリセット
  state.attackRedirectThisTurn = [null, null]; // 攻撃再誘導(ターンスコープ)をリセット
  state.opponentCounterLockThisTurn = []; // 対抗ロック(ターンスコープ)をリセット
  state.turnDestroyImmunity = []; // ターン限定の破壊耐性(対抗フォースフィールド等)をリセット
  // Z4(e)(S-UB-C03/0043): ターン限定保護(state.turnProtections)は remainingTurnEnds を1減算し、
  // 0以下になったエントリのみ除去する（turns:2＝ターン終了2回分＝そのターン＋次のターン中、が保持される）。
  state.turnProtections = (state.turnProtections || [])
    .map((entry) => ({ ...entry, remainingTurnEnds: (entry.remainingTurnEnds ?? 1) - 1 }))
    .filter((entry) => entry.remainingTurnEnds > 0);
  // FE2(X-BT01/0124 ガエン): ドロー禁止(state.drawBans)も turnProtections と同じく毎ターン端で1減算。
  // remainingTurnEnds:2 で設定＝発動側の残りターン端(→1)＋相手の次ターン端(→0で除去)＝「次の相手のターン中」限定。
  state.drawBans = (state.drawBans || [])
    .map((entry) => ({ ...entry, remainingTurnEnds: (entry.remainingTurnEnds ?? 1) - 1 }))
    .filter((entry) => entry.remainingTurnEnds > 0);
  // Z4(f)(S-UB-C03/0051): ターン限定ダメージ軽減は毎ターン全消去（turnDestroyImmunityと同様、多ターン持続なし）。
  state.turnDamageReductions = [];
  state.lastDamageTaken = [0, 0];
  state.turnDamageEvents = []; // 「武器がダメージを与えたターン中」判定用の蓄積をターン境界でクリア
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  // E-XB1(X-BT02/0113): 新しいターンの開始時点（active/turnCount 更新後）で「ファイトに敗北しない」保護の
  // 期限を判定し、失効した席がライフ0/デッキ0 のまま延命していればその場で敗北を確定させる（延命ループ防止）。
  expireLossPreventionForTurnStart();
  addLog(`${activePlayer().name}のターンです。`);
  // E5: ターン限定のサイズ修整が切れた後の★ルール処理★（両ファイターのサイズ超過を再検査）。
  await runSizeRuleProcessing();
  // E-XB28: 新しく開始した席に「攻撃禁止」予約があれば、このターンへ適用する（スキップ後に来る使用者のターン）。
  // fieldAttackBanThisTurn は直上のクリア後に立てるため、このターン限定で効き、次のターン境界で失効する。
  if (state.scheduledAttackBan?.[state.active]) {
    state.scheduledAttackBan[state.active] = false;
    state.fieldAttackBanThisTurn ||= [false, false];
    state.fieldAttackBanThisTurn[state.active] = true;
    addLog(`${activePlayer().name}の場のカードはこのターン攻撃できません。`);
  }
  // E-XB28: 新しく開始した席にターンスキップ予約があれば、そのターンを即終了して次へ（ドロー/チャージ/行動なし）。
  const skipEntry = state.scheduledTurnSkip?.[state.active];
  if (!state.winner && skipEntry) {
    const skippedSeat = state.active;
    state.scheduledTurnSkip[skippedSeat] = null; // 消費（ワンショット）
    // 「次の君のターン中、君の場のカードは攻撃できない」＝スキップされた席の直後に来る使用者(schedulerSeat)の
    // ターンへ攻撃禁止を予約する（この下の再帰で使用者ターンが設定される際に上の分岐で適用される）。
    const schedulerSeat = Number.isInteger(skipEntry.schedulerSeat) ? skipEntry.schedulerSeat : 1 - skippedSeat;
    state.scheduledAttackBan ||= [false, false];
    state.scheduledAttackBan[schedulerSeat] = true;
    addLog(`${state.players[skippedSeat].name}のターンは効果で開始時に終了しました。`);
    await finishAndAdvanceTurn(); // スキップされたターンを即終了して次の席へ（再帰は消費で必ず停止）
    return; // 再帰側が最終 render 済み
  }
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
      // 裁定2026-10-08「誰のターンと書かれていなければ両方のターン」: 印字『■ターン終了時、このカードを破壊する。』
      // (旧レガシー1枚キー destroyAtEndOfTurn:true＝BT02/0040・0060)は、場にある限り両者のターン終了時に誘発する
      // 自動能力。登場時に立てる destroyAtEndOfTurnOwner(=コール者のターン)だけだと、相手ターン中に場へ出た場合や
      // ソウルガード等で場に残った後に二度と破壊されなかった。能力無効化中は誘発しない（自動能力）。
      // コール者のターン終了時の既存経路（destroyAtEndOfTurnOwner）は従来どおり。
      const printedTurnEndDestroy =
        card?.destroyAtEndOfTurn === true && typeof isAbilitiesNullified === "function" && !isAbilitiesNullified(card);
      if (card?.destroyAtEndOfTurnOwner === endingOwner || printedTurnEndDestroy) {
        const destroyedName = card.name;
        card.destroyAtEndOfTurnOwner = null;
        // rule-zones-2: 予約された「ターン終了時に破壊」もソウルガードで場に残せる（離場の原因を問わない置換効果）。
        // pt-fix-c T7-2: 「ターン終了時、破壊する」も効果による破壊＝cause を渡す（「カードの効果で破壊された時」用）。
        const destroyed = await destroyFieldCard(owner, zone, {
          cause: {
            byEffect: true,
            byOpponent: false,
            sourceOwner: owner,
            sourceType: printedTurnEndDestroy ? effectiveCardType(card) : null,
            sourceCard: printedTurnEndDestroy ? card : null,
          },
        });
        if (destroyed) {
          addDestroyLog(`${destroyedName}はターン終了時の効果で破壊されました。`, destroyedName);
        }
      } else if (
        card?.putToGaugeAtEndOfTurnOwner != null &&
        (card.putToGaugeAtEndOfTurnTurn ?? card.putToGaugeAtEndOfTurnOwner) === endingOwner
      ) {
        // 「ターン終了時、そのモンスターを君のゲージに置く」。ソウルはドロップへ、本体をゲージへ。
        // 裁定2026-10-08: 効果が作る遅延の『ターン終了時』（誰のターンか書かれていない）は予約したそのターンの終了時。
        // putToGaugeAtEndOfTurnTurn＝予約時の state.active（未設定の旧 state は従来どおり送り先＝予約者のターン）。
        const destOwner = card.putToGaugeAtEndOfTurnOwner;
        card.putToGaugeAtEndOfTurnOwner = null;
        card.putToGaugeAtEndOfTurnTurn = null;
        if (destOwner === owner) {
          // E9: 正規の離場→ゲージ経路へ委譲（ソウルのドロップ送り＋reconcileFaceDownSoulDrops・着任解除・
          // ライフリンク・場離れ放送・『ゲージにカードが置かれた時』(byEffect=queueGaugePlacedTriggers)込み）。
          // 以前は手書きの移動でライフリンク/場離れ誘発/裏向きソウル処理/着任解除を取りこぼしていた。
          // rule-zones-1: 効果によるゲージ置きも場を離れる＝ソウルガード（置換効果）で場に残せる。
          if (!(await trySoulguardOnLeave(card, owner, zone))) {
            putFieldCardToGauge(player, zone, { byEffect: true });
          }
        } else {
          // 他人の場のカードを自分のゲージへ置く予約（現行カードデータには無い）。従来どおりの移動を保持する。
          player.field[zone] = null;
          if ((card.soul || []).length > 0) {
            player.drop.push(...card.soul);
            card.soul = [];
          }
          state.players[destOwner].gauge.push(card);
          queueGaugePlacedTriggers(destOwner, [card]); // 相手のゲージにカードが置かれた時（0020）
        }
        addLog(`${card.name}はターン終了時の効果でゲージに置かれました。`);
      }
    }
  }
}

function clearTurnModifiers() {
  state.deferredMultiAttackStands = []; // E3: 保留中の多回攻撃スタンドはターンを跨がない
  // E3: 能力本体の入れ子深さ（実行時の一時値）もターン境界で 0 に戻す。応答の来ない選択待ち等で深さが
  // 戻らなかった場合に、以降の多回攻撃スタンドが永久に保留され続けないための安全弁（通常は既に 0）。
  if (typeof abilityBodyDepth === "number") {
    abilityBodyDepth = 0;
    if (typeof triggerResolutionHold === "number") {
      triggerResolutionHold = 0; // 同じ安全弁（応答の来ない選択待ち等で深さが戻らなかった場合）
    }
    kickTriggerDriver(); // 対抗窓改修: 深さを戻したら待たせていた誘発を流す（通常はキュー空＝no-op）
  }
  state.spiritStrikeDamageBonus = [0, 0]; // 霊撃ブースト（ターンスコープ）をリセット
  state.standedByEffectThisTurn = [[], []]; // E-PR16(PR/0470): このターン効果でスタンドしたカード履歴をリセット
  state.movedThisTurn = [[], []]; // E-XB69(X2-SP/0014,0027): このターン『移動』したモンスターの席別 instanceId 履歴をリセット
  state.turnDeckMilled = [0, 0]; // E8(D-CBT/PR-0330): ターン内デッキ→ドロップ ミル枚数(席別)をリセット
  state.gaugePlacedThisTurn = [0, 0]; // E-XB12(X-CP03/0069): ターン内ゲージ流入枚数(席別)をリセット
  state.turnDamageTaken = [0, 0]; // E-X2(X-SD02/0016): ターン内被ダメージ(席別)をリセット
  state.spellsCastThisTurn = [0, 0]; // E-XB9(X-SS03/0017): ターン内魔法使用回数(席別)をリセット
  state.turnHandDiscardedByEffect = [0, 0]; // E-XB10(X-SS03/0048): ターン内「効果で捨てられた手札枚数」(席別)をリセット
  state.nextAllyAttackTriggers = []; // E10(D-CBT/0110): 「そのターン中、次の味方攻撃時」ワンショット予約を破棄
  state.callRestrictionsThisTurn = []; // X6(D-BT01/0064): ターン限定コール制限をリセット
  state.callCountCapsThisTurn = []; // E-XB7(X-SS03/0060): ターン内総コール枚数キャップをリセット
  state.turnFlagNameAliases = [[], []]; // E12(D-SS02/0005): ターン限定フラッグ名エイリアスをリセット
  state.phaseCallRights = null; // grantPhaseCallRight（フェイズ中のコール権）はターンを跨がない
  state.turnNullifies = []; // E2(D-SS03/0010): ターン限定の全体能力無効化(nullifyFieldAbilities)をリセット
  state.turnDetachedContinuous = []; // 離場した発生源から退避した「そのターン中」継続をリセット
  state.turnPlayerContinuous = [[], []]; // E-XB64(X2-BT01/0052): プレイヤー単位のターン限定継続（匿名アンカー・魔法発）をリセット
  state.turnSourcedContinuous = [[], []]; // 監査 rule-continuous-1: 発生源から切り離したターン限定継続（addTurnContinuous）をリセット
  // X11b(D-BT01/0131): ターンスコープのサイズ上書き(setConditionalSizeScope turnScoped)と
  // X19 ターン限定継続(turnContinuous)を解除。
  state.players.forEach((player) => {
    zones.forEach((zone) => {
      const fieldCard = player.field?.[zone];
      if (fieldCard?.conditionalSize?.turnScoped) {
        fieldCard.conditionalSize = null;
      }
      if (fieldCard?.turnContinuous) {
        fieldCard.turnContinuous = null;
      }
    });
  });
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
      restoreTurnCopiedCardFields(card); // カード単位フィールドで得た能力（destroyImmunity 等）を元へ戻す
      if (card?.turnKeywords?.length && !zones.some((zone) => player.field[zone] === card)) {
        card.turnKeywords = []; // 場を離れたカードに残ったターンスコープキーワードの残留防止
      }
      // E-PR11/E-PR12: 場を離れたカードに残った一時付与（トリガー能力/攻撃耐性）の残留防止（turnKeywords と同型）。
      if (card?.grantedTempAbilities?.length && !zones.some((zone) => player.field[zone] === card)) {
        card.grantedTempAbilities = [];
      }
      if (card?.grantedTempAttackResistances?.length && !zones.some((zone) => player.field[zone] === card)) {
        card.grantedTempAttackResistances = [];
      }
      // E-PR15(PR/0461): 場を離れたカードに残った一時ワールド付与（turnWorlds）の残留防止（turnKeywords と同型）。
      if (card?.turnWorlds?.length && !zones.some((zone) => player.field[zone] === card)) {
        card.turnWorlds = [];
      }
      // E-PR17(PR/0478): 場を離れたカードに残った一時破壊耐性（grantedTempDestroyImmunities）の残留防止。
      if (card?.grantedTempDestroyImmunities?.length && !zones.some((zone) => player.field[zone] === card)) {
        card.grantedTempDestroyImmunities = [];
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
    player.nextSpellCostMayUseOpponentGauge = false; // E-XB73(X2-SP/0041): 魔法【使用コスト】用の相手ゲージ許可もターン終了で失効
    player.setLockedIdsThisTurn = []; // 「そのターン中は『設置』できない」ロック(発進準備OK！等)をターン終了で解除
    player.setLockedNamesThisTurn = []; // audit2(b010-2): 名前単位の設置ロックも同時に解除
    zones.forEach((zone) => {
      const card = player.field[zone];
      if (card) {
        card.turnPowerBonus = 0;
        card.turnDefenseBonus = 0;
        card.turnCriticalBonus = 0;
        card.turnKeywords = [];
        card.turnSuppressedKeywords = [];
        // E-PR11(PR/0389)/E-PR12(PR/0381): そのターン中だけ付与した一時トリガー能力/攻撃耐性をターン終了で解除
        //（turnKeywords と同寿命。場のカードはここ、場外に残ったカードは下の全パイル走査で掃除）。
        card.grantedTempAbilities = [];
        card.grantedTempAttackResistances = [];
        card.turnWorlds = []; // E-PR15(PR/0461): 一時ワールド付与をターン終了で解除（turnKeywords と同寿命）
        card.grantedTempDestroyImmunities = []; // E-PR17(PR/0478): 一時破壊耐性をターン終了で解除（turnKeywords と同寿命）
        card.preventNextDestroyCount = 0;
        card.preventNextDestroyEffects = []; // 未発火の破壊置換effect(反撃付与等)が翌ターンへ残留しないようクリア
        card.cannotAttackThisTurn = false; // 「そのターン中攻撃できない」(グレイプニル等)をターン終了で解除
        if (card.cannotAttackThisTurnSources) card.cannotAttackThisTurnSources = [];
        card.cannotStandThisTurn = false; // Z14(g)(S-UB-C03/0038): 「そのターン中スタンドできない」をターン終了で解除
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
  // E-XB54b(X-UB03/0019 ∞ the Chaos ∞ ＝攻撃するフラッグ): 攻撃したフラッグは他のカードと同じくレスト(used=true)
  // し、自分のスタートフェイズにスタンドする。フラッグは player.field ではなく player.flag に実体があり zones 走査に
  // 乗らないため、ここで明示的にスタンドする。used=true になるのは攻撃したフラッグ（＝infinity-the-chaos）だけで、
  // 通常フラッグは決して used にならない＝既存の全対戦ではこのブロックは何もしない（バイト不変）。
  if (player.flag?.type === "flag" && player.flag.used) {
    player.flag.used = false;
    player.flag.battlePowerBonus = 0;
    player.flag.battleDefenseBonus = 0;
    player.flag.battleCriticalBonus = 0;
    player.flag.counterattack = false;
    player.flag.doubleAttackUsed = false;
    player.flag.tripleAttackStandCount = 0;
    delete player.flag.multiAttackUses; // rulings-e: 『Ｎ回攻撃』の N 別使用回数（src/10 standAttackerForMultiAttack）
  }
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
      delete card.multiAttackUses; // rulings-e: 『Ｎ回攻撃』の N 別使用回数もターン開始でリセット
    }
  });
}

// FE1(X-BT01/0128 ドラゴン・ドライ rule③): プレイヤーのフラッグを試合中に flagId のフラッグ定義へ差し替える。
// player.flag は state 常駐（room 復元/リプレイの JSON 往復で保たれる）。以後 flagNameIs・canUseCardForFlag・
// フラッグ表示(12-render)が新フラッグを返す。flagId は cardLibrary(flags.json 由来)から createCard で実体化する。
function stackPlayerFlag(player, flagId) {
  let newFlag = null;
  try {
    newFlag = createCard(flagId);
  } catch (error) {
    newFlag = null;
  }
  if (!newFlag) {
    return false;
  }
  player.flag = newFlag;
  return true;
}

// E-XB71(X2-SP/0024): lifeZeroReplacement / lifeZeroSafeguard の追加 effects を同期実行する共通ディスパッチ。
// resolveLifeZeroReplacements は同期経路（applyDamageToPlayer 等の非同期を使わない）ため、ライフ/手札の直接操作と
// 同期プリミティブ（drawCards / addNextDamagePrevention）のみ扱う。lifeZeroSafeguard の従来インライン4op
// （discardAllHand / dealDamage / gainLife / draw）を関数化し、preventAllDamageThisTurn（「そのターン中、君は
// ダメージを受けない」= 0024 の魔法ヒット時ボーナス）を追加した上位集合。sourceCard 省略時（プレイヤー単位の
// safeguard）はログを player 名へフォールバックさせ、従来 safeguard の出力を byte 一致で保つ（後方互換）。
function applyLifeZeroReplacementEffects(effects, owner, sourceCard = null) {
  const player = state.players[owner];
  for (const eff of effects || []) {
    if (eff.op === "discardAllHand") {
      const discarded = player.hand.splice(0);
      player.drop.push(...discarded);
      if (discarded.length) addLog(`${player.name}は手札を全て捨てました。`);
    } else if (eff.op === "dealDamage") {
      // E11: 直接 life を減らさず、全ダメージが合流する applyDamageToPlayer を通す（受け手の軽減/無効化・
      // 被ダメ記録・『ダメージを受けた時』誘発・勝敗判定）。同期関数なのでこの同期経路からそのまま呼べる。
      const receiverIndex = eff.player === "opponent" ? 1 - owner : owner;
      const receiver = state.players[receiverIndex];
      const dealt = applyDamageToPlayer(receiverIndex, eff.amount || 0, {
        byEffect: true,
        sourceOwner: owner,
        sourceCard: sourceCard || null,
        sourceName: sourceCard?.name || player.name,
        log: false,
      });
      if (dealt > 0) {
        addLog(`${sourceCard?.name || player.name}の効果で${receiver.name}に${dealt}ダメージ！`);
      }
    } else if (eff.op === "gainLife") {
      player.life += eff.amount || 0;
    } else if (eff.op === "draw") {
      // E-XC16(X-CP01/0062 バディトゥギャザー！): drawCards 直呼び（同期経路の作法。誘発は内部で queue）。
      drawCards(player, eff.amount || 1);
    } else if (eff.op === "preventAllDamageThisTurn") {
      // src/15 の同名 op と同意味論（once:false + preventAll・untilTurnOwner=state.active で当該ターン終了に失効）。
      const whileCond = captureWhileConditions(eff, owner); // 裁定 R9（未指定は null＝従来どおり常時）
      addNextDamagePrevention(owner, {
        preventAll: true,
        once: false,
        damageClass: "noDamage", // 裁定 rulings-d: 分類(a)「受けない」
        ...(eff.onlyAttack === true ? { onlyAttack: true } : {}),
        source: sourceCard?.name,
        sourceCard: sourceCard || null,
        ...(whileCond ? { whileCond } : {}),
      });
      addLog(`${sourceCard?.name || "効果"}により、このターン中${player.name}はダメージを受けません。`);
    }
  }
}

// 裁定 rulings-d（Q1610）: ×天バスター系の致死（ライフ変更ロック中）で、場の強制 lifeZeroReplacement を
// 「ライフを変更しない」形で解決する。対象は topDeckFilter / soulFilter 型（「このカードをドロップゾーンに置き、
// デッキの上から１枚（ソウル全て）をドロップゾーンに置く。そのカードが魔法なら、君のライフはNになる」）と
// sacrificeFilter 型（「『搭乗』しているカード１枚を破壊する。破壊したら、君のライフは１になり、このカードを破壊する」）。
// どれも印字上は強制。置く/破壊する処理は行い、ライフ・ドロー・追加効果（ライフ変更に続く部分）は行わない。
// soulCost 型（「捨ててよい。捨てたら」）は任意＝ライフが変わらないので使わない。
function lockedLifeZeroReplacement(player, owner) {
  const replacementSlot = [...setZones, "item", ...fieldZones]
    .map((zone) => ({ zone, card: player.field[zone] }))
    .find(
      ({ card }) =>
        card?.lifeZeroReplacement &&
        !isAbilitiesNullified(card) &&
        !card.lifeZeroReplacement.soulCost &&
        !triggerDriver.lifeZeroSacrificePending.has(card.instanceId) &&
        (card.lifeZeroReplacement.topDeckFilter || card.lifeZeroReplacement.soulFilter || card.lifeZeroReplacement.sacrificeFilter),
    );
  if (!replacementSlot) {
    addLog(`${player.name}のライフは変更されません（復活できない）。`);
    return;
  }
  const { zone, card } = replacementSlot;
  const replacement = card.lifeZeroReplacement;
  if (replacement.sacrificeFilter) {
    // 2026-10-13 rulings-f: 生贄は通常の破壊経路（ソウルガード等の任意確認・破壊耐性・破壊時誘発）で破壊する。
    // ライフ変更ロック中なので「破壊したら」でもライフは変えず、このカードの破壊だけ行う。
    const sac = findLifeZeroSacrifice(player, owner, zone, card);
    if (sac) {
      scheduleLifeZeroSacrifice(owner, zone, card, sac, { changeLife: false });
    }
  } else {
    if (replacement.soulFilter) {
      const soulCards = card.soul?.splice(0) || [];
      player.drop.push(...soulCards);
    }
    if (replacement.topDeckFilter) {
      const topDeckCard = player.deck.pop() || null;
      if (topDeckCard) {
        player.drop.push(topDeckCard);
        queueDeckMilledTriggers(owner, [topDeckCard], {
          byEffect: true,
          byOpponent: false,
          sourceOwner: owner,
          sourceCard: card || null,
        });
      } else {
        declareDeckLoss(player);
      }
    }
    dropFieldCardByRule(player, zone);
  }
  addLog(`${card.name}の効果は発動しましたが、${player.name}のライフは変更されません（復活できない）。`);
}

// rulings-f: ライフ0置換の生贄（『搭乗』しているカード等）を探す。既定は破壊耐性で破壊できないものを除く（Q777）。
function lifeZeroSacrificeCause(owner, card) {
  return { byEffect: true, byOpponent: false, sourceOwner: owner, sourceType: card ? effectiveCardType(card) : null, sourceCard: card || null };
}
function findLifeZeroSacrifice(player, owner, zone, card, options = {}) {
  const replacement = card.lifeZeroReplacement;
  const searchZones = expandZoneList(replacement.sacrificeZones) || zones;
  const cause = lifeZeroSacrificeCause(owner, card);
  return (
    searchZones
      .map((z) => ({ z, c: player.field[z] }))
      .find(
        ({ z, c }) =>
          c &&
          z !== zone &&
          matchesCardFilter(c, replacement.sacrificeFilter) &&
          (options.includeImmune || !destroyImmunityBlocks(c, cause, owner)),
      ) || null
  );
}

// rulings-f: ライフ0置換の生贄を通常の破壊経路で破壊し、「破壊したら」このカードを破壊する（ブレイブフォート H-EB02/0029）。
// ソウルガード等の確認は destroyFieldCard → confirmChoiceAsync が持ち主の席（ローカル/CPU/権威サーバ/リプレイ）へ回す。
// changeLife: 呼び出し側が先にライフを確定させた（通常時）。破壊が成立しなかったらライフを戻し敗北処理をやり直す。
function scheduleLifeZeroSacrifice(owner, zone, card, sac, { changeLife }) {
  const pending = triggerDriver.lifeZeroSacrificePending;
  pending.add(card.instanceId);
  const replacement = card.lifeZeroReplacement;
  const job = async () => {
    const player = state.players[owner];
    const cause = lifeZeroSacrificeCause(owner, card);
    const destroyed =
      player.field[sac.z] === sac.c ? await destroyFieldCard(owner, sac.z, { cause, outcome: {} }) : null;
    if (!destroyed) {
      if (changeLife) {
        player.life = Math.min(player.life, sac.lifeBefore ?? 0);
        addLog(`${sac.c.name}を破壊できなかったため、${card.name}の効果で${player.name}のライフは変わりません。`);
      }
      pending.delete(card.instanceId);
      if (changeLife) {
        // このライフ0に対しては同じ置換を再使用しない（他の置換/セーフガードは従来どおり）。
        triggerDriver.lifeZeroSkip = card.instanceId;
        try {
          checkWinner();
        } finally {
          triggerDriver.lifeZeroSkip = null;
        }
      }
      return;
    }
    pending.delete(card.instanceId);
    if (changeLife) {
      addLog(`${card.name}の効果で${sac.c.name}を破壊し、${player.name}のライフは${player.life}になりました。`);
      if ((replacement?.draw || 0) > 0 && !isDrawByEffectPrevented(owner)) {
        drawCards(player, replacement.draw || 0);
      }
    }
    const fortSlot = findFieldCardSlot(card);
    if (fortSlot && fortSlot.owner === owner) {
      await destroyFieldCard(owner, fortSlot.zone, { cause });
    }
  };
  // 攻撃の破壊〜貫通の間は battleTriggerHold に溜まり、プレイタイミングで解決する（他の誘発と同じ）。
  queueTriggerMicrotask(job, { owner });
}

function resolveLifeZeroReplacements() {
  state.players.forEach((player, owner) => {
    if (player.life > 0) {
      return;
    }
    // E-Y6(0048/0028): この致死ダメージが「相手のカードで相手のライフは変更されない（復活できない）」を
    // 指定していれば、受け手(owner)のライフは変更されない＝敗北確定。フラグは applyDamageToPlayer の checkWinner
    // 呼び出しの間だけ立つ（この致死限定）。
    // 裁定 rulings-d（Q1610/Q1611）: ライフを変更する部分だけが行われない。強制の置換（「このカードをドロップゾーンに
    // 置き、デッキの上から１枚をドロップゾーンに置く。そのカードが魔法なら、君のライフは２になる」Ｄ・Ｒ・システム等）は
    // 発動して置く処理までは行い、ライフは0のまま（Q1610）。「〜てよい」の任意置換（手札重ね・ソウル捨て）と
    // プレイヤー単位のセーフガード（バーンノヴァ救援等のライフ1化＝Q1611 コールコストが払えない）は行わない。
    const lifeLocked = state.suppressLifeZeroReplacementFor === owner;
    if (lifeLocked) {
      lockedLifeZeroReplacement(player, owner);
      return;
    }
    // FE1(X-BT01/0128 ドラゴン・ドライ rule③): 「君のライフが0になるなら、手札のこのカードを君の
    // 「ドラゴン・ツヴァイ」に重ねてよい。重ねたら、君の場のカード全てをドロップゾーンに置き、ライフを5にする」。
    // 手札の handLifeZeroReplacement マーカー(0128)を、フラッグが requireFlag(ドラゴン・ツヴァイ)の時だけ発動。
    // 任意だが延命は有利なため既存の置換群と同様に自動使用。フラッグ差し替えで 0124 ガエン召喚・0125-0127 の
    // ドライ分岐が到達可能になる。resolveLifeZeroReplacements は同期経路のため直接操作のみ（非同期を使わない）。
    const handIndex = (player.hand || []).findIndex((card) => card.handLifeZeroReplacement);
    if (handIndex >= 0) {
      const overlayCard = player.hand[handIndex];
      const rep = overlayCard.handLifeZeroReplacement;
      if (!rep.requireFlag || player.flag?.name === rep.requireFlag) {
        const previousFlag = player.flag;
        if (!stackPlayerFlag(player, rep.stackFlagId)) {
          return; // フラッグ定義が引けない異常時は何も消費しない（従来はここで手札だけ消えていた）
        }
        player.hand.splice(handIndex, 1); // 手札のこのカードをフラッグに重ねる（消費）
        // カード保存則: 差し替えフラッグ実体は重ねた0128の instanceId を引き継ぎ、旧フラッグ実体を下に重ねて
        // 保持する（物理カードを消さない。soul ごと room/replay に直列化される。フザー card-conservation 対象）。
        player.flag.instanceId = overlayCard.instanceId;
        player.flag.soul = [previousFlag];
        if (rep.dropAllField) {
          zones.forEach((zone) => {
            if (player.field[zone]) {
              dropFieldCardByRule(player, zone);
            }
          });
        }
        player.life = rep.life ?? 5;
        addLog(`${player.name}は${overlayCard.name}を「${rep.requireFlag || "フラッグ"}」に重ね、場のカードを全てドロップしてライフを${player.life}にしました。`);
        return;
      }
    }
    const replacementSlot = [...setZones, "item", ...fieldZones]
      .map((zone) => ({ zone, card: player.field[zone] }))
      .find(
        ({ card }) =>
          card?.lifeZeroReplacement &&
          // 場のカードの■能力。能力無効化中は置換できない（破壊置換・ソウルガードと同基準）。
          !isAbilitiesNullified(card) &&
          // rulings-f: 生贄の破壊を待っている（または破壊に失敗した）同じ置換は二度使わない。
          !triggerDriver.lifeZeroSacrificePending.has(card.instanceId) &&
          triggerDriver.lifeZeroSkip !== card.instanceId &&
          // soulCost 型はソウルが足りる時だけ置換候補になる（不足時は次の敗北処理へ）
          (!card.lifeZeroReplacement.soulCost ||
            (card.soul || []).length >= (card.lifeZeroReplacement.soulCost.amount || 1)),
      );
    if (!replacementSlot) {
      // プレイヤー単位の一回限りセーフガード（実は生きていた！）。場札の置換が無い場合に消費する。
      // 監査 rule-damage-5: duration:"attackPhase" はアタックフェイズを過ぎたら失効（R-BR21 と同じく攻撃中の
      //   state.phase="defense" は宣言時の pendingAttack.phase で論理フェイズを判定）。
      const sg = player.lifeZeroSafeguard;
      if (sg?.duration === "attackPhase") {
        const logicalPhase = state.pendingAction?.phase || state.phase;
        const inAttackPhase =
          sg.turnCount === state.turnCount && (logicalPhase === "attack" || state.pendingAttack?.phase === "attack");
        if (!inAttackPhase) {
          player.lifeZeroSafeguard = null;
        }
      }
      if (player.lifeZeroSafeguard) {
        const safeguard = player.lifeZeroSafeguard;
        // once:false（期間型）は消費しない（期間中は何度でも置換する）。
        if (safeguard.once !== false) {
          player.lifeZeroSafeguard = null;
        }
        player.life = safeguard.life || 1;
        addLog(`${player.name}は「実は生きていた！」でライフが${player.life}になりました。`);
        // 追加効果（蒼舞天滝陣 0037: 手札全捨て＋相手にダメージ2 等）を同期実行する。共通ディスパッチ
        // applyLifeZeroReplacementEffects（E-XB71 で lifeZeroReplacement と共有）へ委譲。sourceCard は
        // プレイヤー単位のため渡さず（ログは従来どおり player 名フォールバック）。
        applyLifeZeroReplacementEffects(safeguard.effects, owner);
      }
      return;
    }
    const { zone, card } = replacementSlot;
    const replacement = card.lifeZeroReplacement;
    if (replacement.sacrificeFilter) {
      // 『搭乗』しているカード等1枚を生贄に破壊してライフを守る（ブレイブフォート 0029）。
      // 生贄が無ければ守れない（発生源も破壊しない）。
      // R-BR28(ブラウザレビュー): 『搭乗』しているカード＝装備枠(item)のみ。sacrificeZones で走査ゾーンを
      // 絞る（未指定なら従来どおり全ゾーン＝完全後方互換。keyword:"ride" は静的なので未搭乗の場のライド
      // モンスターも拾ってしまうため、0029 は sacrificeZones:["item"...] で装備済みのみに限定する）。
      // 2026-10-13 rulings-f（オーナー裁定・Q776/Q777）: 生贄は通常の破壊経路（destroyFieldCard）で破壊する。
      // ソウルガード等で場に残っても破壊は成功（2026-10-09 裁定）＝ライフ1・このカードを破壊（Q776 カイゼリオン）。
      // 「カードの効果で破壊されない」カードは破壊できない＝「破壊したら」以降は解決しない（Q777 ガンザウラー）。
      // checkWinner は同期経路でソウルガード確認（往復）を待てないため、破壊が成立し得る（耐性の無い）生贄がいる時は
      // ライフ1を先に確定させて敗北を止め、破壊と「このカードを破壊」は誘発ジョブ（scheduleLifeZeroSacrifice）で
      // 通常の破壊経路に流す。ジョブで破壊が成立しなかったら（場を離れて別の場所へ移る置換・状況の変化）ライフを
      // 戻して敗北処理をやり直す。
      const sac = findLifeZeroSacrifice(player, owner, zone, card);
      if (!sac) {
        const immune = findLifeZeroSacrifice(player, owner, zone, card, { includeImmune: true });
        if (immune) {
          addLog(`${immune.c.name}は効果では破壊されないため、${card.name}の効果でライフは変わりません。`);
        }
        return;
      }
      sac.lifeBefore = player.life;
      player.life = replacement.life || 1;
      addLog(`${card.name}の効果で${sac.c.name}を破壊します。${player.name}のライフは${player.life}になります。`);
      scheduleLifeZeroSacrifice(owner, zone, card, sac, { changeLife: true });
      return;
    }
    if (replacement.soulCost) {
      // 「このカードのソウルN枚を捨ててよい。捨てたら、君のライフはlifeになる」型
      // （カード自身は場に残る。H-BT04/0001 カイザー・ドラム“固い絆”）。任意だが有利な置換のため自動使用（既存置換と同仕様）。
      const soulAmount = replacement.soulCost.amount || 1;
      let soulDropped = 0;
      for (let index = 0; index < soulAmount; index += 1) {
        const soulCard = card.soul.pop();
        if (soulCard) {
          player.drop.push(soulCard);
          soulDropped += 1;
        }
      }
      player.life = replacement.life || 1;
      addLog(`${card.name}の効果でソウル${soulAmount}枚を捨て、${player.name}のライフは${player.life}になりました。`);
      // E1/F2: ソウルがドロップへ移り card は場に残る（置換成立）→ soulCardDropped を発火。
      queueSoulCardDroppedTriggers(card, state.players.indexOf(player), soulDropped);
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
        // E5: 置換効果によるデッキ→ドロップも deckMilled ブロードキャスト対象（起因=置換を持つカード自身）。
        queueDeckMilledTriggers(state.players.indexOf(player), [topDeckCard], {
          byEffect: true,
          byOpponent: false,
          sourceOwner: state.players.indexOf(player),
          sourceCard: card || null,
        });
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
    // E-XB71(X2-SP/0024 グローリー・シーカー "奇跡よ再び"): 置換成立（topDeckFilter=魔法一致 等の hasRequiredSoul）
    // 時に追加 effects を解決する。0024 は preventAllDamageThisTurn（「そのターン中、君はダメージを受けない」）。
    // 既存 lifeZeroReplacement は effects 未保持＝空ループ＝完全後方互換。owner は forEach 添字。
    applyLifeZeroReplacementEffects(replacement.effects, owner, card);
  });
}

function checkWinner() {
  resolveLifeZeroReplacements();
  state.players.forEach((player, index) => {
    // E-XB1(X-BT02/0113): 「ファイトに敗北しない」保護中の席はライフ0/デッキ0でも敗北を保留する
    //（isSeatLossPrevented は未設定時 false ＝従来の敗北判定と完全一致）。
    if (isSeatLossPrevented(index)) {
      return;
    }
    if (player.life <= 0 && !state.winner) {
      state.winner = state.players[1 - index].name;
      state.winnerSeat = 1 - index; // D5(戦績): 名前はデッキと紐付かないため勝者席・理由を刻む
      state.winReason = "life";
      addLog(`${state.winner}の勝利です。`);
    }
    if (player.deck.length === 0 && !state.winner) {
      state.winner = state.players[1 - index].name;
      state.winnerSeat = 1 - index; // D5(戦績)
      state.winReason = "deckout";
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
  // E-XB1(X-BT02/0113): 「ファイトに敗北しない」保護中の席はデッキ0枚でも敗北を保留する。
  if (isSeatLossPrevented(loserIndex)) {
    return;
  }
  state.winner = state.players[1 - loserIndex].name;
  state.winnerSeat = 1 - loserIndex; // D5(戦績)
  state.winReason = "deckout";
  addLog(`${player.name}のデッキが0枚のため、${state.winner}の勝利です。`);
}


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
// perf(R11): isAbilitiesNullified も同じ statMemo スコープでメモ化する（taint 無しの完全値のみ格納）。
// E-XB2 で無効化保護判定を per-card 再入化した結果、保護グラフを DAG として何度も踏み直し、cinderella 系で
// 1手が main 比 10倍(seed641 2.3s→21s)に膨れた。isAbilitiesNullified は純粋関数で、この評価中に走る
// matchesCardFilter→effectiveAttributes が独自に開いていた最外スコープを isAbilitiesNullified 側の
// statMemoBegin/End で覆うことで、1回の最外評価の再帰全体で結果を共有し指数を多項式へ落とす。
const statMemoNullified = new Map(); // card → isAbilitiesNullified（完全値のみ）
function statMemoBegin() {
  statMemoDepth += 1;
}
function statMemoEnd() {
  statMemoDepth -= 1;
  if (statMemoDepth <= 0) {
    statMemoDepth = 0;
    statMemoSize.clear();
    statMemoAttributes.clear();
    statMemoNullified.clear();
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
// Z4(d)(S-UB-C03) / R10(E-XB2): grantNullifyImmunity 継続の保護判定は、保護元カード自身の継続走査
// (grantedProtectionBlocks→activeContinuousEffects→isAbilitiesNullified) を辿るため循環し得る。
// 旧実装は「保護評価中に再入した“どのカードでも”保護チェックを丸ごと打ち切り fieldNullified の生値を
// 返す」グローバルフラグ(evaluatingNullifyProtection)で循環を止めていた。だがこれだと相手の
// nullifyAbilities 継続が場に実在するとき、保護元が“自分自身”を守る継続(filter一致=自己言及保護)まで
// 生値=無効化扱いで打ち切られ、保護元もろとも保護対象まで無効化された（B7 が VM 実測で発見した
// 出荷済みバグ。bf-pr-0441 / bf-x-ss02-0002 / bf-x-ub01-0021 等 filter:{} 型や、自身が filter に一致
// する条件付き保護が該当）。
// 修正: グローバルフラグを「いま保護評価中のカード集合」(visited set)へ格上げする。再入が“同一カード”
// のときだけ（＝真の自己循環）「無効化されていない」(false)で打ち切り、その札の自己言及保護を有効と
// 見なす（最大不動点＝能力が生きている前提）。異なるカードへの再入は通常どおり保護評価を通すので、
// 保護元が“自分では守れない別要因”で無効化された場合は保護も止まる（red pin ②）。集合キーは
// カードオブジェクト（instanceId を持たない疑似札でも安全＝sizeEvaluationStack と同方針）。
// 無限再帰は「同一カードは stack 追加後に必ず即 false で打ち切る」ことで防ぐ（保護2枚相互でも停止）。
// 0024(諸星きらり・全体無効化＋nullifyImmune) vs 0001(アイドル無効化耐性) の競合は「されない」側が
// 勝つ（0001側のcardProtectedFrom判定が先に評価されfalseで確定するため）。
// perf(R11): stack を Map(card→評価順序) にして taint 追跡付きメモ化を行う（詳細は statMemoNullified 定義／
// 下の isAbilitiesNullified の statMemoBegin コメント参照）。自己言及保護の循環打ち切りの意味論は不変。
const nullifyProtectionStack = new Map(); // card → enterOrder（cardProtectedFrom 評価中のみ在籍）
let nullifyEnterCounter = 0;
let nullifySubtreeMinCut = Infinity; // 現フレームの subtree 内で観測した最小 cut 順序（祖先=より浅い順序）
function isAbilitiesNullified(card) {
  if (!card || card.nullifyImmune || !state?.players?.length) return false;
  // FD5(X-BT01/0124 ガエン): ゾーン限定の無効化耐性。指定ゾーン(item=変身中)に在る間だけ「能力を無効化されない」。
  // destroyImmunity/preventReturnToHand が conditions:[sourceZoneIn(item)] でゲート済みなのに合わせた対称形。
  // 在ゾーンを直接読むだけ（continuous 評価に再入しない＝自己 grantNullifyImmunity のような循環で無効化に負けない）。
  // 既存カードは nullifyImmuneZones 未所持＝この分岐は素通り（後方互換）。
  if (Array.isArray(card.nullifyImmuneZones) && card.nullifyImmuneZones.length) {
    const slotZone = findFieldCardSlot(card)?.zone;
    if (slotZone && card.nullifyImmuneZones.includes(slotZone)) return false;
  }
  // フラッグは能力無効化を受けない（公式裁定Q2220: ∞ the Chaos ∞ 先例）。フラッグは場のzonesにも
  // 誰のソウルにも存在しないため、下の探索は本来どのみち host が見つからず false になるが、
  // 将来の実装変更（フラッグを走査対象に含める等）に備えて明示的に免除しておく。
  if (card.type === "flag") return false;
  if (nullifyProtectionStack.has(card)) {
    // 同一/祖先カードの保護評価への再入＝自己言及保護の循環。最大不動点として「無効化されていない」で打ち切る
    // （＝この札の能力が生きている前提で、その札自身の grantNullifyImmunity を読ませる）。
    // taint 追跡: 打ち切った再入元(card)の評価順序を subtree の最小 cut として記録する。これより深い
    // （順序が大きい＝祖先を跨いだ）フレームの結果は文脈依存になるためメモ対象から外す。
    nullifySubtreeMinCut = Math.min(nullifySubtreeMinCut, nullifyProtectionStack.get(card));
    return false;
  }
  // perf(R11): この評価の再帰全体を1つの statMemo スコープで覆う。isAbilitiesNullified は純粋関数だが、
  // 内部で走る matchesCardFilter→effectiveAttributes/effectiveSize が各々「最外」スコープを開閉していたため、
  // isAbilitiesNullified の結果メモが再帰の途中で毎回破棄され効かなかった。ここで最外スコープを覆うことで
  // 1回の最外評価（さらに親が continuousStatBonus 等でスコープを開いていれば、その1手ぶん全体）で保護グラフ
  // の結果を共有し、E-XB2 の per-card 再入で階乗化していた再帰を多項式へ落とす（seed641 21s→数s）。
  statMemoBegin();
  try {
    const cached = statMemoNullified.get(card);
    if (cached !== undefined) {
      return cached;
    }
    const topLevel = nullifyProtectionStack.size === 0;
    const myOrder = (nullifyEnterCounter += 1);
    const savedSubtreeMinCut = topLevel ? Infinity : nullifySubtreeMinCut;
    nullifySubtreeMinCut = Infinity;
    const result = evaluateAbilitiesNullified(card, myOrder);
    const myMinCut = nullifySubtreeMinCut;
    // subtree 内で「自分より浅い(=祖先)フレームへの cut」が起きた結果は文脈依存＝メモ不可。自己保護の cut は
    // 順序が myOrder ちょうど（myMinCut===myOrder）のため taint にならず、E-XB2 の自己言及保護はそのまま格納。
    if (!(myMinCut < myOrder)) {
      statMemoNullified.set(card, result);
    }
    // subtree の cut 順序を親フレームへ伝播（親は自分の順序で taint 判定する）。最外は次の問い合わせへ
    // 影響させないため Infinity に戻す。
    nullifySubtreeMinCut = topLevel ? Infinity : Math.min(savedSubtreeMinCut, myMinCut);
    return result;
  } finally {
    statMemoEnd();
  }
}

// isAbilitiesNullified の実体（保護判定→フィールド無効化継続の走査）。保護スタック(nullifyProtectionStack)の
// set/delete スコープは従来どおり cardProtectedFrom の間のみ（fieldNullified 走査中は card を stack に載せない
// ＝挙動不変）。myOrder はラッパが振った評価順序（再入 cut の taint 判定に使う）。
function evaluateAbilitiesNullified(card, myOrder) {
  nullifyProtectionStack.set(card, myOrder);
  try {
    if (cardProtectedFrom(card, "nullify")) return false;
  } finally {
    nullifyProtectionStack.delete(card);
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
        // E-XB23(X-BT03/0018 封じられし黒印竜 エルゴッド): opposingFront＝「このカードの前の相手のモンスター」限定
        // の無効化。発生源(src=nullifierOwner側の zone)の正面（ミラー列: 左↔右/中央↔中央）に在る相手側の
        // 場札1枚だけを無効化する（continuousEffectApplies の opposingFront と同じ oppositeFieldZone 対応付け）。
        // 盤面位置のみを読む純粋判定＝isAbilitiesNullified の statMemo スコープ（盤面不変な1パス）内で結果は一定＝
        // メモ健全（前面カードの入替は次の最外評価＝新パスでメモが捨てられ再計算される）。位置は保護グラフの
        // 再入(taint)とは独立で、cut 判定に影響しない。ソウル内カード(slot 無し)は正面を持たないため対象外。
        if (e.opposingFront) {
          if (!slot || slot.owner === nullifierOwner || slot.zone !== oppositeFieldZone(zone)) return false;
        }
        if (e.filter && Object.keys(e.filter).length && !matchesCardFilter(card, e.filter)) return false;
        if (e.conditions && !checkCardConditions(e.conditions, nullifierOwner, { card: src, zone })) return false;
        // Z10(S-UB-C03/0089): battleOpponentOnly は「このカードとバトルしている相手」限定の無効化。
        // pendingAttack が無い、または card が付与元(nullifierOwner側)から見て対戦相手でなければ適用しない。
        if (e.battleOpponentOnly && !isBattlingOpponentOf(card, cardOwner, nullifierOwner)) return false;
        return true;
      });
    }),
  );
  return fieldNullified || isNullifiedByBattlingHostSoul(card) || isNullifiedByTurnEffect(card);
}

// E2(D-SS03/0010 ドラゴンフォース・キャンセル): nullifyFieldAbilities 効果op が積んだ
// ターン限定の全体能力無効化。発動時点で記録した対象カードの instanceId 集合（state.turnNullifies）に
// card が含まれれば無効化。集合走査のみで matchesCardFilter/継続走査を再入しない（無限再帰リスク無し）。
// 既存カードは nullifyFieldAbilities 未使用＝turnNullifies 常時空＝挙動完全不変。
function isNullifiedByTurnEffect(card) {
  if (!card || !state?.turnNullifies?.length) return false;
  return state.turnNullifies.some((entry) => (entry.instanceIds || []).includes(card.instanceId));
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
  // E-XB44(X-CBT02/0076 ワールド・パンデミック): フラッグが裏（flagFaceDown）＝フラッグ機能停止。
  // フラッグ由来の場サイズ上限（maxFieldSize）を失い規定値3へ戻す。未設定（既存の全state）は素通り＝バイト不変。
  const base = player?.flagFaceDown ? 3 : (player?.flag?.maxFieldSize ?? 3);
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
  // E-XB43(X-CBT01/0070 バールバッツ・ドラグロイヤー): 印字パワー∞。powerInfinity:true 型のフラグで表現し、
  // stat 解決点で JS の Infinity を返す（数値サチュレーション＝999999 のような有限代用は不採用＝ルール裁定 R6）。
  // 設計上の∞相互作用（すべて JS の Infinity 演算が自然に満たす。赤ピン: powerInfinity 分岐を消すと有限値に戻り fail）:
  //  ・＋X 加算後も∞（Infinity + 有限 = Infinity。この short-circuit で加算/バフ/デバフを一切素通りさせ、常に∞を返す）。
  //  ・減算でも∞（相手効果の打撃力減少 turnPowerBonus/battlePowerBonus は short-circuit で無視＝「打撃力は減らない」を内包）。
  //  ・バトル比較（§10-battle-resolve の attackPower>=defense）は Infinity>=有限=true（∞は必ず貫く）。
  //  ・statThreshold/動的しきい値（§17 passesStatThreshold・E-XB19系）は Infinity<=X=false / Infinity>=X=true / ===X=false。
  //  ・∞同士は Infinity===Infinity=true（同値扱い）・Math.max(∞,∞)=∞。
  //  ・注意（設計判断）: amountFrom の stat ソース（fieldCardStat/weaponPowerMax/itemPowerSum/soulStatSum＝§15）が
  //    ∞カードの visiblePower を読むと Infinity が「支払い/加算量」へ伝播し、格納フィールドに入ると JSON 直列化で null 化する。
  //    対象内DBに∞カードを stat ソースへ食わせる組み合わせは存在しない（バールバッツはドラゴンW モンスターで武器/アイテム系ソースの対象外）。
  //    よって saturation を入れず、この既知エッジは「∞は stat ソースに使わない」を規約として明示（ruling R6 の指示どおりコメントで設計判断を固定）。
  if (card?.powerInfinity) {
    return Infinity;
  }
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

// E-XB29(X-SS04/0005 雷晶竜 アトラ 継続②): 継続 modifyStats の amountFrom:{source:"distinctWorldCount"} 分。
// 「君の場のカードのワールド名の種類分、攻撃力+1000、防御力+1000」= 指定側(controller・既定self)の指定pile
// (既定field)の filter 一致カードの「ワールド名の種類数」× per[statKey]。効果op側 resolveAmountFrom の
// distinctWorldCount（E-XB17・src/15）と同ロジックの「継続」版で、cardWorlds() により2ワールド持ちは両ワールドを
// union 算入する（条件op cardCount の distinct:"distinctByWorld" と同根拠）。pile は field/item/center/soul/
// その他(player[pile]=drop等)に対応し、max/filter も受理。per は継続側の作法どおり per:{power,defense,critical}
// のstat別オブジェクト（他の継続 amountFrom ヘルパーと同一）。amountFrom 非保持／別source の既存継続は per が
// 引けず 0 加算＝完全に挙動不変（distinctWorldCount を継続で使う既存カードは0件＝後方互換）。
function continuousDistinctWorldCountAmount(effect, statKey, sourceOwner) {
  if (effect.op !== "modifyStats" || effect.amountFrom?.source !== "distinctWorldCount") {
    return 0;
  }
  const af = effect.amountFrom;
  const per = af.per?.[statKey] ?? 0;
  if (!per) {
    return 0;
  }
  const owner = af.controller === "opponent" ? 1 - sourceOwner : sourceOwner;
  const pl = state.players[owner];
  const pile = af.pile || "field";
  let cards = [];
  if (pile === "field") cards = zones.map((zone) => pl?.field?.[zone]).filter(Boolean);
  else if (pile === "item") cards = equippedItems(pl);
  else if (pile === "center") cards = pl?.field?.center ? [pl.field.center] : [];
  else if (pile === "soul") cards = zones.flatMap((zone) => pl?.field?.[zone]?.soul || []);
  else if (pile === "itemSoul") cards = itemZones.flatMap((zone) => pl?.field?.[zone]?.soul || []); // E-XB46: アイテムゾーンのソウル限定
  else cards = pl?.[pile] || [];
  const matched = cards.filter((card) => matchesCardFilter(card, af.filter || {}));
  let count = new Set(matched.flatMap((card) => cardWorlds(card))).size;
  if (af.max !== undefined) {
    count = Math.min(count, af.max);
  }
  return count * per;
}

// E-XC6(X-CP01/0049 ガンズアーム): 継続 modifyStats の amountFrom:{source:"weaponCriticalSum"} 分。
// 指定controller(既定self)の場のアイテムのうち filter 一致（例 nameIncludes:"拳"）の visible critical(打撃力)を
// 合計 × per[statKey]。印字値ではなく visible を見るので、参照先アイテムの打撃力が可変バフされた時も追従する。
// 再帰安全: 発生源自身(sourceCard)は既定で除外（excludeSource!==false）＝自己参照の無限再帰を防ぐ。参照先アイテムが
// 同種の weaponCriticalSum を持たない限りサイクルは生じない（continuousFieldCardStatValueAmount と同注意）。
function continuousWeaponCriticalSumAmount(effect, statKey, sourceOwner, sourceCard) {
  if (effect.op !== "modifyStats" || effect.amountFrom?.source !== "weaponCriticalSum") {
    return 0;
  }
  const af = effect.amountFrom;
  const per = af.per?.[statKey] ?? 0;
  if (!per) {
    return 0;
  }
  const owner = af.controller === "opponent" ? 1 - sourceOwner : sourceOwner;
  let sum = 0;
  zones.forEach((zone) => {
    const item = state.players[owner]?.field?.[zone];
    if (!item || effectiveCardType(item) !== "item") {
      return;
    }
    if (af.excludeSource !== false && item.instanceId === sourceCard?.instanceId) {
      return;
    }
    if (!matchesCardFilter(item, af.filter || {})) {
      return;
    }
    sum += visibleFieldStat(item, "critical");
  });
  return sum * per;
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

// E-PR4(PR/0223 竜装機シュレディンガー): 継続 modifyStats の amountFrom:{source:...} 系
// （ドロップ属性枚数・ソウル枚数/合計・自サイズ・場のソウル/カード枚数・場のカードstat・武器打撃力合計）の
// 動的算出ヘルパー群を1関数へ集約する。従来は場カード継続(continuousStatBonus の own-side ループ)だけが
// これらを個別に呼んでいたため、ソウル内カードの soulContinuous の modifyStats はリテラル値しか読めず
// 「ドロップの同名枚数分＋1000」のような動的スケーリングを表現できなかった。ここへ集約して soul 側でも
// 同じ amountFrom 解決を使えるよう配線する。各ヘルパーは effect.op / amountFrom.source を自己ゲートし、
// 該当しなければ0を返す＝amountFrom を持たない既存 soulContinuous（一竜当千・竜装機系 等16枚。DB走査で
// amountFrom 使用0件確認済み）の挙動は完全不変（加算0）。sourceOwner は発生源カードの所有者席。
function continuousModifyStatsAmountFrom(effect, statKey, player, sourceCard, sourceOwner) {
  return (
    continuousDropStatAmount(effect, statKey, player) +
    continuousSoulStatAmount(effect, statKey, sourceCard) +
    continuousSelfSizeAmount(effect, statKey, sourceCard) + // X11a(D-BT01/0059)
    continuousFieldSoulStatAmount(effect, statKey, player) +
    continuousFieldCardStatAmount(effect, statKey, sourceOwner, sourceCard) +
    continuousFieldCardStatValueAmount(effect, statKey, sourceOwner) + // E8(D-BT03/0031)
    continuousWeaponCriticalSumAmount(effect, statKey, sourceOwner, sourceCard) + // E-XC6(X-CP01/0049)
    continuousDistinctWorldCountAmount(effect, statKey, sourceOwner) // E-XB29(X-SS04/0005)
  );
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
    // E1(D-BT04): ジェムクローンが inheritSoulAbilities:{filter} で得た、ソウル札の continuous も合流。
    // sourceCard=host のまま continuousEffectApplies に通すので、自己バフ/条件付き継続が host に乗る。
    [
      ...(sourceCard?.continuous || []),
      ...(sourceCard?.turnContinuous || []),
      ...inheritedFilterSoulContinuous(sourceCard),
    ].forEach((effect) => {
      if (!continuousEffectApplies(effect, card, sourceCard)) {
        return;
      }
      if (effect.op === "modifyStats") {
        bonus += effect[statKey] || 0;
      }
      // amountFrom 系(dropAttributeCount/soulCount/soulStatSum/selfSize/fieldSoulCount/fieldCardCount/
      // fieldCardStat/weaponCriticalSum)を統一解決。E-PR4 でソウル側と共通のヘルパーへ集約した（挙動不変）。
      bonus += continuousModifyStatsAmountFrom(effect, statKey, player, sourceCard, slot.owner);
    });
  });
  // Z1(S-UB-C03/0095): フラッグの継続効果。フラッグは zones 走査に乗らない（player.field ではなく
  // player.flag に実体がある）ため専用ブロックで評価する。フラッグは能力無効化を受けない(Q2220)ため
  // isAbilitiesNullified は経由しない（activeContinuousEffects と異なりフラッグ自体はここでは
  // sourceCard として使わず、flag.continuous を直接読む）。
  // E-XB44: フラッグが裏（flagFaceDown）ならフラッグ継続効果は一切適用しない（「フラッグに書かれているカードは使えず」＝機能停止）。
  if (player.flag?.type === "flag" && !player.flagFaceDown && player.flag.continuous?.length) {
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
        // E-XB51①(X-CBT01/0073): ターン限定 grantTurnProtection{kinds:["statDecrease"]} でも越境負デルタを保護する。
        const protectedDecrease =
          raw < 0 && (statDecreaseProtected(card, statKey) || turnProtectionBlocks(card, "statDecrease", statKey));
        bonus += protectedDecrease ? 0 : raw;
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
    // 自己ソウルの soulContinuous は bearer(card) 自身がホスト＝E-XC7 で hostMatches が使えるよう渡す。
    if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, slot.owner, card)) {
      return;
    }
    if (effect.op === "modifyStats") {
      bonus += effect[statKey] || 0;
    }
    // E-PR4(PR/0223 竜装機シュレディンガー): soulContinuous の modifyStats も amountFrom を動的解決する
    // （「君のドロップの同名枚数分＋1000」等）。player はホスト(card)の所有者＝dropAttributeCount は
    // 「君のドロップ」を数える。amountFrom 非保持の既存 soulContinuous は加算0で挙動不変。
    bonus += continuousModifyStatsAmountFrom(effect, statKey, player, sourceCard, slot.owner);
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
        // E-XC7(X-CP02/0039 アトアリザール): fieldWide の条件評価に host（ソウルを持つ場札）を渡し、
        // hostMatches{nameIncludes:"ゾディアック"} 等でホスト名に応じて場全体バフを掛けられるようにする。
        if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, slot.owner, host)) {
          return;
        }
        bonus += effect[statKey] || 0;
        // E-PR4: 場全体型(fieldWide)の soulContinuous modifyStats も amountFrom を動的解決する。
        bonus += continuousModifyStatsAmountFrom(effect, statKey, player, sourceCard, slot.owner);
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

// E1(D-BT04/0006・0115 ジェムクローン): inheritSoulAbilities:{filter} モードの continuous 面。
// filter 一致ソウル札の（soulContinuous ではなく）通常 continuous を、ホスト自身の継続として返す。
// continuousStatBonus の own-side ループが sourceCard=host として continuousEffectApplies に通すため、
// ソウル札の自己バフ（filter:{sameInstanceAsSource:true} で「このカード」＝host）や条件付き継続が
// 正しく host に乗る。inheritedFilterSoulCards が host 無効化時に空を返す＝継承は host 無効化で止まる。
// filter モード未使用の既存カードは常に空配列＝挙動不変。
function inheritedFilterSoulContinuous(host) {
  if (!host?.inheritSoulAbilities?.filter) {
    return [];
  }
  return inheritedFilterSoulCards(host).flatMap((soulCard) => soulCard.continuous || []);
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

function continuousEffectAppliesFromSoul(effect, targetCard, sourceCard, owner, hostCard) {
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
    // E-XC7(X-CP02/0039 アトアリザール): hostMatches 等の「ソウルを持つホスト」を見る条件が効くよう、
    // ホスト（fieldWide=場全体の各ホスト／自己ソウル=targetCard 自身の bearer）を条件コンテキストへ渡す。
    // hostCard 未指定の呼び出し（後方互換）は従来どおり host 情報なし＝hostMatches は false のまま。
    const conditionContext = { card: sourceCard, targetCard };
    if (hostCard) {
      conditionContext.hostCard = hostCard;
      conditionContext.hostOwner = owner;
      conditionContext.hostZone = findFieldCardSlot(hostCard)?.zone;
    }
    if (!checkCardConditions(effect.conditions, owner, conditionContext)) {
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
        if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, hostOwner, host)) {
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
// E-XU4(X-UB01/0043 キング・グミスライム): 相手モンスター全体への継続デナイアル。
// 場札の continuous/turnContinuous op:"restrictOpponentMonsters"{move|standInAttackPhase} を live 走査する
// （発生源が場を離れれば走査で見つからず自動解除＝継続評価。持続フラグは持たない）。
// controller/filter/conditions のスコープ判定は continuousEffectApplies に委譲（controller:"opponent"＝
// 相手モンスター限定・filter:{cardType:"monster"} 等）。能力無効化された発生源は activeContinuousEffects と
// continuousEffectApplies(isAbilitiesNullified) の二重で除外される。
// 既存カードは restrictOpponentMonsters op を持たない＝場に該当継続が無ければ常に false（高速パス・波及ゼロ）。
// ==========================================================================
function monsterActionRestricted(card, kind) {
  if (!card || !findFieldCardSlot(card)) {
    return false;
  }
  return state.players.some((player) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return activeContinuousEffects(source).some(
        (e) => e.op === "restrictOpponentMonsters" && e[kind] === true && continuousEffectApplies(e, card, source),
      );
    }),
  );
}

// 『移動』デナイアル: 移動キーワードの使用可否判定に使う（runMoveKeywordsAtAttackPhaseStart）。
function monsterMovementRestricted(card) {
  return monsterActionRestricted(card, "move");
}

// スタンドデナイアル: 既存の cannotStandThisTurn（Z14 S-UB-C03/0038＝そのターン中スタンド不可）に加え、
// アタックフェイズ中のみ restrictOpponentMonsters{standInAttackPhase} でスタンド不可（メイン/ファイナルは可）。
function standRestrictedNow(card) {
  if (!card) {
    return false;
  }
  if (card.cannotStandThisTurn) {
    return true;
  }
  return state.phase === "attack" && monsterActionRestricted(card, "standInAttackPhase");
}

// ==========================================================================
// E-PR1(PR/0075 アーマナイト・ハティー): 「相手の場のカードは連携攻撃できない」。
// 場札の continuous/turnContinuous op:"restrictLinkAttack" を live 走査し、対象カードが連携攻撃の
// 攻撃者に加われるか（＝連携の一員になれるか）を判定する。既存の cannotBeLinkAttacked/
// fighterCannotBeLinkAttacked は「連携攻撃“されない”」＝防御側の抑止で方向が逆。こちらは攻撃側の
// 「連携攻撃“できない”」＝攻撃者としての参加を禁じる（単独攻撃は許可＝呼び出し側が attackers.length>1 の
// ときだけ問う）。発生源が場を離れれば走査で見つからず自動解除（continuousEffectApplies 委譲・持続フラグは
// 持たない consult 型）。controller/filter/conditions のスコープ判定は continuousEffectApplies に委譲
// （controller:"opponent"＝相手の場のカード限定・filter:{}＝モンスター/アイテム問わず全カード）。能力無効化
// された発生源は activeContinuousEffects と continuousEffectApplies(isAbilitiesNullified) の二重で除外される。
// 既存カードは restrictLinkAttack op を持たない＝場に該当継続が無ければ常に false（高速パス・波及ゼロ）。
// ==========================================================================
function linkAttackRestricted(card) {
  if (!card || !findFieldCardSlot(card)) {
    return false;
  }
  return state.players.some((player) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return activeContinuousEffects(source).some(
        (e) => e.op === "restrictLinkAttack" && continuousEffectApplies(e, card, source),
      );
    }),
  );
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
  // E-XB34(X-BT04/0040/0110 鏡面峡谷): 「別のエリアに置かれない」＝移動耐性。cardProtectedFrom(card,"moveArea",cause)
  // が移動系op（moveTargetToDrop/putTargetToGauge/moveTargetToZone/EmptyZone 等）の実行点でゲートする。破壊/手札戻しは
  // 別クローズ（grantDestroyImmunity/preventReturnToHand）が担う。from:{byOpponent:true} で「相手のカードの効果で」限定。
  moveArea: "grantMoveAreaImmunity",
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
  return state.players.some((player, sourceOwner) => {
    // 継続の発生源: 場のモンスター(zones)＋フラッグ(player.flag)。フラッグ発の grantNullifyImmunity
    // （the-chaos「サイズ30以上のモンスターは能力を無効化されない」等）は player.flag に実体があり
    // zones 走査に乗らないため明示的に加える。既存フラッグは grant*Immunity 継続を持たない＝後方互換。
    const sources = zones.map((zone) => ({ source: player.field[zone], zone }));
    // E-XB44: 裏フラッグ（flagFaceDown）は grantNullifyImmunity 継続の発生源にならない（フラッグ機能停止）。
    if (player.flag?.type === "flag" && !player.flagFaceDown) {
      sources.push({ source: player.flag, zone: null });
    }
    return sources.some(({ source, zone }) => {
      if (!source) return false;
      // R10(E-XB2) 再入バウンド: この source が op を印字継続(continuous/turnContinuous。flagはcontinuous)に
      // 一切持たないなら、activeContinuousEffects(→isAbilitiesNullified 再帰) を呼ばずに早期スキップする。
      // isAbilitiesNullified の再入ガードを visited set 化した結果、grantedProtectionBlocks は「発生源自身が
      // 無効化されていないか」を実評価するようになったため、保護カードでない大多数の場札まで能力無効化評価を
      // 連鎖的に走らせると盤面枚数の階乗オーダに膨らむ。op を印字継続に持つ source（＝実際の保護カード。
      // 通常0〜1枚）だけに activeContinuousEffects 評価を限定して再入を有界化する純粋なプレチェック。
      // activeContinuousEffects が返す集合は continuous+turnContinuous（flag は continuous）と一致するため、
      // このプレチェックは真の保護カードを取りこぼさない（無効化された保護元は activeContinuousEffects が []
      // を返し保護を与えない、という既存意味論も不変）。
      const hasOpRaw =
        (source.continuous || []).some((e) => e.op === op) ||
        (source.turnContinuous || []).some((e) => e.op === op);
      if (!hasOpRaw) return false;
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
    });
  });
}

// Z4(e): 【対抗】等でそのターン(または複数ターン)限定に付与される保護（state.turnProtections）。
// エントリ形: {kinds:["rest"|"nullify"|"returnToHand"], owner, scope, filter, zoneIn, remainingTurnEnds}。
// destroy専用の既存 state.turnDestroyImmunity/grantTurnDestroyImmunity は移行せずそのまま使う。
function turnProtectionBlocks(card, kind, statKey) {
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
    // E-XB51①(X-CBT01/0073 覇王紅蓮雷波): 選んだ1枚だけを束縛する instanceIds（filter/scope の広域一致ではなく
    // 特定 instance 限定）。statDecrease 保護は entry.stats で対象 stat を絞れる（例 打撃力=critical のみ）。
    if (entry.instanceIds && !entry.instanceIds.includes(card.instanceId)) return false;
    if (kind === "statDecrease" && entry.stats && statKey && !entry.stats.includes(statKey)) return false;
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
  // E-XC9(X-CP02/0068 バイシャール): ソウル札の soulContinuous grantNullifyImmunity(hostOnly 等)による
  // 能力無効化耐性。恒久 grant*Immunity は「場の継続」限定(grantedProtectionBlocks)なので、ソウル発の
  // 付与は soulContinuousGrantsOp が担う（grantDestroyImmunity/preventReturnToHand と同じ配線）。
  // isAbilitiesNullified からの再入は evaluatingNullifyProtection ガードで打ち切られる（無限再帰なし）。
  // 既存カードで soulContinuous grantNullifyImmunity は0件＝turnNullifies/継続いずれの挙動も不変。
  if (kind === "nullify" && soulContinuousGrantsOp(card, "grantNullifyImmunity")) {
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


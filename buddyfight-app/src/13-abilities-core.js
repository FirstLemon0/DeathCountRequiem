// ==========================================================================
// buddyfight モジュール 13 — 能力探索・使用・条件判定
// 旧 app.js L5706-6486 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
// 手札から今使える能力を「すべて」返す（変身/搭乗の装備と別の起動/対抗が同時に使える等、複数ある時は
// useCardAction が選択させる。findUsableFieldAbilities の手札版）。単数形 findUsableHandAbility は先頭を返す薄いラッパ。
function findUsableHandAbilities(card, options = {}) {
  // F1(D-EB02): カードレベルの useConditions（「〜なら使える」）を通常の手札キャスト経路でも評価する。
  // 従来は castSetSpell（設置・src/08）でのみ評価され、通常の魔法/必殺技/対抗では無視されていた
  //（bf-s-ub-c03-0052/0053/0054/0093 のゲートが不発だった）。全手札キャスト経路
  //（useCardAction/castSpell/castImpact/useCounterCard/useCounterPlayCard/render/AI）はここを通る。
  const useOwner = state.selected?.owner ?? state.active;
  if (!checkCardConditions(card.useConditions || [], useOwner, { card, owner: useOwner })) {
    return [];
  }
  return (card.abilities || []).filter((ability) => {
    if (!canUseAbilityFromHand(ability)) {
      return false;
    }
    if (ability.fromFieldOnly) {
      return false;
    }
    if (ability.fromSoulOnly) {
      return false;
    }
    if (!handAbilityTimingMatches(ability, options)) {
      return false;
    }
    if (isAbilityLimitUsed(state.selected.owner, card, ability)) {
      return false;
    }
    if (ability.target && !abilityUsableWithoutTarget(ability) && targetCandidatesFromSpec(ability.target, state.selected.owner, { card, ability }).length === 0) {
      return false;
    }
    return (
      checkAbilityConditions(ability, state.selected.owner) &&
      canSatisfyAbilityScript(card, ability, state.selected.owner)
    );
  });
}

// 互換: 従来の単数形は先頭候補を返す（内部委譲。全既存呼び出し元はこれを使い続けられる）。
function findUsableHandAbility(card, options = {}) {
  return findUsableHandAbilities(card, options)[0];
}

// 手札のカードに使える能力が複数ある時、どれを使うか選ばせる（場の chooseFieldAbility の手札版）。
// 例: 変身/搭乗の装備と、別の起動能力が同時に使えるカード。ラベルは fieldAbilityLabel を共有し、
// equipSelf 系は「このカードを装備する（変身／搭乗）」・その他は ability.label/名前を出す。
async function chooseHandAbility(card, abilities, owner = state.selected?.owner ?? state.active) {
  if (globalThis.__BUDDYFIGHT_TEST__ && typeof globalThis.__forcedHandAbilityId === "string") {
    return abilities.find((ability) => ability.id === globalThis.__forcedHandAbilityId) || abilities[0];
  }
  const selected = await chooseCardEntries(
    abilities.map((ability) => ({
      ability,
      card: {
        name: fieldAbilityLabel(card, ability),
        type: "choice",
      },
    })),
    {
      title: `${card.name}の能力`,
      lead: "使う能力を選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
      allowCancel: true,
      purpose: "ability-pick", // CPU対戦(src/22): 先頭選択で解決＝無限ループしない
      promptSeat: owner,
    },
  );
  return selected?.[0]?.ability || null;
}

function canUseAbilityFromHand(ability) {
  if (!ability || ability.fromFieldOnly || ability.fromSoulOnly) {
    return false;
  }
  if (["spell", "impact"].includes(ability.kind)) {
    return true;
  }
  return ability.kind === "activated" && ability.fromHandOnly;
}

function handAbilityTimingMatches(ability, options = {}) {
  if (options.counterOnly) {
    return isCounterAbility(ability) && (isCounterPlayTiming() || Boolean(state.pendingAction || state.pendingAttack));
  }
  if (state.pendingAction) {
    return isCounterAbility(ability);
  }
  if (state.pendingAttack) {
    return isCounterAbility(ability);
  }
  // F8(D-SS03/0020 『必殺変身』): explicitPhase 指定時は「timing がそのフェイズを明示する」能力のみ真。
  // 非メインフェイズの useCardAction 経路が使う——timing 省略（＝メイン扱い）の魔法/起動能力を
  // メイン外で誤って通さないための限定モード。対抗系は上の pending 分岐と通常経路が従来どおり担う。
  if (options.explicitPhase) {
    return (ability.timing || []).includes(options.explicitPhase);
  }
  return abilityTimingIncludes(ability, state.phase) || (isCounterAbility(ability) && isCounterPlayTiming());
}

function isCounterAbility(ability) {
  return abilityTimingIncludes(ability, "counter");
}

// 条件 op "sourceIsBuddy": このカード（条件評価の主体）がバディモンスターか。
// 登録バディとの同名判定（isBuddyCard）に加え、treatAsBuddyThisTurn の一時付与（turnTreatAsBuddy）も真とする。
function sourceIsBuddyCondition(owner, context) {
  const card = context?.card;
  if (!card) {
    return false;
  }
  if (card.turnTreatAsBuddy) {
    return true;
  }
  return isBuddyCard(state.players[owner], card);
}

function isCounterOnlyHandCard(card) {
  const handAbilities = (card?.abilities || []).filter((ability) => canUseAbilityFromHand(ability));
  return handAbilities.length > 0 && handAbilities.every((ability) => isCounterAbility(ability));
}

function abilityCostPurpose(ability) {
  if (["spell", "impact"].includes(ability?.kind)) {
    return "cast";
  }
  return ability?.kind || "cast";
}

function abilityCostSteps(card, ability) {
  const purpose = abilityCostPurpose(ability);
  return ability?.cost || card?.costs?.[purpose] || [];
}

// T2: 宣言時のコストで何かを払う（カード・ゲージ・ライフ等が動く）か。払っていれば宣言後の選択は巻き戻せない。
function declarationCostCommits(costSteps) {
  return (costSteps || []).some((step) => step && !(typeof step.amount === "number" && step.amount <= 0));
}

// pt-fix-c T7-3: 「手札のこのカードを、【装備コスト】を払って装備する」型の起動能力（デュランダル“王の手”等）。
// 能力の cost が印字の【装備コスト】(costs.equip)と同一で、本体が equipSelf のものは、その支払いを【装備コスト】
// として扱う＝装備コストの軽減/追加（レヴァンティン「手札のアイテム全ては追加で【装備コスト】ゲージ１」等）を通す。
function abilityPaysPrintedEquipCost(card, ability) {
  if (!card || !ability || ability.kind !== "activated" || !Array.isArray(card.costs?.equip)) {
    return false;
  }
  const bodyOps = [...(ability.effects || []), ...(Array.isArray(ability.script) ? ability.script : [])];
  if (!bodyOps.some((entry) => entry?.op === "equipSelf")) {
    return false;
  }
  return JSON.stringify(ability.cost || []) === JSON.stringify(card.costs.equip);
}

// 手札/場の能力の実支払いコスト（軽減適用後）。全ての判定・支払い経路はこれを通す。
function adjustedAbilityCostSteps(player, card, ability) {
  if (abilityPaysPrintedEquipCost(card, ability)) {
    return cardCostSteps(player, card, "equip").steps;
  }
  return adjustedCostSteps(player, card, abilityCostPurpose(ability), abilityCostSteps(card, ability));
}

// 2018年6月以前ルール: 【対抗】は対抗ウィンドウ(pending)だけでなく自分のターン中の各フェイズでも使える。
// 手札の対抗カード(isCounterPlayTiming)と場の対抗起動能力(abilityTimingIncludes)で同じフェイズ集合を共有し、
// 「手札の対抗はアタックフェイズで使えるのに場の対抗起動はメイン限定」という非対称バグを防ぐ。
const COUNTER_PLAY_PHASES = ["draw", "charge", "main", "attack", "final"];

function isCounterPlayTiming() {
  return !hasPendingResolution() && COUNTER_PLAY_PHASES.includes(state.phase);
}

// 攻撃中(pendingAttack)のターンファイター側の席。攻撃しているのはターンファイターなので攻撃側(attackerOwner)を正とし、
// 欠けた旧 state だけ state.active で補う。
function pendingAttackTurnSide() {
  const pending = state.pendingAttack;
  if (!pending) {
    return null;
  }
  return pending.attackerOwner ?? pending.attackers?.[0]?.owner ?? state.active;
}

// pt-final(1): 宣言時の「対象選択より前」のコスト判定。払い方が対象に依存するコスト（amountFrom:targetStat 等）は
// 対象が決まるまで判定できないので素通し（従来どおり支払い時に判定）。判定は支払い本体と同じ canPayStructuredCost。
function abilityCostPrecheck(player, costSteps, context) {
  if (!Array.isArray(costSteps) || costSteps.length === 0) {
    return { ok: true };
  }
  if (JSON.stringify(costSteps).includes("target")) {
    return { ok: true };
  }
  try {
    return canPayStructuredCost(player, costSteps, { ...context, allowInteractiveSelection: true });
  } catch (error) {
    return { ok: true };
  }
}

async function useHandAbilityAction(card, ability, options = {}) {
  const owner = state.selected.owner;
  // R-BR10(ブラウザレビュー bt04-B3 発見): 使用コストが「攻撃されている自分のモンスターを手札に戻す」型
  //   （bt04-0047 ドラゴニック・カウンター等）だと、コスト実行で対象が場を離れ pending 攻撃が解消され、
  //   clearPendingAttack が state.selected=null にする。その後の removeSelectedFromHand が null 参照で失敗し、
  //   カードが手札に残ったまま効果も未実行＝コスト（ゲージ+モンスター）だけ払い損。コスト前に選択を控え、
  //   コスト後に state.selected が消えていてカードがまだ手札にあれば復元する（真に離場した場合は復元しない）。
  const selectedRefBeforeCost = { ...state.selected };
  const player = state.players[owner];
  // pt-final(1): コスト不足は対象選択の前に判定する（尊キ犠牲/外法 闇討ち: 対象を選ばせた後で「ゲージが
  // 足りません」になっていた）。判定は下の支払い（payStructuredCostWithSelection の冒頭）と同じ canPayStructuredCost。
  {
    const preSteps = adjustedAbilityCostSteps(player, card, ability);
    const preOpponentGauge = Boolean(
      ability.kind === "spell" && preSteps.some((step) => step.op === "payGauge" && step.amount > 0) && player.nextSpellCostMayUseOpponentGauge,
    );
    const prePayment = abilityCostPrecheck(player, preSteps, { sourceCard: card, selectedCard: card, includeOpponentGauge: preOpponentGauge });
    if (!prePayment.ok) {
      addLog(prePayment.reason);
      render();
      return;
    }
  }
  const targetChoice = await targetForAbilityUseDetailed(card, ability, owner);
  if (targetChoice.cancelled) {
    // T2（オーナー裁定 2026-10-14）: 宣言時の対象選択キャンセル＝使用の取りやめ（コスト未払い・手札のまま）。
    // allowMissingTarget でも「対象なしで続行」にはしない（竜木死灰: キャンセルでライフ+1だけ得ていた）。
    addLog(`${card.name}の使用を取りやめました。`);
    render();
    return;
  }
  const target = targetChoice.target;
  if (ability.target && !target && !abilityUsableWithoutTarget(ability)) {
    // Q3（オーナー裁定 2026-10-14）: 対象が無いときは使えない。例外は R7 の「〜し、〜」型（target 内
    // allowMissingTarget かつ対象に依存しない後段がある）だけ＝対象なしで後段を解決する（finder 側と同一判定）。
    addLog(`${card.name}の対象を選んでください。`);
    render(); // R-BR2: 早期リターン時の画面反映（表示のみ）
    return;
  }
  const costSteps = adjustedAbilityCostSteps(player, card, ability);
  // E-XB73(X2-SP/0041): 魔法の【使用コスト】でゲージを払う場合、nextSpellCostMayUseOpponentGauge が立っていれば
  // 相手ゲージからも払える（起動能力の useFieldAbilityAction:331 と同型・spell 限定）。共有ワンショットのため成立時は
  // 両フラグ（spell/activated）を消費する。0033 は spell flag を立てない＝魔法へは波及しない（起動側の挙動は不変）。
  const spellUsesGaugeCost = ability.kind === "spell" && costSteps.some((step) => step.op === "payGauge" && step.amount > 0);
  const includeOpponentGauge = Boolean(spellUsesGaugeCost && player.nextSpellCostMayUseOpponentGauge);
  const deckBeforeCost = player.deck.length;
  const lifeBeforeCost = player.life;
  const payment = await payStructuredCostWithSelection(player, costSteps, {
    sourceCard: card,
    selectedCard: card,
    includeOpponentGauge,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    render(); // R-BR2: 早期リターン時の画面反映（表示のみ）
    return;
  }
  if (includeOpponentGauge) {
    player.nextSpellCostMayUseOpponentGauge = false;
    player.nextActivatedCostMayUseOpponentGauge = false; // 共有ワンショット（魔法か起動どちらか1回）
  }
  // R-BR10: コストで pending が解消され state.selected が null 化されたが、使用札はまだ手札にある場合に復元。
  //   真に手札を離れた場合（下の usedCard 判定で中止）は復元しない＝既存のレースガードは維持。
  if (
    !state.selected &&
    selectedRefBeforeCost.source === "hand" &&
    state.players[selectedRefBeforeCost.owner]?.hand.some((c) => c.instanceId === selectedRefBeforeCost.instanceId)
  ) {
    state.selected = selectedRefBeforeCost;
  }
  const usedCard = removeSelectedFromHand();
  // 非同期誘発レースで選択カードが手札を離れていたら使用中止（callMonster と同型・fuzzer seed915）。
  if (!usedCard) {
    addLog(`${card.name}が手札にないため、使用を中止しました。`);
    render(); // R-BR2: 早期リターン時の画面反映（表示のみ）
    return;
  }
  // ability.landAsDiscard:「手札のこのカードを捨て」をコストとして持つ手札起動能力。宣言時に本体を手札から
  // 「捨てる」（discardHandCardsToDrop・byCost）＝手札破棄の自己誘発/場ブロードキャストを発火させ、以後の着地
  // （即時解決／pendingAction の fromHand 着地）では二重にドロップへ置かない。未指定＝従来どおり。
  const landedAsDiscard = Boolean(ability.landAsDiscard && ability.kind === "activated");
  if (landedAsDiscard) {
    discardHandCardsToDrop(player, [usedCard], { byCost: true, sourceOwner: owner, sourceCard: usedCard });
  }
  // ②プレイタイミング／【対抗】の流れ 2→3・同Q2/A2（HANDOFF のユーザー確認済み裁定メモ）: ターンファイターが使った
  // カード/能力に対して、非ターンファイターはその解決より先に【対抗】を1つ使える。攻撃中(pendingAttack)に攻撃側＝
  // ターンファイターが【対抗】で使ったカード/能力も、即時解決せず相手(防御側)への入れ子の対抗窓(pendingAction)を開く。
  // 防御側が攻撃中に使う【対抗】は従来どおり即時解決（＝ターンファイターは対抗の対抗をできない）。
  const opensNestedAttackWindow = Boolean(
    options.counterTiming &&
      state.pendingAttack &&
      !state.pendingAction &&
      owner === pendingAttackTurnSide() &&
      !counterWindowUseActive(owner), // 対抗窓改修: 誘発/ライフリンク窓への応答は入れ子の宣言窓を開かない
  );
  if (opensNestedAttackWindow && options.counterKind) {
    markCounterUsed(owner, options.counterKind); // 攻撃中の【対抗】1回を消費（即時解決経路と同じ記帳）
  }
  if ((!options.counterTiming || opensNestedAttackWindow) && ["spell", "impact"].includes(ability.kind)) {
    markAbilityLimit(owner, usedCard, ability);
    beginPendingAction({
      kind: ability.kind,
      owner,
      responder: 1 - owner,
      card: usedCard,
      ability,
      phase: state.phase,
      limitMarkedAtDeclare: true, // ④Q3: 無効化されたら resolvePendingSpell が記帳を取り消す
      // E-PR6(PR/0281 ルア・ノヴァ): 使用コストで捨てたカードを解決時の条件(costDiscardedCardMatches)へ渡す。
      costDiscardedCards: payment.discarded || [],
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : elements.effectTarget.value,
    });
    addLog(`${player.name}は${usedCard.name}の使用を宣言しました。対抗確認を行ってください。`);
    render();
    // 保存則: 使用コストの putTopDeckToDrop で山切れ／自傷でライフ0 等でこの宣言と同時に決着した場合、pending を
    // 宙吊りにせず即着地させる（fuzzer 恒久漏れ・seed51「シャドウ・クルセイダー」）。詳細は src/07 の同ヘルパー参照。
    await resolveDeclarationIfGameEnded(deckBeforeCost, lifeBeforeCost, player);
    return;
  }
  // 手札発動の起動能力（変身/搭乗の hand版 等、kind:"activated"）も宣言時に相手へ対抗機会を与える。
  // 場発動(useFieldAbilityAction)は既に対抗ウィンドウを開くが、手札発動は spell/impact 以外で
  // 即解決していた（＝変身時に対抗確認が出ない）ため、activated も pendingAction 経由にする。
  // fromHand で resolvePendingAbility 側がカードのドロップ着地/ロールバックを扱う。
  // ④1.2「相手に【対抗】タイミングが発生します」: 対抗窓への応答として使ったのでなければ、【対抗】を持つ【起動】でも
  // 宣言時に相手へ対抗機会を与える（以前は isCounterAbility なら窓を開かず即時解決していた＝総合レビュー rule-counter-3）。
  if (
    ((!options.counterTiming && !hasPendingResolution()) || opensNestedAttackWindow) &&
    ability.kind === "activated" &&
    !ability.noCounterWindow // E-XB56②: 「相手は【対抗】できず」= 宣言時に対抗ウィンドウを開かず即時解決へ落とす（下の即時解決経路が後続処理を担う）。未指定は従来どおり。
  ) {
    markAbilityLimit(owner, usedCard, ability);
    beginPendingAction({
      kind: "ability",
      owner,
      responder: 1 - owner,
      card: usedCard,
      ability,
      phase: state.phase,
      fromHand: true,
      landedAsDiscard, // landAsDiscard: 宣言時に捨て済み（resolvePendingAbility は着地させない）
      // T2/T3: 宣言でコストを払っていない手札起動は、解決中の最初の選択までなら取りやめ＝手札へ戻して使用前に戻せる。
      selectionRollbackable: !landedAsDiscard && !declarationCostCommits(costSteps),
      declaredBuddyCall: declareBuddyCallForEquipSelf(player, usedCard, ability), // 変身/搭乗/着任/必殺変身のバディギフト宣言
      limitMarkedAtDeclare: true, // ④Q3: 無効化されたら resolvePendingAbility が記帳を取り消す
      costDiscardedCards: payment.discarded || [], // E-PR6: 手札発動起動能力でも使用コストの捨て札を解決へ伝播
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : elements.effectTarget.value,
    });
    addLog(`${player.name}は${usedCard.name}の能力を宣言しました。対抗確認を行ってください。`);
    render();
    // 保存則: 手札発動(変身/搭乗等)のコストでこの宣言と同時に決着した場合も pending を宙吊りにせず即着地させる。
    await resolveDeclarationIfGameEnded(deckBeforeCost, lifeBeforeCost, player);
    return;
  }
  // rule-zones-8: ver2.05 キャストの流れ 3.「キャストしたカードの能力が解決されます。※解決された後、キャストしたカードは
  // ドロップゾーンに置かれます。」＝魔法/必殺技(spell/impact)は解決中はドロップに無い（resolvePendingSpell と同順序）。
  // 解決後、効果で自身が移動していなければ(cardMoved)ドロップへ置く。手札起動能力（変身/callSelfFromHand 等）は従来どおり
  // 先にドロップへ置く（equipSelf 等がドロップから回収/着地する既存の前提を保つ）。
  const castDropsAfterResolve =
    ["spell", "impact"].includes(ability.kind) &&
    !(Array.isArray(ability.script) && ability.script.some((s) => s?.op === "callSelfFromHand"));
  if (!castDropsAfterResolve && !landedAsDiscard) {
    player.drop.push(usedCard);
  }
  if (options.counterKind) {
    markCounterUsed(owner, options.counterKind);
  }
  if (options.counterTiming) {
    addLog(`${player.name}は${usedCard.name}を【対抗】で使いました。`);
  }
  const context = {
    card: usedCard,
    ability,
    player,
    owner,
    target,
    costDiscardedCards: payment.discarded || [], // E-PR6: 即時解決経路（対抗窓を挟まない）でも捨て札を渡す
    // T2: 即時解決経路で巻き戻せるのは「手札の自身コール」をコスト無しで宣言した時だけ（下の取りやめ処理が手札へ戻す）。
    __selectionRollbackable:
      !landedAsDiscard &&
      !declarationCostCommits(costSteps) &&
      Array.isArray(ability.script) &&
      ability.script.some((s) => s?.op === "callSelfFromHand"),
  };
  const bodyResult = await executeAbilityBody(context);
  if (castDropsAfterResolve && !context.cardMoved) {
    player.drop.push(usedCard);
  }
  // callSelfFromHand(手札の自身コール)を含む能力で、スクリプトが中断(コール先選択キャンセル等)し
  // 発生源カードがドロップに取り残された場合は、宣言不成立として手札へ戻す(カード喪失を防ぐ)。
  const usesCallSelf = Array.isArray(ability.script) && ability.script.some((s) => s?.op === "callSelfFromHand");
  if (bodyResult === false && usesCallSelf) {
    const onField = zones.some(
      (z) => player.field[z]?.instanceId === usedCard.instanceId,
    );
    const dropIndex = player.drop.findIndex((c) => c.instanceId === usedCard.instanceId);
    if (!onField && dropIndex >= 0) {
      player.drop.splice(dropIndex, 1);
      player.hand.push(usedCard);
      addLog(`${usedCard.name}のコールを取りやめ、手札に戻しました。`);
      state.selected = null;
      state.linkAttackers = [];
      render();
      return;
    }
  }
  markAbilityLimit(owner, usedCard, ability);
  // 「君が魔法を使った時」の場全体誘発（allySpellCast/opponentSpellCast）。
  // 通常のメインフェイズ魔法解決(resolvePendingSpell)では発火済みだが、このブロック（対抗タイミングでの
  // 手札魔法の即時解決等）ではこれまで未発火だった（決戦の地 ヴィーグリーズ 0053 等が取りこぼす）。
  // usedCard は直前で player.drop に積んでおり、場のカードとして自分自身を拾うことはないため
  // 自己反応の心配はない（既存の resolvePendingSpell と同じ安全性）。
  if (effectiveCardType(usedCard) === "spell") {
    recordSpellCastThisTurn(owner); // E-XB9: 対抗/即時手札魔法解決経路もターン内魔法使用回数へ算入
    await runFieldEventTriggers("spellCast", owner, usedCard, null, { spellCard: usedCard });
  }
  state.selected = null;
  state.linkAttackers = [];
  // E-XB42(X-BT04/0099 endCurrentTurn): 手札起動能力の即時解決経路（対抗窓を挟まない）で立った「現在ターン終了」
  // 予約もこの unwind 点で消費する（field 版と対）。pending 中は保留され後の resolvePendingResolution で終える。
  // 予約が無ければ no-op（後方互換）。
  await maybeEndPendingCurrentTurn();
  if (!hasPendingResolution()) {
    await runSizeRuleProcessing(); // E5: 即時解決した手札起動能力の後の★ルール処理★
  }
  render();
}

// loc を渡すと場以外（ドロップ等）からの起動にも使える。loc={owner, zone, inDrop, abilities?}。
// 省略時は state.selected を参照（従来の場の起動能力）。
async function useFieldAbilityAction(card, loc = null) {
  const owner = loc ? loc.owner : state.selected.owner;
  const zone = loc ? loc.zone : state.selected.zone;
  const inDrop = Boolean(loc?.inDrop);
  let usableAbilities =
    loc?.abilities || (inDrop ? findUsableDropAbilities(card, owner) : findUsableFieldAbilities(card, owner));
  // ②の流れ 6.: 対抗窓の外で非ターンファイターが使えるのは【対抗】を持つ能力だけ（相手のターンに【起動】だけの能力は使えない）。
  // 対抗窓改修: 誘発/ライフリンクの対抗窓で使う時は手番に関係なく【対抗】能力だけ（④2.2.1）。
  if ((!hasPendingResolution() && owner !== state.active) || counterWindowUseActive(owner)) {
    usableAbilities = usableAbilities.filter((ability) => isCounterAbility(ability));
  }
  // ソウル一覧から「この能力を使う」と名指しされた場合はそれに絞る（権威版は state.selected に載せて送る）。
  // 絞った結果が空なら（条件が変わった等）絞らず従来どおり全候補から選ばせる。
  const wantedAbilityId = loc?.abilityId ?? state.selected?.abilityId;
  const wantedSoulInstanceId = loc?.soulInstanceId ?? state.selected?.soulInstanceId;
  if (wantedAbilityId) {
    const narrowed = usableAbilities.filter(
      (ability) =>
        ability.id === wantedAbilityId &&
        (!wantedSoulInstanceId || ability.soulSourceCard?.instanceId === wantedSoulInstanceId),
    );
    if (narrowed.length > 0) {
      usableAbilities = narrowed;
    }
  }
  if (usableAbilities.length === 0) {
    // 理由（タイミング/1ターン1回/使用条件）を説明できるなら、それを出す。
    // 「ありません」だけだと、ソウルの能力が壊れているのか条件未達なのかユーザーが判別できない。
    const reasons = inDrop ? [] : describeUnusableFieldAbilities(card, owner);
    if (reasons.length > 0) {
      reasons.forEach((reason) => addLog(reason));
    } else {
      addLog(inDrop ? "今使えるドロップからの起動能力はありません。" : "今使える起動能力はありません。");
    }
    // R-BR2(ブラウザレビュー cp01-B2 発見): render() を呼ばず return していたため、不使用理由が state.log には
    // 入るのに画面(#logList)へは次の操作まで反映されず「クリックしても無反応」に見えた。表示のみの修正。
    render();
    return;
  }
  const ability =
    usableAbilities.length === 1 ? usableAbilities[0] : await chooseFieldAbility(card, usableAbilities, owner);
  if (!ability) {
    return; // 能力選択がキャンセルされた
  }
  const player = state.players[owner];
  const sourceCard = ability.fromSoul ? ability.soulSourceCard : card;
  // pt-final(1): コスト不足は対象選択の前に判定する（手札側 useHandAbilityAction と同じ）。
  {
    const preSteps = abilityCostSteps(sourceCard, ability);
    const preOpponentGauge = Boolean(
      ability.kind === "activated" && preSteps.some((step) => step.op === "payGauge" && step.amount > 0) && player.nextActivatedCostMayUseOpponentGauge,
    );
    const prePayment = abilityCostPrecheck(player, preSteps, { sourceCard, selectedCard: sourceCard, ability, includeOpponentGauge: preOpponentGauge, owner });
    if (!prePayment.ok) {
      addLog(prePayment.reason);
      render();
      return;
    }
  }
  // 起動能力は確認を挟まず即実行する（ユーザー方針「いきなり使えた方がいい」）。誤爆した場合の巻き戻しは
  // 「対象/カード選択のキャンセル」で行う＝盤面を変える前の中断なら resolvePendingAbility が使用回数を
  // 消費せず「使用前」に戻す（src/07・executeAbilityScript の __abilityProgressed）。
  const targetChoice = await targetForAbilityUseDetailed(sourceCard, ability, owner);
  if (targetChoice.cancelled) {
    // T2: 宣言時の対象選択キャンセル＝使用の取りやめ（コスト・使用回数とも未消費）。
    addLog(`${sourceCard.name}の使用を取りやめました。`);
    render();
    return;
  }
  const target = targetChoice.target;
  if (ability.target && !target && !abilityUsableWithoutTarget(ability)) {
    // R-BR1(ブラウザレビュー bt01-B4 発見・bt01-0061 実証): 場の起動能力側だけ allowMissingTarget の
    // 除外が漏れており、対象0件で常に中断していた（手札側 useHandAbilityAction:148 と非対称）。
    // finder 側（findUsableFieldAbilities/fieldAbilityUsable）は考慮済みのため「押せるのに何も起きない」
    // UI 齟齬になっていた。手札側と同一条件に統一（対象0でも後段効果だけ解決する宣言的フラグ）。
    addLog(`${card.name}の対象を選んでください。`);
    render(); // R-BR2: 早期リターン時の画面反映（表示のみ）
    return;
  }
  if (
    hasPendingResolution() &&
    !counterWindowUseActive(owner) && // 対抗窓改修: 誘発/ライフリンク窓は攻撃の対抗回数とは別の【対抗】タイミング
    (!isCounterAbility(ability) || !canUseCounterEffect(owner, selectedCounterKind(card)))
  ) {
    addLog("この攻撃中に使える【対抗】能力ではありません。");
    render(); // R-BR2: 早期リターン時の画面反映（表示のみ）
    return;
  }
  const usesGaugeCost = abilityCostSteps(sourceCard, ability).some((step) => step.op === "payGauge" && step.amount > 0);
  const includeOpponentGauge = Boolean(
    ability.kind === "activated" &&
      usesGaugeCost &&
      player.nextActivatedCostMayUseOpponentGauge
  );
  const payment = await payStructuredCostWithSelection(player, abilityCostSteps(sourceCard, ability), {
    sourceCard,
    selectedCard: sourceCard,
    ability,
    includeOpponentGauge,
    // E3(D-BT04/0033 グラトス): discardSoulToDeckBottom{amountFrom:{source:"targetStat"}} が、
    // 先に選んだ効果対象の打撃力を最小支払い量として読めるよう渡す（専用キー＝dropOwnMonster 等の
    // 既存 context.target 解決経路には触れない）。owner は controller 解決の整合用。
    effectTargetForCost: target,
    owner,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    render(); // R-BR2: 早期リターン時の画面反映（表示のみ）
    return;
  }
  if (includeOpponentGauge) {
    player.nextActivatedCostMayUseOpponentGauge = false;
    // E-XB73(X2-SP/0041): 「魔法か起動のどちらか1回」の共有ワンショット。起動でゲージを払った側が spell flag も
    // 落とす（0033 は spell flag を立てないため常に no-op＝既存の起動挙動は不変）。
    player.nextSpellCostMayUseOpponentGauge = false;
  }
  if (ability.soulSpellCast) {
    // E-XB45: 使用コスト支払い済み。ソウルの魔法を「使用」として spell の pendingAction へ流す（対抗窓→resolvePendingSpell）。
    await finalizeSoulSpellCast(card, sourceCard, ability, owner, player, target);
    return;
  }
  addAbilityUseLog(player, sourceCard, ability);
  // E-XB56②(X-UB03/0001 ギアゴッド ver.1ØØØØ『逆天殺ReBOOT』の「相手は【対抗】できず」): ability.noCounterWindow が立つと
  // 宣言時の対抗ウィンドウ(pendingAction)を開かず、下の即時解決経路へ落とす。即時解決経路は executeAbilityBody→markAbilityLimit→
  // maybeEndPendingCurrentTurn→render を賄うため自席の後続処理は不変。triggered 型 preventOpponentCounterThisTurn では
  // 「宣言そのもの」を遡れない（対抗ウィンドウが閉じた後にしか効かない）ため、宣言前バリアとして ability レベルにゲートする。
  // 未指定（既存カード全て）は false 扱いで従来どおり対抗ウィンドウを開く＝後方互換。
  // ④1.2: 起動能力の使用を宣言したら相手に【対抗】タイミングが発生する。対抗窓への応答として使ったのでなければ
  // 【対抗】を持つ起動能力でも窓を開く（総合レビュー rule-counter-3）。攻撃中に攻撃側(ターンファイター)が使う【対抗】起動も
  // 防御側への入れ子の窓を開く（②Q2/A2・rule-counter-2）。防御側の【対抗】は従来どおり即時解決。
  const opensNestedAttackWindow = Boolean(
    state.pendingAttack &&
      !state.pendingAction &&
      owner === pendingAttackTurnSide() &&
      isCounterAbility(ability) &&
      !counterWindowUseActive(owner), // 対抗窓改修: 窓への応答は即時解決
  );
  // 対抗窓改修: 誘発/ライフリンクの対抗窓への応答として使った【対抗】は、宣言の対抗窓を開かず即時解決する
  // （④2.2.3「その【対抗】を先に発動し、解決」・②Q2/A2 相手はさらに先に【対抗】できない）。
  if ((!hasPendingResolution() || opensNestedAttackWindow) && !ability.noCounterWindow && !counterWindowUseActive(owner)) {
    if (opensNestedAttackWindow) {
      markCounterUsed(owner, selectedCounterKind(card));
    }
    beginPendingAction({
      kind: "ability",
      owner,
      responder: 1 - owner,
      card: sourceCard,
      ability,
      phase: state.phase,
      zone,
      declaredBuddyCall: declareBuddyCallForEquipSelf(player, sourceCard, ability), // 場からの変身/搭乗/着任のバディギフト宣言
      // T2: 宣言でコストを払っていない起動だけ、解決中の最初の選択までキャンセル＝使用前へ戻せる（それ以外は強制選択）。
      selectionRollbackable: !declarationCostCommits(abilityCostSteps(sourceCard, ability)),
      hostCard: ability.fromSoul ? card : null,
      hostOwner: ability.fromSoul ? owner : null,
      hostZone: ability.fromSoul ? zone : null,
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : "",
    });
    addLog(`${player.name}は${sourceCard.name}の能力を宣言しました。対抗確認を行ってください。`);
    render();
    return;
  }
  await executeAbilityBody({
    card: sourceCard,
    ability,
    player,
    owner,
    zone,
    hostCard: card,
    hostOwner: owner,
    hostZone: zone,
    target,
  });
  if (hasPendingResolution() && isCounterAbility(ability)) {
    markCounterUsed(owner, selectedCounterKind(card));
  }
  markAbilityLimit(owner, sourceCard, ability);
  state.selected = null;
  state.linkAttackers = [];
  // E-XB42(X-BT04/0099 endCurrentTurn): 対抗窓を挟まず即時解決した場の起動能力（0099 逆天殺 の即時 counter 等、
  // hasPendingResolution が偽のイベント窓経路）で立った「現在ターン終了」予約をこの unwind 点で消費する。
  // pending 中（通常の対抗中）は maybeEndPendingCurrentTurn が保留し、後の resolvePendingResolution で終える。
  // 予約が無ければ no-op（後方互換）。useDropAbilityAction はこの関数へ委譲するためドロップ起動も同時に賄う。
  await maybeEndPendingCurrentTurn();
  if (!hasPendingResolution()) {
    await runSizeRuleProcessing(); // E5: 即時解決した場の起動能力の後の★ルール処理★
  }
  render();
}

// E-XB45(エルシニアス): ソウルの魔法を「使用」として確定させる。使用コストは呼び出し元(useFieldAbilityAction)で支払い済み。
// ソウルからホスト外へ抜き（＝使用後の行き先はドロップ。原文「魔法を使う」＝通常魔法と同じく解決後ドロップゾーンへ）、
// spell の pendingAction を開いて相手へ対抗機会を与える。resolvePendingSpell(src/07)が本体解決・ドロップ着地・
// 「君が魔法を使った時」(spellCast)誘発・named-once 記帳を賄う（手札魔法と同一の解決経路＝忠実）。
async function finalizeSoulSpellCast(hostCard, spellCard, ability, owner, player, target) {
  const soul = hostCard.soul || [];
  const idx = soul.findIndex((c) => c.instanceId === spellCard.instanceId);
  if (idx < 0) {
    // 非同期誘発レースでソウルから抜けていたら中止（callMonster と同型のガード）。
    addLog(`${spellCard.name}がソウルにないため、使用を中止しました。`);
    render(); // R-BR2: 早期リターン時の画面反映（表示のみ）
    return;
  }
  const removed = soul.splice(idx, 1)[0];
  // named-once（「1ターンに1回だけ使える」）は宣言＝コスト支払い済みのこの時点で記帳（手札魔法 src/13:177 と同順序）。
  markAbilityLimit(owner, removed, ability);
  beginPendingAction({
    kind: "spell",
    owner,
    responder: 1 - owner,
    card: removed,
    ability,
    phase: state.phase,
    limitMarkedAtDeclare: true, // ④Q3: 無効化されたら resolvePendingSpell が記帳を取り消す
    // E-XB50(X-CBT01/0030 秘剣 斬流雷牙「『秘剣 絶命陣』のソウルから使われていたなら」): soul-cast の
    // ホストカードを spell の pendingAction へ伝搬し、解決時に castFromSoulHostMatches で照合できるようにする。
    // resolvePendingSpell が action.hostCard を context.hostCard へ渡す。ホストは場札＝両席可視でT13安全。
    hostCard,
    effectTargetValue: target ? encodeTarget(target.owner, target.zone) : "",
  });
  addLog(`${player.name}は${removed.name}（${hostCard.name}のソウル）の使用を宣言しました。対抗確認を行ってください。`);
  render();
}

async function targetForAbilityUse(card, ability, owner) {
  return (await targetForAbilityUseDetailed(card, ability, owner)).target;
}

// 宣言時の対象決定。{ target, cancelled } を返す（cancelled＝利用者が対象選択を取り消した＝宣言の取りやめ）。
async function targetForAbilityUseDetailed(card, ability, owner) {
  if (!ability.target) {
    return { target: getEffectTargetInfo(), cancelled: false };
  }
  const current = getEffectTargetInfo();
  if (current && targetMatchesSpec(current, ability.target, owner, { card, ability })) {
    return { target: current, cancelled: false };
  }
  return chooseAbilityTargetDetailed(card, ability, owner);
}

// Q3（オーナー裁定 2026-10-14「対象が無いときは使えない」）: 魔法・必殺技・【起動】を対象候補0件で使えるか。
// R7（2026-10-09）の「〜し、〜」型＝target 内 allowMissingTarget を持ち、かつ対象（$target）に依存しない効果が
// 1つ以上ある能力だけが「対象なしで使用し後段を解決」できる。全効果が対象依存（見えたぞ、そこだっ！ の
// destroy $target のみ等）なら target 内 allowMissingTarget があっても対象0件では使えない。
// 依存判定は tests/data-defect-fixes.regression.js の R7 走査と同一（$target 参照／lastDestroy・targetStill・targetMatches 条件）。
const abilityTargetIndependenceCache = new WeakMap();
function abilityHasTargetIndependentEffect(ability) {
  if (!ability || typeof ability !== "object") {
    return false;
  }
  if (abilityTargetIndependenceCache.has(ability)) {
    return abilityTargetIndependenceCache.get(ability);
  }
  const body = [...(ability.effects || []), ...(Array.isArray(ability.script) ? ability.script : [])];
  const result = body.some(
    (effect) =>
      !JSON.stringify(effect).includes("$target") &&
      !/lastDestroy|targetStill|targetMatches/.test(JSON.stringify(effect?.conditions || [])),
  );
  abilityTargetIndependenceCache.set(ability, result);
  return result;
}

function abilityUsableWithoutTarget(ability) {
  return Boolean(ability?.target?.allowMissingTarget) && abilityHasTargetIndependentEffect(ability);
}

function addAbilityUseLog(player, card, ability) {
  if (isFieldActivatedAbility(ability)) {
    addLog(`${player.name}は${card.name}の【起動】を使いました。`);
  }
}

function fieldAbilityUsable(card, ability, owner, timing) {
  if (ability.fromHandOnly) {
    return false;
  }
  if (!isFieldActivatedAbility(ability)) {
    return false;
  }
  if (!abilityTimingIncludes(ability, timing)) {
    return false;
  }
  if (isAbilityLimitUsed(owner, card, ability)) {
    return false;
  }
  if (ability.target && !abilityUsableWithoutTarget(ability) && targetCandidatesFromSpec(ability.target, owner, { card, ability }).length === 0) {
    return false;
  }
  return (
    // context.card を渡す（対抗ウィンドウ中は state.selected が攻撃側等の別カードになり得るため、
    // pendingBattleInvolvesSelf 等の「このカード」系条件が発生源カードを正しく参照できるように）。
    checkAbilityConditions(ability, owner, { card }) &&
    canSatisfyAbilityScript(card, ability, owner, { zone: state.selected?.zone })
  );
}

// 使用可能な場の起動能力を「すべて」返す（直接＋ソウル）。
// 変身/搭乗(モンスタースペースからの装備)と別の【起動】が同時に使える場合など、
// 複数ある時は useFieldAbilityAction で選択させる。
function findUsableFieldAbilities(card, owner = state.selected?.owner ?? state.active) {
  const phaseCallRightAbilities = findPhaseCallRightAbilities(card, owner); // プレイヤーのコール権＝カードの無効化と独立
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  if (isAbilitiesNullified(card)) {
    // 能力無効化(凍てつく星辰)されたカードの起動能力は使えない。ただし ability.cannotBeNullified
    // （「この能力は無効化されない」）の印字起動だけは使える。既存カードは未所持＝従来どおり []。
    return (card.abilities || []).filter(
      (ability) => ability.cannotBeNullified && fieldAbilityUsable(card, ability, owner, timing),
    ).concat(phaseCallRightAbilities);
  }
  const direct = (card.abilities || []).filter((ability) => fieldAbilityUsable(card, ability, owner, timing));
  return [...direct, ...findUsableSoulAbilities(card, owner, timing), ...findCastableSoulSpells(card, owner, timing), ...phaseCallRightAbilities];
}

// grantPhaseCallRight(src/15)で記帳された「このアタックフェイズ中、このカードのソウルの filter 一致モンスターを
// コールできる」権利を、発生源カード(card)の起動候補として列挙する（逆天戦艦 サツキG X-CBT01/0008）。
// 権利はプレイヤーのものなので発生源の能力無効化では消えず、回数制限も無い（ソウルに候補がある限り何度でも）。
// 有効なのは記帳したターンのアタックフェイズ中だけ（フェイズ移行・ターン終了で失効）。実行は既存の callSelected 経路
// （free=【コールコスト】無し）。記帳が無い既存の盤面では常に [] ＝従来と完全一致。
function findPhaseCallRightAbilities(card, owner) {
  const rights = state.phaseCallRights?.[owner];
  if (!card || !Array.isArray(rights) || rights.length === 0 || state.phase !== "attack") {
    return [];
  }
  const slot = findFieldCardSlot(card);
  const right = rights.find(
    (entry) => entry.sourceInstanceId === card.instanceId && entry.turnCount === state.turnCount && entry.from === "soul",
  );
  if (!right || slot?.owner !== owner) {
    return [];
  }
  const ability = {
    id: `phase-call-right-${card.instanceId}`,
    label: "ソウルからコール",
    kind: "activated",
    timing: ["attack", "counter"],
    phaseCallRight: true,
    script: [
      {
        op: "selectCards",
        var: "call",
        from: "soul",
        controller: "self",
        filter: deepClone(right.filter || {}),
        amount: 1,
        min: 1,
        max: 1,
        callable: true,
        title: card.name,
        lead: `${right.free ? "【コールコスト】を払わず" : ""}コールする、${card.name}のソウルのモンスターを選んでください。`,
      },
      { op: "selectZone", var: "z", cardVar: "call" },
      { op: "callSelected", var: "call", zoneVar: "z", resolveOnEnter: true, ...(right.free ? {} : { payCost: "call" }) },
    ],
  };
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  if (!abilityTimingIncludes(ability, timing) || !canSatisfyAbilityScript(card, ability, owner, { zone: slot.zone })) {
    return [];
  }
  return [ability];
}

function findUsableFieldAbility(card, owner = state.selected?.owner ?? state.active) {
  return findUsableFieldAbilities(card, owner)[0] || null;
}

// ドロップゾーンのカードが持つ、ドロップから発動できる起動能力（fromDropZone:true）で今使えるものを返す。
// 例: 墓場のDJ ブネ(BT03/0014)・炎王の舎弟リッキー(BT03/0018)・百鬼将ギシンギュウキ(EB03/0002)。
// 場のカードと違い state.selected を使わず、対象カードがドロップにある前提で条件(sourceZoneIn:[drop]等)を評価する。
function findUsableDropAbilities(card, owner) {
  // 能力無効化中は ability.cannotBeNullified の能力だけ残す（既存カードは未所持＝従来どおり []）。
  const abilitiesNullified = isAbilitiesNullified(card);
  if (abilitiesNullified && !(card.abilities || []).some((a) => a?.cannotBeNullified)) {
    return [];
  }
  // 手番/応答者ガード（場の起動と同じ規約）: 対抗ウィンドウ中は攻撃/行動の当事者のみ、平時は手番プレイヤーのみ。
  const mayAct = state.pendingAttack
    ? [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(owner)
    : state.pendingAction
      ? owner === state.pendingAction.responder
      : owner === state.active;
  if (!mayAct) {
    return [];
  }
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  return (card.abilities || []).filter(
    (ability) =>
      ability.kind === "activated" &&
      (!abilitiesNullified || ability.cannotBeNullified) &&
      ability.fromDropZone &&
      !ability.fromHandOnly &&
      abilityTimingIncludes(ability, timing) &&
      !isAbilityLimitUsed(owner, card, ability) &&
      (!ability.target ||
        targetCandidatesFromSpec(ability.target, owner, { card, ability, zone: "drop" }).length > 0) &&
      checkAbilityConditions(ability, owner, { card, owner, zone: "drop" }) &&
      canSatisfyAbilityScript(card, ability, owner, { zone: "drop" }),
  );
}

// ドロップのカードの起動能力を発動する（UIのドロップ一覧から呼ぶ）。
async function useDropAbilityAction(owner, card) {
  const usableAbilities = findUsableDropAbilities(card, owner);
  if (usableAbilities.length === 0) {
    addLog("今使えるドロップからの起動能力はありません。");
    return false;
  }
  await useFieldAbilityAction(card, { owner, zone: "drop", inDrop: true, abilities: usableAbilities });
  return true;
}

// ドロップに、今 owner が発動できる起動能力を持つカードがあるか（UIでボタンを出すかの判定）。
function hasUsableDropAbility(owner) {
  return (state.players[owner]?.drop || []).some((card) => findUsableDropAbilities(card, owner).length > 0);
}

function findUsableSoulAbilities(hostCard, owner, timing) {
  const result = [];
  for (const soulSourceCard of hostCard?.soul || []) {
    for (const ability of soulSourceCard.soulAbilities || []) {
      const soulAbility = {
        ...ability,
        fromSoul: true,
        soulSourceCard,
      };
      if (!isFieldActivatedAbility(soulAbility)) {
        continue;
      }
      if (!abilityTimingIncludes(soulAbility, timing)) {
        continue;
      }
      if (isAbilityLimitUsed(owner, soulSourceCard, soulAbility)) {
        continue;
      }
      if (
        !checkAbilityConditions(soulAbility, owner, {
          card: soulSourceCard,
          hostCard,
          hostOwner: owner,
          hostZone: findFieldCardSlot(hostCard)?.zone,
        })
      ) {
        continue;
      }
      result.push(soulAbility);
    }
  }
  return result;
}

function findUsableSoulAbility(hostCard, owner, timing) {
  return findUsableSoulAbilities(hostCard, owner, timing)[0] || null;
}

// E-XB45(X-CBT02/0075 “死灰魔導” エルシニアス): 「君はこのカードのソウルにある《病》の魔法を【使用コスト】を払って使える」。
// fromDropZone 活性（墓場のDJ 0014）の兄弟＝「fromSoulOf(ホスト)」型のキャスト経路。host が top-level フィールド
// soulSpellCast:{filter} を持つとき、ソウル内の filter 一致「魔法カード」を、その魔法自身の spell 能力（使用コスト＋効果）で
// キャスト可能にする。合成能力を { ...spellAbility, fromSoul, soulSpellCast, soulSourceCard } として返し、
// useFieldAbilityAction が spell の pendingAction（＝対抗窓・解決後ドロップ着地・spellCast 誘発・named-once 記帳）へ流す。
// 未設定（soulSpellCast を持たない既存の全ホスト）は即空配列＝バイト不変（後方互換）。host 無効化時は呼び出し元
// findUsableFieldAbilities が [] を返すため、この経路も自動的に停止する（能力無効化＝soul-cast も不可）。
function findCastableSoulSpells(hostCard, owner, timing) {
  const spec = hostCard?.soulSpellCast;
  if (!spec) {
    return [];
  }
  // 通常魔法はターンプレイヤーのメインフェイズのみ使用可（対抗窓/攻撃・ファイナルフェイズでは出さない）。
  // 病の魔法（大魔法群・ワールド・パンデミック）は全てメイン魔法のため、この主枠に限定する（counter 魔法の soul-cast は将来対応）。
  if (timing !== "main" || owner !== state.active) {
    return [];
  }
  const result = [];
  for (const soulCard of hostCard.soul || []) {
    if (spec.filter && !matchesCardFilter(soulCard, spec.filter)) {
      continue;
    }
    const spellAbility = (soulCard.abilities || []).find((ability) => ability.kind === "spell");
    if (!spellAbility) {
      continue;
    }
    // カードレベルの useConditions（例: 8枚以上）も手札キャストと同様にゲートする。
    if (!checkCardConditions(soulCard.useConditions || [], owner, { card: soulCard, owner })) {
      continue;
    }
    const synthetic = { ...spellAbility, fromSoul: true, soulSpellCast: true, soulSourceCard: soulCard };
    if (isAbilityLimitUsed(owner, soulCard, synthetic)) {
      continue; // named-once（「1ターンに1回だけ使える」）は spell の name ベースキー＝手札/ソウル複製で合算（既存規約）
    }
    if (
      synthetic.target &&
      !abilityUsableWithoutTarget(synthetic) &&
      targetCandidatesFromSpec(synthetic.target, owner, { card: soulCard, ability: synthetic }).length === 0
    ) {
      continue;
    }
    if (!checkAbilityConditions(synthetic, owner, { card: soulCard, owner })) {
      continue;
    }
    if (!canSatisfyAbilityScript(soulCard, synthetic, owner, {})) {
      continue;
    }
    result.push(synthetic);
  }
  return result;
}

// 場のカードに使える起動能力が複数ある時、どれを使うか選ばせる。
// 例: モンスタースペースのキャプテン・アンサーは「変身で装備」と「アンサークエスチョン」の両方が使える。
async function chooseFieldAbility(card, abilities, owner) {
  if (globalThis.__BUDDYFIGHT_TEST__ && typeof globalThis.__forcedFieldAbilityId === "string") {
    return abilities.find((ability) => ability.id === globalThis.__forcedFieldAbilityId) || abilities[0];
  }
  const selected = await chooseCardEntries(
    abilities.map((ability) => ({
      ability,
      card: {
        name: fieldAbilityLabel(card, ability),
        type: "choice",
      },
    })),
    {
      // 対抗窓では対抗能力も並ぶため「起動能力」と決め打ちしない（ソウルの対抗を選ぶ場面がある）。
      title: `${card.name}の能力`,
      lead: "使う能力を選んでください（ソウルの能力もここに並びます）。",
      min: 1,
      max: 1,
      forceDialog: true,
      allowCancel: true,
      purpose: "ability-pick", // CPU対戦(src/22): 複数の起動能力からの選択
      promptSeat: owner,
    },
  );
  return selected?.[0]?.ability || null;
}

// 「今使える起動能力はありません。」だけだと、能力が壊れているのか条件を満たしていないだけなのかが
// 分からない（ソウルの能力は特に、ホストのカードしか見えないので原因が追えない）。宣言されている
// 起動/対抗能力を1つずつ見て、最初に引っかかったゲート（タイミング / 1ターン1回 / 使用条件）を返す。
// カード名のハードコードはせず、条件 op から汎用に説明する（説明できない op は理由なしで従来文言）。
const ABILITY_TIMING_LABELS = { ...phaseLabels, counter: "対抗" };
const ABILITY_ZONE_LABELS = {
  hand: "手札",
  drop: "ドロップ",
  left: "モンスタースペース",
  center: "モンスタースペース",
  right: "モンスタースペース",
  item: "アイテム枠",
  item2: "アイテム枠",
  item3: "アイテム枠",
  item4: "アイテム枠",
};

function describeAbilityCondition(condition) {
  if (!condition || typeof condition !== "object") {
    return null;
  }
  if (condition.op === "lifeLte") return `自分のライフ${condition.amount}以下`;
  if (condition.op === "lifeGte") return `自分のライフ${condition.amount}以上`;
  if (condition.op === "lifeCount") {
    const who = condition.controller === "opponent" ? "相手" : "自分";
    const cmp = condition.cmp === "lte" ? "以下" : condition.cmp === "eq" ? "ちょうど" : "以上";
    const amount = condition.amount ?? 0;
    return condition.cmp === "eq" ? `${who}のライフが${amount}` : `${who}のライフ${amount}${cmp}`;
  }
  if (condition.op === "phaseIs") return `${ABILITY_TIMING_LABELS[condition.phase] || condition.phase}フェイズ中`;
  if (condition.op === "turnOwnerIsSelf") return "自分のターン中";
  if (condition.op === "turnOwnerIsOpponent") return "相手のターン中";
  if (condition.op === "reversalUsedThisFight") return "このファイト中に『逆天』を使っていること";
  if (condition.op === "destroyedThisFightMatchingCountGte") return "このファイト中に条件を満たすカードが破壊されていること";
  if (condition.op === "targetStillOnField") return "選んだカードが場にいること";
  if (condition.op === "deckMilledThisTurn") {
    const who = condition.deckOwner === "opponent" ? "相手" : "自分";
    const n = condition.amount ?? 1;
    return `このターン中、${who}のデッキのカードが${n > 1 ? `${n}枚以上` : ""}ドロップに置かれていること`;
  }
  if (condition.op === "damageTakenThisTurn") {
    const who = condition.damageOwner === "opponent" ? "相手" : "自分";
    const n = condition.amount ?? 1;
    return `このターン中、${who}が${n > 1 ? `${n}以上の` : ""}ダメージを受けていること`;
  }
  if (condition.op === "gaugePlacedThisTurnLte") {
    const who = condition.controller === "opponent" ? "相手" : "自分";
    const n = condition.amount ?? 0;
    return n <= 0 ? `このターン中、${who}のゲージにカードが置かれていないこと` : `このターン中、${who}のゲージに置かれたカードが${n}枚以下であること`;
  }
  if (condition.op === "hostMatches") return "装備している（搭乗/変身）カードの条件";
  if (condition.op === "sourceStanding") return "このカードがスタンドしていること";
  if (condition.op === "sourceZoneIn") {
    // left/center/right や item/item2… は同じ表示名に畳む（「モンスタースペース・モンスタースペース…」を防ぐ）。
    const zoneNames = [
      ...new Set((condition.zones || []).map((zone) => ABILITY_ZONE_LABELS[zone] || (isSetZone(zone) ? "設置魔法" : isItemZone(zone) ? "アイテム枠" : zone))),
    ].join("・");
    return zoneNames ? `このカードが${zoneNames}にあること` : null;
  }
  return null;
}

// ability の発生源表示名（ソウルの能力はソウルのカード名を出す。ホスト名だけでは何の能力か分からない）。
function abilitySourceLabel(card, ability) {
  return ability.fromSoul && ability.soulSourceCard?.name
    ? `ソウルの${ability.soulSourceCard.name}`
    : card.name;
}

// 使えない理由の説明を配列で返す（説明できるものが無ければ空配列＝呼び元は従来の文言に落とす）。
// options.soulCard を渡すと、そのソウルカードが持つ能力の理由だけに絞る（ソウル詳細シート用）。
function describeUnusableFieldAbilities(card, owner, options = {}) {
  // 能力無効化中でも ability.cannotBeNullified の印字起動は使える（その能力だけは理由を個別に説明する）。
  const abilitiesNullified = isAbilitiesNullified(card);
  if (abilitiesNullified && (options.soulCard || !(card.abilities || []).some((a) => a?.cannotBeNullified && isFieldActivatedAbility(a)))) {
    return [`${card.name}の能力は無効化されています。`];
  }
  const onlySoulCard = options.soulCard || null;
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  const declared = abilitiesNullified
    ? (card.abilities || []).filter((a) => a?.cannotBeNullified && isFieldActivatedAbility(a)).map((ability) => ({ ...ability }))
    : [
    ...(onlySoulCard ? [] : (card.abilities || []).filter(isFieldActivatedAbility).map((ability) => ({ ...ability }))),
    ...(card.soul || [])
      .filter((soulCard) => !onlySoulCard || soulCard.instanceId === onlySoulCard.instanceId)
      .flatMap((soulCard) =>
        (soulCard.soulAbilities || [])
          .filter(isFieldActivatedAbility)
          .map((ability) => ({ ...ability, fromSoul: true, soulSourceCard: soulCard })),
      ),
  ];
  // 宣言されている能力を**すべて**説明する。最初の1件で打ち切ると、ホスト自身の能力の理由だけを出して
  // 肝心のソウルの能力に触れない（＝ユーザーが探している能力の理由が出ない）。
  const reasons = [];
  for (const ability of declared) {
    const who = abilitySourceLabel(card, ability);
    const kindLabel = isCounterAbility(ability) ? "対抗能力" : "起動能力";
    if (!abilityTimingIncludes(ability, timing)) {
      const allowed = (ability.timing || []).map((t) => ABILITY_TIMING_LABELS[t] || t).join("・");
      reasons.push(
        allowed
          ? `${who}の${kindLabel}は今のタイミングでは使えません（${allowed}）。`
          : `${who}の${kindLabel}は今のタイミングでは使えません。`,
      );
      continue;
    }
    if (isAbilityLimitUsed(owner, ability.soulSourceCard || card, ability)) {
      reasons.push(`${who}の${kindLabel}はこのターン既に使用しています。`);
      continue;
    }
    const conditionContext = ability.fromSoul
      ? {
          card: ability.soulSourceCard,
          hostCard: card,
          hostOwner: owner,
          hostZone: findFieldCardSlot(card)?.zone,
        }
      : { card };
    const failing = (ability.conditions || []).find(
      (condition) => !checkCardConditions([condition], owner, conditionContext),
    );
    if (failing) {
      const desc = describeAbilityCondition(failing);
      reasons.push(
        desc
          ? `${who}の${kindLabel}は使用条件を満たしていません（${desc}）。`
          : `${who}の${kindLabel}は使用条件を満たしていません。`,
      );
    }
  }
  // 同一文言（同じカードの同型能力が複数など）は畳む。多すぎるとログが埋まるので上限3件。
  return [...new Set(reasons)].slice(0, 3);
}

// ver2.05 ④『変身』『搭乗』『着任』『必殺変身』「…アイテムの装備として扱います。ただし、バディギフトによりライフを＋１
// することはできます」・①アイテムの装備の流れ「※『変身』『搭乗』『必殺変身』も同様の流れで行います」1.2（バディコールに
// するか決定）/3.2（場に置かれたならバディギフトでライフ+1）。equipSelf を含む能力を自分のバディ（同名）で宣言し、まだ
// バディコールしていなければ、宣言時にバディコール権を消費する（equipItem の E4 と同じ扱い）。+1 は解決時（equipSelf→
// equipCardDirect の declaredBuddyCall）で、無効化されたら付かない。
// 2026-10-09 オーナー裁定R10: 「手札のこのカードを装備する」等の、能力の効果による装備（equipSelf{effectEquip:true}）は
// 宣言を経ない装備＝バディギフト無し・バディコール権も消費しない（効果によるコールと同じ扱い）。宣言の対象外にする。
function declareBuddyCallForEquipSelf(player, card, ability) {
  const isDeclaredEquipSelf = (op) => op?.op === "equipSelf" && !op.effectEquip;
  const equipsSelf =
    (ability?.effects || []).some(isDeclaredEquipSelf) ||
    (Array.isArray(ability?.script) && ability.script.some(isDeclaredEquipSelf));
  if (!equipsSelf || !player || player.partnerCalled || !isBuddyCard(player, card)) {
    return false;
  }
  player.partnerCalled = true;
  return true;
}

function fieldAbilityLabel(card, ability) {
  if (ability.label) {
    return ability.label;
  }
  const isEquipSelf =
    (ability.effects || []).some((effect) => effect.op === "equipSelf") ||
    (ability.script || []).some((step) => step.op === "equipSelf");
  if (isEquipSelf) {
    // pt-fix-c T7-8: 手札版/場版に分けた『変身』『搭乗』等を区別できるよう出所と能力名（キーワード）を補う。
    const keywordName = { transform: "変身", boarding: "搭乗", arrival: "着任", impactTransform: "必殺変身" }[ability.keyword] || "";
    const where = ability.fromHandOnly ? "手札から" : ability.fromFieldOnly ? "場から" : "";
    if (keywordName || where) {
      return `このカードを装備する（${[keywordName || "変身／搭乗", where].filter(Boolean).join("・")}）`;
    }
    return "このカードを装備する（変身／搭乗）";
  }
  const derived = ability.name ? null : derivedAbilityLabel(ability.__fromSoul || ability.soulSourceCard || card, ability);
  const base = ability.name || derived || (isCounterAbility(ability) ? "対抗能力" : "起動能力");
  // ソウルの能力は発生源（ソウルにあるカード）を明示する。ホスト（武器/変身元）の名前しか出さないと、
  // ホスト自身の能力とソウルの能力が同じ「起動能力」ラベルで並び、どちらがソウルのものか選べない
  // （アーマナイト系＝武器のソウルに入って起動/対抗を与えるカードで顕在化）。
  if (ability.fromSoul && ability.soulSourceCard?.name) {
    return `ソウル: ${ability.soulSourceCard.name} の${base}`;
  }
  return base;
}

// pt-fix-c T7-8: label/name の無い同種の能力（起動/使用）が2つ以上あるカードでは「起動能力」「対抗能力」だけが
// 並び選べなかった（86枚）。カードの rules（公式テキスト）から該当行を引き、短い表示名を作る。
// 該当行の対応: 起動能力＝【起動】を含む行、魔法/必殺技の能力＝「・」で始まる選択肢行（無ければ効果行）を、同種の
// 能力の並び順で対応させる。“名前”があればそれ、無ければ最初の文を短く切る。手札/場の別は補足する。
function abilityLabelCategory(ability) {
  if (["spell", "impact"].includes(ability?.kind)) return "cast";
  if (ability?.kind === "activated") return "activated";
  return null;
}

function isEquipSelfAbilityForLabel(ability) {
  return (
    (ability.effects || []).some((effect) => effect.op === "equipSelf") ||
    (Array.isArray(ability.script) && ability.script.some((step) => step?.op === "equipSelf"))
  );
}

function summarizeRulesLineForLabel(line) {
  const raw = String(line || "").replace(/^[■・\s]+/, "");
  const counter = /【対抗】/.test(raw);
  const quoted = raw.match(/[“"]([^”"]{1,24})[”"]/);
  if (quoted) {
    return `${counter ? "【対抗】" : ""}“${quoted[1]}”`;
  }
  let body = raw.replace(/【対抗】|【起動】/g, "").trim();
  const sentenceEnd = body.indexOf("。");
  if (sentenceEnd > 0) body = body.slice(0, sentenceEnd);
  if (body.length > 30) body = `${body.slice(0, 30)}…`;
  return `${counter ? "【対抗】" : ""}${body}`;
}

function derivedAbilityLabel(card, ability) {
  const category = abilityLabelCategory(ability);
  if (!category || !card) {
    return null;
  }
  const peers = (card.abilities || []).filter(
    (entry) =>
      abilityLabelCategory(entry) === category && !entry.label && !entry.name && !entry.keyword && !isEquipSelfAbilityForLabel(entry),
  );
  const index = peers.findIndex((entry) => entry === ability || (entry.id && entry.id === ability.id));
  if (peers.length < 2 || index < 0) {
    return null;
  }
  const rawLines = Array.isArray(card.rules) ? card.rules : [];
  let lines;
  if (category === "activated") {
    lines = rawLines.filter((line) => /【起動】/.test(line));
  } else {
    lines = rawLines.filter((line) => /^\s*・/.test(line));
    if (lines.length === 0) {
      lines = rawLines.filter(
        (line) => !/【(使用|コール|装備)コスト】|使える|使用できる|次の.つから|全てのフラッグ/.test(line),
      );
    }
  }
  let text = null;
  if (lines.length === peers.length) {
    text = summarizeRulesLineForLabel(lines[index]);
  } else if (lines.length === 1) {
    text = summarizeRulesLineForLabel(lines[0]);
  }
  // 同じ行を手札/場/ドロップの別能力に分けた実装（「手札か場のこのカードを…」）は出所を補う。
  const origin = ability.fromHandOnly ? "手札から" : ability.fromFieldOnly ? "場から" : ability.fromDropZone ? "ドロップから" : "";
  const originsDiffer = new Set(peers.map((entry) => (entry.fromHandOnly ? "h" : entry.fromFieldOnly ? "f" : entry.fromDropZone ? "d" : ""))).size > 1;
  if (!text) {
    const base = isCounterAbility(ability) ? "対抗能力" : category === "activated" ? "起動能力" : "効果";
    return `${base}${index + 1}${origin && originsDiffer ? `（${origin}）` : ""}`;
  }
  if (lines.length !== peers.length && origin && originsDiffer) {
    return `${text}（${origin}）`;
  }
  return text;
}

function isFieldActivatedAbility(ability) {
  return ability.kind === "activated" || hasAbilityKeyword(ability, "reversal");
}

function abilityTimingIncludes(ability, phase) {
  const timings = ability.timing || [];
  if (timings.length === 0 || timings.includes(phase)) {
    return true;
  }
  // 2018年6月以前ルール: 【対抗】を持つカード/能力は、対抗ウィンドウ(pending時=timing"counter")だけでなく
  // 自分のターン中の各フェイズでも使える。攻撃したモンスターをスタンドして再攻撃する等、アタックフェイズ中の
  // 対抗起動が正規の用法（城ヶ崎莉嘉 S-UB-C03/0018 の《パッション》スタンド等）。以前はメイン限定だったため
  // 場の対抗起動がアタックフェイズで「使用タイミングじゃない」と弾かれていた。手札の対抗カード
  // (isCounterPlayTiming)と同じ COUNTER_PLAY_PHASES を共有し、手札/場の非対称を解消する。
  return timings.includes("counter") && COUNTER_PLAY_PHASES.includes(phase);
}

function checkAbilityConditions(ability, owner, context = {}) {
  return checkCardConditions(ability.conditions, owner, context);
}

function checkCardConditions(conditions = [], owner, context = {}) {
  return (conditions || []).every((condition) => checkCondition(condition, owner, context));
}

// 裁定 R9（2026-10-09 オーナー裁定）: 「そのターン中、〜なら、…」の「〜なら」は使用時/解決時のゲートではなく、
// ターン中ずっと判定する継続条件（後から満たせば効き、満たさなくなれば外れる）。効果に
// `whileConditions:[...]`（条件語彙は conditions と同じ）を書くと、効果は条件に関わらず解決してターン限定の記帳を作り、
// 記帳の読み手が適用のたびに whileConditionsHold で再評価する。effect の `conditions` は従来どおり解決時ゲート（後方互換）。
// 判定の主体は効果を解決した席（owner）。発生源カードは場に残らない（魔法）ことが多いので context は owner/player のみ。
// 記帳は JSON プレーン（state 常駐＝部屋復元/リプレイで往復可）。対応済みの記帳: restrictCallThisTurn（callRestrictionsThisTurn）/
// preventAllDamageThisTurn（damagePrevention キュー）。新しいターン限定ストアに対応させる時は、記帳時に captureWhileConditions、
// 読み手で whileConditionsHold を通すこと。
function captureWhileConditions(effect, owner) {
  const list = effect?.whileConditions;
  if (!Array.isArray(list) || list.length === 0 || !Number.isInteger(owner)) {
    return null;
  }
  return { owner, conditions: JSON.parse(JSON.stringify(list)) };
}

function whileConditionsHold(entry) {
  const spec = entry?.whileCond;
  if (!spec || !Array.isArray(spec.conditions) || spec.conditions.length === 0) {
    return true;
  }
  const player = state.players?.[spec.owner];
  if (!player) {
    return false;
  }
  return checkCardConditions(spec.conditions, spec.owner, { owner: spec.owner, player });
}

function hasBuddyOnField(player) {
  // 「君の場にバディモンスターがいる」判定。バディ『アイテム』(canBeBuddy の武器＝不滅剣デュランダル等)は
  // 場にあってもモンスターではないので「バディモンスターがいる」を成立させない（印字type=monster のみ対象。
  // 以前は zones 全枠を名前一致だけで走査し、item 枠のバディアイテムを誤ってバディモンスター扱いしていた）。
  // turnTreatAsBuddy(『バディモンスターとして扱う』)のモンスターも成立させ、他のバディ読者(sourceIsBuddy/
  // filter.buddy/requireBuddy)と判定を揃える。
  return zones.some((zone) => {
    const card = player.field[zone];
    // ver2.05 ⑤「必殺モンスター」は「モンスター」を参照する場合にも該当し、バディにもできる＝印字 impactMonster も対象。
    // ただし『必殺変身』でアイテム化している間はモンスターではない（currentType:"item"）ので除外する。
    if (!card || !["monster", "impactMonster"].includes(card.baseType || card.type) || card.currentType === "item") {
      return false;
    }
    return (player.buddy && card.name === player.buddy.name) || card.turnTreatAsBuddy === true;
  });
}

// 「○○がいるとして扱う」系: 場のカードが countsAsFieldMonster を宣言していれば、
// 仮想モンスター(card風オブジェクト)として返す。場の在否を問う条件（presence/count）のみが参照し、
// 対象選択や継続バフ（実カードを要する処理）には含めない。
function phantomFieldMonsters(player) {
  if (!player) {
    return [];
  }
  const phantoms = [];
  zones.forEach((zone) => {
    const spec = player.field[zone]?.countsAsFieldMonster;
    if (!spec) {
      return;
    }
    (Array.isArray(spec) ? spec : [spec]).forEach((entry) => {
      phantoms.push({
        type: "monster",
        currentType: "monster",
        attributes: entry.attributes || (entry.attribute ? [entry.attribute] : []),
        size: entry.size || 0,
        power: entry.power || 0,
        critical: entry.critical || 0,
        defense: entry.defense || 0,
        name: entry.name || `${player.field[zone].name}(扱い)`,
        __phantom: true,
      });
    });
  });
  return phantoms;
}

// ownMonsterDestroyPending 用: 相手の場を破壊しうる破壊系 op（自己破壊 destroySelf/destroySource は除く）。
const OWN_MONSTER_DESTROY_OPS = new Set([
  "destroy",
  "destroyAll",
  "destroySelected",
  "destroyChosenByRpsWinner",
  "destroyOpponentMonsterWithPowerLteOwnWeapon",
  "destroyTargetLteFieldCardStat",
  "destroyTargetLteSourceStat",
]);

// 宣言者から見て相手（=条件の持ち主）の場を対象にしうる破壊 op を ability 内に含むか（effects/script/分岐を再帰走査）。
function abilityMayDestroyOpponentField(ability) {
  const selfTargeted = ability?.target?.controller === "self";
  const visit = (node) => {
    if (Array.isArray(node)) {
      return node.some(visit);
    }
    if (!node || typeof node !== "object") {
      return false;
    }
    if (typeof node.op === "string" && OWN_MONSTER_DESTROY_OPS.has(node.op)) {
      const onlySelf =
        node.scope === "self" ||
        node.controller === "self" ||
        node.target === "$self" ||
        (node.target === "$target" && selfTargeted);
      if (!onlySelf) {
        return true;
      }
    }
    return Object.keys(node).some((key) => key !== "conditions" && visit(node[key]));
  };
  return visit(ability?.effects) || visit(ability?.script);
}

function ownMonsterDestroyPending(owner) {
  const ownField = state.players[owner]?.field || {};
  const pa = state.pendingAttack;
  if (pa && pa.targetOwner === owner) {
    const attackedZones = [pa.targetType === "monster" ? pa.targetZone : null, ...(pa.attackAllTargetZones || [])];
    if (attackedZones.some((zone) => zone && ownField[zone] && effectiveCardType(ownField[zone]) === "monster")) {
      return true;
    }
  }
  const action = state.pendingAction;
  if (action && action.owner === 1 - owner && action.ability && abilityMayDestroyOpponentField(action.ability)) {
    return fieldZones.some((zone) => ownField[zone] && effectiveCardType(ownField[zone]) === "monster");
  }
  return false;
}

// pt-fix-d（斬魔障壁 eb02-0027「君の場のカードが破壊される時」）: ownMonsterDestroyPending のカード版。
// 攻撃の対象（全体攻撃の対象ゾーン含む）に自分の場のカードがいる／相手の宣言(pendingAction)の能力に相手の場を
// 対象にしうる破壊系 op があり自分の場にカード（アイテム・設置魔法含む）がある時だけ真。破壊の置換窓は無い近似。
function ownFieldCardDestroyPending(owner) {
  const ownField = state.players[owner]?.field || {};
  const pa = state.pendingAttack;
  if (pa && pa.targetOwner === owner) {
    const attackedZones = [pa.targetType === "monster" ? pa.targetZone : null, ...(pa.attackAllTargetZones || [])];
    if (attackedZones.some((zone) => zone && ownField[zone])) {
      return true;
    }
  }
  const action = state.pendingAction;
  if (action && action.owner === 1 - owner && action.ability && abilityMayDestroyOpponentField(action.ability)) {
    return Object.keys(ownField).some((zone) => Boolean(ownField[zone]));
  }
  return false;
}

// pt-fix-d: 「君がダメージを受ける時に使える」「君のライフが０になるなら」の近似ゲート（incomingDamagePending）。
// 相手の宣言(pendingAction)の能力のうち、宣言者から見て相手（=条件の持ち主）にダメージを与えうる op（静的走査）。
const INCOMING_EFFECT_DAMAGE_OPS = new Set([
  "dealDamage",
  "dealDamageBySelectedStatSum",
  "dealDamageByFieldCardStat",
  "revealTopDamagePerMatchRestToBottom",
  "eachPlayerTopDeckToDropThenDamageOrLife",
  "eachPlayerMayDiscardElseDamage",
  "rockPaperScissorsDamageLosers",
]);

// 能力内の「相手へのダメージ」を合計する。量が amountFrom 等で静的に決まらない op があれば amount=null（不明）。
function abilityIncomingDamageToOpponent(ability) {
  let found = false;
  let amount = 0;
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    if (typeof node.op === "string" && INCOMING_EFFECT_DAMAGE_OPS.has(node.op) && node.player !== "self") {
      found = true;
      if (node.op === "dealDamage" && !node.amountFrom && amount !== null) {
        amount += Number(node.amount) || 1;
      } else {
        amount = null;
      }
    }
    Object.keys(node).forEach((key) => {
      if (key !== "conditions") {
        visit(node[key]);
      }
    });
  };
  visit(ability?.effects);
  visit(ability?.script);
  return { found, amount: found ? amount : 0 };
}

// これから owner が受けるダメージの発生源を列挙する: (a) 相手の攻撃がファイターを対象にしている（全体攻撃含む）
// か、モンスターへの攻撃で攻撃者が『貫通』を持つ＝攻撃者の打撃力の合計、(b) 相手の宣言(pendingAction)の能力が
// 相手へのダメージ op を持つ＝その量（不明なら null）。options.from:"attack"|"effect" で片方に限る。
// options.excludeImpact: 必殺技（必殺モンスターのコール宣言を含む）の宣言を数えない（「必殺技以外のダメージ」）。
// 防御アイテムによる無効・軽減は見ない（上限の見積り）。
function pendingIncomingDamageSources(owner, options = {}) {
  const sources = [];
  const pa = state.pendingAttack;
  if (pa && pa.defender === owner && options.from !== "effect") {
    const attackers = getPendingAttackers();
    const critOf = (list) => list.reduce((total, attacker) => total + Math.max(0, visibleCritical(attacker.card) || 0), 0);
    if (pa.targetType === "fighter" || pa.attackAllIncludesFighter) {
      sources.push({ kind: "attack", amount: critOf(attackers) });
    } else {
      const penetrators = attackers.filter((attacker) => hasKeyword(attacker.card, "penetrate"));
      if (penetrators.length > 0) {
        sources.push({ kind: "attack", amount: critOf(penetrators) });
      }
    }
  }
  const action = state.pendingAction;
  if (action && action.owner === 1 - owner && action.ability && options.from !== "attack") {
    const isImpact =
      action.kind === "impact" ||
      (action.kind === "call" && (action.card?.baseType || action.card?.type) === "impactMonster");
    if (!(options.excludeImpact && isImpact)) {
      const damage = abilityIncomingDamageToOpponent(action.ability);
      if (damage.found) {
        sources.push({ kind: "effect", amount: damage.amount });
      }
    }
  }
  return sources;
}

function checkCondition(condition, owner, context = {}) {
  const player = state.players[owner];
  const opponent = state.players[1 - owner];
  if (condition.op === "all") {
    return (condition.conditions || []).every((child) => checkCondition(child, owner, context));
  }
  if (condition.op === "any") {
    return (condition.conditions || []).some((child) => checkCondition(child, owner, context));
  }
  if (condition.op === "not") {
    return !checkCondition(condition.condition || {}, owner, context);
  }
  if (condition.op === "calledViaAmbush") {
    // E-Y1(X-BT01 奇襲): この登場が『奇襲』ルート由来か（context.card=登場カード自身）。
    // 0003/0033/0064/0092「登場した時…さらに奇襲で登場していたなら」の script ifCondition や、
    // 0036/0094「奇襲で登場した時…」の ability.conditions ゲートで参照する。
    // calledViaAmbush は resolveOnEnter で毎登場ごとに明示代入され、通常登場では false（既存挙動不変）。
    return Boolean(context.card?.calledViaAmbush);
  }
  if (condition.op === "declaredNameInZone") {
    // declareCardName で宣言したカード名が、指定の山(既定:相手の手札)に存在するか。
    const declaredName = context.declaredCardName ?? context.vars?.declaredCardName;
    if (!declaredName) {
      return false;
    }
    const side = condition.controller === "opponent" ? opponent : player;
    if (!side) {
      return false;
    }
    const pile = condition.pile || "hand";
    let cards;
    if (pile === "field") {
      cards = zones.map((z) => side.field[z]).filter(Boolean);
    } else if (pile === "soul") {
      cards = zones.flatMap((z) => side.field[z]?.soul || []);
    } else {
      cards = side[pile] || [];
    }
    return cards.some((card) => card.name === declaredName);
  }
  if (condition.op === "confirmPrompt") {
    // メタ的な自己申告条件（例: ギャラホルンの「君が小学生なら」）を確認ポップアップで判定。
    // 何度も評価されると複数回ポップアップするため、ability.conditions ではなく script の ifCondition 内で使うこと。
    // B3: リプレイ再生中は記録済みの真偽値を返す／記録中は同期で控える（確認UIは変えない）。
    if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
      return replayNextConfirm();
    }
    let answer;
    if (typeof aiShouldAnswerPrompt === "function" && aiShouldAnswerPrompt(owner)) {
      // CPU席の自己申告は src/22-ai.js が同期で答える（人間に CPU の判断を代行させない＝R6 ai-prompts-routed）。
      answer = aiAnswerConfirmSync(owner, condition.prompt || "この効果を使いますか？", { purpose: "confirmPrompt" });
    } else if (typeof appChoiceUiAvailable === "function" && appChoiceUiAvailable()) {
      // ブラウザ: 同期の条件判定では確認UIを待てない（script の ifCondition は src/14 が非同期で先に問うため
      // 通常ここへは来ない）。ネイティブ確認は出さず、非対話と同じ既定で確定する。
      answer = Boolean(condition.default);
    } else if (typeof window !== "undefined" && typeof window.confirm === "function") {
      answer = Boolean(window.confirm(condition.prompt || "この効果を使いますか？"));
    } else {
      answer = Boolean(condition.default);
    }
    if (typeof replayRecordConfirm === "function") {
      replayRecordConfirm(answer);
    }
    return answer;
  }
  if (condition.op === "cardCount" || condition.op === "cardCountGte" || condition.op === "cardCountLte") {
    // 汎用枚数条件: controller(self/opponent/both/either) × pile(field/center/item/drop/hand/deck/gauge/soul) × filter × distinct × cmp
    const cmp = condition.cmp || (condition.op === "cardCountLte" ? "lte" : "gte");
    const pile = condition.pile || "field";
    // amount:0 は「ちょうど0枚 / 0枚以下」= 有意な閾値（0049「自場モンスター0体なら」等）。
    // || 1 だと 0 が 1 に潰れて eq/lte が壊れるため ?? で 0 を保持する。
    const amount = condition.amount ?? 1;
    // 指定プレイヤー群のカードを1配列に集めフィルタ後の枚数を返す（複数側渡すと合算＝both 意味論）。
    const countForSides = (sideList) => {
      let matched = [];
      sideList.forEach((pl) => {
        if (!pl) return;
        let cards = [];
        if (pile === "field") cards.push(...zones.map((z) => pl.field[z]).filter(Boolean), ...phantomFieldMonsters(pl));
        else if (pile === "item") cards.push(...equippedItems(pl)); // 複数装備を全てカウント（「アイテム2枚装備なら」0042等）
        else if (pile === "center") { if (pl.field[pile]) cards.push(pl.field[pile]); }
        else if (pile === "soul") cards.push(...zones.flatMap((z) => pl.field[z]?.soul || []));
        // E-XB46(X-CBT02 病5枚 0015/0027/0030/0032/0076「君の場のアイテムのソウルに《病》の魔法N枚以上」):
        // アイテムゾーンのソウルだけを合算する（既存 pile:"soul" は全ゾーン横断＝モンスター/設置/アイテムの
        // ソウルを混ぜる。itemSoul は itemZones のソウルに限定＝「アイテムのソウル」の正確カウント）。
        else if (pile === "itemSoul") cards.push(...itemZones.flatMap((z) => pl.field[z]?.soul || []));
        else cards.push(...(pl[pile] || []));
        if (condition.excludeSource && context.card) {
          cards = cards.filter((c) => c.instanceId !== context.card.instanceId);
        }
        // E-PR3: filter.buddy を場外(ドロップ/手札/デッキ/ゲージ)でも判定できるよう pile 所有者を渡す
        // （E-XC15 と同型。both/either はここで側ごとに正しい所有者で照合。field/soul/center は
        //  findFieldCardSlot で所有者特定できるため owner は無視＝挙動不変）。
        const plOwner = state.players.indexOf(pl);
        matched.push(...cards.filter((c) => matchesCardFilter(c, condition.filter || {}, { owner: plOwner })));
      });
      if (condition.distinct === "distinctByName") {
        return new Set(matched.map((c) => c.name)).size;
      }
      // E1(D-SS03/0039 旧世界の破壊神 アジ・ダハーカ): ワールドの種類数。2ワールド持ちカードは
      // cardWorlds() で両ワールドを算入（union）。既存 distinctByName / 未指定（枚数）は完全に不変。
      if (condition.distinct === "distinctByWorld") {
        return new Set(matched.flatMap((c) => worldNamesForDistinct(c))).size;
      }
      return matched.length;
    };
    const meets = (n) => (cmp === "lte" ? n <= amount : cmp === "eq" ? n === amount : n >= amount);
    // E2(D-EB03): controller:"either" は各側を個別集計し、いずれか一方でも cmp を満たせば真
    // （max/OR 意味論。「君か相手のドロップが N枚以上」0004。both＝合算 とは別値）。
    if (condition.controller === "either") {
      return [player, opponent].some((pl) => pl && meets(countForSides([pl])));
    }
    const sides = condition.controller === "opponent" ? [opponent]
      : condition.controller === "both" ? [player, opponent] : [player];
    return meets(countForSides(sides));
  }
  if (condition.op === "attackingAlone") {
    return getPendingAttackers().length === 1;
  }
  if (condition.op === "targetMatches") {
    const ref = condition.ref ? resolveEffectReference(condition.ref, context) : context.target;
    if (!ref?.card) {
      return false;
    }
    // レビュー修正(D-BT01/0091): matchesCardFilter は zone を解釈しないため、ゾーン条件はここで判定する
    // （「そのカードがセンターにいるなら、かわりに〜」の排他分岐用）。
    if (condition.zone && ref.zone !== condition.zone) {
      return false;
    }
    if (condition.zoneNot && ref.zone === condition.zoneNot) {
      return false;
    }
    return matchesCardFilter(ref.card, condition.filter || {});
  }
  if (condition.op === "targetStillOnField") {
    // audit2(b056-4 X-CP03/0035「その後、選んだカードが場にいるなら」): 参照カード（ref 既定 $target、var 指定時は
    // script 変数）の instanceId が、記録した owner の場（いずれかのゾーン）にまだあるか。破壊が置換されて手札へ
    // 戻った等で場を離れていれば false。var の複数選択は全員が場に残っている時だけ true。
    const refs = condition.var
      ? scriptSelection({ var: condition.var }, context)
      : [
          condition.ref && condition.ref !== "$target"
            ? resolveEffectReference(condition.ref, context)
            : context.target || context.abilityTarget,
        ];
    if (!refs.length) {
      return false;
    }
    return refs.every((ref) => {
      const id = ref?.card?.instanceId;
      if (!id || (ref.owner !== 0 && ref.owner !== 1)) {
        return false;
      }
      const field = state.players[ref.owner]?.field || {};
      return zones.some((zone) => field[zone]?.instanceId === id);
    });
  }
  if (condition.op === "sourceIsBuddy") {
    return sourceIsBuddyCondition(owner, context);
  }
  if (condition.op === "enteredByEffect") {
    // 「このカードがカードの効果で登場した時」（enter誘発のconditionsで使う。H-PP01/0044）。
    return Boolean(context.enteredByEffect);
  }
  if (condition.op === "enteredByCardNamed") {
    // E-XU2(X-UB01/0021 ミセリア): 「『仮面剣士 キリ』の効果で登場した時」。登場の発生源カード名で弁別する。
    // matchesCardFilter の name 判定（additionalNames 込み）を再利用。発生源未追跡（通常コール等）は false。
    return Boolean(context.enterCauseCard) && matchesCardFilter(context.enterCauseCard, { name: condition.name });
  }
  if (condition.op === "enterCauseMatches") {
    // 汎用形: 登場の発生源カードを filter で判定（属性/種別等での弁別に使う）。
    return Boolean(context.enterCauseCard) && matchesCardFilter(context.enterCauseCard, condition.filter || {});
  }
  if (condition.op === "turnOwnerIsSelf") {
    return (context.turnOwner ?? state.active) === owner;
  }
  if (condition.op === "turnOwnerIsOpponent") {
    return (context.turnOwner ?? state.active) !== owner;
  }
  if (condition.op === "reversalUsedThisFight") {
    // E-XB41/R20(X-BT04/0069 天晶への覚醒): 「このファイト中、君が『逆天』を使っているなら使える」。
    // 逆天(reversal)を使うと markAbilityLimit(src/15) が state.fightLimits[owner].reversal を記帳する
    //（normalizedAbilityLimit の既定 scope:"fight"/key:"reversal"）。逆天殺は明示 limit.key:"reversalKill" で
    // 別プールに記帳されるため本 op は false になる（R9/R20 の「逆天と逆天殺は独立プール」規約）。
    // useConditions / ability.conditions / effect.conditions のいずれからも checkCardConditions 経由で評価される。
    return Boolean(state.fightLimits?.[owner]?.reversal);
  }
  if (condition.op === "phaseIs") {
    // context.eventPhase: 発生時点のフェイズを記録する誘発（queueDrewTriggers）のみ設定。未設定時は従来どおり。
    const resolved = context?.eventPhase || state.pendingAction?.phase || state.phase;
    if (resolved === condition.phase) {
      return true;
    }
    // R-BR21(ブラウザレビュー pp01-B1 発見): 攻撃宣言中/バトル中は state.phase が "defense" に切り替わるため、
    // 「アタックフェイズ中に破壊された時」等の phaseIs:"attack"/"final" 誘発が恒常的に不発だった（pp01-0040 ほか
    // ~9カード）。論理フェイズは宣言時の pendingAttack.phase（src/15 のフェイズ限定 limit と同じ弁別）。resolved が
    // 一致しない時のみ pendingAttack.phase をフォールバックし attack/final を成立させる（純粋加算＝phaseIs:"defense"
    // 等 state.phase 自体を見るケースは上の resolved で従来どおり成立し不変）。
    return Boolean(state.pendingAttack?.phase) && condition.phase === state.pendingAttack.phase;
  }
  if (condition.op === "lifeLte") {
    return player.life <= condition.amount;
  }
  if (condition.op === "lifeGte") {
    // E12(D-CBT): describeAbilityCondition に表示文言だけ存在し評価分岐が無かった（未知opは末尾
    // return true＝常時成立に落ちる罠）。既存カード使用0件＝挙動不変。lifeLte の鏡。
    return player.life >= (condition.amount ?? 1);
  }
  if (condition.op === "opponentLifeLte") {
    return opponent.life <= condition.amount;
  }
  if (condition.op === "lifeCount") {
    // E-XB13(X-CP03/0011 大連鎖凶骨 サーティーン): ライフ枚数の汎用比較。controller(self/opponent) × cmp(gte/lte/eq) × amount。
    // 既存 lifeLte/lifeGte(self専用)・opponentLifeLte(相手≤のみ) では表現できない「相手のライフがちょうど13」等の
    // 等値・相手側 gte を1opで賄う（cardCount の life 版＝pile 列挙に life が無い穴を埋める）。既存カード使用0件＝挙動不変。
    const target = condition.controller === "opponent" ? opponent : player;
    const cmp = condition.cmp || "gte";
    const amount = condition.amount ?? 0;
    const n = target.life;
    return cmp === "lte" ? n <= amount : cmp === "eq" ? n === amount : n >= amount;
  }
  if (condition.op === "revealedMatches") {
    // E-XC1(X-CP02 コスモドラグーン reveal-gate): 直前に revealTopCard で公開したカード(context.revealedCard)が
    // filter に一致するか。script の ifCondition と effects[] の effect.conditions の両方に context 経由で届く
    //（ifConditionForScript は checkCondition(cond, owner, context)、effect ゲートは checkCardConditions(...,{...context}) を通す）。
    // 公開カードはデッキ上に残っている(peek)ので matchesCardFilter の属性/名称照合はゾーンに依存せず成立する。
    return context.revealedCard ? matchesCardFilter(context.revealedCard, condition.filter || {}) : false;
  }
  if (condition.op === "ownLifeGreaterThanOpponent") {
    // E-XC5(X-CP02/0013 ヴァルカン):「君のライフが相手より多いなら」＝self>opponent の厳密大なり（同値は不成立）。
    // lifeDifferenceGte(opponent−self≥N＝相手優位方向)の鏡＝自優位方向。効果列途中の評価は直前増減を反映した現在値。
    return player.life > opponent.life;
  }
  if (condition.op === "lifeDifferenceGte") {
    // E9(D-BT03/0013 餓狼深気功): 「相手のライフが君のライフより amount 以上多いなら」＝
    // (相手ライフ − 自ライフ) >= amount の相対差分条件（owner基準。既存 lifeLte/opponentLifeLte は
    // 固定値比較のみで差分は表現不可だった）。効果列の途中で評価される場合は直前の増減を反映した現在値。
    return opponent.life - player.life >= (condition.amount ?? 1);
  }
  if (condition.op === "pileCountDifferenceGte") {
    // E-PR5(PR/0332 キラーオーダー): 「相手の<pile>が君の<pile>より amount 以上多いなら」＝
    // (相手の pile 枚数 − 自分の pile 枚数) >= amount。lifeDifferenceGte（直上）の pile 汎化で、向き
    // (opponent − self)・命名(…DifferenceGte)を踏襲する。pile 既定 gauge。filter 指定時は両側とも一致
    // カードのみ数える（cardCount と同じ pile 解決・matchesCardFilter）。効果列の途中で評価される場合は
    // 直前の増減を反映した現在値（「2枚ゲージに置く。さらに〜多いなら」の後段ゲート）。既存カードはこの op を
    // 持たない＝挙動不変（新規 op・DB使用は PR/0332 のみ）。
    const diffPile = condition.pile || "gauge";
    const countPile = (pl) => {
      if (!pl) return 0;
      let cards;
      if (diffPile === "field") cards = [...zones.map((z) => pl.field[z]).filter(Boolean), ...phantomFieldMonsters(pl)];
      else if (diffPile === "item") cards = equippedItems(pl);
      else if (diffPile === "center") cards = pl.field.center ? [pl.field.center] : [];
      else if (diffPile === "soul") cards = zones.flatMap((z) => pl.field[z]?.soul || []);
      else cards = pl[diffPile] || [];
      return condition.filter ? cards.filter((c) => matchesCardFilter(c, condition.filter)).length : cards.length;
    };
    return countPile(opponent) - countPile(player) >= (condition.amount ?? 1);
  }
  if (condition.op === "costDiscardedCardMatches") {
    // E-PR6(PR/0281 ルア・ノヴァ): 「このカードの【使用コスト】で捨てたカードが filter に一致するなら」。
    // useHandAbilityAction が payStructuredCostWithSelection の payment.discarded を context.costDiscardedCards
    // として伝播する（宣言→対抗窓→解決を跨ぐため pendingAction 経由でも保持）。1枚でも一致すれば真（some）。
    // 捨てたカードはドロップに在るが matchesCardFilter は在ゾーン非依存で world/属性等を照合する。
    // 既存カードはこの op を持たない＝挙動不変（新規 op・DB使用は PR/0281 のみ）。
    return (context.costDiscardedCards || []).some((c) => matchesCardFilter(c, condition.filter || {}));
  }
  if (condition.op === "deckMilledThisTurn") {
    // E8(D-CBT/PR-0330 追撃者 アビゲール):「このターン中、<deckOwner>のデッキのカードがドロップに
    // 置かれているなら」。state.turnDeckMilled[席] はデッキ所有者ごとのターン内ミル枚数
    // （queueDeckMilledTriggers=deckMilled 発火点で常時集計・clearTurnModifiers でリセット・src/07/11）。
    // deckOwner を owner 視点で席へ解決する（"opponent"=相手のデッキ / 既定 "self"=自分のデッキ）。
    // amount 既定=1（「1枚以上置かれているなら」）。
    const milledSeat = condition.deckOwner === "opponent" ? 1 - owner : owner;
    return (state.turnDeckMilled?.[milledSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "gaugePlacedThisTurnLte") {
    // E-XB12(X-CP03/0069 影雄 グラウ):「このターン中、<controller>のゲージにカードが置かれていないなら」。
    // state.gaugePlacedThisTurn[席]=席別のターン内ゲージ流入枚数（noteGaugePlaced=全ゲージ流入点で集計・
    // clearTurnModifiers でリセット・src/07/11）。controller を owner 視点で席へ解決（"opponent"=相手 / 既定 self）。
    // amount 既定=0（「置かれていないなら」= 0枚以下）。deckMilledThisTurn(E8)と同型・?. ガードで旧state 非throw。
    const gaugeSeat = condition.controller === "opponent" ? 1 - owner : owner;
    return (state.gaugePlacedThisTurn?.[gaugeSeat] || 0) <= (condition.amount ?? 0);
  }
  if (condition.op === "damageTakenThisTurn") {
    // E-X2(X-SD02/0016 クリスタル・フローレス・シュート！):「このターン中、<damageOwner>がダメージを受けているなら」。
    // state.turnDamageTaken[席]=席別のターン内被ダメージ累積（applyDamageToPlayer=全ダメージ funnel の実適用点で
    // 軽減/無効化後の実ダメージのみ加算・src/04。payLife 等コスト直減算は funnel 外＝非計上）。damageOwner を owner
    // 視点で席へ解決（"opponent"=相手 / 既定 "self"=自分）。amount 既定=1（「1以上受けているなら」）。0016 の
    // 「君がダメージを受けていなくて」は {op:"not", condition:{op:"damageTakenThisTurn"}} で否定合成する
    // （self が0ダメージ＝真）。deckMilledThisTurn(E8)と同型・?. ガードで旧state 非throw。
    const damagedSeat = condition.damageOwner === "opponent" ? 1 - owner : owner;
    return (state.turnDamageTaken?.[damagedSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "spellCastThisTurnGte") {
    // E-XB9(X-SS03/0017 セフィロトの講義):「このターン中、<controller>が魔法を使っているなら」。
    // state.spellsCastThisTurn[席]=席別のターン内魔法使用回数（recordSpellCastThisTurn=全 spellCast funnel で
    // 加算・clearTurnModifiers でリセット・src/07/11）。controller を owner 視点で席へ解決（"opponent"=相手 /
    // 既定 "self"=自分）。amount 既定=1（「1回以上使っているなら」）。deckMilledThisTurn(E8)と同型・?. ガードで旧state 非throw。
    const casterSeat = condition.controller === "opponent" ? 1 - owner : owner;
    return (state.spellsCastThisTurn?.[casterSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "handDiscardedByEffectThisTurnMatches") {
    // E-XB10(X-SS03/0048 シャインブレイド・ジョーカー):「このターン中、カードの効果で <controller> の手札の
    // カードが捨てられているなら」。state.turnHandDiscardedByEffect[席]=席別のターン内「効果で捨てられた手札枚数」
    // （discardHandCardsToDrop=手札→ドロップの唯一合流点で cause.byEffect のみ加算＝コスト捨て/byCost は非計上。
    // clearTurnModifiers でリセット・src/11）。controller を owner 視点で席へ解決（"opponent"=相手 / 既定 "self"=自分）。
    // amount 既定=1。E8 deckMilledThisTurn の鏡・?. ガードで旧state 非throw。
    const discardedSeat = condition.controller === "opponent" ? 1 - owner : owner;
    return (state.turnHandDiscardedByEffect?.[discardedSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "ownCenterEmpty") {
    return !player.field.center;
  }
  if (condition.op === "ownCenterHasAttribute") {
    return Boolean(player.field.center?.attributes?.includes(condition.attribute));
  }
  if (condition.op === "bothCentersEmpty") {
    return !player.field.center && !opponent.field.center;
  }
  if (condition.op === "opponentCenterEmpty") {
    return !opponent.field.center;
  }
  if (condition.op === "ownDropCardCountGte") {
    return player.drop.filter((card) => matchesCardFilter(card, condition.filter || {})).length >= (condition.amount || 1);
  }
  if (condition.op === "sourceZoneIn") {
    const sourceZone = context.zone ?? state.selected?.zone;
    const sourceOwner = context.owner ?? state.selected?.owner;
    return sourceOwner === owner && zoneListIncludes(condition.zones, sourceZone);
  }
  if (condition.op === "pendingBattleInvolvesSelf") {
    // S-UB-C03/0083「このカードのバトル中」: 発生源カードが進行中のバトル(pendingAttack)の
    // 攻撃側 or 防御対象に含まれているときのみ真。fieldAbilityUsable が context.card を渡す。
    const source = context.card || getSelectedCard();
    return Boolean(source?.instanceId && pendingBattleCardIds().has(source.instanceId));
  }
  if (condition.op === "sourceStanding") {
    const source = context.card || getSelectedCard();
    return Boolean(source && !source.used);
  }
  if (condition.op === "sourceSoulHasAttribute") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).some((card) => card.attributes?.includes(condition.attribute));
  }
  if (condition.op === "sourceSoulCountGte") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).length >= condition.amount;
  }
  if (condition.op === "sourceSoulMatchingCountGte") {
    // 発生源のソウルのうち filter 一致の枚数が amount 以上か（0030の勝利条件系）。
    const source = context.card || getSelectedCard();
    const n = (source?.soul || []).filter((card) => matchesCardFilter(card, condition.filter || {})).length;
    return n >= (condition.amount || 1);
  }
  if (condition.op === "sourceSoulHasSameSizeAsEntered") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).some((card) => (card.size || 0) === (context.enteredCard?.size || 0));
  }
  if (condition.op === "selfStatGte" || condition.op === "selfStatLte") {
    // E-XB51②(X-CBT01/0074 轟天覇王拳 ドラグランブル「このカードの攻撃力が10000以上なら」): 発生源カード自身の
    // 現在値（visible stat＝印字＋バトル/ターン/継続バフ）の閾値判定。bare event:"attack" 等の文脈で
    // context.card（＝攻撃したこのカード）を安全に読む。stat: power(攻撃力)/defense(防御力)/critical(打撃力)。
    // powerGte が matchesTargetFilter 経由で sameInstanceAsSource を解釈しない穴を埋める source 限定版。
    const source = condition.ref ? resolveEffectReference(condition.ref, context)?.card : (context.card || getSelectedCard());
    if (!source) return false;
    const stat = condition.stat || "power";
    const value = stat === "defense" ? visibleDefense(source) : stat === "critical" ? visibleCritical(source) : visiblePower(source);
    const amount = condition.amount ?? 0;
    return condition.op === "selfStatLte" ? value <= amount : value >= amount;
  }
  if (condition.op === "sourceSoulWorldCountGte") {
    // E-XB47(X-CBT01/0038 ぶんぶく師匠 本気モード！): 「このカードのソウルのカードのワールド名がN種類以上なら」。
    // 発生源カード自身のソウルの distinct ワールド種類数（cardWorlds() で2ワールド持ちは両ワールドを算入＝
    // cardCount の distinct:"distinctByWorld"／amountFrom distinctWorldCount と同ロジックの source 限定版）。
    // 場の全モンスターのソウルを合算する pile:"soul" 系と違い、context.card のソウルだけを見る。
    const source = context.card || getSelectedCard();
    const n = new Set((source?.soul || []).flatMap((card) => worldNamesForDistinct(card))).size;
    return n >= (condition.amount || 1);
  }
  if (condition.op === "hostMatches") {
    return Boolean(
      context.hostCard &&
        matchesTargetFilter(
          context.hostCard,
          context.hostOwner ?? owner,
          context.hostZone,
          condition.filter || {},
        ),
    );
  }
  if (condition.op === "castFromSoulHostMatches") {
    // E-XB50(X-CBT01/0030 秘剣 斬流雷牙「このカードが『秘剣 絶命陣』のソウルから使われていたなら」):
    // E-XB45 soul-cast のホスト（finalizeSoulSpellCast→pendingAction.hostCard→resolvePendingSpell の
    // context.hostCard）を filter で照合する。通常の手札魔法（hostCard 無し）は false ＝当該条項が発火しない
    // （後方互換: 手札から使った 0030 はこの節を満たさず、ゲージ加速の追加報酬を得ない）。nameIncludes 等対応。
    return Boolean(context.hostCard && matchesCardFilter(context.hostCard, condition.filter || {}));
  }
  if (condition.op === "enteredCardMatches") {
    if (condition.excludeSource && context.enteredCard?.instanceId === context.card?.instanceId) {
      return false;
    }
    // sameInstanceAsSource 等の相対キー(設置時の自己限定など)を解釈するため relative 版で評価。
    return Boolean(context.enteredCard && matchesRelativeCardFilter(context.enteredCard, condition.filter || {}, context));
  }
  if (condition.op === "enteredZoneIn") {
    return zoneListIncludes(condition.zones, context.enteredZone);
  }
  if (condition.op === "ownFieldMonsterAttributeSizeGte") {
    const real = fieldZones.some((zone) => {
      const card = player.field[zone];
      return (
        card &&
        effectiveCardType(card) === "monster" &&
        card.attributes?.includes(condition.attribute) &&
        (card.size || 0) >= condition.size
      );
    });
    return (
      real ||
      phantomFieldMonsters(player).some(
        (p) => p.attributes.includes(condition.attribute) && (p.size || 0) >= condition.size,
      )
    );
  }
  if (condition.op === "ownFieldHasBuddy") {
    return hasBuddyOnField(player);
  }
  if (condition.op === "buddyMatches") {
    // 登録バディモンスター（場の有無に関係なく）がフィルタに一致するか。
    return Boolean(player?.buddy && matchesCardFilter(player.buddy, condition.filter || {}));
  }
  if (condition.op === "ownFieldHasAttribute") {
    return (
      zones.some((zone) => player.field[zone]?.attributes?.includes(condition.attribute)) ||
      phantomFieldMonsters(player).some((p) => p.attributes.includes(condition.attribute))
    );
  }
  if (condition.op === "ownAttributeAttackDestroyedCountGte") {
    // このターン、自分の指定attributeの攻撃で破壊した相手モンスター数 >= amount。
    const count = state.attackDestroyedByAttribute?.[owner]?.[condition.attribute] || 0;
    return count >= (condition.amount || 1);
  }
  if (condition.op === "flagNameIs") {
    // E12(D-SS02/0005 未来占星術): ターン限定エイリアス（addTurnFlagNameAlias「フラッグは「X」としても扱う」）
    // も真とする。エイリアスは flagNameIs 専用で、カード使用可否(canUseCardForFlag)には効かない。
    // E-XB44: フラッグが裏（flagFaceDown）ならフラッグ名は成立しない（機能停止＝フラッグに書かれた条件を満たさない）。
    if (state.players[owner]?.flagFaceDown) {
      return false;
    }
    return (
      state.players[owner]?.flag?.name === condition.name ||
      (state.turnFlagNameAliases?.[owner] || []).includes(condition.name)
    );
  }
  if (condition.op === "ownHandCountGte") {
    return player.hand.length >= condition.amount;
  }
  if (condition.op === "ownFieldCardExists") {
    const candidateZones = expandZoneList(condition.zones) || zones;
    return (
      candidateZones.some((zone) => {
        const card = player.field[zone];
        return card && matchesTargetFilter(card, owner, zone, condition.filter || {});
      }) ||
      // zones を限定していない（場全体を問う）場合のみ仮想モンスターも参照する
      (!condition.zones && phantomFieldMonsters(player).some((p) => matchesCardFilter(p, condition.filter || {})))
    );
  }
  if (condition.op === "ownOtherFieldCardExists") {
    const candidateZones = expandZoneList(condition.zones) || zones;
    return candidateZones.some((zone) => {
      const card = player.field[zone];
      return (
        card &&
        card.instanceId !== context.card?.instanceId &&
        matchesTargetFilter(card, owner, zone, condition.filter || {})
      );
    });
  }
  if (condition.op === "ownFieldCardCountGte") {
    const candidateZones = expandZoneList(condition.zones) || zones;
    return candidateZones.filter((zone) => {
      const card = player.field[zone];
      return card && matchesTargetFilter(card, owner, zone, condition.filter || {});
    }).length >= condition.amount;
  }
  if (condition.op === "opponentFieldCardCountLte") {
    const candidateZones = expandZoneList(condition.zones) || zones;
    return candidateZones.filter((zone) => {
      const card = opponent.field[zone];
      return card && matchesTargetFilter(card, 1 - owner, zone, condition.filter || {});
    }).length <= condition.amount;
  }
  if (condition.op === "ownDropAttributeCountGte") {
    return player.drop.filter((card) => card.attributes?.includes(condition.attribute)).length >= condition.amount;
  }
  if (condition.op === "ownDropAttributeSumCountGte") {
    // 指定属性のいずれかを持つドロップの札数（和集合＝両属性持ちは1枚として数える）が amount 以上か。
    const attrs = condition.attributes || [];
    const total = player.drop.filter((card) =>
      attrs.some((attr) => card.attributes?.includes(attr)),
    ).length;
    return total >= condition.amount;
  }
  if (condition.op === "enteredFromZoneIn") {
    // コールされたカードの発生元ゾーンを判定（resolvePendingCall="hand"、scriptコール系=entry.source を記録）。
    const entered = context.enteredCard || context.card || getSelectedCard();
    return Boolean(entered && zoneListIncludes(condition.zones || [], entered.enteredFromZone));
  }
  if (condition.op === "eventCardIsSource") {
    // フィールドイベント（allyMove/allyDealDamage 等）の主体カードが能力の発生源自身か。
    const eventCard =
      context.eventCard?.card || context.eventFieldCard || context.destroyedCard || context.enteredCard;
    return Boolean(eventCard && context.card && eventCard.instanceId === context.card.instanceId);
  }
  if (condition.op === "eventDestroyerIsSelf") {
    // opponentDestroyed/allyDestroyed 誘発時、破壊を起こした側が listener(owner) 自身か（「君のカードで破壊された時」0030）。
    return context.destroyCause?.sourceOwner === owner;
  }
  if (condition.op === "eventDestroyerMatches") {
    // opponentDestroyed/allyDestroyed 誘発時、破壊を起こした側(sourceCard)が controller/filter に一致するか。
    // 「君の場の《ヒーロー》が相手のモンスターを破壊した時」等。battle破壊=attacker、効果破壊=makeEffectCause の context.card が sourceCard。
    const cause = context.destroyCause;
    if (!cause?.sourceCard) return false;
    if (condition.controller === "self" && cause.sourceOwner !== owner) return false;
    if (condition.controller === "opponent" && cause.sourceOwner === owner) return false;
    return matchesCardFilter(cause.sourceCard, condition.filter || {});
  }
  if (condition.op === "eventDestroyCauseMatches") {
    // 破壊の原因で誘発を絞る（相手のカードで/効果で/発生源種別）。
    // context.destroyCause は自身の destroyed / ally|opponentDestroyed の双方で参照可能。
    // バトル破壊は byBattle のみ(byEffect/sourceType 無し)なので、byEffect や sourceType 指定の条件は自動的に不成立になる。
    const cause = context.destroyCause;
    if (!cause) return false;
    if (condition.byEffect && !cause.byEffect) return false;
    if (condition.byOpponent && !cause.byOpponent) return false;
    if (condition.sourceType && cause.sourceType !== condition.sourceType) return false;
    return true;
  }
  if (condition.op === "eventRestCauseMatches") {
    // Z14(a)(S-UB-C03/0014): 相手のカードが「君のカードの効果で」レストした時、を判定する。
    // context.restCause は restTarget(15)/restSelectedForScript(14) が makeEffectCause で伝播する。
    // 攻撃レスト(reason:"attack")は restCause を伝播しないため自動的に不成立になる（対象外仕様）。
    const cause = context.restCause;
    if (!cause?.byEffect) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventStandCauseMatches") {
    // E9(D-CBT/0109 シェイクハンズ・ドラゴン): ally/opponentStand 誘発時、スタンドの起因を照合する。
    // context.standCause は queueStandTriggers（効果スタンド経路のみ・src/07）が伝播する。
    // ターン開始スタンド(standPlayer)・多回攻撃キーワードのスタンド(src/10)はそもそもブロードキャスト
    // されないため自動的に不成立（rest の reason:"attack" 対象外と同思想）。eventRestCauseMatches の鏡。
    const cause = context.standCause;
    if (!cause?.byEffect) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventReturnCauseMatches") {
    // Z14(b)(S-UB-C03/0017): 相手の場のカードが「君のカードの効果で」手札に戻った時、を判定する。
    // context.returnCause は returnToHand/returnAllToHand(15)・returnFieldTargetToHand(08)が伝播する。
    const cause = context.returnCause;
    if (!cause?.byEffect) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventMillCauseMatches") {
    // E5(D-BT04/0039 サクシヲン・0098 ノルド): ally/opponentDeckMilled 誘発時、ミルの起因を照合する。
    // context.millCause は queueDeckMilledTriggers（デッキ→ドロップの各ミル経路）が伝播する。
    // 既定は「効果によるミル」（byEffect）のみ。allowCost:true でコスト起因（byCost）も許容。
    // sourceController:"self"=「君のカードの効果で」（起因席が listener 自身）。filter は起因カード照合。
    const cause = context.millCause;
    if (!cause) return false;
    if (!(cause.byEffect || (condition.allowCost && cause.byCost))) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventDiscardCauseMatches") {
    // E6(D-BT04/0104 戦闘詩人 レポーティング): discardedFromHand 誘発時、捨ての起因を照合する。
    // context.discardCause は discardHandCardsToDrop（src/11）へ各経路が渡す（効果op=makeEffectCause／
    // コストstep=byCost。ターン終了時などルール由来の捨ては cause 無し＝不成立）。
    // ★DB では「捨ててよい。捨てたら」型（公式には効果）を cost step でエンコードしている（D-EB02 戦闘詩人
    // トーキング等）ため、この型を拾うリスナーは allowCost:true を併用する（残差: 純粋な【使用コスト】の
    // 手札捨てとの弁別は不可＝過発火し得るが、該当 filter を持つ実カードでは実害なし）。
    const cause = context.discardCause;
    if (!cause) return false;
    if (!(cause.byEffect || (condition.allowCost && cause.byCost))) return false;
    if (condition.sourceController === "self" && cause.sourceOwner !== owner) return false;
    if (condition.sourceController === "opponent" && cause.sourceOwner === owner) return false;
    if (condition.filter && !matchesCardFilter(cause.sourceCard, condition.filter || {})) return false;
    return true;
  }
  if (condition.op === "eventAttackersInclude") {
    // Z14(f)(S-UB-C03/0022,0029): この攻撃(連携含む)の攻撃者一覧に filter 一致のカードが含まれるか。
    // context.attackers は runAttackDeclarationTriggers(09)の"attack"誘発コンテキストに乗る（本Batch0で追加）。
    // 未指定時（"attack"イベント以外からの参照等）は state.pendingAttack から補完する。
    const attackers = context.attackers || getPendingAttackers();
    return attackers.some((a) => {
      if (condition.excludeSelf && a.card?.instanceId === context.card?.instanceId) return false;
      return matchesCardFilter(a.card, condition.filter || {});
    });
  }
  if (condition.op === "attacksThisTurnGte") {
    // Z7(S-UB-C03/0047,0052): このターン中に『君のカードが』攻撃した回数が amount 以上か。連携攻撃は1回と数える
    // （09-attack.js:308 の席別加算 attacksThisTurnBySeat と同一カウンタ・ターン切替でリセット）。
    // 第13回メカレビュー: 以前はグローバル state.attacksThisTurn を席無視で読んでおり、相手ターン中に使う
    // 【対抗】(バッツ×リンク/イレギュラー・アタック等9枚)や『逆天殺』〔相手のターン中〕(ギアゴッド ver.Ø99)で
    // 『相手の』攻撃回数が『君の』攻撃回数として成立していた。自ターン中は相手が攻撃しない＝両者一致するため
    // ファイナル発動系(×天バスター等)の挙動は不変。controller 未指定は自席基準（カード文面『君のカード』）。
    const bySeat = state.attacksThisTurnBySeat;
    if (!Array.isArray(bySeat)) {
      // 席別カウンタを持たない古い state（E-XB40 以前の保存部屋/リプレイ）向けのフォールバック。
      return (state.attacksThisTurn || 0) >= (condition.amount ?? 1);
    }
    const attacksSeat = condition.controller === "opponent" ? 1 - owner : owner;
    return (bySeat[attacksSeat] || 0) >= (condition.amount ?? 1);
  }
  if (condition.op === "lastDestroySucceeded") {
    // 直前の destroy op が実際に破壊を成立させたか（破壊耐性「破壊されない」で生存した場合は false。
    // 2026-10-09 オーナー裁定: ソウルガード等で場に残った場合は破壊成功＝true。src/11 destroyedInPlace）。
    // 「破壊し、そうしたら…」の報酬効果を破壊成立時のみ実行するためのゲート。
    return Boolean(context.lastDestroyed);
  }
  if (condition.op === "lastDiscardSucceeded") {
    // 直前の discardRandomFromHand が1枚以上捨てたか（手札0枚・捨て札置換なら false）。
    // 「捨てたら、〜」の後続ゲート（lastDestroySucceeded と同じ context フラグ方式。X-CP03/0058）。
    return (context.lastDiscardedCount || 0) > 0;
  }
  if (condition.op === "opponentCalledFromHand") {
    // E-XV4(X-UB02/0059 エフゴ・アタック): 直前の opponentMayCallFromHand で相手が実際にコールを成立させたか。
    // 「コールしたら、君はゲージ１を払ってよい。払ったら、このカードを手札に戻す」の後続分岐ゲート
    // （lastDestroySucceeded と同じ context フラグ方式。辞退/候補なし/コスト不能なら false）。
    return Boolean(context.opponentCalledFromHand);
  }
  if (condition.op === "damageSourceLabelIs") {
    // opponentDamagedByEffect 誘発時、ダメージ発生源能力のラベル(“爆雷”等)一致を判定（爆雷連鎖）。
    return context.damageSourceLabel === condition.label;
  }
  if (condition.op === "movedToDropMatches") {
    // この解決中に context.movedToDrop へ置かれたカードのいずれかが filter に一致するか（moveTopDeckToDrop 等）。
    return (context.movedToDrop || []).some((card) => matchesCardFilter(card, condition.filter || {}));
  }
  if (condition.op === "milledContains") {
    // G1(D-EB01/0050): 直前のミル(context.milled)に filter 一致カードが含まれるか
    //（「その中にモンスターがあるなら」）。context.movedToDrop（累積）ではなく最新ミルのみを見る。
    return (context.milled || []).some((card) => matchesCardFilter(card, condition.filter || {}));
  }
  if (condition.op === "milledMatchCountGte") {
    // E7(D-BT03/0011/0051): 直前のミル(context.milled)に filter 一致カードが amount 枚以上あるか
    //（「その中に…モンスター２枚以上があるなら」）。milledContains(1枚以上)の閾値一般形で、
    // 文脈規約も同じ（movedToDrop 累積ではなく最新ミルのみ）。amount 省略時は1＝milledContains と同義。
    const milledMatched = (context.milled || []).filter((card) => matchesCardFilter(card, condition.filter || {})).length;
    return milledMatched >= (condition.amount ?? 1);
  }
  if (condition.op === "milledDistinctAttributeCountGte") {
    // G1(D-EB01/0029): 直前のミル(context.milled)に含まれるカードの「属性」の異なり数が amount 以上か
    //（「その中のカードの属性が4種類以上なら…」。段階判定は effect.conditions に amount:4/6/9 を並べる）。
    const attrs = new Set();
    (context.milled || []).forEach((card) => {
      (card.attributes || []).forEach((attribute) => attrs.add(attribute));
    });
    return attrs.size >= condition.amount;
  }
  if (condition.op === "ownItemIsMonster") {
    // 君のアイテム枠のカードが（元）モンスター＝『変身』か『搭乗』している状態か（equipSelfはcurrentTypeのみitem化）。
    return equippedItems(player).some((item) => item.currentType === "item" && item.type === "monster");
  }
  if (condition.op === "monstersDestroyedThisTurnGte") {
    // このターン中に破壊された controller 側モンスターの総数（攻撃・効果問わず）が amount 以上か。
    const counts = state.monstersDestroyedThisTurn || [0, 0];
    const idx = condition.controller === "opponent" ? 1 - owner : owner;
    return (counts[idx] || 0) >= condition.amount;
  }
  if (condition.op === "destroyedThisTurnMatchingCountGte") {
    // このターン中に controller 側で破壊されたカードのうち filter に一致する枚数が amount 以上か
    // （H-EB04/0021「このターン2体以上どくろ武者破壊」等）。破壊時に凍結したサイズ(sizeAtDestroy)で判定する。
    const idx = condition.controller === "opponent" ? 1 - owner : owner;
    const entries = state.destroyedCardsThisTurn?.[idx] || [];
    const matched = entries.filter(
      (entry) =>
        matchesCardFilter(entry.card, condition.filter || {}, { effectiveSizeOverride: entry.sizeAtDestroy }) &&
        // pt-fix-d（結晶化現象 X-BT02/0007「君のセンターのモンスターが破壊されているなら」）: 破壊時ゾーン限定。
        // ゾーン未記録の旧エントリは通す（lastDestroyedCardMatches の zoneIn と同じ作法）。
        (!Array.isArray(condition.zoneIn) || !entry.zone || zoneListIncludes(condition.zoneIn, entry.zone)),
    ).length;
    return matched >= condition.amount;
  }
  if (condition.op === "destroyedThisFightMatchingCountGte") {
    // audit2(b029-2 PR/0474「このファイト中、君のサイズ３の《炎竜》が破壊されているなら」): このファイト中に
    // controller 側(既定self)で破壊されたカードのスナップショット(state.fightDestroyed)のうち filter 一致が amount 以上か。
    // サイズは破壊時点の値(snapshot.size)で判定する。記録の無い旧 state は 0 件扱い。
    const idx = condition.controller === "opponent" ? 1 - owner : owner;
    const entries = state.fightDestroyed?.[idx] || [];
    const matched = entries.filter((entry) =>
      matchesCardFilter(entry, condition.filter || {}, { effectiveSizeOverride: entry.size }),
    ).length;
    return matched >= (condition.amount ?? 1);
  }
  if (condition.op === "standedByEffectThisTurnMatches") {
    // E-PR16(PR/0470 ボーナス節): このターン中に controller 側の場のカードが「効果で」スタンドしたか。
    // destroyedThisTurnMatchingCountGte の sibling。記帳は queueStandTriggers(src/07)＝効果スタンド専用経路
    // （通常のターン開始スタンド/多回攻撃スタンドは含まれない）。原文「相手の場のカードが〜」に忠実なよう、
    // 記帳した instanceId が現在も controller の場に在るものだけを数える（場を離れたカードは対象外）。
    // filter 省略時は種別不問（PR/0470 は controller だけを見る）。amount 省略時は1枚以上。
    const idx = condition.controller === "opponent" ? 1 - owner : owner;
    const ids = state.standedByEffectThisTurn?.[idx] || [];
    if (ids.length === 0) {
      return false;
    }
    const controllerPlayer = state.players[idx];
    const matched = zones
      .map((zone) => controllerPlayer?.field?.[zone])
      .filter((card) => card && ids.includes(card.instanceId) && matchesCardFilter(card, condition.filter || {}))
      .length;
    return matched >= (condition.amount || 1);
  }
  if (condition.op === "monsterMovedThisTurn") {
    // E-XB69(X2-SP/0014 旋撃のドラム,0027 奮起のハルバード・ドラゴン): このターン中に controller 側の場のモンスターが
    // 『移動』しているか。記帳は moveFieldCard(src/07)＝『移動』キーワード（src/09）と効果移動（src/15）の唯一の
    // choke point。standedByEffectThisTurnMatches の sibling で、原文「君の場のモンスターが移動しているなら」に忠実なよう、
    // 記帳した instanceId が現在も controller の場に在るものだけを見る（移動後に場を離れたカードは対象外）。
    // controller/player 省略時は自席（0014/0027 は「君の場」＝self）／"opponent" で相手席。
    // filter 省略時は種別不問（0014）／filter 指定でカード名等を絞る（0027=nameIncludes「迅雷」）。
    const ctrl = condition.controller ?? condition.player;
    const idx = ctrl === "opponent" ? 1 - owner : owner;
    const ids = state.movedThisTurn?.[idx] || [];
    if (ids.length === 0) {
      return false;
    }
    const controllerPlayer = state.players[idx];
    return zones
      .map((zone) => controllerPlayer?.field?.[zone])
      .some((card) => card && ids.includes(card.instanceId) && matchesCardFilter(card, condition.filter || {}));
  }
  if (condition.op === "isFirstBattleEndWindow") {
    // 「(相手のターン中、)1回目のバトル終了時に使える」(ヴァイシュタッツ 0095) の近似。
    // アプリの対抗ウィンドウはバトル解決前(pendingAttack中)のため、1回目のバトル(attacksThisTurn===1)の
    // 対抗ウィンドウで true を返す（厳密な「バトル終了時」より僅かに早いが、アタックフェイズ終了の意図は満たす）。
    return Boolean(state.pendingAttack) && (state.attacksThisTurn || 0) === 1;
  }
  if (condition.op === "isNthBattleEndWindow") {
    // E-XB35(X-BT04/0092 フェイズシール・チェイン): 「相手のアタックフェイズ中、N回目のバトル終了時に使える」。
    // isFirstBattleEndWindow(N=1) の一般化。対抗ウィンドウはバトル解決前(pendingAttack中)のため、N回目のバトルの
    // 対抗ウィンドウ（attacksThisTurn===N）で true。連携攻撃は1回と数える（09-attack の加算箇所と同一カウンタ）。
    // amount 省略時は1＝isFirstBattleEndWindow と同義。
    const n = condition.amount ?? 1;
    return Boolean(state.pendingAttack) && (state.attacksThisTurn || 0) === n;
  }
  if (condition.op === "ownDropDistinctAttributeCountGte") {
    const names = new Set(
      player.drop
        .filter((card) => card.attributes?.includes(condition.attribute))
        .map((card) => card.name),
    );
    return names.size >= condition.amount;
  }
  if (condition.op === "ownDropHasCardName") {
    return player.drop.some((card) => card.name === condition.name);
  }
  if (condition.op === "ownDropHasCard") {
    return player.drop.some((card) => matchesCardFilter(card, condition.filter || {}));
  }
  if (condition.op === "ownDropDistinctCardCountGte") {
    const names = new Set(
      player.drop
        .filter((card) => matchesCardFilter(card, condition.filter || {}))
        .map((card) => card.name),
    );
    return names.size >= condition.amount;
  }
  if (condition.op === "recentLifeLinkMatches") {
    return Boolean(findRecentLifeLinkEvent(owner, condition));
  }
  if (["specialCallOpportunityMatches", "temporaryCallOpportunityMatches"].includes(condition.op)) {
    return Boolean(findSpecialCallOpportunity(owner, condition));
  }
  if (condition.op === "movedToDropHasSameSizeAsEntered") {
    return (context.movedToDrop || []).some((card) => (card.size || 0) === (context.enteredCard?.size || 0));
  }
  if (condition.op === "opponentHandCountLte") {
    return opponent.hand.length <= condition.amount;
  }
  if (condition.op === "opponentHandCountGte") {
    return opponent.hand.length >= condition.amount;
  }
  if (condition.op === "damageSourceMatches") {
    return Boolean(context.damageSource?.card && matchesCardFilter(context.damageSource.card, condition.filter || {}));
  }
  if (condition.op === "eventCardMatches") {
    let eventCard = context.eventCard?.card || context.destroyedCard || context.enteredCard;
    // rule-zones-3: 場を離れたカードは離場後に印字の型へ戻る（変身/搭乗/着任）。離場系イベントは離場時点の型で照合する。
    const typeAtLeave = context.eventCardTypeAtLeave;
    if (eventCard && typeAtLeave && eventCard === context.eventCard?.card && typeAtLeave !== effectiveCardType(eventCard)) {
      eventCard = { ...eventCard, currentType: typeAtLeave };
    }
    return Boolean(eventCard && matchesCardFilter(eventCard, condition.filter || {}));
  }
  if (condition.op === "eventCardInFrontOfSource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        context.eventOwner !== sourceSlot.owner &&
        context.eventZone === oppositeFieldZone(sourceSlot.zone),
    );
  }
  if (condition.op === "pendingAttackByOpponentItem") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && effectiveCardType(attacker.card) === "item",
    );
  }
  if (condition.op === "pendingAttackByOpponentMonster") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && effectiveCardType(attacker.card) === "monster",
    );
  }
  if (condition.op === "pendingAttackByOpponentCardMatches") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "ownMonsterDestroyPending") {
    // 〔君の場のモンスターが破壊される場合〕の近似ゲート（伊吹童子の逆天殺）。破壊の置換窓は無いため、
    // 「破壊が起こりうる保留中の事象」がある時だけ真: (a) 攻撃中のバトルの対象（全体攻撃の対象ゾーン含む）に
    // 自分の場のモンスターがいる、(b) 相手が宣言した pendingAction の能力に、自分の場を対象にしうる破壊系 op
    // （OWN_MONSTER_DESTROY_OPS・静的走査）があり、かつ自分の場にモンスターがいる。
    return ownMonsterDestroyPending(owner);
  }
  if (condition.op === "ownFieldCardDestroyPending") {
    // pt-fix-d: 〔君の場のカードが破壊される時〕（モンスター以外も含む）の近似ゲート。
    return ownFieldCardDestroyPending(owner);
  }
  if (condition.op === "incomingDamagePending") {
    // pt-fix-d: 「君がダメージを受ける時に使える」＝これから自分がダメージを受ける（相手の攻撃の解決前／ダメージを与える
    // 相手の宣言の解決前）時だけ真。from:"attack"|"effect"、excludeImpact（必殺技以外）、amountGte:N（N以上のダメージ）、
    // lethal:true（そのダメージで君のライフが０になる＝量が自分のライフ以上。量が静的に不明な効果は通す）。
    const sources = pendingIncomingDamageSources(owner, {
      from: condition.from,
      excludeImpact: Boolean(condition.excludeImpact),
    });
    if (!condition.lethal && condition.amountGte == null) {
      return sources.length > 0; // 量は問わない（打撃力はこの後の【対抗】で変わりうる）
    }
    const threshold = condition.lethal ? Math.max(1, player?.life ?? 0) : condition.amountGte;
    return sources.some((source) => source.amount === null || source.amount >= threshold);
  }
  if (condition.op === "pendingAttackBySource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        getPendingAttackers().some((attacker) => sameSlot(attacker, sourceSlot)),
    );
  }
  if (condition.op === "selfIsNullifiedAttacker") {
    // D-SS03/0022 複製黒竜 アビゲール「このカードの攻撃が無効化された時」の自己限定用。
    // allyAttackNullified は「君の場のカードの攻撃が無効化された時」を場全体へ配送する（発火時点では
    // nullifyPendingAttack が既に clearPendingAttack 済み＝pendingAttack は null なので pendingAttackBySource は使えない）。
    // 直前の無効化された攻撃の攻撃側スロットを state.lastAttackOutcome.attackers に凍結してあるので、
    // それに context.card（=この listener）のスロットが含まれるかで「自分の攻撃が無効化された時」だけに絞る。
    const outcome = state.lastAttackOutcome;
    if (!outcome?.nullified) {
      return false;
    }
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(sourceSlot && (outcome.attackers || []).some((slot) => sameSlot(slot, sourceSlot)));
  }
  if (condition.op === "nullifiedAttackerMatches") {
    // E-XB30(X-SS04/0033 第2能力・X-BT02/0052 忠実化): 「君の場の《妖精》の攻撃が無効化された時」等、無効化された
    // 攻撃者にサブタイプ/ゾーン限定がある allyAttackNullified 誘発のゲート。allyAttackNullified は
    // fireAllyAttackNullifiedTriggers(src/10)が無効化された攻撃側プレイヤーの場札全てへ一律配送するブロードキャストで、
    // context には「どのカードが無効化された攻撃者か」の情報が乗らない（selfIsNullifiedAttacker は「自分自身が攻撃者か」・
    // lastAttackNullified は陣営 self/opponent のみ判定でカード filter は評価しない）。ここでは直前の無効化攻撃の攻撃側
    // スロット(state.lastAttackOutcome.attackers＝{owner,zone} 凍結)を場札へ解決し、filter/zone 一致の攻撃者が
    // いるかを判定する。攻撃無効化ではカードは移動しない（nullifyPendingAttack が used=true にするのみ）ため、発火時点で
    // スロットの札はなお攻撃者本人。zone=攻撃元ゾーン限定（0033「センターのモンスター」）・filter=カード条件一致
    // （0052「《妖精》」）。allyAttackNullified は攻撃側の場札のみへ配送されるため attackers[].owner は必ず listener の
    // owner＝「君の場の」限定は自然に満たされる（別途 owner ゲートは不要）。
    const outcome = state.lastAttackOutcome;
    if (!outcome?.nullified) {
      return false;
    }
    return (outcome.attackers || []).some((slot) => {
      if (condition.zone && slot.zone !== condition.zone) {
        return false;
      }
      const attackerCard = state.players[slot.owner]?.field?.[slot.zone];
      return Boolean(attackerCard && matchesCardFilter(attackerCard, condition.filter || {}));
    });
  }
  if (condition.op === "lastAttackNullified") {
    // E-Y5(X-BT01/0088 軍師の計略): 「(君の)攻撃が無効化されたバトルの終了時に使える」を、発生源スロット
    // 非依存で判定する（0088 は手札の対抗呪文＝findFieldCardSlot は常に偽のため selfIsNullifiedAttacker は使えない）。
    // 窓管理: lastAttackOutcome は次の攻撃解決(finishPendingAttack/nullifyPendingAttack)で必ず上書きされ、
    // 無効化されなかったバトルでは nullified:false になる＝「次の攻撃成立後/無効化なしのバトル後」は自然に不可。
    // 加えて turnCount で同ターンに限定し、攻撃無しでターンを跨いで真のまま残らないようにする。
    const outcome = state.lastAttackOutcome;
    if (!outcome?.nullified || outcome.turnCount !== state.turnCount) {
      return false;
    }
    const controller = condition.attackerController || "self";
    if (controller === "any") {
      return true;
    }
    // attackers スロットの owner で攻撃側の陣営を判定（self=owner の攻撃・opponent=相手の攻撃）。
    return (outcome.attackers || []).some((slot) =>
      controller === "opponent" ? slot.owner !== owner : slot.owner === owner,
    );
  }
  if (condition.op === "lastAttackIsLink") {
    // audit2(b063-3/b067-2/b053-6): 「このカードが（他の《X》と）連携攻撃したバトル(の)終了時」。battleEnd 誘発の時点で
    // pendingAttack は既に null なので、finishPendingAttack/nullify/endWithoutBattle が直前に凍結した
    // state.lastAttackOutcome（attackers・attackerInstanceIds・attackerCards）で判定する。同ターン限定。
    // includesSource:true＝context.card がその攻撃者に含まれる（instanceId 一致。旧 state はスロット一致で代替）。
    // otherFilter＝自分以外の攻撃者に filter 一致がいる（場に残っていれば現在の場札、離場していれば凍結写しで判定）。
    const outcome = state.lastAttackOutcome;
    if (!outcome || outcome.turnCount !== state.turnCount) {
      return false;
    }
    const slots = outcome.attackers || [];
    if (slots.length < 2) {
      return false;
    }
    const ids = outcome.attackerInstanceIds || slots.map((slot) => slot.instanceId ?? null);
    const self = context.card || getSelectedCard();
    let selfIndex = self?.instanceId != null ? ids.findIndex((id) => id != null && id === self.instanceId) : -1;
    if (selfIndex < 0 && !outcome.attackerInstanceIds) {
      const sourceSlot = findFieldCardSlot(self);
      selfIndex = sourceSlot ? slots.findIndex((slot) => sameSlot(slot, sourceSlot)) : -1;
    }
    if (condition.includesSource && selfIndex < 0) {
      return false;
    }
    if (condition.otherFilter) {
      return slots.some((slot, index) => {
        if (index === selfIndex) {
          return false;
        }
        const live = state.players[slot.owner]?.field?.[slot.zone];
        const card =
          live && (ids[index] == null || live.instanceId === ids[index]) ? live : outcome.attackerCards?.[index];
        return Boolean(card && matchesCardFilter(card, condition.otherFilter));
      });
    }
    return true;
  }
  if (condition.op === "lastAttackTargetMatches") {
    // E-PR13(PR/0382 使用タイミング「君のセンターのモンスターが攻撃されたバトルの終了時に使える」):
    // 直前に解決したバトルの被攻撃側(state.lastAttackOutcome.targetOwner/targetZone)を owner/zone で判定する。
    // lastAttackNullified(E-Y5/0088)と同系統・同窓管理: lastAttackOutcome は次の攻撃解決で必ず上書きされ、
    // turnCount で同ターンに限定する（攻撃無しでターンを跨いで真のまま残らない）。useConditions から使う。
    const outcome = state.lastAttackOutcome;
    if (!outcome || outcome.turnCount !== state.turnCount) {
      return false;
    }
    // owner: 被攻撃側の陣営（self=owner の被攻撃・opponent=相手の被攻撃）。fighter 攻撃(targetZone=null)は
    // zone 指定で自然に外れる。owner 未指定は陣営不問。
    if (condition.owner === "self" && outcome.targetOwner !== owner) {
      return false;
    }
    if (condition.owner === "opponent" && outcome.targetOwner === owner) {
      return false;
    }
    if (condition.zone && outcome.targetZone !== condition.zone) {
      return false;
    }
    if (Array.isArray(condition.zoneIn) && !zoneListIncludes(condition.zoneIn, outcome.targetZone)) {
      return false;
    }
    return true;
  }
  if (condition.op === "pendingAttackIncludesOtherMatching") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return getPendingAttackers().some(
      (attacker) =>
        (!sourceSlot || !sameSlot(attacker, sourceSlot)) &&
        matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "pendingAttackTargetMatches") {
    const target = getPendingBattleTargetInfo(state.pendingAttack);
    return Boolean(target?.card && matchesTargetFilter(target.card, target.owner, target.zone, condition.filter || {}));
  }
  if (condition.op === "linkAttackWithBuddy") {
    const attack = context.attack || state.pendingAttack;
    const attackers = (attack?.attackers || [])
      .map((slot) => ({ ...slot, card: state.players[slot.owner]?.field?.[slot.zone] }))
      .filter(({ card }) => card);
    return (
      attackers.length > 1 &&
      attackers.some(
        ({ owner: attackerOwner, card }) =>
          card.name === state.players[attackerOwner]?.buddy?.name || card.turnTreatAsBuddy === true,
      )
    );
  }
  if (condition.op === "pendingActionIsOpponent") {
    return Boolean(state.pendingAction && state.pendingAction.owner !== owner);
  }
  if (condition.op === "pendingActionKind") {
    // ver2.05 ⑤「必殺モンスターは、モンスターであり、必殺技でもある…「必殺技」を参照する場合、「必殺モンスター」も
    // それに該当」・Q4（必殺技を無効化するカードで必殺モンスターのコールも無効化される）＝必殺モンスターのコール宣言は
    // kind:"impact"（相手が必殺技を使った時）にも該当する。
    if (
      condition.kind === "impact" &&
      state.pendingAction?.kind === "call" &&
      (state.pendingAction.card?.baseType || state.pendingAction.card?.type) === "impactMonster"
    ) {
      return true;
    }
    return state.pendingAction?.kind === condition.kind;
  }
  if (condition.op === "pendingActionCardType") {
    return Boolean(state.pendingAction?.card && effectiveCardType(state.pendingAction.card) === condition.cardType);
  }
  if (condition.op === "pendingActionCardSizeLte") {
    return (state.pendingAction?.card?.size || 0) <= condition.amount;
  }
  if (condition.op === "pendingActionCardMatches") {
    // E11(D-CBT/0053 秘剣 滅竜陣): pendingAction 中のカードを matchesCardFilter でフル照合する汎用条件
    // （「相手が属性に「竜」か「ドラゴン」を含むモンスターをコールした時」= filter.attributeIncludesAny）。
    // 既存 pendingActionCardType/pendingActionCardSizeLte の一般化（cardType/attribute*/world/sizeIn 等の
    // 全 filter 語彙が使える）。既存カード使用0件＝挙動不変。
    return Boolean(state.pendingAction?.card && matchesCardFilter(state.pendingAction.card, condition.filter || {}));
  }
  if (condition.op === "pendingAttackTargetIs") {
    // 「相手のモンスター全てと相手に攻撃する」全体攻撃はファイターも攻撃対象に含むため、
    // fighter 指定の被弾条件（古竜の盾等）はこの攻撃にも反応できる。
    if (condition.targetType === "fighter" && state.pendingAttack?.attackAllIncludesFighter) {
      return true;
    }
    return state.pendingAttack?.targetType === condition.targetType;
  }
  if (condition.op === "pendingAttackTargetZone") {
    return state.pendingAttack?.targetZone === condition.zone;
  }
  // ver2.05 アタックフェイズの流れ Q3/A3「攻撃しているカードが、1枚以下になった場合、その時点でその攻撃は連携攻撃では
  // なくなります」＝宣言時の枚数ではなく、今も場に残っている攻撃者（getPendingAttackers）の枚数で判定する。
  if (condition.op === "pendingAttackNotLink") {
    return Boolean(state.pendingAttack && getPendingAttackers().length <= 1);
  }
  if (condition.op === "pendingAttackIsLink") {
    return Boolean(state.pendingAttack && getPendingAttackers().length > 1);
  }
  if (condition.op === "pendingAttackTargetIsSource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        state.pendingAttack &&
        state.pendingAttack.targetOwner === sourceSlot.owner &&
        state.pendingAttack.targetZone === sourceSlot.zone,
    );
  }
  if (condition.op === "pendingAttackDefenderIsSelf") {
    return state.pendingAttack?.defender === owner;
  }
  if (condition.op === "pendingAttackExists") {
    // F3(D-SS02/0005): 進行中の攻撃(state.pendingAttack)が有れば真（陣営不問）。手札対抗呪文を『自分の攻撃中』
    // にも使えるようにするゲート。pendingAttackDefenderIsSelf は防御側限定＝自ターンの攻撃コンボを封じてしまうため、
    // 「攻撃が進行中か」だけを見る。攻撃の無いメインフェイズでは偽になり、isCounterPlayTiming の先取り経路が
    // 対抗分岐を main で覆い隠す（draw 分岐を潰す）のを防ぐ。
    return Boolean(state.pendingAttack);
  }
  if (condition.op === "pendingActionResponderIsSelf") {
    // 相手が宣言したカード/効果(呪文・必殺技・起動能力等)の解決前の対抗窓で、自分が応答側(responder)か。
    // 黒竜の盾0101 のように「戦闘だけでなく相手の効果/必殺技のダメージにも対抗する」札を、
    // pendingAction 窓で使えるようにするための判定（preventNextDamage は解決前にセットされ、
    // 直後の効果解決の applyDamageToPlayer で消費される）。
    return state.pendingAction?.responder === owner;
  }
  if (condition.op === "lastDamageSourceMatches") {
    const event = state.counterEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    const sources = event.sources || (event.source ? [event.source] : []);
    return sources.some((source) => {
      if (condition.controller === "self" && source.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && source.owner === owner) {
        return false;
      }
      return Boolean(source.card && matchesCardFilter(source.card, condition.filter || {}));
    });
  }
  if (condition.op === "selfReceivedDamage") {
    // 「君がダメージを受けた時に使える」（五角の誓い H-BT03/0025 等）。
    // 戦闘ダメージ応答窓(counterEventWindow.kind==="damageDealt")で、自分が被弾者(defender)かつダメージ>0のとき真。
    const event = state.counterEventWindow;
    return Boolean(
      event &&
        event.turnCount === state.turnCount &&
        event.kind === "damageDealt" &&
        event.defender === owner &&
        (event.damage || 0) > 0,
    );
  }
  if (condition.op === "damageDealtThisTurnMatches") {
    // 既定は直近のダメージイベント(lastDamageEvent)のみを参照する（【対抗】応答ウィンドウ用途。
    // 「君が《武器》で相手にダメージを与えた時に使える」等はその戦闘の直後に使う想定）。
    // anyTimeThisTurn:true のカード（竜撃奥義 デュアル・ムービングフォース＝必殺技＝ファイナルフェイズで使用）は
    // 「武器がダメージを与えたターン中」を判定するため、当該ターンの全ダメージイベント(turnDamageEvents)を走査する。
    // lastDamageEvent は毎戦闘で上書きされ、武器ダメージの後に別のダメージが入ると発生源を見失うため。
    const events = condition.anyTimeThisTurn
      ? (state.turnDamageEvents && state.turnDamageEvents.length
          ? state.turnDamageEvents
          : state.lastDamageEvent
            ? [state.lastDamageEvent]
            : [])
      : state.lastDamageEvent
        ? [state.lastDamageEvent]
        : [];
    return events.some((event) => {
      if (!event || event.turnCount !== state.turnCount) {
        return false;
      }
      const sources = event.sources || (event.source ? [event.source] : []);
      return sources.some((source) => {
        if (condition.controller === "self" && source.owner !== owner) {
          return false;
        }
        if (condition.controller === "opponent" && source.owner === owner) {
          return false;
        }
        return Boolean(source.card && matchesCardFilter(source.card, condition.filter || {}));
      });
    });
  }
  if (condition.op === "lastEnteredCardMatches") {
    const event = state.enteredEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    return (event.entries || []).some((entry) => {
      if (condition.controller === "self" && entry.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && entry.owner === owner) {
        return false;
      }
      if (condition.zone && entry.zone !== condition.zone) {
        return false;
      }
      return Boolean(entry.card && matchesCardFilter(entry.card, condition.filter || {}));
    });
  }
  if (condition.op === "eventAttackersMatch") {
    return (context.attackers || []).some(
      (attacker) => attacker?.card && matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "sourceSoulCountGte") {
    return (context.card?.soul || []).length >= (condition.amount || 1);
  }
  if (condition.op === "lastDestroyedCardMatches") {
    const event = state.destroyedEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    return (event.entries || []).some((entry) => {
      if (condition.controller === "self" && entry.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && entry.owner === owner) {
        return false;
      }
      // X7(D-BT01/0114): 「君のカードの効果で破壊した時」= 効果破壊のみ・破壊した側の照合。
      if (condition.causeByEffect && !entry.cause?.byEffect) {
        return false;
      }
      if (condition.destroyerController === "self" && entry.cause?.destroyerOwner !== owner) {
        return false;
      }
      if (condition.destroyerController === "opponent" && entry.cause?.destroyerOwner === owner) {
        return false;
      }
      // audit2(b078-5): 破壊時のゾーン（「君のレフトかライトの～が破壊された時」）。zone 未記録の旧エントリは通す。
      if (entry.zone && Array.isArray(condition.zoneIn) && !zoneListIncludes(condition.zoneIn, entry.zone)) {
        return false;
      }
      if (entry.zone && Array.isArray(condition.zoneNot) && condition.zoneNot.includes(entry.zone)) {
        return false;
      }
      // サイズは破壊された瞬間の値(sizeAtDestroy)で判定（破壊後に conditionalSize をクリアしても不変）。
      // 型も破壊された瞬間の値(typeAtDestroy)で判定（rule-zones-3: 変身等はドロップで印字の型へ戻る）。
      const subject =
        entry.card && entry.typeAtDestroy && entry.typeAtDestroy !== effectiveCardType(entry.card)
          ? { ...entry.card, currentType: entry.typeAtDestroy }
          : entry.card;
      return Boolean(
        subject &&
          matchesCardFilter(subject, condition.filter || {}, { effectiveSizeOverride: entry.sizeAtDestroy }),
      );
    });
  }
  if (condition.op === "lastLeftFieldCardMatches") {
    // 「君の場のモンスターが場から離れた時」に使える札の使用条件。破壊に限らず手札戻し・ソウル入り・ドロップ/
    // デッキ/ゲージ送りの全離場を記録する leftFieldEventWindow（src/11 queueLeaveFieldTriggers）を見る。
    // 判定は離場時点の型（typeAtLeave）で行う（lastDestroyedCardMatches と同形・controller/filter）。
    const event = state.leftFieldEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    return (event.entries || []).some((entry) => {
      if (condition.controller === "self" && entry.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && entry.owner === owner) {
        return false;
      }
      const subject =
        entry.card && entry.typeAtLeave && entry.typeAtLeave !== effectiveCardType(entry.card)
          ? { ...entry.card, currentType: entry.typeAtLeave }
          : entry.card;
      return Boolean(subject && matchesCardFilter(subject, condition.filter || {}));
    });
  }
  if (condition.op === "eventReasonIs") {
    // X8(D-BT01/0082): 発火イベントの理由（rest の reason:"effect"/"attack" 等）を照合する。
    return (context.reason || null) === condition.reason;
  }
  if (condition.op === "hasArrival") {
    return Boolean(player.arrivalCardId);
  }
  if (condition.op === "ownItemHasAttribute") {
    return equippedItems(player).some((item) => item.attributes?.includes(condition.attribute));
  }
  if (condition.op === "ownItemStanding") {
    return equippedItems(player).some((item) => !item.used);
  }
  if (condition.op === "ownItemSoulCountGte") {
    // 君のアイテム（filter/attribute一致、既定は装備中アイテム）のソウル枚数が amount 以上か。
    // 例: アーマナイト・イブリース「君の《武器》のソウルが３枚以上なら貫通」。
    const amount = condition.amount ?? 1;
    const filter = condition.filter || (condition.attribute ? { attribute: condition.attribute } : {});
    return equippedItems(player).some(
      (item) => effectiveCardType(item) === "item" && matchesCardFilter(item, filter) && (item.soul?.length || 0) >= amount,
    );
  }
  if (condition.op === "buddyCalled") {
    // 君がバディをコール済みか。バディゾーンのカードを【レスト】にする＝バディコール済みの印であり、
    // 本アプリでは player.partnerCalled がそのフラグ。バディコールの“宣言”時（コスト支払い後・対抗確認の前）に
    // 立つ（src/07 callMonster / src/08 equipItem。無効化されても戻らない＝ver2.05「まだ宣言していない」）。
    return Boolean(player.partnerCalled);
  }
  if (condition.op === "selectedStatSumLte") {
    // E-Z1(X-SS01/0003 荒ぶる五角竜王 天武): script の ifCondition 内で使う。直前の selectCards が
    // context.vars[var] に入れた「選んだカード群」の stat（既定 power=攻撃力）の現在値（バフ込み・
    // visibleFieldStat）を合計し、amount 以下なら真。「選んだカードの攻撃力の合計が15000以下なら、
    // 選んだカード全てを破壊する」のゲート専用（真なら then の destroySelected を実行）。
    // stat（power/defense/critical）を持たないカードは visibleFieldStat が 0 を返す＝合計に非寄与。
    // 選択0枚（"好きな枚数"＝0枚可）は合計0＝真になり得るが、後続 destroySelected は空選択で no-op。
    // scriptSelection(src/14)/visibleFieldStat(src/15) は連結グローバルで実行時に参照可能。
    const selection = scriptSelection({ var: condition.var }, context);
    const stat = condition.stat || "power";
    const sum = selection.reduce((total, entry) => total + visibleFieldStat(entry?.card, stat), 0);
    return sum <= (condition.amount ?? 0);
  }
  if (condition.op === "selectionMatches") {
    // script の var（selectCards の選択や discardHand{var} の捨て札）のうち filter に一致するカードが
    // min 枚（既定1）以上あるか。「捨てたカードが《戦神機》なら」等の分岐ゲート（ダメージ・コントロール）。
    const selection = scriptSelection({ var: condition.var }, context);
    const matched = selection.filter((entry) => entry?.card && matchesCardFilter(entry.card, condition.filter || {}));
    return matched.length >= (condition.min ?? 1);
  }
  return true;
}


// ==========================================================================
// 対抗窓改修（rule-counter-1・rule-damage-4・rule-keywords-10）: 誘発/ライフリンクへの【対抗】窓。
// 設計の正: docs/対抗窓改修_設計_2026-10-08.md
// - ④2.2: 自動能力を選んだ後・解決の前に、選んでいないファイターへ【対抗】タイミング。②Q1: 自動能力にも【対抗】できる。
// - テンポ（オーナー裁定）: 窓は「その席が今使える【対抗】を1つ以上持ち、かつ『このターンはパス』していない」時だけ開く。
//   使える対抗が無ければプロンプトも await も挟まない（従来と同じ同期の流れ）。
// - 窓は chooseCardEntries（記録/再生・CPU・権威サーバ /prompt・60秒タイムアウトの共通 seam）に
//   options.counterWindow で載せる。候補は [パス, このターンはパス, 対抗候補…]。null(キャンセル/無応答)=パス。
// ==========================================================================
const COUNTER_WINDOW_PASS = "pass";
const COUNTER_WINDOW_PASS_TURN = "passTurn";
const COUNTER_WINDOW_USE = "use";
// 窓の対抗を実行している間の文脈（{ owner }）。この間は【対抗】の使用が「対抗タイミングへの応答」になる
// （宣言の対抗窓 pendingAction を開かず即時解決＝④2.2.3／相手はさらに対抗できない＝②Q2）。
let counterWindowUse = null;
// 窓の入れ子（窓で使った対抗の解決中にさらに窓を開く）は行わない。深さで抑止する。
let counterWindowDepth = 0;

function counterWindowUseActive(owner = null) {
  return Boolean(counterWindowUse && (owner === null || counterWindowUse.owner === owner));
}

// preventOpponentCounterThisTurn（0053 等）の対抗ロックが owner に掛かっているか（canUseCounterEffect と同じ判定）。
function counterLockedFor(owner) {
  return (state.opponentCounterLockThisTurn || []).some(
    (lock) =>
      owner === 1 - lock.owner &&
      counterLockSourceActive(lock) &&
      (!lock.while.length || checkCardConditions(lock.while, lock.owner, counterLockSourceContext(lock))),
  );
}

// 「このターンはパス」中か。
function counterWindowPassedThisTurn(seat) {
  const passed = state.counterWindowPass?.[seat];
  return passed !== null && passed !== undefined && passed === state.turnCount;
}

// 静的プレフィルタ: そのゾーンのカードが【対抗】タイミングの能力を（使えるかに関係なく）持つか。
function handCardHasCounterTimingAbility(card) {
  return (card?.abilities || []).some((ability) => canUseAbilityFromHand(ability) && isCounterAbility(ability));
}

function fieldCardHasCounterTimingAbility(card) {
  if (!card) {
    return false;
  }
  const own = [...(card.abilities || []), ...(card.grantedTempAbilities || [])].some(
    (ability) => ability && !ability.fromHandOnly && isFieldActivatedAbility(ability) && isCounterAbility(ability),
  );
  return (
    own ||
    (card.soul || []).some((soulCard) =>
      (soulCard.soulAbilities || []).some((ability) => isFieldActivatedAbility(ability) && isCounterAbility(ability)),
    )
  );
}

function dropCardHasCounterTimingAbility(card) {
  return (card?.abilities || []).some(
    (ability) => ability.kind === "activated" && ability.fromDropZone && isCounterAbility(ability),
  );
}

// 窓の前提（席に依らない部分）。
function counterWindowsOpenable() {
  return Boolean(
    Array.isArray(state?.players) &&
      state.players.length === 2 &&
      !state.winner &&
      // 攻撃/宣言の対抗窓が開いている間は従来窓に任せる。ただしその解決中（resolvingPending＝攻撃の破壊・貫通後の
      // 「破壊された時」等やライフリンク）は宣言窓が閉じた後の別の【対抗】タイミングなので開く（ver2.05 p.13 3.4）。
      (!hasPendingResolution() || state.resolvingPending) &&
      counterWindowDepth === 0 &&
      !state.counterWindow &&
      (COUNTER_PLAY_PHASES.includes(state.phase) || (state.resolvingPending && hasPendingResolution())),
  );
}

// seat が「今」使える【対抗】の候補（カード単位）。エンジン自身の finder だけで判定する（ルールの複製をしない）。
// finder は state.selected 文脈に依存するので一時的に差し替えて必ず戻す。
// exclude: 候補から除く instanceId（ライフリンクで場を離れた本人＝もう場に無い札は使えない）。
function counterWindowOptions(seat, exclude = null) {
  const player = state.players?.[seat];
  if (!player || counterLockedFor(seat)) {
    return [];
  }
  const allowed = (card) => !exclude || !card || !exclude.includes(card.instanceId);
  const handCandidates = player.hand.filter((card) => allowed(card) && handCardHasCounterTimingAbility(card));
  const fieldCandidates = Object.keys(player.field || {}).filter(
    (zone) => allowed(player.field[zone]) && fieldCardHasCounterTimingAbility(player.field[zone]),
  );
  const dropCandidates = player.drop.filter((card) => allowed(card) && dropCardHasCounterTimingAbility(card));
  if (!handCandidates.length && !fieldCandidates.length && !dropCandidates.length) {
    return []; // 静的プレフィルタ（大半の誘発はここで終わる＝テンポ/性能とも従来どおり）
  }
  const prevSelected = state.selected;
  const prevLink = state.linkAttackers;
  const options = [];
  const withSelected = (selected, evaluate) => {
    state.selected = selected;
    state.linkAttackers = [];
    try {
      return evaluate();
    } catch (error) {
      return false; // 判定不能は「使えない」側へ倒す（窓を開かない）
    } finally {
      state.selected = prevSelected;
      state.linkAttackers = prevLink;
    }
  };
  for (const card of handCandidates) {
    const usable = withSelected({ source: "hand", owner: seat, instanceId: card.instanceId }, () => {
      if (!canUseCardForFlag(player, card)) {
        return false;
      }
      const ability = findUsableHandAbility(card, { counterOnly: true });
      if (!ability) {
        return false;
      }
      const costSteps = adjustedAbilityCostSteps(player, card, ability);
      return canPayStructuredCost(player, costSteps, { sourceCard: card, selectedCard: card, allowInteractiveSelection: true }).ok;
    });
    if (usable) {
      options.push({ source: "hand", owner: seat, instanceId: card.instanceId, card });
    }
  }
  for (const zone of fieldCandidates) {
    const card = player.field[zone];
    // pt-final(1): 手札と同じく、コストを払える【対抗】がある時だけ候補にする（払えない場の【対抗】で窓を開き、
    // 選ぶと「コストで捨てる手札が足りません」で止まっていた＝ナノマシン忍者 白夜）。払い方が対象に依存する
    // コストは判定できないので従来どおり候補に残す。
    const usable = withSelected({ source: "field", owner: seat, zone, instanceId: card.instanceId }, () =>
      findUsableFieldAbilities(card, seat).some((ability) => {
        if (!isCounterAbility(ability) || ability.soulSpellCast) return false;
        const source = ability.fromSoul ? ability.soulSourceCard : card;
        const costSteps = abilityCostSteps(source, ability);
        return abilityCostPrecheck(player, costSteps, { sourceCard: source, selectedCard: source, ability, owner: seat }).ok;
      }),
    );
    if (usable) {
      options.push({ source: "field", owner: seat, zone, instanceId: card.instanceId, card });
    }
  }
  for (const card of dropCandidates) {
    const usable = withSelected({ source: "drop", owner: seat, instanceId: card.instanceId }, () =>
      findUsableDropAbilities(card, seat).some(
        (ability) =>
          isCounterAbility(ability) &&
          abilityCostPrecheck(player, abilityCostSteps(card, ability), { sourceCard: card, selectedCard: card, ability, owner: seat }).ok,
      ),
    );
    if (usable) {
      options.push({ source: "drop", owner: seat, instanceId: card.instanceId, card });
    }
  }
  return options;
}

// seat に窓を開くべきなら候補を返す（開かないなら null）。
function counterWindowOptionsIfOpen(seat, exclude = null) {
  if (!(seat === 0 || seat === 1) || !counterWindowsOpenable() || counterWindowPassedThisTurn(seat)) {
    return null;
  }
  const options = counterWindowOptions(seat, exclude);
  return options.length > 0 ? options : null;
}

// 窓の表示用ラベル（盤面上のどこにある札か）。
function counterWindowOptionNote(option) {
  if (option.source === "hand") return "手札";
  if (option.source === "drop") return "ドロップゾーン";
  return zoneLabel(option.zone) || "場";
}

// 1席ぶんの窓を開いて答えを処理する。info: { kind:"trigger"|"lifeLink", sourceName, sourceOwner, lead, damage, instantDefeat, damagedSeat }。
// 返り値: { opened, used } 。
async function runCounterWindowFor(seat, options, info = {}) {
  const passEntry = { counterWindowAnswer: COUNTER_WINDOW_PASS, card: { name: "パス", type: "choice" }, note: "【対抗】を使わない" };
  const passTurnEntry = {
    counterWindowAnswer: COUNTER_WINDOW_PASS_TURN,
    card: { name: "このターンはパス", type: "choice" },
    note: "このターンの終わりまで、誘発への対抗確認を出さない",
  };
  const useEntries = options.map((option) => ({
    counterWindowAnswer: COUNTER_WINDOW_USE,
    option,
    card: option.card,
    owner: option.owner,
    zone: option.source === "field" ? option.zone : undefined,
    note: counterWindowOptionNote(option),
    counterSource: option.source,
  }));
  // 窓IDは専用カウンタ（instanceSeq を消費しない＝カード instanceId の採番位置を窓IDから推測させない・JSON 往復で保持）。
  state.counterWindowSeq = (state.counterWindowSeq || 0) + 1;
  const windowId = `cw${state.counterWindowSeq}`;
  state.counterWindow = {
    id: windowId,
    kind: info.kind || "trigger",
    responder: seat,
    sourceName: info.sourceName || "",
    sourceOwner: info.sourceOwner ?? null,
    sourceInstanceId: info.sourceInstanceId || null, // バーの「ⓘ」で発生源の効果文を見るため（公開カードのみ解決できる）
    turnCount: state.turnCount,
  };
  counterWindowDepth += 1;
  let used = false;
  try {
    if (typeof render === "function") {
      render();
    }
    const title = info.kind === "lifeLink" ? "ライフリンクへの【対抗】" : "【対抗】できます";
    const lead =
      info.lead ||
      (info.kind === "lifeLink"
        ? `${info.sourceName || "カード"}のライフリンクが解決されます。【対抗】を使えます。`
        : `${info.sourceName || "カード"}の能力が解決されます。先に【対抗】を使えます。`);
    const selected = await chooseCardEntries([passEntry, passTurnEntry, ...useEntries], {
      title,
      lead,
      min: 1,
      max: 1,
      allowCancel: true,
      forceDialog: true,
      counterWindow: true,
      counterWindowInfo: { ...info, responder: seat, windowId },
      promptSeat: seat,
      purpose: "counter-window",
    });
    const answer = selected?.[0] || passEntry;
    if (answer.counterWindowAnswer === COUNTER_WINDOW_PASS_TURN) {
      state.counterWindowPass ||= [null, null];
      state.counterWindowPass[seat] = state.turnCount;
      addLog(`${state.players[seat].name}はこのターン、誘発への【対抗】確認をパスします。`);
    } else if (answer.counterWindowAnswer === COUNTER_WINDOW_USE && answer.option) {
      used = await executeCounterWindowOption(seat, answer.option);
    }
  } finally {
    counterWindowDepth = Math.max(0, counterWindowDepth - 1);
    if (state.counterWindow?.id === windowId) {
      state.counterWindow = null;
    }
    if (typeof render === "function") {
      render();
    }
  }
  return { opened: true, used };
}

// 窓で選ばれた【対抗】を、選んだ席の対抗タイミングへの応答として即時解決する（④2.2.3）。
// state.selected / 効果対象欄は窓の外の操作（解決中の本体）のものなので、必ず元へ戻す。
async function executeCounterWindowOption(seat, option) {
  const prevSelected = state.selected;
  const prevLink = state.linkAttackers;
  const effectTargetElement = typeof elements !== "undefined" ? elements.effectTarget : null;
  const prevEffectTarget = effectTargetElement ? effectTargetElement.value : "";
  state.selected = {
    source: option.source,
    owner: seat,
    instanceId: option.instanceId,
    ...(option.source === "field" ? { zone: option.zone } : {}),
  };
  state.linkAttackers = [];
  if (effectTargetElement) {
    effectTargetElement.value = ""; // 対象はダイアログで選ぶ（UI 方針）
  }
  const before = counterWindowStateFingerprint();
  counterWindowUse = { owner: seat };
  try {
    const card = getSelectedCard();
    if (!card || card.instanceId !== option.instanceId) {
      addLog("選んだ【対抗】のカードが見つからないため、使用しませんでした。");
      return false;
    }
    if (option.source === "hand") {
      if (!validateCardCanBeUsedByOwner(seat, card)) {
        return false;
      }
      const abilities = findUsableHandAbilities(card, { counterOnly: true });
      if (abilities.length === 0) {
        addLog(handAbilityUnavailableReason(card, seat, { counterOnly: true }));
        return false;
      }
      // 独立レビュー L5: 1枚に【対抗】能力が複数あれば既存の能力選択ダイアログで選ばせる（キャンセル＝使わない）。
      const ability = abilities.length === 1 ? abilities[0] : await chooseHandAbility(card, abilities, seat);
      if (!ability) {
        return false;
      }
      await useHandAbilityAction(card, ability, { counterKind: selectedCounterKind(card), counterTiming: true });
    } else if (option.source === "drop") {
      const abilities = findUsableDropAbilities(card, seat).filter((ability) => isCounterAbility(ability));
      await useFieldAbilityAction(card, { owner: seat, zone: "drop", inDrop: true, abilities });
    } else {
      const abilities = findUsableFieldAbilities(card, seat).filter(
        (ability) => isCounterAbility(ability) && !ability.soulSpellCast,
      );
      await useFieldAbilityAction(card, { owner: seat, zone: option.zone, abilities });
    }
  } finally {
    counterWindowUse = null;
    state.selected = prevSelected;
    state.linkAttackers = prevLink;
    if (effectTargetElement) {
      effectTargetElement.value = prevEffectTarget;
    }
  }
  return counterWindowStateFingerprint() !== before;
}

// 窓で選んだ対抗が実際に使われたか（不発＝コスト不足/対象キャンセル等と区別する）の粗い指紋。
function counterWindowStateFingerprint() {
  return JSON.stringify(
    (state.players || []).map((p) => [
      p.hand.length,
      p.drop.length,
      p.gauge.length,
      p.deck.length,
      p.life,
      Object.keys(p.field || {}).map((zone) => {
        const c = p.field[zone];
        return c ? `${c.instanceId}:${c.used ? 1 : 0}:${(c.soul || []).length}` : "";
      }),
    ]),
  );
}

// 誘発（自動能力）の解決直前の窓。responder＝能力を選んでいない側（④2.2）。開かなければ null を返す（同期・await 不要）。
function triggerCounterWindowOptions(owner) {
  if (!(owner === 0 || owner === 1)) {
    return null;
  }
  return counterWindowOptionsIfOpen(1 - owner);
}

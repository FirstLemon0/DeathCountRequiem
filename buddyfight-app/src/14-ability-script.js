// ==========================================================================
// buddyfight モジュール 14 — トリガー能力・効果スクリプトエンジン
// 旧 app.js L6487-8025 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
async function runTriggeredAbilities(card, event, baseContext = {}) {
  if (isAbilitiesNullified(card)) {
    return; // 能力無効化(凍てつく星辰)されたカードの誘発能力は発動しない
  }
  let triggeredAbilities = [
    ...(card.abilities || []).filter((ability) => ability.kind === "triggered" && ability.event === event),
    // E-PR11(PR/0389 「Brave Soul Fight！」): grantTemporaryTriggeredAbilitySelected で当ターン付与された
    // 一時トリガー能力(card.grantedTempAbilities)も、印字 abilities と同様に走査する。付与情報は素の DSL
    // オブジェクト（クロージャ無し）で state 内カードインスタンスに常駐＝room-store 復元/リプレイ/engine-host の
    // state 直列化だけで往復する。掃除は clearTurnModifiers(src/11・ターン終了/場外)と
    // resetLeftFieldCardState(src/08・離場)が turnKeywords と同寿命で行う。既存カードは grantedTempAbilities 未設定
    // ＝この spread は常に空＝挙動バイト不変（後方互換）。
    ...(card.grantedTempAbilities || []).filter((ability) => ability.kind === "triggered" && ability.event === event),
    // ソウルカードの triggered soulAbilities も、乗っているホスト(card)のイベントで発火（星合体 竜装機 0102 等）。
    ...(card.soul || []).flatMap((soulCard) =>
      (soulCard.soulAbilities || [])
        .filter((ability) => ability.kind === "triggered" && ability.event === event)
        .map((ability) => ({ ...ability, __fromSoul: soulCard })),
    ),
    // inheritSoulAbilities: ホストが「ソウルにあるカードの能力を得る」。{label}=EB03 爆雷継承（label一致 triggered）／
    // {filter}=D-BT04 ジェムクローン E1（filter一致ソウル札の triggered 全event）。ソウル札の通常 abilities(kind:triggered)
    // を、このイベントでホストの誘発として合流させる。
    ...inheritedSoulAbilitiesFor(card, event),
  ];
  // ドロップゾーン走査などで、opt-in した能力だけに絞る（runPhaseStartTriggers から指定）。
  if (typeof baseContext.__abilityFilter === "function") {
    triggeredAbilities = triggeredAbilities.filter(baseContext.__abilityFilter);
  }
  for (const ability of triggeredAbilities) {
      const owner = baseContext.owner ?? findFieldCardSlot(card)?.owner;
      if (owner === undefined || owner === null) {
        continue;
      }
      const context = {
        ...baseContext,
        card,
        ability,
        soulSourceCard: ability.__fromSoul || baseContext.soulSourceCard,
        player: state.players[owner],
        owner,
        zone: baseContext.zone ?? findFieldCardSlot(card)?.zone,
      };
      if (
        ability.target &&
        !context.target &&
        !ability.allowMissingTarget &&
        targetCandidatesFromSpecForOwner(ability.target, owner, { card, ability }).length === 0
      ) {
        continue;
      }
      if (isAbilityLimitUsed(owner, card, ability) || !checkAbilityConditions(ability, owner, context)) {
        continue;
      }
      const player = state.players[owner];
      const costContext = {
        sourceCard: card,
        selectedCard: card,
        allowInteractiveSelection: true,
      };
      // 誘発能力コストも adjustedCostSteps を通す（costReduction/reduceByFieldCount の適用を統一）。
      const triggeredCostSteps = adjustedCostSteps(player, card, abilityCostPurpose(ability), ability.cost || []);
      const canPay = canPayStructuredCost(player, triggeredCostSteps, costContext);
      if (!canPay.ok) {
        if (!ability.optional) {
          addLog(canPay.reason);
        }
        continue;
      }
      if (!(await shouldUseOptionalAbility(card, ability, owner))) {
        addLog(`${card.name}の任意能力を使いませんでした。`);
        continue;
      }
      if (ability.target && (!context.target || context.target.__fromEvent) && !Array.isArray(ability.script)) {
        context.target = await chooseAbilityTarget(card, ability, owner);
        if (!context.target && !ability.allowMissingTarget && !ability.target?.allowMissingTarget) {
          addLog(`${card.name}の対象が選ばれなかったため、能力を解決しませんでした。`);
          continue;
        }
      }
      const payment = await payStructuredCostWithSelection(player, triggeredCostSteps, costContext);
      if (!payment.ok) {
        addLog(ability.optional ? `${card.name}の任意能力を使いませんでした。` : payment.reason);
        continue;
      }
      context.player = player;
      // 発動回数制限は「発動時」に消費する（本体解決の前）。コスト支払い済みでこの能力は確定発動なので、
      // ここで印字するのが「この能力は1ターンに1回だけ発動する」の正しいタイミング。かつ本体解決中に
      // 同一イベントが同期再発火する効果（爆雷連鎖: dealDamage→opponentDamagedByBakurai 等）でも、
      // markAbilityLimit を本体後に置くと再入時に isAbilityLimitUsed がまだ false で無限再発火→ヒープOOM。
      // 発動時に印字しておけば再入は isAbilityLimitUsed=true で弾かれ、規則通り1回で打ち切られる。
      markAbilityLimit(owner, card, ability);
      await executeAbilityBody(context);
    }
}

// E1(D-BT04/0006 フェイク・ヒーラー・0115 オリジン・ブレイカー): inheritSoulAbilities:{filter} モード。
// ソウル札のうち filter 一致カード（ジェムクローンなら {cardType:"impactMonster", nameNotIncludes:"ジェムクローン"}）を返す。
// host が能力無効化されていれば空＝継承停止（label モードと同じゲート）。filter モード共通のソウル札選別で、
// triggered(src/14)・continuous(src/05 stats 集計)・keywords(src/18 hasKeyword) の3面から呼ぶ。
// label モード（EB03 爆雷継承）とは独立の新分岐＝既存 label 挙動は1ビットも変えない。
function inheritedFilterSoulCards(card) {
  const filter = card?.inheritSoulAbilities?.filter;
  if (!filter || !(card.soul || []).length || isAbilitiesNullified(card)) {
    return [];
  }
  return (card.soul || []).filter((soulCard) => matchesCardFilter(soulCard, filter));
}

// inheritSoulAbilities を持つホスト card について、ソウル札の通常 abilities のうち kind:triggered・event一致で
// ホスト誘発として合流する配列を返す。2モード:
//   - {label}（EB03 爆雷継承 0004/0012/0013/0017/0061）: label 一致の triggered のみ。
//   - {filter}（D-BT04 ジェムクローン E1）: filter 一致ソウル札の triggered 全 event（label 無視）。
// limit はソウル札インスタンス単位で管理（__fromSoul により markAbilityLimit/isAbilityLimitUsed が識別）。
function inheritedSoulAbilitiesFor(card, event) {
  const inherit = card?.inheritSoulAbilities;
  if (!inherit || !(card.soul || []).length || isAbilitiesNullified(card)) {
    return [];
  }
  // E-XB65(X2-BT01/0001 完全竜化 竜牙王): 継承能力の limit を親（ホスト）側で差し替える最小フック。
  // 竜牙王は「このカードのソウルの『大逆天』を得て、君はこのファイト中に2回、『大逆天』を使える」＝ソウル側の印字
  // 大逆天は count 無し（＝normalizedAbilityLimit のキーワード導出で fight/greatReversal・実質1回）だが、ホストが継承する
  // 分だけは E-XB61 の fight count:2 へ上書きしたい。limitOverride を指定すると継承コピー a に limit を付与し、
  // normalizedAbilityLimit(ability) が ability.limit を最優先で読む（キーワード導出より前）ため回数上限が差し替わる。
  // 未指定（既存の inheritSoulAbilities 全カード）は limit を付けず＝従来どおりキーワード/印字 limit のまま＝挙動不変。
  const withOverride = (a) =>
    inherit.limitOverride ? { ...a, __fromSoul: a.__fromSoul, limit: inherit.limitOverride } : a;
  if (inherit.label) {
    return (card.soul || []).flatMap((soulCard) =>
      (soulCard.abilities || [])
        .filter((a) => a.kind === "triggered" && a.event === event && a.label === inherit.label)
        .map((a) => withOverride({ ...a, __fromSoul: soulCard })),
    );
  }
  if (inherit.filter) {
    return inheritedFilterSoulCards(card).flatMap((soulCard) =>
      (soulCard.abilities || [])
        .filter((a) => a.kind === "triggered" && a.event === event)
        .map((a) => withOverride({ ...a, __fromSoul: soulCard })),
    );
  }
  return [];
}

// card（場札）が event に反応する誘発リスナーを持つか。card自身/ソウルのsoulAbilities/爆雷継承を考慮。
// queue*Triggers の hasListener 早期リターンで使う（inheritSoulAbilities 持ちホストを取りこぼさないため）。
function cardHasTriggeredListener(card, event) {
  if (!card) {
    return false;
  }
  if ((card.abilities || []).some((a) => a.kind === "triggered" && a.event === event)) {
    return true;
  }
  if ((card.soul || []).some((s) => (s.soulAbilities || []).some((a) => a.kind === "triggered" && a.event === event))) {
    return true;
  }
  return inheritedSoulAbilitiesFor(card, event).length > 0;
}

async function chooseAbilityTarget(card, ability, owner) {
  const candidates = targetCandidatesFromSpecForOwner(ability.target, owner, { card, ability });
  if (candidates.length === 0) {
    return null;
  }
  const selected = await chooseCardEntries(candidates, {
    title: `${card.name}の対象`,
    lead: "効果の対象にするカードを選んでください。",
    min: 1,
    max: 1,
    forceDialog: true,
    // 権威サーバ: 能力主体の席へ往復させる（未指定だと inferPromptSeat 任せで
    // 相手誘発・攻撃側誘発の選択が誤配送＝候補名漏れの恐れ）。
    promptSeat: owner,
  });
  const target = selected?.[0];
  return target ? { owner: target.owner, zone: target.zone, card: target.card } : null;
}

async function shouldUseOptionalAbility(card, ability, owner) {
  if (!ability.optional) {
    return true;
  }
  const selected = await chooseCardEntries(
    [
      {
        key: "use",
        card: {
          name: "使う",
          rules: [`${card.name}の任意能力を使います。`],
          attributes: [],
          keywords: [],
          costs: {},
        },
      },
      {
        key: "skip",
        card: {
          name: "使わない",
          rules: [`${card.name}の任意能力を使いません。`],
          attributes: [],
          keywords: [],
          costs: {},
        },
      },
    ],
    {
      title: `${card.name}の任意能力`,
      lead: "この能力を使いますか？",
      min: 1,
      max: 1,
      forceDialog: true,
      // 権威サーバ: 任意能力の発動可否は能力主体の席へ問う。
      promptSeat: owner,
    },
  );
  return selected?.[0]?.key === "use";
}

async function executeAbilityBody(context) {
  const ability = context.ability || {};
  if (Array.isArray(ability.script) && ability.script.length > 0) {
    return executeAbilityScript(ability.script, context);
  }
  const legacyScript = legacyAbilityScriptDefinition(ability.handler);
  if (legacyScript) {
    return executeAbilityScript(legacyScript, {
      ...context,
      ability: {
        ...ability,
        script: legacyScript,
      },
    });
  }
  const handler = ability.handler ? abilityHandlers[ability.handler] : null;
  if (ability.handler && !handler) {
    addLog(`未実装の効果ハンドラです: ${ability.handler}`);
    return false;
  }
  if (handler) {
    await handler(context);
    return true;
  }
  await executeAbilityEffects(ability.effects || [], context);
  return true;
}

async function executeAbilityScript(script, context) {
  const scriptContext = {
    ...context,
    vars: {
      ...(context.vars || {}),
    },
  };
  recordDiagnosticEvent("effect_script", {
    stage: "start",
    card: compactCardForLog(context.card),
    abilityId: context.ability?.id || "",
    stepCount: script.length,
  });
  for (const [index, step] of script.entries()) {
    recordDiagnosticEvent("effect_script", {
      stage: "step",
      index,
      op: step.op,
      var: step.var || "",
      card: compactCardForLog(context.card),
      abilityId: context.ability?.id || "",
    });
    // CPU対戦(src/22): selectCards の用途推論（消費opの参照）用に現在位置を渡す。エンジン挙動には影響しない。
    scriptContext.__scriptSteps = script;
    scriptContext.__scriptIndex = index;
    const result = await executeAbilityScriptStep(step, scriptContext);
    if (result === false || result?.ok === false) {
      recordDiagnosticEvent("effect_script", {
        stage: "stopped",
        index,
        op: step.op,
        reason: result?.reason || "script_step_failed",
        card: compactCardForLog(context.card),
        abilityId: context.ability?.id || "",
      });
      context.vars = scriptContext.vars;
      if (scriptContext.cardMoved) context.cardMoved = true; // レビュー修正(D-BT01/0027/0034): script内の自己移動を外側へ伝播
      return false;
    }
  }
  context.vars = scriptContext.vars;
  if (scriptContext.cardMoved) context.cardMoved = true; // レビュー修正(D-BT01/0027/0034): script内の自己移動を外側へ伝播
  recordDiagnosticEvent("effect_script", {
    stage: "complete",
    card: compactCardForLog(context.card),
    abilityId: context.ability?.id || "",
  });
  return true;
}

function canSatisfyAbilityScript(card, ability, owner, baseContext = {}) {
  const script = Array.isArray(ability?.script) && ability.script.length > 0
    ? ability.script
    : legacyAbilityScriptDefinition(ability?.handler);
  if (!Array.isArray(script) || script.length === 0) {
    return true;
  }
  const context = {
    ...baseContext,
    card,
    ability,
    player: state.players[owner],
    owner,
    vars: {},
  };
  return canSatisfyScriptSteps(script, context);
}

function canSatisfyScriptSteps(script, context) {
  return (script || []).every((step) => {
    if (step.op === "selectCards") {
      // E-XB6: from:"var" の候補は先行ステップの選択で実行時に確定する。事前充足チェックの時点では
      // 未確定（vars 空）なので楽観的に満たせる扱いにする（過小評価でアビリティが不発になるのを防ぐ）。
      if (step.from === "var") {
        return true;
      }
      const candidates = groupScriptCandidates(scriptCardSelectionCandidates(step, context), step);
      const amount = step.amount ?? 1;
      const allowEmpty = Boolean(step.allowEmpty && candidates.length === 0);
      const min = allowEmpty ? 0 : step.min ?? (step.require === false ? 0 : amount);
      return candidates.length >= min;
    }
    return true;
  });
}

async function executeAbilityScriptStep(step, context) {
  if (step.op === "selectCards") {
    return selectCardsForScript(step, context);
  }
  if (step.op === "moveSelected") {
    return moveSelectedForScript(step, context);
  }
  if (step.op === "moveSelectedGroup") {
    return moveSelectedGroupForScript(step, context);
  }
  if (step.op === "ifSelection") {
    return ifSelectionForScript(step, context);
  }
  if (step.op === "ifTargetController") {
    return ifTargetControllerForScript(step, context);
  }
  if (step.op === "ifCondition") {
    return ifConditionForScript(step, context);
  }
  if (step.op === "chooseBranch") {
    return chooseBranchForScript(step, context);
  }
  if (step.op === "moveSelectedToDeckBottomOrdered") {
    return moveSelectedToDeckBottomOrderedForScript(step, context);
  }
  if (step.op === "moveSelectedToDeckTopOrdered") {
    return moveSelectedToDeckTopOrderedForScript(step, context);
  }
  if (step.op === "reorderTopOrdered") {
    return reorderTopOrderedForScript(step, context);
  }
  if (step.op === "revealedCardToVar") {
    return revealedCardToVarForScript(step, context);
  }
  if (step.op === "payCost") {
    return payCostForScript(step, context);
  }
  if (step.op === "payLifeChoose") {
    return payLifeChooseForScript(step, context);
  }
  if (step.op === "destroySelected") {
    return await destroySelectedForScript(step, context);
  }
  if (step.op === "grantKeywordSelected") {
    return grantKeywordSelectedForScript(step, context);
  }
  if (step.op === "grantTemporaryTriggeredAbilitySelected") {
    return grantTemporaryTriggeredAbilitySelectedForScript(step, context);
  }
  if (step.op === "grantTemporaryAttackResistanceSelected") {
    return grantTemporaryAttackResistanceSelectedForScript(step, context);
  }
  if (step.op === "gainTemporaryWorldFromVar") {
    return gainTemporaryWorldFromVarForScript(step, context);
  }
  if (step.op === "grantTemporaryDestroyImmunitySelected") {
    return grantTemporaryDestroyImmunitySelectedForScript(step, context);
  }
  if (step.op === "gainNameAsSelected") {
    return gainNameAsSelectedForScript(step, context);
  }
  if (step.op === "gainSelectedCardAbilitiesForTurn") {
    return gainSelectedCardAbilitiesForTurnForScript(step, context);
  }
  if (step.op === "eachPlayerConfirmBranch") {
    return eachPlayerConfirmBranchForScript(step, context);
  }
  if (step.op === "moveAllOwnFieldToDrop") {
    return moveAllOwnFieldToDropForScript(step, context);
  }
  if (step.op === "dealDamageBySelectedStatSum") {
    return dealDamageBySelectedStatSumForScript(step, context);
  }
  if (step.op === "setAttackRedirectThisTurn") {
    return setAttackRedirectThisTurnForScript(step, context);
  }
  if (step.op === "modifySelectedStats") {
    return modifySelectedStatsForScript(step, context);
  }
  if (step.op === "restSelected") {
    return restSelectedForScript(step, context);
  }
  if (step.op === "preventCardAttackThisTurn") {
    // 選択した var のモンスターを「そのターン中攻撃できない」状態にする（グレイプニルのソウルコール等）。
    // レストと違いスタンドしても解除されず、ターン終了(clearTurnModifiers)でのみ解除される。
    for (const entry of scriptSelection(step, context)) {
      if (entry.card) {
        entry.card.cannotAttackThisTurn = true;
      }
    }
    return true;
  }
  if (step.op === "putSelectedToGauge") {
    return putSelectedToGaugeForScript(step, context);
  }
  if (step.op === "dropSelectedSoul") {
    return dropSelectedSoulForScript(step, context);
  }
  if (step.op === "discardSelfSoul") {
    return discardSelfSoulForScript(step, context);
  }
  if (step.op === "moveSoulToDrop") {
    return moveSoulToDropForScript(step, context);
  }
  if (step.op === "payCardCostForSelection") {
    return payCardCostForScriptSelection(step, context);
  }
  if (step.op === "useSelectedCardAbility") {
    return useSelectedCardAbilityForScript(step, context);
  }
  if (step.op === "useSelectedCard") {
    return useSelectedCardForScript(step, context);
  }
  if (step.op === "equipSelectedAsItem") {
    return equipSelectedAsItemForScript(step, context);
  }
  if (step.op === "useTopDeckCardIfMatchesElseBottom") {
    return useTopDeckCardIfMatchesElseBottomForScript(step, context);
  }
  if (step.op === "selectZone") {
    return selectZoneForScript(step, context);
  }
  if (step.op === "callSelected") {
    return callSelectedForScript(step, context);
  }
  if (step.op === "opponentMayCallFromHand") {
    return opponentMayCallFromHandForScript(step, context);
  }
  if (step.op === "callSelfFromHand") {
    return callSelfFromHandForScript(step, context);
  }
  if (step.op === "callSelfFromSoul") {
    return callSelfFromSoulForScript(step, context);
  }
  if (step.op === "swapFieldPositions") {
    return swapFieldPositionsForScript(step, context);
  }
  if (step.op === "callTopDeckAsMonster") {
    return callTopDeckAsMonsterForScript(step, context);
  }
  if (step.op === "callSelectedAsMonster") {
    return callSelectedAsMonsterForScript(step, context);
  }
  if (step.op === "callSelectedToEmptyZones") {
    return callSelectedToEmptyZonesForScript(step, context);
  }
  if (step.op === "stackCallSelected") {
    return stackCallSelectedForScript(step, context);
  }
  if (step.op === "placeSelected") {
    return placeSelectedForScript(step, context);
  }
  if (step.op === "shuffleDeck") {
    return shuffleDeckForScript(step, context);
  }
  if (step.op === "declareCardName") {
    return declareCardNameForScript(step, context);
  }
  if (step.op === "standSelected") {
    return standSelectedForScript(step, context);
  }
  if (step.op === "ifSelectionMatches") {
    return ifSelectionMatchesForScript(step, context);
  }
  if (step.op === "moveSelectedToSelectedSoul") {
    return moveSelectedToSelectedSoulForScript(step, context);
  }
  if (step.op === "putTopDeckToSelectedSoul") {
    return putTopDeckToSelectedSoulForScript(step, context);
  }
  if (step.op === "lookTopSelectToSelectedSoulRestToBottom") {
    return lookTopSelectToSelectedSoulRestToBottomForScript(step, context);
  }
  if (step.op === "lookTopSelectToSelectedSoulRest") {
    return lookTopSelectToSelectedSoulRestForScript(step, context);
  }
  if (step.op === "searchDeckToSelectedSoul") {
    return searchDeckToSelectedSoulForScript(step, context);
  }
  if (step.op === "moveSoulToGauge") {
    return moveSoulToGaugeForScript(step, context);
  }
  if (step.op === "moveSelfToSelectedSoul") {
    return moveSelfToSelectedSoulForScript(step, context);
  }
  if (step.op === "putSelfToGauge") {
    return putSelfToGaugeForScript(step, context);
  }
  if (step.op === "stopUnlessMovedToDropMatches") {
    return stopUnlessMovedToDropMatchesForScript(step, context);
  }
  if (step.op === "log") {
    addLog(interpolateScriptMessage(step.message || "", context));
    return true;
  }
  if (isScriptEffectStep(step)) {
    await executeAbilityEffect(step, context);
    return true;
  }
  addLog(`未実装のscript命令です: ${step.op}`);
  return { ok: false, reason: `unknown_script_op:${step.op}` };
}

async function selectCardsForScript(step, context) {
  const rawCandidates = scriptCardSelectionCandidates(step, context);
  const candidates = groupScriptCandidates(rawCandidates, step);
  const amount = step.amount ?? 1;
  const allowEmpty = Boolean(step.allowEmpty && candidates.length === 0);
  let min = allowEmpty ? 0 : step.min ?? (step.require === false ? 0 : amount);
  let max = step.max ?? amount;
  if (step.maxByEmptyFieldZones) {
    max = Math.min(max, fieldZones.filter((zone) => !context.player.field[zone]).length);
  }
  if (step.maxFrom) {
    // 選択上限を amountFrom スペックで動的決定（0020: ドロップの“爆雷”数まで選ぶ）。
    max = resolveAmountFrom(step.maxFrom, context);
  }
  if (step.minFrom && !allowEmpty) {
    // 選択下限も amountFrom で動的決定（「対象のサイズの数値以上」払う等。H-BT04/0006）。
    min = resolveAmountFrom(step.minFrom, context);
    max = Math.max(max, min);
  }
  if (max <= 0) {
    // 選択上限が0（maxFrom:buddyZoneCount が0 / maxByEmptyFieldZones が0 等）なら、候補が
    // 残っていても「0枚選択」として解決し、決定不能の選択ダイアログ（罠）を出さない。
    // allowEmpty:true と同じ扱い。min>0 の必須指定のみ require に従い不成立扱いにする。
    context.vars[step.var] = [];
    if (step.emptyMessage) {
      addLog(step.emptyMessage);
    }
    return min > 0 && step.require !== false ? { ok: false, reason: "no_selectable_slots" } : true;
  }
  recordDiagnosticEvent("effect_script", {
    stage: "select_candidates",
    op: step.op,
    var: step.var,
    from: step.from,
    candidateCount: candidates.length,
    candidates: candidates.map(compactChoiceForLog),
    card: compactCardForLog(context.card),
  });
  if (candidates.length < min) {
    context.vars[step.var] = [];
    addLog(step.emptyMessage || `${context.card.name}で選べるカードがありません。`);
    return step.require === false ? true : { ok: false, reason: "not_enough_candidates" };
  }
  if (allowEmpty) {
    context.vars[step.var] = [];
    if (step.emptyMessage) {
      addLog(step.emptyMessage);
    }
    return true;
  }
  // E-XB6(X-SS03/0012 カリスマジック): chooser:"opponent" は選択プロンプトを相手席へ往復させる
  // （opponentMayCallFromHandForScript の promptSeat=相手席と同じ配管・リプレイ/room 復元/権威サーバ決定的）。
  // 未指定＝従来どおり能力主体（context.owner）席＝完全後方互換。
  const chooserSeat = step.chooser === "opponent" ? 1 - context.owner : context.owner;
  // E-XB6: shuffle:true は候補を決定的(rng・shuffle=state 常駐 rngInt)にシャッフルしてから提示する
  // （「２枚を裏向きにしてシャッフルし」＝相手の並び順を伏せる）。faceDown と併用で真のブラインド選択。
  const presentCandidates = step.shuffle ? shuffle(candidates) : candidates;
  const selected = await chooseCardEntries(presentCandidates, {
    title: step.title || `${context.card.name}の選択`,
    lead: step.lead || `${min}枚選んでください。`,
    min,
    max,
    forceDialog: step.forceDialog !== false,
    // 権威サーバ: スクリプト選択は既定で能力主体（context.owner）の席へ往復させる。
    // 相手誘発(opponentEnter等)が能動側ターンに選ぶ場合、未指定だと能動側へ誤配送＝手札漏れ。
    // chooser:"opponent" 指定時のみ相手席へ振る。
    promptSeat: chooserSeat,
    // E-XB6: faceDown:true は候補の正体（名前/番号/スタッツ/instanceId/索引）を伏せて提示する
    // （裏向きのブラインド選択・T13＝相手へ余計な公開情報を渡さない）。解決は choiceIndex で実カードへ写像。
    faceDown: Boolean(step.faceDown),
    // CPU対戦(src/22): 用途タグ。DSLの明示指定(purpose/role)が最優先、無ければ消費opから推論。
    purpose:
      step.purpose ||
      step.role ||
      (typeof aiInferScriptSelectPurpose === "function" ? aiInferScriptSelectPurpose(step, context) : undefined),
  });
  if (!selected || selected.length < min) {
    context.vars[step.var] = [];
    addLog(step.cancelMessage || `${context.card.name}のカードを選んでください。`);
    return step.require === false ? true : { ok: false, reason: "selection_cancelled" };
  }
  context.vars[step.var] = selected;
  return true;
}

function groupScriptCandidates(candidates, step) {
  if (!step.groupBy) {
    return candidates;
  }
  const groups = new Map();
  candidates.forEach((entry) => {
    const key = scriptGroupKey(entry.card, step.groupBy);
    if (!key) {
      return;
    }
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  });
  const requiredSize = step.groupSizeGte || 1;
  return [...groups.entries()]
    .filter(([, group]) => group.length >= requiredSize)
    .map(([key, group]) => ({
      ...group[0],
      group,
      note: step.note || `${key} ${group.length}枚`,
    }));
}

function scriptGroupKey(card, groupBy) {
  if (groupBy === "name") {
    return card.name;
  }
  if (groupBy === "id") {
    return card.id;
  }
  return card[groupBy];
}

function scriptCardSelectionCandidates(step, context) {
  const from = step.from || "field";
  if (from === "var") {
    // E-XB6(X-SS03/0012 カリスマジック): 直前の選択(var)のエントリを候補にする（「君が選んだ2枚から
    // 相手が1枚選ぶ」型の2段選択）。sourceVar（単一）か sourceVars（複数=マージ）で参照する。
    // 各エントリは元の source/index/owner を保持したまま渡し、後段の callSelected/moveSelected が
    // 正しい実ゾーンから取り出せるようにする。
    const varNames = Array.isArray(step.sourceVars)
      ? step.sourceVars
      : [step.sourceVar].filter(Boolean);
    const seen = new Set();
    const entries = [];
    for (const name of varNames) {
      for (const entry of scriptSelection({ var: name }, context)) {
        if (!entry?.card || (entry.card.instanceId && seen.has(entry.card.instanceId))) {
          continue;
        }
        if (entry.card.instanceId) {
          seen.add(entry.card.instanceId);
        }
        if (!scriptCardMatches(entry.card, entry.owner ?? context.owner, entry.zone, step, context)) {
          continue;
        }
        entries.push({
          ...entry,
          note: step.note || entry.note || scriptSourceLabel(entry.source || "drop"),
        });
      }
    }
    return entries;
  }
  if (from === "pendingAttackers") {
    return getPendingAttackers()
      .filter((entry) =>
        scriptControllerMatches(step.controller, entry.owner, context.owner) &&
          scriptCardMatches(entry.card, entry.owner, entry.zone, step, context),
      )
      .map((entry) => ({
        ...entry,
        source: "field",
        note: step.note || zoneLabel(entry.zone),
      }));
  }
  if (from === "movedToDrop") {
    const movedEntries = context.movedToDropEntries || (context.movedToDrop || []).map((card) => ({
      owner: context.owner,
      card,
    }));
    return movedEntries
      .filter((entry) => scriptControllerMatches(step.controller, entry.owner, context.owner))
      .map((entry) => {
        const pile = state.players[entry.owner]?.drop || [];
        const index = pile.findIndex((card) => card.instanceId === entry.card?.instanceId);
        return index >= 0 ? { ...entry, index, source: "drop", note: step.note || scriptSourceLabel("drop") } : null;
      })
      .filter((entry) => entry && scriptCardMatches(entry.card, entry.owner, null, step, context));
  }
  if (from === "field") {
    return allFieldTargets((card, owner, zone) =>
      scriptControllerMatches(step.controller, owner, context.owner) &&
        scriptCardMatches(card, owner, zone, step, context),
    ).map((entry) => ({
      ...entry,
      source: "field",
      note: step.note || zoneLabel(entry.zone),
    }));
  }
  const candidates = [];
  const fromPiles = Array.isArray(from) ? from : [from];
  for (const pileKey of fromPiles) {
    for (const owner of scriptOwnersForController(step.controller || "self", context.owner)) {
      const pile = scriptPileForSource(owner, pileKey, context, step);
      if (!pile) {
        continue;
      }
      const soulHost = pileKey === "soul" && step.hostVar
        ? scriptSelection({ var: step.hostVar }, context)[0]?.card || context.card
        : context.card;
      pile.forEach((card, index) => {
        if (!scriptCardMatches(card, owner, null, step, context)) {
          return;
        }
        candidates.push({
          card,
          index,
          owner,
          source: pileKey,
          sourceCard: pileKey === "soul" ? soulHost : null,
          note: step.note || scriptSourceLabel(pileKey),
        });
      });
    }
  }
  return candidates;
}

function scriptCardMatches(card, owner, zone, step, context) {
  if (!card) {
    return false;
  }
  if (step.excludeSource === true && card.instanceId === context.card?.instanceId) {
    return false;
  }
  // excludeBattling（S-UB-C03/0074「バトルしていないキャラ1枚を選び」）: 進行中のバトルに
  // 参加している（攻撃側/防御対象の）カードを候補から除外する。
  if (step.excludeBattling === true && card.instanceId && pendingBattleCardIds().has(card.instanceId)) {
    return false;
  }
  // X17(D-BT01/0102): 「バトルしている〜を選び」= 進行中バトルの参加者（攻撃側/防御対象）のみに絞る包含側フィルタ。
  if (step.onlyBattling === true && !(card.instanceId && pendingBattleCardIds().has(card.instanceId))) {
    return false;
  }
  // X20(D-BT01/0028): 場からの選択をゾーンで絞る（「相手のセンターのモンスター」等。filter.zone は
  // matchesCardFilter が解釈しないため、step.zones で明示する）。
  if (Array.isArray(step.zones) && zone && !step.zones.includes(zone)) {
    return false;
  }
  // E-PR3(PR/0175 バディ・リコール / PR/0106 / 出荷済み bf-h-eb01-0013): selectCards の候補判定にも
  // owner を渡し、filter.buddy を「ドロップ/デッキ/手札等の場外」でも検索主の登録バディ名で判定させる
  // （E-XC15 が searchDeckToHand に入れた owner 伝播と同型。場のカードは findFieldCardSlot で所有者を
  //  特定できるため owner は無視される＝場・field 経路の挙動は不変。owner は from 各経路で pile/場の所有者）。
  // 相対フィルタ（発生源カード基準）: matchesCardFilter は sameInstanceAsSource 等を解釈しない
  // （effect 経路は matchesRelativeCardFilter 側・src/15 が担うが、script の selectCards/callSelected/
  //  moveSelected 経路はここを通る）。従来これらのキーは黙殺され「このカード自身１枚」を厳密に絞れず、
  //  手札発動の自己コール（X-SS03/0048）が counter timing の事前ドロップ後にドロップの同名別インスタンスを
  //  誤コールし得た。context.card 基準で instanceId/id/name を評価し、残りの汎用述語のみ matchesCardFilter へ
  //  渡す（未使用なら strip は no-op＝完全後方互換。script 経路での使用は PR/0473・PR/0474・X-SS03/0045・0048
  //  の4枚のみで、いずれも「このカード自身」を意図＝厳密化は狭義の正しさ向上のみ）。
  const rawFilter = step.filter || {};
  if (rawFilter.sameInstanceAsSource && card.instanceId !== context.card?.instanceId) {
    return false;
  }
  if (rawFilter.sameIdAsSource && card.id !== context.card?.id) {
    return false;
  }
  if (rawFilter.sameNameAsSource && card.name !== context.card?.name) {
    return false;
  }
  const { sameInstanceAsSource, sameIdAsSource, sameNameAsSource, ...cardFilter } = rawFilter;
  if (!matchesCardFilter(card, cardFilter, { owner })) {
    return false;
  }
  // filter.sameNameAsVar: 先に選んだ別の選択(var)のカードと同じカード名のみ（爆裂魔神丸の術等）。
  if (step.filter?.sameNameAsVar) {
    const refName = scriptSelection({ var: step.filter.sameNameAsVar }, context)[0]?.card?.name;
    if (!refName || card.name !== refName) {
      return false;
    }
  }
  // E3(D-EB02/0052 ライドチェンジ！): filter.differentNameFromVar — 先に選んだ別の選択(var)の
  // カードと「カード名が違う」もののみ（sameNameAsVar の逆）。var 未選択時は制約なし（候補を残す）。
  if (step.filter?.differentNameFromVar) {
    const refName = scriptSelection({ var: step.filter.differentNameFromVar }, context)[0]?.card?.name;
    if (refName && card.name === refName) {
      return false;
    }
  }
  // filter.sizeNotEqualVar: 先に選んだ別の選択(var)のカードとサイズが異なるもののみ（H-BT04/0039）。
  if (step.filter?.sizeNotEqualVar) {
    const refCard = scriptSelection({ var: step.filter.sizeNotEqualVar }, context)[0]?.card;
    if (!refCard || effectiveSize(card) === effectiveSize(refCard)) {
      return false;
    }
  }
  if (step.callable && !isCallableMonster(card)) {
    return false;
  }
  if (step.callable && !checkCardConditions(card.callConditions, owner)) {
    return false;
  }
  if (step.canUseForFlag && !canUseCardForFlag(state.players[owner], card)) {
    return false;
  }
  if (step.canPayCost) {
    const payment = canPayCardCost(state.players[owner], card, step.canPayCost, card, {
      sourceCard: card,
      allowInteractiveSelection: true,
    });
    if (!payment.ok) {
      return false;
    }
  }
  if (step.zone && zone !== step.zone) {
    return false;
  }
  return true;
}

function scriptControllerMatches(controller = "self", owner, contextOwner) {
  if (controller === "any") {
    return true;
  }
  if (controller === "opponent") {
    return owner !== contextOwner;
  }
  return owner === contextOwner;
}

function scriptOwnersForController(controller = "self", contextOwner) {
  if (controller === "any") {
    return [0, 1];
  }
  if (controller === "opponent") {
    return [1 - contextOwner];
  }
  return [contextOwner];
}

function scriptPileForSource(owner, from, context, step = {}) {
  if (from === "soul") {
    // X16(D-BT01/0020): hostVar 指定時は「事前に選択した場カード」のソウルを読む
    //（既定は従来通り発生源カード自身のソウル＝後方互換）。
    if (step.hostVar) {
      const host = scriptSelection({ var: step.hostVar }, context)[0]?.card;
      if (host) {
        return host.soul || [];
      }
      // 事前充足チェック(canSatisfyScriptSteps)では hostVar が未確定のため、
      // その owner の場カード全ソウルの和集合で楽観近似する（実行時は上の host 経路が使われる）。
      return zones.flatMap((zone) => state.players[owner]?.field?.[zone]?.soul || []);
    }
    return context.card?.soul || [];
  }
  return state.players[owner]?.[from] || null;
}

function scriptSourceLabel(from) {
  return {
    hand: "手札",
    drop: "ドロップ",
    deck: "デッキ",
    gauge: "ゲージ",
    soul: "ソウル",
    field: "場",
  }[from] || from;
}

// E-PR9(PR/0311 超勇者 アルスグランデ): revealTopCard で公開した実カード(context.revealedCard)を
// selectCards 互換の var（{card,owner,index,source:"deck"}）へ橋渡しする。以後 callSelectedToEmptyZones
// 等の script call/move op が、デッキ上に残っている当カードを『実カードのまま（識別子・印字コストを保って）』
// 動かせる。callTopDeckAsMonster（裏向きトークン化・コスト無視）や useTopDeckCardIfMatchesElseBottom
// （spell/impact 限定・無償）では表現できなかった「公開したそのカードを【コールコスト】を払ってコール」を実現する。
// takeScriptSelectionCards が source:"deck" を scriptPileForSource(owner,"deck") 経由で findIndex→splice する
// ため index は近似でよいが、現在のデッキ位置を入れておく。既存カードはこの op を持たない＝新規追加のみ。
function revealedCardToVarForScript(step, context) {
  const revealed = context.revealedCard;
  const owner = context.revealedCardOwner ?? context.owner;
  const deck = state.players[owner]?.deck || [];
  const index = revealed ? deck.findIndex((c) => c.instanceId === revealed.instanceId) : -1;
  if (!revealed || index < 0) {
    context.vars[step.var] = [];
    return step.require === false ? true : { ok: false, reason: "no_revealed_card" };
  }
  context.vars[step.var] = [{ card: revealed, owner, index, source: "deck", zone: null }];
  return true;
}

// 発生源カードが、選択カード(var)と同じカード名を『追加のカード名』として得る（そのターン中。RD メタモルエフェクト 0016）。
// card.additionalNames[] に積み、clearTurnModifiers(ターン終了)でクリアされる。matchesCardFilter の name系が参照する。
// このカード以外(excludeSource)の発生源側の場のカードを「全て」ドロップゾーンに置く（強制・非対話）。
// 四角炎王バーンノヴァ 0006「このカード以外の君の場のカード全てをドロップゾーンに置き」用。
function moveAllOwnFieldToDropForScript(step, context) {
  const player = state.players[context.owner];
  const moved = [];
  zones.forEach((zone) => {
    const card = player.field[zone];
    if (!card) {
      return;
    }
    if (step.excludeSource && card.instanceId === context.card?.instanceId) {
      return;
    }
    if (step.filter && !matchesCardFilter(card, step.filter)) {
      return;
    }
    player.field[zone] = null;
    player.drop.push(...(card.soul || []));
    card.soul = [];
    player.drop.push(card);
    // ※「ドロップゾーンに置く」は破壊ではないためライフリンクは発動しない（公式: 破壊≠ドロップ送り）。
    if (zone === "item" && player.arrivalCardId === card.instanceId) {
      player.arrivalCardId = null; // 着任アイテムを流す場合は着任フラグをクリア
    }
    moved.push(card);
  });
  if (moved.length > 0) {
    addLog(`${context.card?.name || "効果"}の効果で${moved.map((c) => c.name).join("、")}をドロップゾーンに置きました。`);
  }
  return true;
}

// 選択済みの複数var(フィールドカード)の指定stat(既定critical=打撃力)を合計し、その分を1回のダメージとして与える。
// ギガハウリング・クラッシャー 0026「モンスター1枚＋アイテム1枚の打撃力合計分ダメージ」用。
function dealDamageBySelectedStatSumForScript(step, context) {
  const stat = step.stat || "critical";
  let sum = 0;
  (step.vars || []).forEach((v) => {
    const card = scriptSelection({ var: v }, context)[0]?.card;
    if (card) {
      sum += visibleFieldStat(card, stat);
    }
  });
  const seat = step.player === "opponent" ? 1 - context.owner : context.owner;
  if (sum > 0) {
    const dealt = applyDamageToPlayer(seat, sum, {
      sourceName: context.card?.name,
      sourceCard: context.card,
      sourceOwner: context.owner, // preventOpponentEffectDamage（相手効果ダメ無効）の判定に必要
      ignorePrevention: Boolean(step.ignorePrevention),
      byEffect: true,
    });
    addLog(`${context.card?.name || "効果"}の効果で${state.players[seat].name}に${dealt}ダメージ！`);
  }
  return true;
}

// そのターン中、指定コントローラ(既定opponent)のカードが攻撃した時、対象を選択済みモンスター(var)へ強制変更する
// ターンスコープの再誘導フラグを張る（0061）。攻撃宣言(src/09)側が生存する限り対象を差し替える。
function setAttackRedirectThisTurnForScript(step, context) {
  const target = scriptSelection(step, context)[0];
  if (!target?.card) {
    return true;
  }
  const seat = step.controller === "self" ? context.owner : 1 - context.owner;
  state.attackRedirectThisTurn ||= [null, null];
  state.attackRedirectThisTurn[seat] = { owner: target.owner, instanceId: target.card.instanceId };
  addLog(`${context.card?.name || "効果"}の効果で、このターン${state.players[seat].name}の攻撃は${target.card.name}へ向かいます。`);
  return true;
}

// 「お互いは〜してよい。したファイターはA、しなかったファイターはB」（H-PP01/0030 ゴッド★フナヤマ等）。
// 各プレイヤーに confirmChoiceAsync で個別に確認し（CPU対戦のseam・権威サーバの往復も通る）、
// 選んだ側の branch をそのプレイヤーを owner とする context で実行する。
async function eachPlayerConfirmBranchForScript(step, context) {
  for (const seat of [context.owner, 1 - context.owner]) {
    const accepted = await confirmChoiceAsync(seat, step.prompt || "使いますか？", {
      yesLabel: step.yesLabel || "はい",
      noLabel: step.noLabel || "いいえ",
      purpose: "use-optional",
    });
    const branch = accepted ? step.then : step.else;
    if (Array.isArray(branch) && branch.length > 0) {
      // 片方の branch が失敗（選択キャンセル等）しても、もう片方のプレイヤーの確認・実行は必ず行う。
      await executeAbilityScript(branch, {
        ...context,
        owner: seat,
        player: state.players[seat],
      });
    }
  }
  return true;
}

// 「選んだカードに書かれている能力全てを、そのターン中得る」（H-SS01 バーンノヴァ等）。
// abilities/continuous はクローンして発生源カードに追加（__turnCopy 印）、keywords は turnKeywords へ。
// 除去は clearTurnModifiers（state.turnAbilityCopyHosts 経由。ホストが場を離れても剥がれる）。
function gainSelectedCardAbilitiesForTurnForScript(step, context) {
  const entries = scriptSelection(step, context);
  const host = context.card;
  if (!host || entries.length === 0) {
    return step.require === false ? true : { ok: false, reason: "no_selected_cards" };
  }
  for (const entry of entries) {
    const source = entry.card;
    if (!source) {
      continue;
    }
    (source.abilities || []).forEach((ability, index) => {
      const cloned = deepClone(ability);
      cloned.id = `${host.instanceId}-turncopy-${source.id}-${index}`;
      cloned.__turnCopy = true;
      host.abilities ||= [];
      host.abilities.push(cloned);
    });
    (source.continuous || []).forEach((effect) => {
      const cloned = deepClone(effect);
      cloned.__turnCopy = true;
      host.continuous ||= [];
      host.continuous.push(cloned);
    });
    (source.keywords || []).forEach((keyword) => {
      host.turnKeywords ||= [];
      host.turnKeywords.push(keyword);
    });
    addLog(`${host.name}はそのターン中、${source.name}に書かれている能力全てを得ました。`);
  }
  return true;
}

function gainNameAsSelectedForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  const name = entry?.card?.name;
  const self = context.card;
  if (name && self) {
    self.additionalNames = [...(self.additionalNames || []), name];
    addLog(`${self.name}はそのターン中「${name}」としても扱われます。`);
  }
  return true;
}

function scriptSelection(step, context) {
  const key = step.var || step.selection || step.cardVar;
  if (key === "$target" && context.target?.card) {
    return [{ ...context.target, source: "field" }];
  }
  const selected = context.vars?.[key];
  if (!selected) {
    return [];
  }
  return Array.isArray(selected) ? selected : [selected];
}

function takeScriptSelectionCards(selection) {
  const movedCards = [];
  for (const entry of [...selection].sort((left, right) => (right.index ?? 0) - (left.index ?? 0))) {
    if (entry.source === "field") {
      const card = detachFieldCardForMove(entry.owner, entry.zone, entry.card);
      if (card) {
        movedCards.unshift({ ...entry, card });
      }
      continue;
    }
    const pile = scriptPileForSource(entry.owner, entry.source, { card: entry.sourceCard });
    if (!pile) {
      continue;
    }
    const currentIndex =
      pile[entry.index]?.instanceId === entry.card.instanceId
        ? entry.index
        : pile.findIndex((card) => card.instanceId === entry.card.instanceId);
    if (currentIndex >= 0) {
      movedCards.unshift({ ...entry, card: pile.splice(currentIndex, 1)[0] });
    }
  }
  return movedCards;
}

function detachFieldCardForMove(owner, zone, expectedCard = null) {
  const player = state.players[owner];
  const card = player?.field?.[zone];
  if (!card || (expectedCard && card.instanceId !== expectedCard.instanceId)) {
    return null;
  }
  player.drop.push(...(card.soul || []));
  card.soul = [];
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, owner);
  // r3 L4(S-UB-C03/0066): script経由の場外移動(selectCards/moveSelected等)でも印字値を復元する。
  restoreFaceDownMonsterPrint(card);
  return card;
}

function moveSelectedForScript(step, context) {
  if (step.to === "deckBottom" && step.order === "choose") {
    return moveSelectedToDeckBottomOrderedForScript(step, context);
  }
  const movedEntries = takeScriptSelectionCards(scriptSelection(step, context));
  if (movedEntries.length === 0) {
    addLog(step.emptyMessage || `${context.card.name}で動かすカードがありません。`);
    return step.require === false ? true : { ok: false, reason: "no_selected_cards" };
  }
  for (const entry of movedEntries) {
    const destinationOwner = scriptMoveDestinationOwner(step, entry, context);
    moveScriptCardToDestination(entry.card, step.to, destinationOwner, context);
    // 「場かデッキからドロップに置かれた時」誘発（movedToDrop）。宛先がドロップ（未指定既定含む）の時のみ。
    // 移動自体は moveScriptCardToDestination 済みのため alreadyPlaced で誘発の queue のみ行う。
    const destKind = step.to || "drop";
    if (destKind === "drop") {
      // E5: entry.source==="deck" のときは deckMilled ブロードキャストも飛ぶ（cause=この効果の起因）。
      putCardsToDropWithTrigger(state.players[destinationOwner], destinationOwner, [entry.card], entry.source, { alreadyPlaced: true, cause: makeEffectCause(context, destinationOwner) });
    } else if (destKind === "soul" && context.card) {
      // 「ソウルに入った時」誘発（enteredSoul）。soul 宛先は発生源カード(context.card)のソウルへ入る。
      putCardsToSoulWithTrigger(context.card, destinationOwner, [entry.card], entry.source, { alreadyPlaced: true });
    } else if (destKind === "itemSoul") {
      const itemHost = state.players[destinationOwner]?.field?.item;
      if (itemHost) {
        putCardsToSoulWithTrigger(itemHost, destinationOwner, [entry.card], entry.source, { alreadyPlaced: true });
      }
    }
  }
  if (step.log === "discard") {
    addLog(`${context.player.name}は${context.card.name}の効果で${movedEntries.map((entry) => entry.card.name).join("、")}を捨てました。`);
  } else if (step.log) {
    addLog(step.log.replace("{cards}", movedEntries.map((entry) => entry.card.name).join("、")));
  }
  return true;
}

async function moveSelectedGroupForScript(step, context) {
  const selected = scriptSelection(step, context);
  const movedEntries = [];
  for (const entry of selected) {
    const group = entry.group || [entry];
    const amount = Math.min(step.amount || group.length, group.length);
    let picked = group.slice(0, amount);
    if (step.chooseWithinGroup && group.length > amount) {
      // 同一グループ(同サイズ等)内で「どのカードを最大 amount 枚動かすか」をプレイヤーに選ばせる。
      const chosen = await chooseCardEntries(group, {
        title: step.title || context.card.name,
        lead: step.chooseLead || `動かすカードを${amount}枚まで選んでください。`,
        min: step.require === false ? 0 : Math.min(1, amount),
        max: amount,
        forceDialog: true,
        promptSeat: context.owner,
      });
      picked = chosen && chosen.length ? chosen : [];
    }
    movedEntries.push(...takeScriptSelectionCards(picked));
  }
  if (movedEntries.length === 0) {
    addLog(step.emptyMessage || `${context.card.name}で動かすカードがありません。`);
    return step.require === false ? true : { ok: false, reason: "no_selected_group_cards" };
  }
  for (const entry of movedEntries) {
    const destinationOwner = scriptMoveDestinationOwner(step, entry, context);
    moveScriptCardToDestination(entry.card, step.to, destinationOwner, context);
    // 「場かデッキからドロップに置かれた時」誘発（movedToDrop）。宛先がドロップ（未指定既定含む）の時のみ。
    // 移動自体は moveScriptCardToDestination 済みのため alreadyPlaced で誘発の queue のみ行う。
    const destKind = step.to || "drop";
    if (destKind === "drop") {
      // E5: entry.source==="deck" のときは deckMilled ブロードキャストも飛ぶ（cause=この効果の起因）。
      putCardsToDropWithTrigger(state.players[destinationOwner], destinationOwner, [entry.card], entry.source, { alreadyPlaced: true, cause: makeEffectCause(context, destinationOwner) });
    } else if (destKind === "soul" && context.card) {
      // 「ソウルに入った時」誘発（enteredSoul）。soul 宛先は発生源カード(context.card)のソウルへ入る。
      putCardsToSoulWithTrigger(context.card, destinationOwner, [entry.card], entry.source, { alreadyPlaced: true });
    } else if (destKind === "itemSoul") {
      const itemHost = state.players[destinationOwner]?.field?.item;
      if (itemHost) {
        putCardsToSoulWithTrigger(itemHost, destinationOwner, [entry.card], entry.source, { alreadyPlaced: true });
      }
    }
  }
  if (step.log) {
    addLog(step.log.replace("{cards}", movedEntries.map((entry) => entry.card.name).join("、")));
  }
  return true;
}

async function ifSelectionForScript(step, context) {
  const selected = scriptSelection(step, context);
  const branch = selected.length > 0 ? step.then : step.else;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

async function ifTargetControllerForScript(step, context) {
  const targetOwner = context.target?.owner;
  const matches =
    step.controller === "any" ||
    (step.controller === "self" && targetOwner === context.owner) ||
    (step.controller === "opponent" && targetOwner === 1 - context.owner);
  const branch = matches ? step.then : step.else;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

async function ifConditionForScript(step, context) {
  const matches = checkCondition(step.condition || {}, context.owner, context);
  const branch = matches ? step.then : step.else;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

// 宣言可能なカード名の一覧（重複排除）。カード名宣言プロンプト(検索付き)の候補に使う。
function distinctDeclarableCardNames() {
  const names = new Set();
  (cardLibrary || []).forEach((card) => {
    if (card?.name) {
      names.add(card.name);
    }
  });
  return [...names].sort((a, b) => a.localeCompare(b, "ja"));
}

// 汎用プリミティブ: 「カード名１つを宣言し、相手(自分)の手札を見る」。
// 宣言名を context.declaredCardName に記録し、condition declaredNameInZone で参照する。
// 検索付き選択(searchable)で全カード名から1つ宣言。ネット権威版でも宣言者席へ往復する。
async function declareCardNameForScript(step, context) {
  const declarerSeat = context.owner;
  let chosenName = null;
  if (globalThis.__BUDDYFIGHT_TEST__ && typeof globalThis.__forcedDeclaredCardName === "string") {
    chosenName = globalThis.__forcedDeclaredCardName; // テスト専用シーム(検索UIを介さず宣言名を固定)
  } else {
    const candidates = distinctDeclarableCardNames().map((name) => ({
      card: { name, type: "name" },
    }));
    const selected = await chooseCardEntries(candidates, {
      title: `${context.card?.name || ""}のカード名宣言`,
      lead: "カード名を1つ宣言してください（検索で絞り込めます）。",
      min: 1,
      max: 1,
      forceDialog: true,
      allowCancel: false,
      searchable: true,
      promptSeat: declarerSeat,
      purpose: "declare", // CPU対戦(src/22): カード名宣言
    });
    chosenName = selected?.[0]?.card?.name ?? null;
  }
  context.declaredCardName = chosenName;
  if (context.vars) {
    context.vars.declaredCardName = chosenName;
  }
  if (chosenName) {
    addLog(`${state.players[declarerSeat]?.name || ""}は「${chosenName}」を宣言しました。`);
  }
  if (step.reveal) {
    await executeAbilityEffect({ op: "revealHand", player: step.reveal }, context);
  }
  return true;
}

async function chooseBranchForScript(step, context) {
  const options = (Array.isArray(step.options) ? step.options : []).filter(
    (option) =>
      (!option.condition || checkCondition(option.condition, context.owner, context)) &&
      canPayScriptBranchCosts([{ op: "payCost", cost: option.canPayCost || [] }], context) &&
      canPayScriptBranchCosts(option.script || [], context),
  );
  if (options.length === 0) {
    if (step.emptyMessage) {
      addLog(step.emptyMessage);
    }
    return true;
  }
  const selected = await chooseCardEntries(
    options.map((option) => ({
      option,
      card: {
        name: option.label || option.key,
        rules: option.description ? [option.description] : [],
        type: "choice",
      },
      note: option.note || "",
    })),
    {
      title: step.title || `${context.card.name}の効果`,
      lead: step.lead || "解決する効果を選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
      // 権威サーバ: 分岐選択は能力の主体(context.owner)へ往復させる（未指定だと inferPromptSeat が state.active に誤配送）。
      promptSeat: context.owner,
      purpose: "branch", // CPU対戦(src/22): 効果分岐の選択
    },
  );
  const branch = selected?.[0]?.option?.script;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

function canPayScriptBranchCosts(script, context) {
  return (script || []).every((step) => {
    if (step.op === "payCost") {
      const costSteps = adjustedCostSteps(
        context.player,
        context.card,
        step.purpose || "activated",
        step.cost || [],
      );
      return canPayStructuredCost(context.player, costSteps, {
        sourceCard: context.card,
        selectedCard: context.card,
        allowInteractiveSelection: true,
      }).ok;
    }
    if (Array.isArray(step.then) && !canPayScriptBranchCosts(step.then, context)) {
      return false;
    }
    if (Array.isArray(step.else) && !canPayScriptBranchCosts(step.else, context)) {
      return false;
    }
    return true;
  });
}

async function payCostForScript(step, context) {
  const costSteps = adjustedCostSteps(
    context.player,
    context.card,
    step.purpose || "activated",
    step.cost || [],
  );
  const payment = await payStructuredCostWithSelection(context.player, costSteps, {
    sourceCard: context.card,
    selectedCard: context.card,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return { ok: false, reason: payment.reason || "script_cost_unpaid" };
  }
  context.costPayment = payment;
  return true;
}

// E2(D-BT03/0063 闘気暴走・0030 牙槍斧 オウガ斬魔): 「ライフを好きなだけ／N まで払う」→
// 払った数値を後続効果（putTopDeckToGauge / modifyStats 等）が amountFrom:{source:"scriptVar", var}
// で参照する汎用op。max: 数値（例 5）or "life"（現ライフ＝「好きなだけ」）。実効上限は「ライフを0以下には
// できない」規則で life-1 に丸める（既存 payLife コストの canPay 判定 src/04「life>amount」＝0063 の
// 「君のライフ以上は払えないぞ！」と同義）。0 払い可（「好きなだけ」「払ってよい」は0を含む・両カードとも任意）。
// 支払額を context.vars[step.var] にスカラーで格納。選択は既存コスト選択と同じ chooseCardEntries 往復
// （promptSeat＝能力主体席・リプレイ決定的）。
async function payLifeChooseForScript(step, context) {
  const owner = context.owner;
  const player = state.players[owner];
  const varName = step.var || "paidLife";
  context.vars = context.vars || {};
  const rawMax = step.max === "life" ? player.life : Math.max(0, Math.floor(Number(step.max) || 0));
  const cap = Math.max(0, Math.min(rawMax, player.life - 1)); // ライフ0にはできない（払える上限＝life-1）
  if (cap <= 0) {
    context.vars[varName] = 0; // 払える額が無い＝0払い（後続の amountFrom は0＝no-op）
    return true;
  }
  const options = [];
  for (let n = 0; n <= cap; n += 1) {
    options.push({ amount: n, card: { name: `${n}`, rules: [], type: "choice" }, note: "" });
  }
  const selected = await chooseCardEntries(options, {
    title: step.title || `${context.card?.name || "効果"}：支払うライフ`,
    lead: step.lead || `払うライフの数値を選んでください（0〜${cap}）。`,
    min: 1,
    max: 1,
    forceDialog: true,
    promptSeat: owner, // 能力主体の席へ（権威サーバ/CPU の誤配送防止）
    purpose: "cost", // CPU対戦(src/22): コスト選択（最小価値方針）
  });
  const paid = Math.max(0, Math.min(cap, selected?.[0]?.amount ?? 0));
  player.life -= paid;
  context.vars[varName] = paid;
  if (paid > 0) {
    addLog(`${player.name}は${context.card?.name || "効果"}でライフを${paid}払いました。`);
  }
  return true;
}

async function moveSelectedToDeckBottomOrderedForScript(step, context) {
  const selected = Array.isArray(step.vars)
    ? step.vars.flatMap((varName) => scriptSelection({ var: varName }, context))
    : scriptSelection(step, context);
  const movedEntries = takeScriptSelectionCards(selected);
  if (movedEntries.length === 0) {
    return step.require === false ? true : { ok: false, reason: "no_selected_cards" };
  }
  const owner =
    step.toOwner === "opponent" ? 1 - context.owner :
    step.toOwner === "self" ? context.owner :
    movedEntries[0]?.owner ?? context.owner;
  const player = state.players[owner];
  let remaining = [...movedEntries];
  const ordered = [];
  while (remaining.length > 0) {
    const picked = await chooseCardEntries(remaining, {
      title: step.title || `${context.card.name}のデッキ下順序`,
      lead: `デッキの下から${ordered.length + 1}番目に置くカードを選んでください。`,
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
    });
    const entry = picked?.[0];
    if (!entry) {
      player.drop.push(...remaining.map((candidate) => candidate.card));
      return { ok: false, reason: "ordered_selection_cancelled" };
    }
    ordered.push(entry.card);
    remaining = remaining.filter((candidate) => candidate.card.instanceId !== entry.card.instanceId);
  }
  player.deck.unshift(...ordered);
  queueDeckBottomPlacedTriggers(owner, ordered); // E-XB18: 選択カードをデッキ下（順序付き）
  if (step.log) {
    addLog(step.log.replace("{cards}", ordered.map((card) => card.name).join("、")));
  }
  return true;
}

// E-XV3(X-UB02/0052 メガドロイド ラージャー): 選択した（ドロップ等の）カードを「デッキの上に好きな順番で置く」。
// moveSelectedToDeckBottomOrdered の鏡（あちらは「下」＝unshift、こちらは「上」＝push）。デッキ向き規約は
// reorderTopOrdered と同じ「top=末尾」＝ordered[0]（＝1番目に置くカード）を最上段にするため逆順で push する。
// 選択の取り出しは moveSelectedToDeckBottomOrdered と共通の takeScriptSelectionCards（場/ドロップ/手札いずれからも可）。
async function moveSelectedToDeckTopOrderedForScript(step, context) {
  const selected = Array.isArray(step.vars)
    ? step.vars.flatMap((varName) => scriptSelection({ var: varName }, context))
    : scriptSelection(step, context);
  const movedEntries = takeScriptSelectionCards(selected);
  if (movedEntries.length === 0) {
    return step.require === false ? true : { ok: false, reason: "no_selected_cards" };
  }
  const owner =
    step.toOwner === "opponent" ? 1 - context.owner :
    step.toOwner === "self" ? context.owner :
    movedEntries[0]?.owner ?? context.owner;
  const player = state.players[owner];
  let remaining = [...movedEntries];
  const ordered = [];
  while (remaining.length > 0) {
    const picked = await chooseCardEntries(remaining, {
      title: step.title || `${context.card.name}のデッキ上順序`,
      lead: `デッキの上から${ordered.length + 1}番目に置くカードを選んでください。`,
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
      purpose: "scry",
    });
    const entry = picked?.[0];
    if (!entry) {
      // キャンセル時は取り出し済みカードを消失させない（元ゾーンには戻せないためデッキ上へ既定順で退避）。
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        player.deck.push(remaining[i].card);
      }
      return { ok: false, reason: "ordered_selection_cancelled" };
    }
    ordered.push(entry.card);
    remaining = remaining.filter((candidate) => candidate.card.instanceId !== entry.card.instanceId);
  }
  // ordered[0] を最上段(末尾)にするため逆順 push（reorderTopOrdered と同規約）。
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    player.deck.push(ordered[i]);
  }
  if (step.log) {
    addLog(step.log.replace("{cards}", ordered.map((card) => card.name).join("、")));
  } else {
    addLog(`${context.card?.name || "効果"}で${ordered.length}枚を${player.name}のデッキの上に置きました。`);
  }
  return true;
}

// G4(D-EB01/0025 スクルド): 「君か相手のデッキの上からN枚を見て、好きな順番で元のデッキの上に置く」。
// moveSelectedToDeckBottomOrdered が「下」方向なのに対し、これは「上」方向（並べ替え）。デッキ上=末尾。
// target: "self" | "opponent" | "choose"（既定 self。"choose" は能力主体がどちらのデッキか確認ダイアログで選ぶ）。
async function reorderTopOrderedForScript(step, context) {
  let deckOwner;
  if (step.target === "opponent") {
    deckOwner = 1 - context.owner;
  } else if (step.target === "choose") {
    const chooseOpponent = await confirmChoiceAsync(
      context.owner,
      `${context.card?.name || "効果"}: どちらのデッキの上を見ますか？`,
      { yesLabel: "相手のデッキ", noLabel: "自分のデッキ", purpose: "scry" },
    );
    deckOwner = chooseOpponent ? 1 - context.owner : context.owner;
  } else {
    deckOwner = context.owner;
  }
  const player = state.players[deckOwner];
  const count = step.count || 3;
  const revealed = [];
  for (let i = 0; i < count && player.deck.length > 0; i += 1) {
    revealed.push(player.deck.pop()); // top = 末尾（drawCards/moveTopDeckToDrop と同規約）
  }
  if (revealed.length === 0) {
    addLog(`${context.card?.name || "効果"}で見るカードがありません。`);
    return true;
  }
  // 上から1番目..N番目に置くカードを順に選ばせる（1番目=最上段）。
  let remaining = revealed.map((card) => ({ card, owner: deckOwner, zone: "deck", source: "deck" }));
  const ordered = [];
  while (remaining.length > 0) {
    const picked = await chooseCardEntries(remaining, {
      title: step.title || `${context.card?.name || "効果"}のデッキ上順序`,
      lead: `デッキの上から${ordered.length + 1}番目に置くカードを選んでください。`,
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
      purpose: "scry",
    });
    const entry = picked?.[0];
    if (!entry) {
      // キャンセル時は全カードを元の順序(revealed[0]=最上段)で戻し、カード消失を防ぐ。
      for (let i = revealed.length - 1; i >= 0; i -= 1) {
        player.deck.push(revealed[i]);
      }
      return true;
    }
    ordered.push(entry.card);
    remaining = remaining.filter((candidate) => candidate.card.instanceId !== entry.card.instanceId);
  }
  // ordered[0] を最上段に置く。デッキ上=末尾のため、末尾が ordered[0] になるよう逆順で push。
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    player.deck.push(ordered[i]);
  }
  addLog(`${context.card?.name || "効果"}で${player.name}のデッキの上${ordered.length}枚を並べ替えました。`);
  return true;
}

function scriptMoveDestinationOwner(step, entry, context) {
  if (step.toOwner === "self") {
    return context.owner;
  }
  if (step.toOwner === "opponent") {
    return 1 - context.owner;
  }
  return entry.owner ?? context.owner;
}

function moveScriptCardToDestination(card, destination, owner, context) {
  const player = state.players[owner];
  if (destination === "hand") {
    player.hand.push(card);
  } else if (destination === "gauge") {
    player.gauge.push(card);
    queueGaugePlacedTriggers(owner, [card]); // 相手のゲージにカードが置かれた時（0020）
  } else if (destination === "deck") {
    player.deck.push(card);
  } else if (destination === "deckBottom") {
    player.deck.unshift(card);
    queueDeckBottomPlacedTriggers(owner, [card]); // E-XB18: script move の deckBottom 宛先
  } else if (destination === "soul") {
    context.card.soul ||= [];
    context.card.soul.push(card);
    queueSoulCardAddedTriggers(context.card, owner, 1, card); // E-XB24
  } else if (destination === "itemSoul") {
    // 君のアイテムのソウルに入れる（アーマナイト・カーリーの“修羅降臨の儀”）
    const item = player.field.item;
    if (item) {
      item.soul ||= [];
      item.soul.push(card);
      queueSoulCardAddedTriggers(item, owner, 1, card); // E-XB24
    } else {
      player.hand.push(card);
    }
  } else {
    player.drop.push(card);
  }
}

async function destroySelectedForScript(step, context) {
  const selected = scriptSelection(step, context);
  let destroyedCount = 0;
  for (const entry of selected) {
    if (entry.source !== "field") {
      continue;
    }
    const targetCard = state.players[entry.owner]?.field?.[entry.zone];
    if (!targetCard || targetCard.instanceId !== entry.card.instanceId) {
      continue;
    }
    const destroyedName = targetCard.name;
    // 効果破壊として発生源(sourceOwner)を伝播（「君のカードで破壊された時」0030・破壊耐性判定と整合）。
    const destroyed = await destroyFieldCard(entry.owner, entry.zone, { cause: makeEffectCause(context, entry.owner) });
    if (destroyed) {
      destroyedCount += 1;
      addLog(`${context.card.name}の効果で${destroyedName}を破壊しました。`);
    }
  }
  // 実際に破壊した枚数を context へ露出（dealDamage の amountFrom:destroyedCount が参照。破壊耐性で免れた分は除外）。
  context.destroyedCounts = context.destroyedCounts || {};
  context.destroyedCounts[step.var] = destroyedCount;
  // 後続 ifCondition(lastDestroySucceeded) の「破壊したら〜」報酬ゲート用に破壊成立フラグを立てる
  // （effect版 destroy の src/15:1089/1097 と同じ定義＝destroyFieldCard が実カードを返した＝破壊成立。
  //  ソウルガード/破壊耐性で場に残った分は destroyedCount に数えない＝false のまま）。
  // これが無いと lastDestroySucceeded が常に false になり「破壊したら」報酬が不発だった（F1 恒久FIX）。
  context.lastDestroyed = destroyedCount > 0;
  if (destroyedCount === 0 && step.require !== false) {
    return { ok: false, reason: "no_destroyed_cards" };
  }
  return true;
}

function grantKeywordSelectedForScript(step, context) {
  const selected = scriptSelection(step, context);
  selected.forEach((entry) => {
    const card = entry.card;
    if (!card) {
      return;
    }
    // duration を counterattack 特別扱いより先に判定（effects版 grantKeyword と挙動一致）。
    if (step.duration === "permanent") {
      card.keywords ||= [];
      if (!card.keywords.includes(step.keyword)) {
        card.keywords.push(step.keyword);
      }
    } else if (step.duration === "turn") {
      card.turnKeywords ||= [];
      card.turnKeywords.push(step.keyword);
    } else if (step.keyword === "counterattack") {
      card.counterattack = true;
    } else {
      card.temporaryKeywords ||= [];
      card.temporaryKeywords.push(step.keyword);
    }
  });
  return true;
}

// E-PR11(PR/0389 「Brave Soul Fight！」): selectCards で選んだ場のカードへ、そのターン中のみ有効な
// triggered 能力を付与する。付与情報は素の DSL オブジェクトとしてカードインスタンス(state 内)に持たせる
// (card.grantedTempAbilities)。クロージャは持たない＝room-store 復元・リプレイ・engine-host の state 直列化
// だけで往復する。走査は runTriggeredAbilities(src/14)が card.abilities と一緒に行い、掃除は
// clearTurnModifiers(src/11・ターン終了/場外)と resetLeftFieldCardState(src/08・離場)が turnKeywords と
// 同じ寿命で行う。effects 側は既存 op(destroy / putTopDeckToGauge 等)をそのまま流用する。
function grantTemporaryTriggeredAbilitySelectedForScript(step, context) {
  const template = step.ability;
  if (!template || !template.event) {
    return true; // 付与内容が無ければ何もしない(後方互換の安全弁)
  }
  scriptSelection(step, context).forEach((entry) => {
    const card = entry.card;
    if (!card) {
      return;
    }
    // 素の DSL を deep clone(発生源との参照共有を切る)し、kind:"triggered" を正規化して常駐させる。
    const granted = JSON.parse(JSON.stringify(template));
    granted.kind = "triggered";
    card.grantedTempAbilities ||= [];
    card.grantedTempAbilities.push(granted);
  });
  return true;
}

// E-PR12(PR/0381): selectCards で選んだカードへ、そのターン中のみ有効な攻撃防御耐性
// (attackResistances 相当エントリ)を付与する。E-PR11 と対の一時付与ストレージ card.grantedTempAttackResistances
// に素の DSL で常駐(クロージャ無し・state 直列化往復可)。applicableAttackResistances(src/09)が印字 attackResistances
// と一緒に走査する。掃除は E-PR11 と共通(clearTurnModifiers / resetLeftFieldCardState)。
// 発動側の「ライフ4以下なら」等のゲートは effect.conditions(lifeLte)で op の外に置く(汎用ゲート)。
function grantTemporaryAttackResistanceSelectedForScript(step, context) {
  const entries = Array.isArray(step.resistances)
    ? step.resistances
    : step.resistance
      ? [step.resistance]
      : [];
  if (entries.length === 0) {
    return true; // 付与内容が無ければ何もしない(後方互換の安全弁)
  }
  scriptSelection(step, context).forEach((entry) => {
    const card = entry.card;
    if (!card) {
      return;
    }
    card.grantedTempAttackResistances ||= [];
    entries.forEach((resistance) => {
      card.grantedTempAttackResistances.push(JSON.parse(JSON.stringify(resistance)));
    });
  });
  return true;
}

// E-PR15(PR/0461 「変幻自在のウェイビー」): 直前に選択/移動したカード群($var・selectCards→moveSelected 等で
// context.vars に残る選択結果）の全ワールド名を集め、発生源カード(context.card)へ「そのターン中のみ」の追加ワールド
// として付与する（card.turnWorlds）。多ワールド持ちの選択カードは cardWorlds() 解決で全ワールドを算入。付与は素の
// 文字列配列で state 常駐（クロージャ無し＝room-store 復元・リプレイ・engine-host の state 直列化だけで往復可）。
// cardWorlds()(src/03) が静的 world/worlds と合流して読むので filter.world / worldNotIn / distinctByWorld 等の
// 全読者が新ワールドを自動で拾う。掃除は clearTurnModifiers(src/11・ターン終了/場外)と resetLeftFieldCardState
// (src/08・離場)が turnKeywords と同寿命で行う。選択が空/ワールド不明なら no-op（後方互換の安全弁）。
// カード名ハードコードは無い汎用op（選択されたカードのワールドを見るだけ）。
function gainTemporaryWorldFromVarForScript(step, context) {
  const source = context.card;
  if (!source) {
    return true;
  }
  const worlds = [];
  scriptSelection(step, context).forEach((entry) => {
    const card = entry.card;
    if (!card) {
      return;
    }
    cardWorlds(card).forEach((world) => {
      if (world && !worlds.includes(world)) {
        worlds.push(world);
      }
    });
  });
  if (worlds.length === 0) {
    return true; // 選択が空 or ワールド不明 → 何もしない
  }
  source.turnWorlds ||= [];
  worlds.forEach((world) => {
    // 静的ワールド／既に付与済みと重複するものは積まない（cardWorlds() 側も合流時に重複除去する）。
    if (!cardWorlds(source).includes(world)) {
      source.turnWorlds.push(world);
    }
  });
  return true;
}

// E-PR17(PR/0478 「振り撒く者」): selectCards で選んだ場のカードへ、そのターン中のみ有効な破壊耐性
// (destroyImmunity 相当エントリ)を付与する。E-PR11/E-PR12 と対の一時付与ストレージ card.grantedTempDestroyImmunities
// に素の DSL で常駐(クロージャ無し・state 直列化往復可)。destroyImmunityBlocks(src/11)が印字 destroyImmunity の
// 新 form と同じ判定で走査する。掃除は E-PR11/12/15 と共通(clearTurnModifiers / resetLeftFieldCardState)。
// immunities 例: [{from:{byEffect:true, byOpponent:true}}]（相手のカードの効果で破壊されない）。空なら no-op。
function grantTemporaryDestroyImmunitySelectedForScript(step, context) {
  const entries = Array.isArray(step.immunities)
    ? step.immunities
    : step.immunity
      ? [step.immunity]
      : [];
  if (entries.length === 0) {
    return true; // 付与内容が無ければ何もしない(後方互換の安全弁)
  }
  scriptSelection(step, context).forEach((entry) => {
    const card = entry.card;
    if (!card) {
      return;
    }
    card.grantedTempDestroyImmunities ||= [];
    entries.forEach((immunity) => {
      card.grantedTempDestroyImmunities.push(JSON.parse(JSON.stringify(immunity)));
    });
  });
  return true;
}

function modifySelectedStatsForScript(step, context) {
  const selected = scriptSelection(step, context);
  const duration = step.duration || "battle";
  selected.forEach((entry) => {
    const card = entry.card;
    if (!card) {
      return;
    }
    if (duration === "nextOwnTurnEnd") {
      // 「次の君のターン終了時まで」（アーマナイト・ナーガ 0035）。expireOwner の「次の」ターン終了で失効。
      // 相手ターン中にセット(0035は【対抗】)なら、直後の自分ターン終了で失効(armed=true)。
      // 自分ターン中にセットなら、そのターン終了はスキップし次の自分ターン終了で失効(armed=false)。
      card.scheduledStatBonus ||= [];
      card.scheduledStatBonus.push({
        power: step.power || 0,
        defense: step.defense || 0,
        critical: step.critical || 0,
        expireOwner: context.owner,
        armed: context.owner !== state.active,
      });
      return;
    }
    const prefix = duration === "turn" ? "turn" : "battle";
    applyStatBonus(card, prefix, "power", step.power || 0);
    applyStatBonus(card, prefix, "defense", step.defense || 0);
    applyStatBonus(card, prefix, "critical", step.critical || 0);
  });
  return true;
}

async function restSelectedForScript(step, context) {
  for (const entry of scriptSelection(step, context)) {
    if (entry.card) {
      // Z4(a)(S-UB-C03/0021,0077): grantRestImmunity/ターン限定保護で保護されたカードは
      // 相手の効果でレストされない（cardProtectedFrom、05-stats.js）。
      const restCause = makeEffectCause(context, entry.owner ?? context.owner);
      if (restCause.byOpponent && cardProtectedFrom(entry.card, "rest", restCause)) {
        addLog(`${entry.card.name}は相手のカードの効果でレストされません。`);
        continue;
      }
      // レビュー修正(D-BT01/0082): 効果によるレストは reason:"effect" を明示（eventReasonIs 条件が拾えるように）。
      await restFieldCard(entry.owner ?? context.owner, entry.zone, entry.card, { source: context.card, restCause, reason: "effect" });
    }
  }
  return true;
}

function putSelectedToGaugeForScript(step, context) {
  const selected = scriptSelection(step, context);
  selected.forEach((entry) => {
    if (entry.source !== "field") {
      return;
    }
    const ownerPlayer = state.players[entry.owner];
    if (ownerPlayer?.field?.[entry.zone]?.instanceId === entry.card?.instanceId) {
      putFieldCardToGauge(ownerPlayer, entry.zone);
    }
  });
  return true;
}

function dropSelectedSoulForScript(step, context) {
  const selected = scriptSelection(step, context);
  selected.forEach((entry) => {
    const owner = entry.owner ?? context.owner;
    const soul = entry.card?.soul || [];
    // E-XB59②(X-UB03/0031 エニグマ・ウィルス②): ソウル内カード自身の自己保護（相手効果のソウルドロップから自身を守る
    //   selfInSoulProtection）を候補から除外する。cause.byOpponent＝このドロップが相手発か（ソウル持ちカードの持ち主 owner と
    //   効果主体 context.owner が別席なら相手発）。自発（自分のコスト等）は byOpponent:false で from:{byOpponent:true} を通さない。
    const cause = { byEffect: true, byOpponent: owner !== context.owner };
    let eligible = soul.filter((soulCard) => !soulCardSelfProtectedFrom(soulCard, "soulDrop", cause));
    // E-XB58(X-UB03/0016 起爆畳): faceDown:true は裏向きソウルのみを候補にする（原文「裏向きのソウル1枚」）。
    if (step.faceDown) {
      eligible = eligible.filter((soulCard) => soulCard?.faceDown);
    }
    const amount = Math.min(step.amount ?? eligible.length, eligible.length);
    const movedCards = [];
    for (let i = 0; i < amount; i += 1) {
      const idx = soul.indexOf(eligible[i]);
      if (idx >= 0) {
        movedCards.push(soul.splice(idx, 1)[0]);
      }
    }
    state.players[owner].drop.push(...movedCards);
    if (movedCards.length > 0 && step.log !== false) {
      addLog(`${entry.card.name}のソウルから${movedCards.map((card) => card.name).join("、")}をドロップゾーンに置きました。`);
    }
    // E1/F2(D-BT02/0097等): ホスト存命のままソウルがドロップへ → soulCardDropped。
    queueSoulCardDroppedTriggers(entry.card, owner, movedCards.length);
  });
  return true;
}

async function discardSelfSoulForScript(step, context) {
  const amount = Math.min(step.amount || 1, context.card?.soul?.length || 0);
  if (amount <= 0) {
    addLog(step.emptyMessage || `${context.card.name}のソウルがありません。`);
    return step.require === false ? true : { ok: false, reason: "missing_soul" };
  }
  const soulEntries = (context.card.soul || []).map((card, index) => ({
    card,
    index,
    owner: context.owner,
    source: "soul",
    note: `${context.card.name}のソウル`,
  }));
  const selected =
    soulEntries.length > amount
      ? await chooseCardEntries(soulEntries, {
          title: `${context.card.name}のソウル選択`,
          lead: `ドロップゾーンに置くソウルを${amount}枚選んでください。`,
          min: amount,
          max: amount,
          forceDialog: true,
          promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
          purpose: "cost",
        })
      : soulEntries.slice(0, amount);
  const movedCards = removePileEntries(context.card.soul || [], selected || []);
  context.player.drop.push(...movedCards);
  if (step.log !== false) {
    addLog(`${context.card.name}のソウルから${movedCards.map((card) => card.name).join("、")}をドロップゾーンに置きました。`);
  }
  // E1/F2: 自ソウルをドロップ（自身は場に残る）→ soulCardDropped。
  queueSoulCardDroppedTriggers(context.card, context.owner, movedCards.length);
  return true;
}

function moveSoulToDropForScript(step, context) {
  const movedCards = context.card?.soul?.splice(0) || [];
  context.player.drop.push(...movedCards);
  context.movedToDrop ||= [];
  context.movedToDrop.push(...movedCards);
  if (movedCards.length > 0 && step.log !== false) {
    addLog(`${context.card.name}のソウルを全てドロップゾーンに置きました。`);
  }
  // E1/F2: ソウル全落とし（自身は場に残る）→ soulCardDropped（下の自壊で離場したら発火時再検証で不発）。
  queueSoulCardDroppedTriggers(context.card, context.owner, movedCards.length);
  maybeDropSetWhenSoulEmpty(context.card, context.owner); // 設置のソウル切れ自壊（H-BT04/0025）
  return true;
}

// 発生源カードのソウルを全て持ち主のゲージに置く（THE チームワーク「残りのソウル全てをゲージに置く」）。
function moveSoulToGaugeForScript(step, context) {
  const movedCards = context.card?.soul?.splice(0) || [];
  context.player.gauge.push(...movedCards);
  queueGaugePlacedTriggers(context.owner, movedCards);
  if (movedCards.length > 0 && step.log !== false) {
    addLog(`${context.card.name}のソウルを全てゲージに置きました。`);
  }
  return true;
}

// 選択(var)した場のカードを【スタンド】する（used=false）。restSelected の対。
function standSelectedForScript(step, context) {
  const stoodEntries = []; // E9: レスト→スタンドへ実際に遷移したカードのみブロードキャスト対象
  for (const entry of scriptSelection(step, context)) {
    if (!entry.card) {
      continue;
    }
    const slot = findFieldCardSlot(entry.card);
    if (slot) {
      const live = state.players[slot.owner].field[slot.zone];
      // Z14(g)(S-UB-C03/0038): そのターン中スタンド不可＋E-XU4(0043): アタックフェイズ中の継続スタンド不可はスキップ。
      if (live && standRestrictedNow(live)) {
        addLog(`${live.name}はスタンドできません。`);
      } else if (live) {
        if (live.used) {
          stoodEntries.push({ owner: slot.owner, zone: slot.zone, card: live, cause: makeEffectCause(context, slot.owner) });
        }
        live.used = false;
        if (step.log !== false) {
          addLog(`${live.name}を【スタンド】しました。`);
        }
      }
    }
  }
  queueStandTriggers(stoodEntries); // E9（複数枚も1チェーンで逐次発火）
  return true;
}

// 選択(var)したカードが filter に一致するかで then/else を分岐する（『変身』しているなら等）。
async function ifSelectionMatchesForScript(step, context) {
  const selected = scriptSelection(step, context);
  const matches = selected.some((entry) => entry.card && matchesCardFilter(entry.card, step.filter || {}));
  const branch = matches ? step.then : step.else;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

// 選択(var)したカード群を、別の選択(soulOfVar)した場のカードのソウルに入れる。
function moveSelectedToSelectedSoulForScript(step, context) {
  // soulOfVar:"$self" は発生源カード自身のソウルへ（「デッキから選んでこのカードのソウルに入れる」H-PP01/0006 等）。
  // $self は場にいる時のみ有効（コストで場を離れた後に見えないソウルへ吸い込む事故を防ぐ）。
  const selfHost = step.soulOfVar === "$self" && findFieldCardSlot(context.card) ? context.card : null;
  const host = step.soulOfVar === "$self" ? selfHost : scriptSelection({ var: step.soulOfVar }, context)[0]?.card;
  if (!host) {
    addLog(step.emptyMessage || `${context.card.name}でソウルの行き先がありません。`);
    return step.require === false ? true : { ok: false, reason: "no_soul_host" };
  }
  const movedEntries = takeScriptSelectionCards(scriptSelection(step, context));
  host.soul ||= []; // 0枚選択時も従来通りソウル配列を初期化しておく（挙動不変）。
  movedEntries.forEach((entry) => {
    putCardsToSoulWithTrigger(host, entry.owner ?? context.owner, [entry.card], entry.source || "field", {
      faceDown: Boolean(step.faceDown), // E-Y1(奇襲): 「裏向きで」ソウルに入れる
    });
  });
  if (movedEntries.length > 0 && step.log !== false) {
    // E-Y1(奇襲): 裏向き挿入は表情報(カード名)を addLog に出さない（相手席/観戦へ log は伏せられず配信される＝
    // シード非漏洩と同じ思想）。枚数とホスト名（場の公開カード）のみ記す。
    addLog(
      step.faceDown
        ? `${movedEntries.length}枚を裏向きで${host.name}のソウルに入れました。`
        : `${movedEntries.map((entry) => entry.card.name).join("、")}を${host.name}のソウルに入れました。`,
    );
  }
  return true;
}

// デッキの上から amount 枚を、選択(var)した場のカードのソウルに（裏向きで）入れる。
function putTopDeckToSelectedSoulForScript(step, context) {
  const host = scriptSelection(step, context)[0]?.card;
  if (!host) {
    return step.require === false ? true : { ok: false, reason: "no_soul_host" };
  }
  const player = state.players[step.controller === "opponent" ? 1 - context.owner : context.owner];
  const amount = step.amount || 1;
  host.soul ||= [];
  const moved = [];
  for (let index = 0; index < amount; index += 1) {
    const card = player.deck.pop();
    if (card) {
      host.soul.push(card);
      moved.push(card);
    }
  }
  if (moved.length > 0) {
    queueSoulCardAddedTriggers(host, state.players.indexOf(player), moved.length, moved[0]); // E-XB24
  }
  if (step.faceDown) {
    markSoulCardsFaceDown(moved, host); // E-Y1(奇襲): 「裏向きで」
  }
  if (moved.length > 0 && step.log !== false) {
    addLog(`デッキの上から${moved.length}枚を${host.name}のソウルに入れました。`);
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
  return true;
}

// FE3(X-BT01/0035 眼の妖 阿欲): デッキ上 count 枚を見て、その中の max 枚までを（裏向きで）選択済みホスト(var)の
// ソウルへ入れ、残りをデッキの下へ置く。「見る/選ぶ」は所有者のみ（promptSeat=owner）で秘匿を担保し、
// faceDown 選択札は markSoulCardsFaceDown で裏向き・ログに名前を出さない。「デッキの下へ好きな順」は
// lookTopSelectToBottomRestToTop(15-ability-effects.js) 同様 unshift 順の近似（順序選択は省略・残差）。
async function lookTopSelectToSelectedSoulRestToBottomForScript(step, context) {
  const host = scriptSelection(step, context)[0]?.card;
  if (!host) {
    return step.require === false ? true : { ok: false, reason: "no_soul_host" };
  }
  const player = state.players[step.controller === "opponent" ? 1 - context.owner : context.owner];
  const owner = state.players.indexOf(player);
  const count = step.count || 1;
  const revealed = [];
  for (let index = 0; index < count && player.deck.length > 0; index += 1) {
    revealed.push(player.deck.pop());
  }
  if (revealed.length > 0) {
    const wantMax = Math.min(step.max || 1, revealed.length);
    const picked = await chooseCardEntries(
      revealed.map((card) => ({ card, owner })),
      {
        title: step.title || context.card?.name || "効果",
        lead: step.lead || `${host.name}のソウルに入れるカードを${wantMax}枚まで選んでください（残りはデッキの下へ）。`,
        min: 0,
        max: wantMax,
        forceDialog: true,
        promptSeat: owner,
        purpose: "search",
      },
    );
    const toSoul = (picked || []).map((entry) => entry.card);
    const soulSet = new Set(toSoul.map((card) => card.instanceId));
    const rest = revealed.filter((card) => !soulSet.has(card.instanceId));
    if (toSoul.length > 0) {
      host.soul ||= [];
      host.soul.push(...toSoul);
      queueSoulCardAddedTriggers(host, owner, toSoul.length, toSoul[0]); // E-XB24
      if (step.faceDown) {
        markSoulCardsFaceDown(toSoul, host); // E-Y1(奇襲): 「裏向きで」（秘匿・名前を伏せる）
      }
      addLog(
        step.faceDown
          ? `${toSoul.length}枚を裏向きで${host.name}のソウルに入れました。`
          : `${toSoul.map((card) => card.name).join("、")}を${host.name}のソウルに入れました。`,
      );
    }
    // 残りをデッキの下へ（top=末尾/pop・bottom=先頭/unshift。「好きな順」は unshift 順で近似）。
    rest.forEach((card) => player.deck.unshift(card));
    queueDeckBottomPlacedTriggers(owner, rest); // E-XB18: scry 残りをデッキ下
    if (rest.length > 0) {
      addLog(`残りの${rest.length}枚をデッキの下に置きました。`);
    }
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
  return true;
}

// E-XV1(X-UB02/0018 ブレイブマシン格納庫 / 0030 制服仕事人 アサシンフリル): 事前選択した「場のカード」(var/hostVar)
// のソウルへ、デッキの上から count 枚を「見て」amount 枚まで入れ、残りを restTo（"gauge"|"drop"）へ置く。
//   ・lookTopSelectToSelectedSoulRestToBottom（残り＝デッキ下 固定・表向き固定）の兄弟。相違点は
//     (1) 残りの行き先が restTo で選べる（0018=ゲージ／0030=ドロップ）
//     (2) faceChoice=true でソウルへ入れる各札を owner が表向き/裏向きで選べる（0030「表向きか裏向きで」）。
//   ・「見る」＝秘匿（owner のみ開示・promptSeat=owner）。T13 精神で state.log に見たカード名は出さない
//     （公開ソウル札＝表向きは既にソウルで両席可視になるので名前ログ可。裏向き＝秘匿はカード名を出さない。
//      残りは行き先に依らず枚数のみログ＝lookTopSelectToSoulRestToDrop と同規約）。
//   ・pop 中の宙吊り最小（既存 lookTop 系の作法）＝revealed をクロージャに保持し、選別後に即ソウル/ゲージ/ドロップへ移す。
async function lookTopSelectToSelectedSoulRestForScript(step, context) {
  const host = scriptSelection({ var: step.hostVar || step.var }, context)[0]?.card;
  if (!host) {
    return step.require === false ? true : { ok: false, reason: "no_soul_host" };
  }
  const player = state.players[step.controller === "opponent" ? 1 - context.owner : context.owner];
  const owner = state.players.indexOf(player);
  const count = step.count || 1;
  const restTo = step.restTo === "gauge" ? "gauge" : "drop"; // 既定 drop（0030）。0018 は "gauge"。
  const revealed = [];
  for (let index = 0; index < count && player.deck.length > 0; index += 1) {
    revealed.push(player.deck.pop());
  }
  if (revealed.length > 0) {
    const wantMax = Math.min(step.amount || 1, revealed.length);
    const picked = await chooseCardEntries(
      revealed.map((card) => ({ card, owner })),
      {
        title: step.title || context.card?.name || "効果",
        lead:
          step.lead ||
          `${host.name}のソウルに入れるカードを${wantMax}枚まで選んでください（残りは${restTo === "gauge" ? "ゲージ" : "ドロップゾーン"}へ）。`,
        // 既定は min:0（「N枚まで」＝任意・0018）。minAmount 指定時のみ強制選択（「N枚を…入れ」＝0030）。
        // 候補（見た枚数）が minAmount 未満なら wantMax でクランプ＝候補0なら上の if(revealed.length>0) で本ブロック自体に入らず空許可。
        min: step.minAmount ? Math.min(step.minAmount, wantMax) : 0,
        max: wantMax,
        forceDialog: true,
        promptSeat: owner, // 「見る」＝能力主体の席のみへ開示（秘匿・誤配送防止）
        purpose: "search",
      },
    );
    const toSoul = (picked || []).map((entry) => entry.card);
    const soulSet = new Set(toSoul.map((card) => card.instanceId));
    const rest = revealed.filter((card) => !soulSet.has(card.instanceId));
    for (const soulCard of toSoul) {
      // faceChoice=true（0030）: 表向き/裏向きを owner に確認。裏向き＝秘匿（markSoulCardsFaceDown＝viewFor が
      //   所有者以外へ伏せる／ソウル→ドロップで公開時に解除）。faceChoice 未指定は表向き固定（0018）。
      let faceDown = false;
      if (step.faceChoice) {
        faceDown = !(await confirmChoiceAsync(
          owner,
          `${context.card?.name || "効果"}: ${host.name}のソウルに表向きで入れますか？（いいえ＝裏向き）`,
          { yesLabel: "表向き", noLabel: "裏向き", purpose: "search" },
        ));
      }
      putCardsToSoulWithTrigger(host, owner, [soulCard], "deck", { faceDown });
      addLog(
        faceDown
          ? `デッキの上から1枚を裏向きで${host.name}のソウルに入れました。`
          : `${soulCard.name}を${host.name}のソウルに入れました。`,
      );
    }
    if (rest.length > 0) {
      if (restTo === "gauge") {
        // ゲージは伏せ札（hidden pile）＝lookTopSelectToGaugeRestToTop と同様に gaugePlaced 誘発は起こさず枚数のみログ。
        rest.forEach((card) => player.gauge.push(card));
        noteGaugePlaced(owner, rest.length); // E-XB12: 伏せ札ゲージも「置かれた」ターン記帳（gaugePlaced 誘発は従来どおり非発火）
        addLog(`残りの${rest.length}枚をゲージに置きました。`);
      } else {
        // ドロップ（公開）へ。movedToDrop/deckMilled 誘発つき（lookTopSelectToSoulRestToDrop と同規約・枚数のみログ）。
        putCardsToDropWithTrigger(player, owner, rest, "deck", { cause: makeEffectCause(context, owner) });
        addLog(`残りの${rest.length}枚をドロップゾーンに置きました。`);
      }
    }
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
  return true;
}

// X4(D-BT01/0045): デッキから filter 一致カードを amount 枚まで選び、選択済みホスト(var)のソウルへ入れ、
// デッキをシャッフルする（「デッキから『剣星機 J・スラスター』1枚までをそのカードのソウルに入れ、シャッフル」）。
async function searchDeckToSelectedSoulForScript(step, context) {
  const host = step.var ? scriptSelection(step, context)[0]?.card : context.hostCard || context.card;
  if (!host) {
    return step.require === false ? true : { ok: false, reason: "no_soul_host" };
  }
  const player = state.players[step.controller === "opponent" ? 1 - context.owner : context.owner];
  const owner = state.players.indexOf(player);
  const candidates = player.deck
    .map((card) => ({ card, owner }))
    .filter((entry) => matchesCardFilter(entry.card, step.filter || {}));
  const wanted = step.amount || 1;
  if (candidates.length > 0) {
    const picked = await chooseCardEntries(candidates, {
      title: `${context.card?.name || "効果"}のデッキサーチ`,
      lead: `${host.name}のソウルに入れるカードを${wanted}枚まで選んでください。`,
      min: step.require === true ? Math.min(wanted, candidates.length) : 0,
      max: wanted,
      forceDialog: true,
      promptSeat: owner,
      purpose: "search",
    });
    host.soul ||= [];
    for (const entry of picked || []) {
      const deckIndex = player.deck.indexOf(entry.card);
      if (deckIndex >= 0) {
        player.deck.splice(deckIndex, 1);
        host.soul.push(entry.card);
        queueSoulCardAddedTriggers(host, state.players.indexOf(player), 1, entry.card); // E-XB24
        if (step.faceDown) {
          markSoulCardsFaceDown([entry.card], host); // E-Y1(奇襲): 「裏向きで」
          // 裏向きは表情報(カード名)を log に出さない（秘匿）。
          addLog(`デッキから1枚を裏向きで${host.name}のソウルに入れました。`);
        } else {
          addLog(`デッキから${entry.card.name}を${host.name}のソウルに入れました。`);
        }
      }
    }
  }
  if (step.shuffle !== false) {
    shuffleInPlace(player.deck);
    addLog(`${player.name}はデッキをシャッフルしました。`);
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
  return true;
}

// 発生源カード自身を取り出す（必殺技/呪文は解決前にドロップへ置かれているため drop から、設置等は場から）。
function takeSelfFromDropOrField(context) {
  const player = context.player;
  const dropIndex = player.drop.findIndex((c) => c.instanceId === context.card.instanceId);
  if (dropIndex >= 0) {
    return player.drop.splice(dropIndex, 1)[0];
  }
  const slot = findFieldCardSlot(context.card);
  if (slot) {
    return detachFieldCardForMove(slot.owner, slot.zone, context.card);
  }
  return null;
}

// このカード自身を持ち主のゲージに置く（暗黒葬「このカードをゲージに置く」等）。
function putSelfToGaugeForScript(step, context) {
  let card = takeSelfFromDropOrField(context);
  if (!card) {
    // R17(E-XB21): メインフェイズ魔法/必殺技の解決中(resolvePendingSpell 07-actions-turn.js)は、カードが
    // action.card に保持されていて drop にも field にも無い。従来はここで静かに不発し、カードがゲージではなく
    // 解決後の自動ドロップ積み(07:1148-1150)でドロップへ落ちていた（出荷済み bf-h-eb01-0056 暗黒葬・
    // X-BT03/0024 ヘブンズ・ギフトが同症状）。保持中の自身をゲージへ移し、cardMoved で二重積み/ドロップ落ちを
    // 抑止する（returnSelfToHand(15:1573-1576)/moveSelfToSelectedSoul(14) と同型のフォールバック）。
    card = context.card;
    if (!card) {
      return true;
    }
  }
  const selfPlayer = context.player || state.players[context.owner];
  selfPlayer.gauge.push(card);
  // 自身移動系は解決後の二重ドロップ積みを防ぐため常に cardMoved を立てる（moveSelfToSelectedSoul と同作法。
  // 【対抗】即時解決経路(card は drop 経由)でも既にゲージへ移した後なので false のままより安全）。
  context.cardMoved = true;
  queueGaugePlacedTriggers(context.owner, [card]);
  if (step.log !== false) {
    addLog(`${card.name}をゲージに置きました。`);
  }
  return true;
}

// このカード自身を、選択(var)した場のモンスターのソウルに入れる。
function moveSelfToSelectedSoulForScript(step, context) {
  const host = scriptSelection(step, context)[0]?.card;
  if (!host) {
    return step.require === false ? true : { ok: false, reason: "no_soul_host" };
  }
  const fromZone = findFieldCardSlot(context.card) ? "field" : "drop";
  let card = takeSelfFromDropOrField(context);
  if (!card) {
    // レビュー修正(D-BT01/0034): メインフェイズ魔法の解決中はカードが action.card に保持されており
    // ドロップにも場にも無い。保持中のカード自身をソウルへ移し、cardMoved で解決後のドロップ積みを抑止する
    // （黙って不発にしない。moveSelfToBuddyZoneFaceDown と同型）。
    card = context.card;
    if (!card) {
      return true;
    }
    context.cardMoved = true;
  }
  if (card.instanceId === context.card?.instanceId) {
    context.cardMoved = true;
  }
  putCardsToSoulWithTrigger(host, context.owner, [card], fromZone, { faceDown: Boolean(step.faceDown) });
  if (step.log !== false) {
    // E-Y1(奇襲): 裏向き挿入は名前を伏せる（このカード自身の移動なので通常は表向きだが、faceDown 指定に追従）。
    addLog(
      step.faceDown
        ? `1枚を裏向きで${host.name}のソウルに入れました。`
        : `${card.name}を${host.name}のソウルに入れました。`,
    );
  }
  return true;
}

async function payCardCostForScriptSelection(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}のコストを支払うカードを選んでください。`);
    return { ok: false, reason: "missing_cost_card" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const payment = await payCardCostWithSelection(player, entry.card, step.purpose || "call", entry.card, {
    sourceCard: entry.card,
    callFromZone: entry.source, // E-XU3: コール元ゾーン（drop/soul/deck 等）を軽減判定へ橋渡し
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return { ok: false, reason: payment.reason };
  }
  return true;
}

// 共通: 選択したカード(ドロップ等)を、その種別に応じて「正しく使う」。
//   アイテム → 装備(equipCost を払い equipCardDirect: 装備変更/着任/装備時誘発も通る)
//   『設置』を持つ魔法/必殺技 → 設置ゾーンへ配置(castCost を払い placeSetSpellDirect)
//   それ以外の魔法/必殺技 → その能力を即時解決(useSelectedCardAbility にフォールバック)
// step.payCost:false でコスト支払いを省略可。例: ヴォータンシャドウ(ドロップから装備/設置)。
// 選んだカードを「アイテムとして装備」する（搭乗/ライドアウト）。モンスターでも装備可。
// 別カードがデッキ/手札から特定モンスターを装備させる『搭乗』(カードバーン→アルティメット・カードバーン等)に使う。
async function equipSelectedAsItemForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    return step.require === false ? true : { ok: false, reason: "missing_equip_card" };
  }
  const owner = entry.owner ?? context.owner;
  const player = state.players[owner];
  const card = entry.card;
  // payCost:true の『変身』(EB01/0060 エマージェンシー・トランス！): 選んだカードの『変身』能力のコストを払ってから装備する。
  // step.payCost 未指定(既定)は搭乗/ライドアウト(BT01/0037 カードバーン等)としてコスト無支払いで従来通り。
  if (step.payCost) {
    const henshinAbility =
      (card.abilities || []).find(
        (a) => a.kind === "activated" && a.fromHandOnly && (a.effects || []).some((e) => e.op === "equipSelf"),
      ) ||
      (card.abilities || []).find(
        (a) => a.kind === "activated" && (a.effects || []).some((e) => e.op === "equipSelf"),
      );
    if (henshinAbility?.cost?.length) {
      const payment = await payStructuredCostWithSelection(player, henshinAbility.cost, {
        sourceCard: card,
        selectedCard: card, // 装備するカード自身をコスト（手札捨て等）に使わせない
      });
      if (!payment.ok) {
        addLog(payment.reason);
        return { ok: false, reason: payment.reason };
      }
    }
  }
  takeScriptSelectionCards([entry]); // ソース(デッキ/手札/場)から取り除く
  // E-XB53: step.allowExtra は主枠を奪わず追加枠へ並存装備（0062 の《英雄》2枚同時装備）。既定は従来どおり主枠装備。
  await equipCardDirect(player, card, { byEffect: true, allowExtra: Boolean(step.allowExtra) }); // currentType="item" 化して装備（装備変更/装備時誘発も通る）
  return true;
}

async function useSelectedCardForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}で使うカードを選んでください。`);
    return { ok: false, reason: "missing_use_card" };
  }
  const owner = entry.owner ?? context.owner;
  const player = state.players[owner];
  const card = entry.card;
  const type = effectiveCardType(card);
  const payCost = step.payCost !== false;
  if (type === "item") {
    if (card.equipConditions && !checkCardConditions(card.equipConditions, owner, { card })) {
      addLog(`${card.name}の装備条件を満たしていません。`);
      return { ok: false, reason: "equip_conditions" };
    }
    if (payCost) {
      const payment = await payCardCostWithSelection(player, card, "equip", card);
      if (!payment.ok) {
        addLog(payment.reason);
        return { ok: false, reason: "cannot_pay_equip" };
      }
    }
    const takenItem = takeScriptSelectionCards([entry]);
    // 非同期誘発レース: 上の await payCardCostWithSelection 中に、対象カードが別経路で元ゾーンを
    // 離れることがある（例: fuzzer seed340「煉獄騎士団 グラッジアロー」の破壊時装備が、AIの通常装備
    // 宣言=beginPendingAction と同フレームで走り、先に手札から抜かれる）。stale 参照のまま
    // equipCardDirect すると field.item に既存の同一カードがあると見なされて dropFieldCardByRule で
    // ドロップへ落とし、再度 field.item へ置くため二重存在（instanceId 重複・保存則破れ）になる。
    // 取り出せなかった＝既に別経路が確保済みなので装備を中止する（equipItem/callMonster の !card 同型ガード）。
    if (takenItem.length === 0) {
      addLog(`${card.name}が見つからないため、装備を中止しました。`);
      return { ok: false, reason: "use_card_gone" };
    }
    await equipCardDirect(player, takenItem[0].card, { byEffect: true });
    return true;
  }
  if ((type === "spell" || type === "impact") && hasKeyword(card, "set")) {
    const zone = setZones.find((candidate) => !player.field[candidate]);
    if (!zone) {
      addLog("配置魔法ゾーンが空いていません。");
      return { ok: false, reason: "no_set_zone" };
    }
    if (card.uniqueSet && setZones.some((candidate) => player.field[candidate]?.name === card.name)) { // レビュー修正(D-BT01/0066): 同名制限
      addLog(`${card.name}はすでに配置されています。`);
      return { ok: false, reason: "already_set" };
    }
    if ((player.setLockedIdsThisTurn || []).includes(card.id)) {
      addLog(`${card.name}はそのターン中は設置できません。`);
      return { ok: false, reason: "set_locked_this_turn" };
    }
    if (payCost) {
      const payment = await payCardCostWithSelection(player, card, "cast", card);
      if (!payment.ok) {
        addLog(payment.reason);
        return { ok: false, reason: "cannot_pay_cast" };
      }
    }
    const takenSet = takeScriptSelectionCards([entry]);
    // 同上の非同期誘発レースガード（設置版）。cost 支払いの await 中に対象が元ゾーンを離れていたら
    // stale 参照での二重配置を避けて中止する。
    if (takenSet.length === 0) {
      addLog(`${card.name}が見つからないため、配置を中止しました。`);
      return { ok: false, reason: "use_card_gone" };
    }
    await placeSetSpellDirect(player, takenSet[0].card, zone);
    return true;
  }
  // 通常の魔法/必殺技は能力を即時解決（既存挙動）
  return useSelectedCardAbilityForScript(step, context);
}

async function useSelectedCardAbilityForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}で使うカードを選んでください。`);
    return { ok: false, reason: "missing_selected_ability_card" };
  }
  const usedAbility = (entry.card.abilities || []).find((ability) => {
    if (!canUseAbilityFromScriptSelection(ability, entry)) {
      return false;
    }
    const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
    return abilityTimingIncludes(ability, timing) && checkAbilityConditions(ability, context.owner, {
      ...context,
      card: entry.card,
      // ソウルの秘剣/忍法を使わせているホスト（絶命陣/忍び巻物）を渡す。
      // hostMatches 条件（「秘剣 絶命陣」のソウルにあるなら等）がホストを判定できるようにする。
      hostCard: context.card,
      ability,
    });
  });
  if (!usedAbility) {
    addLog(`${entry.card.name}は現在のタイミングで使える能力がありません。`);
    return { ok: false, reason: "selected_card_ability_unusable" };
  }
  const target = usedAbility.target ? await chooseAbilityTarget(entry.card, usedAbility, context.owner) : null;
  if (usedAbility.target && !target) {
    return { ok: false, reason: "selected_card_ability_missing_target" };
  }
  const costSteps = adjustedCostSteps(
    context.player,
    entry.card,
    abilityCostPurpose(usedAbility),
    abilityCostSteps(entry.card, usedAbility),
  );
  const payment = await payStructuredCostWithSelection(context.player, costSteps, {
    sourceCard: entry.card,
    selectedCard: entry.card,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return { ok: false, reason: payment.reason };
  }
  const moved = takeScriptSelectionCards([entry]);
  const usedCard = moved[0]?.card || entry.card;
  const bodyContext = {
    ...context,
    card: usedCard,
    hostCard: context.card,
    ability: usedAbility,
    target,
    cardMoved: false,
  };
  await executeAbilityBody(bodyContext);
  // moveSelfToTargetSoul/equipSelf 等で自身が別ゾーンへ移った札はドロップに戻さない(二重存在の防止。上の top-deck 版と同型)。
  if (!bodyContext.cardMoved) {
    context.player.drop.push(usedCard);
  }
  addLog(`${context.card.name}の効果で${usedCard.name}を使いました。`);
  return true;
}

function canUseAbilityFromScriptSelection(ability, entry = {}) {
  if (!ability) {
    return false;
  }
  if (["spell", "impact"].includes(ability.kind)) {
    return !ability.fromFieldOnly;
  }
  if (ability.kind !== "activated") {
    return false;
  }
  if (entry.source === "hand") {
    return Boolean(ability.fromHandOnly);
  }
  if (entry.source === "soul") {
    return Boolean(ability.fromSoulOnly);
  }
  return false;
}

async function useTopDeckCardIfMatchesElseBottomForScript(step, context) {
  const owner = scriptOwnersForController(step.controller || "self", context.owner)[0];
  const player = state.players[owner];
  const topCard = player.deck.pop();
  if (!topCard) {
    declareDeckLoss(player);
    return step.require === false ? true : { ok: false, reason: "deck_empty" };
  }
  if (!matchesCardFilter(topCard, step.filter || {})) {
    player.deck.unshift(topCard);
    queueDeckBottomPlacedTriggers(owner, [topCard]); // E-XB18: トップ確認→デッキ下戻し
    addLog(`${context.card.name}で確認した${topCard.name}をデッキの下に置きました。`);
    return true;
  }
  const ability = (topCard.abilities || []).find((candidate) =>
    ["spell", "impact"].includes(candidate.kind) &&
      !candidate.fromFieldOnly &&
      !candidate.fromSoulOnly &&
      abilityTimingIncludes(candidate, state.pendingAttack || state.pendingAction ? "counter" : state.phase) &&
      checkAbilityConditions(candidate, owner, {
        ...context,
        card: topCard,
        ability: candidate,
      }),
  );
  if (!ability) {
    player.deck.unshift(topCard);
    queueDeckBottomPlacedTriggers(owner, [topCard]); // E-XB18: トップ確認→デッキ下戻し
    addLog(`${context.card.name}で確認した${topCard.name}は現在使えないためデッキの下に置きました。`);
    return true;
  }
  if (step.optional) {
    const useIt = await confirmChoiceAsync(owner, `${topCard.name}を使いますか？`, { yesLabel: "使う", noLabel: "使わない", purpose: "use-optional" });
    if (!useIt) {
      player.deck.unshift(topCard);
      queueDeckBottomPlacedTriggers(owner, [topCard]); // E-XB18: トップ確認→デッキ下戻し
      addLog(`${context.card.name}で公開した${topCard.name}を使わずデッキの下に置きました。`);
      return true;
    }
  }
  const target = ability.target ? await chooseAbilityTarget(topCard, ability, owner) : null;
  if (ability.target && !target) {
    player.deck.unshift(topCard);
    queueDeckBottomPlacedTriggers(owner, [topCard]); // E-XB18: トップ確認→デッキ下戻し
    return { ok: false, reason: "top_deck_ability_missing_target" };
  }
  const topContext = {
    ...context,
    card: topCard,
    ability,
    player,
    owner,
    target,
    cardMoved: false,
  };
  await executeAbilityBody(topContext);
  if (!topContext.cardMoved) {
    player.drop.push(topCard);
  }
  markAbilityLimit(owner, topCard, ability);
  addLog(`${context.card.name}の効果で${topCard.name}をコストを払わず使いました。`);
  return true;
}

async function selectZoneForScript(step, context) {
  const cardEntry = scriptSelection({ var: step.cardVar }, context)[0];
  const card = cardEntry?.card || context.card;
  const zoneOwner = step.controller === "opponent" ? 1 - context.owner : context.owner;
  const zonesToOffer = (step.zones || fieldZones).filter(
    (zone) => !step.emptyOnly || !state.players[zoneOwner].field[zone],
  );
  const selected = await chooseCardEntries(
    zonesToOffer.map((zone) => ({
      card,
      zone,
      owner: zoneOwner,
      note: step.note || `${zoneLabel(zone)}にコール`,
    })),
    {
      title: step.title || `${card.name}のコール先`,
      lead: step.lead || "コールするエリアを選んでください。",
      min: 1,
      max: 1,
      forceDialog: step.forceDialog !== false,
      // 権威サーバ: コール先の選択はコール主体(context.owner)へ往復させる（未指定だと state.active に誤配送）。
      promptSeat: context.owner,
    },
  );
  const choice = selected?.[0];
  if (!choice) {
    addLog(step.cancelMessage || `${context.card.name}のエリアを選んでください。`);
    return { ok: false, reason: "zone_cancelled" };
  }
  context.vars[step.var] = choice.zone;
  return true;
}

// preventCallFromZone 継続（ゲート・オブ・ドラゴン 0033「君と相手はドロップからサイズ1以下のモンスターをコールできない」）。
// 場札(設置含む)の継続に op:preventCallFromZone があり、fromZone(既定drop)一致・filter一致なら true。
// E5(D-BT03/0072 竜装機デブリスィーパー): 場札の continuous に加えて、ホストのソウル内カードの
// soulContinuous も畳む（星合体「このカードがソウルにあるなら、相手はドロップからコールできない」。
// ソウルから出れば host.soul から外れて自然に解ける）。走査は soulContinuousGrantsOp と同型で、
// 能力無効化・filter・conditions は continuousEffectAppliesFromSoul（filter は「コールされるカード」
// に適用）。controller は "opponent"=ホスト持ち主の相手のコールのみ封じる／"self"=自分のみ／
// 未指定=両者（場側 consumer の既定と同じ）。hostOnly は本 op では非該当（場の対象カードが無い）。
// E-XB3(X-BT02/0068 死地への誘い「相手はドロップゾーンからモンスターをコールできない」): 場 continuous
// 経路も controller を尊重する。従来 fieldRestricted 分岐は effect.controller を一切見ず両者を無条件
// 制限していた（controller 対応は soulContinuous 経路だけ）。ソウル経路と同一解釈で、"opponent"=発生源の
// 相手のコールのみ／"self"=発生源自身のコールのみ／未指定=両者（既存 bf-h-eb03-0033 は controller 無し＝
// 両者制限のまま不変＝後方互換）。sourceOwner は発生源カードの所有者席。
function isCallFromZoneRestricted(owner, card, fromZone) {
  const fieldRestricted = state.players.some((player, sourceOwner) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return (activeContinuousEffects(source) || []).some((effect) => {
        if (effect.op !== "preventCallFromZone") {
          return false;
        }
        const restrictedZone = effect.fromZone || "drop";
        if (restrictedZone !== fromZone) {
          return false;
        }
        if (effect.controller === "opponent" && owner === sourceOwner) {
          return false;
        }
        if (effect.controller === "self" && owner !== sourceOwner) {
          return false;
        }
        return matchesCardFilter(card, effect.filter || {});
      });
    }),
  );
  if (fieldRestricted) {
    return true;
  }
  return state.players.some((player, hostOwner) =>
    zones.some((zone) => {
      const host = player.field[zone];
      return soulContinuousEffects(host, hostOwner).some(({ effect, sourceCard }) => {
        if (effect.op !== "preventCallFromZone") {
          return false;
        }
        if ((effect.fromZone || "drop") !== fromZone) {
          return false;
        }
        // hostFilter: 「《ネオドラゴン》のソウルにあるなら」等、乗っているホスト側の限定（0072）。
        if (effect.hostFilter && !matchesCardFilter(host, effect.hostFilter)) {
          return false;
        }
        if (effect.controller === "opponent" && owner === hostOwner) {
          return false;
        }
        if (effect.controller === "self" && owner !== hostOwner) {
          return false;
        }
        return continuousEffectAppliesFromSoul(effect, card, sourceCard, hostOwner);
      });
    }),
  );
}

async function callSelectedForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}でコールするカードを選んでください。`);
    return { ok: false, reason: "missing_call_card" };
  }
  if ((entry.source || step.from) === "drop" && isCallFromZoneRestricted(entry.owner ?? context.owner, entry.card, "drop")) {
    addLog(`効果により、ドロップゾーンからそのカードをコールできません。`);
    return { ok: false, reason: "call_from_zone_restricted" };
  }
  // 必殺モンスターの共通ゲート: 効果によるコールも「1ターンに1枚・自分のファイナルフェイズのみ」に服する。
  if (!impactMonsterCallAllowed(entry.owner ?? context.owner, entry.card, { specialCall: Boolean(step.specialCall) })) {
    addLog(`${entry.card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
    return { ok: false, reason: "impact_monster_call_restricted" };
  }
  if (turnCallRestrictionBlocks(entry.owner ?? context.owner, entry.card)) {
    addLog(`${entry.card.name}はこのターン、コール制限によりコールできません。`);
    return { ok: false, reason: "turn_call_restricted" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const zone = context.vars[step.zoneVar] || step.zone;
  if (!fieldZones.includes(zone)) {
    addLog(`${context.card.name}のコール先を選んでください。`);
    return { ok: false, reason: "missing_call_zone" };
  }
  // E-XU5(X-UB01/0068 仲間を集めろ！): opt-in の対戦ジャンケンゲート。「勝ったら〜コールする」を、選んだ
  // カードを動かす前（コスト未払い・状態未変更）に判定し、勝ち以外（負け/引き分け/キャンセル）は {ok:false} で
  // script を中断する＝カードは元ゾーン（ドロップ等）に残る。乱数/往復は既存 resolveRockPaperScissors の
  // 作法どおり（promptSeat=各席・リプレイ/room 復元決定性・シード非漏洩）。既存 callSelected 使用カードは
  // rockPaperScissors 非保持＝挙動完全不変（オプトイン。effect.rockPaperScissors ゲートは src/15 の単純 effect
  // にのみ効き、専用ディスパッチの本 op には届かなかった＝B7 実測の silent no-op を封じる正規経路）。
  if (step.rockPaperScissors && (await resolveRockPaperScissors(context)) !== "win") {
    addLog(`${context.card.name}のジャンケンに勝てなかったため、${entry.card.name}はコールされませんでした。`);
    return { ok: false, reason: "rps_not_won" };
  }
  // E-XU5: 勝った時のみ【コールコスト】等を支払う（step.payCost:"call"）。支払えなければ中断（カードは元ゾーンに
  // 残る）。callSelectedToEmptyZones/stackCallSelected の step.payCost と同形（callSelected は従来 payCost 非対応＝
  // 既存使用0件・オプトイン。原文の「勝ったら【コールコスト】を払ってコール」の順＝RPS 勝利後に課金）。
  if (step.payCost) {
    const payment = await payCardCostWithSelection(player, entry.card, step.payCost, entry.card, {
      sourceCard: entry.card,
      callFromZone: entry.source, // E-XU3: コール元ゾーンを軽減判定へ橋渡し
    });
    if (!payment.ok) {
      addLog(payment.reason);
      return { ok: false, reason: "call_cost_unpaid" };
    }
  }
  const moved = takeScriptSelectionCards([entry]);
  const calledCard = moved[0]?.card;
  if (!calledCard) {
    addLog(`${context.card.name}で選んだカードが移動できません。`);
    return { ok: false, reason: "call_card_missing" };
  }
  if (player.field[zone]) {
    dropFieldCardByRule(player, zone);
  }
  player.field[zone] = calledCard;
  recordImpactMonsterCall(entry.owner ?? context.owner, calledCard);
  applyScriptGrantedKeywords(calledCard, step.grantKeywords || []);
  // 再コール時は前回付与のサイズ上書き(conditionalSize)を必ずリセットしてから、必要な時だけ新たに付与する。
  // （大首領アンノウン0029でコール→破壊→ドロップから別効果で再コールした際に、古いサイズ0を引きずらないため。
  //  破壊時にはクリアしない＝破壊された瞬間のサイズを対抗札等が正しく参照でき、Q827/Q824 も不変。）
  // enforceSizeLimit より前に付与しないと、サイズ0化前の実サイズでサイズ超過と誤判定され発生源が落ちる。
  calledCard.conditionalSize = step.grantConditionalSize
    ? {
        size: step.grantConditionalSize.size ?? 0,
        granterInstanceId: context.card?.instanceId,
        // unconditional: 「場から離れるまでサイズN」型（付与元の在場に依存しない。H-PP01/0013）
        unconditional: Boolean(step.grantConditionalSize.unconditional),
      }
    : null;
  // G5(D-EB01/0023): コールしたカードへ「場を離れるまでファイナルフェイズ中にも攻撃できる」を付与。
  if (step.grantFinalPhaseAttack) {
    calledCard.grantedFinalPhaseAttack = true;
  }
  enforceSizeLimit(player, zone);
  if (step.redirectPendingAttack && state.pendingAttack) {
    state.pendingAttack.targetOwner = entry.owner ?? context.owner;
    state.pendingAttack.targetZone = zone;
    state.pendingAttack.targetType = "monster";
  }
  addLog(`${context.card.name}で${calledCard.name}を${zoneLabel(zone)}にコールしました。`);
  if (step.redirectPendingAttack && state.pendingAttack) {
    addLog(`${context.card.name}の効果で攻撃対象を変更しました。`);
  }
  calledCard.enteredFromZone = entry.source || step.from || null; // 発生元ゾーン記録（enteredFromZoneIn 用。飛雲丸 0056）
  if (step.resolveOnEnter) {
    await resolveOnEnter(calledCard, player, null, { byEffect: true, enterCauseCard: context.card });
  }
  return true;
}

// E-XV4(X-UB02/0059 エフゴ・アタック): 発生源(君)の効果解決中に、相手が「手札のモンスター１枚を【コールコスト】を
// 払ってコールしてよい」。相手席への往復プロンプト（辞退可・相手がコストを負担）で任意コールを開く。
//   ・promptSeat は一貫して相手席(1 - context.owner)＝相手の手札候補・コール先が発生源側へ漏れない（秘匿）。
//   ・成立時に context.opponentCalledFromHand=true を立てる（後続 ifCondition{op:"opponentCalledFromHand"} が
//     「コールしたら、君はゲージ１を払ってよい。払ったら、このカードを手札に戻す」を chooseBranch+payCost+
//     returnSelfToHand（既存 op・bf-h-pp01-0016 デストラップと同型）で分岐するためのフラグ。lastDestroyed と同作法）。
//   ・辞退／候補なし／コスト不能／コール先なし はいずれも「呼ばれなかった」＝フラグは false のまま no-op。
//   ・乱数不使用＝T13 非漏洩。往復は chooseCardEntries/confirmChoiceAsync/selectZone の既存 seam を通る＝
//     リプレイ記録再生・room 復元で決定的（callSelectedForScript と同じ移動/課金/resolveOnEnter 経路）。
async function opponentMayCallFromHandForScript(step, context) {
  context.opponentCalledFromHand = context.opponentCalledFromHand || false;
  const oppOwner = 1 - context.owner;
  const opp = state.players[oppOwner];
  // 手札の候補（filter・コール可能＝コールコストを支払えるカードに限る）。必殺モンスターの通常コール不可ゲート等も除外。
  const candidateCards = (opp.hand || []).filter((card) => {
    if (!matchesCardFilter(card, step.filter || {})) {
      return false;
    }
    if (!impactMonsterCallAllowed(oppOwner, card, { specialCall: Boolean(step.specialCall) })) {
      return false; // 必殺モンスターは「1ターン1枚・自ファイナルのみ」＝相手ターンのこの窓では不可
    }
    if (turnCallRestrictionBlocks(oppOwner, card)) {
      return false;
    }
    // 空きゾーンが1つも無ければ（全枠埋まり）コールできない。
    if (!fieldZones.some((zone) => !opp.field[zone])) {
      return false;
    }
    // コールコストを相手が実際に支払えるか（払えないカードは候補から除外＝辞退と同じ）。
    if (step.payCost) {
      const check = canPayCardCost(opp, card, step.payCost, card, { callFromZone: "hand" });
      if (!check.ok) {
        return false;
      }
    }
    return true;
  });
  if (candidateCards.length === 0) {
    addLog(`${state.players[context.owner].name}の効果: ${opp.name}はコールできるモンスターがいません。`);
    return true; // フラグは false のまま
  }
  // (1) 相手に「コールするか」を確認（辞退可）。promptSeat=相手席。
  const wantsCall = await confirmChoiceAsync(
    oppOwner,
    `${context.card?.name || "効果"}: 手札のモンスター1枚を【コールコスト】を払ってコールしますか？`,
    { yesLabel: "コールする", noLabel: "コールしない", purpose: "call-optional" },
  );
  if (!wantsCall) {
    addLog(`${opp.name}はコールしませんでした。`);
    return true; // 辞退＝フラグ false
  }
  // (2) 相手がコールするカードを選ぶ。
  const pickedCard = await chooseCardEntries(
    candidateCards.map((card) => ({ card, owner: oppOwner, source: "hand", zone: "hand" })),
    {
      title: `${context.card?.name || "効果"}: コールするモンスター`,
      lead: "手札からコールするモンスターを選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: oppOwner,
      purpose: "call",
    },
  );
  const chosen = pickedCard?.[0]?.card;
  if (!chosen) {
    addLog(`${opp.name}はコールしませんでした。`);
    return true;
  }
  // (3) コール先ゾーンを相手が選ぶ（空き枠のみ）。
  const emptyZones = fieldZones.filter((zone) => !opp.field[zone]);
  const zoneSel = await chooseCardEntries(
    emptyZones.map((zone) => ({ card: chosen, zone, owner: oppOwner, note: `${zoneLabel(zone)}にコール` })),
    {
      title: `${chosen.name}のコール先`,
      lead: "コールするエリアを選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: oppOwner,
      purpose: "call",
    },
  );
  const zone = zoneSel?.[0]?.zone;
  if (!zone || !fieldZones.includes(zone)) {
    addLog(`${opp.name}はコールしませんでした。`);
    return true;
  }
  // (4) 相手が【コールコスト】を支払う（払えなければ中断＝コールされず・フラグ false）。
  if (step.payCost) {
    const payment = await payCardCostWithSelection(opp, chosen, step.payCost, chosen, {
      sourceCard: chosen,
      callFromZone: "hand",
    });
    if (!payment.ok) {
      addLog(payment.reason || `${opp.name}はコールコストを支払えませんでした。`);
      return true;
    }
  }
  // (5) 手札からカードを取り出して場へ置く（callSelectedForScript と同じ移動/上書き/サイズ/enter 経路）。
  const handIndex = opp.hand.findIndex((card) => card.instanceId === chosen.instanceId);
  if (handIndex < 0) {
    return true; // 念のため（コスト支払いで手札が動いた等）
  }
  const [calledCard] = opp.hand.splice(handIndex, 1);
  if (opp.field[zone]) {
    dropFieldCardByRule(opp, zone);
  }
  opp.field[zone] = calledCard;
  recordImpactMonsterCall(oppOwner, calledCard);
  calledCard.enteredFromZone = "hand";
  enforceSizeLimit(opp, zone);
  addLog(`${opp.name}は${calledCard.name}を${zoneLabel(zone)}にコールしました。`);
  // 効果コール＝登場時能力を解決（byEffect）。発生源(君のスペル)は cause ではない＝enterCauseCard 未指定。
  await resolveOnEnter(calledCard, opp, null, { byEffect: true });
  context.opponentCalledFromHand = true;
  return true;
}

// 「【対抗】手札のこのカードをコールする」等、発生源カード自身を場へコールする。
// useHandAbilityAction が起動コスト解決時に使用カードをドロップへ送るため、ドロップ→手札の順で発生源を回収する。
async function callSelfFromHandForScript(step, context) {
  const player = state.players[context.owner];
  const card = context.card;
  if (!card) {
    return { ok: false, reason: "self_missing" };
  }
  const zone = context.vars?.[step.zoneVar] || step.zone;
  if (!fieldZones.includes(zone)) {
    addLog(`${card.name}のコール先を選んでください。`);
    return { ok: false, reason: "missing_call_zone" };
  }
  // 必殺モンスターの共通ゲート（効果による自己コールも制限に服する）。
  if (!impactMonsterCallAllowed(context.owner, card, { specialCall: Boolean(step.specialCall) })) {
    addLog(`${card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
    return { ok: false, reason: "impact_monster_call_restricted" };
  }
  if (turnCallRestrictionBlocks(context.owner, card)) {
    addLog(`${card.name}はこのターン、コール制限によりコールできません。`);
    return { ok: false, reason: "turn_call_restricted" };
  }
  const cost = card.costs?.call || [];
  const adjustedSelfCallCost = adjustedCostSteps(player, card, "call", cost);
  if (adjustedSelfCallCost.length && !canPayStructuredCost(player, adjustedSelfCallCost, { sourceCard: card }).ok) {
    addLog(`${card.name}のコールコストを支払えません。`);
    return { ok: false, reason: "cannot_pay_call_cost" };
  }
  const removeSelf = (pile) => {
    const index = pile.findIndex((c) => c.instanceId === card.instanceId);
    if (index >= 0) {
      pile.splice(index, 1);
      return true;
    }
    return false;
  };
  const fromDrop = removeSelf(player.drop);
  if (!fromDrop && !removeSelf(player.hand)) {
    addLog(`${card.name}はコールできる場所にありません。`);
    return { ok: false, reason: "self_not_found" };
  }
  card.enteredFromZone = fromDrop ? "drop" : "hand"; // 発生元ゾーン記録（enteredFromZoneIn 用）
  if (adjustedSelfCallCost.length) {
    payStructuredCost(player, adjustedSelfCallCost, { sourceCard: card });
  }
  if (player.field[zone]) {
    dropFieldCardByRule(player, zone);
  }
  player.field[zone] = card;
  recordImpactMonsterCall(context.owner, card);
  card.conditionalSize = null; // 再コール時は前回のサイズ上書き(アンノウン0029等)をリセット
  applyScriptGrantedKeywords(card, step.grantKeywords || []);
  enforceSizeLimit(player, zone);
  addLog(`${card.name}を${zoneLabel(zone)}にコールしました。`);
  if (step.resolveOnEnter !== false) {
    await resolveOnEnter(card, player, null, { byEffect: true, enterCauseCard: context.card });
  }
  return true;
}

// Z5(S-UB-C03/0058): 「このカードがキャラのソウルにあるなら、ソウルにあるこのカードをコールする」。
// 発見経路: findUsableSoulAbilities（13-abilities-core.js）が既存の soulAbilities 走査で無改修対応
// （このopを持つ能力自体を soulAbilities に定義する。既存カードはsoulAbilitiesを持たないため後方互換）。
// このカード自身がどこかの場カードのソウルに入っている前提で、そのソウルから取り出して場へコールする。
// 0058 のテキストにコールコストの記載が無いためコストは支払わない（callSelfFromHandForScriptとの違い）。
async function callSelfFromSoulForScript(step, context) {
  const card = context.card;
  if (!card) {
    return { ok: false, reason: "self_missing" };
  }
  let host = null;
  for (let owner = 0; owner < state.players.length && !host; owner += 1) {
    for (const zone of zones) {
      const fc = state.players[owner].field[zone];
      if (fc?.soul?.some((s) => s.instanceId === card.instanceId)) {
        host = fc;
        break;
      }
    }
  }
  if (!host) {
    addLog(`${card.name}はソウルにありません。`);
    return step.require === false ? true : { ok: false, reason: "not_in_soul" };
  }
  const player = state.players[context.owner];
  const zone = context.vars?.[step.zoneVar] || step.zone;
  if (!fieldZones.includes(zone)) {
    addLog(`${card.name}のコール先を選んでください。`);
    return { ok: false, reason: "missing_call_zone" };
  }
  // 必殺モンスターの共通ゲート（ソウルからの自己コールも制限に服する）。
  if (!impactMonsterCallAllowed(context.owner, card, { specialCall: Boolean(step.specialCall) })) {
    addLog(`${card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
    return { ok: false, reason: "impact_monster_call_restricted" };
  }
  if (turnCallRestrictionBlocks(context.owner, card)) {
    addLog(`${card.name}はこのターン、コール制限によりコールできません。`);
    return { ok: false, reason: "turn_call_restricted" };
  }
  const soulIndex = host.soul.findIndex((s) => s.instanceId === card.instanceId);
  const [removed] = host.soul.splice(soulIndex, 1);
  if (player.field[zone]) {
    dropFieldCardByRule(player, zone);
  }
  removed.conditionalSize = null; // 再コール時は前回のサイズ上書きをリセット
  player.field[zone] = removed;
  recordImpactMonsterCall(context.owner, removed);
  applyScriptGrantedKeywords(removed, step.grantKeywords || []);
  enforceSizeLimit(player, zone);
  addLog(`${removed.name}をソウルから${zoneLabel(zone)}にコールしました。`);
  if (step.resolveOnEnter !== false) {
    await resolveOnEnter(removed, player, null, { byEffect: true, enterCauseCard: context.card });
  }
  return true;
}

// Z8(S-UB-C03/0078): 選択2枚(var、同一オーナー・場ゾーン在)のフィールドゾーンを入れ替える。
// レスト状態・ソウル・ターン修正はカードオブジェクトに載っているため自動追従。継続効果はクエリ時計算
// （05-stats.js）のため再評価不要。pendingAttackの対象/攻撃者ゾーンも安全のため追従書き換えする。
function swapFieldPositionsForScript(step, context) {
  const selected = scriptSelection(step, context);
  const entryA = selected[0];
  const entryB = selected[1];
  if (!entryA?.card || !entryB?.card || entryA.owner !== entryB.owner) {
    addLog(`${context.card?.name || "効果"}で入れ替えるカードを選んでください。`);
    return step.require === false ? true : { ok: false, reason: "invalid_swap_selection" };
  }
  const owner = entryA.owner;
  const player = state.players[owner];
  const zoneA = entryA.zone;
  const zoneB = entryB.zone;
  if (!zoneA || !zoneB || zoneA === zoneB) {
    return step.require === false ? true : { ok: false, reason: "invalid_swap_zones" };
  }
  const cardA = player.field[zoneA];
  const cardB = player.field[zoneB];
  player.field[zoneA] = cardB;
  player.field[zoneB] = cardA;
  const pending = state.pendingAttack;
  if (pending) {
    if (pending.targetOwner === owner) {
      if (pending.targetZone === zoneA) pending.targetZone = zoneB;
      else if (pending.targetZone === zoneB) pending.targetZone = zoneA;
    }
    (pending.attackers || []).forEach((attacker) => {
      if (attacker.owner !== owner) return;
      if (attacker.zone === zoneA) attacker.zone = zoneB;
      else if (attacker.zone === zoneB) attacker.zone = zoneA;
    });
    if (pending.attackerOwner === owner) {
      if (pending.attackerZone === zoneA) pending.attackerZone = zoneB;
      else if (pending.attackerZone === zoneB) pending.attackerZone = zoneA;
    }
  }
  addLog(`${context.card?.name || "効果"}の効果で${zoneLabel(zoneA)}と${zoneLabel(zoneB)}のカードを入れ替えました。`);
  return true;
}

// Z13(S-UB-C03/0066《あの子》): デッキ最上位1枚を見ずに取り、裏向きモンスターとして空きエリアに出す。
// callSelectedAsMonsterForScript（既存・トークン専用）の配置本体を、デッキトップ直取り版に流用する。
// selectCards(from:"deck")は全デッキが見える仕様のため使用禁止（このopがデッキトップ直取りを担う）。
async function callTopDeckAsMonsterForScript(step, context) {
  const player = context.player || state.players[context.owner];
  const card = player.deck.pop();
  if (!card) {
    addLog(`${context.card?.name || "効果"}の効果を使いましたが、デッキがありません。`);
    declareDeckLoss(player);
    return step.require === false ? true : { ok: false, reason: "deck_empty" };
  }
  const allowedZones = Array.isArray(step.zones) ? step.zones : fieldZones;
  const emptyZones = allowedZones.filter((zone) => fieldZones.includes(zone) && !player.field[zone]);
  if (emptyZones.length === 0) {
    player.deck.push(card); // 置き場が無ければデッキに戻す（本来は空きエリアがある前提の効果）
    addLog(`${context.card?.name || "効果"}の効果を使いましたが、置くエリアがありません。`);
    return true;
  }
  let zone = emptyZones[0];
  if (emptyZones.length > 1) {
    const selectedZone = await chooseCardEntries(
      emptyZones.map((candidateZone) => ({
        card: { name: step.name || "裏向きのカード", rules: [], attributes: [], keywords: [], costs: {} },
        zone: candidateZone,
        note: zoneLabel(candidateZone),
      })),
      {
        title: `${context.card?.name || "効果"}のコール先`,
        lead: "コールするエリアを選んでください。",
        min: 1,
        max: 1,
        forceDialog: true,
        promptSeat: context.owner,
        purpose: "move",
      },
    );
    zone = selectedZone?.[0]?.zone || zone;
  }
  // r3 L4: 以下は実カード(card)の印字値を裏向きトークン表示用に恒久上書きする。上書き前に
  // printedFaceDownBackup へ退避しておき、場を離れる時に restoreFaceDownMonsterPrint で復元する
  // （復元しないと、離場後もドロップ/手札で「あの子」のまま名前/rules/属性/ステータスが残ってしまう）。
  card.printedFaceDownBackup = {
    name: card.name,
    rules: card.rules,
    attributes: card.attributes,
    additionalNames: card.additionalNames,
    printedAdditionalNames: card.printedAdditionalNames,
    size: card.size,
    power: card.power,
    critical: card.critical,
    defense: card.defense,
  };
  card.currentType = "monster";
  card.faceDownMonster = true;
  card.name = step.name || card.name;
  card.additionalNames = [];
  card.printedAdditionalNames = [];
  card.size = step.size ?? 0;
  card.power = step.power ?? 0;
  card.critical = step.critical ?? 0;
  card.defense = step.defense ?? 0;
  card.attributes = step.attributes || [];
  card.rules = [];
  card.conditionalSize = null;
  player.field[zone] = card;
  enforceSizeLimit(player, zone);
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
  addLog(`${context.card?.name || "効果"}の効果でデッキの上から1枚を裏向きで${zoneLabel(zone)}に置きました。`);
  return true;
}

// r3 L4(S-UB-C03/0066《あの子》): callTopDeckAsMonsterForScriptが実カードへ恒久上書きした
// 裏向きトークン用の表示値(name/rules/attributes/additionalNames/size/power/critical/defense)を、
// このカードが場を離れる際に printedFaceDownBackup から復元する。faceDownMonster でないカードや
// バックアップが無いカード（callSelectedAsMonsterForScript由来の既存トークン等）には何もしない。
// 呼び出し元: resetLeftFieldCardState（手札/デッキへの帰還系）、destroyFieldCard・dropFieldCardByRule
// （破壊/ドロップ系）、detachFieldCardForMove（scriptによる場外移動系）。
function restoreFaceDownMonsterPrint(card) {
  if (!card?.faceDownMonster || !card.printedFaceDownBackup) {
    return;
  }
  const backup = card.printedFaceDownBackup;
  card.name = backup.name;
  card.rules = backup.rules;
  card.attributes = backup.attributes;
  card.additionalNames = backup.additionalNames;
  card.printedAdditionalNames = backup.printedAdditionalNames;
  card.size = backup.size;
  card.power = backup.power;
  card.critical = backup.critical;
  card.defense = backup.defense;
  card.faceDownMonster = false;
  delete card.printedFaceDownBackup;
}

async function callSelectedAsMonsterForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  const zone = context.vars[step.zoneVar] || step.zone;
  if (!entry?.card || !fieldZones.includes(zone)) {
    addLog(`${context.card.name}で置くカードとエリアを選んでください。`);
    return { ok: false, reason: "missing_monster_card_or_zone" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const moved = takeScriptSelectionCards([entry]);
  const calledCard = moved[0]?.card;
  if (!calledCard) {
    return { ok: false, reason: "monster_card_missing" };
  }
  if (player.field[zone]) {
    dropFieldCardByRule(player, zone);
  }
  calledCard.currentType = "monster";
  calledCard.faceDownMonster = true;
  calledCard.size = step.size ?? calledCard.size ?? 0;
  calledCard.power = step.power ?? calledCard.power ?? 0;
  calledCard.critical = step.critical ?? calledCard.critical ?? 1;
  calledCard.defense = step.defense ?? calledCard.defense ?? 0;
  calledCard.attributes = step.attributes || calledCard.attributes || [];
  player.field[zone] = calledCard;
  calledCard.conditionalSize = null; // 再コール時は前回のサイズ上書き(アンノウン0029等)をリセット
  enforceSizeLimit(player, zone);
  addLog(`${context.card.name}の効果で手札のカードを${zoneLabel(zone)}にモンスターとして置きました。`);
  return true;
}

async function callSelectedToEmptyZonesForScript(step, context) {
  const selected = scriptSelection(step, context);
  if (selected.length === 0) {
    return step.require === false ? true : { ok: false, reason: "missing_call_cards" };
  }
  const player = context.player;
  // step.zones でコール先を限定できる（0010「レフトかライトにコール」）。既定は全フィールドゾーン。
  const allowedZones = Array.isArray(step.zones) ? step.zones : fieldZones;
  for (const entry of selected) {
    // 必殺モンスターの共通ゲート: 効果によるコールも「1ターンに1枚・自分のファイナルフェイズのみ」に服する。
    if (!impactMonsterCallAllowed(entry.owner ?? context.owner, entry.card, { specialCall: Boolean(step.specialCall) })) {
      addLog(`${entry.card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
      continue;
    }
    if (turnCallRestrictionBlocks(entry.owner ?? context.owner, entry.card)) {
      addLog(`${entry.card.name}はこのターン、コール制限によりコールできません。`);
      continue;
    }
    const emptyZones = allowedZones.filter((zone) => fieldZones.includes(zone) && !player.field[zone]);
    if (emptyZones.length === 0) {
      break;
    }
    let zone = emptyZones[0];
    if (step.chooseZones && emptyZones.length > 1) {
      const selectedZone = await chooseCardEntries(
        emptyZones.map((candidateZone) => ({
          card: entry.card,
          owner: entry.owner ?? context.owner,
          zone: candidateZone,
          note: zoneLabel(candidateZone),
        })),
        {
          title: `${entry.card.name}のコール先`,
          lead: "コールするエリアを選んでください。",
          min: 1,
          max: 1,
          forceDialog: true,
          promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
          purpose: "move",
        },
      );
      zone = selectedZone?.[0]?.zone;
    }
    if (!zone) {
      continue;
    }
    if (step.payCost) {
      const payment = await payCardCostWithSelection(player, entry.card, step.payCost, entry.card, {
        sourceCard: entry.card,
        callFromZone: entry.source, // E-XU3: コール元ゾーン（drop/soul/deck 等）を軽減判定へ橋渡し
      });
      if (!payment.ok) {
        addLog(payment.reason);
        continue;
      }
    }
    const movedEntries = takeScriptSelectionCards([entry]);
    const calledCard = movedEntries[0]?.card;
    if (!calledCard) {
      continue;
    }
    player.field[zone] = calledCard;
    recordImpactMonsterCall(entry.owner ?? context.owner, calledCard);
    // G5(D-EB01/0023): 「そのカードは場から離れるまでサイズ0になり、ファイナル攻撃可」。
    // enforceSizeLimit より前に conditionalSize を付与しないと元サイズでサイズ超過と誤判定される。
    // 未指定時は従来通り null リセット（再コール時に古いサイズ上書きを引きずらない。アンノウン0029等）。
    calledCard.conditionalSize = step.grantConditionalSize
      ? {
          size: step.grantConditionalSize.size ?? 0,
          granterInstanceId: context.card?.instanceId,
          unconditional: Boolean(step.grantConditionalSize.unconditional),
        }
      : null;
    if (step.grantFinalPhaseAttack) {
      calledCard.grantedFinalPhaseAttack = true;
    }
    applyScriptGrantedKeywords(calledCard, step.grantKeywords || []);
    enforceSizeLimit(player, zone);
    addLog(`${context.card.name}の効果で${calledCard.name}を${zoneLabel(zone)}にコールしました。`);
    if (step.resolveOnEnter) {
      await resolveOnEnter(calledCard, player, null, { byEffect: true, enterCauseCard: context.card });
    }
  }
  return true;
}

async function stackCallSelectedForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  // X16(D-BT01/0020): zoneVar 指定時は「事前に選択した場カード」のゾーンへ重ねる（既定は発生源の場所＝後方互換）。
  const zoneFromVar = step.zoneVar
    ? findFieldCardSlot(scriptSelection({ var: step.zoneVar }, context)[0]?.card)?.zone
    : null;
  const zone = zoneFromVar ?? context.zone ?? findFieldCardSlot(context.card)?.zone;
  if (!entry?.card || !fieldZones.includes(zone)) {
    addLog(`${context.card.name}で重ねてコールするカードを選んでください。`);
    return { ok: false, reason: "missing_stack_call_card" };
  }
  // 必殺モンスターの共通ゲート: 効果による重ねコールも「1ターンに1枚・自分のファイナルフェイズのみ」に服する。
  // F1: 重ねコール判定なので stackCall:true を渡し、raiseImpactCallCap{stackOnly:true}（ジェムクローン）の cap 解放を算入する。
  if (!impactMonsterCallAllowed(entry.owner ?? context.owner, entry.card, { stackCall: true, specialCall: Boolean(step.specialCall) })) {
    addLog(`${entry.card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
    return { ok: false, reason: "impact_monster_call_restricted" };
  }
  if (turnCallRestrictionBlocks(entry.owner ?? context.owner, entry.card)) {
    addLog(`${entry.card.name}はこのターン、コール制限によりコールできません。`);
    return { ok: false, reason: "turn_call_restricted" };
  }
  const player = context.player;
  if (step.payCost) {
    // 選んだカードのコール等コストを支払ってから重ねる（H-EB04/0004: ドロップから重ねコール時のコスト）。
    // 支払い失敗時は選択したカードを動かさず、重ねコール自体を中止する。
    const payment = await payCardCostWithSelection(player, entry.card, step.payCost, entry.card, {
      sourceCard: entry.card,
      callFromZone: entry.source, // E-XU3: コール元ゾーン（drop/soul/deck 等）を軽減判定へ橋渡し
    });
    if (!payment.ok) {
      addLog(payment.reason);
      return { ok: false, reason: "stack_call_cost_unpaid" };
    }
  }
  const moved = takeScriptSelectionCards([entry]);
  const calledCard = moved[0]?.card;
  if (!calledCard) {
    addLog(`${context.card.name}で選んだカードが移動できません。`);
    return { ok: false, reason: "stack_call_card_missing" };
  }
  stackFieldCardAsSoul(player, zone, calledCard);
  recordImpactMonsterCall(entry.owner ?? context.owner, calledCard);
  enforceSizeLimit(player, zone);
  addLog(`${context.card.name}の効果で${calledCard.name}を${zoneLabel(zone)}に重ねてコールしました。`);
  if (step.resolveOnEnter) {
    await resolveOnEnter(calledCard, player, null, { byEffect: true, enterCauseCard: context.card });
  }
  return true;
}

function placeSelectedForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}で配置するカードを選んでください。`);
    return { ok: false, reason: "missing_place_card" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const zone = resolveScriptPlaceZone(step, player);
  if (!zone) {
    addLog(step.noZoneMessage || "配置できる場所がありません。");
    return { ok: false, reason: "missing_place_zone" };
  }
  const moved = takeScriptSelectionCards([entry]);
  const placedCard = moved[0]?.card;
  if (!placedCard) {
    addLog(`${context.card.name}で選んだカードが移動できません。`);
    return { ok: false, reason: "place_card_missing" };
  }
  if (step.currentType) {
    placedCard.currentType = step.currentType;
  }
  player.field[zone] = placedCard;
  if (step.log) {
    addLog(step.log.replace("{cards}", placedCard.name).replace("{zone}", zoneLabel(zone)));
  } else {
    addLog(`${context.card.name}の効果で${placedCard.name}を${zoneLabel(zone)}に置きました。`);
  }
  return true;
}

function resolveScriptPlaceZone(step, player) {
  if (step.zone === "firstEmptySet") {
    return setZones.find((zone) => !player.field[zone]);
  }
  if (step.zone === "firstEmptyField") {
    return fieldZones.find((zone) => !player.field[zone]);
  }
  return step.zone && !player.field[step.zone] ? step.zone : null;
}

function shuffleDeckForScript(step, context) {
  scriptOwnersForController(step.controller || "self", context.owner).forEach((owner) => {
    shuffleInPlace(state.players[owner].deck);
    if (step.log !== false) {
      addLog(`${state.players[owner].name}はデッキをシャッフルしました。`);
    }
  });
  return true;
}

function stopUnlessMovedToDropMatchesForScript(step, context) {
  const movedCards = context.movedToDrop || [];
  const matched = movedCards.some((card) => matchesCardFilter(card, step.filter || {}));
  if (matched) {
    return true;
  }
  if (step.message) {
    addLog(interpolateScriptMessage(step.message, context));
  }
  return { ok: false, reason: "moved_to_drop_condition_not_met" };
}

function interpolateScriptMessage(message, context) {
  return String(message)
    .replaceAll("{card}", context.card?.name || "")
    .replaceAll("{player}", context.player?.name || "")
    .replace(/\{selection:([^}]+)\}/g, (_match, varName) =>
      scriptSelection({ var: varName }, context)
        .map((entry) => entry.card?.name)
        .filter(Boolean)
        .join("、"),
    );
}

function isScriptEffectStep(step) {
  return [
    "relocateFieldMonstersToDistinctZones",
    "treatAsBuddyThisTurn",
    "scheduleZoneMoveAtTurnEnd",
    "draw",
    "searchDeckToHand", // X4(D-BT01)
    "restrictCallThisTurn", // X6(D-BT01/0064)
    "restrictCallCountPerTurn", // E-XB7(X-SS03/0060 ロイヤルティ): chooseBranch の option.script（3択の1つ）から呼べるよう許可
    "discardRandomFromHand", // E-XB8(X-CP03/0058 ファントム・ゲッター): script 経由でも使えるよう許可（effect版 src/15 に委譲）
    "returnTargetSoulToHand", // E-XB11(X-SS03/0057 アトラ"SD"): script 経由でも使えるよう許可（dropTargetSoul と同格）
    "lookTopSelectToSoulRestToDrop", // X10(D-BT01/0044)
    "lookTopSelectToCall", // E-XB39(X-BT04/0027/0053/0081 モンスターエッグ群): 非破壊look→コール→残りデッキ戻し（effect版 src/15 へ委譲）
    "lookTopDistribute", // E-XB40(X-BT04/0008 天晶の祝福): 動的count(countFrom)の非破壊look→ゲージ/手札/デッキ下の3方向振り分け（effect版 src/15 へ委譲）
    "setConditionalSizeScope", // X11b(D-BT01/0131)
    "addTurnContinuous", // X19(D-BT01/0131)
    "stackOnFlag", // E-XB67(X2-BT01/0003 ダ・エーワ後段): 「手札/デッキ横断で1枚選び→フラッグの上に重ね→ライフ+5」を
    //   両立させるための script 許可。効果版 src/15-ability-effects.js:1461 stackOnFlag（stackPlayerFlag で player.flag を
    //   flagId 定義へ差し替え）へ委譲する。選択(selectCards)→重ね(stackOnFlag)→ライフ(gainLife)の script を1本で組める。
    //   flagId 未指定/差し替え不能なら stackPlayerFlag が false を返しログのみ（script は停止しない＝後方互換）。
    "putTopDeckToGauge",
    "putTopDeckToGaugeIfBuddyOnField",
    "moveTopDeckToDrop",
    "gainLife",
    "dealDamage",
    "dealDamageByFieldCardStat",
    "discardAllHand",
    "discardHand",
    "moveHandToGauge",
    "moveMatchingDropToHand",
    "moveGaugeToDrop",
    "revealHand",
    "setNextActivatedCostMayUseOpponentGauge",
    "eachPlayerTopDeckToDropThenDamageOrLife",
    "rockPaperScissorsDamageLosers",
    "rockPaperScissorsBranch", // E-XB74①(X2-SP/0013): 単発ジャンケン→結果分岐（効果版 src/15 へ委譲）。script でも組めるよう許可
    "topTwoRevealOneOpponentRandomToHandOrGauge",
    "startAttackPhase",
    "restSelf",
    // standTarget を script からも使えるよう許可（effect版 src/15 の standTarget へ委譲。target:"$self" は
    // resolveEffectReference が発生源へ解決）。ifCondition(lastDestroySucceeded) の then で自壊スタンドする
    // インフェルノ/ディミオスソード・ドラゴン/ミセリア等は、この許可が無いと「未実装のscript命令」で script が
    // 停止し報酬（スタンド＋後続破壊）が不発だった（F1 と同経路で露見した欠落・後方互換＝旧挙動は常に停止）。
    "standTarget",
    "setLife", // E-XB56①(X-UB03/0001 ギアゴッド ver.1ØØØØ): 「ライフが3以下なら10にする」を無償複数コール(script専用op)と同一 ability で両立させるため script 許可op に加える（effect版 src/15:662 へ委譲）。ifCondition(script) の then に置いて条件付き代入する。未指定の既存カードは script から未使用＝挙動不変。
    "setLifeZeroSafeguard",
    "banEffectDrawTemporal", // E-PR14(PR/0380): script からも使えるよう許可（effect版 src/15 に委譲）
    "preventAllDamageThisTurn",
    "dropSelf",
    "destroySelf",
    "destroy",
    "destroyAll",
    "moveTargetToDrop",
    "putTopDeckToSoul",
    "moveSourceSoulToHand",
    "returnToHand",
    "returnSelfToHand",
    "returnAllToHand",
    "modifyStats",
    "modifyStatsAll",
    "modifyStatsBySelectedCard",
    "modifyStatsByFieldCardStat",
    "modifyStatsIfTargetAttribute",
    "grantKeyword",
    "dropTargetSoul",
    "nullifyAttack",
    "nullifyPendingAction",
    "redirectPendingAttackToSelf",
    "putTopDeckToGaugeEqualToLastDamage",
    "destroyOpponentMonsterWithPowerLteOwnWeapon",
    "moveTargetToZone",
    "moveTargetToEmptyZone",
    "moveSelfToTargetSoul",
    "dropEventCard",
    "preventOwnMonsterAttacksThisTurn",
    "scheduleOpponentTurnSkip", // E-XB28(X-BT03/0102 逆天③): script 経由でも使えるよう許可（effect版 src/15 に委譲）
    "scheduleLossAtNextOwnTurnEnd", // E-XB32(X-BT04/0002 ドラゴウーノ): 予約敗北（effect版 src/15 へ委譲）
    "resetBoardToDeckAndRefill", // E-XB36(X-BT04/0103 ミセリア 逆天): 盤面リセット複合op（effect版 src/15 へ委譲）
    "cancelRecentLifeLink",
    "cancelLifeLink",
    "cancelCallOpportunityLifeLink",
    "reduceNextDamage",
    "preventNextDamage",
    "setPreventNextDestroy",
    "setDelayedDestroyAtOpponentTurnEnd",
    "setDelayedDestroyAtTurnEnd",
    "setDelayedDestroy",
    "shuffleDropIntoDeck",
    "takeExtraTurnAfterThis",
    "gainLifeMinusMatchingDropCount",
    "winGame",
    "lookTopSelectToHandRestToBottom",
    "lookTopSelectToSoulOrHand", // E-ZA3(X-SS02/0001 英雄竜 ジャックナイフ): デッキ上1枚look→ソウル/手札の二択
    "revealTopDamagePerMatchRestToBottom",
    "revealTopCard", // E-XC1(X-CP02 コスモドラグーン reveal-gate): デッキ上1枚を両席公開＝context.revealedCard 記録
    "putRevealedToDeckBottom", // E-XC1: 公開カードをデッキ下へ（不一致 else 分岐 / 「その後デッキの下」型）
    // Z2/Z4(e)/Z4(f)/Z6/Z9/Z12(b)/Z14(g)（S-UB-C03）: script(ability.script)からも使えるよう許可リストに追加。
    "putTopDeckToBuddyZoneFaceDown",
    "moveSelfToBuddyZoneFaceDown",
    "redirectPendingAttackToSelected",
    "grantTurnProtection",
    "grantTurnDamageReduction",
    "grantTurnDestroyImmunity",
    "preventLossUntilOpponentTurnStart", // E-XB1(X-BT02/0113 アステリズム・エフェクト): chooseBranch から敗北保護を付与（effect版 src/15 へ委譲）
    "setPreventNextLeaveField",
    "preventStandThisTurn",
    "preventStandNextTurn", // E-XC10(X-CP02/0070 グラビトン・ジェネレーター): 次の相手スタートフェイズ 全体スタンド不可
    "returnSelfToDeckBottom", // E-XC11(X-CP02/0016 ネクタル): 場のこのカードをデッキの下へ（effect版 src/15 へ委譲）
    "nullifySelectedAbilities", // E-XC8(X-CP02/0040 マインドフェイカー): 選択1枚をそのターン中 能力無効化
    // E-XB49②(X-CBT01/0008 逆天戦艦 サツキG 逆天後段): 「君の場のモンスター全ての能力を無効化し、〜無償コールできる」を
    // 1つの ability(script) で両立させるため script 許可op に加える（effect版 src/15:1529 へ委譲）。script なら
    // nullifyFieldAbilities（自身も無効化）→ 続くソウル無償コールstep を同一 script の連続実行で処理でき、
    // findUsableFieldAbilities のカード単位 nullify ゲート（別ability だと後段が発見不能になる問題）を回避できる
    //（実行中の script は再発見を経ないため自己無効化に阻まれない）。既存カードは script から未使用＝挙動不変。
    "nullifyFieldAbilities",
    "dropSoulSourceCard", // E-XC13(X-CP02/0046 ビガーブレイブ): triggered soulAbility から発生源ソウル札をドロップへ
    "revealRandomHandThenBranch", // E-XU1(X-UB01/0057 パル子): 相手手札ランダム1枚公開＋種別分岐（effect版 src/15 へ委譲）
    "skipToFinalPhase", // E-XV2(X-UB02/0036): メイン→ファイナルへスキップ（effect版 src/15 へ委譲。script からも使用可）
    "endFinalPhase",
    "endCurrentTurn", // E-XB42(X-BT04/0099 逆天殺 後段): 現在ターン即終了（effect版 src/15 へ委譲。script 断片からも使用可）
    "gainTemporaryWorldFromVar", // E-PR15(PR/0461): 選択カードのワールドを発生源へそのターン中付与（card.turnWorlds）
    "grantTemporaryDestroyImmunitySelected", // E-PR17(PR/0478): 選択カードへそのターン中の破壊耐性を付与（grantedTempDestroyImmunities）
  ].includes(step.op);
}

function applyScriptGrantedKeywords(card, keywords) {
  keywords.forEach((keyword) => {
    if (keyword === "counterattack") {
      card.counterattack = true;
      return;
    }
    card.temporaryKeywords ||= [];
    card.temporaryKeywords.push(keyword);
  });
}


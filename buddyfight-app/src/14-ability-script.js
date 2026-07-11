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
    // ソウルカードの triggered soulAbilities も、乗っているホスト(card)のイベントで発火（星合体 竜装機 0102 等）。
    ...(card.soul || []).flatMap((soulCard) =>
      (soulCard.soulAbilities || [])
        .filter((ability) => ability.kind === "triggered" && ability.event === event)
        .map((ability) => ({ ...ability, __fromSoul: soulCard })),
    ),
    // inheritSoulAbilities: ホストが「ソウルにあるカードが持つ全ての“<label>”を得る」（EB03 爆雷継承 0004/0012/0013/0017/0061）。
    // ソウル札の通常 abilities(kind:triggered, label一致) を、このイベントでホストの誘発として合流させる。
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
      await executeAbilityBody(context);
      markAbilityLimit(owner, card, ability);
    }
}

// inheritSoulAbilities:{label} を持つホスト card について、ソウル札の通常 abilities のうち
// kind:triggered・label一致・event一致のものを、ホスト誘発として合流する配列で返す（爆雷継承）。
// limit はソウル札インスタンス単位で管理（__fromSoul により markAbilityLimit/isAbilityLimitUsed が識別）。
function inheritedSoulAbilitiesFor(card, event) {
  const label = card?.inheritSoulAbilities?.label;
  if (!label || !(card.soul || []).length || isAbilitiesNullified(card)) {
    return [];
  }
  return (card.soul || []).flatMap((soulCard) =>
    (soulCard.abilities || [])
      .filter((a) => a.kind === "triggered" && a.event === event && a.label === label)
      .map((a) => ({ ...a, __fromSoul: soulCard })),
  );
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
      return false;
    }
  }
  context.vars = scriptContext.vars;
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
  if (step.op === "payCost") {
    return payCostForScript(step, context);
  }
  if (step.op === "destroySelected") {
    return await destroySelectedForScript(step, context);
  }
  if (step.op === "grantKeywordSelected") {
    return grantKeywordSelectedForScript(step, context);
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
  const selected = await chooseCardEntries(candidates, {
    title: step.title || `${context.card.name}の選択`,
    lead: step.lead || `${min}枚選んでください。`,
    min,
    max,
    forceDialog: step.forceDialog !== false,
    // 権威サーバ: スクリプト選択は能力主体（context.owner）の席へ往復させる。
    // 相手誘発(opponentEnter等)が能動側ターンに選ぶ場合、未指定だと能動側へ誤配送＝手札漏れ。
    promptSeat: context.owner,
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
      const pile = scriptPileForSource(owner, pileKey, context);
      if (!pile) {
        continue;
      }
      pile.forEach((card, index) => {
        if (!scriptCardMatches(card, owner, null, step, context)) {
          return;
        }
        candidates.push({
          card,
          index,
          owner,
          source: pileKey,
          sourceCard: pileKey === "soul" ? context.card : null,
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
  if (!matchesCardFilter(card, step.filter || {})) {
    return false;
  }
  // filter.sameNameAsVar: 先に選んだ別の選択(var)のカードと同じカード名のみ（爆裂魔神丸の術等）。
  if (step.filter?.sameNameAsVar) {
    const refName = scriptSelection({ var: step.filter.sameNameAsVar }, context)[0]?.card?.name;
    if (!refName || card.name !== refName) {
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

function scriptPileForSource(owner, from, context) {
  if (from === "soul") {
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
      putCardsToDropWithTrigger(state.players[destinationOwner], destinationOwner, [entry.card], entry.source, { alreadyPlaced: true });
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
      putCardsToDropWithTrigger(state.players[destinationOwner], destinationOwner, [entry.card], entry.source, { alreadyPlaced: true });
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
  if (step.log) {
    addLog(step.log.replace("{cards}", ordered.map((card) => card.name).join("、")));
  }
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
  } else if (destination === "soul") {
    context.card.soul ||= [];
    context.card.soul.push(card);
  } else if (destination === "itemSoul") {
    // 君のアイテムのソウルに入れる（アーマナイト・カーリーの“修羅降臨の儀”）
    const item = player.field.item;
    if (item) {
      item.soul ||= [];
      item.soul.push(card);
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
      await restFieldCard(entry.owner ?? context.owner, entry.zone, entry.card, { source: context.card, restCause });
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
    const amount = Math.min(step.amount ?? entry.card?.soul?.length ?? 0, entry.card?.soul?.length || 0);
    const movedCards = amount > 0 ? entry.card.soul.splice(0, amount) : [];
    state.players[entry.owner ?? context.owner].drop.push(...movedCards);
    if (movedCards.length > 0 && step.log !== false) {
      addLog(`${entry.card.name}のソウルから${movedCards.map((card) => card.name).join("、")}をドロップゾーンに置きました。`);
    }
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
  for (const entry of scriptSelection(step, context)) {
    if (!entry.card) {
      continue;
    }
    const slot = findFieldCardSlot(entry.card);
    if (slot) {
      const live = state.players[slot.owner].field[slot.zone];
      // Z14(g)(S-UB-C03/0038): そのターン中スタンドできないカードはスキップ。
      if (live && live.cannotStandThisTurn) {
        addLog(`${live.name}はそのターン中スタンドできません。`);
      } else if (live) {
        live.used = false;
        if (step.log !== false) {
          addLog(`${live.name}を【スタンド】しました。`);
        }
      }
    }
  }
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
    putCardsToSoulWithTrigger(host, entry.owner ?? context.owner, [entry.card], entry.source || "field");
  });
  if (movedEntries.length > 0 && step.log !== false) {
    addLog(`${movedEntries.map((entry) => entry.card.name).join("、")}を${host.name}のソウルに入れました。`);
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
  let moved = 0;
  for (let index = 0; index < amount; index += 1) {
    const card = player.deck.pop();
    if (card) {
      host.soul.push(card);
      moved += 1;
    }
  }
  if (moved > 0 && step.log !== false) {
    addLog(`デッキの上から${moved}枚を${host.name}のソウルに入れました。`);
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
  const card = takeSelfFromDropOrField(context);
  if (!card) {
    return true;
  }
  context.player.gauge.push(card);
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
  const card = takeSelfFromDropOrField(context);
  if (!card) {
    return true;
  }
  putCardsToSoulWithTrigger(host, context.owner, [card], fromZone);
  if (step.log !== false) {
    addLog(`${card.name}を${host.name}のソウルに入れました。`);
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
  await equipCardDirect(player, card, { byEffect: true }); // currentType="item" 化して装備（装備変更/装備時誘発も通る）
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
    takeScriptSelectionCards([entry]);
    await equipCardDirect(player, card, { byEffect: true });
    return true;
  }
  if ((type === "spell" || type === "impact") && hasKeyword(card, "set")) {
    const zone = setZones.find((candidate) => !player.field[candidate]);
    if (!zone) {
      addLog("配置魔法ゾーンが空いていません。");
      return { ok: false, reason: "no_set_zone" };
    }
    if (card.uniqueSet && setZones.some((candidate) => player.field[candidate]?.id === card.id)) {
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
    takeScriptSelectionCards([entry]);
    await placeSetSpellDirect(player, card, zone);
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
    addLog(`${context.card.name}で確認した${topCard.name}は現在使えないためデッキの下に置きました。`);
    return true;
  }
  if (step.optional) {
    const useIt = await confirmChoiceAsync(owner, `${topCard.name}を使いますか？`, { yesLabel: "使う", noLabel: "使わない", purpose: "use-optional" });
    if (!useIt) {
      player.deck.unshift(topCard);
      addLog(`${context.card.name}で公開した${topCard.name}を使わずデッキの下に置きました。`);
      return true;
    }
  }
  const target = ability.target ? await chooseAbilityTarget(topCard, ability, owner) : null;
  if (ability.target && !target) {
    player.deck.unshift(topCard);
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
function isCallFromZoneRestricted(owner, card, fromZone) {
  return state.players.some((player) =>
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
        return matchesCardFilter(card, effect.filter || {});
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
  if (!impactMonsterCallAllowed(entry.owner ?? context.owner, entry.card)) {
    addLog(`${entry.card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
    return { ok: false, reason: "impact_monster_call_restricted" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const zone = context.vars[step.zoneVar] || step.zone;
  if (!fieldZones.includes(zone)) {
    addLog(`${context.card.name}のコール先を選んでください。`);
    return { ok: false, reason: "missing_call_zone" };
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
    await resolveOnEnter(calledCard, player, null, { byEffect: true });
  }
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
  if (!impactMonsterCallAllowed(context.owner, card)) {
    addLog(`${card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
    return { ok: false, reason: "impact_monster_call_restricted" };
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
    await resolveOnEnter(card, player, null, { byEffect: true });
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
  if (!impactMonsterCallAllowed(context.owner, card)) {
    addLog(`${card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
    return { ok: false, reason: "impact_monster_call_restricted" };
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
    await resolveOnEnter(removed, player, null, { byEffect: true });
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
    if (!impactMonsterCallAllowed(entry.owner ?? context.owner, entry.card)) {
      addLog(`${entry.card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
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
    calledCard.conditionalSize = null; // 再コール時は前回のサイズ上書き(アンノウン0029等)をリセット
    applyScriptGrantedKeywords(calledCard, step.grantKeywords || []);
    enforceSizeLimit(player, zone);
    addLog(`${context.card.name}の効果で${calledCard.name}を${zoneLabel(zone)}にコールしました。`);
    if (step.resolveOnEnter) {
      await resolveOnEnter(calledCard, player, null, { byEffect: true });
    }
  }
  return true;
}

async function stackCallSelectedForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  const zone = context.zone ?? findFieldCardSlot(context.card)?.zone;
  if (!entry?.card || !fieldZones.includes(zone)) {
    addLog(`${context.card.name}で重ねてコールするカードを選んでください。`);
    return { ok: false, reason: "missing_stack_call_card" };
  }
  // 必殺モンスターの共通ゲート: 効果による重ねコールも「1ターンに1枚・自分のファイナルフェイズのみ」に服する。
  if (!impactMonsterCallAllowed(entry.owner ?? context.owner, entry.card)) {
    addLog(`${entry.card.name}は必殺モンスターのため、今はコールできません（1ターンに1枚・自分のファイナルフェイズのみ）。`);
    return { ok: false, reason: "impact_monster_call_restricted" };
  }
  const player = context.player;
  if (step.payCost) {
    // 選んだカードのコール等コストを支払ってから重ねる（H-EB04/0004: ドロップから重ねコール時のコスト）。
    // 支払い失敗時は選択したカードを動かさず、重ねコール自体を中止する。
    const payment = await payCardCostWithSelection(player, entry.card, step.payCost, entry.card, {
      sourceCard: entry.card,
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
    await resolveOnEnter(calledCard, player, null, { byEffect: true });
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
    "topTwoRevealOneOpponentRandomToHandOrGauge",
    "startAttackPhase",
    "restSelf",
    "setLifeZeroSafeguard",
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
    "revealTopDamagePerMatchRestToBottom",
    // Z2/Z4(e)/Z4(f)/Z6/Z9/Z12(b)/Z14(g)（S-UB-C03）: script(ability.script)からも使えるよう許可リストに追加。
    "putTopDeckToBuddyZoneFaceDown",
    "moveSelfToBuddyZoneFaceDown",
    "redirectPendingAttackToSelected",
    "grantTurnProtection",
    "grantTurnDamageReduction",
    "grantTurnDestroyImmunity",
    "setPreventNextLeaveField",
    "preventStandThisTurn",
    "endFinalPhase",
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


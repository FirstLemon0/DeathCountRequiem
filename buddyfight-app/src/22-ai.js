// ==========================================================================
// buddyfight モジュール 22 — CPU対戦（ローカルAI）: 機構＋頭脳
// 設計の正: docs/CPU対戦_設計メモ_2026-07-02.md（grill Q1〜Q13 合意済み）。
// - 機構: 駆動（ターン駆動 aiTurnStep / 対抗ミニループ aiPendingStep / 応答窓 aiWindowStep=Q11）と
//   seam 応答（aiAnswerSelection / aiAnswerConfirm。src/16 chooseCardEntries・src/11 confirmChoiceAsync から呼ばれる）。
//   CPUの答えは必ず min/max/allowCancel を守り、判断に失敗したら「合法だが凡庸」へフォールバックする（Q9）。
// - 頭脳: cardValue / scoreAction系 / aiChooseSelection / aiDecideConfirm の純関数群（後から差し替え可能）。
// - OFF時の不変性: aiSession.seats が全 false なら全フックが素通り。ネット対戦・権威サーバ・thin では無効。
// ==========================================================================

const aiSession = {
  seats: [false, false], // 席ごとのCPUフラグ（UIは P2=1 を true にする。CPU vs CPU テストは両方 true）
  waitMs: 500, // 1手ごとの見せウェイト（Q8）。0 なら render 駆動を止め、テストが pump を明示駆動する
  running: false, // aiPump の再入ガード
  scheduled: false,
  actionCount: 0, // 1ターンの行動数（Q9 暴走ガード）
  actionCap: 100,
  turnKey: "", // ターン切替検出（actionCount / failedActionKeys 等のリセット）
  failedActionKeys: new Set(), // 実行しても状態が変わらなかった行動（同一ターン内は再試行しない）
  usedOnceKeys: new Set(), // このターンに使った場/ドロップ起動能力（同一能力の連打防止）
  handledWindows: new WeakSet(), // 判断済みの応答窓イベント（同じ窓を再判断しない）
  waitingPendings: new WeakSet(), // CPU応答側だが「宣言側(人間)の攻撃側対抗」を待っている pending
  offeredCounterIds: new Set(), // このターンに人間へ提案済みの対抗カード instanceId（同じ提案の連発防止）
  lastOfferWindow: null, // 最後に提案対象にした応答窓（新しい窓が開いたら再提案を許す）
  errorStreak: 0,
  errorCount: 0, // 累計のフォールバック発生数（スモークの「例外ゼロ」検証用）
};

function aiEnabled() {
  if (!aiSession.seats[0] && !aiSession.seats[1]) {
    return false;
  }
  if (globalThis.__BUDDYFIGHT_SERVER__ || globalThis.__BUDDYFIGHT_THIN__) {
    return false;
  }
  if (typeof isNetworkConnected === "function" && isNetworkConnected()) {
    return false;
  }
  return true;
}

function isAiSeat(seat) {
  return aiEnabled() && (seat === 0 || seat === 1) && aiSession.seats[seat] === true;
}

function aiHumanSeat() {
  return [0, 1].find((seat) => !isAiSeat(seat)) ?? null;
}

// --------------------------------------------------------------------------
// seam 応答（src/16 chooseCardEntries / src/11 confirmChoiceAsync から呼ばれる）
// --------------------------------------------------------------------------
function aiShouldAnswerPrompt(seat) {
  return isAiSeat(seat);
}

// カード選択への応答。頭脳(aiChooseSelection)の答えを min/max/allowCancel に収めて返す（機構の責務）。
async function aiAnswerSelection(normalized, options) {
  const min = options.min ?? Math.min(1, normalized.length);
  const max = Math.min(options.max ?? min, normalized.length);
  const allowCancel = options.allowCancel !== false;
  let picked;
  try {
    picked = aiChooseSelection(normalized, { ...options, min, max, allowCancel });
  } catch (error) {
    aiSession.errorCount += 1;
    console.error("[AI] 選択の判断に失敗。既定選択へフォールバックします。", error);
    picked = undefined;
  }
  if (picked === null && allowCancel) {
    return null; // 明示的な辞退（任意選択）
  }
  if (!Array.isArray(picked)) {
    picked = [];
  }
  const valid = [];
  for (const entry of picked) {
    if (normalized.includes(entry) && !valid.includes(entry)) {
      valid.push(entry);
    }
  }
  for (const entry of normalized) {
    if (valid.length >= min) break;
    if (!valid.includes(entry)) valid.push(entry);
  }
  return valid.slice(0, Math.max(max, min));
}

// Yes/No 確認への応答。判断に失敗したら「はい」（ソウルガード等を無駄死にさせない側）に倒す。
async function aiAnswerConfirm(owner, message, options = {}) {
  try {
    return Boolean(aiDecideConfirm(owner, message, options));
  } catch (error) {
    aiSession.errorCount += 1;
    console.error("[AI] 確認の判断に失敗。既定(はい)へフォールバックします。", error);
    return true;
  }
}

// --------------------------------------------------------------------------
// 駆動（render 末尾から aiOnRender が呼ばれる。テストは __buddyfightAiApi.pump を明示駆動）
// --------------------------------------------------------------------------
function aiOnRender() {
  if (!aiEnabled() || aiSession.running || aiSession.scheduled) {
    return;
  }
  if (!Array.isArray(state?.players) || state.winner || state.resolvingPending) {
    return;
  }
  if (aiSession.waitMs <= 0 || typeof setTimeout !== "function") {
    return; // ヘッドレスは pump 明示駆動（microtask 割り込みでエンジン処理中に干渉しない）
  }
  if (elements.selectionDialog?.open) {
    return; // 人間の選択ダイアログ中は割り込まない（閉じた後の render で再開する）
  }
  if (!aiHasWork()) {
    return;
  }
  aiSession.scheduled = true;
  setTimeout(() => {
    aiSession.scheduled = false;
    aiPump();
  }, Math.min(aiSession.waitMs, 250));
}

function aiWait() {
  if (aiSession.waitMs > 0 && typeof setTimeout === "function") {
    return new Promise((resolve) => setTimeout(resolve, aiSession.waitMs));
  }
  return Promise.resolve();
}

// CPUに今やることがあるか（冪等・副作用なし）。
function aiHasWork() {
  if (!aiEnabled() || !Array.isArray(state?.players) || state.players.length < 2 || state.winner) {
    return false;
  }
  if (hasPendingResolution()) {
    const responder = networkResolutionSeat();
    const declarer = state.pendingAction ? state.pendingAction.owner : state.pendingAttack.attackerOwner;
    if (isAiSeat(responder)) {
      const pending = state.pendingAction || state.pendingAttack;
      if (aiSession.waitingPendings.has(pending)) {
        // 宣言側(人間)の攻撃側対抗を待っている。人間の対抗が尽きたらCPUが解決を引き取る
        return aiEnumerateCounters(declarer).length === 0;
      }
      return true; // CPUが応答側: 対抗するか解決する
    }
    if (isAiSeat(declarer) && !isAiSeat(responder)) {
      // CPU発の宣言で人間が応答側: 使える対抗が無ければ自動解決してテンポを保つ（Q11と同思想）
      return !aiHumanHasUsableCounter(responder);
    }
    return false;
  }
  const windowEvent = aiOpenResponseWindow();
  if (windowEvent && !aiSession.handledWindows.has(windowEvent)) {
    if ([0, 1].some((seat) => isAiSeat(seat) && aiEnumerateWindowCounters(seat).length > 0)) {
      return true;
    }
  }
  return isAiSeat(state.active); // 自ターンの駆動（人間への対抗提案は aiTurnStep が行う）
}

async function aiPump() {
  if (!aiEnabled() || aiSession.running) {
    return;
  }
  aiSession.running = true;
  let guard = 0;
  try {
    while (aiEnabled() && Array.isArray(state?.players) && !state.winner && !state.resolvingPending && aiHasWork()) {
      if ((guard += 1) > 20000) {
        console.error("[AI] pump の安全上限に達したため停止します。");
        break;
      }
      await aiWait();
      let progressed = false;
      try {
        progressed = await aiStep();
        aiSession.errorStreak = 0;
      } catch (error) {
        aiSession.errorStreak += 1;
        aiSession.errorCount += 1;
        console.error("[AI] 行動中に例外。合法な既定行動へフォールバックします。", error);
        try {
          await aiForceAdvance();
          progressed = true;
        } catch (advanceError) {
          console.error("[AI] 進行フォールバックにも失敗。停止します。", advanceError);
          break;
        }
        if (aiSession.errorStreak >= 5) {
          console.error("[AI] 連続エラーが多いため停止します。");
          break;
        }
      }
      if (!progressed) {
        break; // 人間の入力待ち等。次の render で再開する
      }
    }
    // 保存則（fuzzer seed302/685）: 決着(winner成立)でループを抜けた時、宣言直後で宙吊りのままの
    // pendingAction が残っていると、その札（removeSelectedFromHand で手札から抜いた本体＋ソウル）が
    // どのゾーンにも属さず物理消失する（終局後は pump も対抗UIも解決を回さない）。resolveDeclarationIfGameEnded
    // は「このカードのコストで敗北条件を跨いだ」型を宣言時に拾うが、「別カードが先にデッキを0にした後に宣言し、
    // その宣言のコスト検査で決着が判明」型は宣言時点で跨がないため拾えない。ここで正規ゾーンへ着地させる
    // （魔法→ドロップ・コール→場・装備→アイテム枠等、既存の resolvePendingResolution 経路をそのまま使う）。
    // 空デッキ前提の内部テストは pump を回さないためこの安全網の影響を受けない（挙動不変）。
    if (state?.winner && state.pendingAction && !state.resolvingPending) {
      try {
        await resolvePendingResolution();
      } catch (error) {
        console.error("[AI] 終局時の宙吊り宣言の着地中に例外。", error);
      }
    }
  } finally {
    aiSession.running = false;
    try {
      render(); // 操作ロックの解除を画面へ反映（running 中の render はロック表示のままのため）
    } catch (error) {
      // render 不能な環境（極小スタブ等）では無視
    }
  }
}

// 1判断=1行動。true を返すと pump が継続、false は「人間待ち」。
async function aiStep() {
  if (hasPendingResolution()) {
    return aiPendingStep();
  }
  const windowEvent = aiOpenResponseWindow();
  if (windowEvent && !aiSession.handledWindows.has(windowEvent)) {
    const acted = await aiWindowStep(windowEvent);
    if (acted) {
      return true;
    }
  }
  if (isAiSeat(state.active)) {
    return aiTurnStep();
  }
  return false;
}

// --------------------------------------------------------------------------
// 対抗ミニループ（pendingAction / pendingAttack）
// --------------------------------------------------------------------------
async function aiPendingStep() {
  aiResetTurnScope();
  const responder = networkResolutionSeat();
  const declarer = state.pendingAction ? state.pendingAction.owner : state.pendingAttack.attackerOwner;
  if (isAiSeat(responder)) {
    const counters = aiEnumerateCounters(responder).filter(
      (counter) => !aiSession.failedActionKeys.has(aiCounterKey(counter)),
    );
    const pick = aiChooseCounter(counters, responder);
    if (pick) {
      const before = aiStateFingerprint();
      await aiExecuteCounter(pick);
      if (aiStateFingerprint() === before) {
        // 特殊コスト等で不発（状態不変）→ 同一ターン内は再選択しない（不発対抗の無限再選択＝凍結防止）
        aiSession.failedActionKeys.add(aiCounterKey(pick));
      }
      return true;
    }
    // 攻撃への【対抗】は宣言側(攻撃側)にも機会がある(ver2.05・エンジンも対応)。人間の攻撃側対抗が
    // 残っているなら解決せず待つ（人間は対抗カードを使うか「解決」を押す）。
    // pendingAction は宣言側が自分の行動に対抗できない（usePendingActionCounterCard が responder 限定）ため即解決してよい。
    // CPU(応答側)が既に対抗を使った後は「対抗の対抗」は不可のため待たずに解決する。
    if (
      state.pendingAttack &&
      !isAiSeat(declarer) &&
      !state.pendingAttack.counterUsed?.[responder] &&
      aiEnumerateCounters(declarer).length > 0
    ) {
      aiSession.waitingPendings.add(state.pendingAttack);
      return false;
    }
    await resolvePendingResolution();
    return true;
  }
  if (isAiSeat(declarer) && !isAiSeat(responder)) {
    if (!aiHumanHasUsableCounter(responder)) {
      await resolvePendingResolution();
      return true;
    }
    return false; // 人間の対抗 or 解決ボタン待ち
  }
  return false;
}

function aiCounterKey(counter) {
  return `counter:${counter.card.instanceId}`;
}

function aiHumanHasUsableCounter(seat) {
  return aiEnumerateCounters(seat).length > 0;
}

// pending 中に seat が使える【対抗】を列挙する（手札/場・ソウル/ドロップ。エンジン自身の可否関数のみ使用）。
// 手札対抗はコスト支払可否も確認する（支払えない対抗を選んで不発→無限再選択、の凍結防止）。
// 可否関数は state.selected の zone/owner 文脈に依存するため、必ず aiWithSelected で包んで評価する。
function aiEnumerateCounters(seat) {
  const player = state.players[seat];
  if (!player) {
    return [];
  }
  const counters = [];
  for (const card of player.hand) {
    const usable = aiWithSelected({ source: "hand", owner: seat, instanceId: card.instanceId }, () => {
      const ability = findUsableHandAbility(card, { counterOnly: true });
      if (!ability || !canUseCounterEffect(seat, selectedCounterKind(card))) {
        return false;
      }
      return aiCanPayAbilityCost(player, card, ability);
    });
    if (usable) {
      counters.push({ type: "hand", seat, card });
    }
  }
  for (const zone of Object.keys(player.field)) {
    const card = player.field[zone];
    if (!card) continue;
    const usable = aiWithSelected({ source: "field", owner: seat, zone, instanceId: card.instanceId }, () =>
      findUsableFieldAbilities(card, seat).length > 0,
    );
    if (usable) {
      counters.push({ type: "field", seat, zone, card });
    }
  }
  for (const card of player.drop) {
    const usable = aiWithSelected({ source: "drop", owner: seat, instanceId: card.instanceId }, () =>
      findUsableDropAbilities(card, seat).length > 0,
    );
    if (usable) {
      counters.push({ type: "drop", seat, card });
    }
  }
  return counters;
}

// 能力コストの支払可否（判定不能な特殊コストは「支払える」に倒し、実行失敗はブラックリストで吸収）。
function aiCanPayAbilityCost(player, card, ability) {
  try {
    const costSteps = adjustedCostSteps(player, card, abilityCostPurpose(ability), abilityCostSteps(card, ability));
    // canPayStructuredCost は {ok, reason} を返す（オブジェクトのまま返すと常に真になる）。
    // allowInteractiveSelection: 実支払い(payStructuredCostWithSelection)と同条件で判定する
    // （dropOwnMonster 等の選択型コストは候補があれば支払えるとみなす。選択自体は seam でAIが答える）。
    return canPayStructuredCost(player, costSteps, {
      sourceCard: card,
      selectedCard: card,
      allowInteractiveSelection: true,
    }).ok;
  } catch (error) {
    return true;
  }
}

// カード級コスト（コール等）の支払可否。
function aiCanPayCardCost(player, card, purpose) {
  try {
    // cardCostSteps は {exists, steps} ラッパー（steps は adjustedCostSteps 適用済み）を返すため、
    // エンジン本体と同じ canPayCardCost（構造化＋legacyコスト両対応）で判定して .ok を返す。
    return canPayCardCost(player, card, purpose, card, { allowInteractiveSelection: true }).ok;
  } catch (error) {
    return true;
  }
}

async function aiExecuteCounter(pick) {
  if (pick.type === "hand") {
    state.selected = { source: "hand", owner: pick.seat, instanceId: pick.card.instanceId };
  } else if (pick.type === "field") {
    state.selected = { source: "field", owner: pick.seat, zone: pick.zone, instanceId: pick.card.instanceId };
  } else {
    state.selected = { source: "drop", owner: pick.seat, instanceId: pick.card.instanceId };
  }
  await useCardAction();
}

// --------------------------------------------------------------------------
// 応答窓（counterEventWindow / destroyedEventWindow / enteredEventWindow）= Q11
// --------------------------------------------------------------------------
function aiOpenResponseWindow() {
  return state.counterEventWindow || state.destroyedEventWindow || state.enteredEventWindow || null;
}

// pending が無いタイミングで seat が使える手札対抗を列挙（エンジンの canUseCounterPlayCard と同一判定）。
// 応答窓（被ダメ時等）専用ではなく、フリータイミング対抗も条件を満たせばここに載る。コスト支払可否も確認。
function aiEnumerateWindowCounters(seat) {
  const player = state.players[seat];
  if (!player || hasPendingResolution()) {
    return [];
  }
  const counters = [];
  for (const card of player.hand) {
    const usable = aiWithSelected({ source: "hand", owner: seat, instanceId: card.instanceId }, () => {
      if (!canUseCounterPlayCard(card)) {
        return false;
      }
      const ability = findUsableHandAbility(card, { counterOnly: true });
      return ability ? aiCanPayAbilityCost(player, card, ability) : false;
    });
    if (usable) {
      counters.push({ type: "hand", seat, card });
    }
  }
  return counters;
}

async function aiWindowStep(windowEvent) {
  // CPU応答側: 窓対抗を自動判断（人間→CPU方向、CPU vs CPU も含む）。
  // 人間応答側への提案はターン駆動側（aiTurnStep）が担う。
  for (const seat of [0, 1]) {
    if (!isAiSeat(seat)) continue;
    const counters = aiEnumerateWindowCounters(seat);
    if (!counters.length) continue;
    const pick = aiChooseWindowCounter(counters, seat);
    aiSession.handledWindows.add(windowEvent);
    if (pick) {
      await aiExecuteCounter(pick);
      return true;
    }
  }
  aiSession.handledWindows.add(windowEvent);
  return false; // 誰も使わない → そのままターン駆動へ（窓は次の行動で自然失効）
}

// 人間へ【対抗】の使用機会をブロッキング確認で提案する（応答窓＋フリータイミング共通。F4/Q11）。
async function aiOfferHumanCounters(humanSeat, counters) {
  const passEntry = {
    pass: true,
    card: { name: "対抗しない", rules: [], attributes: [], keywords: [], costs: {} },
  };
  const entries = [...counters.map((counter) => ({ card: counter.card, counter })), passEntry];
  const selected = await chooseCardEntries(entries, {
    title: "対抗タイミング",
    lead: "CPUの手番中ですが、今あなたが使える【対抗】カードがあります。使うカードを選ぶか、「対抗しない」を選んでください。",
    min: 1,
    max: 1,
    forceDialog: true,
    allowCancel: false,
    promptSeat: humanSeat,
  });
  const chosen = selected?.[0];
  if (chosen && !chosen.pass && chosen.counter) {
    await aiExecuteCounter(chosen.counter);
  }
}

// --------------------------------------------------------------------------
// ターン駆動（フェイズ骨格＋列挙→採点→実行の反復。ADVANCE が常に候補=停止性保証）
// --------------------------------------------------------------------------
function aiResetTurnScope() {
  const key = `${state.turnCount}:${state.active}`;
  if (aiSession.turnKey !== key) {
    aiSession.turnKey = key;
    aiSession.actionCount = 0;
    aiSession.failedActionKeys = new Set();
    aiSession.usedOnceKeys = new Set();
    aiSession.offeredCounterIds = new Set();
    aiSession.lastOfferWindow = null;
  }
}

async function aiTurnStep() {
  const seat = state.active;
  aiResetTurnScope();
  aiSession.actionCount += 1;
  if (aiSession.actionCount > aiSession.actionCap) {
    await aiForceAdvance();
    return true;
  }
  // 人間の【対抗】機会（F4/Q11統合）: 応答窓 or フリータイミングで人間が使える手札対抗が
  // 新しく現れたら、次の行動（=窓の失効）より前にブロッキング確認を一度だけ出す。
  const humanSeat = aiHumanSeat();
  if (humanSeat !== null) {
    const windowEvent = aiOpenResponseWindow();
    if (windowEvent && windowEvent !== aiSession.lastOfferWindow) {
      aiSession.lastOfferWindow = windowEvent;
      aiSession.offeredCounterIds = new Set(); // 新しい窓が開いたら同じカードでも再提案を許す
    }
    const counters = aiEnumerateWindowCounters(humanSeat);
    const fresh = counters.filter((counter) => !aiSession.offeredCounterIds.has(counter.card.instanceId));
    if (fresh.length) {
      counters.forEach((counter) => aiSession.offeredCounterIds.add(counter.card.instanceId));
      await aiOfferHumanCounters(humanSeat, counters);
      return true;
    }
  }
  switch (state.phase) {
    case "draw":
      await drawAction();
      return true;
    case "charge":
      return aiChargeStep(seat);
    case "main":
      return aiMainStep(seat);
    case "attack":
      return aiAttackStep(seat);
    case "final":
      return aiFinalStep(seat);
    default:
      return false; // "defense" は pendingAttack 中= aiPendingStep 側で扱う
  }
}

async function aiChargeStep(seat) {
  const player = state.players[seat];
  const pick = aiPickChargeCard(player);
  if (!pick) {
    await goMainPhase();
    return true;
  }
  state.selected = { source: "hand", owner: seat, instanceId: pick.instanceId };
  await chargeAction();
  return true;
}

async function aiMainStep(seat) {
  const actions = aiEnumerateMainActions(seat).filter((action) => !aiSession.failedActionKeys.has(action.key));
  const best = aiPickBestAction(actions);
  if (!best) {
    await goAttackPhase();
    return true;
  }
  await aiExecuteAction(best);
  return true;
}

async function aiAttackStep(seat) {
  const actions = aiEnumerateAttacks(seat).filter((action) => !aiSession.failedActionKeys.has(action.key));
  const best = aiPickBestAction(actions);
  if (!best) {
    await goFinalPhase();
    return true;
  }
  await aiExecuteAction(best);
  return true;
}

async function aiFinalStep(seat) {
  const player = state.players[seat];
  for (const card of player.hand) {
    const key = `final:${card.instanceId}`;
    if (aiSession.failedActionKeys.has(key)) continue;
    const ability = aiWithSelected({ source: "hand", owner: seat, instanceId: card.instanceId }, () =>
      findUsableHandAbility(card),
    );
    if (!ability || !aiShouldUseFinalCard(seat, card, ability)) continue;
    await aiExecuteAction({
      key,
      score: 1,
      exec: async () => {
        state.selected = { source: "hand", owner: seat, instanceId: card.instanceId };
        elements.effectTarget.value = "";
        await useCardAction();
      },
    });
    return true;
  }
  // 必殺モンスター(DDD): 自分のファイナルフェイズにのみコール可（1ターン1枚）。
  // コール可能なら貪欲にコールする（デッキのフィニッシャーである前提の近似）。
  if ((state.impactMonsterCallsThisTurn?.[seat] || 0) < 1) {
    const calls = [];
    for (const card of player.hand) {
      if (card.type !== "impactMonster" || card.cannotCallNormally) continue;
      if (!aiCanPayCardCost(player, card, "call")) continue;
      if (card.callStack) {
        // 重ねコール: 有効な重ね先ごとに列挙（メインフェイズのコール列挙と同じF7方式）。
        const bases = aiWithSelected({ source: "hand", owner: seat, instanceId: card.instanceId }, () => {
          try {
            return effectTargetCandidates(card) || [];
          } catch (error) {
            return [];
          }
        });
        for (const base of bases) {
          if (base.owner !== seat || !base.zone) continue;
          calls.push(aiCallAction(seat, card, base.zone, { stack: true, base }));
        }
        // callStack.optional（「１枚まで」型）は重ねずに通常コールも可。重ね先が無くてもコールできる。
        if (card.callStack.optional) {
          for (const zone of fieldZones) {
            if (player.field[zone]) continue;
            calls.push(aiCallAction(seat, card, zone, {}));
          }
        }
        continue;
      }
      for (const zone of fieldZones) {
        if (player.field[zone]) continue;
        calls.push(aiCallAction(seat, card, zone, {}));
      }
    }
    const bestCall = aiPickBestAction(calls.filter((action) => !aiSession.failedActionKeys.has(action.key)));
    if (bestCall) {
      await aiExecuteAction(bestCall);
      return true;
    }
  }
  // ファイナルフェイズ中の攻撃は canDeclareAttackInFinal（必殺モンスター等）に限定（src/09 と同じゲート）。
  const finalAttacks = aiEnumerateAttacks(seat, (card) => canDeclareAttackInFinal(card)).filter(
    (action) => !aiSession.failedActionKeys.has(action.key),
  );
  const bestAttack = aiPickBestAction(finalAttacks);
  if (bestAttack) {
    await aiExecuteAction(bestAttack);
    return true;
  }
  await endTurn();
  return true;
}

// 実行して状態が変わらなければ、その行動キーを同一ターン内でブラックリスト化（同じ無効行動の無限反復を防ぐ）。
async function aiExecuteAction(action) {
  const before = aiStateFingerprint();
  await action.exec();
  if (aiStateFingerprint() === before) {
    aiSession.failedActionKeys.add(action.key);
  }
}

// 例外・行動数上限時の「必ず前へ進む」既定行動（全て正規APIの範囲＝合法）。
async function aiForceAdvance() {
  if (hasPendingResolution()) {
    if (isAiSeat(networkResolutionSeat())) {
      await resolvePendingResolution();
    }
    return;
  }
  switch (state.phase) {
    case "draw":
      await drawAction();
      return;
    case "charge":
      await goMainPhase();
      return;
    case "main":
      await goAttackPhase();
      return;
    case "attack":
      await goFinalPhase();
      return;
    case "final":
      await endTurn();
      return;
    default:
      return;
  }
}

// --------------------------------------------------------------------------
// 合法手の列挙（Q12: 全行動種。既存のエンジン可否関数だけで判定する）
// --------------------------------------------------------------------------
function aiEnumerateMainActions(seat) {
  const player = state.players[seat];
  const actions = [];
  const usableHand = new Set();
  // 手札使用（魔法・必殺技・手札起動能力=搭乗/変身。finder が条件/対象/タイミングを検証済み）
  for (const card of player.hand) {
    const ability = aiWithSelected({ source: "hand", owner: seat, instanceId: card.instanceId }, () =>
      findUsableHandAbility(card),
    );
    if (!ability) continue;
    usableHand.add(card.instanceId);
    actions.push({
      key: `use:${card.instanceId}`,
      score: aiScoreHandUse(seat, card, ability),
      exec: async () => {
        state.selected = { source: "hand", owner: seat, instanceId: card.instanceId };
        elements.effectTarget.value = "";
        await useCardAction();
      },
    });
  }
  // コール（重ねコール含む）＋バディコール。支払えないコールは列挙しない
  // （F2: 支払い不能バディコールの宣言⇄解除ループ防止。特殊コストの判定不能は列挙に倒す）。
  for (const card of player.hand) {
    if (!isCallableMonster(card) || card.cannotCallNormally) continue;
    if (card.type === "impactMonster") continue; // 必殺モンスターはファイナルフェイズ限定（aiFinalStep で扱う）
    if (!aiCanPayCardCost(player, card, "call")) continue;
    const buddyable = !player.partnerCalled && isBuddyCard(player, card);
    if (card.callStack) {
      // 重ねコール: 有効な重ね先（効果対象候補）ごとに列挙し、exec で effectTarget に重ね先を指定する（F7）。
      const bases = aiWithSelected({ source: "hand", owner: seat, instanceId: card.instanceId }, () => {
        try {
          return effectTargetCandidates(card) || [];
        } catch (error) {
          return [];
        }
      });
      for (const base of bases) {
        if (base.owner !== seat || !base.zone) continue;
        actions.push(aiCallAction(seat, card, base.zone, { stack: true, base }));
      }
      // callStack.optional（「１枚まで」型）は重ねずに空きエリアへの通常コールも可。
      // 重ね先が無い/選ばない場合の経路を AI にも開く（callMonster 側の optional 分岐と対応）。
      if (card.callStack.optional) {
        for (const zone of fieldZones) {
          if (player.field[zone]) continue;
          actions.push(aiCallAction(seat, card, zone, {}));
          if (buddyable) {
            actions.push(aiCallAction(seat, card, zone, { buddy: true }));
          }
        }
      }
      continue;
    }
    for (const zone of fieldZones) {
      if (player.field[zone]) continue;
      actions.push(aiCallAction(seat, card, zone, {}));
      if (buddyable) {
        actions.push(aiCallAction(seat, card, zone, { buddy: true }));
      }
    }
  }
  // アイテム装備（手札能力として使えないアイテムの通常装備経路）
  for (const card of player.hand) {
    if (card.type !== "item" || usableHand.has(card.instanceId)) continue;
    actions.push({
      key: `equip:${card.instanceId}`,
      score: aiScoreEquip(seat, card),
      exec: async () => {
        state.selected = { source: "hand", owner: seat, instanceId: card.instanceId };
        elements.effectTarget.value = "";
        await useCardAction();
      },
    });
  }
  // 場の起動能力（ソウル能力・星合体含む。同一カードは1ターン1回まで=連打防止）
  for (const zone of Object.keys(player.field)) {
    const card = player.field[zone];
    if (!card) continue;
    const abilities = findUsableFieldAbilities(card, seat);
    if (!abilities.length) continue;
    const key = `field:${card.instanceId}`;
    if (aiSession.usedOnceKeys.has(key)) continue;
    actions.push({
      key,
      score: aiScoreFieldAbility(seat, card, abilities),
      exec: async () => {
        aiSession.usedOnceKeys.add(key);
        state.selected = { source: "field", owner: seat, zone, instanceId: card.instanceId };
        elements.effectTarget.value = "";
        await useCardAction();
      },
    });
  }
  // ドロップ起動能力
  for (const card of player.drop) {
    const key = `drop:${card.instanceId}`;
    if (aiSession.usedOnceKeys.has(key)) continue;
    if (!findUsableDropAbilities(card, seat).length) continue;
    actions.push({
      key,
      score: aiScoreDropAbility(seat, card),
      exec: async () => {
        aiSession.usedOnceKeys.add(key);
        await useDropAbilityAction(seat, card);
      },
    });
  }
  return actions;
}

function aiCallAction(seat, card, zone, options) {
  const key = options.buddy
    ? `buddycall:${card.instanceId}:${zone}`
    : options.stack
      ? `call-stack:${card.instanceId}:${zone}`
      : `call:${card.instanceId}:${zone}`;
  return {
    key,
    score: aiScoreCall(seat, card, zone, options),
    exec: async () => {
      state.selected = { source: "hand", owner: seat, instanceId: card.instanceId };
      // 重ねコールは getStackCallTarget が効果対象を参照するため、重ね先を明示指定する（F7）。
      elements.effectTarget.value = options.base ? encodeTarget(options.base.owner, options.base.zone) : "";
      if (options.buddy) {
        // 宣言は明示代入（partnerCall のトグルだと、コール失敗→再試行で宣言が解除され
        // フィンガープリントが毎回変わりブラックリストが効かない=F2のループ）。
        state.buddyCallDeclared = card.instanceId;
      }
      await callMonster(zone);
    },
  };
}

function aiEnumerateAttacks(seat, attackerFilter) {
  const player = state.players[seat];
  const actions = [];
  for (const zone of Object.keys(player.field)) {
    const card = player.field[zone];
    if (!card || card.used) continue;
    if (attackerFilter && !attackerFilter(card)) continue; // ファイナルフェイズの必殺モンスター限定攻撃(aiFinalStep)用
    if (!canDeclareAttack({ owner: seat, zone, card })) continue;
    const targets = aiWithSelected({ source: "field", owner: seat, zone, instanceId: card.instanceId }, () =>
      computeAttackTargetCandidates(),
    );
    for (const target of targets) {
      actions.push({
        key: `attack:${card.instanceId}:${target.value}`,
        score: aiScoreAttack(seat, card, target),
        exec: async () => {
          state.linkAttackers = [];
          state.selected = { source: "field", owner: seat, zone, instanceId: card.instanceId };
          render(); // attackTarget の option を最新化してから対象を指定する
          elements.attackTarget.value = target.value;
          await attackAction();
        },
      });
    }
  }
  return actions;
}

// 状態フィンガープリント（行動が実際に何かを変えたかの判定用）。
function aiStateFingerprint() {
  const parts = [
    state.phase,
    state.turnCount,
    state.attacksThisTurn,
    state.drewThisTurn,
    state.chargedThisTurn,
    state.buddyCallDeclared || "",
    hasPendingResolution() ? 1 : 0,
    state.winner || "",
  ];
  for (const player of state.players) {
    parts.push(
      player.hand.length,
      player.gauge.length,
      player.drop.length,
      player.deck.length,
      player.life,
      player.partnerCalled ? 1 : 0,
      Object.values(player.field)
        .map((card) => (card ? `${card.instanceId}${card.used ? "r" : "s"}${card.soul?.length || 0}` : "-"))
        .join(","),
    );
  }
  return parts.join("|");
}

// state.selected / linkAttackers を一時差し替えて評価する（エンジンの finder が selected 依存のため）。
function aiWithSelected(selected, evaluate) {
  const prevSelected = state.selected;
  const prevLink = state.linkAttackers;
  state.selected = selected;
  state.linkAttackers = [];
  try {
    return evaluate();
  } finally {
    state.selected = prevSelected;
    state.linkAttackers = prevLink;
  }
}

// --------------------------------------------------------------------------
// 頭脳（差し替え可能な判断関数群。v1 はカジュアルなヒューリスティック=Q5）
// --------------------------------------------------------------------------
function aiPickBestAction(actions) {
  let best = null;
  for (const action of actions) {
    if (action.score > 0 && (!best || action.score > best.score)) {
      best = action;
    }
  }
  return best;
}

function cardValue(card) {
  if (!card) return 0;
  let value = (card.power || 0) / 1000 + (card.defense || 0) / 1000 + (card.critical || 0) * 3;
  for (const keyword of ["soulguard", "penetrate", "doubleAttack", "tripleAttack", "quadrupleAttack", "counterattack", "move"]) {
    if (hasKeyword(card, keyword)) value += 2;
  }
  return value;
}

function aiPickChargeCard(player) {
  if (!player.hand.length) return null;
  if (player.hand.length <= 3 && player.gauge.length >= 3) return null; // 手札温存（ゲージ十分）
  return [...player.hand].sort((a, b) => cardValue(a) - cardValue(b))[0];
}

function aiScoreCall(seat, card, zone, options) {
  const player = state.players[seat];
  if (!options.stack && !canAddSize(player, card)) {
    return -1; // サイズ超過コールは選ばない（ルール処理での即ドロップを避ける）
  }
  let score = 5 + cardValue(card) / 10;
  if (zone === "center" && !player.field.center) {
    score += 3; // センター防御優先
  }
  if (options.buddy) {
    score += 2; // ライフ+1 のぶんバディコールを優先
  }
  if (options.stack) {
    score = 4 + cardValue(card) / 10;
  }
  return score;
}

function aiScoreEquip(seat, card) {
  return 6 + cardValue(card) / 10;
}

function aiScoreHandUse(seat, card, ability) {
  if (card.type === "impact") return 0; // 必殺技はファイナルフェイズ（aiFinalStep）で
  if (card.type === "spell") return 2;
  return 3; // 搭乗/変身など手札起動
}

function aiScoreFieldAbility(seat, card, abilities) {
  return 1;
}

function aiScoreDropAbility(seat, card) {
  return 1;
}

function aiScoreAttack(seat, card, target) {
  const opponent = state.players[1 - seat];
  if (target.value === "fighter") {
    let score = 8 + visibleCritical(card);
    if (opponent.life <= visibleCritical(card)) {
      score += 100; // 致死チェック: この一撃で決まるなら最優先（Q5）
    }
    return score;
  }
  const defenderCard = opponent?.field?.[target.zone];
  if (!defenderCard) return 1;
  const destroys = visiblePower(card) >= visibleDefense(defenderCard);
  let score = destroys ? 7 + cardValue(defenderCard) / 10 : 0.4; // 破壊できない攻撃はほぼ無価値
  if (hasKeyword(defenderCard, "counterattack") && visiblePower(defenderCard) >= visibleDefense(card)) {
    score -= cardValue(card) / 2; // 反撃で討ち死にするトレードは減点
  }
  if (destroys && hasKeyword(card, "penetrate")) {
    score += visibleCritical(card); // 貫通ダメージぶん加点
  }
  return score;
}

// pending への対抗判断（Q5: 明白な対抗のみ）。
// 自分が防御側の攻撃に対し、致死/大打点 or 主力破壊なら nullifyAttack 系シールドを切る。
function aiChooseCounter(counters, seat) {
  const pending = state.pendingAttack;
  if (!pending || pending.defender !== seat) {
    return null; // 行動(pendingAction)への対抗は v1 では見送り
  }
  const shields = counters.filter((counter) => counter.type === "hand" && aiAbilityNullifiesAttack(counter.card));
  if (!shields.length) {
    return null;
  }
  const attackerCards = (pending.attackers || [])
    .map((slot) => state.players[slot.owner]?.field?.[slot.zone])
    .filter(Boolean);
  const damage = attackerCards.reduce((sum, attacker) => sum + visibleCritical(attacker), 0);
  const power = attackerCards.reduce((sum, attacker) => sum + visiblePower(attacker), 0);
  if (pending.targetType === "fighter") {
    const life = state.players[seat].life;
    if (damage >= life || (life <= 5 && damage >= 3)) {
      return shields[0]; // 致死 or 危険域の大打点はシールド
    }
    return null;
  }
  const targetCard = state.players[pending.targetOwner]?.field?.[pending.targetZone];
  if (targetCard && power >= visibleDefense(targetCard) && cardValue(targetCard) >= 8) {
    return shields[0]; // 主力が破壊される攻撃はシールド
  }
  return null;
}

function aiAbilityNullifiesAttack(card) {
  return (card?.abilities || []).some((ability) =>
    JSON.stringify(ability.effects || ability.script || []).includes('"nullifyAttack"'),
  );
}

// 応答窓（被ダメ時など）への対抗判断。条件を満たして使えるなら使う
// （インデュア等の資源系。窓ごとに1回だけ判断されるため連打はしない）。
function aiChooseWindowCounter(counters, seat) {
  return counters[0] || null;
}

function aiShouldUseFinalCard(seat, card, ability) {
  return card.type === "impact"; // 使える必殺技（条件はfinderで検証済み）は撃つ
}

// selectCards の用途推論（設計メモ §3-2）。src/14 selectCardsForScript から呼ばれる。
// DSL明示(purpose/role)が無い時、同一変数を参照する後続の消費opから hostile/friendly/cost/search を導く。
function aiInferScriptSelectPurpose(step, context) {
  const steps = context?.__scriptSteps || [];
  const start = (context?.__scriptIndex ?? -1) + 1;
  const varKey = step.var || step.selection || step.cardVar;
  const targetsOpponent = /opponent|相手/i.test(JSON.stringify(step.from ?? step.zone ?? ""));
  for (let i = start; i < steps.length; i += 1) {
    const next = steps[i];
    const nextVar = next.var || next.selection || next.cardVar;
    if (varKey && nextVar && nextVar !== varKey) {
      continue; // 別変数を消費するopはスキップして更に先を見る
    }
    switch (next.op) {
      case "destroySelected":
      case "restSelected":
        // controller 省略時のエンジン既定は self（scriptControllerMatches / scriptOwnersForController）＝
        // 候補は自軍のみ。自軍から選んで破壊/レストは自己犠牲コスト（最低価値を差し出す）。
        // "opponent"・"any"（両陣営）の時のみ敵対消費（aiChooseSelection の hostile 分岐が相手側を優先）。
        return (step.controller || "self") === "self" ? "cost" : "hostile";
      case "callSelected":
      case "callSelectedAsMonster":
      case "callSelectedToEmptyZones":
      case "stackCallSelected":
      case "placeSelected":
      case "grantKeywordSelected":
      case "modifySelectedStats":
      case "equipSelectedAsItem":
      case "useSelectedCard":
        return "friendly";
      case "gainNameAsSelected":
        return "declare";
      case "payCardCostForSelection":
        return "cost";
      case "moveSelectedToDeckBottomOrdered":
        return targetsOpponent ? "hostile" : "cost";
      case "moveSelected":
      case "moveSelectedGroup": {
        const to = next.to || "";
        if (to === "hand") {
          return targetsOpponent ? "hostile" : "search";
        }
        return targetsOpponent ? "hostile" : "cost"; // soul/gauge/deck/drop への自カード移動はコスト系
      }
      default:
        continue; // ifCondition/log 等の非消費opは読み飛ばす
    }
  }
  return undefined;
}

// カード選択の判断（purpose 駆動。設計メモ Q4/Q5）。
// - cost: 最小価値を差し出す ／ hostile: 相手の最大の脅威を最大数 ／ friendly/search: 最大価値
// - declare/branch: 先頭 ／ rps: ランダム ／ タグ無し: 必須なら先頭min枚・任意は辞退
function aiChooseSelection(normalized, options) {
  const purpose = options.purpose;
  const byValueAsc = () => [...normalized].sort((a, b) => aiEntryValue(a) - aiEntryValue(b));
  const byValueDesc = () => [...normalized].sort((a, b) => aiEntryValue(b) - aiEntryValue(a));
  switch (purpose) {
    case "cost":
      if (options.min <= 0) {
        return options.allowCancel ? null : [];
      }
      return byValueAsc().slice(0, options.min);
    case "hostile": {
      // 敵対消費（破壊・レスト等）は相手のカードを優先。controller:"any" 等で自軍カードも候補に
      // 並ぶ時は、相手側を価値降順で採り、必須枚数(min)の不足分だけ自軍の最低価値で埋める。
      const own = (entry) => options.promptSeat != null && entry.owner === options.promptSeat;
      const picked = byValueDesc()
        .filter((entry) => !own(entry))
        .slice(0, Math.max(options.max, Math.max(options.min, 1)));
      if (picked.length < options.min) {
        picked.push(...byValueAsc().filter(own).slice(0, options.min - picked.length));
      }
      return picked;
    }
    case "friendly":
    case "search":
      return byValueDesc().slice(0, Math.max(options.min, 1));
    case "rps":
      return [normalized[rngInt(normalized.length)]]; // B1: シード乱数（未設定時は Math.random 素通し）
    case "move": {
      const center = normalized.find((entry) => entry.zone === "center");
      if (center) {
        return [center]; // センター空き（=選択肢に出る）なら防御優先で center へ
      }
      const skip = normalized.find((entry) => entry.key === "skip");
      return [skip || normalized[0]];
    }
    case "declare":
    case "branch":
    case "ability-pick":
      return normalized.slice(0, Math.max(options.min, 1));
    default:
      if (options.min <= 0) {
        return options.allowCancel ? null : [];
      }
      return normalized.slice(0, options.min);
  }
}

// 選択候補の価値（entry.card が疑似カードでも安全に 0 になる）。
function aiEntryValue(entry) {
  try {
    return cardValue(entry?.card);
  } catch (error) {
    return 0;
  }
}

// Yes/No 確認の判断（purpose 駆動）。既定は「はい」（ソウルガード/破壊置換/任意誘発を使う側に倒す）。
function aiDecideConfirm(owner, message, options) {
  switch (options?.purpose) {
    case "pay-optional":
      return false; // コストを払う任意のやり直し等は見送る（資源温存）
    case "scry":
      return true; // デッキ上は残す
    default:
      return true;
  }
}

// --------------------------------------------------------------------------
// UI（index.html の CPUトグル/先攻選択）と人間操作ロック
// --------------------------------------------------------------------------
const aiUi = {
  modeSelect: null,
  firstSelect: null,
  restoreRandomDeck: false,
  prevP2Deck: null, // CPUモード有効化前にユーザーが選んでいたP2デッキ（オフ時に復元する）
};

// CPUの手番/思考中は人間の操作（ボタン・盤面タップ）をロックする。
// 例外: pending（対抗確認）中は常に解放する — 応答側の人間は対抗/解決、宣言側の人間も
// 自分の攻撃への攻撃側【対抗】が使えるため（F3）。CPUの判断は pump が担い、実行中は running で守る。
function aiShouldLockHumanControls() {
  if (!aiEnabled() || state?.winner || !Array.isArray(state?.players)) {
    return false;
  }
  if (aiSession.running) {
    return true;
  }
  if (hasPendingResolution()) {
    return false;
  }
  return isAiSeat(state.active);
}

function aiRefreshSeatsFromUi() {
  if (!aiUi.modeSelect) {
    return;
  }
  aiSession.seats = [false, aiUi.modeSelect.value === "on"];
}

function aiApplyUiMode() {
  const on = aiUi.modeSelect?.value === "on";
  if (!on) {
    // オフは即時反映（暴走時に止められるように）。オンは「次の新規から」= aiBeforeNewGame で反映
    // （進行中のホットシート対戦をCPUが乗っ取らないように。F8）。
    aiSession.seats = [false, false];
  }
  aiEnsureRandomDeckOption(on);
  if (Array.isArray(state?.players)) {
    // トグルが効いていることを即座にログで可視化（キャッシュ等で src が古い場合はこのログ自体が出ない）。
    addLog(on ? "CPU対戦モード: 次の「新規」からプレイヤー2をCPUが操作します。" : "CPU対戦モード: オフにしました。");
    render();
  }
}

// CPUモード中は P2 デッキセレクトに「（ランダム）」を先頭追加し既定にする（Q6: 既定ランダム）。
function aiEnsureRandomDeckOption(on) {
  if (typeof document === "undefined") {
    return;
  }
  const select = document.querySelector("#p2DeckSelect");
  if (!select || typeof select.querySelector !== "function") {
    return; // ヘッドレス（dummy element）ではデッキはテスト側が明示指定する
  }
  const existing = select.querySelector('option[value="__cpu_random__"]');
  if (on && !existing) {
    aiUi.prevP2Deck = select.value; // オフに戻した時に復元する（F10）
    const option = document.createElement("option");
    option.value = "__cpu_random__";
    option.textContent = "（ランダム）";
    select.prepend(option);
    select.value = "__cpu_random__";
  } else if (!on && existing) {
    const wasRandom = select.value === "__cpu_random__";
    existing.remove();
    if (wasRandom) {
      const previous = aiUi.prevP2Deck;
      if (previous && Array.from(select.options || []).some((option) => option.value === previous)) {
        select.value = previous; // 有効化前のユーザー選択デッキへ復元
      } else if (select.options?.length) {
        select.selectedIndex = 0;
      }
    }
    aiUi.prevP2Deck = null;
  }
}

// newGame 冒頭フック: CPU席の反映と、CPUデッキ「（ランダム）」の実デッキ解決。
function aiBeforeNewGame() {
  aiRefreshSeatsFromUi();
  aiUi.restoreRandomDeck = false;
  if (!aiEnabled() || typeof document === "undefined") {
    return;
  }
  const select = document.querySelector("#p2DeckSelect");
  if (select && select.value === "__cpu_random__" && deckProfiles.length) {
    // aiBeforeNewGame は newGame の state 再構築より前に走るため、ここでの rng は前ゲームの seed
    // （初回や未設定時は Math.random）に従う。デッキ選択のランダム性としては十分（B1）。
    const profile = deckProfiles[rngInt(deckProfiles.length)];
    select.value = profile.id;
    aiUi.restoreRandomDeck = true;
  }
}

// newGame 末尾フック: 先攻の適用（ランダム/選択。Q6）とAIターンスコープのリセット。
function aiAfterNewGame() {
  if (aiUi.restoreRandomDeck && typeof document !== "undefined") {
    const select = document.querySelector("#p2DeckSelect");
    if (select) {
      addLog(`CPUのデッキ: ${state.players[1]?.deckName || selectedDeckProfile(1)?.name || "ランダム"}`);
      select.value = "__cpu_random__"; // 次の新規ゲームも再抽選
    }
    aiUi.restoreRandomDeck = false;
  }
  aiSession.turnKey = "";
  aiSession.handledWindows = new WeakSet();
  if (!aiEnabled()) {
    return; // CPUモードOFF: 先攻は従来どおりプレイヤー1固定（既存挙動不変）
  }
  // 先攻決定は newGame と同じ resolveFirstSeat に集約（重複排除）。CPU-UI は "0"/"1"/"random" 値。
  // UI が無い（ヘッドレス）場合は従来どおりランダム。newGame が options.firstSeat で置いた値を上書きする。
  const preference = aiUi.firstSelect?.value;
  const firstSeat = resolveFirstSeat(preference === "0" || preference === "1" ? preference : "random");
  state.active = firstSeat;
  addLog(`CPU対戦: 先攻は${state.players[firstSeat].name}です。`);
}

function aiSetupUi() {
  if (globalThis.__BUDDYFIGHT_TEST__ || globalThis.__BUDDYFIGHT_SERVER__ || globalThis.__BUDDYFIGHT_THIN__) {
    return;
  }
  if (typeof document === "undefined") {
    return;
  }
  const modeSelect = document.querySelector("#cpuModeSelect");
  if (!modeSelect || typeof modeSelect.addEventListener !== "function") {
    return; // このページにCPU UIは無い（play.html 等）
  }
  aiUi.modeSelect = modeSelect;
  aiUi.firstSelect = document.querySelector("#cpuFirstSeat");
  modeSelect.addEventListener("change", aiApplyUiMode);
}
aiSetupUi();

// --------------------------------------------------------------------------
// 外部API（UI/テスト用）
// --------------------------------------------------------------------------
globalThis.__buddyfightAiApi = {
  session: aiSession,
  setSeats(seats) {
    aiSession.seats = [Boolean(seats?.[0]), Boolean(seats?.[1])];
  },
  setWaitMs(ms) {
    aiSession.waitMs = Number(ms) || 0;
  },
  enabled: () => aiEnabled(),
  hasWork: () => aiHasWork(),
  pump: () => aiPump(),
  // ヘッドレステスト用アクセサ（state/elements/deckProfiles は let/const のため vm から直接触れない）
  getState: () => state,
  getElements: () => elements,
  getDeckProfiles: () => deckProfiles,
  ui: aiUi,
  applyUiMode: () => aiApplyUiMode(),
};

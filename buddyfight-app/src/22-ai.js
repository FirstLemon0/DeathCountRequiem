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
  // 難易度（席別）。"beginner"=v1のカジュアルヒューリスティック（既定・従来と完全同一の判断）、
  // "advanced"=上級（盤面と打点を読む判断関数群）。判断関数は全て aiIsAdvanced(seat) で分岐し、
  // beginner 側の式には一切触れない＝既存の挙動・テスト・リプレイは不変。
  // 席別なのは「相手ターン中の防御判断（対抗等）はその席の難易度で行う」ため。UIは両席へ同じ値を入れる。
  levels: ["beginner", "beginner"],
  // 上級の個別機能つまみ。既定は全部有効。強さへの寄与を1つずつ計測/切り分けするために外から落とせる。
  // attack は寄与が大きいので細分化して個別に切れるようにする（デッキ相性の切り分け用）。
  advancedFeatures: {
    attack: true, // 攻撃改善の親スイッチ（false で下の4つとも無効）
    attackFutile: true, // 破壊できない攻撃を撃たない
    attackWallPick: true, // 壁処理は打点の低い攻撃者を使う
    attackLethal: true, // センター破壊でリーサルが通る局面を最優先
    attackLink: true, // 連携攻撃を使う
    call: true, charge: true, ability: true, counter: true,
    equip: true, // アイテム装備の評価（打点/防御/多重装備/持ち替え判断）
    size: true, // サイズ枠の管理（実効サイズ・サイズ減少効果）
    flag: true, // 特殊フラッグ（攻撃するフラッグ）での攻撃を使う
  },
};

const AI_LEVELS = ["beginner", "advanced"];

// 上級判定＋機能フラグ。feature 省略時は難易度だけを見る。
function aiAdv(seat, feature) {
  if (!aiIsAdvanced(seat)) {
    return false;
  }
  return feature ? aiSession.advancedFeatures?.[feature] !== false : true;
}

// seat 省略時は「どちらかの席が上級なら true」ではなく、既定席(=CPU想定のP2側)ではなく
// 明示 seat を要求する運用にする。seat 不明の箇所では上級分岐を使わない（誤爆防止）。
function aiIsAdvanced(seat) {
  return seat === 0 || seat === 1 ? aiSession.levels[seat] === "advanced" : false;
}

// seat 省略で両席に設定（UI/通常運用）。テストは席別に指定して強さを比較できる。
function aiSetLevel(level, seat) {
  const normalized = AI_LEVELS.includes(level) ? level : "beginner";
  if (seat === 0 || seat === 1) {
    aiSession.levels[seat] = normalized;
  } else {
    aiSession.levels = [normalized, normalized];
  }
  return normalized;
}

// player オブジェクトから席番号を引く（aiPickChargeCard 等、seat を受け取らない関数用）。
function aiSeatOfPlayer(player) {
  const index = state?.players?.indexOf(player);
  return index === 0 || index === 1 ? index : null;
}

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
  // MR19-1: アタックフェイズ中に使える起動能力も候補に入れる。
  // 以前はここで攻撃しか列挙しておらず、timing:["attack"] の起動能力（暦級五番艦 サツキの
  // 「メインフェイズかアタックフェイズ中、ソウルの《艦載機》をコールする」等）は
  // メインの列挙でもタイミング不一致で弾かれ、CPU が一度も使えなかった。
  const actions = [
    ...aiEnumerateAttacks(seat),
    ...aiEnumerateFieldAbilities(seat),
  ].filter((action) => !aiSession.failedActionKeys.has(action.key));
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
// 場の起動能力の列挙（ソウル能力・星合体含む。同一カードは1ターン1回まで=連打防止）。
// findUsableFieldAbilities が「今のフェイズで使えるか」まで見るので、メイン/アタックの両方から同じ関数を呼べる
// （timing:["attack"] の能力はアタックフェイズでだけ候補に出る）。
function aiEnumerateFieldAbilities(seat) {
  const player = state.players[seat];
  const actions = [];
  if (!player) return actions;
  for (const zone of Object.keys(player.field)) {
    const card = player.field[zone];
    if (!card) continue;
    // 対抗列挙・攻撃対象列挙と同様に aiWithSelected で state.selected を仮設定して列挙する。
    // 『搭乗』『変身』の -field 起動は sourceZoneIn:[left/center/right] を持ち、その条件は state.selected?.zone を
    // 見る。プランニング中 state.selected=null のまま findUsableFieldAbilities を呼ぶと、場のモンスターからの
    // 搭乗/変身が候補に一切現れず（exec 側は selected を設定するのに列挙側だけ包み忘れていた非対称）、CPU が
    // 場からの搭乗/変身を永久に選べなかった。
    const abilities = aiWithSelected(
      { source: "field", owner: seat, zone, instanceId: card.instanceId },
      () => findUsableFieldAbilities(card, seat),
    );
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
  return actions;
}

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
  // MR15-2『着任』: キーワード駆動でアイテム枠へ出すモンスター（サツキ系＝X-UB02/X-CBT01 の《戦艦》の主役）。
  // 能力オブジェクトを持たない（keywords:["arrival"]）ので findUsableHandAbility では拾えず、上の装備列挙は
  // type==="item" 限定、コール列挙はサイズ5で必ず枠超過。結果として CPU はこのカードを一度も選べなかった
  // ＝テーマの中心札が盤面に出ない。useCardAction は hasKeyword(card,"arrival") で arriveCard へ分岐するので、
  // 通常装備と同じ実操作経路（selected→useCardAction）で列挙する。
  for (const card of player.hand) {
    if (usableHand.has(card.instanceId)) continue;
    if (typeof hasKeyword !== "function" || !hasKeyword(card, "arrival")) continue;
    // フラッグのワールド外のカードは使えない（useCardAction が拒否する）。無駄な試行を作らない。
    if (typeof canUseCardForFlag === "function" && !canUseCardForFlag(player, card)) continue;
    if (!aiCanPayCardCost(player, card, "arrival")) continue;
    actions.push({
      key: `arrive:${card.instanceId}`,
      score: aiScoreArrival(seat, card),
      exec: async () => {
        state.selected = { source: "hand", owner: seat, instanceId: card.instanceId };
        elements.effectTarget.value = "";
        await useCardAction();
      },
    });
  }
  // 場の起動能力（ソウル能力・星合体含む）。メインとアタックで同じ列挙を使う（MR19-1）。
  actions.push(...aiEnumerateFieldAbilities(seat));
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
  const singles = []; // 上級の連携攻撃列挙で再利用する「単騎で攻撃できるカード」
  for (const zone of Object.keys(player.field)) {
    const card = player.field[zone];
    if (!card || card.used) continue;
    if (attackerFilter && !attackerFilter(card)) continue; // ファイナルフェイズの必殺モンスター限定攻撃(aiFinalStep)用
    if (!canDeclareAttack({ owner: seat, zone, card })) continue;
    const targets = aiWithSelected({ source: "field", owner: seat, zone, instanceId: card.instanceId }, () =>
      computeAttackTargetCandidates(),
    );
    singles.push({ zone, card, targets });
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
  if (aiAdv(seat, "attack") && aiAdv(seat, "attackLink")) {
    actions.push(...aiEnumerateLinkAttacks(seat, singles));
  }
  if (aiAdv(seat, "flag") && !attackerFilter) {
    actions.push(...aiEnumerateFlagAttacks(seat));
  }
  return actions;
}

// 上級のみ: 「攻撃するフラッグ」（∞ the Chaos ∞ 等 canAttackAsFlag）での攻撃を列挙する。
// 初級は player.field しか走査しないためフラッグ攻撃を一度も使えない（フラッグは player.flag にあり
// field の zone ではない）。フラッグ攻撃は連携できず常に単騎宣言＝source:"flag" で選択する（src/07:74 と同経路）。
function aiEnumerateFlagAttacks(seat) {
  const actions = [];
  const player = state.players[seat];
  if (!player || typeof canAttackAsFlag !== "function" || !canAttackAsFlag(player)) {
    return actions;
  }
  const flag = player.flag;
  if (!flag || flag.used) {
    return actions;
  }
  if (!canDeclareAttack({ owner: seat, zone: "flag", card: flag })) {
    return actions;
  }
  const targets = aiWithSelected({ source: "flag", owner: seat, zone: "flag", instanceId: flag.instanceId }, () =>
    computeAttackTargetCandidates(),
  );
  for (const target of targets) {
    actions.push({
      key: `flagattack:${flag.instanceId}:${target.value}`,
      // フラッグは失っても場のモンスターを失わない＝トレードのリスクが無い攻撃。同条件ならモンスター攻撃より優先する。
      score: aiScoreAttack(seat, flag, target) + 1,
      exec: async () => {
        state.linkAttackers = [];
        state.selected = { source: "flag", owner: seat, zone: "flag", instanceId: flag.instanceId };
        render();
        elements.attackTarget.value = target.value;
        await attackAction();
      },
    });
  }
  return actions;
}

// 上級のみ: 連携攻撃（2枚）を列挙する。初級は単騎しか撃たないため、単体では抜けない高防御の壁を
// 永久に処理できない弱点がある。ver2.05 の連携攻撃は「攻撃力の合計」で判定し、打撃力も合計で入る。
// 3枚以上の組合せは打点効率が落ちやすい（1体ずつ本体を殴った方が総ダメージが大きい）ので2枚に限定する。
function aiEnumerateLinkAttacks(seat, singles) {
  const actions = [];
  if (!Array.isArray(singles) || singles.length < 2) {
    return actions;
  }
  if (state.turnCount === 1) {
    return actions; // 先攻1ターン目は連携攻撃できない（src/09 のゲートと同じ前提）
  }
  const opponent = state.players[1 - seat];
  for (let i = 0; i < singles.length; i += 1) {
    for (let j = i + 1; j < singles.length; j += 1) {
      const a = singles[i];
      const b = singles[j];
      // 連携で「合計攻撃力なら破壊できる」相手だけを狙う（単騎で足りるなら連携する意味がない）。
      const combinedPower = (visiblePower(a.card) || 0) + (visiblePower(b.card) || 0);
      const itemDefense = aiOpponentItemDefense(seat);
      for (const target of a.targets) {
        if (!b.targets.some((t) => t.value === target.value)) continue; // 双方がこの対象を攻撃できること
        if (target.value === "fighter") {
          // MR19-2: 本体は原則1体ずつ殴った方が総打点が多い。ただし防御力アイテムが壁になっている場合、
          // 単騎では攻撃力が足りず1点も通らない（ver2.05「防御力未満の攻撃はダメージを与えられません」）。
          // 連携すれば攻撃力を合算して壁を越えられ、打撃力も合算で入る＝ここだけは連携が正解になる。
          if (itemDefense <= 0) continue;
          const soloBreaksA = (visiblePower(a.card) || 0) >= itemDefense;
          const soloBreaksB = (visiblePower(b.card) || 0) >= itemDefense;
          if (soloBreaksA || soloBreaksB) continue; // 単騎で越えられるなら連携する意味がない
          if (combinedPower < itemDefense) continue; // 連携でも越えられない
          const combinedCritical = (visibleCritical(a.card) || 0) + (visibleCritical(b.card) || 0);
          let fighterScore = 9 + combinedCritical; // 単騎では0点だった打点がまとめて通る
          if ((opponent?.life || 0) <= combinedCritical) {
            fighterScore += 100; // これで決まるなら最優先
          }
          actions.push({
            key: `link:${a.card.instanceId}+${b.card.instanceId}:fighter`,
            score: fighterScore,
            exec: async () => {
              state.linkAttackers = [
                { owner: seat, zone: a.zone },
                { owner: seat, zone: b.zone },
              ];
              state.selected = { source: "field", owner: seat, zone: a.zone, instanceId: a.card.instanceId };
              render();
              elements.attackTarget.value = "fighter";
              await attackAction();
            },
          });
          continue;
        }
        const defenderCard = opponent?.field?.[target.zone];
        if (!defenderCard) continue;
        const defense = visibleDefense(defenderCard) || 0;
        const soloA = (visiblePower(a.card) || 0) >= defense;
        const soloB = (visiblePower(b.card) || 0) >= defense;
        if (soloA || soloB) continue; // 単騎で割れるなら連携は打点の無駄
        if (combinedPower < defense) continue; // 連携でも割れない
        // 壁（センター）を割れると以後の攻撃が本体へ通る。単騎で処理できない盤面を動かす価値は大きい。
        let score = 7 + cardValue(defenderCard) / 10;
        if (target.zone === "center") {
          score += 4;
        }
        score -= ((visibleCritical(a.card) || 0) + (visibleCritical(b.card) || 0)) * 0.4; // 2体ぶんの打点を使う
        if (hasKeyword(defenderCard, "counterattack")) {
          score -= 1; // 反撃で1体持っていかれる可能性
        }
        actions.push({
          key: `link:${a.card.instanceId}+${b.card.instanceId}:${target.value}`,
          score,
          exec: async () => {
            state.linkAttackers = [
              { owner: seat, zone: a.zone },
              { owner: seat, zone: b.zone },
            ];
            state.selected = { source: "field", owner: seat, zone: a.zone, instanceId: a.card.instanceId };
            render();
            elements.attackTarget.value = target.value;
            await attackAction();
          },
        });
      }
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
  for (const keyword of ["soulguard", "penetrate", "doubleAttack", "tripleAttack", "quadrupleAttack", "sextupleAttack", "counterattack", "move"]) {
    if (hasKeyword(card, keyword)) value += 2;
  }
  // 注: cardValue は席を持たない共通尺度（チャージで最小値を捨てる／コスト選択で最小値を差し出す／
  // 敵対選択で最大値を狙う）。ここを難易度で変えると全席・全用途に波及し、実測で勝率が落ちた
  // （『軽いほど偉い』を足したら強い大型札からゲージに捨てる自滅挙動になった）。難易度差は
  // 席を知っている判断関数（aiScoreAttack/aiScoreCall/aiChooseCounter 等）側だけに置く。
  return value;
}

// 上級の盤面評価ヘルパー ---------------------------------------------------
// effectiveSize は場外カードでも安全に呼べるが、疑似カード対策で例外を握る。
function effectiveSizeSafe(card) {
  try {
    return typeof effectiveSize === "function" ? effectiveSize(card) : card?.size || 0;
  } catch (error) {
    return card?.size || 0;
  }
}

// seat から見た相手のセンター（ここにモンスターが居る限り、原則ファイターを殴れない）。
function aiOpponentCenter(seat) {
  return state.players[1 - seat]?.field?.center || null;
}

// seat の場でまだ攻撃していないカードの打撃力合計（このターンにあと何点入るかの見積り）。
function aiRemainingCritical(seat) {
  const player = state.players[seat];
  if (!player) return 0;
  return Object.keys(player.field).reduce((sum, zone) => {
    const card = player.field[zone];
    if (!card || card.used) return sum;
    if (effectiveCardType(card) !== "monster" && !hasKeyword(card, "weapon")) {
      // アイテムは canDeclareAttack 側で判定されるので、ここではモンスターのみ数える近似。
      if (effectiveCardType(card) !== "item") return sum;
    }
    try {
      return sum + (visibleCritical(card) || 0);
    } catch (error) {
      return sum;
    }
  }, 0);
}

// このカードは「攻撃した時／攻撃している間」に仕事をするか（自身・ソウル・継承まで見る）。
// これが真なら、相手を破壊できない攻撃でも撃つ価値がある（ダンジョンW等の攻撃誘発デッキ）。
const AI_ATTACK_TRIGGER_EVENTS = ["attack", "allyAttack", "attacked", "fighterAttacked", "allyLinkAttack", "battleEnd"];
function aiHasAttackTrigger(card) {
  if (!card) return false;
  try {
    if (typeof cardHasTriggeredListener === "function") {
      return AI_ATTACK_TRIGGER_EVENTS.some((event) => cardHasTriggeredListener(card, event));
    }
  } catch (error) {
    /* 疑似カードは下のフォールバックで見る */
  }
  return (card.abilities || []).some(
    (ability) => ability?.kind === "triggered" && AI_ATTACK_TRIGGER_EVENTS.includes(ability.event),
  );
}

// このターン、相手を削り切れる見込みがあるか（センターが空いている＝本体を殴れる前提）。
function aiCanLethalThisTurn(seat) {
  const opponent = state.players[1 - seat];
  if (!opponent) return false;
  return aiRemainingCritical(seat) >= opponent.life;
}

function aiPickChargeCard(player) {
  if (!player.hand.length) return null;
  if (aiAdv(aiSeatOfPlayer(player), "charge")) {
    // 上級: ゲージは行動力。枯渇（0〜1）なら手札が薄くても必ず作り、十分（5以上）なら手札を温存する。
    const gauge = player.gauge.length;
    const hand = player.hand.length;
    if (gauge >= 5 && hand <= 5) return null; // 十分あるので手札を残す
    if (gauge >= 3 && hand <= 3) return null; // 手札が薄いので温存（初級と同じ判断を包含）
    // 捨てるのは「一番仕事をしない札」。同値なら重い（サイズが大きく出しにくい）札から。
    return [...player.hand].sort(
      (a, b) => cardValue(a) - cardValue(b) || effectiveSizeSafe(b) - effectiveSizeSafe(a),
    )[0];
  }
  if (player.hand.length <= 3 && player.gauge.length >= 3) return null; // 手札温存（ゲージ十分）
  return [...player.hand].sort((a, b) => cardValue(a) - cardValue(b))[0];
}

function aiScoreCall(seat, card, zone, options) {
  const player = state.players[seat];
  if (!options.stack) {
    // 初級は印字サイズで判定（従来どおり）。上級は「場に出た後の実効サイズ」で判定する。
    // 『君の場に元々のサイズ３の《竜王番長》がいるなら、このカードのサイズを１減らす』型（96枚）は
    // 印字サイズだと枠に入らず、初級は一生コールしない。エンジン側（enforceSizeLimit→getFieldSize）は
    // 実効サイズで数えるので、実際には合法かつ何も落ちない。
    const overflow = aiAdv(seat, "size")
      ? aiCallWouldOverflow(player, card, zone)
      : !canAddSize(player, card);
    if (overflow) {
      return -1; // サイズ超過コールは選ばない（ルール処理での即ドロップを避ける）
    }
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
  if (aiAdv(seat, "call")) {
    // 上級: センターは「相手の本体攻撃を止める壁」。空いている＝直接殴られる状態なので、
    // ライフが減っているほど、また相手の打点が高いほど、埋める価値が跳ね上がる。
    if (zone === "center" && !player.field.center) {
      const incoming = aiRemainingCritical(1 - seat); // 相手が今出せる打点の目安
      const life = player.life || 0;
      score += Math.min(6, incoming); // 受ける可能性のある打点ぶん
      if (life <= 4) score += 4; // 低ライフでは壁が最優先
      if (incoming >= life) score += 20; // 空けたままだと負ける＝必ず埋める
      // 硬い（防御力が高い）モンスターほど壁として優秀。
      try {
        score += Math.min(4, (visibleDefense(card) || 0) / 2000);
      } catch (error) {
        /* 疑似カードは無視 */
      }
    }
    // 攻めに転じられる盤面なら、打点の高いモンスターを前に出す価値が上がる。
    try {
      if (!aiOpponentCenter(seat)) {
        score += Math.min(3, (visibleCritical(card) || 0));
      }
    } catch (error) {
      /* 無視 */
    }
  }
  return score;
}

// 「このカードを zone に置いたら、場のサイズ合計は上限を超えるか」をエンジンの実効サイズで見積もる。
// 印字サイズではなく effectiveSize（継続 modifyStats の size 減少・conditionalSize 込み）で数えるため、
// 『…なら、場のこのカードのサイズを◯減らす』型のカードを正しくコール候補にできる。
// 盤面を一時的に差し替えて getFieldSize を読むだけの同期評価で、必ず元に戻す（誘発も描画も走らない）。
function aiCallWouldOverflow(player, card, zone) {
  if (!player || !card) return false;
  let slot = zone && Object.prototype.hasOwnProperty.call(player.field || {}, zone) ? zone : null;
  if (!slot) {
    slot = fieldZones.find((z) => !player.field[z]) || fieldZones[0];
  }
  if (!slot) return !canAddSize(player, card);
  const previous = player.field[slot];
  player.field[slot] = card;
  try {
    return getFieldSize(player) > fieldSizeLimit(player);
  } catch (error) {
    return !canAddSize(player, card); // 何かあれば従来判定にフォールバック
  } finally {
    player.field[slot] = previous;
  }
}

function aiScoreEquip(seat, card) {
  if (!aiAdv(seat, "equip")) {
    return 6 + cardValue(card) / 10;
  }
  // 上級: アイテムは「毎ターン本体を殴れる打点」と「防御の壁」の二役。何を装備するかで価値が大きく違う。
  const player = state.players[seat];
  const stat = (fn, card2, fallback) => {
    try {
      return typeof fn === "function" ? fn(card2) || 0 : fallback;
    } catch (error) {
      return fallback;
    }
  };
  const critical = stat(typeof visibleCritical === "function" ? visibleCritical : null, card, card.critical || 0);
  const defense = stat(typeof visibleDefense === "function" ? visibleDefense : null, card, card.defense || 0);
  let score = 6 + critical * 1.5 + defense / 3000;
  // 追加装備枠を開ける/使えるアイテム（降魔王剣 レヴァンティン等）は盤面の総打点を伸ばすので高評価。
  if (card.allowExtraItemEquip || card.canEquipAsExtraItem) {
    score += 3;
  }
  // 既に装備中なら「置き換え」になる。主枠のアイテムより弱いなら装備しない（今のアイテムを失う）。
  // 追加枠に並存できるアイテムは置き換えにならないので減点しない。
  const current = player?.field?.item;
  if (current && !card.allowExtraItemEquip && !card.canEquipAsExtraItem) {
    const currentCritical = stat(typeof visibleCritical === "function" ? visibleCritical : null, current, current.critical || 0);
    const currentDefense = stat(typeof visibleDefense === "function" ? visibleDefense : null, current, current.defense || 0);
    const gain = critical * 1.5 + defense / 3000 - (currentCritical * 1.5 + currentDefense / 3000);
    if (gain <= 0) {
      return 0; // 弱いアイテムへの持ち替えはしない
    }
    score = 6 + gain;
  }
  // 低ライフでは防御アイテムの価値が上がる（本体への攻撃を肩代わりする）。
  if ((player?.life || 0) <= 4 && defense > 0) {
    score += 2;
  }
  return score;
}

// MR15-2『着任』の評価。着任したカードはアイテムとして場に出る（currentType="item"）ので、
// 損得の見方は装備と同じ＝aiScoreEquip に委ねる。そのうえで着任固有の事情を足す:
//  ・元がモンスターなので打点/防御が大きく、アイテムとしては破格（初級の一律6点だと弱すぎる）
//  ・『着任』は既存のアイテムを押しのける（arriveCard が field.item を捨てる）ので、持ち替え損得は
//    aiScoreEquip の置き換え判定がそのまま効く
function aiScoreArrival(seat, card) {
  const base = aiScoreEquip(seat, card);
  if (base <= 0) {
    return base; // 今より弱いものへの置き換えはしない（装備と同基準）
  }
  if (!aiAdv(seat, "equip")) {
    return base + 1; // 初級でも「テーマの主役が一切出ない」は避ける（装備よりわずかに優先）
  }
  let score = base + 2; // 着任は1枚でアイテム枠を強力に埋める＝同点なら通常装備より優先
  try {
    // ソウルガード持ちは場持ちが良い（サツキ系）。盤面維持の価値を上乗せ。
    if (typeof hasKeyword === "function" && hasKeyword(card, "soulguard")) {
      score += 1;
    }
  } catch (error) {
    /* 無視 */
  }
  return score;
}

function aiScoreHandUse(seat, card, ability) {
  if (card.type === "impact") return 0; // 必殺技はファイナルフェイズ（aiFinalStep）で
  if (card.type === "spell") return 2;
  return 3; // 搭乗/変身など手札起動
}

// 能力が「何をするか」を粗く点数化する（上級の起動能力評価）。DSLの op を再帰的に走査して、
// 除去/打点/リソースの各カテゴリに加点する。未知の op は 0 点＝評価対象外（安全側）。
const AI_ABILITY_OP_VALUE = {
  destroy: 4, destroyAll: 6, destroySelected: 4, // 除去は最も直接的
  dealDamage: 3, damageOpponent: 3,
  returnToHand: 3, returnAllToHand: 4, returnPendingTargetToHand: 3,
  putTargetToGauge: 2, moveFieldCardToSoul: 2,
  draw: 2, gainLife: 1.5, putTopDeckToGauge: 1, moveTopDeckToGauge: 1,
  searchDeckToHand: 2, moveMatchingDropToHand: 2,
  standTarget: 2, standSelf: 2, standAll: 3, // スタンド＝追加攻撃
  modifyStats: 1, grantKeyword: 1,
  callSelected: 3, callSelectedToEmptyZones: 3, callSelfFromDrop: 3, // 盤面展開
  restTarget: 1.5, restOwnMonster: 0,
};
function aiAbilityPayoff(ability) {
  let total = 0;
  const walk = (node, depth) => {
    if (depth > 6 || !node) return;
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    if (node.op && Object.prototype.hasOwnProperty.call(AI_ABILITY_OP_VALUE, node.op)) {
      total += AI_ABILITY_OP_VALUE[node.op];
    }
    for (const key of ["effects", "script", "then", "else", "options"]) {
      if (node[key]) walk(node[key], depth + 1);
    }
  };
  walk({ effects: ability?.effects, script: ability?.script }, 0);
  return total;
}

function aiScoreFieldAbility(seat, card, abilities) {
  if (aiAdv(seat, "ability")) {
    // 上級: 起動能力は基本的に得だが、ゲージが枯渇している時にゲージコストを払うと展開が止まる。
    // 無償の能力は積極的に、ゲージを食う能力はゲージに余裕がある時だけ優先度を上げる。
    const list = Array.isArray(abilities) ? abilities : [abilities].filter(Boolean);
    const usesGauge = list.some((ability) =>
      (ability?.cost || []).some((step) => step?.op === "payGauge" && (step.amount || 0) > 0),
    );
    const usesLife = list.some((ability) =>
      (ability?.cost || []).some((step) => step?.op === "payLife" && (step.amount || 0) > 0),
    );
    const player = state.players[seat];
    // 「何をする能力か」で評価する（除去・打点・展開は高く、スタッツ微調整は低く）。
    const payoff = list.reduce((max, ability) => Math.max(max, aiAbilityPayoff(ability)), 0);
    let score = 2.5 + payoff; // コール(5)と比較できるスケール
    if (usesGauge && (player?.gauge?.length || 0) <= 2) score -= 2;
    if (usesLife && (player?.life || 0) <= 4) score -= 3; // 低ライフでライフを払わない
    return score;
  }
  return 1;
}

function aiScoreDropAbility(seat, card) {
  if (aiAdv(seat, "ability")) {
    return 2; // ドロップからの起動は基本的に得（資源を追加で使わない前提の近似）
  }
  return 1;
}

// MR19-2: 相手が装備している「防御力を持つアイテム」の防御力（複数装備なら最大値）。
// ver2.05:「防御力を持つアイテムを装備している時、その防御力未満の攻撃力の攻撃はダメージを与えられません」。
// エンジンの getPendingBattleTargetInfo(src/11) と同じ「全アイテム枠から防御力最大」の規約で読む。
function aiOpponentItemDefense(seat) {
  const opponent = state.players[1 - seat];
  let best = 0;
  try {
    for (const zone of itemZones) {
      const item = opponent?.field?.[zone];
      if (typeof isDefenseItem === "function" ? isDefenseItem(item) : item && visibleDefense(item) > 0) {
        best = Math.max(best, visibleDefense(item) || 0);
      }
    }
  } catch (error) {
    return 0; // 読めない局面では従来どおり（防御アイテム無し扱い）
  }
  return best;
}

function aiScoreAttack(seat, card, target) {
  const opponent = state.players[1 - seat];
  if (target.value === "fighter") {
    let score = 8 + visibleCritical(card);
    // MR19-2: 防御力アイテムの壁。攻撃力が防御力未満だと本体へ1点も通らない＝完全な空振り。
    // 以前はここを見ておらず、防御力6000のアイテム相手に攻撃力4000のモンスターで殴り続けていた
    //（ユーザー報告）。上級は空振りを選ばない。初級は従来どおり（既存挙動不変）。
    const itemDefense = aiOpponentItemDefense(seat);
    if (itemDefense > 0 && visiblePower(card) < itemDefense) {
      if (aiAdv(seat, "attackFutile") && !aiHasAttackTrigger(card)) {
        return 0; // 『攻撃した時』誘発を持つならその仕事のために撃つ（壁抜き不能でも価値がある）
      }
      score -= 6; // 初級・誘発持ちでも「通らない攻撃」は後回しにする
    }
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
  if (aiAdv(seat, "attack")) {
    // 上級: センター処理を「本体を殴るための前提」として評価する。
    // ver2.05 では相手センターにモンスターが居る限り原則ファイターを攻撃できないので、
    // センター破壊は単なるトレードではなく「この後の全打点を通す鍵」になる。
    if (target.zone === "center" && destroys) {
      const opened = aiRemainingCritical(seat) - (visibleCritical(card) || 0); // この攻撃を使った後に残る打点
      score += 4; // センターをどかす価値
      if (opened >= (opponent?.life || 0) && aiAdv(seat, "attackLethal")) {
        score += 100; // センターを割れば残りの攻撃で削り切れる＝実質リーサル。最優先。
      } else {
        score += Math.min(opened, 6); // 通せる打点ぶん加点
      }
      // 誰で壁を割るか: 壁に使った打点は本体に入らない＝高打点を壁にぶつけるのは損。
      // 同じ「壁を割れる」候補の中では打撃力の低い攻撃者を優先する（打点温存）。
      if (aiAdv(seat, "attackWallPick")) {
        score -= (visibleCritical(card) || 0) * 0.8;
      }
    }
    // 破壊できない攻撃は「レストするだけで何も起きない」ので実行しない（初級は 0.4 で撃ってしまう）。
    // 反撃持ちに突っ込めば一方的に失うのでなおさら。score<=0 は aiPickBestAction が採らない。
    if (!destroys) {
      // 破壊できない攻撃を撃たない。ただし『攻撃した時』誘発を持つカードは、破壊できなくても
      // 攻撃自体に価値があるので撃つ（ダンジョンW等の攻撃誘発デッキで損をしないため）。
      if (aiAdv(seat, "attackFutile") && !aiHasAttackTrigger(card)) {
        return 0;
      }
    }
    // 価値の高い相手を優先的に処理（cardValue の差分で重み付け）。
    score += Math.max(0, cardValue(defenderCard) - cardValue(card)) / 5;
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
    if (aiAdv(seat, "counter")) {
      // 上級: 「このターン中に受けうる総打点」で判断する。今の1発では死ななくても、
      // 相手にまだ攻撃者が残っていて合計が致死なら、ここで止めないと負ける。
      const stillComing = aiRemainingCritical(1 - seat); // 未行動の攻撃者ぶん
      if (damage + stillComing >= life) {
        return shields[0];
      }
      // ライフに余裕があるうちは温存（チップダメージでシールドを使い切らない）。
      if (life > 8 && damage <= 2) {
        return null;
      }
      if (damage >= Math.ceil(life / 2)) {
        return shields[0]; // 一撃でライフの半分以上は看過しない
      }
    }
    return null;
  }
  const targetCard = state.players[pending.targetOwner]?.field?.[pending.targetZone];
  if (targetCard && power >= visibleDefense(targetCard) && cardValue(targetCard) >= 8) {
    return shields[0]; // 主力が破壊される攻撃はシールド
  }
  if (aiAdv(seat, "counter") && targetCard && power >= visibleDefense(targetCard)) {
    // 上級: センターを失うと本体が丸裸になる。壁が最後の1枚なら価値が低くても守る。
    const isCenter = pending.targetZone === "center";
    const otherBlockers = fieldZones.filter(
      (zone) => zone !== pending.targetZone && state.players[seat]?.field?.[zone],
    ).length;
    const life = state.players[seat].life;
    if (isCenter && otherBlockers === 0 && aiRemainingCritical(1 - seat) >= life) {
      return shields[0];
    }
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
  if (aiAdv(seat, "counter") && counters.length > 1) {
    // 上級: 窓に複数あるなら「一番軽い（失うものが少ない）」ものから切る。
    // cardValue が低い＝手札としての価値が低い札を先に消費して、強い札を温存する。
    return [...counters].sort((a, b) => aiEntryValue({ card: a.card }) - aiEntryValue({ card: b.card }))[0];
  }
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
  levelSelect: null, // CPUの強さ（初級/上級）
  restoreRandomDeck: [false, false], // 席ごと: 今回の新規ゲームで「（ランダム）」を実デッキへ展開したか
  prevDeck: [null, null], // 席ごと: CPUモード有効化前にユーザーが選んでいたデッキ（オフ時に復元する）
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
  // 両席CPU（観戦モード）は人間の担当席が無いので常にロックする。pending の解放例外は
  //「人間が対抗を使えるようにする」ためのものなので、担当席が無いなら開ける理由が無い。
  if (aiSession.seats[0] && aiSession.seats[1]) {
    return true;
  }
  if (hasPendingResolution()) {
    return false;
  }
  return isAiSeat(state.active);
}

// CPUモードの選択値 → どの席をCPUが操作するか。旧値 "on"（P2のみ）は後方互換で残す
// （保存済みUI状態やテストが "on" を渡してくる）。
function aiSeatsForMode(value) {
  switch (value) {
    case "on": // 旧値＝P2をCPU
    case "p2":
      return [false, true];
    case "p1":
      return [true, false];
    case "both":
      return [true, true];
    default:
      return [false, false];
  }
}

function aiRefreshSeatsFromUi() {
  aiRefreshLevelFromUi();
  if (!aiUi.modeSelect) {
    return;
  }
  aiSession.seats = aiSeatsForMode(aiUi.modeSelect.value);
}

// CPUの強さ（初級/上級）をUIから取り込む。未設置のページ/ヘッドレスでは既定(初級)のまま。
function aiRefreshLevelFromUi() {
  if (aiUi.levelSelect && aiUi.levelSelect.value) {
    aiSetLevel(aiUi.levelSelect.value);
  }
}

function aiApplyUiLevel() {
  aiRefreshLevelFromUi();
  if (Array.isArray(state?.players)) {
    addLog(aiIsAdvanced(1) || aiIsAdvanced(0) ? "CPUの強さ: 上級（盤面と打点を読みます）。" : "CPUの強さ: 初級。");
    render();
  }
}

// CPU席の説明文（ログ用）。
function aiSeatsLabel(seats) {
  if (seats[0] && seats[1]) return "プレイヤー1と2の両方をCPU（観戦）";
  if (seats[0]) return "プレイヤー1をCPU";
  if (seats[1]) return "プレイヤー2をCPU";
  return "";
}

function aiApplyUiMode() {
  const seats = aiSeatsForMode(aiUi.modeSelect?.value);
  const on = seats[0] || seats[1];
  if (!on) {
    // オフは即時反映（暴走時に止められるように）。オンは「次の新規から」= aiBeforeNewGame で反映
    // （進行中のホットシート対戦をCPUが乗っ取らないように。F8）。
    aiSession.seats = [false, false];
  }
  aiEnsureRandomDeckOption(seats);
  if (Array.isArray(state?.players)) {
    // トグルが効いていることを即座にログで可視化（キャッシュ等で src が古い場合はこのログ自体が出ない）。
    addLog(on ? `CPU対戦モード: 次の「新規」から${aiSeatsLabel(seats)}が操作します。` : "CPU対戦モード: オフにしました。");
    render();
  }
}

// 席 → デッキセレクトの id。P1をCPUにできるようにしたので席で引く。
const AI_DECK_SELECT_IDS = ["#p1DeckSelect", "#p2DeckSelect"];

// CPU席のデッキセレクトに「（ランダム）」を先頭追加し既定にする（Q6: 既定ランダム）。
// seats は [P1がCPUか, P2がCPUか]。CPUでなくなった席からは選択肢を外して元のデッキへ戻す（F10）。
function aiEnsureRandomDeckOption(seats) {
  if (typeof document === "undefined") {
    return;
  }
  for (const seat of [0, 1]) {
    const select = document.querySelector(AI_DECK_SELECT_IDS[seat]);
    if (!select || typeof select.querySelector !== "function") {
      continue; // ヘッドレス（dummy element）ではデッキはテスト側が明示指定する
    }
    const on = Boolean(seats?.[seat]);
    const existing = select.querySelector('option[value="__cpu_random__"]');
    if (on && !existing) {
      aiUi.prevDeck[seat] = select.value; // オフに戻した時に復元する（F10）
      const option = document.createElement("option");
      option.value = "__cpu_random__";
      option.textContent = "（ランダム）";
      select.prepend(option);
      select.value = "__cpu_random__";
    } else if (!on && existing) {
      const wasRandom = select.value === "__cpu_random__";
      existing.remove();
      if (wasRandom) {
        const previous = aiUi.prevDeck[seat];
        if (previous && Array.from(select.options || []).some((option) => option.value === previous)) {
          select.value = previous; // 有効化前のユーザー選択デッキへ復元
        } else if (select.options?.length) {
          select.selectedIndex = 0;
        }
      }
      aiUi.prevDeck[seat] = null;
    }
  }
}

// newGame 冒頭フック: CPU席の反映と、デッキ「（ランダム）」の実デッキ解決。
// CPU席だけでなく人間側の席も対象にする（デッキ選択モーダルの「ランダム」で __random__ を選べるため）。
function aiBeforeNewGame() {
  aiRefreshSeatsFromUi();
  aiUi.restoreRandomDeck = [false, false];
  if (typeof document === "undefined") {
    return;
  }
  for (const seat of [0, 1]) {
    const select = document.querySelector(AI_DECK_SELECT_IDS[seat]);
    if (!select || select.value !== "__cpu_random__" || !deckProfiles.length) {
      continue;
    }
    // aiBeforeNewGame は newGame の state 再構築より前に走るため、ここでの rng は前ゲームの seed
    // （初回や未設定時は Math.random）に従う。デッキ選択のランダム性としては十分（B1）。
    const profile = deckProfiles[rngInt(deckProfiles.length)];
    select.value = profile.id;
    aiUi.restoreRandomDeck[seat] = true;
  }
}

// newGame 末尾フック: 先攻の適用（ランダム/選択。Q6）とAIターンスコープのリセット。
function aiAfterNewGame() {
  if (typeof document !== "undefined") {
    for (const seat of [0, 1]) {
      if (!aiUi.restoreRandomDeck[seat]) {
        continue;
      }
      const select = document.querySelector(AI_DECK_SELECT_IDS[seat]);
      if (select) {
        const who = isAiSeat(seat) ? "CPU" : `プレイヤー${seat + 1}`;
        addLog(`${who}のデッキ: ${state.players[seat]?.deckName || selectedDeckProfile(seat)?.name || "ランダム"}`);
        select.value = "__cpu_random__"; // 次の新規ゲームも再抽選
      }
      aiUi.restoreRandomDeck[seat] = false;
    }
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
  const levelSelect = document.querySelector("#cpuLevelSelect");
  if (levelSelect && typeof levelSelect.addEventListener === "function") {
    aiUi.levelSelect = levelSelect;
    aiRefreshLevelFromUi(); // リロード時にブラウザが復元した選択値を初期反映
    levelSelect.addEventListener("change", aiApplyUiLevel);
  }
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
  // CPUの強さ: "beginner"(既定・従来と同一判断) / "advanced"(上級)
  setLevel: (level, seat) => aiSetLevel(level, seat),
  setAdvancedFeatures: (features) => {
    aiSession.advancedFeatures = {
      attack: true, call: true, charge: true, ability: true, counter: true,
      equip: true, flag: true, size: true, ...(features || {}),
    };
  },
  getLevel: (seat) => (seat === 0 || seat === 1 ? aiSession.levels[seat] : aiSession.levels[1]),
  // 判断関数（強さ比較テスト用。スコアだけを純粋に比べられる）
  scoreAttack: (seat, card, target) => aiScoreAttack(seat, card, target),
  scoreCall: (seat, card, zone, options = {}) => aiScoreCall(seat, card, zone, options),
  scoreEquip: (seat, card) => aiScoreEquip(seat, card),
  scoreArrival: (seat, card) => aiScoreArrival(seat, card),
  canPayCardCost: (player, card, purpose) => aiCanPayCardCost(player, card, purpose),
  scoreFieldAbility: (seat, card, abilities) => aiScoreFieldAbility(seat, card, abilities),
  abilityPayoff: (ability) => aiAbilityPayoff(ability),
  enumerateFlagAttacks: (seat) => aiEnumerateFlagAttacks(seat),
  enumerateFieldAbilities: (seat) => aiEnumerateFieldAbilities(seat),
  enumerateAttacks: (seat) => aiEnumerateAttacks(seat),
  chooseCounter: (counters, seat) => aiChooseCounter(counters, seat),
  pickChargeCard: (player) => aiPickChargeCard(player),
  enabled: () => aiEnabled(),
  shouldLockHumanControls: () => aiShouldLockHumanControls(),
  hasWork: () => aiHasWork(),
  pump: () => aiPump(),
  // ヘッドレステスト用アクセサ（state/elements/deckProfiles は let/const のため vm から直接触れない）
  getState: () => state,
  getElements: () => elements,
  getDeckProfiles: () => deckProfiles,
  ui: aiUi,
  applyUiMode: () => aiApplyUiMode(),
};

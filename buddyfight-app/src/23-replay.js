// ==========================================================================
// buddyfight モジュール 23 — リプレイの記録・再生（B2）
// 全モジュールはグローバルスコープを共有し、HTML で番号順に <script> 読み込みする。
//
// 決定論の土台は B1（乱数シード）＋ B2（決定的 instanceId, createInstanceId）。
// これらが揃うと「初期状態(seed/firstSeat/デッキ)」＋「操作列」＋「各操作中のプロンプト応答列」だけから
// 対戦を完全再現できる（伏せ札は seed から再現されるので持ち回らない）。
//
// 記録は chooseCardEntries（src/16）が返る直前で行う。選択ダイアログ・じゃんけん・確認ダイアログは
// すべてこの1つの seam に集約されているため、ローカルUI・CPU(src/22)・権威サーバの __serverPrompt 往復・
// 権威サーバの60秒タイムアウト自動確定（resolveServerSelection が先頭min枚を採る）まで、どの経路でも
// 「実際に確定した選択」が同じ形で載る。壁時計依存のタイムアウト確定やCPUの判断もここで固定される。
//
// アクション境界（1操作＝1step）は呼び出し側が replayBeginStep/replayEndStep で刻む
// （権威サーバは engine-host の applyAction、ローカルは実操作経路の入口）。1回の操作内で複数回の
// プロンプト往復が起きるため（例: じゃんけんは自分→相手の2往復）、応答は step にぶら下げて記録する。
//
// オフ時（session も playback も無い）は真偽値2つを見るだけで素通しする＝オーバーヘッド実質ゼロ。
// ==========================================================================

const REPLAY_VERSION = 1;

// 記録セッション（null の間は記録オフ＝完全素通し）。
let replaySession = null;
// 記録中の現在ステップ（replayBeginStep〜replayEndStep の間だけ非null）。
let replayCurrentStep = null;
// 再生キュー（null=再生オフ / 配列=再生中。空配列でも「再生中」であり、次の選択要求で不足エラーを投げる）。
let replayPlaybackQueue = null;

function replayIsRecording() {
  return replaySession !== null;
}

function replayIsPlaying() {
  return replayPlaybackQueue !== null;
}

// 記録開始。meta: { seed, firstSeat, deckIds, customDecks }。seed 省略時は現 state.rngSeed を採る。
// 返り値はライブのセッション（確定形が欲しい時は replayGetRecording を使う）。
function replayStartRecording(meta = {}) {
  replaySession = {
    version: REPLAY_VERSION,
    seed: meta.seed != null ? meta.seed : state ? state.rngSeed : null,
    firstSeat: meta.firstSeat != null ? meta.firstSeat : null,
    deckIds: Array.isArray(meta.deckIds) ? meta.deckIds.slice() : null,
    // カスタムデッキは engine-host/ローカル双方で復元できるよう丸ごと（JSONセーフに）持つ。
    customDecks: meta.customDecks ? deepClone(meta.customDecks) : null,
    // アクション境界の外（newGame の配牌中など）で起きた選択の受け皿。通常は空。
    setupResponses: [],
    steps: [],
  };
  replayCurrentStep = null;
  return replaySession;
}

// 記録停止。確定したセッション（JSONセーフな複製）を返す。
function replayStopRecording() {
  const done = replaySession ? replayGetRecording() : null;
  replaySession = null;
  replayCurrentStep = null;
  return done;
}

// 記録中セッションのスナップショット（deep clone）。B3（保存・共有URL）はこれを持ち回る。
function replayGetRecording() {
  return replaySession ? deepClone(replaySession) : null;
}

// アクション境界の開始。type/params は engine-host.applyAction／ローカル実操作経路の入口で渡す。
// params は member.token 等の秘匿情報を含まない操作入力（selected/attackTarget/effectTarget/callZone 相当）だが、
// 念のため JSON 往復して非JSON値・関数・循環を落とす。
function replayBeginStep(seat, type, params) {
  if (!replaySession) {
    return;
  }
  replayCurrentStep = {
    seat: seat != null ? seat : null,
    type,
    params: replaySafeParams(params),
    promptResponses: [],
  };
}

// アクション境界の終了。ここで初めて step をセッションへ積む（例外時も呼ぶ＝engine-host 側は finally で確定）。
function replayEndStep() {
  if (!replaySession || !replayCurrentStep) {
    return;
  }
  replaySession.steps.push(replayCurrentStep);
  replayCurrentStep = null;
}

// chooseCardEntries の戻り値（null=キャンセル / entry配列）を応答として記録する。
// 応答は {selectedIndexes:[...]} に正規化する（null は「キャンセル」を表すため null のまま保持）。
function replayRecordSelection(result) {
  if (!replaySession) {
    return;
  }
  const response = {
    selectedIndexes: result === null ? null : result.map((entry) => entry.choiceIndex),
  };
  if (replayCurrentStep) {
    replayCurrentStep.promptResponses.push(response);
  } else {
    replaySession.setupResponses.push(response);
  }
}

// 再生キューを差し替える（step 単位・setup 単位で入れ替える運用）。null で再生オフ。
function replaySetPlaybackQueue(responses) {
  replayPlaybackQueue = Array.isArray(responses) ? responses.slice() : null;
}

function replayClearPlayback() {
  replayPlaybackQueue = null;
}

// 現在のキューに残っている未消費応答数（再生器が「記録が多すぎる」を検出するのに使う）。
function replayPlaybackRemaining() {
  return replayPlaybackQueue ? replayPlaybackQueue.length : 0;
}

// 再生中に chooseCardEntries が呼ばれた時、記録された応答を1つ取り出して候補へ再マップする。
// 応答の過不足・種別（選択/確認）のズレは即エラーにする。ただし**プロンプトの回数・順序・種別を変えない
// 値だけの分岐**（記録済み selectedIndexes が分岐後の別候補を指す）は検出できず黙って別対戦になりうる。
// 実運用の記録源＝権威サーバ net play は AI 非関与で決定的なのでこの経路は踏まないが、ローカル CPU 録画を
// 有効化する場合は AI の rng 消費が再生時に再現されずズレる（既定オフ・HANDOFF の既知の限界参照）。
function replayNextSelection(candidates) {
  if (!replayPlaybackQueue) {
    throw new Error("リプレイ: 再生キューが無い状態で選択が要求されました");
  }
  if (replayPlaybackQueue.length === 0) {
    throw new Error("リプレイ: 記録された応答が不足しています（操作列と選択回数が一致しません）");
  }
  const response = replayPlaybackQueue.shift();
  // B3: 確認応答({confirm})が選択の位置に来たら記録ズレ＝黙って別の対戦になる前に即エラーにする。
  if (response && Object.prototype.hasOwnProperty.call(response, "confirm")) {
    throw new Error("リプレイ: 選択が要求された位置に確認応答が記録されています（操作列と記録がズレています）");
  }
  if (!response || response.selectedIndexes === null) {
    return null; // キャンセル（min===0 の任意選択の辞退を含む）
  }
  // choiceIndex は候補配列内の添字。同じシード＝同じ候補列なので添字で確実に一致する。
  const normalized = (candidates || []).map((candidate, index) => ({ ...candidate, choiceIndex: index }));
  return response.selectedIndexes
    .map((choiceIndex) => normalized[choiceIndex])
    .filter((entry) => entry !== undefined);
}

// params を JSON セーフ・秘匿安全に整える。undefined を返さないよう空オブジェクトへ丸める。
function replaySafeParams(params) {
  if (params == null) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(params));
  } catch {
    return {};
  }
}

// ==========================================================================
// B3: 確認（真偽値）の記録・再生フック
// ローカル対戦の確認（ソウルガードを使うか等）は chooseCardEntries seam を通らず window.confirm や
// 専用ダイアログに落ちるため、選択とは別種の応答として同じ記録キュー(promptResponses/setupResponses)に
// 順序どおり載せる。決定論エンジンなので「確認」と「選択」の発生順は記録・再生で必ず一致し、
// 種別タグ（confirm / selectedIndexes）でズレを即検出できる。確認UI自体は変えない（挙動不変）。
// ==========================================================================

// 確認応答（真偽値）を記録する。記録オフなら素通し（answer をそのまま返す）。
function replayRecordConfirm(answer) {
  if (!replaySession) {
    return answer;
  }
  const response = { confirm: Boolean(answer) };
  if (replayCurrentStep) {
    replayCurrentStep.promptResponses.push(response);
  } else {
    replaySession.setupResponses.push(response);
  }
  return answer;
}

// 再生中に確認が要求された時、記録済みの真偽値を1つ取り出して返す。
// 応答が尽きた/種別が違えば明確に失敗させる（黙って別の対戦にならないよう即エラー化）。
function replayNextConfirm() {
  if (!replayPlaybackQueue) {
    throw new Error("リプレイ: 再生キューが無い状態で確認が要求されました");
  }
  if (replayPlaybackQueue.length === 0) {
    throw new Error("リプレイ: 記録された応答が不足しています（確認の回数が操作列と一致しません）");
  }
  const response = replayPlaybackQueue.shift();
  if (!response || !Object.prototype.hasOwnProperty.call(response, "confirm")) {
    throw new Error("リプレイ: 確認が要求された位置に選択応答が記録されています（操作列と記録がズレています）");
  }
  return Boolean(response.confirm);
}

// ==========================================================================
// B3: ローカル対戦の記録配線（既定オフ・フラグでオン。オフ時はオーバーヘッド実質ゼロ）
// 権威サーバは engine-host.applyAction が step 境界を刻むが、ローカルUIは実操作経路を直接呼ぶため
// 境界が無い。ここで実操作関数を薄く包み、記録有効時のみ「1操作=1step」として刻む。
// 既存関数のシグネチャは変えない（包んだ関数も同じ引数・戻り値。sync/async どちらも保つ）。
// 入れ子呼び出し（効果解決中の内部 endTurn 等）は最外の1回だけ刻む（replayCurrentStep ガード）。
// ==========================================================================

let replayLocalEnabled = false;
let replayLocalInstalled = false;

function replayLocalRecordingEnabled() {
  return replayLocalEnabled;
}

// ローカル記録の ON/OFF。ON にすると（install 済みなら）以降の実操作が step として記録される。
function replaySetLocalRecording(enabled) {
  replayLocalEnabled = Boolean(enabled);
}

// 実操作の種別名 → engine-host.applyAction の dispatch と同じ type 文字列（再生を同経路に載せるため）。
const REPLAY_LOCAL_ACTION_TYPES = {
  drawAction: "draw",
  chargeAction: "charge",
  goMainPhase: "main",
  goAttackPhase: "attackPhase",
  goFinalPhase: "finalPhase",
  useCardAction: "use",
  attackAction: "attack",
  endTurn: "endTurn",
  partnerCall: "buddy",
  toggleLinkAttacker: "link",
  resolvePendingResolution: "resolve",
  toggleCounterHand: "counterHand",
  callMonster: "call",
};

// 実行時の live state / DOM から操作入力を採取する（engine-host.applyAction が params として受ける形に揃える）。
function replayCaptureLocalParams(type, args) {
  const params = {};
  if (typeof state !== "undefined" && state && state.selected != null) {
    params.selected = deepClone(state.selected);
  }
  const at = typeof elements !== "undefined" && elements.attackTarget ? elements.attackTarget.value : "";
  const et = typeof elements !== "undefined" && elements.effectTarget ? elements.effectTarget.value : "";
  if (at) params.attackTarget = at;
  if (et) params.effectTarget = et;
  if (type === "call") {
    params.callZone = args[0];
  }
  return params;
}

// 記録すべき主体席を state から推定する（宛先ではなく能動席。engine-host は明示 seat を受けるがローカルは無い）。
function replayInferLocalSeat() {
  if (typeof state === "undefined" || !state) return null;
  if (state.pendingAttack) return state.counterHandOwner ?? state.pendingAttack.defender;
  if (state.pendingAction) return state.pendingAction.responder;
  return state.active;
}

// 実操作関数を step 境界で包む。記録オフ / セッション未開始 / 入れ子内なら素通し（境界を足さない）。
function replayWrapLocalAction(name, fn) {
  const type = REPLAY_LOCAL_ACTION_TYPES[name] || name;
  return function replayLocalWrapped(...args) {
    if (!replayLocalEnabled || !replaySession || replayCurrentStep) {
      return fn.apply(this, args);
    }
    replayBeginStep(replayInferLocalSeat(), type, replayCaptureLocalParams(type, args));
    let result;
    try {
      result = fn.apply(this, args);
    } catch (error) {
      replayEndStep();
      throw error;
    }
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          replayEndStep();
          return value;
        },
        (error) => {
          replayEndStep();
          throw error;
        },
      );
    }
    replayEndStep();
    return result;
  };
}

// ローカル実操作のグローバル束縛を包んだ版へ差し替える（idempotent）。ローカル(index.html)専用。
// 権威版=engine-host が境界を刻む／テスト=seam直叩き／thin=ローカル操作しないため、そちらでは呼ばない。
// src/23 は最後にロードされるので、ここで包むと以降の全クリック（遅延束縛のハンドラ）が包み後を呼ぶ。
function replayInstallLocalStepBoundaries() {
  if (replayLocalInstalled) return;
  replayLocalInstalled = true;
  const g = globalThis;
  for (const name of Object.keys(REPLAY_LOCAL_ACTION_TYPES)) {
    if (typeof g[name] === "function") {
      g[name] = replayWrapLocalAction(name, g[name]);
    }
  }
}

// ==========================================================================
// B3: ブラウザ用リプレイ再生ドライバ（replay.html から使う）
// engine-host の replayGame(Node) 相当を、ブラウザのグローバル（newGame / 各実操作 / elements /
// deckProfiles）で行う。1 step ずつ進められるステッパを返す（「最初から」「1ステップ」「最後まで」UI用）。
// 記録の seam 応答は各 step の直前に再生キューへ載せ、chooseCardEntries / confirmChoiceAsync が消費する。
// ==========================================================================

// 記録内のカスタムデッキを deckProfiles へ注入する（プリセットのみの記録では customDecks は空）。
function replayInjectCustomDecks(customDecks) {
  if (!Array.isArray(customDecks) || customDecks.length === 0) return;
  if (typeof deckProfiles === "undefined" || !Array.isArray(deckProfiles)) return;
  for (const deck of customDecks) {
    if (!deck || !deck.id) continue;
    if (deckProfiles.some((profile) => profile.id === deck.id)) continue;
    try {
      deckProfiles.push(normalizeDeckProfile(deck, { id: "custom", name: "ユーザー作成デッキ" }));
    } catch {
      /* 正規化できないデッキは無視（再生は失敗するが、握り潰さず後段で明確に落ちる） */
    }
  }
}

// 1 step を再生適用する（engine-host.applyAction の dispatch と同形。params を live state/DOM へ再注入）。
async function replayApplyStep(step) {
  const params = step.params || {};
  if (Object.prototype.hasOwnProperty.call(params, "selected")) {
    state.selected = params.selected ?? null;
  }
  if (elements && elements.attackTarget) {
    elements.attackTarget.value = Object.prototype.hasOwnProperty.call(params, "attackTarget")
      ? params.attackTarget ?? ""
      : "";
  }
  if (elements && elements.effectTarget) {
    elements.effectTarget.value = Object.prototype.hasOwnProperty.call(params, "effectTarget")
      ? params.effectTarget ?? ""
      : "";
  }
  switch (step.type) {
    case "draw":
      return drawAction();
    case "charge":
      return chargeAction();
    case "main":
      return goMainPhase();
    case "attackPhase":
      return goAttackPhase();
    case "finalPhase":
      return goFinalPhase();
    case "call":
      return callMonster(params.callZone);
    case "use":
      return useCardAction();
    case "attack":
      return attackAction();
    case "endTurn":
      return endTurn();
    case "buddy":
      return partnerCall();
    case "link":
      return toggleLinkAttacker();
    case "resolve":
      return resolvePendingResolution();
    case "counterHand":
      return toggleCounterHand();
    default:
      throw new Error(`リプレイ: 未知のアクション種別: ${step.type}`);
  }
}

// recording を食わせてブラウザ上で 1 step ずつ再生するステッパを作る。
// 返り値: { reset, stepOnce, runToEnd, total, atEnd, currentIndex }。いずれも再生キューを毎 step 入替。
function replayCreatePlayer(recording) {
  if (!recording || typeof recording !== "object") {
    throw new Error("リプレイ: recording が不正です");
  }
  const steps = Array.isArray(recording.steps) ? recording.steps : [];
  let index = 0;
  let started = false;

  const drain = (label) => {
    const remaining = replayPlaybackRemaining();
    if (remaining > 0) {
      throw new Error(`リプレイ: ${label} で記録された応答が余りました（${remaining}件・記録過多）`);
    }
  };

  async function reset() {
    // 記録が持ち回るカスタムデッキを注入 → デッキ選択を記録どおりに合わせる。
    replayInjectCustomDecks(recording.customDecks);
    applyDeckValues(recording.deckIds || []);
    // newGame(配牌)中の選択（通常空）も監視して想定外の選択要求を即検出する。
    replaySetPlaybackQueue(recording.setupResponses || []);
    newGame({ seed: recording.seed, firstSeat: recording.firstSeat });
    drain("newGame(setup)");
    replayClearPlayback();
    index = 0;
    started = true;
    render();
  }

  async function stepOnce() {
    if (!started) {
      await reset();
    }
    if (index >= steps.length) {
      return false;
    }
    const step = steps[index];
    replaySetPlaybackQueue(step.promptResponses || []);
    try {
      await replayApplyStep(step);
      drain(`step#${index}(${step.type})`);
    } finally {
      replayClearPlayback();
    }
    index += 1;
    render();
    return true;
  }

  async function runToEnd() {
    if (!started) {
      await reset();
    }
    // 1 step ずつ順に流す（await が必要なので逐次）。
    let progressed = true;
    while (index < steps.length && progressed) {
      progressed = await stepOnce();
    }
  }

  return {
    reset,
    stepOnce,
    runToEnd,
    total: steps.length,
    atEnd: () => index >= steps.length,
    currentIndex: () => index,
  };
}

// ローカル(index.html)でのみ、実操作経路を step 境界で包む。src/23 は最後にロードされるため、
// ここで包めば src/21 で登録済みの全ハンドラ（遅延束縛）が以降のクリックで包み後を呼ぶ。
// 権威版(engine-host が境界担当) / thin(ローカル操作なし) / テスト(seam直叩き) では包まない。
if (
  !globalThis.__BUDDYFIGHT_SERVER__ &&
  !globalThis.__BUDDYFIGHT_TEST__ &&
  !globalThis.__BUDDYFIGHT_THIN__ &&
  !globalThis.__BUDDYFIGHT_REPLAY__
) {
  replayInstallLocalStepBoundaries();
}

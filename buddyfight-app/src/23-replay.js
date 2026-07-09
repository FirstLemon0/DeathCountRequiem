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
// 応答が尽きたら明確に失敗させる（黙って別の対戦にならないよう、取りこぼしを即エラーにする）。
function replayNextSelection(candidates) {
  if (!replayPlaybackQueue) {
    throw new Error("リプレイ: 再生キューが無い状態で選択が要求されました");
  }
  if (replayPlaybackQueue.length === 0) {
    throw new Error("リプレイ: 記録された応答が不足しています（操作列と選択回数が一致しません）");
  }
  const response = replayPlaybackQueue.shift();
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

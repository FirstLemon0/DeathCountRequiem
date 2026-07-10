// ==========================================================================
// buddyfight モジュール 24 — 戦績・対戦履歴（デッキ別勝率）(D5)
// 全モジュールはグローバルスコープを共有し、HTML で番号順に <script> 読み込みする。
//
// 決着は state.winner（プレイヤー名文字列）で表すが、名前はデッキと紐付かない。そこで勝者設定サイト
// （checkWinner / declareDeckLoss / チェックメイト(src/10) / winGame(src/15) / ライフリンク即死(src/11)）が
// 揃って state.winnerSeat / state.winReason を刻み、使用デッキは newGame(src/03) が state.deckIds に控える。
// このモジュールは「決着済み・巻き戻し余地なしの整合局面」で一度だけ state.matchResult を確定させる
// 単一フック matchRecordCheckpoint を提供する。ライフリンク相殺 clearWinnerIfNoCurrentLoss(src/11) で
// winner が null に戻り得るため、pending リゾルブ中は確定しない。二重発火は state.matchResult で冪等化する。
//
// フックは render(src/12) 末尾（ローカル）と engine-host.applyAction 末尾（権威サーバ）から呼ばれる。
// どの勝利経路（ライフ0 / デッキ切れ / 効果 / チェックメイト）も最終的に render/applyAction を通るため、
// 呼び出し口が1つに集約され取りこぼさない。
//
// 【セキュリティ】戦績レコードには seed も member.token も入れない。seed は決着後のみ公開のリプレイ側に既にあり、
// 戦績は一覧APIで他人に見え得るため、進行中対戦の seed を戦績経由で漏らさない。勝敗はサーバが state から判定し、
// クライアント申告（POST /auth/matches の outcome）は権威記録(source:"server")を上書きできない（user-store 側で担保）。
// ==========================================================================

const MATCH_HISTORY_KEY = "buddyfight.matchHistory.v1"; // ゲームデータ流儀（ドット＋バージョン）
const MATCH_HISTORY_LIMIT = 200; // ローカル保持上限（古いものから捨てる）
const MATCH_RECENT_SHOWN = 20; // パネルの直近一覧の表示件数

// 決着理由。カード名はハードコードしない（勝者設定サイトが刻む汎用タグのみを受ける）。
const MATCH_REASONS = ["life", "deckout", "effect", "checkmate", "forfeit"];
const MATCH_REASON_LABELS = {
  life: "ライフ0",
  deckout: "デッキ切れ",
  effect: "効果",
  checkmate: "チェックメイト",
  forfeit: "投了",
  unknown: "—",
};

// 決着レコードのシンク（ローカル=localStorage、サーバ=未登録で state.matchResult を外部から読む）。
let matchResultSink = null;
function matchSetResultSink(fn) {
  matchResultSink = typeof fn === "function" ? fn : null;
}

// state から決定論的な戦績レコードを組む。seed / token / fightId / 壁時計は含めない
// （再生の deep-equal を壊さないため。fightId・時刻は外側のシンクで付与する）。
function matchBuildResult() {
  if (!state || state.winner == null) {
    return null;
  }
  const winnerSeat = Number.isInteger(state.winnerSeat) ? state.winnerSeat : null;
  if (winnerSeat !== 0 && winnerSeat !== 1) {
    return null;
  }
  const loserSeat = 1 - winnerSeat;
  const deckIds = Array.isArray(state.deckIds) ? state.deckIds : [];
  const reason = MATCH_REASONS.includes(state.winReason) ? state.winReason : "unknown";
  return {
    winnerSeat,
    loserSeat,
    reason,
    firstSeat: Number.isInteger(state.firstSeat) ? state.firstSeat : null,
    turnCount: Number.isInteger(state.turnCount) ? state.turnCount : 0,
    deckIds: [deckIds[0] ?? null, deckIds[1] ?? null],
  };
}

// 決着を検知して state.matchResult を一度だけ確定させる単一フック。
// 戻り値は「今回新たに確定した決定論 result」or null（冪等）。
function matchRecordCheckpoint() {
  if (!state || state.matchResult) {
    return null; // 冪等（既に確定済み）
  }
  if (state.winner == null) {
    return null; // 未決着
  }
  // 巻き戻し余地（ライフリンク相殺の対抗窓等）が残る間は確定しない＝整合した終局のみ拾う。
  if (typeof hasPendingResolution === "function" && hasPendingResolution()) {
    return null;
  }
  if (state.resolvingPending) {
    return null;
  }
  const result = matchBuildResult();
  if (!result) {
    return null;
  }
  state.matchResult = result;
  if (matchResultSink) {
    // fightId / finishedAt / replayId は state 外で付与する（決定論を壊さない）。
    const record = {
      fightId: state.fightId || null,
      finishedAt: Date.now(),
      replayId: null,
      ...result,
      winnerDeckId: result.deckIds[result.winnerSeat] ?? null,
      loserDeckId: result.deckIds[result.loserSeat] ?? null,
    };
    try {
      matchResultSink(record);
    } catch (error) {
      /* シンク失敗は対戦進行を止めない */
    }
  }
  return result;
}

// 投了（オンライン対戦での退出/切断による強制決着）。退出者=loserSeat の相手を勝者に確定させ、
// 決着フック matchRecordCheckpoint まで走らせて state.matchResult を刻む（権威サーバはこれを読んで D5 戦績に記録する）。
// 通常の決着（checkWinner 等）と違い、対抗窓(pendingAttack/pendingAction)が開いていても不可逆に即終局させる
// ＝残したままだと matchRecordCheckpoint の pending ガードに弾かれて戦績が欠落するため、先に畳んでから確定する。
// winner(名前) と winnerSeat(席) は必ず単一の loserSeat から導出し、名前↔席のズレ（戦績のデッキ紐付けが壊れる）を構造的に防ぐ。
function matchDeclareForfeit(loserSeat) {
  if (!state || state.winner != null) {
    return null; // 既に決着していれば投了は無効（勝者を書き換えない＝二重決着を防ぐ）
  }
  const loser = Number(loserSeat);
  if (loser !== 0 && loser !== 1) {
    return null;
  }
  const winnerSeat = 1 - loser;
  const winnerName = state.players?.[winnerSeat]?.name;
  if (!winnerName) {
    return null;
  }
  // 投了は不可逆。開いていた対抗窓・解決中フラグを畳んでから確定させる（畳まないと pending ガードで戦績が載らない）。
  state.pendingAttack = null;
  state.pendingAction = null;
  state.resolvingPending = false;
  state.winner = winnerName;
  state.winnerSeat = winnerSeat; // ← winnerName と同じ winnerSeat から導出＝名前↔席は必ず整合する
  state.winReason = "forfeit";
  if (typeof addLog === "function") {
    addLog(`${winnerName}の勝利です（相手の退出による投了）。`);
  }
  return matchRecordCheckpoint();
}

// ---- 集計（純粋関数。パネルとスモークで共用） --------------------------------------------------

// 履歴からデッキ別の勝敗数・勝率を集計する。ミラー戦（勝者=敗者デッキが同一）は同デッキに勝1敗1が付く。
function matchComputeDeckStats(history) {
  const map = new Map();
  const bucket = (deckId) => {
    const key = deckId == null ? "__unknown__" : String(deckId);
    if (!map.has(key)) {
      map.set(key, { deckId: deckId ?? null, wins: 0, losses: 0 });
    }
    return map.get(key);
  };
  for (const rec of Array.isArray(history) ? history : []) {
    if (rec.winnerDeckId !== undefined) {
      bucket(rec.winnerDeckId).wins += 1;
    }
    if (rec.loserDeckId !== undefined) {
      bucket(rec.loserDeckId).losses += 1;
    }
  }
  const rows = [...map.values()].map((row) => {
    const total = row.wins + row.losses;
    return { ...row, total, winRate: total > 0 ? row.wins / total : 0 };
  });
  // 対戦数の多い順→勝率の高い順で安定に並べる。
  rows.sort((a, b) => b.total - a.total || b.winRate - a.winRate);
  return rows;
}

// ---- ローカル（localStorage）シンク --------------------------------------------------------------

function matchLoadLocalHistory() {
  try {
    const raw = localStorage.getItem(MATCH_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (error) {
    return [];
  }
}

function matchSaveLocalHistory(list) {
  try {
    localStorage.setItem(MATCH_HISTORY_KEY, JSON.stringify(list.slice(-MATCH_HISTORY_LIMIT)));
  } catch (error) {
    /* localStorage 不可環境は無視 */
  }
}

// ローカルの「自分」席。CPU対戦なら人間席、ホットシート(人間同士)は P1 を自分とみなす（サーバ同期の近似）。
function matchSelfSeat() {
  if (typeof aiEnabled === "function" && aiEnabled() && typeof aiHumanSeat === "function") {
    const seat = aiHumanSeat();
    if (seat === 0 || seat === 1) {
      return seat;
    }
  }
  return 0;
}

function matchLocalSink(record) {
  const list = matchLoadLocalHistory();
  list.push(record); // ローカルは両席デッキ入りの対称レコードを保持（パネルは勝者/敗者の両デッキを出す）
  matchSaveLocalHistory(list);
  // ログイン中ならサーバへも記録（best-effort・source:"client"。権威記録 source:"server" は上書きしない）。
  // サーバは席=自分の視点で集計するため、自分席の勝敗・デッキへ射影して送る。
  if (typeof userRecordMatch === "function") {
    const self = matchSelfSeat();
    const deckIds = Array.isArray(record.deckIds) ? record.deckIds : [null, null];
    try {
      // 非同期(fetch)。同期例外も非同期リジェクトも握り、ローカル記録・対戦進行に影響させない。
      const pending = userRecordMatch({
        fightId: record.fightId,
        finishedAt: record.finishedAt,
        outcome: self === record.winnerSeat ? "win" : "loss",
        reason: record.reason,
        firstSeat: record.firstSeat,
        turnCount: record.turnCount,
        deckId: deckIds[self] ?? null,
        opponentDeckId: deckIds[1 - self] ?? null,
        replayId: record.replayId ?? null,
      });
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => {});
      }
    } catch (error) {
      /* サーバ同期の失敗はローカル記録に影響させない */
    }
  }
  matchRefreshPanel(); // 開いていれば最新化
}

// ---- 戦績パネル（index.html。ローカル対戦専用の閲覧UI） ----------------------------------------

function matchDeckLabel(deckId) {
  if (deckId == null) {
    return "（不明なデッキ）";
  }
  const profiles = typeof deckProfiles !== "undefined" && Array.isArray(deckProfiles) ? deckProfiles : [];
  const found = profiles.find((deck) => deck.id === deckId);
  return found ? found.name : String(deckId);
}

function matchReasonLabel(reason) {
  return MATCH_REASON_LABELS[reason] || MATCH_REASON_LABELS.unknown;
}

function matchFormatTime(ms) {
  if (!ms) {
    return "";
  }
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// パネルが開いていれば中身を再描画する（未マウント環境では何もしない）。
function matchRefreshPanel() {
  const dialog = typeof document !== "undefined" ? document.getElementById("matchHistoryDialog") : null;
  if (!dialog || !dialog.open) {
    return;
  }
  matchRenderPanel();
}

function matchRenderPanel() {
  if (typeof document === "undefined") {
    return;
  }
  const statsBody = document.getElementById("matchStatsBody");
  const recentBody = document.getElementById("matchRecentBody");
  const empty = document.getElementById("matchHistoryEmpty");
  if (!statsBody || !recentBody) {
    return;
  }
  const history = matchLoadLocalHistory();
  if (empty) {
    empty.hidden = history.length > 0;
  }
  // デッキ別集計テーブル。
  const stats = matchComputeDeckStats(history);
  statsBody.innerHTML = "";
  for (const row of stats) {
    const tr = document.createElement("tr");
    const pct = row.total > 0 ? `${Math.round(row.winRate * 100)}%` : "—";
    const cells = [matchDeckLabel(row.deckId), String(row.wins), String(row.losses), pct];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i > 0) {
        td.className = "match-num";
      }
      tr.append(td);
    });
    statsBody.append(tr);
  }
  // 直近N戦（新しい順）。
  recentBody.innerHTML = "";
  const recent = history.slice(-MATCH_RECENT_SHOWN).reverse();
  for (const rec of recent) {
    const li = document.createElement("li");
    li.className = "match-recent-item";
    const winName = matchDeckLabel(rec.winnerDeckId);
    const loseName = matchDeckLabel(rec.loserDeckId);
    const meta = `${matchReasonLabel(rec.reason)}・${rec.turnCount || 0}ターン・${matchFormatTime(rec.finishedAt)}`;
    const head = document.createElement("div");
    head.className = "match-recent-head";
    head.textContent = `${winName} ○ 対 ● ${loseName}`;
    const sub = document.createElement("div");
    sub.className = "match-recent-sub";
    sub.textContent = meta;
    li.append(head, sub);
    recentBody.append(li);
  }
}

function matchOpenPanel() {
  const dialog = document.getElementById("matchHistoryDialog");
  if (!dialog) {
    return;
  }
  matchRenderPanel();
  if (dialog.showModal) {
    dialog.showModal();
  }
}

// ローカル(index.html)の実対戦でのみシンク登録＋パネル配線する。
// 権威版(engine-host が state.matchResult を外部で読む) / thin(ローカル対戦なし) /
// テスト(フック直叩き) / リプレイ再生(記録しない) では登録しない。
if (
  !globalThis.__BUDDYFIGHT_SERVER__ &&
  !globalThis.__BUDDYFIGHT_TEST__ &&
  !globalThis.__BUDDYFIGHT_THIN__ &&
  !globalThis.__BUDDYFIGHT_REPLAY__
) {
  matchSetResultSink(matchLocalSink);
  if (typeof document !== "undefined") {
    document.getElementById("matchHistoryButton")?.addEventListener("click", matchOpenPanel);
    document.getElementById("closeMatchHistoryButton")?.addEventListener("click", () => {
      document.getElementById("matchHistoryDialog")?.close();
    });
    document.getElementById("matchHistoryDialog")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        event.currentTarget.close(); // 背景タップで閉じる（他ダイアログと挙動統一）
      }
    });
  }
}

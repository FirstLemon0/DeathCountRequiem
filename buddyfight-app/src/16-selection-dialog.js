// ==========================================================================
// buddyfight モジュール 16 — カード選択ダイアログ
// 旧 app.js L9192-9478 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
// 選択ダイアログの「盤面確認」中は、盤面カードをタップして詳細（閲覧専用シート）だけ見られるようにする。
// dialog.showModal() は背後の文書を inert にするため、モーダルのままだと盤面が見えてもタップできない。
// 盤面確認中だけ非モーダル(show)へ切り替え、各クライアントのタップ配線はこのフラグを見て
// 「詳細を開くだけ・盤面操作はしない」に落とす。
let selectionBoardInspect = false;
function isBoardInspectMode() {
  return selectionBoardInspect;
}

// スマホ: 選択は非モーダルのドック（画面下）で出し、盤面の候補札を光らせて盤面タップでも選べるようにする。
// 開いている間だけ { pick(owner, zone) } を持つ。各クライアントの盤面タップ配線が最初に selectionDockPick を呼ぶ。
let selectionDockState = null;
function selectionDockPick(owner, zone) {
  return Boolean(selectionDockState && selectionDockState.pick(owner, zone));
}

// pt-final(4): 配置魔法パイル（設置魔法 set1..setN をまとめた枠）のタップ。ドックの候補に設置魔法があれば、
// 1枚ならそれを選び、複数なら一覧（下部メニュー）から選ばせる。候補が無ければ false。
function selectionDockPickSet(owner) {
  return Boolean(selectionDockState?.pickSet && selectionDockState.pickSet(owner));
}

// 候補の札が盤面（レフト/センター/ライト/アイテム枠）にあれば、その所在を返す（無ければ null）。
function selectionBoardLocation(candidate) {
  const instanceId = candidate?.card?.instanceId;
  if (!instanceId || !Array.isArray(state?.players)) {
    return null;
  }
  for (let owner = 0; owner < state.players.length; owner += 1) {
    const field = state.players[owner]?.field || {};
    for (const zone of ["left", "center", "right", ...itemZones]) { // pt-fix-c T7-4: item5 以降も
      if (field[zone]?.instanceId === instanceId) {
        return { owner, zone, domZone: zone.startsWith("item") ? "item" : zone };
      }
    }
    // pt-final(4): 設置魔法は「配置魔法」パイル（data-zone="setpile"）にまとめて表示される。
    for (const zone of setZones) {
      if (field[zone]?.instanceId === instanceId) {
        return { owner, zone, domZone: "setpile" };
      }
    }
  }
  return null;
}

async function chooseDeckCardIndex(player, predicate, title) {
  const candidates = player.deck
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => predicate(card));
  if (candidates.length === 0) {
    return -1;
  }
  if (candidates.length === 1) {
    return candidates[0].index;
  }
  const selected = await chooseCardEntries(candidates, {
    title,
    lead: "デッキから1枚選んでください。選んだ後、デッキはシャッフルされます。",
    min: 1,
    max: 1,
    // 権威サーバ: デッキ検索は検索する本人の席へ往復させる（cross-seat 誤配送防止）。
    promptSeat: state.players.indexOf(player),
  });
  return selected?.[0]?.index ?? -1;
}

// B2: リプレイの記録・再生はこの seam を通す。プロンプト応答（選択ダイアログ・じゃんけん・確認）は
// すべて chooseCardEntries に集約されているため、ここ1箇所でローカルUI・CPU・権威サーバ・60秒タイムアウト
// 自動確定の全経路を同形で捕捉/再現できる（HTTP 層ではなくエンジン seam で扱う理由）。
// - 再生中: 記録された選択をそのまま返し、本体（Impl）は実行しない。
// - 記録中: 本体の戻り値（＝実際に確定した選択）を返る直前に記録する。
// - 記録も再生もオフの時は関数呼び出し2回ぶんだけで素通し（オーバーヘッド実質ゼロ）。
// R1: 順序配信。記録/再生中は、応答枠を「要求時に開いている step」へ確保し、配信を
// 要求順・macrotask 境界に揃える（src/23 replayReservePrompt/replayDeliverPrompt）。追跡オフなら ticket=null で従来経路。
async function chooseCardEntries(candidates, options = {}) {
  if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
    return replayPlaybackSelectionAsync(candidates);
  }
  const replayTicket = typeof replayReservePrompt === "function" ? replayReservePrompt() : null;
  if (replayTicket) {
    return replayDeliverPrompt(replayTicket, chooseCardEntriesImpl(candidates, options), replaySelectionResponse);
  }
  const result = await chooseCardEntriesImpl(candidates, options);
  if (typeof replayIsRecording === "function" && replayIsRecording()) {
    replayRecordSelection(result);
  }
  return result;
}

async function chooseCardEntriesImpl(candidates, options = {}) {
  const normalized = (candidates || []).map((candidate, index) => ({
    ...candidate,
    choiceIndex: index,
  }));
  const choiceBase = {
    title: options.title || "カード選択",
    lead: options.lead || "",
    min: options.min,
    max: options.max,
    forceDialog: Boolean(options.forceDialog),
    candidateCount: normalized.length,
    candidates: normalized.map(compactChoiceForLog),
  };
  if (normalized.length === 0) {
    recordDiagnosticEvent("choice", {
      ...choiceBase,
      result: "no_candidates",
      selected: [],
    });
    return [];
  }
  const min = options.min ?? Math.min(1, normalized.length);
  const max = Math.min(options.max ?? min, normalized.length);
  if (!options.forceDialog && normalized.length === 1 && min === 1 && max === 1) {
    recordDiagnosticEvent("choice", {
      ...choiceBase,
      min,
      max,
      result: "auto_single",
      selected: [compactChoiceForLog(normalized[0])],
    });
    return [normalized[0]];
  }
  // E-XB6(X-SS03/0012 カリスマジック): faceDown 指定時は候補の正体を伏せた提示用ビューを作る
  // （相手のブラインド選択・T13＝余計な公開情報を渡さない）。選択の解決は choiceIndex（提示順の位置）で
  // 行うため、正体を隠しても正しく実カード（normalized）へ写像できる。未指定＝presented===normalized で不変。
  const presented = options.faceDown ? normalized.map(maskChoiceFaceDown) : normalized;
  let selected;
  if (globalThis.__BUDDYFIGHT_SERVER__ && typeof globalThis.__serverPrompt === "function") {
    // 権威サーバ: 該当クライアントへ選択を往復で問い合わせる（DOMダイアログは使わない）。
    const response = await globalThis.__serverPrompt({
      // 対抗窓改修: 誘発/ライフリンクの対抗窓は非モーダルのバーで受ける別種（play.js が kind で分岐）。
      kind: options.counterWindow ? "counterWindow" : "selection",
      ...(options.counterWindow ? { counterWindow: compactCounterWindowInfo(options.counterWindowInfo) } : {}),
      targetSeat: options.promptSeat,
      title: choiceBase.title,
      lead: choiceBase.lead,
      min,
      max,
      allowCancel: options.allowCancel !== false,
      searchable: Boolean(options.searchable),
      candidates: presented.map((candidate) => ({
        index: candidate.choiceIndex,
        ...compactChoiceForLog(candidate),
      })),
    });
    selected = resolveServerSelection(response, normalized, min, max, options.allowCancel !== false);
  } else if (typeof aiShouldAnswerPrompt === "function" && aiShouldAnswerPrompt(options.promptSeat)) {
    // CPU対戦: promptSeat がCPU席の選択は src/22-ai.js が答える（ダイアログは出さない）。
    selected = await aiAnswerSelection(presented, { ...options, min, max });
  } else if (options.counterWindow) {
    // 対抗窓改修: 人間席の対抗窓は非モーダルのバー（src/12 showCounterWindowBar）。バーを出せない環境
    // （ヘッドレステスト等）はテスト用フック → 無ければ「パス」（window.prompt の応答キューを消費しない）。
    selected = await answerCounterWindowLocally(presented, options);
  } else if (!canShowSelectionDialog()) {
    selected = fallbackCardEntrySelection(presented, { ...options, min, max });
  } else {
    selected = await showCardSelectionDialog(presented, { ...options, min, max });
  }
  // E-XB6: faceDown 提示で AI/ダイアログ/フォールバックが返したマスク entry を、choiceIndex で
  // 実 entry（normalized）へ戻す（server 経路は resolveServerSelection が既に normalized を返すため恒等）。
  if (options.faceDown && Array.isArray(selected)) {
    selected = selected.map(
      (entry) => normalized.find((real) => real.choiceIndex === entry.choiceIndex) || entry,
    );
  }
  // T2: 強制選択（allowCancel:false・min≥1）で取り消し(null)が返ってきた場合の安全網（UI/経路の取りこぼし対策）。
  // 権威サーバ(resolveServerSelection)・CPU と同じ「先頭 min 枚を既定採用」に揃え、null を呼び出し側へ漏らさない。
  if (selected === null && options.allowCancel === false && min > 0) {
    selected = normalized.slice(0, min);
  }
  recordDiagnosticEvent("choice", {
    ...choiceBase,
    min,
    max,
    result: selected === null ? "cancelled" : "selected",
    selected: (selected || []).map(compactChoiceForLog),
  });
  return selected;
}

// 対抗窓改修: ローカル（非サーバ・非CPU席）の対抗窓の答え。テスト用フック __counterWindowTestAnswer(entries, options)
// （候補 index か null を返す）→ ブラウザの非モーダルバー → どちらも無ければパス（候補0）。
async function answerCounterWindowLocally(presented, options) {
  if (typeof globalThis.__counterWindowTestAnswer === "function") {
    const index = await globalThis.__counterWindowTestAnswer(presented, options);
    const entry = presented.find((candidate) => candidate.choiceIndex === index);
    return entry ? [entry] : null;
  }
  if (typeof showCounterWindowBar === "function" && counterWindowBarAvailable()) {
    return showCounterWindowBar(presented, options);
  }
  return [presented[0]];
}

// 権威サーバの prompt_request に載せる窓の公開情報（候補は別途 candidates で応答席にだけ届く）。
function compactCounterWindowInfo(info = {}) {
  return {
    kind: info.kind || "trigger",
    sourceName: info.sourceName || "",
    sourceInstanceId: info.sourceInstanceId || null,
    responder: info.responder ?? null,
    windowId: info.windowId || null,
  };
}

// E-XB6(X-SS03/0012 カリスマジック): 裏向き選択の提示用に候補の正体を全て伏せる。
// choiceIndex（提示順の位置）だけを残し、名前/番号/属性/スタッツ/instanceId/ゾーン/索引・所有者は隠す。
// 選択の解決は choiceIndex で実 entry へ写像するため、表示だけ伏せれば実処理は正しく進む。
function maskChoiceFaceDown(choice) {
  return {
    choiceIndex: choice.choiceIndex,
    index: null,
    owner: null,
    zone: null,
    note: "裏向きのカード",
    card: {
      id: null,
      instanceId: null,
      no: "",
      name: "裏向きのカード",
      type: "monster",
      currentType: "monster",
      world: "",
      attributes: [],
      size: null,
      power: null,
      critical: null,
      defense: null,
      used: false,
      soul: [],
    },
  };
}

// 権威サーバのプロンプト応答(selectedIndexes)を実候補entryへ再マップする。
// 未応答(null)時は、キャンセル可ならnull、必須なら先頭min枚を既定採用（不正応答も補完）。
function resolveServerSelection(response, normalized, min, max, allowCancel) {
  if (!response || !Array.isArray(response.selectedIndexes)) {
    return allowCancel ? null : normalized.slice(0, min);
  }
  const picked = [];
  for (const index of response.selectedIndexes) {
    const entry = normalized.find((candidate) => candidate.choiceIndex === index);
    if (entry && !picked.includes(entry)) {
      picked.push(entry);
    }
  }
  for (const candidate of normalized) {
    if (picked.length >= min) break;
    if (!picked.includes(candidate)) picked.push(candidate);
  }
  return picked.slice(0, Math.max(max, min));
}

function canShowSelectionDialog() {
  return Boolean(
    elements.selectionDialog &&
      elements.selectionDialogTitle &&
      elements.selectionDialogLead &&
      elements.selectionDialogPreview &&
      elements.selectionDialogList &&
      elements.selectionConfirmButton &&
      elements.selectionCancelButton &&
      typeof elements.selectionDialog.showModal === "function",
  );
}

// アプリ内の選択UI（スマホ=ドック／PC=モーダル）を出せるブラウザか。ネイティブの window.confirm/prompt は
// これが無い環境（ヘッドレステスト等の DOM スタブ）だけの互換経路に限る（プレイテスト T8: 対戦中のネイティブ
// ダイアログはスマホで盤面が見えず・UI が浮くため、対戦中の二択/選択は全てアプリ内 UI に統一する）。
function appChoiceUiAvailable() {
  return canShowSelectionDialog() && !globalThis.__BUDDYFIGHT_SERVER__;
}

// 「はい/いいえ」の確認をアプリ内の選択UI（スマホ=ドック・盤面は見えたまま／PC=モーダル）で問う。
// 候補（2択）のタップで即確定。キャンセル不可（どちらかを選ぶ）。戻り値: true=はい。
// 記録/再生・CPU・権威サーバ往復は呼び出し側（confirmChoiceAsync）が従来どおり受け持つ（ここは UI だけ）。
async function showConfirmChoiceDialog(message, options = {}) {
  const choice = (key, name) => ({
    key,
    choiceIndex: key === "yes" ? 0 : 1,
    card: { name, type: "choice", rules: [], attributes: [], keywords: [], costs: {} },
  });
  const selected = await showCardSelectionDialog(
    [choice("yes", options.yesLabel || "はい"), choice("no", options.noLabel || "いいえ")],
    {
      title: message,
      lead: options.lead || "どちらかを選んでください。",
      min: 1,
      max: 1,
      allowCancel: false,
      instantPick: true,
    },
  );
  return selected?.[0]?.key === "yes";
}

function fallbackCardEntrySelection(candidates, options = {}) {
  const min = options.min ?? 1;
  const max = options.max ?? min;
  if (typeof window === "undefined" || typeof window.prompt !== "function") {
    return candidates.slice(0, max);
  }
  const lines = candidates.map(
    ({ card }, index) => `${index + 1}: ${card.name}${card.no ? ` (${card.no})` : ""}`,
  );
  const suffix = max > 1 ? `番号をカンマ区切りで${min}～${max}個入力してください。` : "番号を入力してください。";
  const answer = window.prompt(`${options.title || "カード選択"}\n${lines.join("\n")}\n${suffix}`, "1");
  if (answer === null && min === 0) {
    return [];
  }
  const indexes = String(answer || "")
    .split(",")
    .map((value) => Number(value.trim()) - 1)
    .filter((index, position, list) =>
      Number.isInteger(index) && index >= 0 && index < candidates.length && list.indexOf(index) === position,
    )
    .slice(0, max);
  if (indexes.length < min) {
    return candidates.slice(0, max);
  }
  return indexes.map((index) => candidates[index]);
}

function showCardSelectionDialog(candidates, options = {}) {
  return new Promise((resolve) => {
    const selectedIndexes = new Set();
    const min = options.min ?? 1;
    const max = options.max ?? min;
    const allowCancel = options.allowCancel !== false;
    let settled = false;
    // スマホ（body.bf-game・幅640以下）は非モーダルのドック。PC は従来どおりモーダル。
    const dock = typeof isPhoneLayout === "function" && isPhoneLayout();
    // プレイテスト T7/T8: 攻撃/効果の対象選択（盤面タップ待ち）の途中で選択が開いたら、対象選択の状態・
    // バナー・候補ハイライトを畳む（攻撃時誘発の選択中や防御フェイズまで「攻撃対象をタップ」が残り、
    // バナーのキャンセルがドックのキャンセルと重なって誤タップを招いていた）。シンクライアントは play.js 管轄。
    if (!globalThis.__BUDDYFIGHT_THIN__ && typeof uiTargeting !== "undefined" && uiTargeting) {
      uiTargeting = null;
      if (typeof refreshTargeting === "function") refreshTargeting();
    }
    const openDialog = () => {
      if (dock && typeof elements.selectionDialog.show === "function") {
        elements.selectionDialog.show();
      } else {
        elements.selectionDialog.showModal();
      }
    };
    const boardLocations = new Map(); // choiceIndex → 盤面の所在（スマホのみ）
    let dockEscHandler = null;
    if (dock) {
      const byPlace = new Map();
      candidates.forEach((candidate) => {
        const location = selectionBoardLocation(candidate);
        if (location) {
          const key = `${location.owner}:${location.zone}`;
          byPlace.set(key, [...(byPlace.get(key) || []), [candidate.choiceIndex, location]]);
        }
      });
      // 同じ盤面の札に候補が複数ある（『移動』の行き先違い等）場所は盤面選択の対象にしない（一覧で選ぶ）。
      // 盤面タップで先頭の候補が黙って選ばれるのを防ぐ。
      byPlace.forEach((entries) => {
        if (entries.length === 1) {
          boardLocations.set(entries[0][0], entries[0][1]);
        }
      });
    }
    const clearBoardMarks = () => {
      document.querySelectorAll?.(".selection-candidate, .selection-picked").forEach((element) =>
        element.classList.remove("selection-candidate", "selection-picked"),
      );
    };
    const refreshBoardMarks = () => {
      if (!dock) {
        return;
      }
      clearBoardMarks();
      boardLocations.forEach((location, choiceIndex) => {
        const element = document.querySelector?.(`.zone[data-owner="${location.owner}"][data-zone="${location.domZone}"]`);
        element?.classList.add("selection-candidate");
        if (selectedIndexes.has(choiceIndex)) {
          element?.classList.add("selection-picked");
        }
      });
    };

    // 盤面確認中はモーダル→非モーダルへ切り替える。モーダル(showModal)の間は背後の文書が inert になり、
    // 盤面が見えていてもカードをタップできない（＝詳細が見られない）ため。
    // close() の close イベントは「キューされたタスク」で発火するので、同期で open し直せば
    // 既存の close ハンドラ冒頭の `if (open) return` に吸収され、キャンセル扱いにならない。
    const applyModality = (modal) => {
      const dialog = elements.selectionDialog;
      if (!dialog.open || dock) {
        return; // スマホは最初から非モーダル（盤面確認＝一覧を畳むだけ）
      }
      dialog.close();
      if (modal || typeof dialog.show !== "function") {
        dialog.showModal();
      } else {
        dialog.show();
      }
    };

    // スマホ: 盤面タップで選べる候補がある時の案内。候補の札がドックの下に隠れている（見えている高さが
    // タップできる 44px に満たない）間は「盤面の光る札をタップ」とは言わず、一覧から選ぶ案内にする
    // （プレイテスト T8: アイテム列などがドックに覆われたまま「光る札をタップ」と案内していた）。
    let baseLead = "";
    const boardCandidateCovered = () => {
      const dockRect = elements.selectionDialog.getBoundingClientRect?.();
      if (!dockRect || !dockRect.height) {
        return false;
      }
      const viewBottom = Math.min(dockRect.top, typeof innerHeight === "number" ? innerHeight : dockRect.top);
      for (const location of boardLocations.values()) {
        const element = document.querySelector?.(`.zone[data-owner="${location.owner}"][data-zone="${location.domZone}"]`);
        const rect = element?.getBoundingClientRect?.();
        if (!rect || !rect.height) {
          return true;
        }
        const visible = Math.min(rect.bottom, viewBottom) - Math.max(rect.top, 0);
        if (visible < Math.min(rect.height, 44)) {
          return true;
        }
      }
      return false;
    };
    const updateLeadHint = () => {
      if (!dock || settled || !baseLead) {
        return;
      }
      let hint = "";
      if (boardLocations.size > 0) {
        if (elements.selectionDialog.classList.contains("selection-board-peek")) {
          hint = "（盤面の光る札をタップして選べます）";
        } else if (elements.selectionDialog.open && boardCandidateCovered()) {
          hint = "（下の一覧から選んでください。「盤面で選ぶ」で一覧を畳むと盤面の札もタップできます）";
        } else {
          hint = "（盤面の光る札をタップしても選べます）";
        }
      }
      elements.selectionDialogLead.textContent = baseLead + hint;
      elements.selectionDialog.dataset.boardHint = hint ? (hint.includes("一覧から") ? "list" : "board") : "";
    };

    let boardPeekOn = false;
    const setBoardPeek = (enabled) => {
      elements.selectionDialog.classList.toggle("selection-board-peek", enabled);
      // 早期returnより前に必ず反映（前のダイアログの状態を残さない）。スマホは非モーダルの間ずっと「盤面は見るだけ」
      // （盤面/手札のタップで別の操作を始めさせない。候補札のタップは selectionDockPick が先に拾う）。
      selectionBoardInspect = dock ? !settled : enabled;
      if (elements.selectionBoardButton && dock) {
        const hasBoard = boardLocations.size > 0;
        elements.selectionBoardButton.textContent = enabled ? "一覧で選ぶ" : hasBoard ? "盤面で選ぶ" : "盤面を見る";
        elements.selectionBoardButton.title = enabled ? "候補の一覧を開く" : "一覧を畳んで盤面を広く見る";
        elements.selectionBoardButton.setAttribute("aria-pressed", String(enabled));
      } else if (elements.selectionBoardButton) {
        elements.selectionBoardButton.textContent = enabled ? "選択に戻る" : "盤面確認";
        elements.selectionBoardButton.title = enabled ? "選択ダイアログに戻る" : "盤面のカードをタップして詳細を見る";
        elements.selectionBoardButton.setAttribute("aria-pressed", String(enabled));
      }
      hideCardTooltip();
      if (boardPeekOn === enabled) {
        return; // モーダル切替は状態が変わった時だけ（無駄な close/open を避ける）
      }
      boardPeekOn = enabled;
      selectionBoardInspect = dock ? !settled : enabled;
      applyModality(!enabled);
      updateLeadHint();
    };

    const toggleBoardPeek = () => {
      setBoardPeek(!elements.selectionDialog.classList.contains("selection-board-peek"));
    };

    const updateSelectionPreview = (card) => {
      if (!elements.selectionDialogPreview) {
        return;
      }
      if (!card) {
        elements.selectionDialogPreview.innerHTML =
          '<p class="selection-preview-empty">候補のカードにカーソルを合わせると詳細を確認できます。</p>';
        return;
      }
      elements.selectionDialogPreview.innerHTML = cardTooltipHtml(card);
    };

    const updateConfirm = () => {
      elements.selectionConfirmButton.disabled =
        selectedIndexes.size < min || selectedIndexes.size > max;
      if (dock) {
        // 0〜N枚の任意選択で何も選んでいない時は「選ばずに進める」（スマホのみ。PC の文言は従来どおり）。
        elements.selectionConfirmButton.textContent =
          min === 0 && selectedIndexes.size === 0 ? "選ばずに進める" : options.confirmText || "決定";
        refreshBoardMarks();
      }
      elements.selectionDialogList
        .querySelectorAll(".selection-choice")
        .forEach((button) => {
          button.classList.toggle("selected", selectedIndexes.has(Number(button.dataset.choiceIndex)));
        });
    };

    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      elements.selectionDialog.classList.remove("selection-instant");
      if (globalThis.__forceSettleSelectionDialog) {
        globalThis.__forceSettleSelectionDialog = null; // 外部強制クローズ用フック(thin)を解除
      }
      hideCardTooltip();
      setBoardPeek(false);
      selectionBoardInspect = false;
      selectionDockState = null;
      clearBoardMarks();
      elements.selectionDialog.classList.remove("selection-dock");
      document.body.classList?.remove("selection-dock-open");
      elements.selectionConfirmButton.removeEventListener("click", confirm);
      elements.selectionCancelButton.removeEventListener("click", cancel);
      elements.selectionCancelButton.disabled = false;
      elements.selectionBoardButton?.removeEventListener("click", toggleBoardPeek);
      if (dockEscHandler) document.removeEventListener?.("keydown", dockEscHandler);
      elements.selectionDialog.removeEventListener("cancel", cancel);
      elements.selectionDialog.removeEventListener("close", close);
      const finish = () => resolve(value);
      if (elements.selectionDialog.open) {
        elements.selectionDialog.addEventListener("close", finish, { once: true });
        elements.selectionDialog.close();
        return;
      }
      finish();
    };

    const confirm = () => {
      const selected = candidates.filter((candidate) => selectedIndexes.has(candidate.choiceIndex));
      settle(selected);
    };
    const cancel = (event) => {
      event?.preventDefault?.();
      if (!allowCancel) {
        return;
      }
      settle(min === 0 ? [] : null);
    };
    const close = () => {
      // stale イベントガード: dialog.close() の close イベントは「キューされたタスク」で発火するため、
      // 旧ダイアログを強制settle→同一タスク内で新ダイアログを showModal した場合、旧 close() 由来の
      // イベントが新ダイアログのこのハンドラに届く。自分自身の正規 close は必ず open=false で届くので、
      // open のままなら他人(旧ダイアログ)のイベントとして無視する。
      if (elements.selectionDialog.open) {
        return;
      }
      if (!allowCancel && !settled) {
        openDialog();
        return;
      }
      settle(min === 0 ? [] : null);
    };

    elements.selectionDialogTitle.textContent = options.title || "カード選択";
    // pt-final(5): 既定の案内（「0～1枚」→「1枚まで（選ばなくてもかまいません）」）。
    baseLead = options.lead || (min === 0 ? `${max}枚まで選んでください（選ばなくてもかまいません）。` : max > min ? `${min}～${max}枚選んでください。` : `${max}枚選んでください。`);
    elements.selectionDialogLead.textContent = baseLead;
    elements.selectionDialogList.innerHTML = "";
    setBoardPeek(false);
    updateSelectionPreview(null);
    // searchable: 候補名でインクリメンタルに絞り込む検索ボックス（カード名宣言など候補が多い時用）。
    if (options.searchable) {
      const search = document.createElement("input");
      search.type = "search";
      search.className = "selection-search";
      search.placeholder = "カード名で絞り込み";
      search.style.cssText =
        "width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px 10px;font-size:1em;";
      search.addEventListener("input", () => {
        const query = search.value.trim().toLowerCase();
        elements.selectionDialogList.querySelectorAll(".selection-choice").forEach((button) => {
          const name = (button.dataset.choiceName || "").toLowerCase();
          button.style.display = !query || name.includes(query) ? "" : "none";
        });
      });
      elements.selectionDialogList.append(search);
    }
    candidates.forEach((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "selection-choice";
      button.dataset.choiceIndex = String(candidate.choiceIndex);
      button.dataset.choiceName = candidate.card?.name || "";
      button.innerHTML = selectionChoiceMarkup(candidate.card, index, candidate.note);
      attachTooltip(button, candidate.card, { touchPreview: true }); // タッチでも長押しで候補カードの詳細を見られるように
      button.addEventListener("mouseenter", () => updateSelectionPreview(candidate.card));
      button.addEventListener("focus", () => updateSelectionPreview(candidate.card));
      button.addEventListener("click", () => {
        updateSelectionPreview(candidate.card);
        if (options.instantPick) {
          // 二択の確認（showConfirmChoiceDialog）: 候補のタップで即確定（「決定」を挟まない）。
          selectedIndexes.clear();
          selectedIndexes.add(candidate.choiceIndex);
          confirm();
          return;
        }
        if (selectedIndexes.has(candidate.choiceIndex)) {
          selectedIndexes.delete(candidate.choiceIndex);
        } else {
          if (max === 1) {
            selectedIndexes.clear();
          }
          selectedIndexes.add(candidate.choiceIndex);
        }
        updateConfirm();
      });
    elements.selectionDialogList.append(button);
    });
    elements.selectionConfirmButton.textContent = options.confirmText || "決定";
    elements.selectionCancelButton.disabled = !allowCancel;
    elements.selectionConfirmButton.addEventListener("click", confirm);
    elements.selectionCancelButton.addEventListener("click", cancel);
    elements.selectionBoardButton?.addEventListener("click", toggleBoardPeek);
    elements.selectionDialog.addEventListener("cancel", cancel);
    elements.selectionDialog.addEventListener("close", close);
    if (dock) {
      // 非モーダルの dialog は Esc で cancel イベントが来ないため、ドックの間だけ Esc＝キャンセルを自前で受ける。
      dockEscHandler = (event) => {
        // ドックの上に重ねて開いたモーダル（ドロップ一覧等）の Esc はそのダイアログを閉じるだけにする。
        if (event.key === "Escape" && !elements.cardSheet?.open && !document.querySelector?.("dialog[open]:modal")) {
          cancel(event);
        }
      };
      document.addEventListener?.("keydown", dockEscHandler);
      elements.selectionDialog.classList.add("selection-dock");
      document.body.classList?.add("selection-dock-open");
      selectionDockState = {
        pickSet: (owner) => {
          const sets = [...boardLocations].filter(([, location]) => location.owner === owner && location.domZone === "setpile");
          if (sets.length === 0) return false;
          const clickChoice = (choiceIndex) =>
            elements.selectionDialogList.querySelector?.(`.selection-choice[data-choice-index="${choiceIndex}"]`)?.click();
          if (sets.length === 1) {
            clickChoice(sets[0][0]);
            return true;
          }
          showActionMenu(
            sets.map(([choiceIndex]) => {
              const candidate = candidates.find((entry) => entry.choiceIndex === choiceIndex);
              return { label: `${candidate?.card?.name || "配置魔法"}を${selectedIndexes.has(choiceIndex) ? "外す" : "選ぶ"}`, run: () => clickChoice(choiceIndex) };
            }),
          );
          return true;
        },
        pick: (owner, zone) => {
          if (zone === "setpile") {
            return selectionDockState?.pickSet?.(owner) || false;
          }
          for (const [choiceIndex, location] of boardLocations) {
            if (location.owner === owner && (location.zone === zone || location.domZone === zone)) {
              elements.selectionDialogList.querySelector?.(`.selection-choice[data-choice-index="${choiceIndex}"]`)?.click();
              return true;
            }
          }
          return false;
        },
      };
    }
    elements.selectionDialog.classList.toggle("selection-instant", Boolean(options.instantPick));
    updateConfirm();
    openDialog();
    setBoardPeek(false); // スマホ: 開いた時点から「盤面は見るだけ＋候補タップで選択」にする
    updateLeadHint(); // 開いてからドックの高さで「隠れた候補」を判定し直す
    if (dock && boardLocations.size > 0) {
      // pt-final(5): ドックの高さ/盤面のスクロールは開いた直後のレイアウト・遷移で変わる（開いた瞬間は覆われて
      // いないと判定→実際は一覧の下に隠れたまま「盤面の光る札をタップしても選べます」と案内していた）。
      // 描画が落ち着いた後と画面サイズの変化時にも判定し直す。
      const recheck = () => {
        if (!settled) updateLeadHint();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(recheck));
      if (typeof setTimeout === "function") {
        setTimeout(recheck, 120);
        setTimeout(recheck, 400);
      }
      if (typeof addEventListener === "function") {
        addEventListener("resize", recheck);
        const removeResize = () => typeof removeEventListener === "function" && removeEventListener("resize", recheck);
        elements.selectionDialog.addEventListener("close", removeResize, { once: true });
      }
    }
    if (dock) {
      // 開いた時の自動フォーカスで先頭候補のホバー詳細が出て一覧を覆うのを防ぐ（詳細は長押しで見る）。
      document.activeElement?.blur?.();
      hideCardTooltip();
    }
    // thin(権威版)向け: 新しいプロンプトが届いた時に、開きっぱなしの旧ダイアログを
    // プログラム側から安全に解決(キャンセル扱い)して閉じるためのフック。
    globalThis.__forceSettleSelectionDialog = () => settle(min === 0 ? [] : null);
  });
}

function selectionChoiceMarkup(card, index, note = "") {
  // 分岐・二択の行（type:"choice"）はカードではないので種別を出さない（PC で内部値 "choice" が見えていた）。
  const isChoice = card.type === "choice";
  const meta = [
    card.no,
    isChoice ? "" : typeLabels[displayCardType(card)] || typeLabels[card.type] || card.type,
    (card.attributes || []).join(" / "),
    note,
  ]
    .filter(Boolean)
    .join(" ・ ");
  return `
    <span class="selection-choice-index">${index + 1}</span>
    <span class="selection-choice-main">
      <span class="selection-choice-name">${escapeHtml(card.name)}</span>
      ${note ? `<span class="selection-choice-note">${escapeHtml(note)}</span>` : ""}
      <span class="selection-choice-meta">${escapeHtml(meta)}</span>
      <span class="selection-choice-biblio">${escapeHtml([card.no, (card.attributes || []).join(" / ")].filter(Boolean).join(" ・ "))}</span>
    </span>
    ${isChoice ? "" : `<span class="selection-choice-type" data-type="${escapeHtml(card.type || "")}">${escapeHtml(typeLabels[displayCardType(card)] || typeLabels[card.type] || card.type || "")}</span>`}
  `;
}

async function chooseAndTakeMatchingCards(pile, filter = {}, amount = 1, excludedCard = null, options = {}) {
  const candidates = (pile || [])
    .map((card, index) => ({ card, index }))
    // E-PR3: filter.buddy を場外(ドロップ/手札)でも判定できるよう pile 所有者 options.owner を伝播する
    // （E-XC15/scriptCardMatches と同型。owner 未供給の呼び出しは matchesCardFilter が従来どおり＝挙動不変）。
    .filter(({ card }) => card.instanceId !== excludedCard?.instanceId && matchesCardFilter(card, filter, { owner: options.owner }));
  const selected = await chooseCardEntries(candidates, {
    title: options.title || "カード選択",
    lead: options.lead || `${amount}枚選んでください。`,
    min: options.min ?? Math.min(amount, candidates.length),
    max: options.max ?? amount,
    // 権威サーバ: 選ぶ本人の席は呼び出し元責務（pile の所有者と選択者が一致しない場合があるため）。
    promptSeat: options.promptSeat,
    // T2（オーナー裁定 2026-10-14）: 効果の解決途中の取り出し（捨てる手札・ドロップから手札へ等）は巻き戻せないため
    // 既定で強制選択（キャンセル不可）。以前はキャンセル＝0枚扱いで「3枚引いて捨てない」等が起きていた（竜雲月露）。
    allowCancel: options.allowCancel ?? false,
  });
  if (!selected?.length) {
    return [];
  }
  return removePileEntries(pile, selected);
}

function removePileEntries(pile, entries) {
  const movedCards = [];
  [...entries]
    .sort((left, right) => right.index - left.index)
    .forEach((entry) => {
      if (pile[entry.index]?.instanceId === entry.card.instanceId) {
        movedCards.unshift(pile.splice(entry.index, 1)[0]);
        return;
      }
      const currentIndex = pile.findIndex((card) => card.instanceId === entry.card.instanceId);
      if (currentIndex >= 0) {
        movedCards.unshift(pile.splice(currentIndex, 1)[0]);
      }
    });
  return movedCards;
}


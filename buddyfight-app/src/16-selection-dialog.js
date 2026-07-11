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
async function chooseCardEntries(candidates, options = {}) {
  if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
    return replayNextSelection(candidates);
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
  let selected;
  if (globalThis.__BUDDYFIGHT_SERVER__ && typeof globalThis.__serverPrompt === "function") {
    // 権威サーバ: 該当クライアントへ選択を往復で問い合わせる（DOMダイアログは使わない）。
    const response = await globalThis.__serverPrompt({
      kind: "selection",
      targetSeat: options.promptSeat,
      title: choiceBase.title,
      lead: choiceBase.lead,
      min,
      max,
      allowCancel: options.allowCancel !== false,
      searchable: Boolean(options.searchable),
      candidates: normalized.map((candidate) => ({
        index: candidate.choiceIndex,
        ...compactChoiceForLog(candidate),
      })),
    });
    selected = resolveServerSelection(response, normalized, min, max, options.allowCancel !== false);
  } else if (typeof aiShouldAnswerPrompt === "function" && aiShouldAnswerPrompt(options.promptSeat)) {
    // CPU対戦: promptSeat がCPU席の選択は src/22-ai.js が答える（ダイアログは出さない）。
    selected = await aiAnswerSelection(normalized, { ...options, min, max });
  } else if (!canShowSelectionDialog()) {
    selected = fallbackCardEntrySelection(normalized, { ...options, min, max });
  } else {
    selected = await showCardSelectionDialog(normalized, { ...options, min, max });
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

    // 盤面確認中はモーダル→非モーダルへ切り替える。モーダル(showModal)の間は背後の文書が inert になり、
    // 盤面が見えていてもカードをタップできない（＝詳細が見られない）ため。
    // close() の close イベントは「キューされたタスク」で発火するので、同期で open し直せば
    // 既存の close ハンドラ冒頭の `if (open) return` に吸収され、キャンセル扱いにならない。
    const applyModality = (modal) => {
      const dialog = elements.selectionDialog;
      if (!dialog.open) {
        return;
      }
      dialog.close();
      if (modal || typeof dialog.show !== "function") {
        dialog.showModal();
      } else {
        dialog.show();
      }
    };

    let boardPeekOn = false;
    const setBoardPeek = (enabled) => {
      elements.selectionDialog.classList.toggle("selection-board-peek", enabled);
      selectionBoardInspect = enabled; // 早期returnより前に必ず反映（前のダイアログの状態を残さない）
      if (elements.selectionBoardButton) {
        elements.selectionBoardButton.textContent = enabled ? "選択に戻る" : "盤面確認";
        elements.selectionBoardButton.title = enabled ? "選択ダイアログに戻る" : "盤面のカードをタップして詳細を見る";
        elements.selectionBoardButton.setAttribute("aria-pressed", String(enabled));
      }
      hideCardTooltip();
      if (boardPeekOn === enabled) {
        return; // モーダル切替は状態が変わった時だけ（無駄な close/open を避ける）
      }
      boardPeekOn = enabled;
      selectionBoardInspect = enabled;
      applyModality(!enabled);
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
      if (globalThis.__forceSettleSelectionDialog) {
        globalThis.__forceSettleSelectionDialog = null; // 外部強制クローズ用フック(thin)を解除
      }
      hideCardTooltip();
      setBoardPeek(false);
      elements.selectionConfirmButton.removeEventListener("click", confirm);
      elements.selectionCancelButton.removeEventListener("click", cancel);
      elements.selectionCancelButton.disabled = false;
      elements.selectionBoardButton?.removeEventListener("click", toggleBoardPeek);
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
        elements.selectionDialog.showModal();
        return;
      }
      settle(min === 0 ? [] : null);
    };

    elements.selectionDialogTitle.textContent = options.title || "カード選択";
    elements.selectionDialogLead.textContent =
      options.lead || (max > 1 ? `${min}～${max}枚選んでください。` : "1枚選んでください。");
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
    updateConfirm();
    elements.selectionDialog.showModal();
    // thin(権威版)向け: 新しいプロンプトが届いた時に、開きっぱなしの旧ダイアログを
    // プログラム側から安全に解決(キャンセル扱い)して閉じるためのフック。
    globalThis.__forceSettleSelectionDialog = () => settle(min === 0 ? [] : null);
  });
}

function selectionChoiceMarkup(card, index, note = "") {
  const meta = [
    card.no,
    typeLabels[displayCardType(card)] || typeLabels[card.type] || card.type,
    (card.attributes || []).join(" / "),
    note,
  ]
    .filter(Boolean)
    .join(" ・ ");
  return `
    <span class="selection-choice-index">${index + 1}</span>
    <span class="selection-choice-main">
      <span class="selection-choice-name">${escapeHtml(card.name)}</span>
      <span class="selection-choice-meta">${escapeHtml(meta)}</span>
    </span>
    <span class="selection-choice-type">${escapeHtml(typeLabels[displayCardType(card)] || typeLabels[card.type] || card.type || "")}</span>
  `;
}

async function chooseAndTakeMatchingCards(pile, filter = {}, amount = 1, excludedCard = null, options = {}) {
  const candidates = (pile || [])
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card.instanceId !== excludedCard?.instanceId && matchesCardFilter(card, filter));
  const selected = await chooseCardEntries(candidates, {
    title: options.title || "カード選択",
    lead: options.lead || `${amount}枚選んでください。`,
    min: options.min ?? Math.min(amount, candidates.length),
    max: options.max ?? amount,
    // 権威サーバ: 選ぶ本人の席は呼び出し元責務（pile の所有者と選択者が一致しない場合があるため）。
    promptSeat: options.promptSeat,
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


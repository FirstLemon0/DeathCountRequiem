// ==========================================================================
// buddyfight モジュール 20 — タッチ操作UI(カードシート/対象タップ/確認/デッキ情報)
// 旧 app.js L10574-10907 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ============================================================
// B2: タッチ操作刷新（カードシート・対象タップ・確認ダイアログ）
// 既存のルール/アクション関数は変更せず、有効なボタンへ委譲する。
// ============================================================

// 現在カードシートに表示すべきカードを返す
function cardSheetCard() {
  if (cardSheetReadOnly) {
    return cardSheetReadOnlyCard;
  }
  return getSelectedCard();
}

// 選択中カードのシートを開く（操作可能）
function openCardSheet() {
  if (!elements.cardSheet || !getSelectedCard()) {
    return;
  }
  cardSheetReadOnly = false;
  cardSheetReadOnlyCard = null;
  refreshCardSheet();
  if (!elements.cardSheet.open) {
    elements.cardSheet.showModal();
  }
}

// 閲覧専用シートを開く（相手カード等。操作なし）
function openReadOnlyCardSheet(card) {
  if (!elements.cardSheet || !card) {
    return;
  }
  cardSheetReadOnly = true;
  cardSheetReadOnlyCard = card;
  refreshCardSheet();
  if (!elements.cardSheet.open) {
    elements.cardSheet.showModal();
  }
}

function closeCardSheet() {
  cardSheetReadOnly = false;
  cardSheetReadOnlyCard = null;
  if (elements.cardSheet?.open) {
    elements.cardSheet.close();
  }
}

// ---- 画面下部アクションメニュー（権威版 play.js と同一の見た目/操作。カードタップ→操作の共通部品）----
// id は play.js の従来実装と同じ(playActionMenu/playActionBackdrop)にし、両者の closeMenu が互いに効くようにする。
function closeActionMenu() {
  document.getElementById("playActionMenu")?.remove();
  document.getElementById("playActionBackdrop")?.remove();
}

// items: [{label, run}] を下部ポップアップで表示。項目タップ＝メニューを閉じて実行。
// 背景タップ/「閉じる」＝閉じて options.onClose（選択解除等）を呼ぶ。
function showActionMenu(items, options = {}) {
  closeActionMenu();
  const close = () => {
    closeActionMenu();
    if (typeof options.onClose === "function") {
      options.onClose();
    }
  };
  const backdrop = document.createElement("div");
  backdrop.id = "playActionBackdrop";
  backdrop.className = "play-action-backdrop";
  backdrop.addEventListener("click", (event) => {
    // 背後の盤面/手札へのタップ貫通を遮断しつつ閉じる（権威版と同じ）。
    event.stopPropagation();
    close();
  });
  const menu = document.createElement("div");
  menu.id = "playActionMenu";
  menu.className = "play-action-menu";
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.addEventListener("click", () => {
      closeActionMenu();
      item.run();
    });
    menu.append(button);
  });
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "menu-close";
  closeButton.textContent = "閉じる";
  closeButton.addEventListener("click", close);
  menu.append(closeButton);
  document.body.append(backdrop);
  document.body.append(menu);
}

// メニューを閉じた時の選択解除（権威版 clearSelection のローカル版。連携編成は維持する）。
function clearLocalSelection() {
  state.selected = null;
  render();
}

// ---- ローカル/中継: カードタップ→下部アクションメニュー（権威版 handCardMenu/fieldCardMenu と同項目）----
function handCardMenuLocal(instanceId) {
  // 進行中の対象選択(攻撃/効果)と残留効果対象は破棄してから選び直す
  // （旧カードの pending が新カードの対象タップで誤発動するのを防ぐ）。
  uiTargeting = null;
  elements.effectTarget.value = "";
  selectHandCard(instanceId);
  if (!getSelectedCard()) {
    return;
  }
  const callVia = (zone) => () => {
    const card = getSelectedCard();
    // 重ねてコールする札(callStack)は、先に重ねる対象を盤面タップで選ばせてからコールする
    // （権威版の「効果対象タップ＋callZone」と同型）。
    if (card?.callStack && !elements.effectTarget.value && effectTargetCandidates(card).length > 0) {
      startEffectTargeting({ type: "call", zone });
      return;
    }
    runNetworkMutation("コール", () => callMonster(zone));
  };
  showActionMenu(
    [
      { label: "チャージ&ドロー", run: () => runNetworkMutation("チャージ&ドロー", chargeAction) },
      { label: "レフトにコール", run: callVia("left") },
      { label: "センターにコール", run: callVia("center") },
      { label: "ライトにコール", run: callVia("right") },
      { label: "使用/装備", run: () => runNetworkMutation("カード使用", useCardAction) },
      { label: "使用（効果対象を選ぶ）", run: () => startEffectTargeting({ type: "use" }) },
      { label: "バディコール宣言", run: () => partnerCall() },
    ],
    { onClose: clearLocalSelection },
  );
}

// アイテム枠(DOM上は "item" 単一)を複数アイテムで共有するため、クリック位置から実スロットを解決する。
// タップが特定アイテムレイヤー(data-item-zone)上なら そのスロット、そうでなければ最初の装備アイテムの枠を返す。
function resolveClickedItemZone(event, owner, zone) {
  if (zone !== "item") {
    return zone;
  }
  const layer = event?.target?.closest?.("[data-item-zone]");
  if (layer?.dataset?.itemZone && state.players[owner]?.field?.[layer.dataset.itemZone]) {
    return layer.dataset.itemZone;
  }
  // レイヤー未特定: 主枠が空なら最初の装備アイテムの実スロットへフォールバック。
  if (!state.players[owner]?.field?.item) {
    const firstItem = equippedItems(state.players[owner])[0];
    if (firstItem) {
      return itemZoneOf(state.players[owner], firstItem) || zone;
    }
  }
  return zone;
}

function fieldCardMenuLocal(owner, zone) {
  // 進行中の対象選択と残留効果対象は破棄してから選び直す（handCardMenuLocalと同じ防御）。
  uiTargeting = null;
  elements.effectTarget.value = "";
  if (!selectFieldCard(owner, zone)) {
    return false;
  }
  const linked = (state.linkAttackers || []).some(
    (slot) => slot.owner === owner && slot.zone === zone,
  );
  showActionMenu(
    [
      { label: "攻撃（対象を選ぶ）", run: () => startAttackTargeting() },
      { label: linked ? "連携から外す" : "連携に追加", run: () => toggleLinkAttacker() },
      { label: "使用（能力）", run: () => runNetworkMutation("カード使用", useCardAction) },
      { label: "使用（効果対象を選ぶ）", run: () => startEffectTargeting({ type: "use" }) },
    ],
    { onClose: clearLocalSelection },
  );
  return true;
}

// シート内に出す操作ボタンの定義（有効なものだけ既存ボタンへ委譲）
function cardSheetActionSpecs() {
  const card = getSelectedCard();
  if (!card) {
    return [];
  }
  const specs = [];
  // 効果対象が必要で未指定 → 盤面タップで選ぶモードへ
  if (
    requiresExplicitEffectTarget(card) &&
    !elements.effectTarget.value &&
    effectTargetCandidates(card).length > 0
  ) {
    specs.push({ label: "効果対象を選ぶ", run: () => startEffectTargeting({ type: "use" }), primary: true });
  }
  // 既存の共有ボタンを委譲（renderActionsが確定したdisabledを読むだけ）
  const proxied = [
    elements.castButton,
    elements.attackButton,
    elements.partnerCallButton,
    elements.linkToggleButton,
    elements.resolveAttackButton,
    elements.counterHandButton,
    elements.chargeButton,
  ];
  proxied.forEach((button) => {
    if (button && !button.disabled) {
      specs.push({ label: button.textContent, run: () => proxyClickFromSheet(button) });
    }
  });
  // コール先（3ゾーン）
  document.querySelectorAll("[data-call-zone]").forEach((button) => {
    if (!button.disabled) {
      specs.push({ label: button.textContent, run: () => proxyClickFromSheet(button) });
    }
  });
  return specs;
}

// シートのボタン → 既存ボタンへclick委譲
function proxyClickFromSheet(button) {
  closeCardSheet();
  button.click();
}

function refreshCardSheet() {
  if (!elements.cardSheet) {
    return;
  }
  const card = cardSheetCard();
  if (!card) {
    closeCardSheet();
    return;
  }
  elements.cardSheetTitle.textContent = card.name;
  elements.cardSheetDetail.innerHTML = cardTooltipHtml(card);
  elements.cardSheetActions.innerHTML = "";
  const specs = cardSheetReadOnly ? [] : cardSheetActionSpecs();
  if (specs.length === 0 && !cardSheetReadOnly) {
    const note = document.createElement("p");
    note.className = "card-sheet-empty";
    note.textContent = "今このカードで行える操作はありません。";
    elements.cardSheetActions.append(note);
  }
  specs.forEach((spec) => {
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = `card-sheet-action${spec.primary ? " primary" : ""}`;
    actionButton.textContent = spec.label;
    actionButton.addEventListener("click", spec.run);
    elements.cardSheetActions.append(actionButton);
  });
}

// ---- 対象選択（攻撃/効果）：盤面タップで隠しselectの値を設定 ----

function startAttackTargeting() {
  // 攻撃宣言できない状況では対象選択モードに入らない（バナー/減光だけ残る混乱を防ぐ）。
  if (state.winner || hasPendingResolution() || !["attack", "final"].includes(state.phase)) {
    addLog("攻撃はアタックフェイズ／ファイナルフェイズでのみ宣言できます。");
    showToast("攻撃はアタックフェイズでのみ宣言できます");
    render();
    return;
  }
  const candidates = computeAttackTargetCandidates();
  if (candidates.length === 0) {
    addLog("攻撃できる対象がありません（行動済み・攻撃制限などを確認してください）。");
    showToast("攻撃できる対象がありません");
    render();
    return;
  }
  uiTargeting = { mode: "attack", candidates };
  closeCardSheet();
  closeActionMenu();
  render();
}

// 権威版仕様: 対象タップで即・攻撃宣言（確認ダイアログは挟まない）。
async function confirmAttackTarget(value) {
  uiTargeting = null;
  elements.attackTarget.value = value;
  await runNetworkMutation("攻撃宣言", attackAction);
}

// pending: {type:"use"} または {type:"call", zone}（対象確定後に実行する操作。権威版と同じ1段階フロー）。
function startEffectTargeting(pending) {
  const card = getSelectedCard();
  const candidates = card ? effectTargetCandidates(card) : [];
  if (candidates.length === 0) {
    addLog("効果対象の候補がありません。");
    showToast("効果対象の候補がありません");
    render();
    return;
  }
  uiTargeting = {
    mode: "effect",
    pending: pending && pending.type ? pending : { type: "use" },
    candidates: candidates.map((candidate) => ({ owner: candidate.owner, zone: candidate.zone })),
  };
  closeCardSheet();
  closeActionMenu();
  render();
}

function pickEffectTarget(owner, zone) {
  if (!uiTargeting || uiTargeting.mode !== "effect") {
    return;
  }
  const pending = uiTargeting.pending || { type: "use" };
  uiTargeting = null;
  elements.effectTarget.value = encodeTarget(owner, zone);
  render(); // effectTarget.value反映
  // 権威版と同じ1段階: 対象タップで即実行（従来のシート再表示→ボタン押下は廃止）。
  if (pending.type === "call" && pending.zone) {
    runNetworkMutation("コール", () => callMonster(pending.zone));
  } else {
    runNetworkMutation("カード使用", useCardAction);
  }
}

function isAttackCandidateZone(owner, zone) {
  return Boolean(
    uiTargeting?.mode === "attack" &&
      uiTargeting.candidates.some(
        (candidate) => candidate.owner === owner && candidate.zone === zone,
      ),
  );
}

function isEffectCandidateZone(owner, zone) {
  return Boolean(
    uiTargeting?.mode === "effect" &&
      uiTargeting.candidates.some(
        (candidate) => candidate.owner === owner && candidate.zone === zone,
      ),
  );
}

// 対象選択モードのハイライト/ヒントを再適用（render末尾から呼ぶ）
function refreshTargeting() {
  document
    .querySelectorAll(".attack-target-candidate, .effect-target-candidate")
    .forEach((element) =>
      element.classList.remove("attack-target-candidate", "effect-target-candidate"),
    );
  clearTargetingBanner();
  if (!uiTargeting) {
    return;
  }
  if (uiTargeting.mode === "attack") {
    const fresh = computeAttackTargetCandidates();
    if (fresh.length === 0) {
      uiTargeting = null;
      return;
    }
    uiTargeting.candidates = fresh;
    fresh.forEach((candidate) => {
      if (candidate.value === "fighter") {
        // 権威版と同じく「本体＝相手の装備枠」をタップ対象として強調（fighter-panelタップも受付は継続）。
        highlightZoneElement(candidate.owner, "item", "attack-target-candidate");
      } else {
        highlightZoneElement(candidate.owner, candidate.zone, "attack-target-candidate");
      }
    });
    setTargetingBanner("攻撃対象をタップ（本体は相手の『装備』枠）");
  } else if (uiTargeting.mode === "effect") {
    const card = getSelectedCard();
    const fresh = card ? effectTargetCandidates(card) : [];
    if (fresh.length === 0) {
      uiTargeting = null;
      return;
    }
    uiTargeting.candidates = fresh.map((candidate) => ({ owner: candidate.owner, zone: candidate.zone }));
    fresh.forEach((candidate) =>
      highlightZoneElement(candidate.owner, candidate.zone, "effect-target-candidate"),
    );
    setTargetingBanner("効果対象をタップ");
  }
}

function highlightZoneElement(owner, zone, className) {
  const element = document.querySelector(`.zone[data-owner="${owner}"][data-zone="${zone}"]`);
  element?.classList.add(className);
}

// ---- デッキ情報ポップアップ（ワールドタイルから）----
function openDeckInfo(owner) {
  const player = state?.players?.[owner];
  if (!player || !elements.deckInfoDialog) {
    return;
  }
  const hideName = isNetworkConnected() && networkSession.seat !== owner; // 相手のデッキ名は非公開
  const deckName = hideName ? "（非公開）" : player.deckName || "（不明）";
  const world = player.flag?.name || player.world || "-";
  const buddyState = player.buddy ? (player.partnerCalled ? "（コール済）" : "（未コール）") : "";
  const buddyName = player.buddy ? `${player.buddy.name}${buddyState}` : "なし";
  const rows = [
    ["プレイヤー", player.name],
    ["デッキ名", deckName],
    ["使用ワールド", world],
    ["バディ", buddyName],
  ];
  elements.deckInfoTitle.textContent = `${player.name} のデッキ情報`;
  elements.deckInfoBody.innerHTML = rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  if (!elements.deckInfoDialog.open) {
    elements.deckInfoDialog.showModal();
  }
}

// ---- 確認ダイアログ（不可逆操作）----
function confirmAction(message) {
  if (!elements.confirmDialog || !elements.confirmMessage) {
    return Promise.resolve(window.confirm(message));
  }
  // 先行の確認が未解決なら安全に破棄してから新規を張る（resolverの握り潰し防止）
  if (confirmDialogResolver) {
    resolveConfirmDialog(false);
  }
  elements.confirmMessage.textContent = message;
  return new Promise((resolve) => {
    confirmDialogResolver = resolve;
    if (!elements.confirmDialog.open) {
      elements.confirmDialog.showModal();
    }
  });
}

function resolveConfirmDialog(result) {
  if (elements.confirmDialog?.open) {
    elements.confirmDialog.close();
  }
  const resolver = confirmDialogResolver;
  confirmDialogResolver = null;
  resolver?.(result);
}

// ---- ロングプレスで閲覧専用シート（対象選択中でも相手カードを確認）----
function attachZoneLongPress(zoneButton) {
  zoneButton.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") {
      return; // デスクトップはhoverツールチップを使う
    }
    if (longPressTimer) {
      clearTimeout(longPressTimer);
    }
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const owner = Number(zoneButton.dataset.owner);
      const zone = zoneButton.dataset.zone;
      const card = state?.players?.[owner]?.field?.[zone];
      if (card) {
        suppressNextZoneClick = true;
        openReadOnlyCardSheet(card);
      }
    }, 300); // 長押し閾値は手札カード(12-render.js)と統一
  });
  const cancel = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };
  zoneButton.addEventListener("pointerup", cancel);
  zoneButton.addEventListener("pointerleave", cancel);
  zoneButton.addEventListener("pointercancel", cancel);
}


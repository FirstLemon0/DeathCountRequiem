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
    specs.push({ label: "効果対象を選ぶ", run: startEffectTargeting, primary: true });
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
  const candidates = computeAttackTargetCandidates();
  if (candidates.length === 0) {
    return;
  }
  uiTargeting = { mode: "attack", candidates };
  closeCardSheet();
  render();
}

async function confirmAttackTarget(value) {
  uiTargeting = null;
  const opponent = opponentPlayer();
  const label = value === "fighter" ? `${opponent.name}本体` : zoneLabel(value);
  const ok = await confirmAction(`${label}へ攻撃しますか？`);
  if (!ok) {
    render();
    return;
  }
  elements.attackTarget.value = value;
  await runNetworkMutation("攻撃宣言", attackAction);
}

function startEffectTargeting() {
  const card = getSelectedCard();
  const candidates = card ? effectTargetCandidates(card) : [];
  if (candidates.length === 0) {
    return;
  }
  uiTargeting = {
    mode: "effect",
    candidates: candidates.map((candidate) => ({ owner: candidate.owner, zone: candidate.zone })),
  };
  closeCardSheet();
  render();
}

function pickEffectTarget(owner, zone) {
  if (!uiTargeting || uiTargeting.mode !== "effect") {
    return;
  }
  uiTargeting = null;
  elements.effectTarget.value = encodeTarget(owner, zone);
  render(); // effectTarget.value反映 → castButton等が有効化
  openCardSheet(); // シートを再表示して「使用/コール」を出す
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
        highlightFighterPanel(candidate.owner);
      } else {
        highlightZoneElement(candidate.owner, candidate.zone, "attack-target-candidate");
      }
    });
    setTargetingBanner("攻撃対象をタップ");
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

function highlightFighterPanel(owner) {
  const panel = document.querySelector(`.fighter-panel[data-fighter-owner="${owner}"]`);
  panel?.classList.add("attack-target-candidate");
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


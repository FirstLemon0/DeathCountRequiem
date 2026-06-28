// ==========================================================================
// buddyfight モジュール 12 — 描画(盤面/手札/アクション/攻撃対象UI)
// 旧 app.js L5148-5705 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function render() {
  hideCardTooltip();
  renderNetworkChrome();
  renderPlayerStats();
  renderZones();
  renderHand();
  renderActions();
  renderLog();
  refreshTargeting(); // B2: 対象選択モードのハイライト/ヒントを再適用
  if (elements.cardSheet?.open) {
    refreshCardSheet(); // B2: 開いているカードシートを最新状態へ
  }
}

function renderNetworkChrome() {
  if (!isNetworkPage()) {
    return;
  }
  document.body.classList.toggle("network-connected", isNetworkConnected());
  [0, 1].forEach((index) => {
    const zone = document.querySelector(`#player${index + 1}Zone`);
    zone?.classList.toggle("local-seat", isNetworkConnected() && networkSession.seat === index);
    zone?.classList.toggle("remote-seat", isNetworkConnected() && networkSession.seat !== index);
    // turn-seat の付与は renderPlayerStats（全画面共通）へ一本化。
  });
  elements.p1DeckSelect.disabled = isNetworkConnected() && networkSession.seat !== 0;
  elements.p2DeckSelect.disabled = isNetworkConnected() && networkSession.seat !== 1;
  elements.newGameButton.disabled = isNetworkConnected() && networkSession.seat !== 0;
  elements.copyRoomButton.disabled = !networkSession.roomId;
}

function renderPlayerStats() {
  state.players.forEach((player, index) => {
    const playerNumber = index + 1;
    // 手番側ゾーンを持ち上げ相手側を沈める（ローカル含む全画面共通。state.active基準）。
    document
      .querySelector(`#player${playerNumber}Zone`)
      ?.classList.toggle("turn-seat", !state.winner && state.active === index);
    document.querySelector(`#p${playerNumber}Life`).textContent = player.life;
    const deckCounter = document.querySelector(`#p${playerNumber}Deck`);
    const handCounter = document.querySelector(`#p${playerNumber}Hand`);
    const gaugeCounter = document.querySelector(`#p${playerNumber}Gauge`);
    if (deckCounter) {
      deckCounter.textContent = `山${player.deck.length}`;
    }
    if (handCounter) {
      handCounter.textContent = `手${player.hand.length}`;
    }
    if (gaugeCounter) {
      gaugeCounter.textContent = `ゲ${player.gauge.length}`;
    }
    // B2: バディ専用スロットを廃し、ワールド名タイル化（タップでデッキ情報ポップアップ）。
    const partner = document.querySelector(`#p${index + 1}Partner`);
    if (partner) {
      partner.innerHTML = "";
      partner.classList.add("world-tile");
      partner.dataset.owner = String(index);
      const worldName = player.flag?.name || player.world || "ワールド";
      const label = document.createElement("span");
      label.className = "world-tile-label";
      label.textContent = worldName;
      partner.append(label);
      partner.title = "タップでデッキ情報を表示";
    }
    renderHandPreview(index);
  });

  const current = activePlayer();
  elements.turnLabel.textContent = state.winner ? `${state.winner} 勝利` : current.name;
  elements.phaseLabel.textContent = phaseLabels[state.phase] || state.phase;
  const handPlayer = handOwner();
  elements.handTitle.textContent = state.pendingAttack || state.pendingAction
    ? `${handPlayer.name}の手札（${handPlayerRole(handOwnerIndex())}）`
    : isNetworkConnected()
      ? `${handPlayer.name}の手札（自分）`
      : handOwnerIndex() === state.active
      ? `${handPlayer.name}の手札`
      : `${handPlayer.name}の手札（対抗）`;
  elements.sizeLabel.textContent = `サイズ ${getFieldSize(current)} / ${fieldSizeLimit(current)}`;
  const selected = getSelectedCard();
  elements.selectionLabel.textContent =
    state.linkAttackers?.length > 0
      ? `連携 ${state.linkAttackers.length}枚`
      : selected
        ? selected.name
        : "なし";
}

function renderHandPreview(playerIndex) {
  const target = document.querySelector(`#p${playerIndex + 1}HandPreview`);
  target.innerHTML = "";
  state.players[playerIndex].hand.forEach(() => {
    const back = document.createElement("span");
    back.className = "hand-back";
    target.append(back);
  });
}

function renderZones() {
  document.querySelectorAll(".zone").forEach((zoneButton) => {
    const owner = Number(zoneButton.dataset.owner);
    const zone = zoneButton.dataset.zone;
    const player = state.players[owner];
    zoneButton.innerHTML = "";

    if (zone === "deck") {
      zoneButton.textContent = `デッキ ${player.deck.length}`;
      return;
    }
    if (zone === "drop") {
      renderDropZone(zoneButton, player);
      return;
    }
    if (zone === "setpile") {
      renderSetPile(zoneButton, player);
      return;
    }
    if (zone === "item") {
      renderFlagItemZone(zoneButton, player);
      return;
    }

    const card = player.field[zone];
    if (zone === "center") {
      // センターにモンスターがいる時だけ「本体が守られている＝直接攻撃不可」を強調
      // （盾アイコン＋warn縁取りは styles.css の .zone.center.center-occupied）。空なら通常表示。
      zoneButton.classList.toggle("center-occupied", Boolean(card));
    }
    if (card) {
      zoneButton.append(createCardElement(card));
    } else {
      zoneButton.textContent = zoneLabel(zone);
    }
  });
}

function renderDropZone(zoneButton, player) {
  zoneButton.textContent = `ドロップ ${player.drop.length}`;
  zoneButton.title = "クリックして中身を確認";
}

// 配置魔法は2スロットを1パイルに集約表示（複数設置に対応）。中身はタップ一覧で確認。
function renderSetPile(zoneButton, player) {
  const count = setZones.reduce((total, zone) => total + (player.field[zone] ? 1 : 0), 0);
  zoneButton.textContent = count > 0 ? `配置魔法 ${count}` : "配置魔法";
  zoneButton.classList.toggle("has-cards", count > 0);
  zoneButton.title = "タップで配置魔法の一覧";
}

// 配置魔法の一覧（ドロップダイアログのDOMを流用）。自分の配置魔法は名前＋効果を表示しタップで使用、
// 相手の伏せ配置魔法(faceDown)は「裏向き」で非公開・操作不可。
function showSetSpellDialog(owner) {
  const player = state.players[owner];
  if (!player || !elements.dropDialog || !elements.dropDialogTitle || !elements.dropDialogList) {
    return;
  }
  hideCardTooltip();
  const entries = setZones
    .map((zone) => ({ zone, card: player.field[zone] }))
    .filter((entry) => entry.card);
  elements.dropDialogTitle.textContent = `${player.name}の配置魔法（${entries.length}枚）`;
  elements.dropDialogList.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "drop-dialog-empty";
    empty.textContent = "なし";
    elements.dropDialogList.append(empty);
    if (!elements.dropDialog.open) {
      elements.dropDialog.showModal();
    }
    return;
  }
  entries.forEach(({ zone, card }, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drop-dialog-card";
    if (card.faceDown) {
      button.disabled = true;
      button.innerHTML = `
        <span class="drop-dialog-order">${index + 1}</span>
        <span class="drop-dialog-name">（裏向きの配置魔法）</span>
      `;
    } else {
      button.innerHTML = `
        <span class="drop-dialog-order">${index + 1}</span>
        <span class="drop-dialog-name">${escapeHtml(card.name)}<small class="set-effect">${escapeHtml(effectImplementationLabel(card))}</small></span>
      `;
      attachTooltip(button, card);
      button.addEventListener("click", () => activateSetSpellFromPile(owner, zone, card));
    }
    item.append(button);
    elements.dropDialogList.append(item);
  });
  if (!elements.dropDialog.open) {
    elements.dropDialog.showModal();
  }
}

// 一覧から配置魔法をタップ→選択/使用へ。thin client は globalThis.__onSetSpellActivate で fieldCardMenu に橋渡し。
function activateSetSpellFromPile(owner, zone, card) {
  if (elements.dropDialog?.open) {
    elements.dropDialog.close();
  }
  if (typeof globalThis.__onSetSpellActivate === "function") {
    globalThis.__onSetSpellActivate(owner, zone, card);
    return;
  }
  const selected = selectFieldCard(owner, zone);
  if (selected) {
    openCardSheet();
  } else {
    openReadOnlyCardSheet(card);
  }
}

function renderFlagItemZone(zoneButton, player) {
  const itemCard = player.field.item;
  const stack = document.createElement("span");
  stack.className = `flag-item-stack${itemCard ? " has-item" : ""}`;

  const flagLayer = document.createElement("span");
  flagLayer.className = "flag-layer";
  flagLayer.innerHTML = `
    <span class="stack-layer-label">フラッグ</span>
    <span class="stack-layer-name">${escapeHtml(player.flag.name)}</span>
  `;
  attachTooltip(flagLayer, player.flag);
  stack.append(flagLayer);

  if (itemCard) {
    const itemLayer = createCardElement(itemCard);
    itemLayer.classList.add("item-layer");
    stack.append(itemLayer);
  }
  zoneButton.append(stack);
}

function showDropDialog(owner) {
  const player = state.players[owner];
  if (!player || !elements.dropDialog || !elements.dropDialogTitle || !elements.dropDialogList) {
    return;
  }
  hideCardTooltip();
  elements.dropDialogTitle.textContent = `${player.name}のドロップゾーン（${player.drop.length}枚）`;
  elements.dropDialogList.innerHTML = "";

  if (player.drop.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "drop-dialog-empty";
    emptyItem.textContent = "なし";
    elements.dropDialogList.append(emptyItem);
  } else {
    player.drop.forEach((card, index) => {
      const item = document.createElement("li");
      const cardButton = document.createElement("button");
      cardButton.type = "button";
      cardButton.className = "drop-dialog-card";
      cardButton.innerHTML = `
        <span class="drop-dialog-order">${index + 1}</span>
        <span class="drop-dialog-name">${escapeHtml(card.name)}</span>
        <span class="drop-dialog-type">${escapeHtml(typeLabels[effectiveCardType(card)] || "")}</span>
      `;
      attachTooltip(cardButton, card);
      item.append(cardButton);
      elements.dropDialogList.append(item);
    });
  }

  if (!elements.dropDialog.open) {
    elements.dropDialog.showModal();
  }
}

// 対抗ウィンドウ(相手の攻撃/行動への応答)中、この手札カードが【対抗】で使える種別か。
// state.selected 非依存の静的判定（コスト充足までは見ないが「打てる手」を明示する用途には十分）。
function handCardHasCounterOption(card) {
  return (card.abilities || []).some(
    (ability) => canUseAbilityFromHand(ability) && isCounterAbility(ability),
  );
}

function renderHand() {
  const player = handOwner();
  // 対抗ウィンドウ中は「打てる手（対抗で使える手札）」を強調表示する。
  const counterWindow = Boolean(state.pendingAttack || state.pendingAction);
  let counterPlayable = 0;
  elements.handList.innerHTML = "";
  player.hand.forEach((card) => {
    const cardButton = createCardElement(card, true);
    if (counterWindow && handCardHasCounterOption(card)) {
      cardButton.classList.add("counter-playable");
      counterPlayable += 1;
    }
    if (!globalThis.__BUDDYFIGHT_THIN__) {
      // 通常モードのみローカル選択＋カードシート。シンクライアントは play.js が配線。
      cardButton.addEventListener("click", () => {
        if (cardButton.dataset.tooltipPreview) {
          delete cardButton.dataset.tooltipPreview; // 長押しプレビュー後の click はシートを開かない
          return;
        }
        selectHandCard(card.instanceId);
        openCardSheet();
      });
    }
    elements.handList.append(cardButton);
  });
  // 手札見出しに「打てる手」枚数を併記（0枚＝解決(パス)を促す手掛かり）。
  if (counterWindow && elements.handTitle) {
    elements.handTitle.textContent +=
      counterPlayable > 0 ? ` ・打てる手 ${counterPlayable}` : " ・打てる手なし（解決でパス）";
  }
  // スマホ手札の横スクロール発見性: 右にまだカードが続く時だけ右端フェードを付ける。
  updateHandScrollHint();
}

// .has-overflow を「横にオーバーフローしていて、かつ末尾までスクロールしていない」時のみ付与。
// モバイルはスクロールバーが出ないため、続きがある手掛かりにする（CSS側 .hand-list.has-overflow）。
function applyHandScrollHint(list) {
  const more =
    list.scrollWidth > list.clientWidth + 2 &&
    list.scrollLeft + list.clientWidth < list.scrollWidth - 2;
  list.classList.toggle("has-overflow", more);
}
function updateHandScrollHint() {
  const list = elements.handList;
  if (!list) return;
  if (!list.dataset.scrollHintWired) {
    list.addEventListener("scroll", () => applyHandScrollHint(list), { passive: true });
    list.dataset.scrollHintWired = "1";
  }
  applyHandScrollHint(list);
}

function createCardElement(card, interactive = false) {
  const cardElement = document.createElement(interactive ? "button" : "span");
  const displayType = effectiveCardType(card);
  cardElement.className = `card ${displayType}`;
  if (card.instanceId) {
    cardElement.dataset.instanceId = card.instanceId; // シンクライアント等が識別に使う
  }
  if (interactive) {
    cardElement.type = "button";
  }
  if (state.selected?.instanceId === card.instanceId) {
    cardElement.classList.add("selected");
  }
  if (
    (state.linkAttackers || []).some(
      (attacker) => state.players[attacker.owner]?.field[attacker.zone]?.instanceId === card.instanceId,
    )
  ) {
    cardElement.classList.add("linked");
  }
  if (card.used) {
    cardElement.classList.add("used");
  }
  const soulNames = stackedCardNames(card);
  const soulPeek = soulNames.length
    ? `<span class="card-stack-peek" title="${escapeHtml(soulNames.join(" / "))}">ソウル ${soulNames.length}</span>`
    : "";
  cardElement.innerHTML = `
    <span class="card-title">
      <span class="card-name">${escapeHtml(card.name)}</span>
      <span class="card-kind">${typeLabels[displayType]}</span>
    </span>
    ${soulPeek}
    <span class="card-text">${escapeHtml(effectImplementationLabel(card))}</span>
      <span class="card-stats">
        <span class="st-cost">コスト ${costLabel(card)}</span>
        <span class="st-size">サイズ ${statLabel(card.size)}</span>
        <span class="st-pow">攻 ${statLabel(visiblePower(card))}</span>
        <span class="st-def">防 ${statLabel(visibleDefense(card))}</span>
        <span class="st-crit">クリ ${statLabel(visibleCritical(card))}</span>
      </span>
  `;
  // 手札カード(interactive=button)のみ、タッチ長押しでプレビュー（盤面のspanは対象外）。
  attachTooltip(cardElement, card, { touchPreview: interactive });
  return cardElement;
}

function stackedCardNames(card) {
  return (card.soul || []).map((soulCard) => soulCard.name).filter(Boolean);
}

function attachTooltip(element, card, options = {}) {
  // デスクトップ: ホバーで表示。
  element.addEventListener("mouseenter", (event) => showCardTooltip(card, event));
  element.addEventListener("mousemove", moveCardTooltip);
  element.addEventListener("mouseleave", hideCardTooltip);
  // フォーカス表示はキーボード操作用。タッチ由来のフォーカスでは出さない
  //（タップでフォーカスが残り blur が来ず「離しても詳細が出続ける」不具合の回避）。
  let touchActive = false;
  let holdTimer = null;
  element.addEventListener("focus", (event) => {
    if (!touchActive) showCardTooltip(card, event);
  });
  element.addEventListener("blur", hideCardTooltip);
  // タッチ: touchPreview 指定要素（手札カード）だけ、長押し(約300ms)でプレビュー表示。
  //   指を離す/外れる/スクロール開始(pointercancel)で消える。横スクロールは閾値前に cancel されるため誤発火しない。
  element.addEventListener("pointerdown", (event) => {
    // 新しい操作の開始で前回の抑止フラグを必ずクリア（指が要素外で離れて click が来なかった
    // 場合の残留で“次タップを飲む”のを防ぐ。長押し成立時はこの後また立て直す）。
    delete element.dataset.tooltipPreview;
    if (event.pointerType === "mouse") return;
    touchActive = true;
    if (!options.touchPreview) return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      element.dataset.tooltipPreview = "1"; // 長押しプレビュー成立→直後の click(=カードシート)は抑止
      // 指の下・画面下部に隠れないよう、長押しプレビューは画面上部中央へアンカー。
      showCardTooltip(card, { clientX: Math.max(10, window.innerWidth / 2 - 130), clientY: 8 });
    }, 300);
  });
  const endTouch = () => {
    if (!touchActive && holdTimer === null) return;
    touchActive = false;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    hideCardTooltip();
  };
  element.addEventListener("pointerup", endTouch);
  element.addEventListener("pointerleave", endTouch);
  element.addEventListener("pointercancel", endTouch);
}

function renderActions() {
  const selectedCard = getSelectedCard();
  renderAttackTargets();
  renderEffectTargets();

  const inBattle = hasPendingResolution();
  const attackingCards = getAttackDeclarationAttackers();
  const missingRequiredEffectTarget =
    requiresExplicitEffectTarget(selectedCard) && !elements.effectTarget.value;
  const selectedLinked =
    state.selected?.source === "field" &&
    (state.linkAttackers || []).some((attacker) =>
      sameSlot(attacker, { owner: state.selected.owner, zone: state.selected.zone }),
    );
  elements.drawButton.disabled = Boolean(
    state.winner || inBattle || state.drewThisTurn || state.phase !== "draw",
  );
  elements.chargeButton.disabled = Boolean(
    state.winner ||
      inBattle ||
      state.phase !== "charge" ||
      state.chargedThisTurn ||
      state.selected?.source !== "hand" ||
      state.selected.owner !== state.active,
  );
  elements.mainPhaseButton.disabled = Boolean(state.winner || inBattle || state.phase !== "charge");
  elements.castButton.disabled = Boolean(!canUseSelectedCard(selectedCard) || missingRequiredEffectTarget);
  elements.resolveAttackButton.textContent = state.pendingAction ? "行動解決" : "攻撃解決";
  elements.resolveAttackButton.disabled = Boolean(
      state.winner ||
      state.resolvingPending ||
      !hasPendingResolution() ||
      (isNetworkConnected() && networkSession.seat !== networkResolutionSeat()),
  );
  elements.counterHandButton.textContent = state.pendingAttack ? "攻防手札切替" : "対抗手札切替";
  elements.counterHandButton.disabled = Boolean(
    state.winner || isNetworkConnected() || (!hasPendingResolution() && !isCounterPlayTiming()),
  );
  elements.attackPhaseButton.disabled = Boolean(state.winner || inBattle || state.phase !== "main");
  elements.finalPhaseButton.disabled = Boolean(
    state.winner || inBattle || state.phase !== "attack",
  );
  elements.linkToggleButton.textContent = selectedLinked ? "連携から外す" : "連携に追加";
  elements.linkToggleButton.disabled = Boolean(
      state.winner ||
      inBattle ||
      !["attack", "final"].includes(state.phase) ||
      state.selected?.source !== "field" ||
      state.selected.owner !== state.active ||
      !selectedCard ||
      selectedCard.used,
  );
  elements.partnerCallButton.textContent =
    state.buddyCallDeclared === selectedCard?.instanceId ? "バディ宣言中" : "バディコール宣言";
  elements.partnerCallButton.disabled = !canDeclareBuddyCall(activePlayer(), selectedCard);
  elements.attackButton.disabled = Boolean(
      state.winner ||
      inBattle ||
      !["attack", "final"].includes(state.phase) ||
      (state.turnCount === 1 && state.attacksThisTurn >= 1) ||
      attackingCards.length === 0 ||
      // B2: 対象未指定でも候補があれば押下可（押下で対象選択モードへ）。値があれば従来どおり宣言。
      (!elements.attackTarget.value && computeAttackTargetCandidates().length === 0),
  );
  elements.endTurnButton.disabled = Boolean(state.winner || inBattle || state.phase !== "final");

  document.querySelectorAll("[data-call-zone]").forEach((button) => {
    const canSpecialCall = specialCallOpportunityForCard(state.selected?.owner, selectedCard);
    button.disabled = Boolean(
        (state.winner && !canSpecialCall) ||
        (inBattle && !canSpecialCall) ||
        (state.phase !== "main" && !canSpecialCall) ||
        state.selected?.source !== "hand" ||
        (!canSpecialCall && state.selected.owner !== state.active) ||
        !selectedCard ||
        !canUseCardForFlag(state.players[state.selected?.owner ?? state.active], selectedCard) ||
        !isCallableMonster(selectedCard) ||
        missingRequiredEffectTarget,
    );
  });
}

function requiresExplicitEffectTarget(card) {
  if (!card) {
    return false;
  }
  const enterAbility = state.selected?.source === "hand" && isCallableMonster(card)
    ? (card.abilities || []).find(
        (ability) => ability.kind === "triggered" && ability.event === "enter" && ability.target,
      )
    : null;
  if (enterAbility?.allowMissingTarget) {
    return false;
  }
  if (firstTargetedAbilityForCurrentTiming(card)?.target) {
    return false;
  }
  return effectTargetCandidates(card).length > 0;
}

function canUseSelectedCard(selectedCard) {
  if (state.winner || !selectedCard) {
    return false;
  }
  if (state.selected?.source === "field") {
    const owner = state.selected.owner;
    const ability = findUsableFieldAbility(selectedCard, owner);
    if (!ability) {
      return false;
    }
    if (state.pendingAction) {
      return (
        owner === state.pendingAction.responder &&
        isCounterAbility(ability) &&
        canUseCounterEffect(owner, selectedCounterKind(selectedCard))
      );
    }
    if (state.pendingAttack) {
      return (
        [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(owner) &&
        isCounterAbility(ability) &&
        canUseCounterEffect(owner, selectedCounterKind(selectedCard))
      );
    }
    return owner === state.active;
  }
  if (state.selected?.source !== "hand") {
    return false;
  }
  if (!canUseCardForFlag(state.players[state.selected.owner], selectedCard)) {
    return false;
  }
  if (state.pendingAction) {
    if (isMagicalGoodbyeCard(selectedCard)) {
      return (
        state.selected.owner === state.pendingAction.responder &&
        canUseCounterEffect(state.selected.owner, selectedCounterKind(selectedCard)) &&
        canUseMagicalGoodbye(state.selected.owner, selectedCard)
      );
    }
    return (
      state.selected.owner === state.pendingAction.responder &&
      canUseCounterEffect(state.selected.owner, selectedCounterKind(selectedCard)) &&
      Boolean(findUsableHandAbility(selectedCard, { counterOnly: true }))
    );
  }
  if (state.pendingAttack) {
    if (isMagicalGoodbyeCard(selectedCard)) {
      return (
        [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(
          state.selected.owner,
        ) &&
        canUseCounterEffect(state.selected.owner, selectedCounterKind(selectedCard)) &&
        canUseMagicalGoodbye(state.selected.owner, selectedCard)
      );
    }
    return (
      [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(
        state.selected.owner,
      ) &&
      canUseCounterEffect(state.selected.owner, selectedCard.effect || selectedCounterKind(selectedCard)) &&
      Boolean(findUsableHandAbility(selectedCard))
    );
  }
  if (canUseCounterPlayCard(selectedCard)) {
    return true;
  }
  if (isCounterOnlyHandCard(selectedCard)) {
    return false;
  }
  return (
    state.selected.owner === state.active &&
    (Boolean(findUsableHandAbility(selectedCard)) ||
    ((state.phase === "main" &&
      (["spell", "item"].includes(selectedCard.type) || hasKeyword(selectedCard, "arrival"))) ||
      (state.phase === "final" && selectedCard.type === "impact")))
  );
}

function computeAttackTargetCandidates() {
  if (state.winner || state.pendingAttack || state.pendingAction) {
    return [];
  }
  const attackers = getAttackDeclarationAttackers();
  if (attackers.length === 0) {
    return [];
  }
  const opponent = opponentPlayer();
  const targetOwner = opponentIndex();
  const candidates = [];
  fieldZones.forEach((zone) => {
    if (opponent.field[zone] && attackers.every((attacker) => canAttackTargetValue(attacker, zone))) {
      candidates.push({
        value: zone,
        owner: targetOwner,
        zone,
        label: `${zoneLabel(zone)}：${opponent.field[zone].name}`,
      });
    }
  });
  if (
    attackers.every((attacker) => canAttackTargetValue(attacker, "fighter")) &&
    (!opponent.field.center || canAttackFighterThroughCenter(attackers))
  ) {
    candidates.push({ value: "fighter", owner: targetOwner, zone: "fighter", label: `${opponent.name}本体` });
  }
  return candidates;
}

function renderAttackTargets() {
  const previous = elements.attackTarget.value;
  elements.attackTarget.innerHTML = "";
  if (state.pendingAttack) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = `攻撃中：${targetLabel(state.pendingAttack)}`;
    elements.attackTarget.append(option);
    elements.attackTarget.disabled = true;
    return;
  }
  if (state.pendingAction) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = `対抗確認中：${pendingActionLabel(state.pendingAction)}`;
    elements.attackTarget.append(option);
    elements.attackTarget.disabled = true;
    return;
  }

  const targets = computeAttackTargetCandidates();
  // B2: 候補があるときは先頭に空プレースホルダを置く。
  // これが無いと<select>が先頭候補を自動選択し、attackTarget.valueが常に非空となり、
  // 「対象未指定なら対象選択モードへ」の分岐が死んで先頭候補へ無確認で即攻撃してしまう。
  if (targets.length > 0) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "攻撃対象を選択";
    elements.attackTarget.append(placeholder);
  }
  targets.forEach((target) => {
    const option = document.createElement("option");
    option.value = target.value;
    option.textContent = target.label;
    elements.attackTarget.append(option);
  });
  elements.attackTarget.disabled = targets.length === 0;
  if (targets.some((target) => target.value === previous)) {
    elements.attackTarget.value = previous;
  } else {
    elements.attackTarget.value = "";
  }
}

function canAttackFighterThroughCenter(attackers) {
  return (
    attackers.length > 0 &&
    attackers.every((attacker) => hasKeyword(attacker.card, "canAttackFighterThroughCenter"))
  );
}

function canAttackTargetValue(attacker, targetValue) {
  if (!attacker?.card || targetValue === "fighter") {
    return true;
  }
  // cannotAttackZones は desugarCardFlags で continuous restrictAttackTargets(自身のみ) へ
  // 変換済みのため、ここでは汎用の攻撃対象制限のみを参照する。
  return !isAttackTargetRestricted(attacker, targetValue);
}

function isAttackTargetRestricted(attacker, targetValue) {
  return state.players.some((player) =>
    zones.some((zone) => {
      const sourceCard = player.field[zone];
      return (sourceCard?.continuous || []).some((effect) => {
        if (effect.op !== "restrictAttackTargets") {
          return false;
        }
        if (effect.zones && !effect.zones.includes(targetValue)) {
          return false;
        }
        if (!continuousEffectApplies(effect, attacker.card, sourceCard)) {
          return false;
        }
        const targetOwner = 1 - attacker.owner;
        const targetCard = state.players[targetOwner]?.field?.[targetValue];
        return !effect.targetFilter || matchesTargetFilter(targetCard, targetOwner, targetValue, effect.targetFilter);
      });
    }),
  );
}

function attackAllMonsterTargetZones(attackers, targetOwner, targetValue) {
  if (targetValue === "fighter" || attackers.length !== 1) {
    return [];
  }
  const attacker = attackers[0];
  if (!attacker.card.attackAllMonstersOnMonsterAttack) {
    return [];
  }
  return fieldZones.filter((zone) => {
    const targetCard = state.players[targetOwner]?.field?.[zone];
    return targetCard && effectiveCardType(targetCard) === "monster" && canAttackTargetValue(attacker, zone);
  });
}


// ===== 対象選択(ターゲティング)の指示バナー: モバイルで指示テキストが消える問題への対応 =====
// body.targeting-active で CSS が固定バナーを表示。テキストを #targetingText に出す。
function setTargetingBanner(text) {
  document.body.classList.add("targeting-active");
  const el = document.querySelector("#targetingText");
  if (el) el.textContent = text;
  if (elements.selectionLabel) elements.selectionLabel.textContent = text;
}
function clearTargetingBanner() {
  document.body.classList.remove("targeting-active");
}

// 一過性トースト（空マスタップ等の短いヒント。モバイルでログが隠れていても見える）。
let toastTimer = null;
function showToast(message, ms = 2600) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  el.setAttribute("aria-hidden", "false");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    el.setAttribute("aria-hidden", "true");
  }, ms);
}

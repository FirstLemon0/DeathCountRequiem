// ==========================================================================
// buddyfight モジュール 12 — 描画(盤面/手札/アクション/攻撃対象UI)
// 旧 app.js L5148-5705 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function render() {
  syncSetZonesWithState(state); // rule-call-11: 設置枠は可変長（直置き・復元直後でも一覧に載せる）
  noteDeckCountsForRuleProcessing(); // ★ルール処理★のデッキ0枚判定用の観測（src/07 runDeckZeroRuleProcessing）
  hideCardTooltip();
  renderNetworkChrome();
  syncLocalSeatFlip();
  renderPlayerStats();
  renderZones();
  renderHand();
  renderActions();
  renderLog();
  refreshTargeting(); // B2: 対象選択モードのハイライト/ヒントを再適用
  if (elements.cardSheet?.open) {
    refreshCardSheet(); // B2: 開いているカードシートを最新状態へ
  }
  syncCounterWindowBar(); // 対抗窓改修: 窓が閉じた/別の窓になったらバーを閉じ、使える札を強調する
  if (typeof aiOnRender === "function") {
    aiOnRender(); // CPU対戦(src/22): 状態変化のたびにCPUの手番/応答を駆動（OFF時は即return）
  }
  if (typeof matchRecordCheckpoint === "function") {
    matchRecordCheckpoint(); // D5(戦績): 決着済み・整合局面で一度だけ戦績を確定（未決着/pending 中は即 return）
  }
}

// プレイテスト T8: ローカルの CPU 対戦で人間が席1（P2）の時は、権威版 play.html の後手席と同じく盤面を
// 人間視点に反転する（自分の場＝下段・相手＝上段・位置名も相手側に「相手」）。styles.css の body.seat-flip 規則を
// 使う。シンクライアントは play.js、リプレイ再生は対象外（それぞれ自分で管理/固定）。
function syncLocalSeatFlip() {
  if (globalThis.__BUDDYFIGHT_THIN__ || globalThis.__BUDDYFIGHT_SERVER__ || typeof document === "undefined" || !document.body?.classList || isReplayViewOnly()) {
    return;
  }
  if (typeof isNetworkConnected === "function" && isNetworkConnected()) {
    return;
  }
  const flip = typeof aiEnabled === "function" && aiEnabled() && aiHumanSeat() === 1;
  document.body.classList.toggle("seat-flip", Boolean(flip));
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
  if (elements.newGameButton) elements.newGameButton.disabled = isNetworkConnected() && networkSession.seat !== 0;
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
      setMobileCounter(deckCounter, "山札", player.deck.length);
    }
    if (handCounter) {
      handCounter.textContent = `手${player.hand.length}`;
      setMobileCounter(handCounter, "手札", player.hand.length);
    }
    if (gaugeCounter) {
      gaugeCounter.textContent = `ゲ${player.gauge.length}`;
      setMobileCounter(gaugeCounter, "ゲージ", player.gauge.length);
    }
    renderMobileSeatSize(index, player);
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

  renderMobilePhaseSteps();
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
    if (zone === "buddyzone") {
      renderBuddyZone(zoneButton, player);
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
  zoneButton.dataset.count = String(player.drop.length);
  zoneButton.title = "クリックして中身を確認";
}

// Z2(S-UB-C03/0095他): バディゾーンの裏向きパイル表示。枚数は互いに常時公開（公式裁定Q2630）。
// 中身の閲覧は所有者本人のみ許される（Q2629）が、ローカル対戦(index.html)は元々両者の情報が
// 同一画面上で共有される非ネット対戦のため、Batch0では枚数バッジ表示のみとする
// （ネット対戦側の秘匿はengine-host.js viewForで別途担保済み。閲覧UIはDSLバッチ以降の追補候補）。
function renderBuddyZone(zoneButton, player) {
  const count = (player.buddyZoneFaceDown || []).length;
  zoneButton.textContent = count > 0 ? `バディゾーン ${count}` : "バディゾーン";
  zoneButton.classList.toggle("has-cards", count > 0);
  zoneButton.dataset.count = String(count);
  zoneButton.title = "裏向きカードの枚数（相手にも公開）";
}

// rule-call-11: 『設置』の枚数に上限は無い。配置魔法は可変長の set 枠（set1, set2, set3, …）を1パイルに集約表示する
// （デッキ/ドロップと同じ「枚数＋タップで一覧」）。枚数があれば末尾の1枚のサムネイルを添える（伏せ札は出さない）。
function renderSetPile(zoneButton, player) {
  const entries = setSpellEntries(player);
  const count = entries.length;
  zoneButton.classList.toggle("has-cards", count > 0);
  zoneButton.dataset.count = String(count);
  if (count === 0) {
    zoneButton.textContent = "配置魔法";
    zoneButton.title = "タップで配置魔法の一覧";
    return;
  }
  const names = entries.map(({ card }) => (card.faceDown ? "（裏向き）" : card.name));
  zoneButton.title = `タップで配置魔法の一覧（${names.join("／")}）`;
  const top = entries[entries.length - 1].card;
  if (!top.faceDown) {
    const thumb = document.createElement("span");
    thumb.className = "set-pile-thumb";
    thumb.append(createCardImageElement(top));
    zoneButton.append(thumb);
  }
  const label = document.createElement("span");
  label.className = "set-pile-label";
  label.textContent = `配置魔法 ${count}`;
  zoneButton.append(label);
}

// 配置魔法の一覧（ドロップダイアログのDOMを流用＝デッキ/ドロップ閲覧と同じ見た目）。両者とも開ける（設置魔法は公開情報）。
// 各行: 名前＋効果ラベル（ホバー/タップで詳細）。行タップ＝従来どおり選択メニュー/閲覧シート。
// 今使える能力を持つ自分の設置魔法には「使用」ボタン（ドロップの「発動」と同じ規約＝確認なしで即実行・対象は選択ダイアログ）。
// 伏せ配置魔法(faceDown)は「裏向き」で非公開・操作不可。
function showSetSpellDialog(owner) {
  const player = state.players[owner];
  if (!player || !elements.dropDialog || !elements.dropDialogTitle || !elements.dropDialogList) {
    return;
  }
  hideCardTooltip();
  const entries = setSpellEntries(player);
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
    item.dataset.zone = zone;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drop-dialog-card set-dialog-card";
    if (card.faceDown) {
      button.disabled = true;
      button.innerHTML = `
        <span class="drop-dialog-order">${index + 1}</span>
        <span class="drop-dialog-name">（裏向きの配置魔法）</span>
      `;
      item.append(button);
    } else {
      button.innerHTML = `
        <span class="drop-dialog-order">${index + 1}</span>
        <span class="drop-dialog-name">${escapeHtml(card.name)}<small class="set-effect">${escapeHtml(effectImplementationLabel(card))}</small></span>
      `;
      attachTooltip(button, card, { touchPreview: true });
      button.addEventListener("click", () => activateSetSpellFromPile(owner, zone, card));
      item.append(button);
      if (setSpellHasUsableAbility(owner, card)) {
        const useButton = document.createElement("button");
        useButton.type = "button";
        useButton.className = "drop-dialog-activate set-dialog-use";
        useButton.textContent = "使用";
        // pt-final(1): 能力はあってもコストを払えない等の時は無効＋理由1行（押して「ゲージが足りません」で止まっていた）。
        const reason = typeof fieldUseBlockedReason === "function"
          ? safeBlockedReason(() => fieldUseBlockedReason({ source: "field", owner, zone, instanceId: card.instanceId }))
          : null;
        if (reason) {
          markButtonBlocked(useButton, reason);
        } else {
          useButton.addEventListener("click", () => useSetSpellFromPile(owner, zone, card));
        }
        item.append(useButton);
      }
    }
    elements.dropDialogList.append(item);
  });
  if (!elements.dropDialog.open) {
    elements.dropDialog.showModal();
  }
}

// pt-final(1): 一覧のボタン（配置魔法の「使用」・ドロップの「発動」）を無効＋理由1行にする。
function markButtonBlocked(button, reason) {
  button.disabled = true;
  button.classList.add("has-reason");
  button.title = reason;
  const note = document.createElement("span");
  note.className = "card-sheet-reason";
  note.textContent = reason;
  button.append(note);
  button.setAttribute("aria-label", `${button.textContent.replace(reason, "")}（できません: ${reason}）`);
}

function safeBlockedReason(compute) {
  try {
    return compute() || null;
  } catch (error) {
    return null;
  }
}

// 一覧の「使用」ボタンを出すか。ドロップ起動と同じ手番/応答者ガード＋今使える場の能力があるか（閲覧専用リプレイでは出さない）。
function setSpellHasUsableAbility(owner, card) {
  if (typeof isReplayViewOnly === "function" && isReplayViewOnly()) return false;
  if (globalThis.__BUDDYFIGHT_THIN__ && Number.isInteger(thinViewerSeat) && thinViewerSeat !== owner) {
    return false; // ネット対戦: 自席の設置魔法だけ
  }
  if (typeof isAiSeat === "function" && isAiSeat(owner)) return false; // CPU席の設置魔法は人間が使えない
  if (typeof aiShouldLockHumanControls === "function" && aiShouldLockHumanControls()) return false;
  const mayAct = state.pendingAttack
    ? [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(owner)
    : state.pendingAction
      ? owner === state.pendingAction.responder
      : owner === state.active || findUsableFieldAbilities(card, owner).some((ability) => isCounterAbility(ability));
  if (!mayAct) return false;
  try {
    return findUsableFieldAbilities(card, owner).length > 0;
  } catch (error) {
    return false;
  }
}

// 一覧の「使用」: 設置魔法の能力を即実行（能力が複数なら選択ダイアログ・対象は選択ダイアログ＝既存の場カード使用経路）。
// thin client は globalThis.__onSetSpellUse で "use" アクション（source:"field"）を送る。
function useSetSpellFromPile(owner, zone, card) {
  if (elements.dropDialog?.open) {
    elements.dropDialog.close();
  }
  if (typeof globalThis.__onSetSpellUse === "function") {
    globalThis.__onSetSpellUse(owner, zone, card);
    return;
  }
  uiTargeting = null;
  if (elements.effectTarget) elements.effectTarget.value = "";
  if (!selectFieldCard(owner, zone)) {
    openReadOnlyCardSheet(card);
    return;
  }
  runNetworkMutation("カード使用", useCardAction);
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
  // ローカル/中継: 操作可能なら下部アクションメニュー（権威版と同一操作）、不可なら閲覧専用シート。
  if (!fieldCardMenuLocal(owner, zone)) {
    openReadOnlyCardSheet(card);
  }
}

function renderFlagItemZone(zoneButton, player) {
  const items = equippedItems(player); // 複数装備対応（主枠＋追加枠）
  const stack = document.createElement("span");
  stack.className = `flag-item-stack${items.length ? " has-item" : ""}${items.length > 1 ? " multi-item" : ""}`;

  const flagLayer = document.createElement("span");
  flagLayer.className = "flag-layer";
  // E-XB54b(∞ the Chaos ∞): 攻撃してレストしたフラッグは used 表示にする（実機のレスト=横向きの代替。
  // 既存 .card.used と同じ淡色＋脱色）。通常フラッグは used が立たないため常に無印＝挙動不変。
  if (player.flag.used) {
    flagLayer.classList.add("used");
  }
  // フラッグ絵（他のカードと同じ画像解決＝imgpack遅延読込→公式URL→テキスト の順にフォールバック）。
  // 画像が出せない/読込失敗時は showCardImageFallback が flag-layer から画像だけ外し、
  // 下のキャプション（フラッグ名）＝現行のテキスト表示へグレースフルに戻す。
  const flagImageCard = flagDisplayImageCard(player.flag);
  if (flagImageCard) {
    const flagImg = createCardImageElement(flagImageCard);
    flagImg.classList.add("flag-img");
    flagLayer.classList.add("has-flag-img");
    flagLayer.append(flagImg);
  }
  const flagCaption = document.createElement("span");
  flagCaption.className = "flag-caption";
  flagCaption.innerHTML = `
    <span class="stack-layer-label">フラッグ</span>
    <span class="stack-layer-name">${escapeHtml(player.flag.name)}</span>
  `;
  flagLayer.append(flagCaption);
  attachTooltip(flagLayer, player.flag);
  stack.append(flagLayer);

  // 装備アイテムを重ねて表示（複数時は少しずつずらして全て見えるように）。
  const owner = Number(zoneButton.dataset.owner);
  items.forEach((itemCard, index) => {
    const itemLayer = createCardElement(itemCard);
    itemLayer.classList.add("item-layer");
    // 複数装備時、どのアイテムかを識別できるよう実スロット名を持たせる（攻撃/操作対象の絞り込み用）。
    itemLayer.dataset.itemZone = itemZoneOf(state.players[owner], itemCard) || "item";
    if (items.length > 1 && index > 0) {
      // 束見せ: 1枚目(itemLayer)を高さの基準にし、2枚目以降を絶対配置で少しずつずらして重ねる
      //（ゾーンを縦に肥大させない）。重なって隠れたカードは端が覗くのでホバー/タップで確認できる。
      itemLayer.classList.add("item-layer-stacked");
      itemLayer.style.setProperty("--item-index", String(index));
    }
    stack.append(itemLayer);
  });
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
        <span class="drop-dialog-type">${escapeHtml(typeLabels[displayCardType(card)] || "")}</span>
      `;
      attachTooltip(cardButton, card, { touchPreview: true });
      item.append(cardButton);
      // ドロップから発動できる起動能力（fromDropZone）を持つ自分のカードには「発動」ボタンを出す。
      if (findUsableDropAbilities(card, owner).length > 0) {
        const useButton = document.createElement("button");
        useButton.type = "button";
        useButton.className = "drop-dialog-activate";
        useButton.textContent = "発動";
        // pt-final(1): コストを払えない時は無効＋理由1行。
        const reason = typeof dropUseBlockedReason === "function" ? safeBlockedReason(() => dropUseBlockedReason(owner, card)) : null;
        if (reason) {
          markButtonBlocked(useButton, reason);
        } else {
          useButton.addEventListener("click", () => activateDropAbilityFromPile(owner, card));
        }
        item.append(useButton);
      }
      elements.dropDialogList.append(item);
    });
  }

  if (!elements.dropDialog.open) {
    elements.dropDialog.showModal();
  }
}

// 盤面カードの「ソウル N」バッジ→ソウル一覧。ソウルのカードをタップすると詳細シート（＋使える能力のボタン）へ。
// ソウルは公開情報なので相手のカードのソウルも見られる（能力ボタンは自分の使える能力だけ出る）。
function showSoulDialog(owner, zone) {
  const host = state.players[owner]?.field?.[zone];
  if (!host || !elements.soulDialog || !elements.soulDialogList) {
    return;
  }
  const souls = host.soul || [];
  hideCardTooltip();
  elements.soulDialogTitle.textContent = `${host.name}のソウル（${souls.length}枚）`;
  elements.soulDialogList.innerHTML = "";
  if (souls.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "drop-dialog-empty";
    emptyItem.textContent = "なし";
    elements.soulDialogList.append(emptyItem);
  } else {
    souls.forEach((soulCard, index) => {
      const item = document.createElement("li");
      const cardButton = document.createElement("button");
      cardButton.type = "button";
      cardButton.className = "drop-dialog-card";
      // MR17-2: ネット対戦の view では、裏向きソウル（ver2.05 p.24＝所有者以外は中身を見られない）が
      // {hidden:true} で届く。名前が無いので escapeHtml(undefined) が文字列 "undefined" を描いていた。
      // 伏せ札として明示し、詳細シート（能力発動の入口）も開かない。
      const isHidden = Boolean(soulCard.hidden) || !soulCard.name;
      if (isHidden) {
        cardButton.classList.add("drop-dialog-card-hidden");
        cardButton.disabled = true;
        cardButton.innerHTML = `
          <span class="drop-dialog-order">${index + 1}</span>
          <span class="drop-dialog-name">（裏向き）</span>
          <span class="drop-dialog-type"></span>
        `;
        item.append(cardButton);
        elements.soulDialogList.append(item);
        return;
      }
      cardButton.innerHTML = `
        <span class="drop-dialog-order">${index + 1}</span>
        <span class="drop-dialog-name">${escapeHtml(soulCard.name)}</span>
        <span class="drop-dialog-type">${escapeHtml(typeLabels[displayCardType(soulCard)] || "")}</span>
      `;
      attachTooltip(cardButton, soulCard, { touchPreview: true });
      // タップ＝そのソウルカードの詳細シート（下に使える能力のボタンが並ぶ）。
      cardButton.addEventListener("click", () => openSoulCardSheet(owner, zone, soulCard));
      item.append(cardButton);
      elements.soulDialogList.append(item);
    });
  }
  if (!elements.soulDialog.open) {
    elements.soulDialog.showModal();
  }
}

function closeSoulDialog() {
  if (elements.soulDialog?.open) {
    elements.soulDialog.close();
  }
}

// ドロップ一覧の「発動」から、ドロップのカードの起動能力を使う。
// thin/権威クライアントは globalThis.__onDropAbilityActivate に橋渡し、ローカルは直接実行。
function activateDropAbilityFromPile(owner, card) {
  if (elements.dropDialog?.open) {
    elements.dropDialog.close();
  }
  if (typeof globalThis.__onDropAbilityActivate === "function") {
    globalThis.__onDropAbilityActivate(owner, card);
    return;
  }
  // 対抗窓改修: 窓が開いていれば、このドロップ札が候補なら窓への応答にする。
  if (counterWindowInterceptLocal("カード使用", { source: "drop", owner, instanceId: card.instanceId })) {
    return;
  }
  // ローカル/中継対戦: 他の全操作と同様に runNetworkMutation 経由で実行し、盤面変化を相手へ snapshot 送信する
  // （素の直接実行だと中継版 netplay.html でドロップ起動が相手に同期されず、相手の次snapshotで巻き戻る）。
  runNetworkMutation("カード使用", () => useDropAbilityAction(owner, card));
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
    if (counterWindow && handCardHasCounterOption(card) && handCounterStillAvailable(card)) {
      cardButton.classList.add("counter-playable");
      counterPlayable += 1;
    }
    // 対抗窓改修: 誘発/ライフリンクの対抗窓で今使える手札を強調（バーの候補と同じ札）。
    if (counterWindowUiUsable("hand", handOwnerIndex(), card.instanceId)) {
      cardButton.classList.add("counter-playable", "counter-window-usable");
    }
    if (!globalThis.__BUDDYFIGHT_THIN__) {
      // 通常モードのみローカル選択＋下部アクションメニュー（権威版と同一操作）。シンクライアントは play.js が配線。
      cardButton.addEventListener("click", () => {
        if (cardButton.dataset.tooltipPreview) {
          delete cardButton.dataset.tooltipPreview; // 長押しプレビュー後の click はメニューを開かない
          return;
        }
        // 選択ダイアログの「盤面確認」中は詳細を見るだけ（手札から操作を始めさせない）。
        if (isBoardInspectMode()) {
          openReadOnlyCardSheet(card);
          return;
        }
        handCardMenuLocal(card.instanceId);
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

// 攻撃/行動の対抗ウィンドウで、この席がまだ【対抗】を使えるか（各ファイター1回まで等）。判定できなければ従来どおり true。
function handCounterStillAvailable(card) {
  try {
    return canUseCounterEffect(handOwnerIndex(), selectedCounterKind(card));
  } catch (error) {
    return true;
  }
}

// S-UB-C03: バディゾーンの裏向き札は持ち主だけが表を見られる（公式裁定 Q2629/Q2630）。持ち主には一覧を出す。
// ローカル: CPU 席以外は持ち主として扱う（同じ画面の対戦）。ネット対戦: view が自席の分だけ表を届ける。
function canViewBuddyZone(owner) {
  if (globalThis.__BUDDYFIGHT_THIN__) {
    return Number.isInteger(thinViewerSeat) && thinViewerSeat === owner;
  }
  if (typeof isReplayViewOnly === "function" && isReplayViewOnly()) return true;
  return !(typeof isAiSeat === "function" && isAiSeat(owner));
}

function showBuddyZoneDialog(owner) {
  const player = state.players?.[owner];
  if (!player || !elements.dropDialog) return;
  const cards = player.buddyZoneFaceDown || [];
  if (!canViewBuddyZone(owner) || cards.some((card) => card?.hidden || !card?.name)) {
    showToast(`バディゾーン ${cards.length}枚（裏向き。中身は持ち主だけが見られます）`);
    return;
  }
  hideCardTooltip();
  elements.dropDialogTitle.textContent = `${player.name}のバディゾーン（裏向き・${cards.length}枚・持ち主だけ表を見られます）`;
  elements.dropDialogList.innerHTML = "";
  if (cards.length === 0) {
    const empty = document.createElement("li");
    empty.className = "drop-dialog-empty";
    empty.textContent = "なし";
    elements.dropDialogList.append(empty);
  }
  cards.forEach((card, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drop-dialog-card";
    button.innerHTML = `
      <span class="drop-dialog-order">${index + 1}</span>
      <span class="drop-dialog-name">${escapeHtml(card.name)}</span>
      <span class="drop-dialog-type">${escapeHtml(typeLabels[displayCardType(card)] || "")}</span>
    `;
    attachTooltip(button, card, { touchPreview: true });
    button.addEventListener("click", () => openReadOnlyCardSheet(card));
    item.append(button);
    elements.dropDialogList.append(item);
  });
  if (!elements.dropDialog.open) elements.dropDialog.showModal();
}

// .has-overflow を「横にオーバーフローしていて、かつ末尾までスクロールしていない」時のみ付与。
// モバイルはスクロールバーが出ないため、続きがある手掛かりにする（CSS側 .hand-list.has-overflow）。
function applyHandScrollHint(list) {
  const more =
    list.scrollWidth > list.clientWidth + 2 &&
    list.scrollLeft + list.clientWidth < list.scrollWidth - 2;
  list.classList.toggle("has-overflow", more);
  // スマホの手札（7枚以上）: 左にも隠れた札がある時は左端もフェード（CSS .has-overflow-left）。
  list.classList.toggle("has-overflow-left", list.scrollLeft > 2);
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
  const displayType = displayCardType(card); // 必殺モンスターは機能上monsterだが、見た目は印字通り（横長フレーム等）

  // 必殺技・必殺モンスターは公式カードが横長なので、横長フレームで表示する。
  const landscape = ["impact", "impactMonster"].includes(displayType) ? " landscape" : "";
  cardElement.className = `card ${displayType} ${interactive ? "hand-card" : "board-card"}${landscape}`;
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
  // カード画像（ローカルWebP優先→公式URLフォールバック→プレースホルダ）。
  cardElement.append(createCardImageElement(card));
  if (interactive) {
    // 手札: 画像＋カード名（効果/コスト/ステータスはタップ時のポップアップ＝attachTooltip に任せる）。
    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = card.name;
    cardElement.append(name);
  } else if (cardHasDisplayStats(card)) {
    // 盤面: 画像＋攻/防/クリのステータスのみ（名前・効果・種別は非表示）。
    const stats = document.createElement("span");
    stats.className = "card-stats-board";
    stats.innerHTML =
      `<span class="st-pow">${statLabel(visiblePower(card))}</span>` +
      `<span class="sep">/</span>` +
      `<span class="st-def">${statLabel(visibleDefense(card))}</span>` +
      `<span class="sep">/</span>` +
      `<span class="st-crit">${statLabel(visibleCritical(card))}</span>`;
    cardElement.append(stats);
  }
  appendMobileTileParts(cardElement, card, interactive);
  if (soulNames.length) {
    const peek = document.createElement("span");
    peek.className = "card-stack-peek";
    // ソウルバッジはタップでソウル一覧を開く（配線は各クライアントのゾーンclickで data-soul-peek を拾う）。
    // <button> にすると盤面カードの <button> と入れ子になるため span のまま role/tabindex で押せるようにする。
    peek.dataset.soulPeek = "1";
    peek.setAttribute("role", "button");
    peek.tabIndex = 0;
    peek.title = `タップしてソウルを見る: ${soulNames.join(" / ")}`;
    peek.textContent = `ソウル ${soulNames.length}`;
    cardElement.append(peek);
  }
  // 手札カード(interactive=button)のみ、タッチ長押しでプレビュー（盤面のspanは対象外）。
  attachTooltip(cardElement, card, { touchPreview: interactive });
  return cardElement;
}

// ---- スマホ対戦画面（styles.css の body.bf-game・幅640px以下）だけで見せる補助表示 ----
// PC 幅では .m-tile-part / .ms-size / .phase-steps を CSS で display:none にしているので見た目は変わらない。
function setMobileCounter(element, label, count) {
  element.dataset.label = label;
  element.dataset.n = String(count);
}

// 両者のサイズ（場のサイズ合計／上限）。相手ヘッダーにも常時出す（スマホのみ表示）。
function renderMobileSeatSize(index, player) {
  const mini = document.querySelector(`#player${index + 1}Zone .mini-stats`);
  if (!mini || typeof mini.querySelector !== "function") {
    return;
  }
  let size = mini.querySelector(".ms-size");
  if (!size) {
    size = document.createElement("span");
    size.className = "ms-size";
    mini.append(size);
  }
  const used = getFieldSize(player);
  const limit = fieldSizeLimit(player);
  size.textContent = `サイズ ${used}/${limit}`;
  setMobileCounter(size, "サイズ", `${used}/${limit}`);
  size.classList.toggle("over", used > limit);
}

// ターン帯: 現在のフェイズだけ全文、他は1字（aria-label に全文）。
const MOBILE_PHASE_STEPS = [
  ["draw", "ド", "ドロー"],
  ["charge", "チ", "チャージ＆ドロー", "チャージ"],
  ["main", "メ", "メイン"],
  ["attack", "ア", "アタック"],
  ["final", "フ", "ファイナル"],
];
function renderMobilePhaseSteps() {
  const strip = document.querySelector(".status-strip");
  if (!strip || typeof strip.querySelector !== "function") {
    return;
  }
  let steps = strip.querySelector(".phase-steps");
  if (!steps) {
    steps = document.createElement("ol");
    steps.className = "phase-steps";
    steps.setAttribute("aria-label", "フェイズ");
    strip.append(steps);
  }
  const currentIndex = MOBILE_PHASE_STEPS.findIndex(([key]) => key === state.phase);
  steps.innerHTML = MOBILE_PHASE_STEPS.map(([key, short, full, label], index) => {
    const now = index === currentIndex;
    const cls = now ? "now" : index < currentIndex ? "done" : "next";
    return `<li class="${cls}"${now ? ' aria-current="step"' : ""} aria-label="${escapeHtml(full)}${now ? "（現在）" : ""}">${escapeHtml(now ? label || full : short)}</li>`;
  }).join("");
  strip.dataset.turn = `T${state.turnCount || 1}`;
  // 攻撃/行動の保留中（対抗の確認中）は、帯のフェイズ表示を「保留中」の案内に差し替える。
  const pending = state.pendingAttack ? "攻撃は保留中（対抗・解決待ち）" : state.pendingAction ? "行動は保留中（対抗・解決待ち）" : "";
  strip.dataset.pending = pending;
  strip.classList.toggle("is-pending", Boolean(pending));
}

function mobileCostShort(card) {
  const steps = (typeof primaryStructuredCost === "function" && primaryStructuredCost(card)) || [];
  let gauge = steps.filter((step) => step.op === "payGauge").reduce((sum, step) => sum + (Number(step.amount) || 1), 0);
  if (!gauge && typeof primaryCost === "function") {
    gauge = primaryCost(card)?.gauge || 0;
  }
  return gauge > 0 ? `G${gauge}` : "";
}

// 盤面＝名前＋サイズ＋「攻/打（大）・防（中）」の文字タイル、手札＝コスト・対抗・名前・攻/打 または種類。
function appendMobileTileParts(cardElement, card, interactive) {
  const part = (className, html) => {
    const element = document.createElement("span");
    element.className = `m-tile-part ${className}`;
    element.innerHTML = html;
    cardElement.append(element);
    return element;
  };
  const isMonster = effectiveCardType(card) === "monster";
  const typeName = typeLabels[displayCardType(card)] || "";
  if (interactive) {
    const counter = typeof handCardHasCounterOption === "function" && handCardHasCounterOption(card);
    part("ht-top", `<span class="ht-cost">${escapeHtml(mobileCostShort(card))}</span>${counter ? '<span class="ht-ctr">対抗</span>' : ""}`);
    part("ht-name", escapeHtml(card.name || ""));
    if (isMonster) {
      part("ht-foot", `攻${escapeHtml(statLabel(visiblePower(card)))}`);
      part("ht-foot2", `打${escapeHtml(statLabel(visibleCritical(card)))}・S${escapeHtml(statLabel(card.size))}`);
    } else {
      part("ht-foot", escapeHtml(typeName));
      part("ht-foot2", "");
    }
    return;
  }
  part("bt-name", escapeHtml(card.name || ""));
  if (isMonster && card.size !== undefined && card.size !== null) {
    part("bt-size", `S${escapeHtml(statLabel(card.size))}`);
  }
  // pt-final(5): スマホの盤面ではソウル枚数を札の上段（位置名の横）ではなくステータス欄に出す（上段のバッジが
  // 「レフト」等の位置名を「レ…」まで潰し、アイテム枠では名前に重なっていた）。PC は従来のバッジ（.card-stack-peek）。
  const soulCount = (card.soul || []).length;
  const soulChip = soulCount > 0 ? `<span class="bt-soul" title="ソウル${soulCount}枚" aria-label="ソウル${soulCount}枚"><i>ソ</i><b>${soulCount}</b></span>` : "";
  if (cardHasDisplayStats(card)) {
    const isItemTile = effectiveCardType(card) === "item";
    part(
      "bt-stats",
      (isItemTile ? soulChip : "") +
        `<span class="bt-row"><span><i>攻</i><b>${escapeHtml(statLabel(visiblePower(card)))}</b></span>` +
        `<span><i>打</i><b>${escapeHtml(statLabel(visibleCritical(card)))}</b></span></span>` +
        `<span class="bt-def"><span><i>防</i><b>${escapeHtml(statLabel(visibleDefense(card)))}</b></span>${isItemTile ? "" : soulChip}</span>`,
    );
  } else if (soulChip) {
    part("bt-stats bt-soul-only", soulChip);
  }
}

// 盤面でステータス（攻/防/クリ）を表示するカードか。モンスター・必殺モンスター・アイテム(武器)は表示、
// 呪文・必殺技・フラッグは非表示。
function cardHasDisplayStats(card) {
  return ["monster", "impactMonster", "item"].includes(effectiveCardType(card));
}

// 対戦画面のフラッグゾーンに出す絵を解決する。他カードと同じ画像ヘルパー(createCardImageElement)へ
// 渡せる card 風オブジェクトを返す（無ければ null＝画像なしでテキスト表示）。独自の画像ロードはしない。
//  1) フラッグ自身が id/no/imageUrl で解決できる場合（絵違いカード=別id等）はそのフラッグ自身の絵を使う。
//  2) 基底ワールドフラッグ(no/imageUrl無し)は data-load が作った同名の代表印字フラッグ参照へフォールバック。
function flagDisplayImageCard(flag) {
  if (!flag) {
    return null;
  }
  const resolvableBySelf =
    Boolean(flag.imageUrl) ||
    Boolean(flag.id && cardIdToPack[flag.id]) ||
    Boolean(flag.no && String(flag.no).indexOf("/") >= 0);
  if (resolvableBySelf) {
    return flag;
  }
  const ref = flag.name ? flagImageRefByName[flag.name] : null;
  if (ref && (ref.id || ref.no || ref.imageUrl)) {
    return { id: ref.id || null, no: ref.no || null, imageUrl: ref.imageUrl || null, name: flag.name };
  }
  return null;
}

// カード番号から公式カード画像URLを導出（ローカルWebPが無い場合のフォールバック）。
// 例: H-EB01/0002 -> .../images/card/heb_01_0002.png
function officialCardImageUrl(card) {
  if (card?.imageUrl) return card.imageUrl;
  const no = card?.no;
  if (!no || no.indexOf("/") < 0) {
    return null;
  }
  const [left, right] = no.split("/");
  const letters = left.replace(/-/g, "").match(/^([A-Za-z]+)(\d+)$/);
  const cardnum = String(right).match(/^\d+/);
  if (!letters || !cardnum) {
    return null;
  }
  const num = String(parseInt(cardnum[0], 10)).padStart(4, "0");
  return `https://fc-buddyfight.com/wordpress/wp-content/images/card/${letters[1].toLowerCase()}_${letters[2]}_${num}.png`;
}

function createCardImageElement(card) {
  const img = document.createElement("img");
  img.className = "card-img";
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = card?.name || "";
  const remote = officialCardImageUrl(card);
  img.dataset.remote = remote || "";
  const packed = card?.id ? cardImagePacks[card.id] : null;
  if (packed) {
    img.src = packed;
    img.addEventListener("error", onCardImageError);
  } else {
    // 製品画像パック未読込: 遅延ロードし、読めたら差し込む。無ければ公式URL→プレースホルダ。
    ensureImagePackLoaded(card).then(() => {
      const url = card?.id ? cardImagePacks[card.id] : null;
      if (url) {
        img.src = url;
        img.addEventListener("error", onCardImageError);
      } else if (remote) {
        img.src = remote;
        img.addEventListener("error", onCardImageError);
      } else {
        showCardImageFallback(img);
      }
    });
  }
  return img;
}

// カードの製品画像パック（data/images/{pack}.imgpack.json）を必要時に一度だけ読み込み、
// cardImagePacks に cardId→dataURL を展開する。多重fetchは imagePackPromises で防止。
function ensureImagePackLoaded(card) {
  const pack = card?.id ? cardIdToPack[card.id] : null;
  if (!pack || typeof fetch !== "function") {
    return Promise.resolve();
  }
  if (imagePackPromises[pack]) {
    return imagePackPromises[pack];
  }
  // imgpack も loadJson と同じく ?v=DATA_VERSION でバスト。付けないと serveStatic の immutable 1年
  // キャッシュ下で既存パック再生成が最長1年届かない（カードJSONはバージョン付きなので非対称になる）。
  const __v = globalThis.__BUDDYFIGHT_DATA_VERSION;
  const __packUrl = `data/images/${pack}.imgpack.json${__v ? `?v=${__v}` : ""}`;
  imagePackPromises[pack] = fetch(__packUrl, { cache: "force-cache" })
    .then((response) => (response.ok ? response.json() : {}))
    .then((map) => {
      Object.assign(cardImagePacks, map);
    })
    .catch(() => {});
  return imagePackPromises[pack];
}

function onCardImageError(event) {
  const img = event?.currentTarget;
  if (!img) {
    return;
  }
  const remote = img.dataset?.remote;
  // 画像失敗→まだ公式URLを試していなければ公式へ。既に公式なら名前プレースホルダ。
  if (remote && img.src !== remote) {
    img.src = remote;
    return;
  }
  showCardImageFallback(img);
}

// 画像が出せないカード: 画像を名前プレースホルダに差し替える（テストのダミーDOMでも例外を出さない）。
function showCardImageFallback(img) {
  if (!img) {
    return;
  }
  if (typeof img.removeEventListener === "function") {
    img.removeEventListener("error", onCardImageError);
  }
  // フラッグ絵は .card ではなく .flag-layer 内に置く（アイテム装備の重ね表示を壊さないため）。
  // 画像が出せない場合は画像だけ外し、キャプション(フラッグ名)＝現行のテキスト表示へ戻す。
  const flagHolder = typeof img.closest === "function" ? img.closest(".flag-layer") : null;
  if (flagHolder) {
    flagHolder.classList?.remove?.("has-flag-img");
    if (typeof img.remove === "function") {
      img.remove();
    }
    return;
  }
  const holder = typeof img.closest === "function" ? img.closest(".card") : null;
  if (holder && typeof holder.querySelector === "function" && !holder.querySelector(".card-img-fallback")) {
    holder.classList?.add?.("no-image");
    const fallback = document.createElement("span");
    fallback.className = "card-img-fallback";
    fallback.textContent = img.alt || "";
    if (typeof img.replaceWith === "function") {
      img.replaceWith(fallback);
    }
  }
}

// MR17-3: ソウルの「枚数」は公開情報（ver2.05 p.24 が非公開としているのは裏向き札の**内容**だけ）。
// 以前は名前の無い札（ネット対戦の view が伏せた {hidden:true}）を filter(Boolean) で落としており、
// バッジの枚数が実際より少なく出た。相手の全ソウルが裏向きだとバッジ自体が消え、
// ソウルガードを持つ相手モンスターが「ソウル0＝次で落ちる」に見えてしまう（攻撃判断が壊れる）。
// 中身が見えない札は「（裏向き）」として数に含める。
function stackedCardNames(card) {
  return (card.soul || []).map((soulCard) => soulCard?.name || "（裏向き）");
}

function attachTooltip(element, card, options = {}) {
  // デスクトップ: ホバーで表示。タップ後の互換マウスイベント（mouseenter）では出さない
  //（スマホでタップのたびに詳細が候補一覧やボタンを覆っていた。タッチの詳細は長押し／カードシートで見る）。
  let lastTouchAt = 0;
  const justTouched = () => Date.now() - lastTouchAt < 1000;
  element.addEventListener("mouseenter", (event) => {
    if (justTouched()) return;
    showCardTooltip(card, event);
  });
  element.addEventListener("mousemove", moveCardTooltip);
  element.addEventListener("mouseleave", hideCardTooltip);
  // フォーカス表示はキーボード操作用。タッチ由来のフォーカスでは出さない
  //（タップでフォーカスが残り blur が来ず「離しても詳細が出続ける」不具合の回避）。
  let touchActive = false;
  let holdTimer = null;
  element.addEventListener("focus", (event) => {
    if (!touchActive && !justTouched()) showCardTooltip(card, event);
  });
  element.addEventListener("blur", hideCardTooltip);
  // タッチ: touchPreview 指定要素（手札カード）だけ、長押し(約300ms)でプレビュー表示。
  //   指を離す/外れる/スクロール開始(pointercancel)で消える。横スクロールは閾値前に cancel されるため誤発火しない。
  element.addEventListener("pointerdown", (event) => {
    // 新しい操作の開始で前回の抑止フラグを必ずクリア（指が要素外で離れて click が来なかった
    // 場合の残留で“次タップを飲む”のを防ぐ。長押し成立時はこの後また立て直す）。
    delete element.dataset.tooltipPreview;
    if (event.pointerType === "mouse") return;
    lastTouchAt = Date.now();
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
    lastTouchAt = Date.now();
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
  elements.chargeButton.disabled = isChargeBlocked();
  elements.mainPhaseButton.disabled = Boolean(state.winner || inBattle || state.phase !== "charge");
  // 「使用 / 装備」は効果対象ドロップダウン未選択でも押せる（ユーザー方針: 場の【起動】がダイアログで対象を
  // 聞くのに、手札の使用/装備だけ先にドロップダウンで選ばないと押せないのは分かりづらい＝導線を揃える）。
  // 対象やコスト対象は使用時にダイアログで聞かれる（ability.target→chooseAbilityTarget /
  // dropOwnMonster コスト→payStructuredCostWithSelection の対話選択）。ドロップダウンは事前指定の近道として残す。
  elements.castButton.disabled = Boolean(!canUseSelectedCard(selectedCard));
  elements.resolveAttackButton.textContent = state.pendingAction ? "行動解決" : "攻撃解決";
  elements.resolveAttackButton.disabled = Boolean(
      state.winner ||
      state.resolvingPending ||
      !hasPendingResolution() ||
      (isNetworkConnected() && networkSession.seat !== networkResolutionSeat()),
  );
  elements.counterHandButton.textContent = state.pendingAttack ? "攻防手札切替" : "対抗手札切替";
  elements.counterHandButton.disabled = Boolean(
    state.winner ||
      isNetworkConnected() ||
      (typeof aiEnabled === "function" && aiEnabled()) || // CPU対戦: 手札は人間席固定のため切替不可
      (!hasPendingResolution() && !isCounterPlayTiming()),
  );
  elements.attackPhaseButton.disabled = Boolean(state.winner || inBattle || state.phase !== "main");
  elements.finalPhaseButton.disabled = Boolean(
    state.winner || inBattle || state.phase !== "attack",
  );
  elements.linkToggleButton.textContent = selectedLinked ? "連携から外す" : "連携に追加";
  elements.linkToggleButton.disabled = isLinkToggleBlocked(selectedCard);
  elements.partnerCallButton.textContent =
    state.buddyCallDeclared === selectedCard?.instanceId ? "バディ宣言中" : "バディコール宣言";
  elements.partnerCallButton.disabled = !canDeclareBuddyCall(activePlayer(), selectedCard);
  elements.attackButton.disabled = isAttackDeclareBlocked(attackingCards, Boolean(elements.attackTarget.value));
  elements.endTurnButton.disabled = Boolean(state.winner || inBattle || state.phase !== "final");

  // CPU対戦(src/22): CPUの手番/思考中は人間の操作ボタンを一括ロック（人間宛プロンプトと対抗応答は通す）。
  if (typeof aiShouldLockHumanControls === "function" && aiShouldLockHumanControls()) {
    [
      elements.drawButton,
      elements.chargeButton,
      elements.mainPhaseButton,
      elements.castButton,
      elements.attackPhaseButton,
      elements.finalPhaseButton,
      elements.linkToggleButton,
      elements.partnerCallButton,
      elements.attackButton,
      elements.endTurnButton,
      elements.resolveAttackButton,
      elements.counterHandButton,
    ].forEach((button) => {
      if (button) {
        button.disabled = true;
      }
    });
  }

  document.querySelectorAll("[data-call-zone]").forEach((button) => {
    button.disabled = isCallBlocked(selectedCard) || missingRequiredEffectTarget;
  });
}

// ---- 操作の可否（PC の操作パネルの disabled と、カードタップのメニュー/スマホのカードシートで共有する規則）----
// いずれも state.selected（いま選んでいる札）を前提に判定する。

function isChargeBlocked() {
  return Boolean(
    state.winner ||
      hasPendingResolution() ||
      state.phase !== "charge" ||
      state.chargedThisTurn ||
      state.selected?.source !== "hand" ||
      state.selected.owner !== state.active,
  );
}

function isLinkToggleBlocked(selectedCard) {
  return Boolean(
    state.winner ||
      hasPendingResolution() ||
      !["attack", "final"].includes(state.phase) ||
      (state.phase === "final" && !canDeclareAttackInFinal(selectedCard)) || // ファイナルは必殺モンスターのみ
      state.selected?.source !== "field" ||
      state.selected.owner !== state.active ||
      !selectedCard ||
      selectedCard.used ||
      // pt-final(1): 先攻1ターン目は攻撃1回だけ＝連携攻撃は宣言できない（「連携に追加」を出さない）。
      state.turnCount === 1,
  );
}

// hasTargetValue: 攻撃対象が既に指定済み（隠し select に値あり）なら候補の有無を問わない。
function isAttackDeclareBlocked(attackingCards, hasTargetValue = false) {
  return Boolean(
    state.winner ||
      hasPendingResolution() ||
      !["attack", "final"].includes(state.phase) ||
      (state.phase === "final" && attackingCards.some((attacker) => !canDeclareAttackInFinal(attacker.card))) ||
      (state.turnCount === 1 && state.attacksThisTurn >= 1) ||
      attackingCards.length === 0 ||
      // B2: 対象未指定でも候補があれば押下可（押下で対象選択モードへ）。値があれば従来どおり宣言。
      (!hasTargetValue && computeAttackTargetCandidates().length === 0),
  );
}

// コール（レフト/センター/ライト共通）の可否。効果対象の事前指定が必要な札（missingRequiredEffectTarget）は
// 呼び出し側で別に扱う（メニューは「重ねてコール」等で対象選択へ進めるため）。
function isCallBlocked(selectedCard) {
  const inBattle = hasPendingResolution();
  const canSpecialCall = specialCallOpportunityForCard(state.selected?.owner, selectedCard);
  // E-Y1(奇襲): 奇襲コールはドロップから行う（選択中の本人カードをコール）。
  const isAmbushCall = state.selected?.source === "drop" && canSpecialCall?.reason === "ambush";
  // 必殺モンスターは自分のファイナルフェイズにのみコール可（通常モンスターは従来通りメインのみ）。
  const callPhase = selectedCard?.type === "impactMonster" ? "final" : "main";
  return Boolean(
    (typeof aiShouldLockHumanControls === "function" && aiShouldLockHumanControls()) ||
      (state.winner && !canSpecialCall) ||
      (inBattle && !canSpecialCall) ||
      (state.phase !== callPhase && !canSpecialCall) ||
      (state.selected?.source !== "hand" && !isAmbushCall) ||
      (!canSpecialCall && state.selected.owner !== state.active) ||
      !selectedCard ||
      !canUseCardForFlag(state.players[state.selected?.owner ?? state.active], selectedCard) ||
      !isCallableMonster(selectedCard),
  );
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
  // pt-fix-c T7-7: ソウルからだけ使えるカード（秘剣 流星/月牙 等）は手札の「使用」を出さない。
  if (isSoulOnlyUseCard(selectedCard)) {
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
  if (!attacker?.card) {
    return true;
  }
  // cannotAttackZones は desugarCardFlags で continuous restrictAttackTargets(自身のみ) へ
  // 変換済みのため、ここでは汎用の攻撃対象制限のみを参照する。
  // fighter も restrictAttackTargets の対象に含む（zones:["...","fighter"] や竜騎士スレイマンの攻撃不可）。
  return !isAttackTargetRestricted(attacker, targetValue);
}

function isAttackTargetRestricted(attacker, targetValue) {
  return state.players.some((player) =>
    zones.some((zone) => {
      const sourceCard = player.field[zone];
      // E15: 印字 continuous だけでなく turnContinuous（addTurnContinuous で付与したターン限定継続）も合流する
      // activeContinuousEffects で読む（他の継続スキャナと同じ入口。能力無効化の除外も同関数が担う）。
      return activeContinuousEffects(sourceCard).some((effect) => {
        if (effect.op !== "restrictAttackTargets") {
          return false;
        }
        if (effect.zones && !zoneListIncludes(effect.zones, targetValue)) {
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
  if (attackers.length !== 1) {
    return [];
  }
  const attacker = attackers[0];
  if (!attacker.card.attackAllMonstersOnMonsterAttack) {
    return [];
  }
  // 「攻撃した時、かわりに相手のモンスター全てと相手に攻撃する」（attackAllIncludesFighter）は攻撃対象に関わらず
  // 置き換わる。ファイター宣言でも相手のモンスター全てを対象に含める（以前はモンスター宣言時だけだった）。
  if (targetValue === "fighter" && !attacker.card.attackAllIncludesFighter) {
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


// ==========================================================================
// 対抗窓改修: 誘発/ライフリンクの【対抗】窓の非モーダルバー（index.html / play.html 共通）。
// 設計: docs/対抗窓改修_設計_2026-10-08.md。盤面を塞がない小さなバー（上部固定）で「パス」「このターンはパス」と
// 使える【対抗】のチップを出す。使える札は手札/場で強調し、通常の「使用」操作でもそのまま窓への応答になる
// （ローカル=src/19 runNetworkMutation・src/20 のドロップ/ソウル起動、シン=play.js sendAction が横取りする）。
// 答えは候補 index（0=パス, 1=このターンはパス, 2..=対抗候補）。CPU 席の窓はバーを出さない（src/22 が即答）。
// ==========================================================================
let counterWindowUi = null; // { mode:"local"|"remote", entries, onAnswer, windowId, element }

function counterWindowBarAvailable() {
  return Boolean(
    typeof document !== "undefined" &&
      document.body &&
      typeof document.body.appendChild === "function" &&
      typeof document.createElement === "function" &&
      !globalThis.__BUDDYFIGHT_SERVER__,
  );
}

// スマホ対戦画面: 対抗窓バー・待つ側の表示・選択ドックは #dockSlot（手札とドックの間の行）へ差し込む。
// PC 幅では #dockSlot は display:contents で、バーは従来どおり画面下中央の fixed 表示（見た目不変）。
// #dockSlot の無い画面（netplay 等）やスタブ環境では document.body に追加する（従来どおり）。
function dockSlotElement() {
  const slot = typeof document.getElementById === "function" ? document.getElementById("dockSlot") : null;
  return slot && typeof slot.appendChild === "function" ? slot : document.body;
}

// スマホ幅（styles.css のスマホ対戦画面と同じ境界）か。matchMedia の無い環境（テスト/サーバ）は false。
function isPhoneLayout() {
  try {
    return Boolean(
      typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 640px)").matches &&
        document.body?.classList?.contains("bf-game"),
    );
  } catch (error) {
    return false;
  }
}

// 対抗窓を開いてから誤パスを防ぐ待ち時間（スマホのみ。オーナー裁定: 0.5秒）。
const COUNTER_WINDOW_PASS_GUARD_MS = 500;

// 候補 entry（ローカル: option 付き／シン: サーバの compact 候補）から札の所在を取り出す。
function counterWindowEntryRef(entry) {
  const option = entry?.option || null;
  return {
    source: entry?.counterSource || option?.source || null,
    owner: entry?.owner ?? option?.owner ?? null,
    zone: entry?.zone ?? option?.zone ?? null,
    instanceId: entry?.card?.instanceId || option?.instanceId || null,
  };
}

// 盤面の札（source/owner/instanceId[/zone]）が今の窓の候補なら、その候補 index を返す。
function counterWindowAnswerFor(ref) {
  if (!counterWindowUi || !ref) {
    return null;
  }
  const entry = counterWindowUi.entries.find((candidate) => {
    if (candidate.counterWindowAnswer !== "use") {
      return false;
    }
    const own = counterWindowEntryRef(candidate);
    if (own.source !== ref.source || Number(own.owner) !== Number(ref.owner)) {
      return false;
    }
    if (ref.source === "field" && ref.zone && own.zone && own.zone !== ref.zone) {
      return false;
    }
    return !ref.instanceId || own.instanceId === ref.instanceId;
  });
  return entry ? entry.choiceIndex : null;
}

function counterWindowUiUsable(source, owner, instanceId) {
  return counterWindowAnswerFor({ source, owner, instanceId }) !== null;
}

function answerCounterWindow(choiceIndex) {
  const ui = counterWindowUi;
  if (!ui) {
    return;
  }
  closeCounterWindowBar();
  try {
    ui.onAnswer(choiceIndex);
  } finally {
    if (typeof render === "function" && Array.isArray(state?.players)) {
      render();
    }
  }
}

// 窓の発生源カード（公開ゾーン＝場・ソウル・ドロップ・自分の手札）を instanceId で探す。見つからなければ null。
function findCounterWindowSourceCard(instanceId) {
  if (!instanceId || !Array.isArray(state?.players)) {
    return null;
  }
  for (const player of state.players) {
    for (const card of Object.values(player.field || {})) {
      if (!card) continue;
      if (card.instanceId === instanceId) return card;
      const inSoul = (card.soul || []).find((soulCard) => soulCard?.instanceId === instanceId);
      if (inSoul) return inSoul;
    }
    const pile = [...(player.drop || []), ...(player.hand || []), ...(player.flag ? [player.flag] : [])];
    const hit = pile.find((card) => card?.instanceId === instanceId && card.name);
    if (hit) return hit;
  }
  return null;
}

// バーを開く。entries は choiceIndex 付きの候補（0=パス,1=このターンはパス,2..=使う）。
// 独立レビュー L6: 盤面上部（相手のライフ等）を隠さないよう画面下部（手札/操作バーの上）に、1〜2行のコンパクトな帯で出す。
// 1行目=見出し＋発生源（タップで効果文）＋パス/このターンはパス、2行目=使える【対抗】のチップ（横スクロール）。
function openCounterWindowBar({ entries, title, lead, onAnswer, mode = "local", windowId = null, sourceInstanceId = null, sourceName = "" }) {
  closeCounterWindowBar();
  if (!counterWindowBarAvailable()) {
    onAnswer(0);
    return;
  }
  const bar = document.createElement("div");
  bar.className = "counter-window-bar";
  bar.id = "counterWindowBar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-live", "polite");
  bar.setAttribute("aria-label", "対抗の確認");
  const row = document.createElement("div");
  row.className = "cwb-row";
  const head = document.createElement("strong");
  head.className = "cwb-title";
  head.textContent = title || "【対抗】できます";
  const source = document.createElement("button");
  source.type = "button";
  source.className = "cwb-source";
  const sourceLabel = document.createElement("span");
  sourceLabel.className = "cwb-source-name";
  sourceLabel.textContent = sourceName || "能力";
  const sourceIcon = document.createElement("span");
  sourceIcon.className = "cwb-source-icon";
  sourceIcon.textContent = "ⓘ";
  source.append(sourceLabel, sourceIcon);
  source.title = lead || "発生源の効果文を見る";
  source.setAttribute("aria-label", `${lead || sourceName}（タップで効果文）`);
  source.addEventListener("click", () => {
    const card = findCounterWindowSourceCard(sourceInstanceId);
    if (card && typeof openReadOnlyCardSheet === "function") {
      openReadOnlyCardSheet(card);
    } else if (typeof addLog === "function" && lead) {
      addLog(lead);
      render();
    }
  });
  // スマホ: 窓が開いてから0.5秒はパス系を押せない（右下の連打で誤ってパスしない）。PC は従来どおり即押せる。
  const guarded = isPhoneLayout();
  const guardedAnswer = (index) => () => {
    if (bar.dataset.guard === "1") {
      return;
    }
    answerCounterWindow(index);
  };
  const pass = document.createElement("button");
  pass.type = "button";
  pass.className = "cwb-pass";
  pass.textContent = "パス";
  pass.addEventListener("click", guardedAnswer(0));
  const passTurn = document.createElement("button");
  passTurn.type = "button";
  passTurn.className = "cwb-pass-turn";
  passTurn.textContent = "このターンはパス";
  passTurn.title = "このターンの終わりまで、誘発・ライフリンクへの対抗確認を出しません";
  passTurn.addEventListener("click", guardedAnswer(1));
  if (guarded) {
    bar.dataset.guard = "1";
    [pass, passTurn].forEach((button) => button.setAttribute("aria-disabled", "true"));
    setTimeout(() => {
      delete bar.dataset.guard;
      [pass, passTurn].forEach((button) => button.removeAttribute("aria-disabled"));
    }, COUNTER_WINDOW_PASS_GUARD_MS);
  }
  row.append(head, source, pass, passTurn);
  const chips = document.createElement("div");
  chips.className = "cwb-options";
  (entries || [])
    .filter((entry) => entry.counterWindowAnswer === "use")
    .forEach((entry) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cwb-use";
      const where = entry.note || entry.zoneLabel || "";
      chip.textContent = `${entry.card?.name || "対抗"}${where ? `（${where}）` : ""}`;
      chip.title = "この【対抗】を使う";
      chip.addEventListener("click", () => answerCounterWindow(entry.choiceIndex));
      chips.append(chip);
    });
  bar.append(row, chips);
  dockSlotElement().appendChild(bar);
  document.body.classList?.add("counter-window-open");
  counterWindowUi = { mode, entries: entries || [], onAnswer, windowId, element: bar };
  if (typeof render === "function" && Array.isArray(state?.players)) {
    render(); // 使える札の強調を反映
  }
}

function closeCounterWindowBar() {
  const ui = counterWindowUi;
  counterWindowUi = null;
  if (ui?.element?.remove) {
    ui.element.remove();
  }
  if (typeof document !== "undefined") {
    document.body?.classList?.remove("counter-window-open");
    document.querySelectorAll?.(".counter-window-usable").forEach((el) => el.classList.remove("counter-window-usable"));
  }
}

// ローカル（index.html）の窓: バーを出して答えを待つ（src/16 answerCounterWindowLocally から）。
function showCounterWindowBar(presented, options = {}) {
  return new Promise((resolve) => {
    openCounterWindowBar({
      entries: presented,
      title: options.title,
      lead: options.lead,
      mode: "local",
      windowId: options.counterWindowInfo?.windowId || null,
      sourceInstanceId: options.counterWindowInfo?.sourceInstanceId || null,
      sourceName: options.counterWindowInfo?.sourceName || "",
      onAnswer: (choiceIndex) => {
        const entry = presented.find((candidate) => candidate.choiceIndex === choiceIndex) || presented[0];
        resolve([entry]);
      },
    });
  });
}

// 相手の窓を待つ側の表示（シンクライアント）。text が空なら消す。
function showCounterWindowWaiting(text) {
  if (!counterWindowBarAvailable()) {
    return;
  }
  let note = document.getElementById?.("counterWindowWaiting");
  if (!text) {
    note?.remove?.();
    return;
  }
  if (!note) {
    note = document.createElement("div");
    note.id = "counterWindowWaiting";
    note.className = "counter-window-bar is-waiting";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    dockSlotElement().appendChild(note);
  }
  note.textContent = text;
}

// render のたびに: 窓が閉じた（タイムアウト・再接続・新規対戦等）ならバーを閉じ、場の候補を強調し直す。
function syncCounterWindowBar() {
  if (typeof document === "undefined" || !document.querySelectorAll) {
    return;
  }
  const open = state?.counterWindow || null;
  if (counterWindowUi && (!open || (counterWindowUi.windowId && open.id !== counterWindowUi.windowId))) {
    const ui = counterWindowUi;
    closeCounterWindowBar();
    if (ui.mode === "local") {
      ui.onAnswer(0); // 取り残された窓はパス扱いで閉じる
    }
  }
  // 待つ側の表示は view（state.counterWindow）から毎回復元する（再接続・再読込でも消えない。独立レビュー L6）。
  // シンクライアントで、窓が自席宛てでない（相手の窓・観戦）時だけ出す。ローカルは応答席のバーがあるので出さない。
  const viewer = globalThis.__BUDDYFIGHT_THIN__ && Number.isInteger(thinViewerSeat) ? thinViewerSeat : null;
  if (open && globalThis.__BUDDYFIGHT_THIN__ && open.responder !== viewer) {
    showCounterWindowWaiting(viewer === null ? "対抗を検討中…" : "相手が対抗を検討中…");
  } else if (!open || open.responder === viewer) {
    showCounterWindowWaiting("");
  }
  document.querySelectorAll(".zone.counter-window-usable").forEach((el) => el.classList.remove("counter-window-usable"));
  if (!counterWindowUi) {
    return;
  }
  counterWindowUi.entries
    .filter((entry) => entry.counterWindowAnswer === "use")
    .map(counterWindowEntryRef)
    .filter((ref) => ref.source === "field" && ref.zone)
    .forEach((ref) => {
      document
        .querySelector?.(`.zone[data-owner="${ref.owner}"][data-zone="${ref.zone}"]`)
        ?.classList.add("counter-window-usable");
    });
}

// ローカルの操作を窓が横取りする（src/19 runNetworkMutation から）。true を返したら元の操作は行わない。
// 「カード使用」は選択中の札が候補なら窓への応答に変換、それ以外の操作は窓の間は受け付けない。
function counterWindowInterceptLocal(label, ref = null) {
  if (!counterWindowUi || counterWindowUi.mode !== "local") {
    return false;
  }
  const target = ref || (state?.selected ? { ...state.selected } : null);
  const index = label === "カード使用" ? counterWindowAnswerFor(target) : null;
  if (index !== null) {
    answerCounterWindow(index);
    return true;
  }
  addLog("【対抗】の確認中です。強調された【対抗】を使うか、「パス」を選んでください。");
  render();
  return true;
}

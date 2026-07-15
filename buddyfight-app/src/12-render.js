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
  if (typeof aiOnRender === "function") {
    aiOnRender(); // CPU対戦(src/22): 状態変化のたびにCPUの手番/応答を駆動（OFF時は即return）
  }
  if (typeof matchRecordCheckpoint === "function") {
    matchRecordCheckpoint(); // D5(戦績): 決着済み・整合局面で一度だけ戦績を確定（未決着/pending 中は即 return）
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
  zoneButton.title = "裏向きカードの枚数（相手にも公開）";
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
  flagLayer.innerHTML = `
    <span class="stack-layer-label">フラッグ</span>
    <span class="stack-layer-name">${escapeHtml(player.flag.name)}</span>
  `;
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
        useButton.addEventListener("click", () => activateDropAbilityFromPile(owner, card));
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
    if (counterWindow && handCardHasCounterOption(card)) {
      cardButton.classList.add("counter-playable");
      counterPlayable += 1;
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

// 盤面でステータス（攻/防/クリ）を表示するカードか。モンスター・必殺モンスター・アイテム(武器)は表示、
// 呪文・必殺技・フラッグは非表示。
function cardHasDisplayStats(card) {
  return ["monster", "impactMonster", "item"].includes(effectiveCardType(card));
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
  elements.linkToggleButton.disabled = Boolean(
      state.winner ||
      inBattle ||
      !["attack", "final"].includes(state.phase) ||
      (state.phase === "final" && !canDeclareAttackInFinal(selectedCard)) || // ファイナルは必殺モンスターのみ
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
      (state.phase === "final" && attackingCards.some((attacker) => !canDeclareAttackInFinal(attacker.card))) ||
      (state.turnCount === 1 && state.attacksThisTurn >= 1) ||
      attackingCards.length === 0 ||
      // B2: 対象未指定でも候補があれば押下可（押下で対象選択モードへ）。値があれば従来どおり宣言。
      (!elements.attackTarget.value && computeAttackTargetCandidates().length === 0),
  );
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
    const canSpecialCall = specialCallOpportunityForCard(state.selected?.owner, selectedCard);
    // E-Y1(奇襲): 奇襲コールはドロップから行う（選択中の本人カードをコール）。
    const isAmbushCall = state.selected?.source === "drop" && canSpecialCall?.reason === "ambush";
    // 必殺モンスターは自分のファイナルフェイズにのみコール可（通常モンスターは従来通りメインのみ）。
    const callPhase = selectedCard?.type === "impactMonster" ? "final" : "main";
    button.disabled = Boolean(
        (typeof aiShouldLockHumanControls === "function" && aiShouldLockHumanControls()) ||
        (state.winner && !canSpecialCall) ||
        (inBattle && !canSpecialCall) ||
        (state.phase !== callPhase && !canSpecialCall) ||
        (state.selected?.source !== "hand" && !isAmbushCall) ||
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

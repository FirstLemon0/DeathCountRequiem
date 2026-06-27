// ==========================================================================
// buddyfight モジュール 03 — 初期化・プレイヤー/デッキ生成・基本アクセサ
// 旧 app.js L587-880 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function initializeApp() {
  disableAllActions(true);
  elements.turnLabel.textContent = "データ読込中";
  elements.phaseLabel.textContent = "-";
  elements.selectionLabel.textContent = "カードJSONを読み込んでいます";
  try {
    await loadGameData();
    initializeDeckSelectors();
    initializeNetworkUi();
    disableAllActions(false);
    newGame();
  } catch (error) {
    elements.turnLabel.textContent = "読込失敗";
    elements.selectionLabel.textContent = error.message;
    elements.logList.innerHTML = "";
    const item = document.createElement("li");
    item.textContent = `カードデータを読み込めませんでした。ローカルサーバー経由で開いてください: ${error.message}`;
    elements.logList.append(item);
  }
}

function initializeDeckSelectors() {
  const defaults = preferredDefaultDecks();
  [elements.p1DeckSelect, elements.p2DeckSelect].forEach((select, index) => {
    select.innerHTML = "";
    deckProfiles.forEach((deck) => {
      const option = document.createElement("option");
      option.value = deck.id;
      option.textContent = deck.productName ? `${deck.name} / ${deck.productName}` : deck.name;
      select.append(option);
    });
    select.value = defaults[index]?.id || deckProfiles[index]?.id || "";
  });
}

function initializeNetworkUi() {
  if (!isNetworkPage()) {
    return;
  }
  updateNetworkStatus("未接続。部屋を作成するか、部屋番号を入力して参加してください。");
  elements.playerSeatLabel.textContent = "席: 未接続";
  elements.copyRoomButton.disabled = true;
  elements.roomInput.value = new URLSearchParams(window.location.search).get("room") || "";
}

function preferredDefaultDecks() {
  if (deckProfiles.length === 1) {
    return [deckProfiles[0], deckProfiles[0]];
  }
  return [deckProfiles[0], deckProfiles[deckProfiles.length - 1]];
}

function selectedDeckProfile(index) {
  const select = index === 0 ? elements.p1DeckSelect : elements.p2DeckSelect;
  return deckProfiles.find((deck) => deck.id === select.value) || deckProfiles[index];
}

function currentDeckValues() {
  return [elements.p1DeckSelect.value, elements.p2DeckSelect.value];
}

function applyDeckValues(deckValues = []) {
  if (deckValues[0] && deckProfiles.some((deck) => deck.id === deckValues[0])) {
    elements.p1DeckSelect.value = deckValues[0];
  }
  if (deckValues[1] && deckProfiles.some((deck) => deck.id === deckValues[1])) {
    elements.p2DeckSelect.value = deckValues[1];
  }
}

function disableAllActions(disabled) {
  document.querySelectorAll("button, select").forEach((control) => {
    control.disabled = disabled;
  });
}

function createCard(templateId) {
  const template = cardLibrary.find((card) => card.id === templateId);
  if (!template) {
    throw new Error(`カード定義が見つかりません: ${templateId}`);
  }
  const card = deepClone(template);
  return {
    ...card,
    baseType: card.type,
    currentType: card.currentType || card.type,
    instanceId: createInstanceId(),
    used: false,
    soul: [...(card.soul || [])],
    battlePowerBonus: 0,
    battleDefenseBonus: 0,
    battleCriticalBonus: 0,
    turnPowerBonus: 0,
    turnDefenseBonus: 0,
    turnCriticalBonus: 0,
    counterattack: false,
    doubleAttackUsed: false,
  };
}

function canUseCardForFlag(player, card) {
  if (!player || !card || effectiveCardType(card) === "flag") {
    return true;
  }
  const flag = player.flag;
  if (!flag || flag.allowAllWorlds) {
    return true;
  }
  const cardType = effectiveCardType(card);
  if ((flag.forbiddenTypes || []).includes(cardType)) {
    return false;
  }
  if ((flag.allowedCardTypes || []).length > 0 && !flag.allowedCardTypes.includes(cardType)) {
    return false;
  }
  if (flag.allowGeneric !== false && isGenericWorld(card.world)) {
    return true;
  }
  if ((flag.allowedWorlds || []).includes(card.world)) {
    return true;
  }
  const attributes = card.attributes || [];
  if ((flag.allowedAttributes || []).some((attribute) => attributes.includes(attribute))) {
    return true;
  }
  if (
    (flag.allowedAttributeIncludes || []).some((part) =>
      attributes.some((attribute) => attribute.includes(part)),
    )
  ) {
    return true;
  }
  const hasRestriction = [
    flag.allowedWorlds,
    flag.allowedAttributes,
    flag.allowedAttributeIncludes,
    flag.allowedCardTypes,
  ].some((value) => Array.isArray(value) && value.length > 0);
  return !hasRestriction;
}

function isGenericWorld(world) {
  return world === "ジェネリック" || world === "Generic";
}

function validateCardCanBeUsedByOwner(owner, card) {
  const player = state.players[owner];
  if (canUseCardForFlag(player, card)) {
    return true;
  }
  addLog(`${player.flag.name}では${card.name}を使えません。`);
  return false;
}

function createInstanceId() {
  return globalThis.crypto?.randomUUID?.() ?? `card-${Date.now()}-${Math.random()}`;
}

function makeDeck(recipe) {
  const deck = [];
  recipe.forEach(([id, count]) => {
    for (let index = 0; index < count; index += 1) {
      deck.push(createCard(id));
    }
  });
  return shuffle(deck);
}

function shuffle(cards) {
  const copy = [...cards];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function shuffleInPlace(cards) {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
  }
  return cards;
}

function createPlayer(name, profile) {
  const deck = makeDeck(profile.recipe);
  const flag = createCard(profile.flag);
  const player = {
    name,
    deckName: profile.name,
    flag,
    buddy: profile.buddy ? createCard(profile.buddy) : null,
    life: flag.startingLife ?? 10,
    deck,
    hand: [],
    gauge: [],
    drop: [],
    partnerCalled: false,
    arrivalCardId: null,
    oncePerTurn: {},
    field: {
      left: null,
      center: null,
      right: null,
      set1: null,
      set2: null,
      item: null,
    },
  };

  drawCards(player, flag.startingHand ?? 6, false);
  for (let index = 0; index < (flag.startingGauge ?? 2); index += 1) {
    const gaugeCard = player.deck.pop();
    if (gaugeCard) {
      player.gauge.push(gaugeCard);
    }
  }
  return player;
}

function newGame() {
  state = {
    players: [
      createPlayer("プレイヤー1", selectedDeckProfile(0)),
      createPlayer("プレイヤー2", selectedDeckProfile(1)),
    ],
    active: 0,
    phase: "charge",
    selected: null,
    chargedThisTurn: false,
    drewThisTurn: true,
    attacksThisTurn: 0,
    linkAttackers: [],
    buddyCallDeclared: null,
    pendingAttack: null,
    pendingAction: null,
    resolvingPending: false,
    counterHandOwner: null,
    turnCount: 1,
    fightLimits: [{}, {}],
    monsterAttackForbidden: [false, false],
    monsterAttackForbiddenSources: [[], []],
    damagePrevention: [[], []],
    lifeLinkEvents: [],
    specialCallOpportunities: [],
    counterEventWindow: null,
    destroyedEventWindow: null,
    enteredEventWindow: null,
    extraTurnOwner: null,
    winner: null,
    log: [],
    diagnosticLog: [],
    diagnosticSeq: 0,
    fightId: createFightId(),
  };
  addLog(`ゲーム開始。${ruleEraLabel}で進行します。`);
  addLog("先攻1ターン目はスタートフェイズのドローを行いません。プレイヤー1のチャージから開始します。");
  render();
}

function activePlayer() {
  return state.players[state.active];
}

function opponentIndex() {
  return 1 - state.active;
}

function opponentPlayer() {
  return state.players[opponentIndex()];
}

function handOwnerIndex() {
  if (globalThis.__BUDDYFIGHT_THIN__ && Number.isInteger(thinViewerSeat)) {
    return thinViewerSeat; // シンクライアントは常に視点席の手札を表示
  }
  if (isNetworkConnected() && Number.isInteger(networkSession.seat)) {
    return networkSession.seat;
  }
  return state.pendingAttack || state.pendingAction
    ? state.counterHandOwner ?? pendingResponderOwner()
    : state.counterHandOwner ?? state.active;
}

function handOwner() {
  return state.players[handOwnerIndex()];
}

function hasPendingResolution() {
  return Boolean(state.pendingAttack || state.pendingAction);
}


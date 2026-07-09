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
    // ローカル実プレイ: 記録用シードを生成し、先攻はシード乱数で決める（P1固定を廃止。B1）。
    newGame({ seed: generateRngSeed(), firstSeat: "random" });
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
  if (card.deckAnyFlag) {
    return true; // 角王(deckAnyFlag)はどのフラッグのデッキに入れても使用できる
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
  // B2: シードが確立している間は state 常駐カウンタから決定的な id を振る。理由: randomUUID だと
  // 同じシードで再生しても instanceId が変わり「再生結果が元と完全一致する」ことを機械検証できない。
  // カウンタは state に置く（rngCounter と同じく JSON 往復・部屋復元で保たれる）。
  // シード未設定（従来経路＝tests/既存スモーク/ローカルの旧挙動）は randomUUID のまま＝後方互換絶対。
  if (state && state.rngSeed != null) {
    state.instanceSeq = (state.instanceSeq || 0) + 1;
    return `c${state.instanceSeq}`;
  }
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
    const swapIndex = rngInt(index + 1); // シード確立時は決定的、未設定時は Math.random 素通し（B1）
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function shuffleInPlace(cards) {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swapIndex = rngInt(index + 1); // 同上（B1: 山札シャッフルの再現性）
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
    // Z2(S-UB-C03): バディゾーンの裏向きパイル（カード実体の配列）。「登録バディ名一致」を表す
    // 既存 filter.buddy / player.partnerCalled とは別概念。読む側は必ず (player.buddyZoneFaceDown || []) で
    // ガードする（旧セーブ/権威サーバ再構築state等、本フィールドを持たない旧state との互換のため）。
    buddyZoneFaceDown: [],
    field: {
      left: null,
      center: null,
      right: null,
      set1: null,
      set2: null,
      item: null,
      item2: null,
      item3: null,
      item4: null,
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

// 先攻席の決定（B1）。0/1 は固定、"random" は rng 抽選、それ以外（未指定）は従来どおり 0。
// 後方互換: 呼び出し側が firstSeat を渡さない限り seat0 固定＝既存の tests/スモークは不変。
function resolveFirstSeat(preference) {
  if (preference === 0 || preference === "0") {
    return 0;
  }
  if (preference === 1 || preference === "1") {
    return 1;
  }
  if (preference === "random") {
    return rngInt(2);
  }
  return 0;
}

// options.seed: 乱数シード（省略時は素通し＝従来挙動）。options.firstSeat: 0|1|"random"（省略時 seat0）。
function newGame(options = {}) {
  if (typeof aiBeforeNewGame === "function") {
    aiBeforeNewGame(); // CPU対戦(src/22): CPU席の反映・CPUデッキのランダム選択（OFF時は素通り）
  }
  // シードは最初のシャッフル（createPlayer→makeDeck→shuffle は rngNext→state.rngSeed を読む）より
  // 前に state へ確立する必要がある。そのため骨格 state を先に代入してから players を埋める（順序が命）。
  const seed = normalizeRngSeed(options.seed);
  state = {
    players: [],
    active: 0,
    rngSeed: seed,
    rngCounter: 0,
    // B2: 決定的 instanceId のカウンタ（createInstanceId がシード確立時に消費）。state に載せて JSON 往復で保つ。
    instanceSeq: 0,
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
    turnDamageEvents: [],
    destroyedEventWindow: null,
    destroyedCardsThisTurn: [[], []],
    enteredEventWindow: null,
    extraTurnOwner: null,
    winner: null,
    // D5(戦績): state.winner はプレイヤー名文字列でデッキと紐付かないため、決着時の勝者席・理由・
    // 使用デッキ・先攻席を別に控える。matchResult は決着フック(src/24)が一度だけ確定させる
    // 決定論レコード（冪等マーカ兼用）。いずれも決着まで null／確定値のまま JSON 往復・部屋復元で保つ。
    winnerSeat: null,
    winReason: null,
    matchResult: null,
    deckIds: [null, null],
    firstSeat: 0,
    log: [],
    diagnosticLog: [],
    diagnosticSeq: 0,
    fightId: createFightId(),
  };
  // シード確立後に players を組み立てる（この中の shuffle が確定シードを使う）。
  // 使用デッキプロファイルは createPlayer と同じものを控える（CPUランダムデッキ選択後の select 値で
  // 確定済み。selectedDeckProfile を二度呼んで食い違わせない）。
  const deckProfilesInUse = [selectedDeckProfile(0), selectedDeckProfile(1)];
  state.players = [
    createPlayer("プレイヤー1", deckProfilesInUse[0]),
    createPlayer("プレイヤー2", deckProfilesInUse[1]),
  ];
  state.deckIds = [deckProfilesInUse[0]?.id ?? null, deckProfilesInUse[1]?.id ?? null];
  // 先攻はオプトイン。CPU対戦時は下の aiAfterNewGame が CPU-UI の選択で上書きする。
  state.active = resolveFirstSeat(options.firstSeat);
  // シードは不具合報告・リプレイ用にログへ残すが、権威サーバでは絶対に残さない。
  // state.log は viewFor で伏せられず両席へ配信される。シードが相手に見えると、
  // 消費数（シャッフル2回＝98、先攻抽選＋1）が決定的なので以降の全シャッフル/ドローを
  // 先読みできてしまう（viewFor が rngSeed/rngCounter を消しても意味がない）。
  // サーバ側はシードを stdout と state.rngSeed（スナップショット）で追える。
  if (seed != null && !globalThis.__BUDDYFIGHT_SERVER__) {
    addLog(`乱数シード: ${seed}`);
  }
  addLog(`ゲーム開始。${ruleEraLabel}で進行します。`);
  if (typeof aiAfterNewGame === "function") {
    aiAfterNewGame(); // CPU対戦(src/22): 先攻の適用（ランダム/選択）・AIターンスコープのリセット
  }
  // D5(戦績): 先攻席は firstSeat オプション／CPU対戦フックで確定するため、aiAfterNewGame の後で控える
  // （active はターンで変わるので別フィールドに固定する）。
  state.firstSeat = state.active;
  // 先攻は firstSeat オプション／CPU対戦フックで変わりうるため、確定後の activePlayer 名でログする
  // （firstSeat 省略時は seat0＝プレイヤー1固定で従来どおり）。
  addLog(`先攻1ターン目はスタートフェイズのドローを行いません。${activePlayer().name}のチャージから開始します。`);
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
  if (typeof aiEnabled === "function" && aiEnabled()) {
    const humanSeat = aiHumanSeat();
    if (Number.isInteger(humanSeat)) {
      return humanSeat; // CPU対戦: 手札表示は常に人間席（相互非公開=Q7。CPU手札は裏向きプレビュー）
    }
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


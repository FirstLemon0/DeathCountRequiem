const dataFiles = {
  cardsets: "data/cardsets.json",
  decksets: "data/decksets.json",
  flags: "data/flags.json",
};

const customDeckStorageKey = "buddyfight.customDecks.v1";

const typeLabels = {
  monster: "モンスター",
  spell: "魔法",
  item: "アイテム",
  impact: "必殺技",
  impactMonster: "必殺モンスター",
  flag: "フラッグ",
};

const elements = {
  deckNameInput: document.querySelector("#deckNameInput"),
  flagSelect: document.querySelector("#flagSelect"),
  buddySelect: document.querySelector("#buddySelect"),
  deckCountLabel: document.querySelector("#deckCountLabel"),
  deckStats: document.querySelector("#deckStats"),
  validationList: document.querySelector("#validationList"),
  searchInput: document.querySelector("#searchInput"),
  typeFilter: document.querySelector("#typeFilter"),
  worldFilter: document.querySelector("#worldFilter"),
  productFilter: document.querySelector("#productFilter"),
  generationTabs: document.querySelector("#generationTabs"),
  resultCountLabel: document.querySelector("#resultCountLabel"),
  cardResults: document.querySelector("#cardResults"),
  deckList: document.querySelector("#deckList"),
  deckJsonText: document.querySelector("#deckJsonText"),
  builderStatus: document.querySelector("#builderStatus"),
  savedDeckSelect: document.querySelector("#savedDeckSelect"),
  newDeckButton: document.querySelector("#newDeckButton"),
  saveDeckButton: document.querySelector("#saveDeckButton"),
  exportDeckButton: document.querySelector("#exportDeckButton"),
  importDeckButton: document.querySelector("#importDeckButton"),
  downloadDeckButton: document.querySelector("#downloadDeckButton"),
  loadSavedDeckButton: document.querySelector("#loadSavedDeckButton"),
  deleteSavedDeckButton: document.querySelector("#deleteSavedDeckButton"),
  sortDeckButton: document.querySelector("#sortDeckButton"),
  shareCodeInput: document.querySelector("#shareCodeInput"),
  issueShareCodeButton: document.querySelector("#issueShareCodeButton"),
  importShareCodeButton: document.querySelector("#importShareCodeButton"),
};

let cards = [];
let officialDecks = [];
let currentDeck = emptyDeck();
let flagIdAliases = new Map();
let activeGeneration = ""; // 世代タブの選択（空=すべて）。製品が増えても世代で製品リストを絞る。

async function initializeBuilder() {
  setStatus("カードデータ読込中");
  try {
    await loadGameData();
    populateFilters();
    renderGenerationTabs();
    populateDeckOptions();
    populateSavedDecks();
    loadFirstAvailableDeck();
    bindEvents();
    render();
    setStatus("準備完了");
  } catch (error) {
    setStatus(`読込失敗: ${error.message}`);
  }
}

async function loadGameData() {
  const [cardsetsData, decksetsData, flagsData] = await Promise.all([
    loadJson(dataFiles.cardsets),
    loadJson(dataFiles.decksets),
    loadJson(dataFiles.flags),
  ]);
  const cardSets = await Promise.all((cardsetsData.sets || []).map(loadSetFile));
  const deckSets = await Promise.all((decksetsData.sets || []).map(loadSetFile));
  const flags = normalizeFlagDefinitions(flagsData);
  flagIdAliases = buildFlagIdAliases(flags);
  cards = [
    ...flags,
    ...cardSets.flatMap(({ set, data }) =>
      (data.cards || [])
        .filter((card) => card.type !== "flag")
        .map((card) => normalizeCard(card, set)),
    ),
  ];
  officialDecks = deckSets.flatMap(({ set, data }) =>
    (data.decks || []).map((deck) => normalizeDeck(deck, set)),
  );
}

async function loadSetFile(set) {
  return { set, data: await loadJson(set.file) };
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} を読み込めませんでした。`);
  }
  return response.json();
}

function normalizeCard(card, set = {}) {
  return {
    ...card,
    productId: card.productId || set.id || "",
    productName: card.productName || set.name || "",
    generation: card.generation || set.generation || "",
    aliases: [...(card.aliases || [])],
    attributes: [...(card.attributes || [])],
    keywords: [...(card.keywords || [])],
    rules: [...(card.rules || [])],
    allowedWorlds: [...(card.allowedWorlds || [])],
    allowedAttributes: [...(card.allowedAttributes || [])],
    allowedAttributeIncludes: [...(card.allowedAttributeIncludes || [])],
    allowedCardTypes: [...(card.allowedCardTypes || [])],
    forbiddenTypes: [...(card.forbiddenTypes || [])],
  };
}

function normalizeFlagDefinitions(flagsData = {}) {
  const set = flagsData.product || { id: "common-flags", name: "共通フラッグ" };
  return (flagsData.flags || []).map((flag) => normalizeCard(flag, set));
}

function buildFlagIdAliases(flags) {
  const aliases = new Map();
  flags.forEach((flag) => {
    aliases.set(flag.id, flag.id);
    (flag.aliases || []).forEach((alias) => aliases.set(alias, flag.id));
  });
  return aliases;
}

function canonicalFlagId(id) {
  return flagIdAliases.get(id) || id;
}

function normalizeDeck(deck, set = {}) {
  return {
    ...deck,
    flag: canonicalFlagId(deck.flag || ""),
    productId: deck.productId || set.id || "",
    productName: deck.productName || set.name || "",
    recipe: [...(deck.recipe || [])],
  };
}

function emptyDeck() {
  return {
    id: createDeckId("custom"),
    name: "新しいデッキ",
    flag: "",
    buddy: "",
    recipe: [],
  };
}

function createDeckId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function bindEvents() {
  elements.deckNameInput.addEventListener("input", () => {
    currentDeck.name = elements.deckNameInput.value.trim() || "無題デッキ";
    renderExportText();
  });
  elements.flagSelect.addEventListener("change", () => {
    currentDeck.flag = elements.flagSelect.value;
    render();
  });
  elements.buddySelect.addEventListener("change", () => {
    currentDeck.buddy = elements.buddySelect.value;
    render();
  });
  [elements.searchInput, elements.typeFilter, elements.worldFilter, elements.productFilter].forEach(
    (control) => control.addEventListener("input", renderSearchResults),
  );
  elements.newDeckButton.addEventListener("click", () => {
    currentDeck = emptyDeck();
    currentDeck.flag = flagCards()[0]?.id || "";
    currentDeck.buddy = buddyCards()[0]?.id || "";
    render();
    setStatus("新しいデッキを作成しました。");
  });
  elements.saveDeckButton.addEventListener("click", saveCurrentDeck);
  elements.exportDeckButton.addEventListener("click", exportDeckToText);
  elements.downloadDeckButton.addEventListener("click", downloadCurrentDeck);
  elements.importDeckButton.addEventListener("click", importDeckFromText);
  elements.loadSavedDeckButton.addEventListener("click", loadSelectedSavedDeck);
  elements.deleteSavedDeckButton.addEventListener("click", deleteSelectedSavedDeck);
  elements.sortDeckButton.addEventListener("click", () => {
    sortRecipe();
    render();
  });
  elements.issueShareCodeButton?.addEventListener("click", exportDeckShareCode);
  elements.importShareCodeButton?.addEventListener("click", importDeckShareCode);
}

function populateFilters() {
  setOptions(elements.typeFilter, [
    ["", "すべての種類"],
    ...unique(cards.map((card) => card.type)).map((type) => [type, typeLabels[type] || type]),
  ]);
  setOptions(elements.worldFilter, [
    ["", "すべてのワールド"],
    ...unique(cards.map((card) => card.world).filter(Boolean)).map((world) => [world, world]),
  ]);
  populateProductFilter();
}

// 選択中の世代(空=すべて)に属する製品 [productId, productName] 一覧。
function productsForGeneration(generation) {
  const seen = new Map();
  cards.forEach((card) => {
    if (!card.productId) return;
    if (generation && card.generation !== generation) return;
    if (!seen.has(card.productId)) seen.set(card.productId, card.productName || card.productId);
  });
  return [...seen.entries()];
}

// 製品ドロップダウンを現在の世代タブで絞って再構築。以前の選択が新世代に無ければ「すべて」へ。
function populateProductFilter() {
  const prev = elements.productFilter.value;
  const opts = productsForGeneration(activeGeneration);
  setOptions(elements.productFilter, [["", "すべての製品"], ...opts]);
  elements.productFilter.value = opts.some(([id]) => id === prev) ? prev : "";
}

// 世代タブ（製品が増えても製品リストが長くなりすぎないよう、世代で先に絞る）。
function renderGenerationTabs() {
  const host = elements.generationTabs;
  if (!host) return;
  const gens = unique(cards.map((card) => card.generation).filter(Boolean));
  if (gens.length <= 1) {
    host.innerHTML = ""; // 1世代しか無いうちはタブを出さない
    return;
  }
  host.innerHTML = "";
  [["", "すべて"], ...gens.map((g) => [g, g])].forEach(([value, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "generation-tab" + (value === activeGeneration ? " active" : "");
    btn.textContent = label;
    btn.setAttribute("aria-pressed", String(value === activeGeneration));
    btn.addEventListener("click", () => {
      activeGeneration = value;
      populateProductFilter();
      renderGenerationTabs();
      renderSearchResults();
    });
    host.append(btn);
  });
}

function populateDeckOptions() {
  setOptions(
    elements.flagSelect,
    flagCards().map((card) => [card.id, `${card.name} / ${card.productName}`]),
  );
  setOptions(
    elements.buddySelect,
    buddyCards().map((card) => [card.id, `${card.name} / ${card.productName}`]),
  );
}

function populateSavedDecks() {
  const savedDecks = loadSavedDecks();
  setOptions(elements.savedDeckSelect, [
    ["", "保存済みデッキ"],
    ...officialDecks.map((deck) => [deck.id, `公式: ${deck.name}`]),
    ...savedDecks.map((deck) => [deck.id, `保存: ${deck.name}`]),
  ]);
}

function setOptions(select, entries) {
  select.innerHTML = "";
  entries.forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  });
}

function loadFirstAvailableDeck() {
  const first = officialDecks[0];
  if (first) {
    currentDeck = cloneDeck(first);
  } else {
    currentDeck.flag = flagCards()[0]?.id || "";
    currentDeck.buddy = buddyCards()[0]?.id || "";
  }
}

function cloneDeck(deck) {
  return {
    id: deck.id?.startsWith("custom-") ? deck.id : createDeckId("custom"),
    name: deck.name || "無題デッキ",
    flag: canonicalFlagId(deck.flag || ""),
    buddy: deck.buddy || "",
    recipe: [...(deck.recipe || [])].map(([id, count]) => [id, Number(count)]),
  };
}

function render() {
  elements.deckNameInput.value = currentDeck.name;
  elements.flagSelect.value = currentDeck.flag;
  elements.buddySelect.value = currentDeck.buddy;
  renderStats();
  renderValidation();
  renderSearchResults();
  renderDeckList();
  renderExportText();
}

function renderStats() {
  const stats = deckStats();
  elements.deckCountLabel.textContent = `${stats.total}枚`;
  const typeSummary = Object.entries(stats.byType)
    .map(([type, count]) => `${typeLabels[type] || type}: ${count}`)
    .join(" / ");
  const worldSummary = Object.entries(stats.byWorld)
    .map(([world, count]) => `${world}: ${count}`)
    .join(" / ");
  const sizeSummary = Object.entries(stats.bySize)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([size, count]) => `サイズ${size}: ${count}`)
    .join(" / ");
  elements.deckStats.innerHTML = "";
  [
    `合計 ${stats.total}`,
    typeSummary || "種類なし",
    worldSummary || "ワールドなし",
    sizeSummary || "モンスターなし",
  ].forEach((text) => {
    const item = document.createElement("span");
    item.className = "stat-pill";
    item.textContent = text;
    elements.deckStats.append(item);
  });
}

function deckStats() {
  const byType = {};
  const byWorld = {};
  const bySize = {};
  currentDeck.recipe.forEach(([id, count]) => {
    const card = findCard(id);
    if (!card) {
      return;
    }
    byType[card.type] = (byType[card.type] || 0) + count;
    byWorld[card.world] = (byWorld[card.world] || 0) + count;
    if (["monster", "impactMonster"].includes(card.type)) {
      const size = card.size ?? "-";
      bySize[size] = (bySize[size] || 0) + count;
    }
  });
  return { total: deckCount(), byType, byWorld, bySize };
}

function renderValidation() {
  const validations = validateDeck(currentDeck);
  elements.validationList.innerHTML = "";
  validations.forEach((item) => {
    const row = document.createElement("div");
    row.className = `validation-item ${item.level}`;
    row.textContent = item.message;
    elements.validationList.append(row);
  });
}

function validateDeck(deck) {
  const items = [];
  const total = deckCount();
  const flag = findCard(deck.flag);
  const buddy = findCard(deck.buddy);
  addValidation(items, total >= 50, `メインデッキ: ${total}枚 / 50枚以上`);
  addValidation(items, Boolean(flag && flag.type === "flag"), "フラッグ: 1枚");
  addValidation(
    items,
    Boolean(buddy && ["monster", "impactMonster"].includes(buddy.type)),
    "バディ: モンスターまたは必殺モンスター1枚",
  );

  const overLimitNames = cardNameCounts()
    .map((entry) => ({ ...entry, limit: cardCopyLimitForFlag(flag, entry.card) }))
    .filter((entry) => entry.count > entry.limit)
    .map((entry) => `${entry.name} ${entry.count}枚(上限${entry.limit})`);
  addValidation(
    items,
    overLimitNames.length === 0,
    overLimitNames.length ? `同名上限超過: ${overLimitNames.join(" / ")}` : "同名カード: 上限以内（通常4枚／角王はホーム外1枚）",
  );

  const invalidWorlds = flag ? unusableCardsForFlag(flag) : [];
  if (invalidWorlds.length) {
    items.push({
      level: "warn",
      message: `フラッグで使えない可能性: ${invalidWorlds.slice(0, 4).join(" / ")}${invalidWorlds.length > 4 ? " ほか" : ""}`,
    });
  } else {
    items.push({ level: "ok", message: "ワールド条件: 問題なし" });
  }

  if (buddy && !deckContainsName(buddy.name)) {
    items.push({ level: "warn", message: "バディと同名のカードがメインデッキにありません。" });
  }
  if (deck.recipe.some(([id]) => findCard(id)?.type === "flag")) {
    items.push({ level: "error", message: "メインデッキにフラッグは入れられません。" });
  }
  return items;
}

function addValidation(items, ok, message) {
  items.push({ level: ok ? "ok" : "error", message });
}

function cardNameCounts() {
  const counts = new Map();
  currentDeck.recipe.forEach(([id, count]) => {
    const card = findCard(id);
    const name = card?.name || id;
    const prev = counts.get(name) || { count: 0, card };
    counts.set(name, { count: prev.count + count, card: prev.card || card });
  });
  return [...counts.entries()].map(([name, value]) => ({
    name,
    count: value.count,
    card: value.card,
  }));
}

function unusableCardsForFlag(flag) {
  return currentDeck.recipe
    .map(([id]) => findCard(id))
    .filter((card) => card && !isCardAllowedByFlag(flag, card) && card.type !== "flag")
    .map((card) => card.name);
}

function isCardAllowedByFlag(flag, card) {
  // 『角王』(deckAnyFlag): ワールドに関係なくどのフラッグのデッキにも入れられる。
  // 投入枚数の制限（ホーム以外なら1枚等）は cardCopyLimitForFlag が別途判定する。
  if (card?.deckAnyFlag) {
    return true;
  }
  return isCardNativelyAllowedByFlag(flag, card);
}

// フラッグの本来の使用可能条件（ワールド/属性/カード種）。『角王』の上書きは含まない。
// この判定が真＝そのフラッグに「ネイティブに」入るカード（＝角王のホーム判定）。
function isCardNativelyAllowedByFlag(flag, card) {
  if (!flag || !card || card.type === "flag" || flag.allowAllWorlds) {
    return true;
  }
  if ((flag.forbiddenTypes || []).includes(card.type)) {
    return false;
  }
  if ((flag.allowedCardTypes || []).length > 0 && !flag.allowedCardTypes.includes(card.type)) {
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

// フラッグが指定ワールドの「正規フラッグ」か（allowedWorlds に明示しているか）。
// 重要: ドラゴンアイン/ツヴァイ・百鬼・天国・地獄・カオス等、末尾に「W／ワールド」が付かない
// 特殊フラッグは allowedWorlds を持たない。これらを安易に特定ワールド（ドラゴンW等）へ同一視しない。
function flagIsOfWorld(flag, world) {
  if (!flag || !world) {
    return false;
  }
  if (flag.allowAllWorlds) {
    return true;
  }
  return (flag.allowedWorlds || []).includes(world);
}

// 『角王』(deckAnyFlag)カードにとって、そのフラッグが「ホーム」か。
// 公式: 君のフラッグがそのカードのワールド（角王なら竜牙雷帝を含むドラゴンＷのフラッグ）なら通常枚数。
// データ駆動の判定:
//   1) フラッグが homeWorld の正規フラッグ（allowedWorlds に明示） … 例 dragon-world
//   2) フラッグが homeAttribute（角王アーキタイプ）を allowedAttributes に明示 … 例 竜牙雷帝
// アイン/ツヴァイは竜/ドラゴン属性を許すだけで角王を挙げていないため非ホーム（＝制限）。
function flagIsHomeForDeckAnyFlag(flag, card) {
  const rule = card?.deckAnyFlag;
  if (!flag || !rule) {
    return false;
  }
  if (flag.allowAllWorlds) {
    return true;
  }
  const homeWorld = rule.homeWorld || card?.world;
  if (flagIsOfWorld(flag, homeWorld)) {
    return true;
  }
  if (rule.homeAttribute && (flag.allowedAttributes || []).includes(rule.homeAttribute)) {
    return true;
  }
  return false;
}

// カードのデッキ投入上限枚数（既定4）。『角王』(deckAnyFlag)カードは、君のフラッグが
// ホーム（flagIsHomeForDeckAnyFlag）なら4枚、それ以外なら deckAnyFlag.awayMaxCopies（既定1）。
// 公式テキスト「君のフラッグが＜ドラゴンＷ＞以外なら1枚」（竜牙雷帝はドラゴンＷの角王フラッグ＝4枚）に対応。
function cardCopyLimitForFlag(flag, card) {
  const base = 4;
  const rule = card?.deckAnyFlag;
  if (!rule) {
    return base;
  }
  if (flag && !flagIsHomeForDeckAnyFlag(flag, card)) {
    return rule.awayMaxCopies ?? 1;
  }
  return base;
}

function deckContainsName(name) {
  return currentDeck.recipe.some(([id]) => findCard(id)?.name === name);
}

function renderSearchResults() {
  const filtered = filteredCards();
  elements.resultCountLabel.textContent = `${filtered.length}件`;
  elements.cardResults.innerHTML = "";
  filtered.slice(0, 140).forEach((card) => elements.cardResults.append(createCardResult(card)));
}

function filteredCards() {
  const text = elements.searchInput.value.trim().toLowerCase();
  const type = elements.typeFilter.value;
  const world = elements.worldFilter.value;
  const productId = elements.productFilter.value;
  return cards
    // 世代で絞る（フラッグは全世代共通なので常に通す）
    .filter((card) => !activeGeneration || card.generation === activeGeneration || card.type === "flag")
    .filter((card) => !type || card.type === type)
    .filter((card) => !world || card.world === world)
    .filter((card) => !productId || card.productId === productId)
    .filter((card) => {
      if (!text) {
        return true;
      }
      const haystack = [card.name, card.no, card.world, card.productName, ...(card.attributes || [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(text);
    })
    .sort(compareCards);
}

function createCardResult(card) {
  const node = document.createElement("article");
  node.className = "builder-card";
  node.innerHTML = `
    <div class="builder-card-head">
      <div class="builder-card-title">
        <strong>${escapeHtml(card.name)}</strong>
        <span class="meta-line">${escapeHtml(cardSummaryLine(card))}</span>
      </div>
      <span class="meta-line">${deckCardCount(card.id)}枚</span>
    </div>
    <div class="card-stat-grid">${cardStatHtml(card)}</div>
    <div class="meta-line">${escapeHtml(card.productName || "-")} / ${escapeHtml((card.attributes || []).join(" / ") || "-")}</div>
    <div class="rules-line">${escapeHtml(cardRules(card))}</div>
  `;
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = "追加";
  addButton.disabled = card.type === "flag";
  addButton.addEventListener("click", () => addCard(card.id, 1));
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.textContent = "減らす";
  removeButton.disabled = deckCardCount(card.id) === 0;
  removeButton.addEventListener("click", () => addCard(card.id, -1));
  const flagButton = document.createElement("button");
  flagButton.type = "button";
  flagButton.textContent = "フラッグ";
  flagButton.disabled = card.type !== "flag";
  flagButton.addEventListener("click", () => {
    currentDeck.flag = card.id;
    render();
  });
  const buddyButton = document.createElement("button");
  buddyButton.type = "button";
  buddyButton.textContent = "バディ";
  buddyButton.disabled = !["monster", "impactMonster"].includes(card.type);
  buddyButton.addEventListener("click", () => {
    currentDeck.buddy = card.id;
    render();
  });
  actions.append(addButton, removeButton, flagButton, buddyButton);
  node.append(actions);
  return node;
}

function renderDeckList() {
  elements.deckList.innerHTML = "";
  sortedRecipe().forEach(([id, count]) => {
    const card = findCard(id);
    const row = document.createElement("article");
    row.className = "deck-row";
    row.innerHTML = `
      <div class="deck-row-head">
        <div class="deck-row-title">
          <strong>${escapeHtml(card?.name || id)}</strong>
          <span class="meta-line">${escapeHtml(card ? cardSummaryLine(card) : "-")}</span>
        </div>
        <strong>${count}枚</strong>
      </div>
      ${card ? `<div class="card-stat-grid compact">${cardStatHtml(card)}</div>` : ""}
    `;
    const actions = document.createElement("div");
    actions.className = "deck-actions";
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.addEventListener("click", () => addCard(id, 1));
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "-";
    minus.addEventListener("click", () => addCard(id, -1));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "0";
    remove.addEventListener("click", () => removeCard(id));
    actions.append(plus, minus, remove);
    row.append(actions);
    elements.deckList.append(row);
  });
}

function addCard(id, delta) {
  if (findCard(id)?.type === "flag" && delta > 0) {
    currentDeck.flag = id;
    render();
    return;
  }
  const entry = currentDeck.recipe.find(([cardId]) => cardId === id);
  if (!entry && delta > 0) {
    currentDeck.recipe.push([id, delta]);
  } else if (entry) {
    entry[1] += delta;
    if (entry[1] <= 0) {
      removeCard(id, false);
    }
  }
  render();
}

function removeCard(id, shouldRender = true) {
  currentDeck.recipe = currentDeck.recipe.filter(([cardId]) => cardId !== id);
  if (shouldRender) {
    render();
  }
}

function sortRecipe() {
  currentDeck.recipe = sortedRecipe();
}

function sortedRecipe() {
  return [...currentDeck.recipe].sort(([leftId], [rightId]) =>
    compareCards(findCard(leftId), findCard(rightId)),
  );
}

function compareCards(left, right) {
  if (!left || !right) {
    return left ? -1 : 1;
  }
  return (
    typeOrder(left.type) - typeOrder(right.type) ||
    String(left.no || "").localeCompare(String(right.no || ""), "ja") ||
    left.name.localeCompare(right.name, "ja")
  );
}

function typeOrder(type) {
  return { flag: 0, monster: 1, impactMonster: 2, spell: 3, item: 4, impact: 5 }[type] ?? 9;
}

function renderExportText() {
  elements.deckJsonText.value = JSON.stringify({ schemaVersion: 1, decks: [exportableDeck()] }, null, 2);
}

async function exportDeckToText() {
  renderExportText();
  elements.deckJsonText.focus();
  elements.deckJsonText.select();
  const text = elements.deckJsonText.value;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("JSONを出力し、クリップボードにコピーしました。ファイル化する場合は「JSON保存」を押してください。");
      return;
    } catch {
      // HTTPS以外や権限なしでは失敗するため、選択状態だけ残します。
    }
  }
  setStatus("JSONを出力しました。テキスト欄を選択済みです。必要に応じてコピーしてください。");
}

function exportableDeck() {
  return {
    id: currentDeck.id || createDeckId("custom"),
    name: currentDeck.name || "無題デッキ",
    flag: canonicalFlagId(currentDeck.flag),
    buddy: currentDeck.buddy,
    recipe: sortedRecipe().filter(([, count]) => count > 0),
  };
}

// ---- デッキ共有コード（versioned base64url。クロスデバイス持ち寄り。flag/buddy/cardId は card.id スラグ＝サーバ custom 経路と整合） ----
function toBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(code) {
  let b = code.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return decodeURIComponent(escape(atob(b)));
}
function encodeDeckShareCode() {
  const d = exportableDeck();
  const payload = [1, d.name, canonicalFlagId(d.flag), d.buddy || "", d.recipe]; // [version, name, flag, buddy, recipe]
  return "BFD1." + toBase64Url(JSON.stringify(payload));
}
function decodeDeckShareCode(code) {
  const body = String(code || "").trim().replace(/^BFD1\./, "");
  const arr = JSON.parse(fromBase64Url(body));
  const [ver, name, flag, buddy, recipe] = arr;
  if (ver !== 1) throw new Error("未対応の共有コードバージョン: " + ver);
  if (!flag || !Array.isArray(recipe)) throw new Error("共有コードの形式が不正です");
  return {
    id: createDeckId("custom"),
    name: name || "共有デッキ",
    flag: canonicalFlagId(flag),
    buddy: buddy || "",
    recipe: recipe.map(([id, count]) => [id, Number(count)]),
  };
}
async function exportDeckShareCode() {
  if (!elements.shareCodeInput) return;
  const code = encodeDeckShareCode();
  elements.shareCodeInput.value = code;
  elements.shareCodeInput.focus();
  elements.shareCodeInput.select();
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(code);
      setStatus("共有コードを発行し、クリップボードにコピーしました。");
      return;
    } catch {
      /* HTTPS外/権限なしでは選択状態のみ */
    }
  }
  setStatus("共有コードを発行しました。コード欄を選択済みです。");
}
function importDeckShareCode() {
  if (!elements.shareCodeInput) return;
  try {
    const deck = decodeDeckShareCode(elements.shareCodeInput.value);
    currentDeck = cloneDeck(deck);
    render();
    setStatus("共有コードを取り込みました。");
  } catch (error) {
    setStatus("共有コード取込失敗: " + error.message);
  }
}

function saveCurrentDeck() {
  const deck = exportableDeck();
  currentDeck.id = deck.id;
  const decks = loadSavedDecks().filter((candidate) => candidate.id !== deck.id);
  decks.push(deck);
  localStorage.setItem(customDeckStorageKey, JSON.stringify(decks));
  populateSavedDecks();
  elements.savedDeckSelect.value = deck.id;
  setStatus(`${deck.name}を保存しました。`);
}

function loadSavedDecks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(customDeckStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed : parsed.decks || [];
  } catch {
    return [];
  }
}

function loadSelectedSavedDeck() {
  const id = elements.savedDeckSelect.value;
  const deck = [...officialDecks, ...loadSavedDecks()].find((candidate) => candidate.id === id);
  if (!deck) {
    return;
  }
  currentDeck = cloneDeck(deck);
  render();
  setStatus(`${deck.name}を読み込みました。`);
}

function deleteSelectedSavedDeck() {
  const id = elements.savedDeckSelect.value;
  if (!id || officialDecks.some((deck) => deck.id === id)) {
    return;
  }
  const decks = loadSavedDecks().filter((deck) => deck.id !== id);
  localStorage.setItem(customDeckStorageKey, JSON.stringify(decks));
  populateSavedDecks();
  setStatus("保存済みデッキを削除しました。");
}

function importDeckFromText() {
  try {
    const parsed = JSON.parse(elements.deckJsonText.value);
    const imported = Array.isArray(parsed.decks) ? parsed.decks[0] : parsed;
    if (!imported || !Array.isArray(imported.recipe)) {
      throw new Error("デッキ形式ではありません。");
    }
    currentDeck = cloneDeck({
      ...imported,
      id: imported.id || createDeckId("custom"),
      name: imported.name || "インポートデッキ",
    });
    render();
    setStatus("インポートしました。");
  } catch (error) {
    setStatus(`インポート失敗: ${error.message}`);
  }
}

function downloadCurrentDeck() {
  const text = JSON.stringify({ schemaVersion: 1, decks: [exportableDeck()] }, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(currentDeck.name || "deck")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

function flagCards() {
  return cards.filter((card) => card.type === "flag").sort(compareCards);
}

function buddyCards() {
  return cards.filter((card) => ["monster", "impactMonster"].includes(card.type)).sort(compareCards);
}

function findCard(id) {
  const lookupId = canonicalFlagId(id);
  return cards.find((card) => card.id === lookupId);
}

function deckCount() {
  return currentDeck.recipe.reduce((total, [, count]) => total + Number(count || 0), 0);
}

function deckCardCount(id) {
  return currentDeck.recipe.find(([cardId]) => cardId === id)?.[1] || 0;
}

function cardSummaryLine(card) {
  return [
    card.no || "-",
    typeLabels[card.type] || card.type,
    card.world || "-",
  ].join(" / ");
}

function cardStatHtml(card) {
  return cardStatEntries(card)
    .map(
      ([label, value]) =>
        `<span class="card-stat"><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`,
    )
    .join("");
}

function cardStatEntries(card) {
  const entries = [];
  if (["monster", "impactMonster"].includes(card.type)) {
    entries.push(
      ["サイズ", statLabel(card.size)],
      ["攻撃力", statLabel(card.power)],
      ["打撃力", statLabel(card.critical)],
      ["防御力", statLabel(card.defense)],
    );
  } else if (card.type === "item") {
    entries.push(["攻撃力", statLabel(card.power)], ["打撃力", statLabel(card.critical)]);
    if (hasStatValue(card.defense)) {
      entries.push(["防御力", statLabel(card.defense)]);
    }
  } else if (card.type === "flag") {
    entries.push(
      ["初期ライフ", statLabel(card.startingLife)],
      ["初期手札", statLabel(card.startingHand)],
      ["初期ゲージ", statLabel(card.startingGauge)],
    );
    if ((card.maxFieldSize ?? 3) !== 3) {
      entries.push(["サイズ上限", statLabel(card.maxFieldSize)]);
    }
  }
  const cost = costLabel(card);
  if (cost !== "-") {
    entries.push(["コスト", cost]);
  }
  if (card.keywords?.length) {
    entries.push(["キーワード", card.keywords.join(" / ")]);
  }
  return entries.length ? entries : [["情報", "数値なし"]];
}

function statLabel(value) {
  return hasStatValue(value) ? String(value) : "-";
}

function hasStatValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function costLabel(card) {
  const structured = primaryStructuredCost(card);
  if (structured?.length) {
    return structured.map(costStepLabel).join(" / ");
  }
  const cost = primaryCost(card);
  if (!cost) {
    return "-";
  }
  const labels = [];
  if (cost.gauge) {
    labels.push(`ゲージ${cost.gauge}`);
  }
  if (cost.discard) {
    labels.push(`手札${cost.discard}`);
  }
  if (cost.life) {
    labels.push(`ライフ${cost.life}`);
  }
  return labels.join(" / ") || "-";
}

function primaryStructuredCost(card) {
  return card.costs?.call || card.costs?.cast || card.costs?.equip || card.costs?.arrival || null;
}

function primaryCost(card) {
  return card.callCost || card.castCost || card.equipCost || null;
}

function costStepLabel(step) {
  const amount = step.amount || 1;
  return {
    payGauge: `ゲージ${amount}`,
    discardHand: `手札${amount}`,
    payLife: `ライフ${amount}`,
    putTopDeckToSoul: `デッキ上${amount}枚をソウル`,
    putDropToSoul: `ドロップ${amount}枚をソウル`,
    putTopDeckToGauge: `デッキ上${amount}枚をゲージ`,
    discardSoul: `ソウル${amount}枚を捨てる`,
    dropOwnMonster: `自分のモンスター${amount}枚をドロップ`,
  }[step.op] || step.op;
}

function cardRules(card) {
  return card.rules?.length ? card.rules.join(" / ") : "能力なし。";
}

function unique(values) {
  return [...new Set(values)];
}

function setStatus(message) {
  elements.builderStatus.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

initializeBuilder();

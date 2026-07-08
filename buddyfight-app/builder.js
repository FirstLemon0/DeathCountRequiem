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
  loadSavedDeckButton: document.querySelector("#loadSavedDeckButton"), // 旧・読込ボタン（DOMから撤去済。参照は null ガード）
  deleteSavedDeckButton: document.querySelector("#deleteSavedDeckButton"),
  sortDeckButton: document.querySelector("#sortDeckButton"),
  shareCodeInput: document.querySelector("#shareCodeInput"),
  issueShareCodeButton: document.querySelector("#issueShareCodeButton"),
  importShareCodeButton: document.querySelector("#importShareCodeButton"),
  saveMenuButton: document.querySelector("#saveMenuButton"),
  saveMenu: document.querySelector("#saveMenu"),
  saveLocalMenuItem: document.querySelector("#saveLocalMenuItem"),
  saveServerMenuItem: document.querySelector("#saveServerMenuItem"),
  accountControl: document.querySelector("#accountControl"),
};

// 共通アカウントコンポーネント(user-api.js §2.1)の返り値。未ログイン時にモーダルを開くのに使う。
let builderAccountControl = null;
// [開く…] select の「確定済み」値。picker 選択(change)で即読込し、dirty 破棄キャンセル時はこの値へ戻す。
let lastLoadedSavedValue = "";

let cards = [];
let officialDecks = [];
let currentDeck = emptyDeck();
let flagIdAliases = new Map();
let activeGeneration = ""; // 世代タブの選択（空=すべて）。製品が増えても世代で製品リストを絞る。
let deckJsonDirty = false; // 入出力欄をユーザーが手入力/貼り付けした後は render で自動上書きしない（貼り付けたインポート元を保護）。

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
    updateDeckSnapshot();
    mountBuilderAccount();
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
    ...cardSets.flatMap(({ set, data }) => {
      const packName = (set.file || "").split("/").pop().replace(/\.json$/, "");
      return (data.cards || [])
        .filter((card) => card.type !== "flag")
        .map((card) => {
          const c = normalizeCard(card, set);
          c.imagePack = packName;
          return c;
        });
    }),
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
    // デッキ選択モーダル(deck-picker.js)用のメタ。decksets.json 由来（無ければ既定値で従来どおり）。
    category: deck.category || set.category || (set.id === "custom" ? "custom" : "official"),
    series: deck.series || set.series || "",
    releaseOrder: deck.releaseOrder ?? set.releaseOrder ?? 9999,
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
  // 入出力欄を手入力/貼り付けしたら以後 render で上書きしない（インポート元の消失を防ぐ）。
  elements.deckJsonText.addEventListener("input", () => {
    deckJsonDirty = true;
  });
  elements.newDeckButton.addEventListener("click", () => {
    if (!confirmDiscardIfDirty()) {
      return;
    }
    currentDeck = emptyDeck();
    currentDeck.flag = flagCards()[0]?.id || "";
    currentDeck.buddy = buddyCards()[0]?.id || "";
    updateDeckSnapshot();
    render();
    setStatus("新しいデッキを作成しました。");
  });
  elements.saveDeckButton.addEventListener("click", saveCurrentDeck);
  elements.exportDeckButton.addEventListener("click", exportDeckToText);
  elements.downloadDeckButton.addEventListener("click", downloadCurrentDeck);
  elements.importDeckButton.addEventListener("click", importDeckFromText);
  // 旧・読込ボタンは topbar 再編で撤去（picker 選択＝change で即読込）。残置参照は null ガード。
  elements.loadSavedDeckButton?.addEventListener("click", () => loadSelectedSavedDeck());
  elements.deleteSavedDeckButton.addEventListener("click", deleteSelectedSavedDeck);
  // [開く…]: deck-picker で選ぶと savedDeckSelect に change が飛ぶ→即読込。
  // dirty なら confirmDiscardIfDirty で1回だけ確認し、キャンセル時は選択を元へ戻す。
  elements.savedDeckSelect.addEventListener("change", () => {
    const id = elements.savedDeckSelect.value;
    if (id === lastLoadedSavedValue) {
      return;
    }
    if (!id) {
      lastLoadedSavedValue = id;
      return;
    }
    if (!confirmDiscardIfDirty()) {
      elements.savedDeckSelect.value = lastLoadedSavedValue;
      syncSavedDeckPickerLabel();
      return;
    }
    if (loadSelectedSavedDeck({ skipConfirm: true })) {
      lastLoadedSavedValue = elements.savedDeckSelect.value;
    } else {
      elements.savedDeckSelect.value = lastLoadedSavedValue;
      syncSavedDeckPickerLabel();
    }
  });
  // 保存▾ スプリットメニュー: 開閉＋各項目。
  elements.saveMenuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSaveMenu();
  });
  elements.saveLocalMenuItem?.addEventListener("click", () => {
    closeSaveMenu();
    saveCurrentDeck();
  });
  elements.saveServerMenuItem?.addEventListener("click", () => {
    closeSaveMenu();
    saveCurrentDeckToServer();
  });
  // メニュー外クリック / Esc で閉じる。
  document.addEventListener("click", (event) => {
    if (elements.saveMenu && !elements.saveMenu.hidden && !event.target.closest(".save-split")) {
      closeSaveMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSaveMenu();
    }
  });
  elements.sortDeckButton.addEventListener("click", () => {
    sortRecipe();
    render();
  });
  elements.issueShareCodeButton?.addEventListener("click", exportDeckShareCode);
  elements.importShareCodeButton?.addEventListener("click", importDeckShareCode);
  // 未保存の編集があるまま離脱/再読込しようとしたら確認（ツールバーのリンク遷移・タブ閉じを含む）。
  window.addEventListener("beforeunload", (event) => {
    if (isDeckDirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
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
    ["", "デッキを選ぶ…"],
    ...officialDecks.map((deck) => [deck.id, `公式: ${deck.name}`]),
    ...savedDecks.map((deck) => [deck.id, `保存: ${deck.name}`]),
  ]);
  // setOptions は select.innerHTML を丸ごと差し替えるため、追補済みの「マイ: 」option も消える。
  // user-api.js がログイン中ならここで即座に再注入する（未ログイン/未読込なら何もしない）。
  if (typeof userRefreshMyDeckOptions === "function") {
    userRefreshMyDeckOptions();
  }
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

// 全再描画(innerHTML)でフォーカスが body に落ちるため、直近操作したボタンと同じ data-focus-key の
// 新ノードへフォーカスを戻す（キーボードで +/- 追加を連続操作できるように）。
function refocusBuilder(key) {
  if (!key) {
    return;
  }
  const el = document.querySelector(`[data-focus-key="${key}"]`);
  if (el) {
    el.focus();
  }
}

function renderStats() {
  const stats = deckStats();
  elements.deckCountLabel.textContent = `${stats.total}枚`;
  elements.deckCountLabel.classList.toggle("count-ok", stats.total >= 50);
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
    const icon = document.createElement("span");
    icon.className = "validation-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = item.level === "ok" ? "✓" : item.level === "warn" ? "！" : "✕";
    const text = document.createElement("span");
    text.textContent = item.message;
    row.append(icon, text);
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
    Boolean(buddy && (["monster", "impactMonster"].includes(buddy.type) || buddy.canBeBuddy)),
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
// 公式ルール（2018年6月以前）: 君のフラッグがそのカードのワールドなら通常枚数、それ以外なら1枚。
// ＝ホームは「homeWorld の正規フラッグ（allowedWorlds に明示）」のみ。例 ドラゴンＷ角王→dragon-world。
// ※以前あった「竜牙雷帝は角王を4枚」の特例（homeAttribute 分岐）は公式に該当ルールが無いため撤去。
//   竜牙雷帝など特殊フラッグでは角王は「使用可・ただし1枚」（deckAnyFlag=全フラッグで使えるが非ホーム）。
// アイン/ツヴァイ等の特殊フラッグも同様に非ホーム（＝制限）。
function flagIsHomeForDeckAnyFlag(flag, card) {
  const rule = card?.deckAnyFlag;
  if (!flag || !rule) {
    return false;
  }
  if (flag.allowAllWorlds) {
    return true;
  }
  const homeWorld = rule.homeWorld || card?.world;
  return flagIsOfWorld(flag, homeWorld);
}

// カードのデッキ投入上限枚数（既定4）。『角王』(deckAnyFlag)カードは、君のフラッグが
// ホーム（flagIsHomeForDeckAnyFlag＝homeWorldのフラッグ）なら4枚、それ以外なら deckAnyFlag.awayMaxCopies（既定1）。
// 公式テキスト「君のフラッグが＜そのカードのワールド＞以外なら1枚」に対応（特殊フラッグは非ホーム＝1枚）。
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
  const limit = 140;
  const shown = filtered.slice(0, limit);
  elements.resultCountLabel.textContent =
    filtered.length > limit ? `${filtered.length}件中 先頭${limit}件` : `${filtered.length}件`;
  elements.cardResults.innerHTML = "";
  shown.forEach((card) => elements.cardResults.append(createCardResult(card)));
  if (filtered.length > limit) {
    const note = document.createElement("p");
    note.className = "results-truncated-note";
    note.textContent = `ほか${filtered.length - limit}件は非表示です。検索語・種類・ワールド・製品で絞り込むと表示されます。`;
    elements.cardResults.append(note);
  }
  builderFillThumbs(elements.cardResults);
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

// カード番号から公式カード画像URLを導出（ローカルWebPが無い場合のフォールバック）。
function officialCardImageUrl(card) {
  const no = card?.no;
  if (!no || no.indexOf("/") < 0) {
    return "";
  }
  const [left, right] = no.split("/");
  const letters = left.replace(/-/g, "").match(/^([A-Za-z]+)(\d+)$/);
  const cardnum = String(right).match(/^\d+/);
  if (!letters || !cardnum) {
    return "";
  }
  const num = String(parseInt(cardnum[0], 10)).padStart(4, "0");
  return `https://fc-buddyfight.com/wordpress/wp-content/images/card/${letters[1].toLowerCase()}_${letters[2]}_${num}.png`;
}

// 製品画像パック（data/images/{pack}.imgpack.json）の遅延読み込み。
const builderPacks = {};
const builderPackPromises = {};
function builderEnsurePack(pack) {
  if (!pack) {
    return Promise.resolve();
  }
  if (builderPackPromises[pack]) {
    return builderPackPromises[pack];
  }
  builderPackPromises[pack] = fetch(`data/images/${pack}.imgpack.json`, { cache: "force-cache" })
    .then((r) => (r.ok ? r.json() : {}))
    .then((map) => Object.assign(builderPacks, map))
    .catch(() => {});
  return builderPackPromises[pack];
}

// レンダー後、サムネイルimgに製品パックのdata URLを流し込む（未読込は製品パックを読み込んでから）。
function builderFillThumbs(root) {
  if (!root) {
    return;
  }
  root.querySelectorAll("img.builder-card-thumb[data-cid]").forEach((img) => {
    const cid = img.dataset.cid;
    if (builderPacks[cid]) {
      setBuilderThumbSrc(img, builderPacks[cid]);
      return;
    }
    builderEnsurePack(img.dataset.pack).then(() => {
      if (builderPacks[cid]) {
        setBuilderThumbSrc(img, builderPacks[cid]);
      } else {
        builderCardImgError(img);
      }
    });
  });
}

// サムネイルへ製品パックのdata URLを設定。以前のフォールバックで display:none にされていても復帰させる
// （ローカル画像があるのにレースで恒久非表示になる不具合の対策）。onerror未設定なら失敗時フォールバックも配線。
function setBuilderThumbSrc(img, src) {
  img.style.display = "";
  if (!img.getAttribute("onerror")) {
    img.onerror = () => builderCardImgError(img);
  }
  img.src = src;
}

// カードサムネイルの img マークアップ（製品パックのdata URL→公式URL→失敗で非表示）。
function cardThumbHtml(card, extraClass = "") {
  const remote = officialCardImageUrl(card);
  const cid = card?.id || "";
  if (!cid && !remote) {
    return "";
  }
  const src = builderPacks[cid] || "";
  // 初期srcが無いときは src/onerror を付けない。src="" が即 error を発火し、公式URLフェッチ→非表示になる
  // レース（オンラインはちらつき、オフラインはローカル画像があるのに恒久非表示）を防ぐ。srcは描画後 builderFillThumbs が流し込む。
  const srcAttr = src ? ` src="${src}" onerror="builderCardImgError(this)"` : "";
  return `<img class="builder-card-thumb ${extraClass}" loading="lazy" decoding="async" alt="${escapeHtml(card.name || "")}"${srcAttr} data-cid="${cid}" data-pack="${card?.imagePack || ""}" data-remote="${remote}">`;
}

// サムネイル読み込み失敗時: 公式URLへ一度フォールバック、それも失敗なら非表示。
function builderCardImgError(img) {
  const remote = img.getAttribute("data-remote");
  if (remote && img.src !== remote) {
    img.src = remote;
    return;
  }
  img.style.display = "none";
}

function createCardResult(card) {
  const flag = findCard(currentDeck.flag);
  const copyLimit = card.type === "flag" ? null : cardCopyLimitForFlag(flag, card);
  const count = deckCardCount(card.id);
  const node = document.createElement("article");
  node.className = "builder-card";
  node.innerHTML = `
    <div class="builder-card-head">
      ${cardThumbHtml(card)}
      <div class="builder-card-title">
        <strong>${escapeHtml(card.name)}</strong>
        <span class="meta-line">${escapeHtml(cardSummaryLine(card))}</span>
      </div>
      <span class="meta-line">${count}${copyLimit != null ? " / " + copyLimit : ""}枚</span>
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
  addButton.disabled = card.type === "flag" || (copyLimit != null && count >= copyLimit);
  if (copyLimit != null && count >= copyLimit) {
    addButton.title = `同名カードの上限 ${copyLimit} 枚に達しています`;
  }
  addButton.dataset.focusKey = "res-add-" + card.id;
  addButton.addEventListener("click", () => {
    addCard(card.id, 1);
    refocusBuilder("res-add-" + card.id);
  });
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.textContent = "減らす";
  removeButton.disabled = deckCardCount(card.id) === 0;
  removeButton.dataset.focusKey = "res-sub-" + card.id;
  removeButton.addEventListener("click", () => {
    addCard(card.id, -1);
    refocusBuilder("res-sub-" + card.id);
  });
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
  buddyButton.disabled = !(["monster", "impactMonster"].includes(card.type) || card.canBeBuddy);
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
        ${card ? cardThumbHtml(card, "deck-thumb") : ""}
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
    plus.dataset.focusKey = "deck-add-" + id;
    plus.addEventListener("click", () => {
      addCard(id, 1);
      refocusBuilder("deck-add-" + id);
    });
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "-";
    minus.dataset.focusKey = "deck-sub-" + id;
    minus.addEventListener("click", () => {
      addCard(id, -1);
      refocusBuilder("deck-sub-" + id);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "0";
    remove.addEventListener("click", () => removeCard(id));
    if (card && (["monster", "impactMonster"].includes(card.type) || card.canBeBuddy)) {
      const buddy = document.createElement("button");
      buddy.type = "button";
      buddy.textContent = currentDeck.buddy === id ? "バディ★" : "バディ";
      buddy.title = "このカードをバディに設定";
      buddy.addEventListener("click", () => {
        currentDeck.buddy = id;
        render();
      });
      actions.append(plus, minus, remove, buddy);
    } else {
      actions.append(plus, minus, remove);
    }
    row.append(actions);
    elements.deckList.append(row);
  });
  builderFillThumbs(elements.deckList);
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

function renderExportText(force = false) {
  // 手入力中(貼り付け直後など)は上書きしない。エクスポート操作時のみ force で強制反映。
  if (deckJsonDirty && !force) {
    return;
  }
  elements.deckJsonText.value = JSON.stringify({ schemaVersion: 1, decks: [exportableDeck()] }, null, 2);
  deckJsonDirty = false;
}

async function exportDeckToText() {
  renderExportText(true);
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

// 未保存変更の検知（直近の保存/読込/新規/取込時点のデッキJSONと比較）。破棄前の確認・離脱ガードに使う。
let deckSnapshot = "";
function updateDeckSnapshot() {
  deckSnapshot = JSON.stringify(exportableDeck());
  deckJsonDirty = false;
}
function isDeckDirty() {
  return deckSnapshot !== JSON.stringify(exportableDeck());
}
function confirmDiscardIfDirty() {
  return !isDeckDirty() || window.confirm("編集中のデッキに保存していない変更があります。破棄して続けますか？");
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
  return encodeDeckObjectShareCode(exportableDeck());
}
// 任意のデッキオブジェクト{name,flag,buddy,recipe}をBFD1コード化する。
// user-api.js の「端末→サーバーへ一括移行」がlocalStorageの各保存済みデッキ（currentDeck以外）を
// コード化するのに使う（encodeDeckShareCodeはcurrentDeckしか見ないため個別デッキ向けに切り出し）。
function encodeDeckObjectShareCode(d) {
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
  if (!confirmDiscardIfDirty()) return;
  try {
    const deck = decodeDeckShareCode(elements.shareCodeInput.value);
    currentDeck = cloneDeck(deck);
    updateDeckSnapshot();
    render();
    setStatus("共有コードを取り込みました。");
  } catch (error) {
    const known = /共有コード|バージョン/.test(error.message);
    setStatus(
      "共有コード取込失敗: " +
        (known ? error.message : "コードを読み取れませんでした。BFD1. で始まる全文を貼り付けてください。"),
    );
  }
}

// ---- 保存▾ スプリットメニュー ----
function toggleSaveMenu() {
  if (!elements.saveMenu) {
    return;
  }
  if (elements.saveMenu.hidden) {
    openSaveMenu();
  } else {
    closeSaveMenu();
  }
}
function openSaveMenu() {
  if (!elements.saveMenu) {
    return;
  }
  elements.saveMenu.hidden = false;
  elements.saveMenuButton?.setAttribute("aria-expanded", "true");
}
function closeSaveMenu() {
  if (!elements.saveMenu || elements.saveMenu.hidden) {
    return;
  }
  elements.saveMenu.hidden = true;
  elements.saveMenuButton?.setAttribute("aria-expanded", "false");
}

// deck-picker が savedDeckSelect の後ろに付けた選択ボタン(.dp-open-button)のラベルを、
// 現在の選択オプションに合わせて更新する（プログラム的な value 変更は picker の change を発火しないため補完）。
function syncSavedDeckPickerLabel() {
  const sel = elements.savedDeckSelect;
  if (!sel) {
    return;
  }
  const btn =
    sel.parentElement?.querySelector(".dp-open-button") ||
    (sel.nextElementSibling?.classList?.contains?.("dp-open-button") ? sel.nextElementSibling : null);
  if (!btn) {
    return;
  }
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  btn.textContent = opt && opt.textContent.trim() ? opt.textContent.trim() : "デッキを選ぶ…";
}

// [保存▾ → サーバーに保存]。未ログインならアカウントモーダルを開く（無ければトースト案内）。
async function saveCurrentDeckToServer() {
  const loggedIn = typeof userSession === "function" && userSession();
  if (!loggedIn) {
    openAccountModalForLogin();
    return;
  }
  if (typeof userSaveMyDeck !== "function" || typeof encodeDeckShareCode !== "function") {
    setStatus("サーバー保存機能が利用できません。");
    return;
  }
  try {
    const deck = exportableDeck();
    const code = encodeDeckShareCode();
    await userSaveMyDeck(deck.name, code);
    if (typeof userRefreshMyDeckOptions === "function") {
      await userRefreshMyDeckOptions();
    }
    setStatus(`${deck.name}をサーバーに保存しました。`);
  } catch (error) {
    setStatus(`サーバー保存に失敗しました: ${error.message}`);
  }
}

// localStorage の各保存済みデッキをサーバーへ一括アップロード（アカウントモーダルの extraAction 用）。
async function migrateLocalDecksToServer() {
  if (typeof userSaveMyDeck !== "function") {
    setStatus("サーバー機能が利用できません。");
    return;
  }
  const localDecks = loadSavedDecks();
  let ok = 0;
  let fail = 0;
  for (const deck of localDecks) {
    try {
      await userSaveMyDeck(deck.name, encodeDeckObjectShareCode(deck));
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  if (typeof userRefreshMyDeckOptions === "function") {
    await userRefreshMyDeckOptions();
  }
  setStatus(`一括移行: 成功${ok}件 / 失敗${fail}件`);
}

// アカウントモーダルを開く（compact コントロールの返り値 or グローバル関数を優先。無ければトースト案内）。
function openAccountModalForLogin() {
  // 1) コントロールが open() を返すならそれ、2) グローバル関数、
  // 3) compact の 👤 ボタンをプログラム的に押してモーダルを開く、いずれも無ければ 4) トースト案内。
  const opener =
    (builderAccountControl && (builderAccountControl.open || builderAccountControl.openModal)) ||
    (typeof userOpenAccountModal === "function" ? userOpenAccountModal : null);
  if (opener) {
    try {
      opener.call(builderAccountControl || null);
      return;
    } catch {
      /* フォールバックへ */
    }
  }
  const accButton = elements.accountControl?.querySelector(".account-compact-button, button");
  if (accButton) {
    accButton.click();
    return;
  }
  setStatus("サーバーに保存するにはログインしてください（👤 からログイン）。");
}

// マイデッキ行アクション「開く」= プロフィールをエディタへ読込（dirty なら破棄確認）。
function loadProfileIntoEditor(profile) {
  if (!profile) {
    return;
  }
  if (!confirmDiscardIfDirty()) {
    return;
  }
  currentDeck = cloneDeck({ flag: profile.flag, buddy: profile.buddy, name: profile.name, recipe: profile.recipe });
  updateDeckSnapshot();
  render();
  setStatus(`${profile.name}を読み込みました。`);
}

// topbar 右の #accountControl に共通アカウントコンポーネント(compact)をマウント。
// A班未マージ時は既存 userMountAccountBar にフォールバック（builder が壊れないこと）。
function mountBuilderAccount() {
  const container = elements.accountControl;
  if (!container) {
    return;
  }
  const opts = {
    variant: "compact",
    deckActions: [{ label: "開く", onPick: loadProfileIntoEditor }],
    extraActions: [
      { label: "今のデッキをサーバーに保存", when: "loggedIn", onClick: saveCurrentDeckToServer },
      { label: "端末→サーバーへ一括移行", when: "loggedIn", onClick: migrateLocalDecksToServer },
    ],
  };
  if (typeof userMountAccountControl === "function") {
    builderAccountControl = userMountAccountControl(container, opts);
  } else if (typeof userMountAccountBar === "function") {
    userMountAccountBar(container); // フォールバック（従来のバー）
  }
}

function saveCurrentDeck() {
  const deck = exportableDeck();
  currentDeck.id = deck.id;
  const decks = loadSavedDecks().filter((candidate) => candidate.id !== deck.id);
  decks.push(deck);
  try {
    localStorage.setItem(customDeckStorageKey, JSON.stringify(decks));
  } catch (error) {
    setStatus(`保存に失敗しました（ブラウザの保存容量やプライベートモードをご確認ください）: ${error.message}`);
    return;
  }
  populateSavedDecks();
  elements.savedDeckSelect.value = deck.id;
  lastLoadedSavedValue = deck.id; // 保存で select 値を確定（この後 picker change の即読込対象にしない）
  syncSavedDeckPickerLabel();
  updateDeckSnapshot();
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

// 選択中の保存/公式/マイデッキをエディタへ読み込む。
// options.skipConfirm=true は呼び出し側で既に破棄確認済みの場合（picker change 経路）に二重確認を避ける。
// 戻り値: 読み込んだら true、未選択/取得失敗/破棄キャンセルなら false。
function loadSelectedSavedDeck(options = {}) {
  const skipConfirm = options.skipConfirm === true;
  const id = elements.savedDeckSelect.value;
  if (id.startsWith("mydeck-")) {
    const profile = typeof userCachedMyDeckProfile === "function" ? userCachedMyDeckProfile(id) : null;
    if (!profile) {
      setStatus("マイデッキを読み込めませんでした。もう一度「マイデッキ」を選び直してください。");
      return false;
    }
    if (!skipConfirm && !confirmDiscardIfDirty()) {
      return false;
    }
    currentDeck = cloneDeck({ flag: profile.flag, buddy: profile.buddy, name: profile.name, recipe: profile.recipe });
    updateDeckSnapshot();
    render();
    setStatus(`${profile.name}を読み込みました。`);
    return true;
  }
  const deck = [...officialDecks, ...loadSavedDecks()].find((candidate) => candidate.id === id);
  if (!deck) {
    setStatus("読み込むデッキを選んでください。");
    return false;
  }
  if (!skipConfirm && !confirmDiscardIfDirty()) {
    return false;
  }
  currentDeck = cloneDeck(deck);
  updateDeckSnapshot();
  render();
  setStatus(`${deck.name}を読み込みました。`);
  return true;
}

function deleteSelectedSavedDeck() {
  const id = elements.savedDeckSelect.value;
  if (!id) {
    setStatus("削除する保存済みデッキを選んでください。");
    return;
  }
  if (id.startsWith("mydeck-")) {
    const profile = typeof userCachedMyDeckProfile === "function" ? userCachedMyDeckProfile(id) : null;
    if (!profile) {
      setStatus("マイデッキ情報を取得できませんでした。もう一度「マイデッキ」を選び直してください。");
      return;
    }
    if (!window.confirm(`サーバー上のマイデッキ「${profile.name}」を削除します。元に戻せません。よろしいですか？`)) {
      return;
    }
    if (typeof userDeleteMyDeck !== "function") {
      setStatus("サーバー機能が利用できません。");
      return;
    }
    userDeleteMyDeck(profile.serverId)
      .then(() => setStatus("マイデッキをサーバーから削除しました。"))
      .catch((error) => setStatus(`削除に失敗しました: ${error.message}`));
    return;
  }
  if (officialDecks.some((deck) => deck.id === id)) {
    setStatus("公式デッキは削除できません。");
    return;
  }
  const target = loadSavedDecks().find((deck) => deck.id === id);
  const name = target?.name || "このデッキ";
  if (!window.confirm(`保存済みデッキ「${name}」を削除します。元に戻せません。よろしいですか？`)) {
    return;
  }
  const decks = loadSavedDecks().filter((deck) => deck.id !== id);
  localStorage.setItem(customDeckStorageKey, JSON.stringify(decks));
  populateSavedDecks();
  lastLoadedSavedValue = elements.savedDeckSelect.value; // 一覧再構築でプレースホルダへ戻る
  syncSavedDeckPickerLabel();
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
    updateDeckSnapshot();
    render();
    setStatus("インポートしました。");
  } catch (error) {
    const hint =
      error instanceof SyntaxError
        ? "JSONの形式が正しくありません。テキスト欄に有効なデッキJSONを貼り付けてください。"
        : error.message;
    setStatus(`インポート失敗: ${hint}`);
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
  return cards.filter((card) => ["monster", "impactMonster"].includes(card.type) || card.canBeBuddy).sort(compareCards);
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
  showBuilderToast(message);
}

// 操作結果を画面下中央のトースト(styles.cssの#toast)でも通知。モバイルで入出力欄が画面外でも見える。
let builderToastTimer = null;
function showBuilderToast(message, ms = 2600) {
  const el = document.querySelector("#toast");
  if (!el) {
    return;
  }
  el.textContent = message;
  el.classList.add("show");
  el.setAttribute("aria-hidden", "false");
  if (builderToastTimer) {
    clearTimeout(builderToastTimer);
  }
  builderToastTimer = setTimeout(() => {
    el.classList.remove("show");
    el.setAttribute("aria-hidden", "true");
  }, ms);
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

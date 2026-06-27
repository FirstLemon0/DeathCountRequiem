const typeLabels = {
  monster: "モンスター",
  spell: "魔法",
  item: "アイテム",
  impact: "必殺技",
  impactMonster: "必殺モンスター",
  flag: "フラッグ",
};

const phaseLabels = {
  draw: "ドロー",
  charge: "チャージ",
  main: "メイン",
  attack: "アタック",
  defense: "防御確認",
  final: "ファイナル",
  end: "終了",
};

const fieldZones = ["left", "center", "right"];
const setZones = ["set1", "set2"];
const zones = ["left", "center", "right", "set1", "set2", "item"];
const ruleEraLabel = "2018年6月以前ルール（神バディファイト以前）";

let cardLibrary = [];
let deckProfiles = [];
let cardSetProfiles = [];
let deckSetProfiles = [];
let flagIdAliases = new Map();

const dataFiles = {
  cardsets: "data/cardsets.json",
  decksets: "data/decksets.json",
  flags: "data/flags.json",
};

const customDeckStorageKey = "buddyfight.customDecks.v1";

const elements = {
  turnLabel: document.querySelector("#turnLabel"),
  phaseLabel: document.querySelector("#phaseLabel"),
  selectionLabel: document.querySelector("#selectionLabel"),
  handTitle: document.querySelector("#handTitle"),
  handList: document.querySelector("#handList"),
  sizeLabel: document.querySelector("#sizeLabel"),
  attackTarget: document.querySelector("#attackTarget"),
  effectTarget: document.querySelector("#effectTarget"),
  logList: document.querySelector("#logList"),
  cardTooltip: document.querySelector("#cardTooltip"),
  newGameButton: document.querySelector("#newGameButton"),
  exportLogButton: document.querySelector("#exportLogButton"),
  p1DeckSelect: document.querySelector("#p1DeckSelect"),
  p2DeckSelect: document.querySelector("#p2DeckSelect"),
  rulesButton: document.querySelector("#rulesButton"),
  rulesDialog: document.querySelector("#rulesDialog"),
  closeRulesButton: document.querySelector("#closeRulesButton"),
  dropDialog: document.querySelector("#dropDialog"),
  dropDialogTitle: document.querySelector("#dropDialogTitle"),
  dropDialogList: document.querySelector("#dropDialogList"),
  closeDropDialogButton: document.querySelector("#closeDropDialogButton"),
  selectionDialog: document.querySelector("#selectionDialog"),
  selectionDialogTitle: document.querySelector("#selectionDialogTitle"),
  selectionDialogLead: document.querySelector("#selectionDialogLead"),
  selectionDialogPreview: document.querySelector("#selectionDialogPreview"),
  selectionDialogList: document.querySelector("#selectionDialogList"),
  selectionBoardButton: document.querySelector("#selectionBoardButton"),
  selectionConfirmButton: document.querySelector("#selectionConfirmButton"),
  selectionCancelButton: document.querySelector("#selectionCancelButton"),
  drawButton: document.querySelector("#drawButton"),
  chargeButton: document.querySelector("#chargeButton"),
  mainPhaseButton: document.querySelector("#mainPhaseButton"),
  castButton: document.querySelector("#castButton"),
  resolveAttackButton: document.querySelector("#resolveAttackButton"),
  counterHandButton: document.querySelector("#counterHandButton"),
  attackPhaseButton: document.querySelector("#attackPhaseButton"),
  linkToggleButton: document.querySelector("#linkToggleButton"),
  finalPhaseButton: document.querySelector("#finalPhaseButton"),
  attackButton: document.querySelector("#attackButton"),
  endTurnButton: document.querySelector("#endTurnButton"),
  partnerCallButton: document.querySelector("#partnerCallButton"),
  netplayPanel: document.querySelector("#netplayPanel"),
  networkStatus: document.querySelector("#networkStatus"),
  roomInput: document.querySelector("#roomInput"),
  createRoomButton: document.querySelector("#createRoomButton"),
  joinRoomButton: document.querySelector("#joinRoomButton"),
  copyRoomButton: document.querySelector("#copyRoomButton"),
  playerSeatLabel: document.querySelector("#playerSeatLabel"),
};

let state;
let networkSession = {
  connected: false,
  roomId: "",
  token: "",
  seat: null,
  eventSource: null,
  applyingSnapshot: false,
  lastSeq: 0,
  pendingChoiceResolvers: new Map(),
  handledChoiceRequests: new Set(),
};

async function loadGameData() {
  const [cardsetsData, decksetsData, flagsData] = await Promise.all([
    loadJson(dataFiles.cardsets),
    loadJson(dataFiles.decksets),
    loadJson(dataFiles.flags),
  ]);
  cardSetProfiles = [...(cardsetsData.sets || [])];
  deckSetProfiles = [...(decksetsData.sets || [])];

  const cardSets = await Promise.all(cardSetProfiles.map(loadSetFile));
  const deckSets = await Promise.all(deckSetProfiles.map(loadSetFile));
  const flags = normalizeFlagDefinitions(flagsData);
  flagIdAliases = buildFlagIdAliases(flags);

  cardLibrary = [
    ...flags,
    ...cardSets.flatMap(({ set, data }) =>
      (data.cards || [])
        .filter((card) => card.type !== "flag")
        .map((card) => normalizeCardDefinition(card, set)),
    ),
  ];
  const officialDecks = deckSets.flatMap(({ set, data }) =>
    (data.decks || []).map((deck) => normalizeDeckProfile(deck, set)),
  );
  deckProfiles = [...officialDecks, ...loadCustomDeckProfiles().filter(deckReferencesKnown)];
  validateGameData();
}

async function loadSetFile(set) {
  return {
    set,
    data: await loadJson(set.file),
  };
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} を読み込めませんでした。`);
  }
  return response.json();
}

// 任意の深さのノードを走査し、op を持つオブジェクトに変換関数 fn を適用する（非破壊・深さ優先）。
// 入れ子（effects/script/options[].script/branch の then-else 等）も漏れなく辿る。
// 変更が無ければ同一参照を返し、共有参照（continuous 等）の元データを汚さない。
function mapEffectNode(node, fn) {
  if (Array.isArray(node)) {
    let changed = false;
    const mapped = node.map((child) => {
      const next = mapEffectNode(child, fn);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? mapped : node;
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  const replaced = typeof node.op === "string" ? fn(node) || node : node;
  const patch = {};
  let changed = replaced !== node;
  for (const [key, value] of Object.entries(replaced)) {
    if (value && typeof value === "object") {
      const mapped = mapEffectNode(value, fn);
      if (mapped !== value) {
        patch[key] = mapped;
        changed = true;
      }
    }
  }
  return changed ? { ...replaced, ...patch } : replaced;
}

// カード内のすべての効果保持配列（abilities/continuous/soul 系/costs）を走査し、旧op→新op へ非破壊変換する。
// abilities/costs は normalizeCardDefinition で deepClone 済みだが、continuous 等は共有参照のため
// 必ず新しいオブジェクトを生成して元の JSON 定義を汚さないこと（mapEffectNode が担保する）。
function mapCardEffectOps(card, fn) {
  for (const key of ["abilities", "soulAbilities", "effects", "continuous", "soulContinuous"]) {
    if (Array.isArray(card[key])) {
      card[key] = mapEffectNode(card[key], fn);
    }
  }
  if (card.costs && typeof card.costs === "object") {
    const nextCosts = {};
    for (const [key, value] of Object.entries(card.costs)) {
      nextCosts[key] = mapEffectNode(value, fn);
    }
    card.costs = nextCosts;
  }
  return card;
}

// #12 双子op統合: 旧ダメージ軽減/無効・旧遅延破壊 op を新opへ寄せる（effect-op desugar）。
function desugarTwinEffectOps(effect) {
  if (effect.op === "reduceNextDamage") {
    return { ...effect, op: "preventNextDamage", amount: effect.amount ?? 1 };
  }
  if (effect.op === "preventNextDamage" && effect.all === undefined && effect.amount === undefined) {
    return { ...effect, all: true };
  }
  if (effect.op === "setDelayedDestroyAtOpponentTurnEnd") {
    const { op, ...rest } = effect;
    return { ...rest, op: "setDelayedDestroy", when: "opponentTurnEnd" };
  }
  if (effect.op === "setDelayedDestroyAtTurnEnd") {
    const { op, ...rest } = effect;
    // target あり = 解決カード所有者のターン終了時（when 省略でその意味）。target なし = 自分のターン終了時。
    return effect.target
      ? { ...rest, op: "setDelayedDestroy" }
      : { ...rest, op: "setDelayedDestroy", when: "ownTurnEnd" };
  }
  return effect;
}

// #13 強化/破壊/量参照 op族統合: destroyAll/destroySelf・modifyStatsAll/IfTarget*・
// 継続 modifyStatsByDropAttributeCount を合成可能な destroy{scope}/modifyStats{scope|conditions|amountFrom} へ寄せる。
function desugarStatDestroyEffectOps(effect) {
  if (effect.op === "destroyAll") {
    const { op, controller, ...rest } = effect;
    return { ...rest, op: "destroy", scope: controller || "all" };
  }
  if (effect.op === "destroySelf") {
    const { op, options, ...rest } = effect;
    return { ...rest, op: "destroy", target: "$self", options: { ignoreSoulguard: true, ...(options || {}) } };
  }
  if (effect.op === "modifyStatsAll") {
    const { op, controller, ...rest } = effect;
    return { ...rest, op: "modifyStats", scope: controller || "all", duration: effect.duration || "turn" };
  }
  if (effect.op === "modifyStatsIfTargetAttribute") {
    const { op, attribute, ...rest } = effect;
    return {
      ...rest,
      op: "modifyStats",
      duration: effect.duration || "battle",
      conditions: [...(effect.conditions || []), { op: "targetMatches", filter: { attribute } }],
    };
  }
  if (effect.op === "modifyStatsIfTargetName") {
    const { op, name, nameIncludes, ...rest } = effect;
    const filter = nameIncludes ? { nameIncludes } : { name };
    return {
      ...rest,
      op: "modifyStats",
      duration: effect.duration || "battle",
      conditions: [...(effect.conditions || []), { op: "targetMatches", filter }],
    };
  }
  if (effect.op === "modifyStatsByDropAttributeCount") {
    const { op, dropFilter, attribute, max, powerPerCard, defensePerCard, criticalPerCard, power, defense, critical, ...rest } = effect;
    return {
      ...rest,
      op: "modifyStats",
      amountFrom: {
        source: "dropAttributeCount",
        filter: dropFilter || { attribute },
        max,
        per: {
          power: powerPerCard ?? power ?? 0,
          defense: defensePerCard ?? defense ?? 0,
          critical: criticalPerCard ?? critical ?? 0,
        },
      },
    };
  }
  return effect;
}

function desugarEffectOp(effect) {
  return desugarStatDestroyEffectOps(desugarTwinEffectOps(effect));
}

function desugarCardFlags(card) {
  if (card.__flagsDesugared) return card;
  card.__flagsDesugared = true;
  // 名称指定の無効化耐性(単独攻撃) → attackResistances（条件×フィルタ×耐性種別）
  const names = Array.isArray(card.ignoreNamedDefenseWhenAlone)
    ? card.ignoreNamedDefenseWhenAlone
    : card.ignoresDragonShieldWhenAlone ? ["ドラゴンシールド"] : null;
  if (names) {
    card.attackResistances = [
      ...(card.attackResistances || []),
      { conditions: [{ op: "attackingAlone" }], filter: { anyOf: names.map((n) => ({ nameIncludes: n })) }, effects: ["nullify", "reduce"] },
    ];
  }
  // 無効化されない(必殺技ガルガンチュア等の名前ハードコード effect:"gargantua") → 汎用 cannotBeNullified
  if (card.effect === "gargantua") card.cannotBeNullified = true;
  // マジックW魔法コスト軽減 keyword → filter駆動 costReduction
  if ((card.keywords || []).includes("reduceMagicWorldSpellGaugeCost")) {
    card.costReduction = [
      ...(card.costReduction || []),
      { purpose: "cast", filter: { world: "マジックW", cardType: "spell" }, payOp: "payGauge", amount: 1 },
    ];
  }
  // 破壊時ソウル手札回収フラグ → onDestroy
  if (card.returnSoulToHandOnDestroy && !card.onDestroy) {
    card.onDestroy = { moveSoulTo: "hand" };
  }
  // dragoenergy のカード名ハードコード(effect 直書き)を廃止し、counterKind 宣言フィールドへ。
  // 旧 selectedCounterKind は id/effect を直接判定していた。JSON は無改変のまま counterKind を付与する。
  if (!card.counterKind && card.effect === "dragoenergy") {
    card.counterKind = "dragoenergy";
  }
  // 旧 onEnter 文字列 → 構造化 triggered/enter ability（後方互換 desugar）。
  // 既に enter triggered ability を持つカードには追加しない（二重発火防止）。
  if (card.onEnter === "destroy-opponent-size2") {
    const hasEnterAbility = (card.abilities || []).some(
      (ability) => ability.kind === "triggered" && ability.event === "enter",
    );
    if (!hasEnterAbility) {
      card.abilities = [
        ...(card.abilities || []),
        {
          id: `${card.id || "card"}-on-enter-destroy-size2`,
          kind: "triggered",
          event: "enter",
          target: {
            type: "fieldCard",
            controller: "opponent",
            filter: { cardType: "monster", sizeLte: 2 },
          },
          effects: [{ op: "destroy", target: "$target" }],
        },
      ];
    }
  }
  // 破壊時の特殊コール権 → callConditions（specialCallOpportunityMatches）へ統一。
  if (
    card.specialCallOnDestroyed &&
    !(card.callConditions || []).some((entry) => entry.op === "specialCallOpportunityMatches")
  ) {
    card.callConditions = [
      ...(card.callConditions || []),
      {
        op: "specialCallOpportunityMatches",
        kind: "destroyed",
        controller: "self",
        filter: card.specialCallOnDestroyed.filter || {},
      },
    ];
  }
  // #11 自身の固定攻撃ゾーン制限 → continuous restrictAttackTargets（自分自身のみ）。
  if (Array.isArray(card.cannotAttackZones) && card.cannotAttackZones.length) {
    card.continuous = [
      ...(card.continuous || []),
      {
        op: "restrictAttackTargets",
        filter: { sameInstanceAsSource: true },
        zones: [...card.cannotAttackZones],
      },
    ];
  }
  // #11 連携攻撃時の課金 set魔法フラグ → 汎用 attackTax[]。
  if (card.linkAttackTax && !card.attackTax) {
    const tax = card.linkAttackTax;
    card.attackTax = [
      {
        appliesTo: "linkOnly",
        targetType: "monster",
        sourcePosition: "set",
        controller: "opponentOfAttacker",
        payer: "attacker",
        targetFilter: tax.targetAttribute ? { attribute: tax.targetAttribute } : undefined,
        cost: tax.cost || [],
        onFail: tax.onFail === "nullifyAttack" ? "nullifyAttack" : "none",
      },
    ];
  }
  // #12/#13 effect-op desugar: 双子op・強化/破壊/量参照op族を合成可能な新opへ寄せる。
  mapCardEffectOps(card, desugarEffectOp);
  return card;
}

function normalizeCardDefinition(card, set = {}) {
  return desugarCardFlags({
    ...card,
    productId: card.productId || set.id || "",
    productName: card.productName || set.name || "",
    aliases: [...(card.aliases || [])],
    attributes: [...(card.attributes || [])],
    keywords: [...(card.keywords || [])],
    rules: [...(card.rules || [])],
    allowedWorlds: [...(card.allowedWorlds || [])],
    allowedAttributes: [...(card.allowedAttributes || [])],
    allowedAttributeIncludes: [...(card.allowedAttributeIncludes || [])],
    allowedCardTypes: [...(card.allowedCardTypes || [])],
    forbiddenTypes: [...(card.forbiddenTypes || [])],
    callCost: { ...(card.callCost || {}) },
    castCost: { ...(card.castCost || {}) },
    equipCost: { ...(card.equipCost || {}) },
    costs: deepClone(card.costs || {}),
    abilities: deepClone(card.abilities || []).map(normalizeAbilityDefinition),
  });
}

function normalizeAbilityDefinition(ability) {
  const normalized = { ...ability };
  if (!Array.isArray(normalized.script) || normalized.script.length === 0) {
    const legacyScript = legacyAbilityScriptDefinition(normalized.handler);
    if (legacyScript) {
      normalized.script = legacyScript;
      delete normalized.handler;
    }
  }
  return normalized;
}

// 旧 handler 文字列 → 構造化 script のデータ表。出荷カードはすべて inline script を
// 持つため実カードはこの経路を通らないが、「handler 文字列という旧スキーマも受理する」
// という後方互換契約のため定義を残す（#4: 全廃ではなく表化＋dispatch温存）。
const LEGACY_HANDLER_SCRIPTS = {
  "asmodai-on-enter": [
    {
      op: "selectCards",
      var: "discard",
      from: "hand",
      controller: "self",
      amount: 1,
      require: true,
      title: "魔王 アスモダイで捨てる手札",
      lead: "手札から捨てるカードを1枚選んでください。",
    },
    {
      op: "moveSelected",
      var: "discard",
      to: "drop",
      log: "discard",
    },
    {
      op: "selectCards",
      var: "destroyTarget",
      from: "field",
      controller: "any",
      filter: {
        cardType: "monster",
      },
      amount: 1,
      require: true,
      title: "魔王 アスモダイで破壊するモンスター",
      lead: "破壊する場のモンスターを1枚選んでください。",
    },
    {
      op: "destroySelected",
      var: "destroyTarget",
    },
  ],
  "quick-summon": [
    {
      op: "selectCards",
      var: "calledMonster",
      from: "hand",
      controller: "self",
      callable: true,
      canUseForFlag: true,
      canPayCost: "call",
      amount: 1,
      require: true,
      title: "クイックサモンでコールするモンスター",
      lead: "手札からコールするモンスターを選んでください。",
    },
    {
      op: "selectZone",
      var: "callZone",
      cardVar: "calledMonster",
      zones: ["left", "center", "right"],
      title: "クイックサモンのコール先",
      lead: "コールするエリアを選んでください。",
    },
    {
      op: "payCardCostForSelection",
      var: "calledMonster",
      purpose: "call",
    },
    {
      op: "callSelected",
      var: "calledMonster",
      zoneVar: "callZone",
      grantKeywords: ["counterattack"],
      redirectPendingAttack: true,
      resolveOnEnter: true,
    },
  ],
};

function legacyAbilityScriptDefinition(handler) {
  const script = LEGACY_HANDLER_SCRIPTS[handler];
  // 呼び出し側で配列要素を共有・破壊しないよう deepClone して返す。
  return script ? deepClone(script) : null;
}

function normalizeFlagDefinitions(flagsData = {}) {
  const set = flagsData.product || { id: "common-flags", name: "共通フラッグ" };
  return (flagsData.flags || []).map((flag) => normalizeCardDefinition(flag, set));
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

function normalizeDeckProfile(deck, set = {}) {
  return {
    ...deck,
    flag: canonicalFlagId(deck.flag || ""),
    productId: deck.productId || set.id || "",
    productName: deck.productName || set.name || "",
    recipe: [...(deck.recipe || [])],
  };
}

function loadCustomDeckProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(customDeckStorageKey) || "[]");
    const decks = Array.isArray(parsed) ? parsed : parsed.decks || [];
    return decks
      .filter((deck) => deck && deck.id && deck.name && deck.flag && Array.isArray(deck.recipe))
      .map((deck) => normalizeDeckProfile(deck, { id: "custom", name: "ユーザー作成デッキ" }));
  } catch (error) {
    console.warn("ユーザーデッキを読み込めませんでした。", error);
    return [];
  }
}

function deckReferencesKnown(deck) {
  const ids = new Set(cardLibrary.map((card) => card.id));
  return (
    ids.has(deck.flag) &&
    (!deck.buddy || ids.has(deck.buddy)) &&
    deck.recipe.every(([id]) => ids.has(id))
  );
}

function validateGameData() {
  if (deckProfiles.length < 1) {
    throw new Error("対戦用のデッキ定義が必要です。");
  }
  const ids = new Set(cardLibrary.map((card) => card.id));
  deckProfiles.forEach((deck) => {
    if (!ids.has(deck.flag)) {
      throw new Error(`${deck.name} のフラッグ定義が見つかりません: ${deck.flag}`);
    }
    if (deck.buddy && !ids.has(deck.buddy)) {
      throw new Error(`${deck.name} のバディ定義が見つかりません: ${deck.buddy}`);
    }
    deck.recipe.forEach(([id]) => {
      if (!ids.has(id)) {
        throw new Error(`${deck.name} のカード定義が見つかりません: ${id}`);
      }
    });
  });
}

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

function drawCards(player, count = 1, shouldLog = true) {
  for (let index = 0; index < count; index += 1) {
    if (player.deck.length === 0) {
      if (shouldLog) {
        addLog(`${player.name}のデッキが0枚です。`);
      }
      declareDeckLoss(player);
      return;
    }
    const card = player.deck.pop();
    if (card) {
      player.hand.push(card);
      if (player.deck.length === 0) {
        if (shouldLog) {
          addLog(`${player.name}のデッキが0枚になりました。`);
        }
        declareDeckLoss(player);
        return;
      }
    }
  }
}

function applyDamageToPlayer(owner, amount = 0, options = {}) {
  const player = state.players[owner];
  if (!player || amount <= 0) {
    return 0;
  }
  state.damagePrevention ||= [[], []];
  state.damagePrevention[owner] ||= [];
  let remaining = amount;
  // 軽減/無効の無視判定: 名称配列(後方互換) または attackResistances由来の filter エントリ
  const ignoreNames = options.ignoreNamedPreventions
    || (options.ignoreNamedPrevention ? [options.ignoreNamedPrevention] : []);
  const resistEntries = options.resistEntries || [];
  const isPreventionResisted = (prevention) =>
    ignoreNames.some((n) => (prevention.source || "").includes(n)) ||
    resistEntries.some((e) => resistanceFilterMatches(e.filter, prevention.sourceCard, prevention.source));
  const queue = state.damagePrevention[owner];
  let i = 0;
  while (!options.ignorePrevention && remaining > 0 && i < queue.length) {
    const prevention = queue[i];
    if (isPreventionResisted(prevention)) {
      // この攻撃には適用しない（キューには残す）
      i += 1;
      continue;
    }
    const reduction = prevention.preventAll ? remaining : Math.min(remaining, prevention.amount || 0);
    remaining -= reduction;
    if (!prevention.preventAll) {
      prevention.amount = Math.max(0, (prevention.amount || 0) - reduction);
    }
    if (reduction > 0) {
      addLog(`${prevention.source || "効果"}により${player.name}へのダメージを${reduction}減らしました。`);
    }
    if (prevention.preventAll || prevention.amount <= 0 || prevention.once !== false) {
      queue.splice(i, 1);
    } else {
      i += 1;
    }
  }
  if (remaining > 0) {
    player.life -= remaining;
    // 受けたダメージ量を記録（豪胆逆怒などの「受けたダメージと同じ数値分」効果が参照する）
    state.lastDamageTaken ||= [0, 0];
    state.lastDamageTaken[owner] = remaining;
    if (options.log !== false && options.sourceName) {
      addLog(`${options.sourceName}により${player.name}に${remaining}ダメージを与えました。`);
    }
    checkWinner();
  }
  return remaining;
}

function addNextDamagePrevention(owner, prevention) {
  state.damagePrevention ||= [[], []];
  state.damagePrevention[owner] ||= [];
  state.damagePrevention[owner].push({
    untilTurnOwner: state.active,
    once: true,
    ...prevention,
  });
}

function spendGauge(player, amount = 0) {
  if (player.gauge.length < amount) {
    return false;
  }
  const spent = player.gauge.splice(player.gauge.length - amount, amount);
  player.drop.push(...spent);
  return true;
}

function canSpendGaugePool(player, amount = 0, options = {}) {
  if (player.gauge.length >= amount) {
    return true;
  }
  const owner = state.players.indexOf(player);
  const opponent = state.players[1 - owner];
  return Boolean(options.includeOpponent && player.gauge.length + (opponent?.gauge.length || 0) >= amount);
}

function spendGaugePool(player, amount = 0, options = {}) {
  if (!canSpendGaugePool(player, amount, options)) {
    return false;
  }
  const ownAmount = Math.min(player.gauge.length, amount);
  spendGauge(player, ownAmount);
  const remaining = amount - ownAmount;
  if (remaining > 0) {
    const owner = state.players.indexOf(player);
    const opponent = state.players[1 - owner];
    spendGauge(opponent, remaining);
    addLog(`${player.name}は相手のゲージ${remaining}枚をコストに使いました。`);
  }
  return true;
}

function canPayCost(player, cost = {}, selectedCard) {
  const gauge = cost.gauge || 0;
  const discard = cost.discard || 0;
  if (player.gauge.length < gauge) {
    return { ok: false, reason: "ゲージが足りません。" };
  }
  const availableHand = player.hand.filter((card) => card.instanceId !== selectedCard?.instanceId);
  if (availableHand.length < discard) {
    return { ok: false, reason: "コストで捨てる手札が足りません。" };
  }
  return { ok: true, discarded: discard > 0 ? availableHand.slice(-discard) : [] };
}

function payCost(player, cost = {}, selectedCard) {
  const payment = canPayCost(player, cost, selectedCard);
  if (!payment.ok) {
    return payment;
  }
  if (!spendGauge(player, cost.gauge || 0)) {
    return { ok: false, reason: "ゲージが足りません。" };
  }
  (payment.discarded || []).forEach((card) => {
    const index = player.hand.findIndex((candidate) => candidate.instanceId === card.instanceId);
    if (index >= 0) {
      player.drop.push(player.hand.splice(index, 1)[0]);
    }
  });
  return { ok: true, discarded: payment.discarded || [] };
}

async function payCostWithSelection(player, cost = {}, selectedCard) {
  const payment = canPayCost(player, cost, selectedCard);
  if (!payment.ok) {
    return payment;
  }
  const discard = cost.discard || 0;
  let selected = [];
  if (discard <= 0) {
    selected = [];
  } else {
    const candidates = player.hand
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => card.instanceId !== selectedCard?.instanceId);
    selected = await chooseCardEntries(candidates, {
      title: "コストで捨てる手札",
      lead: `手札からコストで捨てるカードを${discard}枚選んでください。`,
      min: discard,
      max: discard,
      forceDialog: true,
    });
    if (!selected || selected.length < discard) {
      return { ok: false, reason: "コストで捨てる手札を選んでください。" };
    }
  }
  if (!spendGauge(player, cost.gauge || 0)) {
    return { ok: false, reason: "ゲージが足りません。" };
  }
  const discarded = removePileEntries(player.hand, selected);
  player.drop.push(...discarded);
  if (discarded.length > 0) {
    addLog(`${player.name}はコストで${discarded.map((card) => card.name).join("、")}を捨てました。`);
  }
  return { ok: true, discarded };
}

function canPayCardCost(player, card, purpose, selectedCard = card, context = {}) {
  const structuredCost = cardCostSteps(player, card, purpose, context);
  if (structuredCost.exists) {
    return canPayStructuredCost(player, structuredCost.steps, {
      ...context,
      sourceCard: context.sourceCard || card,
      selectedCard,
    });
  }
  const legacyKey = {
    call: "callCost",
    cast: "castCost",
    equip: "equipCost",
  }[purpose];
  return canPayCost(player, adjustedLegacyCost(player, card, purpose, card[legacyKey]), selectedCard);
}

function payCardCost(player, card, purpose, selectedCard = card, context = {}) {
  const structuredCost = cardCostSteps(player, card, purpose, context);
  if (structuredCost.exists) {
    return payStructuredCost(player, structuredCost.steps, {
      ...context,
      sourceCard: context.sourceCard || card,
      selectedCard,
    });
  }
  const legacyKey = {
    call: "callCost",
    cast: "castCost",
    equip: "equipCost",
  }[purpose];
  return payCost(player, adjustedLegacyCost(player, card, purpose, card[legacyKey]), selectedCard);
}

async function payCardCostWithSelection(player, card, purpose, selectedCard = card, context = {}) {
  const structuredCost = cardCostSteps(player, card, purpose, context);
  if (structuredCost.exists) {
    return payStructuredCostWithSelection(player, structuredCost.steps, {
      ...context,
      sourceCard: context.sourceCard || card,
      selectedCard,
    });
  }
  const legacyKey = {
    call: "callCost",
    cast: "castCost",
    equip: "equipCost",
  }[purpose];
  return payCostWithSelection(player, adjustedLegacyCost(player, card, purpose, card[legacyKey]), selectedCard);
}

function cardCostSteps(player, card, purpose, context = {}) {
  const rawCost = card.costs?.[purpose] ?? context.cost;
  if (!Array.isArray(rawCost)) {
    return { exists: false, steps: [] };
  }
  return {
    exists: true,
    steps: adjustedCostSteps(player, card, purpose, rawCost),
  };
}

function fieldCostReductions(player) {
  // 場のカードが供給する汎用コスト軽減（costReduction:[{purpose,filter,payOp,amount}]）を集約
  const out = [];
  zones.forEach((zone) => {
    const c = player.field[zone];
    (c?.costReduction || []).forEach((r) => out.push(r));
  });
  return out;
}

function costReductionApplies(reduction, card, purpose) {
  return (reduction.purpose || "cast") === purpose && matchesCardFilter(card, reduction.filter || {});
}

function adjustedLegacyCost(player, card, purpose, cost = {}) {
  const adjusted = { ...(cost || {}) };
  fieldCostReductions(player).forEach((r) => {
    if (!costReductionApplies(r, card, purpose)) return;
    const key = r.payOp === "payLife" ? "life" : "gauge";
    if ((adjusted[key] || 0) > 0) adjusted[key] = Math.max(0, adjusted[key] - (r.amount || 1));
  });
  return adjusted;
}

function adjustedCostSteps(player, card, purpose, costSteps = []) {
  const steps = deepClone(costSteps || []);
  fieldCostReductions(player).forEach((r) => {
    if (!costReductionApplies(r, card, purpose)) return;
    const payOp = r.payOp || "payGauge";
    const step = steps.find((st) => st.op === payOp && (st.amount || 0) > 0);
    if (step) step.amount = Math.max(0, step.amount - (r.amount || 1));
  });
  return steps.filter((step) => step.amount === undefined || step.amount > 0);
}

function hasFieldKeyword(player, keyword) {
  return zones.some((zone) => {
    const card = player.field[zone];
    return card && hasKeyword(card, keyword);
  });
}

function canPayStructuredCost(player, costSteps = [], context = {}) {
  const selectedCard = context.selectedCard;
  const includeOpponentGauge = Boolean(context.includeOpponentGauge);
  const applicableCostSteps = costSteps.filter((step) => costStepApplies(player, step, context));
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge" && !canSpendGaugePool(player, amount, { includeOpponent: includeOpponentGauge })) {
      return { ok: false, reason: "ゲージが足りません。" };
    }
    if (step.op === "discardHand") {
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      if (availableHand.length < amount) {
        return { ok: false, reason: "コストで捨てる手札が足りません。" };
      }
    }
    if (step.op === "putHandToSoul") {
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      const minimum = step.min ?? amount;
      if (availableHand.length < minimum) {
        return { ok: false, reason: "ソウルに入れる手札が足りません。" };
      }
    }
    if (step.op === "putCardToSoul") {
      const candidates = cardToSoulCostCandidates(player, step, selectedCard);
      const minimum = step.min ?? amount;
      if (candidates.length < minimum) {
        return { ok: false, reason: "ソウルに入れるカードが足りません。" };
      }
    }
    if (step.op === "payLife" && player.life <= amount) {
      return { ok: false, reason: "ライフが足りません。" };
    }
    if (["cancelRecentLifeLink", "cancelLifeLink"].includes(step.op)) {
      const owner = state.players.indexOf(player);
      if (!findRecentLifeLinkEvent(owner, step)) {
        return { ok: false, reason: "Life Link to cancel was not found." };
      }
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      const owner = state.players.indexOf(player);
      if (!findSpecialCallOpportunity(owner, step)) {
        return { ok: false, reason: "Special call opportunity was not found." };
      }
      if (!findLifeLinkEventForCallOpportunity(owner, step)) {
        return { ok: false, reason: "Life Link to cancel was not found." };
      }
    }
    if (step.op === "putTopDeckToSoul" && player.deck.length < amount) {
      return { ok: false, reason: "ソウルに入れるデッキ枚数が足りません。" };
    }
    if (step.op === "putDropToSoul" && matchingCardsFromPile(player.drop, step.filter).length < (step.min ?? amount)) {
      return { ok: false, reason: "ソウルに入れるドロップのカードが足りません。" };
    }
    if (step.op === "discardSoul" && (context.sourceCard?.soul?.length || 0) < amount) {
      return { ok: false, reason: "ソウルが足りません。" };
    }
    if (step.op === "dropSource" && !findFieldCardSlot(context.sourceCard)) {
      return { ok: false, reason: "コストでドロップゾーンに置くカードが場にありません。" };
    }
    if (step.op === "dropOwnMonster") {
      const explicitTarget = getDropOwnMonsterCostTarget(player, context);
      const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
      const candidates = explicitTarget ? [explicitTarget] : dropOwnMonsterCostCandidates(player, step.filter, excludeId);
      if (candidates.length < amount || (!explicitTarget && !context.allowInteractiveSelection)) {
        return { ok: false, reason: "コストでドロップに置く自分のモンスターを選んでください。" };
      }
    }
    if (step.op === "returnPendingTargetToHand") {
      const owner = state.players.indexOf(player);
      const target = getPendingBattleTargetInfo(state.pendingAttack);
      if (
        !target?.card ||
        target.owner !== owner ||
        cannotReturnToHand(target.card) ||
        !matchesTargetFilter(target.card, target.owner, target.zone, step.filter || {})
      ) {
        return { ok: false, reason: "コストで手札に戻す対象のモンスターがいません。" };
      }
    }
    if (step.op === "putOwnFieldCardsToGauge") {
      const candidates = ownFieldCostCandidates(player, step.filter);
      if (candidates.length < amount) {
        return { ok: false, reason: "コストでゲージに置く自分の場のカードが足りません。" };
      }
    }
  }
  return { ok: true };
}

function getDropOwnMonsterCostTarget(player, context = {}) {
  const owner = state.players.indexOf(player);
  const target = context.costTarget || context.target || getEffectTargetInfo();
  if (
    target &&
    target.owner === owner &&
    fieldZones.includes(target.zone) &&
    effectiveCardType(target.card) === "monster"
  ) {
    return target;
  }
  return null;
}

function dropOwnMonsterCostCandidates(player, filter = {}, excludeInstanceId = null) {
  const owner = state.players.indexOf(player);
  return fieldZones
    .map((zone) => ({ owner, zone, card: player.field[zone], source: "field" }))
    .filter(
      ({ card, zone }) =>
        card &&
        card.instanceId !== excludeInstanceId &&
        matchesTargetFilter(card, owner, zone, { cardType: "monster", ...filter }),
    );
}

function ownFieldCostCandidates(player, filter = {}) {
  const owner = state.players.indexOf(player);
  return zones
    .map((zone) => ({ owner, zone, card: player.field[zone], source: "field" }))
    .filter(({ card, zone }) => card && matchesTargetFilter(card, owner, zone, filter));
}

function cardToSoulCostCandidates(player, step = {}, selectedCard = null, reservedHandIds = new Set()) {
  const owner = state.players.indexOf(player);
  const sources = step.sources || (step.from ? [step.from] : ["hand"]);
  const candidates = [];
  sources.forEach((source) => {
    const pile = player[source];
    if (!Array.isArray(pile)) {
      return;
    }
    pile.forEach((card, index) => {
      if (card.instanceId === selectedCard?.instanceId) {
        return;
      }
      if (source === "hand" && reservedHandIds.has(card.instanceId)) {
        return;
      }
      if (!matchesCardFilter(card, step.filter || {})) {
        return;
      }
      candidates.push({
        card,
        index,
        owner,
        source,
        note: scriptSourceLabel(source),
      });
    });
  });
  return candidates;
}

function costStepApplies(player, step = {}, context = {}) {
  if (!step.conditions?.length) {
    return true;
  }
  const owner = state.players.indexOf(player);
  return checkCardConditions(step.conditions, owner, {
    ...context,
    card: context.sourceCard || context.selectedCard,
  });
}

function moveCostEntriesToSoul(player, entries, sourceCard) {
  const bySource = new Map();
  entries.forEach((entry) => {
    const group = bySource.get(entry.source) || [];
    group.push(entry);
    bySource.set(entry.source, group);
  });
  const movedCards = [];
  bySource.forEach((group, source) => {
    const pile = player[source];
    if (!Array.isArray(pile)) {
      return;
    }
    movedCards.push(...removePileEntries(pile, group));
    if (source === "deck") {
      shuffleInPlace(pile);
      addLog(`${player.name}はデッキをシャッフルしました。`);
    }
  });
  if (movedCards.length > 0) {
    sourceCard.soul ||= [];
    sourceCard.soul.push(...movedCards);
    addLog(`${player.name}はコストで${movedCards.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`);
  }
  return movedCards;
}

function chooseCostEntriesSync(candidates, options = {}) {
  const amount = options.max ?? options.amount ?? 1;
  if ((candidates || []).length <= amount) {
    return (candidates || []).slice(0, amount);
  }
  return fallbackCardEntrySelection(candidates, {
    min: options.min ?? amount,
    max: amount,
    title: options.title || "コストのカード選択",
  });
}

function payStructuredCost(player, costSteps = [], context = {}) {
  const payment = canPayStructuredCost(player, costSteps, context);
  if (!payment.ok) {
    return payment;
  }
  const sourceCard = context.sourceCard;
  const selectedCard = context.selectedCard;
  const includeOpponentGauge = Boolean(context.includeOpponentGauge);
  const applicableCostSteps = costSteps.filter((step) => costStepApplies(player, step, context));
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge") {
      spendGaugePool(player, amount, { includeOpponent: includeOpponentGauge });
    }
    if (step.op === "discardHand") {
      const candidates = player.hand
        .map((card, index) => ({ card, index }))
        .filter(
          ({ card }) =>
            card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
        );
      const selected = chooseCostEntriesSync(candidates, {
        amount,
        min: amount,
        max: amount,
        title: `${sourceCard?.name || "コスト"}で捨てる手札`,
      });
      discardHandCardsToDrop(player, removePileEntries(player.hand, selected || []));
    }
    if (step.op === "putHandToSoul") {
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      availableHand.slice(-amount).forEach((card) => {
        const index = player.hand.findIndex((candidate) => candidate.instanceId === card.instanceId);
        if (index >= 0) {
          sourceCard.soul ||= [];
          sourceCard.soul.push(player.hand.splice(index, 1)[0]);
        }
      });
    }
    if (step.op === "putCardToSoul") {
      const candidates = cardToSoulCostCandidates(player, step, selectedCard).slice(0, amount);
      moveCostEntriesToSoul(player, candidates, sourceCard);
    }
    if (step.op === "payLife") {
      player.life -= amount;
    }
    if (step.op === "returnPendingTargetToHand") {
      const target = getPendingBattleTargetInfo(state.pendingAttack);
      if (target?.card) {
        returnFieldTargetToHand(target, sourceCard?.name || "効果");
      }
    }
    if (["cancelRecentLifeLink", "cancelLifeLink"].includes(step.op)) {
      cancelRecentLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      cancelCallOpportunityLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "putTopDeckToSoul") {
      moveTopDeckToSoul(player, sourceCard, amount);
    }
    if (step.op === "putDropToSoul") {
      moveDropToSoul(player, sourceCard, amount, step.filter);
    }
    if (step.op === "discardSoul") {
      for (let index = 0; index < amount; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.drop.push(soulCard);
        }
      }
    }
    if (step.op === "dropSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        dropFieldCardByRule(player, slot.zone);
      }
    }
    if (step.op === "dropOwnMonster") {
      const target = getEffectTargetInfo();
      if (target && target.owner === state.players.indexOf(player) && fieldZones.includes(target.zone)) {
        const dropped = dropFieldCardByRule(player, target.zone);
        if (dropped) {
          addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
        }
      }
    }
    if (step.op === "putOwnFieldCardsToGauge") {
      ownFieldCostCandidates(player, step.filter)
        .slice(0, amount)
        .forEach((target) => putFieldCardToGauge(player, target.zone));
    }
  }
  checkWinner();
  return { ok: true };
}

async function payStructuredCostWithSelection(player, costSteps = [], context = {}) {
  const payment = canPayStructuredCost(player, costSteps, {
    ...context,
    allowInteractiveSelection: true,
  });
  if (!payment.ok) {
    return payment;
  }
  const applicableCostSteps = costSteps.filter((step) => costStepApplies(player, step, context));
  const selectedCard = context.selectedCard;
  const reservedHandIds = new Set();
  const handDiscards = [];
  const handToSoulSelections = [];
  const reservedCostZones = new Set();
  const dropOwnMonsterSelections = [];
  const fieldToGaugeSelections = [];
  const cardToSoulSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "discardHand") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = player.hand
      .map((card, index) => ({ card, index }))
      .filter(
        ({ card }) =>
          card.instanceId !== selectedCard?.instanceId &&
          !reservedHandIds.has(card.instanceId) &&
          matchesCardFilter(card, step.filter || {}),
      );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}で捨てる手札`,
      lead: `手札からコストで捨てるカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストで捨てる手札を選んでください。" };
    }
    selected.forEach(({ card }) => reservedHandIds.add(card.instanceId));
    handDiscards.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putHandToSoul") {
      continue;
    }
    const amount = step.amount || step.max || 1;
    const minimum = step.min ?? amount;
    const maximum = Math.min(step.max ?? amount, amount);
    const candidates = player.hand
      .map((card, index) => ({ card, index }))
      .filter(
        ({ card }) =>
          card.instanceId !== selectedCard?.instanceId &&
          !reservedHandIds.has(card.instanceId) &&
          matchesCardFilter(card, step.filter || {}),
      );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でソウルに入れる手札`,
      lead: `手札からソウルに入れるカードを${minimum}～${maximum}枚選んでください。`,
      min: minimum,
      max: maximum,
      forceDialog: true,
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: "コストでソウルに入れる手札を選んでください。" };
    }
    selected.forEach(({ card }) => reservedHandIds.add(card.instanceId));
    handToSoulSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "dropOwnMonster") {
      continue;
    }
    const amount = step.amount || 1;
    const explicitTarget = getDropOwnMonsterCostTarget(player, context);
    if (explicitTarget && !reservedCostZones.has(`${explicitTarget.owner}:${explicitTarget.zone}`)) {
      reservedCostZones.add(`${explicitTarget.owner}:${explicitTarget.zone}`);
      dropOwnMonsterSelections.push([explicitTarget]);
      continue;
    }
    const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
    const candidates = dropOwnMonsterCostCandidates(player, step.filter, excludeId).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でドロップに置くモンスター`,
      lead: `場の自分のモンスターを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストでドロップに置く自分のモンスターを選んでください。" };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    dropOwnMonsterSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putOwnFieldCardsToGauge") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = ownFieldCostCandidates(player, step.filter).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でゲージに置くカード`,
      lead: `自分の場からゲージに置くカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: "コストでゲージに置く自分の場のカードを選んでください。" };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    fieldToGaugeSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putCardToSoul") {
      continue;
    }
    const amount = step.amount || step.max || 1;
    const minimum = step.min ?? amount;
    const maximum = Math.min(step.max ?? amount, amount);
    const candidates = cardToSoulCostCandidates(player, step, selectedCard, reservedHandIds);
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でソウルに入れるカード`,
      lead: `指定された領域からソウルに入れるカードを${minimum}～${maximum}枚選んでください。`,
      min: minimum,
      max: maximum,
      forceDialog: true,
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: "コストでソウルに入れるカードを選んでください。" };
    }
    selected
      .filter((entry) => entry.source === "hand")
      .forEach(({ card }) => reservedHandIds.add(card.instanceId));
    cardToSoulSelections.push(selected);
  }

  const sourceCard = context.sourceCard;
  const includeOpponentGauge = Boolean(context.includeOpponentGauge);
  let discardStepIndex = 0;
  let handToSoulStepIndex = 0;
  let cardToSoulStepIndex = 0;
  let dropOwnMonsterStepIndex = 0;
  let fieldToGaugeStepIndex = 0;
  const discarded = [];
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge") {
      spendGaugePool(player, amount, { includeOpponent: includeOpponentGauge });
    }
    if (step.op === "discardHand") {
      const movedCards = removePileEntries(player.hand, handDiscards[discardStepIndex] || []);
      discardStepIndex += 1;
      discardHandCardsToDrop(player, movedCards);
      discarded.push(...movedCards);
      if (movedCards.length > 0) {
        addLog(`${player.name}はコストで${movedCards.map((card) => card.name).join("、")}を捨てました。`);
      }
    }
    if (step.op === "putHandToSoul") {
      const movedCards = removePileEntries(player.hand, handToSoulSelections[handToSoulStepIndex] || []);
      handToSoulStepIndex += 1;
      sourceCard.soul ||= [];
      sourceCard.soul.push(...movedCards);
      if (movedCards.length > 0) {
        addLog(`${player.name}はコストで${movedCards.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`);
      }
    }
    if (step.op === "putCardToSoul") {
      moveCostEntriesToSoul(player, cardToSoulSelections[cardToSoulStepIndex] || [], sourceCard);
      cardToSoulStepIndex += 1;
    }
    if (step.op === "payLife") {
      player.life -= amount;
    }
    if (step.op === "returnPendingTargetToHand") {
      const target = getPendingBattleTargetInfo(state.pendingAttack);
      if (target?.card) {
        returnFieldTargetToHand(target, sourceCard?.name || "効果");
      }
    }
    if (["cancelRecentLifeLink", "cancelLifeLink"].includes(step.op)) {
      cancelRecentLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      cancelCallOpportunityLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "putTopDeckToSoul") {
      moveTopDeckToSoul(player, sourceCard, amount);
    }
    if (step.op === "putDropToSoul") {
      moveDropToSoul(player, sourceCard, amount, step.filter);
    }
    if (step.op === "discardSoul") {
      for (let index = 0; index < amount; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.drop.push(soulCard);
        }
      }
    }
    if (step.op === "dropSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        dropFieldCardByRule(player, slot.zone);
      }
    }
    if (step.op === "dropOwnMonster") {
      const selectedTargets = dropOwnMonsterSelections[dropOwnMonsterStepIndex] || [];
      dropOwnMonsterStepIndex += 1;
      selectedTargets.forEach((target) => {
        const dropped = dropFieldCardByRule(player, target.zone);
        if (dropped) {
          addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
        }
      });
    }
    if (step.op === "putOwnFieldCardsToGauge") {
      const selectedTargets = fieldToGaugeSelections[fieldToGaugeStepIndex] || [];
      fieldToGaugeStepIndex += 1;
      selectedTargets.forEach((target) => putFieldCardToGauge(player, target.zone));
    }
  }
  checkWinner();
  return { ok: true, discarded };
}

function moveTopDeckToSoul(player, card, amount = 1) {
  card.soul ||= [];
  for (let index = 0; index < amount; index += 1) {
    const soulCard = player.deck.pop();
    if (soulCard) {
      card.soul.push(soulCard);
    }
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
}

function moveTopDeckToGauge(player, amount = 1) {
  for (let index = 0; index < amount; index += 1) {
    const gaugeCard = player.deck.pop();
    if (gaugeCard) {
      player.gauge.push(gaugeCard);
    }
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
}

function moveDropToSoul(player, card, amount = 1, filter = {}) {
  card.soul ||= [];
  const movedCards = takeMatchingCards(player.drop, filter, amount);
  if (movedCards.length > 0) {
    card.soul.push(...movedCards);
    addLog(`${movedCards.map((soulCard) => soulCard.name).join("、")}を${card.name}のソウルに入れました。`);
  }
}

function putFieldCardToGauge(player, zone) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  player.drop.push(...(card.soul || []));
  card.soul = [];
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, state.players.indexOf(player));
  player.gauge.push(card);
  addLog(`${card.name}をコストでゲージに置きました。`);
  return card;
}

function getFieldSize(player) {
  return fieldZones.reduce((total, zone) => total + (player.field[zone]?.size || 0), 0);
}

function fieldSizeLimit(player) {
  return player?.flag?.maxFieldSize ?? 3;
}

function canAddSize(player, card) {
  return getFieldSize(player) + (card.size || 0) <= fieldSizeLimit(player);
}

function visiblePower(card) {
  return Math.max(0,
    (card?.power || 0) +
    (card?.battlePowerBonus || 0) +
    (card?.turnPowerBonus || 0) +
    continuousPowerBonus(card)
  );
}

function visibleDefense(card) {
  return Math.max(0,
    (card?.defense || 0) +
    (card?.battleDefenseBonus || 0) +
    (card?.turnDefenseBonus || 0) +
    continuousDefenseBonus(card)
  );
}

function visibleCritical(card) {
  return Math.max(0,
    (card?.critical || 0) +
    (card?.battleCriticalBonus || 0) +
    (card?.turnCriticalBonus || 0) +
    continuousCriticalBonus(card)
  );
}

// 継続効果のドロップ枚数参照分（旧 modifyStatsByDropAttributeCount と
// 新 modifyStats{amountFrom:{source:"dropAttributeCount"}} を統一）。statKey の単価×枚数。
function continuousDropStatAmount(effect, statKey, player) {
  let filter;
  let max;
  let per;
  if (effect.op === "modifyStatsByDropAttributeCount") {
    filter = effect.dropFilter || { attribute: effect.attribute };
    max = effect.max;
    per = effect[{ power: "powerPerCard", defense: "defensePerCard", critical: "criticalPerCard" }[statKey]] ?? effect[statKey] ?? 0;
  } else if (effect.op === "modifyStats" && effect.amountFrom?.source === "dropAttributeCount") {
    const af = effect.amountFrom;
    filter = af.filter || { attribute: af.attribute };
    max = af.max;
    per = af.per?.[statKey] ?? 0;
  } else {
    return 0;
  }
  if (!per) {
    return 0;
  }
  const count = player.drop.filter((dropCard) => matchesCardFilter(dropCard, filter)).length;
  const capped = max !== undefined ? Math.min(count, max) : count;
  return capped * per;
}

// 場・ソウルの継続 modifyStats（定数 by と amountFrom:dropAttributeCount）から statKey の合計補正値を算出。
function continuousStatBonus(card, statKey) {
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return 0;
  }
  const player = state.players[slot.owner];
  let bonus = 0;
  zones.forEach((zone) => {
    const sourceCard = player.field[zone];
    (sourceCard?.continuous || []).forEach((effect) => {
      if (!continuousEffectApplies(effect, card, sourceCard)) {
        return;
      }
      if (effect.op === "modifyStats") {
        bonus += effect[statKey] || 0;
      }
      bonus += continuousDropStatAmount(effect, statKey, player);
    });
  });
  // 相手側からの越境継続（opposingFront / controller:"opponent" の明示デバフ）も評価する。
  // 自陣バフ（controller 無指定の通常継続）は越境適用しないようゲートする。
  const crossOwner = 1 - slot.owner;
  const crossField = state.players[crossOwner]?.field || {};
  zones.forEach((zone) => {
    const sourceCard = crossField[zone];
    (sourceCard?.continuous || []).forEach((effect) => {
      if (!(effect.opposingFront || effect.controller === "opponent")) {
        return;
      }
      if (!continuousEffectApplies(effect, card, sourceCard)) {
        return;
      }
      if (effect.op === "modifyStats") {
        bonus += effect[statKey] || 0;
      }
      bonus += continuousDropStatAmount(effect, statKey, state.players[crossOwner]);
    });
  });
  soulContinuousEffects(card, slot.owner).forEach(({ effect, sourceCard }) => {
    if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, slot.owner)) {
      return;
    }
    if (effect.op === "modifyStats") {
      bonus += effect[statKey] || 0;
    }
  });
  return bonus;
}

function continuousPowerBonus(card) {
  return continuousStatBonus(card, "power");
}

function continuousDefenseBonus(card) {
  return continuousStatBonus(card, "defense");
}

function continuousCriticalBonus(card) {
  return continuousStatBonus(card, "critical");
}

function soulContinuousEffects(card, owner) {
  if (!card?.soul?.length) {
    return [];
  }
  return card.soul.flatMap((sourceCard) =>
    (sourceCard.soulContinuous || []).map((effect) => ({ sourceCard, effect, owner })),
  );
}

function continuousEffectAppliesFromSoul(effect, targetCard, sourceCard, owner) {
  if (!matchesCardFilter(targetCard, effect.filter || {})) {
    return false;
  }
  if (effect.requireBuddy && targetCard.name !== state.players[owner]?.buddy?.name) {
    return false;
  }
  if (effect.sourceName && sourceCard?.name !== effect.sourceName) {
    return false;
  }
  return true;
}

function continuousEffectApplies(effect, targetCard, sourceCard) {
  if (effect.excludeSource && sourceCard?.instanceId === targetCard?.instanceId) {
    return false;
  }
  if (effect.filter?.sameInstanceAsSource && targetCard?.instanceId !== sourceCard?.instanceId) {
    return false;
  }
  if (effect.filter?.sameNameAsSource && targetCard?.name !== sourceCard?.name) {
    return false;
  }
  if (effect.filter?.sameIdAsSource && targetCard?.id !== sourceCard?.id) {
    return false;
  }
  const sourceSlot = findFieldCardSlot(sourceCard);
  const targetSlot = findFieldCardSlot(targetCard);
  if (effect.opposingFront) {
    // 「このカードの前の相手のモンスター」= 物理的に正面(ミラー列: 左↔右, 中央↔中央)・相手側の1枚にのみ適用。
    // 盤面は相手列が逆順描画のため、正面は同名zoneではなく oppositeFieldZone で対応付ける。
    if (
      !sourceSlot ||
      !targetSlot ||
      sourceSlot.owner === targetSlot.owner ||
      targetSlot.zone !== oppositeFieldZone(sourceSlot.zone)
    ) {
      return false;
    }
  }
  if (effect.controller && sourceSlot && targetSlot) {
    if (effect.controller === "self" && targetSlot.owner !== sourceSlot.owner) {
      return false;
    }
    if (effect.controller === "opponent" && targetSlot.owner === sourceSlot.owner) {
      return false;
    }
  }
  if (effect.conditions?.length) {
    if (!sourceSlot) {
      return false;
    }
    if (!checkCardConditions(effect.conditions, sourceSlot.owner, {
      card: sourceCard,
      zone: sourceSlot.zone,
      targetCard,
    })) {
      return false;
    }
  }
  return matchesCardFilter(targetCard, effect.filter || {});
}

function addLog(message) {
  state?.log.unshift(message);
  if (state && state.log.length > 50) {
    state.log.length = 50;
  }
  recordDiagnosticEvent("message", {
    message,
    severity: classifyDiagnosticMessage(message),
  });
}

function createFightId() {
  return `fight-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function classifyDiagnosticMessage(message) {
  if (/未実装|まだ実装|想定外|エラー|失敗/.test(message)) {
    return "needs_attention";
  }
  if (/できません|足りません|対象.*選|選んでください|無効/.test(message)) {
    return "warning";
  }
  return "info";
}

function recordDiagnosticEvent(type, details = {}) {
  if (!state) {
    return;
  }
  state.diagnosticLog ||= [];
  state.diagnosticSeq = (state.diagnosticSeq || 0) + 1;
  state.diagnosticLog.push({
    seq: state.diagnosticSeq,
    type,
    recordedAt: new Date().toISOString(),
    context: diagnosticContext(),
    ...details,
  });
}

function diagnosticContext() {
  return {
    fightId: state.fightId || "",
    turnCount: state.turnCount,
    phase: state.phase,
    active: state.active,
    activeName: state.players?.[state.active]?.name || "",
    handOwner: Number.isInteger(handOwnerIndexSafe()) ? handOwnerIndexSafe() : null,
    pendingAttack: state.pendingAttack ? targetLabel(state.pendingAttack) : null,
    pendingAction: state.pendingAction ? pendingActionLabel(state.pendingAction) : null,
    selected: diagnosticSelected(),
    winner: state.winner || null,
  };
}

function handOwnerIndexSafe() {
  try {
    return state?.players ? handOwnerIndex() : null;
  } catch {
    return null;
  }
}

function diagnosticSelected() {
  if (!state?.selected) {
    return null;
  }
  return {
    ...state.selected,
    card: compactCardForLog(getSelectedCard()),
  };
}

function compactCardForLog(card) {
  if (!card) {
    return null;
  }
  return {
    id: card.id,
    instanceId: card.instanceId,
    no: card.no || "",
    name: card.name,
    type: card.type,
    currentType: effectiveCardType(card),
    world: card.world || "",
    attributes: [...(card.attributes || [])],
    size: card.size ?? null,
    power: card.power ?? null,
    critical: card.critical ?? null,
    defense: card.defense ?? null,
    used: Boolean(card.used),
    soul: (card.soul || []).map(compactCardForLog),
  };
}

function compactTargetForLog(target) {
  if (!target) {
    return null;
  }
  return {
    owner: target.owner,
    ownerName: state.players?.[target.owner]?.name || "",
    zone: target.zone,
    zoneLabel: zoneLabel(target.zone),
    card: compactCardForLog(target.card),
    note: target.note || "",
  };
}

function compactChoiceForLog(choice) {
  return {
    choiceIndex: choice.choiceIndex,
    index: choice.index,
    owner: choice.owner,
    zone: choice.zone,
    zoneLabel: choice.zone ? zoneLabel(choice.zone) : "",
    note: choice.note || "",
    card: compactCardForLog(choice.card),
  };
}

function compactPlayerForLog(player, owner, options = {}) {
  if (!player) {
    return null;
  }
  const includeDeckOrder = options.includeDeckOrder !== false;
  return {
    owner,
    name: player.name,
    deckName: player.deckName,
    life: player.life,
    flag: compactCardForLog(player.flag),
    buddy: compactCardForLog(player.buddy),
    partnerCalled: Boolean(player.partnerCalled),
    hand: player.hand.map(compactCardForLog),
    gauge: player.gauge.map(compactCardForLog),
    drop: player.drop.map(compactCardForLog),
    deckCount: player.deck.length,
    deck: includeDeckOrder ? player.deck.map(compactCardForLog) : undefined,
    field: Object.fromEntries(
      Object.entries(player.field || {}).map(([zone, card]) => [zone, compactCardForLog(card)]),
    ),
    oncePerTurn: { ...(player.oncePerTurn || {}) },
  };
}

function compactFightStateForLog(options = {}) {
  if (!state?.players) {
    return null;
  }
  return {
    fightId: state.fightId || "",
    turnCount: state.turnCount,
    phase: state.phase,
    active: state.active,
    activeName: state.players[state.active]?.name || "",
    chargedThisTurn: Boolean(state.chargedThisTurn),
    drewThisTurn: Boolean(state.drewThisTurn),
    attacksThisTurn: state.attacksThisTurn || 0,
    winner: state.winner || null,
    selected: diagnosticSelected(),
    pendingAttack: state.pendingAttack ? { ...state.pendingAttack } : null,
    pendingAction: state.pendingAction
      ? {
          ...state.pendingAction,
          card: compactCardForLog(state.pendingAction.card),
        }
      : null,
    players: state.players.map((player, owner) => compactPlayerForLog(player, owner, options)),
  };
}

function buildBattleLogExport() {
  const events = state?.diagnosticLog || [];
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    note: "この診断ログには手札・デッキ順・選択内容など、デバッグ用の非公開情報を含みます。",
    app: {
      ruleEra: ruleEraLabel,
      url: location.href,
      userAgent: navigator.userAgent,
    },
    fight: {
      id: state?.fightId || "",
      finalState: compactFightStateForLog({ includeDeckOrder: true }),
    },
    diagnostics: {
      attentionEvents: events.filter((event) => event.severity === "needs_attention"),
      warningEvents: events.filter((event) => event.severity === "warning"),
      unimplementedMessages: events.filter((event) => /未実装|まだ実装/.test(event.message || "")),
    },
    events,
    visibleLog: [...(state?.log || [])],
  };
}

function downloadBattleLog() {
  if (!state) {
    return;
  }
  recordDiagnosticEvent("export", {
    message: "対戦診断ログを保存しました。",
    severity: "info",
  });
  const payload = buildBattleLogExport();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeLogFileName(state.fightId || "buddyfight-log")}.json`;
  link.click();
  URL.revokeObjectURL(url);
  addLog("対戦診断ログをJSONで保存しました。");
}

function safeLogFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_");
}

function selectHandCard(instanceId) {
  const owner = handOwnerIndex();
  const player = state.players[owner];
  const card = player.hand.find((candidate) => candidate.instanceId === instanceId);
  state.selected = card ? { source: "hand", owner, instanceId } : null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  render();
}

function selectFieldCard(owner, zone) {
  const player = state.players[owner];
  const card = player.field[zone];
  if (!card) {
    return;
  }
  const canSelect =
    (!hasPendingResolution() && owner === state.active) ||
    (state.pendingAttack &&
      [state.pendingAttack.attackerOwner, state.pendingAttack.defender].includes(owner)) ||
    (state.pendingAction && owner === state.pendingAction.responder);
  if (!canSelect) {
    return;
  }
  state.selected = { source: "field", owner, zone, instanceId: card.instanceId };
  state.buddyCallDeclared = null;
  render();
}

function getSelectedCard() {
  if (!state.selected) {
    return null;
  }
  const player = state.players[state.selected.owner];
  if (state.selected.source === "hand") {
    return player.hand.find((card) => card.instanceId === state.selected.instanceId) || null;
  }
  return player.field[state.selected.zone];
}

function removeSelectedFromHand() {
  if (state.selected?.source !== "hand") {
    return null;
  }
  const player = state.players[state.selected.owner];
  const cardIndex = player.hand.findIndex(
    (card) => card.instanceId === state.selected.instanceId,
  );
  if (cardIndex < 0) {
    return null;
  }
  return player.hand.splice(cardIndex, 1)[0];
}

async function drawAction() {
  if (state.winner || hasPendingResolution() || state.drewThisTurn) {
    return;
  }
  if (state.phase !== "draw") {
    addLog("ドローはドローフェイズでのみ行えます。");
    return;
  }
  expireTransientResponseWindows();
  await runPhaseStartTriggers("turnStart", state.active);
  await runPhaseStartTriggers("drawStart", state.active);
  drawCards(activePlayer(), 1);
  state.drewThisTurn = true;
  state.phase = "charge";
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  addLog(`${activePlayer().name}はカードを1枚引きました。`);
  render();
}

async function chargeAction() {
  if (
    state.winner ||
    hasPendingResolution() ||
    state.chargedThisTurn ||
    state.selected?.source !== "hand" ||
    state.selected.owner !== state.active
  ) {
    return;
  }
  if (state.phase !== "charge") {
    addLog("チャージ&ドローはチャージフェイズでのみ行えます。");
    return;
  }
  const card = removeSelectedFromHand();
  if (!card) {
    return;
  }
  expireTransientResponseWindows();
  activePlayer().gauge.push(card);
  drawCards(activePlayer(), 1);
  state.chargedThisTurn = true;
  state.phase = "main";
  state.selected = null;
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  await runPhaseStartTriggers("mainStart", state.active);
  addLog(`${activePlayer().name}は${card.name}をチャージし、1枚引きました。`);
  render();
}

async function goMainPhase() {
  if (state.winner || hasPendingResolution() || state.phase !== "charge") {
    return;
  }
  expireTransientResponseWindows();
  state.phase = "main";
  state.selected = null;
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  await runPhaseStartTriggers("mainStart", state.active);
  addLog(`${activePlayer().name}はメインフェイズに入りました。`);
  render();
}

async function callMonster(zone) {
  const selectedCard = getSelectedCard();
  const selectedOwner = state.selected?.owner;
  const specialCallOpportunity = specialCallOpportunityForCard(selectedOwner, selectedCard);
  const player = state.players[selectedOwner ?? state.active];
  if (
    (state.winner && !specialCallOpportunity) ||
    (hasPendingResolution() && !specialCallOpportunity) ||
    (state.phase !== "main" && !specialCallOpportunity) ||
    state.selected?.source !== "hand" ||
    (!specialCallOpportunity && state.selected.owner !== state.active) ||
    !selectedCard ||
    !isCallableMonster(selectedCard) ||
    !fieldZones.includes(zone)
  ) {
    return;
  }
  if (!validateCardCanBeUsedByOwner(selectedOwner, selectedCard)) {
    return;
  }
  const stackTarget = selectedCard.callStack ? getStackCallTarget(player, selectedCard) : null;
  if (selectedCard.callStack && !stackTarget) {
    addLog(`${selectedCard.name}は、重ねる対象を効果対象から選んでください。`);
    return;
  }
  if (!checkCardConditions(selectedCard.callConditions, selectedOwner)) {
    addLog(`${selectedCard.name}のコール条件を満たしていません。`);
    return;
  }
  const actualZone = stackTarget?.zone || zone;
  if (
    (selectedCard.callZones && !selectedCard.callZones.includes(actualZone)) ||
    (selectedCard.cannotCallZones || []).includes(actualZone)
  ) {
    addLog(`${selectedCard.name}は${zoneLabel(actualZone)}にコールできません。`);
    return;
  }
  if (actualZone === "center" && isCenterCallPrevented(selectedOwner, selectedCard)) {
    addLog(`${selectedCard.name}はセンターにコールできません。`);
    return;
  }
  expireTransientResponseWindows({ preserveSpecialCallOpportunity: specialCallOpportunity });
  const declaredBuddyCall = isBuddyCallDeclared(player, selectedCard);
  const payment = await payCardCostWithSelection(player, selectedCard, "call", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  beginPendingAction({
    kind: "call",
    owner: selectedOwner,
    responder: 1 - selectedOwner,
    card,
    phase: state.phase,
    targetZone: actualZone,
    stackTarget: stackTarget ? { owner: stackTarget.owner, zone: stackTarget.zone } : null,
    declaredBuddyCall,
    effectTargetValue: elements.effectTarget.value,
  });
  if (specialCallOpportunity) {
    specialCallOpportunity.used = true;
  }
  addLog(`${player.name}は${card.name}を${zoneLabel(actualZone)}にコール宣言しました。対抗確認を行ってください。`);
  render();
}

function specialCallOpportunityForCard(owner, card) {
  if (owner === undefined || owner === null || !card) {
    return null;
  }
  // 旧 specialCallOnDestroyed は desugarCardFlags で callConditions へ統一済みのため、
  // ここでは callConditions の specialCall/temporaryCall 系エントリのみを評価する。
  const condition = (card.callConditions || []).find((entry) =>
    ["specialCallOpportunityMatches", "temporaryCallOpportunityMatches"].includes(entry.op),
  );
  return condition ? findSpecialCallOpportunity(owner, condition) : null;
}

async function resolvePendingCall(action) {
  const player = state.players[action.owner];
  const card = action.card;
  if (action.nullified) {
    player.drop.push(card);
    addLog(`${card.name}のコールは無効化され、ドロップゾーンに置かれました。`);
    return;
  }
  const stackTarget = action.stackTarget
    ? getFieldTarget(action.stackTarget.owner, action.stackTarget.zone)
    : null;
  if (action.stackTarget && !stackTarget) {
    player.drop.push(card);
    addLog(`${card.name}を重ねる対象が場を離れたため、ドロップゾーンに置かれました。`);
    return;
  }
  const actualZone = action.targetZone;
  if (stackTarget) {
    stackFieldCardAsSoul(player, actualZone, card);
  } else if (player.field[actualZone]) {
    const replaced = player.field[actualZone];
    dropFieldCardByRule(player, actualZone);
    addLog(`${zoneLabel(actualZone)}にいた${replaced.name}をルール処理でドロップに置きました。`);
    player.field[actualZone] = card;
  } else {
    player.field[actualZone] = card;
  }
  enforceSizeLimit(player, actualZone);
  state.phase = action.phase || "main";
  state.selected = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  if (action.declaredBuddyCall) {
    player.partnerCalled = true;
    player.life += 1;
    addLog(`${player.name}は${card.name}を${zoneLabel(actualZone)}にバディコールし、ライフを1回復しました。`);
  } else {
    addLog(`${player.name}は${card.name}を${zoneLabel(actualZone)}にコールしました。`);
  }
  if (card.destroyAtEndOfTurn) {
    card.destroyAtEndOfTurnOwner = action.owner;
  }
  await resolveOnEnter(card, player, getTargetInfoFromValue(action.effectTargetValue));
}

function getStackCallTarget(player, card) {
  const target = getEffectTargetInfo();
  if (!target || target.owner !== state.players.indexOf(player)) {
    return null;
  }
  if (!fieldZones.includes(target.zone) || effectiveCardType(target.card) !== "monster") {
    return null;
  }
  const nameIncludes = card.callStack?.nameIncludes;
  if (nameIncludes && !target.card.name.includes(nameIncludes)) {
    return null;
  }
  const stackAttribute = card.callStack?.attribute;
  if (stackAttribute && !(target.card.attributes || []).includes(stackAttribute)) {
    return null;
  }
  return target;
}

function stackFieldCardAsSoul(player, zone, card) {
  const baseCard = player.field[zone];
  card.soul ||= [];
  if (baseCard) {
    card.soul.push(...(baseCard.soul || []));
    baseCard.soul = [];
    card.soul.push(baseCard);
  }
  player.field[zone] = card;
}

function enforceSizeLimit(player, latestZone) {
  const limit = fieldSizeLimit(player);
  while (getFieldSize(player) > limit) {
    const dropZone = fieldZones.find((zone) => zone !== latestZone && player.field[zone]);
    if (!dropZone) {
      break;
    }
    const dropped = player.field[dropZone];
    dropFieldCardByRule(player, dropZone);
    addLog(`サイズ合計が${limit}を超えたため、${dropped.name}をルール処理でドロップに置きました。`);
  }
}

async function resolveOnEnter(card, player, storedTarget = null) {
  const owner = state.players.indexOf(player);
  const zone = findFieldCardSlot(card)?.zone;
  recordEnteredEventWindow(card, owner, zone);
  // onEnter:"destroy-opponent-size2" は desugarCardFlags で構造化 triggered/enter ability へ
  // 変換済みのため、専用ハードコード分岐は不要。すべて runTriggeredAbilities が処理する。
  await runTriggeredAbilities(card, "enter", {
    card,
    player,
    owner,
    zone,
    target: storedTarget || null,
  });
  await runAllyEnterTriggers(card, owner, zone);
}

async function runAllyEnterTriggers(enteredCard, owner, enteredZone) {
  for (const triggerOwner of [owner, 1 - owner]) {
    const event = triggerOwner === owner ? "allyEnter" : "opponentEnter";
    for (const zone of zones) {
      const sourceCard = state.players[triggerOwner]?.field?.[zone];
      if (!sourceCard || sourceCard.instanceId === enteredCard.instanceId) {
        continue;
      }
      await runTriggeredAbilities(sourceCard, event, {
        card: sourceCard,
        player: state.players[triggerOwner],
        owner: triggerOwner,
        zone,
        enteredCard,
        enteredOwner: owner,
        enteredZone,
        target: { owner, zone: enteredZone, card: enteredCard },
      });
    }
  }
}

async function runFieldEventTriggers(eventBase, eventOwner, eventCard, eventZone, details = {}) {
  for (const triggerOwner of [eventOwner, 1 - eventOwner]) {
    const event = triggerOwner === eventOwner ? `ally${capitalizeAscii(eventBase)}` : `opponent${capitalizeAscii(eventBase)}`;
    for (const zone of zones) {
      const sourceCard = state.players[triggerOwner]?.field?.[zone];
      if (!sourceCard) {
        continue;
      }
      await runTriggeredAbilities(sourceCard, event, {
        card: sourceCard,
        player: state.players[triggerOwner],
        owner: triggerOwner,
        zone,
        eventCard: {
          card: eventCard,
          owner: eventOwner,
          zone: eventZone,
          source: "field",
        },
        eventFieldCard: eventCard,
        eventOwner,
        eventZone,
        target: { owner: eventOwner, zone: eventZone, card: eventCard },
        ...details,
      });
    }
  }
}

function capitalizeAscii(value = "") {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
}

async function restFieldCard(owner, zone, card = state.players[owner]?.field?.[zone], details = {}) {
  if (!card || card.used) {
    return false;
  }
  card.used = true;
  await runFieldEventTriggers("rest", owner, card, zone, details);
  return true;
}

async function moveFieldCard(owner, fromZone, toZone, details = {}) {
  const player = state.players[owner];
  const card = player?.field?.[fromZone];
  if (!card || !zones.includes(toZone) || player.field[toZone]) {
    return false;
  }
  player.field[fromZone] = null;
  player.field[toZone] = card;
  await runFieldEventTriggers("move", owner, card, toZone, {
    fromZone,
    ...details,
  });
  return true;
}

async function runPhaseStartTriggers(event, turnOwner = state.active) {
  for (const owner of [turnOwner, 1 - turnOwner]) {
    for (const zone of zones) {
      const card = state.players[owner]?.field?.[zone];
      if (!card) {
        continue;
      }
      await runTriggeredAbilities(card, event, {
        card,
        player: state.players[owner],
        owner,
        zone,
        turnOwner,
      });
    }
  }
}

function beginPendingAction(action) {
  state.pendingAction = {
    ...action,
    counterUsed: {
      [action.owner]: null,
      [action.responder]: null,
    },
    nullified: false,
  };
  state.counterHandOwner = action.responder;
  state.selected = null;
  state.linkAttackers = [];
}

async function resolvePendingResolution() {
  if (state.resolvingPending) {
    return;
  }
  if (isNetworkConnected() && networkSession.seat !== networkResolutionSeat()) {
    updateNetworkStatus("対抗確認を担当する相手席の解決を待っています。");
    return;
  }
  expireTransientResponseWindows();
  state.resolvingPending = true;
  render();
  try {
    if (state.pendingAction) {
      await resolvePendingAction();
      return;
    }
    if (state.pendingAttack) {
      await resolvePendingAttack();
    }
  } finally {
    state.resolvingPending = false;
    render();
  }
}

function networkResolutionSeat() {
  if (state.pendingAction) {
    return state.pendingAction.responder;
  }
  if (state.pendingAttack) {
    return state.pendingAttack.defender;
  }
  return null;
}

async function resolvePendingAction() {
  const action = state.pendingAction;
  if (!action) {
    return;
  }
  state.pendingAction = null;
  state.counterHandOwner = null;
  state.selected = null;
  state.linkAttackers = [];
  if (action.kind === "call") {
    await resolvePendingCall(action);
  }
  if (action.kind === "spell") {
    await resolvePendingSpell(action);
  }
  if (action.kind === "impact") {
    await resolvePendingSpell(action);
  }
  if (action.kind === "setSpell") {
    await resolvePendingSetSpell(action);
  }
  if (action.kind === "ability") {
    await resolvePendingAbility(action);
  }
}

async function resolvePendingSpell(action) {
  const player = state.players[action.owner];
  if (action.nullified) {
    player.drop.push(action.card);
    addLog(`${action.card.name}は無効化され、ドロップゾーンに置かれました。`);
    return;
  }
  const context = {
    card: action.card,
    ability: action.ability,
    player,
    owner: action.owner,
    target: getTargetInfoFromValue(action.effectTargetValue),
  };
  await executeAbilityBody(context);
  if (!context.cardMoved) {
    player.drop.push(action.card);
  }
  markAbilityLimit(action.owner, action.card, action.ability || {});
  addLog(`${action.card.name}を解決しました。`);
}

async function resolvePendingAbility(action) {
  const player = state.players[action.owner];
  if (action.nullified) {
    markAbilityLimit(action.owner, action.card, action.ability || {});
    addLog(`${pendingActionLabel(action)}は無効化されました。`);
    return;
  }
  const context = {
    card: action.card,
    ability: action.ability,
    player,
    owner: action.owner,
    zone: action.zone,
    hostCard: action.hostCard || null,
    hostOwner: action.hostOwner,
    hostZone: action.hostZone,
    target: getTargetInfoFromValue(action.effectTargetValue),
  };
  await executeAbilityBody(context);
  markAbilityLimit(action.owner, action.card, action.ability || {});
  state.phase = action.phase || state.phase;
  addLog(`${pendingActionLabel(action)}を解決しました。`);
}

async function resolvePendingSetSpell(action) {
  const player = state.players[action.owner];
  if (action.nullified) {
    player.drop.push(action.card);
    addLog(`${action.card.name}は無効化され、ドロップゾーンに置かれました。`);
    return;
  }
  if (player.field[action.zone]) {
    player.drop.push(action.card);
    addLog(`${action.card.name}を配置する場所がなくなったため、ドロップゾーンに置かれました。`);
    return;
  }
  await placeSetSpellDirect(player, action.card, action.zone);
}

function clearPendingAction(returnPhase = "main") {
  state.pendingAction = null;
  state.counterHandOwner = null;
  state.phase = returnPhase || "main";
  state.selected = null;
  state.linkAttackers = [];
}

function nullifyPendingAction(sourceName = "効果") {
  if (!state.pendingAction) {
    return false;
  }
  const action = state.pendingAction;
  if (action.card?.cannotBeNullified) {
    addLog(`${action.card.name}は無効化されません。`);
    return false;
  }
  action.nullified = true;
  addLog(`${sourceName}で${pendingActionLabel(action)}を無効化しました。`);
  return true;
}

function pendingActionLabel(action = state.pendingAction) {
  if (!action) {
    return "行動";
  }
  if (action.kind === "call") {
    return `${action.card.name}のコール`;
  }
  if (action.kind === "ability") {
    return `${action.card.name}の能力`;
  }
  return `${action.card.name}の使用`;
}

function pendingResponderOwner() {
  if (state.pendingAttack) {
    return state.pendingAttack.defender;
  }
  return state.pendingAction?.responder ?? state.active;
}

function partnerCall() {
  const player = activePlayer();
  const selectedCard = getSelectedCard();
  if (!canDeclareBuddyCall(player, selectedCard)) {
    return;
  }
  if (state.buddyCallDeclared === selectedCard.instanceId) {
    state.buddyCallDeclared = null;
    addLog("バディコール宣言を解除しました。");
  } else {
    state.buddyCallDeclared = selectedCard.instanceId;
    addLog(`${selectedCard.name}を次のコールでバディコールとして宣言します。`);
  }
  render();
}

function canDeclareBuddyCall(player, card) {
  return Boolean(
    !state.winner &&
      !hasPendingResolution() &&
      state.phase === "main" &&
      !player.partnerCalled &&
      state.selected?.source === "hand" &&
      state.selected.owner === state.active &&
      card &&
      isCallableMonster(card) &&
      isBuddyCard(player, card),
  );
}

function isBuddyCallDeclared(player, card) {
  return Boolean(
    state.buddyCallDeclared === card?.instanceId &&
      !player.partnerCalled &&
      isBuddyCard(player, card),
  );
}

function isBuddyCard(player, card) {
  return Boolean(player.buddy && card?.name === player.buddy.name);
}

function isCallableMonster(card) {
  return ["monster", "impactMonster"].includes(card?.type);
}

async function useCardAction() {
  const selectedCard = getSelectedCard();
  if (state.winner || !selectedCard) {
    return;
  }
  const usesCounterEventWindow = Boolean(
    (state.counterEventWindow || state.destroyedEventWindow || state.enteredEventWindow) &&
      state.selected?.source === "hand" &&
      canUseCounterPlayCard(selectedCard),
  );
  if (!usesCounterEventWindow) {
    expireTransientResponseWindows();
  }
  if (state.selected?.source === "field") {
    await useFieldAbilityAction(selectedCard);
    return;
  }
  if (state.selected?.source !== "hand") {
    return;
  }
  if (!validateCardCanBeUsedByOwner(state.selected.owner, selectedCard)) {
    return;
  }
  if (state.pendingAction) {
    await usePendingActionCounterCard(selectedCard);
    return;
  }
  if (state.pendingAttack) {
    await useCounterCard(selectedCard);
    return;
  }
  if (canUseCounterPlayCard(selectedCard)) {
    await useCounterPlayCard(selectedCard);
    expireTransientResponseWindows();
    return;
  }
  if (state.phase !== "main" && selectedCard.type !== "impact") {
    addLog("コール、装備、通常魔法の使用はメインフェイズでのみ行えます。");
    return;
  }
  if (selectedCard.type === "impact" && state.phase !== "final") {
    addLog("必殺技はファイナルフェイズでのみ使用できます。");
    return;
  }
  if (state.selected.owner !== state.active) {
    return;
  }
  if (hasKeyword(selectedCard, "arrival")) {
    await arriveCard(selectedCard);
    return;
  }
  const handAbility = findUsableHandAbility(selectedCard);
  if (handAbility) {
    await useHandAbilityAction(selectedCard, handAbility);
    return;
  }
  if (hasKnownHandAbility(selectedCard)) {
    addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner));
    return;
  }
  if (selectedCard.type === "item") {
    await equipItem(selectedCard);
    return;
  }
  if (selectedCard.type === "spell") {
    await castSpell(selectedCard);
    return;
  }
  if (selectedCard.type === "impact") {
    await castImpact(selectedCard);
  }
}

// 共通: 既にソース(手札/ドロップ等)から取り出したカードをアイテムとして装備する。
// equipItem(手札からの通常装備) と script op useSelectedCard(ドロップからの装備) で共有。
async function equipCardDirect(player, card) {
  const owner = state.players.indexOf(player);
  if (player.field.item) {
    if (hasKeyword(card, "equipChange") && !player.oncePerTurn["equipChange"]) {
      player.hand.push(player.field.item);
      player.field.item = null;
      player.oncePerTurn["equipChange"] = true;
      addLog(`${card.name}の『装備変更』で装備中のアイテムを手札に戻しました。`);
    } else {
      dropFieldCardByRule(player, "item");
    }
  }
  card.currentType = "item";
  player.field.item = card;
  if (card.destroyAtEndOfTurn) {
    card.destroyAtEndOfTurnOwner = owner;
  }
  player.arrivalCardId = null;
  await resolveOnEnter(card, player);
  addLog(`${player.name}は${card.name}を装備しました。`);
}

// 共通: 既に取り出した設置(set)カードを設置ゾーンに配置する。
// resolvePendingSetSpell(通常設置) と script op useSelectedCard(ドロップからの設置) で共有。
async function placeSetSpellDirect(player, card, zone) {
  const owner = state.players.indexOf(player);
  card.currentType = card.type;
  player.field[zone] = card;
  addLog(`${player.name}は${card.name}を配置しました。`);
  await runFieldEventTriggers("set", owner, card, zone, {
    enteredCard: card,
    enteredZone: zone,
  });
}

async function equipItem(selectedCard) {
  const player = activePlayer();
  if (
    selectedCard.equipConditions &&
    !checkCardConditions(selectedCard.equipConditions, state.active)
  ) {
    addLog(`${selectedCard.name}の装備条件を満たしていません。`);
    return;
  }
  const payment = await payCardCostWithSelection(player, selectedCard, "equip", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  await equipCardDirect(player, card);
  state.selected = null;
  state.phase = "main";
  state.linkAttackers = [];
  render();
}

async function arriveCard(selectedCard) {
  const player = activePlayer();
  const ability = findKeywordAbility(selectedCard, "arrival");
  const payment = await payStructuredCostWithSelection(player, ability?.cost || selectedCard.costs?.arrival || [], {
    sourceCard: selectedCard,
    selectedCard,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  if (player.field.item) {
    dropFieldCardByRule(player, "item");
  }
  const card = removeSelectedFromHand();
  card.currentType = "item";
  card.arrived = true;
  player.field.item = card;
  if (card.destroyAtEndOfTurn) {
    card.destroyAtEndOfTurnOwner = state.active;
  }
  player.arrivalCardId = card.instanceId;
  state.selected = null;
  state.phase = "main";
  state.linkAttackers = [];
  addLog(`${player.name}は${card.name}を着任しました。`);
  render();
}

async function castSpell(selectedCard) {
  if (hasKeyword(selectedCard, "set")) {
    await castSetSpell(selectedCard);
    return;
  }
  const ability = findUsableHandAbility(selectedCard);
  if (ability) {
    await useHandAbilityAction(selectedCard, ability);
    return;
  }
  if (selectedCard.name === "ウープス！") {
    await castOops(selectedCard);
    return;
  }
  if (hasKnownHandAbility(selectedCard)) {
    addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner));
    return;
  }
  addLog("このカードの使用処理はまだ実装されていません。");
}

function hasKnownHandAbility(card) {
  return (card?.abilities || []).some((ability) => canUseAbilityFromHand(ability));
}

function handAbilityUnavailableReason(card, owner, options = {}) {
  const abilities = (card?.abilities || []).filter((ability) => canUseAbilityFromHand(ability));
  if (abilities.length === 0) {
    return "このカードの使用処理はまだ実装されていません。";
  }
  const ability = abilities[0];
  if (!handAbilityTimingMatches(ability, options)) {
    if (isCounterAbility(ability)) {
      return `${card.name}は【対抗】で使うカードです。`;
    }
    return `${card.name}は今のフェイズでは使えません。`;
  }
  if (isAbilityLimitUsed(owner, card, ability)) {
    const limit = normalizedAbilityLimit(ability);
    if (limit?.scope === "turn") {
      return `${card.name}はこのターンすでに使っています。`;
    }
    if (limit?.scope === "fight") {
      return `${card.name}はこのファイト中すでに使っています。`;
    }
    return `${card.name}は使用回数制限により使えません。`;
  }
  if (!checkAbilityConditions(ability, owner)) {
    return `${card.name}の使用条件を満たしていません。`;
  }
  if (ability.target && targetCandidatesFromSpec(ability.target, owner, { card, ability }).length === 0) {
    return `${card.name}の対象にできるカードがありません。`;
  }
  const player = state.players[owner];
  const costSteps = adjustedCostSteps(
    player,
    card,
    abilityCostPurpose(ability),
    abilityCostSteps(card, ability),
  );
  const canPay = canPayStructuredCost(player, costSteps, {
    sourceCard: card,
    selectedCard: card,
    allowInteractiveSelection: true,
  });
  if (!canPay.ok) {
    return canPay.reason;
  }
  return `${card.name}は現在の状態では使えません。`;
}

async function castSetSpell(selectedCard) {
  const player = activePlayer();
  if (!checkCardConditions(selectedCard.useConditions || [], state.active, { card: selectedCard, owner: state.active })) {
    addLog(`${selectedCard.name}の使用条件を満たしていません。`);
    return;
  }
  const zone = setZones.find((candidate) => !player.field[candidate]);
  if (!zone) {
    addLog("配置魔法ゾーンが空いていません。");
    return;
  }
  if (selectedCard.uniqueSet && setZones.some((candidate) => player.field[candidate]?.id === selectedCard.id)) {
    addLog(`${selectedCard.name}はすでに配置されています。`);
    return;
  }
  const payment = await payCardCostWithSelection(player, selectedCard, "cast", selectedCard);
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  beginPendingAction({
    kind: "setSpell",
    owner: state.active,
    responder: 1 - state.active,
    card,
    phase: state.phase,
    zone,
  });
  addLog(`${player.name}は${card.name}の配置を宣言しました。対抗確認を行ってください。`);
  render();
}

async function useCounterPlayCard(selectedCard) {
  const ability = findUsableHandAbility(selectedCard, { counterOnly: true });
  if (!ability) {
    if (hasKnownHandAbility(selectedCard)) {
      addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner, { counterOnly: true }));
      return;
    }
    addLog("このタイミングで使える【対抗】能力ではありません。");
    return;
  }
  await useHandAbilityAction(selectedCard, ability);
}

function canUseCounterPlayCard(selectedCard) {
  return Boolean(
    !state.pendingAttack &&
      state.selected?.source === "hand" &&
      selectedCard &&
      isCounterPlayTiming() &&
      findUsableHandAbility(selectedCard, { counterOnly: true }),
  );
}

async function castOops(selectedCard) {
  const owner = state.selected.owner;
  const player = state.players[owner];
  const ability = (selectedCard.abilities || []).find((candidate) => candidate.id === "oops-counter");
  if (!ability || !canUseOopsTiming()) {
    addLog("ウープス！は【対抗】で使うカードです。");
    return;
  }
  const target = await chooseAbilityTarget(selectedCard, ability, owner);
  if (!target) {
    addLog("ウープス！で手札に戻す場のカードを選んでください。");
    return;
  }
  const costSteps = adjustedCostSteps(player, selectedCard, "cast", abilityCostSteps(selectedCard, ability));
  const payment = await payStructuredCostWithSelection(player, costSteps, {
    sourceCard: selectedCard,
    selectedCard,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const card = removeSelectedFromHand();
  player.drop.push(card);
  if (state.pendingAttack || state.pendingAction) {
    markCounterUsed(owner, selectedCounterKind(card));
  }
  addLog(`${player.name}は${card.name}を【対抗】で使いました。`);
  await executeAbilityBody({
    card,
    ability,
    player,
    owner,
    target,
  });
  state.selected = null;
  state.linkAttackers = [];
  render();
}

function canUseOopsTiming() {
  return Boolean(state.pendingAttack || state.pendingAction || isCounterPlayTiming());
}


async function castImpact(selectedCard) {
  if (hasKeyword(selectedCard, "set")) {
    await castSetSpell(selectedCard);
    return;
  }
  const player = activePlayer();
  const ability = findUsableHandAbility(selectedCard);
  if (ability) {
    await useHandAbilityAction(selectedCard, ability);
    return;
  }
  if (hasKnownHandAbility(selectedCard)) {
    addLog(handAbilityUnavailableReason(selectedCard, state.players.indexOf(player)));
    return;
  }
  addLog("この必殺技の処理はまだ実装されていません。");
}

async function useCounterCard(selectedCard) {
  const caster = state.players[state.selected.owner];
  if (!canUseCounterEffect(state.selected.owner, selectedCard.effect || selectedCounterKind(selectedCard))) {
    addLog("2018年6月以前ルールでは、この攻撃中に使える【対抗】は各ファイター1回までです。ドラゴエナジーのみ、カード指定により複数使用できます。");
    return;
  }
  if (isMagicalGoodbyeCard(selectedCard)) {
    await useMagicalGoodbyeCounterCard(selectedCard, caster);
    return;
  }
  const ability = findUsableHandAbility(selectedCard);
  if (ability) {
    await useHandAbilityAction(selectedCard, ability, {
      counterKind: selectedCounterKind(selectedCard),
      counterTiming: true,
    });
    return;
  }
  if (selectedCard.name === "ウープス！") {
    await castOops(selectedCard);
    return;
  }
  if (hasKnownHandAbility(selectedCard)) {
    addLog(handAbilityUnavailableReason(selectedCard, state.selected.owner));
    return;
  }
  addLog("このカードは今の攻撃中に使えるカウンターではありません。");
}

async function usePendingActionCounterCard(selectedCard) {
  const action = state.pendingAction;
  const owner = state.selected?.owner;
  if (!action || owner !== action.responder) {
    addLog("この行動への対抗は、相手側だけが使えます。");
    return;
  }
  if (!canUseCounterEffect(owner, selectedCounterKind(selectedCard))) {
    addLog("2018年6月以前ルールでは、この行動への【対抗】は各ファイター1回までです。");
    return;
  }
  if (isMagicalGoodbyeCard(selectedCard)) {
    await useMagicalGoodbyeCounterCard(selectedCard, state.players[owner]);
    return;
  }
  const ability = findUsableHandAbility(selectedCard, { counterOnly: true });
  if (!ability) {
    if (selectedCard.name === "ウープス！") {
      await castOops(selectedCard);
      return;
    }
    if (hasKnownHandAbility(selectedCard)) {
      addLog(handAbilityUnavailableReason(selectedCard, owner, { counterOnly: true }));
      return;
    }
    addLog("この行動に対して使える【対抗】能力ではありません。");
    return;
  }
  await useHandAbilityAction(selectedCard, ability, {
    counterKind: selectedCounterKind(selectedCard),
    counterTiming: true,
  });
}

function selectedCounterKind(card) {
  // counterKind 宣言を最優先（dragoenergy は desugar で counterKind="dragoenergy" を付与）。
  // 旧 id/effect 直書きは廃止し、データ駆動の宣言フィールドへ一般化した。
  if (card?.counterKind) {
    return card.counterKind;
  }
  return hasKeyword(card, "reversal") ? "reversal" : "other";
}

function isMagicalGoodbyeCard(card) {
  return (card?.abilities || []).some((ability) => ability.id === "magical-goodbye-counter");
}

function magicalGoodbyeAbility(card) {
  return (card?.abilities || []).find((ability) => ability.id === "magical-goodbye-counter");
}

function canUseMagicalGoodbye(owner, card) {
  const ability = magicalGoodbyeAbility(card);
  return Boolean(
    ability &&
      handAbilityTimingMatches(ability) &&
      checkAbilityConditions(ability, owner) &&
      targetCandidatesFromSpecForOwner(ability.target, owner, { card, ability }).length > 0,
  );
}

async function useMagicalGoodbyeCounterCard(selectedCard, caster) {
  const owner = state.selected.owner;
  const ability = magicalGoodbyeAbility(selectedCard);
  if (!ability || !handAbilityTimingMatches(ability)) {
    addLog(`${selectedCard.name}はこのタイミングでは使えません。`);
    return;
  }
  if (!checkAbilityConditions(ability, owner)) {
    addLog(`${selectedCard.name}の使用条件を満たしていません。`);
    return;
  }
  const targets = targetCandidatesFromSpecForOwner(ability.target, owner, { card: selectedCard, ability });
  if (targets.length === 0) {
    addLog(`${selectedCard.name}で手札に戻せるサイズ2以下のモンスターが場にありません。`);
    return;
  }
  const selected = await chooseCardEntries(targets, {
    title: `${selectedCard.name}の対象`,
    lead: "手札に戻すサイズ2以下のモンスターを選んでください。",
    min: 1,
    max: 1,
    forceDialog: true,
  });
  const target = selected?.[0];
  if (!target) {
    addLog(`${selectedCard.name}の対象を選んでください。`);
    return;
  }
  const payment = await payStructuredCostWithSelection(caster, ability.cost || [], {
    sourceCard: selectedCard,
    selectedCard,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const usedCard = removeSelectedFromHand();
  if (!usedCard) {
    addLog(`${selectedCard.name}が手札にありません。`);
    return;
  }
  caster.drop.push(usedCard);
  if (hasPendingResolution()) {
    markCounterUsed(owner, selectedCounterKind(usedCard));
  }
  addLog(`${caster.name}は${usedCard.name}を【対抗】で使いました。`);
  returnFieldTargetToHand(target, usedCard.name);
  markAbilityLimit(owner, usedCard, ability);
  state.selected = null;
  state.linkAttackers = [];
  render();
}

function returnFieldTargetToHand(target, sourceName = "効果") {
  const ownerPlayer = state.players[target.owner];
  const returned = ownerPlayer?.field[target.zone];
  if (!returned) {
    addLog(`${sourceName}の対象はすでに場にありません。`);
    return null;
  }
  if (cannotReturnToHand(returned)) {
    addLog(`${returned.name}は手札に戻せません。`);
    return null;
  }
  ownerPlayer.drop.push(...(returned.soul || []));
  returned.soul = [];
  ownerPlayer.field[target.zone] = null;
  if (target.zone === "item" && ownerPlayer.arrivalCardId === returned.instanceId) {
    ownerPlayer.arrivalCardId = null;
  }
  ownerPlayer.hand.push(returned);
  applyLifeLink(returned, target.owner);
  addLog(`${sourceName}で${returned.name}を手札に戻しました。`);
  handleDestroyedDuringPending({ owner: target.owner, zone: target.zone });
  // 「場のモンスターが手札に戻った時」誘発（D・R・システム等）。発生源は既に場から外れている。
  queueMonsterReturnedTriggers(returned, target.owner, target.zone);
  return returned;
}

function toggleLinkAttacker() {
  if (state.winner || hasPendingResolution() || !["attack", "final"].includes(state.phase)) {
    return;
  }
  if (state.selected?.source !== "field" || state.selected.owner !== state.active) {
    return;
  }
  const card = getSelectedCard();
  if (!card || card.used) {
    return;
  }
  const slot = { owner: state.active, zone: state.selected.zone };
  if (!canDeclareAttack({ ...slot, card })) {
    addLog("センターにモンスターがいるため、武器では攻撃できません。");
    return;
  }
  expireTransientResponseWindows();
  const index = (state.linkAttackers || []).findIndex((attacker) => sameSlot(attacker, slot));
  if (index >= 0) {
    state.linkAttackers.splice(index, 1);
    addLog(`${card.name}を連携攻撃から外しました。`);
  } else {
    state.linkAttackers.push(slot);
    addLog(`${card.name}を連携攻撃に加えました。`);
  }
  render();
}

async function attackAction() {
  if (state.winner || hasPendingResolution()) {
    return;
  }
  if (!["attack", "final"].includes(state.phase)) {
    addLog("攻撃はアタックフェイズまたはファイナルフェイズで行えます。");
    return;
  }
  if (state.turnCount === 1 && state.attacksThisTurn >= 1) {
    addLog("2018年6月以前ルールでは、先攻1ターン目に行える攻撃は1回までです。");
    return;
  }
  const attackers = getAttackDeclarationAttackers();
  if (attackers.length === 0) {
    if (state.selected?.source === "field") {
      const card = getSelectedCard();
      if (card && !canDeclareAttack({ owner: state.selected.owner, zone: state.selected.zone, card })) {
        addLog("センターにモンスターがいるため、武器では攻撃できません。");
      }
    }
    return;
  }
  if (state.turnCount === 1 && attackers.length > 1) {
    addLog("先攻1ターン目は連携攻撃できません。");
    return;
  }
  expireTransientResponseWindows();
  const targetValue = elements.attackTarget.value;
  if (!targetValue) {
    return;
  }
  await performAttackDeclaration(attackers, targetValue);
}

async function performAttackDeclaration(attackers, targetValue) {
  const opponent = opponentPlayer();
  if (!attackers.every((attacker) => canAttackTargetValue(attacker, targetValue))) {
    addLog("この攻撃対象には攻撃できません。");
    return false;
  }
  if (targetValue === "fighter" && opponent.field.center) {
    if (!canAttackFighterThroughCenter(attackers)) {
      addLog(`${opponent.name}のセンターにモンスターがいるため、ファイターを攻撃できません。`);
      return false;
    }
  }
  const targetOwner = opponentIndex();
  const targetZone = targetValue === "fighter" ? null : targetValue;
  const attackAllTargetZones = attackAllMonsterTargetZones(attackers, targetOwner, targetValue);
  if (
    targetZone &&
    attackers.length > 1 &&
    hasKeyword(state.players[targetOwner].field[targetZone], "cannotBeLinkAttacked")
  ) {
    addLog(`${state.players[targetOwner].field[targetZone].name}は連携攻撃されません。`);
    return false;
  }
  if (
    targetValue === "fighter" &&
    attackers.length > 1 &&
    zones.some((zone) => {
      const sourceCard = state.players[targetOwner]?.field?.[zone];
      return (sourceCard?.continuous || []).some(
        (effect) =>
          effect.op === "fighterCannotBeLinkAttacked" &&
          checkCardConditions(effect.conditions || [], targetOwner, { card: sourceCard, zone }),
      );
    })
  ) {
    addLog(`${state.players[targetOwner].name}は連携攻撃されません。`);
    return false;
  }
  const firstAttacker = attackers[0];
  state.pendingAttack = {
    phase: state.phase,
    attackers: attackers.map((attacker) => ({ owner: attacker.owner, zone: attacker.zone })),
    attackerOwner: firstAttacker.owner,
    attackerZone: firstAttacker.zone,
    defender: targetOwner,
    targetOwner,
    targetZone,
    targetType: targetValue === "fighter" ? "fighter" : "monster",
    attackAllTargetZones,
    counterUsed: {
      [state.active]: null,
      [targetOwner]: null,
    },
  };
  state.counterHandOwner = targetOwner;
  state.attacksThisTurn += 1;
  for (const attacker of attackers) {
    await restFieldCard(attacker.owner, attacker.zone, attacker.card, { reason: "attack" });
  }
  const attackerNames = attackers.map((attacker) => attacker.card.name).join("、");
  state.phase = "defense";
  state.selected = null;
  state.linkAttackers = [];
  addLog(`${attackerNames}が${targetLabel(state.pendingAttack)}へ攻撃しました。`);
  if (attackAllTargetZones.length > 0) {
    addLog(`${attackerNames}の効果で相手のモンスター全てに攻撃します。`);
  }
  applyAttackRedirectContinuous();
  await runAttackDeclarationTriggers(attackers);
  await runAttackedTriggers(attackers);
  if (applyAttackTaxes()) {
    render();
    return true;
  }
  addLog("防御側はカウンターを使えます。");
  render();
  return true;
}

async function declareAttackWithFieldCard(owner, zone, options = {}) {
  const player = state.players[owner];
  const card = player?.field?.[zone];
  if (!card || state.winner || state.pendingAttack) {
    return false;
  }
  if (options.requireStanding !== false && card.used) {
    addLog(`${card.name}はレストしているため攻撃しません。`);
    return false;
  }
  if (state.turnCount === 1 && state.attacksThisTurn >= 1) {
    addLog("2018年6月以前ルールでは、先攻1ターン目に行える攻撃は1回までです。");
    return false;
  }
  const attacker = { owner, zone, card };
  if (!canDeclareAttack(attacker)) {
    addLog(`${card.name}は攻撃できません。`);
    return false;
  }
  const opponentOwner = 1 - owner;
  const opponentFighter = state.players[opponentOwner];
  const candidates = [];
  for (const targetZone of ["left", "center", "right"]) {
    const targetCard = opponentFighter.field[targetZone];
    if (targetCard && canAttackTargetValue(attacker, targetZone)) {
      candidates.push({ value: targetZone, card: targetCard });
    }
  }
  if (
    canAttackTargetValue(attacker, "fighter") &&
    (!opponentFighter.field.center || canAttackFighterThroughCenter([attacker]))
  ) {
    candidates.push({
      value: "fighter",
      card: { name: `${opponentFighter.name}（ファイター）`, rules: [], type: "fighter" },
    });
  }
  if (candidates.length === 0) {
    addLog(`${card.name}で攻撃できる対象がありません。`);
    return false;
  }
  let targetValue = candidates[0].value;
  if (candidates.length > 1) {
    const selected = await chooseCardEntries(
      candidates.map((candidate) => ({ value: candidate.value, card: candidate.card })),
      {
        title: `${card.name}の攻撃対象`,
        lead: "攻撃する対象を選んでください。",
        min: 1,
        max: 1,
        forceDialog: true,
      },
    );
    if (selected?.length) {
      targetValue = selected[0].value;
    }
  }
  return performAttackDeclaration([attacker], targetValue);
}

// 「攻撃の対象をこのモンスターに変更する」継続効果（闘神竜 デモンゴドル・アーク）。
// 攻撃宣言直後、防御側の場に redirectAttackToSelf を持つカードがあれば攻撃対象をそのカードへ移す。
function applyAttackRedirectContinuous() {
  const pending = state.pendingAttack;
  if (!pending) {
    return;
  }
  const defenderOwner = pending.targetOwner;
  for (const zone of zones) {
    const card = state.players[defenderOwner]?.field?.[zone];
    if (!card) {
      continue;
    }
    const redirects = (card.continuous || []).some(
      (effect) =>
        effect.op === "redirectAttackToSelf" &&
        checkCardConditions(effect.conditions || [], defenderOwner, { card, zone }),
    );
    if (redirects) {
      if (pending.targetZone === zone) {
        return;
      }
      pending.targetZone = zone;
      pending.targetType = effectiveCardType(card) === "monster" ? "monster" : "fieldCard";
      addLog(`${card.name}の効果で攻撃対象が${card.name}に変更されました。`);
      return;
    }
  }
}

async function runAttackedTriggers(attackers) {
  const pending = state.pendingAttack;
  if (!pending || !pending.targetZone) {
    return;
  }
  const targetZones = [pending.targetZone, ...(pending.attackAllTargetZones || [])].filter(
    (zone, index, list) => zone && list.indexOf(zone) === index,
  );
  for (const zone of targetZones) {
    const targetCard = state.players[pending.targetOwner]?.field?.[zone];
    if (!targetCard) {
      continue;
    }
    await runTriggeredAbilities(targetCard, "attacked", {
      card: targetCard,
      player: state.players[pending.targetOwner],
      owner: pending.targetOwner,
      zone,
      attackers,
      attack: pending,
    });
  }
}

async function runAttackDeclarationTriggers(attackers) {
  for (const attacker of attackers) {
    await runTriggeredAbilities(attacker.card, "attack", {
      card: attacker.card,
      player: state.players[attacker.owner],
      owner: attacker.owner,
      zone: attacker.zone,
      attack: state.pendingAttack,
    });
    if (!hasKeyword(attacker.card, "dropOpponentMonsterSoulOnAttack")) {
      continue;
    }
    const opponentOwner = 1 - attacker.owner;
    const candidates = fieldZones
      .map((zone) => ({
        owner: opponentOwner,
        zone,
        card: state.players[opponentOwner].field[zone],
        source: "field",
      }))
      .filter((entry) => entry.card && effectiveCardType(entry.card) === "monster" && (entry.card.soul?.length || 0) > 0);
    if (candidates.length === 0) {
      continue;
    }
    const selected = await chooseCardEntries(candidates, {
      title: `${attacker.card.name}の効果`,
      lead: "ソウルをドロップゾーンに置く相手モンスターを1枚選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
    });
    const target = selected?.[0];
    if (!target) {
      continue;
    }
    const current = state.players[target.owner]?.field?.[target.zone];
    if (!current || current.instanceId !== target.card.instanceId || !(current.soul?.length)) {
      continue;
    }
    const soulCard = current.soul.pop();
    state.players[target.owner].drop.push(soulCard);
    addLog(`${attacker.card.name}の効果で${current.name}のソウルから${soulCard.name}をドロップゾーンに置きました。`);
  }
}

// この attackTax エントリが、現在の攻撃宣言に対して発火するかを判定する（誰の・どの攻撃に・何を対象に）。
function attackTaxApplies(tax, sourceOwner, sourceZone, pending, target) {
  const attackerCount = pending.attackers?.length || 0;
  const appliesTo = tax.appliesTo || "any";
  if (appliesTo === "linkOnly" && attackerCount <= 1) {
    return false;
  }
  if (appliesTo === "soloOnly" && attackerCount !== 1) {
    return false;
  }
  const targetType = tax.targetType || "any";
  if (targetType !== "any" && pending.targetType !== targetType) {
    return false;
  }
  const sourcePosition = tax.sourcePosition || "any";
  if (sourcePosition === "set" && !setZones.includes(sourceZone)) {
    return false;
  }
  const controller = tax.controller || "any";
  if (controller === "opponentOfAttacker" && sourceOwner === pending.attackerOwner) {
    return false;
  }
  if (controller === "controllerIsAttacker" && sourceOwner !== pending.attackerOwner) {
    return false;
  }
  if (tax.targetFilter) {
    if (!target || !matchesCardFilter(target, tax.targetFilter)) {
      return false;
    }
  }
  return true;
}

// 攻撃宣言時の課金（旧 linkAttackTax を一般化した attackTax[] 駆動）。払えず onFail:nullifyAttack なら攻撃を無効化。
function applyAttackTaxes() {
  const pending = state.pendingAttack;
  if (!pending) {
    return false;
  }
  const target = getPendingTarget();
  const attacker = state.players[pending.attackerOwner];
  for (let owner = 0; owner < state.players.length; owner += 1) {
    const player = state.players[owner];
    for (const zone of zones) {
      const taxCard = player.field[zone];
      const taxes = taxCard?.attackTax;
      if (!Array.isArray(taxes) || taxes.length === 0) {
        continue;
      }
      for (const tax of taxes) {
        if (!attackTaxApplies(tax, owner, zone, pending, target)) {
          continue;
        }
        const payer = tax.payer === "controller" ? player : attacker;
        const payment = payStructuredCost(payer, tax.cost || [], {
          sourceCard: taxCard,
          selectedCard: taxCard,
        });
        if (payment.ok) {
          addLog(`${taxCard.name}の効果で${payer.name}はコストを払いました。`);
          continue;
        }
        if (tax.onFail === "nullifyAttack") {
          addLog(`${taxCard.name}の効果で攻撃は無効化されました。`);
          nullifyPendingAttack(taxCard.name, taxCard);
          return true;
        }
      }
    }
  }
  return false;
}

async function goAttackPhase() {
  if (state.winner || hasPendingResolution() || state.phase !== "main") {
    return;
  }
  expireTransientResponseWindows();
  state.phase = "attack";
  state.selected = null;
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  addLog(`${activePlayer().name}はアタックフェイズに入りました。`);
  await runPhaseStartTriggers("attackStart", state.active);
  await runMoveKeywordsAtAttackPhaseStart();
  render();
}

async function runMoveKeywordsAtAttackPhaseStart() {
  for (const owner of [state.active, 1 - state.active]) {
    const player = state.players[owner];
    const movableSlots = fieldZones
      .map((zone) => ({ owner, zone, card: player.field[zone] }))
      .filter(({ card }) => card && hasKeyword(card, "move"));
    for (const slot of movableSlots) {
      const current = player.field[slot.zone];
      if (!current || current.instanceId !== slot.card.instanceId) {
        continue;
      }
      const destinations = fieldZones.filter((zone) => zone !== slot.zone && !player.field[zone]);
      if (destinations.length === 0) {
        continue;
      }
      const choices = [
        {
          key: "skip",
          card: { name: "移動しない", type: "choice", rules: [`${current.name}を移動しません。`] },
          note: "そのまま",
        },
        ...destinations.map((zone) => ({
          key: zone,
          zone,
          card: current,
          note: zoneLabel(zone),
        })),
      ];
      const selected = await chooseCardEntries(choices, {
        title: `${current.name}の『移動』`,
        lead: "移動先を選んでください。",
        min: 1,
        max: 1,
        forceDialog: true,
      });
      const destination = selected?.[0]?.zone;
      if (!destination) {
        continue;
      }
      if (await moveFieldCard(owner, slot.zone, destination, { reason: "keyword" })) {
        addLog(`${current.name}は「移動」で${zoneLabel(destination)}に移動しました。`);
      }
    }
  }
}

async function goFinalPhase() {
  if (state.winner || hasPendingResolution() || state.phase !== "attack") {
    return;
  }
  expireTransientResponseWindows();
  state.phase = "final";
  state.selected = null;
  state.counterHandOwner = null;
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  addLog(`${activePlayer().name}はファイナルフェイズに入りました。`);
  await runPhaseStartTriggers("finalStart", state.active);
  render();
}

async function resolvePendingAttack() {
  if (!state.pendingAttack) {
    return;
  }
  const pending = state.pendingAttack;
  if (pending.nullified) {
    addLog("この攻撃は無効化されています。");
    clearPendingAttack({ nullified: true });
    render();
    return;
  }
  const attackers = getPendingAttackers();
  if (attackers.length === 0) {
    addLog("攻撃カードが場を離れたため、攻撃は終了しました。");
    clearPendingAttack();
    render();
    return;
  }
  const attackerNames = attackers.map((attacker) => attacker.card.name).join("、");
  if (pending.targetType === "fighter") {
    await resolveFighterAttack(pending, attackers, attackerNames);
    return;
  }
  if (pending.attackAllTargetZones?.length) {
    await resolveMultiMonsterAttack(pending, attackers, attackerNames);
    return;
  }
  const target = getPendingTarget();
  if (!target) {
    addLog("攻撃対象が場を離れたため、攻撃は終了しました。");
    clearPendingAttack();
    render();
    return;
  }
  const attackPower = attackers.reduce((total, attacker) => total + visiblePower(attacker.card), 0);
  if (attackPower >= visibleDefense(target)) {
    const destroyedName = target.name;
    const destroyed = destroyFieldCard(pending.targetOwner, pending.targetZone, {
      cause: { byBattle: true, byOpponent: true, sourceCard: attackers[0]?.card },
    });
    if (destroyed) {
      addLog(`${attackerNames}は${destroyedName}を破壊しました。`);
      await runAttackDestroyedTriggers(attackers, pending, destroyed);
      resolveLinkDestroyedMonsterTriggers(pending, attackers);
      await resolvePenetrateDamage(attackers, pending);
    }
  } else {
    addLog(`${target.name}は攻撃を耐えました。`);
  }

  await resolveCounterattack({ owner: pending.targetOwner, zone: pending.targetZone }, attackers);
  finishPendingAttack({ destroyedTarget: pending.targetType === "monster" && !getPendingTarget() });
  render();
}

async function resolveMultiMonsterAttack(pending, attackers, attackerNames) {
  const targets = uniqueTargetEntries(
    (pending.attackAllTargetZones || [])
      .map((zone) => getFieldTarget(pending.targetOwner, zone))
      .filter((target) => target?.card && effectiveCardType(target.card) === "monster"),
  );
  if (targets.length === 0) {
    addLog("攻撃対象が場を離れたため、攻撃は終了しました。");
    clearPendingAttack();
    render();
    return;
  }
  const attackPower = attackers.reduce((total, attacker) => total + visiblePower(attacker.card), 0);
  let destroyedCount = 0;
  for (const target of targets) {
    const current = state.players[target.owner]?.field?.[target.zone];
    if (!current || current.instanceId !== target.card.instanceId) {
      continue;
    }
    if (attackPower >= visibleDefense(current)) {
      const destroyedName = current.name;
      const destroyed = destroyFieldCard(target.owner, target.zone, {
        cause: { byBattle: true, byOpponent: true, sourceCard: attackers[0]?.card },
      });
      if (destroyed) {
        destroyedCount += 1;
        addLog(`${attackerNames}は${destroyedName}を破壊しました。`);
        await runAttackDestroyedTriggers(
          attackers,
          {
            ...pending,
            targetOwner: target.owner,
            targetZone: target.zone,
            targetType: "monster",
          },
          destroyed,
        );
      }
    } else {
      addLog(`${current.name}は攻撃を耐えました。`);
    }
  }
  for (const target of targets) {
    await resolveCounterattack({ owner: target.owner, zone: target.zone }, attackers);
  }
  finishPendingAttack({
    destroyedTarget: destroyedCount > 0,
    destroyedCount,
    attackAllTargetZones: [...(pending.attackAllTargetZones || [])],
  });
  render();
}

async function runAttackDestroyedTriggers(attackers, pending, destroyedCard) {
  for (const attacker of attackers) {
    await runTriggeredAbilities(attacker.card, "destroyByAttack", {
      card: attacker.card,
      player: state.players[attacker.owner],
      owner: attacker.owner,
      zone: attacker.zone,
      destroyedCard,
      destroyedOwner: pending.targetOwner,
      destroyedZone: pending.targetZone,
      eventCard: {
        card: destroyedCard,
        owner: pending.targetOwner,
        zone: pending.targetZone,
        source: "field",
      },
    });
  }
  const attackerOwner = attackers[0]?.owner;
  if (attackerOwner !== undefined && attackerOwner !== null) {
    for (const zone of zones) {
      const sourceCard = state.players[attackerOwner]?.field?.[zone];
      if (!sourceCard) {
        continue;
      }
      await runTriggeredAbilities(sourceCard, "allyAttackDestroyed", {
        card: sourceCard,
        player: state.players[attackerOwner],
        owner: attackerOwner,
        zone,
        attackers,
        destroyedCard,
        destroyedOwner: pending.targetOwner,
        destroyedZone: pending.targetZone,
        eventCard: {
          card: destroyedCard,
          owner: pending.targetOwner,
          zone: pending.targetZone,
          source: "field",
        },
      });
    }
  }
  for (const zone of zones) {
    const sourceCard = state.players[pending.targetOwner]?.field?.[zone];
    if (!sourceCard) {
      continue;
    }
    await runTriggeredAbilities(sourceCard, "allyDestroyedByAttack", {
      card: sourceCard,
      player: state.players[pending.targetOwner],
      owner: pending.targetOwner,
      zone,
      destroyedCard,
      destroyedOwner: pending.targetOwner,
      destroyedZone: pending.targetZone,
      eventCard: {
        card: destroyedCard,
        owner: pending.targetOwner,
        zone: pending.targetZone,
        source: "field",
      },
    });
  }
}

function resolveLinkDestroyedMonsterTriggers(pending, attackers) {
  if (!pending || pending.targetType !== "monster" || (attackers?.length || 0) <= 1) {
    return;
  }
  let dealtDamage = false;
  state.players.forEach((player, owner) => {
    setZones.forEach((zone) => {
      const setCard = player.field[zone];
      const trigger = setCard?.linkDestroyedOpponentMonsterTrigger;
      if (!trigger || pending.targetOwner === owner) {
        return;
      }
      const receiver = state.players[pending.targetOwner];
      const damage = trigger.damage || 1;
      const appliedDamage = applyDamageToPlayer(pending.targetOwner, damage, { log: false });
      dealtDamage = appliedDamage;
      addLog(`${setCard.name}の効果で${receiver.name}に${dealtDamage}ダメージを与えました。`);
    });
  });
  if (dealtDamage) {
    checkWinner();
  }
}

// このカードが1枚で攻撃しているなら、攻撃はカード名に「ドラゴンシールド」を含む
// カードによって無効化・軽減されない（ディルクショーテル・ドラゴン EB02/0008）。
// 攻撃の防御耐性(attackResistances): 条件×フィルタ×耐性種別(nullify/reduce) の合成可能プリミティブ
function resistanceFilterMatches(filter, card, name) {
  if (!filter || Object.keys(filter).length === 0) return true; // filter省略=全防御源に一致
  if (card) return matchesCardFilter(card, filter);
  const nameHit = (f) => Boolean((f.nameIncludes && (name || "").includes(f.nameIncludes)) || (f.name && name === f.name));
  if (Array.isArray(filter.anyOf)) return filter.anyOf.some(nameHit) || nameHit(filter);
  return nameHit(filter);
}

function applicableAttackResistances(attackers = []) {
  const entries = [];
  (attackers || []).forEach((atk) => {
    const card = atk?.card;
    (card?.attackResistances || []).forEach((entry) => {
      const owner = atk.owner ?? findFieldCardSlot(card)?.owner ?? state.active;
      if (!entry.conditions || checkCardConditions(entry.conditions, owner, { card, zone: atk.zone })) {
        entries.push(entry);
      }
    });
  });
  return entries;
}

function attackSourceResisted(attackers, kind, sourceCard, sourceName) {
  return applicableAttackResistances(attackers).some(
    (e) => (e.effects || []).includes(kind) && resistanceFilterMatches(e.filter, sourceCard, sourceName),
  );
}

// 連携攻撃で受けるダメージの上限（君が連携攻撃によって受けるダメージは N になる）。
function linkAttackDamageCapFor(defenderOwner) {
  const player = state.players[defenderOwner];
  let cap = null;
  zones.forEach((zone) => {
    const card = player.field[zone];
    if (card && typeof card.linkAttackDamageReceivedTo === "number") {
      cap = cap === null ? card.linkAttackDamageReceivedTo : Math.min(cap, card.linkAttackDamageReceivedTo);
    }
  });
  return cap;
}

async function resolveFighterAttack(pending, attackers, attackerNames) {
  const defender = state.players[pending.defender];
  const defenseItemInfo = getPendingBattleTargetInfo(pending);
  let damage = attackers.reduce((total, attacker) => total + visibleCritical(attacker.card), 0);
  if (attackers.length > 1) {
    const cap = linkAttackDamageCapFor(pending.defender);
    if (cap !== null && damage > cap) {
      damage = cap;
    }
  }
  const damageOptions = { log: false };
  const reduceResist = applicableAttackResistances(attackers).filter((e) => (e.effects || []).includes("reduce"));
  if (reduceResist.length > 0) {
    damageOptions.resistEntries = reduceResist;
  }

  if (defenseItemInfo) {
    const attackPower = attackers.reduce((total, attacker) => total + visiblePower(attacker.card), 0);
    const itemDefense = visibleDefense(defenseItemInfo.card);
    if (attackPower < itemDefense) {
      addLog(
        `${defender.name}の${defenseItemInfo.card.name}の防御力${itemDefense}により、${attackerNames}の攻撃はダメージを与えられませんでした。`,
      );
      finishPendingAttack({ dealtDamage: 0, battledDefenseItem: true });
      render();
      return;
    }
    const dealtDamage = applyDamageToPlayer(pending.defender, damage, damageOptions);
    addLog(
      `${attackerNames}の攻撃力${attackPower}が${defenseItemInfo.card.name}の防御力${itemDefense}以上のため、${defender.name}は${dealtDamage}ダメージを受けました。`,
    );
    await runDamageDealtTriggers(attackers, pending, dealtDamage);
    finishPendingAttack({ dealtDamage, battledDefenseItem: true });
    checkWinner();
    render();
    return;
  }

  const dealtDamage = applyDamageToPlayer(pending.defender, damage, damageOptions);
  addLog(`${defender.name}は${attackerNames}の攻撃で${dealtDamage}ダメージを受けました。`);
  await runDamageDealtTriggers(attackers, pending, dealtDamage);
  finishPendingAttack({ dealtDamage });
  checkWinner();
  render();
}

async function resolveCounterattack(targetSlot, attackers) {
  const targetAfterBattle = state.players[targetSlot.owner]?.field[targetSlot.zone];
  if (!hasKeyword(targetAfterBattle, "counterattack") || effectiveCardType(targetAfterBattle) !== "monster") {
    return;
  }
  const candidates = attackers.filter(
    (attacker) =>
      effectiveCardType(attacker.card) === "monster" &&
      visiblePower(targetAfterBattle) >= visibleDefense(attacker.card),
  );
  if (candidates.length === 0) {
    return;
  }
  let counterTarget = candidates[0];
  if (candidates.length > 1) {
    const selected = await chooseCardEntries(candidates, {
      title: `${targetAfterBattle.name}の『反撃』`,
      lead: "『反撃』で破壊する攻撃モンスター1枚を選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
    });
    counterTarget = selected?.[0];
  }
  if (!counterTarget) {
    return;
  }
  const attackerName = counterTarget.card.name;
  const destroyed = destroyFieldCard(counterTarget.owner, counterTarget.zone);
  if (destroyed) {
    addLog(`${targetAfterBattle.name}の反撃で${attackerName}を破壊しました。`);
  }
}

function finishPendingAttack(outcome = {}) {
  const pending = state.pendingAttack;
  if (!pending) {
    return;
  }
  state.lastAttackOutcome = {
    ...outcome,
    nullified: Boolean(outcome.nullified || pending.nullified),
    attackers: getPendingAttackerSlots(pending),
    targetOwner: pending.targetOwner,
    targetZone: pending.targetZone,
    targetType: pending.targetType,
  };
  if (!state.lastAttackOutcome.nullified) {
    runAfterAttackTriggers(state.lastAttackOutcome);
    queueBattleEndTriggers(state.lastAttackOutcome.attackers || []);
  }
  clearPendingAttack(outcome);
}

// このカードのバトル終了時(攻撃が無効化されず解決した後)の triggered 能力を発火する。
function queueBattleEndTriggers(attackerSlots) {
  attackerSlots.forEach((slot) => {
    const card = state.players[slot.owner]?.field?.[slot.zone];
    if (!card || !(card.abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "battleEnd")) {
      return;
    }
    Promise.resolve()
      .then(async () => {
        await runTriggeredAbilities(card, "battleEnd", { card, player: state.players[slot.owner], owner: slot.owner, zone: slot.zone });
        render();
      })
      .catch((error) => {
        console.error(error);
        addLog(`${card.name}のバトル終了時能力の処理中にエラーが発生しました。`);
        render();
      });
  });
}

function pendingAttackNullifyBlocker(pending = state.pendingAttack) {
  if (!pending) {
    return null;
  }
  const attackers = getPendingAttackers();
  if (attackers.length === 1 && hasKeyword(attackers[0].card, "singleAttackCannotBeNullified")) {
    return attackers[0].card;
  }
  return null;
}

function nullifyPendingAttack(sourceName = "効果", sourceCard = null) {
  const pending = state.pendingAttack;
  if (!pending) {
    return false;
  }
  const blocker = pendingAttackNullifyBlocker(pending);
  if (blocker) {
    addLog(`${blocker.name}の攻撃は無効化されません。`);
    return false;
  }
  // 攻撃の無効化耐性（attackResistances の nullify。filter/conditionで合成可能）
  if (attackSourceResisted(getPendingAttackers(), "nullify", sourceCard, sourceName)) {
    addLog(`${sourceName}では${getPendingAttackers()[0]?.card?.name || "この攻撃"}の攻撃は無効化されません。`);
    return false;
  }
  pending.nullified = true;
  pending.skipAfterAttackTriggers = true;
  getPendingAttackers().forEach((attacker) => {
    attacker.card.used = true;
  });
  state.lastAttackOutcome = {
    nullified: true,
    nullifiedBy: sourceName,
    attackers: getPendingAttackerSlots(pending),
    targetOwner: pending.targetOwner,
    targetZone: pending.targetZone,
    targetType: pending.targetType,
  };
  clearPendingAttack({ nullified: true });
  return true;
}

async function resolvePenetrateDamage(attackers, pending) {
  if (pending.targetZone !== "center") {
    return;
  }
  const penetrateDamage = attackers
    .filter((attacker) => hasKeyword(attacker.card, "penetrate"))
    .reduce((total, attacker) => total + visibleCritical(attacker.card), 0);
  if (penetrateDamage <= 0) {
    return;
  }
  const defender = state.players[pending.defender];
  const penetrateOptions = { log: false };
  const reducePenetrateResist = applicableAttackResistances(attackers).filter((e) => (e.effects || []).includes("reduce"));
  if (reducePenetrateResist.length > 0) {
    penetrateOptions.resistEntries = reducePenetrateResist;
  }
  const dealtDamage = applyDamageToPlayer(pending.defender, penetrateDamage, penetrateOptions);
  addLog(`貫通により${defender.name}に${dealtDamage}ダメージを与えました。`);
  await runDamageDealtTriggers(
    attackers.filter((attacker) => hasKeyword(attacker.card, "penetrate")),
    pending,
    dealtDamage,
  );
  checkWinner();
}

async function runDamageDealtTriggers(attackers, pending, damage) {
  if (damage <= 0) {
    return;
  }
  const damageSources = attackers.map((attacker) => ({
      card: attacker.card,
      owner: attacker.owner,
      zone: attacker.zone,
      source: "field",
    }));
  const damageEvent = {
    kind: "damageDealt",
    source: damageSources[0],
    sources: damageSources,
    sourceCard: compactCardForLog(damageSources[0]?.card),
    sourceOwner: damageSources[0]?.owner,
    defender: pending.defender,
    damage,
    turnCount: state.turnCount,
    phase: pending.phase || state.phase,
  };
  state.lastDamageEvent = damageEvent;
  state.counterEventWindow = damageEvent;
  for (const damageSource of damageSources) {
    const attacker = {
      card: damageSource.card,
      owner: damageSource.owner,
      zone: damageSource.zone,
    };
    await runTriggeredAbilities(attacker.card, "dealDamage", {
      card: attacker.card,
      player: state.players[attacker.owner],
      owner: attacker.owner,
      zone: attacker.zone,
      damage,
      defender: pending.defender,
      damageSource,
    });
    for (const zone of zones) {
      const sourceCard = state.players[attacker.owner].field[zone];
      if (!sourceCard || sourceCard.instanceId === attacker.card.instanceId) {
        continue;
      }
      await runTriggeredAbilities(sourceCard, "allyDealDamage", {
        card: sourceCard,
        player: state.players[attacker.owner],
        owner: attacker.owner,
        zone,
        damage,
        defender: pending.defender,
        damageSource,
      });
    }
  }
}

function runAfterAttackTriggers(outcome) {
  if (outcome.nullified) {
    return;
  }
  (outcome.attackers || []).forEach((slot) => {
    const card = state.players[slot.owner]?.field[slot.zone];
    if (!card) {
      return;
    }
    if (hasKeyword(card, "tripleAttack")) {
      card.tripleAttackStandCount = card.tripleAttackStandCount || 0;
      if (card.tripleAttackStandCount < 2) {
        card.used = false;
        card.tripleAttackStandCount += 1;
        addLog(`${card.name}は３回攻撃でスタンドしました。`);
      }
      return;
    }
    if (!hasKeyword(card, "doubleAttack") || card.doubleAttackUsed) {
      return;
    }
    card.used = false;
    card.doubleAttackUsed = true;
    addLog(`${card.name}は2回攻撃でスタンドしました。`);
  });
}

function clearPendingAttack(outcome = {}) {
  const returnPhase = state.pendingAttack?.phase || "attack";
  clearBattleModifiers();
  state.pendingAttack = null;
  state.counterHandOwner = null;
  state.phase = returnPhase;
  state.selected = null;
  state.linkAttackers = [];
}

function toggleCounterHand() {
  if (!hasPendingResolution() && !isCounterPlayTiming()) {
    return;
  }
  if (state.pendingAttack) {
    const pending = state.pendingAttack;
    state.counterHandOwner =
      handOwnerIndex() === pending.defender ? pending.attackerOwner : pending.defender;
  } else if (state.pendingAction) {
    const pending = state.pendingAction;
    state.counterHandOwner =
      handOwnerIndex() === pending.responder ? pending.owner : pending.responder;
  } else {
    state.counterHandOwner = handOwnerIndex() === state.active ? opponentIndex() : state.active;
  }
  state.selected = null;
  render();
}

function clearBattleModifiers() {
  state.players.forEach((player) => {
    zones.forEach((zone) => {
      const card = player.field[zone];
      if (card) {
        card.battlePowerBonus = 0;
        card.battleDefenseBonus = 0;
        card.battleCriticalBonus = 0;
        card.counterattack = false;
        card.temporaryKeywords = [];
      }
    });
  });
}

function handleDestroyedDuringPending(target) {
  if (!state.pendingAttack) {
    return;
  }
  const pending = state.pendingAttack;
  const destroyedAttacker = getPendingAttackerSlots(pending).some((attacker) =>
    sameSlot(attacker, target),
  );
  const destroyedTarget =
    target.owner === pending.targetOwner && target.zone === pending.targetZone;
  if (destroyedAttacker || destroyedTarget) {
    addLog("攻撃に関わるカードが場を離れたため、攻撃は終了しました。");
    clearPendingAttack();
  }
}

function getPendingAttacker() {
  return getPendingAttackers()[0]?.card || null;
}

function getPendingAttackers() {
  const pending = state.pendingAttack;
  if (!pending) {
    return [];
  }
  return getPendingAttackerSlots(pending)
    .map((slot) => ({ ...slot, card: state.players[slot.owner]?.field[slot.zone] }))
    .filter((attacker) => attacker.card);
}

function getPendingAttackerSlots(pending) {
  return pending.attackers?.length
    ? pending.attackers
    : [{ owner: pending.attackerOwner, zone: pending.attackerZone }];
}

function getAttackDeclarationAttackers() {
  const slots = state.linkAttackers?.length
    ? state.linkAttackers
    : state.selected?.source === "field"
      ? [{ owner: state.selected.owner, zone: state.selected.zone }]
      : [];
  const seen = new Set();
  return slots
    .filter((slot) => {
      const key = `${slot.owner}:${slot.zone}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return slot.owner === state.active;
    })
    .map((slot) => ({ ...slot, card: state.players[slot.owner]?.field[slot.zone] }))
    .filter((attacker) => attacker.card && !attacker.card.used && canDeclareAttack(attacker));
}

function canDeclareAttack(attacker) {
  if (!attacker?.card) {
    return false;
  }
  const player = state.players[attacker.owner];
  if (
    state.monsterAttackForbidden?.[attacker.owner] &&
    effectiveCardType(attacker.card) === "monster"
  ) {
    // ignoreAttackForbidden は「グレイプニル」の効果のみ無視できる（マーナガルム/魔狼フェンリル）。
    // デイ・オブ・ザ・ドラゴン等の他の攻撃禁止は無視できないため、禁止の発生源を確認する。
    const sources = state.monsterAttackForbiddenSources?.[attacker.owner] || [];
    const ignored = hasKeyword(attacker.card, "ignoreAttackForbidden") ? ["グレイプニル"] : [];
    const blocked = sources.length === 0 || sources.some((src) => !ignored.includes(src));
    if (blocked) {
      return false;
    }
  }
  if (
    effectiveCardType(attacker.card) === "item" &&
    player?.field.center &&
      !hasKeyword(attacker.card, "canAttackWithCenter")
  ) {
    return false;
  }
  if (!checkCardConditions(attacker.card.attackConditions || [], attacker.owner, {
    card: attacker.card,
    zone: attacker.zone,
  })) {
    return false;
  }
  return true;
}

function sameSlot(left, right) {
  return left?.owner === right?.owner && left?.zone === right?.zone;
}

function oppositeFieldZone(zone) {
  if (zone === "left") {
    return "right";
  }
  if (zone === "right") {
    return "left";
  }
  return zone;
}

function getPendingTarget() {
  return getPendingBattleTargetInfo()?.card || null;
}

function getPendingBattleTargetInfo(pending = state.pendingAttack) {
  if (!pending) {
    return null;
  }
  if (pending.targetType === "monster") {
    const card = state.players[pending.targetOwner]?.field[pending.targetZone];
    return card ? { owner: pending.targetOwner, zone: pending.targetZone, card } : null;
  }
  if (pending.targetType === "fighter") {
    const card = state.players[pending.defender]?.field.item;
    return isDefenseItem(card) ? { owner: pending.defender, zone: "item", card } : null;
  }
  if (pending.targetType === "item") {
    const card = state.players[pending.targetOwner]?.field[pending.targetZone];
    return isDefenseItem(card) ? { owner: pending.targetOwner, zone: pending.targetZone, card } : null;
  }
  return null;
}

function isDefenseItem(card) {
  return Boolean(card && effectiveCardType(card) === "item" && visibleDefense(card) > 0);
}

function isPendingBattleCard(targetInfo) {
  if (!targetInfo) {
    return false;
  }
  if (getPendingAttackers().some((attacker) => sameSlot(attacker, targetInfo))) {
    return true;
  }
  const battleTarget = getPendingBattleTargetInfo();
  return Boolean(battleTarget && sameSlot(battleTarget, targetInfo));
}

function makeEffectCause(context, victimOwner) {
  // 効果による破壊の発生源情報（破壊耐性 destroyImmunity の判定に使う）
  return {
    byEffect: true,
    byOpponent: victimOwner !== context.owner,
    sourceType: context.card ? effectiveCardType(context.card) : null,
    sourceCard: context.card || null,
  };
}

function destroyImmunityBlocks(card, cause, owner) {
  const imm = card.destroyImmunity;
  if (!imm || !cause) return false;
  const entries = Array.isArray(imm) ? imm : [imm];
  const zone = findFieldCardSlot(card)?.zone;
  return entries.some((e) => {
    // 旧 object 形（発生源種別の固定bool）。いずれも効果破壊(byEffect)前提のためバトル破壊では発火しない。
    if (e.fromEffect && cause.byEffect) return true;
    if (e.fromOpponentEffect && cause.byEffect && cause.byOpponent) return true;
    if (e.fromSpell && cause.byEffect && cause.sourceType === "spell") return true;
    if (e.fromImpact && cause.byEffect && cause.sourceType === "impact") return true;
    // 新 form（from条件 × byFilter（破壊元カード） × conditions（被破壊側owner基準））
    if (e.from || e.byFilter || e.conditions) {
      // バトル破壊耐性は from.byBattle を明示した耐性のみが対象（既存の効果破壊耐性に誤適用しない）。逆も同様。
      if (cause.byBattle && !(e.from && e.from.byBattle)) return false;
      if (!cause.byBattle && e.from && e.from.byBattle) return false;
      if (e.from) {
        if (e.from.byEffect && !cause.byEffect) return false;
        if (e.from.byOpponent && !cause.byOpponent) return false;
        if (e.from.sourceType && cause.sourceType !== e.from.sourceType) return false;
      }
      if (e.byFilter && !(cause.sourceCard && matchesCardFilter(cause.sourceCard, e.byFilter))) return false;
      if (e.conditions && !checkCardConditions(e.conditions, owner, { card, zone, owner })) return false;
      return true;
    }
    return false;
  });
}

// 破壊時誘発がこのカード自身のソウルを参照するか（from:"soul"）。
// true の場合、ソウルのドロップ送りを誘発解決後まで遅延させる（グレイプニル等）。
function destroyTriggerUsesSoul(card) {
  const scan = (node) => {
    if (Array.isArray(node)) {
      return node.some(scan);
    }
    if (node && typeof node === "object") {
      if (node.from === "soul") {
        return true;
      }
      return Object.values(node).some(scan);
    }
    return false;
  };
  return (card.abilities || []).some(
    (ability) => ability.kind === "triggered" && ability.event === "destroyed" && scan(ability),
  );
}

function destroyFieldCard(owner, zone, options = {}) {
  const player = state.players[owner];
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  // 汎用破壊耐性: 旧 {fromEffect/fromOpponentEffect/fromSpell/fromImpact} と
  // 新 [{from:{byEffect,byOpponent,sourceType}, byFilter, conditions}] の両対応
  if (!options.ignoreDestroyImmunity && options.cause && destroyImmunityBlocks(card, options.cause, owner)) {
    addLog(`${card.name}は${options.cause.byBattle ? "攻撃" : "効果"}では破壊されません。`);
    return null;
  }
  if (!options.ignoreDestroyReplacement && applyDestroyReplacement(card, owner, options)) {
    // 置換が成立した場合、カードは破壊されていない（破壊数・破壊時誘発・貫通判定に数えない）
    return null;
  }
  if (!options.ignoreDestroyReplacement && card.preventNextDestroyCount > 0) {
    card.preventNextDestroyCount -= 1;
    const replacement = card.preventNextDestroyEffects?.shift();
    const countsAsDestroyed = Boolean(replacement?.countsAsDestroyed);
    if (replacement?.gainLife) {
      state.players[replacement.owner ?? owner].life += replacement.gainLife;
      addLog(`${replacement.source || card.name}の効果で${state.players[replacement.owner ?? owner].name}のライフを${replacement.gainLife}回復しました。`);
    }
    addLog(`${card.name}は効果により場に残りました。`);
    if (countsAsDestroyed) {
      recordSpecialCallOpportunity(card, owner, zone, options);
      queueDestroyedTriggers(card, owner, zone);
      return card;
    }
    return null;
  }
  if (!options.ignoreSoulguard && canUseSoulguard(card) && shouldUseSoulguard(card)) {
    const soulCard = card.soul.pop();
    player.drop.push(soulCard);
    addLog(`${card.name}はソウルガードで場に残りました。`);
    return null;
  }
  const moveSoulTo = card.onDestroy?.moveSoulTo || (card.returnSoulToHandOnDestroy ? "hand" : null);
  if (moveSoulTo === "hand" && (card.soul || []).length > 0) {
    // 「破壊される場合、ソウル全てを手札に加える」。ソウルがドロップへ移る前に回収。
    const recovered = card.soul.length;
    player.hand.push(...card.soul);
    card.soul = [];
    addLog(`${card.name}が破壊され、ソウル${recovered}枚を手札に加えました。`);
  } else if (destroyTriggerUsesSoul(card)) {
    // 破壊時能力がソウルを参照するため、ドロップ送りは queueDestroyedTriggers の解決後まで遅延。
  } else {
    player.drop.push(...(card.soul || []));
    card.soul = [];
  }
  player.drop.push(card);
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, owner);
  recordDestroyedEventWindow(card, owner);
  recordSpecialCallOpportunity(card, owner, zone, options);
  queueDestroyedTriggers(card, owner, zone);
  return card;
}

function applyDestroyReplacement(card, owner, options = {}) {
  const replacement = card.destroyReplacement;
  if (!replacement || options.ignoreDestroyReplacement) {
    return false;
  }
  const player = state.players[owner];
  if (!checkCardConditions(replacement.conditions || [], owner, {
    card,
    owner,
    zone: findFieldCardSlot(card)?.zone,
  })) {
    return false;
  }
  if (!canPayStructuredCost(player, replacement.cost || [], {
    sourceCard: card,
    selectedCard: card,
  }).ok) {
    return false;
  }
  if (replacement.optional && !window.confirm(`${card.name}の破壊置換を使いますか？`)) {
    return false;
  }
  const payment = payStructuredCost(player, replacement.cost || [], {
    sourceCard: card,
    selectedCard: card,
  });
  if (!payment.ok) {
    return false;
  }
  if (replacement.gainLife) {
    player.life += replacement.gainLife;
  }
  if (replacement.to === "gauge") {
    const slot = findFieldCardSlot(card);
    if (slot) {
      player.drop.push(...(card.soul || []));
      card.soul = [];
      player.field[slot.zone] = null;
      player.gauge.push(card);
    }
    addLog(`${card.name}は破壊置換によりゲージに置かれました。`);
    return true;
  }
  addLog(`${card.name}は破壊置換により場に残りました。`);
  return true;
}

function recordSpecialCallOpportunity(destroyedCard, owner, zone, options = {}) {
  state.specialCallOpportunities ||= [];
  const lifeLinkEvent = findRecentLifeLinkEvent(owner, {
    sameTurn: true,
    filter: { name: destroyedCard.name },
  });
  state.specialCallOpportunities.push({
    owner,
    destroyedCard: compactCardForLog(destroyedCard),
    destroyedName: destroyedCard.name,
    destroyedZone: zone,
    turnCount: state.turnCount,
    phase: state.phase,
    reason: options.reason || "destroyed",
    lifeLinkEventId: lifeLinkEvent?.id || null,
    expired: false,
  });
  if (state.specialCallOpportunities.length > 20) {
    state.specialCallOpportunities.splice(0, state.specialCallOpportunities.length - 20);
  }
}

function findSpecialCallOpportunity(owner, spec = {}) {
  const events = state.specialCallOpportunities || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!specialCallOpportunityMatches(event, owner, spec)) {
      continue;
    }
    return event;
  }
  return null;
}

function specialCallOpportunityMatches(event, owner, spec = {}) {
  if (!event || event.used || event.expired) {
    return false;
  }
  if (spec.sameTurn !== false && event.turnCount !== state.turnCount) {
    return false;
  }
  if (spec.kind && spec.kind !== event.reason) {
    return false;
  }
  if (spec.controller === "opponent") {
    if (event.owner === owner) {
      return false;
    }
  } else if (spec.controller !== "any" && event.owner !== owner) {
    return false;
  }
  return matchesCardFilter(event.destroyedCard, spec.filter || {});
}

function recordDestroyedEventWindow(card, owner) {
  if (state.destroyedEventWindow && state.destroyedEventWindow.turnCount === state.turnCount) {
    state.destroyedEventWindow.entries.push({ card, owner });
    return;
  }
  state.destroyedEventWindow = {
    kind: "destroyed",
    entries: [{ card, owner }],
    turnCount: state.turnCount,
  };
}

function recordEnteredEventWindow(card, owner, zone) {
  if (state.enteredEventWindow && state.enteredEventWindow.turnCount === state.turnCount) {
    state.enteredEventWindow.entries.push({ card, owner, zone });
    return;
  }
  state.enteredEventWindow = {
    kind: "entered",
    entries: [{ card, owner, zone }],
    turnCount: state.turnCount,
  };
}

function expireTransientResponseWindows(options = {}) {
  const preserved = options.preserveSpecialCallOpportunity;
  (state.specialCallOpportunities || []).forEach((event) => {
    if (!event.used && !event.expired && event !== preserved) {
      event.expired = true;
    }
  });
  state.counterEventWindow = null;
  state.destroyedEventWindow = null;
  state.enteredEventWindow = null;
}

function queueDestroyedTriggers(card, owner, zone) {
  if (!(card.abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "destroyed")) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runTriggeredAbilities(card, "destroyed", {
        card,
        player: state.players[owner],
        owner,
        zone,
      });
      // 破壊時能力で使われなかったソウルはドロップへ（destroyFieldCard で遅延した分の回収）。
      if ((card.soul || []).length > 0) {
        state.players[owner].drop.push(...card.soul);
        card.soul = [];
      }
      render();
    })
    .catch((error) => {
      console.error(error);
      addLog(`${card.name}の破壊時能力の処理中にエラーが発生しました。`);
      render();
    });
}

// 「場のモンスターが手札/デッキに戻った時」の誘発（D・R・システム / 竜剣 ドラムソード等、場の他カードが反応）。
// 復帰処理は同期関数のため、破壊/手札破棄の誘発と同じくマイクロタスクで非同期発火する。
function queueMonsterReturnedTriggers(card, owner, zone) {
  if (effectiveCardType(card) !== "monster") {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runFieldEventTriggers("monsterReturned", owner, card, zone);
      render();
    })
    .catch((error) => {
      console.error(error);
      addLog(`${card?.name ?? "カード"}の復帰誘発の処理中にエラーが発生しました。`);
      render();
    });
}

function queueDiscardedFromHandTriggers(card, owner) {
  if (!(card.abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "discardedFromHand")) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runTriggeredAbilities(card, "discardedFromHand", { card, player: state.players[owner], owner });
      render();
    })
    .catch((error) => {
      console.error(error);
      addLog(`${card.name}の手札破棄時能力の処理中にエラーが発生しました。`);
      render();
    });
}

// 手札のカードをドロップへ送り、「手札から捨てられた時」誘発を発火させる共通経路。
function discardHandCardsToDrop(player, cards) {
  const owner = state.players.indexOf(player);
  cards.forEach((card) => {
    player.drop.push(card);
    queueDiscardedFromHandTriggers(card, owner);
  });
}

function dropFieldCardByRule(player, zone) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  player.drop.push(...(card.soul || []));
  card.soul = [];
  player.drop.push(card);
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, state.players.indexOf(player));
  return card;
}

function canUseSoulguard(card) {
  return hasKeyword(card, "soulguard") && (card.soul?.length || 0) > 0;
}

function shouldUseSoulguard(card) {
  if (typeof window?.confirm !== "function") {
    return true;
  }
  const useSoulguard = window.confirm(`${card.name}の『ソウルガード』を使いますか？`);
  if (!useSoulguard) {
    addLog(`${card.name}の『ソウルガード』を使いませんでした。`);
  }
  return useSoulguard;
}

function lifeLinkAmount(card) {
  const keywords = [
    ...(card?.keywords || []),
    ...(card?.temporaryKeywords || []),
    ...(card?.turnKeywords || []),
  ];
  const match = keywords.map(String).find((keyword) => /^lifeLink\d+$/i.test(keyword));
  return match ? Number(match.replace(/\D/g, "")) : 0;
}

function hasInstantLifeLink(card) {
  const keywords = [
    ...(card?.keywords || []),
    ...(card?.temporaryKeywords || []),
    ...(card?.turnKeywords || []),
  ].map(String);
  return keywords.some((keyword) =>
    ["lifeLinkLose", "lifeLinkDeath", "lifeLinkInstantDeath", "lifeLinkSokushi", "lifeLink即死"].includes(keyword),
  );
}

function applyLifeLink(card, owner) {
  const amount = lifeLinkAmount(card);
  const instantDefeat = hasInstantLifeLink(card);
  if ((!amount && !instantDefeat) || owner < 0) {
    return null;
  }
  const event = recordLifeLinkEvent(card, owner, { amount, instantDefeat });
  if (instantDefeat) {
    if (!state.winner) {
      state.winner = state.players[1 - owner]?.name || null;
    }
    addLog(`${card.name}'s Life Link causes defeat for ${state.players[owner].name}.`);
    return event;
  }
  event.appliedDamage = applyDamageToPlayer(owner, amount, { log: false });
  addLog(`${card.name}のライフリンクにより${state.players[owner].name}に${amount}ダメージ。`);
  return event;
}

function recordLifeLinkEvent(card, owner, details = {}) {
  state.lifeLinkEvents ||= [];
  const event = {
    id: createInstanceId(),
    card,
    cardId: card?.id || "",
    cardInstanceId: card?.instanceId || "",
    cardName: card?.name || "",
    owner,
    amount: details.amount || 0,
    appliedDamage: 0,
    instantDefeat: Boolean(details.instantDefeat),
    canceled: false,
    turnCount: state.turnCount,
  };
  state.lifeLinkEvents.push(event);
  if (state.lifeLinkEvents.length > 20) {
    state.lifeLinkEvents.splice(0, state.lifeLinkEvents.length - 20);
  }
  return event;
}

function findRecentLifeLinkEvent(owner, spec = {}) {
  const events = state.lifeLinkEvents || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (lifeLinkEventMatches(event, owner, spec)) {
      return event;
    }
  }
  return null;
}

function lifeLinkEventMatches(event, owner, spec = {}) {
  if (!event || event.canceled) {
    return false;
  }
  if (spec.sameTurn !== false && event.turnCount !== state.turnCount) {
    return false;
  }
  if (spec.controller === "opponent") {
    if (event.owner === owner) {
      return false;
    }
  } else if (spec.controller !== "any" && event.owner !== owner) {
    return false;
  }
  return matchesCardFilter(event.card, spec.filter || {});
}

function cancelRecentLifeLink(owner, spec = {}, sourceName = "") {
  const event = findRecentLifeLinkEvent(owner, spec);
  if (!event) {
    return null;
  }
  event.canceled = true;
  if (event.appliedDamage > 0) {
    state.players[event.owner].life += event.appliedDamage;
  }
  clearWinnerIfNoCurrentLoss();
  addLog(`${sourceName || event.cardName} canceled ${event.cardName}'s Life Link.`);
  return event;
}

function findLifeLinkEventForCallOpportunity(owner, spec = {}) {
  const opportunity = findSpecialCallOpportunity(owner, spec);
  if (!opportunity) {
    return null;
  }
  if (opportunity.lifeLinkEventId) {
    const byId = (state.lifeLinkEvents || []).find(
      (event) => event.id === opportunity.lifeLinkEventId && !event.canceled,
    );
    if (byId) {
      return byId;
    }
  }
  return findRecentLifeLinkEvent(owner, {
    ...spec,
    filter: spec.filter || { name: opportunity.destroyedName },
  });
}

function cancelCallOpportunityLifeLink(owner, spec = {}, sourceName = "") {
  const opportunity = findSpecialCallOpportunity(owner, spec);
  const event = findLifeLinkEventForCallOpportunity(owner, spec);
  if (!opportunity || !event) {
    return null;
  }
  opportunity.lifeLinkCanceled = true;
  event.canceled = true;
  if (event.appliedDamage > 0) {
    state.players[event.owner].life += event.appliedDamage;
  }
  clearWinnerIfNoCurrentLoss();
  addLog(`${sourceName || event.cardName} canceled ${event.cardName}'s Life Link.`);
  return event;
}

function clearWinnerIfNoCurrentLoss() {
  if (!state.winner) {
    return;
  }
  const stillLost = state.players.some((player) => player.life <= 0 || player.deck.length === 0);
  if (!stillLost) {
    state.winner = null;
  }
}

async function endTurn() {
  if (state.winner || hasPendingResolution()) {
    return;
  }
  if (state.phase !== "final") {
    addLog("ターン終了はファイナルフェイズの終了時に行います。");
    return;
  }
  expireTransientResponseWindows();
  const endingOwner = state.active;
  await runPhaseStartTriggers("turnEnd", endingOwner);
  runEndTurnEffects(state.active);
  clearDamagePreventionForTurn(endingOwner);
  clearTurnModifiers();
  state.monsterAttackForbidden = [false, false];
  state.monsterAttackForbiddenSources = [[], []];
  activePlayer().oncePerTurn = {};
  if (state.extraTurnOwner === endingOwner) {
    state.extraTurnOwner = null;
    state.active = endingOwner;
    addLog(`${state.players[endingOwner].name}の追加ターンを開始します。`);
  } else {
    state.active = opponentIndex();
  }
  state.turnCount += 1;
  standPlayer(activePlayer());
  state.phase = "draw";
  state.selected = null;
  state.counterHandOwner = null;
  state.chargedThisTurn = false;
  state.drewThisTurn = false;
  state.attacksThisTurn = 0;
  state.lastDamageTaken = [0, 0];
  state.linkAttackers = [];
  state.buddyCallDeclared = null;
  addLog(`${activePlayer().name}のターンです。`);
  render();
}

function clearDamagePreventionForTurn(endingOwner) {
  (state.damagePrevention || []).forEach((entries, owner) => {
    state.damagePrevention[owner] = (entries || []).filter(
      (entry) => entry.untilTurnOwner !== endingOwner,
    );
  });
}

function runEndTurnEffects(endingOwner) {
  state.players.forEach((player, owner) => {
    zones.forEach((zone) => {
      const card = player.field[zone];
      if (card?.destroyAtEndOfTurnOwner === endingOwner) {
        const destroyedName = card.name;
        card.destroyAtEndOfTurnOwner = null;
        const destroyed = destroyFieldCard(owner, zone, { ignoreSoulguard: true });
        if (destroyed) {
          addLog(`${destroyedName}はターン終了時の効果で破壊されました。`);
        }
      }
    });
  });
}

function clearTurnModifiers() {
  state.players.forEach((player) => {
    player.nextActivatedCostMayUseOpponentGauge = false;
    zones.forEach((zone) => {
      const card = player.field[zone];
      if (card) {
        card.turnPowerBonus = 0;
        card.turnDefenseBonus = 0;
        card.turnCriticalBonus = 0;
        card.turnKeywords = [];
        card.turnSuppressedKeywords = [];
        card.preventNextDestroyCount = 0;
      }
    });
  });
}

function standPlayer(player) {
  zones.forEach((zone) => {
    const card = player.field[zone];
    if (card) {
      card.used = false;
      card.battlePowerBonus = 0;
      card.battleDefenseBonus = 0;
      card.battleCriticalBonus = 0;
      card.counterattack = false;
      card.doubleAttackUsed = false;
      card.tripleAttackStandCount = 0;
    }
  });
}

function resolveLifeZeroReplacements() {
  state.players.forEach((player, owner) => {
    if (player.life > 0) {
      return;
    }
    const replacementSlot = [...setZones, "item"]
      .map((zone) => ({ zone, card: player.field[zone] }))
      .find(({ card }) => card?.lifeZeroReplacement);
    if (!replacementSlot) {
      return;
    }
    const { zone, card } = replacementSlot;
    const replacement = card.lifeZeroReplacement;
    let hasRequiredSoul = true;
    if (replacement.soulFilter) {
      const soulCards = card.soul?.splice(0) || [];
      player.drop.push(...soulCards);
      hasRequiredSoul = soulCards.some((soulCard) =>
        matchesCardFilter(soulCard, replacement.soulFilter || {}),
      );
    }
    let topDeckCard = null;
    if (replacement.topDeckFilter) {
      topDeckCard = player.deck.pop() || null;
      if (topDeckCard) {
        player.drop.push(topDeckCard);
      } else {
        declareDeckLoss(player);
      }
      hasRequiredSoul = Boolean(topDeckCard && matchesCardFilter(topDeckCard, replacement.topDeckFilter));
    }
    dropFieldCardByRule(player, zone);
    if (!hasRequiredSoul) {
      addLog(`${card.name}のソウルに条件を満たすカードがないため、ライフを守れませんでした。`);
      return;
    }
    player.life = replacement.life || 1;
    drawCards(player, replacement.draw || 0);
    addLog(`${card.name}の効果で${player.name}のライフは${player.life}になりました。`);
  });
}

function checkWinner() {
  resolveLifeZeroReplacements();
  state.players.forEach((player, index) => {
    if (player.life <= 0 && !state.winner) {
      state.winner = state.players[1 - index].name;
      addLog(`${state.winner}の勝利です。`);
    }
    if (player.deck.length === 0 && !state.winner) {
      state.winner = state.players[1 - index].name;
      addLog(`${player.name}のデッキが0枚のため、${state.winner}の勝利です。`);
    }
  });
}

function declareDeckLoss(player) {
  if (!state?.players || state.winner) {
    return;
  }
  const loserIndex = state.players.indexOf(player);
  if (loserIndex < 0) {
    return;
  }
  state.winner = state.players[1 - loserIndex].name;
  addLog(`${player.name}のデッキが0枚のため、${state.winner}の勝利です。`);
}

function render() {
  hideCardTooltip();
  renderNetworkChrome();
  renderPlayerStats();
  renderZones();
  renderHand();
  renderActions();
  renderLog();
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
    zone?.classList.toggle("turn-seat", state?.active === index);
  });
  elements.p1DeckSelect.disabled = isNetworkConnected() && networkSession.seat !== 0;
  elements.p2DeckSelect.disabled = isNetworkConnected() && networkSession.seat !== 1;
  elements.newGameButton.disabled = isNetworkConnected() && networkSession.seat !== 0;
  elements.copyRoomButton.disabled = !networkSession.roomId;
}

function renderPlayerStats() {
  state.players.forEach((player, index) => {
    const playerNumber = index + 1;
    document.querySelector(`#p${playerNumber}Life`).textContent = player.life;
    const deckCounter = document.querySelector(`#p${playerNumber}Deck`);
    const handCounter = document.querySelector(`#p${playerNumber}Hand`);
    const gaugeCounter = document.querySelector(`#p${playerNumber}Gauge`);
    if (deckCounter) {
      deckCounter.textContent = `デッキ ${player.deck.length}`;
    }
    if (handCounter) {
      handCounter.textContent = `手札 ${player.hand.length}`;
    }
    if (gaugeCounter) {
      gaugeCounter.textContent = `ゲージ ${player.gauge.length}`;
    }
    const partner = document.querySelector(`#p${index + 1}Partner`);
    partner.innerHTML = "";
    partner.append("バディ");
    if (player.buddy) {
      const buddy = document.createElement("span");
      buddy.className = "partner-text";
      buddy.textContent = `バディ：${player.buddy.name}${player.partnerCalled ? "（済）" : ""}`;
      attachTooltip(buddy, player.buddy);
      partner.innerHTML = "";
      partner.append(buddy);
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
    if (zone === "item") {
      renderFlagItemZone(zoneButton, player);
      return;
    }

    const card = player.field[zone];
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

function renderHand() {
  const player = handOwner();
  elements.handList.innerHTML = "";
  player.hand.forEach((card) => {
    const cardButton = createCardElement(card, true);
    cardButton.addEventListener("click", () => selectHandCard(card.instanceId));
    elements.handList.append(cardButton);
  });
}

function createCardElement(card, interactive = false) {
  const cardElement = document.createElement(interactive ? "button" : "span");
  const displayType = effectiveCardType(card);
  cardElement.className = `card ${displayType}`;
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
    ? `<span class="card-stack-peek" title="${escapeHtml(soulNames.join(" / "))}">下札 ${soulNames.length}</span>`
    : "";
  cardElement.innerHTML = `
    <span class="card-title">
      <span class="card-name">${escapeHtml(card.name)}</span>
      <span class="card-kind">${typeLabels[displayType]}</span>
    </span>
    ${soulPeek}
    <span class="card-text">${escapeHtml(effectImplementationLabel(card))}</span>
      <span class="card-stats">
        <span>コスト ${costLabel(card)}</span>
        <span>サイズ ${statLabel(card.size)}</span>
        <span>攻 ${statLabel(visiblePower(card))}</span>
        <span>打 ${statLabel(visibleCritical(card))}</span>
      </span>
  `;
  attachTooltip(cardElement, card);
  return cardElement;
}

function stackedCardNames(card) {
  return (card.soul || []).map((soulCard) => soulCard.name).filter(Boolean);
}

function attachTooltip(element, card) {
  element.addEventListener("mouseenter", (event) => showCardTooltip(card, event));
  element.addEventListener("mousemove", moveCardTooltip);
  element.addEventListener("mouseleave", hideCardTooltip);
  element.addEventListener("focus", (event) => showCardTooltip(card, event));
  element.addEventListener("blur", hideCardTooltip);
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
      !elements.attackTarget.value,
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

function renderAttackTargets() {
  const previous = elements.attackTarget.value;
  const opponent = opponentPlayer();
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

  const targets = [];
  const attackers = getAttackDeclarationAttackers();
  fieldZones.forEach((zone) => {
    if (opponent.field[zone] && attackers.every((attacker) => canAttackTargetValue(attacker, zone))) {
      targets.push({ value: zone, label: `${zoneLabel(zone)}：${opponent.field[zone].name}` });
    }
  });
  if (
    attackers.every((attacker) => canAttackTargetValue(attacker, "fighter")) &&
    (!opponent.field.center || canAttackFighterThroughCenter(attackers))
  ) {
    targets.push({ value: "fighter", label: `${opponent.name}本体` });
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

function findUsableHandAbility(card, options = {}) {
  return (card.abilities || []).find((ability) => {
    if (!canUseAbilityFromHand(ability)) {
      return false;
    }
    if (ability.fromFieldOnly) {
      return false;
    }
    if (ability.fromSoulOnly) {
      return false;
    }
    if (!handAbilityTimingMatches(ability, options)) {
      return false;
    }
    if (isAbilityLimitUsed(state.selected.owner, card, ability)) {
      return false;
    }
    if (ability.target && targetCandidatesFromSpec(ability.target, state.selected.owner, { card, ability }).length === 0) {
      return false;
    }
    return (
      checkAbilityConditions(ability, state.selected.owner) &&
      canSatisfyAbilityScript(card, ability, state.selected.owner)
    );
  });
}

function canUseAbilityFromHand(ability) {
  if (!ability || ability.fromFieldOnly || ability.fromSoulOnly) {
    return false;
  }
  if (["spell", "impact"].includes(ability.kind)) {
    return true;
  }
  return ability.kind === "activated" && ability.fromHandOnly;
}

function handAbilityTimingMatches(ability, options = {}) {
  if (options.counterOnly) {
    return isCounterAbility(ability) && (isCounterPlayTiming() || Boolean(state.pendingAction || state.pendingAttack));
  }
  if (state.pendingAction) {
    return isCounterAbility(ability);
  }
  if (state.pendingAttack) {
    return isCounterAbility(ability);
  }
  return abilityTimingIncludes(ability, state.phase) || (isCounterAbility(ability) && isCounterPlayTiming());
}

function isCounterAbility(ability) {
  return abilityTimingIncludes(ability, "counter");
}

function isCounterOnlyHandCard(card) {
  const handAbilities = (card?.abilities || []).filter((ability) => canUseAbilityFromHand(ability));
  return handAbilities.length > 0 && handAbilities.every((ability) => isCounterAbility(ability));
}

function abilityCostPurpose(ability) {
  if (["spell", "impact"].includes(ability?.kind)) {
    return "cast";
  }
  return ability?.kind || "cast";
}

function abilityCostSteps(card, ability) {
  const purpose = abilityCostPurpose(ability);
  return ability?.cost || card?.costs?.[purpose] || [];
}

function isCounterPlayTiming() {
  return !hasPendingResolution() && ["draw", "charge", "main", "attack", "final"].includes(state.phase);
}

async function useHandAbilityAction(card, ability, options = {}) {
  const owner = state.selected.owner;
  const player = state.players[owner];
  const target = await targetForAbilityUse(card, ability, owner);
  if (ability.target && !target) {
    addLog(`${card.name}の対象を選んでください。`);
    return;
  }
  const costSteps = adjustedCostSteps(
    player,
    card,
    abilityCostPurpose(ability),
    abilityCostSteps(card, ability),
  );
  const payment = await payStructuredCostWithSelection(player, costSteps, {
    sourceCard: card,
    selectedCard: card,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  const usedCard = removeSelectedFromHand();
  if (!options.counterTiming && ["spell", "impact"].includes(ability.kind)) {
    markAbilityLimit(owner, usedCard, ability);
    beginPendingAction({
      kind: ability.kind,
      owner,
      responder: 1 - owner,
      card: usedCard,
      ability,
      phase: state.phase,
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : elements.effectTarget.value,
    });
    addLog(`${player.name}は${usedCard.name}の使用を宣言しました。対抗確認を行ってください。`);
    render();
    return;
  }
  player.drop.push(usedCard);
  if (options.counterKind) {
    markCounterUsed(owner, options.counterKind);
  }
  if (options.counterTiming) {
    addLog(`${player.name}は${usedCard.name}を【対抗】で使いました。`);
  }
  const context = {
    card: usedCard,
    ability,
    player,
    owner,
    target,
  };
  const bodyResult = await executeAbilityBody(context);
  // callSelfFromHand(手札の自身コール)を含む能力で、スクリプトが中断(コール先選択キャンセル等)し
  // 発生源カードがドロップに取り残された場合は、宣言不成立として手札へ戻す(カード喪失を防ぐ)。
  const usesCallSelf = Array.isArray(ability.script) && ability.script.some((s) => s?.op === "callSelfFromHand");
  if (bodyResult === false && usesCallSelf) {
    const onField = [...fieldZones, ...setZones, "item"].some(
      (z) => player.field[z]?.instanceId === usedCard.instanceId,
    );
    const dropIndex = player.drop.findIndex((c) => c.instanceId === usedCard.instanceId);
    if (!onField && dropIndex >= 0) {
      player.drop.splice(dropIndex, 1);
      player.hand.push(usedCard);
      addLog(`${usedCard.name}のコールを取りやめ、手札に戻しました。`);
      state.selected = null;
      state.linkAttackers = [];
      render();
      return;
    }
  }
  markAbilityLimit(owner, usedCard, ability);
  state.selected = null;
  state.linkAttackers = [];
  render();
}

async function useFieldAbilityAction(card) {
  const owner = state.selected.owner;
  const ability = findUsableFieldAbility(card, owner);
  if (!ability) {
    addLog("今使える起動能力はありません。");
    return;
  }
  const zone = state.selected.zone;
  const player = state.players[owner];
  const sourceCard = ability.fromSoul ? ability.soulSourceCard : card;
  const target = await targetForAbilityUse(sourceCard, ability, owner);
  if (ability.target && !target) {
    addLog(`${card.name}の対象を選んでください。`);
    return;
  }
  if (
    hasPendingResolution() &&
    (!isCounterAbility(ability) || !canUseCounterEffect(owner, selectedCounterKind(card)))
  ) {
    addLog("この攻撃中に使える【対抗】能力ではありません。");
    return;
  }
  const usesGaugeCost = abilityCostSteps(sourceCard, ability).some((step) => step.op === "payGauge" && step.amount > 0);
  const includeOpponentGauge = Boolean(
    ability.kind === "activated" &&
      usesGaugeCost &&
      player.nextActivatedCostMayUseOpponentGauge
  );
  const payment = await payStructuredCostWithSelection(player, abilityCostSteps(sourceCard, ability), {
    sourceCard,
    selectedCard: sourceCard,
    ability,
    includeOpponentGauge,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return;
  }
  if (includeOpponentGauge) {
    player.nextActivatedCostMayUseOpponentGauge = false;
  }
  addAbilityUseLog(player, sourceCard, ability);
  if (!hasPendingResolution() && !isCounterAbility(ability)) {
    beginPendingAction({
      kind: "ability",
      owner,
      responder: 1 - owner,
      card: sourceCard,
      ability,
      phase: state.phase,
      zone,
      hostCard: ability.fromSoul ? card : null,
      hostOwner: ability.fromSoul ? owner : null,
      hostZone: ability.fromSoul ? zone : null,
      effectTargetValue: target ? encodeTarget(target.owner, target.zone) : "",
    });
    addLog(`${player.name}は${sourceCard.name}の能力を宣言しました。対抗確認を行ってください。`);
    render();
    return;
  }
  await executeAbilityBody({
    card: sourceCard,
    ability,
    player,
    owner,
    zone,
    hostCard: card,
    hostOwner: owner,
    hostZone: zone,
    target,
  });
  if (hasPendingResolution() && isCounterAbility(ability)) {
    markCounterUsed(owner, selectedCounterKind(card));
  }
  markAbilityLimit(owner, sourceCard, ability);
  state.selected = null;
  state.linkAttackers = [];
  render();
}

async function targetForAbilityUse(card, ability, owner) {
  if (!ability.target) {
    return getEffectTargetInfo();
  }
  const current = getEffectTargetInfo();
  if (current && targetMatchesSpec(current, ability.target, owner, { card, ability })) {
    return current;
  }
  return chooseAbilityTarget(card, ability, owner);
}

function addAbilityUseLog(player, card, ability) {
  if (isFieldActivatedAbility(ability)) {
    addLog(`${player.name}は${card.name}の【起動】を使いました。`);
  }
}

function findUsableFieldAbility(card, owner = state.selected?.owner ?? state.active) {
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  const directAbility = (card.abilities || []).find((ability) => {
    if (ability.fromHandOnly) {
      return false;
    }
    if (!isFieldActivatedAbility(ability)) {
      return false;
    }
    if (!abilityTimingIncludes(ability, timing)) {
      return false;
    }
    if (isAbilityLimitUsed(owner, card, ability)) {
      return false;
    }
    if (ability.target && targetCandidatesFromSpec(ability.target, owner, { card, ability }).length === 0) {
      return false;
    }
    return (
      checkAbilityConditions(ability, owner) &&
      canSatisfyAbilityScript(card, ability, owner, { zone: state.selected?.zone })
    );
  });
  return directAbility || findUsableSoulAbility(card, owner, timing);
}

function findUsableSoulAbility(hostCard, owner, timing) {
  for (const soulSourceCard of hostCard?.soul || []) {
    for (const ability of soulSourceCard.soulAbilities || []) {
      const soulAbility = {
        ...ability,
        fromSoul: true,
        soulSourceCard,
      };
      if (!isFieldActivatedAbility(soulAbility)) {
        continue;
      }
      if (!abilityTimingIncludes(soulAbility, timing)) {
        continue;
      }
      if (isAbilityLimitUsed(owner, soulSourceCard, soulAbility)) {
        continue;
      }
      if (
        !checkAbilityConditions(soulAbility, owner, {
          card: soulSourceCard,
          hostCard,
          hostOwner: owner,
          hostZone: findFieldCardSlot(hostCard)?.zone,
        })
      ) {
        continue;
      }
      return soulAbility;
    }
  }
  return null;
}

function isFieldActivatedAbility(ability) {
  return ability.kind === "activated" || hasAbilityKeyword(ability, "reversal");
}

function abilityTimingIncludes(ability, phase) {
  const timings = ability.timing || [];
  if (timings.length === 0 || timings.includes(phase)) {
    return true;
  }
  // 2018年6月以前ルール: 【対抗】を持つカード/能力は自分のメインフェイズでも使える
  return phase === "main" && timings.includes("counter");
}

function checkAbilityConditions(ability, owner, context = {}) {
  return checkCardConditions(ability.conditions, owner, context);
}

function checkCardConditions(conditions = [], owner, context = {}) {
  return (conditions || []).every((condition) => checkCondition(condition, owner, context));
}

function hasBuddyOnField(player) {
  return zones.some((zone) => {
    const card = player.field[zone];
    return card && player.buddy && card.name === player.buddy.name;
  });
}

// 「○○がいるとして扱う」系: 場のカードが countsAsFieldMonster を宣言していれば、
// 仮想モンスター(card風オブジェクト)として返す。場の在否を問う条件（presence/count）のみが参照し、
// 対象選択や継続バフ（実カードを要する処理）には含めない。
function phantomFieldMonsters(player) {
  if (!player) {
    return [];
  }
  const phantoms = [];
  zones.forEach((zone) => {
    const spec = player.field[zone]?.countsAsFieldMonster;
    if (!spec) {
      return;
    }
    (Array.isArray(spec) ? spec : [spec]).forEach((entry) => {
      phantoms.push({
        type: "monster",
        currentType: "monster",
        attributes: entry.attributes || (entry.attribute ? [entry.attribute] : []),
        size: entry.size || 0,
        power: entry.power || 0,
        critical: entry.critical || 0,
        defense: entry.defense || 0,
        name: entry.name || `${player.field[zone].name}(扱い)`,
        __phantom: true,
      });
    });
  });
  return phantoms;
}

function checkCondition(condition, owner, context = {}) {
  const player = state.players[owner];
  const opponent = state.players[1 - owner];
  if (condition.op === "all") {
    return (condition.conditions || []).every((child) => checkCondition(child, owner, context));
  }
  if (condition.op === "any") {
    return (condition.conditions || []).some((child) => checkCondition(child, owner, context));
  }
  if (condition.op === "not") {
    return !checkCondition(condition.condition || {}, owner, context);
  }
  if (condition.op === "confirmPrompt") {
    // メタ的な自己申告条件（例: ギャラホルンの「君が小学生なら」）を確認ポップアップで判定。
    // 何度も評価されると複数回ポップアップするため、ability.conditions ではなく script の ifCondition 内で使うこと。
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      return Boolean(window.confirm(condition.prompt || "この効果を使いますか？"));
    }
    return Boolean(condition.default);
  }
  if (condition.op === "cardCount" || condition.op === "cardCountGte" || condition.op === "cardCountLte") {
    // 汎用枚数条件: controller(self/opponent/both) × pile(field/center/item/drop/hand/deck/gauge/soul) × filter × distinct × cmp
    const cmp = condition.cmp || (condition.op === "cardCountLte" ? "lte" : "gte");
    const sides = condition.controller === "opponent" ? [opponent]
      : condition.controller === "both" ? [player, opponent] : [player];
    const pile = condition.pile || "field";
    let cards = [];
    sides.forEach((pl) => {
      if (!pl) return;
      if (pile === "field") cards.push(...zones.map((z) => pl.field[z]).filter(Boolean), ...phantomFieldMonsters(pl));
      else if (pile === "center" || pile === "item") { if (pl.field[pile]) cards.push(pl.field[pile]); }
      else if (pile === "soul") cards.push(...zones.flatMap((z) => pl.field[z]?.soul || []));
      else cards.push(...(pl[pile] || []));
    });
    if (condition.excludeSource && context.card) {
      cards = cards.filter((c) => c.instanceId !== context.card.instanceId);
    }
    const matched = cards.filter((c) => matchesCardFilter(c, condition.filter || {}));
    const n = condition.distinct === "distinctByName"
      ? new Set(matched.map((c) => c.name)).size
      : matched.length;
    const amount = condition.amount || 1;
    return cmp === "lte" ? n <= amount : cmp === "eq" ? n === amount : n >= amount;
  }
  if (condition.op === "attackingAlone") {
    return getPendingAttackers().length === 1;
  }
  if (condition.op === "targetMatches") {
    const ref = condition.ref ? resolveEffectReference(condition.ref, context) : context.target;
    return Boolean(ref?.card && matchesCardFilter(ref.card, condition.filter || {}));
  }
  if (condition.op === "turnOwnerIsSelf") {
    return (context.turnOwner ?? state.active) === owner;
  }
  if (condition.op === "turnOwnerIsOpponent") {
    return (context.turnOwner ?? state.active) !== owner;
  }
  if (condition.op === "phaseIs") {
    return (state.pendingAction?.phase || state.phase) === condition.phase;
  }
  if (condition.op === "lifeLte") {
    return player.life <= condition.amount;
  }
  if (condition.op === "opponentLifeLte") {
    return opponent.life <= condition.amount;
  }
  if (condition.op === "ownCenterEmpty") {
    return !player.field.center;
  }
  if (condition.op === "ownCenterHasAttribute") {
    return Boolean(player.field.center?.attributes?.includes(condition.attribute));
  }
  if (condition.op === "bothCentersEmpty") {
    return !player.field.center && !opponent.field.center;
  }
  if (condition.op === "opponentCenterEmpty") {
    return !opponent.field.center;
  }
  if (condition.op === "ownDropCardCountGte") {
    return player.drop.filter((card) => matchesCardFilter(card, condition.filter || {})).length >= (condition.amount || 1);
  }
  if (condition.op === "sourceZoneIn") {
    const sourceZone = context.zone ?? state.selected?.zone;
    const sourceOwner = context.owner ?? state.selected?.owner;
    return sourceOwner === owner && condition.zones?.includes(sourceZone);
  }
  if (condition.op === "sourceStanding") {
    const source = context.card || getSelectedCard();
    return Boolean(source && !source.used);
  }
  if (condition.op === "sourceSoulHasAttribute") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).some((card) => card.attributes?.includes(condition.attribute));
  }
  if (condition.op === "sourceSoulCountGte") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).length >= condition.amount;
  }
  if (condition.op === "sourceSoulHasSameSizeAsEntered") {
    const source = context.card || getSelectedCard();
    return (source?.soul || []).some((card) => (card.size || 0) === (context.enteredCard?.size || 0));
  }
  if (condition.op === "hostMatches") {
    return Boolean(
      context.hostCard &&
        matchesTargetFilter(
          context.hostCard,
          context.hostOwner ?? owner,
          context.hostZone,
          condition.filter || {},
        ),
    );
  }
  if (condition.op === "enteredCardMatches") {
    if (condition.excludeSource && context.enteredCard?.instanceId === context.card?.instanceId) {
      return false;
    }
    // sameInstanceAsSource 等の相対キー(設置時の自己限定など)を解釈するため relative 版で評価。
    return Boolean(context.enteredCard && matchesRelativeCardFilter(context.enteredCard, condition.filter || {}, context));
  }
  if (condition.op === "enteredZoneIn") {
    return condition.zones?.includes(context.enteredZone);
  }
  if (condition.op === "ownFieldMonsterAttributeSizeGte") {
    const real = fieldZones.some((zone) => {
      const card = player.field[zone];
      return (
        card &&
        effectiveCardType(card) === "monster" &&
        card.attributes?.includes(condition.attribute) &&
        (card.size || 0) >= condition.size
      );
    });
    return (
      real ||
      phantomFieldMonsters(player).some(
        (p) => p.attributes.includes(condition.attribute) && (p.size || 0) >= condition.size,
      )
    );
  }
  if (condition.op === "ownFieldHasBuddy") {
    return hasBuddyOnField(player);
  }
  if (condition.op === "buddyMatches") {
    // 登録バディモンスター（場の有無に関係なく）がフィルタに一致するか。
    return Boolean(player?.buddy && matchesCardFilter(player.buddy, condition.filter || {}));
  }
  if (condition.op === "ownFieldHasAttribute") {
    return (
      zones.some((zone) => player.field[zone]?.attributes?.includes(condition.attribute)) ||
      phantomFieldMonsters(player).some((p) => p.attributes.includes(condition.attribute))
    );
  }
  if (condition.op === "ownHandCountGte") {
    return player.hand.length >= condition.amount;
  }
  if (condition.op === "ownFieldCardExists") {
    const candidateZones = condition.zones || zones;
    return (
      candidateZones.some((zone) => {
        const card = player.field[zone];
        return card && matchesTargetFilter(card, owner, zone, condition.filter || {});
      }) ||
      // zones を限定していない（場全体を問う）場合のみ仮想モンスターも参照する
      (!condition.zones && phantomFieldMonsters(player).some((p) => matchesCardFilter(p, condition.filter || {})))
    );
  }
  if (condition.op === "ownOtherFieldCardExists") {
    const candidateZones = condition.zones || zones;
    return candidateZones.some((zone) => {
      const card = player.field[zone];
      return (
        card &&
        card.instanceId !== context.card?.instanceId &&
        matchesTargetFilter(card, owner, zone, condition.filter || {})
      );
    });
  }
  if (condition.op === "ownFieldCardCountGte") {
    const candidateZones = condition.zones || zones;
    return candidateZones.filter((zone) => {
      const card = player.field[zone];
      return card && matchesTargetFilter(card, owner, zone, condition.filter || {});
    }).length >= condition.amount;
  }
  if (condition.op === "opponentFieldCardCountLte") {
    const candidateZones = condition.zones || zones;
    return candidateZones.filter((zone) => {
      const card = opponent.field[zone];
      return card && matchesTargetFilter(card, 1 - owner, zone, condition.filter || {});
    }).length <= condition.amount;
  }
  if (condition.op === "ownDropAttributeCountGte") {
    return player.drop.filter((card) => card.attributes?.includes(condition.attribute)).length >= condition.amount;
  }
  if (condition.op === "ownDropDistinctAttributeCountGte") {
    const names = new Set(
      player.drop
        .filter((card) => card.attributes?.includes(condition.attribute))
        .map((card) => card.name),
    );
    return names.size >= condition.amount;
  }
  if (condition.op === "ownDropHasCardName") {
    return player.drop.some((card) => card.name === condition.name);
  }
  if (condition.op === "ownDropHasCard") {
    return player.drop.some((card) => matchesCardFilter(card, condition.filter || {}));
  }
  if (condition.op === "ownDropDistinctCardCountGte") {
    const names = new Set(
      player.drop
        .filter((card) => matchesCardFilter(card, condition.filter || {}))
        .map((card) => card.name),
    );
    return names.size >= condition.amount;
  }
  if (condition.op === "recentLifeLinkMatches") {
    return Boolean(findRecentLifeLinkEvent(owner, condition));
  }
  if (["specialCallOpportunityMatches", "temporaryCallOpportunityMatches"].includes(condition.op)) {
    return Boolean(findSpecialCallOpportunity(owner, condition));
  }
  if (condition.op === "movedToDropHasSameSizeAsEntered") {
    return (context.movedToDrop || []).some((card) => (card.size || 0) === (context.enteredCard?.size || 0));
  }
  if (condition.op === "opponentHandCountLte") {
    return opponent.hand.length <= condition.amount;
  }
  if (condition.op === "opponentHandCountGte") {
    return opponent.hand.length >= condition.amount;
  }
  if (condition.op === "damageSourceMatches") {
    return Boolean(context.damageSource?.card && matchesCardFilter(context.damageSource.card, condition.filter || {}));
  }
  if (condition.op === "eventCardMatches") {
    const eventCard = context.eventCard?.card || context.destroyedCard || context.enteredCard;
    return Boolean(eventCard && matchesCardFilter(eventCard, condition.filter || {}));
  }
  if (condition.op === "eventCardInFrontOfSource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        context.eventOwner !== sourceSlot.owner &&
        context.eventZone === oppositeFieldZone(sourceSlot.zone),
    );
  }
  if (condition.op === "pendingAttackByOpponentItem") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && effectiveCardType(attacker.card) === "item",
    );
  }
  if (condition.op === "pendingAttackByOpponentMonster") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && effectiveCardType(attacker.card) === "monster",
    );
  }
  if (condition.op === "pendingAttackByOpponentCardMatches") {
    return getPendingAttackers().some(
      (attacker) => attacker.owner !== owner && matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "pendingAttackBySource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        getPendingAttackers().some((attacker) => sameSlot(attacker, sourceSlot)),
    );
  }
  if (condition.op === "pendingAttackIncludesOtherMatching") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return getPendingAttackers().some(
      (attacker) =>
        (!sourceSlot || !sameSlot(attacker, sourceSlot)) &&
        matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "pendingAttackTargetMatches") {
    const target = getPendingBattleTargetInfo(state.pendingAttack);
    return Boolean(target?.card && matchesTargetFilter(target.card, target.owner, target.zone, condition.filter || {}));
  }
  if (condition.op === "linkAttackWithBuddy") {
    const attack = context.attack || state.pendingAttack;
    const attackers = (attack?.attackers || [])
      .map((slot) => ({ ...slot, card: state.players[slot.owner]?.field?.[slot.zone] }))
      .filter(({ card }) => card);
    return (
      attackers.length > 1 &&
      attackers.some(({ owner: attackerOwner, card }) => card.name === state.players[attackerOwner]?.buddy?.name)
    );
  }
  if (condition.op === "pendingActionIsOpponent") {
    return Boolean(state.pendingAction && state.pendingAction.owner !== owner);
  }
  if (condition.op === "pendingActionKind") {
    return state.pendingAction?.kind === condition.kind;
  }
  if (condition.op === "pendingActionCardType") {
    return Boolean(state.pendingAction?.card && effectiveCardType(state.pendingAction.card) === condition.cardType);
  }
  if (condition.op === "pendingActionCardSizeLte") {
    return (state.pendingAction?.card?.size || 0) <= condition.amount;
  }
  if (condition.op === "pendingAttackTargetIs") {
    return state.pendingAttack?.targetType === condition.targetType;
  }
  if (condition.op === "pendingAttackTargetZone") {
    return state.pendingAttack?.targetZone === condition.zone;
  }
  if (condition.op === "pendingAttackNotLink") {
    return Boolean(state.pendingAttack && (state.pendingAttack.attackers?.length || 0) <= 1);
  }
  if (condition.op === "pendingAttackIsLink") {
    return Boolean(state.pendingAttack && (state.pendingAttack.attackers?.length || 0) > 1);
  }
  if (condition.op === "pendingAttackTargetIsSource") {
    const sourceSlot = findFieldCardSlot(context.card || getSelectedCard());
    return Boolean(
      sourceSlot &&
        state.pendingAttack &&
        state.pendingAttack.targetOwner === sourceSlot.owner &&
        state.pendingAttack.targetZone === sourceSlot.zone,
    );
  }
  if (condition.op === "pendingAttackDefenderIsSelf") {
    return state.pendingAttack?.defender === owner;
  }
  if (condition.op === "lastDamageSourceMatches") {
    const event = state.counterEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    const sources = event.sources || (event.source ? [event.source] : []);
    return sources.some((source) => {
      if (condition.controller === "self" && source.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && source.owner === owner) {
        return false;
      }
      return Boolean(source.card && matchesCardFilter(source.card, condition.filter || {}));
    });
  }
  if (condition.op === "damageDealtThisTurnMatches") {
    // このターン中にダメージを与えた発生源を見る（応答ウィンドウが閉じても残る lastDamageEvent を参照）。
    // 竜撃奥義 デュアル・ムービングフォース（必殺技＝ファイナルフェイズで使用）が
    // 「武器がダメージを与えたターン中」を判定するために使う。
    const event = state.lastDamageEvent;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    const sources = event.sources || (event.source ? [event.source] : []);
    return sources.some((source) => {
      if (condition.controller === "self" && source.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && source.owner === owner) {
        return false;
      }
      return Boolean(source.card && matchesCardFilter(source.card, condition.filter || {}));
    });
  }
  if (condition.op === "lastEnteredCardMatches") {
    const event = state.enteredEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    return (event.entries || []).some((entry) => {
      if (condition.controller === "self" && entry.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && entry.owner === owner) {
        return false;
      }
      if (condition.zone && entry.zone !== condition.zone) {
        return false;
      }
      return Boolean(entry.card && matchesCardFilter(entry.card, condition.filter || {}));
    });
  }
  if (condition.op === "eventAttackersMatch") {
    return (context.attackers || []).some(
      (attacker) => attacker?.card && matchesCardFilter(attacker.card, condition.filter || {}),
    );
  }
  if (condition.op === "sourceSoulCountGte") {
    return (context.card?.soul || []).length >= (condition.amount || 1);
  }
  if (condition.op === "lastDestroyedCardMatches") {
    const event = state.destroyedEventWindow;
    if (!event || event.turnCount !== state.turnCount) {
      return false;
    }
    return (event.entries || []).some((entry) => {
      if (condition.controller === "self" && entry.owner !== owner) {
        return false;
      }
      if (condition.controller === "opponent" && entry.owner === owner) {
        return false;
      }
      return Boolean(entry.card && matchesCardFilter(entry.card, condition.filter || {}));
    });
  }
  if (condition.op === "hasArrival") {
    return Boolean(player.arrivalCardId);
  }
  if (condition.op === "ownItemHasAttribute") {
    return Boolean(player.field.item?.attributes?.includes(condition.attribute));
  }
  if (condition.op === "ownItemStanding") {
    return Boolean(player.field.item && !player.field.item.used);
  }
  return true;
}

async function runTriggeredAbilities(card, event, baseContext = {}) {
  const triggeredAbilities = (card.abilities || []).filter(
    (ability) => ability.kind === "triggered" && ability.event === event,
  );
  for (const ability of triggeredAbilities) {
      const owner = baseContext.owner ?? findFieldCardSlot(card)?.owner;
      if (owner === undefined || owner === null) {
        continue;
      }
      const context = {
        ...baseContext,
        card,
        ability,
        player: state.players[owner],
        owner,
        zone: baseContext.zone ?? findFieldCardSlot(card)?.zone,
      };
      if (
        ability.target &&
        !context.target &&
        !ability.allowMissingTarget &&
        targetCandidatesFromSpecForOwner(ability.target, owner, { card, ability }).length === 0
      ) {
        continue;
      }
      if (isAbilityLimitUsed(owner, card, ability) || !checkAbilityConditions(ability, owner, context)) {
        continue;
      }
      const player = state.players[owner];
      const costContext = {
        sourceCard: card,
        selectedCard: card,
        allowInteractiveSelection: true,
      };
      const canPay = canPayStructuredCost(player, ability.cost || [], costContext);
      if (!canPay.ok) {
        if (!ability.optional) {
          addLog(canPay.reason);
        }
        continue;
      }
      if (!(await shouldUseOptionalAbility(card, ability))) {
        addLog(`${card.name}の任意能力を使いませんでした。`);
        continue;
      }
      if (ability.target && !context.target && !Array.isArray(ability.script)) {
        context.target = await chooseAbilityTarget(card, ability, owner);
        if (!context.target && !ability.allowMissingTarget) {
          addLog(`${card.name}の対象が選ばれなかったため、能力を解決しませんでした。`);
          continue;
        }
      }
      const payment = await payStructuredCostWithSelection(player, ability.cost || [], costContext);
      if (!payment.ok) {
        addLog(ability.optional ? `${card.name}の任意能力を使いませんでした。` : payment.reason);
        continue;
      }
      context.player = player;
      await executeAbilityBody(context);
      markAbilityLimit(owner, card, ability);
    }
}

async function chooseAbilityTarget(card, ability, owner) {
  const candidates = targetCandidatesFromSpecForOwner(ability.target, owner, { card, ability });
  if (candidates.length === 0) {
    return null;
  }
  const selected = await chooseCardEntries(candidates, {
    title: `${card.name}の対象`,
    lead: "効果の対象にするカードを選んでください。",
    min: 1,
    max: 1,
    forceDialog: true,
  });
  const target = selected?.[0];
  return target ? { owner: target.owner, zone: target.zone, card: target.card } : null;
}

async function shouldUseOptionalAbility(card, ability) {
  if (!ability.optional) {
    return true;
  }
  const selected = await chooseCardEntries(
    [
      {
        key: "use",
        card: {
          name: "使う",
          rules: [`${card.name}の任意能力を使います。`],
          attributes: [],
          keywords: [],
          costs: {},
        },
      },
      {
        key: "skip",
        card: {
          name: "使わない",
          rules: [`${card.name}の任意能力を使いません。`],
          attributes: [],
          keywords: [],
          costs: {},
        },
      },
    ],
    {
      title: `${card.name}の任意能力`,
      lead: "この能力を使いますか？",
      min: 1,
      max: 1,
      forceDialog: true,
    },
  );
  return selected?.[0]?.key === "use";
}

async function executeAbilityBody(context) {
  const ability = context.ability || {};
  if (Array.isArray(ability.script) && ability.script.length > 0) {
    return executeAbilityScript(ability.script, context);
  }
  const legacyScript = legacyAbilityScriptDefinition(ability.handler);
  if (legacyScript) {
    return executeAbilityScript(legacyScript, {
      ...context,
      ability: {
        ...ability,
        script: legacyScript,
      },
    });
  }
  const handler = ability.handler ? abilityHandlers[ability.handler] : null;
  if (ability.handler && !handler) {
    addLog(`未実装の効果ハンドラです: ${ability.handler}`);
    return false;
  }
  if (handler) {
    await handler(context);
    return true;
  }
  await executeAbilityEffects(ability.effects || [], context);
  return true;
}

async function executeAbilityScript(script, context) {
  const scriptContext = {
    ...context,
    vars: {
      ...(context.vars || {}),
    },
  };
  recordDiagnosticEvent("effect_script", {
    stage: "start",
    card: compactCardForLog(context.card),
    abilityId: context.ability?.id || "",
    stepCount: script.length,
  });
  for (const [index, step] of script.entries()) {
    recordDiagnosticEvent("effect_script", {
      stage: "step",
      index,
      op: step.op,
      var: step.var || "",
      card: compactCardForLog(context.card),
      abilityId: context.ability?.id || "",
    });
    const result = await executeAbilityScriptStep(step, scriptContext);
    if (result === false || result?.ok === false) {
      recordDiagnosticEvent("effect_script", {
        stage: "stopped",
        index,
        op: step.op,
        reason: result?.reason || "script_step_failed",
        card: compactCardForLog(context.card),
        abilityId: context.ability?.id || "",
      });
      context.vars = scriptContext.vars;
      return false;
    }
  }
  context.vars = scriptContext.vars;
  recordDiagnosticEvent("effect_script", {
    stage: "complete",
    card: compactCardForLog(context.card),
    abilityId: context.ability?.id || "",
  });
  return true;
}

function canSatisfyAbilityScript(card, ability, owner, baseContext = {}) {
  const script = Array.isArray(ability?.script) && ability.script.length > 0
    ? ability.script
    : legacyAbilityScriptDefinition(ability?.handler);
  if (!Array.isArray(script) || script.length === 0) {
    return true;
  }
  const context = {
    ...baseContext,
    card,
    ability,
    player: state.players[owner],
    owner,
    vars: {},
  };
  return canSatisfyScriptSteps(script, context);
}

function canSatisfyScriptSteps(script, context) {
  return (script || []).every((step) => {
    if (step.op === "selectCards") {
      const candidates = groupScriptCandidates(scriptCardSelectionCandidates(step, context), step);
      const amount = step.amount ?? 1;
      const allowEmpty = Boolean(step.allowEmpty && candidates.length === 0);
      const min = allowEmpty ? 0 : step.min ?? (step.require === false ? 0 : amount);
      return candidates.length >= min;
    }
    return true;
  });
}

async function executeAbilityScriptStep(step, context) {
  if (step.op === "selectCards") {
    return selectCardsForScript(step, context);
  }
  if (step.op === "moveSelected") {
    return moveSelectedForScript(step, context);
  }
  if (step.op === "moveSelectedGroup") {
    return moveSelectedGroupForScript(step, context);
  }
  if (step.op === "ifSelection") {
    return ifSelectionForScript(step, context);
  }
  if (step.op === "ifTargetController") {
    return ifTargetControllerForScript(step, context);
  }
  if (step.op === "ifCondition") {
    return ifConditionForScript(step, context);
  }
  if (step.op === "chooseBranch") {
    return chooseBranchForScript(step, context);
  }
  if (step.op === "moveSelectedToDeckBottomOrdered") {
    return moveSelectedToDeckBottomOrderedForScript(step, context);
  }
  if (step.op === "payCost") {
    return payCostForScript(step, context);
  }
  if (step.op === "destroySelected") {
    return destroySelectedForScript(step, context);
  }
  if (step.op === "grantKeywordSelected") {
    return grantKeywordSelectedForScript(step, context);
  }
  if (step.op === "modifySelectedStats") {
    return modifySelectedStatsForScript(step, context);
  }
  if (step.op === "restSelected") {
    return restSelectedForScript(step, context);
  }
  if (step.op === "putSelectedToGauge") {
    return putSelectedToGaugeForScript(step, context);
  }
  if (step.op === "dropSelectedSoul") {
    return dropSelectedSoulForScript(step, context);
  }
  if (step.op === "discardSelfSoul") {
    return discardSelfSoulForScript(step, context);
  }
  if (step.op === "moveSoulToDrop") {
    return moveSoulToDropForScript(step, context);
  }
  if (step.op === "payCardCostForSelection") {
    return payCardCostForScriptSelection(step, context);
  }
  if (step.op === "useSelectedCardAbility") {
    return useSelectedCardAbilityForScript(step, context);
  }
  if (step.op === "useSelectedCard") {
    return useSelectedCardForScript(step, context);
  }
  if (step.op === "useTopDeckCardIfMatchesElseBottom") {
    return useTopDeckCardIfMatchesElseBottomForScript(step, context);
  }
  if (step.op === "selectZone") {
    return selectZoneForScript(step, context);
  }
  if (step.op === "callSelected") {
    return callSelectedForScript(step, context);
  }
  if (step.op === "callSelfFromHand") {
    return callSelfFromHandForScript(step, context);
  }
  if (step.op === "callSelectedAsMonster") {
    return callSelectedAsMonsterForScript(step, context);
  }
  if (step.op === "callSelectedToEmptyZones") {
    return callSelectedToEmptyZonesForScript(step, context);
  }
  if (step.op === "stackCallSelected") {
    return stackCallSelectedForScript(step, context);
  }
  if (step.op === "placeSelected") {
    return placeSelectedForScript(step, context);
  }
  if (step.op === "shuffleDeck") {
    return shuffleDeckForScript(step, context);
  }
  if (step.op === "stopUnlessMovedToDropMatches") {
    return stopUnlessMovedToDropMatchesForScript(step, context);
  }
  if (step.op === "log") {
    addLog(interpolateScriptMessage(step.message || "", context));
    return true;
  }
  if (isScriptEffectStep(step)) {
    await executeAbilityEffect(step, context);
    return true;
  }
  addLog(`未実装のscript命令です: ${step.op}`);
  return { ok: false, reason: `unknown_script_op:${step.op}` };
}

async function selectCardsForScript(step, context) {
  const rawCandidates = scriptCardSelectionCandidates(step, context);
  const candidates = groupScriptCandidates(rawCandidates, step);
  const amount = step.amount ?? 1;
  const allowEmpty = Boolean(step.allowEmpty && candidates.length === 0);
  const min = allowEmpty ? 0 : step.min ?? (step.require === false ? 0 : amount);
  let max = step.max ?? amount;
  if (step.maxByEmptyFieldZones) {
    max = Math.min(max, fieldZones.filter((zone) => !context.player.field[zone]).length);
  }
  recordDiagnosticEvent("effect_script", {
    stage: "select_candidates",
    op: step.op,
    var: step.var,
    from: step.from,
    candidateCount: candidates.length,
    candidates: candidates.map(compactChoiceForLog),
    card: compactCardForLog(context.card),
  });
  if (candidates.length < min) {
    context.vars[step.var] = [];
    addLog(step.emptyMessage || `${context.card.name}で選べるカードがありません。`);
    return step.require === false ? true : { ok: false, reason: "not_enough_candidates" };
  }
  if (allowEmpty) {
    context.vars[step.var] = [];
    if (step.emptyMessage) {
      addLog(step.emptyMessage);
    }
    return true;
  }
  const selected = await chooseCardEntries(candidates, {
    title: step.title || `${context.card.name}の選択`,
    lead: step.lead || `${min}枚選んでください。`,
    min,
    max,
    forceDialog: step.forceDialog !== false,
  });
  if (!selected || selected.length < min) {
    context.vars[step.var] = [];
    addLog(step.cancelMessage || `${context.card.name}のカードを選んでください。`);
    return step.require === false ? true : { ok: false, reason: "selection_cancelled" };
  }
  context.vars[step.var] = selected;
  return true;
}

function groupScriptCandidates(candidates, step) {
  if (!step.groupBy) {
    return candidates;
  }
  const groups = new Map();
  candidates.forEach((entry) => {
    const key = scriptGroupKey(entry.card, step.groupBy);
    if (!key) {
      return;
    }
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  });
  const requiredSize = step.groupSizeGte || 1;
  return [...groups.entries()]
    .filter(([, group]) => group.length >= requiredSize)
    .map(([key, group]) => ({
      ...group[0],
      group,
      note: step.note || `${key} ${group.length}枚`,
    }));
}

function scriptGroupKey(card, groupBy) {
  if (groupBy === "name") {
    return card.name;
  }
  if (groupBy === "id") {
    return card.id;
  }
  return card[groupBy];
}

function scriptCardSelectionCandidates(step, context) {
  const from = step.from || "field";
  if (from === "pendingAttackers") {
    return getPendingAttackers()
      .filter((entry) =>
        scriptControllerMatches(step.controller, entry.owner, context.owner) &&
          scriptCardMatches(entry.card, entry.owner, entry.zone, step, context),
      )
      .map((entry) => ({
        ...entry,
        source: "field",
        note: step.note || zoneLabel(entry.zone),
      }));
  }
  if (from === "movedToDrop") {
    const movedEntries = context.movedToDropEntries || (context.movedToDrop || []).map((card) => ({
      owner: context.owner,
      card,
    }));
    return movedEntries
      .filter((entry) => scriptControllerMatches(step.controller, entry.owner, context.owner))
      .map((entry) => {
        const pile = state.players[entry.owner]?.drop || [];
        const index = pile.findIndex((card) => card.instanceId === entry.card?.instanceId);
        return index >= 0 ? { ...entry, index, source: "drop", note: step.note || scriptSourceLabel("drop") } : null;
      })
      .filter((entry) => entry && scriptCardMatches(entry.card, entry.owner, null, step, context));
  }
  if (from === "field") {
    return allFieldTargets((card, owner, zone) =>
      scriptControllerMatches(step.controller, owner, context.owner) &&
        scriptCardMatches(card, owner, zone, step, context),
    ).map((entry) => ({
      ...entry,
      source: "field",
      note: step.note || zoneLabel(entry.zone),
    }));
  }
  const candidates = [];
  for (const owner of scriptOwnersForController(step.controller || "self", context.owner)) {
    const pile = scriptPileForSource(owner, from, context);
    if (!pile) {
      continue;
    }
    pile.forEach((card, index) => {
      if (!scriptCardMatches(card, owner, null, step, context)) {
        return;
      }
      candidates.push({
        card,
        index,
        owner,
        source: from,
        sourceCard: from === "soul" ? context.card : null,
        note: step.note || scriptSourceLabel(from),
      });
    });
  }
  return candidates;
}

function scriptCardMatches(card, owner, zone, step, context) {
  if (!card) {
    return false;
  }
  if (step.excludeSource === true && card.instanceId === context.card?.instanceId) {
    return false;
  }
  if (!matchesCardFilter(card, step.filter || {})) {
    return false;
  }
  if (step.callable && !isCallableMonster(card)) {
    return false;
  }
  if (step.callable && !checkCardConditions(card.callConditions, owner)) {
    return false;
  }
  if (step.canUseForFlag && !canUseCardForFlag(state.players[owner], card)) {
    return false;
  }
  if (step.canPayCost) {
    const payment = canPayCardCost(state.players[owner], card, step.canPayCost, card, {
      sourceCard: card,
      allowInteractiveSelection: true,
    });
    if (!payment.ok) {
      return false;
    }
  }
  if (step.zone && zone !== step.zone) {
    return false;
  }
  return true;
}

function scriptControllerMatches(controller = "self", owner, contextOwner) {
  if (controller === "any") {
    return true;
  }
  if (controller === "opponent") {
    return owner !== contextOwner;
  }
  return owner === contextOwner;
}

function scriptOwnersForController(controller = "self", contextOwner) {
  if (controller === "any") {
    return [0, 1];
  }
  if (controller === "opponent") {
    return [1 - contextOwner];
  }
  return [contextOwner];
}

function scriptPileForSource(owner, from, context) {
  if (from === "soul") {
    return context.card?.soul || [];
  }
  return state.players[owner]?.[from] || null;
}

function scriptSourceLabel(from) {
  return {
    hand: "手札",
    drop: "ドロップ",
    deck: "デッキ",
    gauge: "ゲージ",
    soul: "ソウル",
    field: "場",
  }[from] || from;
}

function scriptSelection(step, context) {
  const key = step.var || step.selection || step.cardVar;
  if (key === "$target" && context.target?.card) {
    return [{ ...context.target, source: "field" }];
  }
  const selected = context.vars?.[key];
  if (!selected) {
    return [];
  }
  return Array.isArray(selected) ? selected : [selected];
}

function takeScriptSelectionCards(selection) {
  const movedCards = [];
  for (const entry of [...selection].sort((left, right) => (right.index ?? 0) - (left.index ?? 0))) {
    if (entry.source === "field") {
      const card = detachFieldCardForMove(entry.owner, entry.zone, entry.card);
      if (card) {
        movedCards.unshift({ ...entry, card });
      }
      continue;
    }
    const pile = scriptPileForSource(entry.owner, entry.source, { card: entry.sourceCard });
    if (!pile) {
      continue;
    }
    const currentIndex =
      pile[entry.index]?.instanceId === entry.card.instanceId
        ? entry.index
        : pile.findIndex((card) => card.instanceId === entry.card.instanceId);
    if (currentIndex >= 0) {
      movedCards.unshift({ ...entry, card: pile.splice(currentIndex, 1)[0] });
    }
  }
  return movedCards;
}

function detachFieldCardForMove(owner, zone, expectedCard = null) {
  const player = state.players[owner];
  const card = player?.field?.[zone];
  if (!card || (expectedCard && card.instanceId !== expectedCard.instanceId)) {
    return null;
  }
  player.drop.push(...(card.soul || []));
  card.soul = [];
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, owner);
  return card;
}

function moveSelectedForScript(step, context) {
  if (step.to === "deckBottom" && step.order === "choose") {
    return moveSelectedToDeckBottomOrderedForScript(step, context);
  }
  const movedEntries = takeScriptSelectionCards(scriptSelection(step, context));
  if (movedEntries.length === 0) {
    addLog(step.emptyMessage || `${context.card.name}で動かすカードがありません。`);
    return step.require === false ? true : { ok: false, reason: "no_selected_cards" };
  }
  for (const entry of movedEntries) {
    const destinationOwner = scriptMoveDestinationOwner(step, entry, context);
    moveScriptCardToDestination(entry.card, step.to, destinationOwner, context);
  }
  if (step.log === "discard") {
    addLog(`${context.player.name}は${context.card.name}の効果で${movedEntries.map((entry) => entry.card.name).join("、")}を捨てました。`);
  } else if (step.log) {
    addLog(step.log.replace("{cards}", movedEntries.map((entry) => entry.card.name).join("、")));
  }
  return true;
}

function moveSelectedGroupForScript(step, context) {
  const selected = scriptSelection(step, context);
  const movedEntries = [];
  selected.forEach((entry) => {
    const group = entry.group || [entry];
    const amount = Math.min(step.amount || group.length, group.length);
    movedEntries.push(...takeScriptSelectionCards(group.slice(0, amount)));
  });
  if (movedEntries.length === 0) {
    addLog(step.emptyMessage || `${context.card.name}で動かすカードがありません。`);
    return step.require === false ? true : { ok: false, reason: "no_selected_group_cards" };
  }
  for (const entry of movedEntries) {
    const destinationOwner = scriptMoveDestinationOwner(step, entry, context);
    moveScriptCardToDestination(entry.card, step.to, destinationOwner, context);
  }
  if (step.log) {
    addLog(step.log.replace("{cards}", movedEntries.map((entry) => entry.card.name).join("、")));
  }
  return true;
}

async function ifSelectionForScript(step, context) {
  const selected = scriptSelection(step, context);
  const branch = selected.length > 0 ? step.then : step.else;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

async function ifTargetControllerForScript(step, context) {
  const targetOwner = context.target?.owner;
  const matches =
    step.controller === "any" ||
    (step.controller === "self" && targetOwner === context.owner) ||
    (step.controller === "opponent" && targetOwner === 1 - context.owner);
  const branch = matches ? step.then : step.else;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

async function ifConditionForScript(step, context) {
  const matches = checkCondition(step.condition || {}, context.owner, context);
  const branch = matches ? step.then : step.else;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

async function chooseBranchForScript(step, context) {
  const options = (Array.isArray(step.options) ? step.options : []).filter(
    (option) =>
      (!option.condition || checkCondition(option.condition, context.owner, context)) &&
      canPayScriptBranchCosts([{ op: "payCost", cost: option.canPayCost || [] }], context) &&
      canPayScriptBranchCosts(option.script || [], context),
  );
  if (options.length === 0) {
    if (step.emptyMessage) {
      addLog(step.emptyMessage);
    }
    return true;
  }
  const selected = await chooseCardEntries(
    options.map((option) => ({
      option,
      card: {
        name: option.label || option.key,
        rules: option.description ? [option.description] : [],
        type: "choice",
      },
      note: option.note || "",
    })),
    {
      title: step.title || `${context.card.name}の効果`,
      lead: step.lead || "解決する効果を選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
    },
  );
  const branch = selected?.[0]?.option?.script;
  if (!Array.isArray(branch) || branch.length === 0) {
    return true;
  }
  return executeAbilityScript(branch, context);
}

function canPayScriptBranchCosts(script, context) {
  return (script || []).every((step) => {
    if (step.op === "payCost") {
      const costSteps = adjustedCostSteps(
        context.player,
        context.card,
        step.purpose || "activated",
        step.cost || [],
      );
      return canPayStructuredCost(context.player, costSteps, {
        sourceCard: context.card,
        selectedCard: context.card,
        allowInteractiveSelection: true,
      }).ok;
    }
    if (Array.isArray(step.then) && !canPayScriptBranchCosts(step.then, context)) {
      return false;
    }
    if (Array.isArray(step.else) && !canPayScriptBranchCosts(step.else, context)) {
      return false;
    }
    return true;
  });
}

async function payCostForScript(step, context) {
  const costSteps = adjustedCostSteps(
    context.player,
    context.card,
    step.purpose || "activated",
    step.cost || [],
  );
  const payment = await payStructuredCostWithSelection(context.player, costSteps, {
    sourceCard: context.card,
    selectedCard: context.card,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return { ok: false, reason: payment.reason || "script_cost_unpaid" };
  }
  context.costPayment = payment;
  return true;
}

async function moveSelectedToDeckBottomOrderedForScript(step, context) {
  const selected = Array.isArray(step.vars)
    ? step.vars.flatMap((varName) => scriptSelection({ var: varName }, context))
    : scriptSelection(step, context);
  const movedEntries = takeScriptSelectionCards(selected);
  if (movedEntries.length === 0) {
    return step.require === false ? true : { ok: false, reason: "no_selected_cards" };
  }
  const owner =
    step.toOwner === "opponent" ? 1 - context.owner :
    step.toOwner === "self" ? context.owner :
    movedEntries[0]?.owner ?? context.owner;
  const player = state.players[owner];
  let remaining = [...movedEntries];
  const ordered = [];
  while (remaining.length > 0) {
    const picked = await chooseCardEntries(remaining, {
      title: step.title || `${context.card.name}のデッキ下順序`,
      lead: `デッキの下から${ordered.length + 1}番目に置くカードを選んでください。`,
      min: 1,
      max: 1,
      forceDialog: true,
    });
    const entry = picked?.[0];
    if (!entry) {
      player.drop.push(...remaining.map((candidate) => candidate.card));
      return { ok: false, reason: "ordered_selection_cancelled" };
    }
    ordered.push(entry.card);
    remaining = remaining.filter((candidate) => candidate.card.instanceId !== entry.card.instanceId);
  }
  player.deck.unshift(...ordered);
  if (step.log) {
    addLog(step.log.replace("{cards}", ordered.map((card) => card.name).join("、")));
  }
  return true;
}

function scriptMoveDestinationOwner(step, entry, context) {
  if (step.toOwner === "self") {
    return context.owner;
  }
  if (step.toOwner === "opponent") {
    return 1 - context.owner;
  }
  return entry.owner ?? context.owner;
}

function moveScriptCardToDestination(card, destination, owner, context) {
  const player = state.players[owner];
  if (destination === "hand") {
    player.hand.push(card);
  } else if (destination === "gauge") {
    player.gauge.push(card);
  } else if (destination === "deck") {
    player.deck.push(card);
  } else if (destination === "deckBottom") {
    player.deck.unshift(card);
  } else if (destination === "soul") {
    context.card.soul ||= [];
    context.card.soul.push(card);
  } else if (destination === "itemSoul") {
    // 君のアイテムのソウルに入れる（アーマナイト・カーリーの“修羅降臨の儀”）
    const item = player.field.item;
    if (item) {
      item.soul ||= [];
      item.soul.push(card);
    } else {
      player.hand.push(card);
    }
  } else {
    player.drop.push(card);
  }
}

function destroySelectedForScript(step, context) {
  const selected = scriptSelection(step, context);
  let destroyedCount = 0;
  for (const entry of selected) {
    if (entry.source !== "field") {
      continue;
    }
    const targetCard = state.players[entry.owner]?.field?.[entry.zone];
    if (!targetCard || targetCard.instanceId !== entry.card.instanceId) {
      continue;
    }
    const destroyedName = targetCard.name;
    const destroyed = destroyFieldCard(entry.owner, entry.zone);
    if (destroyed) {
      destroyedCount += 1;
      addLog(`${context.card.name}の効果で${destroyedName}を破壊しました。`);
    }
  }
  if (destroyedCount === 0 && step.require !== false) {
    return { ok: false, reason: "no_destroyed_cards" };
  }
  return true;
}

function grantKeywordSelectedForScript(step, context) {
  const selected = scriptSelection(step, context);
  selected.forEach((entry) => {
    const card = entry.card;
    if (!card) {
      return;
    }
    if (step.keyword === "counterattack") {
      card.counterattack = true;
    } else if (step.duration === "permanent") {
      card.keywords ||= [];
      if (!card.keywords.includes(step.keyword)) {
        card.keywords.push(step.keyword);
      }
    } else if (step.duration === "turn") {
      card.turnKeywords ||= [];
      card.turnKeywords.push(step.keyword);
    } else {
      card.temporaryKeywords ||= [];
      card.temporaryKeywords.push(step.keyword);
    }
  });
  return true;
}

function modifySelectedStatsForScript(step, context) {
  const selected = scriptSelection(step, context);
  const duration = step.duration || "battle";
  const prefix = duration === "turn" ? "turn" : "battle";
  selected.forEach((entry) => {
    const card = entry.card;
    if (!card) {
      return;
    }
    applyStatBonus(card, prefix, "power", step.power || 0);
    applyStatBonus(card, prefix, "defense", step.defense || 0);
    applyStatBonus(card, prefix, "critical", step.critical || 0);
  });
  return true;
}

async function restSelectedForScript(step, context) {
  for (const entry of scriptSelection(step, context)) {
    if (entry.card) {
      await restFieldCard(entry.owner ?? context.owner, entry.zone, entry.card, { source: context.card });
    }
  }
  return true;
}

function putSelectedToGaugeForScript(step, context) {
  const selected = scriptSelection(step, context);
  selected.forEach((entry) => {
    if (entry.source !== "field") {
      return;
    }
    const ownerPlayer = state.players[entry.owner];
    if (ownerPlayer?.field?.[entry.zone]?.instanceId === entry.card?.instanceId) {
      putFieldCardToGauge(ownerPlayer, entry.zone);
    }
  });
  return true;
}

function dropSelectedSoulForScript(step, context) {
  const selected = scriptSelection(step, context);
  selected.forEach((entry) => {
    const amount = Math.min(step.amount ?? entry.card?.soul?.length ?? 0, entry.card?.soul?.length || 0);
    const movedCards = amount > 0 ? entry.card.soul.splice(0, amount) : [];
    state.players[entry.owner ?? context.owner].drop.push(...movedCards);
    if (movedCards.length > 0 && step.log !== false) {
      addLog(`${entry.card.name}のソウルから${movedCards.map((card) => card.name).join("、")}をドロップゾーンに置きました。`);
    }
  });
  return true;
}

async function discardSelfSoulForScript(step, context) {
  const amount = Math.min(step.amount || 1, context.card?.soul?.length || 0);
  if (amount <= 0) {
    addLog(step.emptyMessage || `${context.card.name}のソウルがありません。`);
    return step.require === false ? true : { ok: false, reason: "missing_soul" };
  }
  const soulEntries = (context.card.soul || []).map((card, index) => ({
    card,
    index,
    owner: context.owner,
    source: "soul",
    note: `${context.card.name}のソウル`,
  }));
  const selected =
    soulEntries.length > amount
      ? await chooseCardEntries(soulEntries, {
          title: `${context.card.name}のソウル選択`,
          lead: `ドロップゾーンに置くソウルを${amount}枚選んでください。`,
          min: amount,
          max: amount,
          forceDialog: true,
        })
      : soulEntries.slice(0, amount);
  const movedCards = removePileEntries(context.card.soul || [], selected || []);
  context.player.drop.push(...movedCards);
  if (step.log !== false) {
    addLog(`${context.card.name}のソウルから${movedCards.map((card) => card.name).join("、")}をドロップゾーンに置きました。`);
  }
  return true;
}

function moveSoulToDropForScript(step, context) {
  const movedCards = context.card?.soul?.splice(0) || [];
  context.player.drop.push(...movedCards);
  context.movedToDrop ||= [];
  context.movedToDrop.push(...movedCards);
  if (movedCards.length > 0 && step.log !== false) {
    addLog(`${context.card.name}のソウルを全てドロップゾーンに置きました。`);
  }
  return true;
}

async function payCardCostForScriptSelection(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}のコストを支払うカードを選んでください。`);
    return { ok: false, reason: "missing_cost_card" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const payment = await payCardCostWithSelection(player, entry.card, step.purpose || "call", entry.card, {
    sourceCard: entry.card,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return { ok: false, reason: payment.reason };
  }
  return true;
}

// 共通: 選択したカード(ドロップ等)を、その種別に応じて「正しく使う」。
//   アイテム → 装備(equipCost を払い equipCardDirect: 装備変更/着任/装備時誘発も通る)
//   『設置』を持つ魔法/必殺技 → 設置ゾーンへ配置(castCost を払い placeSetSpellDirect)
//   それ以外の魔法/必殺技 → その能力を即時解決(useSelectedCardAbility にフォールバック)
// step.payCost:false でコスト支払いを省略可。例: ヴォータンシャドウ(ドロップから装備/設置)。
async function useSelectedCardForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}で使うカードを選んでください。`);
    return { ok: false, reason: "missing_use_card" };
  }
  const owner = entry.owner ?? context.owner;
  const player = state.players[owner];
  const card = entry.card;
  const type = effectiveCardType(card);
  const payCost = step.payCost !== false;
  if (type === "item") {
    if (card.equipConditions && !checkCardConditions(card.equipConditions, owner, { card })) {
      addLog(`${card.name}の装備条件を満たしていません。`);
      return { ok: false, reason: "equip_conditions" };
    }
    if (payCost) {
      const payment = await payCardCostWithSelection(player, card, "equip", card);
      if (!payment.ok) {
        addLog(payment.reason);
        return { ok: false, reason: "cannot_pay_equip" };
      }
    }
    takeScriptSelectionCards([entry]);
    await equipCardDirect(player, card);
    return true;
  }
  if ((type === "spell" || type === "impact") && hasKeyword(card, "set")) {
    const zone = setZones.find((candidate) => !player.field[candidate]);
    if (!zone) {
      addLog("配置魔法ゾーンが空いていません。");
      return { ok: false, reason: "no_set_zone" };
    }
    if (card.uniqueSet && setZones.some((candidate) => player.field[candidate]?.id === card.id)) {
      addLog(`${card.name}はすでに配置されています。`);
      return { ok: false, reason: "already_set" };
    }
    if (payCost) {
      const payment = await payCardCostWithSelection(player, card, "cast", card);
      if (!payment.ok) {
        addLog(payment.reason);
        return { ok: false, reason: "cannot_pay_cast" };
      }
    }
    takeScriptSelectionCards([entry]);
    await placeSetSpellDirect(player, card, zone);
    return true;
  }
  // 通常の魔法/必殺技は能力を即時解決（既存挙動）
  return useSelectedCardAbilityForScript(step, context);
}

async function useSelectedCardAbilityForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}で使うカードを選んでください。`);
    return { ok: false, reason: "missing_selected_ability_card" };
  }
  const usedAbility = (entry.card.abilities || []).find((ability) => {
    if (!canUseAbilityFromScriptSelection(ability, entry)) {
      return false;
    }
    const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
    return abilityTimingIncludes(ability, timing) && checkAbilityConditions(ability, context.owner, {
      ...context,
      card: entry.card,
      ability,
    });
  });
  if (!usedAbility) {
    addLog(`${entry.card.name}は現在のタイミングで使える能力がありません。`);
    return { ok: false, reason: "selected_card_ability_unusable" };
  }
  const target = usedAbility.target ? await chooseAbilityTarget(entry.card, usedAbility, context.owner) : null;
  if (usedAbility.target && !target) {
    return { ok: false, reason: "selected_card_ability_missing_target" };
  }
  const costSteps = adjustedCostSteps(
    context.player,
    entry.card,
    abilityCostPurpose(usedAbility),
    abilityCostSteps(entry.card, usedAbility),
  );
  const payment = await payStructuredCostWithSelection(context.player, costSteps, {
    sourceCard: entry.card,
    selectedCard: entry.card,
  });
  if (!payment.ok) {
    addLog(payment.reason);
    return { ok: false, reason: payment.reason };
  }
  const moved = takeScriptSelectionCards([entry]);
  const usedCard = moved[0]?.card || entry.card;
  await executeAbilityBody({
    ...context,
    card: usedCard,
    ability: usedAbility,
    target,
  });
  context.player.drop.push(usedCard);
  addLog(`${context.card.name}の効果で${usedCard.name}を使いました。`);
  return true;
}

function canUseAbilityFromScriptSelection(ability, entry = {}) {
  if (!ability) {
    return false;
  }
  if (["spell", "impact"].includes(ability.kind)) {
    return !ability.fromFieldOnly;
  }
  if (ability.kind !== "activated") {
    return false;
  }
  if (entry.source === "hand") {
    return Boolean(ability.fromHandOnly);
  }
  if (entry.source === "soul") {
    return Boolean(ability.fromSoulOnly);
  }
  return false;
}

async function useTopDeckCardIfMatchesElseBottomForScript(step, context) {
  const owner = scriptOwnersForController(step.controller || "self", context.owner)[0];
  const player = state.players[owner];
  const topCard = player.deck.pop();
  if (!topCard) {
    declareDeckLoss(player);
    return step.require === false ? true : { ok: false, reason: "deck_empty" };
  }
  if (!matchesCardFilter(topCard, step.filter || {})) {
    player.deck.unshift(topCard);
    addLog(`${context.card.name}で確認した${topCard.name}をデッキの下に置きました。`);
    return true;
  }
  const ability = (topCard.abilities || []).find((candidate) =>
    ["spell", "impact"].includes(candidate.kind) &&
      !candidate.fromFieldOnly &&
      !candidate.fromSoulOnly &&
      abilityTimingIncludes(candidate, state.pendingAttack || state.pendingAction ? "counter" : state.phase) &&
      checkAbilityConditions(candidate, owner, {
        ...context,
        card: topCard,
        ability: candidate,
      }),
  );
  if (!ability) {
    player.deck.unshift(topCard);
    addLog(`${context.card.name}で確認した${topCard.name}は現在使えないためデッキの下に置きました。`);
    return true;
  }
  const target = ability.target ? await chooseAbilityTarget(topCard, ability, owner) : null;
  if (ability.target && !target) {
    player.deck.unshift(topCard);
    return { ok: false, reason: "top_deck_ability_missing_target" };
  }
  const topContext = {
    ...context,
    card: topCard,
    ability,
    player,
    owner,
    target,
    cardMoved: false,
  };
  await executeAbilityBody(topContext);
  if (!topContext.cardMoved) {
    player.drop.push(topCard);
  }
  markAbilityLimit(owner, topCard, ability);
  addLog(`${context.card.name}の効果で${topCard.name}をコストを払わず使いました。`);
  return true;
}

async function selectZoneForScript(step, context) {
  const cardEntry = scriptSelection({ var: step.cardVar }, context)[0];
  const card = cardEntry?.card || context.card;
  const zoneOwner = step.controller === "opponent" ? 1 - context.owner : context.owner;
  const zonesToOffer = (step.zones || fieldZones).filter(
    (zone) => !step.emptyOnly || !state.players[zoneOwner].field[zone],
  );
  const selected = await chooseCardEntries(
    zonesToOffer.map((zone) => ({
      card,
      zone,
      owner: zoneOwner,
      note: step.note || `${zoneLabel(zone)}にコール`,
    })),
    {
      title: step.title || `${card.name}のコール先`,
      lead: step.lead || "コールするエリアを選んでください。",
      min: 1,
      max: 1,
      forceDialog: step.forceDialog !== false,
    },
  );
  const choice = selected?.[0];
  if (!choice) {
    addLog(step.cancelMessage || `${context.card.name}のエリアを選んでください。`);
    return { ok: false, reason: "zone_cancelled" };
  }
  context.vars[step.var] = choice.zone;
  return true;
}

async function callSelectedForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}でコールするカードを選んでください。`);
    return { ok: false, reason: "missing_call_card" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const zone = context.vars[step.zoneVar] || step.zone;
  if (!fieldZones.includes(zone)) {
    addLog(`${context.card.name}のコール先を選んでください。`);
    return { ok: false, reason: "missing_call_zone" };
  }
  const moved = takeScriptSelectionCards([entry]);
  const calledCard = moved[0]?.card;
  if (!calledCard) {
    addLog(`${context.card.name}で選んだカードが移動できません。`);
    return { ok: false, reason: "call_card_missing" };
  }
  if (player.field[zone]) {
    dropFieldCardByRule(player, zone);
  }
  player.field[zone] = calledCard;
  applyScriptGrantedKeywords(calledCard, step.grantKeywords || []);
  enforceSizeLimit(player, zone);
  if (step.redirectPendingAttack && state.pendingAttack) {
    state.pendingAttack.targetOwner = entry.owner ?? context.owner;
    state.pendingAttack.targetZone = zone;
    state.pendingAttack.targetType = "monster";
  }
  addLog(`${context.card.name}で${calledCard.name}を${zoneLabel(zone)}にコールしました。`);
  if (step.redirectPendingAttack && state.pendingAttack) {
    addLog(`${context.card.name}の効果で攻撃対象を変更しました。`);
  }
  if (step.resolveOnEnter) {
    await resolveOnEnter(calledCard, player);
  }
  return true;
}

// 「【対抗】手札のこのカードをコールする」等、発生源カード自身を場へコールする。
// useHandAbilityAction が起動コスト解決時に使用カードをドロップへ送るため、ドロップ→手札の順で発生源を回収する。
async function callSelfFromHandForScript(step, context) {
  const player = state.players[context.owner];
  const card = context.card;
  if (!card) {
    return { ok: false, reason: "self_missing" };
  }
  const zone = context.vars?.[step.zoneVar] || step.zone;
  if (!fieldZones.includes(zone)) {
    addLog(`${card.name}のコール先を選んでください。`);
    return { ok: false, reason: "missing_call_zone" };
  }
  const cost = card.costs?.call || [];
  if (cost.length && !canPayStructuredCost(player, cost, { sourceCard: card }).ok) {
    addLog(`${card.name}のコールコストを支払えません。`);
    return { ok: false, reason: "cannot_pay_call_cost" };
  }
  const removeSelf = (pile) => {
    const index = pile.findIndex((c) => c.instanceId === card.instanceId);
    if (index >= 0) {
      pile.splice(index, 1);
      return true;
    }
    return false;
  };
  if (!removeSelf(player.drop) && !removeSelf(player.hand)) {
    addLog(`${card.name}はコールできる場所にありません。`);
    return { ok: false, reason: "self_not_found" };
  }
  if (cost.length) {
    payStructuredCost(player, cost, { sourceCard: card });
  }
  if (player.field[zone]) {
    dropFieldCardByRule(player, zone);
  }
  player.field[zone] = card;
  applyScriptGrantedKeywords(card, step.grantKeywords || []);
  enforceSizeLimit(player, zone);
  addLog(`${card.name}を${zoneLabel(zone)}にコールしました。`);
  if (step.resolveOnEnter !== false) {
    await resolveOnEnter(card, player);
  }
  return true;
}

async function callSelectedAsMonsterForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  const zone = context.vars[step.zoneVar] || step.zone;
  if (!entry?.card || !fieldZones.includes(zone)) {
    addLog(`${context.card.name}で置くカードとエリアを選んでください。`);
    return { ok: false, reason: "missing_monster_card_or_zone" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const moved = takeScriptSelectionCards([entry]);
  const calledCard = moved[0]?.card;
  if (!calledCard) {
    return { ok: false, reason: "monster_card_missing" };
  }
  if (player.field[zone]) {
    dropFieldCardByRule(player, zone);
  }
  calledCard.currentType = "monster";
  calledCard.faceDownMonster = true;
  calledCard.size = step.size ?? calledCard.size ?? 0;
  calledCard.power = step.power ?? calledCard.power ?? 0;
  calledCard.critical = step.critical ?? calledCard.critical ?? 1;
  calledCard.defense = step.defense ?? calledCard.defense ?? 0;
  calledCard.attributes = step.attributes || calledCard.attributes || [];
  player.field[zone] = calledCard;
  enforceSizeLimit(player, zone);
  addLog(`${context.card.name}の効果で手札のカードを${zoneLabel(zone)}にモンスターとして置きました。`);
  return true;
}

async function callSelectedToEmptyZonesForScript(step, context) {
  const selected = scriptSelection(step, context);
  if (selected.length === 0) {
    return step.require === false ? true : { ok: false, reason: "missing_call_cards" };
  }
  const player = context.player;
  for (const entry of selected) {
    const emptyZones = fieldZones.filter((zone) => !player.field[zone]);
    if (emptyZones.length === 0) {
      break;
    }
    let zone = emptyZones[0];
    if (step.chooseZones && emptyZones.length > 1) {
      const selectedZone = await chooseCardEntries(
        emptyZones.map((candidateZone) => ({
          card: entry.card,
          owner: entry.owner ?? context.owner,
          zone: candidateZone,
          note: zoneLabel(candidateZone),
        })),
        {
          title: `${entry.card.name}のコール先`,
          lead: "コールするエリアを選んでください。",
          min: 1,
          max: 1,
          forceDialog: true,
        },
      );
      zone = selectedZone?.[0]?.zone;
    }
    if (!zone) {
      continue;
    }
    if (step.payCost) {
      const payment = await payCardCostWithSelection(player, entry.card, step.payCost, entry.card, {
        sourceCard: entry.card,
      });
      if (!payment.ok) {
        addLog(payment.reason);
        continue;
      }
    }
    const movedEntries = takeScriptSelectionCards([entry]);
    const calledCard = movedEntries[0]?.card;
    if (!calledCard) {
      continue;
    }
    player.field[zone] = calledCard;
    applyScriptGrantedKeywords(calledCard, step.grantKeywords || []);
    enforceSizeLimit(player, zone);
    addLog(`${context.card.name}の効果で${calledCard.name}を${zoneLabel(zone)}にコールしました。`);
    if (step.resolveOnEnter) {
      await resolveOnEnter(calledCard, player);
    }
  }
  return true;
}

async function stackCallSelectedForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  const zone = context.zone ?? findFieldCardSlot(context.card)?.zone;
  if (!entry?.card || !fieldZones.includes(zone)) {
    addLog(`${context.card.name}で重ねてコールするカードを選んでください。`);
    return { ok: false, reason: "missing_stack_call_card" };
  }
  const moved = takeScriptSelectionCards([entry]);
  const calledCard = moved[0]?.card;
  if (!calledCard) {
    addLog(`${context.card.name}で選んだカードが移動できません。`);
    return { ok: false, reason: "stack_call_card_missing" };
  }
  const player = context.player;
  stackFieldCardAsSoul(player, zone, calledCard);
  enforceSizeLimit(player, zone);
  addLog(`${context.card.name}の効果で${calledCard.name}を${zoneLabel(zone)}に重ねてコールしました。`);
  if (step.resolveOnEnter) {
    await resolveOnEnter(calledCard, player);
  }
  return true;
}

function placeSelectedForScript(step, context) {
  const entry = scriptSelection(step, context)[0];
  if (!entry?.card) {
    addLog(`${context.card.name}で配置するカードを選んでください。`);
    return { ok: false, reason: "missing_place_card" };
  }
  const player = state.players[entry.owner ?? context.owner];
  const zone = resolveScriptPlaceZone(step, player);
  if (!zone) {
    addLog(step.noZoneMessage || "配置できる場所がありません。");
    return { ok: false, reason: "missing_place_zone" };
  }
  const moved = takeScriptSelectionCards([entry]);
  const placedCard = moved[0]?.card;
  if (!placedCard) {
    addLog(`${context.card.name}で選んだカードが移動できません。`);
    return { ok: false, reason: "place_card_missing" };
  }
  if (step.currentType) {
    placedCard.currentType = step.currentType;
  }
  player.field[zone] = placedCard;
  if (step.log) {
    addLog(step.log.replace("{cards}", placedCard.name).replace("{zone}", zoneLabel(zone)));
  } else {
    addLog(`${context.card.name}の効果で${placedCard.name}を${zoneLabel(zone)}に置きました。`);
  }
  return true;
}

function resolveScriptPlaceZone(step, player) {
  if (step.zone === "firstEmptySet") {
    return setZones.find((zone) => !player.field[zone]);
  }
  if (step.zone === "firstEmptyField") {
    return fieldZones.find((zone) => !player.field[zone]);
  }
  return step.zone && !player.field[step.zone] ? step.zone : null;
}

function shuffleDeckForScript(step, context) {
  scriptOwnersForController(step.controller || "self", context.owner).forEach((owner) => {
    shuffleInPlace(state.players[owner].deck);
    if (step.log !== false) {
      addLog(`${state.players[owner].name}はデッキをシャッフルしました。`);
    }
  });
  return true;
}

function stopUnlessMovedToDropMatchesForScript(step, context) {
  const movedCards = context.movedToDrop || [];
  const matched = movedCards.some((card) => matchesCardFilter(card, step.filter || {}));
  if (matched) {
    return true;
  }
  if (step.message) {
    addLog(interpolateScriptMessage(step.message, context));
  }
  return { ok: false, reason: "moved_to_drop_condition_not_met" };
}

function interpolateScriptMessage(message, context) {
  return String(message)
    .replaceAll("{card}", context.card?.name || "")
    .replaceAll("{player}", context.player?.name || "")
    .replace(/\{selection:([^}]+)\}/g, (_match, varName) =>
      scriptSelection({ var: varName }, context)
        .map((entry) => entry.card?.name)
        .filter(Boolean)
        .join("、"),
    );
}

function isScriptEffectStep(step) {
  return [
    "draw",
    "putTopDeckToGauge",
    "putTopDeckToGaugeIfBuddyOnField",
    "moveTopDeckToDrop",
    "gainLife",
    "dealDamage",
    "dealDamageByFieldCardStat",
    "discardAllHand",
    "discardHand",
    "moveHandToGauge",
    "moveMatchingDropToHand",
    "moveGaugeToDrop",
    "revealHand",
    "setNextActivatedCostMayUseOpponentGauge",
    "eachPlayerTopDeckToDropThenDamageOrLife",
    "rockPaperScissorsDamageLosers",
    "topTwoRevealOneOpponentRandomToHandOrGauge",
    "startAttackPhase",
    "restSelf",
    "dropSelf",
    "destroySelf",
    "destroy",
    "destroyAll",
    "moveTargetToDrop",
    "putTopDeckToSoul",
    "moveSourceSoulToHand",
    "returnToHand",
    "returnSelfToHand",
    "returnAllToHand",
    "modifyStats",
    "modifyStatsAll",
    "modifyStatsBySelectedCard",
    "modifyStatsByFieldCardStat",
    "modifyStatsIfTargetAttribute",
    "grantKeyword",
    "dropTargetSoul",
    "nullifyAttack",
    "nullifyPendingAction",
    "redirectPendingAttackToSelf",
    "putTopDeckToGaugeEqualToLastDamage",
    "destroyOpponentMonsterWithPowerLteOwnWeapon",
    "moveTargetToZone",
    "moveTargetToEmptyZone",
    "moveSelfToTargetSoul",
    "dropEventCard",
    "preventOwnMonsterAttacksThisTurn",
    "cancelRecentLifeLink",
    "cancelLifeLink",
    "cancelCallOpportunityLifeLink",
    "reduceNextDamage",
    "preventNextDamage",
    "setPreventNextDestroy",
    "setDelayedDestroyAtOpponentTurnEnd",
    "setDelayedDestroyAtTurnEnd",
    "setDelayedDestroy",
    "shuffleDropIntoDeck",
    "takeExtraTurnAfterThis",
    "gainLifeMinusMatchingDropCount",
    "winGame",
    "lookTopSelectToHandRestToBottom",
    "revealTopDamagePerMatchRestToBottom",
  ].includes(step.op);
}

function applyScriptGrantedKeywords(card, keywords) {
  keywords.forEach((keyword) => {
    if (keyword === "counterattack") {
      card.counterattack = true;
      return;
    }
    card.temporaryKeywords ||= [];
    card.temporaryKeywords.push(keyword);
  });
}

async function executeAbilityEffects(effects, context) {
  for (const effect of effects) {
    await executeAbilityEffect(effect, context);
  }
}

async function resolveRockPaperScissors(context) {
  const choices = [
    { key: "rock", card: { name: "グー", type: "choice" } },
    { key: "scissors", card: { name: "チョキ", type: "choice" } },
    { key: "paper", card: { name: "パー", type: "choice" } },
  ];
  const choose = async (owner) => {
    const title = `${state.players[owner].name}のジャンケン`;
    const lead = "出す手を選んでください。";
    if (isNetworkConnected() && networkSession.seat !== owner) {
      return requestRemoteNetworkChoice(owner, choices, { title, lead });
    }
    const selected = await chooseCardEntries(choices, {
      title,
      lead,
      min: 1,
      max: 1,
      forceDialog: true,
      allowCancel: false,
    });
    return selected?.[0]?.key || null;
  };
  const selfChoice = await choose(context.owner);
  const opponentChoice = await choose(1 - context.owner);
  const winsAgainst = {
    rock: "scissors",
    scissors: "paper",
    paper: "rock",
  };
  const result =
    !selfChoice || !opponentChoice
      ? "cancelled"
      : selfChoice === opponentChoice
        ? "draw"
        : winsAgainst[selfChoice] === opponentChoice
          ? "win"
          : "lose";
  recordDiagnosticEvent("rock_paper_scissors", {
    source: compactCardForLog(context.card),
    owner: context.owner,
    selfChoice,
    opponentChoice,
    result,
  });
  addLog(`${context.card.name}のジャンケン結果: ${state.players[context.owner].name}は${rockPaperScissorsLabel(selfChoice)}、${state.players[1 - context.owner].name}は${rockPaperScissorsLabel(opponentChoice)}。`);
  return result;
}

function rockPaperScissorsLabel(choice) {
  return {
    rock: "グー",
    scissors: "チョキ",
    paper: "パー",
  }[choice] || "未選択";
}

async function executeAbilityEffect(effect, context) {
  const target = resolveEffectReference(effect.target, context);
  const player = context.player;
  const opponent = state.players[1 - context.owner];
  // 汎用ジャンケンゲート: effect.rockPaperScissors が真なら、勝った時だけこのeffectを解決する
  if (effect.rockPaperScissors) {
    if ((await resolveRockPaperScissors(context)) !== "win") {
      addLog(`${context.card?.name || "効果"}のジャンケンに勝てなかったため、効果は解決されませんでした。`);
      return;
    }
  }
  // 汎用 effect conditions ゲート: 各effectに conditions を付けると満たした時だけ解決（targetMatches等と合成可）
  if (
    Array.isArray(effect.conditions) && effect.conditions.length > 0 &&
    !checkCardConditions(effect.conditions, context.owner, { ...context, target })
  ) {
    return;
  }
  if (effect.op === "draw") {
    drawCards(player, effect.amount || 1);
  }
  if (effect.op === "putTopDeckToGauge") {
    const receiver = effect.player === "opponent" ? opponent : player;
    const before = receiver.gauge.length;
    moveTopDeckToGauge(receiver, effect.amount || 1);
    const moved = receiver.gauge.length - before;
    addLog(`${receiver.name}はデッキの上から${moved}枚をゲージに置きました。`);
  }
  if (effect.op === "putTopDeckToSoul" && context.card) {
    const receiver = effect.player === "opponent" ? opponent : player;
    const before = context.card.soul?.length || 0;
    moveTopDeckToSoul(receiver, context.card, effect.amount || 1);
    const moved = (context.card.soul?.length || 0) - before;
    addLog(`${context.card.name}のソウルにデッキの上から${moved}枚を入れました。`);
  }
  if (effect.op === "moveGaugeToDeckAndShuffle") {
    const receiver = effect.player === "opponent" ? opponent : player;
    const movedCards = receiver.gauge.splice(0);
    receiver.deck.push(...movedCards);
    shuffleInPlace(receiver.deck);
    addLog(`${receiver.name}はゲージ${movedCards.length}枚をデッキに戻してシャッフルしました。`);
  }
  if (effect.op === "putTopDeckToGaugeIfBuddyOnField") {
    const amount = hasBuddyOnField(player) ? effect.amountWithBuddy || 2 : effect.amount || 1;
    const before = player.gauge.length;
    moveTopDeckToGauge(player, amount);
    const moved = player.gauge.length - before;
    addLog(`${player.name}はデッキの上から${moved}枚をゲージに置きました。`);
  }
  if (effect.op === "moveTopDeckToDrop") {
    const receiver = effect.player === "opponent" ? opponent : player;
    const movedCards = [];
    for (let index = 0; index < (effect.amount || 1); index += 1) {
      const movedCard = receiver.deck.pop();
      if (movedCard) {
        receiver.drop.push(movedCard);
        movedCards.push(movedCard);
      }
    }
    if (receiver.deck.length === 0) {
      declareDeckLoss(receiver);
    }
    addLog(`${receiver.name}はデッキの上から${movedCards.length}枚をドロップゾーンに置きました。`);
    context.movedToDrop ||= [];
    context.movedToDrop.push(...movedCards);
    context.movedToDropEntries ||= [];
    context.movedToDropEntries.push(
      ...movedCards.map((card) => ({ owner: state.players.indexOf(receiver), card })),
    );
  }
  if (effect.op === "startAttackPhase") {
    state.phase = "attack";
    state.counterHandOwner = null;
    state.linkAttackers = [];
    state.buddyCallDeclared = null;
    addLog(`${context.card.name}の効果で、もう1度アタックフェイズを行います。`);
    await runPhaseStartTriggers("attackStart", state.active);
    await runMoveKeywordsAtAttackPhaseStart();
  }
  if (effect.op === "gainLife") {
    const gained = effect.amount || 1;
    player.life += gained;
    if (gained > 0) {
      await runFieldEventTriggers("lifeGained", state.players.indexOf(player));
    }
  }
  if (effect.op === "lookTopSelectToHandRestToBottom") {
    const count = effect.count || 5;
    const revealed = [];
    for (let i = 0; i < count && player.deck.length > 0; i += 1) revealed.push(player.deck.pop());
    const candidates = revealed.filter((c) => matchesCardFilter(c, effect.filter || {}));
    let picked = [];
    if (candidates.length > 0) {
      const sel = await chooseCardEntries(candidates.map((c) => ({ card: c })), {
        title: effect.title || context.card.name,
        lead: effect.lead || "手札に加えるカードを選んでください。",
        min: 0, max: effect.max || 1, forceDialog: true,
      });
      picked = (sel || []).map((e) => e.card);
    }
    picked.forEach((c) => player.hand.push(c));
    revealed.filter((c) => !picked.includes(c)).forEach((c) => player.deck.unshift(c));
    addLog(`${context.card.name}の効果でデッキの上${revealed.length}枚を見て${picked.length}枚を手札に加えました。`);
  }
  if (effect.op === "revealTopDamagePerMatchRestToBottom") {
    const count = effect.count || 5;
    const revealed = [];
    for (let i = 0; i < count && player.deck.length > 0; i += 1) revealed.push(player.deck.pop());
    const matched = revealed.filter((c) => matchesCardFilter(c, effect.filter || {})).length;
    const dmg = matched * (effect.perDamage || 1);
    addLog(`${context.card.name}の効果で${revealed.length}枚を公開し、${matched}枚一致。`);
    if (dmg > 0) applyDamageToPlayer(1 - context.owner, dmg, { sourceName: context.card?.name });
    revealed.forEach((c) => player.deck.unshift(c));
  }
  if (effect.op === "gainLifeMinusMatchingDropCount") {
    const copies = player.drop.filter((card) =>
      matchesRelativeCardFilter(card, effect.filter || {}, context),
    ).length;
    const amount = Math.max(0, (effect.baseAmount || 0) - copies);
    player.life += amount;
    addLog(`${player.name}は${context.card.name}の効果でライフを${amount}回復しました。`);
    if (amount > 0) {
      await runFieldEventTriggers("lifeGained", state.players.indexOf(player));
    }
  }
  if (effect.op === "dealDamage") {
    const receiver = effect.player === "self" ? player : opponent;
    const amount = effect.amountFrom ? resolveAmountFrom(effect.amountFrom, context) : effect.amount || 1;
    applyDamageToPlayer(state.players.indexOf(receiver), amount, {
      sourceName: context.card?.name,
      ignorePrevention: Boolean(effect.ignorePrevention),
    });
  }
  if (effect.op === "dealDamageByFieldCardStat") {
    const source = fieldCardForEffect(effect, context);
    if (!source?.card) {
      return;
    }
    if (effect.chance !== undefined && Math.random() >= effect.chance) {
      addLog(`${context.card.name}の判定は成功しませんでした。`);
      return;
    }
    const amount = visibleFieldStat(source.card, effect.stat || "critical");
    const receiver = effect.player === "self" ? player : opponent;
    const dealtDamage = applyDamageToPlayer(state.players.indexOf(receiver), amount, { log: false });
    addLog(`${context.card.name}の効果で${receiver.name}に${dealtDamage}ダメージを与えました。`);
    checkWinner();
  }
  if (effect.op === "discardAllHand") {
    discardHandCardsToDrop(player, player.hand.splice(0));
  }
  if (effect.op === "discardHand") {
    const receiver = effect.player === "opponent" ? opponent : player;
    const amount = Math.min(effect.amount || 1, receiver.hand.length);
    const movedCards = await chooseAndTakeMatchingCards(receiver.hand, effect.filter, amount, context.card, {
      title: `${context.card.name}で捨てる手札`,
      lead: `手札から捨てるカードを${amount}枚選んでください。`,
    });
    discardHandCardsToDrop(receiver, movedCards);
    if (movedCards.length > 0) {
      addLog(`${receiver.name}は${movedCards.map((card) => card.name).join("、")}を捨てました。`);
    }
  }
  if (effect.op === "moveHandToGauge") {
    const amount = effect.amount || 1;
    const movedCards = await chooseAndTakeMatchingCards(player.hand, effect.filter, amount, context.card, {
      title: `${context.card.name}でゲージに置くカード`,
      lead: `手札から条件を満たすカードを${amount}枚選んでください。`,
    });
    player.gauge.push(...movedCards);
    if (movedCards.length > 0) {
      addLog(`${movedCards.map((card) => card.name).join("、")}をゲージに置きました。`);
    }
  }
  if (effect.op === "moveMatchingDropToHand") {
    const amount = effect.amount || 1;
    // optional:true の場合は「N枚まで／加えてよい」を表すため最小選択数を0にする（既定は強制取得＝min:amount）
    const selectOptions = {
      title: `${context.card.name}で手札に加えるカード`,
      lead: `ドロップゾーンから条件を満たすカードを${amount}枚選んでください。`,
    };
    if (effect.optional) {
      selectOptions.min = 0;
    }
    const movedCards = await chooseAndTakeMatchingCards(player.drop, effect.filter, amount, null, selectOptions);
    player.hand.push(...movedCards);
    if (movedCards.length > 0) {
      addLog(`${movedCards.map((card) => card.name).join("、")}を手札に加えました。`);
    }
  }
  if (effect.op === "moveGaugeToDrop") {
    const receiver = effect.player === "opponent" ? opponent : player;
    const amount = Math.min(effect.amount || 1, receiver.gauge.length);
    const movedCards = receiver.gauge.splice(receiver.gauge.length - amount, amount);
    receiver.drop.push(...movedCards);
    if (movedCards.length > 0) {
      addLog(`${context.card.name}の効果で${receiver.name}のゲージ${movedCards.length}枚をドロップゾーンに置きました。`);
    }
  }
  if (effect.op === "revealHand") {
    const receiver = effect.player === "self" ? player : opponent;
    const cardNames = receiver.hand.map((card) => card.name);
    addLog(`${context.card.name}の効果で${receiver.name}の手札を確認しました：${cardNames.join("、") || "なし"}`);
    recordDiagnosticEvent("reveal_hand", {
      source: compactCardForLog(context.card),
      targetPlayer: receiver.name,
      cards: receiver.hand.map(compactCardForLog),
    });
  }
  if (effect.op === "setNextActivatedCostMayUseOpponentGauge") {
    player.nextActivatedCostMayUseOpponentGauge = true;
    addLog(`${context.card.name}の効果で、次に君の場のモンスターの【起動】でゲージを払う時、相手のゲージからも払えます。`);
  }
  if (effect.op === "eachPlayerTopDeckToDropThenDamageOrLife") {
    for (const owner of [context.owner, 1 - context.owner]) {
      const receiver = state.players[owner];
      const movedCard = receiver.deck.pop();
      if (!movedCard) {
        declareDeckLoss(receiver);
        continue;
      }
      receiver.drop.push(movedCard);
      if (effectiveCardType(movedCard) === "monster") {
        applyDamageToPlayer(owner, effect.damage || 1, { sourceName: context.card?.name });
      } else {
        receiver.life += effect.life || 1;
        addLog(`${context.card.name}の効果で${receiver.name}のライフを${effect.life || 1}回復しました。`);
      }
    }
  }
  if (effect.op === "rockPaperScissorsDamageLosers") {
    const result = await resolveRockPaperScissors(context);
    const amount = effect.amount || 1;
    if (result === "win" || result === "draw") {
      applyDamageToPlayer(1 - context.owner, amount, { sourceName: context.card?.name });
    }
    if (result === "lose" || result === "draw") {
      applyDamageToPlayer(context.owner, amount, { sourceName: context.card?.name });
    }
  }
  if (effect.op === "topTwoRevealOneOpponentRandomToHandOrGauge") {
    await resolveTopTwoRevealOneOpponentRandomToHandOrGauge(effect, context);
  }
  if (effect.op === "restSelf" && context.card) {
    context.card.used = true;
  }
  if (effect.op === "dropSelf") {
    dropFieldCardByRule(player, context.zone);
  }
  if (effect.op === "destroySelf") {
    destroyFieldCard(context.owner, context.zone, { ignoreSoulguard: true });
  }
  if (effect.op === "destroy") {
    // 統合形: target(単体) / scope(全体) / target:"$self"(自己) を1opに。
    // options(cause/ignoreSoulguard 等)で破壊耐性の挙動差を明示的に再現する。
    if (effect.scope) {
      collectFieldTargets(
        { scope: effect.scope, filter: effect.filter, zones: effect.zones, excludeSource: effect.excludeSource },
        context,
      )
        .map((entry) => ({ owner: entry.owner, zone: entry.zone }))
        .forEach((entry) =>
          destroyFieldCard(entry.owner, entry.zone, { cause: makeEffectCause(context, entry.owner), ...(effect.options || {}) }),
        );
    } else if (target?.card) {
      const destroyedName = target.card.name;
      const isSelf = effect.target === "$self";
      const options = isSelf
        ? { ignoreSoulguard: true, ...(effect.options || {}) }
        : { cause: makeEffectCause(context, target.owner), ...(effect.options || {}) };
      const destroyed = destroyFieldCard(target.owner, target.zone, options);
      if (destroyed && !isSelf && context.card) {
        addLog(`${context.card.name}の効果で${destroyedName}を破壊しました。`);
      }
    }
  }
  if (effect.op === "destroyAll") {
    allFieldTargets((card, owner, zone) => {
      if (Array.isArray(effect.zones) && !effect.zones.includes(zone)) {
        return false;
      }
      if (effect.controller === "self" && owner !== context.owner) {
        return false;
      }
      if (effect.controller === "opponent" && owner === context.owner) {
        return false;
      }
      return matchesTargetFilter(card, owner, zone, effect.filter);
    })
      .map((candidate) => ({ owner: candidate.owner, zone: candidate.zone }))
      .forEach((candidate) => destroyFieldCard(candidate.owner, candidate.zone, { cause: makeEffectCause(context, candidate.owner) }));
  }
  if (effect.op === "moveTargetToDrop" && target?.card) {
    const ownerPlayer = state.players[target.owner];
    const moved = dropFieldCardByRule(ownerPlayer, target.zone);
    if (moved) {
      addLog(`${context.card.name}の効果で${moved.name}をドロップゾーンに置きました。`);
    }
  }
  if (effect.op === "returnToHand" && target) {
    returnFieldTargetToHand(target, context.card.name);
  }
  if (effect.op === "dischargeSelfFromHostSoul" && context.card && context.hostCard) {
    // ソウルに入っているこのカード自身を、ホスト（武器等）のソウルからドロップへ置く。
    const soul = context.hostCard.soul || [];
    const soulIndex = soul.findIndex((c) => c.instanceId === context.card.instanceId);
    if (soulIndex >= 0) {
      const [removed] = soul.splice(soulIndex, 1);
      const selfPlayer = context.player || state.players[context.owner];
      selfPlayer.drop.push(removed);
      addLog(`${removed.name}を${context.hostCard.name}のソウルからドロップに置きました。`);
    }
  }
  if (effect.op === "returnSelfToHand" && context.card) {
    // 使用中のこのカード自身を手札に戻す（対抗呪文等は解決時点で既にドロップにある）。
    const selfPlayer = context.player || state.players[context.owner];
    if (selfPlayer) {
      const dropIndex = selfPlayer.drop.findIndex((c) => c.instanceId === context.card.instanceId);
      if (dropIndex >= 0) {
        selfPlayer.drop.splice(dropIndex, 1);
      }
      if (!selfPlayer.hand.some((c) => c.instanceId === context.card.instanceId)) {
        selfPlayer.hand.push(context.card);
      }
      addLog(`${context.card.name}を手札に戻しました。`);
    }
  }
  if (effect.op === "returnAllToHand") {
    const returnAllTargets = allFieldTargets((card, owner, zone) => {
      if (effect.controller === "self" && owner !== context.owner) {
        return false;
      }
      if (effect.controller === "opponent" && owner === context.owner) {
        return false;
      }
      return matchesTargetFilter(card, owner, zone, effect.filter);
    })
      .map((candidate) => ({ owner: candidate.owner, zone: candidate.zone }));
    const returnedForTriggers = [];
    for (const candidate of returnAllTargets) {
      const ownerPlayer = state.players[candidate.owner];
      const returned = ownerPlayer.field[candidate.zone];
      if (!returned) {
        continue;
      }
      if (cannotReturnToHand(returned)) {
        addLog(`${returned.name}は手札に戻せません。`);
        continue;
      }
      ownerPlayer.drop.push(...(returned.soul || []));
      returned.soul = [];
      ownerPlayer.field[candidate.zone] = null;
      if (candidate.zone === "item" && ownerPlayer.arrivalCardId === returned.instanceId) {
        ownerPlayer.arrivalCardId = null;
      }
      ownerPlayer.hand.push(returned);
      applyLifeLink(returned, candidate.owner);
      addLog(`${returned.name}を手札に戻しました。`);
      if (effectiveCardType(returned) === "monster") {
        returnedForTriggers.push({ card: returned, owner: candidate.owner, zone: candidate.zone });
      }
    }
    // 「場のモンスターが手札に戻った時」誘発を逐次 await で発火する。
    // マイクロタスク並列だと消費側の「1ターン1回」が markAbilityLimit 前に複数回パスするため、直列化する。
    for (const r of returnedForTriggers) {
      await runFieldEventTriggers("monsterReturned", r.owner, r.card, r.zone);
    }
  }
  if (effect.op === "modifyStats") {
    // 統合形: scope(全体) / 単体target、by:{}・直書き・amountFrom(スカラー量参照)を受理。
    const recipients = effect.scope
      ? collectFieldTargets(
          { scope: effect.scope, filter: effect.filter, zones: effect.zones, excludeSource: effect.excludeSource },
          context,
        )
      : target?.card
        ? [target]
        : [];
    if (recipients.length > 0) {
      const duration = effect.duration || (effect.scope ? "turn" : "battle");
      const delta = modifyStatsDelta(effect, context);
      recipients.forEach((entry) => applyModifyStatsDelta(entry.card, duration, delta));
    }
  }
  if (effect.op === "modifyStatsAll") {
    const duration = effect.duration || "turn";
    const prefix = duration === "turn" ? "turn" : "battle";
    allFieldTargets((card, owner, zone) => {
      if (effect.controller === "self" && owner !== context.owner) return false;
      if (effect.controller === "opponent" && owner === context.owner) return false;
      return matchesTargetFilter(card, owner, zone, effect.filter || {});
    }).forEach((entry) => {
      entry.card[`${prefix}PowerBonus`] += effect.power || 0;
      entry.card[`${prefix}DefenseBonus`] += effect.defense || 0;
      entry.card[`${prefix}CriticalBonus`] += effect.critical || 0;
    });
  }
  if (effect.op === "modifyStatsBySelectedCard" && target?.card) {
    const selected = scriptSelection({ var: effect.var }, context)[0]?.card;
    if (!selected) {
      return;
    }
    const duration = effect.duration || "battle";
    const prefix = duration === "turn" ? "turn" : "battle";
    if (effect.power !== false) {
      applyStatBonus(target.card, prefix, "power", selected.power || 0);
    }
    if (effect.defense !== false) {
      applyStatBonus(target.card, prefix, "defense", selected.defense || 0);
    }
    if (effect.critical !== false) {
      applyStatBonus(target.card, prefix, "critical", selected.critical || 0);
    }
    addLog(`${context.card.name}の効果で${target.card.name}を${selected.name}の能力値分強化しました。`);
  }
  if (effect.op === "modifyStatsByFieldCardStat" && target?.card) {
    const source = fieldCardForEffect(effect, context);
    if (!source?.card) {
      return;
    }
    const amount = visibleFieldStat(source.card, effect.stat || "power");
    const stats = await statsToModifyForEffect(effect, context, amount);
    const duration = effect.duration || "battle";
    const prefix = duration === "turn" ? "turn" : "battle";
    stats.forEach((stat) => {
      applyStatBonus(target.card, prefix, stat, amount);
    });
    if (stats.length > 0) {
      addLog(`${context.card.name}の効果で${target.card.name}を${amount}強化しました。`);
    }
  }
  if (effect.op === "modifyStatsIfTargetAttribute" && target?.card?.attributes?.includes(effect.attribute)) {
    const duration = effect.duration || "battle";
    const prefix = duration === "turn" ? "turn" : "battle";
    target.card[`${prefix}PowerBonus`] += effect.power || 0;
    target.card[`${prefix}DefenseBonus`] += effect.defense || 0;
    target.card[`${prefix}CriticalBonus`] += effect.critical || 0;
  }
  if (
    effect.op === "modifyStatsIfTargetName" &&
    target?.card &&
    (effect.nameIncludes ? target.card.name.includes(effect.nameIncludes) : target.card.name === effect.name)
  ) {
    const duration = effect.duration || "battle";
    const prefix = duration === "turn" ? "turn" : "battle";
    target.card[`${prefix}PowerBonus`] += effect.power || 0;
    target.card[`${prefix}DefenseBonus`] += effect.defense || 0;
    target.card[`${prefix}CriticalBonus`] += effect.critical || 0;
  }
  if (effect.op === "grantKeyword" && target?.card) {
    if (effect.keyword === "counterattack") {
      target.card.counterattack = true;
    } else if (effect.duration === "permanent") {
      target.card.keywords ||= [];
      if (!target.card.keywords.includes(effect.keyword)) {
        target.card.keywords.push(effect.keyword);
      }
    } else if (effect.duration === "turn") {
      target.card.turnKeywords ||= [];
      target.card.turnKeywords.push(effect.keyword);
    } else {
      target.card.temporaryKeywords ||= [];
      target.card.temporaryKeywords.push(effect.keyword);
    }
  }
  if (effect.op === "dropTargetSoul" && target?.card) {
    const amount = effect.amount ?? target.card.soul?.length ?? 0;
    if (amount <= 0) {
      return;
    }
    const soulEntries = (target.card.soul || []).map((card, index) => ({
      card,
      index,
      owner: target.owner,
      source: "soul",
      note: `${target.card.name}のソウル`,
    }));
    const selected =
      soulEntries.length > amount
        ? await chooseCardEntries(soulEntries, {
            title: `${context.card.name}のソウル選択`,
            lead: `${target.card.name}のソウルからドロップゾーンに置くカードを${amount}枚選んでください。`,
            min: amount,
            max: amount,
            forceDialog: true,
          })
        : soulEntries.slice(0, amount);
    const movedCards = removePileEntries(target.card.soul || [], selected || []);
    state.players[target.owner].drop.push(...movedCards);
    if (movedCards.length > 0) {
      addLog(
        `${context.card.name}の効果で${target.card.name}のソウルから${movedCards
          .map((card) => card.name)
          .join("、")}をドロップゾーンに置きました。`,
      );
    }
  }
  if (effect.op === "declareAttackWithTarget" && target?.card) {
    await declareAttackWithFieldCard(target.owner, target.zone, effect);
  }
  if (effect.op === "nullifyAttackersKeyword") {
    const eventAttackers = context.attackers || getPendingAttackers();
    for (const attacker of eventAttackers) {
      if (!attacker?.card) {
        continue;
      }
      attacker.card.turnSuppressedKeywords ||= [];
      attacker.card.turnSuppressedKeywords.push(effect.keyword);
      addLog(`${context.card.name}の効果で${attacker.card.name}の『${effect.label || effect.keyword}』をそのターン中無効化しました。`);
    }
  }
  if (effect.op === "dropAllSoulAtZone") {
    const soulOwners =
      effect.controller === "self"
        ? [context.owner]
        : effect.controller === "opponent"
          ? [1 - context.owner]
          : [context.owner, 1 - context.owner];
    for (const soulOwner of soulOwners) {
      const fieldCard = state.players[soulOwner]?.field?.[effect.zone];
      if (fieldCard?.soul?.length) {
        addLog(`${context.card.name}の効果で${fieldCard.name}のソウル${fieldCard.soul.length}枚をドロップゾーンに置きました。`);
        state.players[soulOwner].drop.push(...fieldCard.soul);
        fieldCard.soul = [];
      }
    }
  }
  if (effect.op === "moveSourceSoulToHand" && context.card) {
    const soulCards = context.card.soul || [];
    if (soulCards.length > 0) {
      state.players[context.owner].hand.push(...soulCards);
      addLog(`${context.card.name}のソウル${soulCards.length}枚を手札に加えました。`);
      context.card.soul = [];
    }
  }
  if (effect.op === "restTarget" && target?.card) {
    if (await restFieldCard(target.owner, target.zone, target.card, { source: context.card })) {
      addLog(`${context.card.name}の効果で${target.card.name}をレストしました。`);
    }
  }
  if (effect.op === "standTarget" && target?.card) {
    target.card.used = false;
    addLog(`${context.card.name}の効果で${target.card.name}をスタンドしました。`);
  }
  if (effect.op === "nullifyAttackersKeyword") {
    // 攻撃してきたカードの指定キーワードを、そのターン中 無効化する（turnSuppressedKeywords は hasKeyword が参照し、ターン終了でクリア）。
    const attackers = context.attackers?.length ? context.attackers : getPendingAttackers();
    attackers.forEach((attacker) => {
      const attackerCard = attacker.card;
      if (!attackerCard) {
        return;
      }
      attackerCard.turnSuppressedKeywords = attackerCard.turnSuppressedKeywords || [];
      if (!attackerCard.turnSuppressedKeywords.includes(effect.keyword)) {
        attackerCard.turnSuppressedKeywords.push(effect.keyword);
      }
    });
    addLog(`${context.card?.name || "効果"}で攻撃側の『${effect.label || effect.keyword}』を無効化しました。`);
  }
  if (effect.op === "putTargetToGauge" && target?.card) {
    const ownerPlayer = state.players[target.owner];
    const moved = putFieldCardToGauge(ownerPlayer, target.zone);
    if (moved) {
      addLog(`${context.card.name}の効果で${moved.name}をゲージに置きました。`);
    }
  }
  if (effect.op === "nullifyAttack" && state.pendingAttack) {
    context.lastEffectResult = nullifyPendingAttack(context.card?.name || "効果", context.card);
  }
  if (effect.op === "nullifyPendingAction" && state.pendingAction) {
    context.lastEffectResult = nullifyPendingAction(context.card?.name || "効果");
  }
  if (effect.op === "redirectPendingAttackToSelf" && state.pendingAttack && context.card) {
    const slot = findFieldCardSlot(context.card);
    if (slot) {
      const alreadyTarget =
        state.pendingAttack.targetOwner === slot.owner && state.pendingAttack.targetZone === slot.zone;
      if (!alreadyTarget) {
        state.pendingAttack.targetOwner = slot.owner;
        state.pendingAttack.targetZone = slot.zone;
        state.pendingAttack.targetType =
          effectiveCardType(context.card) === "monster" ? "monster" : "fieldCard";
        addLog(`${context.card.name}の効果で攻撃対象を${context.card.name}に変更しました。`);
      }
    }
  }
  if (effect.op === "putTopDeckToGaugeEqualToLastDamage") {
    state.lastDamageTaken ||= [0, 0];
    const idx = state.players.indexOf(player);
    const amount = state.lastDamageTaken[idx] || 0;
    if (amount > 0) {
      const before = player.gauge.length;
      moveTopDeckToGauge(player, amount);
      const moved = player.gauge.length - before;
      addLog(`${player.name}は${context.card.name}の効果でデッキの上から${moved}枚をゲージに置きました。`);
      state.lastDamageTaken[idx] = 0;
    }
  }
  if (effect.op === "destroyOpponentMonsterWithPowerLteOwnWeapon") {
    // 君の場の《武器》の攻撃力以下の攻撃力を持つ相手モンスター１枚を破壊する（斬魔烈斬）
    const weaponPowers = zones
      .map((zone) => player.field[zone])
      .filter(
        (fieldCard) =>
          fieldCard &&
          effectiveCardType(fieldCard) === "item" &&
          (fieldCard.attributes || []).includes("武器"),
      )
      .map((fieldCard) => visiblePower(fieldCard));
    const weaponPower = weaponPowers.length > 0 ? Math.max(...weaponPowers) : 0;
    const candidates = allFieldTargets(
      (fieldCard, fieldOwner) =>
        fieldOwner !== context.owner &&
        effectiveCardType(fieldCard) === "monster" &&
        visiblePower(fieldCard) <= weaponPower,
    );
    if (candidates.length === 0) {
      addLog(`${context.card.name}の効果で破壊できる相手モンスターがいません。`);
      return;
    }
    const selected = await chooseCardEntries(
      candidates.map((candidate) => ({
        card: candidate.card,
        owner: candidate.owner,
        zone: candidate.zone,
      })),
      {
        title: `${context.card.name}`,
        lead: "破壊する相手モンスターを選んでください。",
        min: 1,
        max: 1,
        forceDialog: true,
      },
    );
    if (selected?.[0]) {
      destroyFieldCard(selected[0].owner, selected[0].zone);
      addLog(`${context.card.name}の効果で${selected[0].card.name}を破壊しました。`);
    }
  }
  if (effect.op === "moveTargetToZone" && target?.card) {
    const ownerPlayer = state.players[target.owner];
    const destination = effect.zone;
    if (!zones.includes(destination) || ownerPlayer.field[destination]) {
      addLog(`${context.card.name}の効果で移動できるエリアがありません。`);
      return;
    }
    if (!(await moveFieldCard(target.owner, target.zone, destination, { source: context.card }))) {
      return;
    }
    addLog(`${context.card.name}の効果で${target.card.name}を${zoneLabel(destination)}に移動しました。`);
    if (effect.redirectPendingAttack && state.pendingAttack) {
      state.pendingAttack.targetOwner = target.owner;
      state.pendingAttack.targetZone = destination;
      state.pendingAttack.targetType = effectiveCardType(target.card) === "monster" ? "monster" : "fieldCard";
      addLog(`${context.card.name}の効果で攻撃対象を${target.card.name}に変更しました。`);
    }
  }
  if (effect.op === "moveTargetToEmptyZone" && target?.card) {
    const ownerPlayer = state.players[target.owner];
    const destinations = (effect.zones || fieldZones).filter((zone) => zones.includes(zone) && !ownerPlayer.field[zone]);
    if (destinations.length === 0) {
      addLog(`${context.card.name}の効果で移動できるエリアがありません。`);
      return;
    }
    let destination = destinations[0];
    if (destinations.length > 1) {
      const selected = await chooseCardEntries(
        destinations.map((zone) => ({
          card: target.card,
          owner: target.owner,
          zone,
          note: zoneLabel(zone),
        })),
        {
          title: `${context.card.name}の移動先`,
          lead: `${target.card.name}を移動するエリアを選んでください。`,
          min: 1,
          max: 1,
          forceDialog: true,
        },
      );
      destination = selected?.[0]?.zone;
    }
    if (!destination) {
      return;
    }
    if (await moveFieldCard(target.owner, target.zone, destination, { source: context.card })) {
      addLog(`${context.card.name}の効果で${target.card.name}を${zoneLabel(destination)}に移動しました。`);
    }
  }
  if (effect.op === "moveSelfToTargetSoul" && target?.card && context.card) {
    const sourceSlot = findFieldCardSlot(context.card);
    let movedCard;
    if (sourceSlot) {
      movedCard = detachFieldCardForMove(sourceSlot.owner, sourceSlot.zone, context.card);
    } else {
      // 手札からの起動（「手札のこのカードを…ソウルに入れる」）に対応: 手札から取り除いてから移す。
      const handCards = state.players[context.owner]?.hand;
      const handIndex = handCards?.findIndex((c) => c.instanceId === context.card.instanceId);
      movedCard = handIndex !== undefined && handIndex >= 0 ? handCards.splice(handIndex, 1)[0] : context.card;
    }
    if (!movedCard) {
      return;
    }
    target.card.soul ||= [];
    target.card.soul.push(movedCard);
    context.cardMoved = true;
    addLog(`${context.card.name}を${target.card.name}のソウルに入れました。`);
  }
  if (effect.op === "dropEventCard") {
    const eventEntry = effect.eventCard === "damageSource" ? context.damageSource : context.eventCard;
    if (!eventEntry?.card || eventEntry.source !== "field") {
      return;
    }
    const current = state.players[eventEntry.owner]?.field?.[eventEntry.zone];
    if (!current || current.instanceId !== eventEntry.card.instanceId) {
      return;
    }
    const dropped = dropFieldCardByRule(state.players[eventEntry.owner], eventEntry.zone);
    if (dropped) {
      addLog(`${context.card.name}の効果で${dropped.name}をドロップゾーンに置きました。`);
    }
  }
  if (effect.op === "preventOwnMonsterAttacksThisTurn") {
    state.monsterAttackForbidden[context.owner] = true;
    // 禁止の発生源を記録（ignoreAttackForbidden が「グレイプニル」のみ解除するため）。
    state.monsterAttackForbiddenSources ||= [[], []];
    state.monsterAttackForbiddenSources[context.owner].push(effect.source || context.card?.name || "不明");
  }
  if (["cancelRecentLifeLink", "cancelLifeLink"].includes(effect.op)) {
    cancelRecentLifeLink(context.owner, effect, context.card?.name);
  }
  if (effect.op === "cancelCallOpportunityLifeLink") {
    cancelCallOpportunityLifeLink(context.owner, effect, context.card?.name);
  }
  if (effect.op === "reduceNextDamage") {
    addNextDamagePrevention(context.owner, {
      amount: effect.amount || 1,
      source: context.card?.name,
      sourceCard: context.card,
    });
    addLog(`${context.card.name}の効果で、次に受けるダメージを${effect.amount || 1}減らします。`);
  }
  if (effect.op === "preventNextDamage") {
    // 統合形: all:true(全無効) / amount:N(N軽減) / 引数なし(後方互換で全無効)。
    const preventAll = effect.all === true || (effect.amount === undefined && effect.all === undefined);
    if (preventAll) {
      addNextDamagePrevention(context.owner, {
        preventAll: true,
        source: context.card?.name,
        sourceCard: context.card,
      });
      addLog(`${context.card.name}の効果で、次に受けるダメージを0にします。`);
    } else {
      const amount = effect.amount || 1;
      addNextDamagePrevention(context.owner, {
        amount,
        source: context.card?.name,
        sourceCard: context.card,
      });
      addLog(`${context.card.name}の効果で、次に受けるダメージを${amount}減らします。`);
    }
  }
  if (effect.op === "setPreventNextDestroy" && target?.card) {
    target.card.preventNextDestroyCount = (target.card.preventNextDestroyCount || 0) + (effect.amount || 1);
    if (effect.gainLife || effect.log || effect.countsAsDestroyed) {
      target.card.preventNextDestroyEffects ||= [];
      target.card.preventNextDestroyEffects.push({
        owner: context.owner,
        gainLife: effect.gainLife || 0,
        source: context.card?.name || "",
        log: effect.log || "",
        countsAsDestroyed: Boolean(effect.countsAsDestroyed),
      });
    }
    addLog(`${context.card.name}の効果で、次に${target.card.name}が破壊される場合、場に残せるようにしました。`);
  }
  if (effect.op === "setDelayedDestroyAtOpponentTurnEnd" && context.card) {
    context.card.destroyAtEndOfTurnOwner = 1 - context.owner;
  }
  if (effect.op === "setDelayedDestroyAtTurnEnd") {
    const delayTarget = effect.target ? resolveEffectReference(effect.target, context) : null;
    if (delayTarget?.card) {
      delayTarget.card.destroyAtEndOfTurnOwner = delayTarget.owner;
    } else if (context.card) {
      context.card.destroyAtEndOfTurnOwner = context.owner;
    }
  }
  // 統合形: setDelayedDestroy{when?, target?}。旧 setDelayedDestroyAt(Opponent)TurnEnd を吸収。
  // when:"ownTurnEnd"=自分のターン終了時 / "opponentTurnEnd"=相手のターン終了時 /
  // 省略時=対象カードの所有者のターン終了時（旧 AtTurnEnd(target有) 互換）。
  if (effect.op === "setDelayedDestroy") {
    const victim = effect.target
      ? resolveEffectReference(effect.target, context)
      : context.card
        ? { card: context.card, owner: context.owner }
        : null;
    if (victim?.card) {
      let turnEndOwner;
      if (effect.when === "ownTurnEnd") {
        turnEndOwner = context.owner;
      } else if (effect.when === "opponentTurnEnd") {
        turnEndOwner = 1 - context.owner;
      } else {
        turnEndOwner = victim.owner;
      }
      victim.card.destroyAtEndOfTurnOwner = turnEndOwner;
    }
  }
  if (effect.op === "shuffleDropIntoDeck") {
    const movedCards = player.drop.splice(0);
    player.deck.push(...movedCards);
    shuffleInPlace(player.deck);
    addLog(`${player.name}はドロップゾーンのカードをデッキに戻してシャッフルしました。`);
  }
  if (effect.op === "takeExtraTurnAfterThis") {
    state.extraTurnOwner = context.owner;
    addLog(`${player.name}はこのターンの後に追加ターンを得ます。`);
  }
  if (effect.op === "winGame") {
    state.winner = context.owner;
    addLog(`${player.name}は${context.card.name}の効果で勝利しました。`);
  }
}

function resolveEffectReference(reference, context) {
  if (reference === "$target") {
    return context.target;
  }
  if (reference === "$self") {
    return { owner: context.owner, zone: context.zone, card: context.card };
  }
  if (reference === "$host") {
    return context.hostCard
      ? { owner: context.hostOwner ?? context.owner, zone: context.hostZone ?? context.zone, card: context.hostCard }
      : null;
  }
  if (reference === "$attackTarget") {
    return getPendingBattleTargetInfo(context.attack || state.pendingAttack);
  }
  if (reference === "$attacker") {
    if (context.attackers && context.attackers[0]) {
      return context.attackers[0];
    }
    const pa = state.pendingAttack;
    if (pa && pa.attackers && pa.attackers[0]) {
      const slot = pa.attackers[0];
      return { owner: slot.owner, zone: slot.zone, card: state.players[slot.owner]?.field?.[slot.zone] };
    }
    return null;
  }
  return null;
}

function fieldCardForEffect(effect, context) {
  const owner = effect.controller === "opponent" ? 1 - context.owner : context.owner;
  const zone = effect.zone || "item";
  const card = state.players[owner]?.field?.[zone];
  if (!card || !matchesTargetFilter(card, owner, zone, effect.sourceFilter || effect.filter || {})) {
    if (effect.require !== false) {
      addLog(`${context.card.name}の効果で参照する場のカードがありません。`);
    }
    return null;
  }
  return { owner, zone, card };
}

function visibleFieldStat(card, stat) {
  if (stat === "power") {
    return visiblePower(card);
  }
  if (stat === "defense") {
    return visibleDefense(card);
  }
  return visibleCritical(card);
}

async function resolveTopTwoRevealOneOpponentRandomToHandOrGauge(effect, context) {
  const player = context.player;
  const cards = [];
  for (let index = 0; index < 2; index += 1) {
    const card = player.deck.pop();
    if (card) {
      cards.push(card);
    }
  }
  if (cards.length < 2) {
    player.hand.push(...cards);
    declareDeckLoss(player);
    return;
  }
  const selected = await chooseCardEntries(
    cards.map((card, index) => ({ card, index, owner: context.owner, source: "deck" })),
    {
      title: `${context.card.name}で公開するカード`,
      lead: "デッキの上から見た2枚のうち、公開するカードを1枚選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
    },
  );
  const revealed = selected?.[0]?.card || cards[0];
  const randomPick = cards[Math.floor(Math.random() * cards.length)];
  const destination = randomPick.name === revealed.name ? "hand" : "gauge";
  player[destination].push(...cards);
  addLog(
    `${context.card.name}で${revealed.name}を公開し、ランダムに選ばれた${randomPick.name}により2枚を${destination === "hand" ? "手札" : "ゲージ"}に置きました。`,
  );
  recordDiagnosticEvent("top_two_random_branch", {
    source: compactCardForLog(context.card),
    revealed: compactCardForLog(revealed),
    randomPick: compactCardForLog(randomPick),
    destination,
    cards: cards.map(compactCardForLog),
  });
}

async function statsToModifyForEffect(effect, context, amount) {
  if (Array.isArray(effect.chooseStat) && effect.chooseStat.length > 0) {
    const choices = effect.chooseStat.map((stat) => ({
      stat,
      card: {
        name: `${statLabel(stat)} +${amount}`,
        type: "choice",
      },
      note: statLabel(stat),
    }));
    const selected = await chooseCardEntries(choices, {
      title: `${context.card.name}の強化先`,
      lead: "強化する能力値を選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
    });
    return selected?.[0]?.stat ? [selected[0].stat] : [];
  }
  if (Array.isArray(effect.stats)) {
    return effect.stats;
  }
  return ["power", "defense", "critical"].filter((stat) => effect[stat]);
}

function statLabel(stat) {
  return {
    power: "攻撃力",
    defense: "防御力",
    critical: "打撃力",
  }[stat] || stat;
}

function applyStatBonus(card, prefix, stat, amount) {
  if (stat === "power") {
    card[`${prefix}PowerBonus`] += amount;
  }
  if (stat === "defense") {
    card[`${prefix}DefenseBonus`] += amount;
  }
  if (stat === "critical") {
    card[`${prefix}CriticalBonus`] += amount;
  }
}

// 量参照プリミティブ: ゲーム状態から効果量（スカラー）を算出する。
// source: fieldCardStat(場の1枚のvisible stat) / weaponPowerMax(自分武器の最大visiblePower) / dropCount(ドロップ枚数×per)。
function resolveAmountFrom(spec, context) {
  if (!spec || typeof spec !== "object") {
    return 0;
  }
  const ownerOf = (controller) => (controller === "opponent" ? 1 - context.owner : context.owner);
  if (spec.source === "selectedCardStat") {
    // script で選択した var のカードの visible stat（破壊直後のカードの打撃力参照などに使う）。
    const selected = scriptSelection({ var: spec.var }, context)[0]?.card;
    return selected ? visibleFieldStat(selected, spec.stat || "critical") : 0;
  }
  if (spec.source === "targetStat") {
    // 効果の対象($target)のカードの visible stat（破壊する対象のサイズ分ダメージ等）。size も読める。
    const tcard = context.target?.card;
    if (!tcard) return 0;
    return spec.stat === "size" ? tcard.size || 0 : visibleFieldStat(tcard, spec.stat || "critical");
  }
  if (spec.source === "fieldCardStat") {
    const owner = ownerOf(spec.controller);
    const zone = spec.zone || "item";
    const card = state.players[owner]?.field?.[zone];
    if (!card || !matchesTargetFilter(card, owner, zone, spec.sourceFilter || spec.filter || {})) {
      return 0;
    }
    return visibleFieldStat(card, spec.stat || "power");
  }
  if (spec.source === "weaponPowerMax") {
    const owner = ownerOf(spec.controller);
    const powers = zones
      .map((zone) => state.players[owner]?.field?.[zone])
      .filter((card) => card && effectiveCardType(card) === "item" && (card.attributes || []).includes("武器"))
      .map((card) => visiblePower(card));
    return powers.length > 0 ? Math.max(...powers) : 0;
  }
  if (spec.source === "dropCount") {
    const owner = ownerOf(spec.controller);
    const count = (state.players[owner]?.drop || []).filter((card) => matchesCardFilter(card, spec.filter || {})).length;
    const capped = spec.max !== undefined ? Math.min(count, spec.max) : count;
    return capped * (spec.per ?? 1);
  }
  return 0;
}

// modifyStats の増分 {power,defense,critical} を算出。amountFrom(スカラー) があれば applyTo の各statに同額、
// なければ by:{} もしくは旧来の直書き power/defense/critical を使う。
function modifyStatsDelta(effect, context) {
  if (effect.amountFrom && effect.amountFrom.source !== "dropAttributeCount") {
    const value = resolveAmountFrom(effect.amountFrom, context);
    const source = effect.by || effect;
    const applyTo = Array.isArray(effect.applyTo)
      ? effect.applyTo
      : ["power", "defense", "critical"].filter((stat) => source[stat]);
    const delta = { power: 0, defense: 0, critical: 0 };
    applyTo.forEach((stat) => {
      delta[stat] = value;
    });
    return delta;
  }
  const source = effect.by || effect;
  return {
    power: source.power || 0,
    defense: source.defense || 0,
    critical: source.critical || 0,
  };
}

function applyModifyStatsDelta(targetCard, duration, delta) {
  if (duration === "permanent") {
    targetCard.power = (targetCard.power || 0) + delta.power;
    targetCard.defense = (targetCard.defense || 0) + delta.defense;
    targetCard.critical = (targetCard.critical || 0) + delta.critical;
    return;
  }
  const prefix = duration === "turn" ? "turn" : "battle";
  targetCard[`${prefix}PowerBonus`] += delta.power;
  targetCard[`${prefix}DefenseBonus`] += delta.defense;
  targetCard[`${prefix}CriticalBonus`] += delta.critical;
}

function matchesRelativeCardFilter(card, filter = {}, context = {}) {
  if (filter.excludeSource && card.instanceId === context.card?.instanceId) {
    return false;
  }
  if (filter.sameInstanceAsSource && card.instanceId !== context.card?.instanceId) {
    return false;
  }
  if (filter.sameIdAsSource && card.id !== context.card?.id) {
    return false;
  }
  if (filter.sameNameAsSource && card.name !== context.card?.name) {
    return false;
  }
  const { excludeSource, sameInstanceAsSource, sameIdAsSource, sameNameAsSource, ...cardFilter } = filter;
  return matchesCardFilter(card, cardFilter);
}

function isAbilityLimitUsed(owner, card, ability) {
  const limit = normalizedAbilityLimit(ability);
  if (!limit) {
    return false;
  }
  const key = abilityLimitKey(card, ability, limit);
  if (limit.scope === "fight") {
    return Boolean(state.fightLimits?.[owner]?.[key]);
  }
  if (limit.scope === "turn") {
    return Boolean(state.players[owner].oncePerTurn[key]);
  }
  return false;
}

function markAbilityLimit(owner, card, ability) {
  const limit = normalizedAbilityLimit(ability);
  if (!limit) {
    return;
  }
  const key = abilityLimitKey(card, ability, limit);
  if (limit.scope === "fight") {
    state.fightLimits[owner][key] = true;
  }
  if (limit.scope === "turn") {
    state.players[owner].oncePerTurn[key] = true;
  }
}

function normalizedAbilityLimit(ability) {
  if (ability.limit) {
    return ability.limit;
  }
  if (hasAbilityKeyword(ability, "reversal")) {
    return { scope: "fight", key: "reversal" };
  }
  return null;
}

function abilityLimitKey(card, ability, limit) {
  return limit.key || ability.id || card.id;
}

const abilityHandlers = {};

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
  });
  return selected?.[0]?.index ?? -1;
}

async function chooseCardEntries(candidates, options = {}) {
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
  if (!canShowSelectionDialog()) {
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

    const setBoardPeek = (enabled) => {
      elements.selectionDialog.classList.toggle("selection-board-peek", enabled);
      if (elements.selectionBoardButton) {
        elements.selectionBoardButton.textContent = enabled ? "選択に戻る" : "盤面確認";
        elements.selectionBoardButton.title = enabled ? "選択ダイアログに戻る" : "盤面を確認";
        elements.selectionBoardButton.setAttribute("aria-pressed", String(enabled));
      }
      hideCardTooltip();
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
    candidates.forEach((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "selection-choice";
      button.dataset.choiceIndex = String(candidate.choiceIndex);
      button.innerHTML = selectionChoiceMarkup(candidate.card, index, candidate.note);
      attachTooltip(button, candidate.card);
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
  });
}

function selectionChoiceMarkup(card, index, note = "") {
  const meta = [
    card.no,
    typeLabels[effectiveCardType(card)] || typeLabels[card.type] || card.type,
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
    <span class="selection-choice-type">${escapeHtml(typeLabels[effectiveCardType(card)] || typeLabels[card.type] || card.type || "")}</span>
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

function renderEffectTargets() {
  const previous = elements.effectTarget.value;
  const selectedCard = getSelectedCard();
  const targets = effectTargetCandidates(selectedCard);
  elements.effectTarget.innerHTML = "";

  if (targets.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "効果対象なし";
    elements.effectTarget.append(option);
    elements.effectTarget.disabled = true;
    return;
  }

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "効果対象を選択";
  elements.effectTarget.append(placeholder);

  targets.forEach((target) => {
    const option = document.createElement("option");
    option.value = encodeTarget(target.owner, target.zone);
    option.textContent = `${state.players[target.owner].name} ${zoneLabel(target.zone)}：${target.card.name}`;
    elements.effectTarget.append(option);
  });
  elements.effectTarget.disabled = false;
  if (targets.some((target) => encodeTarget(target.owner, target.zone) === previous)) {
    elements.effectTarget.value = previous;
  } else {
    elements.effectTarget.value = "";
  }
}

function effectTargetCandidates(selectedCard) {
  if (!selectedCard) {
    return [];
  }
  if (cardCostRequiresOwnMonsterTarget(selectedCard)) {
    const owner = state.selected?.owner ?? state.active;
    const dropStep = Object.values(selectedCard?.costs || {})
      .flat()
      .find((step) => step.op === "dropOwnMonster");
    const stepFilter = dropStep?.filter || {};
    const excludeSelf = Boolean(dropStep?.excludeSource || stepFilter.excludeSource);
    return allFieldTargets(
      (card, targetOwner, zone) =>
        targetOwner === owner &&
        fieldZones.includes(zone) &&
        effectiveCardType(card) === "monster" &&
        (!excludeSelf || card.instanceId !== selectedCard?.instanceId) &&
        matchesCardFilter(card, stepFilter),
    );
  }
  if (selectedCard.callStack && state.selected?.source === "hand") {
    const nameIncludes = selectedCard.callStack.nameIncludes;
    const stackAttribute = selectedCard.callStack.attribute;
    return allFieldTargets(
      (card, owner) =>
        owner === state.active &&
        effectiveCardType(card) === "monster" &&
        (!nameIncludes || card.name.includes(nameIncludes)) &&
        (!stackAttribute || (card.attributes || []).includes(stackAttribute)),
    );
  }
  const genericAbility = firstTargetedAbilityForCurrentTiming(selectedCard);
  if (genericAbility?.target) {
    return targetCandidatesFromSpec(genericAbility.target, state.selected?.owner ?? state.active, {
      card: selectedCard,
      ability: genericAbility,
    });
  }
  return [];
}

function cardCostRequiresOwnMonsterTarget(card) {
  return Object.values(card?.costs || {})
    .flat()
    .some((step) => step.op === "dropOwnMonster");
}

function allFieldTargets(predicate) {
  const targets = [];
  state.players.forEach((player, owner) => {
    zones.forEach((zone) => {
      const card = player.field[zone];
      if (card && predicate(card, owner, zone)) {
        targets.push({ owner, zone, card });
      }
    });
  });
  return targets;
}

// 場の対象集合を scope(self/opponent/all)・filter・zones・excludeSource で一元的に収集する。
// destroy{scope} / modifyStats{scope} など全体対象 op の共通基盤（旧 destroyAll/modifyStatsAll の述語を統一）。
function collectFieldTargets(spec, context) {
  const scope = spec.scope || "all";
  const zoneList = Array.isArray(spec.zones) ? spec.zones : null;
  return allFieldTargets((card, owner, zone) => {
    if (zoneList && !zoneList.includes(zone)) {
      return false;
    }
    if (scope === "self" && owner !== context.owner) {
      return false;
    }
    if (scope === "opponent" && owner === context.owner) {
      return false;
    }
    if (spec.excludeSource && card.instanceId === context.card?.instanceId) {
      return false;
    }
    return matchesTargetFilter(card, owner, zone, spec.filter || {});
  });
}

function firstTargetedAbilityForCurrentTiming(card) {
  const timing = state.pendingAttack || state.pendingAction ? "counter" : state.phase;
  return (card.abilities || []).find((ability) => {
    if (!ability.target || !abilityTimingIncludes(ability, timing)) {
      return false;
    }
    if (state.selected?.source === "field") {
      return isFieldActivatedAbility(ability);
    }
    return canUseAbilityFromHand(ability);
  });
}

function targetCandidatesFromSpec(targetSpec, owner = state.selected?.owner ?? state.active, context = {}) {
  return targetCandidatesFromSpecForOwner(targetSpec, owner, context);
}

function targetMatchesSpec(target, targetSpec, specOwner, context = {}) {
  if (!target?.card || !targetSpec) {
    return false;
  }
  if (Array.isArray(targetSpec.anyOf)) {
    return targetSpec.anyOf.some((spec) => targetMatchesSpec(target, spec, specOwner, context));
  }
  if (!targetSourceConditionMatches(targetSpec, context)) {
    return false;
  }
  if (targetSpec.type === "fieldCard") {
    if (targetSpec.controller === "self" && target.owner !== specOwner) {
      return false;
    }
    if (targetSpec.controller === "opponent" && target.owner === specOwner) {
      return false;
    }
    return (
      targetAllowedByAbility(target.card, context) &&
      matchesTargetFilter(target.card, target.owner, target.zone, targetSpec.filter)
    );
  }
  if (targetSpec.type === "battleCard") {
    return targetCandidatesFromSpecForOwner(targetSpec, specOwner, context).some((candidate) =>
      sameSlot(candidate, target),
    );
  }
  return false;
}

function targetCandidatesFromSpecForOwner(targetSpec, specOwner, context = {}) {
  if (Array.isArray(targetSpec?.anyOf)) {
    return uniqueTargetEntries(
      targetSpec.anyOf.flatMap((spec) => targetCandidatesFromSpecForOwner(spec, specOwner, context)),
    );
  }
  if (!targetSpec || !targetSourceConditionMatches(targetSpec, context)) {
    return [];
  }
  if (targetSpec.type === "battleCard") {
    const pending = state.pendingAttack;
    if (!pending) {
      return [];
    }
    let targets = [];
    if (!targetSpec.role || targetSpec.role === "attacker") {
      targets.push(...getPendingAttackers());
    }
    if (!targetSpec.role || targetSpec.role === "defender") {
      const battleTarget = getPendingBattleTargetInfo(pending);
      if (battleTarget) {
        targets.push(battleTarget);
      }
    }
    return targets.filter(
      (target) =>
        targetAllowedByAbility(target.card, context) &&
        matchesTargetFilter(target.card, target.owner, target.zone, targetSpec.filter),
    );
  }
  if (targetSpec.type === "fieldCard") {
    return allFieldTargets((card, owner, zone) => {
      if (targetSpec.controller === "self" && owner !== specOwner) {
        return false;
      }
      if (targetSpec.controller === "opponent" && owner === specOwner) {
        return false;
      }
      if (targetSpec.excludeSource && card.instanceId === context.card?.instanceId) {
        return false;
      }
      return targetAllowedByAbility(card, context) && matchesTargetFilter(card, owner, zone, targetSpec.filter);
    });
  }
  return [];
}

function targetAllowedByAbility(card, context = {}) {
  if (!cannotReturnToHand(card)) {
    return true;
  }
  return !(context.ability?.effects || []).some(
    (effect) => effect.op === "returnToHand" && effect.target === "$target",
  );
}

function cannotReturnToHand(card) {
  if (!card) {
    return false;
  }
  if (card.cannotReturnToHand) {
    return true;
  }
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return false;
  }
  return state.players.some((player) =>
    zones.some((zone) => {
      const sourceCard = player.field[zone];
      return (sourceCard?.continuous || []).some(
        (effect) =>
          effect.op === "preventReturnToHand" &&
          continuousEffectApplies(effect, card, sourceCard),
      );
    }),
  );
}

function targetSourceConditionMatches(targetSpec, context = {}) {
  if (targetSpec.sourceSoulCountGte !== undefined) {
    return (context.card?.soul?.length || 0) >= targetSpec.sourceSoulCountGte;
  }
  return true;
}

function uniqueTargetEntries(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    const key = `${target.owner}:${target.zone}:${target.card?.instanceId || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function matchesTargetFilter(card, owner, zone, filter = {}) {
  if (!matchesCardFilter(card, filter)) {
    return false;
  }
  if (filter.buddy && card.name !== state.players[owner]?.buddy?.name) {
    return false;
  }
  if (filter.zone && zone !== filter.zone) {
    return false;
  }
  if (filter.zoneIn && !filter.zoneIn.includes(zone)) {
    return false;
  }
  if (filter.zoneNot && zone === filter.zoneNot) {
    return false;
  }
  return true;
}

function matchesCardFilter(card, filter = {}) {
  if (!card) {
    return false;
  }
  if (Array.isArray(filter.anyOf) && filter.anyOf.length > 0) {
    const rest = { ...filter };
    delete rest.anyOf;
    return filter.anyOf.some((candidate) => matchesCardFilter(card, { ...rest, ...candidate }));
  }
  if (filter.cardType && effectiveCardType(card) !== filter.cardType) {
    return false;
  }
  if (filter.cardTypeIn && !filter.cardTypeIn.includes(effectiveCardType(card))) {
    return false;
  }
  if (filter.world && card.world !== filter.world) {
    return false;
  }
  if (filter.powerLte !== undefined && visiblePower(card) > filter.powerLte) {
    return false;
  }
  if (filter.powerGte !== undefined && visiblePower(card) < filter.powerGte) {
    return false;
  }
  if (filter.defenseLte !== undefined && visibleDefense(card) > filter.defenseLte) {
    return false;
  }
  if (filter.defenseGte !== undefined && visibleDefense(card) < filter.defenseGte) {
    return false;
  }
  if (filter.criticalGte !== undefined && visibleCritical(card) < filter.criticalGte) {
    return false;
  }
  if (filter.criticalLte !== undefined && visibleCritical(card) > filter.criticalLte) {
    return false;
  }
  if (filter.sizeLte !== undefined && (card.size || 0) > filter.sizeLte) {
    return false;
  }
  if (filter.sizeGte !== undefined && (card.size || 0) < filter.sizeGte) {
    return false;
  }
  if (filter.sizeIn && !filter.sizeIn.includes(card.size || 0)) {
    return false;
  }
  if (filter.attribute && !card.attributes?.includes(filter.attribute)) {
    return false;
  }
  if (filter.attributeIn && !filter.attributeIn.some((attribute) => card.attributes?.includes(attribute))) {
    return false;
  }
  if (filter.attributeIncludes && !card.attributes?.some((attribute) => attribute.includes(filter.attributeIncludes))) {
    return false;
  }
  if (
    filter.attributeIncludesAny &&
    !filter.attributeIncludesAny.some((needle) => card.attributes?.some((attribute) => attribute.includes(needle)))
  ) {
    return false;
  }
  if (filter.name && card.name !== filter.name) {
    return false;
  }
  if (filter.nameIn && !filter.nameIn.includes(card.name)) {
    return false;
  }
  if (filter.nameIncludes && !card.name.includes(filter.nameIncludes)) {
    return false;
  }
  if (filter.nameNot && card.name === filter.nameNot) {
    return false;
  }
  if (filter.keyword && !hasKeyword(card, filter.keyword)) {
    return false;
  }
  if (filter.standing !== undefined && Boolean(card.used) === Boolean(filter.standing)) {
    return false;
  }
  if (filter.soulCountLte !== undefined && (card.soul?.length || 0) > filter.soulCountLte) {
    return false;
  }
  if (filter.soulCountGte !== undefined && (card.soul?.length || 0) < filter.soulCountGte) {
    return false;
  }
  return true;
}

function matchingCardsFromPile(pile, filter = {}) {
  return (pile || []).filter((card) => matchesCardFilter(card, filter));
}

function takeMatchingCards(pile, filter = {}, amount = 1, excludedCard = null) {
  const movedCards = [];
  for (let index = pile.length - 1; index >= 0 && movedCards.length < amount; index -= 1) {
    const card = pile[index];
    if (card.instanceId === excludedCard?.instanceId) {
      continue;
    }
    if (matchesCardFilter(card, filter)) {
      movedCards.push(pile.splice(index, 1)[0]);
    }
  }
  return movedCards;
}

function encodeTarget(owner, zone) {
  return `${owner}:${zone}`;
}

function getEffectTargetInfo() {
  return getTargetInfoFromValue(elements.effectTarget.value);
}

function getTargetInfoFromValue(value) {
  if (!value) {
    return null;
  }
  const [ownerText, zone] = value.split(":");
  const owner = Number(ownerText);
  return getFieldTarget(owner, zone);
}

function getFieldTarget(owner, zone) {
  const card = state.players[owner]?.field[zone];
  return card ? { owner, zone, card } : null;
}

function renderLog() {
  elements.logList.innerHTML = "";
  state.log.forEach((entry) => {
    const item = document.createElement("li");
    item.textContent = entry;
    elements.logList.append(item);
  });
}

function showCardTooltip(card, event) {
  const tooltipHost = elements.selectionDialog?.open ? elements.selectionDialog : document.body;
  if (tooltipHost?.append && elements.cardTooltip.parentElement !== tooltipHost) {
    tooltipHost.append(elements.cardTooltip);
  }
  elements.cardTooltip.innerHTML = cardTooltipHtml(card);
  elements.cardTooltip.setAttribute("aria-hidden", "false");
  elements.cardTooltip.classList.add("visible");
  moveCardTooltip(event);
}

function moveCardTooltip(event) {
  if (!elements.cardTooltip.classList.contains("visible")) {
    return;
  }
  const rect = elements.cardTooltip.getBoundingClientRect();
  const sourceRect = event.currentTarget?.getBoundingClientRect?.();
  const fallbackX = sourceRect ? sourceRect.right : 20;
  const fallbackY = sourceRect ? sourceRect.top : 20;
  const cursorX = typeof event.clientX === "number" ? event.clientX : fallbackX;
  const cursorY = typeof event.clientY === "number" ? event.clientY : fallbackY;
  const x = Math.min(window.innerWidth - rect.width - 14, cursorX + 16);
  const y = Math.min(window.innerHeight - rect.height - 14, cursorY + 16);
  elements.cardTooltip.style.left = `${Math.max(10, x)}px`;
  elements.cardTooltip.style.top = `${Math.max(10, y)}px`;
}

function hideCardTooltip() {
  elements.cardTooltip?.classList.remove("visible");
  elements.cardTooltip?.setAttribute("aria-hidden", "true");
  if (document.body?.append && elements.cardTooltip?.parentElement !== document.body) {
    document.body.append(elements.cardTooltip);
  }
}

function cardTooltipHtml(card) {
  const soulNames = stackedCardNames(card);
  const soulList = soulNames.length
    ? `<div class="tooltip-rules tooltip-soul">
        <strong>下に重なっているカード</strong>
        <ul>${soulNames.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul>
      </div>`
    : "";
  const rows = [
    ["カード番号", card.no],
    ["製品", card.productName],
    ["種類", typeLabel(card)],
    ["ワールド", card.world],
    ["属性", card.attributes?.join(" / ") || "-"],
    ["サイズ", statLabel(card.size)],
    ["攻撃力", statLabel(visiblePower(card))],
    ["打撃力", statLabel(visibleCritical(card))],
    ["防御力", statLabel(visibleDefense(card))],
    ["ソウル", String(card.soul?.length || 0)],
    ["レアリティ", card.rarity],
    ["コスト", costLabel(card)],
  ];
  return `
    <div class="tooltip-head">
      <strong>${escapeHtml(card.name)}</strong>
      <span>${escapeHtml(card.no || "")}</span>
    </div>
    <dl>
      ${rows
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "-")}</dd></div>`)
        .join("")}
    </dl>
    <div class="tooltip-rules">
      <strong>効果</strong>
      <ul>
        ${cardRules(card).map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}
      </ul>
    </div>
    ${soulList}
  `;
}

function effectImplementationLabel(card) {
  return cardRules(card).join(" ");
}

function cardRules(card) {
  return card.rules?.length ? card.rules : ["能力なし。"];
}

function effectiveCardType(card) {
  return card.currentType || card.type;
}

function typeLabel(card) {
  const current = effectiveCardType(card);
  if (card.baseType && card.baseType !== current) {
    return `${typeLabels[card.baseType]} / ${typeLabels[current]}扱い`;
  }
  return typeLabels[current];
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
  return labels.join(" / ") || "-";
}

function primaryStructuredCost(card) {
  return card.costs?.call || card.costs?.cast || card.costs?.equip || card.costs?.arrival || null;
}

function costStepLabel(step) {
  const amount = step.amount || 1;
  return {
    payGauge: `ゲージ${amount}`,
    discardHand: `手札${amount}`,
    payLife: `ライフ${amount}`,
    cancelRecentLifeLink: "ライフリンク無効化",
    cancelLifeLink: "ライフリンク無効化",
    cancelCallOpportunityLifeLink: "ライフリンク無効化",
    putTopDeckToSoul: `デッキ上${amount}枚をソウル`,
    putDropToSoul: `ドロップ${amount}枚をソウル`,
    putTopDeckToGauge: `デッキ上${amount}枚をゲージ`,
    discardSoul: `ソウル${amount}枚を捨てる`,
    dropOwnMonster: `自分のモンスター${amount}枚をドロップ`,
    putHandToSoul: `手札${amount}枚をソウル`,
    putOwnFieldCardsToGauge: `自分の場のカード${amount}枚をゲージ`,
  }[step.op] || step.op;
}

function primaryCost(card) {
  if (hasCost(card.callCost)) {
    return card.callCost;
  }
  if (hasCost(card.castCost)) {
    return card.castCost;
  }
  if (hasCost(card.equipCost)) {
    return card.equipCost;
  }
  return null;
}

function hasCost(cost = {}) {
  return Boolean(cost.gauge || cost.discard);
}

function statLabel(value) {
  return value || value === 0 ? String(value) : "-";
}

function targetLabel(pending) {
  if (pending.targetType === "fighter") {
    return `${state.players[pending.defender].name}本体`;
  }
  const card = state.players[pending.targetOwner].field[pending.targetZone];
  return card ? `${zoneLabel(pending.targetZone)}の${card.name}` : zoneLabel(pending.targetZone);
}

function handPlayerRole(owner) {
  if (state.pendingAction) {
    return owner === state.pendingAction.owner ? "行動側" : "対抗側";
  }
  if (!state.pendingAttack) {
    return "";
  }
  return owner === state.pendingAttack.attackerOwner ? "攻撃側" : "防御側";
}

function hasKeyword(card, keyword) {
  if (!card) {
    return false;
  }
  if (keyword === "lifeLink") {
    return lifeLinkAmount(card) > 0 || hasInstantLifeLink(card);
  }
  if (isKeywordPrevented(card, keyword)) {
    return false;
  }
  if (
    (card.turnSuppressedKeywords || []).some((candidate) =>
      keywordAliases(keyword).includes(candidate),
    )
  ) {
    return false;
  }
  if (keyword === "counterattack" && card.counterattack) {
    return true;
  }
  const aliases = keywordAliases(keyword);
  const slot = findFieldCardSlot(card);
  return (
    (card.keywords || []).some((candidate) => aliases.includes(candidate)) ||
    (card.temporaryKeywords || []).some((candidate) => aliases.includes(candidate)) ||
    (card.turnKeywords || []).some((candidate) => aliases.includes(candidate)) ||
    (slot &&
      state.players.some((player) =>
        zones.some((zone) => {
          const sourceCard = player.field[zone];
          return (sourceCard?.continuous || []).some(
            (effect) =>
              effect.op === "grantKeyword" &&
              aliases.includes(effect.keyword) &&
              continuousEffectApplies(effect, card, sourceCard),
          );
        }),
      )) ||
    (slot &&
      soulContinuousEffects(card, slot.owner).some(
        ({ effect, sourceCard }) =>
          effect.op === "grantKeyword" &&
          aliases.includes(effect.keyword) &&
          continuousEffectAppliesFromSoul(effect, card, sourceCard, slot.owner),
      )) ||
    (card.abilities || []).some(
      (ability) => hasAbilityKeyword(ability, keyword) && passiveAbilityConditionsMet(card, ability),
    )
  );
}

// センターへのモンスターコールを禁止する継続効果（爆斧 リクドウ斬魔・決戦闘技 MAJI斬魔）
// controller:"self" は発生源の持ち主のみ対象、未指定は両者。sizeLte でサイズ上限を指定可。
function isCenterCallPrevented(callerOwner, card) {
  return state.players.some((player, pIdx) =>
    zones.some((zone) => {
      const source = player.field[zone];
      return (source?.continuous || []).some((effect) => {
        if (effect.op !== "preventCenterCall") {
          return false;
        }
        if (effect.controller === "self" && pIdx !== callerOwner) {
          return false;
        }
        if (effect.sizeLte !== undefined && (card.size ?? 0) > effect.sizeLte) {
          return false;
        }
        return true;
      });
    }),
  );
}

function isKeywordPrevented(card, keyword) {
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return false;
  }
  const aliases = keywordAliases(keyword);
  return state.players.some((player) =>
    zones.some((zone) => {
      const sourceCard = player.field[zone];
      return (sourceCard?.continuous || []).some(
        (effect) =>
          effect.op === "preventKeyword" &&
          aliases.includes(effect.keyword) &&
          continuousEffectApplies(effect, card, sourceCard),
      );
    }),
  );
}

function passiveAbilityConditionsMet(card, ability) {
  if (!ability.conditions?.length) {
    return true;
  }
  const slot = findFieldCardSlot(card);
  if (!slot) {
    return false;
  }
  return ability.conditions.every((condition) => {
    if (condition.op === "sourceZoneIn") {
      return condition.zones?.includes(slot.zone);
    }
    return checkCondition(condition, slot.owner, {
      card,
      owner: slot.owner,
      zone: slot.zone,
    });
  });
}

function findFieldCardSlot(card) {
  if (!state?.players || !card) {
    return null;
  }
  for (const [owner, player] of state.players.entries()) {
    for (const zone of zones) {
      if (player.field[zone]?.instanceId === card.instanceId) {
        return { owner, zone };
      }
    }
  }
  return null;
}

function hasAbilityKeyword(ability, keyword) {
  const aliases = keywordAliases(keyword);
  return aliases.includes(ability.keyword) || aliases.includes(ability.kind);
}

function findKeywordAbility(card, keyword) {
  return (card.abilities || []).find((ability) => hasAbilityKeyword(ability, keyword));
}

function keywordAliases(keyword) {
  return {
    arrival: ["arrival", "着任"],
    reversal: ["reversal", "逆天"],
    soulguard: ["soulguard", "ソウルガード"],
    canAttackWithCenter: ["canAttackWithCenter", "センター攻撃可"],
    canAttackFighterThroughCenter: ["canAttackFighterThroughCenter", "センター越し本体攻撃"],
    dropOpponentMonsterSoulOnAttack: ["dropOpponentMonsterSoulOnAttack", "攻撃時ソウル落とし"],
    cannotBeLinkAttacked: ["cannotBeLinkAttacked", "連携攻撃されない"],
    move: ["move", "移動"],
    penetrate: ["penetrate", "貫通"],
    doubleAttack: ["doubleAttack", "2回攻撃", "２回攻撃"],
    tripleAttack: ["tripleAttack", "3回攻撃", "３回攻撃"],
    lifeLink: ["lifeLink"],
  }[keyword] || [keyword];
}

// 1攻撃中に何度でも使える例外カウンター種別（同一 kind を連続使用する限り無制限）。
// 旧来は "dragoenergy" を id/effect 直書きで判定していたが、種別名の集合として一般化した。
const REPEATABLE_COUNTER_KINDS = new Set(["dragoenergy"]);

function isRepeatableCounterKind(kind) {
  return Boolean(kind) && REPEATABLE_COUNTER_KINDS.has(kind);
}

function canUseCounterEffect(owner, effect) {
  const pending = state.pendingAttack || state.pendingAction;
  if (!pending) {
    return false;
  }
  const usedKind = pending.counterUsed?.[owner];
  if (!usedKind) {
    return true;
  }
  // 直前と同一の repeatable 種別（=ドラゴエナジー等）かつ攻撃中のみ再使用を許可。
  return Boolean(state.pendingAttack && usedKind === effect && isRepeatableCounterKind(effect));
}

function markCounterUsed(owner, kind) {
  const pending = state.pendingAttack || state.pendingAction;
  if (!pending) {
    return;
  }
  pending.counterUsed = {
    ...(pending.counterUsed || {}),
    [owner]: kind,
  };
}

function zoneLabel(zone) {
  return {
    left: "レフト",
    center: "センター",
    right: "ライト",
    set1: "配置魔法1",
    set2: "配置魔法2",
    item: "アイテム",
  }[zone];
}

function isNetworkPage() {
  return Boolean(elements.netplayPanel);
}

function isNetworkConnected() {
  return Boolean(networkSession.connected && Number.isInteger(networkSession.seat));
}

function updateNetworkStatus(message) {
  if (elements.networkStatus) {
    elements.networkStatus.textContent = message;
  }
}

async function createNetworkRoom() {
  try {
    updateNetworkStatus("部屋を作成しています...");
    const response = await fetch("api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deckValues: currentDeckValues() }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "部屋を作成できませんでした。");
    }
    startNetworkSession(data);
  } catch (error) {
    updateNetworkStatus(`接続失敗: ${error.message}`);
  }
}

async function joinNetworkRoom() {
  const roomId = elements.roomInput.value.trim();
  if (!roomId) {
    updateNetworkStatus("参加する部屋番号を入力してください。");
    return;
  }
  try {
    updateNetworkStatus("部屋に参加しています...");
    const response = await fetch(`api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deckValues: currentDeckValues() }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "部屋に参加できませんでした。");
    }
    startNetworkSession(data);
  } catch (error) {
    updateNetworkStatus(`接続失敗: ${error.message}`);
  }
}

function startNetworkSession(data) {
  networkSession.connected = true;
  networkSession.roomId = data.roomId;
  networkSession.token = data.token;
  networkSession.seat = data.playerIndex;
  networkSession.lastSeq = 0;
  elements.roomInput.value = data.roomId;
  elements.copyRoomButton.disabled = false;
  elements.playerSeatLabel.textContent = `席: ${networkPlayerName(networkSession.seat)}`;
  applyDeckValues(data.deckValues);
  updateNetworkStatus(`部屋 ${data.roomId} に接続しました。`);
  connectNetworkEvents();
  render();
}

function connectNetworkEvents() {
  networkSession.eventSource?.close();
  const url = `api/rooms/${encodeURIComponent(networkSession.roomId)}/events?token=${encodeURIComponent(networkSession.token)}`;
  const source = new EventSource(url);
  networkSession.eventSource = source;
  source.addEventListener("message", (event) => {
    applyNetworkMessage(JSON.parse(event.data));
  });
  source.addEventListener("error", () => {
    updateNetworkStatus("接続が切れました。サーバーを確認してください。");
  });
}

function applyNetworkMessage(message) {
  if (!message || (message.type !== "hello" && message.seq <= networkSession.lastSeq)) {
    return;
  }
  networkSession.lastSeq = Math.max(networkSession.lastSeq, message.seq || 0);
  if (message.type === "hello") {
    applyDeckValues(message.deckValues);
    if (message.snapshot) {
      applyNetworkSnapshot(message.snapshot);
    }
    return;
  }
  if (message.type === "deck") {
    applyDeckValues(message.deckValues);
    updateNetworkStatus(`部屋 ${networkSession.roomId}: デッキ選択を同期しました。`);
    render();
    return;
  }
  if (message.type === "hidden_choice_request") {
    handleRemoteNetworkChoiceRequest(message);
    return;
  }
  if (message.type === "hidden_choice_response") {
    resolveRemoteNetworkChoice(message);
    return;
  }
  if (message.type === "snapshot" && message.sender !== networkSession.token) {
    applyDeckValues(message.deckValues);
    applyNetworkSnapshot(message.snapshot);
    updateNetworkStatus(`部屋 ${networkSession.roomId}: ${message.label || "盤面"}を同期しました。`);
  }
}

function applyNetworkSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  networkSession.applyingSnapshot = true;
  state = deepClone(snapshot);
  state.selected = null;
  state.linkAttackers = [];
  networkSession.applyingSnapshot = false;
  render();
}

function createNetworkChoiceRequestId() {
  return `choice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function requestRemoteNetworkChoice(targetSeat, choices, options = {}) {
  if (!isNetworkConnected() || networkSession.seat === targetSeat) {
    return null;
  }
  const requestId = createNetworkChoiceRequestId();
  const choice = await new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      networkSession.pendingChoiceResolvers.delete(requestId);
      updateNetworkStatus("相手の選択待ちが時間切れになりました。");
      resolve(null);
    }, 60 * 1000);
    networkSession.pendingChoiceResolvers.set(requestId, {
      resolve: (selectedChoice) => {
        clearTimeout(timeoutId);
        resolve(selectedChoice);
      },
    });
    sendNetworkMessage("hidden_choice_request", {
      requestId,
      targetSeat,
      title: options.title || "選択",
      lead: options.lead || "",
      choices: choices.map(({ key, card }) => ({
        key,
        card: {
          name: card.name,
          type: card.type || "choice",
        },
      })),
    }).then((sent) => {
      if (!sent) {
        const pending = networkSession.pendingChoiceResolvers.get(requestId);
        networkSession.pendingChoiceResolvers.delete(requestId);
        pending?.resolve(null);
      }
    });
  });
  return choice;
}

async function handleRemoteNetworkChoiceRequest(message) {
  if (
    message.targetSeat !== networkSession.seat ||
    !message.requestId ||
    networkSession.handledChoiceRequests.has(message.requestId)
  ) {
    return;
  }
  networkSession.handledChoiceRequests.add(message.requestId);
  const choices = (message.choices || []).map(({ key, card }) => ({
    key,
    card: {
      name: card?.name || String(key),
      type: card?.type || "choice",
    },
  }));
  updateNetworkStatus("相手の効果で選択を求められています。");
  const selected = await chooseCardEntries(choices, {
    title: message.title || "選択",
    lead: message.lead || "",
    min: 1,
    max: 1,
    forceDialog: true,
    allowCancel: false,
  });
  await sendNetworkMessage("hidden_choice_response", {
    requestId: message.requestId,
    choice: selected?.[0]?.key || null,
  });
  updateNetworkStatus(`部屋 ${networkSession.roomId}: 選択を送信しました。`);
}

function resolveRemoteNetworkChoice(message) {
  const pending = networkSession.pendingChoiceResolvers.get(message.requestId);
  if (!pending) {
    return;
  }
  networkSession.pendingChoiceResolvers.delete(message.requestId);
  pending.resolve(message.choice || null);
}

async function sendNetworkMessage(type, payload) {
  if (!isNetworkConnected()) {
    return false;
  }
  try {
    const response = await fetch(`api/rooms/${encodeURIComponent(networkSession.roomId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: networkSession.token,
        type,
        payload,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "同期に失敗しました。");
    }
    return true;
  } catch (error) {
    updateNetworkStatus(`同期失敗: ${error.message}`);
    return false;
  }
}

async function runNetworkMutation(label, callback) {
  const beforeSummary = compactFightStateForLog({ includeDeckOrder: false });
  if (!isNetworkConnected() || networkSession.applyingSnapshot) {
    await callback();
    recordDiagnosticEvent("user_action", {
      label,
      changed: JSON.stringify(beforeSummary) !== JSON.stringify(compactFightStateForLog({ includeDeckOrder: false })),
      before: beforeSummary,
      after: compactFightStateForLog({ includeDeckOrder: false }),
    });
    return;
  }
  const before = JSON.stringify(state);
  await callback();
  const changed = JSON.stringify(state) !== before;
  recordDiagnosticEvent("user_action", {
    label,
    changed,
    before: beforeSummary,
    after: compactFightStateForLog({ includeDeckOrder: false }),
  });
  if (changed) {
    sendNetworkMessage("snapshot", {
      label,
      snapshot: state,
      deckValues: currentDeckValues(),
    });
  }
}

function syncNetworkDeckChoice(playerIndex) {
  if (!isNetworkConnected() || networkSession.seat !== playerIndex) {
    return;
  }
  sendNetworkMessage("deck", {
    playerIndex,
    deckValues: currentDeckValues(),
  });
}

function networkPlayerName(index) {
  return index === 0 ? "プレイヤー1" : "プレイヤー2";
}

async function copyRoomId() {
  if (!networkSession.roomId) {
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(networkSession.roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    updateNetworkStatus("参加URLをクリップボードにコピーしました。");
  } catch {
    elements.roomInput.select();
    updateNetworkStatus("コピーできないため、部屋番号欄を選択しました。");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.querySelectorAll(".zone.field").forEach((zoneButton) => {
  zoneButton.addEventListener("click", () => {
    selectFieldCard(Number(zoneButton.dataset.owner), zoneButton.dataset.zone);
  });
});

document.querySelectorAll(".drop-zone").forEach((zoneButton) => {
  zoneButton.addEventListener("click", () => {
    showDropDialog(Number(zoneButton.dataset.owner));
  });
});

document.querySelectorAll("[data-call-zone]").forEach((button) => {
  button.addEventListener("click", () =>
    runNetworkMutation("コール", () => callMonster(button.dataset.callZone)),
  );
});

elements.newGameButton.addEventListener("click", () => runNetworkMutation("新規ゲーム", newGame));
elements.exportLogButton?.addEventListener("click", downloadBattleLog);
elements.rulesButton.addEventListener("click", () => elements.rulesDialog.showModal());
elements.closeRulesButton.addEventListener("click", () => elements.rulesDialog.close());
elements.closeDropDialogButton?.addEventListener("click", () => elements.dropDialog?.close());
elements.dropDialog?.addEventListener("close", hideCardTooltip);
elements.drawButton.addEventListener("click", () => runNetworkMutation("ドロー", drawAction));
elements.chargeButton.addEventListener("click", () => runNetworkMutation("チャージ&ドロー", chargeAction));
elements.mainPhaseButton.addEventListener("click", () => runNetworkMutation("メインフェイズ", goMainPhase));
elements.castButton.addEventListener("click", () => runNetworkMutation("カード使用", useCardAction));
elements.resolveAttackButton.addEventListener("click", () => runNetworkMutation("解決", resolvePendingResolution));
elements.counterHandButton.addEventListener("click", toggleCounterHand);
elements.attackPhaseButton.addEventListener("click", () => runNetworkMutation("アタックフェイズ", goAttackPhase));
elements.linkToggleButton.addEventListener("click", toggleLinkAttacker);
elements.finalPhaseButton.addEventListener("click", () => runNetworkMutation("ファイナルフェイズ", goFinalPhase));
elements.attackButton.addEventListener("click", () => runNetworkMutation("攻撃宣言", attackAction));
elements.endTurnButton.addEventListener("click", () => runNetworkMutation("ターン終了", endTurn));
elements.partnerCallButton.addEventListener("click", partnerCall);
elements.attackTarget.addEventListener("change", renderActions);
elements.effectTarget.addEventListener("change", renderActions);
elements.p1DeckSelect.addEventListener("change", () => syncNetworkDeckChoice(0));
elements.p2DeckSelect.addEventListener("change", () => syncNetworkDeckChoice(1));
elements.createRoomButton?.addEventListener("click", createNetworkRoom);
elements.joinRoomButton?.addEventListener("click", joinNetworkRoom);
elements.copyRoomButton?.addEventListener("click", copyRoomId);

if (globalThis.__BUDDYFIGHT_TEST__) {
  globalThis.__buddyfightTestApi = {
    adjustedCostSteps,
    applyAttackRedirectContinuous,
    applyDamageToPlayer,
    applicableAttackResistances,
    callMonster,
    canDeclareAttack,
    checkAbilityConditions,
    createInstanceId,
    visiblePower,
    destroyFieldCard,
    executeAbilityBody,
    hasKeyword,
    findUsableHandAbility,
    getState: () => state,
    legacyAbilityScriptDefinition,
    selectedCounterKind,
    canUseCounterEffect,
    markCounterUsed,
    isRepeatableCounterKind,
    executeAbilityEffect,
    matchesCardFilter,
    canAttackTargetValue,
    applyAttackTaxes,
    dropOwnMonsterCostCandidates,
    payStructuredCost,
    canPayStructuredCost,
    discardHandCardsToDrop,
    linkAttackDamageCapFor,
    continuousPowerBonus,
    continuousDefenseBonus,
    continuousCriticalBonus,
    normalizeCardDefinition,
    applyNetworkMessage,
    resolveRockPaperScissors,
    resolveOnEnter,
    resolvePendingResolution,
    setState: (nextState) => {
      state = nextState;
    },
    setNetworkSession: (values) => {
      networkSession = {
        ...networkSession,
        ...values,
      };
    },
    useCardAction,
  };
} else {
  initializeApp();
}

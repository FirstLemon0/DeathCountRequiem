// ==========================================================================
// buddyfight モジュール 02 — データ読込・正規化・レガシー互換
// 旧 app.js L125-586 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
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

  // カードid→画像パック名(=カードJSONファイル名stem)。render の画像遅延読込で使う。
  cardIdToPack = {};
  // ワールド名→代表印字フラッグの画像参照。対戦画面のフラッグ絵表示のためだけの索引（表示専用）。
  flagImageRefByName = {};
  cardLibrary = [
    ...flags,
    ...cardSets.flatMap(({ set, data }) => {
      const packName = (set.file || "").split("/").pop().replace(/\.json$/, "");
      const defs = [];
      (data.cards || []).forEach((card) => {
        const def = normalizeCardDefinition(card, set);
        // 画像パック索引は全カード（印字フラッグ含む）で登録する。cardIdToPack は画像解決専用で
        // ルール/デッキ判定の cardLibrary とは独立なので、除外対象フラッグを含めても互換に影響しない。
        if (packName && def.id) {
          cardIdToPack[def.id] = packName;
        }
        // 印字フラッグ(type:"flag")の絵をワールド名で索引化（基底フラッグの代表絵として使う）。
        // 複数候補は preference で 1 枚に決める（小さいスターターパックの原典絵を優先）。
        if (def.type === "flag" && def.name && packName) {
          const score = flagImagePackPreference(packName);
          const prev = flagImageRefByName[def.name];
          if (!prev || score > prev.score) {
            flagImageRefByName[def.name] = {
              id: def.id,
              no: def.no || null,
              imageUrl: def.imageUrl || null,
              score,
            };
          }
        }
        // R7(X-BT01/0128 ドラゴン・ドライ): deckable:true の flag はデッキ投入可＝cardLibrary に含める
        // （手札の handLifeZeroReplacement=FE1 が読むため）。通常の表示専用 flag は従来どおり除外。
        if (def.type !== "flag" || card.deckable === true) {
          defs.push(def);
        }
      });
      return defs;
    }),
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
  // データJSONはバージョン付きURL(?v=…)＋ブラウザキャッシュに載せて毎回の再取得を避ける
  // （旧 cache:"no-store" はカードJSON 3MB超を毎回落とし直していた）。ローダHTMLが
  // globalThis.__BUDDYFIGHT_DATA_VERSION=ENGINE_VERSION を定義した時だけ ?v= を付ける。
  // 未定義の環境（旧ローダ・FSスタブのみのvm）では従来どおり no-store にフォールバックし挙動を変えない。
  const version = globalThis.__BUDDYFIGHT_DATA_VERSION;
  const url = version ? `${path}${path.includes("?") ? "&" : "?"}v=${version}` : path;
  const response = await fetch(url, version ? undefined : { cache: "no-store" });
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
  const keywords = [...(card.keywords || [])];
  // 旧・搭乗/変身モンスターは keywords:["ride"|"henshin"] を明記せず、ability id 規約(-ride-*/-rideout/-henshin-*)
  // だけで実装されている場合がある。搭乗/変身判別フィルタ(keyword:"ride"/"henshin")や hasKeyword が正しく拾えるよう補完する。
  (card.abilities || []).forEach((ability) => {
    const id = ability?.id || "";
    if (!keywords.includes("ride") && /-ride(-|out)/.test(id)) {
      keywords.push("ride");
    }
    if (!keywords.includes("henshin") && /-henshin(-|$)/.test(id)) {
      keywords.push("henshin");
    }
  });
  return desugarCardFlags({
    ...card,
    productId: card.productId || set.id || "",
    productName: card.productName || set.name || "",
    aliases: [...(card.aliases || [])],
    attributes: [...(card.attributes || [])],
    keywords,
    rules: [...(card.rules || [])],
    // 印字の恒久additionalNames（例: 0022の「武神竜王 デュエルズィーガー」）をベースラインとして保持する。
    // gainNameAsSelected等のターンスコープ付与名はclearTurnModifiers/resetLeftFieldCardStateで
    // additionalNamesごと[]にリセットされるため、印字名を消さず復元できるよう別枠に控えておく。
    printedAdditionalNames: [...(card.additionalNames || [])],
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

// 同名フラッグの絵が複数パックにある時、代表 1 枚を選ぶための優先度（高いほど優先）。
// 対戦画面のフラッグ絵は「そのワールドの原典的な絵」で十分なので、画像も軽い旧トライアルデッキ
// (td*/ss01)・各世代スターター(td/sd)を優先し、巨大な PR パックは最後の手段にする（読込コスト抑制）。
function flagImagePackPreference(packName) {
  const p = String(packName || "");
  if (/^td\d/.test(p)) return 5; // 旧トライアルデッキ（最小・原典の絵）
  if (/^ss01/.test(p)) return 4;
  if (/^bf-[hdx]-(td|sd)\d/.test(p)) return 3; // 各世代スターター/トライアル
  if (/^bf-zd\d/.test(p)) return 2; // WHF配布デッキ
  if (/^bf-hd-pr$/.test(p) || /^bf-s-pr$/.test(p)) return 0; // 巨大 PR パック（最後の手段）
  return 1;
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
    // デッキ選択モーダル(deck-picker.js)用のメタ。decksets.json 由来（無ければ既定値で従来どおり）。
    category: deck.category || set.category || (set.id === "custom" ? "custom" : "official"),
    series: deck.series || set.series || "",
    releaseOrder: deck.releaseOrder ?? set.releaseOrder ?? 9999,
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


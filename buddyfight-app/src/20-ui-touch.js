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
// ソウル詳細モード: ソウル一覧から選んだカードの詳細＋そのカードが持つ「今使える能力」のボタンを出す。
// ホスト（そのソウルを持つ場のカード）経由で発動するので owner/zone も覚えておく。
let cardSheetSoulContext = null;
// 操作シート（スマホでカードをタップした時）: { card, items, onClose }。items は「今できること」だけ
// （PC の下部メニューと同じ規則で絞った presentCardActions の items）。閉じる＝onClose（選択解除）。
let cardSheetActionContext = null;

function cardSheetCard() {
  if (cardSheetActionContext) {
    return cardSheetActionContext.card;
  }
  if (cardSheetSoulContext) {
    return cardSheetSoulContext.soulCard;
  }
  if (cardSheetReadOnly) {
    return cardSheetReadOnlyCard;
  }
  return getSelectedCard();
}

// ソウルのカード1枚を詳細表示する（下に使える能力のボタン／使えないなら理由が出る）。
function openSoulCardSheet(owner, zone, soulCard) {
  if (!elements.cardSheet || !soulCard) {
    return;
  }
  cardSheetReadOnly = false;
  cardSheetReadOnlyCard = null;
  cardSheetActionContext = null;
  cardSheetSoulContext = { owner, zone, soulCard };
  refreshCardSheet();
  if (!elements.cardSheet.open) {
    elements.cardSheet.showModal();
  }
}

// そのソウルカードが今使える能力（ホスト経由）を、シートのボタン定義に変換する。
function soulCardSheetActionSpecs(context) {
  if (isReplayViewOnly()) {
    return [];
  }
  const host = state.players[context.owner]?.field?.[context.zone];
  if (!host) {
    return [];
  }
  const usable = findUsableFieldAbilities(host, context.owner).filter(
    (ability) => ability.fromSoul && ability.soulSourceCard?.instanceId === context.soulCard.instanceId,
  );
  const player = state.players[context.owner];
  return usable.map((ability) => {
    // pt-final(1): 使える能力でもコストを払えないなら無効＋理由（宣言して「ゲージが足りません」で止まっていた）。
    const reason = abilityEntriesPayBlockedReason(player, [
      { card: ability.soulSourceCard || context.soulCard, ability, steps: abilityCostSteps(ability.soulSourceCard || context.soulCard, ability) },
    ]);
    return {
      label: `${fieldAbilityLabel(host, ability)}を使う`,
      primary: !reason,
      disabled: Boolean(reason),
      reason: reason || "",
      run: () => activateSoulAbility(context.owner, context.zone, context.soulCard, ability),
    };
  });
}

// ソウルの能力を発動する。ローカルは実操作経路（useFieldAbilityAction の loc.abilities 経由）、
// thin/権威版は __onSoulAbilityActivate でサーバへ橋渡し（ドロップ起動と同じ作法）。
function activateSoulAbility(owner, zone, soulCard, ability) {
  closeCardSheet();
  closeSoulDialog();
  const host = state.players[owner]?.field?.[zone];
  if (!host) {
    return;
  }
  if (typeof globalThis.__onSoulAbilityActivate === "function") {
    globalThis.__onSoulAbilityActivate(owner, zone, host, soulCard, ability);
    return;
  }
  // 対抗窓改修: 窓が開いていれば、ソウルの【対抗】も「場の札（ホスト）」の候補として窓への応答にする。
  if (counterWindowInterceptLocal("カード使用", { source: "field", owner, zone, instanceId: host.instanceId })) {
    return;
  }
  runNetworkMutation("カード使用", async () => {
    if (!selectFieldCard(owner, zone)) {
      return; // 手番/対抗窓の条件を満たさない（selectFieldCard と同じガードに従う）
    }
    await useFieldAbilityAction(host, { owner, zone, abilities: [ability] });
  });
}

// 選択中カードのシートを開く（操作可能）
function openCardSheet() {
  if (!elements.cardSheet || !getSelectedCard()) {
    return;
  }
  cardSheetReadOnly = false;
  cardSheetReadOnlyCard = null;
  cardSheetActionContext = null;
  cardSheetSoulContext = null; // 前回ソウル詳細の残留で別カードが「ソウル: …」表示されるのを防ぐ
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
  cardSheetActionContext = null;
  cardSheetSoulContext = null; // 同上（Esc で閉じるとソウル文脈が残っていた）
  refreshCardSheet();
  if (!elements.cardSheet.open) {
    elements.cardSheet.showModal();
  }
}

function closeCardSheet() {
  cardSheetReadOnly = false;
  cardSheetReadOnlyCard = null;
  cardSheetSoulContext = null;
  if (elements.cardSheet?.open) {
    elements.cardSheet.close();
  }
}

// 操作シートを開く（スマホ）。PC は従来の下部メニュー（showActionMenu）。
function openActionCardSheet(card, items, options = {}) {
  if (!elements.cardSheet || !card) {
    return;
  }
  cardSheetReadOnly = false;
  cardSheetReadOnlyCard = null;
  cardSheetSoulContext = null;
  cardSheetActionContext = { card, items: items || [], onClose: options.onClose || null, pickedCallZone: null };
  refreshCardSheet();
  if (!elements.cardSheet.open) {
    elements.cardSheet.showModal();
  }
}

// シートが閉じた（背景タップ/閉じる/Esc）。操作ボタンから閉じた時は onClose を呼ばない（runActionFromSheet が先に外す）。
// 閉じた直後に同じシートを開き直した場合（重ねてコールの2段目等）は、古い close イベントを無視する。
function onCardSheetClosed() {
  if (elements.cardSheet?.open) {
    return;
  }
  const context = cardSheetActionContext;
  cardSheetActionContext = null;
  if (typeof context?.onClose === "function") {
    context.onClose();
  }
}

function runActionFromSheet(item) {
  cardSheetActionContext = null; // 操作の実行は「キャンセル」ではない（選択を解除しない）
  closeCardSheet();
  item.run();
}

// カードタップの操作の出し方を1か所に集約: スマホ＝カードシート（詳細全文＋今できる操作）、PC＝下部メニュー。
// items が空なら「今できる操作はない」ことを示す（PC は閲覧専用シートで詳細だけ出す）。
function presentCardActions(card, items, options = {}) {
  closeActionMenu();
  if (!(typeof isPhoneLayout === "function" && isPhoneLayout())) {
    items = (items || []).filter((item) => !item.disabled);
  }
  if (card && typeof isPhoneLayout === "function" && isPhoneLayout() && elements.cardSheet) {
    openActionCardSheet(card, items, options);
    return;
  }
  if ((!items || items.length === 0) && card) {
    if (typeof options.onClose === "function") {
      options.onClose();
    }
    openReadOnlyCardSheet(card);
    return;
  }
  showActionMenu(items || [], options);
}

// ---- カードタップの「今できること」（PC の操作パネルのボタンと同じ判定＝src/12 の isXxxBlocked）----
// selection を一時的に state.selected に置いて判定し、必ず元に戻す（権威版 play.js でも view 上で同じ判定を使う）。
function withTemporarySelection(selection, compute) {
  const previous = state.selected;
  state.selected = selection;
  try {
    return compute();
  } finally {
    state.selected = previous;
  }
}

// 手札の札: charge / call(zone) / use / useTarget / buddy。
function handCardActionKeys(selection) {
  if (typeof aiShouldLockHumanControls === "function" && aiShouldLockHumanControls()) {
    return [];
  }
  return withTemporarySelection(selection, () => {
    const card = getSelectedCard();
    if (!card) {
      return [];
    }
    const keys = [];
    if (!isChargeBlocked()) {
      keys.push({ key: "charge" });
    }
    if (!isCallBlocked(card)) {
      ["left", "center", "right"].forEach((zone) => keys.push({ key: "call", zone }));
    }
    const canUse = canUseSelectedCard(card);
    if (canUse) {
      keys.push({ key: "use" });
      if (effectTargetCandidates(card).length > 0) {
        keys.push({ key: "useTarget" });
      }
    }
    if (canDeclareBuddyCall(activePlayer(), card)) {
      keys.push({ key: "buddy" });
    }
    return keys;
  });
}

// 場の札: attack / link / use / useTarget。
function fieldCardActionKeys(selection) {
  if (typeof aiShouldLockHumanControls === "function" && aiShouldLockHumanControls()) {
    return [];
  }
  return withTemporarySelection(selection, () => {
    const card = getSelectedCard();
    if (!card) {
      return [];
    }
    const keys = [];
    if (!isAttackDeclareBlocked(getAttackDeclarationAttackers())) {
      keys.push({ key: "attack" });
    }
    if (!isLinkToggleBlocked(card)) {
      keys.push({ key: "link" });
    }
    if (canUseSelectedCard(card)) {
      keys.push({ key: "use" });
      if (effectTargetCandidates(card).length > 0) {
        keys.push({ key: "useTarget" });
      }
    }
    return keys;
  });
}

// 主要な操作（攻撃・バディコール宣言）が今できない理由（スマホのシートで「無効＋理由1行」を出す）。
// 理由が出せない／出すほどでもない時は null（その項目は従来どおり出さない）。selection を一時的に選んで判定する。
function fieldAttackBlockedReason(selection) {
  return withTemporarySelection(selection, () => {
    const card = getSelectedCard();
    if (!card || state.winner || hasPendingResolution() || selection.owner !== state.active) return null;
    if (!["attack", "final"].includes(state.phase)) return null;
    if (!["monster", "item"].includes(effectiveCardType(card))) return null;
    if (card.used) return "レスト済み（このターンはもう攻撃できません）";
    if (state.phase === "final" && !canDeclareAttackInFinal(card)) return "ファイナルフェイズは必殺モンスターだけが攻撃できます";
    if (state.turnCount === 1 && state.attacksThisTurn >= 1) return "先攻1ターン目の攻撃は1回までです";
    const player = state.players[selection.owner];
    if (effectiveCardType(card) === "item" && player?.field?.center && !canDeclareAttack({ owner: selection.owner, zone: selection.zone, card })) {
      return "君のセンターにモンスターがいる間は、アイテムで攻撃できません";
    }
    if (!canDeclareAttack({ owner: selection.owner, zone: selection.zone, card })) return "このカードは今は攻撃できません";
    return "攻撃できる対象がありません";
  });
}

function buddyCallBlockedReason(selection) {
  return withTemporarySelection(selection, () => {
    const card = getSelectedCard();
    const player = state.players?.[selection.owner];
    if (!card || !player || !isBuddyCard(player, card)) return null;
    if (player.partnerCalled) return "バディコールは1回だけ（コール済み）";
    return null;
  });
}

// プレイテスト T8: 手札の主要操作（コール先／使用・装備）が今できない理由。エンジンが宣言時に行う判定
// （src/07 callMonsterImpl・src/08 useCardActionImpl/equipItem/castSpell と同じ関数＝コスト支払い可否・条件）を
// 副作用なしで先に当て、できないと確定した時だけ理由を返す（判定できない／特殊コール等は null＝従来どおり出す）。
function stripReasonText(text, card) {
  let out = String(text || "").trim().replace(/。$/, "");
  for (const particle of ["の", "は"]) {
    if (card?.name && out.startsWith(card.name + particle)) {
      out = out.slice(card.name.length + 1);
      break;
    }
  }
  return out;
}

// コールの共通の不可理由（コール先によらない）。null＝コールできる見込み（またはここでは判定しない）。
function handCallCommonBlockedReason(selection) {
  return withTemporarySelection(selection, () => {
    const card = getSelectedCard();
    const owner = selection?.owner;
    const player = state.players?.[owner];
    if (!card || !player || selection.source !== "hand" || isCallBlocked(card)) return null;
    if (specialCallOpportunityForCard(owner, card)) return null; // 特殊コール（逆転コール等）は従来どおり
    if (card.cannotCallNormally) return "通常のコールでは場に出せません（特定の効果でのみ）";
    if (card.type === "impactMonster" && !impactMonsterCallAllowed(owner, card, { specialCall: false })) {
      return "必殺モンスターのコールは1ターンに1枚までです";
    }
    if (!checkCardConditions(card.callConditions, owner)) return "コール条件を満たしていません";
    if (isCallRestricted(owner, card)) return "今はコールできません（コール制限中）";
    if (isCallCountLimitedThisTurn(owner, card) || isCallCountCappedThisTurn(owner)) return "このターンはこれ以上コールできません";
    if (card.callStack && !card.callStack.optional) return null; // 重ね先しだい（コストも重ね先で決まる）＝呼び出し側で扱う
    const payment = canPayCardCost(player, card, "call", card, { callFromZone: "hand", allowInteractiveSelection: true });
    if (!payment.ok) return stripReasonText(payment.reason, card) || "コールコストを払えません";
    return null;
  });
}

// コール先ごとの不可理由（そのエリアにはコールできない）。
function handCallZoneBlockedReason(selection, zone) {
  return withTemporarySelection(selection, () => {
    const card = getSelectedCard();
    const owner = selection?.owner;
    if (!card || selection.source !== "hand" || specialCallOpportunityForCard(owner, card)) return null;
    // pt-final(5): 理由はエリア名の繰り返しにしない（コール先ボタンにはエリア名が既に出ている）。
    if (card.callZones && !card.callZones.includes(zone)) {
      return `${card.callZones.map((allowed) => zoneLabel(allowed)).join("・")}にだけコールできるカードです`;
    }
    if ((card.cannotCallZones || []).includes(zone)) return "このカードはこのエリアにコールできません";
    if (zone === "center" && isCenterCallPrevented(owner, card)) return "今はセンターへのコールが禁止されています";
    return null;
  });
}

// pt-final(1): 能力の一覧のうち、どれか1つでも今コストを払えるなら null、どれも払えなければ最初の理由。
// entries: [{ card(コストの主体), ability, steps? }]。判定はエンジンの宣言時と同じ canPayStructuredCost。
// 払い方が対象に依存するコスト（amountFrom:targetStat 等）は判定できないので「払える」扱い（従来どおり宣言時に判定）。
function abilityEntriesPayBlockedReason(player, entries, kindOpponentGauge = null) {
  if (!player || !Array.isArray(entries) || entries.length === 0) return null;
  let firstReason = null;
  for (const { card, ability, steps } of entries) {
    const costSteps = steps || adjustedAbilityCostSteps(player, card, ability);
    if (JSON.stringify(costSteps || []).includes("target")) return null;
    const usesGauge = (costSteps || []).some((step) => step.op === "payGauge" && step.amount > 0);
    const includeOpponentGauge = Boolean(
      usesGauge &&
        ((ability.kind === "spell" && player.nextSpellCostMayUseOpponentGauge) ||
          (ability.kind === "activated" && player.nextActivatedCostMayUseOpponentGauge)),
    );
    let payment;
    try {
      payment = canPayStructuredCost(player, costSteps, { sourceCard: card, selectedCard: card, ability, includeOpponentGauge, allowInteractiveSelection: true });
    } catch (error) {
      return null;
    }
    if (payment.ok) return null;
    firstReason ||= payment.reason;
  }
  return firstReason ? stripReasonText(firstReason, entries[0].card) || "コストを払えません" : null;
}

// 手札の「使用/装備」の不可理由。メインの通常使用・装備・必殺技に加え（pt-final(1)）、【対抗】（自分の手番の
// 対抗タイミング・攻撃/宣言への応答）と、ファイナルフェイズの必殺技/『必殺変身』も、エンジンの宣言時と同じ判定
// （使える能力の列挙＝findUsableHandAbilities・コスト＝canPayStructuredCost）で理由を出す。
function handUseBlockedReason(selection) {
  return withTemporarySelection(selection, () => {
    const card = getSelectedCard();
    const owner = selection?.owner;
    if (!card || selection.source !== "hand" || state.winner) return null;
    const player = state.players[owner];
    if (!player) return null;
    if (isSoulOnlyUseCard(card)) return "ソウルにある時だけ使えるカードです（手札からは使えません）";
    if (hasKeyword(card, "arrival")) return null;
    const inResponse = Boolean(state.pendingAction || state.pendingAttack);
    if (inResponse || owner !== state.active) {
      // 【対抗】: 対抗窓で使う時と同じ列挙（攻撃中は findUsableHandAbilities、それ以外は counterOnly）。
      if (isMagicalGoodbyeCard(card) || card.name === "ウープス！") return null;
      const counterAbilities = state.pendingAttack
        ? findUsableHandAbilities(card)
        : findUsableHandAbilities(card, { counterOnly: true });
      if (counterAbilities.length === 0) {
        if (!(card.abilities || []).some((ability) => canUseAbilityFromHand(ability) && isCounterAbility(ability))) return null;
        return stripReasonText(handAbilityUnavailableReason(card, owner, { counterOnly: true }), card) || "今は使えません";
      }
      if (inResponse && !canUseCounterEffect(owner, selectedCounterKind(card))) return "この攻撃中はもう【対抗】を使えません";
      return abilityEntriesPayBlockedReason(player, counterAbilities.map((ability) => ({ card, ability })));
    }
    if (hasPendingResolution()) return null;
    if (state.phase === "final" && card.type !== "impact" && hasExplicitPhaseHandAbility(card, "final")) {
      // 『必殺変身』等（ファイナルフェイズを明示する手札起動）。
      const finalAbilities = findUsableHandAbilities(card, { explicitPhase: "final" });
      if (finalAbilities.length === 0) {
        return stripReasonText(handAbilityUnavailableReason(card, owner, { explicitPhase: "final" }), card) || "今は使えません";
      }
      return abilityEntriesPayBlockedReason(player, finalAbilities.map((ability) => ({ card, ability })));
    }
    const usable = findUsableHandAbilities(card);
    if (usable.length > 0) {
      // 使える能力がある＝宣言時に useHandAbilityAction がコストを払う。どれも払えない時だけ理由を返す
      // （自分の手番の【対抗】タイミングで使う手札の【対抗】もここ＝findUsableHandAbilities が対抗を含めて列挙する）。
      return abilityEntriesPayBlockedReason(player, usable.map((ability) => ({ card, ability })));
    }
    if (state.phase !== "main" && card.type !== "impact") return null;
    if (card.type === "impact" && state.phase !== "final") return null;
    if (card.type === "item") {
      if (card.equipOnlyByAbility) return "特定の能力からのみ装備できます";
      if (card.equipConditions && !checkCardConditions(card.equipConditions, owner)) return "装備条件を満たしていません";
      const payment = canPayCardCost(state.players[owner], card, "equip", card, { allowInteractiveSelection: true });
      return payment.ok ? null : stripReasonText(payment.reason, card) || "装備コストを払えません";
    }
    if (card.type === "spell" || card.type === "impact") {
      if (hasKeyword(card, "set")) {
        // castSetSpell（src/08）と同じ判定（使用条件・同名1枚・そのターンの設置禁止・使用コスト）。
        if (!checkCardConditions(card.useConditions || [], owner, { card, owner })) return "使用条件を満たしていません";
        if (card.uniqueSet && setZones.some((zone) => player.field[zone]?.name === card.name)) return "すでに配置されています（1枚だけ設置できます）";
        if ((player.setLockedIdsThisTurn || []).includes(card.id) || (player.setLockedNamesThisTurn || []).includes(card.name)) {
          return "このターンは設置できません";
        }
        const payment = canPayCardCost(player, card, "cast", card, { allowInteractiveSelection: true });
        return payment.ok ? null : stripReasonText(payment.reason, card) || "使用コストを払えません";
      }
      if (card.type === "spell" && controllerSpellUsePrevented(owner)) return "あなたは今、魔法を使えません";
      if (card.name === "ウープス！") return null;
      if (hasKnownHandAbility(card)) return stripReasonText(handAbilityUnavailableReason(card, owner), card) || "今は使えません";
    }
    return null;
  });
}

// pt-final(1): 場の札（設置魔法を含む）の「使用（能力）」の不可理由。useFieldAbilityAction と同じ列挙
// （findUsableFieldAbilities ＋相手手番/応答中は【対抗】だけ）で、使える能力が無ければその理由
// （describeUnusableFieldAbilities）、あってもどれもコストを払えなければコストの理由。判定できない時は null。
function fieldUseBlockedReason(selection) {
  return withTemporarySelection(selection, () => {
    const card = getSelectedCard();
    const owner = selection?.owner;
    const player = state.players?.[owner];
    if (!card || !player || selection.source !== "field" || state.winner) return null;
    let usable = findUsableFieldAbilities(card, owner);
    const responding = hasPendingResolution() || owner !== state.active || counterWindowUseActive(owner);
    if (responding) usable = usable.filter((ability) => isCounterAbility(ability));
    if (usable.length === 0) {
      const reasons = describeUnusableFieldAbilities(card, owner);
      return reasons.length > 0 ? stripReasonText(reasons[0], card) : null;
    }
    if (hasPendingResolution() && !counterWindowUseActive(owner) && !canUseCounterEffect(owner, selectedCounterKind(card))) {
      return "この攻撃中はもう【対抗】を使えません";
    }
    return abilityEntriesPayBlockedReason(
      player,
      usable.map((ability) => {
        const source = ability.fromSoul ? ability.soulSourceCard : card;
        return { card: source, ability, steps: abilityCostSteps(source, ability) };
      }),
    );
  });
}

// pt-final(1): ドロップの起動能力の「発動」の不可理由（findUsableDropAbilities で使える能力のコストだけを見る）。
function dropUseBlockedReason(owner, card) {
  const player = state.players?.[owner];
  if (!player || !card) return null;
  const usable = findUsableDropAbilities(card, owner);
  if (usable.length === 0) return null;
  return abilityEntriesPayBlockedReason(player, usable.map((ability) => ({ card, ability, steps: abilityCostSteps(card, ability) })));
}

// pt-final(1): 先攻1ターン目は攻撃が1回だけ＝連携攻撃（2枚以上での1回の攻撃）は宣言できない。
function linkFirstTurnBlocked() {
  return state.turnCount === 1;
}

// コール先の予告（スマホのカードシート）: いま居る札とコール後のサイズ。超過はコール直後に自分で選んでドロップへ（エンジンと同じ）。
function callZonePreview(owner, zone, card) {
  const player = state.players?.[owner];
  if (!player || !card) {
    return null;
  }
  const occupant = player.field?.[zone] || null;
  const used = getFieldSize(player);
  const after = used - (occupant ? effectiveSize(occupant) : 0) + effectiveSize(card);
  const limit = fieldSizeLimit(player);
  return { occupantName: occupant?.name || "", after, limit, over: after > limit };
}

// ---- 画面下部アクションメニュー（権威版 play.js と同一の見た目/操作。カードタップ→操作の共通部品）----
// id は play.js の従来実装と同じ(playActionMenu/playActionBackdrop)にし、両者の closeMenu が互いに効くようにする。
// Esc で閉じるための keydown ハンドラ（表示中だけ document に載せる。閉じたら必ず外す）。
let actionMenuEscHandler = null;

function closeActionMenu() {
  document.getElementById("playActionMenu")?.remove();
  document.getElementById("playActionBackdrop")?.remove();
  if (actionMenuEscHandler && typeof document.removeEventListener === "function") {
    document.removeEventListener("keydown", actionMenuEscHandler);
  }
  actionMenuEscHandler = null;
}

// items: [{label, run}] を下部ポップアップで表示。項目タップ＝メニューを閉じて実行。
// 背景タップ/「閉じる」＝閉じて options.onClose（選択解除等）を呼ぶ。
function showActionMenu(items, options = {}) {
  closeActionMenu();
  const close = () => {
    closeActionMenu();
    if (typeof options.onClose === "function") {
      options.onClose();
    }
  };
  const backdrop = document.createElement("div");
  backdrop.id = "playActionBackdrop";
  backdrop.className = "play-action-backdrop";
  backdrop.addEventListener("click", (event) => {
    // 背後の盤面/手札へのタップ貫通を遮断しつつ閉じる（権威版と同じ）。
    event.stopPropagation();
    close();
  });
  const menu = document.createElement("div");
  menu.id = "playActionMenu";
  menu.className = "play-action-menu";
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.addEventListener("click", () => {
      closeActionMenu();
      item.run();
    });
    menu.append(button);
  });
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "menu-close";
  closeButton.textContent = "閉じる";
  closeButton.addEventListener("click", close);
  menu.append(closeButton);
  document.body.append(backdrop);
  document.body.append(menu);
  // a11y: Esc＝「閉じる」と同じ（onClose も呼ぶ）。DOM スタブ環境（テスト/サーバ）では登録しない。
  if (typeof document.addEventListener === "function") {
    actionMenuEscHandler = (event) => {
      if (event.key !== "Escape") {
        return;
      }
      // play.js の closeMenu 等が DOM だけ外した後なら、onClose を呼ばずハンドラだけ片付ける。
      if (menu.isConnected === false) {
        closeActionMenu();
        return;
      }
      close();
    };
    document.addEventListener("keydown", actionMenuEscHandler);
  }
}

// メニューを閉じた時の選択解除（権威版 clearSelection のローカル版。連携編成は維持する）。
function clearLocalSelection() {
  state.selected = null;
  render();
}

// ---- ローカル/中継: カードタップ→下部アクションメニュー（権威版 handCardMenu/fieldCardMenu と同項目）----
// U3: リプレイ再生ページ（replay.html）は閲覧専用。カードタップは詳細表示だけにし、操作メニューを出さない。
function isReplayViewOnly() {
  return Boolean(globalThis.__BUDDYFIGHT_REPLAY__);
}

function handCardMenuLocal(instanceId) {
  if (isReplayViewOnly()) {
    const card = (state?.players || []).flatMap((player) => player?.hand || []).find((c) => c.instanceId === instanceId);
    if (card) {
      openReadOnlyCardSheet(card);
    }
    return;
  }
  // 進行中の対象選択(攻撃/効果)と残留効果対象は破棄してから選び直す
  // （旧カードの pending が新カードの対象タップで誤発動するのを防ぐ）。
  uiTargeting = null;
  elements.effectTarget.value = "";
  // 対抗窓改修: 対抗窓（非モーダルバー）の間は、窓の候補の札だけ「【対抗】で使う」を出す（他の操作は窓の後）。
  if (counterWindowUi && counterWindowUi.mode === "local") {
    const index = counterWindowAnswerFor({ source: "hand", owner: handOwnerIndex(), instanceId });
    const card = handOwner()?.hand.find((c) => c.instanceId === instanceId);
    if (index === null) {
      if (card) {
        openReadOnlyCardSheet(card);
      }
      return;
    }
    presentCardActions(card, [{ label: "【対抗】で使う", run: () => answerCounterWindow(index), primary: true }]);
    return;
  }
  selectHandCard(instanceId);
  const selectedHandCard = getSelectedCard();
  if (!selectedHandCard) {
    return;
  }
  const callVia = (zone) => () => {
    const card = getSelectedCard();
    // 重ねてコールする札(callStack)は、先に重ねる対象を盤面タップで選ばせてからコールする
    // （権威版の「効果対象タップ＋callZone」と同型）。
    if (card?.callStack && !elements.effectTarget.value && effectTargetCandidates(card).length > 0) {
      if (card.callStack.optional) {
        // E-ZA4:「１枚まで の上に重ね」型は重ねるかどうかをプレイヤーが選べる
        //（バンテージ仮面の chooseHandAbility と同じ「処理の分離はダイアログで」方式）。
        presentCardActions(
          card,
          [
            { label: "重ねてコール（対象を選ぶ）", run: () => startEffectTargeting({ type: "call", zone }) },
            { label: "重ねずにコール", run: () => runNetworkMutation("コール", () => callMonster(zone)) },
          ],
          { onClose: clearLocalSelection },
        );
        return;
      }
      startEffectTargeting({ type: "call", zone });
      return;
    }
    runNetworkMutation("コール", () => callMonster(zone));
  };
  // 今できる操作だけを出す（PC の操作パネルのボタンと同じ判定。押しても失敗するだけの項目は出さない）。
  const keys = handCardActionKeys(state.selected);
  const items = keys.map((entry) => {
    switch (entry.key) {
      case "charge":
        return { label: "チャージ&ドロー", run: () => runNetworkMutation("チャージ&ドロー", chargeAction) };
      case "call":
        return { label: `${zoneLabel(entry.zone)}にコール`, run: callVia(entry.zone), callZone: entry.zone, owner: state.selected.owner };
      case "use":
        return { label: "使用/装備", run: () => runNetworkMutation("カード使用", useCardAction), primary: true };
      case "useTarget":
        return { label: "使用（効果対象を選ぶ）", run: () => startEffectTargeting({ type: "use" }) };
      case "buddy":
        return {
          label: state.buddyCallDeclared === selectedHandCard.instanceId ? "バディ宣言中" : "バディコール宣言",
          run: () => partnerCall(),
          buddy: true,
        };
      default:
        return null;
    }
  }).filter(Boolean);
  if (!keys.some((entry) => entry.key === "buddy")) {
    const reason = buddyCallBlockedReason(state.selected);
    if (reason) items.push({ label: "バディコール宣言", disabled: true, reason, run: () => {} });
  }
  applyHandActionBlockedReasons(selectedHandCard, items);
  presentCardActions(selectedHandCard, items, { onClose: clearLocalSelection });
}

// プレイテスト T8: 手札メニューの項目に「今できない理由」を反映する（スマホ＝無効＋理由1行／PC＝項目を出さない）。
// ・コール: コール先によらない理由があれば3つのコール先の代わりに「コール」1行（無効＋理由）。エリア限定の理由は
//   そのコール先だけ無効。重ねてコールが必須の札は、コール先3つではなく「重ねてコール（対象を選ぶ）」1つにする。
// ・使用/装備: 払えない／条件不成立なら無効＋理由（「効果対象を選ぶ」近道は外す）。
// ・バディコール宣言: コールできない時は宣言も無効（宣言してからコールで止まっていた）。
function applyHandActionBlockedReasons(card, items, selection = state.selected) {
  if (!card || !selection) {
    return;
  }
  const callItems = items.filter((item) => item.callZone);
  let callReason = null;
  if (callItems.length > 0) {
    callReason = handCallCommonBlockedReason(selection);
    const insertAt = items.indexOf(callItems[0]);
    if (card.callStack && !card.callStack.optional && !callReason) {
      // 重ね先が要るコール（重ね先＝コール先）: コール先3つは出さず、重ね先を盤面で選ぶ1項目にする。
      const hasTarget = withTemporarySelection(selection, () => effectTargetCandidates(card).length > 0);
      callItems.forEach((item) => items.splice(items.indexOf(item), 1));
      items.splice(
        insertAt,
        0,
        hasTarget
          ? { label: "重ねてコール（重ねる札を選ぶ）", run: () => startEffectTargeting({ type: "call", zone: "center" }), primary: true }
          : { label: "重ねてコール", disabled: true, reason: "重ねられる札が場にいません", run: () => {} },
      );
    } else if (callReason) {
      callItems.forEach((item) => items.splice(items.indexOf(item), 1));
      items.splice(insertAt, 0, { label: "コール", disabled: true, reason: callReason, run: () => {} });
    } else {
      callItems.forEach((item) => {
        const reason = handCallZoneBlockedReason(selection, item.callZone);
        if (reason) {
          item.disabled = true;
          item.reason = reason;
        }
      });
      if (callItems.every((item) => item.disabled)) {
        // 全エリア不可（エリア限定の理由のみ）: 1行にまとめる。
        callItems.forEach((item) => items.splice(items.indexOf(item), 1));
        const reasons = [...new Set(callItems.map((item) => item.reason).filter(Boolean))];
        items.splice(insertAt, 0, { label: "コール", disabled: true, reason: `空いているエリアにコールできません（${reasons.join("／")}）`, run: () => {} });
      }
    }
  }
  let useItem = items.find((item) => item.label === "使用/装備" || item.label === "【対抗】で使用");
  if (!useItem && withTemporarySelection(selection, () => isSoulOnlyUseCard(card))) {
    // pt-final(1): ソウルからだけ使えるカード（秘剣 等）は「使用」を無効＋理由で示す（以前は項目ごと消えていた）。
    useItem = { label: "使用/装備", run: () => {} };
    items.push(useItem);
  }
  if (useItem) {
    const reason = handUseBlockedReason(selection);
    if (reason) {
      useItem.disabled = true;
      useItem.reason = reason;
      useItem.primary = false;
      const shortcut = items.findIndex((item) => item.label === "使用（効果対象を選ぶ）" || item.label === "【対抗】で使用（効果対象を選ぶ）");
      if (shortcut >= 0) items.splice(shortcut, 1);
    }
  }
  const buddyItem = items.find((item) => item.buddy && !item.disabled);
  if (buddyItem && callReason && state.buddyCallDeclared !== card.instanceId) {
    buddyItem.disabled = true;
    buddyItem.reason = `コールできないため宣言できません（${callReason}）`;
  }
}

// pt-final(1): 場の札メニューの「使用（能力）」に今使えない理由を反映する（スマホ＝無効＋理由1行）。
// 項目が無くても、自分の手番のメインフェイズに起動能力を持つ札なら「使用（能力）」を無効＋理由で出す
// （「何も出ない」と使えないのか壊れているのか判らない）。selection は判定に使う選択（権威版は ui.selected）。
function applyFieldActionBlockedReasons(card, items, selection = state.selected) {
  if (!card || !selection) {
    return;
  }
  const isUse = (item) => item.label === "使用（能力）" || item.label === "【対抗】で使用（能力）";
  const isShortcut = (item) => item.label === "使用（効果対象を選ぶ）" || item.label === "【対抗】で使用（効果対象を選ぶ）";
  let useItem = items.find(isUse);
  let added = false;
  if (!useItem) {
    const declares = withTemporarySelection(selection, () =>
      selection.owner === state.active &&
      !hasPendingResolution() &&
      state.phase === "main" &&
      ((card.abilities || []).some(isFieldActivatedAbility) ||
        (card.soul || []).some((soulCard) => (soulCard.soulAbilities || []).some(isFieldActivatedAbility))),
    );
    if (!declares) return;
    useItem = { label: "使用（能力）", run: () => {} };
    added = true;
  }
  const reason = fieldUseBlockedReason(selection);
  if (added && reason) items.push(useItem);
  if (reason) {
    useItem.disabled = true;
    useItem.reason = reason;
    useItem.primary = false;
    const shortcut = items.findIndex(isShortcut);
    if (shortcut >= 0) items.splice(shortcut, 1);
  }
}

// アイテム枠(DOM上は "item" 単一)を複数アイテムで共有するため、クリック位置から実スロットを解決する。
// タップが特定アイテムレイヤー(data-item-zone)上なら そのスロット、そうでなければ最初の装備アイテムの枠を返す。
function resolveClickedItemZone(event, owner, zone) {
  if (zone !== "item") {
    return zone;
  }
  // タップされたカード要素のスロットを最優先で使う（権威版 play.js と同じ解決順）。
  // data-item-zone はカード要素(.card)に載っているが、内部の画像/ソウルバッジをタップした時も
  // closest で拾えるようにしておく。取り違えると別アイテムのソウル能力を開いてしまう。
  const layer =
    event?.target?.closest?.(".card[data-item-zone]") || event?.target?.closest?.("[data-item-zone]");
  if (layer?.dataset?.itemZone && state.players[owner]?.field?.[layer.dataset.itemZone]) {
    return layer.dataset.itemZone;
  }
  // レイヤー未特定: 主枠が空なら最初の装備アイテムの実スロットへフォールバック。
  if (!state.players[owner]?.field?.item) {
    const firstItem = equippedItems(state.players[owner])[0];
    if (firstItem) {
      return itemZoneOf(state.players[owner], firstItem) || zone;
    }
  }
  return zone;
}

function fieldCardMenuLocal(owner, zone) {
  if (isReplayViewOnly()) {
    return false; // 呼び出し側が閲覧専用シートへフォールバックする
  }
  // 進行中の対象選択と残留効果対象は破棄してから選び直す（handCardMenuLocalと同じ防御）。
  uiTargeting = null;
  elements.effectTarget.value = "";
  // 対抗窓改修: 窓の間は、窓の候補の場の札だけ「【対抗】で使う」を出す（それ以外は詳細表示へフォールバック）。
  if (counterWindowUi && counterWindowUi.mode === "local") {
    const index = counterWindowAnswerFor({ source: "field", owner, zone, instanceId: state.players[owner]?.field?.[zone]?.instanceId });
    if (index === null) {
      return false;
    }
    presentCardActions(state.players[owner]?.field?.[zone], [{ label: "【対抗】で使う", run: () => answerCounterWindow(index), primary: true }]);
    return true;
  }
  if (!selectFieldCard(owner, zone)) {
    return false;
  }
  const linked = (state.linkAttackers || []).some(
    (slot) => slot.owner === owner && slot.zone === zone,
  );
  const fieldCard = getSelectedCard();
  const items = fieldCardActionKeys(state.selected).map((entry) => {
    switch (entry.key) {
      case "attack":
        return { label: "攻撃（対象を選ぶ）", run: () => startAttackTargeting(), primary: true };
      case "link":
        return { label: linked ? "連携から外す" : "連携に追加", run: () => toggleLinkAttacker() };
      case "use":
        return { label: "使用（能力）", run: () => runNetworkMutation("カード使用", useCardAction) };
      case "useTarget":
        return { label: "使用（効果対象を選ぶ）", run: () => startEffectTargeting({ type: "use" }) };
      default:
        return null;
    }
  }).filter(Boolean);
  if (!items.some((item) => item.label === "攻撃（対象を選ぶ）")) {
    const reason = fieldAttackBlockedReason(state.selected);
    if (reason) items.unshift({ label: "攻撃（対象を選ぶ）", disabled: true, reason, run: () => {} });
  }
  applyFieldActionBlockedReasons(fieldCard, items, state.selected);
  if (items.every((item) => item.disabled) && !(typeof isPhoneLayout === "function" && isPhoneLayout())) {
    items.length = 0; // PC の下部メニューは従来どおり「できる操作」だけ（無効＋理由はスマホのシートのみ）
  }
  if (items.length === 0) {
    // 自分の札でも今できる操作が無い（レスト済み・フェイズ外等）: 選択を外し、詳細だけ（呼び出し側が閲覧シートを出す）。
    clearLocalSelection();
    return false;
  }
  presentCardActions(fieldCard, items, { onClose: clearLocalSelection });
  return true;
}

// E-XB54b(∞ the Chaos ∞): 「攻撃するフラッグ」(canAttackAsFlag)を自席の手番にタップ→攻撃メニュー。
// selectFlagCard が「攻撃できるフラッグ・自ターン・対抗窓/AIロック外」を一括ゲートする（src/07）。選べた時だけ
// 攻撃メニュー（フラッグは連携/装備/能力を持たないので「攻撃（対象を選ぶ）」のみ）を出し、以後は場札攻撃と
// 同じ startAttackTargeting→attackAction 経路（getAttackDeclarationAttackers が source:"flag" を組み立てる）。
// 選べない場合（相手の∞フラッグ／自ターン外／レスト等）はフラッグ詳細を閲覧専用で表示する。呼び出し側
// （21-bootstrap.js）が canAttackAsFlag ゲート済みのため、通常フラッグはこの関数に到達しない＝挙動不変。
function flagZoneMenuLocal(owner) {
  const player = state.players[owner];
  if (!player?.flag) {
    return false;
  }
  if (isReplayViewOnly()) {
    openReadOnlyCardSheet(player.flag);
    return false;
  }
  // 進行中の対象選択と残留効果対象は破棄してから選び直す（fieldCardMenuLocal と同じ防御）。
  uiTargeting = null;
  elements.effectTarget.value = "";
  if (!selectFlagCard(owner)) {
    openReadOnlyCardSheet(player.flag); // 攻撃できないフラッグは従来どおり詳細表示のみ
    return false;
  }
  presentCardActions(
    player.flag,
    [{ label: "攻撃（対象を選ぶ）", run: () => startAttackTargeting(), primary: true }],
    { onClose: clearLocalSelection },
  );
  return true;
}

// シート内に出す操作ボタンの定義（有効なものだけ既存ボタンへ委譲）
function cardSheetActionSpecs() {
  const card = getSelectedCard();
  if (!card) {
    return [];
  }
  const specs = [];
  // 効果対象の事前指定は「近道」であって必須ではない（使用/装備は未指定でも押せて、必要な選択は
  // 使用時にダイアログで聞かれる。デスクトップの castButton ゲート撤去と同じ方針＝導線を揃える）。
  // 盤面タップで先に選びたい人向けに従来のボタンは残すが、primary（最優先の推奨操作）にはしない。
  if (
    requiresExplicitEffectTarget(card) &&
    !elements.effectTarget.value &&
    effectTargetCandidates(card).length > 0
  ) {
    specs.push({ label: "効果対象を選ぶ", run: () => startEffectTargeting({ type: "use" }) });
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
  elements.cardSheetTitle.textContent = cardSheetSoulContext ? `ソウル: ${card.name}` : card.name;
  elements.cardSheetDetail.innerHTML = cardTooltipHtml(card);
  // スマホ: シートの先頭に大きなカード画像（phone-art）。PC のシートは従来どおり。
  // 裏向き（伏せ設置・裏向きモンスター・伏せ札）は画像を出さない（画像は card.id で引くので正体が漏れる）。
  if (typeof isPhoneLayout === "function" && isPhoneLayout() && card.name && !isFaceHiddenCard(card)) {
    const figure = document.createElement("div");
    figure.className = `card-sheet-figure${isLandscapeArtCard(card) ? " is-landscape" : ""}`;
    figure.append(createCardImageElement(card));
    elements.cardSheetDetail.prepend(figure);
  }
  elements.cardSheetActions.innerHTML = "";
  elements.cardSheetActions.classList?.toggle("is-action-sheet", Boolean(cardSheetActionContext));
  // phone-art: 見るだけのシート（長押し等）は絵を大きく、操作のあるシートは低い画面で絵をサムネに戻す（操作ボタンを画面内に残す）。
  elements.cardSheet.classList?.toggle("sheet-view-only", Boolean(cardSheetReadOnly && !cardSheetActionContext && !cardSheetSoulContext));
  if (cardSheetActionContext) {
    renderActionSheetButtons(cardSheetActionContext);
    appendSoulPeekSheetButton(card);
    return;
  }
  let specs;
  if (cardSheetSoulContext) {
    specs = soulCardSheetActionSpecs(cardSheetSoulContext);
  } else if (cardSheetReadOnly) {
    specs = [];
  } else {
    specs = cardSheetActionSpecs();
  }
  if (specs.length === 0 && cardSheetSoulContext) {
    // 使える能力が無い時は、なぜ使えないか（タイミング/使用条件）をシート上でも示す。
    const host = state.players[cardSheetSoulContext.owner]?.field?.[cardSheetSoulContext.zone];
    const reasons = host
      ? describeUnusableFieldAbilities(host, cardSheetSoulContext.owner, { soulCard: card })
      : [];
    const note = document.createElement("p");
    note.className = "card-sheet-empty";
    note.textContent = reasons.length > 0 ? reasons[0] : "このソウルのカードに、今使える能力はありません。";
    elements.cardSheetActions.append(note);
  } else if (specs.length === 0 && !cardSheetReadOnly) {
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
    if (spec.disabled) {
      // pt-final(1): 今使えない理由を1行で添えて無効表示（操作シートの has-reason と同じ見た目）。
      actionButton.disabled = true;
      actionButton.classList.add("has-reason");
      const reason = document.createElement("span");
      reason.className = "card-sheet-reason";
      reason.textContent = spec.reason || "";
      actionButton.append(reason);
      actionButton.setAttribute("aria-label", `${spec.label}（できません: ${spec.reason || ""}）`);
    } else {
      actionButton.addEventListener("click", spec.run);
    }
    elements.cardSheetActions.append(actionButton);
  });
  if (!cardSheetSoulContext) {
    appendSoulPeekSheetButton(card);
  }
}

// 場の札（instanceId 一致）の所在 { owner, zone }。無ければ null。
function fieldSlotOfCard(card) {
  if (!card?.instanceId || !Array.isArray(state?.players)) {
    return null;
  }
  for (let owner = 0; owner < state.players.length; owner += 1) {
    const field = state.players[owner]?.field || {};
    for (const zone of Object.keys(field)) {
      if (field[zone]?.instanceId === card.instanceId) {
        return { owner, zone };
      }
    }
  }
  return null;
}

// スマホ: ソウルを持つ場の札のシートに「ソウルを見る（N枚）」を出す（盤面のソウルバッジは表示だけ＝プレイテスト T8）。
// 操作シートではキャンセル/決定の行の手前に置く。押す＝シートを閉じてソウル一覧（src/12 showSoulDialog）。
function appendSoulPeekSheetButton(card) {
  if (!(typeof isPhoneLayout === "function" && isPhoneLayout())) {
    return;
  }
  const slot = fieldSlotOfCard(card);
  const souls = slot ? stackedCardNames(state.players[slot.owner].field[slot.zone]) : [];
  if (!slot || souls.length === 0) {
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-sheet-action card-sheet-soul";
  button.textContent = `ソウルを見る（${souls.length}枚）`;
  button.addEventListener("click", () => {
    closeCardSheet();
    showSoulDialog(slot.owner, slot.zone);
  });
  const footer = elements.cardSheetActions.querySelector?.(".card-sheet-footer");
  if (footer) {
    elements.cardSheetActions.insertBefore(button, footer);
  } else {
    elements.cardSheetActions.append(button);
  }
}

// 操作シート（スマホ）のボタン: コール先は「選んでから決定」の2段階（いま居る札・コール後のサイズを予告）。
// それ以外の操作は1ボタン1操作。左下=キャンセル、右下=主役（コールの決定）。
function renderActionSheetButtons(context) {
  const actions = elements.cardSheetActions;
  const callItems = context.items.filter((item) => item.callZone);
  const otherItems = context.items.filter((item) => !item.callZone);
  if (context.items.length === 0) {
    const note = document.createElement("p");
    note.className = "card-sheet-empty";
    note.textContent = "今このカードで行える操作はありません。";
    actions.append(note);
  }
  otherItems.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `card-sheet-action${item.primary && callItems.length === 0 ? " primary" : ""}`;
    button.textContent = item.label;
    if (item.disabled) {
      // できない理由がある主要操作: 無効表示＋理由1行（押しても何も起きない）。
      button.disabled = true;
      button.classList.add("has-reason");
      const reason = document.createElement("span");
      reason.className = "card-sheet-reason";
      reason.textContent = item.reason || "";
      button.append(reason);
      button.setAttribute("aria-label", `${item.label}（できません: ${item.reason || ""}）`);
    } else {
      button.addEventListener("click", () => runActionFromSheet(item));
    }
    actions.append(button);
  });
  let decide = null;
  if (callItems.length > 0) {
    const group = document.createElement("div");
    group.className = "card-sheet-call";
    const head = document.createElement("div");
    head.className = "card-sheet-call-head";
    const owner = callItems[0].owner;
    const player = state.players?.[owner];
    head.textContent = player ? `コール先を選ぶ（いまのサイズ ${getFieldSize(player)}/${fieldSizeLimit(player)}）` : "コール先を選ぶ";
    group.append(head);
    const radios = document.createElement("div");
    radios.className = "card-sheet-call-zones";
    radios.setAttribute("role", "radiogroup");
    radios.setAttribute("aria-label", "コール先");
    const note = document.createElement("p");
    note.className = "card-sheet-call-note";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    callItems.forEach((item) => {
      const preview = callZonePreview(owner, item.callZone, context.card);
      const radio = document.createElement("button");
      radio.type = "button";
      radio.className = "card-sheet-call-zone";
      radio.setAttribute("role", "radio");
      radio.setAttribute("aria-checked", String(context.pickedCallZone === item.callZone));
      radio.dataset.callZone = item.callZone;
      // pt-final(5): 各行の間に空白を挟む（縦並びの flex なので見た目は変わらない）。読み上げ/テキスト取得で
      // 「センターいま 流星機 バイシャールセンターにはコールできません」と繋がっていた。
      const nowText = preview?.occupantName ? `いま ${preview.occupantName}` : "いま 空き";
      radio.innerHTML =
        `<span class="cz-name">${escapeHtml(zoneLabel(item.callZone))}</span> ` +
        `<span class="cz-now">${escapeHtml(nowText)}</span> ` +
        (item.disabled
          ? `<span class="cz-reason">${escapeHtml(item.reason || "コールできません")}</span>`
          : preview ? `<span class="cz-size${preview.over ? " over" : ""}">→ ${preview.after}/${preview.limit}</span>` : "");
      radio.setAttribute(
        "aria-label",
        item.disabled
          ? `${zoneLabel(item.callZone)}（${nowText}）: コールできません。${item.reason || ""}`
          : `${zoneLabel(item.callZone)}（${nowText}）${preview ? `: コール後のサイズ ${preview.after}/${preview.limit}` : ""}`,
      );
      if (item.disabled) {
        // このエリアにはコールできない（理由を1行で出す・選べない）。
        radio.disabled = true;
        radio.setAttribute("aria-disabled", "true");
        radios.append(radio);
        return;
      }
      radio.addEventListener("click", () => {
        context.pickedCallZone = item.callZone;
        radios.querySelectorAll(".card-sheet-call-zone").forEach((other) =>
          other.setAttribute("aria-checked", String(other.dataset.callZone === item.callZone)),
        );
        if (decide) {
          decide.disabled = false;
          decide.textContent = `${zoneLabel(item.callZone)}にコール`;
        }
        note.textContent = !preview
          ? ""
          : preview.over
            ? `コール後のサイズ ${preview.after}/${preview.limit}（超過）: コールした直後に、場のモンスターを選んでドロップへ置きます。`
            : `コール後のサイズ ${preview.after}/${preview.limit}${preview.occupantName ? `・いまの ${preview.occupantName} はドロップへ置かれます` : ""}`;
      });
      radios.append(radio);
    });
    group.append(radios, note);
    actions.append(group);
  }
  const footer = document.createElement("div");
  footer.className = "card-sheet-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "card-sheet-cancel";
  cancel.textContent = "キャンセル";
  cancel.addEventListener("click", () => closeCardSheet());
  footer.append(cancel);
  if (callItems.length > 0) {
    decide = document.createElement("button");
    decide.type = "button";
    decide.className = "card-sheet-action primary card-sheet-decide";
    decide.textContent = "コール先を選んでください";
    decide.disabled = !context.pickedCallZone;
    decide.addEventListener("click", () => {
      const item = callItems.find((candidate) => candidate.callZone === context.pickedCallZone);
      if (item) {
        runActionFromSheet(item);
      }
    });
    footer.append(decide);
  }
  actions.append(footer);
}

// ---- 対象選択（攻撃/効果）：盤面タップで隠しselectの値を設定 ----

function startAttackTargeting() {
  // 攻撃宣言できない状況では対象選択モードに入らない（バナー/減光だけ残る混乱を防ぐ）。
  if (state.winner || hasPendingResolution() || !["attack", "final"].includes(state.phase)) {
    addLog("攻撃はアタックフェイズ／ファイナルフェイズでのみ宣言できます。");
    showToast("攻撃はアタックフェイズでのみ宣言できます");
    render();
    return;
  }
  const candidates = computeAttackTargetCandidates();
  if (candidates.length === 0) {
    addLog("攻撃できる対象がありません（行動済み・攻撃制限などを確認してください）。");
    showToast("攻撃できる対象がありません");
    render();
    return;
  }
  uiTargeting = { mode: "attack", candidates };
  closeCardSheet();
  closeActionMenu();
  render();
}

// 権威版仕様: 対象タップで即・攻撃宣言（確認ダイアログは挟まない）。
async function confirmAttackTarget(value) {
  uiTargeting = null;
  // T7（pt-fix-a/pt-fix-e 共通）: 対象を確定したら「攻撃対象をタップ」のバナー/候補ハイライトを即座に消す。攻撃宣言の処理中（攻撃時誘発の
  // 選択ダイアログ等）は render が走らず、以前は防御フェイズに入るまで残っていた（キャンセル位置と重なり誤タップ）。
  refreshTargeting(); // uiTargeting=null なのでハイライト除去＋バナー消去だけを行う
  elements.attackTarget.value = value;
  await runNetworkMutation("攻撃宣言", attackAction);
  render(); // 拒否時（先攻1ターン目の連携等）も解いた連携・選択を盤面へ反映する
}

// pending: {type:"use"} または {type:"call", zone}（対象確定後に実行する操作。権威版と同じ1段階フロー）。
function startEffectTargeting(pending) {
  const card = getSelectedCard();
  const candidates = card ? effectTargetCandidates(card) : [];
  if (candidates.length === 0) {
    addLog("効果対象の候補がありません。");
    showToast("効果対象の候補がありません");
    render();
    return;
  }
  uiTargeting = {
    mode: "effect",
    pending: pending && pending.type ? pending : { type: "use" },
    candidates: candidates.map((candidate) => ({ owner: candidate.owner, zone: candidate.zone })),
  };
  closeCardSheet();
  closeActionMenu();
  render();
}

function pickEffectTarget(owner, zone) {
  if (!uiTargeting || uiTargeting.mode !== "effect") {
    return;
  }
  const pending = uiTargeting.pending || { type: "use" };
  uiTargeting = null;
  elements.effectTarget.value = encodeTarget(owner, zone);
  render(); // effectTarget.value反映
  // 権威版と同じ1段階: 対象タップで即実行（従来のシート再表示→ボタン押下は廃止）。
  if (pending.type === "call" && pending.zone) {
    runNetworkMutation("コール", () => callMonster(pending.zone));
  } else {
    runNetworkMutation("カード使用", useCardAction);
  }
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
        // 権威版と同じく「本体＝相手の装備枠」をタップ対象として強調（fighter-panelタップも受付は継続）。
        highlightZoneElement(candidate.owner, "item", "attack-target-candidate");
      } else {
        highlightZoneElement(candidate.owner, candidate.zone, "attack-target-candidate");
      }
    });
    setTargetingBanner("攻撃対象をタップ（本体は相手の『装備』枠）");
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

// pt-final(4): 候補の札が「まとめて表示される枠」にある時（設置魔法 set1..setN＝配置魔法パイル／追加アイテム
// item2..＝アイテム枠）は、そのまとめ枠を光らせる（以前は該当 DOM が無く何も光らなかった）。
function zoneHighlightElement(owner, zone) {
  const direct = document.querySelector(`.zone[data-owner="${owner}"][data-zone="${zone}"]`);
  if (direct) return direct;
  if (/^item\d+$/.test(String(zone))) return document.querySelector(`.zone[data-owner="${owner}"][data-zone="item"]`);
  if (/^set\d*$/.test(String(zone))) return document.querySelector(`.set-pile[data-owner="${owner}"]`);
  return null;
}

function highlightZoneElement(owner, zone, className) {
  zoneHighlightElement(owner, zone)?.classList.add(className);
}

// pt-final(4): まとめ枠（配置魔法パイル・複数アイテムの枠）をタップした時、その中の候補が複数なら選ぶ一覧を出す
// （1つならそれを返す）。candidates=[{owner,zone}]・group="set"|"item"。onPick(zone) で確定。候補が無ければ false。
function pickGroupedZoneCandidate(owner, group, candidates, onPick) {
  const player = state.players?.[owner];
  const inGroup = (zone) => (group === "set" ? /^set\d*$/.test(zone) : /^item\d*$/.test(zone));
  const list = (candidates || []).filter((candidate) => candidate.owner === owner && inGroup(String(candidate.zone)) && player?.field?.[candidate.zone]);
  if (list.length === 0) return false;
  if (list.length === 1) {
    onPick(list[0].zone);
    return true;
  }
  showActionMenu(
    list.map((candidate) => ({
      label: `${player.field[candidate.zone].faceDown ? "（裏向きの配置魔法）" : player.field[candidate.zone].name}を選ぶ`,
      run: () => onPick(candidate.zone),
    })),
  );
  return true;
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
  ];
  elements.deckInfoTitle.textContent = `${player.name} のデッキ情報`;
  elements.deckInfoBody.innerHTML = rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  // バディ行はDOMで組む: カードがあればタップで能力詳細（閲覧専用カードシート）を開く。
  // 対戦中もデッキ情報からバディの効果を確認したい、という要望（権威版 play.js と同じ動線）。
  const buddyRow = document.createElement("div");
  const buddyDt = document.createElement("dt");
  buddyDt.textContent = "バディ";
  const buddyDd = document.createElement("dd");
  if (player.buddy) {
    const buddyButton = document.createElement("button");
    buddyButton.type = "button";
    buddyButton.className = "buddy-detail-link";
    buddyButton.textContent = buddyName;
    buddyButton.title = "タップでバディの詳細を表示";
    buddyButton.addEventListener("click", () => openReadOnlyCardSheet(player.buddy));
    buddyDd.append(buddyButton);
  } else {
    buddyDd.textContent = buddyName;
  }
  buddyRow.append(buddyDt, buddyDd);
  elements.deckInfoBody.append(buddyRow);
  if (!elements.deckInfoDialog.open) {
    elements.deckInfoDialog.showModal();
  }
}

// ---- 確認ダイアログ（不可逆操作）----
function confirmAction(message) {
  // B3: リプレイ再生中は記録済みの真偽値を返す（確認ダイアログを出さない・確認UIは変えない）。
  if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
    return Promise.resolve(replayNextConfirm());
  }
  const compute = () => {
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
  };
  // 記録中なら確認応答（真偽値）として控える。
  return Promise.resolve(compute()).then((answer) => {
    if (typeof replayRecordConfirm === "function") {
      replayRecordConfirm(answer);
    }
    return answer;
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


// ---- スマホの「戻る」（Android の戻るボタン・ブラウザの戻る）: 開いている物を1つ閉じる。何も無ければ離脱を確認 ----
// 対戦ページ（body.bf-game）をスマホ幅で開いた時だけ、履歴に1段積んで popstate を受ける（PC は従来どおり）。
function closeTopmostPhoneLayer() {
  const openDialog = (id) => document.getElementById(id)?.open;
  if (openDialog("confirmDialog")) {
    resolveConfirmDialog(false);
    return true;
  }
  if (openDialog("cardSheet")) {
    closeCardSheet();
    return true;
  }
  for (const id of ["dropDialog", "soulDialog", "deckInfoDialog", "rulesDialog", "matchHistoryDialog"]) {
    if (openDialog(id)) {
      document.getElementById(id).close();
      return true;
    }
  }
  if (document.getElementById("playActionMenu")) {
    document.querySelector("#playActionMenu .menu-close")?.click();
    return true;
  }
  if (openDialog("selectionDialog")) {
    const cancel = document.getElementById("selectionCancelButton");
    if (cancel && !cancel.disabled) cancel.click();
    return true; // キャンセル不可の選択は閉じない（ページにも留まる）
  }
  for (const cls of ["nav-open", "log-open"]) {
    if (document.body.classList.contains(cls)) {
      window.bfToggleBodyClass ? window.bfToggleBodyClass(cls, cls === "nav-open" ? ".nav-toggle" : ".log-toggle") : document.body.classList.remove(cls);
      return true;
    }
  }
  if (document.body.classList.contains("targeting-active")) {
    document.getElementById("targetingCancelButton")?.click();
    return true;
  }
  if (document.getElementById("counterWindowBar")) {
    return true; // 対抗窓は答えるまで閉じない（パス/使う）
  }
  return false;
}

function installPhoneBackGuard() {
  if (typeof window === "undefined" || typeof history === "undefined" || typeof history.pushState !== "function") return;
  if (!(typeof isPhoneLayout === "function" && isPhoneLayout())) return;
  if (globalThis.__BUDDYFIGHT_SERVER__) return;
  history.pushState({ bfGuard: true }, "");
  window.addEventListener("popstate", () => {
    if (closeTopmostPhoneLayer()) {
      history.pushState({ bfGuard: true }, "");
      return;
    }
    if (window.confirm("対戦ページから離れますか？（対戦の状態は残りません）")) {
      history.back();
      return;
    }
    history.pushState({ bfGuard: true }, "");
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof document.addEventListener === "function" && !globalThis.__BUDDYFIGHT_SERVER__) {
  installPhoneBackGuard();
}

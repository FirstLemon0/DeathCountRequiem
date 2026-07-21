// ==========================================================================
// buddyfight モジュール 15 — 効果実行・dispatch・ステータス変更・能力制限
// 旧 app.js L8026-9191 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
async function executeAbilityEffects(effects, context) {
  for (const effect of effects) {
    await executeAbilityEffect(effect, context);
  }
}

// 汎用 effect.conditions ゲート（executeAbilityEffect内）を素通りさせる op の集合。
// これらの op は effect.conditions を「発動時に一括評価される前提条件」としてではなく、
// 「消費側(対抗ウィンドウ等)で対象イベントごとに後評価するwhile条件」として自前で保持・消費する。
// 発動時点(メインフェイズ解決など)ではその条件の前提(例: state.pendingAttack)がまだ存在しないため、
// 汎用ゲートで先評価すると常にfalseとなり op 自体が不発になってしまう（0057 アブソリュート・アタック等）。
const CONDITIONS_DEFERRED_TO_CONSUMER_OPS = new Set(["preventOpponentCounterThisTurn"]);

// ==========================================================================
// ソウルイン/ドロップ移動の共有プリミティブ（誘発つき移動）
// 新しい「ソウルに入れる」「ドロップに置く」系の op/コスト実装は必ずこの2関数を使うこと。
// queueEnteredSoulTriggers / queueMovedToDropTriggers を各所で手撒きすると発火漏れの温床になる。
// ==========================================================================

// cards を hostCard のソウル末尾に積み、「ソウルに入った時」（enteredSoul）誘発を queue する。
// owner: ソウルに入るカードの持ち主（seat index）。fromZone: "field" | "drop" | "hand" | "deck" 等の出所。
// options.alreadyPlaced: true なら移動（push）は呼び出し元で完了済みで、誘発の queue のみ行う。
function putCardsToSoulWithTrigger(hostCard, owner, cards, fromZone, options = {}) {
  if (!hostCard || !cards || cards.length === 0) {
    return;
  }
  if (!options.alreadyPlaced) {
    hostCard.soul ||= [];
    hostCard.soul.push(...cards);
  }
  // E-Y1(X-BT01 奇襲): options.faceDown で「裏向きで」ソウルに入れる。所有者以外へは viewFor が伏せる
  // （src=engine-host.js）。ソウル→ドロップで公開＝reconcileFaceDownSoulDrops が faceDown を解除する。
  if (options.faceDown) {
    markSoulCardsFaceDown(cards, hostCard);
  } else {
    // E-XC12(X-CP02/0029 ヴィーガー "ダブルアームビット"): 表向きソウル札のうち selfDroppedFromSoul 誘発を
    // 持つものにホストの公開スナップショットを付ける（faceDown は付けない＝秘匿対象ではない）。落下時に
    // reconcileFaceDownSoulDrops が __soulHost を見て自己離脱を発火し hostFilter を照合する。
    markFaceUpSoulSelfDropHost(cards, hostCard);
  }
  cards.forEach((soulCard) => queueEnteredSoulTriggers(soulCard, owner, fromZone, hostCard));
  // E-XB24: ホスト側の「ソウルが入った時」場ブロードキャスト（funnel 経由の全 soul-in を一括で拾う）。
  queueSoulCardAddedTriggers(hostCard, owner, cards.length, cards[0] || null);
}

// E-XB44(ワールド・パンデミック): フラッグ裏返しに伴う「場のカードは全てドロップゾーンに置かれる」の一括処理。
// 破壊ではなくルール上の場移動なので、破壊/離場誘発・ソウルガード・破壊置換は一切通さず、各枠のカードと
// そのソウルを所有者のドロップへ順に移す（カード総数保存＝fuzz の card-conservation と整合）。
function sweepFieldToDropForFlagFlip(player) {
  for (const zone of zones) {
    const card = player.field[zone];
    if (!card) {
      continue;
    }
    player.field[zone] = null;
    if (Array.isArray(card.soul) && card.soul.length) {
      player.drop.push(...card.soul);
      card.soul = [];
    }
    player.drop.push(card);
  }
}

// E-Y1(X-BT01 奇襲): ソウルに入れた cards を「裏向き」に印付けする共有ヘルパー。
// - faceDown=true: viewFor が所有者以外へ伏せる対象（秘匿の核）。
// - __soulHost: ホストの公開スナップショット。落下時 selfDroppedFromSoul の hostFilter 照合に使う
//   （0067 袖の下「場の《暗殺鬼》の裏向きのソウルから落ちた時」）。表情報は含めない（instanceId/名前/属性/種別のみ＝
//   ホストは場の公開カード）。挿入時に確定するため、以後ホストが場を離れても落下時に種別/属性を照合できる。
function soulHostSnapshot(hostCard) {
  return hostCard
    ? {
        instanceId: hostCard.instanceId,
        name: hostCard.name,
        type: hostCard.type,
        currentType: effectiveCardType(hostCard),
        attributes: [...(hostCard.attributes || [])],
      }
    : null;
}
function markSoulCardsFaceDown(cards, hostCard) {
  const snapshot = soulHostSnapshot(hostCard);
  (cards || []).forEach((soulCard) => {
    if (!soulCard) {
      return;
    }
    soulCard.faceDown = true;
    if (snapshot) {
      soulCard.__soulHost = snapshot;
    }
  });
  return cards;
}

// E-XC12(X-CP02/0029 竜装機ヴィーガー "ダブルアームビット"): 表向きでソウルに入る札のうち
// selfDroppedFromSoul 誘発を持つものだけにホストの公開スナップショット(__soulHost)を付ける（faceDown は
// 付けない＝秘匿対象ではない・viewFor でも伏せない）。落下時 reconcileFaceDownSoulDrops が __soulHost を
// 見て自己離脱誘発を発火し、ability.hostFilter でホスト（例《ネオドラゴン》）を照合する。listener を持たない
// 札は一切タグ付けしない（オプトイン＝既存の表向きソウル札の挙動不変）。
function markFaceUpSoulSelfDropHost(cards, hostCard) {
  const snapshot = soulHostSnapshot(hostCard);
  if (!snapshot) {
    return;
  }
  (cards || []).forEach((soulCard) => {
    if (!soulCard || soulCard.faceDown) {
      return;
    }
    const hasSelfDrop = (soulCard.abilities || []).some(
      (ability) => ability.kind === "triggered" && ability.event === "selfDroppedFromSoul",
    );
    if (hasSelfDrop) {
      soulCard.__soulHost = snapshot;
    }
  });
}

// cards を player のドロップ末尾に積み、「場かデッキからドロップに置かれた時」（movedToDrop）誘発を queue する。
// 誘発は fromZone が "field" | "deck" の時のみ（queueMovedToDropTriggers の対応範囲。手札/ソウル由来は発火しない）。
// owner: カードの持ち主（seat index）。options.alreadyPlaced: true なら push 済みで誘発の queue のみ行う。
// E5(D-BT04): fromZone==="deck"（ミル）は場ブロードキャスト deckMilled も queue する（src/07）。
// options.cause = 起因（効果op は makeEffectCause／コストstep は {byCost,...}。未指定は cause 無し＝
// eventMillCauseMatches は不成立）。deckMilled リスナーを持つ既存カードは無い＝既存挙動不変。
function putCardsToDropWithTrigger(player, owner, cards, fromZone, options = {}) {
  if (!player || !cards || cards.length === 0) {
    return;
  }
  if (!options.alreadyPlaced) {
    player.drop.push(...cards);
  }
  if (["field", "deck"].includes(fromZone)) {
    cards.forEach((dropCard) => queueMovedToDropTriggers(dropCard, owner, fromZone));
  }
  if (fromZone === "field") {
    // E-XB57(X-UB03/0010 虹色特権): 場→ドロップの非破壊移動（script moveSelected 等）も field-wide movedToDrop を配送する。
    // deck→ドロップ（ミル）は「場からドロップに置かれた時」に該当しないため対象外（queueMovedToDropField 内でも fromZone を再ガード）。
    cards.forEach((dropCard) => queueMovedToDropFieldTriggers(dropCard, owner, fromZone));
  }
  if (fromZone === "deck") {
    queueDeckMilledTriggers(owner, cards, options.cause || null);
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
      // 権威サーバ: じゃんけんは各プレイヤー自身へ問う。promptSeat を明示しないと
      // 往復の宛先が能動側(state.active)に推定され、相手の選択が能動側へ誤配送される。
      promptSeat: owner,
      purpose: "rps", // CPU対戦(src/22): ジャンケンの手選択
    });
    return selected?.[0]?.key || null;
  };
  const winsAgainst = {
    rock: "scissors",
    scissors: "paper",
    paper: "rock",
  };
  let selfChoice;
  let opponentChoice;
  let result;
  // rockPaperScissorsRedo を持つ場札があり、勝敗確定後にコストを払える間、やり直しを選べる（謎のデカラビア 0037）。
  // 「負けてもやり直せる」ため結果に関わらず提示。1回のやり直しごとにコストを支払う。
  for (;;) {
    selfChoice = await choose(context.owner);
    opponentChoice = await choose(1 - context.owner);
    result =
      !selfChoice || !opponentChoice
        ? "cancelled"
        : selfChoice === opponentChoice
          ? "draw"
          : winsAgainst[selfChoice] === opponentChoice
            ? "win"
            : "lose";
    addLog(`${context.card.name}のジャンケン結果: ${state.players[context.owner].name}は${rockPaperScissorsLabel(selfChoice)}、${state.players[1 - context.owner].name}は${rockPaperScissorsLabel(opponentChoice)}。`);
    const redoCard = zones
      .map((zone) => state.players[context.owner]?.field?.[zone])
      .find((c) => c?.rockPaperScissorsRedo && !isAbilitiesNullified(c));
    if (result === "cancelled" || !redoCard) {
      break;
    }
    const redoCost = redoCard.rockPaperScissorsRedo.cost || [];
    if (!canPayStructuredCost(state.players[context.owner], redoCost, { sourceCard: redoCard }).ok) {
      break;
    }
    if (!(await confirmChoiceAsync(context.owner, `${redoCard.name}でジャンケンをやり直しますか？（コストを支払う）`, { purpose: "pay-optional" }))) {
      break;
    }
    payStructuredCost(state.players[context.owner], redoCost, { sourceCard: redoCard });
    addLog(`${redoCard.name}の効果でジャンケンをやり直します。`);
  }
  recordDiagnosticEvent("rock_paper_scissors", {
    source: compactCardForLog(context.card),
    owner: context.owner,
    selfChoice,
    opponentChoice,
    result,
  });
  return result;
}

function rockPaperScissorsLabel(choice) {
  return {
    rock: "グー",
    scissors: "チョキ",
    paper: "パー",
  }[choice] || "未選択";
}

// Z11(S-UB-C03/0050): 相手のカードの効果で手札が捨てられる場合、手札の handDiscardGuard を持つカードを
// 公開しコストを払って捨て札を防げる（「その効果で君の手札は捨てられない」）。true を返した時、
// 呼び出し元(discardHand/discardAllHand)は当該捨て札処理全体をスキップする。
// カード側キー形: handDiscardGuard:{cost:[{op:"payLife",amount:1}], reveal:true}。
async function maybeApplyHandDiscardGuard(receiver, context) {
  const guardCard = (receiver.hand || []).find((card) => card.handDiscardGuard);
  if (!guardCard) {
    return false;
  }
  const guard = guardCard.handDiscardGuard || {};
  const receiverOwner = state.players.indexOf(receiver);
  if (guard.cost?.length && !canPayStructuredCost(receiver, guard.cost, { sourceCard: guardCard }).ok) {
    return false;
  }
  const use = await confirmChoiceAsync(
    receiverOwner,
    `${guardCard.name}を公開してコストを払い、手札が捨てられるのを防ぎますか？`,
    { purpose: "handDiscardGuard" },
  );
  if (!use) {
    return false;
  }
  if (guard.cost?.length) {
    await payStructuredCostWithSelection(receiver, guard.cost, { sourceCard: guardCard });
  }
  addLog(`${receiver.name}は${guardCard.name}を公開し、${context.card?.name || "効果"}で手札は捨てられませんでした。`);
  return true;
}

// E-XB8(X-CP03/0058 ファントム・ゲッター): この dealDamage が"霊撃"か。霊撃は「破壊された時に相手へ
// ダメージ」＝event:"destroyByAttack" の dealDamage（＋明示 effect.spiritStrike）で表現される既存概念で、
// spiritStrikeDamageBonus の同定条件と一致させる。ブースト加算点と被弾トリガー点で共有する。
function damageIsSpiritStrike(effect, context) {
  return Boolean(effect.spiritStrike) || context.ability?.event === "destroyByAttack";
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
  // ただし CONDITIONS_DEFERRED_TO_CONSUMER_OPS に属する op は、conditions を消費側で後評価するためここでは評価しない。
  if (
    Array.isArray(effect.conditions) && effect.conditions.length > 0 &&
    !CONDITIONS_DEFERRED_TO_CONSUMER_OPS.has(effect.op) &&
    !checkCardConditions(effect.conditions, context.owner, { ...context, target })
  ) {
    return;
  }
  if (effect.op === "draw") {
    const drawer = effect.player === "opponent" ? opponent : player;
    if (isDrawByEffectPrevented(state.players.indexOf(drawer))) {
      addLog(`${drawer.name}はカードの効果でカードを引けません。`);
    } else {
      // amountFrom 対応（gainLife/putTopDeckToGauge/dealDamage と同形。X-CP01/0020「破壊した枚数分、カードを引く」＝lastDestroyedCount）。
      const amount = effect.amountFrom ? resolveAmountFrom(effect.amountFrom, context) : effect.amount || 1;
      const drew = drawCards(drawer, amount);
      // 後方互換: amountFrom 未指定時の発火判定は元の effect.amount の生値の真偽（デフォルト適用前）に完全一致させる
      // （effect.amount 省略時は drew!==0 のみで判定＝既存呼び出し0件変更。amountFrom 使用時は解決後amountの真偽で判定）。
      if (drew !== 0 || (effect.amountFrom ? amount : effect.amount)) {
        await runFieldEventTriggers("drawByEffect", state.players.indexOf(drawer));
      }
    }
  }
  if (effect.op === "drawUpToHand") {
    // 手札が effect.amount 枚になるように引く（既に同数以上なら引かない）。
    // 例: ドラゴニック・ディレクティブ「手札が２枚以下なら３枚になるように引く」。
    const targetHand = effect.amount || 0;
    const toDraw = Math.max(0, targetHand - player.hand.length);
    if (toDraw > 0 && isDrawByEffectPrevented(state.players.indexOf(player))) {
      addLog(`${player.name}はカードの効果でカードを引けません。`);
    } else {
      drawCards(player, toDraw);
      if (toDraw > 0) {
        await runFieldEventTriggers("drawByEffect", state.players.indexOf(player));
      }
    }
  }
  if (effect.op === "putTopDeckToGauge") {
    const receiver = effect.player === "opponent" ? opponent : player;
    // amountFrom（selectedCount 等）で動的枚数を指定可能（0058:「ドロップに置いた枚数分」）。
    const amount = effect.amountFrom ? resolveAmountFrom(effect.amountFrom, context) : effect.amount || 1;
    const before = receiver.gauge.length;
    moveTopDeckToGauge(receiver, amount);
    const moved = receiver.gauge.length - before;
    addLog(`${receiver.name}はデッキの上から${moved}枚をゲージに置きました。`);
  }
  if (effect.op === "putTopDeckToSoul" && context.card) {
    const receiver = effect.player === "opponent" ? opponent : player;
    const before = context.card.soul?.length || 0;
    moveTopDeckToSoul(receiver, context.card, effect.amount || 1, Boolean(effect.faceDown)); // E-Y1(奇襲): faceDown
    const moved = (context.card.soul?.length || 0) - before;
    addLog(`${context.card.name}のソウルにデッキの上から${moved}枚を入れました。`);
  }
  if (effect.op === "putTopDeckToBuddyZoneFaceDown") {
    // Z2(S-UB-C03/0095他): デッキ上からamount枚を裏向きで自分のバディゾーンパイルへ置く。
    // ログにカード名を出さない（ネット対戦で相手にも見えるログからの秘匿カード名リーク防止。Z2秘匿方針）。
    const receiver = effect.player === "opponent" ? opponent : player;
    const amount = effect.amountFrom ? resolveAmountFrom(effect.amountFrom, context) : effect.amount || 1;
    receiver.buddyZoneFaceDown ||= [];
    let moved = 0;
    for (let index = 0; index < amount; index += 1) {
      const card = receiver.deck.pop();
      if (!card) {
        break;
      }
      receiver.buddyZoneFaceDown.push(card);
      moved += 1;
    }
    if (moved > 0) {
      addLog(`${receiver.name}はデッキの上から${moved}枚を裏向きでバディゾーンに置きました。`);
    }
    if (receiver.deck.length === 0) {
      declareDeckLoss(receiver);
    }
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
    // X15(D-BT01/0039): amountFrom 対応（「破壊したカードのサイズの数値分ミル」等。dealDamage と同形）。
    const millAmount = effect.amountFrom ? resolveAmountFrom(effect.amountFrom, context) : effect.amount || 1;
    for (let index = 0; index < millAmount; index += 1) {
      const movedCard = receiver.deck.pop();
      if (movedCard) {
        movedCards.push(movedCard);
      }
    }
    // E5: ミルの起因（誰のカードの効果か）を deckMilled ブロードキャストへ伝播（0039/0098 が照合）。
    // ★ブロードキャストは「op 1回＝1バッチ」で発火する（per-card にすると microtask チェーンが
    // 複数本立ち、await 点の交錯で limit マーク前に2本目が走る＝named-once の二重計上レースになる。
    // プローブ E5(g) で実測）。movedToDrop 誘発は従来どおり funnel 内で per-card に queue される。
    putCardsToDropWithTrigger(receiver, state.players.indexOf(receiver), movedCards, "deck", {
      cause: makeEffectCause(context, state.players.indexOf(receiver)),
    }); // mill でデッキからドロップへ
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
    // G1(D-EB01/0019/0029/0050): 「今回めくって置いた」配列を context.milled に記録（都度上書き）。
    // 直後の effects で amountFrom milledMatchCount / conditions milledDistinctAttributeCountGte /
    // milledContains が参照する（movedToDrop は解決全体で累積するのに対し milled は最新のミルのみ）。
    context.milled = movedCards.slice();
  }
  if (effect.op === "searchDeckToHand") {
    // X4(D-BT01/0072/0133): デッキから filter に一致するカードを amount 枚まで選んで手札に加え、デッキをシャッフルする。
    // optional/「までを」= min 0。候補提示は選択ダイアログ（デッキ非公開情報だが自分のサーチは公開処理で可）。
    const searcher = effect.player === "opponent" ? opponent : player;
    const searcherOwner = state.players.indexOf(searcher);
    const candidates = searcher.deck
      .map((card, index) => ({ card, index, owner: searcherOwner }))
      // E-XC15(X-CP01/0061): owner を渡して filter.buddy を「デッキ内でも」検索主の登録バディ名で判定させる。
      .filter((entry) => matchesCardFilter(entry.card, effect.filter || {}, { owner: searcherOwner }));
    const wanted = effect.amount || 1;
    if (candidates.length > 0) {
      const picked = await chooseCardEntries(candidates, {
        title: `${context.card?.name || "効果"}のデッキサーチ`,
        lead: `手札に加えるカードを${wanted}枚まで選んでください。`,
        min: effect.optional === false ? Math.min(wanted, candidates.length) : 0,
        max: wanted,
        forceDialog: true,
        promptSeat: searcherOwner,
        purpose: "search",
      });
      for (const entry of picked || []) {
        const deckIndex = searcher.deck.indexOf(entry.card);
        if (deckIndex >= 0) {
          searcher.deck.splice(deckIndex, 1);
          searcher.hand.push(entry.card);
          addLog(`${searcher.name}はデッキから${entry.card.name}を手札に加えました。`);
        }
      }
    } else {
      addLog(`${searcher.name}のデッキに対象のカードがありませんでした。`);
    }
    if (effect.shuffle !== false) {
      shuffleInPlace(searcher.deck);
      addLog(`${searcher.name}はデッキをシャッフルしました。`);
    }
    if (searcher.deck.length === 0) {
      declareDeckLoss(searcher); // レビュー修正: サーチでデッキ0枚もデッキ切れ敗北の対象
    }
  }
  if (effect.op === "moveDeckBottomToHand") {
    // E-PR2(PR/0166 想刻騎竜 メモリー・グレイブ): 「君のデッキの１番下のカード１枚を手札に加える」。
    // デッキ向き規約: top=末尾（pop/push）／bottom=先頭（shift/unshift）。returnSelfToDeckBottom の
    // 「unshift=最下」(このファイル 1398 付近)と対称で、山下の読み出しは deck.shift()（deck[0]）。
    // 「加える」は選ばず自動取得＝伏せ札のまま手札へ入るため、カード名は addLog しない
    //（state.log は viewFor で伏せられず両席・観戦者へ配信されるので、名前を出すと秘匿情報が漏れる。
    //  自分で選ぶ公開サーチの searchDeckToHand が名前を出すのとは非対称）。
    // デッキ0枚は no-op（「引く」ではなく「加える」なのでデッキ切れ敗北判定はしない）。
    const receiver = effect.player === "opponent" ? opponent : player;
    const amount = effect.amount || 1;
    let moved = 0;
    for (let i = 0; i < amount; i += 1) {
      if (receiver.deck.length === 0) {
        break;
      }
      receiver.hand.push(receiver.deck.shift());
      moved += 1;
    }
    if (moved > 0) {
      addLog(`${receiver.name}はデッキの1番下のカードを手札に加えました。`);
    }
  }
  if (effect.op === "restrictCallThisTurn") {
    // X6(D-BT01/0064): 「そのターン中、君は（allowFilter に一致するカード）以外のモンスターをコールできない」。
    // 魔法など場に残らないカードからのターン限定コール制限（isCallRestricted が参照・clearTurnModifiers で解除）。
    const restricted = effect.player === "opponent" ? 1 - context.owner : context.owner;
    state.callRestrictionsThisTurn ||= [];
    state.callRestrictionsThisTurn.push({
      owner: restricted,
      allowFilter: effect.allowFilter || null,
      // E-XB59①(X-UB03/0031 エニグマ・ウィルス①): byEffectOnly:true は「カードの効果でのコールのみ」を禁止する
      //   （手打ちの通常コールは許可）。効果コール5op を判定する turnCallRestrictionBlocks(src/07) は従来どおり掛かり、
      //   通常コールを判定する isCallRestricted(src/18) は byEffectOnly エントリを読み飛ばす。未指定=従来の全面禁止（後方互換）。
      byEffectOnly: Boolean(effect.byEffectOnly),
      sourceName: context.card?.name || "効果",
    });
    addLog(
      effect.byEffectOnly
        ? `${state.players[restricted].name}はこのターン、カードの効果でモンスターをコールできません。`
        : `${state.players[restricted].name}はこのターン、コールできるカードが制限されます。`,
    );
  }
  if (effect.op === "restrictCallCountPerTurn") {
    // E-XB7(X-SS03/0060 ロイヤルティ): 「そのターン中、相手はN枚以上モンスターをコールできない」。
    // max＝そのターンにコールできる最大枚数（「4枚以上コールできない」＝max:3）。総コール枚数キャップは
    // 同名単位の callLimitPerTurn とは別軸。clearTurnModifiers で解除・isCallCountCappedThisTurn(src/07)が参照。
    const capped =
      effect.controller === "opponent" || effect.player === "opponent"
        ? 1 - context.owner
        : context.owner;
    const max = Math.max(0, effect.max ?? effect.amount ?? 1);
    state.callCountCapsThisTurn ||= [];
    state.callCountCapsThisTurn.push({ owner: capped, max, sourceName: context.card?.name || "効果" });
    addLog(`${state.players[capped].name}はこのターン、モンスターを${max}枚までしかコールできません。`);
  }
  if (effect.op === "lookTopSelectToSoulRestToDrop") {
    // X10(D-BT01/0044/0050): デッキの上から count 枚を見て amount 枚をこのカードのソウルへ、残りをドロップへ。
    // レビュー修正: (a)プレイヤーに amount 枚を選ばせる（自動先頭取りにしない） (b)ソウル/ドロップ移動は
    // *WithTrigger 経由（enteredSoul=スラスターズ・レスポンス 0045、movedToDrop 誘発を発火させる）。
    const looked = [];
    for (let index = 0; index < (effect.count || 1); index += 1) {
      const drawn = player.deck.pop();
      if (drawn) looked.push(drawn);
    }
    if (looked.length > 0) {
      const soulOwner = state.players.indexOf(player);
      const wanted = Math.min(effect.amount || 1, looked.length);
      const picked = await chooseCardEntries(
        looked.map((card) => ({ card, owner: soulOwner })),
        {
          title: `${context.card?.name || "効果"}で見たデッキの上のカード`,
          lead: `ソウルに入れるカードを${wanted}枚選んでください（残りはドロップゾーンへ）。`,
          min: wanted,
          max: wanted,
          forceDialog: true,
          promptSeat: soulOwner,
          purpose: "search",
        },
      );
      const toSoul = (picked || []).map((entry) => entry.card);
      const rest = looked.filter((card) => !toSoul.includes(card));
      if (toSoul.length > 0) {
        putCardsToSoulWithTrigger(context.card, soulOwner, toSoul, "deck");
        if (effect.faceDown) {
          markSoulCardsFaceDown(toSoul, context.card); // FE3/E-Y1(奇襲): 「裏向きで」（秘匿・名前を伏せる）
        }
        addLog(
          effect.faceDown
            ? `デッキの上から${toSoul.length}枚を裏向きで${context.card?.name || ""}のソウルに入れました。`
            : `デッキの上から${toSoul.length}枚を${context.card?.name || ""}のソウルに入れました。`,
        );
      }
      if (rest.length > 0) {
        putCardsToDropWithTrigger(player, soulOwner, rest, "deck", { cause: makeEffectCause(context, soulOwner) }); // E5
        addLog(`残りの${rest.length}枚をドロップゾーンに置きました。`);
      }
    }
    if (player.deck.length === 0) {
      declareDeckLoss(player);
    }
  }
  if (effect.op === "lookTopSelectToSoulOrHand") {
    // E-ZA3(X-SS02/0001 英雄竜 ジャックナイフ): 「このカードが登場した時、君のデッキの上から1枚を見る。
    // その後、そのカードをこのカードのソウルに入れるか、手札に加える。」
    // ・デッキ上1枚を owner にのみ開示（confirmChoiceAsync の promptSeat=context.owner。往復は該当席のみ＝
    //   lookTopCardPlaceTopOrBottom と同じ「見る」の秘匿）し、ソウル/手札の二択で選んだ先へ移す。
    // ・秘匿厳守(T13 精神): state.log にカード名を出さない（log は両席/観戦へ配信＝下の addLog は枚数のみ）。
    //   デッキは全ロールで枚数のみ（viewFor/hiddenPile）＝開示は owner の往復プロンプトだけ。見た1枚は
    //   pop 済み＝どのゾーンにも無い（クロージャ保持）。busy 中は room 非永続＝再開時は宣言時から再実行され整合。
    // ・ホスト(ソウルの入れ先)は既定で発生源自身(context.card)。hostVar 指定時は事前選択した場カードのソウルへ
    //   （将来 X-BT02 等での再利用向け。scriptSelection は未確定なら [] を返すので既定の self へフォールバック）。
    const host = effect.hostVar
      ? scriptSelection({ var: effect.hostVar }, context)[0]?.card || context.card
      : context.card;
    if (player.deck.length === 0 || !host) {
      // デッキ0枚（または host 不在）は no-op（見るカードが無い）。カード名は出さない。
      addLog(`${context.card?.name || "効果"}で見るカードがありません。`);
    } else {
      const soulOwner = state.players.indexOf(player);
      const top = player.deck.pop();
      const toSoul = await confirmChoiceAsync(
        context.owner,
        `${context.card?.name || "効果"}: デッキの上の${top.name}を、${host.name}のソウルに入れますか？（いいえ＝手札に加える）`,
        { yesLabel: "ソウルに入れる", noLabel: "手札に加える", purpose: "search" },
      );
      if (toSoul) {
        // enteredSoul 誘発を発火（0004 光核反応「ジャックナイフのソウルに入った時」等の再出誘発を通す）。
        putCardsToSoulWithTrigger(host, soulOwner, [top], "deck", { faceDown: Boolean(effect.faceDown) });
        addLog(`${context.card?.name || "効果"}でデッキの上から1枚を${host.name}のソウルに入れました。`);
      } else {
        player.hand.push(top);
        addLog(`${context.card?.name || "効果"}でデッキの上から1枚を手札に加えました。`);
      }
    }
  }
  if (effect.op === "addTurnContinuous" && effect.anchor === "player") {
    // E-XB64(X2-BT01/0052 逆雷の源泉③): プレイヤー単位のターン限定継続（発生源カードに縛られない匿名アンカー）。
    //   「そのターン中、君の場にカード名に『ヤミゲドウ』を含むモンスターがいるなら、君のカードの効果で相手に与える
    //   ダメージは減らない」＝魔法（解決後ドロップへ移り場に残らない）から張る player-wide 継続。card-anchored な
    //   turnContinuous では魔法自身が場を離れて消えるため、state.turnPlayerContinuous[owner] に格納する（state 常駐＝
    //   room 復元/リプレイで往復・JSON 直列化可）。継続側 conditions（ownFieldCardExists 等）はスキャナが毎評価する
    //   ため「ヤミゲドウが在場のあいだだけ」効く。clearTurnModifiers（src/11）がターン境界で破棄する。
    //   スキャナ（例 ownEffectDamageUnreducibleActive・src/04）が effect.op を op として読むため、item は素の
    //   {op, conditions, ...} を積む（deep-copy して発生源の後続変更から隔離）。既存カードは anchor 未指定＝この分岐を踏まない。
    state.turnPlayerContinuous ||= [[], []];
    const seat = context.owner;
    if ((seat === 0 || seat === 1) && effect.continuous) {
      const items = Array.isArray(effect.continuous) ? effect.continuous : [effect.continuous];
      state.turnPlayerContinuous[seat] ||= [];
      items.forEach((item) => state.turnPlayerContinuous[seat].push(JSON.parse(JSON.stringify(item))));
      addLog(`${context.card?.name || "効果"}のターン中の継続効果を適用しました。`);
    }
  } else if (effect.op === "addTurnContinuous") {
    // X19(D-BT01/0131 レビュー修正): ターン中の継続効果を発生源カードに一時付与する
    //（「そのターン中、君のレフトとライトのサイズ2以下の《百鬼》はサイズ0になる」= 発動後にコールした
    //  カードにも適用されるルール変更。activeContinuousEffects が turnContinuous を合流し、
    //  clearTurnModifiers がターン境界で除去する）。
    if (context.card && effect.continuous) {
      context.card.turnContinuous ||= [];
      // effect.continuous は単一オブジェクト（D-BT01/0131）か配列（D-EB01/0027）の両形を取る。
      // 配列をそのまま push するとネスト（[[{...}]]）し、activeContinuousEffects(src/05)の spread 後に
      // 要素が配列になって .op を拾えず付与が無効化する。Array.isArray で正規化し各オブジェクトを個別に push する。
      const continuousItems = Array.isArray(effect.continuous) ? effect.continuous : [effect.continuous];
      continuousItems.forEach((item) => {
        context.card.turnContinuous.push(JSON.parse(JSON.stringify(item)));
      });
      addLog(`${context.card.name}のターン中の継続効果を適用しました。`);
    }
  }
  if (effect.op === "setConditionalSizeScope") {
    // X11b(D-BT01/0131): 対象範囲のカードのサイズを一括で上書き（turnScoped はターン終了時に解除）。
    // selfOnly(D-BT01/0059): 発生源カード自身だけを対象にする（同名カードの巻き込み防止）。
    const sizeTargets = effect.selfOnly
      ? (findFieldCardSlot(context.card) ? [{ ...findFieldCardSlot(context.card), card: context.card }] : [])
      : collectFieldTargets(
          { scope: effect.scope || "self", filter: effect.filter, zones: effect.zones },
          context,
        );
    sizeTargets.forEach((entry) => {
      entry.card.conditionalSize = {
        size: effect.size ?? 0,
        granterInstanceId: context.card?.instanceId,
        unconditional: true,
        turnScoped: Boolean(effect.turnScoped),
      };
    });
    if (sizeTargets.length > 0) {
      addLog(`${context.card?.name || "効果"}で${sizeTargets.length}枚のサイズを${effect.size ?? 0}にしました。`);
    }
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
  if (effect.op === "endAttackPhase") {
    // 進行中のアタックフェイズを終了しファイナルフェイズへ（残りの攻撃を行わない。ヴァイシュタッツ 0095）。
    // 「1回目のバトル終了時」に使う対抗のため、係属中の1回目の攻撃は先に解決してダメージを通してから終了する
    // （直接 pendingAttack を破棄すると1回目の攻撃自体まで無効化してしまう）。
    if (state.pendingAttack) {
      await resolvePendingAttack();
    }
    state.phase = "final";
    state.pendingAttack = null;
    state.selected = null;
    state.counterHandOwner = null;
    state.linkAttackers = [];
    state.buddyCallDeclared = null;
    addLog(`${context.card?.name || "効果"}の効果でアタックフェイズを終了しました。`);
  }
  if (effect.op === "skipToFinalPhase") {
    // E-XV2(X-UB02/0036 機甲符：GAIN ADVANTAGE): メインフェイズを終了し、アタックフェイズを行わずに
    // ファイナルフェイズへ移る（「メインフェイズを終了し、ファイナルフェイズを行う。アタックフェイズは行わない」）。
    // 既存 endAttackPhase は「アタック中→final」（係属攻撃を解決してから遷移）、goFinalPhase は phase==="attack"
    // 前提のため、いずれもメインからの前方ジャンプは扱えない。ここは goFinalPhase と同じ正規のフェイズ入場手順
    // （transient 応答窓の失効・選択/リンク/バディ宣言のクリア・finalStart 誘発）でメイン→final を直接行う。
    // fuzzer の ALLOWED_PHASE_TRANSITIONS には main>final が登録済み＝正規遷移（不変条件に抵触しない）。
    // アタックフェイズを一切開かない（startAttackPhase を経ない）ので攻撃宣言も pendingAttack も生じない。
    if (state.phase === "main" && !state.winner) {
      expireTransientResponseWindows();
      state.phase = "final";
      state.selected = null;
      state.counterHandOwner = null;
      state.linkAttackers = [];
      state.buddyCallDeclared = null;
      addLog(`${context.card?.name || "効果"}の効果でアタックフェイズを行わず、ファイナルフェイズに移ります。`);
      await runPhaseStartTriggers("finalStart", state.active);
    }
  }
  if (effect.op === "gainLife") {
    // E-XB26(R23): effect.player で回復対象を選べる（既定=従来どおり自分=player。sibling の setLife/draw と同規約
    // ＝未指定は player＝挙動不変）。相手の場へ付与した triggered から「君（付与者）のライフ+1」を表すのに使う
    // ―付与された能力は付与先（相手席）の視点で解決されるため、"opponent"（=付与者＝この解決の opponent 変数）を
    // 回復させる（0071 ブラック・プロボックの破壊時/攻撃時「君のライフ+1」）。既存カードは player 未指定＝後方互換。
    const recipient = effect.player === "opponent" ? opponent : player;
    if (isLifeGainByEffectPrevented(state.players.indexOf(recipient))) {
      addLog(`${recipient.name}は効果でライフを回復できません。`);
    } else {
      // amountFrom 対応（「破壊したモンスターのサイズ分回復」H-BT04/0015 等。dealDamage と同形）。
      const gained = effect.amountFrom ? resolveAmountFrom(effect.amountFrom, context) : effect.amount || 1;
      recipient.life += gained;
      if (gained > 0) {
        // 可逆winner: 同一解決内で致死→回復が続いた場合（例: 緑竜の盾の無効化がヤミゲドウ“爆雷”を即時誘発→
        // 致死→直後の本効果ライフ+1）に勝敗を巻き戻す。ライフリンク相殺(src/11:1633)と同じ扱い。
        clearWinnerIfNoCurrentLoss();
        await runFieldEventTriggers("lifeGained", state.players.indexOf(recipient));
      }
    }
  }
  if (effect.op === "setLife") {
    // ライフを固定値に代入（「ライフを10にする」等。gainLifeの加算では表せない）。
    const target = effect.player === "opponent" ? opponent : player;
    target.life = effect.life ?? effect.amount ?? target.life;
    clearWinnerIfNoCurrentLoss(); // 可逆winner: 正のライフへの代入は致死の巻き戻しになりうる（gainLife と同じ）
    addLog(`${target.name}のライフは${target.life}になりました。`);
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
        promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
        purpose: "search",
      });
      picked = (sel || []).map((e) => e.card);
    }
    picked.forEach((c) => player.hand.push(c));
    // altTo:"drop" 指定時は残りをデッキ下でなくドロップへ（H-BT04/0013/0043。lookTopCardPlaceTopOrBottom の altTo と同形）。
    // altTo:"gauge"（S-UB-C03/0042）は残りをゲージへ。既定(else)はデッキ下(unshift)。
    const rest = revealed.filter((c) => !picked.includes(c));
    if (effect.altTo === "drop") {
      rest.forEach((c) => player.drop.push(c));
      queueDeckMilledTriggers(state.players.indexOf(player), rest, makeEffectCause(context, state.players.indexOf(player))); // E5
    } else if (effect.altTo === "gauge") {
      rest.forEach((c) => player.gauge.push(c));
      noteGaugePlaced(state.players.indexOf(player), rest.length); // E-XB12: 残りをゲージへ（funnel 非経由）
    } else {
      rest.forEach((c) => player.deck.unshift(c));
      queueDeckBottomPlacedTriggers(state.players.indexOf(player), rest); // E-XB18: デッキ下流入
    }
    addLog(`${context.card.name}の効果でデッキの上${revealed.length}枚を見て${picked.length}枚を手札に加えました。`);
    // F4(D-SS03/0001): discardOnPick:N — 手札に加えた枚数が1以上のときのみ、解決後に手札N枚を選んで捨てる。
    // 「加えたら、君の手札1枚を捨てる」の再出パターン（0枚しか加えなかった/あえて0枚選んだ場合は捨てない）。
    if (effect.discardOnPick && picked.length > 0) {
      const discardCount = Math.min(effect.discardOnPick, player.hand.length);
      if (discardCount > 0) {
        const discarded = await chooseAndTakeMatchingCards(player.hand, {}, discardCount, context.card, {
          title: `${context.card.name}で捨てる手札`,
          lead: `手札から捨てるカードを${discardCount}枚選んでください。`,
          promptSeat: context.owner,
        });
        discardHandCardsToDrop(player, discarded, makeEffectCause(context, state.players.indexOf(player))); // E6
        if (discarded.length > 0) {
          addLog(`${player.name}は${discarded.map((c) => c.name).join("、")}を捨てました。`);
        }
      }
    }
  }
  if (effect.op === "lookTopSelectToCall") {
    // E-XB39(X-BT04/0027/0053/0081 モンスターエッグ群): デッキの上から count 枚を「見て」（非破壊＝ミル誘発を発火
    //   させない）、その中の filter 一致モンスター1枚までを【コールコスト】を払ってコールし、残りを強制でデッキへ戻す。
    //   rest:"shuffle"（0027/0053: デッキに戻してシャッフル）／rest:"bottomOrdered"（0081: デッキの下に好きな順で置く）。
    //   秘匿性: 「見る」は自席のみ（promptSeat=context.owner・非コール札の名前は log に出さない＝T13 と同作法）。
    //   現行の一時ミル近似（デッキ→ドロップ→戻し）が deckMilled 誘発を誤発火していた問題を、pop→（コール or デッキ戻し）で
    //   ドロップを経由しない真の非破壊 look に是正する。保存則: revealed は全て「コール」か「デッキ戻し」で保存。
    const seat = state.players.indexOf(player);
    const count = effect.count || 6;
    const revealed = [];
    for (let i = 0; i < count && player.deck.length > 0; i += 1) revealed.push(player.deck.pop());
    const candidates = revealed.filter((c) => matchesCardFilter(c, effect.filter || {}));
    let called = null;
    if (candidates.length > 0) {
      const sel = await chooseCardEntries(candidates.map((c) => ({ card: c })), {
        title: effect.title || context.card?.name,
        lead: effect.lead || "コールするモンスターを選んでください（コールしなくてもよい）。",
        min: 0, max: 1, forceDialog: true,
        promptSeat: context.owner, // 能力主体の席へ（look の秘匿・CPU/権威サーバの誤配送防止）
        purpose: "call",
      });
      const pick = (sel || [])[0]?.card;
      if (pick) {
        // コール先ゾーン選択（空きフィールドゾーン優先。空きが無ければ上書きコール＝既存カードをルールドロップ）。
        const emptyZones = fieldZones.filter((z) => !player.field[z]);
        const zoneChoices = emptyZones.length ? emptyZones : fieldZones;
        let zone = zoneChoices[0];
        if (zoneChoices.length > 1) {
          const zsel = await chooseCardEntries(
            zoneChoices.map((z) => ({ card: pick, owner: seat, zone: z, note: zoneLabel(z) })),
            { title: effect.title || context.card?.name, lead: `${pick.name}のコール先を選んでください。`, min: 1, max: 1, forceDialog: true, promptSeat: context.owner, purpose: "call" },
          );
          zone = zsel?.[0]?.zone ?? zone;
        }
        // 【コールコスト】を払う（払えなければコールせず、pick は残りに合流してデッキへ戻る）。
        const payment = await payCardCostWithSelection(player, pick, "call", pick, { sourceCard: pick, callFromZone: "deck" });
        if (payment.ok && fieldZones.includes(zone)) {
          if (player.field[zone]) dropFieldCardByRule(player, zone);
          player.field[zone] = pick;
          recordImpactMonsterCall(seat, pick);
          pick.enteredFromZone = "deck";
          // 「そのカードは場から離れるまで、サイズ0（0）になる」（grantConditionalSize。conditionalSize を先に付与してから
          //  enforceSizeLimit＝サイズ0化前の実サイズでサイズ超過と誤判定しないため。callSelectedForScript と同順）。
          if (effect.grantConditionalSize) {
            pick.conditionalSize = {
              size: effect.grantConditionalSize.size ?? 0,
              granterInstanceId: context.card?.instanceId,
              unconditional: Boolean(effect.grantConditionalSize.unconditional),
            };
          }
          enforceSizeLimit(player, zone);
          called = pick;
          addLog(`${context.card?.name || "効果"}で${pick.name}を${zoneLabel(zone)}にコールしました。`);
          await resolveOnEnter(pick, player, null, { byEffect: true, enterCauseCard: context.card });
        } else if (!payment.ok) {
          addLog(payment.reason || `${pick.name}のコールコストを払えませんでした。`);
        }
      }
    }
    // 残り（コールされなかった revealed 全て）を強制でデッキへ戻す（ドロップを経由しない＝deckMilled 誘発なし）。
    const rest = revealed.filter((c) => c !== called);
    if (effect.rest === "bottomOrdered") {
      // 0081: 「残りのカードをデッキの下に好きな順番で置く」。2枚以上なら下での積み順を1枚ずつ選ばせる。
      let ordered = rest;
      if (rest.length >= 2) {
        ordered = [];
        let remaining = rest.map((c) => ({ card: c }));
        while (remaining.length > 1) {
          const pick2 = await chooseCardEntries(remaining, {
            title: effect.title || context.card?.name,
            lead: `デッキの下から${ordered.length + 1}番目に置くカードを選んでください。`,
            min: 1, max: 1, forceDialog: true, promptSeat: context.owner, purpose: "scry",
          });
          const entry = pick2?.[0] || remaining[0];
          ordered.push(entry.card);
          remaining = remaining.filter((r) => r.card.instanceId !== entry.card.instanceId);
        }
        if (remaining.length) ordered.push(remaining[0].card);
      }
      ordered.forEach((c) => player.deck.unshift(c)); // 下バッチ: ordered[0] が先に引く側（既存 bottom 規約）。
      queueDeckBottomPlacedTriggers(seat, ordered); // E-XB18: デッキ下流入（ミルではない）
    } else {
      // 既定/"shuffle": 0027/0053「デッキをシャッフルする」。残りをデッキへ戻してシャッフル（決定的 rngInt）。
      rest.forEach((c) => player.deck.push(c));
      if (rest.length > 0) shuffleInPlace(player.deck);
    }
    addLog(`${context.card?.name || "効果"}の効果でデッキの上${revealed.length}枚を見ました${called ? "" : "（コールなし）"}。`);
  }
  if (effect.op === "lookTopDistribute") {
    // E-XB40(X-BT04/0008 天晶の祝福): デッキの上から count 枚を「見て」（非破壊＝ミル誘発を発火させない）、
    //   その中を3方向へ振り分ける ― gaugeAmount 枚(既定1)→ゲージ／handMax 枚まで(既定2)→手札／残り→デッキの下に
    //   好きな順。count は countFrom（amountFrom 互換・resolveAmountFrom）で動的化する（0008 は
    //   countFrom:{source:"attacksThisTurn",controller:"opponent"}＝相手のカードが攻撃した回数＝席別カウンタ）。
    //   非破壊 look の作法（pop→各宛先へ・ドロップ非経由＝deckMilled 非発火・保存則）は lookTopSelectToCall(E-XB39)/
    //   lookTopSelectToHandRestToBottom と同一。秘匿: 「見る」は owner のみ開示（promptSeat=context.owner・
    //   非取得札の名前を log に出さない＝T13 と同作法）。既存カードは lookTopDistribute op を持たない＝後方互換。
    const seat = state.players.indexOf(player);
    const count = effect.countFrom ? resolveAmountFrom(effect.countFrom, context) : (effect.count || 0);
    const gaugeAmount = effect.gaugeAmount ?? 1;
    const handMax = effect.handMax ?? 2;
    const revealed = [];
    for (let i = 0; i < count && player.deck.length > 0; i += 1) revealed.push(player.deck.pop());
    if (revealed.length === 0) {
      addLog(`${context.card?.name || "効果"}の効果で見るデッキのカードがありません。`);
    } else {
      let remaining = revealed.slice();
      // (1) ゲージへ置く（gaugeAmount 枚まで＝見た枚数が少なければその分だけ。0008 は必ず1枚＝mandatory）。
      let toGauge = [];
      const gaugePick = Math.min(gaugeAmount, remaining.length);
      if (gaugePick > 0) {
        const sel = await chooseCardEntries(remaining.map((c) => ({ card: c })), {
          title: effect.title || context.card?.name,
          lead: effect.gaugeLead || "ゲージに置くカードを選んでください。",
          min: gaugePick, max: gaugePick, forceDialog: true,
          promptSeat: context.owner, // 「見る」＝能力主体の席のみへ開示（誤配送防止・秘匿）
          purpose: "search",
        });
        toGauge = (sel || []).map((e) => e.card);
        toGauge.forEach((c) => player.gauge.push(c));
        noteGaugePlaced(seat, toGauge.length); // E-XB12: scry の選択分をゲージへ（gaugePlaced 誘発funnelは非経由）
        remaining = remaining.filter((c) => !toGauge.includes(c));
      }
      // (2) 手札へ加える（handMax 枚まで・0枚可）。E-XB74②(X2-SP/0040 角王の共鳴): handFilter 指定時は一致札のみ提示。
      //     未指定は remaining 全体＝既存 X-BT04/0008 と完全に同一挙動（後方互換）。
      let toHand = [];
      if (remaining.length > 0 && handMax > 0) {
        const handEligible = effect.handFilter ? remaining.filter((c) => matchesCardFilter(c, effect.handFilter)) : remaining;
        const handPickMax = Math.min(handMax, handEligible.length);
        if (handPickMax > 0) {
          const sel = await chooseCardEntries(handEligible.map((c) => ({ card: c })), {
            title: effect.title || context.card?.name,
            lead: effect.handLead || `手札に加えるカードを選んでください（${handPickMax}枚まで）。`,
            min: 0, max: handPickMax, forceDialog: true,
            promptSeat: context.owner,
            purpose: "search",
          });
          toHand = (sel || []).map((e) => e.card);
          toHand.forEach((c) => player.hand.push(c));
          remaining = remaining.filter((c) => !toHand.includes(c));
        }
      }
      // (2b) ドロップゾーンへ置く（dropMax 枚まで・0枚可・dropFilter 指定時は一致札のみ）。E-XB74②(0040 角王3枚まで
      //      ドロップ)。既存の gauge/hand/bottom 呼び出しは dropMax 未指定＝この段まるごとスキップ＝不変。
      //      「見た」札を置く扱いのため、非破壊 look の作法に合わせ deckMilled/movedToDrop 誘発は発火させない
      //      （意図的近似＝この op の gauge/hand/bottom 各段と同じく funnel を経由しない・保存則は player.drop へ直接移す）。
      let toDrop = [];
      const dropMax = effect.dropMax ?? 0;
      if (remaining.length > 0 && dropMax > 0) {
        const dropEligible = effect.dropFilter ? remaining.filter((c) => matchesCardFilter(c, effect.dropFilter)) : remaining;
        const dropPickMax = Math.min(dropMax, dropEligible.length);
        if (dropPickMax > 0) {
          const sel = await chooseCardEntries(dropEligible.map((c) => ({ card: c })), {
            title: effect.title || context.card?.name,
            lead: effect.dropLead || `ドロップゾーンに置くカードを選んでください（${dropPickMax}枚まで）。`,
            min: 0, max: dropPickMax, forceDialog: true,
            promptSeat: context.owner,
            purpose: "search",
          });
          toDrop = (sel || []).map((e) => e.card);
          toDrop.forEach((c) => player.drop.push(c));
          remaining = remaining.filter((c) => !toDrop.includes(c));
        }
      }
      // (3) 残りをデッキの下へ好きな順（2枚以上なら下での積み順を1枚ずつ選ばせる）。
      let rest = remaining;
      if (rest.length >= 2) {
        const ordered = [];
        let pool = rest.map((c) => ({ card: c }));
        while (pool.length > 1) {
          const pick = await chooseCardEntries(pool, {
            title: effect.title || context.card?.name,
            lead: `デッキの下から${ordered.length + 1}番目に置くカードを選んでください。`,
            min: 1, max: 1, forceDialog: true, promptSeat: context.owner, purpose: "scry",
          });
          const entry = pick?.[0] || pool[0];
          ordered.push(entry.card);
          pool = pool.filter((r) => r.card.instanceId !== entry.card.instanceId);
        }
        if (pool.length) ordered.push(pool[0].card);
        rest = ordered;
      }
      rest.forEach((c) => player.deck.unshift(c)); // 下バッチ: rest[0] が先に引く側（既存 bottom 規約）
      queueDeckBottomPlacedTriggers(seat, rest); // E-XB18: デッキ下流入（ミルではない）
      // 秘匿: 枚数のみログ（カード名は出さない＝相手先読み防止）。E-XB74②: ドロップ分は toDrop>0 の時だけ付記
      //（dropMax 未指定の既存 gauge/hand/bottom 呼び出しは toDrop=0＝ログ byte 不変）。
      addLog(`${context.card?.name || "効果"}の効果でデッキの上${revealed.length}枚を見て、${toGauge.length}枚をゲージ・${toHand.length}枚を手札${toDrop.length > 0 ? `・${toDrop.length}枚をドロップ` : ""}に加えました。`);
    }
  }
  if (effect.op === "lookTopSelectToBottomRestToTop") {
    // FE2/A8(D-BT04/0070 メガドロイド ヒュージー): デッキの上から count 枚を見て、選んだ任意枚数を
    //   選んだ順でデッキの下へ、残りを選んだ順でデッキの上へ。lookTopSelectToHandRestToBottom の
    //   「選択分→行き先／残り→別の行き先」の形を踏襲した新規op（既存カードは未使用＝後方互換）。
    //   デッキ向き規約: top=末尾(pop/push)・bottom=先頭(unshift)。順序は index0 が「先に引く側」で統一
    //   （上: index0=最上段=最初に引く／下: index0=下バッチ内で先に引く側）。
    const count = effect.count || 2;
    const revealed = [];
    for (let i = 0; i < count && player.deck.length > 0; i += 1) revealed.push(player.deck.pop());
    if (revealed.length === 0) {
      addLog(`${context.card.name}の効果で見るカードがありません。`);
    } else {
      // (1) デッキの下へ送るカードを選ぶ（0枚可＝全て上へ）。選択順が下での積み順。
      const sel = await chooseCardEntries(revealed.map((c) => ({ card: c })), {
        title: effect.title || context.card.name,
        lead: effect.lead || "デッキの下に置くカードを選んでください（選ばなければ全て上に戻ります）。",
        min: 0, max: revealed.length, forceDialog: true,
        promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
        purpose: "scry",
      });
      const toBottom = (sel || []).map((e) => e.card);
      // (2) 残りをデッキの上へ。2枚以上なら上での順序（1番目=最上段）を1枚ずつ選ばせる。
      let toTop = revealed.filter((c) => !toBottom.includes(c));
      if (toTop.length >= 2) {
        const ordered = [];
        let remaining = toTop.map((c) => ({ card: c }));
        while (remaining.length > 1) {
          const pick = await chooseCardEntries(remaining, {
            title: effect.title || context.card.name,
            lead: `デッキの上から${ordered.length + 1}番目に置くカードを選んでください。`,
            min: 1, max: 1, forceDialog: true,
            promptSeat: context.owner,
            purpose: "scry",
          });
          const entry = pick?.[0] || remaining[0];
          ordered.push(entry.card);
          remaining = remaining.filter((r) => r.card.instanceId !== entry.card.instanceId);
        }
        if (remaining.length) ordered.push(remaining[0].card);
        toTop = ordered;
      }
      // 下バッチ: 前から unshift（toBottom[0] が先に引く側・toBottom[末尾] が最下段）。
      toBottom.forEach((c) => player.deck.unshift(c));
      queueDeckBottomPlacedTriggers(state.players.indexOf(player), toBottom); // E-XB18: デッキ下流入
      // 上バッチ: ordered[0] を最上段(末尾)にするため逆順 push（reorderTopOrdered と同規約）。
      for (let i = toTop.length - 1; i >= 0; i -= 1) player.deck.push(toTop[i]);
      addLog(`${context.card.name}の効果でデッキの上${revealed.length}枚を見て、${toBottom.length}枚をデッキの下に置きました。`);
    }
  }
  if (effect.op === "lookTopSelectToGaugeRestToTop") {
    // E-XC14(X-CP02/0062 コスモチャージ・プロテクション): デッキの上から count 枚を「見て」、その中から
    //   選んだ枚数(既定1枚)をゲージへ、残りを選んだ順でデッキの上へ戻す。lookTopSelectToBottomRestToTop の
    //   「選択分→行き先／残り→別の行き先」の兄弟（宛先＝ゲージ）。
    // 秘匿: これは「公開」ではなく「見る」＝owner のみ開示（promptSeat=context.owner・往復は該当席のみ・
    //   state.log にカード名を出さない＝T13 精神。E-XC1 revealTopCard の両席公開とは逆）。
    // デッキ向き規約: top=末尾(pop/push)・bottom=先頭(unshift)。残りの上戻しは index0=最上段の順で積む。
    const count = effect.count || 2;
    const pick = effect.pick || 1;
    const revealed = [];
    for (let i = 0; i < count && player.deck.length > 0; i += 1) revealed.push(player.deck.pop());
    if (revealed.length === 0) {
      addLog(`${context.card.name}の効果で見るカードがありません。`);
    } else {
      // (1) ゲージへ置くカードを選ぶ（見た中から pick 枚まで）。
      const sel = await chooseCardEntries(revealed.map((c) => ({ card: c })), {
        title: effect.title || context.card.name,
        lead: effect.lead || "ゲージに置くカードを選んでください。",
        min: Math.min(pick, revealed.length),
        max: Math.min(pick, revealed.length),
        forceDialog: true,
        promptSeat: context.owner, // 「見る」＝能力主体の席のみへ開示（誤配送防止・秘匿）
        purpose: "search",
      });
      const toGauge = (sel || []).map((e) => e.card);
      // (2) 残りをデッキの上へ。2枚以上なら上での順序（1番目=最上段）を1枚ずつ選ばせる。
      let toTop = revealed.filter((c) => !toGauge.includes(c));
      if (toTop.length >= 2) {
        const ordered = [];
        let remaining = toTop.map((c) => ({ card: c }));
        while (remaining.length > 1) {
          const order = await chooseCardEntries(remaining, {
            title: effect.title || context.card.name,
            lead: `デッキの上から${ordered.length + 1}番目に置くカードを選んでください。`,
            min: 1, max: 1, forceDialog: true,
            promptSeat: context.owner,
            purpose: "scry",
          });
          const entry = order?.[0] || remaining[0];
          ordered.push(entry.card);
          remaining = remaining.filter((r) => r.card.instanceId !== entry.card.instanceId);
        }
        if (remaining.length) ordered.push(remaining[0].card);
        toTop = ordered;
      }
      toGauge.forEach((c) => player.gauge.push(c));
      noteGaugePlaced(state.players.indexOf(player), toGauge.length); // E-XB12: scry の選択分をゲージへ（funnel 非経由）
      // 上バッチ: ordered[0] を最上段(末尾)にするため逆順 push（reorderTopOrdered と同規約）。
      for (let i = toTop.length - 1; i >= 0; i -= 1) player.deck.push(toTop[i]);
      // 秘匿: 枚数のみログ（カード名は出さない＝相手先読み防止）。
      addLog(`${context.card.name}の効果でデッキの上${revealed.length}枚を見て、${toGauge.length}枚をゲージに置きました。`);
    }
  }
  if (effect.op === "revealTopDamagePerMatchRestToBottom") {
    const count = effect.count || 5;
    const revealed = [];
    for (let i = 0; i < count && player.deck.length > 0; i += 1) revealed.push(player.deck.pop());
    const matched = revealed.filter((c) => matchesCardFilter(c, effect.filter || {})).length;
    // E2(D-BT04/0016 ギガドロイド ジガンテス): tiers 指定時は「N枚以上ならダメージD」の閾値表
    // （降順評価・最初に満たした段のダメージ。例: [{atLeast:5,damage:5},{atLeast:3,damage:2}] ＝ 5枚→5/3〜4枚→2/2枚以下→0）。
    // tiers 未指定は従来の perDamage×matched（枚数比例）＝既存カード挙動不変。
    // 「デッキ下へ好きな順」は現状 unshift（順不同）＝残差（_note）。
    let dmg;
    if (Array.isArray(effect.tiers)) {
      dmg = 0;
      for (const tier of [...effect.tiers].sort((a, b) => (b.atLeast || 0) - (a.atLeast || 0))) {
        if (matched >= (tier.atLeast || 0)) {
          dmg = tier.damage || 0;
          break;
        }
      }
    } else {
      dmg = matched * (effect.perDamage || 1);
    }
    addLog(`${context.card.name}の効果で${revealed.length}枚を公開し、${matched}枚一致。`);
    if (dmg > 0) applyDamageToPlayer(1 - context.owner, dmg, { sourceName: context.card?.name, sourceCard: context.card, sourceOwner: context.owner });
    revealed.forEach((c) => player.deck.unshift(c));
    queueDeckBottomPlacedTriggers(state.players.indexOf(player), revealed); // E-XB18: デッキ下流入
  }
  if (effect.op === "revealTopCard") {
    // E-XC1(X-CP02 コスモドラグーン reveal-gate): 「君のデッキの上から1枚を公開する」。
    // ・これは E-ZA3(0001 look)の伏せ札とは逆＝両席に見える正規の「公開」なので addLog にカード名を出してよい
    //   （viewFor で伏せる秘匿札ではない＝T13 のシード漏洩とは無関係。「見る」=秘匿 / 「公開」=両席可視 を混同しない）。
    // ・カードはデッキ上に残したまま(peek＝pop しない)で context.revealedCard に記録する。pop せず宙に浮かせないので
    //   room 復元(busy中の非永続)や effects/script の途中でカードが「どのゾーンにも無い」瞬間を作らない（既存 lookTop 系の作法）。
    // ・一致時の効果Aで手札/ソウル/ゲージへ移す場合は、デッキ上に残った1枚を既存の top-deck op がそのまま消費する
    //   （手札=draw / ソウル=putTopDeckToSoul / ゲージ=putTopDeckToGauge）。不一致(else)は putRevealedToDeckBottom がデッキ下へ循環。
    const revealer = effect.controller === "opponent" ? opponent : player;
    const top = revealer.deck[revealer.deck.length - 1] || null;
    context.revealedCard = top;
    context.revealedCardOwner = state.players.indexOf(revealer);
    addLog(
      top
        ? `${revealer.name}はデッキの上から${top.name}を公開しました。`
        : `${revealer.name}のデッキに公開するカードがありません。`,
    );
  }
  if (effect.op === "putRevealedToDeckBottom") {
    // E-XC1: 直前に revealTopCard で公開したカードをデッキの下へ置く（不一致分岐、または「その後デッキの下に置く」型）。
    // 効果Aで既に手札/ソウル/ゲージへ移動済み（デッキに無い）なら no-op。デッキ上に残っていれば取り出して下へ循環。
    const rc = context.revealedCard;
    if (rc) {
      const bottomOwner = context.revealedCardOwner ?? context.owner;
      const deck = state.players[bottomOwner]?.deck || [];
      const idx = deck.indexOf(rc);
      if (idx >= 0) {
        // PR/0311 超勇者 アルスグランデ（S5統合レビュー F4）: chooseTopOrBottom:true で「デッキの上か下に置く」の
        // 上/下選択を提供する（既定=フラグ無しは従来通り常に下＝後方互換・X-CP01/02 コスモドラグーン等は不変）。
        // ・公開札は revealTopCard の peek でデッキ上に残るため idx>=0 で必ず見つかる＝ここに来る＝非コール経路のみ。
        //   コール成立時は callSelectedToEmptyZones が公開札をデッキから取り出し済み＝idx<0 でこの分岐に入らない
        //   ＝「コール成立時は走らない」no-op ガードを維持し、次の（未公開の）カードを誤って覗く事故を起こさない。
        // ・取り出してから confirm を待つ（lookTopCardPlaceTopOrBottom の pop→confirm と同型。await 中に別札を触らない）。
        deck.splice(idx, 1);
        let toTop = false;
        if (effect.chooseTopOrBottom) {
          toTop = await confirmChoiceAsync(
            bottomOwner,
            `${context.card?.name || "効果"}: 公開した${rc.name}をデッキの1番上か1番下のどちらに置きますか？`,
            { yesLabel: "1番上に置く", noLabel: "1番下に置く", purpose: "scry" },
          );
        }
        if (toTop) {
          deck.push(rc);
          addLog(`${state.players[bottomOwner]?.name || ""}は公開した${rc.name}をデッキの上に置きました。`);
        } else {
          deck.unshift(rc);
          queueDeckBottomPlacedTriggers(bottomOwner, [rc]); // E-XB18: デッキ下流入（上戻し=deck.push 側は非発火）
          addLog(`${state.players[bottomOwner]?.name || ""}は公開した${rc.name}をデッキの下に置きました。`);
        }
      }
    }
    context.revealedCard = null;
  }
  if (effect.op === "lookTopCardPlaceTopOrBottom") {
    // デッキの1番上のカードを見て、1番上か1番下に置く（ブレイド・オブ・アサメイ 0089 のスクライ）。
    // デッキ向きは drawCards/lookTopSelectToHandRestToBottom の規約に一致（top=末尾=pop/push、bottom=先頭=unshift）。
    if (player.deck.length === 0) {
      addLog(`${context.card?.name || "効果"}で見るカードがありません。`);
    } else {
      // altTo:"drop" 指定時は「下に置く」選択がデッキ下ではなくドロップ行きになる（H-EB04/0060）。
      const toDrop = effect.altTo === "drop";
      const top = player.deck.pop();
      const keepOnTop = await confirmChoiceAsync(
        context.owner,
        `${context.card?.name || "効果"}: デッキの1番上の${top.name}を1番上か${toDrop ? "ドロップ" : "1番下"}のどちらに置きますか？`,
        { yesLabel: "1番上に置く", noLabel: toDrop ? "ドロップに置く" : "1番下に置く", purpose: "scry" },
      );
      if (keepOnTop) {
        player.deck.push(top);
        addLog(`${context.card?.name || "効果"}でデッキの1番上を見て、1番上に置きました。`);
      } else if (toDrop) {
        player.drop.push(top);
        queueDeckMilledTriggers(state.players.indexOf(player), [top], makeEffectCause(context, state.players.indexOf(player))); // E5
        addLog(`${context.card?.name || "効果"}でデッキの1番上を見て、ドロップに置きました。`);
      } else {
        player.deck.unshift(top);
        queueDeckBottomPlacedTriggers(state.players.indexOf(player), [top]); // E-XB18: デッキ下流入
        addLog(`${context.card?.name || "効果"}でデッキの1番上を見て、1番下に置きました。`);
      }
    }
  }
  if (effect.op === "gainLifeMinusMatchingDropCount") {
    if (isLifeGainByEffectPrevented(state.players.indexOf(player))) {
      addLog(`${player.name}は効果でライフを回復できません。`);
    } else {
      const copies = player.drop.filter((card) =>
        matchesRelativeCardFilter(card, effect.filter || {}, context),
      ).length;
      const amount = Math.max(0, (effect.baseAmount || 0) - copies);
      player.life += amount;
      if (amount > 0) {
        clearWinnerIfNoCurrentLoss(); // 可逆winner（gainLife と同じ扱い）
      }
      addLog(`${player.name}は${context.card.name}の効果でライフを${amount}回復しました。`);
      if (amount > 0) {
        await runFieldEventTriggers("lifeGained", state.players.indexOf(player));
      }
    }
  }
  if (effect.op === "dealDamage") {
    const receiver = effect.player === "self" ? player : opponent;
    let amount = effect.amountFrom ? resolveAmountFrom(effect.amountFrom, context) : effect.amount || 1;
    // 霊撃ブースト: バイオレンス・ファミリア等で立てた turn ボーナスを、霊撃(=event destroyByAttack の dealDamage)に加算。
    const isSpiritStrike = damageIsSpiritStrike(effect, context); // E-XB8: 霊撃同定（ブースト/被弾トリガー共通）
    if (
      receiver === opponent &&
      isSpiritStrike &&
      state.spiritStrikeDamageBonus?.[context.owner]
    ) {
      amount += state.spiritStrikeDamageBonus[context.owner];
    }
    const dealt = applyDamageToPlayer(state.players.indexOf(receiver), amount, {
      sourceName: context.card?.name,
      sourceCard: context.card,
      sourceOwner: context.owner,
      ignorePrevention: Boolean(effect.ignorePrevention),
      // E-Y6(X-BT01/0048 クリスティアーノ・クリスタル・シュート！・0028 雷槍×天バスター！＋DUP 0118/0123):
      // 「このカードで相手のライフが0になった場合、相手のカードで相手のライフは変更されない（復活できない）」。
      // この致死に限り、受け手の lifeZeroReplacement（場アイテム型復活＝逆襲の型系）/ lifeZeroSafeguard を抑止する。
      suppressLifeZeroReplacement: Boolean(effect.suppressLifeZeroReplacement),
      sourceAbilityLabel: context.ability?.label || null, // damageReceived 側で参照（爆雷等）
      floorLife: effect.floorLife, // 非致死: このダメージで受け手を floorLife 未満にしない（ミネウチでござる 0109）
    });
    // 「効果で相手にダメージを与えた時」ダメージ源側の場札へ誘発（爆雷連鎖 0005/0064）。
    // 発生源(context.owner)の視点イベントなので、runFieldEventTriggers の接頭辞を使わず自陣へ直接配送する。
    if (receiver === opponent && dealt > 0) {
      const label = context.ability?.label || null;
      for (const zone of zones) {
        const listener = state.players[context.owner]?.field?.[zone];
        if (!listener) continue;
        const detail = {
          card: listener,
          player,
          owner: context.owner,
          zone,
          damageSourceLabel: label,
          // X14(D-BT01/0049): ダメージ源カードを条件参照（targetMatches ref:"$damageSource"）できるようにする
          damageSource: { card: context.card, owner: context.owner },
          damageAmount: dealt,
        };
        await runTriggeredAbilities(listener, "opponentDamagedByEffect", detail);
        if (label === "爆雷") {
          await runTriggeredAbilities(listener, "opponentDamagedByBakurai", detail);
        }
        if (isSpiritStrike) {
          // E-XB8(X-CP03/0058 ファントム・ゲッター): 「相手が"霊撃"でダメージを受けた時」の受け皿。
          // 霊撃は event:"destroyByAttack"（＋明示 spiritStrike）の dealDamage＝ブースト同定と同一条件。
          // opponentDamagedByEffect/Bakurai と同じ発生源(context.owner)視点で自陣の場札へ直接配送する
          //（設置札は zones（set 枠含む）に載るためこのループで拾える。1ターン1回等は card 側 limit で制御）。
          await runTriggeredAbilities(listener, "opponentDamagedBySpiritStrike", detail);
        }
      }
    }
  }
  if (effect.op === "discardRandomFromHand") {
    // E-XB8 補助(X-CP03/0058 ファントム・ゲッター): 相手(既定)/自分の手札からランダムにN枚捨てる。
    // 乱数索引は state 常駐 rngInt（リプレイ/room 復元で決定的）。索引/シードは addLog しない（T13）。
    // 捨て札は公開領域（ドロップ）へ落ちるため、捨てたカード名の addLog は許容（公開）。
    const receiver = effect.player === "self" ? player : opponent;
    if (receiver !== player && (await maybeApplyHandDiscardGuard(receiver, context))) {
      return;
    }
    const amount = Math.min(effect.amount || 1, receiver.hand.length);
    const picked = [];
    for (let index = 0; index < amount; index += 1) {
      if (receiver.hand.length === 0) {
        break;
      }
      picked.push(receiver.hand.splice(rngInt(receiver.hand.length), 1)[0]);
    }
    discardHandCardsToDrop(receiver, picked, makeEffectCause(context, state.players.indexOf(receiver)));
    if (picked.length > 0) {
      addLog(`${receiver.name}はランダムに選ばれた${picked.map((card) => card.name).join("、")}を捨てました。`);
    }
  }
  if (effect.op === "dealDamageByFieldCardStat") {
    const source = fieldCardForEffect(effect, context);
    if (!source?.card) {
      return;
    }
    if (effect.chance !== undefined && rngNext() >= effect.chance) { // B1: シード乱数で成否を再現可能に
      addLog(`${context.card.name}の判定は成功しませんでした。`);
      return;
    }
    const amount = visibleFieldStat(source.card, effect.stat || "critical");
    const receiver = effect.player === "self" ? player : opponent;
    const dealtDamage = applyDamageToPlayer(state.players.indexOf(receiver), amount, {
      log: false,
      sourceCard: context.card,
      sourceOwner: context.owner,
    });
    addLog(`${context.card.name}の効果で${receiver.name}に${dealtDamage}ダメージを与えました。`);
    checkWinner();
  }
  if (effect.op === "discardAllHand") {
    // player:"opponent" 対応（従来は指定を無視して常に自分の手札を捨てていた潜在バグ。
    // ss01-0030/bt04/bt05 の該当カードもこれで公式テキスト通りになる）。
    const discardTarget = effect.player === "opponent" ? opponent : player;
    // Z11(S-UB-C03/0050): 相手のカードの効果による捨て札なら handDiscardGuard で置換できるか確認。
    if (
      discardTarget !== player &&
      (await maybeApplyHandDiscardGuard(discardTarget, context))
    ) {
      return;
    }
    discardHandCardsToDrop(discardTarget, discardTarget.hand.splice(0), makeEffectCause(context, state.players.indexOf(discardTarget))); // E6
  }
  if (effect.op === "discardHand") {
    const receiver = effect.player === "opponent" ? opponent : player;
    // Z11(S-UB-C03/0050): 「相手のカードの効果で君の手札が捨てられる場合」＝receiver!==playerの時のみ対象。
    if (receiver !== player && (await maybeApplyHandDiscardGuard(receiver, context))) {
      return;
    }
    const amount = Math.min(effect.amount || 1, receiver.hand.length);
    const movedCards = await chooseAndTakeMatchingCards(receiver.hand, effect.filter, amount, context.card, {
      title: `${context.card.name}で捨てる手札`,
      lead: `手札から捨てるカードを${amount}枚選んでください。`,
      // 権威サーバ: 捨てる本人(receiver=自分 or 相手)の席へ往復（相手手札候補が能動側へ漏れない）。
      promptSeat: state.players.indexOf(receiver),
      owner: state.players.indexOf(receiver), // E-PR3: filter.buddy を手札でも所有者判定できるよう伝播
    });
    discardHandCardsToDrop(receiver, movedCards, makeEffectCause(context, state.players.indexOf(receiver))); // E6
    if (movedCards.length > 0) {
      addLog(`${receiver.name}は${movedCards.map((card) => card.name).join("、")}を捨てました。`);
    }
  }
  if (effect.op === "moveHandToGauge") {
    const amount = effect.amount || 1;
    const movedCards = await chooseAndTakeMatchingCards(player.hand, effect.filter, amount, context.card, {
      title: `${context.card.name}でゲージに置くカード`,
      lead: `手札から条件を満たすカードを${amount}枚選んでください。`,
      promptSeat: state.players.indexOf(player),
      owner: state.players.indexOf(player), // E-PR3: filter.buddy を手札でも所有者判定できるよう伝播
    });
    player.gauge.push(...movedCards);
    noteGaugePlaced(state.players.indexOf(player), movedCards.length); // E-XB12: 手札→ゲージ（funnel 非経由・直接 runFieldEventTriggers）
    if (movedCards.length > 0) {
      addLog(`${movedCards.map((card) => card.name).join("、")}をゲージに置きました。`);
      // 「相手のゲージにカードが置かれた時」誘発（爆雷 0020）。効果でゲージに置く経路も対象。
      await runFieldEventTriggers("gaugePlaced", state.players.indexOf(player), movedCards[0], null, { count: movedCards.length });
    }
  }
  if (effect.op === "moveMatchingDropToHand") {
    const amount = effect.amount || 1;
    // optional:true の場合は「N枚まで／加えてよい」を表すため最小選択数を0にする（既定は強制取得＝min:amount）
    const selectOptions = {
      title: `${context.card.name}で手札に加えるカード`,
      lead: `ドロップゾーンから条件を満たすカードを${amount}枚選んでください。`,
      promptSeat: state.players.indexOf(player),
      owner: state.players.indexOf(player), // E-PR3: filter.buddy をドロップでも所有者判定できるよう伝播
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
    // E-XV5(X-UB02/0068 フィジカル・フォーマット！): downTo 指定時は「ゲージが downTo 枚になるように置く」＝
    // 超過分(gauge.length - downTo)だけドロップへ。downTo 以下なら no-op（「3枚以上なら2枚に」= downTo:2 と
    // 自然に一致：2枚以下は動かさない）。downTo 未指定時は従来の固定 amount 挙動（既存カード不変・オプトイン）。
    // E-XB15(X-CP03/0034 ヴェンディダート・ディザスター): amountFrom 指定時は動的枚数（putTopDeckToGauge と同型の
    // resolveAmountFrom。「相手の場のモンスターの枚数分」＝fieldCardCount controller:opponent）をゲージ残数でクランプ。
    // downTo/amount の各経路はこの分岐が undefined のときのみ到達＝挙動完全不変（後方互換のオプトイン）。
    const amount =
      effect.downTo !== undefined
        ? Math.max(0, receiver.gauge.length - effect.downTo)
        : effect.amountFrom !== undefined
          ? Math.max(0, Math.min(resolveAmountFrom(effect.amountFrom, context), receiver.gauge.length))
          : Math.min(effect.amount || 1, receiver.gauge.length);
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
  if (effect.op === "revealRandomHandThenBranch") {
    // E-XU1(X-UB01/0057 パル子): 相手（既定）の手札からランダム1枚を公開し、種別で効果を分岐する。
    // 公開したカードは動かさない＝「公開したカードは元に戻す」を満たす（no move）。手札0枚は no-op。
    const revealFrom = effect.player === "self" ? player : opponent;
    if (revealFrom.hand.length > 0) {
      // 乱数索引は state 常駐 rngInt（クロージャ禁止・シード/counter は state 常駐＝リプレイ/room 復元で決定的）。
      // 索引値やシードは addLog しない（T13 精神＝シード漏洩防止）。公開したカード名は addLog 可（両席可視の「公開」）。
      const index = rngInt(revealFrom.hand.length);
      const revealed = revealFrom.hand[index];
      addLog(`${context.card.name}の効果で${revealFrom.name}の手札からランダムに選んだ${revealed.name}を公開しました。`);
      recordDiagnosticEvent("reveal_random_hand", {
        source: compactCardForLog(context.card),
        targetPlayer: revealFrom.name,
        revealed: compactCardForLog(revealed), // 公開カード名（公開は正規挙動）。乱数索引は記録しない。
      });
      const kind = effectiveCardType(revealed);
      if (kind === "monster" && Array.isArray(effect.ifMonster)) {
        await executeAbilityEffects(effect.ifMonster, context);
      } else if (kind === "spell" && Array.isArray(effect.ifSpell)) {
        await executeAbilityEffects(effect.ifSpell, context);
      } else if (kind === "item" && Array.isArray(effect.ifItem)) {
        await executeAbilityEffects(effect.ifItem, context);
      }
    }
  }
  if (effect.op === "setNextActivatedCostMayUseOpponentGauge") {
    player.nextActivatedCostMayUseOpponentGauge = true;
    // E-XB73(X2-SP/0041 ガッチャ！(捕まえたぜ！)): includeSpellCost:true で「次の君の魔法の【使用コスト】」でも
    // 相手ゲージを払えるようにする。旧ガッチャ(bt03-0033)は 起動 のみ＝includeSpellCost 未指定＝従来どおり
    // spell flag を立てない（魔法 使用コストへは波及しない）。両者は「魔法か起動どちらか1回」の共有ワンショットで、
    // 先にゲージを払った側が両フラグを消費する（useHandAbilityAction / useFieldAbilityAction 双方が両フラグを落とす）。
    if (effect.includeSpellCost) {
      player.nextSpellCostMayUseOpponentGauge = true;
    }
    addLog(
      effect.includeSpellCost
        ? `${context.card.name}の効果で、次に君の魔法の【使用コスト】か君の場のモンスターの【起動】でゲージを払う時、相手のゲージからも払えます。`
        : `${context.card.name}の効果で、次に君の場のモンスターの【起動】でゲージを払う時、相手のゲージからも払えます。`,
    );
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
      queueDeckMilledTriggers(owner, [movedCard], makeEffectCause(context, owner)); // E5: 両者のデッキ→ドロップもミル
      if (effectiveCardType(movedCard) === "monster") {
        applyDamageToPlayer(owner, effect.damage || 1, { sourceName: context.card?.name, sourceCard: context.card, sourceOwner: context.owner });
      } else if (!isLifeGainByEffectPrevented(state.players.indexOf(receiver))) {
        receiver.life += effect.life || 1;
        clearWinnerIfNoCurrentLoss(); // 可逆winner（gainLife と同じ扱い）
        addLog(`${context.card.name}の効果で${receiver.name}のライフを${effect.life || 1}回復しました。`);
      }
    }
  }
  if (effect.op === "destroyChosenByRpsWinner") {
    // 相手とジャンケンし、勝ったファイターが場のカード1枚を選んで破壊する（デスゲーム 0078）。
    // 使用者が勝てば使用者が、相手が勝てば相手が対象を選ぶ（promptSeat で選択席を切り替え）。
    // 引き分けは既存ジャンケン機構（やり直し無し）に合わせて不成立＝破壊なし。
    const rpsResult = await resolveRockPaperScissors(context);
    if (rpsResult !== "win" && rpsResult !== "lose") {
      addLog(`${context.card?.name || "効果"}のジャンケンは決着せず、破壊は行われませんでした。`);
      return;
    }
    const chooserOwner = rpsResult === "win" ? context.owner : 1 - context.owner;
    const rpsCandidates = allFieldTargets((card) => matchesCardFilter(card, effect.filter || {}));
    if (rpsCandidates.length === 0) {
      addLog(`${context.card?.name || "効果"}で破壊できる場のカードがありません。`);
      return;
    }
    const rpsSelected = await chooseCardEntries(rpsCandidates, {
      title: `${context.card?.name || "効果"}で破壊するカード`,
      lead: "破壊するカードを1枚選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: chooserOwner,
    });
    const rpsChosen = rpsSelected?.[0];
    if (rpsChosen) {
      const rpsDestroyed = await destroyFieldCard(rpsChosen.owner, rpsChosen.zone, {
        cause: makeEffectCause(context, rpsChosen.owner),
      });
      if (rpsDestroyed) {
        addLog(`${state.players[chooserOwner].name}はジャンケンに勝ち、${rpsChosen.card.name}を破壊しました。`);
      }
    }
  }
  if (effect.op === "rockPaperScissorsDamageLosers") {
    const result = await resolveRockPaperScissors(context);
    const amount = effect.amount || 1;
    // E-XB72(X2-SP/0036 トバク・ジバク！): drawPerWin 指定時、勝ったファイターが drawPerWin 枚ドローする
    // （1回のジャンケンで完結＝別途 rockPaperScissors ゲートで2回目を発生させない）。アイコ（draw）は勝者不在
    // ＝ドローなし。勝者は result="win"→使用者・"lose"→相手。カード文面順（勝者ドロー→敗者ダメージ）に合わせ先に処理。
    if (effect.drawPerWin) {
      const winnerSeat = result === "win" ? context.owner : result === "lose" ? 1 - context.owner : null;
      if (winnerSeat !== null) {
        if (isDrawByEffectPrevented(winnerSeat)) {
          addLog(`${state.players[winnerSeat].name}はカードの効果でカードを引けません。`);
        } else {
          drawCards(state.players[winnerSeat], effect.drawPerWin);
          addLog(`${context.card?.name || "効果"}: ${state.players[winnerSeat].name}はジャンケンに勝ち、${effect.drawPerWin}枚引きました。`);
          await runFieldEventTriggers("drawByEffect", winnerSeat);
        }
      }
    }
    // 既定: アイコは両ファイターが敗者(BT03/0065 大入りパンドラ「勝てなかった＝アイコも被弾」)。
    // noDrawDamage:true のカード(EB02/0063「負けたファイター」)ではアイコで誰も被弾しない。
    const drawHitsBoth = result === "draw" && !effect.noDrawDamage;
    if (result === "win" || drawHitsBoth) {
      applyDamageToPlayer(1 - context.owner, amount, { sourceName: context.card?.name, sourceCard: context.card, sourceOwner: context.owner });
    }
    if (result === "lose" || drawHitsBoth) {
      applyDamageToPlayer(context.owner, amount, { sourceName: context.card?.name, sourceCard: context.card, sourceOwner: context.owner });
    }
  }
  if (effect.op === "rockPaperScissorsBranch") {
    // E-XB74①(X2-SP/0013 再来の勇者 ドラム): 相手と1回だけジャンケンし、結果(win/lose/draw)に対応するサブ effects 配列を
    // 順に解決する（単発ロール→複数帰結）。effect.rockPaperScissors ゲート（executeAbilityEffect 冒頭）は「1効果=1ロール」で
    // 複数帰結には別々のロールが要り「相手とジャンケンする」1回に反するため、この op で1ロール完結にする。0013 は
    // winEffects=[draw1・modifyStats{$self,turn,power:5000,critical:2}・grantKeyword{$self,turn,penetrate}]。
    // loseEffects/drawEffects も任意（結果分岐の一般形）。既存カードは未使用＝後方互換。ジャンケンは既存 RNG 経路
    // （resolveRockPaperScissors）を通す＝シード addLog なし・T13/リプレイ安全。
    const rpsBranchResult = await resolveRockPaperScissors(context);
    const branch =
      rpsBranchResult === "win" ? effect.winEffects
        : rpsBranchResult === "lose" ? effect.loseEffects
          : rpsBranchResult === "draw" ? effect.drawEffects
            : null;
    if (Array.isArray(branch)) {
      for (const sub of branch) {
        await executeAbilityEffect(sub, context);
      }
    }
    return;
  }
  if (effect.op === "topTwoRevealOneOpponentRandomToHandOrGauge") {
    await resolveTopTwoRevealOneOpponentRandomToHandOrGauge(effect, context);
  }
  if (effect.op === "restSelf" && context.card) {
    // 単なる used=true 代入ではなく restFieldCard を通し「レストした時」誘発(opponentRest/allyRest)を発火させる。
    const slot = findFieldCardSlot(context.card);
    if (slot) {
      await restFieldCard(slot.owner, slot.zone, context.card, { reason: "effect" });
    } else {
      context.card.used = true;
    }
  }
  if (effect.op === "dropSelf") {
    dropFieldCardByRule(player, context.zone);
  }
  if (effect.op === "lockOwnSetThisTurn" && context.card) {
    // 「そのターン中、このカードは『設置』できない」: カード名(id)単位でロック。
    // castSetSpell / script設置経路の uniqueSet 判定直後に参照し、clearTurnModifiers で解除。
    player.setLockedIdsThisTurn ||= [];
    if (!player.setLockedIdsThisTurn.includes(context.card.id)) {
      player.setLockedIdsThisTurn.push(context.card.id);
    }
  }
  if (effect.op === "destroySelf") {
    await destroyFieldCard(context.owner, context.zone, { ignoreSoulguard: true });
  }
  if (effect.op === "equipSelf") {
    // 『変身』: 発生源カード自身を（手札/場、または手札能力使用でドロップへ移った直後でも）
    // アイテムとして装備する。currentType="item" 化・装備変更・装備時誘発は equipCardDirect が処理。
    const source = context.card;
    if (source) {
      const handIndex = player.hand.findIndex((c) => c.instanceId === source.instanceId);
      if (handIndex >= 0) {
        player.hand.splice(handIndex, 1);
      } else {
        const fieldZone = [...fieldZones, ...setZones].find(
          (zone) => player.field[zone]?.instanceId === source.instanceId,
        );
        if (fieldZone) {
          player.field[fieldZone] = null;
        } else {
          const dropIndex = player.drop.findIndex((c) => c.instanceId === source.instanceId);
          if (dropIndex >= 0) {
            player.drop.splice(dropIndex, 1);
          }
        }
      }
      await equipCardDirect(player, source, { byEffect: true });
      // E3(D-SS03/0020 ゼータ『必殺変身』): 「装備したら『変身』しているアイテムとして扱い、ファイナル
      // フェイズ中にも攻撃できる」。装備先に grantedFinalPhaseAttack を立てる（src/09 canDeclareAttackInFinal が参照。
      // 場を離れると resetLeftFieldCardState でクリア）。既定（オプション無し）は従来どおり非設定＝挙動不変。
      if (effect.grantFinalPhaseAttack) {
        source.grantedFinalPhaseAttack = true;
      }
      context.cardMoved = true;
    }
  }
  if (effect.op === "stackOnFlag") {
    // FE1(X-BT01/0128 ドラゴン・ドライ): 発動側プレイヤーのフラッグを flagId のフラッグ定義へ試合中差し替え。
    // stackPlayerFlag(src/11) が cardLibrary から実体化して player.flag を置き換える（state 常駐・room/replay 安全）。
    // 以後 flagNameIs・canUseCardForFlag・フラッグ表示が新フラッグを返す。効果op としても呼べる汎用形。
    if (stackPlayerFlag(player, effect.flagId)) {
      addLog(`${player.name}のフラッグは「${player.flag?.name || effect.flagId}」になりました。`);
    }
  }
  if (effect.op === "flipFlagFaceDown") {
    // E-XB44(X-CBT02/0076 究極大魔法 ワールド・パンデミック！): 「相手のフラッグを裏にする。（フラッグが裏になると、
    // フラッグに書かれているカードは使えず、場のカードは全てドロップゾーンに置かれる）」。
    // controller 既定は "opponent"（原文「相手の」）。self/both も汎用に受ける。
    // フラッグ裏の意味論（公式カードテキスト＝本カードの括弧書きが一次資料。詳細ルール ver.2.05 と整合。WebSearch では
    // ワールド・パンデミック個別裁定は見つからず、フラッグ裏＝カードがドロップへ置かれる一般則のみ確認）:
    //   ①フラッグ能力の喪失: 裏フラッグは grant*Immunity・maxFieldSize・継続バフ等の発生源にならない
    //     （src/05-stats・src/11-destroy-turn の各フラッグ走査を flagFaceDown でゲート）。
    //   ②ワールド適合への影響: 「フラッグに書かれているカードは使えず」＝機能するフラッグが無い＝canUseCardForFlag が
    //     deckAnyFlag/usableInAnyFlag 以外を不許可（src/03-setup）。flagNameIs 条件も不成立（src/13）。
    //   ③裏のままファイト継続: フラッグ実体は player.flag に残す（表向きに戻さない＝ワンウェイ。対象内DBに戻す効果は無い）。
    //     プレイヤーの残機/手札/デッキ/ゲージは無傷。裏返しと同時に「場のカードは全てドロップゾーンに置かれる」を実施する。
    // 「置かれる」は破壊ではない（ルール処理の場移動）ため、破壊/離場誘発・ソウルガード・破壊置換は発火させない
    //   （設計判断: フラッグ裏の一括処理は再入リスクが高く、対象内DBに opponent フラッグ裏の盤面一掃へ反応するカードは無い）。
    const seat = effect.controller === "self" ? context.owner
      : effect.controller === "both" ? null
      : 1 - context.owner; // 既定 opponent
    const seats = seat === null ? [0, 1] : [seat];
    for (const s of seats) {
      const victim = state.players[s];
      if (!victim || victim.flagFaceDown) {
        continue; // 既に裏なら再一掃しない（冪等）
      }
      victim.flagFaceDown = true;
      sweepFieldToDropForFlagFlip(victim);
      addLog(`${context.card?.name || "効果"}の効果で、${victim.name}のフラッグは裏になり、場のカードは全てドロップゾーンに置かれました。`);
    }
  }
  if (effect.op === "promoteFlagReserve") {
    // E-XB54b(X-UB03/0058 ザ・カオス・アップグレード): 「君のフラッグの下にある裏向きのカード１枚までを、
    // 君のフラッグの上に表向きで重ね（る）」＝控えフラッグ(player.flagReserve = ∞ the Chaos ∞)を表向きにして
    // 現フラッグ(the Chaos)の上に重ね、以後の主フラッグ(player.flag)を ∞ the Chaos ∞ へ差し替える昇格 op。
    // 旧フラッグの行き先（原文精査）: 「フラッグの上に重ね（る）」＝旧フラッグは捨てず新フラッグの“下”に残る。
    //   FE1(ドラゴン・ドライ stackPlayerFlag) の確立形に倣い、旧フラッグ実体を新フラッグの soul に格納して保持する
    //   （物理カードを消さない＝カード保存則。room/replay に直列化される）。soul は継続/ソウルガード等の対象では
    //   ないフラッグ同士なので機能的に不活性。控えは1枚のみ（原文「１枚だけ」）＝先頭1枚を昇格し flagReserve を空にする。
    // ゲート（flagNameIs "the Chaos"・ドロップ10枚以上・1ターン1回）は 0058 側の DSL（useConditions/limit）が担う。
    // 昇格後: player.flag.name === "∞ the Chaos ∞" で flagNameIs（0012/0014）が成立し、maxFieldSizeInfinite で ∞ 場サイズ、
    //   canAttackAsFlag でフラッグ攻撃が解禁される。控えが無い（0019 を仕込んでいない）なら何もしない（冪等）。
    const reserve = (player.flagReserve || []);
    if (reserve.length > 0) {
      const promoted = reserve.shift(); // 先頭の控え札（∞ the Chaos ∞）を昇格
      player.flagReserve = reserve;
      const previousFlag = player.flag;
      if (previousFlag) {
        promoted.soul = [previousFlag, ...(promoted.soul || [])]; // 旧フラッグを下に重ねて保持（保存則）
      }
      promoted.used = false;
      player.flag = promoted;
      addLog(`${context.card?.name || "効果"}の効果で、${player.name}のフラッグは表向きの「${promoted.name}」になりました。`);
    }
  }
  if (effect.op === "banDrawNextTurn") {
    // FE2(X-BT01/0124 ガエン『変身した時』): 「次の相手のターン中、相手はカードを引くことができない」。
    // 通常ドローステップも含めて封じる（drawCards が全経路を止める）。state.drawBans に owner を積み、
    // endTurn(src/11) が remainingTurnEnds を毎ターン端で減算＝「次の相手ターン」だけに限定。state 常駐でJSON安全。
    const selfOwner = state.players.indexOf(player);
    const targetOwner = effect.controller === "self" ? selfOwner : 1 - selfOwner;
    state.drawBans ||= [];
    // remainingTurnEnds:(turns+1) ＝ 発動側の残りターン端 ＋ 対象の次ターン端。既存の同 owner エントリは張り替え。
    state.drawBans = state.drawBans.filter((entry) => entry.owner !== targetOwner);
    state.drawBans.push({ owner: targetOwner, remainingTurnEnds: (effect.turns || 1) + 1 });
    addLog(`${state.players[targetOwner].name}は次の自分のターン中、カードを引くことができなくなりました。`);
  }
  if (effect.op === "banEffectDrawTemporal") {
    // E-PR14(PR/0380「このターンと次のターン、お互いは自分のカードの効果でカードを引けない」):
    // state 常駐の時限フラグ（両陣営共通スカラー・turnCount 比較で自動失効）。今ターン(turnCount)＋
    // 以降 (turns-1) ターンまで＝既定 turns:2 で「このターンと次のターン」。effect ドロー実行点が参照する
    // isDrawByEffectPrevented(src/18)がこのフラグを見る。通常ドローステップ(drawAction)は封じない。
    // banDrawNextTurn(場常駐 preventDrawByEffect/drawBans)とは別軸で、両者は独立に効く。JSON 直列化安全。
    const until = state.turnCount + Math.max(1, effect.turns ?? 2) - 1;
    state.effectDrawBanUntilTurn = Math.max(state.effectDrawBanUntilTurn ?? -Infinity, until);
    addLog(`このターンと次のターン、お互いはカードの効果でカードを引けなくなりました。`);
  }
  if (effect.op === "setLifeZeroSafeguard") {
    // 「そのターン中、次に君のライフが0になるなら、かわりにライフは1になる」（実は生きていた！）。
    // プレイヤー単位の一回限り。resolveLifeZeroReplacements が消費し、ターン終了でクリアされる。
    // effects 指定時は消費時に追加効果（手札全捨て・相手にダメージ等。蒼舞天滝陣 0037）を実行する。
    player.lifeZeroSafeguard = { life: effect.life || 1, effects: effect.effects || null, owner: state.players.indexOf(player) };
    addLog(`${player.name}は次にライフが0になっても${effect.life || 1}で耐える構えをとった。`);
  }
  if (effect.op === "addTurnFlagNameAlias") {
    // E12(D-SS02/0005 未来占星術): 「そのターン中、君のフラッグは「X」と「Y」としても扱う」。
    // owner のターン限定フラッグ名エイリアス集合へ追加する。state 常駐（クロージャ禁止）＝
    // room復元/リプレイの規約どおり JSON 往復で保持。クリアは clearTurnModifiers（ターン終了）。
    // 参照するのは flagNameIs 条件のみで、カード使用可否(canUseCardForFlag)には効かせない
    //（公式注記「使えるワールドは変わらないぞ！！」）。names はフル表記（「レジェンドワールド」等）で
    // 登録する＝既存 flagNameIs 値は全数フル表記（Ｗ略記の機械値は0件・grep済）なので直接比較で一致する。
    state.turnFlagNameAliases ||= [[], []];
    const aliasSet = state.turnFlagNameAliases[context.owner];
    (effect.names || []).forEach((name) => {
      if (name && !aliasSet.includes(name)) {
        aliasSet.push(name);
      }
    });
    addLog(`${player.name}のフラッグはそのターン中、${(effect.names || []).map((n) => `「${n}」`).join("と")}としても扱います。`);
  }
  if (effect.op === "nullifyFieldAbilities") {
    // E2(D-SS03/0010 ドラゴンフォース・キャンセル): 「そのターン中、相手の場のモンスター全ての能力を無効化する」。
    // 魔法発＝場にホストが残らないため、発動時点で filter/controller に一致するカードの instanceId 集合を記録し、
    // state.turnNullifies へ積む。isAbilitiesNullified がこの集合も走査して能力を無効化する。
    //  - 「発動時点の場のモンスター全て」＝以後に登場したモンスターは対象外（instanceId 集合を固定するため自動的に非対象）。
    //  - 対象カードが場を離れて別カードに置換されても、instanceId で固定するので別カードを誤って無効化しない。
    //  - state 常駐（クロージャ禁止）＝room-store 復元/リプレイの JSON 往復で維持。クリアは clearTurnModifiers（ターン終了）。
    // 既存カードで使用0件（新op）＝turnNullifies は常に空＝挙動完全不変。
    const sides = effect.controller === "opponent" ? [opponent]
      : effect.controller === "self" ? [player]
      : [player, opponent];
    const ids = [];
    sides.forEach((pl) => {
      if (!pl) return;
      zones.forEach((zone) => {
        const c = pl.field[zone];
        if (c && matchesCardFilter(c, effect.filter || {})) {
          ids.push(c.instanceId);
        }
      });
    });
    if (ids.length) {
      state.turnNullifies ||= [];
      state.turnNullifies.push({ instanceIds: ids });
      addLog(`${context.card?.name || player.name}の効果で、そのターン中${ids.length}体のモンスターの能力を無効化しました。`);
    }
  }
  if (effect.op === "nullifySelectedAbilities") {
    // E-XC8(X-CP02/0040 マインドフェイカー): selectCards で選んだカード（相手の場のモンスター1枚等）を、
    // そのターン中だけ能力無効化する。nullifyFieldAbilities(D-SS03/0010)と同じ state.turnNullifies 機構
    // （isNullifiedByTurnEffect が instanceId 集合を consult・room復元/リプレイの JSON 往復で保持・
    // クリアは clearTurnModifiers）を、filter/controller の一括ではなく「選択された instance」に限定して使う。
    // nullifyFieldAbilities は「発動時点で filter 一致の全カード」を対象にするため単体選択と組み合わせられず、
    // 単体・ターン限定の無効化には本 op が要る（既存カード0件＝turnNullifies は常に空＝挙動完全不変）。
    const sel = context.vars?.[effect.var];
    const entries = Array.isArray(sel) ? sel : sel ? [sel] : [];
    const ids = entries.map((entry) => entry.card?.instanceId).filter(Boolean);
    if (ids.length) {
      state.turnNullifies ||= [];
      state.turnNullifies.push({ instanceIds: ids });
      addLog(`${context.card?.name || player.name}の効果で、そのターン中${ids.length}体の能力を無効化しました。`);
    }
  }
  if (effect.op === "destroy") {
    // 統合形: target(単体) / scope(全体) / target:"$self"(自己) を1opに。
    // options(cause/ignoreSoulguard 等)で破壊耐性の挙動差を明示的に再現する。
    if (effect.scope) {
      let scopeCandidates = collectFieldTargets(
        { scope: effect.scope, filter: effect.filter, zones: effect.zones, excludeSource: effect.excludeSource },
        context,
      );
      // E11(D-BT03/0093 斬魔滅葬陣): targetStatLte={stat, amountFrom} で「<amountFrom の値>以下の
      // <stat> を持つカードのみ」に動的絞り込み（「《武器》の攻撃力以下の防御力を持つモンスター全て」）。
      // 閾値は破壊開始前に1回だけ resolveAmountFrom で確定し、比較は visible stat
      // （destroyOpponentMonsterWithPowerLteOwnWeapon＝斬魔烈斬と同じ視点）。未指定は従来どおり。
      if (effect.targetStatLte) {
        const lteSpec = effect.targetStatLte;
        const threshold = lteSpec.amountFrom ? resolveAmountFrom(lteSpec.amountFrom, context) : lteSpec.amount || 0;
        scopeCandidates = scopeCandidates.filter(
          (entry) => visibleFieldStat(entry.card, lteSpec.stat || "defense") <= threshold,
        );
      }
      const scopeTargets = scopeCandidates.map((entry) => ({ owner: entry.owner, zone: entry.zone }));
      // 逐次破壊（順序・破壊時誘発キューの保持。並列化禁止）。
      let anyDestroyed = false;
      context.lastDestroyedCards = []; // 破壊できた実カード（amountFrom lastDestroyedStatSum 用。H-BT04/0068）
      // FE1: destroyAll{nullifyAbilities} は desugar で destroy{scope, nullifyAbilities} に化ける
      //   （src/02:140-143）。「能力を無効化して破壊」= ソウルガード/破壊耐性/破壊置換/破壊時誘発/ライフリンクを
      //   一括で貫通する。この翻訳が無いと 0004/UR s003・無印 bt04-0032/ss01-0030 の final 全体無効化破壊が
      //   耐性持ちを貫通しない（レガシー destroyAll ハンドラ 971-976 と同等。そちらは desugar 後は到達不能な
      //   デッドコードだが後方互換のため温存）。ignore*/suppress* は !options.X 判定なので false 明示は無害。
      const nullifyDestroyOptions = {
        ignoreSoulguard: Boolean(effect.ignoreSoulguard || effect.nullifyAbilities),
        ignoreDestroyImmunity: Boolean(effect.ignoreDestroyImmunity || effect.nullifyAbilities),
        ignoreDestroyReplacement: Boolean(effect.ignoreDestroyReplacement || effect.nullifyAbilities),
        suppressDestroyedTriggers: Boolean(effect.suppressDestroyedTriggers || effect.nullifyAbilities),
        suppressLifeLink: Boolean(effect.suppressLifeLink || effect.nullifyAbilities),
      };
      for (const entry of scopeTargets) {
        const d = await destroyFieldCard(entry.owner, entry.zone, { cause: makeEffectCause(context, entry.owner), ...nullifyDestroyOptions, ...(effect.options || {}) });
        if (d) {
          anyDestroyed = true;
          context.lastDestroyedCards.push(d);
        }
      }
      // 後続effectの lastDestroySucceeded 条件用（破壊が1枚でも成立したか）。
      context.lastDestroyed = anyDestroyed;
    } else if (target?.card) {
      const destroyedName = target.card.name;
      const isSelf = effect.target === "$self";
      const options = isSelf
        ? { ignoreSoulguard: true, ...(effect.options || {}) }
        : { cause: makeEffectCause(context, target.owner), ...(effect.options || {}) };
      const destroyed = await destroyFieldCard(target.owner, target.zone, options);
      context.lastDestroyed = Boolean(destroyed);
      if (destroyed && !isSelf && context.card) {
        addLog(`${context.card.name}の効果で${destroyedName}を破壊しました。`);
      }
    }
  }
  if (effect.op === "destroyAll") {
    // FE1 注記: destroyAll は normalizeCardDefinition の desugarStatDestroyEffectOps で
    //   destroy{scope} へ書き換えられるため、この分岐は正規化済みカードからは到達しない
    //   デッドコード（生 op を直接投げる内部呼び出しの後方互換のため温存・削除不可）。
    //   nullifyAbilities の実挙動は上の destroy{scope} 経路（nullifyDestroyOptions）が担う。
    const destroyAllTargets = allFieldTargets((card, owner, zone) => {
      if (Array.isArray(effect.zones) && !effect.zones.includes(zone)) {
        return false;
      }
      if (effect.controller === "self" && owner !== context.owner) {
        return false;
      }
      if (effect.controller === "opponent" && owner === context.owner) {
        return false;
      }
      if (effect.excludeSource && card.instanceId === context.card?.instanceId) {
        return false; // このカード以外を全破壊（0094）
      }
      return matchesTargetFilter(card, owner, zone, effect.filter);
    }).map((candidate) => ({ owner: candidate.owner, zone: candidate.zone }));
    // 逐次破壊（順序・破壊時誘発キューの保持。並列化禁止）。
    // E6(D-BT03/0026): destroy(scope) と同じく実破壊カードを記録（amountFrom lastDestroyedCount /
    // lastDestroyedStatSum 用）。destroyAll+lastDestroyed* 同居の既存カードは0件（全数grep）＝挙動不変。
    context.lastDestroyedCards = [];
    for (const candidate of destroyAllTargets) {
      const destroyed = await destroyFieldCard(candidate.owner, candidate.zone, {
        cause: makeEffectCause(context, candidate.owner),
        // nullifyAbilities: 「場のモンスターの能力全てを無効化し…破壊する」(大魔法 ラグナロク 0030)。
        // 能力由来の防御(ソウルガード/破壊耐性/破壊置換)と破壊時誘発を一括で無効化してから破壊する。
        ignoreSoulguard: Boolean(effect.ignoreSoulguard || effect.nullifyAbilities),
        ignoreDestroyImmunity: Boolean(effect.ignoreDestroyImmunity || effect.nullifyAbilities),
        ignoreDestroyReplacement: Boolean(effect.nullifyAbilities),
        suppressDestroyedTriggers: Boolean(effect.nullifyAbilities),
        // ライフリンクもキーワード能力なので「能力全て無効化してから破壊」では発動しない（ラグナロク）。
        suppressLifeLink: Boolean(effect.nullifyAbilities),
      });
      if (destroyed) {
        context.lastDestroyedCards.push(destroyed);
      }
    }
  }
  if (effect.op === "moveTargetToDrop" && target?.card) {
    const ownerPlayer = state.players[target.owner];
    const leaveCause = makeEffectCause(context, target.owner);
    // E-XB34(X-BT04/0040/0110 鏡面峡谷): 「別のエリアに置かれない」＝相手効果によるドロップ送り（非破壊の再配置）を防ぐ。
    if (cardProtectedFrom(target.card, "moveArea", leaveCause)) {
      addLog(`${target.card.name}は効果で別のエリアに置かれません。`);
      return;
    }
    // E2(D-EB02/0031): 相手効果で場を離れる際、対象側の離場置換（バリア発動！等）が庇えば場に残す。
    // E4(D-SS03/0029): 対象のソウル内カードによる離場置換（バリアブル・ビット）も同様に庇える。
    if (!(
      (fieldHasLeaveFieldReplacer(target.owner) && (await applyAllyLeaveFieldReplacement(target.card, target.owner, leaveCause))) ||
      (soulHasLeaveFieldReplacer(target.card) && (await applySoulLeaveFieldReplacement(target.card, target.owner, leaveCause)))
    )) {
      const moved = dropFieldCardByRule(ownerPlayer, target.zone);
      if (moved) {
        addLog(`${context.card.name}の効果で${moved.name}をドロップゾーンに置きました。`);
      }
    }
  }
  if (effect.op === "returnToHand" && target) {
    // Z14(b)(S-UB-C03/0017): 「君のカードの効果で」判定用の returnCause を伝播する。
    // E2(D-EB02/0031): 相手効果による手札戻しも離場置換の対象。庇えたら戻さず場に残す。
    // E4(D-SS03/0029): 対象のソウル内カードによる離場置換（バリアブル・ビット）も庇える。
    const returnTargetCard = target.card || state.players[target.owner]?.field?.[target.zone];
    const leaveCause = makeEffectCause(context, target.owner);
    if (!(
      (fieldHasLeaveFieldReplacer(target.owner) && (await applyAllyLeaveFieldReplacement(returnTargetCard, target.owner, leaveCause))) ||
      (soulHasLeaveFieldReplacer(returnTargetCard) && (await applySoulLeaveFieldReplacement(returnTargetCard, target.owner, leaveCause)))
    )) {
      returnFieldTargetToHand(target, context.card.name, { returnCause: leaveCause });
    }
  }
  if (effect.op === "dischargeSelfFromHostSoul" && context.card && context.hostCard) {
    // ソウルに入っているこのカード自身を、ホスト（武器等）のソウルから退避する。
    // E-XB4(X-BT02/0103 天装機 ゼーナ「場か、ソウルにあるこのカードをデッキの下に置いてよい」のソウル分岐):
    // to:"deckBottom" でデッキ下へ、未指定=従来どおりドロップへ着地（後方互換）。いずれもホストの soul 配列
    // から removed を1枚抜くだけ＝枚数/instanceId 保存則(fuzz の card-conservation)を満たす。
    const soul = context.hostCard.soul || [];
    const soulIndex = soul.findIndex((c) => c.instanceId === context.card.instanceId);
    if (soulIndex >= 0) {
      const [removed] = soul.splice(soulIndex, 1);
      const selfPlayer = context.player || state.players[context.owner];
      if (effect.to === "deckBottom") {
        // デッキへ戻る際は変身等の一時的な型上書きを解除する（returnSelfToDeckBottom と同方針）。
        // deck.pop() が山上のため unshift が最下段。
        removed.currentType = removed.baseType || removed.type;
        selfPlayer.deck.unshift(removed);
        queueDeckBottomPlacedTriggers(state.players.indexOf(selfPlayer), [removed]); // E-XB18: デッキ下流入
        addLog(`${removed.name}を${context.hostCard.name}のソウルからデッキの下に置きました。`);
      } else {
        selfPlayer.drop.push(removed);
        addLog(`${removed.name}を${context.hostCard.name}のソウルからドロップに置きました。`);
      }
    }
  }
  if (effect.op === "dropSoulSourceCard" && context.card && context.soulSourceCard) {
    // E-XC13(X-CP02/0046 ビガーブレイブ): triggered soulAbility（event:battleEnd 等）の解決から、発生源の
    // ソウル札自身（context.soulSourceCard＝runTriggeredAbilities が設定）を、ホスト（context.card）の
    // ソウルからドロップへ置く。dischargeSelfFromHostSoul は activated 用（context.card=ソウル本体・
    // context.hostCard 必須）の逆配線でこの triggered 経路では不発のため、対の op を新設する。
    // soul→drop funnel（queueSoulCardDroppedTriggers＝reconcileFaceDownSoulDrops＋ホスト側 soulCardDropped）
    // を通して離脱を整合させる（既存カード0件＝挙動不変）。
    const host = context.card;
    const soul = host.soul || [];
    const soulIndex = soul.findIndex((c) => c.instanceId === context.soulSourceCard.instanceId);
    if (soulIndex >= 0) {
      const [removed] = soul.splice(soulIndex, 1);
      const selfPlayer = context.player || state.players[context.owner];
      selfPlayer.drop.push(removed);
      addLog(`${removed.name}を${host.name}のソウルからドロップに置きました。`);
      queueSoulCardDroppedTriggers(host, context.owner, 1);
    }
  }
  if (effect.op === "returnSelfToDeckBottom" && context.card) {
    // このカード自身をデッキの下に置く（シーフ・キャット 0049）。deck.pop()が山上なので unshift=最下。
    const selfPlayer = context.player || state.players[context.owner];
    const card = context.card;
    if (selfPlayer) {
      const slot = findFieldCardSlot(card);
      if (slot && slot.owner === state.players.indexOf(selfPlayer)) {
        selfPlayer.drop.push(...(card.soul || []));
        card.soul = [];
        selfPlayer.field[slot.zone] = null;
      } else {
        const dropIndex = selfPlayer.drop.findIndex((c) => c.instanceId === card.instanceId);
        if (dropIndex >= 0) selfPlayer.drop.splice(dropIndex, 1);
      }
      card.currentType = card.baseType || card.type;
      selfPlayer.deck.unshift(card);
      queueDeckBottomPlacedTriggers(state.players.indexOf(selfPlayer), [card]); // E-XB18: デッキ下流入
      addLog(`${card.name}をデッキの下に置きました。`);
    }
  }
  if (effect.op === "returnSelfToHand" && context.card) {
    // 使用中のこのカード自身を手札に戻す（対抗呪文等は解決時点で既にドロップにある）。
    const selfPlayer = context.player || state.players[context.owner];
    if (selfPlayer) {
      const selfOwnerIndex = state.players.indexOf(selfPlayer);
      const selfSlot = findFieldCardSlot(context.card);
      if (selfSlot && selfSlot.owner === selfOwnerIndex) {
        // F5: 場にあるこのカード自身の手札戻し（battleEnd自己戻し bf-h-eb04-0008/0011/0059・
        // bf-h-pp01-0036/0063、【対抗】自己戻し bf-s-ub-c03-0020/0071/0084 等）。従来はドロップ回収
        // しか処理せず field[zone] に参照が残り「場と手札に同一カードが複製」される実バグだった。
        // 正規の単体手札戻し経路（ソウルのドロップ送り・ゾーンクリア・ライフリンク・戻り誘発・
        // cannotReturnToHand/離場置換ゲート込み）へ委譲する。
        const returned = returnFieldTargetToHand(
          { owner: selfSlot.owner, zone: selfSlot.zone },
          context.card.name,
        );
        if (returned) {
          context.cardMoved = true;
        }
      } else {
        const dropIndex = selfPlayer.drop.findIndex((c) => c.instanceId === context.card.instanceId);
        if (dropIndex >= 0) {
          selfPlayer.drop.splice(dropIndex, 1);
        }
        if (!selfPlayer.hand.some((c) => c.instanceId === context.card.instanceId)) {
          resetLeftFieldCardState(context.card);
          selfPlayer.hand.push(context.card);
        }
        // レビュー修正(D-BT01/0027): メインフェイズ魔法/必殺技は解決時点でカードが action.card に保持されて
        // いる（ドロップに無い）。cardMoved を立てないと resolvePendingSpell が同一インスタンスをドロップにも
        // 積んで二重存在（カード複製）になる。既存の同型カード（H-EB02/0052等）の潜在バグも同時に解消。
        context.cardMoved = true;
        addLog(`${context.card.name}を手札に戻しました。`);
        // E-XV6(X-UB02/0015): ドロップ回収枝の自己誘発（fromZone:"drop"）。fromZones:["field"] を指定した
        // リスナー（0015）はここでは発火しない＝「場から手札に戻った時」限定が ability 側で選べる。
        queueReturnedToHandTriggers(context.card, selfOwnerIndex, "drop");
      }
    }
  }
  if (effect.op === "moveSelfToBuddyZoneFaceDown" && context.card) {
    // Z2(S-UB-C03/0041,0042): 使用中のこのカード自身を、解決後に裏向きで自分のバディゾーンへ置く。
    // 通常のメインフェイズ魔法解決(resolvePendingSpell 07-actions-turn.js)は executeAbilityBody の
    // 後に「context.cardMovedが立っていなければ」自動でドロップへ積む設計のため、ここで
    // cardMoved=true を立てて二重配置(バディゾーン+ドロップ)を防ぐ（moveSelfToTargetSoul等と同型）。
    // 【対抗】即時解決タイミング(useHandAbilityAction 13-abilities-core.js)は逆に実行前に既にドロップへ
    // 積まれているため、その場合はドロップから回収してから移す（returnSelfToHandと同型の後追い方式）。
    const selfPlayer = context.player || state.players[context.owner];
    if (selfPlayer) {
      const dropIndex = selfPlayer.drop.findIndex((c) => c.instanceId === context.card.instanceId);
      if (dropIndex >= 0) {
        selfPlayer.drop.splice(dropIndex, 1);
      }
      selfPlayer.buddyZoneFaceDown ||= [];
      if (!selfPlayer.buddyZoneFaceDown.some((c) => c.instanceId === context.card.instanceId)) {
        selfPlayer.buddyZoneFaceDown.push(context.card);
      }
      context.cardMoved = true;
      // ログにカード名を出さない（ネット対戦の相手にも見えるログからの秘匿カード名リーク防止。Z2秘匿方針）。
      addLog(`${selfPlayer.name}はカードを裏向きでバディゾーンに置きました。`);
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
    const allReturnedForTriggers = [];
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
      // Z9(S-UB-C03/0072): 「次に場から離れる場合、そのカードを場に残す」。
      if (returned.preventNextLeaveFieldCount > 0) {
        returned.preventNextLeaveFieldCount -= 1;
        addLog(`${returned.name}は効果により場に残りました。`);
        continue;
      }
      // X9(D-BT01/0131): コスト付き離場置換（手札戻しもカバー）。
      if (await tryLeaveFieldReplacement(returned, candidate.owner)) {
        continue;
      }
      ownerPlayer.drop.push(...(returned.soul || []));
      returned.soul = [];
      ownerPlayer.field[candidate.zone] = null;
      if (candidate.zone === "item" && ownerPlayer.arrivalCardId === returned.instanceId) {
        ownerPlayer.arrivalCardId = null;
      }
      resetLeftFieldCardState(returned);
      ownerPlayer.hand.push(returned);
      applyLifeLink(returned, candidate.owner);
      addLog(`${returned.name}を手札に戻しました。`);
      // E-XV6(X-UB02/0015): 戻ったカード自身の「このカードが手札に戻った時」自己誘発（全戻し funnel。
      // returnFieldTargetToHand を経ない直接 hand.push のため、ここでも queue する＝兄弟経路の取りこぼし防止）。
      queueReturnedToHandTriggers(returned, candidate.owner, "field");
      allReturnedForTriggers.push({ card: returned, owner: candidate.owner, zone: candidate.zone });
      if (effectiveCardType(returned) === "monster") {
        returnedForTriggers.push({ card: returned, owner: candidate.owner, zone: candidate.zone });
      }
    }
    // E4'(D-EB03/0002): 「戻した枚数」＝この呼び出しで実際に手札へ戻した全カード（アイテム/設置含む）。
    // 従来はモンスターのみ計数で、0002「相手の場のカード全てを手札に戻し、戻した枚数分ダメージ」が過少だった。
    // 既存の参照元 bf-d-bt01-0013 は filter:{cardType:"monster"} でモンスターしか戻さないため挙動不変（全数監査済み）。
    context.returnedCount = allReturnedForTriggers.length; // X2: 後続 amountFrom {source:"returnedCount"} 用
    // 「場のモンスターが手札に戻った時」誘発を逐次 await で発火する。
    // マイクロタスク並列だと消費側の「1ターン1回」が markAbilityLimit 前に複数回パスするため、直列化する。
    // Z14(b)(S-UB-C03/0017): 「君のカードの効果で」判定用の returnCause を伝播する。
    for (const r of returnedForTriggers) {
      await runFieldEventTriggers("monsterReturned", r.owner, r.card, r.zone, {
        returnCause: makeEffectCause(context, r.owner),
      });
    }
    // レビュー修正(D-BT01/0096等): カード種を問わない cardReturned も発火（新イベント・後方互換。既存の
    // monsterReturned 消費側の文脈を汚さないよう後段で・details は都度生成）。
    for (const r of allReturnedForTriggers) {
      await runFieldEventTriggers("cardReturned", r.owner, r.card, r.zone, {
        returnCause: makeEffectCause(context, r.owner),
      });
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
      recipients.forEach((entry) =>
        applyModifyStatsDelta(entry.card, duration, delta, makeEffectCause(context, entry.owner)),
      );
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
      // Z4(c)(S-UB-C03/0056): 相手発のAoEステ減少も grantStatDecreaseImmunity 保護を通す。
      const cause = makeEffectCause(context, entry.owner);
      entry.card[`${prefix}PowerBonus`] += guardStatDelta(entry.card, "power", effect.power || 0, cause);
      entry.card[`${prefix}DefenseBonus`] += guardStatDelta(entry.card, "defense", effect.defense || 0, cause);
      entry.card[`${prefix}CriticalBonus`] += guardStatDelta(entry.card, "critical", effect.critical || 0, cause);
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
    // Z4(c)(S-UB-C03/0056): 相手発の負デルタは grantStatDecreaseImmunity 保護を通す。
    const cause = makeEffectCause(context, target.owner);
    target.card[`${prefix}PowerBonus`] += guardStatDelta(target.card, "power", effect.power || 0, cause);
    target.card[`${prefix}DefenseBonus`] += guardStatDelta(target.card, "defense", effect.defense || 0, cause);
    target.card[`${prefix}CriticalBonus`] += guardStatDelta(target.card, "critical", effect.critical || 0, cause);
  }
  if (
    effect.op === "modifyStatsIfTargetName" &&
    target?.card &&
    (effect.nameIncludes ? target.card.name.includes(effect.nameIncludes) : target.card.name === effect.name)
  ) {
    const duration = effect.duration || "battle";
    const prefix = duration === "turn" ? "turn" : "battle";
    const cause = makeEffectCause(context, target.owner);
    target.card[`${prefix}PowerBonus`] += guardStatDelta(target.card, "power", effect.power || 0, cause);
    target.card[`${prefix}DefenseBonus`] += guardStatDelta(target.card, "defense", effect.defense || 0, cause);
    target.card[`${prefix}CriticalBonus`] += guardStatDelta(target.card, "critical", effect.critical || 0, cause);
  }
  if (effect.op === "grantKeyword" && target?.card) {
    // duration を counterattack 特別扱いより先に判定する。counterattack+duration:"turn" は
    // turnKeywords に載せることで、clearBattleModifiers(バトル終了)ではなく clearTurnModifiers(ターン終了)で
    // クリアされる（「そのターン中『反撃』を得る」がバトル終了で失効するのを防ぐ）。
    if (effect.duration === "permanent") {
      target.card.keywords ||= [];
      if (!target.card.keywords.includes(effect.keyword)) {
        target.card.keywords.push(effect.keyword);
      }
    } else if (effect.duration === "turn") {
      target.card.turnKeywords ||= [];
      target.card.turnKeywords.push(effect.keyword);
    } else if (effect.keyword === "counterattack") {
      target.card.counterattack = true;
    } else {
      target.card.temporaryKeywords ||= [];
      target.card.temporaryKeywords.push(effect.keyword);
    }
  }
  if (effect.op === "dropTargetSoul" && target?.card) {
    // Z4(b)(S-UB-C03/0012): grantSoulDiscardImmunity で保護されたカードのソウルは相手の効果で捨てられない。
    // 自発（自分のコスト/ソウルガード等）はcause.byOpponent=falseのためゲート対象外。
    const soulDiscardCause = makeEffectCause(context, target.owner);
    if (soulDiscardCause.byOpponent && cardProtectedFrom(target.card, "soulDiscard", soulDiscardCause)) {
      addLog(`${target.card.name}のソウルは相手のカードの効果で捨てられません。`);
      return;
    }
    const amount = effect.amount ?? target.card.soul?.length ?? 0;
    if (amount <= 0) {
      return;
    }
    const soulEntries = (target.card.soul || [])
      .map((card, index) => ({
        card,
        index,
        owner: target.owner,
        source: "soul",
        note: `${target.card.name}のソウル`,
      }))
      // E-XB59②(X-UB03/0031 エニグマ・ウィルス②): 自己保護(selfInSoulProtection)されたソウル札は相手効果のドロップ候補から外す
      //   （soulDiscardCause は上で makeEffectCause 済み＝byOpponent を含む）。自発(byOpponent:false)は from:{byOpponent:true} を通さない。
      .filter((entry) => !soulCardSelfProtectedFrom(entry.card, "soulDrop", soulDiscardCause))
      // E-XB58(X-UB03/0016 起爆畳): faceDown:true は裏向きソウルのみを候補にする（原文「裏向きのソウル」限定）。
      .filter((entry) => !effect.faceDown || entry.card?.faceDown);
    const selected =
      soulEntries.length > amount
        ? await chooseCardEntries(soulEntries, {
            title: `${context.card.name}のソウル選択`,
            lead: `${target.card.name}のソウルからドロップゾーンに置くカードを${amount}枚選んでください。`,
            min: amount,
            max: amount,
            forceDialog: true,
            promptSeat: context.owner, // 効果の使用者が選ぶ（CPU対戦/権威サーバの誤配送防止）
            purpose: "hostile",
          })
        : soulEntries.slice(0, amount);
    const movedCards = removePileEntries(target.card.soul || [], selected || []);
    state.players[target.owner].drop.push(...movedCards);
    // E1/F2: ホスト存命のままソウルがドロップへ → soulCardDropped（下の自壊で離場したら発火時再検証で不発）。
    queueSoulCardDroppedTriggers(target.card, target.owner, movedCards.length);
    maybeDropSetWhenSoulEmpty(target.card, target.owner); // 設置のソウル切れ自壊（相手発の dropTargetSoul でも）
    if (movedCards.length > 0) {
      addLog(
        `${context.card.name}の効果で${target.card.name}のソウルから${movedCards
          .map((card) => card.name)
          .join("、")}をドロップゾーンに置きました。`,
      );
    }
  }
  if (effect.op === "returnTargetSoulToHand" && target?.card) {
    // E-XB11(X-SS03/0057 アトラ"SD"): 「場のカード1枚を選び、そのカードのソウル全てを持ち主の手札に戻す」。
    // dropTargetSoul の宛先違い版（ドロップではなく持ち主＝target.owner の手札へ）。amount 省略＝全て。
    // これは「捨てる」ではなく「戻す」なので soulDiscardImmunity（Z4(b)）ゲート・soulCardDropped 誘発は掛けない
    // （ソウルはドロップに落ちていない）。ソウル切れの設置自壊のみ dropTargetSoul と同様に検査する。
    const amount = effect.amount ?? target.card.soul?.length ?? 0;
    if (amount <= 0) {
      return; // ソウル0枚＝no-op（枚数保存）
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
            lead: `${target.card.name}のソウルから手札に戻すカードを${amount}枚選んでください。`,
            min: amount,
            max: amount,
            forceDialog: true,
            promptSeat: context.owner, // 効果の使用者が選ぶ（CPU対戦/権威サーバの誤配送防止）
            purpose: "move",
          })
        : soulEntries.slice(0, amount);
    const movedCards = removePileEntries(target.card.soul || [], selected || []);
    // 「持ち主の手札」＝ソウルを持つカードの持ち主(target.owner)の手札（dropTargetSoul が drop 先を target.owner に
    // 取るのと同じ持ち主決定）。instanceId/枚数はそのまま保存（soul → hand の移動のみ・card-conservation 満たす）。
    state.players[target.owner].hand.push(...movedCards);
    maybeDropSetWhenSoulEmpty(target.card, target.owner); // 設置のソウル切れ自壊（宛先が手札でも同様）
    if (movedCards.length > 0) {
      addLog(
        `${context.card.name}の効果で${target.card.name}のソウルから${movedCards
          .map((card) => card.name)
          .join("、")}を持ち主の手札に戻しました。`,
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
        const droppedCount = fieldCard.soul.length;
        addLog(`${context.card.name}の効果で${fieldCard.name}のソウル${droppedCount}枚をドロップゾーンに置きました。`);
        state.players[soulOwner].drop.push(...fieldCard.soul);
        fieldCard.soul = [];
        // E1/F2: ホスト存命のままソウル全てがドロップへ → soulCardDropped。
        queueSoulCardDroppedTriggers(fieldCard, soulOwner, droppedCount);
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
    // Z4(a)(S-UB-C03/0021,0077): grantRestImmunity/ターン限定保護で保護されたカードは相手の効果でレストされない。
    // 攻撃レスト(09:143 reason:"attack")は cause.byBattle 相当でありこの経路を通らないためゲート対象外。
    const restCause = makeEffectCause(context, target.owner);
    if (restCause.byOpponent && cardProtectedFrom(target.card, "rest", restCause)) {
      addLog(`${target.card.name}は相手のカードの効果でレストされません。`);
      return;
    }
    if (await restFieldCard(target.owner, target.zone, target.card, { source: context.card, restCause, reason: "effect" })) {
      addLog(`${context.card.name}の効果で${target.card.name}をレストしました。`);
    }
  }
  if (effect.op === "standTarget" && target?.card) {
    // Z14(g)(S-UB-C03/0038): そのターン中スタンド不可。E-XU4(0043 グミスライム): アタックフェイズ中の継続スタンド不可。
    if (standRestrictedNow(target.card)) {
      addLog(`${target.card.name}はスタンドできません。`);
      return;
    }
    const wasRested = Boolean(target.card.used); // E9: レスト→スタンドへ実際に遷移した時のみ発火
    target.card.used = false;
    addLog(`${context.card.name}の効果で${target.card.name}をスタンドしました。`);
    if (wasRested) {
      queueStandTriggers([
        { owner: target.owner, zone: target.zone, card: target.card, cause: makeEffectCause(context, target.owner) },
      ]);
    }
  }
  if (effect.op === "standAll") {
    // controller/filter 一致の場のカード全てをスタンド（「君の場の《冒険者》全てを【スタンド】」0046）。
    const targets = allFieldTargets((card, owner, zone) => {
      if (Array.isArray(effect.zones) && !effect.zones.includes(zone)) return false;
      if (effect.controller === "self" && owner !== context.owner) return false;
      if (effect.controller === "opponent" && owner === context.owner) return false;
      return matchesTargetFilter(card, owner, zone, effect.filter || {});
    });
    let standCount = 0;
    const stoodEntries = []; // E9: レスト→スタンドへ実際に遷移したカードのみブロードキャスト対象
    targets.forEach((t) => {
      // Z14(g)(S-UB-C03/0038): そのターン中スタンド不可＋E-XU4(0043): アタックフェイズ中の継続スタンド不可を対象外に。
      if (t.card && !standRestrictedNow(t.card)) {
        if (t.card.used) {
          stoodEntries.push({ owner: t.owner, zone: t.zone, card: t.card, cause: makeEffectCause(context, t.owner) });
        }
        t.card.used = false;
        standCount += 1;
      }
    });
    if (standCount > 0) {
      addLog(`${context.card?.name || "効果"}の効果で${standCount}枚をスタンドしました。`);
    }
    queueStandTriggers(stoodEntries); // E9（複数枚も1チェーンで逐次発火）
  }
  if (effect.op === "setNextAllyAttackTrigger") {
    // E10(D-CBT/0110 ヒートウェーブ・R5近似(a)): 「そのターン中、(attackerFilter に一致する)味方のカードが
    // 攻撃した時」に一度だけ effects を実行するワンショット予約。state 常駐キュー（プレーンJSON＝room復元
    // 対応）へ積み、攻撃宣言時（runAttackDeclarationTriggers 末尾・src/09）に一致した最初の攻撃で消費する。
    // chooseTarget があれば発火時に対象選択（promptSeat=予約者の席）→ effects は "$target" で参照。
    // ターン終了時に clearTurnModifiers（src/11）が破棄する。既存カード使用0件＝挙動不変。
    state.nextAllyAttackTriggers ||= [];
    state.nextAllyAttackTriggers.push({
      owner: context.owner,
      attackerFilter: effect.attackerFilter || effect.filter || {},
      chooseTarget: effect.chooseTarget || null,
      effects: effect.effects || [],
      sourceName: context.card?.name || "効果",
      // ログ/makeEffectCause 用の最小スナップショット。実カード参照は room 復元（JSON往復）で
      // 同一性が切れるため持たない（cause の filter 照合に必要な面のみ写す）。
      sourceCard: context.card
        ? {
            id: context.card.id,
            name: context.card.name,
            type: context.card.type,
            currentType: context.card.currentType,
            world: context.card.world,
            attributes: [...(context.card.attributes || [])],
            size: context.card.size,
          }
        : null,
    });
    addLog(`${context.card?.name || "効果"}の効果を予約しました（このターン中、条件を満たす攻撃時に発動）。`);
  }
  if (effect.op === "attackWithAll") {
    // controller/filter 一致の【スタンド】している場のカード全てで一度に(連携)攻撃する（0046）。
    // 対象は既定でファイター本体。既にpendingAttack中なら安全のため何もしない。
    if (!state.pendingAttack && typeof performAttackDeclaration === "function") {
      const seat = effect.controller === "opponent" ? 1 - context.owner : context.owner;
      const attackers = zones
        .map((zone) => ({ owner: seat, zone, card: state.players[seat]?.field?.[zone] }))
        .filter(
          (a) => a.card && !a.card.used && matchesTargetFilter(a.card, a.owner, a.zone, effect.filter || {}),
        );
      if (attackers.length > 0) {
        state.linkAttackers = attackers.map((a) => ({ owner: a.owner, zone: a.zone }));
        // 相手センターにモンスターがいるとファイター本体は攻撃できない。
        // 既定ではセンターのモンスターを攻撃対象にし、センターが空なら本体を攻撃する（0046）。
        const oppSeat = 1 - seat;
        const attackTarget =
          effect.attackTarget || (state.players[oppSeat]?.field?.center ? "center" : "fighter");
        await performAttackDeclaration(attackers, attackTarget);
      }
    }
  }
  if (effect.op === "putTargetToGaugeAtTurnEnd" && target?.card) {
    // 「ターン終了時、そのモンスターを君のゲージに置く」。フラグを立て runEndTurnEffects で移動。
    // E-XB34(鏡面峡谷): 相手効果による「別のエリアに置かれない」なら予約自体を行わない（通常は自陣モンスター対象で
    // cause.byOpponent=false＝素通り）。
    const moveCause = makeEffectCause(context, target.owner);
    if (cardProtectedFrom(target.card, "moveArea", moveCause)) {
      addLog(`${target.card.name}は効果で別のエリアに置かれません。`);
      return;
    }
    target.card.putToGaugeAtEndOfTurnOwner = context.owner;
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
  if (effect.op === "suppressAttackTargetKeyword" && state.pendingAttack) {
    // 攻撃対象のモンスターの指定キーワードをそのターン中 無効化する（アクワルタ・グワルナフのソウルガード封じ）。
    const targetCard = state.players[state.pendingAttack.targetOwner]?.field?.[state.pendingAttack.targetZone];
    if (targetCard && effectiveCardType(targetCard) === "monster") {
      targetCard.turnSuppressedKeywords = targetCard.turnSuppressedKeywords || [];
      if (!targetCard.turnSuppressedKeywords.includes(effect.keyword)) {
        targetCard.turnSuppressedKeywords.push(effect.keyword);
      }
      addLog(`${context.card?.name || "効果"}で${targetCard.name}の『${effect.keyword}』をそのターン無効化しました。`);
    }
  }
  if (effect.op === "suppressKeywordAll") {
    // controller の場のカード全て（filter一致）の指定キーワードをそのターン無効化する。
    // 例: エンタングル・ローパー「相手の場のカード全ての貫通を無効化」。
    const targetOwner = effect.controller === "opponent" ? 1 - context.owner : context.owner;
    const targetPlayer = state.players[targetOwner];
    zones.forEach((zone) => {
      const fieldCard = targetPlayer?.field?.[zone];
      if (!fieldCard) {
        return;
      }
      if (effect.filter && !matchesCardFilter(fieldCard, effect.filter)) {
        return;
      }
      fieldCard.turnSuppressedKeywords = fieldCard.turnSuppressedKeywords || [];
      if (!fieldCard.turnSuppressedKeywords.includes(effect.keyword)) {
        fieldCard.turnSuppressedKeywords.push(effect.keyword);
      }
    });
    addLog(`${context.card?.name || "効果"}で${targetOwner === context.owner ? "君" : "相手"}の場全ての『${effect.label || effect.keyword}』をそのターン無効化しました。`);
  }
  if (effect.op === "preventAttackDamageThisTurn") {
    // そのターン中、君が攻撃によって受けるダメージを0にする（拳士の覚悟 グラップルソウル）。
    // onlyAttack=攻撃ダメージ限定、once:false=ターン中持続（turn-end で untilTurnOwner により消える）。
    addNextDamagePrevention(context.owner, {
      preventAll: true,
      once: false,
      onlyAttack: true,
      source: context.card?.name,
      sourceCard: context.card,
    });
    addLog(`${context.card?.name || "効果"}で、そのターン中に攻撃で受けるダメージを0にします。`);
  }
  if (effect.op === "boostSpiritStrikeDamage") {
    // そのターン中、“霊撃”（event:"destroyByAttack" の dealDamage）で相手に与えるダメージを +amount。
    state.spiritStrikeDamageBonus ||= [0, 0];
    state.spiritStrikeDamageBonus[context.owner] += effect.amount || 1;
    addLog(`${context.card?.name || "効果"}で、そのターン中の“霊撃”ダメージを+${effect.amount || 1}します。`);
  }
  if (effect.op === "rockPaperScissorsBestOfThree") {
    // 相手と rounds 回（アイコは数えない）ジャンケンし、勝った数 × drawPerWin 枚ドロー。
    // rounds 回全敗なら相手が opponentDrawOnSweep 枚ドロー（審判アスモダイの超公平３回勝負）。
    const rounds = effect.rounds || 3;
    let wins = 0;
    let losses = 0;
    let decided = 0;
    let safety = 0;
    while (decided < rounds && safety < 50) {
      safety += 1;
      const result = await resolveRockPaperScissors(context);
      if (result === "cancelled") {
        break;
      }
      if (result === "win") {
        wins += 1;
        decided += 1;
      } else if (result === "lose") {
        losses += 1;
        decided += 1;
      }
      // draw はアイコ=数えず再戦
    }
    const selfDraw = wins * (effect.drawPerWin || 1);
    if (selfDraw > 0 && isDrawByEffectPrevented(context.owner)) {
      addLog(`${player.name}はカードの効果でカードを引けません。`);
    } else if (selfDraw > 0) {
      drawCards(player, selfDraw);
      addLog(`${context.card?.name || "効果"}: ${player.name}はジャンケンに${wins}勝し、${selfDraw}枚引きました。`);
      await runFieldEventTriggers("drawByEffect", context.owner);
    }
    if (losses >= rounds) {
      const sweep = effect.opponentDrawOnSweep || 0;
      if (sweep > 0 && isDrawByEffectPrevented(1 - context.owner)) {
        addLog(`${opponent.name}はカードの効果でカードを引けません。`);
      } else if (sweep > 0) {
        drawCards(opponent, sweep);
        addLog(`${context.card?.name || "効果"}: ${player.name}は${rounds}回負け、${opponent.name}は${sweep}枚引きました。`);
        await runFieldEventTriggers("drawByEffect", 1 - context.owner);
      }
    }
  }
  if (effect.op === "putTargetToGauge" && target?.card) {
    const ownerPlayer = state.players[target.owner];
    const leaveCause = makeEffectCause(context, target.owner);
    // E-XB34(鏡面峡谷): 「別のエリアに置かれない」＝相手効果によるゲージ送りを防ぐ。
    if (cardProtectedFrom(target.card, "moveArea", leaveCause)) {
      addLog(`${target.card.name}は効果で別のエリアに置かれません。`);
      return;
    }
    // E2(D-EB02/0031): 相手効果によるゲージ送りも離場置換の対象。庇えたら送らず場に残す。
    // E4(D-SS03/0029): 対象のソウル内カードによる離場置換（バリアブル・ビット）も庇える。
    if (!(
      (fieldHasLeaveFieldReplacer(target.owner) && (await applyAllyLeaveFieldReplacement(target.card, target.owner, leaveCause))) ||
      (soulHasLeaveFieldReplacer(target.card) && (await applySoulLeaveFieldReplacement(target.card, target.owner, leaveCause)))
    )) {
      const moved = putFieldCardToGauge(ownerPlayer, target.zone);
      if (moved) {
        addLog(`${context.card.name}の効果で${moved.name}をゲージに置きました。`);
      }
    }
  }
  if (effect.op === "attachDestroyReaction" && target?.card) {
    // 対象カードに「そのターン中に破壊された時、reactionOwnerが指定effectsを解決する」遅延リアクションを付与（ダークターゲット0058）。
    const reactionSeat = effect.reactionOwner === "opponent" ? 1 - context.owner : context.owner;
    target.card.destroyReaction = {
      owner: reactionSeat,
      effects: effect.effects || [],
      duration: effect.duration || "turn",
      sourceName: context.card?.name,
    };
    addLog(`${context.card?.name || "効果"}の効果で${target.card.name}に破壊時リアクションを付与しました。`);
  }
  if (effect.op === "preventStandNextTurn") {
    // 次のスタートフェイズで指定カードをスタンドさせない（standPlayer が preventStandOnce を消費）。
    // E-PR8(PR/0295 竜装機キャストネッター・D-CBT/0007 ゾディアック"es"): effect.target 指定時は、
    // 選択した1枚だけへ preventStandOnce を立てる（「相手の場のモンスター1枚を選び、そのカードは次の相手の
    // スタートフェイズでスタンドしない」）。target 未指定は従来どおり指定プレイヤーの場の filter 一致 全カードへ
    // 適用（0042 甲蠍 堅牢砦・X-CP02/0070 グラビトン・ジェネレーター＝全体形。既存カードは effect.target 非保持
    // ＝この分岐へ入らず挙動不変）。裁定: 「次の相手のスタートフェイズ」は preventStandOnce（次スタートフェイズで
    // 消費）で表現する。cannotStandThisTurn は clearTurnModifiers で当ターン終了時に消えて次スタートフェイズまで
    // 残らないため用いない（D-CBT/0007 が preventStandThisTurn を誤用していた恒久不発バグをここで是正）。
    if (effect.target) {
      if (target?.card) {
        target.card.preventStandOnce = true;
        addLog(`${context.card?.name || "効果"}の効果で、次のスタートフェイズに${target.card.name}は【スタンド】できません。`);
      }
    } else {
      const seat = effect.player === "opponent" ? 1 - context.owner : context.owner;
      zones.forEach((zone) => {
        const card = state.players[seat]?.field?.[zone];
        if (card && matchesCardFilter(card, effect.filter || {})) {
          card.preventStandOnce = true;
        }
      });
      addLog(`${context.card?.name || "効果"}の効果で、次の${state.players[seat].name}のスタートフェイズに対象は【スタンド】できません。`);
    }
  }
  if (effect.op === "suppressLifeLinkThisTurn") {
    // そのターン中、指定コントローラーの場のカードのライフリンクを無効化（護竜王アミュレイ 0063）。
    const seat = effect.controller === "opponent" ? 1 - context.owner : context.owner;
    state.suppressLifeLinkThisTurn ||= [false, false];
    state.suppressLifeLinkThisTurn[seat] = true;
    addLog(`${context.card?.name || "効果"}の効果で、このターン${state.players[seat].name}の場の『ライフリンク』は無効化されます。`);
  }
  if (effect.op === "preventOpponentCounterThisTurn") {
    // そのターン中、effect.conditions を満たすバトル中は、発動者の相手は【対抗】を使えない（0053）。
    // メイン魔法で貼り、後で連携攻撃等が起きた時に効くターンスコープのロック。
    state.opponentCounterLockThisTurn ||= [];
    state.opponentCounterLockThisTurn.push({ owner: context.owner, while: effect.conditions || [] });
    addLog(`${context.card?.name || "効果"}の効果で、このターン相手は指定の状況で【対抗】を使えません。`);
  }
  if (effect.op === "eachPlayerMayDiscardElseDamage") {
    // 「お互いは手札N枚を捨ててよい。捨てなかったファイターにダメージD」（喧嘩両成敗 0095）。
    // 能動側→相手の順に、手札があれば任意でN枚捨てさせ、捨てなかった側にDダメージ。
    const n = effect.amount || 1;
    const dmg = effect.damage || 2;
    for (const seatOffset of [0, 1]) {
      const seat = seatOffset === 0 ? context.owner : 1 - context.owner;
      const p = state.players[seat];
      const canDiscard = p.hand.filter((c) => c.instanceId !== context.card?.instanceId).length >= n;
      let discarded = false;
      if (canDiscard && (await confirmChoiceAsync(seat, `手札${n}枚を捨てますか？（捨てないと${dmg}ダメージ）`, { purpose: "discard-or-damage" }))) {
        const handEntries = p.hand
          .map((card, index) => ({ card, index }))
          .filter((entry) => entry.card.instanceId !== context.card?.instanceId);
        const chosen = await chooseCardEntries(handEntries, {
          title: context.card?.name || "喧嘩両成敗",
          lead: `捨てる手札${n}枚を選んでください。`,
          min: n,
          max: n,
          forceDialog: true,
          promptSeat: seat,
        });
        const toDrop = chosen && chosen.length >= n ? chosen : handEntries.slice(0, n);
        const removed = removePileEntries(p.hand, toDrop);
        discardHandCardsToDrop(p, removed, makeEffectCause(context, seat)); // E6
        addLog(`${p.name}は手札${removed.length}枚を捨てました。`);
        discarded = true;
      }
      if (!discarded) {
        applyDamageToPlayer(seat, dmg, { sourceName: context.card?.name, byEffect: true, sourceCard: context.card, sourceOwner: context.owner });
        addLog(`${p.name}は捨てなかったため${dmg}ダメージ。`);
      }
    }
  }
  if (effect.op === "nullifyAttack" && state.pendingAttack) {
    context.lastEffectResult = nullifyPendingAttack(context.card?.name || "効果", context.card);
    if (context.lastEffectResult) {
      // 相手の効果で自軍の攻撃が無効化された時の誘発（爆雷 ヤミゲドウ 0109/0110）を発火する。
      await fireAllyAttackNullifiedTriggers();
    }
  }
  if (effect.op === "markPendingAttackUnstoppable" && state.pendingAttack) {
    // 「この攻撃は無効化されず、そのダメージは減らない」(ドラム・ザ・フューチャー)。
    // onlyNullify:true は「無効化されない」のみ（ダメージ減少耐性は付けない。例: ジウン0002）。
    state.pendingAttack.cannotBeNullified = true;
    if (!effect.onlyNullify) {
      state.pendingAttack.damageCannotBeReduced = true;
    }
    addLog(
      effect.onlyNullify
        ? `${context.card?.name || "効果"}の効果でこの攻撃は無効化されない。`
        : `${context.card?.name || "効果"}の効果でこの攻撃は無効化されず、ダメージも減らない。`,
    );
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
  if (effect.op === "redirectPendingAttackToFighter" && state.pendingAttack) {
    // 進行中の攻撃の対象を、この能力のコントローラー本体(ファイター)へ変更する。
    state.pendingAttack.targetOwner = context.owner;
    state.pendingAttack.targetZone = null;
    state.pendingAttack.targetType = "fighter";
    addLog(`${context.card?.name || "効果"}の効果で攻撃対象を${player.name}本体に変更しました。`);
  }
  if (effect.op === "redirectPendingAttackToTarget" && state.pendingAttack) {
    // 進行中の攻撃の対象を、解決済み $target（自分の場のモンスター等）へその場で変更（馬鹿囃子 0089）。
    const ref = resolveEffectReference(effect.target, context);
    const targetCard = ref?.card;
    const slot = targetCard ? findFieldCardSlot(targetCard) : ref?.zone != null ? { owner: ref.owner, zone: ref.zone } : null;
    if (slot) {
      state.pendingAttack.targetOwner = slot.owner;
      state.pendingAttack.targetZone = slot.zone;
      const card = targetCard || state.players[slot.owner]?.field?.[slot.zone];
      state.pendingAttack.targetType = card && effectiveCardType(card) === "monster" ? "monster" : "fieldCard";
      addLog(`${context.card?.name || "効果"}の効果で攻撃対象を${card?.name || "対象"}に変更しました。`);
    }
  }
  if (effect.op === "redirectPendingAttackToSelected" && state.pendingAttack) {
    // Z12(b)(S-UB-C03/0074): redirectPendingAttackToSelf(自分自身へ)の選択カード版。
    // var で選んだ場のカードへ進行中の攻撃対象を変更する（redirectPendingAttackToTargetと同型）。
    const selected = scriptSelection({ var: effect.var }, context)[0]?.card;
    const slot = selected ? findFieldCardSlot(selected) : null;
    if (slot) {
      state.pendingAttack.targetOwner = slot.owner;
      state.pendingAttack.targetZone = slot.zone;
      state.pendingAttack.targetType = effectiveCardType(selected) === "monster" ? "monster" : "fieldCard";
      addLog(`${context.card?.name || "効果"}の効果で攻撃対象を${selected.name}に変更しました。`);
    }
  }
  if (effect.op === "putTopDeckToGaugeEqualToLastDamage") {
    state.lastDamageTaken ||= [0, 0];
    const idx = state.players.indexOf(player);
    // reference:"dealt" は「君が相手に与えたダメージ」(=相手が受けたダメージ)を参照する（0034）。
    // 既定は「君が受けたダメージ」（0026）。
    const refIdx = effect.reference === "dealt" ? 1 - idx : idx;
    const amount = state.lastDamageTaken[refIdx] || 0;
    if (amount > 0) {
      const before = player.gauge.length;
      moveTopDeckToGauge(player, amount);
      const moved = player.gauge.length - before;
      addLog(`${player.name}は${context.card.name}の効果でデッキの上から${moved}枚をゲージに置きました。`);
      // 「与えたダメージ」参照(dealt)は相手の被ダメージスロットを覗くだけでクリアしない。
      // クリアすると、同一ダメージを参照する相手の「受けたダメージ分」効果(0026)を潰してしまうため。
      if (effect.reference !== "dealt") {
        state.lastDamageTaken[refIdx] = 0;
      }
    }
  }
  if (effect.op === "destroyTargetLteSourceStat") {
    // X5(D-BT01/0123): 発生源カードの stat 以下の同 stat を持つモンスター1枚を選んで破壊する
    // （「このカードの打撃力以下の打撃力を持つモンスター1枚を破壊する」。controller 既定 "any"=両者の場）。
    const stat = effect.stat || "critical";
    const threshold = visibleFieldStat(context.card, stat);
    const candidates = allFieldTargets((fieldCard, fieldOwner) => {
      if (effect.controller === "opponent" && fieldOwner === context.owner) return false;
      if (effect.controller === "self" && fieldOwner !== context.owner) return false;
      if (effectiveCardType(fieldCard) !== "monster") return false;
      if (effect.filter && !matchesCardFilter(fieldCard, effect.filter)) return false;
      return visibleFieldStat(fieldCard, stat) <= threshold;
    });
    if (candidates.length === 0) {
      addLog(`${context.card.name}の効果で破壊できるモンスターがいません。`);
      return;
    }
    const picked = await chooseCardEntries(candidates, {
      title: `${context.card.name}で破壊するモンスター`,
      lead: `破壊するモンスターを1枚選んでください。`,
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: context.owner,
      purpose: "hostile",
    });
    const chosen = picked?.[0];
    if (chosen) {
      await destroyFieldCard(chosen.owner, chosen.zone, { cause: makeEffectCause(context, chosen.owner) });
    }
    return;
  }
  if (effect.op === "destroyTargetLteFieldCardStat") {
    // E-Y4(X-BT01/0007 プリズム・アイ): 「君のセンターのモンスターの防御力以下の攻撃力を持つ、相手の場の
    // モンスター1枚を破壊」。しきい値は destroyTargetLteSourceStat（発生源自身の同一 stat）と違い、別の場カード
    // （effect.source={controller,zone,stat}）の visible stat を既存 resolveAmountFrom の fieldCardStat 源
    // （E8/D-BT03/0031 ケルベロスで実績）で確定する。破壊対象の判定 stat は effect.targetStat（既定 power）。
    // 単体 target 選択（chooseCardEntries）で 1 枚破壊。センター不在等で source が取れない時は threshold=0 →
    // 通常 stat>0 のモンスターは候補0＝実質不発（原文どおり「センターのモンスター」が要る）。
    const targetStat = effect.targetStat || "power";
    const threshold = resolveAmountFrom({ source: "fieldCardStat", ...(effect.source || {}) }, context);
    const candidates = allFieldTargets((fieldCard, fieldOwner) => {
      if (effect.controller === "opponent" && fieldOwner === context.owner) return false;
      if (effect.controller === "self" && fieldOwner !== context.owner) return false;
      if (effectiveCardType(fieldCard) !== "monster") return false;
      if (effect.filter && !matchesCardFilter(fieldCard, effect.filter)) return false;
      return visibleFieldStat(fieldCard, targetStat) <= threshold;
    });
    if (candidates.length === 0) {
      addLog(`${context.card.name}の効果で破壊できるモンスターがいません。`);
      return;
    }
    const picked = await chooseCardEntries(candidates, {
      title: `${context.card.name}で破壊するモンスター`,
      lead: `破壊するモンスターを1枚選んでください。`,
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: context.owner,
      purpose: "hostile",
    });
    const chosen = picked?.[0];
    if (chosen) {
      await destroyFieldCard(chosen.owner, chosen.zone, { cause: makeEffectCause(context, chosen.owner) });
    }
    return;
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
        promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
        purpose: "hostile",
      },
    );
    if (selected?.[0]) {
      // 効果破壊として発生源(sourceOwner)を伝播（「君のカードで破壊された時」0030・破壊耐性判定と整合）。
      await destroyFieldCard(selected[0].owner, selected[0].zone, { cause: makeEffectCause(context, selected[0].owner) });
      addLog(`${context.card.name}の効果で${selected[0].card.name}を破壊しました。`);
    }
  }
  if (effect.op === "moveTargetToZone" && target?.card) {
    const ownerPlayer = state.players[target.owner];
    const destination = effect.zone;
    // E-XB34(鏡面峡谷): 相手効果による別エリア移動を防ぐ（自分の『移動』は cause.byOpponent=false で素通り）。
    if (cardProtectedFrom(target.card, "moveArea", makeEffectCause(context, target.owner))) {
      addLog(`${target.card.name}は効果で別のエリアに置かれません。`);
      return;
    }
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
  if (effect.op === "scheduleZoneMoveAtTurnEnd") {
    // 「ターン終了時、君のゲージ全てをドロップゾーンに置く」等のプレイヤー単位ゾーン一括移動の予約
    // （H-PP01/0060 デッドリー・ブースト）。消費は clearTurnModifiers。
    state.turnEndZoneMoves ||= [];
    state.turnEndZoneMoves.push({
      owner: effect.player === "opponent" ? 1 - context.owner : context.owner,
      from: effect.from || "gauge",
      to: effect.to || "drop",
      sourceName: context.card?.name || "効果",
    });
  }
  if (effect.op === "relocateFieldMonstersToDistinctZones") {
    // 「相手の場のモンスター全てを、別々の空いたエリアに動かす」（H-BT04/0038 DEATH死揮棒）。
    // 全員を一旦退避してから、効果の使用者が1体ずつ再配置先を選ぶ（重複なし。元のゾーンにも置ける）。
    const relocOwner = effect.controller === "self" ? context.owner : 1 - context.owner;
    const relocPlayer = state.players[relocOwner];
    // E-XB34(鏡面峡谷): 「別のエリアに置かれない」対象は再配置から除外（元エリアに残す）。相手モンスターを動かす
    // 用途（H-BT04/0038 等）で cause.byOpponent=true のときのみ効く（自陣移動は素通り）。
    const relocCause = makeEffectCause(context, relocOwner);
    const detached = [];
    fieldZones.forEach((zone) => {
      const fieldCard = relocPlayer.field[zone];
      if (fieldCard && effectiveCardType(fieldCard) === "monster" && matchesCardFilter(fieldCard, effect.filter || {})) {
        if (cardProtectedFrom(fieldCard, "moveArea", relocCause)) {
          addLog(`${fieldCard.name}は効果で別のエリアに置かれません。`);
          return;
        }
        relocPlayer.field[zone] = null;
        detached.push(fieldCard);
      }
    });
    const usedZones = new Set();
    for (const movedCard of detached) {
      const choices = fieldZones
        .filter((zone) => !usedZones.has(zone) && !relocPlayer.field[zone])
        .map((zone) => ({ zone, card: movedCard, note: zoneLabel(zone) }));
      let zone = choices[0]?.zone;
      if (choices.length > 1) {
        const selected = await chooseCardEntries(choices, {
          title: `${context.card?.name || "効果"}の再配置`,
          lead: `${movedCard.name}を動かすエリアを選んでください。`,
          min: 1,
          max: 1,
          forceDialog: true,
          promptSeat: context.owner,
          purpose: "move",
        });
        zone = selected?.[0]?.zone ?? zone;
      }
      if (zone) {
        relocPlayer.field[zone] = movedCard;
        usedZones.add(zone);
        addLog(`${movedCard.name}を${zoneLabel(zone)}に動かしました。`);
      } else {
        relocPlayer.drop.push(movedCard); // 置き場が無い異常系（通常発生しない）
      }
    }
  }
  if (effect.op === "treatAsBuddyThisTurn") {
    // 「そのターン中、（filterの）モンスター全てはバディモンスターとして扱う」（H-BT04/0016）。
    // sourceIsBuddy 条件（src/13）が turnTreatAsBuddy を参照する。クリアは clearTurnModifiers。
    const buddyOwner = effect.controller === "opponent" ? 1 - context.owner : context.owner;
    const buddyPlayer = state.players[buddyOwner];
    zones.forEach((zone) => {
      const fieldCard = buddyPlayer.field[zone];
      if (fieldCard && matchesCardFilter(fieldCard, effect.filter || {})) {
        fieldCard.turnTreatAsBuddy = true;
      }
    });
  }
  if (effect.op === "moveTargetToEmptyZone" && target?.card) {
    const ownerPlayer = state.players[target.owner];
    // E-XB34(鏡面峡谷): 相手効果による別エリア移動を防ぐ。
    if (cardProtectedFrom(target.card, "moveArea", makeEffectCause(context, target.owner))) {
      addLog(`${target.card.name}は効果で別のエリアに置かれません。`);
      return;
    }
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
          promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
          purpose: "move",
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
    let fromZone; // enteredSoul 誘発の fromZones 判定用に、実際の取り出し元を記録する。
    if (sourceSlot) {
      movedCard = detachFieldCardForMove(sourceSlot.owner, sourceSlot.zone, context.card);
      fromZone = "field";
    } else {
      // 手札からの起動（「手札のこのカードを…ソウルに入れる」）に対応: 手札から取り除いてから移す。
      const handCards = state.players[context.owner]?.hand;
      const handIndex = handCards?.findIndex((c) => c.instanceId === context.card.instanceId);
      if (handIndex !== undefined && handIndex >= 0) {
        movedCard = handCards.splice(handIndex, 1)[0];
        fromZone = "hand";
      } else {
        // ドロップからの起動（「ドロップのこのカードを…ソウルに入れる」H-EB04/0005）にも対応。
        const dropCards = state.players[context.owner]?.drop;
        const dropIndex = dropCards?.findIndex((c) => c.instanceId === context.card.instanceId);
        if (dropIndex !== undefined && dropIndex >= 0) {
          movedCard = dropCards.splice(dropIndex, 1)[0];
          fromZone = "drop";
        } else {
          movedCard = context.card;
          fromZone = "hand"; // どこにも見つからない時の従来既定（手札起動扱い）
        }
      }
    }
    if (!movedCard) {
      return;
    }
    // レビュー修正(D-BT01/0063): メインフェイズ魔法の解決中は action.card 保持のため、cardMoved を
    // 立てないと解決後にドロップへも積まれて二重存在になる（returnSelfToHand と同型）。
    if (movedCard.instanceId === context.card?.instanceId) {
      context.cardMoved = true;
    }
    putCardsToSoulWithTrigger(target.card, context.owner, [movedCard], fromZone, {
      faceDown: Boolean(effect.faceDown), // E-Y1(奇襲): 「裏向きで」
    });
    context.cardMoved = true;
    // 自身の移動は表向きが通常だが、faceDown 指定時は名前を伏せる（秘匿）。
    addLog(
      effect.faceDown
        ? `1枚を裏向きで${target.card.name}のソウルに入れました。`
        : `${context.card.name}を${target.card.name}のソウルに入れました。`,
    );
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
  if (effect.op === "scheduleOpponentTurnSkip") {
    // E-XB28(X-BT03/0102 逆天③): 「次の相手のターン開始時、そのターンを終了する。次の君のターン中、君の場の
    // カードは攻撃できない」。相手席へターンスキップを予約する（消費は endTurn の新ターン設定点）。schedulerSeat に
    // 使用者席を記録し、スキップ消費時にその席の次ターンへ攻撃禁止を予約する（攻撃禁止の適用は使用者のターン開始時）。
    const opponentSeat = 1 - context.owner;
    state.scheduledTurnSkip ||= [null, null];
    state.scheduledTurnSkip[opponentSeat] = { schedulerSeat: context.owner };
    addLog(`次の${state.players[opponentSeat].name}のターンは開始時に終了します。`);
  }
  if (effect.op === "scheduleLossAtNextOwnTurnEnd") {
    // E-XB32(X-BT04/0002 世界を繋ぐ壱の鍵 ドラゴウーノ): 「次の君のターン終了時、君はファイトに敗北する」。
    // 相手ターン中の【対抗】で使う想定＝発生源席(context.owner)は非アクティブ。席別ワンショットを積み、消費は
    // finishAndAdvanceTurn の maybeApplyScheduledLoss（自ターン終了時。sinceTurnCount より真に後のターン）。
    // controller:"opponent" 指定時は相手席へ（原文には無いが対称拡張。既定は自席）。
    const seat = effect.controller === "opponent" ? 1 - context.owner : context.owner;
    state.scheduledLoss ||= [null, null];
    state.scheduledLoss[seat] = { sinceTurnCount: state.turnCount };
    addLog(`${state.players[seat]?.name}は次の自分のターン終了時にファイトに敗北します。`);
  }
  if (["cancelRecentLifeLink", "cancelLifeLink"].includes(effect.op)) {
    // E5'(D-EB03/0043): matchVar（script var）/matchInstanceId で「直前に手札へ戻した/離場したそのカード」の
    // イベントに限定して取消せる（一致イベントが無ければ no-op＝LL非持ちを戻した時に無関係な同ターン
    // イベントを誤取消しない）。無指定は従来どおり直近イベント＝後方互換。
    let spec = effect;
    if (effect.matchVar || effect.matchInstanceId) {
      const matchIds = [
        ...(effect.matchVar ? scriptSelection({ var: effect.matchVar }, context).map((entry) => entry.card?.instanceId) : []),
        ...(effect.matchInstanceId ? [effect.matchInstanceId] : []),
      ].filter(Boolean);
      spec = { ...effect, matchInstanceIds: matchIds };
    }
    cancelRecentLifeLink(context.owner, spec, context.card?.name);
  }
  if (effect.op === "cancelCallOpportunityLifeLink") {
    cancelCallOpportunityLifeLink(context.owner, effect, context.card?.name);
  }
  if (effect.op === "reduceNextDamage") {
    addNextDamagePrevention(context.owner, {
      amount: effect.amount || 1,
      // 「N以上のダメージを受ける時」限定の軽減（PP01/0026）。未指定なら全ダメージ対象。
      threshold: effect.threshold,
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
  if (effect.op === "preventAllDamageThisTurn") {
    // 「そのターン中、君はダメージを受けない」（四角炎王 バーンノヴァ H-BT03/0006 の救援）。
    // once:false + preventAll で持続。untilTurnOwner=state.active（発動＝相手ターン）なので、その相手ターン終了で失効。
    addNextDamagePrevention(context.owner, {
      preventAll: true,
      once: false,
      source: context.card?.name,
      sourceCard: context.card,
    });
    addLog(`${context.card?.name || "効果"}により、このターン中${state.players[context.owner].name}はダメージを受けません。`);
  }
  if (effect.op === "setPreventNextDestroy" && target?.card) {
    target.card.preventNextDestroyCount = (target.card.preventNextDestroyCount || 0) + (effect.amount || 1);
    // E2(D-BT02/0110): mode:"returnToHand" で破壊置換の着地先を「場に残す」→「手札へ戻す」に変える。
    // 既定(mode 未指定)は従来どおり場に残す＝完全後方互換。消費側(src/11)が returnToHand を見て委譲先を切替。
    const returnToHand = effect.mode === "returnToHand";
    if (effect.gainLife || effect.log || effect.countsAsDestroyed || effect.grantKeyword || effect.effects || returnToHand) {
      target.card.preventNextDestroyEffects ||= [];
      target.card.preventNextDestroyEffects.push({
        owner: context.owner,
        gainLife: effect.gainLife || 0,
        source: context.card?.name || "",
        log: effect.log || "",
        countsAsDestroyed: Boolean(effect.countsAsDestroyed),
        grantKeyword: effect.grantKeyword || null,
        // effects: 場に残った/手札へ戻った時に追加で解決する効果群（H-EB04/0052・D-BT02/0110 等）。
        // 破壊解決の消費側(src/11)で destroyReaction と同形の microtask で実行する（再入を避けるため）。
        effects: Array.isArray(effect.effects) ? effect.effects : null,
        returnToHand,
      });
    }
    addLog(
      returnToHand
        ? `${context.card.name}の効果で、次に${target.card.name}が破壊される場合、手札に戻せるようにしました。`
        : `${context.card.name}の効果で、次に${target.card.name}が破壊される場合、場に残せるようにしました。`,
    );
  }
  if (effect.op === "grantTurnDestroyImmunity") {
    // 【対抗】このターン中、指定ゾーンのモンスターは破壊されない（ドラゴニック・フォースフィールド）。
    // state.turnDestroyImmunity に登録し、destroyImmunityBlocks が参照。ターン進行時にリセット。
    state.turnDestroyImmunity ||= [];
    const immunityOwner = effect.controller === "opponent" ? 1 - context.owner : context.owner;
    state.turnDestroyImmunity.push({
      owner: immunityOwner,
      zoneIn: effect.zoneIn || null,
      filter: effect.filter || null,
    });
    addLog(`${context.card?.name || "効果"}の効果で、このターン中に対象のモンスターは破壊されなくなりました。`);
  }
  if (effect.op === "grantTurnProtection") {
    // Z4(e)(S-UB-C03/0043): 【対抗】等でそのターン(turns:1、既定)または複数ターン(turns:2等)限定の
    // レスト/能力無効化/手札戻し耐性を付与する。scope:"both"は entry.scope を undefined にすることで
    // turnProtectionBlocks（05-stats.js）のowner一致判定をスキップし両者対象にする。
    // state.turnProtections はターン終了(clearTurnModifiers)の都度 remainingTurnEnds を1減算し、
    // 0で除去する（turns:2 = ターン終了2回分＝そのターン＋次のターン中）。
    state.turnProtections ||= [];
    const protectionEntry = {
      kinds: effect.kinds || [],
      owner: context.owner,
      scope: effect.scope === "both" ? undefined : effect.scope || "self",
      zoneIn: effect.zoneIn || null,
      filter: effect.filter || null,
      remainingTurnEnds: effect.turns || 1,
    };
    // E-XB51①(X-CBT01/0073 覇王紅蓮雷波): statDecrease(相手効果によるステ減少無視)保護。effect.stats で
    // 対象 stat を限定（例 ["critical"]＝打撃力のみ「減らず」）。既定（stats 無し）は全stat保護＝後方互換。
    if (effect.stats) protectionEntry.stats = effect.stats;
    // effect.selected: filter/scope の広域一致ではなく「選んだ1枚」だけを束縛する。context.vars[effect.var]
    //（selectCards の選択）または context.target を instanceIds に写す。既存2カードは selected 未指定＝挙動不変。
    if (effect.selected) {
      const sel = effect.var ? context.vars?.[effect.var] : null;
      const entries = Array.isArray(sel) ? sel : sel ? [sel] : context.target ? [context.target] : [];
      protectionEntry.instanceIds = entries.map((e) => e.card?.instanceId).filter(Boolean);
    }
    state.turnProtections.push(protectionEntry);
    addLog(`${context.card?.name || "効果"}の効果で保護を付与しました。`);
  }
  if (effect.op === "grantTurnDamageReduction") {
    // Z4(f)(S-UB-C03/0051): そのターン中、受けるダメージを毎回N減らす(damageReceivedReductionForが参照。
    // 04-cost-resource.js)。既存の継続 damageReceivedReduction（場のカード発）とは独立レイヤ。
    state.turnDamageReductions ||= [];
    const reductionOwner = effect.scope === "opponent" ? 1 - context.owner : context.owner;
    state.turnDamageReductions.push({ owner: reductionOwner, amount: effect.amount || 0 });
    addLog(`${context.card?.name || "効果"}の効果で、そのターン中に受けるダメージが${effect.amount || 0}減るようになりました。`);
  }
  if (effect.op === "setPreventNextLeaveField" && target?.card) {
    // Z9(S-UB-C03/0072): 次に場から離れる(受動的な破壊/手札戻し等)場合、そのカードを場に残す。
    // preventNextDestroyCountと異なりターン限定でない（clearTurnModifiersでは消さない・恒久カウンタ）。
    // 自発の移動(equipSelf等)は対象外＝消費フック側(11/08/15)で受動的離場のみ消費する。
    target.card.preventNextLeaveFieldCount = (target.card.preventNextLeaveFieldCount || 0) + (effect.amount || 1);
    addLog(`${context.card?.name || "効果"}の効果で、次に${target.card.name}が場から離れる場合、場に残せるようにしました。`);
  }
  if (effect.op === "preventStandThisTurn" && target?.card) {
    // Z14(g)(S-UB-C03/0038): そのターン中、指定カードはスタンドできない。clearTurnModifiersでクリア。
    // 既存 preventStandNextTurn(15:1173付近)とは別物・そちらは使わない（0038は「そのターン中」限定）。
    target.card.cannotStandThisTurn = true;
    addLog(`${context.card?.name || "効果"}の効果で、${target.card.name}はそのターン中スタンドできなくなりました。`);
  }
  if (effect.op === "endFinalPhase") {
    // Z6(S-UB-C03/0054): ファイナルフェイズを終了しターンを終える。必殺技はファイナルフェイズでのみ
    // 使用できる(08-card-use.js useCardAction)ため呼び出し時点で state.phase は既に"final"。
    // endTurn()を直接ここで呼ぶと、呼び出し元(useHandAbilityAction等)の後続処理がターン交代後の
    // stateを前提外に触ってしまう恐れがあるため、useCardActionの解決アンワインド完了地点
    // （08-card-use.js末尾）まで実行を遅延させるフラグだけを立てる。
    state.pendingEndTurn = true;
  }
  if (effect.op === "endCurrentTurn") {
    // E-XB42/R21(X-BT04/0099 Cの超越者 ギアゴッド ver.Ø99 逆天殺 後段): 「このターンを終了する」。任意フェイズ・
    // 任意席（0099 は相手ターン中の counter/main 起動）から現在のターン(state.active)を即終了する。ここで endTurn()
    // を直接呼ぶと、解決チェーンの再入や pendingResolution 破綻（呼び出し元がターン交代後の state を前提外に触る）の
    // 恐れがあるため、endFinalPhase(pendingEndTurn) と同型の予約フラグだけを立て、maybeEndPendingCurrentTurn(src/11)
    // が「解決アンワインドが完了した地点」で finishAndAdvanceTurn を1回だけ呼ぶ。endFinalPhase と違い final フェイズ
    // 入口ガード(endTurn)を通さず finishAndAdvanceTurn へ直行するので、相手ターン中でも「そのターン」を終えられる。
    // E-XB28 scheduledTurnSkip は「次に来るターンを開始時に飛ばす」別機構＝こちらは「今のターンを終える」。
    state.pendingCurrentTurnEnd = true;
    addLog(`${context.card?.name || "効果"}の効果で、このターンを終了します。`);
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
    const turnEndOwnerFor = (victimOwner) => {
      if (effect.when === "ownTurnEnd") return context.owner;
      if (effect.when === "opponentTurnEnd") return 1 - context.owner;
      return victimOwner;
    };
    if (effect.target === "$attackers") {
      // 連携攻撃で攻撃してきた全モンスターを対象にする（デスカース 0026: 「攻撃したモンスター」複数対応）。
      // rules は「攻撃したモンスター」なので、武器(アイテム)等の非モンスター攻撃者は除外する。
      const attackers = context.attackers?.length ? context.attackers : getPendingAttackers();
      (attackers || []).forEach((entry) => {
        if (entry?.card && effectiveCardType(entry.card) === "monster") {
          entry.card.destroyAtEndOfTurnOwner = turnEndOwnerFor(entry.owner);
        }
      });
    } else {
      const victim = effect.target
        ? resolveEffectReference(effect.target, context)
        : context.card
          ? { card: context.card, owner: context.owner }
          : null;
      if (victim?.card) {
        victim.card.destroyAtEndOfTurnOwner = turnEndOwnerFor(victim.owner);
      }
    }
  }
  if (effect.op === "shuffleDropIntoDeck") {
    // レビュー修正(D-BT01/0035): 対抗タイミングの即時解決では使用中のカード自身が既にドロップにあるため、
    // 自身を巻き込んでデッキに消えないよう除外する（公式は解決完了後にドロップへ置かれ、ドロップに残る）。
    const movedCards = [];
    for (let index = player.drop.length - 1; index >= 0; index -= 1) {
      if (player.drop[index].instanceId !== context.card?.instanceId) {
        movedCards.push(player.drop.splice(index, 1)[0]);
      }
    }
    player.deck.push(...movedCards);
    shuffleInPlace(player.deck);
    addLog(`${player.name}はドロップゾーンのカードをデッキに戻してシャッフルしました。`);
  }
  if (effect.op === "takeExtraTurnAfterThis") {
    state.extraTurnOwner = context.owner;
    addLog(`${player.name}はこのターンの後に追加ターンを得ます。`);
  }
  if (effect.op === "resetBoardToDeckAndRefill") {
    // E-XB36(X-BT04/0103 逆天の氷王 ミセリア): 「場のカードの能力全てを無効化し、このカード以外の、お互いの、手札、
    // ゲージ、ドロップゾーン、場のカード全てを持ち主のデッキに戻し、そのデッキをシャッフルする！その後、お互いは、
    // カード6枚を引き、デッキの上から2枚をゲージに置く！！」。
    // 「能力全てを無効化」は、トリガー/離場置換/ライフリンクを一切発火させない“生の移動”でモデル化する（バリア等で
    // 残らず・誘発が連鎖せず盤面が確実にリセットされる）。発生源（このカード）とそのソウルは場に残す。フラッグ/バディ
    // ゾーン裏面パイルは「場のカード」に含めない（原文どおり据え置き）。設置/アイテムは zones 走査に含まれるため戻る。
    // 保存則: 各席の {手札+ゲージ+ドロップ+場(発生源除く)+それらのソウル} をデッキへ→シャッフル(rng は state 常駐で
    // 決定的)→6引き→上2枚ゲージ。survivor 以外は全て回収するので instanceId/枚数は保存される。
    const survivorId = context.card?.instanceId;
    const drawCount = effect.drawCount ?? 6;
    const gaugeCount = effect.gaugeCount ?? 2;
    state.players.forEach((resetPlayer) => {
      const toDeck = [];
      const collect = (movedCard) => {
        if (!movedCard) {
          return;
        }
        // デッキへ戻る際は変身/搭乗等の一時的な型上書きを解除する（returnSelfToDeckBottom と同方針）。
        movedCard.currentType = movedCard.baseType || movedCard.type;
        toDeck.push(movedCard);
      };
      resetPlayer.hand.splice(0).forEach(collect);
      resetPlayer.gauge.splice(0).forEach(collect);
      resetPlayer.drop.splice(0).forEach(collect);
      zones.forEach((zone) => {
        const fieldCard = resetPlayer.field[zone];
        if (!fieldCard || fieldCard.instanceId === survivorId) {
          return; // 発生源（ミセリア）は場に残す。
        }
        resetPlayer.field[zone] = null;
        (fieldCard.soul || []).splice(0).forEach(collect); // 戻すモンスターのソウルも持ち主デッキへ。
        fieldCard.soul = [];
        resetLeftFieldCardState(fieldCard); // used/一時バフ/一時付与/currentType 等を場離脱の規約でクリア。
        collect(fieldCard);
      });
      resetPlayer.arrivalCardId = null; // 着任アイテムは全て戻る＝参照を解除。
      resetPlayer.deck.push(...toDeck);
      shuffleInPlace(resetPlayer.deck); // 決定的シャッフル（rngInt→state.rngSeed/rngCounter）。
    });
    addLog(`${context.card?.name || "効果"}の効果で、お互いの手札・ゲージ・ドロップ・場（このカード以外）をデッキに戻してシャッフルしました。`);
    state.players.forEach((refillPlayer) => {
      drawCards(refillPlayer, drawCount, false); // デッキは満杯なのでデッキ切れは起きない（起きても declareDeckLoss で安全）。
      moveTopDeckToGauge(refillPlayer, gaugeCount);
    });
    addLog(`お互いはカード${drawCount}枚を引き、デッキの上から${gaugeCount}枚をゲージに置きました。`);
  }
  if (effect.op === "winGame") {
    // state.winner はプレイヤー名文字列（checkWinner 等と統一）。席index を入れると席0で falsy になり終局しない。
    state.winner = state.players[context.owner]?.name || null;
    state.winnerSeat = context.owner; // D5(戦績): 効果による即勝利
    state.winReason = "effect";
    addLog(`${player.name}は${context.card.name}の効果で勝利しました。`);
  }
  if (effect.op === "preventLossUntilOpponentTurnStart") {
    // E-XB1(X-BT02/0113 アステリズム・エフェクト): 「次の相手ターンの開始時まで、君はファイトに敗北しない。
    // （ライフが０や、デッキが０枚でもファイトを続ける。）」。席別 state.lossPrevention にエントリを積み、
    // 敗北確定点（checkWinner の life<=0/deck0・declareDeckLoss・applyLifeLink 即死）が isSeatLossPrevented で
    // ゲートする。期限は endTurn の expireLossPreventionForTurnStart が「相手(1-seat)のターン開始時」に除去。
    // sinceTurnCount は付与時の turnCount＝現ターン中は失効せず（判定は turnCount > sinceTurnCount の真に大なり）、
    // 相手ターン中の【対抗】で撃っても現在の相手ターンでは切れず、次の相手ターン開始時に切れる。
    const seat = effect.controller === "opponent" ? 1 - context.owner : context.owner;
    state.lossPrevention ||= [[], []];
    state.lossPrevention[seat] ||= [];
    state.lossPrevention[seat].push({
      untilTurnStartOf: 1 - seat, // 相手のターン開始時に失効
      sinceTurnCount: state.turnCount,
    });
    // 直前の致死（守る当人のライフ0/デッキ0）で既に winner が立っていれば、保護成立でその敗北を巻き戻す。
    // clearWinnerIfNoCurrentLoss は保護席を「現在の敗北」に数えないため、当人由来の暫定 winner のみ解除される。
    clearWinnerIfNoCurrentLoss();
    addLog(
      `${context.card?.name || "効果"}の効果で、${state.players[seat]?.name}は次の相手ターンの開始時までファイトに敗北しなくなりました。`,
    );
  }
}

function resolveEffectReference(reference, context) {
  if (reference === "$target") {
    return context.target;
  }
  if (reference === "$damageSource") {
    // X14(D-BT01/0049): 効果/戦闘ダメージの発生源カード（opponentDamagedByEffect の detail 等が設定）。
    return context.damageSource || null;
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
      promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
    },
  );
  const revealed = selected?.[0]?.card || cards[0];
  const randomPick = cards[rngInt(cards.length)]; // B1: シード乱数（未設定時は Math.random 素通し）
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
        name: `${statKindLabel(stat)} +${amount}`,
        type: "choice",
      },
      note: statKindLabel(stat),
    }));
    const selected = await chooseCardEntries(choices, {
      title: `${context.card.name}の強化先`,
      lead: "強化する能力値を選んでください。",
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
    });
    return selected?.[0]?.stat ? [selected[0].stat] : [];
  }
  if (Array.isArray(effect.stats)) {
    return effect.stats;
  }
  return ["power", "defense", "critical"].filter((stat) => effect[stat]);
}

// ステータス種別名（power/defense/critical）→ 日本語ラベル。
// 値整形の statLabel(value)（src/18-tooltip-format.js）とは別物。
function statKindLabel(stat) {
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
  if (spec.source === "scriptVar") {
    // E2(D-BT03/0063 闘気暴走・0030 オウガ斬魔): payLifeChoose 等が context.vars[var] に格納した
    // スカラー数値を参照する（「払ったライフの数値分」）。per 乗数対応（既定1）。
    // 未設定/非数値は0（安全側・payLifeChoose が0払い時に必ず0を格納するため通常は数値）。
    const value = context.vars?.[spec.var];
    return (typeof value === "number" ? value : 0) * (spec.per ?? 1);
  }
  if (spec.source === "selectedCardStat") {
    // script で選択した var のカードの visible stat（破壊直後のカードの打撃力参照などに使う）。
    const selected = scriptSelection({ var: spec.var }, context)[0]?.card;
    return selected ? visibleFieldStat(selected, spec.stat || "critical") : 0;
  }
  if (spec.source === "selfStat") {
    // X2(D-BT01/0017): 発生源カード自身の visible stat（「このカードの打撃力分、君のライフを回復」等）。
    const self = context.card;
    if (!self) return 0;
    const base = spec.stat === "size" ? self.size || 0 : visibleFieldStat(self, spec.stat || "critical");
    return base * (spec.per ?? 1);
  }
  if (spec.source === "returnedCount") {
    // X2(D-BT01/0013): 直前の returnAllToHand で手札に戻した枚数（「戻した枚数分相手にダメージ」）。
    return (context.returnedCount || 0) * (spec.per ?? 1);
  }
  if (spec.source === "lastDestroyedStatSum") {
    // 直前の destroy(scope) で破壊できたカード群の印字 stat 合計（「破壊した打撃力合計分ダメージ」H-BT04/0068）。
    // 破壊済み＝場を離れているため visible ではなく印字値を使う。
    return (context.lastDestroyedCards || []).reduce((sum, card) => sum + (card?.[spec.stat || "critical"] || 0), 0);
  }
  if (spec.source === "lastDestroyedCount") {
    // E6(D-BT03/0026 ゼルホルス): 直前の destroy(scope)/destroyAll で「実際に破壊できた」枚数
    //（「破壊した枚数分、相手にダメージ」）。破壊耐性・離場置換で破壊を免れた分は数えない
    //（lastDestroyedCards に積まれない＝事前カウント近似との差分そのもの）。filter/per 対応（既定は全数×1）。
    return (
      (context.lastDestroyedCards || []).filter((card) => matchesCardFilter(card, spec.filter || {})).length *
      (spec.per ?? 1)
    );
  }
  if (spec.source === "fieldSoulCountSum") {
    // 自分（controller指定可）の場の全カードのソウル枚数合計（filter でソウル側を絞れる）。
    const soulOwner = ownerOf(spec.controller || "self");
    const soulPlayer = state.players[soulOwner];
    let total = 0;
    zones.forEach((zone) => {
      const fieldCard = soulPlayer?.field?.[zone];
      (fieldCard?.soul || []).forEach((soulCard) => {
        if (matchesCardFilter(soulCard, spec.filter || {})) total += 1;
      });
    });
    return Math.min(total, spec.max ?? total) * (spec.per ?? 1);
  }
  if (spec.source === "targetStat") {
    // 効果の対象($target)のカードの visible stat（破壊する対象のサイズ分ダメージ等）。size も読める。
    // per 乗数対応（S-UB-C03/0082「そのキャラのサイズの数値分、このカードの攻撃力+3000」= size×3000）。
    const tcard = context.target?.card;
    if (!tcard) return 0;
    const base = spec.stat === "size" ? tcard.size || 0 : visibleFieldStat(tcard, spec.stat || "critical");
    return base * (spec.per ?? 1);
  }
  if (spec.source === "damageSourceStat") {
    // ダメージ源(context.damageSource.card)の visible stat（自分がダメージを受けた時、与えてきたカードのサイズ分ダメージ等 0020）。
    // size は印字サイズ（ドロップ後も参照できるよう effectiveSize ではなく card.size を見る）。
    const c = context.damageSource?.card;
    return c ? (spec.stat === "size" ? c.size || 0 : visibleFieldStat(c, spec.stat || "critical")) : 0;
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
  if (spec.source === "itemStatMax") {
    // E-XB19(X-BT03/0096 斬魔闘気“縛”): 指定controller(既定self)の場の全アイテム枠のうち最大の visible stat(既定critical)。
    // 「君の場のアイテムの打撃力以下」= 複数アイテム(itemZones=item/item2..)時は最大値を閾値に（どれか1つのアイテム
    // 以下＝最も許容的な読み）。weaponPowerMax（武器限定・power固定）の一般化で、全アイテム・stat可変・filter可。
    // アイテム不在時は0（＝アイテムの打撃力が無い状態＝実質「打撃力0以下」しか通らない忠実な帰結）。
    const owner = ownerOf(spec.controller || "self");
    const stats = itemZones
      .map((zone) => state.players[owner]?.field?.[zone])
      .filter((card) => card && effectiveCardType(card) === "item" && (!spec.filter || matchesCardFilter(card, spec.filter)))
      .map((card) => visibleFieldStat(card, spec.stat || "critical"));
    return stats.length > 0 ? Math.max(...stats) : 0;
  }
  if (spec.source === "dropCount") {
    const owner = ownerOf(spec.controller);
    const matched = (state.players[owner]?.drop || []).filter((card) => matchesCardFilter(card, spec.filter || {}));
    // E-ZA1(X-SS02/0031 ジェノサイド・パニッシャー): distinct:"distinctByName" は filter 一致カードの
    // 名称ユニーク数（「君のドロップの「煉獄騎士団」を含むカードの種類分」）を返す。条件op cardCount(src/13)の
    // distinct と同ロジック。distinct 未指定は従来どおり総枚数＝完全に後方互換（既存 dropCount は挙動不変）。
    const count = spec.distinct === "distinctByName" ? new Set(matched.map((card) => card.name)).size : matched.length;
    const capped = spec.max !== undefined ? Math.min(count, spec.max) : count;
    return capped * (spec.per ?? 1);
  }
  if (spec.source === "buddyZoneCount") {
    // Z1/Z2(S-UB-C03): 指定controllerのバディゾーン裏向きカード枚数×per（既定は自分。「君のバディゾーンの
    // 裏向きのカードの枚数まで選び」0048/0049等でselectCardsのmaxFromからも同じ経路で使われる）。
    const owner = ownerOf(spec.controller || "self");
    const count = (state.players[owner]?.buddyZoneFaceDown || []).length;
    const capped = spec.max !== undefined ? Math.min(count, spec.max) : count;
    return capped * (spec.per ?? 1);
  }
  if (spec.source === "fieldCardCount") {
    // 指定controllerの場の filter 一致カード枚数×per＋plus（「場の《X》枚数分ダメージ」0032）。
    const owner = ownerOf(spec.controller);
    let count = 0;
    zones.forEach((zone) => {
      const card = state.players[owner]?.field?.[zone];
      // E10(D-BT03/0091): excludeSource=発生源自身を数えない（「このカード以外の…1枚につき」。
      // 条件op cardCount / 継続側 continuousFieldCardStatAmount と同型。未指定は従来どおり＝後方互換）。
      if (spec.excludeSource && card && card.instanceId === context.card?.instanceId) {
        return;
      }
      if (card && matchesTargetFilter(card, owner, zone, spec.filter || {})) {
        count += 1;
      }
    });
    return count * (spec.per ?? 1) + (spec.plus || 0);
  }
  if (spec.source === "selectedCount") {
    // script で選択した var の枚数（「選んだ枚数分」。破壊耐性を無視して選択数を数える）。
    return scriptSelection({ var: spec.var }, context).length * (spec.per ?? 1);
  }
  if (spec.source === "destroyedCount") {
    // script の destroySelected が実際に破壊した var の枚数（破壊耐性で免れた分は除外。0020「破壊した枚数分」）。
    return (context.destroyedCounts?.[spec.var] ?? 0) * (spec.per ?? 1);
  }
  if (spec.source === "dropAbilityLabelCount") {
    // 指定controllerのドロップのカードが持つ、指定label(“爆雷”等)の能力の総数（0020）。
    const owner = ownerOf(spec.controller);
    let total = 0;
    (state.players[owner]?.drop || []).forEach((card) => {
      total += (card.abilities || []).filter((a) => a.label === spec.label).length;
    });
    return total * (spec.per ?? 1);
  }
  if (spec.source === "fieldCardSoulCount") {
    // 指定ゾーン(既定 item)の filter 一致フィールドカードのソウル枚数（搭乗しているカードのソウル分ダメージ 0033）。
    const owner = ownerOf(spec.controller);
    const zone = spec.zone || "item";
    const card = state.players[owner]?.field?.[zone];
    if (!card || !matchesTargetFilter(card, owner, zone, spec.filter || {})) {
      return 0;
    }
    return (card.soul || []).length * (spec.per ?? 1);
  }
  if (spec.source === "itemPowerSum") {
    // 指定側(controller未指定=両者)の場のアイテムの visiblePower 総和×per。
    const owners =
      spec.controller === "self"
        ? [context.owner]
        : spec.controller === "opponent"
          ? [1 - context.owner]
          : [0, 1];
    let total = 0;
    owners.forEach((owner) => {
      equippedItems(state.players[owner]).forEach((card) => {
        if (effectiveCardType(card) === "item") {
          total += visiblePower(card);
        }
      });
    });
    return total * (spec.per ?? 1);
  }
  if (spec.source === "itemCriticalSum") {
    // R-BR20(ブラウザレビュー pp01-B1): 指定側(controller未指定=両者)の場のアイテムの visibleCritical 総和×per。
    // pp01-0009 アーマナイト・リーサルドレイク「打撃力は両者アイテムの“打撃力”合計分増える」用（打撃力=critical）。
    // 旧実装は itemPowerSum(visiblePower)＋applyTo:power で二重に誤っていた。
    const owners =
      spec.controller === "self"
        ? [context.owner]
        : spec.controller === "opponent"
          ? [1 - context.owner]
          : [0, 1];
    let total = 0;
    owners.forEach((owner) => {
      equippedItems(state.players[owner]).forEach((card) => {
        if (effectiveCardType(card) === "item") {
          total += visibleCritical(card);
        }
      });
    });
    return total * (spec.per ?? 1);
  }
  if (spec.source === "milledMatchCount") {
    // G1(D-EB01/0019): 直前の moveTopDeckToDrop で「今回めくって置いた」カード(context.milled)のうち
    // filter に一致する枚数×per（「置いたその中の《髑髏武者》の枚数分ダメージ」）。
    const count = (context.milled || []).filter((card) => matchesCardFilter(card, spec.filter || {})).length;
    return count * (spec.per ?? 1);
  }
  if (spec.source === "attacksThisTurn") {
    // E-XB16(X-BT03/0026 灼熱地獄分岐・0100 轟天雷槍): このターン中に君のカードが攻撃した回数
    //（state.attacksThisTurn＝グローバルの攻撃回数カウンタ。攻撃はターンプレイヤーのみが行うため、
    // 自分の必殺技解決時点では「君のカードが攻撃した回数」と一致する＝条件op attacksThisTurnGte(Z7)と同じ根拠）。
    // ターン開始(startTurn/src/11)で0にリセット・room 復元(JSON往復)後も state 常駐で保たれる。per/max 対応（既定 ×1）。
    // E-XB40(X-BT04/0008 天晶の祝福): controller 指定時は席別カウンタ attacksThisTurnBySeat[席] を読む
    //（"opponent"＝1-owner・"self"＝owner）。0008 は相手ターン中に使う【対抗】＝この時点では
    // state.attacksThisTurn(全体)も相手席カウンタと一致するが、「相手のカードが攻撃した回数」を席で明示して
    // ターンゲートに依存しない正確な値にする（後方互換: controller 未指定は従来どおり全体カウンタ）。
    let count;
    if (spec.controller) {
      const seat = spec.controller === "opponent" ? 1 - context.owner : context.owner;
      count = (state.attacksThisTurnBySeat || [])[seat] || 0;
    } else {
      count = state.attacksThisTurn || 0;
    }
    const capped = spec.max !== undefined ? Math.min(count, spec.max) : count;
    return capped * (spec.per ?? 1);
  }
  if (spec.source === "distinctWorldCount") {
    // E-XB17(X-TD03/0003 超雷星 レイトニング): 指定側(controller・既定self)の指定pile(既定field)の
    // filter 一致カードの「ワールド名の種類数」。cardWorlds() で2ワールド持ちは両ワールドを算入（union）＝
    // 条件op cardCount の distinct:"distinctByWorld"(src/13)と同ロジックの「量」版。pile/filter/max/per 対応。
    const owner = ownerOf(spec.controller || "self");
    const pl = state.players[owner];
    const pile = spec.pile || "field";
    let cards = [];
    if (pile === "field") cards = zones.map((zone) => pl?.field?.[zone]).filter(Boolean);
    else if (pile === "item") cards = equippedItems(pl);
    else if (pile === "center") cards = pl?.field?.center ? [pl.field.center] : [];
    else if (pile === "soul") cards = zones.flatMap((zone) => pl?.field?.[zone]?.soul || []);
    else if (pile === "itemSoul") cards = itemZones.flatMap((zone) => pl?.field?.[zone]?.soul || []); // E-XB46: アイテムゾーンのソウル限定
    else cards = pl?.[pile] || [];
    const matched = cards.filter((card) => matchesCardFilter(card, spec.filter || {}));
    const count = new Set(matched.flatMap((card) => cardWorlds(card))).size;
    const capped = spec.max !== undefined ? Math.min(count, spec.max) : count;
    return capped * (spec.per ?? 1);
  }
  if (spec.source === "sourceSoulWorldCount") {
    // E-XB47(X-CBT01/0038 系「ソウルのワールド名の種類分」): 発生源カード自身のソウルの distinct ワールド種類数を
    // 「量」として返す（sourceSoulWorldCountGte の amountFrom 版）。cardWorlds() で2ワールドは両算入。max/per 対応。
    const source = context.card || getSelectedCard();
    const count = new Set((source?.soul || []).flatMap((card) => cardWorlds(card))).size;
    const capped = spec.max !== undefined ? Math.min(count, spec.max) : count;
    return capped * (spec.per ?? 1);
  }
  if (spec.source === "costDiscardedCount") {
    // E-XB31(X-SS04/0015 ラウドヴォイス): このカードの【使用コスト】で捨てた手札の枚数（「捨てた枚数分」）。
    // E-PR6 の costDiscardedCards（payStructuredCostWithSelection の payment.discarded を宣言→解決の context へ
    // 持ち越したコスト捨て札。条件op costDiscardedCardMatches が同ソースを読む）の「量」版。filter で捨て札を
    // 絞れる（既定は全数）。per 乗数対応（既定1・負値可＝0015 は per:-3000/-1 で「攻撃力-3000・打撃力-1 ×枚数」を
    // modifyStats の applyTo 別に2効果で表現）。捨て0枚（min:0 のコスト等）や未設定 context は0＝安全側。
    const count = (context.costDiscardedCards || []).filter((c) => matchesCardFilter(c, spec.filter || {})).length;
    return count * (spec.per ?? 1);
  }
  if (spec.source === "monstersDestroyedByMeThisTurn") {
    // E-XB70(X2-SP/0044 ランペイジ・ブラスター・レッドヒート！): このターン中に指定側(controller・既定self)の
    // カードが破壊したモンスターの枚数。destroyFieldCard が破壊者席別に累計した state.destroyedByOwnerThisTurn を
    // 参照（ターン境界でリセット）。「＋２」は plus:2（fieldCardCount と同じ plus オフセット慣例）。max/per 対応。
    // controller は破壊“した”側の視点で解く（"self"=自席が破壊した数・"opponent"=相手が破壊した数）。
    const owner = ownerOf(spec.controller || "self");
    const count = (state.destroyedByOwnerThisTurn || [0, 0])[owner] || 0;
    const capped = spec.max !== undefined ? Math.min(count, spec.max) : count;
    return capped * (spec.per ?? 1) + (spec.plus || 0);
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

// Z4(c)(S-UB-C03/0056): cause.byOpponent（対象カードの所有者とは異なる側からの効果）の場合のみ、
// grantStatDecreaseImmunity で保護されたstatの負デルタを0に丸める。自分自身の効果によるデバフは対象外
// （0056は「相手のカードの効果で」限定・自効果は通す）。cause省略時（発生源不明の旧呼び出し）は
// 保護を適用しない（挙動不変・後方互換）。
// Z4(c)(S-UB-C03/0056): 相手発(cause.byOpponent)の負デルタで、grantStatDecreaseImmunity が保護する
// stat のみ0に丸める共通シンク。単体modifyStats(applyModifyStatsDelta)・AoE(modifyStatsAll)・
// 条件付き(modifyStatsIfTarget*)の全ステ変更経路がこれを通すことで「相手のカードの効果で減らない」を
// 一撃op全体に一貫適用する。cause省略/自効果(byOpponent=false)/正デルタは素通し（後方互換）。
function guardStatDelta(targetCard, stat, value, cause) {
  // E-XB51①(X-CBT01/0073): 相手発の負デルタは、恒久 grantStatDecreaseImmunity(statDecreaseProtected)に加え、
  // ターン限定・選択カード束縛の grantTurnProtection{kinds:["statDecrease"]}(turnProtectionBlocks)でもゲートする。
  const blocked =
    cause?.byOpponent &&
    value < 0 &&
    (statDecreaseProtected(targetCard, stat) || turnProtectionBlocks(targetCard, "statDecrease", stat));
  return blocked ? 0 : value;
}

function applyModifyStatsDelta(targetCard, duration, delta, cause = null) {
  const guardedDelta = {
    power: guardStatDelta(targetCard, "power", delta.power, cause),
    defense: guardStatDelta(targetCard, "defense", delta.defense, cause),
    critical: guardStatDelta(targetCard, "critical", delta.critical, cause),
  };
  if (duration === "permanent") {
    targetCard.power = (targetCard.power || 0) + guardedDelta.power;
    targetCard.defense = (targetCard.defense || 0) + guardedDelta.defense;
    targetCard.critical = (targetCard.critical || 0) + guardedDelta.critical;
    return;
  }
  const prefix = duration === "turn" ? "turn" : "battle";
  targetCard[`${prefix}PowerBonus`] += guardedDelta.power;
  targetCard[`${prefix}DefenseBonus`] += guardedDelta.defense;
  targetCard[`${prefix}CriticalBonus`] += guardedDelta.critical;
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

// E-XB61(X2-BT01/0001 完全竜化 竜牙王): fight-limit の count 化。
// `state.fightLimits[owner][key]` は歴史的に boolean（true=このファイト中使用済み）。これを回数記帳へ後方互換で拡張する。
// 読み手は boolean(true) と 数値の双方を「使用回数」として解釈する（既存 state / 進行中部屋 / リプレイ golden との混在互換）:
//   undefined/false → 0回, true → 1回, 数値N → N回。
function fightLimitUseCount(value) {
  if (value === true) return 1;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

// limit.count（fight スコープの許容使用回数）。未指定/不正は 1（＝既存全カードと同一挙動）。
function normalizedFightLimitMax(limit) {
  const n = Number(limit && limit.count);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return 1;
}

function isAbilityLimitUsed(owner, card, ability) {
  const limit = normalizedAbilityLimit(ability);
  if (!limit) {
    return false;
  }
  const key = abilityLimitKey(card, ability, limit);
  if (limit.scope === "fight") {
    // count 未指定は max=1 ＝ 0回なら未使用/1回以上で使用済み（従来の Boolean 判定と完全一致）。
    // count:N は N 回まで許可（N回目までは false＝使用可、N回到達で true＝ブロック）。
    return fightLimitUseCount(state.fightLimits?.[owner]?.[key]) >= normalizedFightLimitMax(limit);
  }
  if (limit.scope === "turn") {
    return Boolean(state.players[owner].oncePerTurn[key]);
  }
  if (limit.scope === "phase") {
    return Boolean(state.players[owner].oncePerTurn[key]); // X1: キーが現フェイズ名を含む（abilityLimitKey）
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
    const max = normalizedFightLimitMax(limit);
    if (max <= 1) {
      // count 未指定/1 は従来どおり boolean true を書き込む（既存全カード・既存 golden とバイト互換を保つ）。
      state.fightLimits[owner][key] = true;
    } else {
      // count:N のときだけ数値カウンタで記帳（max を上限に飽和）。
      state.fightLimits[owner][key] = Math.min(fightLimitUseCount(state.fightLimits[owner][key]) + 1, max);
    }
  }
  if (limit.scope === "turn") {
    state.players[owner].oncePerTurn[key] = true;
  }
  if (limit.scope === "phase") {
    // X1(D-BT01/0026): 「アタックフェイズとファイナルフェイズに1回ずつ発動する」。キーに現フェイズを
    // 含めるため同一ターン内でもフェイズごとに独立してカウントされる。oncePerTurn 格納なのでターン境界で自動リセット。
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
  // E-XB43(X-CBT01/0070 バールバッツ): 『大逆天』はファイト中1回のキーワード。key="greatReversal" で
  // 『逆天』(key:"reversal") とは別プールに記帳する＝0069 等の reversalUsedThisFight（.reversal を読む）は満たさない。
  // keyword:"greatReversal" を triggered な大逆天に付けても isFieldActivatedAbility は "reversal" alias のみ真化するため
  // 場起動へ誤露出しない（reversalKill と同じく明示 limit を書いてもよいが、キーワード自動導出でDSLを対称に保つ）。
  if (hasAbilityKeyword(ability, "greatReversal")) {
    return { scope: "fight", key: "greatReversal" };
  }
  // E-XB55(X-UB03/0001 究極に至るC ギアゴッド ver.1ØØØØ): 『逆天殺ReBOOT』はファイト中1回の独立キーワード。
  // 大逆天(greatReversal)と同形で key="reversalKillReboot" を自動導出する。『逆天』(reversal)・『逆天殺』(reversalKill)
  // とは別プールに記帳する（cross-reference するカードは対象内DBに無い＝独立keが安全。設計 R7）。keyword:"reversalKillReboot"
  // は "reversal" alias 集合に含めないため isFieldActivatedAbility を勝手に真化させない（0001 は kind:"activated" で明示）。
  // 非無効化＋相手対抗不可（原文括弧書き）は 0001 の effects 側（preventOpponentCounterThisTurn 等・既存op）が担う。
  if (hasAbilityKeyword(ability, "reversalKillReboot")) {
    return { scope: "fight", key: "reversalKillReboot" };
  }
  return null;
}

function abilityLimitKey(card, ability, limit) {
  const base = limit.key || ability.id || card.id;
  // 「1ターンに1回」は印字カード(=場/ソウルのインスタンス)ごとに独立。同名2枚を並べても各1回誘発できるよう
  // turnスコープはインスタンスIDで分離する。手札から使う spell/impact/変身系(fromHandOnly)は
  // 同名カード単位(=base)に保つ(再録間で共有する nice-one 等のキー設計を壊さない)。fightスコープは base のまま。
  // レビュー修正(D-BT01/0010等): 「“能力名”は1ターンに1回だけ発動する」の名前付き制限は、公式裁定では
  // 同名カード合算（ファイター単位）で1回。limit.shared:true でインスタンス分離をスキップし key を共有する。
  if (limit.shared) {
    return base;
  }
  if (limit.scope === "turn" && !isHandCastLimitAbility(ability)) {
    const instanceId = ability.__fromSoul?.instanceId || card?.instanceId;
    if (instanceId) {
      return `${base}::${instanceId}`;
    }
  }
  if (limit.scope === "phase") {
    // X1: フェイズ単位の1回制限（インスタンス分離＋フェイズ名で分離）。攻撃宣言中は state.phase が
    // "defense" に切り替わるため、宣言時のフェイズ（pendingAttack.phase）を優先して attack/final を弁別する。
    const instanceId = ability.__fromSoul?.instanceId || card?.instanceId || "";
    const phaseForKey = state.pendingAttack?.phase || state.phase;
    return `${base}::${instanceId}::${phaseForKey}`;
  }
  return base;
}

function isHandCastLimitAbility(ability) {
  return ability.kind === "spell" || ability.kind === "impact" || ability.fromHandOnly === true;
}

const abilityHandlers = {};


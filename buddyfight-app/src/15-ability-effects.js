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
  cards.forEach((soulCard) => queueEnteredSoulTriggers(soulCard, owner, fromZone, hostCard));
}

// cards を player のドロップ末尾に積み、「場かデッキからドロップに置かれた時」（movedToDrop）誘発を queue する。
// 誘発は fromZone が "field" | "deck" の時のみ（queueMovedToDropTriggers の対応範囲。手札/ソウル由来は発火しない）。
// owner: カードの持ち主（seat index）。options.alreadyPlaced: true なら push 済みで誘発の queue のみ行う。
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
      const drew = drawCards(drawer, effect.amount || 1);
      if (drew !== 0 || effect.amount) {
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
        putCardsToDropWithTrigger(receiver, state.players.indexOf(receiver), [movedCard], "deck"); // mill でデッキからドロップへ
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
  if (effect.op === "gainLife") {
    if (isLifeGainByEffectPrevented(state.players.indexOf(player))) {
      addLog(`${player.name}は効果でライフを回復できません。`);
    } else {
      // amountFrom 対応（「破壊したモンスターのサイズ分回復」H-BT04/0015 等。dealDamage と同形）。
      const gained = effect.amountFrom ? resolveAmountFrom(effect.amountFrom, context) : effect.amount || 1;
      player.life += gained;
      if (gained > 0) {
        await runFieldEventTriggers("lifeGained", state.players.indexOf(player));
      }
    }
  }
  if (effect.op === "setLife") {
    // ライフを固定値に代入（「ライフを10にする」等。gainLifeの加算では表せない）。
    const target = effect.player === "opponent" ? opponent : player;
    target.life = effect.life ?? effect.amount ?? target.life;
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
    const rest = revealed.filter((c) => !picked.includes(c));
    if (effect.altTo === "drop") {
      rest.forEach((c) => player.drop.push(c));
    } else {
      rest.forEach((c) => player.deck.unshift(c));
    }
    addLog(`${context.card.name}の効果でデッキの上${revealed.length}枚を見て${picked.length}枚を手札に加えました。`);
  }
  if (effect.op === "revealTopDamagePerMatchRestToBottom") {
    const count = effect.count || 5;
    const revealed = [];
    for (let i = 0; i < count && player.deck.length > 0; i += 1) revealed.push(player.deck.pop());
    const matched = revealed.filter((c) => matchesCardFilter(c, effect.filter || {})).length;
    const dmg = matched * (effect.perDamage || 1);
    addLog(`${context.card.name}の効果で${revealed.length}枚を公開し、${matched}枚一致。`);
    if (dmg > 0) applyDamageToPlayer(1 - context.owner, dmg, { sourceName: context.card?.name, sourceCard: context.card, sourceOwner: context.owner });
    revealed.forEach((c) => player.deck.unshift(c));
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
        addLog(`${context.card?.name || "効果"}でデッキの1番上を見て、ドロップに置きました。`);
      } else {
        player.deck.unshift(top);
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
    if (
      receiver === opponent &&
      (context.ability?.event === "destroyByAttack" || effect.spiritStrike) &&
      state.spiritStrikeDamageBonus?.[context.owner]
    ) {
      amount += state.spiritStrikeDamageBonus[context.owner];
    }
    const dealt = applyDamageToPlayer(state.players.indexOf(receiver), amount, {
      sourceName: context.card?.name,
      sourceCard: context.card,
      sourceOwner: context.owner,
      ignorePrevention: Boolean(effect.ignorePrevention),
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
        const detail = { card: listener, player, owner: context.owner, zone, damageSourceLabel: label };
        await runTriggeredAbilities(listener, "opponentDamagedByEffect", detail);
        if (label === "爆雷") {
          await runTriggeredAbilities(listener, "opponentDamagedByBakurai", detail);
        }
      }
    }
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
    discardHandCardsToDrop(discardTarget, discardTarget.hand.splice(0));
  }
  if (effect.op === "discardHand") {
    const receiver = effect.player === "opponent" ? opponent : player;
    const amount = Math.min(effect.amount || 1, receiver.hand.length);
    const movedCards = await chooseAndTakeMatchingCards(receiver.hand, effect.filter, amount, context.card, {
      title: `${context.card.name}で捨てる手札`,
      lead: `手札から捨てるカードを${amount}枚選んでください。`,
      // 権威サーバ: 捨てる本人(receiver=自分 or 相手)の席へ往復（相手手札候補が能動側へ漏れない）。
      promptSeat: state.players.indexOf(receiver),
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
      promptSeat: state.players.indexOf(player),
    });
    player.gauge.push(...movedCards);
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
        applyDamageToPlayer(owner, effect.damage || 1, { sourceName: context.card?.name, sourceCard: context.card, sourceOwner: context.owner });
      } else if (!isLifeGainByEffectPrevented(state.players.indexOf(receiver))) {
        receiver.life += effect.life || 1;
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
      context.cardMoved = true;
    }
  }
  if (effect.op === "setLifeZeroSafeguard") {
    // 「そのターン中、次に君のライフが0になるなら、かわりにライフは1になる」（実は生きていた！）。
    // プレイヤー単位の一回限り。resolveLifeZeroReplacements が消費し、ターン終了でクリアされる。
    // effects 指定時は消費時に追加効果（手札全捨て・相手にダメージ等。蒼舞天滝陣 0037）を実行する。
    player.lifeZeroSafeguard = { life: effect.life || 1, effects: effect.effects || null, owner: state.players.indexOf(player) };
    addLog(`${player.name}は次にライフが0になっても${effect.life || 1}で耐える構えをとった。`);
  }
  if (effect.op === "destroy") {
    // 統合形: target(単体) / scope(全体) / target:"$self"(自己) を1opに。
    // options(cause/ignoreSoulguard 等)で破壊耐性の挙動差を明示的に再現する。
    if (effect.scope) {
      const scopeTargets = collectFieldTargets(
        { scope: effect.scope, filter: effect.filter, zones: effect.zones, excludeSource: effect.excludeSource },
        context,
      ).map((entry) => ({ owner: entry.owner, zone: entry.zone }));
      // 逐次破壊（順序・破壊時誘発キューの保持。並列化禁止）。
      let anyDestroyed = false;
      context.lastDestroyedCards = []; // 破壊できた実カード（amountFrom lastDestroyedStatSum 用。H-BT04/0068）
      for (const entry of scopeTargets) {
        const d = await destroyFieldCard(entry.owner, entry.zone, { cause: makeEffectCause(context, entry.owner), ...(effect.options || {}) });
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
    for (const candidate of destroyAllTargets) {
      await destroyFieldCard(candidate.owner, candidate.zone, {
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
    }
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
      addLog(`${card.name}をデッキの下に置きました。`);
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
        resetLeftFieldCardState(context.card);
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
      resetLeftFieldCardState(returned);
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
            promptSeat: context.owner, // 効果の使用者が選ぶ（CPU対戦/権威サーバの誤配送防止）
            purpose: "hostile",
          })
        : soulEntries.slice(0, amount);
    const movedCards = removePileEntries(target.card.soul || [], selected || []);
    state.players[target.owner].drop.push(...movedCards);
    maybeDropSetWhenSoulEmpty(target.card, target.owner); // 設置のソウル切れ自壊（相手発の dropTargetSoul でも）
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
  if (effect.op === "standAll") {
    // controller/filter 一致の場のカード全てをスタンド（「君の場の《冒険者》全てを【スタンド】」0046）。
    const targets = allFieldTargets((card, owner, zone) => {
      if (Array.isArray(effect.zones) && !effect.zones.includes(zone)) return false;
      if (effect.controller === "self" && owner !== context.owner) return false;
      if (effect.controller === "opponent" && owner === context.owner) return false;
      return matchesTargetFilter(card, owner, zone, effect.filter || {});
    });
    targets.forEach((t) => {
      if (t.card) t.card.used = false;
    });
    if (targets.length > 0) {
      addLog(`${context.card?.name || "効果"}の効果で${targets.length}枚をスタンドしました。`);
    }
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
    const moved = putFieldCardToGauge(ownerPlayer, target.zone);
    if (moved) {
      addLog(`${context.card.name}の効果で${moved.name}をゲージに置きました。`);
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
    // 次のスタートフェイズで filter 一致の指定プレイヤーの場札をスタンドさせない（0042）。対象カードにフラグ。
    const seat = effect.player === "opponent" ? 1 - context.owner : context.owner;
    zones.forEach((zone) => {
      const card = state.players[seat]?.field?.[zone];
      if (card && matchesCardFilter(card, effect.filter || {})) {
        card.preventStandOnce = true;
      }
    });
    addLog(`${context.card?.name || "効果"}の効果で、次の${state.players[seat].name}のスタートフェイズに対象は【スタンド】できません。`);
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
        discardHandCardsToDrop(p, removed);
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
    const detached = [];
    fieldZones.forEach((zone) => {
      const fieldCard = relocPlayer.field[zone];
      if (fieldCard && effectiveCardType(fieldCard) === "monster" && matchesCardFilter(fieldCard, effect.filter || {})) {
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
    putCardsToSoulWithTrigger(target.card, context.owner, [movedCard], fromZone);
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
    if (effect.gainLife || effect.log || effect.countsAsDestroyed || effect.grantKeyword || effect.effects) {
      target.card.preventNextDestroyEffects ||= [];
      target.card.preventNextDestroyEffects.push({
        owner: context.owner,
        gainLife: effect.gainLife || 0,
        source: context.card?.name || "",
        log: effect.log || "",
        countsAsDestroyed: Boolean(effect.countsAsDestroyed),
        grantKeyword: effect.grantKeyword || null,
        // effects: 場に残った時に追加で解決する効果群（H-EB04/0052 等）。破壊解決の消費側(src/11)で
        // destroyReactionと同形のmicrotaskで実行する（破壊解決中の再入を避けるため）。
        effects: Array.isArray(effect.effects) ? effect.effects : null,
      });
    }
    addLog(`${context.card.name}の効果で、次に${target.card.name}が破壊される場合、場に残せるようにしました。`);
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
    // state.winner はプレイヤー名文字列（checkWinner 等と統一）。席index を入れると席0で falsy になり終局しない。
    state.winner = state.players[context.owner]?.name || null;
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
      promptSeat: context.owner, // 能力主体の席へ（CPU対戦/権威サーバの誤配送防止）
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
  if (spec.source === "selectedCardStat") {
    // script で選択した var のカードの visible stat（破壊直後のカードの打撃力参照などに使う）。
    const selected = scriptSelection({ var: spec.var }, context)[0]?.card;
    return selected ? visibleFieldStat(selected, spec.stat || "critical") : 0;
  }
  if (spec.source === "lastDestroyedStatSum") {
    // 直前の destroy(scope) で破壊できたカード群の印字 stat 合計（「破壊した打撃力合計分ダメージ」H-BT04/0068）。
    // 破壊済み＝場を離れているため visible ではなく印字値を使う。
    return (context.lastDestroyedCards || []).reduce((sum, card) => sum + (card?.[spec.stat || "critical"] || 0), 0);
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
    const tcard = context.target?.card;
    if (!tcard) return 0;
    return spec.stat === "size" ? tcard.size || 0 : visibleFieldStat(tcard, spec.stat || "critical");
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
  if (spec.source === "dropCount") {
    const owner = ownerOf(spec.controller);
    const count = (state.players[owner]?.drop || []).filter((card) => matchesCardFilter(card, spec.filter || {})).length;
    const capped = spec.max !== undefined ? Math.min(count, spec.max) : count;
    return capped * (spec.per ?? 1);
  }
  if (spec.source === "fieldCardCount") {
    // 指定controllerの場の filter 一致カード枚数×per＋plus（「場の《X》枚数分ダメージ」0032）。
    const owner = ownerOf(spec.controller);
    let count = 0;
    zones.forEach((zone) => {
      const card = state.players[owner]?.field?.[zone];
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
    // 指定側(controller未指定=両者)の場のアイテムの visiblePower 総和×per（0009 両者アイテム打撃力合計）。
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
  const base = limit.key || ability.id || card.id;
  // 「1ターンに1回」は印字カード(=場/ソウルのインスタンス)ごとに独立。同名2枚を並べても各1回誘発できるよう
  // turnスコープはインスタンスIDで分離する。手札から使う spell/impact/変身系(fromHandOnly)は
  // 同名カード単位(=base)に保つ(再録間で共有する nice-one 等のキー設計を壊さない)。fightスコープは base のまま。
  if (limit.scope === "turn" && !isHandCastLimitAbility(ability)) {
    const instanceId = ability.__fromSoul?.instanceId || card?.instanceId;
    if (instanceId) {
      return `${base}::${instanceId}`;
    }
  }
  return base;
}

function isHandCastLimitAbility(ability) {
  return ability.kind === "spell" || ability.kind === "impact" || ability.fromHandOnly === true;
}

const abilityHandlers = {};


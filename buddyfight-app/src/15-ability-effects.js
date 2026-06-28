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
  if (effect.op === "drawUpToHand") {
    // 手札が effect.amount 枚になるように引く（既に同数以上なら引かない）。
    // 例: ドラゴニック・ディレクティブ「手札が２枚以下なら３枚になるように引く」。
    const targetHand = effect.amount || 0;
    drawCards(player, Math.max(0, targetHand - player.hand.length));
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
      await equipCardDirect(player, source);
      context.cardMoved = true;
    }
  }
  if (effect.op === "setLifeZeroSafeguard") {
    // 「そのターン中、次に君のライフが0になるなら、かわりにライフは1になる」（実は生きていた！）。
    // プレイヤー単位の一回限り。resolveLifeZeroReplacements が消費し、ターン終了でクリアされる。
    player.lifeZeroSafeguard = { life: effect.life || 1 };
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
      for (const entry of scopeTargets) {
        await destroyFieldCard(entry.owner, entry.zone, { cause: makeEffectCause(context, entry.owner), ...(effect.options || {}) });
      }
    } else if (target?.card) {
      const destroyedName = target.card.name;
      const isSelf = effect.target === "$self";
      const options = isSelf
        ? { ignoreSoulguard: true, ...(effect.options || {}) }
        : { cause: makeEffectCause(context, target.owner), ...(effect.options || {}) };
      const destroyed = await destroyFieldCard(target.owner, target.zone, options);
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
      return matchesTargetFilter(card, owner, zone, effect.filter);
    }).map((candidate) => ({ owner: candidate.owner, zone: candidate.zone }));
    // 逐次破壊（順序・破壊時誘発キューの保持。並列化禁止）。
    for (const candidate of destroyAllTargets) {
      await destroyFieldCard(candidate.owner, candidate.zone, { cause: makeEffectCause(context, candidate.owner) });
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
      await destroyFieldCard(selected[0].owner, selected[0].zone);
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


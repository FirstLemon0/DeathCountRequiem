// ==========================================================================
// buddyfight モジュール 10 — バトル解決(対抗/貫通/ダメージトリガー)
// 旧 app.js L3777-4390 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
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
    const destroyed = await destroyFieldCard(pending.targetOwner, pending.targetZone, {
      cause: { byBattle: true, byOpponent: true, sourceOwner: attackers[0]?.owner, sourceCard: attackers[0]?.card },
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
  if (targets.length === 0 && !pending.attackAllIncludesFighter) {
    // 全体攻撃(相手に攻撃を含む)は、対象モンスターが全て居なくなっても本体への攻撃は続行する。
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
      const destroyed = await destroyFieldCard(target.owner, target.zone, {
        cause: { byBattle: true, byOpponent: true, sourceOwner: attackers[0]?.owner, sourceCard: attackers[0]?.card },
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
  let fighterDamageDealt = 0;
  if (pending.attackAllIncludesFighter) {
    // 「相手のモンスター全てと相手に攻撃する」の本体打撃（アジ・ダハーカ）。本体へ合計クリティカルぶんのダメージ。
    // 単体ファイター攻撃(resolveFighterAttack)と同じ算出（連携キャップ/攻撃キャップ/軽減耐性/減らないダメージ）。
    let damage = attackers.reduce((total, attacker) => total + visibleCritical(attacker.card), 0);
    if (attackers.length > 1) {
      const cap = linkAttackDamageCapFor(pending.defender);
      if (cap !== null && damage > cap) damage = cap;
    }
    const attackCap = attackDamageCapFor(pending.defender);
    if (attackCap !== null && damage > attackCap) damage = attackCap;
    const damageOptions = { log: false, byAttack: true };
    if (pending.damageCannotBeReduced) damageOptions.ignorePrevention = true;
    const reduceResist = applicableAttackResistances(attackers).filter((e) => (e.effects || []).includes("reduce"));
    if (reduceResist.length > 0) damageOptions.resistEntries = reduceResist;
    const fighterDefender = state.players[pending.defender];
    fighterDamageDealt = applyDamageToPlayer(pending.defender, damage, damageOptions);
    addLog(`${fighterDefender.name}は${attackerNames}の攻撃で${fighterDamageDealt}ダメージを受けました。`);
    await runDamageDealtTriggers(attackers, pending, fighterDamageDealt);
  }
  finishPendingAttack({
    destroyedTarget: destroyedCount > 0,
    destroyedCount,
    dealtDamage: fighterDamageDealt,
    attackAllTargetZones: [...(pending.attackAllTargetZones || [])],
  });
  if (fighterDamageDealt > 0) checkWinner();
  render();
}

async function runAttackDestroyedTriggers(attackers, pending, destroyedCard) {
  // このターン、攻撃で相手モンスターを破壊した数を「攻撃側の属性」ごとに集計（ターン開始でリセット）。
  // 例: ヒーロークライマックス「君の《ヒーロー》が攻撃で破壊した相手モンスターが2枚以上」用。
  // 撃破モンスター1枚につき、攻撃側に存在する各属性を+1（リンク攻撃でも1枚=各属性+1）。
  const attackerOwnerForCount = attackers[0]?.owner;
  if (attackerOwnerForCount === 0 || attackerOwnerForCount === 1) {
    state.attackDestroyedByAttribute ||= [{}, {}];
    const attrs = new Set();
    attackers.forEach((a) => (a.card?.attributes || []).forEach((attr) => attrs.add(attr)));
    attrs.forEach((attr) => {
      state.attackDestroyedByAttribute[attackerOwnerForCount][attr] =
        (state.attackDestroyedByAttribute[attackerOwnerForCount][attr] || 0) + 1;
    });
  }
  // X13(D-BT01/0093): 設置魔法などの第三者が「味方の攻撃でモンスターを破壊した時」を拾えるフィールドイベント。
  // イベントカード=先頭アタッカー（targetMatches で「《太陽竜》の攻撃で」等を判定できる）。
  if (attackers[0]) {
    await runFieldEventTriggers("monsterDestroyedByAttack", attackers[0].owner, attackers[0].card, attackers[0].zone, {
      destroyedCard,
      destroyedOwner: pending.targetOwner,
    });
  }
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
      const appliedDamage = applyDamageToPlayer(pending.targetOwner, damage, {
        log: false,
        sourceCard: setCard,
        sourceOwner: owner, // preventOpponentEffectDamage（相手効果ダメ無効）の判定に必要
      });
      // 累積（上書きだと2枚目の設置が0ダメージ=効果ダメ無効等の時、1枚目の致死ダメージ後の checkWinner が飛ぶ）。
      dealtDamage = dealtDamage || appliedDamage > 0;
      if (appliedDamage > 0) {
        addLog(`${setCard.name}の効果で${receiver.name}に${appliedDamage}ダメージを与えました。`);
      }
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
    // E-PR12(PR/0381): grantTemporaryAttackResistanceSelected でそのターン中だけ付与された攻撃耐性
    // (card.grantedTempAttackResistances)も印字 attackResistances と同型で走査する。素の DSL で state 常駐
    //（クロージャ無し・直列化往復可）。掃除は clearTurnModifiers/resetLeftFieldCardState が turnKeywords と同寿命で行う。
    // 既存カードは未設定＝この forEach は空＝挙動不変（後方互換）。
    (card?.grantedTempAttackResistances || []).forEach((entry) => {
      const owner = atk.owner ?? findFieldCardSlot(card)?.owner ?? state.active;
      if (!entry.conditions || checkCardConditions(entry.conditions, owner, { card, zone: atk.zone })) {
        entries.push(entry);
      }
    });
    // 場の別カードの継続 grantAttackResistance からも付与（0080: 拳アイテムが1枚で攻撃なら無効化されない）。
    if (!card) {
      return;
    }
    state.players.forEach((player) => {
      zones.forEach((zone) => {
        const source = player.field[zone];
        (activeContinuousEffects(source) || []).forEach((effect) => {
          if (effect.op !== "grantAttackResistance") {
            return;
          }
          const srcSlot = findFieldCardSlot(source);
          if (!srcSlot || (effect.controller === "self" && srcSlot.owner !== atk.owner)) {
            return;
          }
          if (effect.filter && !matchesTargetFilter(card, atk.owner, atk.zone, effect.filter)) {
            return;
          }
          if (effect.conditions && !checkCardConditions(effect.conditions, srcSlot.owner, { card: source, zone })) {
            return;
          }
          entries.push({ effects: effect.effects || ["nullify"], filter: effect.sourceFilter || {} });
        });
      });
    });
    // E5(D-BT03/0038 剣星機 J・ギャラクシオン): ホストのソウル内カードの soulContinuous
    // grantAttackResistance も収集する（星合体「ソウルにこのカードがあるモンスターが1枚で攻撃している
    // 攻撃は無効化されない」）。走査は soulContinuousGrantsOp と同型: 能力無効化・filter（attacker に
    // 適用）・conditions は continuousEffectAppliesFromSoul、hostOnly=ホスト自身が攻撃者の時のみ、
    // controller 既定は self（ホスト持ち主側の攻撃者のみ・soulContinuousGrantsOp の既定と同じ）。
    state.players.forEach((player, hostOwner) => {
      zones.forEach((zone) => {
        const host = player.field[zone];
        soulContinuousEffects(host, hostOwner).forEach(({ effect, sourceCard }) => {
          if (effect.op !== "grantAttackResistance") {
            return;
          }
          if (effect.hostOnly && host?.instanceId !== card.instanceId) {
            return;
          }
          // hostFilter: 乗っているホスト側の限定（「「ジャックナイフ」を含む必殺モンスターのソウルにある…」0038。
          // hostOnly と併用すると「ホスト自身が攻撃者かつホストが filter 一致」の二重ゲート）。
          if (effect.hostFilter && !matchesCardFilter(host, effect.hostFilter)) {
            return;
          }
          if (effect.controller === "opponent" && atk.owner === hostOwner) {
            return;
          }
          if ((!effect.controller || effect.controller === "self") && atk.owner !== hostOwner) {
            return;
          }
          if (!continuousEffectAppliesFromSoul(effect, card, sourceCard, hostOwner)) {
            return;
          }
          entries.push({ effects: effect.effects || ["nullify"], filter: effect.sourceFilter || {} });
        });
      });
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

// 攻撃で受けるダメージの上限（連携に限らない汎用版。合体戦士ディジエム 0013「4以上なら3に減らす」）。
function attackDamageCapFor(defenderOwner) {
  const player = state.players[defenderOwner];
  let cap = null;
  zones.forEach((zone) => {
    const card = player.field[zone];
    if (card && typeof card.attackDamageReceivedTo === "number") {
      cap = cap === null ? card.attackDamageReceivedTo : Math.min(cap, card.attackDamageReceivedTo);
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
  const attackCap = attackDamageCapFor(pending.defender);
  if (attackCap !== null && damage > attackCap) {
    damage = attackCap;
  }
  const damageOptions = { log: false, byAttack: true };
  if (state.pendingAttack?.damageCannotBeReduced) {
    damageOptions.ignorePrevention = true; // 「そのダメージは減らない」(ドラム・ザ・フューチャー等)
  }
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
    applyWinOnFighterDamage(pending, dealtDamage);
    finishPendingAttack({ dealtDamage, battledDefenseItem: true });
    checkWinner();
    render();
    return;
  }

  const dealtDamage = applyDamageToPlayer(pending.defender, damage, damageOptions);
  addLog(`${defender.name}は${attackerNames}の攻撃で${dealtDamage}ダメージを受けました。`);
  await runDamageDealtTriggers(attackers, pending, dealtDamage);
  applyWinOnFighterDamage(pending, dealtDamage);
  finishPendingAttack({ dealtDamage });
  checkWinner();
  render();
}

// 「その攻撃で相手にダメージを与えたなら勝利する」(チェック・メイト 0074)。
// pending.winOnFighterDamage が立った攻撃がファイターへダメージを与えたら攻撃側の勝利。
function applyWinOnFighterDamage(pending, dealtDamage) {
  if (!pending?.winOnFighterDamage || dealtDamage <= 0 || state.winner) {
    return;
  }
  const winnerSeat = pending.attackerOwner;
  state.winner = state.players[winnerSeat].name;
  state.winnerSeat = winnerSeat; // D5(戦績)
  state.winReason = "checkmate";
  addLog(`${state.winner}はチェック・メイトの条件を満たしゲームに勝利しました。`);
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
      promptSeat: targetSlot.owner, // 反撃するモンスターの持ち主の席へ（CPU対戦/権威サーバの誤配送防止）
      purpose: "hostile",
    });
    counterTarget = selected?.[0];
  }
  if (!counterTarget) {
    return;
  }
  const attackerName = counterTarget.card.name;
  // 反撃側(=破壊を起こす側=targetSlot.owner)を発生源に（「君のカードで破壊された時」0030・破壊耐性判定と整合）。
  const destroyed = await destroyFieldCard(counterTarget.owner, counterTarget.zone, {
    cause: { byBattle: true, byOpponent: true, sourceOwner: targetSlot.owner, sourceCard: targetAfterBattle },
  });
  if (destroyed) {
    addLog(`${targetAfterBattle.name}の反撃で${attackerName}を破壊しました。`);
    // E-XB14(X-CP03/0013 蠱惑の剣鬼 ヴィオローザ): 『反撃』でモンスターを破壊した時のフックを発火する。
    // 既存 event:"destroyByAttack"（DB全76枚が「このカードの"攻撃で"破壊した時」＝攻撃限定・generic『破壊した時』は
    // grep 実証で0枚）へ反撃を混ぜると76枚全てが反撃時に誤爆するため、別イベント名 "destroyByCounterattack" を新設する
    //（既存データに listener 0件＝挙動完全不変のオプトイン）。0013 は原文がDB唯一の無限定『このカードがモンスターを
    // 破壊した時』のため、mech 側で destroyByAttack＋destroyByCounterattack の2本立てにして攻撃/反撃の両破壊を拾う。
    // 反撃側カード(targetAfterBattle)は攻撃を耐えて場に残った側＝現在も場在。runAttackDestroyedTriggers の
    // destroyByAttack 発火 context と同型（card/owner/zone＋破壊されたカード情報＋eventCard）。
    const counterCard = state.players[targetSlot.owner]?.field?.[targetSlot.zone];
    if (counterCard && counterCard.instanceId === targetAfterBattle.instanceId) {
      await runTriggeredAbilities(counterCard, "destroyByCounterattack", {
        card: counterCard,
        player: state.players[targetSlot.owner],
        owner: targetSlot.owner,
        zone: targetSlot.zone,
        destroyedCard: destroyed,
        destroyedOwner: counterTarget.owner,
        destroyedZone: counterTarget.zone,
        eventCard: {
          card: destroyed,
          owner: counterTarget.owner,
          zone: counterTarget.zone,
          source: "field",
        },
      });
    }
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
    turnCount: state.turnCount, // E-Y5(0088): lastAttackNullified の同ターン窓限定用
  };
  if (!state.lastAttackOutcome.nullified) {
    runAfterAttackTriggers(state.lastAttackOutcome);
    // F3(X-CP01/0035 リーネア・0043 キャノンボール隊): 攻撃者スロットに加え、被攻撃（防御）スロットも渡す。
    // queueBattleEndTriggers は defender スロットへは includeDefender:true を明示した battleEnd 能力に限り配信する
    // （原文が無限定の「このカードのバトル終了時」＝攻撃・被攻撃どちらでも発火すべき札の救済）。fighter 攻撃は
    // モンスター非対象なので defenderSlot なし＝既存挙動不変。
    const defenderSlot =
      pending.targetType !== "fighter" && pending.targetOwner != null && pending.targetZone
        ? { owner: pending.targetOwner, zone: pending.targetZone }
        : null;
    queueBattleEndTriggers(state.lastAttackOutcome.attackers || [], defenderSlot);
    // E-X1: 被攻撃モンスターを eventCard に「バトル終了」を場全体へ放送する（defender-side 誘発＝ally/opponentBattleEnd。
    // 上の attacker-only bare "battleEnd" とは別イベント名で非衝突・既存挙動不変）。fighter 攻撃（モンスター非対象）は
    // 放送しない。被攻撃札は現在の場から取り直す（戦闘を耐えて場に残ったモンスターのみ＝破壊済みは null で放送しない）。
    if (pending.targetType !== "fighter") {
      const attackedCard = state.players[pending.targetOwner]?.field?.[pending.targetZone];
      queueBattleEndFieldTriggers(pending.targetOwner, attackedCard, pending.targetZone, {
        nullified: false,
        attackerOwner: pending.attackerOwner,
        targetType: pending.targetType,
      });
    }
    // E-XV7(X-UB01/0052 道化師 ダークフォックス・X-UB02/0004 ブレザーフリル): 攻撃側カードを eventCard に
    // 「攻撃したバトルの終了時」を場全体へ放送する（attacker-side 誘発＝ally/opponentAttackerBattleEnd。
    // 直上 E-X1 の defender-side ally/opponentBattleEnd の姉妹実装）。fighter 攻撃でも『バトル』は成立する
    // ため targetType を問わず放送する。!nullified 経路のみ＝対抗で攻撃無効化されたバトルは非放送
    // （従来の allyAttack 宣言時近似の乖離を解消する核）。連携攻撃は攻撃者ごとに配信。
    queueAttackerBattleEndFieldTriggers(state.lastAttackOutcome.attackers || [], {
      nullified: false,
      targetOwner: pending.targetOwner,
      targetType: pending.targetType,
    });
  }
  clearPendingAttack(outcome);
}

// このカードのバトル終了時(攻撃が無効化されず解決した後)の triggered 能力を発火する。
// listener 検出は cardHasTriggeredListener に統一（自身の abilities に加え、ソウル札の soulAbilities も見る。
// D-SS02/0003 流星機ネブローサ「ホストが攻撃したバトル終了時、ホストは２回攻撃を得る」等・queueDrewTriggers と同型）。
// 旧実装は card.abilities のみを見ていたため、ソウル札発の battleEnd 誘発が queue 前に取りこぼされていた
// （既存カードに soulAbilities+event:battleEnd の使用は0件＝この拡張で挙動が変わる既存カードは無い）。
//
// F3(X-CP01/0035 リーネア・0043 キャノンボール隊): 第2引数 defenderSlot（被攻撃モンスターのスロット・省略可）を
// 受け取り、その札の battleEnd 能力のうち includeDefender:true を明示したものだけを追加で発火する。bare battleEnd は
// 攻撃者スロットのみ配信するため、原文が無限定の「このカードのバトル終了時」（攻撃・被攻撃どちらでも発火すべき）を
// 被攻撃側で不発にしていた。includeDefender を持たない既存 bare battleEnd（57件）は defender 経路で一切発火しない
// ＝完全なオプトインで後方互換。攻撃者側の多重攻撃スタンド処理（standAttackerForMultiAttack）は防御側では行わない。
function queueBattleEndTriggers(attackerSlots, defenderSlot = null) {
  attackerSlots.forEach((slot) => {
    const card = state.players[slot.owner]?.field?.[slot.zone];
    if (!card || !cardHasTriggeredListener(card, "battleEnd")) {
      return;
    }
    const attackerInstanceId = card.instanceId;
    Promise.resolve()
      .then(async () => {
        await runTriggeredAbilities(card, "battleEnd", { card, player: state.players[slot.owner], owner: slot.owner, zone: slot.zone });
        // 「このカードが攻撃したバトルの終了時、…このカードは『２回攻撃』を得る」型(フォーマルフリル 0008 等)は、
        // 上の battleEnd 誘発でキーワードが後付けされる。runAfterAttackTriggers(同期)はこの付与より前に走るため
        // スタンド判定に間に合わない。付与後のこの時点で、まだ場に残り(instanceId一致)レスト中(used)の攻撃カードを
        // 再判定してスタンドさせる。既存の doubleAttackUsed/tripleAttackStandCount ガードで二重スタンドは防がれる。
        // battleEnd 中に場を離れたカード(0012 の自己戻し等)は現在の場札と instanceId が不一致でスキップされる。
        const attackerNow = state.players[slot.owner]?.field?.[slot.zone];
        if (attackerNow && attackerNow.instanceId === attackerInstanceId && attackerNow.used) {
          standAttackerForMultiAttack(attackerNow);
        }
        render();
      })
      .catch((error) => {
        console.error(error);
        addLog(`${card.name}のバトル終了時能力の処理中にエラーが発生しました。`);
        render();
      });
  });
  // F3: 被攻撃（防御）側 battleEnd の配信（includeDefender:true のみ）。
  if (defenderSlot) {
    const card = state.players[defenderSlot.owner]?.field?.[defenderSlot.zone];
    if (card && cardHasIncludeDefenderBattleEnd(card)) {
      Promise.resolve()
        .then(async () => {
          await runTriggeredAbilities(card, "battleEnd", {
            card,
            player: state.players[defenderSlot.owner],
            owner: defenderSlot.owner,
            zone: defenderSlot.zone,
            // includeDefender を明示した能力のみに絞る（他の bare battleEnd は防御側で発火させない）。
            __abilityFilter: (ability) => ability.includeDefender === true,
          });
          render();
        })
        .catch((error) => {
          console.error(error);
          addLog(`${card.name}のバトル終了時能力の処理中にエラーが発生しました。`);
          render();
        });
    }
  }
}

// F3: card が「被攻撃側でも発火する battleEnd 能力」(includeDefender:true) を持つか。
// 自身の abilities とソウル札の soulAbilities の両方を見る（bare battleEnd は includeDefender を持たない＝false）。
function cardHasIncludeDefenderBattleEnd(card) {
  if (!card) {
    return false;
  }
  const has = (list) =>
    (list || []).some(
      (ability) => ability.kind === "triggered" && ability.event === "battleEnd" && ability.includeDefender === true,
    );
  return has(card.abilities) || (card.soul || []).some((soulCard) => has(soulCard.soulAbilities));
}

// E-X1(X-SD02/0015 クリスタル・マーク): 「君の場の《プリズムドラゴン》のモンスターが攻撃されたバトルの終了時」を
// 場全体へブロードキャストする。直上の queueBattleEndTriggers は『攻撃者スロットのカード自身』の bare "battleEnd"
// 誘発のみを発火し（出荷済み57リスナーが依存＝1ビットも変えない）、防御側の被攻撃モンスターや場のアイテム
// （クリスタル・マーク）には届かなかった。ここは別イベント名 ally/opponentBattleEnd を新設する —— runFieldEventTriggers
// が eventBase を capitalize して ally+/opponent+ を動的生成するため、bare "battleEnd" とは非衝突（既存データに
// ally/opponentBattleEnd リスナーは0件＝grep 実証・挙動完全不変）。被攻撃モンスター(defenderCard)を eventCard に載せ、
// defenderOwner から見て ally=自軍が攻撃された/opponent=相手が攻撃された を配送する（クリスタル・マークは自軍側の
// allyBattleEnd＋eventCardMatches{cardType:monster,attribute:プリズムドラゴン} で受ける）。finishPendingAttack の
// !nullified 経路からのみ呼ぶ（＝既存 bare battleEnd と同一タイミング。無効化された攻撃は『バトル』が成立しないため
// 放送しない）。hasListener ゲート＋microtask（queueDeckMilledTriggers 同型）。defenderCard は呼び出し時点の場札
// （戦闘を耐えて場に残った被攻撃モンスター）をクロージャで凍結する（state には積まない＝room 復元での二重参照を避ける）。
// 戦闘で破壊された被攻撃モンスターは呼び出し側で defenderCard=null となり放送しない（それがセンター札なら『君の
// センターに《プリズムドラゴン》がいるなら』条件も同時に外れ実害なし・非センターの被破壊のみ取りこぼす近似）。
function queueBattleEndFieldTriggers(defenderOwner, defenderCard, defenderZone, details = {}) {
  if (!defenderCard) {
    return;
  }
  const hasListener = [0, 1].some((playerIndex) =>
    zones.some((zone) => {
      const c = state.players[playerIndex]?.field?.[zone];
      return (
        cardHasTriggeredListener(c, "allyBattleEnd") || cardHasTriggeredListener(c, "opponentBattleEnd")
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      await runFieldEventTriggers("battleEnd", defenderOwner, defenderCard, defenderZone, details);
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
    });
}

// E-XV7(X-UB01/0052 道化師 ダークフォックス・X-UB02/0004 ブレザーフリル): 「君の場の《X》が攻撃したバトルの
// 終了時」を場全体へブロードキャストする。直上 queueBattleEndFieldTriggers（E-X1＝被攻撃側視点の
// ally/opponentBattleEnd）の姉妹実装で、こちらは**攻撃側カード**を eventCard に載せる。イベント名は別軸の
// ally/opponentAttackerBattleEnd（runFieldEventTriggers("attackerBattleEnd", 攻撃者owner, ...) が capitalize 生成）＝
// bare "battleEnd"（攻撃者スロットのカード自身・68リスナー）とも E-X1 とも非衝突（既存データにリスナー0件＝
// grep 実証・挙動完全不変のオプトイン）。攻撃者の持ち主から見て ally=自軍が攻撃した／opponent=相手が攻撃した。
// finishPendingAttack の !nullified 経路からのみ呼ぶ（無効化された攻撃は『バトル』が成立しない＝非放送。
// 従来の event:allyAttack 宣言時近似が持っていた「無効化されても発動する」乖離を解消する）。
// 連携攻撃は攻撃者スロットごとに1回ずつ配信（eventCard=各攻撃カード）。attackerSlots のカードは呼び出し時点の
// 場札をクロージャで凍結する（E-X1 と同型＝state には積まない）。反撃等でバトル中に破壊された攻撃者は場に無く
// null → その攻撃者分は放送しない（「場のそのカードを手札に戻す」等の消費側は場在が前提＝実害なしの近似）。
function queueAttackerBattleEndFieldTriggers(attackerSlots, details = {}) {
  const hasListener = [0, 1].some((playerIndex) =>
    zones.some((zone) => {
      const c = state.players[playerIndex]?.field?.[zone];
      return (
        cardHasTriggeredListener(c, "allyAttackerBattleEnd") ||
        cardHasTriggeredListener(c, "opponentAttackerBattleEnd")
      );
    }),
  );
  if (!hasListener) {
    return;
  }
  const frozen = (attackerSlots || [])
    .map((slot) => ({ owner: slot.owner, zone: slot.zone, card: state.players[slot.owner]?.field?.[slot.zone] }))
    .filter((slot) => slot.card);
  if (frozen.length === 0) {
    return;
  }
  Promise.resolve()
    .then(async () => {
      // 逐次 await（連携攻撃の複数配信で limit 記帳が並列に抜けないように＝runTriggeredAbilities の作法）。
      for (const slot of frozen) {
        await runFieldEventTriggers("attackerBattleEnd", slot.owner, slot.card, slot.zone, { ...details });
      }
      render();
    })
    .catch((error) => {
      console.error(error);
      render();
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
  if (pending.cannotBeNullified) {
    addLog("この攻撃は無効化されません。");
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
    turnCount: state.turnCount, // E-Y5(0088): lastAttackNullified の同ターン窓限定用
  };
  clearPendingAttack({ nullified: true });
  return true;
}

// 「君の場のカードの攻撃が相手に無効化された時」(爆雷 ヤミゲドウ 0109/0110) の誘発を、攻撃側の場札へ発火する。
// nullifyPendingAttack は同期なので、無効化を成立させた非同期経路(counter効果解決)から呼ぶ。
async function fireAllyAttackNullifiedTriggers() {
  const outcome = state.lastAttackOutcome;
  if (!outcome?.nullified || outcome.allyAttackNullifiedFired) {
    return;
  }
  outcome.allyAttackNullifiedFired = true;
  const attackerOwner = outcome.attackers?.[0]?.owner;
  if (attackerOwner === undefined || attackerOwner === null) {
    return;
  }
  for (const zone of zones) {
    const card = state.players[attackerOwner]?.field?.[zone];
    if (!card) {
      continue;
    }
    await runTriggeredAbilities(card, "allyAttackNullified", {
      card,
      player: state.players[attackerOwner],
      owner: attackerOwner,
      zone,
    });
  }
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
  if (state.pendingAttack?.damageCannotBeReduced) {
    penetrateOptions.ignorePrevention = true;
  }
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
  // 「そのターン中に自分の武器(等)が攻撃でダメージを与えた」判定用に、当該ターンのダメージイベントを蓄積する。
  // lastDamageEvent は毎戦闘で上書きされるため、単発参照だと武器ダメージの後に別ダメージが入ると発生源を見失う。
  if (!Array.isArray(state.turnDamageEvents)) {
    state.turnDamageEvents = [];
  }
  state.turnDamageEvents.push(damageEvent);
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

// 攻撃解決後の多重攻撃（『４回攻撃』/『３回攻撃』/『２回攻撃』）のスタンド判定を1枚ぶん実行する。
// runAfterAttackTriggers（攻撃解決直後・同期）と queueBattleEndTriggers（battleEnd 誘発で多重攻撃
// キーワードが後付けされたカードの再判定）の両方から呼ぶ。quadruple/triple は tripleAttackStandCount、
// double は doubleAttackUsed の既存ガードで、同一カードが同一ターンに規定回数を超えてスタンドしない。
function standAttackerForMultiAttack(card) {
  if (!card) {
    return;
  }
  // E-XB43(X-CBT01/0070 バールバッツ・ドラグロイヤー): sextupleAttack（『６回攻撃』）。
  // 選定理由（ruling R6）: 既存 double/triple/quadruple は「離散keyword＋閾値」で表現され、quadruple は triple の
  // tripleAttackStandCount カウンタを閾値3で流用する確立形。6回攻撃は 5回スタンド＝同カウンタを閾値5で流用するのが
  // 最小かつ自然な拡張（standPlayer の既存ターン開始リセット・22-ai/18-tooltip の keyword 集合にも同型で乗る）。
  // 汎用 multiAttack:N 化も可だが、既存3keyword を N化に作り替えると後方互換の diff が広がるため、確立形の踏襲を優先した。
  // 5回攻撃が対象内DBに存在しない（＝連番keywordの穴埋め不要）ことも離散keyword採用の後押し。赤ピン: 本分岐を消すと6回目以降も攻撃できず fail。
  if (hasKeyword(card, "sextupleAttack")) {
    card.tripleAttackStandCount = card.tripleAttackStandCount || 0;
    if (card.tripleAttackStandCount < 5) {
      card.used = false;
      card.tripleAttackStandCount += 1;
      addLog(`${card.name}は６回攻撃でスタンドしました。`);
    }
    return;
  }
  // Z14(c)(S-UB-C03/0021): quadrupleAttack（『４回攻撃』）。tripleAttackと同じ
  // tripleAttackStandCountカウンタを流用（閾値のみ3に。standPlayerの既存ターン開始リセットに乗る）。
  if (hasKeyword(card, "quadrupleAttack")) {
    card.tripleAttackStandCount = card.tripleAttackStandCount || 0;
    if (card.tripleAttackStandCount < 3) {
      card.used = false;
      card.tripleAttackStandCount += 1;
      addLog(`${card.name}は４回攻撃でスタンドしました。`);
    }
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
}

function runAfterAttackTriggers(outcome) {
  if (outcome.nullified) {
    return;
  }
  (outcome.attackers || []).forEach((slot) => {
    standAttackerForMultiAttack(attackerCardAt(slot.owner, slot.zone)); // E-XB54b: zone:"flag"→player.flag（∞ は多回攻撃keyword無し＝実質no-op）
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
  const destroyedTarget =
    target.owner === pending.targetOwner && target.zone === pending.targetZone;
  if (destroyedTarget) {
    // 攻撃対象が場を離れた → 攻撃終了。
    addLog("攻撃に関わるカードが場を離れたため、攻撃は終了しました。");
    clearPendingAttack();
    return;
  }
  // 攻撃側カードが場を離れた場合、公式裁定は「連携攻撃ではなくなるが、残った1枚が攻撃する」。
  // 攻撃者が全て場を離れた時のみ攻撃を終了する（1枚でも残れば resolvePendingAttack が残存で続行）。
  // ※呼び出し時点で除去カードは既に場から外れているため getPendingAttackers() は生存分のみを返す。
  const wasAttacker = getPendingAttackerSlots(pending).some((attacker) => sameSlot(attacker, target));
  if (wasAttacker && getPendingAttackers().length === 0) {
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
    .map((slot) => ({ ...slot, card: attackerCardAt(slot.owner, slot.zone) })) // E-XB54b: zone:"flag"→player.flag
    .filter((attacker) => attacker.card);
}

function getPendingAttackerSlots(pending) {
  return pending.attackers?.length
    ? pending.attackers
    : [{ owner: pending.attackerOwner, zone: pending.attackerZone }];
}

// S-UB-C03(0074/0083): 現在進行中のバトル(pendingAttack)に参加しているカードの instanceId 集合。
// 攻撃側スロットのカード＋防御対象がモンスターならその1枚。pendingAttack が無ければ空集合。
// selectCards{excludeBattling}（0074＝バトルしていない相手キャラへ攻撃対象を変更）と
// 条件op pendingBattleInvolvesSelf（0083＝このカードのバトル中のみ起動可）が共有する。
function pendingBattleCardIds() {
  const pending = state.pendingAttack;
  const ids = new Set();
  if (!pending) {
    return ids;
  }
  getPendingAttackerSlots(pending).forEach((slot) => {
    const card = attackerCardAt(slot.owner, slot.zone); // E-XB54b: zone:"flag"→player.flag
    if (card?.instanceId) {
      ids.add(card.instanceId);
    }
  });
  if (pending.targetType === "monster") {
    const target = state.players[pending.targetOwner]?.field?.[pending.targetZone];
    if (target?.instanceId) {
      ids.add(target.instanceId);
    }
  }
  return ids;
}

function getAttackDeclarationAttackers() {
  // E-XB54b: source:"flag"（∞ the Chaos ∞ を攻撃者に選択）は zone を "flag" に固定する単騎スロット。
  // 連携(linkAttackers)は場札のみが積まれる＝フラッグは常に単騎。既存の field 選択・連携は完全不変。
  const slots = state.linkAttackers?.length
    ? state.linkAttackers
    : state.selected?.source === "field"
      ? [{ owner: state.selected.owner, zone: state.selected.zone }]
      : state.selected?.source === "flag"
        ? [{ owner: state.selected.owner, zone: "flag" }]
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
    .map((slot) => ({ ...slot, card: attackerCardAt(slot.owner, slot.zone) }))
    .filter((attacker) => attacker.card && !attacker.card.used && canDeclareAttack(attacker));
}


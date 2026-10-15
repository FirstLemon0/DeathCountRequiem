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
    endPendingAttackWithoutBattle("攻撃カードが場を離れたため、攻撃は終了しました。");
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
    // 対象が戦闘前に離場しても、多回攻撃(2/3/4/6回)の攻撃者は残りの攻撃のため再スタンドする（無効化経路と同型。
    // 攻撃宣言でレスト＝攻撃は成立しており追加攻撃の権利は失われない。『Ｎ回攻撃』の N 別使用回数(multiAttackUses)の
    // 既存ガードで規定回数を超えてスタンドしない）。E6: 『バトルの終了時』も解決する（endPendingAttackWithoutBattle）。
    endPendingAttackWithoutBattle("攻撃対象が場を離れたため、攻撃は終了しました。");
    render();
    return;
  }
  const attackPower = attackers.reduce((total, attacker) => total + visiblePower(attacker.card), 0);
  let destroyedInPlace = false; // 2026-10-09 オーナー裁定: ソウルガード等で場に残ったが破壊は成功
  if (attackPower >= visibleDefense(target)) {
    const destroyedName = target.name;
    // ver2.05 p.13: 3.1 破壊 → 3.2.1『貫通』→ 3.3 ★ルール処理★ → 3.4 プレイタイミング（「破壊された時」
    // 「モンスターを破壊した時」「ダメージを与えた時」の能力はここで解決）。破壊〜貫通の間に queue された誘発は
    // battleTriggerHold に溜め、貫通（resolvePenetrateDamage 内の checkWinner＝ルール処理）の後で解決する。
    const previousHold = holdBattleTriggers();
    let destroyed = null;
    try {
      // R11（2026-10-09 オーナー裁定）: センターのモンスターがソウルガード等の置換で場に残っても、攻撃はヒットし破壊は
      // 成功している（場に残るだけ）ので『貫通』のダメージは通る。置換の成立は outcome.replaced で受け取る。
      // 2026-10-09 オーナー裁定（追加）: 場に残る置換（ソウルガード等）は destroyFieldCard が場に残ったカードを返す＝
      // 「攻撃で破壊した時」誘発・破壊数も数える（outcome.destroyedInPlace）。ゲージ/手札等へ移る置換は従来どおり null。
      const destroyOutcome = {};
      destroyed = await destroyFieldCard(pending.targetOwner, pending.targetZone, {
        cause: { byBattle: true, byOpponent: true, sourceOwner: attackers[0]?.owner, sourceCard: attackers[0]?.card },
        outcome: destroyOutcome,
      });
      if (destroyed) {
        addDestroyLog(`${attackerNames}は${destroyedName}を破壊しました。`, destroyedName);
      }
      destroyedInPlace = Boolean(destroyed && destroyOutcome.destroyedInPlace);
      if (destroyed || destroyOutcome.replaced) {
        await resolvePenetrateDamage(attackers, pending);
      }
    } finally {
      await releaseBattleTriggers(previousHold);
    }
    if (destroyed) {
      await runAttackDestroyedTriggers(attackers, pending, destroyed);
      const linkTriggers = resolveLinkDestroyedMonsterTriggers(pending, attackers);
      if (linkTriggers?.then) await linkTriggers;
    }
  } else {
    addLog(`${target.name}は攻撃を耐えました。`);
  }

  await resolveCounterattack({ owner: pending.targetOwner, zone: pending.targetZone, instanceId: target.instanceId }, attackers);
  finishPendingAttack({ destroyedTarget: pending.targetType === "monster" && (destroyedInPlace || !getPendingTarget()) }, { attackedCard: target });
  render();
}

async function resolveMultiMonsterAttack(pending, attackers, attackerNames) {
  // E2: 宣言時に控えた各対象の instanceId と一致するカードだけを対象にする（離場後に同エリアへ入った別カードは対象外）。
  const targetRefIds = new Map((pending.attackAllTargetRefs || []).map((ref) => [ref.zone, ref.instanceId]));
  const targets = uniqueTargetEntries(
    (pending.attackAllTargetZones || [])
      .map((zone) => getFieldTarget(pending.targetOwner, zone))
      .filter((target) => target?.card && effectiveCardType(target.card) === "monster")
      .filter((target) => {
        const refId = targetRefIds.get(target.zone);
        return refId == null || target.card.instanceId === refId;
      }),
  );
  if (targets.length === 0 && !pending.attackAllIncludesFighter) {
    // 全体攻撃(相手に攻撃を含む)は、対象モンスターが全て居なくなっても本体への攻撃は続行する。
    // 対象が全て離場しても多回攻撃の攻撃者は再スタンドする（単体対象経路と同型・無効化経路と対称）。
    endPendingAttackWithoutBattle("攻撃対象が場を離れたため、攻撃は終了しました。");
    render();
    return;
  }
  const attackPower = attackers.reduce((total, attacker) => total + visiblePower(attacker.card), 0);
  let destroyedCount = 0;
  let centerDestroyed = false; // 貫通判定用: この全体攻撃で相手センターのモンスターを破壊したか（R11: 置換で場に残った場合も含む）
  for (const target of targets) {
    const current = state.players[target.owner]?.field?.[target.zone];
    if (!current || current.instanceId !== target.card.instanceId) {
      continue;
    }
    if (attackPower >= visibleDefense(current)) {
      const destroyedName = current.name;
      const destroyOutcome = {}; // R11: 置換で場に残っても貫通判定（centerDestroyed）には数える
      const destroyed = await destroyFieldCard(target.owner, target.zone, {
        cause: { byBattle: true, byOpponent: true, sourceOwner: attackers[0]?.owner, sourceCard: attackers[0]?.card },
        outcome: destroyOutcome,
      });
      if (!destroyed && destroyOutcome.replaced && target.zone === "center") {
        centerDestroyed = true;
      }
      if (destroyed) {
        destroyedCount += 1;
        if (target.zone === "center") {
          centerDestroyed = true;
        }
        addDestroyLog(`${attackerNames}は${destroyedName}を破壊しました。`, destroyedName);
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
    await resolveCounterattack({ owner: target.owner, zone: target.zone, instanceId: target.card?.instanceId }, attackers);
  }
  // 貫通: 全体攻撃(『相手のモンスター全て(と相手)に攻撃』)でも、この攻撃で相手センターのモンスターを破壊し攻撃側に
  // 貫通保持者がいれば、単体攻撃と同じく相手ライフへ打撃力ぶんのダメージを与える。resolveMultiMonsterAttack は
  // これまで resolvePenetrateDamage を一切呼ばず、全体攻撃経路では貫通が丸ごと落ちていた。単体経路と同じ関数を
  // targetZone:"center" を差し込んだ pending で1回だけ呼ぶ（キャップ/軽減耐性/減らないダメージも中で適用される）。
  if (centerDestroyed) {
    await resolvePenetrateDamage(attackers, { ...pending, targetZone: "center" });
  }
  let fighterDamageDealt = 0;
  if (pending.attackAllIncludesFighter) {
    // 「相手のモンスター全てと相手に攻撃する」の本体打撃（アジ・ダハーカ）。本体へ合計クリティカルぶんのダメージ。
    // 単体ファイター攻撃(resolveFighterAttack)と同じ算出（連携キャップ/攻撃キャップ/軽減耐性/減らないダメージ）。
    let damage = attackers.reduce((total, attacker) => total + visibleCritical(attacker.card), 0);
    const reduceResist = applicableAttackResistances(attackers).filter((e) => (e.effects || []).includes("reduce"));
    // 裁定 rulings-d: ゴルドリッター「Nになる」(b)は『減らない』でも適用、ディジエム「Nに減らす」(c)は貫通される。
    damage = applyAttackDamageReceivedCaps(pending, attackers, damage, reduceResist);
    const damageOptions = { log: false, byAttack: true };
    if (pending.damageCannotBeReduced) damageOptions.ignorePrevention = true;
    if (reduceResist.length > 0) damageOptions.resistEntries = reduceResist;
    const fighterDefender = state.players[pending.defender];
    const winnerBeforeDamage = state.winner;
    fighterDamageDealt = applyDamageToPlayerAsk(pending.defender, damage, damageOptions); // 任意コストの軽減は本人に問う
    if (fighterDamageDealt?.then) fighterDamageDealt = await fighterDamageDealt;
    addDamageLog(`${fighterDefender.name}は${attackerNames}の攻撃で${fighterDamageDealt}ダメージを受けました。`, winnerBeforeDamage);
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
    return undefined;
  }
  const jobs = [];
  state.players.forEach((player, owner) => {
    setZones.forEach((zone) => {
      const setCard = player.field[zone];
      const trigger = setCard?.linkDestroyedOpponentMonsterTrigger;
      if (!trigger || pending.targetOwner === owner) {
        return;
      }
      jobs.push({ owner, setCard, damage: trigger.damage || 1 });
    });
  });
  let dealtDamage = false;
  const receiver = state.players[pending.targetOwner];
  const note = (setCard, appliedDamage) => {
    // 累積（上書きだと2枚目の設置が0ダメージ=効果ダメ無効等の時、1枚目の致死ダメージ後の checkWinner が飛ぶ）。
    dealtDamage = dealtDamage || appliedDamage > 0;
    if (appliedDamage > 0) {
      addLog(`${setCard.name}の効果で${receiver.name}に${appliedDamage}ダメージを与えました。`);
    }
  };
  // 任意コストの軽減（メラク等）を本人に問う時だけ非同期に切り替える（Promise を返す＝呼び出し側が await）。
  const runFrom = (index) => {
    for (let i = index; i < jobs.length; i += 1) {
      const { owner, setCard, damage } = jobs[i];
      const applied = applyDamageToPlayerAsk(pending.targetOwner, damage, {
        log: false,
        sourceCard: setCard,
        sourceOwner: owner, // preventOpponentEffectDamage（相手効果ダメ無効）の判定に必要
      });
      if (applied?.then) {
        return applied.then((value) => {
          note(setCard, value);
          return runFrom(i + 1);
        });
      }
      note(setCard, applied);
    }
    if (dealtDamage) {
      checkWinner();
    }
    return undefined;
  };
  return runFrom(0);
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
    // 能力無効化(凍てつく星辰)中は、このカード自身の印字/一時付与の攻撃耐性(『無効化されない』等)も無効になる。
    // hasKeyword の ownNullified と同じ扱い（印字＋card格納の付与を無効化。他カード発の継続 grantAttackResistance
    // ＝下段は付与元の無効化判定に委ねるためゲートしない）。以前は印字 attackResistances だけ isAbilitiesNullified
    // を見ておらず、能力無効化された攻撃側の『無効化されない』が消えず緑竜の盾等を弾き続けていた（キーワード版
    // singleAttackCannotBeNullified は hasKeyword 経由で正しく消えるのに非対称）。
    if (card && !isAbilitiesNullified(card)) {
      (card.attackResistances || []).forEach((entry) => {
        const owner = atk.owner ?? findFieldCardSlot(card)?.owner ?? state.active;
        if (!entry.conditions || checkCardConditions(entry.conditions, owner, { card, zone: atk.zone })) {
          entries.push(entry);
        }
      });
      // E-PR12(PR/0381): grantTemporaryAttackResistanceSelected でそのターン中だけ付与された攻撃耐性
      // (card.grantedTempAttackResistances)も印字 attackResistances と同型で走査する（state 常駐・直列化往復可）。
      (card.grantedTempAttackResistances || []).forEach((entry) => {
        const owner = atk.owner ?? findFieldCardSlot(card)?.owner ?? state.active;
        if (!entry.conditions || checkCardConditions(entry.conditions, owner, { card, zone: atk.zone })) {
          entries.push(entry);
        }
      });
    }
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
// 注: zones は setZonesAndItems（item 枠含む）を内包するため、装備アイテム
//   （ジャックナイフ “ゴルドリッター”・countsAsFieldMonster）も本走査で拾える（testJackknifeEquipAndLinkDamageCap で担保）。
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

// 裁定 rulings-d: 攻撃で受けるダメージの「上限/変更」2種を分類どおりに掛ける（ファイター攻撃・全体攻撃の本体打撃で共通）。
//   ゴルドリッター「君が連携攻撃によって受けるダメージは２になる」＝分類(b) 変更。『減らない』（ドラム・ザ・フューチャー、
//     ∞）でも２になり（Q553・Q1604）、打撃力が１以下でも２になる（Q323）。
//   ディジエム「攻撃によって受けるダメージが４以上なら、３に減らす」＝分類(c) 軽減。damageCannotBeReduced と、発生源
//     一致の reduce 耐性（「このカードが相手に与えるダメージは減らない」）に貫通される。
function applyAttackDamageReceivedCaps(pending, attackers, damage, reduceResist = []) {
  if (attackers.length > 1) {
    const linkTo = linkAttackDamageCapFor(pending.defender);
    if (linkTo !== null) {
      damage = linkTo;
    }
  }
  const cannotReduce = Boolean(pending.damageCannotBeReduced || state.pendingAttack?.damageCannotBeReduced);
  if (!cannotReduce) {
    const player = state.players[pending.defender];
    let cap = null;
    zones.forEach((zone) => {
      const card = player?.field?.[zone];
      if (!card || typeof card.attackDamageReceivedTo !== "number") {
        return;
      }
      if (reduceResist.some((e) => resistanceFilterMatches(e.filter, card, card.name))) {
        return;
      }
      cap = cap === null ? card.attackDamageReceivedTo : Math.min(cap, card.attackDamageReceivedTo);
    });
    if (cap !== null && damage > cap) {
      damage = cap;
    }
  }
  return damage;
}

async function resolveFighterAttack(pending, attackers, attackerNames) {
  const defender = state.players[pending.defender];
  const defenseItemInfo = getPendingBattleTargetInfo(pending);
  let damage = attackers.reduce((total, attacker) => total + visibleCritical(attacker.card), 0);
  const reduceResist = applicableAttackResistances(attackers).filter((e) => (e.effects || []).includes("reduce"));
  // damageCannotBeReduced(『そのダメージは減らない』ドラム)は被ダメ上限(attackDamageReceivedTo=ディジエム『３に減らす』)
  // を貫通する（第10回メカレビュー是正）。裁定 rulings-d: ゴルドリッター「２になる」は減らす効果ではない＝貫通しない（Q553）。
  damage = applyAttackDamageReceivedCaps(pending, attackers, damage, reduceResist);
  const damageOptions = { log: false, byAttack: true };
  if (state.pendingAttack?.damageCannotBeReduced) {
    damageOptions.ignorePrevention = true; // 「そのダメージは減らない」(ドラム・ザ・フューチャー等)
  }
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
    const winnerBeforeItemDamage = state.winner;
    let dealtDamage = applyDamageToPlayerAsk(pending.defender, damage, damageOptions); // 任意コストの軽減は本人に問う
    if (dealtDamage?.then) dealtDamage = await dealtDamage;
    addDamageLog(
      `${attackerNames}の攻撃力${attackPower}が${defenseItemInfo.card.name}の防御力${itemDefense}以上のため、${defender.name}は${dealtDamage}ダメージを受けました。`,
      winnerBeforeItemDamage,
    );
    await runDamageDealtTriggers(attackers, pending, dealtDamage);
    applyWinOnFighterDamage(pending, dealtDamage);
    finishPendingAttack({ dealtDamage, battledDefenseItem: true });
    checkWinner();
    render();
    return;
  }

  const winnerBeforeDamage = state.winner;
  let dealtDamage = applyDamageToPlayerAsk(pending.defender, damage, damageOptions); // 任意コストの軽減は本人に問う
  if (dealtDamage?.then) dealtDamage = await dealtDamage;
  addDamageLog(`${defender.name}は${attackerNames}の攻撃で${dealtDamage}ダメージを受けました。`, winnerBeforeDamage);
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
  // E2: 攻撃されたモンスター本人だけが『反撃』する（バトル中に場を離れ、同エリアへ別のカードが入った場合は反撃しない）。
  if (targetSlot.instanceId != null && targetAfterBattle?.instanceId !== targetSlot.instanceId) {
    return;
  }
  // 反撃で破壊する攻撃者も、まだ場に居る本人に限る（反撃までの間に入れ替わった別カードを破壊しない）。
  attackers = attackers.filter((attacker) => {
    const now = attackerCardAt(attacker.owner, attacker.zone);
    return now && now.instanceId === attacker.card?.instanceId;
  });
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
      allowCancel: false, // T2: 解決途中の必須選択は強制（キャンセル不可）
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
    addDestroyLog(`${targetAfterBattle.name}の反撃で${attackerName}を破壊しました。`, attackerName);
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

// audit2(b053-4): 第2引数 extras.attackedCard＝戦闘で破壊される前の被攻撃カード実体（単体モンスター攻撃の経路が渡す）。
// state には積まず、allyBattleEnd 系の配信（queueBattleEndFieldTriggers）にだけ使う。
function finishPendingAttack(outcome = {}, extras = {}) {
  const pending = state.pendingAttack;
  if (!pending) {
    return;
  }
  state.lastAttackOutcome = {
    ...outcome,
    nullified: Boolean(outcome.nullified || pending.nullified),
    attackers: getPendingAttackerSlots(pending),
    ...lastAttackOutcomeAttackerInfo(pending),
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
      // audit2(b053-4): 被攻撃モンスターが戦闘で破壊されて場に無い（または別カードに入れ替わった）なら、
      // 呼び出し側が渡した破壊前のカード実体で配信する（「攻撃されたバトルの終了時」は破壊されても成立する）。
      const liveAttacked = state.players[pending.targetOwner]?.field?.[pending.targetZone];
      const frozenAttacked = extras.attackedCard || null;
      const attackedCard =
        frozenAttacked && liveAttacked?.instanceId !== frozenAttacked.instanceId ? frozenAttacked : liveAttacked;
      queueBattleEndFieldTriggers(pending.targetOwner, attackedCard, pending.targetZone, {
        nullified: false,
        attackerOwner: pending.attackerOwner,
        targetType: pending.targetType,
      });
    }
    // E-XV7(X-UB01/0052 道化師 ダークフォックス・X-UB02/0004 ブレザーフリル): 攻撃側カードを eventCard に
    // 「攻撃したバトルの終了時」を場全体へ放送する（attacker-side 誘発＝ally/opponentAttackerBattleEnd。
    // 直上 E-X1 の defender-side ally/opponentBattleEnd の姉妹実装）。fighter 攻撃でも『バトル』は成立する
    // ため targetType を問わず放送する。連携攻撃は攻撃者ごとに配信。
    // 注: 攻撃が無効化された場合も ver2.05 p.12-13 の 2.6.→3.3.→3.5. で『バトルの終了時』は解決するため、
    // nullifyPendingAttack 側からも同じ3系統を details.nullified=true で放送する（旧コメントの「無効化は非放送」は
    // ルール本文と食い違っていたため撤回）。
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
    scheduleTriggerJob(async () => {
        await runTriggeredAbilities(card, "battleEnd", { card, player: state.players[slot.owner], owner: slot.owner, zone: slot.zone });
        // 「このカードが攻撃したバトルの終了時、…このカードは『２回攻撃』を得る」型(フォーマルフリル 0008 等)は、
        // 上の battleEnd 誘発でキーワードが後付けされる。runAfterAttackTriggers(同期)はこの付与より前に走るため
        // スタンド判定に間に合わない。付与後のこの時点で、まだ場に残り(instanceId一致)レスト中(used)の攻撃カードを
        // 再判定してスタンドさせる。『Ｎ回攻撃』の N 別使用回数(multiAttackUses)のガードで二重スタンドは防がれる。
        // battleEnd 中に場を離れたカード(0012 の自己戻し等)は現在の場札と instanceId が不一致でスキップされる。
        const attackerNow = state.players[slot.owner]?.field?.[slot.zone];
        if (attackerNow && attackerNow.instanceId === attackerInstanceId && attackerNow.used) {
          requestMultiAttackStand({ owner: slot.owner, zone: slot.zone, card: attackerNow }); // E3: 解決中なら保留
        }
        render();
      }, (error) => {
        console.error(error);
        addLog(`${card.name}のバトル終了時能力の処理中にエラーが発生しました。`);
        render();
      }, slot.owner);
  });
  // F3: 被攻撃（防御）側 battleEnd の配信（includeDefender:true のみ）。
  if (defenderSlot) {
    const card = state.players[defenderSlot.owner]?.field?.[defenderSlot.zone];
    if (card && cardHasIncludeDefenderBattleEnd(card)) {
      scheduleTriggerJob(async () => {
          await runTriggeredAbilities(card, "battleEnd", {
            card,
            player: state.players[defenderSlot.owner],
            owner: defenderSlot.owner,
            zone: defenderSlot.zone,
            // includeDefender を明示した能力のみに絞る（他の bare battleEnd は防御側で発火させない）。
            __abilityFilter: (ability) => ability.includeDefender === true,
          });
          render();
        }, (error) => {
          console.error(error);
          addLog(`${card.name}のバトル終了時能力の処理中にエラーが発生しました。`);
          render();
        }, defenderSlot.owner);
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
// audit2(b053-4): 戦闘で破壊された被攻撃モンスターも、finishPendingAttack が呼び出し側から受け取った破壊前の
// カード実体（と元の defenderZone）で放送する（旧実装は null で打ち切り、非センターの被破壊を取りこぼしていた）。
// defenderCard が null になるのは、破壊前の実体も持たない経路（全体攻撃・防御アイテム等）だけ。
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
  scheduleTriggerJob(async () => {
      await runFieldEventTriggers("battleEnd", defenderOwner, defenderCard, defenderZone, details);
      render();
    }, (error) => {
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
  scheduleTriggerJob(async () => {
      // 逐次 await（連携攻撃の複数配信で limit 記帳が並列に抜けないように＝runTriggeredAbilities の作法）。
      for (const slot of frozen) {
        await runFieldEventTriggers("attackerBattleEnd", slot.owner, slot.card, slot.zone, { ...details });
      }
      render();
    }, (error) => {
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
    // 多回攻撃(2回/3回/4回/6回攻撃)のモンスターは、攻撃が無効化(ドラゴンシールド等)されても、残りの攻撃の
    // ために再スタンドする。無効化はその1回の攻撃を止めるだけで、多回攻撃による追加攻撃の権利は失われない。
    // 通常解決(finishPendingAttack→runAfterAttackTriggers)と同じ standAttackerForMultiAttack を通し、
    // 『Ｎ回攻撃』の N 別使用回数(multiAttackUses)の既存ガードで規定回数を超えてスタンドしないようにする。
    // 無効化パスは finishPendingAttack を経由せず自前で clearPendingAttack するため、ここで明示的に再判定する。
    // E3: ver2.05 では『Ｎ回攻撃』は 4.1（無効化した【対抗】の解決が終わった後）。無効化を含む効果の解決中に
    // 即スタンドすると、同じ効果の後半「そのターン中スタンドできない」(影縫いの術 X-BT03/0062)が間に合わない。
    // requestMultiAttackStand は能力本体の実行中なら解決し終わるまで保留し、それ以外（直接呼び出し等）は即時。
    requestMultiAttackStand(attacker);
  });
  state.lastAttackOutcome = {
    nullified: true,
    nullifiedBy: sourceName,
    attackers: getPendingAttackerSlots(pending),
    ...lastAttackOutcomeAttackerInfo(pending),
    targetOwner: pending.targetOwner,
    targetZone: pending.targetZone,
    targetType: pending.targetType,
    turnCount: state.turnCount, // E-Y5(0088): lastAttackNullified の同ターン窓限定用
  };
  // ver2.05『アタックフェイズの流れ』p.12-13 の裁定: 2.6.「攻撃しているカードまたは攻撃対象がなくなったり、
  // 攻撃が無効化された場合、3.3.に進みます。」→ 3.3.「この時点で、『攻撃中』『バトル中』の扱いが終了します。」
  // → 3.5.「『バトルの終了時』『攻撃の終了時』に発動する能力もここで解決します」。
  // つまり無効化で飛ばされるのは 3.1(ヒット判定)と 3.2(『貫通』『反撃』)だけで、『バトルの終了時』は解決する。
  // 以前は finishPendingAttack の !nullified ゲートに阻まれ、無効化時に battleEnd 系が一切発火しなかった
  // （ユーザー実プレイ報告: 正義の義賊 ムクロ「このカードのバトル終了時、このカードを手札に戻す」が不発。
  //  docs/BF-D-CBT_実装メモ:148 も『防御時/無効化時を取りこぼす』全体近似と明記していた既知ギャップ）。
  // 『Ｎ回攻撃』(4.1)は上の standAttackerForMultiAttack で既に処理済み。
  const nullifiedDefenderSlot =
    pending.targetType !== "fighter" && pending.targetOwner != null && pending.targetZone
      ? { owner: pending.targetOwner, zone: pending.targetZone }
      : null;
  queueBattleEndTriggers(state.lastAttackOutcome.attackers || [], nullifiedDefenderSlot);
  if (pending.targetType !== "fighter") {
    const attackedCard = state.players[pending.targetOwner]?.field?.[pending.targetZone];
    queueBattleEndFieldTriggers(pending.targetOwner, attackedCard, pending.targetZone, {
      nullified: true,
      attackerOwner: pending.attackerOwner,
      targetType: pending.targetType,
    });
  }
  queueAttackerBattleEndFieldTriggers(state.lastAttackOutcome.attackers || [], {
    nullified: true,
    targetOwner: pending.targetOwner,
    targetType: pending.targetType,
  });
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
  // ver2.05 アタックフェイズの流れ 3.2.1「連携攻撃の場合、攻撃に参加したカードのうち、『貫通』を持っているカード
  // すべてが、それぞれ1回ずつ『貫通』を発動させます」＝貫通持ちごとに1回ずつダメージを与える（以前は打撃力を合算して
  // 1回で与えていたため、1回ごとの軽減やしきい値＝竜装 ドラゴキーパー/竜王剣 ドラゴエンペラー等の結果が狂っていた）。
  // 貫通ダメージは「攻撃以外のダメージ」（竜装 ドラゴキーパー H-SS01/0016 公式テキスト「攻撃以外の君が受けるダメージを
  // １減らす。（『貫通』のダメージも減るぞ！）」）。よって「攻撃/連携攻撃によって受けるダメージ」の上限
  // （attackDamageCapFor＝合体戦士 ディジエム／linkAttackDamageCapFor＝ゴルドリッター）は掛けない
  // （byAttack を渡さない＝グラップルソウルの「攻撃によるダメージ0」が貫通に効かないのと同じ扱いに統一）。
  const penetrators = attackers.filter((attacker) => hasKeyword(attacker.card, "penetrate"));
  const defender = state.players[pending.defender];
  for (const attacker of penetrators) {
    if (state.winner !== null && state.winner !== undefined) {
      break; // 前の貫通で決着したら以降は与えない（engine-continuous 由来）
    }
    const penetrateDamage = visibleCritical(attacker.card);
    if (penetrateDamage <= 0) {
      continue;
    }
    const penetrateOptions = { log: false };
    if (state.pendingAttack?.damageCannotBeReduced || pending.damageCannotBeReduced) {
      penetrateOptions.ignorePrevention = true;
    }
    const reducePenetrateResist = applicableAttackResistances([attacker]).filter((e) => (e.effects || []).includes("reduce"));
    if (reducePenetrateResist.length > 0) {
      penetrateOptions.resistEntries = reducePenetrateResist;
    }
    let dealtDamage = applyDamageToPlayerAsk(pending.defender, penetrateDamage, penetrateOptions); // 任意コストの軽減は本人に問う
    if (dealtDamage?.then) dealtDamage = await dealtDamage;
    addLog(`貫通により${defender.name}に${dealtDamage}ダメージを与えました。`);
    await runDamageDealtTriggers([attacker], pending, dealtDamage);
    checkWinner();
  }
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
  // audit2(b055-2): 連携攻撃のダメージは1回（ver2.05）なのに、ダメージ源ごとに dealDamage/allyDealDamage を配るため、
  // 同じカードの同じ能力が源の数だけ発動していた。このダメージイベントの中では同一カード×同一能力を1回に限る。
  const firedInThisDamage = new Set();
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
      __oncePerEvent: firedInThisDamage,
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
        __oncePerEvent: firedInThisDamage,
      });
    }
  }
  // E-XB68(X2-BT01/0046 ルール・オブ・デプス): 攻撃ダメージの「両面」ブロードキャスト（新イベント attackDamageDealt）。
  //   上の dealDamage/allyDealDamage は攻撃者と“同じ owner”側にしか届かないため、別 owner の場札（＝相手の場の
  //   モンスターの攻撃を見ている自分の設置魔法）へは届かない。runFieldEventTriggers 型で両席へ配信し、攻撃者の逆側は
  //   opponentAttackDamageDealt を受ける（0046＝操骨 グラツィア 0065 の forceSelfAttack で相手モンスターが相手自身へ
  //   攻撃した時、自分の設置がこれを拾う）。これは既存 dealDamage/allyDealDamage とは別イベント名＝純粋な追加配信で、
  //   両者は重複しない（各場札は自席1本ぶんだけ受け取り、既存の runDamageDealtTriggers 配信は不変）。リスナー不在なら
  //   何もしない（既存カードに attackDamageDealt リスナーは無い＝挙動完全不変）。1回の runDamageDealtTriggers＝1配信。
  const primary = damageSources[0];
  if (primary?.card) {
    const hasAttackDamageListener = [0, 1].some((playerIndex) =>
      zones.some((zone) => {
        const c = state.players[playerIndex]?.field?.[zone];
        return (
          cardHasTriggeredListener(c, "allyAttackDamageDealt") ||
          cardHasTriggeredListener(c, "opponentAttackDamageDealt")
        );
      }),
    );
    if (hasAttackDamageListener) {
      await runFieldEventTriggers("attackDamageDealt", primary.owner, primary.card, primary.zone, {
        damage,
        defender: pending.defender,
        damageSource: primary,
      });
    }
  }
}

// 『Ｎ回攻撃』キーワード表（N → keyword 内部名・ログ表記）。5回攻撃は対象内DBに無いため欠番。
// 新しい『Ｎ回攻撃』を足すときはここに1行追加するだけでよい（standAttackerForMultiAttack が汎用に扱う）。
const MULTI_ATTACK_KEYWORDS = [
  { n: 2, keyword: "doubleAttack", label: "2回攻撃" },
  { n: 3, keyword: "tripleAttack", label: "３回攻撃" },
  { n: 4, keyword: "quadrupleAttack", label: "４回攻撃" }, // Z14(c)(S-UB-C03/0021)
  { n: 6, keyword: "sextupleAttack", label: "６回攻撃" }, // E-XB43(X-CBT01/0070 バールバッツ・ドラグロイヤー)
];

// rulings-e（2026-10-09 オーナー裁定・rule-continuous-7）: 『Ｎ回攻撃』の使用回数は N ごとの独立カウンタ
// card.multiAttackUses = { "2": 使ったスタンド数, "3": …, "4": …, "6": … }（各 N の上限は N−1）。
// 旧形式は doubleAttackUsed(bool)＋tripleAttackStandCount(3/4/6回攻撃の共用カウンタ)。旧フィールドは
// 互換のため「ミラー」として書き続ける（doubleAttackUsed = 2回攻撃を使ったか、tripleAttackStandCount =
// N≥3 の使用数の最大）。multiAttackUses が無い（旧セーブ・旧テスト・初期札）か、旧フィールドがミラーと
// 食い違う（外部から旧フィールドだけ書き換えた）場合は、旧フィールドから移行する。共用カウンタ t は旧挙動で
// 「3回攻撃なら残り 2−t、4回なら 3−t、6回なら 5−t」を意味したので、uses[N] = min(t, N−1) で完全に再現できる。
function multiAttackUsesMirror(uses) {
  let triple = 0;
  Object.keys(uses).forEach((key) => {
    if (Number(key) >= 3) {
      triple = Math.max(triple, uses[key] || 0);
    }
  });
  return { double: (uses["2"] || 0) >= 1, triple };
}

function writeMultiAttackLegacyMirror(card, uses) {
  const mirror = multiAttackUsesMirror(uses);
  card.doubleAttackUsed = mirror.double;
  card.tripleAttackStandCount = mirror.triple;
}

function ensureMultiAttackUses(card) {
  const current = card.multiAttackUses;
  if (current && typeof current === "object") {
    const mirror = multiAttackUsesMirror(current);
    if (mirror.double === !!card.doubleAttackUsed && mirror.triple === (card.tripleAttackStandCount || 0)) {
      return current;
    }
  }
  const uses = {};
  if (card.doubleAttackUsed) {
    uses["2"] = 1;
  }
  const shared = Math.max(0, Number(card.tripleAttackStandCount) || 0);
  if (shared > 0) {
    MULTI_ATTACK_KEYWORDS.forEach(({ n }) => {
      if (n >= 3) {
        uses[String(n)] = Math.min(shared, n - 1);
      }
    });
  }
  card.multiAttackUses = uses;
  writeMultiAttackLegacyMirror(card, uses);
  return uses;
}

// 攻撃解決後の『Ｎ回攻撃』のスタンド判定を1枚ぶん実行する（ver2.05 p20『Ｎ回攻撃』／アタックフェイズの流れ 4.2）。
// runAfterAttackTriggers（攻撃解決直後・同期）と queueBattleEndTriggers（battleEnd 誘発で多重攻撃
// キーワードが後付けされたカードの再判定）・無効化/対象消失経路の requestMultiAttackStand から呼ぶ。
// 裁定（2026-10-09 オーナー承認。公式Q&A Q800・Q3110）:
//  - 2回/3回/4回/6回攻撃は別々の能力で、それぞれ N−1 回ぶんの使用回数を持つ（同一の『Ｎ回攻撃』は重複しない）。
//  - 攻撃終了後のこの時点で、今持っていて使用回数が残っている『Ｎ回攻撃』は全て誘発し、誘発したもの全部が
//    1回ずつ消費する。ただしスタンドは1回だけ（Q800: H-EB03/0001 は2つ同時に誘発→両方消費→合計3回）。
//    よって最初から両方持つなら合計攻撃回数は max N（例: PR/0468 轟く雷鳴 バールバッツ 2回＋逆天4回 → 4回）。
//  - 一方の使用回数を使い切った後で別の『Ｎ回攻撃』を得たら、その能力は N−1 回まるごと残っている
//    （Q3110: 2回攻撃でスタンド後に3回攻撃を得る → さらに3回攻撃できる＝合計4回）。
function standAttackerForMultiAttack(card) {
  if (!card) {
    return;
  }
  // E3: 「そのターン中、スタンドできない」(preventStandThisTurn＝影縫いの術 X-BT03/0062・S-UB-C03/0038)を受けた
  // カードは多回攻撃でもスタンドしない（残スタンド回数も消費しない）。
  if (card.cannotStandThisTurn) {
    return;
  }
  const uses = ensureMultiAttackUses(card);
  const triggering = MULTI_ATTACK_KEYWORDS.filter(
    ({ n, keyword }) => (uses[String(n)] || 0) < n - 1 && hasKeyword(card, keyword),
  );
  if (!triggering.length) {
    return;
  }
  triggering.forEach(({ n }) => {
    uses[String(n)] = (uses[String(n)] || 0) + 1;
  });
  writeMultiAttackLegacyMirror(card, uses);
  card.used = false;
  addLog(`${card.name}は${triggering.map((entry) => entry.label).join("・")}でスタンドしました。`);
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
    // 攻撃対象が場を離れた → 攻撃終了。多回攻撃の攻撃者(生存分)は残りの攻撃のため再スタンドする
    // （対抗バウンス等でここに到達・無効化経路と対称。resolvePendingAttack の対象消失分岐と同型）。
    // E6: ver2.05 2.6→3.3→3.5『バトルの終了時』も解決し、lastAttackOutcome も更新する。
    endPendingAttackWithoutBattle("攻撃に関わるカードが場を離れたため、攻撃は終了しました。");
    return;
  }
  // 攻撃側カードが場を離れた場合、公式裁定は「連携攻撃ではなくなるが、残った1枚が攻撃する」。
  // 攻撃者が全て場を離れた時のみ攻撃を終了する（1枚でも残れば resolvePendingAttack が残存で続行）。
  // ※呼び出し時点で除去カードは既に場から外れているため getPendingAttackers() は生存分のみを返す。
  const wasAttacker = getPendingAttackerSlots(pending).some((attacker) => sameSlot(attacker, target));
  if (wasAttacker && getPendingAttackers().length === 0) {
    endPendingAttackWithoutBattle("攻撃に関わるカードが場を離れたため、攻撃は終了しました。");
  }
}

// E6: 攻撃しているカードまたは攻撃対象がなくなって攻撃が終わる時の終了処理（ver2.05 アタックフェイズの流れ
// 2.6「攻撃しているカードまたは攻撃対象がなくなったり、攻撃が無効化された場合、3.3.に進みます」→3.3『攻撃中』
// 『バトル中』の終了→3.5『バトルの終了時』『攻撃の終了時』の能力を解決→4.1『Ｎ回攻撃』）。無効化経路
// (nullifyPendingAttack) と同じく 3.1(ヒット判定)/3.2(貫通・反撃) だけを飛ばし、lastAttackOutcome を更新して
// battleEnd 系3放送と多回攻撃スタンドを行う。以前は addLog＋clearPendingAttack だけで、バトル終了時誘発が落ち、
// lastAttackOutcome も前の攻撃のまま残っていた。nullified は立てない（無効化ではない）。
function endPendingAttackWithoutBattle(message) {
  const pending = state.pendingAttack;
  if (!pending) {
    return;
  }
  if (message) {
    addLog(message);
  }
  // 場に残っている攻撃者（宣言時の本人のみ＝E2）。離場した攻撃者・入れ替わった別カードにはバトル終了時を配らない。
  const liveAttackers = getPendingAttackers();
  const liveSlots = liveAttackers.map((attacker) => ({
    owner: attacker.owner,
    zone: attacker.zone,
    instanceId: attacker.card.instanceId,
  }));
  state.lastAttackOutcome = {
    nullified: false,
    endedWithoutBattle: true,
    attackers: getPendingAttackerSlots(pending),
    ...lastAttackOutcomeAttackerInfo(pending),
    targetOwner: pending.targetOwner,
    targetZone: pending.targetZone,
    targetType: pending.targetType,
    turnCount: state.turnCount,
  };
  liveAttackers.forEach((attacker) => requestMultiAttackStand(attacker));
  const targetCard = pending.targetType !== "fighter" ? pendingAttackTargetCard(pending) : null;
  const defenderSlot =
    targetCard && pending.targetOwner != null && pending.targetZone
      ? { owner: pending.targetOwner, zone: pending.targetZone }
      : null;
  queueBattleEndTriggers(liveSlots, defenderSlot);
  if (pending.targetType !== "fighter") {
    queueBattleEndFieldTriggers(pending.targetOwner, targetCard, pending.targetZone, {
      nullified: false,
      attackerOwner: pending.attackerOwner,
      targetType: pending.targetType,
    });
  }
  queueAttackerBattleEndFieldTriggers(liveSlots, {
    nullified: false,
    targetOwner: pending.targetOwner,
    targetType: pending.targetType,
  });
  clearPendingAttack();
}

// E3: 多回攻撃のスタンド（ver2.05 4.1）の要求。能力本体の実行中（無効化/手札戻し等を含む効果の解決途中）なら、
// その解決が終わるまで保留する（state.deferredMultiAttackStands → flushDeferredMultiAttackStands）。能力本体の
// 外（直接呼び出し・攻撃税の不払い無効化・バトル終了時誘発の後）では即時に standAttackerForMultiAttack する。
// attacker: { owner, zone, card }。保留中に場を離れた/入れ替わった/既にスタンドしたカードはスタンド処理しない。
function requestMultiAttackStand(attacker) {
  const card = attacker?.card;
  if (!card) {
    return;
  }
  if (typeof abilityBodyDepth === "number" && abilityBodyDepth > 0) {
    state.deferredMultiAttackStands ||= [];
    state.deferredMultiAttackStands.push({
      owner: attacker.owner,
      zone: attacker.zone,
      instanceId: card.instanceId ?? null,
    });
    return;
  }
  standAttackerForMultiAttack(card);
}

function flushDeferredMultiAttackStands() {
  const entries = state.deferredMultiAttackStands;
  if (!entries?.length) {
    return;
  }
  if (typeof abilityBodyDepth === "number" && abilityBodyDepth > 0) {
    return; // まだ能力解決の途中（外側の解決終了時に再試行）
  }
  state.deferredMultiAttackStands = [];
  entries.forEach((entry) => {
    const card = attackerCardAt(entry.owner, entry.zone);
    if (!card || (entry.instanceId != null && card.instanceId !== entry.instanceId) || !card.used) {
      return;
    }
    standAttackerForMultiAttack(card);
  });
}

function getPendingAttacker() {
  return getPendingAttackers()[0]?.card || null;
}

function getPendingAttackers() {
  const pending = state.pendingAttack;
  if (!pending) {
    return [];
  }
  // E2: 宣言時の攻撃者(instanceId)が場を離れ、別のカードが同じエリアに入っていても攻撃者として扱わない。
  return getPendingAttackerSlots(pending)
    .map((slot) => ({ ...slot, card: pendingAttackerCardAt(slot) })) // E-XB54b: zone:"flag"→player.flag
    .filter((attacker) => attacker.card);
}

function getPendingAttackerSlots(pending) {
  return pending.attackers?.length
    ? pending.attackers
    : [{ owner: pending.attackerOwner, zone: pending.attackerZone }];
}

// audit2(b063-3 他): lastAttackOutcome に攻撃者の instanceId とカード情報の写し（compactCardForLog＝JSON 安全）を控える。
// バトル終了時の条件 lastAttackIsLink(src/13) が「このカードが（他の《X》と）連携攻撃したバトル」かを、スロットの
// 入れ替わりや連携相手の離場（反撃で破壊等）に左右されず判定するため。旧 state（未記録）では slots の instanceId を使う。
function lastAttackOutcomeAttackerInfo(pending) {
  const slots = getPendingAttackerSlots(pending);
  const cards = slots.map((slot) => {
    const card = pendingAttackerCardAt(slot);
    return card ? compactCardForLog(card) : null;
  });
  return {
    attackerInstanceIds: slots.map((slot, index) => slot.instanceId ?? cards[index]?.instanceId ?? null),
    attackerCards: cards,
  };
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
    const card = pendingAttackerCardAt(slot); // E-XB54b: zone:"flag"→player.flag／E2: 同一性確認
    if (card?.instanceId) {
      ids.add(card.instanceId);
    }
  });
  if (pending.targetType === "monster") {
    const target = pendingAttackTargetCard(pending); // E2
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


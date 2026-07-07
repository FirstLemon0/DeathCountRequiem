// ==========================================================================
// buddyfight モジュール 09 — 攻撃宣言・連携・攻撃トリガー・フェイズ移行
// 旧 app.js L3327-3776 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
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

async function performAttackDeclaration(attackers, targetValue, options = {}) {
  const attackerSeat = attackers[0]?.owner;
  // forceSelfAttack: そのモンスターが自分の持ち主（＝使用者の相手）を攻撃する（ナイトメア・ディスペアー 0020）。
  // 防御側＝そのモンスターの持ち主自身。通常攻撃は opponentIndex()（手番側の相手）。
  const targetOwner = options.forceSelfAttack ? (attackerSeat ?? opponentIndex()) : opponentIndex();
  const opponent = state.players[targetOwner];
  // setAttackRedirectThisTurn: このターン、この席の攻撃対象を指定モンスターへ強制変更（0061）。強制自攻撃には適用しない。
  const redirect = options.forceSelfAttack ? null : state.attackRedirectThisTurn?.[attackerSeat];
  if (redirect && targetValue !== redirect.instanceId) {
    const redirectZone = zones.find(
      (zone) => state.players[redirect.owner]?.field?.[zone]?.instanceId === redirect.instanceId,
    );
    if (redirectZone && redirect.owner === 1 - attackerSeat) {
      targetValue = redirectZone; // 生存する敵モンスターへ対象を差し替え
    }
  }
  if (!attackers.every((attacker) => canAttackTargetValue(attacker, targetValue))) {
    addLog("この攻撃対象には攻撃できません。");
    return false;
  }
  if (targetValue === "fighter" && !options.forceSelfAttack && opponent.field.center) {
    if (!canAttackFighterThroughCenter(attackers)) {
      addLog(`${opponent.name}のセンターにモンスターがいるため、ファイターを攻撃できません。`);
      return false;
    }
  }
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
      return activeContinuousEffects(sourceCard).some(
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
    // 「相手のモンスター全てと相手（ファイター）に攻撃する」フラグ（アジ・ダハーカ）。
    attackAllIncludesFighter:
      attackAllTargetZones.length > 0 && Boolean(firstAttacker.card.attackAllIncludesFighter),
    // 「その攻撃で相手にダメージを与えたなら勝利」(チェック・メイト 0074)。
    winOnFighterDamage: Boolean(options.winOnFighterDamage),
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
  await runFighterAttackedTriggers(attackers);
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
  if (options.forceSelfAttack) {
    // 「そのモンスターで相手（＝そのモンスターの持ち主）を攻撃する」(ナイトメア・ディスペアー 0020)。
    // そのモンスターの持ち主(owner)のファイターへ強制攻撃する（対象選択・センターブロック判定なし）。
    return performAttackDeclaration([attacker], "fighter", options);
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
  if (options.forceTargetValue && candidates.some((c) => c.value === options.forceTargetValue)) {
    // 対象を強制指定（チェック・メイト 0074 は必ずファイターへ攻撃）。可能な時のみ適用。
    targetValue = options.forceTargetValue;
  } else if (candidates.length > 1) {
    const selected = await chooseCardEntries(
      candidates.map((candidate) => ({ value: candidate.value, card: candidate.card })),
      {
        title: `${card.name}の攻撃対象`,
        lead: "攻撃する対象を選んでください。",
        min: 1,
        max: 1,
        forceDialog: true,
        promptSeat: owner, // 攻撃者の持ち主の席へ（CPU対戦/権威サーバの誤配送防止）
      },
    );
    if (selected?.length) {
      targetValue = selected[0].value;
    }
  }
  return performAttackDeclaration([attacker], targetValue, options);
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
    const redirects = activeContinuousEffects(card).some(
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

// 「君（ファイター）が攻撃された時」の誘発（H-SS01 五角竜王 紅蓮のドラム等）。
// 本体攻撃（targetType:"fighter"）の宣言時に、防御側プレイヤーの場札の
// kind:"triggered" event:"fighterAttacked" を発火する。redirect 系 effect による対象変更が起きたら
// もうファイター攻撃ではないため、以降の場札への発火は打ち切る。
async function runFighterAttackedTriggers(attackers) {
  const pending = state.pendingAttack;
  if (!pending || pending.targetType !== "fighter") {
    return;
  }
  const defender = pending.defender;
  for (const zone of zones) {
    const card = state.players[defender]?.field?.[zone];
    if (!card) {
      continue;
    }
    if (!(card.abilities || []).some((ability) => ability.kind === "triggered" && ability.event === "fighterAttacked")) {
      continue;
    }
    await runTriggeredAbilities(card, "fighterAttacked", {
      card,
      player: state.players[defender],
      owner: defender,
      zone,
      attackers,
      attack: pending,
    });
    if (state.pendingAttack?.targetType !== "fighter") {
      break;
    }
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
    // 場全体への攻撃誘発（allyAttack/opponentAttack）。設置魔法等の「(味方の)カードが攻撃した時」用（0047/0075）。
    await runFieldEventTriggers("attack", attacker.owner, attacker.card, attacker.zone, {
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
      promptSeat: attacker.owner, // 効果の持ち主の席へ（CPU対戦/権威サーバの誤配送防止）
      purpose: "hostile",
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
  // destroyAttackedMonsterWithSoulDrop（0039 付与）: 攻撃対象の相手モンスターのソウル1枚をドロップし、そのモンスターを破壊。
  for (const attacker of attackers) {
    if (!hasKeyword(attacker.card, "destroyAttackedMonsterWithSoulDrop")) {
      continue;
    }
    const pa = state.pendingAttack;
    if (!pa || pa.targetType !== "monster" || pa.targetZone == null) {
      continue;
    }
    const defenderOwner = pa.targetOwner;
    const attacked = state.players[defenderOwner]?.field?.[pa.targetZone];
    if (!attacked) {
      continue;
    }
    if ((attacked.soul?.length || 0) > 0) {
      const soulCard = attacked.soul.pop();
      state.players[defenderOwner].drop.push(soulCard);
      addLog(`${attacker.card.name}の効果で${attacked.name}のソウルから${soulCard.name}をドロップゾーンに置きました。`);
    }
    await destroyFieldCard(defenderOwner, pa.targetZone, {
      cause: { byEffect: true, byOpponent: true, sourceOwner: attacker.owner, sourceName: attacker.card.name, sourceCard: attacker.card },
    });
  }
  // 連携攻撃（attackers が2枚以上）なら、攻撃側のフィールドイベント allyLinkAttack を発火する。
  // 攻撃カード自身でなく場全体（設置魔法など）へ届く「味方が連携攻撃した時」（THE チームワーク等）。
  if (attackers.length > 1) {
    const linkOwner = attackers[0]?.owner;
    if (linkOwner !== undefined && linkOwner !== null) {
      await runFieldEventTriggers("linkAttack", linkOwner, attackers[0].card, attackers[0].zone, {
        attackers,
        attack: state.pendingAttack,
      });
    }
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
        // 持ち主の席へ問う（CPU対戦でCPUの移動を人間に聞かない。権威サーバの誤配送防止も兼ねる）。
        promptSeat: owner,
        purpose: "move", // CPU対戦(src/22): センター空きなら center へ、それ以外は移動しない
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


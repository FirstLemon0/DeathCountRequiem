// ==========================================================================
// buddyfight モジュール 09 — 攻撃宣言・連携・攻撃トリガー・フェイズ移行
// 旧 app.js L3327-3776 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
// ファイナルフェイズに攻撃宣言できるカードか。ver2.05では攻撃はアタックフェイズのみで、
// 例外は「このカードは君のファイナルフェイズ中にも攻撃できる」を持つ必殺モンスター（カード注記）。
// 将来「ファイナルフェイズにも攻撃できる」を印字する通常カードが出たら canAttackInFinalPhase フラグで表す。
// 効果による攻撃（performAttackDeclaration 直呼び。「もう1度攻撃」等）はこのゲートを通らない（従来通り）。
function canDeclareAttackInFinal(card) {
  if (!card) {
    return false;
  }
  // 印字フラグ（必殺モンスター／将来の canAttackInFinalPhase 印字カード）。
  if (card.type === "impactMonster" || card.canAttackInFinalPhase) {
    return true;
  }
  // G5(D-EB01/0023): 場を離れるまで付与される instance フラグ（無償コールした魔王等。
  // resetLeftFieldCardState で解除）。
  if (card.grantedFinalPhaseAttack) {
    return true;
  }
  // G5(D-EB01/0027/0015): 他カードが継続/ターン継続/ソウルで付与する grantFinalPhaseAttack。
  return grantsFinalPhaseAttack(card);
}

// G5(D-EB01): 場の他カードの継続(＋turnContinuous)またはソウル内カードの soulContinuous が、
// grantFinalPhaseAttack{controller,zoneIn,filter,excludeSource} で card にファイナル攻撃可を付与しているか。
// 0027=addTurnContinuous によるターン付与（自場のワイダーサカー/妖精へ）／0015=ソウル在の自分が host 武器へ。
// grantFinalPhaseAttack 継続を1つも持たない既存カードでは常に false を返す（高速パス・後方互換）。
function grantsFinalPhaseAttack(card) {
  if (!card || !state?.players) {
    return false;
  }
  const targetSlot = findFieldCardSlot(card); // zones は item/set 枠も含むためアイテムも対象になり得る
  if (!targetSlot) {
    return false;
  }
  const fromField = state.players.some((player, sourceOwner) =>
    zones.some((zone) => {
      const source = player.field[zone];
      if (!source) {
        return false;
      }
      return activeContinuousEffects(source).some((effect) => {
        if (effect.op !== "grantFinalPhaseAttack") return false;
        if (effect.controller === "self" && targetSlot.owner !== sourceOwner) return false;
        if (effect.controller === "opponent" && targetSlot.owner === sourceOwner) return false;
        if (effect.excludeSource && source.instanceId === card.instanceId) return false;
        if (effect.zoneIn && !effect.zoneIn.includes(targetSlot.zone)) return false;
        if (effect.filter && !matchesCardFilter(card, effect.filter)) return false;
        // 条件付き付与への備え: continuousEffectApplies(src/05) と同じく effect.conditions を発生源基準で評価する
        //（引数形は checkCardConditions(conditions, sourceOwner, {card:発生源, zone, targetCard})）。
        // 現行 D-EB01 の grantFinalPhaseAttack は conditions を持たないため挙動不変（将来の条件付きカード向け）。
        if (
          effect.conditions?.length &&
          !checkCardConditions(effect.conditions, sourceOwner, { card: source, zone, targetCard: card })
        ) {
          return false;
        }
        return true;
      });
    }),
  );
  if (fromField) {
    return true;
  }
  // ソウル内カードの soulContinuous grantFinalPhaseAttack（host==target=武器 も許容。soulContinuousGrantsOp が
  // controller/filter/能力無効化を判定）。
  return soulContinuousGrantsOp(card, "grantFinalPhaseAttack");
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
  if (state.phase === "final" && !canDeclareAttackInFinal(card)) {
    addLog("ファイナルフェイズに攻撃できるのは必殺モンスターだけです。");
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
    // E-PR1(PR/0075 アーマナイト・ハティー): 「相手の場のカードは連携攻撃できない」。相手の場の
    // restrictLinkAttack 継続が適用されるカードは連携の攻撃者に加われない（単独攻撃は select→attack で可）。
    if (linkAttackRestricted(card)) {
      addLog(`${card.name}は連携攻撃できません。`);
      return;
    }
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
  // ver2.05: ファイナルフェイズに攻撃宣言できるのは必殺モンスター等の例外持ちのみ（連携相手も同様）。
  if (state.phase === "final" && attackers.some((attacker) => !canDeclareAttackInFinal(attacker.card))) {
    addLog("ファイナルフェイズに攻撃できるのは必殺モンスターだけです。");
    return;
  }
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
  // E-PR1(PR/0075 アーマナイト・ハティー): 「相手の場のカードは連携攻撃できない」（攻撃側の抑止）。
  // 連携(攻撃者2枚以上)に restrictLinkAttack を受ける攻撃者が含まれるなら宣言を拒否する（単独攻撃は不変）。
  // UI(toggleLinkAttacker)・効果(attackWithAll 等 performAttackDeclaration 直呼び)いずれの経路もここを通る。
  // 既存カードは restrictLinkAttack を持たず linkAttackRestricted は常に false（高速パス・後方互換）。
  if (attackers.length > 1) {
    const blockedAttacker = attackers.find((attacker) => linkAttackRestricted(attacker.card));
    if (blockedAttacker) {
      addLog(`${blockedAttacker.card.name}は連携攻撃できません。`);
      return false;
    }
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
  // E-XB40(X-BT04/0008 天晶の祝福): 席別の攻撃宣言回数（攻撃者席で加算）。攻撃はターンプレイヤーのみが行うため
  // firstAttacker.owner は常に state.active。resolveAmountFrom source:"attacksThisTurn" の controller 指定が参照する
  // （0008「相手のカードが攻撃した回数」＝相手席のカウンタ）。旧 state（room 復元前）にも ||= で安全初期化。
  state.attacksThisTurnBySeat ||= [0, 0];
  state.attacksThisTurnBySeat[firstAttacker.owner] += 1;
  for (const attacker of attackers) {
    await restFieldCard(attacker.owner, attacker.zone, attacker.card, { reason: "attack" });
  }
  // 攻撃者のレスト誘発、および直前バトルの遅延 battleEnd（queueBattleEndTriggers が Promise で切り離す
  // detached microtask。上の await 境界で流れ込む）が、攻撃者/攻撃対象を場から除去して
  // handleDestroyedDuringPending→clearPendingAttack を走らせると、この時点で state.pendingAttack は
  // 既に null になり得る（例: H-PP01/0063 闇の貴公子 キルナイトの「バトル終了時、自身を手札に戻す」が
  // 次の攻撃宣言のレスト待ちで解決するケース）。以降の宣言処理は targetLabel(pending) 等で pending を
  // 参照するため、無効化された攻撃はここで安全に中断する（攻撃者は既にレスト済み＝宣言済み扱いで整合）。
  if (!state.pendingAttack) {
    render();
    return false;
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
  // Z12(a)(S-UB-C03/0009): redirectAttackToFilter — 攻撃対象を、条件に一致する防御側の自陣カードへ変更する
  // （redirectAttackToSelfの一般化。対象は継続の発生源自身とは限らない。一致ゼロなら変更なし）。
  for (const zone of zones) {
    const source = state.players[defenderOwner]?.field?.[zone];
    if (!source) {
      continue;
    }
    const redirectEffect = activeContinuousEffects(source).find(
      (effect) =>
        effect.op === "redirectAttackToFilter" &&
        checkCardConditions(effect.conditions || [], defenderOwner, { card: source, zone }),
    );
    if (!redirectEffect) {
      continue;
    }
    const allowedZones = Array.isArray(redirectEffect.zones) ? redirectEffect.zones : zones;
    const newZone = allowedZones.find((z) => {
      const candidate = state.players[defenderOwner]?.field?.[z];
      return candidate && matchesCardFilter(candidate, redirectEffect.filter || {});
    });
    // 一致ゼロ(newZone undefined)や既に当該ゾーンが対象なら、この継続源では変更しない。
    // 他のリダイレクト源も評価できるよう return ではなく continue（複数源の将来ケース対応）。
    if (!newZone || pending.targetZone === newZone) {
      continue;
    }
    const newCard = state.players[defenderOwner].field[newZone];
    pending.targetZone = newZone;
    pending.targetType = effectiveCardType(newCard) === "monster" ? "monster" : "fieldCard";
    addLog(`${newCard.name}の効果で攻撃対象が${newCard.name}に変更されました。`);
    return;
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
      // Z14(f)(S-UB-C03/0022,0029): 連携攻撃メンバー一覧（eventAttackersInclude条件opが参照）。
      attackers,
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
    // E1/F2: ホスト存命のままソウル1枚がドロップへ → soulCardDropped。
    queueSoulCardDroppedTriggers(current, target.owner, 1);
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
      // E1/F2: この時点でホスト存命 → soulCardDropped。直後の destroyFieldCard で離場したら
      // queueSoulCardDroppedTriggers の発火時再検証が不発化する（破壊が置換等で防がれた時のみ発火）。
      queueSoulCardDroppedTriggers(attacked, defenderOwner, 1);
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
  // E10(D-CBT/0110 ヒートウェーブ): setNextAllyAttackTrigger のワンショット予約を消費する。
  // 予約者(entry.owner)の味方攻撃カードが attackerFilter に一致したら、その予約を1件消費して effects を
  // 実行する（対象選択は発火時＝R5近似(a)・promptSeat=予約者）。複数予約が同時に一致すれば各予約とも
  // 発火する（各エントリ1回ずつのワンショット。0110 を2枚使えばそれぞれ独立に誘発する原文semantics）。
  if (Array.isArray(state.nextAllyAttackTriggers) && state.nextAllyAttackTriggers.length > 0) {
    for (const attacker of attackers) {
      const queue = state.nextAllyAttackTriggers;
      for (let index = 0; index < queue.length; ) {
        const entry = queue[index];
        if (entry.owner === attacker.owner && matchesCardFilter(attacker.card, entry.attackerFilter || {})) {
          queue.splice(index, 1); // 先に消費（effects 中の再帰的攻撃や例外でも二重発火しない）
          await fireNextAllyAttackTrigger(entry, attacker, attackers);
        } else {
          index += 1;
        }
      }
    }
  }
}

// E10: setNextAllyAttackTrigger 予約エントリ1件の発火本体。chooseTarget があれば発火時に対象選択
// （promptSeat=予約者の席・chooseAbilityTarget 経由）→ effects は "$target" 参照で解決する。
// 対象候補が場に無ければ effects を解決せずログのみ（予約は消費済み＝ワンショット厳守）。
async function fireNextAllyAttackTrigger(entry, attacker, attackers) {
  const owner = entry.owner;
  const sourceCard = entry.sourceCard || { name: entry.sourceName || "効果" };
  const context = {
    card: sourceCard,
    owner,
    player: state.players[owner],
    vars: {},
    attack: state.pendingAttack,
    attackers,
  };
  addLog(`${sourceCard.name}の効果が${attacker.card.name}の攻撃により発動しました。`);
  if (entry.chooseTarget) {
    const chosen = await chooseAbilityTarget(sourceCard, { target: entry.chooseTarget }, owner);
    if (!chosen) {
      addLog(`${sourceCard.name}の効果の対象がないため、解決されませんでした。`);
      return;
    }
    context.target = chosen;
  }
  await executeAbilityEffects(entry.effects || [], context);
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
      // E-XU4(0043 グミスライム): 相手継続で『移動』が封じられているカードは移動を提示しない。
      .filter(({ card }) => card && hasKeyword(card, "move") && !monsterMovementRestricted(card));
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


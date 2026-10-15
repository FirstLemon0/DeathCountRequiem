// ==========================================================================
// buddyfight モジュール 04 — ドロー/ダメージ/ゲージ/コスト支払い
// 旧 app.js L881-1758 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
// FE2(X-BT01/0124 ガエン): 「次の相手のターン中、相手はカードを引くことができない」。state.drawBans に
// {owner, remainingTurnEnds} を積み、owner の自分のターン中(state.active===owner)は全ドローを封じる。
// 通常ドローステップ・チャージドロー・効果ドローを一律に止める（drawCards が全経路の関門）。
// state 常駐＝room 復元(JSON往復)/リプレイ安全。remainingTurnEnds は endTurn(src/11)が毎ターン端で1減算。
function drawBanActive(owner) {
  return state?.active === owner && (state?.drawBans || []).some((entry) => entry.owner === owner);
}

function drawCards(player, count = 1, shouldLog = true) {
  const drawerIndex = Array.isArray(state?.players) ? state.players.indexOf(player) : -1;
  if (drawerIndex >= 0 && drawBanActive(drawerIndex)) {
    if (shouldLog) {
      addLog(`${player.name}は効果によりカードを引けません。`);
    }
    return 0;
  }
  let drawn = 0;
  for (let index = 0; index < count; index += 1) {
    if (player.deck.length === 0) {
      if (shouldLog) {
        addLog(`${player.name}のデッキが0枚です。`);
      }
      declareDeckLoss(player);
      return drawn;
    }
    const card = player.deck.pop();
    if (card) {
      player.hand.push(card);
      drawn += 1;
      // 「（相手が）カードを引いた時」誘発（1枚ごと。H-BT04/0008）。
      // createPlayer の初期手札ドロー時は state.players 未構築のため発火しない（indexOf が -1）。
      if (drawerIndex >= 0) {
        queueDrewTriggers(drawerIndex);
      }
      if (player.deck.length === 0) {
        if (shouldLog) {
          addLog(`${player.name}のデッキが0枚になりました。`);
        }
        declareDeckLoss(player);
        return drawn;
      }
    }
  }
  return drawn;
}

// E-XB52(X-CBT01/0009 天元晶竜 アトラ・アダマント 第3条項「君のカードの効果で相手に与えるダメージは減らない」):
// ダメージ源(sourceOwner)の場に、継続 ownEffectDamageUnreducible を持つカードがアクティブに在るか。
// 発生源側視点＝受け手の軽減系（damageReceivedReduction / damagePrevention キュー）をバイパスするゲート。
// conditions（「センターにいるなら」等）があれば評価する（preventOpponentEffectDamage ガードと同じ配線）。
function ownEffectDamageUnreducibleActive(sourceOwner) {
  const src = state.players[sourceOwner];
  if (!src) {
    return false;
  }
  // E-XB64(X2-BT01/0052 逆雷の源泉③): card-anchored な場札の継続に加え、プレイヤー単位のターン限定継続
  //   （state.turnPlayerContinuous[sourceOwner]）も走査する。魔法発の匿名アンカーはここに積まれ、conditions は
  //   毎評価する（「君の場にヤミゲドウがいるなら」＝ownFieldCardExists）。発生源カードが無いので context は owner のみ。
  //   store が空/未初期化の既存 state では以下は常に false（後方互換・E-XB52 のフィールド走査は不変）。
  const playerStore = state.turnPlayerContinuous?.[sourceOwner] || [];
  if (
    playerStore.some(
      (e) =>
        e.op === "ownEffectDamageUnreducible" &&
        (!e.conditions?.length || checkCardConditions(e.conditions, sourceOwner, { owner: sourceOwner, player: src })),
    )
  ) {
    return true;
  }
  return zones.some((zone) => {
    const fieldCard = src.field[zone];
    return (
      fieldCard &&
      activeContinuousEffects(fieldCard).some(
        (e) =>
          e.op === "ownEffectDamageUnreducible" &&
          (!e.conditions?.length ||
            checkCardConditions(e.conditions, sourceOwner, { card: fieldCard, owner: sourceOwner, zone, player: src })),
      )
    );
  });
}

// 裁定 rulings-d（公式Q&A Q1018/Q677/Q553/Q165/Q1602〜1605）: ダメージ防止/軽減プリミティブの3分類。
//   (a) "noDamage" 「ダメージを受けない」「無効」 … 『減らない』ダメージにも効く（Q1018 アステール vs ガルガンチュア・
//       パニッシャー!!＝受けない／Q1605 バーンノヴァ救援の「そのターン中ダメージを受けない」は打撃力∞も受けない）。
//   (b) "setZero" 「ダメージは０になる／Nになる」（変更） … 減らす効果ではない＝『減らない』ダメージにも効く
//       （Q677 グラップルソウル vs ドラム・ザ・フューチャー／Q553・Q1604 ゴルドリッター「２になる」）。
//   (c) "reduce"  「０に減らす」「N減らす」「軽減」 … 『減らない』ダメージには効かない（Q165・Q1602）。
// 『減らない』の全フレーバー（dealDamage.ignorePrevention＝必殺技/魔法の「このカードのダメージは減らない」、
// pendingAttack.damageCannotBeReduced＝ドラム等、ownEffectDamageUnreducible＝アトラ・アダマント/逆雷の源泉、
// attackResistances{effects:["reduce"]}＝「このカードが相手に与えるダメージは減らない」）は (c) だけを無効にする。
// キューのエントリは生成時に damageClass を持つ。旧 state（部屋復元）の未付与エントリは形から導出する。
function damagePreventionClass(prevention) {
  if (prevention?.damageClass) {
    return prevention.damageClass;
  }
  if (prevention?.preventAll && !prevention.reduceToZero) {
    // 旧形: onlyAttack の preventAll はグラップルソウル（preventAttackDamageThisTurn「０になる」）だけが生成していた。
    return prevention.onlyAttack ? "setZero" : "noDamage";
  }
  return "reduce";
}

// 継続 preventOpponentEffectDamage: 「君は相手のカードの効果でダメージを受けない」恒常（H-BT04/0109）＝分類(a)。
// 該当する場札（ガード）を返す（無ければ null）。applyDamageToPlayer と任意コストの事前確認（prepareDamageDecisions）で共用。
function opponentEffectDamageGuardCard(owner, options = {}) {
  const player = state.players[owner];
  if (!player || options.byAttack || !Number.isInteger(options.sourceOwner) || options.sourceOwner === owner) {
    return null;
  }
  return (
    zones
      .map((zone) => ({ zone, fieldCard: player.field[zone] }))
      .find(
        ({ zone, fieldCard }) =>
          fieldCard &&
          activeContinuousEffects(fieldCard).some(
            (e) =>
              e.op === "preventOpponentEffectDamage" &&
              (!e.conditions?.length ||
                checkCardConditions(e.conditions, owner, { card: fieldCard, owner, zone, player })),
          ),
      )?.fieldCard || null
  );
}

// 継続 damageReceivedReduction の適用（監査 rule-continuous-3 / rule-damage-3: 別々の継続軽減はそれぞれ適用する）。
// 適用順は受け手に有利な順＝閾値付き（「N以上のダメージを受ける場合」）と full（0に減らす）を先、定量軽減を後にし、
// 閾値は各段階の残りダメージで判定する。任意コスト付き（optionalCost）は最後（強制の軽減で足りるなら払わずに済む）。
// decide(cap): 任意コスト付きの軽減を「払って適用する」なら true。null を返すと走査を打ち切る（事前確認の探索用）。
// options.dryRun: ログを出さない（事前確認の探索用）。戻り値は軽減後の残りダメージ（打ち切り時は { stopAt: cap }）。
function continuousDamageReductionPass(owner, remaining, options, reductionResisted, namedIgnored, decide, passOptions = {}) {
  const player = state.players[owner];
  const reductionEntries = damageReceivedReductionEntries(owner, Boolean(options.byAttack), remaining, options.sourceOwner, options.sourceCard)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Number(Boolean(a.entry.optionalCost)) - Number(Boolean(b.entry.optionalCost)) || (b.entry.threshold || 0) - (a.entry.threshold || 0) || Number(b.entry.full) - Number(a.entry.full) || a.index - b.index)
    .map(({ entry }) => entry);
  for (const cap of reductionEntries) {
    if (remaining <= 0) {
      break;
    }
    // 攻撃側の reduce 耐性(『相手に与えるダメージは減らない』ジャックナイフ等)は、キュー型の damagePrevention だけ
    // でなく継続 damageReceivedReduction(ドラゴエンペラー等)も貫通する（ver2.05: 「減らない」は「減らす」に優先）。
    // 耐性の発生源一致は軽減ごとに判定する。
    if (reductionResisted(cap.sourceCard, cap.source) || namedIgnored(cap.source) || (cap.threshold && remaining < cap.threshold)) {
      continue;
    }
    if (cap.optionalCost) {
      const decision = decide(cap);
      if (decision === null) {
        return { stopAt: cap };
      }
      if (!decision) {
        continue;
      }
    }
    const amount = cap.full ? remaining : cap.amount;
    const reduced = Math.max(0, remaining - amount);
    if (reduced !== remaining && !passOptions.dryRun) {
      addLog(`${cap.source || "効果"}により${player.name}が受けるダメージを${remaining - reduced}減らしました。`);
    }
    remaining = reduced;
  }
  return remaining;
}

// 任意コスト付き軽減（メラク・プリドゥエン）の確認の同一性キー（事前確認→同期適用の受け渡し用）。
function optionalDamageReductionKey(cap) {
  return `${cap.sourceCard?.instanceId || ""}|${cap.source || ""}|${cap.amount || 0}`;
}

// applyDamageToPlayer と同じ判定（『減らない』・耐性・名称無視）を options から作る。
function damageReductionResistance(owner, options = {}) {
  const sourceUnreducible =
    !options.ignorePrevention &&
    !options.byAttack &&
    Number.isInteger(options.sourceOwner) &&
    options.sourceOwner !== owner &&
    ownEffectDamageUnreducibleActive(options.sourceOwner);
  const unreducible = Boolean(options.ignorePrevention) || sourceUnreducible;
  const ignoreNames = options.ignoreNamedPreventions || (options.ignoreNamedPrevention ? [options.ignoreNamedPrevention] : []);
  const resistEntries = options.resistEntries || [];
  return {
    unreducible,
    reductionResisted: (sourceCard, sourceName) =>
      unreducible || resistEntries.some((e) => resistanceFilterMatches(e.filter, sourceCard, sourceName)),
    namedIgnored: (sourceName) => ignoreNames.some((n) => (sourceName || "").includes(n)),
  };
}

// 統合 follow-up（pt-fix-e の残課題）: 任意コスト付き軽減の「払ってよい」を、非同期の文脈では本人に問う。
// applyDamageToPlayer は同期の合流点で確認UI/権威サーバ往復を待てないため、呼ぶ前にこの事前確認で
// confirmChoiceAsync（アプリ内UI・権威サーバ往復・CPU 席は AI・リプレイ記録/再生）を通し、払うならここで払い、
// 決定を options に載せる（同期の適用はそれを消費するだけ）。問う必要が無ければ何もしない。
function nextOptionalDamageReductionToAsk(owner, amount, options = {}) {
  const player = state.players[owner];
  if (!player || !(amount > 0) || opponentEffectDamageGuardCard(owner, options)) {
    return null;
  }
  const { unreducible, reductionResisted, namedIgnored } = damageReductionResistance(owner, options);
  if (unreducible) {
    return null;
  }
  const decisions = options.__optionalCostDecisions || {};
  const result = continuousDamageReductionPass(
    owner,
    amount,
    options,
    reductionResisted,
    namedIgnored,
    (cap) => {
      const key = optionalDamageReductionKey(cap);
      if (Object.prototype.hasOwnProperty.call(decisions, key)) {
        return decisions[key];
      }
      return canPayStructuredCost(player, cap.optionalCost || [], { sourceCard: cap.sourceCard || null }).ok ? null : false;
    },
    { dryRun: true },
  );
  return result && typeof result === "object" ? result.stopAt : null;
}

function damageNeedsAsyncDecision(owner, amount, options = {}) {
  if (options.__optionalCostPrepared) {
    return false;
  }
  return Boolean(nextOptionalDamageReductionToAsk(owner, amount, options));
}

async function prepareDamageDecisions(owner, amount, options = {}) {
  options.__optionalCostDecisions ||= {};
  for (let guard = 0; guard < 8; guard += 1) {
    const cap = nextOptionalDamageReductionToAsk(owner, amount, options);
    if (!cap) {
      break;
    }
    const player = state.players[owner];
    const message = `${cap.source || "効果"}のコストを払って、受けるダメージを${cap.amount || 0}減らしますか？`;
    const answer = await confirmChoiceAsync(owner, message, {
      purpose: "damageReductionOptionalCost",
      yesLabel: "払って減らす",
      noLabel: "払わない",
    });
    const paid = Boolean(answer) && Boolean(payStructuredCost(player, cap.optionalCost || [], { sourceCard: cap.sourceCard || null }).ok);
    options.__optionalCostDecisions[optionalDamageReductionKey(cap)] = paid;
  }
  options.__optionalCostPrepared = true;
  return options;
}

// 非同期の文脈からのダメージ適用。任意コストの確認が要る時だけ Promise を返す（要らなければ同期の数値＝tick 不変）。
// 呼び出し側: let dealt = applyDamageToPlayerAsk(...); if (dealt?.then) dealt = await dealt;
function applyDamageToPlayerAsk(owner, amount = 0, options = {}) {
  if (!damageNeedsAsyncDecision(owner, amount, options)) {
    return applyDamageToPlayer(owner, amount, options);
  }
  return prepareDamageDecisions(owner, amount, options).then(() => applyDamageToPlayer(owner, amount, options));
}

function applyDamageToPlayer(owner, amount = 0, options = {}) {
  const player = state.players[owner];
  if (!player || amount <= 0) {
    return 0;
  }
  state.damagePrevention ||= [[], []];
  state.damagePrevention[owner] ||= [];
  let remaining = amount;
  // E-XB52: ダメージ源側の ownEffectDamageUnreducible（アトラ・アダマント）が「効果ダメージ（!byAttack）を
  // 相手（sourceOwner!==owner）へ与える」場合、受け手の軽減(c)だけをバイパスする＝『減らない』ダメージ（(c) 軽減を全て無効）。
  // 軽減/無効の無視判定: 名称配列(後方互換) または attackResistances由来の filter エントリ（「このカードが与えるダメージは
  // 減らない」＝発生源一致の (c) 軽減だけを無効にする）。名称指定の無視（旧 ignoreNamedPrevention）は「そのカードはこの攻撃に
  // 適用しない」＝分類を問わず素通りしキューに残す。判定は任意コストの事前確認と共用（damageReductionResistance）。
  const { unreducible, reductionResisted, namedIgnored } = damageReductionResistance(owner, options);
  // 継続 preventOpponentEffectDamage: 「君は相手のカードの効果でダメージを受けない」恒常（H-BT04/0109）＝分類(a)。
  // 『減らない』ダメージにも効く（Q1018: アステールの場で相手のガルガンチュア・パニッシャー!!のダメージは受けない）。
  // 攻撃ダメージ(byAttack)と自分発のダメージ（コストの damageSelf 等 sourceOwner===owner）には効かない。
  // F1(D-BT02/0123): エントリの conditions を評価する（「このカードがセンターにいるなら」＝sourceZoneIn 等）。
  // 受けないダメージには軽減の任意コスト確認（メラク等）も出さないよう、軽減より先に判定する。
  const guardCard = opponentEffectDamageGuardCard(owner, options);
  if (guardCard) {
    addLog(`${guardCard.name}の効果で${player.name}は相手の効果によるダメージを受けません。`);
    return 0;
  }
  // 継続 damageReceivedReduction（分類(c)。装備者が受けるダメージを amount 減らす／full＝「０に減らす」。
  // nonAttackOnly:true は攻撃以外のダメージ限定(マグナグレイス0011)、既定は全ダメージ(0056)。
  // byOpponent:true は相手席発のダメージ限定(X-UB01/0007 結晶魔王アトラ)＝options.sourceOwner を渡して判定）。
  if (!unreducible) {
    remaining = continuousDamageReductionPass(owner, remaining, options, reductionResisted, namedIgnored, (cap) =>
      // audit2(b015-2): 「君がダメージを受ける時、[コスト]を払ってよい。払ったら、そのダメージをN減らす」
      // （メラク H-BT03/0022・プリドゥエン BT04/0037）。ダメージ1回ごとに払うかを確認し、払った時だけ軽減する。
      payOptionalDamageReductionCostSync(owner, cap, options),
    );
  }
  if (remaining <= 0) {
    return 0;
  }
  const queue = state.damagePrevention[owner];
  // 適用したキューエントリの「君のライフを＋N」（チェレックス！/黒竜の盾等「０に減らし、君のライフを＋１する」）。
  // Q189: ライフ＋１は軽減効果の発動時＝ダメージを受ける時に行う（使用時ではない）。ダメージ適用後にまとめて加算する。
  let pendingLifeGain = 0;
  const lifeGainSources = [];
  let i = 0;
  while (remaining > 0 && i < queue.length) {
    const prevention = queue[i];
    const damageClass = damagePreventionClass(prevention);
    if (namedIgnored(prevention.source)) {
      // この攻撃には適用しない（キューには残す）
      i += 1;
      continue;
    }
    if (prevention.whileCond && !whileConditionsHold(prevention)) {
      // 裁定 R9: 「そのターン中、〜なら」の継続条件を今は満たしていない＝適用しない（キューには残す）。
      // 分類(a)〜(c)の判定より先に見る（継続条件を満たさない間は『受けない』でも適用されない）。
      i += 1;
      continue;
    }
    if (prevention.onlyAttack && !options.byAttack) {
      // 「攻撃によって受けるダメージ」限定の防止は、攻撃以外のダメージには適用しない（キューには残す）。
      i += 1;
      continue;
    }
    if (prevention.threshold && remaining < prevention.threshold) {
      // 「N以上のダメージを受ける時」限定の軽減は、N未満のダメージには適用しない（キューには残す）。
      i += 1;
      continue;
    }
    // (c) 軽減は『減らない』ダメージを減らせない。「次に受けるダメージ」としてはこのダメージに適用済み（一度きりなら消費）
    // で、付随する「ライフ＋１」は行う（Q165 ガルガンチュア・パニッシャー!! vs チェレックス！）。
    const cannotReduce = damageClass === "reduce" && reductionResisted(prevention.sourceCard, prevention.source);
    let reduction = 0;
    if (!cannotReduce) {
      reduction = damageClass !== "reduce" || prevention.preventAll ? remaining : Math.min(remaining, prevention.amount || 0);
    }
    remaining -= reduction;
    if (damageClass === "reduce" && !prevention.preventAll && !cannotReduce) {
      prevention.amount = Math.max(0, (prevention.amount || 0) - reduction);
    }
    if (reduction > 0) {
      addLog(
        damageClass === "reduce"
          ? `${prevention.source || "効果"}により${player.name}へのダメージを${reduction}減らしました。`
          : `${prevention.source || "効果"}により${player.name}はダメージ${reduction}を受けませんでした。`,
      );
    } else if (cannotReduce) {
      addLog(`${prevention.source || "効果"}ではこのダメージを減らせません（ダメージは減らない）。`);
    }
    if (prevention.gainLife > 0) {
      pendingLifeGain += prevention.gainLife;
      lifeGainSources.push(prevention.source || "効果");
    }
    // once!==false: 一度きり（消費）。once:false の preventAll/残量ありは消費せずターン中持続。
    const exhausted = !prevention.preventAll && (prevention.amount || 0) <= 0;
    if (prevention.once !== false || exhausted) {
      queue.splice(i, 1);
    } else {
      i += 1;
    }
  }
  // 非致死ダメージ: options.floorLife 指定時、このダメージで受け手のライフが floorLife 未満になるなら floorLife で止める。
  // （ミネウチでござる 0109「このダメージで相手のライフが0になるなら、かわりに相手のライフは1になる」）。
  if (options.floorLife !== undefined && remaining > 0) {
    const maxLoss = Math.max(0, player.life - options.floorLife);
    if (remaining > maxLoss) {
      remaining = maxLoss;
    }
  }
  if (remaining > 0) {
    player.life -= remaining;
    // 受けたダメージ量を記録（豪胆逆怒などの「受けたダメージと同じ数値分」効果が参照する）
    state.lastDamageTaken ||= [0, 0];
    state.lastDamageTaken[owner] = remaining;
    // E-X2(X-SD02/0016 クリスタル・フローレス・シュート！): このターン中に owner席が受けた実ダメージ
    // （軽減/無効化を通過した最終値）を席別に累積する。applyDamageToPlayer は戦闘・効果・必殺技の全ダメージが
    // 合流する単一 funnel であり、ここが実適用点(player.life -= remaining)。payLife 等コストの直減算は funnel 外
    // ＝計上しない（＝原文「君がダメージを受けていない」に忠実）。条件op damageTakenThisTurn(src/13)が参照・
    // clearTurnModifiers(src/11)でリセット・createInitialState(src/03)で初期化。state 常駐で room 復元(JSON往復)
    // 後も保たれ、旧 state に無くても安全なようガード付き ||= で初期化する（E8 deckMilledThisTurn と同型）。
    state.turnDamageTaken ||= [0, 0];
    state.turnDamageTaken[owner] = (state.turnDamageTaken[owner] || 0) + remaining;
    if (options.log !== false && options.sourceName) {
      addLog(`${options.sourceName}により${player.name}に${remaining}ダメージを与えました。`);
    }
    applyPreventionLifeGain(owner, pendingLifeGain, lifeGainSources, options);
    // 効果/必殺技ダメージの後にも「ダメージを受けた時」対抗窓(counterEventWindow)を開く。
    // 戦闘ダメージは runDamageDealtTriggers 側でより詳細に設定するためここでは開かない(byAttack)。
    // 発生源 owner が判っている効果ダメージのみ対象（コスト/ライフリンク等の発生源不明ダメージでは開かない＝安全）。
    // これにより黒竜の盾(解決前予防)や五角竜王ドラム等の被弾時対抗が、戦闘に限らず正しいタイミングで機能する。
    if (!options.byAttack && options.sourceOwner !== undefined) {
      openDamageReceivedCounterWindow(owner, remaining, options);
    }
    // E-Y6: この致死に限り受け手の lifeZeroReplacement/safeguard を抑止する（0048/0028）。
    // フラグはこの checkWinner の同期実行だけの寿命＝直後に必ず解除するので room 復元スナップショットには残らない。
    if (options.suppressLifeZeroReplacement) {
      state.suppressLifeZeroReplacementFor = owner;
    }
    checkWinner();
    state.suppressLifeZeroReplacementFor = null;
    // 「君がダメージを受けた時」誘発（五角竜王ドラム等）。同期経路のため microtask で遅延発火。
    queueDamageReceivedTriggers(owner, remaining, options);
  } else {
    applyPreventionLifeGain(owner, pendingLifeGain, lifeGainSources, options);
  }
  return remaining;
}

// 裁定 rulings-d: キューの防止/軽減エントリに付いた「君のライフを＋N」（damagePrevention.gainLife）をダメージ適用後に行う。
// Q189: ＋１は軽減効果の発動時（使用時ではない）。Q165: 『減らない』ダメージで軽減できなくても＋１は行う。
// Q1612（×天バスター系 suppressLifeZeroReplacement）: 「このカードで相手のライフが０になった場合、相手のカードで相手の
// ライフは変更されない」＝このダメージでライフ0以下になったなら＋１は行われない（ライフ0のまま）。
function applyPreventionLifeGain(owner, gain, sources, options = {}) {
  const player = state.players[owner];
  if (!player || !(gain > 0)) {
    return;
  }
  const sourceLabel = sources.join("・") || "効果";
  if (options.suppressLifeZeroReplacement && player.life <= 0) {
    addLog(`${sourceLabel}のライフ＋${gain}は行われません（ライフは変更されない）。`);
    return;
  }
  if (typeof isLifeGainByEffectPrevented === "function" && isLifeGainByEffectPrevented(owner)) {
    addLog(`${player.name}は効果でライフを回復できません。`);
    return;
  }
  player.life += gain;
  addLog(`${sourceLabel}の効果で${player.name}のライフを${gain}回復しました。`);
  if (typeof clearWinnerIfNoCurrentLoss === "function") {
    clearWinnerIfNoCurrentLoss();
  }
  // 「ライフが回復した時」誘発（gainLife op と同じ lifeGained 放送）。同期 funnel のため trigger job で遅延発火。
  if (typeof scheduleTriggerJob === "function" && typeof runFieldEventTriggers === "function") {
    scheduleTriggerJob(async () => {
      await runFieldEventTriggers("lifeGained", owner);
    });
  }
}

// 効果/必殺技ダメージ後の「ダメージを受けた時」対抗窓。発生源(カード/owner)を凍結して counterEventWindow へ。
// lastDamageSourceMatches(相手カード由来判定) / selfReceivedDamage(被弾者判定) がこの窓で真になる。
function openDamageReceivedCounterWindow(defender, damage, options = {}) {
  if (damage <= 0) {
    return;
  }
  const src = { card: options.sourceCard || null, owner: options.sourceOwner, zone: null, source: "field" };
  const event = {
    kind: "damageDealt",
    source: src,
    sources: [src],
    sourceCard: options.sourceCard ? compactCardForLog(options.sourceCard) : null,
    sourceOwner: options.sourceOwner,
    defender,
    damage,
    turnCount: state.turnCount,
    phase: state.phase,
  };
  // 被弾側の対抗窓(lastDamageSourceMatches/selfReceivedDamage)だけを開く。
  // 攻撃側視点の単発参照 state.lastDamageEvent や turnDamageEvents は戦闘専用のまま触らない
  // （戦闘ダメージ→効果ダメージが連続した時に、直前戦闘の「与ダメージ」参照カードを潰さないため）。
  state.counterEventWindow = event;
}

// audit2(b015-2): 継続 damageReceivedReduction{optionalCost} の「払ってよい」を同期で確認し、払えたら true。
// applyDamageToPlayer は同期の合流点なので、確認は tryLeaveFieldReplacementSync(src/11) と同じ方式
// （リプレイ再生＝記録値／CPU席＝src/22 が同期回答／ブラウザ＝window.confirm／非対話（権威サーバ・ヘッドレス）＝払う）。
// 非同期の文脈からの適用（applyDamageToPlayerAsk）は事前確認（prepareDamageDecisions）で本人に問い済み＝その決定を使う。
function payOptionalDamageReductionCostSync(owner, entry, damageOptions = {}) {
  // 事前確認（prepareDamageDecisions）済み: 払う/払わないは確定・支払いも済んでいる。未確認の分（事前確認の時点で払えなかった）は払わない。
  if (damageOptions.__optionalCostPrepared) {
    return Boolean(damageOptions.__optionalCostDecisions?.[optionalDamageReductionKey(entry)]);
  }
  const player = state.players[owner];
  const cost = entry.optionalCost || [];
  const sourceCard = entry.sourceCard || null;
  if (!player || !canPayStructuredCost(player, cost, { sourceCard }).ok) {
    return false;
  }
  const message = `${entry.source || "効果"}のコストを払って、受けるダメージを${entry.amount || 0}減らしますか？`;
  let answer;
  if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
    answer = replayNextConfirm();
  } else if (typeof aiShouldAnswerPrompt === "function" && aiShouldAnswerPrompt(owner)) {
    answer = aiAnswerConfirmSync(owner, message, { purpose: "damageReductionOptionalCost" });
    if (typeof replayRecordConfirm === "function") {
      replayRecordConfirm(answer);
    }
  } else if (typeof appChoiceUiAvailable === "function" && appChoiceUiAvailable()) {
    // ブラウザ: applyDamageToPlayer は同期の合流点で確認UIを待てない。ネイティブ確認は出さず、権威サーバと
    // 同じ既定（払う）で確定し、確認応答として記録する（再生は上の replayNextConfirm で同じ値を消費）。
    answer = true;
    if (typeof replayRecordConfirm === "function") {
      replayRecordConfirm(answer);
    }
  } else if (typeof window !== "undefined" && typeof window.confirm === "function") {
    answer = Boolean(window.confirm(message));
    if (typeof replayRecordConfirm === "function") {
      replayRecordConfirm(answer);
    }
  } else {
    answer = true;
  }
  if (!answer) {
    return false;
  }
  return Boolean(payStructuredCost(player, cost, { sourceCard }).ok);
}

// 継続 damageReceivedReduction を持つ場札から、owner が受けるダメージの軽減設定（最も減らせる1件）を返す。
// nonAttackOnly:true は byAttack===false の時のみ適用（攻撃以外限定。マグナグレイス0011）。
// attackOnly:true は byAttack===true の時のみ適用（攻撃限定。E-ZA2/X-SS02/0002 ソル・アステール）。既定は全ダメージ(0056)。
// byOpponent:true は sourceOwner が相手席の時のみ適用（相手のカードの効果で受けるダメージ限定。X-UB01/0007 結晶魔王アトラ）。
// E-XB27(R24): sourceCardType（例 "monster"）はダメージ発生源カードの種別限定（「モンスターの効果で」X-BT03/0044）。
// full:true は threshold 以上のダメージを 0 に減らす（軽減量=incomingDamage 相当＝全額。「N以上のダメージを0に減らす」）。
function damageReceivedReductionFor(owner, byAttack, incomingDamage = Infinity, sourceOwner = undefined, sourceCard = undefined) {
  // 後方互換: 「最も減らせる1件」を返す旧 API（applyDamageToPlayer は damageReceivedReductionEntries で全件を順に適用する）。
  let best = null;
  damageReceivedReductionEntries(owner, byAttack, incomingDamage, sourceOwner, sourceCard).forEach((entry) => {
    if (entry.threshold && incomingDamage < entry.threshold) {
      return;
    }
    const amount = entry.full && Number.isFinite(incomingDamage) ? incomingDamage : entry.amount;
    // audit2(b015-2): 任意コスト付きの軽減は払うか未定なので「確実に減らせる」見積もりには含めない。
    if (entry.optionalCost) {
      return;
    }
    if (amount > 0 && (!best || amount > best.amount)) {
      best = { amount, source: entry.source, sourceCard: entry.sourceCard };
    }
  });
  return best;
}

// 監査 rule-continuous-3 / rule-damage-3: 適用可能な継続 damageReceivedReduction を全件返す（ver2.05 ③3「永続能力の
// 効果 能力に示された条件を満たしている間、常にその効果を発揮します」＝別カードの軽減はそれぞれ独立して効く）。
// エントリ形 {amount, full, threshold, source, sourceCard}。threshold/full の判定は applyDamageToPlayer が各段階の
// 残りダメージで行う（ここでは incomingDamage による閾値の事前判定をしない）。
function damageReceivedReductionEntries(owner, byAttack, incomingDamage = Infinity, sourceOwner = undefined, sourceCard = undefined) {
  const entries = [];
  // 監査 rule-continuous-1: 発生源から切り離したターン限定 damageReceivedReduction（バッツ・ザ・スピリット
  // 「そのターン中、君が攻撃で受けるダメージを１減らす」）。発生源の席＝受け手のときだけ（controller:"opponent" 以外）。
  const turnSourced = turnSourcedContinuousEntries("damageReceivedReduction")
    .filter(({ seat, effect }) => seat === owner && effect.controller !== "opponent")
    .map(({ effect, entry }) => ({ effect, source: { name: entry.sourceName, id: entry.sourceId, instanceId: entry.sourceInstanceId }, zone: null }));
  const fromField = [];
  zones.forEach((zone) => {
    const source = state.players[owner]?.field?.[zone];
    activeContinuousEffects(source).forEach((effect) => fromField.push({ effect, source, zone }));
  });
  [...fromField, ...turnSourced].forEach(({ effect, source, zone }) => {
    {
      if (effect.op !== "damageReceivedReduction" || effect.controller === "opponent") {
        return;
      }
      // Z4(S-UB-C03/0039): 継続 damageReceivedReduction の conditions を評価する（位置限定等）。
      // 0039「このカードがセンターにいるなら、君が受けるダメージを2減らす」は
      // conditions:[{op:"sourceZoneIn",zones:["center"]}] を持つ。context に発生源カードの
      // 在ゾーン(zone)と所有者(owner)を渡し、sourceZoneIn が in-center 判定できるようにする。
      if (effect.conditions?.length && !checkCardConditions(effect.conditions, owner, { card: source, zone, owner })) {
        return;
      }
      if (effect.nonAttackOnly && byAttack) {
        return; // 攻撃以外限定の軽減は攻撃ダメージには効かない
      }
      // E-ZA2(X-SS02/0002 超光星竜 ジャックナイフ "ソル・アステール"): attackOnly:true は byAttack===false の時のみ
      // スキップする（攻撃限定＝「君が攻撃で受けるダメージを2減らす」。nonAttackOnly の完全対称）。既存カードでの
      // 使用は0件＝この分岐を踏むエントリは無いため、attackOnly 未指定の従来挙動は完全に不変。
      if (effect.attackOnly && !byAttack) {
        return; // 攻撃限定の軽減は攻撃以外（効果/必殺技）のダメージには効かない
      }
      // F1(X-UB01/0007 結晶魔王アトラ): byOpponent:true は「相手のカードの効果で受けるダメージ」限定。
      // sourceOwner（発生源の席）が相手席（整数かつ owner と異なる）の時のみ適用する。sourceOwner 未供給
      // （攻撃ダメージ・発生源不明のライフリンク/コスト減算等）では適用しない安全側＝preventOpponentEffectDamage
      // (04-cost-resource.js 上部)と同じ sourceOwner 配線を再利用。既存の damageReceivedReduction 使用カードは
      // byOpponent 非保持＝この分岐を踏まず挙動完全不変（DB全数監査済み）。
      if (effect.byOpponent && !(Number.isInteger(sourceOwner) && sourceOwner !== owner)) {
        return;
      }
      // 「N以上のダメージを受ける場合」限定（threshold）は applyDamageToPlayer が各段階の残りダメージで判定する。
      // E-XB27(X-BT03/0044 沈んだ海底遺跡): sourceCardType＝「モンスターの効果で」等、ダメージ発生源カードの
      // 種別限定。発生源カードが無い（攻撃/コスト/ライフリンク等）か種別不一致なら適用しない（安全側）。
      // 既存の damageReceivedReduction 使用カードは sourceCardType 非保持＝この分岐を踏まず挙動完全不変。
      if (effect.sourceCardType && !(sourceCard && cardTypeMatches(sourceCard, effect.sourceCardType))) {
        return;
      }
      // full:true は threshold 以上のダメージを 0 にする＝軽減量を incomingDamage 全額にする（「0に減らす」）。
      // 既定は amount 分の部分軽減（従来）。incomingDamage 未供給時（Infinity）は full を適用できないため amount へフォールバック。
      // sourceCard も返す: 攻撃側の reduce 耐性(『相手に与えるダメージは減らない』)が、この軽減の発生源に
      // 一致するかを applyDamageToPlayer 側で resistanceFilterMatches で判定してスキップするため。
      if (effect.full || (effect.amount || 0) > 0) {
        entries.push({
          amount: effect.amount || 0,
          full: Boolean(effect.full),
          threshold: effect.threshold || 0,
          source: source?.name,
          sourceCard: source,
          ...(Array.isArray(effect.optionalCost) && effect.optionalCost.length ? { optionalCost: effect.optionalCost } : {}),
        });
      }
    }
  });
  // engine-inter: 発生源が場を離れた後も残る「そのターン中、君が受けるダメージを減らす」（X-CBT01/0011 等。
  // カードに残った __turnEffect を離場時に退避したもの）。threshold/full は applyDamageToPlayer が段階ごとに判定する。
  detachedTurnContinuousSources(owner).forEach((entry) => {
    entry.turnContinuous.forEach((effect) => {
      if (effect.op !== "damageReceivedReduction" || effect.controller === "opponent") return;
      if (effect.nonAttackOnly && byAttack) return;
      if (effect.attackOnly && !byAttack) return;
      if (effect.byOpponent && !(Number.isInteger(sourceOwner) && sourceOwner !== owner)) return;
      if (effect.sourceCardType && !(sourceCard && cardTypeMatches(sourceCard, effect.sourceCardType))) return;
      if (effect.full || (effect.amount || 0) > 0) {
        entries.push({ amount: effect.amount || 0, full: Boolean(effect.full), threshold: effect.threshold || 0, source: entry.name, sourceCard: entry });
      }
    });
  });
  // Z4(f)(S-UB-C03/0051): 【対抗】等で付与されたターン限定ダメージ軽減（state.turnDamageReductions）。
  // 監査 rule-damage-3: 場の継続軽減と同じく、別々の効果は加算する。
  (state.turnDamageReductions || []).forEach((entry) => {
    if (entry.owner !== owner) {
      return;
    }
    const amount = entry.amount || 0;
    if (amount > 0) {
      entries.push({ amount, full: false, threshold: 0, source: "ターン限定効果", sourceCard: null });
    }
  });
  return entries;
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
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
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

// E-XB38(X-BT04/0006 "降魔王剣" レヴァンティン「君の手札のアイテム全ては、追加で【装備コスト】ゲージ1を払う。を得る」):
// 場の継続 grantAdditionalCost が、指定パイル(既定 hand)の filter 一致カードへ purpose のコスト行を「追加で」与える。
// costReduction（コスト減）とは独立レイヤで、canPay/pay の両方が通る cardCostSteps で合流する。既存カードは
// grantAdditionalCost 継続を持たない＝additionalCostSteps は常に []＝コスト算出はバイト不変（後方互換）。
function additionalCostSteps(player, card, purpose) {
  const ownerIndex = state.players.indexOf(player);
  if (ownerIndex < 0) {
    return [];
  }
  const out = [];
  state.players.forEach((sourcePlayer, sourceOwner) => {
    zones.forEach((zone) => {
      const source = sourcePlayer.field[zone];
      activeContinuousEffects(source).forEach((e) => {
        if (e.op !== "grantAdditionalCost") return;
        if ((e.purpose || "equip") !== purpose) return;
        // controller: self(既定)=発生源と同席の pile／opponent=相手席の pile。
        const targetOwner = e.controller === "opponent" ? 1 - sourceOwner : sourceOwner;
        if (targetOwner !== ownerIndex) return;
        // pile: card が targetOwner の指定パイル（既定 hand）に実在するか（instanceId 照合）。
        const pile = e.pile || "hand";
        if (!(state.players[targetOwner]?.[pile] || []).some((c) => c.instanceId === card.instanceId)) return;
        if (e.filter && !matchesCardFilter(card, e.filter)) return;
        (e.steps || []).forEach((st) => out.push(deepClone(st)));
      });
    });
  });
  return out;
}

// E-XB38: レガシーコスト（card.equipCost/callCost/castCost = {gauge,life}）を構造化コスト step へ変換する。
// 追加コスト継続が有るとき、印字レガシーコスト＋追加行を1本の構造化コストに合流させるために使う（軽減も反映）。
function legacyCostToSteps(player, card, purpose) {
  const legacyKey = { call: "callCost", cast: "castCost", equip: "equipCost" }[purpose];
  const legacy = adjustedLegacyCost(player, card, purpose, card[legacyKey]);
  const out = [];
  if ((legacy.gauge || 0) > 0) out.push({ op: "payGauge", amount: legacy.gauge });
  if ((legacy.life || 0) > 0) out.push({ op: "payLife", amount: legacy.life });
  return out;
}

function cardCostSteps(player, card, purpose, context = {}) {
  const rawCost = card.costs?.[purpose] ?? context.cost;
  const hasStructured = Array.isArray(rawCost);
  const additional = additionalCostSteps(player, card, purpose); // E-XB38（無ければ [] ＝従来と完全一致）
  if (additional.length === 0) {
    if (!hasStructured) {
      return { exists: false, steps: [] };
    }
    return {
      exists: true,
      // E-XU3: コール元ゾーン（context.callFromZone）を軽減判定へ橋渡し（「手札以外から」ゲート）。
      steps: adjustedCostSteps(player, card, purpose, rawCost, { callFromZone: context.callFromZone }),
    };
  }
  // E-XB38: 追加コスト有り。印字コスト（構造化 or レガシー変換）＋追加行を1本の構造化コストに合流する
  //（印字コスト無しアイテムには追加行だけが付く）。
  const baseSteps = hasStructured
    ? adjustedCostSteps(player, card, purpose, rawCost, { callFromZone: context.callFromZone })
    : legacyCostToSteps(player, card, purpose);
  return { exists: true, steps: [...baseSteps, ...additional] };
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

function costReductionApplies(reduction, card, purpose, options = {}) {
  if ((reduction.purpose || "cast") !== purpose || !matchesCardFilter(card, reduction.filter || {})) {
    return false;
  }
  // フェイズ/状況限定のコスト軽減（0070: アタックフェイズ中のみ魔法ゲージ-2）。
  if (reduction.conditions && !checkCardConditions(reduction.conditions, state.active, {})) {
    return false;
  }
  // E-XU3(X-UB01/0019 サツキ・パレス): 「手札以外からコールする場合」限定の軽減。コール元ゾーンが判明
  // していて、かつ除外ゾーンに含まれない時だけ適用する。ゾーン不明（通常の手札コール等＝callFromZone 未供給）は
  // 非適用＝後方互換（callFromZoneNot を持たない既存 costReduction はこの分岐を素通り＝挙動完全不変）。
  // audit2(b078-6): コール元ゾーン未供給は通常の手札コール＝"hand" とみなす（通常コール/奇襲コールは
  // callMonsterImpl が明示供給）。callFromZoneIn は「手札からコールする場合」等の包含限定（アンディ BT05/0032）。
  const fromZone = options.callFromZone || "hand";
  if (Array.isArray(reduction.callFromZoneNot) && reduction.callFromZoneNot.includes(fromZone)) {
    return false;
  }
  if (Array.isArray(reduction.callFromZoneIn) && !reduction.callFromZoneIn.includes(fromZone)) {
    return false;
  }
  return true;
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

function adjustedCostSteps(player, card, purpose, costSteps = [], options = {}) {
  const steps = deepClone(costSteps || []);
  fieldCostReductions(player).forEach((r) => {
    if (!costReductionApplies(r, card, purpose, options)) return;
    const payOp = r.payOp || "payGauge";
    const step = steps.find((st) => st.op === payOp && (st.amount || 0) > 0);
    if (step) step.amount = Math.max(0, step.amount - (r.amount || 1));
  });
  // コストstepの動的自己軽減 reduceByFieldCount:{filter, per, controller}
  // 「君の場の《72柱》1枚につき、払うゲージが1少なくなる」（H-PP01/0046）。カード級コスト
  // （use/call/equip等）と能力コストの主経路はこの関数を通る（誘発コスト・破壊置換・callSelfFromHand も
  // adjustedCostSteps 経由に統一済み）。
  const ownerIndex = state.players.indexOf(player);
  steps.forEach((step) => {
    if (!step.reduceByFieldCount || (step.amount || 0) <= 0) return;
    const spec = step.reduceByFieldCount;
    const countOwner = spec.controller === "opponent" ? 1 - ownerIndex : ownerIndex;
    const countPlayer = state.players[countOwner];
    let count = 0;
    zones.forEach((zone) => {
      const fieldCard = countPlayer?.field?.[zone];
      if (fieldCard && matchesCardFilter(fieldCard, spec.filter || {})) count += 1;
    });
    step.amount = Math.max(0, step.amount - count * (spec.per ?? 1));
  });
  // E-XB16(X-BT03/0100 轟天雷槍): コストstepの動的自己軽減の amountFrom 版。「払うゲージは、このターン中、
  // 君のカードが攻撃した回数分、少なくなる」＝reduceByAmountFrom:{source:"attacksThisTurn"}。reduceByFieldCount と
  // 同じ「支払い量を減らす」枠で、削減量を resolveAmountFrom(src/15)で算出する（attacksThisTurn 等の context 非依存
  // ソース向け。owner だけ渡す最小 context）。reduceByAmountFrom を持たない既存 step は素通り＝完全に後方互換。
  steps.forEach((step) => {
    if (!step.reduceByAmountFrom || (step.amount || 0) <= 0) return;
    const reduce = Math.max(0, Math.round(resolveAmountFrom(step.reduceByAmountFrom, { owner: ownerIndex })));
    step.amount = Math.max(0, step.amount - reduce);
  });
  return steps.filter((step) => step.amount === undefined || step.amount > 0);
}

function hasFieldKeyword(player, keyword) {
  return zones.some((zone) => {
    const card = player.field[zone];
    return card && hasKeyword(card, keyword);
  });
}

// E3(D-BT04/0033 グラトス): discardSoulToDeckBottom コストの最小支払い枚数。
// amountFrom（例 {source:"targetStat", stat:"critical"}＝選んだ対象の打撃力）指定時はその値を最小量とする
// （allowMore:true なら支払い時にソウル残数まで追加で払える＝「以上」）。amountFrom 未指定は従来の固定量
// （step.amount || 1）＝既存の固定呼び出しは完全に不変。resolveAmountFrom は context.target?.card を読むため、
// 効果対象は effectTargetForCost 専用キー（src/13 が渡す）から供給し、既存の context.target 経路には触れない。
function discardSoulToDeckBottomFloor(step, context = {}) {
  if (step.amountFrom) {
    const amountContext = { target: context.effectTargetForCost || context.target, owner: context.owner };
    return Math.max(0, Math.round(resolveAmountFrom(step.amountFrom, amountContext)));
  }
  return step.amount || 1;
}

function canPayStructuredCost(player, costSteps = [], context = {}) {
  const selectedCard = context.selectedCard;
  const includeOpponentGauge = Boolean(context.includeOpponentGauge);
  const applicableCostSteps = costSteps.filter((step) => costStepApplies(player, step, context));
  let gaugeNeeded = 0;
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge") {
      // 複数の payGauge ステップは同じゲージを二重に当てにできない。累計で判定する
      // （例: [payGauge3, payGauge4] はゲージ7が必要。各3/4を別々に見て通してはいけない）。
      gaugeNeeded += amount;
      if (!canSpendGaugePool(player, gaugeNeeded, { includeOpponent: includeOpponentGauge })) {
        return { ok: false, reason: "ゲージが足りません。" };
      }
    }
    if (step.op === "setLife") {
      // 「君のライフをNにする」コスト。減少になる時のみ支払い可（増加はコストにならない）。
      const target = step.life ?? step.amount ?? player.life;
      if (player.life <= target) {
        return { ok: false, reason: "ライフが足りません。" };
      }
    }
    if (step.op === "discardHand") {
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      // E-XB31(X-SS04/0015 ラウドヴォイス): 「手札1枚以上を好きな枚数捨てる」= min/max 可変の discardHand。
      // 最小支払い枚数は step.min ?? amount（putHandToSoul/putDropToSoul の既存 min イディオムと同型）。
      // min 未指定の固定コスト（{op:"discardHand", amount:N}／amount 省略=1）は min=amount＝従来どおり完全不変。
      if (availableHand.length < (step.min ?? amount)) {
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
    if (step.op === "putHandToDeckTop") {
      // E-XB48(X-CBT01/0037 トラクタービーム「【使用コスト】君の手札1枚を君のデッキの上に置く」):
      // 手札 N 枚をデッキの上（＝配列末尾。drawCards は pop で末尾から引く）へ戻すコスト。putHandToSoul と同型の
      // min/max・selectedCard 除外・filter を踏襲する（宛先だけソウル→デッキ上）。
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      const minimum = step.min ?? amount;
      if (availableHand.length < minimum) {
        return { ok: false, reason: "デッキの上に置く手札が足りません。" };
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
        return { ok: false, reason: "打ち消せるライフリンクがありません。" };
      }
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      const owner = state.players.indexOf(player);
      if (!findSpecialCallOpportunity(owner, step)) {
        return { ok: false, reason: "対象となるコール機会がありません。" };
      }
      if (!findLifeLinkEventForCallOpportunity(owner, step)) {
        return { ok: false, reason: "打ち消せるライフリンクがありません。" };
      }
    }
    if (step.op === "putTopDeckToSoul") {
      // 発生源自身（ドロップ/デッキから重ねコール中の selectedCard）はソウルにできないので勘定から除く
      // （putHandToSoul/putCardToSoul と同じ selectedCard 除外・支払い側 moveTopDeckToSoul と一致）。
      const availableDeck = player.deck.filter((card) => card.instanceId !== selectedCard?.instanceId).length;
      if (availableDeck < amount) {
        return { ok: false, reason: "ソウルに入れるデッキ枚数が足りません。" };
      }
    }
    if (step.op === "putDropToSoul") {
      const availableDrop = player.drop.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      if (availableDrop.length < (step.min ?? amount)) {
        return { ok: false, reason: "ソウルに入れるドロップのカードが足りません。" };
      }
    }
    if (step.op === "discardSoul" && (context.sourceCard?.soul?.length || 0) < amount) {
      return { ok: false, reason: "ソウルが足りません。" };
    }
    if (step.op === "discardSoulToDeckBottom" && (context.sourceCard?.soul?.length || 0) < discardSoulToDeckBottomFloor(step, context)) {
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
        cannotReturnToHand(target.card, returnPendingTargetCostCause(owner, target.owner)) ||
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
    if (step.op === "putOwnFieldCardsToDeckBottom") {
      // E3'(D-EB03/0002): 場→デッキ下のコスト（putOwnFieldCardsToGauge と同型・宛先のみデッキ下）。
      const candidates = ownFieldCostCandidates(player, step.filter);
      if (candidates.length < amount) {
        return { ok: false, reason: "コストでデッキの下に置く自分の場のカードが足りません。" };
      }
    }
    if (step.op === "dropOwnFieldCard") {
      const candidates = ownFieldCostCandidates(player, step.filter);
      if (candidates.length < amount) {
        return { ok: false, reason: "コストでドロップに置く自分の場のカードが足りません。" };
      }
    }
    if (step.op === "dropOwnFieldOrSoulCard") {
      // 「君の場の◯◯1枚か、君の場のカードのソウルにある◯◯1枚をドロップに置く」（H-SS01 テラフォーミング等）。
      const candidates = ownFieldOrSoulCostCandidates(player, step.filter);
      if (candidates.length < amount) {
        return { ok: false, reason: "コストでドロップに置くカード（場かソウル）が足りません。" };
      }
    }
    if (step.op === "putSelectedOwnFieldCardsToSoul") {
      const candidates = ownFieldCostCandidates(player, step.filter).filter(
        (candidate) => candidate.card.instanceId !== context.sourceCard?.instanceId,
      );
      if (candidates.length < (step.min ?? 1)) {
        return { ok: false, reason: "コストでソウルに入れる自分の場のカードが足りません。" };
      }
    }
    if (step.op === "lookTopSelectToSoulRestToDrop" && player.deck.length < 1) {
      return { ok: false, reason: "見るデッキのカードがありません。" };
    }
    if (step.op === "destroyOwnMonster") {
      const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
      // 破壊耐性/離場防止で実際には破壊できないカードはコスト候補から除外する（第13回メカレビュー:
      // 耐性持ちしか居ない時に「支払えた」ことにして効果だけ通るコスト踏み倒しを防ぐ）。
      const candidates = ownFieldCostCandidates(player, step.includeAllTypes ? (step.filter || {}) : { cardType: "monster", ...(step.filter || {}) }).filter(
        (candidate) => candidate.card.instanceId !== excludeId && !costDestroyBlocked(candidate.card, candidate.owner, costDestroyStepCause(step)),
      );
      if (candidates.length < amount) {
        return { ok: false, reason: "コストで破壊する自分のモンスターがいません。" };
      }
    }
    if (step.op === "destroySource") {
      const slot = findFieldCardSlot(context.sourceCard);
      if (!slot) {
        return { ok: false, reason: "コストで破壊するこのカードが場にありません。" };
      }
      if (costDestroyBlocked(context.sourceCard, slot.owner)) {
        return { ok: false, reason: "コストでこのカードを破壊できません。" };
      }
    }
    // X3(D-BT01): 発生源カードをレストするコスト（0037/0108「このカードをレストしてよい」）。
    if (step.op === "restSource") {
      if (!findFieldCardSlot(context.sourceCard) || context.sourceCard?.used) {
        return { ok: false, reason: "コストでレストするこのカードが場にないか、既にレスト中です。" };
      }
    }
    // X3(D-BT01/0085): 自分の場のモンスターをレストするコスト。
    if (step.op === "restOwnMonster") {
      const candidates = ownFieldCostCandidates(player, step.includeAllTypes ? (step.filter || {}) : { cardType: "monster", ...(step.filter || {}) }).filter(
        (candidate) => !candidate.card.used,
      );
      if (candidates.length < amount) {
        return { ok: false, reason: "コストでレストする自分のモンスターがいません。" };
      }
    }
    // X3(D-BT01/0132/0134): ドロップの filter 一致カードをデッキの下に置くコスト。
    if (step.op === "putDropToDeckBottom") {
      const matching = player.drop.filter((card) => matchesCardFilter(card, step.filter || {}));
      if (matching.length < amount) {
        return { ok: false, reason: "コストでデッキの下に置くドロップのカードが足りません。" };
      }
    }
    // X3(D-BT01/0131 離場置換コスト等): デッキの上から N 枚をドロップに置くコスト。
    if (step.op === "putTopDeckToDrop") {
      if (player.deck.length < amount) {
        return { ok: false, reason: "デッキの枚数が足りません。" };
      }
    }
    // X3(D-BT01/0120/0122): 自分の場の filter 一致カード1枚を選び、そのソウルから amount 枚をドロップに置くコスト。
    if (step.op === "dropOwnFieldCardSoul") {
      const hosts = ownFieldCostCandidates(player, step.filter || {}).filter(
        (candidate) => (candidate.card.soul || []).length >= amount,
      );
      if (hosts.length === 0) {
        return { ok: false, reason: "コストでソウルを置ける自分の場のカードがありません。" };
      }
    }
    // X3(D-BT01/0079/0122): 代替コスト（options のいずれか1つを選んで支払う）。
    if (step.op === "chooseCost") {
      const options = step.options || [];
      if (!options.some((option) => canPayStructuredCost(player, option, context).ok)) {
        return { ok: false, reason: "いずれのコストも支払えません。" };
      }
    }
    if (step.op === "returnOwnFieldCardToHand") {
      const candidates = returnFieldCostCandidates(player, step);
      const minimum = step.min ?? amount;
      if (candidates.length < minimum) {
        return { ok: false, reason: "コストで手札に戻す自分の場のカードが足りません。" };
      }
    }
  }
  return { ok: true };
}

// returnOwnFieldCardToHand 用の候補（zones 指定があればそのゾーンのみ、既定は全場）。
function returnFieldCostCandidates(player, step = {}) {
  const owner = state.players.indexOf(player);
  const allowedZones = step.zones && step.zones.length ? expandZoneList(step.zones) : zones;
  return allowedZones
    .map((zone) => ({ owner, zone, card: player.field[zone], source: "field" }))
    .filter(({ card, zone }) => card && matchesTargetFilter(card, owner, zone, step.filter || {}));
}

// 場のカードを手札へ戻す（ソウルはドロップ・currentTypeを基底へ）。コスト用。
// rule-zones-6: コストでも「場を離れて手札に戻る」ので、ライフリンク（ver2.05「場から離れる場合、示された数値分の
// ダメージを受けます」）・「場から離れた時」・「場のモンスターが手札(かデッキ)に戻った時」(D・R・システム等)・
// 自身の「手札に戻った時」を、効果の手札戻し(returnFieldTargetToHand)と同じ順序で発火する。
function returnFieldCardToHandCost(player, zone) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  const owner = state.players.indexOf(player);
  const lifeLinkNullifiedAtLeave = isAbilitiesNullified(card); // 離場直前に捕捉（能力無効化中はライフリンク無し）
  const typeAtLeave = effectiveCardType(card);
  player.drop.push(...(card.soul || []));
  card.soul = [];
  // ホスト離場でソウル札がドロップへ＝裏向き奇襲札の公開・selfDroppedFromSoul(ヴィーガー等)を発火する
  // （destroyFieldCard:511 等と同基準・冪等/opt-in。第12回メカレビュー: コスト経路の取りこぼしを是正）。
  reconcileFaceDownSoulDrops();
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  resetLeftFieldCardState(card);
  player.hand.push(card);
  applyLifeLink(card, owner, { nullifiedAtLeave: lifeLinkNullifiedAtLeave });
  queueLeaveFieldTriggers(card, owner, zone, { eventCardTypeAtLeave: typeAtLeave });
  addLog(`${card.name}をコストで手札に戻しました。`);
  queueMonsterReturnedTriggers(card, owner, zone, { eventCardTypeAtLeave: typeAtLeave });
  queueReturnedToHandTriggers(card, owner, "field");
  return card;
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

// 「場の filter 一致カード」＋「場のカードのソウルにある filter 一致カード」を横断したコスト候補
// （dropOwnFieldOrSoulCard 用。H-SS01 テラフォーミング等）。
function ownFieldOrSoulCostCandidates(player, filter = {}) {
  const owner = state.players.indexOf(player);
  const candidates = [];
  zones.forEach((zone) => {
    const fieldCard = player.field[zone];
    if (!fieldCard) {
      return;
    }
    if (matchesCardFilter(fieldCard, filter)) {
      candidates.push({ owner, zone, card: fieldCard, source: "field" });
    }
    (fieldCard.soul || []).forEach((soulCard) => {
      if (matchesCardFilter(soulCard, filter)) {
        candidates.push({ owner, zone, card: soulCard, source: "soul", hostCard: fieldCard, note: `${fieldCard.name}のソウル` });
      }
    });
  });
  return candidates;
}

function payDropOwnFieldOrSoulTarget(player, target) {
  if (target.source === "soul" && target.hostCard) {
    const index = (target.hostCard.soul || []).findIndex((card) => card.instanceId === target.card.instanceId);
    if (index >= 0) {
      player.drop.push(target.hostCard.soul.splice(index, 1)[0]);
      addLog(`${target.card.name}をコストでドロップゾーンに置きました。`);
      // E1/F2: ホスト存命のままソウル1枚がドロップへ → soulCardDropped（リスナー不在なら即帰り）。
      queueSoulCardDroppedTriggers(target.hostCard, state.players.indexOf(player), 1);
    }
    return;
  }
  const dropped = dropFieldCardByRule(player, target.zone);
  if (dropped) {
    addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
  }
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

function moveCostEntriesToSoul(player, entries, sourceCard, faceDown = false) {
  const bySource = new Map();
  entries.forEach((entry) => {
    const group = bySource.get(entry.source) || [];
    group.push(entry);
    bySource.set(entry.source, group);
  });
  const movedCards = [];
  const movedFrom = new Map(); // instanceId → 出所（enteredSoul の fromZone 判定用）
  bySource.forEach((group, source) => {
    const pile = player[source];
    if (!Array.isArray(pile)) {
      return;
    }
    const removed = removePileEntries(pile, group);
    removed.forEach((moved) => movedFrom.set(moved.instanceId, source));
    movedCards.push(...removed);
    if (source === "deck") {
      shuffleInPlace(pile);
      addLog(`${player.name}はデッキをシャッフルしました。`);
    }
  });
  if (movedCards.length > 0) {
    sourceCard.soul ||= [];
    sourceCard.soul.push(...movedCards);
    // 「このカードが手札/デッキ/ドロップから…のソウルに入った時」（enteredSoul）。コスト経路でも発火する。
    movedCards.forEach((moved) =>
      queueEnteredSoulTriggers(moved, state.players.indexOf(player), movedFrom.get(moved.instanceId), sourceCard),
    );
    queueSoulCardAddedTriggers(sourceCard, state.players.indexOf(player), movedCards.length, movedCards[0]); // E-XB24
    if (faceDown) {
      markSoulCardsFaceDown(movedCards, sourceCard); // E-Y1(奇襲): 「裏向きで」
    } else {
      markFaceUpSoulSelfDropHost(movedCards, sourceCard); // 表向き selfDroppedFromSoul 札の __soulHost 印（funnel と同基準）
    }
    // E-Y1(奇襲): 裏向きコストは表情報(カード名)を log に出さない（秘匿）。枚数のみ記す。
    addLog(
      faceDown
        ? `${player.name}はコストで${movedCards.length}枚を裏向きで${sourceCard.name}のソウルに入れました。`
        : `${player.name}はコストで${movedCards.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`,
    );
  }
  return movedCards;
}

// R2: 同期のコスト選択（破壊置換の payStructuredCost 等、async にできない経路）。支払う席(promptSeat)を見て
// 答え手を選ぶ: CPU 席なら AI が同期で選ぶ（従来は window.prompt に落ち、人間に CPU の手札が見え CPU の代わりに
// 選ばされていた）。権威サーバは同期往復できないため従来どおり既定（先頭）で確定する（誰にも提示しない）。
// それ以外（ローカルの人間席）は従来どおり本人への window.prompt。選択はリプレイの応答として記録・再生する
// （再生中は記録された応答を消費する）。
function chooseCostEntriesSync(candidates, options = {}) {
  const amount = options.max ?? options.amount ?? 1;
  if ((candidates || []).length <= amount) {
    return (candidates || []).slice(0, amount);
  }
  const min = options.min ?? amount;
  const normalized = candidates.map((candidate, index) => ({ ...candidate, choiceIndex: index }));
  if (typeof replayIsPlaying === "function" && replayIsPlaying()) {
    return replayNextSelection(candidates);
  }
  let selected;
  if (typeof aiShouldAnswerPrompt === "function" && aiShouldAnswerPrompt(options.promptSeat)) {
    selected = aiAnswerSelectionSync(normalized, {
      min,
      max: amount,
      allowCancel: false,
      purpose: "cost",
      promptSeat: options.promptSeat,
      title: options.title || "コストのカード選択",
    });
  } else if (typeof appChoiceUiAvailable === "function" && appChoiceUiAvailable()) {
    // ブラウザ: 同期の支払い経路では選択UIを待てない。ネイティブ prompt は出さず、権威サーバと同じ既定（先頭から）で確定する。
    selected = normalized.slice(0, amount);
  } else {
    selected = fallbackCardEntrySelection(normalized, {
      min,
      max: amount,
      title: options.title || "コストのカード選択",
    });
  }
  if (typeof replayIsRecording === "function" && replayIsRecording()) {
    replayRecordSelection(selected);
  }
  return selected;
}

// pt-fix-c(b): コスト支払い中に場からドロップへ置いたカードの「ドロップに置かれた時」誘発を、宣言の解決後まで
// 控える（src/11 costDropCapture）。支払い本体は Core。失敗時は控えた分を即放つ。
function payStructuredCost(player, costSteps = [], context = {}) {
  enterCostDropCapture();
  let result;
  try {
    result = payStructuredCostCore(player, costSteps, context);
    return result;
  } finally {
    exitCostDropCapture(result);
  }
}

function payStructuredCostCore(player, costSteps = [], context = {}) {
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
    if (step.op === "discardAllHand") {
      // 使用中のカードを除く手札を全て捨てるコスト（オールド・ラング・サイン 0029）。手札0でも支払い可。
      const removed = removeInUseHandExcept(player, selectedCard);
      discardHandCardsToDrop(player, removed, { byCost: true, sourceOwner: state.players.indexOf(player), sourceCard: context.sourceCard || null }); // E6: コスト起因
      if (removed.length > 0) {
        addLog(`${player.name}はコストで手札を全て捨てました。`);
      }
    }
    if (step.op === "discardHand") {
      const candidates = player.hand
        .map((card, index) => ({ card, index }))
        .filter(
          ({ card }) =>
            card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
        );
      // E-XB31: min/max 可変（putHandToSoul と同型）。固定コストは min=max=amount で従来どおり。
      const minimum = step.min ?? amount;
      const maximum = step.max ?? amount;
      const selected = chooseCostEntriesSync(candidates, {
        amount: maximum,
        min: minimum,
        max: maximum,
        title: `${sourceCard?.name || "コスト"}で捨てる手札`,
        promptSeat: state.players.indexOf(player), // R2: 支払う本人の席（CPU 席なら AI が答える）
      });
      discardHandCardsToDrop(player, removePileEntries(player.hand, selected || []), { byCost: true, sourceOwner: state.players.indexOf(player), sourceCard: context.sourceCard || null }); // E6: コスト起因
    }
    if (step.op === "putHandToSoul") {
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      availableHand.slice(-amount).forEach((card) => {
        const index = player.hand.findIndex((candidate) => candidate.instanceId === card.instanceId);
        if (index >= 0) {
          sourceCard.soul ||= [];
          const moved = player.hand.splice(index, 1)[0];
          sourceCard.soul.push(moved);
          // ソウルイン funnel（enteredSoul・E-XB24・裏向き印・__soulHost 印）。移動は上で完了済み。
          putCardsToSoulWithTrigger(sourceCard, state.players.indexOf(player), [moved], "hand", { alreadyPlaced: true, faceDown: step.faceDown });
        }
      });
    }
    if (step.op === "putHandToDeckTop") {
      // E-XB48: 非対話（sync）経路。putHandToSoul の sync 版と同型で、宛先をデッキ上（push＝末尾）にする。
      const availableHand = player.hand.filter(
        (card) => card.instanceId !== selectedCard?.instanceId && matchesCardFilter(card, step.filter || {}),
      );
      availableHand.slice(-amount).forEach((card) => {
        const index = player.hand.findIndex((candidate) => candidate.instanceId === card.instanceId);
        if (index >= 0) {
          player.deck.push(player.hand.splice(index, 1)[0]); // 配列末尾＝デッキの上
        }
      });
    }
    if (step.op === "putCardToSoul") {
      const candidates = cardToSoulCostCandidates(player, step, selectedCard).slice(0, amount);
      moveCostEntriesToSoul(player, candidates, sourceCard, Boolean(step.faceDown)); // E-Y1(奇襲)
    }
    if (step.op === "payLife") {
      player.life -= amount;
    }
    if (step.op === "damageSelf") {
      applyDamageToPlayer(state.players.indexOf(player), amount, { sourceName: sourceCard?.name, byAttack: false });
    }
    if (step.op === "setLife") {
      player.life = step.life ?? step.amount ?? player.life;
    }
    if (step.op === "returnPendingTargetToHand") {
      const target = getPendingBattleTargetInfo(state.pendingAttack);
      if (target?.card) {
        returnFieldTargetToHand(target, sourceCard?.name || "効果", {
          cause: returnPendingTargetCostCause(state.players.indexOf(player), target.owner),
        });
      }
    }
    if (["cancelRecentLifeLink", "cancelLifeLink"].includes(step.op)) {
      cancelRecentLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      cancelCallOpportunityLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "putTopDeckToSoul") {
      moveTopDeckToSoul(player, sourceCard, amount, Boolean(step.faceDown)); // E-Y1(奇襲)
    }
    if (step.op === "putDropToSoul") {
      moveDropToSoul(player, sourceCard, amount, step.filter);
    }
    if (step.op === "putOwnFieldCardsToSoul") {
      moveFieldCardsToSoul(player, sourceCard, step.filter);
    }
    if (step.op === "discardSoul") {
      let soulDropped = 0;
      for (let index = 0; index < amount; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.drop.push(soulCard);
          soulDropped += 1;
        }
      }
      // E1/F2(D-BT02/0062等): 自ソウルをコストでドロップ → soulCardDropped（設置の自壊で離場したら発火時再検証で不発）。
      queueSoulCardDroppedTriggers(sourceCard, state.players.indexOf(player), soulDropped);
      maybeDropSetWhenSoulEmpty(sourceCard, state.players.indexOf(player)); // 設置のソウル切れ自壊（H-BT04/0025）
    }
    if (step.op === "discardSoulToDeckBottom") {
      // E3: 同期経路は対話不可のため allowMore の追加払いはせず最小量（amountFrom or 固定量）だけ払う近似
      //（末尾から pop＝好きな順の残差は非同期側と同じ）。固定量呼び出しは need===amount で完全に不変。
      const need = discardSoulToDeckBottomFloor(step, context);
      const placed = [];
      for (let index = 0; index < need; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.deck.unshift(soulCard);
          placed.push(soulCard);
        }
      }
      queueDeckBottomPlacedTriggers(state.players.indexOf(player), placed); // E-XB18: コストでソウル→デッキ下
    }
    if (step.op === "dropSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        dropFieldCardByRule(player, slot.zone);
      }
    }
    if (step.op === "destroySource") {
      // 同期経路: 破壊誘発/ソウルガードは反映されない近似（destroyOwnMonster 同期経路と同ポリシー）。
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        const dropped = dropFieldCardByRule(player, slot.zone);
        if (dropped) addLog(`${dropped.name}をコストで破壊しました。`);
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
    if (step.op === "putOwnFieldCardsToDeckBottom") {
      // E3': 非対話経路では先頭 amount 枚を自動選択（putOwnFieldCardsToGauge と同ポリシー）。
      ownFieldCostCandidates(player, step.filter)
        .slice(0, amount)
        .forEach((target) => putFieldCardToDeckBottom(player, target.zone));
    }
    if (step.op === "dropOwnFieldCard") {
      ownFieldCostCandidates(player, step.filter)
        .slice(0, amount)
        .forEach((target) => {
          const dropped = dropFieldCardByRule(player, target.zone);
          if (dropped) {
            addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
          }
        });
    }
    if (step.op === "dropOwnFieldOrSoulCard") {
      // 非対話経路では先頭 amount 枚を自動選択（場札→ルールドロップ／ソウル札→ホストのソウルから除去）。
      ownFieldOrSoulCostCandidates(player, step.filter)
        .slice(0, amount)
        .forEach((target) => payDropOwnFieldOrSoulTarget(player, target));
    }
    if (step.op === "putSelectedOwnFieldCardsToSoul") {
      // 非対話経路では最小枚数だけ自動選択してソウルへ。
      const selected = ownFieldCostCandidates(player, step.filter)
        .filter((candidate) => candidate.card.instanceId !== sourceCard?.instanceId)
        .slice(0, step.min ?? 1);
      moveSelectedFieldCardsToSoul(player, sourceCard, selected);
    }
    if (step.op === "lookTopSelectToSoulRestToDrop") {
      // 非対話経路では見た先頭 amount 枚をソウルにする。
      lookTopSelectToSoulRestToDrop(player, sourceCard, step.count || 1, step.amount || 1);
    }
    if (step.op === "destroyOwnMonster") {
      // 非対話経路: 先頭の候補を破壊。ソウルガード/破壊時誘発は同期のため反映されない近似。
      const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
      const target = ownFieldCostCandidates(player, step.includeAllTypes ? (step.filter || {}) : { cardType: "monster", ...(step.filter || {}) }).find(
        (candidate) => candidate.card.instanceId !== excludeId,
      );
      if (target) {
        const dropped = dropFieldCardByRule(player, target.zone);
        if (dropped) addLog(`${dropped.name}をコストで破壊しました。`);
      }
    }
    if (step.op === "restSource") {
      // 非対話経路: used=true のみ（restイベントは対話経路=payWithSelection 側で発火する近似）。
      if (findFieldCardSlot(sourceCard) && !sourceCard.used) {
        sourceCard.used = true;
        addLog(`${sourceCard.name}をコストで【レスト】しました。`);
      }
    }
    if (step.op === "restOwnMonster") {
      ownFieldCostCandidates(player, step.includeAllTypes ? (step.filter || {}) : { cardType: "monster", ...(step.filter || {}) })
        .filter((candidate) => !candidate.card.used)
        .slice(0, amount)
        .forEach((candidate) => {
          candidate.card.used = true;
          addLog(`${candidate.card.name}をコストで【レスト】しました。`);
        });
    }
    if (step.op === "putDropToDeckBottom") {
      let moved = 0;
      const placed = [];
      for (let index = player.drop.length - 1; index >= 0 && moved < amount; index -= 1) {
        if (matchesCardFilter(player.drop[index], step.filter || {})) {
          const movedCard = player.drop.splice(index, 1)[0];
          player.deck.unshift(movedCard); // 配列先頭=デッキの下
          placed.push(movedCard);
          moved += 1;
        }
      }
      queueDeckBottomPlacedTriggers(state.players.indexOf(player), placed); // E-XB18: コストでドロップ→デッキ下
      if (moved > 0) addLog(`${player.name}はコストでドロップの${moved}枚をデッキの下に置きました。`);
    }
    if (step.op === "putTopDeckToDrop") {
      // E5: deckMilled ブロードキャストはバッチ1回（per-card だと microtask 交錯で named-once が
      // 二重計上し得る＝moveTopDeckToDrop と同じレース対策）。起因はコスト（byEffect ではない）。
      const milledCards = [];
      for (let index = 0; index < amount; index += 1) {
        const milled = player.deck.pop();
        if (milled) milledCards.push(milled);
      }
      putCardsToDropWithTrigger(player, state.players.indexOf(player), milledCards, "deck", { cause: { byCost: true, sourceOwner: state.players.indexOf(player), sourceCard: context.sourceCard || null } });
      if (player.deck.length === 0) declareDeckLoss(player);
      addLog(`${player.name}はコストでデッキの上から${amount}枚をドロップゾーンに置きました。`);
    }
    if (step.op === "dropOwnFieldCardSoul") {
      // 非対話経路: 先頭候補のソウル末尾から amount 枚をドロップへ。
      const host = ownFieldCostCandidates(player, step.filter || {}).find(
        (candidate) => (candidate.card.soul || []).length >= amount,
      );
      if (host) {
        for (let index = 0; index < amount; index += 1) {
          const soulCard = host.card.soul.pop();
          if (soulCard) player.drop.push(soulCard);
        }
        addLog(`${host.card.name}のソウル${amount}枚をコストでドロップゾーンに置きました。`);
        // E1/F2: ホスト存命のままソウルがドロップへ → soulCardDropped。
        queueSoulCardDroppedTriggers(host.card, state.players.indexOf(player), amount);
      }
    }
    if (step.op === "chooseCost") {
      const option = (step.options || []).find((candidate) => canPayStructuredCost(player, candidate, context).ok);
      if (option) payStructuredCost(player, option, context);
    }
    if (step.op === "returnOwnFieldCardToHand") {
      returnFieldCostCandidates(player, step)
        .slice(0, step.min ?? amount)
        .forEach((target) => returnFieldCardToHandCost(player, target.zone));
    }
  }
  checkWinner();
  return { ok: true };
}

// destroyOwnMonster コストの破壊の原因（候補判定用）。asEffect（“C・ドレイン”等＝効果の破壊）は効果、それ以外は真の【コスト】。
function costDestroyStepCause(step) {
  return step?.asEffect ? { byEffect: true, byOpponent: false } : { byCost: true, byEffect: false, byOpponent: false };
}

// 統合 follow-up（pt-fix-e の残課題「同期のコスト選択」）: 対話の選択・確認が要るコスト step。同期の
// payStructuredCost はこれらを先頭から自動で決める（chooseCostEntriesSync＝ブラウザ/権威サーバとも既定）ため、
// 非同期の文脈では payStructuredCostWithSelection（本人へ往復・CPU は AI・リプレイ記録）で払う。
const INTERACTIVE_COST_OPS = new Set([
  "chooseCost", "destroyOwnMonster", "discardHand", "discardSoulToDeckBottom", "dropOwnFieldCard", "dropOwnFieldCardSoul",
  "dropOwnFieldOrSoulCard", "dropOwnMonster", "lookTopSelectToSoulRestToDrop", "putCardToSoul", "putDropToDeckBottom",
  "putDropToSoul", "putHandToDeckTop", "putHandToSoul", "putOwnFieldCardsToDeckBottom", "putOwnFieldCardsToGauge",
  "putSelectedOwnFieldCardsToSoul", "restOwnMonster", "returnOwnFieldCardToHand", "damageSelf", "returnPendingTargetToHand",
]);

function costStepsNeedInteraction(costSteps) {
  return (costSteps || []).some((step) => step && INTERACTIVE_COST_OPS.has(step.op));
}

// 非同期の文脈でのコスト支払い。対話が要る時だけ Promise（payStructuredCostWithSelection）を返し、要らなければ同期の
// 結果をそのまま返す（await しない＝tick 不変）。呼び出し側: let paid = payCostAsk(...); if (paid?.then) paid = await paid;
function payCostAsk(player, costSteps = [], context = {}) {
  return costStepsNeedInteraction(costSteps)
    ? payStructuredCostWithSelection(player, costSteps, context)
    : payStructuredCost(player, costSteps, context);
}

// T2（オーナー裁定 2026-10-14）: 効果の解決途中で払うコスト（script の payCost 等）は、宣言前へ巻き戻せないので
// 選択をキャンセル不可（強制）にする。context.forceSelection:true の時だけ allowCancel:false を足す（宣言時のコスト
// 選択＝キャンセルで使用前へ戻る従来挙動は不変）。
function forcedCostSelectionOption(context) {
  return context?.forceSelection === true ? { allowCancel: false } : {};
}

// pt-final(5): destroyOwnMonster コストで破壊する札の呼び名（属性指定＝《属性》／全種類可＝カード／既定＝モンスター）。
function costDestroyNoun(step = {}) {
  const attribute = step.filter?.attribute;
  if (typeof attribute === "string" && attribute) {
    return `《${attribute}》`;
  }
  return step.includeAllTypes ? "カード" : "モンスター";
}

// pt-final(5): コスト選択の枚数の案内（「0～1枚」→「1枚まで（選ばなくてもかまいません）」・上限は候補数で切る）。
function costCountLead(minimum, maximum, candidateCount = Infinity) {
  const upper = Math.max(0, Math.min(Number.isFinite(maximum) ? maximum : candidateCount, candidateCount));
  if (!(minimum > 0)) {
    return `${upper}枚まで選んでください（選ばなくてもかまいません）。`;
  }
  if (upper > minimum) {
    return `${minimum}～${upper}枚選んでください。`;
  }
  return `${minimum}枚選んでください。`;
}

// pt-fix-c T7-8: コスト選択の候補が必要枚数に足りない時に「〜を選んでください」とだけ出ていた（選びようがない）。
// 候補不足ならその理由を述べる（候補はあるのに選ばなかった＝キャンセル時は従来文言）。
function costChoiceFailReason(message, candidates, minimum = 1) {
  const count = Array.isArray(candidates) ? candidates.length : 0;
  const need = Math.max(1, Number(minimum) || 1);
  if (count >= need) {
    return message;
  }
  const subject = String(message).replace(/^コストで/, "").replace(/を選んでください。$/, "");
  return `コストで${subject}が足りないため、払えません（必要${need}枚・候補${count}枚）。`;
}

// 注: async の包みは await 1段ぶん解決が遅れ、既存の誘発タイミング（同期的に解決し切る前提のテスト・リプレイ）を
// ずらすため、Core の Promise をそのまま返し、終了処理は同じ Promise への先行リアクションで行う（呼び出し側の
// await より先に走る＝tick 数は従来と同一）。
function payStructuredCostWithSelection(player, costSteps = [], context = {}) {
  enterCostDropCapture();
  let promise;
  try {
    promise = payStructuredCostWithSelectionCore(player, costSteps, context);
  } catch (error) {
    exitCostDropCapture(null);
    throw error;
  }
  promise.then(
    (result) => exitCostDropCapture(result),
    () => exitCostDropCapture(null),
  );
  return promise;
}

async function payStructuredCostWithSelectionCore(player, costSteps = [], context = {}) {
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
  const handToDeckTopSelections = []; // E-XB48(0037 トラクタービーム): 手札→デッキ上コストの対話選択
  const reservedCostZones = new Set();
  const dropOwnMonsterSelections = [];
  const fieldToGaugeSelections = [];
  const fieldToDeckBottomSelections = []; // E3'(D-EB03/0002): 場→デッキ下コストの対話選択
  const dropOwnFieldSelections = [];
  const dropOwnFieldOrSoulSelections = [];
  const putSelectedFieldSoulSelections = [];
  const lookTopSoulSelections = [];
  const destroyOwnMonsterSelections = [];
  const returnFieldToHandSelections = [];
  const cardToSoulSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "discardHand") {
      continue;
    }
    const amount = step.amount || 1;
    // E-XB31(X-SS04/0015 ラウドヴォイス): 「手札1枚以上を好きな枚数捨てる」= min/max 可変（putHandToSoul と同型）。
    // min=step.min ?? amount／max=step.max ?? amount（候補数は chooseCardEntries が上限に丸める）。固定コスト
    // （min/max 未指定）は min=max=amount＝従来の1択挙動と完全に不変。捨てた実枚数は下の適用フェイズで
    // payment.discarded に積まれ、amountFrom:"costDiscardedCount"（「捨てた枚数分」）の解決へ伝播する。
    const minimum = step.min ?? amount;
    const maximum = step.max ?? amount;
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
      lead:
        minimum === maximum
          ? `手札からコストで捨てるカードを${maximum}枚選んでください。`
          : `手札からコストで捨てるカードを${costCountLead(minimum, maximum, candidates.length)}`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: costChoiceFailReason("コストで捨てる手札を選んでください。", candidates, minimum) };
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
      // pt-final(5): 「好きな枚数」(ヴァリアブルコード max:20) は候補数で上限を示す（「0～20枚」と出ていた）。
      lead: `手札からソウルに入れるカードを${costCountLead(minimum, maximum, candidates.length)}`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: costChoiceFailReason("コストでソウルに入れる手札を選んでください。", candidates, minimum) };
    }
    selected.forEach(({ card }) => reservedHandIds.add(card.instanceId));
    handToSoulSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putHandToDeckTop") {
      continue;
    }
    // E-XB48(0037 トラクタービーム): 手札 N 枚をデッキの上へ戻すコストの対話選択。putHandToSoul の選択ループと同型
    // （selectedCard 除外・予約済み手札除外・filter・min/max・promptSeat 支払い本人・CPU は最小価値）。
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
      title: `${context.sourceCard?.name || "コスト"}でデッキの上に置く手札`,
      lead: `手札からデッキの上に置くカードを${costCountLead(minimum, maximum, candidates.length)}`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost",
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: costChoiceFailReason("コストでデッキの上に置く手札を選んでください。", candidates, minimum) };
    }
    selected.forEach(({ card }) => reservedHandIds.add(card.instanceId));
    handToDeckTopSelections.push(selected);
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
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: costChoiceFailReason("コストでドロップに置く自分のモンスターを選んでください。", candidates, amount) };
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
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: costChoiceFailReason("コストでゲージに置く自分の場のカードを選んでください。", candidates, amount) };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    fieldToGaugeSelections.push(selected);
  }
  // E3'(D-EB03/0002): putOwnFieldCardsToDeckBottom の対話選択（putOwnFieldCardsToGauge と同型・宛先のみデッキ下）。
  for (const step of applicableCostSteps) {
    if (step.op !== "putOwnFieldCardsToDeckBottom") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = ownFieldCostCandidates(player, step.filter).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でデッキの下に置くカード`,
      lead: `自分の場からデッキの下に置くカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: costChoiceFailReason("コストでデッキの下に置く自分の場のカードを選んでください。", candidates, amount) };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    fieldToDeckBottomSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "dropOwnFieldCard") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = ownFieldCostCandidates(player, step.filter).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でドロップに置くカード`,
      lead: `自分の場からドロップゾーンに置くカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: costChoiceFailReason("コストでドロップに置く自分の場のカードを選んでください。", candidates, amount) };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    dropOwnFieldSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "dropOwnFieldOrSoulCard") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = ownFieldOrSoulCostCandidates(player, step.filter).filter(
      (candidate) => candidate.source !== "field" || !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でドロップに置くカード`,
      lead: `自分の場か、場のカードのソウルからドロップゾーンに置くカードを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: costChoiceFailReason("コストでドロップに置くカードを選んでください。", candidates, amount) };
    }
    selected.forEach((candidate) => {
      if (candidate.source === "field") {
        reservedCostZones.add(`${candidate.owner}:${candidate.zone}`);
      }
    });
    dropOwnFieldOrSoulSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "putSelectedOwnFieldCardsToSoul") {
      continue;
    }
    const candidates = ownFieldCostCandidates(player, step.filter).filter(
      (candidate) =>
        candidate.card.instanceId !== context.sourceCard?.instanceId &&
        !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const minimum = step.min ?? 1;
    const maximum = Math.min(step.max ?? candidates.length, candidates.length);
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でソウルに入れる場のカード`,
      lead: `自分の場からソウルに入れるカードを${minimum}枚以上選んでください。`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: costChoiceFailReason("コストでソウルに入れる自分の場のカードを選んでください。", candidates, minimum) };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    putSelectedFieldSoulSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "destroyOwnMonster") {
      continue;
    }
    const amount = step.amount || 1;
    const excludeId = step.excludeSource ? context.sourceCard?.instanceId : null;
    const candidates = ownFieldCostCandidates(player, step.includeAllTypes ? (step.filter || {}) : { cardType: "monster", ...(step.filter || {}) }).filter(
      (candidate) =>
        candidate.card.instanceId !== excludeId &&
        !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`) &&
        !costDestroyBlocked(candidate.card, candidate.owner, costDestroyStepCause(step)), // 破壊耐性で払えないカードは選ばせない（canPay と同基準）
    );
    const selected = await chooseCardEntries(candidates, {
      // pt-final(5): 呼び名はフィルタに合わせる（ブラック・リチュアル「君の場の《黒竜》１枚を破壊」＝アイテムの
      // 《黒竜》も払える includeAllTypes なのに「自分のモンスター」と出ていた）。
      title: `${context.sourceCard?.name || "コスト"}で破壊する自分の${costDestroyNoun(step)}`,
      lead: `コストで破壊する自分の場の${costDestroyNoun(step)}を${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: costChoiceFailReason(`コストで破壊する自分の${costDestroyNoun(step)}を選んでください。`, candidates, amount) };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    destroyOwnMonsterSelections.push(selected);
  }
  for (const step of applicableCostSteps) {
    if (step.op !== "returnOwnFieldCardToHand") {
      continue;
    }
    const amount = step.amount || 1;
    const minimum = step.min ?? amount;
    const candidates = returnFieldCostCandidates(player, step).filter(
      (candidate) => !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const maximum = Math.min(step.max ?? amount, candidates.length);
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}で手札に戻すカード`,
      lead: `自分の場から手札に戻すカードを${costCountLead(minimum, maximum, candidates.length)}`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      allowCancel: minimum === 0,
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < minimum) {
      if (minimum > 0) {
        return { ok: false, reason: costChoiceFailReason("コストで手札に戻す自分の場のカードを選んでください。", candidates, minimum) };
      }
    }
    (selected || []).forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`));
    returnFieldToHandSelections.push(selected || []);
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
      lead: `指定された領域からソウルに入れるカードを${costCountLead(minimum, maximum, candidates.length)}`,
      min: minimum,
      max: maximum,
      forceDialog: true,
      // 権威サーバ: コスト選択は支払い本人の席へ往復（未指定だと能動側へ誤配送＝相手手札候補が漏れる）。
      promptSeat: state.players.indexOf(player),
      purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < minimum) {
      return { ok: false, reason: costChoiceFailReason("コストでソウルに入れるカードを選んでください。", candidates, minimum) };
    }
    selected
      .filter((entry) => entry.source === "hand")
      .forEach(({ card }) => reservedHandIds.add(card.instanceId));
    cardToSoulSelections.push(selected);
  }
  // pt-fix-c T7-6: putDropToSoul（「君のドロップゾーンの〜N枚(まで)をこのカードのソウルに入れる」）も選択式に
  // （以前は対話経路でもドロップ末尾から自動取得＝何を入れるか選べなかった）。選択の余地が無い（候補＝必要枚数）
  // 時だけ自動。選択は chooseCardEntries（CPU/権威サーバ/リプレイの共通 seam）で支払い本人の席へ。
  const dropToSoulSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "putDropToSoul") {
      continue;
    }
    const amount = step.amount || 1;
    const minimum = Math.min(step.min ?? amount, amount);
    const candidates = cardToSoulCostCandidates(
      player,
      { sources: ["drop"], filter: step.filter || {} },
      selectedCard,
    ).filter((entry) => entry.card.instanceId !== context.sourceCard?.instanceId);
    const maximum = Math.min(amount, candidates.length);
    if (candidates.length < minimum) {
      return { ok: false, reason: "ソウルに入れるドロップのカードが足りません。" };
    }
    let selected;
    if (candidates.length === minimum && minimum === maximum) {
      selected = candidates; // 選択の余地なし（全て入れる）
    } else {
      selected = await chooseCardEntries(candidates, {
        title: `${context.sourceCard?.name || "コスト"}でソウルに入れるドロップのカード`,
        lead:
          minimum === maximum
            ? `ドロップゾーンからソウルに入れるカードを${maximum}枚選んでください。`
            : minimum === 0
              ? `ドロップゾーンからソウルに入れるカードを${maximum}枚まで選んでください。`
              : `ドロップゾーンからソウルに入れるカードを${costCountLead(minimum, maximum, candidates.length)}`,
        min: minimum,
        max: maximum,
        forceDialog: true,
        promptSeat: state.players.indexOf(player),
        purpose: "cost",
        ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択（統合時: pt-fix-c の新設選択にも適用）
      });
      if (!selected || selected.length < minimum) {
        return { ok: false, reason: "コストでソウルに入れるドロップのカードを選んでください。" };
      }
    }
    dropToSoulSelections.push(selected || []);
  }

  const sourceCard = context.sourceCard;
  const includeOpponentGauge = Boolean(context.includeOpponentGauge);
  // X3(D-BT01): restOwnMonster / putDropToDeckBottom / chooseCost の対話選択（他opと同じ収集→実行の2段構え）。
  const restOwnMonsterSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "restOwnMonster") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = ownFieldCostCandidates(player, step.includeAllTypes ? (step.filter || {}) : { cardType: "monster", ...(step.filter || {}) }).filter(
      (candidate) => !candidate.card.used && !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`),
    );
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}で【レスト】するモンスター`,
      lead: `コストで【レスト】する自分の場のモンスターを${amount}枚選んでください。`,
      min: amount,
      max: amount,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost",
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: costChoiceFailReason("コストで【レスト】するモンスターを選んでください。", candidates, amount) };
    }
    selected.forEach((candidate) => reservedCostZones.add(`${candidate.owner}:${candidate.zone}`)); // 二重選択防止
    restOwnMonsterSelections.push(selected);
  }
  const dropToBottomSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "putDropToDeckBottom") {
      continue;
    }
    const amount = step.amount || 1;
    const candidates = player.drop
      .map((card) => ({ card, owner: state.players.indexOf(player) }))
      .filter((entry) => matchesCardFilter(entry.card, step.filter || {}));
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でデッキの下に置くカード`,
      lead: `コストでデッキの下に置くドロップのカードを${amount}枚選んでください（選んだ順に下から積みます）。`,
      min: amount,
      max: amount,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost",
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < amount) {
      return { ok: false, reason: costChoiceFailReason("コストでデッキの下に置くカードを選んでください。", candidates, amount) };
    }
    dropToBottomSelections.push(selected);
  }
  // E3(D-BT04/0033 グラトス): amountFrom/allowMore 付き discardSoulToDeckBottom は、置くソウルを対話選択する
  //（最小=対象の打撃力、allowMore なら残数まで＝「以上」・選んだ順に下から積む）。固定量（amountFrom/allowMore
  // 無し）はこのループを素通りし exec の従来 soul.pop() 経路のまま＝既存挙動不変。
  const soulToBottomSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "discardSoulToDeckBottom" || !(step.amountFrom || step.allowMore)) {
      continue;
    }
    const soul = sourceCard?.soul || [];
    const floor = Math.min(discardSoulToDeckBottomFloor(step, context), soul.length);
    const max = step.allowMore ? soul.length : floor;
    const candidates = soul.map((soulCard) => ({ card: soulCard, owner: state.players.indexOf(player) }));
    const selected = await chooseCardEntries(candidates, {
      title: `${context.sourceCard?.name || "コスト"}でデッキの下に置くソウル`,
      lead: `このカードのソウルを${floor}枚以上デッキの下に置きます（選んだ順に下から積む）。置くソウルを選んでください。`,
      min: floor,
      max,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost",
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    if (!selected || selected.length < floor) {
      return { ok: false, reason: costChoiceFailReason("コストでデッキの下に置くソウルを選んでください。", candidates, floor) };
    }
    soulToBottomSelections.push(selected);
  }
  const fieldSoulDropSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "dropOwnFieldCardSoul") {
      continue;
    }
    const amount = step.amount || 1;
    const hosts = ownFieldCostCandidates(player, step.filter || {}).filter(
      (candidate) =>
        (candidate.card.soul || []).length >= amount &&
        !reservedCostZones.has(`${candidate.owner}:${candidate.zone}`), // 破壊/レスト予約済みカードのソウルは当てにしない
    );
    const hostPick = await chooseCardEntries(hosts, {
      title: `${context.sourceCard?.name || "コスト"}でソウルを置くカード`,
      lead: `ソウルをドロップゾーンに置く自分の場のカードを1枚選んでください。`,
      min: 1,
      max: 1,
      forceDialog: true,
      promptSeat: state.players.indexOf(player),
      purpose: "cost",
      ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
    });
    const host = hostPick?.[0];
    if (!host) {
      return { ok: false, reason: "コストでソウルを置くカードを選んでください。" };
    }
    const soulPick = await chooseCardEntries(
      (host.card.soul || []).map((soulCard) => ({ card: soulCard, owner: host.owner })),
      {
        title: `${host.card.name}のソウルから置くカード`,
        lead: `ドロップゾーンに置くソウルを${amount}枚選んでください。`,
        min: amount,
        max: amount,
        forceDialog: true,
        promptSeat: state.players.indexOf(player),
        purpose: "cost",
        ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
      },
    );
    if (!soulPick || soulPick.length < amount) {
      return { ok: false, reason: "コストで置くソウルを選んでください。" };
    }
    fieldSoulDropSelections.push({ host, souls: soulPick });
  }
  const chooseCostSelections = [];
  for (const step of applicableCostSteps) {
    if (step.op !== "chooseCost") {
      continue;
    }
    const options = (step.options || []).map((option, index) => ({ option, index }));
    const payable = options.filter(({ option }) => canPayStructuredCost(player, option, context).ok);
    if (payable.length === 0) {
      return { ok: false, reason: "いずれのコストも支払えません。" };
    }
    // 選択肢は疑似カード名で提示（labels を DSL で併記する。無ければ既定文言）。
    const picked = await chooseCardEntries(
      payable.map(({ option, index }) => ({
        card: { name: (step.labels || [])[index] || `コスト${index + 1}`, instanceId: `choose-cost-${index}`, rules: [], attributes: [], keywords: [], costs: {} },
        owner: state.players.indexOf(player),
        note: (step.labels || [])[index] || "",
      })),
      {
        title: `${context.sourceCard?.name || "コスト"}の支払い方法`,
        lead: "支払うコストを1つ選んでください。",
        min: 1,
        max: 1,
        forceDialog: true,
        promptSeat: state.players.indexOf(player),
        purpose: "cost",
        ...forcedCostSelectionOption(context), // T2: 効果の途中で払うコストは強制選択
      },
    );
    // pt-final(2): キャンセル時に先頭の支払い方法を黙って採用しない（宣言ごと取り消す）。強制選択時は
    // chooseCardEntries 側が既定を返すので null にならない。
    if (!picked || !picked.length) {
      return { ok: false, reason: "支払うコストを選んでください。" };
    }
    const chosenIndex = Number(String(picked[0]?.card?.instanceId || "").replace("choose-cost-", ""));
    const chosen = payable.find(({ index }) => index === chosenIndex) || payable[0];
    chooseCostSelections.push(chosen.option);
  }
  // pt-final(2): lookTopSelectToSoulRestToDrop（グライゼンZK 等「デッキの上からN枚見て1枚をソウルに入れ、残りを
  // ドロップ」）。以前はここでデッキから pop してから選ばせ、キャンセルすると先頭を黙って自動採用（＝宣言は進み
  // ゲージも払われる）、後続のコスト選択をキャンセルするとデッキから抜いた札が消えていた。
  // 今は (a) デッキは覗くだけ（pop は下の適用フェイズ）＝後続キャンセルでもデッキ不変、(b) 他の（取り消せる）
  // コスト選択を全て終えた最後に出し、(c) デッキを見た後は戻せないので選択は強制（キャンセル不可）。
  let lookTopPeekOffset = 0;
  for (const step of applicableCostSteps) {
    if (step.op !== "lookTopSelectToSoulRestToDrop") {
      continue;
    }
    const count = step.count || 1;
    const amount = step.amount || 1;
    const revealed = [];
    for (let index = 0; index < count; index += 1) {
      const card = player.deck[player.deck.length - 1 - lookTopPeekOffset - index];
      if (!card) {
        break;
      }
      revealed.push(card);
    }
    lookTopPeekOffset += revealed.length;
    const pickCount = Math.min(amount, revealed.length);
    const selected =
      pickCount > 0
        ? await chooseCardEntries(
            revealed.map((card) => ({ card, owner: state.players.indexOf(player) })),
            {
              title: `${context.sourceCard?.name || "コスト"}: デッキの上${revealed.length}枚を見る`,
              lead: `ソウルに入れる${pickCount}枚を選んでください（残りはドロップゾーンに置かれます）。`,
              min: pickCount,
              max: pickCount,
              forceDialog: true,
              allowCancel: false, // デッキを見た後は宣言前へ戻せない（強制選択）
              promptSeat: state.players.indexOf(player),
              purpose: "cost", // CPU対戦(src/22): コスト支払いの選択＝最小価値を差し出す
            },
          )
        : [];
    const soulSelected = (selected || []).map((entry) => entry.card).slice(0, pickCount);
    lookTopSoulSelections.push({ revealed, soulSelected });
  }
  let discardStepIndex = 0;
  let handToSoulStepIndex = 0;
  let handToDeckTopStepIndex = 0; // E-XB48(0037 トラクタービーム)
  let cardToSoulStepIndex = 0;
  let dropToSoulStepIndex = 0;
  let dropOwnMonsterStepIndex = 0;
  let fieldToGaugeStepIndex = 0;
  let fieldToDeckBottomStepIndex = 0; // E3'
  let dropOwnFieldStepIndex = 0;
  let dropOwnFieldOrSoulStepIndex = 0;
  let putSelectedFieldSoulStepIndex = 0;
  let lookTopSoulStepIndex = 0;
  let destroyOwnMonsterStepIndex = 0;
  let effectDestroyFailed = false; // destroyOwnMonster{asEffect} が置換等で破壊できなかった（R8）
  let returnFieldToHandStepIndex = 0;
  let restOwnMonsterStepIndex = 0;
  let dropToBottomStepIndex = 0;
  let soulToBottomStepIndex = 0;
  let chooseCostStepIndex = 0;
  let fieldSoulDropStepIndex = 0;
  const discarded = [];
  for (const step of applicableCostSteps) {
    const amount = step.amount || 1;
    if (step.op === "payGauge") {
      spendGaugePool(player, amount, { includeOpponent: includeOpponentGauge });
    }
    if (step.op === "discardAllHand") {
      const removed = removeInUseHandExcept(player, selectedCard);
      discardHandCardsToDrop(player, removed, { byCost: true, sourceOwner: state.players.indexOf(player), sourceCard: context.sourceCard || null }); // E6: コスト起因
      if (removed.length > 0) {
        addLog(`${player.name}はコストで手札を全て捨てました。`);
      }
    }
    if (step.op === "discardHand") {
      const movedCards = removePileEntries(player.hand, handDiscards[discardStepIndex] || []);
      discardStepIndex += 1;
      discardHandCardsToDrop(player, movedCards, { byCost: true, sourceOwner: state.players.indexOf(player), sourceCard: context.sourceCard || null }); // E6: コスト起因
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
      // ソウルイン funnel（enteredSoul・E-XB24・裏向き印・__soulHost 印）。移動は上で完了済み。
      putCardsToSoulWithTrigger(sourceCard, state.players.indexOf(player), movedCards, "hand", { alreadyPlaced: true, faceDown: step.faceDown });
      if (movedCards.length > 0) {
        // E-Y1(奇襲): 裏向きコストは表情報(カード名)を log に出さない（秘匿）。枚数のみ記す。
        addLog(
          step.faceDown
            ? `${player.name}はコストで${movedCards.length}枚を裏向きで${sourceCard.name}のソウルに入れました。`
            : `${player.name}はコストで${movedCards.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`,
        );
      }
    }
    if (step.op === "putHandToDeckTop") {
      // E-XB48(0037 トラクタービーム): 選んだ手札をデッキの上（push＝末尾）へ戻す。putHandToSoul 適用ブロックと同型。
      const movedCards = removePileEntries(player.hand, handToDeckTopSelections[handToDeckTopStepIndex] || []);
      handToDeckTopStepIndex += 1;
      player.deck.push(...movedCards); // 配列末尾＝デッキの上
      if (movedCards.length > 0) {
        // 情報漏洩ガード: state.log は viewFor で伏せられず両席/観戦へ配信される。手札(非公開)→デッキ上へ戻す
        // カード名を出すと、その1枚の内訳と相手の次ドローが先読み漏洩する。チャージ/faceDown putHandToSoul と
        // 同じく枚数のみ記す（デッキ順は自席含め全ロール非公開＝engine-host の hiddenPile）。
        addLog(`${player.name}はコストで手札${movedCards.length}枚をデッキの上に置きました。`);
      }
    }
    if (step.op === "putCardToSoul") {
      moveCostEntriesToSoul(player, cardToSoulSelections[cardToSoulStepIndex] || [], sourceCard, Boolean(step.faceDown)); // E-Y1(奇襲)
      cardToSoulStepIndex += 1;
    }
    if (step.op === "payLife") {
      player.life -= amount;
    }
    if (step.op === "damageSelf") {
      const dealing = applyDamageToPlayerAsk(state.players.indexOf(player), amount, { sourceName: sourceCard?.name, byAttack: false }); // 対話経路: 任意コストの軽減は本人に問う
      if (dealing?.then) await dealing;
    }
    if (step.op === "setLife") {
      player.life = step.life ?? step.amount ?? player.life;
    }
    if (step.op === "returnPendingTargetToHand") {
      const target = getPendingBattleTargetInfo(state.pendingAttack);
      if (target?.card) {
        const returnCause = returnPendingTargetCostCause(state.players.indexOf(player), target.owner);
        // 対話経路: 戻される札のコスト付き離場置換（“C・ドレイン”・X9 等）は持ち主に非同期で問い、対話の支払いで解決する
        // （同期の returnFieldTargetToHand 内の確認は権威サーバと同じ既定でしか確定できない）。手札に戻せない／Z9 で場に残る札は
        // 置換の前に同期側のゲートで止まるので、ここでは問わない。
        const leaving = target.card;
        const canAskReplacement =
          leaving.leaveFieldReplacement &&
          !cannotReturnToHand(leaving, returnCause) &&
          !(leaving.preventNextLeaveFieldCount > 0);
        if (canAskReplacement && (await tryLeaveFieldReplacement(leaving, target.owner))) {
          // 離場置換が成立＝場に残った（手札へは戻らない）。
        } else {
          returnFieldTargetToHand(target, sourceCard?.name || "効果", {
            cause: returnCause,
            ...(canAskReplacement ? { skipLeaveReplacement: true } : {}),
          });
        }
      }
    }
    if (["cancelRecentLifeLink", "cancelLifeLink"].includes(step.op)) {
      cancelRecentLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "cancelCallOpportunityLifeLink") {
      cancelCallOpportunityLifeLink(state.players.indexOf(player), step, sourceCard?.name);
    }
    if (step.op === "putTopDeckToSoul") {
      moveTopDeckToSoul(player, sourceCard, amount, Boolean(step.faceDown)); // E-Y1(奇襲)
    }
    if (step.op === "putDropToSoul") {
      // pt-fix-c T7-6: 上で選んだドロップのカードをソウルへ（enteredSoul 誘発つき・putCardToSoul と同じ移動）。
      const chosen = dropToSoulSelections[dropToSoulStepIndex] || [];
      dropToSoulStepIndex += 1;
      if (chosen.length > 0 && sourceCard) {
        moveCostEntriesToSoul(player, chosen, sourceCard);
      }
    }
    if (step.op === "putOwnFieldCardsToSoul") {
      moveFieldCardsToSoul(player, sourceCard, step.filter);
    }
    if (step.op === "discardSoul") {
      let soulDropped = 0;
      for (let index = 0; index < amount; index += 1) {
        const soulCard = sourceCard?.soul?.pop();
        if (soulCard) {
          player.drop.push(soulCard);
          soulDropped += 1;
        }
      }
      // E1/F2(D-BT02/0062等): 自ソウルをコストでドロップ → soulCardDropped（設置の自壊で離場したら発火時再検証で不発）。
      queueSoulCardDroppedTriggers(sourceCard, state.players.indexOf(player), soulDropped);
      maybeDropSetWhenSoulEmpty(sourceCard, state.players.indexOf(player)); // 設置のソウル切れ自壊（H-BT04/0025）
    }
    if (step.op === "discardSoulToDeckBottom") {
      const placed = [];
      if (step.amountFrom || step.allowMore) {
        // E3: 対話選択した具体的なソウル札を、選んだ順にデッキ下へ積む（allowMore の追加払い込み）。
        const selected = soulToBottomSelections[soulToBottomStepIndex] || [];
        soulToBottomStepIndex += 1;
        const soul = sourceCard?.soul || [];
        selected.forEach(({ card }) => {
          const idx = soul.findIndex((s) => s.instanceId === card.instanceId);
          if (idx >= 0) {
            const [moved] = soul.splice(idx, 1);
            player.deck.unshift(moved);
            placed.push(moved);
          }
        });
      } else {
        for (let index = 0; index < amount; index += 1) {
          const soulCard = sourceCard?.soul?.pop();
          if (soulCard) {
            player.deck.unshift(soulCard);
            placed.push(soulCard);
          }
        }
      }
      queueDeckBottomPlacedTriggers(state.players.indexOf(player), placed); // E-XB18: コストでソウル→デッキ下
    }
    if (step.op === "dropSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        dropFieldCardByRule(player, slot.zone);
      }
    }
    if (step.op === "destroySource") {
      // このカード自身をコストで「破壊」する（破壊時誘発・ソウルガード・ライフリンクが正しく発生）。
      const slot = findFieldCardSlot(sourceCard);
      if (slot) {
        // Q&A No.1007/1000/850・No.1933: コストの破壊は効果の破壊ではない（「カードの効果で破壊された時」は誘発しない）。
        const dropped = await destroyFieldCard(slot.owner, slot.zone, {
          cause: makeCostDestroyCause(state.players.indexOf(player), context.sourceCard || sourceCard || null, slot.owner),
          ignoreDestroyReplacement: true,
        });
        if (dropped) addLog(`${dropped.name}をコストで破壊しました。`);
      }
    }
    if (step.op === "putSelectedOwnFieldCardsToSoul") {
      moveSelectedFieldCardsToSoul(player, sourceCard, putSelectedFieldSoulSelections[putSelectedFieldSoulStepIndex] || []);
      putSelectedFieldSoulStepIndex += 1;
    }
    if (step.op === "destroyOwnMonster") {
      const targets = destroyOwnMonsterSelections[destroyOwnMonsterStepIndex] || [];
      destroyOwnMonsterStepIndex += 1;
      for (const target of targets) {
        // 破壊の発生源情報（makeEffectCause と同形）を載せる。以前は byEffect だけで sourceType/sourceCard が無く、
        // 「モンスターの効果で破壊された時」（eventDestroyCauseMatches{sourceType:"monster"}）が不成立だった
        // （煉獄騎士団の『〜を破壊する。破壊したら』起動で破壊されたエヴィルグレイブ等が誘発しない）。
        const costSource = context.sourceCard || sourceCard || null;
        // asEffect:true（2026-10-09 オーナー裁定R8）: コスト欄に置くが実体は効果の破壊＝「〜を破壊してよい。破壊したら」
        // （“C・ドレイン”の離場置換など、支払い＝解決時のもの）。破壊される側の置換（ソウルガードの任意使用・「破壊される
        // 場合かわりに」等）を通常どおり適用し、実際に破壊できなかったら支払い不成立（ok:false）として後段を行わせない。
        // 未指定（真の【コスト】）は従来どおり置換を無視して破壊する（後方互換）。
        // 真の【コスト】（asEffect 無し）は効果の破壊ではない（公式Q&A No.1007/1000/850「効果ではなく【使用コスト】で破壊
        // されたため…発動しません」・No.1933「【使用コスト】や【コールコスト】はカードの効果ではない」）＝byCost の原因で破壊し、
        // 「カードの効果で破壊された時」（eventDestroyCauseMatches{byEffect}）は誘発させない。「破壊された時」・ライフリンク・
        // ソウルガード（Q&A No.334）は従来どおり。asEffect は効果の破壊（R8）なので従来の効果の原因のまま。
        const dropped = await destroyFieldCard(target.owner, target.zone, {
          cause: step.asEffect
            ? {
                byEffect: true,
                byOpponent: false,
                sourceOwner: state.players.indexOf(player),
                sourceType: costSource ? effectiveCardType(costSource) : null,
                sourceCard: costSource,
              }
            : makeCostDestroyCause(state.players.indexOf(player), costSource, target.owner),
          ...(step.asEffect ? {} : { ignoreDestroyReplacement: true }),
        });
        if (dropped) addLog(`${dropped.name}を${step.asEffect ? "" : "コストで"}破壊しました。`);
        if (step.asEffect && !dropped) {
          effectDestroyFailed = true;
        }
      }
    }
    if (step.op === "restSource") {
      const slot = findFieldCardSlot(sourceCard);
      if (slot && !sourceCard.used) {
        await restFieldCard(slot.owner, slot.zone, sourceCard, { reason: "effect" }); // コストのレストも「効果でレスト」扱い（0082）
        addLog(`${sourceCard.name}をコストで【レスト】しました。`);
      }
    }
    if (step.op === "restOwnMonster") {
      const targets = restOwnMonsterSelections[restOwnMonsterStepIndex] || [];
      restOwnMonsterStepIndex += 1;
      for (const target of targets) {
        if (target.card && !target.card.used) {
          await restFieldCard(target.owner, target.zone, target.card, { reason: "effect" });
          addLog(`${target.card.name}をコストで【レスト】しました。`);
        }
      }
    }
    if (step.op === "putDropToDeckBottom") {
      const targets = dropToBottomSelections[dropToBottomStepIndex] || [];
      dropToBottomStepIndex += 1;
      // レビュー修正: 「選んだ順に下から積む」= 最初に選んだカードが最下になるよう逆順で unshift する。
      const placed = [];
      [...targets].reverse().forEach((target) => {
        const dropIndex = player.drop.indexOf(target.card);
        if (dropIndex >= 0) {
          const movedCard = player.drop.splice(dropIndex, 1)[0];
          player.deck.unshift(movedCard); // 配列先頭=デッキの下
          placed.push(movedCard);
        }
      });
      queueDeckBottomPlacedTriggers(state.players.indexOf(player), placed); // E-XB18: コストでドロップ→デッキ下
      if (targets.length > 0) addLog(`${player.name}はコストでドロップの${targets.length}枚をデッキの下に置きました。`);
    }
    if (step.op === "putTopDeckToDrop") {
      // E5: deckMilled ブロードキャストはバッチ1回（per-card だと microtask 交錯で named-once が
      // 二重計上し得る＝moveTopDeckToDrop と同じレース対策）。起因はコスト（byEffect ではない）。
      const milledCards = [];
      for (let index = 0; index < amount; index += 1) {
        const milled = player.deck.pop();
        if (milled) milledCards.push(milled);
      }
      putCardsToDropWithTrigger(player, state.players.indexOf(player), milledCards, "deck", { cause: { byCost: true, sourceOwner: state.players.indexOf(player), sourceCard: context.sourceCard || null } });
      if (player.deck.length === 0) declareDeckLoss(player);
      addLog(`${player.name}はコストでデッキの上から${amount}枚をドロップゾーンに置きました。`);
    }
    if (step.op === "dropOwnFieldCardSoul") {
      const selection = fieldSoulDropSelections[fieldSoulDropStepIndex];
      fieldSoulDropStepIndex += 1;
      if (selection) {
        selection.souls.forEach((entry) => {
          const soulIndex = (selection.host.card.soul || []).indexOf(entry.card);
          if (soulIndex >= 0) {
            player.drop.push(selection.host.card.soul.splice(soulIndex, 1)[0]);
          }
        });
        addLog(`${selection.host.card.name}のソウル${selection.souls.length}枚をコストでドロップゾーンに置きました。`);
        // E1/F2: ホスト存命のままソウルがドロップへ → soulCardDropped。
        queueSoulCardDroppedTriggers(selection.host.card, state.players.indexOf(player), selection.souls.length);
      }
    }
    if (step.op === "chooseCost") {
      const chosenOption = chooseCostSelections[chooseCostStepIndex];
      chooseCostStepIndex += 1;
      if (chosenOption) {
        const nested = await payStructuredCostWithSelection(player, chosenOption, context);
        if (!nested.ok) {
          return nested;
        }
      }
    }
    if (step.op === "returnOwnFieldCardToHand") {
      const targets = returnFieldToHandSelections[returnFieldToHandStepIndex] || [];
      returnFieldToHandStepIndex += 1;
      targets.forEach((target) => returnFieldCardToHandCost(player, target.zone));
    }
    if (step.op === "lookTopSelectToSoulRestToDrop") {
      const pick = lookTopSoulSelections[lookTopSoulStepIndex] || { revealed: [], soulSelected: [] };
      lookTopSoulStepIndex += 1;
      // pt-final(2): 選択フェイズでは覗いただけ。ここでデッキから実際に抜く（その間に動いた札は除外）。
      pick.revealed = pick.revealed.filter((card) => {
        const at = player.deck.indexOf(card);
        if (at < 0) {
          return false;
        }
        player.deck.splice(at, 1);
        return true;
      });
      pick.soulSelected = pick.soulSelected.filter((card) => pick.revealed.includes(card));
      // FE3(X-BT01/0032 羅生門): faceDown で選んだ1枚を裏向きソウルへ（秘匿・ログに名前を出さない）。
      lookTopSelectToSoulRestToDrop(player, sourceCard, step.count || 1, step.amount || 1, pick.revealed, pick.soulSelected, step.faceDown);
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
    if (step.op === "putOwnFieldCardsToDeckBottom") {
      // E3': 選択済みの場カードをデッキ下へ（離場の正規処理は putFieldCardToDeckBottom が担う）。
      const selectedTargets = fieldToDeckBottomSelections[fieldToDeckBottomStepIndex] || [];
      fieldToDeckBottomStepIndex += 1;
      selectedTargets.forEach((target) => putFieldCardToDeckBottom(player, target.zone));
    }
    if (step.op === "dropOwnFieldCard") {
      const selectedTargets = dropOwnFieldSelections[dropOwnFieldStepIndex] || [];
      dropOwnFieldStepIndex += 1;
      selectedTargets.forEach((target) => {
        const dropped = dropFieldCardByRule(player, target.zone);
        if (dropped) {
          addLog(`${dropped.name}をコストでドロップゾーンに置きました。`);
        }
      });
    }
    if (step.op === "dropOwnFieldOrSoulCard") {
      const selectedTargets = dropOwnFieldOrSoulSelections[dropOwnFieldOrSoulStepIndex] || [];
      dropOwnFieldOrSoulStepIndex += 1;
      selectedTargets.forEach((target) => payDropOwnFieldOrSoulTarget(player, target));
    }
  }
  checkWinner();
  if (effectDestroyFailed) {
    return { ok: false, reason: "破壊できなかったため、後の処理は行いません。", discarded };
  }
  return { ok: true, discarded };
}

function moveTopDeckToSoul(player, card, amount = 1, faceDown = false) {
  card.soul ||= [];
  const moved = [];
  // カードは自分自身のソウルにできない。デッキから重ねコール/コール中に、まだデッキに居る発生源が
  // デッキトップとして拾われる自食い＝孤児化を防ぐ（取り置いてデッキ上へ戻す。moveDropToSoul と対称）。
  const skipped = [];
  while (moved.length < amount && player.deck.length > 0) {
    const soulCard = player.deck.pop();
    if (soulCard.instanceId === card.instanceId) {
      skipped.push(soulCard);
      continue;
    }
    card.soul.push(soulCard);
    moved.push(soulCard);
  }
  for (let index = skipped.length - 1; index >= 0; index -= 1) {
    player.deck.push(skipped[index]); // 取り置いた自分自身をデッキ上（元位置）へ戻す
  }
  // ソウルイン funnel（enteredSoul・E-XB24 ソウル加入放送・E-Y1 裏向き印・表向き selfDroppedFromSoul の __soulHost 印）。
  // 移動（soul.push）は上で完了済み＝alreadyPlaced。
  putCardsToSoulWithTrigger(card, state.players.indexOf(player), moved, "deck", { alreadyPlaced: true, faceDown });
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
}

function moveTopDeckToGauge(player, amount = 1) {
  const placed = [];
  for (let index = 0; index < amount; index += 1) {
    const gaugeCard = player.deck.pop();
    if (gaugeCard) {
      player.gauge.push(gaugeCard);
      placed.push(gaugeCard);
    }
  }
  queueGaugePlacedTriggers(state.players.indexOf(player), placed); // 相手のゲージにカードが置かれた時（0020）
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
}

function moveDropToSoul(player, card, amount = 1, filter = {}) {
  card.soul ||= [];
  // カードは自分自身のソウルにできない。ドロップから重ねコール/コール中に、まだドロップに居る発生源（card）を
  // コスト札として拾う自食い（card.soul に card 自身が入り、以後の取り出しで見失う孤児化）を防ぐため
  // excludedCard=card で自身を候補から除外する（moveFieldCardsToSoul と同じ不変条件）。
  const movedCards = takeMatchingCards(player.drop, filter, amount, card);
  if (movedCards.length > 0) {
    putCardsToSoulWithTrigger(card, state.players.indexOf(player), movedCards, "drop");
    addLog(`${movedCards.map((soulCard) => soulCard.name).join("、")}を${card.name}のソウルに入れました。`);
  }
}

// 君の場の filter 一致カード全てを、発生源カード(card)のソウルに入れる（コスト用）。
// 例: マセマティック「君の場の《カルテットファイブ》のモンスター全てをこのカードのソウルに入れる」。
function moveFieldCardsToSoul(player, card, filter = {}) {
  card.soul ||= [];
  const moved = [];
  const movedZones = [];
  const movedNullified = []; // 離場直前の能力無効化状態（ライフリンク剥奪の判定用・第12回メカレビュー）
  zones.forEach((zone) => {
    const fieldCard = player.field[zone];
    if (fieldCard && fieldCard.instanceId !== card.instanceId && matchesCardFilter(fieldCard, filter)) {
      movedNullified.push(isAbilitiesNullified(fieldCard));
      // 保存則: ソウルへ移る場札自身のソウルはドロップへ解放する（ソウル札は自分のソウルを持てない＝
      // redirectTo:"sourceSoul" src/11:707 と同基準。入れ子のまま残すとカードがどのゾーンからも参照できなくなる）。
      player.drop.push(...(fieldCard.soul || []));
      fieldCard.soul = [];
      reconcileFaceDownSoulDrops();
      player.field[zone] = null;
      moved.push(fieldCard);
      movedZones.push(zone);
    }
  });
  if (moved.length > 0) {
    putCardsToSoulWithTrigger(card, state.players.indexOf(player), moved, "field");
    // field→soul は『場を離れる』＝ライフリンク＆「場から離れた時」誘発が発火（重ねコール/オルコス②と同じ裁定。
    // ソウルは場に含まれない）。detachFieldCardForMove を通す script move 経路(14:1108)は既に両方発火済みだが、
    // この関数は field を直接 null にして funnel へ渡す独自経路のため漏れていた。移動した各 field カードで1回ずつ発火する。
    moved.forEach((movedCard, index) => {
      applyLifeLink(movedCard, state.players.indexOf(player), { nullifiedAtLeave: movedNullified[index] });
      queueLeaveFieldTriggers(movedCard, state.players.indexOf(player), movedZones[index]);
    });
    addLog(`${moved.map((c) => c.name).join("、")}を${card.name}のソウルに入れました。`);
  }
}

// 選択された自分の場のカード（entries: {zone} を含む）を発生源のソウルへ入れる（putSelectedOwnFieldCardsToSoul用）。
function moveSelectedFieldCardsToSoul(player, sourceCard, entries = []) {
  sourceCard.soul ||= [];
  const owner = state.players.indexOf(player);
  const moved = [];
  const movedZones = [];
  const movedNullified = [];
  entries.forEach(({ zone }) => {
    const fieldCard = player.field[zone];
    if (fieldCard && fieldCard.instanceId !== sourceCard.instanceId) {
      movedNullified.push(isAbilitiesNullified(fieldCard)); // 離場直前に捕捉（能力無効化中はライフリンク無し）
      // 保存則: 場のカードが別カードのソウルへ入る時、そのカード自身のソウルはドロップへ解放する
      // （ソウル札は自分のソウルを持てない＝applyDestroyReplacement redirectTo:"sourceSoul" src/11:707 と同基準。
      //  第13回メカレビュー: ここだけ入れ子のまま残り、ホスト破壊後もドロップ配列内に隠れてどのゾーンからも
      //  参照できないカードが生じていた＝カードがゲームから消える保存則違反）。
      player.drop.push(...(fieldCard.soul || []));
      fieldCard.soul = [];
      reconcileFaceDownSoulDrops(); // ソウル札の公開・selfDroppedFromSoul（他の離場経路と同基準）
      player.field[zone] = null;
      moved.push(fieldCard);
      movedZones.push(zone);
    }
  });
  if (moved.length > 0) {
    // field→soul は『場を離れる』＝ライフリンク＆「場から離れた時」誘発が発火する（moveFieldCardsToSoul:2260 と
    // 同基準。第13回メカレビュー: このコスト経路だけ両方を鳴らしていなかった）。
    moved.forEach((movedCard, index) => {
      applyLifeLink(movedCard, owner, { nullifiedAtLeave: movedNullified[index] });
      queueLeaveFieldTriggers(movedCard, owner, movedZones[index]);
    });
    // ソウル加入は共通funnelへ（__soulHost スタンプ・enteredSoul・ソウル加入ブロードキャストを兄弟経路と統一）。
    putCardsToSoulWithTrigger(sourceCard, owner, moved, "field");
    addLog(`${moved.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`);
  }
  return moved;
}

// デッキ上から count 枚を見て、soulCards をソウルへ、残りをドロップへ（lookTopSelectToSoulRestToDrop用）。
// revealed 未指定時はここでデッキ上から count 枚めくる。soulCards 未指定時は先頭 amount 枚をソウルにする。
function lookTopSelectToSoulRestToDrop(player, sourceCard, count = 1, amount = 1, revealed = null, soulCards = null, faceDown = false) {
  const cards = revealed || [];
  if (!revealed) {
    for (let index = 0; index < count && player.deck.length > 0; index += 1) {
      cards.push(player.deck.pop());
    }
  }
  sourceCard.soul ||= [];
  const soulPick = soulCards || cards.slice(0, amount);
  const soulSet = new Set(soulPick.map((card) => card.instanceId));
  const toSoul = cards.filter((card) => soulSet.has(card.instanceId));
  const toDrop = cards.filter((card) => !soulSet.has(card.instanceId));
  sourceCard.soul.push(...toSoul);
  if (toSoul.length > 0) {
    toSoul.forEach((soulCard) => queueEnteredSoulTriggers(soulCard, state.players.indexOf(player), "deck", sourceCard)); // enteredSoul（デッキから）
    queueSoulCardAddedTriggers(sourceCard, state.players.indexOf(player), toSoul.length, toSoul[0]); // E-XB24
  }
  if (faceDown) {
    markSoulCardsFaceDown(toSoul, sourceCard); // FE3/E-Y1(奇襲): 「裏向きで」
  }
  player.drop.push(...toDrop);
  // E5: デッキ→ドロップ（コスト起因の残りドロップ）も deckMilled ブロードキャスト対象（byEffect ではない）。
  queueDeckMilledTriggers(state.players.indexOf(player), toDrop, { byCost: true, sourceOwner: state.players.indexOf(player), sourceCard: sourceCard || null });
  if (toSoul.length > 0) {
    // 裏向き札は表情報(名前)を log に出さない（秘匿。state.log は両席/観戦へ配信）。
    addLog(
      faceDown
        ? `${toSoul.length}枚を裏向きで${sourceCard.name}のソウルに入れました。`
        : `${toSoul.map((card) => card.name).join("、")}を${sourceCard.name}のソウルに入れました。`,
    );
  }
  if (toDrop.length > 0) {
    addLog(`残りの${toDrop.map((card) => card.name).join("、")}をドロップゾーンに置きました。`);
  }
  if (player.deck.length === 0) {
    declareDeckLoss(player);
  }
}

function putFieldCardToGauge(player, zone, options = {}) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  const lifeLinkNullifiedAtLeave = isAbilitiesNullified(card); // 離場直前に捕捉（能力無効化中はライフリンク無し）
  const typeAtLeave = effectiveCardType(card); // rule-zones-3: 場離れ誘発はこの時点の型で照合
  player.drop.push(...(card.soul || []));
  card.soul = [];
  reconcileFaceDownSoulDrops(); // ソウル札の公開・selfDroppedFromSoul（第12回メカレビュー: この経路の取りこぼしを是正）
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  applyLifeLink(card, state.players.indexOf(player), { nullifiedAtLeave: lifeLinkNullifiedAtLeave });
  // 「場から離れた時」誘発はゲージ置きでも発火（ライフリンクと同一離場サイト）。
  queueLeaveFieldTriggers(card, state.players.indexOf(player), zone, { eventCardTypeAtLeave: typeAtLeave });
  // rule-zones-3: 場の一時状態と、装備中だけアイテム扱い（変身/搭乗/着任）の型を離場で戻す。
  resetLeftFieldCardState(card);
  player.gauge.push(card);
  if (options.byEffect) {
    // 効果でゲージへ置く経路(putTargetToGauge)は『ゲージにカードが置かれた時』(メギトス opponentGaugePlaced)を
    // 発火する（占い→ゲージ src/15 と同基準・第11回メカレビュー）。queueGaugePlacedTriggers が noteGaugePlaced を
    // 1回だけ内部で行う=二重計上なし。ログは呼び出し側(putTargetToGauge)が『の効果で〜』を出すため、ここでは出さない。
    queueGaugePlacedTriggers(state.players.indexOf(player), [card]);
  } else {
    noteGaugePlaced(state.players.indexOf(player), 1); // E-XB12: コストで場札をゲージへ（この経路は queueGaugePlacedTriggers を通らない=既知近似）
    addLog(`${card.name}をコストでゲージに置きました。`);
  }
  return card;
}

// E3'(D-EB03/0002 アヴァロン“ベネディクト・レイ”): 場のカードをコストでデッキの下に置く。
// putFieldCardToGauge と同型＝離場の正規処理（ソウルのドロップ送り・ゾーンクリア・着任解除・ライフリンク）を
// 通し、本体の宛先だけデッキ下。デッキ配列は先頭=下・末尾=上（putDropToDeckBottom と同じ向き）なので unshift。
// ホスト離場のためソウル→ドロップは soulCardDropped を発火させない（dbt02 被覆表 #16 と同ポリシー）。
function putFieldCardToDeckBottom(player, zone) {
  const card = putFieldCardToDeck(player, zone, { position: "bottom" });
  if (card) {
    addLog(`${card.name}をコストでデッキの下に置きました。`);
  }
  return card;
}

// rule-zones-7: 場のカードを持ち主のデッキ（position: "bottom"=下 / "top"=上）へ置く共通の離場経路。
// ソウルのドロップ送り・裏向きソウルの公開・着任解除・場の一時状態と変身等の型のリセット・ライフリンク・
// 「場から離れた時」・「場のモンスターが手札かデッキに戻った時」(returnedTo:"deck"＝D・R・システム等
// returnedToZones に "deck" を持つリスナーのみ)を発火する。ログは呼び出し側が出す。
function putFieldCardToDeck(player, zone, options = {}) {
  const card = player.field[zone];
  if (!card) {
    return null;
  }
  const owner = state.players.indexOf(player);
  const lifeLinkNullifiedAtLeave = isAbilitiesNullified(card); // 離場直前に捕捉（能力無効化中はライフリンク無し）
  const typeAtLeave = effectiveCardType(card);
  player.drop.push(...(card.soul || []));
  card.soul = [];
  reconcileFaceDownSoulDrops(); // ソウル札の公開・selfDroppedFromSoul（第12回メカレビュー: この経路の取りこぼしを是正）
  player.field[zone] = null;
  if (zone === "item" && player.arrivalCardId === card.instanceId) {
    player.arrivalCardId = null;
  }
  resetLeftFieldCardState(card);
  applyLifeLink(card, owner, { nullifiedAtLeave: lifeLinkNullifiedAtLeave });
  // 「場から離れた時」誘発はデッキ戻しでも発火（ライフリンクと同一離場サイト）。
  queueLeaveFieldTriggers(card, owner, zone, { eventCardTypeAtLeave: typeAtLeave });
  if (options.position === "top") {
    player.deck.push(card);
  } else {
    player.deck.unshift(card);
    queueDeckBottomPlacedTriggers(owner, [card]); // E-XB18: 場→デッキ下
  }
  queueMonsterReturnedTriggers(card, owner, zone, { ...(options.details || {}), eventCardTypeAtLeave: typeAtLeave, returnedTo: "deck" });
  return card;
}

// コスト「手札に戻す」の原因（preventReturnToHand の from 判定用）。コストは効果ではない（byEffect:false）。
function returnPendingTargetCostCause(payerOwner, victimOwner) {
  return { byCost: true, byEffect: false, byOpponent: payerOwner !== victimOwner, sourceOwner: payerOwner };
}

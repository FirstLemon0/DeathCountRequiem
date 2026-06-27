// ==========================================================================
// buddyfight モジュール 06 — ログ・診断・対戦ログ書き出し
// 旧 app.js L1958-2179 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function addLog(message) {
  state?.log.unshift(message);
  if (state && state.log.length > 50) {
    state.log.length = 50;
  }
  recordDiagnosticEvent("message", {
    message,
    severity: classifyDiagnosticMessage(message),
  });
}

function createFightId() {
  return `fight-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function classifyDiagnosticMessage(message) {
  if (/未実装|まだ実装|想定外|エラー|失敗/.test(message)) {
    return "needs_attention";
  }
  if (/できません|足りません|対象.*選|選んでください|無効/.test(message)) {
    return "warning";
  }
  return "info";
}

function recordDiagnosticEvent(type, details = {}) {
  if (!state) {
    return;
  }
  state.diagnosticLog ||= [];
  state.diagnosticSeq = (state.diagnosticSeq || 0) + 1;
  state.diagnosticLog.push({
    seq: state.diagnosticSeq,
    type,
    recordedAt: new Date().toISOString(),
    context: diagnosticContext(),
    ...details,
  });
}

function diagnosticContext() {
  return {
    fightId: state.fightId || "",
    turnCount: state.turnCount,
    phase: state.phase,
    active: state.active,
    activeName: state.players?.[state.active]?.name || "",
    handOwner: Number.isInteger(handOwnerIndexSafe()) ? handOwnerIndexSafe() : null,
    pendingAttack: state.pendingAttack ? targetLabel(state.pendingAttack) : null,
    pendingAction: state.pendingAction ? pendingActionLabel(state.pendingAction) : null,
    selected: diagnosticSelected(),
    winner: state.winner || null,
  };
}

function handOwnerIndexSafe() {
  try {
    return state?.players ? handOwnerIndex() : null;
  } catch {
    return null;
  }
}

function diagnosticSelected() {
  if (!state?.selected) {
    return null;
  }
  return {
    ...state.selected,
    card: compactCardForLog(getSelectedCard()),
  };
}

function compactCardForLog(card) {
  if (!card) {
    return null;
  }
  return {
    id: card.id,
    instanceId: card.instanceId,
    no: card.no || "",
    name: card.name,
    type: card.type,
    currentType: effectiveCardType(card),
    world: card.world || "",
    attributes: [...(card.attributes || [])],
    size: card.size ?? null,
    power: card.power ?? null,
    critical: card.critical ?? null,
    defense: card.defense ?? null,
    used: Boolean(card.used),
    soul: (card.soul || []).map(compactCardForLog),
  };
}

function compactTargetForLog(target) {
  if (!target) {
    return null;
  }
  return {
    owner: target.owner,
    ownerName: state.players?.[target.owner]?.name || "",
    zone: target.zone,
    zoneLabel: zoneLabel(target.zone),
    card: compactCardForLog(target.card),
    note: target.note || "",
  };
}

function compactChoiceForLog(choice) {
  return {
    choiceIndex: choice.choiceIndex,
    index: choice.index,
    owner: choice.owner,
    zone: choice.zone,
    zoneLabel: choice.zone ? zoneLabel(choice.zone) : "",
    note: choice.note || "",
    card: compactCardForLog(choice.card),
  };
}

function compactPlayerForLog(player, owner, options = {}) {
  if (!player) {
    return null;
  }
  const includeDeckOrder = options.includeDeckOrder !== false;
  return {
    owner,
    name: player.name,
    deckName: player.deckName,
    life: player.life,
    flag: compactCardForLog(player.flag),
    buddy: compactCardForLog(player.buddy),
    partnerCalled: Boolean(player.partnerCalled),
    hand: player.hand.map(compactCardForLog),
    gauge: player.gauge.map(compactCardForLog),
    drop: player.drop.map(compactCardForLog),
    deckCount: player.deck.length,
    deck: includeDeckOrder ? player.deck.map(compactCardForLog) : undefined,
    field: Object.fromEntries(
      Object.entries(player.field || {}).map(([zone, card]) => [zone, compactCardForLog(card)]),
    ),
    oncePerTurn: { ...(player.oncePerTurn || {}) },
  };
}

function compactFightStateForLog(options = {}) {
  if (!state?.players) {
    return null;
  }
  return {
    fightId: state.fightId || "",
    turnCount: state.turnCount,
    phase: state.phase,
    active: state.active,
    activeName: state.players[state.active]?.name || "",
    chargedThisTurn: Boolean(state.chargedThisTurn),
    drewThisTurn: Boolean(state.drewThisTurn),
    attacksThisTurn: state.attacksThisTurn || 0,
    winner: state.winner || null,
    selected: diagnosticSelected(),
    pendingAttack: state.pendingAttack ? { ...state.pendingAttack } : null,
    pendingAction: state.pendingAction
      ? {
          ...state.pendingAction,
          card: compactCardForLog(state.pendingAction.card),
        }
      : null,
    players: state.players.map((player, owner) => compactPlayerForLog(player, owner, options)),
  };
}

function buildBattleLogExport() {
  const events = state?.diagnosticLog || [];
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    note: "この診断ログには手札・デッキ順・選択内容など、デバッグ用の非公開情報を含みます。",
    app: {
      ruleEra: ruleEraLabel,
      url: location.href,
      userAgent: navigator.userAgent,
    },
    fight: {
      id: state?.fightId || "",
      finalState: compactFightStateForLog({ includeDeckOrder: true }),
    },
    diagnostics: {
      attentionEvents: events.filter((event) => event.severity === "needs_attention"),
      warningEvents: events.filter((event) => event.severity === "warning"),
      unimplementedMessages: events.filter((event) => /未実装|まだ実装/.test(event.message || "")),
    },
    events,
    visibleLog: [...(state?.log || [])],
  };
}

function downloadBattleLog() {
  if (!state) {
    return;
  }
  recordDiagnosticEvent("export", {
    message: "対戦診断ログを保存しました。",
    severity: "info",
  });
  const payload = buildBattleLogExport();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeLogFileName(state.fightId || "buddyfight-log")}.json`;
  link.click();
  URL.revokeObjectURL(url);
  addLog("対戦診断ログをJSONで保存しました。");
}

function safeLogFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_");
}


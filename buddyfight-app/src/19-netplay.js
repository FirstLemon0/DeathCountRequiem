// ==========================================================================
// buddyfight モジュール 19 — ネット対戦(部屋/同期/隠し選択)
// 旧 app.js L10272-10573 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
function isNetworkPage() {
  return Boolean(elements.netplayPanel);
}

function isNetworkConnected() {
  return Boolean(networkSession.connected && Number.isInteger(networkSession.seat));
}

function updateNetworkStatus(message) {
  if (elements.networkStatus) {
    elements.networkStatus.textContent = message;
  }
}

async function createNetworkRoom() {
  try {
    updateNetworkStatus("部屋を作成しています...");
    const response = await fetch("api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deckValues: currentDeckValues() }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "部屋を作成できませんでした。");
    }
    startNetworkSession(data);
  } catch (error) {
    updateNetworkStatus(`接続失敗: ${error.message}`);
  }
}

async function joinNetworkRoom() {
  const roomId = elements.roomInput.value.trim();
  if (!roomId) {
    updateNetworkStatus("参加する部屋番号を入力してください。");
    return;
  }
  try {
    updateNetworkStatus("部屋に参加しています...");
    const response = await fetch(`api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deckValues: currentDeckValues() }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "部屋に参加できませんでした。");
    }
    startNetworkSession(data);
  } catch (error) {
    updateNetworkStatus(`接続失敗: ${error.message}`);
  }
}

function startNetworkSession(data) {
  networkSession.connected = true;
  networkSession.roomId = data.roomId;
  networkSession.token = data.token;
  networkSession.seat = data.playerIndex;
  networkSession.lastSeq = 0;
  elements.roomInput.value = data.roomId;
  elements.copyRoomButton.disabled = false;
  elements.playerSeatLabel.textContent = `席: ${networkPlayerName(networkSession.seat)}`;
  applyDeckValues(data.deckValues);
  updateNetworkStatus(`部屋 ${data.roomId} に接続しました。`);
  connectNetworkEvents();
  render();
}

function connectNetworkEvents() {
  networkSession.eventSource?.close();
  const url = `api/rooms/${encodeURIComponent(networkSession.roomId)}/events?token=${encodeURIComponent(networkSession.token)}`;
  const source = new EventSource(url);
  networkSession.eventSource = source;
  source.addEventListener("message", (event) => {
    applyNetworkMessage(JSON.parse(event.data));
  });
  source.addEventListener("error", () => {
    updateNetworkStatus("接続が切れました。サーバーを確認してください。");
  });
}

function applyNetworkMessage(message) {
  if (!message || (message.type !== "hello" && message.seq <= networkSession.lastSeq)) {
    return;
  }
  networkSession.lastSeq = Math.max(networkSession.lastSeq, message.seq || 0);
  if (message.type === "hello") {
    applyDeckValues(message.deckValues);
    if (message.snapshot) {
      applyNetworkSnapshot(message.snapshot);
    }
    return;
  }
  if (message.type === "deck") {
    applyDeckValues(message.deckValues);
    updateNetworkStatus(`部屋 ${networkSession.roomId}: デッキ選択を同期しました。`);
    render();
    return;
  }
  if (message.type === "hidden_choice_request") {
    handleRemoteNetworkChoiceRequest(message);
    return;
  }
  if (message.type === "hidden_choice_response") {
    resolveRemoteNetworkChoice(message);
    return;
  }
  if (message.type === "snapshot" && message.sender !== networkSession.token) {
    applyDeckValues(message.deckValues);
    applyNetworkSnapshot(message.snapshot);
    updateNetworkStatus(`部屋 ${networkSession.roomId}: ${message.label || "盤面"}を同期しました。`);
  }
}

function applyNetworkSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  networkSession.applyingSnapshot = true;
  state = deepClone(snapshot);
  state.selected = null;
  state.linkAttackers = [];
  networkSession.applyingSnapshot = false;
  // B2: 相手の操作で盤面が変わったら、自分のUI状態（対象選択・カードシート・確認）はリセット
  uiTargeting = null;
  closeCardSheet();
  if (confirmDialogResolver) {
    resolveConfirmDialog(false); // 確認待機中なら破棄（宙づり防止）
  }
  render();
}

function createNetworkChoiceRequestId() {
  return `choice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function requestRemoteNetworkChoice(targetSeat, choices, options = {}) {
  if (!isNetworkConnected() || networkSession.seat === targetSeat) {
    return null;
  }
  const requestId = createNetworkChoiceRequestId();
  const choice = await new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      networkSession.pendingChoiceResolvers.delete(requestId);
      updateNetworkStatus("相手の選択待ちが時間切れになりました。");
      resolve(null);
    }, 60 * 1000);
    networkSession.pendingChoiceResolvers.set(requestId, {
      resolve: (selectedChoice) => {
        clearTimeout(timeoutId);
        resolve(selectedChoice);
      },
    });
    sendNetworkMessage("hidden_choice_request", {
      requestId,
      targetSeat,
      title: options.title || "選択",
      lead: options.lead || "",
      choices: choices.map(({ key, card }) => ({
        key,
        card: {
          name: card.name,
          type: card.type || "choice",
        },
      })),
    }).then((sent) => {
      if (!sent) {
        const pending = networkSession.pendingChoiceResolvers.get(requestId);
        networkSession.pendingChoiceResolvers.delete(requestId);
        pending?.resolve(null);
      }
    });
  });
  return choice;
}

async function handleRemoteNetworkChoiceRequest(message) {
  if (
    message.targetSeat !== networkSession.seat ||
    !message.requestId ||
    networkSession.handledChoiceRequests.has(message.requestId)
  ) {
    return;
  }
  networkSession.handledChoiceRequests.add(message.requestId);
  const choices = (message.choices || []).map(({ key, card }) => ({
    key,
    card: {
      name: card?.name || String(key),
      type: card?.type || "choice",
    },
  }));
  updateNetworkStatus("相手の効果で選択を求められています。");
  const selected = await chooseCardEntries(choices, {
    title: message.title || "選択",
    lead: message.lead || "",
    min: 1,
    max: 1,
    forceDialog: true,
    allowCancel: false,
  });
  await sendNetworkMessage("hidden_choice_response", {
    requestId: message.requestId,
    choice: selected?.[0]?.key || null,
  });
  updateNetworkStatus(`部屋 ${networkSession.roomId}: 選択を送信しました。`);
}

function resolveRemoteNetworkChoice(message) {
  const pending = networkSession.pendingChoiceResolvers.get(message.requestId);
  if (!pending) {
    return;
  }
  networkSession.pendingChoiceResolvers.delete(message.requestId);
  pending.resolve(message.choice || null);
}

async function sendNetworkMessage(type, payload) {
  if (!isNetworkConnected()) {
    return false;
  }
  try {
    const response = await fetch(`api/rooms/${encodeURIComponent(networkSession.roomId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: networkSession.token,
        type,
        payload,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "同期に失敗しました。");
    }
    return true;
  } catch (error) {
    updateNetworkStatus(`同期失敗: ${error.message}`);
    return false;
  }
}

async function runNetworkMutation(label, callback) {
  const beforeSummary = compactFightStateForLog({ includeDeckOrder: false });
  if (!isNetworkConnected() || networkSession.applyingSnapshot) {
    await callback();
    recordDiagnosticEvent("user_action", {
      label,
      changed: JSON.stringify(beforeSummary) !== JSON.stringify(compactFightStateForLog({ includeDeckOrder: false })),
      before: beforeSummary,
      after: compactFightStateForLog({ includeDeckOrder: false }),
    });
    return;
  }
  const before = JSON.stringify(state);
  await callback();
  const changed = JSON.stringify(state) !== before;
  recordDiagnosticEvent("user_action", {
    label,
    changed,
    before: beforeSummary,
    after: compactFightStateForLog({ includeDeckOrder: false }),
  });
  if (changed) {
    sendNetworkMessage("snapshot", {
      label,
      snapshot: state,
      deckValues: currentDeckValues(),
    });
  }
}

function syncNetworkDeckChoice(playerIndex) {
  if (!isNetworkConnected() || networkSession.seat !== playerIndex) {
    return;
  }
  sendNetworkMessage("deck", {
    playerIndex,
    deckValues: currentDeckValues(),
  });
}

function networkPlayerName(index) {
  return index === 0 ? "プレイヤー1" : "プレイヤー2";
}

async function copyRoomId() {
  if (!networkSession.roomId) {
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(networkSession.roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    updateNetworkStatus("参加URLをクリップボードにコピーしました。");
  } catch {
    elements.roomInput.select();
    updateNetworkStatus("コピーできないため、部屋番号欄を選択しました。");
  }
}


// 権威サーバ用シンクライアント（play.html 専用）。
// ロビー（作成/参加/役割割当/デッキ選択/開始）＋ SSE 受信 → サーバ配信viewを engine render で描画。
// 操作はサーバへ「アクション」として送信（ローカル解決はしない）。
// 対応操作: ドロー/各フェイズ/ターン終了（無選択）＋ チャージ/コール/使用/攻撃（カード選択・対象クリック）
//   ＋ 解決（攻撃/行動の保留を解決＝対抗で「何も使わない（パス）」する手段）。
//   選択ダイアログ/任意能力ゲート/じゃんけん/ソウルガード等の確認は prompt_request で往復（showPrompt）。
// 未対応(次): 効果対象を要する使用の対象指定（effectTarget）。
(() => {
  const thin = window.__buddyfightThin;
  const $ = (id) => document.getElementById(id);
  const session = { roomId: "", token: "", clientId: "", role: null, started: false, es: null };
  const ui = { selected: null, targeting: false, effectTargeting: null, activePromptId: null };

  // ---- 自作（カスタム）デッキ: builder と同じ localStorage を共有。サーバへは recipe ごと custom 同梱で送る ----
  const CUSTOM_DECK_KEY = "buddyfight.customDecks.v1";
  const customDecksById = new Map();
  function loadCustomDecks() {
    customDecksById.clear();
    try {
      const parsed = JSON.parse(localStorage.getItem(CUSTOM_DECK_KEY) || "[]");
      const decks = Array.isArray(parsed) ? parsed : parsed.decks || [];
      decks
        .filter((d) => d && d.id && d.name && d.flag && Array.isArray(d.recipe))
        .forEach((d) => customDecksById.set(d.id, d));
    } catch { /* 壊れたローカルデータは無視 */ }
    return customDecksById;
  }
  // lobbyDeckSelect で選択中の id から送信用 deck ペイロードを作る。
  // 自作デッキなら full プロファイルを custom 同梱（サーバが engine の localStorage へ注入し id で割当）。
  function selectedDeckPayload() {
    const id = $("lobbyDeckSelect").value;
    const custom = customDecksById.get(id);
    return custom ? { id, name: custom.name, custom } : { id };
  }

  // ---- セッション永続化（リロード/一時切断からの同席復帰。部屋別キーで別部屋と共存） ----
  const sk = (id) => `bf_auth_session:${id}`;
  function saveSession() {
    if (!session.roomId) return;
    try {
      localStorage.setItem(
        sk(session.roomId),
        JSON.stringify({ roomId: session.roomId, token: session.token, clientId: session.clientId, role: session.role }),
      );
      localStorage.setItem("bf_auth_last", session.roomId);
    } catch { /* localStorage 不可環境は無視 */ }
  }
  function loadSession(roomId) {
    try {
      const id = roomId || localStorage.getItem("bf_auth_last");
      if (!id) return null;
      const raw = localStorage.getItem(sk(id));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function clearSession(roomId) {
    try {
      const id = roomId || session.roomId;
      if (id) localStorage.removeItem(sk(id));
      if (localStorage.getItem("bf_auth_last") === id) localStorage.removeItem("bf_auth_last");
    } catch { /* noop */ }
  }

  async function api(pathname, body) {
    const options = body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined;
    const res = await fetch(pathname, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  const setStatus = (m) => ($("lobbyStatus").textContent = m);
  const mySeat = () => (session.role === 0 || session.role === 1 ? session.role : null);
  const isMyTurnSeat = () => mySeat() !== null && session.started;
  function roleLabel(role) {
    if (role === 0) return "先手(P1)";
    if (role === 1) return "後手(P2)";
    if (role === "spectator") return "観戦";
    return "-";
  }

  // ---- デッキ一覧（権威API→失敗時はクライアント側エンジンで補完） ----
  async function loadDecks() {
    let decks = null;
    try {
      decks = (await api("auth/decks")).decks;
    } catch {
      try {
        if (thin?.loadGameData) {
          await thin.loadGameData();
          decks = thin.getDeckProfiles().map((d) => ({ id: d.id, name: d.name, productName: d.productName }));
        }
      } catch (error) {
        setStatus(`デッキ一覧取得失敗: ${error.message}`);
      }
    }
    if (!decks) return;
    const select = $("lobbyDeckSelect");
    select.innerHTML = "";
    decks.forEach((deck) => {
      const option = document.createElement("option");
      option.value = deck.id;
      option.textContent = deck.productName ? `${deck.name} / ${deck.productName}` : deck.name;
      select.append(option);
    });
    // builder で保存した自作デッキを併記（送信時に recipe を custom 同梱）
    loadCustomDecks().forEach((deck) => {
      const option = document.createElement("option");
      option.value = deck.id;
      option.textContent = `自作: ${deck.name}`;
      select.append(option);
    });
  }

  // ---- SSE ----
  function connectSse() {
    session.es?.close();
    const url = `auth/rooms/${encodeURIComponent(session.roomId)}/events?token=${encodeURIComponent(session.token)}`;
    const es = new EventSource(url);
    session.es = es;
    es.addEventListener("open", () => setStatus(`部屋 ${session.roomId} に接続中`));
    es.addEventListener("message", (event) => handleMessage(JSON.parse(event.data)));
    // EventSource は自動再接続するので close せず待機（リロード/瞬断からの復帰）。
    es.addEventListener("error", () => setStatus("再接続中… 相手の操作/接続を待っています"));
  }

  function handleMessage(message) {
    if (message.type === "hello" || message.type === "lobby") {
      applyLobby(message);
    } else if (message.type === "view") {
      session.started = true;
      saveSession();
      const seat = message.role === 0 || message.role === 1 ? message.role : null;
      thin?.setViewerSeat?.(seat);
      clearSelection();
      thin?.applyView?.(message.state);
      document.body.classList.add("game-started");
      $("lobbySeatLabel").textContent = `役割: ${roleLabel(message.role)}`;
    } else if (message.type === "prompt_request") {
      // 観戦/非該当席には届かない設計だが、念のため防御。
      if (mySeat() === null) return;
      if (message.requestId === ui.activePromptId) return; // 再接続時の再送重複を吸収
      showPrompt(message);
    }
  }

  function applyLobby(message) {
    session.started = message.started;
    if (message.you) {
      session.role = message.you.role;
      session.clientId = message.you.clientId;
    }
    saveSession();
    $("lobbySeatLabel").textContent = `役割: ${roleLabel(session.role)}`;
    setStatus(`部屋 ${message.roomId} ${message.started ? "（対戦中）" : "（待機中）"}`);
    const roster = $("lobbyRoster");
    roster.innerHTML = "";
    (message.members || []).forEach((member) => {
      const div = document.createElement("div");
      div.className = "lobby-member";
      const me = member.clientId === session.clientId ? "（あなた）" : "";
      const deck = member.deck ? ` / ${member.deck.name || member.deck.id || "デッキ確定"}` : " / デッキ未選択";
      div.textContent = `${roleLabel(member.role)}: ${member.name}${me}${member.online ? "" : " [接続なし]"}${deck}`;
      roster.append(div);
    });
    // 対局中に相手席が切断していたら「待機中」を明示。
    if (session.started && mySeat() !== null) {
      const opponent = (message.members || []).find((m) => m.role === 1 - mySeat());
      if (opponent && !opponent.online) {
        setStatus("相手が切断中です（再接続を待機中）");
      }
    }
  }

  // ---- ロビー操作 ----
  const lobbyAction = (action, extra = {}) =>
    api(`auth/rooms/${encodeURIComponent(session.roomId)}/lobby`, { token: session.token, action, ...extra }).catch(
      (error) => setStatus(error.message),
    );
  const askName = () => window.prompt("プレイヤー名は？", "プレイヤー") || "プレイヤー";

  async function createOrJoin(kind) {
    try {
      const deck = selectedDeckPayload();
      const pathname = kind === "create" ? "auth/rooms" : `auth/rooms/${encodeURIComponent($("lobbyRoomInput").value.trim())}/join`;
      if (kind === "join" && !$("lobbyRoomInput").value.trim()) {
        setStatus("参加する部屋番号を入力してください");
        return;
      }
      const data = await api(pathname, { name: askName(), deck });
      Object.assign(session, { roomId: data.roomId, token: data.token, clientId: data.clientId, role: data.role });
      session.started = false;
      // 新しい部屋へ入り直す＝ロビーが主役。前局の game-started を解除しないとモバイルでロビーが隠れたまま。
      document.body.classList.remove("game-started");
      saveSession();
      $("lobbyRoomInput").value = data.roomId;
      connectSse();
      setStatus(`部屋 ${data.roomId} ${kind === "create" ? "を作成" : "に参加"}しました`);
    } catch (error) {
      setStatus(`${kind === "create" ? "作成" : "参加"}失敗: ${error.message}`);
    }
  }
  $("lobbyCreateButton").addEventListener("click", () => createOrJoin("create"));
  $("lobbyJoinButton").addEventListener("click", () => createOrJoin("join"));
  $("lobbySeat0Button").addEventListener("click", () => lobbyAction("assign", { role: 0 }));
  $("lobbySeat1Button").addEventListener("click", () => lobbyAction("assign", { role: 1 }));
  $("lobbySpectateButton").addEventListener("click", () => lobbyAction("assign", { role: "spectator" }));
  $("lobbySwapButton").addEventListener("click", () => lobbyAction("swapSeats"));
  $("lobbySetDeckButton").addEventListener("click", () => lobbyAction("setDeck", { deck: selectedDeckPayload() }));
  $("lobbyStartButton").addEventListener("click", () => lobbyAction("start"));
  $("lobbyCopyButton").addEventListener("click", async () => {
    if (!session.roomId) return;
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(session.roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setStatus("参加URLをコピーしました");
    } catch {
      $("lobbyRoomInput").select();
    }
  });

  // ---- アクション送信 ----
  async function sendAction(type, params) {
    if (!isMyTurnSeat()) {
      setStatus("観戦者は操作できません");
      return;
    }
    try {
      await api(`auth/rooms/${encodeURIComponent(session.roomId)}/action`, { token: session.token, type, params: params || {} });
    } catch (error) {
      setStatus(`操作不可: ${error.message}`);
    } finally {
      closeMenu();
    }
  }
  const wireButton = (id, type) => {
    const el = $(id);
    if (el) el.addEventListener("click", () => sendAction(type));
  };
  wireButton("drawButton", "draw");
  wireButton("mainPhaseButton", "main");
  wireButton("attackPhaseButton", "attackPhase");
  wireButton("finalPhaseButton", "finalPhase");
  wireButton("endTurnButton", "endTurn");
  // 解決ボタン（攻撃/行動の保留を解決＝対抗・割り込みで「何も使わない（パス）」する手段）。
  // pending がある間だけ render() が有効化する（攻撃側/防御側の双方が押せ、可否はサーバが canActorActNow で判定）。
  wireButton("resolveAttackButton", "resolve");

  // ---- 選択＋アクションメニュー ----
  function clearSelection() {
    ui.selected = null;
    ui.targeting = false;
    ui.effectTargeting = null;
    closeMenu();
  }
  function closeMenu() {
    document.getElementById("playActionMenu")?.remove();
  }
  function showMenu(items) {
    closeMenu();
    const menu = document.createElement("div");
    menu.id = "playActionMenu";
    menu.style.cssText =
      "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:200;display:flex;flex-wrap:wrap;gap:8px;" +
      "padding:10px 12px;border:1px solid var(--line,#345);border-radius:12px;background:var(--panel,#141b2b);box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:94vw;";
    items.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      btn.style.cssText = "min-height:40px;padding:6px 12px;font-weight:800;";
      btn.addEventListener("click", item.run);
      menu.append(btn);
    });
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "閉じる";
    close.style.cssText = "min-height:40px;padding:6px 12px;";
    close.addEventListener("click", clearSelection);
    menu.append(close);
    document.body.append(menu);
  }

  // ---- プロンプト往復（カード選択ダイアログ）モーダル ----
  // サーバの prompt_request を受け、候補から選んで POST /prompt で応答する。
  // 重要: 応答の selectedIndexes には candidate.choiceIndex を詰める
  // （candidate.index は pile index で別物。エンジン側は choiceIndex で照合する）。
  function promptCandidateLabel(candidate) {
    const card = candidate.card || {};
    const name = card.name || candidate.note || `候補 ${(candidate.choiceIndex ?? 0) + 1}`;
    const meta = [card.no, candidate.zoneLabel].filter(Boolean).join(" ・ ");
    return meta ? `${name}（${meta}）` : name;
  }

  function showPrompt(req) {
    closeMenu();
    ui.activePromptId = req.requestId; // 再接続再送の重複抑止用
    const candidates = req.candidates || [];
    const min = req.min ?? 1;
    const max = req.max ?? min;
    const allowCancel = req.allowCancel !== false;
    const single = min === 1 && max === 1;

    const menu = document.createElement("div");
    menu.id = "playActionMenu";
    menu.style.cssText =
      "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;" +
      "padding:12px 14px;border:1px solid var(--line,#345);border-radius:12px;background:var(--panel,#141b2b);box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:94vw;max-height:70vh;overflow:auto;";

    const head = document.createElement("div");
    head.style.cssText = "font-weight:800;";
    head.textContent = req.title || "選択";
    menu.append(head);
    if (req.lead) {
      const lead = document.createElement("div");
      lead.style.cssText = "font-size:.85em;opacity:.85;";
      lead.textContent = req.lead;
      menu.append(lead);
    }

    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";
    menu.append(list);

    if (single) {
      // 単一選択（min=max=1）: 各候補ボタンで即決。
      candidates.forEach((candidate) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = promptCandidateLabel(candidate);
        btn.style.cssText = "min-height:40px;padding:6px 12px;font-weight:800;";
        btn.addEventListener("click", () =>
          sendPromptResponse(req.requestId, { selectedIndexes: [candidate.choiceIndex] }),
        );
        list.append(btn);
      });
    } else {
      // 複数選択（min〜max）: トグルで選び「決定」で送信。
      const selected = new Set();
      const decide = document.createElement("button");
      decide.type = "button";
      decide.style.cssText = "min-height:40px;padding:6px 12px;font-weight:800;";
      decide.textContent = `決定（${min}〜${max}枚）`;
      decide.disabled = selected.size < min || selected.size > max;
      candidates.forEach((candidate) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = promptCandidateLabel(candidate);
        btn.style.cssText = "min-height:40px;padding:6px 12px;";
        btn.addEventListener("click", () => {
          if (selected.has(candidate.choiceIndex)) {
            selected.delete(candidate.choiceIndex);
          } else {
            selected.add(candidate.choiceIndex);
          }
          btn.style.outline = selected.has(candidate.choiceIndex) ? "2px solid var(--accent,#5cf)" : "";
          decide.disabled = selected.size < min || selected.size > max;
        });
        list.append(btn);
      });
      decide.addEventListener("click", () =>
        sendPromptResponse(req.requestId, { selectedIndexes: [...selected] }),
      );
      menu.append(decide);
    }

    if (allowCancel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "キャンセル";
      cancel.style.cssText = "min-height:40px;padding:6px 12px;";
      // 空応答 → エンジン側 resolveServerSelection が「キャンセル可ならnull」で扱う。
      cancel.addEventListener("click", () => sendPromptResponse(req.requestId, {}));
      menu.append(cancel);
    }
    document.body.append(menu);
  }

  async function sendPromptResponse(requestId, response) {
    try {
      await api(`auth/rooms/${encodeURIComponent(session.roomId)}/prompt`, {
        token: session.token,
        requestId,
        response,
      });
    } catch (error) {
      setStatus(`選択送信失敗: ${error.message}`);
    } finally {
      ui.activePromptId = null;
      closeMenu();
    }
  }

  function handCardMenu(instanceId) {
    ui.selected = { source: "hand", owner: mySeat(), instanceId };
    ui.targeting = false;
    const sel = ui.selected;
    showMenu([
      { label: "チャージ&ドロー", run: () => sendAction("charge", { selected: sel }) },
      { label: "レフトにコール", run: () => sendAction("call", { selected: sel, callZone: "left" }) },
      { label: "センターにコール", run: () => sendAction("call", { selected: sel, callZone: "center" }) },
      { label: "ライトにコール", run: () => sendAction("call", { selected: sel, callZone: "right" }) },
      { label: "使用/装備", run: () => sendAction("use", { selected: sel }) },
      { label: "使用（効果対象を選ぶ）", run: () => startEffectTargeting(sel, "use") },
      { label: "バディコール宣言", run: () => sendAction("buddy", { selected: sel }) },
    ]);
  }

  function fieldCardMenu(owner, zone, instanceId) {
    ui.selected = { source: "field", owner, zone, instanceId };
    ui.targeting = false;
    const sel = ui.selected;
    showMenu([
      { label: "攻撃（対象を選ぶ）", run: () => { ui.targeting = true; closeMenu(); setStatus("攻撃対象（相手のカード/本体）をクリック"); } },
      { label: "連携に追加", run: () => sendAction("link", { selected: sel }) },
      { label: "使用（能力）", run: () => sendAction("use", { selected: sel }) },
      { label: "使用（効果対象を選ぶ）", run: () => startEffectTargeting(sel, "use") },
    ]);
  }

  // ---- 効果対象タップ（attackTargetタップと同型。対象を盤面カードでタップ→effectTarget送信）----
  function startEffectTargeting(sel, type, extra = {}) {
    ui.effectTargeting = { selected: sel, type, callZone: extra.callZone };
    ui.targeting = false;
    closeMenu();
    setStatus("効果対象を盤面のカードでタップしてください");
  }

  // ---- ワールドタイル→デッキ情報ポップアップ（thin専用。相手のデッキ名は非公開）----
  function showDeckInfo(owner) {
    const st = thin?.getState?.();
    const player = st?.players?.[owner];
    const dialog = $("deckInfoDialog");
    const body = $("deckInfoBody");
    if (!player || !dialog || !body) return;
    const hideName = owner !== mySeat();
    const deckName = hideName ? "（非公開）" : player.deckName || "（不明）";
    const world = player.flag?.name || player.world || "-";
    const buddyState = player.buddy ? (player.partnerCalled ? "（コール済）" : "（未コール）") : "";
    const buddyName = player.buddy ? `${player.buddy.name}${buddyState}` : "なし";
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s);
    const rows = [
      ["プレイヤー", player.name],
      ["デッキ名", deckName],
      ["使用ワールド", world],
      ["バディ", buddyName],
    ];
    body.innerHTML = rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
    const title = $("deckInfoTitle");
    if (title) title.textContent = `${player.name} のデッキ情報`;
    if (!dialog.open) dialog.showModal();
  }
  $("closeDeckInfoButton")?.addEventListener("click", () => $("deckInfoDialog")?.close());

  // 手札クリック（委譲）
  $("handList").addEventListener("click", (event) => {
    if (!isMyTurnSeat()) return;
    const card = event.target.closest(".card[data-instance-id]");
    if (!card) return;
    if (card.dataset.tooltipPreview) {
      delete card.dataset.tooltipPreview; // 長押しプレビュー後の click はメニューを開かない
      return;
    }
    handCardMenu(card.dataset.instanceId);
  });

  // 盤面ゾーンクリック（自分=選択 / 相手=攻撃対象）
  document.querySelectorAll(".zone.field").forEach((zoneButton) => {
    zoneButton.addEventListener("click", () => {
      if (!isMyTurnSeat()) return;
      const owner = Number(zoneButton.dataset.owner);
      const zone = zoneButton.dataset.zone;
      const cardEl = zoneButton.querySelector(".card[data-instance-id]");
      if (ui.effectTargeting) {
        if (cardEl) {
          const et = ui.effectTargeting;
          sendAction(et.type, {
            selected: et.selected,
            effectTarget: `${owner}:${zone}`,
            ...(et.callZone ? { callZone: et.callZone } : {}),
          });
          ui.effectTargeting = null;
        }
        return;
      }
      if (ui.targeting && owner !== mySeat()) {
        if (cardEl) {
          sendAction("attack", { selected: ui.selected, attackTarget: zone });
          ui.targeting = false;
        }
        return;
      }
      if (owner === mySeat() && cardEl) {
        fieldCardMenu(owner, zone, cardEl.dataset.instanceId);
      }
    });
  });

  // 配置魔法パイル: タップで一覧（engine の showSetSpellDialog を再利用）。
  // 一覧から自分の配置魔法を使う時は fieldCardMenu へ橋渡し（src/12 の activateSetSpellFromPile が呼ぶ）。
  window.__onSetSpellActivate = (owner, zone, card) => {
    if (owner !== mySeat()) return; // 相手の配置魔法は裏向き非公開・操作不可（観戦も不可）
    fieldCardMenu(owner, zone, card.instanceId);
  };
  document.querySelectorAll(".set-pile").forEach((pile) => {
    pile.addEventListener("click", () => {
      if (typeof showSetSpellDialog === "function") {
        showSetSpellDialog(Number(pile.dataset.owner));
      }
    });
  });

  // 相手本体（ファイター）クリック＝攻撃対象 fighter
  document.querySelectorAll(".fighter-panel[data-fighter-owner]").forEach((panel) => {
    panel.addEventListener("click", () => {
      if (!isMyTurnSeat() || !ui.targeting) return;
      const owner = Number(panel.dataset.fighterOwner);
      if (owner !== mySeat()) {
        sendAction("attack", { selected: ui.selected, attackTarget: "fighter" });
        ui.targeting = false;
      }
    });
  });

  // ワールドタイル（ヘッダ）クリック→デッキ情報ポップアップ。攻撃/効果タップ中は対象選択を優先。
  document.querySelectorAll(".partner-slot[data-owner]").forEach((cell) => {
    cell.addEventListener("click", (event) => {
      if (!session.started) return;
      if (ui.targeting || ui.effectTargeting) return; // fighter-panel の攻撃対象選択にバブリングさせる
      event.stopPropagation();
      showDeckInfo(Number(cell.dataset.owner));
    });
  });

  // ---- 起動時の自動復帰（保存セッションがあれば /me でトークン生存確認→同席再接続） ----
  async function restoreAndConnect(preRoom) {
    const saved = loadSession(preRoom || null);
    if (!saved || !saved.roomId || !saved.token) return false;
    try {
      const me = await api(
        `auth/rooms/${encodeURIComponent(saved.roomId)}/me?token=${encodeURIComponent(saved.token)}`,
      );
      Object.assign(session, {
        roomId: saved.roomId, token: saved.token, clientId: me.clientId, role: me.role, started: me.started,
      });
      $("lobbyRoomInput").value = saved.roomId;
      connectSse();
      setStatus(`部屋 ${saved.roomId} に復帰しました`);
      return true;
    } catch {
      clearSession(saved.roomId); // 失効トークン（部屋GC/サーバ再起動）は掃除してロビーへフォールバック
      return false;
    }
  }

  // 初期化
  loadDecks();
  const preRoom = new URLSearchParams(location.search).get("room");
  if (preRoom) $("lobbyRoomInput").value = preRoom;
  restoreAndConnect(preRoom).then((restored) => {
    if (!restored) {
      setStatus("未接続。デッキを選び、部屋作成 か 参加 してください（このページは権威サーバ経由で開いてください）。");
    }
  });
})();

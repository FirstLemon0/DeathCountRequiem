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

  async function api(pathname, body, extraHeaders) {
    const options = body
      ? { method: "POST", headers: { "Content-Type": "application/json", ...(extraHeaders || {}) }, body: JSON.stringify(body) }
      : (extraHeaders ? { headers: { ...extraHeaders } } : undefined);
    const res = await fetch(pathname, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  const setStatus = (m) => {
    $("lobbyStatus").textContent = m;
    // 開戦後はロビーが隠れるので、固定バナー(#netStatus)にも出して状態を見えるようにする。
    const ns = document.getElementById("netStatus");
    if (ns) ns.textContent = m || "";
  };
  // 今このクライアントが盤面操作できるか（自分の手番、または対抗ウィンドウ）。手番外の無言失敗を防ぐ。
  const canActNow = () => {
    const st = thin?.getState?.();
    if (mySeat() === null || !session.started || !st || st.winner) return false;
    if (st.active === mySeat()) return true;
    return Boolean(st.pendingAttack || st.pendingAction); // 対抗/応答中は相手手番でも操作可
  };
  const mySeat = () => (session.role === 0 || session.role === 1 ? session.role : null);
  const isMyTurnSeat = () => mySeat() !== null && session.started;
  function roleLabel(role) {
    if (role === 0) return "先手(P1)";
    if (role === 1) return "後手(P2)";
    if (role === "spectator") return "観戦";
    return "-";
  }

  // カードライブラリ(cardLibrary)を必ずロードしておく（選択プロンプトのプレビュー/効果全文表示・
  // 効果対象候補の算出に使う。デッキ一覧がサーバAPIで取れた場合でも必要）。失敗しても続行。
  const gameDataReady = (async () => {
    try {
      if (thin?.loadGameData) {
        await thin.loadGameData();
      }
    } catch {
      /* オフライン等で失敗してもプロンプトは compact 表示で動く */
    }
  })();

  // ---- デッキ一覧（権威API→失敗時はクライアント側エンジンで補完） ----
  async function loadDecks() {
    let decks = null;
    try {
      decks = (await api("auth/decks")).decks;
    } catch {
      try {
        await gameDataReady;
        if (thin?.getDeckProfiles) {
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
    // select.innerHTML を丸ごと差し替えたため、user-api.js が追補した「マイ: 」optionも消えている。
    // ログイン中なら再注入する（user-api.js未ロード/未ログイン時は何もしない）。
    if (typeof userRefreshMyDeckOptions === "function") {
      userRefreshMyDeckOptions();
    }
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
    refreshState(); // 接続直後にHTTPでも一度同期（SSE初回が逆プロキシにバッファされても表示が出る）
    ensureSyncPoll();
  }

  // SSE非依存のフォールバック同期。逆プロキシ(Render等)でSSEのlobby/viewが届かない環境でも、
  // /sync をHTTPで取得して現在のロビー＋自分のviewを反映する（役割・席・手札・相手の操作も復帰）。
  async function refreshState() {
    if (!session.roomId || !session.token) return;
    try {
      const data = await api(
        `auth/rooms/${encodeURIComponent(session.roomId)}/sync?token=${encodeURIComponent(session.token)}`,
      );
      if (data.lobby) applyLobby(data.lobby);
      if (data.view) handleMessage(data.view);
    } catch { /* トークン失効等はSSE/復帰側で処理。ここは黙って次のポーリングに任せる */ }
  }

  // 3秒ごとのフォールバックポーリング（多重起動防止）。ターン制なので頻度はこれで十分。
  let syncPollTimer = null;
  function ensureSyncPoll() {
    if (syncPollTimer) return;
    syncPollTimer = setInterval(() => {
      if (session.roomId && session.token) refreshState();
    }, 3000);
  }

  function handleMessage(message) {
    if (message.type === "hello" || message.type === "lobby") {
      applyLobby(message);
    } else if (message.type === "view") {
      // 局面が変わっていない再適用（3秒ポーリング等）では何もしない。
      // applyView/clearSelection を毎回呼ぶと、操作ポップアップ(選択メニュー)が
      // ポーリングのたびに閉じてしまうため、同一stateならスキップする。
      const viewKey = JSON.stringify(message.state);
      if (viewKey === ui.lastViewKey) return;
      ui.lastViewKey = viewKey;
      session.started = true;
      saveSession();
      const seat = message.role === 0 || message.role === 1 ? message.role : null;
      thin?.setViewerSeat?.(seat);
      clearSelection();
      thin?.applyView?.(message.state);
      updateAttackHighlights(); // 盤面再描画後もハイライト状態を反映（対象選択中なら付け直す）
      document.body.classList.add("game-started");
      // 自席の枠強調＋手番の「/ ターン中」表示を有効化。renderNetworkChrome は play.html では
      // no-op(isNetworkPage=false)なので thin 側で .network-connected と席クラスを付ける
      // （styles.css の .network-connected .player-zone.local-seat / .turn-seat フックを流用）。
      document.body.classList.add("network-connected");
      [0, 1].forEach((i) => {
        const z = document.getElementById(`player${i + 1}Zone`);
        z?.classList.toggle("local-seat", seat === i);
        z?.classList.toggle("remote-seat", seat !== i);
      });
      // 席相対フリップ: 後手(P2)席の視点では自分の場(player2Zone=opponentクラス)を下段へ、
      // 相手(player1Zone=active-player)を上段へ入れ替える（styles.css の body.seat-flip 規則）。
      document.body.classList.toggle("seat-flip", seat === 1);
      $("lobbySeatLabel").textContent = `役割: ${roleLabel(message.role)}`;
      // 初回ガイド(コーチ)を開戦時に一度だけ。
      try {
        const coach = document.getElementById("coachDialog");
        if (coach?.showModal && !localStorage.getItem("bf_coach_seen")) {
          coach.showModal();
          localStorage.setItem("bf_coach_seen", "1");
        }
      } catch { /* noop */ }
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
    // 「対戦中/待機中」は routine なので lobbyStatus だけに表示する。固定バナー(#netStatus)は
    // 再接続/相手切断/操作エラーなど“異常時専用”にし、正常同期のたびに空へ戻して盤面下部を覆わない。
    $("lobbyStatus").textContent = `部屋 ${message.roomId} ${message.started ? "（対戦中）" : "（待機中）"}`;
    if (session.started) {
      const banner = document.getElementById("netStatus");
      if (banner) banner.textContent = "";
    }
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
    // 開始ゲート: 両席が埋まり両者デッキ確定するまで「対戦開始」を無効化（事後エラーを防ぐ）。
    const startBtn = document.getElementById("lobbyStartButton");
    if (startBtn) {
      const members = message.members || [];
      const seat0 = members.find((m) => m.role === 0);
      const seat1 = members.find((m) => m.role === 1);
      const ready = Boolean(seat0 && seat1 && seat0.deck && seat1.deck);
      startBtn.disabled = message.started || !ready;
      startBtn.title = ready ? "対戦を開始" : "両席が埋まり、両者のデッキが確定すると押せます";
      if (!message.started && !ready) {
        const onlyOne = !seat0 || !seat1;
        setStatus(onlyOne ? "相手の参加を待っています…" : "両者のデッキ確定を待っています…");
      }
    }
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
    api(`auth/rooms/${encodeURIComponent(session.roomId)}/lobby`, { token: session.token, action, ...extra })
      .then((result) => {
        refreshState(); // 開始/席変更/デッキ確定の結果を即時反映（SSE待ちにしない）
        return result;
      })
      .catch((error) => setStatus(error.message));
  const askName = () => window.prompt("プレイヤー名は？", "プレイヤー") || "プレイヤー";

  async function createOrJoin(kind) {
    try {
      const deck = selectedDeckPayload();
      const pathname = kind === "create" ? "auth/rooms" : `auth/rooms/${encodeURIComponent($("lobbyRoomInput").value.trim().toUpperCase())}/join`;
      if (kind === "join" && !$("lobbyRoomInput").value.trim()) {
        setStatus("参加する部屋番号を入力してください");
        return;
      }
      // D5(戦績): ログイン中なら Bearer を添えて席にログインユーザーを紐づける（決着時にサーバが戦績を記録）。
      // 未ログイン・トークン失効でもサーバ側は握って未ログイン扱いにするだけ＝参加は失敗しない。
      let authHeaders;
      try {
        const token = typeof window.userSession === "function" ? window.userSession()?.token : null;
        if (token) authHeaders = { Authorization: "Bearer " + token };
      } catch (_) { /* localStorage 不可環境等は無視 */ }
      const data = await api(pathname, { name: askName(), deck }, authHeaders);
      Object.assign(session, { roomId: data.roomId, token: data.token, clientId: data.clientId, role: data.role });
      session.started = false;
      ui.lastViewKey = null; // 別部屋へ入り直したら次のviewを必ず再適用する
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
  // ルール表示(thinでも配線。手札秘匿の説明等を含む)。
  $("rulesButton")?.addEventListener("click", () => document.getElementById("rulesDialog")?.showModal());
  $("lobbyCopyButton").addEventListener("click", async () => {
    if (!session.roomId) {
      setStatus("先に「部屋作成」または「参加」をしてください");
      return;
    }
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
      // 着席済みだが未開始のプレイヤーに「観戦者は操作できません」は誤り。席の有無で文言を分ける。
      setStatus(mySeat() === null ? "観戦者は操作できません" : "対戦開始前です（ロビーで『対戦開始』を押してください）");
      return;
    }
    closeMenu();
    // 送信〜解決まで（相手のプロンプトを誘発した場合は最大数十秒ホールドされる）非ブロッキングに待機表示。
    setStatus("操作を送信中…（相手の応答が必要な場合は待機します）");
    try {
      await api(`auth/rooms/${encodeURIComponent(session.roomId)}/action`, { token: session.token, type, params: params || {} });
      setStatus(""); // 完了（最新 view は SSE＋フォールバック同期で届く）
      refreshState(); // 自分の操作結果を即時反映（SSE待ちにしない）
    } catch (error) {
      setStatus(`操作不可: ${error.message}`);
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
    if (typeof updateEffectTargetHighlights === "function") {
      updateEffectTargetHighlights();
    }
  }
  function closeMenu() {
    document.getElementById("playActionMenu")?.remove();
    document.getElementById("playActionBackdrop")?.remove();
  }
  // 操作ポップアップの背後にクリック遮断バックドロップを敷く。
  // これが無いと、ポップアップ表示中に背後の盤面/手札カードへタップが貫通し、
  // 別カードの詳細/メニューに塗り替わってしまう。onBackdrop指定時は背景タップで閉じる。
  function mountActionMenu(menu, onBackdrop) {
    closeMenu();
    const backdrop = document.createElement("div");
    backdrop.id = "playActionBackdrop";
    backdrop.style.cssText =
      "position:fixed;inset:0;z-index:199;background:rgba(0,0,0,.28);pointer-events:auto;touch-action:none;";
    backdrop.addEventListener("click", (event) => {
      event.stopPropagation();
      if (typeof onBackdrop === "function") onBackdrop();
    });
    document.body.append(backdrop);
    document.body.append(menu);
  }
  function showMenu(items) {
    // 共有コンポーネント(src/20 showActionMenu)で表示。ローカル/中継と同一の見た目・同一のid
    // (playActionMenu/playActionBackdrop)なので closeMenu もそのまま効く。
    if (typeof showActionMenu === "function") {
      showActionMenu(items, { onClose: clearSelection });
      return;
    }
    // フォールバック（共有部品が無い場合のみ）: 従来のインライン実装。
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
    // 背景タップ＝操作ポップアップを閉じる（カードシート等と挙動統一・誤タップ貫通を防止）。
    mountActionMenu(menu, clearSelection);
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

  // 候補(compact)をカードライブラリの完全定義で補完（選択ダイアログのプレビュー/効果全文表示用）。
  function enrichPromptCard(candidate) {
    const compact = candidate.card || {};
    const library = typeof cardLibrary !== "undefined" && Array.isArray(cardLibrary) ? cardLibrary : [];
    const full =
      library.find((def) => compact.no && def.no === compact.no) ||
      library.find((def) => compact.name && def.name === compact.name) ||
      null;
    if (full) {
      return { ...full, ...compact };
    }
    return { name: compact.name || `候補 ${(candidate.choiceIndex ?? 0) + 1}`, ...compact };
  }

  // ローカル/中継と同じ #selectionDialog（プレビュー・盤面確認・検索付き）でプロンプトに応答する。
  async function showPromptViaSelectionDialog(req) {
    await gameDataReady; // cardLibrary ロード後に enrich（未ロードだと候補が「能力なし」表示になる）
    if (ui.activePromptId !== req.requestId) {
      return; // 待機中に別プロンプトへ置き換わった
    }
    const entries = (req.candidates || []).map((candidate) => ({
      ...candidate,
      card: enrichPromptCard(candidate),
      note: [candidate.zoneLabel, candidate.note].filter(Boolean).join(" ・ "),
    }));
    const min = req.min ?? 1;
    const max = req.max ?? min;
    const selected = await showCardSelectionDialog(entries, {
      title: req.title || "選択",
      lead: req.lead || "",
      min,
      max,
      allowCancel: req.allowCancel !== false,
      searchable: Boolean(req.searchable),
    });
    if (ui.activePromptId !== req.requestId) {
      return; // 応答待ちの間に別プロンプトへ置き換わった（再接続等）
    }
    if (selected === null) {
      sendPromptResponse(req.requestId, {}); // キャンセル＝空応答（エンジン側がnull扱い）
      return;
    }
    sendPromptResponse(req.requestId, { selectedIndexes: selected.map((entry) => entry.choiceIndex) });
  }

  function showPrompt(req) {
    closeMenu();
    ui.activePromptId = req.requestId; // 再接続再送の重複抑止用（旧プロンプトの応答はこのIDと突き合わせて破棄）
    // 旧プロンプトのダイアログが開いたままなら強制解決して閉じる（連続プロンプト/タイムアウト後の残留対策）。
    // activePromptId を先に新IDへ更新済みのため、旧側の応答送信はガードで抑止される。
    if (typeof globalThis.__forceSettleSelectionDialog === "function") {
      globalThis.__forceSettleSelectionDialog();
    }
    // ローカル/中継と同じ選択ダイアログが使える環境ではそちらを優先（見た目統一・プレビュー/盤面確認付き）。
    if (typeof canShowSelectionDialog === "function" && canShowSelectionDialog() && !elements.selectionDialog.open) {
      showPromptViaSelectionDialog(req).catch(() => {
        setStatus("選択ダイアログの表示に失敗しました。");
      });
      return;
    }
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

    // searchable: 候補が多いカード名宣言などで、名前による絞り込み検索ボックスを出す。
    if (req.searchable) {
      const search = document.createElement("input");
      search.type = "search";
      search.placeholder = "カード名で絞り込み";
      search.style.cssText =
        "width:100%;box-sizing:border-box;min-height:40px;padding:8px 10px;font-size:1em;";
      search.addEventListener("input", () => {
        const query = search.value.trim().toLowerCase();
        menu.querySelectorAll("button[data-cname]").forEach((btn) => {
          const name = (btn.dataset.cname || "").toLowerCase();
          btn.style.display = !query || name.includes(query) ? "" : "none";
        });
      });
      menu.append(search);
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
        btn.dataset.cname = candidate.card?.name || "";
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
        btn.dataset.cname = candidate.card?.name || "";
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
    // 背後への貫通タップを遮断。キャンセル可なら背景タップで空応答、不可なら遮断のみ（誤キャンセル防止）。
    mountActionMenu(menu, allowCancel ? () => sendPromptResponse(req.requestId, {}) : undefined);
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
      // 連続プロンプト時、旧応答の後処理が「次のプロンプト」の状態を潰さないようにIDを確認してから消す。
      if (ui.activePromptId === requestId) {
        ui.activePromptId = null;
        closeMenu();
      }
    }
  }

  function handCardMenu(instanceId) {
    ui.selected = { source: "hand", owner: mySeat(), instanceId };
    ui.targeting = false;
    const sel = ui.selected;
    // 重ねてコールする札(callStack)は、先に重ねる対象を盤面タップで選ばせてから
    // callZone 付きでコールする（ローカル版 callVia と同型。自分の手札は view で伏せ字化されない）。
    const handCard = state?.players?.[mySeat()]?.hand?.find((c) => c.instanceId === instanceId);
    const callVia = (zone) => () => {
      if (handCard?.callStack) {
        startEffectTargeting(sel, "call", { callZone: zone });
        return;
      }
      sendAction("call", { selected: sel, callZone: zone });
    };
    showMenu([
      { label: "チャージ&ドロー", run: () => sendAction("charge", { selected: sel }) },
      { label: "レフトにコール", run: callVia("left") },
      { label: "センターにコール", run: callVia("center") },
      { label: "ライトにコール", run: callVia("right") },
      { label: "使用/装備", run: () => sendAction("use", { selected: sel }) },
      { label: "使用（効果対象を選ぶ）", run: () => startEffectTargeting(sel, "use") },
      { label: "バディコール宣言", run: () => sendAction("buddy", { selected: sel }) },
    ]);
  }

  function fieldCardMenu(owner, zone, instanceId) {
    ui.selected = { source: "field", owner, zone, instanceId };
    ui.targeting = false;
    const sel = ui.selected;
    // 連携編成済みなら「連携から外す」表示（ローカル版と同じトグルラベル。実体はサーバ側toggle）。
    const linked =
      Array.isArray(state?.linkAttackers) &&
      state.linkAttackers.some((slot) => slot.owner === owner && slot.zone === zone);
    showMenu([
      { label: "攻撃（対象を選ぶ）", run: () => { ui.targeting = true; closeMenu(); setTargetingBanner("攻撃対象をタップ（本体は相手の『装備』枠）"); setStatus("攻撃対象をタップ：相手モンスター、または本体は相手の『装備』枠をタップ"); updateAttackHighlights(); } },
      { label: linked ? "連携から外す" : "連携に追加", run: () => sendAction("link", { selected: sel }) },
      { label: "使用（能力）", run: () => sendAction("use", { selected: sel }) },
      { label: "使用（効果対象を選ぶ）", run: () => startEffectTargeting(sel, "use") },
    ]);
  }

  // ---- 効果対象タップ（attackTargetタップと同型。対象を盤面カードでタップ→effectTarget送信）----
  function startEffectTargeting(sel, type, extra = {}) {
    ui.effectTargeting = { selected: sel, type, callZone: extra.callZone };
    ui.targeting = false;
    closeMenu();
    setTargetingBanner("効果対象をタップ");
    setStatus("効果対象を盤面のカードでタップしてください");
    updateEffectTargetHighlights();
  }

  // 効果対象選択中の候補ハイライト（ローカル版と同じ .effect-target-candidate）。
  // effectTargetCandidates は内部で state.selected（誰が何を選んでいるか）に依存するため、
  // 算出の間だけ thin 側の選択(ui.effectTargeting.selected)を state.selected に一時設定して視点を合わせる。
  // 算出に失敗した場合は「カードのある全ゾーン」を候補表示（従来のどこでもタップ可の挙動）。
  // 算出できた候補は ui.effectTargeting.candidates に保存し、タップ受付のゲートにも使う（ローカルと同じ）。
  function updateEffectTargetHighlights() {
    document
      .querySelectorAll(".effect-target-candidate")
      .forEach((el) => el.classList.remove("effect-target-candidate"));
    if (!ui.effectTargeting) return;
    const sel = ui.effectTargeting.selected;
    let candidates = [];
    const prevSelected = typeof state !== "undefined" ? state?.selected : undefined;
    try {
      const player = state?.players?.[sel.owner];
      const card =
        sel.source === "hand"
          ? player?.hand?.find((c) => c.instanceId === sel.instanceId)
          : player?.field?.[sel.zone];
      if (card && typeof effectTargetCandidates === "function") {
        if (state) {
          state.selected =
            sel.source === "hand"
              ? { source: "hand", owner: sel.owner, instanceId: sel.instanceId }
              : { source: "field", owner: sel.owner, zone: sel.zone, instanceId: sel.instanceId };
        }
        candidates = effectTargetCandidates(card);
      }
    } catch (_error) {
      candidates = [];
    } finally {
      if (typeof state !== "undefined" && state) {
        state.selected = prevSelected ?? null;
      }
    }
    if (candidates.length === 0) {
      ui.effectTargeting.candidates = null; // null＝算出不能。フォールバックで全カードゾーンをタップ可に
      document.querySelectorAll(".zone.field").forEach((z) => {
        if (z.querySelector(".card[data-instance-id]")) z.classList.add("effect-target-candidate");
      });
      return;
    }
    ui.effectTargeting.candidates = candidates.map((c) => ({ owner: c.owner, zone: c.zone }));
    candidates.forEach((candidate) => {
      const el = document.querySelector(`.zone[data-owner="${candidate.owner}"][data-zone="${candidate.zone}"]`);
      el?.classList.add("effect-target-candidate");
    });
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
    ];
    body.innerHTML = rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
    // バディ行: カードがあればクリックで詳細(read-onlyカードシート)を表示する。
    const buddyRow = document.createElement("div");
    const buddyDt = document.createElement("dt");
    buddyDt.textContent = "バディ";
    const buddyDd = document.createElement("dd");
    if (player.buddy) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "buddy-detail-link";
      btn.textContent = buddyName;
      btn.title = "タップでバディの詳細を表示";
      btn.style.cssText =
        "background:none;border:none;padding:0;font:inherit;color:var(--accent,#7fd1ff);text-decoration:underline;cursor:pointer;text-align:left;";
      btn.addEventListener("click", () => {
        if (typeof openReadOnlyCardSheet === "function") openReadOnlyCardSheet(player.buddy);
      });
      buddyDd.append(btn);
    } else {
      buddyDd.textContent = "なし";
    }
    buddyRow.append(buddyDt, buddyDd);
    body.append(buddyRow);
    const title = $("deckInfoTitle");
    if (title) title.textContent = `${player.name} のデッキ情報`;
    if (!dialog.open) dialog.showModal();
  }
  $("closeDeckInfoButton")?.addEventListener("click", () => $("deckInfoDialog")?.close());
  // カード詳細シート(バディ詳細等)の閉じ配線。thinモードでは src/21 非thin側の配線が走らないため自前で。
  $("closeCardSheetButton")?.addEventListener("click", () => {
    if (typeof closeCardSheet === "function") closeCardSheet();
    else $("cardSheet")?.close();
  });
  const cardSheetEl = $("cardSheet");
  if (cardSheetEl) {
    cardSheetEl.addEventListener("click", (event) => {
      if (event.target === cardSheetEl) cardSheetEl.close(); // 背景タップで閉じる
    });
    // 長押しプレビューで立てた click 抑制フラグを解除（src/21 非thin側の close 配線の thin 版。
    // モーダル表示中は盤面へ click が届かず消費コードが走らないため、close で必ず戻す）。
    cardSheetEl.addEventListener("close", () => {
      if (typeof suppressNextZoneClick !== "undefined") suppressNextZoneClick = false;
    });
  }

  // 手札クリック（委譲）
  $("handList").addEventListener("click", (event) => {
    if (!session.started) return;
    const card = event.target.closest(".card[data-instance-id]");
    if (!card) return;
    if (card.dataset.tooltipPreview) {
      delete card.dataset.tooltipPreview; // 長押しプレビュー後の click はメニューを開かない
      return;
    }
    if (!canActNow()) {
      setStatus("相手の番です（あなたの操作番ではありません）");
      return;
    }
    handCardMenu(card.dataset.instanceId);
  });

  // 攻撃対象選択中、攻撃可能な相手の対象をハイライトする。
  // ・相手モンスターのいるエリア(左/中/右)をハイライト。
  // ・相手センターが空なら本体＝相手の『装備』枠をハイライト。
  function updateAttackHighlights() {
    document.querySelectorAll(".attack-target-highlight").forEach((el) => el.classList.remove("attack-target-highlight"));
    if (!ui.targeting) return;
    const opp = 1 - mySeat();
    if (opp !== 0 && opp !== 1) return;
    let centerHasMonster = false;
    document.querySelectorAll(`.zone.field[data-owner="${opp}"]`).forEach((z) => {
      const zone = z.dataset.zone;
      if (zone === "left" || zone === "center" || zone === "right") {
        if (z.querySelector(".card[data-instance-id]")) {
          z.classList.add("attack-target-highlight");
          if (zone === "center") centerHasMonster = true;
        }
      }
    });
    if (!centerHasMonster) {
      const itemZone = document.querySelector(`.zone.field.item[data-owner="${opp}"][data-zone="item"]`);
      if (itemZone) itemZone.classList.add("attack-target-highlight");
    }
  }

  // 盤面ゾーンクリック（自分=選択 / 相手=攻撃対象 / それ以外のカード=閲覧）
  document.querySelectorAll(".zone.field").forEach((zoneButton) => {
    zoneButton.addEventListener("click", (event) => {
      if (!session.started) return;
      if (typeof suppressNextZoneClick !== "undefined" && suppressNextZoneClick) {
        suppressNextZoneClick = false; // 長押しプレビュー直後のclickは無視（ローカル版と同じ）
        return;
      }
      const owner = Number(zoneButton.dataset.owner);
      // 複数アイテム対応: タップしたカード要素を優先し、そのアイテムの実スロット(data-item-zone)を使う。
      const cardEl = event.target?.closest?.(".card[data-instance-id]") || zoneButton.querySelector(".card[data-instance-id]");
      const zone = cardEl?.dataset?.itemZone || zoneButton.dataset.zone;
      if (ui.effectTargeting) {
        const et = ui.effectTargeting;
        // 候補が算出できている時は候補ゾーンのみ受け付ける（ローカルと同じ。候補外タップは無視）。
        const isCandidate =
          !Array.isArray(et.candidates) ||
          et.candidates.some((candidate) => candidate.owner === owner && candidate.zone === zone);
        if (cardEl && isCandidate) {
          sendAction(et.type, {
            selected: et.selected,
            effectTarget: `${owner}:${zone}`,
            ...(et.callZone ? { callZone: et.callZone } : {}),
          });
          ui.effectTargeting = null;
          clearTargetingBanner();
          updateEffectTargetHighlights();
        }
        return;
      }
      if (ui.targeting && owner !== mySeat()) {
        // 相手の「装備」枠(武器装備枠)タップ＝本体(ファイター)への攻撃。
        // 武器があればサーバ側で防御に回る。空でも本体攻撃として成立する（カード有無を問わない）。
        if (zoneButton.dataset.zone === "item") {
          sendAction("attack", { selected: ui.selected, attackTarget: "fighter" });
          ui.targeting = false;
          clearTargetingBanner();
          updateAttackHighlights();
        } else if (cardEl) {
          sendAction("attack", { selected: ui.selected, attackTarget: zone });
          ui.targeting = false;
          clearTargetingBanner();
          updateAttackHighlights();
        }
        return;
      }
      if (owner === mySeat() && cardEl) {
        if (!canActNow()) {
          setStatus("相手の番です（あなたの操作番ではありません）");
          return;
        }
        fieldCardMenu(owner, zone, cardEl.dataset.instanceId);
        return;
      }
      // 相手の盤面カードタップ＝閲覧専用シート（ローカル版と同じ。公開情報の確認手段）。
      if (cardEl) {
        const card = state?.players?.[owner]?.field?.[zone];
        if (card && typeof openReadOnlyCardSheet === "function") {
          openReadOnlyCardSheet(card);
        }
      }
    });
    // 盤面カードの長押し(300ms)＝閲覧専用シート（ローカル版と同じ。モバイルでの詳細確認手段）。
    if (typeof attachZoneLongPress === "function") {
      attachZoneLongPress(zoneButton);
    }
  });

  // ドロップ（墓地）タップ＝一覧ダイアログ（ローカル版と同じ。ドロップは公開情報）。
  document.querySelectorAll(".drop-zone").forEach((zoneButton) => {
    zoneButton.addEventListener("click", () => {
      if (!session.started || !state?.players) return; // 開始前/初回view未着は state 未同期のため開かない
      if (typeof showDropDialog === "function") {
        showDropDialog(Number(zoneButton.dataset.owner));
      }
    });
  });

  // 配置魔法パイル: タップで一覧（engine の showSetSpellDialog を再利用）。
  // 一覧から自分の配置魔法を使う時は fieldCardMenu へ橋渡し（src/12 の activateSetSpellFromPile が呼ぶ）。
  window.__onSetSpellActivate = (owner, zone, card) => {
    if (owner !== mySeat()) {
      // 相手の配置魔法: 裏向きは非公開のまま、表向き(公開済み)なら閲覧専用シートを出す（ローカル版と同じ）。
      if (card && !card.faceDown && typeof openReadOnlyCardSheet === "function") {
        openReadOnlyCardSheet(card);
      }
      return;
    }
    fieldCardMenu(owner, zone, card.instanceId);
  };
  // ドロップからの起動能力（墓場のDJ等）: 自分の席のみ、"use" アクションに source:"drop" 選択を載せて送る。
  window.__onDropAbilityActivate = (owner, card) => {
    if (owner !== mySeat() || !canActNow()) {
      return;
    }
    sendAction("use", { selected: { source: "drop", owner, instanceId: card.instanceId } });
  };
  document.querySelectorAll(".set-pile").forEach((pile) => {
    pile.addEventListener("click", () => {
      if (!session.started || !state?.players) return; // 開始前/初回view未着は state 未同期のため開かない
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
        clearTargetingBanner();
        updateAttackHighlights();
      }
    });
  });

  // 対象選択バナーの「キャンセル」(thin): targeting を解除。
  document.getElementById("targetingCancelButton")?.addEventListener("click", () => {
    ui.targeting = false;
    ui.effectTargeting = null;
    clearTargetingBanner();
    updateAttackHighlights();
    updateEffectTargetHighlights(); // 効果対象の候補ハイライトも消す
    setStatus("対象選択をキャンセルしました");
  });

  // thin: ダイアログの閉じ配線（src/21 の非thin側は走らないため自前で）。
  $("closeDropDialogButton")?.addEventListener("click", () => document.getElementById("dropDialog")?.close());
  $("coachCloseButton")?.addEventListener("click", () => document.getElementById("coachDialog")?.close());
  ["dropDialog", "deckInfoDialog"].forEach((id) => {
    const dlg = document.getElementById(id);
    dlg?.addEventListener("click", (event) => {
      if (event.target === dlg) dlg.close();
    });
  });
  // ☰メニュー: 外側タップ/項目タップで閉じる＋aria-expanded同期。
  document.addEventListener("click", (event) => {
    if (!document.body.classList.contains("nav-open")) return;
    if (event.target.closest(".nav-toggle")) return;
    const item = event.target.closest(".toolbar a, .toolbar button");
    const outside = !event.target.closest(".toolbar");
    if (outside || (item && !item.closest(".log-toggle, .theme-toggle"))) {
      document.body.classList.remove("nav-open");
      document.querySelector(".nav-toggle")?.setAttribute("aria-expanded", "false");
    }
  });

  // ワールドタイル（ヘッダのデッキ詳細）クリック→デッキ情報ポップアップ。
  // 対象選択中は「デッキ詳細タイルで本体攻撃」になってしまうのを防ぐため、攻撃へバブリングさせない。
  // 本体(ファイター)への攻撃は相手の『装備』枠タップで行う。
  document.querySelectorAll(".partner-slot[data-owner]").forEach((cell) => {
    cell.addEventListener("click", (event) => {
      if (!session.started) return;
      event.stopPropagation();
      if (ui.targeting || ui.effectTargeting) return; // 対象選択中はデッキ詳細を開かず、攻撃にもしない
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

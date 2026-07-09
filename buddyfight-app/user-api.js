// user-api.js — ユーザー登録＋マイデッキ（サーバー保存）のクライアント配線。
// classic script。builder.html / play.html / index.html で共用（<script> 追加のみで動く）。
//
// 設計: docs/ユーザーデータ保管とデッキ選択UI_設計_2026-07-08.md §3.5
// サーバAPI（別班が並行実装中。/auth/register 等が未実装でも本スクリプトは壊れない＝
// fetch失敗/404/501はすべて「サーバーに接続できません」的なエラー表示に丸める）。
//
// 公開グローバル関数:
//   userApiAvailable() / userSession() / userRegister(name,pass) / userLogin(name,pass) / userLogout()
//   userFetchMe() / userListMyDecks() / userSaveMyDeck(name,code) / userDeleteMyDeck(serverId)
//   userAdminListUsers() / userAdminResetPassword(name,newPass)
//   userRefreshMyDeckOptions() / userMountAccountBar(container)
//
// セッション変化時に document へ "user-session-changed" CustomEvent を発火する。
(function () {
  "use strict";

  var SESSION_KEY = "buddyfight.session.v1";
  var API_BASE_KEY = "buddyfight.apiBase.v1";

  // ---- API基点解決 ----
  // play.html（__BUDDYFIGHT_THIN__=true。権威サーバ配信前提）は常に相対("")。
  // それ以外（index.html/builder.html＝静的配信想定）は localStorage の apiBase 設定有無のみで判定
  // （fetchで疎通確認はしない＝起動を遅くしない）。
  // 同一オリジン判定: thin(play)は確定。builder/index も「権威サーバから配信」されていれば
  // 同一オリジンの /auth が使える（推奨起動=権威起動.bat は全ページ:4174配信）。それは
  // /healthz プローブ（userProbeSameOrigin）で判定し、結果をここに覚える。null=未判定。
  var sameOriginProbe = null;
  var sameOriginProbePromise = null;

  function userProbeSameOrigin() {
    if (typeof window !== "undefined" && window.__BUDDYFIGHT_THIN__) {
      sameOriginProbe = true;
    }
    if (sameOriginProbe !== null) return Promise.resolve(sameOriginProbe);
    if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) {
      sameOriginProbe = false;
      return Promise.resolve(false);
    }
    if (sameOriginProbePromise) return sameOriginProbePromise;
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (controller) setTimeout(function () { controller.abort(); }, 1500);
    sameOriginProbePromise = fetch("healthz", { signal: controller ? controller.signal : undefined })
      .then(function (res) { sameOriginProbe = Boolean(res && res.ok); return sameOriginProbe; })
      .catch(function () { sameOriginProbe = false; return false; });
    return sameOriginProbePromise;
  }

  function userApiBase() {
    if (typeof window !== "undefined" && window.__BUDDYFIGHT_THIN__) {
      return "";
    }
    if (sameOriginProbe === true) {
      return ""; // 権威サーバ配信ページ＝同一オリジンの /auth を使う
    }
    try {
      var stored = localStorage.getItem(API_BASE_KEY);
      if (stored && stored.trim()) {
        return stored.trim().replace(/\/+$/, "");
      }
    } catch (e) {
      /* localStorage不可環境は無視 */
    }
    return null;
  }

  function userApiAvailable() {
    return userApiBase() !== null;
  }

  function setUserApiBase(base) {
    try {
      if (base && base.trim()) {
        localStorage.setItem(API_BASE_KEY, base.trim().replace(/\/+$/, ""));
      } else {
        localStorage.removeItem(API_BASE_KEY);
      }
    } catch (e) {
      /* noop */
    }
  }

  // ---- セッション ----
  function userSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setUserSession(session) {
    try {
      if (session) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      } else {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch (e) {
      /* noop */
    }
    document.dispatchEvent(new CustomEvent("user-session-changed"));
  }

  // ---- fetch ラッパ（Bearer付与・エラー統一） ----
  async function userApiFetch(path, options) {
    var base = userApiBase();
    if (base === null) {
      throw new Error("サーバーURLが未設定です");
    }
    var opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    var session = userSession();
    if (session && session.token) {
      opts.headers["Authorization"] = "Bearer " + session.token;
    }
    var res;
    try {
      res = await fetch(base + path, opts);
    } catch (e) {
      throw new Error("サーバーに接続できません");
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      var msg = (data && data.error) || "サーバーエラー (HTTP " + res.status + ")";
      // サーバがDB接続失敗の理由（detail）を付けている時は原因を画面に出す（登録できない時の切り分け用）。
      if (data && data.detail) {
        msg += "（" + data.detail + "）";
      }
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- 認証 ----
  async function userRegister(name, pass) {
    var data = await userApiFetch("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, password: pass }),
    });
    setUserSession({ token: data.token, name: data.name, isAdmin: !!data.isAdmin });
    return data;
  }

  async function userLogin(name, pass) {
    var data = await userApiFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, password: pass }),
    });
    setUserSession({ token: data.token, name: data.name, isAdmin: !!data.isAdmin });
    return data;
  }

  async function userLogout() {
    try {
      await userApiFetch("/auth/logout", { method: "POST" });
    } catch (e) {
      /* サーバー側が既に無効化していても構わずローカルを消す */
    }
    myDeckCache = [];
    setUserSession(null);
    try {
      await userRefreshMyDeckOptions();
    } catch (e) {
      /* noop */
    }
  }

  async function userFetchMe() {
    return userApiFetch("/auth/me", { method: "GET" });
  }

  // ---- デッキ共有コード decode（deck-code.js切り出し前の内蔵フォールバック） ----
  // builder.html では builder.js の decodeDeckShareCode（canonicalFlagId込みの本実装）をそのまま使う。
  // index.html/play.html にはこの関数が無いため、同じロジックの簡易フォールバックで代替する。
  function userFromBase64Url(code) {
    var b = String(code).replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) {
      b += "=";
    }
    return decodeURIComponent(escape(atob(b)));
  }

  function userDecodeDeckShareCode(code) {
    if (typeof decodeDeckShareCode === "function") {
      return decodeDeckShareCode(code);
    }
    var body = String(code || "").trim().replace(/^BFD1\./, "");
    var arr = JSON.parse(userFromBase64Url(body));
    var ver = arr[0];
    var name = arr[1];
    var flag = arr[2];
    var buddy = arr[3];
    var recipe = arr[4];
    if (ver !== 1) {
      throw new Error("未対応の共有コードバージョン: " + ver);
    }
    if (!flag || !Array.isArray(recipe)) {
      throw new Error("共有コードの形式が不正です");
    }
    return {
      name: name || "共有デッキ",
      flag: flag,
      buddy: buddy || "",
      recipe: recipe.map(function (pair) {
        return [pair[0], Number(pair[1])];
      }),
    };
  }

  // ---- マイデッキ ----
  var myDeckCache = []; // 直近の userListMyDecks() 結果（プロファイル化済み）。play.js の selectedDeckPayload 等が参照する。

  async function userListMyDecks() {
    var data = await userApiFetch("/auth/mydecks", { method: "GET" });
    var decks = (data && data.decks) || [];
    var profiles = decks.map(function (deck) {
      var decoded = null;
      try {
        decoded = userDecodeDeckShareCode(deck.code);
      } catch (e) {
        decoded = null;
      }
      return {
        id: "mydeck-" + deck.id,
        serverId: deck.id,
        name: deck.name,
        flag: (decoded && decoded.flag) || deck.flag || "",
        buddy: (decoded && decoded.buddy) || deck.buddy || "",
        recipe: (decoded && decoded.recipe) || [],
        code: deck.code,
        category: "mydeck",
        productId: "mydeck",
        productName: "マイデッキ（サーバー）",
        releaseOrder: 99998,
        position: deck.position,
        updatedAt: deck.updatedAt,
      };
    });
    myDeckCache = profiles;
    return profiles;
  }

  function userCachedMyDeckProfile(id) {
    for (var i = 0; i < myDeckCache.length; i += 1) {
      if (myDeckCache[i].id === id) return myDeckCache[i];
    }
    return null;
  }

  // D5(戦績): ローカル対戦の自己申告をサーバへ記録する（best-effort。未ログイン/未設定は黙って何もしない）。
  // サーバ側で source:"client" 固定＝権威記録(net対戦)は上書きできない。呼び元(src/24)は失敗を握る。
  async function userRecordMatch(record) {
    if (!userSession() || userApiBase() === null) {
      return null; // 未ログイン or サーバーURL未設定なら送らない
    }
    return userApiFetch("/auth/matches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record || {}),
    });
  }

  // GET: 自分の対戦履歴／デッキ別集計（ログインUIから使う想定。未使用でもAPIとして公開）。
  async function userListMatches(limit) {
    var q = limit ? "?limit=" + encodeURIComponent(limit) : "";
    return userApiFetch("/auth/matches" + q, { method: "GET" });
  }
  async function userMatchStats() {
    return userApiFetch("/auth/matches/stats", { method: "GET" });
  }

  async function userSaveMyDeck(name, code) {
    var data = await userApiFetch("/auth/mydecks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, code: code }),
    });
    try {
      await userRefreshMyDeckOptions();
    } catch (e) {
      /* noop */
    }
    return data;
  }

  async function userDeleteMyDeck(serverId) {
    await userApiFetch("/auth/mydecks/" + encodeURIComponent(serverId), { method: "DELETE" });
    try {
      await userRefreshMyDeckOptions();
    } catch (e) {
      /* noop */
    }
  }

  // ---- 管理者 ----
  async function userAdminListUsers() {
    var data = await userApiFetch("/auth/admin/users", { method: "GET" });
    return (data && data.users) || [];
  }

  async function userAdminResetPassword(name, newPass) {
    return userApiFetch("/auth/admin/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, newPassword: newPass }),
    });
  }

  // ---- マイデッキのセレクト注入 ----
  // (a) deckProfiles（対戦エンジン、index.html/play.html）から旧 mydeck- を除去して新プロファイルを push。
  // (b) ページ内の対象 select に mydeck-* option を追補（既存 mydeck- option は入れ替え）。
  var MYDECK_SELECT_IDS = ["p1DeckSelect", "p2DeckSelect", "lobbyDeckSelect", "savedDeckSelect"];

  function pruneMyDeckOptions(select) {
    if (!select) return;
    [...select.querySelectorAll('option[value^="mydeck-"]')].forEach(function (opt) {
      opt.remove();
    });
  }

  function appendMyDeckOptions(select, profiles) {
    if (!select) return;
    profiles.forEach(function (profile) {
      var option = document.createElement("option");
      option.value = profile.id;
      option.textContent = "マイ: " + profile.name;
      select.appendChild(option);
    });
  }

  async function userRefreshMyDeckOptions() {
    var session = userSession();
    var selects = MYDECK_SELECT_IDS.map(function (id) {
      return document.getElementById(id);
    }).filter(Boolean);

    if (typeof deckProfiles !== "undefined" && Array.isArray(deckProfiles)) {
      // eslint-disable-next-line no-undef
      for (var i = deckProfiles.length - 1; i >= 0; i -= 1) {
        if (typeof deckProfiles[i].id === "string" && deckProfiles[i].id.indexOf("mydeck-") === 0) {
          deckProfiles.splice(i, 1);
        }
      }
    }

    if (!session || !userApiAvailable()) {
      myDeckCache = [];
      selects.forEach(pruneMyDeckOptions);
      return [];
    }

    var profiles = [];
    try {
      profiles = await userListMyDecks();
    } catch (e) {
      selects.forEach(pruneMyDeckOptions);
      return [];
    }

    if (typeof deckProfiles !== "undefined" && Array.isArray(deckProfiles)) {
      // eslint-disable-next-line no-undef
      profiles.forEach(function (profile) {
        deckProfiles.push(profile);
      });
    }

    selects.forEach(function (select) {
      pruneMyDeckOptions(select);
      appendMyDeckOptions(select, profiles);
    });
    return profiles;
  }

  // ---- アカウントバー UI ----
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ==== 共通アカウントコンポーネント（設計 §2） ====
  // 単一のアカウントモーダル（deck-picker と同じ backdrop 流儀・[hidden]{display:none} 併記）を土台に、
  // 各画面へ compact（👤ボタン）/ inline（ロビーのバー）でマウントする。

  var accModalRoot = null;
  var activeControlOpts = {}; // モーダルを開いたコントロールの {variant, deckActions, extraActions}
  var modalState = {
    error: "",
    busy: false,
    adminOpen: false,
    adminUsers: null,
    adminError: "",
    apiTest: "",
    deleteConfirmId: null, // 削除2段階確認中の serverId（文字列）
    myDecks: null, // 直近のマイデッキ一覧（null=未取得）
  };

  function isBuilderPage() {
    return typeof exportableDeck === "function" && typeof encodeDeckShareCode === "function";
  }

  function lookupCardById(id) {
    if (!id) return null;
    if (typeof cardLibrary !== "undefined" && Array.isArray(cardLibrary)) {
      var a = cardLibrary.find(function (c) { return c.id === id; });
      if (a) return a;
    }
    if (typeof cards !== "undefined" && Array.isArray(cards)) {
      var b = cards.find(function (c) { return c.id === id; });
      if (b) return b;
    }
    return null;
  }

  function formatDeckSub(profile) {
    var flagCard = lookupCardById(profile.flag);
    var world = flagCard && flagCard.allowedWorlds && flagCard.allowedWorlds[0];
    var flagName = flagCard ? flagCard.name : profile.flag || "";
    return [world, flagName].filter(Boolean).join("・");
  }

  function formatUpdatedAt(value) {
    if (!value) return "";
    try {
      var d = new Date(value);
      if (isNaN(d.getTime())) return "";
      var m = ("0" + (d.getMonth() + 1)).slice(-2);
      var day = ("0" + d.getDate()).slice(-2);
      return d.getFullYear() + "/" + m + "/" + day;
    } catch (e) {
      return "";
    }
  }

  // 対象 select にデッキをセット（mydeck option 未注入なら先に注入してから value 設定＋change）
  async function setDeckToSelect(selectId, profile) {
    var select = document.getElementById(selectId);
    if (!select || !profile) return;
    var exists = [...select.options].some(function (o) { return o.value === profile.id; });
    if (!exists) {
      await userRefreshMyDeckOptions();
    }
    select.value = profile.id;
    if (select.value !== profile.id) return; // 注入に失敗したら何もしない（保険）
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---- アカウントモーダル（単一インスタンス） ----
  function ensureAccountModal() {
    if (accModalRoot) return accModalRoot;
    accModalRoot = document.createElement("div");
    accModalRoot.className = "acc-backdrop";
    accModalRoot.hidden = true;
    accModalRoot.innerHTML =
      '<div class="acc-modal" role="dialog" aria-modal="true" aria-label="アカウント">' +
      '<div class="acc-head"><strong class="acc-title">アカウント</strong>' +
      '<button type="button" class="acc-close" aria-label="閉じる">×</button></div>' +
      '<div class="acc-body"></div>' +
      "</div>";
    document.body.appendChild(accModalRoot);
    accModalRoot.addEventListener("click", function (event) {
      if (event.target === accModalRoot) closeAccountModal();
    });
    accModalRoot.querySelector(".acc-close").addEventListener("click", closeAccountModal);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && accModalRoot && !accModalRoot.hidden) closeAccountModal();
    });
    // deck-picker を開いたらアカウントモーダルを閉じる（相互排他・§5。capture で dp が開く前に閉じる）
    document.addEventListener(
      "click",
      function (event) {
        if (
          accModalRoot &&
          !accModalRoot.hidden &&
          event.target &&
          event.target.closest &&
          event.target.closest(".dp-open-button")
        ) {
          closeAccountModal();
        }
      },
      true
    );
    return accModalRoot;
  }

  function closeAccountModal() {
    if (accModalRoot) accModalRoot.hidden = true;
    modalState.adminOpen = false;
    modalState.deleteConfirmId = null;
  }

  function openAccountModal(opts) {
    activeControlOpts = opts || {};
    ensureAccountModal();
    // deck-picker のモーダルが開いていたら閉じる（hidden を立てるだけ）
    var dp = document.querySelector(".dp-backdrop");
    if (dp && !dp.hidden) dp.hidden = true;
    modalState.error = "";
    modalState.apiTest = "";
    modalState.deleteConfirmId = null;
    accModalRoot.hidden = false;
    renderModal();
    // 権威サーバ配信かどうか未判定なら、モーダルを開いたタイミングで一度だけ /healthz を叩いて確定
    // →同一オリジンなら「保存先: このサーバー」に描き直す（設計§2.2・§5）。
    if (sameOriginProbe === null) {
      userProbeSameOrigin().then(function () {
        if (!accModalRoot.hidden) {
          renderModal();
          if (userSession() && userApiAvailable()) refreshModalDecks();
        }
      });
    }
    if (userSession() && userApiAvailable()) {
      refreshModalDecks();
    }
  }

  async function refreshModalDecks() {
    try {
      modalState.myDecks = await userListMyDecks();
    } catch (e) {
      modalState.myDecks = [];
    }
    if (accModalRoot && !accModalRoot.hidden) renderModal();
  }

  function setModalError(message) {
    modalState.error = message || "";
    if (!accModalRoot) return;
    var el = accModalRoot.querySelector(".acc-error");
    if (el) el.textContent = modalState.error;
  }

  async function withBusy(fn) {
    if (modalState.busy) return;
    modalState.busy = true;
    setModalError("");
    try {
      await fn();
    } catch (error) {
      setModalError(error && error.message ? error.message : "エラーが発生しました");
    } finally {
      modalState.busy = false;
    }
  }

  async function loadAdminUsers() {
    try {
      modalState.adminUsers = await userAdminListUsers();
      modalState.adminError = "";
    } catch (error) {
      modalState.adminUsers = [];
      modalState.adminError = error && error.message ? error.message : "取得に失敗しました";
    }
    renderModal();
  }

  // 接続テスト: GET {url}/healthz を AbortController 2秒タイムアウトで
  async function testApiBase(url) {
    var base = String(url || "").trim().replace(/\/+$/, "");
    if (!base) {
      modalState.apiTest = "URLを入力してください";
      renderModal();
      return;
    }
    modalState.apiTest = "接続中…";
    renderModal();
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 2000) : null;
    try {
      var res = await fetch(base + "/healthz", { signal: controller ? controller.signal : undefined });
      if (timer) clearTimeout(timer);
      modalState.apiTest = res && res.ok ? "接続OK ✓" : "応答エラー (HTTP " + (res ? res.status : "?") + ")";
    } catch (e) {
      if (timer) clearTimeout(timer);
      modalState.apiTest = "接続できません";
    }
    renderModal();
  }

  function renderAdminPanel() {
    var rowsHtml = "";
    if (modalState.adminUsers) {
      rowsHtml = modalState.adminUsers
        .map(function (u) {
          return (
            '<option value="' + escapeHtml(u.name) + '">' + escapeHtml(u.name) +
            (u.isAdmin ? "（管理者）" : "") + " / デッキ" + (u.deckCount != null ? u.deckCount : "-") + "件</option>"
          );
        })
        .join("");
    }
    return (
      '<div class="acc-section acc-admin-panel">' +
      '<select id="accAdminUserSelect" class="account-input">' +
      (rowsHtml || '<option value="">（読込中）</option>') + "</select>" +
      '<input type="password" id="accAdminPassInput" class="account-input" placeholder="新パスワード" />' +
      '<button type="button" data-act="admin-reset">リセット</button>' +
      '<span class="account-error">' + escapeHtml(modalState.adminError) + "</span>" +
      "</div>"
    );
  }

  function renderDeckRow(profile) {
    var actions = activeControlOpts.deckActions || [];
    var sid = escapeHtml(String(profile.serverId));
    var buttons;
    if (String(modalState.deleteConfirmId) === String(profile.serverId)) {
      buttons =
        '<span class="acc-confirm">本当に削除?</span>' +
        '<button type="button" class="acc-danger" data-act="deck-delete-yes" data-server-id="' + sid + '">はい</button>' +
        '<button type="button" data-act="deck-delete-no">いいえ</button>';
    } else {
      buttons = actions
        .map(function (a, i) {
          return '<button type="button" data-act="deck-action" data-action-idx="' + i + '" data-server-id="' + sid + '">' + escapeHtml(a.label) + "</button>";
        })
        .join("");
      buttons += '<button type="button" class="acc-danger" data-act="deck-delete" data-server-id="' + sid + '">削除</button>';
    }
    var meta = [formatDeckSub(profile), formatUpdatedAt(profile.updatedAt)].filter(Boolean).join(" / ");
    return (
      '<li class="acc-deck-row">' +
      '<div class="acc-deck-meta"><span class="acc-deck-name">' + escapeHtml(profile.name) + "</span>" +
      '<span class="acc-deck-sub">' + escapeHtml(meta) + "</span></div>" +
      '<div class="acc-deck-actions">' + buttons + "</div>" +
      "</li>"
    );
  }

  function renderModal() {
    if (!accModalRoot) return;
    var body = accModalRoot.querySelector(".acc-body");
    var session = userSession();
    var html = "";

    // (1) 接続状態
    if ((typeof window !== "undefined" && window.__BUDDYFIGHT_THIN__) || sameOriginProbe === true) {
      html += '<div class="acc-section acc-conn"><span class="account-label">保存先: このサーバー</span></div>';
    } else {
      var cur = userApiBase() || "";
      var host = (typeof location !== "undefined" && location.hostname) || "127.0.0.1";
      html +=
        '<div class="acc-section acc-conn">' +
        '<label class="account-label" for="accApiBaseInput">サーバーURL</label>' +
        '<input type="text" id="accApiBaseInput" class="account-input" placeholder="http://' + escapeHtml(host) + ':4174" value="' + escapeHtml(cur) + '" />' +
        '<button type="button" data-act="test-apibase">接続テスト</button>' +
        '<button type="button" data-act="save-apibase">保存</button>' +
        '<span class="acc-conn-result">' + escapeHtml(modalState.apiTest) + "</span>" +
        "</div>";
    }

    if (!session) {
      // (2) 未ログイン
      html +=
        '<form class="acc-section acc-login" id="accLoginForm">' +
        '<input type="text" id="accNameInput" class="account-input" placeholder="名前" autocomplete="username" required />' +
        '<input type="password" id="accPassInput" class="account-input" placeholder="パスワード" autocomplete="current-password" required />' +
        '<div class="acc-login-buttons">' +
        '<button type="submit" data-act="login">ログイン</button>' +
        '<button type="button" data-act="register">登録</button>' +
        "</div></form>";
    } else {
      // (3) ログイン中
      var count = modalState.myDecks ? modalState.myDecks.length : (session.deckCount || 0);
      html +=
        '<div class="acc-section acc-me">' +
        '<span class="account-name">' + escapeHtml(session.name) + " さん（デッキ " + count + "件）</span>" +
        '<button type="button" data-act="logout">ログアウト</button>';
      if (session.isAdmin) {
        html += '<button type="button" data-act="toggle-admin">管理</button>';
      }
      html += "</div>";

      // マイデッキ一覧
      html += '<div class="acc-section acc-decks"><h3 class="acc-subhead">マイデッキ</h3>';
      if (!userApiAvailable()) {
        html += '<p class="acc-empty">サーバーURLを設定してください。</p>';
      } else if (modalState.myDecks === null) {
        html += '<p class="acc-empty">読込中…</p>';
      } else if (modalState.myDecks.length === 0) {
        html += '<p class="acc-empty">保存されたデッキはありません。デッキ構築で「サーバーに保存」すると、ここに表示されます。</p>';
      } else {
        html += '<ul class="acc-deck-list">' + modalState.myDecks.map(renderDeckRow).join("") + "</ul>";
      }
      html += "</div>";

      // extraActions（builder 追加ボタン等）
      var extra = activeControlOpts.extraActions || [];
      if (extra.length) {
        html += '<div class="acc-section acc-extra">';
        extra.forEach(function (a, i) {
          html += '<button type="button" data-act="extra" data-extra-idx="' + i + '">' + escapeHtml(a.label) + "</button>";
        });
        html += "</div>";
      }

      if (session.isAdmin && modalState.adminOpen) {
        html += renderAdminPanel();
      }
    }

    html += '<div class="account-error acc-error">' + escapeHtml(modalState.error) + "</div>";
    body.innerHTML = html;
    wireModalEvents();
  }

  function wireModalEvents() {
    if (!accModalRoot) return;
    var root = accModalRoot;

    var loginForm = root.querySelector("#accLoginForm");
    if (loginForm) {
      loginForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var name = root.querySelector("#accNameInput").value.trim();
        var pass = root.querySelector("#accPassInput").value;
        if (!name || !pass) { setModalError("名前とパスワードを入力してください"); return; }
        withBusy(async function () { await userLogin(name, pass); modalState.myDecks = null; renderModal(); refreshModalDecks(); });
      });
    }
    var registerButton = root.querySelector('[data-act="register"]');
    if (registerButton) {
      registerButton.addEventListener("click", function () {
        var name = root.querySelector("#accNameInput").value.trim();
        var pass = root.querySelector("#accPassInput").value;
        if (!name || !pass) { setModalError("名前とパスワードを入力してください"); return; }
        withBusy(async function () { await userRegister(name, pass); modalState.myDecks = null; renderModal(); refreshModalDecks(); });
      });
    }
    var logoutButton = root.querySelector('[data-act="logout"]');
    if (logoutButton) {
      logoutButton.addEventListener("click", function () {
        withBusy(async function () { await userLogout(); modalState.myDecks = null; modalState.adminOpen = false; renderModal(); });
      });
    }
    var saveApi = root.querySelector('[data-act="save-apibase"]');
    if (saveApi) {
      saveApi.addEventListener("click", function () {
        var input = root.querySelector("#accApiBaseInput");
        var val = input ? input.value.trim() : "";
        setUserApiBase(val);
        modalState.apiTest = val ? "保存しました" : "URLを消去しました";
        renderModal();
        userRefreshMyDeckOptions();
        if (userSession()) { modalState.myDecks = null; refreshModalDecks(); }
      });
    }
    var testApi = root.querySelector('[data-act="test-apibase"]');
    if (testApi) {
      testApi.addEventListener("click", function () {
        var input = root.querySelector("#accApiBaseInput");
        testApiBase(input ? input.value : "");
      });
    }
    var toggleAdmin = root.querySelector('[data-act="toggle-admin"]');
    if (toggleAdmin) {
      toggleAdmin.addEventListener("click", function () {
        modalState.adminOpen = !modalState.adminOpen;
        renderModal();
        if (modalState.adminOpen) loadAdminUsers();
      });
    }
    var adminReset = root.querySelector('[data-act="admin-reset"]');
    if (adminReset) {
      adminReset.addEventListener("click", function () {
        var sel = root.querySelector("#accAdminUserSelect");
        var pin = root.querySelector("#accAdminPassInput");
        var name = sel ? sel.value : "";
        var np = pin ? pin.value : "";
        if (!name || !np) { modalState.adminError = "対象ユーザーと新パスワードを入力してください"; renderModal(); return; }
        withBusy(async function () { await userAdminResetPassword(name, np); modalState.adminError = name + " のパスワードをリセットしました。"; renderModal(); });
      });
    }
    root.querySelectorAll('[data-act="extra"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = Number(btn.getAttribute("data-extra-idx"));
        var action = (activeControlOpts.extraActions || [])[idx];
        if (!action || typeof action.onClick !== "function") return;
        withBusy(async function () { await action.onClick(); if (userSession()) { modalState.myDecks = null; refreshModalDecks(); } });
      });
    });
    root.querySelectorAll('[data-act="deck-action"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = Number(btn.getAttribute("data-action-idx"));
        var sid = btn.getAttribute("data-server-id");
        var profile = (modalState.myDecks || []).find(function (p) { return String(p.serverId) === String(sid); });
        var action = (activeControlOpts.deckActions || [])[idx];
        if (!profile || !action || typeof action.onPick !== "function") return;
        withBusy(async function () { await action.onPick(profile); closeAccountModal(); });
      });
    });
    root.querySelectorAll('[data-act="deck-delete"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        modalState.deleteConfirmId = btn.getAttribute("data-server-id");
        renderModal();
      });
    });
    root.querySelectorAll('[data-act="deck-delete-no"]').forEach(function (btn) {
      btn.addEventListener("click", function () { modalState.deleteConfirmId = null; renderModal(); });
    });
    root.querySelectorAll('[data-act="deck-delete-yes"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var sid = btn.getAttribute("data-server-id");
        withBusy(async function () { await userDeleteMyDeck(sid); modalState.deleteConfirmId = null; modalState.myDecks = null; renderModal(); refreshModalDecks(); });
      });
    });
  }

  // ---- 画面マウント ----
  function renderCompactButton(container, controlOpts) {
    var session = userSession();
    var label = session ? "👤 " + session.name : "👤 ログイン";
    container.innerHTML = '<button type="button" class="account-compact-button" aria-haspopup="dialog">' + escapeHtml(label) + "</button>";
    container.querySelector("button").addEventListener("click", function () {
      openAccountModal(controlOpts);
    });
  }

  function renderInlineBar(container, controlOpts) {
    var session = userSession();
    var html = '<div class="account-bar account-inline">';
    if (!session) {
      html +=
        '<form class="account-row account-login-row" id="accInlineLoginForm">' +
        '<input type="text" class="account-input acc-inline-name" placeholder="名前" autocomplete="username" required />' +
        '<input type="password" class="account-input acc-inline-pass" placeholder="パスワード" autocomplete="current-password" required />' +
        '<button type="submit">ログイン</button>' +
        '<button type="button" data-act="inline-detail">詳細…</button>' +
        "</form>";
    } else {
      html +=
        '<div class="account-row account-logged-row">' +
        '<span class="account-name">' + escapeHtml(session.name) + " さん</span>" +
        '<button type="button" data-act="inline-logout">ログアウト</button>' +
        '<button type="button" data-act="inline-detail">詳細…</button>' +
        "</div>";
    }
    html += "</div>";
    container.innerHTML = html;

    var form = container.querySelector("#accInlineLoginForm");
    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var name = container.querySelector(".acc-inline-name").value.trim();
        var pass = container.querySelector(".acc-inline-pass").value;
        if (!name || !pass) { openAccountModal(controlOpts); return; }
        userLogin(name, pass).catch(function () { openAccountModal(controlOpts); });
      });
    }
    var logout = container.querySelector('[data-act="inline-logout"]');
    if (logout) logout.addEventListener("click", function () { userLogout(); });
    var detail = container.querySelector('[data-act="inline-detail"]');
    if (detail) detail.addEventListener("click", function () { openAccountModal(controlOpts); });
  }

  // 公開契約（B班はこれを呼ぶだけ）: userMountAccountControl(container, {variant, deckActions, extraActions})
  function userMountAccountControl(container, opts) {
    if (!container) return;
    opts = opts || {};
    var variant = opts.variant === "inline" ? "inline" : "compact";
    var controlOpts = {
      variant: variant,
      deckActions: opts.deckActions || [],
      extraActions: opts.extraActions || [],
    };
    container.dataset.accountMounted = "1";

    function renderControl() {
      if (variant === "inline") {
        renderInlineBar(container, controlOpts);
      } else {
        renderCompactButton(container, controlOpts);
      }
    }
    renderControl();
    document.addEventListener("user-session-changed", function () {
      renderControl();
      // このコントロール文脈でモーダルが開いていれば追随
      if (accModalRoot && !accModalRoot.hidden && activeControlOpts === controlOpts) {
        renderModal();
      }
    });
  }

  // builder 用の既定 extraActions（互換ラッパで使用。B班は独自に渡してもよい）
  function builderExtraActions() {
    return [
      {
        label: "今のデッキをサーバーに保存",
        when: "loggedIn",
        onClick: async function () {
          var deck = exportableDeck();
          // encodeDeckShareCode は deck-code.js 一本化でデッキ引数を取る形になった（旧builderの無引数版は廃止）。
          // builder 固有の canonicalFlagId 解決を通す encodeDeckObjectShareCode を優先し、無い環境は user 側フォールバック。
          var code =
            typeof encodeDeckObjectShareCode === "function"
              ? encodeDeckObjectShareCode(deck)
              : userEncodeDeckObjectShareCode(deck);
          await userSaveMyDeck(deck.name, code);
          if (typeof showBuilderToast === "function") showBuilderToast(deck.name + " をサーバーに保存しました。");
        },
      },
      {
        label: "端末→サーバーへ一括移行",
        when: "loggedIn",
        onClick: async function () {
          var localDecks = typeof loadSavedDecks === "function" ? loadSavedDecks() : [];
          var ok = 0;
          var fail = 0;
          for (var i = 0; i < localDecks.length; i += 1) {
            var deck = localDecks[i];
            try {
              var code =
                typeof encodeDeckObjectShareCode === "function"
                  ? encodeDeckObjectShareCode(deck)
                  : userEncodeDeckObjectShareCode(deck);
              await userSaveMyDeck(deck.name, code);
              ok += 1;
            } catch (e) {
              fail += 1;
            }
          }
          if (typeof showBuilderToast === "function") showBuilderToast("一括移行: 成功" + ok + "件 / 失敗" + fail + "件");
        },
      },
    ];
  }

  // 互換ラッパ: 旧 #accountBar を inline variant として差し替え。builder では既定 extraActions を注入。
  function userMountAccountBar(container) {
    var extraActions = isBuilderPage() ? builderExtraActions() : [];
    return userMountAccountControl(container, { variant: "inline", deckActions: [], extraActions: extraActions });
  }

  // ---- 「デッキオブジェクト→BFD1コード」のフォールバック実装。
  // 一括移行ボタンはbuilder.htmlにしか出さないため、通常は builder.js 本体の同名関数
  // encodeDeckObjectShareCode をそのまま使う（上のmigrateハンドラでtypeof判定）。
  // これは万一その関数が無い場合の保険（名前衝突を避けるため user プレフィックス付き）。
  function userEncodeDeckObjectShareCode(deck) {
    var flag = typeof canonicalFlagId === "function" ? canonicalFlagId(deck.flag) : deck.flag;
    var payload = [1, deck.name, flag, deck.buddy || "", deck.recipe];
    var json = JSON.stringify(payload);
    var b64 =
      typeof toBase64Url === "function"
        ? toBase64Url(json)
        : btoa(unescape(encodeURIComponent(json)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    return "BFD1." + b64;
  }

  // ---- グローバル公開 ----
  window.userApiAvailable = userApiAvailable;
  window.userSession = userSession;
  window.userRegister = userRegister;
  window.userLogin = userLogin;
  window.userLogout = userLogout;
  window.userFetchMe = userFetchMe;
  window.userListMyDecks = userListMyDecks;
  window.userCachedMyDeckProfile = userCachedMyDeckProfile;
  window.userSaveMyDeck = userSaveMyDeck;
  window.userDeleteMyDeck = userDeleteMyDeck;
  window.userRecordMatch = userRecordMatch;
  window.userListMatches = userListMatches;
  window.userMatchStats = userMatchStats;
  window.userAdminListUsers = userAdminListUsers;
  window.userAdminResetPassword = userAdminResetPassword;
  window.userRefreshMyDeckOptions = userRefreshMyDeckOptions;
  window.userMountAccountBar = userMountAccountBar;
  window.userMountAccountControl = userMountAccountControl;

  // ---- 初期化: DOM準備後に #accountBar があればマウント、無くても mydeck 注入は試みる ----
  // 対戦エンジン(deckProfiles)/builder(officialDecks)のデータ読込は非同期で、完了後に各ページが
  // select.innerHTML を丸ごと差し替える（populateSavedDecks/initializeDeckSelectors 等）ため、
  // それより前に mydeck option を足しても消される。データ読込完了をポーリングしてから注入する
  // （builder.js/play.js は各自の初期化末尾でも userRefreshMyDeckOptions を明示的に呼ぶ＝二重の保険）。
  function whenEngineDataReady(callback) {
    var attempts = 0;
    var maxAttempts = 40; // 40 * 250ms ≒ 10秒でタイムアウトし、それでも一度は注入を試みる
    function check() {
      attempts += 1;
      var ready;
      if (typeof deckProfiles !== "undefined" && Array.isArray(deckProfiles)) {
        // eslint-disable-next-line no-undef
        ready = deckProfiles.length > 0;
      } else if (typeof officialDecks !== "undefined" && Array.isArray(officialDecks)) {
        // eslint-disable-next-line no-undef
        ready = officialDecks.length > 0;
      } else {
        ready = true; // このページにはエンジン側デッキ一覧の概念が無い
      }
      if (ready || attempts >= maxAttempts) {
        callback();
        return;
      }
      setTimeout(check, 250);
    }
    check();
  }

  function init() {
    // 画面判定でアカウントコントロールをマウント（DOM要素の有無で判定＝スクリプト読込順に非依存）。
    // builder は B班が userMountAccountControl を明示的に呼ぶため、ここでは触らない
    // （旧 #accountBar が残っている場合のみ互換マウント）。
    if (document.getElementById("lobbyDeckSelect")) {
      // play.html（ネット対戦ロビー）: inline バー ＋ [使用デッキにセット]
      var bar = document.getElementById("accountBar");
      if (bar && bar.dataset.accountMounted !== "1") {
        userMountAccountControl(bar, {
          variant: "inline",
          deckActions: [
            { label: "使用デッキにセット", onPick: function (p) { return setDeckToSelect("lobbyDeckSelect", p); } },
          ],
        });
      }
    } else if (document.getElementById("p1DeckSelect")) {
      // index.html（ローカル対戦）: compact ボタン ＋ [1Pにセット][2Pにセット]
      var control = document.getElementById("accountControl");
      if (control && control.dataset.accountMounted !== "1") {
        userMountAccountControl(control, {
          variant: "compact",
          deckActions: [
            { label: "1Pにセット", onPick: function (p) { return setDeckToSelect("p1DeckSelect", p); } },
            { label: "2Pにセット", onPick: function (p) { return setDeckToSelect("p2DeckSelect", p); } },
          ],
        });
      }
    } else {
      // builder 等: B班が未マウントのまま旧 #accountBar が残っていれば互換マウント
      var legacy = document.getElementById("accountBar");
      if (legacy && legacy.dataset.accountMounted !== "1") {
        userMountAccountBar(legacy);
      }
    }
    whenEngineDataReady(function () {
      userRefreshMyDeckOptions();
    });
    // ログイン済みで apiBase 未設定（＝権威サーバ配信の builder/index の可能性）なら、
    // 一度だけ /healthz プローブして同一オリジンを確定→マイデッキ注入をやり直す。
    // 未ログインならページロード時にはプローブしない（モーダルを開いた時に判定。設計§5）。
    if (userSession() && userApiBase() === null) {
      userProbeSameOrigin().then(function (ok) {
        if (ok) {
          whenEngineDataReady(function () {
            userRefreshMyDeckOptions();
          });
        }
      });
    }
    document.addEventListener("user-session-changed", userRefreshMyDeckOptions);
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();

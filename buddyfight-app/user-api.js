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
  function userApiBase() {
    if (typeof window !== "undefined" && window.__BUDDYFIGHT_THIN__) {
      return "";
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

  function userMountAccountBar(container) {
    if (!container) return;
    var barState = { error: "", busy: false, adminOpen: false, adminUsers: null, adminError: "" };

    function isBuilderPage() {
      return typeof exportableDeck === "function" && typeof encodeDeckShareCode === "function";
    }

    function render() {
      var session = userSession();
      var apiAvailable = userApiAvailable();
      var html = "";

      if (!apiAvailable) {
        html +=
          '<div class="account-row account-apibase-row">' +
          '<span class="account-label">サーバーURL未設定</span>' +
          '<input type="text" id="accApiBaseInput" class="account-input" placeholder="例: http://127.0.0.1:4174" />' +
          '<button type="button" data-act="save-apibase">設定</button>' +
          "</div>";
      } else if (!session) {
        html +=
          '<form class="account-row account-login-row" id="accLoginForm">' +
          '<input type="text" id="accNameInput" class="account-input" placeholder="名前" autocomplete="username" required />' +
          '<input type="password" id="accPassInput" class="account-input" placeholder="パスワード" autocomplete="current-password" required />' +
          '<button type="submit" data-act="login">ログイン</button>' +
          '<button type="button" data-act="register">登録</button>' +
          "</form>";
        if (typeof window !== "undefined" && !window.__BUDDYFIGHT_THIN__) {
          html +=
            '<div class="account-row account-apibase-row account-apibase-row-compact">' +
            '<button type="button" class="account-link-button" data-act="edit-apibase">サーバーURL変更</button>' +
            "</div>";
        }
      } else {
        html +=
          '<div class="account-row account-logged-row">' +
          '<span class="account-name">' +
          escapeHtml(session.name) +
          " さん</span>" +
          '<button type="button" data-act="logout">ログアウト</button>';
        if (isBuilderPage()) {
          html +=
            '<button type="button" data-act="save-server">サーバーに保存</button>' +
            '<button type="button" data-act="migrate">端末→サーバーへ一括移行</button>';
        }
        if (session.isAdmin) {
          html += '<button type="button" data-act="toggle-admin">管理</button>';
        }
        html += "</div>";
        if (session.isAdmin && barState.adminOpen) {
          html += renderAdminPanel();
        }
      }

      html += '<span class="account-error" id="accError">' + escapeHtml(barState.error) + "</span>";
      container.innerHTML = '<div class="account-bar">' + html + "</div>";
      wireEvents();
    }

    function renderAdminPanel() {
      var rowsHtml = "";
      if (barState.adminUsers) {
        rowsHtml = barState.adminUsers
          .map(function (u) {
            return (
              '<option value="' +
              escapeHtml(u.name) +
              '">' +
              escapeHtml(u.name) +
              (u.isAdmin ? "（管理者）" : "") +
              " / デッキ" +
              (u.deckCount != null ? u.deckCount : "-") +
              "件</option>"
            );
          })
          .join("");
      }
      return (
        '<div class="account-row account-admin-panel">' +
        '<select id="accAdminUserSelect" class="account-input">' +
        (rowsHtml || '<option value="">（読込中）</option>') +
        "</select>" +
        '<input type="password" id="accAdminPassInput" class="account-input" placeholder="新パスワード" />' +
        '<button type="button" data-act="admin-reset">リセット</button>' +
        '<span class="account-error">' +
        escapeHtml(barState.adminError) +
        "</span>" +
        "</div>"
      );
    }

    function setError(message) {
      barState.error = message || "";
      var el = container.querySelector("#accError");
      if (el) el.textContent = barState.error;
    }

    async function withBusy(fn) {
      if (barState.busy) return;
      barState.busy = true;
      setError("");
      try {
        await fn();
      } catch (error) {
        setError(error && error.message ? error.message : "エラーが発生しました");
      } finally {
        barState.busy = false;
      }
    }

    async function loadAdminUsers() {
      try {
        barState.adminUsers = await userAdminListUsers();
        barState.adminError = "";
      } catch (error) {
        barState.adminUsers = [];
        barState.adminError = error && error.message ? error.message : "取得に失敗しました";
      }
      render();
    }

    function wireEvents() {
      var loginForm = container.querySelector("#accLoginForm");
      if (loginForm) {
        loginForm.addEventListener("submit", function (event) {
          event.preventDefault();
          var name = container.querySelector("#accNameInput").value.trim();
          var pass = container.querySelector("#accPassInput").value;
          if (!name || !pass) return;
          withBusy(async function () {
            await userLogin(name, pass);
            render();
          });
        });
      }

      var registerButton = container.querySelector('[data-act="register"]');
      if (registerButton) {
        registerButton.addEventListener("click", function () {
          var name = container.querySelector("#accNameInput").value.trim();
          var pass = container.querySelector("#accPassInput").value;
          if (!name || !pass) {
            setError("名前とパスワードを入力してください");
            return;
          }
          withBusy(async function () {
            await userRegister(name, pass);
            render();
          });
        });
      }

      var logoutButton = container.querySelector('[data-act="logout"]');
      if (logoutButton) {
        logoutButton.addEventListener("click", function () {
          withBusy(async function () {
            await userLogout();
            barState.adminOpen = false;
            render();
          });
        });
      }

      var saveServerButton = container.querySelector('[data-act="save-server"]');
      if (saveServerButton) {
        saveServerButton.addEventListener("click", function () {
          withBusy(async function () {
            var deck = exportableDeck();
            var code = encodeDeckShareCode();
            await userSaveMyDeck(deck.name, code);
            if (typeof showBuilderToast === "function") {
              showBuilderToast(deck.name + " をサーバーに保存しました。");
            } else {
              setError("");
            }
          });
        });
      }

      var migrateButton = container.querySelector('[data-act="migrate"]');
      if (migrateButton) {
        migrateButton.addEventListener("click", function () {
          withBusy(async function () {
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
            var message = "一括移行: 成功" + ok + "件 / 失敗" + fail + "件";
            if (typeof showBuilderToast === "function") {
              showBuilderToast(message);
            } else {
              setError(message);
            }
          });
        });
      }

      var toggleAdminButton = container.querySelector('[data-act="toggle-admin"]');
      if (toggleAdminButton) {
        toggleAdminButton.addEventListener("click", function () {
          barState.adminOpen = !barState.adminOpen;
          if (barState.adminOpen) {
            render();
            loadAdminUsers();
          } else {
            render();
          }
        });
      }

      var adminResetButton = container.querySelector('[data-act="admin-reset"]');
      if (adminResetButton) {
        adminResetButton.addEventListener("click", function () {
          var select = container.querySelector("#accAdminUserSelect");
          var passInput = container.querySelector("#accAdminPassInput");
          var name = select ? select.value : "";
          var newPass = passInput ? passInput.value : "";
          if (!name || !newPass) {
            barState.adminError = "対象ユーザーと新パスワードを入力してください";
            render();
            return;
          }
          withBusy(async function () {
            await userAdminResetPassword(name, newPass);
            barState.adminError = name + " のパスワードをリセットしました。";
            render();
          });
        });
      }

      var saveApiBaseButton = container.querySelector('[data-act="save-apibase"]');
      if (saveApiBaseButton) {
        saveApiBaseButton.addEventListener("click", function () {
          var input = container.querySelector("#accApiBaseInput");
          if (!input || !input.value.trim()) return;
          setUserApiBase(input.value);
          barState.error = "";
          render();
          userRefreshMyDeckOptions();
        });
      }

      var editApiBaseButton = container.querySelector('[data-act="edit-apibase"]');
      if (editApiBaseButton) {
        editApiBaseButton.addEventListener("click", function () {
          setUserApiBase("");
          render();
        });
      }
    }

    render();
    document.addEventListener("user-session-changed", render);
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
  window.userAdminListUsers = userAdminListUsers;
  window.userAdminResetPassword = userAdminResetPassword;
  window.userRefreshMyDeckOptions = userRefreshMyDeckOptions;
  window.userMountAccountBar = userMountAccountBar;

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
    var container = document.getElementById("accountBar");
    if (container) {
      userMountAccountBar(container);
    }
    whenEngineDataReady(function () {
      userRefreshMyDeckOptions();
    });
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

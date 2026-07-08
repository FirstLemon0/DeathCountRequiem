// deck-picker.js — デッキ選択モーダル（検索・フィルタ・ソート）。index.html / play.html / builder.html 共用。
//
// 設計（docs/ユーザーデータ保管とデッキ選択UI_設計_2026-07-08.md §4）:
// - 既存の <select> は「options と value の置き場」としてそのまま活かす（各画面の populate 流儀・
//   CPUランダム(__cpu_random__)・自作デッキ・builder のプレースホルダを無改変で継承する）。
// - このスクリプトは select を CSS で隠し、「デッキを選ぶ…」ボタン＋モーダルを被せるだけ。
// - 選択確定は select.value を書いて change イベントを dispatch する（既存ロジック非依存・非改変）。
// - デッキのメタ（シリーズ/ワールド/発売順/バディ画像）は各ページのグローバル
//   （deckProfiles+cardLibrary ＝対戦画面、officialDecks+cards ＝builder）から遅延解決する。
//   グローバルが無いページ・未ロード時は素のリスト（ラベルのみ）で動く。
(function () {
  "use strict";
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return; // vm テスト環境等では何もしない
  }

  const WORLD_ORDER = [
    "ドラゴンW",
    "デンジャーW",
    "マジックW",
    "スタードラゴンW",
    "エンシェントW",
    "ダンジョンW",
    "レジェンドW",
    "カタナW",
    "ヒーローW",
    "ダークネスドラゴンW",
    "ジェネリック",
    "特殊",
  ];
  const SPECIAL_GROUP = "その他";
  const uiState = { search: "", series: "", category: "", world: "", product: "", sort: "release" };
  const collapsedGroups = new Set(); // productName 単位の折りたたみ状態（ページ内で保持）
  let modalRoot = null;
  let activeAttach = null;

  // ---- ページ別アダプタ（グローバルの有無で判定。lazy に毎回読む） ----

  function engineAdapter() {
    return {
      resolve(value) {
        if (typeof deckProfiles === "undefined" || !Array.isArray(deckProfiles)) return null;
        return deckProfiles.find((profile) => profile.id === value) || null;
      },
      findCard(id) {
        if (!id || typeof cardLibrary === "undefined" || !Array.isArray(cardLibrary)) return null;
        return cardLibrary.find((card) => card.id === id) || null;
      },
      fillThumb(card, img) {
        if (!card) return false;
        const cached = typeof cardImagePacks !== "undefined" ? cardImagePacks[card.id] : null;
        if (cached) {
          img.src = cached;
          return true;
        }
        if (typeof ensureImagePackLoaded === "function") {
          ensureImagePackLoaded(card).then(() => {
            const loaded = typeof cardImagePacks !== "undefined" ? cardImagePacks[card.id] : null;
            if (loaded) {
              img.src = loaded;
            } else if (typeof officialCardImageUrl === "function") {
              const remote = officialCardImageUrl(card);
              if (remote) img.src = remote;
            }
          });
          return true;
        }
        return false;
      },
    };
  }

  function builderAdapter() {
    return {
      resolve(value) {
        if (typeof officialDecks !== "undefined" && Array.isArray(officialDecks)) {
          const official = officialDecks.find((deck) => deck.id === value);
          if (official) return official;
        }
        if (typeof loadSavedDecks === "function") {
          const saved = loadSavedDecks().find((deck) => deck.id === value);
          if (saved) {
            return { ...saved, category: "custom", productName: "この端末の保存デッキ", releaseOrder: 99999 };
          }
        }
        return null;
      },
      findCard(id) {
        if (!id || typeof cards === "undefined" || !Array.isArray(cards)) return null;
        return cards.find((card) => card.id === id) || null;
      },
      fillThumb(card, img) {
        if (!card) return false;
        const cached = typeof builderPacks !== "undefined" ? builderPacks[card.id] : null;
        if (cached) {
          img.src = cached;
          return true;
        }
        if (typeof builderEnsurePack === "function" && card.imagePack) {
          builderEnsurePack(card.imagePack).then(() => {
            const loaded = typeof builderPacks !== "undefined" ? builderPacks[card.id] : null;
            if (loaded) {
              img.src = loaded;
            } else if (typeof officialCardImageUrl === "function") {
              const remote = officialCardImageUrl(card);
              if (remote) img.src = remote;
            }
          });
          return true;
        }
        return false;
      },
    };
  }

  function pageAdapter() {
    if (typeof deckProfiles !== "undefined") return engineAdapter();
    if (typeof officialDecks !== "undefined") return builderAdapter();
    return { resolve: () => null, findCard: () => null, fillThumb: () => false };
  }

  // ---- エントリ構築（select の options が唯一の情報源） ----

  function buildEntries(select, adapter) {
    return [...select.options].map((option) => {
      const profile = adapter.resolve(option.value);
      if (!profile) {
        return { value: option.value, label: option.textContent.trim(), profile: null };
      }
      const flagCard = adapter.findCard(profile.flag);
      const buddyCard = profile.buddy ? adapter.findCard(profile.buddy) : null;
      const world = (flagCard && flagCard.allowedWorlds && flagCard.allowedWorlds[0]) || "特殊";
      const category = profile.category || (profile.productId === "custom" ? "custom" : "official");
      return {
        value: option.value,
        label: option.textContent.trim(),
        profile,
        name: profile.name || option.textContent.trim(),
        productName:
          category === "custom" ? "自作デッキ" : profile.productName || profile.productId || "その他の製品",
        series: profile.series || "",
        category,
        world,
        flagName: flagCard ? flagCard.name : "",
        buddyCard,
        buddyName: buddyCard ? buddyCard.name : "",
        releaseOrder: Number.isFinite(profile.releaseOrder) ? profile.releaseOrder : 9999,
        searchText: [
          profile.name,
          profile.productName,
          flagCard ? flagCard.name : "",
          buddyCard ? buddyCard.name : "",
          world,
          profile.series,
        ]
          .join(" ")
          .toLowerCase(),
      };
    });
  }

  function entryMatches(entry) {
    if (!entry.profile) return true; // CPUランダム等の特別行はフィルタ対象外（常に表示）
    if (uiState.series && entry.series !== uiState.series) return false;
    if (uiState.category && entry.category !== uiState.category) return false;
    if (uiState.world && entry.world !== uiState.world) return false;
    if (uiState.product && entry.productName !== uiState.product) return false;
    if (uiState.search && !entry.searchText.includes(uiState.search.toLowerCase())) return false;
    return true;
  }

  function groupEntries(entries) {
    const special = entries.filter((entry) => !entry.profile);
    const decks = entries.filter((entry) => entry.profile && entryMatches(entry));
    const groups = [];
    if (special.length > 0) {
      groups.push({ title: SPECIAL_GROUP, order: -1, rows: special });
    }
    if (uiState.sort === "name") {
      groups.push({
        title: "すべて（名前順）",
        order: 0,
        rows: [...decks].sort((a, b) => a.name.localeCompare(b.name, "ja")),
      });
    } else if (uiState.sort === "world") {
      const byWorld = new Map();
      decks.forEach((entry) => {
        if (!byWorld.has(entry.world)) byWorld.set(entry.world, []);
        byWorld.get(entry.world).push(entry);
      });
      [...byWorld.entries()]
        .sort((a, b) => {
          const ai = WORLD_ORDER.indexOf(a[0]);
          const bi = WORLD_ORDER.indexOf(b[0]);
          return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        })
        .forEach(([world, rows]) => {
          rows.sort((a, b) => a.releaseOrder - b.releaseOrder || a.name.localeCompare(b.name, "ja"));
          groups.push({ title: world, order: 0, rows });
        });
    } else {
      const byProduct = new Map();
      decks.forEach((entry) => {
        if (!byProduct.has(entry.productName)) byProduct.set(entry.productName, []);
        byProduct.get(entry.productName).push(entry);
      });
      [...byProduct.entries()]
        .map(([title, rows]) => ({
          title,
          order: Math.min(...rows.map((row) => row.releaseOrder)),
          rows,
        }))
        .sort((a, b) => a.order - b.order)
        .forEach((group) => groups.push(group));
    }
    return groups.filter((group) => group.rows.length > 0);
  }

  // ---- モーダル ----

  function ensureModal() {
    if (modalRoot) return modalRoot;
    modalRoot = document.createElement("div");
    modalRoot.className = "dp-backdrop";
    modalRoot.hidden = true;
    modalRoot.innerHTML = `
      <div class="dp-modal" role="dialog" aria-modal="true" aria-label="デッキ選択">
        <div class="dp-head">
          <strong class="dp-title">デッキを選ぶ</strong>
          <button type="button" class="dp-close" aria-label="閉じる">×</button>
        </div>
        <div class="dp-tools">
          <input type="search" class="dp-search" placeholder="デッキ名・フラッグ・バディで検索" aria-label="デッキ検索" />
          <div class="dp-chip-row" data-filter="series">
            <button type="button" class="dp-chip" data-value="">全シリーズ</button>
            <button type="button" class="dp-chip" data-value="無印">無印</button>
            <button type="button" class="dp-chip" data-value="100">100</button>
          </div>
          <div class="dp-chip-row" data-filter="category">
            <button type="button" class="dp-chip" data-value="">全区分</button>
            <button type="button" class="dp-chip" data-value="official">公式</button>
            <button type="button" class="dp-chip" data-value="developer">開発者</button>
            <button type="button" class="dp-chip" data-value="custom">自作</button>
          </div>
          <div class="dp-select-row">
            <label>製品
              <select class="dp-product"><option value="">すべて</option></select>
            </label>
            <label>ワールド
              <select class="dp-world"><option value="">すべて</option></select>
            </label>
            <label>並び順
              <select class="dp-sort">
                <option value="release">発売順</option>
                <option value="name">名前順</option>
                <option value="world">ワールド別</option>
              </select>
            </label>
          </div>
        </div>
        <div class="dp-list" role="listbox"></div>
        <div class="dp-foot">
          <span class="dp-count"></span>
          <button type="button" class="dp-cancel">閉じる</button>
        </div>
      </div>`;
    document.body.appendChild(modalRoot);

    modalRoot.addEventListener("click", (event) => {
      if (event.target === modalRoot) closeModal();
    });
    modalRoot.querySelector(".dp-close").addEventListener("click", closeModal);
    modalRoot.querySelector(".dp-cancel").addEventListener("click", closeModal);
    modalRoot.querySelector(".dp-search").addEventListener("input", (event) => {
      uiState.search = event.target.value.trim();
      renderList();
    });
    modalRoot.querySelectorAll(".dp-chip-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        const chip = event.target.closest(".dp-chip");
        if (!chip) return;
        uiState[row.dataset.filter] = chip.dataset.value;
        renderList();
      });
    });
    modalRoot.querySelector(".dp-product").addEventListener("change", (event) => {
      uiState.product = event.target.value;
      renderList();
    });
    modalRoot.querySelector(".dp-world").addEventListener("change", (event) => {
      uiState.world = event.target.value;
      renderList();
    });
    modalRoot.querySelector(".dp-sort").addEventListener("change", (event) => {
      uiState.sort = event.target.value;
      renderList();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modalRoot && !modalRoot.hidden) closeModal();
    });
    return modalRoot;
  }

  function closeModal() {
    if (modalRoot) modalRoot.hidden = true;
    if (activeAttach) syncButtonLabel(activeAttach);
    activeAttach = null;
  }

  function renderList() {
    if (!activeAttach || !modalRoot) return;
    const { select, adapter } = activeAttach;
    const entries = buildEntries(select, adapter);

    // 製品セレクトの選択肢を現在のデッキ群から再構築（発売順・重複排除・選択は保持）
    const productSelect = modalRoot.querySelector(".dp-product");
    const productOrder = new Map();
    entries
      .filter((entry) => entry.profile)
      .forEach((entry) => {
        const prev = productOrder.get(entry.productName);
        if (prev === undefined || entry.releaseOrder < prev) {
          productOrder.set(entry.productName, entry.releaseOrder);
        }
      });
    const products = [...productOrder.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
    productSelect.innerHTML = `<option value="">すべて</option>${products
      .map((name) => `<option value="${name}"${name === uiState.product ? " selected" : ""}>${name}</option>`)
      .join("")}`;
    if (uiState.product && !products.includes(uiState.product)) {
      uiState.product = "";
      productSelect.value = "";
    }

    // ワールドセレクトの選択肢を現在のデッキ群から再構築（選択は保持）
    const worldSelect = modalRoot.querySelector(".dp-world");
    const worlds = [...new Set(entries.filter((entry) => entry.profile).map((entry) => entry.world))];
    worlds.sort((a, b) => {
      const ai = WORLD_ORDER.indexOf(a);
      const bi = WORLD_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    worldSelect.innerHTML = `<option value="">すべて</option>${worlds
      .map((world) => `<option value="${world}"${world === uiState.world ? " selected" : ""}>${world}</option>`)
      .join("")}`;
    if (uiState.world && !worlds.includes(uiState.world)) {
      uiState.world = "";
      worldSelect.value = "";
    }
    modalRoot.querySelector(".dp-search").value = uiState.search;
    modalRoot.querySelector(".dp-sort").value = uiState.sort;
    modalRoot.querySelectorAll(".dp-chip-row").forEach((row) => {
      row.querySelectorAll(".dp-chip").forEach((chip) => {
        chip.classList.toggle("dp-chip-on", chip.dataset.value === uiState[row.dataset.filter]);
      });
    });

    const groups = groupEntries(entries);
    const list = modalRoot.querySelector(".dp-list");
    list.innerHTML = "";
    let shown = 0;
    groups.forEach((group) => {
      const section = document.createElement("section");
      section.className = "dp-group";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "dp-group-head";
      const collapsed = collapsedGroups.has(group.title);
      head.innerHTML = `<span class="dp-caret">${collapsed ? "▶" : "▼"}</span>${group.title}<span class="dp-group-count">${group.rows.length}</span>`;
      head.addEventListener("click", () => {
        if (collapsedGroups.has(group.title)) collapsedGroups.delete(group.title);
        else collapsedGroups.add(group.title);
        renderList();
      });
      section.appendChild(head);
      if (!collapsed) {
        group.rows.forEach((entry) => {
          section.appendChild(buildRow(entry));
          shown += 1;
        });
      } else {
        shown += group.rows.length;
      }
      list.appendChild(section);
    });
    if (groups.length === 0) {
      list.innerHTML = '<p class="dp-empty">条件に一致するデッキがありません。</p>';
    }
    modalRoot.querySelector(".dp-count").textContent = `${shown}件`;
  }

  function buildRow(entry) {
    const { select, adapter } = activeAttach;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dp-row";
    if (entry.value === select.value) row.classList.add("dp-row-selected");
    if (entry.profile) {
      const img = document.createElement("img");
      img.className = "dp-thumb";
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.style.visibility = "hidden";
      });
      if (!adapter.fillThumb(entry.buddyCard, img)) img.style.visibility = "hidden";
      row.appendChild(img);
      const text = document.createElement("span");
      text.className = "dp-row-text";
      text.innerHTML = `<span class="dp-row-name"></span><span class="dp-row-sub"></span>`;
      text.querySelector(".dp-row-name").textContent = entry.name;
      text.querySelector(".dp-row-sub").textContent = [entry.world, entry.flagName].filter(Boolean).join("・");
      row.appendChild(text);
    } else {
      const text = document.createElement("span");
      text.className = "dp-row-text dp-row-special";
      text.textContent = entry.label || "（未選択）";
      row.appendChild(text);
    }
    row.addEventListener("click", () => {
      select.value = entry.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      closeModal();
    });
    return row;
  }

  // ---- attach ----

  function syncButtonLabel(attachInfo) {
    const { select, button } = attachInfo;
    const selected = select.selectedOptions && select.selectedOptions[0];
    button.textContent = selected && selected.textContent.trim() ? selected.textContent.trim() : "デッキを選ぶ…";
  }

  function attachDeckPicker(select) {
    if (!select || select.dataset.deckPickerAttached === "1") return;
    select.dataset.deckPickerAttached = "1";
    select.classList.add("dp-hidden-select");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dp-open-button";
    const ariaLabel = select.getAttribute("aria-label");
    if (ariaLabel) button.setAttribute("aria-label", `${ariaLabel}を選ぶ`);
    const attachInfo = { select, button, adapter: pageAdapter() };
    select.insertAdjacentElement("afterend", button);
    button.addEventListener("click", () => {
      activeAttach = attachInfo;
      ensureModal();
      syncButtonLabel(attachInfo);
      modalRoot.hidden = false;
      renderList();
      modalRoot.querySelector(".dp-search").focus({ preventScroll: true });
    });
    select.addEventListener("change", () => syncButtonLabel(attachInfo));
    // 各画面の populate（innerHTML 差し替え・オプション追加）や既定値設定は change を発火しないことが
    // あるため、options の変化を監視してラベルを追随させる。
    const observer = new MutationObserver(() => syncButtonLabel(attachInfo));
    observer.observe(select, { childList: true });
    syncButtonLabel(attachInfo);
    setTimeout(() => syncButtonLabel(attachInfo), 1500); // 非同期ロード後の既定値反映を拾う保険
  }

  function init() {
    ["p1DeckSelect", "p2DeckSelect", "lobbyDeckSelect", "savedDeckSelect"].forEach((id) => {
      attachDeckPicker(document.getElementById(id));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

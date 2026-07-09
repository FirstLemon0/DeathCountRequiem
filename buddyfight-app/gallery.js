// ===== gallery.js — カードギャラリー（閲覧専用）=====
// 34製品2,089枚を検索・絞り込み・ページングして眺めるだけの画面。デッキ編集機能は持たない。
//
// 【builder.js の流用について】builder.js の検索/フィルタ/サムネ読込は流用したいが、builder.js は
// 1,500行超の単一グローバルスコープでデッキ編集の状態（currentDeck・保存/ネット連携・user-api 依存）と
// 密結合しており、共有関数を切り出すと builder 側を壊すリスクが高い。ギャラリーは閲覧専用で単純なので、
// 必要な薄いスライス（loadJson の ?v= 化 / フィルタ / compareCards / IntersectionObserver サムネゲート）
// だけを builder のロジックに忠実になぞって再実装する。特に **D1 の可視性ゲート（IntersectionObserver）は
// 必須要件**（無条件全件読込は 40MB 落とす）なので builder と同じ設計で踏襲する。

const galleryDataFiles = { cardsets: "data/cardsets.json" };

const galleryTypeLabels = {
  monster: "モンスター",
  spell: "魔法",
  item: "アイテム",
  impact: "必殺技",
  impactMonster: "必殺モンスター",
  flag: "フラッグ",
};

const GALLERY_PAGE_SIZE = 60; // 1ページ表示件数

// ---- 状態（vm では let はグローバルに露出しないので、テストは純粋関数 galleryComputeFiltered/galleryPaginate を叩く）----
let galleryCards = [];
let galleryPage = 0;
let galleryActiveGeneration = ""; // 世代タブの選択（空=すべて）

const gEl = {
  searchInput: document.querySelector("#gallerySearch"),
  typeFilter: document.querySelector("#galleryType"),
  worldFilter: document.querySelector("#galleryWorld"),
  productFilter: document.querySelector("#galleryProduct"),
  rarityFilter: document.querySelector("#galleryRarity"),
  generationTabs: document.querySelector("#galleryGenerations"),
  resultCount: document.querySelector("#galleryCount"),
  results: document.querySelector("#galleryResults"),
  pager: document.querySelector("#galleryPager"),
  status: document.querySelector("#galleryStatus"),
  modal: document.querySelector("#galleryModal"),
  modalBody: document.querySelector("#galleryModalBody"),
  modalClose: document.querySelector("#galleryModalClose"),
};

async function initializeGallery() {
  gallerySetStatus("カードデータ読込中");
  try {
    await galleryLoadData();
    galleryPopulateFilters();
    galleryRenderGenerationTabs();
    galleryBindEvents();
    galleryRender();
    gallerySetStatus(`全${galleryCards.length}枚を読み込みました。`);
  } catch (error) {
    gallerySetStatus(`読込失敗: ${error.message}`);
  }
}

// ---- データ読込（DOM非依存。全カードセットの全エントリ＝2,089枚をそのまま列挙する。builder と違い
//      閲覧専用なので type:flag のカードも除外しない）----
async function galleryLoadData() {
  const cardsetsData = await galleryLoadJson(galleryDataFiles.cardsets);
  const sets = cardsetsData.sets || [];
  const loaded = await Promise.all(
    sets.map(async (set) => ({ set, data: await galleryLoadJson(set.file) })),
  );
  galleryCards = loaded.flatMap(({ set, data }) => {
    const packName = (set.file || "").split("/").pop().replace(/\.json$/, "");
    return (data.cards || []).map((card) => galleryNormalizeCard(card, set, packName));
  });
  return galleryCards;
}

// loadJson: builder/src の loadJson と同じ ?v= 付きキャッシュ方式（未定義環境は no-store フォールバック）。
async function galleryLoadJson(path) {
  const version = globalThis.__BUDDYFIGHT_DATA_VERSION;
  const url = version ? `${path}${path.includes("?") ? "&" : "?"}v=${version}` : path;
  const response = await fetch(url, version ? undefined : { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} を読み込めませんでした。`);
  }
  return response.json();
}

function galleryNormalizeCard(card, set = {}, packName = "") {
  return {
    ...card,
    productId: card.productId || set.id || "",
    productName: card.productName || set.name || "",
    generation: card.generation || set.generation || "",
    attributes: [...(card.attributes || [])],
    keywords: [...(card.keywords || [])],
    rules: [...(card.rules || [])],
    imagePack: packName,
  };
}

// ---- フィルタ（純粋関数: criteria から絞り込み＋整列。DOM非依存でテストしやすい）----
function galleryComputeFiltered(criteria) {
  const c = criteria || {};
  const text = String(c.search || "").trim().toLowerCase();
  const type = c.type || "";
  const world = c.world || "";
  const productId = c.product || "";
  const rarity = c.rarity || "";
  const generation = c.generation || "";
  return galleryCards
    .filter((card) => !generation || card.generation === generation)
    .filter((card) => !type || card.type === type)
    .filter((card) => !world || card.world === world)
    .filter((card) => !productId || card.productId === productId)
    .filter((card) => !rarity || (card.rarity || "") === rarity)
    .filter((card) => {
      if (!text) {
        return true;
      }
      const haystack = [card.name, card.no, card.world, card.productName, ...(card.attributes || [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(text);
    })
    .sort(galleryCompareCards);
}

// DOM のフィルタ値から criteria を組んで絞り込む。
function galleryFilteredCards() {
  return galleryComputeFiltered({
    search: gEl.searchInput ? gEl.searchInput.value : "",
    type: gEl.typeFilter ? gEl.typeFilter.value : "",
    world: gEl.worldFilter ? gEl.worldFilter.value : "",
    product: gEl.productFilter ? gEl.productFilter.value : "",
    rarity: gEl.rarityFilter ? gEl.rarityFilter.value : "",
    generation: galleryActiveGeneration,
  });
}

// builder.js の compareCards と同じ整列（種類順→カード番号→名前）。
function galleryCompareCards(left, right) {
  if (!left || !right) {
    return left ? -1 : 1;
  }
  return (
    galleryTypeOrder(left.type) - galleryTypeOrder(right.type) ||
    String(left.no || "").localeCompare(String(right.no || ""), "ja") ||
    String(left.name || "").localeCompare(String(right.name || ""), "ja")
  );
}
function galleryTypeOrder(type) {
  return { flag: 0, monster: 1, impactMonster: 2, spell: 3, item: 4, impact: 5 }[type] ?? 9;
}

// ---- ページング（純粋関数: 端数・末尾も含めて安全にクランプ）----
function galleryPageCount(total) {
  return Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
}
function galleryPaginate(list, page) {
  const total = list.length;
  const pages = galleryPageCount(total);
  const clamped = Math.min(Math.max(0, page), pages - 1);
  const start = clamped * GALLERY_PAGE_SIZE;
  return { slice: list.slice(start, start + GALLERY_PAGE_SIZE), page: clamped, pages, total, start };
}

// ---- 描画 ----
function galleryRender() {
  if (!gEl.results) {
    return;
  }
  const filtered = galleryFilteredCards();
  const { slice, page, pages, total, start } = galleryPaginate(filtered, galleryPage);
  galleryPage = page; // クランプ結果を反映
  if (gEl.resultCount) {
    gEl.resultCount.textContent = total
      ? `全${total}枚中 ${start + 1}〜${start + slice.length}枚（${page + 1}/${pages}ページ）`
      : "0枚";
  }
  gEl.results.innerHTML = "";
  slice.forEach((card) => gEl.results.append(galleryRenderCard(card)));
  if (!slice.length) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = "条件に合うカードがありません。検索語・種類・ワールド・製品・レアリティを緩めてください。";
    gEl.results.append(empty);
  }
  galleryRenderPager(page, pages);
  galleryFillThumbs(gEl.results);
}

function galleryRenderCard(card) {
  const node = document.createElement("article");
  node.className = "gallery-card";
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", `${card.name || ""} の詳細`);
  node.innerHTML = `
    <div class="gallery-thumb-wrap">${galleryThumbHtml(card)}</div>
    <div class="gallery-card-body">
      <strong class="gallery-card-name">${escapeHtmlG(card.name || "-")}</strong>
      <span class="gallery-meta">${escapeHtmlG(gallerySummaryLine(card))}</span>
      <span class="gallery-meta gallery-rarity">${escapeHtmlG(card.rarity || "-")} / ${escapeHtmlG(card.productName || "-")}</span>
    </div>
  `;
  // カード全体をクリック/Enter で詳細モーダル。
  node.addEventListener("click", () => openCardModal(card));
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCardModal(card);
    }
  });
  return node;
}

function galleryRenderPager(page, pages) {
  if (!gEl.pager) {
    return;
  }
  gEl.pager.innerHTML = "";
  if (pages <= 1) {
    return;
  }
  const mkButton = (label, targetPage, disabled) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener("click", () => galleryGoToPage(targetPage));
    return btn;
  };
  gEl.pager.append(mkButton("« 最初", 0, page === 0));
  gEl.pager.append(mkButton("‹ 前", page - 1, page === 0));
  const indicator = document.createElement("span");
  indicator.className = "gallery-page-indicator";
  indicator.textContent = `${page + 1} / ${pages}`;
  gEl.pager.append(indicator);
  gEl.pager.append(mkButton("次 ›", page + 1, page >= pages - 1));
  gEl.pager.append(mkButton("最後 »", pages - 1, page >= pages - 1));
}

function galleryGoToPage(page) {
  galleryPage = page;
  galleryRender();
  if (gEl.results && typeof gEl.results.scrollIntoView === "function") {
    gEl.results.scrollIntoView({ block: "start" });
  }
}

// フィルタ変更時は必ず先頭ページへ戻す（末尾ページ表示中に絞り込んで空表示になるのを防ぐ）。
function galleryResetAndRender() {
  galleryPage = 0;
  galleryRender();
}

// ---- フィルタ選択肢の生成 ----
function galleryPopulateFilters() {
  gallerySetOptions(gEl.typeFilter, [
    ["", "すべての種類"],
    ...uniqueG(galleryCards.map((c) => c.type)).map((t) => [t, galleryTypeLabels[t] || t]),
  ]);
  gallerySetOptions(gEl.worldFilter, [
    ["", "すべてのワールド"],
    ...uniqueG(galleryCards.map((c) => c.world).filter(Boolean)).map((w) => [w, w]),
  ]);
  gallerySetOptions(gEl.rarityFilter, [
    ["", "すべてのレアリティ"],
    ...uniqueG(galleryCards.map((c) => c.rarity).filter(Boolean)).map((r) => [r, r]),
  ]);
  galleryPopulateProductFilter();
}

function galleryPopulateProductFilter() {
  const prev = gEl.productFilter ? gEl.productFilter.value : "";
  const seen = new Map();
  galleryCards.forEach((card) => {
    if (!card.productId) return;
    if (galleryActiveGeneration && card.generation !== galleryActiveGeneration) return;
    if (!seen.has(card.productId)) seen.set(card.productId, card.productName || card.productId);
  });
  const opts = [...seen.entries()];
  gallerySetOptions(gEl.productFilter, [["", "すべての製品"], ...opts]);
  if (gEl.productFilter) {
    gEl.productFilter.value = opts.some(([id]) => id === prev) ? prev : "";
  }
}

function galleryRenderGenerationTabs() {
  const host = gEl.generationTabs;
  if (!host) return;
  const gens = uniqueG(galleryCards.map((c) => c.generation).filter(Boolean));
  host.innerHTML = "";
  if (gens.length <= 1) {
    return; // 1世代しか無いうちはタブを出さない
  }
  [["", "すべて"], ...gens.map((g) => [g, g])].forEach(([value, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gallery-gen-tab" + (value === galleryActiveGeneration ? " active" : "");
    btn.textContent = label;
    btn.setAttribute("aria-pressed", String(value === galleryActiveGeneration));
    btn.addEventListener("click", () => {
      galleryActiveGeneration = value;
      galleryPopulateProductFilter();
      galleryRenderGenerationTabs();
      galleryResetAndRender();
    });
    host.append(btn);
  });
}

function galleryBindEvents() {
  [gEl.searchInput, gEl.typeFilter, gEl.worldFilter, gEl.productFilter, gEl.rarityFilter].forEach(
    (control) => control && control.addEventListener("input", galleryResetAndRender),
  );
  gEl.modalClose && gEl.modalClose.addEventListener("click", closeCardModal);
  gEl.modal &&
    gEl.modal.addEventListener("click", (event) => {
      if (event.target === gEl.modal) {
        closeCardModal(); // 背景クリックで閉じる
      }
    });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCardModal();
    }
  });
}

// ---- サムネイル読込（builder.js の IntersectionObserver ゲートを忠実に踏襲）----
// 製品画像パック(data/images/*.imgpack.json)は1製品で最大3MB弱。無条件全件読込は 40MB 落とすので、
// **実際にビューポートへ入ったカードの製品パックだけ**を取得する。非対応環境（jsdom/古ブラウザ）は即時読込。
const galleryPacks = {};
const galleryPackPromises = {};
function galleryEnsurePack(pack) {
  if (!pack) {
    return Promise.resolve();
  }
  if (galleryPackPromises[pack]) {
    return galleryPackPromises[pack];
  }
  galleryPackPromises[pack] = fetch(`data/images/${pack}.imgpack.json`, { cache: "force-cache" })
    .then((r) => (r.ok ? r.json() : {}))
    .then((map) => Object.assign(galleryPacks, map))
    .catch(() => {});
  return galleryPackPromises[pack];
}

function galleryFillThumbs(root) {
  if (!root) {
    return;
  }
  // 再描画では前回張った監視を必ず捨てる（DOMノードが差し替わり監視対象が宙に浮くため）。
  if (root.galleryThumbObserver) {
    root.galleryThumbObserver.disconnect();
    root.galleryThumbObserver = null;
  }
  const pending = [];
  root.querySelectorAll("img.gallery-thumb[data-cid]").forEach((img) => {
    const cid = img.dataset.cid;
    if (galleryPacks[cid]) {
      setGalleryThumbSrc(img, galleryPacks[cid]); // 読込済みは即流し込み（fetch も監視も不要）
      return;
    }
    pending.push(img);
  });
  if (!pending.length) {
    return;
  }
  if (typeof IntersectionObserver !== "function") {
    pending.forEach((img) => galleryLoadThumb(img)); // 非対応環境フォールバック
    return;
  }
  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        obs.unobserve(entry.target); // 一度読み込んだら監視解除（多重発火・多重fetch防止）
        galleryLoadThumb(entry.target);
      });
    },
    { rootMargin: "200px" },
  );
  root.galleryThumbObserver = observer;
  pending.forEach((img) => observer.observe(img));
}

function galleryLoadThumb(img) {
  const cid = img.dataset.cid;
  if (galleryPacks[cid]) {
    setGalleryThumbSrc(img, galleryPacks[cid]);
    return;
  }
  galleryEnsurePack(img.dataset.pack).then(() => {
    if (galleryPacks[cid]) {
      setGalleryThumbSrc(img, galleryPacks[cid]);
    } else {
      galleryCardImgError(img);
    }
  });
}

function setGalleryThumbSrc(img, src) {
  img.style.display = "";
  if (!img.getAttribute("onerror")) {
    img.onerror = () => galleryCardImgError(img);
  }
  img.src = src;
}

function galleryThumbHtml(card, extraClass = "") {
  const remote = galleryOfficialImageUrl(card);
  const cid = card?.id || "";
  if (!cid && !remote) {
    return "";
  }
  const src = galleryPacks[cid] || "";
  const srcAttr = src ? ` src="${src}" onerror="galleryCardImgError(this)"` : "";
  return `<img class="gallery-thumb ${extraClass}" loading="lazy" decoding="async" alt="${escapeHtmlG(card.name || "")}"${srcAttr} data-cid="${cid}" data-pack="${card?.imagePack || ""}" data-remote="${remote}">`;
}

function galleryCardImgError(img) {
  const remote = img.getAttribute("data-remote");
  if (remote && img.src !== remote) {
    img.src = remote; // 公式URLへ一度フォールバック
    return;
  }
  img.style.display = "none";
}

// カード番号から公式カード画像URLを導出（ローカルWebPが無い場合のフォールバック。builder と同一ロジック）。
function galleryOfficialImageUrl(card) {
  const no = card?.no;
  if (!no || no.indexOf("/") < 0) {
    return "";
  }
  const [left, right] = no.split("/");
  const letters = left.replace(/-/g, "").match(/^([A-Za-z]+)(\d+)$/);
  const cardnum = String(right).match(/^\d+/);
  if (!letters || !cardnum) {
    return "";
  }
  const num = String(parseInt(cardnum[0], 10)).padStart(4, "0");
  return `https://fc-buddyfight.com/wordpress/wp-content/images/card/${letters[1].toLowerCase()}_${letters[2]}_${num}.png`;
}

// ---- カード詳細モーダル（拡大画像＋rules全文＋ステータス）----
function openCardModal(card) {
  if (!gEl.modal || !gEl.modalBody) {
    return;
  }
  const stats = galleryStatEntries(card)
    .map(([label, value]) => `<div class="gallery-stat"><dt>${escapeHtmlG(label)}</dt><dd>${escapeHtmlG(value)}</dd></div>`)
    .join("");
  const rules = (card.rules || []).length
    ? card.rules.map((line) => `<p>${escapeHtmlG(line)}</p>`).join("")
    : "<p>能力なし。</p>";
  gEl.modalBody.innerHTML = `
    <div class="gallery-modal-grid">
      <div class="gallery-modal-image">${galleryThumbHtml(card, "gallery-modal-thumb")}</div>
      <div class="gallery-modal-info">
        <h2 id="galleryModalTitle">${escapeHtmlG(card.name || "-")}</h2>
        <p class="gallery-modal-sub">${escapeHtmlG(gallerySummaryLine(card))} / ${escapeHtmlG(card.rarity || "-")}</p>
        <p class="gallery-modal-sub">${escapeHtmlG(card.productName || "-")}${(card.attributes || []).length ? " / " + escapeHtmlG(card.attributes.join(" / ")) : ""}</p>
        <dl class="gallery-stat-grid">${stats}</dl>
        <div class="gallery-modal-rules">${rules}</div>
      </div>
    </div>
  `;
  gEl.modal.hidden = false;
  gEl.modal.classList.add("open");
  if (gEl.modalClose && typeof gEl.modalClose.focus === "function") {
    gEl.modalClose.focus();
  }
  // 拡大画像は開いた時にだけ製品パックを確実に取得して流し込む（サムネと同じ経路）。
  galleryFillThumbs(gEl.modalBody);
  galleryEnsurePack(card.imagePack).then(() => {
    const img = gEl.modalBody.querySelector("img.gallery-thumb[data-cid]");
    if (img && galleryPacks[img.dataset.cid]) {
      setGalleryThumbSrc(img, galleryPacks[img.dataset.cid]);
    }
  });
}

function closeCardModal() {
  if (!gEl.modal) {
    return;
  }
  gEl.modal.classList.remove("open");
  gEl.modal.hidden = true;
}

function gallerySummaryLine(card) {
  return [card.no || "-", galleryTypeLabels[card.type] || card.type, card.world || "-"].join(" / ");
}

// カード種別に応じたステータス項目（builder の cardStatEntries を簡約）。
function galleryStatEntries(card) {
  const entries = [];
  if (["monster", "impactMonster"].includes(card.type)) {
    entries.push(
      ["サイズ", galleryStat(card.size)],
      ["攻撃力", galleryStat(card.power)],
      ["打撃力", galleryStat(card.critical)],
      ["防御力", galleryStat(card.defense)],
    );
  } else if (card.type === "item") {
    entries.push(["攻撃力", galleryStat(card.power)], ["打撃力", galleryStat(card.critical)]);
    if (galleryHasStat(card.defense)) {
      entries.push(["防御力", galleryStat(card.defense)]);
    }
  } else if (card.type === "flag") {
    entries.push(
      ["初期ライフ", galleryStat(card.startingLife)],
      ["初期手札", galleryStat(card.startingHand)],
      ["初期ゲージ", galleryStat(card.startingGauge)],
    );
  }
  if (card.keywords?.length) {
    entries.push(["キーワード", card.keywords.join(" / ")]);
  }
  entries.push(["カード番号", card.no || "-"]);
  return entries;
}
function galleryStat(value) {
  return galleryHasStat(value) ? String(value) : "-";
}
function galleryHasStat(value) {
  return value !== undefined && value !== null && value !== "";
}

// ---- 汎用ヘルパ ----
function gallerySetOptions(select, entries) {
  if (!select) {
    return;
  }
  select.innerHTML = "";
  entries.forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  });
}

function uniqueG(values) {
  return [...new Set(values)];
}

function gallerySetStatus(message) {
  if (gEl.status) {
    gEl.status.textContent = message;
  }
}

function escapeHtmlG(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

initializeGallery();

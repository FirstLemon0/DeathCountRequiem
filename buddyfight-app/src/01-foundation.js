// ==========================================================================
// buddyfight モジュール 01 — 定数・共有状態・DOM参照(elements)
// 旧 app.js L1-124 由来。全モジュールはグローバルスコープを共有し、
// HTML で番号順に <script> 読み込みする（連結すると旧 app.js とバイト等価）。
// ==========================================================================
const typeLabels = {
  monster: "モンスター",
  spell: "魔法",
  item: "アイテム",
  impact: "必殺技",
  impactMonster: "必殺モンスター",
  flag: "フラッグ",
};

const phaseLabels = {
  draw: "ドロー",
  charge: "チャージ",
  main: "メイン",
  attack: "アタック",
  defense: "防御確認",
  final: "ファイナル",
  end: "終了",
};

const fieldZones = ["left", "center", "right"];
const setZones = ["set1", "set2"];
// アイテムは通常1枚だが、カード効果で複数装備できるため名前付きスロットを複数用意する（"item" が主枠）。
// zones に全スロットを含めることで、継続/破壊/イベント/無効化などのゾーン走査系が全アイテムを自動処理する。
// 将来もっと必要なら itemZones に追記するだけでよい（各所のゾーン走査はこの配列を参照する）。
const itemZones = ["item", "item2", "item3", "item4"];
const setZonesAndItems = [...setZones, ...itemZones];
const zones = ["left", "center", "right", ...setZonesAndItems];
const ruleEraLabel = "2018年6月以前ルール（神バディファイト以前）";

// プレイヤーが装備している全アイテム（主枠＋追加枠、コール順）を返す。
function equippedItems(player) {
  return itemZones.map((zone) => player?.field?.[zone]).filter(Boolean);
}

// 空いている最初のアイテムスロット名（無ければ null）。
function firstEmptyItemZone(player) {
  return itemZones.find((zone) => !player?.field?.[zone]) || null;
}

// 指定カードが今いるアイテムスロット名（無ければ null）。
function itemZoneOf(player, card) {
  return itemZones.find((zone) => player?.field?.[zone]?.instanceId === card?.instanceId) || null;
}

let cardLibrary = [];
let deckProfiles = [];
let cardSetProfiles = [];
let deckSetProfiles = [];
let flagIdAliases = new Map();

// カード画像パック（製品ごとの base64 パック data/images/{pack}.imgpack.json）。
// cardIdToPack: カードid→パック名(=カードJSONのファイル名stem)。loadGameData で構築。
// cardImagePacks: 読み込み済み cardId→data URL。imagePackPromises: 多重fetch防止の読込Promise。
let cardIdToPack = {};
const cardImagePacks = {};
const imagePackPromises = {};

const dataFiles = {
  cardsets: "data/cardsets.json",
  decksets: "data/decksets.json",
  flags: "data/flags.json",
};

const customDeckStorageKey = "buddyfight.customDecks.v1";

const elements = {
  turnLabel: document.querySelector("#turnLabel"),
  phaseLabel: document.querySelector("#phaseLabel"),
  selectionLabel: document.querySelector("#selectionLabel"),
  handTitle: document.querySelector("#handTitle"),
  handList: document.querySelector("#handList"),
  sizeLabel: document.querySelector("#sizeLabel"),
  attackTarget: document.querySelector("#attackTarget"),
  effectTarget: document.querySelector("#effectTarget"),
  logList: document.querySelector("#logList"),
  cardTooltip: document.querySelector("#cardTooltip"),
  newGameButton: document.querySelector("#newGameButton"),
  exportLogButton: document.querySelector("#exportLogButton"),
  p1DeckSelect: document.querySelector("#p1DeckSelect"),
  p2DeckSelect: document.querySelector("#p2DeckSelect"),
  rulesButton: document.querySelector("#rulesButton"),
  rulesDialog: document.querySelector("#rulesDialog"),
  closeRulesButton: document.querySelector("#closeRulesButton"),
  dropDialog: document.querySelector("#dropDialog"),
  dropDialogTitle: document.querySelector("#dropDialogTitle"),
  dropDialogList: document.querySelector("#dropDialogList"),
  closeDropDialogButton: document.querySelector("#closeDropDialogButton"),
  selectionDialog: document.querySelector("#selectionDialog"),
  selectionDialogTitle: document.querySelector("#selectionDialogTitle"),
  selectionDialogLead: document.querySelector("#selectionDialogLead"),
  selectionDialogPreview: document.querySelector("#selectionDialogPreview"),
  selectionDialogList: document.querySelector("#selectionDialogList"),
  selectionBoardButton: document.querySelector("#selectionBoardButton"),
  selectionConfirmButton: document.querySelector("#selectionConfirmButton"),
  selectionCancelButton: document.querySelector("#selectionCancelButton"),
  drawButton: document.querySelector("#drawButton"),
  chargeButton: document.querySelector("#chargeButton"),
  mainPhaseButton: document.querySelector("#mainPhaseButton"),
  castButton: document.querySelector("#castButton"),
  resolveAttackButton: document.querySelector("#resolveAttackButton"),
  counterHandButton: document.querySelector("#counterHandButton"),
  attackPhaseButton: document.querySelector("#attackPhaseButton"),
  linkToggleButton: document.querySelector("#linkToggleButton"),
  finalPhaseButton: document.querySelector("#finalPhaseButton"),
  attackButton: document.querySelector("#attackButton"),
  endTurnButton: document.querySelector("#endTurnButton"),
  partnerCallButton: document.querySelector("#partnerCallButton"),
  netplayPanel: document.querySelector("#netplayPanel"),
  networkStatus: document.querySelector("#networkStatus"),
  roomInput: document.querySelector("#roomInput"),
  createRoomButton: document.querySelector("#createRoomButton"),
  joinRoomButton: document.querySelector("#joinRoomButton"),
  copyRoomButton: document.querySelector("#copyRoomButton"),
  playerSeatLabel: document.querySelector("#playerSeatLabel"),
  // B2: カードシート / デッキ情報 / 確認ダイアログ（タッチ操作刷新）
  cardSheet: document.querySelector("#cardSheet"),
  cardSheetTitle: document.querySelector("#cardSheetTitle"),
  cardSheetDetail: document.querySelector("#cardSheetDetail"),
  cardSheetActions: document.querySelector("#cardSheetActions"),
  closeCardSheetButton: document.querySelector("#closeCardSheetButton"),
  deckInfoDialog: document.querySelector("#deckInfoDialog"),
  deckInfoTitle: document.querySelector("#deckInfoTitle"),
  deckInfoBody: document.querySelector("#deckInfoBody"),
  closeDeckInfoButton: document.querySelector("#closeDeckInfoButton"),
  confirmDialog: document.querySelector("#confirmDialog"),
  confirmMessage: document.querySelector("#confirmMessage"),
  confirmOkButton: document.querySelector("#confirmOkButton"),
  confirmCancelButton: document.querySelector("#confirmCancelButton"),
};

let state;
let networkSession = {
  connected: false,
  roomId: "",
  token: "",
  seat: null,
  eventSource: null,
  applyingSnapshot: false,
  lastSeq: 0,
  pendingChoiceResolvers: new Map(),
  handledChoiceRequests: new Set(),
};

// B2: タッチ操作刷新のUI状態。ネット同期(snapshot)には絶対に載せない（相手画面へ漏れるため）。
let uiTargeting = null; // null | { mode: "attack" | "effect", candidates: [...] }
let cardSheetReadOnly = false; // 閲覧専用シート（相手カード等）かどうか
let cardSheetReadOnlyCard = null; // 閲覧専用シートで表示中のカード
let confirmDialogResolver = null; // confirmAction() のPromise解決関数
let longPressTimer = null; // ロングプレス検出タイマー
let suppressNextZoneClick = false; // ロングプレス後のclick抑制フラグ
let thinViewerSeat = null; // シンクライアント(play.html)の視点席。手札ドックを常に自分側にする

// --------------------------------------------------------------------------
// 乱数のシード化（B1）
// RNG の内部状態は必ず state の中に置く（state.rngSeed / state.rngCounter）。理由: state は
// 権威サーバの部屋スナップショット永続化・deepClone・engine-host の setState/viewFor で JSON 往復する。
// RNG 位置をモジュールスコープのクロージャに持つと、サーバ再起動→部屋復元の直後に RNG が巻き戻り、
// 以降のシャッフル結果が保存前と食い違う。そこでカウンタベースPRNG（(seed, counter) だけで次値が決まる
// ステートレス実装）を使い、状態を数値2個に抑えて JSON セーフにする。
// シード未設定（従来経路＝tests/既存スモーク/ローカルの旧挙動）では Math.random に素通しし、
// 既存挙動を完全に維持する（後方互換絶対）。
// --------------------------------------------------------------------------

// 32bit uint へ正規化する（null は「シード無し＝素通し」を表す）。
function normalizeRngSeed(value) {
  if (value == null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric >>> 0 : null;
}

// 記録用シードの生成。種そのものは Math.random ベースでよい（種は決定論の対象外＝記録するための値）。
// 生成後は state.rngSeed に載り、リプレイ／不具合報告時にユーザーが貼れる。
function generateRngSeed() {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

// mulberry32 を (seed, counter) だけで評価するステートレス版。mulberry32(seed) を counter 回
// 呼んだ時の出目と一致する（内部の加算状態を seed + counter*step で再構成する＝クロージャ状態ゼロ）。
function mulberry32At(seed, counter) {
  let a = (seed + Math.imul(counter, 0x6d2b79f5)) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// [0,1) の乱数。シード未確立時は Math.random に素通し（＝既存挙動不変）。
// シードがあれば state.rngCounter を1つ進めて決定的な値を返す。
function rngNext() {
  if (!state || state.rngSeed == null) {
    return Math.random();
  }
  state.rngCounter = (state.rngCounter + 1) >>> 0;
  return mulberry32At(state.rngSeed >>> 0, state.rngCounter);
}

// [0, maxExclusive) の整数（Fisher-Yates 等）。maxExclusive<=0 は 0。
function rngInt(maxExclusive) {
  if (!(maxExclusive > 0)) {
    return 0;
  }
  return Math.floor(rngNext() * maxExclusive);
}

// シードを載せ直す（state 必須。counter は 0 から）。null を渡すとシード解除＝素通しに戻す。
function setRngSeed(seed) {
  if (!state) {
    return;
  }
  state.rngSeed = normalizeRngSeed(seed);
  state.rngCounter = 0;
}


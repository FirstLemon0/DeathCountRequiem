// 権威サーバ用 エンジンホスト（headless）。
// 既存ブラウザエンジン(src/01-*.js〜21-*.js)を vm + DOMスタブで読み込み、
// サーバ側で「ロボットユーザー」として駆動する。effects-regression.test.js と同方式。
// 1ルーム = 1エンジンインスタンス（独立 vm context / 独立 state）。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");

// src/ を番号順に連結（旧 app.js 相当）。
function buildEngineSource() {
  return fs
    .readdirSync(srcDir)
    .filter((name) => /^\d+-.*\.js$/.test(name))
    .sort()
    .map((name) => fs.readFileSync(path.join(srcDir, name), "utf8"))
    .join("\n");
}

// DOM要素スタブ（テストハーネスと同等。.value/.textContent/.innerHTML/.dataset は可変）。
function dummyElement() {
  return {
    addEventListener() {},
    append() {},
    appendChild() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    close() {},
    dataset: {},
    disabled: false,
    innerHTML: "",
    open: false,
    options: [],
    querySelector() {
      return dummyElement();
    },
    querySelectorAll() {
      return [];
    },
    removeEventListener() {},
    select() {},
    setAttribute() {},
    showModal: undefined,
    style: {},
    textContent: "",
    value: "",
  };
}

// loadJson(path) は fetch(path,{cache}) → .json()。data/ をFSから返すスタブ。
function makeFsFetch() {
  return function fsFetch(reqPath) {
    const rel = String(reqPath).replace(/^[./]+/, "");
    const file = path.join(root, rel);
    const exists = fs.existsSync(file);
    return Promise.resolve({
      ok: exists,
      async json() {
        return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
      },
    });
  };
}

// カスタムデッキはクライアントから受け取る想定。ここでは渡された配列を localStorage 経由で供給。
function makeLocalStorage(customDecks) {
  const store = new Map();
  if (Array.isArray(customDecks) && customDecks.length > 0) {
    store.set("buddyfight.customDecks.v1", JSON.stringify(customDecks));
  }
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

// エンジンを1インスタンス起動し、サーバ駆動APIを返す。
function createEngineContext({ customDecks = [], onServerPrompt = null } = {}) {
  const context = {
    __BUDDYFIGHT_SERVER__: true,
    console,
    crypto: {
      randomUUID: () =>
        `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    },
    fetch: makeFsFetch(),
    document: {
      body: { classList: { add() {}, remove() {}, toggle() {} } },
      createElement() {
        return dummyElement();
      },
      querySelector() {
        return dummyElement();
      },
      querySelectorAll() {
        return [];
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: makeLocalStorage(customDecks),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: {
      confirm: () => true,
      // TODO(P1 後続): 選択ダイアログ/じゃんけん等は現状サーバ側で自動解決（先頭選択）。
      // 本来はアクティブ/応答プレイヤーのクライアントへ往復させる（プロンプト round-trip）。
      prompt: () => "1",
      location: { origin: "http://server.local", pathname: "/netplay.html", search: "" },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener() {},
    },
  };
  // 権威サーバのプロンプト往復フック。エンジンの chooseCardEntries 等が
  // globalThis.__serverPrompt(request) を await する。未設定時は window.prompt/confirm の自動解決にフォールバック。
  if (typeof onServerPrompt === "function") {
    context.__serverPrompt = (request) => onServerPrompt(request);
  }
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(buildEngineSource(), context, { filename: "buddyfight-engine.js" });
  const api = context.__buddyfightServerApi;
  if (!api) {
    throw new Error("__buddyfightServerApi が公開されていません（__BUDDYFIGHT_SERVER__ 分岐を確認）");
  }
  return { context, api };
}

// 非公開ゾーン（山札・ゲージ・相手手札・場のソウル）を枚数のみに伏せる。
function hiddenPile(arr) {
  return (arr || []).map(() => ({ hidden: true }));
}
// 面伏せカード（伏せ魔法）の表示用プレースホルダ。中身（名前/効果）は秘匿。
function faceDownCard(card) {
  return {
    name: "（セット）",
    type: "spell",
    currentType: "spell",
    instanceId: card?.instanceId,
    faceDown: true,
    soul: [],
  };
}

// Z13(S-UB-C03/0066他): 場の裏向きモンスター(faceDownMonster:true)の表示用プレースホルダ。
// 上書き後のステータス(power/defense/critical/size)のみ見せ、名前/属性/ルール文は秘匿する。
// 既存bt02-0035（電子式神）にも同型のリークがあり、この一般化で同時に直る（挙動追加のみ・後方互換）。
// 自席も含め常にマスクする（公式上も裏向きトークンの表は出した本人も見ない読みのため統一する）。
function faceDownMonsterCard(card) {
  return {
    name: "（裏向き）",
    type: "monster",
    currentType: "monster",
    instanceId: card?.instanceId,
    faceDownMonster: true,
    size: card?.size,
    power: card?.power,
    defense: card?.defense,
    critical: card?.critical,
    attributes: [],
    keywords: [],
    used: card?.used,
    soul: hiddenPile(card?.soul),
  };
}

// 1ルームのゲームインスタンス。
class GameRoom {
  constructor(options = {}) {
    // options.onPrompt を createEngineContext の onServerPrompt へ明示ブリッジ
    // （キー名が違うため素通しだと黙って null に落ち自動解決へ退行する）。
    const { api } = createEngineContext({
      customDecks: options.customDecks,
      onServerPrompt: options.onPrompt,
    });
    this.api = api;
    this.started = false;
    // 直近に applyAction を呼んだ席（プロンプト往復の既定の宛先＝手番プレイヤー）。
    this.actingSeat = null;
  }

  async loadData() {
    await this.api.loadGameData();
    return this.api.getDeckProfiles().map((d) => ({ id: d.id, name: d.name, productName: d.productName }));
  }

  // deckIds: [seat0, seat1] のデッキID（プリセット/カスタム問わず deckProfiles に存在するID）。
  startGame(deckIds = []) {
    const profiles = this.api.getDeckProfiles();
    const pick = (i) => (deckIds[i] && profiles.some((d) => d.id === deckIds[i]) ? deckIds[i] : profiles[i]?.id);
    this.api.elements.p1DeckSelect.value = pick(0) || profiles[0]?.id || "";
    this.api.elements.p2DeckSelect.value = pick(1) || profiles[1]?.id || profiles[0]?.id || "";
    this.api.newGame();
    this.started = true;
    return this.api.getState();
  }

  // seat の操作を適用。type と params(selected/attackTarget/effectTarget/callZone)。
  async applyAction(seat, type, params = {}) {
    // この操作の主体席を記録（往復プロンプトの既定の宛先解決に使う）。
    this.actingSeat = seat;
    const a = this.api.actions;
    // 入力（DOM相当）をスタブへ供給
    if (Object.prototype.hasOwnProperty.call(params, "selected")) {
      this.api.setSelected(params.selected);
    }
    // params に含まれない攻撃/効果対象は毎回 '' にリセットする。ブラウザは新カード選択時に
    // effectTarget を空へクリアする(20-ui-touch.js handCardMenuLocal/fieldCardMenuLocal)が、
    // サーバの applyAction はその経路を通らないため、明示供給しない限り前アクションの対象が
    // 残留し、targetForAbilityUse が残留値を新カードの target spec と照合して未選択の相手へ
    // 効果/攻撃を撃つ。供給値で毎回上書きしてブラウザのカード選択時クリアと挙動を揃える。
    this.api.elements.attackTarget.value = Object.prototype.hasOwnProperty.call(params, "attackTarget")
      ? (params.attackTarget ?? "")
      : "";
    this.api.elements.effectTarget.value = Object.prototype.hasOwnProperty.call(params, "effectTarget")
      ? (params.effectTarget ?? "")
      : "";
    const dispatch = {
      draw: a.drawAction,
      charge: a.chargeAction,
      main: a.goMainPhase,
      attackPhase: a.goAttackPhase,
      finalPhase: a.goFinalPhase,
      call: () => a.callMonster(params.callZone),
      use: a.useCardAction,
      attack: a.attackAction,
      endTurn: a.endTurn,
      buddy: a.partnerCall,
      link: a.toggleLinkAttacker,
      resolve: a.resolvePendingResolution,
      counterHand: a.toggleCounterHand,
    };
    const fn = dispatch[type];
    if (!fn) {
      throw new Error(`未知のアクション: ${type}`);
    }
    await fn();
    return this.api.getState();
  }

  // 役割別の伏せ字 view。role: 0 | 1 | "spectator"。
  // role: 0 | 1 | "spectator"。隠しゾーンを役割別に伏せ字化する。
  viewFor(role) {
    const state = this.api.getState();
    const view = JSON.parse(JSON.stringify(state));
    // 内部診断データは全状態スナップショット（両者の手札名等）を含むためクライアントへ送らない。
    delete view.diagnosticLog;
    delete view.diagnosticSeq;
    const spectator = role === "spectator";
    const seat = spectator ? null : Number(role);
    view.players.forEach((player, index) => {
      // 山札の順序は誰も知らない（サーバでシャッフル）。全ロールで枚数のみ。
      player.deck = hiddenPile(player.deck);
      const own = index === seat;
      if (!spectator && !own) {
        // 相手の非公開ゾーン: 手札・ゲージ(face-down)・伏せ魔法・場のソウル
        player.hand = hiddenPile(player.hand);
        player.gauge = hiddenPile(player.gauge);
        for (const zone of ["set1", "set2"]) {
          if (player.field[zone]) {
            player.field[zone] = faceDownCard(player.field[zone]);
          }
        }
        for (const zone of ["left", "center", "right", "item"]) {
          const card = player.field[zone];
          if (card && Array.isArray(card.soul) && card.soul.length) {
            card.soul = hiddenPile(card.soul);
          }
        }
      }
      // Z2(S-UB-C03/0095他・公式裁定Q2629/Q2630): バディゾーンの裏向きカードは所有者本人のみ表を見られる。
      // 相手席からは常に伏せる。観戦系ロールは手札より厳格に扱い、両者とも常に伏せる
      // （spectatorはown判定が常にfalseになる既存構造上の帰結として、!own を満たせば自動的に対象になる）。
      if (spectator || !own) {
        player.buddyZoneFaceDown = hiddenPile(player.buddyZoneFaceDown);
      }
      // Z13(S-UB-C03/0066他): 場の裏向きモンスター(faceDownMonster:true)は誰から見てもマスクする
      // （自席も含む。既存bt02-0035の同型リークもこれで同時に直る）。
      for (const zone of ["left", "center", "right"]) {
        const card = player.field[zone];
        if (card?.faceDownMonster) {
          player.field[zone] = faceDownMonsterCard(card);
        }
      }
    });
    if (!spectator) {
      view.viewerSeat = seat;
    }
    return view;
  }
}

module.exports = { GameRoom, createEngineContext };

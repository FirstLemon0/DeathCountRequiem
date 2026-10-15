// 権威サーバ用 エンジンホスト（headless）。
// 既存ブラウザエンジン(src/01-*.js〜21-*.js)を vm + DOMスタブで読み込み、
// サーバ側で「ロボットユーザー」として駆動する。effects-regression.test.js と同方式。
// 1ルーム = 1エンジンインスタンス（独立 vm context / 独立 state）。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { engineVersion } = require("./engine-version");

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
// loadJson はキャッシュ運用のため ?v=<version> 付きURLを投げてくる（__BUDDYFIGHT_DATA_VERSION 定義時）。
// FS読込ではクエリを落とさないとファイルが見つからず loadData が落ちるので、先頭で ? 以降を除去する。
function makeFsFetch() {
  return function fsFetch(reqPath) {
    const rel = String(reqPath).split("?")[0].replace(/^[./]+/, "");
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
    // loadJson の ?v= キャッシュ経路をサーバ側でも通す（＝実ローダと同じコードパスを検証する）。
    // FS読込ではクエリは makeFsFetch が落とすので値は任意でよい。
    __BUDDYFIGHT_DATA_VERSION: "engine-host",
    // リプレイ記録へ刻むエンジン版（src/23 replayStartRecording）。正は index.html の ENGINE_VERSION（server/engine-version.js）。
    __BUDDYFIGHT_ENGINE_VERSION: engineVersion(),
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
    // R1: リプレイの順序配信（src/23 replayMacrotask）が macrotask 境界へ譲るのに使う（無ければ setTimeout(0)）。
    setImmediate,
    clearImmediate,
    window: {
      confirm: () => true,
      // 選択ダイアログ/じゃんけん/任意能力ゲート等は onServerPrompt（__serverPrompt）経由で該当席の
      // クライアントへ往復させる（authoritative-server の dispatchPrompt → /prompt 応答）。window.prompt/confirm は
      // その往復フックを持たない文脈（単体スモーク等）と、宛先席が不在/未接続の時の既定値フォールバックのみ。
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

// rule-call-11: 設置魔法の枠名（"set1","set2","set3",…）。エンジン側 isSetZone と同じ判定（vm 外で使うため複製）。
function isSetZoneKey(zone) {
  return typeof zone === "string" && /^set[1-9][0-9]*$/.test(zone);
}

// pt-fix-c T7-4: アイテム枠も可変長（"item5","item6",…）。エンジン側 isItemZone の 5 以降と同じ判定。
function isDynamicItemZoneKey(zone) {
  return typeof zone === "string" && /^item([5-9]|[1-9][0-9]+)$/.test(zone);
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
    // R1/R7: 往復プロンプトの in-flight 数を数える（誘発チェーンが静止するまで applyAction を返さないため）。
    this.promptsInFlight = 0;
    this.promptWaiters = [];
    const onPrompt =
      typeof options.onPrompt === "function" ? (request) => this.trackPrompt(options.onPrompt(request)) : options.onPrompt;
    const { context, api } = createEngineContext({
      customDecks: options.customDecks,
      onServerPrompt: onPrompt,
    });
    this.context = context;
    this.api = api;
    this.started = false;
    // 直近に applyAction を呼んだ席（プロンプト往復の既定の宛先＝手番プレイヤー）。
    this.actingSeat = null;
    // B2: リプレイ記録。true の時 startGame で記録を開始し、applyAction 境界を step として刻む。
    this.recordReplay = Boolean(options.record);
    // startGame の入力（seed は下で確定済み）を記録メタとして保持する。
    this.customDecks = Array.isArray(options.customDecks) ? options.customDecks : [];
    this.replayDeckIds = null;
    this.replayFirstSeat = null;
    // B1: 乱数シードを state に固定して部屋復元／リプレイを決定化する（省略時は生成）。
    // seed は state.rngSeed に載り、部屋スナップショットに含まれて再起動をまたいで復元される。
    this.seed =
      options.seed != null ? options.seed >>> 0 : Math.floor(Math.random() * 0x100000000) >>> 0;
  }

  // R1/R7: 往復プロンプトの Promise を in-flight として数える（解決/失敗で減らし待機者を起こす）。
  trackPrompt(promise) {
    this.promptsInFlight += 1;
    const settle = () => {
      this.promptsInFlight = Math.max(0, this.promptsInFlight - 1);
      const waiters = this.promptWaiters;
      this.promptWaiters = [];
      waiters.forEach((resolve) => resolve());
    };
    return Promise.resolve(promise).then(
      (value) => {
        settle();
        return value;
      },
      (error) => {
        settle();
        throw error;
      },
    );
  }

  // R1/R7: 操作本体の解決後、遅延実行の誘発チェーン（battleEnd 等の Promise.resolve().then）が静止するまで待つ。
  // 静止＝microtask が走り切り（macrotask 境界）、未応答の往復プロンプトも記録/再生上の未配信プロンプトも 0。
  // これにより (1) チェーン中の応答も同じ step に記録され（リプレイの決定性）、(2) authoritative-server の
  // /action 後処理（broadcastView / persistNow / maybeRecordMatch）がチェーン完了後の局面で走る
  // （チェーンの /prompt 応答で局面が変わっても配信・保存・戦績が取りこぼされない＝R7）。
  async waitQuiescent() {
    for (;;) {
      if (typeof this.context.replayWaitQuiescent === "function") {
        await this.context.replayWaitQuiescent();
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (this.promptsInFlight === 0) {
        return;
      }
      await new Promise((resolve) => this.promptWaiters.push(resolve));
    }
  }

  async loadData() {
    await this.api.loadGameData();
    return this.api.getDeckProfiles().map((d) => ({ id: d.id, name: d.name, productName: d.productName }));
  }

  // deckIds: [seat0, seat1] のデッキID（プリセット/カスタム問わず deckProfiles に存在するID）。
  // options.firstSeat: 0|1|"random"（省略時 seat0＝既存スモークは不変）。
  startGame(deckIds = [], options = {}) {
    const profiles = this.api.getDeckProfiles();
    const pick = (i) => (deckIds[i] && profiles.some((d) => d.id === deckIds[i]) ? deckIds[i] : profiles[i]?.id);
    this.api.elements.p1DeckSelect.value = pick(0) || profiles[0]?.id || "";
    this.api.elements.p2DeckSelect.value = pick(1) || profiles[1]?.id || profiles[0]?.id || "";
    this.replayDeckIds = [pick(0) || null, pick(1) || null];
    this.replayFirstSeat = options.firstSeat != null ? options.firstSeat : null;
    this.api.newGame({ seed: this.seed, firstSeat: options.firstSeat });
    this.started = true;
    // B2: 記録モードなら newGame 確定直後に記録を開始する（初期状態はメタとして持ち、以降を step 化）。
    if (this.recordReplay) {
      this.api.replayStartRecording({
        seed: this.seed,
        firstSeat: this.replayFirstSeat,
        deckIds: this.replayDeckIds,
        customDecks: this.customDecks,
      });
    }
    // シードは対戦ログ(state.log)へは載せない（両席へ配信され先読みされる）。運用者は stdout で追う。
    console.log(`[engine-host] 乱数シード: ${this.seed}`);
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
    // F10: dispatch は素のオブジェクトなので dispatch["toString"]/["constructor"]/["__proto__"] が
    // Object.prototype から引けてしまい、未知アクションが受理されリプレイ step にも刻まれていた。
    // 自前プロパティのみ受理し、replayBeginStep より前に弾く。
    if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(dispatch, type)) {
      throw new Error(`未知のアクション: ${String(type).slice(0, 40)}`);
    }
    // R3: 操作入力の形を受理前に検査する（selected.owner:7 等でエンジン内部が TypeError を投げ、
    // 「投げた step」が記録に残って保存済みリプレイが必ずそこで失敗する事故を入口で断つ）。
    const invalid =
      typeof this.context.replayValidateActionParams === "function"
        ? this.context.replayValidateActionParams(params)
        : null;
    if (invalid) {
      throw new Error(`不正な操作入力: ${invalid}`);
    }
    const fn = dispatch[type];
    // B2: このアクションを1 step として刻む。プロンプト応答は chooseCardEntries seam が
    // 要求時に開いている step へ溜める（R1）。例外時も step を確定させるため finally で閉じる（記録オフなら no-op）。
    // R1/R7: step を閉じる前に誘発チェーンの静止を待つ。R3: 例外で終わった step には threw 印を付ける。
    this.api.replayBeginStep(seat, type, params);
    let threw = false;
    try {
      await fn();
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      await this.waitQuiescent();
      this.api.replayEndStep({ threw });
    }
    // D5(戦績): アクション解決後の整合局面で決着を確定させる（state.matchResult に一度だけ載る）。
    // authoritative-server はこの後 getState().matchResult を読んで席別ユーザーに戦績を記録する。
    // 記録オフでも state を stamp するだけで害はない（決定論・冪等）。復元対戦でも matchResult は正しく載る。
    if (typeof this.api.matchRecordCheckpoint === "function") {
      this.api.matchRecordCheckpoint();
    }
    return this.api.getState();
  }

  // rule-counter-5: 非ターン席(seat≠active)が、保留(攻撃/行動の対抗窓)の無い局面で今この選択を【対抗】として
  // 使えるか。ver2.05 ②プレイタイミング／【対抗】の流れ 6.: 非ターンファイターは【対抗】を持つカード/能力（手札・場・
  // ドロップ・ソウルを問わない）を使えるが、それ以外（コール/装備/通常魔法/【対抗】無しの【起動】/フェイズ進行等）は不可。
  // 判定はエンジン自身の探索関数（useCardAction が実際に通る経路と同じ finder）に委ね、サーバでルールを複製しない。
  // state は変更しない（finder が読む state.selected だけ一時的に差し替えて必ず戻す）。
  canUseOffTurnCounter(seat, params = {}) {
    const ctx = this.context;
    const state = this.api.getState();
    if (!state || state.winner || state.pendingAttack || state.pendingAction) return false;
    if (seat !== 0 && seat !== 1) return false;
    if (seat === state.active) return false; // 手番席は通常の可否判定（canActorActNow）側で扱う
    const sel = params?.selected;
    if (!sel || typeof sel !== "object" || sel.owner !== seat) return false;
    if (!["hand", "field", "drop"].includes(sel.source)) return false;
    if (typeof ctx.isCounterPlayTiming !== "function" || !ctx.isCounterPlayTiming()) return false;
    const prevSelected = state.selected;
    try {
      state.selected = { ...sel };
      const card = ctx.getSelectedCard();
      if (!card) return false;
      if (sel.source === "hand") {
        return Boolean(ctx.findUsableHandAbility(card, { counterOnly: true }));
      }
      const abilities =
        sel.source === "drop" ? ctx.findUsableDropAbilities(card, seat) : ctx.findUsableFieldAbilities(card, seat);
      return abilities.some((ability) => ctx.isCounterAbility(ability));
    } catch (_error) {
      return false; // 判定不能は不許可側へ倒す
    } finally {
      state.selected = prevSelected;
    }
  }

  // B2: 記録済みリプレイ（JSONセーフな複製）を取り出す。B3（保存・共有URL）はこれを持ち回る。
  getRecording() {
    return this.api.replayGetRecording();
  }

  // 投了（オンライン対戦の退出/切断で片側から強制決着させる）。loserSeat の相手を勝者に確定させ、
  // エンジンの matchDeclareForfeit が matchRecordCheckpoint まで走らせるので、この後サーバは
  // getState().matchResult を読んで席のログインユーザーへ戦績を記録できる。
  // winner/winnerSeat/winReason は単一 seat から導出されるため名前↔席のズレは起きない。
  declareForfeit(loserSeat) {
    if (typeof this.api.matchDeclareForfeit !== "function") {
      return null;
    }
    return this.api.matchDeclareForfeit(loserSeat);
  }

  // 役割別の伏せ字 view。role: 0 | 1 | "spectator"。
  // role: 0 | 1 | "spectator"。隠しゾーンを役割別に伏せ字化する。
  viewFor(role) {
    const state = this.api.getState();
    const view = JSON.parse(JSON.stringify(state));
    // 内部診断データは全状態スナップショット（両者の手札名等）を含むためクライアントへ送らない。
    delete view.diagnosticLog;
    delete view.diagnosticSeq;
    // B1: 乱数の内部位置はクライアントへ出さない。露出すると以降のシャッフル/ドローを先読みできてしまう。
    delete view.rngSeed;
    delete view.rngCounter;
    const spectator = role === "spectator";
    const seat = spectator ? null : Number(role);
    view.players.forEach((player, index) => {
      // 山札の順序は誰も知らない（サーバでシャッフル）。全ロールで枚数のみ。
      player.deck = hiddenPile(player.deck);
      const own = index === seat;
      if (!spectator && !own) {
        // 相手の非公開ゾーン: 手札・ゲージ(face-down)。場のソウルは表向きなら公開情報（MR17-1）。
        player.hand = hiddenPile(player.hand);
        player.gauge = hiddenPile(player.gauge);
        // 配置魔法(『設置』)は神以前ルールでは表向き＝両者に公開が基本。無条件で伏せると相手から中身が
        // 見えなくなるバグになる。実際に faceDown フラグが立ったカード（将来の裏向き設置カード等）だけ伏せる
        // （通常の設置魔法は faceDown を持たないため、そのまま名前・効果が相手に見える）。
        // rule-call-11: 設置魔法の枠は可変長（set1, set2, set3, …）。field に在る setN キーを全て見る。
        for (const zone of Object.keys(player.field || {}).filter(isSetZoneKey)) {
          if (player.field[zone] && player.field[zone].faceDown === true) {
            player.field[zone] = faceDownCard(player.field[zone]);
          }
        }
        // MR17-1: 場のソウルはここでは伏せない。ver2.05 p.24「特に指示がない限り、ソウルには表向きに
        // カードが置かれます」「他のファイターの**裏向きの**ソウルの内容を見ることはできません」＝
        // 表向きソウルは公開情報で、相手も中身を見られる（ローカル対戦のUIも「相手のカードのソウルも
        // 中身を確認できます」で一致）。以前はここで soul 全体を hiddenPile しており、ネット対戦だけ
        // 相手のソウルガード枚数や星合体の中身が見えず、攻撃可否の判断材料が落ちていた。
        // 裏向き札の秘匿は下の !own ブロック（観戦ロールと同一処理）が担う。
      }
      // E-Y1(X-BT01 奇襲): 裏向き(faceDown)でソウルに入った札は所有者本人のみ表を見られる。
      // 相手席・観戦ロールとも face-down 札だけを個別に伏せ、face-up ソウルは公開のまま見せる
      // （ver2.05 p.24。MR17-1 で相手席の一律 hiddenPile を廃止し、両ロールをこの1経路に統一した）。
      if (!own) {
        // rule-call-11: 設置魔法（setN）に載ったソウルの裏向き札も同様に伏せる（表向きは公開のまま）。
        const soulHostZones = ["left", "center", "right", "item", "item2", "item3", "item4", ...Object.keys(player.field || {}).filter(isDynamicItemZoneKey), ...Object.keys(player.field || {}).filter(isSetZoneKey)];
        for (const zone of soulHostZones) {
          const card = player.field[zone];
          if (card && Array.isArray(card.soul) && card.soul.length) {
            card.soul = card.soul.map((soulCard) =>
              soulCard && soulCard.faceDown ? { hidden: true } : soulCard,
            );
          }
        }
      }
      // Z2(S-UB-C03/0095他・公式裁定Q2629/Q2630): バディゾーンの裏向きカードは所有者本人のみ表を見られる。
      // 相手席からは常に伏せる。観戦系ロールは手札より厳格に扱い、両者とも常に伏せる
      // （spectatorはown判定が常にfalseになる既存構造上の帰結として、!own を満たせば自動的に対象になる）。
      if (spectator || !own) {
        player.buddyZoneFaceDown = hiddenPile(player.buddyZoneFaceDown);
      }
      // E-XB54a(X-UB03/0019 ∞ the Chaos ∞): フラッグの下に裏向きで置く控えフラッグ(flagReserve)は所有者本人のみ
      // 中身を見られる。相手/観戦へは hiddenPile で「存在のみ・中身伏せ」（buddyZoneFaceDown と同じ扱い）。
      // 中身は seed 非依存の決定的セットアップ物＝T13 のシード漏洩とは無関係だが、裏向き控え札の忠実な秘匿として伏せる。
      // 既存の全対戦では flagReserve は空配列＝hiddenPile([]) も空配列で view は不変（後方互換・T13 影響なし）。
      if (spectator || !own) {
        player.flagReserve = hiddenPile(player.flagReserve);
      }
      // Z13(S-UB-C03/0066他): 場の裏向きモンスター(faceDownMonster:true)は誰から見てもマスクする
      // （自席も含む。既存bt02-0035の同型リークもこれで同時に直る）。
      for (const zone of ["left", "center", "right", "item", "item2", "item3", "item4", ...Object.keys(player.field || {}).filter(isDynamicItemZoneKey)]) {
        const card = player.field[zone];
        if (card?.faceDownMonster) {
          player.field[zone] = faceDownMonsterCard(card);
        }
      }
    });
    // MR18-1: state.selected（いま選択中のカード）は本来そのプレイヤーのUI状態で、view には
    // 「誰が何を選んでいるか」がそのまま載る。相手が手札のカードを選んだ瞬間、その instanceId が
    // 相手席の view に流れ、まだ公開されていない手札札の識別子が漏れていた（実測: view.selected.instanceId）。
    // instanceId はシード確立時に配布順の連番（c1,c2,…）なので、識別子だけでも山札位置の手掛かりになる。
    // 場・ドロップ・フラッグの選択は公開情報なのでそのまま見せ、非公開ゾーン（手札・山札・ソウル）の
    // 選択は「選択中であること」だけ残して中身を伏せる（相手が操作中である合図としては有用なため）。
    const HIDDEN_SELECT_SOURCES = new Set(["hand", "deck", "soul"]);
    if (view.selected && view.selected.owner !== seat && HIDDEN_SELECT_SOURCES.has(view.selected.source)) {
      view.selected = { owner: view.selected.owner, source: view.selected.source, hidden: true };
    }
    if (!spectator) {
      view.viewerSeat = seat;
    }
    return view;
  }
}

// B2: 記録（recording）から headless で対戦を再現する。
// 1) seed/firstSeat/デッキで newGame → 2) steps を順に適用し、各 step の間 chooseCardEntries を
//    「記録された selectedIndexes を順に返す」再生キューに差し替える → 3) 最終 state を返す。
// step ごとに応答キューを入れ替え、適用後に未消費応答が残っていれば失敗させる（記録過多を検出）。
// 応答不足は chooseCardEntries seam（replayNextSelection）が投げる。どちらでも「黙って別の対戦」にならない。
async function replayGame(recording) {
  if (!recording || typeof recording !== "object") {
    throw new Error("リプレイ: recording が不正です");
  }
  const room = new GameRoom({ seed: recording.seed, customDecks: recording.customDecks || [] });
  await room.loadData();

  const drain = (label) => {
    const remaining = room.api.replayPlaybackRemaining();
    if (remaining > 0) {
      throw new Error(`リプレイ: ${label} で記録された応答が余りました（${remaining}件・記録過多）`);
    }
  };

  // 版の照合（旧版の記録は再生しない）は呼び元（authoritative-server の GET /replay・replay.html）が行う。
  room.context.replayBeginPlayback();
  // newGame(配牌)中の選択（通常は空）。setup 中もキューを立てておき、想定外の選択要求を即検出する。
  room.api.replaySetPlaybackQueue(recording.setupResponses || []);
  room.startGame(recording.deckIds || [], { firstSeat: recording.firstSeat });
  drain("newGame(setup)");

  const steps = Array.isArray(recording.steps) ? recording.steps : [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    room.api.replaySetPlaybackQueue(step.promptResponses || []);
    try {
      await room.applyAction(step.seat, step.type, step.params || {});
    } catch (error) {
      // R3: 記録時にも例外で終わった step（threw 印）は同じく投げるのが正しい再現。それ以外は失敗。
      if (!step.threw) {
        throw error;
      }
    }
    drain(`step#${index}(${step.type})`);
  }
  room.api.replayClearPlayback();
  return room.api.getState();
}

module.exports = { GameRoom, createEngineContext, replayGame };

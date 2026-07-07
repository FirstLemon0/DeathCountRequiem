# REVIEW_MAP — 今回のレビューで修正したバグの修正マップ（再レビュー用）

対象: バディファイト再現アプリ（Vanilla JS, `src/01`〜`src/21` を番号順連結・グローバルスコープ共有）。ルールは2018年6月以前(ver2.05)固定。
本ファイルは**今回のArtifactに載っていて実際に修正した項目のみ**を、`修正内容 / 妥当性チェック / 意図` の3点で圧縮したもの。未修正・誤検出は載せない。
再レビュー観点: (a)修正が公式ルール上正しいか (b)妥当性チェックが十分か (c)副作用・見落としが無いか。

---

## 0. 全修正に共通の検証手法（前提）
- **normcheck**: カードの op を正規化して dispatch モジュール(04/05/09/10/11/13/14/15/18)に存在するか照合。「正規化失敗0・未知op0」を全修正で確認。
- **回帰テスト** `tests/effects-regression.test.js`: `src/` 全連結を vm 実行。方針=**実操作経路を通す**（`useCardAction`/`callMonster`/`executeAbilityBody`/`destroyFieldCard`/`resolvePendingResolution`/`applyDamageToPlayer` 等）。期待出力 `effects regression ok`。各修正にテストを追加。
- **敵対的レビュー**: 別エージェント群で適用後の副作用を探索→検出したものを手当て（本文中★で明示）。
- **公式Q&A/裁定照合**: 該当時（連携攻撃・大首領アンノウンQ827/Q824 等）。

---

## 1. エンジン共通バグ（高優先度13 + ルート原因R1〜R10）

| # | 修正内容 | 妥当性チェック | 意図/ルール根拠 |
|---|---|---|---|
| 複数payGaugeコスト | コスト判定を**累積**に(src/04)。半額以下で無償/踏み倒し使用を防止 | 回帰8本 | 複数ゲージ要求の合計を払えないと使用不可が正 |
| 1ターン1回のクリア | ターン境界で両プレイヤー分クリア(src/11)。相手ターンの【対抗】使用が自ターンへ持ち越さない | 回帰 | 「1ターンに1回」は各ターンで独立 |
| R2 1ターン1回の粒度 | limit.key を**カードインスタンス単位**に分離(src/15)。同名2枚が各1回誘発。spell/impact/手札発動はbase維持 | 回帰 | 別個体は別制限 |
| 連携攻撃バウンス | 連携中に攻撃側1枚がバウンスされても残り1枚で続行(src/10) | **公式Q&A準拠**（「連携ではなくなるが残った1枚が攻撃」） | 公式裁定 |
| R1 ターン持続バフ | duration未指定の反撃/攻防バフを turnKeywords に載せ、最初のバトル終了で失効しないよう修正(src/14,15) | 回帰 | 「そのターン中」付与はターン終了まで持続 |
| R4 全体攻撃の本体 | 「相手のモンスター全てと相手に攻撃」に**ファイター本体ダメージ**を追加(src/09,10, 全滅時も本体継続) | 回帰 | アジ・ダハーカ等の本体打撃 |
| R5 破壊のdrop代用 | dropOwnMonster 代用を**実破壊化**(destroyOwnMonster excludeSource / 新op destroySource) | 回帰 | 破壊イベント/ソウルガード/ライフリンクを正しく発火させるため |
| R6 破壊原因条件 | 新op `eventDestroyCauseMatches` + 自身destroyed誘発へ cause 伝播(src/11,13)。★cause伝播漏れ(主経路)を敵対的レビューで検出→修正 | 回帰(実破壊経路) | 「効果で/相手のカードで破壊された時」の限定 |
| R8 setLifeコスト | setLife をコスト支払い分岐に追加(src/04)。無償使用を防止 | 回帰 | コスト未対応opの黙殺を解消 |
| R10 同名自己バフ | 名前一致の continuous を `sameInstanceAsSource` 化(bt02-0024/0025)。同名2枚の二重強化を解消 | 回帰 | 自己バフは自分のみ |
| 権威サーバ解決権 | 攻撃/効果の「解決」を**対抗担当席(防御側/応答側)のみ**に限定 | サーバは実機検証ユーザー時のみ（静的確認） | 攻撃側による対抗窓スキップ防止 |
| ブーメラン系 | 手札戻り時に一時状態(used/戦闘・ターン修整/付与KW/変身)を `resetLeftFieldCardState` でリセット。全手札戻し経路に適用 | 実操作経路(battleEnd誘発)回帰 | レスト持ち越しで再コール後に攻撃不可になる不整合を解消 |

---

## 2. エンジン新機構・新op（needs-engine）

各: **op名** — 修正内容 / 妥当性 / 意図。（回帰テスト＋normcheckは全件で実施済み、以下は個別要点）

- `lastDestroySucceeded`(条件) + destroy op が `context.lastDestroyed` に破壊成否を記録 — 「破壊し、そうしたら報酬」を**破壊成立時のみ**報酬（H-EB03/0015・BT04/0007・PP01/0033）。意図: ソウルガードで残った時に報酬を与えない。
- `destroyedCount`(amountFrom) — 実破壊数でダメージ(H-BT03/0020)。意図: 宣言数でなく実際に破壊できた数。
- `damageSelf`(コスト) / `discardSoulToDeckBottom`(コスト) — ダメージ扱いコスト/ソウルをデッキ下へ(H-BT03/0011・BT05/0008)。意図: rules文言に一致。
- `grantTurnDestroyImmunity` — ゾーン限定ターン破壊耐性(BT04/0049)。意図: 対抗の「このターン破壊されない」。
- `preventDrawByEffect`(継続) — 効果ドロー禁止(PP01/0006)。★ライフ0置換ドロー経路(src/11×2)にもガード適用。意図: 「相手は効果でドローできない」の網羅。
- `lockOwnSetThisTurn` — 設置ロック(H-EB01/0032)。
- `eventDestroyerMatches`(条件) — 破壊者フィルタ + destroyAll対応(H-EB02/0047)。
- `destroyAll{ignoreSoulguard/ignoreDestroyImmunity/nullifyAbilities}` — 大魔法ラグナロク(BT04/0032・S006・ss01-0030)。★nullifyAbilitiesが**非モンスターの味方破壊時誘発まで抑制**する過剰を敵対的レビューで検出→`queueAllyDestroyedTriggers`を suppress から分離。意図: 「場のモンスターの能力」だけ無効化。近似: 他モンスターの同種反応は発火し得る。
- `preventLifeGainByEffect`(継続, BT05/0083) — 相手のライフ回復禁止。★破壊置換gainLife(src/11×2)/eachPlayerTopDeck…Life(src/15)にもガード適用。
- `cardHasTriggeredListener`(bf-h-eb03-0020 ゲージ配置誘発の継承検出), `noDrawDamage`(ジャンケンあいこ, H-EB02/0063), `useTopDeckCard`任意化(BT02/0049), setPreventNextDestroyの**破壊回避成立時のみ**反撃付与(H-BT03/0036), endAttackPhaseが係属1回目攻撃を先解決(H-BT02/0095), item をバディに(canBeBuddy+バディギフト, pp01-0055/BT04/S007)。
- 角王 `deckAnyFlag`(非ホームフラッグでも使用可), `ownDropAttributeSumCountGte`を**和集合**カウント(両属性の二重計上解消), `continuousDropStatAmount`の`distinct`(「1種類につき」), `restSelf`を`restFieldCard`経由で「レストした時」誘発発火, 起動能力ゲートの`allowMissingTarget`尊重。

---

## 3. カード条件/フィルタ/データ修正（fixable 42 + LOW）

要点のみ（個別カードはファイル別に検証しつつ適用・normcheck・回帰済み）:
- **攻撃/被弾条件**: 「攻撃された時」を `pendingAttackDefenderIsSelf` だけでなく `pendingAttackByOpponentMonster`(攻撃者=モンスター)や `pendingAttackTargetIsSource`(このカードが対象)で適正化。過剰(自分の別カード攻撃で発動)/過少(センター空で左右を守れない)を是正。例: BT02/0065, TD05/0011(BT02/0065再録の取りこぼし), BT05/0008デスタリカ。
- **世界/サイズ/属性フィルタ**: `size`ベアキー→`sizeIn`/`sizeLte`(effectiveSize参照)へ。エンシェントW等の world 補完。★sizeベアキー未対応を敵対的レビューで検出→sizeIn化。BT05/0005を baseSize→sizeIn:[2](Secret版と統一)。
- **搭乗/変身の区別(#14/R9)**: 判別フィルタ `{mounted}` に `keyword:"ride"/"henshin"` を追加。★keyword未明記の旧カードが漏れる退行を敵対的レビューで検出→`normalizeCardDefinition`で ability id 規約(`-ride-*`/`-henshin-*`)から keyword を**自動補完**（体系的解消・誤検出0を確認）。
- **破壊のdrop代用是正**(destroyOwnMonster), **再コールのrules外「センター空」制限(emptyOnly)除去**+resolveOnEnter付与, 破壊者/ホスト/名称限定の補正(絶命陣ソウル限定・超絶命陣のnameIncludes緩和 等)。
- **useSelectedCardAbilityForScript が hostCard を伝播**(秘剣/忍法をソウルから使う時の hostMatches 判定)。
- **canAttackTargetValue の fighter 無条件true を廃止** — restrictAttackTargets を fighter にも適用(竜騎士スレイマンの攻撃不可)。

---

## 4. 個別カードの機構実装（実攻撃・勝利・救援・場残し）

- **BT04/0026 デスカース**（連携全体自壊）: 実行分岐 `setDelayedDestroy` に `target:"$attackers"` 対応(context.attackers反復)、カードを $attacker→$attackers。★過去2回リバートした難物。正規化(target有→when省略→turnEndOwner=攻撃者所有者)整合を確認。単体+連携2体の回帰。意図: 攻撃してきた全モンスターを破壊。
- **BT01/0074 チェック・メイト**（実攻撃勝利）: `winGame`直行→`declareAttackWithTarget(スタンドチェスで, forceTargetValue:"fighter", winOnFighterDamage:true)`。performAttackDeclaration に options→`pending.winOnFighterDamage`、resolveFighterAttack の2ダメージ経路に `applyWinOnFighterDamage`。意図: **相手の対抗窓を経て**ファイターにダメージを与えたら勝利（従来は条件だけ満たせば即勝利）。回帰(宣言→解決→勝利)。
- **BT04/0020 ナイトメア・ディスペアー**（強制自攻撃）: 新option `forceSelfAttack` — 「そのモンスターで相手(=そのモンスターの持ち主)を攻撃」。declareAttackWithFieldCardで**持ち主自身のファイター**へ攻撃、performAttackDeclarationで targetOwner=攻撃モンスターの持ち主。★以前 attackerSeat汎用化が**使用者自傷のHIGH回帰**を起こしリバート→今回 defender を正しく解決して再実装。回帰(攻撃者=B/防御=B/使用者無傷)。
- **デスタリカ 場残し**(BT05/0008・S009): `destroyReplacement{optional, conditions:sourceSoulCountGte3, cost:discardSoulToDeckBottom×3}`（既存 applyDestroyReplacement 機構=既定で場に残る）。近似: 破壊のみ対応、バウンス/ソウル送りは未対応。回帰(破壊→ソウル3デッキ下→場に残る)。
- **H-BT03/0006 バーンノヴァ 救援コール**（事前備え式）: 新effect op `preventAllDamageThisTurn`(addNextDamagePrevention preventAll+once:false, untilTurnOwner=相手ターンで持続→相手ターン終了で失効)。救援ability(kind:activated/fromHandOnly/timing:counter/条件turnOwnerIsOpponent, RD マッハブレイバーH-BT01/0018と同型)。script: callSelfFromHand(ゲージ3)→setLifeZeroSafeguard{life:1}→preventAllDamageThisTurn。★当初 effect op が `isScriptEffectStep` 許可漏れで**scriptが途中中断し防御未発火=自滅**を敵対的レビューで検出→許可リスト追加+**script経路を通す回帰**を追加。意図: コア(勝敗判定)を非同期化せず、既存のlifeZeroSafeguard/damagePreventionで「ライフ1据え置き+ダメージ無効」。近似=先撃ち(応答窓で予めセット)。

---

## 5. 対抗窓タイミング（黒竜の盾・反応窓・効果ダメージ窓）★重点

**設計思想**: カードを個別に直すのではなく、**対抗窓が各場面で正しく開くか**をエンジンで担保する。調査で「相手の呪文/必殺技/起動能力の宣言時に、防御側=応答側(responder)へ**解決前の対抗窓 `pendingAction` が正しく開く**（castImpactは即解決でなく beginPendingAction を挟む）」ことを確認済み。

- **H-BT03/0025 五角の誓い**: 新条件op `selfReceivedDamage`(counterEventWindow.kind="damageDealt" かつ defender=自分 かつ damage>0)。従来は無条件で任意の対抗窓で撃てた過剰を「君がダメージを受けた時」に限定。
- **H-SD02/0014 実は生きていた!**: 既存 `setLifeZeroSafeguard(life:1)+pendingAttackDefenderIsSelf+fight1回` で忠実実装済みと**検証して変更不要**と判断。
- **BT04/0101 黒竜の盾**（主力）: 効かない原因は対抗窓でなく**カード条件が戦闘窓専用**だった点。新条件op `pendingActionResponderIsSelf`(相手効果の解決前対抗窓で自分が応答側か)を追加、条件を `ownCenterEmpty + any(pendingAttackDefenderIsSelf, pendingActionResponderIsSelf)` に。既存の `preventNextDamage`(preventAll・onlyAttack無し)→applyDamageToPlayer が、直後解決の相手効果ダメージ(byAttack:false)を予防。回帰(両窓で発動可・窓なしで不可)。意図: 戦闘・相手の呪文/必殺技/起動能力の全ダメージに対抗。
- **効果ダメージ後の被弾窓**（対抗タイミングの網羅）: 従来 `counterEventWindow` は戦闘ダメージ後のみ。`applyDamageToPlayer` に `openDamageReceivedCounterWindow` を追加し、**byAttackでない=効果/必殺技ダメージで発生源ownerが判っている時のみ**窓を開く(コスト/ライフリンク等の発生源不明は開かない=過剰発火防止)。src/15 の効果ダメージ全経路に sourceCard/sourceOwner を付与。効果: **H-EB03/0060(相手のカードが君にダメージを与えた時)がカード無修正で機能**、五角の誓いも効果ダメージに反応。回帰(被弾者/発生源側の判定・無修正カード対応)。残ギャップ(意図的): beginPendingAction/戦闘を経ない誘発ダメージの直呼びは発生源owner未付与なら窓を開かない。

---

## 6. 大首領アンノウン(bf-h-eb03-0029) の conditionalSize（サイズ0上書き）★重点

- **Q827/Q824 検証**: (Q827)アンノウン離場で `effectiveSize` が `granterOnField(アンノウン)` を参照し**印字サイズに戻る**。(Q824)`grantConditionalSize` を `enforceSizeLimit` の**前**に適用し、コールしたサイズ2以下は超過処理より先にサイズ0（上限3・アンノウン在場でも超過破壊されない）。実コール経路/effectiveSizeで実挙動を検証・回帰で固定。
- **隅ケース(コール→破壊→ドロップから別効果で再コールで古いサイズ0が残る)**: 経緯=最初は**破壊時同期クリア**にしたが、破壊後の遅延評価(破壊された瞬間のサイズを見る対抗札 `lastDestroyedCardMatches`)を壊す回帰→リバート。次に**再コール時リセット**(コール系5経路)にした。**さらにユーザー指摘**（ドロップ滞在中のサイズ参照も印字サイズであるべき）を受け、最終形:
  - `recordDestroyedEventWindow` が破壊された瞬間の実効サイズ `sizeAtDestroy` を**凍結**。
  - `destroyFieldCard` がドロップ送り後に `card.conditionalSize=null`（ドロップのサイズ参照は印字サイズ）。
  - `matchesCardFilter` に `effectiveSizeOverride` オプション。`lastDestroyedCardMatches` は凍結した破壊時サイズで判定（「だが奴は一番の格下」等は不変）。
  - 再コール時リセットは非破壊離脱(field→soul→host破壊→drop)の保険として併存。
  - 回帰(ドロップは印字サイズ・対抗札は破壊時サイズ0)。意図: 破壊時サイズと通常のドロップサイズ参照を両立。

---

## 7. グレイプニル(BT04/0092・SS01/0033)「そのターン中攻撃できない」

- 経緯: 最初 `restSelected`(レスト)で近似→**ユーザー指摘**「レストはスタンド付与で再攻撃可能になるが、グレイプニルはスタンドしても攻撃不能」→是正。
- 修正: 新script op `preventCardAttackThisTurn`(選択varに `cannotAttackThisTurn=true`)、`canDeclareAttack` でチェック(used/スタンドと**独立**)、`clearTurnModifiers` でターン終了に解除。★魔狼フェンリル/マーナガルム(ignoreAttackForbidden)は攻撃可の例外を敵対的レビューで検出→canDeclareAttackに例外追加。
- 意図: 「その1枚だけ」攻撃不可（owner全体禁止のグレイプニル機構=デイ・オブ・ザ・ドラゴン用とは別系統。既存機構/テストは不変）。回帰(スタンドしても攻撃不可・ターン終了で解除)。

---

## 8. デザイン/UX 27件（対戦UI/builder/netplay）
機能不全を確実修正(死にCSS・未定義--accent各テーマ定義・部屋番号大文字送信・モバイルでパネル非表示・確認なし削除・同一title・サムネイルsrc=""空振り)＋見た目改善。CSS波括弧均衡/JS構文/HTMLタグ均衡/回帰(エンジン非影響)で検証。#4束見せ・#20席相対フリップはユーザー方針確認の上。※ブラウザ実表示の最終確認はユーザー側。

---

（検証の限界: サーバ実機はユーザー起動時のみ検証。デザインはブラウザ実描画は未検証=静的検証のみ。近似実装は本文に明記。）

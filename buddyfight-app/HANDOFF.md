# Buddyfight App Handoff

作成日: 2026-05-22  
対象プロジェクト: フューチャーカード バディファイト再現デジタルアプリ

このファイルは、別PCや別スレッドで開発を引き継ぐためのコンテキストです。  
特に「何を作っているか」「絶対に守る制約」「現在の実装状態」「最近揉めたバグ」を優先して書いています。

## 最重要ルール

- ユーザーは日本語UI・日本語カード情報を希望している。
- カード情報は海外版ではなく、ブシロード公式の日本語版情報を基準にする。
- ルールは 2018年6月以前、特に `buddyfight_rule_ver205.pdf` 相当を基準にする。
- 「フューチャーカード 神バディファイト」は存在しないものとして扱う。
- フレーバーテキストは諦めてよい。効果内容はTCGとして重要なので正確に実装する。
- 仮想サーバー・ローカルサーバー起動はEDRに引っかかるため、ユーザーが明示的に「こちらで立てた」と言わない限り起動しない。
- ブラウザ検証も、ユーザーが用意した稼働中サーバーがない限り行わない。
- 検証は基本的に `for f in src/*.js; do node --check "$f"; done`（旧 `node --check app.js`。エンジンは `src/` 21モジュールに分割済み）と `node tests/effects-regression.test.js` などの静的/Nodeロジック検証で行う。
- 配布物を更新したら `buddyfight-app-export` に同期し、`buddyfight-app-export.zip` を更新する。

## 現在の主なファイル

- `src/01-foundation.js`〜`src/21-bootstrap.js`: 対戦画面、ローカル対戦、ネット対戦クライアント、効果エンジン本体（旧 `app.js` を2026-06-25に21モジュールへ分割。番号順 classic script 読み込み・グローバルスコープ共有・連結すると旧 app.js とバイト等価）。
- `index.html`: ローカル対戦用画面。
- `play.html` / `play.js`: ネット対戦用画面（権威サーバ版シンクライアント）。`netplay.html` は旧・中継版で現在は非使用。
- `styles.css`: 対戦UI。
- `builder.html` / `builder.js` / `builder.css`: デッキ構築画面。
- `server/authoritative-server.js` / `server/engine-host.js`: 権威サーバ版ネット対戦サーバー。`netplay-server.js`（旧・中継サーバ）は現在は非使用。
- `data/cards/*.json`: 製品別カードデータ。
- `data/decks/*.json`: 構築済みデッキ。
- `data/flags.json`: ワールドフラッグを一括管理。
- `tests/effects-regression.test.js`: アスモダイ、クイックサモン等の効果回帰テスト。
- `buddyfight-app-export/`: 外部展開用に必要ファイルだけ集めたフォルダ。
- `buddyfight-app-export.zip`: 外部展開用zip。

不要・引継ぎ不要の可能性が高いもの:

- `edge-*profile` 系フォルダ
- `rule-render-*.png` や `rule-contact-*.png` は作業中生成物。必要なら残してよいが、アプリ起動には不要。

## 実装済みカード製品

カードデータは製品別JSONに分離済み。

- `data/cards/td01-strong-dragon.json`
- `data/cards/td02-forging-blood.json`
- `data/cards/td03-dragonic-force.json`
- `data/cards/bt01-dragon-bancho.json`

実装済み製品:

- 最初のスターターデッキ相当
- 500円スタートデッキ第2弾「フォージング・ブラッド」
- 500円スタートデッキ第3弾「ドラゴニック・フォース」
- ブースターパック第1弾「ドラゴン番長」

ブースターパックはデフォルトデッキを持たない。

## フラッグ方針

ワールドフラッグは製品ごとに重複登録しない。  
今後パック内にフラッグがあっても無視し、`data/flags.json` で一括管理する。

現在登録済みの主なフラッグ:

- ドラゴンワールド
- デンジャーワールド
- マジックワールド
- カタナワールド
- エンシェントワールド
- ダンジョンワールド
- レジェンドワールド
- ダークネスドラゴンワールド
- ヒーローワールド
- スタードラゴンワールド
- ドラゴンアイン
- 百鬼夜行
- 楽園天国
- 灼熱地獄
- ドラゴンツヴァイ
- the Chaos
- 竜牙雷帝

## ルール・裁定メモ

### フェイズ

メイン、アタック、ファイナルなどを分離済み。  
メインフェイズで攻撃後にドローできるような誤動作は避ける。

### 対抗

2018年6月以前ルール基準。  
ユーザーから明示された重要裁定:

- ターンファイターがカード/能力を使用した後、非ターンファイターはその解決前に【対抗】を1つ使える。
- それに対して、ターンファイターはさらに先にカード/能力を使えない。
- つまり「対抗の対抗」は基本的にできない。
- アブラカダブラは相手の魔法キャストに対して使う対抗魔法であり、対抗の対抗ではない。

注意:

- 以前、こちらが「2018年6月以前は1回の攻撃中に魔法を複数枚使える」と誤回答したが、ユーザーは ver.2.05 の「対抗は1つ」を根拠に指摘している。
- 今後この点を間違えないこと。

### バディコール

デッキ作成時にモンスターまたは必殺モンスターを1枚バディとして設定する。  
同名モンスターをコールする際、1度だけバディコールとして宣言できる。  
ライフ+1以外は通常のコールと同じで、コールコストやサイズ制限は通常通り。

### アイテム

- センターにモンスターがいてもアイテム装備自体は可能。
- ただし通常、センターにモンスターがいる間、武器では攻撃できない。
- 「装備不可」ではなく「攻撃不可」なので注意。
- フラッグとアイテムは同じ表示枠でよい。装備や着任、変身時はフラッグ上に重ねる。

### 防御力を持つアイテム

防御力を持つアイテムを装備している時:

- ファイターへの攻撃は、防御力を持つアイテムへの攻撃としても扱う。
- 攻撃力が防御力未満ならダメージを受けない。
- 攻撃力が防御力以上なら、攻撃参加カードの合計打撃力分のダメージを受ける。
- ダメージを受けても防御力を持つアイテムは破壊されない。
- 防御力を持つアイテムが攻撃された場合、バトルになる。
- 反撃はモンスターに適用される能力なので、アイテムに反撃してもアイテムは破壊されない。
- 防御力を持たないアイテムへの攻撃は、攻撃された扱いにならず、バトルにならない。

### ドロップゾーン

- ドロップゾーンの順番は重要。
- 現在は枚数表示にし、クリックで中身をポップアップ表示する。
- 並び順は追加順を保つ。
- 将来的に「ドロップゾーンの上から10枚をデッキに戻してシャッフル」等が必要になるため、順序を壊さないこと。

## UI方針

- 全体を黒一色にしない。プレイヤー1/2で盤面色を分ける。
- 画面左 3/5 に盤面、右 2/5 にログや操作ボタン。
- プレイヤー1はレフトが左、ライトが右。
- プレイヤー2は対面なので左右・上下を反転して表示。
- 盤面は公式画像風に、上段にゲージ/レフト/センター/ライト/ドロップ、下段に配置魔法/フラッグ&アイテム/バディ/デッキ。
- 配置魔法は2枠。
- ドロップゾーンは枚数表示、クリックで中身。
- カードにホバーしたら詳細情報ポップアップ。
- フラッグ、アイテム、ソウルなど重なったカードも、ホバー時に裏側/下のカードが分かる工夫をする。

## デッキ構築

`builder.html` / `builder.js` で実装。

主な機能:

- 別画面のデッキ構築ツール。
- カード検索。
- インポート/エクスポート。
- 公式デッキ構築ルールを意識。
- カード一覧には名前と効果だけでなく、モンスター編成に必要なサイズ、攻撃力、防御力、打撃力、属性などを表示する方針。

過去に「エクスポートボタンが反応しない/見えない」指摘あり。必要なら再確認。

## ネット対戦

現在は権威サーバ版（`server/authoritative-server.js` + `play.html`）による部屋番号式に一本化（旧・中継版 `netplay-server.js`/`netplay.html` は非使用）。  
同一ネットワーク限定ではなく、公開サーバーへデプロイすればブラウザゲーム風に誰でも部屋番号で参加できる設計。

ただし、この開発環境ではサーバー起動しない。  
ネット対戦の実動検証は、ユーザーがサーバーを立てた場合のみ行う。

## 効果エンジン

以前はカード名/handlerごとの個別処理が多かったが、現在は汎用 `script` / `effects` へ移行中。

カード能力の主な構造:

- `kind`: `spell`, `impact`, `activated`, `triggered`, `continuous` など。
- `timing`: `main`, `counter`, `final` など。
- `conditions`: 使用条件。
- `cost`: 使用コスト。
- `target`: 対象指定。
- `effects`: 単純効果。
- `script`: 選択や分岐を含む複雑効果。
- `optional`: 任意能力。

現在カードJSON内の `handler` 参照は 0 件にしている。  
ただし `app.js` 側には旧カード状態互換用として `legacyAbilityScriptDefinition()` が残っている。

重要な汎用script命令:

- `selectCards`
- `moveSelected`
- `moveSelectedGroup`
- `destroySelected`
- `payCardCostForSelection`
- `selectZone`
- `callSelected`
- `callSelectedToEmptyZones`
- `stackCallSelected`
- `placeSelected`
- `shuffleDeck`
- `stopUnlessMovedToDropMatches`
- `ifSelection`
- `ifTargetController`
- `discardSelfSoul`
- `moveSoulToDrop`
- `log`

重要な汎用effect命令:

- `draw`
- `putTopDeckToGauge`
- `moveTopDeckToDrop`
- `gainLife`
- `dealDamage`
- `discardAllHand`
- `discardHand`
- `moveHandToGauge`
- `moveMatchingDropToHand`
- `destroy`
- `destroyAll`
- `returnToHand`
- `returnAllToHand`
- `modifyStats`
- `modifyStatsByFieldCardStat`
- `grantKeyword`
- `nullifyAttack`
- `nullifyPendingAction`
- `shuffleDropIntoDeck`
- `gainLifeMinusMatchingDropCount`
- `winGame`

## 直近の重要バグ: アスモダイとクイックサモン

ユーザーから何度も「魔王 アスモダイの効果が未実装」「クイックサモンが何も起きない」と指摘された。  
原因は、こちらがJSON上のscript実装だけを確認し、実際の操作経路まで検証していなかったこと。

現在の対策:

- `tests/effects-regression.test.js` を追加。
- `app.js` に `globalThis.__BUDDYFIGHT_TEST__` 時だけ初期化を止め、内部関数をNodeテストから叩けるフックを追加。
- アスモダイとクイックサモンについて、効果本体だけでなく実操作経路もテストに入れた。

現在テストしている内容:

- アスモダイのscript直接実行:
  - 手札を選ぶ。
  - 捨てる。
  - 場のモンスターを選ぶ。
  - 破壊する。
- アスモダイ旧handler互換。
- アスモダイ実操作経路:
  - 手札からコール宣言。
  - 対抗確認後にコール解決。
  - 登場時効果解決。
  - 未実装ログが出ないこと。
- クイックサモンのscript直接実行:
  - 手札モンスター選択。
  - コール先選択。
  - コール。
  - 反撃付与。
  - 攻撃対象変更。
- クイックサモン旧handler互換。
- クイックサモン実操作経路:
  - 攻撃中に手札から使用。
  - 効果解決。
  - 未実装ログが出ないこと。

検証コマンド:

```powershell
# エンジンは src/01-*.js 〜 src/21-*.js に分割済み（旧 app.js）。各モジュールを構文チェック
Get-ChildItem src/*.js | ForEach-Object { node --check $_.FullName }
node tests/effects-regression.test.js
```

期待値:

```text
effects regression ok
```

注意:

- `npm` はこの環境では見つからなかった。`package.json` には `test` script があるが、実体は `node tests/effects-regression.test.js`。
- もし別PCで `npm` が使えるなら `npm test` でもよい。
- ブラウザキャッシュ回避のため、`index.html` / `netplay.html` は現在 `app.js?v=20260521-effects-route` を読み込む。

## 既知のリスク/未完成の可能性

- ブラウザ実操作での検証は、EDR制約によりこちらでは行っていない。
- 既に開いている画面や進行中対戦には古いカードオブジェクトが残る可能性がある。検証時は画面リロードと新規対戦が必要。
- カード効果の大半は汎用script/effectsへ移行したが、今後の追加カードで新しいパターンが出たらエンジン命令を増やす。
- `チェック・メイト` は現在、条件達成時に `winGame` で即勝利する簡略実装。実カードは攻撃とダメージ成立が絡むため、将来的に専用の攻撃誘導/勝利条件処理へ直すべき。
- `双掌断頭台` のジャンケンは現在ランダム判定。将来的にはプレイヤー選択UIまたは専用ログが必要。
- 複数候補を選ぶ効果はかなりUI化したが、今後も「自動選択寄り」の処理が残っていないか注意する。
- 公式テキストの完全性はカードごとに再確認が必要。フレーバーは未収録でよい方針。

## 外部展開/配布

外部展開用には `buddyfight-app-export/` と `buddyfight-app-export.zip` を使う。  
不要な `edge-*profile` 系フォルダは配布に含めない。

変更後に同期する基本手順:

```powershell
Copy-Item -LiteralPath .\app.js -Destination .\buddyfight-app-export\app.js -Force
Copy-Item -LiteralPath .\index.html -Destination .\buddyfight-app-export\index.html -Force
Copy-Item -LiteralPath .\netplay.html -Destination .\buddyfight-app-export\netplay.html -Force
Copy-Item -LiteralPath .\package.json -Destination .\buddyfight-app-export\package.json -Force
New-Item -ItemType Directory -Path .\buddyfight-app-export\tests -Force | Out-Null
Copy-Item -LiteralPath .\tests\effects-regression.test.js -Destination .\buddyfight-app-export\tests\effects-regression.test.js -Force
Compress-Archive -Path .\buddyfight-app-export\* -DestinationPath .\buddyfight-app-export.zip -Force
```

カードJSONを変更した場合は、該当ファイルも `buddyfight-app-export\data\cards\...` にコピーする。

検証:

```powershell
node --check .\buddyfight-app-export\app.js
node .\buddyfight-app-export\tests\effects-regression.test.js
```

## 次の開発者への注意

- ユーザーはかなり正確にTCG挙動を見ている。曖昧な「実装したつもり」は通用しない。
- カード効果の修正時は、カードJSONを見るだけでなく、実際の操作経路に近い回帰テストを追加する。
- 「効果本体を直接叩くテスト」だけでは不十分。可能なら `useCardAction`, `callMonster`, `resolvePendingResolution` など実UI経路の関数も通す。
- サーバー起動はしない。必要ならユーザーに起動してもらい、そのURLに対してのみ確認する。
- 公式情報を参照する必要がある場合は、海外版ではなくブシロード公式日本語情報を使う。
- ただし回答に公式テキストを長く引用しない。実装データとして扱う場合も、必要最小限に注意する。

## 2026-06-01 追記: 起動効果の分離

起動効果を持つモンスターや設置魔法が、使用・登場・設置時に勝手に発動する問題を修正済み。

- `app.js` に `canUseAbilityFromHand()` を追加した。
- `activated` は基本的に場から明示的に使う。手札から使えるのは `fromHandOnly` がある場合だけ。
- スクリプト選択、デッキ上から使う処理も同じ方針に揃えた。
- `tests/effects-regression.test.js` に以下の回帰テストを追加済み。
  - 場の起動効果を持つモンスターが手札使用で発動しない。
  - 「ノイジィ・ダンスルーム」は設置時に起動効果が発動せず、場で選んで使った時だけ発動する。

この修正と同時に、以下も反映済み。

- ハーティの連携攻撃無効化は、ハーティ自身が攻撃対象の場合だけ使える。
- ターン終了時の遅延破壊は、破壊が防がれても一度試みたら失効する。
- ラディスの `countsAsDestroyed` を破壊置換時に処理する。

## 2026-06-01 追記: BT02 / EB01 読み取り専用レビュー

動作チェック班を2つに分け、以下を再レビューした。アプリ本体の修正はまだ行っていない。

- BT02 ブースターパック第2弾「サイバー忍軍」
- EB01 エクストラブースター第1弾「不死身の竜神」

確認結果:

- ユーザーが起動済みの `http://127.0.0.1:4173/index.html` に接続できた。
- `index.html` と `builder.html` の読み込み時コンソールエラーは 0 件。
- `tests/effects-regression.test.js` を検証環境から実行し、`effects regression ok` を確認した。
- BT02 / EB01 のJSONが使う条件、script命令、effect命令を機械走査し、エンジン側で未認識の命令は 0 件だった。
- 端末からの `node.exe` 実行は `Access is denied` となる。この環境では検証環境経由で回帰テストを実行する。

### 要修正

1. EB01「百面忍者 無楽」の常設『反撃』が動かない。
   - `data/cards/eb01-immortal-dragon-deity.json` の `eb01-0020` は `keywords: ["counterattack"]` を持つ。
   - `app.js` の `createCard()` は `counterattack: false` を設定する。
   - `resolveCounterattack()` は `targetAfterBattle.counterattack` だけを参照するため、カード本来のキーワードを見ない。
   - 汎用修正として `hasKeyword(targetAfterBattle, "counterattack")` を使う。

2. 連携攻撃への『反撃』で、破壊する攻撃モンスターをプレイヤーが選べない。
   - `resolveCounterattack()` が `attackers.find(...)` で先頭候補を自動選択している。
   - 「百面忍者 無楽」、および「竜神無頼」「竜胆不敵」で『反撃』を得たモンスターに影響する。
   - 汎用のカード選択UIを使って、破壊可能な攻撃モンスター1枚を選ばせる。

3. ズィーガー系の破壊時特殊コール機会が、そのターン中残り続ける。
   - 対象は「デュエルズィーガー “スパルタンド”」と「デュエルズィーガー “テンペスト・エンフォーサー”」。
   - `recordSpecialCallOpportunity()` と `specialCallOpportunityMatches()` は、使用済みか同一ターンかだけを判定する。
   - 本来の「破壊された時」の処理窓を過ぎた後も、同一ターンならコールできる。
   - 汎用修正として、特殊コール機会に解決窓の世代番号を持たせるか、窓の終了時に明示的に失効させる。

4. BT02「ビクトリースラッシュ！」は近似実装のまま。
   - 現在は `lastDamageSourceMatches` が同一ターンのダメージ履歴を見る。
   - ジャンケンは `chance: 0.5` の乱数判定。
   - 本来の発動タイミングに限定するイベント窓と、プレイヤーがジャンケンを選ぶUIが必要。

### 整理候補

BT02 の以下には用途が合わない空配列または不要なコスト定義が残っている。現時点では別経路で正しい支払いが行われるため、確認済みの対戦バグとしては扱わない。

- `bt02-0022` 「ドラゴニック・パラトルーパー」: `costs.call: []`
- `bt02-0039` 「黄泉の還り路」: 不要な `costs.call`
- `bt02-0049` 「伊達男 シトリー」: `costs.cast: []`

### 次の修正で追加するテスト

- 常設『反撃』が発動する。
- 連携攻撃への『反撃』で破壊対象を選べる。
- ズィーガー系特殊コールは対応する破壊直後だけ可能で、別行動後は失効する。
- 「ビクトリースラッシュ！」は直前の武器ダメージに対する【対抗】としてだけ使える。

## 2026-06-02 追記: BT02 / EB01 レビュー修正

読み取り専用レビューで挙がった BT02 / EB01 の問題を汎用処理側で修正した。

### EB01

- 常設『反撃』も `hasKeyword()` 経由で判定するようにした。これにより「百面忍者 無楽」の常設『反撃』が動く。
- `hasKeyword()` に null ガードを追加した。攻撃で対象が破壊済みの場合も『反撃』確認で例外にならない。
- 一時付与の `card.counterattack` も `hasKeyword()` で扱う。「竜神無頼」「竜胆不敵」で付与した『反撃』も動く。
- 連携攻撃への『反撃』で破壊可能な攻撃モンスターが複数いる場合、汎用選択UIで対象1枚を選ぶ。
- ズィーガー系の破壊時特殊コール機会に `expired` を追加した。対応する破壊直後の窓を過ぎて別行動を行うと失効する。

### BT02

- 「ビクトリースラッシュ！」の発動可否は、同一ターンの履歴ではなく直前のダメージ応答窓だけを見る。
- ダメージ応答窓は連携攻撃に参加した全カードを `sources` として保持する。武器とモンスターの連携攻撃でも武器由来の条件を確認できる。
- ジャンケンは `chance: 0.5` の乱数ではなく、プレイヤーがグー・チョキ・パーを選ぶ。
- ネット対戦では、相手席の選択を相手ブラウザへ要求する `hidden_choice_request` / `hidden_choice_response` を追加した。要求先の席と返答候補は `netplay-server.js` でも検証する。
- ジャンケンの必須選択では、ローカル・リモートともキャンセルボタンと Esc を無効化した。候補外または空の返答はサーバー側でも拒否する。
- ネット対戦の解決操作は、行動なら `responder`、攻撃なら `defender` の席だけが実行できる。表示上のボタン無効化と関数入口の両方で制限する。
- 効果ダメージのログは、軽減前の値ではなく実際に与えた `dealtDamage` を表示する。
- `bt02-0022`, `bt02-0039`, `bt02-0049` に残っていた不要または誤解を招くカード本体側コスト定義を削除した。

ジャンケンの汎用処理は BT01「双掌断頭台」にも適用した。

### 追加した回帰テスト

- 常設『反撃』と、連携攻撃に対する破壊対象選択。
- 破壊済み対象への『反撃』確認が例外にならないこと。
- 効果で一時付与した『反撃』も働くこと。
- ズィーガー系特殊コール窓が別行動後に失効すること。
- 「ビクトリースラッシュ！」が直前の武器ダメージ窓でだけ使えること。
- 武器とモンスターの連携攻撃でも武器条件を満たすこと。
- 軽減後の実ダメージがログに出ること。
- ネット対戦のジャンケンで相手席へ伏せ選択要求を送ること。
- ネット対戦の行動解決は対抗確認側の席からだけ実行できること。

### 検証

- 検証環境経由で `tests/effects-regression.test.js` を実行し、`effects regression ok` を確認した。
- `netplay-server.js` は構文確認済み。
- 通信サーバーは起動せず、モック通信で部屋作成 `201`、参加 `200`、伏せ選択要求 `200`、相手返答 `200` を確認した。
- ユーザー起動済みの `http://127.0.0.1:4173/index.html` と `http://127.0.0.1:4173/netplay.html` を再読込し、コンソールエラー 0 件を確認した。
- 最後の小修正後はユーザー側サーバーが停止していたため、画面再読込は繰り返していない。最終状態は回帰テストと配布版構文確認で検証した。

### 展開時の注意

- 外部公開環境では、`app.js` だけでなく `netplay-server.js` も差し替えて Node サーバーを再起動する。
- 2ブラウザを使った実サーバー上のジャンケン操作は未実施。公開環境を更新した後に確認する。

## 2026-06-04 追記: ズィーガー特殊コールとソウルガード

ユーザー報告: 「デュエルズィーガー破壊時に、手札からスパルタンドなどの特殊召喚ができない」。

原因:

- `destroyFieldCard()` が『ソウルガード』を自動使用していた。
- 「武神竜王 デュエルズィーガー」は『ソウルガード』持ちで、実戦ではコールコストでソウルを持ちやすい。
- 自動でソウルガードされるとカードは破壊されず、`recordSpecialCallOpportunity()` が呼ばれないため、スパルタンド/テンペスト用の破壊時コール窓が作られなかった。

修正:

- `destroyFieldCard()` のソウルガード処理を任意確認に変更した。
- `shouldUseSoulguard()` を追加し、確認で「いいえ」を選んだ場合は通常破壊として処理する。
- ソウルガードを使わなかった場合は、ソウルと本体がドロップに置かれ、ライフリンクが発生し、特殊コール窓が作られる。

追加検証:

- `tests/effects-regression.test.js` に、ソウルを持つズィーガーでソウルガードを使わず、手札の「デュエルズィーガー “スパルタンド”」を特殊コールできる回帰テストを追加した。
- `tests/eb01-zieger-browser-smoke.html` を追加した。ユーザー起動済みサーバー上で読み込み、ブラウザ上で `ok` とコンソールエラー 0 件を確認した。
- 通常の `http://127.0.0.1:4173/index.html` も再読込し、コンソールエラー 0 件を確認した。

注意:

- スクリーンショット取得はブラウザ側の `Page.captureScreenshot` が時間切れになった。挙動検証自体は DOM とログで確認済み。


## 2026-06-04 追記 BT03「ドドド大冒険」実装

公式日本語カードリストから BT03 117枚を `data/cards/bt03-dododo-adventure.json` に追加し、`data/cardsets.json` に登録した。

主なエンジン追加:

- カード直下の `costs.cast` を手札能力の使用コストとして拾うフォールバックを追加。
- コストステップに `conditions` を付けられるようにし、「条件を満たさない場合だけ追加コスト」を表現可能にした。
- レスト/移動イベントを共通トリガー化し、`opponentRest` / `allyMove` などをカードJSONで扱えるようにした。
- 全体モンスター攻撃、攻撃対象制限、キーワード禁止、手札戻し禁止、破壊置換でゲージへ置く処理を追加。
- `setNextActivatedCostMayUseOpponentGauge`、`eachPlayerTopDeckToDropThenDamageOrLife`、`rockPaperScissorsDamageLosers`、`topTwoRevealOneOpponentRandomToHandOrGauge` を汎用 effect op として追加。
- 装備カード選択時にソウル内カードの `soulAbilities` を起動できるようにし、`$host` 参照を追加。

BT03で追加・修正した代表効果:

- `bt03-0005` 遊び人 ザ・ゴールド: 相手モンスター全体攻撃と破壊数ぶんダメージ。
- `bt03-0016` / `bt03-0057` / `bt03-s007`: 前の相手モンスターがレストした時のダメージ。
- `bt03-0019`: 《魔王》がいない時の追加ゲージ4コスト。
- `bt03-0028`: 迅雷騎士団が相手ターン中に移動した時のゲージ追加。
- `bt03-0033`: ガッチャ！のライフ条件と次の起動コストで相手ゲージも使える効果。
- `bt03-0038`: 当たり付きミミックの破壊時デッキ上判定。
- `bt03-0044`: 他の《タロット》がない場合の攻撃不可。
- `bt03-0061`: レフト/ライトのモンスターへ攻撃できない設置効果。
- `bt03-0065`: 大入りパンドラのジャンケン敗者ダメージ。
- `bt03-0067`: 危険な導火線の上2枚確認/公開/ランダム分岐。
- `bt03-0070`: 竜滅剣 ドラゴンスレイヤーの対ドラゴン/竜属性パワー増加。
- `bt03-0074` / `bt03-0104`: 《タロット》2枚以上で使用コスト免除。
- `bt03-0077`: 竜騎士 カゲキヨの破壊置換ゲージ行き。
- `bt03-0098`: グミスライムの移動不可/手札戻し不可。
- `bt03-0105`: アーマナイト・ケルベロス “A” の武器ソウル中の打撃力上昇とガルチャージ。

検証:

- `tests/effects-regression.test.js` にBT03回帰を追加。
- Node REPL の VM 実行で `effects regression ok` を確認。
- 全カードセット読込確認: td01 17、td02 17、td03 19、bt01 117、cp01 51、bt02 117、eb01 54、bt03 117、合計 509、ID重複なし。
- ユーザー指示に従い、こちらではサーバー起動・ブラウザ実動作検証は行っていない。

残注意:

- `bt03-0028` 迅雷フォーメーション！の「真・迅雷フォーメーション」で追加アタックフェイズを行う複合処理は、現状まだ完全な専用フローではない。今後、追加攻撃フェイズ/複数カード同時コール/デッキ上からドロップ後の複数選択UIをより汎用化して対応するのが望ましい。

## 2026-06-10 追記: Claude Code（WSL2）への引き継ぎ

このフォルダ（`~/dev/simu_app/buddyfight-app-export/`）を開発本体とし、git 管理を開始した。
本ファイルの最終追記（2026-06-04）以降〜 app.js 最終更新（2026-06-08）の間の変更
（BT03 前後レビューサイクル、場の起動能力の pendingAction 化、sameInstanceAsSource、
ズィーガー特殊コール確認フロー等）は **`docs/引き継ぎ補遺_2026-06-10.md`** に復元・記録した。

- Codex 会話ログ全文は `docs/codex開発ログ.md`（UTF-8 変換済み。原本 `ログ.md` は cp932・git 管理外）
- 新環境では node を直接実行できるため、検証は `for f in src/*.js; do node --check "$f"; done`（旧 `node --check app.js`）と `node tests/effects-regression.test.js` をそのまま使う
- 「buddyfight-app-export へ同期 + zip 更新」の運用は廃止（このフォルダが本体）

## 2026-06-11 追記: BF-TD01 / BF-TD02 実装（デッキ商品）

トライアルデッキ2製品を実装し、構築済みデッキとして登録した。

- **BF-TD01 トライアルデッキ第1弾「ザ・勇者爆誕!!」**: カード番号 TD04/0001〜0020（ダンジョンW、新規18種+BT03再録1種+フラッグ）
  - `data/cards/td04-braves-explosion.json` / `data/decks/td04-braves-explosion.json`
- **BF-TD02 トライアルデッキ第2弾「激闘!! 絶命陣」**: カード番号 TD05/0001〜0020（カタナW、新規5種+BT02再録13種+フラッグ）
  - `data/cards/td05-ninja-onslaught.json` / `data/decks/td05-ninja-onslaught.json`
- 情報源: fc-buddyfight.com 公式カードリスト（expansion=14/15）。再録はカタログ内の先行実装（BT02/BT03）をコピーし id/no/rarity のみ変更。
- デッキ構成: 公式は「20種52枚」のみ公表。枚数内訳は Buddyfight Theory ブログのリストを採用（フラッグ1+バディ1+メイン50で検算済み）。
- **バディは公式情報が見つからずカバーカードを推定採用**: TD04=伝説の闘士 牙王（td04-0002）、TD05=月影 剣神もうど（td05-0005）。判明したら deck JSON の buddy と recipe 枚数を入れ替えること。

### エンジン追加（汎用）

- `attacked` イベント（攻撃対象になった時。`runAttackedTriggers` を攻撃宣言後に発火）
- effect op `nullifyAttackersKeyword`（攻撃側のキーワードをターン中無効化。`card.turnSuppressedKeywords` + hasKeyword で判定、ターン終了時クリア）
- 設置イベント `set`（`resolvePendingSetSpell` から `runFieldEventTriggers("set")` → `allySet`/`opponentSet`。`enteredCard` を context に渡す）
- 登場応答窓 `enteredEventWindow` + 条件 op `lastEnteredCardMatches`（ダンジョン・ピット用。破壊応答窓と同型）
- 攻撃側の破壊イベント `allyAttackDestroyed` + 条件 op `eventAttackersMatch`（ミッションカード "モンスター討伐！" 用）
- 条件 op `sourceSoulCountGte` / script op `ifCondition`（汎用 if 分岐）/ effect op `moveSourceSoulToHand`
- effect op `dropAllSoulAtZone` + `destroyAll` の `zones` 絞り込み（ローリング・ストーン用）
- `dealDamage` の `ignorePrevention`（デッドエンド・クラッシュ！の軽減無視）+ カード級 `cannotBeNullified` は既存流用
- ファイターへの連携攻撃保護: continuous op `fighterCannotBeLinkAttacked`（絶剣忍者 斬鉄）
- script 許可リストに `putTopDeckToSoul` / `moveSourceSoulToHand` を追加
- `enteredCardMatches` に `excludeSource` を追加（パーティ結成の「このカード以外」）

### 検証

- 機械走査: 新セットの全命令にエンジン未認識なし。全セットID重複なし（フラッグ除く544枚）。
- 回帰テスト9本追加（牙王の貫通無効化・ローリング・ストーン・ダンジョン・ピット窓・ミッション2種・斬鉄の連携保護・デッドエンドの軽減無視・林蔵サーチ・もうど打撃力）。`effects regression ok`。

## 2026-06-19 追記: BF-EB02 実装（エクストラブースター第2弾）

エクストラブースター第2弾「ヤバすぎ大決闘!! ドラゴン VS デンジャー」全54枚を実装した。
詳細は `docs/EB02実装報告_2026-06-19.md`。

- `data/cards/eb02-dragon-vs-danger.json`（モンスター34/魔法13/アイテム4/必殺技3）。`cardsets.json` 登録済。
- 全セット総数 **603**（ID・カードNo重複なし）。情報源: fc-buddyfight.com 公式（expansion=16）。
- S001〜S006 は 0003/0001/0004/0006/0007/0017 の再録。0013 ケルベロス"A" は BT03/0105 の完全再録。

### エンジン追加（汎用）

- `state.lastDamageTaken` 記録（applyDamageToPlayer、ターン終了でリセット）＋ effect `putTopDeckToGaugeEqualToLastDamage`（豪胆逆怒）
- `lifeGained` フィールドイベント（gainLife系→`allyLifeGained`/`opponentLifeGained`、竜剣ドラゴウイング）
- effect `nullifyAttack` の `rockPaperScissors` ゲート（スフィンクス）
- effect `redirectPendingAttackToSelf` / 継続 `redirectAttackToSelf`＋`applyAttackRedirectContinuous`（デモンゴドルの挑発）
- effect `destroyOpponentMonsterWithPowerLteOwnWeapon`（斬魔烈斬）
- `callStack.attribute`（属性指定の重ねコール、デモンゴドル）
- 継続 `preventCenterCall`＋`isCenterCallPrevented`（リクドウ斬魔・MAJI斬魔）
- `equipConditions` ゲート（ドラゴエターナル）
- moveSelected 宛先 `itemSoul`（カーリー）
- `returnSoulToHandOnDestroy` フラグ（ゴブリン。destroyFieldCard がソウルをドロップへ移す前に手札へ回収）

### 検証

- `node --check app.js` / `node tests/effects-regression.test.js` → `effects regression ok`（既存72＋EB02新規16本）。
- サブエージェント3班でレビュー（データ忠実性・エンジン差分・テスト網羅/no-op検出）。指摘のうち実害のある3点
  （ゴブリン破壊時ソウル回収の不発＝致命／デュアル・ムービングフォースのcontroller未指定／豪胆逆怒のターン跨ぎ悪用）を修正済み。

### 2巡目レビュー（5班）と裁定反映

- 牙竜喝破0015（「1枚で攻撃中」前提を `turnOwnerIsSelf`+`pendingAttackNotLink` で実装）、アスモダイ0007（生贄を《アーマナイト》限定に）を修正。
- **ディルクショーテル0008**：ユーザー指示で正式実装。`ignoresDragonShieldWhenAlone` フラグ＋ `applyDamageToPlayer(ignoreNamedPrevention)` / `nullifyPendingAttack` ガードで、単独攻撃時にカード名「ドラゴンシールド」を含む軽減/無効を無視（無視した軽減はキューに残る）。
- 必殺技は一律「1ゲーム1回」制限なし（ユーザー確認済、現状維持）。
- EB02回帰テスト計20本。詳細は `docs/EB02実装報告_2026-06-19.md`。

## 2026-06-19 追記: 全カードパック レビュー（10班）と不具合修正

全11製品603枚をパック別サブエージェント10班でレビュー（大型パックは前後半2班ずつ）。
**実在しない op はゼロ**。検出した実害6件を修正（詳細 `docs/全カードレビュー報告_2026-06-19.md`）:

- 【致命】BT03/0015 絶獅子: ターン終了時の《髑髏武者》ゲージ送りが `from:"pendingAttackers"` で常に不発 → `from:"field"` に修正。
- 【致命】EB02/0011 デュアル・ムービングフォース: 必殺技条件が `counterEventWindow`（ファイナルで破棄）依存で常に偽 → 新 condition op `damageDealtThisTurnMatches`（ターン保持の `lastDamageEvent` 参照）で修正。
- 【中】ガルガンチュア・パニッシャー(BT01/0012,S007,TD01/0015): 「ダメージは減らない」未実装 → `dealDamage` に `ignorePrevention`。
- 【中】BT02/0007 闇狐: 自身の攻撃時に誘発しない → 自身用 `dealDamage` イベント能力を追加。
- 【中】reduceMagicWorldSpellGaugeCost(BT01/0005,BT02/0012): 必殺技にも誤適用 → `effectiveCardType==="spell"` ガード追加。
- 【中】CP01/0002 ジェロニモ: 自己強化が全モンスターに波及 → filter に `sameInstanceAsSource`。

回帰テスト6本追加。`effects regression ok`。テストAPIに applyDamageToPlayer/destroyFieldCard/hasKeyword/visiblePower/checkAbilityConditions/applyAttackRedirectContinuous を公開。

## 2026-06-22 追記: BT04「轟斬轟く!!」実装（ブースターパック第4弾）

ブースターパック第4弾(expansion=18)全117枚を実装。レジェンドW/ダークネスドラゴンW中心。
詳細は `docs/BT04実装報告_2026-06-22.md`。

- `data/cards/bt04-roaring-slash.json`（0001-0105＋再録S001-S012）。`cardsets.json`登録。全セット総数 **720**（ID/No重複なし）。
- 実装フロー: buddyfight-card-pack スキル準拠。起草4班→レビュー4班。
- エンジン汎用追加: `equipChange`(装備変更)/`lookTopSelectToHandRestToBottom`/`revealTopDamagePerMatchRestToBottom`/`modifyStatsIfTargetName`/`$attacker`参照＋`setDelayedDestroyAtTurnEnd`のtarget対応。
- レビューで検出した実害を修正（致命: 0026デスカースの自壊・0034全体2回攻撃無効・0053連携判定・0059フィンブルの冬の設置/ソウル不発／中: 0028貫通dead code・0047/0031/0020 ほか）。BT04リグレッション5本追加。
- 既知の近似28件（_note）。主因: 特定カード名の効果無効化・非攻撃ダメージ軽減・能力全無効化・連携被ダメージ固定など専用機構の不在。`effects regression ok`。
- **作業はすべて main ブランチ上で実施**（前回のような feature ブランチ/worktree は使わない方針）。

## 2026-06-22 追記: BT04 近似の汎用化（再利用可能なエンジン部品へ）

「専用機構の不在」による近似を、ハードコードでなく**汎用エンジン部品**として実装し、対象カードを忠実化（詳細 `docs/BT04実装報告_2026-06-22.md` / 部品一覧は `.claude/skills/buddyfight-card-pack/SKILL.md`）。

- `ignoreNamedDefenseWhenAlone:[名称]`（名称指定の無効化耐性・単独攻撃時。EB02ディルクショーテルの`ignoresDragonShieldWhenAlone`を一般化、後方互換あり）
- effect `modifyStatsAll`（全体強化）/ condition `ownDropCardCountGte`（名称部分一致等の枚数）/ condition `opponentCenterEmpty`
- 全effect共通の `rockPaperScissors` ジャンケンゲート（個別3箇所を共通化）
- カードフラグ `destroyImmunity{fromEffect/fromOpponentEffect/fromSpell/fromImpact}`（効果破壊耐性、`makeEffectCause`で発生源判定）
- 条件付きコストstep（`costStepApplies`）でコスト免除分岐

忠実化: 0005/0008/0016/0019/0022/0026/0028/0036/0074/0076/0002。近似 28→22件。回帰テスト追加（汎用部品ごと）。`effects regression ok`・総数720・ID/No重複なし・未認識opゼロ。

## 2026-06-22 追記: エンジンDSLの細粒度プリミティブ化（合成可能な部品へ）

monolithicなカード級フラグ/op を「条件×フィルタ×効果」の直交プリミティブへ分解（全720枚＋回帰テスト維持・カードJSONは desugar で吸収＝無改変）。詳細は `.claude/skills/buddyfight-card-pack/SKILL.md`。

- 汎用枚数条件 `cardCount`（pile/controller/filter/distinct/cmp/amount。「指定名称が何枚」を含む全カウントを集約）
- 条件 `attackingAlone` / `targetMatches`、全effect共通の `conditions` ゲート
- 攻撃耐性 `attackResistances[{conditions,filter,effects:[nullify,reduce]}]`（旧 `ignoreNamedDefenseWhenAlone` を分解。cardCountと合成可）
- 無効化耐性 `cannotBeNullified`（旧 `effect:"gargantua"` の名前ハードコード撤廃）
- filter駆動コスト軽減 `costReduction`（旧 reduceMagicWorldSpellGaugeCost を desugar。ルーンスタッフのライフ免除も同部品で実装＝近似1件解消）
- 破壊耐性 `destroyImmunity` の配列/byFilter/conditions 化、`onDestroy:{moveSoulTo}`（旧 returnSoulToHandOnDestroy）
- desugar 層 `desugarCardFlags`（normalize内・冪等）に旧→新の変換を集約＝後方互換基盤

検証: `effects regression ok`（合成/desugar/後方互換テスト多数追加）。総数720・ID/No重複なし・未認識opゼロ。敵対的レビューWorkflow(3レンズ→裏取り)で致命/中ゼロを確認。BT04近似 28→21件。

## 2026-06-23 追記: 分解計画 全13項目完了＋全カード正当性レビュー

### エンジン分解（残り #4/#5/#6/#11/#12/#13 を実装）
すべて加算的＋desugar（カードJSON無改変・旧ハンドラは互換シム温存・後方互換絶対）。各段階で `node --check`＋`effects regression ok`＋全720枚 desugarスモーク（旧op残存0・ID/No重複0・冪等0違反）を通過。

- **#5** onEnter文字列 `"destroy-opponent-size2"` → 構造化 triggered/enter ability を desugar（コミット `a64973c`）
- **#6** dragoenergy の id/effect 直書き廃止 → `counterKind` 宣言＋`REPEATABLE_COUNTER_KINDS` 集合で1攻撃中の例外カウンターを一般化（`a64973c`）
- **#12** `preventNextDamage{all|amount}`（旧reduceNextDamage吸収）・`setDelayedDestroy{when,target}`（旧AtTurnEnd系吸収）・`specialCallOnDestroyed→callConditions`。**非破壊の effect-op walker `mapCardEffectOps`（任意ネスト対応）を新設**＝#13でも再利用（`2b3c76d`）
- **#11** `linkAttackTax→attackTax[]`（appliesTo/sourcePosition/controller/payer/targetFilter/onFail）・`cannotAttackZones→continuous restrictAttackTargets(sameInstanceAsSource)`（`07e9ee4`）
- **#4** legacy handler script を `LEGACY_HANDLER_SCRIPTS` データ表化（後方互換契約のため dispatch は温存＝全廃しない判断、`6d5383d`）
- **#13** `destroy{target|scope|$self+options}`（旧destroyAll/destroySelf吸収・破壊耐性の非対称は options で温存）・`modifyStats{scope|conditions|amountFrom|by}`（旧modifyStatsAll/IfTargetAttribute/IfTargetName/ByDropAttributeCount吸収）・継続stat bonus 3関数を `continuousStatBonus` に集約・量参照プリミティブ `resolveAmountFrom`(fieldCardStat/weaponPowerMax/dropCount)＋`collectFieldTargets` 新設（`4f7729f`）。別軸機構（per-stat copy・対話select・script var）は専用opとして温存。

### 全720枚レビュー（rules⇔実装の忠実性）
16並列レビュー＋敵対的検証で**確定バグ24件**を検出。**全件リファクタ起因ではなく既存のデータ側不具合**でリファクタの挙動保存を確認。明確・低リスクの10カード（＋兄弟2枚）を rules/兄弟照合で修正（`6785872`）。残り14件はエンジン機能追加 or 設計判断が必要で `docs/全カードレビュー報告_2026-06-23.md` に優先度付きで列挙（メガブラスト bt03-0030/s005 は過去docs記録の設計判断のため要確認）。

## 2026-06-23 追記(2): 全カードレビュー確定24件を全修正

レビュー（前述）で確定した24件（いずれもリファクタ非起因の既存データ不具合）を修正。明確10件＋兄弟2件を `6785872`、残り14件をエンジン部品追加で `d96fa9b`〜`7589f5f`。詳細は `docs/全カードレビュー報告_2026-06-23.md`。

追加した汎用部品: `soulCountLte/soulCountGte`(filter)、条件 `buddyMatches`、effect `returnSelfToHand`/`dischargeSelfFromHostSoul`、`moveSelfToTargetSoul` 手札ソース対応、`dropOwnMonster` コストの `excludeSource`、cost `returnPendingTargetToHand`、trigger `discardedFromHand`(+`discardHandCardsToDrop`)、`destroyTriggerUsesSoul`(破壊時ソウル遅延)、`linkAttackDamageReceivedTo`(連携被ダメージ上限)。

~~唯一の既知の限界: bt04-0002/s002「サイズ3の武装騎竜がいるとして扱う」は仮想モンスター機構が必要なため未実装~~ → **その後、仮想モンスター機構 `countsAsFieldMonster`（src/13 `phantomFieldMonsters`）で実装済み**（在否・枚数条件で参照。対象選択・継続バフには含めない）。この記述は古い。

## 2026-06-23 追記(3): TD06「暗黒竜 凶襲」実装＋既存TD/SD整理

- 公式(fc-buddyfight.com)で製品同定: 印刷カードNoは TD01〜TD06 連番（500円スタートデッキ3＋トライアルデッキ3）。既存td01-05のファイル名はカードNoと一致＝正しい。空だった product 欄に正式名・種別(SD/TD)を記録。
- **TD06 暗黒竜凶襲(ダークネスドラゴンW) 全19枚**を td06-darkness-dragon-assault.json に実装（`fb6f700`）。効果は既存プリミティブ＋新規 `opposingFront`（「前の相手モンスター」継続=ミラー列）。
- 3レビュアー＋敵対的検証で確定バグ1件（アーレアの前列判定がミラー列でなく同名zoneだった）→ `oppositeFieldZone` で修正（`8b59aac`）。詳細 `docs/TD06実装報告_2026-06-23.md`。
- 検証: effects regression ok / 全739枚スモーク（重複0・冪等0違反・旧op残存0）。

## 2026-06-23 追記(4): BT05「煉獄ナイツ」全147枚 実装

- 公式 expansion=21。BT05/0001-0135＋S001-S012=147枚（モンスター92/魔法39/アイテム7/必殺技9、ダークネスドラゴンW中心）。
- サブエージェント7班で起草→生成→7班レビュー＋敵対的検証。確定バグ10件修正。詳細 `docs/BT05実装報告_2026-06-23.md`。
- 追加エンジン部品: nullifyAttackersKeyword / triggered event battleEnd / dealDamage の amountFrom(selectedCardStat) / discardHand player:opponent / putDropToSoul の min ゲート / matchesCardFilter powerGte・criticalGte等。
- 残り約30枚は専用機構(サイズ修整/コール制限/カード名エイリアス/搭乗/scry/setLife/新フィールドイベント等)が必要で近似据え置き（BT04初期同様、後続で汎用化）。
- 検証: effects regression ok / 全886枚スモーク（重複0・冪等0違反・旧op残存0）。

## 2026-06-23 追記(5): PP01「ゴールデンバディパック」全58枚 実装

- 公式 expansion=22。PP01/0001-0058=58枚（モンスター57＋アイテム1、全9世界）。
- 16枚=既存実装の再録(spec再利用・ability id を pp01 へ再接頭辞化)、42枚=新規(4班起草)。
- レビューは0-15枚目がワークフロー(バグ0)、15-58枚目はセッション上限で失敗→自己レビュー。確定バグ2件修正。詳細 `docs/PP01実装報告_2026-06-23.md`。
- 追加部品: resolveAmountFrom の targetStat source（対象$targetのstat/size参照）。0033の破壊対象サイズ分ダメージ。
- 残り約10枚は専用機構(preventDraw/allySpellCast誘発/attackNullified誘発/fieldStatSum/ソウル越し耐性付与等)が必要で近似据え置き。
- 検証: effects regression ok / 全944枚スモーク（重複0・冪等0違反・旧op残存0）。

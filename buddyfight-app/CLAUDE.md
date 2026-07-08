# バディファイト再現アプリ

## プロジェクト情報

- ステータス: active（個人プロジェクト・非SDD。Codex 試作を 2026-06-10 に引き継ぎ本開発中）
- 技術スタック: Vanilla JS/HTML/CSS（ビルド工程なし）、Node.js >=18（ネット対戦サーバー・回帰テスト・スモーク）
- 配置: `/home/fuji25840/dev_okuhara/simu_app/buddyfight-app-export/`（ここが開発本体）
- Git: ブランチ `main` 直コミットが基本。並行セッション時のみ worktree（`.claude/worktrees/`）→ `git merge --ff-only` で main へ。GitHub リモート無し。

## 概要

「フューチャーカード バディファイト」のWeb再現アプリ。ローカル対戦（`index.html`）・権威サーバ式ネット対戦（`play.html`）・デッキ構築（`builder.html`）を持つ。カード効果は JSON のデータ駆動エンジン（`conditions`/`cost`/`target`/`effects`/`script`）で処理し、**34製品・計2,089枚**を実装済み（無印17製品＋バディファイト100(H)14製品＋S弾特例3製品[S-UB-C03本体・同アイドルレア別絵74枚・PRカード3枚]。一覧の正は `data/cardsets.json`。全カード画像パック同梱）。対象内（無印+H）は31製品1,917枚で不変。

## 絶対に守る制約

- ルールは **神バディファイト開始前＝2018年6月以前（詳細ルール ver.2.05）** に固定。以降の追加要素・裁定変更は採用しない。
  - 製品記号の凡例（間違えやすい）: **S＝神バディファイト ／ X＝バッツ ／ D＝DDD ／ H＝バディファイト100（ハンドレッド）**。シリーズ順は 無印 → H(100) → D → X → S(神)。**対象内＝無印・H・X・D、対象外＝S(神)**（例外: S-UB-C03 アイドルマスター シンデレラガールズ劇場のみユーザー明示の特例で収録。派生の別絵アイドルレア74枚[`bf-s-ub-c03-idolrare`]・フラッグPR3枚[`bf-s-pr`]・公式レシピ11本も同特例の範囲内）。実装済みの `bf-h-*` はバディファイト100であり対象内。
  - ルール基準文書: `buddyfight_rule_ver205.pdf`（リポジトリ直下・git 管理外）。
- 日本語UI・日本語カード情報。情報源はブシロード公式日本語カードリスト（`fc-buddyfight.com`。海外版は使わない）。
- カードの `rules`（表示用効果文）には**公式カードテキストをそのまま入れる**（空だとUIに「能力なし」表示）。効果実装も公式テキスト通り（要約・独自解釈で変えない。例外はユーザー明示時のみ）。※旧方針「全文転載禁止・要約のみ」は廃止済み。
- カード効果の修正時は、効果本体のテストだけでなく **実操作経路（`useCardAction`/`callMonster`/`resolvePendingResolution` 等）を通す回帰テスト**を `tests/effects-regression.test.js` に追加する。
- サーバーの実動検証はユーザーが起動した場合のみ。こちらからは起動しない（基本は node の静的/ロジック検証）。
- エンジン改変は後方互換絶対。既存カードJSONは原則無改変（旧op/旧フラグはロード時 desugar で新DSLに吸収する方式）。

## コード構成（対戦エンジン）

対戦エンジンは `src/01-foundation.js`〜`src/22-ai.js` の **22モジュール（計約16,000行超）**。旧 `app.js`（単一ファイル）は 2026-06-25 に分割済みで**存在しない**。

- バンドラ無し。**classic script を番号順に `<script>` 読み込み**し、全モジュールが同一グローバルスコープを共有（`elements`/`state` 等を相互参照）。
- ロード順: `01` 定数・共有状態・DOM参照 → `02`〜`20` 機能別関数群 → `21` イベント登録・起動（`__BUDDYFIGHT_SERVER__`/`__BUDDYFIGHT_THIN__` 分岐あり）→ `22` CPU対戦AI（OFF時は全フック素通り）。新しい関数は責務が近いモジュールへ（配置表は `.claude/skills/buddyfight-card-pack/SKILL.md` §4）。
- ローダは `index.html`（ローカル・フルエンジン）/ `play.html`（権威サーバ版シンクライアント）/ `tests/*-browser-smoke.html`。**src/ にモジュールを増やしたらこれらにも `<script>` を追加**（回帰テストは src/ を番号順連結して vm 実行するため変更不要）。
- `netplay.html`/`netplay-server.js` は旧・中継版で**非使用**（ファイル残置・保守不要）。ネット対戦は権威サーバ版（`server/authoritative-server.js`＋`server/engine-host.js`＋`play.html`）に一本化。

## 検証コマンド（コミット前に必ず）

```bash
for f in src/*.js; do node --check "$f"; done   # 全モジュール構文チェック（出力なし=OK）
node tests/effects-regression.test.js            # 期待出力: effects regression ok
```

サーバ/builder を触った時は追加で:

```bash
node server/engine-host.smoke.js                 # 期待: === engine-host walking skeleton OK ===
node server/authoritative-server.smoke.js        # 期待: 各シナリオ [ok]
node server/persistence.smoke.js
node tests/builder-kakuou.smoke.js               # 期待: === builder 角王(deckAnyFlag) smoke OK (7 flags) ===
node tests/ai-vs-ai.smoke.js                     # CPU対戦(src/22)を触った時。期待: === ai-vs-ai smoke OK (6 games) ===
node tests/ai-behavior.test.js                   # 同上（片席CPU・対人間インタラクション）。期待: ai behavior ok
PLAYWRIGHT_BROWSERS_PATH=0 node e2e/online-smoke.mjs   # ブラウザe2e（任意）
```

## 起動（参考。実動検証はユーザー起動が前提）

- ローカル対戦: 静的サーバーで `index.html`（Windows: `起動.bat`/`server.ps1`、WSL2: `python3 -m http.server` 等）
- ネット対戦: `node server/authoritative-server.js --port 4174` → `play.html`（Windows: `権威起動.bat`）。**play.html は権威サーバのポート経由で開く**（静的サーバだと `/auth/*` が無く繋がらない）
- デッキ構築: `builder.html`

## ドキュメント地図

| ファイル | 役割 |
|---|---|
| `.claude/skills/buddyfight-card-pack/SKILL.md` | **カード実装の主ドキュメント**（手順・DSL語彙・プリミティブカタログ・落とし穴） |
| `HANDOFF.md` | 生きた引き継ぎ（実装状態・ルール裁定メモ・実装履歴・残課題） |
| `docs/オンライン対戦実装_引き継ぎ_2026-06-25.md` | 権威サーバ版ネット対戦の実装ノート（アーキテクチャ・プロンプト往復・promptSeat・永続化・デプロイ） |
| `docs/オンライン対戦権威サーバ設計_2026-06-25.md` | 権威サーバ化の設計の正 |
| `docs/CPU対戦_設計メモ_2026-07-02.md` | CPU対戦（設計確定・未実装）。実装するならまずこれ |
| `docs/BF-H-*_実装メモ_*.md`・各実装報告/レビュー報告 | 各パックの実装詳細・新規op・意図的近似・レビュー結果 |
| `docs/codex開発ログ.md` | 旧 Codex 会話ログ全文（32,731行。原本 `ログ.md`＝cp932・git 管理外） |
| `README.md` | 機能一覧・操作説明書（唯一の説明書。旧 MANUAL.md 等は統合済み） |

## 運用メモ

- 配布 zip: 原則差分 zip。方針と現在の基準コミットは memory `zip-packaging-policy` が正（ここには書かない）。
- 上書き/削除前は前版をバックアップ（memory `keep-previous-versions`。git 管理外ファイルは `.bak`）。
- Windows 配布物の md/txt は UTF-8(BOM付)+CRLF、`.bat` は BOMなし+CRLF（BOM 付きは cmd 誤動作）。

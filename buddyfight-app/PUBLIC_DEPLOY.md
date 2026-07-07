# 公開ネット対戦サーバー化

常時起動できるNode.jsホストにこのフォルダを置くと、ネット越しの相手と部屋番号で対戦できます。
**推奨は権威サーバ版（`/play.html`）** ＝ サーバが唯一のエンジンを持ち、各プレイヤーには自分視点だけを配信するので **手札・山札が相手に渡りません**。

---

## 権威サーバ版（推奨・手札秘匿・観戦・再接続・再起動復元）

### 起動コマンド / ヘルスチェック
- Start command: `npm run start:auth`（＝`node server/authoritative-server.js --host 0.0.0.0`。`start:public` も同じ）
- Health check path: `/healthz`（`{ok:true,rooms:N}` を返す）
- ポート: 環境変数 `PORT` を自動採用（無ければ 4174）。`HOST` も env 対応。
- Node: 18以上。依存パッケージはゼロ（バニラ）なので `npm install` は不要。
- 公開後に開くURL: `https://<公開ドメイン>/play.html`

### 同梱の設定ファイル
- `Dockerfile` … `node:20-slim`＋`CMD node server/authoritative-server.js --host 0.0.0.0`、`/healthz` HEALTHCHECK付き。
- `fly.toml` … Fly.io 用。`internal_port=8080`／`PORT=8080`／`auto_stop_machines=false`（SSE常時接続を切らない）／`/healthz` チェック。
- `Procfile` … Railway/Render/Heroku 系 buildpack 用（`web: node server/authoritative-server.js --host 0.0.0.0`）。
- `.dockerignore` … テスト/e2e/docs 等を除外。

### Fly.io
```sh
fly launch         # 既存 fly.toml を検出
fly deploy
```
- `fly.toml` の `internal_port` と env `PORT` を一致させる（同梱は 8080）。
- 再起動越えの局面復元（下記P4）を使うなら永続ボリュームを作成しマウント:
  ```sh
  fly volumes create auth_data --size 1
  ```
  `fly.toml` の `[mounts]`（コメント参照）を有効化し、`AUTH_DATA_DIR=/data/auth` を保存先にする。

### Railway / Render
- `Procfile` の start command（または `npm run start:auth`）を指定。`PORT` は自動注入。
- 永続化を使うなら永続ディスクを割り当て `AUTH_DATA_DIR` をそのパスに向ける。

### VPS（pm2 等）
```sh
PORT=8080 AUTH_DATA_DIR=/var/lib/buddyfight-auth pm2 start "npm run start:auth"
```
- リバースプロキシ（Nginx 等）では **SSE のため response buffering を無効化**すること（`proxy_buffering off;`）。サーバは `X-Accel-Buffering: no` を送出済みだが、CDN/プロキシ側の設定も必要。Cloudflare 等を挟む場合もバッファリング無効化／長時間接続許可を確認。

### 永続化（P4・再起動耐性）
- 進行中ゲーム（局面＋部屋メタ＋席割＋メンバートークン）を `AUTH_DATA_DIR`（既定: リポジトリの兄弟 `../buddyfight-auth-data`）にJSON保存し、再起動/再デプロイ後に復元します。
- このディレクトリは **web root の外**に置くこと（トークンを含むため。サーバ側にも静的配信deny の二重防御あり）。本番ではホストの永続ボリュームをマウントしてください。

### 再接続（P3）
- リロード/瞬断しても `localStorage` の席トークンで同席復帰し、現局面と未応答プロンプトが再配信されます（手動操作不要）。相手切断中は「待機中」を表示。

---

## デッキ共有コード（クロスデバイス持ち寄り）

`builder.html`（デッキ構築）で **「共有コード発行」** を押すと `BFD1.…` の共有コードが出ます。相手はそのコードを欄に貼って **「共有コード取込」**。デッキ名／フラッグ／バディ／レシピ（カードID）が復元され、別端末でも同じデッキを持ち寄れます。

---

> ネット対戦は権威サーバ版（`/play.html`）に一本化しています。旧・中継版（`netplay.html` / `netplay-server.js`）は使用しません。

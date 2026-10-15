// エンジン版（ENGINE_VERSION）のサーバ側の読み口。
// 正（single source of truth）は index.html の `var ENGINE_VERSION = "..."`（キャッシュバスターと同じ1定数）。
// play.html / replay.html の ENGINE_VERSION は index.html と同値であることを tests/load-perf.smoke.js が固定している。
// サーバはこの値を起動時（初回 require 時）に1度だけ読み、
//   - engine-host が新しい記録へ engineVersion として刻む（src/23 replayStartRecording が __BUDDYFIGHT_ENGINE_VERSION を読む）
//   - authoritative-server が保存済みリプレイの版と比べ、旧版を削除/410 にする（2026-10-09 オーナー裁定:
//     「リプレイについてはバージョンアップ時に前のは消していい」）
// に使う。ENGINE_VERSION を上げる＝旧版のリプレイは再生不可になる（サーバ再起動時に削除）。
"use strict";

const fs = require("fs");
const path = require("path");

const INDEX_HTML = path.resolve(__dirname, "..", "index.html");
const PATTERN = /\bvar\s+ENGINE_VERSION\s*=\s*"([^"]+)"/;

function parseEngineVersion(html) {
  const m = String(html || "").match(PATTERN);
  return m ? m[1] : null;
}

let cached = null;
function engineVersion() {
  if (cached == null) {
    const version = parseEngineVersion(fs.readFileSync(INDEX_HTML, "utf8"));
    if (!version) {
      // 黙って null で動くと全リプレイが「旧版」扱いで消える。読めない時は起動時点で明確に落とす。
      throw new Error(`engine-version: ${INDEX_HTML} から ENGINE_VERSION を読み取れません`);
    }
    cached = version;
  }
  return cached;
}

module.exports = { engineVersion, parseEngineVersion };

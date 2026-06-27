// 差し替え可能なファイルJSON永続バックエンド（P4・再起動耐性）。
// authoritative-server から room の plain snapshot を受け取り、room毎に1ファイルで保存/列挙/削除する。
// 小規模・低頻度のため同期FSで十分。将来 SQLite/KV へ I/F(save/loadAll/delete) のまま差し替え可能。
// 注意: snapshot は member.token を含むため、保存先 dataDir は web root の外に置くこと（静的配信で漏れない）。
const fs = require("fs");
const path = require("path");

let dir = null;

module.exports = {
  init({ dataDir }) {
    dir = dataDir;
    fs.mkdirSync(dir, { recursive: true });
  },
  dir() {
    return dir;
  },
  save(roomId, snapshot) {
    if (!dir) return;
    const file = path.join(dir, `${roomId}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, file); // アトミック差し替え（書込み途中の半端ファイルを読ませない）
  },
  delete(roomId) {
    if (!dir) return;
    try {
      fs.unlinkSync(path.join(dir, `${roomId}.json`));
    } catch {
      /* 無ければ無視 */
    }
  },
  loadAll() {
    if (!dir) return [];
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        out.push(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        console.warn(`[room-store] 破損スナップショットをスキップ: ${name}`);
        try {
          fs.renameSync(file, `${file}.bad`);
        } catch {
          /* noop */
        }
      }
    }
    return out;
  },
};

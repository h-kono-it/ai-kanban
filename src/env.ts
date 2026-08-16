// .env があれば読む。無ければ何も言わずに環境変数だけで動く。
//
// node の --env-file-if-exists フラグでも同じことができるが、ファイルが無いと
// 「.env not found. Continuing without it.」を毎回 stderr に出す。.env は
// gitignore 対象＝無いのが既定の状態なので、初回起動でいきなりこれが出ると
// 設定漏れを疑わせてしまう。実害のない通知なので黙らせる。
//
// server.ts の一番最初に import すること（他のモジュールが process.env を読む前に
// 読み込まれる必要がある）。
try {
  process.loadEnvFile(".env");
} catch {
  // 無ければ環境変数だけで動く。既定値は各所の ?? で持っている。
}

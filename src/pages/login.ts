// パスフレーズ入力画面。PASSPHRASE が設定されているときだけ使われる。

import { html } from "hono/html";

/**
 * next はログイン後の戻り先。safeNext() を通した値だけを渡すこと（open redirect 防止）。
 * XSS: value="${next}" は hono/html が自動エスケープするので、属性を抜けられない。raw() は使わない。
 */
export function loginPage(next: string, error?: boolean) {
  return html`<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ログイン - AI Kanban</title>
    <link rel="stylesheet" href="/login.css" />
  </head>
  <body>
    <div class="wrap">
      <h1>AI Kanban</h1>
      <p>パスフレーズを入力してください</p>
      ${error ? html`<p class="error">パスフレーズが違います</p>` : ""}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${next}" />
        <input type="password" name="passphrase" placeholder="パスフレーズ" autocomplete="current-password" autofocus />
        <button type="submit">ログイン</button>
      </form>
    </div>
  </body>
</html>`;
}

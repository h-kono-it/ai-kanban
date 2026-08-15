// ボード画面のシェル。中身は空で、public/app.js が WebSocket から state を受け取って描く。
// JSX は使えない（Node のネイティブ型ストリップは JSX を変換しない）ので hono/html を使う。

import { html } from "hono/html";

/**
 * ヘッダーの各要素の id は public/app.js が前提にしている契約。変えるときは両方直すこと。
 * XSS: id はテンプレートリテラルの ${} 経由なので hono/html が自動でエスケープする。
 * さらに server.ts の boardIdGuard が [A-Za-z0-9_-] しか通さないので二重に安全。raw() は使わない。
 */
export function boardPage(id: string) {
  return html`<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Kanban</title>
    <link rel="stylesheet" href="/board.css" />
    <link rel="stylesheet" href="/tree.css" />
  </head>
  <body data-board-id="${id}">
    <header>
      <h1 id="board-title">接続中…</h1>
      <span id="conn-status" class="conn-status"></span>
      <nav id="view-tabs">
        <button class="view-tab" data-view="tree">🌳 ツリー</button>
        <button class="view-tab" data-view="kanban">📋 カンバン</button>
      </nav>
      <span id="awaiting-badge" class="awaiting-badge" hidden></span>
      <button id="add-goal-btn" class="manage-btn">＋ 目的</button>
      <button id="filter-btn" class="manage-btn">🔍 フィルター</button>
      <button id="manage-btn" class="manage-btn">👥 メンバー管理</button>
    </header>
    <main id="view-root"></main>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;
}

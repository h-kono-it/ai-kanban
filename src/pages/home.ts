// トップページ。ボード一覧と作成フォームを SSR で出すだけで、クライアント JS は使わない。

import { html } from "hono/html";
import type { BoardSummary } from "../store.ts";

/**
 * XSS: タイトルも id も ${} 経由なので hono/html が自動エスケープする。
 * ボードタイトルはユーザー入力（POST / のフォームや API から）がそのまま入るため、
 * ここを raw() に変えると即 XSS になる。絶対に raw() を使わないこと。
 */
export function homePage(boards: BoardSummary[]) {
  return html`<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Kanban</title>
    <link rel="stylesheet" href="/home.css" />
  </head>
  <body>
    <div class="wrap">
      <h1>AI Kanban</h1>
      ${boards.length === 0
        ? html`<p class="empty">まだボードがありません。下のフォームから最初のボードを作ってください。</p>`
        : html`<ul class="board-list">
            ${boards.map(
              (board) => html`<li class="board-item">
                <a href="/${board.id}">${board.title}</a>
                <span class="board-meta">${board.nodeCount} ノード / ${board.createdAt.slice(0, 10)} 作成</span>
              </li>`,
            )}
          </ul>`}
      <p>新しいボードを作る（ID を空にすると自動採番）</p>
      <form method="post" action="/">
        <input name="title" placeholder="ボード名" autocomplete="off" />
        <input name="id" placeholder="ID（任意・例: conf2026）" autocomplete="off" />
        <button type="submit">作成</button>
      </form>
    </div>
  </body>
</html>`;
}

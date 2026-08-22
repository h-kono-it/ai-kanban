// トップページ。ボード一覧と作成フォームを SSR で出すだけで、クライアント JS は使わない。
// アーカイブの開閉も <details> でやる（JS を持ち込まないため）。

import { html } from "hono/html";
import type { BoardSummary } from "../store.ts";

/**
 * XSS: タイトルも id も ${} 経由なので hono/html が自動エスケープする。
 * ボードタイトルはユーザー入力（POST / のフォームや API から）がそのまま入るため、
 * ここを raw() に変えると即 XSS になる。絶対に raw() を使わないこと。
 */
export function homePage(boards: BoardSummary[]) {
  // listBoards() は最終更新の新しい順で返す。畳むかどうかだけここで振り分ける。
  const active = boards.filter((b) => !b.archived);
  const archived = boards.filter((b) => b.archived);

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
      ${active.length === 0
        ? html`<p class="empty">
            ${archived.length > 0
              ? "表示中のボードはありません（アーカイブ済みは下にあります）。"
              : "まだボードがありません。下のフォームから最初のボードを作ってください。"}
          </p>`
        : html`<ul class="board-list">
            ${active.map((board) => boardRow(board))}
          </ul>`}
      ${archived.length === 0
        ? ""
        : html`<details class="archived">
            <summary>アーカイブ済み ${archived.length} 件</summary>
            <ul class="board-list">
              ${archived.map((board) => boardRow(board))}
            </ul>
          </details>`}
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

function boardRow(board: BoardSummary) {
  return html`<li class="board-item">
    <a href="/${board.id}">${board.title}</a>
    <span class="board-meta" title="最終更新 ${board.updatedAt} / ${board.createdAt.slice(0, 10)} 作成">
      ${board.nodeCount} ノード / ${relativeTime(board.updatedAt)}更新
    </span>
    <form method="post" action="/${board.id}/archive" class="archive-form">
      <input type="hidden" name="archived" value="${board.archived ? "0" : "1"}" />
      <button type="submit" class="archive-btn">${board.archived ? "戻す" : "アーカイブ"}</button>
    </form>
  </li>`;
}

/**
 * 「3日前」の形。SSR なので描画時刻で固定される（この画面はリロードで作り直される前提）。
 * 1週間を超えたら日付そのものを出す。相対表記のまま古くなると、かえって粒度が読めないため。
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "?";
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days}日前`;
  return iso.slice(0, 10);
}

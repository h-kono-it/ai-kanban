// エントリポイント。ヘッダーの配線と、ビュー切替を含む render() の登録。
//
// render() は state が変わるたびに丸ごと呼ばれる（全再描画）。開いている popover / modal は
// モジュール変数に持ち、render() の末尾で renderXxx() を再実行して復元する作法。
// 後続タスクの modals.js も同じ流儀でここにぶら下がる想定。

import { board, breadcrumb, el, makeEditable, nodeById, onRender, rerender, ui } from "./state.js";
import { renderKanban } from "./kanban.js";
import { renderTree, revealNode } from "./tree.js";
import {
  openAddGoalModal,
  openManageModal,
  openNodeDetail,
  renderModals,
  toggleFilterPopover,
} from "./modals.js";
import { connect, send } from "./ws.js";

const boardId = document.body.dataset.boardId;
const titleEl = document.getElementById("board-title");
const viewRoot = document.getElementById("view-root");
const viewTabs = document.getElementById("view-tabs");
const awaitingBadge = document.getElementById("awaiting-badge");

// 選択中のビューはボードごとに覚える（別のボードでは別の見方をしたいことが多いため）。
const VIEW_KEY = `ai-kanban:view:${boardId}`;

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function render() {
  // 接続直後、まだ {type:"state"} が届いていないうちは何も描かない。
  if (!board) return;

  titleEl.textContent = board.title;
  renderAwaitingBadge();
  renderViewTabs();

  viewRoot.innerHTML = "";
  if (ui.scopeId !== null) viewRoot.append(renderScopeBar());

  if (ui.view === "tree") {
    renderTree(viewRoot);
  } else {
    renderKanban(viewRoot);
  }

  // ?node=<id> のパーマリンク。state が届いた最初の render() の1回だけ開く
  // （以降の再描画で毎回開き直すと、閉じたモーダルが勝手に復活してしまう）。
  if (!didAutoOpenDetail) {
    didAutoOpenDetail = true;
    if (nodeParam && nodeById(nodeParam)) openNodeDetail(nodeParam);
  }

  // 開いているモーダル / ポップオーバーの復元。全再描画なので、ここで作り直さないと
  // 他クライアントの Op が1つ届いただけで開いていた UI が消える。
  renderModals();
}

/** 「要対応 n 件」。awaiting_human 列にいるノード＋未承認の提案の合計。 */
function renderAwaitingBadge() {
  let count = 0;
  for (const list of board.lists) {
    if (list.role === "awaiting_human") count += list.nodeIds.length;
  }
  for (const node of Object.values(board.nodes)) {
    if (node.state === "proposed") count += 1;
  }
  awaitingBadge.textContent = `要対応 ${count} 件`;
  awaitingBadge.hidden = count === 0;
}

function renderViewTabs() {
  for (const tab of viewTabs.querySelectorAll(".view-tab")) {
    tab.classList.toggle("active", tab.dataset.view === ui.view);
  }
}

/**
 * スコープ表示。設定は ツリーの［絞り込み］、解除はここと ツリーの［解除］の両方から。
 * 絞り込みが効くのはカンバンだけ（ツリーは構造を直す画面なので常に全体を出す）ので、
 * どちらのビューから見ても誤解しない文面にしてある。
 * .scope-bar のスタイルは tree.css 側にある（カンバンにも出る要素なのであちらで定義済み）。
 */
function renderScopeBar() {
  const bar = el("div", "scope-bar");

  const node = nodeById(ui.scopeId);
  const path = [...breadcrumb(ui.scopeId), node ? node.title : ""].filter(Boolean).join(" › ");
  bar.append(el("span", null, `カンバンは「${path}」の配下のみ表示中（ツリーは全体を表示します）`));

  const clear = el("button", null, "✕");
  clear.title = "絞り込みを解除";
  clear.addEventListener("click", () => {
    ui.scopeId = null;
    rerender();
  });
  bar.append(clear);
  return bar;
}

// ---------------------------------------------------------------------------
// ヘッダーの配線
// ---------------------------------------------------------------------------

// ボード名はクリックでインライン編集。
makeEditable(titleEl, (title) => send({ type: "renameBoard", title }));

function setView(view) {
  ui.view = view === "tree" ? "tree" : "kanban";
  try {
    localStorage.setItem(VIEW_KEY, ui.view);
  } catch {
    // プライベートモード等で localStorage が使えなくても表示は続けられる
  }
}

viewTabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".view-tab");
  if (!tab) return;
  setView(tab.dataset.view);
  rerender();
});

/** ツリー順（深さ優先）で最初の未承認ノード。無ければ null。 */
function firstProposedNodeId() {
  const visit = (ids) => {
    for (const id of ids) {
      const node = nodeById(id);
      if (!node) continue;
      if (node.state === "proposed") return id;
      const found = visit(node.childIds);
      if (found) return found;
    }
    return null;
  };
  return visit(board.rootIds);
}

// 「要対応」バッジ: 人間が止めているものへ最短で連れて行く。
// 未承認の提案はカンバンに出ない＝画面のどこにも見えないので、そちらを優先する。
// ツリーができたので、詳細モーダルを開くのではなく「ツリーへ切り替えて最初の提案まで
// スクロールする」。提案はたいてい一度にまとまって届くので、1件だけを拡大するより
// 兄弟や親子関係ごと見えた方が承認するか決めやすく、そのまま［配下ごと承認］も押せる。
// 個別に中身を読みたければ、その行をクリックすれば詳細モーダルが開く。
awaitingBadge.addEventListener("click", () => {
  if (!board) return;
  const proposed = firstProposedNodeId();
  if (proposed) {
    // 畳んだ中に埋まっていると切り替えても見えないので、祖先を開いてから描き直す。
    revealNode(proposed);
    setView("tree");
    rerender();
    const row = document.querySelector(`.tree-row[data-node-id="${proposed}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    // どの行に来たのかを一瞬だけ示す（次の再描画で消えて構わない類の演出）。
    row.style.boxShadow = "0 0 0 2px #58a6ff";
    setTimeout(() => {
      row.style.boxShadow = "";
    }, 1500);
    return;
  }
  // 絞り込み中だと対象が隠れていることがあるので、解除してからカンバンへ。
  ui.scopeId = null;
  setView("kanban");
  rerender();
  const target =
    board.lists.find((l) => l.role === "awaiting_human" && l.nodeIds.length > 0) ??
    board.lists.find((l) => l.role === "awaiting_human");
  if (!target) return;
  const listEl = document.querySelector(`.list[data-list-id="${target.id}"]`);
  if (listEl) listEl.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
});

document.getElementById("add-goal-btn").addEventListener("click", () => openAddGoalModal());

document.getElementById("filter-btn").addEventListener("click", (e) => {
  // 開いたクリック自身が「外側クリック」と見なされて即閉じるのを防ぐ。
  e.stopPropagation();
  toggleFilterPopover();
});

document.getElementById("manage-btn").addEventListener("click", () => openManageModal());

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

// 前回のビューを復元してから最初の描画に入る。
try {
  const saved = localStorage.getItem(VIEW_KEY);
  if (saved === "tree" || saved === "kanban") ui.view = saved;
} catch {
  // 読めなければ既定（カンバン）のまま
}
renderViewTabs();

// ?node=<id> のパーマリンク。render() の中で、state が届いた最初の1回だけ開く。
const nodeParam = new URLSearchParams(location.search).get("node");
let didAutoOpenDetail = false;

onRender(render);
connect(boardId);

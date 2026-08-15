// カンバンビューの描画と DnD。
//
// カンバンは「ツリーのビュー」。列に並べるのは list.nodeIds のうち葉ノードだけで、
// 親（目的・機能）は箱なのでカードにしない。proposed のノードはそもそもサーバーが
// lists[].nodeIds に載せないので、ここで state を見なくても自然に出てこない。
//
// 全再描画。状態が変わるたびに DOM を作り直す（差分更新はしない）。

import {
  board,
  breadcrumb,
  descendantIds,
  el,
  isLeaf,
  makeEditable,
  nodeById,
  ui,
} from "./state.js";
import { openDeleteListConfirm, openNodeDetail, toggleAssigneePopover } from "./modals.js";
import { send } from "./ws.js";

/**
 * ドラッグ直後に飛んでくる click を1回だけ食い潰すフラグ。
 * これが無いと、カードをドラッグして離した瞬間に click が発火し、
 * 意図せず詳細モーダルが開く（旧 my-kanban で実際に起きた問題の対処をそのまま移植）。
 */
let suppressNextCardClick = false;

/**
 * カンバンを root（#view-root）の中に描く。root を空にするのは呼び出し側（app.js）の責務。
 * board.css の #lists がカードの列を横並びにする。
 */
export function renderKanban(root) {
  const listsEl = el("div");
  listsEl.id = "lists";

  // ui.scopeId が立っていたらその子孫だけを出す（scope 自身は含めない）。
  const scoped = ui.scopeId === null ? null : new Set(descendantIds(ui.scopeId));

  for (const list of board.lists) {
    listsEl.append(renderList(list, scoped));
  }

  // 列の追加。列の削除と違って取り返しがつくので、確認 UI なしでそのまま置く。
  const addListWrap = el("div", "add-list");
  const addListForm = el("form", "add-list-form");
  const addListInput = el("input");
  addListInput.placeholder = "＋ 新しい列を追加";
  addListForm.append(addListInput);
  addListForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = addListInput.value.trim();
    if (!title) return;
    send({ type: "addList", title });
    addListInput.value = "";
  });
  addListWrap.append(addListForm);
  listsEl.append(addListWrap);

  // 列の並べ替え。カードの drop は .cards 側で stopPropagation しているのでここには来ない。
  listsEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/plain")) return;
    e.preventDefault();
  });
  listsEl.addEventListener("drop", (e) => {
    const payload = readPayload(e);
    if (!payload || payload.kind !== "list") return;
    e.preventDefault();
    send({ type: "moveList", id: payload.id, beforeId: beforeIdFromX(listsEl, e.clientX) });
  });

  root.append(listsEl);
}

// ---------------------------------------------------------------------------
// 列
// ---------------------------------------------------------------------------

function renderList(list, scoped) {
  const listEl = el("div", "list");
  listEl.dataset.listId = list.id;
  listEl.draggable = true;

  listEl.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "list", id: list.id }));
    e.dataTransfer.effectAllowed = "move";
    // 位置計算から自分を外すためのクラス。CSS が無くても :not(.dragging) が効けばよい。
    setTimeout(() => listEl.classList.add("dragging"), 0);
  });
  listEl.addEventListener("dragend", () => listEl.classList.remove("dragging"));

  // この列に出す葉ノード。並びは list.nodeIds そのまま。
  const nodes = [];
  for (const id of list.nodeIds) {
    const node = nodeById(id);
    if (!node || !isLeaf(node)) continue;
    if (scoped && !scoped.has(node.id)) continue;
    nodes.push(node);
  }

  listEl.append(renderListHeader(list, nodes.length));

  const cardsEl = el("div", "cards");
  cardsEl.dataset.listId = list.id;
  for (const node of nodes) cardsEl.append(renderCard(node));

  cardsEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/plain")) return;
    e.preventDefault();
    e.stopPropagation();
    listEl.classList.add("drag-over");
  });
  cardsEl.addEventListener("dragleave", () => listEl.classList.remove("drag-over"));
  cardsEl.addEventListener("drop", (e) => {
    e.preventDefault();
    // 列の並べ替えハンドラ（#lists）に二重に拾わせない。
    e.stopPropagation();
    listEl.classList.remove("drag-over");
    const payload = readPayload(e);
    if (!payload || payload.kind !== "card") return;
    send({ type: "moveCard", id: payload.id, listId: list.id, beforeId: beforeIdFromY(cardsEl, e.clientY) });
  });
  listEl.append(cardsEl);

  const addForm = el("form", "add-card-form");
  const addInput = el("input");
  addInput.placeholder = "＋ カードを追加";
  addForm.append(addInput);
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = addInput.value.trim();
    if (!title) return;
    // scope 配下ならその子として、未設定ならルート直下（＝新しい目的）として作る。
    send({ type: "addNode", parentId: ui.scopeId, listId: list.id, title, kind: "task" });
    addInput.value = "";
  });
  // フォームの入力欄にフォーカスしたまま列をドラッグされないように。
  addInput.addEventListener("dragstart", (e) => e.preventDefault());
  listEl.append(addForm);

  return listEl;
}

function renderListHeader(list, count) {
  const header = el("div", "list-header");

  // .list-header は space-between なので、左側（タイトル＋印＋件数）をひとまとめにする。
  const left = el("div");
  left.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0;";

  const h2 = el("h2", null, list.title);
  makeEditable(h2, (title) => send({ type: "renameList", id: list.id, title }));
  left.append(h2);

  // role は列の意味づけ。人間の対応待ちは目立たせ、完了は控えめに印を付ける。
  if (list.role === "awaiting_human") {
    const mark = el("span", null, "⚠");
    mark.title = "人間の対応待ち";
    mark.style.cssText = "font-size:12px;color:#e3b341;";
    left.append(mark);
  } else if (list.role === "done") {
    const mark = el("span", null, "✓");
    mark.title = "完了列";
    mark.style.cssText = "font-size:12px;color:#3fb950;opacity:0.7;";
    left.append(mark);
  }

  const countEl = el("span", null, String(count));
  countEl.title = "表示中のカード数";
  countEl.style.cssText = "font-size:11px;color:#7d8590;";
  left.append(countEl);

  const del = el("button", null, "×");
  del.title = "列を削除";
  // data-* は modals.js の確認ポップオーバーがアンカーを引き直すための目印
  // （全再描画でこのボタンごと作り直されるので、参照ではなくセレクタで探す）。
  del.dataset.action = "delete-list";
  del.dataset.listId = list.id;
  // 確認ポップオーバーは modals.js 側。confirm() は使わず、この × をアンカーに出す。
  del.addEventListener("click", (e) => {
    // 列の dragstart に拾わせない／開いた瞬間に外側クリック扱いで閉じないように。
    e.stopPropagation();
    openDeleteListConfirm(list.id);
  });

  header.append(left, del);
  return header;
}

// ---------------------------------------------------------------------------
// カード
// ---------------------------------------------------------------------------

function renderCard(node) {
  const cardEl = el("div", "card");
  cardEl.dataset.nodeId = node.id;
  cardEl.draggable = true;

  // 親のパンくず（末尾2つ）。どの目的・機能のタスクかがカード面で分かるように。
  const trail = breadcrumb(node.id).slice(-2);
  if (trail.length > 0) {
    const crumb = el("div", "card-breadcrumb", trail.join(" › "));
    crumb.style.cssText =
      "font-size:11px;color:#7d8590;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    cardEl.append(crumb);
  }

  cardEl.append(el("div", "card-title", node.title));

  // 担当者フィルタは「隠さず薄く」。beforeId 方式になったので隠しても DnD は壊れないが、
  // 全体の中でそのカードがどこに居るかが見える方が使いやすいので旧実装の作法を踏襲する。
  const dimmed = ui.filterIds.size > 0 && !matchesFilter(node);
  if (dimmed) {
    // .card-dimmed が board.css 側の実際のスタイル。.dimmed は意味づけ用に併記する。
    cardEl.classList.add("dimmed", "card-dimmed");
  } else {
    // .card-assignees は flex 行なので、期日チップと担当者チップの共通の置き場として使う。
    const meta = el("div", "card-assignees");
    if (node.dueDate) meta.append(renderDue(node.dueDate));
    for (const assigneeId of node.assigneeIds) {
      const assignee = board.assignees[assigneeId];
      if (assignee) meta.append(el("span", `chip chip-${assignee.kind}`, assignee.name));
    }
    const assignBtn = el("button", "assign-btn", "＋ アサイン");
    assignBtn.addEventListener("click", (e) => {
      // カード自身の click（詳細モーダル）に伝播させない。
      e.stopPropagation();
      toggleAssigneePopover(node.id, "card");
    });
    // ボタンにフォーカスが乗ったままカードをドラッグされないように。
    assignBtn.addEventListener("dragstart", (e) => e.preventDefault());
    meta.append(assignBtn);
    cardEl.append(meta);
  }

  // 説明はカード面に出さない。クリックで詳細モーダル（?node=<id> のパーマリンクとセット）。
  cardEl.addEventListener("click", () => {
    if (suppressNextCardClick) {
      suppressNextCardClick = false;
      return;
    }
    openNodeDetail(node.id);
  });

  cardEl.addEventListener("dragstart", (e) => {
    // カードと列がどちらも draggable なので、止めないと親の列の dragstart として
    // 誤解釈される（旧 my-kanban で実際に起きたバグ）。
    e.stopPropagation();
    suppressNextCardClick = true;
    e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "card", id: node.id }));
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => cardEl.classList.add("dragging"), 0);
  });
  cardEl.addEventListener("dragend", (e) => {
    e.stopPropagation();
    cardEl.classList.remove("dragging");
    // ドラッグ後に click が飛ばないブラウザではフラグが残り、次の正常なクリックを
    // 食ってしまう。同じティックの click だけ抑制して、その後は必ず解除する。
    setTimeout(() => {
      suppressNextCardClick = false;
    }, 0);
  });

  return cardEl;
}

function renderDue(dueDate) {
  const overdue = dueDate < todayString();
  const due = el("span", "card-due", `📅 ${dueDate}`);
  due.style.cssText = `font-size:11px;${overdue ? "color:#f85149;font-weight:600;" : "color:#7d8590;"}`;
  if (overdue) due.title = "期限切れ";
  return due;
}

/** 期日は "YYYY-MM-DD"（ローカル日付）なので、比較用の今日も同じ形で作る。 */
function todayString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * フィルタ照合。未選択なら全件該当。選択中は OR 条件で、ノードに直接付いた
 * 担当者 id が1つでも選択に含まれれば該当（チームのメンバー展開はしない）。
 */
function matchesFilter(node) {
  if (ui.filterIds.size === 0) return true;
  return node.assigneeIds.some((id) => ui.filterIds.has(id));
}

// ---------------------------------------------------------------------------
// DnD の位置計算
// ---------------------------------------------------------------------------
// 挿入位置は index ではなく beforeId（この id の直前に置く／末尾なら null）で送る。
// 絞り込みで一部のカードを出していなくても、サーバーが実データ上の正しい位置に解決できる。

/** ポインタより下にある最初のカードの id。無ければ null（＝末尾）。 */
function beforeIdFromY(cardsEl, clientY) {
  for (const cardEl of cardsEl.querySelectorAll(".card:not(.dragging)")) {
    const rect = cardEl.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return cardEl.dataset.nodeId;
  }
  return null;
}

/** ポインタより右にある最初の列の id。無ければ null（＝末尾）。 */
function beforeIdFromX(listsEl, clientX) {
  for (const listEl of listsEl.querySelectorAll(".list:not(.dragging)")) {
    const rect = listEl.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return listEl.dataset.listId;
  }
  return null;
}

/** drop 時のペイロード。dragover 中は getData が使えないので types で判定していること。 */
function readPayload(e) {
  try {
    return JSON.parse(e.dataTransfer.getData("text/plain"));
  } catch {
    return null;
  }
}

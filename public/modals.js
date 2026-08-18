// モーダルとポップオーバー一式。旧 my-kanban の board.js から移植し、ツリー（ノード）向けに組み直した。
//
// 引き継いだ作法:
//  - 全再描画。app.js の render() は毎回 DOM を作り直すので、開いている UI は
//    このモジュールの変数に持ち、render() の末尾で renderModals() を呼んで復元する。
//    この作法を外すと、他クライアントの Op が届いた瞬間に開いていたモーダルが閉じる。
//  - 楽観更新しない。ボタンは send() で意図を送るだけで、画面が変わるのは Op が返ってから。
//  - CSS は board.css / tree.css に既にあるものだけを使う（クラス名が DOM の契約）。
//    どうしても足りないところだけ、kanban.js と同じ流儀でインラインスタイルを当てる。

import {
  board,
  breadcrumb,
  descendantIds,
  el,
  listById,
  makeEditable,
  nodeById,
  rerender,
  ui,
} from "./state.js";
import { send } from "./ws.js";

// ---------------------------------------------------------------------------
// 開いている UI の状態（全再描画のたびにここから作り直す）
// ---------------------------------------------------------------------------

/** 詳細モーダルで開いているノード id。null なら閉じている。 */
let detailNodeId = null;

/** 担当者ポップオーバーの対象ノード id と、アンカーの居場所（カード or 詳細モーダル）。 */
const assignee = { nodeId: null, source: "card" };

let manageOpen = false;
let filterOpen = false;

/**
 * 目的の追加モーダル。作成後もモーダルは閉じず「次にやること」を出すので、
 * 送った目的の id を掴んでおく必要がある。楽観更新しない＝返ってきた Op を待つので、
 * 「送信時点のルート id 集合」と「送ったタイトル」を控えて突き合わせて特定する。
 */
const addGoal = { open: false, pendingTitle: null, knownRootIds: null, createdId: null };

/**
 * 削除確認ポップオーバー。confirm() は使わない（ブラウザのダイアログは
 * 全再描画と相性が悪く、文面も作り込めないため）。
 * onConfirm は開いた時点のクロージャだが、中では id しか掴まないので再描画に耐える。
 */
let confirmState = null;

/** .popover の width。位置クランプの計算に使うので CSS と揃えること。 */
const POPOVER_WIDTH = 220;

// ---------------------------------------------------------------------------
// 復元の入口（app.js の render() 末尾から呼ばれる）
// ---------------------------------------------------------------------------

/**
 * 開いている UI をすべて描き直す。
 * 順番が意味を持つ: ポップオーバーはモーダル内の要素をアンカーにできるので、
 * モーダルを先に組み立ててからでないとアンカーが見つからず勝手に閉じてしまう。
 */
export function renderModals() {
  renderDetailModal();
  renderManageModal();
  renderAddGoalModal();
  renderAssigneePopover();
  updateFilterButton();
  renderFilterPopover();
  renderConfirmPopover();
}

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** select / input に board.css の入力欄と同じ見た目を当てる（select 用のクラスが無いため）。 */
function styleField(node) {
  node.style.cssText =
    "background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:6px 8px;font-size:13px;";
  return node;
}

function selectFrom(options, value, onChange) {
  const sel = styleField(el("select"));
  for (const opt of options) {
    const o = el("option", null, opt.label);
    o.value = opt.value;
    if (opt.value === value) o.selected = true;
    if (opt.disabled) o.disabled = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

/** 列の見え方。role は列の意味づけなので、選ぶときも一覧するときも印を添える。 */
function listLabel(list) {
  if (list.role === "awaiting_human") return `${list.title}（⚠ 人間待ち）`;
  if (list.role === "done") return `${list.title}（✓ 完了）`;
  return list.title;
}

const ROLE_OPTIONS = [
  { value: "normal", label: "normal（ふつうの進行状態）" },
  { value: "awaiting_human", label: "awaiting_human（⚠ 人間の対応待ち）" },
  { value: "done", label: "done（✓ 完了）" },
];

const KIND_OPTIONS = [
  { value: "goal", label: "goal（目的）" },
  { value: "feature", label: "feature（機能）" },
  { value: "task", label: "task（タスク）" },
];

/**
 * ポップオーバーをアンカーの下に置く。画面外へはみ出さないようクランプし、
 * 入り切らなければ上側へ回す。
 * モーダル（.modal-overlay は z-index:100）の中から開いた場合は、.popover の
 * z-index:50 のままだとオーバーレイの背後に隠れて見えないので前に出す。
 */
function placePopover(pop, anchor, align = "left") {
  const rect = anchor.getBoundingClientRect();
  let left = align === "right" ? rect.right - POPOVER_WIDTH : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - POPOVER_WIDTH - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${rect.bottom + 4}px`;
  if (anchor.closest(".modal-overlay")) pop.style.zIndex = "200";
  // 高さは DOM に入れないと測れないので、追加後に必要なら上へ回す。
  document.body.append(pop);
  const height = pop.offsetHeight;
  if (rect.bottom + 4 + height > window.innerHeight) {
    pop.style.top = `${Math.max(8, rect.top - 4 - height)}px`;
  }
}

/**
 * 入力中の値を再描画から守るための退避。
 * 全再描画なので、他クライアントの Op が1つ届くだけで打ちかけの本文が消えかねない。
 * 対象は data-keep を持つ入力欄だけ。onlyFocused=true のときはフォーカス中の欄のみ
 * 引き継ぐ（サーバー側の値が正のフィールドで、他人の更新を握り潰さないため）。
 */
function captureFields(root) {
  if (!root) return null;
  const values = {};
  for (const field of root.querySelectorAll("[data-keep]")) values[field.dataset.keep] = field.value;
  const active = document.activeElement;
  const focusKey =
    active && root.contains(active) && active.dataset && active.dataset.keep ? active.dataset.keep : null;
  let start = null;
  let end = null;
  if (focusKey) {
    try {
      start = active.selectionStart;
      end = active.selectionEnd;
    } catch {
      // date 入力などは選択範囲を持たない
    }
  }
  return { values, focusKey, start, end };
}

function restoreFields(root, snapshot, onlyFocused = false) {
  if (!root || !snapshot) return;
  for (const [key, value] of Object.entries(snapshot.values)) {
    if (onlyFocused && key !== snapshot.focusKey) continue;
    const field = root.querySelector(`[data-keep="${key}"]`);
    if (field) field.value = value;
  }
  if (!snapshot.focusKey) return;
  const focused = root.querySelector(`[data-keep="${snapshot.focusKey}"]`);
  if (!focused) return;
  focused.focus();
  if (snapshot.start !== null && snapshot.end !== null) {
    try {
      focused.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      // 選択範囲を持たない型では何もしない
    }
  }
}

/** クリップボードへコピーし、ボタンの表示を一時的に変える（.copied は board.css に定義済み）。 */
function copyWithFeedback(btn, text, label) {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text());
      btn.textContent = "コピーしました";
      btn.classList.add("copied");
    } catch {
      // http 経由や権限拒否だと clipboard API は使えない。手でコピーしてもらう。
      btn.textContent = "コピーに失敗（手動でコピーしてください）";
    }
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove("copied");
    }, 1600);
  });
}

// ---------------------------------------------------------------------------
// 1. ノード詳細モーダル
// ---------------------------------------------------------------------------

export function openNodeDetail(id) {
  detailNodeId = id;
  renderDetailModal();
}

export function closeNodeDetail() {
  detailNodeId = null;
  // 開いている間だけ URL に ?node= を映しているので、閉じたら消す。
  const url = new URL(location.href);
  if (url.searchParams.has("node")) {
    url.searchParams.delete("node");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  renderDetailModal();
}

function permalinkForNode(id) {
  const url = new URL(location.href);
  url.searchParams.set("node", id);
  return url.href;
}

function renderDetailModal() {
  const existing = document.getElementById("node-detail-modal");
  // 打ちかけの説明文を再描画で失わないよう、フォーカス中の欄だけ引き継ぐ。
  const snapshot = existing && existing.dataset.nodeId === detailNodeId ? captureFields(existing) : null;
  if (existing) existing.remove();
  if (!detailNodeId) return;

  const node = nodeById(detailNodeId);
  // 他クライアントに消されたら閉じる（サブツリー削除で自分ごと消えることがある）。
  if (!node) {
    closeNodeDetail();
    return;
  }

  // 開いている間はパーマリンクを URL に映しておく。
  const url = new URL(location.href);
  if (url.searchParams.get("node") !== node.id) {
    url.searchParams.set("node", node.id);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  const overlay = el("div", "modal-overlay");
  overlay.id = "node-detail-modal";
  overlay.dataset.nodeId = node.id;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeNodeDetail();
  });

  const box = el("div", "modal-box");
  const closeBtn = el("button", "modal-close", "×");
  closeBtn.addEventListener("click", closeNodeDetail);
  box.append(closeBtn);

  // ---- タイトル ----
  const title = el("h2", "card-detail-title", node.title);
  makeEditable(title, (value) => send({ type: "renameNode", id: node.id, title: value }));
  title.title = "クリックで編集";
  box.append(title);

  // ---- ツリー上の位置 ----
  const path = breadcrumb(node.id);
  const whereField = el("div", "card-detail-field");
  whereField.append(el("label", "card-detail-label", "ツリー上の位置"));
  const where = el("div", null, path.length > 0 ? path.join(" › ") : "ルート（＝目的そのもの）");
  where.style.cssText = "font-size:13px;color:#cbd5e1;line-height:1.5;";
  whereField.append(where);
  box.append(whereField);

  // ---- 未承認の提案なら、まずここで承認/却下 ----
  if (node.state === "proposed") {
    box.append(renderProposedField(node));
  } else {
    box.append(renderApprovedField(node));
  }

  // ---- 種別と列（横並び） ----
  const cols = el("div", "modal-cols");

  const kindCol = el("div", "modal-col");
  kindCol.append(el("label", "card-detail-label", "種別"));
  const kindSel = selectFrom(KIND_OPTIONS, node.kind, (kind) => send({ type: "setNodeKind", id: node.id, kind }));
  kindSel.style.width = "100%";
  kindCol.append(kindSel);

  const listCol = el("div", "modal-col");
  listCol.append(el("label", "card-detail-label", "列"));
  const listSel = selectFrom(
    board.lists.map((l) => ({ value: l.id, label: listLabel(l) })),
    node.listId,
    // beforeId:null ＝ 移動先の末尾へ。列の中の細かい位置は DnD で決める。
    (listId) => send({ type: "moveCard", id: node.id, listId, beforeId: null }),
  );
  listSel.style.width = "100%";
  if (node.state === "proposed") {
    // 未承認のノードはそもそもカンバンに載っていない（サーバーが moveCard を拒否する）。
    listSel.disabled = true;
    listSel.title = "承認するまで列は動かせません";
  }
  listCol.append(listSel);

  cols.append(kindCol, listCol);
  const colsField = el("div", "card-detail-field");
  colsField.append(cols);
  box.append(colsField);

  // ---- 説明 ----
  const descField = el("div", "card-detail-field");
  descField.append(el("label", "card-detail-label", "説明"));
  const desc = el("textarea", "card-detail-desc");
  desc.dataset.keep = "description";
  desc.placeholder = "ハイレベルな要求や、やることの詳細を書く…";
  desc.value = node.description || "";
  desc.addEventListener("blur", () => {
    if (desc.value !== (node.description || "")) {
      send({ type: "setNodeDescription", id: node.id, description: desc.value });
    }
  });
  descField.append(desc);
  box.append(descField);

  // ---- 期日 ----
  const dueField = el("div", "card-detail-field");
  dueField.append(el("label", "card-detail-label", "期日"));
  const dueRow = el("div", "card-detail-due-row");
  const dueInput = el("input", "card-detail-due");
  dueInput.type = "date";
  dueInput.value = node.dueDate || "";
  dueInput.addEventListener("change", () => {
    send({ type: "setNodeDueDate", id: node.id, dueDate: dueInput.value || null });
  });
  const dueClear = el("button", "card-detail-due-clear", "クリア");
  dueClear.type = "button";
  dueClear.addEventListener("click", () => {
    dueInput.value = "";
    send({ type: "setNodeDueDate", id: node.id, dueDate: null });
  });
  dueRow.append(dueInput, dueClear);
  dueField.append(dueRow);
  box.append(dueField);

  // ---- 担当者 ----
  const assigneeField = el("div", "card-detail-field");
  assigneeField.append(el("label", "card-detail-label", "担当者"));
  const chips = el("div", "card-assignees");
  for (const assigneeId of node.assigneeIds) {
    const a = board.assignees[assigneeId];
    if (a) chips.append(el("span", `chip chip-${a.kind}`, a.name));
  }
  const assignBtn = el("button", "assign-btn", "＋ アサイン");
  assignBtn.type = "button";
  assignBtn.addEventListener("click", (e) => {
    // ポップオーバーの外側クリック判定に、開いたクリック自身を巻き込ませない。
    e.stopPropagation();
    toggleAssigneePopover(node.id, "detail");
  });
  chips.append(assignBtn);
  assigneeField.append(chips);
  box.append(assigneeField);

  // ---- パーマリンクと削除 ----
  const footer = el("div", "card-detail-field");
  footer.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:0;";
  const copyBtn = el("button", "card-detail-copy", "パーマリンクをコピー");
  copyBtn.type = "button";
  copyWithFeedback(copyBtn, () => permalinkForNode(node.id), "パーマリンクをコピー");
  const spacer = el("div");
  spacer.style.flex = "1";
  const delBtn = el("button", "popover-danger-btn", "削除");
  delBtn.type = "button";
  delBtn.id = "detail-delete-btn";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const children = descendantIds(node.id).length;
    openConfirm({
      key: `node:${node.id}`,
      anchorSelector: "#detail-delete-btn",
      align: "right",
      message:
        children > 0
          ? `「${node.title}」を削除しますか？配下 ${children} 件も一緒に削除されます。取り消せません。`
          : `「${node.title}」を削除しますか？取り消せません。`,
      onConfirm: () => send({ type: "deleteNode", id: node.id }),
    });
  });
  footer.append(copyBtn, spacer, delBtn);
  box.append(footer);

  overlay.append(box);
  document.body.append(overlay);

  // サーバーの値が正のフィールドなので、引き継ぐのはフォーカス中の欄だけ。
  restoreFields(overlay, snapshot, true);
}

/** 未承認の提案であることの明示と、承認・却下のボタン。 */
function renderProposedField(node) {
  const field = el("div", "card-detail-field");
  const message = el(
    "div",
    "popover-message",
    "⚠ 未承認の提案です。承認するまでカンバンには並びません（ツリーにだけ点線で出ます）。",
  );
  message.style.cssText =
    "background:#171310;border:1px dashed #4a3208;border-radius:6px;padding:10px;color:#e3b341;";
  field.append(message);

  const actions = el("div", "popover-actions");
  actions.style.justifyContent = "flex-start";

  const approve = el("button", "card-detail-copy", "承認");
  approve.type = "button";
  approve.title = "このノードを確定してカンバンに載せる（祖先が未承認ならまとめて承認される）";
  approve.addEventListener("click", () => send({ type: "approveNode", id: node.id }));

  const approveAll = el("button", "card-detail-copy", "配下ごと承認");
  approveAll.type = "button";
  approveAll.title = "このノードと、その配下の提案をすべて承認する";
  approveAll.addEventListener("click", () => send({ type: "approveNode", id: node.id, recursive: true }));

  const reject = el("button", "popover-danger-btn", "却下");
  reject.type = "button";
  reject.id = "detail-reject-btn";
  reject.title = "提案をサブツリーごと削除する";
  reject.addEventListener("click", (e) => {
    e.stopPropagation();
    openConfirm({
      key: `reject:${node.id}`,
      anchorSelector: "#detail-reject-btn",
      ...rejectConfirm(node),
    });
  });

  actions.append(approve, approveAll, reject);
  field.append(actions);
  return field;
}

/**
 * 確定済みノードの「承認を取り消す」欄。
 * 承認したあとで「やっぱり違った」に戻れないと、承認ゲートが片道弁になってしまう
 * （まとめて承認したあと一部だけ戻したい、が実際に起きた）。
 */
function renderApprovedField(node) {
  const field = el("div", "card-detail-field");
  const actions = el("div", "popover-actions");
  actions.style.justifyContent = "flex-start";

  // 巻き込む件数を先に見せる。子孫を確定させたまま自分だけ戻すことはできない
  // （「親が未承認なら子も未承認」の不変条件があるため）。
  const alsoAffected = descendantIds(node.id).filter((id) => {
    const child = nodeById(id);
    return child && child.state === "active";
  }).length;

  const unapprove = el("button", "card-detail-copy", "承認を取り消す");
  unapprove.type = "button";
  unapprove.title =
    alsoAffected > 0
      ? `このノードと配下 ${alsoAffected} 件を未承認に戻す（カンバンから外れる）`
      : "このノードを未承認に戻す（カンバンから外れる）";
  unapprove.addEventListener("click", () => send({ type: "unapproveNode", id: node.id }));
  actions.append(unapprove);

  // 人間待ちの列に居るときだけ［差し戻し］。レビューして「まだ直してほしい」を
  // やり直しキューへ返す操作なので、それ以外の列では意味を持たない。
  const list = listById(node.listId);
  if (list && list.role === "awaiting_human") {
    const sendBack = el("button", "popover-danger-btn", "差し戻し");
    sendBack.type = "button";
    sendBack.id = "detail-send-back-btn";
    sendBack.title = "やり直しキューへ戻す（指摘は説明に残る）";
    sendBack.addEventListener("click", (e) => {
      e.stopPropagation();
      openConfirm({
        key: `send-back:${node.id}`,
        anchorSelector: "#detail-send-back-btn",
        message: `「${node.title}」を差し戻しますか？「${sendBackTarget()}」へ戻します。`,
        confirmLabel: "差し戻す",
        reasonPlaceholder: "直してほしいこと（任意・説明に残ります）",
        onConfirm: (note) => send({ type: "sendBack", id: node.id, note: note || undefined }),
      });
    });
    actions.append(sendBack);
  }

  if (alsoAffected > 0) {
    const note = el("span", null, `配下 ${alsoAffected} 件も一緒に戻ります`);
    note.style.cssText = "font-size:11px;color:#7d8590;align-self:center;";
    actions.append(note);
  }

  field.append(actions);
  return field;
}

/** 差し戻し先の列名。サーバー側の既定（role="normal" の先頭列）と同じ選び方を文面に出す。 */
function sendBackTarget() {
  const target = board.lists.find((l) => l.role === "normal") ?? board.lists[0];
  return target ? target.title : "先頭の列";
}

// ---------------------------------------------------------------------------
// 2. 担当者アサインのポップオーバー
// ---------------------------------------------------------------------------

/**
 * source は "card"（カンバンのカード）／"tree"（ツリーの行）／"detail"（詳細モーダル）。
 * アンカーの探し先が変わるだけで、送る意図は同じ。
 */
export function toggleAssigneePopover(nodeId, source) {
  const same = assignee.nodeId === nodeId && assignee.source === source;
  assignee.nodeId = same ? null : nodeId;
  assignee.source = source;
  renderAssigneePopover();
}

function assigneeAnchor() {
  if (assignee.source === "detail") {
    const modal = document.getElementById("node-detail-modal");
    // 詳細モーダルが別のノードに切り替わっていたら、開きっぱなしにせず閉じさせる
    // （見えているカードと操作対象がズレるのが一番たちが悪い）。
    if (!modal || modal.dataset.nodeId !== assignee.nodeId) return null;
    return modal.querySelector(".assign-btn");
  }
  if (assignee.source === "tree") {
    return document.querySelector(`.tree-row[data-node-id="${assignee.nodeId}"] .assign-btn`);
  }
  return document.querySelector(`.card[data-node-id="${assignee.nodeId}"] .assign-btn`);
}

function renderAssigneePopover() {
  const existing = document.getElementById("assignee-popover");
  if (existing) existing.remove();
  if (!assignee.nodeId) return;

  const node = nodeById(assignee.nodeId);
  const anchor = assigneeAnchor();
  // ビュー切替や他クライアントの削除でアンカーが消えたら、開きっぱなしにせず閉じる。
  if (!node || !anchor) {
    assignee.nodeId = null;
    return;
  }

  const pop = el("div", "popover");
  pop.id = "assignee-popover";
  pop.append(
    assigneeSection("チーム", "team", (a) => node.assigneeIds.includes(a.id), (a) =>
      send({ type: "toggleNodeAssignee", nodeId: node.id, assigneeId: a.id }),
    ),
    assigneeSection("人", "person", (a) => node.assigneeIds.includes(a.id), (a) =>
      send({ type: "toggleNodeAssignee", nodeId: node.id, assigneeId: a.id }),
    ),
  );
  placePopover(pop, anchor);
}

/** 人／チームの一覧セクション。チェック状態の読み取りと切り替えだけを差し替えて使い回す。 */
function assigneeSection(heading, kind, isChecked, onToggle) {
  const section = el("div", "popover-section");
  section.append(el("div", "popover-heading", heading));
  const items = Object.values(board.assignees).filter((a) => a.kind === kind);
  if (items.length === 0) {
    section.append(el("div", "popover-empty", kind === "team" ? "チーム未登録" : "メンバー未登録"));
    return section;
  }
  for (const item of items) {
    const label = el("label", "popover-item");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = isChecked(item);
    cb.addEventListener("change", () => onToggle(item));
    label.append(cb, document.createTextNode(` ${item.name}`));
    section.append(label);
  }
  return section;
}

// ---------------------------------------------------------------------------
// 3. 担当者フィルタのポップオーバー（クライアントローカル）
// ---------------------------------------------------------------------------

export function toggleFilterPopover() {
  filterOpen = !filterOpen;
  renderFilterPopover();
}

function updateFilterButton() {
  const btn = document.getElementById("filter-btn");
  if (!btn) return;
  const n = ui.filterIds.size;
  btn.textContent = n > 0 ? `🔍 フィルター (${n})` : "🔍 フィルター";
  btn.classList.toggle("filter-active", n > 0);
}

function renderFilterPopover() {
  const existing = document.getElementById("filter-popover");
  if (existing) existing.remove();
  if (!filterOpen) return;
  const anchor = document.getElementById("filter-btn");
  if (!anchor) return;

  const pop = el("div", "popover");
  pop.id = "filter-popover";

  // フィルタはサーバーに送らない表示状態。ui.filterIds を出し入れして再描画するだけ。
  const toggle = (a) => {
    if (ui.filterIds.has(a.id)) ui.filterIds.delete(a.id);
    else ui.filterIds.add(a.id);
    rerender();
  };
  pop.append(
    assigneeSection("チーム", "team", (a) => ui.filterIds.has(a.id), toggle),
    assigneeSection("人", "person", (a) => ui.filterIds.has(a.id), toggle),
  );

  const actions = el("div", "popover-actions");
  actions.style.marginTop = "10px";
  const clear = el("button", "popover-cancel-btn", "すべて解除");
  clear.type = "button";
  clear.addEventListener("click", (e) => {
    // このボタンは rerender() で自分ごと作り直される。外側クリック判定に
    // 巻き込まれてポップオーバーが閉じないよう伝播を止める。
    e.stopPropagation();
    ui.filterIds.clear();
    rerender();
  });
  actions.append(clear);
  pop.append(actions);

  placePopover(pop, anchor, "right");
}

// ---------------------------------------------------------------------------
// 4. メンバー管理モーダル（＋ 列の管理）
// ---------------------------------------------------------------------------

export function openManageModal() {
  manageOpen = true;
  renderManageModal();
}

function closeManageModal() {
  manageOpen = false;
  renderManageModal();
}

function renderManageModal() {
  const existing = document.getElementById("manage-modal");
  const snapshot = existing ? captureFields(existing) : null;
  if (existing) existing.remove();
  if (!manageOpen) return;

  const overlay = el("div", "modal-overlay");
  overlay.id = "manage-modal";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeManageModal();
  });

  const box = el("div", "modal-box");
  const closeBtn = el("button", "modal-close", "×");
  closeBtn.addEventListener("click", closeManageModal);
  box.append(closeBtn, el("h2", null, "メンバーと列の管理"));

  const assignees = Object.values(board.assignees);
  const people = assignees.filter((a) => a.kind === "person");
  const teams = assignees.filter((a) => a.kind === "team");

  const cols = el("div", "modal-cols");
  cols.append(renderPeopleCol(people), renderTeamCol(teams, people));
  box.append(cols);

  // 旧実装で「自動化」を置いていた枠をそのまま列の管理に使う（.modal-auto は
  // 上に区切り線を引く下段セクションのスタイルで、中身の意味には縛られない）。
  box.append(renderListsSection());

  overlay.append(box);
  document.body.append(overlay);

  // 入力途中の追加フォームは全部引き継ぐ（サーバー側に対応する値がない純粋な入力欄なので）。
  restoreFields(overlay, snapshot);
}

function renderPeopleCol(people) {
  const col = el("div", "modal-col");
  col.append(el("h3", null, "人"));
  const list = el("div", "modal-list");
  if (people.length === 0) list.append(el("div", "popover-empty", "まだいません"));
  for (const person of people) {
    const row = el("div", "modal-row");
    const name = el("span", null, person.name);
    name.title = "クリックで改名";
    makeEditable(name, (value) => send({ type: "renameAssignee", id: person.id, name: value }));
    const del = el("button", null, "×");
    del.title = "削除";
    del.addEventListener("click", () => send({ type: "deleteAssignee", id: person.id }));
    row.append(name, del);
    list.append(row);
  }
  col.append(list, addForm("＋ メンバーを追加", "add-person", (name) => send({ type: "addAssignee", kind: "person", name })));
  return col;
}

function renderTeamCol(teams, people) {
  const col = el("div", "modal-col");
  col.append(el("h3", null, "チーム"));
  const list = el("div", "modal-list");
  if (teams.length === 0) list.append(el("div", "popover-empty", "まだありません"));
  for (const team of teams) {
    const teamBox = el("div", "modal-team-box");
    const row = el("div", "modal-row");
    const name = el("span", null, team.name);
    name.title = "クリックで改名";
    makeEditable(name, (value) => send({ type: "renameAssignee", id: team.id, name: value }));
    const del = el("button", null, "×");
    del.title = "削除";
    del.addEventListener("click", () => send({ type: "deleteAssignee", id: team.id }));
    row.append(name, del);
    teamBox.append(row);

    const members = el("div", "modal-team-members");
    if (people.length === 0) members.append(el("div", "popover-empty", "メンバー未登録"));
    for (const person of people) {
      const label = el("label", "popover-item");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = team.memberIds.includes(person.id);
      cb.addEventListener("change", () => send({ type: "toggleTeamMember", teamId: team.id, memberId: person.id }));
      label.append(cb, document.createTextNode(` ${person.name}`));
      members.append(label);
    }
    teamBox.append(members);
    list.append(teamBox);
  }
  col.append(list, addForm("＋ チームを追加", "add-team", (name) => send({ type: "addAssignee", kind: "team", name })));
  return col;
}

function addForm(placeholder, keepKey, onSubmit) {
  const form = el("form", "modal-add-form");
  const input = el("input");
  input.placeholder = placeholder;
  input.dataset.keep = keepKey;
  form.append(input);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    onSubmit(value);
    input.value = "";
  });
  return form;
}

/** 列の一覧（改名・role 変更・削除）。 */
function renderListsSection() {
  const section = el("div", "modal-auto");
  section.append(el("h3", null, "列"));

  const note = el(
    "div",
    "popover-empty",
    "role は列の意味づけです。awaiting_human に置かれたタスクは「人間の対応待ち」として扱われ、" +
      "AI はそこで手を止めます。完了判定は列名ではなく done role で行います（done の列にある間だけ完了時刻が入ります）。",
  );
  note.style.cssText = "line-height:1.6;margin-bottom:8px;";
  section.append(note);

  const list = el("div", "modal-list");
  for (const col of board.lists) {
    const row = el("div", "modal-row");

    const name = el("span", null, col.title);
    name.title = "クリックで改名";
    name.style.cssText = "flex:1;min-width:0;";
    makeEditable(name, (title) => send({ type: "renameList", id: col.id, title }));

    const right = el("div");
    right.style.cssText = "display:flex;align-items:center;gap:8px;";

    // nodeIds には親ノードも入る（カンバンにカードとして出るのは葉だけ）。
    const count = el("span", null, `${col.nodeIds.length} 件`);
    count.title = "この列にあるノード数（カードにならない親ノードも含む）";
    count.style.cssText = "font-size:11px;color:#7d8590;";

    const roleSel = selectFrom(ROLE_OPTIONS, col.role, (role) => send({ type: "setListRole", id: col.id, role }));
    roleSel.style.fontSize = "12px";

    const del = el("button", null, "×");
    del.title = "列を削除";
    del.dataset.action = "delete-list-row";
    del.dataset.listId = col.id;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteListConfirm(col.id, `#manage-modal button[data-action="delete-list-row"][data-list-id="${col.id}"]`);
    });

    right.append(count, roleSel, del);
    row.append(name, right);
    list.append(row);
  }
  section.append(list);
  return section;
}

// ---------------------------------------------------------------------------
// 5. 削除確認ポップオーバー
// ---------------------------------------------------------------------------

/**
 * key が同じボタンをもう一度押したら閉じる（トグル）。
 * anchorSelector は再描画のたびに引き直すので、アンカーが消えたら自動的に閉じる。
 * tree.js の［却下］もこれを使う（サブツリーごと消える操作なので確認を挟む）。
 *
 * reasonPlaceholder を渡すと理由の入力欄が付き、onConfirm がその文字列を受け取る
 * （空なら ""）。打ちかけの内容は data-keep で再描画から守る。
 */
export function openConfirm(options) {
  if (confirmState && confirmState.key === options.key) confirmState = null;
  else confirmState = options;
  renderConfirmPopover();
}

/**
 * 却下確認の中身（message / confirmLabel / reasonPlaceholder / onConfirm）。
 * ツリー行と詳細モーダルの両方から同じ文面・同じ理由欄で開けるように切り出してある。
 * key と anchorSelector は呼び出し側が足すこと。
 *
 * 理由は親の description に1行残るだけなので、親がいないルートでは欄を出さない
 * （サーバーも理由付きのルート却下はエラーにする）。
 */
export function rejectConfirm(node) {
  const children = descendantIds(node.id).length;
  const isRoot = node.parentId === null;
  const head =
    children > 0
      ? `提案「${node.title}」を却下しますか？配下 ${children} 件の提案も一緒に削除されます。`
      : `提案「${node.title}」を却下しますか？`;
  return {
    message: isRoot ? `${head}（最上位なので理由の記録先がありません）` : head,
    confirmLabel: "却下",
    reasonPlaceholder: isRoot ? null : "却下する理由（任意・親の説明に残ります）",
    onConfirm: (reason) => send({ type: "rejectNode", id: node.id, reason: reason || undefined }),
  };
}

/** 列削除の確認。anchorSelector 省略時は列ヘッダーの × をアンカーにする。 */
export function openDeleteListConfirm(listId, anchorSelector) {
  const list = listById(listId);
  if (!list) return;
  const anchor = anchorSelector ?? `.list[data-list-id="${listId}"] button[data-action="delete-list"]`;

  // 列を消してもノードは消えない（ツリーの実体なので）。他の列の末尾へ退避する。
  // 「カードも消える」と誤解させないことがこの文面の目的。
  const count = list.nodeIds.length;
  const last = board.lists.length <= 1;
  const message = last
    ? "最後の1列は削除できません。先に別の列を追加してください。"
    : count > 0
      ? `「${list.title}」を削除しますか？この列にある ${count} 件のノードは削除されず、別の列の末尾へ移動します。` +
        "（カードとして出ていない親ノードも数に含みます）"
      : `「${list.title}」を削除しますか？`;

  openConfirm({
    key: `list:${listId}:${anchor}`,
    anchorSelector: anchor,
    align: "right",
    message,
    // 最後の1列はサーバーが拒否するので、そもそも押せる形にしない。
    onConfirm: last ? null : () => send({ type: "deleteList", id: list.id }),
  });
}

function renderConfirmPopover() {
  const existing = document.getElementById("confirm-popover");
  // 同じ確認が開き続けているときだけ、打ちかけの理由とカーソル位置を引き継ぐ。
  const snapshot = existing && confirmState && existing.dataset.key === confirmState.key ? captureFields(existing) : null;
  if (existing) existing.remove();
  if (!confirmState) return;

  const anchor = document.querySelector(confirmState.anchorSelector);
  if (!anchor) {
    confirmState = null;
    return;
  }

  const pop = el("div", "popover");
  pop.id = "confirm-popover";
  pop.dataset.key = confirmState.key;
  pop.append(el("div", "popover-message", confirmState.message));

  let reasonField = null;
  if (confirmState.reasonPlaceholder && confirmState.onConfirm) {
    reasonField = el("textarea", "popover-input");
    reasonField.rows = 3;
    reasonField.placeholder = confirmState.reasonPlaceholder;
    reasonField.dataset.keep = "confirm-reason";
    pop.append(reasonField);
  }

  const actions = el("div", "popover-actions");
  const cancel = el("button", "popover-cancel-btn", confirmState.onConfirm ? "キャンセル" : "閉じる");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    confirmState = null;
    renderConfirmPopover();
  });
  actions.append(cancel);

  if (confirmState.onConfirm) {
    const run = confirmState.onConfirm;
    const danger = el("button", "popover-danger-btn", confirmState.confirmLabel ?? "削除");
    danger.type = "button";
    danger.addEventListener("click", () => {
      run(reasonField ? reasonField.value.trim() : "");
      confirmState = null;
      renderConfirmPopover();
    });
    actions.append(danger);
  }
  pop.append(actions);

  placePopover(pop, anchor, confirmState.align ?? "left");
  restoreFields(pop, snapshot);
  // 開いた直後だけ理由欄にカーソルを置く（再描画時は snapshot 側が focus を持っている）。
  if (reasonField && !snapshot) reasonField.focus();
}

// ---------------------------------------------------------------------------
// 6. 目的の追加モーダル（このアプリの入口）
// ---------------------------------------------------------------------------

export function openAddGoalModal() {
  addGoal.open = true;
  addGoal.pendingTitle = null;
  addGoal.knownRootIds = null;
  addGoal.createdId = null;
  renderAddGoalModal();
}

function closeAddGoalModal() {
  addGoal.open = false;
  addGoal.pendingTitle = null;
  addGoal.knownRootIds = null;
  addGoal.createdId = null;
  renderAddGoalModal();
}

/**
 * 送った目的が返ってきたかを見る。楽観更新しないので、追加した id は
 * 「送信時に無かったルート id で、タイトルが一致するもの」として拾う。
 */
function resolveCreatedGoal() {
  if (addGoal.createdId !== null || addGoal.pendingTitle === null || !addGoal.knownRootIds) return;
  for (const id of board.rootIds) {
    if (addGoal.knownRootIds.has(id)) continue;
    const node = nodeById(id);
    if (node && node.title === addGoal.pendingTitle) {
      addGoal.createdId = id;
      addGoal.pendingTitle = null;
      return;
    }
  }
}

/**
 * Claude Code に細分化を頼むための依頼文。
 * サーバーは LLM を呼ばない設計なので、UI に「細分化する」ボタンは置かない
 * （押しても何も起きないボタンになる）。この文面のコピーが導線。
 */
function decomposePrompt(boardId, node) {
  return [
    `ai-kanban のボード "${boardId}" にある目的 ${node.id}「${node.title}」を細分化してください。`,
    `ベース URL は ${location.origin} で、API の使い方はプロジェクトの API.md にあります。`,
    `細分化結果は POST /api/boards/${boardId}/nodes に入れ子で投入してください（既定で未承認の提案として入ります）。`,
  ].join("\n");
}

function renderAddGoalModal() {
  const existing = document.getElementById("add-goal-modal");
  const snapshot = existing ? captureFields(existing) : null;
  if (existing) existing.remove();
  if (!addGoal.open) return;

  resolveCreatedGoal();

  const overlay = el("div", "modal-overlay");
  overlay.id = "add-goal-modal";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAddGoalModal();
  });

  const box = el("div", "modal-box");
  const closeBtn = el("button", "modal-close", "×");
  closeBtn.addEventListener("click", closeAddGoalModal);
  box.append(closeBtn, el("h2", null, "＋ 新しい目的"));

  const lead = el(
    "div",
    "popover-message",
    "実現したいことを、粒度を気にせず大きめに書いてください。タスクへの細分化は、この後ローカルの Claude Code に頼みます。",
  );
  lead.style.cssText = "color:#7d8590;line-height:1.6;";
  box.append(lead);

  // ---- 入力 ----
  const titleField = el("div", "card-detail-field");
  titleField.append(el("label", "card-detail-label", "タイトル"));
  const titleWrap = el("div", "modal-add-form");
  const titleInput = el("input");
  titleInput.placeholder = "例: 認証基盤をつくる";
  titleInput.dataset.keep = "goal-title";
  titleWrap.append(titleInput);
  titleField.append(titleWrap);
  box.append(titleField);

  const descField = el("div", "card-detail-field");
  descField.append(el("label", "card-detail-label", "目的・機能要求（Claude Code はここを読んで細分化します）"));
  const descArea = el("textarea", "card-detail-desc");
  descArea.dataset.keep = "goal-desc";
  descArea.style.minHeight = "160px";
  descArea.placeholder =
    "何を実現したいか / なぜ必要か / 満たすべき条件や制約 / 触ってよい範囲…\n箇条書きで構いません。";
  descField.append(descArea);
  box.append(descField);

  const submitField = el("div", "card-detail-field");
  const submit = el("button", "card-detail-copy", "この目的を追加");
  submit.type = "button";
  submit.addEventListener("click", () => {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return;
    }
    // 返ってくる addNode の Op を見分けるために、送信時点のルート id を控える。
    addGoal.knownRootIds = new Set(board.rootIds);
    addGoal.pendingTitle = title;
    addGoal.createdId = null;
    send({
      type: "addNode",
      parentId: null,
      title,
      description: descArea.value,
      kind: "goal",
    });
    titleInput.value = "";
    descArea.value = "";
  });
  submitField.append(submit);
  box.append(submitField);

  // ---- 作成後の導線 ----
  if (addGoal.createdId !== null) {
    const created = nodeById(addGoal.createdId);
    if (created) box.append(renderNextStep(created));
    else addGoal.createdId = null; // 作った直後に他クライアントが消した場合
  } else if (addGoal.pendingTitle !== null) {
    const waiting = el("div", "popover-empty", "追加を送信しました。反映待ち…");
    waiting.style.marginTop = "8px";
    box.append(waiting);
  }

  overlay.append(box);
  document.body.append(overlay);
  restoreFields(overlay, snapshot);
}

/** 作成した目的に対する「次にやること」＝ Claude Code への依頼文。 */
function renderNextStep(node) {
  const boardId = document.body.dataset.boardId;
  const section = el("div", "modal-auto");
  section.append(el("h3", null, "次にやること"));

  const lead = el(
    "div",
    "popover-message",
    `「${node.title}」を追加しました。細分化はローカルの Claude Code の仕事です（サーバーは LLM を呼びません）。` +
      "下の依頼文をコピーして Claude Code に貼ってください。投入された子タスクは未承認の提案として届くので、" +
      "ツリーで内容を確かめてから承認します。",
  );
  lead.style.cssText = "color:#7d8590;line-height:1.6;";
  section.append(lead);

  const text = decomposePrompt(boardId, node);
  const box = el("textarea", "card-detail-desc");
  box.readOnly = true;
  box.value = text;
  box.style.minHeight = "88px";
  box.addEventListener("focus", () => box.select());
  section.append(box);

  const actions = el("div", "popover-actions");
  actions.style.cssText = "justify-content:flex-start;margin-top:10px;";

  const copyBtn = el("button", "card-detail-copy", "依頼文をコピー");
  copyBtn.type = "button";
  copyWithFeedback(copyBtn, () => text, "依頼文をコピー");

  const openBtn = el("button", "popover-cancel-btn", "この目的の詳細を開く");
  openBtn.type = "button";
  openBtn.addEventListener("click", () => {
    closeAddGoalModal();
    openNodeDetail(node.id);
  });

  const againBtn = el("button", "popover-cancel-btn", "続けてもう1つ追加");
  againBtn.type = "button";
  againBtn.addEventListener("click", () => {
    addGoal.createdId = null;
    addGoal.pendingTitle = null;
    addGoal.knownRootIds = null;
    renderAddGoalModal();
  });

  actions.append(copyBtn, openBtn, againBtn);
  section.append(actions);
  return section;
}

// ---------------------------------------------------------------------------
// 外側クリックと Esc
// ---------------------------------------------------------------------------

// ポップオーバーは「外をクリックしたら閉じる」。開いた瞬間のクリックで閉じないよう、
// 開く側のハンドラでは必ず stopPropagation() していること。
document.addEventListener("click", (e) => {
  if (assignee.nodeId) {
    const pop = document.getElementById("assignee-popover");
    if (pop && !pop.contains(e.target)) {
      assignee.nodeId = null;
      renderAssigneePopover();
    }
  }
  if (filterOpen) {
    const pop = document.getElementById("filter-popover");
    const btn = document.getElementById("filter-btn");
    if (pop && !pop.contains(e.target) && !(btn && btn.contains(e.target))) {
      filterOpen = false;
      renderFilterPopover();
    }
  }
  if (confirmState) {
    const pop = document.getElementById("confirm-popover");
    if (pop && !pop.contains(e.target)) {
      confirmState = null;
      renderConfirmPopover();
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // 入力中の Esc は makeEditable の「編集を取り消す」に譲る（モーダルまで閉じない）。
  const tag = e.target && e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  // 手前にあるものから1つずつ閉じる。
  if (confirmState) {
    confirmState = null;
    renderConfirmPopover();
  } else if (assignee.nodeId) {
    assignee.nodeId = null;
    renderAssigneePopover();
  } else if (filterOpen) {
    filterOpen = false;
    renderFilterPopover();
  } else if (addGoal.open) {
    closeAddGoalModal();
  } else if (manageOpen) {
    closeManageModal();
  } else if (detailNodeId) {
    closeNodeDetail();
  }
});

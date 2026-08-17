// ツリービューの描画と DnD。
//
// カンバンが「実作業の進行」を見る画面なのに対し、ここは **構造を見る・直す・承認する**
// 画面。AI が生やした提案（state="proposed"）はカンバンに出ないので、点線で現れるのは
// ここだけ。承認して初めてカンバンに並ぶ。
//
// DOM の契約は public/tree.css。クラス名はあちらにあるものだけを使い、足りないところだけ
// kanban.js / modals.js と同じ流儀で控えめなインラインスタイルを当てる。
//
// 全再描画。app.js の render() が毎回 #view-root を空にして呼び直すので、開閉状態や
// 「＋子」の入力中の値はモジュール変数に持ち、描き直したあとで復元する。

import {
  board,
  descendantIds,
  el,
  listById,
  makeEditable,
  nodeById,
  progressOf,
  rerender,
  ui,
} from "./state.js";
import { openConfirm, openNodeDetail, rejectConfirm, toggleAssigneePopover } from "./modals.js";
import { send } from "./ws.js";

// ---------------------------------------------------------------------------
// 画面ローカルの状態
// ---------------------------------------------------------------------------

const boardId = document.body.dataset.boardId;

/** 畳んでいるノード id。既定は全展開なので「畳んだものだけ」を覚える。app.js の VIEW_KEY と同じ作法。 */
const COLLAPSED_KEY = `ai-kanban:tree-collapsed:${boardId}`;

const collapsed = new Set(loadCollapsed());

/** 「＋子」のインライン入力。開いている行と、打ちかけの値・種別を保持する。 */
const addChild = { parentId: null, kind: "task", value: "" };

/**
 * 担当者ポップオーバーを開いている行の id。.tree-actions は hover 中しか見えないので、
 * ポップオーバーが開いている間はその行だけ出しっぱなしにする（アンカーが消えて見えると
 * 「どこから出ているのか分からない」ため）。ポップオーバー本体の状態は modals.js が持つので、
 * ここは表示のためだけの控え。実体が消えていたら描画のたびに捨てる。
 */
let assignOpenId = null;

/** ドラッグ中のノード id。dragover では getData が使えないのでここから引く。 */
let draggingId = null;

/** ドロップ位置の目印を付けている行と、その種類。 */
let markedRow = null;

/**
 * ドラッグ直後に飛んでくる click を1回だけ食い潰すフラグ。
 * これが無いと、行をドラッグして離した瞬間に click が発火して詳細モーダルが開く
 * （kanban.js と同じ対処）。
 */
let suppressNextRowClick = false;

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    // プライベートモードや壊れた値でも表示は続けられる（全展開に倒す）
    return [];
  }
}

function saveCollapsed() {
  try {
    // 消えたノードの id を溜め込まないよう、保存時に現存するものだけに絞る。
    const alive = [...collapsed].filter((id) => nodeById(id));
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(alive));
  } catch {
    // 保存できなくてもこのセッションの開閉は効く
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * ツリーを root（#view-root）の中に描く。root を空にするのは呼び出し側（app.js）の責務。
 */
export function renderTree(root) {
  const treeEl = el("div");
  treeEl.id = "tree";

  // 外側クリックや Esc で閉じられた場合、modals.js は tree.js に何も言わない。
  // ポップオーバーの実体が無ければ控えも捨てる。
  if (assignOpenId !== null && !document.getElementById("assignee-popover")) assignOpenId = null;

  if (board.rootIds.length === 0) {
    treeEl.append(renderEmpty());
    root.append(treeEl);
    return;
  }

  treeEl.append(renderToolbar());

  const list = el("ul", "tree-root");
  for (const id of board.rootIds) {
    const li = renderNode(id);
    if (li) list.append(li);
  }
  treeEl.append(list);
  root.append(treeEl);

  // 開いている「＋子」の入力欄は全再描画で作り直されるので、値とフォーカスを戻す。
  restoreAddChildInput();
}

/**
 * 指定ノードが見えるように祖先の畳みを解く。app.js の「要対応」バッジから使う
 * （畳まれた中に提案が埋まっていると、ツリーへ切り替えても何も見えない）。
 */
export function revealNode(id) {
  let node = nodeById(id);
  const seen = new Set();
  while (node && node.parentId !== null && !seen.has(node.parentId)) {
    seen.add(node.parentId);
    collapsed.delete(node.parentId);
    node = nodeById(node.parentId);
  }
  saveCollapsed();
}

// ---------------------------------------------------------------------------
// 空のとき
// ---------------------------------------------------------------------------

/** ノードが1つも無いときは、このアプリの使い方そのものを出すのが一番役に立つ。 */
function renderEmpty() {
  const box = el("div", "tree-empty");
  box.append(el("div", null, "まだノードがありません。このアプリは次の流れで使います。"));

  const steps = el("ol");
  steps.style.cssText = "margin:12px 0 0;padding-left:22px;";

  const step1 = el("li");
  step1.append(document.createTextNode("ヘッダーの "));
  step1.append(el("code", null, "＋ 目的"));
  step1.append(document.createTextNode(" で、実現したいことを粒度を気にせず大きめに書く"));

  const step2 = el("li");
  step2.append(document.createTextNode("表示される依頼文をコピーして、ローカルの "));
  step2.append(el("code", null, "Claude Code"));
  step2.append(document.createTextNode(" に渡す（細分化はサーバーではなく Claude Code の仕事）"));

  const step3 = el("li");
  step3.append(document.createTextNode("細分化結果は "));
  step3.append(el("code", null, "未承認の提案"));
  step3.append(document.createTextNode(" として、ここに点線で現れる。［承認］するとカンバンに並ぶ"));

  steps.append(step1, step2, step3);
  box.append(steps);
  return box;
}

// ---------------------------------------------------------------------------
// 上部のツールバー
// ---------------------------------------------------------------------------

/** 「すべて展開 / すべて畳む」。tree.css に専用クラスが無いので控えめなインラインで。 */
function renderToolbar() {
  const bar = el("div");
  bar.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px;";

  const expandAll = toolbarButton("すべて展開", () => {
    collapsed.clear();
    saveCollapsed();
    rerender();
  });

  const collapseAll = toolbarButton("すべて畳む", () => {
    for (const node of Object.values(board.nodes)) {
      if (node.childIds.length > 0) collapsed.add(node.id);
    }
    saveCollapsed();
    rerender();
  });

  const hint = el("span", null, "行をドラッグすると親替え・並べ替えができます");
  hint.style.cssText = "font-size:11px;color:#7d8590;margin-left:auto;";

  bar.append(expandAll, collapseAll, hint);
  return bar;
}

function toolbarButton(label, onClick) {
  const btn = el("button", null, label);
  btn.type = "button";
  btn.style.cssText =
    "background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;";
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------------------------------------------------------------------------
// ノード（li）と行
// ---------------------------------------------------------------------------

function renderNode(id) {
  const node = nodeById(id);
  if (!node) return null;

  const li = el("li", "tree-node");
  li.dataset.nodeId = node.id;
  // .proposed の点線・淡色・「提案」ラベル（::before）はすべて CSS 側が付ける。
  if (node.state === "proposed") li.classList.add("proposed");
  if (ui.scopeId === node.id) li.classList.add("scoped");
  // 配下に未承認の提案を抱えている行は［配下ごと承認］を常時見せる（CSS が opacity を上げる）。
  // hover しないと出てこないと、要対応バッジからツリーに来た人が最初に押すべきボタンを
  // 見つけられない。
  if (node.state === "active" && hasProposedDescendant(node.id)) li.classList.add("has-proposed");

  const hasChildren = node.childIds.length > 0;
  if (hasChildren && collapsed.has(node.id)) li.classList.add("collapsed");

  li.append(renderRow(node, hasChildren));

  // 「＋子」の入力は行の下、子のリストより上に出す（畳んでいても見える位置）。
  if (addChild.parentId === node.id) li.append(renderAddChildForm(node));

  if (hasChildren) {
    const children = el("ul", "tree-children");
    for (const childId of node.childIds) {
      const child = renderNode(childId);
      if (child) children.append(child);
    }
    li.append(children);
  }

  return li;
}

function renderRow(node, hasChildren) {
  const row = el("div", "tree-row");
  row.dataset.nodeId = node.id;
  row.draggable = true;

  row.append(renderToggle(node, hasChildren));
  row.append(el("span", `tree-kind kind-${node.kind}`, kindLabel(node.kind)));

  // .tree-title は flex:1 で行の余白をすべて飲み込む（バッジを右に寄せるための伸び代）。
  // そこへ直接 makeEditable を掛けると、行のほぼ全域がタイトル編集になって「行をクリックで
  // 詳細モーダル」が事実上効かなくなる。編集の当たり判定は文字の分だけにしたいので、
  // 中に文字用の span を1枚挟む（余白のクリックは行のクリックとして通す）。
  const title = el("span", "tree-title");
  const titleText = el("span", null, node.title);
  titleText.title = "クリックで編集";
  makeEditable(titleText, (value) => send({ type: "renameNode", id: node.id, title: value }));
  title.append(titleText);
  row.append(title);

  // 子孫の進捗。葉には出ない（progressOf が total:0 を返す）。
  const progress = progressOf(node.id);
  if (progress.total > 0) {
    const text = `${progress.done}/${progress.total}`;
    const progressEl = el("span", "tree-progress", text);
    if (progress.done === progress.total) progressEl.classList.add("complete");
    progressEl.title = "配下の完了数（未承認の提案は数えません）";
    row.append(progressEl);
  }

  // 未承認の提案はまだ列に並んでいないので、列名は出さない。
  if (node.state !== "proposed") {
    const list = listById(node.listId);
    if (list) {
      const badge = el("span", `tree-list-badge role-${list.role}`, list.title);
      badge.title = "今いる列";
      row.append(badge);
    }
  }

  const chips = [];
  for (const assigneeId of node.assigneeIds) {
    const assignee = board.assignees[assigneeId];
    if (assignee) chips.push(el("span", `chip chip-${assignee.kind}`, assignee.name));
  }
  if (chips.length > 0) {
    const assignees = el("div", "tree-assignees");
    assignees.append(...chips);
    row.append(assignees);
  }

  if (node.dueDate) {
    const due = el("span", "tree-due", `📅 ${node.dueDate}`);
    if (node.dueDate < todayString()) {
      due.classList.add("overdue");
      due.title = "期限切れ";
    }
    row.append(due);
  }

  row.append(renderActions(node, hasChildren));

  // 行のクリックで詳細モーダル。ボタン・入力欄の中は対象外。
  row.addEventListener("click", (e) => {
    if (suppressNextRowClick) {
      suppressNextRowClick = false;
      return;
    }
    if (e.target.closest("button, input, select, textarea, form")) return;
    openNodeDetail(node.id);
  });

  wireDrag(row, node);
  return row;
}

function renderToggle(node, hasChildren) {
  const isCollapsed = collapsed.has(node.id);
  // 葉でも幅は確保する（.leaf は visibility:hidden）。付け忘れると行ごとにタイトルの
  // 開始位置がずれる。
  const toggle = el("button", "tree-toggle", hasChildren ? (isCollapsed ? "▶" : "▼") : "▶");
  toggle.type = "button";
  if (!hasChildren) {
    toggle.classList.add("leaf");
    toggle.tabIndex = -1;
    return toggle;
  }
  toggle.title = isCollapsed ? "展開する" : "畳む";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (collapsed.has(node.id)) collapsed.delete(node.id);
    else collapsed.add(node.id);
    saveCollapsed();
    rerender();
  });
  noDrag(toggle);
  return toggle;
}

function kindLabel(kind) {
  if (kind === "goal") return "目的";
  if (kind === "feature") return "機能";
  return "タスク";
}

/** 期日は "YYYY-MM-DD"（ローカル日付）なので、比較用の今日も同じ形で作る。 */
function todayString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// 行のアクション
// ---------------------------------------------------------------------------

function renderActions(node, hasChildren) {
  const actions = el("div", "tree-actions");

  if (node.state === "proposed") {
    actions.append(
      actionButton("承認", "approve", "この提案を確定してカンバンに載せる（祖先が未承認ならまとめて承認される）", () =>
        send({ type: "approveNode", id: node.id }),
      ),
    );
    if (hasChildren) {
      actions.append(
        actionButton("配下ごと", "approve", "この提案と、その配下の提案をすべて承認する", () =>
          send({ type: "approveNode", id: node.id, recursive: true }),
        ),
      );
    }
    // 却下はサブツリーごと消えるので必ず確認を挟む。
    const reject = actionButton("却下", "reject", "提案をサブツリーごと削除する", () => {
      openConfirm({
        key: `tree-reject:${node.id}`,
        anchorSelector: `.tree-row[data-node-id="${node.id}"] button.reject`,
        align: "right",
        ...rejectConfirm(node),
      });
    });
    actions.append(reject);
  } else {
    if (hasProposedDescendant(node.id)) {
      // AI が既存の目的の下に提案をぶら下げた直後、一番使うボタン。
      actions.append(
        actionButton("配下ごと承認", "approve", "配下にある未承認の提案をすべて承認する", () =>
          send({ type: "approveNode", id: node.id, recursive: true }),
        ),
      );
    }
    // 承認したあとで戻れないとゲートが片道弁になる（まとめて承認したあと一部だけ
    // 戻したい、が実際に起きた）。確定済みの行には常に取り消しを置く。
    actions.append(
      actionButton("戻す", null, "承認を取り消して未承認に戻す（配下の確定済みも一緒に戻る）", () =>
        send({ type: "unapproveNode", id: node.id }),
      ),
    );
  }

  // 担当者ポップオーバーのアンカー（modals.js が .assign-btn を探す）。
  const assign = actionButton("担当", "assign-btn", "担当者を割り当てる", () => {
    assignOpenId = assignOpenId === node.id ? null : node.id;
    toggleAssigneePopover(node.id, "tree");
  });
  actions.append(assign);
  if (assignOpenId === node.id) actions.style.opacity = "1";

  const add = actionButton("＋子", null, "子ノードを追加する", () => {
    if (addChild.parentId === node.id) {
      closeAddChild();
    } else {
      addChild.parentId = node.id;
      // 目的の下は機能、それ以外はタスクを既定に。
      addChild.kind = node.kind === "goal" ? "feature" : "task";
      addChild.value = "";
      // 畳んだままだと追加した子が見えないので開いておく。
      collapsed.delete(node.id);
      saveCollapsed();
    }
    rerender();
  });
  actions.append(add);

  const scoped = ui.scopeId === node.id;
  const scope = actionButton(
    scoped ? "解除" : "絞り込み",
    null,
    scoped ? "絞り込みを解除する" : "カンバンをこのサブツリーだけの表示にする",
    () => {
      ui.scopeId = scoped ? null : node.id;
      rerender();
    },
  );
  actions.append(scope);

  return actions;
}

function actionButton(label, className, title, onClick) {
  const btn = el("button", className ?? undefined, label);
  btn.type = "button";
  btn.title = title;
  btn.addEventListener("click", (e) => {
    // 行の click（詳細モーダル）と、ポップオーバーの外側クリック判定に巻き込ませない。
    e.stopPropagation();
    onClick(e);
  });
  noDrag(btn);
  return btn;
}

/** 配下に未承認の提案がいるか。 */
function hasProposedDescendant(id) {
  for (const descendantId of descendantIds(id)) {
    const node = nodeById(descendantId);
    if (node && node.state === "proposed") return true;
  }
  return false;
}

/** ボタンや入力欄にフォーカスが乗ったまま行をドラッグされないように。 */
function noDrag(node) {
  node.addEventListener("dragstart", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

// ---------------------------------------------------------------------------
// 「＋子」のインライン入力
// ---------------------------------------------------------------------------

const ADD_CHILD_INPUT_ID = "tree-add-child-input";

function closeAddChild() {
  addChild.parentId = null;
  addChild.value = "";
}

function renderAddChildForm(parent) {
  const form = el("form");
  // .tree-children と同じだけ左に寄せて、どの行の子になるのかを見た目で合わせる。
  form.style.cssText =
    "display:flex;gap:6px;align-items:center;margin:2px 0 2px 27px;padding:4px 0;";

  const kindSel = el("select");
  kindSel.style.cssText =
    "background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:4px 6px;font-size:12px;";
  for (const opt of [
    { value: "goal", label: "目的" },
    { value: "feature", label: "機能" },
    { value: "task", label: "タスク" },
  ]) {
    const o = el("option", null, opt.label);
    o.value = opt.value;
    if (opt.value === addChild.kind) o.selected = true;
    kindSel.append(o);
  }
  kindSel.addEventListener("change", () => {
    addChild.kind = kindSel.value;
  });
  noDrag(kindSel);

  const input = el("input");
  input.id = ADD_CHILD_INPUT_ID;
  input.placeholder = `「${parent.title}」の子として追加…`;
  input.value = addChild.value;
  input.style.cssText =
    "flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:4px 8px;font-size:13px;";
  input.addEventListener("input", () => {
    addChild.value = input.value;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeAddChild();
      rerender();
    }
  });
  noDrag(input);

  const submit = el("button", null, "追加");
  submit.type = "submit";
  submit.style.cssText =
    "background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;";
  noDrag(submit);

  const cancel = el("button", null, "閉じる");
  cancel.type = "button";
  cancel.style.cssText =
    "background:none;border:none;color:#7d8590;font-size:11px;cursor:pointer;";
  cancel.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAddChild();
    rerender();
  });
  noDrag(cancel);

  form.addEventListener("click", (e) => e.stopPropagation());
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    const intent = { type: "addNode", parentId: parent.id, title, kind: addChild.kind };
    // 未承認の親の下に確定済みの子を作ると、カンバンに出ているのに親が未承認、という
    // ねじれた状態になる。親が提案なら子も提案として作る。
    if (parent.state === "proposed") intent.state = "proposed";
    send(intent);
    // 続けて足せるように開いたままにする（送信した分だけ空にする）。
    addChild.value = "";
    input.value = "";
    input.focus();
  });

  form.append(kindSel, input, submit, cancel);
  return form;
}

/** 全再描画で作り直された入力欄に、打ちかけの値とフォーカスを戻す。 */
function restoreAddChildInput() {
  if (addChild.parentId === null) return;
  const input = document.getElementById(ADD_CHILD_INPUT_ID);
  if (!input) {
    // 対象の行が他クライアントに消された。開きっぱなしにしない。
    closeAddChild();
    return;
  }
  input.value = addChild.value;
  input.focus();
  const end = input.value.length;
  try {
    input.setSelectionRange(end, end);
  } catch {
    // 選択範囲を持たない状況では何もしない
  }
}

// ---------------------------------------------------------------------------
// DnD（親替えと並べ替え）
// ---------------------------------------------------------------------------
// 行の高さを3分割してドロップの意味を決める:
//   上 25% … その行の兄になる（parentId は target と同じ、beforeId = target）
//   中 50% … その行の子になる（parentId = target、beforeId = null）
//   下 25% … その行の弟になる（parentId は target と同じ、beforeId = target の次の兄弟）
// 見分けが付かないと「入れ子にしたつもりが並べ替えだった」が頻発するので、
// .drop-before / .drop-after / .drop-into を必ず付け替える。

function wireDrag(row, node) {
  row.addEventListener("dragstart", (e) => {
    // 入れ子の li なので、止めないと子の行のドラッグが親の行として解釈されうる
    // （カンバンで実際に起きたバグと同じ形）。
    e.stopPropagation();
    draggingId = node.id;
    suppressNextRowClick = true;
    // ペイロードはカンバン（kind:"card" / "list"）と取り違えないよう kind を分ける。
    e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "tree-node", id: node.id }));
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => row.classList.add("dragging"), 0);
  });

  row.addEventListener("dragend", (e) => {
    e.stopPropagation();
    row.classList.remove("dragging");
    clearMark();
    draggingId = null;
    // ドラッグ後に click が飛ばないブラウザではフラグが残り、次の正常なクリックを
    // 食ってしまう。同じティックの click だけ抑制して、その後は必ず解除する。
    setTimeout(() => {
      suppressNextRowClick = false;
    }, 0);
  });

  row.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/plain")) return;
    // 自分自身・自分の子孫の上には落とさせない（サーバーも弾くが、エラーを出させる前に
    // カーソルの時点で拒否する方が親切）。
    if (!canDrop(node.id)) {
      clearMark();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setMark(row, zoneAt(row, e.clientY));
  });

  row.addEventListener("dragleave", (e) => {
    // 子要素への移動で飛ぶ dragleave では消さない。
    if (e.relatedTarget && row.contains(e.relatedTarget)) return;
    if (markedRow === row) clearMark();
  });

  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = zoneAt(row, e.clientY);
    clearMark();
    const payload = readPayload(e);
    draggingId = null;
    if (!payload || payload.kind !== "tree-node") return;
    if (payload.id === node.id || isSelfOrDescendant(node.id, payload.id)) return;

    if (zone === "into") {
      send({ type: "moveNode", id: payload.id, parentId: node.id, beforeId: null });
      // 落とした先が畳まれていると、動かしたノードが消えたように見える。
      collapsed.delete(node.id);
      saveCollapsed();
      return;
    }
    const beforeId = zone === "before" ? node.id : nextSiblingId(node, payload.id);
    send({ type: "moveNode", id: payload.id, parentId: node.parentId, beforeId });
  });
}

function zoneAt(row, clientY) {
  const rect = row.getBoundingClientRect();
  const offset = clientY - rect.top;
  if (offset < rect.height * 0.25) return "before";
  if (offset > rect.height * 0.75) return "after";
  return "into";
}

function setMark(row, zone) {
  const className = zone === "before" ? "drop-before" : zone === "after" ? "drop-after" : "drop-into";
  if (markedRow === row && row.classList.contains(className)) return;
  clearMark();
  row.classList.add(className);
  markedRow = row;
}

function clearMark() {
  if (!markedRow) return;
  markedRow.classList.remove("drop-before", "drop-after", "drop-into");
  markedRow = null;
}

/** ドラッグ中のノードを targetId の位置に落としてよいか。 */
function canDrop(targetId) {
  if (draggingId === null) return false;
  if (targetId === draggingId) return false;
  // target が自分の子孫なら、親にすると木が輪になる。
  return !isSelfOrDescendant(targetId, draggingId);
}

/** candidateId が ancestorId 自身か、その子孫か（src/ops.ts の同名関数と同じ判定）。 */
function isSelfOrDescendant(candidateId, ancestorId) {
  let node = nodeById(candidateId);
  const seen = new Set();
  while (node) {
    if (node.id === ancestorId) return true;
    if (node.parentId === null || seen.has(node.parentId)) return false;
    seen.add(node.parentId);
    node = nodeById(node.parentId);
  }
  return false;
}

/**
 * target の次の兄弟の id（無ければ null）。
 * 動かすノード自身は兄弟の並びから外して数える。サーバーの placeBefore は
 * beforeId に自分自身を渡されると末尾送りにしてしまうため、ここで避けておく。
 */
function nextSiblingId(target, movingId) {
  const siblings = (target.parentId === null ? board.rootIds : nodeById(target.parentId)?.childIds ?? []).filter(
    (id) => id !== movingId,
  );
  const index = siblings.indexOf(target.id);
  if (index === -1) return null;
  return siblings[index + 1] ?? null;
}

/** drop 時のペイロード。dragover 中は getData が使えないので types で判定していること。 */
function readPayload(e) {
  try {
    return JSON.parse(e.dataTransfer.getData("text/plain"));
  } catch {
    return null;
  }
}

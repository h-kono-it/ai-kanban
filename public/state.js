// ボードのローカルコピーと、画面ローカルの UI 状態を持つ唯一の場所。
//
// 設計の核: サーバーが配信する正規化済みの Op を applyOp() で手元の board に機械的に
// 当てる。src/ops.ts の apply() の鏡像なので、片方を変えたらもう片方も必ず変えること。
// 楽観更新はしない（送るのは意図だけで、画面が変わるのは Op が返ってきてから）。
//
// 循環 import を避けるため、このモジュールは他の public/*.js を import しない。
// 再描画は onRender() で登録されたフックを rerender() で呼ぶ形にしてある。

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

/** サーバーには送らない、この画面だけの表示状態。 */
export const ui = {
  /** "kanban" | "tree" */
  view: "kanban",
  /** ツリーで選んだ絞り込み対象のノード id。null ならボード全体。 */
  scopeId: null,
  /** 担当者フィルタ（クライアントローカル。WebSocket には流さない）。 */
  filterIds: new Set(),
};

/** BoardState。{type:"state"} を受けるたび丸ごと差し替わる。届くまでは null。 */
export let board = null;

/** 差分同期の通し番号。state で置き換え、op で 1 ずつ進む。 */
export let seq = 0;

/** 接続直後・resync 応答で全体像を丸ごと置き換える。 */
export function replaceState(nextBoard, nextSeq) {
  board = nextBoard;
  seq = nextSeq;
  pruneUi();
}

/**
 * seq を進める。ESM の export let は import 側から代入できないので setter を置く。
 * seq を動かしてよいのは ws.js だけ（op の連番検証とセットで扱うため）。
 */
export function setSeq(next) {
  seq = next;
}

/**
 * 他クライアントの操作で消えた id が UI 状態に残っていると、フィルタが効かない・
 * 空のスコープに閉じ込められる、といった直しようのない状態になる。state を受けるたび掃除する。
 */
function pruneUi() {
  if (!board) return;
  for (const id of [...ui.filterIds]) {
    if (!board.assignees[id]) ui.filterIds.delete(id);
  }
  if (ui.scopeId !== null && !board.nodes[ui.scopeId]) ui.scopeId = null;
}

// ---------------------------------------------------------------------------
// 再描画フック
// ---------------------------------------------------------------------------

let renderFn = null;

/** app.js が render() を登録する。state.js → app.js の import を作らないための仕組み。 */
export function onRender(fn) {
  renderFn = fn;
}

export function rerender() {
  if (renderFn) renderFn();
}

// ---------------------------------------------------------------------------
// 読み取りの小道具
// ---------------------------------------------------------------------------

export function nodeById(id) {
  if (!board || id === null || id === undefined) return null;
  return board.nodes[id] ?? null;
}

export function listById(id) {
  if (!board) return null;
  return board.lists.find((l) => l.id === id) ?? null;
}

/** 葉＝子を持たないノード。カンバンに出るのは葉だけ（親は「箱」でカードではない）。 */
export function isLeaf(node) {
  return !!node && node.childIds.length === 0;
}

/** 子の id 配列。id が null ならルート（＝目的）の並び。 */
export function childIdsOf(id) {
  if (!board) return [];
  if (id === null) return board.rootIds;
  return board.nodes[id]?.childIds ?? [];
}

/** 祖先のタイトルをルート側から順に。自分自身は含めない。 */
export function breadcrumb(id) {
  const titles = [];
  let node = nodeById(id);
  // 万一データが輪になっていても固まらないよう、訪問済みで打ち切る。
  const seen = new Set();
  while (node && node.parentId !== null && !seen.has(node.parentId)) {
    seen.add(node.parentId);
    const parent = nodeById(node.parentId);
    if (!parent) break;
    titles.unshift(parent.title);
    node = parent;
  }
  return titles;
}

/** 子孫の id を深さ優先で。自分自身は含めない（スコープ絞り込みがそういう意味なので）。 */
export function descendantIds(id) {
  const out = [];
  const visit = (nodeId) => {
    for (const childId of childIdsOf(nodeId)) {
      out.push(childId);
      visit(childId);
    }
  };
  if (nodeById(id)) visit(id);
  return out;
}

/** role="done" の列の id 集合。 */
export function doneListIds() {
  const ids = new Set();
  if (!board) return ids;
  for (const list of board.lists) {
    if (list.role === "done") ids.add(list.id);
  }
  return ids;
}

/**
 * 子孫の進捗 {done, total}。
 * 数えるのは state="active" の子孫だけ（proposed はまだ盤に載っていないので分母に入れない）。
 * 中間ノード（機能など）も1件として数える素直な数え方にしてある。
 */
export function progressOf(id) {
  const done = doneListIds();
  let total = 0;
  let doneCount = 0;
  for (const descendantId of descendantIds(id)) {
    const node = nodeById(descendantId);
    if (!node || node.state !== "active") continue;
    total += 1;
    if (done.has(node.listId)) doneCount += 1;
  }
  return { done: doneCount, total };
}

// ---------------------------------------------------------------------------
// 共有の DOM 小道具
// ---------------------------------------------------------------------------
// 本来は dom.js に置きたいが、ファイルを増やさない方針なので全モジュールが import する
// ここに同居させている（tree.js / modals.js からも使う想定）。

export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * クリックで input に化けるインライン編集。commit すると元の要素に戻る。
 * 全再描画なので、編集中に他クライアントの Op が来ると入れ替えた要素ごと捨てられる。
 * それでも「打った内容が消える」のは blur→commit が先に走るので実害が出にくい。
 */
export function makeEditable(target, onCommit, eventName = "click") {
  target.addEventListener(eventName, (e) => {
    e.stopPropagation();
    const input = el("input");
    input.value = target.textContent;
    target.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const value = input.value.trim();
      if (value && value !== target.textContent) onCommit(value);
      input.replaceWith(target);
    };
    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") input.blur();
      if (ev.key === "Escape") {
        input.removeEventListener("blur", commit);
        input.replaceWith(target);
      }
    });
    // ドラッグ可能な要素の中に置かれるので、入力中にドラッグが始まらないようにする。
    input.addEventListener("dragstart", (ev) => ev.preventDefault());
  });
}

// ---------------------------------------------------------------------------
// applyOp
// ---------------------------------------------------------------------------

/** 親の子配列（parentId が null ならルートの並び）。実体を返す＝ splice で直接いじる。 */
function siblingsOf(parentId) {
  if (!board) return null;
  if (parentId === null) return board.rootIds;
  return board.nodes[parentId]?.childIds ?? null;
}

function removeFrom(array, value) {
  const i = array.indexOf(value);
  if (i !== -1) array.splice(i, 1);
}

/** ids を nodes / rootIds / 全 childIds / 全 lists[].nodeIds から一括で消す。 */
function purgeNodes(ids) {
  const gone = new Set(ids);
  for (const id of gone) delete board.nodes[id];
  board.rootIds = board.rootIds.filter((id) => !gone.has(id));
  for (const node of Object.values(board.nodes)) {
    node.childIds = node.childIds.filter((id) => !gone.has(id));
  }
  for (const list of board.lists) {
    list.nodeIds = list.nodeIds.filter((id) => !gone.has(id));
  }
}

/**
 * サーバーが配信した正規化済み Op を手元の board へ適用する。
 * src/ops.ts の apply() と 1:1 対応（Op の形を変えたら両方を直すこと）。
 * op は検証済み前提なので includes 判定などはせず載っている値に従うが、
 * 対象が見つからない＝手元がズレている合図なので false を返す。呼び出し側（ws.js）が
 * resync して全体を取り直す。未知の type も同じく false。
 */
export function applyOp(op) {
  if (!board) return false;

  switch (op.type) {
    // ---- ツリー ------------------------------------------------------------
    case "addNode": {
      const node = op.node;
      const siblings = siblingsOf(node.parentId);
      if (!siblings) return false;
      board.nodes[node.id] = node;
      siblings.splice(op.treeIndex, 0, node.id);
      // proposed のノードは列に載らない。サーバーは listIndex を null で返してくる。
      if (op.listIndex !== null) {
        const list = listById(node.listId);
        if (!list) return false;
        list.nodeIds.splice(op.listIndex, 0, node.id);
      }
      return true;
    }

    case "renameNode": {
      const node = nodeById(op.id);
      if (!node) return false;
      node.title = op.title;
      return true;
    }

    case "setNodeDescription": {
      const node = nodeById(op.id);
      if (!node) return false;
      node.description = op.description;
      return true;
    }

    case "setNodeDueDate": {
      const node = nodeById(op.id);
      if (!node) return false;
      node.dueDate = op.dueDate;
      return true;
    }

    case "setNodeKind": {
      const node = nodeById(op.id);
      if (!node) return false;
      node.kind = op.kind;
      return true;
    }

    case "moveNode": {
      const node = nodeById(op.id);
      if (!node) return false;
      const from = siblingsOf(node.parentId);
      if (from) removeFrom(from, node.id);
      const to = siblingsOf(op.parentId);
      if (!to) return false;
      node.parentId = op.parentId;
      to.splice(op.treeIndex, 0, node.id);
      // 列は動かさない（ツリー上の位置とカンバン上の位置は独立）。
      return true;
    }

    case "deleteNode":
    case "rejectNode": {
      // ids は自分を含むサブツリー全部。親の childIds も列も同時に掃除する。
      purgeNodes(op.ids);
      return true;
    }

    case "toggleNodeAssignee": {
      const node = nodeById(op.nodeId);
      if (!node) return false;
      // includes 判定はせず present に従う（重複を避けるため一旦外してから足す）。
      const without = node.assigneeIds.filter((id) => id !== op.assigneeId);
      node.assigneeIds = op.present ? [...without, op.assigneeId] : without;
      return true;
    }

    // ---- 承認ゲート ---------------------------------------------------------
    case "approveNode": {
      // entries は祖先→子孫の順。listIndex はその順に適用した前提で採番されているので、
      // 並び替えずに順に当てること。
      for (const entry of op.entries) {
        const node = nodeById(entry.id);
        const list = listById(entry.listId);
        if (!node || !list) return false;
        node.state = "active";
        node.completedAt = entry.completedAt;
        list.nodeIds.splice(entry.listIndex, 0, entry.id);
      }
      return true;
    }

    case "unapproveNode": {
      // ids は自分と子孫のうち確定済みだったもの。まとめて未承認に戻り、カンバンから外れる。
      const gone = new Set(op.ids);
      for (const id of op.ids) {
        const node = nodeById(id);
        if (!node) return false;
        node.state = "proposed";
        node.completedAt = null;
      }
      for (const list of board.lists) {
        list.nodeIds = list.nodeIds.filter((id) => !gone.has(id));
      }
      return true;
    }

    // ---- カンバン -----------------------------------------------------------
    case "moveCard": {
      const node = nodeById(op.id);
      const to = listById(op.listId);
      if (!node || !to) return false;
      // 元の列だけでなく全列から一旦外す。取りこぼして二重に並ぶより安全。
      for (const list of board.lists) removeFrom(list.nodeIds, op.id);
      node.listId = op.listId;
      // サーバーが算出した完了時刻（done 出入りで now / null）をそのまま反映する。
      node.completedAt = op.completedAt;
      to.nodeIds.splice(op.listIndex, 0, op.id);
      return true;
    }

    case "addList": {
      board.lists.splice(op.index, 0, op.list);
      return true;
    }

    case "renameList": {
      const list = listById(op.id);
      if (!list) return false;
      list.title = op.title;
      return true;
    }

    case "setListRole": {
      const list = listById(op.id);
      if (!list) return false;
      list.role = op.role;
      return true;
    }

    case "deleteList": {
      const index = board.lists.findIndex((l) => l.id === op.id);
      if (index === -1) return false;
      board.lists.splice(index, 1);
      // 列を消してもノードは消えない。退避先の末尾へ movedNodeIds の順に移す。
      if (op.movedToListId !== null) {
        const to = listById(op.movedToListId);
        if (!to) return false;
        for (const id of op.movedNodeIds) {
          const node = nodeById(id);
          if (!node) continue;
          node.listId = op.movedToListId;
          // 退避先が完了列でなければ完了時刻を落とす（サーバーの deleteList と同じ判断）。
          if (to.role !== "done") node.completedAt = null;
          // proposed は列に載らないので nodeIds には積まない（listId だけ付け替える）。
          if (node.state === "active") to.nodeIds.push(id);
        }
      }
      return true;
    }

    case "moveList": {
      const index = board.lists.findIndex((l) => l.id === op.id);
      if (index === -1) return false;
      const [moved] = board.lists.splice(index, 1);
      board.lists.splice(op.index, 0, moved);
      return true;
    }

    // ---- メンバー -----------------------------------------------------------
    case "addAssignee": {
      board.assignees[op.assignee.id] = op.assignee;
      return true;
    }

    case "renameAssignee": {
      const assignee = board.assignees[op.id];
      if (!assignee) return false;
      assignee.name = op.name;
      return true;
    }

    case "deleteAssignee": {
      delete board.assignees[op.id];
      for (const assignee of Object.values(board.assignees)) {
        assignee.memberIds = assignee.memberIds.filter((id) => id !== op.id);
      }
      for (const node of Object.values(board.nodes)) {
        node.assigneeIds = node.assigneeIds.filter((id) => id !== op.id);
      }
      // 消えた担当者でフィルタしたままだと全カードが薄くなって戻せない。
      ui.filterIds.delete(op.id);
      return true;
    }

    case "toggleTeamMember": {
      const team = board.assignees[op.teamId];
      if (!team) return false;
      const without = team.memberIds.filter((id) => id !== op.memberId);
      team.memberIds = op.present ? [...without, op.memberId] : without;
      return true;
    }

    // ---- ボード -------------------------------------------------------------
    case "renameBoard": {
      board.title = op.title;
      return true;
    }

    case "setBoardSettings": {
      board.settings = op.settings;
      return true;
    }

    default:
      // 知らない Op＝サーバーが先に進んでいる。resync させる。
      return false;
  }
}

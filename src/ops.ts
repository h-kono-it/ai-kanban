// 意図（Intent）を1つ受け取って SQLite に適用し、正規化済みの Op を返す唯一の入口。
// ブラウザ（WebSocket）も Claude Code（REST）も必ずここを通り、返ってきた Op が
// 全接続へブロードキャストされる。ここを通さない書き込みを足すと、開いている画面が
// 黙ってズレるので絶対に増やさないこと。
//
// Op は受信メッセージのエコーではなく「実際に適用された結果」。id は採番済み、
// 順序は解決済み、トグルは present で明示する。クライアントの applyOp が検証なしで
// 機械的に適用できる形にしてある。
// ★ ここの Op 形状を変えたら public/state.js の applyOp も必ず更新すること。

import type { Db } from "./db.ts";
import { transact } from "./db.ts";
import type { AssigneeRow, ListRow, NodeRow } from "./store.ts";
import { parseSettings, queryAll, queryOne } from "./store.ts";
import type {
  Assignee,
  AssigneeKind,
  BeforeId,
  BoardSettings,
  Intent,
  ListRole,
  NodeKind,
  NodeSeed,
  NodeState,
  Op,
  TaskNode,
} from "./types.ts";
import { newId, nowIso } from "./util.ts";

export interface AppliedOp {
  seq: number;
  op: Op;
}

/** 不正な意図はこれを投げる。呼び出し側が WS では error メッセージ、REST では 400 に変換する。 */
export class OpError extends Error {}

/**
 * 意図を1つ適用し、正規化済み Op と採番済み seq の列を返す。
 * トランザクションと boards.seq の更新はこの関数の責務。
 * 何も変わらなかった場合（タイトルが空、既に承認済みなど）は空配列を返す。
 */
export function applyIntent(db: Db, boardId: string, intent: Intent): AppliedOp[] {
  return transact(db, () => {
    const ops = apply(db, boardId, intent);
    if (ops.length === 0) return [];
    // seq は Op の個数だけ進める。クライアントは連番の欠落で取りこぼしを検出して
    // resync するので、1 Op = 1 seq を崩さないこと。
    const before = queryOne<{ seq: number }>(db, "SELECT seq FROM boards WHERE id = ?", boardId);
    if (!before) throw new OpError(`ボードが見つかりません: ${boardId}`);
    const base = Number(before.seq);
    db.prepare("UPDATE boards SET seq = seq + ? WHERE id = ?").run(ops.length, boardId);
    return ops.map((op, i) => ({ seq: base + i + 1, op }));
  });
}

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NODE_KINDS: NodeKind[] = ["goal", "feature", "task"];
const NODE_STATES: NodeState[] = ["active", "proposed"];
const LIST_ROLES: ListRole[] = ["normal", "awaiting_human", "done"];

/** REST 経由の JSON は型が保証されないので、文字列以外は空文字（＝no-op）に倒す。 */
function trimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKind(value: NodeKind | undefined): NodeKind {
  if (value === undefined) return "task";
  if (!NODE_KINDS.includes(value)) throw new OpError(`不正な kind: ${String(value)}`);
  return value;
}

function normalizeState(value: NodeState | undefined, fallback: NodeState): NodeState {
  if (value === undefined) return fallback;
  if (!NODE_STATES.includes(value)) throw new OpError(`不正な state: ${String(value)}`);
  return value;
}

function normalizeRole(value: ListRole | undefined, fallback: ListRole): ListRole {
  if (value === undefined) return fallback;
  if (!LIST_ROLES.includes(value)) throw new OpError(`不正な role: ${String(value)}`);
  return value;
}

/** 期日は "YYYY-MM-DD" か null のみ。空文字は「未設定」と解釈する。 */
function normalizeDueDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new OpError(`期日は YYYY-MM-DD 形式で指定してください: ${String(value)}`);
  return value;
}

function findNode(db: Db, boardId: string, id: string): NodeRow | undefined {
  return queryOne<NodeRow>(db, "SELECT * FROM nodes WHERE id = ? AND board_id = ?", id, boardId);
}

function requireNode(db: Db, boardId: string, id: string): NodeRow {
  const node = findNode(db, boardId, id);
  if (!node) throw new OpError(`ノードが見つかりません: ${id}`);
  return node;
}

function requireList(db: Db, boardId: string, id: string): ListRow {
  const list = queryOne<ListRow>(db, "SELECT * FROM lists WHERE id = ? AND board_id = ?", id, boardId);
  if (!list) throw new OpError(`列が見つかりません: ${id}`);
  return list;
}

function requireAssignee(db: Db, boardId: string, id: string): AssigneeRow {
  const assignee = queryOne<AssigneeRow>(db, "SELECT * FROM assignees WHERE id = ? AND board_id = ?", id, boardId);
  if (!assignee) throw new OpError(`担当者が見つかりません: ${id}`);
  return assignee;
}

/** listId 省略時の既定列＝role="normal" の最初の列。normal が無ければ先頭の列。 */
function defaultList(db: Db, boardId: string): ListRow {
  const normal = queryOne<ListRow>(
    db,
    "SELECT * FROM lists WHERE board_id = ? AND role = 'normal' ORDER BY position LIMIT 1",
    boardId,
  );
  if (normal) return normal;
  const first = queryOne<ListRow>(db, "SELECT * FROM lists WHERE board_id = ? ORDER BY position LIMIT 1", boardId);
  if (!first) throw new OpError("列が1つもありません");
  return first;
}

/** 兄弟（同じ親を持つノード）の id を tree_pos 順で。parent_id IS ? は NULL でも一致する。 */
function siblingIds(db: Db, boardId: string, parentId: string | null): string[] {
  return queryAll<{ id: string }>(
    db,
    "SELECT id FROM nodes WHERE board_id = ? AND parent_id IS ? ORDER BY tree_pos",
    boardId,
    parentId,
  ).map((r) => r.id);
}

/** 列に並んでいる active なノードの id を list_pos 順で（proposed はカンバンに載らない）。 */
function activeIdsInList(db: Db, boardId: string, listId: string): string[] {
  return queryAll<{ id: string }>(
    db,
    "SELECT id FROM nodes WHERE board_id = ? AND list_id = ? AND state = 'active' ORDER BY list_pos",
    boardId,
    listId,
  ).map((r) => r.id);
}

function listIdsInOrder(db: Db, boardId: string): string[] {
  return queryAll<{ id: string }>(db, "SELECT id FROM lists WHERE board_id = ? ORDER BY position", boardId).map((r) => r.id);
}

/**
 * 並び順カラムを渡された配列の順で 0..n-1 に振り直す。
 * 移動・削除・挿入のたびにグループを読み直して一括 UPDATE する素朴な方式
 * （1グループはせいぜい数百件なので、隙間を空ける小細工より単純さを取る）。
 */
function writeOrder(db: Db, table: "nodes" | "lists", column: "tree_pos" | "list_pos" | "position", ids: string[]): void {
  const stmt = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
  ids.forEach((id, i) => {
    stmt.run(i, id);
  });
}

/**
 * ids の中で「beforeId の直前」に id を差し込んだ並びと、その位置を返す。
 * beforeId が null / 対象グループに居ない / 自分自身なら末尾。
 * 表示側の絞り込みで DOM の index が実データとズレるため、順序指定は index ではなく
 * beforeId で受ける（旧 my-kanban の index 方式はここが弱かった）。
 */
function placeBefore(ids: string[], id: string, beforeId: BeforeId | undefined): { ids: string[]; index: number } {
  const rest = ids.filter((x) => x !== id);
  const at = beforeId === null || beforeId === undefined ? -1 : rest.indexOf(beforeId);
  const index = at === -1 ? rest.length : at;
  rest.splice(index, 0, id);
  return { ids: rest, index };
}

/** 自分を含むサブツリーの id を、親が子より先に来る順で集める。 */
function subtreeIds(db: Db, boardId: string, id: string): string[] {
  return queryAll<{ id: string }>(
    db,
    `WITH RECURSIVE sub(id, depth, tree_pos) AS (
       SELECT id, 0, tree_pos FROM nodes WHERE id = ? AND board_id = ?
       UNION ALL
       SELECT n.id, sub.depth + 1, n.tree_pos FROM nodes n JOIN sub ON n.parent_id = sub.id
     )
     SELECT id FROM sub ORDER BY depth, tree_pos`,
    id,
    boardId,
  ).map((r) => r.id);
}

/** candidateId が ancestorId の子孫（または本人）か。moveNode の循環検出用に親を辿る。 */
function isSelfOrDescendant(db: Db, boardId: string, ancestorId: string, candidateId: string): boolean {
  let cur = findNode(db, boardId, candidateId);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parent_id === null ? undefined : findNode(db, boardId, cur.parent_id);
  }
  return false;
}

/** サブツリーを消したあとの後始末（兄弟と、載っていた列の再採番）をまとめる。 */
function deleteSubtree(db: Db, boardId: string, root: NodeRow): string[] {
  const ids = subtreeIds(db, boardId, root.id);
  const listIds = new Set(
    queryAll<{ list_id: string }>(
      db,
      `SELECT DISTINCT list_id FROM nodes WHERE id IN (${placeholders(ids.length)})`,
      ...ids,
    ).map((r) => r.list_id),
  );
  db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders(ids.length)})`).run(...ids);
  writeOrder(db, "nodes", "tree_pos", siblingIds(db, boardId, root.parent_id));
  for (const listId of listIds) {
    writeOrder(db, "nodes", "list_pos", activeIdsInList(db, boardId, listId));
  }
  return ids;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function touchNode(db: Db, id: string, now: string): void {
  db.prepare("UPDATE nodes SET updated_at = ? WHERE id = ?").run(now, id);
}

// ---------------------------------------------------------------------------
// ノード生成（addNode と bulkAddNodes の共通実体）
// ---------------------------------------------------------------------------

interface AddNodeInput {
  parentId: string | null;
  beforeId?: BeforeId;
  title: string;
  kind?: NodeKind;
  description?: string;
  listId?: string;
  state?: NodeState;
  dueDate?: string | null;
  assigneeIds?: string[];
}

/** ノードを1つ作る。タイトルが空なら何もせず null（＝no-op）を返す。 */
function insertNode(db: Db, boardId: string, input: AddNodeInput, defaultState: NodeState): { op: Op; node: TaskNode } | null {
  const title = trimmedText(input.title);
  if (!title) return null;

  const parent = input.parentId === null ? null : requireNode(db, boardId, input.parentId);
  const list = input.listId === undefined ? defaultList(db, boardId) : requireList(db, boardId, input.listId);
  const kind = normalizeKind(input.kind);
  // 親が未承認なら子も強制的に未承認にする。approveNode が「祖先の proposed も一緒に
  // active にする」ことで守っている不変条件（親が未承認なのに子だけ確定している状態を
  // 作らない）の裏返しで、こちら側で塞がないと API から addNode するだけで崩せてしまう。
  const requested = normalizeState(input.state, defaultState);
  const state: NodeState = parent?.state === "proposed" ? "proposed" : requested;
  const dueDate = normalizeDueDate(input.dueDate);
  const now = nowIso();
  const id = newId();

  // active なら列の末尾に置く。列内の位置は beforeId の対象外で、beforeId はツリーの
  // 兄弟順にだけ効く。proposed はカンバンに載らないので list_pos は使われない（NOT NULL なので 0）。
  const isActive = state === "active";
  const listIndex = isActive ? activeIdsInList(db, boardId, list.id).length : null;
  // 完了列に直接置かれたら完了扱いにする（旧 my-kanban の addCard と同じ配慮）。
  const completedAt = isActive && list.role === "done" ? now : null;

  const placed = placeBefore(siblingIds(db, boardId, input.parentId), id, input.beforeId);
  db.prepare(
    `INSERT INTO nodes (id, board_id, parent_id, kind, state, title, description, list_id,
                        tree_pos, list_pos, due_date, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    boardId,
    input.parentId,
    kind,
    state,
    title,
    typeof input.description === "string" ? input.description : "",
    list.id,
    placed.index,
    listIndex ?? 0,
    dueDate,
    completedAt,
    now,
    now,
  );
  writeOrder(db, "nodes", "tree_pos", placed.ids);

  const assigneeIds: string[] = [];
  for (const assigneeId of input.assigneeIds ?? []) {
    requireAssignee(db, boardId, assigneeId);
    if (assigneeIds.includes(assigneeId)) continue;
    db.prepare("INSERT INTO node_assignees (node_id, assignee_id) VALUES (?, ?)").run(id, assigneeId);
    assigneeIds.push(assigneeId);
  }

  const node: TaskNode = {
    id,
    parentId: input.parentId,
    kind,
    state,
    title,
    description: typeof input.description === "string" ? input.description : "",
    listId: list.id,
    childIds: [],
    assigneeIds,
    dueDate,
    completedAt,
    createdAt: now,
    updatedAt: now,
  };
  return { op: { type: "addNode", node, treeIndex: placed.index, listIndex }, node };
}

/**
 * 入れ子の種を深さ優先で辿って addNode の Op に展開する。
 * 親を必ず子より先に流すこと（クライアントは順に applyOp するため）。
 * 同じ beforeId の直前に順番に差し込んでいくと、種の並び順がそのまま兄弟順になる。
 */
function expandSeeds(
  db: Db,
  boardId: string,
  parentId: string | null,
  beforeId: BeforeId | undefined,
  seeds: NodeSeed[],
  state: NodeState,
): Op[] {
  const ops: Op[] = [];
  for (const seed of seeds) {
    const created = insertNode(
      db,
      boardId,
      {
        parentId,
        beforeId,
        title: seed.title,
        kind: seed.kind,
        description: seed.description,
        listId: seed.listId,
        state,
        dueDate: seed.dueDate,
        assigneeIds: seed.assigneeIds,
      },
      state,
    );
    // 一括投入の途中でタイトルが空だと、その子が親を失って宙に浮く。
    // 黙って落とすとどこが欠けたか分からないので、まとめて失敗させる（トランザクションごと巻き戻る）。
    if (!created) throw new OpError("タイトルが空のノードは追加できません");
    ops.push(created.op);
    if (seed.children && seed.children.length > 0) {
      ops.push(...expandSeeds(db, boardId, created.node.id, null, seed.children, state));
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function apply(db: Db, boardId: string, intent: Intent): Op[] {
  switch (intent.type) {
    // ---- ツリー ----------------------------------------------------------
    case "addNode": {
      const created = insertNode(
        db,
        boardId,
        {
          parentId: intent.parentId,
          beforeId: intent.beforeId,
          title: intent.title,
          kind: intent.kind,
          description: intent.description,
          listId: intent.listId,
          state: intent.state,
          dueDate: intent.dueDate,
          assigneeIds: intent.assigneeIds,
        },
        "active",
      );
      return created ? [created.op] : [];
    }

    case "renameNode": {
      const node = requireNode(db, boardId, intent.id);
      const title = trimmedText(intent.title);
      if (!title) return [];
      db.prepare("UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?").run(title, nowIso(), node.id);
      return [{ type: "renameNode", id: node.id, title }];
    }

    case "setNodeDescription": {
      const node = requireNode(db, boardId, intent.id);
      const description = typeof intent.description === "string" ? intent.description : "";
      db.prepare("UPDATE nodes SET description = ?, updated_at = ? WHERE id = ?").run(description, nowIso(), node.id);
      return [{ type: "setNodeDescription", id: node.id, description }];
    }

    case "setNodeDueDate": {
      const node = requireNode(db, boardId, intent.id);
      const dueDate = normalizeDueDate(intent.dueDate);
      db.prepare("UPDATE nodes SET due_date = ?, updated_at = ? WHERE id = ?").run(dueDate, nowIso(), node.id);
      return [{ type: "setNodeDueDate", id: node.id, dueDate }];
    }

    case "setNodeKind": {
      const node = requireNode(db, boardId, intent.id);
      const kind = normalizeKind(intent.kind);
      db.prepare("UPDATE nodes SET kind = ?, updated_at = ? WHERE id = ?").run(kind, nowIso(), node.id);
      return [{ type: "setNodeKind", id: node.id, kind }];
    }

    case "moveNode": {
      const node = requireNode(db, boardId, intent.id);
      if (intent.parentId !== null) {
        requireNode(db, boardId, intent.parentId);
        // 自分自身や子孫を親にすると木が輪になって二度と辿れなくなる。
        if (isSelfOrDescendant(db, boardId, node.id, intent.parentId)) {
          throw new OpError("自分自身または子孫を親にはできません");
        }
      }
      const oldParentId = node.parent_id;
      db.prepare("UPDATE nodes SET parent_id = ?, updated_at = ? WHERE id = ?").run(intent.parentId, nowIso(), node.id);
      // 列は動かさない（ツリー上の位置とカンバン上の位置は独立）。
      const placed = placeBefore(siblingIds(db, boardId, intent.parentId), node.id, intent.beforeId);
      writeOrder(db, "nodes", "tree_pos", placed.ids);
      if (oldParentId !== intent.parentId) {
        writeOrder(db, "nodes", "tree_pos", siblingIds(db, boardId, oldParentId));
      }
      return [{ type: "moveNode", id: node.id, parentId: intent.parentId, treeIndex: placed.index }];
    }

    case "deleteNode": {
      const node = requireNode(db, boardId, intent.id);
      // 外部キーの CASCADE 任せにせず id を集めてから消す。クライアントが一括で
      // 手元の状態から落とせるように、消えた子孫を Op に全部載せるため。
      const ids = deleteSubtree(db, boardId, node);
      return [{ type: "deleteNode", ids }];
    }

    case "toggleNodeAssignee": {
      const node = requireNode(db, boardId, intent.nodeId);
      const assignee = requireAssignee(db, boardId, intent.assigneeId);
      const existing = queryOne<{ node_id: string }>(
        db,
        "SELECT node_id FROM node_assignees WHERE node_id = ? AND assignee_id = ?",
        node.id,
        assignee.id,
      );
      const present = existing === undefined;
      if (present) {
        db.prepare("INSERT INTO node_assignees (node_id, assignee_id) VALUES (?, ?)").run(node.id, assignee.id);
      } else {
        db.prepare("DELETE FROM node_assignees WHERE node_id = ? AND assignee_id = ?").run(node.id, assignee.id);
      }
      touchNode(db, node.id, nowIso());
      return [{ type: "toggleNodeAssignee", nodeId: node.id, assigneeId: assignee.id, present }];
    }

    case "bulkAddNodes": {
      if (intent.parentId !== null) requireNode(db, boardId, intent.parentId);
      // AI の提案は既定で未承認。人間が approveNode するまでカンバンには出ない。
      const state = normalizeState(intent.state, "proposed");
      return expandSeeds(db, boardId, intent.parentId, intent.beforeId, intent.nodes ?? [], state);
    }

    // ---- 承認ゲート -------------------------------------------------------
    case "approveNode": {
      const node = requireNode(db, boardId, intent.id);
      // 対象が既に確定済みでも recursive なら配下の提案を承認する。
      // 「承認済みの目的の下に AI が提案をぶら下げ、まとめて承認する」が主要な使い道なので、
      // ここで打ち切ると一番使うボタンが無反応になる。
      if (node.state === "active" && intent.recursive !== true) return [];

      // 祖先に proposed が残っていれば一緒に active にする。
      // 親が未承認なのに子だけ確定している状態を作らないため。
      const targets: NodeRow[] = [];
      let cur: NodeRow | undefined = node.state === "proposed" ? node : undefined;
      while (cur && cur.state === "proposed") {
        targets.unshift(cur);
        cur = cur.parent_id === null ? undefined : findNode(db, boardId, cur.parent_id);
      }
      if (intent.recursive === true) {
        for (const id of subtreeIds(db, boardId, node.id)) {
          if (id === node.id) continue;
          const descendant = findNode(db, boardId, id);
          if (descendant && descendant.state === "proposed") targets.push(descendant);
        }
      }
      // 承認すべきものが1つも無ければ seq を進めない。
      if (targets.length === 0) return [];

      const now = nowIso();
      const roles = new Map(
        queryAll<ListRow>(db, "SELECT * FROM lists WHERE board_id = ?", boardId).map((l) => [l.id, l.role]),
      );
      const entries: { id: string; listId: string; listIndex: number; completedAt: string | null }[] = [];
      const update = db.prepare(
        "UPDATE nodes SET state = 'active', list_pos = ?, completed_at = ?, updated_at = ? WHERE id = ?",
      );
      for (const target of targets) {
        // active になった順に自分の列の末尾へ積む。列内の件数は都度数え直す。
        const listIndex = activeIdsInList(db, boardId, target.list_id).length;
        // 完了列に居るまま承認されたらその場で完了扱い（addNode が完了列に直接作るときと揃える）。
        const completedAt = roles.get(target.list_id) === "done" ? (target.completed_at ?? now) : null;
        update.run(listIndex, completedAt, now, target.id);
        entries.push({ id: target.id, listId: target.list_id, listIndex, completedAt });
      }
      return [{ type: "approveNode", entries }];
    }

    case "unapproveNode": {
      const node = requireNode(db, boardId, intent.id);
      if (node.state === "proposed") return [];

      // 自分と子孫のうち確定済みのものを、まとめて未承認に戻す。
      // 「親が proposed なら子も proposed」の不変条件があるので、子孫を確定させたまま
      // 自分だけ戻すことはできない（approveNode が祖先を巻き込むのと対称）。
      const rows = subtreeIds(db, boardId, node.id)
        .map((id) => findNode(db, boardId, id))
        .filter((row): row is NodeRow => row !== undefined && row.state === "active");
      if (rows.length === 0) return [];

      // 抜けたあとに再採番する列を、UPDATE する前に控えておく。
      const listIds = new Set(rows.map((row) => row.list_id));
      const now = nowIso();
      // 未承認はカンバンに載らないので list_pos は意味を持たなくなる（0 に倒す）。
      // completed_at も落とす。再承認したとき、そのときの列の role で入り直す。
      const update = db.prepare(
        "UPDATE nodes SET state = 'proposed', list_pos = 0, completed_at = NULL, updated_at = ? WHERE id = ?",
      );
      for (const row of rows) update.run(now, row.id);
      for (const listId of listIds) {
        writeOrder(db, "nodes", "list_pos", activeIdsInList(db, boardId, listId));
      }
      return [{ type: "unapproveNode", ids: rows.map((row) => row.id) }];
    }

    case "rejectNode": {
      const node = requireNode(db, boardId, intent.id);
      if (node.state === "active") throw new OpError("確定済みのノードは却下できません");
      const ids = deleteSubtree(db, boardId, node);
      return [{ type: "rejectNode", ids }];
    }

    // ---- カンバン ---------------------------------------------------------
    case "moveCard": {
      const node = requireNode(db, boardId, intent.id);
      if (node.state === "proposed") throw new OpError("未承認のノードはカンバンに載っていません");
      const toList = requireList(db, boardId, intent.listId);
      // done 列に入っている間だけ completedAt が入る。ただし done 列内での並べ替えでは
      // 元の完了時刻を維持する（並べ替えただけで完了時刻がリセットされないように）。
      const completedAt = toList.role === "done" ? (node.completed_at ?? nowIso()) : null;
      const fromListId = node.list_id;

      db.prepare("UPDATE nodes SET list_id = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(
        toList.id,
        completedAt,
        nowIso(),
        node.id,
      );
      const placed = placeBefore(activeIdsInList(db, boardId, toList.id), node.id, intent.beforeId);
      writeOrder(db, "nodes", "list_pos", placed.ids);
      if (fromListId !== toList.id) {
        writeOrder(db, "nodes", "list_pos", activeIdsInList(db, boardId, fromListId));
      }
      return [{ type: "moveCard", id: node.id, listId: toList.id, listIndex: placed.index, completedAt }];
    }

    case "addList": {
      const title = trimmedText(intent.title);
      if (!title) return [];
      const role = normalizeRole(intent.role, "normal");
      const id = newId();
      const placed = placeBefore(listIdsInOrder(db, boardId), id, intent.beforeId);
      db.prepare("INSERT INTO lists (id, board_id, title, position, role) VALUES (?, ?, ?, ?, ?)").run(
        id,
        boardId,
        title,
        placed.index,
        role,
      );
      writeOrder(db, "lists", "position", placed.ids);
      return [{ type: "addList", list: { id, title, role, nodeIds: [] }, index: placed.index }];
    }

    case "renameList": {
      const list = requireList(db, boardId, intent.id);
      const title = trimmedText(intent.title);
      if (!title) return [];
      db.prepare("UPDATE lists SET title = ? WHERE id = ?").run(title, list.id);
      return [{ type: "renameList", id: list.id, title }];
    }

    case "setListRole": {
      const list = requireList(db, boardId, intent.id);
      const role = normalizeRole(intent.role, list.role);
      db.prepare("UPDATE lists SET role = ? WHERE id = ?").run(role, list.id);
      // 既にこの列にあるノードの completed_at は触らない。role を変えただけで完了時刻が
      // 湧いたり消えたりすると混乱するため、新しい role は次に moveCard したときから効く。
      return [{ type: "setListRole", id: list.id, role }];
    }

    case "deleteList": {
      const list = requireList(db, boardId, intent.id);
      const all = queryAll<ListRow>(db, "SELECT * FROM lists WHERE board_id = ? ORDER BY position", boardId);
      if (all.length <= 1) throw new OpError("最後の1列は削除できません");
      const target = all.find((l) => l.id !== list.id);
      if (!target) throw new OpError("退避先の列がありません");

      // 列を消してもノードは消さない（ツリーの実体なので消えると困る）。
      // active はそのままの順で退避先の末尾へ、proposed もカンバンには出ないが
      // list_id は NOT NULL なので付け替えが要る。
      const activeIds = activeIdsInList(db, boardId, list.id);
      const proposedIds = queryAll<{ id: string }>(
        db,
        "SELECT id FROM nodes WHERE board_id = ? AND list_id = ? AND state = 'proposed' ORDER BY rowid",
        boardId,
        list.id,
      ).map((r) => r.id);
      const movedNodeIds = [...activeIds, ...proposedIds];

      const now = nowIso();
      const move = db.prepare("UPDATE nodes SET list_id = ?, updated_at = ? WHERE id = ?");
      for (const id of movedNodeIds) move.run(target.id, now, id);
      writeOrder(db, "nodes", "list_pos", [...activeIdsInList(db, boardId, target.id).filter((id) => !activeIds.includes(id)), ...activeIds]);

      db.prepare("DELETE FROM lists WHERE id = ?").run(list.id);
      writeOrder(db, "lists", "position", listIdsInOrder(db, boardId));
      return [
        {
          type: "deleteList",
          id: list.id,
          movedToListId: movedNodeIds.length > 0 ? target.id : null,
          movedNodeIds,
        },
      ];
    }

    case "moveList": {
      const list = requireList(db, boardId, intent.id);
      const placed = placeBefore(listIdsInOrder(db, boardId), list.id, intent.beforeId);
      writeOrder(db, "lists", "position", placed.ids);
      return [{ type: "moveList", id: list.id, index: placed.index }];
    }

    // ---- メンバー ---------------------------------------------------------
    case "addAssignee": {
      const name = trimmedText(intent.name);
      if (!name) return [];
      const kind: AssigneeKind = intent.kind === "team" ? "team" : "person";
      const id = newId();
      db.prepare("INSERT INTO assignees (id, board_id, kind, name) VALUES (?, ?, ?, ?)").run(id, boardId, kind, name);
      const assignee: Assignee = { id, kind, name, memberIds: [] };
      return [{ type: "addAssignee", assignee }];
    }

    case "renameAssignee": {
      const assignee = requireAssignee(db, boardId, intent.id);
      const name = trimmedText(intent.name);
      if (!name) return [];
      db.prepare("UPDATE assignees SET name = ? WHERE id = ?").run(name, assignee.id);
      return [{ type: "renameAssignee", id: assignee.id, name }];
    }

    case "deleteAssignee": {
      const assignee = requireAssignee(db, boardId, intent.id);
      // node_assignees / team_members からは外部キーの ON DELETE CASCADE で落ちる
      // （db.ts が接続ごとに PRAGMA foreign_keys = ON を入れている前提）。
      db.prepare("DELETE FROM assignees WHERE id = ?").run(assignee.id);
      return [{ type: "deleteAssignee", id: assignee.id }];
    }

    case "toggleTeamMember": {
      const team = requireAssignee(db, boardId, intent.teamId);
      if (team.kind !== "team") throw new OpError(`チームではありません: ${team.id}`);
      const member = requireAssignee(db, boardId, intent.memberId);
      if (member.kind !== "person") throw new OpError(`人ではありません: ${member.id}`);
      if (team.id === member.id) throw new OpError("自分自身をメンバーにはできません");
      const existing = queryOne<{ team_id: string }>(
        db,
        "SELECT team_id FROM team_members WHERE team_id = ? AND member_id = ?",
        team.id,
        member.id,
      );
      const present = existing === undefined;
      if (present) {
        db.prepare("INSERT INTO team_members (team_id, member_id) VALUES (?, ?)").run(team.id, member.id);
      } else {
        db.prepare("DELETE FROM team_members WHERE team_id = ? AND member_id = ?").run(team.id, member.id);
      }
      return [{ type: "toggleTeamMember", teamId: team.id, memberId: member.id, present }];
    }

    // ---- ボード -----------------------------------------------------------
    case "renameBoard": {
      const title = trimmedText(intent.title);
      if (!title) return [];
      const changes = db.prepare("UPDATE boards SET title = ? WHERE id = ?").run(title, boardId);
      if (Number(changes.changes) === 0) throw new OpError(`ボードが見つかりません: ${boardId}`);
      return [{ type: "renameBoard", title }];
    }

    case "setBoardSettings": {
      const row = queryOne<{ settings: string }>(db, "SELECT settings FROM boards WHERE id = ?", boardId);
      if (!row) throw new OpError(`ボードが見つかりません: ${boardId}`);
      // 浅くマージして保存し、Op にはマージ後の全体を入れる（クライアントは差分を持たない）。
      const merged = { ...parseSettings(row.settings), ...(intent.settings ?? {}) } as BoardSettings;
      db.prepare("UPDATE boards SET settings = ? WHERE id = ?").run(JSON.stringify(merged), boardId);
      return [{ type: "setBoardSettings", settings: merged }];
    }

    default: {
      // Intent union に case を足し忘れるとここで型エラーになる。
      const unhandled: never = intent;
      throw new OpError(`未対応の intent: ${JSON.stringify(unhandled)}`);
    }
  }
}

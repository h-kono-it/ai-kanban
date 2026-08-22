// SQLite からの読み取りとボードの初期化。書き込みの本体は ops.ts にある。
// 読み取りはどれも「ボード1つ分はまるごとメモリに載る」前提で、数クエリ流してから
// メモリ上で組み立てる（子や担当者をノードごとに引く N+1 は作らない）。

import type { Db } from "./db.ts";
import { transact } from "./db.ts";
import type {
  Assignee,
  AssigneeKind,
  BoardSettings,
  BoardState,
  ListCol,
  ListRole,
  NodeKind,
  NodeState,
  TaskNode,
} from "./types.ts";
import { newId, nowIso } from "./util.ts";

// ---------------------------------------------------------------------------
// 行の型付けとクエリの薄いラッパ
// ---------------------------------------------------------------------------

/** node:sqlite に渡せるバインド値のうち、このアプリで実際に使うもの。 */
export type Param = string | number | null;

/** nodes テーブルの1行。列名はスキーマの snake_case のまま。 */
export interface NodeRow {
  id: string;
  board_id: string;
  parent_id: string | null;
  kind: NodeKind;
  state: NodeState;
  title: string;
  description: string;
  list_id: string;
  tree_pos: number;
  list_pos: number;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListRow {
  id: string;
  board_id: string;
  title: string;
  position: number;
  role: ListRole;
}

export interface AssigneeRow {
  id: string;
  board_id: string;
  kind: AssigneeKind;
  name: string;
}

export interface BoardRow {
  id: string;
  title: string;
  seq: number;
  settings: string;
  created_at: string;
}

// node:sqlite の戻り値は Record<string, SQLOutputValue> で列ごとの型が落ちるため、
// 呼び出し側が期待する行の型を付け直す。SQL と型定義がズレたら実行時に壊れる点は
// 素の SQL を書いている以上避けられないので、SELECT はテーブル定義に忠実に書くこと。
export function queryAll<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function queryOne<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

// ---------------------------------------------------------------------------
// ボードの一覧・初期化
// ---------------------------------------------------------------------------

const DEFAULT_BOARD_TITLE = "AI カンバン";

// 既定の列。role は id ではなく意味で判定する設計なので、id は newId() で採番し
// "todo" / "done" のような固定 id は持たせない（旧 my-kanban はここが固定だった）。
const DEFAULT_LISTS: { title: string; role: ListRole }[] = [
  { title: "ToDo", role: "normal" },
  { title: "進行中", role: "normal" },
  { title: "レビュー待ち", role: "awaiting_human" },
  { title: "承認待ち", role: "awaiting_human" },
  { title: "完了", role: "done" },
];

/** ボード一覧の1件分。 */
export interface BoardSummary {
  id: string;
  title: string;
  createdAt: string;
  /** 最後に書き込みが通った時刻。一度も書き込まれていないボードは createdAt と同じ。 */
  updatedAt: string;
  nodeCount: number;
  /** true ならホームの一覧から畳む（ボードは消えない）。 */
  archived: boolean;
}

/**
 * ボード一覧。**最終更新の新しい順**で返す（作成順ではない）。
 * 複数ボードを行き来する使い方だと、直近に触ったものが上に来る方が探す手間が小さい。
 * archived も含めて返すので、畳むかどうかは呼び出し側（ホーム画面）が決める。
 */
export function listBoards(db: Db): BoardSummary[] {
  const rows = queryAll<{
    id: string;
    title: string;
    created_at: string;
    updated_at: string | null;
    settings: string;
    node_count: number;
  }>(
    db,
    `SELECT b.id, b.title, b.created_at, b.updated_at, b.settings, COUNT(n.id) AS node_count
       FROM boards b LEFT JOIN nodes n ON n.board_id = b.id
      GROUP BY b.id
      ORDER BY COALESCE(b.updated_at, b.created_at) DESC, b.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    nodeCount: Number(r.node_count),
    archived: parseSettings(r.settings).archived === true,
  }));
}

export function boardExists(db: Db, boardId: string): boolean {
  return queryOne<{ id: string }>(db, "SELECT id FROM boards WHERE id = ?", boardId) !== undefined;
}

/** ボードが無ければデフォルト列付きで作る。既にあれば何もしない。 */
export function ensureBoard(db: Db, boardId: string, title?: string): void {
  if (boardExists(db, boardId)) return;
  transact(db, () => {
    db.prepare("INSERT INTO boards (id, title, seq, settings, created_at) VALUES (?, ?, 0, '{}', ?)").run(
      boardId,
      title?.trim() || DEFAULT_BOARD_TITLE,
      nowIso(),
    );
    const insertList = db.prepare("INSERT INTO lists (id, board_id, title, position, role) VALUES (?, ?, ?, ?, ?)");
    DEFAULT_LISTS.forEach((list, i) => {
      insertList.run(newId(), boardId, list.title, i, list.role);
    });
  });
}

// ---------------------------------------------------------------------------
// ボード全体の読み込み
// ---------------------------------------------------------------------------

export function getSeq(db: Db, boardId: string): number {
  const row = queryOne<{ seq: number }>(db, "SELECT seq FROM boards WHERE id = ?", boardId);
  return row ? Number(row.seq) : 0;
}

/** DB の1行から TaskNode の骨格を作る。childIds / assigneeIds は呼び出し側で埋める。 */
function toTaskNode(row: NodeRow): TaskNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    state: row.state,
    title: row.title,
    description: row.description,
    listId: row.list_id,
    childIds: [],
    assigneeIds: [],
    dueDate: row.due_date,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** WebSocket の {type:"state"} で送る全体像を組み立てる。 */
export function loadBoard(db: Db, boardId: string): BoardState {
  const board = queryOne<BoardRow>(db, "SELECT id, title, seq, settings, created_at FROM boards WHERE id = ?", boardId);
  if (!board) throw new Error(`board not found: ${boardId}`);

  const listRows = queryAll<ListRow>(db, "SELECT * FROM lists WHERE board_id = ? ORDER BY position", boardId);
  // tree_pos 順で読んでおけば childIds / rootIds は push するだけで正しい順になる。
  const nodeRows = queryAll<NodeRow>(db, "SELECT * FROM nodes WHERE board_id = ? ORDER BY tree_pos", boardId);
  const nodeAssigneeRows = queryAll<{ node_id: string; assignee_id: string }>(
    db,
    `SELECT na.node_id, na.assignee_id FROM node_assignees na
       JOIN nodes n ON n.id = na.node_id
      WHERE n.board_id = ? ORDER BY na.rowid`,
    boardId,
  );
  const assigneeRows = queryAll<AssigneeRow>(db, "SELECT * FROM assignees WHERE board_id = ? ORDER BY rowid", boardId);
  const teamMemberRows = queryAll<{ team_id: string; member_id: string }>(
    db,
    `SELECT tm.team_id, tm.member_id FROM team_members tm
       JOIN assignees a ON a.id = tm.team_id
      WHERE a.board_id = ? ORDER BY tm.rowid`,
    boardId,
  );

  const nodes: Record<string, TaskNode> = {};
  const rootIds: string[] = [];
  for (const row of nodeRows) {
    nodes[row.id] = toTaskNode(row);
  }
  for (const row of nodeRows) {
    if (row.parent_id === null) {
      rootIds.push(row.id);
    } else {
      nodes[row.parent_id]?.childIds.push(row.id);
    }
  }
  for (const row of nodeAssigneeRows) {
    nodes[row.node_id]?.assigneeIds.push(row.assignee_id);
  }

  // 列に並ぶのは active なノードだけ（proposed は承認されるまでカンバンに出ない）。
  // tree_pos 順に読んだ配列を list_pos で並べ直して列ごとに配る。
  const byList = new Map<string, string[]>();
  const activeRows = nodeRows.filter((r) => r.state === "active").sort((a, b) => a.list_pos - b.list_pos);
  for (const row of activeRows) {
    const ids = byList.get(row.list_id);
    if (ids) ids.push(row.id);
    else byList.set(row.list_id, [row.id]);
  }
  const lists: ListCol[] = listRows.map((row) => ({
    id: row.id,
    title: row.title,
    role: row.role,
    nodeIds: byList.get(row.id) ?? [],
  }));

  const assignees: Record<string, Assignee> = {};
  for (const row of assigneeRows) {
    assignees[row.id] = { id: row.id, kind: row.kind, name: row.name, memberIds: [] };
  }
  for (const row of teamMemberRows) {
    assignees[row.team_id]?.memberIds.push(row.member_id);
  }

  return {
    id: board.id,
    title: board.title,
    settings: parseSettings(board.settings),
    lists,
    nodes,
    rootIds,
    assignees,
  };
}

/** settings は TEXT 列なので壊れた JSON でもボードごと読めなくならないように握り潰す。 */
export function parseSettings(raw: string): BoardSettings {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as BoardSettings;
  } catch {
    // 壊れていたら空設定として扱う
  }
  return {} as BoardSettings;
}

// ---------------------------------------------------------------------------
// API 用の読み取り（LLM に渡す形）
// ---------------------------------------------------------------------------

/** 入れ子 JSON。id 参照を辿らなくても意味が取れるよう、列は id とタイトルの両方を入れる。 */
export interface TreeNodeDto {
  id: string;
  kind: NodeKind;
  state: NodeState;
  title: string;
  description: string;
  listId: string;
  listTitle: string;
  dueDate: string | null;
  assigneeIds: string[];
  children: TreeNodeDto[];
}

/**
 * 入れ子 JSON を返す。rootId 省略なら全ルート、depth 省略なら無制限。
 * depth は「含める階層数」で、1 ならルートだけ（children は空配列）になる。
 * rootId が見つからない場合は空配列。
 */
export function getTree(db: Db, boardId: string, rootId?: string, depth?: number): TreeNodeDto[] {
  const board = loadBoard(db, boardId);
  const listTitles = new Map(board.lists.map((l) => [l.id, l.title]));
  const limit = depth ?? Number.POSITIVE_INFINITY;

  const build = (id: string, level: number): TreeNodeDto | null => {
    const node = board.nodes[id];
    if (!node) return null;
    const children = level + 1 >= limit ? [] : compact(node.childIds.map((childId) => build(childId, level + 1)));
    return {
      id: node.id,
      kind: node.kind,
      state: node.state,
      title: node.title,
      description: node.description,
      listId: node.listId,
      listTitle: listTitles.get(node.listId) ?? "",
      dueDate: node.dueDate,
      assigneeIds: node.assigneeIds,
      children,
    };
  };

  const roots = rootId === undefined ? board.rootIds : board.nodes[rootId] ? [rootId] : [];
  return compact(roots.map((id) => build(id, 0)));
}

/**
 * 人間の対応待ちを集める。AI はこの2つを見て「自分では進められないもの」を判断する。
 * awaitingHuman は列の並び順・列内の順序、proposed はツリーの深さ優先順。
 */
export function getAwaiting(db: Db, boardId: string): { awaitingHuman: TaskNode[]; proposed: TaskNode[] } {
  const board = loadBoard(db, boardId);
  const awaitingHuman: TaskNode[] = [];
  for (const list of board.lists) {
    if (list.role !== "awaiting_human") continue;
    for (const id of list.nodeIds) {
      const node = board.nodes[id];
      if (node) awaitingHuman.push(node);
    }
  }
  const proposed = walkTree(board).filter((node) => node.state === "proposed");
  return { awaitingHuman, proposed };
}

/** 子を持たない kind="goal" のノード＝まだ細分化されていない目的。 */
export function getUndecomposedGoals(db: Db, boardId: string): TaskNode[] {
  const board = loadBoard(db, boardId);
  return walkTree(board).filter((node) => node.kind === "goal" && node.childIds.length === 0);
}

/** ツリーを深さ優先で平坦化する。「全ノードを条件で絞る」系はこれを土台にする。 */
export function walkTree(board: BoardState): TaskNode[] {
  const out: TaskNode[] = [];
  const visit = (id: string) => {
    const node = board.nodes[id];
    if (!node) return;
    out.push(node);
    for (const childId of node.childIds) visit(childId);
  };
  for (const id of board.rootIds) visit(id);
  return out;
}

/** noUncheckedIndexedAccess 下で null を落とすための小道具。 */
function compact<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}

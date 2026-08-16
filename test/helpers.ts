// テスト用の小道具。使い捨ての DB と、ツリーを1行で組み立てるフィクスチャ。
//
// 方針: プロダクトコードの内部は覗かず、applyIntent() で書いて loadBoard() で読む
// 「外から見える振る舞い」だけで検証する。唯一の例外が assertPositions() で、
// 並び順の連番（tree_pos / list_pos が 0..n-1）は loadBoard() の配列からは
// 見えない（ソート済みで返るので歯抜けや重複が隠れる）ため、生の列を直接読む。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import type { Db } from "../src/db.ts";
import { openDb } from "../src/db.ts";
import { applyIntent } from "../src/ops.ts";
import { ensureBoard, loadBoard, queryAll } from "../src/store.ts";
import type { BoardState, Intent, ListCol, ListRole, NodeState, Op } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 使い捨ての DB
// ---------------------------------------------------------------------------

export interface FreshDb {
  db: Db;
  boardId: string;
  cleanup: () => void;
}

/**
 * 一時ディレクトリに DB を作って開く。テストごとに使い捨て。
 * プロジェクトの data/ は絶対に触らない（tmpdir + ランダム名）。
 * ensureBoard() 済みの状態で返るので、既定の5列がある。
 */
export function freshDb(boardTitle?: string): FreshDb {
  const dir = mkdtempSync(join(tmpdir(), "ai-kanban-test-"));
  const path = join(dir, "kanban.db");
  const db = openDb(path);
  const boardId = "test";
  ensureBoard(db, boardId, boardTitle);

  const cleanup = () => {
    try {
      db.close();
    } catch {
      // 既に閉じていても気にしない
    }
    // WAL モードなので -wal / -shm も残る。ディレクトリごと消す。
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    rmSync(dir, { recursive: true, force: true });
  };

  return { db, boardId, cleanup };
}

// ---------------------------------------------------------------------------
// 意図を投げる薄いラッパ
// ---------------------------------------------------------------------------

/** 意図を適用して Op だけ取り出す（seq を見ないテスト向け）。 */
export function apply(db: Db, boardId: string, intent: Intent): Op[] {
  return applyIntent(db, boardId, intent).map((a) => a.op);
}

/** ちょうど1つの Op を返す意図を適用する。0件や2件以上なら落とす。 */
export function applyOne(db: Db, boardId: string, intent: Intent): Op {
  const ops = apply(db, boardId, intent);
  assert.equal(ops.length, 1, `${intent.type} は Op を1つ返すはずが ${ops.length} 件だった`);
  return ops[0]!;
}

type AddNodeInput = Omit<Extract<Intent, { type: "addNode" }>, "type">;

/** ノードを1つ作って id を返す。Op の中身を見たいときは applyOne() を使う。 */
export function addNode(db: Db, boardId: string, input: AddNodeInput): string {
  const op = applyOne(db, boardId, { type: "addNode", ...input });
  assert.equal(op.type, "addNode", "addNode の Op が返らなかった");
  return op.type === "addNode" ? op.node.id : "";
}

/**
 * 壁時計を確実に進める（同期）。完了時刻のような ISO 文字列は同一ミリ秒だと
 * 「更新された」のか「維持された」のか区別できないので、その手前で挟む。
 */
export function tick(ms = 5): void {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // ビジーウェイト。同期 API しか使わないテストなので await は挟めない。
  }
}

// ---------------------------------------------------------------------------
// ツリーのフィクスチャ
// ---------------------------------------------------------------------------

/**
 * ツリーの形。
 * - 文字列          → 葉ノード1つ
 * - 配列            → 兄弟の並び（左から順に）
 * - オブジェクト    → { タイトル: 子の spec }
 *
 * 例: { 目的: { 機能: ["タスクA", "タスクB"] } }
 */
export type TreeSpec = string | TreeSpec[] | { [title: string]: TreeSpec };

export interface BuildTreeOpts {
  /** 作るノードの state。既定は addNode と同じ "active"。 */
  state?: NodeState;
  /** 置く列。省略時は role="normal" の先頭列。 */
  listId?: string;
  /** ぶら下げ先。省略時はルート。 */
  parentId?: string | null;
}

/**
 * spec からツリーを組み立て、タイトル → id の対応を返す。
 * kind は深さから決める（0=goal / 1=feature / それ以下=task）。振る舞いには影響しない。
 * タイトルは対応表のキーなので、1つのツリー内で重複させないこと（重複したら落とす）。
 */
export function buildTree(db: Db, boardId: string, spec: TreeSpec, opts?: BuildTreeOpts): Record<string, string> {
  const ids: Record<string, string> = {};
  build(db, boardId, opts?.parentId ?? null, spec, opts, 0, ids);
  return ids;
}

function build(
  db: Db,
  boardId: string,
  parentId: string | null,
  spec: TreeSpec,
  opts: BuildTreeOpts | undefined,
  depth: number,
  ids: Record<string, string>,
): void {
  if (typeof spec === "string") {
    create(db, boardId, parentId, spec, opts, depth, ids);
    return;
  }
  if (Array.isArray(spec)) {
    for (const child of spec) build(db, boardId, parentId, child, opts, depth, ids);
    return;
  }
  for (const [title, children] of Object.entries(spec)) {
    const id = create(db, boardId, parentId, title, opts, depth, ids);
    build(db, boardId, id, children, opts, depth + 1, ids);
  }
}

function create(
  db: Db,
  boardId: string,
  parentId: string | null,
  title: string,
  opts: BuildTreeOpts | undefined,
  depth: number,
  ids: Record<string, string>,
): string {
  assert.equal(ids[title], undefined, `フィクスチャのタイトルが重複している: ${title}`);
  const id = addNode(db, boardId, {
    parentId,
    title,
    kind: depth === 0 ? "goal" : depth === 1 ? "feature" : "task",
    state: opts?.state,
    listId: opts?.listId,
  });
  ids[title] = id;
  return id;
}

// ---------------------------------------------------------------------------
// 読み取りの小道具（すべて loadBoard() の結果を見る）
// ---------------------------------------------------------------------------

export function board(db: Db, boardId: string): BoardState {
  return loadBoard(db, boardId);
}

/** role で列を引く（同じ role が複数あれば先頭）。 */
export function listByRole(b: BoardState, role: ListRole): ListCol {
  const list = b.lists.find((l) => l.role === role);
  assert.ok(list, `role="${role}" の列が無い`);
  return list;
}

/** タイトルで列を引く。 */
export function listByTitle(b: BoardState, title: string): ListCol {
  const list = b.lists.find((l) => l.title === title);
  assert.ok(list, `"${title}" という列が無い`);
  return list;
}

export function titleOf(b: BoardState, id: string): string {
  return b.nodes[id]?.title ?? `(不明: ${id})`;
}

/** 列に並んでいるノードをタイトルの配列で（並び順そのまま）。 */
export function titlesInList(b: BoardState, listId: string): string[] {
  const list = b.lists.find((l) => l.id === listId);
  assert.ok(list, `列が無い: ${listId}`);
  return list.nodeIds.map((id) => titleOf(b, id));
}

/** 子（parentId が null ならルート）をタイトルの配列で。 */
export function childTitles(b: BoardState, parentId: string | null): string[] {
  const childIds = parentId === null ? b.rootIds : (b.nodes[parentId]?.childIds ?? []);
  return childIds.map((id) => titleOf(b, id));
}

/** そのノードが今どの列の何番目にいるか。カンバンに載っていなければ null。 */
export function whereIs(b: BoardState, nodeId: string): { listTitle: string; index: number } | null {
  for (const list of b.lists) {
    const index = list.nodeIds.indexOf(nodeId);
    if (index !== -1) return { listTitle: list.title, index };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 不変条件のスイープ
// ---------------------------------------------------------------------------

interface PosRow {
  id: string;
  parent_id: string | null;
  state: NodeState;
  list_id: string;
  tree_pos: number;
  list_pos: number;
}

/**
 * 並び順の連番が保たれているかを全体に対して確認する。
 * - 兄弟グループごとに tree_pos が 0..n-1（歯抜け・重複なし）
 * - 列ごとに active なノードの list_pos が 0..n-1
 * ops.ts の再採番はここが崩れると静かに壊れるので、順序を触るテストの最後に必ず呼ぶ。
 */
export function assertPositions(db: Db, boardId: string, label = ""): void {
  const rows = queryAll<PosRow>(
    db,
    "SELECT id, parent_id, state, list_id, tree_pos, list_pos FROM nodes WHERE board_id = ?",
    boardId,
  );
  const suffix = label ? `（${label}）` : "";

  const byParent = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.parent_id ?? " root";
    const bucket = byParent.get(key);
    if (bucket) bucket.push(row.tree_pos);
    else byParent.set(key, [row.tree_pos]);
  }
  for (const [parent, positions] of byParent) {
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions.map((_, i) => i),
      `兄弟の tree_pos が 0..n-1 になっていない: parent=${parent}${suffix}`,
    );
  }

  const byList = new Map<string, number[]>();
  for (const row of rows) {
    if (row.state !== "active") continue;
    const bucket = byList.get(row.list_id);
    if (bucket) bucket.push(row.list_pos);
    else byList.set(row.list_id, [row.list_pos]);
  }
  for (const [listId, positions] of byList) {
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions.map((_, i) => i),
      `列内の list_pos が 0..n-1 になっていない: list=${listId}${suffix}`,
    );
  }
}

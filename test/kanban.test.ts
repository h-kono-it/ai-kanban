// カンバン側（moveCard / deleteList）の検証。
// 完了判定は列 id ではなく role === "done" で行われる点に注意。

import test from "node:test";
import assert from "node:assert/strict";

import { OpError } from "../src/ops.ts";
import {
  addNode,
  apply,
  applyOne,
  assertPositions,
  board,
  buildTree,
  freshDb,
  listByRole,
  listByTitle,
  tick,
  titlesInList,
  whereIs,
} from "./helpers.ts";

test("done 列への出入りで completedAt が入る・消える", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const b0 = board(db, boardId);
  const todo = listByRole(b0, "normal");
  const done = listByRole(b0, "done");
  const review = listByRole(b0, "awaiting_human");

  const id = addNode(db, boardId, { parentId: null, title: "タスク" });
  assert.equal(board(db, boardId).nodes[id]!.completedAt, null, "作った直後に完了時刻が入っている");

  // done 列へ
  const toDone = applyOne(db, boardId, { type: "moveCard", id, listId: done.id, beforeId: null });
  assert.equal(toDone.type, "moveCard", "moveCard の Op が返るはず");
  const completedAt = toDone.type === "moveCard" ? toDone.completedAt : null;
  assert.notEqual(completedAt, null, "done 列に入れたのに Op の completedAt が null");
  assert.equal(board(db, boardId).nodes[id]!.completedAt, completedAt, "DB の completedAt が Op と食い違う");
  assert.deepEqual(whereIs(board(db, boardId), id), { listTitle: done.title, index: 0 }, "done 列に移っていない");

  // awaiting_human 列へ（done ではないので落ちる）
  const toReview = applyOne(db, boardId, { type: "moveCard", id, listId: review.id, beforeId: null });
  assert.equal(toReview.type === "moveCard" ? toReview.completedAt : "x", null, "done 以外の列で完了時刻が残っている");
  assert.equal(board(db, boardId).nodes[id]!.completedAt, null, "done 列から出たのに完了時刻が残っている");

  // 通常列へ戻しても null のまま
  apply(db, boardId, { type: "moveCard", id, listId: todo.id, beforeId: null });
  assert.equal(board(db, boardId).nodes[id]!.completedAt, null, "通常列で完了時刻が湧いている");
  assertPositions(db, boardId, "done 列の出入り");
});

test("done 列内での並べ替えでは完了時刻が維持される", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const done = listByRole(board(db, boardId), "done");
  const a = addNode(db, boardId, { parentId: null, title: "A" });
  const b = addNode(db, boardId, { parentId: null, title: "B" });

  apply(db, boardId, { type: "moveCard", id: a, listId: done.id, beforeId: null });
  apply(db, boardId, { type: "moveCard", id: b, listId: done.id, beforeId: null });
  const beforeA = board(db, boardId).nodes[a]!.completedAt;
  const beforeB = board(db, boardId).nodes[b]!.completedAt;
  assert.deepEqual(titlesInList(board(db, boardId), done.id), ["A", "B"], "done 列の初期の並びが違う");

  // 時計を進めてから並べ替える（同一ミリ秒だと「維持」と「上書き」が区別できない）。
  tick();
  const op = applyOne(db, boardId, { type: "moveCard", id: a, listId: done.id, beforeId: null });
  assert.ok(
    beforeA !== null && beforeA < new Date().toISOString(),
    "テストの前提が壊れている（完了時刻が現在時刻より後）",
  );

  assert.equal(op.type === "moveCard" ? op.completedAt : "x", beforeA, "並べ替えの Op で完了時刻が作り直されている");
  const after = board(db, boardId);
  assert.equal(after.nodes[a]!.completedAt, beforeA, "done 列内の並べ替えで A の完了時刻が変わった");
  assert.equal(after.nodes[b]!.completedAt, beforeB, "動かしていない B の完了時刻が変わった");
  assert.deepEqual(titlesInList(after, done.id), ["B", "A"], "並べ替えが効いていない");
  assertPositions(db, boardId, "done 列内の並べ替え");
});

test("deleteList でノードは消えず、他の列の末尾へ退避される", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const ids = buildTree(db, boardId, { 目的: ["タスクA", "タスクB"] });
  const b0 = board(db, boardId);
  const todo = listByTitle(b0, "ToDo");
  const doing = listByTitle(b0, "進行中");

  // 退避先に先客を置いておく（末尾に付くことを確かめるため）。
  const senkyaku = addNode(db, boardId, { parentId: null, title: "先客", listId: doing.id });
  // 未承認のノードもカンバンには出ないが list_id は持つ。
  const proposedId = addNode(db, boardId, { parentId: null, title: "未承認", state: "proposed", listId: todo.id });

  const nodeCountBefore = Object.keys(board(db, boardId).nodes).length;
  const op = applyOne(db, boardId, { type: "deleteList", id: todo.id });
  assert.equal(op.type, "deleteList", "deleteList の Op が返るはず");
  if (op.type === "deleteList") {
    assert.equal(op.movedToListId, doing.id, "退避先の列が違う");
    assert.deepEqual(
      op.movedNodeIds,
      [ids["目的"]!, ids["タスクA"]!, ids["タスクB"]!, proposedId],
      "退避したノード（active の列順 → proposed）が Op に載っていない",
    );
  }

  const b = board(db, boardId);
  assert.equal(Object.keys(b.nodes).length, nodeCountBefore, "列を消したらノードまで消えた");
  assert.equal(b.lists.some((l) => l.id === todo.id), false, "列が消えていない");
  assert.deepEqual(
    b.lists.map((l) => l.title),
    ["進行中", "レビュー待ち", "承認待ち", "完了"],
    "残った列の並びが違う",
  );
  assert.deepEqual(
    titlesInList(b, doing.id),
    ["先客", "目的", "タスクA", "タスクB"],
    "退避先の末尾に、元の順序のまま付いていない",
  );
  assert.equal(b.nodes[senkyaku]!.listId, doing.id, "先客の列が変わっている");
  assert.equal(b.nodes[proposedId]!.listId, doing.id, "proposed の list_id が付け替わっていない");
  assert.equal(b.nodes[proposedId]!.state, "proposed", "退避で state が変わっている");
  assert.equal(
    b.lists.every((l) => !l.nodeIds.includes(proposedId)),
    true,
    "proposed がカンバンの列に載ってしまった",
  );
  assertPositions(db, boardId, "deleteList 後");
});

test("最後の1列は削除できない", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  // 既定の5列を1つになるまで消す
  for (let i = 0; i < 4; i++) {
    const first = board(db, boardId).lists[0]!;
    apply(db, boardId, { type: "deleteList", id: first.id });
  }
  const last = board(db, boardId).lists;
  assert.equal(last.length, 1, "列が1つになっていない");

  assert.throws(
    () => apply(db, boardId, { type: "deleteList", id: last[0]!.id }),
    OpError,
    "最後の1列が削除できてしまった",
  );
  assert.equal(board(db, boardId).lists.length, 1, "失敗したのに列が消えている");
});

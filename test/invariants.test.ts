// 不変条件の穴として見つかったバグの回帰テスト。
//
// どちらも「個々の操作は正しいが、別の経路から不変条件を破れる」型のバグで、
// 最初のテストスイートを書いたときに発見された。ops.ts に新しい case を足すときは、
// ここに書いてある2つの不変条件を破っていないか確認すること。
//
//  1. 親が proposed なら子も proposed（addNode / approveNode / unapproveNode / moveNode）
//  2. completed_at が入っているなら、そのノードは role="done" の列に居る

import test from "node:test";
import assert from "node:assert/strict";

import { addNode, apply, assertPositions, board, freshDb, listByRole } from "./helpers.ts";

test("未承認の親の下へ確定済みノードを移すと、未承認に倒れてカンバンから外れる", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const parent = addNode(db, boardId, { parentId: null, title: "未承認の親", state: "proposed" });
  const child = addNode(db, boardId, { parentId: null, title: "確定済みのノード" });

  const before = board(db, boardId);
  assert.ok(listByRole(before, "normal").nodeIds.includes(child), "前提: 確定済みノードは列に載っている");

  const ops = apply(db, boardId, { type: "moveNode", id: child, parentId: parent, beforeId: null });

  // moveNode 自体は state を表現できないので、unapproveNode の Op が続けて配信される。
  // クライアントの applyOp に特別扱いを増やさないための作り。
  assert.equal(ops.length, 2, "moveNode と unapproveNode の2つが返るはず");
  assert.equal(ops[0]!.type, "moveNode", "1つ目は moveNode");
  assert.equal(ops[1]!.type, "unapproveNode", "未承認へ倒す Op が続いていない");

  const after = board(db, boardId);
  assert.equal(after.nodes[child]!.state, "proposed", "未承認の親の下なのに確定済みのまま");
  assert.ok(
    !listByRole(after, "normal").nodeIds.includes(child),
    "未承認になったのにカンバンの列に残っている（親が未承認なのに子だけ盤に出る状態）",
  );
  assertPositions(db, boardId, "moveNode で未承認に倒したあと");
});

test("確定済みの親の下への移動では state が変わらない", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const parent = addNode(db, boardId, { parentId: null, title: "確定済みの親" });
  const child = addNode(db, boardId, { parentId: null, title: "確定済みのノード" });

  const ops = apply(db, boardId, { type: "moveNode", id: child, parentId: parent, beforeId: null });

  assert.equal(ops.length, 1, "余計な Op が付いている（state を触る必要はない）");
  const after = board(db, boardId);
  assert.equal(after.nodes[child]!.state, "active", "確定済みのままであるべき");
  assert.ok(listByRole(after, "normal").nodeIds.includes(child), "列から外れてしまっている");
});

test("done 列を削除すると、退避したノードの完了時刻が落ちる", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const done = listByRole(board(db, boardId), "done");
  const id = addNode(db, boardId, { parentId: null, title: "終わったタスク" });
  apply(db, boardId, { type: "moveCard", id, listId: done.id, beforeId: null });
  assert.notEqual(board(db, boardId).nodes[id]!.completedAt, null, "前提: done 列で完了時刻が入る");

  apply(db, boardId, { type: "deleteList", id: done.id });

  const after = board(db, boardId);
  const node = after.nodes[id]!;
  assert.equal(
    after.lists.find((l) => l.id === done.id),
    undefined,
    "前提: 列が消えている",
  );
  assert.notEqual(node, undefined, "列を消したらノードまで消えた（列削除はノードを消さない）");

  const movedTo = after.lists.find((l) => l.id === node.listId)!;
  assert.notEqual(movedTo.role, "done", "前提: 退避先は完了列ではない");
  assert.equal(
    node.completedAt,
    null,
    "完了列でない列へ退避したのに完了時刻が残っている（あとで done 列へ戻すと古い時刻が復活する）",
  );
  assertPositions(db, boardId, "done 列を削除したあと");
});

test("done 列以外を削除しても、完了列に残ったノードの完了時刻はそのまま", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const b0 = board(db, boardId);
  const done = listByRole(b0, "done");
  const review = listByRole(b0, "awaiting_human");

  const id = addNode(db, boardId, { parentId: null, title: "終わったタスク" });
  apply(db, boardId, { type: "moveCard", id, listId: done.id, beforeId: null });
  const completedAt = board(db, boardId).nodes[id]!.completedAt;

  // 別の列を消しても、done 列に居るノードには何の影響も無いこと。
  apply(db, boardId, { type: "deleteList", id: review.id });

  assert.equal(board(db, boardId).nodes[id]!.completedAt, completedAt, "無関係な列の削除で完了時刻が動いた");
});

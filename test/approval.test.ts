// 承認ゲート（proposed ↔ active）の検証。
// 不変条件は「親が proposed なら子も必ず proposed」。approveNode が祖先を、
// unapproveNode が子孫を巻き込むことで両側から守られている。

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
  titlesInList,
} from "./helpers.ts";

test("approveNode は祖先の未承認も一緒に承認する（孫だけ承認 → 親と祖父も active）", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const ids = buildTree(db, boardId, { 目的: { 機能: ["タスク"] } }, { state: "proposed" });

  const todo = listByRole(board(db, boardId), "normal");
  assert.deepEqual(titlesInList(board(db, boardId), todo.id), [], "proposed はカンバンに出ないはず");

  const op = applyOne(db, boardId, { type: "approveNode", id: ids["タスク"]! });
  assert.equal(op.type, "approveNode", "approveNode の Op が返るはず");
  if (op.type === "approveNode") {
    assert.deepEqual(
      op.entries.map((e) => e.id),
      [ids["目的"]!, ids["機能"]!, ids["タスク"]!],
      "祖先が（親より先の順で）一緒に承認されていない",
    );
    assert.deepEqual(op.entries.map((e) => e.listIndex), [0, 1, 2], "列内の位置が末尾から順に振られていない");
    assert.deepEqual(op.entries.map((e) => e.completedAt), [null, null, null], "done 列ではないのに完了時刻が入っている");
  }

  const b = board(db, boardId);
  for (const title of ["目的", "機能", "タスク"]) {
    assert.equal(b.nodes[ids[title]!]!.state, "active", `${title} が active になっていない`);
  }
  assert.deepEqual(titlesInList(b, todo.id), ["目的", "機能", "タスク"], "承認したノードが列に載っていない");
  assertPositions(db, boardId, "祖先ごと承認");
});

test("確定済みの親への recursive 承認が配下の提案を承認する", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  // 確定済みの目的に、AI が提案（proposed）をぶら下げた状態＝一番多い使い方。
  const goal = addNode(db, boardId, { parentId: null, title: "認証基盤をつくる", kind: "goal" });
  const bulk = apply(db, boardId, {
    type: "bulkAddNodes",
    parentId: goal,
    nodes: [
      { title: "セッション管理", kind: "feature", children: [{ title: "HMAC クッキー" }, { title: "有効期限" }] },
      { title: "パスワードリセット", kind: "feature" },
    ],
  });
  assert.equal(bulk.length, 4, "bulkAddNodes が 4 ノードを作っていない");

  // recursive でなければ「既に active」なので何も起きない。
  assert.deepEqual(apply(db, boardId, { type: "approveNode", id: goal }), [], "active な対象は recursive 無しでは no-op のはず");

  const op = applyOne(db, boardId, { type: "approveNode", id: goal, recursive: true });
  assert.equal(op.type, "approveNode", "approveNode の Op が返るはず");
  if (op.type === "approveNode") {
    assert.equal(op.entries.length, 4, "配下の提案 4 件が承認されていない（recursive が効いていない）");
    assert.equal(op.entries.some((e) => e.id === goal), false, "既に active な対象自身が entries に入っている");
  }

  const b = board(db, boardId);
  assert.equal(
    Object.values(b.nodes).every((n) => n.state === "active"),
    true,
    "proposed が残っている",
  );
  // 承認は「深さ順（幅優先）」に積まれる: 兄弟の機能が先に並び、そのあとに孫が続く。
  // ツリーの深さ優先の見た目とは一致しないが、親が子より先であることは保たれる。
  assert.deepEqual(
    titlesInList(b, listByRole(b, "normal").id),
    ["認証基盤をつくる", "セッション管理", "パスワードリセット", "HMAC クッキー", "有効期限"],
    "承認後の列の並びが違う（親が子より先に、深さ順で積まれるはず）",
  );
  assertPositions(db, boardId, "recursive 承認");

  // もう一度叩いても承認するものが無いので no-op。
  assert.deepEqual(apply(db, boardId, { type: "approveNode", id: goal, recursive: true }), [], "再実行が no-op になっていない");
});

test("親が proposed のとき、子の state:\"active\" 指定は無視される", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const goal = addNode(db, boardId, { parentId: null, title: "未承認の目的", kind: "goal", state: "proposed" });

  const childId = addNode(db, boardId, { parentId: goal, title: "確定させたい子", state: "active" });
  assert.equal(board(db, boardId).nodes[childId]!.state, "proposed", "親が proposed なのに子が active になった");

  // bulkAddNodes に state:"active" を渡しても同じ（孫まで proposed に倒れる）。
  const bulk = apply(db, boardId, {
    type: "bulkAddNodes",
    parentId: goal,
    state: "active",
    nodes: [{ title: "機能", children: [{ title: "孫タスク" }] }],
  });
  assert.equal(bulk.length, 2, "bulkAddNodes が 2 ノードを作っていない");
  for (const op of bulk) {
    if (op.type === "addNode") {
      assert.equal(op.node.state, "proposed", `${op.node.title} が active のまま作られた`);
    }
  }

  const b = board(db, boardId);
  assert.equal(
    Object.values(b.nodes).every((n) => n.state === "proposed"),
    true,
    "未承認の親の下に確定済みの子ができている（不変条件が壊れている）",
  );
  assert.deepEqual(
    b.lists.flatMap((l) => l.nodeIds),
    [],
    "proposed がカンバンの列に載っている",
  );
});

test("rejectNode は確定済みノードを拒否し、未承認ならサブツリーごと消す", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const goal = addNode(db, boardId, { parentId: null, title: "目的", kind: "goal" });
  const proposed = buildTree(db, boardId, { 機能: ["タスクA", "タスクB"] }, { state: "proposed", parentId: goal });

  assert.throws(
    () => apply(db, boardId, { type: "rejectNode", id: goal }),
    OpError,
    "確定済みのノードが却下できてしまった",
  );
  assert.notEqual(board(db, boardId).nodes[goal], undefined, "却下に失敗したのにノードが消えている");

  const op = applyOne(db, boardId, { type: "rejectNode", id: proposed["機能"]! });
  assert.equal(op.type, "rejectNode", "rejectNode の Op が返るはず");
  if (op.type === "rejectNode") {
    assert.deepEqual(
      [...op.ids].sort(),
      [proposed["機能"]!, proposed["タスクA"]!, proposed["タスクB"]!].sort(),
      "ids に子孫が全部載っていない",
    );
  }

  const b = board(db, boardId);
  assert.deepEqual(Object.keys(b.nodes), [goal], "却下したサブツリーが残っている");
  assertPositions(db, boardId, "rejectNode 後");
});

test("unapproveNode は自分と子孫の確定済みを巻き込み、列から外し、completedAt を落とす（再承認で戻る）", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const ids = buildTree(db, boardId, { 目的: { 機能: ["タスクA", "タスクB"] } });
  const todo = listByRole(board(db, boardId), "normal");
  const done = listByRole(board(db, boardId), "done");
  assert.equal(titlesInList(board(db, boardId), todo.id).length, 4, "最初は 4 件すべて列に載っているはず");

  // 完了列へ1つ送って completedAt を持たせておく
  apply(db, boardId, { type: "moveCard", id: ids["タスクA"]!, listId: done.id, beforeId: null });
  assert.notEqual(board(db, boardId).nodes[ids["タスクA"]!]!.completedAt, null, "完了列に入れても completedAt が入らない");

  // 機能を未承認に戻す → 自分 + 子孫が巻き込まれ、目的は確定のまま
  const op = applyOne(db, boardId, { type: "unapproveNode", id: ids["機能"]! });
  assert.equal(op.type, "unapproveNode", "unapproveNode の Op が返るはず");
  if (op.type === "unapproveNode") {
    assert.deepEqual(
      [...op.ids].sort(),
      [ids["機能"]!, ids["タスクA"]!, ids["タスクB"]!].sort(),
      "自分 + 子孫 3 件が戻っていない",
    );
  }

  let b = board(db, boardId);
  assert.equal(b.nodes[ids["機能"]!]!.state, "proposed", "機能が proposed に戻っていない");
  assert.equal(b.nodes[ids["タスクA"]!]!.state, "proposed", "子孫が巻き込まれていない");
  assert.equal(b.nodes[ids["目的"]!]!.state, "active", "祖先まで戻してしまっている");
  assert.equal(b.nodes[ids["タスクA"]!]!.completedAt, null, "未承認に戻したのに完了時刻が残っている");
  assert.deepEqual(titlesInList(b, todo.id), ["目的"], "カンバンから外れていない");
  assert.deepEqual(titlesInList(b, done.id), [], "完了列から外れていない");
  assertPositions(db, boardId, "unapproveNode 後");

  // 既に proposed なら no-op
  assert.deepEqual(apply(db, boardId, { type: "unapproveNode", id: ids["機能"]! }), [], "proposed への再実行が no-op になっていない");

  // 再承認すると列にも完了時刻にも戻る
  const re = applyOne(db, boardId, { type: "approveNode", id: ids["機能"]!, recursive: true });
  if (re.type === "approveNode") {
    assert.equal(re.entries.length, 3, "再承認で 3 件が戻っていない");
  }
  b = board(db, boardId);
  assert.deepEqual(titlesInList(b, todo.id), ["目的", "機能", "タスクB"], "再承認で列に戻っていない");
  assert.deepEqual(titlesInList(b, done.id), ["タスクA"], "完了列に戻っていない");
  assert.notEqual(b.nodes[ids["タスクA"]!]!.completedAt, null, "再承認で完了時刻が入り直していない");
  assertPositions(db, boardId, "再承認後");

  // 目的ごと戻すと全部戻る
  const all = applyOne(db, boardId, { type: "unapproveNode", id: ids["目的"]! });
  if (all.type === "unapproveNode") {
    assert.equal(all.ids.length, 4, "目的から戻したのに 4 件すべてが巻き込まれていない");
  }
  assert.deepEqual(
    board(db, boardId).lists.flatMap((l) => l.nodeIds),
    [],
    "どの列も空になるはず",
  );
});

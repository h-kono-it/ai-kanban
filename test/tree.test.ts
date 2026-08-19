// ツリー操作（addNode / moveNode / deleteNode）の検証。
// 並び順は必ず「loadBoard() で見える並び」と「0..n-1 の連番」の両方を確認する。

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
  childTitles,
  freshDb,
} from "./helpers.ts";

test("addNode の beforeId で兄弟順が意図どおりになる（先頭・中間・末尾・null・存在しない id）", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const goal = addNode(db, boardId, { parentId: null, title: "目的", kind: "goal" });
  // beforeId 省略 → 末尾
  const a = addNode(db, boardId, { parentId: goal, title: "A" });
  const c = addNode(db, boardId, { parentId: goal, title: "C" });

  // 中間: C の直前へ。Op の treeIndex も解決済みの位置を返すはず。
  const op = applyOne(db, boardId, { type: "addNode", parentId: goal, title: "B", beforeId: c });
  assert.equal(op.type, "addNode", "addNode の Op が返るはず");
  if (op.type === "addNode") {
    assert.equal(op.treeIndex, 1, "C の直前＝index 1 に入るはず");
    // 列内の位置は beforeId の対象外で、active なノードは常に列の末尾に積まれる（既に 目的/A/C の3件）。
    assert.equal(op.listIndex, 3, "active なノードは列の末尾に積まれるはず");
  }

  // 先頭: A の直前へ
  addNode(db, boardId, { parentId: goal, title: "先頭", beforeId: a });
  // 明示的な null → 末尾
  addNode(db, boardId, { parentId: goal, title: "末尾null", beforeId: null });
  // 存在しない id → 末尾扱い（例外にはしない）
  addNode(db, boardId, { parentId: goal, title: "末尾missing", beforeId: "そんな id は無い" });

  const b = board(db, boardId);
  assert.deepEqual(
    childTitles(b, goal),
    ["先頭", "A", "B", "C", "末尾null", "末尾missing"],
    "beforeId で指定した位置に入っていない",
  );
  assertPositions(db, boardId, "addNode の beforeId");
});

test("moveNode は親替えのあと移動元・移動先の両方を再採番する", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const ids = buildTree(db, boardId, {
    目的: { 機能A: ["a1", "a2", "a3"], 機能B: ["b1", "b2"] },
  });

  const op = applyOne(db, boardId, {
    type: "moveNode",
    id: ids["a2"]!,
    parentId: ids["機能B"]!,
    beforeId: ids["b2"]!,
  });
  assert.equal(op.type, "moveNode", "moveNode の Op が返るはず");
  if (op.type === "moveNode") {
    assert.equal(op.parentId, ids["機能B"], "新しい親が Op に載っていない");
    assert.equal(op.treeIndex, 1, "b2 の直前＝index 1 に入るはず");
  }

  const b = board(db, boardId);
  assert.deepEqual(childTitles(b, ids["機能A"]!), ["a1", "a3"], "移動元に穴が残っている");
  assert.deepEqual(childTitles(b, ids["機能B"]!), ["b1", "a2", "b2"], "移動先の並びが違う");
  assert.equal(b.nodes[ids["a2"]!]!.parentId, ids["機能B"], "親が付け替わっていない");
  // 列は動かない（ツリー上の位置とカンバン上の位置は独立）。
  assert.equal(b.nodes[ids["a2"]!]!.listId, b.nodes[ids["a1"]!]!.listId, "moveNode で列まで動いてしまっている");
  assertPositions(db, boardId, "moveNode で親替え");

  // 同じ親の中だけの移動でも連番が保たれること
  apply(db, boardId, { type: "moveNode", id: ids["a3"]!, parentId: ids["機能A"]!, beforeId: ids["a1"]! });
  assert.deepEqual(childTitles(board(db, boardId), ids["機能A"]!), ["a3", "a1"], "同じ親の中での並べ替えが効いていない");
  assertPositions(db, boardId, "moveNode で同一親内の移動");
});

test("moveNode は自分自身・子孫を親にできない", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const ids = buildTree(db, boardId, { 目的: { 機能: ["タスク"] } });

  assert.throws(
    () => apply(db, boardId, { type: "moveNode", id: ids["機能"]!, parentId: ids["機能"]!, beforeId: null }),
    OpError,
    "自分自身を親にできてしまった",
  );
  assert.throws(
    () => apply(db, boardId, { type: "moveNode", id: ids["目的"]!, parentId: ids["タスク"]!, beforeId: null }),
    OpError,
    "子孫（孫）を親にできてしまった",
  );
  assert.throws(
    () => apply(db, boardId, { type: "moveNode", id: ids["目的"]!, parentId: ids["機能"]!, beforeId: null }),
    OpError,
    "子を親にできてしまった",
  );

  const b = board(db, boardId);
  assert.equal(b.nodes[ids["機能"]!]!.parentId, ids["目的"], "失敗した moveNode で親が書き換わっている");
  assert.deepEqual(childTitles(b, null), ["目的"], "ルートの構成が変わっている");
  assertPositions(db, boardId, "moveNode の循環拒否後");
});

test("deleteNode はサブツリーごと消し、ids に子孫が全部載る", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const ids = buildTree(db, boardId, {
    目的: { 機能A: ["a1", "a2"], 機能B: ["b1"] },
  });
  const listId = board(db, boardId).lists[0]!.id;

  const op = applyOne(db, boardId, { type: "deleteNode", id: ids["機能A"]! });
  assert.equal(op.type, "deleteNode", "deleteNode の Op が返るはず");
  if (op.type === "deleteNode") {
    assert.deepEqual(
      [...op.ids].sort(),
      [ids["機能A"]!, ids["a1"]!, ids["a2"]!].sort(),
      "ids に自分＋子孫が全部載っていない",
    );
  }

  const b = board(db, boardId);
  for (const title of ["機能A", "a1", "a2"]) {
    assert.equal(b.nodes[ids[title]!], undefined, `${title} が nodes に残っている`);
    assert.equal(b.lists.some((l) => l.nodeIds.includes(ids[title]!)), false, `${title} が列に残っている`);
  }
  assert.deepEqual(childTitles(b, ids["目的"]!), ["機能B"], "残った兄弟の並びが違う");
  assert.deepEqual(
    b.lists.find((l) => l.id === listId)!.nodeIds.map((id) => b.nodes[id]!.title),
    ["目的", "機能B", "b1"],
    "列に残るノードの並びが違う",
  );
  assertPositions(db, boardId, "deleteNode 後");
});

test("appendNodeDescription は本文の末尾に足し、メモ行はいちばん下に残る", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const goal = addNode(db, boardId, { parentId: null, title: "目的", kind: "goal" });
  const id = addNode(db, boardId, { parentId: goal, title: "タスク", description: "なぜやるか: 入口だから" });

  // 差し戻しの指摘を1行積んでおく（sendBack と同じ形）。
  apply(db, boardId, { type: "sendBack", id, note: "エラー時の表示が無い" });
  const withNote = board(db, boardId).nodes[id]!.description;
  const noteLine = withNote.split("\n").at(-1)!;
  assert.match(noteLine, /^差し戻し \d{4}-\d{2}-\d{2}: エラー時の表示が無い$/, "前提の差し戻し行が作れていない");

  // 追記は本文の末尾（メモ行より前）に入る。全文を送らないので人間の編集を潰さない。
  const op = applyOne(db, boardId, { type: "appendNodeDescription", id, text: "エラー時は画面上部に赤帯で出す。" });
  assert.equal(op.type, "setNodeDescription", "setNodeDescription の Op に化けるはず");
  assert.equal(
    board(db, boardId).nodes[id]!.description,
    `なぜやるか: 入口だから\n\nエラー時は画面上部に赤帯で出す。\n\n${noteLine}`,
    "追記がメモ行より下に入っている",
  );

  // 空文字は no-op（seq を進めない）。
  assert.deepEqual(apply(db, boardId, { type: "appendNodeDescription", id, text: "  " }), [], "空の追記で Op が出ている");
});

test("clearNodeNotes はメモ行だけを落とし、本文には触らない", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const goal = addNode(db, boardId, { parentId: null, title: "目的", kind: "goal" });
  const id = addNode(db, boardId, { parentId: goal, title: "タスク", description: "なぜやるか: 入口だから" });

  // メモ行が無ければ no-op。
  assert.deepEqual(apply(db, boardId, { type: "clearNodeNotes", id }), [], "メモが無いのに Op が出ている");

  apply(db, boardId, { type: "sendBack", id, note: "指摘その1" });
  apply(db, boardId, { type: "sendBack", id, note: "指摘その2" });
  assert.equal(board(db, boardId).nodes[id]!.description.split("\n").length, 4, "差し戻し行が2本積まれていない");

  const op = applyOne(db, boardId, { type: "clearNodeNotes", id });
  assert.equal(op.type, "setNodeDescription", "setNodeDescription の Op に化けるはず");
  assert.equal(board(db, boardId).nodes[id]!.description, "なぜやるか: 入口だから", "本文まで削れている");
});

test("却下の墓標も clearNodeNotes の対象になる（親に積まれた分を畳める）", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const goal = addNode(db, boardId, { parentId: null, title: "目的", kind: "goal", description: "なぜやるか" });
  const proposed = addNode(db, boardId, { parentId: goal, title: "提案", state: "proposed" });
  apply(db, boardId, { type: "rejectNode", id: proposed, reason: "スコープ外" });
  assert.equal(board(db, boardId).nodes[goal]!.description.split("\n").length, 3, "墓標が積まれていない");

  applyOne(db, boardId, { type: "clearNodeNotes", id: goal });
  assert.equal(board(db, boardId).nodes[goal]!.description, "なぜやるか", "墓標だけを落とせていない");
});

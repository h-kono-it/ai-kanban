// 同期プロトコルの土台になる seq の検証。
// クライアントは seq の連番の欠落で取りこぼしを検出して resync するので、
// 「1 Op = 1 seq」「何も変わらなければ進めない」「失敗したら進めない」が崩れると
// 画面が黙ってズレる。

import test from "node:test";
import assert from "node:assert/strict";

import { applyIntent, OpError } from "../src/ops.ts";
import { getSeq } from "../src/store.ts";
import { addNode, apply, assertPositions, board, childTitles, freshDb } from "./helpers.ts";

test("bulkAddNodes は Op の数だけ seq を進める（入れ子の親が必ず子より先に来る）", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const goal = addNode(db, boardId, { parentId: null, title: "目的", kind: "goal" });
  const before = getSeq(db, boardId);

  const applied = applyIntent(db, boardId, {
    type: "bulkAddNodes",
    parentId: goal,
    nodes: [
      { title: "機能1", kind: "feature", children: [{ title: "タスク1-1" }, { title: "タスク1-2" }] },
      { title: "機能2", kind: "feature", children: [{ title: "タスク2-1" }] },
    ],
  });

  assert.equal(applied.length, 5, "入れ子を含めて 5 つの addNode Op に展開されるはず");
  assert.deepEqual(
    applied.map((a) => a.seq),
    [before + 1, before + 2, before + 3, before + 4, before + 5],
    "seq が Op ごとに1ずつ振られていない",
  );
  assert.equal(getSeq(db, boardId), before + 5, "boards.seq が Op の数だけ進んでいない");

  // 親が子より先に流れること（クライアントは順に applyOp するので、逆だと親不明で当たらない）。
  const seen = new Set<string>([goal]);
  for (const { op } of applied) {
    assert.equal(op.type, "addNode", "bulkAddNodes は addNode Op に展開されるはず（Op union に bulkAddNodes は無い）");
    if (op.type !== "addNode") continue;
    assert.equal(
      op.node.parentId !== null && seen.has(op.node.parentId),
      true,
      `${op.node.title} の親がまだ流れていない（親は子より先に来るはず）`,
    );
    seen.add(op.node.id);
  }

  const b = board(db, boardId);
  assert.deepEqual(childTitles(b, goal), ["機能1", "機能2"], "種の並び順がそのまま兄弟順になっていない");
  assert.deepEqual(childTitles(b, b.nodes[goal]!.childIds[0]!), ["タスク1-1", "タスク1-2"], "孫の並び順が違う");
  assertPositions(db, boardId, "bulkAddNodes 後");
});

test("何も変わらない意図は seq を進めない", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const active = addNode(db, boardId, { parentId: null, title: "確定済み", kind: "goal" });
  const proposed = addNode(db, boardId, { parentId: null, title: "未承認", kind: "goal", state: "proposed" });
  const before = getSeq(db, boardId);

  // 空タイトルの addNode
  assert.deepEqual(apply(db, boardId, { type: "addNode", parentId: null, title: "   " }), [], "空タイトルでノードが増えた");
  assert.equal(getSeq(db, boardId), before, "空タイトルの addNode が seq を進めた");

  // 既に active なノードへの approveNode（recursive なし）
  assert.deepEqual(apply(db, boardId, { type: "approveNode", id: active }), [], "active への approveNode が Op を返した");
  assert.equal(getSeq(db, boardId), before, "active への approveNode が seq を進めた");

  // 既に proposed なノードへの unapproveNode
  assert.deepEqual(apply(db, boardId, { type: "unapproveNode", id: proposed }), [], "proposed への unapproveNode が Op を返した");
  assert.equal(getSeq(db, boardId), before, "proposed への unapproveNode が seq を進めた");

  assert.equal(Object.keys(board(db, boardId).nodes).length, 2, "no-op のはずがノード数が変わっている");
});

test("OpError で失敗した意図は seq を進めず、DB も変更しない", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const goal = addNode(db, boardId, { parentId: null, title: "目的", kind: "goal" });
  const before = getSeq(db, boardId);
  const nodeCountBefore = Object.keys(board(db, boardId).nodes).length;

  // 1件目は挿入に成功し、2件目（空タイトル）で失敗する＝途中まで書いてから巻き戻る形。
  assert.throws(
    () =>
      applyIntent(db, boardId, {
        type: "bulkAddNodes",
        parentId: goal,
        nodes: [{ title: "先に入る機能" }, { title: "   " }],
      }),
    OpError,
    "空タイトルを含む bulkAddNodes が失敗しなかった",
  );

  assert.equal(getSeq(db, boardId), before, "失敗した意図が seq を進めた");
  assert.equal(Object.keys(board(db, boardId).nodes).length, nodeCountBefore, "ロールバックされずにノードが残っている");
  assert.deepEqual(childTitles(board(db, boardId), goal), [], "途中まで書かれたノードが残っている");

  // 存在しないノードへの意図も同じ（そもそも何も書かない）。
  assert.throws(
    () => apply(db, boardId, { type: "renameNode", id: "そんな id は無い", title: "X" }),
    OpError,
    "存在しないノードの renameNode が通ってしまった",
  );
  assert.equal(getSeq(db, boardId), before, "存在しないノードへの意図が seq を進めた");

  // 失敗のあとも普通に書ける（トランザクションが開きっぱなしになっていない）。
  const ok = applyIntent(db, boardId, { type: "addNode", parentId: goal, title: "あとから追加" });
  assert.equal(ok.length, 1, "失敗のあとに書き込めていない");
  assert.equal(ok[0]!.seq, before + 1, "失敗を挟んでも seq は連番のはず");
  assertPositions(db, boardId, "ロールバック後");
});

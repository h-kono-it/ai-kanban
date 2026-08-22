// ボード一覧まわり（最終更新の記録・並び順・アーカイブ）の検証。
// 鮮度は applyIntent が seq を進めるのと同じ場所で更新される。

import test from "node:test";
import assert from "node:assert/strict";

import { ensureBoard, listBoards } from "../src/store.ts";
import { addNode, apply, board, freshDb, tick } from "./helpers.ts";

test("書き込みが通るたびに updatedAt が進む（何も変わらない意図では進まない）", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  const created = listBoards(db)[0]!;
  assert.equal(created.updatedAt, created.createdAt, "作った直後は作成時刻と同じはず");
  assert.equal(created.archived, false, "作った直後にアーカイブされている");

  tick();
  const id = addNode(db, boardId, { parentId: null, title: "タスク" });
  const afterWrite = listBoards(db)[0]!.updatedAt;
  assert.notEqual(afterWrite, created.updatedAt, "書き込んだのに updatedAt が動いていない");

  // 空タイトルの改名は Op を返さない＝seq も updatedAt も進めない。
  tick();
  assert.deepEqual(apply(db, boardId, { type: "renameNode", id, title: "  " }), [], "no-op のはず");
  assert.equal(listBoards(db)[0]!.updatedAt, afterWrite, "no-op で updatedAt が進んでいる");
});

test("一覧は最終更新の新しい順に並ぶ（作成順ではない）", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);

  // freshDb が作った "test" のあとに2つ足す。作成順は test → 古い → 新しい。
  ensureBoard(db, "old", "古いボード");
  tick();
  ensureBoard(db, "recent", "最近のボード");

  // 古い方に書き込んで、最終更新だけを新しくする。
  tick();
  addNode(db, "old", { parentId: null, title: "タスク" });

  assert.deepEqual(
    listBoards(db).map((b) => b.id),
    ["old", "recent", "test"],
    "最終更新の新しい順になっていない",
  );
});

test("archived は setBoardSettings で立ち、undefined を送ると戻る", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  apply(db, boardId, { type: "setBoardSettings", settings: { archived: true } });
  assert.equal(listBoards(db)[0]!.archived, true, "アーカイブされていない");
  assert.deepEqual(board(db, boardId).settings, { archived: true }, "BoardState の settings に載っていない");

  apply(db, boardId, { type: "setBoardSettings", settings: { archived: undefined } });
  assert.equal(listBoards(db)[0]!.archived, false, "アーカイブが戻っていない");
  assert.deepEqual(board(db, boardId).settings, {}, "false を持たずキーごと落ちるはず");
});

test("settings は知らないキーと壊れた値を捨てる", (t) => {
  const { db, boardId, cleanup } = freshDb();
  t.after(cleanup);

  // REST からは任意の JSON が来る。型どおりでない値は落として保存する。
  apply(db, boardId, {
    type: "setBoardSettings",
    settings: { archived: "yes", danger: "<script>" } as never,
  });
  assert.deepEqual(board(db, boardId).settings, {}, "壊れた値がそのまま保存されている");
});

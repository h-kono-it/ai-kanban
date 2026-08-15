// Claude Code が叩く REST API。server.ts が app.route("/api", api) でマウントする。
// 全レスポンス JSON。
//
// 書き込みは必ず hub.ts の applyAndBroadcast() を通す。applyIntent() を直接呼ぶと
// 開いているブラウザに Op が届かず、画面が黙ってズレる。

import { Hono } from "hono";
import { getDb } from "./db.ts";
import { applyAndBroadcast } from "./hub.ts";
import type { AppliedOp } from "./ops.ts";
import { OpError } from "./ops.ts";
import type { Db } from "./db.ts";
import { boardExists, ensureBoard, getAwaiting, getSeq, getTree, getUndecomposedGoals, listBoards, loadBoard, walkTree } from "./store.ts";
import type { BeforeId, Intent, NodeKind, NodeSeed, NodeState, Op, TaskNode } from "./types.ts";
import { isValidBoardId, newBoardId } from "./util.ts";

// ---------------------------------------------------------------------------
// ボード id の予約語
// ---------------------------------------------------------------------------

/**
 * ルーティング上 /:id に食われては困るパス。ボード id として使えない。
 * 予約語のボードを作れてしまうと /<id> でブラウザから開けない盤ができるので、
 * API 側（ここ）と server.ts の boardIdGuard の両方で弾く。
 * server.ts からも import するため、両者が参照できるこのモジュールに置いている。
 */
const RESERVED_BOARD_IDS = new Set(["api", "login", "public"]);

export function isReservedBoardId(id: string): boolean {
  return RESERVED_BOARD_IDS.has(id);
}

// ---------------------------------------------------------------------------
// エラー（onError で一括変換するため、ハンドラは投げるだけ）
// ---------------------------------------------------------------------------

/** ステータスを持たせた API エラー。erasableSyntaxOnly なのでパラメータプロパティは使わない。 */
class ApiError extends Error {
  status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * POST /boards/:id/ops の途中失敗。
 * applyIntent はトランザクションを1意図ごとに閉じるので、配列の途中でコケても
 * それ以前に適用した分はロールバックされず DB に残る（＝配列全体はアトミックではない）。
 * 呼び出し側が続きから再送できるよう、何件目まで適用したかをエラー応答に載せる。
 */
class BulkOpsError extends Error {
  /** 成功した Intent の件数（= 次に再送すべき配列の添字）。 */
  appliedCount: number;
  /** そこまでに適用された Op（ブロードキャスト済み）。 */
  ops: Op[];
  /** 最後に採番された seq。 */
  seq: number;
  constructor(message: string, appliedCount: number, ops: Op[], seq: number) {
    super(message);
    this.appliedCount = appliedCount;
    this.ops = ops;
    this.seq = seq;
  }
}

// ---------------------------------------------------------------------------
// 入力の取り回し
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** JSON ボディを読む。壊れた JSON / オブジェクト以外は 400 に倒す。 */
async function readJson(body: Promise<unknown>): Promise<Json> {
  let parsed: unknown;
  try {
    parsed = await body;
  } catch {
    throw new ApiError(400, "リクエストボディが不正な JSON です");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "リクエストボディは JSON オブジェクトである必要があります");
  }
  return parsed as Json;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** ボード id を検証して返す。存在確認まではしない（POST /boards は未作成でも通す）。 */
function boardIdParam(raw: string | undefined): string {
  const id = raw ?? "";
  if (!isValidBoardId(id) || isReservedBoardId(id)) throw new ApiError(400, `不正なボード id: ${id}`);
  return id;
}

/** 既存ボードを前提とするルート用。無ければ 404。 */
function requireBoard(db: Db, raw: string | undefined): string {
  const id = boardIdParam(raw);
  if (!boardExists(db, id)) throw new ApiError(404, `ボードが見つかりません: ${id}`);
  return id;
}

// ---------------------------------------------------------------------------
// 書き込みの共通形
// ---------------------------------------------------------------------------

/** 書き込み系のレスポンス。seq は最後に採番された番号（何も変わらなければ現在値）。 */
function writeResult(db: Db, boardId: string, applied: AppliedOp[]): { ok: true; seq: number; ops: Op[] } {
  const last = applied[applied.length - 1];
  return { ok: true, seq: last ? last.seq : getSeq(db, boardId), ops: applied.map((a) => a.op) };
}

/**
 * 意図を順に適用する。途中で失敗したら、そこまでの適用結果を添えて BulkOpsError を投げる。
 * ここだけ try/catch があるのは「何件目まで適用したか」を応答に載せる必要があるため。
 */
function applySequence(db: Db, boardId: string, intents: Intent[]): AppliedOp[] {
  const applied: AppliedOp[] = [];
  for (let i = 0; i < intents.length; i++) {
    const intent = intents[i];
    if (intent === undefined) continue;
    try {
      applied.push(...applyAndBroadcast(db, boardId, intent));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const last = applied[applied.length - 1];
      throw new BulkOpsError(
        `${i + 1} 件目の意図で失敗しました: ${message}`,
        i,
        applied.map((a) => a.op),
        last ? last.seq : getSeq(db, boardId),
      );
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// ルーター
// ---------------------------------------------------------------------------

export const api = new Hono();

// ---- ボード ----------------------------------------------------------------

api.get("/boards", (c) => c.json(listBoards(getDb())));

api.post("/boards", async (c) => {
  const body = await readJson(c.req.json());
  const raw = optionalString(body.id)?.trim();
  // id 未指定なら採番する（ブラウザの POST / と同じ挙動）。
  const id = raw ? boardIdParam(raw) : newBoardId();
  ensureBoard(getDb(), id, optionalString(body.title));
  return c.json({ id });
});

api.get("/boards/:id", (c) => {
  const db = getDb();
  return c.json(loadBoard(db, requireBoard(db, c.req.param("id"))));
});

api.get("/boards/:id/tree", (c) => {
  const db = getDb();
  const boardId = requireBoard(db, c.req.param("id"));
  const node = c.req.query("node");
  // depth は「含める階層数」。1 ならルートだけ。数値にならない・0 以下なら無制限扱い。
  const rawDepth = c.req.query("depth");
  const depth = rawDepth === undefined ? undefined : Number.parseInt(rawDepth, 10);
  const validDepth = depth !== undefined && Number.isFinite(depth) && depth > 0 ? depth : undefined;
  return c.json(getTree(db, boardId, node, validDepth));
});

api.get("/boards/:id/awaiting", (c) => {
  const db = getDb();
  return c.json(getAwaiting(db, requireBoard(db, c.req.param("id"))));
});

api.get("/boards/:id/goals", (c) => {
  const db = getDb();
  const boardId = requireBoard(db, c.req.param("id"));
  // ?undecomposed=1 で「まだ細分化されていない目的」だけに絞る（AI が次に手を付ける対象）。
  if (c.req.query("undecomposed") !== undefined && c.req.query("undecomposed") !== "0") {
    return c.json(getUndecomposedGoals(db, boardId));
  }
  return c.json(allGoals(db, boardId));
});

/** kind="goal" のノードをツリーの深さ優先順で全部。 */
function allGoals(db: Db, boardId: string): TaskNode[] {
  return walkTree(loadBoard(db, boardId)).filter((node) => node.kind === "goal");
}

// ---- 書き込み --------------------------------------------------------------

/**
 * 汎用の書き込み口。{ops: Intent[]} を順に適用する。
 * 注意: 配列全体はアトミックではない。applyIntent が1意図ごとにトランザクションを
 * 閉じるため、途中で失敗してもそこまでに適用した分は DB に残り、ブロードキャストも済んでいる。
 * 失敗時は appliedCount（何件目まで成功したか）を返すので、そこから再送すること。
 */
api.post("/boards/:id/ops", async (c) => {
  const db = getDb();
  const boardId = requireBoard(db, c.req.param("id"));
  const body = await readJson(c.req.json());
  const raw = body.ops;
  if (!Array.isArray(raw)) throw new ApiError(400, "ops は Intent の配列である必要があります");
  const intents = raw.map((item, i) => {
    if (item === null || typeof item !== "object" || typeof (item as Json).type !== "string") {
      throw new ApiError(400, `ops[${i}] に type がありません`);
    }
    // 個々のフィールドの検証は applyIntent（ops.ts）に任せる。未知の type も OpError になる。
    return item as Intent;
  });
  return c.json(writeResult(db, boardId, applySequence(db, boardId, intents)));
});

/**
 * bulkAddNodes のラッパ。細分化結果の入れ子をそのまま投入する。
 * state 省略時は "proposed"（＝人間が承認するまでカンバンに出ない）。ops.ts の既定に従う。
 */
api.post("/boards/:id/nodes", async (c) => {
  const db = getDb();
  const boardId = requireBoard(db, c.req.param("id"));
  const body = await readJson(c.req.json());
  if (!Array.isArray(body.nodes)) throw new ApiError(400, "nodes は NodeSeed の配列である必要があります");
  const intent: Intent = {
    type: "bulkAddNodes",
    // parentId 未指定はルート直下（新しい目的）を意味する。
    parentId: optionalString(body.parentId) ?? null,
    beforeId: (body.beforeId ?? null) as BeforeId,
    state: body.state as NodeState | undefined,
    nodes: body.nodes as NodeSeed[],
  };
  return c.json(writeResult(db, boardId, applyAndBroadcast(db, boardId, intent)));
});

/**
 * ノードの部分更新。渡されたフィールドだけを対応する Intent に分解して順に適用する。
 * - title / description / dueDate / kind … それぞれ単独の Intent。
 * - parentId … ツリー上の移動（moveNode）。null ならルートへ。列は動かない。
 * - listId  … カンバン上の移動（moveCard）。ツリー上の親子関係は動かない。
 * - beforeId … 「この id の直前に置く」。parentId とセットなら兄弟順、listId とセットなら
 *              列内の順序に効く。両方指定すればそれぞれに同じ beforeId が使われるので、
 *              普通は parentId か listId のどちらか一方と組み合わせて使う。
 *              単独で渡されても解釈しようがないため無視する。
 * 途中で失敗したら applySequence が何件目まで適用したかを返す（ops と同じ理由でアトミックではない）。
 */
api.patch("/boards/:id/nodes/:nodeId", async (c) => {
  const db = getDb();
  const boardId = requireBoard(db, c.req.param("id"));
  const nodeId = c.req.param("nodeId") ?? "";
  const body = await readJson(c.req.json());
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);
  // null が意味を持つフィールド（parentId=null はルート、dueDate=null は解除）があるので、
  // 値の真偽ではなくキーの有無で「指定された」を判定する。
  const beforeId = (has("beforeId") ? body.beforeId : null) as BeforeId;

  const intents: Intent[] = [];
  if (has("title")) intents.push({ type: "renameNode", id: nodeId, title: String(body.title) });
  if (has("description")) intents.push({ type: "setNodeDescription", id: nodeId, description: String(body.description) });
  if (has("dueDate")) intents.push({ type: "setNodeDueDate", id: nodeId, dueDate: (body.dueDate ?? null) as string | null });
  if (has("kind")) intents.push({ type: "setNodeKind", id: nodeId, kind: body.kind as NodeKind });
  if (has("parentId")) {
    intents.push({ type: "moveNode", id: nodeId, parentId: optionalString(body.parentId) ?? null, beforeId });
  }
  if (has("listId")) {
    intents.push({ type: "moveCard", id: nodeId, listId: String(body.listId), beforeId });
  }
  if (intents.length === 0) throw new ApiError(400, "更新するフィールドがありません");
  return c.json(writeResult(db, boardId, applySequence(db, boardId, intents)));
});

api.delete("/boards/:id/nodes/:nodeId", (c) => {
  const db = getDb();
  const boardId = requireBoard(db, c.req.param("id"));
  const intent: Intent = { type: "deleteNode", id: c.req.param("nodeId") ?? "" };
  return c.json(writeResult(db, boardId, applyAndBroadcast(db, boardId, intent)));
});

// ---- エラー変換 ------------------------------------------------------------

// 各ハンドラに try/catch を散らさず、投げられた例外をここで一括して JSON に変換する。
api.onError((err, c) => {
  if (err instanceof BulkOpsError) {
    return c.json({ error: err.message, appliedCount: err.appliedCount, seq: err.seq, ops: err.ops }, 400);
  }
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
  if (err instanceof OpError) return c.json({ error: err.message }, 400);
  console.error("[api]", err);
  return c.json({ error: "サーバー内部エラー" }, 500);
});

// app.route("/api", api) でマウントすると 404 は親アプリ側の notFound に落ちて
// HTML/テキストになってしまう。全レスポンス JSON を守るため catch-all を最後に置く
// （上のルートが一致すればそちらがレスポンスを返すのでここには来ない）。
api.all("/*", (c) => c.json({ error: "そのような API はありません" }, 404));

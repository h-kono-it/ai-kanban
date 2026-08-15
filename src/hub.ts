// WebSocket 接続の管理とブロードキャスト。
//
// 設計の核: 書き込みは必ず applyAndBroadcast() を通す。ブラウザ（WS）も Claude Code（REST）も
// 同じ関数を呼ぶので、API を叩いた瞬間に開いているブラウザが更新される。
// applyIntent() を直接呼ぶ経路を足すと画面が黙ってズレるので絶対に増やさないこと。

import { WebSocket, WebSocketServer } from "ws";
import type { Db } from "./db.ts";
import type { AppliedOp } from "./ops.ts";
import { applyIntent } from "./ops.ts";
import { getSeq, loadBoard } from "./store.ts";
import type { Intent, ServerMsg } from "./types.ts";

/** boardId → その盤を開いている接続。0 になったらエントリごと捨てる（Map を伸ばしっぱなしにしない）。 */
const rooms = new Map<string, Set<WebSocket>>();

/**
 * 接続 → boardId の逆引き。送信に失敗した接続をその場で捨てるとき、
 * 呼び出し側が boardId を知らなくても rooms から外せるようにするため。
 * WeakMap なので接続が GC されればエントリも消える。
 */
const boardOf = new WeakMap<WebSocket, string>();

/** 直近の ping 周期で pong が返ってきた接続。次の周期で入っていなければ死んだとみなす。 */
const alive = new WeakSet<WebSocket>();

const PING_INTERVAL_MS = 30_000;

export function addSocket(boardId: string, ws: WebSocket): void {
  let set = rooms.get(boardId);
  if (!set) {
    set = new Set<WebSocket>();
    rooms.set(boardId, set);
  }
  set.add(ws);
  boardOf.set(ws, boardId);
  // 繋がった直後は生きているものとして扱う（初回の周期でいきなり切らないため）。
  alive.add(ws);
  ws.on("pong", () => {
    alive.add(ws);
  });
}

export function removeSocket(boardId: string, ws: WebSocket): void {
  const set = rooms.get(boardId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(boardId);
}

/** 送信に失敗した／死んだ接続を、boardId を知らなくても後片付けする。 */
function dropSocket(ws: WebSocket): void {
  const boardId = boardOf.get(ws);
  if (boardId !== undefined) removeSocket(boardId, ws);
  boardOf.delete(ws);
  try {
    ws.terminate();
  } catch {
    // 既に閉じている場合は何もすることがない
  }
}

/**
 * 1接続へ 1メッセージ送る。OPEN でなければ黙って捨てる。
 * 送信例外（相手が切断した直後など）は握り潰して接続ごと捨てる。ここで throw すると
 * ブロードキャストの途中で他の接続への配信が止まってしまうため。
 */
export function sendTo(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    dropSocket(ws);
  }
}

/** 適用済みの Op を、そのボードの全接続へ {type:"op", seq, op} として配る。 */
export function broadcast(boardId: string, applied: AppliedOp[]): void {
  if (applied.length === 0) return;
  const set = rooms.get(boardId);
  if (!set || set.size === 0) return;
  // 配信中に dropSocket が set を触るので、スナップショットを取ってから回す。
  for (const ws of [...set]) {
    for (const { seq, op } of applied) {
      sendTo(ws, { type: "op", seq, op });
    }
  }
}

/**
 * applyIntent + broadcast。REST も WS もこれを呼ぶ（唯一の書き込み経路）。
 * OpError はそのまま投げる。呼び出し側が WS では {type:"error"}、REST では 400 に変換する。
 */
export function applyAndBroadcast(db: Db, boardId: string, intent: Intent): AppliedOp[] {
  const applied = applyIntent(db, boardId, intent);
  broadcast(boardId, applied);
  return applied;
}

/** 接続直後と {type:"resync"} への応答。要求元の1接続にだけ全体像を送る。 */
export function sendState(db: Db, boardId: string, ws: WebSocket): void {
  const board = loadBoard(db, boardId);
  sendTo(ws, { type: "state", board, seq: getSeq(db, boardId) });
}

/** テスト・終了処理向け。今そのボードに繋がっている接続数。 */
export function socketCount(boardId: string): number {
  return rooms.get(boardId)?.size ?? 0;
}

// ---------------------------------------------------------------------------
// 死活監視
// ---------------------------------------------------------------------------

// TCP は片側が黙って消えても検出できないので、30 秒ごとに ping を撃って
// 前の周期の pong が無い接続を切る。切らないと rooms に幽霊が溜まり、
// ブロードキャストのたびに無駄な送信を試みることになる。
const pingTimer = setInterval(() => {
  for (const set of rooms.values()) {
    for (const ws of [...set]) {
      if (!alive.has(ws)) {
        dropSocket(ws);
        continue;
      }
      // 次の周期までに pong が返ってこなければ落とす。
      alive.delete(ws);
      try {
        ws.ping();
      } catch {
        dropSocket(ws);
      }
    }
  }
}, PING_INTERVAL_MS);
// このタイマーだけでプロセスが生き続けないように。
pingTimer.unref();

/** upgrade 処理で使う WebSocketServer。HTTP サーバーとは切り離して自前で upgrade する。 */
export function createWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true });
}

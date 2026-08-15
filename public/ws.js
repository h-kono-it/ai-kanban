// WebSocket 接続・再接続・送信。旧 my-kanban の board.js から移植。
//
// 受信は2種類だけ:
//   {type:"state"} … 全体像。丸ごと置き換える（接続直後と resync の応答）。
//   {type:"op"}    … 正規化済みの差分。seq が連番のときだけ当てる。
// 連番が飛んだら手元がズレているので resync を要求して全体を取り直す。
// 送信は「意図」だけ。楽観更新はせず、返ってきた Op を当てて初めて画面が変わる。

import { applyOp, replaceState, rerender, seq, setSeq } from "./state.js";

const statusEl = document.getElementById("conn-status");

let ws = null;
let boardId = null;
/** resync 要求の多重送信を避けるフラグ。state を受け取ったら解除する。 */
let resyncing = false;

// 再接続は指数バックオフ（2s→…→60s）。固定間隔で無限リトライすると、サーバーが
// 落ちている間ずっと接続を叩き続けることになる（旧実装では無料枠の保護が目的だった。
// ローカル運用でも無駄な再接続ループは避けたいので踏襲する）。
const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 60000;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;

// 一時的なエラー表示から元の接続ステータスへ戻すためのタイマーと文言。
const ERROR_DISPLAY_MS = 5000;
let statusText = "";
let errorTimer = null;

function setStatus(text) {
  statusText = text;
  if (errorTimer !== null) return; // エラー表示中は上書きしない（消えたら戻る）
  statusEl.textContent = text;
}

/** サーバーからの {type:"error"} を一定時間だけ出す。 */
function showError(message) {
  statusEl.textContent = `⚠ ${message}`;
  if (errorTimer !== null) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    errorTimer = null;
    statusEl.textContent = statusText;
  }, ERROR_DISPLAY_MS);
}

/** 接続を開始する。app.js から1度だけ呼ぶ。 */
export function connect(id) {
  boardId = id;
  open();
}

function open() {
  reconnectTimer = null;
  setStatus("接続中…");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/${boardId}/ws`);

  ws.onopen = () => {
    setStatus("接続済み");
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === "state") {
      // 初回接続・再同期の両方をここで吸収する。届いた＝同期が生きているので、
      // 次に切れたときは最短の間隔で繋ぎ直してよい。
      reconnectDelay = RECONNECT_MIN;
      resyncing = false;
      replaceState(msg.board, msg.seq);
      rerender();
      return;
    }

    if (msg.type === "op") {
      reconnectDelay = RECONNECT_MIN;
      if (msg.seq === seq + 1 && applyOp(msg.op)) {
        setSeq(msg.seq);
        rerender();
        return;
      }
      // 連番が飛んだ・戻った・当てられなかった（未知の Op / 対象が無い）。
      // どれも手元がズレている合図なので、全体を取り直す。
      requestResync();
      return;
    }

    if (msg.type === "error") {
      showError(msg.message);
    }
  };

  ws.onclose = async () => {
    setStatus("再接続待ち…");
    // 認証切れ（クッキー失効）だと ws は 401 で確立できず無限に再接続してしまう。
    // API を1回叩いて 401 ならログイン画面へ送る（PASSPHRASE 未設定なら 401 は返らない）。
    try {
      const res = await fetch(`/api/boards/${boardId}`, { redirect: "manual" });
      if (res.status === 401) {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        return;
      }
    } catch {
      // ネットワーク断などは通常の再接続にフォールバックする
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  // 非表示タブでは再接続しない（visibilitychange で再開）。放置タブのリトライ抑制。
  if (document.hidden) return;
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(open, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  // 非表示中に切断されたまま止まっていたら、戻ってきたタイミングで即再接続する。
  if (ws && ws.readyState === WebSocket.CLOSED && reconnectTimer === null) {
    reconnectDelay = RECONNECT_MIN;
    open();
  }
});

function requestResync() {
  if (resyncing) return;
  resyncing = true;
  send({ type: "resync" });
}

/** 意図を1つ送る。接続が開いていなければ黙って捨てる（次の state で追いつく）。 */
export function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

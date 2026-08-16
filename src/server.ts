// エントリポイント。Hono アプリ + HTTP サーバー + WebSocket の upgrade 処理。
// `node --disable-warning=ExperimentalWarning src/server.ts` で直接動く（Node 24 の型ストリップ）。

// 副作用 import。他のモジュールが process.env を読む前に .env を読み込む必要があるので
// 一番上に置くこと（ESM の import は記述順に評価される）。
import "./env.ts";

import { relative } from "node:path";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { WebSocket } from "ws";
import { api, isReservedBoardId } from "./api.ts";
import { AUTH_COOKIE, isCorrectPassphrase, isValidSession, safeNext, sessionToken } from "./auth.ts";
import { getDb } from "./db.ts";
import { addSocket, applyAndBroadcast, createWebSocketServer, removeSocket, sendState, sendTo } from "./hub.ts";
import { OpError } from "./ops.ts";
import { boardExists, ensureBoard, listBoards } from "./store.ts";
import { boardPage } from "./pages/board.ts";
import { homePage } from "./pages/home.ts";
import { loginPage } from "./pages/login.ts";
import type { ClientMsg } from "./types.ts";
import { isValidBoardId, newBoardId } from "./util.ts";

const app = new Hono();

// ---------------------------------------------------------------------------
// 静的ファイル
// ---------------------------------------------------------------------------

// serveStatic の root は「起動時の cwd からの相対パス」なので、cwd がどこでも
// public/ を指すように src/ からの相対で解決し直す。
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const staticRoot = relative(process.cwd(), publicDir) || ".";

// 認証ガードより先に置く＝静的アセットは認証の対象外（ログイン画面の CSS が必要なため）。
// 該当ファイルが無ければ next() されるので、後続のルートは普通に動く。
app.use("/*", serveStatic({ root: staticRoot }));

// ---------------------------------------------------------------------------
// 認証
// ---------------------------------------------------------------------------

// 認証済みセッションのクッキーを発行する。https のときだけ Secure を付ける
// （ローカル http 開発で壊れないように）。
async function setAuthCookie(c: Context, passphrase: string): Promise<void> {
  const token = await sessionToken(passphrase);
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, AUTH_COOKIE, token, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: 31536000,
    secure,
  });
}

/**
 * PASSPHRASE 未設定なら認証は完全に無効（ローカル利用の既定）。
 * 設定時はブラウザは HMAC クッキー、Claude Code などの API 利用は Bearer トークンで通す。
 */
async function authGuard(c: Context, next: Next): Promise<Response | void> {
  const passphrase = process.env.PASSPHRASE;
  if (!passphrase) return next();

  const path = c.req.path;
  if (path === "/login") return next();

  const isApi = path === "/api" || path.startsWith("/api/");

  // API はクッキーを持てないクライアント（Claude Code）から叩かれるので Bearer も許可する。
  if (isApi) {
    const header = c.req.header("Authorization") ?? "";
    if (header.startsWith("Bearer ") && (await isCorrectPassphrase(header.slice(7), passphrase))) {
      return next();
    }
  }

  if (await isValidSession(getCookie(c, AUTH_COOKIE), passphrase)) return next();

  if (isApi) return c.json({ error: "Unauthorized" }, 401);
  // /:id/ws は本来 HTTP サーバーの upgrade 側で弾かれるが、念のためここでも 401 にしておく。
  if (/^\/[^/]+\/ws$/.test(path)) return c.text("Unauthorized", 401);

  // HTML ページ要求は /login へリダイレクト（元のパスを next で引き回す）。
  const url = new URL(c.req.url);
  return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
}

app.use("*", authGuard);

// ---------------------------------------------------------------------------
// ボード id の検証
// ---------------------------------------------------------------------------

/**
 * /:id のボード id を検証する。app.use ではなくルートごとの前段ハンドラとして使う。
 * app.use("/:id", ...) にすると /login まで巻き込んで予約語判定で 404 にしてしまうため。
 */
async function boardIdGuard(c: Context, next: Next): Promise<Response | void> {
  const id = c.req.param("id");
  if (!id || !isValidBoardId(id)) return c.text("Invalid board ID", 400);
  // 予約語のボードを許すと /<id> が API やログインに食われて開けなくなる。
  if (isReservedBoardId(id)) return c.notFound();
  await next();
}

// ---------------------------------------------------------------------------
// ルート（/api/* は /:id より先に登録する）
// ---------------------------------------------------------------------------

app.get("/login", (c) => c.html(loginPage(safeNext(c.req.query("next")))));

app.post("/login", async (c) => {
  const passphrase = process.env.PASSPHRASE;
  const body = await c.req.parseBody();
  const input = typeof body.passphrase === "string" ? body.passphrase : "";
  const next = safeNext(typeof body.next === "string" ? body.next : undefined);

  // PASSPHRASE 未設定時は認証無効なので、そのまま next へ通す。
  if (!passphrase) return c.redirect(next, 302);

  if (await isCorrectPassphrase(input, passphrase)) {
    await setAuthCookie(c, passphrase);
    return c.redirect(next, 302);
  }
  return c.html(loginPage(next, true));
});

app.route("/api", api);

app.get("/", (c) => c.html(homePage(listBoards(getDb()))));

app.post("/", async (c) => {
  const body = await c.req.parseBody();
  const title = typeof body.title === "string" ? body.title : "";
  const raw = typeof body.id === "string" ? body.id.trim() : "";
  const id = raw || newBoardId();
  if (!isValidBoardId(id) || isReservedBoardId(id)) return c.text("Invalid board ID", 400);
  ensureBoard(getDb(), id, title);
  return c.redirect(`/${id}`, 302);
});

// URL を訪問したら暗黙にボードができる（旧 my-kanban と同じ挙動）。
app.get("/:id", boardIdGuard, (c) => {
  // boardIdGuard を通っている時点で必ず値があるが、型の上では optional なので畳んでおく。
  const id = c.req.param("id") ?? "";
  ensureBoard(getDb(), id);
  return c.html(boardPage(id));
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 3000);

// serve() が返すのは http.Server（http2 系を使う設定にしていないため）。
// upgrade イベントを自前で扱いたいのでキャストする。@hono/node-ws は依存の都合で使わない。
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ai-kanban listening on http://localhost:${info.port}`);
}) as Server;

const wss = createWebSocketServer();

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const WS_PATH_RE = /^\/([a-zA-Z0-9_-]{1,64})\/ws$/;

/** Cookie ヘッダを自前でパースする（upgrade は Hono を通らないので getCookie が使えない）。 */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      // "%" 単体のような壊れた値を投げつけられても upgrade ハンドラごと死なないように、
      // デコードできなければ生のまま扱う（どのみち照合に失敗して 401 になる）。
      out[name] = raw;
    }
  }
  return out;
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** ws の受信データは Buffer / Buffer[] / ArrayBuffer のいずれか。文字列に揃える。 */
function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
}

/**
 * 1メッセージ処理する。resync は要求元にだけ全体像を返し、それ以外は Intent として
 * applyAndBroadcast に流す。どんな例外でもプロセスを落とさず、送信元に error を返す。
 */
function handleMessage(boardId: string, ws: WebSocket, raw: unknown): void {
  let msg: ClientMsg;
  try {
    const parsed: unknown = JSON.parse(toText(raw));
    if (parsed === null || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      throw new Error("type がありません");
    }
    msg = parsed as ClientMsg;
  } catch {
    sendTo(ws, { type: "error", message: "不正なメッセージです" });
    return;
  }

  const db = getDb();
  try {
    if (msg.type === "resync") {
      sendState(db, boardId, ws);
      return;
    }
    // Intent のフィールド検証は applyIntent（ops.ts）に任せる。未知の type も OpError になる。
    applyAndBroadcast(db, boardId, msg);
  } catch (e) {
    if (e instanceof OpError) {
      sendTo(ws, { type: "error", message: e.message });
      return;
    }
    console.error("[ws]", e);
    sendTo(ws, { type: "error", message: "サーバー内部エラー" });
  }
}

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const match = WS_PATH_RE.exec(new URL(req.url ?? "/", "http://localhost").pathname);
  const boardId = match?.[1];
  if (!boardId || isReservedBoardId(boardId)) {
    socket.destroy();
    return;
  }

  // isValidSession は async なので即時関数で包む。upgrade ハンドラは Promise を待てない。
  void (async () => {
    const passphrase = process.env.PASSPHRASE;
    if (passphrase) {
      const cookies = parseCookieHeader(req.headers.cookie);
      if (!(await isValidSession(cookies[AUTH_COOKIE], passphrase))) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
    }

    const db = getDb();
    // 存在しないボードに繋がれると sendState が throw するので先に弾く。
    // ブラウザは GET /:id（= ensureBoard 済み）を経由して繋ぐので通常は起きない。
    if (!boardExists(db, boardId)) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      addSocket(boardId, ws);
      // 繋がった直後に全体像を1回だけ送る。以降は Op の差分だけが流れる。
      sendState(db, boardId, ws);
      ws.on("message", (data) => handleMessage(boardId, ws, data));
      ws.on("close", () => removeSocket(boardId, ws));
      ws.on("error", () => removeSocket(boardId, ws));
    });
  })();
});

// ---------------------------------------------------------------------------
// 終了処理
// ---------------------------------------------------------------------------

process.on("SIGINT", () => {
  // 開いている WebSocket は server.close() を待たせるので先に切る。
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close(() => process.exit(0));
});

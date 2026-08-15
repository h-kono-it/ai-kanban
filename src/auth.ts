// パスフレーズ認証のヘルパー群。デプロイ全体で共有の1パスフレーズ方式で、
// セッションはステートレス（クッキー値 = HMAC を毎リクエスト再計算して照合）。
// PASSPHRASE が未設定なら認証は無効。詳細は src/server.ts の authGuard を参照。

export const AUTH_COOKIE = "aik_auth";

// セッショントークン = HMAC-SHA256(key=PASSPHRASE, message="kanban-auth-v1") の hex。
// 固定メッセージなので同じパスフレーズなら常に同じ値になり、ステートレスに照合できる。
const SESSION_MESSAGE = "kanban-auth-v1";

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// クッキーに入れる／照合するセッショントークンを計算する。
export function sessionToken(passphrase: string): Promise<string> {
  return hmacHex(passphrase, SESSION_MESSAGE);
}

// タイミングセーフな文字列比較（全バイト XOR 累積方式）。
// 長さが違えば即 false だが、hex トークン同士の比較では常に同じ長さになるため
// 長さ差による早期リターンでの情報漏洩は起きない。
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// クッキー値が正しいセッショントークンかを照合する。
export async function isValidSession(cookieValue: string | undefined, passphrase: string): Promise<boolean> {
  if (!cookieValue) return false;
  const expected = await sessionToken(passphrase);
  return timingSafeEqual(cookieValue, expected);
}

// 入力パスフレーズが正しいかを照合する。両辺に HMAC を適用してから比較することで
// タイミングセーフかつ長さ漏洩なし。
export async function isCorrectPassphrase(input: string, passphrase: string): Promise<boolean> {
  const [a, b] = await Promise.all([sessionToken(input), sessionToken(passphrase)]);
  return timingSafeEqual(a, b);
}

// open redirect 防止: "/" で始まる相対パスのみ許可し、"//"（プロトコル相対）は拒否。
// ブラウザは "\" を "/" に正規化するため "/\" もプロトコル相対と同義で拒否する。
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

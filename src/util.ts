/** ノード・リスト・担当者の id。URL に出ることもあるので短めの hex。 */
export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** ボード id は手で打つこともあるのでさらに短く。 */
export function newBoardId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** URL に載せて安全なボード id か。ユーザーが好きな id を指定できるので検証する。 */
export function isValidBoardId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

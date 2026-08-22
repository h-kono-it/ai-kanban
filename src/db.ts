import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Db = DatabaseSync;

export const DEFAULT_DB_PATH = "./data/kanban.db";

let instance: Db | null = null;

/**
 * プロセス内で共有する SQLite 接続。node:sqlite は同期 API なので、
 * ハンドラの中から素直に呼んでよい（ローカル用途で並行度も高くない）。
 */
export function getDb(): Db {
  if (!instance) instance = openDb(process.env.DB_PATH ?? DEFAULT_DB_PATH);
  return instance;
}

export function openDb(path: string): Db {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  // WAL にしておくと読み書きが競合しにくい。外部キーは既定 OFF なので明示的に入れる
  // （nodes.parent_id の ON DELETE CASCADE がサブツリー削除の土台になっている）。
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  db.exec(schema);

  // schema.sql は CREATE TABLE IF NOT EXISTS なので、既にあるテーブルには列が増えない。
  // 後から足した列はここで個別に追いつかせる（ALTER TABLE は列が既にあると落ちるため、
  // PRAGMA table_info で存在を見てから流す）。
  if (addColumn(db, "boards", "updated_at", "TEXT")) {
    // 既存ボードの初期値。ノードの最終更新が拾えればそれを、無ければ作成時刻を入れる。
    db.exec(
      `UPDATE boards SET updated_at =
         COALESCE((SELECT MAX(updated_at) FROM nodes WHERE nodes.board_id = boards.id), created_at)
       WHERE updated_at IS NULL`,
    );
  }
}

/** 列が無ければ足す。足したら true。定義は schema.sql 側にも必ず書いておくこと（新規 DB 用）。 */
function addColumn(db: Db, table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** 複数の書き込みをまとめて1トランザクションにする。例外時はロールバックする。 */
export function transact<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

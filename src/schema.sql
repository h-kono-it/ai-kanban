-- ai-kanban のスキーマ。db.ts の migrate() が起動時に流す（すべて IF NOT EXISTS で冪等）。
-- PRAGMA は接続ごとの設定なので db.ts 側で行う。

CREATE TABLE IF NOT EXISTS boards (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  -- 差分同期の通し番号。mutation を1つ適用するたびに 1 増える。
  seq        INTEGER NOT NULL DEFAULT 0,
  settings   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- カンバンの列 = ステータス。
CREATE TABLE IF NOT EXISTS lists (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title    TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- 'normal' | 'awaiting_human' | 'done'
  role     TEXT NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id, position);

-- 目的・機能・タスクをすべて収める単一のツリー。カンバンはこのテーブルのビュー。
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  -- NULL ならルート（＝目的）。
  parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  -- 'goal' | 'feature' | 'task'
  kind        TEXT NOT NULL DEFAULT 'task',
  -- 'active' | 'proposed'
  state       TEXT NOT NULL DEFAULT 'active',
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  list_id     TEXT NOT NULL REFERENCES lists(id),
  -- 兄弟内の順序。
  tree_pos    INTEGER NOT NULL,
  -- カンバン列内の順序。ツリー順とは独立に動く。
  list_pos    INTEGER NOT NULL,
  due_date    TEXT,
  -- role='done' の列に在る間だけ ISO 文字列が入る。
  completed_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_tree ON nodes(board_id, parent_id, tree_pos);
CREATE INDEX IF NOT EXISTS idx_nodes_list ON nodes(board_id, list_id, list_pos);

CREATE TABLE IF NOT EXISTS assignees (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('person','team')),
  name     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignees_board ON assignees(board_id);

-- チーム↔人の多対多。所有方向はない。
CREATE TABLE IF NOT EXISTS team_members (
  team_id   TEXT NOT NULL REFERENCES assignees(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES assignees(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, member_id)
);

-- ノードへの割り当て。人・チームを区別せず同じ表に入れる。
CREATE TABLE IF NOT EXISTS node_assignees (
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  assignee_id TEXT NOT NULL REFERENCES assignees(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, assignee_id)
);
CREATE INDEX IF NOT EXISTS idx_node_assignees_assignee ON node_assignees(assignee_id);

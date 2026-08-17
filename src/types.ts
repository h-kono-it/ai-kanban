// サーバーとクライアントで共有するドメイン型と同期プロトコルの定義。
// public/*.js は素の JS なのでこの型を import しないが、形はここが正本。
// 変更したら public/state.js の applyOp と API.md も必ず追随させること。

// ---------------------------------------------------------------------------
// ドメイン
// ---------------------------------------------------------------------------

/** ツリー上の役割ラベル。振る舞いには影響せず、表示バッジと API からの絞り込みに使う。 */
export type NodeKind = "goal" | "feature" | "task";

/**
 * ノードの確定状態。
 * - active:   確定したタスク。カンバンに並ぶ。
 * - proposed: AI が提案しただけでまだ人間が承認していない。ツリーにのみ現れる。
 */
export type NodeState = "active" | "proposed";

/**
 * カンバン列の意味づけ。
 * - normal:         ふつうの進行状態。
 * - awaiting_human: 人間の対応待ち（レビュー待ち・承認待ち）。AI はここで手を止める。
 * - done:           完了。この列に入っている間だけ completedAt に時刻が入る。
 */
export type ListRole = "normal" | "awaiting_human" | "done";

export type AssigneeKind = "person" | "team";

export interface TaskNode {
  id: string;
  /** null ならルート（＝目的）。 */
  parentId: string | null;
  kind: NodeKind;
  state: NodeState;
  title: string;
  description: string;
  /** 所属するカンバン列。proposed のノードも列は持つが、カンバンには出ない。 */
  listId: string;
  /** 子の id を tree 順で。葉なら空配列。 */
  childIds: string[];
  /** 人・チームの id が混在する。 */
  assigneeIds: string[];
  /** "YYYY-MM-DD" または null。 */
  dueDate: string | null;
  /** role="done" の列に在る間だけ ISO 文字列。それ以外は null。 */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListCol {
  id: string;
  title: string;
  role: ListRole;
  /**
   * この列にある state="active" なノードの id を列内の順序で。
   * 親ノードも含まれる（カンバンに描くとき「葉だけ」に絞るのはクライアントの仕事）。
   * proposed のノードはここに載らず、承認された時点で挿入される。
   */
  nodeIds: string[];
}

export interface Assignee {
  id: string;
  kind: AssigneeKind;
  name: string;
  /** kind="team" のときだけ意味を持つ。人と同じ id 空間。 */
  memberIds: string[];
}

/** ボード単位の設定。今は空。将来足すときに型エラーで気づけるよう never にしてある。 */
export type BoardSettings = Record<string, never>;

/** WebSocket の {type:"state"} で丸ごと送られるボードの全体像。 */
export interface BoardState {
  id: string;
  title: string;
  settings: BoardSettings;
  /** 表示順そのまま。 */
  lists: ListCol[];
  nodes: Record<string, TaskNode>;
  /** ルートノード（目的）の id を tree 順で。 */
  rootIds: string[];
  assignees: Record<string, Assignee>;
}

// ---------------------------------------------------------------------------
// クライアント → サーバー（意図）
// ---------------------------------------------------------------------------

/**
 * 並び順の指定は index ではなく「この id の直前に置く」で表現する（null なら末尾）。
 * カンバンやツリーは絞り込み表示で一部のノードが隠れることがあり、DOM 上の index は
 * 実データの index と一致しないため。旧 my-kanban の index 方式はここが弱かった。
 */
export type BeforeId = string | null;

/** bulkAddNodes で受け取る入れ子の種。細分化結果をそのまま流し込むための形。 */
export interface NodeSeed {
  title: string;
  description?: string;
  kind?: NodeKind;
  listId?: string;
  dueDate?: string | null;
  assigneeIds?: string[];
  children?: NodeSeed[];
}

export type Intent =
  // ツリー
  | { type: "addNode"; parentId: string | null; beforeId?: BeforeId; title: string; kind?: NodeKind; description?: string; listId?: string; state?: NodeState; dueDate?: string | null; assigneeIds?: string[] }
  | { type: "renameNode"; id: string; title: string }
  | { type: "setNodeDescription"; id: string; description: string }
  | { type: "setNodeDueDate"; id: string; dueDate: string | null }
  | { type: "setNodeKind"; id: string; kind: NodeKind }
  | { type: "moveNode"; id: string; parentId: string | null; beforeId: BeforeId }
  | { type: "deleteNode"; id: string }
  | { type: "toggleNodeAssignee"; nodeId: string; assigneeId: string }
  /** 細分化結果の一括投入。入れ子ごと作る。省略時 state は "proposed"。 */
  | { type: "bulkAddNodes"; parentId: string | null; beforeId?: BeforeId; state?: NodeState; nodes: NodeSeed[] }
  // 承認ゲート（提案の承認）
  | { type: "approveNode"; id: string; recursive?: boolean }
  /** 承認の取り消し。子孫も必ず巻き込む（recursive の指定は無い）。 */
  | { type: "unapproveNode"; id: string }
  /**
   * 提案をサブツリーごと削除する。reason を添えると親の description に墓標が1行残る。
   * ルート（親が無い）に reason を添えると追記先が無いのでエラーになる。
   */
  | { type: "rejectNode"; id: string; reason?: string }
  // カンバン
  | { type: "moveCard"; id: string; listId: string; beforeId: BeforeId }
  | { type: "addList"; title: string; role?: ListRole; beforeId?: BeforeId }
  | { type: "renameList"; id: string; title: string }
  | { type: "setListRole"; id: string; role: ListRole }
  | { type: "deleteList"; id: string }
  | { type: "moveList"; id: string; beforeId: BeforeId }
  // メンバー
  | { type: "addAssignee"; kind: AssigneeKind; name: string }
  | { type: "renameAssignee"; id: string; name: string }
  | { type: "deleteAssignee"; id: string }
  | { type: "toggleTeamMember"; teamId: string; memberId: string }
  // ボード
  | { type: "renameBoard"; title: string }
  | { type: "setBoardSettings"; settings: Partial<BoardSettings> };

export type ClientMsg = Intent | { type: "resync" };

// ---------------------------------------------------------------------------
// サーバー → クライアント（正規化済みの適用結果）
// ---------------------------------------------------------------------------

/**
 * Op はクライアントメッセージのエコーではなく「実際に適用された結果」。
 * id は採番済み、index は解決済み、トグルは present で明示される。
 * bulkAddNodes のような糖衣は複数の addNode Op に展開して配信するので、
 * ここには現れない（クライアントの applyOp に特別扱いを増やさないため）。
 */
export type Op =
  // ツリー
  | { type: "addNode"; node: TaskNode; treeIndex: number; listIndex: number | null }
  | { type: "renameNode"; id: string; title: string }
  | { type: "setNodeDescription"; id: string; description: string }
  | { type: "setNodeDueDate"; id: string; dueDate: string | null }
  | { type: "setNodeKind"; id: string; kind: NodeKind }
  | { type: "moveNode"; id: string; parentId: string | null; treeIndex: number }
  /** サブツリーごと消える。ids は自分を含む子孫すべて。 */
  | { type: "deleteNode"; ids: string[] }
  | { type: "toggleNodeAssignee"; nodeId: string; assigneeId: string; present: boolean }
  // 承認ゲート
  /**
   * 承認され active になったノードと、それぞれが入った列内の位置。
   * role="done" の列に居るノードを承認するとその場で完了扱いになるので completedAt も返す。
   */
  | { type: "approveNode"; entries: { id: string; listId: string; listIndex: number; completedAt: string | null }[] }
  /** 未承認に戻ったノード。カンバンから外れ、completedAt も落ちる。 */
  | { type: "unapproveNode"; ids: string[] }
  /**
   * 却下で消えたノード。ids は自分を含む子孫すべて。
   * 理由は Op に載らない。親の description への追記として、この直前に
   * setNodeDescription の Op が別途配信される（消える側に情報を積んでも読めないため）。
   */
  | { type: "rejectNode"; ids: string[] }
  // カンバン
  | { type: "moveCard"; id: string; listId: string; listIndex: number; completedAt: string | null }
  | { type: "addList"; list: ListCol; index: number }
  | { type: "renameList"; id: string; title: string }
  | { type: "setListRole"; id: string; role: ListRole }
  /** 列を消してもノードは消さない。残ったノードは movedToListId の末尾へ退避する。 */
  | { type: "deleteList"; id: string; movedToListId: string | null; movedNodeIds: string[] }
  | { type: "moveList"; id: string; index: number }
  // メンバー
  | { type: "addAssignee"; assignee: Assignee }
  | { type: "renameAssignee"; id: string; name: string }
  /** 消えた担当者は全ノードとチームからも外れる。 */
  | { type: "deleteAssignee"; id: string }
  | { type: "toggleTeamMember"; teamId: string; memberId: string; present: boolean }
  // ボード
  | { type: "renameBoard"; title: string }
  | { type: "setBoardSettings"; settings: BoardSettings };

export type ServerMsg =
  | { type: "state"; board: BoardState; seq: number }
  | { type: "op"; seq: number; op: Op }
  | { type: "error"; message: string };

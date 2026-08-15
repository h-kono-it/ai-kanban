# ai-kanban API

ローカルの Claude Code から叩くための REST API。**サーバーは LLM を呼びません。** 目的を読んでタスクに細分化するのは Claude Code 側の仕事で、このサーバーは「ツリーの正本 + API + リアルタイム配信」に徹します。

書き込みは必ずブロードキャストされるので、**API を叩くとブラウザで開いているボードが即座に更新されます。**

- ベース URL: `http://localhost:3000`（`PORT` で変更可）
- ボード id は URL の一部（`/<boardId>`）。`api` `login` `public` は予約語で使えません。

## 認証

`PASSPHRASE` 環境変数が**未設定なら認証は無効**（ローカル利用の既定）。設定した場合は:

```bash
curl -H "Authorization: Bearer $PASSPHRASE" localhost:3000/api/boards
```

ブラウザは HMAC クッキーで通ります（`/login`）。

## データモデル

目的・機能・タスクは**すべて `nodes` という1本のツリー**に入ります。カンバンはそのツリーのビューであり、別の実体ではありません。

```
nodes（単一ツリー）
  認証基盤をつくる            kind=goal      list=ToDo
   ├─ セッション管理           kind=feature   list=進行中
   │   ├─ HMAC クッキー        kind=task      list=レビュー待ち   ← カンバンに出る（葉）
   │   └─ 有効期限の設計       kind=task      list=ToDo           ← カンバンに出る（葉）
   └─ パスワードリセット       kind=feature   list=ToDo
```

- **カンバンに並ぶのは葉ノード（子を持たないノード）だけ。** 親は「箱」なのでカードになりません。子を1つ足した瞬間、その親はカンバンから消えます。
- ノードの並び順は2系統あって独立に動きます: ツリー上の兄弟順（`tree_pos`）と、カンバン列内の順序（`list_pos`）。

### ノードの2つの状態（`state`）

| state | 意味 |
|---|---|
| `active` | 確定したタスク。カンバンに並ぶ。 |
| `proposed` | **AI が提案しただけで、人間がまだ承認していない。** ツリーにだけ点線で現れ、カンバンには出ない。 |

**`POST /nodes` で投入したノードは既定で `proposed` です。** 人間が UI の「承認」を押す（＝ `approveNode`）と `active` になってカンバンに並びます。勝手に確定させたい場合のみ明示的に `"state": "active"` を指定してください。

### 列の役割（`role`）

| role | 意味 |
|---|---|
| `normal` | ふつうの進行状態 |
| `awaiting_human` | **人間の対応待ち**（既定では「レビュー待ち」「承認待ち」）。AI はここで手を止める |
| `done` | 完了。この列にいる間だけ `completedAt` に時刻が入る |

既定の列は `ToDo` / `進行中` / `レビュー待ち`(awaiting_human) / `承認待ち`(awaiting_human) / `完了`(done)。列は追加・削除・改称でき、完了判定は列 id ではなく `role` で行います。

---

## エンドポイント

### 読み取り

| メソッド | パス | 内容 |
|---|---|---|
| `GET` | `/api/boards` | ボード一覧 |
| `GET` | `/api/boards/:id` | ボードの全体像（`BoardState`。列・ノード・担当者すべて） |
| `GET` | `/api/boards/:id/tree` | **入れ子 JSON**。`?node=<id>` で部分木、`?depth=<n>` で階層数を制限（`depth=1` はルートのみ） |
| `GET` | `/api/boards/:id/goals` | `kind="goal"` のノード。`?undecomposed=1` で**まだ子を持たない目的**だけ＝これから細分化すべきもの |
| `GET` | `/api/boards/:id/awaiting` | `{awaitingHuman, proposed}`。**人間待ちで止まっているもの** |

### 書き込み

| メソッド | パス | 内容 |
|---|---|---|
| `POST` | `/api/boards` | `{id?, title?}` → `{id}`。id 省略で自動採番 |
| `POST` | `/api/boards/:id/nodes` | **入れ子をまとめて投入**（細分化結果の投入口） |
| `PATCH` | `/api/boards/:id/nodes/:nodeId` | 部分更新 |
| `DELETE` | `/api/boards/:id/nodes/:nodeId` | サブツリーごと削除 |
| `POST` | `/api/boards/:id/ops` | **汎用の書き込み口**。`{ops: Intent[]}` を順に適用 |

書き込み系の応答は `{ok: true, seq, ops: [...]}`。`ops` は「実際に適用された正規化済みの結果」で、送った内容のエコーではありません（id は採番済み、順序は解決済み）。

---

## 典型的なワークフロー

### 1. 未細分化の目的を探す

```bash
curl -s localhost:3000/api/boards/myboard/goals?undecomposed=1
```

### 2. 目的の詳細（要求の本文）を読む

```bash
curl -s "localhost:3000/api/boards/myboard/tree?node=<goalId>"
```

`description` にハイレベルな要求が書かれています。

### 3. 細分化結果を投入する

```bash
curl -sX POST localhost:3000/api/boards/myboard/nodes \
  -H 'content-type: application/json' -d '{
  "parentId": "<goalId>",
  "nodes": [
    {
      "title": "セッション管理",
      "kind": "feature",
      "description": "ログイン状態の保持方式を決めて実装する",
      "children": [
        { "title": "HMAC クッキーの実装", "kind": "task" },
        { "title": "有効期限とローテーション", "kind": "task" }
      ]
    },
    { "title": "パスワードリセット", "kind": "feature" }
  ]
}'
```

- `parentId: null` にすると**新しい目的そのもの**を作れます。
- 投入されたノードは **`proposed`（未承認）** なので、人間が UI で承認するまでカンバンには出ません。これは仕様です — 勝手にタスクを増やして作業キューを汚さないための安全弁です。
- `NodeSeed` のフィールド: `title`（必須）/ `description` / `kind`（`goal`|`feature`|`task`）/ `listId` / `dueDate`（`YYYY-MM-DD`）/ `assigneeIds` / `children`

### 4. 人間待ちを確認する

```bash
curl -s localhost:3000/api/boards/myboard/awaiting
```

`awaitingHuman`（レビュー待ち・承認待ちの列にいるタスク）と `proposed`（未承認の提案）が返ります。**ここに積まれているものは AI 側では進められません。** ユーザーに報告して判断を仰いでください。

### 5. 作業したタスクをレビュー待ちに送る

```bash
# 列 id は GET /api/boards/:id の lists から取る（role="awaiting_human" のもの）
curl -sX PATCH localhost:3000/api/boards/myboard/nodes/<nodeId> \
  -H 'content-type: application/json' -d '{"listId": "<レビュー待ちの列id>"}'
```

---

## Intent リファレンス（`POST /ops` で使える全操作）

`{"ops": [ ... ]}` の配列に入れて送ります。UI の操作もすべてこの Intent に対応していて、**ブラウザと API はまったく同じ経路を通ります。**

**順序の指定はすべて `beforeId`**（「この id の直前に置く」、`null` なら末尾）。index ではありません — 画面側が絞り込みで一部しか表示していなくても正しく解決できるようにするためです。

### ツリー

| type | フィールド |
|---|---|
| `addNode` | `parentId`(必須,null可) `title`(必須) `beforeId?` `kind?` `description?` `listId?` `state?` `dueDate?` `assigneeIds?` |
| `bulkAddNodes` | `parentId`(必須,null可) `nodes`(必須) `beforeId?` `state?`（既定 `proposed`） |
| `renameNode` | `id` `title` |
| `setNodeDescription` | `id` `description` |
| `setNodeDueDate` | `id` `dueDate`（`YYYY-MM-DD` または null） |
| `setNodeKind` | `id` `kind` |
| `moveNode` | `id` `parentId`(null可) `beforeId` — ツリー上の移動。**列は動かない** |
| `deleteNode` | `id` — **サブツリーごと**消える |
| `toggleNodeAssignee` | `nodeId` `assigneeId` |

### 承認

| type | フィールド |
|---|---|
| `approveNode` | `id` `recursive?` — `proposed` → `active`。**祖先が未承認ならそれも一緒に承認される**（親が未承認なのに子だけ確定する状態を作らないため）。`recursive: true` で配下の提案もすべて承認 |
| `unapproveNode` | `id` — 承認の取り消し。`active` → `proposed` に戻し、カンバンから外して `completedAt` も落とす。**子孫の確定済みも必ず一緒に戻る**（`approveNode` が祖先を巻き込むのと対称）。削除ではないので、再度 `approveNode` すれば元に戻る |
| `rejectNode` | `id` — 提案をサブツリーごと削除。`active` なノードには使えない |

### カンバン

| type | フィールド |
|---|---|
| `moveCard` | `id` `listId` `beforeId` — 列の移動＝ステータス変更。`role="done"` の列に入ると `completedAt` が入る（同じ列内の並べ替えでは元の時刻を維持） |
| `addList` | `title` `role?` `beforeId?` |
| `renameList` | `id` `title` |
| `setListRole` | `id` `role` — 既存ノードの `completedAt` は動かさない。新しい role は次の `moveCard` から効く |
| `deleteList` | `id` — **列を消してもノードは消えない**（ツリーの実体なので）。他の列の末尾へ退避する |
| `moveList` | `id` `beforeId` |

### 担当者

| type | フィールド |
|---|---|
| `addAssignee` | `kind`(`person`\|`team`) `name` |
| `renameAssignee` | `id` `name` |
| `deleteAssignee` | `id` |
| `toggleTeamMember` | `teamId` `memberId` |

人とチームは同じ id 空間にあり、カードにはどちらも同じように割り当てられます（チームは人を多対多で含む）。

### ボード

| type | フィールド |
|---|---|
| `renameBoard` | `title` |
| `setBoardSettings` | `settings` |

---

## エラーと注意

- 不正な意図は `400 {"error": "..."}`。存在しないボードは `404`。
- **`POST /ops` の配列はアトミックではありません。** 1意図ごとにトランザクションが閉じるので、途中で失敗するとそこまでは適用済みのまま残ります。失敗応答には `appliedCount`（何件目まで成功したか）が入るので、そこから再送してください。
- 存在しない id を指定するとエラーになります（黙って無視はしません）。タイトルが空の場合だけは no-op です。
- `deleteNode` は子孫ごと消えます。取り消しはできません。

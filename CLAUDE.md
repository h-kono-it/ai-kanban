# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # 依存は hono / @hono/node-server / ws の3つだけ
npm run dev       # node --watch で起動（http://localhost:3000）
npm start         # 本番相当
npm run typecheck # tsc --noEmit（テストスイートは無い）
```

**ビルドステップはありません。** Node 24 のネイティブ型ストリップで `.ts` を直接実行し、クライアントは素の ESM です。この前提を壊さないために `tsconfig.json` で `erasableSyntaxOnly: true` を設定してあるので、**enum / namespace / パラメータプロパティは使えません**。また相対 import は**拡張子付き**（`"./db.ts"`）で書き、型だけの import は `import type` にすること（`verbatimModuleSyntax`）。

**JSX も使えません**（型ストリップは JSX を変換しない）。ページは `hono/html` のテンプレートリテラルで書きます。

テストは無いので、変更の検証は `npm run dev` してブラウザで触る + `curl` で API を叩く、が基本です。複数タブを開くと WebSocket 同期を確認できます。

## このアプリは何か

AI との協働を前提にしたツリー型カンバン。**目的を放り込む → ローカルの Claude Code が REST API 経由で細分化してツリーに投入する → 人間が承認する → カンバンで進める**、という流れのために作られています。

**サーバーは LLM を呼びません。** 細分化の知能はローカルの Claude Code 側にあり、サーバーは「ツリーの正本 + API + リアルタイム配信」に徹します。だから **UI に「細分化する」ボタンを作ってはいけません**（押しても何も起きないボタンになる）。導線は目的追加モーダルが出す「依頼文のコピー」です。

Cloudflare Workers + Durable Object 版の [my-kanban](../my-kanban) が前身で、クライアントの作法とデータモデルの考え方を引き継いでいます。

## Architecture

単一の Node プロセス（Hono）+ SQLite ファイル1つ（`node:sqlite`、依存ゼロ）。

- `src/types.ts` — **ドメイン型と同期プロトコルの正本**。`Intent`（クライアント→サーバーの意図）と `Op`（サーバー→クライアントの適用結果）を分けて定義している。
- `src/db.ts` / `src/schema.sql` — 接続（WAL + `foreign_keys=ON`）と DDL。`transact()` でトランザクションを張る。
- `src/store.ts` — 読み取りとボードの初期化。`loadBoard()` は 6 クエリでボード1つ分を丸ごと組み立てる（N+1 を作らない）。
- `src/ops.ts` — **すべての書き込みが通る唯一の場所**。`applyIntent()` が意図を1つ適用し、正規化済みの `Op` と採番済み `seq` を返す。
- `src/hub.ts` — WebSocket 接続の管理と `applyAndBroadcast()`。
- `src/api.ts` — Claude Code が叩く REST。仕様は `API.md`。
- `src/server.ts` — ルーター、認証、WebSocket の upgrade。
- `public/*.js` — クライアント。フレームワークなし。

### 絶対に守ること

**書き込みは必ず `applyIntent()` → `broadcast()` を通す。** ブラウザ（WebSocket）も Claude Code（REST）も同じ経路を通るので、API を叩いた瞬間に開いているブラウザが更新されます。これがこのアプリの体験の核です。`applyIntent()` を迂回する書き込みを足すと、開いている画面が黙ってズレます。

**`public/state.js` の `applyOp()` は `src/ops.ts` の `apply()` の鏡像です。** 片方の `Op` の形を変えたら、必ずもう片方も直すこと。

### データモデル

目的・機能・タスクは**すべて `nodes` という1本のツリー**に入り、**カンバンはそのビュー**です。二重管理はありません。

```ts
interface TaskNode {
  id; parentId;          // parentId === null がルート（＝目的）
  kind;                  // "goal" | "feature" | "task" — 表示ラベル。振る舞いには影響しない
  state;                 // "active" | "proposed"
  title; description;
  listId;                // カンバン列 = ステータス
  childIds; assigneeIds; // 人とチームは同じ id 空間に混在する
  dueDate; completedAt;  // completedAt は role="done" の列に在る間だけ入る
}
```

- **カンバンに並ぶのは葉ノードだけ**（`childIds.length === 0`）。親は「箱」であってカードではないので、子を1つ足した瞬間その親はカンバンから消えます。この絞り込みは**クライアント側の描画時**に行っています（`lists[].nodeIds` にはその列にいる active なノードが親子を問わず載る）。
- 順序は2系統あって独立に動きます: ツリー上の兄弟順（`tree_pos`）とカンバン列内の順序（`list_pos`）。どちらもグループ内 0..n-1 の連番で、移動のたびに再採番する素朴な方式です。
- 完了判定は**列 id ではなく `role === "done"`** で行います（旧 my-kanban は `"done"` という id をハードコードしていた）。

### 2段の承認ゲート（このアプリ固有の概念）

AI に作業させる前提なので、人間が止めるポイントが2種類あります。**混同しないこと。**

| | 何を止めるか | 実装 |
|---|---|---|
| 列の `role="awaiting_human"` | **作業の進行**。「作ったものを見てほしい」 | `lists.role`。既定は「レビュー待ち」「承認待ち」 |
| ノードの `state="proposed"` | **タスクの存在そのもの**。「このタスクでいいか見てほしい」 | `nodes.state`。ツリーに点線で出るが**カンバンには出ない** |

`POST /api/boards/:id/nodes` で投入されたノードは**既定で `proposed`** です（AI が勝手に作業キューを汚さないための安全弁）。

**不変条件: 親が `proposed` なら子も必ず `proposed`。** 両側から守っています。
- `approveNode` は対象だけでなく**祖先の `proposed` も一緒に** `active` にする。
- `addNode` は**親が `proposed` なら子の `state` 指定を無視して `proposed` に倒す**（API から崩せてしまうため）。

`approveNode` は「対象が既に `active` でも `recursive: true` なら配下の提案を承認する」挙動です。**承認済みの目的の下に AI が提案をぶら下げ、まとめて承認する**のが一番多い使い方なので、ここで打ち切ると主要導線が無反応になります。

逆向きの `unapproveNode`（`active` → `proposed`）もあり、**こちらは子孫の確定済みを必ず巻き込みます**（不変条件の裏返し）。承認が取り消せないとゲートが片道弁になり、「まとめて承認したあと一部だけ戻したい」ができなくなる — これは実際に運用して出てきた要求です。削除ではないので、再承認すれば列にも完了時刻にも戻ります。

### 同期プロトコル

接続時（と `{type:"resync"}` 要求時）に `{type:"state", board, seq}` で全体像を送り、以降は `{type:"op", seq, op}` で差分を配ります。`Op` は**受信メッセージのエコーではなく、実際に適用された正規化済みの結果**（id は採番済み、順序は解決済み、トグルは `present` で明示）。

クライアントは `seq` が期待どおり（`seq + 1`）のときだけ `applyOp` し、飛んだり当てられなかったりしたら `resync` して取り直します。`seq` は `boards.seq` に永続化されます。

`bulkAddNodes` のような糖衣は**複数の `addNode` Op に展開**して配信されます（クライアントの `applyOp` に特別扱いを増やさないため）。`Op` union に `bulkAddNodes` は存在しません。

### 並び順は index ではなく `beforeId`

**挿入位置は「この id の直前に置く」（末尾なら `null`）で送ります。** 旧 my-kanban は DOM 上の index で送っていて、そのせいで「フィルタで非該当カードを隠さず薄く表示する」という制約を背負っていました（隠すと index がズレるため）。ツリーの絞り込みではこれがもっと効いてくるので、方式を変えてあります。新しい並べ替え UI を足すときも index で送らないこと。

### クライアントの作法

- **全再描画**。状態が変わるたびに DOM を作り直します（差分更新はしない）。
- したがって**開いている popover / modal はモジュール変数に持ち、`render()` の末尾で `renderXxx()` を再実行して復元**します。この作法を外すと、他クライアントの Op が1つ届いただけで開いていた UI が消えます。ポップオーバーのアンカーは**参照ではなくセレクタで毎回引き直す**こと（対象が消えたら自分で閉じられる）。打ちかけの入力は `data-keep` 属性で退避・復元します（`public/modals.js` の `captureFields` / `restoreFields`）。
- **楽観更新しない**。操作は意図を送るだけで、画面が変わるのは Op が返ってきてから。
- **CSS のクラス名が DOM の契約**です（`public/board.css` / `tree.css`）。新しいクラス名を発明する前に、既にあるものを探すこと。
- カードもリストもツリー行も `draggable` なので、**入れ子の要素の `dragstart` では必ず `e.stopPropagation()`** を呼ぶこと。これを忘れて親の要素のドラッグとして誤解釈されるのは、旧実装で実際に起きたバグです。
- モジュール構成: `state.js`（状態と `applyOp`、他の `public/*.js` を import しない）← `ws.js` / `kanban.js` / `tree.js` / `modals.js` ← `app.js`。循環を避けるため、再描画は `state.js` の `onRender()` / `rerender()` フック経由で行います。

## Known gaps

期限通知（Discord）と完了ノードの自動削除は**未実装**（旧 my-kanban にはあった）。親ステータスの自動ロールアップも無く、ツリーに `3/7` の進捗を出すだけです。コメント・変更履歴は無し。モバイル未対応。認証はデプロイ全体で共有の `PASSPHRASE` 1本（未設定なら認証なし）。

**新しい機能に手をつける前に `todo.md` を読んでください。** 実装中に見つかった細かい課題と、「やらないと決めたこと」（Cloudflare への再展開、サーバー側で LLM を呼ぶこと）もそこに書いてあります。

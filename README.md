# ai-kanban

AI との協働を前提にしたツリー型カンバン。ローカルで動く Node + SQLite の1プロセスです。

**ハイレベルな目的を放り込む → ローカルの Claude Code が細分化してツリーに投入する → 人間が承認する → カンバンで進める**、という流れのために作られています。

## 3つの見方、1つのデータ

```
目的の入力                     ツリー                          カンバン
┌──────────────┐    認証基盤をつくる               ToDo    進行中   レビュー待ち⚠
│ 認証基盤を    │     ├─ セッション管理            ┌────┐  ┌────┐  ┌────┐
│ つくりたい    │ ─→  │   ├─ HMAC クッキー    ─→  │HMAC│  │有効│  │リセ│
│ ...          │     │   └─ 有効期限の設計        └────┘  └────┘  └────┘
└──────────────┘     └─ パスワードリセット
```

目的・機能・タスクは**すべて同じ1本のツリー**（`nodes` テーブル）に入っていて、カンバンはそのツリーの**ビュー**です。二重管理はありません。カンバンに並ぶのは**葉ノード**（子を持たないノード＝実作業の単位）だけで、親は「箱」として扱われます。

## クイックスタート

```bash
npm install
npm run dev     # http://localhost:3000
```

Node 24 以上が必要です（`node:sqlite` とネイティブの型ストリップを使うため）。**ビルドステップはありません** — `.ts` をそのまま実行し、クライアントは素の ESM です。

データは `data/kanban.db`（SQLite ファイル1つ）に入ります。

## Claude Code から使う

REST API を叩くと、**開いているブラウザが即座に更新されます**（サーバーが全接続に差分をブロードキャストするため）。

```bash
# まだ細分化されていない目的を探す
curl -s localhost:3000/api/boards/myboard/goals?undecomposed=1

# 細分化結果を入れ子のまま投入する（既定で「未承認の提案」として入る）
curl -sX POST localhost:3000/api/boards/myboard/nodes \
  -H 'content-type: application/json' \
  -d '{"parentId":"<goalId>","nodes":[{"title":"セッション管理","kind":"feature",
       "children":[{"title":"HMAC クッキーの実装"}]}]}'

# 人間の対応待ちで止まっているものを確認する
curl -s localhost:3000/api/boards/myboard/awaiting
```

**サーバーは LLM を呼びません。** 細分化の知能はローカルの Claude Code 側にあります。詳細は [API.md](./API.md)。

Claude Code 用の skill を `~/.claude/skills/ai-kanban/` に置いてあります（このリポジトリの外です）。どのプロジェクトで作業していても「カンバンに積んで」で使えるように personal skill にしてあるので、API の使い方や「AI がやらないこと」を変えたときはそちらも直してください。

## 2段の承認ゲート

AI に作業させる前提なので、人間が判断するポイントが2種類あります。

| | 何を止めるか | どう表れるか |
|---|---|---|
| **列の role** `awaiting_human` | 作業の進行 | 「レビュー待ち」「承認待ち」列に置かれたタスク。`GET /awaiting` に出る |
| **ノードの state** `proposed` | タスクの存在そのもの | AI が生やしたタスクは未承認。ツリーに点線で現れ、**カンバンには出ない**。承認して初めて作業対象になる |

前者は「作ったものを見てほしい」、後者は「そもそもこのタスクでいいか見てほしい」です。

## 設定

`.env`（`.env.example` をコピー）で設定します。

| 変数 | 既定 | 意味 |
|---|---|---|
| `PORT` | `3000` | 待ち受けポート |
| `DB_PATH` | `./data/kanban.db` | SQLite ファイルの場所 |
| `PASSPHRASE` | 未設定 | **未設定なら認証は完全に無効**（ローカル利用の既定）。設定するとブラウザはログイン画面、API は `Authorization: Bearer <値>` が必要になる |

## 構成

```
src/
  schema.sql  db.ts        SQLite（node:sqlite、依存ゼロ）
  types.ts                 ドメイン型と同期プロトコルの正本
  store.ts                 読み取りとボードの初期化
  ops.ts                   ★ 全ての書き込みが通る唯一の場所
  hub.ts                   WebSocket 接続とブロードキャスト
  api.ts                   Claude Code が叩く REST
  server.ts  pages/        Hono のルーターとページシェル
public/
  state.js                 ボードのローカルコピーと applyOp（ops.ts の鏡像）
  ws.js  app.js            同期とエントリポイント
  kanban.js  tree.js       2つのビュー
  modals.js                モーダル・ポップオーバー群
```

`ai-kanban` は [my-kanban](../my-kanban)（Cloudflare Workers + Durable Object 版）から、クライアントの作法とデータモデルの考え方を引き継いでいます。

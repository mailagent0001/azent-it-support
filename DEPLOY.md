# A-Zent IT保守サブスク デプロイ手順

## 事前準備(PCに1回だけ)

```bash
npm install -g wrangler
wrangler login   # ブラウザが開くのでCloudflareアカウントでログイン
```

---

## 手順1: D1データベースを作成する

```bash
wrangler d1 create azent-support-db
# → 表示された database_id を wrangler.toml の REPLACE_WITH_YOUR_D1_DATABASE_ID に貼る

wrangler d1 create azent-support-db-staging
# → ステージング側のIDも同様に貼る
```

---

## 手順2: テーブルとサンプルデータを投入する

```bash
# ステージング(テスト用)に先に流す
wrangler d1 execute azent-support-db-staging --env staging --file=0001_initial.sql

# 問題なければ本番にも流す
wrangler d1 execute azent-support-db --file=0001_initial.sql
```

---

## 手順3: Secrets(機密情報)を設定する

```bash
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
# → LINEのチャネルアクセストークンを貼り付け

wrangler secret put LINE_CHANNEL_SECRET
# → LINEのチャネルシークレットを貼り付け

wrangler secret put AZENT_ADMIN_LINE_ID
# → 自分のLINEユーザーID(全業者未応答時にここへ通知が来る)
```

---

## 手順4: デプロイする

```bash
wrangler deploy --env staging   # ステージング先にデプロイ
wrangler deploy                  # 本番デプロイ
# → https://azent-it-support.YOUR_SUBDOMAIN.workers.dev が発行される
```

---

## 手順5: 動作確認

```bash
curl https://azent-it-support.YOUR_SUBDOMAIN.workers.dev/health
# → {"status":"ok","timestamp":"..."}が返れば成功
```

---

## 手順6: LINE Webhook URLを設定する

LINE Developersコンソール → Messaging API設定 → Webhook URL:
- 顧客用: `https://azent-it-support.YOUR_SUBDOMAIN.workers.dev/webhook/line`
- 業者用: `https://azent-it-support.YOUR_SUBDOMAIN.workers.dev/webhook/vendor`

「Webhookの利用」をONにして「検証」を押し、200 OKが返れば完了。

---

## 手順7: 実機テスト

```bash
# 自分のLINEユーザーIDをサンプル会社に登録
wrangler d1 execute azent-support-db \
  --command="UPDATE companies SET approver_line_id='自分のLINE_USER_ID' WHERE company_id='C001'"
```

LINE公式アカウントを友だち追加して「プリンタで紙が詰まりました」と送信 → 自動返信が来れば完成。

---

## ファイル構成

```
CloudflareWorkers_ソースコード/
├── wrangler.toml        デプロイ設定
├── DEPLOY.md            この手順書
├── 0001_initial.sql     DB初期構築SQL
├── index.js             エントリーポイント・ルーティング
├── matchEngine.js       照合エンジン
├── approvalEngine.js    承認判定エンジン
├── lineClient.js        LINEクライアント
└── dispatcher.js        業者ディスパッチ・タイムアウト管理
```

---

## よくあるエラー

| エラー | 原因 | 対処 |
|---|---|---|
| `database_id not found` | wrangler.tomlのIDが仮のまま | D1作成後に正しいIDに書き換える |
| `401 Unauthorized` | LINE secretが未設定 | `wrangler secret put LINE_CHANNEL_SECRET` |
| ヘルスチェックが返らない | デプロイ未完了 | `wrangler deploy`を再実行 |
| Cronが動かない | wrangler.tomlの`[triggers]`を確認 | |

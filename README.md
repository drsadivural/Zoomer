# Ayonix Zoomer

オンライン研修における本人確認・継続認証・受講状況監視を自動化する、Ayonixブランドの運用システムです。

**本番環境: https://zoomer.ayonix.com**

---

## 1. 設計方針（重要）

通常のZoomミーティング画面から第三者サービスが全参加者の生映像を任意取得する設計にはしていません。

- **Zoomから取得するもの**: 研修予定、ミーティングID、開催状態、参加者名簿（参加・退出）
- **Zoomから取得しないもの**: 参加者の映像・音声
- **カメラ映像**: 受講者がZoomと併用して開く「Zoomer受講画面」で、**明示的な同意の下に本人のカメラのみ**を利用

顔の解析は原則として受講者の端末内で実行し、サーバーへ送るのは判定メタデータと、
ルールに合致したときの最小限の証跡画像だけです。

## 2. アーキテクチャ

```
受講者ブラウザ (Zoom + Zoomer受講画面)
  └─ 端末内 顔検出・特徴量抽出・閉眼/複数人判定
       ├─ 判定メタデータ ──► Cloudflare Workers API ──► D1 (APAC)
       ├─ 顔特徴量(照合時) ─► サーバー側で1:1照合（テンプレートは端末へ渡さない）
       └─ 証跡画像(該当時) ─► R2 (AES-256-GCM 暗号化, APAC)

Zoom ──(OAuth / 署名付きWebhook)──► Workers API ──► Durable Object ──► 管理ダッシュボード
```

| 層 | 実装 |
|---|---|
| フロントエンド | React 19 + Vite + Tailwind v4 + shadcn/ui |
| API | Cloudflare Workers + Hono |
| DB | Cloudflare D1（APACリージョン）+ Drizzle ORM |
| 証跡ストレージ | Cloudflare R2（APACリージョン、暗号化保存） |
| リアルタイム | Durable Object（WebSocket、カーソル付き再接続） |
| 顔認識 | 端末内推論（`FaceEngine` 差し替え可能） |

### 顔認識エンジンについて

既定の実装は **face-api.js（tiny detector + 68 landmarks + 128次元記述子）** を
自己ホストしたモデル重みで動かします（`public/models/`、外部CDNへの通信なし）。

`src/lib/face/engine.ts` の `FaceEngine` インターフェースを実装し `ENGINE_ID` を
変更すれば、**Ayonix SDK へ差し替え**られます。アプリの他の部分に変更は不要です。
サーバーは `engine` が登録時と異なる照合を拒否するため、記述子空間の取り違えは起きません。

## 3. セットアップ

```bash
pnpm install          # または npm install
cp .env.example .dev.vars   # 値を設定
npm run db:migrate:local
node scripts/make-seed.mjs  # 管理者パスワードを生成
npm run seed:local
npm run dev
```

### 必要なシークレット

| 名前 | 用途 |
|---|---|
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | Zoom OAuth |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | Webhook署名検証 |
| `DATA_ENCRYPTION_KEY` | 顔特徴量・OAuthトークン・証跡画像の暗号化（base64 32バイト） |
| `SESSION_SIGNING_KEY` | セッションCookie・受講リンク・署名URL（base64 32バイト） |

```bash
openssl rand -base64 32   # 鍵の生成
npx wrangler secret put DATA_ENCRYPTION_KEY
```

## 4. Zoom連携の設定

Zoom Marketplace → 対象アプリ に、以下を**完全一致**で登録します。
一致しない場合、認可時に `4700 Invalid redirect` になります。

| 項目 | 値 |
|---|---|
| OAuth Redirect URL | `https://zoomer.ayonix.com/api/v1/integrations/zoom/oauth/callback` |
| OAuth Allow List | `https://zoomer.ayonix.com` |
| Event notification endpoint URL | `https://zoomer.ayonix.com/api/v1/webhooks/zoom` |

購読イベント: `meeting.started` / `meeting.ended` /
`meeting.participant_joined` / `meeting.participant_left`

必要スコープ: `meeting:read:meeting`, `meeting:read:list_meetings`,
`meeting:read:participant`, `user:read:user`

設定後、管理画面の **設定 → Zoom連携 → Zoomアカウントを接続** を実行します。

### 参加者の照合方法

Zoom参加者を受講者へ紐付ける優先順位:

1. **メールアドレス完全一致**（確度 1.0）
2. **表示名に含まれる受講者ID**（確度 0.95）— 組織の実際のID一覧と突合します
3. **氏名の一意一致**（確度 0.8、全角/半角・空白差を吸収）
4. **氏名の部分一致**（確度 0.6）

いずれにも当てはまらない参加者も**破棄せず記録**し、管理画面から手動で割り当てられます。
同名が複数いる場合は自動では決めず、候補を提示します。

## 5. 運用フロー

1. **受講者登録** — 個別登録またはCSV一括取込。顔画像から特徴量を抽出（品質判定つき）
2. **研修作成** — Zoomミーティングと紐付け、受講者を割当、受講者ごとの受講リンクを発行
3. **受講者** — 受講リンク → 同意 → カメラ → ライブネス → 1:1本人確認 → 継続監視
4. **管理者** — ライブ監視でZoom参加者・本人確認状態・アラートを確認、レビュー
5. **証跡** — イベント・画像を検索、CSV出力、保存期限後に自動削除

## 6. セキュリティ

- 顔特徴量・OAuthトークン・証跡画像は **AES-256-GCM** で暗号化して保存
- **登録テンプレートはブラウザへ送信しません**。1:1照合はサーバー側で実行するため、
  改ざんしたクライアントが「一致した」と主張しても通りません
- 証跡画像は **60秒で失効する署名URL** 経由のみ。閲覧・出力・削除はすべて監査ログへ記録
- 監査ログに顔特徴量・画像URL・トークンは記録しません（`worker/lib/audit.ts` で除去）
- 全業務テーブルに `organization_id`。`X-Organization-Id` がトークンと不一致なら 403
- 変更系APIは `Idempotency-Key` 対応（同一キー・異内容は 409）
- CSV出力は数式インジェクション対策済み（`= + - @` 等を無害化）
- **居眠りは「疑い」**として扱い、自動判定のみで受講不可としません

### 既知の制約

- Cloudflare WorkersのWebCryptoは **PBKDF2 の反復回数を100,000までしか許容しません**。
  ローカルパスワードはブートストラップ用途に留め、本番はSSO＋MFAを前提としてください。
- ライブネスは瞬きと自然な動きによる一次防御です。写真・画面再生・マスクに対する
  評価（`docs/TEST_PLAN.md` §2）を実施してから本番採用してください。
- 遮蔽度は検出スコアからの**代理指標**であり、直接の遮蔽測定ではありません。
- **しきい値はサンプル値です。** 本番値は顧客データでのFAR/FRR測定から決めてください。

## 7. テスト

```bash
npm test                       # 単体テスト（111件）
node scripts/e2e.mjs <baseUrl> <email> <password> <webhookSecret>   # 統合テスト（97項目）
```

統合テストは、署名付きZoom Webhookによる参加者認識、1:1照合、ルール判定による
アラート生成、権限分離、冪等性、監査ログの健全性までを実環境に対して検証します。

## 8. デプロイ

```bash
npm run db:migrate:remote
npm run deploy
```

## 9. ドキュメント

- `docs/PRODUCT_SPEC_JA.md` — 製品要件
- `docs/ARCHITECTURE.md` — アーキテクチャ
- `docs/API_CONTRACT.md` — API契約
- `docs/SECURITY_PRIVACY.md` — セキュリティ・プライバシー設計
- `docs/TEST_PLAN.md` — テスト・受入計画
- `docs/OPERATIONS.md` — 運用手順（バックアップ・削除・資格情報ローテーション）

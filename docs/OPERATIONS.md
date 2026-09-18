# 運用手順

対象環境: Cloudflare Workers (`ayonix-zoomer`) / D1 `ayonix-zoomer` / R2
`ayonix-zoomer-evidence`・`ayonix-zoomer-reports`（いずれもAPACリージョン）。

## 1. デプロイ

```bash
npm test                        # 単体テスト
npm run db:migrate:remote       # マイグレーション
npm run deploy                  # ビルド + wrangler deploy
node scripts/e2e.mjs https://zoomer.ayonix.com <admin> <password> <webhookSecret>
```

ロールバックは Cloudflare ダッシュボードの Workers → Deployments から、
直前のバージョンIDを選択して行います。

## 2. バックアップ

### D1

D1 は Time Travel により**過去30日間の任意時点へ復元**できます。

```bash
# 復元可能な時点の確認
npx wrangler d1 time-travel info ayonix-zoomer

# 特定時刻へ復元（本番は必ず事前にエクスポートを取得）
npx wrangler d1 time-travel restore ayonix-zoomer --timestamp=<ISO8601>
```

定期エクスポート（日次を推奨）:

```bash
npx wrangler d1 export ayonix-zoomer --remote --output=backup-$(date +%F).sql
```

エクスポートには顔特徴量の暗号文が含まれます。**暗号鍵とは別の場所に保管**してください。
鍵とバックアップが同じ場所にあると、暗号化の意味が失われます。

### R2

証跡バケットはバージョニングを有効にし、ライフサイクルルールで
保存期間＋猶予期間の経過後に完全削除します。R2 のデータは
アプリ側でも暗号化済みのため、バケットの複製単体では平文になりません。

## 3. データ削除

### 保存期限による自動削除

毎時のCronトリガー（`0 * * * *`）が `evidence_objects.expires_at` を過ぎた
オブジェクトをR2から削除し、行に `deleted_at` と削除理由を記録し、
監査ログへ `evidence.purge` を残します。

### 受講者からの削除要求

1. 受講者を特定（受講者ID／メール）
2. 管理画面から受講者を削除 → 顔特徴量が論理削除され、以後の照合に使われなくなります
3. 当該受講者の証跡を削除する場合は、対象研修を特定して個別に削除
4. D1 Time Travel の保持期間（30日）とR2バージョニングの猶予が過ぎるまで、
   バックアップ上には残存します。**削除完了とみなせる時点を要求元へ明示**してください
5. 削除の受理・承認・実行・バックアップ失効を監査ログと運用記録に残します

```bash
# 特定受講者の証跡を確認（削除前の影響確認）
npx wrangler d1 execute ayonix-zoomer --remote --command="
  select e.id, e.session_id, e.captured_at, e.expires_at
  from evidence_objects e
  join session_participants sp on sp.id = e.participant_id
  where sp.trainee_id = '<trainee_id>' and e.deleted_at is null;"
```

## 4. 障害復旧

| 症状 | 確認 | 対応 |
|---|---|---|
| 全面的に 5xx | `wrangler tail ayonix-zoomer` | 直前バージョンへロールバック |
| ログインのみ失敗 | tail で `Pbkdf2 failed` を確認 | パスワードハッシュの反復回数が100,000超。`scripts/make-seed.mjs` で再生成 |
| Zoom参加者が反映されない | 管理画面 設定 → Zoom連携の状態 | Webhook URL・Secret Token・購読イベントを確認。復旧後は「Zoom参加者を同期」で取りこぼしを回収 |
| Webhookが401 | tail で `signature rejected` | Secret Token の不一致。Marketplaceの値とWorkersシークレットを再同期 |
| 証跡が表示できない | 監査ログの `evidence.url.issue` | 署名URLは60秒で失効。再発行する |
| リアルタイム更新が止まる | ブラウザのWebSocket状態 | 管理画面は15秒間隔のポーリングに自動フォールバックするため、状態自体は失われません |

Webhookは at-least-once かつ取りこぼしの可能性があるため、**名簿の正はZoom API側**です。
障害後は必ず「Zoom参加者を同期」を実行してください。

## 5. 資格情報のローテーション

### Zoom（Client Secret / Secret Token）

1. Zoom Marketplace で新しい値を発行
2. `npx wrangler secret put ZOOM_CLIENT_SECRET`（および `ZOOM_WEBHOOK_SECRET_TOKEN`）
3. `npm run deploy`
4. 管理画面から Zoom を再接続（リフレッシュトークンが無効化されるため）
5. `/api/v1/health` で `zoom.configured` と `webhookConfigured` を確認

### SESSION_SIGNING_KEY

**影響**: 全管理者セッション、発行済みの受講リンク、未使用の署名URLが即座に無効化されます。
研修時間外に実施してください。ローテーション後は受講リンクを再発行します。

### DATA_ENCRYPTION_KEY

**単純な差し替えは不可**です。この鍵は保存済みの顔特徴量・OAuthトークン・証跡画像を
復号する唯一の手段であり、差し替えると既存データが復号不能になります。

再暗号化の手順:

1. 研修が実施されていない時間帯を確保
2. D1 と R2 をエクスポート
3. 旧鍵で復号 → 新鍵で再暗号化する移行スクリプトを、対象3種
   （`face_enrollments`、`integrations`、`evidence_objects`）すべてに対して実行
4. 新鍵を設定してデプロイ
5. 本人確認・証跡表示・Zoom再接続を実機で確認
6. 旧鍵を破棄

鍵が失われた場合、顔特徴量は復旧できません。受講者の再登録が必要です。

## 6. 監視すべき指標

- API の P95 応答時間（画像取得を除き 500ms 未満）
- アラート反映時間（検知確定から3秒以内）
- Webhook の 401 発生率（署名不一致＝設定ずれの兆候）
- `monitoring_events.quarantined` の件数（異常なクライアント挙動の兆候）
- `evidence.purge` の日次件数（0が続く場合は保持ジョブの停止を疑う）
- 誤検知率（`alert_reviews.reason_code` の集計）

## 7. 定期作業

| 周期 | 作業 |
|---|---|
| 日次 | D1 エクスポート、Webhook 401 の確認 |
| 週次 | 誤検知理由の集計、しきい値の妥当性レビュー |
| 月次 | 削除ジョブの実行状況確認、権限棚卸し |
| 四半期 | 資格情報ローテーション、FAR/FRR 再測定、復旧訓練 |

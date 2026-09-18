# Ayonix Zoomer API契約

Base path: `/api/v1`

## 認証・共通規則

- OIDC Bearer Token
- `X-Organization-Id` はトークンの所属組織と一致必須
- 変更系APIは `Idempotency-Key` を必須化
- エラー形式: `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`
- 顔特徴量・画像・署名URLをAPIログへ出力しない

## 主要エンドポイント

| Method | Path | Purpose |
|---|---|---|
| POST | `/trainees` | 受講者作成 |
| POST | `/trainees/import` | CSV一括登録 |
| POST | `/trainees/{id}/enrollments` | 顔登録開始・品質判定 |
| DELETE | `/trainees/{id}/enrollments/{enrollmentId}` | 顔登録の論理削除 |
| POST | `/sessions` | 研修作成 |
| POST | `/sessions/{id}/participants` | 受講者割当 |
| POST | `/sessions/{id}/precheck` | 開始前本人確認 |
| POST | `/sessions/{id}/events` | 端末判定イベント送信 |
| GET | `/sessions/{id}/monitor` | 現在の監視状態取得 |
| GET | `/sessions/{id}/events` | イベント検索 |
| PATCH | `/alerts/{id}` | 確認・誤検知・担当割当 |
| GET | `/evidence/{id}/download-url` | 短時間署名URL取得 |
| POST | `/reports` | 監査レポート生成 |
| GET | `/reports/{id}` | 生成状態・取得URL |
| GET/PUT | `/settings/monitoring` | 検知ルール取得／更新 |

## イベント送信例

```json
{
  "eventId": "evt_01J5Y3M9VJ40P73TKXYG6C8N6Z",
  "sessionId": "ses_01J5Y1X2QD8Z7XW9QPBW4SZTNT",
  "participantId": "sp_01J5Y2K1PXV3H2TZM0MQ2J9N2S",
  "capturedAt": "2026-09-17T01:42:16.241Z",
  "type": "FACE_ABSENT",
  "severity": "WARNING",
  "durationMs": 62000,
  "faceCount": 0,
  "matchScore": null,
  "qualityScore": 0.91,
  "modelVersion": "ayonix-monitor-3.2.0",
  "ruleVersion": "org_001:17",
  "evidenceRequested": true
}
```

## サーバー検証

- UUID/ULID形式、時刻の許容ずれ、組織・研修・参加者の関連を検証
- 同一 `eventId` は冪等処理
- 端末署名と短命セッショントークンを検証
- 不可能な順序や急激なイベント量を拒否または隔離
- アラート確定はクライアント申告だけでなくサーバールールで再評価

## リアルタイムイベント

Channel: `organization/{organizationId}/session/{sessionId}`

- `participant.status.changed`
- `alert.created`
- `alert.updated`
- `session.metrics.updated`
- `participant.disconnected`

再接続時は `GET /sessions/{id}/monitor?since=<cursor>` で欠落を回復します。

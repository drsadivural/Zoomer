# Zoom Organizer Intelligence Layer

An **additive** layer over Ayonix Zoomer that turns the product into the Zoom
organizer's real-time monitoring, identity-verification, presence and reporting
console. Zoom remains the meeting, audio, video, chat and screen-share
application; Ayonix Zoomer observes it and answers one question quickly:

> **Who currently requires my attention?**

Nothing in the original product was removed, renamed or re-pointed. Every
existing route, API, table, permission, screen and deployment setting still
behaves exactly as it did — see [Compatibility](#1-compatibility-what-was-preserved).

---

## Contents

1. [Compatibility: what was preserved](#1-compatibility-what-was-preserved)
2. [Architecture](#2-architecture)
3. [The signal vocabulary](#3-the-signal-vocabulary)
4. [New functionality](#4-new-functionality)
5. [Database](#5-database)
6. [API reference](#6-api-reference)
7. [Zoom integration](#7-zoom-integration)
8. [Local simulation](#8-local-simulation)
9. [Environment variables](#9-environment-variables)
10. [Testing](#10-testing)
11. [Deployment](#11-deployment)
12. [Security review](#12-security-review)
13. [Privacy and retention](#13-privacy-and-retention)
14. [Known Zoom limitations](#14-known-zoom-limitations)
15. [Future Video SDK migration path](#15-future-video-sdk-migration-path)
16. [File manifest](#16-file-manifest)

---

## 1. Compatibility: what was preserved

The audit below was taken before any change and re-verified afterwards in a real
browser (`33/33` interaction checks) and by the test suite (`284/284`).

| Area | Before | After | Verified by |
|---|---|---|---|
| Routes | `/`, `/monitor`, `/sessions`, `/enroll`, `/logs`, `/settings`, `/join/:participantId` | identical, plus 4 new | browser drive |
| Navigation | 6 items | same 6, in the same order, plus 4 | browser drive |
| APIs | `/api/v1/{auth,dashboard,trainees,sessions,alerts,evidence,reports,settings,audit,monitor,bot,trainee,integrations/zoom,webhooks/zoom}` | unchanged, plus `/api/v1/meetings` | route table diff |
| `POST /api/v1/bot/ingest` | trainee-style event pipeline | **byte-identical behaviour**; `/bot/observe` added alongside | tests |
| Database | 20 tables | same 20 untouched, plus 7 new | migration is `CREATE`-only |
| Auth / RBAC | 3 roles, 17 permissions | same roles, same permissions, plus `monitoring:read` / `monitoring:write` | `tests/permissions.test.ts` |
| Alerts | one inbox (`alerts`) | same inbox; organizer events escalate **into** it | DB join check |
| Evidence | encrypted R2 + 60 s signed URLs + retention purge | unchanged and reused for snapshots | code reuse |
| Realtime | `SessionHub` DO, 5 event types | same DO, same 5 types, plus 4 | union extension |
| Settings | 検知ルール (`monitoring_settings`, own version counter) | untouched; 会議モニタリング added as a separate card and table | browser drive |
| Deployment | Cloudflare Worker + D1 + R2 + DO + hourly cron | unchanged; cron gained a second purge task | `wrangler.jsonc` diff |
| Trainee flow | `/join/:participantId`, precheck, reauth, events | entirely untouched | route diff |

### Two pre-existing defects fixed in passing

Both were hit while verifying this work, and both would have kept biting:

1. **`npm run build` emitted `.js` next to every `.tsx`.** The script was
   `tsc -b --noEmit false --emitDeclarationOnly false 2>/dev/null; vite build`,
   which wrote 148 compiled files into `src/` and `worker/`. Vite resolves
   `@/screens/admin/LiveMeeting` to the stale `.js` before the `.tsx`, so the
   dev server silently served **old code** after any build — this cost real
   debugging time before it was identified. The script is now
   `tsc --noEmit && vite build`, the artifacts are deleted, and `.gitignore`
   blocks them. The three type errors the old script was swallowing
   (`2>/dev/null`) are fixed, so the typecheck can now actually gate the build.
2. **The UI's permission matrix was a copy-paste of the server's** inside
   `auth-context.tsx`, and drifted the moment a permission was added: the
   organizer console's controls vanished for an admin who genuinely had the
   right. It now lives in `src/lib/permissions.ts` and
   `tests/permissions.test.ts` asserts the two are identical role-for-role.

---

## 2. Architecture

```
Zoom Meeting
     │  participant events · media events · video · (transcript, optional)
     ▼
Zoom Integration Layer            worker/integrations/zoom/
     ├── adapter.ts               ZoomMediaAdapter interface + factory
     ├── meeting-sdk.ts           PUSH  — the C++ bot posts analysed frames
     ├── rtms.ts                  PUSH  — Realtime Media Streams (scaffold)
     ├── mock.ts                  LOCAL — deterministic simulator
     ├── participant-events.ts    identity resolution, rejoin detection
     ├── media-events.ts          camera/mic/speaking → observations
     └── reconnect.ts             backoff, DEGRADED state, heartbeat staleness
     ▼
Participant State Service         worker/services/analysis/participant-state.ts
     │  pure reducer: (state, observation, config) → (state, change)
     ▼
Analysis Scheduler                worker/services/analysis/{scheduler,priority-queue}.ts
     │  HOT / WARM / NORMAL + priority heap → GET /meetings/:id/analysis/plan
     ▼
Ayonix Vision Pipeline            (runs OFF Cloudflare: bot on a GPU host, or the browser)
     │  detect · recognise · track · count · landmarks · head pose · gaze · quality
     ▼
Event Engine                      worker/services/events/*
     │  temporal persistence · gates · dedupe · open/resolve · escalation
     ▼
Durable Object (SessionHub)       worker/do/session-hub.ts      ← "Redis" in the spec
     │  WebSocket fan-out + bounded replay buffer
     ▼
Organizer Dashboard               src/screens/admin/LiveMeeting.tsx + components/meeting-monitoring/
```

### Where the spec was adapted to the existing architecture

The instruction was to preserve the existing architecture and adapt the design
to it. Four places where that mattered:

| Spec says | This codebase | Resolution |
|---|---|---|
| Redis for realtime state | Durable Objects (`SessionHub`) | DO **is** the realtime tier; it already does fan-out with a replay cursor. No Redis added. |
| PostgreSQL | D1 (SQLite) | Kept D1. New tables follow the existing tenancy and epoch-millis conventions. |
| `src/services/…`, `src/api/…` | backend lives in `worker/` | Same conceptual structure under `worker/services/` and `worker/integrations/`. |
| A `participant_events` table | `monitoring_events` + `alerts` already exist | Added `participant_engagement_events` for open/close engagement state, and **escalate into the existing `alerts` inbox** rather than creating a second one. |

### The scheduler's placement

Cloudflare Workers cannot hold a Zoom media session or run a GPU model, and the
spec explicitly forbids forcing GPU work onto them. So the **policy** lives in
the Worker as a pure function, and the **work** happens wherever the frames are:

- the analysis worker polls `GET /api/v1/meetings/:id/analysis/plan`;
- the plan names exactly who to analyse, at what FPS, and why;
- results come back via `POST /api/v1/bot/observe`.

This is what keeps a 200-person meeting inside one GPU's budget: in a healthy
room almost everyone is `NORMAL` (one analysis per 10 s), and inference is spent
on the handful who are `HOT`.

---

## 3. The signal vocabulary

Defined once in `worker/services/monitoring/signals.ts`, mirrored for the UI in
`src/lib/meeting/signals.ts`.

**Engagement states** — `SCREEN_FACING`, `LOOKING_LEFT`, `LOOKING_RIGHT`,
`LOOKING_UP`, `LOOKING_DOWN`, `FACE_NOT_VISIBLE`, `CAMERA_OFF`,
`MULTIPLE_FACES`, `IDENTITY_MISMATCH`, `LOW_CONFIDENCE`, `UNKNOWN`.

**Identity** — `VERIFIED`, `UNVERIFIED`, `MISMATCH`, `NO_FACE`,
`MULTIPLE_FACES`, `LOW_CONFIDENCE`, `UNKNOWN`.

**Head pose** — `FORWARD`, `LEFT`, `RIGHT`, `UP`, `DOWN`, `UNKNOWN`.

The product **never** claims to know whether someone is listening. There is no
"bored", "distracted", "attentive" or "engaged" anywhere in the data model, the
API or the interface, and the participant drawer and every report carry that
statement in writing. Two consequences that are easy to get wrong and are
enforced in code:

- **`SCREEN_FACING` is geometry, not attention.** It says a face is oriented at
  the camera. `docs` and UI copy say exactly that.
- **Below-threshold recognition is `UNVERIFIED`, never `MISMATCH`.** A mismatch
  requires recognising a *different enrolled person* above the threshold. "We
  could not confirm" and "this is somebody else" are different accusations.

---

## 4. New functionality

### Analysis lifecycle
Start/stop an analysis run per meeting, with an adapter choice
(`MEETING_SDK` / `RTMS` / `MOCK`). A run whose worker stops sending heartbeats
is reported `DEGRADED` — the grid keeps its last known state, clearly labelled
stale, rather than pretending to be live.

### Participant state
One denormalised row per participant (`participant_analysis_state`): camera,
microphone, speaking, face count, face box, identity, head pose, screen-facing
probability, committed engagement state, scheduler tier and analysis freshness.
The grid reads this table alone — one indexed query for 200 people.

### Temporal persistence
No state is believed on one frame. A candidate must hold for `transientSec`
(default 3 s) before it is committed, and when it is, the committed state is
**back-dated** to when the candidate first appeared — so "face missing for 30 s"
means thirty seconds of missing face, not thirty seconds since we made up our
mind. `CAMERA_OFF` and `IDENTITY_MISMATCH` bypass the delay: the first is a
discrete Zoom fact, the second is the one signal an organizer must see at once.

### Screen-facing estimation
Cosine falloff on head pose (1.0 head-on, ~0.9 at 25°, 0 at 90°) blended with
iris offset when the provider supplies it, then exponentially smoothed with a
confidence that grows over the first five samples. A single 45° glance does not
move the state — verified by test.

### Identity verification with cache invalidation
A verification is cached for `identityCacheSec` (default 10 min) and voided by:
rejoin, a second face, a camera-source change, a long absence, confidence below
threshold, or a previous mismatch (never cached). Every decision — including the
failures — is written to `identity_verifications`.

### Event engine
States raise events only after a per-event gate, are de-duplicated by
`(participant, condition)` while open, get a re-open cool-off so a flickering
detector cannot machine-gun the organizer, and **always resolve**. A prolonged
condition raises its own event (`FACE_MISSING` → `LONG_ABSENCE`) so the timeline
shows both onset and escalation. Only `IDENTITY_MISMATCH`, `MULTIPLE_FACES` and
`LONG_ABSENCE` are promoted into the existing alert inbox.

### Organizer console
- **ライブ会議** — status strip, 6 KPI cards, an attention strip naming the
  people who need a decision, a virtualised participant grid, filters, search,
  4 sort orders, and a live event feed.
- **参加者** — the same state as a dense, sortable, exportable table.
- **イベント** — the event feed with category and open/resolved filters.
- **レポート** — meeting summary + per-participant analytics, CSV / JSON / PDF.
- **Participant drawer** — live metrics, zoomable timeline (5/15/30 min/full),
  recent events, identity history with thresholds.

### Performance
The grid measures its container, derives the column count, and renders only the
visible rows plus a two-row overscan; cards are memoised on the fields they
render and the relative clock is bucketed to 5 s. Socket frames are coalesced to
at most one refetch per 1.2 s. A participant update re-renders exactly one card.

---

## 5. Database

Migration `migrations/0001_meeting_intelligence.sql` — **7 `CREATE TABLE`, 16
indexes, zero `DROP`, zero `ALTER`.** It is reversible by dropping the seven new
tables; no existing table, column, index or row is touched, so existing data
stays readable by both the old and new code.

| Table | Purpose |
|---|---|
| `meeting_analysis_sessions` | one analysis run: adapter, status, config snapshot, heartbeat |
| `participant_analysis_state` | live engagement state, 1:1 with `session_participants` |
| `participant_observations` | sampled analysis output, retention-bounded via `expires_at` |
| `participant_engagement_events` | open/close engagement events with dedupe keys |
| `identity_verifications` | every identity decision, successes and failures |
| `meeting_monitoring_settings` | organizer config, its own version counter |
| `meeting_reports` | frozen analytics that outlive observation retention |

Thumbnails and snapshots reuse the existing `evidence_objects` table (kind
`ENGAGEMENT_SNAPSHOT`), so they inherit AES-GCM encryption, SHA-256 integrity,
60-second signed URLs, audit logging and the hourly retention purge.

Tenancy: every new table carries `organization_id` and every query filters on
it, matching `ARCHITECTURE.md` §4.

---

## 6. API reference

All endpoints are under `/api/v1/meetings`, require an authenticated session,
and are tenant-scoped. `:id` accepts a **training-session id or a Zoom meeting
number** (a Zoom id mapping to more than one session is a `400`, not a guess).

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/meetings/:id/analysis` | `monitoring:read` | run status + KPIs + config |
| `POST` | `/meetings/:id/analysis/start` | `monitoring:write` | start a run (`adapter`, `participantCount`, `seed`) |
| `POST` | `/meetings/:id/analysis/stop` | `monitoring:write` | stop the run |
| `POST` | `/meetings/:id/analysis/heartbeat` | `monitoring:write` | worker liveness |
| `GET` | `/meetings/:id/analysis/plan` | `monitoring:read` | scheduler work list (`limit`, `all=1`) |
| `GET` | `/meetings/:id/participants` | `monitoring:read` | grid data (`limit`, `offset`) |
| `GET` | `/meetings/:id/participants/:pid` | `monitoring:read` | detail + events + identity history + timeline |
| `GET` | `/meetings/:id/events` | `monitoring:read` | `type`, `state`, `severity`, `participantId`, `from`, `to`, `limit` |
| `GET` | `/meetings/:id/report` | `report:create` | report as JSON, or `?format=csv` |
| `POST` | `/meetings/:id/report` | `report:create` | freeze the report into `meeting_reports` |
| `GET` | `/meetings/monitoring-settings` | `monitoring:read` | organizer config |
| `PATCH` | `/meetings/monitoring-settings` | `monitoring:write` | update config (partial) |
| `PATCH` | `/meetings/:id/monitoring-settings` | `monitoring:write` | per-meeting alias of the above |
| `POST` | `/meetings/:id/simulate` | `monitoring:write` | advance the simulator (MOCK runs only) |

### Bot ingestion

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/bot/ingest` | `Bearer BOT_INGEST_TOKEN` | **unchanged** — original trainee-style pipeline |
| `POST` | `/api/v1/bot/observe` | `Bearer BOT_INGEST_TOKEN` | new — rich observations for this layer |

`/bot/observe` body:

```jsonc
{
  "meetingId": "81234567890",
  "botId": "bot-1",
  "observations": [{
    "zoomParticipantUuid": "abc…", "zoomUserId": "16778240", "zoomUserName": "田中 健二",
    "observedAt": 1790247000000,
    "faceDetected": true, "faceCount": 1, "detectionConfidence": 0.97,
    "faceBox": { "x": 0.34, "y": 0.2, "width": 0.24, "height": 0.33 },  // normalised 0..1
    "yaw": 6.2, "pitch": -3.1, "roll": 0.8,                              // degrees
    "gazeHorizontal": -0.04, "gazeVertical": 0.02,                       // -1..1
    "identityStatus": "VERIFIED", "identityConfidence": 0.93, "traineeId": "trn_…",
    "cameraOn": true, "microphoneOn": true, "speaking": false,
    "snapshot": "data:image/jpeg;base64,…",   // stored only if snapshots are enabled
    "left": false
  }]
}
```

Sign convention: **yaw > 0 = turned to the participant's own right; pitch > 0 =
tilted up**, in the camera's frame, never mirrored. An adapter that disagrees
will mirror the dashboard.

### Realtime

`GET /api/v1/sessions/:id/stream?since=<cursor>` (unchanged endpoint) now also
carries `participant.analysis.updated`, `engagement.event.opened`,
`engagement.event.resolved` and `analysis.session.changed`. Consumers built
against the original five types ignore what they do not recognise.

---

## 7. Zoom integration

Three adapters behind one interface (`ZoomMediaAdapter`):

- **`MEETING_SDK` (push)** — `zoom-bot/` joins the meeting with the Zoom Meeting
  SDK, pulls each participant's raw video, runs the Ayonix/UXE engine on a GPU
  host and posts results. **Gated by Zoom**: needs a Meeting SDK app
  (Key + Secret, separate from the OAuth app) and raw-data access, which
  requires Zoom app review for production. Neither is a code change.
- **`RTMS` (push)** — preferable where the account has it: no extra attendee, no
  GPU host running a Zoom client. Handshake signing and event normalisation are
  implemented and tested; the long-lived media socket needs a Durable Object or
  the same GPU host, marked `TODO(rtms-media)`.
- **`MOCK` (local)** — the simulator. Refused for anything but a `MOCK` run, so
  synthetic data can never contaminate a real meeting's evidence.

The existing OAuth integration, webhook receiver and participant reconciliation
(`reconcileZoomParticipant`) are reused unchanged.

---

## 8. Local simulation

The entire console can be exercised with no Zoom account, no SDK key and no
camera.

```bash
npm run dev                      # http://localhost:5173
```

Then: **ライブ会議 → 解析を開始 → シミュレーションで開始 → データを生成**.

Or via the API:

```bash
curl -X POST "$BASE/api/v1/meetings/$SESSION/analysis/start" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  --cookie "zoomer_session=$TOKEN" -d '{"adapter":"MOCK","participantCount":12}'

curl -X POST "$BASE/api/v1/meetings/$SESSION/simulate" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  --cookie "zoomer_session=$TOKEN" -d '{"ticks":6,"stepSec":8}'
```

The simulator is **deterministic** (seeded `mulberry32`), so a bug seen in the
UI reproduces exactly from the same seed. Twelve scenarios are generated
round-robin, covering the whole §44 verification list: `stable`, `speaking`,
`looking-left`, `looking-right`, `looking-down`, `looking-up`, `camera-off`,
`face-missing`, `multiple-faces`, `identity-mismatch`, `low-quality` (poor
light / low bitrate), `rejoining`. Scenarios cycle, so conditions open **and
resolve** rather than settling — which is what exercises de-duplication.

---

## 9. Environment variables

No new **required** variables. Everything the layer needs is either an existing
binding or a database-backed setting.

| Variable | Status | Used for |
|---|---|---|
| `BOT_INGEST_TOKEN` | existing secret | Bearer auth for `/bot/ingest` **and** `/bot/observe` |
| `DATA_ENCRYPTION_KEY` | existing secret | encrypts snapshots at rest |
| `SESSION_SIGNING_KEY` | existing secret | signs 60 s evidence URLs |
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | existing secrets | OAuth; also RTMS handshake signing |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | existing secret | webhook verification |
| `DB`, `EVIDENCE`, `REPORTS`, `SESSION_HUB`, `ASSETS` | existing bindings | unchanged |

Monitoring thresholds, FPS, retention and feature flags are **not** environment
variables — they are per-organization rows in `meeting_monitoring_settings`,
editable in 設定 → 会議モニタリング and versioned independently of the trainee-side
rules. Bot-side settings (`ZOOM_SDK_KEY`, `ZOOM_SDK_SECRET`, `ZOOM_MEETING_NUMBER`,
`ZOOMER_BASE_URL`, engine host/port) live in `zoom-bot/config.example.env`.

---

## 10. Testing

```bash
npm test          # 284 tests, 16 files
npm run typecheck
npm run build     # typecheck now gates the bundle
```

**284 passing** — the 126 that existed before, unchanged, plus 158 new:

| Suite | Covers |
|---|---|
| `participant-state.test.ts` | state derivation, temporal persistence, back-dating, speaking analytics |
| `meeting-scheduler.test.ts` | priority heap, tier classification, §6 ordering, plan building, 200-person bound |
| `event-engine.test.ts` | gates, duration bands, open/resolve, escalation, dedupe, cool-off |
| `gaze.test.ts` | pose normalisation, bucketing, sign convention, falloff, smoothing |
| `identity-cache.test.ts` | re-verification triggers, every invalidation rule, mismatch vs unverified |
| `meeting-report.test.ts` | percentages, longest-away runs, event counts, CSV shape, no key leakage |
| `zoom-adapter.test.ts` | identity resolution, rejoin, media mapping, backoff, all three adapters, simulator |
| `permissions.test.ts` | server/UI matrix equality, organizer role aliases |

### Verified in a real browser

`33/33` interaction checks against the running app (Playwright, headless
Chromium): login; all six original pages render; 検知ルール still present and
会議モニタリング added; all ten nav items; start analysis; generate data; 12 cards
render; KPIs populate; filters narrow correctly (要対応 5, カメラオフ 2, 本人未確認 6
of 12); search; drawer opens with timeline, identity history and the
no-inference notice; drawer closes; event feed 6 rows; participants table 12
rows; events page; report with 12 participants and the sampling caveat; **no
console errors; no failing API calls.**

Escalation was verified directly in the database: `IDENTITY_MISMATCH` and
`MULTIPLE_FACES` produced rows in the **existing** `alerts` table with
`escalated=1` and a linked `alert_id`, while `CAMERA_OFF`, `FACE_MISSING` and
`LOW_CONFIDENCE` correctly stayed in the engagement feed only.

---

## 11. Deployment

Unchanged: `npm run deploy` (`vite build && wrangler deploy`).

```bash
npx wrangler d1 migrations apply ayonix-zoomer --local    # then --remote
npm run deploy
```

The migration is additive, so **it is safe to apply before deploying the new
code** — the running Worker simply ignores the new tables. That ordering gives a
clean rollback: redeploy the previous Worker and the new tables sit unused.

Recommended topology (matches the spec's §52 and the existing setup):

| Tier | Runs |
|---|---|
| Cloudflare Workers | API, organizer console, scheduler policy, event engine, realtime (DO) |
| D1 / R2 | state, events, reports, encrypted snapshots |
| GPU host | `zoom-bot/` + the Ayonix/UXE engine — the only place inference runs |

---

## 12. Security review

**Reused, not rebuilt:** session cookie + bearer auth, the RBAC matrix,
`X-Organization-Id` cross-tenant guard, `Idempotency-Key` replay protection,
AES-GCM encryption at rest, HMAC-signed 60-second evidence URLs, and the
append-only audit log.

- **Tenant isolation** — every new table carries `organization_id`; every query
  in `worker/routes/meetings.ts` filters on `actor.organizationId`. A meeting id
  from another tenant returns `404`, not another tenant's data.
- **Authorisation** — `monitoring:read` to view, `monitoring:write` to start,
  stop or configure. Auditors get read-only. The UI mirror is now test-locked to
  the server matrix.
- **Bot auth** — `/bot/observe` uses the same constant-time bearer comparison as
  `/bot/ingest`, and applies the same clock-skew and event-age guards, so a bot
  with a wrong clock cannot back-date or pre-date a timeline.
- **Simulation containment** — `/simulate` is refused unless the run's adapter is
  `MOCK`, so synthetic observations can never be written into a meeting being
  monitored for real.
- **Audit** — analysis start/stop, settings changes, report reads and report
  creation are all audited with actor, resource and request id.
- **No leakage in exports or logs** — the report CSV carries a boolean for
  evidence presence, never an object key or signed URL (asserted by test). The
  ingest log carries counts and latency, never a name or a face.
- **Snapshot URLs** — short-lived, HMAC-signed, audited on access, and off by
  default.

**Not implemented, and not claimed:** per-endpoint rate limiting. The existing
product does not have it either; `Idempotency-Key` prevents replay but not
volume. Cloudflare WAF rate limiting in front of `/api/v1/bot/*` is the natural
place for it and is a deployment configuration, not code.

---

## 13. Privacy and retention

Defaults are deliberately conservative, and 設定 → 会議モニタリング shows the
organizer the current posture in plain language, suitable for a participant
notice:

| Data | Default |
|---|---|
| Raw video | **never stored** |
| Raw frames | discarded after inference |
| Snapshots | **off**; 7-day retention when enabled |
| Observations | 14 days, enforced by `expires_at` + hourly cron |
| Engagement events | 90 days (resolved events only are purged) |
| Meeting reports | retained — the summarised record outlives the raw samples |
| Transcript analytics | off, optional, never a dependency of visual monitoring |

Shortening a retention window applies to **new** data: rows keep the `expires_at`
computed when they were written, so a policy change cannot retroactively re-date
evidence. Analysis percentages are reported over *analysed samples*, not
wall-clock, and every report says so — claiming wall-clock precision from
sampled analysis would be a fabrication.

---

## 14. Known Zoom limitations

1. **Raw video needs Zoom's permission.** The Meeting SDK path requires a
   Meeting SDK app and raw-data/local-recording access, which needs Zoom app
   review for production use.
2. **A bot is a visible participant.** The Meeting SDK approach adds an attendee
   to the meeting. RTMS avoids this where available.
3. **Participant identifiers are unstable.** `user_id` is unique only within one
   meeting and the participant UUID changes on rejoin — handled in
   `participant-events.ts`, but it means cross-occurrence identity depends on
   face recognition or the roster, not on Zoom ids.
4. **Gaze is limited by tile resolution.** Iris position needs more pixels than a
   small gallery tile provides; the estimator degrades to head pose alone and
   reports lower confidence rather than guessing.
5. **Speaking is active-speaker, not per-person VAD.** Zoom reports the active
   speaker; overlapping speech is attributed to whoever Zoom names.
6. **Cost is real.** CPU inference measured ≈1.9 s/face on this VM. A GPU host
   is required for a real class; the scheduler exists precisely to bound this.
7. **No control over the Zoom UI.** Face boxes are drawn on Ayonix Zoomer's own
   thumbnails. The product does not, and cannot, modify the Zoom client.

---

## 15. Future Video SDK migration path

The interfaces already assume it. A Video SDK version — where the meeting is
rendered *inside* Ayonix Zoomer — is a new `ZoomMediaAdapter` implementation and
nothing else:

1. Add `worker/integrations/zoom/video-sdk.ts` implementing `ZoomMediaAdapter`,
   and register it in `createAdapter()`.
2. Add `"VIDEO_SDK"` to `AdapterKind` and to the `adapter` column's accepted
   values (a string column — no migration).
3. Frames become locally available, so `onVideoFrame` is finally used for real
   and the browser can run the vision pipeline for small meetings.
4. **Nothing else changes**: the state reducer, scheduler, event engine,
   identity service, reporting and the whole organizer console consume
   normalised observations and never learn where the pixels came from.

This migration is deliberately **not** implemented now, per §49.

---

## 16. File manifest

### New — backend (16)
```
worker/integrations/zoom/{types,adapter,meeting-sdk,rtms,mock,participant-events,media-events,reconnect}.ts
worker/services/monitoring/{signals,config,pipeline}.ts
worker/services/analysis/{participant-state,priority-queue,scheduler}.ts
worker/services/gaze/{head-pose,screen-facing}.ts
worker/services/events/{thresholds,deduplication,event-engine}.ts
worker/services/identity/verification.ts
worker/services/reporting/meeting-report.ts
worker/routes/meetings.ts
migrations/0001_meeting_intelligence.sql
```

### New — frontend (13)
```
src/components/meeting-monitoring/{FaceOverlay,ParticipantCard,ParticipantGrid,MeetingKPIs,
  FilterBar,ParticipantTimeline,ParticipantDetail,EventFeed,MeetingMonitoringSettings}.tsx
src/screens/admin/{LiveMeeting,MeetingParticipants,MeetingEvents,MeetingReports}.tsx
src/lib/meeting/{signals.ts,use-meeting.ts}
src/lib/permissions.ts
```

### New — tests (6)
```
tests/{participant-state,meeting-scheduler,event-engine,gaze,identity-cache,meeting-report,zoom-adapter}.test.ts
```

### Modified (existing behaviour preserved)
```
worker/db/schema.ts          7 tables appended; nothing above them touched
worker/index.ts              route registered; second purge task added to cron
worker/routes/bot.ts         /observe added; /ingest untouched
worker/lib/auth.ts           2 permissions added; organizer role aliases
worker/lib/ids.ts            5 id prefixes added
worker/do/session-hub.ts     4 event types added to the union
src/App.tsx                  4 routes added
src/components/shell/AppShell.tsx   4 nav items + 4 headings added
src/screens/admin/Settings.tsx      new card appended
src/lib/api.ts               client methods + types appended
src/lib/auth-context.tsx     matrix extracted to src/lib/permissions.ts
tests/permissions.test.ts    3 pre-existing type errors fixed; sync tests added
package.json                 build script no longer emits into src/
.gitignore                   blocks stray tsc output
```

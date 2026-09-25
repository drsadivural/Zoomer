/**
 * Ayonix Zoomer - D1 (SQLite) schema.
 *
 * Tenancy rule (ARCHITECTURE.md §4): every business table carries `organizationId`
 * and every query must filter on it. `worker/lib/tenant.ts` enforces this at the
 * application layer; the partial indexes below back it at the storage layer.
 *
 * Time rule (PRODUCT_SPEC_JA.md §5): all timestamps are stored as UTC epoch
 * milliseconds. Display-time zone conversion happens in the UI only.
 */
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

/* ------------------------------------------------------------------ tenancy */

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Tokyo"),
  locale: text("locale").notNull().default("ja"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
  deletedAt: integer("deleted_at"),
});

/** Roles are fixed (RBAC, SECURITY_PRIVACY.md §2): viewing faces and exporting
 *  evidence are deliberately separate permissions. */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** sys_admin | training_admin | auditor */
    role: text("role").notNull().default("training_admin"),
    /** Null when the user authenticates through SSO only. */
    passwordHash: text("password_hash"),
    ssoSubject: text("sso_subject"),
    lastLoginAt: integer("last_login_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    uniqueIndex("users_org_email_uq").on(t.organizationId, t.email),
    index("users_org_idx").on(t.organizationId),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(now),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_uq").on(t.tokenHash),
    index("auth_sessions_user_idx").on(t.userId),
  ],
);

/* ------------------------------------------------------------------ trainees */

export const trainees = sqliteTable(
  "trainees",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    /** Customer-facing trainee number, e.g. AZ-0241. Unique per organization. */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    department: text("department"),
    email: text("email"),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    uniqueIndex("trainees_org_external_uq").on(t.organizationId, t.externalId),
    index("trainees_org_idx").on(t.organizationId),
    index("trainees_org_email_idx").on(t.organizationId, t.email),
    index("trainees_org_name_idx").on(t.organizationId, t.name),
  ],
);

/**
 * Face templates. `template` holds an AES-GCM encrypted descriptor, never a raw
 * image (SECURITY_PRIVACY.md §1). `imageKey` is set only when the organization's
 * retention policy opts into keeping the enrollment photo.
 */
export const faceEnrollments = sqliteTable(
  "face_enrollments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    traineeId: text("trainee_id").notNull(),
    template: text("template").notNull(),
    templateIv: text("template_iv").notNull(),
    /** Dimensionality + engine that produced the template; gates comparisons. */
    engine: text("engine").notNull(),
    modelVersion: text("model_version").notNull(),
    dimensions: integer("dimensions").notNull(),
    qualityScore: real("quality_score").notNull(),
    qualityDetail: text("quality_detail", { mode: "json" }).$type<Record<string, number | boolean>>(),
    imageKey: text("image_key"),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: integer("created_at").notNull().default(now),
    createdBy: text("created_by"),
    deletedAt: integer("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (t) => [
    index("face_enrollments_org_trainee_idx").on(t.organizationId, t.traineeId),
    index("face_enrollments_org_status_idx").on(t.organizationId, t.status),
  ],
);

/** Explicit, revocable biometric consent (PRODUCT_SPEC_JA.md §3.2). */
export const consents = sqliteTable(
  "consents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    traineeId: text("trainee_id").notNull(),
    sessionId: text("session_id"),
    /** Version of the consent text the trainee actually saw. */
    policyVersion: text("policy_version").notNull(),
    scope: text("scope", { mode: "json" }).$type<string[]>().notNull(),
    grantedAt: integer("granted_at").notNull().default(now),
    revokedAt: integer("revoked_at"),
    userAgent: text("user_agent"),
  },
  (t) => [index("consents_org_trainee_idx").on(t.organizationId, t.traineeId)],
);

/* ------------------------------------------------------------------ sessions */

export const trainingSessions = sqliteTable(
  "training_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    /** SCHEDULED | LIVE | COMPLETED | CANCELLED */
    status: text("status").notNull().default("SCHEDULED"),
    zoomMeetingId: text("zoom_meeting_id"),
    /** Snapshot of monitoring rules taken when the session starts, so that a
     *  later settings change cannot retroactively alter past judgements. */
    ruleVersion: text("rule_version"),
    ruleSnapshot: text("rule_snapshot", { mode: "json" }).$type<Record<string, number | boolean>>(),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
    createdBy: text("created_by"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("training_sessions_org_idx").on(t.organizationId),
    index("training_sessions_org_status_idx").on(t.organizationId, t.status),
    index("training_sessions_org_start_idx").on(t.organizationId, t.startsAt),
  ],
);

/**
 * A trainee's place in one session. Zoom identity lives here: this is the join
 * between "who Zoom says is in the meeting" and "who we verified by face".
 */
export const sessionParticipants = sqliteTable(
  "session_participants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** Null while a Zoom attendee has joined but is not yet matched to a trainee. */
    traineeId: text("trainee_id"),
    /** PRECHECK_PENDING | VERIFIED | MONITORING | WARNING | ALERT | REVIEWED | DISCONNECTED | COMPLETED */
    status: text("status").notNull().default("PRECHECK_PENDING"),
    statusDetail: text("status_detail"),
    lastMatchScore: real("last_match_score"),
    lastSeenAt: integer("last_seen_at"),
    precheckAt: integer("precheck_at"),
    precheckAttempts: integer("precheck_attempts").notNull().default(0),

    /* --- Zoom participant identity (from webhooks / participants API) --- */
    zoomParticipantUuid: text("zoom_participant_uuid"),
    zoomParticipantUserId: text("zoom_participant_user_id"),
    zoomUserId: text("zoom_user_id"),
    zoomDisplayName: text("zoom_display_name"),
    zoomEmail: text("zoom_email"),
    zoomJoinedAt: integer("zoom_joined_at"),
    zoomLeftAt: integer("zoom_left_at"),
    /** email | external_id | name | manual | unmatched — how we tied Zoom → trainee. */
    matchMethod: text("match_method"),
    matchConfidence: real("match_confidence"),

    /** Short-lived bearer for the trainee's own monitoring client. */
    deviceTokenHash: text("device_token_hash"),
    deviceTokenExpiresAt: integer("device_token_expires_at"),

    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("session_participants_org_session_idx").on(t.organizationId, t.sessionId),
    uniqueIndex("session_participants_session_trainee_uq").on(t.sessionId, t.traineeId),
    index("session_participants_zoom_uuid_idx").on(t.sessionId, t.zoomParticipantUuid),
    index("session_participants_status_idx").on(t.organizationId, t.status),
  ],
);

export const zoomMeetings = sqliteTable(
  "zoom_meetings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    /** Numeric Zoom meeting id, as a string to avoid precision loss. */
    meetingId: text("meeting_id").notNull(),
    /** Per-occurrence UUID; changes each time the meeting starts. */
    meetingUuid: text("meeting_uuid"),
    topic: text("topic"),
    hostId: text("host_id"),
    joinUrl: text("join_url"),
    startTime: integer("start_time"),
    duration: integer("duration"),
    status: text("status").notNull().default("waiting"),
    lastSyncedAt: integer("last_synced_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("zoom_meetings_org_meeting_uq").on(t.organizationId, t.meetingId),
    index("zoom_meetings_uuid_idx").on(t.meetingUuid),
  ],
);

/* ------------------------------------------------------- monitoring & alerts */

export const monitoringEvents = sqliteTable(
  "monitoring_events",
  {
    /** Client-supplied ULID. Primary key so replays are idempotent by construction. */
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    participantId: text("participant_id").notNull(),
    /** FACE_ABSENT | MULTIPLE_FACES | EYES_CLOSED | MATCH_FAIL | MATCH_OK |
     *  CAMERA_BLOCKED | CAMERA_STOPPED | TAB_HIDDEN | NETWORK_LOST | PRECHECK_* */
    type: text("type").notNull(),
    /** INFO | WARNING | ALERT */
    severity: text("severity").notNull(),
    capturedAt: integer("captured_at").notNull(),
    receivedAt: integer("received_at").notNull().default(now),
    durationMs: integer("duration_ms"),
    faceCount: integer("face_count"),
    matchScore: real("match_score"),
    qualityScore: real("quality_score"),
    modelVersion: text("model_version"),
    ruleVersion: text("rule_version"),
    evidenceId: text("evidence_id"),
    /** Set when the server's own rule pass disagreed with the client's claim. */
    serverAdjusted: integer("server_adjusted", { mode: "boolean" }).notNull().default(false),
    quarantined: integer("quarantined", { mode: "boolean" }).notNull().default(false),
    quarantineReason: text("quarantine_reason"),
  },
  (t) => [
    index("monitoring_events_org_session_idx").on(t.organizationId, t.sessionId, t.capturedAt),
    index("monitoring_events_participant_idx").on(t.participantId, t.capturedAt),
    index("monitoring_events_org_type_idx").on(t.organizationId, t.type),
  ],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    participantId: text("participant_id").notNull(),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    /** OPEN | ACKNOWLEDGED | FALSE_POSITIVE | ESCALATED | RESOLVED */
    state: text("state").notNull().default("OPEN"),
    summary: text("summary").notNull(),
    detail: text("detail"),
    firstEventId: text("first_event_id"),
    lastEventId: text("last_event_id"),
    evidenceId: text("evidence_id"),
    occurrences: integer("occurrences").notNull().default(1),
    ruleVersion: text("rule_version"),
    modelVersion: text("model_version"),
    assignedTo: text("assigned_to"),
    /** Dedupe key: suppresses repeat notifications for one ongoing condition. */
    dedupeKey: text("dedupe_key"),
    openedAt: integer("opened_at").notNull().default(now),
    closedAt: integer("closed_at"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("alerts_org_session_idx").on(t.organizationId, t.sessionId, t.openedAt),
    index("alerts_org_state_idx").on(t.organizationId, t.state),
    uniqueIndex("alerts_dedupe_uq").on(t.sessionId, t.dedupeKey),
  ],
);

export const alertReviews = sqliteTable(
  "alert_reviews",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    alertId: text("alert_id").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    action: text("action").notNull(),
    /** Structured false-positive cause, fed back into model evaluation. */
    reasonCode: text("reason_code"),
    comment: text("comment"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("alert_reviews_org_alert_idx").on(t.organizationId, t.alertId)],
);

/* ---------------------------------------------------------------- evidence */

export const evidenceObjects = sqliteTable(
  "evidence_objects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    participantId: text("participant_id").notNull(),
    /** R2 key. Never logged and never placed in exports. */
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull().default("image/jpeg"),
    byteSize: integer("byte_size"),
    /** SHA-256 over the ciphertext, for tamper detection. */
    sha256: text("sha256").notNull(),
    kind: text("kind").notNull(),
    capturedAt: integer("captured_at").notNull(),
    /** Retention deadline; the scheduled purge deletes at or after this instant. */
    expiresAt: integer("expires_at").notNull(),
    deletedAt: integer("deleted_at"),
    deleteReason: text("delete_reason"),
  },
  (t) => [
    index("evidence_org_session_idx").on(t.organizationId, t.sessionId),
    index("evidence_expiry_idx").on(t.expiresAt, t.deletedAt),
  ],
);

/* ------------------------------------------------------ settings & integrations */

export const monitoringSettings = sqliteTable("monitoring_settings", {
  organizationId: text("organization_id").primaryKey(),
  /** Monotonic; stamped onto every event so past judgements stay explainable. */
  version: integer("version").notNull().default(1),
  reauthIntervalSec: integer("reauth_interval_sec").notNull().default(60),
  matchThreshold: real("match_threshold").notNull().default(0.82),
  absenceSec: integer("absence_sec").notNull().default(60),
  eyesClosedSec: integer("eyes_closed_sec").notNull().default(10),
  multiFaceFrames: integer("multi_face_frames").notNull().default(15),
  evidenceIntervalSec: integer("evidence_interval_sec").notNull().default(300),
  evidenceRetentionDays: integer("evidence_retention_days").notNull().default(30),
  precheckMaxAttempts: integer("precheck_max_attempts").notNull().default(3),
  livenessRequired: integer("liveness_required", { mode: "boolean" }).notNull().default(true),
  imageQuality: real("image_quality").notNull().default(0.72),
  updatedAt: integer("updated_at").notNull().default(now),
  updatedBy: text("updated_by"),
});

/** Third-party credentials. Tokens are AES-GCM encrypted at rest. */
export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    /** zoom | teams | webhook | smtp */
    provider: text("provider").notNull(),
    status: text("status").notNull().default("DISCONNECTED"),
    accessToken: text("access_token"),
    accessTokenIv: text("access_token_iv"),
    refreshToken: text("refresh_token"),
    refreshTokenIv: text("refresh_token_iv"),
    expiresAt: integer("expires_at"),
    scope: text("scope"),
    accountId: text("account_id"),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
    connectedBy: text("connected_by"),
    connectedAt: integer("connected_at"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("integrations_org_provider_uq").on(t.organizationId, t.provider)],
);

export const notificationRules = sqliteTable(
  "notification_rules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    eventTypes: text("event_types", { mode: "json" }).$type<string[]>().notNull(),
    minSeverity: text("min_severity").notNull().default("ALERT"),
    channel: text("channel").notNull(),
    target: text("target").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("notification_rules_org_idx").on(t.organizationId)],
);

/* --------------------------------------------------------------- audit & ops */

/** Append-only. Must never contain templates, image URLs, or tokens. */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    actorId: text("actor_id"),
    actorType: text("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    result: text("result").notNull().default("SUCCESS"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    requestId: text("request_id"),
    ipHash: text("ip_hash"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt),
    index("audit_logs_org_resource_idx").on(t.organizationId, t.resourceType, t.resourceId),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("PENDING"),
    params: text("params", { mode: "json" }).$type<Record<string, unknown>>(),
    objectKey: text("object_key"),
    rowCount: integer("row_count"),
    error: text("error"),
    requestedBy: text("requested_by").notNull(),
    createdAt: integer("created_at").notNull().default(now),
    completedAt: integer("completed_at"),
    expiresAt: integer("expires_at"),
  },
  (t) => [index("reports_org_created_idx").on(t.organizationId, t.createdAt)],
);

/** Replay guard for mutating APIs (API_CONTRACT.md: Idempotency-Key). */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    createdAt: integer("created_at").notNull().default(now),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [uniqueIndex("idempotency_org_key_uq").on(t.organizationId, t.key, t.endpoint)],
);

/** Dedupe for Zoom webhook deliveries, which are at-least-once. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    organizationId: text("organization_id"),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: integer("received_at").notNull().default(now),
    processedAt: integer("processed_at"),
    result: text("result"),
  },
  (t) => [uniqueIndex("webhook_deliveries_hash_uq").on(t.provider, t.payloadHash)],
);

/* ==================================================================== *
 *  Zoom Organizer Intelligence Layer (additive — 2026-09-24)
 *
 *  Everything below is new. No table, column or index above was changed:
 *  the organizer console is a layer over the existing monitoring pipeline,
 *  not a replacement for it. Observations, engagement state and identity
 *  history live here; alerts, evidence and audit continue to use the
 *  original tables so one alert inbox still covers both sources.
 * ==================================================================== */

/** One analysis run over one training session (start → stop). */
export const meetingAnalysisSessions = sqliteTable(
  "meeting_analysis_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    zoomMeetingId: text("zoom_meeting_id"),
    /** MOCK | MEETING_SDK | RTMS — which ingestion adapter feeds this run. */
    adapter: text("adapter").notNull().default("MOCK"),
    /** STARTING | RUNNING | DEGRADED | STOPPED | FAILED */
    status: text("status").notNull().default("STARTING"),
    /** Snapshot of the monitoring config in force, so a later settings change
     *  cannot retroactively re-grade this run (same rule as ruleSnapshot). */
    config: text("config", { mode: "json" }).$type<Record<string, number | boolean | string>>(),
    startedAt: integer("started_at").notNull().default(now),
    stoppedAt: integer("stopped_at"),
    startedBy: text("started_by"),
    /** Liveness of the analysis worker; absence of a heartbeat is a degraded state. */
    lastHeartbeatAt: integer("last_heartbeat_at"),
    participantCount: integer("participant_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("mas_org_session_idx").on(t.organizationId, t.sessionId),
    index("mas_org_status_idx").on(t.organizationId, t.status),
    index("mas_zoom_meeting_idx").on(t.zoomMeetingId),
  ],
);

/**
 * Live engagement state, one row per session participant.
 *
 * Deliberately denormalised: the organizer grid reads this table alone, so a
 * 200-person meeting costs one indexed query rather than an aggregate over the
 * observation history.
 */
export const participantAnalysisState = sqliteTable(
  "participant_analysis_state",
  {
    /** Same id as `session_participants.id` — a 1:1 extension of that row. */
    participantId: text("participant_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    analysisSessionId: text("analysis_session_id"),

    displayName: text("display_name"),
    joinedAt: integer("joined_at"),
    leftAt: integer("left_at"),

    cameraOn: integer("camera_on", { mode: "boolean" }).notNull().default(false),
    microphoneOn: integer("microphone_on", { mode: "boolean" }).notNull().default(false),
    speaking: integer("speaking", { mode: "boolean" }).notNull().default(false),
    speakingMs: integer("speaking_ms").notNull().default(0),
    speakingTurns: integer("speaking_turns").notNull().default(0),
    lastSpokeAt: integer("last_spoke_at"),

    faceDetected: integer("face_detected", { mode: "boolean" }).notNull().default(false),
    faceCount: integer("face_count").notNull().default(0),
    /** Normalised {x,y,width,height} in 0..1, for the dashboard face overlay. */
    faceBox: text("face_box", { mode: "json" }).$type<Record<string, number>>(),

    /** VERIFIED | UNVERIFIED | MISMATCH | NO_FACE | MULTIPLE_FACES | UNKNOWN */
    identityStatus: text("identity_status").notNull().default("UNKNOWN"),
    identityConfidence: real("identity_confidence"),
    identityTraineeId: text("identity_trainee_id"),
    identityVerifiedAt: integer("identity_verified_at"),
    /** Verification is cached until here, then re-run (see identity service). */
    identityExpiresAt: integer("identity_expires_at"),

    headYaw: real("head_yaw"),
    headPitch: real("head_pitch"),
    headRoll: real("head_roll"),
    /** FORWARD | LEFT | RIGHT | UP | DOWN | UNKNOWN */
    headState: text("head_state").notNull().default("UNKNOWN"),

    /** Eye state. Drowsiness is reported as a *suspicion* for a human to
     *  confirm, never as an automatic judgement (PRODUCT_SPEC_JA.md §3.4). */
    eyeClosed: integer("eye_closed", { mode: "boolean" }).notNull().default(false),
    /** 0..1, higher means more open. Null when the provider cannot measure it. */
    eyeOpenness: real("eye_openness"),
    /** When the current unbroken run of closed eyes began. */
    eyesClosedSince: integer("eyes_closed_since"),

    screenFacingProbability: real("screen_facing_probability"),
    gazeHorizontal: real("gaze_horizontal"),
    gazeVertical: real("gaze_vertical"),

    /** Observable engagement signal — never a psychological label. */
    currentState: text("current_state").notNull().default("UNKNOWN"),
    currentStateSince: integer("current_state_since").notNull().default(now),
    /** Candidate state awaiting temporal persistence before it is committed. */
    pendingState: text("pending_state"),
    pendingStateSince: integer("pending_state_since"),

    lastAnalyzedAt: integer("last_analyzed_at"),
    analysisConfidence: real("analysis_confidence"),
    /** HOT | WARM | NORMAL — scheduler tier. */
    analysisTier: text("analysis_tier").notNull().default("NORMAL"),
    nextAnalysisAt: integer("next_analysis_at"),

    /** Points at an `evidence_objects` row of kind THUMBNAIL (retention applies). */
    thumbnailEvidenceId: text("thumbnail_evidence_id"),
    thumbnailAt: integer("thumbnail_at"),

    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("pas_org_session_idx").on(t.organizationId, t.sessionId),
    index("pas_session_state_idx").on(t.sessionId, t.currentState),
    index("pas_schedule_idx").on(t.sessionId, t.analysisTier, t.nextAnalysisAt),
  ],
);

/** Sampled analysis output. Retained for the configured window, then purged. */
export const participantObservations = sqliteTable(
  "participant_observations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    participantId: text("participant_id").notNull(),
    observedAt: integer("observed_at").notNull(),

    faceDetected: integer("face_detected", { mode: "boolean" }).notNull().default(false),
    faceCount: integer("face_count").notNull().default(0),
    identityStatus: text("identity_status"),
    recognitionConfidence: real("recognition_confidence"),

    headYaw: real("head_yaw"),
    headPitch: real("head_pitch"),
    headRoll: real("head_roll"),
    screenFacingProbability: real("screen_facing_probability"),

    eyeClosed: integer("eye_closed", { mode: "boolean" }),
    eyeOpenness: real("eye_openness"),

    cameraOn: integer("camera_on", { mode: "boolean" }),
    microphoneOn: integer("microphone_on", { mode: "boolean" }),
    speaking: integer("speaking", { mode: "boolean" }),

    state: text("state").notNull().default("UNKNOWN"),
    confidence: real("confidence"),
    source: text("source").notNull().default("BOT"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    index("obs_session_time_idx").on(t.sessionId, t.observedAt),
    index("obs_participant_time_idx").on(t.participantId, t.observedAt),
    index("obs_expiry_idx").on(t.expiresAt),
  ],
);

/**
 * Engagement events with explicit open/close, so "screen away for 40s" is one
 * row that resolves rather than 40 repeated notifications.
 */
export const participantEngagementEvents = sqliteTable(
  "participant_engagement_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    participantId: text("participant_id").notNull(),
    /** FACE_MISSING | SCREEN_AWAY | CAMERA_OFF | MULTIPLE_FACES | IDENTITY_MISMATCH |
     *  LONG_ABSENCE | LOW_CONFIDENCE | PARTICIPANT_JOINED | PARTICIPANT_LEFT |
     *  IDENTITY_VERIFIED | FACE_RETURNED | SCREEN_FACING_RETURNED | CAMERA_ON */
    type: text("type").notNull(),
    severity: text("severity").notNull().default("INFO"),
    /** OPEN | RESOLVED */
    state: text("state").notNull().default("OPEN"),
    startedAt: integer("started_at").notNull(),
    resolvedAt: integer("resolved_at"),
    durationMs: integer("duration_ms"),
    confidence: real("confidence"),
    detail: text("detail"),
    /** Suppresses duplicates for one ongoing condition (unique while OPEN). */
    dedupeKey: text("dedupe_key").notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    evidenceId: text("evidence_id"),
    /** Set when this event was escalated into the existing alert inbox. */
    alertId: text("alert_id"),
    escalated: integer("escalated", { mode: "boolean" }).notNull().default(false),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("pee_session_time_idx").on(t.sessionId, t.startedAt),
    index("pee_participant_idx").on(t.participantId, t.startedAt),
    index("pee_org_state_idx").on(t.organizationId, t.state),
    uniqueIndex("pee_open_dedupe_uq").on(t.participantId, t.dedupeKey, t.startedAt),
  ],
);

/** Audit trail of every identity decision, including the ones that failed. */
export const identityVerifications = sqliteTable(
  "identity_verifications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    participantId: text("participant_id").notNull(),
    traineeId: text("trainee_id"),
    /** VERIFIED | UNVERIFIED | MISMATCH | NO_FACE | MULTIPLE_FACES | LOW_CONFIDENCE | UNKNOWN */
    result: text("result").notNull(),
    confidence: real("confidence"),
    threshold: real("threshold"),
    engine: text("engine"),
    modelVersion: text("model_version"),
    /** BOT | BROWSER | SIMULATION | MANUAL */
    source: text("source").notNull().default("BOT"),
    /** JOIN | RETURN | PERIODIC | FACE_CHANGE | MANUAL — why we re-verified. */
    trigger: text("trigger").notNull().default("PERIODIC"),
    reason: text("reason"),
    evidenceId: text("evidence_id"),
    verifiedAt: integer("verified_at").notNull(),
    expiresAt: integer("expires_at"),
  },
  (t) => [
    index("idv_session_time_idx").on(t.sessionId, t.verifiedAt),
    index("idv_participant_idx").on(t.participantId, t.verifiedAt),
  ],
);

/**
 * Organizer-facing monitoring configuration. A separate table from
 * `monitoring_settings` on purpose: the original trainee-side rules keep their
 * own version counter and review history, untouched by this layer.
 */
export const meetingMonitoringSettings = sqliteTable("meeting_monitoring_settings", {
  organizationId: text("organization_id").primaryKey(),
  version: integer("version").notNull().default(1),

  faceMonitoringEnabled: integer("face_monitoring_enabled", { mode: "boolean" }).notNull().default(true),
  identityVerificationEnabled: integer("identity_verification_enabled", { mode: "boolean" }).notNull().default(true),
  screenFacingEnabled: integer("screen_facing_enabled", { mode: "boolean" }).notNull().default(true),
  headPoseEnabled: integer("head_pose_enabled", { mode: "boolean" }).notNull().default(true),
  multiFaceEnabled: integer("multi_face_enabled", { mode: "boolean" }).notNull().default(true),
  drowsinessEnabled: integer("drowsiness_enabled", { mode: "boolean" }).notNull().default(true),
  participationAnalyticsEnabled: integer("participation_analytics_enabled", { mode: "boolean" }).notNull().default(true),
  transcriptEnabled: integer("transcript_enabled", { mode: "boolean" }).notNull().default(false),

  normalFps: real("normal_fps").notNull().default(2),
  elevatedFps: real("elevated_fps").notNull().default(5),
  normalIntervalSec: integer("normal_interval_sec").notNull().default(10),
  warmIntervalSec: integer("warm_interval_sec").notNull().default(3),
  hotIntervalSec: integer("hot_interval_sec").notNull().default(1),

  /** Temporal persistence before a signal is believed (§12). */
  transientSec: integer("transient_sec").notNull().default(3),
  temporarySec: integer("temporary_sec").notNull().default(10),
  prolongedSec: integer("prolonged_sec").notNull().default(30),

  faceMissingSec: integer("face_missing_sec").notNull().default(30),
  screenAwaySec: integer("screen_away_sec").notNull().default(30),
  cameraOffSec: integer("camera_off_sec").notNull().default(60),
  multiFaceSec: integer("multi_face_sec").notNull().default(5),
  longAbsenceSec: integer("long_absence_sec").notNull().default(300),
  /** Eyes must stay closed this long before drowsiness is even suspected. */
  eyesClosedSec: integer("eyes_closed_sec").notNull().default(10),

  identityConfidenceThreshold: real("identity_confidence_threshold").notNull().default(0.82),
  identityCacheSec: integer("identity_cache_sec").notNull().default(600),
  screenFacingThreshold: real("screen_facing_threshold").notNull().default(0.6),
  lowConfidenceThreshold: real("low_confidence_threshold").notNull().default(0.4),

  yawThresholdDeg: real("yaw_threshold_deg").notNull().default(25),
  pitchUpThresholdDeg: real("pitch_up_threshold_deg").notNull().default(18),
  pitchDownThresholdDeg: real("pitch_down_threshold_deg").notNull().default(22),

  snapshotsEnabled: integer("snapshots_enabled", { mode: "boolean" }).notNull().default(false),
  snapshotRetentionDays: integer("snapshot_retention_days").notNull().default(7),
  observationRetentionDays: integer("observation_retention_days").notNull().default(14),
  eventRetentionDays: integer("event_retention_days").notNull().default(90),
  transcriptRetentionDays: integer("transcript_retention_days").notNull().default(30),

  alertNotificationsEnabled: integer("alert_notifications_enabled", { mode: "boolean" }).notNull().default(true),

  updatedAt: integer("updated_at").notNull().default(now),
  updatedBy: text("updated_by"),
});

/** Frozen end-of-meeting analytics, so a report survives observation purging. */
export const meetingReports = sqliteTable(
  "meeting_reports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    analysisSessionId: text("analysis_session_id"),
    summary: text("summary", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    participants: text("participants", { mode: "json" }).$type<Record<string, unknown>[]>().notNull(),
    generatedAt: integer("generated_at").notNull().default(now),
    generatedBy: text("generated_by"),
  },
  (t) => [index("mr_org_session_idx").on(t.organizationId, t.sessionId, t.generatedAt)],
);

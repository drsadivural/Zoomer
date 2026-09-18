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

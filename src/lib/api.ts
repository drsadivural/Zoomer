/**
 * Typed API client.
 *
 * Mutating calls carry an `Idempotency-Key` automatically (API_CONTRACT.md), so
 * a retry after a flaky connection cannot double-create a record.
 */

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

const BASE = "/api/v1";

/** `crypto.randomUUID` exists only in secure contexts, so plain-HTTP access by IP falls back to a v4 UUID. */
function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Bearer token for trainee-device calls; admin calls use the session cookie. */
  token?: string;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (method !== "GET") headers["Idempotency-Key"] = options.idempotencyKey ?? newIdempotencyKey();

  const res = await fetch(url.toString(), {
    method,
    headers,
    credentials: "include",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const envelope = parsed as { error?: { code?: string; message?: string } } | null;
    throw new ApiClientError(
      res.status,
      envelope?.error?.code ?? "UNKNOWN",
      envelope?.error?.message ?? `リクエストが失敗しました (${res.status})`,
      (parsed as Record<string, unknown>) ?? undefined,
    );
  }
  return parsed as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: CurrentUser }>("/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  me: () => request<{ user: CurrentUser }>("/auth/me"),
  health: () => request<HealthResponse>("/health"),

  dashboard: () => request<DashboardResponse>("/dashboard"),

  listTrainees: (q?: string) => request<TraineeListResponse>("/trainees", { query: { q, limit: 200 } }),
  getTrainee: (id: string) => request<TraineeDetailResponse>(`/trainees/${id}`),
  createTrainee: (body: NewTrainee) =>
    request<{ trainee: { id: string } }>("/trainees", { method: "POST", body }),
  updateTrainee: (id: string, body: Partial<NewTrainee> & { status?: string }) =>
    request<{ ok: boolean }>(`/trainees/${id}`, { method: "PATCH", body }),
  deleteTrainee: (id: string) => request<{ ok: boolean }>(`/trainees/${id}`, { method: "DELETE" }),
  importTrainees: (csv: string) =>
    request<ImportResult>("/trainees/import", { method: "POST", body: { csv } }),
  enroll: (id: string, body: EnrollRequest) =>
    request<{ enrollment: { id: string; qualityScore: number } }>(`/trainees/${id}/enrollments`, {
      method: "POST",
      body,
    }),
  deleteEnrollment: (traineeId: string, enrollmentId: string) =>
    request<{ ok: boolean }>(`/trainees/${traineeId}/enrollments/${enrollmentId}`, {
      method: "DELETE",
    }),

  listSessions: (status?: string) => request<SessionListResponse>("/sessions", { query: { status } }),
  createSession: (body: NewSession) =>
    request<{ session: { id: string } }>("/sessions", { method: "POST", body }),
  getSession: (id: string) => request<SessionDetailResponse>(`/sessions/${id}`),
  updateSession: (id: string, body: Partial<NewSession> & { status?: string }) =>
    request<{ ok: boolean }>(`/sessions/${id}`, { method: "PATCH", body }),
  assignParticipants: (id: string, traineeIds: string[]) =>
    request<AssignResult>(`/sessions/${id}/participants`, {
      method: "POST",
      body: { traineeIds },
    }),
  listParticipants: (id: string) =>
    request<{ participants: Participant[] }>(`/sessions/${id}/participants`),
  bindParticipant: (sessionId: string, participantId: string, traineeId: string) =>
    request<{ ok: boolean }>(`/sessions/${sessionId}/participants/${participantId}/bind`, {
      method: "POST",
      body: { traineeId },
    }),
  joinLink: (sessionId: string, participantId: string) =>
    request<{ joinUrl: string; expiresAt: number }>(
      `/sessions/${sessionId}/participants/${participantId}/join-link`,
      { method: "POST" },
    ),
  monitor: (id: string, since?: number) =>
    request<MonitorResponse>(`/sessions/${id}/monitor`, { query: { since } }),
  sessionEvents: (id: string, query: Record<string, string | number | undefined> = {}) =>
    request<{ events: MonitoringEvent[] }>(`/sessions/${id}/events`, { query }),

  listAlerts: (query: Record<string, string | undefined> = {}) =>
    request<{ alerts: Alert[] }>("/alerts", { query }),
  reviewAlert: (id: string, body: AlertReview) =>
    request<{ ok: boolean; state: string }>(`/alerts/${id}`, { method: "PATCH", body }),

  evidenceUrl: (id: string) =>
    request<{ url: string; expiresAt: number; sha256: string }>(`/evidence/${id}/download-url`),

  getSettings: () => request<{ settings: MonitoringSettings }>("/settings/monitoring"),
  saveSettings: (body: Omit<MonitoringSettings, "version">) =>
    request<{ settings: MonitoringSettings }>("/settings/monitoring", { method: "PUT", body }),

  /** 1:N identify a live descriptor against enrolled templates (compared server-side). */
  identify: (descriptor: number[], engine: string, topK?: number) =>
    request<IdentifyResponse>("/monitor/identify", { method: "POST", body: { descriptor, engine, topK } }),

  auditLogs: (query: Record<string, string | undefined> = {}) =>
    request<{ logs: AuditLog[] }>("/audit", { query }),

  createReport: (body: { kind: string; sessionId?: string; from?: number; to?: number }) =>
    request<{ report: { id: string; rowCount: number } }>("/reports", { method: "POST", body }),

  zoomStatus: () => request<ZoomStatus>("/integrations/zoom/status"),
  zoomAuthorize: () =>
    request<{ url: string; redirectUri: string; scopes: string[] }>("/integrations/zoom/authorize"),
  zoomDisconnect: () => request<{ ok: boolean }>("/integrations/zoom", { method: "DELETE" }),
  zoomCreateMeeting: (body: { topic: string; startTime?: string; durationMin?: number }) =>
    request<ZoomCreatedMeeting>("/integrations/zoom/meetings", { method: "POST", body }),
  zoomMeetings: (type = "upcoming") =>
    request<{ meetings: ZoomMeeting[] }>("/integrations/zoom/meetings", { query: { type } }),
  zoomSyncParticipants: (sessionId: string) =>
    request<{ matched: number; unmatched: number; updated: number; total: number }>(
      "/integrations/zoom/sync-participants",
      { method: "POST", body: { sessionId } },
    ),
};

/* ------------------------------------------------------- trainee client */

export const traineeApi = {
  join: (participantId: string, token: string) =>
    request<JoinResponse>(`/trainee/session/${participantId}`, { query: { t: token } }),
  consent: (participantId: string, body: ConsentRequest) =>
    request<{ granted: boolean }>(`/trainee/session/${participantId}/consent`, {
      method: "POST",
      body,
    }),
  precheck: (participantId: string, body: PrecheckRequest) =>
    request<PrecheckResponse>(`/trainee/session/${participantId}/precheck`, {
      method: "POST",
      body,
    }),
  reauth: (token: string, body: ReauthRequest) =>
    request<{ matchScore: number; threshold: number; passed: boolean }>("/trainee/reauth", {
      method: "POST",
      token,
      body,
    }),
  sendEvents: (token: string, events: unknown[]) =>
    request<{ accepted: number; rejected: { eventId: string; reason: string }[] }>(
      "/trainee/events",
      { method: "POST", token, body: { events } },
    ),
};

/* ----------------------------------------------------------------- types */

export interface CurrentUser {
  userId: string;
  organizationId: string;
  role: "sys_admin" | "training_admin" | "auditor";
  email: string;
  name: string;
}

export interface HealthResponse {
  status: string;
  app: string;
  time: string;
  zoom: { configured: boolean; webhookConfigured: boolean };
  keys: { encryption: boolean; signing: boolean };
}

export interface NewTrainee {
  externalId: string;
  name: string;
  department?: string;
  email?: string;
}

export interface Trainee extends NewTrainee {
  id: string;
  status: string;
  createdAt: number;
  enrollmentCount: number;
  lastQuality: number | null;
}

export interface TraineeListResponse {
  trainees: Trainee[];
  total: number;
}

export interface Enrollment {
  id: string;
  engine: string;
  modelVersion: string;
  qualityScore: number;
  qualityDetail: Record<string, number | boolean> | null;
  status: string;
  createdAt: number;
  hasImage: number;
}

export interface TraineeDetailResponse {
  trainee: Trainee;
  enrollments: Enrollment[];
}

export interface ImportResult {
  created: number;
  total: number;
  skipped: { row: number; externalId: string; reason: string }[];
}

export interface QualityMetricsPayload {
  faceCount: number;
  relativeSize: number;
  yaw: number;
  pitch: number;
  brightness: number;
  sharpness: number;
  occlusion: number;
}

export interface EnrollRequest {
  descriptor: number[];
  engine: string;
  modelVersion: string;
  quality: QualityMetricsPayload;
  consent: { policyVersion: string; scope: string[] };
}

export interface NewSession {
  title: string;
  description?: string;
  startsAt: number;
  endsAt: number;
  zoomMeetingId?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  status: string;
  zoomMeetingId: string | null;
  participantCount: number;
  verifiedCount: number;
  alertCount: number;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface SessionDetailResponse {
  session: SessionSummary & { description: string | null; ruleVersion: string | null };
  zoom: { meetingId: string; meetingUuid: string | null; topic: string | null; status: string } | null;
}

export interface AssignResult {
  added: number;
  rejected: string[];
  links: { participantId: string; traineeId: string | null; joinUrl: string }[];
}

export interface Participant {
  id: string;
  traineeId: string | null;
  status: string;
  statusDetail: string | null;
  lastMatchScore: number | null;
  lastSeenAt: number | null;
  precheckAt: number | null;
  precheckAttempts: number;
  zoomDisplayName: string | null;
  zoomEmail: string | null;
  zoomJoinedAt: number | null;
  zoomLeftAt: number | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  name: string | null;
  externalId: string | null;
  department: string | null;
  email: string | null;
  hasEnrollment: number;
}

export interface MonitorResponse {
  session: { id: string; title: string; status: string; startsAt: number; endsAt: number; ruleVersion: string | null };
  participants: Participant[];
  alerts: Alert[];
  metrics: {
    total: number;
    connected: number;
    normal: number;
    needsReview: number;
    notConnected: number;
    verifiedRate: number;
    byStatus: Record<string, number>;
  };
  missed: unknown[];
}

export interface IdentifyMatch {
  traineeId: string;
  name: string;
  externalId: string;
  score: number;
}

export interface IdentifyResponse {
  threshold: number;
  enrolledTrainees: number;
  matched: boolean;
  best: IdentifyMatch | null;
  matches: IdentifyMatch[];
}

export interface MonitoringEvent {
  id: string;
  type: string;
  severity: string;
  capturedAt: number;
  durationMs: number | null;
  faceCount: number | null;
  matchScore: number | null;
  qualityScore: number | null;
  modelVersion: string | null;
  ruleVersion: string | null;
  evidenceId: string | null;
  serverAdjusted: boolean;
  quarantined: boolean;
  participantId: string;
  traineeName: string | null;
  traineeExternalId: string | null;
}

export interface Alert {
  id: string;
  sessionId: string;
  participantId: string;
  type: string;
  severity: string;
  state: string;
  summary: string;
  detail: string | null;
  occurrences: number;
  evidenceId: string | null;
  assignedTo: string | null;
  openedAt: number;
  updatedAt: number;
  ruleVersion: string | null;
  modelVersion: string | null;
  traineeName: string | null;
  traineeExternalId: string | null;
}

export interface AlertReview {
  action: "ACKNOWLEDGE" | "FALSE_POSITIVE" | "ESCALATE" | "RESOLVE" | "ASSIGN";
  reasonCode?: "GLASSES" | "LIGHTING" | "NETWORK" | "HEAD_POSE" | "OCCLUSION" | "OTHER";
  comment?: string;
  assignedTo?: string;
}

export interface MonitoringSettings {
  version: number;
  reauthIntervalSec: number;
  matchThreshold: number;
  absenceSec: number;
  eyesClosedSec: number;
  multiFaceFrames: number;
  evidenceIntervalSec: number;
  evidenceRetentionDays: number;
  precheckMaxAttempts: number;
  livenessRequired: boolean;
  imageQuality: number;
}

export interface AuditLog {
  id: string;
  actorId: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface DashboardResponse {
  sessions: {
    id: string;
    title: string;
    startsAt: number;
    endsAt: number;
    status: string;
    participantCount: number;
    alertCount: number;
  }[];
  metrics: {
    connected: number;
    normal: number;
    needsReview: number;
    notConnected: number;
    totalLive: number;
    verifiedRate: number;
    verified: number;
    assigned: number;
  };
  recentAlerts: (Pick<Alert, "id" | "sessionId" | "type" | "severity" | "state" | "summary" | "detail" | "openedAt"> & {
    traineeName: string | null;
  })[];
  trend: { date: number; count: number }[];
}

export interface ZoomStatus {
  connected: boolean;
  integration: { status: string; scope: string | null; connectedAt: number | null; expiresAt: number | null } | null;
  redirectUri: string;
  webhookUrl: string;
  configured: boolean;
  webhookConfigured: boolean;
}

export interface ZoomCreatedMeeting {
  meetingId: string;
  joinUrl: string;
  startUrl: string | null;
  password: string | null;
  topic?: string;
  startTime?: string | null;
}

export interface ZoomMeeting {
  id: number | string;
  uuid?: string;
  topic: string;
  start_time?: string;
  duration?: number;
  join_url?: string;
}

export interface JoinResponse {
  participant: { id: string; status: string; precheckAttempts: number; precheckAt: number | null };
  session: { id: string; title: string; startsAt: number; endsAt: number; status: string };
  trainee: { name: string; externalId: string } | null;
  enrolled: boolean;
  engine: string | null;
  consentPolicyVersion: string;
  rules: {
    reauthIntervalSec: number;
    absenceSec: number;
    eyesClosedSec: number;
    multiFaceFrames: number;
    evidenceIntervalSec: number;
    livenessRequired: boolean;
    precheckMaxAttempts: number;
  };
}

export interface ConsentRequest {
  token: string;
  policyVersion: string;
  scope: string[];
  granted: boolean;
}

export interface PrecheckRequest {
  token: string;
  descriptor: number[];
  engine: string;
  modelVersion: string;
  quality: QualityMetricsPayload;
  liveness: { passed: boolean; blinks: number; motionScore: number };
}

export interface PrecheckResponse {
  result: "VERIFIED" | "MISMATCH" | "QUALITY_REJECTED" | "LIVENESS_FAILED";
  matchScore?: number;
  threshold?: number;
  qualityScore?: number;
  attemptsRemaining: number;
  deviceToken?: string | null;
  deviceTokenExpiresAt?: number | null;
  escalated?: boolean;
  reasons?: string[];
}

export interface ReauthRequest {
  descriptor: number[];
  engine: string;
  modelVersion: string;
  qualityScore: number;
}

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EVIDENCE: R2Bucket;
  REPORTS: R2Bucket;
  SESSION_HUB: DurableObjectNamespace;

  APP_NAME: string;
  PUBLIC_BASE_URL: string;
  ZOOM_OAUTH_REDIRECT_PATH: string;
  EVIDENCE_URL_TTL_SECONDS: string;
  LOG_LEVEL: string;

  ZOOM_CLIENT_ID?: string;
  ZOOM_CLIENT_SECRET?: string;
  ZOOM_WEBHOOK_SECRET_TOKEN?: string;
  DATA_ENCRYPTION_KEY?: string;
  SESSION_SIGNING_KEY?: string;
}

export type Role = "sys_admin" | "training_admin" | "auditor";

export interface Actor {
  userId: string;
  organizationId: string;
  role: Role;
  email: string;
  name: string;
}

/** Trainee-side caller: scoped to exactly one session participant row. */
export interface DeviceActor {
  participantId: string;
  sessionId: string;
  organizationId: string;
}

export interface Variables {
  requestId: string;
  actor?: Actor;
  device?: DeviceActor;
}

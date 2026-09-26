/**
 * Zoom integration.
 *
 * Scope boundary (ARCHITECTURE.md §3, README): Zoom is the source of truth for
 * *who is in the meeting* — the roster, join/leave times and meeting lifecycle.
 * It is never used to pull other participants' video. Camera frames only ever
 * come from the trainee's own consented Zoomer screen.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { integrations, trainees } from "../db/schema";
import { hmacSha256Hex, seal, timingSafeEqual, unseal } from "./crypto";
import { badRequest, serverError } from "./errors";

const ZOOM_OAUTH_BASE = "https://zoom.us/oauth";
const ZOOM_API_BASE = "https://api.zoom.us/v2";

/** Minimum scopes for roster sync; must match the Zoom app's scope list. */
export const ZOOM_SCOPES = [
  "meeting:read:meeting",
  "meeting:write:meeting",
  "meeting:read:list_meetings",
  "meeting:read:participant",
  // Required by `listPastParticipants`, which backs 参加者を同期. It was
  // being called without ever being requested, so that sync could only fail
  // with a Zoom scope error. It is the only roster endpoint available on a
  // Pro plan — the live equivalent is a Dashboard API that needs Business —
  // so after a meeting ends this is what completes an attendance record that
  // missed webhooks.
  "meeting:read:list_past_participants",
  "user:read:user",
] as const;

/**
 * Canonical form of a Zoom meeting id: digits only.
 *
 * Zoom shows a meeting id as "801 755 4335" and people paste it that way, but
 * every webhook payload and API response carries "8017554335". Storing what
 * was typed meant the two never compared equal, so a session linked by hand
 * received no participants and the webhook quietly created a second, empty
 * session beside it. Normalising on the way in and on every lookup is what
 * makes a pasted id work.
 *
 * Returns null for anything with no digits, so an empty field stays unlinked
 * rather than becoming the empty string.
 */
export function normalizeMeetingId(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D+/g, "");
  return digits.length ? digits : null;
}

export interface ZoomTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  accountId?: string;
}

/* ------------------------------------------------------------------- OAuth */

export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(`${ZOOM_OAUTH_BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(
  clientId: string,
  clientSecret: string,
  body: Record<string, string>,
): Promise<ZoomTokens> {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(`${ZOOM_OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    // Zoom returns the reason in the body; surface it without leaking the secret.
    let reason = `status ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { reason?: string; error?: string };
      reason = parsed.reason ?? parsed.error ?? reason;
    } catch { /* non-JSON error body */ }
    throw badRequest(`Zoom認証に失敗しました: ${reason}`);
  }

  const data = JSON.parse(text) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

export function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<ZoomTokens> {
  return tokenRequest(clientId, clientSecret, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
}

export function refreshTokens(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<ZoomTokens> {
  return tokenRequest(clientId, clientSecret, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/* --------------------------------------------------------- token storage */

export async function saveTokens(
  d1: D1Database,
  organizationId: string,
  tokens: ZoomTokens,
  encryptionKey: string,
  connectedBy?: string,
): Promise<void> {
  const db = drizzle(d1);
  const access = await seal(tokens.accessToken, encryptionKey);
  const refresh = await seal(tokens.refreshToken, encryptionKey);
  const values = {
    status: "CONNECTED",
    accessToken: access.ciphertext,
    accessTokenIv: access.iv,
    refreshToken: refresh.ciphertext,
    refreshTokenIv: refresh.iv,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    accountId: tokens.accountId ?? null,
    updatedAt: Date.now(),
  };
  await db
    .insert(integrations)
    .values({
      id: `int_${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 26)}`,
      organizationId,
      provider: "zoom",
      connectedBy: connectedBy ?? null,
      connectedAt: Date.now(),
      ...values,
    })
    .onConflictDoUpdate({
      target: [integrations.organizationId, integrations.provider],
      set: { ...values, connectedBy: connectedBy ?? null, connectedAt: Date.now() },
    });
}

/**
 * Returns a usable access token, refreshing (and re-persisting) when it is
 * within 60s of expiry. Zoom rotates the refresh token on every use, so the new
 * one must be stored or the connection dies.
 */
export async function getAccessToken(
  d1: D1Database,
  organizationId: string,
  clientId: string,
  clientSecret: string,
  encryptionKey: string,
): Promise<string> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, "zoom")))
    .limit(1);

  const row = rows[0];
  if (!row?.accessToken || !row.accessTokenIv || !row.refreshToken || !row.refreshTokenIv) {
    throw badRequest("Zoom連携が未設定です");
  }

  if (row.expiresAt && row.expiresAt > Date.now() + 60_000) {
    return unseal({ ciphertext: row.accessToken, iv: row.accessTokenIv }, encryptionKey);
  }

  const currentRefresh = await unseal(
    { ciphertext: row.refreshToken, iv: row.refreshTokenIv },
    encryptionKey,
  );
  const refreshed = await refreshTokens(clientId, clientSecret, currentRefresh);
  await saveTokens(d1, organizationId, refreshed, encryptionKey, row.connectedBy ?? undefined);
  return refreshed.accessToken;
}

/* ----------------------------------------------------------- API client */

export async function zoomApi<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${ZOOM_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `Zoom API ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = `${message}: ${parsed.message}`;
    } catch { /* non-JSON */ }
    throw serverError(message);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface ZoomMeetingSummary {
  id: number | string;
  uuid?: string;
  topic: string;
  start_time?: string;
  duration?: number;
  join_url?: string;
  host_id?: string;
  status?: string;
}

export async function listMeetings(
  accessToken: string,
  userId = "me",
  type: "scheduled" | "live" | "upcoming" = "upcoming",
): Promise<ZoomMeetingSummary[]> {
  const data = await zoomApi<{ meetings?: ZoomMeetingSummary[] }>(
    accessToken,
    `/users/${encodeURIComponent(userId)}/meetings?type=${type}&page_size=100`,
  );
  return data.meetings ?? [];
}

export interface CreatedZoomMeeting {
  id: number | string;
  join_url: string;
  start_url?: string;
  password?: string;
  topic?: string;
  start_time?: string;
  duration?: number;
}

/**
 * Creates a Zoom meeting for the connected user. `type` 2 = scheduled (when a
 * start time is given), 1 = instant. Requires the `meeting:write:meeting` scope,
 * so the tenant must have re-authorised after that scope was added.
 */
export async function createMeeting(
  accessToken: string,
  input: { topic: string; startTime?: string; durationMin?: number; timezone?: string },
  userId = "me",
): Promise<CreatedZoomMeeting> {
  return zoomApi<CreatedZoomMeeting>(accessToken, `/users/${encodeURIComponent(userId)}/meetings`, {
    method: "POST",
    body: JSON.stringify({
      topic: input.topic,
      type: input.startTime ? 2 : 1,
      start_time: input.startTime,
      duration: input.durationMin ?? 60,
      timezone: input.timezone ?? "Asia/Tokyo",
      settings: { join_before_host: true, waiting_room: false, approval_type: 2 },
    }),
  });
}

export interface ZoomMeetingDetail {
  id: number | string;
  uuid?: string;
  topic?: string;
  host_id?: string;
  status?: string;
  start_time?: string;
  duration?: number;
  join_url?: string;
  password?: string;
  encrypted_password?: string;
  h323_password?: string;
}

/**
 * Full detail for one meeting, including its passcode.
 *
 * The bot needs the passcode to join, and a listing never includes it. Callers
 * must treat the result as a credential: it is handed to the bot over an
 * authenticated channel and never persisted.
 */
export async function getMeetingDetail(
  accessToken: string,
  meetingId: string,
): Promise<ZoomMeetingDetail> {
  return zoomApi<ZoomMeetingDetail>(accessToken, `/meetings/${encodeURIComponent(meetingId)}`);
}

export interface ZoomParticipantRecord {
  id?: string;
  user_id?: string;
  name?: string;
  user_name?: string;
  user_email?: string;
  email?: string;
  join_time?: string;
  leave_time?: string;
  participant_uuid?: string;
}

/**
 * Past-meeting roster. Used to reconcile after the fact, since webhooks are
 * at-least-once and can be missed entirely if the endpoint was down.
 * `meetingUuid` must be double-encoded when it contains `/` or `//`.
 */
export async function listPastParticipants(
  accessToken: string,
  meetingUuid: string,
): Promise<ZoomParticipantRecord[]> {
  const encoded = encodeURIComponent(encodeURIComponent(meetingUuid));
  const data = await zoomApi<{ participants?: ZoomParticipantRecord[] }>(
    accessToken,
    `/past_meetings/${encoded}/participants?page_size=300`,
  );
  return data.participants ?? [];
}

/* --------------------------------------------------------- webhook proof */

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
}

/**
 * Verifies `x-zm-signature` per Zoom's scheme:
 *   message = `v0:${x-zm-request-timestamp}:${rawBody}`
 *   expected = `v0=${HMAC_SHA256(secretToken, message)}`
 * The timestamp window blocks replay of a previously captured delivery.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secretToken: string,
  now: number = Date.now(),
  toleranceMs = 5 * 60 * 1000,
): Promise<WebhookVerification> {
  if (!signature || !timestamp) return { valid: false, reason: "署名ヘッダーがありません" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { valid: false, reason: "タイムスタンプが不正です" };
  // Zoom sends milliseconds; tolerate seconds defensively.
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs(now - tsMs) > toleranceMs) {
    return { valid: false, reason: "タイムスタンプが有効期限外です" };
  }

  const expected = `v0=${await hmacSha256Hex(secretToken, `v0:${timestamp}:${rawBody}`)}`;
  return timingSafeEqual(expected, signature)
    ? { valid: true }
    : { valid: false, reason: "署名が一致しません" };
}

/** Answer to Zoom's `endpoint.url_validation` handshake. */
export async function buildUrlValidationResponse(
  plainToken: string,
  secretToken: string,
): Promise<{ plainToken: string; encryptedToken: string }> {
  return { plainToken, encryptedToken: await hmacSha256Hex(secretToken, plainToken) };
}

/* ------------------------------------------------- participant → trainee */

export type MatchMethod = "email" | "external_id" | "name" | "manual" | "unmatched";

export interface ParticipantMatch {
  traineeId: string | null;
  method: MatchMethod;
  confidence: number;
  candidates?: { traineeId: string; name: string; reason: string }[];
}

/**
 * Normalises a display name for comparison: NFKC folds full-width characters,
 * and every space form (including U+3000) is removed so that "佐藤 美咲",
 * "佐藤　美咲" and "佐藤美咲" all compare equal.
 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .toLowerCase();
}

/**
 * Pulls a trainee-number-shaped token such as AZ-0241 or E2E-12345 out of a
 * free-form Zoom display name.
 *
 * This is a convenience for diagnostics and for the case where no roster is at
 * hand. Actual matching uses `findExternalIdInName`, which compares against the
 * organization's real identifiers rather than guessing at a format.
 */
export function extractExternalId(displayName: string): string | null {
  const normalized = displayName.normalize("NFKC");
  // Hyphenated form first (AZ-0241, E2E-12345), then a bare letter+digit run.
  const match =
    normalized.match(/\b([A-Za-z][A-Za-z0-9]{0,7}-\d{2,8})\b/) ??
    normalized.match(/\b([A-Za-z]{1,6}\d{2,8})\b/);
  return match ? match[1].toUpperCase() : null;
}

/** Comparison form for identifiers: full-width folded, spaces removed, upper-cased. */
function normalizeId(value: string): string {
  return value.normalize("NFKC").replace(/[\s\u3000]+/g, "").toUpperCase();
}

/**
 * Finds which of the organization's trainee numbers appears in a display name.
 *
 * Driven by the real roster rather than a format guess, so it works for any
 * identifier scheme the customer uses. Returns null when the name matches more
 * than one identifier, since that is genuinely ambiguous.
 */
export function findExternalIdInName(
  displayName: string,
  externalIds: string[],
): string | null {
  const haystack = normalizeId(displayName);
  if (!haystack) return null;
  const hits = externalIds.filter((id) => {
    const needle = normalizeId(id);
    // Very short identifiers would match almost anything.
    return needle.length >= 3 && haystack.includes(needle);
  });
  if (hits.length !== 1) return null;
  return hits[0];
}

/**
 * Resolves a Zoom attendee to an enrolled trainee.
 *
 * Ordered strongest-evidence-first. Anything weaker than an exact email or
 * trainee-number hit is reported with its confidence so an administrator can
 * confirm; we never silently bind a low-confidence name guess to a person's
 * biometric record.
 */
export async function matchParticipantToTrainee(
  d1: D1Database,
  organizationId: string,
  participant: { name?: string; email?: string },
): Promise<ParticipantMatch> {
  const db = drizzle(d1);
  const displayName = (participant.name ?? "").trim();
  const email = (participant.email ?? "").trim().toLowerCase();

  const roster = await db
    .select({
      id: trainees.id,
      name: trainees.name,
      email: trainees.email,
      externalId: trainees.externalId,
    })
    .from(trainees)
    .where(
      and(
        eq(trainees.organizationId, organizationId),
        isNull(trainees.deletedAt),
        eq(trainees.status, "ACTIVE"),
      ),
    );

  if (email) {
    const hit = roster.find((t) => (t.email ?? "").toLowerCase() === email);
    if (hit) return { traineeId: hit.id, method: "email", confidence: 1 };
  }

  if (displayName) {
    const externalId = findExternalIdInName(
      displayName,
      roster.map((t) => t.externalId),
    );
    if (externalId) {
      const hit = roster.find((t) => t.externalId === externalId);
      if (hit) return { traineeId: hit.id, method: "external_id", confidence: 0.95 };
    }

    const normalized = normalizeName(displayName);
    const exact = roster.filter((t) => normalizeName(t.name) === normalized);
    if (exact.length === 1) {
      return { traineeId: exact[0].id, method: "name", confidence: 0.8 };
    }
    if (exact.length > 1) {
      // Ambiguous by name alone — surface the tie rather than pick one.
      return {
        traineeId: null,
        method: "unmatched",
        confidence: 0,
        candidates: exact.map((t) => ({
          traineeId: t.id,
          name: t.name,
          reason: "同名の受講者が複数います",
        })),
      };
    }

    // Containment fallback: display names often carry a title or company prefix.
    const contained = roster.filter((t) => {
      const n = normalizeName(t.name);
      return n.length >= 3 && (normalized.includes(n) || n.includes(normalized));
    });
    if (contained.length === 1) {
      return { traineeId: contained[0].id, method: "name", confidence: 0.6 };
    }
    if (contained.length > 1) {
      return {
        traineeId: null,
        method: "unmatched",
        confidence: 0,
        candidates: contained.slice(0, 5).map((t) => ({
          traineeId: t.id,
          name: t.name,
          reason: "表示名が複数の受講者に部分一致します",
        })),
      };
    }
  }

  return { traineeId: null, method: "unmatched", confidence: 0 };
}

/** Looks up a trainee by email or trainee number, for manual binding. */
export async function findTraineeByIdentifier(
  d1: D1Database,
  organizationId: string,
  identifier: string,
): Promise<{ id: string; name: string } | null> {
  const db = drizzle(d1);
  const rows = await db
    .select({ id: trainees.id, name: trainees.name })
    .from(trainees)
    .where(
      and(
        eq(trainees.organizationId, organizationId),
        isNull(trainees.deletedAt),
        or(eq(trainees.email, identifier.toLowerCase()), eq(trainees.externalId, identifier)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

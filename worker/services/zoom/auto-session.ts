/**
 * Binds a live Zoom meeting to a training session.
 *
 * Everything downstream — the participant roster, `/bot/observe`, the ライブ監視
 * console, events, reports — is keyed on a `training_sessions` row whose
 * `zoom_meeting_id` matches the meeting. Before this module existed that row
 * had to be created by hand in advance, so an organizer who simply started a
 * meeting in their connected Zoom account saw nothing at all: the webhook found
 * no linked session and dropped every `participant_joined` on the floor.
 *
 * So: when a meeting starts in a connected account and the tenant has left
 * auto-session on, we create the session for them. It is an ordinary session
 * afterwards — nothing about it is special-cased downstream.
 */
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { integrations, trainingSessions, zoomMeetings } from "../../db/schema";
import { newId } from "../../lib/ids";
import type { Env } from "../../types";
import { getMeetingConfig } from "../monitoring/config";

/** Default window for a meeting Zoom has not told us the length of. */
const DEFAULT_DURATION_MIN = 60;

export interface MeetingMeta {
  topic?: string | null;
  startTime?: number | null;
  durationMin?: number | null;
}

export interface EnsureResult {
  session: typeof trainingSessions.$inferSelect | null;
  created: boolean;
  /** Why no session exists, when one could not be produced. */
  reason?: "disabled" | "no-meeting-id";
}

/**
 * Resolves which tenant a Zoom meeting belongs to.
 *
 * Ordered by strength of evidence:
 *   1. the Zoom account id recorded when OAuth was completed;
 *   2. the meeting id, which is already linked to exactly one tenant's session
 *      or meeting row — this keeps things working if the webhook was configured
 *      before OAuth, or if Zoom omits `account_id`;
 *   3. a single connected tenant, which is unambiguous by definition.
 * With more than one candidate and no stronger signal, we refuse to guess:
 * attributing a meeting to the wrong tenant would leak one customer's roster
 * into another's console.
 */
export async function resolveOrganizationForMeeting(
  env: Env,
  accountId?: string | null,
  meetingId?: string | null,
): Promise<string | null> {
  const db = drizzle(env.DB);

  if (accountId) {
    const rows = await db
      .select({ organizationId: integrations.organizationId })
      .from(integrations)
      .where(and(eq(integrations.provider, "zoom"), eq(integrations.accountId, accountId)))
      .limit(1);
    if (rows[0]) return rows[0].organizationId;
  }

  if (meetingId) {
    const linked = await db
      .select({ organizationId: trainingSessions.organizationId })
      .from(trainingSessions)
      .where(eq(trainingSessions.zoomMeetingId, meetingId))
      .limit(2);
    if (linked.length === 1) return linked[0].organizationId;

    // The meeting may be known from a listing or a webhook before any session
    // exists for it — that row identifies the tenant just as well.
    const known = await db
      .select({ organizationId: zoomMeetings.organizationId })
      .from(zoomMeetings)
      .where(eq(zoomMeetings.meetingId, meetingId))
      .limit(2);
    if (known.length === 1) return known[0].organizationId;
  }

  const connected = await db
    .select({ organizationId: integrations.organizationId })
    .from(integrations)
    .where(and(eq(integrations.provider, "zoom"), eq(integrations.status, "CONNECTED")))
    .limit(2);
  return connected.length === 1 ? connected[0].organizationId : null;
}

/** The session linked to this meeting, if there already is one. */
export async function findSessionForMeeting(env: Env, organizationId: string, meetingId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(trainingSessions)
    .where(
      and(
        eq(trainingSessions.organizationId, organizationId),
        eq(trainingSessions.zoomMeetingId, meetingId),
        isNull(trainingSessions.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Returns the session for a meeting, creating one if the tenant allows it.
 *
 * Idempotent: a second call for the same meeting returns the same session, so
 * it is safe on every webhook delivery and on every bot poll. Zoom delivers
 * at-least-once and the bot polls on a timer, so this is called constantly.
 */
export async function ensureSessionForMeeting(
  env: Env,
  organizationId: string,
  meetingId: string,
  meta: MeetingMeta = {},
): Promise<EnsureResult> {
  if (!meetingId) return { session: null, created: false, reason: "no-meeting-id" };

  const existing = await findSessionForMeeting(env, organizationId, meetingId);
  if (existing) return { session: existing, created: false };

  const config = await getMeetingConfig(env.DB, organizationId);
  if (!config.autoSessionEnabled) return { session: null, created: false, reason: "disabled" };

  const db = drizzle(env.DB);
  const now = Date.now();
  const startsAt = meta.startTime ?? now;
  const endsAt = startsAt + (meta.durationMin ?? DEFAULT_DURATION_MIN) * 60_000;

  const session = {
    id: newId("session"),
    organizationId,
    title: meta.topic?.trim() || `Zoomミーティング ${meetingId}`,
    description: "Zoomミーティングの開始を検知して自動作成されました。",
    startsAt,
    endsAt,
    status: "LIVE",
    zoomMeetingId: meetingId,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
  };

  try {
    await db.insert(trainingSessions).values(session);
  } catch {
    // Two concurrent deliveries can race here. The loser re-reads rather than
    // creating a duplicate session for the same meeting.
    const raced = await findSessionForMeeting(env, organizationId, meetingId);
    return { session: raced, created: false };
  }

  return { session: session as typeof trainingSessions.$inferSelect, created: true };
}

/**
 * Records what Zoom told us about a meeting.
 *
 * Shared by the webhook and the bot-assignment poller so both write the same
 * row; `meeting_uuid` in particular is what the post-meeting roster sync needs.
 */
export async function upsertZoomMeeting(
  env: Env,
  organizationId: string,
  meetingId: string,
  fields: {
    meetingUuid?: string | null;
    topic?: string | null;
    hostId?: string | null;
    joinUrl?: string | null;
    startTime?: number | null;
    duration?: number | null;
    status?: string;
  },
): Promise<void> {
  const db = drizzle(env.DB);
  const values = {
    organizationId,
    meetingId,
    lastSyncedAt: Date.now(),
    updatedAt: Date.now(),
    // Only overwrite what the caller actually knows; a webhook payload and an
    // API listing carry different subsets and neither should blank the other.
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
  };
  await db
    .insert(zoomMeetings)
    .values({ id: newId("zoomMeeting"), ...values })
    .onConflictDoUpdate({ target: [zoomMeetings.organizationId, zoomMeetings.meetingId], set: values });
}

/**
 * Zoom webhook receiver.
 *
 * Mounted outside the authenticated router: the only credential is Zoom's HMAC
 * signature over the raw body, so the body must be read as text *before* any
 * JSON parsing and verified before anything is acted on.
 *
 * Deliveries are at-least-once, so every event is deduplicated on a hash of the
 * payload; the roster is additionally reconciled on demand via
 * `POST /integrations/zoom/sync-participants`.
 */
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { sessionParticipants, trainingSessions, webhookDeliveries, zoomMeetings } from "../db/schema";
import { recordAudit } from "../lib/audit";
import { sha256Hex } from "../lib/crypto";
import { newId } from "../lib/ids";
import { publishToSession } from "../lib/realtime";
import { buildUrlValidationResponse, matchParticipantToTrainee, verifyWebhookSignature } from "../lib/zoom";
import type { Env, Variables } from "../types";
import { ensureSessionForMeeting, resolveOrganizationForMeeting } from "../services/zoom/auto-session";
import { reconcileZoomParticipant } from "./zoom";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

interface ZoomMeetingObject {
  id?: string | number;
  uuid?: string;
  topic?: string;
  host_id?: string;
  start_time?: string;
  end_time?: string;
  duration?: number;
  participant?: {
    user_id?: string;
    user_name?: string;
    id?: string;
    participant_uuid?: string;
    email?: string;
    join_time?: string;
    leave_time?: string;
  };
}

interface ZoomWebhookBody {
  event: string;
  event_ts?: number;
  payload?: {
    plainToken?: string;
    account_id?: string;
    object?: ZoomMeetingObject;
  };
}

/**
 * Tenant attribution lives in the auto-session service so that the webhook, the
 * bot-assignment poller and `/bot/observe` all agree on which customer a
 * meeting belongs to. Divergence here would mean one caller creating a session
 * under a tenant another caller refuses to serve.
 */
async function resolveOrganization(
  env: Env,
  accountId?: string,
  meetingId?: string | null,
): Promise<string | null> {
  return resolveOrganizationForMeeting(env, accountId, meetingId);
}

/** Finds the training session linked to a Zoom meeting id. */
async function findSession(env: Env, organizationId: string, meetingId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(trainingSessions)
    .where(
      and(
        eq(trainingSessions.organizationId, organizationId),
        eq(trainingSessions.zoomMeetingId, meetingId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

app.post("/", async (c) => {
  const secret = c.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (!secret) {
    console.error(JSON.stringify({ level: "error", message: "zoom webhook secret missing" }));
    return c.json({ error: "not configured" }, 503);
  }

  // Raw body first: re-serialising parsed JSON would change the bytes and break
  // the signature.
  const raw = await c.req.text();

  let body: ZoomWebhookBody;
  try {
    body = JSON.parse(raw) as ZoomWebhookBody;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  // Zoom's endpoint validation handshake is signed like any other delivery.
  if (body.event === "endpoint.url_validation" && body.payload?.plainToken) {
    const response = await buildUrlValidationResponse(body.payload.plainToken, secret);
    return c.json(response, 200);
  }

  const verification = await verifyWebhookSignature(
    raw,
    c.req.header("x-zm-signature"),
    c.req.header("x-zm-request-timestamp"),
    secret,
  );
  if (!verification.valid) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "zoom webhook signature rejected",
        reason: verification.reason,
        event: body.event,
      }),
    );
    return c.json({ error: "invalid signature" }, 401);
  }

  const db = drizzle(c.env.DB);
  const payloadHash = await sha256Hex(raw);

  // At-least-once delivery: a repeat of the identical payload is a no-op.
  try {
    await db.insert(webhookDeliveries).values({
      id: newId("webhook"),
      provider: "zoom",
      eventType: body.event,
      payloadHash,
    });
  } catch {
    return c.json({ ok: true, deduplicated: true });
  }

  const incomingMeetingId = body.payload?.object?.id != null ? String(body.payload.object.id) : null;
  const organizationId = await resolveOrganization(
    c.env,
    body.payload?.account_id,
    incomingMeetingId,
  );
  if (!organizationId) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "zoom webhook could not be attributed to an organization",
        event: body.event,
      }),
    );
    return c.json({ ok: true, ignored: "unattributed" });
  }

  const object = body.payload?.object;
  const meetingId = incomingMeetingId;
  let result: Record<string, unknown> = { ok: true };

  switch (body.event) {
    case "meeting.started": {
      if (!meetingId) break;
      await upsertMeeting(c.env, organizationId, meetingId, object, "started");
      // Creates the session when the tenant has not linked one by hand. Without
      // this, every later participant event for this meeting is discarded.
      const ensured = await ensureSessionForMeeting(c.env, organizationId, meetingId, {
        topic: object?.topic,
        startTime: object?.start_time ? Date.parse(object.start_time) : null,
        durationMin: object?.duration ?? null,
      });
      const session = ensured.session;
      if (session) {
        await db
          .update(trainingSessions)
          .set({ status: "LIVE", updatedAt: Date.now() })
          .where(eq(trainingSessions.id, session.id));
        await publishToSession(c.env, session.id, "session.metrics.updated", {
          status: "LIVE",
          zoomMeetingId: meetingId,
        });
        result = { ok: true, sessionId: session.id, status: "LIVE", createdSession: ensured.created };
      }
      break;
    }

    case "meeting.ended": {
      if (!meetingId) break;
      await upsertMeeting(c.env, organizationId, meetingId, object, "ended");
      const session = await findSession(c.env, organizationId, meetingId);
      if (session) {
        await db
          .update(trainingSessions)
          .set({ status: "COMPLETED", updatedAt: Date.now() })
          .where(eq(trainingSessions.id, session.id));
        await publishToSession(c.env, session.id, "session.metrics.updated", {
          status: "COMPLETED",
        });
        result = { ok: true, sessionId: session.id, status: "COMPLETED" };
      }
      break;
    }

    case "meeting.participant_joined": {
      const participant = object?.participant;
      if (!meetingId || !participant) break;
      // A participant event can arrive before `meeting.started` (Zoom does not
      // guarantee ordering), so the session is ensured here too.
      const session = (await ensureSessionForMeeting(c.env, organizationId, meetingId)).session;
      if (!session) {
        result = { ok: true, ignored: "no linked session" };
        break;
      }

      // This is the recognition step: turn a Zoom attendee into a known trainee.
      const reconciled = await reconcileZoomParticipant(c.env, {
        organizationId,
        sessionId: session.id,
        name: participant.user_name,
        email: participant.email,
        participantUuid: participant.participant_uuid,
        participantUserId: participant.id,
        zoomUserId: participant.user_id,
        joinedAt: participant.join_time ? Date.parse(participant.join_time) : Date.now(),
      });

      await recordAudit(c.env.DB, {
        organizationId,
        actorType: "integration",
        action: "zoom.participant_joined",
        resourceType: "session_participant",
        resourceId: reconciled.participantId,
        metadata: {
          sessionId: session.id,
          matched: Boolean(reconciled.traineeId),
          method: reconciled.method,
        },
        requestId: c.get("requestId"),
      });

      result = {
        ok: true,
        sessionId: session.id,
        participantId: reconciled.participantId,
        matched: Boolean(reconciled.traineeId),
        method: reconciled.method,
      };
      break;
    }

    case "meeting.participant_left": {
      const participant = object?.participant;
      if (!meetingId || !participant) break;
      const session = await findSession(c.env, organizationId, meetingId);
      if (!session) break;

      const leftAt = participant.leave_time ? Date.parse(participant.leave_time) : Date.now();

      // Prefer the exact Zoom participant identity.
      let rows = participant.participant_uuid
        ? await db
            .select({ id: sessionParticipants.id, status: sessionParticipants.status })
            .from(sessionParticipants)
            .where(
              and(
                eq(sessionParticipants.sessionId, session.id),
                eq(sessionParticipants.zoomParticipantUuid, participant.participant_uuid),
              ),
            )
            .limit(1)
        : [];

      // A trainee who rejoins gets a fresh participant_uuid, and a row only
      // holds the most recent one. Fall back to the same recognition logic the
      // join path uses so a leave is not silently dropped.
      if (!rows[0]) {
        const match = await matchParticipantToTrainee(c.env.DB, organizationId, {
          name: participant.user_name,
          email: participant.email,
        });
        if (match.traineeId) {
          rows = await db
            .select({ id: sessionParticipants.id, status: sessionParticipants.status })
            .from(sessionParticipants)
            .where(
              and(
                eq(sessionParticipants.sessionId, session.id),
                eq(sessionParticipants.traineeId, match.traineeId),
              ),
            )
            .limit(1);
        }
      }

      // Last resort: the display name, for an attendee we never resolved.
      if (!rows[0] && participant.user_name) {
        rows = await db
          .select({ id: sessionParticipants.id, status: sessionParticipants.status })
          .from(sessionParticipants)
          .where(
            and(
              eq(sessionParticipants.sessionId, session.id),
              eq(sessionParticipants.zoomDisplayName, participant.user_name),
            ),
          )
          .limit(1);
      }

      if (rows[0]) {
        await db
          .update(sessionParticipants)
          .set({
            zoomLeftAt: leftAt,
            // Leaving Zoom is a disconnect, not a completion: only an explicit
            // session end marks a trainee COMPLETED.
            status: rows[0].status === "COMPLETED" ? "COMPLETED" : "DISCONNECTED",
            statusDetail: "Zoomミーティングから退出しました",
            updatedAt: Date.now(),
          })
          .where(eq(sessionParticipants.id, rows[0].id));

        await publishToSession(c.env, session.id, "participant.disconnected", {
          participantId: rows[0].id,
          zoomLeftAt: leftAt,
        });
        result = { ok: true, participantId: rows[0].id, status: "DISCONNECTED" };
      } else {
        result = { ok: true, ignored: "participant not recognised on leave" };
      }
      break;
    }

    default:
      result = { ok: true, ignored: body.event };
  }

  await db
    .update(webhookDeliveries)
    .set({ organizationId, processedAt: Date.now(), result: JSON.stringify(result).slice(0, 500) })
    .where(eq(webhookDeliveries.payloadHash, payloadHash));

  return c.json(result);
});

async function upsertMeeting(
  env: Env,
  organizationId: string,
  meetingId: string,
  object: ZoomMeetingObject | undefined,
  status: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const values = {
    organizationId,
    meetingId,
    meetingUuid: object?.uuid ?? null,
    topic: object?.topic ?? null,
    hostId: object?.host_id ?? null,
    startTime: object?.start_time ? Date.parse(object.start_time) : null,
    duration: object?.duration ?? null,
    status,
    lastSyncedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db
    .insert(zoomMeetings)
    .values({ id: newId("zoomMeeting"), ...values })
    .onConflictDoUpdate({
      target: [zoomMeetings.organizationId, zoomMeetings.meetingId],
      set: values,
    });
}

export default app;

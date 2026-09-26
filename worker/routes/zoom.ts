/**
 * Zoom integration endpoints: OAuth connect/disconnect, meeting listing, and
 * roster reconciliation. The webhook receiver lives in `zoom-webhook.ts`
 * because it must stay outside the authenticated router.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import {
  integrations, sessionParticipants, trainingSessions, webhookDeliveries, zoomMeetings,
} from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { hmacSha256Base64, timingSafeEqual } from "../lib/crypto";
import { badRequest, notFound, serverError } from "../lib/errors";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import { publishToSession } from "../lib/realtime";
import {
  buildAuthorizeUrl,
  createMeeting,
  exchangeCode,
  getAccessToken,
  listMeetings,
  listPastParticipants,
  matchParticipantToTrainee,
  saveTokens,
  ZOOM_SCOPES,
  zoomApi,
} from "../lib/zoom";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function redirectUri(env: Env): string {
  return new URL(env.ZOOM_OAUTH_REDIRECT_PATH, env.PUBLIC_BASE_URL).toString();
}

/* ----------------------------------------------------------- OAuth start */

/**
 * `state` is an HMAC over the organization id, so the callback can prove which
 * tenant began the flow without a server-side session and without trusting a
 * value an attacker could forge.
 */
app.get("/authorize", requireAuth, requirePermission("integration:manage"), async (c) => {
  const actor = getActor(c);
  const clientId = c.env.ZOOM_CLIENT_ID;
  const signingKey = c.env.SESSION_SIGNING_KEY;
  if (!clientId) throw serverError("ZOOM_CLIENT_ID が未設定です");
  if (!signingKey) throw serverError("SESSION_SIGNING_KEY が未設定です");

  const issuedAt = Date.now();
  const payload = `${actor.organizationId}:${actor.userId}:${issuedAt}`;
  const sig = await hmacSha256Base64(signingKey, payload);
  const state = btoa(JSON.stringify({ o: actor.organizationId, u: actor.userId, t: issuedAt, s: sig }));

  return c.json({
    url: buildAuthorizeUrl(clientId, redirectUri(c.env), state),
    redirectUri: redirectUri(c.env),
    scopes: ZOOM_SCOPES,
  });
});

/* -------------------------------------------------------- OAuth callback */

/**
 * A browser lands here from zoom.us, so this handler must never answer with a
 * JSON error envelope the way the rest of the API does — the person clicked a
 * button and deserves to end up back on the settings screen with a readable
 * reason. Every failure path redirects; only the outcome differs.
 *
 * It also logs one structured line per attempt, because "nothing happened" is
 * otherwise indistinguishable from "Zoom never called us", and those two have
 * completely different fixes.
 */
/** How long an authorization may take from first click to callback. */
const STATE_TTL_MS = 30 * 60 * 1000;

app.get("/oauth/callback", async (c) => {
  const fail = (stage: string, reason: string) => {
    console.warn(
      JSON.stringify({ level: "warn", message: "zoom oauth callback failed", stage, reason }),
    );
    return c.redirect(
      `/settings?zoom=error&stage=${encodeURIComponent(stage)}&reason=${encodeURIComponent(reason)}`,
      302,
    );
  };

  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  console.log(
    JSON.stringify({
      level: "info",
      message: "zoom oauth callback hit",
      hasCode: Boolean(code),
      hasState: Boolean(state),
      error: error ?? null,
    }),
  );

  if (error) return fail("zoom", c.req.query("error_description") ?? error);
  if (!code || !state) return fail("request", "Zoomから code / state が返されませんでした");

  const clientId = c.env.ZOOM_CLIENT_ID;
  const clientSecret = c.env.ZOOM_CLIENT_SECRET;
  const signingKey = c.env.SESSION_SIGNING_KEY;
  const encryptionKey = c.env.DATA_ENCRYPTION_KEY;
  if (!clientId || !clientSecret) return fail("config", "Zoomアプリの資格情報が未設定です");
  if (!signingKey || !encryptionKey) return fail("config", "暗号鍵が未設定です");

  let parsed: { o: string; u: string; t: number; s: string };
  try {
    parsed = JSON.parse(atob(state));
  } catch {
    return fail("state", "stateの形式が不正です");
  }

  const expected = await hmacSha256Base64(signingKey, `${parsed.o}:${parsed.u}:${parsed.t}`);
  if (!timingSafeEqual(expected, parsed.s)) return fail("state", "stateの署名が一致しません");
  // 30 minutes, not 10. The window has to cover everything between clicking
  // "connect" and Zoom redirecting back: signing in to Zoom, two-factor, and
  // possibly an administrator approving the app. Ten minutes was short enough
  // that a normal first-time sign-in could exhaust it, turning a working setup
  // into "the flow expired". The state is HMAC-signed and binds the
  // organization and user, so the window bounds replay rather than being the
  // only thing preventing it.
  if (Date.now() - parsed.t > STATE_TTL_MS) {
    return fail("state", "認可フローの有効期限が切れています（30分）。もう一度お試しください");
  }

  let tokens;
  try {
    tokens = await exchangeCode(clientId, clientSecret, code, redirectUri(c.env));
  } catch (err) {
    // Almost always a client-secret mismatch or a redirect_uri that differs
    // from the one registered — Zoom's own message is the useful part here.
    return fail("token", err instanceof Error ? err.message : "トークン交換に失敗しました");
  }

  // Record which Zoom account this is: webhook deliveries carry only
  // `payload.account_id`, and that is how they get routed back to this tenant.
  try {
    const me = await zoomApi<{ account_id?: string }>(tokens.accessToken, "/users/me");
    tokens.accountId = me.account_id;
  } catch {
    // Non-fatal: a single connected tenant is still resolvable without it.
  }

  try {
    await saveTokens(c.env.DB, parsed.o, tokens, encryptionKey, parsed.u);
  } catch (err) {
    return fail("save", err instanceof Error ? err.message : "トークンの保存に失敗しました");
  }

  await recordAudit(c.env.DB, {
    organizationId: parsed.o,
    actorId: parsed.u,
    action: "integration.zoom.connect",
    resourceType: "integration",
    resourceId: "zoom",
    metadata: { scope: tokens.scope },
    requestId: c.get("requestId"),
  });

  console.log(
    JSON.stringify({ level: "info", message: "zoom connected", organizationId: parsed.o, scope: tokens.scope }),
  );
  return c.redirect("/settings?zoom=connected", 302);
});

/* -------------------------------------------------------------- status */

app.get("/status", requireAuth, requirePermission("settings:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      status: integrations.status,
      scope: integrations.scope,
      connectedAt: integrations.connectedAt,
      expiresAt: integrations.expiresAt,
    })
    .from(integrations)
    .where(
      and(eq(integrations.organizationId, actor.organizationId), eq(integrations.provider, "zoom")),
    )
    .limit(1);

  return c.json({
    connected: rows[0]?.status === "CONNECTED",
    integration: rows[0] ?? null,
    redirectUri: redirectUri(c.env),
    webhookUrl: new URL("/api/v1/webhooks/zoom", c.env.PUBLIC_BASE_URL).toString(),
    configured: Boolean(c.env.ZOOM_CLIENT_ID && c.env.ZOOM_CLIENT_SECRET),
    webhookConfigured: Boolean(c.env.ZOOM_WEBHOOK_SECRET_TOKEN),
  });
});

app.delete("/", requireAuth, requirePermission("integration:manage"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  await db
    .update(integrations)
    .set({
      status: "DISCONNECTED",
      accessToken: null,
      accessTokenIv: null,
      refreshToken: null,
      refreshTokenIv: null,
      expiresAt: null,
      updatedAt: Date.now(),
    })
    .where(
      and(eq(integrations.organizationId, actor.organizationId), eq(integrations.provider, "zoom")),
    );

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "integration.zoom.disconnect",
    resourceType: "integration",
    resourceId: "zoom",
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------- meetings */

app.get("/meetings", requireAuth, requirePermission("session:read"), async (c) => {
  const actor = getActor(c);
  const token = await getAccessToken(
    c.env.DB,
    actor.organizationId,
    c.env.ZOOM_CLIENT_ID!,
    c.env.ZOOM_CLIENT_SECRET!,
    c.env.DATA_ENCRYPTION_KEY!,
  );
  const type = (c.req.query("type") ?? "upcoming") as "scheduled" | "live" | "upcoming";
  const meetings = await listMeetings(token, "me", type);

  const db = drizzle(c.env.DB);
  for (const m of meetings) {
    const values = {
      organizationId: actor.organizationId,
      meetingId: String(m.id),
      meetingUuid: m.uuid ?? null,
      topic: m.topic ?? null,
      hostId: m.host_id ?? null,
      joinUrl: m.join_url ?? null,
      startTime: m.start_time ? Date.parse(m.start_time) : null,
      duration: m.duration ?? null,
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

  return c.json({ meetings });
});

/* ------------------------------------------------------- diagnostics */

/**
 * Why the organizer console is empty.
 *
 * Getting a live meeting onto ライブ監視 depends on a chain — OAuth connected,
 * the right scopes granted, webhooks configured and arriving, a session linked
 * to the meeting, analysis running. Any one link missing produces the same
 * symptom: an empty screen with nothing to act on. This reports the state of
 * each link so the answer is on the page instead of in a database.
 *
 * Read-only, and it names no participant: it is a configuration check.
 */
app.get("/diagnostics", requireAuth, requirePermission("settings:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);

  const rows = await db
    .select({
      status: integrations.status,
      scope: integrations.scope,
      accountId: integrations.accountId,
      connectedAt: integrations.connectedAt,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.organizationId, actor.organizationId),
        eq(integrations.provider, "zoom"),
      ),
    )
    .limit(1);
  const integration = rows[0] ?? null;

  const granted = new Set((integration?.scope ?? "").split(/\s+/).filter(Boolean));
  const missingScopes = ZOOM_SCOPES.filter((s) => !granted.has(s));

  // Has Zoom ever delivered anything? Zero is the signal that the event
  // subscription was never configured or never validated — which is invisible
  // from inside the app otherwise.
  const deliveries = await db
    .select({
      total: sql<number>`count(*)`,
      // Column references go through Drizzle rather than being written out,
      // so a rename cannot leave a silently failing diagnostic behind.
      lastAt: sql<number | null>`max(${webhookDeliveries.receivedAt})`,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.provider, "zoom"));

  const sessions = await db
    .select({
      total: sql<number>`count(*)`,
      live: sql<number>`sum(case when ${trainingSessions.status} = 'LIVE' then 1 else 0 end)`,
      linked: sql<number>`sum(case when ${trainingSessions.zoomMeetingId} is not null then 1 else 0 end)`,
    })
    .from(trainingSessions)
    .where(
      and(
        eq(trainingSessions.organizationId, actor.organizationId),
        isNull(trainingSessions.deletedAt),
      ),
    );

  // Ask Zoom directly. This is the check that catches a missing scope even
  // when the scope list looks plausible, because Zoom answers with the exact
  // scope it wanted.
  let liveMeetings: { ok: boolean; count?: number; error?: string } = {
    ok: false,
    error: "Zoom未接続",
  };
  if (integration?.status === "CONNECTED") {
    try {
      const token = await getAccessToken(
        c.env.DB,
        actor.organizationId,
        c.env.ZOOM_CLIENT_ID!,
        c.env.ZOOM_CLIENT_SECRET!,
        c.env.DATA_ENCRYPTION_KEY!,
      );
      liveMeetings = { ok: true, count: (await listMeetings(token, "me", "live")).length };
    } catch (err) {
      liveMeetings = { ok: false, error: err instanceof Error ? err.message : "不明なエラー" };
    }
  }

  return c.json({
    connected: integration?.status === "CONNECTED",
    connectedAt: integration?.connectedAt ?? null,
    // Null means /users/me was refused, which is itself a missing-scope signal.
    accountId: integration?.accountId ?? null,
    scopes: {
      required: ZOOM_SCOPES,
      missing: missingScopes,
      grantedCount: granted.size,
    },
    liveMeetings,
    webhooks: {
      received: Number(deliveries[0]?.total ?? 0),
      lastAt: deliveries[0]?.lastAt ?? null,
      url: `${c.env.PUBLIC_BASE_URL}/api/v1/webhooks/zoom`,
    },
    sessions: {
      total: Number(sessions[0]?.total ?? 0),
      live: Number(sessions[0]?.live ?? 0),
      linkedToZoom: Number(sessions[0]?.linked ?? 0),
    },
  });
});

/* ---------------------------------------------------- create meeting */

const createMeetingSchema = z.object({
  topic: z.string().min(1).max(200),
  startTime: z.string().optional(), // ISO 8601; omit for an instant meeting
  durationMin: z.number().int().min(5).max(1440).optional(),
});

/**
 * Creates a Zoom meeting for the connected account and returns its invitation.
 * Needs the `meeting:write:meeting` scope — if the tenant authorised before that
 * scope was added, Zoom returns 4711 and they must reconnect.
 */
app.post("/meetings", requireAuth, requirePermission("session:write"), async (c) => {
  const actor = getActor(c);
  const clientId = c.env.ZOOM_CLIENT_ID;
  const clientSecret = c.env.ZOOM_CLIENT_SECRET;
  const encryptionKey = c.env.DATA_ENCRYPTION_KEY;
  if (!clientId || !clientSecret) throw serverError("Zoomアプリの資格情報が未設定です");
  if (!encryptionKey) throw serverError("暗号鍵が未設定です");

  const body = await parseBody(c, createMeetingSchema);
  const token = await getAccessToken(c.env.DB, actor.organizationId, clientId, clientSecret, encryptionKey);

  let meeting;
  try {
    meeting = await createMeeting(token, {
      topic: body.topic,
      startTime: body.startTime,
      durationMin: body.durationMin,
    });
  } catch (err) {
    throw serverError(err instanceof Error ? err.message : "Zoomミーティングの作成に失敗しました");
  }

  const meetingId = String(meeting.id);
  const db = drizzle(c.env.DB);
  const values = {
    organizationId: actor.organizationId,
    meetingId,
    topic: meeting.topic ?? body.topic,
    joinUrl: meeting.join_url ?? null,
    startTime: meeting.start_time ? Date.parse(meeting.start_time) : null,
    duration: meeting.duration ?? null,
    lastSyncedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db
    .insert(zoomMeetings)
    .values({ id: newId("zoomMeeting"), ...values })
    .onConflictDoUpdate({ target: [zoomMeetings.organizationId, zoomMeetings.meetingId], set: values });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "zoom.meeting.create",
    resourceType: "zoom_meeting",
    resourceId: meetingId,
    metadata: { topic: values.topic },
    requestId: c.get("requestId"),
  });

  return c.json({
    meetingId,
    joinUrl: meeting.join_url,
    startUrl: meeting.start_url ?? null,
    password: meeting.password ?? null,
    topic: values.topic,
    startTime: meeting.start_time ?? null,
  });
});

/* --------------------------------------------------- roster reconcile */

const syncSchema = z.object({ sessionId: z.string().min(1) });

/**
 * Pulls the authoritative participant list from Zoom and reconciles it against
 * our session. Webhooks are at-least-once and can be missed entirely if the
 * endpoint was unreachable, so this is the catch-up path that guarantees the
 * roster eventually matches reality.
 */
app.post("/sync-participants", requireAuth, requirePermission("session:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, syncSchema);
  const db = drizzle(c.env.DB);

  const sessionRows = await db
    .select()
    .from(trainingSessions)
    .where(
      and(
        eq(trainingSessions.id, body.sessionId),
        eq(trainingSessions.organizationId, actor.organizationId),
      ),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw notFound("研修が見つかりません");
  if (!session.zoomMeetingId) throw badRequest("この研修にZoomミーティングが紐付いていません");

  const meetingRows = await db
    .select()
    .from(zoomMeetings)
    .where(
      and(
        eq(zoomMeetings.organizationId, actor.organizationId),
        eq(zoomMeetings.meetingId, session.zoomMeetingId),
      ),
    )
    .limit(1);
  const meetingUuid = meetingRows[0]?.meetingUuid;
  if (!meetingUuid) throw badRequest("Zoomミーティングの開催情報がまだありません");

  const token = await getAccessToken(
    c.env.DB,
    actor.organizationId,
    c.env.ZOOM_CLIENT_ID!,
    c.env.ZOOM_CLIENT_SECRET!,
    c.env.DATA_ENCRYPTION_KEY!,
  );
  const roster = await listPastParticipants(token, meetingUuid);

  const summary = { matched: 0, unmatched: 0, updated: 0 };
  for (const p of roster) {
    const result = await reconcileZoomParticipant(c.env, {
      organizationId: actor.organizationId,
      sessionId: session.id,
      name: p.name ?? p.user_name,
      email: p.user_email ?? p.email,
      participantUuid: p.participant_uuid,
      participantUserId: p.id,
      zoomUserId: p.user_id,
      joinedAt: p.join_time ? Date.parse(p.join_time) : undefined,
      leftAt: p.leave_time ? Date.parse(p.leave_time) : undefined,
    });
    if (result.traineeId) summary.matched++;
    else summary.unmatched++;
    if (result.updated) summary.updated++;
  }

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "integration.zoom.sync_participants",
    resourceType: "training_session",
    resourceId: session.id,
    metadata: summary,
    requestId: c.get("requestId"),
  });

  return c.json({ ...summary, total: roster.length });
});

/* ------------------------------------------------------------ internals */

export interface ZoomParticipantInput {
  organizationId: string;
  sessionId: string;
  name?: string;
  email?: string;
  participantUuid?: string;
  participantUserId?: string;
  zoomUserId?: string;
  joinedAt?: number;
  leftAt?: number;
}

/**
 * Recognises one Zoom attendee and reconciles them into the session roster.
 *
 * Resolution order (see `matchParticipantToTrainee`): exact email, then trainee
 * number embedded in the display name, then an unambiguous name match. An
 * attendee we cannot resolve is still recorded — as an unmatched row an
 * administrator can bind manually — because silently dropping an attendee would
 * hide someone who is actually in the training.
 */
export async function reconcileZoomParticipant(
  env: Env,
  input: ZoomParticipantInput,
): Promise<{ participantId: string; traineeId: string | null; updated: boolean; method: string }> {
  const db = drizzle(env.DB);

  // 1. Same Zoom attendee already reconciled for this session?
  if (input.participantUuid) {
    const existing = await db
      .select()
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, input.sessionId),
          eq(sessionParticipants.zoomParticipantUuid, input.participantUuid),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await db
        .update(sessionParticipants)
        .set({
          zoomJoinedAt: input.joinedAt ?? existing[0].zoomJoinedAt,
          zoomLeftAt: input.leftAt ?? existing[0].zoomLeftAt,
          updatedAt: Date.now(),
        })
        .where(eq(sessionParticipants.id, existing[0].id));
      return {
        participantId: existing[0].id,
        traineeId: existing[0].traineeId,
        updated: true,
        method: existing[0].matchMethod ?? "unmatched",
      };
    }
  }

  // 1b. Same Zoom user id within this session?
  //
  // The Meeting-SDK bot reports `zoomUserId` on every observation but has no
  // participant UUID unless Zoom supplies a persistent id, and an attendee who
  // matches no trainee falls through to the INSERT below. Without this lookup
  // every observation of an unrecognised attendee created another participant
  // row — one person appearing on ライブ監視 once per sample. The id is stable
  // for the duration of a meeting, which is exactly the scope we need it for.
  if (input.zoomUserId) {
    const existing = await db
      .select()
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, input.sessionId),
          eq(sessionParticipants.zoomUserId, input.zoomUserId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await db
        .update(sessionParticipants)
        .set({
          zoomParticipantUuid: input.participantUuid ?? existing[0].zoomParticipantUuid,
          zoomDisplayName: input.name ?? existing[0].zoomDisplayName,
          zoomJoinedAt: input.joinedAt ?? existing[0].zoomJoinedAt,
          zoomLeftAt: input.leftAt ?? existing[0].zoomLeftAt,
          updatedAt: Date.now(),
        })
        .where(eq(sessionParticipants.id, existing[0].id));
      return {
        participantId: existing[0].id,
        traineeId: existing[0].traineeId,
        updated: true,
        method: existing[0].matchMethod ?? "unmatched",
      };
    }
  }

  const match = await matchParticipantToTrainee(env.DB, input.organizationId, {
    name: input.name,
    email: input.email,
  });

  // 2. Trainee already assigned to this session (the normal pre-assigned case):
  //    attach the Zoom identity to their existing row rather than duplicating.
  if (match.traineeId) {
    const assigned = await db
      .select()
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, input.sessionId),
          eq(sessionParticipants.traineeId, match.traineeId),
        ),
      )
      .limit(1);

    if (assigned[0]) {
      await db
        .update(sessionParticipants)
        .set({
          zoomParticipantUuid: input.participantUuid ?? assigned[0].zoomParticipantUuid,
          zoomParticipantUserId: input.participantUserId ?? assigned[0].zoomParticipantUserId,
          zoomUserId: input.zoomUserId ?? assigned[0].zoomUserId,
          zoomDisplayName: input.name ?? assigned[0].zoomDisplayName,
          zoomEmail: input.email?.toLowerCase() ?? assigned[0].zoomEmail,
          zoomJoinedAt: input.joinedAt ?? assigned[0].zoomJoinedAt,
          zoomLeftAt: input.leftAt ?? assigned[0].zoomLeftAt,
          matchMethod: match.method,
          matchConfidence: match.confidence,
          updatedAt: Date.now(),
        })
        .where(eq(sessionParticipants.id, assigned[0].id));

      await publishToSession(env, input.sessionId, "participant.status.changed", {
        participantId: assigned[0].id,
        traineeId: match.traineeId,
        zoomDisplayName: input.name,
        matchMethod: match.method,
        matchConfidence: match.confidence,
        zoomJoinedAt: input.joinedAt,
      });

      return {
        participantId: assigned[0].id,
        traineeId: match.traineeId,
        updated: true,
        method: match.method,
      };
    }
  }

  // 2b. Last resort before creating a row: an attendee we already recorded
  //     under the same display name in this session. Mirrors the leave path in
  //     `zoom-webhook.ts`, and covers a provider that reports neither a UUID
  //     nor a stable user id.
  if (!match.traineeId && input.name) {
    const sameName = await db
      .select()
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, input.sessionId),
          eq(sessionParticipants.zoomDisplayName, input.name),
          isNull(sessionParticipants.traineeId),
        ),
      )
      .limit(2);
    // Two attendees sharing a display name is genuinely ambiguous; record a new
    // row rather than merging two people into one.
    if (sameName.length === 1) {
      await db
        .update(sessionParticipants)
        .set({
          zoomUserId: input.zoomUserId ?? sameName[0].zoomUserId,
          zoomParticipantUuid: input.participantUuid ?? sameName[0].zoomParticipantUuid,
          zoomLeftAt: input.leftAt ?? sameName[0].zoomLeftAt,
          updatedAt: Date.now(),
        })
        .where(eq(sessionParticipants.id, sameName[0].id));
      return {
        participantId: sameName[0].id,
        traineeId: null,
        updated: true,
        method: sameName[0].matchMethod ?? "unmatched",
      };
    }
  }

  // 3. Someone joined who was not pre-assigned (matched or not): record them.
  const id = newId("participant");
  await db.insert(sessionParticipants).values({
    id,
    organizationId: input.organizationId,
    sessionId: input.sessionId,
    traineeId: match.traineeId,
    status: "PRECHECK_PENDING",
    statusDetail: match.traineeId ? "Zoom参加を検出しました" : "未照合のZoom参加者です",
    zoomParticipantUuid: input.participantUuid ?? null,
    zoomParticipantUserId: input.participantUserId ?? null,
    zoomUserId: input.zoomUserId ?? null,
    zoomDisplayName: input.name ?? null,
    zoomEmail: input.email?.toLowerCase() ?? null,
    zoomJoinedAt: input.joinedAt ?? Date.now(),
    zoomLeftAt: input.leftAt ?? null,
    matchMethod: match.method,
    matchConfidence: match.confidence,
  });

  await publishToSession(env, input.sessionId, "participant.status.changed", {
    participantId: id,
    traineeId: match.traineeId,
    zoomDisplayName: input.name,
    matchMethod: match.method,
    matchConfidence: match.confidence,
    candidates: match.candidates,
    zoomJoinedAt: input.joinedAt,
  });

  return { participantId: id, traineeId: match.traineeId, updated: false, method: match.method };
}

export default app;

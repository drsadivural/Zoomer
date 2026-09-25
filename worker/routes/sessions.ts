import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import {
  alerts,
  monitoringEvents,
  sessionParticipants,
  trainees,
  trainingSessions,
  zoomMeetings,
} from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { withIdempotency } from "../lib/idempotency";
import { badRequest, conflict, notFound, serverError } from "../lib/errors";
import { buildJoinUrl, signJoinToken } from "../lib/join";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import { getRules, ruleVersionTag } from "../lib/settings";
import type { Env, Variables } from "../types";
import { publishToSession } from "../lib/realtime";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);
app.use("*", withIdempotency());

/* ------------------------------------------------------------------ list */

app.get("/", requirePermission("session:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const status = c.req.query("status");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const filters = [
    eq(trainingSessions.organizationId, actor.organizationId),
    isNull(trainingSessions.deletedAt),
  ];
  if (status) filters.push(eq(trainingSessions.status, status));
  if (from) filters.push(gte(trainingSessions.startsAt, Number(from)));
  if (to) filters.push(lte(trainingSessions.startsAt, Number(to)));

  const rows = await db
    .select({
      id: trainingSessions.id,
      title: trainingSessions.title,
      startsAt: trainingSessions.startsAt,
      endsAt: trainingSessions.endsAt,
      status: trainingSessions.status,
      zoomMeetingId: trainingSessions.zoomMeetingId,
      /* Written out, not interpolated — see the note in routes/trainees.ts.
         Interpolated, every one of these compared a row's foreign key to its
         own id, so the session list reported 0 participants and 0 alerts
         however many there were. */
      participantCount: sql<number>`(
        select count(*) from session_participants sp
        where sp.session_id = training_sessions.id
      )`,
      verifiedCount: sql<number>`(
        select count(*) from session_participants sp
        where sp.session_id = training_sessions.id
          and sp.status in ('VERIFIED','MONITORING','REVIEWED','COMPLETED')
      )`,
      alertCount: sql<number>`(
        select count(*) from alerts a
        where a.session_id = training_sessions.id and a.state = 'OPEN'
      )`,
    })
    .from(trainingSessions)
    .where(and(...filters))
    .orderBy(desc(trainingSessions.startsAt))
    .limit(Math.min(Number(c.req.query("limit") ?? 100), 200));

  return c.json({ sessions: rows });
});

/* ---------------------------------------------------------------- create */

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  startsAt: z.number().int().positive(),
  endsAt: z.number().int().positive(),
  zoomMeetingId: z.string().max(64).optional(),
});

app.post("/", requirePermission("session:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, createSchema);
  if (body.endsAt <= body.startsAt) throw badRequest("終了時刻は開始時刻より後にしてください");

  const db = drizzle(c.env.DB);
  const id = newId("session");
  await db.insert(trainingSessions).values({
    id,
    organizationId: actor.organizationId,
    title: body.title,
    description: body.description ?? null,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    zoomMeetingId: body.zoomMeetingId ?? null,
    createdBy: actor.userId,
  });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "session.create",
    resourceType: "training_session",
    resourceId: id,
    metadata: { title: body.title, zoomMeetingId: body.zoomMeetingId },
    requestId: c.get("requestId"),
  });

  return c.json({ session: { id, ...body } }, 201);
});

/* ---------------------------------------------------------------- detail */

async function loadSession(env: Env, organizationId: string, sessionId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(trainingSessions)
    .where(
      and(
        eq(trainingSessions.id, sessionId),
        eq(trainingSessions.organizationId, organizationId),
        isNull(trainingSessions.deletedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("研修が見つかりません");
  return rows[0];
}

app.get("/:id", requirePermission("session:read"), async (c) => {
  const actor = getActor(c);
  const session = await loadSession(c.env, actor.organizationId, c.req.param("id"));
  const db = drizzle(c.env.DB);

  let zoom = null;
  if (session.zoomMeetingId) {
    const rows = await db
      .select()
      .from(zoomMeetings)
      .where(
        and(
          eq(zoomMeetings.organizationId, actor.organizationId),
          eq(zoomMeetings.meetingId, session.zoomMeetingId),
        ),
      )
      .limit(1);
    zoom = rows[0] ?? null;
  }
  return c.json({ session, zoom });
});

const patchSchema = createSchema.partial().extend({
  status: z.enum(["SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
});

app.patch("/:id", requirePermission("session:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, patchSchema);
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  await loadSession(c.env, actor.organizationId, id);

  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  for (const key of ["title", "description", "startsAt", "endsAt", "zoomMeetingId", "status"] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }

  // Freeze the rules in force at go-live so later settings edits cannot
  // retroactively re-grade this session's events.
  if (body.status === "LIVE") {
    const rules = await getRules(c.env.DB, actor.organizationId);
    patch.ruleVersion = ruleVersionTag(actor.organizationId, rules.version);
    patch.ruleSnapshot = rules as unknown as Record<string, number | boolean>;
  }

  await db.update(trainingSessions).set(patch).where(eq(trainingSessions.id, id));
  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "session.update",
    resourceType: "training_session",
    resourceId: id,
    metadata: body,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

/* ---------------------------------------------------------- participants */

const assignSchema = z.object({ traineeIds: z.array(z.string()).min(1).max(1000) });

app.post("/:id/participants", requirePermission("session:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, assignSchema);
  const sessionId = c.req.param("id");
  const session = await loadSession(c.env, actor.organizationId, sessionId);
  const db = drizzle(c.env.DB);

  // Cross-tenant guard: only trainees belonging to this organization may be assigned.
  const valid = await db
    .select({ id: trainees.id })
    .from(trainees)
    .where(
      and(
        eq(trainees.organizationId, actor.organizationId),
        isNull(trainees.deletedAt),
        inArray(trainees.id, body.traineeIds),
      ),
    );
  const validIds = new Set(valid.map((v) => v.id));
  const rejected = body.traineeIds.filter((id) => !validIds.has(id));

  const already = await db
    .select({ traineeId: sessionParticipants.traineeId })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, sessionId));
  const existing = new Set(already.map((a) => a.traineeId));

  const toInsert = [...validIds]
    .filter((id) => !existing.has(id))
    .map((traineeId) => ({
      id: newId("participant"),
      organizationId: actor.organizationId,
      sessionId,
      traineeId,
    }));

  for (let i = 0; i < toInsert.length; i += 50) {
    await db.insert(sessionParticipants).values(toInsert.slice(i, i + 50));
  }

  const signingKey = c.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw serverError("SESSION_SIGNING_KEY が未設定です");
  const expiresAt = session.endsAt + 60 * 60 * 1000;
  const links = await Promise.all(
    toInsert.map(async (p) => ({
      participantId: p.id,
      traineeId: p.traineeId,
      joinUrl: buildJoinUrl(
        c.env.PUBLIC_BASE_URL,
        p.id,
        await signJoinToken(p.id, expiresAt, signingKey),
      ),
    })),
  );

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "session.participants.assign",
    resourceType: "training_session",
    resourceId: sessionId,
    metadata: { added: toInsert.length, rejected: rejected.length },
    requestId: c.get("requestId"),
  });

  return c.json({ added: toInsert.length, rejected, links }, 201);
});

app.get("/:id/participants", requirePermission("session:read"), async (c) => {
  const actor = getActor(c);
  const sessionId = c.req.param("id");
  await loadSession(c.env, actor.organizationId, sessionId);
  const db = drizzle(c.env.DB);

  const rows = await db
    .select({
      id: sessionParticipants.id,
      traineeId: sessionParticipants.traineeId,
      status: sessionParticipants.status,
      statusDetail: sessionParticipants.statusDetail,
      lastMatchScore: sessionParticipants.lastMatchScore,
      lastSeenAt: sessionParticipants.lastSeenAt,
      precheckAt: sessionParticipants.precheckAt,
      precheckAttempts: sessionParticipants.precheckAttempts,
      zoomDisplayName: sessionParticipants.zoomDisplayName,
      zoomEmail: sessionParticipants.zoomEmail,
      zoomJoinedAt: sessionParticipants.zoomJoinedAt,
      zoomLeftAt: sessionParticipants.zoomLeftAt,
      matchMethod: sessionParticipants.matchMethod,
      matchConfidence: sessionParticipants.matchConfidence,
      name: trainees.name,
      externalId: trainees.externalId,
      department: trainees.department,
      email: trainees.email,
      hasEnrollment: sql<number>`(
        select count(*) from face_enrollments fe
        where fe.trainee_id = ${sessionParticipants.traineeId}
          and fe.status = 'ACTIVE' and fe.deleted_at is null
      )`,
    })
    .from(sessionParticipants)
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        eq(sessionParticipants.organizationId, actor.organizationId),
      ),
    )
    .orderBy(asc(sessionParticipants.createdAt));

  return c.json({ participants: rows });
});

/** Manually bind a Zoom attendee that automatic matching could not resolve. */
const bindSchema = z.object({ traineeId: z.string().min(1) });

app.post("/:id/participants/:participantId/bind", requirePermission("session:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, bindSchema);
  const sessionId = c.req.param("id");
  const participantId = c.req.param("participantId");
  await loadSession(c.env, actor.organizationId, sessionId);
  const db = drizzle(c.env.DB);

  const trainee = await db
    .select({ id: trainees.id, name: trainees.name })
    .from(trainees)
    .where(
      and(
        eq(trainees.id, body.traineeId),
        eq(trainees.organizationId, actor.organizationId),
        isNull(trainees.deletedAt),
      ),
    )
    .limit(1);
  if (!trainee[0]) throw notFound("受講者が見つかりません");

  const clash = await db
    .select({ id: sessionParticipants.id })
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        eq(sessionParticipants.traineeId, body.traineeId),
      ),
    )
    .limit(1);
  if (clash[0] && clash[0].id !== participantId) {
    throw conflict("この受講者は既に別の参加者レコードに紐付いています");
  }

  const result = await db
    .update(sessionParticipants)
    .set({
      traineeId: body.traineeId,
      matchMethod: "manual",
      matchConfidence: 1,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(sessionParticipants.id, participantId),
        eq(sessionParticipants.organizationId, actor.organizationId),
      ),
    );
  if (!result.meta.changes) throw notFound("参加者が見つかりません");

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "session.participant.bind",
    resourceType: "session_participant",
    resourceId: participantId,
    metadata: { traineeId: body.traineeId, method: "manual" },
    requestId: c.get("requestId"),
  });

  await publishToSession(c.env, sessionId, "participant.status.changed", {
    participantId,
    traineeId: body.traineeId,
    matchMethod: "manual",
  });

  return c.json({ ok: true });
});

/** Re-issues a join link for one participant (e.g. the trainee lost the mail). */
app.post("/:id/participants/:participantId/join-link", requirePermission("session:write"), async (c) => {
  const actor = getActor(c);
  const sessionId = c.req.param("id");
  const participantId = c.req.param("participantId");
  const session = await loadSession(c.env, actor.organizationId, sessionId);
  const signingKey = c.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw serverError("SESSION_SIGNING_KEY が未設定です");

  const db = drizzle(c.env.DB);
  const rows = await db
    .select({ id: sessionParticipants.id })
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.id, participantId),
        eq(sessionParticipants.organizationId, actor.organizationId),
        eq(sessionParticipants.sessionId, sessionId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("参加者が見つかりません");

  const expiresAt = session.endsAt + 60 * 60 * 1000;
  const token = await signJoinToken(participantId, expiresAt, signingKey);
  return c.json({ joinUrl: buildJoinUrl(c.env.PUBLIC_BASE_URL, participantId, token), expiresAt });
});

/* --------------------------------------------------------------- monitor */

app.get("/:id/monitor", requirePermission("session:read"), async (c) => {
  const actor = getActor(c);
  const sessionId = c.req.param("id");
  const session = await loadSession(c.env, actor.organizationId, sessionId);
  const db = drizzle(c.env.DB);
  const since = Number(c.req.query("since") ?? "0");

  const participants = await db
    .select({
      id: sessionParticipants.id,
      traineeId: sessionParticipants.traineeId,
      status: sessionParticipants.status,
      statusDetail: sessionParticipants.statusDetail,
      lastMatchScore: sessionParticipants.lastMatchScore,
      lastSeenAt: sessionParticipants.lastSeenAt,
      precheckAt: sessionParticipants.precheckAt,
      zoomDisplayName: sessionParticipants.zoomDisplayName,
      zoomJoinedAt: sessionParticipants.zoomJoinedAt,
      matchMethod: sessionParticipants.matchMethod,
      matchConfidence: sessionParticipants.matchConfidence,
      name: trainees.name,
      externalId: trainees.externalId,
    })
    .from(sessionParticipants)
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        eq(sessionParticipants.organizationId, actor.organizationId),
      ),
    )
    .orderBy(asc(sessionParticipants.createdAt));

  const openAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.sessionId, sessionId),
        eq(alerts.organizationId, actor.organizationId),
        inArray(alerts.state, ["OPEN", "ESCALATED"]),
      ),
    )
    .orderBy(desc(alerts.openedAt))
    .limit(100);

  // Recovery path for a dashboard that dropped its socket.
  let missed: unknown[] = [];
  if (since > 0) {
    const stub = c.env.SESSION_HUB.get(c.env.SESSION_HUB.idFromName(sessionId));
    const res = await stub.fetch(`https://hub/since?since=${since}`);
    if (res.ok) missed = ((await res.json()) as { events: unknown[] }).events;
  }

  const counts = participants.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});

  return c.json({
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      ruleVersion: session.ruleVersion,
    },
    participants,
    alerts: openAlerts,
    metrics: {
      total: participants.length,
      connected: participants.filter((p) => p.status !== "DISCONNECTED" && p.status !== "PRECHECK_PENDING").length,
      normal: counts.MONITORING ?? 0,
      needsReview: (counts.ALERT ?? 0) + (counts.WARNING ?? 0),
      notConnected: counts.PRECHECK_PENDING ?? 0,
      verifiedRate: participants.length
        ? participants.filter((p) => p.precheckAt || p.status !== "PRECHECK_PENDING").length / participants.length
        : 0,
      byStatus: counts,
    },
    missed,
  });
});

/* ---------------------------------------------------------- event search */

app.get("/:id/events", requirePermission("session:read"), async (c) => {
  const actor = getActor(c);
  const sessionId = c.req.param("id");
  await loadSession(c.env, actor.organizationId, sessionId);
  const db = drizzle(c.env.DB);

  const filters = [
    eq(monitoringEvents.organizationId, actor.organizationId),
    eq(monitoringEvents.sessionId, sessionId),
  ];
  const type = c.req.query("type");
  const severity = c.req.query("severity");
  const participantId = c.req.query("participantId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (type) filters.push(eq(monitoringEvents.type, type));
  if (severity) filters.push(eq(monitoringEvents.severity, severity));
  if (participantId) filters.push(eq(monitoringEvents.participantId, participantId));
  if (from) filters.push(gte(monitoringEvents.capturedAt, Number(from)));
  if (to) filters.push(lte(monitoringEvents.capturedAt, Number(to)));

  const rows = await db
    .select({
      id: monitoringEvents.id,
      type: monitoringEvents.type,
      severity: monitoringEvents.severity,
      capturedAt: monitoringEvents.capturedAt,
      durationMs: monitoringEvents.durationMs,
      faceCount: monitoringEvents.faceCount,
      matchScore: monitoringEvents.matchScore,
      qualityScore: monitoringEvents.qualityScore,
      modelVersion: monitoringEvents.modelVersion,
      ruleVersion: monitoringEvents.ruleVersion,
      evidenceId: monitoringEvents.evidenceId,
      serverAdjusted: monitoringEvents.serverAdjusted,
      quarantined: monitoringEvents.quarantined,
      participantId: monitoringEvents.participantId,
      traineeName: trainees.name,
      traineeExternalId: trainees.externalId,
    })
    .from(monitoringEvents)
    .leftJoin(sessionParticipants, eq(sessionParticipants.id, monitoringEvents.participantId))
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(and(...filters))
    .orderBy(desc(monitoringEvents.capturedAt))
    .limit(Math.min(Number(c.req.query("limit") ?? 100), 500));

  return c.json({ events: rows });
});

export { loadSession };
export default app;

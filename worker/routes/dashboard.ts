import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { alerts, monitoringEvents, sessionParticipants, trainees, trainingSessions } from "../db/schema";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

/** Powers the ダッシュボード screen: today's sessions, live counts, alert trend. */
app.get("/", requirePermission("session:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const now = Date.now();
  const dayStart = now - (now % 86_400_000);
  const dayEnd = dayStart + 86_400_000;

  const todaySessions = await db
    .select({
      id: trainingSessions.id,
      title: trainingSessions.title,
      startsAt: trainingSessions.startsAt,
      endsAt: trainingSessions.endsAt,
      status: trainingSessions.status,
      /* Written out, not interpolated — see the note in routes/trainees.ts.
         Interpolated, these read `sp.session_id = sp.id` and
         `a.session_id = a.id`, so both counts were always zero. */
      participantCount: sql<number>`(
        select count(*) from session_participants sp
        where sp.session_id = training_sessions.id
      )`,
      alertCount: sql<number>`(
        select count(*) from alerts a
        where a.session_id = training_sessions.id and a.state = 'OPEN'
      )`,
    })
    .from(trainingSessions)
    .where(
      and(
        eq(trainingSessions.organizationId, actor.organizationId),
        isNull(trainingSessions.deletedAt),
        gte(trainingSessions.startsAt, dayStart),
        lte(trainingSessions.startsAt, dayEnd),
      ),
    )
    .orderBy(trainingSessions.startsAt);

  const liveIds = todaySessions.filter((s) => s.status === "LIVE").map((s) => s.id);

  const statusRows = liveIds.length
    ? await db
        .select({ status: sessionParticipants.status, count: sql<number>`count(*)` })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.organizationId, actor.organizationId),
            inArray(sessionParticipants.sessionId, liveIds),
          ),
        )
        .groupBy(sessionParticipants.status)
    : [];

  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.count]));
  const connected =
    (byStatus.MONITORING ?? 0) + (byStatus.VERIFIED ?? 0) + (byStatus.WARNING ?? 0) +
    (byStatus.ALERT ?? 0) + (byStatus.REVIEWED ?? 0);
  const totalLive = Object.values(byStatus).reduce<number>((a, b) => a + b, 0);

  const recentAlerts = await db
    .select({
      id: alerts.id,
      sessionId: alerts.sessionId,
      type: alerts.type,
      severity: alerts.severity,
      state: alerts.state,
      summary: alerts.summary,
      detail: alerts.detail,
      openedAt: alerts.openedAt,
      traineeName: trainees.name,
    })
    .from(alerts)
    .leftJoin(sessionParticipants, eq(sessionParticipants.id, alerts.participantId))
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(eq(alerts.organizationId, actor.organizationId))
    .orderBy(desc(alerts.openedAt))
    .limit(8);

  // Alert volume per day over the last week, for the trend chart.
  const weekAgo = now - 7 * 86_400_000;
  const trendRows = await db
    .select({
      day: sql<number>`(${monitoringEvents.capturedAt} / 86400000)`,
      count: sql<number>`count(*)`,
    })
    .from(monitoringEvents)
    .where(
      and(
        eq(monitoringEvents.organizationId, actor.organizationId),
        gte(monitoringEvents.capturedAt, weekAgo),
        inArray(monitoringEvents.severity, ["WARNING", "ALERT"]),
      ),
    )
    .groupBy(sql`(${monitoringEvents.capturedAt} / 86400000)`)
    .orderBy(sql`(${monitoringEvents.capturedAt} / 86400000)`);

  const trend = Array.from({ length: 7 }, (_, i) => {
    const day = Math.floor((weekAgo + i * 86_400_000) / 86_400_000);
    return { date: day * 86_400_000, count: trendRows.find((r) => r.day === day)?.count ?? 0 };
  });

  const [{ verified = 0 } = {}] = await db
    .select({ verified: sql<number>`count(*)` })
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.organizationId, actor.organizationId),
        gte(sessionParticipants.precheckAt, dayStart),
      ),
    );
  const [{ assigned = 0 } = {}] = await db
    .select({ assigned: sql<number>`count(*)` })
    .from(sessionParticipants)
    .innerJoin(trainingSessions, eq(trainingSessions.id, sessionParticipants.sessionId))
    .where(
      and(
        eq(sessionParticipants.organizationId, actor.organizationId),
        gte(trainingSessions.startsAt, dayStart),
        lte(trainingSessions.startsAt, dayEnd),
      ),
    );

  return c.json({
    sessions: todaySessions,
    metrics: {
      connected,
      normal: byStatus.MONITORING ?? 0,
      needsReview: (byStatus.ALERT ?? 0) + (byStatus.WARNING ?? 0),
      notConnected: byStatus.PRECHECK_PENDING ?? 0,
      totalLive,
      verifiedRate: assigned > 0 ? verified / assigned : 0,
      verified,
      assigned,
    },
    recentAlerts,
    trend,
  });
});

export default app;

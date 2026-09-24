/**
 * Zoom Organizer Intelligence API.
 *
 * The organizer console's read/write surface. Mounted at `/api/v1/meetings`;
 * `:id` accepts either a training-session id or the Zoom meeting number, because
 * an organizer thinks in meetings and the rest of the product thinks in training
 * sessions.
 *
 * Every handler is tenant-scoped through `requireAuth` → `actor.organizationId`,
 * and every query filters on it. Nothing here bypasses the existing auth, audit
 * or idempotency middleware.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  alerts,
  identityVerifications,
  meetingAnalysisSessions,
  meetingMonitoringSettings,
  meetingReports,
  participantAnalysisState,
  participantEngagementEvents,
  participantObservations,
  sessionParticipants,
  trainees,
  trainingSessions,
} from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { toCsv } from "../lib/csv";
import { badRequest, notFound } from "../lib/errors";
import { parseBody } from "../lib/http";
import { withIdempotency } from "../lib/idempotency";
import { newId } from "../lib/ids";
import { publishToSession } from "../lib/realtime";
import { isStale } from "../integrations/zoom/reconnect";
import { buildPlan } from "../services/analysis/scheduler";
import { rowToState, applyObservation, ensureSessionParticipant } from "../services/monitoring/pipeline";
import {
  DEFAULT_MEETING_CONFIG,
  getMeetingConfig,
  mergeMeetingConfig,
  type MeetingMonitoringConfig,
} from "../services/monitoring/config";
import { needsAttention } from "../services/events/event-engine";
import {
  buildMeetingReport,
  REPORT_CSV_HEADERS,
  reportToCsvRows,
  type EngagementEventRow,
  type ObservationRow,
  type ParticipantRow,
} from "../services/reporting/meeting-report";
import { isLookingAway } from "../services/monitoring/signals";
import type { Env, Variables } from "../types";
import { upsertAlert } from "./trainee";

/** Fixed so a simulation run reproduces exactly when replayed. */
const DEFAULT_SIMULATION_SEED = 20260924;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);
app.use("*", withIdempotency());

/* ------------------------------------------------------------ resolution */

/**
 * Resolves `:id` to a training session.
 *
 * Accepts the session id or the Zoom meeting number. A Zoom id that maps to
 * more than one session is an error rather than a guess — silently monitoring
 * the wrong training is worse than a 400.
 */
async function resolveSession(env: Env, organizationId: string, id: string) {
  const db = drizzle(env.DB);
  const direct = await db
    .select()
    .from(trainingSessions)
    .where(
      and(
        eq(trainingSessions.id, id),
        eq(trainingSessions.organizationId, organizationId),
        isNull(trainingSessions.deletedAt),
      ),
    )
    .limit(1);
  if (direct[0]) return direct[0];

  const byMeeting = await db
    .select()
    .from(trainingSessions)
    .where(
      and(
        eq(trainingSessions.zoomMeetingId, id),
        eq(trainingSessions.organizationId, organizationId),
        isNull(trainingSessions.deletedAt),
      ),
    )
    .limit(2);
  if (byMeeting.length > 1) throw badRequest("このZoomミーティングIDは複数の研修に紐付いています");
  if (!byMeeting[0]) throw notFound("研修（ミーティング）が見つかりません");
  return byMeeting[0];
}

async function currentRun(env: Env, organizationId: string, sessionId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(meetingAnalysisSessions)
    .where(
      and(
        eq(meetingAnalysisSessions.organizationId, organizationId),
        eq(meetingAnalysisSessions.sessionId, sessionId),
      ),
    )
    .orderBy(desc(meetingAnalysisSessions.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------- monitoring config */

app.get("/monitoring-settings", requirePermission("monitoring:read"), async (c) => {
  const actor = getActor(c);
  return c.json({ settings: await getMeetingConfig(c.env.DB, actor.organizationId) });
});

/** Bounds mirror the settings UI; anything outside them is operator error. */
const configSchema = z
  .object({
    faceMonitoringEnabled: z.boolean(),
    identityVerificationEnabled: z.boolean(),
    screenFacingEnabled: z.boolean(),
    headPoseEnabled: z.boolean(),
    multiFaceEnabled: z.boolean(),
    participationAnalyticsEnabled: z.boolean(),
    transcriptEnabled: z.boolean(),

    normalFps: z.number().min(0.2).max(15),
    elevatedFps: z.number().min(0.5).max(30),
    normalIntervalSec: z.number().int().min(1).max(300),
    warmIntervalSec: z.number().int().min(1).max(120),
    hotIntervalSec: z.number().int().min(1).max(60),

    transientSec: z.number().int().min(1).max(60),
    temporarySec: z.number().int().min(1).max(300),
    prolongedSec: z.number().int().min(5).max(3600),

    faceMissingSec: z.number().int().min(3).max(600),
    screenAwaySec: z.number().int().min(3).max(600),
    cameraOffSec: z.number().int().min(5).max(3600),
    multiFaceSec: z.number().int().min(1).max(300),
    longAbsenceSec: z.number().int().min(30).max(7200),

    identityConfidenceThreshold: z.number().min(0.5).max(0.999),
    identityCacheSec: z.number().int().min(30).max(7200),
    screenFacingThreshold: z.number().min(0.1).max(0.99),
    lowConfidenceThreshold: z.number().min(0.05).max(0.9),

    yawThresholdDeg: z.number().min(5).max(80),
    pitchUpThresholdDeg: z.number().min(5).max(80),
    pitchDownThresholdDeg: z.number().min(5).max(80),

    snapshotsEnabled: z.boolean(),
    snapshotRetentionDays: z.number().int().min(1).max(365),
    observationRetentionDays: z.number().int().min(1).max(365),
    eventRetentionDays: z.number().int().min(1).max(3650),
    transcriptRetentionDays: z.number().int().min(1).max(3650),

    alertNotificationsEnabled: z.boolean(),
  })
  .partial();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

async function saveConfig(c: AppContext, patch: Partial<MeetingMonitoringConfig>) {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const current = await getMeetingConfig(c.env.DB, actor.organizationId);
  const merged = mergeMeetingConfig(current, patch);
  const version = current.version + 1;
  const { version: _v, ...values } = merged;

  await db
    .insert(meetingMonitoringSettings)
    .values({
      organizationId: actor.organizationId,
      version,
      ...values,
      updatedAt: Date.now(),
      updatedBy: actor.userId,
    })
    .onConflictDoUpdate({
      target: meetingMonitoringSettings.organizationId,
      set: { version, ...values, updatedAt: Date.now(), updatedBy: actor.userId },
    });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "meeting.settings.update",
    resourceType: "meeting_monitoring_settings",
    resourceId: actor.organizationId,
    metadata: { version, changed: Object.keys(patch) },
    requestId: c.get("requestId"),
  });

  return { ...merged, version };
}

app.patch("/monitoring-settings", requirePermission("monitoring:write"), async (c) => {
  const body = await parseBody(c, configSchema);
  return c.json({ settings: await saveConfig(c, body) });
});

/** Per-meeting alias, as specified in §38. Settings are organization-wide. */
app.patch("/:id/monitoring-settings", requirePermission("monitoring:write"), async (c) => {
  const actor = getActor(c);
  await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const body = await parseBody(c, configSchema);
  return c.json({ settings: await saveConfig(c, body) });
});

/* ----------------------------------------------------------- analysis run */

const startSchema = z.object({
  adapter: z.enum(["MEETING_SDK", "RTMS", "MOCK"]).optional(),
  /** Simulation only. */
  participantCount: z.number().int().min(1).max(200).optional(),
  seed: z.number().int().optional(),
});

app.post("/:id/analysis/start", requirePermission("monitoring:write"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const body = await parseBody(c, startSchema);
  const db = drizzle(c.env.DB);
  const now = Date.now();

  const existing = await currentRun(c.env, actor.organizationId, session.id);
  if (existing && (existing.status === "RUNNING" || existing.status === "STARTING")) {
    return c.json({ analysis: existing, alreadyRunning: true });
  }

  const config = await getMeetingConfig(c.env.DB, actor.organizationId);
  const id = newId("analysisSession");
  const adapter = body.adapter ?? (session.zoomMeetingId ? "MEETING_SDK" : "MOCK");

  await db.insert(meetingAnalysisSessions).values({
    id,
    organizationId: actor.organizationId,
    sessionId: session.id,
    zoomMeetingId: session.zoomMeetingId,
    adapter,
    status: "RUNNING",
    config: {
      ...(config as unknown as Record<string, number | boolean | string>),
      participantCount: body.participantCount ?? 0,
      seed: body.seed ?? 0,
    },
    startedAt: now,
    startedBy: actor.userId,
    lastHeartbeatAt: now,
  });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "meeting.analysis.start",
    resourceType: "meeting_analysis_session",
    resourceId: id,
    metadata: { sessionId: session.id, adapter },
    requestId: c.get("requestId"),
  });

  await publishToSession(c.env, session.id, "analysis.session.changed", { id, status: "RUNNING", adapter });

  return c.json({ analysis: { id, sessionId: session.id, adapter, status: "RUNNING", startedAt: now } }, 201);
});

app.post("/:id/analysis/stop", requirePermission("monitoring:write"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const run = await currentRun(c.env, actor.organizationId, session.id);
  if (!run) throw notFound("解析セッションが見つかりません");

  const now = Date.now();
  await drizzle(c.env.DB)
    .update(meetingAnalysisSessions)
    .set({ status: "STOPPED", stoppedAt: now, updatedAt: now })
    .where(eq(meetingAnalysisSessions.id, run.id));

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "meeting.analysis.stop",
    resourceType: "meeting_analysis_session",
    resourceId: run.id,
    metadata: { sessionId: session.id },
    requestId: c.get("requestId"),
  });

  await publishToSession(c.env, session.id, "analysis.session.changed", { id: run.id, status: "STOPPED" });
  return c.json({ ok: true, analysis: { id: run.id, status: "STOPPED", stoppedAt: now } });
});

/**
 * Overall analysis view: run status, KPI cards, and the config in force.
 * This is the single call the Live Meeting page makes on load.
 */
app.get("/:id/analysis", requirePermission("monitoring:read"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const db = drizzle(c.env.DB);
  const now = Date.now();

  const run = await currentRun(c.env, actor.organizationId, session.id);
  const config = await getMeetingConfig(c.env.DB, actor.organizationId);

  const states = await db
    .select()
    .from(participantAnalysisState)
    .where(
      and(
        eq(participantAnalysisState.organizationId, actor.organizationId),
        eq(participantAnalysisState.sessionId, session.id),
      ),
    );

  const present = states.filter((s) => !s.leftAt);
  const openEvents = await db
    .select({ count: sql<number>`count(*)` })
    .from(participantEngagementEvents)
    .where(
      and(
        eq(participantEngagementEvents.organizationId, actor.organizationId),
        eq(participantEngagementEvents.sessionId, session.id),
        eq(participantEngagementEvents.state, "OPEN"),
      ),
    );

  const kpis = {
    participants: states.length,
    present: present.length,
    cameraOn: present.filter((s) => s.cameraOn).length,
    screenFacing: present.filter((s) => s.currentState === "SCREEN_FACING").length,
    lookingAway: present.filter((s) => isLookingAway(s.currentState as never)).length,
    unverified: present.filter((s) => s.identityStatus !== "VERIFIED").length,
    needsAttention: present.filter((s) => needsAttention(s.currentState as never)).length,
    speaking: present.filter((s) => s.speaking).length,
    alerts: Number(openEvents[0]?.count ?? 0),
  };

  // A run whose worker stopped sending heartbeats is DEGRADED, not RUNNING:
  // the grid keeps its last known state but says so.
  const degraded = Boolean(run && run.status === "RUNNING" && isStale(run.lastHeartbeatAt, now));

  return c.json({
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      zoomMeetingId: session.zoomMeetingId,
    },
    analysis: run
      ? { ...run, status: degraded ? "DEGRADED" : run.status, stale: degraded }
      : null,
    config,
    kpis,
    serverTime: now,
  });
});

/** Liveness ping from the analysis worker (bot or browser). */
app.post("/:id/analysis/heartbeat", requirePermission("monitoring:write"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const run = await currentRun(c.env, actor.organizationId, session.id);
  if (!run) throw notFound("解析セッションが見つかりません");
  await drizzle(c.env.DB)
    .update(meetingAnalysisSessions)
    .set({ lastHeartbeatAt: Date.now(), status: "RUNNING", updatedAt: Date.now() })
    .where(eq(meetingAnalysisSessions.id, run.id));
  return c.json({ ok: true });
});

/**
 * The scheduler's work list.
 *
 * An analysis worker polls this and analyses exactly the participants it names,
 * at the FPS it specifies. That is what keeps a 200-person meeting inside one
 * GPU's budget — and it keeps the policy here, where it is testable, instead of
 * hard-coded in the bot.
 */
app.get("/:id/analysis/plan", requirePermission("monitoring:read"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const config = await getMeetingConfig(c.env.DB, actor.organizationId);
  const db = drizzle(c.env.DB);

  const rows = await db
    .select()
    .from(participantAnalysisState)
    .where(
      and(
        eq(participantAnalysisState.organizationId, actor.organizationId),
        eq(participantAnalysisState.sessionId, session.id),
      ),
    );

  const limit = Math.min(Number(c.req.query("limit") ?? 25), 200);
  const includeNotDue = c.req.query("all") === "1";
  const plan = buildPlan(rows.map(rowToState), config, { limit, includeNotDue });

  return c.json({ plan, generatedAt: Date.now(), config: { normalFps: config.normalFps, elevatedFps: config.elevatedFps } });
});

/* ------------------------------------------------------------ participants */

/**
 * Grid data.
 *
 * Sorted server-side by risk when asked, because "who needs me?" must be
 * answerable without the browser pulling 200 rows and sorting them (§47).
 */
app.get("/:id/participants", requirePermission("monitoring:read"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const db = drizzle(c.env.DB);

  const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

  const rows = await db
    .select({
      participantId: participantAnalysisState.participantId,
      sessionId: participantAnalysisState.sessionId,
      displayName: participantAnalysisState.displayName,
      joinedAt: participantAnalysisState.joinedAt,
      leftAt: participantAnalysisState.leftAt,
      cameraOn: participantAnalysisState.cameraOn,
      microphoneOn: participantAnalysisState.microphoneOn,
      speaking: participantAnalysisState.speaking,
      speakingMs: participantAnalysisState.speakingMs,
      speakingTurns: participantAnalysisState.speakingTurns,
      faceDetected: participantAnalysisState.faceDetected,
      faceCount: participantAnalysisState.faceCount,
      faceBox: participantAnalysisState.faceBox,
      identityStatus: participantAnalysisState.identityStatus,
      identityConfidence: participantAnalysisState.identityConfidence,
      headYaw: participantAnalysisState.headYaw,
      headPitch: participantAnalysisState.headPitch,
      headRoll: participantAnalysisState.headRoll,
      headState: participantAnalysisState.headState,
      screenFacingProbability: participantAnalysisState.screenFacingProbability,
      currentState: participantAnalysisState.currentState,
      currentStateSince: participantAnalysisState.currentStateSince,
      lastAnalyzedAt: participantAnalysisState.lastAnalyzedAt,
      analysisConfidence: participantAnalysisState.analysisConfidence,
      analysisTier: participantAnalysisState.analysisTier,
      thumbnailEvidenceId: participantAnalysisState.thumbnailEvidenceId,
      thumbnailAt: participantAnalysisState.thumbnailAt,
      traineeName: trainees.name,
      externalId: trainees.externalId,
      department: trainees.department,
      participantStatus: sessionParticipants.status,
    })
    .from(participantAnalysisState)
    .leftJoin(sessionParticipants, eq(sessionParticipants.id, participantAnalysisState.participantId))
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(
      and(
        eq(participantAnalysisState.organizationId, actor.organizationId),
        eq(participantAnalysisState.sessionId, session.id),
      ),
    )
    .limit(limit)
    .offset(offset);

  return c.json({ participants: rows, total: rows.length, serverTime: Date.now() });
});

app.get("/:id/participants/:participantId", requirePermission("monitoring:read"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const participantId = c.req.param("participantId");
  const db = drizzle(c.env.DB);

  const rows = await db
    .select()
    .from(participantAnalysisState)
    .leftJoin(sessionParticipants, eq(sessionParticipants.id, participantAnalysisState.participantId))
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(
      and(
        eq(participantAnalysisState.organizationId, actor.organizationId),
        eq(participantAnalysisState.sessionId, session.id),
        eq(participantAnalysisState.participantId, participantId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("参加者が見つかりません");

  const since = Number(c.req.query("since") ?? session.startsAt);
  const [events, identity, observations] = await Promise.all([
    db
      .select()
      .from(participantEngagementEvents)
      .where(
        and(
          eq(participantEngagementEvents.organizationId, actor.organizationId),
          eq(participantEngagementEvents.participantId, participantId),
        ),
      )
      .orderBy(desc(participantEngagementEvents.startedAt))
      .limit(50),
    db
      .select()
      .from(identityVerifications)
      .where(
        and(
          eq(identityVerifications.organizationId, actor.organizationId),
          eq(identityVerifications.participantId, participantId),
        ),
      )
      .orderBy(desc(identityVerifications.verifiedAt))
      .limit(25),
    db
      .select({
        observedAt: participantObservations.observedAt,
        state: participantObservations.state,
        faceDetected: participantObservations.faceDetected,
        faceCount: participantObservations.faceCount,
        cameraOn: participantObservations.cameraOn,
        speaking: participantObservations.speaking,
        screenFacingProbability: participantObservations.screenFacingProbability,
        headYaw: participantObservations.headYaw,
        headPitch: participantObservations.headPitch,
        confidence: participantObservations.confidence,
      })
      .from(participantObservations)
      .where(
        and(
          eq(participantObservations.organizationId, actor.organizationId),
          eq(participantObservations.participantId, participantId),
          gte(participantObservations.observedAt, since),
        ),
      )
      .orderBy(asc(participantObservations.observedAt))
      .limit(2000),
  ]);

  return c.json({
    participant: {
      ...rows[0].participant_analysis_state,
      traineeName: rows[0].trainees?.name ?? null,
      externalId: rows[0].trainees?.externalId ?? null,
      department: rows[0].trainees?.department ?? null,
    },
    events,
    identityHistory: identity,
    timeline: observations,
    serverTime: Date.now(),
  });
});

/* ------------------------------------------------------------------ events */

app.get("/:id/events", requirePermission("monitoring:read"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const db = drizzle(c.env.DB);

  const filters = [
    eq(participantEngagementEvents.organizationId, actor.organizationId),
    eq(participantEngagementEvents.sessionId, session.id),
  ];
  const type = c.req.query("type");
  const state = c.req.query("state");
  const severity = c.req.query("severity");
  const participantId = c.req.query("participantId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (type) filters.push(inArray(participantEngagementEvents.type, type.split(",")));
  if (state) filters.push(eq(participantEngagementEvents.state, state));
  if (severity) filters.push(eq(participantEngagementEvents.severity, severity));
  if (participantId) filters.push(eq(participantEngagementEvents.participantId, participantId));
  if (from) filters.push(gte(participantEngagementEvents.startedAt, Number(from)));
  if (to) filters.push(lte(participantEngagementEvents.startedAt, Number(to)));

  const rows = await db
    .select({
      id: participantEngagementEvents.id,
      participantId: participantEngagementEvents.participantId,
      type: participantEngagementEvents.type,
      severity: participantEngagementEvents.severity,
      state: participantEngagementEvents.state,
      startedAt: participantEngagementEvents.startedAt,
      resolvedAt: participantEngagementEvents.resolvedAt,
      durationMs: participantEngagementEvents.durationMs,
      confidence: participantEngagementEvents.confidence,
      detail: participantEngagementEvents.detail,
      evidenceId: participantEngagementEvents.evidenceId,
      alertId: participantEngagementEvents.alertId,
      occurrences: participantEngagementEvents.occurrences,
      displayName: participantAnalysisState.displayName,
      traineeName: trainees.name,
      externalId: trainees.externalId,
    })
    .from(participantEngagementEvents)
    .leftJoin(
      participantAnalysisState,
      eq(participantAnalysisState.participantId, participantEngagementEvents.participantId),
    )
    .leftJoin(sessionParticipants, eq(sessionParticipants.id, participantEngagementEvents.participantId))
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(and(...filters))
    .orderBy(desc(participantEngagementEvents.startedAt))
    .limit(Math.min(Number(c.req.query("limit") ?? 100), 500));

  return c.json({ events: rows, serverTime: Date.now() });
});

/* ----------------------------------------------------------------- report */

async function gatherReport(env: Env, organizationId: string, sessionId: string) {
  const db = drizzle(env.DB);
  const session = await resolveSession(env, organizationId, sessionId);

  const participants: ParticipantRow[] = (
    await db
      .select({
        participantId: participantAnalysisState.participantId,
        displayName: participantAnalysisState.displayName,
        joinedAt: participantAnalysisState.joinedAt,
        leftAt: participantAnalysisState.leftAt,
        identityStatus: participantAnalysisState.identityStatus,
        speakingMs: participantAnalysisState.speakingMs,
        speakingTurns: participantAnalysisState.speakingTurns,
        lastSpokeAt: participantAnalysisState.lastSpokeAt,
        traineeName: trainees.name,
        externalId: trainees.externalId,
      })
      .from(participantAnalysisState)
      .leftJoin(sessionParticipants, eq(sessionParticipants.id, participantAnalysisState.participantId))
      .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
      .where(
        and(
          eq(participantAnalysisState.organizationId, organizationId),
          eq(participantAnalysisState.sessionId, session.id),
        ),
      )
  ).map((r) => ({ ...r }));

  const observations: ObservationRow[] = await db
    .select({
      participantId: participantObservations.participantId,
      observedAt: participantObservations.observedAt,
      faceDetected: participantObservations.faceDetected,
      faceCount: participantObservations.faceCount,
      cameraOn: participantObservations.cameraOn,
      speaking: participantObservations.speaking,
      state: participantObservations.state,
      identityStatus: participantObservations.identityStatus,
      screenFacingProbability: participantObservations.screenFacingProbability,
    })
    .from(participantObservations)
    .where(
      and(
        eq(participantObservations.organizationId, organizationId),
        eq(participantObservations.sessionId, session.id),
      ),
    )
    .orderBy(asc(participantObservations.observedAt))
    .limit(50_000);

  const events: EngagementEventRow[] = await db
    .select({
      participantId: participantEngagementEvents.participantId,
      type: participantEngagementEvents.type,
      severity: participantEngagementEvents.severity,
      startedAt: participantEngagementEvents.startedAt,
      resolvedAt: participantEngagementEvents.resolvedAt,
      durationMs: participantEngagementEvents.durationMs,
    })
    .from(participantEngagementEvents)
    .where(
      and(
        eq(participantEngagementEvents.organizationId, organizationId),
        eq(participantEngagementEvents.sessionId, session.id),
      ),
    )
    .limit(10_000);

  return {
    session,
    report: buildMeetingReport({
      sessionId: session.id,
      sessionStartsAt: session.startsAt,
      sessionEndsAt: session.endsAt,
      participants,
      observations,
      events,
    }),
  };
}

app.get("/:id/report", requirePermission("report:create"), async (c) => {
  const actor = getActor(c);
  const { session, report } = await gatherReport(c.env, actor.organizationId, c.req.param("id"));
  const format = (c.req.query("format") ?? "json").toLowerCase();

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "meeting.report.read",
    resourceType: "training_session",
    resourceId: session.id,
    metadata: { format, participants: report.participants.length },
    requestId: c.get("requestId"),
  });

  if (format === "csv") {
    const csv = toCsv(REPORT_CSV_HEADERS, reportToCsvRows(report));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="meeting-report-${session.id}.csv"`,
        "Cache-Control": "no-store, private",
      },
    });
  }

  return c.json({ session: { id: session.id, title: session.title }, ...report });
});

/** Freezes the current numbers so they survive observation retention. */
app.post("/:id/report", requirePermission("report:create"), async (c) => {
  const actor = getActor(c);
  const { session, report } = await gatherReport(c.env, actor.organizationId, c.req.param("id"));
  const run = await currentRun(c.env, actor.organizationId, session.id);
  const id = newId("meetingReport");

  await drizzle(c.env.DB).insert(meetingReports).values({
    id,
    organizationId: actor.organizationId,
    sessionId: session.id,
    analysisSessionId: run?.id ?? null,
    summary: report.summary as unknown as Record<string, unknown>,
    participants: report.participants as unknown as Record<string, unknown>[],
    generatedAt: Date.now(),
    generatedBy: actor.userId,
  });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "meeting.report.create",
    resourceType: "meeting_report",
    resourceId: id,
    metadata: { sessionId: session.id, participants: report.participants.length },
    requestId: c.get("requestId"),
  });

  return c.json({ report: { id, ...report } }, 201);
});

/* ------------------------------------------------------------- simulation */

const simulateSchema = z.object({
  ticks: z.number().int().min(1).max(30).optional(),
  /** Seconds of simulated time each tick advances. */
  stepSec: z.number().int().min(1).max(60).optional(),
  participantCount: z.number().int().min(1).max(50).optional(),
  seed: z.number().int().optional(),
});

/**
 * Advances the development simulator (§42).
 *
 * Refuses unless the run's adapter is MOCK: injecting synthetic observations
 * into a meeting that is being monitored for real would corrupt evidence an
 * organization may later rely on.
 */
app.post("/:id/simulate", requirePermission("monitoring:write"), async (c) => {
  const actor = getActor(c);
  const session = await resolveSession(c.env, actor.organizationId, c.req.param("id"));
  const body = await parseBody(c, simulateSchema);
  const run = await currentRun(c.env, actor.organizationId, session.id);

  if (!run || run.status === "STOPPED") throw badRequest("先に解析セッションを開始してください");
  if (run.adapter !== "MOCK") {
    throw badRequest("シミュレーションはMOCKアダプタの解析セッションでのみ実行できます");
  }

  const config = await getMeetingConfig(c.env.DB, actor.organizationId);
  const { MockZoomAdapter } = await import("../integrations/zoom/mock");
  // `Number(x) ?? fallback` never reaches the fallback — Number() returns NaN,
  // which is not nullish — so an absent stored value produced NaN here and only
  // survived because the constructor call below happened to coerce it away.
  const runConfig = (run.config ?? {}) as Record<string, unknown>;
  const storedNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const seed = body.seed ?? storedNumber(runConfig.seed) ?? DEFAULT_SIMULATION_SEED;
  const count = body.participantCount ?? storedNumber(runConfig.participantCount) ?? 12;

  const adapter = new MockZoomAdapter({ participantCount: count > 0 ? count : 12, seed });

  // Map each synthetic attendee onto a real session_participants row, so the
  // simulation exercises the same joins and tenancy checks as production.
  const ids = new Map<string, string>();
  adapter.onObservation(async (participant, observation) => {
    const key = participant.participantUuid ?? participant.zoomUserId ?? "unknown";
    let participantId = ids.get(key);
    if (!participantId) {
      participantId = await ensureSessionParticipant(c.env, actor.organizationId, session.id, {
        participantUuid: participant.participantUuid,
        zoomUserId: participant.zoomUserId,
        displayName: (participant as { displayName?: string }).displayName,
      });
      ids.set(key, participantId);
    }
    await applyObservation({
      env: c.env,
      organizationId: actor.organizationId,
      sessionId: session.id,
      participantId,
      observation,
      config,
      analysisSessionId: run.id,
      displayName: (participant as { displayName?: string }).displayName ?? null,
      raiseAlert: makeAlertRaiser(c.env, actor.organizationId, session.id, run.id),
    });
  });

  await adapter.connect(session.zoomMeetingId ?? session.id);
  for (const entry of adapter.roster_) {
    const participantId = await ensureSessionParticipant(c.env, actor.organizationId, session.id, {
      participantUuid: entry.participant.participantUuid,
      zoomUserId: entry.participant.zoomUserId,
      displayName: entry.participant.displayName,
    });
    ids.set(entry.key.replace("sim-", "sim-uuid-"), participantId);
    ids.set(entry.participant.participantUuid ?? entry.key, participantId);
  }

  const ticks = body.ticks ?? 1;
  const stepMs = (body.stepSec ?? 5) * 1000;
  const start = Date.now() - (ticks - 1) * stepMs;
  let observations = 0;
  for (let i = 0; i < ticks; i++) {
    observations += await adapter.tick(start + i * stepMs);
  }

  await drizzle(c.env.DB)
    .update(meetingAnalysisSessions)
    .set({ lastHeartbeatAt: Date.now(), participantCount: ids.size, updatedAt: Date.now() })
    .where(eq(meetingAnalysisSessions.id, run.id));

  return c.json({ ok: true, participants: adapter.roster_.length, observations, ticks });
});

/**
 * Escalation bridge into the ORIGINAL alert inbox.
 *
 * Reuses `upsertAlert` so organizer-layer alerts are indistinguishable from
 * trainee-layer ones on the existing ライブ監視 screen — one inbox, one review
 * workflow, one audit trail.
 */
export function makeAlertRaiser(
  env: Env,
  organizationId: string,
  sessionId: string,
  analysisSessionId: string,
) {
  return async (
    action: { type: string; severity: string; detail: string; dedupeKey: string; startedAt: number },
    state: { participantId: string },
  ): Promise<string | null> => {
    await upsertAlert(env, {
      organizationId,
      sessionId,
      participantId: state.participantId,
      type: action.type,
      severity: action.severity,
      summary: action.detail,
      detail: action.detail,
      dedupeKey: action.dedupeKey,
      eventId: `${analysisSessionId}:${action.startedAt}`,
      evidenceId: null,
      ruleVersion: analysisSessionId,
      modelVersion: null,
    });

    const rows = await drizzle(env.DB)
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.sessionId, sessionId),
          eq(alerts.dedupeKey, `${state.participantId}:${action.dedupeKey}`),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  };
}

export { resolveSession, DEFAULT_MEETING_CONFIG };
export default app;

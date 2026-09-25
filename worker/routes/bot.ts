/**
 * Ingestion endpoint for the Zoom Meeting-SDK recognition bot.
 *
 * The bot runs server-side: it joins a training meeting, pulls each participant's
 * raw video, runs the UXE engine (detect + recognize + rules) and POSTs the
 * resulting detections here. This route folds those detections into the SAME
 * pipeline the trainee client uses — session participants, monitoring events,
 * the rule engine, alerts, evidence and the realtime dashboard — so the admin
 * ライブ監視 screen shows bot-sourced results with no other changes.
 *
 * Auth is a shared bearer secret (BOT_INGEST_TOKEN); the bot is trusted
 * server-to-server, unlike a trainee device.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import {
  meetingAnalysisSessions, monitoringEvents, sessionParticipants, trainingSessions, trainees,
} from "../db/schema";
import { timingSafeEqual } from "../lib/crypto";
import { badRequest, notFound, serverError, unauthorized } from "../lib/errors";
import { parseBody } from "../lib/http";
import { publishToSession } from "../lib/realtime";
import {
  checkPlausibility, evaluate, MAX_CLOCK_SKEW_MS, MAX_EVENT_AGE_MS, nextStatus,
  type ParticipantStatus, type ProposedEvent, type Severity,
} from "../lib/rules";
import { getRules, ruleVersionTag } from "../lib/settings";
import { getMeetingConfig } from "../services/monitoring/config";
import { applyObservation, markParticipantLeft } from "../services/monitoring/pipeline";
import type { Env, Variables } from "../types";
import { makeAlertRaiser } from "./meetings";
import { reconcileZoomParticipant } from "./zoom";
import { storeEvidence, upsertAlert } from "./trainee";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Server-to-server bearer auth. */
app.use("*", async (c, next) => {
  const secret = c.env.BOT_INGEST_TOKEN;
  if (!secret) throw serverError("BOT_INGEST_TOKEN が未設定です");
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !timingSafeEqual(token, secret)) throw unauthorized("botトークンが不正です");
  await next();
});

const eventSchema = z.object({
  eventId: z.string().min(1).max(64),
  /** Zoom identity of the participant this detection is about. */
  zoomUserId: z.string().optional(),
  zoomUserName: z.string().optional(),
  zoomParticipantUuid: z.string().optional(),
  zoomEmail: z.string().email().optional(),
  /** The engine's 1:N identify result, when it recognised an enrolled trainee. */
  traineeId: z.string().optional(),
  type: z.enum([
    "MATCH_OK", "MATCH_FAIL", "FACE_ABSENT", "MULTIPLE_FACES", "EYES_CLOSED",
    "CAMERA_BLOCKED", "CAMERA_STOPPED", "HEARTBEAT",
  ]),
  capturedAt: z.number().int().positive(),
  durationMs: z.number().int().optional(),
  faceCount: z.number().int().optional(),
  frameCount: z.number().int().optional(),
  matchScore: z.number().optional(),
  qualityScore: z.number().optional(),
  modelVersion: z.string().max(120).optional(),
  severity: z.enum(["INFO", "WARNING", "ALERT"]).optional(),
  /** data: URL JPEG, stored as evidence when a rule requires it. */
  evidence: z.string().optional(),
});

const ingestSchema = z.object({
  meetingId: z.string().min(1),
  botId: z.string().optional(),
  events: z.array(eventSchema).min(1).max(200),
});

interface PartState {
  participantId: string;
  traineeId: string | null;
  status: ParticipantStatus;
  lastMatchScore: number | null;
  dirty: boolean;
}

app.post("/ingest", async (c) => {
  const body = await parseBody(c, ingestSchema);
  const db = drizzle(c.env.DB);
  const now = Date.now();

  // Resolve the training session from the Zoom meeting id.
  const sessions = await db
    .select()
    .from(trainingSessions)
    .where(and(eq(trainingSessions.zoomMeetingId, body.meetingId), isNull(trainingSessions.deletedAt)))
    .limit(2);
  if (!sessions[0]) throw notFound("meetingId に対応する研修が見つかりません");
  if (sessions.length > 1) throw badRequest("meetingId が複数の研修に紐付いています");
  const session = sessions[0];
  const orgId = session.organizationId;

  const rules = (session.ruleSnapshot as never) ?? (await getRules(c.env.DB, orgId));
  const ruleVersion =
    session.ruleVersion ?? ruleVersionTag(orgId, (rules as { version: number }).version);
  const retentionDays = (rules as { evidenceRetentionDays: number }).evidenceRetentionDays;

  // Resolve each Zoom participant once per request.
  const parts = new Map<string, PartState>();
  const resolve = async (ev: z.infer<typeof eventSchema>): Promise<PartState> => {
    const key = ev.zoomParticipantUuid ?? ev.zoomUserId ?? ev.traineeId ?? ev.eventId;
    const cached = parts.get(key);
    if (cached) return cached;

    const rec = await reconcileZoomParticipant(c.env, {
      organizationId: orgId,
      sessionId: session.id,
      name: ev.zoomUserName,
      email: ev.zoomEmail,
      participantUuid: ev.zoomParticipantUuid,
      zoomUserId: ev.zoomUserId,
    });
    let traineeId = rec.traineeId;

    // If the engine identified a trainee by face and the row isn't bound yet,
    // bind it (verifying the trainee belongs to this tenant).
    if (ev.traineeId && !traineeId) {
      const owns = await db
        .select({ id: trainees.id })
        .from(trainees)
        .where(and(eq(trainees.id, ev.traineeId), eq(trainees.organizationId, orgId), isNull(trainees.deletedAt)))
        .limit(1);
      if (owns[0]) {
        await db
          .update(sessionParticipants)
          .set({ traineeId: ev.traineeId, matchMethod: "face", matchConfidence: ev.matchScore ?? null, updatedAt: now })
          .where(and(eq(sessionParticipants.id, rec.participantId), eq(sessionParticipants.organizationId, orgId)));
        traineeId = ev.traineeId;
      }
    }

    const row = (
      await db.select().from(sessionParticipants).where(eq(sessionParticipants.id, rec.participantId)).limit(1)
    )[0];
    const state: PartState = {
      participantId: rec.participantId,
      traineeId,
      status: (row?.status ?? "PRECHECK_PENDING") as ParticipantStatus,
      lastMatchScore: row?.lastMatchScore ?? null,
      dirty: false,
    };
    parts.set(key, state);
    return state;
  };

  const accepted: string[] = [];
  const rejected: { eventId: string; reason: string }[] = [];

  for (const ev of body.events) {
    const p = await resolve(ev);
    const proposed: ProposedEvent = {
      type: ev.type,
      capturedAt: ev.capturedAt,
      durationMs: ev.durationMs ?? null,
      faceCount: ev.faceCount ?? null,
      matchScore: ev.matchScore ?? null,
      qualityScore: ev.qualityScore ?? null,
      frameCount: ev.frameCount ?? null,
    };

    const plausibility = checkPlausibility(proposed, now, accepted.length);
    if (!plausibility.ok) {
      rejected.push({ eventId: ev.eventId, reason: plausibility.reason ?? "不正なイベント" });
      continue;
    }

    const judgement = evaluate(proposed, rules as never, ev.severity as Severity | undefined);

    let evidenceId: string | null = null;
    if (ev.evidence && judgement.evidenceRequired && !plausibility.quarantine) {
      evidenceId = await storeEvidence(c.env, {
        organizationId: orgId,
        sessionId: session.id,
        participantId: p.participantId,
        dataUrl: ev.evidence,
        kind: ev.type,
        capturedAt: ev.capturedAt,
        retentionDays,
      });
    }

    try {
      await db.insert(monitoringEvents).values({
        id: ev.eventId,
        organizationId: orgId,
        sessionId: session.id,
        participantId: p.participantId,
        type: ev.type,
        severity: judgement.severity,
        capturedAt: ev.capturedAt,
        receivedAt: now,
        durationMs: ev.durationMs ?? null,
        faceCount: ev.faceCount ?? null,
        matchScore: ev.matchScore ?? null,
        qualityScore: ev.qualityScore ?? null,
        modelVersion: ev.modelVersion ?? null,
        ruleVersion,
        evidenceId,
        serverAdjusted: judgement.adjusted,
        quarantined: plausibility.quarantine,
        quarantineReason: plausibility.reason ?? null,
      });
      accepted.push(ev.eventId);
    } catch {
      rejected.push({ eventId: ev.eventId, reason: "重複イベント（処理済み）" });
      continue;
    }

    if (plausibility.quarantine) continue;

    if (ev.matchScore != null) p.lastMatchScore = ev.matchScore;
    const next = nextStatus(p.status, judgement.status);
    if (next !== p.status || ev.matchScore != null) p.dirty = true;
    p.status = next;

    if (judgement.alertType && judgement.dedupeKey) {
      await upsertAlert(c.env, {
        organizationId: orgId,
        sessionId: session.id,
        participantId: p.participantId,
        type: judgement.alertType,
        severity: judgement.severity,
        summary: judgement.summary,
        detail: judgement.detail,
        dedupeKey: judgement.dedupeKey,
        eventId: ev.eventId,
        evidenceId,
        ruleVersion,
        modelVersion: ev.modelVersion ?? null,
      });
    }
  }

  // Persist status changes and push them to the live dashboard.
  for (const p of parts.values()) {
    if (!p.dirty) continue;
    await db
      .update(sessionParticipants)
      .set({ status: p.status, lastMatchScore: p.lastMatchScore, lastSeenAt: now, updatedAt: now })
      .where(eq(sessionParticipants.id, p.participantId));
    await publishToSession(c.env, session.id, "participant.status.changed", {
      participantId: p.participantId,
      status: p.status,
      lastMatchScore: p.lastMatchScore,
    });
  }

  return c.json({ ok: true, sessionId: session.id, accepted: accepted.length, rejected });
});

/* ==================================================================== *
 *  Organizer Intelligence ingestion (additive)
 *
 *  `/ingest` above is unchanged and still drives the original trainee-style
 *  pipeline. `/observe` below carries the richer per-participant analysis the
 *  organizer console needs — head pose, gaze, camera/mic/speaking, face box —
 *  and feeds the state reducer, scheduler and event engine.
 *
 *  A bot may call either or both: they write to different tables and neither
 *  depends on the other.
 * ==================================================================== */

const observationSchema = z.object({
  zoomUserId: z.string().optional(),
  zoomUserName: z.string().optional(),
  zoomParticipantUuid: z.string().optional(),
  zoomEmail: z.string().email().optional(),
  traineeId: z.string().optional(),

  observedAt: z.number().int().positive(),
  faceDetected: z.boolean(),
  faceCount: z.number().int().min(0).max(64).default(0),
  detectionConfidence: z.number().min(0).max(1).nullable().optional(),
  faceBox: z
    .object({
      x: z.number().min(-1).max(2),
      y: z.number().min(-1).max(2),
      width: z.number().min(0).max(2),
      height: z.number().min(0).max(2),
    })
    .nullable()
    .optional(),
  yaw: z.number().min(-180).max(180).nullable().optional(),
  pitch: z.number().min(-180).max(180).nullable().optional(),
  roll: z.number().min(-180).max(180).nullable().optional(),
  gazeHorizontal: z.number().min(-1).max(1).nullable().optional(),
  gazeVertical: z.number().min(-1).max(1).nullable().optional(),

  /** Eye state, when the provider can measure it (MediaPipe eyeBlink, or an
   *  equivalent from the UXE engine). Absent means "not measured", which is
   *  different from "eyes open" and is treated as such downstream. */
  eyeClosed: z.boolean().nullable().optional(),
  eyeOpenness: z.number().min(0).max(1).nullable().optional(),

  identityStatus: z
    .enum(["VERIFIED", "UNVERIFIED", "MISMATCH", "NO_FACE", "MULTIPLE_FACES", "LOW_CONFIDENCE", "UNKNOWN"])
    .optional(),
  identityConfidence: z.number().min(0).max(1).nullable().optional(),

  cameraOn: z.boolean().nullable().optional(),
  microphoneOn: z.boolean().nullable().optional(),
  speaking: z.boolean().nullable().optional(),

  /** Optional data: URL JPEG, stored only when snapshots are enabled. */
  snapshot: z.string().optional(),
  /** True when the participant has left the meeting. */
  left: z.boolean().optional(),
});

const observeSchema = z.object({
  meetingId: z.string().min(1),
  botId: z.string().optional(),
  observations: z.array(observationSchema).min(1).max(200),
});

app.post("/observe", async (c) => {
  const startedAt = Date.now();
  const body = await parseBody(c, observeSchema);
  const db = drizzle(c.env.DB);
  const now = Date.now();

  const sessions = await db
    .select()
    .from(trainingSessions)
    .where(and(eq(trainingSessions.zoomMeetingId, body.meetingId), isNull(trainingSessions.deletedAt)))
    .limit(2);
  if (!sessions[0]) throw notFound("meetingId に対応する研修が見つかりません");
  if (sessions.length > 1) throw badRequest("meetingId が複数の研修に紐付いています");
  const session = sessions[0];
  const orgId = session.organizationId;

  const config = await getMeetingConfig(c.env.DB, orgId);
  if (!config.faceMonitoringEnabled) {
    return c.json({ ok: true, skipped: "face monitoring disabled", accepted: 0 });
  }

  const run = (
    await db
      .select()
      .from(meetingAnalysisSessions)
      .where(
        and(
          eq(meetingAnalysisSessions.organizationId, orgId),
          eq(meetingAnalysisSessions.sessionId, session.id),
        ),
      )
      .orderBy(desc(meetingAnalysisSessions.startedAt))
      .limit(1)
  )[0];

  const raiseAlert = run ? makeAlertRaiser(c.env, orgId, session.id, run.id) : undefined;
  const retentionDays = config.snapshotRetentionDays;
  let accepted = 0;
  const rejected: { at: number; reason: string }[] = [];

  for (const o of body.observations) {
    // Same clock-skew guard the trainee pipeline applies: a bot with a wrong
    // clock must not back-date or pre-date the timeline.
    if (o.observedAt > now + MAX_CLOCK_SKEW_MS || now - o.observedAt > MAX_EVENT_AGE_MS) {
      rejected.push({ at: o.observedAt, reason: "時刻が許容範囲外です" });
      continue;
    }

    const rec = await reconcileZoomParticipant(c.env, {
      organizationId: orgId,
      sessionId: session.id,
      name: o.zoomUserName,
      email: o.zoomEmail,
      participantUuid: o.zoomParticipantUuid,
      zoomUserId: o.zoomUserId,
    });

    if (o.left) {
      await markParticipantLeft(c.env, orgId, session.id, rec.participantId, o.observedAt);
      accepted++;
      continue;
    }

    await applyObservation({
      env: c.env,
      organizationId: orgId,
      sessionId: session.id,
      participantId: rec.participantId,
      displayName: o.zoomUserName ?? null,
      analysisSessionId: run?.id ?? null,
      config,
      observation: {
        observedAt: o.observedAt,
        faceDetected: o.faceDetected,
        faceCount: o.faceCount ?? 0,
        detectionConfidence: o.detectionConfidence ?? null,
        faceBox: o.faceBox ?? null,
        pose:
          o.yaw != null || o.pitch != null
            ? { yaw: o.yaw ?? 0, pitch: o.pitch ?? 0, roll: o.roll ?? 0 }
            : null,
        gazeHorizontal: o.gazeHorizontal ?? null,
        gazeVertical: o.gazeVertical ?? null,
        eyeClosed: o.eyeClosed ?? null,
        eyeOpenness: o.eyeOpenness ?? null,
        identityStatus: o.identityStatus ?? null,
        identityConfidence: o.identityConfidence ?? null,
        identityTraineeId: o.traineeId ?? null,
        cameraOn: o.cameraOn ?? null,
        microphoneOn: o.microphoneOn ?? null,
        speaking: o.speaking ?? null,
        source: "BOT",
      },
      raiseAlert,
      storeSnapshot: o.snapshot
        ? async () =>
            storeEvidence(c.env, {
              organizationId: orgId,
              sessionId: session.id,
              participantId: rec.participantId,
              dataUrl: o.snapshot!,
              kind: "ENGAGEMENT_SNAPSHOT",
              capturedAt: o.observedAt,
              retentionDays,
            })
        : undefined,
    });
    accepted++;
  }

  if (run) {
    await db
      .update(meetingAnalysisSessions)
      .set({ lastHeartbeatAt: now, status: "RUNNING", updatedAt: now })
      .where(eq(meetingAnalysisSessions.id, run.id));
  }

  // Structured ingest log (§37). Carries no participant identity: the fields an
  // operator needs to spot a stalled or overloaded analysis worker, and nothing
  // that would put a name or a face in the log stream.
  console.log(
    JSON.stringify({
      level: "info",
      message: "bot observations ingested",
      sessionId: session.id,
      analysisSessionId: run?.id ?? null,
      botId: body.botId ?? null,
      accepted,
      rejected: rejected.length,
      latencyMs: Date.now() - startedAt,
    }),
  );

  return c.json({ ok: true, sessionId: session.id, accepted, rejected });
});

export default app;

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
  integrations, meetingAnalysisSessions, monitoringEvents, organizations, sessionParticipants,
  trainingSessions, trainees,
} from "../db/schema";
import { timingSafeEqual } from "../lib/crypto";
import { getAccessToken, getMeetingDetail, listMeetings } from "../lib/zoom";
import { badRequest, notFound, serverError, unauthorized } from "../lib/errors";
import { parseBody } from "../lib/http";
import { publishToSession } from "../lib/realtime";
import {
  checkPlausibility, evaluate, MAX_CLOCK_SKEW_MS, MAX_EVENT_AGE_MS, nextStatus,
  type ParticipantStatus, type ProposedEvent, type Severity,
} from "../lib/rules";
import { getRules, ruleVersionTag } from "../lib/settings";
import { getMeetingConfig } from "../services/monitoring/config";
import {
  ensureSessionForMeeting, resolveOrganizationForMeeting, upsertZoomMeeting,
} from "../services/zoom/auto-session";
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
  /** Only consulted when the meeting cannot be attributed any other way. */
  organizationId: z.string().min(1).optional(),
  botId: z.string().optional(),
  events: z.array(eventSchema).min(1).max(200),
});

/**
 * Finds — or creates — the training session a bot payload belongs to.
 *
 * The bot can be pointed at a meeting directly (`ZOOM_MEETING_NUMBER`) as well
 * as driven by `/assignments`, and in the direct case nothing has ever created
 * a session for that meeting. Returning 404 there would make the bot look
 * broken when it is working perfectly; instead we resolve the tenant the same
 * way the webhook does and bind the meeting to a session.
 */
async function resolveBotSession(env: Env, meetingId: string, statedOrgId?: string) {
  const db = drizzle(env.DB);
  const sessions = await db
    .select()
    .from(trainingSessions)
    .where(and(eq(trainingSessions.zoomMeetingId, meetingId), isNull(trainingSessions.deletedAt)))
    .limit(2);
  if (sessions.length > 1) throw badRequest("meetingId が複数の研修に紐付いています");
  if (sessions[0]) return sessions[0];

  // A bot run from a fixed meeting number has no webhook and no OAuth record to
  // attribute it by, so it may state its tenant outright. It is a trusted
  // server-to-server principal, but the id is still checked against a real
  // organization rather than taken on faith.
  let organizationId = await resolveOrganizationForMeeting(env, null, meetingId);
  if (!organizationId && statedOrgId) {
    const owner = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, statedOrgId))
      .limit(1);
    organizationId = owner[0]?.id ?? null;
  }
  if (!organizationId) {
    throw notFound(
      "meetingId に対応する研修が見つかりません（テナントを特定できません。organizationId を指定してください）",
    );
  }
  const ensured = await ensureSessionForMeeting(env, organizationId, meetingId);
  if (!ensured.session) {
    throw notFound(
      ensured.reason === "disabled"
        ? "meetingId に対応する研修がなく、自動作成が無効になっています"
        : "meetingId に対応する研修が見つかりません",
    );
  }
  return ensured.session;
}

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

  // Resolve (or create) the training session for this Zoom meeting.
  const sessions = [await resolveBotSession(c.env, body.meetingId, body.organizationId)];
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

export const observationSchema = z.object({
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
  /** Only consulted when the meeting cannot be attributed any other way. */
  organizationId: z.string().min(1).optional(),
  botId: z.string().optional(),
  observations: z.array(observationSchema).min(1).max(200),
});

app.post("/observe", async (c) => {
  const startedAt = Date.now();
  const body = await parseBody(c, observeSchema);
  const db = drizzle(c.env.DB);
  const now = Date.now();

  const session = await resolveBotSession(c.env, body.meetingId, body.organizationId);
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

/* ------------------------------------------------------- bot assignments */

/**
 * Tells the bot which meetings to be in.
 *
 * The bot cannot be launched by the Worker — Cloudflare has no process to
 * spawn, and the Meeting SDK needs a real host with a GPU-less but native
 * runtime. So the relationship is inverted: the bot polls this endpoint and
 * joins whatever it is told to. That also means the bot needs no Zoom
 * credentials of its own beyond its SDK key, and no knowledge of which
 * customers exist.
 *
 * "Live" comes from Zoom itself rather than from our webhook state, because a
 * tenant may not have configured webhooks at all, and because a bot that
 * restarts must be able to rejoin a meeting that started while it was down.
 */
app.get("/assignments", async (c) => {
  const db = drizzle(c.env.DB);
  const clientId = c.env.ZOOM_CLIENT_ID;
  const clientSecret = c.env.ZOOM_CLIENT_SECRET;
  const encryptionKey = c.env.DATA_ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !encryptionKey) {
    throw serverError("Zoom連携が未設定です");
  }

  const connected = await db
    .select({ organizationId: integrations.organizationId })
    .from(integrations)
    .where(and(eq(integrations.provider, "zoom"), eq(integrations.status, "CONNECTED")));

  const assignments: Record<string, unknown>[] = [];
  /** Reported rather than thrown: one tenant's expired token must not blind the
   *  bot to every other tenant's live meetings. */
  const problems: { organizationId: string; reason: string }[] = [];

  for (const row of connected) {
    const config = await getMeetingConfig(c.env.DB, row.organizationId);
    if (!config.botAutoJoinEnabled || !config.faceMonitoringEnabled) continue;

    let token: string;
    try {
      token = await getAccessToken(c.env.DB, row.organizationId, clientId, clientSecret, encryptionKey);
    } catch (err) {
      problems.push({
        organizationId: row.organizationId,
        reason: err instanceof Error ? err.message : "アクセストークンを取得できません",
      });
      continue;
    }

    let live;
    try {
      live = await listMeetings(token, "me", "live");
    } catch (err) {
      problems.push({
        organizationId: row.organizationId,
        reason: err instanceof Error ? err.message : "開催中のミーティングを取得できません",
      });
      continue;
    }

    for (const m of live) {
      const meetingId = String(m.id);
      await upsertZoomMeeting(c.env, row.organizationId, meetingId, {
        meetingUuid: m.uuid ?? null,
        topic: m.topic ?? null,
        hostId: m.host_id ?? null,
        joinUrl: m.join_url ?? null,
        startTime: m.start_time ? Date.parse(m.start_time) : null,
        duration: m.duration ?? null,
        status: "started",
      });

      const ensured = await ensureSessionForMeeting(c.env, row.organizationId, meetingId, {
        topic: m.topic,
        startTime: m.start_time ? Date.parse(m.start_time) : null,
        durationMin: m.duration ?? null,
      });
      const session = ensured.session;
      if (!session) continue;

      if (session.status !== "LIVE") {
        await db
          .update(trainingSessions)
          .set({ status: "LIVE", updatedAt: Date.now() })
          .where(eq(trainingSessions.id, session.id));
      }

      // The passcode is a credential: fetched per poll, handed to the bot over
      // its authenticated channel, never written to our database.
      let passcode: string | null = null;
      try {
        const detail = await getMeetingDetail(token, meetingId);
        passcode = detail.password ?? null;
      } catch {
        // A meeting with no passcode, or a scope the tenant has not granted.
        // The bot can still try to join; join_before_host meetings need none.
      }

      assignments.push({
        organizationId: row.organizationId,
        meetingId,
        meetingUuid: m.uuid ?? null,
        topic: m.topic ?? null,
        passcode,
        sessionId: session.id,
        // Cadence comes from the tenant's own monitoring settings so the bot
        // never has to be reconfigured when an administrator changes them.
        observeIntervalSec: config.normalIntervalSec,
        snapshotsEnabled: config.snapshotsEnabled,
        identityEnabled: config.identityVerificationEnabled,
        drowsinessEnabled: config.drowsinessEnabled,
        identityThreshold: config.identityConfidenceThreshold,
      });
    }
  }

  console.log(
    JSON.stringify({
      level: "info",
      message: "bot assignments served",
      tenants: connected.length,
      assignments: assignments.length,
      problems: problems.length,
    }),
  );

  return c.json({ assignments, problems, pollAfterSec: 20 });
});

export default app;

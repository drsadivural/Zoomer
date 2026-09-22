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
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { monitoringEvents, sessionParticipants, trainingSessions, trainees } from "../db/schema";
import { timingSafeEqual } from "../lib/crypto";
import { badRequest, notFound, serverError, unauthorized } from "../lib/errors";
import { parseBody } from "../lib/http";
import { publishToSession } from "../lib/realtime";
import {
  checkPlausibility, evaluate, nextStatus, type ParticipantStatus, type ProposedEvent, type Severity,
} from "../lib/rules";
import { getRules, ruleVersionTag } from "../lib/settings";
import type { Env, Variables } from "../types";
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

export default app;

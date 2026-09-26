/**
 * Trainee-facing endpoints.
 *
 * These are reached from the Zoomer 受講画面 that the trainee opens alongside
 * Zoom. Two credentials are in play:
 *   - a join token (per participant, expires with the session) for precheck;
 *   - a device token (minted on a successful precheck) for the monitoring loop.
 *
 * The 1:1 comparison that decides "is this the enrolled person" runs *here*,
 * not in the browser, so a tampered client cannot simply claim it passed.
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import {
  alerts,
  consents,
  evidenceObjects,
  faceEnrollments,
  monitoringEvents,
  sessionParticipants,
  trainees,
  trainingSessions,
} from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getDevice, requireDevice } from "../lib/auth";
import { generateToken } from "../lib/crypto";
import { badRequest, forbidden, notFound, serverError, unprocessable } from "../lib/errors";
import { decodeDataUrl, putEncrypted } from "../lib/evidence";
import { assertDescriptor, assessQuality, matchScore as computeMatchScore, unsealDescriptor } from "../lib/faces";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import { verifyJoinToken } from "../lib/join";
import { publishToSession } from "../lib/realtime";
import { checkPlausibility, evaluate, nextStatus, type ParticipantStatus, type Severity } from "../lib/rules";
import { getRules, ruleVersionTag } from "../lib/settings";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEVICE_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
export const CONSENT_POLICY_VERSION = "2026-09-01";

async function loadParticipantByJoin(env: Env, participantId: string, token: string) {
  const signingKey = env.SESSION_SIGNING_KEY;
  if (!signingKey) throw serverError("SESSION_SIGNING_KEY が未設定です");
  await verifyJoinToken(participantId, token, signingKey);

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      participant: sessionParticipants,
      session: trainingSessions,
      trainee: trainees,
    })
    .from(sessionParticipants)
    .innerJoin(trainingSessions, eq(trainingSessions.id, sessionParticipants.sessionId))
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(eq(sessionParticipants.id, participantId))
    .limit(1);

  if (!rows[0]) throw notFound("参加情報が見つかりません");
  return rows[0];
}

/* ------------------------------------------------------------ join screen */

app.get("/session/:participantId", async (c) => {
  const token = c.req.query("t");
  if (!token) throw forbidden("参加トークンがありません");
  const { participant, session, trainee } = await loadParticipantByJoin(
    c.env,
    c.req.param("participantId"),
    token,
  );

  const db = drizzle(c.env.DB);
  const rules = await getRules(c.env.DB, participant.organizationId);
  const enrollment = participant.traineeId
    ? await db
        .select({ id: faceEnrollments.id, engine: faceEnrollments.engine })
        .from(faceEnrollments)
        .where(
          and(
            eq(faceEnrollments.traineeId, participant.traineeId),
            eq(faceEnrollments.status, "ACTIVE"),
            isNull(faceEnrollments.deletedAt),
          ),
        )
        .orderBy(desc(faceEnrollments.createdAt))
        .limit(1)
    : [];

  return c.json({
    participant: {
      id: participant.id,
      status: participant.status,
      precheckAttempts: participant.precheckAttempts,
      precheckAt: participant.precheckAt,
    },
    session: {
      id: session.id,
      title: session.title,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      status: session.status,
    },
    trainee: trainee ? { name: trainee.name, externalId: trainee.externalId } : null,
    enrolled: enrollment.length > 0,
    engine: enrollment[0]?.engine ?? null,
    consentPolicyVersion: CONSENT_POLICY_VERSION,
    rules: {
      reauthIntervalSec: rules.reauthIntervalSec,
      absenceSec: rules.absenceSec,
      eyesClosedSec: rules.eyesClosedSec,
      multiFaceFrames: rules.multiFaceFrames,
      evidenceIntervalSec: rules.evidenceIntervalSec,
      livenessRequired: rules.livenessRequired,
      precheckMaxAttempts: rules.precheckMaxAttempts,
    },
  });
});

/* ---------------------------------------------------------------- consent */

const consentSchema = z.object({
  token: z.string().min(1),
  policyVersion: z.string().min(1),
  scope: z.array(z.string()).min(1),
  granted: z.boolean(),
});

app.post("/session/:participantId/consent", async (c) => {
  const body = await parseBody(c, consentSchema);
  const participantId = c.req.param("participantId");
  const { participant } = await loadParticipantByJoin(c.env, participantId, body.token);
  if (!participant.traineeId) throw badRequest("受講者が特定できていません");

  const db = drizzle(c.env.DB);
  if (!body.granted) {
    // A refusal is a legitimate outcome and must be recorded, not treated as an error.
    await recordAudit(c.env.DB, {
      organizationId: participant.organizationId,
      actorId: participant.id,
      actorType: "device",
      action: "consent.declined",
      resourceType: "session_participant",
      resourceId: participantId,
      requestId: c.get("requestId"),
    });
    return c.json({ granted: false });
  }

  await db.insert(consents).values({
    id: newId("consent"),
    organizationId: participant.organizationId,
    traineeId: participant.traineeId,
    sessionId: participant.sessionId,
    policyVersion: body.policyVersion,
    scope: body.scope,
    userAgent: c.req.header("User-Agent") ?? null,
  });

  await recordAudit(c.env.DB, {
    organizationId: participant.organizationId,
    actorId: participant.id,
    actorType: "device",
    action: "consent.granted",
    resourceType: "session_participant",
    resourceId: participantId,
    metadata: { policyVersion: body.policyVersion, scope: body.scope },
    requestId: c.get("requestId"),
  });

  return c.json({ granted: true });
});

/* --------------------------------------------------------------- precheck */

const precheckSchema = z.object({
  token: z.string().min(1),
  descriptor: z.array(z.number()).min(64).max(1024),
  engine: z.string().min(1),
  modelVersion: z.string().min(1),
  quality: z.object({
    faceCount: z.number().int().min(0),
    relativeSize: z.number().min(0).max(1),
    yaw: z.number(),
    pitch: z.number(),
    brightness: z.number().min(0).max(1),
    sharpness: z.number().min(0).max(1),
    occlusion: z.number().min(0).max(1),
  }),
  liveness: z.object({
    passed: z.boolean(),
    blinks: z.number().int().min(0),
    motionScore: z.number().min(0).max(1),
  }),
});

app.post("/session/:participantId/precheck", async (c) => {
  const body = await parseBody(c, precheckSchema);
  const participantId = c.req.param("participantId");
  const { participant, session } = await loadParticipantByJoin(c.env, participantId, body.token);
  const key = c.env.DATA_ENCRYPTION_KEY;
  if (!key) throw serverError("DATA_ENCRYPTION_KEY が未設定です");
  if (!participant.traineeId) throw badRequest("受講者が特定できていません");

  const db = drizzle(c.env.DB);
  const rules = await getRules(c.env.DB, participant.organizationId);

  // Consent is a precondition, not a checkbox. It must be scoped to *this*
  // session: the consent an administrator recorded at enrollment time is a
  // different act from the trainee agreeing to be monitored today
  // (PRODUCT_SPEC_JA.md §3.2).
  const consentRows = await db
    .select({ id: consents.id })
    .from(consents)
    .where(
      and(
        eq(consents.traineeId, participant.traineeId),
        eq(consents.organizationId, participant.organizationId),
        eq(consents.sessionId, participant.sessionId),
        isNull(consents.revokedAt),
      ),
    )
    .limit(1);
  if (!consentRows.length) throw forbidden("カメラ利用と顔情報処理への同意が必要です");

  if (participant.precheckAttempts >= rules.precheckMaxAttempts) {
    throw forbidden("本人確認の試行回数上限に達しました。管理者にお問い合わせください");
  }

  const quality = assessQuality(body.quality);
  if (!quality.passed) {
    await db
      .update(sessionParticipants)
      .set({ precheckAttempts: participant.precheckAttempts + 1, updatedAt: Date.now() })
      .where(eq(sessionParticipants.id, participantId));
    return c.json(
      {
        result: "QUALITY_REJECTED",
        reasons: quality.reasons,
        score: quality.score,
        attemptsRemaining: Math.max(0, rules.precheckMaxAttempts - participant.precheckAttempts - 1),
      },
      422,
    );
  }

  if (rules.livenessRequired && !body.liveness.passed) {
    await db
      .update(sessionParticipants)
      .set({ precheckAttempts: participant.precheckAttempts + 1, updatedAt: Date.now() })
      .where(eq(sessionParticipants.id, participantId));
    return c.json(
      {
        result: "LIVENESS_FAILED",
        reasons: ["生体検知に失敗しました。画面の指示に従って瞬きしてください"],
        attemptsRemaining: Math.max(0, rules.precheckMaxAttempts - participant.precheckAttempts - 1),
      },
      422,
    );
  }

  const enrollmentRows = await db
    .select()
    .from(faceEnrollments)
    .where(
      and(
        eq(faceEnrollments.traineeId, participant.traineeId),
        eq(faceEnrollments.organizationId, participant.organizationId),
        eq(faceEnrollments.status, "ACTIVE"),
        isNull(faceEnrollments.deletedAt),
      ),
    )
    .orderBy(desc(faceEnrollments.createdAt));

  if (!enrollmentRows.length) {
    throw unprocessable("顔登録が完了していません。管理者にお問い合わせください");
  }

  // Only templates from the same engine are comparable at all.
  const comparable = enrollmentRows.filter((e) => e.engine === body.engine);
  if (!comparable.length) {
    throw unprocessable(
      `顔登録時のエンジン（${enrollmentRows[0].engine}）と異なります。再登録が必要です`,
    );
  }

  // Best score across every template the trainee has enrolled.
  //
  // A trainee may register several photos — different poses, lighting, with
  // and without glasses — and the whole point of allowing that is that the
  // live frame gets compared against all of them. Taking only the newest
  // would silently discard the others and make a second enrollment actively
  // harmful whenever it happened to be the least representative shot.
  const live = assertDescriptor(body.descriptor, body.engine);
  let matchScore = 0;
  let compared = 0;
  for (const candidate of comparable) {
    let stored: number[];
    try {
      stored = await unsealDescriptor(candidate.template, candidate.templateIv, key);
    } catch {
      continue; // One unreadable template must not fail the whole check.
    }
    compared++;
    matchScore = Math.max(matchScore, computeMatchScore(live, stored));
  }
  if (!compared) throw unprocessable("登録済みの顔特徴量を読み取れませんでした");
  const passed = matchScore >= rules.matchThreshold;

  const attempts = participant.precheckAttempts + 1;
  const ruleVersion = session.ruleVersion ?? ruleVersionTag(participant.organizationId, rules.version);
  const judgement = evaluate(
    {
      type: passed ? "PRECHECK_PASS" : "PRECHECK_FAIL",
      capturedAt: Date.now(),
      matchScore,
      qualityScore: quality.score,
    },
    rules,
  );

  await db.insert(monitoringEvents).values({
    id: newId("event"),
    organizationId: participant.organizationId,
    sessionId: participant.sessionId,
    participantId,
    type: passed ? "PRECHECK_PASS" : "PRECHECK_FAIL",
    severity: judgement.severity,
    capturedAt: Date.now(),
    matchScore,
    qualityScore: quality.score,
    modelVersion: body.modelVersion,
    ruleVersion,
  });

  let deviceToken: string | null = null;
  if (passed) {
    const generated = await generateToken();
    deviceToken = generated.token;
    await db
      .update(sessionParticipants)
      .set({
        status: "VERIFIED",
        statusDetail: "本人確認済み",
        lastMatchScore: matchScore,
        lastSeenAt: Date.now(),
        precheckAt: Date.now(),
        precheckAttempts: attempts,
        deviceTokenHash: generated.hash,
        deviceTokenExpiresAt: Date.now() + DEVICE_TOKEN_TTL_MS,
        updatedAt: Date.now(),
      })
      .where(eq(sessionParticipants.id, participantId));
  } else {
    await db
      .update(sessionParticipants)
      .set({
        precheckAttempts: attempts,
        lastMatchScore: matchScore,
        statusDetail: "本人確認に失敗しました",
        updatedAt: Date.now(),
      })
      .where(eq(sessionParticipants.id, participantId));

    // Exhausting the attempt budget escalates to a human rather than silently
    // locking the trainee out (実装指示: 自動判定だけで不合格にしない).
    if (attempts >= rules.precheckMaxAttempts) {
      await db
        .insert(alerts)
        .values({
          id: newId("alert"),
          organizationId: participant.organizationId,
          sessionId: participant.sessionId,
          participantId,
          type: "本人確認失敗",
          severity: "ALERT",
          summary: "本人確認が上限回数まで失敗しました",
          detail: `試行 ${attempts} 回 / 最終一致度 ${(matchScore * 100).toFixed(1)}%`,
          dedupeKey: "PRECHECK_EXHAUSTED",
          ruleVersion,
          modelVersion: body.modelVersion,
        })
        .onConflictDoNothing();
    }
  }

  await recordAudit(c.env.DB, {
    organizationId: participant.organizationId,
    actorId: participantId,
    actorType: "device",
    action: passed ? "precheck.pass" : "precheck.fail",
    resourceType: "session_participant",
    resourceId: participantId,
    result: passed ? "SUCCESS" : "DENIED",
    metadata: { matchScore, qualityScore: quality.score, attempts, ruleVersion },
    requestId: c.get("requestId"),
  });

  await publishToSession(c.env, participant.sessionId, "participant.status.changed", {
    participantId,
    status: passed ? "VERIFIED" : "PRECHECK_PENDING",
    matchScore,
  });

  return c.json({
    result: passed ? "VERIFIED" : "MISMATCH",
    matchScore,
    threshold: rules.matchThreshold,
    qualityScore: quality.score,
    attemptsRemaining: Math.max(0, rules.precheckMaxAttempts - attempts),
    deviceToken,
    deviceTokenExpiresAt: passed ? Date.now() + DEVICE_TOKEN_TTL_MS : null,
    escalated: !passed && attempts >= rules.precheckMaxAttempts,
  });
});

/* ------------------------------------------------------------- re-auth */

const reauthSchema = z.object({
  descriptor: z.array(z.number()).min(64).max(1024),
  engine: z.string().min(1),
  modelVersion: z.string().min(1),
  qualityScore: z.number().min(0).max(1),
});

/**
 * Periodic continuous authentication.
 *
 * The comparison happens here rather than in the browser so the enrolled
 * template never leaves the server: the device sends only the live descriptor.
 * A single low score is recorded but, per 実装指示, does not by itself fail the
 * trainee — the rules engine decides what the score means.
 */
app.post("/reauth", requireDevice, async (c) => {
  const device = getDevice(c);
  const body = await parseBody(c, reauthSchema);
  const key = c.env.DATA_ENCRYPTION_KEY;
  if (!key) throw serverError("DATA_ENCRYPTION_KEY が未設定です");

  const db = drizzle(c.env.DB);
  const partRows = await db
    .select()
    .from(sessionParticipants)
    .where(eq(sessionParticipants.id, device.participantId))
    .limit(1);
  const participant = partRows[0];
  if (!participant?.traineeId) throw notFound("参加者が見つかりません");

  const sessionRows = await db
    .select()
    .from(trainingSessions)
    .where(eq(trainingSessions.id, device.sessionId))
    .limit(1);
  const session = sessionRows[0];
  const rules = (session?.ruleSnapshot as never) ?? (await getRules(c.env.DB, device.organizationId));
  const threshold = (rules as { matchThreshold: number }).matchThreshold;
  const ruleVersion =
    session?.ruleVersion ?? ruleVersionTag(device.organizationId, (rules as { version: number }).version);

  const enrollmentRows = await db
    .select()
    .from(faceEnrollments)
    .where(
      and(
        eq(faceEnrollments.traineeId, participant.traineeId),
        eq(faceEnrollments.organizationId, device.organizationId),
        eq(faceEnrollments.status, "ACTIVE"),
        isNull(faceEnrollments.deletedAt),
      ),
    )
    .orderBy(desc(faceEnrollments.createdAt))
    .limit(1);
  const enrollment = enrollmentRows[0];
  if (!enrollment) throw unprocessable("顔登録が見つかりません");
  if (enrollment.engine !== body.engine) throw unprocessable("顔登録時のエンジンと異なります");

  const live = assertDescriptor(body.descriptor, body.engine);
  const stored = await unsealDescriptor(enrollment.template, enrollment.templateIv, key);
  const matchScore = computeMatchScore(live, stored);
  const passed = matchScore >= threshold;

  const type = passed ? "MATCH_OK" : "MATCH_FAIL";
  const judgement = evaluate(
    { type, capturedAt: Date.now(), matchScore, qualityScore: body.qualityScore },
    rules as never,
  );

  await db.insert(monitoringEvents).values({
    id: newId("event"),
    organizationId: device.organizationId,
    sessionId: device.sessionId,
    participantId: device.participantId,
    type,
    severity: judgement.severity,
    capturedAt: Date.now(),
    matchScore,
    qualityScore: body.qualityScore,
    modelVersion: body.modelVersion,
    ruleVersion,
  });

  const status = nextStatus(participant.status as ParticipantStatus, judgement.status);
  await db
    .update(sessionParticipants)
    .set({ status, lastMatchScore: matchScore, lastSeenAt: Date.now(), updatedAt: Date.now() })
    .where(eq(sessionParticipants.id, device.participantId));

  if (!passed && judgement.alertType && judgement.dedupeKey) {
    await upsertAlert(c.env, {
      organizationId: device.organizationId,
      sessionId: device.sessionId,
      participantId: device.participantId,
      type: judgement.alertType,
      severity: judgement.severity,
      summary: judgement.summary,
      detail: judgement.detail,
      dedupeKey: judgement.dedupeKey,
      eventId: newId("event"),
      evidenceId: null,
      ruleVersion,
      modelVersion: body.modelVersion,
    });
  }

  if (status !== participant.status) {
    await publishToSession(c.env, device.sessionId, "participant.status.changed", {
      participantId: device.participantId,
      status,
      lastMatchScore: matchScore,
    });
  }

  return c.json({ matchScore, threshold, passed });
});

/* ------------------------------------------------------------ event intake */

const eventSchema = z.object({
  eventId: z.string().min(8).max(64),
  type: z.enum([
    "FACE_ABSENT", "MULTIPLE_FACES", "EYES_CLOSED", "MATCH_OK", "MATCH_FAIL",
    "CAMERA_BLOCKED", "CAMERA_STOPPED", "TAB_HIDDEN", "NETWORK_LOST", "HEARTBEAT",
  ]),
  severity: z.enum(["INFO", "WARNING", "ALERT"]).optional(),
  capturedAt: z.number().int(),
  durationMs: z.number().int().optional().nullable(),
  faceCount: z.number().int().optional().nullable(),
  frameCount: z.number().int().optional().nullable(),
  matchScore: z.number().optional().nullable(),
  qualityScore: z.number().optional().nullable(),
  modelVersion: z.string().max(64).optional(),
  evidence: z.string().max(4_000_000).optional(),
});

const eventsSchema = z.object({ events: z.array(eventSchema).min(1).max(50) });

app.post("/events", requireDevice, async (c) => {
  const device = getDevice(c);
  const body = await parseBody(c, eventsSchema);
  const db = drizzle(c.env.DB);
  const now = Date.now();

  const partRows = await db
    .select()
    .from(sessionParticipants)
    .where(eq(sessionParticipants.id, device.participantId))
    .limit(1);
  const participant = partRows[0];
  if (!participant) throw notFound("参加者が見つかりません");

  const sessionRows = await db
    .select()
    .from(trainingSessions)
    .where(eq(trainingSessions.id, device.sessionId))
    .limit(1);
  const session = sessionRows[0];

  // Prefer the snapshot frozen at go-live over current settings.
  const rules = (session?.ruleSnapshot as never) ?? (await getRules(c.env.DB, device.organizationId));
  const ruleVersion =
    session?.ruleVersion ?? ruleVersionTag(device.organizationId, (rules as { version: number }).version);

  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)` })
    .from(monitoringEvents)
    .where(
      and(
        eq(monitoringEvents.participantId, device.participantId),
        gte(monitoringEvents.receivedAt, now - 60_000),
      ),
    );

  const accepted: string[] = [];
  const rejected: { eventId: string; reason: string }[] = [];
  let status: ParticipantStatus = participant.status as ParticipantStatus;
  let lastMatchScore = participant.lastMatchScore;

  for (const raw of body.events) {
    const plausibility = checkPlausibility(raw, now, recent + accepted.length);
    if (!plausibility.ok) {
      rejected.push({ eventId: raw.eventId, reason: plausibility.reason ?? "不正なイベント" });
      continue;
    }

    const judgement = evaluate(raw, rules as never, raw.severity as Severity | undefined);

    let evidenceId: string | null = null;
    if (raw.evidence && judgement.evidenceRequired && !plausibility.quarantine) {
      evidenceId = await storeEvidence(c.env, {
        organizationId: device.organizationId,
        sessionId: device.sessionId,
        participantId: device.participantId,
        dataUrl: raw.evidence,
        kind: raw.type,
        capturedAt: raw.capturedAt,
        retentionDays: (rules as { evidenceRetentionDays: number }).evidenceRetentionDays,
      });
    }

    try {
      await db.insert(monitoringEvents).values({
        id: raw.eventId,
        organizationId: device.organizationId,
        sessionId: device.sessionId,
        participantId: device.participantId,
        type: raw.type,
        severity: judgement.severity,
        capturedAt: raw.capturedAt,
        receivedAt: now,
        durationMs: raw.durationMs ?? null,
        faceCount: raw.faceCount ?? null,
        matchScore: raw.matchScore ?? null,
        qualityScore: raw.qualityScore ?? null,
        modelVersion: raw.modelVersion ?? null,
        ruleVersion,
        evidenceId,
        serverAdjusted: judgement.adjusted,
        quarantined: plausibility.quarantine,
        quarantineReason: plausibility.reason ?? null,
      });
      accepted.push(raw.eventId);
    } catch {
      // Duplicate primary key: the client retried a delivery we already have.
      rejected.push({ eventId: raw.eventId, reason: "重複イベント（処理済み）" });
      continue;
    }

    if (plausibility.quarantine) continue;

    if (raw.matchScore != null) lastMatchScore = raw.matchScore;
    status = nextStatus(status, judgement.status);

    if (judgement.alertType && judgement.dedupeKey) {
      await upsertAlert(c.env, {
        organizationId: device.organizationId,
        sessionId: device.sessionId,
        participantId: device.participantId,
        type: judgement.alertType,
        severity: judgement.severity,
        summary: judgement.summary,
        detail: judgement.detail,
        dedupeKey: judgement.dedupeKey,
        eventId: raw.eventId,
        evidenceId,
        ruleVersion,
        modelVersion: raw.modelVersion ?? null,
      });
    }
  }

  await db
    .update(sessionParticipants)
    .set({
      status,
      lastMatchScore,
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(eq(sessionParticipants.id, device.participantId));

  if (status !== participant.status) {
    await publishToSession(c.env, device.sessionId, "participant.status.changed", {
      participantId: device.participantId,
      status,
      lastMatchScore,
    });
  }

  return c.json({ accepted: accepted.length, rejected });
});

/* ------------------------------------------------------------- internals */

export async function storeEvidence(
  env: Env,
  input: {
    organizationId: string;
    sessionId: string;
    participantId: string;
    dataUrl: string;
    kind: string;
    capturedAt: number;
    retentionDays: number;
  },
): Promise<string | null> {
  const key = env.DATA_ENCRYPTION_KEY;
  if (!key) return null;
  try {
    const { bytes, contentType } = decodeDataUrl(input.dataUrl);
    const id = newId("evidence");
    const objectKey = `${input.organizationId}/${input.sessionId}/${id}.bin`;
    const { sha256, byteSize } = await putEncrypted(env.EVIDENCE, objectKey, bytes, key, contentType);

    await drizzle(env.DB).insert(evidenceObjects).values({
      id,
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      participantId: input.participantId,
      objectKey,
      contentType,
      byteSize,
      sha256,
      kind: input.kind,
      capturedAt: input.capturedAt,
      expiresAt: Date.now() + input.retentionDays * 24 * 60 * 60 * 1000,
    });
    return id;
  } catch (err) {
    // Losing an evidence frame must never drop the event that referenced it.
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "evidence store failed",
        sessionId: input.sessionId,
        error: err instanceof Error ? err.message : "unknown",
      }),
    );
    return null;
  }
}

export async function upsertAlert(
  env: Env,
  input: {
    organizationId: string;
    sessionId: string;
    participantId: string;
    type: string;
    severity: string;
    summary: string;
    detail: string;
    dedupeKey: string;
    eventId: string;
    evidenceId: string | null;
    ruleVersion: string;
    modelVersion: string | null;
  },
): Promise<void> {
  const db = drizzle(env.DB);
  // One open alert per (participant, condition): repeats bump the counter
  // instead of spamming a new row and a new notification.
  const dedupeKey = `${input.participantId}:${input.dedupeKey}`;

  const existing = await db
    .select({ id: alerts.id, occurrences: alerts.occurrences, state: alerts.state })
    .from(alerts)
    .where(and(eq(alerts.sessionId, input.sessionId), eq(alerts.dedupeKey, dedupeKey)))
    .limit(1);

  if (existing[0]) {
    if (existing[0].state === "OPEN" || existing[0].state === "ESCALATED") {
      await db
        .update(alerts)
        .set({
          occurrences: existing[0].occurrences + 1,
          lastEventId: input.eventId,
          detail: input.detail,
          evidenceId: input.evidenceId ?? undefined,
          updatedAt: Date.now(),
        })
        .where(eq(alerts.id, existing[0].id));
      await publishToSession(env, input.sessionId, "alert.updated", {
        alertId: existing[0].id,
        occurrences: existing[0].occurrences + 1,
      });
    }
    return;
  }

  const id = newId("alert");
  await db.insert(alerts).values({
    id,
    organizationId: input.organizationId,
    sessionId: input.sessionId,
    participantId: input.participantId,
    type: input.type,
    severity: input.severity,
    summary: input.summary,
    detail: input.detail,
    firstEventId: input.eventId,
    lastEventId: input.eventId,
    evidenceId: input.evidenceId,
    dedupeKey,
    ruleVersion: input.ruleVersion,
    modelVersion: input.modelVersion,
  });

  await publishToSession(env, input.sessionId, "alert.created", {
    alertId: id,
    participantId: input.participantId,
    type: input.type,
    severity: input.severity,
    summary: input.summary,
    detail: input.detail,
  });
}

export default app;

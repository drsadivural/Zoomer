import { and, asc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { alerts, monitoringEvents, reports, sessionParticipants, trainees, trainingSessions } from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { withIdempotency } from "../lib/idempotency";
import { toCsv } from "../lib/csv";
import { notFound } from "../lib/errors";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);
app.use("*", withIdempotency());

const createSchema = z.object({
  kind: z.enum(["EVENTS_CSV", "ALERTS_CSV", "ATTENDANCE_CSV"]),
  sessionId: z.string().optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});

/**
 * Report generation. Exports are synchronous here because D1 result sets for a
 * single session are small; the row cap keeps a runaway range from exhausting
 * the worker's memory. Every export is audited — this is the action that moves
 * evidence metadata out of the system.
 */
app.post("/", requirePermission("report:create"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, createSchema);
  const db = drizzle(c.env.DB);
  const id = newId("report");
  const LIMIT = 50_000;

  let csv = "";
  let rowCount = 0;

  if (body.kind === "EVENTS_CSV") {
    const filters = [eq(monitoringEvents.organizationId, actor.organizationId)];
    if (body.sessionId) filters.push(eq(monitoringEvents.sessionId, body.sessionId));
    if (body.from) filters.push(gte(monitoringEvents.capturedAt, body.from));
    if (body.to) filters.push(lte(monitoringEvents.capturedAt, body.to));

    const rows = await db
      .select({
        capturedAt: monitoringEvents.capturedAt,
        type: monitoringEvents.type,
        severity: monitoringEvents.severity,
        traineeName: trainees.name,
        externalId: trainees.externalId,
        durationMs: monitoringEvents.durationMs,
        faceCount: monitoringEvents.faceCount,
        matchScore: monitoringEvents.matchScore,
        qualityScore: monitoringEvents.qualityScore,
        modelVersion: monitoringEvents.modelVersion,
        ruleVersion: monitoringEvents.ruleVersion,
        hasEvidence: monitoringEvents.evidenceId,
      })
      .from(monitoringEvents)
      .leftJoin(sessionParticipants, eq(sessionParticipants.id, monitoringEvents.participantId))
      .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
      .where(and(...filters))
      .orderBy(asc(monitoringEvents.capturedAt))
      .limit(LIMIT);

    rowCount = rows.length;
    csv = toCsv(
      ["発生時刻(UTC)", "種別", "重要度", "氏名", "受講者ID", "継続ms", "顔検出数", "一致度", "品質", "モデル版", "ルール版", "証跡有無"],
      rows.map((r) => [
        new Date(r.capturedAt).toISOString(), r.type, r.severity, r.traineeName ?? "", r.externalId ?? "",
        r.durationMs ?? "", r.faceCount ?? "",
        r.matchScore != null ? (r.matchScore * 100).toFixed(1) + "%" : "",
        r.qualityScore != null ? r.qualityScore.toFixed(2) : "",
        r.modelVersion ?? "", r.ruleVersion ?? "",
        // Deliberately a boolean, never the object key or a signed URL.
        r.hasEvidence ? "あり" : "なし",
      ]),
    );
  } else if (body.kind === "ALERTS_CSV") {
    const filters = [eq(alerts.organizationId, actor.organizationId)];
    if (body.sessionId) filters.push(eq(alerts.sessionId, body.sessionId));
    if (body.from) filters.push(gte(alerts.openedAt, body.from));
    if (body.to) filters.push(lte(alerts.openedAt, body.to));

    const rows = await db
      .select({
        openedAt: alerts.openedAt, type: alerts.type, severity: alerts.severity,
        state: alerts.state, summary: alerts.summary, detail: alerts.detail,
        occurrences: alerts.occurrences, traineeName: trainees.name,
        externalId: trainees.externalId, ruleVersion: alerts.ruleVersion,
      })
      .from(alerts)
      .leftJoin(sessionParticipants, eq(sessionParticipants.id, alerts.participantId))
      .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
      .where(and(...filters))
      .orderBy(asc(alerts.openedAt))
      .limit(LIMIT);

    rowCount = rows.length;
    csv = toCsv(
      ["発生時刻(UTC)", "種別", "重要度", "状態", "概要", "詳細", "回数", "氏名", "受講者ID", "ルール版"],
      rows.map((r) => [
        new Date(r.openedAt).toISOString(), r.type, r.severity, r.state, r.summary,
        r.detail ?? "", r.occurrences, r.traineeName ?? "", r.externalId ?? "", r.ruleVersion ?? "",
      ]),
    );
  } else {
    const filters = [eq(sessionParticipants.organizationId, actor.organizationId)];
    if (body.sessionId) filters.push(eq(sessionParticipants.sessionId, body.sessionId));

    const rows = await db
      .select({
        sessionTitle: trainingSessions.title, startsAt: trainingSessions.startsAt,
        traineeName: trainees.name, externalId: trainees.externalId,
        department: trainees.department, status: sessionParticipants.status,
        precheckAt: sessionParticipants.precheckAt,
        lastMatchScore: sessionParticipants.lastMatchScore,
        zoomDisplayName: sessionParticipants.zoomDisplayName,
        zoomJoinedAt: sessionParticipants.zoomJoinedAt,
        zoomLeftAt: sessionParticipants.zoomLeftAt,
        matchMethod: sessionParticipants.matchMethod,
      })
      .from(sessionParticipants)
      .innerJoin(trainingSessions, eq(trainingSessions.id, sessionParticipants.sessionId))
      .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
      .where(and(...filters))
      .orderBy(asc(trainingSessions.startsAt))
      .limit(LIMIT);

    rowCount = rows.length;
    csv = toCsv(
      ["研修", "開始(UTC)", "氏名", "受講者ID", "所属", "状態", "本人確認時刻(UTC)", "最終一致度", "Zoom表示名", "Zoom参加(UTC)", "Zoom退出(UTC)", "照合方法"],
      rows.map((r) => [
        r.sessionTitle, new Date(r.startsAt).toISOString(), r.traineeName ?? "", r.externalId ?? "",
        r.department ?? "", r.status,
        r.precheckAt ? new Date(r.precheckAt).toISOString() : "",
        r.lastMatchScore != null ? (r.lastMatchScore * 100).toFixed(1) + "%" : "",
        r.zoomDisplayName ?? "",
        r.zoomJoinedAt ? new Date(r.zoomJoinedAt).toISOString() : "",
        r.zoomLeftAt ? new Date(r.zoomLeftAt).toISOString() : "",
        r.matchMethod ?? "",
      ]),
    );
  }

  const objectKey = `${actor.organizationId}/${id}.csv`;
  await c.env.REPORTS.put(objectKey, csv, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
  });

  await db.insert(reports).values({
    id,
    organizationId: actor.organizationId,
    kind: body.kind,
    status: "COMPLETED",
    params: body,
    objectKey,
    rowCount,
    requestedBy: actor.userId,
    completedAt: Date.now(),
    expiresAt: Date.now() + 7 * 86_400_000,
  });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "report.create",
    resourceType: "report",
    resourceId: id,
    metadata: { kind: body.kind, rowCount, sessionId: body.sessionId },
    requestId: c.get("requestId"),
  });

  return c.json({ report: { id, kind: body.kind, status: "COMPLETED", rowCount } }, 201);
});

app.get("/:id/content", requirePermission("evidence:export"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(reports)
    .where(
      and(eq(reports.id, c.req.param("id")), eq(reports.organizationId, actor.organizationId)),
    )
    .limit(1);
  const report = rows[0];
  if (!report?.objectKey) throw notFound("レポートが見つかりません");

  const object = await c.env.REPORTS.get(report.objectKey);
  if (!object) throw notFound("レポートデータが見つかりません");

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "report.download",
    resourceType: "report",
    resourceId: report.id,
    metadata: { kind: report.kind, rowCount: report.rowCount },
    requestId: c.get("requestId"),
  });

  return new Response(object.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report.kind.toLowerCase()}-${report.id}.csv"`,
      "Cache-Control": "no-store, private",
    },
  });
});

app.get("/", requirePermission("report:create"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(reports)
    .where(eq(reports.organizationId, actor.organizationId))
    .orderBy(asc(reports.createdAt))
    .limit(50);
  return c.json({ reports: rows });
});

export default app;

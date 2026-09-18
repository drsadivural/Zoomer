import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { alertReviews, alerts, sessionParticipants, trainees } from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { withIdempotency } from "../lib/idempotency";
import { notFound } from "../lib/errors";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import { publishToSession } from "../lib/realtime";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);
app.use("*", withIdempotency());

app.get("/", requirePermission("alert:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const filters = [eq(alerts.organizationId, actor.organizationId)];
  const state = c.req.query("state");
  const sessionId = c.req.query("sessionId");
  if (state) filters.push(eq(alerts.state, state));
  if (sessionId) filters.push(eq(alerts.sessionId, sessionId));

  const rows = await db
    .select({
      id: alerts.id,
      sessionId: alerts.sessionId,
      participantId: alerts.participantId,
      type: alerts.type,
      severity: alerts.severity,
      state: alerts.state,
      summary: alerts.summary,
      detail: alerts.detail,
      occurrences: alerts.occurrences,
      evidenceId: alerts.evidenceId,
      assignedTo: alerts.assignedTo,
      openedAt: alerts.openedAt,
      updatedAt: alerts.updatedAt,
      ruleVersion: alerts.ruleVersion,
      modelVersion: alerts.modelVersion,
      traineeName: trainees.name,
      traineeExternalId: trainees.externalId,
    })
    .from(alerts)
    .leftJoin(sessionParticipants, eq(sessionParticipants.id, alerts.participantId))
    .leftJoin(trainees, eq(trainees.id, sessionParticipants.traineeId))
    .where(and(...filters))
    .orderBy(desc(alerts.openedAt))
    .limit(Math.min(Number(c.req.query("limit") ?? 100), 300));

  return c.json({ alerts: rows });
});

/**
 * Review actions. `FALSE_POSITIVE` carries a structured reason so that
 * misdetections can be aggregated anonymously for model evaluation
 * (SECURITY_PRIVACY.md §4).
 */
const patchSchema = z.object({
  action: z.enum(["ACKNOWLEDGE", "FALSE_POSITIVE", "ESCALATE", "RESOLVE", "ASSIGN"]),
  reasonCode: z
    .enum(["GLASSES", "LIGHTING", "NETWORK", "HEAD_POSE", "OCCLUSION", "OTHER"])
    .optional(),
  comment: z.string().max(1000).optional(),
  assignedTo: z.string().optional(),
});

const STATE_FOR: Record<string, string> = {
  ACKNOWLEDGE: "ACKNOWLEDGED",
  FALSE_POSITIVE: "FALSE_POSITIVE",
  ESCALATE: "ESCALATED",
  RESOLVE: "RESOLVED",
};

app.patch("/:id", requirePermission("alert:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, patchSchema);
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const rows = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.id, id), eq(alerts.organizationId, actor.organizationId)))
    .limit(1);
  const alert = rows[0];
  if (!alert) throw notFound("アラートが見つかりません");

  const nextState = body.action === "ASSIGN" ? alert.state : STATE_FOR[body.action];
  const closing = nextState === "RESOLVED" || nextState === "FALSE_POSITIVE";

  await db
    .update(alerts)
    .set({
      state: nextState,
      assignedTo: body.assignedTo ?? alert.assignedTo,
      closedAt: closing ? Date.now() : alert.closedAt,
      updatedAt: Date.now(),
    })
    .where(eq(alerts.id, id));

  await db.insert(alertReviews).values({
    id: newId("review"),
    organizationId: actor.organizationId,
    alertId: id,
    reviewerId: actor.userId,
    action: body.action,
    reasonCode: body.reasonCode ?? null,
    comment: body.comment ?? null,
  });

  // A reviewed alert clears the participant's ALERT state; only a human can do this.
  if (closing) {
    await db
      .update(sessionParticipants)
      .set({ status: "REVIEWED", statusDetail: "管理者確認済み", updatedAt: Date.now() })
      .where(
        and(
          eq(sessionParticipants.id, alert.participantId),
          inArray(sessionParticipants.status, ["ALERT", "WARNING"]),
        ),
      );
  }

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: `alert.${body.action.toLowerCase()}`,
    resourceType: "alert",
    resourceId: id,
    metadata: { reasonCode: body.reasonCode, state: nextState },
    requestId: c.get("requestId"),
  });

  await publishToSession(c.env, alert.sessionId, "alert.updated", {
    alertId: id,
    state: nextState,
    reviewedBy: actor.name,
  });

  return c.json({ ok: true, state: nextState });
});

app.get("/:id/reviews", requirePermission("alert:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(alertReviews)
    .where(
      and(
        eq(alertReviews.alertId, c.req.param("id")),
        eq(alertReviews.organizationId, actor.organizationId),
      ),
    )
    .orderBy(desc(alertReviews.createdAt));
  return c.json({ reviews: rows });
});

export default app;

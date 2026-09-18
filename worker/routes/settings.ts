import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { monitoringSettings } from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { withIdempotency } from "../lib/idempotency";
import { parseBody } from "../lib/http";
import { getRules } from "../lib/settings";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);
app.use("*", withIdempotency());

app.get("/monitoring", requirePermission("settings:read"), async (c) => {
  const actor = getActor(c);
  return c.json({ settings: await getRules(c.env.DB, actor.organizationId) });
});

/** Bounds mirror what the UI exposes; values outside them are operator error. */
const updateSchema = z.object({
  reauthIntervalSec: z.number().int().min(15).max(900),
  matchThreshold: z.number().min(0.5).max(0.999),
  absenceSec: z.number().int().min(10).max(600),
  eyesClosedSec: z.number().int().min(3).max(120),
  multiFaceFrames: z.number().int().min(3).max(300),
  evidenceIntervalSec: z.number().int().min(30).max(3600),
  evidenceRetentionDays: z.number().int().min(1).max(365),
  precheckMaxAttempts: z.number().int().min(1).max(10),
  livenessRequired: z.boolean(),
  imageQuality: z.number().min(0.3).max(1),
});

app.put("/monitoring", requirePermission("settings:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, updateSchema);
  const db = drizzle(c.env.DB);
  const current = await getRules(c.env.DB, actor.organizationId);
  // Bumping the version is what makes past judgements explainable: events keep
  // the rule version they were graded under.
  const version = current.version + 1;

  await db
    .insert(monitoringSettings)
    .values({
      organizationId: actor.organizationId,
      version,
      ...body,
      updatedAt: Date.now(),
      updatedBy: actor.userId,
    })
    .onConflictDoUpdate({
      target: monitoringSettings.organizationId,
      set: { version, ...body, updatedAt: Date.now(), updatedBy: actor.userId },
    });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "settings.update",
    resourceType: "monitoring_settings",
    resourceId: actor.organizationId,
    metadata: { version, ...body },
    requestId: c.get("requestId"),
  });

  return c.json({ settings: { version, ...body } });
});

export default app;

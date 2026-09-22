/**
 * Admin-side live monitoring helpers for the ライブ監視 screen.
 *
 * `POST /identify` performs 1:N face identification against the organization's
 * enrolled templates. The comparison runs here, on the server, because the
 * enrolled templates must never be shipped to the browser (SECURITY_PRIVACY.md).
 * The caller sends only a live descriptor extracted on their device; we return
 * the ranked matches and whether the best one clears the org's threshold.
 */
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { faceEnrollments, trainees } from "../db/schema";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { serverError } from "../lib/errors";
import { assertDescriptor, matchScore, unsealDescriptor } from "../lib/faces";
import { parseBody } from "../lib/http";
import { getRules } from "../lib/settings";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const identifySchema = z.object({
  descriptor: z.array(z.number()),
  engine: z.string().min(1),
  topK: z.number().int().min(1).max(10).optional(),
});

app.post("/identify", requireAuth, requirePermission("session:read"), async (c) => {
  const actor = getActor(c);
  const key = c.env.DATA_ENCRYPTION_KEY;
  if (!key) throw serverError("暗号鍵が未設定です");

  const body = await parseBody(c, identifySchema);
  const live = assertDescriptor(body.descriptor, body.engine);
  const rules = await getRules(c.env.DB, actor.organizationId);
  const db = drizzle(c.env.DB);

  // Only templates from the same engine are comparable.
  const rows = await db
    .select({
      traineeId: faceEnrollments.traineeId,
      template: faceEnrollments.template,
      templateIv: faceEnrollments.templateIv,
      name: trainees.name,
      externalId: trainees.externalId,
    })
    .from(faceEnrollments)
    .innerJoin(trainees, eq(trainees.id, faceEnrollments.traineeId))
    .where(
      and(
        eq(faceEnrollments.organizationId, actor.organizationId),
        eq(faceEnrollments.status, "ACTIVE"),
        eq(faceEnrollments.engine, body.engine),
        isNull(faceEnrollments.deletedAt),
        isNull(trainees.deletedAt),
      ),
    );

  // Best score per trainee (a trainee may have several enrolled photos).
  const best = new Map<string, { traineeId: string; name: string; externalId: string; score: number }>();
  for (const r of rows) {
    let stored: number[];
    try {
      stored = await unsealDescriptor(r.template, r.templateIv, key);
    } catch {
      continue; // A single unreadable template must not fail the whole lookup.
    }
    if (stored.length !== live.length) continue;
    const score = matchScore(live, stored);
    const prev = best.get(r.traineeId);
    if (!prev || score > prev.score) {
      best.set(r.traineeId, { traineeId: r.traineeId, name: r.name, externalId: r.externalId, score });
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const matches = ranked.slice(0, body.topK ?? 3);
  const top = matches[0] ?? null;

  return c.json({
    threshold: rules.matchThreshold,
    enrolledTrainees: best.size,
    matched: Boolean(top && top.score >= rules.matchThreshold),
    best: top,
    matches,
  });
});

export default app;

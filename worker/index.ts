import { and, eq, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { evidenceObjects, participantEngagementEvents, participantObservations } from "./db/schema";
import { recordAudit } from "./lib/audit";
import { ApiError } from "./lib/errors";
import { errorResponse } from "./lib/http";
import alertsRoutes from "./routes/alerts";
import auditRoutes from "./routes/audit";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import evidenceRoutes from "./routes/evidence";
import monitorRoutes from "./routes/monitor";
import meetingsRoutes from "./routes/meetings";
import botRoutes from "./routes/bot";
import reportsRoutes from "./routes/reports";
import sessionsRoutes from "./routes/sessions";
import settingsRoutes from "./routes/settings";
import traineeRoutes from "./routes/trainee";
import traineesRoutes from "./routes/trainees";
import zoomWebhookRoutes from "./routes/zoom-webhook";
import zoomRoutes from "./routes/zoom";
import type { Env, Variables } from "./types";

export { SessionHub } from "./do/session-hub";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/* --------------------------------------------------------------- request */

app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
  c.header("X-Request-Id", c.get("requestId"));
});

/** Baseline security headers. CSP allows the fonts and wasm the face engine needs. */
app.use("*", async (c, next) => {
  await next();
  if (c.req.path.startsWith("/api/")) {
    c.header("Cache-Control", "no-store");
  }
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

/* ---------------------------------------------------------------- routes */

app.get("/api/v1/health", (c) =>
  c.json({
    status: "ok",
    app: c.env.APP_NAME,
    time: new Date().toISOString(),
    zoom: {
      configured: Boolean(c.env.ZOOM_CLIENT_ID && c.env.ZOOM_CLIENT_SECRET),
      webhookConfigured: Boolean(c.env.ZOOM_WEBHOOK_SECRET_TOKEN),
    },
    keys: {
      encryption: Boolean(c.env.DATA_ENCRYPTION_KEY),
      signing: Boolean(c.env.SESSION_SIGNING_KEY),
    },
  }),
);

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/dashboard", dashboardRoutes);
app.route("/api/v1/trainees", traineesRoutes);
app.route("/api/v1/sessions", sessionsRoutes);
app.route("/api/v1/alerts", alertsRoutes);
app.route("/api/v1/evidence", evidenceRoutes);
app.route("/api/v1/reports", reportsRoutes);
app.route("/api/v1/settings", settingsRoutes);
app.route("/api/v1/audit", auditRoutes);
app.route("/api/v1/monitor", monitorRoutes);
/** Zoom Organizer Intelligence layer (additive; the routes above are unchanged). */
app.route("/api/v1/meetings", meetingsRoutes);
app.route("/api/v1/bot", botRoutes);
app.route("/api/v1/trainee", traineeRoutes);
app.route("/api/v1/integrations/zoom", zoomRoutes);
app.route("/api/v1/webhooks/zoom", zoomWebhookRoutes);

/** Dashboard realtime stream, proxied to the session's Durable Object. */
app.get("/api/v1/sessions/:id/stream", async (c) => {
  const sessionId = c.req.param("id");
  const since = c.req.query("since") ?? "0";
  const stub = c.env.SESSION_HUB.get(c.env.SESSION_HUB.idFromName(sessionId));
  return stub.fetch(`https://hub/ws?since=${encodeURIComponent(since)}`, {
    headers: { Upgrade: c.req.header("Upgrade") ?? "" },
  });
});

app.onError((err, c) => {
  if (err instanceof ApiError) return errorResponse(c, err);
  return errorResponse(c, err);
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "エンドポイントが見つかりません",
          requestId: c.get("requestId") ?? "unknown",
        },
      },
      404,
    );
  }
  // Everything else is the SPA; the assets binding serves index.html.
  return c.env.ASSETS.fetch(c.req.raw);
});

/* ------------------------------------------------------------ scheduled */

/**
 * Hourly retention purge (PRODUCT_SPEC_JA.md §3.6: 保存期間満了後に自動削除).
 * Deletion is recorded in the audit log, because "we deleted it" is itself an
 * auditable claim.
 */
async function purgeExpiredEvidence(env: Env): Promise<number> {
  const db = drizzle(env.DB);
  const due = await db
    .select({
      id: evidenceObjects.id,
      objectKey: evidenceObjects.objectKey,
      organizationId: evidenceObjects.organizationId,
      sessionId: evidenceObjects.sessionId,
    })
    .from(evidenceObjects)
    .where(and(lte(evidenceObjects.expiresAt, Date.now()), isNull(evidenceObjects.deletedAt)))
    .limit(500);

  let purged = 0;
  for (const row of due) {
    try {
      await env.EVIDENCE.delete(row.objectKey);
      await db
        .update(evidenceObjects)
        .set({ deletedAt: Date.now(), deleteReason: "RETENTION_EXPIRED" })
        .where(eq(evidenceObjects.id, row.id));
      await recordAudit(env.DB, {
        organizationId: row.organizationId,
        actorType: "system",
        action: "evidence.purge",
        resourceType: "evidence_object",
        resourceId: row.id,
        metadata: { sessionId: row.sessionId, reason: "RETENTION_EXPIRED" },
      });
      purged++;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "evidence purge failed",
          evidenceId: row.id,
          error: err instanceof Error ? err.message : "unknown",
        }),
      );
    }
  }
  return purged;
}

/**
 * Retention for the organizer-intelligence tables (§41).
 *
 * Observations and engagement events carry their own `expires_at`, computed
 * from the organization's retention settings when they were written — so
 * shortening a retention window applies to new data without retroactively
 * re-dating what is already stored. Meeting reports are deliberately NOT
 * purged: they are the summarised record that outlives the raw samples.
 */
async function purgeExpiredAnalytics(env: Env): Promise<{ observations: number; events: number }> {
  const db = drizzle(env.DB);
  const now = Date.now();

  const observations = await db
    .delete(participantObservations)
    .where(lte(participantObservations.expiresAt, now));
  const events = await db
    .delete(participantEngagementEvents)
    .where(
      and(
        lte(participantEngagementEvents.expiresAt, now),
        eq(participantEngagementEvents.state, "RESOLVED"),
      ),
    );

  return {
    observations: observations.meta.changes ?? 0,
    events: events.meta.changes ?? 0,
  };
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      purgeExpiredEvidence(env).then((n) => {
        if (n > 0) console.log(JSON.stringify({ level: "info", message: "evidence purged", count: n }));
      }),
    );
    ctx.waitUntil(
      purgeExpiredAnalytics(env)
        .then((r) => {
          if (r.observations || r.events) {
            console.log(JSON.stringify({ level: "info", message: "analytics purged", ...r }));
          }
        })
        .catch((err) =>
          console.error(
            JSON.stringify({
              level: "error",
              message: "analytics purge failed",
              error: err instanceof Error ? err.message : "unknown",
            }),
          ),
        ),
    );
  },
} satisfies ExportedHandler<Env>;

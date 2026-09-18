import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { evidenceObjects } from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { forbidden, notFound, serverError } from "../lib/errors";
import { getDecrypted, signEvidenceUrl, verifyEvidenceUrl } from "../lib/evidence";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Mints a signed, short-lived link (default 60s, SECURITY_PRIVACY.md §2).
 * Issuing the link is itself an audited event, because it is the point at which
 * a person gains access to biometric imagery.
 */
app.get("/:id/download-url", requireAuth, requirePermission("evidence:view"), async (c) => {
  const actor = getActor(c);
  const signingKey = c.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw serverError("SESSION_SIGNING_KEY が未設定です");

  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(evidenceObjects)
    .where(
      and(
        eq(evidenceObjects.id, c.req.param("id")),
        eq(evidenceObjects.organizationId, actor.organizationId),
        isNull(evidenceObjects.deletedAt),
      ),
    )
    .limit(1);
  const evidence = rows[0];
  if (!evidence) throw notFound("証跡が見つかりません");
  if (evidence.expiresAt < Date.now()) throw notFound("証跡は保存期限を過ぎています");

  const ttl = Number(c.env.EVIDENCE_URL_TTL_SECONDS ?? "60");
  const link = await signEvidenceUrl(
    c.env.PUBLIC_BASE_URL,
    evidence.id,
    actor.organizationId,
    signingKey,
    ttl,
  );

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "evidence.url.issue",
    resourceType: "evidence_object",
    resourceId: evidence.id,
    metadata: { ttlSeconds: ttl, sessionId: evidence.sessionId },
    requestId: c.get("requestId"),
  });

  // The URL itself is returned but never logged (audit metadata omits it).
  return c.json({ url: link.url, expiresAt: link.expiresAt, sha256: evidence.sha256 });
});

/**
 * Serves the decrypted image to a holder of a valid signature. Authentication
 * is the signature, so the tenant is taken from the signed payload and the row
 * is re-checked against it.
 */
app.get("/:id/content", async (c) => {
  const signingKey = c.env.SESSION_SIGNING_KEY;
  const encryptionKey = c.env.DATA_ENCRYPTION_KEY;
  if (!signingKey || !encryptionKey) throw serverError("鍵が未設定です");

  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(evidenceObjects)
    .where(and(eq(evidenceObjects.id, id), isNull(evidenceObjects.deletedAt)))
    .limit(1);
  const evidence = rows[0];
  if (!evidence) throw notFound("証跡が見つかりません");

  await verifyEvidenceUrl(
    id,
    evidence.organizationId,
    c.req.query("exp"),
    c.req.query("sig"),
    signingKey,
  );
  if (evidence.expiresAt < Date.now()) throw forbidden("証跡は保存期限を過ぎています");

  const object = await getDecrypted(c.env.EVIDENCE, evidence.objectKey, encryptionKey);
  if (!object) throw notFound("証跡データが見つかりません");

  return new Response(object.bytes as BodyInit, {
    headers: {
      "Content-Type": object.contentType,
      // Never cached: each view must go through a fresh signature.
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:",
    },
  });
});

export default app;

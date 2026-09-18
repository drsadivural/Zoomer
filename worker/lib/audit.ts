import { drizzle } from "drizzle-orm/d1";
import { auditLogs } from "../db/schema";
import { newId } from "./ids";
import { sha256Hex } from "./crypto";

export interface AuditInput {
  organizationId: string;
  actorId?: string | null;
  actorType?: "user" | "device" | "system" | "integration";
  action: string;
  resourceType: string;
  resourceId?: string | null;
  result?: "SUCCESS" | "DENIED" | "FAILURE";
  metadata?: Record<string, unknown>;
  requestId?: string;
  ip?: string | null;
}

/**
 * Keys that must never reach the audit log (SECURITY_PRIVACY.md §2): biometric
 * templates, raw imagery, signed URLs and bearer tokens.
 */
const FORBIDDEN_KEYS = new Set([
  "template", "descriptor", "embedding", "image", "imageData", "photo",
  "signedUrl", "downloadUrl", "url", "accessToken", "refreshToken",
  "password", "token", "objectKey", "secret",
]);

function scrub(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v)
      ? scrub(v as Record<string, unknown>)
      : v;
  }
  return out;
}

export async function recordAudit(db: D1Database, input: AuditInput): Promise<void> {
  const d = drizzle(db);
  await d.insert(auditLogs).values({
    id: newId("audit"),
    organizationId: input.organizationId,
    actorId: input.actorId ?? null,
    actorType: input.actorType ?? "user",
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    result: input.result ?? "SUCCESS",
    metadata: scrub(input.metadata) ?? null,
    requestId: input.requestId ?? null,
    ipHash: input.ip ? await sha256Hex(input.ip) : null,
  });
}

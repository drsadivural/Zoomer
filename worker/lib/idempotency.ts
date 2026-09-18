import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { MiddlewareHandler } from "hono";
import type { Env, Variables } from "../types";
import { idempotencyKeys } from "../db/schema";
import { sha256Hex } from "./crypto";
import { conflict } from "./errors";
import { newId } from "./ids";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface ReplayHit {
  statusCode: number;
  body: unknown;
}

/**
 * Idempotency for mutating endpoints (API_CONTRACT.md). A repeat of the same key
 * with the same body replays the stored response; the same key with a *different*
 * body is a client bug and is rejected rather than silently doing something new.
 */
export async function checkIdempotency(
  d1: D1Database,
  organizationId: string,
  key: string,
  endpoint: string,
  body: unknown,
): Promise<ReplayHit | null> {
  const db = drizzle(d1);
  const requestHash = await sha256Hex(JSON.stringify(body ?? null));
  const rows = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.organizationId, organizationId),
        eq(idempotencyKeys.key, key),
        eq(idempotencyKeys.endpoint, endpoint),
        gt(idempotencyKeys.expiresAt, Date.now()),
      ),
    )
    .limit(1);

  const existing = rows[0];
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw conflict("同一のIdempotency-Keyで異なる内容が送信されました");
  }
  if (existing.statusCode == null) {
    // The original attempt is still in flight; asking the client to retry is
    // safer than running the side effect twice.
    throw conflict("同一リクエストを処理中です。しばらくして再試行してください");
  }
  return {
    statusCode: existing.statusCode,
    body: existing.responseBody ? JSON.parse(existing.responseBody) : null,
  };
}

export async function reserveIdempotency(
  d1: D1Database,
  organizationId: string,
  key: string,
  endpoint: string,
  body: unknown,
): Promise<void> {
  const db = drizzle(d1);
  await db.insert(idempotencyKeys).values({
    id: newId("idempotency"),
    organizationId,
    key,
    endpoint,
    requestHash: await sha256Hex(JSON.stringify(body ?? null)),
    expiresAt: Date.now() + TTL_MS,
  });
}

export async function completeIdempotency(
  d1: D1Database,
  organizationId: string,
  key: string,
  endpoint: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  const db = drizzle(d1);
  await db
    .update(idempotencyKeys)
    .set({ statusCode, responseBody: JSON.stringify(body ?? null) })
    .where(
      and(
        eq(idempotencyKeys.organizationId, organizationId),
        eq(idempotencyKeys.key, key),
        eq(idempotencyKeys.endpoint, endpoint),
      ),
    );
}

/**
 * Hono middleware form. This must run *after* authentication, because the
 * replay record is scoped to the caller's organization — mounting it above
 * `requireAuth` silently disables it.
 */
export function withIdempotency(): MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> {
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

    const key = c.req.header("Idempotency-Key");
    const actor = c.get("actor");
    if (!key || !actor) return next();

    let body: unknown = null;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      body = null;
    }

    const endpoint = `${method} ${c.req.path}`;
    const replay = await checkIdempotency(c.env.DB, actor.organizationId, key, endpoint, body);
    if (replay) {
      c.header("Idempotency-Replayed", "true");
      return c.json(replay.body as object, replay.statusCode as 200);
    }

    await reserveIdempotency(c.env.DB, actor.organizationId, key, endpoint, body);
    await next();

    // Record the outcome so a retry replays it rather than re-running the effect.
    let responseBody: unknown = null;
    try {
      responseBody = await c.res.clone().json();
    } catch {
      responseBody = null;
    }
    await completeIdempotency(
      c.env.DB,
      actor.organizationId,
      key,
      endpoint,
      c.res.status,
      responseBody,
    );
  };
}

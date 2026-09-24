import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { authSessions, sessionParticipants, users } from "../db/schema";
import type { Actor, Env, Role, Variables } from "../types";
import { sha256Hex } from "./crypto";
import { forbidden, unauthorized } from "./errors";

export const SESSION_COOKIE = "zoomer_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Permission matrix (PRODUCT_SPEC_JA.md §2, SECURITY_PRIVACY.md §2).
 * Viewing a face image and exporting evidence are deliberately distinct, so an
 * operator who may triage alerts cannot bulk-export biometric material.
 */
export const PERMISSIONS = {
  sys_admin: [
    "org:manage", "user:manage", "settings:read", "settings:write", "integration:manage",
    "trainee:write", "trainee:read", "enrollment:write", "enrollment:read",
    "session:write", "session:read", "alert:write", "alert:read",
    "evidence:view", "evidence:export", "audit:read", "report:create",
    "monitoring:read", "monitoring:write",
  ],
  training_admin: [
    "trainee:write", "trainee:read", "enrollment:write", "enrollment:read",
    "session:write", "session:read", "alert:write", "alert:read",
    "evidence:view", "report:create", "settings:read",
    "monitoring:read", "monitoring:write",
  ],
  auditor: [
    "trainee:read", "enrollment:read", "session:read", "alert:read",
    "evidence:view", "evidence:export", "audit:read", "report:create", "settings:read",
    "monitoring:read",
  ],
} as const satisfies Record<Role, readonly string[]>;

/**
 * Organizer-role vocabulary from the Zoom Organizer Intelligence spec, mapped
 * onto the roles this product already has rather than introducing a parallel
 * RBAC system (§32). `monitoring:write` is what "may run a live meeting
 * monitoring session" means in practice.
 */
export const ORGANIZER_ROLE_ALIASES = {
  ADMIN: "sys_admin",
  ORGANIZER: "training_admin",
  VIEWER: "auditor",
} as const satisfies Record<string, Role>;

export type Permission = (typeof PERMISSIONS)[Role][number];

export function can(role: Role, permission: string): boolean {
  return (PERMISSIONS[role] as readonly string[]).includes(permission);
}

function bearer(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/**
 * Admin authentication. Accepts a session cookie or a Bearer token, then
 * enforces that any supplied `X-Organization-Id` matches the token's own
 * organization (API_CONTRACT.md: 認証・共通規則).
 */
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next,
) => {
  const token = bearer(c) ?? getCookie(c, SESSION_COOKIE) ?? null;
  if (!token) throw unauthorized();

  const db = drizzle(c.env.DB);
  const tokenHash = await sha256Hex(token);
  const rows = await db
    .select({
      sessionId: authSessions.id,
      userId: users.id,
      organizationId: users.organizationId,
      role: users.role,
      email: users.email,
      name: users.name,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, tokenHash),
        gt(authSessions.expiresAt, Date.now()),
        isNull(authSessions.revokedAt),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw unauthorized("セッションが無効または期限切れです");

  const declaredOrg = c.req.header("X-Organization-Id");
  if (declaredOrg && declaredOrg !== row.organizationId) {
    // A token presented against another tenant is an attack signal, not a typo.
    throw forbidden("組織IDがトークンと一致しません");
  }

  const actor: Actor = {
    userId: row.userId,
    organizationId: row.organizationId,
    role: row.role as Role,
    email: row.email,
    name: row.name,
  };
  c.set("actor", actor);
  await next();
};

export function requirePermission(
  permission: string,
): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    const actor = c.get("actor");
    if (!actor) throw unauthorized();
    if (!can(actor.role, permission)) {
      throw forbidden(`この操作には ${permission} 権限が必要です`);
    }
    await next();
  };
}

export function getActor(c: Context<{ Bindings: Env; Variables: Variables }>): Actor {
  const actor = c.get("actor");
  if (!actor) throw unauthorized();
  return actor;
}

/**
 * Trainee device authentication. The token is minted at precheck and is scoped
 * to a single session participant, so a leaked token cannot read other trainees.
 */
export const requireDevice: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next,
) => {
  const token = bearer(c);
  if (!token) throw unauthorized("端末トークンが必要です");

  const db = drizzle(c.env.DB);
  const tokenHash = await sha256Hex(token);
  const rows = await db
    .select({
      id: sessionParticipants.id,
      sessionId: sessionParticipants.sessionId,
      organizationId: sessionParticipants.organizationId,
    })
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.deviceTokenHash, tokenHash),
        gt(sessionParticipants.deviceTokenExpiresAt, Date.now()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw unauthorized("端末トークンが無効または期限切れです");

  c.set("device", {
    participantId: row.id,
    sessionId: row.sessionId,
    organizationId: row.organizationId,
  });
  await next();
};

export function getDevice(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const device = c.get("device");
  if (!device) throw unauthorized();
  return device;
}

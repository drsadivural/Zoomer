import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { authSessions, users } from "../db/schema";
import { getActor, requireAuth, SESSION_COOKIE, SESSION_TTL_MS } from "../lib/auth";
import { recordAudit } from "../lib/audit";
import { generateToken, verifyPassword } from "../lib/crypto";
import { unauthorized } from "../lib/errors";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Compared against when the email does not exist, so a missing account and a
 * wrong password cost the same and are indistinguishable from outside.
 * Iteration count matches the real hashes.
 */
const DUMMY_HASH =
  "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

app.post("/login", async (c) => {
  const body = await parseBody(c, loginSchema);
  const db = drizzle(c.env.DB);

  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, body.email.toLowerCase()), isNull(users.deletedAt)))
    .limit(1);

  const user = rows[0];
  // Run the hash comparison even when the user is missing so that a failed
  // lookup and a wrong password cost the same, and neither is distinguishable.
  const ok = user?.passwordHash
    ? await verifyPassword(body.password, user.passwordHash)
    : await verifyPassword(body.password, DUMMY_HASH);

  if (!user || !ok) {
    if (user) {
      await recordAudit(c.env.DB, {
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.login",
        resourceType: "user",
        resourceId: user.id,
        result: "DENIED",
        requestId: c.get("requestId"),
        ip: c.req.header("CF-Connecting-IP"),
      });
    }
    throw unauthorized("メールアドレスまたはパスワードが正しくありません");
  }

  const { token, hash } = await generateToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db.insert(authSessions).values({
    id: newId("authSession"),
    organizationId: user.organizationId,
    userId: user.id,
    tokenHash: hash,
    expiresAt,
  });
  await db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id));

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  await recordAudit(c.env.DB, {
    organizationId: user.organizationId,
    actorId: user.id,
    action: "auth.login",
    resourceType: "user",
    resourceId: user.id,
    requestId: c.get("requestId"),
    ip: c.req.header("CF-Connecting-IP"),
  });

  return c.json({
    token,
    expiresAt,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    },
  });
});

app.post("/logout", requireAuth, async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  await db
    .update(authSessions)
    .set({ revokedAt: Date.now() })
    .where(and(eq(authSessions.userId, actor.userId), isNull(authSessions.revokedAt)));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "auth.logout",
    resourceType: "user",
    resourceId: actor.userId,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

app.get("/me", requireAuth, (c) => c.json({ user: getActor(c) }));

export default app;

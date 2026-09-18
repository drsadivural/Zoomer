import { and, desc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { auditLogs } from "../db/schema";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", requirePermission("audit:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const filters = [eq(auditLogs.organizationId, actor.organizationId)];
  const action = c.req.query("action");
  const resourceType = c.req.query("resourceType");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (action) filters.push(eq(auditLogs.action, action));
  if (resourceType) filters.push(eq(auditLogs.resourceType, resourceType));
  if (from) filters.push(gte(auditLogs.createdAt, Number(from)));
  if (to) filters.push(lte(auditLogs.createdAt, Number(to)));

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...filters))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(Number(c.req.query("limit") ?? 100), 500));

  return c.json({ logs: rows });
});

export default app;

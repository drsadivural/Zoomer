import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { consents, faceEnrollments, trainees } from "../db/schema";
import { recordAudit } from "../lib/audit";
import { getActor, requireAuth, requirePermission } from "../lib/auth";
import { withIdempotency } from "../lib/idempotency";
import { parseCsv } from "../lib/csv";
import { badRequest, conflict, notFound, serverError } from "../lib/errors";
import { assertDescriptor, assessQuality, sealDescriptor } from "../lib/faces";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import type { Env, Variables } from "../types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);
app.use("*", withIdempotency());

/* ------------------------------------------------------------------- list */

app.get("/", requirePermission("trainee:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const q = c.req.query("q")?.trim();
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

  const filters = [eq(trainees.organizationId, actor.organizationId), isNull(trainees.deletedAt)];
  if (q) {
    const pattern = `%${q}%`;
    filters.push(
      or(
        like(trainees.name, pattern),
        like(trainees.externalId, pattern),
        like(trainees.email, pattern),
        like(trainees.department, pattern),
      )!,
    );
  }

  const rows = await db
    .select({
      id: trainees.id,
      externalId: trainees.externalId,
      name: trainees.name,
      department: trainees.department,
      email: trainees.email,
      status: trainees.status,
      createdAt: trainees.createdAt,
      /* `trainees.id` is written out rather than interpolated. In a
         single-table select Drizzle renders `${trainees.id}` as a bare
         `"id"`, and SQLite resolves that against the SUBQUERY's table — so
         this asked for `fe.trainee_id = fe.id`, which is never true, and
         every trainee showed 未登録 no matter how many faces were enrolled.
         A join makes Drizzle qualify the reference, which is why only the
         unjoined queries were affected. */
      enrollmentCount: sql<number>`(
        select count(*) from face_enrollments fe
        where fe.trainee_id = trainees.id
          and fe.status = 'ACTIVE' and fe.deleted_at is null
      )`,
      lastQuality: sql<number | null>`(
        select fe.quality_score from face_enrollments fe
        where fe.trainee_id = trainees.id
          and fe.status = 'ACTIVE' and fe.deleted_at is null
        order by fe.created_at desc limit 1
      )`,
    })
    .from(trainees)
    .where(and(...filters))
    .orderBy(desc(trainees.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(trainees)
    .where(and(...filters));

  return c.json({ trainees: rows, total, limit, offset });
});

/* ----------------------------------------------------------------- create */

const createSchema = z.object({
  externalId: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  department: z.string().max(128).optional(),
  email: z.string().email().optional(),
});

app.post("/", requirePermission("trainee:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, createSchema);
  const db = drizzle(c.env.DB);

  const existing = await db
    .select({ id: trainees.id })
    .from(trainees)
    .where(
      and(
        eq(trainees.organizationId, actor.organizationId),
        eq(trainees.externalId, body.externalId),
        isNull(trainees.deletedAt),
      ),
    )
    .limit(1);
  if (existing.length) throw conflict(`受講者ID ${body.externalId} は既に登録されています`);

  const id = newId("trainee");
  await db.insert(trainees).values({
    id,
    organizationId: actor.organizationId,
    externalId: body.externalId,
    name: body.name,
    department: body.department ?? null,
    email: body.email?.toLowerCase() ?? null,
  });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "trainee.create",
    resourceType: "trainee",
    resourceId: id,
    metadata: { externalId: body.externalId },
    requestId: c.get("requestId"),
  });

  return c.json({ trainee: { id, ...body } }, 201);
});

/* ----------------------------------------------------------------- detail */

app.get("/:id", requirePermission("trainee:read"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(trainees)
    .where(
      and(
        eq(trainees.id, c.req.param("id")),
        eq(trainees.organizationId, actor.organizationId),
        isNull(trainees.deletedAt),
      ),
    )
    .limit(1);
  const trainee = rows[0];
  if (!trainee) throw notFound("受講者が見つかりません");

  // Template ciphertext is deliberately excluded from this projection.
  const enrollments = await db
    .select({
      id: faceEnrollments.id,
      engine: faceEnrollments.engine,
      modelVersion: faceEnrollments.modelVersion,
      qualityScore: faceEnrollments.qualityScore,
      qualityDetail: faceEnrollments.qualityDetail,
      status: faceEnrollments.status,
      createdAt: faceEnrollments.createdAt,
      hasImage: sql<number>`case when ${faceEnrollments.imageKey} is null then 0 else 1 end`,
    })
    .from(faceEnrollments)
    .where(
      and(
        eq(faceEnrollments.traineeId, trainee.id),
        eq(faceEnrollments.organizationId, actor.organizationId),
        isNull(faceEnrollments.deletedAt),
      ),
    )
    .orderBy(desc(faceEnrollments.createdAt));

  return c.json({ trainee, enrollments });
});

/* ----------------------------------------------------------------- update */

const updateSchema = createSchema.partial().extend({
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

app.patch("/:id", requirePermission("trainee:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, updateSchema);
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const result = await db
    .update(trainees)
    .set({
      ...(body.name != null ? { name: body.name } : {}),
      ...(body.department != null ? { department: body.department } : {}),
      ...(body.email != null ? { email: body.email.toLowerCase() } : {}),
      ...(body.externalId != null ? { externalId: body.externalId } : {}),
      ...(body.status != null ? { status: body.status } : {}),
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(trainees.id, id),
        eq(trainees.organizationId, actor.organizationId),
        isNull(trainees.deletedAt),
      ),
    );

  if (!result.meta.changes) throw notFound("受講者が見つかりません");

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "trainee.update",
    resourceType: "trainee",
    resourceId: id,
    metadata: body,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

/** Soft delete: the row is retained so historical evidence keeps its subject. */
app.delete("/:id", requirePermission("trainee:write"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const result = await db
    .update(trainees)
    .set({ deletedAt: Date.now(), status: "DELETED" })
    .where(
      and(
        eq(trainees.id, id),
        eq(trainees.organizationId, actor.organizationId),
        isNull(trainees.deletedAt),
      ),
    );
  if (!result.meta.changes) throw notFound("受講者が見つかりません");

  // Revoking the biometric template is the part that actually matters.
  await db
    .update(faceEnrollments)
    .set({ deletedAt: Date.now(), status: "DELETED", deletedBy: actor.userId })
    .where(
      and(
        eq(faceEnrollments.traineeId, id),
        eq(faceEnrollments.organizationId, actor.organizationId),
      ),
    );

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "trainee.delete",
    resourceType: "trainee",
    resourceId: id,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ CSV import */

const importSchema = z.object({ csv: z.string().min(1).max(2_000_000) });

app.post("/import", requirePermission("trainee:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, importSchema);
  const db = drizzle(c.env.DB);

  const rows = parseCsv(body.csv);
  if (rows.length < 2) throw badRequest("ヘッダー行とデータ行が必要です");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const idxExternal = col("external_id", "受講者id", "社員番号", "id");
  const idxName = col("name", "氏名", "名前");
  const idxDept = col("department", "所属", "部署");
  const idxEmail = col("email", "メールアドレス", "mail");

  if (idxExternal < 0 || idxName < 0) {
    throw badRequest("CSVに受講者ID（external_id）と氏名（name）の列が必要です");
  }

  const existing = await db
    .select({ externalId: trainees.externalId })
    .from(trainees)
    .where(and(eq(trainees.organizationId, actor.organizationId), isNull(trainees.deletedAt)));
  const known = new Set(existing.map((r) => r.externalId));

  const created: string[] = [];
  const skipped: { row: number; externalId: string; reason: string }[] = [];
  const seenInFile = new Set<string>();
  const pending: (typeof trainees.$inferInsert)[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const externalId = (r[idxExternal] ?? "").trim();
    const name = (r[idxName] ?? "").trim();
    const rowNo = i + 1;

    if (!externalId || !name) {
      skipped.push({ row: rowNo, externalId, reason: "受講者IDまたは氏名が空です" });
      continue;
    }
    if (known.has(externalId)) {
      skipped.push({ row: rowNo, externalId, reason: "既に登録済みです" });
      continue;
    }
    if (seenInFile.has(externalId)) {
      skipped.push({ row: rowNo, externalId, reason: "ファイル内で重複しています" });
      continue;
    }

    const email = idxEmail >= 0 ? (r[idxEmail] ?? "").trim().toLowerCase() : "";
    if (email && !z.string().email().safeParse(email).success) {
      skipped.push({ row: rowNo, externalId, reason: "メールアドレスが不正です" });
      continue;
    }

    seenInFile.add(externalId);
    const id = newId("trainee");
    pending.push({
      id,
      organizationId: actor.organizationId,
      externalId,
      name,
      department: idxDept >= 0 ? (r[idxDept] ?? "").trim() || null : null,
      email: email || null,
    });
    created.push(id);
  }

  // Chunked so a large upload stays within D1's bound-parameter limit.
  for (let i = 0; i < pending.length; i += 50) {
    await db.insert(trainees).values(pending.slice(i, i + 50));
  }

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "trainee.import",
    resourceType: "trainee",
    metadata: { created: created.length, skipped: skipped.length },
    requestId: c.get("requestId"),
  });

  return c.json({ created: created.length, skipped, total: rows.length - 1 }, 201);
});

/* ---------------------------------------------------------- enrollments */

const enrollSchema = z.object({
  descriptor: z.array(z.number()).min(64).max(1024),
  engine: z.string().min(1).max(64),
  modelVersion: z.string().min(1).max(64),
  quality: z.object({
    faceCount: z.number().int().min(0),
    relativeSize: z.number().min(0).max(1),
    yaw: z.number(),
    pitch: z.number(),
    brightness: z.number().min(0).max(1),
    sharpness: z.number().min(0).max(1),
    occlusion: z.number().min(0).max(1),
  }),
  consent: z.object({
    policyVersion: z.string().min(1),
    scope: z.array(z.string()).min(1),
  }),
});

app.post("/:id/enrollments", requirePermission("enrollment:write"), async (c) => {
  const actor = getActor(c);
  const body = await parseBody(c, enrollSchema);
  const key = c.env.DATA_ENCRYPTION_KEY;
  if (!key) throw serverError("DATA_ENCRYPTION_KEY が未設定です");

  const db = drizzle(c.env.DB);
  const traineeId = c.req.param("id");
  const found = await db
    .select({ id: trainees.id })
    .from(trainees)
    .where(
      and(
        eq(trainees.id, traineeId),
        eq(trainees.organizationId, actor.organizationId),
        isNull(trainees.deletedAt),
      ),
    )
    .limit(1);
  if (!found.length) throw notFound("受講者が見つかりません");

  const quality = assessQuality(body.quality);
  if (!quality.passed) {
    // 422, not 400: the request is well-formed, the photo simply is not usable.
    return c.json(
      {
        error: {
          code: "QUALITY_REJECTED",
          message: "顔画像の品質基準を満たしていません",
          requestId: c.get("requestId"),
          reasons: quality.reasons,
          score: quality.score,
        },
      },
      422,
    );
  }

  const descriptor = assertDescriptor(body.descriptor, body.engine);
  const sealed = await sealDescriptor(descriptor, key);
  const enrollmentId = newId("enrollment");

  // One active template per trainee: supersede the previous one.
  await db
    .update(faceEnrollments)
    .set({ status: "SUPERSEDED" })
    .where(
      and(
        eq(faceEnrollments.traineeId, traineeId),
        eq(faceEnrollments.organizationId, actor.organizationId),
        eq(faceEnrollments.status, "ACTIVE"),
      ),
    );

  await db.insert(faceEnrollments).values({
    id: enrollmentId,
    organizationId: actor.organizationId,
    traineeId,
    template: sealed.ciphertext,
    templateIv: sealed.iv,
    engine: body.engine,
    modelVersion: body.modelVersion,
    dimensions: descriptor.length,
    qualityScore: quality.score,
    qualityDetail: { ...body.quality, passed: quality.passed },
    createdBy: actor.userId,
  });

  await db.insert(consents).values({
    id: newId("consent"),
    organizationId: actor.organizationId,
    traineeId,
    policyVersion: body.consent.policyVersion,
    scope: body.consent.scope,
    userAgent: c.req.header("User-Agent") ?? null,
  });

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "enrollment.create",
    resourceType: "face_enrollment",
    resourceId: enrollmentId,
    metadata: { traineeId, qualityScore: quality.score, engine: body.engine },
    requestId: c.get("requestId"),
  });

  return c.json({ enrollment: { id: enrollmentId, qualityScore: quality.score } }, 201);
});

app.delete("/:id/enrollments/:enrollmentId", requirePermission("enrollment:write"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const enrollmentId = c.req.param("enrollmentId");

  const result = await db
    .update(faceEnrollments)
    .set({ deletedAt: Date.now(), status: "DELETED", deletedBy: actor.userId })
    .where(
      and(
        eq(faceEnrollments.id, enrollmentId),
        eq(faceEnrollments.traineeId, c.req.param("id")),
        eq(faceEnrollments.organizationId, actor.organizationId),
        isNull(faceEnrollments.deletedAt),
      ),
    );
  if (!result.meta.changes) throw notFound("顔登録が見つかりません");

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "enrollment.delete",
    resourceType: "face_enrollment",
    resourceId: enrollmentId,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

export default app;

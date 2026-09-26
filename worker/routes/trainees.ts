import { and, asc, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { consents, faceEnrollments, trainees } from "../db/schema";
import { b64encode, decodeDataUrl, getDecrypted, putEncrypted } from "../lib/evidence";
import { getMeetingConfig } from "../services/monitoring/config";
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

/**
 * Most active face templates kept per trainee.
 *
 * Enough for a useful spread of poses and lighting; small enough that a 1:N
 * identify across a whole organization stays cheap, since every template is
 * one more comparison for every participant in every meeting.
 */
const MAX_ACTIVE_ENROLLMENTS = 8;
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
      hasThumbnail: sql<number>`(
        select count(*) from face_enrollments fe
        where fe.trainee_id = trainees.id
          and fe.status = 'ACTIVE' and fe.deleted_at is null
          and fe.image_key is not null
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

/* ------------------------------------------------------- face thumbnails */

const thumbnailsSchema = z
  .object({
    /** Roster view: the newest stored photo per trainee. */
    traineeIds: z.array(z.string().min(1)).min(1).max(200).optional(),
    /** Detail view: one image per enrollment, so alternate poses are distinct. */
    enrollmentIds: z.array(z.string().min(1)).min(1).max(200).optional(),
  })
  .refine((v) => v.traineeIds?.length || v.enrollmentIds?.length, {
    message: "traineeIds または enrollmentIds が必要です",
  });

/**
 * Returns the stored face thumbnail for each requested trainee.
 *
 * Batched rather than one request per row: a roster of 200 people would
 * otherwise be 200 requests and 200 audit entries for what is, to the
 * operator, a single act of looking at the list.
 *
 * Gated on `evidence:view` because a face crop is biometric imagery, not
 * decoration, and on the organization having opted in — with thumbnails off
 * there is nothing stored to return.
 */
app.post("/thumbnails", requirePermission("evidence:view"), async (c) => {
  const actor = getActor(c);
  const key = c.env.DATA_ENCRYPTION_KEY;
  if (!key) throw serverError("DATA_ENCRYPTION_KEY が未設定です");

  const body = await parseBody(c, thumbnailsSchema);
  const config = await getMeetingConfig(c.env.DB, actor.organizationId);
  if (!config.enrollmentThumbnailsEnabled) {
    return c.json({ thumbnails: {}, enabled: false });
  }

  const db = drizzle(c.env.DB);
  const byEnrollment = Boolean(body.enrollmentIds?.length);

  const rows = await db
    .select({
      id: faceEnrollments.id,
      traineeId: faceEnrollments.traineeId,
      imageKey: faceEnrollments.imageKey,
      createdAt: faceEnrollments.createdAt,
    })
    .from(faceEnrollments)
    .where(
      and(
        eq(faceEnrollments.organizationId, actor.organizationId),
        byEnrollment
          ? inArray(faceEnrollments.id, body.enrollmentIds!)
          : inArray(faceEnrollments.traineeId, body.traineeIds!),
        eq(faceEnrollments.status, "ACTIVE"),
        isNull(faceEnrollments.deletedAt),
      ),
    )
    .orderBy(desc(faceEnrollments.createdAt));

  // Keyed by whatever was asked for. By trainee it is the newest photo and the
  // rest are alternate poses; by enrollment every one is returned, which is
  // what makes a per-enrollment list able to show which photo is which.
  const wanted = new Map<string, string>();
  for (const r of rows) {
    if (!r.imageKey) continue;
    if (byEnrollment) wanted.set(r.id, r.imageKey);
    else if (!wanted.has(r.traineeId)) wanted.set(r.traineeId, r.imageKey);
  }

  const thumbnails: Record<string, string> = {};
  for (const [id, objectKey] of wanted) {
    const stored = await getDecrypted(c.env.EVIDENCE, objectKey, key);
    // A missing object is not an error: retention or a deletion may have
    // removed it, and the row is repaired on the next enrollment.
    if (!stored) continue;
    thumbnails[id] = `data:${stored.contentType};base64,${b64encode(stored.bytes)}`;
  }

  await recordAudit(c.env.DB, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "enrollment.thumbnails.view",
    resourceType: "face_enrollment",
    metadata: {
      keyedBy: byEnrollment ? "enrollment" : "trainee",
      requested: (body.enrollmentIds ?? body.traineeIds ?? []).length,
      served: Object.keys(thumbnails).length,
    },
    requestId: c.get("requestId"),
  });

  return c.json({ thumbnails, enabled: true });
});

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
  /**
   * Optional data: URL of a small face crop, kept only when the organization
   * has turned enrollment thumbnails on. The client always offers it; the
   * server decides whether to keep it, so the privacy setting cannot be
   * bypassed by a client that simply stops asking.
   */
  thumbnail: z.string().max(400_000).optional(),
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

  // Several active templates per trainee, not one.
  //
  // A single template is a single pose under a single light. Enrolling a few
  // photos — front, slight left, slight right, with and without glasses — is
  // what makes recognition hold up in a real meeting, and both comparison
  // paths already take the best score across a trainee's templates.
  //
  // Bounded, because every extra template is work on every 1:N identify and
  // the returns fall away quickly. The oldest is superseded once the cap is
  // reached, so enrolling never fails for want of a slot.
  const active = await db
    .select({ id: faceEnrollments.id })
    .from(faceEnrollments)
    .where(
      and(
        eq(faceEnrollments.traineeId, traineeId),
        eq(faceEnrollments.organizationId, actor.organizationId),
        eq(faceEnrollments.status, "ACTIVE"),
        isNull(faceEnrollments.deletedAt),
      ),
    )
    .orderBy(asc(faceEnrollments.createdAt));

  const overflow = active.slice(0, Math.max(0, active.length + 1 - MAX_ACTIVE_ENROLLMENTS));
  for (const row of overflow) {
    await db
      .update(faceEnrollments)
      .set({ status: "SUPERSEDED" })
      .where(eq(faceEnrollments.id, row.id));
  }

  // Encrypted at rest under the same key and helper as evidence images, and
  // only when the organization has opted in. With the setting off nothing is
  // written and `image_key` stays null, which is the shipped default.
  const config = await getMeetingConfig(c.env.DB, actor.organizationId);
  let image: { key: string; sha256: string; contentType: string } | null = null;
  if (config.enrollmentThumbnailsEnabled && body.thumbnail) {
    try {
      const { bytes, contentType } = decodeDataUrl(body.thumbnail);
      const objectKey = `${actor.organizationId}/enrollments/${enrollmentId}.bin`;
      const { sha256 } = await putEncrypted(c.env.EVIDENCE, objectKey, bytes, key, contentType);
      image = { key: objectKey, sha256, contentType };
    } catch (err) {
      // A thumbnail is a convenience. Losing it must never cost the template,
      // which is the thing identity actually depends on.
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "enrollment thumbnail store failed",
          traineeId,
          error: err instanceof Error ? err.message : "unknown",
        }),
      );
    }
  }

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
    imageKey: image?.key ?? null,
    imageSha256: image?.sha256 ?? null,
    imageContentType: image?.contentType ?? null,
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
    metadata: {
      traineeId,
      qualityScore: quality.score,
      engine: body.engine,
      thumbnailStored: Boolean(image),
    },
    requestId: c.get("requestId"),
  });

  return c.json({ enrollment: { id: enrollmentId, qualityScore: quality.score } }, 201);
});

app.delete("/:id/enrollments/:enrollmentId", requirePermission("enrollment:write"), async (c) => {
  const actor = getActor(c);
  const db = drizzle(c.env.DB);
  const enrollmentId = c.req.param("enrollmentId");

  const existingRows = await db
    .select({ imageKey: faceEnrollments.imageKey })
    .from(faceEnrollments)
    .where(
      and(
        eq(faceEnrollments.id, enrollmentId),
        eq(faceEnrollments.organizationId, actor.organizationId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

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

  // Delete the thumbnail bytes outright rather than only marking the row.
  // Withdrawing a face registration has to remove the face, not hide it.
  if (existing?.imageKey) {
    try {
      await c.env.EVIDENCE.delete(existing.imageKey);
      await db
        .update(faceEnrollments)
        .set({ imageKey: null, imageSha256: null, imageContentType: null })
        .where(eq(faceEnrollments.id, enrollmentId));
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "enrollment thumbnail delete failed",
          enrollmentId,
          error: err instanceof Error ? err.message : "unknown",
        }),
      );
    }
  }

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

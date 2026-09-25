/**
 * Guards the correlated-subquery trap that silently zeroed every count in the
 * product.
 *
 * In a single-table select, Drizzle renders `${table.column}` inside a raw
 * `sql` template as a bare `"column"` with no table prefix. SQLite then
 * resolves that name against the *subquery's* table, so
 *
 *     where fe.trainee_id = ${trainees.id}
 *
 * became `where fe.trainee_id = fe.id` — never true. Every trainee showed
 * 未登録 however many faces were enrolled, and the session list reported zero
 * participants and zero alerts. Nothing failed; the numbers were just wrong.
 *
 * The fix is to write the qualified reference out by hand. These tests pin both
 * halves: that the trap is real (so the comment above stays true), and that the
 * form the routes now use renders correctly.
 */
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull, sql } from "drizzle-orm";
import { trainees, trainingSessions } from "../worker/db/schema";

// toSQL() only builds a statement; it never touches the binding.
const db = drizzle({} as never);

describe("correlated subqueries in single-table selects", () => {
  it("renders an interpolated column WITHOUT its table — the trap", () => {
    const { sql: text } = db
      .select({
        enrollmentCount: sql<number>`(
          select count(*) from face_enrollments fe where fe.trainee_id = ${trainees.id}
        )`,
      })
      .from(trainees)
      .toSQL();

    // Bare "id": inside the subquery SQLite binds this to face_enrollments.id.
    expect(text).toContain('fe.trainee_id = "id"');
    expect(text).not.toContain('fe.trainee_id = "trainees"."id"');
  });

  it("renders a hand-qualified reference correctly — the fix", () => {
    const { sql: text } = db
      .select({
        enrollmentCount: sql<number>`(
          select count(*) from face_enrollments fe where fe.trainee_id = trainees.id
        )`,
      })
      .from(trainees)
      .toSQL();

    expect(text).toContain("fe.trainee_id = trainees.id");
  });

  it("is unaffected when the query has a join, which is why this was subtle", () => {
    const { sql: text } = db
      .select({
        n: sql<number>`(
          select count(*) from alerts a where a.session_id = ${trainingSessions.id}
        )`,
      })
      .from(trainingSessions)
      .leftJoin(trainees, eq(trainees.organizationId, trainingSessions.organizationId))
      .where(and(isNull(trainingSessions.deletedAt)))
      .toSQL();

    // With a join Drizzle qualifies the reference, so the same code was correct
    // in some places and silently wrong in others.
    expect(text).toContain('a.session_id = "training_sessions"."id"');
  });
});

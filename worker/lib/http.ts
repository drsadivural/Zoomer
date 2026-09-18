import type { Context } from "hono";
import { ZodError, type ZodSchema } from "zod";
import { ApiError, badRequest } from "./errors";

export function json<T>(c: Context, body: T, status = 200) {
  return c.json(body as object, status as 200);
}

/** Parses and validates a JSON body, translating Zod issues into the API envelope. */
export async function parseBody<T>(c: Context, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("リクエストボディがJSONとして不正です");
  }
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest("入力値が不正です", {
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    throw err;
  }
}

export function parseQuery<T>(c: Context, schema: ZodSchema<T>): T {
  try {
    return schema.parse(c.req.query());
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest("クエリパラメータが不正です", {
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    throw err;
  }
}

export function errorResponse(c: Context, err: unknown) {
  const requestId = c.get("requestId") ?? "unknown";
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message, requestId, ...(err.details ?? {}) } },
      err.status as 400,
    );
  }
  // Unexpected failures: log the shape, never the payload (which may carry
  // biometric data), and return an opaque message.
  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      path: c.req.path,
      method: c.req.method,
      message: err instanceof Error ? err.message : "unknown error",
    }),
  );
  return c.json(
    { error: { code: "INTERNAL", message: "内部エラーが発生しました", requestId } },
    500,
  );
}

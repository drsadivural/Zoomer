/** Error envelope from API_CONTRACT.md: { error: { code, message, requestId } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "認証が必要です") =>
  new ApiError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "この操作を行う権限がありません") =>
  new ApiError(403, "FORBIDDEN", message);
export const notFound = (message = "対象が見つかりません") =>
  new ApiError(404, "NOT_FOUND", message);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new ApiError(409, "CONFLICT", message, details);
export const unprocessable = (message: string, details?: Record<string, unknown>) =>
  new ApiError(422, "UNPROCESSABLE", message, details);
export const tooManyRequests = (message = "リクエストが多すぎます") =>
  new ApiError(429, "RATE_LIMITED", message);
export const serverError = (message = "内部エラーが発生しました") =>
  new ApiError(500, "INTERNAL", message);

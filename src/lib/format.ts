/** All timestamps are stored UTC; the UI renders in the organization's zone. */
const TZ = "Asia/Tokyo";

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ms));
}

export function formatClock(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ms));
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function duration(ms: number | null | undefined): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${s % 60}秒`;
}

/** `datetime-local` input value in JST, for session forms. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): number {
  return Date.parse(`${value}:00+09:00`);
}

export const STATUS_LABELS: Record<string, string> = {
  PRECHECK_PENDING: "未接続",
  VERIFIED: "本人確認済",
  MONITORING: "正常",
  WARNING: "要確認",
  ALERT: "異常",
  REVIEWED: "確認済",
  DISCONNECTED: "接続断",
  COMPLETED: "完了",
};

export const STATUS_TONES: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  PRECHECK_PENDING: "neutral",
  VERIFIED: "info",
  MONITORING: "success",
  WARNING: "warning",
  ALERT: "danger",
  REVIEWED: "info",
  DISCONNECTED: "neutral",
  COMPLETED: "success",
};

export const MATCH_METHOD_LABELS: Record<string, string> = {
  email: "メール一致",
  external_id: "受講者ID一致",
  name: "氏名一致",
  manual: "手動割当",
  unmatched: "未照合",
};

export const SESSION_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: "予定",
  LIVE: "進行中",
  COMPLETED: "完了",
  CANCELLED: "中止",
};

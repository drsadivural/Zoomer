/**
 * UI vocabulary for engagement signals.
 *
 * Mirrors `worker/services/monitoring/signals.ts`. Every label describes what a
 * camera can evidence — "画面正対" (facing the screen), never "集中している"
 * (concentrating). If a label here starts sounding like a judgement about a
 * person's mind, it is wrong and must be changed.
 */
import type { Tone } from "@/components/shell/primitives";

export const ENGAGEMENT_LABELS: Record<string, string> = {
  SCREEN_FACING: "画面正対",
  LOOKING_LEFT: "左を向いている",
  LOOKING_RIGHT: "右を向いている",
  LOOKING_UP: "上を向いている",
  LOOKING_DOWN: "下を向いている",
  FACE_NOT_VISIBLE: "顔が映っていない",
  CAMERA_OFF: "カメラオフ",
  MULTIPLE_FACES: "複数人を検出",
  IDENTITY_MISMATCH: "本人と不一致",
  LOW_CONFIDENCE: "信頼度が低い",
  UNKNOWN: "判定不能",
};

export const ENGAGEMENT_TONES: Record<string, Tone> = {
  SCREEN_FACING: "success",
  LOOKING_LEFT: "warning",
  LOOKING_RIGHT: "warning",
  LOOKING_UP: "warning",
  LOOKING_DOWN: "warning",
  FACE_NOT_VISIBLE: "danger",
  CAMERA_OFF: "neutral",
  MULTIPLE_FACES: "danger",
  IDENTITY_MISMATCH: "danger",
  LOW_CONFIDENCE: "warning",
  UNKNOWN: "neutral",
};

export const IDENTITY_LABELS: Record<string, string> = {
  VERIFIED: "本人確認済",
  UNVERIFIED: "未確認",
  MISMATCH: "不一致",
  NO_FACE: "顔なし",
  MULTIPLE_FACES: "複数人",
  LOW_CONFIDENCE: "信頼度低",
  UNKNOWN: "不明",
};

export const IDENTITY_TONES: Record<string, Tone> = {
  VERIFIED: "success",
  UNVERIFIED: "warning",
  MISMATCH: "danger",
  NO_FACE: "neutral",
  MULTIPLE_FACES: "danger",
  LOW_CONFIDENCE: "warning",
  UNKNOWN: "neutral",
};

export const HEAD_LABELS: Record<string, string> = {
  FORWARD: "正面",
  LEFT: "左",
  RIGHT: "右",
  UP: "上",
  DOWN: "下",
  UNKNOWN: "不明",
};

export const EVENT_LABELS: Record<string, string> = {
  PARTICIPANT_JOINED: "参加",
  PARTICIPANT_LEFT: "退出",
  FACE_MISSING: "顔が映っていない",
  FACE_RETURNED: "顔が復帰",
  SCREEN_AWAY: "画面から視線が外れた",
  SCREEN_FACING_RETURNED: "画面正対に復帰",
  CAMERA_OFF: "カメラオフ",
  CAMERA_ON: "カメラオン",
  MULTIPLE_FACES: "複数人を検出",
  IDENTITY_MISMATCH: "本人と不一致",
  IDENTITY_VERIFIED: "本人確認成功",
  LONG_ABSENCE: "長時間の不在",
  LOW_CONFIDENCE: "信頼度が低い",
};

export const TIER_LABELS: Record<string, string> = {
  HOT: "重点監視",
  WARM: "注視",
  NORMAL: "通常",
};

export const SEVERITY_TONES: Record<string, Tone> = {
  ALERT: "danger",
  WARNING: "warning",
  INFO: "info",
};

/** Colour used in the participant timeline strip. */
export const STATE_COLORS: Record<string, string> = {
  SCREEN_FACING: "#10b981",
  LOOKING_LEFT: "#f59e0b",
  LOOKING_RIGHT: "#f59e0b",
  LOOKING_UP: "#f59e0b",
  LOOKING_DOWN: "#f59e0b",
  FACE_NOT_VISIBLE: "#ef4444",
  CAMERA_OFF: "#94a3b8",
  MULTIPLE_FACES: "#dc2626",
  IDENTITY_MISMATCH: "#b91c1c",
  LOW_CONFIDENCE: "#c084fc",
  UNKNOWN: "#cbd5e1",
};

const ATTENTION = new Set([
  "IDENTITY_MISMATCH",
  "MULTIPLE_FACES",
  "FACE_NOT_VISIBLE",
  "CAMERA_OFF",
]);

export function needsAttention(state: string): boolean {
  return ATTENTION.has(state);
}

export function isLookingAway(state: string): boolean {
  return (
    state === "LOOKING_LEFT" ||
    state === "LOOKING_RIGHT" ||
    state === "LOOKING_UP" ||
    state === "LOOKING_DOWN"
  );
}

/** Sort weight for "who needs my attention first?" — higher first. */
const RISK: Record<string, number> = {
  IDENTITY_MISMATCH: 100,
  MULTIPLE_FACES: 90,
  FACE_NOT_VISIBLE: 80,
  CAMERA_OFF: 70,
  LOOKING_DOWN: 40,
  LOOKING_LEFT: 40,
  LOOKING_RIGHT: 40,
  LOOKING_UP: 40,
  LOW_CONFIDENCE: 30,
  UNKNOWN: 20,
  SCREEN_FACING: 0,
};

export function riskOf(state: string, identityStatus: string): number {
  const identityPenalty = identityStatus === "VERIFIED" ? 0 : identityStatus === "MISMATCH" ? 50 : 15;
  return (RISK[state] ?? 20) + identityPenalty;
}

/** Short relative time, e.g. "3秒前". Used all over the grid. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.floor(m / 60)}時間前`;
}

export function durationLabel(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${String(s % 60).padStart(2, "0")}秒`;
}

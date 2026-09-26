/**
 * The nine per-participant signals the organizer console reports.
 *
 * Pure, so the wording and the tone thresholds can be tested without a browser
 * — these strings are what an organizer acts on, and a signal that reads
 * "なし" when it was never measured is worse than no signal at all.
 *
 * Two rules the whole file exists to enforce:
 *
 * 1. **Not measured is not a value.** `null` renders as 未測定, never as 0,
 *    「なし」 or 「開」. A blurred frame and a genuinely absent blink both come
 *    back empty from the analyser; presenting either as a confident zero would
 *    invent evidence in a product whose output is used in attendance records.
 *
 * 2. **Never restate a backend judgement.** 居眠り疑い and 離席 read the
 *    committed engagement state rather than recomputing a duration here. The
 *    backend holds the tenant's thresholds and the temporal-persistence rule;
 *    a second opinion in the UI would disagree with the audit log.
 *
 * Wording follows PRODUCT_SPEC_JA.md §3.4: every label describes what a camera
 * can evidence. 居眠り「疑い」 is a suspicion for a human to confirm, never a
 * finding.
 */
import type { MeetingParticipant } from "@/lib/api";
import { HEAD_LABELS } from "./signals";

export type SignalTone = "ok" | "warn" | "bad" | "idle";

export interface ParticipantSignal {
  key: string;
  label: string;
  /** Short enough for a tile chip; the detail view shows `detail` as well. */
  value: string;
  detail?: string;
  tone: SignalTone;
}

/** Degrees, signed, with an explicit zero rather than "-0". */
function deg(v: number | null): string {
  if (v == null) return "—";
  const r = Math.round(v);
  return `${r === 0 ? 0 : r}°`;
}

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

/**
 * Sharpness below this makes every other reading from the same frame
 * questionable: pose and eye-aspect-ratio are both landmark-derived, and
 * landmarks on a blurred face are confidently wrong rather than absent.
 */
export const SHARPNESS_UNRELIABLE = 0.25;
const SHARPNESS_GOOD = 0.5;

export function participantSignals(p: MeetingParticipant): ParticipantSignal[] {
  const analysed = p.lastAnalyzedAt != null;

  /* 1. 顔検出 */
  const faceDetected: ParticipantSignal = !analysed
    ? { key: "face", label: "顔検出", value: "未解析", tone: "idle" }
    : p.faceDetected
      ? {
          key: "face",
          label: "顔検出",
          value: "検出",
          detail: p.analysisConfidence != null ? `信頼度 ${pct(p.analysisConfidence)}` : undefined,
          tone: "ok",
        }
      : { key: "face", label: "顔検出", value: "なし", tone: "bad" };

  /* 2. 顔の向き */
  const facing = p.screenFacingProbability;
  const headDirection: ParticipantSignal = !analysed || !p.faceDetected
    ? { key: "head", label: "顔の向き", value: "—", tone: "idle" }
    : {
        key: "head",
        label: "顔の向き",
        value: HEAD_LABELS[p.headState] ?? p.headState,
        detail: `左右 ${deg(p.headYaw)} / 上下 ${deg(p.headPitch)}${
          facing != null ? ` ・正対 ${pct(facing)}` : ""
        }`,
        tone: p.headState === "FORWARD" ? "ok" : "warn",
      };

  /* 3. 目の開閉 */
  const eyes: ParticipantSignal = !analysed || !p.faceDetected
    ? { key: "eyes", label: "目の開閉", value: "—", tone: "idle" }
    : {
        key: "eyes",
        label: "目の開閉",
        value: p.eyeClosed ? "閉" : "開",
        detail: p.eyeOpenness != null ? `開度 ${pct(p.eyeOpenness)}` : "開度は未測定",
        tone: p.eyeClosed ? "warn" : "ok",
      };

  /* 4. 瞬き — only the capture side runs fast enough to see one. */
  const blink: ParticipantSignal =
    p.blinkRatePerMin == null
      ? {
          key: "blink",
          label: "瞬き",
          value: "未測定",
          detail: "撮影側が瞬き計測に対応していません",
          tone: "idle",
        }
      : {
          key: "blink",
          label: "瞬き",
          value: `${p.blinkRatePerMin.toFixed(1)} 回/分`,
          detail: `累計 ${p.blinkCount} 回`,
          // A very low rate is the one worth surfacing: it accompanies both
          // screen fatigue and a still photograph held up to the camera.
          tone: p.blinkRatePerMin < 5 ? "warn" : "ok",
        };

  /* 5. 鮮明度 */
  const sharp: ParticipantSignal =
    p.sharpness == null
      ? { key: "sharpness", label: "鮮明度", value: "未測定", tone: "idle" }
      : {
          key: "sharpness",
          label: "鮮明度",
          value: pct(p.sharpness),
          detail:
            p.sharpness < SHARPNESS_UNRELIABLE
              ? "映像が不鮮明なため、他の判定の信頼度も低下します"
              : undefined,
          tone: p.sharpness < SHARPNESS_UNRELIABLE ? "bad" : p.sharpness < SHARPNESS_GOOD ? "warn" : "ok",
        };

  /* 6. 離席 — the committed state, not a fresh duration calculation. */
  const away: ParticipantSignal = p.leftAt
    ? { key: "away", label: "離席", value: "退出済み", tone: "idle" }
    : p.currentState === "FACE_NOT_VISIBLE"
      ? { key: "away", label: "離席", value: "可能性あり", detail: "顔が映っていません", tone: "bad" }
      : p.currentState === "CAMERA_OFF"
        ? { key: "away", label: "離席", value: "判定不可", detail: "カメラオフ", tone: "idle" }
        : !analysed
          ? { key: "away", label: "離席", value: "—", tone: "idle" }
          : { key: "away", label: "離席", value: "在席", tone: "ok" };

  /* 7. 複数人 */
  const multi: ParticipantSignal = !analysed
    ? { key: "multi", label: "複数人", value: "—", tone: "idle" }
    : p.faceCount > 1
      ? { key: "multi", label: "複数人", value: `${p.faceCount}人を検出`, tone: "bad" }
      : { key: "multi", label: "複数人", value: "なし", tone: "ok" };

  /* 8. 居眠り疑い — the backend's committed suspicion, after its own dwell rule. */
  const drowsy: ParticipantSignal =
    p.currentState === "EYES_CLOSED"
      ? {
          key: "drowsy",
          label: "居眠り疑い",
          value: "疑いあり",
          detail: "確認が必要です（自動判定のみでは不合格としません）",
          tone: "bad",
        }
      : !analysed
        ? { key: "drowsy", label: "居眠り疑い", value: "—", tone: "idle" }
        : { key: "drowsy", label: "居眠り疑い", value: "なし", tone: "ok" };

  /* 9. 他人検出 */
  const impostor: ParticipantSignal =
    p.identityStatus === "MISMATCH"
      ? { key: "identity", label: "他人検出", value: "検出", detail: "登録者と一致しません", tone: "bad" }
      : p.identityStatus === "VERIFIED"
        ? {
            key: "identity",
            label: "他人検出",
            value: "なし",
            detail: p.identityConfidence != null ? `一致度 ${pct(p.identityConfidence)}` : undefined,
            tone: "ok",
          }
        : p.identityStatus === "LOW_CONFIDENCE"
          ? { key: "identity", label: "他人検出", value: "判定保留", detail: "信頼度が低い", tone: "warn" }
          : { key: "identity", label: "他人検出", value: "未確認", tone: "idle" };

  return [faceDetected, headDirection, eyes, blink, sharp, away, multi, drowsy, impostor];
}

export const SIGNAL_TONE_CLASS: Record<SignalTone, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-50 text-amber-700 ring-amber-200",
  bad: "bg-rose-50 text-rose-700 ring-rose-200",
  idle: "bg-slate-50 text-slate-500 ring-slate-200",
};

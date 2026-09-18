/**
 * Server-side rule evaluation.
 *
 * The trainee's browser proposes an event; this module decides what it actually
 * means. API_CONTRACT.md requires that alert confirmation never rests on the
 * client's own claim, so severity is re-derived here from durations and the
 * organization's rule snapshot, and implausible traffic is quarantined.
 */

export type EventType =
  | "FACE_ABSENT"
  | "MULTIPLE_FACES"
  | "EYES_CLOSED"
  | "MATCH_OK"
  | "MATCH_FAIL"
  | "CAMERA_BLOCKED"
  | "CAMERA_STOPPED"
  | "TAB_HIDDEN"
  | "NETWORK_LOST"
  | "PRECHECK_PASS"
  | "PRECHECK_FAIL"
  | "HEARTBEAT";

export type Severity = "INFO" | "WARNING" | "ALERT";

export type ParticipantStatus =
  | "PRECHECK_PENDING"
  | "VERIFIED"
  | "MONITORING"
  | "WARNING"
  | "ALERT"
  | "REVIEWED"
  | "DISCONNECTED"
  | "COMPLETED";

export interface MonitoringRules {
  version: number;
  reauthIntervalSec: number;
  matchThreshold: number;
  absenceSec: number;
  eyesClosedSec: number;
  multiFaceFrames: number;
  evidenceIntervalSec: number;
  evidenceRetentionDays: number;
  precheckMaxAttempts: number;
  livenessRequired: boolean;
  imageQuality: number;
}

export const DEFAULT_RULES: MonitoringRules = {
  version: 1,
  reauthIntervalSec: 60,
  matchThreshold: 0.82,
  absenceSec: 60,
  eyesClosedSec: 10,
  multiFaceFrames: 15,
  evidenceIntervalSec: 300,
  evidenceRetentionDays: 30,
  precheckMaxAttempts: 3,
  livenessRequired: true,
  imageQuality: 0.72,
};

export interface ProposedEvent {
  type: EventType;
  capturedAt: number;
  durationMs?: number | null;
  faceCount?: number | null;
  matchScore?: number | null;
  qualityScore?: number | null;
  frameCount?: number | null;
}

export interface Judgement {
  severity: Severity;
  /** Null when the event is informational and should not surface as an alert. */
  alertType: string | null;
  summary: string;
  detail: string;
  /** Groups an ongoing condition so repeat notifications are suppressed. */
  dedupeKey: string | null;
  status: ParticipantStatus | null;
  evidenceRequired: boolean;
  /** True when the client's proposed severity was overridden. */
  adjusted: boolean;
}

/** Clock skew we tolerate on client-stamped `capturedAt` values. */
export const MAX_CLOCK_SKEW_MS = 120_000;
/** Events older than this are refused outright rather than back-dated. */
export const MAX_EVENT_AGE_MS = 15 * 60 * 1000;

export interface PlausibilityResult {
  ok: boolean;
  quarantine: boolean;
  reason?: string;
}

/**
 * Rejects events that could not physically have happened, and quarantines
 * (rather than drops) the ones that merely look wrong — a quarantined event is
 * still stored for investigation but never raises an alert.
 */
export function checkPlausibility(
  event: ProposedEvent,
  now: number,
  recentEventCount: number,
): PlausibilityResult {
  if (!Number.isFinite(event.capturedAt)) {
    return { ok: false, quarantine: false, reason: "capturedAt が不正です" };
  }
  if (event.capturedAt > now + MAX_CLOCK_SKEW_MS) {
    return { ok: false, quarantine: false, reason: "未来時刻のイベントです" };
  }
  if (now - event.capturedAt > MAX_EVENT_AGE_MS) {
    return { ok: false, quarantine: false, reason: "古すぎるイベントです" };
  }
  if (event.durationMs != null && (event.durationMs < 0 || event.durationMs > 6 * 60 * 60 * 1000)) {
    return { ok: true, quarantine: true, reason: "継続時間が不正です" };
  }
  if (event.faceCount != null && (event.faceCount < 0 || event.faceCount > 32)) {
    return { ok: true, quarantine: true, reason: "顔検出数が不正です" };
  }
  if (event.matchScore != null && (event.matchScore < -1 || event.matchScore > 1)) {
    return { ok: true, quarantine: true, reason: "照合スコアが範囲外です" };
  }
  // A single participant cannot legitimately produce hundreds of events a minute.
  if (recentEventCount > 240) {
    return { ok: true, quarantine: true, reason: "イベント流量が異常です" };
  }
  return { ok: true, quarantine: false };
}

const seconds = (ms: number | null | undefined) => Math.round((ms ?? 0) / 1000);

/**
 * Maps a proposed event to a judgement.
 *
 * Thresholds are always compared against the session's own rule snapshot, so a
 * settings change cannot retroactively re-grade past events.
 */
export function evaluate(
  event: ProposedEvent,
  rules: MonitoringRules,
  claimedSeverity?: Severity,
): Judgement {
  const base = {
    dedupeKey: null as string | null,
    status: null as ParticipantStatus | null,
    evidenceRequired: false,
    adjusted: false,
  };

  let judgement: Judgement;

  switch (event.type) {
    case "FACE_ABSENT": {
      const elapsed = seconds(event.durationMs);
      const breached = elapsed >= rules.absenceSec;
      judgement = {
        ...base,
        severity: breached ? "ALERT" : "WARNING",
        alertType: breached ? "離席" : null,
        summary: breached ? "離席を検知しました" : "顔が一時的に検出できません",
        detail: `顔未検出 ${elapsed}秒（しきい値 ${rules.absenceSec}秒）`,
        dedupeKey: breached ? "FACE_ABSENT" : null,
        status: breached ? "ALERT" : "WARNING",
        evidenceRequired: breached,
      };
      break;
    }

    case "MULTIPLE_FACES": {
      const frames = event.frameCount ?? 0;
      const faces = event.faceCount ?? 0;
      const breached = frames >= rules.multiFaceFrames && faces >= 2;
      judgement = {
        ...base,
        severity: breached ? "ALERT" : "WARNING",
        alertType: breached ? "複数人" : null,
        summary: breached ? "複数人の在席を検知しました" : "複数人を一時的に検出しました",
        detail: `${faces}名を検出（${frames}フレーム / しきい値 ${rules.multiFaceFrames}フレーム）`,
        dedupeKey: breached ? "MULTIPLE_FACES" : null,
        status: breached ? "ALERT" : "WARNING",
        evidenceRequired: breached,
      };
      break;
    }

    case "EYES_CLOSED": {
      const elapsed = seconds(event.durationMs);
      const breached = elapsed >= rules.eyesClosedSec;
      // Deliberately capped at WARNING: drowsiness is a *suspicion* that a human
      // must confirm, and must never by itself fail a trainee
      // (SECURITY_PRIVACY.md §4, PRODUCT_SPEC_JA.md §3.4).
      judgement = {
        ...base,
        severity: "WARNING",
        alertType: breached ? "居眠り疑い" : null,
        summary: breached ? "居眠りの疑いがあります（要確認）" : "閉眼を検出しました",
        detail: `閉眼 ${elapsed}秒（しきい値 ${rules.eyesClosedSec}秒）`,
        dedupeKey: breached ? "EYES_CLOSED" : null,
        status: breached ? "WARNING" : null,
        evidenceRequired: breached,
      };
      break;
    }

    case "MATCH_FAIL": {
      const score = event.matchScore ?? 0;
      judgement = {
        ...base,
        severity: "ALERT",
        alertType: "本人確認不一致",
        summary: "登録顔と一致しません",
        detail: `一致度 ${(score * 100).toFixed(1)}%（しきい値 ${(rules.matchThreshold * 100).toFixed(1)}%）`,
        dedupeKey: "MATCH_FAIL",
        status: "ALERT",
        evidenceRequired: true,
      };
      break;
    }

    case "MATCH_OK": {
      const score = event.matchScore ?? 0;
      judgement = {
        ...base,
        severity: "INFO",
        alertType: null,
        summary: "継続認証に成功しました",
        detail: `一致度 ${(score * 100).toFixed(1)}%`,
        status: "MONITORING",
      };
      break;
    }

    case "CAMERA_BLOCKED":
    case "CAMERA_STOPPED": {
      const label = event.type === "CAMERA_BLOCKED" ? "カメラ遮蔽" : "カメラ停止";
      judgement = {
        ...base,
        severity: "ALERT",
        alertType: label,
        summary: `${label}を検知しました`,
        detail: `${label}が継続しています`,
        dedupeKey: event.type,
        status: "ALERT",
        evidenceRequired: false,
      };
      break;
    }

    case "TAB_HIDDEN": {
      const elapsed = seconds(event.durationMs);
      judgement = {
        ...base,
        severity: elapsed >= rules.absenceSec ? "ALERT" : "WARNING",
        alertType: elapsed >= rules.absenceSec ? "画面離脱" : null,
        summary: "受講画面が非表示になりました",
        detail: `非表示 ${elapsed}秒`,
        dedupeKey: elapsed >= rules.absenceSec ? "TAB_HIDDEN" : null,
        status: elapsed >= rules.absenceSec ? "ALERT" : "WARNING",
      };
      break;
    }

    case "NETWORK_LOST": {
      judgement = {
        ...base,
        severity: "WARNING",
        alertType: null,
        summary: "ネットワークが切断されました",
        detail: "受講端末との接続が失われました",
        status: "DISCONNECTED",
      };
      break;
    }

    case "PRECHECK_PASS": {
      judgement = {
        ...base,
        severity: "INFO",
        alertType: null,
        summary: "開始前本人確認に成功しました",
        detail: `一致度 ${((event.matchScore ?? 0) * 100).toFixed(1)}%`,
        status: "VERIFIED",
      };
      break;
    }

    case "PRECHECK_FAIL": {
      judgement = {
        ...base,
        severity: "WARNING",
        alertType: "本人確認失敗",
        summary: "開始前本人確認に失敗しました",
        detail: `一致度 ${((event.matchScore ?? 0) * 100).toFixed(1)}%`,
        dedupeKey: "PRECHECK_FAIL",
        status: "PRECHECK_PENDING",
        evidenceRequired: true,
      };
      break;
    }

    case "HEARTBEAT":
    default: {
      judgement = {
        ...base,
        severity: "INFO",
        alertType: null,
        summary: "受講中",
        detail: "定期報告",
        status: null,
      };
      break;
    }
  }

  judgement.adjusted = claimedSeverity != null && claimedSeverity !== judgement.severity;
  return judgement;
}

/**
 * Status precedence. A participant already in ALERT must not be quietly
 * downgraded by a later routine heartbeat; only an explicit review clears it.
 */
const STATUS_RANK: Record<ParticipantStatus, number> = {
  PRECHECK_PENDING: 0,
  VERIFIED: 1,
  MONITORING: 2,
  WARNING: 3,
  ALERT: 4,
  DISCONNECTED: 4,
  REVIEWED: 5,
  COMPLETED: 6,
};

export function nextStatus(
  current: ParticipantStatus,
  proposed: ParticipantStatus | null,
): ParticipantStatus {
  if (!proposed) return current;
  if (current === "COMPLETED" || current === "REVIEWED") return current;
  // Recovery: a good match legitimately clears a transient WARNING.
  if (proposed === "MONITORING" && current === "WARNING") return "MONITORING";
  if (proposed === "MONITORING" && current === "DISCONNECTED") return "MONITORING";
  return STATUS_RANK[proposed] >= STATUS_RANK[current] ? proposed : current;
}

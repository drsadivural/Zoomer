/**
 * The observable-signal vocabulary for the Zoom Organizer Intelligence layer.
 *
 * Every label here describes something a camera can actually evidence — a face
 * is visible or it is not, a head is turned or it is not. Nothing in this file
 * claims to know what a participant is thinking. Psychological labels
 * ("distracted", "not listening", "bored") are deliberately absent and must not
 * be added: the product promise is *observable and technically defensible
 * signals*, and a label we cannot defend in a review is a liability, not a
 * feature.
 */

/** Committed engagement state of one participant. */
export const ENGAGEMENT_STATES = [
  "SCREEN_FACING",
  "LOOKING_LEFT",
  "LOOKING_RIGHT",
  "LOOKING_UP",
  "LOOKING_DOWN",
  "FACE_NOT_VISIBLE",
  "CAMERA_OFF",
  "MULTIPLE_FACES",
  "IDENTITY_MISMATCH",
  // Eyes closed for a sustained period. Reported as a *suspicion* requiring a
  // human to confirm, never as a finding about the person — the product does
  // not claim to know whether someone is asleep, only that their eyes were
  // closed (PRODUCT_SPEC_JA.md §3.4).
  "EYES_CLOSED",
  "LOW_CONFIDENCE",
  // A Zoom attendee we know about but have no analysis for yet.
  "ANALYSIS_PENDING",
  "UNKNOWN",
] as const;

export type EngagementState = (typeof ENGAGEMENT_STATES)[number];

/** Head orientation bucket derived from yaw/pitch. */
export const HEAD_STATES = ["FORWARD", "LEFT", "RIGHT", "UP", "DOWN", "UNKNOWN"] as const;
export type HeadState = (typeof HEAD_STATES)[number];

export const IDENTITY_STATUSES = [
  "VERIFIED",
  "UNVERIFIED",
  "MISMATCH",
  "NO_FACE",
  "MULTIPLE_FACES",
  "LOW_CONFIDENCE",
  "UNKNOWN",
] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/** Scheduler tiers (§6). */
export const ANALYSIS_TIERS = ["HOT", "WARM", "NORMAL"] as const;
export type AnalysisTier = (typeof ANALYSIS_TIERS)[number];

/** Engagement events raised by the event engine (§14). */
export const ENGAGEMENT_EVENT_TYPES = [
  "PARTICIPANT_JOINED",
  "PARTICIPANT_LEFT",
  "FACE_MISSING",
  "FACE_RETURNED",
  "SCREEN_AWAY",
  "SCREEN_FACING_RETURNED",
  "CAMERA_OFF",
  "CAMERA_ON",
  "MULTIPLE_FACES",
  "IDENTITY_MISMATCH",
  "IDENTITY_VERIFIED",
  "LONG_ABSENCE",
  "LOW_CONFIDENCE",
  "DROWSINESS_SUSPECTED",
  "EYES_REOPENED",
] as const;
export type EngagementEventType = (typeof ENGAGEMENT_EVENT_TYPES)[number];

export type Severity = "INFO" | "WARNING" | "ALERT";

/** Which states mean "this participant needs the organizer's attention" (§47). */
export const ATTENTION_STATES: readonly EngagementState[] = [
  "IDENTITY_MISMATCH",
  "MULTIPLE_FACES",
  "FACE_NOT_VISIBLE",
  "EYES_CLOSED",
  "CAMERA_OFF",
];

export function isAttentionState(state: EngagementState): boolean {
  return ATTENTION_STATES.includes(state);
}

/** True when the participant is looking away from the screen but still visible. */
export function isLookingAway(state: EngagementState): boolean {
  return (
    state === "LOOKING_LEFT" ||
    state === "LOOKING_RIGHT" ||
    state === "LOOKING_UP" ||
    state === "LOOKING_DOWN"
  );
}

/**
 * Risk ordering for "who needs me first?". Higher sorts first in the organizer
 * grid and drives the scheduler's HOT tier.
 */
const STATE_RISK: Record<EngagementState, number> = {
  IDENTITY_MISMATCH: 100,
  MULTIPLE_FACES: 90,
  FACE_NOT_VISIBLE: 80,
  EYES_CLOSED: 75,
  CAMERA_OFF: 70,
  LOOKING_DOWN: 40,
  LOOKING_LEFT: 40,
  LOOKING_RIGHT: 40,
  LOOKING_UP: 40,
  LOW_CONFIDENCE: 30,
  ANALYSIS_PENDING: 25,
  UNKNOWN: 20,
  SCREEN_FACING: 0,
};

export function stateRisk(state: EngagementState): number {
  return STATE_RISK[state] ?? 20;
}

const IDENTITY_RISK: Record<IdentityStatus, number> = {
  MISMATCH: 100,
  MULTIPLE_FACES: 70,
  UNVERIFIED: 50,
  NO_FACE: 40,
  LOW_CONFIDENCE: 30,
  UNKNOWN: 25,
  VERIFIED: 0,
};

export function identityRisk(status: IdentityStatus): number {
  return IDENTITY_RISK[status] ?? 25;
}

/** Severity an engagement event carries when it opens. */
const EVENT_SEVERITY: Record<EngagementEventType, Severity> = {
  // Deliberately WARNING, not ALERT, and deliberately named "suspected":
  // eyes being shut is not proof that somebody is asleep, and this signal must
  // never by itself fail a trainee. It is shown prominently so an organizer
  // looks — the judgement stays with the human.
  DROWSINESS_SUSPECTED: "WARNING",
  EYES_REOPENED: "INFO",
  IDENTITY_MISMATCH: "ALERT",
  MULTIPLE_FACES: "ALERT",
  LONG_ABSENCE: "ALERT",
  FACE_MISSING: "WARNING",
  SCREEN_AWAY: "WARNING",
  CAMERA_OFF: "WARNING",
  LOW_CONFIDENCE: "INFO",
  PARTICIPANT_JOINED: "INFO",
  PARTICIPANT_LEFT: "INFO",
  FACE_RETURNED: "INFO",
  SCREEN_FACING_RETURNED: "INFO",
  CAMERA_ON: "INFO",
  IDENTITY_VERIFIED: "INFO",
};

export function eventSeverity(type: EngagementEventType): Severity {
  return EVENT_SEVERITY[type] ?? "INFO";
}

/** Events that close an earlier open event rather than opening a new concern. */
const RESOLVING: Partial<Record<EngagementEventType, EngagementEventType>> = {
  EYES_REOPENED: "DROWSINESS_SUSPECTED",
  FACE_RETURNED: "FACE_MISSING",
  SCREEN_FACING_RETURNED: "SCREEN_AWAY",
  CAMERA_ON: "CAMERA_OFF",
  IDENTITY_VERIFIED: "IDENTITY_MISMATCH",
};

export function resolves(type: EngagementEventType): EngagementEventType | null {
  return RESOLVING[type] ?? null;
}

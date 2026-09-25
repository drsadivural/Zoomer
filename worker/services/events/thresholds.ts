/**
 * Duration thresholds for the event engine.
 *
 * §12 defines four bands, and every one of them is configurable because the
 * right number is a customer policy decision, not a technical one:
 *
 *   < transientSec   ignore — normal human movement
 *   < temporarySec   temporary status only, no event
 *   ≥ per-event gate open an event
 *   ≥ prolongedSec   escalate the open event
 */
import type { MeetingMonitoringConfig } from "../monitoring/config";
import type { EngagementEventType, EngagementState } from "../monitoring/signals";

export type DurationBand = "TRANSIENT" | "TEMPORARY" | "EVENT" | "PROLONGED";

export function classifyDuration(
  durationMs: number,
  gateSec: number,
  config: MeetingMonitoringConfig,
): DurationBand {
  const seconds = durationMs / 1000;
  // A condition is only "prolonged" once it has been sustained BEYOND the gate
  // that opened it. Without the strict comparison, a gate configured at or above
  // `prolongedSec` would make every event escalate the instant it opens, and the
  // EVENT band would never be reachable.
  if (seconds >= config.prolongedSec && seconds > gateSec) return "PROLONGED";
  if (seconds >= gateSec) return "EVENT";
  if (seconds >= config.transientSec) return "TEMPORARY";
  return "TRANSIENT";
}

/** The engagement event a sustained state maps to, and how long it must hold. */
export interface StateGate {
  type: EngagementEventType;
  gateSec: number;
  /** Raised instead of `type` once the state has held for `escalateSec`. */
  escalateTo?: EngagementEventType;
  escalateSec?: number;
  /** Feature flag that must be on for this gate to apply. */
  requires?: keyof MeetingMonitoringConfig;
}

/**
 * Maps a committed engagement state to the event it eventually raises.
 *
 * States absent from this table (SCREEN_FACING, UNKNOWN) raise nothing — an
 * organizer does not need an event to say a participant is behaving normally.
 */
export function gateForState(
  state: EngagementState,
  config: MeetingMonitoringConfig,
): StateGate | null {
  switch (state) {
    case "FACE_NOT_VISIBLE":
      return {
        type: "FACE_MISSING",
        gateSec: config.faceMissingSec,
        escalateTo: "LONG_ABSENCE",
        escalateSec: config.longAbsenceSec,
        requires: "faceMonitoringEnabled",
      };
    case "CAMERA_OFF":
      return { type: "CAMERA_OFF", gateSec: config.cameraOffSec };
    case "MULTIPLE_FACES":
      return {
        type: "MULTIPLE_FACES",
        gateSec: config.multiFaceSec,
        requires: "multiFaceEnabled",
      };
    case "IDENTITY_MISMATCH":
      // Immediate by design: an organizer must not learn about a possible
      // impersonation 30 seconds late.
      return { type: "IDENTITY_MISMATCH", gateSec: 0, requires: "identityVerificationEnabled" };
    case "EYES_CLOSED":
      return {
        type: "DROWSINESS_SUSPECTED",
        gateSec: config.eyesClosedSec,
        requires: "drowsinessEnabled",
      };
    case "LOW_CONFIDENCE":
      return { type: "LOW_CONFIDENCE", gateSec: config.temporarySec };
    case "LOOKING_LEFT":
    case "LOOKING_RIGHT":
    case "LOOKING_UP":
    case "LOOKING_DOWN":
      return {
        type: "SCREEN_AWAY",
        gateSec: config.screenAwaySec,
        requires: "screenFacingEnabled",
      };
    default:
      return null;
  }
}

export function gateEnabled(gate: StateGate, config: MeetingMonitoringConfig): boolean {
  if (!gate.requires) return true;
  return Boolean(config[gate.requires]);
}

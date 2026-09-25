/**
 * Event engine.
 *
 * Turns a stream of participant states into a small number of meaningful,
 * closable events. Pure: it reads state and the currently-open events, and
 * returns the actions a caller should persist. Deciding *what happened* and
 * *writing it down* are separate so the decision half stays testable.
 *
 * Design rule: every condition that opens must be able to close. An event feed
 * full of things that never resolve teaches an organizer to ignore it.
 */
import type { MeetingMonitoringConfig } from "../monitoring/config";
import {
  eventSeverity,
  type EngagementEventType,
  type EngagementState,
  type Severity,
} from "../monitoring/signals";
import type { ParticipantState } from "../analysis/participant-state";
import { indexOpenEvents, shouldSuppressReopen, type OpenEvent } from "./deduplication";
import { classifyDuration, gateEnabled, gateForState } from "./thresholds";

export type EventAction =
  | {
      kind: "OPEN";
      type: EngagementEventType;
      severity: Severity;
      dedupeKey: string;
      startedAt: number;
      detail: string;
      confidence: number | null;
      /** True when this should also raise a row in the existing alert inbox. */
      escalate: boolean;
    }
  | {
      kind: "ESCALATE";
      id: string;
      type: EngagementEventType;
      severity: Severity;
      dedupeKey: string;
      detail: string;
    }
  | {
      kind: "RESOLVE";
      id: string;
      type: EngagementEventType;
      dedupeKey: string;
      resolvedAt: number;
      durationMs: number;
      detail: string;
    };

export interface EvaluateInput {
  state: ParticipantState;
  openEvents: OpenEvent[];
  config: MeetingMonitoringConfig;
  now: number;
  /** Resolve times keyed by dedupe key, for the re-open cool-off. */
  lastResolvedAt?: Record<string, number>;
}

const seconds = (ms: number) => Math.round(ms / 1000);

/** Human-readable detail, in the product's UI language. */
function describe(type: EngagementEventType, state: ParticipantState, durationMs: number): string {
  const s = seconds(durationMs);
  switch (type) {
    case "FACE_MISSING":
      return `顔が検出できない状態が ${s}秒 継続しています`;
    case "LONG_ABSENCE":
      return `長時間の不在（${s}秒）を検出しました`;
    case "SCREEN_AWAY":
      return `画面から視線が外れた状態が ${s}秒 継続しています（頭部方向 ${state.headState}）`;
    case "CAMERA_OFF":
      return `カメラがオフの状態が ${s}秒 継続しています`;
    case "MULTIPLE_FACES":
      return `${state.faceCount}名の顔を検出しています（${s}秒継続）`;
    case "IDENTITY_MISMATCH":
      return `登録された本人と一致しません（一致度 ${((state.identityConfidence ?? 0) * 100).toFixed(1)}%）`;
    case "DROWSINESS_SUSPECTED":
      return `閉眼が ${s}秒 継続しています（居眠りの疑い・要確認）`;
    case "EYES_REOPENED":
      return "開眼を確認しました";
    case "LOW_CONFIDENCE":
      return `解析の信頼度が低い状態が ${s}秒 継続しています`;
    case "IDENTITY_VERIFIED":
      return `本人確認に成功しました（一致度 ${((state.identityConfidence ?? 0) * 100).toFixed(1)}%）`;
    case "PARTICIPANT_JOINED":
      return "参加しました";
    case "PARTICIPANT_LEFT":
      return "退出しました";
    default:
      return "状態が復帰しました";
  }
}

/**
 * Events that should also land in the organizer's existing alert inbox.
 *
 * Kept deliberately short. Everything else is visible in the live grid and the
 * event feed; promoting it to an alert as well would dilute the inbox that
 * already exists for the trainee-side pipeline.
 */
const ESCALATES: readonly EngagementEventType[] = [
  "IDENTITY_MISMATCH",
  "MULTIPLE_FACES",
  "LONG_ABSENCE",
  // Raised as a WARNING-severity alert, matching how the trainee-side pipeline
  // has always handled 居眠り疑い: visible to the organizer, never an automatic
  // judgement about the person.
  "DROWSINESS_SUSPECTED",
];

/**
 * Evaluates one participant.
 *
 * Returns the actions to apply, in the order they should be applied: resolutions
 * first (so a condition that ended frees its dedupe key before a new one opens).
 */
export function evaluateParticipant(input: EvaluateInput): EventAction[] {
  const { state, config, now } = input;
  const open = indexOpenEvents(input.openEvents);
  const actions: EventAction[] = [];

  const gate = gateForState(state.currentState, config);
  const activeGate = gate && gateEnabled(gate, config) ? gate : null;

  // The set of dedupe keys the current state still justifies. An open event
  // whose key is not in here has, by definition, ended.
  const justified = new Set<string>();
  if (activeGate) {
    justified.add(activeGate.type);
    if (activeGate.escalateTo) justified.add(activeGate.escalateTo);
  }

  /* ------------------------------------------------------------- resolve */

  for (const event of input.openEvents) {
    if (justified.has(event.dedupeKey)) continue;
    actions.push({
      kind: "RESOLVE",
      id: event.id,
      type: event.type,
      dedupeKey: event.dedupeKey,
      resolvedAt: now,
      durationMs: Math.max(0, now - event.startedAt),
      detail: describe(event.type, state, Math.max(0, now - event.startedAt)),
    });
  }

  if (!activeGate) return actions;

  /* ---------------------------------------------------------------- open */

  const heldMs = Math.max(0, now - state.currentStateSince);
  const heldSec = heldMs / 1000;

  const openFor = (type: EngagementEventType, startedAt: number) => {
    const existing = open.get(type);
    if (existing) return; // already open — dedupe, do not re-raise
    if (shouldSuppressReopen(input.lastResolvedAt?.[type], now, config.transientSec)) return;
    actions.push({
      kind: "OPEN",
      type,
      severity: eventSeverity(type),
      dedupeKey: type,
      startedAt,
      detail: describe(type, state, now - startedAt),
      confidence: state.analysisConfidence,
      escalate: ESCALATES.includes(type),
    });
  };

  // §12's bands, stated explicitly rather than implied by the comparison:
  // TRANSIENT and TEMPORARY produce a status only; EVENT and PROLONGED open one.
  const band = classifyDuration(heldMs, activeGate.gateSec, config);
  if (band === "EVENT" || band === "PROLONGED") {
    openFor(activeGate.type, state.currentStateSince);
  }

  // Prolonged conditions get their own event rather than silently changing the
  // meaning of the first one — the timeline then shows both the onset and the
  // point at which it became serious.
  if (activeGate.escalateTo && activeGate.escalateSec != null && heldSec >= activeGate.escalateSec) {
    openFor(activeGate.escalateTo, state.currentStateSince);

    const primary = open.get(activeGate.type);
    if (primary && !primary.escalated) {
      actions.push({
        kind: "ESCALATE",
        id: primary.id,
        type: primary.type,
        severity: "ALERT",
        dedupeKey: primary.dedupeKey,
        detail: describe(activeGate.escalateTo, state, heldMs),
      });
    }
  }

  return actions;
}

/**
 * Discrete lifecycle events. These are not derived from video at all — they come
 * from Zoom's participant stream — so they bypass the state machine entirely.
 */
export function lifecycleEvent(
  type: Extract<EngagementEventType, "PARTICIPANT_JOINED" | "PARTICIPANT_LEFT" | "IDENTITY_VERIFIED">,
  state: ParticipantState,
  now: number,
): EventAction {
  return {
    kind: "OPEN",
    type,
    severity: eventSeverity(type),
    dedupeKey: `${type}:${now}`, // point-in-time: never deduped, never resolved
    startedAt: now,
    detail: describe(type, state, 0),
    confidence: state.analysisConfidence,
    escalate: false,
  };
}

/** Which engagement states currently count as "needs attention" for the KPIs. */
export function needsAttention(state: EngagementState): boolean {
  return (
    state === "IDENTITY_MISMATCH" ||
    state === "MULTIPLE_FACES" ||
    state === "FACE_NOT_VISIBLE" ||
    state === "EYES_CLOSED" ||
    state === "CAMERA_OFF"
  );
}

/**
 * Video analysis scheduler.
 *
 * Face inference is the expensive resource in this system (~1.9 s/face on CPU,
 * far less on a GPU but never free), so the scheduler's job is to spend it where
 * it changes an organizer's decision. It answers one question:
 *
 *     "Of these 200 participants, who should the analysis worker look at next?"
 *
 * It is a pure function of participant state + config. The worker that actually
 * pulls frames — the Meeting-SDK bot on a GPU host, or the browser in
 * development — polls `GET /meetings/:id/analysis/plan` and follows the answer.
 * That keeps GPU work off Cloudflare Workers (§52) while leaving the policy in
 * one testable place.
 */
import { tierFps, tierIntervalSec, type MeetingMonitoringConfig } from "../monitoring/config";
import { identityRisk, stateRisk, type AnalysisTier } from "../monitoring/signals";
import { PriorityQueue } from "./priority-queue";
import type { ParticipantState } from "./participant-state";

/** A participant is "newly joined" — and so worth a close look — for this long. */
export const NEW_PARTICIPANT_MS = 30_000;
/** A state that changed this recently keeps the participant warm. */
export const RECENT_CHANGE_MS = 20_000;

export interface ScheduleEntry {
  participantId: string;
  tier: AnalysisTier;
  priority: number;
  /** Seconds the worker should wait before analysing this participant again. */
  intervalSec: number;
  /** Frames per second to sample while analysing. */
  fps: number;
  /** Earliest instant this participant is due. */
  dueAt: number;
  /** How overdue the participant is, in ms; 0 when not yet due. */
  overdueMs: number;
  reason: string;
}

/**
 * Assigns a tier.
 *
 * HOT is for participants whose state is either unknown or actively wrong;
 * WARM for ones that just changed or are going stale; NORMAL for the steady
 * majority. Getting this split right is what lets one GPU cover a large meeting:
 * in a healthy 200-person session almost everyone is NORMAL.
 */
export function classifyTier(
  state: ParticipantState,
  config: MeetingMonitoringConfig,
  now: number,
): { tier: AnalysisTier; reason: string } {
  if (state.leftAt) return { tier: "NORMAL", reason: "participant has left" };

  const age = state.joinedAt == null ? Number.POSITIVE_INFINITY : now - state.joinedAt;
  if (age < NEW_PARTICIPANT_MS) return { tier: "HOT", reason: "newly joined" };

  if (config.identityVerificationEnabled) {
    if (state.identityStatus === "MISMATCH") return { tier: "HOT", reason: "identity mismatch" };
    if (state.identityStatus === "UNVERIFIED" || state.identityStatus === "UNKNOWN") {
      return { tier: "HOT", reason: "identity not established" };
    }
  }

  switch (state.currentState) {
    case "IDENTITY_MISMATCH":
      return { tier: "HOT", reason: "identity mismatch" };
    case "MULTIPLE_FACES":
      return { tier: "HOT", reason: "multiple faces" };
    case "FACE_NOT_VISIBLE":
      return { tier: "HOT", reason: "face not visible" };
    default:
      break;
  }

  // A prolonged screen-away is a live concern; a brief one is not.
  const stateAge = now - state.currentStateSince;
  if (
    (state.currentState === "LOOKING_LEFT" ||
      state.currentState === "LOOKING_RIGHT" ||
      state.currentState === "LOOKING_UP" ||
      state.currentState === "LOOKING_DOWN") &&
    stateAge >= config.screenAwaySec * 1000
  ) {
    return { tier: "HOT", reason: "prolonged screen-away" };
  }

  // A camera that is off yields no frames; analysing it harder is pure waste.
  if (state.currentState === "CAMERA_OFF") return { tier: "NORMAL", reason: "camera off" };

  if (state.pendingState) return { tier: "WARM", reason: "state change in progress" };
  if (stateAge < RECENT_CHANGE_MS) return { tier: "WARM", reason: "recently changed" };
  if (state.currentState === "LOW_CONFIDENCE" || (state.analysisConfidence ?? 1) < 0.5) {
    return { tier: "WARM", reason: "low confidence" };
  }

  const staleAfter = tierIntervalSec(config, "NORMAL") * 2000;
  if (state.lastAnalyzedAt == null || now - state.lastAnalyzedAt > staleAfter) {
    return { tier: "WARM", reason: "analysis going stale" };
  }

  return { tier: "NORMAL", reason: "stable" };
}

const TIER_BASE: Record<AnalysisTier, number> = { HOT: 10_000, WARM: 5_000, NORMAL: 1_000 };

/**
 * Priority within a tier.
 *
 * The explicit ordering from §6 — new participant > identity unverified >
 * mismatch > face disappeared > multiple faces > prolonged screen-away > stale
 * > stable — falls out of the sum below, with staleness as the tie-breaker so
 * nobody is starved indefinitely by a permanently unhappy neighbour.
 */
export function priorityOf(
  state: ParticipantState,
  config: MeetingMonitoringConfig,
  tier: AnalysisTier,
  now: number,
): number {
  let score = TIER_BASE[tier];

  const age = state.joinedAt == null ? Number.POSITIVE_INFINITY : now - state.joinedAt;
  if (age < NEW_PARTICIPANT_MS) score += 500;

  score += identityRisk(state.identityStatus) * 3;
  score += stateRisk(state.currentState) * 2;

  const dueAt = nextDueAt(state, config, tier);
  const overdue = Math.max(0, now - dueAt);
  // Cap staleness so an hour-old row cannot outrank a live identity mismatch.
  score += Math.min(overdue / 1000, 120);

  if (state.leftAt) score -= 5_000;
  if (state.currentState === "CAMERA_OFF") score -= 200;

  return Math.round(score);
}

/** When this participant next becomes eligible for analysis. */
export function nextDueAt(
  state: ParticipantState,
  config: MeetingMonitoringConfig,
  tier: AnalysisTier,
): number {
  if (state.lastAnalyzedAt == null) return state.joinedAt ?? 0;
  return state.lastAnalyzedAt + tierIntervalSec(config, tier) * 1000;
}

export interface PlanOptions {
  now?: number;
  /** Maximum participants the worker can analyse this round. */
  limit?: number;
  /** Include participants that are not yet due (useful for a full ranking). */
  includeNotDue?: boolean;
}

/**
 * Produces the ordered work list for one scheduling round.
 *
 * Returned in strict priority order, capped at `limit`, and — unless
 * `includeNotDue` — filtered to participants that are actually due, so a worker
 * polling every second does not re-analyse a stable participant 10× per interval.
 */
export function buildPlan(
  states: ParticipantState[],
  config: MeetingMonitoringConfig,
  options: PlanOptions = {},
): ScheduleEntry[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 25;
  const queue = new PriorityQueue<ScheduleEntry>();

  for (const state of states) {
    if (state.leftAt) continue;
    const { tier, reason } = classifyTier(state, config, now);
    const dueAt = nextDueAt(state, config, tier);
    if (!options.includeNotDue && dueAt > now) continue;

    const priority = priorityOf(state, config, tier, now);
    queue.push(
      {
        participantId: state.participantId,
        tier,
        priority,
        intervalSec: tierIntervalSec(config, tier),
        fps: tierFps(config, tier),
        dueAt,
        overdueMs: Math.max(0, now - dueAt),
        reason,
      },
      priority,
    );
  }

  return queue.take(limit);
}

/**
 * Re-tiers every participant without producing a work list — used when the
 * dashboard wants to show why someone is being watched closely.
 */
export function tierMap(
  states: ParticipantState[],
  config: MeetingMonitoringConfig,
  now: number = Date.now(),
): Map<string, { tier: AnalysisTier; reason: string; nextAnalysisAt: number }> {
  const out = new Map<string, { tier: AnalysisTier; reason: string; nextAnalysisAt: number }>();
  for (const state of states) {
    const { tier, reason } = classifyTier(state, config, now);
    out.set(state.participantId, { tier, reason, nextAnalysisAt: nextDueAt(state, config, tier) });
  }
  return out;
}

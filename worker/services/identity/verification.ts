/**
 * Identity verification policy.
 *
 * Recognition is the most expensive call in the pipeline, so a verified
 * identity is cached — but a cache that never invalidates is how a system ends
 * up confidently labelling the wrong person. This module owns both halves:
 * how long a verification is trusted, and exactly what voids it (§9).
 *
 * The comparison itself is not here. Templates never leave the server, and the
 * matching maths already lives in `worker/lib/faces.ts` — this module only
 * decides *when* to ask and *what the answer means*.
 */
import type { MeetingMonitoringConfig } from "../monitoring/config";
import type { IdentityStatus } from "../monitoring/signals";
import type { ParticipantState } from "../analysis/participant-state";

export type VerificationTrigger = "JOIN" | "RETURN" | "PERIODIC" | "FACE_CHANGE" | "MANUAL";

export interface IdentityMatch {
  traineeId: string;
  name?: string;
  score: number;
}

export interface IdentityDecision {
  status: IdentityStatus;
  confidence: number | null;
  traineeId: string | null;
  verifiedAt: number;
  /** Null when the result is not cacheable (a mismatch must be re-checked). */
  expiresAt: number | null;
  reason: string;
}

export interface ReverifyInput {
  state: ParticipantState;
  config: MeetingMonitoringConfig;
  now: number;
  /** Signals from the current observation that can void a cached identity. */
  faceCount?: number;
  cameraJustTurnedOn?: boolean;
  rejoined?: boolean;
  faceAbsentMs?: number;
}

export interface ReverifyDecision {
  verify: boolean;
  trigger: VerificationTrigger;
  reason: string;
}

/**
 * Should we re-run recognition for this participant right now?
 *
 * Ordered by how strongly each condition implies the cached answer is stale:
 * an explicit rejoin or a second face beats a timer every time.
 */
export function shouldReverify(input: ReverifyInput): ReverifyDecision {
  const { state, config, now } = input;

  if (!config.identityVerificationEnabled) {
    return { verify: false, trigger: "PERIODIC", reason: "identity verification disabled" };
  }
  if (state.leftAt) {
    return { verify: false, trigger: "PERIODIC", reason: "participant has left" };
  }
  if (input.rejoined) {
    return { verify: true, trigger: "RETURN", reason: "participant left and rejoined" };
  }
  if (state.identityStatus === "UNKNOWN" || state.identityVerifiedAt == null) {
    return { verify: true, trigger: "JOIN", reason: "no identity established yet" };
  }
  if ((input.faceCount ?? state.faceCount) >= 2) {
    return { verify: true, trigger: "FACE_CHANGE", reason: "multiple people appeared" };
  }
  if (input.cameraJustTurnedOn) {
    return { verify: true, trigger: "RETURN", reason: "camera source changed" };
  }
  if ((input.faceAbsentMs ?? 0) >= config.longAbsenceSec * 1000) {
    return { verify: true, trigger: "RETURN", reason: "face absent for a long period" };
  }
  if (
    state.identityConfidence != null &&
    state.identityConfidence < config.identityConfidenceThreshold
  ) {
    return { verify: true, trigger: "PERIODIC", reason: "confidence below threshold" };
  }
  if (state.identityStatus === "MISMATCH") {
    // A mismatch is never cached: it must be re-tested until it clears or a
    // human resolves it.
    return { verify: true, trigger: "PERIODIC", reason: "previous result was a mismatch" };
  }
  if (state.identityExpiresAt != null && now >= state.identityExpiresAt) {
    return { verify: true, trigger: "PERIODIC", reason: "cached verification expired" };
  }

  return { verify: false, trigger: "PERIODIC", reason: "cached verification still valid" };
}

/**
 * Interprets a 1:N identify result.
 *
 * `expected` is the trainee the roster says should be in this seat. When we
 * have one, recognising somebody *else* is a mismatch — which is a far stronger
 * claim than "not recognised", and is graded separately.
 */
export function decideIdentity(
  best: IdentityMatch | null,
  config: MeetingMonitoringConfig,
  now: number,
  trigger: VerificationTrigger,
  context: { faceCount?: number; faceDetected?: boolean; expectedTraineeId?: string | null } = {},
): IdentityDecision {
  const cacheMs = config.identityCacheSec * 1000;

  if (context.faceDetected === false) {
    return {
      status: "NO_FACE",
      confidence: null,
      traineeId: null,
      verifiedAt: now,
      expiresAt: null,
      reason: `${trigger}: no face in frame`,
    };
  }
  if ((context.faceCount ?? 1) >= 2) {
    return {
      status: "MULTIPLE_FACES",
      confidence: best?.score ?? null,
      traineeId: null,
      verifiedAt: now,
      expiresAt: null,
      reason: `${trigger}: more than one face in frame`,
    };
  }
  if (!best) {
    return {
      status: "UNVERIFIED",
      confidence: null,
      traineeId: null,
      verifiedAt: now,
      expiresAt: null,
      reason: `${trigger}: no enrolled template matched`,
    };
  }

  const expected = context.expectedTraineeId ?? null;
  const clears = best.score >= config.identityConfidenceThreshold;

  if (expected && best.traineeId !== expected && clears) {
    return {
      status: "MISMATCH",
      confidence: best.score,
      traineeId: best.traineeId,
      verifiedAt: now,
      expiresAt: null,
      reason: `${trigger}: recognised a different enrolled person`,
    };
  }
  if (!clears) {
    // Below threshold is "we could not confirm", never "it is somebody else".
    return {
      status: best.score >= config.lowConfidenceThreshold ? "UNVERIFIED" : "LOW_CONFIDENCE",
      confidence: best.score,
      traineeId: null,
      verifiedAt: now,
      expiresAt: null,
      reason: `${trigger}: below the confidence threshold`,
    };
  }

  return {
    status: "VERIFIED",
    confidence: best.score,
    traineeId: best.traineeId,
    verifiedAt: now,
    expiresAt: now + cacheMs,
    reason: `${trigger}: matched an enrolled template`,
  };
}

/** True when the new decision is materially different and worth recording. */
export function isIdentityChange(
  previous: Pick<ParticipantState, "identityStatus" | "identityTraineeId">,
  decision: IdentityDecision,
): boolean {
  return (
    previous.identityStatus !== decision.status ||
    (decision.traineeId ?? null) !== (previous.identityTraineeId ?? null)
  );
}

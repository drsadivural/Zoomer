/**
 * Participant state service.
 *
 * Pure reducer: (previous state, one observation, config) → (next state, what
 * changed). Nothing here touches the database, so the whole engagement model is
 * unit-testable and the same code can run in the Worker, in a test, or in the
 * development simulator.
 */
import { headState, headStateToEngagement, normalizeHeadPose, type HeadPose } from "../gaze/head-pose";
import { smoothScreenFacing } from "../gaze/screen-facing";
import type { MeetingMonitoringConfig } from "../monitoring/config";
import type { AnalysisTier, EngagementState, IdentityStatus } from "../monitoring/signals";

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalised output of one analysis pass over one participant's video. */
export interface AnalysisObservation {
  observedAt: number;
  faceDetected: boolean;
  faceCount: number;
  detectionConfidence?: number | null;
  /** Normalised 0..1 coordinates, so the overlay is resolution-independent. */
  faceBox?: FaceBox | null;
  pose?: Partial<HeadPose> | null;
  gazeHorizontal?: number | null;
  gazeVertical?: number | null;
  /** True when the provider judged the eyes shut in this frame. */
  eyeClosed?: boolean | null;
  /** 0..1 eye openness, higher is more open. Null if not measurable. */
  eyeOpenness?: number | null;
  identityStatus?: IdentityStatus | null;
  identityConfidence?: number | null;
  identityTraineeId?: string | null;
  cameraOn?: boolean | null;
  microphoneOn?: boolean | null;
  speaking?: boolean | null;
  source?: "BOT" | "BROWSER" | "SIMULATION" | "MANUAL";
}

/** The live state the organizer dashboard renders (§13). */
export interface ParticipantState {
  participantId: string;
  sessionId: string;
  displayName: string | null;

  joinedAt: number | null;
  leftAt: number | null;

  cameraOn: boolean;
  microphoneOn: boolean;
  speaking: boolean;
  speakingMs: number;
  speakingTurns: number;
  lastSpokeAt: number | null;

  faceDetected: boolean;
  faceCount: number;
  faceBox: FaceBox | null;

  identityStatus: IdentityStatus;
  identityConfidence: number | null;
  identityTraineeId: string | null;
  identityVerifiedAt: number | null;
  identityExpiresAt: number | null;

  headYaw: number | null;
  headPitch: number | null;
  headRoll: number | null;
  headState: ReturnType<typeof headState>;

  eyeClosed: boolean;
  eyeOpenness: number | null;
  /** Start of the current unbroken run of closed eyes; null when open. */
  eyesClosedSince: number | null;

  screenFacingProbability: number | null;
  gazeHorizontal: number | null;
  gazeVertical: number | null;

  currentState: EngagementState;
  currentStateSince: number;
  pendingState: EngagementState | null;
  pendingStateSince: number | null;

  lastAnalyzedAt: number | null;
  analysisConfidence: number | null;
  analysisTier: AnalysisTier;
  nextAnalysisAt: number | null;
}

export function emptyParticipantState(
  participantId: string,
  sessionId: string,
  now: number,
  displayName: string | null = null,
): ParticipantState {
  return {
    participantId,
    sessionId,
    displayName,
    joinedAt: now,
    leftAt: null,
    cameraOn: false,
    microphoneOn: false,
    speaking: false,
    speakingMs: 0,
    speakingTurns: 0,
    lastSpokeAt: null,
    faceDetected: false,
    faceCount: 0,
    faceBox: null,
    identityStatus: "UNKNOWN",
    identityConfidence: null,
    identityTraineeId: null,
    identityVerifiedAt: null,
    identityExpiresAt: null,
    headYaw: null,
    headPitch: null,
    headRoll: null,
    headState: "UNKNOWN",
    eyeClosed: false,
    eyeOpenness: null,
    eyesClosedSince: null,
    screenFacingProbability: null,
    gazeHorizontal: null,
    gazeVertical: null,
    currentState: "UNKNOWN",
    currentStateSince: now,
    pendingState: null,
    pendingStateSince: null,
    lastAnalyzedAt: null,
    analysisConfidence: null,
    analysisTier: "HOT", // a participant we know nothing about is worth looking at
    nextAnalysisAt: now,
  };
}

/**
 * States that must not wait out the transient window.
 *
 * Camera on/off arrives as a discrete Zoom media event, not a noisy inference —
 * debouncing it would only make the dashboard lag reality. An identity mismatch
 * is the one signal an organizer must see immediately (§29).
 */
const IMMEDIATE: readonly EngagementState[] = ["CAMERA_OFF", "IDENTITY_MISMATCH"];

/**
 * The state this single observation argues for, before temporal persistence.
 *
 * Ordering is by how much the organizer needs to know it: an identity problem
 * outranks a head that is turned away, and a camera that is off outranks
 * everything because no other signal can be computed without a picture.
 */
export function deriveObservedState(
  observation: AnalysisObservation,
  config: MeetingMonitoringConfig,
  screenFacingProbability: number | null,
): EngagementState {
  if (observation.cameraOn === false) return "CAMERA_OFF";

  if (config.identityVerificationEnabled && observation.identityStatus === "MISMATCH") {
    return "IDENTITY_MISMATCH";
  }
  if (config.multiFaceEnabled && observation.faceCount >= 2) return "MULTIPLE_FACES";
  if (!observation.faceDetected) return "FACE_NOT_VISIBLE";

  // A face that is present but with closed eyes outranks head direction: the
  // organizer needs to know about it, and "looking down" would understate it.
  if (config.drowsinessEnabled && observation.eyeClosed === true) return "EYES_CLOSED";

  const confidence = observation.detectionConfidence ?? 1;
  if (confidence < config.lowConfidenceThreshold) return "LOW_CONFIDENCE";

  if (config.screenFacingEnabled && screenFacingProbability != null) {
    if (screenFacingProbability >= config.screenFacingThreshold) return "SCREEN_FACING";
  }

  if (config.headPoseEnabled) {
    const pose = normalizeHeadPose(observation.pose);
    const derived = headStateToEngagement(headState(pose, config));
    if (derived !== "UNKNOWN") return derived;
  }

  // Face is visible but we have no orientation evidence either way. Saying
  // "screen facing" here would be a guess dressed up as a measurement.
  return config.screenFacingEnabled || config.headPoseEnabled ? "UNKNOWN" : "SCREEN_FACING";
}

export interface StateChange {
  from: EngagementState;
  to: EngagementState;
  /** When the new state actually began, not when we committed to it. */
  since: number;
  /** How long the state it replaced had been running. */
  previousDurationMs: number;
}

export interface ReduceResult {
  next: ParticipantState;
  change: StateChange | null;
  /** True when this observation started a new speaking turn. */
  startedSpeaking: boolean;
}

/**
 * Applies one observation.
 *
 * Temporal persistence (§12) lives here: a candidate state must hold for
 * `transientSec` before it replaces the committed one, and when it does, the
 * committed state is back-dated to when the candidate first appeared — so a
 * "face missing for 30s" duration means 30 seconds of missing face, not 30
 * seconds since we made up our mind.
 */
export function reduceParticipantState(
  previous: ParticipantState,
  observation: AnalysisObservation,
  config: MeetingMonitoringConfig,
  now: number = observation.observedAt,
): ReduceResult {
  const pose = normalizeHeadPose(observation.pose);

  const facing =
    config.screenFacingEnabled
      ? smoothScreenFacing(previous.screenFacingProbability, {
          pose,
          gazeHorizontal: observation.gazeHorizontal ?? null,
          gazeVertical: observation.gazeVertical ?? null,
          detectionConfidence: observation.detectionConfidence ?? null,
          faceDetected: observation.faceDetected,
        })
      : null;

  const observed = deriveObservedState(observation, config, facing?.screenFacingProbability ?? null);

  let currentState = previous.currentState;
  let currentStateSince = previous.currentStateSince;
  let pendingState = previous.pendingState;
  let pendingStateSince = previous.pendingStateSince;
  let change: StateChange | null = null;

  const commit = (to: EngagementState, since: number) => {
    change = {
      from: currentState,
      to,
      since,
      previousDurationMs: Math.max(0, since - currentStateSince),
    };
    currentState = to;
    currentStateSince = since;
    pendingState = null;
    pendingStateSince = null;
  };

  if (observed === currentState) {
    pendingState = null;
    pendingStateSince = null;
  } else if (IMMEDIATE.includes(observed)) {
    commit(observed, now);
  } else if (pendingState !== observed) {
    pendingState = observed;
    pendingStateSince = now;
  } else if (now - (pendingStateSince ?? now) >= config.transientSec * 1000) {
    commit(observed, pendingStateSince ?? now);
  }

  // Eye state: keep the start of the current closed run so the event engine can
  // measure how long the eyes have actually been shut, independent of when the
  // engagement state was committed.
  const eyeClosed = observation.eyeClosed ?? previous.eyeClosed;
  const eyesClosedSince = !eyeClosed
    ? null
    : previous.eyeClosed && previous.eyesClosedSince != null
      ? previous.eyesClosedSince
      : now;

  const wasSpeaking = previous.speaking;
  const speaking = observation.speaking ?? previous.speaking;
  const startedSpeaking = Boolean(config.participationAnalyticsEnabled && speaking && !wasSpeaking);
  // Credit the gap between analyses to the turn that was already running: with
  // sampled analysis it is the only defensible attribution.
  const speakingDelta =
    config.participationAnalyticsEnabled && wasSpeaking && previous.lastAnalyzedAt
      ? Math.max(0, Math.min(now - previous.lastAnalyzedAt, 60_000))
      : 0;

  const next: ParticipantState = {
    ...previous,
    cameraOn: observation.cameraOn ?? previous.cameraOn,
    microphoneOn: observation.microphoneOn ?? previous.microphoneOn,
    speaking,
    speakingMs: previous.speakingMs + speakingDelta,
    speakingTurns: previous.speakingTurns + (startedSpeaking ? 1 : 0),
    lastSpokeAt: speaking ? now : previous.lastSpokeAt,

    faceDetected: observation.faceDetected,
    faceCount: observation.faceCount,
    faceBox: observation.faceBox ?? (observation.faceDetected ? previous.faceBox : null),

    identityStatus: observation.identityStatus ?? previous.identityStatus,
    identityConfidence: observation.identityConfidence ?? previous.identityConfidence,
    identityTraineeId: observation.identityTraineeId ?? previous.identityTraineeId,

    headYaw: pose?.yaw ?? previous.headYaw,
    headPitch: pose?.pitch ?? previous.headPitch,
    headRoll: pose?.roll ?? previous.headRoll,
    headState: config.headPoseEnabled ? headState(pose, config) : previous.headState,

    eyeClosed,
    eyeOpenness: observation.eyeOpenness ?? previous.eyeOpenness,
    eyesClosedSince,

    screenFacingProbability: facing?.screenFacingProbability ?? previous.screenFacingProbability,
    gazeHorizontal: facing?.gazeHorizontal ?? previous.gazeHorizontal,
    gazeVertical: facing?.gazeVertical ?? previous.gazeVertical,

    currentState,
    currentStateSince,
    pendingState,
    pendingStateSince,

    lastAnalyzedAt: now,
    analysisConfidence: facing?.confidence ?? observation.detectionConfidence ?? previous.analysisConfidence,
  };

  return { next, change, startedSpeaking };
}

/** How long the participant has held their committed state. */
export function stateDurationMs(state: ParticipantState, now: number): number {
  return Math.max(0, now - state.currentStateSince);
}

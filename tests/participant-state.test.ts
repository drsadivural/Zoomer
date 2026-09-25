import { describe, expect, it } from "vitest";
import { DEFAULT_MEETING_CONFIG } from "../worker/services/monitoring/config";
import {
  deriveObservedState,
  emptyParticipantState,
  reduceParticipantState,
  type AnalysisObservation,
} from "../worker/services/analysis/participant-state";

const T0 = 1_760_000_000_000;
const config = { ...DEFAULT_MEETING_CONFIG };

function observation(at: number, patch: Partial<AnalysisObservation> = {}): AnalysisObservation {
  return {
    observedAt: at,
    faceDetected: true,
    faceCount: 1,
    detectionConfidence: 0.95,
    pose: { yaw: 0, pitch: 0, roll: 0 },
    cameraOn: true,
    ...patch,
  };
}

describe("deriveObservedState", () => {
  it("reports CAMERA_OFF before anything else, because nothing else is measurable", () => {
    const state = deriveObservedState(
      observation(T0, { cameraOn: false, faceDetected: false, faceCount: 0, identityStatus: "MISMATCH" }),
      config,
      null,
    );
    expect(state).toBe("CAMERA_OFF");
  });

  it("ranks an identity mismatch above a second face", () => {
    expect(
      deriveObservedState(observation(T0, { identityStatus: "MISMATCH", faceCount: 2 }), config, 0.9),
    ).toBe("IDENTITY_MISMATCH");
  });

  it("reports MULTIPLE_FACES when a second face appears", () => {
    expect(deriveObservedState(observation(T0, { faceCount: 2 }), config, 0.9)).toBe("MULTIPLE_FACES");
  });

  it("reports FACE_NOT_VISIBLE when the camera is on but no face is found", () => {
    expect(
      deriveObservedState(observation(T0, { faceDetected: false, faceCount: 0 }), config, 0),
    ).toBe("FACE_NOT_VISIBLE");
  });

  it("reports SCREEN_FACING once the smoothed probability clears the threshold", () => {
    expect(deriveObservedState(observation(T0), config, 0.91)).toBe("SCREEN_FACING");
  });

  it("falls back to head direction when the probability is below the threshold", () => {
    expect(
      deriveObservedState(observation(T0, { pose: { yaw: -40, pitch: 0, roll: 0 } }), config, 0.2),
    ).toBe("LOOKING_LEFT");
  });

  it("says UNKNOWN rather than guessing when no orientation evidence exists", () => {
    expect(deriveObservedState(observation(T0, { pose: null }), config, null)).toBe("UNKNOWN");
  });

  it("honours the multi-face feature flag", () => {
    const off = { ...config, multiFaceEnabled: false };
    expect(deriveObservedState(observation(T0, { faceCount: 3 }), off, 0.95)).toBe("SCREEN_FACING");
  });
});

describe("temporal persistence", () => {
  it("ignores a state that has not held for transientSec", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, {}), config, T0).next;
    state.currentState = "SCREEN_FACING";
    state.currentStateSince = T0;

    const gone = observation(T0 + 1000, { faceDetected: false, faceCount: 0, pose: null });
    const result = reduceParticipantState(state, gone, config, T0 + 1000);

    expect(result.next.currentState).toBe("SCREEN_FACING");
    expect(result.next.pendingState).toBe("FACE_NOT_VISIBLE");
    expect(result.change).toBeNull();
  });

  it("does not flip state on a single off-axis frame — smoothing absorbs it", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, {}), config, T0).next;
    state.currentState = "SCREEN_FACING";
    state.currentStateSince = T0;

    const glance = observation(T0 + 1000, { pose: { yaw: -45, pitch: 0, roll: 0 }, gazeHorizontal: -0.8 });
    const result = reduceParticipantState(state, glance, config, T0 + 1000);

    // One frame at 45° is a head turn during normal listening, not looking away:
    // the smoothed probability is still above the screen-facing threshold.
    expect(result.next.screenFacingProbability).toBeGreaterThan(config.screenFacingThreshold);
    expect(result.next.currentState).toBe("SCREEN_FACING");
    expect(result.next.pendingState).toBeNull();
  });

  it("does commit to looking away once the head stays turned", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, {}), config, T0).next;
    state.currentState = "SCREEN_FACING";
    state.currentStateSince = T0;

    let last = state;
    for (let i = 1; i <= 12; i++) {
      const at = T0 + i * 1000;
      last = reduceParticipantState(
        last,
        observation(at, { pose: { yaw: -55, pitch: 0, roll: 0 }, gazeHorizontal: -0.9 }),
        config,
        at,
      ).next;
    }
    expect(last.screenFacingProbability).toBeLessThan(config.screenFacingThreshold);
    expect(last.currentState).toBe("LOOKING_LEFT");
  });

  it("commits once the candidate has persisted, back-dated to when it started", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state.currentState = "SCREEN_FACING";
    state.currentStateSince = T0;
    state.screenFacingProbability = 0.95;

    const gone = (at: number) => observation(at, { faceDetected: false, faceCount: 0, pose: null });

    state = reduceParticipantState(state, gone(T0 + 1000), config, T0 + 1000).next;
    state = reduceParticipantState(state, gone(T0 + 2000), config, T0 + 2000).next;
    const result = reduceParticipantState(state, gone(T0 + 4500), config, T0 + 4500);

    expect(result.next.currentState).toBe("FACE_NOT_VISIBLE");
    // Back-dated to the first frame that argued for the new state, not to now —
    // so "missing for 30s" means 30 seconds of missing face.
    expect(result.next.currentStateSince).toBe(T0 + 1000);
    expect(result.change?.from).toBe("SCREEN_FACING");
    expect(result.change?.previousDurationMs).toBe(1000);
  });

  it("resets the candidate when the state flickers back", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state.currentState = "SCREEN_FACING";
    state.currentStateSince = T0;
    state.screenFacingProbability = 0.95;

    state = reduceParticipantState(
      state,
      observation(T0 + 1000, { faceDetected: false, faceCount: 0, pose: null }),
      config,
      T0 + 1000,
    ).next;
    expect(state.pendingState).toBe("FACE_NOT_VISIBLE");

    state = reduceParticipantState(state, observation(T0 + 2000), config, T0 + 2000).next;
    expect(state.pendingState).toBeNull();
    expect(state.currentState).toBe("SCREEN_FACING");
  });

  it("commits CAMERA_OFF immediately — it is a Zoom fact, not an inference", () => {
    const state = emptyParticipantState("sp_1", "ses_1", T0);
    state.currentState = "SCREEN_FACING";
    state.currentStateSince = T0;

    const result = reduceParticipantState(
      state,
      observation(T0 + 500, { cameraOn: false, faceDetected: false, faceCount: 0 }),
      config,
      T0 + 500,
    );
    expect(result.next.currentState).toBe("CAMERA_OFF");
    expect(result.change?.to).toBe("CAMERA_OFF");
  });

  it("commits an identity mismatch immediately", () => {
    const state = emptyParticipantState("sp_1", "ses_1", T0);
    state.currentState = "SCREEN_FACING";
    state.currentStateSince = T0;

    const result = reduceParticipantState(
      state,
      observation(T0 + 500, { identityStatus: "MISMATCH", identityConfidence: 0.9 }),
      config,
      T0 + 500,
    );
    expect(result.next.currentState).toBe("IDENTITY_MISMATCH");
  });
});

describe("participation analytics", () => {
  it("counts a speaking turn only on the transition into speaking", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, { speaking: true }), config, T0).next;
    expect(state.speakingTurns).toBe(1);

    state = reduceParticipantState(state, observation(T0 + 2000, { speaking: true }), config, T0 + 2000).next;
    expect(state.speakingTurns).toBe(1);

    state = reduceParticipantState(state, observation(T0 + 4000, { speaking: false }), config, T0 + 4000).next;
    state = reduceParticipantState(state, observation(T0 + 6000, { speaking: true }), config, T0 + 6000).next;
    expect(state.speakingTurns).toBe(2);
  });

  it("accumulates speaking time across sampled gaps", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, { speaking: true }), config, T0).next;
    state = reduceParticipantState(state, observation(T0 + 5000, { speaking: true }), config, T0 + 5000).next;
    expect(state.speakingMs).toBe(5000);
  });

  it("does not credit an implausible gap to one turn", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, { speaking: true }), config, T0).next;
    const hourLater = T0 + 3_600_000;
    state = reduceParticipantState(state, observation(hourLater, { speaking: true }), config, hourLater).next;
    expect(state.speakingMs).toBe(60_000);
  });

  it("stops counting when participation analytics are disabled", () => {
    const off = { ...config, participationAnalyticsEnabled: false };
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, { speaking: true }), off, T0).next;
    expect(state.speakingTurns).toBe(0);
  });
});

describe("observation merging", () => {
  it("keeps the last known face box only while a face is still detected", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    const box = { x: 0.3, y: 0.2, width: 0.2, height: 0.3 };
    state = reduceParticipantState(state, observation(T0, { faceBox: box }), config, T0).next;
    expect(state.faceBox).toEqual(box);

    state = reduceParticipantState(
      state,
      observation(T0 + 1000, { faceDetected: false, faceCount: 0, faceBox: null }),
      config,
      T0 + 1000,
    ).next;
    expect(state.faceBox).toBeNull();
  });

  it("leaves camera and mic state untouched when an observation omits them", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, { microphoneOn: true }), config, T0).next;
    state = reduceParticipantState(state, observation(T0 + 1000, { microphoneOn: null }), config, T0 + 1000).next;
    expect(state.microphoneOn).toBe(true);
  });
});

describe("eye state", () => {
  it("derives EYES_CLOSED from a closed-eye observation", () => {
    expect(deriveObservedState(observation(T0, { eyeClosed: true }), config, 0.95)).toBe("EYES_CLOSED");
  });

  it("ranks a missing face above closed eyes — no face means nothing to judge", () => {
    expect(
      deriveObservedState(observation(T0, { eyeClosed: true, faceDetected: false, faceCount: 0 }), config, 0),
    ).toBe("FACE_NOT_VISIBLE");
  });

  it("ranks an identity mismatch above closed eyes", () => {
    expect(
      deriveObservedState(observation(T0, { eyeClosed: true, identityStatus: "MISMATCH" }), config, 0.9),
    ).toBe("IDENTITY_MISMATCH");
  });

  it("treats 'not measured' as different from 'eyes open'", () => {
    // An absent eyeClosed must not be read as false and silently clear a
    // closed-eye run recorded by an earlier, better observation.
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, { eyeClosed: true }), config, T0).next;
    expect(state.eyeClosed).toBe(true);
    state = reduceParticipantState(state, observation(T0 + 1000, { eyeClosed: null }), config, T0 + 1000).next;
    expect(state.eyeClosed).toBe(true);
  });

  it("tracks when the closed run began, and clears it on reopening", () => {
    let state = emptyParticipantState("sp_1", "ses_1", T0);
    state = reduceParticipantState(state, observation(T0, { eyeClosed: true }), config, T0).next;
    expect(state.eyesClosedSince).toBe(T0);

    // The run start must not move while the eyes stay shut, or a long closure
    // would look perpetually fresh and never reach the gate.
    state = reduceParticipantState(state, observation(T0 + 5000, { eyeClosed: true }), config, T0 + 5000).next;
    expect(state.eyesClosedSince).toBe(T0);

    state = reduceParticipantState(state, observation(T0 + 9000, { eyeClosed: false }), config, T0 + 9000).next;
    expect(state.eyesClosedSince).toBeNull();
    expect(state.eyeClosed).toBe(false);
  });

  it("honours the drowsiness feature flag", () => {
    const off = { ...config, drowsinessEnabled: false };
    expect(deriveObservedState(observation(T0, { eyeClosed: true }), off, 0.95)).toBe("SCREEN_FACING");
  });
});

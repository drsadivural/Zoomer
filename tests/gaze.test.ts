import { describe, expect, it } from "vitest";
import { DEFAULT_MEETING_CONFIG } from "../worker/services/monitoring/config";
import { headState, headStateToEngagement, normalizeHeadPose } from "../worker/services/gaze/head-pose";
import {
  instantScreenFacing,
  ScreenFacingSmoother,
  smoothScreenFacing,
} from "../worker/services/gaze/screen-facing";

const config = { ...DEFAULT_MEETING_CONFIG };

describe("head pose normalisation", () => {
  it("rejects a pose with no usable angles", () => {
    expect(normalizeHeadPose(null)).toBeNull();
    expect(normalizeHeadPose({})).toBeNull();
    expect(normalizeHeadPose({ yaw: Number.NaN, pitch: 0 })).toBeNull();
  });

  it("clamps absurd angles instead of propagating them", () => {
    expect(normalizeHeadPose({ yaw: 400, pitch: -900, roll: 0 })).toEqual({ yaw: 90, pitch: -90, roll: 0 });
  });

  it("defaults roll to zero when a provider omits it", () => {
    expect(normalizeHeadPose({ yaw: 5, pitch: 5 })).toEqual({ yaw: 5, pitch: 5, roll: 0 });
  });
});

describe("head state bucketing", () => {
  it("calls a small angle FORWARD", () => {
    expect(headState({ yaw: 6, pitch: -4, roll: 1 }, config)).toBe("FORWARD");
  });

  it("uses the documented sign convention", () => {
    expect(headState({ yaw: 40, pitch: 0, roll: 0 }, config)).toBe("RIGHT");
    expect(headState({ yaw: -40, pitch: 0, roll: 0 }, config)).toBe("LEFT");
    expect(headState({ yaw: 0, pitch: 30, roll: 0 }, config)).toBe("UP");
    expect(headState({ yaw: 0, pitch: -40, roll: 0 }, config)).toBe("DOWN");
  });

  it("picks the axis that exceeds its threshold by the largest margin", () => {
    // Small yaw past its gate, large downward pitch: DOWN is the honest answer.
    expect(headState({ yaw: 26, pitch: -70, roll: 0 }, config)).toBe("DOWN");
  });

  it("returns UNKNOWN without a pose", () => {
    expect(headState(null, config)).toBe("UNKNOWN");
  });

  it("respects configured thresholds", () => {
    const strict = { ...config, yawThresholdDeg: 10 };
    expect(headState({ yaw: 15, pitch: 0, roll: 0 }, config)).toBe("FORWARD");
    expect(headState({ yaw: 15, pitch: 0, roll: 0 }, strict)).toBe("RIGHT");
  });

  it("maps directions to engagement states", () => {
    expect(headStateToEngagement("LEFT")).toBe("LOOKING_LEFT");
    expect(headStateToEngagement("FORWARD")).toBe("SCREEN_FACING");
    expect(headStateToEngagement("UNKNOWN")).toBe("UNKNOWN");
  });
});

describe("instantaneous screen-facing", () => {
  it("is zero with no face", () => {
    expect(instantScreenFacing({ pose: { yaw: 0, pitch: 0, roll: 0 }, faceDetected: false })).toBe(0);
    expect(instantScreenFacing({ pose: null, faceDetected: true })).toBe(0);
  });

  it("is near 1 head-on and falls off with angle", () => {
    const headOn = instantScreenFacing({ pose: { yaw: 0, pitch: 0, roll: 0 }, faceDetected: true });
    const off25 = instantScreenFacing({ pose: { yaw: 25, pitch: 0, roll: 0 }, faceDetected: true });
    const off70 = instantScreenFacing({ pose: { yaw: 70, pitch: 0, roll: 0 }, faceDetected: true });
    expect(headOn).toBeCloseTo(1, 3);
    expect(off25).toBeLessThan(headOn);
    expect(off25).toBeGreaterThan(0.85);
    expect(off70).toBeLessThan(0.4);
  });

  it("is symmetric in sign", () => {
    const left = instantScreenFacing({ pose: { yaw: -35, pitch: 0, roll: 0 }, faceDetected: true });
    const right = instantScreenFacing({ pose: { yaw: 35, pitch: 0, roll: 0 }, faceDetected: true });
    expect(left).toBeCloseTo(right, 6);
  });

  it("lets iris offset pull the estimate down even with a straight head", () => {
    const eyesOn = instantScreenFacing({
      pose: { yaw: 0, pitch: 0, roll: 0 },
      gazeHorizontal: 0,
      gazeVertical: 0,
      faceDetected: true,
    });
    const eyesAway = instantScreenFacing({
      pose: { yaw: 0, pitch: 0, roll: 0 },
      gazeHorizontal: 0.9,
      gazeVertical: 0,
      faceDetected: true,
    });
    expect(eyesAway).toBeLessThan(eyesOn);
    expect(eyesAway).toBeGreaterThanOrEqual(0);
  });

  it("stays within 0..1 for every input", () => {
    for (const yaw of [-90, -45, 0, 45, 90]) {
      for (const gaze of [-1, 0, 1]) {
        const v = instantScreenFacing({
          pose: { yaw, pitch: yaw / 2, roll: 0 },
          gazeHorizontal: gaze,
          faceDetected: true,
        });
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("temporal smoothing", () => {
  it("does not swing to the new value on a single frame", () => {
    const smoother = new ScreenFacingSmoother(0.95, 10);
    const result = smoother.push({ pose: { yaw: 80, pitch: 0, roll: 0 }, faceDetected: true });
    expect(result.screenFacingProbability).toBeLessThan(0.95);
    expect(result.screenFacingProbability).toBeGreaterThan(0.5);
  });

  it("converges when the new state persists", () => {
    const smoother = new ScreenFacingSmoother(0.95, 10);
    let value = 1;
    for (let i = 0; i < 20; i++) {
      value = smoother.push({ pose: { yaw: 85, pitch: 0, roll: 0 }, faceDetected: true })
        .screenFacingProbability;
    }
    expect(value).toBeLessThan(0.2);
  });

  it("grows confidence with sample count", () => {
    const smoother = new ScreenFacingSmoother();
    const first = smoother.push({ pose: { yaw: 0, pitch: 0, roll: 0 }, faceDetected: true, detectionConfidence: 1 });
    let last = first;
    for (let i = 0; i < 6; i++) {
      last = smoother.push({ pose: { yaw: 0, pitch: 0, roll: 0 }, faceDetected: true, detectionConfidence: 1 });
    }
    expect(last.confidence).toBeGreaterThan(first.confidence);
    expect(last.confidence).toBeLessThanOrEqual(1);
  });

  it("reports low confidence when detection is weak", () => {
    const result = smoothScreenFacing(0.8, {
      pose: { yaw: 0, pitch: 0, roll: 0 },
      faceDetected: true,
      detectionConfidence: 0.1,
    });
    expect(result.confidence).toBeLessThan(0.2);
  });

  it("starts from the instant value when there is no history", () => {
    const result = smoothScreenFacing(null, { pose: { yaw: 0, pitch: 0, roll: 0 }, faceDetected: true });
    expect(result.screenFacingProbability).toBeCloseTo(1, 2);
  });

  it("drives the probability to zero when the face disappears", () => {
    let value = 0.95;
    for (let i = 0; i < 15; i++) {
      value = smoothScreenFacing(value, { pose: null, faceDetected: false }).screenFacingProbability;
    }
    expect(value).toBeLessThan(0.05);
  });
});

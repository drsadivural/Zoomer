/**
 * Contract test for the Zoom Meeting-SDK bot's ingestion payload.
 *
 * The bot is C++ and its analysis sidecar is Python, so nothing the compiler or
 * the type-checker does can tell us that what it sends still matches what
 * `/bot/observe` accepts. This pins the shape from the other side: the fixtures
 * below are real output — captured from the analyzer running against real
 * photographs — assembled exactly as `buildObservation()` in
 * `zoom-bot/src/main.cpp` assembles it.
 *
 * If a field is renamed on either side of that boundary, this test fails
 * instead of a live meeting silently reporting nothing.
 */
import { describe, expect, it } from "vitest";
import { observationSchema } from "../worker/routes/bot";

/** Captured from `analyzer.py` on a photo of a person with their eyes shut. */
const EYES_CLOSED_ANALYSIS = {
  faceCount: 1,
  box: { x: 0.439, y: 0.6914, width: 0.1032, height: 0.1609 },
  yaw: -9.51,
  pitch: -11.89,
  roll: 0.76,
  eyeClosed: true,
  eyeOpenness: 0.1466,
};

/** Mirrors buildObservation() for a participant whose camera is on. */
function observationFromAnalysis(a: typeof EYES_CLOSED_ANALYSIS) {
  return {
    zoomUserId: "16778240",
    zoomUserName: "高橋 健太",
    observedAt: Date.now(),
    microphoneOn: true,
    speaking: false,
    cameraOn: true,
    faceCount: a.faceCount,
    faceDetected: a.faceCount > 0,
    faceBox: a.box,
    yaw: a.yaw,
    pitch: a.pitch,
    roll: a.roll,
    eyeClosed: a.eyeClosed,
    eyeOpenness: a.eyeOpenness,
    identityStatus: "UNVERIFIED" as const,
  };
}

describe("bot observation payload", () => {
  it("accepts a real analyzer result for a participant with eyes closed", () => {
    const parsed = observationSchema.parse(observationFromAnalysis(EYES_CLOSED_ANALYSIS));
    expect(parsed.eyeClosed).toBe(true);
    expect(parsed.faceBox).toEqual(EYES_CLOSED_ANALYSIS.box);
    // The whole drowsiness feature depends on this one boolean surviving the
    // Python -> C++ -> HTTP -> zod journey intact.
    expect(parsed.eyeOpenness).toBeCloseTo(0.1466, 4);
  });

  it("accepts the camera-off observation, which carries no face data at all", () => {
    const parsed = observationSchema.parse({
      zoomUserId: "16778241",
      zoomUserName: "渡辺 蓮",
      observedAt: Date.now(),
      microphoneOn: true,
      speaking: false,
      cameraOn: false,
      faceDetected: false,
      faceCount: 0,
      identityStatus: "UNKNOWN",
    });
    expect(parsed.cameraOn).toBe(false);
    expect(parsed.faceCount).toBe(0);
  });

  it("accepts the leave observation the bot sends once a participant drops", () => {
    const parsed = observationSchema.parse({
      zoomUserId: "16778242",
      zoomUserName: "佐藤 美咲",
      observedAt: Date.now(),
      left: true,
      faceDetected: false,
      faceCount: 0,
      cameraOn: false,
    });
    expect(parsed.left).toBe(true);
  });

  it("accepts a verified identity with its confidence", () => {
    const parsed = observationSchema.parse({
      ...observationFromAnalysis(EYES_CLOSED_ANALYSIS),
      identityStatus: "VERIFIED",
      traineeId: "trn_01ABC",
      identityConfidence: 0.7412,
    });
    expect(parsed.identityStatus).toBe("VERIFIED");
    expect(parsed.traineeId).toBe("trn_01ABC");
  });

  it("rejects pose angles outside the documented degree range", () => {
    // Guards the analyzer's Euler decomposition: an unwrapped angle used to come
    // back as ~180 on a perfectly frontal face, which is both wrong and out of
    // contract. Better to fail loudly at the boundary than to record it.
    expect(() =>
      observationSchema.parse({ ...observationFromAnalysis(EYES_CLOSED_ANALYSIS), yaw: 361 }),
    ).toThrow();
  });

  it("rejects a normalised face box that is not normalised", () => {
    expect(() =>
      observationSchema.parse({
        ...observationFromAnalysis(EYES_CLOSED_ANALYSIS),
        faceBox: { x: 320, y: 240, width: 120, height: 160 },
      }),
    ).toThrow();
  });

  it("treats an unmeasured eye state as absent, not as open", () => {
    // `eyeClosed` omitted must stay omitted: the pipeline distinguishes "not
    // measured" from "measured open", and collapsing the two would make every
    // camera-off participant look wide awake.
    const parsed = observationSchema.parse({
      zoomUserId: "16778243",
      observedAt: Date.now(),
      faceDetected: true,
      faceCount: 1,
    });
    expect(parsed.eyeClosed).toBeUndefined();
  });
});

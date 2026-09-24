import { describe, expect, it } from "vitest";
import { DEFAULT_MEETING_CONFIG } from "../worker/services/monitoring/config";
import { emptyParticipantState, type ParticipantState } from "../worker/services/analysis/participant-state";
import {
  decideIdentity,
  isIdentityChange,
  shouldReverify,
} from "../worker/services/identity/verification";

const T0 = 1_760_000_000_000;
const config = { ...DEFAULT_MEETING_CONFIG };

function verified(patch: Partial<ParticipantState> = {}): ParticipantState {
  return {
    ...emptyParticipantState("sp_1", "ses_1", T0 - 600_000),
    identityStatus: "VERIFIED",
    identityConfidence: 0.94,
    identityTraineeId: "trn_1",
    identityVerifiedAt: T0 - 60_000,
    identityExpiresAt: T0 + 540_000,
    faceCount: 1,
    ...patch,
  };
}

describe("re-verification policy", () => {
  it("trusts a fresh cached verification", () => {
    expect(shouldReverify({ state: verified(), config, now: T0 }).verify).toBe(false);
  });

  it("re-verifies once the cache expires", () => {
    const d = shouldReverify({ state: verified({ identityExpiresAt: T0 - 1 }), config, now: T0 });
    expect(d).toMatchObject({ verify: true, trigger: "PERIODIC" });
  });

  it("re-verifies a participant who left and rejoined", () => {
    const d = shouldReverify({ state: verified(), config, now: T0, rejoined: true });
    expect(d).toMatchObject({ verify: true, trigger: "RETURN" });
  });

  it("re-verifies when a second face appears", () => {
    const d = shouldReverify({ state: verified(), config, now: T0, faceCount: 2 });
    expect(d).toMatchObject({ verify: true, trigger: "FACE_CHANGE" });
  });

  it("re-verifies when the camera source changes", () => {
    const d = shouldReverify({ state: verified(), config, now: T0, cameraJustTurnedOn: true });
    expect(d).toMatchObject({ verify: true, trigger: "RETURN" });
  });

  it("re-verifies after a long absence", () => {
    const d = shouldReverify({
      state: verified(),
      config,
      now: T0,
      faceAbsentMs: config.longAbsenceSec * 1000 + 1,
    });
    expect(d.verify).toBe(true);
  });

  it("never caches a mismatch", () => {
    const d = shouldReverify({ state: verified({ identityStatus: "MISMATCH" }), config, now: T0 });
    expect(d.verify).toBe(true);
  });

  it("re-verifies when the cached confidence is below the threshold", () => {
    const d = shouldReverify({ state: verified({ identityConfidence: 0.6 }), config, now: T0 });
    expect(d.verify).toBe(true);
  });

  it("verifies a participant with no identity yet", () => {
    const d = shouldReverify({
      state: { ...verified(), identityStatus: "UNKNOWN", identityVerifiedAt: null },
      config,
      now: T0,
    });
    expect(d).toMatchObject({ verify: true, trigger: "JOIN" });
  });

  it("does nothing once the participant has left", () => {
    expect(shouldReverify({ state: verified({ leftAt: T0 - 1 }), config, now: T0 }).verify).toBe(false);
  });

  it("does nothing when identity verification is switched off", () => {
    const off = { ...config, identityVerificationEnabled: false };
    expect(shouldReverify({ state: verified({ identityStatus: "UNKNOWN" }), config: off, now: T0 }).verify).toBe(
      false,
    );
  });
});

describe("identity decisions", () => {
  it("verifies a clear match and caches it", () => {
    const d = decideIdentity({ traineeId: "trn_1", score: 0.93 }, config, T0, "JOIN", {
      faceDetected: true,
      faceCount: 1,
    });
    expect(d.status).toBe("VERIFIED");
    expect(d.expiresAt).toBe(T0 + config.identityCacheSec * 1000);
  });

  it("calls a below-threshold score UNVERIFIED, never a mismatch", () => {
    const d = decideIdentity({ traineeId: "trn_1", score: 0.7 }, config, T0, "PERIODIC", {
      faceDetected: true,
      faceCount: 1,
      expectedTraineeId: "trn_2",
    });
    expect(d.status).toBe("UNVERIFIED");
    expect(d.expiresAt).toBeNull();
  });

  it("reports LOW_CONFIDENCE when the score is very weak", () => {
    const d = decideIdentity({ traineeId: "trn_1", score: 0.2 }, config, T0, "PERIODIC", {
      faceDetected: true,
      faceCount: 1,
    });
    expect(d.status).toBe("LOW_CONFIDENCE");
  });

  it("reports MISMATCH only when a DIFFERENT person clears the threshold", () => {
    const d = decideIdentity({ traineeId: "trn_9", score: 0.95 }, config, T0, "PERIODIC", {
      faceDetected: true,
      faceCount: 1,
      expectedTraineeId: "trn_1",
    });
    expect(d.status).toBe("MISMATCH");
    expect(d.traineeId).toBe("trn_9");
    expect(d.expiresAt).toBeNull();
  });

  it("does not call an unexpected match a mismatch when no one is expected", () => {
    const d = decideIdentity({ traineeId: "trn_9", score: 0.95 }, config, T0, "JOIN", {
      faceDetected: true,
      faceCount: 1,
      expectedTraineeId: null,
    });
    expect(d.status).toBe("VERIFIED");
  });

  it("reports NO_FACE and MULTIPLE_FACES before looking at scores", () => {
    expect(decideIdentity(null, config, T0, "JOIN", { faceDetected: false }).status).toBe("NO_FACE");
    expect(
      decideIdentity({ traineeId: "trn_1", score: 0.99 }, config, T0, "JOIN", {
        faceDetected: true,
        faceCount: 3,
      }).status,
    ).toBe("MULTIPLE_FACES");
  });

  it("reports UNVERIFIED when nothing in the gallery matched", () => {
    const d = decideIdentity(null, config, T0, "JOIN", { faceDetected: true, faceCount: 1 });
    expect(d.status).toBe("UNVERIFIED");
  });

  it("carries the trigger into the reason, for the audit trail", () => {
    const d = decideIdentity({ traineeId: "trn_1", score: 0.95 }, config, T0, "RETURN", {
      faceDetected: true,
      faceCount: 1,
    });
    expect(d.reason).toContain("RETURN");
  });
});

describe("change detection", () => {
  it("spots a status change", () => {
    const decision = decideIdentity({ traineeId: "trn_1", score: 0.95 }, config, T0, "JOIN", {
      faceDetected: true,
      faceCount: 1,
    });
    expect(isIdentityChange({ identityStatus: "UNKNOWN", identityTraineeId: null }, decision)).toBe(true);
    expect(isIdentityChange({ identityStatus: "VERIFIED", identityTraineeId: "trn_1" }, decision)).toBe(false);
  });

  it("spots the same status attached to a different person", () => {
    const decision = decideIdentity({ traineeId: "trn_2", score: 0.95 }, config, T0, "JOIN", {
      faceDetected: true,
      faceCount: 1,
    });
    expect(isIdentityChange({ identityStatus: "VERIFIED", identityTraineeId: "trn_1" }, decision)).toBe(true);
  });
});

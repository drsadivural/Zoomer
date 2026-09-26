/**
 * The nine signals the organizer console reports per participant.
 *
 * The rule under test throughout: **a signal that was not measured must not
 * read as a measurement**. The console is used to justify attendance records,
 * so "瞬き 0.0 回/分" when nothing counted blinks is not a cosmetic bug — it is
 * fabricated evidence against a person. Every unmeasured signal must render
 * 未測定 / 未解析 / —, never a confident value.
 */
import { describe, expect, it } from "vitest";
import { participantSignals, SHARPNESS_UNRELIABLE } from "../src/lib/meeting/participant-signals";
import type { MeetingParticipant } from "../src/lib/api";

function participant(over: Partial<MeetingParticipant> = {}): MeetingParticipant {
  return {
    participantId: "pp_1",
    sessionId: "ses_1",
    displayName: "佐藤 花子",
    joinedAt: 1_000,
    leftAt: null,
    cameraOn: true,
    microphoneOn: true,
    speaking: false,
    speakingMs: 0,
    speakingTurns: 0,
    faceDetected: true,
    faceCount: 1,
    faceBox: null,
    identityStatus: "VERIFIED",
    identityConfidence: 0.91,
    headYaw: 2,
    headPitch: -1,
    headRoll: 0,
    headState: "FORWARD",
    eyeClosed: false,
    eyeOpenness: 0.8,
    eyesClosedSince: null,
    blinkRatePerMin: 14,
    blinkCount: 42,
    sharpness: 0.7,
    screenFacingProbability: 0.85,
    currentState: "SCREEN_FACING",
    currentStateSince: 1_000,
    lastAnalyzedAt: 2_000,
    analysisConfidence: 0.95,
    analysisTier: "NORMAL",
    thumbnailEvidenceId: null,
    thumbnailAt: null,
    traineeName: "佐藤 花子",
    externalId: "AZ-0001",
    department: null,
    participantStatus: "MONITORING",
    ...over,
  };
}

const by = (p: MeetingParticipant, key: string) => {
  const s = participantSignals(p).find((x) => x.key === key);
  if (!s) throw new Error(`no signal ${key}`);
  return s;
};

describe("participantSignals", () => {
  it("always returns the nine named signals, in a stable order", () => {
    // The grid puts the same signal in the same cell on every tile; an
    // organizer scanning twenty tiles reads by position, not by label.
    const keys = participantSignals(participant()).map((s) => s.key);
    expect(keys).toEqual([
      "face", "head", "eyes", "blink", "sharpness", "away", "multi", "drowsy", "identity",
    ]);
    // Still nine when nothing at all has been measured.
    expect(participantSignals(participant({ lastAnalyzedAt: null })).map((s) => s.key)).toEqual(keys);
  });

  describe("not measured is never reported as a value", () => {
    it("shows 未測定 for blink when the capture side does not count them", () => {
      const s = by(participant({ blinkRatePerMin: null }), "blink");
      expect(s.value).toBe("未測定");
      expect(s.tone).toBe("idle");
      expect(s.value).not.toMatch(/0/);
    });

    it("distinguishes a measured zero blink rate from an unmeasured one", () => {
      // Zero is a real, alarming reading — a held-up photograph does not blink.
      const measured = by(participant({ blinkRatePerMin: 0, blinkCount: 0 }), "blink");
      expect(measured.value).toBe("0.0 回/分");
      expect(measured.tone).toBe("warn");
    });

    it("shows 未測定 for sharpness when absent", () => {
      expect(by(participant({ sharpness: null }), "sharpness").value).toBe("未測定");
    });

    it("reports 未解析 rather than 'no face' before the first analysis", () => {
      // A participant who just joined has not been analysed. Saying 顔検出:
      // なし would raise an alert about someone nobody has looked at yet.
      const s = by(participant({ lastAnalyzedAt: null, faceDetected: false }), "face");
      expect(s.value).toBe("未解析");
      expect(s.tone).toBe("idle");
    });

    it("leaves pose and eye state blank when there is no face to measure them on", () => {
      const p = participant({ faceDetected: false, currentState: "FACE_NOT_VISIBLE" });
      expect(by(p, "head").value).toBe("—");
      expect(by(p, "eyes").value).toBe("—");
    });
  });

  describe("judgements come from the backend's committed state", () => {
    it("reports 居眠り疑い only once the backend has committed EYES_CLOSED", () => {
      // A single closed frame is a blink. The dwell threshold is the tenant's
      // and lives server-side; re-deciding here would contradict the audit log.
      const blinking = participant({ eyeClosed: true, currentState: "SCREEN_FACING" });
      expect(by(blinking, "drowsy").value).toBe("なし");
      expect(by(blinking, "eyes").value).toBe("閉");

      const committed = participant({ eyeClosed: true, currentState: "EYES_CLOSED" });
      expect(by(committed, "drowsy").value).toBe("疑いあり");
    });

    it("keeps 居眠り疑い a suspicion, never a finding", () => {
      const s = by(participant({ currentState: "EYES_CLOSED" }), "drowsy");
      expect(s.value).toContain("疑い");
      expect(s.detail).toContain("確認が必要");
      const text = `${s.value}${s.detail}`;
      // No psychological or disciplinary claim.
      expect(text).not.toMatch(/居眠り中|寝ている|集中|やる気|怠/);
      // 不合格 may appear only in the disclaimer that it does *not* follow.
      expect(text.replace("不合格としません", "")).not.toContain("不合格");
    });

    it("reads 離席 from the committed state", () => {
      expect(by(participant({ currentState: "FACE_NOT_VISIBLE" }), "away").value).toBe("可能性あり");
      expect(by(participant({ currentState: "SCREEN_FACING" }), "away").value).toBe("在席");
    });

    it("will not claim presence or absence while the camera is off", () => {
      // Camera off is not evidence of leaving the desk.
      const s = by(participant({ currentState: "CAMERA_OFF", cameraOn: false }), "away");
      expect(s.value).toBe("判定不可");
      expect(s.tone).toBe("idle");
    });

    it("marks a participant who has left rather than calling them absent", () => {
      expect(by(participant({ leftAt: 9_000 }), "away").value).toBe("退出済み");
    });
  });

  describe("tones", () => {
    it("flags an unreliable frame so the other readings are not trusted", () => {
      const bad = by(participant({ sharpness: SHARPNESS_UNRELIABLE - 0.01 }), "sharpness");
      expect(bad.tone).toBe("bad");
      expect(bad.detail).toContain("信頼度");

      expect(by(participant({ sharpness: 0.7 }), "sharpness").tone).toBe("ok");
    });

    it("treats an unusually low blink rate as worth a look", () => {
      expect(by(participant({ blinkRatePerMin: 2 }), "blink").tone).toBe("warn");
      expect(by(participant({ blinkRatePerMin: 15 }), "blink").tone).toBe("ok");
    });

    it("raises 複数人 and 他人検出 to the same severity as the state banner", () => {
      expect(by(participant({ faceCount: 3 }), "multi").tone).toBe("bad");
      expect(by(participant({ faceCount: 3 }), "multi").value).toBe("3人を検出");
      expect(by(participant({ identityStatus: "MISMATCH" }), "identity").tone).toBe("bad");
    });

    it("does not call an unverified participant an impostor", () => {
      // UNVERIFIED means nobody has checked, which is not a mismatch.
      const s = by(participant({ identityStatus: "UNVERIFIED", identityConfidence: null }), "identity");
      expect(s.value).toBe("未確認");
      expect(s.tone).toBe("idle");
      expect(by(participant({ identityStatus: "LOW_CONFIDENCE" }), "identity").value).toBe("判定保留");
    });
  });

  it("renders a head pose of zero as 0°, not -0°", () => {
    expect(by(participant({ headYaw: -0.2, headPitch: 0.1 }), "head").detail).toContain("左右 0°");
  });
});

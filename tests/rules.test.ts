import { describe, expect, it } from "vitest";
import {
  checkPlausibility, DEFAULT_RULES, evaluate, MAX_CLOCK_SKEW_MS, nextStatus,
  type MonitoringRules, type ParticipantStatus,
} from "../worker/lib/rules";

const rules: MonitoringRules = { ...DEFAULT_RULES, absenceSec: 60, eyesClosedSec: 10, multiFaceFrames: 15 };

describe("evaluate — 離席 (absence)", () => {
  it("stays a warning below the threshold and raises no alert", () => {
    const j = evaluate({ type: "FACE_ABSENT", capturedAt: Date.now(), durationMs: 30_000 }, rules);
    expect(j.severity).toBe("WARNING");
    expect(j.alertType).toBeNull();
    expect(j.evidenceRequired).toBe(false);
  });

  it("becomes an alert once the configured duration is exceeded", () => {
    const j = evaluate({ type: "FACE_ABSENT", capturedAt: Date.now(), durationMs: 62_000 }, rules);
    expect(j.severity).toBe("ALERT");
    expect(j.alertType).toBe("離席");
    expect(j.evidenceRequired).toBe(true);
    expect(j.detail).toContain("62秒");
  });

  it("fires exactly at the boundary", () => {
    const j = evaluate({ type: "FACE_ABSENT", capturedAt: Date.now(), durationMs: 60_000 }, rules);
    expect(j.severity).toBe("ALERT");
  });
});

describe("evaluate — 複数人 (multiple faces)", () => {
  it("needs sustained frames, not a single one", () => {
    const j = evaluate(
      { type: "MULTIPLE_FACES", capturedAt: Date.now(), faceCount: 2, frameCount: 3 },
      rules,
    );
    expect(j.alertType).toBeNull();
  });

  it("alerts after the frame threshold with two or more faces", () => {
    const j = evaluate(
      { type: "MULTIPLE_FACES", capturedAt: Date.now(), faceCount: 2, frameCount: 20 },
      rules,
    );
    expect(j.severity).toBe("ALERT");
    expect(j.alertType).toBe("複数人");
  });

  it("does not alert on sustained frames with only one face", () => {
    const j = evaluate(
      { type: "MULTIPLE_FACES", capturedAt: Date.now(), faceCount: 1, frameCount: 50 },
      rules,
    );
    expect(j.alertType).toBeNull();
  });
});

describe("evaluate — 居眠り疑い (drowsiness)", () => {
  it("never escalates past WARNING, even far beyond the threshold", () => {
    const j = evaluate({ type: "EYES_CLOSED", capturedAt: Date.now(), durationMs: 600_000 }, rules);
    // Policy: drowsiness is a suspicion a human must confirm.
    expect(j.severity).toBe("WARNING");
    expect(j.alertType).toBe("居眠り疑い");
    expect(j.summary).toContain("疑い");
  });

  it("raises nothing below the threshold", () => {
    const j = evaluate({ type: "EYES_CLOSED", capturedAt: Date.now(), durationMs: 4000 }, rules);
    expect(j.alertType).toBeNull();
  });
});

describe("evaluate — server overrides the client's claim", () => {
  it("flags an event whose claimed severity does not match the rules", () => {
    const j = evaluate(
      { type: "FACE_ABSENT", capturedAt: Date.now(), durationMs: 5000 },
      rules,
      "ALERT", // client over-claims
    );
    expect(j.severity).toBe("WARNING");
    expect(j.adjusted).toBe(true);
  });

  it("does not flag an agreeing claim", () => {
    const j = evaluate(
      { type: "FACE_ABSENT", capturedAt: Date.now(), durationMs: 90_000 },
      rules,
      "ALERT",
    );
    expect(j.adjusted).toBe(false);
  });
});

describe("checkPlausibility", () => {
  const now = Date.now();

  it("rejects future timestamps beyond tolerated skew", () => {
    const r = checkPlausibility({ type: "HEARTBEAT", capturedAt: now + MAX_CLOCK_SKEW_MS + 60_000 }, now, 0);
    expect(r.ok).toBe(false);
  });

  it("accepts timestamps inside tolerated skew", () => {
    const r = checkPlausibility({ type: "HEARTBEAT", capturedAt: now + 30_000 }, now, 0);
    expect(r.ok).toBe(true);
  });

  it("rejects events that are far too old to back-date", () => {
    const r = checkPlausibility({ type: "HEARTBEAT", capturedAt: now - 60 * 60 * 1000 }, now, 0);
    expect(r.ok).toBe(false);
  });

  it("quarantines rather than drops an impossible duration", () => {
    const r = checkPlausibility({ type: "FACE_ABSENT", capturedAt: now, durationMs: -5 }, now, 0);
    expect(r.ok).toBe(true);
    expect(r.quarantine).toBe(true);
  });

  it("quarantines an out-of-range match score", () => {
    const r = checkPlausibility({ type: "MATCH_OK", capturedAt: now, matchScore: 42 }, now, 0);
    expect(r.quarantine).toBe(true);
  });

  it("quarantines an event flood from one participant", () => {
    const r = checkPlausibility({ type: "HEARTBEAT", capturedAt: now }, now, 500);
    expect(r.quarantine).toBe(true);
  });
});

describe("nextStatus", () => {
  it("does not downgrade an ALERT on a routine heartbeat", () => {
    expect(nextStatus("ALERT", null)).toBe("ALERT");
    expect(nextStatus("ALERT", "VERIFIED")).toBe("ALERT");
  });

  it("lets a good match clear a transient warning", () => {
    expect(nextStatus("WARNING", "MONITORING")).toBe("MONITORING");
  });

  it("lets a reconnect clear a disconnect", () => {
    expect(nextStatus("DISCONNECTED", "MONITORING")).toBe("MONITORING");
  });

  it("keeps a reviewed decision sticky — only a human clears it", () => {
    (["ALERT", "WARNING", "MONITORING"] as ParticipantStatus[]).forEach((s) => {
      expect(nextStatus("REVIEWED", s)).toBe("REVIEWED");
    });
  });

  it("never reopens a completed session", () => {
    expect(nextStatus("COMPLETED", "ALERT")).toBe("COMPLETED");
  });

  it("escalates from monitoring to alert", () => {
    expect(nextStatus("MONITORING", "ALERT")).toBe("ALERT");
  });
});

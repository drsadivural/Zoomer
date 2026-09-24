import { describe, expect, it } from "vitest";
import { DEFAULT_MEETING_CONFIG } from "../worker/services/monitoring/config";
import { emptyParticipantState, type ParticipantState } from "../worker/services/analysis/participant-state";
import { evaluateParticipant, lifecycleEvent, needsAttention } from "../worker/services/events/event-engine";
import type { OpenEvent } from "../worker/services/events/deduplication";
import {
  dedupeKeyFor,
  indexOpenEvents,
  reopenCoolOffMs,
  shouldSuppressReopen,
} from "../worker/services/events/deduplication";
import { classifyDuration, gateEnabled, gateForState } from "../worker/services/events/thresholds";

const T0 = 1_760_000_000_000;
const config = { ...DEFAULT_MEETING_CONFIG };

function stateIn(
  current: ParticipantState["currentState"],
  heldSec: number,
  patch: Partial<ParticipantState> = {},
): ParticipantState {
  return {
    ...emptyParticipantState("sp_1", "ses_1", T0 - 600_000),
    currentState: current,
    currentStateSince: T0 - heldSec * 1000,
    analysisConfidence: 0.9,
    ...patch,
  };
}

const open = (type: string, startedAt: number): OpenEvent => ({
  id: `eng_${type}`,
  type: type as OpenEvent["type"],
  dedupeKey: type,
  startedAt,
  severity: "WARNING",
  occurrences: 1,
  escalated: false,
});

describe("thresholds", () => {
  it("maps each state to its gate", () => {
    expect(gateForState("FACE_NOT_VISIBLE", config)?.type).toBe("FACE_MISSING");
    expect(gateForState("CAMERA_OFF", config)?.type).toBe("CAMERA_OFF");
    expect(gateForState("MULTIPLE_FACES", config)?.type).toBe("MULTIPLE_FACES");
    expect(gateForState("LOOKING_DOWN", config)?.type).toBe("SCREEN_AWAY");
    expect(gateForState("IDENTITY_MISMATCH", config)?.gateSec).toBe(0);
  });

  it("raises nothing for a healthy participant", () => {
    expect(gateForState("SCREEN_FACING", config)).toBeNull();
    expect(gateForState("UNKNOWN", config)).toBeNull();
  });

  it("honours feature flags", () => {
    const gate = gateForState("MULTIPLE_FACES", config)!;
    expect(gateEnabled(gate, config)).toBe(true);
    expect(gateEnabled(gate, { ...config, multiFaceEnabled: false })).toBe(false);
  });

  it("classifies the four duration bands", () => {
    // gate 10s, prolonged 30s — the normal configuration, where all four bands exist.
    expect(classifyDuration(1_000, 10, config)).toBe("TRANSIENT");
    expect(classifyDuration(5_000, 10, config)).toBe("TEMPORARY");
    expect(classifyDuration(15_000, 10, config)).toBe("EVENT");
    expect(classifyDuration(120_000, 10, config)).toBe("PROLONGED");
  });

  it("keeps the EVENT band reachable when the gate is at or above prolongedSec", () => {
    // Regression: with gate == prolongedSec a naive >= comparison escalated every
    // event at the instant it opened, so it was never merely "open".
    expect(classifyDuration(config.prolongedSec * 1000, config.prolongedSec, config)).toBe("EVENT");
    expect(classifyDuration(config.prolongedSec * 1000 + 1, config.prolongedSec, config)).toBe("PROLONGED");
  });
});

describe("deduplication helpers", () => {
  it("keys an event by its type", () => {
    expect(dedupeKeyFor("FACE_MISSING")).toBe("FACE_MISSING");
  });

  it("suppresses a re-open inside the cool-off and allows it after", () => {
    expect(shouldSuppressReopen(T0, T0 + 500, 3)).toBe(true);
    expect(shouldSuppressReopen(T0, T0 + 4_000, 3)).toBe(false);
    expect(shouldSuppressReopen(null, T0, 3)).toBe(false);
  });

  it("never lets the cool-off collapse to zero", () => {
    expect(reopenCoolOffMs(0)).toBeGreaterThanOrEqual(1_000);
  });

  it("indexes open events by dedupe key", () => {
    const index = indexOpenEvents([open("FACE_MISSING", T0)]);
    expect(index.get("FACE_MISSING")?.id).toBe("eng_FACE_MISSING");
  });
});

describe("event engine", () => {
  it("stays quiet below the gate", () => {
    const actions = evaluateParticipant({
      state: stateIn("FACE_NOT_VISIBLE", 5),
      openEvents: [],
      config,
      now: T0,
    });
    expect(actions).toEqual([]);
  });

  it("opens FACE_MISSING once the gate is crossed", () => {
    const actions = evaluateParticipant({
      state: stateIn("FACE_NOT_VISIBLE", config.faceMissingSec + 1),
      openEvents: [],
      config,
      now: T0,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "OPEN", type: "FACE_MISSING", severity: "WARNING" });
  });

  it("does not re-open an event that is already open", () => {
    const state = stateIn("FACE_NOT_VISIBLE", config.faceMissingSec + 10);
    const actions = evaluateParticipant({
      state,
      openEvents: [open("FACE_MISSING", state.currentStateSince)],
      config,
      now: T0,
    });
    expect(actions.filter((a) => a.kind === "OPEN")).toHaveLength(0);
  });

  it("resolves an open event when the condition ends", () => {
    const state = stateIn("SCREEN_FACING", 2);
    const actions = evaluateParticipant({
      state,
      openEvents: [open("FACE_MISSING", T0 - 60_000)],
      config,
      now: T0,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "RESOLVE", type: "FACE_MISSING", durationMs: 60_000 });
  });

  it("raises LONG_ABSENCE alongside FACE_MISSING and escalates the original", () => {
    const state = stateIn("FACE_NOT_VISIBLE", config.longAbsenceSec + 5);
    const actions = evaluateParticipant({
      state,
      openEvents: [open("FACE_MISSING", state.currentStateSince)],
      config,
      now: T0,
    });
    const opened = actions.filter((a) => a.kind === "OPEN");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ type: "LONG_ABSENCE", severity: "ALERT", escalate: true });
    expect(actions.some((a) => a.kind === "ESCALATE")).toBe(true);
  });

  it("does not escalate twice", () => {
    const state = stateIn("FACE_NOT_VISIBLE", config.longAbsenceSec + 60);
    const already = { ...open("FACE_MISSING", state.currentStateSince), escalated: true };
    const actions = evaluateParticipant({
      state,
      openEvents: [already, open("LONG_ABSENCE", state.currentStateSince)],
      config,
      now: T0,
    });
    expect(actions.some((a) => a.kind === "ESCALATE")).toBe(false);
  });

  it("opens an identity mismatch with no delay at all", () => {
    const actions = evaluateParticipant({
      state: stateIn("IDENTITY_MISMATCH", 0, { identityConfidence: 0.88 }),
      openEvents: [],
      config,
      now: T0,
    });
    expect(actions[0]).toMatchObject({ kind: "OPEN", type: "IDENTITY_MISMATCH", severity: "ALERT", escalate: true });
  });

  it("honours the re-open cool-off after a resolve", () => {
    const state = stateIn("FACE_NOT_VISIBLE", config.faceMissingSec + 1);
    const actions = evaluateParticipant({
      state,
      openEvents: [],
      config,
      now: T0,
      lastResolvedAt: { FACE_MISSING: T0 - 500 },
    });
    expect(actions).toHaveLength(0);
  });

  it("resolves the old event and opens the new one when the condition changes", () => {
    const state = stateIn("MULTIPLE_FACES", config.multiFaceSec + 1, { faceCount: 2 });
    const actions = evaluateParticipant({
      state,
      openEvents: [open("CAMERA_OFF", T0 - 120_000)],
      config,
      now: T0,
    });
    expect(actions[0].kind).toBe("RESOLVE");
    expect(actions[1]).toMatchObject({ kind: "OPEN", type: "MULTIPLE_FACES" });
  });

  it("raises nothing when the feature behind the gate is disabled", () => {
    const actions = evaluateParticipant({
      state: stateIn("MULTIPLE_FACES", 600, { faceCount: 3 }),
      openEvents: [],
      config: { ...config, multiFaceEnabled: false },
      now: T0,
    });
    expect(actions.filter((a) => a.kind === "OPEN")).toHaveLength(0);
  });

  it("only escalates the three conditions that belong in the alert inbox", () => {
    const screenAway = evaluateParticipant({
      state: stateIn("LOOKING_DOWN", config.screenAwaySec + 1),
      openEvents: [],
      config,
      now: T0,
    });
    expect(screenAway[0]).toMatchObject({ kind: "OPEN", type: "SCREEN_AWAY", escalate: false });
  });

  it("describes durations in the detail text", () => {
    const state = stateIn("FACE_NOT_VISIBLE", 45);
    const actions = evaluateParticipant({ state, openEvents: [], config, now: T0 });
    expect(actions[0].kind === "OPEN" && actions[0].detail).toContain("45秒");
  });
});

describe("lifecycle events", () => {
  it("produces a point-in-time event that never deduplicates", () => {
    const a = lifecycleEvent("PARTICIPANT_JOINED", stateIn("UNKNOWN", 0), T0);
    const b = lifecycleEvent("PARTICIPANT_JOINED", stateIn("UNKNOWN", 0), T0 + 1);
    expect(a.kind).toBe("OPEN");
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });
});

describe("attention", () => {
  it("flags exactly the four states an organizer must act on", () => {
    expect(needsAttention("IDENTITY_MISMATCH")).toBe(true);
    expect(needsAttention("MULTIPLE_FACES")).toBe(true);
    expect(needsAttention("FACE_NOT_VISIBLE")).toBe(true);
    expect(needsAttention("CAMERA_OFF")).toBe(true);
    expect(needsAttention("SCREEN_FACING")).toBe(false);
    expect(needsAttention("LOOKING_DOWN")).toBe(false);
  });
});

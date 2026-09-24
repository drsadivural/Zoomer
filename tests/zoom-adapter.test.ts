import { describe, expect, it } from "vitest";
import {
  applyMediaEvent,
  applyParticipantEvent,
  participantKey,
} from "../worker/integrations/zoom/participant-events";
import { mergeObservation, observationFromMediaEvent } from "../worker/integrations/zoom/media-events";
import { backoffDelay, ConnectionTracker, isStale } from "../worker/integrations/zoom/reconnect";
import { createAdapter, isProductionAdapter } from "../worker/integrations/zoom/adapter";
import { MeetingSdkAdapter } from "../worker/integrations/zoom/meeting-sdk";
import { toEvent, toParticipant } from "../worker/integrations/zoom/rtms";
import {
  buildSimulatedRoster,
  makeRng,
  MockZoomAdapter,
  simulateObservation,
  SIMULATION_SCENARIOS,
} from "../worker/integrations/zoom/mock";
import type { ZoomParticipant } from "../worker/integrations/zoom/types";
import type { AnalysisObservation } from "../worker/services/analysis/participant-state";

const T0 = 1_760_000_000_000;

describe("participant identity resolution", () => {
  it("prefers the participant UUID, then the user id, then contact details", () => {
    expect(participantKey({ participantUuid: "u1", zoomUserId: "9", email: "a@b.c" })).toBe("u1");
    expect(participantKey({ zoomUserId: "9", email: "a@b.c" })).toBe("9");
    expect(participantKey({ email: "a@b.c" })).toBe("a@b.c");
    expect(participantKey({ displayName: "田中" })).toBe("田中");
    expect(participantKey({})).toBe("unknown");
  });

  it("records a join and a leave on the same roster entry", () => {
    const roster = new Map<string, ZoomParticipant>();
    applyParticipantEvent(roster, {
      type: "participant.joined",
      at: T0,
      participant: { participantUuid: "u1", displayName: "田中" },
    });
    applyParticipantEvent(roster, {
      type: "participant.left",
      at: T0 + 60_000,
      participant: { participantUuid: "u1" },
    });
    expect(roster.size).toBe(1);
    expect(roster.get("u1")?.leftAt).toBe(T0 + 60_000);
  });

  it("detects a rejoin rather than creating a second person", () => {
    const roster = new Map<string, ZoomParticipant>();
    applyParticipantEvent(roster, {
      type: "participant.joined",
      at: T0,
      participant: { participantUuid: "u1", displayName: "田中" },
    });
    applyParticipantEvent(roster, { type: "participant.left", at: T0 + 10_000, participant: { participantUuid: "u1" } });
    const result = applyParticipantEvent(roster, {
      type: "participant.joined",
      at: T0 + 20_000,
      participant: { participantUuid: "u1", displayName: "田中" },
    });

    expect(result.rejoined).toBe(true);
    expect(roster.size).toBe(1);
    expect(roster.get("u1")?.leftAt).toBeUndefined();
    expect(roster.get("u1")?.joinedAt).toBe(T0 + 20_000);
  });

  it("does not report a first join as a rejoin", () => {
    const roster = new Map<string, ZoomParticipant>();
    const result = applyParticipantEvent(roster, {
      type: "participant.joined",
      at: T0,
      participant: { participantUuid: "u1" },
    });
    expect(result.rejoined).toBe(false);
  });

  it("folds media events into the roster", () => {
    const roster = new Map<string, ZoomParticipant>();
    roster.set("u1", { participantUuid: "u1" });
    applyMediaEvent(roster, { type: "camera.on", at: T0, participant: { participantUuid: "u1" } });
    expect(roster.get("u1")?.cameraOn).toBe(true);
    applyMediaEvent(roster, { type: "camera.off", at: T0 + 1, participant: { participantUuid: "u1" } });
    expect(roster.get("u1")?.cameraOn).toBe(false);
    expect(
      applyMediaEvent(roster, { type: "speaking.started", at: T0 + 2, participant: { participantUuid: "u1" } })
        .speaking,
    ).toBe(true);
  });
});

describe("media events → observations", () => {
  it("clears every visual measurement when the camera goes off", () => {
    const patch = observationFromMediaEvent({ type: "camera.off", at: T0, participant: {} })!;
    expect(patch).toMatchObject({ cameraOn: false, faceDetected: false, faceCount: 0, pose: null });
  });

  it("does not fabricate a face when the camera comes back on", () => {
    const patch = observationFromMediaEvent({ type: "camera.on", at: T0, participant: {} })!;
    expect(patch.faceDetected).toBeUndefined();
  });

  it("implies the mic is on when someone starts speaking", () => {
    const patch = observationFromMediaEvent({ type: "speaking.started", at: T0, participant: {} })!;
    expect(patch).toMatchObject({ speaking: true, microphoneOn: true });
  });

  it("stops speaking when the mic is muted", () => {
    const patch = observationFromMediaEvent({ type: "microphone.off", at: T0, participant: {} })!;
    expect(patch).toMatchObject({ microphoneOn: false, speaking: false });
  });

  it("merges a patch and keeps the later timestamp", () => {
    const base: AnalysisObservation = { observedAt: T0, faceDetected: true, faceCount: 1 };
    const merged = mergeObservation(base, { observedAt: T0 + 5_000, speaking: true });
    expect(merged.observedAt).toBe(T0 + 5_000);
    expect(merged.speaking).toBe(true);
    expect(merged.faceDetected).toBe(true);
  });

  it("returns the base unchanged for a null patch", () => {
    const base: AnalysisObservation = { observedAt: T0, faceDetected: true, faceCount: 1 };
    expect(mergeObservation(base, null)).toBe(base);
  });
});

describe("reconnection", () => {
  it("backs off exponentially within bounds", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const delay = backoffDelay(attempt, { jitter: 0 });
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
    expect(backoffDelay(1, { jitter: 0 })).toBe(1_000);
    expect(backoffDelay(3, { jitter: 0 })).toBe(4_000);
  });

  it("degrades before it fails, and reports the error", () => {
    const tracker = new ConnectionTracker(3);
    tracker.connecting();
    expect(tracker.failed(new Error("network"))).toBeGreaterThan(0);
    expect(tracker.state).toBe("DEGRADED");
    expect(tracker.lastError).toBe("network");
    tracker.failed(new Error("network"));
    expect(tracker.failed(new Error("network"))).toBeNull();
    expect(tracker.state).toBe("FAILED");
  });

  it("clears the failure count on a successful connect", () => {
    const tracker = new ConnectionTracker();
    tracker.failed(new Error("x"));
    tracker.connected();
    expect(tracker.state).toBe("CONNECTED");
    expect(tracker.attemptCount).toBe(0);
    expect(tracker.lastError).toBeNull();
  });

  it("treats a missing or old heartbeat as stale", () => {
    expect(isStale(null, T0)).toBe(true);
    expect(isStale(T0 - 5_000, T0)).toBe(false);
    expect(isStale(T0 - 120_000, T0)).toBe(true);
  });
});

describe("adapter factory", () => {
  it("resolves each adapter kind", async () => {
    expect((await createAdapter("MOCK")).kind).toBe("MOCK");
    expect((await createAdapter("MEETING_SDK")).kind).toBe("MEETING_SDK");
    expect((await createAdapter("RTMS")).kind).toBe("RTMS");
  });

  it("knows which adapters may touch a real meeting", () => {
    expect(isProductionAdapter("MEETING_SDK")).toBe(true);
    expect(isProductionAdapter("RTMS")).toBe(true);
    expect(isProductionAdapter("MOCK")).toBe(false);
  });
});

describe("Meeting SDK adapter (push mode)", () => {
  it("routes a bot batch through the shared event path", async () => {
    const adapter = new MeetingSdkAdapter();
    const seen: string[] = [];
    const observed: AnalysisObservation[] = [];
    adapter.onParticipantEvent((e) => void seen.push(e.type));
    adapter.onObservation((_p, o) => void observed.push(o));

    await adapter.connect("81234567890");
    await adapter.ingest({
      meetingId: "81234567890",
      participantEvents: [
        { type: "participant.joined", at: T0, participant: { participantUuid: "u1", displayName: "田中" } },
      ],
      observations: [
        {
          participant: { participantUuid: "u1" },
          observation: { observedAt: T0, faceDetected: true, faceCount: 1 },
        },
      ],
    });

    expect(seen).toEqual(["participant.joined"]);
    expect(observed).toHaveLength(1);
    expect(adapter.status()).toMatchObject({ kind: "MEETING_SDK", connected: true, participants: 1 });
  });

  it("reports rejoins back to the caller", async () => {
    const adapter = new MeetingSdkAdapter();
    await adapter.connect("8123");
    await adapter.ingest({
      meetingId: "8123",
      participantEvents: [{ type: "participant.joined", at: T0, participant: { participantUuid: "u1" } }],
    });
    await adapter.ingest({
      meetingId: "8123",
      participantEvents: [{ type: "participant.left", at: T0 + 1000, participant: { participantUuid: "u1" } }],
    });
    const r = await adapter.ingest({
      meetingId: "8123",
      participantEvents: [{ type: "participant.joined", at: T0 + 2000, participant: { participantUuid: "u1" } }],
    });
    expect(r.rejoined).toEqual(["u1"]);
  });
});

describe("RTMS normalisation", () => {
  it("maps Zoom's event names onto the shared vocabulary", () => {
    expect(toEvent("meeting.participant_joined", { user_id: 9 }, T0)?.type).toBe("participant.joined");
    expect(toEvent("meeting.participant_video_stopped", { user_id: 9 }, T0)?.type).toBe("camera.off");
    expect(toEvent("meeting.participant_audio_muted", { user_id: 9 }, T0)?.type).toBe("microphone.off");
    expect(toEvent("something.unknown", {}, T0)).toBeNull();
  });

  it("stringifies the numeric user id so it never loses precision", () => {
    expect(toParticipant({ user_id: 16778240 }).zoomUserId).toBe("16778240");
  });
});

describe("simulator", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("covers every scenario in a roster of that size", () => {
    const roster = buildSimulatedRoster(SIMULATION_SCENARIOS.length, 1, T0);
    expect(new Set(roster.map((r) => r.scenario)).size).toBe(SIMULATION_SCENARIOS.length);
  });

  it("produces the states each scenario promises", () => {
    const rng = makeRng(7);
    expect(simulateObservation("camera-off", 10, T0, rng).cameraOn).toBe(false);
    expect(simulateObservation("face-missing", 10, T0, rng).faceDetected).toBe(false);
    expect(simulateObservation("multiple-faces", 10, T0, rng).faceCount).toBe(2);
    expect(simulateObservation("identity-mismatch", 10, T0, rng).identityStatus).toBe("MISMATCH");
    expect(simulateObservation("looking-down", 10, T0, rng).pose?.pitch).toBeLessThan(-25);
    expect(simulateObservation("looking-left", 10, T0, rng).pose?.yaw).toBeLessThan(-25);
    expect(simulateObservation("looking-right", 10, T0, rng).pose?.yaw).toBeGreaterThan(25);
  });

  it("cycles so conditions open and later resolve", () => {
    const rng = makeRng(7);
    const during = simulateObservation("face-missing", 10, T0, rng).faceDetected;
    const after = simulateObservation("face-missing", 60, T0, rng).faceDetected;
    expect(during).toBe(false);
    expect(after).toBe(true);
  });

  it("marks every simulated observation as such", () => {
    const rng = makeRng(3);
    for (const scenario of SIMULATION_SCENARIOS) {
      expect(simulateObservation(scenario, 5, T0, rng).source).toBe("SIMULATION");
    }
  });

  it("emits one observation per participant on each tick", async () => {
    const adapter = new MockZoomAdapter({ participantCount: 6, seed: 11 });
    const seen: string[] = [];
    adapter.onObservation((p) => void seen.push(p.participantUuid ?? ""));
    await adapter.connect("sim-meeting");
    const count = await adapter.tick(T0);
    expect(count).toBe(6);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("caps the roster so a typo cannot spawn a thousand participants", async () => {
    const adapter = new MockZoomAdapter({ participantCount: 10_000, seed: 1 });
    await adapter.connect("sim");
    expect(adapter.roster_.length).toBe(200);
  });
});

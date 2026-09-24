import { describe, expect, it } from "vitest";
import {
  buildMeetingReport,
  identityBreakdown,
  REPORT_CSV_HEADERS,
  reportToCsvRows,
  stateBreakdown,
  type EngagementEventRow,
  type ObservationRow,
  type ParticipantRow,
} from "../worker/services/reporting/meeting-report";

const T0 = 1_760_000_000_000;
const MIN = 60_000;

function participant(id: string, patch: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    participantId: id,
    displayName: `Zoom ${id}`,
    traineeName: `受講者 ${id}`,
    externalId: `AZ-${id}`,
    joinedAt: T0,
    leftAt: T0 + 30 * MIN,
    identityStatus: "VERIFIED",
    speakingMs: 0,
    speakingTurns: 0,
    lastSpokeAt: null,
    ...patch,
  };
}

function observations(id: string, states: string[], startAt = T0, stepMs = 10_000): ObservationRow[] {
  return states.map((state, i) => ({
    participantId: id,
    observedAt: startAt + i * stepMs,
    faceDetected: state !== "FACE_NOT_VISIBLE" && state !== "CAMERA_OFF",
    faceCount: state === "MULTIPLE_FACES" ? 2 : state === "FACE_NOT_VISIBLE" ? 0 : 1,
    cameraOn: state !== "CAMERA_OFF",
    speaking: false,
    state,
    identityStatus: "VERIFIED",
    screenFacingProbability: state === "SCREEN_FACING" ? 0.95 : 0.2,
  }));
}

describe("meeting report", () => {
  it("computes per-participant percentages over analysed samples", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 60 * MIN,
      participants: [participant("a")],
      observations: observations("a", [
        "SCREEN_FACING",
        "SCREEN_FACING",
        "LOOKING_DOWN",
        "FACE_NOT_VISIBLE",
      ]),
      events: [],
      now: T0 + 40 * MIN,
    });

    const p = report.participants[0];
    expect(p.samples).toBe(4);
    expect(p.screenFacingPct).toBe(50);
    expect(p.faceVisiblePct).toBe(75);
    expect(p.cameraOnPct).toBe(100);
  });

  it("reports zero rather than dividing by zero when nobody was analysed", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 60 * MIN,
      participants: [participant("a")],
      observations: [],
      events: [],
      now: T0 + MIN,
    });
    expect(report.participants[0].screenFacingPct).toBe(0);
    expect(report.summary.cameraOnPct).toBe(0);
    expect(report.summary.totalSamples).toBe(0);
  });

  it("measures the longest contiguous away run", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 60 * MIN,
      participants: [participant("a")],
      observations: observations("a", [
        "SCREEN_FACING",
        "FACE_NOT_VISIBLE",
        "FACE_NOT_VISIBLE",
        "FACE_NOT_VISIBLE",
        "SCREEN_FACING",
        "FACE_NOT_VISIBLE",
        "SCREEN_FACING",
      ]),
      events: [],
      now: T0 + 10 * MIN,
    });
    // Three consecutive samples 10s apart span 20s.
    expect(report.participants[0].longestAwayMs).toBe(20_000);
  });

  it("counts events by type", () => {
    const events: EngagementEventRow[] = [
      { participantId: "a", type: "MULTIPLE_FACES", severity: "ALERT", startedAt: T0, resolvedAt: T0 + MIN, durationMs: MIN },
      { participantId: "a", type: "FACE_MISSING", severity: "WARNING", startedAt: T0, resolvedAt: null, durationMs: null },
      { participantId: "b", type: "IDENTITY_MISMATCH", severity: "ALERT", startedAt: T0, resolvedAt: null, durationMs: null },
      { participantId: "b", type: "CAMERA_OFF", severity: "WARNING", startedAt: T0, resolvedAt: T0 + 2 * MIN, durationMs: 2 * MIN },
    ];
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 60 * MIN,
      participants: [participant("a"), participant("b")],
      observations: [],
      events,
      now: T0 + 10 * MIN,
    });

    expect(report.summary.multipleFaceEvents).toBe(1);
    expect(report.summary.faceMissingEvents).toBe(1);
    expect(report.summary.identityMismatchEvents).toBe(1);
    expect(report.summary.cameraOffMs).toBe(2 * MIN);
    expect(report.participants.find((p) => p.participantId === "a")?.eventCount).toBe(2);
  });

  it("computes the identity verification rate over participants", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 60 * MIN,
      participants: [
        participant("a"),
        participant("b", { identityStatus: "UNVERIFIED" }),
        participant("c"),
        participant("d", { identityStatus: "MISMATCH" }),
      ],
      observations: [],
      events: [],
      now: T0 + 10 * MIN,
    });
    expect(report.summary.identityVerifiedPct).toBe(50);
  });

  it("treats a participant still present as present until now", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 120 * MIN,
      participants: [participant("a", { leftAt: null })],
      observations: [],
      events: [],
      now: T0 + 25 * MIN,
    });
    expect(report.participants[0].presenceMs).toBe(25 * MIN);
  });

  it("carries the sampling caveat with the numbers", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + MIN,
      participants: [],
      observations: [],
      events: [],
      now: T0,
    });
    expect(report.summary.basis).toContain("サンプリング");
  });

  it("aggregates speaking participation", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 60 * MIN,
      participants: [
        participant("a", { speakingMs: 90_000, speakingTurns: 4 }),
        participant("b", { speakingMs: 0, speakingTurns: 0 }),
      ],
      observations: [],
      events: [],
      now: T0 + 30 * MIN,
    });
    expect(report.summary.speakingParticipants).toBe(1);
    expect(report.summary.totalSpeakingMs).toBe(90_000);
  });
});

describe("report export", () => {
  it("emits one CSV row per participant with matching column count", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 60 * MIN,
      participants: [participant("a"), participant("b")],
      observations: observations("a", ["SCREEN_FACING"]),
      events: [],
      now: T0 + 10 * MIN,
    });
    const rows = reportToCsvRows(report);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toHaveLength(REPORT_CSV_HEADERS.length);
  });

  it("never exports an object key or a signed URL", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + 60 * MIN,
      participants: [participant("a")],
      observations: [],
      events: [],
      now: T0,
    });
    const flat = JSON.stringify(reportToCsvRows(report));
    expect(flat).not.toContain("http");
    expect(flat).not.toContain(".bin");
  });
});

describe("breakdowns", () => {
  it("counts identity statuses", () => {
    const report = buildMeetingReport({
      sessionId: "ses_1",
      sessionStartsAt: T0,
      sessionEndsAt: T0 + MIN,
      participants: [participant("a"), participant("b", { identityStatus: "MISMATCH" })],
      observations: [],
      events: [],
      now: T0,
    });
    const breakdown = identityBreakdown(report.participants);
    expect(breakdown.VERIFIED).toBe(1);
    expect(breakdown.MISMATCH).toBe(1);
  });

  it("counts observation states", () => {
    const counts = stateBreakdown(observations("a", ["SCREEN_FACING", "SCREEN_FACING", "CAMERA_OFF"]));
    expect(counts.SCREEN_FACING).toBe(2);
    expect(counts.CAMERA_OFF).toBe(1);
  });
});

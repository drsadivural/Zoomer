/**
 * End-of-meeting analytics.
 *
 * Computed from the observation history, then frozen into `meeting_reports` so
 * the numbers survive observation purging — a report that changes after the
 * data behind it expires is worse than no report.
 *
 * Percentages are over *analysed samples*, not wall-clock time, and the report
 * says so. With sampled analysis, claiming wall-clock precision would be a
 * fabrication; a sample count next to each percentage is honest and still
 * answers the organizer's question.
 */
import type { EngagementState, IdentityStatus } from "../monitoring/signals";

export interface ObservationRow {
  participantId: string;
  observedAt: number;
  faceDetected: boolean;
  faceCount: number;
  cameraOn: boolean | null;
  speaking: boolean | null;
  state: string;
  identityStatus: string | null;
  screenFacingProbability: number | null;
}

export interface ParticipantRow {
  participantId: string;
  displayName: string | null;
  traineeName: string | null;
  externalId: string | null;
  joinedAt: number | null;
  leftAt: number | null;
  identityStatus: string;
  speakingMs: number;
  speakingTurns: number;
  lastSpokeAt: number | null;
}

export interface EngagementEventRow {
  participantId: string;
  type: string;
  severity: string;
  startedAt: number;
  resolvedAt: number | null;
  durationMs: number | null;
}

export interface ParticipantReport {
  participantId: string;
  name: string;
  externalId: string | null;
  joinedAt: number | null;
  leftAt: number | null;
  presenceMs: number;
  samples: number;
  faceVisiblePct: number;
  screenFacingPct: number;
  cameraOnPct: number;
  speakingMs: number;
  speakingTurns: number;
  identityStatus: string;
  eventCount: number;
  longestAwayMs: number;
}

export interface MeetingReportSummary {
  sessionId: string;
  generatedAt: number;
  durationMs: number;
  participantCount: number;
  averagePresenceMs: number;
  cameraOnPct: number;
  screenFacingPct: number;
  faceVisiblePct: number;
  identityVerifiedPct: number;
  multipleFaceEvents: number;
  faceMissingEvents: number;
  identityMismatchEvents: number;
  cameraOffMs: number;
  speakingParticipants: number;
  totalSpeakingMs: number;
  totalSamples: number;
  /** Honest caveat carried with the numbers, shown in every export. */
  basis: string;
}

export interface MeetingReport {
  summary: MeetingReportSummary;
  participants: ParticipantReport[];
}

const AWAY_STATES: readonly string[] = [
  "FACE_NOT_VISIBLE",
  "CAMERA_OFF",
  "LOOKING_LEFT",
  "LOOKING_RIGHT",
  "LOOKING_UP",
  "LOOKING_DOWN",
];

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

/**
 * Longest contiguous run of "away" observations, in milliseconds.
 *
 * Gaps between samples are attributed to the run they sit inside, which is the
 * only defensible reading when analysis is sampled rather than continuous.
 */
function longestAway(rows: ObservationRow[]): number {
  let longest = 0;
  let runStart: number | null = null;
  let previousAt: number | null = null;

  for (const row of rows) {
    const away = AWAY_STATES.includes(row.state);
    if (away) {
      if (runStart == null) runStart = row.observedAt;
      previousAt = row.observedAt;
    } else if (runStart != null) {
      longest = Math.max(longest, (previousAt ?? runStart) - runStart);
      runStart = null;
      previousAt = null;
    }
  }
  if (runStart != null) longest = Math.max(longest, (previousAt ?? runStart) - runStart);
  return longest;
}

export interface BuildReportInput {
  sessionId: string;
  sessionStartsAt: number;
  sessionEndsAt: number;
  participants: ParticipantRow[];
  observations: ObservationRow[];
  events: EngagementEventRow[];
  now?: number;
}

export function buildMeetingReport(input: BuildReportInput): MeetingReport {
  const now = input.now ?? Date.now();

  const byParticipant = new Map<string, ObservationRow[]>();
  for (const row of input.observations) {
    const list = byParticipant.get(row.participantId);
    if (list) list.push(row);
    else byParticipant.set(row.participantId, [row]);
  }
  for (const list of byParticipant.values()) list.sort((a, b) => a.observedAt - b.observedAt);

  const eventsByParticipant = new Map<string, EngagementEventRow[]>();
  for (const event of input.events) {
    const list = eventsByParticipant.get(event.participantId);
    if (list) list.push(event);
    else eventsByParticipant.set(event.participantId, [event]);
  }

  const participants: ParticipantReport[] = input.participants.map((p) => {
    const rows = byParticipant.get(p.participantId) ?? [];
    const samples = rows.length;
    const faceVisible = rows.filter((r) => r.faceDetected).length;
    const screenFacing = rows.filter((r) => r.state === "SCREEN_FACING").length;
    const cameraOn = rows.filter((r) => r.cameraOn !== false).length;
    const leftAt = p.leftAt ?? Math.min(now, input.sessionEndsAt);
    const joinedAt = p.joinedAt ?? input.sessionStartsAt;

    return {
      participantId: p.participantId,
      name: p.traineeName ?? p.displayName ?? "未照合の参加者",
      externalId: p.externalId,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
      presenceMs: Math.max(0, leftAt - joinedAt),
      samples,
      faceVisiblePct: pct(faceVisible, samples),
      screenFacingPct: pct(screenFacing, samples),
      cameraOnPct: pct(cameraOn, samples),
      speakingMs: p.speakingMs,
      speakingTurns: p.speakingTurns,
      identityStatus: p.identityStatus,
      eventCount: (eventsByParticipant.get(p.participantId) ?? []).length,
      longestAwayMs: longestAway(rows),
    };
  });

  const totalSamples = input.observations.length;
  const countEvents = (type: string) => input.events.filter((e) => e.type === type).length;
  const cameraOffMs = input.events
    .filter((e) => e.type === "CAMERA_OFF")
    .reduce((sum, e) => sum + (e.durationMs ?? Math.max(0, now - e.startedAt)), 0);

  const summary: MeetingReportSummary = {
    sessionId: input.sessionId,
    generatedAt: now,
    durationMs: Math.max(0, Math.min(now, input.sessionEndsAt) - input.sessionStartsAt),
    participantCount: participants.length,
    averagePresenceMs: participants.length
      ? Math.round(participants.reduce((s, p) => s + p.presenceMs, 0) / participants.length)
      : 0,
    cameraOnPct: pct(input.observations.filter((r) => r.cameraOn !== false).length, totalSamples),
    screenFacingPct: pct(input.observations.filter((r) => r.state === "SCREEN_FACING").length, totalSamples),
    faceVisiblePct: pct(input.observations.filter((r) => r.faceDetected).length, totalSamples),
    identityVerifiedPct: pct(
      participants.filter((p) => p.identityStatus === "VERIFIED").length,
      participants.length,
    ),
    multipleFaceEvents: countEvents("MULTIPLE_FACES"),
    faceMissingEvents: countEvents("FACE_MISSING"),
    identityMismatchEvents: countEvents("IDENTITY_MISMATCH"),
    cameraOffMs,
    speakingParticipants: participants.filter((p) => p.speakingMs > 0).length,
    totalSpeakingMs: participants.reduce((s, p) => s + p.speakingMs, 0),
    totalSamples,
    basis:
      "割合は解析サンプル数に対する比率です（連続録画ではなくサンプリング解析のため）。",
  };

  return { summary, participants };
}

/** Flat rows for CSV export; mirrors the participant table in the UI. */
export function reportToCsvRows(report: MeetingReport): (string | number)[][] {
  return report.participants.map((p) => [
    p.name,
    p.externalId ?? "",
    p.joinedAt ? new Date(p.joinedAt).toISOString() : "",
    p.leftAt ? new Date(p.leftAt).toISOString() : "",
    Math.round(p.presenceMs / 1000),
    p.samples,
    p.faceVisiblePct,
    p.screenFacingPct,
    p.cameraOnPct,
    Math.round(p.speakingMs / 1000),
    p.speakingTurns,
    p.identityStatus,
    p.eventCount,
    Math.round(p.longestAwayMs / 1000),
  ]);
}

export const REPORT_CSV_HEADERS = [
  "氏名",
  "受講者ID",
  "参加(UTC)",
  "退出(UTC)",
  "在席秒",
  "解析サンプル数",
  "顔検出率%",
  "画面正対率%",
  "カメラON率%",
  "発話秒",
  "発話回数",
  "本人確認",
  "イベント数",
  "最長離脱秒",
];

/** Identity status counts, used by the summary KPIs. */
export function identityBreakdown(participants: ParticipantReport[]): Record<IdentityStatus, number> {
  const out = {
    VERIFIED: 0,
    UNVERIFIED: 0,
    MISMATCH: 0,
    NO_FACE: 0,
    MULTIPLE_FACES: 0,
    LOW_CONFIDENCE: 0,
    UNKNOWN: 0,
  } as Record<IdentityStatus, number>;
  for (const p of participants) {
    const key = p.identityStatus as IdentityStatus;
    if (key in out) out[key]++;
    else out.UNKNOWN++;
  }
  return out;
}

/** State distribution across a session, for the timeline legend. */
export function stateBreakdown(observations: ObservationRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of observations) out[row.state] = (out[row.state] ?? 0) + 1;
  return out;
}

export type { EngagementState };

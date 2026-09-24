/**
 * Development simulation adapter (§42).
 *
 * Generates a synthetic meeting so the entire organizer console — grid, KPIs,
 * filters, drawer, timeline, event feed, alerts, reports — can be exercised
 * without a Zoom account, a Meeting SDK key, or a camera. Every scenario in the
 * verification list (§44) is represented, including the awkward ones a live
 * demo never reproduces on cue: an identity mismatch, two faces in one tile, a
 * participant who leaves and rejoins.
 *
 * Deterministic on purpose. A seeded generator means a bug seen in the UI can
 * be reproduced exactly by replaying the same seed, and a snapshot test of the
 * simulator is stable.
 */
import { BaseZoomAdapter } from "./adapter";
import type { AdapterFactoryOptions } from "./adapter";
import type { AnalysisObservation } from "../../services/analysis/participant-state";
import type { AdapterKind, ZoomParticipant } from "./types";

/** Small, fast, deterministic PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIMULATION_SCENARIOS = [
  "stable",
  "speaking",
  "looking-left",
  "looking-right",
  "looking-down",
  "looking-up",
  "camera-off",
  "face-missing",
  "multiple-faces",
  "identity-mismatch",
  "low-quality",
  "rejoining",
] as const;

export type SimulationScenario = (typeof SIMULATION_SCENARIOS)[number];

const NAMES = [
  "田中 健二", "佐藤 美咲", "鈴木 太郎", "高橋 由紀", "伊藤 大輔", "渡辺 彩",
  "山本 翔太", "中村 香織", "小林 誠", "加藤 麻衣", "吉田 隆", "山田 直樹",
];

/** Gentle idle motion, so a "stable" participant is not suspiciously rigid. */
function idleJitter(rng: () => number, scale = 6): { yaw: number; pitch: number; roll: number } {
  return {
    yaw: (rng() - 0.5) * scale,
    pitch: (rng() - 0.5) * scale,
    roll: (rng() - 0.5) * (scale / 3),
  };
}

export interface SimulatedParticipant {
  key: string;
  scenario: SimulationScenario;
  participant: ZoomParticipant;
}

/**
 * Produces one observation for one scenario at `elapsedSec` into the run.
 *
 * Scenarios are cyclic so a simulation left running keeps producing open/resolve
 * pairs rather than settling into one state and going quiet — which is exactly
 * what you need when testing the event engine's de-duplication.
 */
export function simulateObservation(
  scenario: SimulationScenario,
  elapsedSec: number,
  now: number,
  rng: () => number,
): AnalysisObservation {
  const base: AnalysisObservation = {
    observedAt: now,
    faceDetected: true,
    faceCount: 1,
    detectionConfidence: 0.93 + rng() * 0.06,
    faceBox: { x: 0.32 + rng() * 0.04, y: 0.18 + rng() * 0.04, width: 0.26, height: 0.36 },
    pose: idleJitter(rng),
    gazeHorizontal: (rng() - 0.5) * 0.12,
    gazeVertical: (rng() - 0.5) * 0.12,
    cameraOn: true,
    microphoneOn: true,
    speaking: false,
    identityStatus: "VERIFIED",
    identityConfidence: 0.88 + rng() * 0.08,
    source: "SIMULATION",
  };

  const phase = (period: number) => elapsedSec % period;

  switch (scenario) {
    case "speaking":
      return { ...base, speaking: phase(40) < 14, microphoneOn: true };

    case "looking-left":
      return phase(60) < 35
        ? { ...base, pose: { yaw: -38 - rng() * 8, pitch: 2, roll: -3 }, gazeHorizontal: -0.6 }
        : base;

    case "looking-right":
      return phase(70) < 40
        ? { ...base, pose: { yaw: 36 + rng() * 8, pitch: -1, roll: 2 }, gazeHorizontal: 0.58 }
        : base;

    case "looking-down":
      // The classic "taking notes / looking at a phone" shape.
      return phase(50) < 30
        ? { ...base, pose: { yaw: 4, pitch: -34 - rng() * 6, roll: 1 }, gazeVertical: -0.55 }
        : base;

    case "looking-up":
      return phase(80) < 25 ? { ...base, pose: { yaw: -3, pitch: 27 + rng() * 5, roll: 0 } } : base;

    case "camera-off":
      return phase(120) < 80
        ? {
            ...base,
            cameraOn: false,
            faceDetected: false,
            faceCount: 0,
            faceBox: null,
            pose: null,
            gazeHorizontal: null,
            gazeVertical: null,
            identityStatus: "NO_FACE",
            identityConfidence: null,
            detectionConfidence: null,
          }
        : base;

    case "face-missing":
      return phase(90) < 45
        ? {
            ...base,
            faceDetected: false,
            faceCount: 0,
            faceBox: null,
            pose: null,
            identityStatus: "NO_FACE",
            identityConfidence: null,
            detectionConfidence: 0,
          }
        : base;

    case "multiple-faces":
      return phase(75) < 30
        ? { ...base, faceCount: 2, identityStatus: "MULTIPLE_FACES", identityConfidence: 0.71 }
        : base;

    case "identity-mismatch":
      return phase(100) < 50
        ? { ...base, identityStatus: "MISMATCH", identityConfidence: 0.86 }
        : base;

    case "low-quality":
      // Poor lighting / low-bitrate video: a face is there but we cannot trust it.
      return { ...base, detectionConfidence: 0.22 + rng() * 0.12, identityStatus: "LOW_CONFIDENCE", identityConfidence: 0.38 };

    case "rejoining":
      return phase(150) < 40
        ? {
            ...base,
            cameraOn: false,
            faceDetected: false,
            faceCount: 0,
            faceBox: null,
            pose: null,
            identityStatus: "UNKNOWN",
            identityConfidence: null,
            detectionConfidence: null,
          }
        : { ...base, identityStatus: "VERIFIED" };

    case "stable":
    default:
      return base;
  }
}

/** Builds a deterministic roster covering every scenario at least once. */
export function buildSimulatedRoster(count: number, seed: number, startedAt: number): SimulatedParticipant[] {
  const rng = makeRng(seed);
  const out: SimulatedParticipant[] = [];
  for (let i = 0; i < count; i++) {
    const scenario = SIMULATION_SCENARIOS[i % SIMULATION_SCENARIOS.length];
    const name = `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` (${Math.floor(i / NAMES.length) + 1})` : ""}`;
    out.push({
      key: `sim-${i + 1}`,
      scenario,
      participant: {
        zoomUserId: `sim-${i + 1}`,
        participantUuid: `sim-uuid-${seed}-${i + 1}`,
        displayName: name,
        joinedAt: startedAt + Math.floor(rng() * 20_000),
        cameraOn: scenario !== "camera-off",
        microphoneOn: true,
      },
    });
  }
  return out;
}

export class MockZoomAdapter extends BaseZoomAdapter {
  readonly kind: AdapterKind = "MOCK";

  private readonly participantCount: number;
  private readonly seed: number;
  private startedAt = Date.now();
  private simulated: SimulatedParticipant[] = [];

  constructor(options: AdapterFactoryOptions = {}) {
    super();
    this.participantCount = Math.max(1, Math.min(options.participantCount ?? 12, 200));
    this.seed = options.seed ?? 20260924;
  }

  protected async onConnect(meetingId: string): Promise<void> {
    this.meetingId = meetingId;
    this.startedAt = Date.now();
    this.simulated = buildSimulatedRoster(this.participantCount, this.seed, this.startedAt);
    for (const entry of this.simulated) {
      await this.emitParticipant({
        type: "participant.joined",
        at: entry.participant.joinedAt ?? this.startedAt,
        participant: entry.participant,
      });
    }
  }

  protected async onDisconnect(): Promise<void> {
    this.simulated = [];
  }

  get roster_(): SimulatedParticipant[] {
    return this.simulated;
  }

  /** Advances the simulation and emits one observation per participant. */
  async tick(now = Date.now()): Promise<number> {
    const rng = makeRng(this.seed + Math.floor(now / 1000));
    const elapsedSec = Math.max(0, (now - this.startedAt) / 1000);
    for (const entry of this.simulated) {
      const observation = simulateObservation(entry.scenario, elapsedSec, now, rng);
      await this.emitObservation(entry.participant, observation);
    }
    return this.simulated.length;
  }
}

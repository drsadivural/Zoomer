/**
 * Organizer monitoring configuration.
 *
 * Kept separate from `worker/lib/settings.ts` (the trainee-side detection rules)
 * so the two version counters never collide: an organizer changing the screen-
 * away threshold must not bump the rule version that past trainee events were
 * graded under.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { meetingMonitoringSettings } from "../../db/schema";

export interface MeetingMonitoringConfig {
  version: number;

  faceMonitoringEnabled: boolean;
  identityVerificationEnabled: boolean;
  screenFacingEnabled: boolean;
  headPoseEnabled: boolean;
  multiFaceEnabled: boolean;
  participationAnalyticsEnabled: boolean;
  transcriptEnabled: boolean;

  /** Frames per second the analysis worker should sample at (§7). */
  normalFps: number;
  elevatedFps: number;
  /** Seconds between analyses for each scheduler tier (§35). */
  normalIntervalSec: number;
  warmIntervalSec: number;
  hotIntervalSec: number;

  /** Temporal persistence gates (§12). */
  transientSec: number;
  temporarySec: number;
  prolongedSec: number;

  faceMissingSec: number;
  screenAwaySec: number;
  cameraOffSec: number;
  multiFaceSec: number;
  longAbsenceSec: number;

  identityConfidenceThreshold: number;
  identityCacheSec: number;
  screenFacingThreshold: number;
  lowConfidenceThreshold: number;

  yawThresholdDeg: number;
  pitchUpThresholdDeg: number;
  pitchDownThresholdDeg: number;

  snapshotsEnabled: boolean;
  snapshotRetentionDays: number;
  observationRetentionDays: number;
  eventRetentionDays: number;
  transcriptRetentionDays: number;

  alertNotificationsEnabled: boolean;
}

/**
 * Shipped defaults. Every value is deliberately conservative: analysis runs at
 * 2 FPS rather than per frame, snapshots are OFF, and no state is believed
 * until it has persisted for at least `transientSec`.
 */
export const DEFAULT_MEETING_CONFIG: MeetingMonitoringConfig = {
  version: 1,

  faceMonitoringEnabled: true,
  identityVerificationEnabled: true,
  screenFacingEnabled: true,
  headPoseEnabled: true,
  multiFaceEnabled: true,
  participationAnalyticsEnabled: true,
  transcriptEnabled: false,

  normalFps: 2,
  elevatedFps: 5,
  normalIntervalSec: 10,
  warmIntervalSec: 3,
  hotIntervalSec: 1,

  transientSec: 3,
  temporarySec: 10,
  prolongedSec: 30,

  faceMissingSec: 30,
  screenAwaySec: 30,
  cameraOffSec: 60,
  multiFaceSec: 5,
  longAbsenceSec: 300,

  identityConfidenceThreshold: 0.82,
  identityCacheSec: 600,
  screenFacingThreshold: 0.6,
  lowConfidenceThreshold: 0.4,

  yawThresholdDeg: 25,
  pitchUpThresholdDeg: 18,
  pitchDownThresholdDeg: 22,

  snapshotsEnabled: false,
  snapshotRetentionDays: 7,
  observationRetentionDays: 14,
  eventRetentionDays: 90,
  transcriptRetentionDays: 30,

  alertNotificationsEnabled: true,
};

/** Reads an organization's config, falling back to shipped defaults. */
export async function getMeetingConfig(
  d1: D1Database,
  organizationId: string,
): Promise<MeetingMonitoringConfig> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(meetingMonitoringSettings)
    .where(eq(meetingMonitoringSettings.organizationId, organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ...DEFAULT_MEETING_CONFIG };

  // Spread the defaults first so a column added in a later migration still has
  // a value for organizations that saved their settings before it existed.
  const { organizationId: _org, updatedAt: _u, updatedBy: _b, ...rest } = row;
  return { ...DEFAULT_MEETING_CONFIG, ...rest };
}

/**
 * Merges a partial update over the current config. Unknown keys are dropped
 * rather than persisted, so a stale client cannot write junk columns.
 */
export function mergeMeetingConfig(
  current: MeetingMonitoringConfig,
  patch: Partial<MeetingMonitoringConfig>,
): MeetingMonitoringConfig {
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_MEETING_CONFIG) as (keyof MeetingMonitoringConfig)[]) {
    if (key === "version") continue;
    const value = patch[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** Seconds between analyses for a tier — the scheduler's only timing source. */
export function tierIntervalSec(config: MeetingMonitoringConfig, tier: "HOT" | "WARM" | "NORMAL"): number {
  if (tier === "HOT") return Math.max(0.2, config.hotIntervalSec);
  if (tier === "WARM") return Math.max(0.2, config.warmIntervalSec);
  return Math.max(1, config.normalIntervalSec);
}

/** Sampling rate an analysis worker should use while a participant is in `tier`. */
export function tierFps(config: MeetingMonitoringConfig, tier: "HOT" | "WARM" | "NORMAL"): number {
  return tier === "HOT" ? config.elevatedFps : config.normalFps;
}

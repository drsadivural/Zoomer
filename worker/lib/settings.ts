import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { monitoringSettings } from "../db/schema";
import { DEFAULT_RULES, type MonitoringRules } from "./rules";

/** Reads the organization's live rules, falling back to shipped defaults. */
export async function getRules(d1: D1Database, organizationId: string): Promise<MonitoringRules> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(monitoringSettings)
    .where(eq(monitoringSettings.organizationId, organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ...DEFAULT_RULES };
  return {
    version: row.version,
    reauthIntervalSec: row.reauthIntervalSec,
    matchThreshold: row.matchThreshold,
    absenceSec: row.absenceSec,
    eyesClosedSec: row.eyesClosedSec,
    multiFaceFrames: row.multiFaceFrames,
    evidenceIntervalSec: row.evidenceIntervalSec,
    evidenceRetentionDays: row.evidenceRetentionDays,
    precheckMaxAttempts: row.precheckMaxAttempts,
    livenessRequired: row.livenessRequired,
    imageQuality: row.imageQuality,
  };
}

/** Formats the rule identity stamped onto every event, e.g. `org_123:17`. */
export function ruleVersionTag(organizationId: string, version: number): string {
  return `${organizationId}:${version}`;
}

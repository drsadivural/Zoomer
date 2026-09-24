/**
 * Event de-duplication.
 *
 * A participant who steps out of frame for two minutes is ONE event that opens
 * and later resolves — not 240 of them. Two mechanisms enforce that:
 *
 *   1. a dedupe key that is unique per (participant, condition) while open, so
 *      a second OPEN for the same condition becomes an occurrence bump; and
 *   2. a re-open cool-off, so a flickering detector cannot machine-gun the
 *      organizer with open/resolve pairs.
 */
import type { EngagementEventType } from "../monitoring/signals";

export interface OpenEvent {
  id: string;
  type: EngagementEventType;
  dedupeKey: string;
  startedAt: number;
  severity: string;
  occurrences: number;
  escalated: boolean;
}

/** Stable within one participant; the participant id scopes it in the database. */
export function dedupeKeyFor(type: EngagementEventType): string {
  return type;
}

/**
 * How long after an event resolves the same condition is suppressed.
 *
 * Tied to the transient window rather than a separate knob: if a state must
 * persist for N seconds to be believed, it should also stay gone for N seconds
 * before we call it a new occurrence.
 */
export function reopenCoolOffMs(transientSec: number): number {
  return Math.max(1_000, transientSec * 1000);
}

export function shouldSuppressReopen(
  lastResolvedAt: number | null | undefined,
  now: number,
  transientSec: number,
): boolean {
  if (!lastResolvedAt) return false;
  return now - lastResolvedAt < reopenCoolOffMs(transientSec);
}

/** Index open events by dedupe key for O(1) lookup during evaluation. */
export function indexOpenEvents(events: OpenEvent[]): Map<string, OpenEvent> {
  const map = new Map<string, OpenEvent>();
  for (const event of events) map.set(event.dedupeKey, event);
  return map;
}

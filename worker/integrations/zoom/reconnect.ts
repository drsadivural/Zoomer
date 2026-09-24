/**
 * Reconnection policy shared by every Zoom adapter.
 *
 * Zoom drops connections routinely — host restarts, network blips, meetings
 * that end and restart under the same id. A dropped media connection must
 * degrade the dashboard, never crash it (§36), and must not turn into a
 * reconnect storm against Zoom's API.
 */

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of the delay to randomise, so many bots do not retry in lockstep. */
  jitter?: number;
}

export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 1_000;
  const max = options.maxMs ?? 30_000;
  const jitter = options.jitter ?? 0.2;
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const spread = raw * jitter;
  return Math.round(raw - spread / 2 + Math.random() * spread);
}

export type ConnectionPhase = "IDLE" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "FAILED";

/**
 * Tracks a connection's health without owning the transport.
 *
 * `DEGRADED` is a first-class state rather than a synonym for failure: the
 * organizer console keeps showing the last known participant states, clearly
 * marked stale, while the adapter retries underneath.
 */
export class ConnectionTracker {
  private phase: ConnectionPhase = "IDLE";
  private attempts = 0;
  private lastErrorMessage: string | null = null;
  private lastChangeAt = Date.now();

  constructor(private readonly maxAttempts = 10) {}

  get state(): ConnectionPhase {
    return this.phase;
  }

  get lastError(): string | null {
    return this.lastErrorMessage;
  }

  get attemptCount(): number {
    return this.attempts;
  }

  get changedAt(): number {
    return this.lastChangeAt;
  }

  connecting(): void {
    this.transition("CONNECTING");
  }

  connected(): void {
    this.attempts = 0;
    this.lastErrorMessage = null;
    this.transition("CONNECTED");
  }

  /** Records a failure and returns how long to wait, or null when giving up. */
  failed(error: unknown): number | null {
    this.attempts++;
    this.lastErrorMessage = error instanceof Error ? error.message : String(error);
    if (this.attempts >= this.maxAttempts) {
      this.transition("FAILED");
      return null;
    }
    this.transition("DEGRADED");
    return backoffDelay(this.attempts);
  }

  closed(): void {
    this.transition("IDLE");
  }

  private transition(next: ConnectionPhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.lastChangeAt = Date.now();
  }
}

/**
 * Heartbeat freshness. An analysis run whose worker has gone quiet is reported
 * as DEGRADED rather than silently continuing to show stale state as live.
 */
export function isStale(lastHeartbeatAt: number | null | undefined, now: number, toleranceMs = 60_000): boolean {
  if (!lastHeartbeatAt) return true;
  return now - lastHeartbeatAt > toleranceMs;
}

import type { HubEventType } from "../do/session-hub";
import type { Env } from "../types";

/** Routes a broadcast to the Durable Object that owns this session. */
export async function publishToSession(
  env: Env,
  sessionId: string,
  type: HubEventType,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const id = env.SESSION_HUB.idFromName(sessionId);
    const stub = env.SESSION_HUB.get(id);
    await stub.fetch("https://hub/publish", {
      method: "POST",
      body: JSON.stringify({ type, sessionId, data }),
    });
  } catch (err) {
    // Realtime is a delivery optimisation, never the system of record: the
    // dashboard can always recover the same state by polling /monitor.
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "realtime publish failed",
        sessionId,
        type,
        error: err instanceof Error ? err.message : "unknown",
      }),
    );
  }
}

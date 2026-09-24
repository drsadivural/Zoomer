import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * One instance per training session. Holds the live participant roster and
 * fans changes out to connected dashboards over WebSocket
 * (API_CONTRACT.md: リアルタイムイベント).
 *
 * Every broadcast carries a monotonic cursor. A dashboard that drops its socket
 * reconnects and replays from its last cursor via
 * `GET /sessions/{id}/monitor?since=<cursor>`, so a brief disconnect cannot
 * silently lose an alert.
 */

export type HubEventType =
  | "participant.status.changed"
  | "alert.created"
  | "alert.updated"
  | "session.metrics.updated"
  | "participant.disconnected"
  /* Zoom Organizer Intelligence layer (additive — existing consumers ignore
     types they do not recognise, so adding to this union is backwards
     compatible for dashboards built against the original five). */
  | "participant.analysis.updated"
  | "engagement.event.opened"
  | "engagement.event.resolved"
  | "analysis.session.changed";

export interface HubEvent {
  cursor: number;
  type: HubEventType;
  sessionId: string;
  at: number;
  data: Record<string, unknown>;
}

/** Bounded replay buffer: enough to cover a reconnect, not a session history. */
const BUFFER_LIMIT = 500;

export class SessionHub extends DurableObject<Env> {
  private buffer: HubEvent[] = [];
  private cursor = 0;
  private sockets = new Set<WebSocket>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      this.sockets.add(server);

      const since = Number(url.searchParams.get("since") ?? "0");
      const backlog = this.buffer.filter((e) => e.cursor > since);
      server.send(JSON.stringify({ type: "sync", cursor: this.cursor, events: backlog }));

      const drop = () => this.sockets.delete(server);
      server.addEventListener("close", drop);
      server.addEventListener("error", drop);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/publish") && request.method === "POST") {
      const body = (await request.json()) as {
        type: HubEventType;
        sessionId: string;
        data: Record<string, unknown>;
      };
      const event = this.publish(body.type, body.sessionId, body.data);
      return Response.json({ cursor: event.cursor });
    }

    if (url.pathname.endsWith("/since")) {
      const since = Number(url.searchParams.get("since") ?? "0");
      return Response.json({
        cursor: this.cursor,
        events: this.buffer.filter((e) => e.cursor > since),
      });
    }

    return new Response("not found", { status: 404 });
  }

  private publish(
    type: HubEventType,
    sessionId: string,
    data: Record<string, unknown>,
  ): HubEvent {
    const event: HubEvent = {
      cursor: ++this.cursor,
      type,
      sessionId,
      at: Date.now(),
      data,
    };

    this.buffer.push(event);
    if (this.buffer.length > BUFFER_LIMIT) {
      this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
    }

    const payload = JSON.stringify({ type: "event", event });
    for (const socket of [...this.sockets]) {
      try {
        socket.send(payload);
      } catch {
        // A socket that refuses a write is already gone; drop it rather than
        // letting a dead peer stall the broadcast.
        this.sockets.delete(socket);
      }
    }
    return event;
  }
}

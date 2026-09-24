/**
 * Adapter base + factory.
 *
 * Two shapes of adapter exist, and the difference matters:
 *
 *   PUSH  the media never reaches this Worker. An external process — the
 *         Meeting-SDK bot on a GPU host — holds the Zoom connection, analyses
 *         frames, and POSTs results in. The adapter here is the *receiving*
 *         half: it normalises what arrives and reports connection health.
 *
 *   LOCAL the adapter generates everything itself. Only the simulator does
 *         this, and only outside production.
 *
 * Cloudflare Workers cannot hold a Zoom media session or run a GPU model (§52),
 * so PUSH is the production shape. Keeping both behind one interface is what
 * lets the organizer console, the scheduler and the event engine be written
 * once and tested against the simulator.
 */
import { ConnectionTracker } from "./reconnect";
import type {
  AdapterKind,
  AdapterStatus,
  MediaEventHandler,
  ObservationHandler,
  ParticipantEventHandler,
  VideoFrameHandler,
  ZoomMediaAdapter,
  ZoomParticipant,
} from "./types";
import { applyMediaEvent, applyParticipantEvent, participantKey } from "./participant-events";
import type { MediaEvent, ParticipantEvent, VideoFrame } from "./types";
import type { AnalysisObservation } from "../../services/analysis/participant-state";

export abstract class BaseZoomAdapter implements ZoomMediaAdapter {
  abstract readonly kind: AdapterKind;

  protected readonly roster = new Map<string, ZoomParticipant>();
  protected readonly subscribed = new Set<string>();
  protected readonly connection = new ConnectionTracker();
  protected meetingId: string | null = null;
  protected connectedAt: number | null = null;

  private participantHandlers: ParticipantEventHandler[] = [];
  private frameHandlers: VideoFrameHandler[] = [];
  private audioHandlers: MediaEventHandler[] = [];
  private observationHandlers: ObservationHandler[] = [];

  async connect(meetingId: string): Promise<void> {
    this.connection.connecting();
    this.meetingId = meetingId;
    await this.onConnect(meetingId);
    this.connectedAt = Date.now();
    this.connection.connected();
  }

  async disconnect(): Promise<void> {
    await this.onDisconnect();
    this.roster.clear();
    this.subscribed.clear();
    this.meetingId = null;
    this.connectedAt = null;
    this.connection.closed();
  }

  status(): AdapterStatus {
    return {
      kind: this.kind,
      connected: this.connection.state === "CONNECTED",
      meetingId: this.meetingId,
      participants: this.roster.size,
      since: this.connectedAt,
      lastError: this.connection.lastError,
    };
  }

  async getParticipants(): Promise<ZoomParticipant[]> {
    return [...this.roster.values()];
  }

  async subscribeParticipant(participantId: string): Promise<void> {
    this.subscribed.add(participantId);
  }

  async unsubscribeParticipant(participantId: string): Promise<void> {
    this.subscribed.delete(participantId);
  }

  onParticipantEvent(callback: ParticipantEventHandler): void {
    this.participantHandlers.push(callback);
  }

  onVideoFrame(callback: VideoFrameHandler): void {
    this.frameHandlers.push(callback);
  }

  onAudioEvent(callback: MediaEventHandler): void {
    this.audioHandlers.push(callback);
  }

  onObservation(callback: ObservationHandler): void {
    this.observationHandlers.push(callback);
  }

  /* ------------------------------------------------------- emit helpers */

  protected async emitParticipant(event: ParticipantEvent): Promise<{ rejoined: boolean }> {
    const { rejoined } = applyParticipantEvent(this.roster, event);
    for (const handler of this.participantHandlers) await handler(event);
    return { rejoined };
  }

  protected async emitMedia(event: MediaEvent): Promise<void> {
    applyMediaEvent(this.roster, event);
    for (const handler of this.audioHandlers) await handler(event);
  }

  protected async emitFrame(frame: VideoFrame): Promise<void> {
    for (const handler of this.frameHandlers) await handler(frame);
  }

  protected async emitObservation(
    participant: Pick<ZoomParticipant, "zoomUserId" | "participantUuid">,
    observation: AnalysisObservation,
  ): Promise<void> {
    for (const handler of this.observationHandlers) await handler(participant, observation);
  }

  protected key(participant: Parameters<typeof participantKey>[0]): string {
    return participantKey(participant);
  }

  protected abstract onConnect(meetingId: string): Promise<void>;
  protected abstract onDisconnect(): Promise<void>;
}

export interface AdapterFactoryOptions {
  /** Simulation only: how many synthetic participants to generate. */
  participantCount?: number;
  seed?: number;
}

/**
 * Resolves an adapter by kind. Async import keeps the simulator — the only
 * adapter with a meaningful code size — out of the production hot path.
 */
export async function createAdapter(
  kind: AdapterKind,
  options: AdapterFactoryOptions = {},
): Promise<ZoomMediaAdapter> {
  switch (kind) {
    case "MEETING_SDK": {
      const { MeetingSdkAdapter } = await import("./meeting-sdk");
      return new MeetingSdkAdapter();
    }
    case "RTMS": {
      const { RtmsAdapter } = await import("./rtms");
      return new RtmsAdapter();
    }
    case "MOCK":
    default: {
      const { MockZoomAdapter } = await import("./mock");
      return new MockZoomAdapter(options);
    }
  }
}

/** Adapters that are safe to start against real customer meetings. */
export function isProductionAdapter(kind: AdapterKind): boolean {
  return kind === "MEETING_SDK" || kind === "RTMS";
}

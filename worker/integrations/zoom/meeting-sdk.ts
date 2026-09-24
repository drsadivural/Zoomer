/**
 * Meeting SDK adapter (push mode).
 *
 * The producer is `zoom-bot/` — a headless C++ process that joins the meeting
 * with the Zoom Meeting SDK, pulls each participant's raw video, runs the
 * Ayonix/UXE engine on a GPU host and POSTs the results to
 * `POST /api/v1/bot/ingest` (unchanged, still used by the original pipeline) and
 * `POST /api/v1/bot/observe` (this layer's richer payload).
 *
 * This class is the receiving half: it normalises what the bot sends into the
 * same events any other adapter produces, so the scheduler, event engine and
 * organizer console cannot tell the difference.
 *
 * Zoom gates two things before this can run against a real meeting: a Meeting
 * SDK app (Key + Secret, separate from the OAuth app) and raw-data access, which
 * needs Zoom app review for production. Neither is a code change here.
 */
import { BaseZoomAdapter } from "./adapter";
import type { AdapterKind, MediaEvent, ParticipantEvent, VideoFrame, ZoomParticipant } from "./types";
import type { AnalysisObservation } from "../../services/analysis/participant-state";

export interface BotIngestBatch {
  meetingId: string;
  botId?: string;
  participants?: ZoomParticipant[];
  participantEvents?: ParticipantEvent[];
  mediaEvents?: MediaEvent[];
  frames?: VideoFrame[];
  observations?: {
    participant: Pick<ZoomParticipant, "zoomUserId" | "participantUuid">;
    observation: AnalysisObservation;
  }[];
}

export class MeetingSdkAdapter extends BaseZoomAdapter {
  readonly kind: AdapterKind = "MEETING_SDK";

  private lastBatchAt: number | null = null;

  protected async onConnect(meetingId: string): Promise<void> {
    // Nothing to dial: the bot initiates. "Connected" here means the backend is
    // ready to accept that bot's batches for this meeting.
    this.meetingId = meetingId;
  }

  protected async onDisconnect(): Promise<void> {
    this.lastBatchAt = null;
  }

  /** Feeds one batch from the bot through the normal event path. */
  async ingest(batch: BotIngestBatch): Promise<{ rejoined: string[] }> {
    this.lastBatchAt = Date.now();
    const rejoined: string[] = [];

    for (const participant of batch.participants ?? []) {
      this.roster.set(this.key(participant), participant);
    }
    for (const event of batch.participantEvents ?? []) {
      const result = await this.emitParticipant(event);
      if (result.rejoined) rejoined.push(this.key(event.participant));
    }
    for (const event of batch.mediaEvents ?? []) {
      await this.emitMedia(event);
    }
    for (const frame of batch.frames ?? []) {
      await this.emitFrame(frame);
    }
    for (const entry of batch.observations ?? []) {
      await this.emitObservation(entry.participant, entry.observation);
    }

    return { rejoined };
  }

  get lastBatch(): number | null {
    return this.lastBatchAt;
  }
}

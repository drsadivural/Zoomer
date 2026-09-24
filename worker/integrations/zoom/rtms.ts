/**
 * RTMS adapter (Zoom Realtime Media Streams).
 *
 * RTMS is the mechanism Zoom intends for exactly this use case: the meeting
 * pushes media and participant events to an endpoint you own, rather than a bot
 * joining as a participant. When an account has it enabled it is preferable to
 * the Meeting SDK bot — no extra attendee in the meeting, no GPU host running a
 * Zoom client.
 *
 * Status: the handshake and event normalisation are implemented; media frames
 * are not consumed here. A Cloudflare Worker is request-scoped and cannot hold
 * the long-lived media socket, so the media half belongs in a Durable Object or
 * the same GPU host that runs the bot today. That boundary is marked below so
 * the work is a substitution, not a rewrite.
 */
import { BaseZoomAdapter } from "./adapter";
import { hmacSha256Base64 } from "../../lib/crypto";
import type { AdapterKind, MediaEvent, ParticipantEvent, ZoomParticipant } from "./types";

export interface RtmsHandshake {
  meetingUuid: string;
  rtmsStreamId: string;
  serverUrls: string;
}

export interface RtmsCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Zoom authenticates an RTMS connection with an HMAC over
 * `clientId,meetingUuid,streamId`. Signing here — rather than in the transport —
 * keeps the secret in one place and makes the signature unit-testable.
 */
export async function signRtmsHandshake(
  credentials: RtmsCredentials,
  handshake: Pick<RtmsHandshake, "meetingUuid" | "rtmsStreamId">,
): Promise<string> {
  const message = `${credentials.clientId},${handshake.meetingUuid},${handshake.rtmsStreamId}`;
  return hmacSha256Base64(credentials.clientSecret, message);
}

/** Normalises an RTMS participant payload into the shared shape. */
export function toParticipant(raw: Record<string, unknown>): ZoomParticipant {
  return {
    zoomUserId: raw.user_id != null ? String(raw.user_id) : undefined,
    participantUuid: typeof raw.participant_uuid === "string" ? raw.participant_uuid : undefined,
    displayName: typeof raw.user_name === "string" ? raw.user_name : undefined,
    email: typeof raw.email === "string" ? raw.email : undefined,
  };
}

/** Maps an RTMS event name onto the shared participant/media event vocabulary. */
export function toEvent(
  eventName: string,
  raw: Record<string, unknown>,
  at: number,
): ParticipantEvent | MediaEvent | null {
  const participant = toParticipant(raw);
  switch (eventName) {
    case "meeting.participant_joined":
      return { type: "participant.joined", at, participant };
    case "meeting.participant_left":
      return { type: "participant.left", at, participant };
    case "meeting.participant_video_started":
      return { type: "camera.on", at, participant };
    case "meeting.participant_video_stopped":
      return { type: "camera.off", at, participant };
    case "meeting.participant_audio_started":
      return { type: "microphone.on", at, participant };
    case "meeting.participant_audio_muted":
      return { type: "microphone.off", at, participant };
    case "meeting.active_speaker_changed":
      return { type: "speaking.started", at, participant };
    default:
      return null;
  }
}

function isMediaEvent(event: ParticipantEvent | MediaEvent): event is MediaEvent {
  return !event.type.startsWith("participant.");
}

export class RtmsAdapter extends BaseZoomAdapter {
  readonly kind: AdapterKind = "RTMS";

  private handshake: RtmsHandshake | null = null;

  protected async onConnect(meetingId: string): Promise<void> {
    this.meetingId = meetingId;
    // TODO(rtms-media): open the signalling socket from a Durable Object and
    // hand its frames to the GPU analysis worker. Participant/media events
    // below already flow through `deliver()` once the webhook is wired.
  }

  protected async onDisconnect(): Promise<void> {
    this.handshake = null;
  }

  setHandshake(handshake: RtmsHandshake): void {
    this.handshake = handshake;
  }

  get stream(): RtmsHandshake | null {
    return this.handshake;
  }

  /** Delivers one normalised RTMS event into the shared pipeline. */
  async deliver(eventName: string, raw: Record<string, unknown>, at = Date.now()): Promise<void> {
    const event = toEvent(eventName, raw, at);
    if (!event) return;
    if (isMediaEvent(event)) await this.emitMedia(event);
    else await this.emitParticipant(event);
  }
}

/**
 * Zoom ingestion types.
 *
 * Deliberately independent of any one Zoom product: the Meeting SDK, RTMS and
 * the development simulator all produce these shapes. Anything Zoom-specific
 * (a `user_id` that is only unique within one meeting, a participant UUID that
 * changes on rejoin) is normalised at the adapter boundary so nothing
 * downstream has to care which pipe the frame came from.
 */
import type { AnalysisObservation } from "../../services/analysis/participant-state";

/** Which ingestion mechanism is feeding an analysis run. */
export type AdapterKind = "MEETING_SDK" | "RTMS" | "MOCK";

export interface ZoomParticipant {
  /** Per-meeting numeric user id, as a string. */
  zoomUserId?: string;
  /** Stable per-occurrence UUID; changes when the person rejoins. */
  participantUuid?: string;
  displayName?: string;
  email?: string;
  joinedAt?: number;
  leftAt?: number;
  cameraOn?: boolean;
  microphoneOn?: boolean;
  isHost?: boolean;
}

export type ParticipantEventType =
  | "participant.joined"
  | "participant.left"
  | "participant.updated";

export interface ParticipantEvent {
  type: ParticipantEventType;
  at: number;
  participant: ZoomParticipant;
}

export type MediaEventType =
  | "camera.on"
  | "camera.off"
  | "microphone.on"
  | "microphone.off"
  | "speaking.started"
  | "speaking.stopped";

export interface MediaEvent {
  type: MediaEventType;
  at: number;
  participant: Pick<ZoomParticipant, "zoomUserId" | "participantUuid">;
}

/**
 * One sampled video frame for one participant.
 *
 * `jpeg` is a data URL and is optional on purpose: the normal path analyses the
 * frame at the edge and ships only the result, because §5 forbids re-streaming
 * every participant's video into the organizer's browser. A frame is carried
 * only when it is about to become an evidence snapshot or a thumbnail.
 */
export interface VideoFrame {
  participant: Pick<ZoomParticipant, "zoomUserId" | "participantUuid">;
  capturedAt: number;
  width: number;
  height: number;
  jpeg?: string;
}

export type ParticipantEventHandler = (event: ParticipantEvent) => void | Promise<void>;
export type MediaEventHandler = (event: MediaEvent) => void | Promise<void>;
export type VideoFrameHandler = (frame: VideoFrame) => void | Promise<void>;
export type ObservationHandler = (
  participant: Pick<ZoomParticipant, "zoomUserId" | "participantUuid">,
  observation: AnalysisObservation,
) => void | Promise<void>;

export interface AdapterStatus {
  kind: AdapterKind;
  connected: boolean;
  meetingId: string | null;
  participants: number;
  since: number | null;
  lastError: string | null;
}

/**
 * The contract every ingestion mechanism satisfies (§4).
 *
 * Written so a future Zoom Video SDK implementation — which would render the
 * meeting inside Ayonix Zoomer rather than observing it from outside — is a new
 * class here and nothing else (§49).
 */
export interface ZoomMediaAdapter {
  readonly kind: AdapterKind;

  connect(meetingId: string): Promise<void>;
  disconnect(): Promise<void>;
  status(): AdapterStatus;

  getParticipants(): Promise<ZoomParticipant[]>;
  subscribeParticipant(participantId: string): Promise<void>;
  unsubscribeParticipant(participantId: string): Promise<void>;

  onParticipantEvent(callback: ParticipantEventHandler): void;
  onVideoFrame(callback: VideoFrameHandler): void;
  onAudioEvent(callback: MediaEventHandler): void;
  /** Optional: adapters that analyse frames themselves emit results directly. */
  onObservation?(callback: ObservationHandler): void;
}

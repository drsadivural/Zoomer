/**
 * Participant identity normalisation.
 *
 * Zoom hands out three different identifiers and none of them is reliable on
 * its own: `user_id` is unique only within one meeting, the participant UUID
 * changes when somebody rejoins, and the display name is whatever the person
 * typed. Resolution order is fixed here so every adapter agrees on who is who.
 */
import type { MediaEvent, ParticipantEvent, ZoomParticipant } from "./types";

/** Stable-enough key for correlating events within one meeting occurrence. */
export function participantKey(
  participant: Pick<ZoomParticipant, "participantUuid" | "zoomUserId" | "email" | "displayName">,
): string {
  return (
    participant.participantUuid ??
    participant.zoomUserId ??
    participant.email ??
    participant.displayName ??
    "unknown"
  );
}

export function isJoin(event: ParticipantEvent): boolean {
  return event.type === "participant.joined";
}

export function isLeave(event: ParticipantEvent): boolean {
  return event.type === "participant.left";
}

/**
 * Folds a participant event into a roster.
 *
 * A rejoin is detected rather than treated as a new person: the roster entry is
 * reused and `leftAt` cleared, which is what lets the identity service demand a
 * fresh verification on return instead of trusting a cached one.
 */
export function applyParticipantEvent(
  roster: Map<string, ZoomParticipant>,
  event: ParticipantEvent,
): { key: string; rejoined: boolean } {
  const key = participantKey(event.participant);
  const existing = roster.get(key);
  const rejoined = Boolean(existing?.leftAt) && isJoin(event);

  if (isLeave(event)) {
    roster.set(key, { ...existing, ...event.participant, leftAt: event.at });
    return { key, rejoined: false };
  }

  roster.set(key, {
    ...existing,
    ...event.participant,
    joinedAt: rejoined ? event.at : (existing?.joinedAt ?? event.participant.joinedAt ?? event.at),
    leftAt: rejoined ? undefined : existing?.leftAt,
  });
  return { key, rejoined };
}

/** Folds a media event into the roster's camera/microphone flags. */
export function applyMediaEvent(
  roster: Map<string, ZoomParticipant>,
  event: MediaEvent,
): { key: string; cameraOn?: boolean; microphoneOn?: boolean; speaking?: boolean } {
  const key = participantKey(event.participant);
  const existing = roster.get(key) ?? {};
  const patch: Partial<ZoomParticipant> = {};
  let speaking: boolean | undefined;

  switch (event.type) {
    case "camera.on":
      patch.cameraOn = true;
      break;
    case "camera.off":
      patch.cameraOn = false;
      break;
    case "microphone.on":
      patch.microphoneOn = true;
      break;
    case "microphone.off":
      patch.microphoneOn = false;
      break;
    case "speaking.started":
      speaking = true;
      break;
    case "speaking.stopped":
      speaking = false;
      break;
  }

  roster.set(key, { ...existing, ...patch });
  return { key, cameraOn: patch.cameraOn, microphoneOn: patch.microphoneOn, speaking };
}

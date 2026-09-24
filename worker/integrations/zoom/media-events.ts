/**
 * Media-event → observation mapping.
 *
 * Camera and microphone state come from Zoom directly. They are facts, not
 * inferences, and are treated as such: a camera-off observation carries no
 * face, no pose and no gaze, because there is genuinely nothing to measure.
 * Filling those in from the last known values would make the dashboard lie.
 */
import type { AnalysisObservation } from "../../services/analysis/participant-state";
import type { MediaEvent } from "./types";

export function observationFromMediaEvent(event: MediaEvent): Partial<AnalysisObservation> | null {
  switch (event.type) {
    case "camera.off":
      return {
        observedAt: event.at,
        cameraOn: false,
        faceDetected: false,
        faceCount: 0,
        pose: null,
        gazeHorizontal: null,
        gazeVertical: null,
      };
    case "camera.on":
      return { observedAt: event.at, cameraOn: true };
    case "microphone.on":
      return { observedAt: event.at, microphoneOn: true };
    case "microphone.off":
      return { observedAt: event.at, microphoneOn: false, speaking: false };
    case "speaking.started":
      return { observedAt: event.at, speaking: true, microphoneOn: true };
    case "speaking.stopped":
      return { observedAt: event.at, speaking: false };
    default:
      return null;
  }
}

/** Merges a partial media observation onto a full one from the vision pipeline. */
export function mergeObservation(
  base: AnalysisObservation,
  patch: Partial<AnalysisObservation> | null,
): AnalysisObservation {
  if (!patch) return base;
  return { ...base, ...patch, observedAt: Math.max(base.observedAt, patch.observedAt ?? 0) };
}

/**
 * Head-pose normalisation and bucketing.
 *
 * Sign convention (documented because every vision SDK picks a different one,
 * and an adapter that disagrees will silently mirror the dashboard):
 *   yaw   > 0  the participant turned toward their own RIGHT
 *   pitch > 0  the participant tilted their head UP
 *   roll  > 0  the participant tilted their head toward their own right shoulder
 * Angles are degrees in the camera's frame — never mirrored.
 */
import type { MeetingMonitoringConfig } from "../monitoring/config";
import type { HeadState } from "../monitoring/signals";

export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

const LIMIT = 90;

function clampAngle(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(-LIMIT, Math.min(LIMIT, value));
}

/** Rejects non-finite or out-of-range angles rather than propagating them. */
export function normalizeHeadPose(input: Partial<HeadPose> | null | undefined): HeadPose | null {
  if (!input) return null;
  const yaw = clampAngle(input.yaw);
  const pitch = clampAngle(input.pitch);
  const roll = clampAngle(input.roll);
  if (yaw == null || pitch == null) return null;
  return { yaw, pitch, roll: roll ?? 0 };
}

/**
 * Buckets a pose into a direction.
 *
 * When several axes are past their thresholds the one that exceeds it by the
 * greatest *relative* margin wins, so a small yaw plus a large downward pitch
 * reads as DOWN rather than as whichever axis happens to be tested first.
 */
export function headState(
  pose: HeadPose | null,
  config: Pick<
    MeetingMonitoringConfig,
    "yawThresholdDeg" | "pitchUpThresholdDeg" | "pitchDownThresholdDeg"
  >,
): HeadState {
  if (!pose) return "UNKNOWN";

  const yawT = Math.max(1, config.yawThresholdDeg);
  const upT = Math.max(1, config.pitchUpThresholdDeg);
  const downT = Math.max(1, config.pitchDownThresholdDeg);

  const candidates: { state: HeadState; margin: number }[] = [];
  if (pose.yaw >= yawT) candidates.push({ state: "RIGHT", margin: pose.yaw / yawT });
  if (pose.yaw <= -yawT) candidates.push({ state: "LEFT", margin: -pose.yaw / yawT });
  if (pose.pitch >= upT) candidates.push({ state: "UP", margin: pose.pitch / upT });
  if (pose.pitch <= -downT) candidates.push({ state: "DOWN", margin: -pose.pitch / downT });

  if (!candidates.length) return "FORWARD";
  return candidates.sort((a, b) => b.margin - a.margin)[0].state;
}

/** Maps a head direction onto the corresponding observable engagement state. */
export function headStateToEngagement(state: HeadState) {
  switch (state) {
    case "LEFT":
      return "LOOKING_LEFT" as const;
    case "RIGHT":
      return "LOOKING_RIGHT" as const;
    case "UP":
      return "LOOKING_UP" as const;
    case "DOWN":
      return "LOOKING_DOWN" as const;
    case "FORWARD":
      return "SCREEN_FACING" as const;
    default:
      return "UNKNOWN" as const;
  }
}

/**
 * Screen-facing estimation.
 *
 * "Screen-facing" is a geometric claim — the face is oriented at the camera —
 * and nothing more. It is never evidence that someone is paying attention, and
 * the UI must not present it as such.
 *
 * A single frame is never enough: heads move constantly during normal listening,
 * so the raw per-frame probability is smoothed exponentially and the caller is
 * given a confidence that grows with the number of samples behind it.
 */
import type { HeadPose } from "./head-pose";

export interface GazeInput {
  pose: HeadPose | null;
  /** Iris offset in [-1, 1]; negative is toward the participant's left. */
  gazeHorizontal?: number | null;
  gazeVertical?: number | null;
  /** Detector confidence for the face this pose came from. */
  detectionConfidence?: number | null;
  faceDetected: boolean;
}

export interface ScreenFacingResult {
  screenFacingProbability: number;
  gazeHorizontal: number | null;
  gazeVertical: number | null;
  confidence: number;
}

const DEG = Math.PI / 180;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Instantaneous probability from one observation.
 *
 * The angular term is a cosine falloff (1.0 head-on, ~0.9 at 25°, 0 at 90°),
 * which matches how quickly a face stops being readable off-axis. Iris offset,
 * when the provider supplies it, contributes a third of the weight: eyes can be
 * on the screen while the head is turned, and vice versa.
 */
export function instantScreenFacing(input: GazeInput): number {
  if (!input.faceDetected || !input.pose) return 0;

  const yawTerm = Math.max(0, Math.cos(input.pose.yaw * DEG));
  const pitchTerm = Math.max(0, Math.cos(input.pose.pitch * DEG));
  const angular = clamp01(yawTerm * pitchTerm);

  const gh = input.gazeHorizontal;
  const gv = input.gazeVertical;
  if (gh == null && gv == null) return angular;

  const offset = Math.hypot(gh ?? 0, gv ?? 0);
  const gazeTerm = clamp01(1 - Math.min(1, offset));
  return clamp01(0.65 * angular + 0.35 * gazeTerm);
}

/** Exponential smoothing horizon: ~5 samples to move most of the way. */
const ALPHA = 0.35;
const CONFIDENCE_SAMPLES = 5;

/**
 * Per-participant smoother. Stateless callers (a Worker handling one request)
 * rehydrate it from the stored probability, so smoothing survives across
 * requests without keeping anything in memory.
 */
export class ScreenFacingSmoother {
  private value: number | null;
  private samples: number;

  constructor(previous?: number | null, samples = 0) {
    this.value = previous ?? null;
    this.samples = samples;
  }

  push(input: GazeInput): ScreenFacingResult {
    const instant = instantScreenFacing(input);
    this.value = this.value == null ? instant : this.value + ALPHA * (instant - this.value);
    this.samples++;

    const maturity = Math.min(1, this.samples / CONFIDENCE_SAMPLES);
    const detection = clamp01(input.detectionConfidence ?? (input.faceDetected ? 0.8 : 0));
    return {
      screenFacingProbability: Number(clamp01(this.value).toFixed(4)),
      gazeHorizontal: input.gazeHorizontal ?? null,
      gazeVertical: input.gazeVertical ?? null,
      confidence: Number(clamp01(maturity * detection).toFixed(4)),
    };
  }

  get current(): number | null {
    return this.value;
  }
}

/**
 * One-shot smoothing for the request/response path: blends the new observation
 * into whatever the participant's stored probability was.
 */
export function smoothScreenFacing(
  previous: number | null | undefined,
  input: GazeInput,
  previousSamples = CONFIDENCE_SAMPLES,
): ScreenFacingResult {
  return new ScreenFacingSmoother(previous ?? null, previous == null ? 0 : previousSamples).push(input);
}

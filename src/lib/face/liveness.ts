/**
 * Passive + active liveness.
 *
 * A still photograph held to the camera produces a stable eye-aspect-ratio and
 * almost no landmark motion. Requiring a real blink plus some natural movement
 * defeats the cheapest presentation attacks (printed photo, phone screen).
 *
 * This is a first line of defence, not a certified PAD implementation.
 * TEST_PLAN.md §2 requires measuring it against photo, screen-replay and mask
 * attacks before relying on it in production.
 */
import { EAR_CLOSED_THRESHOLD, type FaceObservation } from "./engine";

export interface LivenessState {
  blinks: number;
  motionScore: number;
  passed: boolean;
  /** Frames observed so far; used to avoid judging too early. */
  frames: number;
}

export interface LivenessResult extends LivenessState {
  hint: string;
}

const MIN_FRAMES = 20;
const REQUIRED_BLINKS = 1;
const MIN_MOTION = 0.004;

export class LivenessDetector {
  private blinks = 0;
  private eyesClosed = false;
  private frames = 0;
  private motionSamples: number[] = [];
  private previous: { x: number; y: number }[] | null = null;

  reset(): void {
    this.blinks = 0;
    this.eyesClosed = false;
    this.frames = 0;
    this.motionSamples = [];
    this.previous = null;
  }

  observe(face: FaceObservation | null): LivenessResult {
    if (!face) {
      // Losing the face invalidates motion continuity but keeps blink credit.
      this.previous = null;
      return this.result("顔が検出できません。カメラの正面を向いてください");
    }

    this.frames++;

    // A blink is a closed→open transition, not merely a closed frame.
    if (face.eyeAspectRatio < EAR_CLOSED_THRESHOLD) {
      this.eyesClosed = true;
    } else if (this.eyesClosed) {
      this.eyesClosed = false;
      this.blinks++;
    }

    if (this.previous && this.previous.length === face.landmarks.length) {
      // Normalise displacement by face width so motion is scale-invariant.
      const scale = face.box.width || 1;
      let total = 0;
      for (let i = 0; i < face.landmarks.length; i++) {
        total += Math.hypot(
          face.landmarks[i].x - this.previous[i].x,
          face.landmarks[i].y - this.previous[i].y,
        );
      }
      this.motionSamples.push(total / face.landmarks.length / scale);
      if (this.motionSamples.length > 60) this.motionSamples.shift();
    }
    this.previous = face.landmarks;

    return this.result(
      this.blinks < REQUIRED_BLINKS
        ? "画面を見ながら、ゆっくり瞬きしてください"
        : "確認しています。そのままお待ちください",
    );
  }

  private result(hint: string): LivenessResult {
    const motionScore = this.motionSamples.length
      ? Math.min(1, this.motionSamples.reduce((a, b) => a + b, 0) / this.motionSamples.length / 0.02)
      : 0;
    const rawMotion = this.motionSamples.length
      ? this.motionSamples.reduce((a, b) => a + b, 0) / this.motionSamples.length
      : 0;

    const passed =
      this.frames >= MIN_FRAMES && this.blinks >= REQUIRED_BLINKS && rawMotion >= MIN_MOTION;

    return { blinks: this.blinks, motionScore, passed, frames: this.frames, hint };
  }
}

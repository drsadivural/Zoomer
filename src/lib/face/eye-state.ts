/**
 * Eye open/closed detection via MediaPipe Face Landmarker blendshapes.
 *
 * face-api's 68-point EAR cannot separate open from closed eyes (measured: open
 * ≈0.30, closed ≈0.24-0.33 — fully overlapping). MediaPipe's `eyeBlink`
 * blendshape does: open ≈0.1-0.35, closed ≈0.6-0.9. We use it purely for the
 * eye-closure (居眠り疑い) signal; face-api still handles detection, quality and
 * the recognition descriptor.
 *
 * The model + wasm are self-hosted under /mediapipe (no third-party CDN), and
 * the module is dynamically imported so it is only fetched on camera screens.
 */
type Vision = typeof import("@mediapipe/tasks-vision");
// FaceLandmarker has a private constructor (built via createFromOptions), so
// take the instance type from that static factory rather than InstanceType.
type FaceLandmarkerT = Awaited<ReturnType<Vision["FaceLandmarker"]["createFromOptions"]>>;
type BlendCategory = { categoryName: string; score: number };

/** blink ≥ this ⇒ eyes closed; < RELEASE ⇒ open (hysteresis avoids flicker). */
export const EYE_BLINK_CLOSED = 0.5;
export const EYE_BLINK_OPEN = 0.4;

let landmarker: FaceLandmarkerT | null = null;
let loadPromise: Promise<void> | null = null;

export function loadEyeModel(base = "/mediapipe"): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(`${base}/wasm`);
      landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}/face_landmarker.task` },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });
    })().catch((err) => {
      loadPromise = null; // allow retry after a transient failure
      throw err;
    });
  }
  return loadPromise;
}

export function eyeModelReady(): boolean {
  return landmarker !== null;
}

let lastTs = 0;

/**
 * Blink score in [0,1] (mean of both eyes) for the frame, or null if the model
 * is not ready or no face was found. `detectForVideo` needs strictly increasing
 * timestamps.
 */
export function detectBlink(video: HTMLVideoElement, tsMs: number): number | null {
  if (!landmarker || !video.videoWidth) return null;
  const ts = tsMs <= lastTs ? lastTs + 1 : tsMs;
  lastTs = ts;
  let result;
  try {
    result = landmarker.detectForVideo(video, ts);
  } catch {
    return null;
  }
  const cats = result.faceBlendshapes?.[0]?.categories as BlendCategory[] | undefined;
  if (!cats) return null;
  const score = (name: string) => cats.find((c) => c.categoryName === name)?.score ?? null;
  const l = score("eyeBlinkLeft");
  const r = score("eyeBlinkRight");
  if (l == null || r == null) return null;
  return (l + r) / 2;
}

/** Applies hysteresis to a stream of blink scores to decide closed vs open. */
export class BlinkTracker {
  private closed = false;

  reset(): void {
    this.closed = false;
  }

  update(blink: number | null): boolean {
    if (blink == null) return this.closed;
    if (blink >= EYE_BLINK_CLOSED) this.closed = true;
    else if (blink < EYE_BLINK_OPEN) this.closed = false;
    return this.closed;
  }
}

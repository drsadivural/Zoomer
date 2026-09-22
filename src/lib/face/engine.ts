/**
 * On-device face engine.
 *
 * Everything in this module runs in the trainee's browser (ARCHITECTURE.md
 * §2.1): frames never leave the device. What crosses the network is a 128-float
 * descriptor, a handful of quality numbers, and — only when a rule fires and
 * policy allows — a single JPEG frame as evidence.
 *
 * The engine is deliberately behind a narrow interface. Swapping in the Ayonix
 * Web SDK means implementing `FaceEngine` and changing `ENGINE_ID`; nothing
 * else in the app needs to know.
 */
// Loaded on demand: the model runtime is ~1.3 MB and is only needed on the two
// screens that actually use a camera, never on the admin dashboards.
type FaceApi = typeof import("@vladmandic/face-api");

let faceapi: FaceApi | null = null;

async function ensureModule(): Promise<FaceApi> {
  faceapi ??= await import("@vladmandic/face-api");
  return faceapi;
}

/** Identifies the descriptor space. The server refuses to compare across engines. */
export const ENGINE_ID = "faceapi-128";
export const MODEL_VERSION = "face-api-1.7.15/tiny+landmark68+recognition";

export interface FaceObservation {
  /** Bounding box in video pixel coordinates. */
  box: { x: number; y: number; width: number; height: number };
  score: number;
  landmarks: { x: number; y: number }[];
  descriptor: Float32Array | null;
  /** Mean of the two eyes' aspect ratios; low means closed. */
  eyeAspectRatio: number;
}

export interface FrameAnalysis {
  faces: FaceObservation[];
  faceCount: number;
  /** Quality of the largest face, in the shape the API expects. */
  quality: QualityMetrics;
  width: number;
  height: number;
}

export interface QualityMetrics {
  faceCount: number;
  relativeSize: number;
  yaw: number;
  pitch: number;
  brightness: number;
  sharpness: number;
  occlusion: number;
}

export const EMPTY_QUALITY: QualityMetrics = {
  faceCount: 0,
  relativeSize: 0,
  yaw: 0,
  pitch: 0,
  brightness: 0,
  sharpness: 0,
  occlusion: 1,
};

/** Below this the eye is treated as closed. Used by blink/liveness detection,
 *  where a sharp transient is what matters. Sustained-closure (drowsiness)
 *  detection uses the adaptive tracker below instead. */
export const EAR_CLOSED_THRESHOLD = 0.21;

/**
 * Sustained eye-closure, judged relative to the person's own open-eye baseline.
 * face-api's 68-point EAR sits near ~0.30 for open eyes and only drops modestly
 * on closure, and its absolute value varies a lot by face, camera and distance —
 * so a fixed cutoff misses real closures. A relative one is both more sensitive
 * and self-calibrating.
 */
export const EYE_CLOSED_RATIO = 0.8; // closed when EAR < this × open baseline
export const EYE_CLOSED_CAP = 0.27;  // effective cutoff never demands eyes wider than this
export const EYE_CLOSED_FLOOR = 0.16; // …and never triggers above near-shut eyes
export const EYE_BASELINE_MIN = 0.18; // need a plausible open baseline before trusting closure

export function eyeCutoff(baseline: number): number {
  return Math.min(EYE_CLOSED_CAP, Math.max(EYE_CLOSED_FLOOR, baseline * EYE_CLOSED_RATIO));
}

export interface EyeClosureState {
  ear: number | null;
  baseline: number;
  closed: boolean;
}

/**
 * Tracks the running open-eye EAR baseline (slow decay so a long blink cannot
 * drag it down) and reports whether the current frame's eye is closed relative
 * to it. Feed the largest face's EAR each frame, or null when no face is present.
 */
export class EyeClosureTracker {
  private baseline = 0;

  reset(): void {
    this.baseline = 0;
  }

  update(ear: number | null): EyeClosureState {
    if (ear != null) this.baseline = Math.max(ear, this.baseline * 0.999);
    const baseline = this.baseline;
    const closed = ear != null && baseline >= EYE_BASELINE_MIN && ear < eyeCutoff(baseline);
    return { ear, baseline, closed };
  }
}

/**
 * face-api bundles its own TFJS runtime and re-exports it as `tf`, but the
 * published types do not surface the backend helpers. Narrow to what we call.
 */
type TfRuntime = { setBackend(name: string): Promise<boolean>; ready(): Promise<void> };

let loadPromise: Promise<void> | null = null;

/** Loads weights from our own origin — no third-party CDN fetch. */
export function loadModels(basePath = "/models"): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const api = await ensureModule();
      // WebGL where available; CPU is slower but keeps older machines working.
      const tf = api.tf as unknown as TfRuntime;
      await tf.setBackend("webgl").catch(() => tf.setBackend("cpu"));
      await tf.ready();
      await Promise.all([
        api.nets.tinyFaceDetector.loadFromUri(basePath),
        api.nets.faceLandmark68Net.loadFromUri(basePath),
        api.nets.faceRecognitionNet.loadFromUri(basePath),
      ]);
    })().catch((err) => {
      // Reset so a transient network failure can be retried.
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

export function modelsReady(): boolean {
  return Boolean(
    faceapi?.nets.tinyFaceDetector.isLoaded &&
      faceapi.nets.faceLandmark68Net.isLoaded &&
      faceapi.nets.faceRecognitionNet.isLoaded,
  );
}

let detectorOptions: InstanceType<FaceApi["TinyFaceDetectorOptions"]> | null = null;

/** Built once the module is loaded; 320px input keeps detection real-time. */
function detectorOpts(api: FaceApi) {
  detectorOptions ??= new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });
  return detectorOptions;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Eye Aspect Ratio over the 68-point model.
 * Left eye is points 36–41, right eye 42–47; for each,
 * EAR = (|p2−p6| + |p3−p5|) / (2·|p1−p4|).
 */
function eyeAspectRatio(points: { x: number; y: number }[]): number {
  if (points.length < 48) return 1;
  const ear = (i: number) => {
    const p = points.slice(i, i + 6);
    const horizontal = distance(p[0], p[3]);
    if (horizontal === 0) return 1;
    return (distance(p[1], p[5]) + distance(p[2], p[4])) / (2 * horizontal);
  };
  return (ear(36) + ear(42)) / 2;
}

/**
 * Head pose approximated from landmark geometry rather than a full 3D solve.
 * Yaw comes from the nose's horizontal offset between the eye corners; pitch
 * from where the nose tip sits between the eye line and the mouth. Accurate
 * enough to reject non-frontal enrollment photos, which is all it is used for.
 */
function estimatePose(points: { x: number; y: number }[]): { yaw: number; pitch: number } {
  if (points.length < 68) return { yaw: 0, pitch: 0 };
  const leftEyeOuter = points[36];
  const rightEyeOuter = points[45];
  const noseTip = points[30];
  const mouthTop = points[51];

  const eyeSpan = distance(leftEyeOuter, rightEyeOuter);
  if (eyeSpan === 0) return { yaw: 0, pitch: 0 };

  const eyeMidX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
  // Normalised offset in [-1, 1]; scaled to roughly radians of yaw.
  const yaw = ((noseTip.x - eyeMidX) / (eyeSpan / 2)) * 0.6;

  const eyeMidY = (leftEyeOuter.y + rightEyeOuter.y) / 2;
  const faceHeight = Math.abs(mouthTop.y - eyeMidY);
  const expected = 0.5;
  const actual = faceHeight > 0 ? (noseTip.y - eyeMidY) / faceHeight : expected;
  const pitch = (actual - expected) * 1.2;

  return { yaw, pitch };
}

/** Mean luminance and Laplacian-variance sharpness over the face crop. */
function measureExposure(
  source: HTMLVideoElement | HTMLCanvasElement,
  box: { x: number; y: number; width: number; height: number },
): { brightness: number; sharpness: number } {
  const SIZE = 48;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { brightness: 0.5, sharpness: 0.5 };

  ctx.drawImage(
    source,
    Math.max(0, box.x),
    Math.max(0, box.y),
    Math.max(1, box.width),
    Math.max(1, box.height),
    0,
    0,
    SIZE,
    SIZE,
  );

  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const grey = new Float32Array(SIZE * SIZE);
  let sum = 0;
  for (let i = 0; i < grey.length; i++) {
    const o = i * 4;
    // Rec. 601 luma.
    const y = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    grey[i] = y;
    sum += y;
  }
  const brightness = sum / grey.length / 255;

  // 4-neighbour Laplacian; its variance rises with edge content, i.e. focus.
  let mean = 0;
  const lap = new Float32Array(grey.length);
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const i = y * SIZE + x;
      const v =
        4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - SIZE] - grey[i + SIZE];
      lap[i] = v;
      mean += v;
    }
  }
  mean /= grey.length;
  let variance = 0;
  for (let i = 0; i < lap.length; i++) variance += (lap[i] - mean) ** 2;
  variance /= lap.length;

  // Normalised against an empirical "in focus" variance of ~500.
  const sharpness = Math.max(0, Math.min(1, variance / 500));
  return { brightness, sharpness };
}

export interface AnalyseOptions {
  /** Descriptors cost real time; skip them on frames that only need presence. */
  withDescriptor?: boolean;
}

export async function analyseFrame(
  video: HTMLVideoElement,
  options: AnalyseOptions = {},
): Promise<FrameAnalysis> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height || !modelsReady() || !faceapi) {
    return { faces: [], faceCount: 0, quality: EMPTY_QUALITY, width, height };
  }

  const api = faceapi;
  // withFaceLandmarks() uses the full 68-point net that loadModels() loads;
  // passing `true` would select the tiny landmark net, which is neither loaded
  // nor shipped in public/models and throws once a face is actually found.
  const base = api.detectAllFaces(video, detectorOpts(api)).withFaceLandmarks();
  const results = options.withDescriptor ? await base.withFaceDescriptors() : await base;

  const faces: FaceObservation[] = results.map((r) => {
    const points = r.landmarks.positions.map((p) => ({ x: p.x, y: p.y }));
    return {
      box: {
        x: r.detection.box.x,
        y: r.detection.box.y,
        width: r.detection.box.width,
        height: r.detection.box.height,
      },
      score: r.detection.score,
      landmarks: points,
      descriptor: "descriptor" in r ? (r.descriptor as Float32Array) : null,
      eyeAspectRatio: eyeAspectRatio(points),
    };
  });

  if (!faces.length) {
    return { faces, faceCount: 0, quality: { ...EMPTY_QUALITY }, width, height };
  }

  // Quality is always reported for the largest face — the presumed subject.
  const primary = faces.reduce((a, b) =>
    a.box.width * a.box.height >= b.box.width * b.box.height ? a : b,
  );
  const { yaw, pitch } = estimatePose(primary.landmarks);
  const { brightness, sharpness } = measureExposure(video, primary.box);

  return {
    faces,
    faceCount: faces.length,
    quality: {
      faceCount: faces.length,
      relativeSize: (primary.box.width * primary.box.height) / (width * height),
      yaw,
      pitch,
      brightness,
      sharpness,
      // Proxy only: the detector gives no occlusion signal, so a low detection
      // score stands in for it. Documented as a proxy, not a measurement.
      occlusion: Math.max(0, Math.min(1, 1 - primary.score)),
    },
    width,
    height,
  };
}

export function largestFace(analysis: FrameAnalysis): FaceObservation | null {
  if (!analysis.faces.length) return null;
  return analysis.faces.reduce((a, b) =>
    a.box.width * a.box.height >= b.box.width * b.box.height ? a : b,
  );
}

/** Captures a JPEG frame for evidence. Quality comes from org settings. */
export function captureFrame(video: HTMLVideoElement, quality = 0.72, maxWidth = 640): string {
  const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((video.videoWidth || maxWidth) * scale);
  canvas.height = Math.round((video.videoHeight || maxWidth) * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

export function descriptorToArray(descriptor: Float32Array): number[] {
  return Array.from(descriptor);
}

/** Mirrors the server's comparison so the UI can show a live match figure. */
export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

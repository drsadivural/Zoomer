/**
 * Continuous monitoring state machine for the trainee client.
 *
 * Responsibilities:
 *  - track how long a condition has persisted, so a single bad frame never
 *    raises anything (実装指示: 連続判定で確定);
 *  - propose events with durations and counts, leaving the authoritative
 *    severity decision to the server;
 *  - buffer events while offline and flush them with retry.
 *
 * Matching is *not* done here. The live descriptor is posted to the server,
 * which holds the enrolled template — so the template never reaches the browser.
 */
import { analyseFrame, captureFrame, descriptorToArray, EyeClosureTracker, largestFace, MODEL_VERSION } from "./engine";
import { BlinkTracker, detectBlink, eyeModelReady, loadEyeModel } from "./eye-state";

export interface MonitorRules {
  reauthIntervalSec: number;
  absenceSec: number;
  eyesClosedSec: number;
  multiFaceFrames: number;
  evidenceIntervalSec: number;
}

export type MonitorEventType =
  | "FACE_ABSENT"
  | "MULTIPLE_FACES"
  | "EYES_CLOSED"
  | "CAMERA_BLOCKED"
  | "CAMERA_STOPPED"
  | "TAB_HIDDEN"
  | "NETWORK_LOST"
  | "HEARTBEAT";

export interface ProposedEvent {
  eventId: string;
  type: MonitorEventType;
  capturedAt: number;
  durationMs?: number;
  faceCount?: number;
  frameCount?: number;
  qualityScore?: number;
  modelVersion?: string;
  evidence?: string;
}

export interface MonitorStatus {
  faceCount: number;
  eyesClosedMs: number;
  absentMs: number;
  multiFaceFrames: number;
  lastMatchScore: number | null;
  lastReauthAt: number | null;
  queued: number;
  online: boolean;
  message: string;
  tone: "success" | "warning" | "danger" | "neutral";
}

export interface MonitorCallbacks {
  sendEvents: (events: ProposedEvent[]) => Promise<void>;
  reauth: (descriptor: number[], qualityScore: number) => Promise<{ matchScore: number; passed: boolean }>;
  onStatus: (status: MonitorStatus) => void;
}

/** ULID-ish client id: sortable and unique enough to be an idempotency key. */
function eventId(): string {
  const t = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const r = crypto.getRandomValues(new Uint8Array(10));
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let tail = "";
  for (const b of r) tail += chars[b % chars.length];
  return `evt_${t}${tail}`.slice(0, 30);
}

/** Re-emit an ongoing condition at most this often, so alerts refresh but do not flood. */
const REPEAT_INTERVAL_MS = 30_000;

export class MonitoringLoop {
  private raf: number | null = null;
  private timer: number | null = null;
  private queue: ProposedEvent[] = [];
  private flushing = false;
  private stopped = true;

  private absentSince: number | null = null;
  private absentReportedAt: number | null = null;
  private eyesClosedSince: number | null = null;
  private readonly eyeTracker = new EyeClosureTracker();
  private readonly blinkTracker = new BlinkTracker();
  private eyesClosedReportedAt: number | null = null;
  private multiFaceFrames = 0;
  private multiFaceReportedAt: number | null = null;
  private hiddenSince: number | null = null;

  private lastReauthAt: number | null = null;
  private lastEvidenceAt: number | null = null;
  private lastMatchScore: number | null = null;
  private lastFaceCount = 0;
  private reauthInFlight = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly rules: MonitorRules,
    private readonly callbacks: MonitorCallbacks,
    private readonly imageQuality = 0.72,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.eyeTracker.reset();
    this.blinkTracker.reset();
    void loadEyeModel().catch(() => undefined);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    this.video.srcObject instanceof MediaStream &&
      this.video.srcObject.getVideoTracks().forEach((t) => t.addEventListener("ended", this.onTrackEnded));

    // ~4 fps: enough to time conditions to the second without pinning the CPU
    // for eight hours of training.
    this.timer = window.setInterval(() => void this.tick(), 250);
    this.flushLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) window.clearInterval(this.timer);
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.timer = null;
    this.raf = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.hiddenSince = Date.now();
    } else if (this.hiddenSince) {
      const durationMs = Date.now() - this.hiddenSince;
      this.hiddenSince = null;
      // Report on return, when the true duration is known.
      this.enqueue({ eventId: eventId(), type: "TAB_HIDDEN", capturedAt: Date.now(), durationMs });
    }
  };

  private onOnline = () => this.flushLoop();
  private onOffline = () =>
    this.enqueue({ eventId: eventId(), type: "NETWORK_LOST", capturedAt: Date.now() });
  private onTrackEnded = () =>
    this.enqueue({ eventId: eventId(), type: "CAMERA_STOPPED", capturedAt: Date.now() });

  private enqueue(event: ProposedEvent): void {
    this.queue.push(event);
    // Cap the offline buffer; oldest events are the least actionable.
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
  }

  private async tick(): Promise<void> {
    if (this.stopped || document.hidden) return;

    let analysis;
    try {
      analysis = await analyseFrame(this.video, { withDescriptor: false });
    } catch {
      return; // A dropped frame is not an event.
    }

    const now = Date.now();
    this.lastFaceCount = analysis.faceCount;
    const face = largestFace(analysis);

    /* ---- absence ---- */
    if (analysis.faceCount === 0) {
      this.absentSince ??= now;
      const durationMs = now - this.absentSince;
      const due =
        durationMs >= this.rules.absenceSec * 1000 &&
        (!this.absentReportedAt || now - this.absentReportedAt >= REPEAT_INTERVAL_MS);
      if (due) {
        this.absentReportedAt = now;
        this.enqueue({
          eventId: eventId(),
          type: "FACE_ABSENT",
          capturedAt: now,
          durationMs,
          faceCount: 0,
          modelVersion: MODEL_VERSION,
          evidence: this.snapshot(),
        });
      }
    } else {
      this.absentSince = null;
      this.absentReportedAt = null;
    }

    /* ---- multiple people ---- */
    if (analysis.faceCount >= 2) {
      this.multiFaceFrames++;
      const due =
        this.multiFaceFrames >= this.rules.multiFaceFrames &&
        (!this.multiFaceReportedAt || now - this.multiFaceReportedAt >= REPEAT_INTERVAL_MS);
      if (due) {
        this.multiFaceReportedAt = now;
        this.enqueue({
          eventId: eventId(),
          type: "MULTIPLE_FACES",
          capturedAt: now,
          faceCount: analysis.faceCount,
          frameCount: this.multiFaceFrames,
          modelVersion: MODEL_VERSION,
          evidence: this.snapshot(),
        });
      }
    } else {
      this.multiFaceFrames = 0;
      this.multiFaceReportedAt = null;
    }

    /* ---- eyes closed (drowsiness *suspicion* only) ---- */
    // Prefer MediaPipe's eyeBlink blendshape (reliable); fall back to the
    // face-api EAR tracker if the MediaPipe model has not loaded.
    let eyeClosed: boolean;
    if (eyeModelReady()) {
      const blink = detectBlink(this.video, performance.now());
      eyeClosed = blink != null ? this.blinkTracker.update(blink) : false;
      if (blink == null) this.blinkTracker.reset();
    } else {
      eyeClosed = this.eyeTracker.update(face ? face.eyeAspectRatio : null).closed;
    }
    if (eyeClosed) {
      this.eyesClosedSince ??= now;
      const durationMs = now - this.eyesClosedSince;
      const due =
        durationMs >= this.rules.eyesClosedSec * 1000 &&
        (!this.eyesClosedReportedAt || now - this.eyesClosedReportedAt >= REPEAT_INTERVAL_MS);
      if (due) {
        this.eyesClosedReportedAt = now;
        this.enqueue({
          eventId: eventId(),
          type: "EYES_CLOSED",
          capturedAt: now,
          durationMs,
          faceCount: analysis.faceCount,
          modelVersion: MODEL_VERSION,
          evidence: this.snapshot(),
        });
      }
    } else {
      this.eyesClosedSince = null;
      this.eyesClosedReportedAt = null;
    }

    /* ---- camera obstructed: a frame that is present but unusably dark ---- */
    if (analysis.faceCount === 0 && analysis.quality.brightness > 0 && analysis.quality.brightness < 0.06) {
      const durationMs = this.absentSince ? now - this.absentSince : 0;
      if (durationMs > 5000 && (!this.absentReportedAt || now - this.absentReportedAt >= REPEAT_INTERVAL_MS)) {
        this.absentReportedAt = now;
        this.enqueue({ eventId: eventId(), type: "CAMERA_BLOCKED", capturedAt: now, durationMs });
      }
    }

    /* ---- periodic re-authentication (server-side comparison) ---- */
    const reauthDue =
      !this.reauthInFlight &&
      analysis.faceCount === 1 &&
      (!this.lastReauthAt || now - this.lastReauthAt >= this.rules.reauthIntervalSec * 1000);
    if (reauthDue) void this.runReauth();

    /* ---- periodic evidence ---- */
    if (
      this.rules.evidenceIntervalSec > 0 &&
      (!this.lastEvidenceAt || now - this.lastEvidenceAt >= this.rules.evidenceIntervalSec * 1000)
    ) {
      this.lastEvidenceAt = now;
      this.enqueue({
        eventId: eventId(),
        type: "HEARTBEAT",
        capturedAt: now,
        faceCount: analysis.faceCount,
        qualityScore: analysis.quality.sharpness,
        modelVersion: MODEL_VERSION,
      });
    }

    this.report();
  }

  private async runReauth(): Promise<void> {
    this.reauthInFlight = true;
    try {
      const analysis = await analyseFrame(this.video, { withDescriptor: true });
      const face = largestFace(analysis);
      if (!face?.descriptor) return;
      const result = await this.callbacks.reauth(
        descriptorToArray(face.descriptor),
        analysis.quality.sharpness,
      );
      this.lastMatchScore = result.matchScore;
      this.lastReauthAt = Date.now();
    } catch {
      // Leave lastReauthAt unchanged so the next tick retries.
    } finally {
      this.reauthInFlight = false;
      this.report();
    }
  }

  private snapshot(): string | undefined {
    try {
      return captureFrame(this.video, this.imageQuality) || undefined;
    } catch {
      return undefined;
    }
  }

  private flushLoop(): void {
    if (this.flushing) return;
    this.flushing = true;
    const pump = async () => {
      while (!this.stopped) {
        if (this.queue.length && navigator.onLine) {
          const batch = this.queue.slice(0, 20);
          try {
            await this.callbacks.sendEvents(batch);
            this.queue.splice(0, batch.length);
          } catch {
            // Keep the batch and back off; the buffer is the retry mechanism.
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
        this.report();
      }
      this.flushing = false;
    };
    void pump();
  }

  private report(): void {
    const now = Date.now();
    const absentMs = this.absentSince ? now - this.absentSince : 0;
    const eyesClosedMs = this.eyesClosedSince ? now - this.eyesClosedSince : 0;

    let message = "受講中";
    let tone: MonitorStatus["tone"] = "success";
    if (!navigator.onLine) {
      message = "オフライン（記録を保持しています）";
      tone = "warning";
    } else if (this.lastFaceCount === 0) {
      message = absentMs > 3000 ? "顔が検出できません" : "検出中";
      tone = absentMs > 3000 ? "warning" : "neutral";
    } else if (this.lastFaceCount >= 2) {
      message = `複数人を検出しています（${this.lastFaceCount}名）`;
      tone = "danger";
    } else if (eyesClosedMs > 2000) {
      message = "閉眼を検出しています";
      tone = "warning";
    }

    this.callbacks.onStatus({
      faceCount: this.lastFaceCount,
      eyesClosedMs,
      absentMs,
      multiFaceFrames: this.multiFaceFrames,
      lastMatchScore: this.lastMatchScore,
      lastReauthAt: this.lastReauthAt,
      queued: this.queue.length,
      online: navigator.onLine,
      message,
      tone,
    });
  }
}

export { eventId };

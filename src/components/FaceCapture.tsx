/**
 * Camera + live face feedback, shared by admin enrollment and trainee precheck.
 *
 * The preview overlay mirrors the mockup's `camera-feed` / `face-box` styling so
 * both flows look like one product. Nothing is transmitted from here: the parent
 * decides what to do with the descriptor it is handed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  analyseFrame, EAR_CLOSED_THRESHOLD, EMPTY_QUALITY, ENGINE_ID, largestFace, loadModels,
  MODEL_VERSION, descriptorToArray, type FrameAnalysis, type QualityMetrics,
} from "@/lib/face/engine";
import { LivenessDetector, type LivenessResult } from "@/lib/face/liveness";

export interface CaptureResult {
  descriptor: number[];
  quality: QualityMetrics;
  engine: string;
  modelVersion: string;
  liveness: { passed: boolean; blinks: number; motionScore: number };
}

export type CameraState = "idle" | "loading" | "requesting" | "ready" | "denied" | "error";

interface FaceCaptureProps {
  /** Require a blink + motion before capture is allowed. */
  requireLiveness?: boolean;
  onCapture: (result: CaptureResult) => void | Promise<void>;
  captureLabel?: string;
  busy?: boolean;
  /** Exposes the live <video> so a parent can run the monitoring loop on it. */
  onVideoReady?: (video: HTMLVideoElement) => void;
}

const QUALITY_HINTS: { test: (q: QualityMetrics) => boolean; message: string }[] = [
  { test: (q) => q.faceCount === 0, message: "顔が検出できません。カメラの正面を向いてください" },
  { test: (q) => q.faceCount > 1, message: "複数の顔が検出されています。1人で受講してください" },
  { test: (q) => q.relativeSize < 0.05, message: "顔が小さすぎます。カメラに近づいてください" },
  { test: (q) => Math.abs(q.yaw) > 0.35 || Math.abs(q.pitch) > 0.35, message: "正面を向いてください" },
  { test: (q) => q.brightness < 0.25, message: "暗すぎます。照明を明るくしてください" },
  { test: (q) => q.brightness > 0.9, message: "明るすぎます。逆光を避けてください" },
  { test: (q) => q.sharpness < 0.3, message: "画像がぶれています。静止してください" },
  { test: (q) => q.occlusion > 0.35, message: "顔が遮蔽されています。マスクや手を外してください" },
];

export function FaceCapture({
  requireLiveness = true,
  onCapture,
  captureLabel = "撮影して登録",
  busy = false,
  onVideoReady,
}: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const livenessRef = useRef(new LivenessDetector());
  const rafRef = useRef<number | null>(null);

  const [state, setState] = useState<CameraState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<FrameAnalysis | null>(null);
  const [liveness, setLiveness] = useState<LivenessResult | null>(null);
  const [capturing, setCapturing] = useState(false);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setState("loading");
    try {
      await loadModels();
    } catch {
      setState("error");
      setError("顔認識モデルの読み込みに失敗しました。通信環境を確認して再試行してください。");
      return;
    }

    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
        onVideoReady?.(videoRef.current);
      }
      livenessRef.current.reset();
      setState("ready");
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setState("denied");
        setError("カメラの利用が許可されていません。ブラウザの設定から許可してください。");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setState("error");
        setError("カメラが見つかりません。接続を確認してください。");
      } else {
        setState("error");
        setError("カメラを起動できませんでした。");
      }
    }
  }, [onVideoReady]);

  useEffect(() => stop, [stop]);

  /* Preview analysis loop (no descriptors — those cost too much per frame). */
  useEffect(() => {
    if (state !== "ready") return;
    let active = true;
    let last = 0;

    const loop = async (ts: number) => {
      if (!active) return;
      // ~5 fps is plenty for guidance feedback.
      if (ts - last > 200 && videoRef.current) {
        last = ts;
        try {
          const result = await analyseFrame(videoRef.current, { withDescriptor: false });
          if (!active) return;
          setAnalysis(result);
          setLiveness(livenessRef.current.observe(largestFace(result)));
        } catch {
          /* transient frame failure */
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [state]);

  const quality = analysis?.quality ?? EMPTY_QUALITY;
  const hint = QUALITY_HINTS.find((h) => h.test(quality))?.message ?? null;
  const livenessOk = !requireLiveness || Boolean(liveness?.passed);
  const canCapture = state === "ready" && !hint && livenessOk && !capturing && !busy;
  const face = analysis ? largestFace(analysis) : null;
  const eyesClosed = face ? face.eyeAspectRatio < EAR_CLOSED_THRESHOLD : false;

  async function capture() {
    if (!videoRef.current) return;
    setCapturing(true);
    try {
      // One high-effort pass *with* a descriptor at the moment of capture.
      const result = await analyseFrame(videoRef.current, { withDescriptor: true });
      const primary = largestFace(result);
      if (!primary?.descriptor) {
        setError("顔特徴量を抽出できませんでした。もう一度お試しください。");
        return;
      }
      await onCapture({
        descriptor: descriptorToArray(primary.descriptor),
        quality: result.quality,
        engine: ENGINE_ID,
        modelVersion: MODEL_VERSION,
        liveness: {
          passed: Boolean(liveness?.passed),
          blinks: liveness?.blinks ?? 0,
          motionScore: liveness?.motionScore ?? 0,
        },
      });
    } finally {
      setCapturing(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="camera-feed relative overflow-hidden rounded-2xl">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
          style={{ transform: "scaleX(-1)" }}
          aria-label="カメラプレビュー"
        />

        {state === "ready" && face && analysis && (
          <div
            className={`face-box ${hint ? "danger" : ""}`}
            style={{
              // Mirror the box because the preview itself is mirrored.
              left: `${100 - ((face.box.x + face.box.width / 2) / analysis.width) * 100}%`,
              top: `${(face.box.y / analysis.height) * 100}%`,
              width: `${(face.box.width / analysis.width) * 100}%`,
              height: `${(face.box.height / analysis.height) * 100}%`,
              transform: "translateX(-50%)",
            }}
          >
            <span>{eyesClosed ? "閉眼" : `検出 ${(face.score * 100).toFixed(0)}%`}</span>
          </div>
        )}

        {state !== "ready" && (
          <div className="away-state">
            {state === "loading" || state === "requesting" ? (
              <>
                <Loader2 className="animate-spin" />
                {state === "loading" ? "モデルを読み込み中…" : "カメラを準備中…"}
              </>
            ) : (
              <>
                <CameraOff />
                {state === "denied" ? "カメラが許可されていません" : "カメラ未接続"}
              </>
            )}
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {state === "ready" && (
        <div className="space-y-2">
          <div
            role="status"
            aria-live="polite"
            className={`rounded-xl border px-3 py-2 text-sm ${
              hint
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : livenessOk
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-cyan-200 bg-cyan-50 text-cyan-800"
            }`}
          >
            {hint ?? (livenessOk ? "準備ができました" : (liveness?.hint ?? "確認中…"))}
          </div>

          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div><dt>顔検出</dt><dd>{quality.faceCount}件</dd></div>
            <div><dt>鮮明度</dt><dd>{(quality.sharpness * 100).toFixed(0)}%</dd></div>
            <div><dt>明るさ</dt><dd>{(quality.brightness * 100).toFixed(0)}%</dd></div>
            <div><dt>瞬き</dt><dd>{liveness?.blinks ?? 0}回</dd></div>
          </dl>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {state === "idle" || state === "denied" || state === "error" ? (
          <Button onClick={() => void start()} className="gap-1.5">
            <Camera className="size-4" />
            カメラを開始
          </Button>
        ) : (
          <Button onClick={() => void capture()} disabled={!canCapture} className="gap-1.5">
            {capturing || busy ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
            {capturing || busy ? "処理中…" : captureLabel}
          </Button>
        )}
        {state === "ready" && (
          <Button
            variant="outline"
            onClick={() => {
              stop();
              setState("idle");
              setAnalysis(null);
              setLiveness(null);
            }}
          >
            停止
          </Button>
        )}
      </div>
    </div>
  );
}

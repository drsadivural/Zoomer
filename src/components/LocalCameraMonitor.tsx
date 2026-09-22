/**
 * On-device webcam analysis for the admin ライブ監視 screen.
 *
 * Lets an operator add a local webcam and watch the same detection the trainee
 * client runs — face presence, multiple faces, eye closure, quality and liveness
 * — computed entirely in this browser. Nothing is uploaded: no frames, no
 * descriptors, no events. It is a live check of the detection pipeline and of
 * the room in front of the operator, not a substitute for a trainee session.
 *
 * Analysis begins automatically the moment the camera starts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Loader2, ShieldCheck, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard, CardHead, StatusBadge } from "@/components/shell/primitives";
import {
  analyseFrame, EAR_CLOSED_THRESHOLD, EMPTY_QUALITY, largestFace, loadModels,
  type FrameAnalysis,
} from "@/lib/face/engine";
import { LivenessDetector, type LivenessResult } from "@/lib/face/liveness";
import { api } from "@/lib/api";

type CamState = "idle" | "loading" | "requesting" | "ready" | "denied" | "error";

interface LiveStatus {
  message: string;
  tone: "success" | "warning" | "danger" | "neutral";
}

interface Tallies {
  absent: number;
  multiple: number;
  eyesClosed: number;
}

/** Detection thresholds. Seeded with the product defaults; replaced by the org's
 *  own monitoring settings when they load, so this mirrors real behaviour. */
interface Thresholds {
  absenceSec: number;
  eyesClosedSec: number;
  multiFaceFrames: number;
}
const DEFAULT_THRESHOLDS: Thresholds = { absenceSec: 60, eyesClosedSec: 10, multiFaceFrames: 15 };

export function LocalCameraMonitor() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const livenessRef = useRef(new LivenessDetector());
  const rafRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  // Condition trackers (mirror worker-side monitor.ts, but count locally).
  const absentSinceRef = useRef<number | null>(null);
  const absentCountedRef = useRef(false);
  const eyesSinceRef = useRef<number | null>(null);
  const eyesCountedRef = useRef(false);
  const multiFramesRef = useRef(0);
  const multiCountedRef = useRef(false);
  const thresholdsRef = useRef<Thresholds>(DEFAULT_THRESHOLDS);

  const [camState, setCamState] = useState<CamState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<FrameAnalysis | null>(null);
  const [liveness, setLiveness] = useState<LivenessResult | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ message: "カメラ待機中", tone: "neutral" });
  const [tallies, setTallies] = useState<Tallies>({ absent: 0, multiple: 0, eyesClosed: 0 });
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const resetTrackers = useCallback(() => {
    absentSinceRef.current = null;
    absentCountedRef.current = false;
    eyesSinceRef.current = null;
    eyesCountedRef.current = false;
    multiFramesRef.current = 0;
    multiCountedRef.current = false;
    livenessRef.current.reset();
    setTallies({ absent: 0, multiple: 0, eyesClosed: 0 });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setCamState("loading");
    try {
      await loadModels();
    } catch {
      setCamState("error");
      setError("顔認識モデルの読み込みに失敗しました。通信環境を確認して再試行してください。");
      return;
    }

    // Use the org's real detection thresholds when permitted; keep defaults otherwise.
    try {
      const { settings } = await api.getSettings();
      const t: Thresholds = {
        absenceSec: settings.absenceSec,
        eyesClosedSec: settings.eyesClosedSec,
        multiFaceFrames: settings.multiFaceFrames,
      };
      thresholdsRef.current = t;
      setThresholds(t);
    } catch {
      thresholdsRef.current = DEFAULT_THRESHOLDS;
    }

    setCamState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      resetTrackers();
      setCamState("ready"); // The loop below starts analysis automatically.
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setCamState("denied");
        setError("カメラの利用が許可されていません。ブラウザの設定から許可してください。");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCamState("error");
        setError("カメラが見つかりません。接続を確認してください。");
      } else {
        setCamState("error");
        setError("カメラを起動できませんでした。");
      }
    }
  }, [resetTrackers]);

  useEffect(() => stop, [stop]);

  /* Continuous on-device analysis; starts as soon as the camera is ready. */
  useEffect(() => {
    if (camState !== "ready") return;
    let active = true;
    let last = 0;

    const evaluate = (a: FrameAnalysis) => {
      const now = Date.now();
      const t = thresholdsRef.current;
      const face = largestFace(a);

      // Absence
      if (a.faceCount === 0) {
        absentSinceRef.current ??= now;
        if (!absentCountedRef.current && now - absentSinceRef.current >= t.absenceSec * 1000) {
          absentCountedRef.current = true;
          setTallies((p) => ({ ...p, absent: p.absent + 1 }));
        }
      } else {
        absentSinceRef.current = null;
        absentCountedRef.current = false;
      }

      // Multiple faces
      if (a.faceCount >= 2) {
        multiFramesRef.current += 1;
        if (!multiCountedRef.current && multiFramesRef.current >= t.multiFaceFrames) {
          multiCountedRef.current = true;
          setTallies((p) => ({ ...p, multiple: p.multiple + 1 }));
        }
      } else {
        multiFramesRef.current = 0;
        multiCountedRef.current = false;
      }

      // Eyes closed (drowsiness *suspicion* only)
      if (face && face.eyeAspectRatio < EAR_CLOSED_THRESHOLD) {
        eyesSinceRef.current ??= now;
        if (!eyesCountedRef.current && now - eyesSinceRef.current >= t.eyesClosedSec * 1000) {
          eyesCountedRef.current = true;
          setTallies((p) => ({ ...p, eyesClosed: p.eyesClosed + 1 }));
        }
      } else {
        eyesSinceRef.current = null;
        eyesCountedRef.current = false;
      }

      // Instantaneous status
      const absentMs = absentSinceRef.current ? now - absentSinceRef.current : 0;
      const eyesMs = eyesSinceRef.current ? now - eyesSinceRef.current : 0;
      if (a.faceCount === 0) {
        setStatus(absentMs > 3000
          ? { message: "顔が検出できません", tone: "warning" }
          : { message: "検出中…", tone: "neutral" });
      } else if (a.faceCount >= 2) {
        setStatus({ message: `複数人を検出しています（${a.faceCount}名）`, tone: "danger" });
      } else if (eyesMs > 2000) {
        setStatus({ message: "閉眼を検出しています（居眠り疑い）", tone: "warning" });
      } else {
        setStatus({ message: "正常に検出しています", tone: "success" });
      }
    };

    const loop = async (ts: number) => {
      if (!active) return;
      if (ts - last > 220 && videoRef.current && !inFlightRef.current) {
        last = ts;
        inFlightRef.current = true;
        try {
          const result = await analyseFrame(videoRef.current, { withDescriptor: false });
          if (active) {
            setAnalysis(result);
            setLiveness(livenessRef.current.observe(largestFace(result)));
            evaluate(result);
          }
        } catch {
          /* a dropped frame is not an event */
        } finally {
          inFlightRef.current = false;
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [camState]);

  const quality = analysis?.quality ?? EMPTY_QUALITY;
  const face = analysis ? largestFace(analysis) : null;
  const eyesClosed = face ? face.eyeAspectRatio < EAR_CLOSED_THRESHOLD : false;
  const active = camState === "ready";

  return (
    <AppCard>
      <CardHead
        title="ローカルカメラ解析（端末内）"
        description="この端末のカメラで顔検出・複数人・閉眼・品質・生体検知をリアルタイムに確認します。映像・特徴量はサーバーへ送信しません。"
        action={active ? <StatusBadge tone={status.tone}>{status.message}</StatusBadge> : undefined}
      />

      <div className="space-y-4 border-t border-slate-100 p-5">
        {!active && camState !== "loading" && camState !== "requesting" ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-600">
              カメラを追加すると、自動的に解析を開始します。追加は任意で、いつでも停止できます。
            </p>
            <Button onClick={() => void start()} className="gap-1.5">
              <Camera className="size-4" />
              カメラを追加
            </Button>
          </div>
        ) : null}

        {error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
            {(camState === "denied" || camState === "error") && (
              <button type="button" className="ml-3 font-bold underline" onClick={() => void start()}>
                再試行
              </button>
            )}
          </div>
        )}

        {(active || camState === "loading" || camState === "requesting") && (
          <>
            <div className="camera-feed relative overflow-hidden rounded-2xl">
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full object-cover"
                style={{ transform: "scaleX(-1)" }}
                aria-label="ローカルカメラプレビュー"
              />

              {active && face && analysis && (
                <div
                  className={`face-box ${eyesClosed || analysis.faceCount >= 2 ? "danger" : ""}`}
                  style={{
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

              {!active && (
                <div className="away-state">
                  <Loader2 className="animate-spin" />
                  {camState === "loading" ? "モデルを読み込み中…" : "カメラを準備中…"}
                </div>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
              <div><dt>顔検出</dt><dd>{quality.faceCount}件</dd></div>
              <div><dt>鮮明度</dt><dd>{(quality.sharpness * 100).toFixed(0)}%</dd></div>
              <div><dt>明るさ</dt><dd>{(quality.brightness * 100).toFixed(0)}%</dd></div>
              <div><dt>瞬き</dt><dd>{liveness?.blinks ?? 0}回</dd></div>
              <div>
                <dt>生体検知</dt>
                <dd className={liveness?.passed ? "text-emerald-600" : undefined}>
                  {liveness?.passed ? "確認" : "確認中"}
                </dd>
              </div>
            </dl>

            <div className="grid grid-cols-3 gap-2">
              <TallyTile label="離席" value={tallies.absent} hint={`${thresholds.absenceSec}秒`} tone="warning" />
              <TallyTile label="複数人" value={tallies.multiple} hint={`${thresholds.multiFaceFrames}フレーム`} tone="danger" />
              <TallyTile label="居眠り疑い" value={tallies.eyesClosed} hint={`${thresholds.eyesClosedSec}秒`} tone="warning" />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <ShieldCheck className="size-3.5 text-emerald-500" />
                端末内で解析。映像・特徴量は送信されません。
              </p>
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  stop();
                  setCamState("idle");
                  setAnalysis(null);
                  setLiveness(null);
                  setStatus({ message: "カメラ待機中", tone: "neutral" });
                }}
              >
                <CameraOff className="size-4" />
                停止
              </Button>
            </div>
          </>
        )}

        {!active && camState !== "loading" && camState !== "requesting" && (
          <p className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <Video className="size-3.5" />
            カメラの利用には HTTPS 接続と本人の許可が必要です。
          </p>
        )}
      </div>
    </AppCard>
  );
}

function TallyTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "warning" | "danger";
}) {
  const active = value > 0;
  const color = tone === "danger" ? "rose" : "amber";
  return (
    <div
      className={`rounded-xl border p-3 ${
        active
          ? color === "rose"
            ? "border-rose-200 bg-rose-50"
            : "border-amber-200 bg-amber-50"
          : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className={`text-2xl font-extrabold ${active ? (color === "rose" ? "text-rose-600" : "text-amber-600") : "text-slate-400"}`}>
        {value}
      </div>
      <div className="text-[0.7rem] text-slate-400">しきい値 {hint}</div>
    </div>
  );
}

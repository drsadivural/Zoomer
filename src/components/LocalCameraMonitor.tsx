/**
 * Full-screen on-device webcam analysis for the admin ライブ監視 screen.
 *
 * Opened from the toolbar. When the camera starts, analysis runs automatically:
 *  - 顔検出・顔追跡（最大顔を追跡し全ての顔に枠を描画）
 *  - 登録顔との照合 / 本人の継続照合（1:1・1:N。照合はサーバー側で実行し、
 *    登録テンプレートはブラウザへ渡しません）
 *  - 本人以外（他人・未登録）の検出
 *  - 顔が映っていない状態の検出（離席）
 *  - カメラ映像内の複数人検出
 *  - 顔の向き・目の開閉状態の解析
 *  - 認証結果・検知イベントの記録（画面内のイベントログ、コピー可）
 *
 * On-device: frames and descriptors are analysed locally; only a 128-float
 * descriptor is sent for the server-side identity comparison. No image leaves
 * the browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera, CameraOff, Copy, Loader2, ScanFace, ShieldCheck, UserCheck, UserPlus, UserX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/shell/primitives";
import {
  analyseFrame, descriptorToArray, EMPTY_QUALITY, ENGINE_ID, EyeClosureTracker, largestFace,
  loadModels, MODEL_VERSION, type FaceObservation, type FrameAnalysis,
} from "@/lib/face/engine";
import { LivenessDetector, type LivenessResult } from "@/lib/face/liveness";
import { api, ApiClientError, type IdentifyResponse } from "@/lib/api";
import { useCan } from "@/lib/auth-context";

const CONSENT_POLICY_VERSION = "2026-09-01";
const CONSENT_SCOPE = ["face_template", "monitoring", "evidence_images"];

type CamState = "idle" | "loading" | "requesting" | "ready" | "denied" | "error";
type Tone = "success" | "warning" | "danger" | "neutral";

interface Tallies { absent: number; multiple: number; eyesClosed: number; impostor: number }
interface Thresholds { absenceSec: number; eyesClosedSec: number; multiFaceFrames: number }
const DEFAULTS: Thresholds = { absenceSec: 60, eyesClosedSec: 10, multiFaceFrames: 15 };

interface LogEntry { id: number; at: number; tone: Tone; text: string }

const IDENTIFY_INTERVAL_MS = 3000;

function poseLabel(yaw: number, pitch: number): string {
  if (Math.abs(yaw) < 0.15 && Math.abs(pitch) < 0.15) return "正面";
  if (Math.abs(yaw) >= Math.abs(pitch)) return yaw > 0 ? "右を向いています" : "左を向いています";
  return pitch > 0 ? "下を向いています" : "上を向いています";
}

export function LocalCameraMonitor({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const livenessRef = useRef(new LivenessDetector());
  const rafRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  const absentSince = useRef<number | null>(null);
  const absentCounted = useRef(false);
  const eyesSince = useRef<number | null>(null);
  const eyesCounted = useRef(false);
  const multiFrames = useRef(0);
  const multiCounted = useRef(false);
  const thresholdsRef = useRef<Thresholds>(DEFAULTS);
  const identifyingRef = useRef(false);
  const analyzeErrLogged = useRef(false);
  const eyeTrackerRef = useRef(new EyeClosureTracker());
  const lastIdentifyAt = useRef(0);
  const identityKeyRef = useRef<string>("");
  const logSeq = useRef(0);

  const [camState, setCamState] = useState<CamState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<FrameAnalysis | null>(null);
  const [liveness, setLiveness] = useState<LivenessResult | null>(null);
  const [status, setStatus] = useState<{ message: string; tone: Tone }>({ message: "カメラ待機中", tone: "neutral" });
  const [tallies, setTallies] = useState<Tallies>({ absent: 0, multiple: 0, eyesClosed: 0, impostor: 0 });
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULTS);
  const [identity, setIdentity] = useState<IdentifyResponse | null>(null);
  const [eye, setEye] = useState<{ ear: number | null; baseline: number; closed: boolean }>({ ear: null, baseline: 0, closed: false });
  const [log, setLog] = useState<LogEntry[]>([]);

  const can = useCan();
  const canRegister = can("enrollment:write");
  const [regOpen, setRegOpen] = useState(false);
  const [regForm, setRegForm] = useState({ name: "", externalId: "", department: "" });
  const [regConsent, setRegConsent] = useState(false);
  const [regBusy, setRegBusy] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [regReasons, setRegReasons] = useState<string[]>([]);

  const addLog = useCallback((tone: Tone, text: string) => {
    setLog((prev) => [{ id: ++logSeq.current, at: Date.now(), tone, text }, ...prev].slice(0, 80));
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
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
    try {
      const { settings } = await api.getSettings();
      const t: Thresholds = {
        absenceSec: settings.absenceSec, eyesClosedSec: settings.eyesClosedSec, multiFaceFrames: settings.multiFaceFrames,
      };
      thresholdsRef.current = t;
      setThresholds(t);
    } catch {
      thresholdsRef.current = DEFAULTS;
    }
    setCamState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: "user" }, audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      // reset trackers
      absentSince.current = null; absentCounted.current = false;
      eyesSince.current = null; eyesCounted.current = false;
      multiFrames.current = 0; multiCounted.current = false;
      identityKeyRef.current = ""; lastIdentifyAt.current = 0;
      eyeTrackerRef.current.reset();
      livenessRef.current.reset();
      setTallies({ absent: 0, multiple: 0, eyesClosed: 0, impostor: 0 });
      setIdentity(null);
      setEye({ ear: null, baseline: 0, closed: false });
      setCamState("ready");
      addLog("neutral", "解析を開始しました");
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
  }, [addLog]);

  // Start automatically when the dialog opens; tear down when it closes.
  useEffect(() => {
    if (open) {
      void start();
    } else {
      stop();
      setCamState("idle");
      setAnalysis(null);
      setLiveness(null);
      setIdentity(null);
      setStatus({ message: "カメラ待機中", tone: "neutral" });
    }
    return () => stop();
  }, [open, start, stop]);

  // Server-side 1:N identification of the largest face.
  const runIdentify = useCallback(async () => {
    if (identifyingRef.current || !videoRef.current) return;
    identifyingRef.current = true;
    try {
      const result = await analyseFrame(videoRef.current, { withDescriptor: true });
      const face = largestFace(result);
      if (!face?.descriptor) return;
      const res = await api.identify(descriptorToArray(face.descriptor), ENGINE_ID, 3);
      setIdentity(res);
      lastIdentifyAt.current = Date.now();

      // Log only when the outcome category changes.
      let key: string;
      if (res.enrolledTrainees === 0) key = "none";
      else if (res.matched && res.best) key = `ok:${res.best.traineeId}`;
      else key = "impostor";
      if (key !== identityKeyRef.current) {
        identityKeyRef.current = key;
        if (key.startsWith("ok:") && res.best) {
          addLog("success", `本人確認: ${res.best.name}（一致度 ${(res.best.score * 100).toFixed(1)}%）`);
        } else if (key === "impostor") {
          const near = res.best ? `最近傍 ${res.best.name} ${(res.best.score * 100).toFixed(1)}%` : "該当なし";
          addLog("danger", `本人以外を検出（他人／未登録・${near}）`);
          setTallies((p) => ({ ...p, impostor: p.impostor + 1 }));
        } else {
          addLog("neutral", "照合対象の登録顔がありません");
        }
      }
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 401) {
        addLog("warning", "セッションの有効期限が切れました。再ログインしてください。");
      }
    } finally {
      identifyingRef.current = false;
    }
  }, [addLog]);

  // Continuous detection loop (~4.5 fps).
  useEffect(() => {
    if (camState !== "ready") return;
    let active = true;
    let last = 0;

    const evaluate = (a: FrameAnalysis) => {
      const now = Date.now();
      const t = thresholdsRef.current;
      const face = largestFace(a);

      if (a.faceCount === 0) {
        if (absentSince.current == null) { absentSince.current = now; }
        if (!absentCounted.current && now - absentSince.current >= t.absenceSec * 1000) {
          absentCounted.current = true;
          setTallies((p) => ({ ...p, absent: p.absent + 1 }));
          addLog("warning", `顔が映っていません（離席 ${Math.round((now - absentSince.current) / 1000)}秒）`);
        }
      } else {
        if (absentCounted.current) addLog("neutral", "顔を再検出しました");
        absentSince.current = null; absentCounted.current = false;
      }

      if (a.faceCount >= 2) {
        multiFrames.current += 1;
        if (!multiCounted.current && multiFrames.current >= t.multiFaceFrames) {
          multiCounted.current = true;
          setTallies((p) => ({ ...p, multiple: p.multiple + 1 }));
          addLog("danger", `複数人を検出しました（${a.faceCount}名）`);
        }
      } else {
        multiFrames.current = 0; multiCounted.current = false;
      }

      // Eyes closed (drowsiness *suspicion* only) — judged against the person's
      // own running open-eye baseline, since absolute EAR varies widely by face.
      const eyeState = eyeTrackerRef.current.update(face ? face.eyeAspectRatio : null);
      setEye(eyeState);

      if (eyeState.closed) {
        if (eyesSince.current == null) eyesSince.current = now;
        if (!eyesCounted.current && now - eyesSince.current >= t.eyesClosedSec * 1000) {
          eyesCounted.current = true;
          setTallies((p) => ({ ...p, eyesClosed: p.eyesClosed + 1 }));
          addLog("warning", `閉眼を検出しました（居眠り疑い ${t.eyesClosedSec}秒）`);
        }
      } else {
        eyesSince.current = null; eyesCounted.current = false;
      }

      const absentMs = absentSince.current ? now - absentSince.current : 0;
      const eyesMs = eyesSince.current ? now - eyesSince.current : 0;
      if (a.faceCount === 0) {
        setStatus(absentMs > 3000 ? { message: "顔が映っていません", tone: "warning" } : { message: "検出中…", tone: "neutral" });
      } else if (a.faceCount >= 2) {
        setStatus({ message: `複数人を検出（${a.faceCount}名）`, tone: "danger" });
      } else if (eyesMs > 2000) {
        setStatus({ message: "閉眼を検出（居眠り疑い）", tone: "warning" });
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
          analyzeErrLogged.current = false;
          if (active) {
            setAnalysis(result);
            setLiveness(livenessRef.current.observe(largestFace(result)));
            evaluate(result);
            // Continuous identity check on a single face, throttled.
            if (result.faceCount === 1 && Date.now() - lastIdentifyAt.current >= IDENTIFY_INTERVAL_MS) {
              void runIdentify();
            }
          }
        } catch (e) {
          // Never swallow a persistent engine failure silently — surface it once.
          if (active && !analyzeErrLogged.current) {
            analyzeErrLogged.current = true;
            const msg = e instanceof Error ? e.message : "解析に失敗しました";
            addLog("danger", `解析エラー: ${msg}`);
            setStatus({ message: "解析エラー（顔認識エンジン）", tone: "danger" });
          }
        } finally {
          inFlightRef.current = false;
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { active = false; if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
  }, [camState, addLog, runIdentify]);

  const quality = analysis?.quality ?? EMPTY_QUALITY;
  const primary = analysis ? largestFace(analysis) : null;
  const eyesClosed = eye.closed;
  const ready = camState === "ready";

  const idMatched = Boolean(identity?.matched && identity.best);
  const idHasFacePresent = (analysis?.faceCount ?? 0) === 1;
  const identityTone: Tone = idMatched ? "success" : identity && idHasFacePresent && identity.enrolledTrainees > 0 ? "danger" : "neutral";

  async function registerFace() {
    if (!videoRef.current) return;
    const name = regForm.name.trim();
    const externalId = regForm.externalId.trim();
    if (!name || !externalId) { setRegError("氏名と受講者IDを入力してください"); return; }
    if (!regConsent) { setRegError("本人の同意取得を確認してください"); return; }
    setRegBusy(true); setRegError(null); setRegReasons([]);
    try {
      const result = await analyseFrame(videoRef.current, { withDescriptor: true });
      const face = largestFace(result);
      if (result.faceCount !== 1 || !face?.descriptor) {
        setRegError(result.faceCount > 1 ? "複数の顔が検出されています。1人で登録してください" : "顔を検出できませんでした");
        return;
      }
      const created = await api.createTrainee({
        externalId, name, department: regForm.department.trim() || undefined,
      });
      await api.enroll(created.trainee.id, {
        descriptor: descriptorToArray(face.descriptor),
        engine: ENGINE_ID,
        modelVersion: MODEL_VERSION,
        quality: result.quality,
        consent: { policyVersion: CONSENT_POLICY_VERSION, scope: CONSENT_SCOPE },
      });
      addLog("success", `顔登録が完了しました: ${name}（${externalId}）`);
      setRegOpen(false);
      setRegForm({ name: "", externalId: "", department: "" });
      setRegConsent(false);
      // Re-run identification so the newly enrolled face is recognised at once.
      identityKeyRef.current = ""; lastIdentifyAt.current = 0; setIdentity(null);
    } catch (e) {
      if (e instanceof ApiClientError) {
        setRegError(e.message);
        const payload = e.payload as { error?: { reasons?: string[] } } | undefined;
        setRegReasons(payload?.error?.reasons ?? []);
      } else {
        setRegError("登録に失敗しました");
      }
    } finally {
      setRegBusy(false);
    }
  }

  function copyLog() {
    const text = log.slice().reverse().map((e) => `${new Date(e.at).toLocaleTimeString("ja-JP")}  ${e.text}`).join("\n");
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[min(1120px,96vw)] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanFace className="size-5 text-cyan-600" />
            ローカルカメラ解析（端末内）
          </DialogTitle>
          <DialogDescription>
            この端末のカメラで顔検出・追跡・本人照合（1:1 / 1:N）・他人検出・複数人・顔の向き・目の開閉を解析します。
            照合はサーバー側で行い、登録テンプレートはブラウザへ渡しません。映像は送信されません。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
            {(camState === "denied" || camState === "error") && (
              <button type="button" className="ml-3 font-bold underline" onClick={() => void start()}>再試行</button>
            )}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          {/* ---- camera + overlays ---- */}
          <div className="space-y-3">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-slate-900">
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full object-contain"
                style={{ transform: "scaleX(-1)" }}
                aria-label="ローカルカメラプレビュー"
              />
              {ready && analysis && analysis.faces.map((f: FaceObservation, i) => {
                const isPrimary = primary && f === primary;
                const danger = analysis.faceCount >= 2 ? !isPrimary : (isPrimary && (eyesClosed || (identityTone === "danger")));
                const label = isPrimary
                  ? eyesClosed ? "閉眼"
                    : idMatched && identity?.best ? `${identity.best.name} ${(identity.best.score * 100).toFixed(0)}%`
                    : identity && idHasFacePresent && identity.enrolledTrainees > 0 ? "他人/未登録"
                    : `検出 ${(f.score * 100).toFixed(0)}%`
                  : "他";
                return (
                  <div
                    key={i}
                    className={`face-box ${danger ? "danger" : ""}`}
                    style={{
                      left: `${100 - ((f.box.x + f.box.width / 2) / analysis.width) * 100}%`,
                      top: `${(f.box.y / analysis.height) * 100}%`,
                      width: `${(f.box.width / analysis.width) * 100}%`,
                      height: `${(f.box.height / analysis.height) * 100}%`,
                      transform: "translateX(-50%)",
                    }}
                  >
                    <span>{label}</span>
                  </div>
                );
              })}
              {!ready && (
                <div className="away-state">
                  <Loader2 className="animate-spin" />
                  {camState === "loading" ? "モデルを読み込み中…" : camState === "requesting" ? "カメラを準備中…" : "カメラ停止中"}
                </div>
              )}
              {ready && (
                <div className="absolute left-3 top-3">
                  <StatusBadge tone={status.tone}>{status.message}</StatusBadge>
                </div>
              )}
            </div>

            {/* identity result */}
            <div className={`rounded-xl border p-3 ${
              identityTone === "success" ? "border-emerald-200 bg-emerald-50"
                : identityTone === "danger" ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-slate-50"}`}>
              <div className="flex items-center gap-2">
                {idMatched ? <UserCheck className="size-5 text-emerald-600" />
                  : identityTone === "danger" ? <UserX className="size-5 text-rose-600" />
                  : <ScanFace className="size-5 text-slate-400" />}
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-slate-900">
                    {!ready ? "—"
                      : (analysis?.faceCount ?? 0) === 0 ? "顔が映っていません"
                      : (analysis?.faceCount ?? 0) >= 2 ? "複数人を検出（照合は1名時のみ）"
                      : identity == null ? "照合中…"
                      : identity.enrolledTrainees === 0 ? "照合対象の登録顔がありません"
                      : idMatched && identity.best ? `本人確認: ${identity.best.name}`
                      : "本人以外（他人／未登録）の可能性"}
                  </div>
                  <div className="text-xs text-slate-500">
                    {identity?.best && (analysis?.faceCount ?? 0) === 1
                      ? `最近傍 ${identity.best.name}（${identity.best.externalId}） 一致度 ${(identity.best.score * 100).toFixed(1)}% / しきい値 ${(identity.threshold * 100).toFixed(0)}%`
                      : "1:1 / 1:N 照合はサーバー側で実行"}
                  </div>
                </div>
              </div>
              {identity && identity.matches.length > 1 && (analysis?.faceCount ?? 0) === 1 && (
                <div className="mt-2 space-y-1 border-t border-slate-200/70 pt-2">
                  {identity.matches.map((m) => (
                    <div key={m.traineeId} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">{m.name} <span className="text-slate-400">{m.externalId}</span></span>
                      <span className={`font-semibold ${m.score >= identity.threshold ? "text-emerald-600" : "text-slate-500"}`}>
                        {(m.score * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ---- analytics ---- */}
          <div className="space-y-3">
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <Metric label="顔検出" value={`${quality.faceCount}件`} />
              <Metric label="顔の向き" value={primary ? poseLabel(quality.yaw, quality.pitch) : "—"} />
              <Metric
                label="目の開閉"
                value={eye.ear != null ? `${eyesClosed ? "閉" : "開"}（${eye.ear.toFixed(2)}）` : "—"}
                tone={eyesClosed ? "warning" : undefined}
              />
              <Metric label="瞬き" value={`${liveness?.blinks ?? 0}回`} />
              <Metric label="鮮明度" value={`${(quality.sharpness * 100).toFixed(0)}%`} />
              <Metric label="明るさ" value={`${(quality.brightness * 100).toFixed(0)}%`} />
            </dl>

            <div className="grid grid-cols-2 gap-2">
              <Tally label="離席" value={tallies.absent} hint={`${thresholds.absenceSec}秒`} tone="warning" />
              <Tally label="複数人" value={tallies.multiple} hint={`${thresholds.multiFaceFrames}フレーム`} tone="danger" />
              <Tally label="居眠り疑い" value={tallies.eyesClosed} hint={`${thresholds.eyesClosedSec}秒`} tone="warning" />
              <Tally label="他人検出" value={tallies.impostor} hint="照合不一致" tone="danger" />
            </div>

            <div className="rounded-xl border border-slate-200">
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                <span className="text-xs font-bold text-slate-600">イベントログ（{log.length}）</span>
                <button type="button" onClick={copyLog} disabled={!log.length}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-700 disabled:text-slate-300">
                  <Copy className="size-3" /> コピー
                </button>
              </div>
              <div className="max-h-52 space-y-1 overflow-y-auto p-2">
                {!log.length ? (
                  <p className="px-1 py-4 text-center text-xs text-slate-400">まだイベントはありません</p>
                ) : log.map((e) => (
                  <div key={e.id} className="flex items-start gap-2 text-xs">
                    <span className="tabular-nums text-slate-400">{new Date(e.at).toLocaleTimeString("ja-JP")}</span>
                    <span className={
                      e.tone === "success" ? "text-emerald-700"
                        : e.tone === "danger" ? "text-rose-700"
                        : e.tone === "warning" ? "text-amber-700" : "text-slate-600"}>{e.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {regOpen && (
          <div className="space-y-2 rounded-xl border border-cyan-200 bg-cyan-50/60 p-3">
            <div className="flex items-center gap-2 text-sm font-bold text-cyan-900">
              <UserPlus className="size-4" /> カメラ映像から顔を登録
            </div>
            <p className="text-xs text-cyan-800">
              いま映っている顔を新しい受講者として登録します。1人だけ映してください。特徴量は暗号化して保存し、原画像は保存しません。
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <label className="field-label" htmlFor="reg-name">氏名</label>
                <input id="reg-name" className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
                  value={regForm.name} onChange={(e) => setRegForm({ ...regForm, name: e.target.value })} placeholder="佐藤 美咲" />
              </div>
              <div>
                <label className="field-label" htmlFor="reg-id">受講者ID</label>
                <input id="reg-id" className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
                  value={regForm.externalId} onChange={(e) => setRegForm({ ...regForm, externalId: e.target.value })} placeholder="AZ-0241" />
              </div>
              <div>
                <label className="field-label" htmlFor="reg-dept">所属（任意）</label>
                <input id="reg-dept" className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
                  value={regForm.department} onChange={(e) => setRegForm({ ...regForm, department: e.target.value })} placeholder="人事部" />
              </div>
            </div>
            <label className="flex items-start gap-2 text-xs text-cyan-900">
              <input type="checkbox" className="mt-0.5" checked={regConsent} onChange={(e) => setRegConsent(e.target.checked)} />
              <span>本人から、カメラ利用・顔情報の処理・証跡画像の保存について同意を取得しました。（同意文面バージョン {CONSENT_POLICY_VERSION}）</span>
            </label>
            {regError && (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-700">
                <div className="font-semibold">{regError}</div>
                {regReasons.length > 0 && (
                  <ul className="mt-1 list-inside list-disc">{regReasons.map((r) => <li key={r}>{r}</li>)}</ul>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setRegOpen(false)}>キャンセル</Button>
              <Button size="sm" className="gap-1.5" disabled={regBusy || !ready} onClick={() => void registerFace()}>
                {regBusy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                {regBusy ? "登録中…" : "登録する"}
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
          <p className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <ShieldCheck className="size-3.5 text-emerald-500" />
            端末内で解析。映像は送信されず、照合用の特徴量のみをサーバーへ送ります。
          </p>
          <div className="flex items-center gap-2">
            {ready && canRegister && (
              <Button className="gap-1.5" onClick={() => { setRegError(null); setRegReasons([]); setRegOpen((v) => !v); }}>
                <UserPlus className="size-4" /> この顔を登録
              </Button>
            )}
            {ready ? (
              <Button variant="outline" className="gap-1.5" onClick={() => { stop(); setCamState("idle"); setRegOpen(false); addLog("neutral", "解析を停止しました"); }}>
                <CameraOff className="size-4" /> 停止
              </Button>
            ) : (
              <Button className="gap-1.5" onClick={() => void start()} disabled={camState === "loading" || camState === "requesting"}>
                <Camera className="size-4" /> {camState === "loading" || camState === "requesting" ? "起動中…" : "カメラを開始"}
              </Button>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>閉じる</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`mt-0.5 font-bold ${tone === "warning" ? "text-amber-600" : "text-slate-800"}`}>{value}</dd>
    </div>
  );
}

function Tally({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: "warning" | "danger" }) {
  const active = value > 0;
  const danger = tone === "danger";
  return (
    <div className={`rounded-xl border p-2.5 ${
      active ? (danger ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50") : "border-slate-200 bg-slate-50"}`}>
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className={`text-xl font-extrabold ${active ? (danger ? "text-rose-600" : "text-amber-600") : "text-slate-400"}`}>{value}</div>
      <div className="text-[0.68rem] text-slate-400">しきい値 {hint}</div>
    </div>
  );
}

/**
 * Trainee 受講画面, opened alongside Zoom from a per-participant link.
 *
 * Flow: consent → camera + liveness → 1:1 verification (decided server-side) →
 * continuous monitoring. The trainee can see exactly what is being detected and
 * can stop at any time, which is the point of doing this here rather than
 * silently against the Zoom video stream.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, CheckCircle2, Clock3, Loader2, ShieldCheck, Video, WifiOff, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { traineeApi, ApiClientError, type JoinResponse, type PrecheckResponse } from "@/lib/api";
import { AppCard, CardHead, Logo, StatusBadge } from "@/components/shell/primitives";
import { FaceCapture, type CaptureResult } from "@/components/FaceCapture";
import { ENGINE_ID, MODEL_VERSION } from "@/lib/face/engine";
import { MonitoringLoop, type MonitorStatus, type ProposedEvent } from "@/lib/face/monitor";
import { formatClock, formatTime, percent } from "@/lib/format";

type Phase = "loading" | "error" | "consent" | "precheck" | "monitoring" | "blocked" | "finished";

const CONSENT_SCOPE = ["camera", "face_template", "monitoring", "evidence_images"];

export function TraineeJoinScreen() {
  const { participantId = "" } = useParams();
  const [params] = useSearchParams();
  const token = params.get("t") ?? "";

  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [precheck, setPrecheck] = useState<PrecheckResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<MonitorStatus | null>(null);

  const deviceTokenRef = useRef<string | null>(null);
  const loopRef = useRef<MonitoringLoop | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!participantId || !token) {
      setPhase("error");
      setError("受講リンクが不正です。研修案内メールのリンクからアクセスしてください。");
      return;
    }
    traineeApi
      .join(participantId, token)
      .then((r) => {
        setInfo(r);
        if (!r.enrolled) {
          setPhase("blocked");
          setError("顔登録が完了していません。研修管理者にお問い合わせください。");
        } else if (r.participant.status === "COMPLETED") {
          setPhase("finished");
        } else {
          setPhase("consent");
        }
      })
      .catch((e) => {
        setPhase("error");
        setError(e instanceof ApiClientError ? e.message : "受講情報を取得できません");
      });
  }, [participantId, token]);

  useEffect(() => () => loopRef.current?.stop(), []);

  const startMonitoring = useCallback(
    (deviceToken: string, rules: JoinResponse["rules"]) => {
      const video = videoRef.current;
      if (!video) return;
      deviceTokenRef.current = deviceToken;

      const loop = new MonitoringLoop(
        video,
        {
          reauthIntervalSec: rules.reauthIntervalSec,
          absenceSec: rules.absenceSec,
          eyesClosedSec: rules.eyesClosedSec,
          multiFaceFrames: rules.multiFaceFrames,
          evidenceIntervalSec: rules.evidenceIntervalSec,
        },
        {
          sendEvents: async (events: ProposedEvent[]) => {
            await traineeApi.sendEvents(deviceToken, events);
          },
          reauth: async (descriptor, qualityScore) => {
            const r = await traineeApi.reauth(deviceToken, {
              descriptor,
              engine: ENGINE_ID,
              modelVersion: MODEL_VERSION,
              qualityScore,
            });
            return { matchScore: r.matchScore, passed: r.passed };
          },
          onStatus: setStatus,
        },
      );
      loopRef.current = loop;
      loop.start();
      setPhase("monitoring");
    },
    [],
  );

  async function grantConsent() {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      await traineeApi.consent(participantId, {
        token,
        policyVersion: info.consentPolicyVersion,
        scope: CONSENT_SCOPE,
        granted: true,
      });
      setPhase("precheck");
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "同意を記録できません");
    } finally {
      setBusy(false);
    }
  }

  async function declineConsent() {
    await traineeApi
      .consent(participantId, {
        token,
        policyVersion: info?.consentPolicyVersion ?? "",
        scope: CONSENT_SCOPE,
        granted: false,
      })
      .catch(() => undefined);
    setPhase("blocked");
    setError("同意されない場合、本人確認と受講監視は実施できません。研修管理者にご連絡ください。");
  }

  async function handleCapture(result: CaptureResult) {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      const r = await traineeApi.precheck(participantId, {
        token,
        descriptor: result.descriptor,
        engine: result.engine,
        modelVersion: result.modelVersion,
        quality: result.quality,
        liveness: result.liveness,
      });
      setPrecheck(r);
      if (r.result === "VERIFIED" && r.deviceToken) {
        startMonitoring(r.deviceToken, info.rules);
      }
    } catch (e) {
      if (e instanceof ApiClientError) {
        const payload = e.payload as PrecheckResponse | undefined;
        if (payload?.result) setPrecheck(payload);
        else setError(e.message);
        if (e.status === 403) {
          setPhase("blocked");
          setError(e.message);
        }
      } else {
        setError("本人確認に失敗しました");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#f4f7fb] pb-10">
      <header className="hero-strip !min-h-0 !rounded-none px-5 py-4 sm:px-8">
        <div className="flex items-center gap-4">
          <Logo />
          <div className="hidden sm:block">
            <div className="text-sm font-bold text-white">{info?.session.title ?? "受講画面"}</div>
            {info && (
              <div className="text-xs text-cyan-100">
                {formatClock(info.session.startsAt)}–{formatClock(info.session.endsAt)}
                {info.trainee && ` ・ ${info.trainee.name}`}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
        {phase === "loading" && (
          <AppCard className="flex items-center gap-3 p-6">
            <Loader2 className="size-5 animate-spin text-cyan-600" />
            <span className="text-sm font-semibold text-slate-700">受講情報を確認しています…</span>
          </AppCard>
        )}

        {(phase === "error" || phase === "blocked") && (
          <AppCard className="p-6">
            <div className="flex items-start gap-3">
              <XCircle className="mt-0.5 size-6 shrink-0 text-rose-500" />
              <div>
                <h2 className="text-lg font-extrabold text-slate-950">受講を開始できません</h2>
                <p className="mt-1 text-sm text-slate-600">{error}</p>
              </div>
            </div>
          </AppCard>
        )}

        {phase === "finished" && (
          <AppCard className="p-6">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-emerald-500" />
              <div>
                <h2 className="text-lg font-extrabold text-slate-950">この研修は完了しています</h2>
                <p className="mt-1 text-sm text-slate-600">受講ありがとうございました。</p>
              </div>
            </div>
          </AppCard>
        )}

        {phase === "consent" && info && (
          <AppCard>
            <CardHead
              title="カメラ利用と顔情報の取扱いについて"
              description="内容をご確認のうえ、同意して本人確認を開始してください"
            />
            <div className="space-y-4 border-t border-slate-100 p-5">
              <div className="space-y-3 text-sm leading-relaxed text-slate-700">
                <p>
                  本研修では、受講者本人であることの確認と受講状況の記録のため、
                  お使いの端末のWebカメラ映像を利用します。
                </p>
                <ul className="space-y-1.5 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                  <li>• 顔の特徴量を抽出し、登録済みの情報と照合します（1対1照合）。</li>
                  <li>• 映像の解析は原則としてお使いの端末内で行い、映像そのものは常時送信しません。</li>
                  <li>• 離席・複数人の在席・閉眼を検知した場合、その時点の静止画を証跡として保存します。</li>
                  <li>• 保存期間は組織の設定（現在 {info.rules.evidenceIntervalSec > 0 ? "有効" : "無効"}）に従い、期限後は自動削除されます。</li>
                  <li>• Zoom側の他の参加者の映像を取得することはありません。</li>
                  <li>• 閉眼の検知は「居眠りの疑い」として扱われ、自動的に不合格となることはありません。</li>
                </ul>
                <p className="text-xs text-slate-500">同意文面バージョン: {info.consentPolicyVersion}</p>
              </div>

              <label className="flex items-start gap-2.5 rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={consentChecked}
                  onChange={(e) => setConsentChecked(e.target.checked)}
                />
                <span className="text-cyan-900">
                  上記の内容を理解し、カメラの利用と顔情報の処理に同意します。
                </span>
              </label>

              {error && (
                <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {error}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button className="gap-1.5" disabled={!consentChecked || busy} onClick={() => void grantConsent()}>
                  <ShieldCheck className="size-4" />
                  {busy ? "記録中…" : "同意して本人確認へ"}
                </Button>
                <Button variant="outline" onClick={() => void declineConsent()}>同意しない</Button>
              </div>
            </div>
          </AppCard>
        )}

        {phase === "precheck" && info && (
          <AppCard>
            <CardHead
              title="開始前の本人確認"
              description="カメラの正面を向き、ゆっくり瞬きしてください"
            />
            <div className="space-y-4 border-t border-slate-100 p-5">
              {precheck && precheck.result !== "VERIFIED" && (
                <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                  <div className="font-bold">
                    {precheck.result === "MISMATCH" && "登録された顔情報と一致しませんでした"}
                    {precheck.result === "QUALITY_REJECTED" && "画像の品質が基準を満たしていません"}
                    {precheck.result === "LIVENESS_FAILED" && "生体検知に失敗しました"}
                  </div>
                  {precheck.reasons?.length ? (
                    <ul className="mt-1 list-inside list-disc">
                      {precheck.reasons.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                  ) : (
                    precheck.matchScore != null && (
                      <p className="mt-1">一致度 {percent(precheck.matchScore)}</p>
                    )
                  )}
                  <p className="mt-1 text-xs">
                    残り試行回数 {precheck.attemptsRemaining}回
                    {precheck.escalated && "（管理者確認へ回されました）"}
                  </p>
                </div>
              )}

              {error && (
                <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {error}
                </div>
              )}

              <FaceCapture
                requireLiveness={info.rules.livenessRequired}
                onCapture={handleCapture}
                captureLabel="本人確認を実行"
                busy={busy}
                onVideoReady={(v) => { videoRef.current = v; }}
              />
            </div>
          </AppCard>
        )}

        {phase === "monitoring" && info && (
          <>
            <AppCard className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="size-6 text-emerald-500" />
                  <div>
                    <h2 className="font-extrabold text-slate-950">本人確認が完了しました</h2>
                    <p className="text-sm text-slate-600">
                      一致度 {percent(precheck?.matchScore)} ・ 受講中は画面を開いたままにしてください
                    </p>
                  </div>
                </div>
                <StatusBadge tone={status?.tone ?? "success"}>
                  {status?.message ?? "受講中"}
                </StatusBadge>
              </div>
            </AppCard>

            <AppCard>
              <CardHead title="受講状況" description="検知内容はリアルタイムで管理者に共有されます" />
              <div className="border-t border-slate-100 p-5">
                <video
                  ref={(el) => {
                    // Keep showing the same stream the loop is analysing.
                    if (el && videoRef.current && el !== videoRef.current) {
                      el.srcObject = videoRef.current.srcObject;
                      void el.play().catch(() => undefined);
                    }
                  }}
                  playsInline
                  muted
                  className="mb-4 hidden"
                />
                <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                  <div>
                    <dt>顔検出</dt>
                    <dd>{status?.faceCount ?? 0}件</dd>
                  </div>
                  <div>
                    <dt>最終照合</dt>
                    <dd>{percent(status?.lastMatchScore)}</dd>
                  </div>
                  <div>
                    <dt>最終確認</dt>
                    <dd>{formatTime(status?.lastReauthAt)}</dd>
                  </div>
                  <div>
                    <dt>送信待ち</dt>
                    <dd>{status?.queued ?? 0}件</dd>
                  </div>
                </dl>

                {status && !status.online && (
                  <div className="mt-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                    <WifiOff className="size-4" />
                    オフラインです。記録は端末に保持し、復帰後に送信します。
                  </div>
                )}
                {status && status.faceCount >= 2 && (
                  <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                    <AlertTriangle className="size-4" />
                    複数人が検出されています。1人で受講してください。
                  </div>
                )}
              </div>
            </AppCard>

            <AppCard className="p-5">
              <div className="flex items-start gap-3 text-sm text-slate-600">
                <Video className="mt-0.5 size-4 shrink-0 text-cyan-600" />
                <p>
                  Zoomはこれまでどおりご利用ください。この画面は本人確認と受講状況の記録のみを行い、
                  Zoom側の映像・音声は取得しません。
                </p>
              </div>
              <div className="mt-3 flex items-start gap-3 text-sm text-slate-600">
                <Clock3 className="mt-0.5 size-4 shrink-0 text-cyan-600" />
                <p>研修終了後、この画面を閉じてください。</p>
              </div>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => {
                  loopRef.current?.stop();
                  setPhase("finished");
                }}
              >
                受講を終了する
              </Button>
            </AppCard>
          </>
        )}
      </main>
    </div>
  );
}

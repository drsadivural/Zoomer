/**
 * Participant detail drawer (§23).
 *
 * Everything the organizer needs to decide whether a signal is real: the live
 * state, the numbers behind it, the timeline, the events, and the identity
 * history — including the checks that failed, because a verification log that
 * only shows successes is not a log.
 */
import { useEffect, useState } from "react";
import { Camera, CameraOff, Mic, MicOff, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/shell/primitives";
import { api, ApiClientError, type MeetingParticipantDetail } from "@/lib/api";
import { formatTime } from "@/lib/format";
import {
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TONES,
  EVENT_LABELS,
  HEAD_LABELS,
  IDENTITY_LABELS,
  IDENTITY_TONES,
  SEVERITY_TONES,
  TIER_LABELS,
  ago,
  durationLabel,
} from "@/lib/meeting/signals";
import { FaceOverlay } from "./FaceOverlay";
import { ParticipantTimeline } from "./ParticipantTimeline";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
      <div className="text-[0.68rem] font-semibold text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-slate-900">{value}</div>
    </div>
  );
}

export interface ParticipantDetailProps {
  meetingId: string;
  participantId: string | null;
  onClose: () => void;
  canViewEvidence: boolean;
}

export function ParticipantDetail({
  meetingId,
  participantId,
  onClose,
  canViewEvidence,
}: ParticipantDetailProps) {
  const [data, setData] = useState<MeetingParticipantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [thumbnail, setThumbnail] = useState<string | null>(null);

  useEffect(() => {
    if (!participantId) {
      setData(null);
      setThumbnail(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      setLoading(true);
      api
        .meetingParticipant(meetingId, participantId)
        .then((r) => {
          if (cancelled) return;
          setData(r);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof ApiClientError ? e.message : "参加者情報を取得できません");
        })
        .finally(() => !cancelled && setLoading(false));
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [meetingId, participantId]);

  useEffect(() => {
    const id = data?.participant.thumbnailEvidenceId;
    if (!id || !canViewEvidence) {
      setThumbnail(null);
      return;
    }
    let cancelled = false;
    api
      .evidenceUrl(id)
      .then((r) => !cancelled && setThumbnail(r.url))
      .catch(() => !cancelled && setThumbnail(null));
    return () => {
      cancelled = true;
    };
  }, [data?.participant.thumbnailEvidenceId, canViewEvidence]);

  const p = data?.participant;
  const name = p?.traineeName ?? p?.displayName ?? "参加者";
  const now = data?.serverTime ?? Date.now();

  return (
    <Sheet open={Boolean(participantId)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle className="truncate">{name}</SheetTitle>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="閉じる">
            <X className="size-4" />
          </Button>
        </SheetHeader>

        {error && (
          <div role="alert" className="mx-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        {!p ? (
          <div className="p-4 text-sm text-slate-500">{loading ? "読み込み中…" : "データがありません"}</div>
        ) : (
          <div className="space-y-4 p-4">
            <div className="relative aspect-video overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
              {thumbnail ? (
                <img src={thumbnail} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full place-items-center text-center text-xs text-slate-500">
                  <div>
                    <p className="font-bold text-slate-600">スナップショットは保存されていません</p>
                    <p className="mt-1">設定で「証跡スナップショット」を有効にすると表示されます。</p>
                  </div>
                </div>
              )}
              <FaceOverlay
                box={p.faceBox}
                label={p.faceDetected ? name : null}
                verified={p.identityStatus === "VERIFIED"}
                confidence={p.identityConfidence}
                yaw={p.headYaw}
                pitch={p.headPitch}
                tone={p.identityStatus === "MISMATCH" ? "danger" : p.currentState === "SCREEN_FACING" ? "ok" : "warn"}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={ENGAGEMENT_TONES[p.currentState] ?? "neutral"}>
                {ENGAGEMENT_LABELS[p.currentState] ?? p.currentState}
              </StatusBadge>
              <StatusBadge tone={IDENTITY_TONES[p.identityStatus] ?? "neutral"}>
                {IDENTITY_LABELS[p.identityStatus] ?? p.identityStatus}
              </StatusBadge>
              <span className="text-xs text-slate-500">
                {durationLabel(now - p.currentStateSince)} 継続
              </span>
              <span className="ml-auto flex items-center gap-2 text-slate-500">
                {p.cameraOn ? <Camera className="size-4" /> : <CameraOff className="size-4 text-slate-400" />}
                {p.speaking ? (
                  <Volume2 className="size-4 text-emerald-600" />
                ) : p.microphoneOn ? (
                  <Mic className="size-4" />
                ) : (
                  <MicOff className="size-4 text-slate-400" />
                )}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Field
                label="画面正対"
                value={p.screenFacingProbability != null ? `${(p.screenFacingProbability * 100).toFixed(0)}%` : "—"}
              />
              <Field label="顔検出" value={p.faceDetected ? `${p.faceCount}名` : "なし"} />
              <Field
                label="頭部方向"
                value={`${HEAD_LABELS[p.headState] ?? p.headState}${
                  p.headYaw != null ? ` (${p.headYaw.toFixed(0)}°/${(p.headPitch ?? 0).toFixed(0)}°)` : ""
                }`}
              />
              <Field
                label="解析信頼度"
                value={p.analysisConfidence != null ? `${(p.analysisConfidence * 100).toFixed(0)}%` : "—"}
              />
              <Field label="監視ティア" value={TIER_LABELS[p.analysisTier] ?? p.analysisTier} />
              <Field label="最終解析" value={ago(p.lastAnalyzedAt, now)} />
              <Field label="参加" value={formatTime(p.joinedAt)} />
              <Field label="発話時間" value={`${Math.round(p.speakingMs / 1000)}秒 / ${p.speakingTurns}回`} />
              <Field label="受講者ID" value={p.externalId ?? "未照合"} />
            </div>

            <section>
              <h4 className="mb-2 text-sm font-bold text-slate-900">状態タイムライン</h4>
              <ParticipantTimeline points={data.timeline} now={now} />
            </section>

            <section>
              <h4 className="mb-2 text-sm font-bold text-slate-900">最近のイベント</h4>
              {!data.events.length ? (
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-sm text-slate-500">
                  イベントはありません。
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {data.events.map((e) => (
                    <li key={e.id} className="flex items-start gap-2 px-3 py-2.5">
                      <StatusBadge tone={SEVERITY_TONES[e.severity] ?? "neutral"}>
                        {EVENT_LABELS[e.type] ?? e.type}
                      </StatusBadge>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-700">{e.detail}</p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {formatTime(e.startedAt)}
                          {e.resolvedAt
                            ? ` → ${formatTime(e.resolvedAt)}（${durationLabel(e.durationMs)}）`
                            : " ・ 継続中"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h4 className="mb-2 text-sm font-bold text-slate-900">本人確認の履歴</h4>
              {!data.identityHistory.length ? (
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-sm text-slate-500">
                  記録はありません。
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {data.identityHistory.map((v) => (
                    <li key={v.id} className="flex items-center gap-2 px-3 py-2">
                      <StatusBadge tone={IDENTITY_TONES[v.result] ?? "neutral"}>
                        {IDENTITY_LABELS[v.result] ?? v.result}
                      </StatusBadge>
                      <span className="text-xs text-slate-500">
                        {v.confidence != null ? `一致度 ${(v.confidence * 100).toFixed(1)}%` : "—"}
                        {v.threshold != null && ` / しきい値 ${(v.threshold * 100).toFixed(0)}%`}
                      </span>
                      <span className="ml-auto text-xs text-slate-400">{formatTime(v.verifiedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="rounded-xl bg-slate-50 px-3 py-2 text-[0.7rem] leading-relaxed text-slate-500">
              表示される指標は、カメラ映像から観測できる事象のみに基づきます。受講者の理解度・集中度・
              心理状態を判定するものではありません。
            </p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

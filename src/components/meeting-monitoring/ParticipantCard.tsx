/**
 * One participant tile in the organizer grid.
 *
 * Memoised on the fields it actually renders: a 200-person meeting emits a
 * participant update several times a second, and re-rendering every card for
 * each one is the difference between a smooth grid and an unusable one (§34).
 *
 * There is no live video here by design (§5). The tile shows the most recent
 * analysed thumbnail when snapshots are enabled, and an initials tile when they
 * are not — the organizer's decisions come from the signals, not from watching
 * 50 video feeds.
 */
import { memo, useEffect, useState } from "react";
import {
  AlertTriangle, Camera, CameraOff, EyeOff, Mic, MicOff, ShieldAlert, ShieldCheck, Users, Volume2,
} from "lucide-react";
import { api, type MeetingParticipant } from "@/lib/api";
import { StatusBadge } from "@/components/shell/primitives";
import {
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TONES,
  IDENTITY_LABELS,
  IDENTITY_TONES,
  TIER_LABELS,
  ago,
  needsAttention,
} from "@/lib/meeting/signals";
import { FaceOverlay } from "./FaceOverlay";

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 2);
}

/**
 * Evidence URLs are short-lived signed links (60s), so they are fetched lazily
 * per card and refreshed only while the card is mounted.
 */
function useThumbnail(evidenceId: string | null, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!evidenceId || !enabled) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    api
      .evidenceUrl(evidenceId)
      .then((r) => {
        if (!cancelled) setUrl(r.url);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId, enabled]);

  return url;
}

export interface ParticipantCardProps {
  participant: MeetingParticipant;
  now: number;
  onOpen: (participantId: string) => void;
  canViewEvidence: boolean;
}

function Card({ participant: p, now, onOpen, canViewEvidence }: ParticipantCardProps) {
  const name = p.traineeName ?? p.displayName ?? "未照合の参加者";
  const attention = needsAttention(p.currentState) || p.identityStatus === "MISMATCH";
  const alertLabel = ENGAGEMENT_LABELS[p.currentState] ?? p.currentState;
  const thumbnail = useThumbnail(p.thumbnailEvidenceId, canViewEvidence);
  const tone =
    p.identityStatus === "MISMATCH" || p.currentState === "MULTIPLE_FACES"
      ? "danger"
      : p.currentState === "SCREEN_FACING"
        ? "ok"
        : "warn";

  return (
    <button
      type="button"
      onClick={() => onOpen(p.participantId)}
      aria-label={`${name} の詳細を開く`}
      className={`group flex w-full flex-col overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 ${
        attention ? "border-rose-500 ring-2 ring-rose-400/60 shadow-rose-100" : "border-slate-200"
      } ${p.leftAt ? "opacity-60" : ""}`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="grid h-full w-full place-items-center bg-gradient-to-br from-slate-100 to-slate-200">
            <span className="text-2xl font-extrabold tracking-tight text-slate-400">
              {initials(name)}
            </span>
          </div>
        )}

        <FaceOverlay
          box={p.faceBox}
          label={p.faceDetected ? (p.traineeName ?? p.displayName ?? null) : null}
          verified={p.identityStatus === "VERIFIED"}
          confidence={p.identityConfidence}
          yaw={p.headYaw}
          pitch={p.headPitch}
          tone={tone}
        />

        <div className="absolute left-2 top-2 flex gap-1">
          {p.analysisTier !== "NORMAL" && (
            <span className="rounded-md bg-slate-900/75 px-1.5 py-0.5 text-[0.62rem] font-bold text-white">
              {TIER_LABELS[p.analysisTier] ?? p.analysisTier}
            </span>
          )}
          {p.faceCount > 1 && (
            <span className="flex items-center gap-0.5 rounded-md bg-rose-600/90 px-1.5 py-0.5 text-[0.62rem] font-bold text-white">
              <Users className="size-2.5" />
              {p.faceCount}
            </span>
          )}
        </div>

        <div className="absolute right-2 top-2 flex gap-1">
          <span className="grid size-6 place-items-center rounded-md bg-white/90 text-slate-600">
            {p.cameraOn ? <Camera className="size-3.5" /> : <CameraOff className="size-3.5 text-slate-400" />}
          </span>
          {p.eyeClosed && (
            <span
              className="grid size-6 place-items-center rounded-md bg-rose-600 text-white"
              title="閉眼を検出"
            >
              <EyeOff className="size-3.5" />
            </span>
          )}
          <span className="grid size-6 place-items-center rounded-md bg-white/90 text-slate-600">
            {p.speaking ? (
              <Volume2 className="size-3.5 text-emerald-600" />
            ) : p.microphoneOn ? (
              <Mic className="size-3.5" />
            ) : (
              <MicOff className="size-3.5 text-slate-400" />
            )}
          </span>
        </div>

        {attention && !p.leftAt && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-rose-600/95 py-1 text-[0.68rem] font-bold text-white">
            <AlertTriangle className="size-3" />
            {alertLabel}
          </div>
        )}

        {p.leftAt && (
          <div className="absolute inset-x-0 bottom-0 bg-slate-900/70 py-1 text-center text-[0.65rem] font-bold text-white">
            退出済み
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-1.5 p-3">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-900">{name}</span>
          {p.identityStatus === "VERIFIED" ? (
            <ShieldCheck className="size-4 shrink-0 text-emerald-600" aria-label="本人確認済" />
          ) : (
            <ShieldAlert
              className={`size-4 shrink-0 ${p.identityStatus === "MISMATCH" ? "text-rose-600" : "text-amber-500"}`}
              aria-label={IDENTITY_LABELS[p.identityStatus] ?? p.identityStatus}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge tone={ENGAGEMENT_TONES[p.currentState] ?? "neutral"}>
            {ENGAGEMENT_LABELS[p.currentState] ?? p.currentState}
          </StatusBadge>
          <StatusBadge tone={IDENTITY_TONES[p.identityStatus] ?? "neutral"}>
            {IDENTITY_LABELS[p.identityStatus] ?? p.identityStatus}
          </StatusBadge>
        </div>

        {p.screenFacingProbability != null && (
          <div>
            <div className="flex items-center justify-between text-[0.68rem] font-semibold text-slate-500">
              <span>画面正対</span>
              <span className="tabular-nums">{(p.screenFacingProbability * 100).toFixed(0)}%</span>
            </div>
            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${
                  p.screenFacingProbability >= 0.6 ? "bg-emerald-500" : "bg-amber-400"
                }`}
                style={{ width: `${Math.round(p.screenFacingProbability * 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between text-[0.65rem] text-slate-400">
          <span>解析 {ago(p.lastAnalyzedAt, now)}</span>
          {p.analysisConfidence != null && (
            <span className="tabular-nums">信頼度 {(p.analysisConfidence * 100).toFixed(0)}%</span>
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * Re-render only when something visible changed. `now` is bucketed to 5s by the
 * grid, so the relative timestamps still tick without forcing a redraw per frame.
 */
export const ParticipantCard = memo(Card, (a, b) => {
  const p = a.participant;
  const q = b.participant;
  return (
    a.now === b.now &&
    a.canViewEvidence === b.canViewEvidence &&
    p.participantId === q.participantId &&
    p.currentState === q.currentState &&
    p.identityStatus === q.identityStatus &&
    p.identityConfidence === q.identityConfidence &&
    p.cameraOn === q.cameraOn &&
    p.microphoneOn === q.microphoneOn &&
    p.speaking === q.speaking &&
    p.faceCount === q.faceCount &&
    p.faceDetected === q.faceDetected &&
    p.eyeClosed === q.eyeClosed &&
    p.eyeOpenness === q.eyeOpenness &&
    p.screenFacingProbability === q.screenFacingProbability &&
    p.lastAnalyzedAt === q.lastAnalyzedAt &&
    p.analysisTier === q.analysisTier &&
    p.analysisConfidence === q.analysisConfidence &&
    p.thumbnailEvidenceId === q.thumbnailEvidenceId &&
    p.leftAt === q.leftAt &&
    p.traineeName === q.traineeName &&
    p.displayName === q.displayName &&
    p.headYaw === q.headYaw &&
    p.headPitch === q.headPitch
  );
});

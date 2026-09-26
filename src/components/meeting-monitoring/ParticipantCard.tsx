/**
 * One participant tile in the organizer grid.
 *
 * Memoised on the fields it actually renders: a 200-person meeting emits a
 * participant update several times a second, and re-rendering every card for
 * each one is the difference between a smooth grid and an unusable one (§34).
 *
 * The tile is mostly picture. What goes in it, in order of preference:
 *
 *   1. the latest analysed frame, when snapshots are enabled — the person as
 *      they are now;
 *   2. their enrolment thumbnail, when they are matched to a trainee and the
 *      organization stores those — who *should* be there, so it is labelled
 *      登録写真 and carries no face overlay;
 *   3. initials.
 *
 * There is still no live video feed, and not by preference: Zoom's raw video
 * needs Meeting SDK credentials this deployment does not have. The image slot
 * is the one a video element would occupy.
 *
 * The nine signals sit as an icon strip over the bottom of the image rather
 * than as text under the name, so a wall of tiles reads as faces first and
 * colour second.
 */
import { memo, useEffect, useState } from "react";
import {
  AlertTriangle, Camera, CameraOff, Mic, MicOff, ShieldAlert, ShieldCheck, Volume2,
} from "lucide-react";
import { api, type MeetingParticipant } from "@/lib/api";
import { ENGAGEMENT_LABELS, IDENTITY_LABELS, TIER_LABELS, needsAttention } from "@/lib/meeting/signals";
import { SignalIconStrip } from "@/lib/meeting/signal-icons";
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
  /** Enrolment thumbnails by trainee id, fetched once for the whole grid. */
  enrolledThumbnails?: Record<string, string>;
}

function Card({ participant: p, onOpen, canViewEvidence, enrolledThumbnails }: ParticipantCardProps) {
  const name = p.traineeName ?? p.displayName ?? "未照合の参加者";
  const attention = needsAttention(p.currentState) || p.identityStatus === "MISMATCH";
  const alertLabel = ENGAGEMENT_LABELS[p.currentState] ?? p.currentState;
  const live = useThumbnail(p.thumbnailEvidenceId, canViewEvidence);
  const enrolled = p.traineeId ? enrolledThumbnails?.[p.traineeId] : undefined;
  const image = live ?? enrolled ?? null;
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
        {image ? (
          <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="grid h-full w-full place-items-center bg-gradient-to-br from-slate-100 to-slate-200">
            <span className="text-2xl font-extrabold tracking-tight text-slate-400">
              {initials(name)}
            </span>
          </div>
        )}

        {/* The box belongs to the analysed frame. Drawing it over an enrolment
            photo would mark a face that was never analysed. */}
        {live && (
          <FaceOverlay
            box={p.faceBox}
            label={p.faceDetected ? (p.traineeName ?? p.displayName ?? null) : null}
            verified={p.identityStatus === "VERIFIED"}
            confidence={p.identityConfidence}
            yaw={p.headYaw}
            pitch={p.headPitch}
            tone={tone}
          />
        )}

        <div className="absolute left-2 top-2 flex gap-1">
          {p.analysisTier !== "NORMAL" && (
            <span className="rounded-md bg-slate-900/75 px-1.5 py-0.5 text-[0.62rem] font-bold text-white">
              {TIER_LABELS[p.analysisTier] ?? p.analysisTier}
            </span>
          )}
          {!live && enrolled && (
            <span className="rounded-md bg-slate-900/70 px-1.5 py-0.5 text-[0.62rem] font-bold text-white/90">
              登録写真
            </span>
          )}
        </div>

        <div className="absolute right-2 top-2 flex gap-1">
          <span className="grid size-6 place-items-center rounded-md bg-white/90 text-slate-600">
            {p.cameraOn ? <Camera className="size-3.5" /> : <CameraOff className="size-3.5 text-slate-400" />}
          </span>
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

        {/* Below the corner chips, so it never covers the camera/mic state. */}
        {attention && !p.leftAt && (
          <div className="absolute inset-x-0 top-9 flex items-center justify-center gap-1 bg-rose-600/95 py-1 text-[0.68rem] font-bold text-white">
            <AlertTriangle className="size-3" />
            {alertLabel}
          </div>
        )}

        {p.leftAt ? (
          <div className="absolute inset-x-0 bottom-0 bg-slate-900/70 py-1 text-center text-[0.65rem] font-bold text-white">
            退出済み
          </div>
        ) : (
          <SignalIconStrip participant={p} />
        )}
      </div>

      <div className="flex min-w-0 items-center gap-1.5 px-3 py-2">
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
    </button>
  );
}

/**
 * Re-render only when something visible changed.
 */
export const ParticipantCard = memo(Card, (a, b) => {
  const p = a.participant;
  const q = b.participant;
  return (
    a.canViewEvidence === b.canViewEvidence &&
    // Compared by the one entry this card reads rather than by map identity:
    // the grid hands down a fresh object every time a batch resolves.
    (p.traineeId ? a.enrolledThumbnails?.[p.traineeId] : undefined) ===
      (q.traineeId ? b.enrolledThumbnails?.[q.traineeId] : undefined) &&
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
    p.traineeId === q.traineeId &&
    p.traineeName === q.traineeName &&
    p.displayName === q.displayName &&
    p.headYaw === q.headYaw &&
    p.headPitch === q.headPitch &&
    p.headState === q.headState &&
    p.blinkRatePerMin === q.blinkRatePerMin &&
    p.blinkCount === q.blinkCount &&
    p.sharpness === q.sharpness
  );
});

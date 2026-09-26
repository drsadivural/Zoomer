/**
 * The nine signals as an icon strip.
 *
 * The tile's job is to show the person; the signals sit over the bottom of
 * that image rather than as a block of text under their name, so an organizer
 * scanning a wall of tiles reads faces first and colour second.
 *
 * Each icon keeps its position whatever its state — the strip is a fixed row
 * of nine, so "the fourth one is red" is readable at a glance across the whole
 * grid. Only the colour changes. The label and measured value stay available
 * through the title attribute, which is also what a screen reader announces.
 */
import {
  Aperture,
  Compass,
  DoorOpen,
  Eye,
  EyeOff,
  Moon,
  ScanFace,
  Sparkles,
  UserRoundX,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { participantSignals, type ParticipantSignal, type SignalTone } from "./participant-signals";
import type { MeetingParticipant } from "@/lib/api";

const ICONS: Record<string, LucideIcon> = {
  face: ScanFace,
  head: Compass,
  eyes: Eye,
  blink: Sparkles,
  sharpness: Aperture,
  away: DoorOpen,
  multi: Users,
  drowsy: Moon,
  identity: UserRoundX,
};

/**
 * Over a photograph, so the palette is opaque chips rather than the tinted
 * backgrounds used on white. `idle` stays deliberately flat: an unmeasured
 * signal must not read as a reassuring green.
 */
const CHIP: Record<SignalTone, string> = {
  ok: "bg-emerald-500/90 text-white",
  warn: "bg-amber-500/95 text-white",
  bad: "bg-rose-600 text-white",
  idle: "bg-slate-900/45 text-white/60",
};

function iconFor(signal: ParticipantSignal): LucideIcon {
  // The one state worth a different glyph rather than only a different colour:
  // shut eyes are the signal most often acted on.
  if (signal.key === "eyes" && signal.value === "閉") return EyeOff;
  return ICONS[signal.key] ?? ScanFace;
}

export function SignalIconStrip({ participant }: { participant: MeetingParticipant }) {
  const signals = participantSignals(participant);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center gap-[3px] bg-gradient-to-t from-black/55 to-transparent px-1.5 pb-1.5 pt-4">
      {signals.map((s) => {
        const Icon = iconFor(s);
        return (
          <span
            key={s.key}
            // Readable by pointer and by assistive tech; the grid itself stays
            // silent, so this is the only place the value is spoken.
            title={s.detail ? `${s.label}: ${s.value} — ${s.detail}` : `${s.label}: ${s.value}`}
            aria-label={`${s.label}: ${s.value}`}
            role="img"
            className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] ${CHIP[s.tone]}`}
          >
            <Icon className="size-[11px]" strokeWidth={2.5} />
          </span>
        );
      })}
    </div>
  );
}

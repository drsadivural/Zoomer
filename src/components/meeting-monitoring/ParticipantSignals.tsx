/**
 * The nine named signals, as a grid under a participant tile.
 *
 * Every signal is always present, including the ones that were not measured:
 * an organizer scanning twenty tiles needs the same nine cells in the same nine
 * positions, and a signal that disappears when it has nothing to say is a
 * signal nobody notices is missing.
 */
import { participantSignals, SIGNAL_TONE_CLASS } from "@/lib/meeting/participant-signals";
import type { MeetingParticipant } from "@/lib/api";

export function ParticipantSignals({
  participant,
  columns = 3,
}: {
  participant: MeetingParticipant;
  columns?: 2 | 3;
}) {
  const signals = participantSignals(participant);
  return (
    <dl className={`grid gap-1 ${columns === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
      {signals.map((s) => (
        <div
          key={s.key}
          title={s.detail ? `${s.label}: ${s.value} — ${s.detail}` : `${s.label}: ${s.value}`}
          className={`min-w-0 rounded-lg px-1.5 py-1 ring-1 ${SIGNAL_TONE_CLASS[s.tone]}`}
        >
          <dt className="truncate text-[0.6rem] font-semibold opacity-80">{s.label}</dt>
          <dd className="truncate text-[0.68rem] font-bold tabular-nums">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The same nine, with their explanatory detail, for the participant drawer. */
export function ParticipantSignalList({ participant }: { participant: MeetingParticipant }) {
  const signals = participantSignals(participant);
  return (
    <dl className="space-y-1.5">
      {signals.map((s) => (
        <div key={s.key} className="flex items-baseline gap-2 text-sm">
          <dt className="w-24 shrink-0 text-xs font-semibold text-slate-500">{s.label}</dt>
          <dd className="min-w-0 flex-1">
            <span
              className={`rounded-md px-1.5 py-0.5 text-xs font-bold ring-1 ${SIGNAL_TONE_CLASS[s.tone]}`}
            >
              {s.value}
            </span>
            {s.detail && <span className="ml-2 text-xs text-slate-500">{s.detail}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

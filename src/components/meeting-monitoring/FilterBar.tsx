/**
 * Organizer filters, search and sort (§22).
 *
 * "リスク順" is the default sort, not alphabetical: the grid's job is to put the
 * people who need a decision at the top, not to be a directory.
 */
import { Search } from "lucide-react";
import type { MeetingParticipant } from "@/lib/api";
import { isLookingAway, needsAttention, riskOf } from "@/lib/meeting/signals";

export type ParticipantFilter =
  | "all"
  | "attention"
  | "screen-facing"
  | "looking-away"
  | "face-missing"
  | "eyes-closed"
  | "camera-off"
  | "multiple-faces"
  | "unverified"
  | "mismatch"
  | "speaking";

export type ParticipantSort = "risk" | "name" | "last-analyzed" | "screen-facing";

export const FILTERS: { id: ParticipantFilter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "attention", label: "要対応" },
  { id: "screen-facing", label: "画面正対" },
  { id: "looking-away", label: "視線が外れている" },
  { id: "face-missing", label: "顔が映っていない" },
  { id: "eyes-closed", label: "閉眼・居眠り疑い" },
  { id: "camera-off", label: "カメラオフ" },
  { id: "multiple-faces", label: "複数人" },
  { id: "unverified", label: "本人未確認" },
  { id: "mismatch", label: "本人と不一致" },
  { id: "speaking", label: "発話中" },
];

const SORTS: { id: ParticipantSort; label: string }[] = [
  { id: "risk", label: "リスク順" },
  { id: "name", label: "氏名順" },
  { id: "last-analyzed", label: "最終解析順" },
  { id: "screen-facing", label: "画面正対率順" },
];

export function matchesFilter(p: MeetingParticipant, filter: ParticipantFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return needsAttention(p.currentState) || p.identityStatus === "MISMATCH";
    case "screen-facing":
      return p.currentState === "SCREEN_FACING";
    case "looking-away":
      return isLookingAway(p.currentState);
    case "face-missing":
      return p.currentState === "FACE_NOT_VISIBLE";
    case "eyes-closed":
      return p.currentState === "EYES_CLOSED" || p.eyeClosed === true;
    case "camera-off":
      return !p.cameraOn;
    case "multiple-faces":
      return p.faceCount > 1 || p.currentState === "MULTIPLE_FACES";
    case "unverified":
      return p.identityStatus !== "VERIFIED";
    case "mismatch":
      return p.identityStatus === "MISMATCH";
    case "speaking":
      return p.speaking;
    default:
      return true;
  }
}

export function sortParticipants(
  participants: MeetingParticipant[],
  sort: ParticipantSort,
): MeetingParticipant[] {
  const copy = [...participants];
  switch (sort) {
    case "name":
      return copy.sort((a, b) =>
        (a.traineeName ?? a.displayName ?? "").localeCompare(b.traineeName ?? b.displayName ?? "", "ja"),
      );
    case "last-analyzed":
      return copy.sort((a, b) => (b.lastAnalyzedAt ?? 0) - (a.lastAnalyzedAt ?? 0));
    case "screen-facing":
      return copy.sort((a, b) => (b.screenFacingProbability ?? 0) - (a.screenFacingProbability ?? 0));
    case "risk":
    default:
      return copy.sort(
        (a, b) =>
          riskOf(b.currentState, b.identityStatus) - riskOf(a.currentState, a.identityStatus) ||
          (a.traineeName ?? a.displayName ?? "").localeCompare(b.traineeName ?? b.displayName ?? "", "ja"),
      );
  }
}

export function searchParticipants(
  participants: MeetingParticipant[],
  query: string,
): MeetingParticipant[] {
  const q = query.trim().toLowerCase();
  if (!q) return participants;
  return participants.filter((p) =>
    [p.traineeName, p.displayName, p.externalId, p.department]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q)),
  );
}

export interface FilterBarProps {
  filter: ParticipantFilter;
  onFilter: (f: ParticipantFilter) => void;
  sort: ParticipantSort;
  onSort: (s: ParticipantSort) => void;
  query: string;
  onQuery: (q: string) => void;
  counts: Partial<Record<ParticipantFilter, number>>;
}

export function FilterBar({ filter, onFilter, sort, onSort, query, onQuery, counts }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="参加者を検索（氏名・受講者ID・所属）"
          aria-label="参加者を検索"
          className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm"
        />
      </div>

      <label className="sr-only" htmlFor="participant-sort">
        並び替え
      </label>
      <select
        id="participant-sort"
        value={sort}
        onChange={(e) => onSort(e.target.value as ParticipantSort)}
        className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
      >
        {SORTS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>

      <div className="flex w-full flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
        {FILTERS.map((f) => {
          const count = counts[f.id];
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onFilter(f.id)}
              aria-pressed={active}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${
                active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {f.label}
              {count != null && count > 0 && (
                <span className={`ml-1 tabular-nums ${active ? "text-cyan-600" : "text-slate-400"}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

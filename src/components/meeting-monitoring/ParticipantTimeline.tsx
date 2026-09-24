/**
 * Participant state timeline (§24).
 *
 * A horizontal strip of observation samples, coloured by engagement state. The
 * gaps between samples are drawn as the state that surrounds them, which is the
 * only honest rendering of sampled analysis — and the legend says how many
 * samples the strip is made of so nobody mistakes it for continuous recording.
 */
import { useMemo, useState } from "react";
import type { TimelinePoint } from "@/lib/api";
import { ENGAGEMENT_LABELS, STATE_COLORS } from "@/lib/meeting/signals";
import { formatClock } from "@/lib/format";

const ZOOMS = [
  { id: "5m", label: "5分", ms: 5 * 60_000 },
  { id: "15m", label: "15分", ms: 15 * 60_000 },
  { id: "30m", label: "30分", ms: 30 * 60_000 },
  { id: "all", label: "全体", ms: 0 },
] as const;

type ZoomId = (typeof ZOOMS)[number]["id"];

export interface ParticipantTimelineProps {
  points: TimelinePoint[];
  now: number;
}

interface Segment {
  state: string;
  startAt: number;
  endAt: number;
}

/** Collapses consecutive same-state samples into drawable runs. */
function toSegments(points: TimelinePoint[], now: number): Segment[] {
  if (!points.length) return [];
  const segments: Segment[] = [];
  let current: Segment = { state: points[0].state, startAt: points[0].observedAt, endAt: points[0].observedAt };

  for (const point of points.slice(1)) {
    if (point.state === current.state) {
      current.endAt = point.observedAt;
    } else {
      current.endAt = point.observedAt;
      segments.push(current);
      current = { state: point.state, startAt: point.observedAt, endAt: point.observedAt };
    }
  }
  current.endAt = Math.max(current.endAt, Math.min(now, current.endAt + 5_000));
  segments.push(current);
  return segments;
}

export function ParticipantTimeline({ points, now }: ParticipantTimelineProps) {
  const [zoom, setZoom] = useState<ZoomId>("15m");
  const [hover, setHover] = useState<Segment | null>(null);

  const window = ZOOMS.find((z) => z.id === zoom)!.ms;
  const visible = useMemo(
    () => (window ? points.filter((p) => p.observedAt >= now - window) : points),
    [points, window, now],
  );

  const segments = useMemo(() => toSegments(visible, now), [visible, now]);
  const from = visible[0]?.observedAt ?? now - (window || 60_000);
  const to = Math.max(now, visible[visible.length - 1]?.observedAt ?? now);
  const span = Math.max(1, to - from);

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of visible) counts.set(p.state, (counts.get(p.state) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [visible]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={() => setZoom(z.id)}
              aria-pressed={zoom === z.id}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                zoom === z.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              {z.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400">解析サンプル {visible.length}件</span>
      </div>

      {!visible.length ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
          この期間の解析データはありません。
        </p>
      ) : (
        <>
          <div
            className="relative h-9 w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
            role="img"
            aria-label="参加者の状態タイムライン"
          >
            {segments.map((segment, i) => {
              const left = ((segment.startAt - from) / span) * 100;
              const width = Math.max(0.4, ((segment.endAt - segment.startAt) / span) * 100);
              return (
                <div
                  key={`${segment.startAt}-${i}`}
                  className="absolute inset-y-0 cursor-help"
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    backgroundColor: STATE_COLORS[segment.state] ?? STATE_COLORS.UNKNOWN,
                  }}
                  onMouseEnter={() => setHover(segment)}
                  onMouseLeave={() => setHover(null)}
                  title={`${ENGAGEMENT_LABELS[segment.state] ?? segment.state} ${formatClock(segment.startAt)}`}
                />
              );
            })}
          </div>

          <div className="flex items-center justify-between text-[0.68rem] text-slate-400">
            <span>{formatClock(from)}</span>
            <span>
              {hover
                ? `${ENGAGEMENT_LABELS[hover.state] ?? hover.state} ・ ${formatClock(hover.startAt)}`
                : ""}
            </span>
            <span>{formatClock(to)}</span>
          </div>

          <div className="flex flex-wrap gap-2">
            {legend.map(([state, count]) => (
              <span key={state} className="flex items-center gap-1.5 text-[0.68rem] text-slate-600">
                <span
                  className="size-2.5 rounded-sm"
                  style={{ backgroundColor: STATE_COLORS[state] ?? STATE_COLORS.UNKNOWN }}
                />
                {ENGAGEMENT_LABELS[state] ?? state}
                <span className="tabular-nums text-slate-400">{count}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

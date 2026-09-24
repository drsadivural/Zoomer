/**
 * Face box + direction overlay drawn over a participant thumbnail.
 *
 * Coordinates are normalised (0..1) so the same box fits a 120px card and a
 * full-width drawer without the caller doing arithmetic. Nothing here touches
 * the Zoom client UI — this is Ayonix Zoomer's own thumbnail, as §21 requires.
 *
 * The geometry is SVG with `preserveAspectRatio="none"` so the box tracks the
 * image however it is letterboxed; the label is plain HTML on top, because the
 * same non-uniform scaling that makes the box correct would stretch text into
 * illegibility on a wide tile.
 */
import type { FaceBox } from "@/lib/api";

export interface FaceOverlayProps {
  box: FaceBox | null;
  label?: string | null;
  verified?: boolean;
  confidence?: number | null;
  /** Degrees; drives the small direction arrow. */
  yaw?: number | null;
  pitch?: number | null;
  showGaze?: boolean;
  tone?: "ok" | "warn" | "danger";
}

const TONES = {
  ok: { stroke: "#10b981", fill: "rgba(16,185,129,0.12)", chip: "bg-emerald-500" },
  warn: { stroke: "#f59e0b", fill: "rgba(245,158,11,0.14)", chip: "bg-amber-500" },
  danger: { stroke: "#ef4444", fill: "rgba(239,68,68,0.16)", chip: "bg-rose-500" },
};

export function FaceOverlay({
  box,
  label,
  verified,
  confidence,
  yaw,
  pitch,
  showGaze = true,
  tone = "ok",
}: FaceOverlayProps) {
  if (!box) return null;

  const colors = TONES[tone];
  const x = Math.max(0, Math.min(1, box.x)) * 100;
  const y = Math.max(0, Math.min(1, box.y)) * 100;
  const w = Math.max(2, Math.min(100 - x, box.width * 100));
  const h = Math.max(2, Math.min(100 - y, box.height * 100));

  // Arrow length is capped so a large yaw cannot draw outside the tile.
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = Math.max(-18, Math.min(18, ((yaw ?? 0) / 45) * 18));
  const dy = Math.max(-18, Math.min(18, ((-(pitch ?? 0)) / 45) * 18));

  return (
    <div className="pointer-events-none absolute inset-0">
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={1}
          fill={colors.fill}
          stroke={colors.stroke}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {showGaze && (yaw != null || pitch != null) && (
          <line
            x1={cx}
            y1={cy}
            x2={cx + dx}
            y2={cy + dy}
            stroke={colors.stroke}
            strokeWidth={1.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            opacity={0.9}
          />
        )}
      </svg>

      {label && (
        <div
          // Anchored to the box's left edge, below the top edge when the box is
          // too close to the top for the label to sit above it.
          className="absolute max-w-[92%] truncate"
          style={{ left: `${x}%`, top: y > 12 ? `calc(${y}% - 1.15rem)` : `${y}%` }}
        >
          <span
            className={`inline-block max-w-full truncate rounded px-1 py-px text-[0.6rem] font-bold leading-tight text-white ${colors.chip}`}
          >
            {verified ? "✓ " : ""}
            {label}
            {confidence != null ? ` ${(confidence * 100).toFixed(0)}%` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

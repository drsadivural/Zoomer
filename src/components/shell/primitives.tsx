/**
 * Design primitives lifted from the approved mockup. The CSS classes
 * (`brand-mark`, `app-card`, `icon-tile`, `event-icon`) live in globals.css and
 * are shared verbatim with that mockup, so the visual language is identical.
 */
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3" aria-label="Ayonix Zoomer">
      <div className="brand-mark" aria-hidden="true">
        <span>A</span>
      </div>
      {!compact && (
        <div className="leading-none">
          <div className="text-[1.05rem] font-extrabold tracking-[0.12em] text-white">AYONIX</div>
          <div className="mt-1 text-[0.72rem] font-semibold tracking-[0.2em] text-cyan-300">
            ZOOMER
          </div>
        </div>
      )}
    </div>
  );
}

const TONE_STYLES: Record<Tone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  danger: "border-rose-200 bg-rose-50 text-rose-700",
  info: "border-cyan-200 bg-cyan-50 text-cyan-700",
  neutral: "border-slate-200 bg-slate-50 text-slate-600",
};

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge variant="outline" className={`gap-1.5 px-2.5 py-1 font-semibold ${TONE_STYLES[tone]}`}>
      {children}
    </Badge>
  );
}

export function AppCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`app-card ${className}`}>{children}</section>;
}

export function CardHead({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card-head">
      <div>
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function IconTile({
  color,
  children,
}: {
  color: "blue" | "cyan" | "amber" | "emerald";
  children: ReactNode;
}) {
  return <div className={`icon-tile icon-${color}`}>{children}</div>;
}

export function EventIcon({ tone, children }: { tone: Tone; children: ReactNode }) {
  const cls =
    tone === "danger" ? "event-danger" : tone === "success" ? "event-success" : "event-warning";
  return <div className={`event-icon ${cls}`}>{children}</div>;
}

export function MetricTile({
  label,
  value,
  hint,
  color,
  icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  color: "blue" | "cyan" | "amber" | "emerald";
  icon: ReactNode;
}) {
  return (
    <AppCard className="flex items-center gap-4 p-5">
      <IconTile color={color}>{icon}</IconTile>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-500">{label}</div>
        <div className="mt-0.5 text-2xl font-extrabold tracking-tight text-slate-950">{value}</div>
        {hint && <div className="mt-0.5 truncate text-xs text-slate-500">{hint}</div>}
      </div>
    </AppCard>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <p className="text-base font-bold text-slate-700">{title}</p>
      {description && <p className="max-w-md text-sm text-slate-500">{description}</p>}
      {action}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-11 animate-pulse rounded-xl bg-slate-100" />
      ))}
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="m-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
    >
      <div className="font-semibold">読み込みに失敗しました</div>
      <div className="mt-1">{message}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-bold text-rose-700"
        >
          再試行
        </button>
      )}
    </div>
  );
}

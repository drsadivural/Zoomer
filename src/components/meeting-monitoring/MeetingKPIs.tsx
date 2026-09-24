/**
 * Top-of-page KPI cards and meeting status strip.
 *
 * Ordered to answer §47's question first: "who needs my attention?" is the
 * leftmost card and the only one that turns red.
 */
import { AlertTriangle, Camera, Eye, ShieldAlert, UserCheck, Users, Volume2 } from "lucide-react";
import type { MeetingAnalysisResponse, MeetingKpis } from "@/lib/api";
import { AppCard, IconTile } from "@/components/shell/primitives";
import { formatClock } from "@/lib/format";

function Tile({
  label,
  value,
  hint,
  color,
  icon,
  urgent = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  color: "blue" | "cyan" | "amber" | "emerald";
  icon: React.ReactNode;
  urgent?: boolean;
}) {
  return (
    <AppCard
      className={`flex items-center gap-3 p-4 ${urgent ? "border-rose-300 bg-rose-50/60 ring-1 ring-rose-200" : ""}`}
    >
      <IconTile color={color}>{icon}</IconTile>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-slate-500">{label}</div>
        <div
          className={`mt-0.5 text-2xl font-extrabold tracking-tight tabular-nums ${
            urgent ? "text-rose-700" : "text-slate-950"
          }`}
        >
          {value}
        </div>
        {hint && <div className="truncate text-[0.68rem] text-slate-500">{hint}</div>}
      </div>
    </AppCard>
  );
}

function elapsed(startsAt: number, now: number): string {
  const ms = Math.max(0, now - startsAt);
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, "0")}分`;
}

export function MeetingStatusStrip({
  data,
  now,
}: {
  data: MeetingAnalysisResponse;
  now: number;
}) {
  const live = data.session.status === "LIVE";
  const run = data.analysis;
  const stale = Boolean(run?.stale);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <span
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${
          live ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"
        }`}
      >
        <span className={`size-2 rounded-full ${live ? "animate-pulse bg-rose-500" : "bg-slate-400"}`} />
        {live ? "LIVE" : data.session.status}
      </span>

      <div className="min-w-0">
        <div className="truncate text-sm font-bold text-slate-900">{data.session.title}</div>
        <div className="text-xs text-slate-500">
          開始 {formatClock(data.session.startsAt)} ・ 経過 {elapsed(data.session.startsAt, now)}
          {data.session.zoomMeetingId && ` ・ Zoom ${data.session.zoomMeetingId}`}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {run ? (
          <span
            className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
              stale
                ? "bg-amber-50 text-amber-700"
                : run.status === "RUNNING"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-slate-100 text-slate-600"
            }`}
          >
            解析 {stale ? "応答なし（表示は最終値）" : run.status} ・ {run.adapter}
          </span>
        ) : (
          <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
            解析停止中
          </span>
        )}
      </div>
    </div>
  );
}

export function MeetingKPIs({ kpis }: { kpis: MeetingKpis }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <Tile
        label="要対応"
        value={kpis.needsAttention}
        hint="不一致・複数人・顔なし・カメラオフ"
        color="amber"
        icon={<AlertTriangle />}
        urgent={kpis.needsAttention > 0}
      />
      <Tile label="参加者" value={kpis.participants} hint={`在席 ${kpis.present}名`} color="blue" icon={<Users />} />
      <Tile label="カメラON" value={kpis.cameraOn} hint={`全 ${kpis.present}名中`} color="cyan" icon={<Camera />} />
      <Tile
        label="画面正対"
        value={kpis.screenFacing}
        hint={`視線が外れている ${kpis.lookingAway}名`}
        color="emerald"
        icon={<Eye />}
      />
      <Tile label="未確認" value={kpis.unverified} hint="本人確認が未完了" color="amber" icon={<ShieldAlert />} />
      <Tile
        label="未解決イベント"
        value={kpis.alerts}
        hint={`発話中 ${kpis.speaking}名`}
        color="blue"
        icon={kpis.speaking > 0 ? <Volume2 /> : <UserCheck />}
      />
    </div>
  );
}

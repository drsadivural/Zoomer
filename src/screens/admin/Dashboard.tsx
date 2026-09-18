import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, CheckCircle2, Clock3, Eye, ShieldCheck, Users, Video, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiClientError, type DashboardResponse } from "@/lib/api";
import {
  AppCard, CardHead, EmptyState, ErrorNotice, EventIcon, LoadingRows, MetricTile, StatusBadge,
  type Tone,
} from "@/components/shell/primitives";
import { formatClock, formatDate, formatTime, percent, SESSION_STATUS_LABELS } from "@/lib/format";

const SEVERITY_TONE: Record<string, Tone> = {
  ALERT: "danger",
  WARNING: "warning",
  INFO: "success",
};

export function DashboardScreen() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    api
      .dashboard()
      .then(setData)
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "不明なエラー"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // Dashboard figures are a summary, not a live feed: a slow poll is enough.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <ErrorNotice message={error} onRetry={load} />;

  const live = data?.sessions.filter((s) => s.status === "LIVE") ?? [];
  const maxTrend = Math.max(1, ...(data?.trend.map((t) => t.count) ?? [1]));

  return (
    <>
      <section className="hero-strip">
        <div className="max-w-xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-bold tracking-wide text-cyan-100">
            <ShieldCheck className="size-3.5" />
            顔認証による本人確認・継続監視
          </div>
          <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-white sm:text-[1.75rem]">
            本日の研修を監視しています
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-cyan-50/90">
            受講者は Zoom と併用する受講画面で同意の上カメラを提供します。本人確認・離席・複数人・居眠り疑いを検知し、証跡を保存します。
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button asChild variant="secondary" className="gap-2 font-bold">
            <Link to="/monitor">
              <Video className="size-4" />
              ライブ監視へ
            </Link>
          </Button>
          <Button asChild variant="ghost" className="gap-2 border border-white/25 text-white hover:bg-white/10">
            <Link to="/sessions">
              <Clock3 className="size-4" />
              研修を管理
            </Link>
          </Button>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="接続中"
          value={loading && !data ? "—" : data?.metrics.connected ?? 0}
          hint={`進行中 ${live.length} 件`}
          color="blue"
          icon={<Users />}
        />
        <MetricTile
          label="正常受講"
          value={loading && !data ? "—" : data?.metrics.normal ?? 0}
          hint="継続認証が成功しています"
          color="emerald"
          icon={<CheckCircle2 />}
        />
        <MetricTile
          label="要確認"
          value={loading && !data ? "—" : data?.metrics.needsReview ?? 0}
          hint="管理者の確認が必要です"
          color="amber"
          icon={<AlertTriangle />}
        />
        <MetricTile
          label="本人確認率"
          value={loading && !data ? "—" : percent(data?.metrics.verifiedRate, 0)}
          hint={`${data?.metrics.verified ?? 0} / ${data?.metrics.assigned ?? 0} 名`}
          color="cyan"
          icon={<ShieldCheck />}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        <AppCard>
          <CardHead title="本日の研修" description="進行中の研修からライブ監視へ移動できます" />
          {loading && !data ? (
            <LoadingRows />
          ) : !data?.sessions.length ? (
            <EmptyState
              title="本日の研修はありません"
              description="研修管理から新しい研修を作成してください。"
              action={
                <Button asChild variant="outline" className="mt-1">
                  <Link to="/sessions">研修を作成</Link>
                </Button>
              }
            />
          ) : (
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {data.sessions.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-bold text-slate-900">{s.title}</span>
                      <StatusBadge tone={s.status === "LIVE" ? "success" : "neutral"}>
                        {SESSION_STATUS_LABELS[s.status] ?? s.status}
                      </StatusBadge>
                    </div>
                    <div className="mt-1 text-sm text-slate-500">
                      {formatClock(s.startsAt)}–{formatClock(s.endsAt)} ・ 受講者 {s.participantCount}名
                      {s.alertCount > 0 && (
                        <span className="ml-2 font-semibold text-rose-600">要確認 {s.alertCount}件</span>
                      )}
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm" className="gap-1.5">
                    <Link to={`/monitor?session=${s.id}`}>
                      <Eye className="size-3.5" />
                      監視
                    </Link>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </AppCard>

        <AppCard>
          <CardHead title="アラート推移" description="直近7日間の警告・異常件数" />
          <div className="chart-wrap" role="img" aria-label="直近7日間のアラート推移">
            <div className="chart-y">
              <span>{maxTrend}</span>
              <span>{Math.round(maxTrend / 2)}</span>
              <span>0</span>
            </div>
            <div className="chart-grid relative flex items-end gap-2 px-1 pb-0">
              {(data?.trend ?? []).map((t) => (
                <div key={t.date} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <div
                    className="w-full rounded-t-md bg-[#12a8c8]"
                    style={{ height: `${Math.max(3, (t.count / maxTrend) * 165)}px` }}
                    title={`${formatDate(t.date)}: ${t.count}件`}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="chart-labels">
            {(data?.trend ?? []).map((t) => (
              <span key={t.date}>{formatDate(t.date)}</span>
            ))}
          </div>
        </AppCard>
      </div>

      <AppCard>
        <CardHead title="最新アラート" description="確認が必要なイベント" action={
          <Button asChild variant="outline" size="sm">
            <Link to="/logs">すべて表示</Link>
          </Button>
        } />
        {loading && !data ? (
          <LoadingRows rows={3} />
        ) : !data?.recentAlerts.length ? (
          <EmptyState title="アラートはありません" description="現在、確認が必要なイベントはありません。" />
        ) : (
          <div className="divide-y divide-slate-100 border-t border-slate-100">
            {data.recentAlerts.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-5 py-4">
                <EventIcon tone={SEVERITY_TONE[a.severity] ?? "warning"}>
                  {a.severity === "ALERT" ? <AlertTriangle /> : <Zap />}
                </EventIcon>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-slate-900">{a.traineeName ?? "未照合の参加者"}</span>
                    <StatusBadge tone={SEVERITY_TONE[a.severity] ?? "warning"}>{a.type}</StatusBadge>
                    <span className="text-xs font-semibold text-slate-400">{formatTime(a.openedAt)}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{a.detail ?? a.summary}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </AppCard>
    </>
  );
}

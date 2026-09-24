/**
 * Reports — end-of-meeting analytics with CSV / JSON / PDF export (§26).
 *
 * PDF is produced through the browser's own print pipeline rather than a
 * bundled PDF library: it keeps the export visually identical to what the
 * organizer reviewed on screen, and adds no dependency to a Worker bundle.
 *
 * The existing CSV exports on 証跡・ログ are untouched; these are additional.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, FileJson, Printer, RefreshCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppCard, CardHead, EmptyState, ErrorNotice, LoadingRows, MetricTile } from "@/components/shell/primitives";
import { api, ApiClientError, type MeetingReportResponse } from "@/lib/api";
import { useSessionPicker } from "@/lib/meeting/use-meeting";
import { IDENTITY_LABELS } from "@/lib/meeting/signals";
import { formatClock, formatDateTime } from "@/lib/format";
import { useCan } from "@/lib/auth-context";
import { Clock, Camera, Eye, ShieldCheck, Users, Volume2 } from "lucide-react";

function minutes(ms: number): string {
  return `${Math.round(ms / 60000)}分`;
}

export function MeetingReportsScreen() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const sessionId = params.get("session");

  const { sessions, error: sessionsError } = useSessionPicker(sessionId, (id) =>
    setParams({ session: id }, { replace: true }),
  );

  const [report, setReport] = useState<MeetingReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!sessionId) {
      setReport(null);
      return;
    }
    setLoading(true);
    api
      .meetingReport(sessionId)
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "レポートを取得できません"))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(load, [load]);

  function downloadJson() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-report-${report.summary.sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function freeze() {
    if (!sessionId) return;
    try {
      await api.saveMeetingReport(sessionId);
      setNotice("レポートを保存しました（解析データの保存期限後も参照できます）");
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "保存に失敗しました");
    }
  }

  if (!sessions.length && sessionsError) return <ErrorNotice message={sessionsError} />;

  return (
    <>
      <div className="monitor-toolbar print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="report-session">
            会議を選択
          </label>
          <select
            id="report-session"
            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
            value={sessionId ?? ""}
            onChange={(e) => setParams({ session: e.target.value })}
          >
            <option value="">会議を選択</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}（{formatClock(s.startsAt)}）
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={load}>
            <RefreshCcw className="size-3.5" />
            更新
          </Button>
          {sessionId && can("report:create") && (
            <>
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <a href={api.meetingReportCsvUrl(sessionId)}>
                  <Download className="size-3.5" />
                  CSV
                </a>
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={downloadJson} disabled={!report}>
                <FileJson className="size-3.5" />
                JSON
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.print()} disabled={!report}>
                <Printer className="size-3.5" />
                PDF（印刷）
              </Button>
              <Button size="sm" className="gap-1.5" onClick={freeze} disabled={!report}>
                <Save className="size-3.5" />
                レポートを保存
              </Button>
            </>
          )}
        </div>
      </div>

      {notice && (
        <div role="status" className="rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-sm text-cyan-800">
          {notice}
        </div>
      )}
      {error && <ErrorNotice message={error} onRetry={load} />}

      {!sessionId ? (
        <AppCard>
          <EmptyState title="会議を選択してください" />
        </AppCard>
      ) : loading && !report ? (
        <AppCard>
          <LoadingRows rows={6} />
        </AppCard>
      ) : !report ? (
        <AppCard>
          <EmptyState title="レポートを生成できません" description="解析データがまだありません。" />
        </AppCard>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <MetricTile
              label="参加者"
              value={report.summary.participantCount}
              hint={`平均在席 ${minutes(report.summary.averagePresenceMs)}`}
              color="blue"
              icon={<Users />}
            />
            <MetricTile
              label="会議時間"
              value={minutes(report.summary.durationMs)}
              hint={`解析サンプル ${report.summary.totalSamples.toLocaleString()}件`}
              color="cyan"
              icon={<Clock />}
            />
            <MetricTile
              label="本人確認率"
              value={`${report.summary.identityVerifiedPct}%`}
              hint={`不一致イベント ${report.summary.identityMismatchEvents}件`}
              color="emerald"
              icon={<ShieldCheck />}
            />
            <MetricTile
              label="カメラON率"
              value={`${report.summary.cameraOnPct}%`}
              hint={`カメラオフ計 ${minutes(report.summary.cameraOffMs)}`}
              color="blue"
              icon={<Camera />}
            />
            <MetricTile
              label="画面正対率"
              value={`${report.summary.screenFacingPct}%`}
              hint={`顔検出率 ${report.summary.faceVisiblePct}%`}
              color="emerald"
              icon={<Eye />}
            />
            <MetricTile
              label="発話した参加者"
              value={report.summary.speakingParticipants}
              hint={`合計発話 ${minutes(report.summary.totalSpeakingMs)}`}
              color="amber"
              icon={<Volume2 />}
            />
          </div>

          <AppCard>
            <CardHead
              title="参加者別レポート"
              description={report.summary.basis}
              action={
                <span className="text-xs font-semibold text-slate-400">
                  生成 {formatDateTime(report.summary.generatedAt)}
                </span>
              }
            />
            {!report.participants.length ? (
              <EmptyState title="参加者データがありません" />
            ) : (
              <div className="overflow-x-auto border-t border-slate-100">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>氏名</TableHead>
                      <TableHead>受講者ID</TableHead>
                      <TableHead>在席</TableHead>
                      <TableHead>顔検出</TableHead>
                      <TableHead>画面正対</TableHead>
                      <TableHead>カメラON</TableHead>
                      <TableHead>発話</TableHead>
                      <TableHead>本人確認</TableHead>
                      <TableHead>イベント</TableHead>
                      <TableHead>最長離脱</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.participants.map((p) => (
                      <TableRow key={p.participantId}>
                        <TableCell className="font-bold text-slate-900">{p.name}</TableCell>
                        <TableCell className="text-sm text-slate-500">{p.externalId ?? "—"}</TableCell>
                        <TableCell className="tabular-nums text-sm">{minutes(p.presenceMs)}</TableCell>
                        <TableCell className="tabular-nums text-sm">{p.faceVisiblePct}%</TableCell>
                        <TableCell className="tabular-nums text-sm font-semibold">{p.screenFacingPct}%</TableCell>
                        <TableCell className="tabular-nums text-sm">{p.cameraOnPct}%</TableCell>
                        <TableCell className="tabular-nums text-sm">
                          {Math.round(p.speakingMs / 1000)}秒
                          <span className="ml-1 text-xs text-slate-400">/ {p.speakingTurns}回</span>
                        </TableCell>
                        <TableCell className="text-sm">
                          {IDENTITY_LABELS[p.identityStatus] ?? p.identityStatus}
                        </TableCell>
                        <TableCell className="tabular-nums text-sm">{p.eventCount}</TableCell>
                        <TableCell className="tabular-nums text-sm">
                          {Math.round(p.longestAwayMs / 1000)}秒
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </AppCard>

          <p className="px-1 text-xs leading-relaxed text-slate-500">
            本レポートはカメラ映像から観測できる事象の統計です。受講者の理解度・集中度・心理状態を示すものではなく、
            単独で受講可否を判定する目的には使用できません。
          </p>
        </>
      )}
    </>
  );
}

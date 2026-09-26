/**
 * Participants — the dense, sortable table view of the same state the Live
 * Meeting grid shows as cards.
 *
 * The grid is for scanning; this is for working through a list and exporting
 * it. Both read the identical endpoint, so the two can never disagree.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, RefreshCcw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppCard, CardHead, EmptyState, ErrorNotice, LoadingRows, StatusBadge } from "@/components/shell/primitives";
import { ParticipantDetail } from "@/components/meeting-monitoring/ParticipantDetail";
import {
  FilterBar,
  matchesFilter,
  searchParticipants,
  sortParticipants,
  type ParticipantFilter,
  type ParticipantSort,
} from "@/components/meeting-monitoring/FilterBar";
import { api, ApiClientError } from "@/lib/api";
import { useMeeting, useSessionPicker } from "@/lib/meeting/use-meeting";
import {
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TONES,
  HEAD_LABELS,
  IDENTITY_LABELS,
  IDENTITY_TONES,
  TIER_LABELS,
  ago,
} from "@/lib/meeting/signals";
import { formatClock } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

export function MeetingParticipantsScreen() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const sessionId = params.get("session");
  const selected = params.get("participant");

  const { sessions, error: sessionsError } = useSessionPicker(sessionId, (id) =>
    setParams({ session: id }, { replace: true }),
  );
  const { participants, loading, error, refresh, serverTime } = useMeeting({ sessionId, pollMs: 15_000 });

  /**
   * Manual roster pull.
   *
   * Zoom webhooks are at-least-once and can be missed entirely — if the Event
   * Subscription was misconfigured, every participant_joined for a meeting is
   * simply gone, and nothing in the roster will ever show them. This is the
   * catch-up path.
   *
   * It reads Zoom's *past* participants endpoint, the only roster API
   * available below a Business plan, so it is accurate once a meeting has
   * ended and may return nothing while one is still running. Zoom's own error
   * is surfaced verbatim rather than flattened into "同期に失敗しました",
   * because "scope missing" and "meeting not finished" need different fixes.
   */
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  async function syncRoster() {
    if (!sessionId) return;
    setSyncing(true);
    setSyncNote(null);
    try {
      const r = await api.zoomSyncParticipants(sessionId);
      setSyncNote(
        r.total === 0
          ? "Zoomから参加者を取得できませんでした。開催中の会議では終了後に取得できます。"
          : `Zoomから${r.total}名を取り込みました（受講者と照合 ${r.matched}名・未照合 ${r.unmatched}名）。`,
      );
      refresh();
    } catch (e) {
      setSyncNote(e instanceof ApiClientError ? e.message : "同期に失敗しました");
    } finally {
      setSyncing(false);
    }
  }

  const [filter, setFilter] = useState<ParticipantFilter>("all");
  const [sort, setSort] = useState<ParticipantSort>("risk");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c: Partial<Record<ParticipantFilter, number>> = { all: participants.length };
    for (const f of ["attention", "unverified", "camera-off", "looking-away"] as ParticipantFilter[]) {
      c[f] = participants.filter((p) => matchesFilter(p, f)).length;
    }
    return c;
  }, [participants]);

  const rows = useMemo(
    () => sortParticipants(searchParticipants(participants.filter((p) => matchesFilter(p, filter)), query), sort),
    [participants, filter, query, sort],
  );

  if (!sessions.length && sessionsError) return <ErrorNotice message={sessionsError} onRetry={refresh} />;

  return (
    <>
      <div className="monitor-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="participants-session">
            会議を選択
          </label>
          <select
            id="participants-session"
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={refresh}>
            <RefreshCcw className="size-3.5" />
            更新
          </Button>
          {sessionId && can("session:write") && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void syncRoster()}
              disabled={syncing}
              title="Zoomから参加者一覧を取り込みます（会議終了後に取得できます）"
            >
              <Users className="size-3.5" />
              {syncing ? "同期中…" : "Zoomから参加者を同期"}
            </Button>
          )}
          {sessionId && can("report:create") && (
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={api.meetingReportCsvUrl(sessionId)}>
                <Download className="size-3.5" />
                CSV出力
              </a>
            </Button>
          )}
        </div>
      </div>

      {syncNote && (
        <div role="status" className="rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-sm text-cyan-800">
          {syncNote}
          <button type="button" className="ml-3 font-bold underline" onClick={() => setSyncNote(null)}>
            閉じる
          </button>
        </div>
      )}

      {error && <ErrorNotice message={error} onRetry={refresh} />}

      <AppCard>
        <CardHead title="参加者一覧" description="観測された状態・本人確認・解析の鮮度" />
        <div className="space-y-4 px-5 pb-5">
          <FilterBar
            filter={filter}
            onFilter={setFilter}
            sort={sort}
            onSort={setSort}
            query={query}
            onQuery={setQuery}
            counts={counts}
          />
        </div>
        {loading && !participants.length ? (
          <LoadingRows rows={6} />
        ) : !rows.length ? (
          <EmptyState
            title="参加者がいません"
            description={
              participants.length
                ? "フィルターを変更してください。"
                : "Zoomの参加者は会議の開始時に自動で取り込まれます。取り込まれない場合は設定のZoom連携をご確認ください。"
            }
          />
        ) : (
          <div className="overflow-x-auto border-t border-slate-100">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>参加者</TableHead>
                  <TableHead>状態</TableHead>
                  <TableHead>本人確認</TableHead>
                  <TableHead>画面正対</TableHead>
                  <TableHead>頭部</TableHead>
                  <TableHead>カメラ/音声</TableHead>
                  <TableHead>監視</TableHead>
                  <TableHead>最終解析</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow
                    key={p.participantId}
                    className="cursor-pointer"
                    onClick={() => sessionId && setParams({ session: sessionId, participant: p.participantId })}
                  >
                    <TableCell>
                      <div className="font-bold text-slate-900">
                        {p.traineeName ?? p.displayName ?? "未照合の参加者"}
                      </div>
                      <div className="text-xs text-slate-500">
                        {p.externalId ?? "—"}
                        {p.department ? ` ・ ${p.department}` : ""}
                        {p.leftAt ? " ・ 退出済み" : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={ENGAGEMENT_TONES[p.currentState] ?? "neutral"}>
                        {ENGAGEMENT_LABELS[p.currentState] ?? p.currentState}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={IDENTITY_TONES[p.identityStatus] ?? "neutral"}>
                        {IDENTITY_LABELS[p.identityStatus] ?? p.identityStatus}
                      </StatusBadge>
                      {p.identityConfidence != null && (
                        <div className="mt-0.5 text-xs tabular-nums text-slate-400">
                          {(p.identityConfidence * 100).toFixed(1)}%
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-sm font-semibold text-slate-700">
                      {p.screenFacingProbability != null
                        ? `${(p.screenFacingProbability * 100).toFixed(0)}%`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {HEAD_LABELS[p.headState] ?? p.headState}
                      {p.headYaw != null && (
                        <div className="text-xs tabular-nums text-slate-400">
                          {p.headYaw.toFixed(0)}° / {(p.headPitch ?? 0).toFixed(0)}°
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {p.cameraOn ? "カメラON" : "カメラOFF"}
                      <div className="text-xs text-slate-400">
                        {p.speaking ? "発話中" : p.microphoneOn ? "ミュート解除" : "ミュート"}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {TIER_LABELS[p.analysisTier] ?? p.analysisTier}
                    </TableCell>
                    <TableCell className="text-sm text-slate-500">{ago(p.lastAnalyzedAt, serverTime)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </AppCard>

      <ParticipantDetail
        meetingId={sessionId ?? ""}
        participantId={selected}
        onClose={() => sessionId && setParams({ session: sessionId })}
        canViewEvidence={can("evidence:view")}
      />
    </>
  );
}

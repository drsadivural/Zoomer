/**
 * Live Meeting — the organizer's primary console (§19–§22).
 *
 * Layout answers §47 top-down: the meeting's status, then the KPI that says how
 * many people need a decision, then an attention strip naming them, and only
 * then the full grid. An organizer who reads nothing but the top 200px should
 * still know whether anything is wrong.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, PlayCircle, RefreshCcw, Sparkles, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppCard, CardHead, EmptyState, ErrorNotice, LoadingRows, StatusBadge } from "@/components/shell/primitives";
import { MeetingKPIs, MeetingStatusStrip } from "@/components/meeting-monitoring/MeetingKPIs";
import { ParticipantGrid } from "@/components/meeting-monitoring/ParticipantGrid";
import { ParticipantDetail } from "@/components/meeting-monitoring/ParticipantDetail";
import { EventFeed } from "@/components/meeting-monitoring/EventFeed";
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
import { ENGAGEMENT_LABELS, ENGAGEMENT_TONES, needsAttention } from "@/lib/meeting/signals";
import { formatClock } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

export function LiveMeetingScreen() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const sessionId = params.get("session");
  const selected = params.get("participant");

  const { sessions, error: sessionsError } = useSessionPicker(sessionId, (id) =>
    setParams({ session: id }, { replace: true }),
  );
  const { analysis, participants, events, loading, error, live, refresh, serverTime } = useMeeting({
    sessionId,
    withEvents: true,
    eventLimit: 25,
  });

  const [filter, setFilter] = useState<ParticipantFilter>("all");
  const [sort, setSort] = useState<ParticipantSort>("risk");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [simOpen, setSimOpen] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const counts = useMemo(() => {
    const c: Partial<Record<ParticipantFilter, number>> = {};
    for (const f of [
      "attention",
      "screen-facing",
      "looking-away",
      "face-missing",
      "camera-off",
      "multiple-faces",
      "unverified",
      "mismatch",
      "speaking",
    ] as ParticipantFilter[]) {
      c[f] = participants.filter((p) => matchesFilter(p, f)).length;
    }
    c.all = participants.length;
    return c;
  }, [participants]);

  const visible = useMemo(
    () => sortParticipants(searchParticipants(participants.filter((p) => matchesFilter(p, filter)), query), sort),
    [participants, filter, query, sort],
  );

  const attention = useMemo(
    () =>
      sortParticipants(
        participants.filter((p) => !p.leftAt && (needsAttention(p.currentState) || p.identityStatus === "MISMATCH")),
        "risk",
      ).slice(0, 8),
    [participants],
  );

  const running = analysis?.analysis?.status === "RUNNING" || analysis?.analysis?.status === "DEGRADED";

  async function toggleAnalysis(start: boolean, adapter?: "MOCK" | "MEETING_SDK") {
    if (!sessionId) return;
    setBusy(true);
    try {
      if (start) {
        const r = await api.startAnalysis(sessionId, adapter ? { adapter, participantCount: 12 } : {});
        setNotice(r.alreadyRunning ? "解析は既に実行中です" : "解析を開始しました");
      } else {
        await api.stopAnalysis(sessionId);
        setNotice("解析を停止しました");
      }
      refresh();
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "操作に失敗しました");
    } finally {
      setBusy(false);
      setSimOpen(false);
    }
  }

  async function simulate() {
    if (!sessionId) return;
    setBusy(true);
    try {
      const r = await api.simulateMeeting(sessionId, { ticks: 6, stepSec: 8, participantCount: 12 });
      setNotice(`シミュレーション: ${r.participants}名 / ${r.observations}件の観測を生成しました`);
      refresh();
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "シミュレーションに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function viewEvidence(id: string) {
    try {
      const { url } = await api.evidenceUrl(id);
      setEvidenceUrl(url);
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "証跡を取得できません");
    }
  }

  if (!sessions.length && sessionsError) return <ErrorNotice message={sessionsError} onRetry={refresh} />;

  return (
    <>
      <div className="monitor-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="meeting-select">
            会議を選択
          </label>
          <select
            id="meeting-select"
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
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${
              live ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
            }`}
            title={live ? "リアルタイム接続中" : "ポーリングで更新中"}
          >
            <span className={`size-2 rounded-full ${live ? "animate-pulse bg-emerald-500" : "bg-slate-400"}`} />
            {live ? "リアルタイム" : "定期更新"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={refresh}>
            <RefreshCcw className="size-3.5" />
            更新
          </Button>
          {can("monitoring:write") &&
            (running ? (
              <>
                {analysis?.analysis?.adapter === "MOCK" && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={simulate} disabled={busy}>
                    <Sparkles className="size-3.5" />
                    データを生成
                  </Button>
                )}
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => toggleAnalysis(false)} disabled={busy}>
                  <StopCircle className="size-3.5" />
                  解析を停止
                </Button>
              </>
            ) : (
              <Button size="sm" className="gap-1.5" onClick={() => setSimOpen(true)} disabled={busy || !sessionId}>
                <PlayCircle className="size-3.5" />
                解析を開始
              </Button>
            ))}
        </div>
      </div>

      {notice && (
        <div role="status" className="rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-sm text-cyan-800">
          {notice}
        </div>
      )}
      {error && <ErrorNotice message={error} onRetry={refresh} />}

      {!sessionId ? (
        <AppCard>
          <EmptyState title="会議を選択してください" description="監視する会議を上のリストから選びます。" />
        </AppCard>
      ) : !analysis ? (
        <AppCard>{loading ? <LoadingRows rows={5} /> : <EmptyState title="データがありません" />}</AppCard>
      ) : (
        <>
          <MeetingStatusStrip data={analysis} now={serverTime} />
          <MeetingKPIs kpis={analysis.kpis} />

          {attention.length > 0 && (
            <AppCard className="border-rose-200 bg-rose-50/40">
              <CardHead
                title={`対応が必要な参加者 ${attention.length}名`}
                description="本人不一致・複数人検出・顔が映っていない（離席）・閉眼（居眠りの疑い）・カメラオフを優先表示しています"
              />
              <div className="flex flex-wrap gap-2 px-5 pb-4">
                {attention.map((p) => (
                  <button
                    key={p.participantId}
                    type="button"
                    onClick={() => setParams({ session: sessionId, participant: p.participantId })}
                    className="flex items-center gap-2 rounded-xl border border-rose-200 bg-white px-3 py-2 text-left text-sm shadow-sm transition hover:shadow"
                  >
                    <AlertTriangle className="size-4 shrink-0 text-rose-500" />
                    <span className="font-bold text-slate-900">
                      {p.traineeName ?? p.displayName ?? "未照合"}
                    </span>
                    <StatusBadge tone={ENGAGEMENT_TONES[p.currentState] ?? "neutral"}>
                      {ENGAGEMENT_LABELS[p.currentState] ?? p.currentState}
                    </StatusBadge>
                  </button>
                ))}
              </div>
            </AppCard>
          )}

          <AppCard>
            <CardHead
              title="参加者"
              description="各カードはZoomの映像ではなく、解析結果と最新サムネイルを表示します"
              action={<span className="text-xs font-semibold text-slate-400">{visible.length}名を表示</span>}
            />
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
              {loading && !participants.length ? (
                <LoadingRows rows={4} />
              ) : (
                <ParticipantGrid
                  participants={visible}
                  onOpen={(id) => setParams({ session: sessionId, participant: id })}
                  canViewEvidence={can("evidence:view")}
                  emptyDescription={
                    running
                      ? "フィルターを変更するか、解析結果が届くまでお待ちください。"
                      : "「解析を開始」を押すと監視が始まります。"
                  }
                />
              )}
            </div>
          </AppCard>

          <AppCard>
            <CardHead title="最近のイベント" description="検知から解消までを1件として記録します" />
            <EventFeed
              events={events}
              now={serverTime}
              onSelectParticipant={(id) => setParams({ session: sessionId, participant: id })}
              onViewEvidence={viewEvidence}
              canViewEvidence={can("evidence:view")}
            />
          </AppCard>
        </>
      )}

      <ParticipantDetail
        meetingId={sessionId ?? ""}
        participantId={selected}
        onClose={() => sessionId && setParams({ session: sessionId })}
        canViewEvidence={can("evidence:view")}
      />

      <Dialog open={simOpen} onOpenChange={setSimOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>解析を開始</DialogTitle>
            <DialogDescription>
              Zoom連携で実際の参加者を解析するか、開発用のシミュレーションで画面を確認できます。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              <strong className="text-slate-900">Zoom（Meeting SDK）</strong>
              ：Meeting SDKボットが会議に参加し、参加者ごとの映像を解析します。SDKキーと
              raw dataアクセスが必要です。
            </p>
            <p>
              <strong className="text-slate-900">シミュレーション</strong>
              ：合成データで全機能を検証します。実際の会議データには影響しません。
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => toggleAnalysis(true, "MOCK")} disabled={busy}>
              シミュレーションで開始
            </Button>
            <Button onClick={() => toggleAnalysis(true, "MEETING_SDK")} disabled={busy}>
              Zoomで開始
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(evidenceUrl)} onOpenChange={(v) => !v && setEvidenceUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>証跡スナップショット</DialogTitle>
            <DialogDescription>署名URLは60秒で失効し、閲覧は監査ログに記録されます。</DialogDescription>
          </DialogHeader>
          {evidenceUrl && <img src={evidenceUrl} alt="検知時のスナップショット" className="w-full rounded-xl border" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEvidenceUrl(null)}>
              閉じる
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

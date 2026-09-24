/**
 * Events — the realtime engagement event feed with category filters (§25).
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppCard, CardHead, ErrorNotice, LoadingRows } from "@/components/shell/primitives";
import { EVENT_CATEGORIES, EventFeed } from "@/components/meeting-monitoring/EventFeed";
import { ParticipantDetail } from "@/components/meeting-monitoring/ParticipantDetail";
import { api, ApiClientError, type EngagementEvent } from "@/lib/api";
import { useSessionPicker } from "@/lib/meeting/use-meeting";
import { formatClock } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

type StateFilter = "all" | "OPEN" | "RESOLVED";

export function MeetingEventsScreen() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const sessionId = params.get("session");
  const selected = params.get("participant");

  const { sessions, error: sessionsError } = useSessionPicker(sessionId, (id) =>
    setParams({ session: id }, { replace: true }),
  );

  const [category, setCategory] = useState("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [events, setEvents] = useState<EngagementEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverTime, setServerTime] = useState(() => Date.now());
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);

  const types = useMemo(
    () => EVENT_CATEGORIES.find((c) => c.id === category)?.types ?? [],
    [category],
  );

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      setLoading(true);
      api
        .meetingEvents(sessionId, {
          limit: 300,
          type: types.length ? types.join(",") : undefined,
          state: stateFilter === "all" ? undefined : stateFilter,
        })
        .then((r) => {
          if (cancelled) return;
          setEvents(r.events);
          setServerTime(r.serverTime);
          setError(null);
        })
        .catch((e) => !cancelled && setError(e instanceof ApiClientError ? e.message : "イベントを取得できません"))
        .finally(() => !cancelled && setLoading(false));
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessionId, types, stateFilter]);

  async function viewEvidence(id: string) {
    try {
      const { url } = await api.evidenceUrl(id);
      setEvidenceUrl(url);
    } catch {
      setError("証跡を取得できません");
    }
  }

  if (!sessions.length && sessionsError) return <ErrorNotice message={sessionsError} />;

  return (
    <>
      <div className="monitor-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="events-session">
            会議を選択
          </label>
          <select
            id="events-session"
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

          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
            {EVENT_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                aria-pressed={category === c.id}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${
                  category === c.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
            {(
              [
                ["all", "すべて"],
                ["OPEN", "継続中"],
                ["RESOLVED", "解消済み"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setStateFilter(id)}
                aria-pressed={stateFilter === id}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${
                  stateFilter === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setStateFilter((s) => s)}>
          <RefreshCcw className="size-3.5" />
          更新
        </Button>
      </div>

      {error && <ErrorNotice message={error} />}

      <AppCard>
        <CardHead
          title="イベント"
          description="検知から解消までを1件として記録します（重複は集約されます）"
          action={<span className="text-xs font-semibold text-slate-400">{events.length}件</span>}
        />
        {loading && !events.length ? (
          <LoadingRows rows={6} />
        ) : (
          <EventFeed
            events={events}
            now={serverTime}
            onSelectParticipant={(id) => sessionId && setParams({ session: sessionId, participant: id })}
            onViewEvidence={viewEvidence}
            canViewEvidence={can("evidence:view")}
          />
        )}
      </AppCard>

      <ParticipantDetail
        meetingId={sessionId ?? ""}
        participantId={selected}
        onClose={() => sessionId && setParams({ session: sessionId })}
        canViewEvidence={can("evidence:view")}
      />

      <Dialog open={Boolean(evidenceUrl)} onOpenChange={(v) => !v && setEvidenceUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>証跡スナップショット</DialogTitle>
            <DialogDescription>署名URLは60秒で失効します。</DialogDescription>
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

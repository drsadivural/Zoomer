import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle, CheckCircle2, Eye, EyeOff, Filter, Link2, RefreshCcw, ShieldCheck, Users, Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiClientError, type Alert, type MonitorResponse, type Participant, type SessionSummary } from "@/lib/api";
import { AppCard, CardHead, EmptyState, ErrorNotice, LoadingRows, MetricTile, StatusBadge } from "@/components/shell/primitives";
import { LocalCameraMonitor } from "@/components/LocalCameraMonitor";
import { formatClock, formatTime, MATCH_METHOD_LABELS, percent, STATUS_LABELS, STATUS_TONES } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

type StatusFilter = "all" | "attention" | "normal" | "offline";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "attention", label: "要確認" },
  { id: "normal", label: "正常" },
  { id: "offline", label: "未接続" },
];

function matches(p: Participant, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return p.status === "ALERT" || p.status === "WARNING";
  if (filter === "normal") return p.status === "MONITORING" || p.status === "VERIFIED";
  return p.status === "PRECHECK_PENDING" || p.status === "DISCONNECTED";
}

export function MonitorScreen() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const sessionId = params.get("session");

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [data, setData] = useState<MonitorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [reviewTarget, setReviewTarget] = useState<Alert | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const cursorRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    api
      .listSessions()
      .then((r) => {
        setSessions(r.sessions);
        if (!sessionId) {
          const live = r.sessions.find((s) => s.status === "LIVE") ?? r.sessions[0];
          if (live) setParams({ session: live.id }, { replace: true });
        }
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "研修一覧を取得できません"));
  }, [sessionId, setParams]);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    api
      .monitor(sessionId)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "監視情報を取得できません"))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    refresh();
    // Poll as a safety net; the socket below is the fast path.
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [sessionId, refresh]);

  /* Realtime: reconnect with backoff and replay from the last cursor. */
  useEffect(() => {
    if (!sessionId) return;
    let closed = false;
    let attempt = 0;
    let timer: number | undefined;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${proto}//${window.location.host}/api/v1/sessions/${sessionId}/stream?since=${cursorRef.current}`,
      );
      socketRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data as string) as
            | { type: "sync"; cursor: number }
            | { type: "event"; event: { cursor: number } };
          if (payload.type === "sync") cursorRef.current = payload.cursor;
          if (payload.type === "event") {
            cursorRef.current = payload.event.cursor;
            // The socket signals *that* something changed; the authoritative
            // state still comes from /monitor.
            refresh();
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        attempt++;
        timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt));
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socketRef.current?.close();
    };
  }, [sessionId, refresh]);

  const filtered = useMemo(
    () => (data?.participants ?? []).filter((p) => matches(p, filter)),
    [data, filter],
  );
  const unmatched = useMemo(
    () => (data?.participants ?? []).filter((p) => !p.traineeId),
    [data],
  );

  async function viewEvidence(id: string) {
    try {
      const { url } = await api.evidenceUrl(id);
      setEvidenceUrl(url);
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "証跡を取得できません");
    }
  }

  async function review(action: "ACKNOWLEDGE" | "FALSE_POSITIVE" | "RESOLVE", reasonCode?: "GLASSES" | "LIGHTING" | "NETWORK" | "HEAD_POSE" | "OCCLUSION" | "OTHER") {
    if (!reviewTarget) return;
    try {
      await api.reviewAlert(reviewTarget.id, { action, reasonCode });
      setReviewTarget(null);
      refresh();
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "更新できません");
    }
  }

  async function syncZoom() {
    if (!sessionId) return;
    setSyncing(true);
    try {
      const r = await api.zoomSyncParticipants(sessionId);
      setNotice(`Zoom参加者を同期しました: 照合 ${r.matched}名 / 未照合 ${r.unmatched}名（全 ${r.total}名）`);
      refresh();
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "Zoom同期に失敗しました");
    } finally {
      setSyncing(false);
    }
  }

  if (!sessions.length && error) return <ErrorNotice message={error} onRetry={refresh} />;

  return (
    <>
      <div className="monitor-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <label className="field-label sr-only" htmlFor="session-select">研修を選択</label>
          <select
            id="session-select"
            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
            value={sessionId ?? ""}
            onChange={(e) => setParams({ session: e.target.value })}
          >
            <option value="">研修を選択</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}（{formatClock(s.startsAt)}）
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
            <Filter className="ml-1.5 size-3.5 text-slate-400" />
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${
                  filter === f.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={syncZoom} disabled={syncing || !sessionId}>
            <Link2 className="size-3.5" />
            {syncing ? "同期中…" : "Zoom参加者を同期"}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={refresh}>
            <RefreshCcw className="size-3.5" />
            更新
          </Button>
        </div>
      </div>

      {notice && (
        <div role="status" className="rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-sm text-cyan-800">
          {notice}
          <button type="button" className="ml-3 font-bold underline" onClick={() => setNotice(null)}>閉じる</button>
        </div>
      )}

      {!sessionId ? (
        <AppCard>
          <EmptyState title="研修を選択してください" description="監視する研修を上のリストから選びます。" />
        </AppCard>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile label="接続中" value={data?.metrics.connected ?? "—"} hint={`全 ${data?.metrics.total ?? 0}名`} color="blue" icon={<Users />} />
            <MetricTile label="正常受講" value={data?.metrics.normal ?? "—"} hint="継続認証中" color="emerald" icon={<CheckCircle2 />} />
            <MetricTile label="要確認" value={data?.metrics.needsReview ?? "—"} hint="離席・複数人・居眠り疑い" color="amber" icon={<AlertTriangle />} />
            <MetricTile label="本人確認率" value={percent(data?.metrics.verifiedRate, 0)} hint={`未接続 ${data?.metrics.notConnected ?? 0}名`} color="cyan" icon={<ShieldCheck />} />
          </div>

          {unmatched.length > 0 && (
            <AppCard className="border-amber-200 bg-amber-50/40">
              <CardHead
                title={`未照合のZoom参加者が ${unmatched.length}名います`}
                description="Zoomの表示名・メールから受講者を特定できませんでした。手動で割り当ててください。"
              />
              <div className="divide-y divide-amber-100 border-t border-amber-100">
                {unmatched.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-slate-900">{p.zoomDisplayName ?? "（表示名なし）"}</div>
                      <div className="text-xs text-slate-500">
                        {p.zoomEmail ?? "メール未取得"} ・ Zoom参加 {formatTime(p.zoomJoinedAt)}
                      </div>
                    </div>
                    <BindControl sessionId={sessionId} participantId={p.id} onDone={refresh} />
                  </div>
                ))}
              </div>
            </AppCard>
          )}

          <AppCard>
            <CardHead
              title="受講者の状態"
              description="Zoom参加情報と本人確認・継続認証の結果"
              action={<span className="text-xs font-semibold text-slate-400">ルール版 {data?.session.ruleVersion ?? "—"}</span>}
            />
            {loading && !data ? (
              <LoadingRows rows={6} />
            ) : !filtered.length ? (
              <EmptyState title="該当する受講者がいません" description="フィルターを変更してください。" />
            ) : (
              <div className="overflow-x-auto border-t border-slate-100">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>受講者</TableHead>
                      <TableHead>状態</TableHead>
                      <TableHead>一致度</TableHead>
                      <TableHead>Zoom照合</TableHead>
                      <TableHead>最終確認</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="avatar-cell" aria-hidden="true">
                              {(p.name ?? p.zoomDisplayName ?? "?").slice(0, 2)}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-bold text-slate-900">
                                {p.name ?? p.zoomDisplayName ?? "未照合"}
                              </div>
                              <div className="truncate text-xs text-slate-500">
                                {p.externalId ?? "—"}
                                {p.hasEnrollment === 0 && (
                                  <span className="ml-1.5 font-semibold text-amber-600">顔未登録</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={STATUS_TONES[p.status] ?? "neutral"}>
                            {STATUS_LABELS[p.status] ?? p.status}
                          </StatusBadge>
                          {p.statusDetail && (
                            <div className="mt-1 text-xs text-slate-500">{p.statusDetail}</div>
                          )}
                        </TableCell>
                        <TableCell className="font-semibold text-slate-700">
                          {percent(p.lastMatchScore)}
                        </TableCell>
                        <TableCell>
                          {p.matchMethod ? (
                            <div className="text-xs">
                              <div className="font-semibold text-slate-700">
                                {MATCH_METHOD_LABELS[p.matchMethod] ?? p.matchMethod}
                              </div>
                              <div className="text-slate-400">
                                {p.zoomDisplayName ?? "—"}
                                {p.matchConfidence != null && ` (${percent(p.matchConfidence, 0)})`}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Zoom未検出</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-slate-500">
                          {formatTime(p.lastSeenAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </AppCard>

          <AppCard>
            <CardHead title="未対応アラート" description="確認済み・誤検知への変更は監査ログへ記録されます" />
            {!data?.alerts.length ? (
              <EmptyState title="未対応のアラートはありません" />
            ) : (
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {data.alerts.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-slate-900">{a.traineeName ?? "未照合の参加者"}</span>
                        <StatusBadge tone={a.severity === "ALERT" ? "danger" : "warning"}>{a.type}</StatusBadge>
                        {a.occurrences > 1 && (
                          <span className="text-xs font-bold text-slate-400">×{a.occurrences}</span>
                        )}
                        <span className="text-xs text-slate-400">{formatTime(a.openedAt)}</span>
                      </div>
                      <p className="mt-1 text-sm text-slate-600">{a.detail ?? a.summary}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        モデル {a.modelVersion ?? "—"} / ルール {a.ruleVersion ?? "—"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {a.evidenceId && can("evidence:view") && (
                        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void viewEvidence(a.evidenceId!)}>
                          <Eye className="size-3.5" />
                          証跡
                        </Button>
                      )}
                      {can("alert:write") && (
                        <Button size="sm" variant="outline" onClick={() => setReviewTarget(a)}>
                          確認する
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </AppCard>
        </>
      )}

      <LocalCameraMonitor />

      <Dialog open={Boolean(reviewTarget)} onOpenChange={(v) => !v && setReviewTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>アラートを確認</DialogTitle>
            <DialogDescription>
              自動判定のみで受講不可とはしません。確認結果は監査ログに記録されます。
            </DialogDescription>
          </DialogHeader>
          {reviewTarget && (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <div className="font-bold text-slate-900">
                  {reviewTarget.traineeName ?? "未照合の参加者"} ・ {reviewTarget.type}
                </div>
                <div className="mt-1 text-slate-600">{reviewTarget.detail ?? reviewTarget.summary}</div>
              </div>
              <p className="field-label">誤検知の理由（誤検知として記録する場合）</p>
              <div className="flex flex-wrap gap-2">
                {([
                  ["GLASSES", "眼鏡"],
                  ["LIGHTING", "照明"],
                  ["NETWORK", "ネットワーク"],
                  ["HEAD_POSE", "顔の向き"],
                  ["OCCLUSION", "遮蔽"],
                  ["OTHER", "その他"],
                ] as const).map(([code, label]) => (
                  <Button
                    key={code}
                    variant="outline"
                    size="sm"
                    onClick={() => void review("FALSE_POSITIVE", code)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => void review("ACKNOWLEDGE")}>確認済みにする</Button>
            <Button onClick={() => void review("RESOLVE")}>対応完了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(evidenceUrl)} onOpenChange={(v) => !v && setEvidenceUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>証跡画像</DialogTitle>
            <DialogDescription>
              署名URLは60秒で失効します。ダウンロード・閲覧は監査ログに記録されます。
            </DialogDescription>
          </DialogHeader>
          {evidenceUrl && (
            <img
              src={evidenceUrl}
              alt="検知時の証跡画像"
              className="w-full rounded-xl border border-slate-200"
            />
          )}
          <DialogFooter>
            <Button variant="outline" className="gap-1.5" onClick={() => setEvidenceUrl(null)}>
              <EyeOff className="size-4" />
              閉じる
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Inline manual binding for a Zoom attendee we could not resolve. */
function BindControl({
  sessionId,
  participantId,
  onDone,
}: {
  sessionId: string;
  participantId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<{ id: string; name: string; externalId: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api
        .listTrainees(query)
        .then((r) => setOptions(r.trainees.map((t) => ({ id: t.id, name: t.name, externalId: t.externalId }))))
        .catch(() => setOptions([]));
    }, 250);
    return () => clearTimeout(t);
  }, [open, query]);

  async function bind(traineeId: string) {
    setBusy(true);
    try {
      await api.bindParticipant(sessionId, participantId, traineeId);
      setOpen(false);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Video className="size-3.5" />
        受講者を割当
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>受講者を手動で割り当て</DialogTitle>
            <DialogDescription>
              氏名・受講者ID・メールで検索して、このZoom参加者に対応する受講者を選択します。
            </DialogDescription>
          </DialogHeader>
          <input
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            placeholder="氏名または受講者ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                disabled={busy}
                onClick={() => void bind(o.id)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="font-semibold text-slate-800">{o.name}</span>
                <span className="text-xs text-slate-500">{o.externalId}</span>
              </button>
            ))}
            {!options.length && <p className="px-3 py-4 text-sm text-slate-500">該当する受講者がいません</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

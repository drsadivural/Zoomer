import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Copy, Link2, Plus, RefreshCcw, Users, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiClientError, type AssignResult, type Participant, type SessionSummary, type Trainee, type ZoomMeeting } from "@/lib/api";
import { AppCard, CardHead, EmptyState, ErrorNotice, LoadingRows, StatusBadge } from "@/components/shell/primitives";
import { formatClock, formatDateTime, fromLocalInput, MATCH_METHOD_LABELS, SESSION_STATUS_LABELS, STATUS_LABELS, STATUS_TONES, toLocalInput } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

export function SessionsScreen() {
  const can = useCan();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    api
      .listSessions()
      .then((r) => {
        setSessions(r.sessions);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "研修一覧を取得できません"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (error) return <ErrorNotice message={error} onRetry={load} />;

  return (
    <>
      <AppCard>
        <CardHead
          title="研修一覧"
          description="Zoomミーティングとの紐付け、受講者の割当、受講リンクの発行"
          action={
            <>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={load}>
                <RefreshCcw className="size-3.5" />
                更新
              </Button>
              {can("session:write") && (
                <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-3.5" />
                  研修を作成
                </Button>
              )}
            </>
          }
        />
        {loading ? (
          <LoadingRows rows={5} />
        ) : !sessions.length ? (
          <EmptyState
            title="研修がまだありません"
            description="研修を作成し、Zoomミーティングと受講者を割り当ててください。"
            action={
              can("session:write") ? (
                <Button className="mt-1 gap-1.5" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" />
                  研修を作成
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto border-t border-slate-100">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>研修</TableHead>
                  <TableHead>日時</TableHead>
                  <TableHead>状態</TableHead>
                  <TableHead>受講者</TableHead>
                  <TableHead>Zoom</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-bold text-slate-900">{s.title}</TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {formatDateTime(s.startsAt)}
                      <div className="text-xs text-slate-400">〜 {formatClock(s.endsAt)}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={s.status === "LIVE" ? "success" : s.status === "CANCELLED" ? "danger" : "neutral"}>
                        {SESSION_STATUS_LABELS[s.status] ?? s.status}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-sm">
                      <span className="font-semibold text-slate-800">{s.verifiedCount}</span>
                      <span className="text-slate-400"> / {s.participantCount}名</span>
                      {s.alertCount > 0 && (
                        <div className="text-xs font-semibold text-rose-600">要確認 {s.alertCount}件</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {s.zoomMeetingId ? `ID ${s.zoomMeetingId}` : "未連携"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setDetailId(s.id)}>
                          参加者
                        </Button>
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/monitor?session=${s.id}`}>監視</Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </AppCard>

      <CreateSessionDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} />
      <ParticipantsDialog sessionId={detailId} onClose={() => setDetailId(null)} onChanged={load} />
    </>
  );
}

function CreateSessionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const now = Date.now();
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState(toLocalInput(now + 3600_000));
  const [endsAt, setEndsAt] = useState(toLocalInput(now + 3 * 3600_000));
  const [zoomMeetingId, setZoomMeetingId] = useState("");
  const [meetings, setMeetings] = useState<ZoomMeeting[]>([]);
  const [zoomError, setZoomError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function createZoomMeeting() {
    setCreatingMeeting(true);
    setZoomError(null);
    setInviteUrl(null);
    try {
      const startMs = new Date(startsAt).getTime();
      const endMs = new Date(endsAt).getTime();
      const durationMin =
        startMs && endMs && endMs > startMs
          ? Math.min(1440, Math.max(5, Math.round((endMs - startMs) / 60000)))
          : 60;
      const r = await api.zoomCreateMeeting({
        topic: title.trim() || "研修",
        startTime: startMs ? new Date(startMs).toISOString() : undefined,
        durationMin,
      });
      setZoomMeetingId(r.meetingId);
      setInviteUrl(r.joinUrl);
    } catch (e) {
      setZoomError(e instanceof ApiClientError ? e.message : "Zoomミーティングを作成できません");
    } finally {
      setCreatingMeeting(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    api
      .zoomMeetings("upcoming")
      .then((r) => {
        setMeetings(r.meetings);
        setZoomError(null);
      })
      .catch((e) =>
        setZoomError(e instanceof ApiClientError ? e.message : "Zoomミーティングを取得できません"),
      );
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createSession({
        title,
        startsAt: fromLocalInput(startsAt),
        endsAt: fromLocalInput(endsAt),
        zoomMeetingId: zoomMeetingId || undefined,
      });
      onOpenChange(false);
      setTitle("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "作成に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>研修を作成</DialogTitle>
          <DialogDescription>
            Zoomミーティングを紐付けると、参加者の入退室が自動で受講者と照合されます。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {error && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="s-title">研修名</label>
            <Input id="s-title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="情報セキュリティ研修 2026年度" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="field-label" htmlFor="s-start">開始</label>
              <Input id="s-start" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="field-label" htmlFor="s-end">終了</label>
              <Input id="s-end" type="datetime-local" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="field-label" htmlFor="s-zoom">Zoomミーティング</label>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={creatingMeeting} onClick={() => void createZoomMeeting()}>
                <Video className="size-3.5" />
                {creatingMeeting ? "作成中…" : "Zoomミーティングを作成"}
              </Button>
            </div>
            {inviteUrl && (
              <div className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-2.5 text-xs">
                <div className="font-bold text-cyan-900">Zoom招待リンクを作成しました（ID {zoomMeetingId}）</div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-white px-2 py-1 text-slate-600">{inviteUrl}</code>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(inviteUrl).catch(() => undefined)}>コピー</Button>
                </div>
                <p className="mt-1 text-cyan-800">参加者は Zoom で参加し、発行される受講リンクを開くと本人確認・監視が始まります。</p>
              </div>
            )}
            {zoomError ? (
              <>
                <Input id="s-zoom" value={zoomMeetingId} onChange={(e) => setZoomMeetingId(e.target.value)} placeholder="ミーティングID（数字）" />
                <p className="text-xs text-amber-600">{zoomError}（IDを直接入力できます）</p>
              </>
            ) : (
              <select
                id="s-zoom"
                className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"
                value={zoomMeetingId}
                onChange={(e) => setZoomMeetingId(e.target.value)}
              >
                <option value="">紐付けない</option>
                {meetings.map((m) => (
                  <option key={String(m.id)} value={String(m.id)}>
                    {m.topic}（{m.start_time ? formatDateTime(Date.parse(m.start_time)) : "日時未定"}）
                  </option>
                ))}
              </select>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>キャンセル</Button>
            <Button type="submit" disabled={busy} className="gap-1.5">
              <CalendarDays className="size-4" />
              {busy ? "作成中…" : "作成"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ParticipantsDialog({
  sessionId,
  onClose,
  onChanged,
}: {
  sessionId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [trainees, setTrainees] = useState<Trainee[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [links, setLinks] = useState<AssignResult["links"]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    setLinks([]);
    Promise.all([api.listParticipants(sessionId), api.listTrainees()])
      .then(([p, t]) => {
        setParticipants(p.participants);
        setTrainees(t.trainees);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "取得できません"))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const assignedIds = new Set(participants.map((p) => p.traineeId));
  const available = trainees.filter((t) => !assignedIds.has(t.id));

  async function assign() {
    if (!sessionId || !selected.size) return;
    try {
      const r = await api.assignParticipants(sessionId, [...selected]);
      setLinks(r.links);
      setSelected(new Set());
      const p = await api.listParticipants(sessionId);
      setParticipants(p.participants);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "割当に失敗しました");
    }
  }

  async function copyLink(participantId: string) {
    if (!sessionId) return;
    const { joinUrl } = await api.joinLink(sessionId, participantId);
    await navigator.clipboard.writeText(joinUrl).catch(() => undefined);
  }

  return (
    <Dialog open={Boolean(sessionId)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>受講者の割当と受講リンク</DialogTitle>
          <DialogDescription>
            受講者ごとに固有の受講リンクを発行します。リンクは研修終了後に失効します。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        {loading ? (
          <LoadingRows rows={4} />
        ) : (
          <div className="space-y-5">
            <div>
              <p className="field-label mb-2">割当済み（{participants.length}名）</p>
              {!participants.length ? (
                <p className="text-sm text-slate-500">まだ割当がありません。</p>
              ) : (
                <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {participants.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold text-slate-900">
                          {p.name ?? p.zoomDisplayName ?? "未照合"}
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {p.externalId ?? "—"}
                          {p.matchMethod && ` ・ ${MATCH_METHOD_LABELS[p.matchMethod] ?? p.matchMethod}`}
                        </div>
                      </div>
                      <StatusBadge tone={STATUS_TONES[p.status] ?? "neutral"}>
                        {STATUS_LABELS[p.status] ?? p.status}
                      </StatusBadge>
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void copyLink(p.id)}>
                        <Copy className="size-3.5" />
                        リンク
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="field-label mb-2">受講者を追加</p>
              {!available.length ? (
                <p className="text-sm text-slate-500">追加できる受講者がいません。</p>
              ) : (
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
                  {available.map((t) => (
                    <label key={t.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          e.target.checked ? next.add(t.id) : next.delete(t.id);
                          setSelected(next);
                        }}
                      />
                      <span className="flex-1 text-sm font-semibold text-slate-800">{t.name}</span>
                      <span className="text-xs text-slate-500">{t.externalId}</span>
                      {t.enrollmentCount === 0 && (
                        <span className="text-xs font-semibold text-amber-600">顔未登録</span>
                      )}
                    </label>
                  ))}
                </div>
              )}
              <Button className="mt-2 gap-1.5" disabled={!selected.size} onClick={() => void assign()}>
                <Users className="size-4" />
                {selected.size ? `${selected.size}名を割当` : "受講者を選択"}
              </Button>
            </div>

            {links.length > 0 && (
              <div className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-3">
                <p className="text-sm font-bold text-cyan-900">
                  <Link2 className="mr-1 inline size-4" />
                  受講リンクを発行しました（{links.length}件）
                </p>
                <p className="mt-1 text-xs text-cyan-800">
                  各受講者へ個別に送付してください。リンクは本人専用です。
                </p>
                <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {links.map((l) => (
                    <div key={l.participantId} className="flex items-center gap-2 text-xs">
                      <code className="flex-1 truncate rounded bg-white px-2 py-1 text-slate-600">{l.joinUrl}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void navigator.clipboard.writeText(l.joinUrl).catch(() => undefined)}
                      >
                        コピー
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" className="gap-1.5" onClick={onClose}>
            <Video className="size-4" />
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

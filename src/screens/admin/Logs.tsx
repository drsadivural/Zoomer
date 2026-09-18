import { useEffect, useState } from "react";
import { Download, Eye, FileCheck2, Filter, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiClientError, type AuditLog, type MonitoringEvent, type SessionSummary } from "@/lib/api";
import { AppCard, CardHead, EmptyState, ErrorNotice, LoadingRows, StatusBadge, type Tone } from "@/components/shell/primitives";
import { duration, formatDateTime, percent } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

const SEVERITY_TONE: Record<string, Tone> = { ALERT: "danger", WARNING: "warning", INFO: "success" };

const EVENT_LABELS: Record<string, string> = {
  FACE_ABSENT: "離席", MULTIPLE_FACES: "複数人", EYES_CLOSED: "居眠り疑い",
  MATCH_OK: "継続認証OK", MATCH_FAIL: "照合不一致", CAMERA_BLOCKED: "カメラ遮蔽",
  CAMERA_STOPPED: "カメラ停止", TAB_HIDDEN: "画面離脱", NETWORK_LOST: "通信断",
  PRECHECK_PASS: "本人確認成功", PRECHECK_FAIL: "本人確認失敗", HEARTBEAT: "定期報告",
};

export function LogsScreen() {
  const can = useCan();
  const [tab, setTab] = useState<"events" | "audit">("events");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [type, setType] = useState("");
  const [severity, setSeverity] = useState("");
  const [events, setEvents] = useState<MonitoringEvent[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSessions()
      .then((r) => {
        setSessions(r.sessions);
        if (r.sessions[0]) setSessionId(r.sessions[0].id);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "研修一覧を取得できません"));
  }, []);

  useEffect(() => {
    if (tab !== "events" || !sessionId) return;
    setLoading(true);
    api
      .sessionEvents(sessionId, { type: type || undefined, severity: severity || undefined, limit: 300 })
      .then((r) => {
        setEvents(r.events);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "イベントを取得できません"))
      .finally(() => setLoading(false));
  }, [tab, sessionId, type, severity]);

  useEffect(() => {
    if (tab !== "audit") return;
    setLoading(true);
    api
      .auditLogs({ limit: "200" })
      .then((r) => {
        setLogs(r.logs);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "監査ログを取得できません"))
      .finally(() => setLoading(false));
  }, [tab]);

  async function viewEvidence(id: string) {
    try {
      const { url } = await api.evidenceUrl(id);
      setEvidenceUrl(url);
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "証跡を取得できません");
    }
  }

  async function exportCsv(kind: "EVENTS_CSV" | "ALERTS_CSV" | "ATTENDANCE_CSV") {
    try {
      const r = await api.createReport({ kind, sessionId: sessionId || undefined });
      setNotice(`レポートを生成しました（${r.report.rowCount}行）。ダウンロードを開始します。`);
      window.open(`/api/v1/reports/${r.report.id}/content`, "_blank", "noopener");
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "レポート生成に失敗しました");
    }
  }

  return (
    <>
      <div className="monitor-toolbar">
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => setTab("events")}
            aria-pressed={tab === "events"}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${tab === "events" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
          >
            <FileCheck2 className="size-3.5" />
            監視イベント
          </button>
          {can("audit:read") && (
            <button
              type="button"
              onClick={() => setTab("audit")}
              aria-pressed={tab === "audit"}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${tab === "audit" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
            >
              <ScrollText className="size-3.5" />
              監査ログ
            </button>
          )}
        </div>

        {tab === "events" && (
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="size-3.5 text-slate-400" />
            <select className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold" value={sessionId} onChange={(e) => setSessionId(e.target.value)} aria-label="研修">
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
            <select className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold" value={type} onChange={(e) => setType(e.target.value)} aria-label="イベント種別">
              <option value="">全種別</option>
              {Object.entries(EVENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs font-semibold" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="重要度">
              <option value="">全重要度</option>
              <option value="ALERT">異常</option>
              <option value="WARNING">警告</option>
              <option value="INFO">情報</option>
            </select>
            {can("report:create") && (
              <>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void exportCsv("EVENTS_CSV")}>
                  <Download className="size-3.5" />
                  イベントCSV
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void exportCsv("ATTENDANCE_CSV")}>
                  <Download className="size-3.5" />
                  受講状況CSV
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {notice && (
        <div role="status" className="rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-sm text-cyan-800">
          {notice}
          <button type="button" className="ml-3 font-bold underline" onClick={() => setNotice(null)}>閉じる</button>
        </div>
      )}

      {error && <ErrorNotice message={error} />}

      {tab === "events" ? (
        <AppCard>
          <CardHead title="監視イベント" description="判定時刻・照合スコア・モデル版・ルール版を保持しています" />
          {loading ? (
            <LoadingRows rows={6} />
          ) : !events.length ? (
            <EmptyState title="イベントがありません" description="条件を変更するか、研修の実施をお待ちください。" />
          ) : (
            <div className="overflow-x-auto border-t border-slate-100">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>発生時刻</TableHead>
                    <TableHead>受講者</TableHead>
                    <TableHead>種別</TableHead>
                    <TableHead>詳細</TableHead>
                    <TableHead>一致度</TableHead>
                    <TableHead>版</TableHead>
                    <TableHead className="text-right">証跡</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id} className={e.quarantined ? "opacity-60" : ""}>
                      <TableCell className="whitespace-nowrap text-xs text-slate-600">
                        {formatDateTime(e.capturedAt)}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="font-semibold text-slate-800">{e.traineeName ?? "未照合"}</div>
                        <div className="text-xs text-slate-400">{e.traineeExternalId ?? "—"}</div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={SEVERITY_TONE[e.severity] ?? "neutral"}>
                          {EVENT_LABELS[e.type] ?? e.type}
                        </StatusBadge>
                        {e.quarantined && (
                          <div className="mt-1 text-xs font-semibold text-slate-500">隔離</div>
                        )}
                        {e.serverAdjusted && (
                          <div className="mt-1 text-xs font-semibold text-cyan-600">サーバー再評価</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {e.durationMs != null && <div>継続 {duration(e.durationMs)}</div>}
                        {e.faceCount != null && <div>顔 {e.faceCount}件</div>}
                      </TableCell>
                      <TableCell className="text-sm font-semibold text-slate-700">
                        {percent(e.matchScore)}
                      </TableCell>
                      <TableCell className="text-xs text-slate-400">
                        <div>{e.modelVersion ?? "—"}</div>
                        <div>{e.ruleVersion ?? "—"}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        {e.evidenceId && can("evidence:view") ? (
                          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void viewEvidence(e.evidenceId!)}>
                            <Eye className="size-3.5" />
                            表示
                          </Button>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </AppCard>
      ) : (
        <AppCard>
          <CardHead title="監査ログ" description="閲覧・出力・削除・設定変更の記録（顔特徴量や画像URLは含みません）" />
          {loading ? (
            <LoadingRows rows={6} />
          ) : !logs.length ? (
            <EmptyState title="監査ログがありません" />
          ) : (
            <div className="overflow-x-auto border-t border-slate-100">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>時刻</TableHead>
                    <TableHead>操作</TableHead>
                    <TableHead>対象</TableHead>
                    <TableHead>実行者</TableHead>
                    <TableHead>結果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(l.createdAt)}</TableCell>
                      <TableCell className="text-sm font-semibold text-slate-800">{l.action}</TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {l.resourceType}
                        <div className="truncate">{l.resourceId ?? "—"}</div>
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">{l.actorType}</TableCell>
                      <TableCell>
                        <StatusBadge tone={l.result === "SUCCESS" ? "success" : l.result === "DENIED" ? "danger" : "warning"}>
                          {l.result}
                        </StatusBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </AppCard>
      )}

      <Dialog open={Boolean(evidenceUrl)} onOpenChange={(v) => !v && setEvidenceUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>証跡画像</DialogTitle>
            <DialogDescription>署名URLは60秒で失効し、閲覧は監査ログに記録されます。</DialogDescription>
          </DialogHeader>
          {evidenceUrl && <img src={evidenceUrl} alt="検知時の証跡画像" className="w-full rounded-xl border border-slate-200" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEvidenceUrl(null)}>閉じる</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

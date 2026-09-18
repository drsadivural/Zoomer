import { useEffect, useState } from "react";
import { Camera, Plus, Search, Trash2, Upload, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiClientError, type Enrollment, type ImportResult, type Trainee } from "@/lib/api";
import { AppCard, CardHead, EmptyState, ErrorNotice, LoadingRows, StatusBadge } from "@/components/shell/primitives";
import { FaceCapture, type CaptureResult } from "@/components/FaceCapture";
import { formatDateTime, percent } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

const CONSENT_POLICY_VERSION = "2026-09-01";
const CONSENT_SCOPE = ["face_template", "monitoring", "evidence_images"];

export function EnrollScreen() {
  const can = useCan();
  const [trainees, setTrainees] = useState<Trainee[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [faceTarget, setFaceTarget] = useState<Trainee | null>(null);

  function load() {
    setLoading(true);
    api
      .listTrainees(query || undefined)
      .then((r) => {
        setTrainees(r.trainees);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "受講者一覧を取得できません"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const t = setTimeout(load, query ? 300 : 0);
    return () => clearTimeout(t);
  }, [query]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;

  return (
    <>
      <AppCard>
        <CardHead
          title="受講者"
          description="顔登録が完了していない受講者は本人確認を開始できません"
          action={
            can("trainee:write") ? (
              <>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setImportOpen(true)}>
                  <Upload className="size-3.5" />
                  CSV取込
                </Button>
                <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-3.5" />
                  受講者を追加
                </Button>
              </>
            ) : undefined
          }
        />

        <div className="px-5 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="pl-9"
              placeholder="氏名・受講者ID・所属・メールで検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="受講者を検索"
            />
          </div>
        </div>

        {loading ? (
          <LoadingRows rows={6} />
        ) : !trainees.length ? (
          <EmptyState
            title={query ? "該当する受講者がいません" : "受講者がまだ登録されていません"}
            description={query ? "検索条件を変更してください。" : "個別追加またはCSV一括取込で登録します。"}
          />
        ) : (
          <div className="overflow-x-auto border-t border-slate-100">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>受講者</TableHead>
                  <TableHead>所属</TableHead>
                  <TableHead>顔登録</TableHead>
                  <TableHead>品質</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trainees.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="avatar-cell" aria-hidden="true">{t.name.slice(0, 2)}</div>
                        <div className="min-w-0">
                          <div className="truncate font-bold text-slate-900">{t.name}</div>
                          <div className="truncate text-xs text-slate-500">
                            {t.externalId}{t.email ? ` ・ ${t.email}` : ""}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">{t.department ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge tone={t.enrollmentCount > 0 ? "success" : "warning"}>
                        {t.enrollmentCount > 0 ? "登録済み" : "未登録"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-sm font-semibold text-slate-700">
                      {t.lastQuality != null ? percent(t.lastQuality, 0) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {can("enrollment:write") && (
                        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setFaceTarget(t)}>
                          <Camera className="size-3.5" />
                          顔登録
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </AppCard>

      <CreateTraineeDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onDone={load} />
      <FaceEnrollDialog trainee={faceTarget} onClose={() => setFaceTarget(null)} onDone={load} />
    </>
  );
}

function CreateTraineeDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const [form, setForm] = useState({ externalId: "", name: "", department: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTrainee({
        externalId: form.externalId,
        name: form.name,
        department: form.department || undefined,
        email: form.email || undefined,
      });
      onOpenChange(false);
      setForm({ externalId: "", name: "", department: "", email: "" });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "登録に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>受講者を追加</DialogTitle>
          <DialogDescription>
            メールアドレスを登録すると、Zoom参加者との自動照合の精度が上がります。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {error && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="field-label" htmlFor="t-id">受講者ID</label>
              <Input id="t-id" required value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} placeholder="AZ-0241" />
            </div>
            <div className="space-y-1.5">
              <label className="field-label" htmlFor="t-name">氏名</label>
              <Input id="t-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="佐藤 美咲" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="t-dept">所属</label>
            <Input id="t-dept" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="人事部" />
          </div>
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="t-email">メールアドレス</label>
            <Input id="t-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="misaki.sato@example.co.jp" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>キャンセル</Button>
            <Button type="submit" disabled={busy} className="gap-1.5">
              <UserPlus className="size-4" />
              {busy ? "登録中…" : "登録"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open, onOpenChange, onDone,
}: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importTrainees(csv));
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "取込に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>CSV一括取込</DialogTitle>
          <DialogDescription>
            1行目はヘッダーです。<code>external_id</code>（受講者ID）と <code>name</code>（氏名）が必須で、
            <code>department</code>・<code>email</code> は任意です。日本語ヘッダーにも対応します。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setCsv(await file.text());
            }}
            aria-label="CSVファイルを選択"
          />
          <textarea
            className="h-40 w-full rounded-xl border border-slate-200 p-3 font-mono text-xs"
            placeholder={"external_id,name,department,email\nAZ-0241,佐藤 美咲,人事部,misaki.sato@example.co.jp"}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            aria-label="CSV内容"
          />
        </div>

        {result && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm">
            <p className="font-bold text-emerald-900">
              {result.created}件を登録しました（全{result.total}行）
            </p>
            {result.skipped.length > 0 && (
              <div className="mt-2">
                <p className="font-semibold text-amber-700">スキップ {result.skipped.length}件</p>
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-xs text-amber-800">
                  {result.skipped.map((s) => (
                    <li key={`${s.row}-${s.externalId}`}>
                      {s.row}行目 {s.externalId || "(ID空)"}: {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>閉じる</Button>
          <Button disabled={!csv.trim() || busy} onClick={() => void submit()} className="gap-1.5">
            <Upload className="size-4" />
            {busy ? "取込中…" : "取込"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FaceEnrollDialog({
  trainee, onClose, onDone,
}: { trainee: Trainee | null; onClose: () => void; onDone: () => void }) {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!trainee) return;
    setConsent(false);
    setMessage(null);
    setError(null);
    setReasons([]);
    api
      .getTrainee(trainee.id)
      .then((r) => setEnrollments(r.enrollments))
      .catch(() => setEnrollments([]));
  }, [trainee]);

  async function handleCapture(result: CaptureResult) {
    if (!trainee) return;
    setBusy(true);
    setError(null);
    setReasons([]);
    try {
      const r = await api.enroll(trainee.id, {
        descriptor: result.descriptor,
        engine: result.engine,
        modelVersion: result.modelVersion,
        quality: result.quality,
        consent: { policyVersion: CONSENT_POLICY_VERSION, scope: CONSENT_SCOPE },
      });
      setMessage(`顔登録が完了しました（品質 ${percent(r.enrollment.qualityScore, 0)}）`);
      const detail = await api.getTrainee(trainee.id);
      setEnrollments(detail.enrollments);
      onDone();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
        const payload = err.payload as { error?: { reasons?: string[] } } | undefined;
        setReasons(payload?.error?.reasons ?? []);
      } else {
        setError("登録に失敗しました");
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeEnrollment(id: string) {
    if (!trainee) return;
    await api.deleteEnrollment(trainee.id, id).catch(() => undefined);
    const detail = await api.getTrainee(trainee.id);
    setEnrollments(detail.enrollments);
    onDone();
  }

  return (
    <Dialog open={Boolean(trainee)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>顔登録 — {trainee?.name}</DialogTitle>
          <DialogDescription>
            本人確認に使用する顔特徴量を登録します。特徴量は暗号化して保存し、原画像は保存しません。
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-start gap-2.5 rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span className="text-cyan-900">
            受講者本人から、カメラ利用・顔情報の処理・証跡画像の保存について同意を取得しました。
            （同意文面バージョン {CONSENT_POLICY_VERSION}）
          </span>
        </label>

        {message && (
          <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {message}
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <div className="font-semibold">{error}</div>
            {reasons.length > 0 && (
              <ul className="mt-1 list-inside list-disc">
                {reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}
          </div>
        )}

        {consent ? (
          <FaceCapture onCapture={handleCapture} captureLabel="撮影して登録" busy={busy} requireLiveness={false} />
        ) : (
          <div className="upload-zone">
            <Camera className="size-7 text-cyan-700" />
            <p className="text-sm font-bold text-slate-700">同意の確認が必要です</p>
            <p className="text-xs text-slate-500">
              上のチェックボックスにチェックを入れるとカメラを起動できます。
            </p>
          </div>
        )}

        {enrollments.length > 0 && (
          <div>
            <p className="field-label mb-2">登録済みの顔特徴量</p>
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {enrollments.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-800">
                      品質 {percent(e.qualityScore, 0)} ・ {e.status === "ACTIVE" ? "有効" : "無効"}
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatDateTime(e.createdAt)} ・ {e.engine}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="text-rose-600" onClick={() => void removeEnrollment(e.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>閉じる</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

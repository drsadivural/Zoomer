import { useEffect, useState } from "react";
import { Camera, CheckCircle2, FolderOpen, ImagePlus, Pencil, Plus, Search, Trash2, Upload, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiClientError, type Enrollment, type ImportResult, type Trainee } from "@/lib/api";
import { AppCard, CardHead, EmptyState, ErrorNotice, LoadingRows, StatusBadge } from "@/components/shell/primitives";
import { FaceCapture, type CaptureResult } from "@/components/FaceCapture";
import { PhotoEnroll } from "@/components/PhotoEnroll";
import { FacePicker, type FaceSelection } from "@/components/FacePicker";
import { PhotoBatchEnroll } from "@/components/PhotoBatchEnroll";
import { formatDateTime, percent } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

/**
 * Bumped when the consent text changes in substance, so that every stored
 * consent says which wording the person actually agreed to. 2026-09-26 added
 * the optional enrolment thumbnail, which is a stored face image and so a new
 * category rather than a rewording. See /legal/privacy (version 1.1).
 */
const CONSENT_POLICY_VERSION = "2026-09-26";
const CONSENT_SCOPE = [
  "face_template",
  "monitoring",
  "evidence_images",
  "enrollment_thumbnail",
];

export function EnrollScreen() {
  const can = useCan();
  const [trainees, setTrainees] = useState<Trainee[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Trainee | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Trainee | null>(null);
  /**
   * Whether face photos are stored at all.
   *
   * Null while unknown. The roster falls back to initials both when a trainee
   * has no photo and when the organization stores none, and those look
   * identical — an operator who has enrolled ten faces and sees ten sets of
   * initials has no way to tell that the setting is off. So the screen says
   * so, once, above the table.
   */
  const [thumbnailsEnabled, setThumbnailsEnabled] = useState<boolean | null>(null);
  const [enablingThumbnails, setEnablingThumbnails] = useState(false);

  useEffect(() => {
    api
      .getMeetingSettings()
      .then((r) => setThumbnailsEnabled(r.settings.enrollmentThumbnailsEnabled))
      // A reader without settings access simply does not get the notice.
      .catch(() => setThumbnailsEnabled(null));
  }, []);

  async function enableThumbnails() {
    setEnablingThumbnails(true);
    try {
      const r = await api.saveMeetingSettings({ enrollmentThumbnailsEnabled: true });
      setThumbnailsEnabled(r.settings.enrollmentThumbnailsEnabled);
      load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "設定を変更できません");
    } finally {
      setEnablingThumbnails(false);
    }
  }

  function load() {
    setLoading(true);
    api
      .listTrainees(query || undefined)
      .then((r) => {
        setTrainees(r.trainees);
        setError(null);
        // One batched request for the whole page, and only when there is
        // something stored to fetch — with thumbnails off nothing is asked
        // for and nothing is audited.
        const withImages = r.trainees.filter((t) => t.hasThumbnail).map((t) => t.id);
        if (!withImages.length) {
          setThumbnails({});
          return;
        }
        api
          .traineeThumbnails(withImages)
          .then((res) => setThumbnails(res.thumbnails))
          .catch(() => setThumbnails({}));
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
                {can("enrollment:write") && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setBatchOpen(true)}>
                    <FolderOpen className="size-3.5" />
                    フォルダ一括顔登録
                  </Button>
                )}
                <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-3.5" />
                  受講者を追加
                </Button>
              </>
            ) : undefined
          }
        />

        {thumbnailsEnabled === false && (
          <div className="mx-5 mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            <div className="font-semibold">顔写真サムネイルの保存が無効です</div>
            <p className="mt-1 text-xs">
              一覧には氏名の頭文字のみが表示されます。有効にすると、
              <strong>これ以降に登録した顔</strong>のサムネイルが表示されます。
              既存の登録には適用されません — 原画像を保存していないため、
              後からサムネイルだけを作成することはできず、登録し直しが必要です。
            </p>
            {can("settings:write") && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 gap-1.5"
                onClick={() => void enableThumbnails()}
                disabled={enablingThumbnails}
              >
                <ImagePlus className="size-3.5" />
                {enablingThumbnails ? "変更中…" : "サムネイル保存を有効にする"}
              </Button>
            )}
          </div>
        )}

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
                        {thumbnails[t.id] ? (
                          <img
                            src={thumbnails[t.id]}
                            alt=""
                            className="size-9 shrink-0 rounded-[11px] object-cover"
                          />
                        ) : (
                          // Initials cover three different situations and the
                          // operator asks about all of them, so say which.
                          <div
                            className="avatar-cell"
                            title={
                              t.enrollmentCount === 0
                                ? "顔が未登録です"
                                : thumbnailsEnabled === false
                                  ? "顔写真サムネイルの保存が無効です"
                                  : "この受講者の登録には顔写真が保存されていません。登録し直すと表示されます。"
                            }
                          >
                            {t.name.slice(0, 2)}
                          </div>
                        )}
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
                      <div className="flex items-center justify-end gap-1.5">
                        {can("trainee:write") && (
                          <>
                            <Button
                              size="sm"
                              className="gap-1.5"
                              onClick={() => setEditTarget(t)}
                              aria-label={`${t.name} を編集`}
                            >
                              <Pencil className="size-3.5" />
                              編集・顔登録
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-rose-600 hover:bg-rose-50"
                              onClick={() => setDeleteTarget(t)}
                              aria-label={`${t.name} を削除`}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
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
      <PhotoBatchEnroll
        open={batchOpen}
        onOpenChange={setBatchOpen}
        consentPolicyVersion={CONSENT_POLICY_VERSION}
        consentScope={CONSENT_SCOPE}
        onDone={load}
      />
      <EditTraineeDialog trainee={editTarget} onClose={() => setEditTarget(null)} onSaved={load} />
      <DeleteTraineeDialog trainee={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={load} />
    </>
  );
}

const EMPTY_TRAINEE_FORM = { externalId: "", name: "", department: "", email: "" };

function CreateTraineeDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const [form, setForm] = useState(EMPTY_TRAINEE_FORM);
  const [face, setFace] = useState<FaceSelection | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [enrolled, setEnrolled] = useState<EnrolledFace | null>(null);
  const [busy, setBusy] = useState(false);
  /** Resets the picker's own state when a new trainee is started. */
  const [pickerKey, setPickerKey] = useState(0);
  const [newMode, setNewMode] = useState<EnrollMode>("photo");

  function reset() {
    setForm(EMPTY_TRAINEE_FORM);
    setFace(null);
    setConsent(false);
    setError(null);
    setReasons([]);
    setEnrolled(null);
    setNewMode("photo");
    setPickerKey((k) => k + 1);
  }

  /**
   * Creates the trainee, then enrolls the face if one was chosen.
   *
   * The two steps are reported separately on purpose. The trainee is created
   * first and is not rolled back if enrollment is rejected — losing a correctly
   * entered record because a photo was blurry would be worse than the operator
   * retrying the photo, and the row is already in the list to retry from.
   */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setReasons([]);
    setEnrolled(null);
    try {
      const created = await api.createTrainee({
        externalId: form.externalId,
        name: form.name,
        department: form.department || undefined,
        email: form.email || undefined,
      });

      if (!face) {
        onOpenChange(false);
        reset();
        onCreated();
        return;
      }

      try {
        const r = await api.enroll(created.trainee.id, {
          descriptor: face.result.descriptor,
          thumbnail: face.result.preview,
          engine: face.result.engine,
          modelVersion: face.result.modelVersion,
          quality: face.result.quality,
          consent: { policyVersion: CONSENT_POLICY_VERSION, scope: CONSENT_SCOPE },
        });
        setEnrolled({
          preview: face.result.preview ?? null,
          name: form.name,
          externalId: form.externalId,
          quality: r.enrollment.qualityScore,
        });
        // Keep the dialog open so the operator sees whose face was registered,
        // but the list behind it is already correct.
        onCreated();
      } catch (err) {
        // The trainee exists; only the face failed. Say exactly that.
        onCreated();
        if (err instanceof ApiClientError) {
          setError(`受講者は登録しましたが、顔登録に失敗しました：${err.message}`);
          const payload = err.payload as { error?: { reasons?: string[] } } | undefined;
          setReasons(payload?.error?.reasons ?? []);
        } else {
          setError("受講者は登録しましたが、顔登録に失敗しました。");
        }
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "登録に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>受講者を追加</DialogTitle>
          <DialogDescription>
            メールアドレスを登録すると、Zoom参加者との自動照合の精度が上がります。
            顔写真を添えると、同じ操作で顔登録まで完了します。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
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
          {enrolled && <EnrolledConfirmation enrolled={enrolled} />}
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

          <div className="space-y-2 rounded-xl border border-slate-200 p-3">
            <div>
              <p className="field-label">顔写真（任意）</p>
              <p className="text-xs text-slate-500">
                いま登録しない場合は、あとから一覧の「顔登録」でも追加できます。
              </p>
            </div>
            <div className="flex gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="顔写真の取得方法">
              <ModeTab active={newMode === "photo"} onClick={() => { setNewMode("photo"); setFace(null); }}>
                <ImagePlus className="size-3.5" />
                画像から
              </ModeTab>
              <ModeTab active={newMode === "camera"} onClick={() => { setNewMode("camera"); setFace(null); }}>
                <Camera className="size-3.5" />
                カメラで撮影
              </ModeTab>
            </div>
            {newMode === "photo" ? (
              <FacePicker key={pickerKey} onChange={setFace} busy={busy} compact />
            ) : (
              <>
                <FaceCapture
                  key={`cam-${pickerKey}`}
                  requireLiveness={false}
                  captureLabel={face ? "撮り直す" : "この顔を使う"}
                  busy={busy}
                  onCapture={(result) =>
                    setFace({ result, warnings: [], fileName: "カメラ撮影" })
                  }
                />
                {face && (
                  <div className="flex items-center gap-3 rounded-xl border border-slate-200 p-2">
                    {face.result.preview && (
                      <img src={face.result.preview} alt="撮影した顔" className="size-16 rounded-xl object-cover" />
                    )}
                    <p className="text-sm font-semibold text-slate-700">この顔で登録します</p>
                  </div>
                )}
              </>
            )}
            {face && (
              <label className="flex items-start gap-2.5 rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span className="text-cyan-900">
                  受講者本人から、顔情報の処理と、顔写真サムネイルの保存（有効時）について
                  同意を取得しました。（同意文面バージョン {CONSENT_POLICY_VERSION}）
                </span>
              </label>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => { reset(); onOpenChange(false); }}>
              {enrolled ? "閉じる" : "キャンセル"}
            </Button>
            <Button type="submit" disabled={busy || (Boolean(face) && !consent) || Boolean(enrolled)} className="gap-1.5">
              <UserPlus className="size-4" />
              {busy ? "登録中…" : face ? "登録して顔登録" : "登録"}
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

/**
 * Face enrolment for one trainee: consent, capture or upload, and the list of
 * faces already registered.
 *
 * A panel rather than a dialog of its own. Enrolling a face is part of
 * maintaining a trainee record, not a separate errand, and having it behind
 * its own row button meant the roster carried two buttons that both opened
 * "that person" and neither of which was the whole of them.
 */
function FaceEnrollPanel({
  trainee, onDone,
}: { trainee: Trainee | null; onDone: () => void }) {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<EnrollMode>("camera");
  const [enrolled, setEnrolled] = useState<EnrolledFace | null>(null);
  const [enrollmentImages, setEnrollmentImages] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!trainee) return;
    setConsent(false);
    setMode("camera");
    setEnrolled(null);
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
    setEnrolled(null);
    try {
      const r = await api.enroll(trainee.id, {
        descriptor: result.descriptor,
        thumbnail: result.preview,
        engine: result.engine,
        modelVersion: result.modelVersion,
        quality: result.quality,
        consent: { policyVersion: CONSENT_POLICY_VERSION, scope: CONSENT_SCOPE },
      });
      setEnrolled({
        preview: result.preview ?? null,
        name: trainee.name,
        externalId: trainee.externalId,
        quality: r.enrollment.qualityScore,
      });
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

  /**
   * One image per enrollment, so the list shows *which* photo each template
   * came from. The roster endpoint returns the newest per trainee, which
   * would render every row of this list with the same face.
   *
   * Refetched whenever the set of enrollments changes — after an enrol or a
   * delete — and silently skipped when thumbnails are off or the reader lacks
   * evidence:view, in which case the list still shows quality and date.
   */
  useEffect(() => {
    const ids = enrollments.filter((e) => e.hasImage).map((e) => e.id);
    if (!ids.length) {
      setEnrollmentImages({});
      return;
    }
    let cancelled = false;
    api
      .enrollmentThumbnails(ids)
      .then((r) => !cancelled && setEnrollmentImages(r.thumbnails))
      .catch(() => !cancelled && setEnrollmentImages({}));
    return () => {
      cancelled = true;
    };
  }, [enrollments]);

  async function removeEnrollment(id: string) {
    if (!trainee) return;
    await api.deleteEnrollment(trainee.id, id).catch(() => undefined);
    const detail = await api.getTrainee(trainee.id);
    setEnrollments(detail.enrollments);
    onDone();
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
      本人確認に使用する顔特徴量を登録します。特徴量は暗号化して保存し、原画像は保存しません
      （顔写真サムネイルが有効な場合のみ、一覧表示用の小さな画像を暗号化して保存します）。
      </p>

      <label className="flex items-start gap-2.5 rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span className="text-cyan-900">
          受講者本人から、カメラ利用・顔情報の処理・証跡画像および顔写真サムネイルの保存（有効時）
          について同意を取得しました。（同意文面バージョン {CONSENT_POLICY_VERSION}）
        </span>
      </label>

      {enrolled && <EnrolledConfirmation enrolled={enrolled} />}
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
        <div className="space-y-3">
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="登録方法">
            {/* Switching source clears the previous result: a success card
                left standing above a fresh camera preview reads as if the
                shot you are about to take has already been registered. */}
            <ModeTab active={mode === "camera"} onClick={() => { setMode("camera"); setEnrolled(null); }}>
              <Camera className="size-3.5" />
              カメラで撮影
            </ModeTab>
            <ModeTab active={mode === "photo"} onClick={() => { setMode("photo"); setEnrolled(null); }}>
              <ImagePlus className="size-3.5" />
              画像から登録
            </ModeTab>
          </div>
          {mode === "camera" ? (
            <FaceCapture onCapture={handleCapture} captureLabel="撮影して登録" busy={busy} requireLiveness={false} />
          ) : (
            <PhotoEnroll onCapture={handleCapture} busy={busy} />
          )}
        </div>
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
          <p className="field-label mb-2">
            登録済みの顔（{enrollments.length}件）
          </p>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {enrollments.map((e, i) => (
              <li key={e.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                {enrollmentImages[e.id] ? (
                  <img
                    src={enrollmentImages[e.id]}
                    alt={`${trainee?.name ?? ""} の登録顔写真 ${enrollments.length - i}`}
                    className="size-12 shrink-0 rounded-[11px] object-cover ring-1 ring-slate-200"
                  />
                ) : (
                  // Two different reasons for no picture, and the operator
                  // needs to tell them apart: the photo was never stored
                  // (thumbnails off at enrolment time, the default), or it
                  // exists but could not be fetched.
                  <div
                    className="grid size-12 shrink-0 place-items-center rounded-[11px] bg-slate-100 text-[0.6rem] font-semibold text-slate-400 ring-1 ring-slate-200"
                    title={e.hasImage ? "写真を取得できませんでした" : "この登録では顔写真を保存していません"}
                  >
                    {e.hasImage ? "取得不可" : "写真なし"}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-800">
                    品質 {percent(e.qualityScore, 0)} ・ {e.status === "ACTIVE" ? "有効" : "無効"}
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {formatDateTime(e.createdAt)} ・ {e.engine}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-rose-600"
                  aria-label={`${formatDateTime(e.createdAt)} の登録を削除`}
                  onClick={() => void removeEnrollment(e.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

    </div>
  );
}

type EnrollMode = "camera" | "photo";

function ModeTab({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold transition ${
        active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

interface EnrolledFace {
  /** In-tab JPEG of the face just enrolled. Never uploaded: the product stores
   *  encrypted templates only, and says so at /legal/privacy. */
  preview: string | null;
  name: string;
  externalId: string;
  quality: number;
}

/**
 * What was just registered, and for whom.
 *
 * The point is to catch the mistake that matters: a template bound to the wrong
 * person. A quality percentage alone cannot show that — a face beside a name
 * can, at a glance.
 */
function EnrolledConfirmation({ enrolled }: { enrolled: EnrolledFace }) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3"
    >
      {enrolled.preview ? (
        <img
          src={enrolled.preview}
          alt={`${enrolled.name} の登録した顔`}
          className="size-16 shrink-0 rounded-xl object-cover shadow-sm"
        />
      ) : (
        <div className="avatar-cell size-16 shrink-0 rounded-xl text-base" aria-hidden="true">
          {enrolled.name.slice(0, 2)}
        </div>
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-bold text-emerald-900">
          <CheckCircle2 className="size-4 shrink-0" />
          顔登録が完了しました
        </div>
        <div className="truncate text-base font-bold text-slate-900">{enrolled.name}</div>
        <div className="truncate text-xs text-slate-600">
          {enrolled.externalId} ・ 品質 {percent(enrolled.quality, 0)}
        </div>
      </div>
    </div>
  );
}

/**
 * Edit a trainee's details.
 *
 * Deliberately does not touch face data: changing a name is a clerical
 * correction, and silently invalidating a biometric template because someone
 * fixed a typo in a department would be a surprising and expensive side
 * effect. Face enrolments are managed in their own dialog.
 */
function EditTraineeDialog({
  trainee, onClose, onSaved,
}: { trainee: Trainee | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(EMPTY_TRAINEE_FORM);
  const [status, setStatus] = useState("ACTIVE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "face">("details");
  const faceCount = trainee?.enrollmentCount ?? 0;

  useEffect(() => {
    if (!trainee) return;
    // Always reopen on 基本情報: the dialog is reused for every row, and
    // landing on someone else's face tab because that is where you were last
    // is how the wrong person gets a photo registered.
    setTab("details");
    setForm({
      externalId: trainee.externalId,
      name: trainee.name,
      department: trainee.department ?? "",
      email: trainee.email ?? "",
    });
    setStatus(trainee.status);
    setError(null);
  }, [trainee]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trainee) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateTrainee(trainee.id, {
        externalId: form.externalId.trim(),
        name: form.name.trim(),
        // Empty means "cleared", which is different from "unchanged"; the
        // form always sends the current contents of every field.
        department: form.department.trim() || undefined,
        email: form.email.trim() || undefined,
        status,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(trainee)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{trainee?.name}</DialogTitle>
          <DialogDescription>
            受講者情報の修正と顔登録。基本情報の変更は登録済みの顔特徴量に影響しません。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="編集の種類">
          <ModeTab active={tab === "details"} onClick={() => setTab("details")}>
            <UserPlus className="size-3.5" />
            基本情報
          </ModeTab>
          <ModeTab active={tab === "face"} onClick={() => setTab("face")}>
            <ImagePlus className="size-3.5" />
            顔写真{faceCount ? `（${faceCount}）` : ""}
          </ModeTab>
        </div>

        {tab === "face" ? (
          <FaceEnrollPanel trainee={trainee} onDone={onSaved} />
        ) : (
        <form className="space-y-3" onSubmit={submit}>
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="edit-external">受講者ID</label>
            <Input
              id="edit-external"
              required
              value={form.externalId}
              onChange={(e) => setForm({ ...form, externalId: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="edit-name">氏名</label>
            <Input
              id="edit-name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="edit-dept">所属</label>
            <Input
              id="edit-dept"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="edit-email">メール</label>
            <Input
              id="edit-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="edit-status">状態</label>
            <select
              id="edit-status"
              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="ACTIVE">有効</option>
              <option value="INACTIVE">無効</option>
            </select>
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>キャンセル</Button>
            <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </form>
        )}

        {tab === "face" && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>閉じる</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete a trainee.
 *
 * Typed confirmation rather than a plain OK: this revokes the person's
 * biometric template, which cannot be undone from the UI and cannot be
 * reconstructed — the original photograph was never stored. The dialog says
 * exactly that, and how many templates go with them, because "削除" on a row
 * of a table does not convey it.
 */
function DeleteTraineeDialog({
  trainee, onClose, onDeleted,
}: { trainee: Trainee | null; onClose: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfirm("");
    setError(null);
  }, [trainee]);

  async function remove() {
    if (!trainee) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTrainee(trainee.id);
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "削除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const armed = trainee != null && confirm.trim() === trainee.name;

  return (
    <Dialog open={Boolean(trainee)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>受講者を削除</DialogTitle>
          <DialogDescription>
            この操作は取り消せません。監査ログには削除の記録が残ります。
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
          <div className="font-bold">{trainee?.name}（{trainee?.externalId}）</div>
          <p className="mt-1">
            登録済みの顔特徴量 {trainee?.enrollmentCount ?? 0} 件も同時に失効します。
            原画像は保存していないため、復元はできません。
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="field-label" htmlFor="delete-confirm">
            確認のため氏名「{trainee?.name}」を入力してください
          </label>
          <Input
            id="delete-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
          />
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          <Button
            className="bg-rose-600 hover:bg-rose-700"
            disabled={!armed || busy}
            onClick={() => void remove()}
          >
            {busy ? "削除中…" : "削除する"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

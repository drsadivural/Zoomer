/**
 * Bulk face enrollment from a folder of photos.
 *
 * The operator points at a folder, we work out who each photo belongs to from
 * its path, and enroll them one by one. Two rules shape the whole design:
 *
 *   1. Nothing is enrolled until the operator has seen the plan. Binding a face
 *      template to the wrong person is the worst failure this product has, so
 *      the resolution is shown and confirmed before any upload happens.
 *   2. One bad photo must not stop the batch. Each file succeeds or fails on
 *      its own and the failures are reported with a reason.
 *
 * Analysis runs in the browser on the same models as camera enrollment, one
 * photo at a time — the descriptor pass is GPU-bound and running a folder of
 * them in parallel exhausts WebGL memory long before it finishes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, ImagePlus, Loader2, Play, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiClientError, type Trainee } from "@/lib/api";
import { analysePhotoFile, descriptorToArray, ENGINE_ID, MODEL_VERSION } from "@/lib/face/engine";
import {
  groupPhotosByKey, isEnrollableImage, matchPhotoToTrainee, MATCH_METHOD_LABELS,
  type PhotoMatchMethod,
} from "@/lib/face/photo-enroll";
import { percent } from "@/lib/format";

interface PhotoBatchEnrollProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  consentPolicyVersion: string;
  consentScope: string[];
  onDone: () => void;
}

/**
 * Loads the whole roster, page by page.
 *
 * Matching must see every trainee: the Enroll screen's own list is filtered by
 * whatever the operator typed in the search box, and the API caps a page at
 * 200. Matching against either would report real people as "該当者なし" and
 * quietly skip their photos.
 */
async function loadFullRoster(): Promise<Trainee[]> {
  const all: Trainee[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await api.listTrainees(undefined, offset);
    all.push(...page.trainees);
    if (all.length >= page.total || page.trainees.length === 0) break;
  }
  return all;
}

interface PickedFile {
  path: string;
  file: File;
}

type FileOutcome = "pending" | "running" | "enrolled" | "failed" | "skipped";

interface FileRow {
  path: string;
  file: File;
  outcome: FileOutcome;
  detail: string;
  quality?: number;
}

interface PlanGroup {
  key: string;
  traineeId: string | null;
  traineeName: string | null;
  method: PhotoMatchMethod;
  files: FileRow[];
}

/** A key that looks like an address becomes the new trainee's email too. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function PhotoBatchEnroll({
  open, onOpenChange, consentPolicyVersion, consentScope, onDone,
}: PhotoBatchEnrollProps) {
  const [trainees, setTrainees] = useState<Trainee[] | null>(null);
  const [groups, setGroups] = useState<PlanGroup[]>([]);
  const [consent, setConsent] = useState(false);
  const [autoCreate, setAutoCreate] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ignored, setIgnored] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setTrainees(null);
    loadFullRoster()
      .then((r) => active && setTrainees(r))
      .catch(() => {
        if (!active) return;
        setTrainees([]);
        setError("受講者名簿を取得できませんでした。閉じてやり直してください。");
      });
    return () => {
      active = false;
    };
  }, [open]);

  // `webkitdirectory` is not in the React DOM typings and is not a standard
  // attribute, so it is set imperatively on mount.
  const folderInputRef = useCallback((el: HTMLInputElement | null) => {
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
  }, []);

  const reset = useCallback(() => {
    setGroups([]);
    setFinished(false);
    setError(null);
    setIgnored(0);
  }, []);

  const plan = useCallback(
    (picked: PickedFile[], skippedCount: number) => {
      const roster = trainees ?? [];
      setIgnored(skippedCount);
      setFinished(false);
      setError(null);
      const grouped = groupPhotosByKey(picked);
      const next: PlanGroup[] = [];
      for (const [key, files] of grouped) {
        const match = matchPhotoToTrainee(key, roster);
        const trainee = roster.find((t) => t.id === match.traineeId) ?? null;
        next.push({
          key,
          traineeId: match.traineeId,
          traineeName: trainee?.name ?? null,
          method: match.method,
          files: files.map((f) => ({ path: f.path, file: f.file, outcome: "pending", detail: "" })),
        });
      }
      setGroups(next);
    },
    [trainees],
  );

  function onPick(list: FileList | null) {
    if (!list) return;
    const picked: PickedFile[] = [];
    let skipped = 0;
    for (const file of Array.from(list)) {
      if (!isEnrollableImage(file)) {
        skipped++;
        continue;
      }
      picked.push({ path: file.webkitRelativePath || file.name, file });
    }
    plan(picked, skipped);
  }

  const totals = useMemo(() => {
    const files = groups.flatMap((g) => g.files);
    return {
      files: files.length,
      people: groups.length,
      resolvable: groups.filter((g) => g.traineeId || (autoCreate && g.method === "unmatched")).length,
      unresolved: groups.filter((g) => !g.traineeId && !(autoCreate && g.method === "unmatched")).length,
      enrolled: files.filter((f) => f.outcome === "enrolled").length,
      failed: files.filter((f) => f.outcome === "failed").length,
      done: files.filter((f) => f.outcome !== "pending" && f.outcome !== "running").length,
    };
  }, [groups, autoCreate]);

  function updateFile(groupKey: string, path: string, patch: Partial<FileRow>) {
    setGroups((prev) =>
      prev.map((g) =>
        g.key !== groupKey
          ? g
          : { ...g, files: g.files.map((f) => (f.path === path ? { ...f, ...patch } : f)) },
      ),
    );
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      for (const group of groups) {
        let traineeId = group.traineeId;

        // A key with no roster entry becomes a new trainee only when the
        // operator asked for it; otherwise the whole group is left untouched.
        if (!traineeId && autoCreate && group.method === "unmatched") {
          try {
            const created = await api.createTrainee({
              externalId: group.key,
              name: group.key,
              email: looksLikeEmail(group.key) ? group.key : undefined,
            });
            traineeId = created.trainee.id;
            setGroups((prev) =>
              prev.map((g) => (g.key === group.key ? { ...g, traineeId, traineeName: group.key } : g)),
            );
          } catch (err) {
            const detail = err instanceof ApiClientError ? err.message : "受講者を作成できません";
            for (const f of group.files) updateFile(group.key, f.path, { outcome: "failed", detail });
            continue;
          }
        }

        if (!traineeId) {
          for (const f of group.files) {
            updateFile(group.key, f.path, {
              outcome: "skipped",
              detail: MATCH_METHOD_LABELS[group.method],
            });
          }
          continue;
        }

        for (const f of group.files) {
          updateFile(group.key, f.path, { outcome: "running", detail: "解析中…" });
          try {
            const analysis = await analysePhotoFile(f.file);
            if (!analysis.primary?.descriptor) {
              updateFile(group.key, f.path, {
                outcome: "failed",
                detail: analysis.faceCount === 0 ? "顔を検出できません" : "顔特徴量を抽出できません",
              });
              continue;
            }
            const res = await api.enroll(traineeId, {
              descriptor: descriptorToArray(analysis.primary.descriptor),
              engine: ENGINE_ID,
              modelVersion: MODEL_VERSION,
              quality: analysis.quality,
              consent: { policyVersion: consentPolicyVersion, scope: consentScope },
            });
            updateFile(group.key, f.path, {
              outcome: "enrolled",
              detail: "登録しました",
              quality: res.enrollment.qualityScore,
            });
          } catch (err) {
            let detail = "登録に失敗しました";
            if (err instanceof ApiClientError) {
              const payload = err.payload as { error?: { reasons?: string[] } } | undefined;
              const reasons = payload?.error?.reasons;
              detail = reasons?.length ? reasons.join(" / ") : err.message;
            }
            updateFile(group.key, f.path, { outcome: "failed", detail });
          }
        }
      }
      setFinished(true);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "一括登録を完了できませんでした");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (running) return; // never drop a batch mid-flight
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>フォルダから一括顔登録</DialogTitle>
          <DialogDescription>
            ファイル名またはフォルダ名で受講者を特定します。
            <code>AZ-0241.jpg</code>（受講者ID）、<code>佐藤 美咲.jpg</code>（氏名）、
            <code>misaki.sato@example.co.jp.jpg</code>（メール）、
            1人1フォルダ（<code>AZ-0241/front.jpg</code>）のいずれにも対応します。
          </DialogDescription>
        </DialogHeader>

        {trainees === null && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="size-4 animate-spin" />
            受講者名簿を読み込んでいます…
          </div>
        )}

        <div className={`flex flex-wrap gap-2 ${trainees === null ? "pointer-events-none opacity-50" : ""}`}>
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <label>
              <FolderOpen className="size-3.5" />
              フォルダを選択
              <input
                ref={folderInputRef}
                type="file"
                className="hidden"
                aria-label="フォルダを選択"
                onChange={(e) => onPick(e.target.files)}
              />
            </label>
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <label>
              <ImagePlus className="size-3.5" />
              画像を複数選択
              <input
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/bmp"
                className="hidden"
                aria-label="画像を複数選択"
                onChange={(e) => onPick(e.target.files)}
              />
            </label>
          </Button>
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        {groups.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="画像" value={`${totals.files}件`} />
              <Stat label="対象者" value={`${totals.people}名`} />
              <Stat label="紐付け済み" value={`${totals.resolvable}名`} tone="ok" />
              <Stat label="未特定" value={`${totals.unresolved}名`} tone={totals.unresolved ? "warn" : "ok"} />
            </div>

            {ignored > 0 && (
              <p className="text-xs text-slate-500">
                画像以外の{ignored}件のファイルは対象から除外しました。
              </p>
            )}

            <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-200">
              {groups.map((g) => (
                <div key={g.key} className="border-b border-slate-100 last:border-b-0">
                  <div className="flex items-center gap-2 bg-slate-50 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-bold text-slate-800">
                        {g.traineeName ?? g.key}
                      </div>
                      <div className="truncate text-xs text-slate-500">
                        {g.key} ・ {MATCH_METHOD_LABELS[g.method]} ・ {g.files.length}枚
                      </div>
                    </div>
                    {!g.traineeId && (
                      <span
                        className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
                          autoCreate && g.method === "unmatched"
                            ? "bg-cyan-100 text-cyan-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {autoCreate && g.method === "unmatched" ? "新規作成" : "登録しません"}
                      </span>
                    )}
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {g.files.map((f) => (
                      <li key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                        <OutcomeIcon outcome={f.outcome} />
                        <span className="min-w-0 flex-1 truncate text-slate-600">{f.path}</span>
                        <span className="shrink-0 text-slate-500">
                          {f.quality != null ? `品質 ${percent(f.quality, 0)}` : f.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={autoCreate}
                disabled={running}
                onChange={(e) => setAutoCreate(e.target.checked)}
              />
              <span className="text-slate-700">
                該当する受講者がいない場合は、ファイル名を受講者ID・氏名として新規作成する
              </span>
            </label>

            <label className="flex items-start gap-2.5 rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={consent}
                disabled={running}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span className="text-cyan-900">
                対象の受講者全員から、顔情報の処理について同意を取得しました。
                （同意文面バージョン {consentPolicyVersion}）
              </span>
            </label>

            {finished && (
              <div
                role="status"
                className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              >
                完了しました。登録 {totals.enrolled}件 ・ 失敗 {totals.failed}件 ・
                対象外 {totals.files - totals.enrolled - totals.failed}件
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={() => { reset(); onOpenChange(false); }}>
            閉じる
          </Button>
          <Button
            disabled={!groups.length || !consent || running || totals.resolvable === 0}
            onClick={() => void run()}
            className="gap-1.5"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? `登録中… ${totals.done}/${totals.files}` : "一括登録を開始"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className="rounded-xl border border-slate-200 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div
        className={`font-bold ${
          tone === "warn" ? "text-amber-700" : tone === "ok" ? "text-emerald-700" : "text-slate-800"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function OutcomeIcon({ outcome }: { outcome: FileOutcome }) {
  if (outcome === "enrolled") return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />;
  if (outcome === "failed") return <XCircle className="size-3.5 shrink-0 text-rose-600" />;
  if (outcome === "skipped") return <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />;
  if (outcome === "running") return <Loader2 className="size-3.5 shrink-0 animate-spin text-cyan-600" />;
  return <span className="size-3.5 shrink-0 rounded-full border border-slate-300" />;
}

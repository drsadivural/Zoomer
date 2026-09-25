/**
 * Enroll a face from an existing photo instead of the camera.
 *
 * The analysis is identical to `FaceCapture` — same models, same descriptor,
 * same quality gate — so a photo enrollment is directly comparable with a
 * captured one. The one thing it cannot have is liveness: a file proves nothing
 * about who was in front of a camera, and the UI says so rather than letting an
 * operator assume otherwise.
 *
 * When a photo contains several faces the operator picks one. That is not a
 * convenience: the quality gate rejects a multi-face frame precisely because it
 * does not say whose template is being created, and choosing is what resolves
 * the ambiguity. The chosen face is then re-analysed on its own crop, so every
 * number that follows is measured on the pixels actually being enrolled.
 */
import { useCallback, useRef, useState } from "react";
import { ImagePlus, Loader2, Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  analysePhotoFile, analyseSelectedFace, descriptorToArray, ENGINE_ID, faceThumbnail,
  MODEL_VERSION, type FaceObservation, type PhotoAnalysis,
} from "@/lib/face/engine";
import { isEnrollableImage } from "@/lib/face/photo-enroll";
import type { CaptureResult } from "@/components/FaceCapture";
import { percent } from "@/lib/format";

interface PhotoEnrollProps {
  onCapture: (result: CaptureResult) => void | Promise<void>;
  busy?: boolean;
}

/** One detected face the operator can choose. */
interface FaceChoice {
  index: number;
  face: FaceObservation;
  thumbnail: string;
}

interface Selection {
  /** The face the operator picked, ready to enroll. */
  result: CaptureResult;
  warnings: string[];
  faceCount: number;
}

/** Mirrors `assessQuality` in worker/lib/faces.ts so the operator is warned
 *  before the upload rather than after the rejection. */
function qualityWarnings(q: CaptureResult["quality"]): string[] {
  const out: string[] = [];
  if (q.faceCount === 0) out.push("顔が検出できません");
  if (q.faceCount > 1) out.push("切り抜いた範囲に複数の顔が含まれています");
  if (q.relativeSize < 0.05) out.push("顔が小さすぎます");
  if (Math.abs(q.yaw) > 0.35 || Math.abs(q.pitch) > 0.35) out.push("正面を向いた写真を使ってください");
  if (q.brightness < 0.25) out.push("暗すぎます");
  if (q.brightness > 0.9) out.push("明るすぎます");
  if (q.sharpness < 0.3) out.push("ぶれ・ぼけがあります");
  if (q.occlusion > 0.35) out.push("顔が遮蔽されています");
  return out;
}

export function PhotoEnroll({ onCapture, busy = false }: PhotoEnrollProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const analysisRef = useRef<PhotoAnalysis | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [choices, setChoices] = useState<FaceChoice[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    analysisRef.current = null;
    setChoices([]);
    setChosen(null);
    setSelection(null);
  };

  /** Re-analyses one face's own crop and makes it the pending enrollment. */
  const select = useCallback(async (index: number) => {
    const analysis = analysisRef.current;
    if (!analysis) return;
    const face = analysis.faces[index];
    if (!face) return;

    setChosen(index);
    setSelection(null);
    setError(null);
    setAnalysing(true);
    try {
      const cropped = await analyseSelectedFace(analysis.canvas, face.box);
      const primary = cropped.primary;
      if (!primary?.descriptor) {
        setError("この顔から特徴量を抽出できませんでした。別の顔または写真をお試しください。");
        return;
      }
      setSelection({
        faceCount: cropped.faceCount,
        warnings: qualityWarnings(cropped.quality),
        result: {
          descriptor: descriptorToArray(primary.descriptor),
          quality: cropped.quality,
          engine: ENGINE_ID,
          modelVersion: MODEL_VERSION,
          preview: cropped.preview,
          // A file carries no liveness evidence. Reported honestly as absent.
          liveness: { passed: false, blinks: 0, motionScore: 0 },
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "選択した顔を解析できませんでした。");
    } finally {
      setAnalysing(false);
    }
  }, []);

  const analyse = useCallback(
    async (file: File) => {
      setError(null);
      reset();
      setFileName(file.name);
      if (!isEnrollableImage(file)) {
        setError("JPEG・PNG・WebP の画像を選択してください。");
        return;
      }
      setAnalysing(true);
      try {
        const analysis = await analysePhotoFile(file);
        analysisRef.current = analysis;
        if (!analysis.faceCount) {
          setError("顔を検出できませんでした。顔がはっきり写った写真を使ってください。");
          return;
        }
        // Largest first: in a photo taken to enroll someone, that is almost
        // always the subject, so the common case needs no clicking.
        const ordered = [...analysis.faces]
          .map((face, index) => ({ face, index }))
          .sort((a, b) => b.face.box.width * b.face.box.height - a.face.box.width * a.face.box.height);
        setChoices(
          ordered.map(({ face, index }) => ({
            index,
            face,
            thumbnail: faceThumbnail(analysis.canvas, face.box),
          })),
        );
        await select(ordered[0].index);
      } catch (err) {
        setError(err instanceof Error ? err.message : "画像を解析できませんでした。");
      } finally {
        setAnalysing(false);
      }
    },
    [select],
  );

  const multiple = choices.length > 1;

  return (
    <div className="space-y-3">
      <div
        className={`upload-zone ${dragging ? "border-cyan-500 bg-cyan-50" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void analyse(file);
        }}
      >
        {analysing && !selection ? (
          <>
            <Loader2 className="size-7 animate-spin text-cyan-700" />
            <p className="text-sm font-bold text-slate-700">解析中…</p>
          </>
        ) : selection ? (
          <>
            <img
              src={selection.result.preview}
              alt="登録する顔"
              className="size-36 rounded-2xl object-cover shadow-sm"
            />
            <p className="max-w-full truncate text-sm font-bold text-slate-700">{fileName}</p>
            <p className="text-xs text-slate-500">
              鮮明度 {percent(selection.result.quality.sharpness, 0)} ・ 明るさ{" "}
              {percent(selection.result.quality.brightness, 0)}
            </p>
          </>
        ) : (
          <>
            <ImagePlus className="size-7 text-cyan-700" />
            <p className="text-sm font-bold text-slate-700">画像をドラッグ＆ドロップ</p>
            <p className="text-xs text-slate-500">または下のボタンでファイルを選択します（JPEG / PNG / WebP）</p>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/bmp"
        className="hidden"
        aria-label="顔写真を選択"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void analyse(file);
          // Allow re-selecting the same file after a failed attempt.
          e.target.value = "";
        }}
      />

      {multiple && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-amber-900">
            <Users className="size-4" />
            {choices.length}人の顔が検出されました。登録する人を選んでください
          </div>
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="登録する顔を選択"
          >
            {choices.map((c) => (
              <button
                key={c.index}
                type="button"
                role="radio"
                aria-checked={chosen === c.index}
                aria-label={`検出された顔 ${c.index + 1}`}
                disabled={analysing || busy}
                onClick={() => void select(c.index)}
                className={`overflow-hidden rounded-xl border-2 transition ${
                  chosen === c.index
                    ? "border-cyan-600 ring-2 ring-cyan-300"
                    : "border-transparent opacity-70 hover:opacity-100"
                }`}
              >
                <img src={c.thumbnail} alt="" className="size-16 object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {selection && selection.warnings.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <div className="font-semibold">この写真は品質基準を満たさない可能性があります</div>
          <ul className="mt-1 list-inside list-disc">
            {selection.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      <p className="text-xs text-slate-500">
        写真からの登録では生体検知（まばたき確認）を行いません。本人の写真であることは運用で担保してください。
      </p>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={analysing || busy} className="gap-1.5">
          <ImagePlus className="size-4" />
          画像を選択
        </Button>
        <Button
          disabled={!selection || analysing || busy}
          onClick={() => selection && void onCapture(selection.result)}
          className="gap-1.5"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {busy ? "登録中…" : "この顔で登録"}
        </Button>
      </div>
    </div>
  );
}

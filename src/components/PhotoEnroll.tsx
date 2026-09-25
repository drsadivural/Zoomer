/**
 * Enroll a face from an existing photo instead of the camera.
 *
 * The analysis is identical to `FaceCapture` — same models, same descriptor,
 * same quality gate — so a photo enrollment is directly comparable with a
 * captured one. The one thing it cannot have is liveness: a file proves nothing
 * about who was in front of a camera, and the UI says so rather than letting an
 * operator assume otherwise.
 */
import { useCallback, useRef, useState } from "react";
import { ImagePlus, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { analysePhotoFile, descriptorToArray, ENGINE_ID, MODEL_VERSION } from "@/lib/face/engine";
import { isEnrollableImage } from "@/lib/face/photo-enroll";
import type { CaptureResult } from "@/components/FaceCapture";
import { percent } from "@/lib/format";

interface PhotoEnrollProps {
  onCapture: (result: CaptureResult) => void | Promise<void>;
  busy?: boolean;
}

interface Preview {
  name: string;
  image: string;
  result: CaptureResult;
  /** Reasons the server's quality gate is expected to reject this photo. */
  warnings: string[];
}

/** Mirrors `assessQuality` in worker/lib/faces.ts so the operator is warned
 *  before the upload rather than after the rejection. */
function qualityWarnings(q: CaptureResult["quality"]): string[] {
  const out: string[] = [];
  if (q.faceCount === 0) out.push("顔が検出できません");
  if (q.faceCount > 1) out.push("複数の顔が写っています");
  if (q.relativeSize < 0.05) out.push("顔が小さすぎます。顔まわりを切り抜いてください");
  if (Math.abs(q.yaw) > 0.35 || Math.abs(q.pitch) > 0.35) out.push("正面を向いた写真を使ってください");
  if (q.brightness < 0.25) out.push("暗すぎます");
  if (q.brightness > 0.9) out.push("明るすぎます");
  if (q.sharpness < 0.3) out.push("ぶれ・ぼけがあります");
  if (q.occlusion > 0.35) out.push("顔が遮蔽されています");
  return out;
}

export function PhotoEnroll({ onCapture, busy = false }: PhotoEnrollProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [dragging, setDragging] = useState(false);

  const analyse = useCallback(async (file: File) => {
    setError(null);
    setPreview(null);
    if (!isEnrollableImage(file)) {
      setError("JPEG・PNG・WebP の画像を選択してください。");
      return;
    }
    setAnalysing(true);
    try {
      const analysis = await analysePhotoFile(file);
      if (!analysis.primary?.descriptor) {
        setError(
          analysis.faceCount === 0
            ? "顔を検出できませんでした。顔がはっきり写った写真を使ってください。"
            : "顔特徴量を抽出できませんでした。別の写真をお試しください。",
        );
        return;
      }
      setPreview({
        name: file.name,
        image: analysis.preview,
        warnings: qualityWarnings(analysis.quality),
        result: {
          descriptor: descriptorToArray(analysis.primary.descriptor),
          quality: analysis.quality,
          engine: ENGINE_ID,
          modelVersion: MODEL_VERSION,
          // A file carries no liveness evidence. Reported honestly as absent.
          liveness: { passed: false, blinks: 0, motionScore: 0 },
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "画像を解析できませんでした。");
    } finally {
      setAnalysing(false);
    }
  }, []);

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
        {analysing ? (
          <>
            <Loader2 className="size-7 animate-spin text-cyan-700" />
            <p className="text-sm font-bold text-slate-700">解析中…</p>
          </>
        ) : preview ? (
          <>
            <img
              src={preview.image}
              alt=""
              className="h-36 w-36 rounded-2xl object-cover shadow-sm"
            />
            <p className="max-w-full truncate text-sm font-bold text-slate-700">{preview.name}</p>
            <p className="text-xs text-slate-500">
              顔 {preview.result.quality.faceCount}件 ・ 鮮明度{" "}
              {percent(preview.result.quality.sharpness, 0)} ・ 明るさ{" "}
              {percent(preview.result.quality.brightness, 0)}
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

      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {preview && preview.warnings.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <div className="font-semibold">この写真は品質基準を満たさない可能性があります</div>
          <ul className="mt-1 list-inside list-disc">
            {preview.warnings.map((w) => <li key={w}>{w}</li>)}
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
          disabled={!preview || analysing || busy}
          onClick={() => preview && void onCapture(preview.result)}
          className="gap-1.5"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {busy ? "登録中…" : "この画像で登録"}
        </Button>
      </div>
    </div>
  );
}

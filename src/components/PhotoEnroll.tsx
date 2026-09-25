/**
 * Enroll a face from an existing photo instead of the camera.
 *
 * The analysis is identical to `FaceCapture` — same models, same descriptor,
 * same quality gate — so a photo enrollment is directly comparable with a
 * captured one. The one thing it cannot have is liveness: a file proves nothing
 * about who was in front of a camera, and the UI says so rather than letting an
 * operator assume otherwise.
 *
 * Choosing which face is `FacePicker`'s job, shared with 受講者を追加.
 */
import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FacePicker, type FaceSelection } from "@/components/FacePicker";
import type { CaptureResult } from "@/components/FaceCapture";

interface PhotoEnrollProps {
  onCapture: (result: CaptureResult) => void | Promise<void>;
  busy?: boolean;
}

export function PhotoEnroll({ onCapture, busy = false }: PhotoEnrollProps) {
  const [selection, setSelection] = useState<FaceSelection | null>(null);

  return (
    <div className="space-y-3">
      <FacePicker onChange={setSelection} busy={busy} />

      <p className="text-xs text-slate-500">
        写真からの登録では生体検知（まばたき確認）を行いません。本人の写真であることは運用で担保してください。
      </p>

      <Button
        disabled={!selection || busy}
        onClick={() => selection && void onCapture(selection.result)}
        className="gap-1.5"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        {busy ? "登録中…" : "この顔で登録"}
      </Button>
    </div>
  );
}

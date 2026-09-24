/**
 * Engagement event feed (§25).
 *
 * Open events are pinned above resolved ones: a condition that is still
 * happening matters more than one that already ended, regardless of timestamp.
 */
import type { EngagementEvent } from "@/lib/api";
import { StatusBadge, EmptyState } from "@/components/shell/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import { EVENT_LABELS, SEVERITY_TONES, durationLabel } from "@/lib/meeting/signals";

export const EVENT_CATEGORIES: { id: string; label: string; types: string[] }[] = [
  { id: "all", label: "すべて", types: [] },
  { id: "identity", label: "本人確認", types: ["IDENTITY_MISMATCH", "IDENTITY_VERIFIED"] },
  { id: "presence", label: "在席", types: ["FACE_MISSING", "FACE_RETURNED", "LONG_ABSENCE"] },
  { id: "screen", label: "画面正対", types: ["SCREEN_AWAY", "SCREEN_FACING_RETURNED"] },
  { id: "camera", label: "カメラ", types: ["CAMERA_OFF", "CAMERA_ON"] },
  { id: "multiple", label: "複数人", types: ["MULTIPLE_FACES"] },
  { id: "system", label: "システム", types: ["LOW_CONFIDENCE", "PARTICIPANT_JOINED", "PARTICIPANT_LEFT"] },
];

export interface EventFeedProps {
  events: EngagementEvent[];
  now: number;
  onSelectParticipant?: (participantId: string) => void;
  onViewEvidence?: (evidenceId: string) => void;
  canViewEvidence?: boolean;
}

export function EventFeed({
  events,
  now,
  onSelectParticipant,
  onViewEvidence,
  canViewEvidence = false,
}: EventFeedProps) {
  if (!events.length) {
    return <EmptyState title="イベントはありません" description="検知されたイベントがここに表示されます。" />;
  }

  const ordered = [...events].sort((a, b) => {
    if ((a.state === "OPEN") !== (b.state === "OPEN")) return a.state === "OPEN" ? -1 : 1;
    return b.startedAt - a.startedAt;
  });

  return (
    <div className="overflow-x-auto border-t border-slate-100">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>時刻</TableHead>
            <TableHead>参加者</TableHead>
            <TableHead>イベント</TableHead>
            <TableHead>継続</TableHead>
            <TableHead>信頼度</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>証跡</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((e) => {
            const name = e.traineeName ?? e.displayName ?? "未照合の参加者";
            const duration = e.durationMs ?? (e.state === "OPEN" ? now - e.startedAt : null);
            return (
              <TableRow key={e.id} className={e.state === "OPEN" ? "bg-amber-50/40" : undefined}>
                <TableCell className="whitespace-nowrap text-sm text-slate-600">
                  {formatTime(e.startedAt)}
                </TableCell>
                <TableCell>
                  {onSelectParticipant ? (
                    <button
                      type="button"
                      className="truncate font-semibold text-slate-800 underline-offset-2 hover:underline"
                      onClick={() => onSelectParticipant(e.participantId)}
                    >
                      {name}
                    </button>
                  ) : (
                    <span className="font-semibold text-slate-800">{name}</span>
                  )}
                  {e.externalId && <div className="text-xs text-slate-400">{e.externalId}</div>}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={SEVERITY_TONES[e.severity] ?? "neutral"}>
                    {EVENT_LABELS[e.type] ?? e.type}
                  </StatusBadge>
                  {e.detail && <div className="mt-1 max-w-sm text-xs text-slate-500">{e.detail}</div>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm tabular-nums text-slate-600">
                  {durationLabel(duration)}
                </TableCell>
                <TableCell className="text-sm tabular-nums text-slate-600">
                  {e.confidence != null ? `${(e.confidence * 100).toFixed(0)}%` : "—"}
                </TableCell>
                <TableCell>
                  <span
                    className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
                      e.state === "OPEN" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {e.state === "OPEN" ? "継続中" : "解消"}
                  </span>
                </TableCell>
                <TableCell>
                  {e.evidenceId && canViewEvidence && onViewEvidence ? (
                    <Button variant="outline" size="sm" onClick={() => onViewEvidence(e.evidenceId!)}>
                      表示
                    </Button>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Virtualised participant grid.
 *
 * At 200 participants the grid is the only part of the console with a real
 * performance budget, so it windows: it measures the container, works out the
 * column count from the CSS grid's own track size, and renders only the rows
 * that are visible plus an overscan band. Cards outside that band cost one
 * spacer div each.
 *
 * Combined with `ParticipantCard`'s memo comparator, a participant update
 * re-renders exactly one card.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MeetingParticipant } from "@/lib/api";
import { EmptyState } from "@/components/shell/primitives";
import { ParticipantCard } from "./ParticipantCard";

const CARD_MIN_WIDTH = 220;
const CARD_HEIGHT = 300;
const GAP = 16;
const OVERSCAN_ROWS = 2;

export interface ParticipantGridProps {
  participants: MeetingParticipant[];
  onOpen: (participantId: string) => void;
  canViewEvidence: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function ParticipantGrid({
  participants,
  onOpen,
  canViewEvidence,
  emptyTitle = "該当する参加者がいません",
  emptyDescription = "フィルターを変更するか、解析を開始してください。",
}: ParticipantGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);

  // Bucketed clock: relative timestamps stay fresh without re-rendering cards
  // on every animation frame.
  const [nowBucket, setNowBucket] = useState(() => Math.floor(Date.now() / 5000) * 5000);
  useEffect(() => {
    const t = setInterval(() => setNowBucket(Math.floor(Date.now() / 5000) * 5000), 5000);
    return () => clearInterval(t);
  }, []);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onScroll = () => {
      const element = containerRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      setScrollTop(Math.max(0, -rect.top));
      setViewportHeight(window.innerHeight);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const columns = Math.max(1, Math.floor((width + GAP) / (CARD_MIN_WIDTH + GAP)) || 1);
  const rows = Math.ceil(participants.length / columns);
  const rowHeight = CARD_HEIGHT + GAP;

  const { firstRow, lastRow } = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
    const visible = Math.ceil(viewportHeight / rowHeight) + OVERSCAN_ROWS * 2;
    return { firstRow: first, lastRow: Math.min(rows, first + visible) };
  }, [scrollTop, viewportHeight, rowHeight, rows]);

  if (!participants.length) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const visible = participants.slice(firstRow * columns, lastRow * columns);
  const topSpacer = firstRow * rowHeight;
  const bottomSpacer = Math.max(0, (rows - lastRow) * rowHeight);

  return (
    <div ref={containerRef}>
      {topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden="true" />}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        role="list"
        aria-label={`参加者 ${participants.length}名`}
      >
        {visible.map((p) => (
          <div key={p.participantId} role="listitem" style={{ minHeight: CARD_HEIGHT }}>
            <ParticipantCard
              participant={p}
              now={nowBucket}
              onOpen={onOpen}
              canViewEvidence={canViewEvidence}
            />
          </div>
        ))}
      </div>
      {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden="true" />}
    </div>
  );
}

/**
 * Shared data layer for the organizer console.
 *
 * One hook, used by Live Meeting, Participants, Events and Reports so those
 * pages cannot drift out of sync with each other.
 *
 * Realtime strategy matches the existing ライブ監視 screen: the WebSocket says
 * *that* something changed and the REST endpoints remain the source of truth.
 * Socket frames are coalesced — a 200-person meeting can emit dozens per second,
 * and refetching per frame would be worse than not having a socket at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiClientError,
  type EngagementEvent,
  type MeetingAnalysisResponse,
  type MeetingParticipant,
  type SessionSummary,
} from "@/lib/api";

/** Minimum gap between refetches triggered by socket activity. */
const COALESCE_MS = 1_200;

export interface UseMeetingOptions {
  sessionId: string | null;
  /** Poll interval as a safety net behind the socket. */
  pollMs?: number;
  withEvents?: boolean;
  eventLimit?: number;
}

export interface UseMeetingResult {
  analysis: MeetingAnalysisResponse | null;
  participants: MeetingParticipant[];
  events: EngagementEvent[];
  loading: boolean;
  error: string | null;
  /** True while the realtime socket is connected. */
  live: boolean;
  refresh: () => void;
  serverTime: number;
}

export function useMeeting({
  sessionId,
  pollMs = 10_000,
  withEvents = false,
  eventLimit = 100,
}: UseMeetingOptions): UseMeetingResult {
  const [analysis, setAnalysis] = useState<MeetingAnalysisResponse | null>(null);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [events, setEvents] = useState<EngagementEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [serverTime, setServerTime] = useState(() => Date.now());

  const cursorRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const lastFetchRef = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    lastFetchRef.current = Date.now();
    try {
      const [a, p] = await Promise.all([
        api.meetingAnalysis(sessionId),
        api.meetingParticipants(sessionId),
      ]);
      setAnalysis(a);
      setParticipants(p.participants);
      setServerTime(p.serverTime);
      if (withEvents) {
        const e = await api.meetingEvents(sessionId, { limit: eventLimit });
        setEvents(e.events);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "会議データを取得できません");
    } finally {
      setLoading(false);
    }
  }, [sessionId, withEvents, eventLimit]);

  /** Refetch, but never more often than COALESCE_MS. */
  const coalescedLoad = useCallback(() => {
    if (pendingRef.current != null) return;
    const wait = Math.max(0, COALESCE_MS - (Date.now() - lastFetchRef.current));
    pendingRef.current = window.setTimeout(() => {
      pendingRef.current = null;
      void load();
    }, wait);
  }, [load]);

  useEffect(() => {
    if (!sessionId) {
      setAnalysis(null);
      setParticipants([]);
      setEvents([]);
      return;
    }
    setLoading(true);
    void load();
    const t = setInterval(() => void load(), pollMs);
    return () => {
      clearInterval(t);
      if (pendingRef.current != null) {
        window.clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    };
  }, [sessionId, load, pollMs]);

  /* Realtime, with the same reconnect-with-backoff shape as ライブ監視. */
  useEffect(() => {
    if (!sessionId) return;
    let closed = false;
    let attempt = 0;
    let timer: number | undefined;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${proto}//${window.location.host}/api/v1/sessions/${sessionId}/stream?since=${cursorRef.current}`,
      );

      socket.onopen = () => {
        attempt = 0;
        setLive(true);
      };
      socket.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data as string) as
            | { type: "sync"; cursor: number }
            | { type: "event"; event: { cursor: number; type: string } };
          if (payload.type === "sync") cursorRef.current = payload.cursor;
          if (payload.type === "event") {
            cursorRef.current = payload.event.cursor;
            coalescedLoad();
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      socket.onclose = () => {
        setLive(false);
        if (closed) return;
        attempt++;
        timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt));
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [sessionId, coalescedLoad]);

  return {
    analysis,
    participants,
    events,
    loading,
    error,
    live,
    refresh: () => void load(),
    serverTime,
  };
}

/**
 * Session picker shared by every organizer page, defaulting to the live one.
 * Kept here so all four pages agree on which meeting "the current meeting" is.
 */
export function useSessionPicker(sessionId: string | null, onPick: (id: string) => void) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSessions()
      .then((r) => {
        setSessions(r.sessions);
        if (!sessionId) {
          const preferred = r.sessions.find((s) => s.status === "LIVE") ?? r.sessions[0];
          if (preferred) onPick(preferred.id);
        }
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "研修一覧を取得できません"));
    // `onPick` is a setter from the router; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const current = useMemo(() => sessions.find((s) => s.id === sessionId) ?? null, [sessions, sessionId]);
  return { sessions, current, error };
}

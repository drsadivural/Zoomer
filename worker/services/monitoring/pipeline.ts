/**
 * The write path: one observation in, persisted state + events out.
 *
 * Everything above this file is pure (state reducer, scheduler, event engine);
 * everything below it is D1 and R2. Keeping the seam here means the interesting
 * logic is testable without a database, and this module stays boring enough to
 * read in one sitting.
 *
 * Alerts and evidence deliberately reuse the ORIGINAL tables and helpers. An
 * organizer already has one alert inbox; adding a second one for the same
 * meeting would be a regression dressed as a feature.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  identityVerifications,
  participantAnalysisState,
  participantEngagementEvents,
  participantObservations,
  sessionParticipants,
} from "../../db/schema";
import { newId } from "../../lib/ids";
import { publishToSession } from "../../lib/realtime";
import type { Env } from "../../types";
import { classifyTier, nextDueAt } from "../analysis/scheduler";
import {
  emptyParticipantState,
  reduceParticipantState,
  type AnalysisObservation,
  type ParticipantState,
} from "../analysis/participant-state";
import { evaluateParticipant, type EventAction } from "../events/event-engine";
import type { OpenEvent } from "../events/deduplication";
import type { MeetingMonitoringConfig } from "./config";
import type { EngagementState, IdentityStatus } from "./signals";

type StateRow = typeof participantAnalysisState.$inferSelect;

/* ------------------------------------------------------------ row mapping */

export function rowToState(row: StateRow): ParticipantState {
  return {
    participantId: row.participantId,
    sessionId: row.sessionId,
    displayName: row.displayName,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
    cameraOn: row.cameraOn,
    microphoneOn: row.microphoneOn,
    speaking: row.speaking,
    speakingMs: row.speakingMs,
    speakingTurns: row.speakingTurns,
    lastSpokeAt: row.lastSpokeAt,
    faceDetected: row.faceDetected,
    faceCount: row.faceCount,
    faceBox: (row.faceBox as ParticipantState["faceBox"]) ?? null,
    identityStatus: row.identityStatus as IdentityStatus,
    identityConfidence: row.identityConfidence,
    identityTraineeId: row.identityTraineeId,
    identityVerifiedAt: row.identityVerifiedAt,
    identityExpiresAt: row.identityExpiresAt,
    headYaw: row.headYaw,
    headPitch: row.headPitch,
    headRoll: row.headRoll,
    headState: row.headState as ParticipantState["headState"],
    eyeClosed: row.eyeClosed,
    eyeOpenness: row.eyeOpenness,
    eyesClosedSince: row.eyesClosedSince,
    screenFacingProbability: row.screenFacingProbability,
    gazeHorizontal: row.gazeHorizontal,
    gazeVertical: row.gazeVertical,
    currentState: row.currentState as EngagementState,
    currentStateSince: row.currentStateSince,
    pendingState: (row.pendingState as EngagementState | null) ?? null,
    pendingStateSince: row.pendingStateSince,
    lastAnalyzedAt: row.lastAnalyzedAt,
    analysisConfidence: row.analysisConfidence,
    analysisTier: row.analysisTier as ParticipantState["analysisTier"],
    nextAnalysisAt: row.nextAnalysisAt,
  };
}

function stateToRow(
  state: ParticipantState,
  organizationId: string,
  analysisSessionId: string | null,
  now: number,
) {
  return {
    participantId: state.participantId,
    organizationId,
    sessionId: state.sessionId,
    analysisSessionId,
    displayName: state.displayName,
    joinedAt: state.joinedAt,
    leftAt: state.leftAt,
    cameraOn: state.cameraOn,
    microphoneOn: state.microphoneOn,
    speaking: state.speaking,
    speakingMs: state.speakingMs,
    speakingTurns: state.speakingTurns,
    lastSpokeAt: state.lastSpokeAt,
    faceDetected: state.faceDetected,
    faceCount: state.faceCount,
    faceBox: state.faceBox as Record<string, number> | null,
    identityStatus: state.identityStatus,
    identityConfidence: state.identityConfidence,
    identityTraineeId: state.identityTraineeId,
    identityVerifiedAt: state.identityVerifiedAt,
    identityExpiresAt: state.identityExpiresAt,
    headYaw: state.headYaw,
    headPitch: state.headPitch,
    headRoll: state.headRoll,
    headState: state.headState,
    eyeClosed: state.eyeClosed,
    eyeOpenness: state.eyeOpenness,
    eyesClosedSince: state.eyesClosedSince,
    screenFacingProbability: state.screenFacingProbability,
    gazeHorizontal: state.gazeHorizontal,
    gazeVertical: state.gazeVertical,
    currentState: state.currentState,
    currentStateSince: state.currentStateSince,
    pendingState: state.pendingState,
    pendingStateSince: state.pendingStateSince,
    lastAnalyzedAt: state.lastAnalyzedAt,
    analysisConfidence: state.analysisConfidence,
    analysisTier: state.analysisTier,
    nextAnalysisAt: state.nextAnalysisAt,
    updatedAt: now,
  };
}

/* -------------------------------------------------------------- loading */

/**
 * Loads a participant's analysis state, creating it on first sight.
 *
 * The row is a 1:1 extension of `session_participants`, so the participant must
 * already exist there — which is what keeps tenancy and the Zoom↔trainee
 * binding in exactly one place.
 */
export async function loadOrCreateState(
  env: Env,
  organizationId: string,
  sessionId: string,
  participantId: string,
  now: number,
  displayName?: string | null,
): Promise<ParticipantState> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(participantAnalysisState)
    .where(
      and(
        eq(participantAnalysisState.participantId, participantId),
        eq(participantAnalysisState.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (rows[0]) {
    const state = rowToState(rows[0]);
    return displayName && !state.displayName ? { ...state, displayName } : state;
  }
  return emptyParticipantState(participantId, sessionId, now, displayName ?? null);
}

export async function loadStates(
  env: Env,
  organizationId: string,
  sessionId: string,
): Promise<ParticipantState[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(participantAnalysisState)
    .where(
      and(
        eq(participantAnalysisState.organizationId, organizationId),
        eq(participantAnalysisState.sessionId, sessionId),
      ),
    );
  return rows.map(rowToState);
}

async function loadOpenEvents(
  env: Env,
  organizationId: string,
  participantId: string,
): Promise<OpenEvent[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(participantEngagementEvents)
    .where(
      and(
        eq(participantEngagementEvents.organizationId, organizationId),
        eq(participantEngagementEvents.participantId, participantId),
        eq(participantEngagementEvents.state, "OPEN"),
      ),
    )
    .limit(20);

  return rows.map((r) => ({
    id: r.id,
    type: r.type as OpenEvent["type"],
    dedupeKey: r.dedupeKey,
    startedAt: r.startedAt,
    severity: r.severity,
    occurrences: r.occurrences,
    escalated: r.escalated,
  }));
}

/** Most recent resolve time per dedupe key, for the re-open cool-off. */
async function loadLastResolved(
  env: Env,
  organizationId: string,
  participantId: string,
): Promise<Record<string, number>> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      dedupeKey: participantEngagementEvents.dedupeKey,
      resolvedAt: participantEngagementEvents.resolvedAt,
    })
    .from(participantEngagementEvents)
    .where(
      and(
        eq(participantEngagementEvents.organizationId, organizationId),
        eq(participantEngagementEvents.participantId, participantId),
        eq(participantEngagementEvents.state, "RESOLVED"),
      ),
    )
    .orderBy(desc(participantEngagementEvents.resolvedAt))
    .limit(20);

  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.resolvedAt != null && out[row.dedupeKey] == null) out[row.dedupeKey] = row.resolvedAt;
  }
  return out;
}

/* ------------------------------------------------------------- write path */

export interface ApplyObservationInput {
  env: Env;
  organizationId: string;
  sessionId: string;
  participantId: string;
  observation: AnalysisObservation;
  config: MeetingMonitoringConfig;
  analysisSessionId?: string | null;
  displayName?: string | null;
  /** Escalates qualifying events into the existing alert inbox. */
  raiseAlert?: (action: Extract<EventAction, { kind: "OPEN" }>, state: ParticipantState) => Promise<string | null>;
  /** Stores a JPEG as evidence and returns its id; omitted when snapshots are off. */
  storeSnapshot?: (state: ParticipantState) => Promise<string | null>;
}

export interface ApplyObservationResult {
  state: ParticipantState;
  actions: EventAction[];
  stateChanged: boolean;
}

/**
 * Applies one observation end-to-end.
 *
 * Ordering matters: state is persisted before events are evaluated, so a crash
 * between the two loses an event rather than corrupting the state the next
 * observation will build on.
 */
export async function applyObservation(
  input: ApplyObservationInput,
): Promise<ApplyObservationResult> {
  const { env, organizationId, sessionId, participantId, observation, config } = input;
  const db = drizzle(env.DB);
  const now = observation.observedAt || Date.now();

  const previous = await loadOrCreateState(
    env,
    organizationId,
    sessionId,
    participantId,
    now,
    input.displayName,
  );
  const { next, change } = reduceParticipantState(previous, observation, config, now);

  const { tier } = classifyTier(next, config, now);
  next.analysisTier = tier;
  next.nextAnalysisAt = nextDueAt(next, config, tier);

  if (observation.identityStatus === "VERIFIED" && observation.identityConfidence != null) {
    next.identityVerifiedAt = now;
    next.identityExpiresAt = now + config.identityCacheSec * 1000;
  }

  const row = stateToRow(next, organizationId, input.analysisSessionId ?? null, now);
  await db
    .insert(participantAnalysisState)
    .values({ ...row, createdAt: now })
    .onConflictDoUpdate({ target: participantAnalysisState.participantId, set: row });

  /* observation history (retention-bounded) */
  if (config.observationRetentionDays > 0) {
    await db.insert(participantObservations).values({
      id: newId("observation"),
      organizationId,
      sessionId,
      participantId,
      observedAt: now,
      faceDetected: observation.faceDetected,
      faceCount: observation.faceCount,
      identityStatus: observation.identityStatus ?? null,
      recognitionConfidence: observation.identityConfidence ?? null,
      headYaw: next.headYaw,
      headPitch: next.headPitch,
      headRoll: next.headRoll,
      screenFacingProbability: next.screenFacingProbability,
      eyeClosed: observation.eyeClosed ?? null,
      eyeOpenness: observation.eyeOpenness ?? null,
      cameraOn: observation.cameraOn ?? null,
      microphoneOn: observation.microphoneOn ?? null,
      speaking: observation.speaking ?? null,
      state: next.currentState,
      confidence: next.analysisConfidence,
      source: observation.source ?? "BOT",
      expiresAt: now + config.observationRetentionDays * 86_400_000,
    });
  }

  /* identity history — only when the decision actually changed */
  if (
    observation.identityStatus &&
    (observation.identityStatus !== previous.identityStatus ||
      (observation.identityTraineeId ?? null) !== (previous.identityTraineeId ?? null))
  ) {
    await db.insert(identityVerifications).values({
      id: newId("identityCheck"),
      organizationId,
      sessionId,
      participantId,
      traineeId: observation.identityTraineeId ?? null,
      result: observation.identityStatus,
      confidence: observation.identityConfidence ?? null,
      threshold: config.identityConfidenceThreshold,
      source: observation.source ?? "BOT",
      trigger: previous.identityVerifiedAt == null ? "JOIN" : "PERIODIC",
      verifiedAt: now,
      expiresAt: observation.identityStatus === "VERIFIED" ? now + config.identityCacheSec * 1000 : null,
    });
  }

  /* events */
  const openEvents = await loadOpenEvents(env, organizationId, participantId);
  const lastResolvedAt = await loadLastResolved(env, organizationId, participantId);
  const actions = evaluateParticipant({ state: next, openEvents, config, now, lastResolvedAt });

  for (const action of actions) {
    await applyEventAction(env, {
      action,
      organizationId,
      sessionId,
      state: next,
      config,
      now,
      raiseAlert: input.raiseAlert,
      storeSnapshot: input.storeSnapshot,
    });
  }

  if (change || actions.length) {
    await publishToSession(env, sessionId, "participant.analysis.updated", {
      participantId,
      state: next.currentState,
      identityStatus: next.identityStatus,
      screenFacingProbability: next.screenFacingProbability,
      cameraOn: next.cameraOn,
      speaking: next.speaking,
      faceDetected: next.faceDetected,
      faceCount: next.faceCount,
      eyeClosed: next.eyeClosed,
      analysisTier: next.analysisTier,
      at: now,
    });
  }

  return { state: next, actions, stateChanged: Boolean(change) };
}

interface EventActionContext {
  action: EventAction;
  organizationId: string;
  sessionId: string;
  state: ParticipantState;
  config: MeetingMonitoringConfig;
  now: number;
  raiseAlert?: ApplyObservationInput["raiseAlert"];
  storeSnapshot?: ApplyObservationInput["storeSnapshot"];
}

/** Persists one engagement-event action and mirrors it to the realtime hub. */
export async function applyEventAction(env: Env, ctx: EventActionContext): Promise<void> {
  const db = drizzle(env.DB);
  const { action, organizationId, sessionId, state, config, now } = ctx;

  if (action.kind === "OPEN") {
    const evidenceId =
      config.snapshotsEnabled && ctx.storeSnapshot ? await ctx.storeSnapshot(state) : null;
    const id = newId("engagementEvent");
    try {
      await db.insert(participantEngagementEvents).values({
        id,
        organizationId,
        sessionId,
        participantId: state.participantId,
        type: action.type,
        severity: action.severity,
        state: "OPEN",
        startedAt: action.startedAt,
        confidence: action.confidence,
        detail: action.detail,
        dedupeKey: action.dedupeKey,
        evidenceId,
        expiresAt: now + config.eventRetentionDays * 86_400_000,
      });
    } catch {
      // Unique (participant, dedupeKey, startedAt): a concurrent worker already
      // opened this exact event. Dedupe is the point — nothing to do.
      return;
    }

    let alertId: string | null = null;
    if (action.escalate && ctx.raiseAlert) {
      alertId = await ctx.raiseAlert(action, state);
      if (alertId) {
        await db
          .update(participantEngagementEvents)
          .set({ alertId, escalated: true, updatedAt: now })
          .where(eq(participantEngagementEvents.id, id));
      }
    }

    await publishToSession(env, sessionId, "engagement.event.opened", {
      id,
      participantId: state.participantId,
      type: action.type,
      severity: action.severity,
      startedAt: action.startedAt,
      detail: action.detail,
      alertId,
    });
    return;
  }

  if (action.kind === "ESCALATE") {
    await db
      .update(participantEngagementEvents)
      .set({ severity: action.severity, escalated: true, detail: action.detail, updatedAt: now })
      .where(
        and(
          eq(participantEngagementEvents.id, action.id),
          eq(participantEngagementEvents.organizationId, organizationId),
        ),
      );
    return;
  }

  await db
    .update(participantEngagementEvents)
    .set({
      state: "RESOLVED",
      resolvedAt: action.resolvedAt,
      durationMs: action.durationMs,
      detail: action.detail,
      updatedAt: now,
    })
    .where(
      and(
        eq(participantEngagementEvents.id, action.id),
        eq(participantEngagementEvents.organizationId, organizationId),
      ),
    );

  await publishToSession(env, sessionId, "engagement.event.resolved", {
    id: action.id,
    participantId: state.participantId,
    type: action.type,
    resolvedAt: action.resolvedAt,
    durationMs: action.durationMs,
  });
}

/**
 * Marks a participant as gone.
 *
 * Their open events are resolved rather than left dangling: "face missing"
 * stops being true the moment somebody leaves the meeting, and an event feed
 * that says otherwise is simply wrong.
 */
export async function markParticipantLeft(
  env: Env,
  organizationId: string,
  sessionId: string,
  participantId: string,
  now: number,
): Promise<void> {
  const db = drizzle(env.DB);
  await db
    .update(participantAnalysisState)
    .set({ leftAt: now, speaking: false, updatedAt: now })
    .where(
      and(
        eq(participantAnalysisState.participantId, participantId),
        eq(participantAnalysisState.organizationId, organizationId),
      ),
    );

  const open = await loadOpenEvents(env, organizationId, participantId);
  for (const event of open) {
    await db
      .update(participantEngagementEvents)
      .set({
        state: "RESOLVED",
        resolvedAt: now,
        durationMs: Math.max(0, now - event.startedAt),
        detail: "参加者が退出したため終了しました",
        updatedAt: now,
      })
      .where(eq(participantEngagementEvents.id, event.id));
  }

  await publishToSession(env, sessionId, "participant.analysis.updated", {
    participantId,
    leftAt: now,
  });
}

/**
 * Ensures a `session_participants` row exists for a Zoom attendee that the
 * analysis layer saw first (the simulator, or a bot batch that arrived before
 * the roster sync). Reuses the existing table so one participant never ends up
 * represented twice.
 */
export async function ensureSessionParticipant(
  env: Env,
  organizationId: string,
  sessionId: string,
  identity: { zoomUserId?: string; participantUuid?: string; displayName?: string; email?: string },
): Promise<string> {
  const db = drizzle(env.DB);

  if (identity.participantUuid) {
    const existing = await db
      .select({ id: sessionParticipants.id })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.organizationId, organizationId),
          eq(sessionParticipants.zoomParticipantUuid, identity.participantUuid),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].id;
  }

  const id = newId("participant");
  await db.insert(sessionParticipants).values({
    id,
    organizationId,
    sessionId,
    zoomParticipantUuid: identity.participantUuid ?? null,
    zoomUserId: identity.zoomUserId ?? null,
    zoomDisplayName: identity.displayName ?? null,
    zoomEmail: identity.email ?? null,
    matchMethod: "unmatched",
  });
  return id;
}

/** Bulk state fetch for the grid, ordered so the riskiest participants come first. */
export async function loadStatesWithIdentity(
  env: Env,
  organizationId: string,
  sessionId: string,
  participantIds?: string[],
) {
  const db = drizzle(env.DB);
  const filters = [
    eq(participantAnalysisState.organizationId, organizationId),
    eq(participantAnalysisState.sessionId, sessionId),
  ];
  if (participantIds?.length) {
    filters.push(inArray(participantAnalysisState.participantId, participantIds));
  }
  return db.select().from(participantAnalysisState).where(and(...filters));
}

/** Participants in this session that have no analysis row yet. */
export async function participantsWithoutState(
  env: Env,
  organizationId: string,
  sessionId: string,
): Promise<{ id: string; displayName: string | null }[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: sessionParticipants.id,
      displayName: sessionParticipants.zoomDisplayName,
      stateId: participantAnalysisState.participantId,
    })
    .from(sessionParticipants)
    .leftJoin(
      participantAnalysisState,
      eq(participantAnalysisState.participantId, sessionParticipants.id),
    )
    .where(
      and(
        eq(sessionParticipants.organizationId, organizationId),
        eq(sessionParticipants.sessionId, sessionId),
        isNull(participantAnalysisState.participantId),
      ),
    );
  return rows.map((r) => ({ id: r.id, displayName: r.displayName }));
}

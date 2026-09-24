import { describe, expect, it } from "vitest";
import { DEFAULT_MEETING_CONFIG } from "../worker/services/monitoring/config";
import { emptyParticipantState, type ParticipantState } from "../worker/services/analysis/participant-state";
import {
  buildPlan,
  classifyTier,
  NEW_PARTICIPANT_MS,
  nextDueAt,
  priorityOf,
  tierMap,
} from "../worker/services/analysis/scheduler";
import { PriorityQueue, rank } from "../worker/services/analysis/priority-queue";

const T0 = 1_760_000_000_000;
const config = { ...DEFAULT_MEETING_CONFIG };

/** A settled participant: joined long ago, verified, analysed recently. */
function stable(id: string, now = T0, patch: Partial<ParticipantState> = {}): ParticipantState {
  return {
    ...emptyParticipantState(id, "ses_1", now - 600_000),
    joinedAt: now - 600_000,
    identityStatus: "VERIFIED",
    identityConfidence: 0.93,
    identityVerifiedAt: now - 60_000,
    identityExpiresAt: now + 540_000,
    currentState: "SCREEN_FACING",
    currentStateSince: now - 120_000,
    lastAnalyzedAt: now - 1_000,
    analysisConfidence: 0.9,
    analysisTier: "NORMAL",
    ...patch,
  };
}

describe("priority queue", () => {
  it("returns items highest-priority first", () => {
    const q = new PriorityQueue<string>();
    q.push("low", 1);
    q.push("high", 100);
    q.push("mid", 50);
    expect(q.toSortedArray()).toEqual(["high", "mid", "low"]);
  });

  it("breaks ties by insertion order, so equals are served round-robin", () => {
    const q = new PriorityQueue<string>();
    q.push("first", 10);
    q.push("second", 10);
    q.push("third", 10);
    expect(q.toSortedArray()).toEqual(["first", "second", "third"]);
  });

  it("take() respects the limit and leaves the rest queued", () => {
    const q = new PriorityQueue<number>();
    for (let i = 0; i < 10; i++) q.push(i, i);
    expect(q.take(3)).toEqual([9, 8, 7]);
    expect(q.size).toBe(7);
  });

  it("handles a large heap correctly", () => {
    const q = new PriorityQueue<number>();
    const values = Array.from({ length: 500 }, (_, i) => (i * 37) % 500);
    for (const v of values) q.push(v, v);
    const sorted = q.toSortedArray();
    expect(sorted[0]).toBe(499);
    expect(sorted[sorted.length - 1]).toBe(0);
    expect(sorted).toEqual([...values].sort((a, b) => b - a));
  });

  it("rank() is a one-shot sort", () => {
    expect(rank([{ item: "a", priority: 1 }, { item: "b", priority: 9 }])).toEqual(["b", "a"]);
  });
});

describe("tier classification", () => {
  it("puts a brand-new participant in HOT", () => {
    const s = stable("sp_new", T0, { joinedAt: T0 - 5_000 });
    expect(classifyTier(s, config, T0)).toEqual({ tier: "HOT", reason: "newly joined" });
  });

  it("drops out of HOT once the new-participant window passes", () => {
    const s = stable("sp_x", T0, { joinedAt: T0 - NEW_PARTICIPANT_MS - 1_000 });
    expect(classifyTier(s, config, T0).tier).not.toBe("HOT");
  });

  it("puts an identity mismatch in HOT", () => {
    const s = stable("sp_m", T0, { identityStatus: "MISMATCH" });
    expect(classifyTier(s, config, T0).tier).toBe("HOT");
  });

  it("puts an unverified identity in HOT", () => {
    const s = stable("sp_u", T0, { identityStatus: "UNVERIFIED" });
    expect(classifyTier(s, config, T0).tier).toBe("HOT");
  });

  it("puts a missing face in HOT", () => {
    const s = stable("sp_f", T0, { currentState: "FACE_NOT_VISIBLE" });
    expect(classifyTier(s, config, T0).tier).toBe("HOT");
  });

  it("escalates a prolonged screen-away to HOT but leaves a brief one WARM", () => {
    const brief = stable("sp_b", T0, { currentState: "LOOKING_LEFT", currentStateSince: T0 - 5_000 });
    const long = stable("sp_l", T0, {
      currentState: "LOOKING_LEFT",
      currentStateSince: T0 - (config.screenAwaySec + 5) * 1000,
    });
    expect(classifyTier(brief, config, T0).tier).toBe("WARM");
    expect(classifyTier(long, config, T0).tier).toBe("HOT");
  });

  it("does not waste inference on a camera that is off", () => {
    const s = stable("sp_c", T0, { currentState: "CAMERA_OFF", currentStateSince: T0 - 300_000 });
    expect(classifyTier(s, config, T0)).toEqual({ tier: "NORMAL", reason: "camera off" });
  });

  it("keeps a participant WARM while a state change is pending", () => {
    const s = stable("sp_p", T0, { pendingState: "LOOKING_DOWN", pendingStateSince: T0 - 1_000 });
    expect(classifyTier(s, config, T0).tier).toBe("WARM");
  });

  it("warms up an analysis that is going stale", () => {
    const s = stable("sp_s", T0, { lastAnalyzedAt: T0 - config.normalIntervalSec * 4000 });
    expect(classifyTier(s, config, T0)).toEqual({ tier: "WARM", reason: "analysis going stale" });
  });

  it("leaves a settled participant NORMAL", () => {
    expect(classifyTier(stable("sp_ok"), config, T0)).toEqual({ tier: "NORMAL", reason: "stable" });
  });

  it("skips identity checks entirely when verification is disabled", () => {
    const off = { ...config, identityVerificationEnabled: false };
    const s = stable("sp_u", T0, { identityStatus: "UNVERIFIED" });
    expect(classifyTier(s, off, T0).tier).not.toBe("HOT");
  });
});

describe("priority ordering", () => {
  it("ranks the spec's escalation order correctly", () => {
    const now = T0;
    const newcomer = stable("new", now, { joinedAt: now - 3_000, identityStatus: "UNKNOWN" });
    const mismatch = stable("mismatch", now, { identityStatus: "MISMATCH", currentState: "IDENTITY_MISMATCH" });
    const noFace = stable("noface", now, { currentState: "FACE_NOT_VISIBLE" });
    const settled = stable("settled", now);

    const order = buildPlan([settled, noFace, mismatch, newcomer], config, {
      now,
      includeNotDue: true,
      limit: 10,
    }).map((e) => e.participantId);

    expect(order[order.length - 1]).toBe("settled");
    expect(order.indexOf("mismatch")).toBeLessThan(order.indexOf("noface"));
    expect(order.slice(0, 3)).toContain("new");
  });

  it("caps the staleness bonus so an old row cannot outrank a live problem", () => {
    const now = T0;
    const ancient = stable("ancient", now, { lastAnalyzedAt: now - 86_400_000 });
    const mismatch = stable("mismatch", now, { identityStatus: "MISMATCH", currentState: "IDENTITY_MISMATCH" });
    const a = priorityOf(ancient, config, classifyTier(ancient, config, now).tier, now);
    const m = priorityOf(mismatch, config, "HOT", now);
    expect(m).toBeGreaterThan(a);
  });

  it("deprioritises a participant who has left", () => {
    const now = T0;
    const gone = stable("gone", now, { leftAt: now - 1_000 });
    expect(priorityOf(gone, config, "NORMAL", now)).toBeLessThan(priorityOf(stable("here", now), config, "NORMAL", now));
  });
});

describe("plan building", () => {
  it("omits participants that are not yet due", () => {
    const now = T0;
    const justAnalysed = stable("fresh", now, { lastAnalyzedAt: now - 500 });
    expect(buildPlan([justAnalysed], config, { now })).toHaveLength(0);
  });

  it("includes them when asked for the full ranking", () => {
    const now = T0;
    const justAnalysed = stable("fresh", now, { lastAnalyzedAt: now - 500 });
    expect(buildPlan([justAnalysed], config, { now, includeNotDue: true })).toHaveLength(1);
  });

  it("excludes participants who have left", () => {
    const now = T0;
    const gone = stable("gone", now, { leftAt: now - 1_000, lastAnalyzedAt: now - 600_000 });
    expect(buildPlan([gone], config, { now, includeNotDue: true })).toHaveLength(0);
  });

  it("respects the limit", () => {
    const now = T0;
    const many = Array.from({ length: 50 }, (_, i) =>
      stable(`sp_${i}`, now, { lastAnalyzedAt: now - 600_000 }),
    );
    expect(buildPlan(many, config, { now, limit: 10 })).toHaveLength(10);
  });

  it("assigns elevated FPS to HOT and normal FPS to the rest", () => {
    const now = T0;
    const hot = stable("hot", now, { identityStatus: "MISMATCH", lastAnalyzedAt: now - 600_000 });
    const normal = stable("normal", now, { lastAnalyzedAt: now - 600_000 });
    const plan = buildPlan([hot, normal], config, { now, limit: 10 });
    expect(plan.find((e) => e.participantId === "hot")?.fps).toBe(config.elevatedFps);
    expect(plan.find((e) => e.participantId === "normal")?.fps).toBe(config.normalFps);
  });

  it("keeps a 200-person meeting's work list bounded", () => {
    const now = T0;
    const room = Array.from({ length: 200 }, (_, i) =>
      stable(`sp_${i}`, now, { lastAnalyzedAt: now - 600_000 }),
    );
    expect(buildPlan(room, config, { now, limit: 25 })).toHaveLength(25);
  });
});

describe("scheduling arithmetic", () => {
  it("derives the next due time from the tier interval", () => {
    const s = stable("sp_1", T0, { lastAnalyzedAt: T0 });
    expect(nextDueAt(s, config, "NORMAL")).toBe(T0 + config.normalIntervalSec * 1000);
    expect(nextDueAt(s, config, "HOT")).toBe(T0 + config.hotIntervalSec * 1000);
  });

  it("treats a never-analysed participant as immediately due", () => {
    const s = { ...stable("sp_1", T0), lastAnalyzedAt: null, joinedAt: T0 - 1000 };
    expect(nextDueAt(s, config, "NORMAL")).toBe(T0 - 1000);
  });

  it("tierMap explains every participant", () => {
    const map = tierMap([stable("a"), stable("b", T0, { identityStatus: "MISMATCH" })], config, T0);
    expect(map.get("a")?.tier).toBe("NORMAL");
    expect(map.get("b")?.reason).toBe("identity mismatch");
  });
});

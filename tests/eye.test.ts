import { describe, expect, it } from "vitest";
import { EyeClosureTracker, eyeCutoff } from "@/lib/face/engine";

/**
 * Eye closure is judged relative to each person's own open-eye baseline, because
 * face-api's absolute EAR varies by face/camera. These tests pin that behaviour
 * for both the admin live-monitor and the trainee monitoring loop, which share
 * EyeClosureTracker.
 */
describe("eyeCutoff", () => {
  it("scales with the baseline but stays within sane bounds", () => {
    expect(eyeCutoff(0.3)).toBeCloseTo(0.24, 5); // 0.8 × 0.30
    expect(eyeCutoff(0.5)).toBe(0.27); // capped
    expect(eyeCutoff(0.1)).toBe(0.16); // floored
  });
});

describe("EyeClosureTracker", () => {
  const feed = (t: EyeClosureTracker, ear: number, n: number) => {
    let s = t.update(ear);
    for (let i = 1; i < n; i++) s = t.update(ear);
    return s;
  };

  it("does not flag steady open eyes", () => {
    const t = new EyeClosureTracker();
    const s = feed(t, 0.3, 30);
    expect(s.baseline).toBeGreaterThan(0.28);
    expect(s.closed).toBe(false);
  });

  it("flags a real closure once a baseline is established", () => {
    const t = new EyeClosureTracker();
    feed(t, 0.3, 30); // open baseline ≈ 0.30 → cutoff ≈ 0.24
    expect(t.update(0.15).closed).toBe(true);
    expect(t.update(0.22).closed).toBe(true); // 0.22 < 0.24: caught, unlike the old fixed 0.21
  });

  it("adapts to a narrow-eyed face (low open EAR)", () => {
    const t = new EyeClosureTracker();
    feed(t, 0.22, 30); // open baseline ≈ 0.22 → cutoff ≈ 0.176
    expect(t.update(0.22).closed).toBe(false);
    expect(t.update(0.12).closed).toBe(true);
  });

  it("does not trust closure before a plausible baseline exists", () => {
    const t = new EyeClosureTracker();
    expect(t.update(0.1).closed).toBe(false); // baseline 0.10 < minimum
  });

  it("keeps the baseline through a long closure (slow decay)", () => {
    const t = new EyeClosureTracker();
    feed(t, 0.3, 30);
    let s = t.update(0.14);
    for (let i = 0; i < 40; i++) s = t.update(0.14); // ~9s of closure at 4.5fps
    expect(s.baseline).toBeGreaterThan(0.24); // still reads as closure, not a new baseline
    expect(s.closed).toBe(true);
  });

  it("resets its baseline", () => {
    const t = new EyeClosureTracker();
    feed(t, 0.3, 30);
    t.reset();
    expect(t.update(0.1).closed).toBe(false);
  });
});

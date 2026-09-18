import { describe, expect, it } from "vitest";
import { assertDescriptor, assessQuality, cosineSimilarity, type QualityInput } from "../worker/lib/faces";

const GOOD: QualityInput = {
  faceCount: 1, relativeSize: 0.18, yaw: 0.05, pitch: 0.03,
  brightness: 0.55, sharpness: 0.8, occlusion: 0.05,
};

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is scale invariant", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("rejects mismatched dimensions", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});

describe("assertDescriptor", () => {
  it("accepts a 128-float descriptor for the supported engine", () => {
    const d = Array.from({ length: 128 }, (_, i) => i / 128);
    expect(assertDescriptor(d, "faceapi-128")).toHaveLength(128);
  });

  it("rejects the wrong dimensionality", () => {
    expect(() => assertDescriptor(Array(64).fill(0), "faceapi-128")).toThrow(/次元数/);
  });

  it("rejects an unknown engine, so templates are never compared across spaces", () => {
    expect(() => assertDescriptor(Array(128).fill(0), "some-other-engine")).toThrow(/未対応/);
  });

  it("rejects non-finite values", () => {
    const d = Array(128).fill(0);
    d[7] = Number.NaN;
    expect(() => assertDescriptor(d, "faceapi-128")).toThrow();
  });

  it("rejects a non-array", () => {
    expect(() => assertDescriptor("nope", "faceapi-128")).toThrow();
  });
});

describe("assessQuality", () => {
  it("passes a well-framed, sharp, well-lit face", () => {
    const r = assessQuality(GOOD);
    expect(r.passed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.score).toBeGreaterThan(0.55);
  });

  it("rejects a frame with no face", () => {
    const r = assessQuality({ ...GOOD, faceCount: 0 });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toContain("顔が検出できません");
  });

  it("rejects multiple faces", () => {
    const r = assessQuality({ ...GOOD, faceCount: 2 });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toContain("複数の顔");
  });

  it("rejects a dark frame", () => {
    const r = assessQuality({ ...GOOD, brightness: 0.1 });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toContain("暗すぎます");
  });

  it("rejects a blurred frame", () => {
    const r = assessQuality({ ...GOOD, sharpness: 0.1 });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toContain("ぶれ");
  });

  it("rejects a non-frontal pose", () => {
    const r = assessQuality({ ...GOOD, yaw: 0.9 });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toContain("正面");
  });

  it("rejects an occluded face", () => {
    const r = assessQuality({ ...GOOD, occlusion: 0.8 });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toContain("遮蔽");
  });

  it("reports every problem at once so one retake can fix them all", () => {
    const r = assessQuality({ ...GOOD, brightness: 0.05, sharpness: 0.1, yaw: 1.2 });
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the score within [0, 1]", () => {
    for (const q of [GOOD, { ...GOOD, relativeSize: 1, sharpness: 1 }, { ...GOOD, faceCount: 0, occlusion: 1 }]) {
      const { score } = assessQuality(q);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

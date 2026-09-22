/**
 * Server-side face template handling.
 *
 * The engine that produces descriptors runs in the trainee's browser
 * (ARCHITECTURE.md §2.1). This module never sees an image: it stores encrypted
 * descriptors and performs the authoritative 1:1 comparison for precheck, so a
 * tampered client cannot simply assert that it passed.
 */
import { seal, unseal } from "./crypto";
import { unprocessable } from "./errors";

/** Descriptor length must match the enrolling engine or comparison is meaningless. */
export const SUPPORTED_ENGINES: Record<string, number> = {
  "faceapi-128": 128,
};

export function assertDescriptor(descriptor: unknown, engine: string): number[] {
  const expected = SUPPORTED_ENGINES[engine];
  if (!expected) throw unprocessable(`未対応の顔認識エンジンです: ${engine}`);
  if (!Array.isArray(descriptor) || descriptor.length !== expected) {
    throw unprocessable(`顔特徴量の次元数が不正です（期待値 ${expected}）`);
  }
  for (const v of descriptor) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw unprocessable("顔特徴量に数値以外が含まれています");
    }
  }
  return descriptor as number[];
}

/**
 * Cosine similarity in [-1, 1]. Kept for reference/tests, but NOT used for face
 * matching: face-api's 128-D descriptors are not unit-normalised (‖d‖≈1.4) and
 * are not zero-centred, so different people sit at cosine ≈0.80-0.83 while the
 * same person is ≈0.96 — the populations overlap and no cosine cutoff separates
 * them reliably. Use `matchScore` (Euclidean-based) instead.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw unprocessable("顔特徴量の次元数が一致しません");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Euclidean (L2) distance — the metric face-api's recognition net is trained for. */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw unprocessable("顔特徴量の次元数が一致しません");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/**
 * Match confidence in [0, 1], derived from Euclidean distance.
 *
 * Measured on face-api descriptors: same person d≈0.35-0.45, different person
 * d≈0.8-0.9, so the model's standard operating point is a distance of ~0.6.
 * We map distance→score linearly (`1 − 0.3·d`) so that the well-separated
 * populations land either side of the shipped 0.82 threshold (0.6 ↔ 0.82):
 * same person ≈0.87-0.90, different ≈0.73-0.76. This keeps `matchThreshold`
 * as a "higher = stricter" similarity while comparing on the metric that
 * actually separates faces.
 *
 * TEST_PLAN.md §2: production thresholds must still come from a FAR/FRR
 * measurement on customer data; this is a corrected starting point.
 */
export const MATCH_DISTANCE_SLOPE = 0.3;

export function matchScore(a: number[], b: number[]): number {
  const d = euclideanDistance(a, b);
  return Math.max(0, Math.min(1, 1 - MATCH_DISTANCE_SLOPE * d));
}

export async function sealDescriptor(descriptor: number[], key: string) {
  return seal(JSON.stringify(descriptor), key);
}

export async function unsealDescriptor(
  ciphertext: string,
  iv: string,
  key: string,
): Promise<number[]> {
  return JSON.parse(await unseal({ ciphertext, iv }, key)) as number[];
}

export interface QualityReport {
  score: number;
  passed: boolean;
  reasons: string[];
}

export interface QualityInput {
  faceCount: number;
  /** Face box area as a fraction of the frame. */
  relativeSize: number;
  /** 0 = perfectly frontal; radians of yaw/pitch deviation. */
  yaw: number;
  pitch: number;
  brightness: number;
  sharpness: number;
  occlusion: number;
}

/**
 * Enrollment quality gate (PRODUCT_SPEC_JA.md §3.1). Returns every failing
 * reason at once so the trainee can fix the photo in one retake rather than
 * discovering problems one at a time.
 */
export function assessQuality(input: QualityInput): QualityReport {
  const reasons: string[] = [];

  if (input.faceCount === 0) reasons.push("顔が検出できません");
  if (input.faceCount > 1) reasons.push("複数の顔が検出されました");
  if (input.relativeSize < 0.05) reasons.push("顔が小さすぎます。カメラに近づいてください");
  if (Math.abs(input.yaw) > 0.35 || Math.abs(input.pitch) > 0.35) {
    reasons.push("正面を向いてください");
  }
  if (input.brightness < 0.25) reasons.push("暗すぎます。照明を明るくしてください");
  if (input.brightness > 0.9) reasons.push("明るすぎます。逆光を避けてください");
  if (input.sharpness < 0.3) reasons.push("画像がぶれています");
  if (input.occlusion > 0.35) reasons.push("顔が遮蔽されています。マスクや手を外してください");

  // Weighted so that framing and sharpness dominate — they are what actually
  // degrade descriptor stability.
  const score = Math.max(
    0,
    Math.min(
      1,
      0.3 * Math.min(1, input.relativeSize / 0.15) +
        0.25 * input.sharpness +
        0.2 * (1 - Math.min(1, (Math.abs(input.yaw) + Math.abs(input.pitch)) / 0.7)) +
        0.15 * (1 - Math.abs(input.brightness - 0.55) / 0.55) +
        0.1 * (1 - input.occlusion),
    ),
  );

  return { score, passed: reasons.length === 0 && score >= 0.55, reasons };
}

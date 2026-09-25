/**
 * Filename → trainee resolution for photo enrollment.
 *
 * Enrolling from a folder means the operator hands us a pile of image files and
 * expects each one to land on the right person. The only thing an image file
 * carries about identity is its path, so the rules for reading that path have
 * to be explicit, predictable, and refuse to guess — binding a face template to
 * the wrong trainee is the single worst failure this product can have.
 *
 * Kept free of DOM and network calls so the rules can be tested directly;
 * the engine work lives in `engine.ts` and the UI in `Enroll.tsx`.
 */
import type { Trainee } from "@/lib/api";

export type PhotoMatchMethod = "email" | "external_id" | "name" | "unmatched" | "ambiguous";

export interface PhotoMatch {
  traineeId: string | null;
  method: PhotoMatchMethod;
  /** Populated when more than one trainee answers to the same key. */
  candidates: string[];
}

/** Image types the browser can reliably decode for analysis. */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/bmp"];
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|bmp)$/i;

/** True for files worth trying to enroll; a folder drop is full of other things. */
export function isEnrollableImage(file: { name: string; type?: string }): boolean {
  if (file.type && ACCEPTED_IMAGE_TYPES.includes(file.type)) return true;
  // Directory pickers hand over files with an empty `type` more often than not,
  // so the extension has to be authoritative when the MIME type is missing.
  return !file.type && IMAGE_EXTENSIONS.test(file.name);
}

/** Comparison form for identifiers: full-width folded, spaces removed, upper-cased. */
function normalizeId(value: string): string {
  return value.normalize("NFKC").replace(/[\s　]+/g, "").toUpperCase();
}

/**
 * Comparison form for names. Mirrors `normalizeName` in `worker/lib/zoom.ts`
 * so a photo and a Zoom display name resolve to the same trainee.
 */
function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
}

/**
 * Strips a duplicate-file suffix such as `(2)` or `_3`.
 *
 * Deliberately does NOT strip a bare `-2`: trainee numbers routinely end in a
 * hyphen and digits (AZ-0241), so removing that would silently turn one
 * person's identifier into another's. A `(n)` or `_n` suffix has no such
 * collision, and those are the two forms operating systems actually produce
 * when a file is copied.
 */
export function stripDuplicateSuffix(stem: string): string {
  return stem
    .replace(/[\s_]*\(\s*\d{1,3}\s*\)\s*$/u, "")
    .replace(/_\d{1,3}$/u, "")
    .trim();
}

/**
 * The identifying token for one image.
 *
 * A per-person subfolder wins over the filename, because that is how people
 * organise photo sets: `staff/AZ-0241/front.jpg` is three photos of one person,
 * not three people. With no subfolder, the filename stem is the key.
 */
export function photoKeyFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const file = segments[segments.length - 1] ?? "";
  const parents = segments.slice(0, -1);

  // parents[0] is the root folder the operator picked, which names the batch,
  // not a person. Anything below it does name a person.
  const key = parents.length >= 2 ? parents[parents.length - 1] : file.replace(IMAGE_EXTENSIONS, "");
  return stripDuplicateSuffix(key);
}

/**
 * Resolves one key against the roster, strongest evidence first.
 *
 * Returns `ambiguous` rather than picking a winner when a key matches more than
 * one trainee: two people can share a display name, and an operator correcting
 * a reported ambiguity is far cheaper than discovering months later that the
 * wrong face was enrolled.
 */
export function matchPhotoToTrainee(key: string, trainees: Trainee[]): PhotoMatch {
  const trimmed = key.trim();
  if (!trimmed) return { traineeId: null, method: "unmatched", candidates: [] };

  const byEmail = trainees.filter(
    (t) => t.email && t.email.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (byEmail.length) return decide(byEmail, "email");

  const wanted = normalizeId(trimmed);
  const byExternalId = trainees.filter((t) => normalizeId(t.externalId) === wanted);
  if (byExternalId.length) return decide(byExternalId, "external_id");

  const wantedName = normalizeName(trimmed);
  const byName = trainees.filter((t) => normalizeName(t.name) === wantedName);
  if (byName.length) return decide(byName, "name");

  return { traineeId: null, method: "unmatched", candidates: [] };
}

function decide(hits: Trainee[], method: PhotoMatchMethod): PhotoMatch {
  if (hits.length > 1) {
    return { traineeId: null, method: "ambiguous", candidates: hits.map((t) => t.id) };
  }
  return { traineeId: hits[0].id, method, candidates: [hits[0].id] };
}

export const MATCH_METHOD_LABELS: Record<PhotoMatchMethod, string> = {
  email: "メール一致",
  external_id: "受講者ID一致",
  name: "氏名一致",
  unmatched: "該当者なし",
  ambiguous: "候補が複数",
};

/**
 * Groups files by the trainee key they resolve to, preserving order.
 *
 * Grouping matters because several photos of one person should become several
 * enrollments for that person rather than being treated as unrelated files.
 */
export function groupPhotosByKey<T extends { path: string }>(files: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const key = photoKeyFromPath(file.path);
    const existing = groups.get(key);
    if (existing) existing.push(file);
    else groups.set(key, [file]);
  }
  return groups;
}

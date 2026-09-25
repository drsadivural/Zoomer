import { describe, expect, it } from "vitest";
import {
  groupPhotosByKey,
  isEnrollableImage,
  matchPhotoToTrainee,
  photoKeyFromPath,
  stripDuplicateSuffix,
} from "../src/lib/face/photo-enroll";
import type { Trainee } from "../src/lib/api";

function trainee(over: Partial<Trainee> & Pick<Trainee, "id" | "externalId" | "name">): Trainee {
  return {
    department: null,
    email: null,
    enrollmentCount: 0,
    lastQuality: null,
    createdAt: 0,
    ...over,
  } as Trainee;
}

const ROSTER: Trainee[] = [
  trainee({ id: "t1", externalId: "AZ-0241", name: "佐藤 美咲", email: "misaki.sato@example.co.jp" }),
  trainee({ id: "t2", externalId: "AZ-0242", name: "鈴木 健太" }),
  trainee({ id: "t3", externalId: "AZ-0243", name: "鈴木 健太" }), // deliberate name collision
];

describe("photoKeyFromPath", () => {
  it("uses the filename stem when the photo is not in a per-person folder", () => {
    expect(photoKeyFromPath("staff/AZ-0241.jpg")).toBe("AZ-0241");
    expect(photoKeyFromPath("AZ-0241.png")).toBe("AZ-0241");
  });

  it("prefers the immediate parent folder, which names the person", () => {
    expect(photoKeyFromPath("staff/AZ-0241/front.jpg")).toBe("AZ-0241");
    // Several photos of one person must collapse to the same key.
    expect(photoKeyFromPath("staff/AZ-0241/left.jpg")).toBe("AZ-0241");
  });

  it("ignores intermediate folders above the person folder", () => {
    expect(photoKeyFromPath("batch/2026/AZ-0241/a.jpg")).toBe("AZ-0241");
  });

  it("keeps Japanese names intact", () => {
    expect(photoKeyFromPath("研修/佐藤 美咲.jpg")).toBe("佐藤 美咲");
  });
});

describe("stripDuplicateSuffix", () => {
  it("removes copy markers the OS adds", () => {
    expect(stripDuplicateSuffix("AZ-0241 (2)")).toBe("AZ-0241");
    expect(stripDuplicateSuffix("AZ-0241(3)")).toBe("AZ-0241");
    expect(stripDuplicateSuffix("AZ-0241_2")).toBe("AZ-0241");
  });

  it("never strips a bare hyphen-number, which is part of the trainee number", () => {
    // The whole reason the rule is narrow: AZ-0241 must not become AZ.
    expect(stripDuplicateSuffix("AZ-0241")).toBe("AZ-0241");
    expect(stripDuplicateSuffix("E2E-12345")).toBe("E2E-12345");
  });
});

describe("matchPhotoToTrainee", () => {
  it("matches on email before anything else", () => {
    const m = matchPhotoToTrainee("misaki.sato@example.co.jp", ROSTER);
    expect(m).toMatchObject({ traineeId: "t1", method: "email" });
  });

  it("matches a trainee number regardless of case and width", () => {
    expect(matchPhotoToTrainee("az-0241", ROSTER).traineeId).toBe("t1");
    expect(matchPhotoToTrainee("ＡＺ-０２４１", ROSTER).traineeId).toBe("t1");
  });

  it("matches a name with or without the space", () => {
    expect(matchPhotoToTrainee("佐藤 美咲", ROSTER).method).toBe("name");
    expect(matchPhotoToTrainee("佐藤美咲", ROSTER).traineeId).toBe("t1");
  });

  it("refuses to choose when a name belongs to two trainees", () => {
    const m = matchPhotoToTrainee("鈴木 健太", ROSTER);
    expect(m.traineeId).toBeNull();
    expect(m.method).toBe("ambiguous");
    expect(m.candidates).toEqual(["t2", "t3"]);
  });

  it("reports no match rather than approximating", () => {
    expect(matchPhotoToTrainee("unknown-person", ROSTER).method).toBe("unmatched");
    expect(matchPhotoToTrainee("   ", ROSTER).method).toBe("unmatched");
  });
});

describe("isEnrollableImage", () => {
  it("accepts images by MIME type", () => {
    expect(isEnrollableImage({ name: "a.jpg", type: "image/jpeg" })).toBe(true);
  });

  it("falls back to the extension, because folder pickers omit the type", () => {
    expect(isEnrollableImage({ name: "a.JPEG", type: "" })).toBe(true);
    expect(isEnrollableImage({ name: "notes.txt", type: "" })).toBe(false);
  });

  it("rejects non-images that a folder drop sweeps up", () => {
    expect(isEnrollableImage({ name: "roster.csv", type: "text/csv" })).toBe(false);
    expect(isEnrollableImage({ name: ".DS_Store", type: "" })).toBe(false);
  });
});

describe("groupPhotosByKey", () => {
  it("collects every photo of one person under a single key", () => {
    const groups = groupPhotosByKey([
      { path: "staff/AZ-0241/front.jpg" },
      { path: "staff/AZ-0241/left.jpg" },
      { path: "staff/AZ-0242.jpg" },
    ]);
    expect([...groups.keys()]).toEqual(["AZ-0241", "AZ-0242"]);
    expect(groups.get("AZ-0241")).toHaveLength(2);
  });
});

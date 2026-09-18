import { describe, expect, it } from "vitest";
import { isValidId, newId, ulid } from "../worker/lib/ids";

describe("ulid", () => {
  it("is 26 Crockford base32 characters", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts lexicographically by time", () => {
    const early = ulid(1_700_000_000_000);
    const later = ulid(1_800_000_000_000);
    expect(early < later).toBe(true);
  });

  it("is unique across many draws at the same instant", () => {
    const now = Date.now();
    const seen = new Set(Array.from({ length: 1000 }, () => ulid(now)));
    expect(seen.size).toBe(1000);
  });
});

describe("newId / isValidId", () => {
  it("prefixes per resource, matching the API contract examples", () => {
    expect(newId("event")).toMatch(/^evt_/);
    expect(newId("session")).toMatch(/^ses_/);
    expect(newId("participant")).toMatch(/^sp_/);
  });

  it("validates shape and optional prefix", () => {
    const id = newId("alert");
    expect(isValidId(id)).toBe(true);
    expect(isValidId(id, "alert")).toBe(true);
    expect(isValidId(id, "event")).toBe(false);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "evt_", "evt_short", "nope", 123, null, undefined, "evt_" + "I".repeat(26)]) {
      expect(isValidId(bad)).toBe(false);
    }
  });
});

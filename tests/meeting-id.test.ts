/**
 * Zoom shows a meeting id as "801 755 4335"; every webhook and API response
 * carries "8017554335". A session linked by hand with the displayed form
 * matched no incoming event, so its participants never arrived and the webhook
 * would have created a second, empty session beside it. Nothing errored.
 */
import { describe, expect, it } from "vitest";
import { normalizeMeetingId } from "../worker/lib/zoom";

describe("normalizeMeetingId", () => {
  it("strips the spacing Zoom's own UI shows", () => {
    expect(normalizeMeetingId("801 755 4335")).toBe("8017554335");
    expect(normalizeMeetingId("801-755-4335")).toBe("8017554335");
  });

  it("leaves an already-canonical id untouched", () => {
    expect(normalizeMeetingId("8017554335")).toBe("8017554335");
  });

  it("handles full-width spacing pasted from Japanese input", () => {
    expect(normalizeMeetingId("801　755　4335")).toBe("8017554335");
  });

  it("tolerates stray whitespace around a paste", () => {
    expect(normalizeMeetingId("  8017554335\n")).toBe("8017554335");
    expect(normalizeMeetingId("\t801 755 4335 ")).toBe("8017554335");
  });

  it("treats a field with no digits as unlinked rather than empty-string", () => {
    // An empty string would compare equal to nothing and link to nothing,
    // but it is not the same as "this session has no Zoom meeting".
    expect(normalizeMeetingId("")).toBeNull();
    expect(normalizeMeetingId("   ")).toBeNull();
    expect(normalizeMeetingId(null)).toBeNull();
    expect(normalizeMeetingId(undefined)).toBeNull();
  });

  it("keeps only digits from a pasted join URL fragment", () => {
    // Not a documented input, but pasting more than the id is common and
    // digits-only still recovers the meeting number.
    expect(normalizeMeetingId("Meeting ID: 801 755 4335")).toBe("8017554335");
  });
});

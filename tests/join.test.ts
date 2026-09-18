import { describe, expect, it } from "vitest";
import { buildJoinUrl, signJoinToken, verifyJoinToken } from "../worker/lib/join";

const KEY = "test-signing-key";
const PARTICIPANT = "sp_01J5Y2K1PXV3H2TZM0MQ2J9N2S";

describe("join tokens", () => {
  it("verifies a token issued for the same participant", async () => {
    const token = await signJoinToken(PARTICIPANT, Date.now() + 60_000, KEY);
    await expect(verifyJoinToken(PARTICIPANT, token, KEY)).resolves.toBeUndefined();
  });

  it("refuses a token minted for a different participant", async () => {
    const token = await signJoinToken("sp_OTHER0000000000000000000A", Date.now() + 60_000, KEY);
    await expect(verifyJoinToken(PARTICIPANT, token, KEY)).rejects.toThrow(/不正/);
  });

  it("refuses an expired token", async () => {
    const token = await signJoinToken(PARTICIPANT, Date.now() - 1000, KEY);
    await expect(verifyJoinToken(PARTICIPANT, token, KEY)).rejects.toThrow(/有効期限/);
  });

  it("refuses a token signed with a different key", async () => {
    const token = await signJoinToken(PARTICIPANT, Date.now() + 60_000, "other-key");
    await expect(verifyJoinToken(PARTICIPANT, token, KEY)).rejects.toThrow(/不正/);
  });

  it("refuses a token whose expiry was tampered with", async () => {
    const token = await signJoinToken(PARTICIPANT, Date.now() + 1000, KEY);
    const [, sig] = token.split(".");
    const forged = `${Date.now() + 10 * 60 * 1000}.${sig}`;
    await expect(verifyJoinToken(PARTICIPANT, forged, KEY)).rejects.toThrow(/不正/);
  });

  it("refuses malformed tokens", async () => {
    for (const bad of ["", "abc", "123", "."]) {
      await expect(verifyJoinToken(PARTICIPANT, bad, KEY)).rejects.toThrow();
    }
  });

  it("builds a join URL carrying the token", () => {
    const url = new URL(buildJoinUrl("https://zoomer.ayonix.com", PARTICIPANT, "123.abc"));
    expect(url.pathname).toBe(`/join/${PARTICIPANT}`);
    expect(url.searchParams.get("t")).toBe("123.abc");
  });
});

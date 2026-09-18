import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl, buildUrlValidationResponse, extractExternalId, findExternalIdInName,
  normalizeName, verifyWebhookSignature,
} from "../worker/lib/zoom";
import { hmacSha256Hex } from "../worker/lib/crypto";

const SECRET = "test_secret_token";

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ event: "meeting.started", payload: { object: { id: 123 } } });

  async function sign(raw: string, ts: string) {
    return `v0=${await hmacSha256Hex(SECRET, `v0:${ts}:${raw}`)}`;
  }

  it("accepts a correctly signed, fresh delivery", async () => {
    const now = Date.now();
    const ts = String(now);
    const r = await verifyWebhookSignature(body, await sign(body, ts), ts, SECRET, now);
    expect(r.valid).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const now = Date.now();
    const ts = String(now);
    const sig = await sign(body, ts);
    const r = await verifyWebhookSignature(body + " ", sig, ts, SECRET, now);
    expect(r.valid).toBe(false);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const now = Date.now();
    const ts = String(now);
    const sig = `v0=${await hmacSha256Hex("wrong_secret", `v0:${ts}:${body}`)}`;
    const r = await verifyWebhookSignature(body, sig, ts, SECRET, now);
    expect(r.valid).toBe(false);
  });

  it("rejects a replayed delivery outside the timestamp window", async () => {
    const now = Date.now();
    const oldTs = String(now - 10 * 60 * 1000);
    const r = await verifyWebhookSignature(body, await sign(body, oldTs), oldTs, SECRET, now);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("有効期限");
  });

  it("rejects missing headers", async () => {
    expect((await verifyWebhookSignature(body, undefined, "1", SECRET)).valid).toBe(false);
    expect((await verifyWebhookSignature(body, "v0=abc", undefined, SECRET)).valid).toBe(false);
  });

  it("tolerates a seconds-precision timestamp", async () => {
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const r = await verifyWebhookSignature(body, await sign(body, ts), ts, SECRET, now);
    expect(r.valid).toBe(true);
  });
});

describe("buildUrlValidationResponse", () => {
  it("returns the plain token with its HMAC, as Zoom's handshake requires", async () => {
    const r = await buildUrlValidationResponse("abc123", SECRET);
    expect(r.plainToken).toBe("abc123");
    expect(r.encryptedToken).toBe(await hmacSha256Hex(SECRET, "abc123"));
    expect(r.encryptedToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("normalizeName", () => {
  it("treats every space form as equivalent", () => {
    expect(normalizeName("佐藤 美咲")).toBe(normalizeName("佐藤　美咲"));
    expect(normalizeName("佐藤 美咲")).toBe(normalizeName("佐藤美咲"));
  });

  it("folds full-width latin and case", () => {
    expect(normalizeName("ＡＢＣ")).toBe("abc");
    expect(normalizeName("Taro Yamada")).toBe("taroyamada");
  });
});

describe("extractExternalId", () => {
  it("finds a trainee number anywhere in a display name", () => {
    expect(extractExternalId("AZ-0241 佐藤 美咲")).toBe("AZ-0241");
    expect(extractExternalId("佐藤 美咲 (AZ-0241)")).toBe("AZ-0241");
  });

  it("handles identifiers whose prefix mixes letters and digits", () => {
    expect(extractExternalId("E2E-12345 検証")).toBe("E2E-12345");
  });

  it("upper-cases what it finds", () => {
    expect(extractExternalId("az-0241 佐藤")).toBe("AZ-0241");
  });

  it("returns null when there is no identifier", () => {
    expect(extractExternalId("佐藤 美咲")).toBeNull();
  });
});

describe("findExternalIdInName", () => {
  const roster = ["AZ-0241", "AZ-0248", "E2E-12345", "EMP001"];

  it("finds a conventional trainee number", () => {
    expect(findExternalIdInName("AZ-0241 佐藤 美咲", roster)).toBe("AZ-0241");
  });

  it("finds an identifier whose prefix mixes letters and digits", () => {
    // A format-guessing regex misses this; matching against the real roster does not.
    expect(findExternalIdInName("E2E-12345 検証 太郎", roster)).toBe("E2E-12345");
  });

  it("finds an identifier with no separator", () => {
    expect(findExternalIdInName("EMP001 山田", roster)).toBe("EMP001");
  });

  it("ignores full-width and spacing differences", () => {
    expect(findExternalIdInName("ＡＺ－０２４１　佐藤", roster)).toBe("AZ-0241");
  });

  it("returns null when the name matches nothing on the roster", () => {
    expect(findExternalIdInName("Unknown Guest", roster)).toBeNull();
  });

  it("returns null rather than guessing when two identifiers both appear", () => {
    expect(findExternalIdInName("AZ-0241 / AZ-0248 合同", roster)).toBeNull();
  });

  it("ignores identifiers too short to be distinctive", () => {
    expect(findExternalIdInName("A1 田中", ["A1"])).toBeNull();
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds a Zoom authorize URL with an exactly-preserved redirect", () => {
    const redirect = "https://zoomer.ayonix.com/api/v1/integrations/zoom/oauth/callback";
    const url = new URL(buildAuthorizeUrl("client123", redirect, "state456"));
    expect(url.origin + url.pathname).toBe("https://zoom.us/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client123");
    // Zoom rejects (4700) unless this matches the registered value byte for byte.
    expect(url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(url.searchParams.get("state")).toBe("state456");
  });
});

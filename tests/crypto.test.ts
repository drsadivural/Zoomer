import { describe, expect, it } from "vitest";
import {
  b64decode, b64encode, generateToken, hashPassword, hmacSha256Hex, seal, sha256Hex,
  timingSafeEqual, unseal, verifyPassword,
} from "../worker/lib/crypto";

const KEY = b64encode(crypto.getRandomValues(new Uint8Array(32)));

describe("seal / unseal", () => {
  it("round-trips a value", async () => {
    const sealed = await seal("very secret descriptor", KEY);
    expect(await unseal(sealed, KEY)).toBe("very secret descriptor");
  });

  it("produces a different IV and ciphertext each call", async () => {
    const a = await seal("same plaintext", KEY);
    const b = await seal("same plaintext", KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt under a different key", async () => {
    const other = b64encode(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await seal("secret", KEY);
    await expect(unseal(sealed, other)).rejects.toThrow();
  });

  it("fails on tampered ciphertext (GCM authentication)", async () => {
    const sealed = await seal("secret", KEY);
    const bytes = b64decode(sealed.ciphertext);
    bytes[0] ^= 0xff;
    await expect(unseal({ ...sealed, ciphertext: b64encode(bytes) }, KEY)).rejects.toThrow();
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(seal("x", b64encode(new Uint8Array(16)))).rejects.toThrow(/32 bytes/);
  });

  it("round-trips multibyte Japanese text", async () => {
    const value = "佐藤 美咲／人事部";
    expect(await unseal(await seal(value, KEY), KEY)).toBe(value);
  });
});

describe("password hashing", () => {
  it("verifies the correct password", async () => {
    const hash = await hashPassword("Correct-Horse-9");
    expect(await verifyPassword("Correct-Horse-9", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("Correct-Horse-9");
    expect(await verifyPassword("correct-horse-9", hash)).toBe(false);
  });

  it("salts, so equal passwords hash differently", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("rejects an unknown hash scheme rather than throwing", async () => {
    expect(await verifyPassword("x", "bcrypt$12$abc$def")).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("matches identical strings", () => {
    expect(timingSafeEqual("abcdef", "abcdef")).toBe(true);
  });

  it("rejects differing strings of equal length", () => {
    expect(timingSafeEqual("abcdef", "abcdeg")).toBe(false);
  });

  it("rejects differing lengths without short-circuiting to true", () => {
    expect(timingSafeEqual("abc", "abcdef")).toBe(false);
    expect(timingSafeEqual("", "a")).toBe(false);
  });
});

describe("hashing and tokens", () => {
  it("sha256Hex is stable and correctly sized", async () => {
    const a = await sha256Hex("hello");
    expect(a).toBe(await sha256Hex("hello"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hmacSha256Hex depends on the key", async () => {
    expect(await hmacSha256Hex("k1", "m")).not.toBe(await hmacSha256Hex("k2", "m"));
  });

  it("generateToken returns a URL-safe token with a matching hash", async () => {
    const { token, hash } = await generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).toBe(await sha256Hex(token));
  });

  it("generates distinct tokens", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add((await generateToken()).token);
    expect(seen.size).toBe(50);
  });
});

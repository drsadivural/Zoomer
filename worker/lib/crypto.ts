/**
 * Cryptographic helpers. All key material arrives as base64 secrets and is
 * imported per call; nothing is cached across requests on purpose, so that
 * rotating a secret takes effect immediately.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Returns an `ArrayBuffer`-backed view. WebCrypto's `BufferSource` will not
 * accept a `SharedArrayBuffer`-backed array, so the buffer is allocated
 * explicitly rather than relying on inference.
 */
export function b64decode(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Copies text into a fresh `ArrayBuffer`-backed view for WebCrypto calls. */
export function utf8(value: string): Uint8Array<ArrayBuffer> {
  const src = enc.encode(value);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}

/** Copies any byte view into a fresh `ArrayBuffer`-backed view. */
export function rebuffer(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}

export function b64urlencode(buf: ArrayBuffer | Uint8Array): string {
  return b64encode(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const raw = b64decode(base64Key);
  if (raw.length !== 32) {
    throw new Error("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface SealedValue {
  ciphertext: string;
  iv: string;
}

/** AES-256-GCM. A fresh 96-bit IV per call; never reuse one with the same key. */
export async function seal(plaintext: string, base64Key: string): Promise<SealedValue> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plaintext));
  return { ciphertext: b64encode(ct), iv: b64encode(iv) };
}

export async function unseal(sealed: SealedValue, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(sealed.iv) },
    key,
    b64decode(sealed.ciphertext),
  );
  return dec.decode(pt);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? utf8(input) : rebuffer(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256(key: string, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    utf8(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, utf8(message));
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const sig = await hmacSha256(key, message);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Base64(key: string, message: string): Promise<string> {
  return b64encode(await hmacSha256(key, message));
}

/** Length-independent comparison, to keep signature checks off the timing channel. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare a fixed-size digest-like accumulator so that unequal lengths do not
  // short-circuit. Length inequality still forces a mismatch via the seed.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** URL-safe opaque token plus the hash we actually persist. */
export async function generateToken(bytes = 32): Promise<{ token: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(bytes)));
  const token = b64urlencode(raw);
  return { token, hash: await sha256Hex(token) };
}

/**
 * PBKDF2-SHA256 password hashing.
 *
 * Workers has no bcrypt/argon2, and its WebCrypto rejects PBKDF2 iteration
 * counts above 100,000 ("iteration counts above 100000 are not supported"), so
 * that ceiling is the operating point rather than a choice. Local passwords are
 * therefore the bootstrap path only; SSO with MFA is the intended production
 * authentication route (SECURITY_PRIVACY.md §2), and this ceiling is one of the
 * reasons why.
 */
const PBKDF2_ITERATIONS = 100_000;

/** Platform ceiling. A stored hash above this cannot be verified here at all. */
const MAX_PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const keyMaterial = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2") return false;

  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  if (iterations > MAX_PBKDF2_ITERATIONS) {
    // Deny rather than throw, but say so: a hash created off-platform with a
    // higher work factor can never be verified here and needs re-hashing.
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "stored password hash uses an unsupported iteration count; re-hash required",
        iterations,
        maxSupported: MAX_PBKDF2_ITERATIONS,
      }),
    );
    return false;
  }

  const keyMaterial = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: b64decode(saltB64),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return timingSafeEqual(b64encode(bits), hashB64);
}

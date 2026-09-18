/**
 * Evidence objects: encrypted-at-rest images with a tamper hash and a hard
 * retention deadline (SECURITY_PRIVACY.md §2/§3).
 *
 * R2 bindings have no native presigned URLs, so we mint our own short-lived
 * HMAC-signed links. Default lifetime is 60 seconds, per the security design.
 */
import { b64decode, b64encode, hmacSha256Base64, rebuffer, sha256Hex, timingSafeEqual } from "./crypto";
import { forbidden } from "./errors";

export interface SignedLink {
  url: string;
  expiresAt: number;
}

export async function signEvidenceUrl(
  baseUrl: string,
  evidenceId: string,
  organizationId: string,
  signingKey: string,
  ttlSeconds: number,
): Promise<SignedLink> {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const payload = `${evidenceId}:${organizationId}:${expiresAt}`;
  const sig = await hmacSha256Base64(signingKey, payload);
  const url = new URL(`/api/v1/evidence/${evidenceId}/content`, baseUrl);
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", sig);
  return { url: url.toString(), expiresAt };
}

export async function verifyEvidenceUrl(
  evidenceId: string,
  organizationId: string,
  exp: string | undefined,
  sig: string | undefined,
  signingKey: string,
): Promise<void> {
  if (!exp || !sig) throw forbidden("署名が不足しています");
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw forbidden("署名URLの有効期限が切れています");
  }
  const expected = await hmacSha256Base64(signingKey, `${evidenceId}:${organizationId}:${expiresAt}`);
  if (!timingSafeEqual(expected, sig)) throw forbidden("署名が一致しません");
}

/** Encrypts the image before it reaches R2 and returns the integrity hash. */
export async function putEncrypted(
  bucket: R2Bucket,
  objectKey: string,
  bytes: Uint8Array,
  encryptionKey: string,
  contentType: string,
): Promise<{ sha256: string; byteSize: number }> {
  const raw = b64decode(encryptionKey);
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, rebuffer(bytes)));

  // Layout: [12-byte IV][ciphertext]
  const stored = new Uint8Array(new ArrayBuffer(iv.length + ct.length));
  stored.set(iv, 0);
  stored.set(ct, iv.length);

  await bucket.put(objectKey, stored, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { originalContentType: contentType },
  });

  return { sha256: await sha256Hex(stored), byteSize: stored.byteLength };
}

export async function getDecrypted(
  bucket: R2Bucket,
  objectKey: string,
  encryptionKey: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;

  const stored = new Uint8Array(await object.arrayBuffer());
  const iv = rebuffer(stored.slice(0, 12));
  const ct = rebuffer(stored.slice(12));
  const raw = b64decode(encryptionKey);
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));

  return {
    bytes: pt,
    contentType: object.customMetadata?.originalContentType ?? "image/jpeg",
  };
}

/** Decodes a `data:` URL produced by canvas.toDataURL on the trainee device. */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error("invalid data URL");
  return { contentType: match[1], bytes: b64decode(match[2]) };
}

export { b64encode };

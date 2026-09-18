import { hmacSha256Base64, timingSafeEqual } from "./crypto";
import { forbidden } from "./errors";

/**
 * Per-participant join links. The token binds the link to one participant row
 * and expires with the session, so a forwarded URL cannot be used to attend as
 * somebody else or replayed after the training ends.
 */
export async function signJoinToken(
  participantId: string,
  expiresAt: number,
  signingKey: string,
): Promise<string> {
  const sig = await hmacSha256Base64(signingKey, `${participantId}:${expiresAt}`);
  return `${expiresAt}.${sig}`;
}

export async function verifyJoinToken(
  participantId: string,
  token: string,
  signingKey: string,
): Promise<void> {
  const [expStr, sig] = token.split(".");
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || !sig) throw forbidden("参加リンクが不正です");
  if (expiresAt < Date.now()) throw forbidden("参加リンクの有効期限が切れています");

  const expected = await hmacSha256Base64(signingKey, `${participantId}:${expiresAt}`);
  if (!timingSafeEqual(expected, sig)) throw forbidden("参加リンクが不正です");
}

export function buildJoinUrl(baseUrl: string, participantId: string, token: string): string {
  const url = new URL(`/join/${participantId}`, baseUrl);
  url.searchParams.set("t", token);
  return url.toString();
}

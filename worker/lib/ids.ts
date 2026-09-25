/**
 * ULIDs: lexicographically sortable, collision-resistant, and safe to expose.
 * Prefixes match the examples in API_CONTRACT.md (evt_, ses_, sp_, ...).
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let out = "";
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[t % ENCODING_LEN] + out;
    t = Math.floor(t / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  // Mask, not modulo: equivalent for a 32-character alphabet over uniform bytes
  // (256 / 32 = 8 exactly), and it does not read as biased sampling.
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[bytes[i] & (ENCODING_LEN - 1)];
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export const PREFIXES = {
  organization: "org",
  user: "usr",
  authSession: "as",
  trainee: "trn",
  enrollment: "enr",
  consent: "cns",
  session: "ses",
  participant: "sp",
  zoomMeeting: "zm",
  event: "evt",
  alert: "alr",
  review: "rev",
  evidence: "evd",
  integration: "int",
  notification: "nrl",
  audit: "aud",
  report: "rep",
  idempotency: "idm",
  webhook: "whk",
  /* Zoom Organizer Intelligence layer (additive). */
  analysisSession: "mas",
  observation: "obs",
  engagementEvent: "eng",
  identityCheck: "idv",
  meetingReport: "mrp",
} as const;

export function newId(kind: keyof typeof PREFIXES, now?: number): string {
  return `${PREFIXES[kind]}_${ulid(now)}`;
}

const ID_RE = /^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Shape check only — existence and tenancy are verified separately. */
export function isValidId(value: unknown, kind?: keyof typeof PREFIXES): boolean {
  if (typeof value !== "string" || !ID_RE.test(value)) return false;
  if (kind && !value.startsWith(`${PREFIXES[kind]}_`)) return false;
  return true;
}

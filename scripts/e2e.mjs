/**
 * End-to-end integration check against a running server.
 *
 * Proves the whole chain the product depends on:
 *   admin login → trainee + face enrollment → session linked to a Zoom meeting
 *   → signed Zoom webhook recognises the participant → trainee precheck verifies
 *   1:1 server-side → monitoring events raise a rule-confirmed alert → admin
 *   reviews it → Zoom leave marks a disconnect.
 *
 * Usage: node scripts/e2e.mjs <baseUrl> <adminEmail> <adminPassword> <webhookSecret>
 */
import { webcrypto as crypto } from "node:crypto";

const [, , BASE, EMAIL, PASSWORD, WEBHOOK_SECRET] = process.argv;
if (!BASE || !EMAIL || !PASSWORD || !WEBHOOK_SECRET) {
  console.error("usage: node scripts/e2e.mjs <baseUrl> <email> <password> <webhookSecret>");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Cookie jar. A single-slot variable is not enough: Cloudflare attaches its own
 * `__cf_bm` cookie to responses, which would otherwise overwrite the session.
 */
const jar = new Map();

function storeCookies(res) {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  for (const line of raw) {
    const [pair] = String(line).split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function call(path, { method = "GET", body, token, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) h["Content-Type"] = "application/json";
  if (method !== "GET") h["Idempotency-Key"] ??= crypto.randomUUID();
  if (token) h.Authorization = `Bearer ${token}`;
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;

  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

/* ---------- synthetic biometrics: a stable unit vector plus small noise ---- */

function unitVector(seed) {
  const v = [];
  let x = seed;
  for (let i = 0; i < 128; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v.push(x / 2147483648 - 0.5);
  }
  const norm = Math.hypot(...v);
  return v.map((n) => n / norm);
}

function jitter(vec, amount) {
  const out = vec.map((n) => n + (Math.random() - 0.5) * amount);
  const norm = Math.hypot(...out);
  return out.map((n) => n / norm);
}

const GOOD_QUALITY = {
  faceCount: 1, relativeSize: 0.18, yaw: 0.05, pitch: 0.03,
  brightness: 0.55, sharpness: 0.85, occlusion: 0.05,
};

/* ------------------------------- Zoom webhook signing (Zoom's own scheme) -- */

async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postZoomWebhook(payload, { secret = WEBHOOK_SECRET, timestamp } = {}) {
  const raw = JSON.stringify(payload);
  const ts = String(timestamp ?? Date.now());
  const signature = `v0=${await hmacHex(secret, `v0:${ts}:${raw}`)}`;
  const res = await fetch(`${BASE}/api/v1/webhooks/zoom`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zm-signature": signature,
      "x-zm-request-timestamp": ts,
    },
    body: raw,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, json };
}

/* ================================== run ================================== */

const stamp = Date.now();
const MEETING_ID = String(90000000000 + (stamp % 9000000));
const TRAINEE_EMAIL = `e2e.${stamp}@example.co.jp`;
const TRAINEE_EXT = `E2E-${stamp % 100000}`;
const TRAINEE_NAME = "検証 太郎";

section("1. 健康チェックと認証");
{
  const health = await call("/health");
  check("health returns ok", health.json?.status === "ok");
  check("zoom credentials configured", health.json?.zoom?.configured === true);
  check("webhook secret configured", health.json?.zoom?.webhookConfigured === true);
  check("encryption + signing keys present",
    health.json?.keys?.encryption === true && health.json?.keys?.signing === true);

  const bad = await call("/auth/login", { method: "POST", body: { email: EMAIL, password: "wrong-password" } });
  check("wrong password is rejected with 401", bad.status === 401, `got ${bad.status}`);

  const unauth = await call("/trainees");
  check("unauthenticated access is refused", unauth.status === 401, `got ${unauth.status}`);

  const login = await call("/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  check("admin login succeeds", login.status === 200, login.text?.slice(0, 120));
  check("login returns the user's organization", Boolean(login.json?.user?.organizationId));
  globalThis.ORG = login.json?.user?.organizationId;
}

section("2. テナント分離");
{
  const wrongOrg = await call("/trainees", { headers: { "X-Organization-Id": "org_SOMEONEELSE00000000000000" } });
  check("mismatched X-Organization-Id is forbidden", wrongOrg.status === 403, `got ${wrongOrg.status}`);
  const rightOrg = await call("/trainees", { headers: { "X-Organization-Id": globalThis.ORG } });
  check("matching X-Organization-Id is allowed", rightOrg.status === 200, `got ${rightOrg.status}`);
}

section("3. 受講者登録と顔登録");
let traineeId;
{
  const created = await call("/trainees", {
    method: "POST",
    body: { externalId: TRAINEE_EXT, name: TRAINEE_NAME, department: "検証部", email: TRAINEE_EMAIL },
  });
  check("trainee is created", created.status === 201, created.text?.slice(0, 160));
  traineeId = created.json?.trainee?.id;

  const dup = await call("/trainees", {
    method: "POST",
    body: { externalId: TRAINEE_EXT, name: "重複", email: `dup.${stamp}@example.co.jp` },
  });
  check("duplicate trainee id is rejected with 409", dup.status === 409, `got ${dup.status}`);

  const badQuality = await call(`/trainees/${traineeId}/enrollments`, {
    method: "POST",
    body: {
      descriptor: unitVector(11), engine: "faceapi-128", modelVersion: "e2e",
      quality: { ...GOOD_QUALITY, faceCount: 0, brightness: 0.05 },
      consent: { policyVersion: "2026-09-01", scope: ["face_template"] },
    },
  });
  check("poor-quality enrollment is refused (422)", badQuality.status === 422, `got ${badQuality.status}`);
  check("refusal explains why", Array.isArray(badQuality.json?.error?.reasons) && badQuality.json.error.reasons.length > 0);

  const wrongDims = await call(`/trainees/${traineeId}/enrollments`, {
    method: "POST",
    body: {
      descriptor: Array(96).fill(0.1), engine: "faceapi-128", modelVersion: "e2e",
      quality: GOOD_QUALITY, consent: { policyVersion: "2026-09-01", scope: ["face_template"] },
    },
  });
  check("wrong descriptor dimensionality is refused", wrongDims.status === 422, `got ${wrongDims.status}`);

  globalThis.TEMPLATE = unitVector(42);
  const enrolled = await call(`/trainees/${traineeId}/enrollments`, {
    method: "POST",
    body: {
      descriptor: globalThis.TEMPLATE, engine: "faceapi-128", modelVersion: "e2e-1.0",
      quality: GOOD_QUALITY,
      consent: { policyVersion: "2026-09-01", scope: ["face_template", "monitoring"] },
    },
  });
  check("good-quality enrollment succeeds", enrolled.status === 201, enrolled.text?.slice(0, 160));

  const detail = await call(`/trainees/${traineeId}`);
  check("enrollment is listed for the trainee", (detail.json?.enrollments?.length ?? 0) >= 1);
  const leaked = JSON.stringify(detail.json ?? {});
  check("template ciphertext is never returned to the client",
    !leaked.includes("template") || !/"template"\s*:\s*"[A-Za-z0-9+/=]{20,}"/.test(leaked));
}

section("4. 研修とZoom紐付け");
let sessionId;
{
  const session = await call("/sessions", {
    method: "POST",
    body: {
      title: `E2E検証研修 ${stamp}`,
      startsAt: stamp - 600_000,
      endsAt: stamp + 3 * 3600_000,
      zoomMeetingId: MEETING_ID,
    },
  });
  check("session is created", session.status === 201, session.text?.slice(0, 160));
  sessionId = session.json?.session?.id;

  const badRange = await call("/sessions", {
    method: "POST",
    body: { title: "bad", startsAt: stamp + 1000, endsAt: stamp },
  });
  check("end-before-start is rejected", badRange.status === 400, `got ${badRange.status}`);

  const assigned = await call(`/sessions/${sessionId}/participants`, {
    method: "POST",
    body: { traineeIds: [traineeId] },
  });
  check("trainee is assigned to the session", assigned.status === 201, assigned.text?.slice(0, 160));
  check("a per-participant join link is issued", Boolean(assigned.json?.links?.[0]?.joinUrl));
  globalThis.JOIN_URL = assigned.json?.links?.[0]?.joinUrl;
  globalThis.PARTICIPANT_ID = assigned.json?.links?.[0]?.participantId;

  const foreign = await call(`/sessions/${sessionId}/participants`, {
    method: "POST",
    body: { traineeIds: ["trn_NOTOURS000000000000000000"] },
  });
  check("a trainee from another tenant cannot be assigned",
    foreign.status === 201 && foreign.json?.rejected?.length === 1, JSON.stringify(foreign.json)?.slice(0, 120));

  const live = await call(`/sessions/${sessionId}`, { method: "PATCH", body: { status: "LIVE" } });
  check("session can be set LIVE", live.status === 200);
  const detail = await call(`/sessions/${sessionId}`);
  check("rule version is frozen at go-live", Boolean(detail.json?.session?.ruleVersion));
}

section("5. Zoom Webhook — 署名検証");
{
  const raw = JSON.stringify({ event: "meeting.started", payload: { object: { id: MEETING_ID } } });
  const unsigned = await fetch(`${BASE}/api/v1/webhooks/zoom`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: raw,
  });
  check("unsigned delivery is rejected (401)", unsigned.status === 401, `got ${unsigned.status}`);

  const wrongSecret = await postZoomWebhook(
    { event: "meeting.started", payload: { object: { id: MEETING_ID } } },
    { secret: "not-the-real-secret" },
  );
  check("wrong-secret signature is rejected", wrongSecret.status === 401, `got ${wrongSecret.status}`);

  const stale = await postZoomWebhook(
    { event: "meeting.started", payload: { object: { id: MEETING_ID } } },
    { timestamp: Date.now() - 20 * 60 * 1000 },
  );
  check("replayed (stale timestamp) delivery is rejected", stale.status === 401, `got ${stale.status}`);

  const plainToken = `tok${stamp}`;
  const validation = await postZoomWebhook({
    event: "endpoint.url_validation",
    payload: { plainToken },
  });
  check("url_validation handshake returns 200", validation.status === 200, `got ${validation.status}`);
  check("handshake echoes the plain token", validation.json?.plainToken === plainToken);
  check("handshake returns the expected HMAC",
    validation.json?.encryptedToken === (await hmacHex(WEBHOOK_SECRET, plainToken)));
}

section("6. Zoom Webhook — 参加者の認識");
{
  const started = await postZoomWebhook({
    event: "meeting.started",
    payload: { account_id: "e2eAccount", object: { id: MEETING_ID, uuid: `uuid-${stamp}==`, topic: "E2E" } },
  });
  check("meeting.started is accepted", started.status === 200, JSON.stringify(started.json)?.slice(0, 160));
  check("meeting.started marks the session LIVE", started.json?.status === "LIVE", JSON.stringify(started.json)?.slice(0, 160));

  // Match by email — the strongest signal.
  const joinedByEmail = await postZoomWebhook({
    event: "meeting.participant_joined",
    payload: {
      account_id: "e2eAccount",
      object: {
        id: MEETING_ID,
        uuid: `uuid-${stamp}==`,
        participant: {
          user_id: "zoomuser1", user_name: "Taro Kenshou", email: TRAINEE_EMAIL,
          participant_uuid: `puuid-email-${stamp}`, join_time: new Date().toISOString(),
        },
      },
    },
  });
  check("participant_joined is accepted", joinedByEmail.status === 200);
  check("participant is recognised as an enrolled trainee", joinedByEmail.json?.matched === true,
    JSON.stringify(joinedByEmail.json)?.slice(0, 200));
  check("match method is email", joinedByEmail.json?.method === "email", String(joinedByEmail.json?.method));

  // Duplicate delivery must be a no-op.
  const dupPayload = {
    event: "meeting.participant_joined",
    payload: {
      account_id: "e2eAccount",
      object: {
        id: MEETING_ID, uuid: `uuid-${stamp}==`,
        participant: {
          user_id: "zoomuser1", user_name: "Taro Kenshou", email: TRAINEE_EMAIL,
          participant_uuid: `puuid-email-${stamp}`, join_time: "2026-09-18T01:00:00Z",
        },
      },
    },
  };
  const first = await postZoomWebhook(dupPayload);
  const second = await postZoomWebhook(dupPayload);
  check("identical redelivery is deduplicated",
    second.json?.deduplicated === true || first.json?.deduplicated === true,
    JSON.stringify(second.json)?.slice(0, 120));

  // Match by trainee number embedded in the display name.
  const joinedById = await postZoomWebhook({
    event: "meeting.participant_joined",
    payload: {
      account_id: "e2eAccount",
      object: {
        id: MEETING_ID, uuid: `uuid-${stamp}==`,
        participant: {
          user_id: "zoomuser2", user_name: `${TRAINEE_EXT} 検証 太郎`,
          participant_uuid: `puuid-extid-${stamp}`, join_time: new Date().toISOString(),
        },
      },
    },
  });
  check("participant with no email matches on trainee number",
    joinedById.json?.matched === true && joinedById.json?.method === "external_id",
    JSON.stringify(joinedById.json)?.slice(0, 200));

  // An attendee we cannot resolve must still be recorded, not dropped.
  const unknown = await postZoomWebhook({
    event: "meeting.participant_joined",
    payload: {
      account_id: "e2eAccount",
      object: {
        id: MEETING_ID, uuid: `uuid-${stamp}==`,
        participant: {
          user_id: "zoomuser3", user_name: "Totally Unknown Guest",
          participant_uuid: `puuid-unknown-${stamp}`, join_time: new Date().toISOString(),
        },
      },
    },
  });
  check("unmatched attendee is still recorded for manual binding",
    unknown.status === 200 && unknown.json?.matched === false && Boolean(unknown.json?.participantId),
    JSON.stringify(unknown.json)?.slice(0, 200));

  const participants = await call(`/sessions/${sessionId}/participants`);
  const rows = participants.json?.participants ?? [];
  const matchedRow = rows.find((p) => p.traineeId === traineeId);
  check("the assigned trainee's row carries the Zoom identity",
    Boolean(matchedRow?.zoomDisplayName) && Boolean(matchedRow?.zoomJoinedAt),
    JSON.stringify(matchedRow)?.slice(0, 220));
  check("an unmatched Zoom attendee appears with no trainee",
    rows.some((p) => !p.traineeId && p.zoomDisplayName === "Totally Unknown Guest"));

  // Manual binding of the unmatched attendee.
  const unmatchedRow = rows.find((p) => !p.traineeId);
  if (unmatchedRow) {
    const others = await call("/trainees");
    const other = (others.json?.trainees ?? []).find((t) => t.id !== traineeId);
    if (other) {
      const bound = await call(`/sessions/${sessionId}/participants/${unmatchedRow.id}/bind`, {
        method: "POST", body: { traineeId: other.id },
      });
      check("admin can manually bind an unmatched attendee", bound.status === 200, bound.text?.slice(0, 140));
    }
  }
}

section("7. 受講者フロー（同意 → 本人確認）");
let deviceToken;
{
  // Mismatch, poor quality and failed liveness all consume the same retry
  // budget by design, so raise it before exercising each negative path.
  const raised = await call("/settings/monitoring", {
    method: "PUT",
    body: {
      reauthIntervalSec: 60, matchThreshold: 0.82, absenceSec: 60, eyesClosedSec: 10,
      multiFaceFrames: 15, evidenceIntervalSec: 300, evidenceRetentionDays: 30,
      precheckMaxAttempts: 8, livenessRequired: true, imageQuality: 0.72,
    },
  });
  check("admin can raise the precheck attempt limit", raised.status === 200, raised.text?.slice(0, 140));
  if (!globalThis.JOIN_URL) {
    check("a join link was issued in section 4", false, "cannot continue trainee flow");
    console.log(`\n${"=".repeat(60)}\n結果: ${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
    process.exit(1);
  }
  const url = new URL(globalThis.JOIN_URL);
  const token = url.searchParams.get("t");
  const participantId = globalThis.PARTICIPANT_ID;

  const noToken = await fetch(`${BASE}/api/v1/trainee/session/${participantId}`);
  check("join without a token is refused", noToken.status === 403, `got ${noToken.status}`);

  const forged = await fetch(`${BASE}/api/v1/trainee/session/${participantId}?t=9999999999999.abcdef`);
  check("forged join token is refused", forged.status === 403, `got ${forged.status}`);

  const info = await fetch(`${BASE}/api/v1/trainee/session/${participantId}?t=${encodeURIComponent(token)}`);
  const infoJson = await info.json();
  check("valid join token returns session info", info.status === 200, JSON.stringify(infoJson)?.slice(0, 160));
  check("trainee is reported as enrolled", infoJson?.enrolled === true);
  check("join payload does not leak the stored template",
    !JSON.stringify(infoJson).includes("template"));

  // Precheck before consent must be refused.
  const beforeConsent = await fetch(`${BASE}/api/v1/trainee/session/${participantId}/precheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token, descriptor: globalThis.TEMPLATE, engine: "faceapi-128", modelVersion: "e2e-1.0",
      quality: GOOD_QUALITY, liveness: { passed: true, blinks: 2, motionScore: 0.5 },
    }),
  });
  check("precheck without recorded consent is refused (403)", beforeConsent.status === 403,
    `got ${beforeConsent.status}`);

  const consent = await fetch(`${BASE}/api/v1/trainee/session/${participantId}/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token, policyVersion: "2026-09-01",
      scope: ["camera", "face_template", "monitoring", "evidence_images"], granted: true,
    }),
  });
  check("consent is recorded", consent.status === 200);

  // A different person's face must fail the 1:1 comparison.
  const impostor = await fetch(`${BASE}/api/v1/trainee/session/${participantId}/precheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token, descriptor: unitVector(9999), engine: "faceapi-128", modelVersion: "e2e-1.0",
      quality: GOOD_QUALITY, liveness: { passed: true, blinks: 2, motionScore: 0.5 },
    }),
  });
  const impostorJson = await impostor.json();
  check("a different face fails 1:1 verification", impostorJson?.result === "MISMATCH",
    JSON.stringify(impostorJson)?.slice(0, 160));
  check("no device token is issued on mismatch", !impostorJson?.deviceToken);

  // Liveness failure must be refused when liveness is required.
  const noLiveness = await fetch(`${BASE}/api/v1/trainee/session/${participantId}/precheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token, descriptor: globalThis.TEMPLATE, engine: "faceapi-128", modelVersion: "e2e-1.0",
      quality: GOOD_QUALITY, liveness: { passed: false, blinks: 0, motionScore: 0.001 },
    }),
  });
  const noLivenessJson = await noLiveness.json();
  check("failed liveness blocks verification", noLivenessJson?.result === "LIVENESS_FAILED",
    JSON.stringify(noLivenessJson)?.slice(0, 160));

  // The genuine person, with realistic frame-to-frame variation.
  const real = await fetch(`${BASE}/api/v1/trainee/session/${participantId}/precheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token, descriptor: jitter(globalThis.TEMPLATE, 0.05), engine: "faceapi-128",
      modelVersion: "e2e-1.0", quality: GOOD_QUALITY,
      liveness: { passed: true, blinks: 2, motionScore: 0.5 },
    }),
  });
  const realJson = await real.json();
  check("the enrolled person passes 1:1 verification", realJson?.result === "VERIFIED",
    JSON.stringify(realJson)?.slice(0, 160));
  check("a device token is issued on success", Boolean(realJson?.deviceToken));
  check("match score is above the threshold",
    (realJson?.matchScore ?? 0) >= (realJson?.threshold ?? 1),
    `score=${realJson?.matchScore} threshold=${realJson?.threshold}`);
  deviceToken = realJson?.deviceToken;
}

section("8. 継続監視とアラート");
{
  const badToken = await call("/trainee/events", {
    method: "POST", token: "not-a-real-device-token",
    body: { events: [{ eventId: `evt_${stamp}A`, type: "HEARTBEAT", capturedAt: Date.now() }] },
  });
  check("events with an invalid device token are refused", badToken.status === 401, `got ${badToken.status}`);

  // Below threshold → warning only, no alert.
  const short = await call("/trainee/events", {
    method: "POST", token: deviceToken,
    body: { events: [{ eventId: `evt_${stamp}B`, type: "FACE_ABSENT", capturedAt: Date.now(), durationMs: 5000 }] },
  });
  check("short absence is accepted", short.json?.accepted === 1, JSON.stringify(short.json)?.slice(0, 140));

  // Over threshold → alert.
  const long = await call("/trainee/events", {
    method: "POST", token: deviceToken,
    body: {
      events: [{
        eventId: `evt_${stamp}C`, type: "FACE_ABSENT", capturedAt: Date.now(),
        durationMs: 95_000, faceCount: 0, severity: "INFO", modelVersion: "e2e-1.0",
      }],
    },
  });
  check("sustained absence is accepted", long.json?.accepted === 1);

  const multi = await call("/trainee/events", {
    method: "POST", token: deviceToken,
    body: {
      events: [{
        eventId: `evt_${stamp}D`, type: "MULTIPLE_FACES", capturedAt: Date.now(),
        faceCount: 2, frameCount: 40, modelVersion: "e2e-1.0",
      }],
    },
  });
  check("sustained multi-person detection is accepted", multi.json?.accepted === 1);

  const replay = await call("/trainee/events", {
    method: "POST", token: deviceToken,
    body: { events: [{ eventId: `evt_${stamp}C`, type: "FACE_ABSENT", capturedAt: Date.now(), durationMs: 95_000 }] },
  });
  check("a replayed eventId is not double-counted",
    replay.json?.accepted === 0 && replay.json?.rejected?.length === 1,
    JSON.stringify(replay.json)?.slice(0, 140));

  const future = await call("/trainee/events", {
    method: "POST", token: deviceToken,
    body: { events: [{ eventId: `evt_${stamp}E`, type: "HEARTBEAT", capturedAt: Date.now() + 3600_000 }] },
  });
  check("a future-dated event is rejected", future.json?.rejected?.length === 1);

  // Continuous re-authentication, compared server side.
  const reauth = await call("/trainee/reauth", {
    method: "POST", token: deviceToken,
    body: {
      descriptor: jitter(globalThis.TEMPLATE, 0.05), engine: "faceapi-128",
      modelVersion: "e2e-1.0", qualityScore: 0.8,
    },
  });
  check("continuous re-auth succeeds for the enrolled person",
    reauth.json?.passed === true, JSON.stringify(reauth.json)?.slice(0, 140));

  const reauthImpostor = await call("/trainee/reauth", {
    method: "POST", token: deviceToken,
    body: { descriptor: unitVector(777), engine: "faceapi-128", modelVersion: "e2e-1.0", qualityScore: 0.8 },
  });
  check("continuous re-auth fails for a different face", reauthImpostor.json?.passed === false);

  const monitor = await call(`/sessions/${sessionId}/monitor`);
  check("monitor endpoint returns session state", monitor.status === 200);
  check("monitor reports open alerts", (monitor.json?.alerts?.length ?? 0) >= 2,
    `alerts=${monitor.json?.alerts?.length}`);
  const types = (monitor.json?.alerts ?? []).map((a) => a.type);
  check("an absence alert was raised by the server's own rules", types.includes("離席"), types.join(","));
  check("a multi-person alert was raised", types.includes("複数人"), types.join(","));
  check("metrics are computed", typeof monitor.json?.metrics?.total === "number");

  const events = await call(`/sessions/${sessionId}/events`);
  const evs = events.json?.events ?? [];
  check("events are searchable", evs.length >= 4, `count=${evs.length}`);
  check("events retain model and rule versions",
    evs.some((e) => e.modelVersion && e.ruleVersion));
  check("server re-evaluation is recorded when the client over/under-claims",
    evs.some((e) => e.serverAdjusted === true));

  globalThis.ALERT_ID = (monitor.json?.alerts ?? [])[0]?.id;
}

section("9. 管理者レビューと監査");
{
  const reviewed = await call(`/alerts/${globalThis.ALERT_ID}`, {
    method: "PATCH",
    body: { action: "FALSE_POSITIVE", reasonCode: "LIGHTING", comment: "E2E検証" },
  });
  check("an alert can be marked a false positive", reviewed.status === 200, reviewed.text?.slice(0, 140));
  check("state transitions to FALSE_POSITIVE", reviewed.json?.state === "FALSE_POSITIVE");

  const reviews = await call(`/alerts/${globalThis.ALERT_ID}/reviews`);
  check("the review is recorded with its reason",
    (reviews.json?.reviews ?? []).some((r) => r.reasonCode === "LIGHTING"));

  const audit = await call("/audit", { headers: {} });
  const logs = audit.json?.logs ?? [];
  check("audit log is readable", audit.status === 200 && logs.length > 0, `count=${logs.length}`);
  check("precheck decisions are audited", logs.some((l) => l.action?.startsWith("precheck.")));
  check("Zoom participant recognition is audited", logs.some((l) => l.action === "zoom.participant_joined"));
  check("consent is audited", logs.some((l) => l.action === "consent.granted"));

  const auditBlob = JSON.stringify(logs);
  check("audit log contains no descriptors, image keys or tokens",
    !/"template"|"descriptor"|"objectKey"|"accessToken"|"signedUrl"/.test(auditBlob));
}

section("10. レポート出力");
{
  const report = await call("/reports", { method: "POST", body: { kind: "ATTENDANCE_CSV", sessionId } });
  check("attendance report is generated", report.status === 201, report.text?.slice(0, 140));
  check("report has rows", (report.json?.report?.rowCount ?? 0) >= 1);

  const events = await call("/reports", { method: "POST", body: { kind: "EVENTS_CSV", sessionId } });
  check("events report is generated", events.status === 201);

  const content = await fetch(`${BASE}/api/v1/reports/${report.json.report.id}/content`, {
    headers: { Cookie: cookieHeader() },
  });
  const bytes = new Uint8Array(await content.arrayBuffer());
  const csv = new TextDecoder("utf-8").decode(bytes);
  check("report downloads as CSV", content.status === 200 && csv.includes("研修"), csv.slice(0, 80));
  // Checked on the raw bytes: TextDecoder strips the BOM when decoding.
  check("CSV is byte-prefixed with a UTF-8 BOM for Excel",
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    `first bytes ${bytes[0]},${bytes[1]},${bytes[2]}`);
  check("CSV does not contain evidence object keys", !csv.includes(".bin"));
}

section("11. 冪等性");
{
  const key = crypto.randomUUID();
  const body = { externalId: `IDEM-${stamp}`, name: "冪等 検証" };
  const first = await call("/trainees", { method: "POST", body, headers: { "Idempotency-Key": key } });
  const second = await call("/trainees", { method: "POST", body, headers: { "Idempotency-Key": key } });
  check("first request creates the record", first.status === 201);
  check("replay with the same key returns the same result, not a duplicate",
    second.status === 201 && second.json?.trainee?.id === first.json?.trainee?.id,
    `first=${first.json?.trainee?.id} second=${second.json?.trainee?.id}`);
  check("replay is flagged in the response headers",
    second.headers.get("idempotency-replayed") === "true");

  const conflicting = await call("/trainees", {
    method: "POST",
    body: { externalId: `IDEM-OTHER-${stamp}`, name: "別内容" },
    headers: { "Idempotency-Key": key },
  });
  check("the same key with a different body is a conflict", conflicting.status === 409, `got ${conflicting.status}`);
}

section("12. Zoom退出とセッション終了");
{
  // Zoom sends the same participant fields on leave as on join, so the identity
  // is resolvable the same way.
  const left = await postZoomWebhook({
    event: "meeting.participant_left",
    payload: {
      account_id: "e2eAccount",
      object: {
        id: MEETING_ID, uuid: `uuid-${stamp}==`,
        participant: {
          user_id: "zoomuser1", user_name: "Taro Kenshou", email: TRAINEE_EMAIL,
          participant_uuid: `puuid-email-${stamp}`, leave_time: new Date().toISOString(),
        },
      },
    },
  });
  check("participant_left is accepted", left.status === 200, JSON.stringify(left.json)?.slice(0, 160));
  check("leaving Zoom marks the participant disconnected", left.json?.status === "DISCONNECTED",
    JSON.stringify(left.json)?.slice(0, 160));

  // A leave for somebody who was never in this session must not guess.
  const strayLeave = await postZoomWebhook({
    event: "meeting.participant_left",
    payload: {
      account_id: "e2eAccount",
      object: {
        id: MEETING_ID, uuid: `uuid-${stamp}==`,
        participant: {
          user_id: "zzz", user_name: "Nobody At All",
          participant_uuid: `puuid-stray-${stamp}`, leave_time: new Date().toISOString(),
        },
      },
    },
  });
  check("a leave for an unknown attendee is ignored rather than mis-assigned",
    strayLeave.status === 200 && strayLeave.json?.status !== "DISCONNECTED",
    JSON.stringify(strayLeave.json)?.slice(0, 160));

  const ended = await postZoomWebhook({
    event: "meeting.ended",
    payload: { account_id: "e2eAccount", object: { id: MEETING_ID, uuid: `uuid-${stamp}==` } },
  });
  check("meeting.ended completes the session", ended.json?.status === "COMPLETED",
    JSON.stringify(ended.json)?.slice(0, 160));
}

section("13. 権限分離（監査担当者は読み取り専用）");
{
  jar.delete("zoomer_session");
  const auditorLogin = await call("/auth/login", {
    method: "POST", body: { email: EMAIL.replace("admin@", "auditor@"), password: PASSWORD },
  });
  if (auditorLogin.status === 200) {
    const write = await call("/trainees", {
      method: "POST", body: { externalId: `NOPE-${stamp}`, name: "権限検証" },
    });
    check("auditor cannot create trainees (403)", write.status === 403, `got ${write.status}`);
    const read = await call("/trainees");
    check("auditor can read trainees", read.status === 200, `got ${read.status}`);
    const settings = await call("/settings/monitoring", {
      method: "PUT",
      body: {
        reauthIntervalSec: 60, matchThreshold: 0.9, absenceSec: 60, eyesClosedSec: 10,
        multiFaceFrames: 15, evidenceIntervalSec: 300, evidenceRetentionDays: 30,
        precheckMaxAttempts: 3, livenessRequired: true, imageQuality: 0.72,
      },
    });
    check("auditor cannot change detection rules (403)", settings.status === 403, `got ${settings.status}`);
  } else {
    check("auditor account exists for permission testing", false, `login status ${auditorLogin.status}`);
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`結果: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n失敗した検証:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log("=".repeat(60));
process.exit(fail === 0 ? 0 : 1);

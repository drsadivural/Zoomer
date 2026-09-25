# Zoomer Meeting Bot (Zoom Meeting SDK, Linux)

A headless C++ bot that joins a Zoom meeting, pulls **each participant's raw
video**, analyses every participant (face presence, count, head pose, eye
closure, identity) and POSTs the results to the Zoomer backend, which drives the
organizer's 参加者 and ライブ監視 screens, the event engine, alerts and evidence.

```
                     ┌─ GET  /api/v1/bot/assignments  ── which meetings are live
Zoomer backend ──────┤
                     └─ POST /api/v1/bot/observe      ── per-participant state + tiles

Zoom meeting ─(Meeting SDK raw video, per participant)─► zoomer-bot
   zoomer-bot ─(TCP JSON :9102)─► analyzer.py ─┬─ MediaPipe: landmarks, EAR, pose
                                               └─(TCP JSON :9101)─► UXE engine: identity
```

## How it decides what to join

**Assignment mode (default).** The bot polls `GET /api/v1/bot/assignments`. The
backend looks at every tenant with a connected Zoom account, asks Zoom which of
their meetings are live, creates the training session if one does not exist, and
hands back the meeting number, its passcode, and that tenant's monitoring
cadence. The bot needs no per-customer configuration and no Zoom API
credentials of its own.

The inversion is deliberate: the backend runs on Cloudflare Workers and has no
process to spawn, so the bot asks for work rather than being launched.

**Pinned mode.** Set `ZOOM_MEETING_NUMBER` (and `ZOOMER_ORGANIZATION_ID`, since
nothing else identifies the tenant) and the bot stays on that one meeting. This
is how it is tested, and how it runs for a tenant that has not completed OAuth.

## Status

| Piece | State |
|---|---|
| SDK init, JWT auth, glib main loop | **working** — verified to the point of `SDKAuth` returning `AUTHRET_KEYORSECRETWRONG` with a placeholder key |
| Join / leave, participant + video + audio callbacks | **written against the 7.1.5 headers, compiles and links** |
| Raw video subscribe → frame copy → analysis | **written**; needs raw-data approval to produce a frame |
| analyzer.py (MediaPipe + UXE) | **working and measured** — see below |
| `/bot/observe` contract | **verified end to end** with real photographs through the real analyzer (`tests/bot-observation.test.ts`, and the organizer screens driven in a browser) |

**What is not proven:** the bot has never joined a real meeting, because Zoom
gates that behind a Meeting SDK Key/Secret and raw-data (local recording)
approval. Everything downstream of "a frame arrived" is exercised; the frame
itself is not.

## Prerequisites

1. **Meeting SDK app** in Zoom Marketplace → **SDK Key + Secret** (not the OAuth
   app used for `/integrations/zoom`).
2. **Raw data / local recording** approved for the account. Without it
   `createRenderer` fails per participant and the bot logs it explicitly.
3. **UXE engine**: `python server.py --mode json --port 9101`
4. **Analyzer**: `python3 analyzer/analyzer.py --port 9102` (needs `mediapipe`,
   `opencv-python-headless`, `numpy`; the FaceLandmarker model is taken from the
   web client's own `public/mediapipe/face_landmarker.task`, so the bot and the
   browser measure eye closure on identical landmark topology).
5. **`BOT_INGEST_TOKEN`** — the shared secret set on the backend.
6. Build deps: `sudo apt install -y build-essential cmake libssl-dev
   libcurl4-openssl-dev nlohmann-json3-dev libturbojpeg0-dev libglib2.0-dev`
7. The extracted Meeting SDK at `/home/ubuntu/zoom-meeting-sdk`.

## Build  ✅ compiles and links against Meeting SDK 7.1.5

```bash
# The SDK ships libmeetingsdk.so but its SONAME is libmeetingsdk.so.1 — symlink it once:
ln -sf libmeetingsdk.so /home/ubuntu/zoom-meeting-sdk/libmeetingsdk.so.1
cd zoom-bot && cmake -B build -DZOOM_SDK_DIR=/home/ubuntu/zoom-meeting-sdk && cmake --build build -j
```

## Run

```bash
# 1. identity engine
/home/ubuntu/uxe-venv/bin/python /home/ubuntu/uxe_port_v1/server.py --mode json --port 9101 &
# 2. landmark/pose/eye analyzer
/home/ubuntu/uxe-venv/bin/python analyzer/analyzer.py --port 9102 &
# 3. the bot itself
set -a; . ./config.env; set +a
LD_LIBRARY_PATH=/home/ubuntu/zoom-meeting-sdk:/home/ubuntu/zoom-meeting-sdk/qt_libs \
  xvfb-run -a ./build/zoomer-bot
```

The Meeting SDK needs an X display even headless, hence `xvfb-run`.

## Threading

Three threads, and the split matters:

* the **glib main loop** delivers every SDK callback. Callbacks only copy a
  frame or flip a flag — never analyse, never do I/O. Blocking here stalls video
  for the whole meeting.
* the **analysis thread** samples each participant on the configured interval,
  encodes, calls the analyzer and POSTs. All the expensive work lives here.
* the **assignment thread** polls the backend and marshals join/leave back onto
  the glib thread with `g_idle_add`, because the SDK is not thread-safe.

## Live tiles, and what is deliberately *not* sent

The console shows Ayonix Zoomer's own analysed still for each participant, at
`SNAPSHOT_INTERVAL_SEC` (default 30s) and only when the tenant has enabled
snapshots. The participant's Zoom video stream is never duplicated or relayed to
the browser — the product requirement is a periodic analysed thumbnail, not a
second video pipeline, and the backend enforces a 5-second floor regardless of
what a provider sends.

## Measurements worth keeping

* **Eye closure** (MediaPipe 478-point eyelid contour, EAR): open eyes measured
  0.250–0.263, closed 0.051. `EAR_CLOSED = 0.18` sits in the gap. The bot never
  decides someone is asleep — it reports the closure and the backend's
  `eyesClosedSec` rule turns a sustained one into a *suspicion*.
* **Head pose**: the generic 3D model is expressed Y-down/Z-forward to match
  image coordinates. The usual Y-up form leaves a 180° term in the result; all
  four sign combinations were measured and are tabulated in `analyzer.py`.
  Signs match `worker/services/gaze/head-pose.ts`, verified by mirroring a
  portrait and confirming yaw and roll invert while pitch does not.
* **Identity** comes from UXE `identify`, which returns `candidates` — not
  `matches`, which an earlier draft of this bot read and would have silently
  found nobody.

## Requirement coverage

| Requirement | Where |
|---|---|
| ① Pre-training 1:1 verification | first analysed frame → UXE identify → `identityStatus` |
| ② Continuous re-auth | re-identify every `REAUTH_INTERVAL_SEC` |
| ③ Absence (離席) | `faceDetected: false` → backend `FACE_NOT_VISIBLE` → `LONG_ABSENCE` |
| ④ Multiple / other person | `faceCount > 1` → `MULTIPLE_FACES`; identity mismatch → `MISMATCH` |
| ⑤ Admin alerts | backend event engine → ライブ監視 alert inbox |
| ⑥ Evidence | snapshot attached to the opening event, and reused as the live tile |
| ⑦ Drowsiness | MediaPipe EAR → `eyeClosed` → backend `DROWSINESS_SUSPECTED` (WARNING) |
| ⑧ Camera off | `RawDataStatus` + `onUserVideoStatusChange` → `cameraOn: false` |

# Zoomer Meeting Bot (Zoom Meeting SDK, Linux)

A headless C++ bot that joins a Zoom training meeting, pulls **each participant's
raw video** via the Meeting SDK, runs the **UXE face engine** (detect + 1:N
identify), applies the monitoring rules per participant, and POSTs the results to
the Zoomer backend, which raises alerts / stores evidence / drives the admin
ライブ監視 dashboard (via `POST /api/v1/bot/ingest`, already built and tested).

```
Zoom meeting ─(Meeting SDK raw video, per participant)─► bot
      bot ─(TCP JSON: identify/compare)─► UXE engine (server.py, :9101)
      bot ─(HTTPS: /api/v1/bot/ingest, Bearer BOT_INGEST_TOKEN)─► Zoomer backend
```

## Status
This is a **scaffold**. The non-SDK pieces are complete and usable
(`jwt.hpp`, `engine_client.hpp`, `ingest_client.hpp`, `config.hpp`); the SDK glue
in `main.cpp` / `video_delegate.hpp` uses the confirmed 7.1.5 interfaces
(`InitSDK`, `IAuthService::SDKAuth`, `IMeetingService::Join`, `createRenderer` +
`IZoomSDKRendererDelegate::onRawDataFrameReceived(YUVRawDataI420*)`). It cannot
join a meeting until you supply Meeting-SDK credentials and raw-data access
(see Prerequisites) — the two things Zoom gates.

## Prerequisites
1. **Meeting SDK app** in Zoom Marketplace → **SDK Key + Secret** (not the OAuth app).
2. **Raw-data / local-recording** enabled for the bot on the account (Zoom
   requires app review before raw video is allowed in production).
3. The **UXE engine** running: `python server.py --mode json --port 9101` (done).
4. **`BOT_INGEST_TOKEN`** — the shared secret set on the Zoomer backend; the bot
   sends it as a Bearer token to `/api/v1/bot/ingest`.
5. Build deps: `sudo apt install -y build-essential cmake libssl-dev libcurl4-openssl-dev libjpeg-turbo8-dev`
6. The extracted Meeting SDK at `/home/ubuntu/zoom-meeting-sdk` (headers in `h/`,
   `libmeetingsdk.so`, bundled `qt_libs`).

## Build  ✅ verified: compiles + links against Meeting SDK 7.1.5 on this VM
```bash
# The SDK ships libmeetingsdk.so but its SONAME is libmeetingsdk.so.1 — symlink it once:
ln -sf libmeetingsdk.so /home/ubuntu/zoom-meeting-sdk/libmeetingsdk.so.1
cd zoom-bot && cmake -B build -DZOOM_SDK_DIR=/home/ubuntu/zoom-meeting-sdk && cmake --build build -j
```
The binary runs to its config check today (`env -i ./build/zoomer-bot` → "missing config").
It will join a meeting once ZOOM_SDK_KEY/SECRET + raw-data access are provided.

## Run
```bash
cp config.example.json config.json   # fill in the values (or use env vars)
LD_LIBRARY_PATH=/home/ubuntu/zoom-meeting-sdk:/home/ubuntu/zoom-meeting-sdk/qt_libs \
  ./build/zoomer-bot --config config.json
```
Headless hosts usually also need a virtual display for the SDK to initialize:
`xvfb-run -a ./build/zoomer-bot --config config.json`.

## How each customer requirement is met
| Requirement | Where |
|---|---|
| ① Pre-training 1:1 verification | first clean frame → engine `identify`/`compare` → `MATCH_OK/FAIL` |
| ② Continuous re-auth | re-identify every `reauth_interval_sec` |
| ③ Absence (離席) | no face in a participant's frames / video off → `FACE_ABSENT` |
| ④ Multiple / other person | >1 face in a tile, or identify ≠ enrolled → `MULTIPLE_FACES` |
| ⑤ Admin alerts | backend rule engine → alerts on ライブ監視 (already built) |
| ⑥ Evidence (periodic + on anomaly) | JPEG of the frame in the event's `evidence` |
| ⑦ Drowsiness | eye state from the engine / MediaPipe → `EYES_CLOSED` |

## What's intentionally left as integration points (marked `// TODO(sdk)`)
- Exact `InitParam` / `JoinParam4WithoutLogin` field names can vary by SDK point
  release — verify against `h/` when you build.
- I420→JPEG uses libjpeg-turbo (`yuv_jpeg.hpp`); swap for OpenCV if you prefer.
- Per-participant re-auth cadence and frame stride live in `config.json`.

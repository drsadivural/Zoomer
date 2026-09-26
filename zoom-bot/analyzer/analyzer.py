#!/usr/bin/env python3
"""
Face analysis sidecar for the Zoomer Meeting-SDK bot.

The bot receives one raw video stream per Zoom participant and needs, for each
sampled frame, everything `POST /api/v1/bot/observe` expects: how many faces are
present, where the primary face is, which way the head is turned, whether the
eyes are closed, and which enrolled trainee it is.

No single component provides all of that:

  * The **UXE engine** (`server.py --mode json`, already running on :9101) does
    identity — 1:N identify against the enrolled gallery — and its SCRFD
    detector gives a box plus five keypoints. Five keypoints locate the eyes
    but do not describe the eyelids, so they cannot tell an open eye from a
    closed one.
  * **MediaPipe FaceLandmarker** gives 478 landmarks including the full eyelid
    contour, which is what an eye-aspect-ratio needs, plus a usable head pose.

So this process runs MediaPipe itself and delegates identity to UXE over the
same TCP-JSON protocol the bot would have used. The bot then makes exactly one
call per sampled frame instead of three, which matters when a 30-person meeting
is being sampled every few seconds.

Protocol (one JSON object per line, same shape as the UXE server):

    -> {"op":"analyze", "image_b64":"...", "identify":true, "top_k":3}
    -> {"op":"eyes",    "image_b64":"..."}   # landmarks-only, for blink sampling
    <- {"ok":true, "faceCount":2, "primary":{...}, "identity":{...}}

Run:
    python3 analyzer.py --host 127.0.0.1 --port 9102 \
        --engine-host 127.0.0.1 --engine-port 9101
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import socket
import socketserver
import sys
import threading
import time

import cv2
import numpy as np

# The web client already ships this exact model under `public/mediapipe`, so the
# bot and the browser run identical landmark topology — an EAR measured by one
# means the same thing as an EAR measured by the other.
DEFAULT_MODEL = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "mediapipe",
    "face_landmarker.task",
)

# --------------------------------------------------------------------------- #
# MediaPipe face landmarks
# --------------------------------------------------------------------------- #

# Eyelid contours in the 478-point FaceMesh topology. Each list is
# [outer_corner, upper1, upper2, inner_corner, lower2, lower1] so the classic
# six-point eye-aspect-ratio applies unchanged.
LEFT_EYE = [33, 160, 158, 133, 153, 144]
RIGHT_EYE = [362, 385, 387, 263, 373, 380]

# Landmarks used for the head-pose solve, paired with a generic 3D face model.
POSE_LANDMARKS = [1, 152, 33, 263, 61, 291]  # nose, chin, eye corners, mouth corners

# Generic 3D face model, in the SAME handedness as image pixels: X right,
# Y DOWN, Z toward the camera.
#
# The published form of this model is usually Y-up/Z-back. Feeding that to
# solvePnP against pixel coordinates leaves a 180-degree term in the result, and
# flipping only Y turns the model into a reflection rather than a rotation,
# which just moves the 180 from one axis to another. Measured on two frontal
# portraits, all four sign combinations give:
#
#     model       pitch      yaw     roll
#     Y-up Z-back -169.08    6.87    -0.27     <- 180 in pitch
#     Y-dn Z-back  -10.92   -6.87   179.73     <- 180 in roll
#     Y-dn Z-fwd    10.92    6.87    -0.27     <- correct
#     Y-up Z-fwd   169.08   -6.87   179.73
#
# so both axes are flipped together.
POSE_MODEL = np.array(
    [
        (0.0, 0.0, 0.0),           # nose tip
        (0.0, 63.6, 12.5),         # chin
        (-43.3, -32.7, 26.0),      # left eye outer corner
        (43.3, -32.7, 26.0),       # right eye outer corner
        (-28.9, 28.9, 24.1),       # left mouth corner
        (28.9, 28.9, 24.1),        # right mouth corner
    ],
    dtype=np.float64,
)

# An EAR below this is treated as a closed eye. MediaPipe's eyelid contour puts
# an open eye around 0.28-0.35 and a shut one below 0.15, so 0.18 sits in the
# gap rather than on either population. The *duration* rule that turns closure
# into a drowsiness suspicion lives server-side (`eyesClosedSec`), deliberately:
# a single closed frame is a blink, and only the backend knows the tenant's
# threshold.
EAR_CLOSED = 0.18

# Sharpness is the variance of the Laplacian over the face crop, which is the
# standard no-reference blur estimate. The raw variance is unbounded and scales
# with contrast, so it is squashed to 0..1 against a reference value measured on
# this project's own enrolment photographs. It is reported so the console can
# say "this reading is unreliable" — a blurred frame produces confident-looking
# pose and eye numbers that mean nothing.
#
# Measured on a test portrait under increasing Gaussian blur, with this
# reference: sharp 1.00 (clipped), k=3 0.30, k=5 0.14, k=9 0.05, k=25 0.01. The
# scale therefore saturates at the top, which is deliberate — the signal only
# has to separate "usable" from "do not trust this reading", and the UI's
# unreliable threshold of 0.25 falls between the k=3 and k=5 cases above.
SHARPNESS_REFERENCE = 400.0


def sharpness_score(gray_crop: np.ndarray) -> float:
    """0..1 no-reference sharpness of a face crop."""
    if gray_crop.size == 0:
        return 0.0
    variance = float(cv2.Laplacian(gray_crop, cv2.CV_64F).var())
    return round(min(1.0, variance / SHARPNESS_REFERENCE), 4)


def eye_aspect_ratio(points: np.ndarray) -> float:
    """EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)."""
    horizontal = np.linalg.norm(points[0] - points[3])
    if horizontal < 1e-6:
        return 1.0
    a = np.linalg.norm(points[1] - points[5])
    b = np.linalg.norm(points[2] - points[4])
    return float((a + b) / (2.0 * horizontal))


class Landmarker:
    """Lazily-initialised MediaPipe FaceLandmarker, one per worker thread.

    The task object is not documented as thread-safe and the bot analyses
    several participants concurrently, so each thread gets its own.
    """

    _local = threading.local()

    def __init__(self, model_path: str, max_faces: int):
        self.model_path = model_path
        self.max_faces = max_faces

    def get(self):
        existing = getattr(self._local, "landmarker", None)
        if existing is not None:
            return existing
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        options = mp_vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=self.model_path),
            running_mode=mp_vision.RunningMode.IMAGE,
            num_faces=self.max_faces,
            # Off: we derive pose from landmarks, and the blendshape graph
            # roughly doubles per-frame cost for no gain here.
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
        )
        self._local.landmarker = mp_vision.FaceLandmarker.create_from_options(options)
        return self._local.landmarker


def head_pose(points_px: np.ndarray, width: int, height: int) -> dict:
    """Yaw/pitch/roll in degrees from a PnP solve against a generic face model.

    Sign convention matches `worker/services/gaze/head-pose.ts`, which the whole
    product is graded against:
        yaw   > 0  turned toward the participant's own RIGHT
        pitch > 0  head tilted UP
        roll  > 0  head tilted toward their own right shoulder
    Verified by mirroring a portrait and confirming yaw and roll invert while
    pitch does not.
    """
    focal = float(width)
    camera = np.array(
        [[focal, 0, width / 2.0], [0, focal, height / 2.0], [0, 0, 1]], dtype=np.float64
    )
    ok, rvec, _ = cv2.solvePnP(
        POSE_MODEL,
        points_px.astype(np.float64),
        camera,
        np.zeros((4, 1)),
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    if not ok:
        return {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}

    rmat, _ = cv2.Rodrigues(rvec)
    # Standard Tait-Bryan decomposition: X = pitch, Y = yaw, Z = roll.
    sy = math.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
    if sy > 1e-6:
        pitch = math.degrees(math.atan2(rmat[2, 1], rmat[2, 2]))
        yaw = math.degrees(math.atan2(-rmat[2, 0], sy))
        roll = math.degrees(math.atan2(rmat[1, 0], rmat[0, 0]))
    else:  # gimbal lock: roll and pitch are no longer separable
        pitch = math.degrees(math.atan2(-rmat[1, 2], rmat[1, 1]))
        yaw = math.degrees(math.atan2(-rmat[2, 0], sy))
        roll = 0.0

    # The solve yields pitch positive when the head is DOWN (Y grows downward);
    # the product's convention is positive UP.
    return {
        "yaw": round(wrap180(yaw), 2),
        "pitch": round(wrap180(-pitch), 2),
        "roll": round(wrap180(roll), 2),
    }


def wrap180(deg: float) -> float:
    """Fold an angle into [-180, 180)."""
    return (deg + 180.0) % 360.0 - 180.0


# --------------------------------------------------------------------------- #
# UXE engine client (identity only)
# --------------------------------------------------------------------------- #

class EngineClient:
    """Line-delimited JSON client for the UXE engine."""

    def __init__(self, host: str, port: int, timeout: float = 10.0):
        self.host, self.port, self.timeout = host, port, timeout

    def identify(self, image_b64: str, top_k: int = 3) -> dict:
        return self._call({"op": "identify", "image_b64": image_b64, "top_k": top_k})

    def _call(self, req: dict) -> dict:
        try:
            with socket.create_connection((self.host, self.port), self.timeout) as s:
                s.settimeout(self.timeout)
                s.sendall((json.dumps(req) + "\n").encode())
                buf = b""
                while b"\n" not in buf:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
            return json.loads(buf.decode().splitlines()[0])
        except Exception as e:  # engine down, slow, or wedged
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# --------------------------------------------------------------------------- #
# Analysis
# --------------------------------------------------------------------------- #

class Analyzer:
    def __init__(self, landmarker: Landmarker, engine: EngineClient, threshold: float):
        self.landmarker = landmarker
        self.engine = engine
        self.threshold = threshold

    def analyze(self, req: dict) -> dict:
        raw = req.get("image_b64")
        if not raw:
            return {"ok": False, "error": "image_b64 required"}
        try:
            buf = np.frombuffer(base64.b64decode(raw), np.uint8)
            bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        except Exception as e:
            return {"ok": False, "error": f"decode: {e}"}
        if bgr is None:
            return {"ok": False, "error": "decode: not an image"}

        height, width = bgr.shape[:2]
        result = self._landmarks(bgr)
        faces = result.face_landmarks if result else []

        out: dict = {"ok": True, "faceCount": len(faces), "width": width, "height": height}
        if not faces:
            # A participant whose camera is on but who is not in frame. Reported
            # as a real observation, not an error: absence is a signal.
            out["primary"] = None
            return out

        primary_idx, primary = self._largest(faces, width, height)
        described = self._describe(primary, width, height)

        # Sharpness is measured on the face only. Over the whole frame a busy
        # background would mask a blurred face, which is precisely the case
        # that has to be caught.
        box = described["box"]
        x0 = max(0, int(box["x"] * width))
        y0 = max(0, int(box["y"] * height))
        x1 = min(width, int((box["x"] + box["width"]) * width))
        y1 = min(height, int((box["y"] + box["height"]) * height))
        crop = bgr[y0:y1, x0:x1]
        described["sharpness"] = (
            sharpness_score(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)) if crop.size else 0.0
        )

        out["primary"] = described
        out["primaryIndex"] = primary_idx

        if req.get("identify", True):
            out["identity"] = self._identify(raw, req.get("top_k", 3))
        return out

    def eyes(self, req: dict) -> dict:
        """Eye state only, for blink sampling.

        A blink lasts 100-400ms, so it is invisible at the 10s cadence the full
        `analyze` runs at: counting blinks needs ~10 samples a second. This
        path therefore does the landmark pass and nothing else — no pose solve,
        no identity, no sharpness — so the bot can afford to call it often.
        Returns `eyeClosed` per frame; counting the closed->open transitions is
        the caller's job, because only the caller knows its own sample rate.
        """
        raw = req.get("image_b64")
        if not raw:
            return {"ok": False, "error": "image_b64 required"}
        try:
            buf = np.frombuffer(base64.b64decode(raw), np.uint8)
            bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        except Exception as e:
            return {"ok": False, "error": f"decode: {e}"}
        if bgr is None:
            return {"ok": False, "error": "decode: not an image"}

        height, width = bgr.shape[:2]
        result = self._landmarks(bgr)
        faces = result.face_landmarks if result else []
        if not faces:
            # No face is not an open eye and not a closed one.
            return {"ok": True, "faceCount": 0, "eyeClosed": None}

        _, primary = self._largest(faces, width, height)
        pts = np.array([[p.x * width, p.y * height] for p in primary], dtype=np.float32)
        ear = (eye_aspect_ratio(pts[LEFT_EYE]) + eye_aspect_ratio(pts[RIGHT_EYE])) / 2.0
        return {
            "ok": True,
            "faceCount": len(faces),
            "eyeAspectRatio": round(ear, 4),
            "eyeClosed": bool(ear < EAR_CLOSED),
        }

    def _landmarks(self, bgr: np.ndarray):
        import mediapipe as mp

        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        return self.landmarker.get().detect(image)

    @staticmethod
    def _largest(faces, width: int, height: int):
        """The biggest face is taken to be the participant; the rest are extras."""
        best_i, best_area = 0, -1.0
        for i, lm in enumerate(faces):
            xs = [p.x for p in lm]
            ys = [p.y for p in lm]
            area = (max(xs) - min(xs)) * (max(ys) - min(ys))
            if area > best_area:
                best_i, best_area = i, area
        return best_i, faces[best_i]

    def _describe(self, landmarks, width: int, height: int) -> dict:
        pts = np.array([[p.x * width, p.y * height] for p in landmarks], dtype=np.float32)

        xs, ys = pts[:, 0], pts[:, 1]
        x0, y0, x1, y1 = float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())

        left = eye_aspect_ratio(pts[LEFT_EYE])
        right = eye_aspect_ratio(pts[RIGHT_EYE])
        ear = (left + right) / 2.0

        pose = head_pose(pts[POSE_LANDMARKS], width, height)

        return {
            "box": {
                "x": round(x0 / width, 4),
                "y": round(y0 / height, 4),
                "width": round((x1 - x0) / width, 4),
                "height": round((y1 - y0) / height, 4),
            },
            "eyeAspectRatio": round(ear, 4),
            "eyeClosed": bool(ear < EAR_CLOSED),
            # Reported as openness in 0..1 so the backend has a continuous
            # signal as well as the boolean; 0.35 is a comfortably open eye.
            "eyeOpenness": round(min(1.0, max(0.0, ear / 0.35)), 4),
            **pose,
        }

    def _identify(self, image_b64: str, top_k: int) -> dict:
        res = self.engine.identify(image_b64, top_k)
        if not res.get("ok"):
            return {"status": "UNAVAILABLE", "reason": res.get("error", "engine error")}
        # The UXE server returns `candidates`, not `matches`.
        candidates = res.get("candidates") or []
        if not candidates:
            return {"status": "NO_MATCH", "confidence": 0.0}
        top = candidates[0]
        score = float(top.get("score", 0.0))
        return {
            "status": "MATCH" if score >= self.threshold else "NO_MATCH",
            "traineeId": top.get("id") if score >= self.threshold else None,
            "confidence": round(score, 4),
            "candidates": candidates[:top_k],
        }


# --------------------------------------------------------------------------- #
# Server
# --------------------------------------------------------------------------- #

class Handler(socketserver.StreamRequestHandler):
    analyzer: Analyzer = None  # set on the server class

    def handle(self):
        for raw in self.rfile:
            started = time.time()
            try:
                req = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send({"ok": False, "error": f"bad json: {e}"})
                continue

            op = req.get("op", "")
            try:
                if op == "analyze":
                    res = self.analyzer.analyze(req)
                elif op == "eyes":
                    res = self.analyzer.eyes(req)
                elif op == "ping":
                    res = {"ok": True, "service": "zoomer-analyzer"}
                else:
                    res = {"ok": False, "error": f"unknown op '{op}'"}
            except Exception as e:
                res = {"ok": False, "error": f"{type(e).__name__}: {e}"}

            res["elapsed_ms"] = round((time.time() - started) * 1000, 1)
            self._send(res)

    def _send(self, obj: dict):
        self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
        self.wfile.flush()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9102)
    ap.add_argument("--engine-host", default="127.0.0.1")
    ap.add_argument("--engine-port", type=int, default=9101)
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help="MediaPipe FaceLandmarker .task bundle")
    ap.add_argument("--max-faces", type=int, default=4,
                    help="More than one face in a tile is itself the signal; "
                         "counting beyond a handful adds cost without meaning")
    ap.add_argument("--threshold", type=float, default=0.5944,
                    help="UXE far_1e-3 operating point")
    args = ap.parse_args()

    Handler.analyzer = Analyzer(
        Landmarker(args.model, args.max_faces),
        EngineClient(args.engine_host, args.engine_port),
        args.threshold,
    )

    # Fail at startup rather than on the first frame of a real meeting.
    probe = Handler.analyzer._landmarks(np.zeros((64, 64, 3), np.uint8))
    print(f"landmarker ready (probe faces={len(probe.face_landmarks) if probe else 0})", flush=True)

    with Server((args.host, args.port), Handler) as srv:
        print(f"analyzer {args.host}:{args.port} -> engine "
              f"{args.engine_host}:{args.engine_port}", flush=True)
        srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

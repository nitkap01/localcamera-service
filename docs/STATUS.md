# localcamera-service — current status

_Last updated: 2026-07-10. This is the at-a-glance "where we are + how to run it +
what's next" doc. The full chronological journal is in [`PROJECT.md`](./PROJECT.md)._

**Status: working and deployed.** A Xiaomi Yi "Ants" camera, taken off the Chinese
cloud, streaming locally, with a self-hosted browser viewer (live video, capture,
image controls) plus a server-side people counter — running as a Docker container
on Portainer.

---

## What works today

**Camera** (`192.168.0.143`)
- Flashed to free custom firmware **shadow-1/yi-hack-v3 0.1.6** (`y18` build).
- Cloud disabled; joins wifi **without** the Yi app (SD boot hook).
- Local **RTSP**: `rtsp://192.168.0.143:554/ch0_0.h264` (H.264 1280×720 25fps),
  served by `rRTSPServer` + `h264grabber`, auto-started at boot.
- Root SSH for full control (legacy-crypto flags in `scripts/cam-ssh.sh`).

**Viewer** (Node/Express + ffmpeg + go2rtc)
- **Live**: WebRTC via go2rtc (sub-second) with an MJPEG fallback. Honest status
  (green only on real playback; badge shows the actual transport), auto-fallback
  to MJPEG if WebRTC/MSE don't start.
- Clean video surface — go2rtc's native player controls are hidden; **click/tap
  the video → fullscreen** (real iOS fullscreen too).
- **Live overlay** (browser-side, three independent toggles): **People** boxes,
  **Hands** (gesture name + handedness), **Face** (strongest expression) — every
  label carries a probability score. Runs on the displayed frame, so boxes line
  up with the video and the server does no extra work. Live display only; nothing
  is logged. Models load lazily on first toggle and are served from this host.
- **Capture**: snapshot (JPEG) and record (MP4, 10–60s).
- **Adjust**: brightness / contrast / saturation / hue, rotate, mirror, HD/SD,
  and hide the burned-in "YI" watermark (`delogo`).
- **People tab**: current count + peak/avg stats + an SVG time chart
  (Hour / Day / Week).

**People counter** (server-side, 24/7)
- Samples a frame every `COUNT_INTERVAL_MS` (default 4s) and counts the people
  in it. Everything runs on the server — nothing detects in the browser.
- **Two engines**, switchable live from the People tab or set via `DETECTOR`:
  - `cocossd` (default) — coco-ssd on TensorFlow.js/WASM. Pure JS, any arch.
  - `yolo` — YOLOv10n on onnxruntime-node (CPU). More accurate; NMS is baked
    into the model, so no post-processing. AGPL-3.0 model.
  Both models ship in the image (offline). The first switch to an engine loads
  its model (~1–3s); both then stay loaded, so flipping back is instant.
- Logs `{ts, count, detector}` to **SQLite** at `DB_PATH` (instantaneous
  occupancy). The `detector` column keeps history readable across switches.
- API: `GET /api/occupancy/now`, `/api/occupancy/status`,
  `/api/occupancy?range=hour|day|week`,
  `POST /api/occupancy/detector/{cocossd|yolo}`.

---

## How it's deployed

**Container** (Docker Hub): `nitinkapoor/localcamera-viewer` — multi-arch
(`linux/amd64` + `linux/arm64`), Debian base (`node:20-slim`).
- **Deploy the versioned tag** `:v3`, not `:latest`. Portainer caches `latest`
  and won't re-pull it, which served a stale image (that's what caused the
  `/sbin/tini` start error). A fresh tag forces a clean pull. Bump the tag on
  each new build.

**Portainer host** `192.168.0.246`, host networking, DB on a volume:
```yaml
services:
  localcamera-viewer:
    image: nitinkapoor/localcamera-viewer:v3
    container_name: localcamera-viewer
    network_mode: host
    environment:
      CAMERA_IP: "192.168.0.143"
      DETECTOR: "cocossd"       # or "yolo" — also switchable live in the People tab
    volumes:
      - lcs-data:/data          # people-count history — survives redeploys
    restart: unless-stopped
volumes:
  lcs-data:
```
Open **http://192.168.0.246:8080**.

**Local dev** (Mac): `cd viewer && npm start` (runs go2rtc + node). Pin **Node 20**
— `better-sqlite3` is ABI-locked to the Node it built for, and nvm here also has
v22/v25 which fail to load it.

**Env vars**: `CAMERA_IP` (required) · `WEBRTC_CANDIDATE=<host-ip>:8555` (bridge
networking only) · `PORT` (8080) · `GO2RTC_PORT` (1984) · `DB_PATH`
(`/data/occupancy.db`) · `DETECTOR` (`cocossd`) · `COUNT_INTERVAL_MS` (4000) ·
`COUNT_MIN_SCORE` (0.45) · `COUNT_THREADS` (2) · `COUNT_ENABLE` (1) ·
`YOLO_MODEL`.

---

## Key decisions & gotchas (so we don't relearn them)

- **WebRTC in a container**: go2rtc must advertise a reachable IP. Host
  networking = automatic; bridge networking needs `WEBRTC_CANDIDATE=<host>:8555`
  or the browser can't connect and drops to slow MJPEG.
- **Detection engine**: chose tfjs **WASM** (not `tfjs-node`) so there's no native
  TensorFlow to compile and it runs on amd64/arm64 alike. Model
  (`ssdlite_mobilenet_v2`, ~17MB) is vendored/fetched at build and loaded from
  local files = fully offline.
- **YOLO engine**: **YOLOv10n**, because it's *end-to-end* — NMS is baked into the
  graph, so the model returns already-de-duplicated boxes (`[1,300,6]` of
  `x1,y1,x2,y2,score,class`) and there is no NMS code to get wrong. Runs on
  `onnxruntime-node`, which ships prebuilt CPU binaries for linux x64+arm64
  (no compile, no CUDA — set `ONNXRUNTIME_NODE_INSTALL=skip` to suppress the
  optional GPU download).
- **`onnxruntime-node` is pinned to `1.22.0` exactly.** 1.23+ dropped the
  `darwin/x64` binary, and this Mac's nvm Node 20 is an **x64** build (Rosetta),
  so newer versions break local dev with `Cannot find module
  '.../darwin/x64/onnxruntime_binding.node'`. A caret (`^1.22.0`) would drift
  back to 1.27 — keep it exact.
- **`ARG TARGETARCH` must have NO default.** `ARG TARGETARCH=amd64` *shadows* the
  value buildx injects, so every arch silently gets amd64 binaries — confirmed:
  the published `:v2` arm64 image had an **x86-64 go2rtc** inside it. Fixed in
  `:v3`; the build now fails loudly on an unknown arch instead of guessing.
- **Overlay runs in the browser, on purpose.** Gestures are sub-second events; the
  server's 4s sampling can't see them, and server-computed boxes trail the video
  by 300–500ms. Browser-side inference is frame-aligned and free for the server.
  MediaPipe Tasks is browser-only anyway (DOM + WebGL). The counter is separate
  and unchanged.
- **iOS + overlay**: a fullscreened `<video>` goes to the native iOS player, which
  paints above everything and can't show an overlay — so when any layer is on,
  fullscreen switches to a CSS full-window mode. With layers off, the old
  behaviour is untouched.
- **Overlay pauses while rotated**: CSS rotation moves the picture but not the
  layout box, so boxes would sit crooked. Mirror is handled (x is flipped).
- **SQLite bucketing**: floor with `ts - ts % bucket` (integer modulo);
  `(ts/b)*b` didn't floor due to float binding.
- **Docker base**: Alpine → `node:20-slim` (glibc) so `better-sqlite3` installs
  cleanly. tini lives at `/usr/bin/tini` on Debian (was `/sbin/tini` on Alpine).
  onnxruntime also has no musl build, so glibc is now doubly required.
- **Camera quirks**: busybox lacks `nohup/head/sort/wait -n`; `himm`/tools need
  `LD_LIBRARY_PATH=/home/lib`; the low/SD substream is corrupt, so "SD" = ffmpeg
  downscale of HD.

---

## Next / backlog (what we build over)

- **Blue-status-LED toggle** — parked. Traced to the stock `rmm` app's `himm`
  register writes in the Hi3518 sysctrl block; no safe static toggle. Needs a
  bounded, reboot-reversible live test with eyes on the camera. Details in
  [`PROJECT.md`](./PROJECT.md) §12.
- **Unique-person entry counting** — current counter is *instantaneous
  occupancy*. Counting how many distinct people *entered* needs tracking/re-ID
  across frames.
- **Detection quality** — tune `COUNT_MIN_SCORE`, step up to `yolov10s/m`
  (drop-in: same input/output shape, just set `YOLO_MODEL`), add a
  region-of-interest / min box size to cut false positives.
- **Alerts** — notify on occupancy thresholds (MQTT / Home Assistant / Telegram /
  webhook).
- **Data** — retention/rollup of old samples, CSV export, daily/weekly summaries.
- **Hardening** — the viewer is LAN-only by design; add auth before exposing it.
- **NVR** — optionally feed RTSP into Frigate for recording + richer detection.

---

## Repo map (quick pointers)

```
viewer/               the web viewer + counter
  server.js           Express: live MJPEG, snapshot, record, /api/occupancy
  counter.js          sample loop -> detector -> SQLite; runtime engine swap
  detectors/          cocossd.js (tfjs/WASM) + yolo.js (YOLOv10n/onnxruntime)
  public/index.html   UI: Live + People tabs, controls, engine switch, SVG chart
  public/overlay.js   browser-side overlay: people / hands / face + scores
  go2rtc/             WebRTC (RTSP -> WebRTC) config + binary (gitignored)
  models/             fetch-model.sh (coco-ssd, yolov10n, mediapipe; gitignored)
  Dockerfile          multi-stage Debian build (deps + model + go2rtc)
  docker-compose.yml  Portainer stack (host + bridge options)
  DOCKER.md           build / push / deploy + env reference
scripts/              cam-ssh / cam-scp / find-camera / prep-sd / fetch-*
firmware/             yi-hack-v3 y18 firmware + fetch script
docs/PROJECT.md       full build journal
docs/STATUS.md        this file
```

# localcamera-service — current status

_Last updated: 2026-07-09. This is the at-a-glance "where we are + how to run it +
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
- **Capture**: snapshot (JPEG) and record (MP4, 10–60s).
- **Adjust**: brightness / contrast / saturation / hue, rotate, mirror, HD/SD,
  and hide the burned-in "YI" watermark (`delogo`).
- **People tab**: current count + peak/avg stats + an SVG time chart
  (Hour / Day / Week).

**People counter** (server-side, 24/7)
- Samples a frame every `COUNT_INTERVAL_MS` (default 4s), counts `person` boxes
  with **coco-ssd (TensorFlow.js, WASM backend)** — offline, no cloud, any CPU/arch.
- Logs `{ts, count}` to **SQLite** at `DB_PATH` (instantaneous occupancy).
- API: `GET /api/occupancy/now`, `/api/occupancy/status`,
  `/api/occupancy?range=hour|day|week`.

---

## How it's deployed

**Container** (Docker Hub): `nitinkapoor/localcamera-viewer` — multi-arch
(`linux/amd64` + `linux/arm64`), Debian base (`node:20-slim`).
- **Deploy the versioned tag** `:v2`, not `:latest`. Portainer caches `latest`
  and won't re-pull it, which served a stale image (that's what caused the
  `/sbin/tini` start error). A fresh tag forces a clean pull. Bump the tag on
  each new build.

**Portainer host** `192.168.0.246`, host networking, DB on a volume:
```yaml
services:
  localcamera-viewer:
    image: nitinkapoor/localcamera-viewer:v2
    container_name: localcamera-viewer
    network_mode: host
    environment:
      CAMERA_IP: "192.168.0.143"
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
(`/data/occupancy.db`) · `COUNT_INTERVAL_MS` (4000) · `COUNT_MIN_SCORE` (0.45) ·
`COUNT_ENABLE` (1).

---

## Key decisions & gotchas (so we don't relearn them)

- **WebRTC in a container**: go2rtc must advertise a reachable IP. Host
  networking = automatic; bridge networking needs `WEBRTC_CANDIDATE=<host>:8555`
  or the browser can't connect and drops to slow MJPEG.
- **Detection engine**: chose tfjs **WASM** (not `tfjs-node`) so there's no native
  TensorFlow to compile and it runs on amd64/arm64 alike. Model
  (`ssdlite_mobilenet_v2`, ~17MB) is vendored/fetched at build and loaded from
  local files = fully offline.
- **SQLite bucketing**: floor with `ts - ts % bucket` (integer modulo);
  `(ts/b)*b` didn't floor due to float binding.
- **Docker base**: Alpine → `node:20-slim` (glibc) so `better-sqlite3` installs
  cleanly. tini lives at `/usr/bin/tini` on Debian (was `/sbin/tini` on Alpine).
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
- **Detection quality** — tune `COUNT_MIN_SCORE`, try a larger model, add a
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
  counter.js          person detection (coco-ssd/WASM) -> SQLite
  public/index.html   UI: Live + People tabs, controls, SVG chart
  go2rtc/             WebRTC (RTSP -> WebRTC) config + binary (gitignored)
  models/             fetch-model.sh (coco-ssd weights; gitignored)
  Dockerfile          multi-stage Debian build (deps + model + go2rtc)
  docker-compose.yml  Portainer stack (host + bridge options)
  DOCKER.md           build / push / deploy + env reference
scripts/              cam-ssh / cam-scp / find-camera / prep-sd / fetch-*
firmware/             yi-hack-v3 y18 firmware + fetch script
docs/PROJECT.md       full build journal
docs/STATUS.md        this file
```

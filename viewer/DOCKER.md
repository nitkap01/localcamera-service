# Running the viewer in Docker (Docker Hub → Portainer)

One image bundles everything the viewer needs: **Node + Express**, **ffmpeg**
(snapshot / record / MJPEG), and **go2rtc** (WebRTC). Point it at your camera's
LAN IP and open the page.

## Environment variables

| Variable | Required? | Default | What it does |
|---|---|---|---|
| `CAMERA_IP` | **Yes** | `192.168.0.143` | The camera's IP on your LAN. The only one you really must set. |
| `WEBRTC_CANDIDATE` | Bridge only | _(unset)_ | `<docker-host-LAN-IP>:8555`. Needed in **bridge** networking so go2rtc advertises a reachable address — otherwise **phones fall back to slow MJPEG**. Leave unset with host networking. |
| `PORT` | No | `8080` | Port for the web UI (the page you open in a browser). |
| `GO2RTC_PORT` | No | `1984` | go2rtc API + WebRTC signaling. The browser is told this value via `/api/info`, so change it here (not just the port mapping) if you remap it. |
| `DB_PATH` | No | `/data/occupancy.db` | People-count SQLite DB. Mount a volume at `/data` (the compose file does) so the history survives redeploys. |
| `DETECTOR` | No | `cocossd` | Detection engine at boot: `cocossd` or `yolo`. Also switchable at runtime from the People tab. |
| `COUNT_INTERVAL_MS` | No | `4000` | How often (ms) to grab a frame and count people. |
| `COUNT_MIN_SCORE` | No | `0.45` | Detection confidence threshold (0–1). Higher = fewer false positives. |
| `COUNT_THREADS` | No | `2` | CPU threads for the YOLO engine. Raise on a beefy host, drop to `1` on a Pi. |
| `COUNT_ENABLE` | No | `1` | Set `0` to turn the people counter off entirely. |
| `YOLO_MODEL` | No | `/app/models/yolo/yolov10n.onnx` | Path to the ONNX model. Only change to swap in a different YOLO export. |

### People counter

The **People** tab logs how many people are in frame over time. Detection runs
**server-side** — nothing is detected in the browser. Every `COUNT_INTERVAL_MS`
the server grabs a frame, counts the people in it, and stores
`{timestamp, count, detector}` in SQLite at `DB_PATH`. Keep the `/data` volume
mounted so history persists.

### Detection engines

Both models are baked into the image, so detection is fully offline. Pick one
with `DETECTOR`, or flip between them live from the **engine** switch in the
People tab (the first switch to an engine loads its model, ~1–3s; after that
it's instant, and both stay loaded).

| Engine | Model | Runtime | Notes |
|---|---|---|---|
| `cocossd` (default) | ssdlite_mobilenet_v2 | TensorFlow.js, WASM | Pure JS, no native code. Lighter, but misses people more often. |
| `yolo` | YOLOv10n (~9MB) | onnxruntime-node, CPU | More accurate. NMS is baked into the model, so detections come out already de-duplicated. |

Each sample records which engine produced it (the `detector` column), so history
stays readable when you switch. Switching does **not** discard past data.

> YOLOv10 is **AGPL-3.0** licensed. Fine for personal/home use like this; if you
> ever redistribute this service, that license travels with the model.

`GET /api/occupancy/status` reports the active engine; `POST
/api/occupancy/detector/{cocossd|yolo}` switches it. There's no auth — the
viewer is LAN-only by design.

### Live overlay (People / Hands / Face)

The Live tab has three independent toggles that draw boxes over the video, each
label carrying a probability score:

| Toggle | Draws | Model |
|---|---|---|
| **People** | person boxes — `person 0.91` | efficientdet_lite0 |
| **Hands** | hand box + landmarks + gesture — `Right · Victory 0.94` | gesture_recognizer |
| **Face** | face box + strongest expression — `mouth smile left 0.96` | face_landmarker |

**No env vars.** This runs in *your browser*, on the frame being displayed, so
boxes line up with the video and the server does no extra work. The MediaPipe
runtime and models are served from the container (`/vendor/mediapipe`,
`/models/mediapipe`) — nothing is fetched from a CDN, so it works on a LAN with
no internet. Each model (7–8MB) downloads the first time you enable its layer.

This is **live display only — nothing is recorded**. The server-side people
counter above is entirely separate and keeps logging whether or not a browser
is open.

Two behaviours worth knowing: with any layer on, fullscreen becomes a CSS
full-window mode (iOS's native video player paints over an overlay and can't show
it), and the overlay pauses while the picture is **rotated** — boxes would sit
crooked, since CSS rotation moves the picture but not its layout box. Mirror
works fine.

### Why mobile WebRTC fails in a container

WebRTC has to hand the browser an IP address to connect back to. Inside a
bridge-network container, go2rtc only knows its *internal* Docker IP
(e.g. `172.17.0.2`), which your phone can't reach — so the browser gives up on
WebRTC and drops to MJPEG (works, but slow). Two ways to fix it:

- **Host networking** (`network_mode: host`, Linux hosts): go2rtc sees the real
  LAN IP automatically. Nothing else to set.
- **Bridge networking**: publish ports 8080/1984/8555 **and** set
  `WEBRTC_CANDIDATE=<docker-host-LAN-IP>:8555`. Required on Docker Desktop
  (Mac/Windows), where host networking isn't real.

The wifi settings (`WIFI_SSID`, `WIFI_PASSWORD`, `LAN_SUBNET`) are **not** used by
the viewer — they only matter when flashing/finding the camera. Don't put them here.

## Ports

| Port | Proto | Purpose |
|---|---|---|
| 8080 | tcp | Web UI + snapshot + record + MJPEG |
| 1984 | tcp | go2rtc API / WebRTC signaling (WebSocket) |
| 8555 | tcp + udp | WebRTC media |

## Build & push to Docker Hub

Multi-arch (works on an x86 server *and* an ARM Pi). **Bump the version tag on
every build** — Portainer caches `:latest` and won't re-pull it.

```bash
cd viewer
docker login
docker buildx create --use --name lcs 2>/dev/null || docker buildx use lcs
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t nitinkapoor/localcamera-viewer:v3 \
  -t nitinkapoor/localcamera-viewer:latest \
  --push .
```

Single-arch (just your server's CPU) is simpler if you don't need ARM:

```bash
cd viewer
docker build -t nitinkapoor/localcamera-viewer:v3 .
docker push nitinkapoor/localcamera-viewer:v3
```

> The Dockerfile declares `ARG TARGETARCH` **without a default**. Adding one
> (`ARG TARGETARCH=amd64`) silently shadows the value buildx injects, and every
> architecture ends up with amd64 binaries. Don't reintroduce it.

## Deploy on Portainer

**Option A — Stack (recommended).** Portainer → *Stacks* → *Add stack*, paste
`docker-compose.yml` (edit the image name + `CAMERA_IP`), deploy. It uses
`network_mode: host`, which is the simplest way to get WebRTC working on a LAN.

**Option B — Container.** Portainer → *Containers* → *Add container*:
- Image: `nitinkapoor/localcamera-viewer:latest`
- Network: **host** (easiest for WebRTC), or Bridge + publish 8080/1984/8555
- Env: `CAMERA_IP=192.168.0.143`
- Restart policy: *Unless stopped*

Then open `http://<docker-host-ip>:8080` from your phone or laptop on the same wifi.

## Notes

- **WebRTC + Docker:** use host networking. In bridge mode the page and MJPEG
  still work, but WebRTC media needs go2rtc to advertise the host IP — see the
  commented bridge block in `docker-compose.yml`.
- **Host must be Linux** for host networking to behave (a home server / Raspberry
  Pi running Portainer is ideal). Docker Desktop on macOS/Windows doesn't map
  host networking the same way.
- The camera itself is unchanged — the container is just a client of its RTSP
  stream, so nothing on the camera needs Docker.

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
| `COUNT_INTERVAL_MS` | No | `4000` | How often (ms) to grab a frame and count people. |
| `COUNT_MIN_SCORE` | No | `0.45` | Detection confidence threshold (0–1). Higher = fewer false positives. |
| `COUNT_ENABLE` | No | `1` | Set `0` to turn the people counter off entirely. |

### People counter

The **People** tab logs how many people are in frame over time. Detection runs
server-side (TensorFlow.js `coco-ssd` on the WASM backend — offline, no cloud,
any CPU/arch) every `COUNT_INTERVAL_MS`, and each `{count, timestamp}` is stored
in SQLite at `DB_PATH`. Keep the `/data` volume mounted so history persists.

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

Multi-arch (works on an x86 server *and* an ARM Pi). Replace `YOURUSER`.

```bash
cd viewer
docker login
docker buildx create --use --name lcs 2>/dev/null || docker buildx use lcs
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t nitinkapoor/localcamera-viewer:latest \
  --push .
```

Single-arch (just your server's CPU) is simpler if you don't need ARM:

```bash
cd viewer
docker build -t nitinkapoor/localcamera-viewer:latest .
docker push nitinkapoor/localcamera-viewer:latest
```

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

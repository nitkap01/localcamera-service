# 📹 localcamera-service

Turn a cheap Xiaomi Yi "Ants" camera into a **fully local, cloud-free IP camera** with a
browser viewer — live **WebRTC** video, snapshots, recording, and image controls — running
entirely on your own network. No Yi app, no account, nothing phones home.

![Node](https://img.shields.io/badge/Node-20-3c873a)
![ffmpeg](https://img.shields.io/badge/ffmpeg-required-007808)
![go2rtc](https://img.shields.io/badge/WebRTC-go2rtc-3da2ff)
![status](https://img.shields.io/badge/status-working-38d39f)

## Why

The Yi Ants (model `YHS-113`) ships locked to Xiaomi's cloud and, on later firmware, is
region-locked ("this camera can only be used in China"). This project flashes free custom
firmware, kills the cloud, brings the camera up on wifi without the app, exposes a local
**RTSP** stream, and puts a self-hosted **web viewer** in front of it.

## Features

- 🎥 **Live view in any browser** — WebRTC (sub-second) with an MJPEG fallback. Works on
  iPhone Safari and Android/desktop Chrome.
- 📷 **Snapshot** and ⏺ **Record** (MP4, 10–60s) — straight to your device.
- 🎚 **Image controls** — brightness, contrast, saturation, hue, rotate, mirror, HD/SD.
- 🚫 **Watermark removal** — hides the burned-in "YI" logo.
- ☁️ **No cloud** — the camera never talks to the internet.
- 📶 **App-free wifi** — SSID/password set from a config file, no Yi account.
- 🔓 **Root SSH/FTP** on the camera for full control.

## The camera

| | |
|---|---|
| Model | Xiaomi Yi Home 720p "Ants" — `YHS-113-IR` |
| SoC | HiSilicon **Hi3518e v200** |
| Serial id (varint) | `47US` |
| Stock firmware (before) | `1.8.7.0F` — region-locked, cloud |
| Custom firmware (now) | **shadow-1/yi-hack-v3 `0.1.6`** (`home_y18` / `rootfs_y18`) |
| Stream | `rtsp://<cam-ip>:554/ch0_0.h264` — H.264, 1280×720, 25 fps |

## Architecture

```
  browser
   │  page + snapshot + record (HTTP :8080)   │  live video (WebRTC, WS :1984 / :8555)
   ▼                                          ▼
  Node/Express (server.js) ── spawns ffmpeg   go2rtc ── RTSP → WebRTC (passthrough)
   └──────────────────┬──────────────────────────┘
                      ▼
        rtsp://<cam>:554/ch0_0.h264   ← the camera (rRTSPServer + h264grabber)
```

- **go2rtc** re-serves the camera's RTSP as WebRTC (low latency, no transcode).
- **Node + ffmpeg** serves the page and does snapshot / record / MJPEG, applying filters
  (rotate, mirror, `delogo` for the watermark, `eq`/`hue` for image adjust, `scale` for SD).
- Nothing is stored server-side — captures stream straight to your browser.

## Quick start

**Watch the camera** (camera already flashed & streaming):
```bash
cd viewer
npm install
npm start                 # go2rtc (WebRTC) + node server
```
Open **http://localhost:8080** (this machine) or **http://<host-ip>:8080** (phone, same wifi).
Requires [ffmpeg](https://ffmpeg.org) on the host (`brew install ffmpeg`).

**Flash / set up a camera** (Yi Home 720p `47US`):
```bash
cp config.env.example config.env      # set WIFI_SSID / WIFI_PASSWORD
firmware/fetch-firmware.sh            # download the y18 firmware
scripts/prep-sd.sh /Volumes/YOURCARD  # write firmware + app-free wifi hook
# insert SD into the powered-off camera, plug in; yellow flashes ~30s → reboot → blue
scripts/find-camera.sh                # locate its DHCP address
# then enable RTSP over SSH (see docs/PROJECT.md)
```

## Project layout

```
docs/PROJECT.md      full build journal — decisions, gotchas, sources
firmware/            yi-hack-v3 y18 firmware + fetch script + recovery notes
sd-card/             what goes on the camera's microSD (firmware + wifi + rtsp hook)
scripts/             cam-ssh / cam-scp / find-camera / camera-info / prep-sd / fetch-*
viewer/              the web viewer — Node/Express + ffmpeg + go2rtc
config.env           local wifi/IP settings (gitignored)
```

## Security

- **LAN only.** Never expose ports 22 / 80 / 554 (camera) or 8080 / 1984 (viewer) to the internet.
- The camera's root password is blank by default — change it: `scripts/cam-ssh.sh` then `passwd`.
- Wifi password and firmware binaries are gitignored; nothing secret is committed.

## Credits

Built on the community yi-hack work — [shadow-1/yi-hack-v3](https://github.com/shadow-1/yi-hack-v3),
[Arkady23/yi-hack-v3plus](https://github.com/Arkady23/yi-hack-v3plus) (RTSP), and
[go2rtc](https://github.com/AlexxIT/go2rtc) (WebRTC).

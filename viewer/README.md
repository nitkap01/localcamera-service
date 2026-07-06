# viewer — local web viewer

Watch the camera in any browser (iPhone Safari, Android/desktop Chrome) with
capture + adjust controls. Two live-view engines:

- **WebRTC (default)** — sub-second latency, via **go2rtc** (H.264 passthrough).
- **MJPEG (fallback / "clean")** — via this Node server + ffmpeg. Supports the
  features WebRTC passthrough can't: **hide-YI watermark**, **SD downscale**, and
  precise server-side rotation.

## Architecture
```
browser ──HTTP──►  Node/Express (server.js, :8080)   page + snapshot + record (ffmpeg)
        ──WS/WebRTC──►  go2rtc (:1984 / :8555)         low-latency live view
                                │
                 both pull ─────┴────►  rtsp://<cam>:554/ch0_0.h264   (camera)
```
- `server.js` — serves the page; `/snapshot.jpg`, `/record`, `/stream.mjpeg` each
  spawn an ffmpeg that reads the camera's RTSP and applies filters (rotate, mirror,
  `delogo` for the watermark, `scale` for SD).
- `go2rtc/` — the WebRTC engine. `go2rtc.yaml` defines the `nk-camera` stream
  (RTSP → WebRTC). Binary is gitignored (`scripts`/download).
- `public/` — the UI (`index.html`) + go2rtc's `video-rtc.js` web component.

## Run
```bash
cd viewer
npm install                 # first time
npm start                   # go2rtc (WebRTC) + node server
# npm run start:mjpeg       # node only, no WebRTC
```
Open **http://localhost:8080** (Mac) or **http://<mac-ip>:8080** (phone, same wifi).

## Controls
⚡WebRTC / 🎞MJPEG · 📷Snapshot · ⏺Record (10–60s) · HD/SD · ⟳Rotate · ⇄Mirror ·
🚫Hide YI · ⤢Fit · ⛶Fullscreen.

Snapshot/record always go through ffmpeg, so they honour rotate/mirror/hide-YI/SD
even while live view is WebRTC. Selecting **SD** or **Hide YI** auto-switches live
view to MJPEG (WebRTC is a raw passthrough and can't transcode).

## Notes / tuning
- **Watermark:** removed with ffmpeg `delogo` (see `LOGO` in `server.js`). It blurs
  the box rather than a perfect erase; adjust `x/y/w/h` there to tighten it.
- **SD** = HD downscaled to 640px (the camera's native low substream is corrupt).
- **Record length** is approximate for un-filtered clips (keyframe-cut, stream-copy);
  filtered clips (rotate/hide-YI/SD) are re-encoded and exact.
- LAN only — never expose these ports to the internet.

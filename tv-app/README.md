# NKCam — Samsung Tizen TV app

A minimal Samsung Tizen TV app ("NKCam") that opens straight into this project's
camera viewer, full-screen, with no browser UI — built for a TV remote, not a mouse.

## Why this exists, not just the browser page

Pointing the TV's browser at the viewer's normal page (`viewer/public/index.html`)
doesn't work well on a TV:

- The viewer's live view defaults to **WebRTC** (via go2rtc) for low latency, but
  Samsung Tizen TVs generally have poor/no working WebRTC support in their webview -
  it shows a black screen.
- The viewer's controls (snapshot, record, brightness/contrast/rotate sliders) are
  built for mouse/touch. A TV D-pad has no way to click them.

This app works around both:

- It points directly at the server's **`/stream.mjpeg`** endpoint instead of the
  main page - a plain multipart MJPEG image stream, which works reliably without
  WebRTC.
- It adds its own lightweight, D-pad-navigable settings panel (Up/Down selects a
  setting, Left/Right adjusts it) covering the same rotate/mirror/hide-logo/quality/
  brightness/contrast/saturation/hue options the browser viewer exposes via
  `/stream.mjpeg`'s query parameters - see `viewer/server.js`.

## Files

| File | What it is |
|---|---|
| `config.xml` | Tizen app manifest - app id/name/icon, permissions. |
| `index.html` | The entire app: the `<img>` tag showing the MJPEG stream, the settings panel, and the keyboard handling that drives both. |
| `icon.png` | App icon shown in the TV's app list. |

## Before building: update the camera server address

`index.html` has the viewer server's address hardcoded (`http://<host-ip>:8080`) in
two places - the `<img src>` and the fetch base used by the settings panel. Update
both to match wherever `viewer/` is actually running before building.

## Build & install

Requires [Tizen Studio](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)
(CLI tools + TV extension + a certificate/security profile - see
[jellyfinnx-tizen's README](https://github.com/nitkap01/jellyfinNX/tree/main/jellyfinnx-tizen)
in the JellyfinNX repo for the exact one-time setup steps, which are identical).

```sh
cd tv-app
tizen build-web -e ".*" -e "*.wgt"
tizen package -t wgt -s <your-security-profile> -o . -- .buildResult

# Enable Developer Mode on the TV (Apps -> Developer Mode) and set the
# Developer IP to this machine's LAN IP, then:
sdb connect <tv-ip>
tizen install -n NKCam.wgt -s <tv-ip>:26101
tizen run -p NKCamPkg01.NKCam -s <tv-ip>:26101
```

Installs as its own app (`NKCamPkg01.NKCam`) - doesn't touch anything else on the TV.

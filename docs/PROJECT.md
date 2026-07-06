# Yi-Hack Camera Project — journal

Project journal for `localcamera-service`. Goal: run a Xiaomi Yi Ants camera fully
local (no Chinese cloud), view the feed, then build our own viewer and poke further.

This is the full history/decision log. For current state + how-to, see the top-level
`README.md`. The `../yi-hack/` repo is the 2016 reference hack we started from
(it turned out not to fit this camera — see the pivot below).

Last updated: 2026-07-06

---

## 1. Goal and phases

| Phase | Goal | Status |
|---|---|---|
| **0. Prep** | Gather hardware + network info, check firmware, plan safety | ✅ done |
| **1. See the feed** | Flash free hack, no cloud, RTSP feed live | ✅ done — RTSP H.264 720p |
| **2. Our own viewer** | Local web server: live view + snapshot + record + adjust | ✅ built (`viewer/`) |
| **3. Poke further** | Motion/MQTT, snapshots, NVR, reverse-engineer binaries, maybe modern fork | ⬜ not started |

### ✅ Milestone (2026-07-06): flashed & online

- Flashed **shadow-1/yi-hack-v3 `0.1.6`** (`home_y18` + `rootfs_y18`) via SD. Yellow
  LED flashed ~30s → rebooted → **solid blue**.
- **App-free wifi worked first try** — our `yi-hack-v3/startup.sh` brought up `wlan0`
  and joined "Los Santos Customs"; no Yi app / account needed.
- **Cloud disabled automatically** by the firmware (swaps stock `cloudAPI` for a stub).
- Camera found at **`192.168.0.143`** (DHCP). Web UI `<title>Yi Camera</title>` →
  `proxy_config.html`. Open ports: **80 (web), 21 (ftp), 22 (ssh)**.
- RTSP (`:554`) is **closed** — base v3 has no RTSP server. Enabling it (free, via
  `Arkady23/yi-hack-v3plus` or an rtsp binary) is the next step → then the feed.
- All artifacts moved into this repo (`localcamera-service`); firmware + wifi hook +
  host scripts organized. See top-level `README.md`.

---

## 2. What the camera is

- **Model:** Xiaomi Yi Ants (first-gen home camera).
- **Chip (SoC):** HiSilicon **Hi3518**, 32-bit ARM.
- **Hack firmware in this repo:** `sd/home` = U-Boot uImage, version **`1.8.5.1M`** (Dec 2015, the "M release").
- **Wifi:** **2.4 GHz only.** It will NOT join a 5 GHz network. If your router
  broadcasts one SSID for both bands, you may need a separate 2.4 GHz SSID.

### How the hack works (important)
- It is **not a reflash.** You put files on a microSD card. On boot the stock
  firmware auto-runs `sd/test/equip_test.sh` from the card.
- That script **kills the cloud**, sets up wifi + a static IP, and starts four
  servers: HTTP (80), Telnet (23), FTP (21), **RTSP (554)**.
- **Reversible:** pull the card and the camera goes back to stock. The only
  permanent change is one renamed sound file (`timeout.g726`), to silence a
  Chinese "cloud timeout" voice.

### ⚠️ Firmware-match risk (check this first)
This repo is the **original, frozen since Oct 2016**. It targets old firmware.
- If your camera is on old firmware (letter A/K/L/M etc.), the hack should work.
- If Xiaomi auto-updated it to much newer firmware, the SD auto-run trick may not
  fire, or the bundled `home` image may not match. In that case we switch to a
  **modern fork** (`roleoroleo/yi-hack-v4` for Hi3518) instead of forcing this one.

**Decision (2026-07-06):** firmware version is unknown and can't be read without
the Yi app. Because the card is reversible (pull it → stock), we **boot the hack
and read the firmware from its own log** — `equip_test.sh` writes the hardware +
software version and firmware letter into `/home/hd1/test/log.txt` and the HTTP
page. If the camera ignores the card / never reaches solid blue, we pivot to the
modern fork.

**Phase 1 result (2026-07-06): FAILED — the hack never ran.**
- Card prepared correctly: 8 GB, MBR (FDisk) scheme, FAT32, `home` + `test/` at root.
- Camera behavior on boot: LED yellow, then went dark. Never blue-blinked.
- Camera never joined wifi — not reachable at `192.168.0.201`, absent from a full
  `192.168.0.0/24` ARP sweep.
- **Decisive:** after the boot attempt the card was pristine — no `test/log.txt`,
  no `test/log_*.txt`, no `record/` folders. The stock firmware did not auto-run
  `equip_test.sh`.
- **Conclusion:** this 2016 repo's SD auto-run trigger is not honored by this
  camera (newer firmware and/or a model fritz-smh never supported).
- **Next:** positively identify the camera (model number + FCC ID from the base
  label, and firmware via the Yi/Kami app) → pick the correct modern hack
  (`roleoroleo/yi-hack-*` family) or confirm it's unsupported.

### Revised approach (2026-07-06): pivot to yi-hack-v4

**Camera identified:** Yi Home 720p "Ants", serial `47USYXRSY9` → identifier
(varint = first 4 serial chars) **`47US`**, HiSilicon **Hi3518e**. US-region
first-gen model. Current firmware **`1.8.7.0F`** (2018).

**Why fritz-smh (this repo) is the wrong tool here:**
- Its bundled `home` is the `1.8.5.1M` image (M variant); our camera is an
  F-variant on `1.8.7.0F` (2018) — wrong variant + newer firmware.
- On this late firmware/hardware the SD auto-run / downgrade is commonly *ignored*
  (matches our pristine-card result). Forcing a flash needs a reset-button-held
  boot we never did, and cross-variant downgrade may be refused → real brick risk.

**Chosen path:** flash **`TheCrypt0/yi-hack-v4`** — maintained custom firmware for
Hi3518e 720p Yi Home. Our `47US` / `y18` model is supported (siblings 17CN/27US/47CN
listed "Yes" in the v4 wiki; 47US confirmed in `shadow-1/yi-hack-v3` #87 and
`Arkady23/yi-hack-v3plus`, which flash `rootfs_y18` + `home_y18`). Gives local
**RTSP + ONVIF + a web UI + "disable cloud"** out of the box — covers Phase 1 and
much of Phase 2. (Note: `yi-hack-v5` is for Hi3518e**v200** 1080p models — NOT us.)

**Important difference vs. fritz:** v4 **reflashes** the camera (persistent) — it
does not run-from-card. So:
- Small but real **bricking risk** → we follow the official wiki procedure exactly.
- Reversible via v4's documented "restore stock firmware", not by just pulling the card.
- Our existing 8 GB card (MBR / FAT32) is already the right format to reuse.

**Gate before flashing:** confirm exact v4 release + `y18` file names/steps from the
v4 wiki, and get explicit user go-ahead (flashing firmware is the one risky step).

**Sources:** fritz-smh issues #166/#174; diy.2pmc.net Ant Home guide; TheCrypt0
yi-hack-v4 wiki (Supported Models); shadow-1/yi-hack-v3 #87; Arkady23/yi-hack-v3plus.

### Correction (2026-07-06): v4 is paywalled → use FREE shadow-1/yi-hack-v3

Reading the raw v4 wiki changed the recommendation:
- **yi-hack-v4 firmware is donation-gated** — "only available to supporters of the
  project" (Discord + PayPal). No public download.
- **RTSP in v4 (`viewd`/`rtspv4`) is closed-source donationware**, licensed
  per-camera via Discord. So v4 = pay for firmware AND pay for RTSP. Rejected for a
  free local build.

**New chosen path — `shadow-1/yi-hack-v3` (free, public):**
- Release `0.1.6` ships the exact files our camera needs, no donation:
  - `home_y18`   → https://github.com/shadow-1/yi-hack-v3/releases/download/0.1.6/home_y18
  - `rootfs_y18` → https://github.com/shadow-1/yi-hack-v3/releases/download/0.1.6/rootfs_y18
- **Flash:** SD FAT32 (≤16 GB ideal; our 8 GB is perfect) → both files in card root
  → power on → yellow flashes ~30s (flashing) → auto-reboot → blue = wifi OK.
- **Gives:** web UI (`http://yi-hack-v3` or IP), SSH:22 / Telnet:23 / FTP:21,
  root / blank password. Cloud can be disabled (local-only).
- **RTSP:** NOT built into base v3 → add the FREE `Arkady23/yi-hack-v3plus` RTSP
  add-on (an extra step after base flash). URL form: `rtsp://<ip>/ch0_0.h264` (HD),
  `ch0_1.h264` (low).
- **Un-brick / recovery:** stock recovery images exist (flash stock `rootfs_y18` +
  `home_y18` back). Stock firmware for 47US ≈ `1.8.7.0A_201702081101`. This is our
  safety net. ← locate + download the stock recovery pair BEFORE flashing.

**PREREQUISITE — wifi (blocks flashing order):** the flashed firmware inherits the
camera's wifi. Standard method = pair the camera to "Los Santos Customs" with the
**Yi app once** BEFORE flashing (needs a Yi account; 2.4 GHz). Camera was factory
**reset**, so no wifi is stored → we must set it. Open question: use the app once,
or find an app-free wifi method (SD config / self-generated QR) — TBD with user.
Caveat: `1.8.7.0F` may be a region-locked ("only in China") build, which can make
the *international* app refuse to pair; flashing the hack removes that lock, but the
chicken-and-egg (need wifi to... no — the FLASH itself needs no wifi/app, only the
post-flash network join does) means we can flash first, then sort wifi on the hack.

**Decision pending:** (a) free v3 path vs paid v4; (b) wifi method (app vs app-free).

### ✅ Milestone (2026-07-06): RTSP live + web viewer working

- **Flashed shadow-1/yi-hack-v3 `0.1.6`** (`home_y18`+`rootfs_y18`) — booted solid
  blue; app-free wifi hook joined "Los Santos Customs" first try; cloud disabled by
  the firmware. Camera at **`192.168.0.143`** (web `:80`, ssh `:22`, ftp `:21`).
- **SSH is the install channel.** Old dropbear needs legacy crypto; root has a blank
  password. `/home` (jffs2) and `/tmp/sd` (vfat) are rw. FTP is chrooted/locked → use
  SSH+scp. Helpers: `scripts/cam-ssh.sh`, `scripts/cam-scp.sh`.
- **RTSP enabled over the network (no card pull).** Copied roleo `rRTSPServer` +
  `h264grabber` + `libstdc++.so.6` (from `Arkady23/yi-hack-v3plus`) to
  `/tmp/sd/yi-hack-v3/rtsp/`. Key gotchas: model is **`yi_home`** (720p; the add-on
  hardcodes `yi_home_1080p` — wrong), and `LD_LIBRARY_PATH` must include **`/home/lib`**
  (has `libpthread.so.0`). Launch = `sd-card/yi-hack-v3/rtsp-start.sh`; wired into
  `startup.sh` for boot persistence (processes also survive ssh-session close).
- **Stream verified:** `rtsp://192.168.0.143:554/ch0_0.h264` = H.264 **1280×720 @ 25fps**
  (grabbed a real frame). Low stream `ch0_1` is corrupt (decode errors) → HD only.
- **Viewer built** (`viewer/`, Node+Express+ffmpeg): MJPEG live view + `/snapshot.jpg`
  + `/record` + rotate/mirror/fit. Works on iPhone Safari + Chrome. Camera is mounted
  rotated → rotate control matters. Runs on the Mac at `:8080`.
- **Open items:** fix SD/low stream; tighten record duration (keyframe-cut ≈ short);
  optional lower-latency path (WebRTC) later.

### ✅ Milestone (2026-07-06 cont.): WebRTC, watermark, SD

- **WebRTC** live view added via **go2rtc** (`viewer/go2rtc/`, binary gitignored):
  RTSP→WebRTC passthrough, sub-second latency; page uses go2rtc's `video-rtc.js`
  web component. MJPEG kept as fallback/clean mode. `viewer/start.sh` runs both.
- **YI watermark** is burned in by the closed-source Yi app (no logo/osd file or
  config on the camera) → removed in our pipeline with ffmpeg **`delogo`**
  (`x=8:y=636:w=95:h=76` on the raw 1280×720; tune in `server.js`). Verified.
- **SD fixed by not using the camera's low substream** (it's corrupt even in
  isolation — 640×360 h264 with decode errors). "SD" is now HD **downscaled**
  (`scale=640:-2`) by ffmpeg → clean 640×360. Camera switched to **HD-only** grabber.
- WebRTC passthrough can't transcode, so hide-YI + SD auto-switch live view to MJPEG.
- **WebRTC bug fixed:** go2rtc rejected the WS (page on :8080, go2rtc on :1984 = cross
  origin) → added `api.origin: "*"` in `go2rtc.yaml`.

### ✅ Milestone (2026-07-06 cont.): image controls

- **Brightness / contrast / saturation / hue** sliders + rotate/mirror.
- Live: applied instantly via **CSS filters** (`brightness/contrast/saturate/hue-rotate`,
  `transform: rotate/scaleX`) — works in both WebRTC and MJPEG, no stream restart.
- Captures: **baked into snapshot/record** server-side via ffmpeg `eq` + `hue`
  (`buildFilters` in `server.js`), so downloads match what's on screen. Verified.

---

## 3. What you need to have (checklist)

- [ ] The Yi Ants camera + its power supply / USB cable.
- [ ] A **microSD card, 8–32 GB**, that we will format **FAT32**. (Old Yi cameras
      are happiest with ≤32 GB FAT32. Bigger cards / exFAT can fail to mount.)
- [ ] A **microSD card reader** for the Mac.
- [ ] Your **2.4 GHz wifi** name (SSID) and password.
- [ ] Router admin access (to find a free IP and, later, to block the camera's
      internet access).
- [ ] The Mac on the **same LAN/wifi** as the camera.
- [ ] **VLC** on the Mac (to open the RTSP stream). `brew install --cask vlc`
      or download from videolan.org. (Alternative: `ffmpeg`/`ffplay`.)

---

## 4. Network info to collect (fill this in)

We plug these into the two config files. Get them from your router page or, on the
Mac, from **System Settings → Network → Wi‑Fi → Details** (router = gateway).

All values are already written into the **`card/`** staging folder (gitignored,
so wifi/root secrets stay out of git). Non-secret values recorded here:

| Setting | Where it goes | Value |
|---|---|---|
| Wifi SSID (2.4 GHz) | `wpa_supplicant.conf` | `Los Santos Customs` |
| Wifi password | `wpa_supplicant.conf` | *(set on card, not in git)* |
| Gateway (router IP) | `yi-hack.cfg` `GATEWAY` / `NAMESERVER` | `192.168.0.1` |
| Netmask | `yi-hack.cfg` `NETMASK` | `255.255.255.0` |
| Static IP for the camera | `yi-hack.cfg` `IP` | `192.168.0.201` |
| Root password for telnet | `yi-hack.cfg` `ROOT_PASSWORD` | `1234qwer` (default — change later) |
| Timezone | `yi-hack.cfg` `TIMEZONE` | `IST-5:30` (India) |
| Debug (first boot) | `yi-hack.cfg` `DEBUG` | `yes` (extra logs; set to `no` later) |

> **Pick a free static IP:** choose one on your subnet that is outside the router's
> DHCP range (or reserve it in the router). Example: if your LAN is `192.168.1.x`
> and DHCP hands out `.100–.200`, use something like `192.168.1.50`.

**Heads-up:** the files in this repo default to the `192.168.1.x` range with gateway
`.254`. Most home routers use `.1`. We will edit these to match your actual network —
don't use the defaults as-is.

---

## 5. Phase 1 — See the feed, no cloud (step by step)

**Files we edit (already in this repo):**
- `sd/test/wpa_supplicant.conf` — wifi
- `sd/test/yi-hack.cfg` — IP, gateway, password, timezone

**Steps:**
1. **Check firmware (Phase 0 gate).** Confirm the camera model/firmware so we know
   this repo is the right one (see §2 risk note). If unsure, we power it stock once
   and read the version, or check the Yi app's device info.
2. **Format the microSD as FAT32** (name it e.g. `YICAM`).
3. **Copy the payload:** copy everything inside `sd/` to the **root** of the card.
   The card root should then contain `home` and a `test/` folder.
4. **Set wifi:** edit `test/wpa_supplicant.conf` on the card — real SSID + password.
5. **Set network:** edit `test/yi-hack.cfg` on the card — `IP`, `NETMASK`,
   `GATEWAY`, `NAMESERVER`, `ROOT_PASSWORD`, `TIMEZONE`.
6. **Eject** the card cleanly, insert it into the camera.
7. **Power on.** Watch the LED:
   - **yellow** = starting up
   - **blue blinking** = connecting wifi / setting IP
   - **solid blue** = ready ✅
8. **Test HTTP:** browse to `http://<camera-ip>/` — you should see the yi-hack page
   (matches `http_server.png` in the repo).
9. **Test the video (RTSP):** in VLC → File → Open Network → paste:
   - HD: `rtsp://<camera-ip>:554/ch0_0.h264`
   - Low: `rtsp://<camera-ip>:554/ch0_1.h264`
   - Audio only: `rtsp://<camera-ip>:554/ch0_3.h264`

If solid blue + VLC shows video → **Phase 1 done.**

---

## 6. Keeping it off the internet (recommended)

The hack already stops the cloud process. To be certain nothing phones home, also
**block the camera at the router**:
- Give the camera's IP/MAC a firewall rule that **denies WAN/internet access** but
  still allows LAN. (Wording varies by router: "Block Internet Access",
  "Access Control", "Parental Controls", or a firewall deny rule.)
- Trade-off: this also blocks **NTP time sync**. Either allow NTP (UDP 123) only,
  or accept that the clock resets on reboot. Not critical for just viewing.

**Security note:** telnet/FTP here have weak/no auth and traffic is plaintext.
Keep the camera on your trusted LAN (ideally a separate IoT VLAN). Never expose
these ports to the internet.

---

## 7. Verify and troubleshoot

- **No solid blue / stuck blinking:** wifi or IP problem. Most common causes:
  5 GHz SSID (needs 2.4 GHz), wrong password, IP not on your subnet.
- **Read the on-camera log:** telnet in and look at the hack's log:
  ```
  telnet <camera-ip>        # login root / your ROOT_PASSWORD
  cat /home/hd1/test/log.txt
  ```
  It logs each step (wifi status, IP, NTP, which RTSP/HTTP binary it picked).
- **HTTP works but no video:** the RTSP binary letter may not match the firmware.
  `equip_test.sh` picks `rtspsvr{I,K,M}` by firmware letter — the log shows which.
- **Card ignored entirely (boots stock):** likely a firmware mismatch → revisit §2,
  consider the modern fork.

---

## 8. Phase 2 — our own viewer (plan, not yet built)

Browsers can't play raw RTSP/h264 directly, so our web server will **re-package**
the camera's RTSP into something a browser shows (HLS or WebRTC), plus a simple page.

Likely approach (decide later):
- **Option A — `go2rtc`**: point it at the camera's RTSP, it serves WebRTC/HLS +
  a built-in web UI. Lowest effort, low latency. Good first target.
- **Option B — small custom app** (Node/Express or Python/FastAPI) that runs
  `ffmpeg` to convert RTSP → HLS and serves our own dashboard page. More control,
  more work. Good when we want custom UI + controls (snapshots, motion list).

Either runs on the Mac (or later a Raspberry Pi / mini server) on the LAN.

---

## 9. Phase 3 — poke further (idea backlog)

- Pull the motion clips + `/motion` endpoint into a timeline UI.
- **Snapshots** on demand; timelapse.
- **Motion → notification** (MQTT / Home Assistant / push / Telegram).
- Feed RTSP into **Frigate** for recording + person/car detection (NVR).
- Off-box backup of clips (the repo's `scripts/copy_to_ftp.sh` does FTP-to-NAS;
  we could do S3 instead).
- **Reverse-engineer** the ARM binaries (`http/server*`, `rtspsvr*`) or
  cross-compile our own for the Hi3518.
- Evaluate migrating to a modern fork for more features out of the box.

---

## 10. Constraints and safety

- **Reversible by design** — pull the card to revert (except the one sound file).
- **Don't expose** telnet/FTP/HTTP/RTSP to the internet. LAN/VLAN only.
- **No secrets in git:** wifi password and root password live only on the SD card
  copy, not committed. (Repo `.gitignore` already ignores generated files.)
- Read-only poking first; any on-camera change is logged here before we do it.

---

## Open questions / decisions (to resolve in Phase 0)

1. Exact camera firmware version — does this 2016 repo fit, or do we use a fork?
2. Your network values (§4 table).
3. Phase 2 viewer: go2rtc vs custom app.

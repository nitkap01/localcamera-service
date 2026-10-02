# Continuous recording

The viewer records the camera **all the time** into 5-minute MP4 clips on the NAS and keeps
**7 days**. Browse, play and download them in the **🎞 Recordings** tab.

```
NAS  //192.168.0.134/BACKUPS/camera feed/
       02_10_2026/
         02_10_2026_14_00_00.mp4   02_10_2026_14_05_00.mp4 …   (DD_MM_YYYY_HH_MM_SS, 24-hour, India time)
```

## How it works

- `viewer/recorder.js` runs one ffmpeg that **copies** the stream (no re-encode, ~1 Mbit/s,
  ≈ 75 GB per week) into clips aligned to the clock.
- It reads **go2rtc's local restream** (`rtsp://127.0.0.1:8554/nk-camera`), never the camera
  directly. The camera's RTSP server (rRTSPServer) only copes with a couple of clients; extra
  direct connections can freeze it. Snapshot / Record / MJPEG use the restream for the same reason.
- Clips are **fragmented MP4**: a crash or power cut loses seconds, and the clip being written
  can already be played.
- **Watchdog**: ffmpeg is restarted if it exits or the current clip stops growing for 90 s
  (retries every 3–15 s).
- **NAS fallback**: the share must contain the marker file `.nas-ok`. If it's missing or the share
  can't be written (NAS off, mount dropped, or an empty folder where the share should be), the
  recorder switches to a local buffer on the Docker host (`camera-buffer` volume) within 30 s and
  moves those clips to the NAS once it's back. The Recordings tab lists and plays both.
- **Retention**: every 10 minutes, clips older than `RECORD_RETENTION_DAYS` (7) are deleted, and if
  the recordings total more than `RECORD_MAX_GB` (80 GB) the oldest go until they fit. If the share
  itself drops under `RECORD_MIN_FREE_GB` free, the oldest go too.

| Variable | Default | |
|---|---|---|
| `RECORD_ENABLE` | `1` | `0` turns continuous recording off |
| `RECORD_DIR` | `/recordings` | where clips go (mount the NAS here) |
| `RECORD_RETENTION_DAYS` | `7` | how long to keep clips |
| `RECORD_SEGMENT_SECONDS` | `300` | clip length |
| `RECORD_MAX_GB` | `80` | total size cap; oldest clips are deleted first when over it |
| `RECORD_MIN_FREE_GB` | `20` | free-space floor on the share (and on the local buffer) |
| `RECORD_BUFFER_DIR` | `/recordings-buffer` | local fallback while the NAS is unreachable |
| `RECORD_NAS_MARKER` | `.nas-ok` | file that must exist on the share (empty = don't check) |
| `RECORD_MAX_EXPORT_MINUTES` | `240` | longest range one download can cover |
| `TZ` | `Asia/Kolkata` | clip and folder names |

API: `GET /api/health` (200 = recording, 503 = no new video for 5 min), `GET /api/recordings/status`, `/api/recordings/days`, `/api/recordings/day/02_10_2026`,
`/api/recordings/export?from=2026-10-02T14:00&to=2026-10-02T14:45`; clips at
`/recordings/<day>/<file>.mp4`.

## Storage: NAS through Proxmox

The Docker host (`portainer-ct`, Proxmox **CT 106**, 192.168.0.246) is an unprivileged LXC, which
can't mount SMB shares ("operation not permitted"). So the **Proxmox host (192.168.0.242)** mounts
the share and passes it into CT 106:

```bash
# on the Proxmox host (Node → Shell)
apt-get install -y cifs-utils
mkdir -p /mnt/nas-camera-feed
printf 'username=nkapoor\npassword=…\n' > /root/.smb-nas-camera && chmod 600 /root/.smb-nas-camera
echo '//192.168.0.134/BACKUPS/camera\040feed /mnt/nas-camera-feed cifs credentials=/root/.smb-nas-camera,vers=3.0,uid=100000,gid=100000,file_mode=0664,dir_mode=0775,noserverino,_netdev,nofail 0 0' >> /etc/fstab
systemctl daemon-reload && mount /mnt/nas-camera-feed
pct set 106 -mp0 /mnt/nas-camera-feed,mp=/mnt/camera-feed
pct reboot 106
```

`uid=100000` is root inside the unprivileged CT, which is what Docker containers there run as.
Inside CT 106 the share is `/mnt/camera-feed`; the compose file binds it to `/recordings`.

## Deploy (no Docker Hub)

```bash
scripts/deploy.sh      # copies viewer/ to portainer:~/localcamera-viewer, builds there, restarts
```

The image (`localcamera-viewer:local`) is built on the Docker host and never pushed. The host
keeps `~/localcamera-viewer/.env` with the name of the existing people-count volume.

## Camera self-healing

The camera's RTSP server sometimes stops sending video (seen after a client drops off, e.g. the
container restarting). `viewer/camera-heal.js` watches go2rtc's byte counter for the stream every
30 s; if nothing new arrives for `CAMERA_STALE_SECONDS` (120) it SSHes into the camera and restarts
`h264grabber` + `rRTSPServer` (retrying until port 554 is free), at most once per
`CAMERA_HEAL_COOLDOWN_SECONDS` (600). go2rtc reconnects on its own. The Recordings tab shows the
last automatic restart and offers **↻ Restart camera stream** while recording is down
(`POST /api/camera/restart-stream`). `CAMERA_HEAL=0` turns it off; `CAMERA_SSH_PASSWORD` if the
camera's root password is ever set (it's blank by default).

## Robustness — what keeps it recording

What went wrong on 02_10_2026: a redeploy hard-killed go2rtc, the camera's RTSP server froze on
the dropped connection, and for ~45 minutes nothing restarted it or told anyone. Now, layer by layer:

| Layer | Where | What it does |
|---|---|---|
| Recorder watchdog | `recorder.js` | restarts ffmpeg within 3–15 s; kills it if the clip stops growing for 90 s |
| Camera self-healing | `camera-heal.js` | no video for 2 min → SSH into the camera, restart its RTSP server |
| NAS fallback | `recorder.js` | NAS gone → record to the Docker host's disk, move clips back later |
| Clean shutdown | `docker-entrypoint.sh` | `docker stop` stops node (clip closed), then go2rtc (RTSP session ended properly — avoids the freeze) |
| Health check | `/api/health`, compose `healthcheck` | container shows *unhealthy* after 5 min without new video |
| Host watchdog | `scripts/host/camera-watchdog.sh`, nitin's cron on CT 106, every 2 min | container stopped → start it; unhealthy 3× in a row → restart it (max once per 30 min) |
| NAS check | `scripts/host/nas-camera-check.sh`, root cron on Proxmox, every 5 min | share dropped → remount; CT 106 can't see it → reboot CT 106 (max once per 2 h) |
| Boot order | `scripts/host/pve-guests-wait-nas.conf` on Proxmox | containers start after the NAS mount has been tried |
| Email alerts | `alerts.js`, both scripts | recording stopped/resumed, camera restarted (or failed), NAS down/back, container restarted, daily summary at 9:00 |

**Email alerts** go through Gmail with an app password. Credentials live only on the hosts:
`~/localcamera-viewer/.env` on CT 106 (`ALERT_SMTP_USER`, `ALERT_SMTP_PASS`, `ALERT_TO`) and
`/root/.camera-alert.env` on Proxmox. The same alert repeats at most every 30 min
(`ALERT_REPEAT_MINUTES`), max 30 a day (`ALERT_MAX_PER_DAY`); `ALERT_DAILY_HOUR` (9) sets the summary
time. Test: `curl -XPOST http://192.168.0.246:8080/api/alerts/test`.

**Installing the host pieces** — `scripts/deploy.sh` installs the CT 106 watchdog and its cron. On Proxmox, once:

```bash
scp scripts/host/nas-camera-check.sh root@192.168.0.242:/usr/local/bin/
scp scripts/host/pve-guests-wait-nas.conf root@192.168.0.242:/etc/systemd/system/pve-guests.service.d/wait-nas-camera.conf
ssh root@192.168.0.242 'chmod +x /usr/local/bin/nas-camera-check.sh; systemctl daemon-reload;
  (crontab -l; echo "*/5 * * * * /usr/local/bin/nas-camera-check.sh >> /var/log/nas-camera-check.log 2>&1") | crontab -'
# plus /root/.camera-alert.env (chmod 600) with the three ALERT_* lines
```

Logs: `docker logs camera`, `~/.camera-watchdog.log` on CT 106, `/var/log/nas-camera-check.log` on Proxmox.

## Troubleshooting

- **"Not recording"** in the tab: see the error next to it, or `docker logs camera | grep recorder`.
- **"NAS unreachable"** in the tab: recording continues locally. Check the NAS, then on Proxmox
  `mount | grep nas-camera`; the 5-minute check remounts it. The marker `.nas-ok` must stay on the share.
- **Share missing**: `ls /mnt/camera-feed` in CT 106; on Proxmox `mount | grep nas-camera`,
  then `mount /mnt/nas-camera-feed` and `pct reboot 106` if needed.
- **Camera frozen** (live view stuck, counter says `fetch failed`): restart its stream —
  kill `rRTSPServer` and `h264grabber` by PID over `scripts/cam-ssh.sh` and start them again
  from `/tmp/sd/yi-hack-v3/rtsp` with `LD_LIBRARY_PATH` set (busybox has no `killall`/`nohup`;
  see `sd-card/yi-hack-v3/rtsp-start.sh`).

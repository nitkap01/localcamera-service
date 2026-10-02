# Continuous recording

The viewer records the camera **all the time** into 5-minute MP4 clips on the NAS and keeps
**7 days**. Browse, play and download them in the **🎞 Recordings** tab.

```
NAS  //192.168.0.134/BACKUPS/camera feed/
       2026-10-02/
         14-00-00.mp4   14-05-00.mp4   14-10-00.mp4 …    (India time, one folder per day)
```

## How it works

- `viewer/recorder.js` runs one ffmpeg that **copies** the stream (no re-encode, ~0.6 Mbit/s,
  ≈ 46–70 GB per week) into clips aligned to the clock.
- It reads **go2rtc's local restream** (`rtsp://127.0.0.1:8554/nk-camera`), never the camera
  directly. The camera's RTSP server (rRTSPServer) only copes with a couple of clients; extra
  direct connections can freeze it. Snapshot / Record / MJPEG use the restream for the same reason.
- Clips are **fragmented MP4**: a crash or power cut loses seconds, and the clip being written
  can already be played.
- **Watchdog**: ffmpeg is restarted if it exits or the current clip stops growing for 90 s.
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
| `RECORD_MIN_FREE_GB` | `20` | free-space floor on the share |
| `RECORD_MAX_EXPORT_MINUTES` | `240` | longest range one download can cover |
| `TZ` | `Asia/Kolkata` | clip and folder names |

API: `GET /api/recordings/status`, `/api/recordings/days`, `/api/recordings/day/2026-10-02`,
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

## Troubleshooting

- **"Not recording"** in the tab: see the error next to it, or `docker logs camera | grep recorder`.
- **Share missing**: `ls /mnt/camera-feed` in CT 106; on Proxmox `mount | grep nas-camera`,
  then `mount /mnt/nas-camera-feed` and `pct reboot 106` if needed.
- **Camera frozen** (live view stuck, counter says `fetch failed`): restart its stream —
  kill `rRTSPServer` and `h264grabber` by PID over `scripts/cam-ssh.sh` and start them again
  from `/tmp/sd/yi-hack-v3/rtsp` with `LD_LIBRARY_PATH` set (busybox has no `killall`/`nohup`;
  see `sd-card/yi-hack-v3/rtsp-start.sh`).

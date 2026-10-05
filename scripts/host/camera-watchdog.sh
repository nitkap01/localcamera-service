#!/usr/bin/env bash
# Docker-host watchdog for the camera container (runs from cron every 2 minutes, as nitin):
#   - container missing/stopped  -> start it (docker compose up -d)
#   - NAS share back on the host but invisible inside the container -> restart it (CAM-8)
#   - unhealthy 3 checks in a row (= no new video for ~11 min, self-healing didn't fix it)
#                                -> restart the container, at most once per 30 minutes
# and emails what it did, using ALERT_* from ~/localcamera-viewer/.env.
#   crontab:  */2 * * * * ~/localcamera-viewer/host/camera-watchdog.sh >> ~/.camera-watchdog.log 2>&1
set -u
DIR="$HOME/localcamera-viewer"
STATE="$HOME/.camera-watchdog"
NAME=camera
mkdir -p "$STATE"
set -a; . "$DIR/.env" 2>/dev/null; set +a
now=$(date +%s)
log() { echo "$(date '+%d_%m_%Y_%H_%M_%S') $*"; }
# scripts/deploy.sh pauses the watchdog while it rebuilds (ignored if older than 15 min)
[ -f "$STATE/pause" ] && [ $((now - $(stat -c %Y "$STATE/pause"))) -lt 900 ] && exit 0

mail() {   # mail "subject" "body" — once per 30 min per subject
  [ -n "${ALERT_SMTP_PASS:-}" ] || return 0
  local key; key=$(echo "$1" | tr -c 'a-zA-Z0-9' _)
  local last; last=$(cat "$STATE/mail_$key" 2>/dev/null || echo 0)
  [ $((now - last)) -ge 1800 ] || return 0
  echo "$now" > "$STATE/mail_$key"
  printf 'From: Camera watchdog <%s>\r\nTo: %s\r\nSubject: [Camera] %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n\r\n— %s watchdog, %s\r\n' \
    "$ALERT_SMTP_USER" "$ALERT_TO" "$1" "$2" "$(hostname)" "$(date '+%d_%m_%Y %H:%M:%S')" |
  curl -sS --max-time 30 --ssl-reqd --url smtps://smtp.gmail.com:465 --user "$ALERT_SMTP_USER:$ALERT_SMTP_PASS" \
    --mail-from "$ALERT_SMTP_USER" --mail-rcpt "$ALERT_TO" -T - || log "mail failed"
}

state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME" 2>/dev/null)
if [ -z "$state" ] || [ "${state%% *}" != running ]; then
  st=${state%% *}; st=${st:-missing}
  log "container $st — starting it"
  out=$(cd "$DIR" && docker compose up -d 2>&1 | tail -3)
  mail "Container was $st — started it" "The camera container was '$st'. The watchdog ran 'docker compose up -d':
$out"
  echo 0 > "$STATE/unhealthy"
  exit 0
fi

# NAS came back but the container can't see it (CAM-8): a share mounted after the container started
# stays invisible inside it, so the recorder keeps buffering locally. If the share is visible here
# (/mnt/camera-feed) but the recorder still reports the NAS down on 2 checks in a row (~4 min),
# restart the container (max once per 30 min); buffered clips are moved to the NAS afterwards.
if timeout 10 test -f /mnt/camera-feed/.nas-ok; then
  if curl -s --max-time 10 localhost:8080/api/health | grep -q '"nasOk":false'; then
    n=$(( $(cat "$STATE/nas_blind" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE/nas_blind"
    log "share visible on the host but the container sees the NAS as down ($n)"
    last=$(cat "$STATE/nas_restart" 2>/dev/null || echo 0)
    if [ "$n" -ge 2 ] && [ $((now - last)) -ge 1800 ]; then
      log "restarting container to reattach the NAS"
      docker restart -t 20 "$NAME" >/dev/null
      echo "$now" > "$STATE/nas_restart"; echo 0 > "$STATE/nas_blind"
      mail "Container restarted to reattach the NAS" "The NAS share was back on the Docker host but the camera container could not see it, so the watchdog restarted the container. Buffered clips move to the NAS on their own."
      exit 0
    fi
  else
    echo 0 > "$STATE/nas_blind"
  fi
fi

health=${state#* }
if [ "$health" = unhealthy ]; then
  n=$(( $(cat "$STATE/unhealthy" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$STATE/unhealthy"
  log "unhealthy ($n)"
  last=$(cat "$STATE/restarted" 2>/dev/null || echo 0)
  if [ "$n" -ge 3 ] && [ $((now - last)) -ge 1800 ]; then
    detail=$(curl -s --max-time 10 localhost:8080/api/health | head -c 1500)
    log "restarting container"
    docker restart -t 20 "$NAME" >/dev/null
    echo "$now" > "$STATE/restarted"
    echo 0 > "$STATE/unhealthy"
    mail "Container restarted (no video)" "The camera container reported no new video for over 10 minutes and self-healing didn't fix it, so the watchdog restarted it.

Health before restart:
$detail

If this repeats, the camera may be offline or powered off — check it at 192.168.0.143."
  fi
else
  [ "$(cat "$STATE/unhealthy" 2>/dev/null)" = 0 ] || log "healthy again"
  echo 0 > "$STATE/unhealthy"
fi

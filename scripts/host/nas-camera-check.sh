#!/usr/bin/env bash
# Proxmox host (192.168.0.242), root cron every 5 minutes:
#   */5 * * * * /usr/local/bin/nas-camera-check.sh >> /var/log/nas-camera-check.log 2>&1
# 1. NAS share not mounted or not answering -> remount it.
# 2. Share fine here but the Docker CT (106) can't see it (it started while the NAS was down,
#    or still holds a dead mount) -> reboot the CT, at most once per 2 hours.
# Meanwhile the camera container records to local disk and moves clips over once the NAS is back.
# Emails via ALERT_* in /root/.camera-alert.env (root-only).
set -u
MNT=/mnt/nas-camera-feed
CT=106
CT_MNT=/mnt/camera-feed
MARK=.nas-ok
STATE=/var/lib/nas-camera-check
mkdir -p "$STATE"
. /root/.camera-alert.env 2>/dev/null
now=$(date +%s)
log() { echo "$(date '+%d_%m_%Y_%H_%M_%S') $*"; }
mail() {
  [ -n "${ALERT_SMTP_PASS:-}" ] || return 0
  local key; key=$(echo "$1" | tr -c 'a-zA-Z0-9' _)
  local last; last=$(cat "$STATE/mail_$key" 2>/dev/null || echo 0)
  [ $((now - last)) -ge 3600 ] || return 0
  echo "$now" > "$STATE/mail_$key"
  printf 'From: Proxmox <%s>\r\nTo: %s\r\nSubject: [Camera] %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n\r\n— %s, %s\r\n' \
    "$ALERT_SMTP_USER" "$ALERT_TO" "$1" "$2" "$(hostname)" "$(date '+%d_%m_%Y %H:%M:%S')" |
  curl -sS --max-time 30 --ssl-reqd --url smtps://smtp.gmail.com:465 --user "$ALERT_SMTP_USER:$ALERT_SMTP_PASS" \
    --mail-from "$ALERT_SMTP_USER" --mail-rcpt "$ALERT_TO" -T - || log "mail failed"
}

host_ok() { mountpoint -q "$MNT" && timeout 20 test -f "$MNT/$MARK"; }

if ! host_ok; then
  log "NAS share not usable on the host — remounting"
  umount -l "$MNT" 2>/dev/null
  if timeout 60 mount "$MNT" && host_ok; then
    log "remounted"
    mail "NAS share remounted on Proxmox" "//192.168.0.134/BACKUPS/Camera had dropped and was mounted again on the Proxmox host."
    echo 1 > "$STATE/remounted"
  else
    log "remount failed"
    mail "NAS share is DOWN" "Couldn't mount //192.168.0.134/BACKUPS/Camera on the Proxmox host.
Is the NAS (192.168.0.134) on? Recording continues on the Docker host's disk meanwhile and moves to the NAS once it's back."
    exit 0
  fi
fi

# share is fine here; can the Docker CT see it?
[ "$(pct status $CT 2>/dev/null)" = "status: running" ] || exit 0
if ! timeout 30 pct exec $CT -- test -f "$CT_MNT/$MARK"; then
  last=$(cat "$STATE/ct_reboot" 2>/dev/null || echo 0)
  if [ $((now - last)) -ge 7200 ]; then
    log "CT $CT can't see the NAS share — rebooting it"
    echo "$now" > "$STATE/ct_reboot"
    pct reboot $CT --timeout 120
    mail "Docker CT rebooted to reattach the NAS" "CT $CT (Docker host) couldn't see the NAS share at $CT_MNT, so it was rebooted. Containers restart on their own; buffered clips move to the NAS."
  else
    log "CT $CT can't see the NAS share (rebooted recently, waiting)"
  fi
fi

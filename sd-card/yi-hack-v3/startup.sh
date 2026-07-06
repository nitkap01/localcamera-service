#!/bin/sh
# yi-hack-v3 app-free WiFi bring-up (no Yi app / no Yi account, avoids region-lock).
# Runs from /tmp/sd/yi-hack-v3/startup.sh on every boot (called by system.sh).
# Non-blocking (backgrounded) so a failure never hangs the camera boot.
# Diagnostic log written to the SD card: /tmp/sd/yi-hack-v3/wifi-boot.log

LOG=/tmp/sd/yi-hack-v3/wifi-boot.log
CONF=/tmp/sd/yi-hack-v3/wpa_supplicant.conf

{
  echo "=== startup.sh run at $(date) ==="
  # let the stock init load the wifi driver and create wlan0 first
  sleep 15
  ifconfig wlan0 up 2>&1

  # wpa_supplicant lives in different places across builds — find it
  WPA=""
  for p in /home/base/tools/wpa_supplicant /usr/sbin/wpa_supplicant \
           /sbin/wpa_supplicant /home/app/bin/wpa_supplicant \
           $(command -v wpa_supplicant 2>/dev/null); do
    [ -x "$p" ] && WPA="$p" && break
  done
  echo "using wpa_supplicant = ${WPA:-NOT_FOUND}"

  killall wpa_supplicant 2>/dev/null
  if [ -n "$WPA" ]; then
    # no -D flag: let it auto-detect the driver (wlan0 = cfg80211)
    "$WPA" -B -i wlan0 -c "$CONF" 2>&1
  fi

  sleep 10
  killall udhcpc 2>/dev/null
  /sbin/udhcpc -i wlan0 -b -s /home/app/script/default.script 2>&1

  sleep 5
  echo "--- wlan0 state ---"
  ifconfig wlan0 2>&1
  echo "=== wifi startup done ==="
} >> "$LOG" 2>&1 &

# --- start the RTSP server after the camera has fully booted (encoder up) ---
{
  sleep 30
  echo "=== starting RTSP at $(date) ==="
  sh /tmp/sd/yi-hack-v3/rtsp-start.sh
  echo "=== RTSP launch done ==="
} >> "$LOG" 2>&1 &

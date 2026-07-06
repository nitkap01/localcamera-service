#!/bin/sh
# Probe the running camera: which services are up + web UI title.
# Usage: scripts/camera-info.sh [ip]   (defaults to CAMERA_IP in config.env)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
IP="${1:-$CAMERA_IP}"
[ -n "$IP" ] || { echo "usage: $0 <ip>  (or set CAMERA_IP in config.env)"; exit 1; }

echo "camera: $IP"
echo "-- ports --"
for pn in "80/http-webui" "21/ftp" "22/ssh" "23/telnet" "554/rtsp"; do
    p="${pn%%/*}"; name="${pn##*/}"
    if nc -z -G 1 "$IP" "$p" 2>/dev/null; then
        echo "   $p ($name) OPEN"
    else
        echo "   $p ($name) closed"
    fi
done

echo "-- web UI --"
curl -s -m 6 "http://$IP/" | sed -nE 's@.*<title>(.*)</title>.*@   title: \1@p'
echo "   open: http://$IP/"
echo
echo "note: 554 (rtsp) stays closed until the RTSP add-on is installed (see viewer/README.md)."

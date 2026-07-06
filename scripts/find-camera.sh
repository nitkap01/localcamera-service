#!/bin/sh
# Find the yi-hack camera on the LAN by its open ports + web title.
# Usage: scripts/find-camera.sh   (reads LAN_SUBNET from config.env; default 192.168.0)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
SUB="${LAN_SUBNET:-192.168.0}"

echo ">> ping-sweeping ${SUB}.0/24 to refresh ARP ..."
for i in $(seq 1 254); do ping -c1 -W120 -t1 "${SUB}.${i}" >/dev/null 2>&1 & done
wait

echo ">> checking live hosts for the camera (web :80 + ftp :21 / ssh :22) ..."
found=""
arp -an | grep "${SUB}." | grep -v incomplete | sed -nE 's/.*\(([0-9.]+)\).*/\1/p' \
  | sort -u -t. -k4 -n | while read -r ip; do
    nc -z -G 1 "$ip" 80 2>/dev/null || continue
    ftp=""; ssh=""
    nc -z -G 1 "$ip" 21 2>/dev/null && ftp="ftp"
    nc -z -G 1 "$ip" 22 2>/dev/null && ssh="ssh"
    title=$(curl -s -m 4 "http://$ip/" | sed -nE 's:.*<title>(.*)</title>.*:\1:p' | head -1)
    echo "   $ip  web:80 $ftp $ssh  title:'${title}'"
done

echo ">> the camera is the host whose title is 'Yi Camera'. Open http://<that-ip>/"

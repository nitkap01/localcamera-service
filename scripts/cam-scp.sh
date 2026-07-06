#!/bin/sh
# Copy a file/dir TO the camera over scp (legacy protocol for old dropbear).
# Usage: scripts/cam-scp.sh <local-src> <remote-dest>
#   e.g. scripts/cam-scp.sh ./foo /tmp/sd/yi-hack-v3/foo
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
IP="${CAMERA_IP:-192.168.0.143}"
SRC="$1"; DST="$2"
[ -n "$SRC" ] && [ -n "$DST" ] || { echo "usage: $0 <local-src> <remote-dest>"; exit 1; }

exec scp -O -r \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1 \
  -o HostKeyAlgorithms=+ssh-rsa,ssh-dss -o PubkeyAcceptedAlgorithms=+ssh-rsa \
  -o Ciphers=+aes128-cbc,3des-cbc -o PreferredAuthentications=password \
  "$SRC" "root@$IP:$DST"

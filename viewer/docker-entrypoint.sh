#!/bin/sh
# Start go2rtc (WebRTC) + the Node viewer in one container.
# If either process dies, exit so the container's restart policy can recover.
set -e

export CAMERA_IP="${CAMERA_IP:-192.168.0.143}"
export PORT="${PORT:-8080}"
export GO2RTC_PORT="${GO2RTC_PORT:-1984}"

echo "localcamera-service viewer (docker)"
echo "  camera : $CAMERA_IP"
echo "  viewer : http://<host>:$PORT"
echo "  go2rtc : http://<host>:$GO2RTC_PORT  (WebRTC)"

# go2rtc reads ${CAMERA_IP} from its yaml via env substitution.
go2rtc -config /app/go2rtc/go2rtc.yaml &
G2=$!

node /app/server.js &
NODE=$!

# Portable watch (busybox ash has no `wait -n`): stop when either child exits.
while kill -0 "$G2" 2>/dev/null && kill -0 "$NODE" 2>/dev/null; do
  sleep 5
done

kill "$G2" "$NODE" 2>/dev/null || true
exit 1

#!/bin/sh
# Start the camera viewer: go2rtc (WebRTC engine) + the Node app.
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
export CAMERA_IP="${CAMERA_IP:-192.168.0.143}"
export PORT="${PORT:-8080}"

echo "camera : $CAMERA_IP"
echo "viewer : http://localhost:$PORT   (phone: http://<this-mac-ip>:$PORT)"
echo "go2rtc : http://localhost:1984    (WebRTC)"

# start go2rtc (WebRTC) if present; keep it alongside the node server
if [ -x go2rtc/go2rtc ]; then
  CAMERA_IP="$CAMERA_IP" ./go2rtc/go2rtc -config go2rtc/go2rtc.yaml &
  G2=$!
  trap 'kill $G2 2>/dev/null' INT TERM EXIT
else
  echo "(go2rtc binary missing — WebRTC disabled, MJPEG still works. See viewer/README.md)"
fi

node server.js

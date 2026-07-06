#!/bin/sh
# Start the RTSP server on the camera.
# Runs the roleo h264grabber + rRTSPServer from the SD card.
# Model: yi_home  (the 720p Yi Home / y18 — do NOT use yi_home_1080p here).
# Serves: rtsp://<cam-ip>:554/ch0_0.h264 (HD)  and  ch0_1.h264 (SD)
RTSP_DIR=/tmp/sd/yi-hack-v3/rtsp
# /home/lib has libpthread.so.0 + libgcc; the rtsp dir has libstdc++.so.6
export LD_LIBRARY_PATH="$RTSP_DIR:/home/lib:/lib:/usr/lib:$LD_LIBRARY_PATH"
cd "$RTSP_DIR" || exit 1

killall rRTSPServer h264grabber 2>/dev/null
sleep 1

# HD only (ch0_0). The camera's native low/SD substream is corrupt on this
# firmware+grabber, so the viewer makes "SD" by downscaling HD instead.
./h264grabber -r high -m yi_home -f &
sleep 2
./rRTSPServer -r high &

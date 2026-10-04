#!/bin/bash
# At the next camera freeze, restart ONLY h264grabber and see if video resumes (root-cause test).
CAM=/home/nitin/projects/camera/scripts/cam-ssh.sh
OUT=/home/nitin/projects/camera/docs/grabber-test-$(date +%d_%m_%Y).txt
tx(){ timeout 6 $CAM 'grep wlan0 /proc/net/dev' 2>/dev/null | tr -s ' ' | cut -d' ' -f11; }
echo "=== start $(date +%T)" > $OUT
prev=$(tx); stall=0; end=$(( $(date +%s) + 86400 ))
while [ $(date +%s) -lt $end ]; do
  sleep 3; cur=$(tx); [ -z "$cur" ] && continue
  d=$(( cur - prev )); prev=$cur
  if [ $d -lt 20000 ]; then stall=$((stall+1)); else stall=0; fi
  if [ $stall -ge 2 ]; then
    echo "$(date +%T) STALL detected (tx +$d B in 3 s)" >> $OUT
    timeout 30 $CAM 'echo "before: $(ps w | grep -E "h264grabber|rRTSPServer" | grep -v grep)"; for p in $(ps w | grep h264grabber | grep -v grep | while read pid r; do echo $pid; done); do kill $p; done; sleep 1; cd /tmp/sd/yi-hack-v3/rtsp && export LD_LIBRARY_PATH=/tmp/sd/yi-hack-v3/rtsp:/home/lib:/lib:/usr/lib; trap "" HUP; ./h264grabber -r high -m yi_home -f </dev/null >/tmp/grab.log 2>&1 & sleep 1; echo "after: $(ps w | grep -E "h264grabber|rRTSPServer" | grep -v grep)"' >> $OUT 2>&1
    echo "$(date +%T) restarted ONLY h264grabber; watching tx:" >> $OUT
    p=$(tx); for i in $(seq 1 8); do sleep 3; c=$(tx); echo "  $(date +%T) tx +$((c-p)) B/3s" >> $OUT; p=$c; done
    echo "=== done $(date +%T)" >> $OUT; exit 0
  fi
done
echo "=== no stall within 24 h" >> $OUT

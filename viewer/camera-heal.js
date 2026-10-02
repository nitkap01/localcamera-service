'use strict';
// Camera stream self-healing.
//
// The camera's RTSP server (rRTSPServer, LIVE555) sometimes stops sending video — typically
// after a client drops off (e.g. this container restarting). go2rtc stays connected but gets
// nothing, so live view, the people counter and the recorder all stall.
//
// Every 30 s this checks go2rtc's byte counter for the camera stream. If it hasn't moved for
// CAMERA_STALE_SECONDS (default 120), it SSHes into the camera and restarts h264grabber +
// rRTSPServer (retrying rRTSPServer until port 554 is free again). go2rtc reconnects by itself.
// At most once per CAMERA_HEAL_COOLDOWN_SECONDS (default 600).
const { spawn } = require('child_process');

// busybox on the camera has no killall/nohup/head: kill by PID, ignore HUP, retry the bind
const RESTART_SCRIPT = [
  'for p in $(ps w | grep -E "rRTSPServer|h264grabber" | grep -v grep | while read pid rest; do echo $pid; done); do kill $p; done',
  'sleep 2',
  'cd /tmp/sd/yi-hack-v3/rtsp || exit 1',
  'export LD_LIBRARY_PATH=/tmp/sd/yi-hack-v3/rtsp:/home/lib:/lib:/usr/lib',
  'trap "" HUP',
  './h264grabber -r high -m yi_home -f </dev/null >/tmp/grab.log 2>&1 &',
  'sleep 2',
  'i=0; while [ $i -lt 12 ]; do i=$((i+1)); ./rRTSPServer -r high </dev/null >/tmp/rs.log 2>&1 & sleep 5;'
    + ' if ps w | grep -v grep | grep -q rRTSPServer; then echo "rtsp started (try $i)"; exit 0; fi; sleep 5; done',
  'echo "rtsp failed: $(tail -1 /tmp/rs.log)"; exit 1',
].join('\n');

function createCameraHealer(opts) {
  const {
    camIp,
    go2rtcUrl,
    stream = 'nk-camera',
    user = 'root',
    password = '',
    staleMs = 120e3,
    cooldownMs = 600e3,
    onEvent = () => {},   // ('heal', { ok, reason, output })
    log = console,
  } = opts;

  let lastBytes = null;
  let lastProgress = Date.now();
  let lastHeal = null;          // { at, ok, output }
  let healing = false;
  let heals = 0;
  let timer = null;

  async function producerBytes() {
    const r = await fetch(`${go2rtcUrl}/api/streams?src=${encodeURIComponent(stream)}`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    const producers = d.producers || [];
    if (!producers.length) return null;
    return producers.reduce((n, p) => n + (p.receivers || []).reduce((m, x) => m + (x.bytes || 0), 0), 0);
  }

  function restartCameraStream(reason) {
    if (healing) return Promise.resolve(lastHeal);
    healing = true;
    heals += 1;
    log.warn(`camera-heal: ${reason} — restarting the camera's RTSP server`);
    return new Promise((resolve) => {
      const args = [
        '-p', password, 'ssh',
        '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
        '-o', 'KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1',
        '-o', 'HostKeyAlgorithms=+ssh-rsa,ssh-dss', '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa',
        '-o', 'Ciphers=+aes128-cbc,3des-cbc', '-o', 'PreferredAuthentications=password',
        '-o', 'ConnectTimeout=15', `${user}@${camIp}`, RESTART_SCRIPT,
      ];
      const p = spawn('sshpass', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { out += c; });
      const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* */ } }, 150e3);
      const finish = (ok) => {
        clearTimeout(kill);
        healing = false;
        lastHeal = { at: new Date().toISOString(), ok, reason, output: out.trim().split('\n').slice(-3).join(' | ') };
        lastProgress = Date.now();   // give go2rtc time to reconnect before judging again
        (ok ? log.log : log.error)(`camera-heal: ${ok ? 'done' : 'FAILED'} — ${lastHeal.output}`);
        try { onEvent('heal', lastHeal); } catch (e) { /* */ }
        resolve(lastHeal);
      };
      p.on('error', (e) => { out += e.message; finish(false); });
      p.on('exit', (code) => finish(code === 0));
    });
  }

  async function check() {
    let b = null;
    try { b = await producerBytes(); } catch (e) { return; }   // go2rtc busy/restarting: try again later
    // any change counts as progress (a reconnect resets the counter); no producer = no video
    if (b != null) {
      if (lastBytes != null && b !== lastBytes) lastProgress = Date.now();
      lastBytes = b;
    }
    const stale = Date.now() - lastProgress;
    const cooled = !lastHeal || Date.now() - new Date(lastHeal.at).getTime() > cooldownMs;
    if (stale > staleMs && cooled && !healing) {
      restartCameraStream(`no video from the camera for ${Math.round(stale / 1000)}s`);
    }
  }

  return {
    start() { timer = setInterval(check, 30e3); },
    stop() { clearInterval(timer); },
    restart: (reason = 'manual restart') => restartCameraStream(reason),
    status() {
      return { videoAgeSeconds: Math.round((Date.now() - lastProgress) / 1000), heals, healing, lastHeal };
    },
  };
}

module.exports = { createCameraHealer };

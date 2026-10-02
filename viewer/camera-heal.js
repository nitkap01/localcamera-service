'use strict';
// Camera stream self-healing.
//
// The camera's RTSP server (rRTSPServer, LIVE555) sometimes stops sending video — typically
// after a client drops off (e.g. this container restarting). go2rtc stays connected but gets
// nothing, so live view, the people counter and the recorder all stall.
//
// Every 10 s this checks go2rtc's byte counter for the camera stream. If it hasn't moved for
// CAMERA_STALE_SECONDS (default 60), it SSHes into the camera and restarts h264grabber +
// rRTSPServer (retrying rRTSPServer until port 554 is free again). go2rtc reconnects by itself.
// At most once per CAMERA_HEAL_COOLDOWN_SECONDS (default 600).
const { spawn } = require('child_process');

// busybox on the camera has no killall/nohup/head: kill by PID, ignore HUP, retry the bind
const RESTART_SCRIPT = [
  // evidence first: what state were the stream processes in when the video stopped?
  'echo "diag: load $(cat /proc/loadavg | cut -d" " -f1-3); $(grep MemFree /proc/meminfo | tr -s " "); rtsp clients $(grep -c ":022A [0-9A-F:]* 01" /proc/net/tcp)"',
  'for n in rRTSPServer h264grabber rmm; do for p in $(ps w | grep "$n" | grep -v grep | while read pid rest; do echo $pid; done); do'
    + ' echo "diag: $n pid $p state $(cut -d" " -f3 /proc/$p/stat) wchan $(cat /proc/$p/wchan 2>/dev/null) cpu $(cut -d" " -f14-15 /proc/$p/stat)"; done; done',
  'echo "diag: rs.log: $(tail -2 /tmp/rs.log 2>/dev/null | tr "\\n" " ")"; echo "diag: grab.log: $(tail -2 /tmp/grab.log 2>/dev/null | tr "\\n" " ")"',
  'cp /tmp/rs.log /tmp/rs.log.prev 2>/dev/null; cp /tmp/grab.log /tmp/grab.log.prev 2>/dev/null',
  'for p in $(ps w | grep -E "rRTSPServer|h264grabber" | grep -v grep | while read pid rest; do echo $pid; done); do kill $p; done',
  'sleep 2',
  'cd /tmp/sd/yi-hack-v3/rtsp || exit 1',
  'export LD_LIBRARY_PATH=/tmp/sd/yi-hack-v3/rtsp:/home/lib:/lib:/usr/lib',
  'trap "" HUP',
  './h264grabber -r high -m yi_home -f </dev/null >/tmp/grab.log 2>&1 &',
  'sleep 2',
  'i=0; while [ $i -lt 30 ]; do i=$((i+1)); ./rRTSPServer -r high </dev/null >/tmp/rs.log 2>&1 & sleep 3;'
    + ' if ps w | grep -v grep | grep -q rRTSPServer; then echo "rtsp started (try $i)"; exit 0; fi; done',
  'echo "rtsp failed: $(tail -1 /tmp/rs.log)"; exit 1',
].join('\n');

function createCameraHealer(opts) {
  const {
    camIp,
    go2rtcUrl,
    stream = 'nk-camera',
    user = 'root',
    password = '',
    staleMs = 60e3,
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
  let reconnects = 0;
  let lastReconnect = null;

  async function producerBytes() {
    const r = await fetch(`${go2rtcUrl}/api/streams?src=${encodeURIComponent(stream)}`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    const producers = d.producers || [];
    if (!producers.length) return { bytes: null, conn: null };
    return {
      bytes: producers.reduce((n, p) => n + (p.receivers || []).reduce((m, x) => m + (x.bytes || 0), 0), 0),
      conn: producers.map((p) => p.id).join(','),   // go2rtc gives every camera connection a new id
    };
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
        const lines = out.trim().split('\n');
        lastHeal = {
          at: new Date().toISOString(), ok, reason,
          output: lines.filter((l) => !l.startsWith('diag:')).slice(-3).join(' | '),
          diag: lines.filter((l) => l.startsWith('diag:')).map((l) => l.slice(6)),
        };
        if (lastHeal.diag.length) log.warn('camera-heal: camera state before restart:\n  ' + lastHeal.diag.join('\n  '));
        lastProgress = Date.now();   // give go2rtc time to reconnect before judging again
        (ok ? log.log : log.error)(`camera-heal: ${ok ? 'done' : 'FAILED'} — ${lastHeal.output}`);
        try { onEvent('heal', lastHeal); } catch (e) { /* */ }
        resolve(lastHeal);
      };
      p.on('error', (e) => { out += e.message; finish(false); });
      p.on('exit', (code) => finish(code === 0));
    });
  }

  // The camera's RTSP server often sends nothing usable to a client that connects after another one
  // left (e.g. after this container restarts). So: watch for go2rtc (re)connecting, and if a fresh
  // connection brings no video within FRESH_MS, restart the camera's stream right away.
  const FRESH_MS = 25e3;
  let conn = null;
  let connAt = 0;
  let connBytes = null;
  async function check() {
    let r = null;
    try { r = await producerBytes(); } catch (e) { return; }   // go2rtc busy/restarting: try again later
    const b = r.bytes;
    if (r.conn && r.conn !== conn) {
      if (conn) log.warn(`camera-heal: go2rtc reconnected to the camera (connection ${conn} -> ${r.conn})`);
      reconnects += conn ? 1 : 0;
      lastReconnect = conn ? new Date().toISOString() : lastReconnect;
      conn = r.conn; connAt = Date.now(); connBytes = b;
    }
    // any change counts as progress (a reconnect resets the counter); no producer = no video
    if (b != null) {
      if (lastBytes != null && b !== lastBytes) lastProgress = Date.now();
      lastBytes = b;
    }
    const stale = Date.now() - lastProgress;
    const sinceHeal = lastHeal ? Date.now() - new Date(lastHeal.at).getTime() : Infinity;
    // a fresh connection that has delivered (almost) nothing: about 50 KB = a couple of seconds of video
    const freshDead = conn && Date.now() - connAt > FRESH_MS && Date.now() - connAt < 5 * 60e3
      && (b == null || b - (connBytes || 0) < 50e3) && stale > FRESH_MS;
    if (healing) return;
    if (freshDead && sinceHeal > 120e3) {
      restartCameraStream(`camera connection ${conn} brought no video in ${Math.round((Date.now() - connAt) / 1000)}s`);
    } else if (stale > staleMs && sinceHeal > cooldownMs) {
      restartCameraStream(`no video from the camera for ${Math.round(stale / 1000)}s`);
    }
  }

  return {
    start() { timer = setInterval(check, 10e3); },
    stop() { clearInterval(timer); },
    restart: (reason = 'manual restart') => restartCameraStream(reason),
    status() {
      return { videoAgeSeconds: Math.round((Date.now() - lastProgress) / 1000), heals, healing, lastHeal, connection: conn, reconnects, lastReconnect };
    },
  };
}

module.exports = { createCameraHealer };

'use strict';
// Local web viewer for the yi-hack camera.
// Live view: WebRTC (via go2rtc, sub-second) with MJPEG fallback (this server).
// Also: snapshot, record, rotate/mirror, SD (downscale), hide-watermark,
// and continuous recording to disk (recorder.js) with a Recordings browser.
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function loadCameraIp() {
  if (process.env.CAMERA_IP) return process.env.CAMERA_IP;
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', 'config.env'), 'utf8');
    const m = txt.match(/^\s*CAMERA_IP\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  } catch (e) { /* ignore */ }
  return '192.168.0.143';
}
const CAM_IP = loadCameraIp();
const PORT = parseInt(process.env.PORT || '8080', 10);
const GO2RTC_PORT = parseInt(process.env.GO2RTC_PORT || '1984', 10);

// --- human counter (person detection -> SQLite) ---
const { createCounter } = require('./counter');
const COUNT_ENABLE = process.env.COUNT_ENABLE !== '0';
const counter = COUNT_ENABLE ? createCounter({
  dbPath: process.env.DB_PATH || path.join(__dirname, 'data', 'occupancy.db'),
  frameUrl: process.env.COUNT_FRAME_URL || `http://127.0.0.1:${GO2RTC_PORT}/api/frame.jpeg?src=nk-camera`,
  modelDir: path.join(__dirname, 'models', 'coco-ssd'),
  yoloModelPath: process.env.YOLO_MODEL || path.join(__dirname, 'models', 'yolo', 'yolov10n.onnx'),
  detector: process.env.DETECTOR || 'cocossd',
  intervalMs: parseInt(process.env.COUNT_INTERVAL_MS || '4000', 10),
  minScore: parseFloat(process.env.COUNT_MIN_SCORE || '0.45'),
  threads: parseInt(process.env.COUNT_THREADS || '2', 10),
}) : null;

// --- email alerts (alerts.js); credentials only in the host's .env ---
const { createAlerter } = require('./alerts');
const alerter = createAlerter({
  user: process.env.ALERT_SMTP_USER || '',
  pass: process.env.ALERT_SMTP_PASS || '',
  to: process.env.ALERT_TO || '',
  repeatMs: parseInt(process.env.ALERT_REPEAT_MINUTES || '30', 10) * 60e3,
  maxPerDay: parseInt(process.env.ALERT_MAX_PER_DAY || '30', 10),
});
const fmtTime = (iso) => new Date(iso).toLocaleString('en-GB', { hour12: false });

// --- continuous recorder (5-min clips per day folder, kept RECORD_RETENTION_DAYS) ---
const { createRecorder } = require('./recorder');
const RECORD_ENABLE = process.env.RECORD_ENABLE !== '0';
const recorder = RECORD_ENABLE ? createRecorder({
  dir: process.env.RECORD_DIR || path.join(__dirname, 'recordings'),
  bufferDir: process.env.RECORD_BUFFER_DIR || null,
  marker: process.env.RECORD_NAS_MARKER === '' ? null : (process.env.RECORD_NAS_MARKER || '.nas-ok'),
  source: process.env.RECORD_SOURCE || 'rtsp://127.0.0.1:8554/nk-camera',
  segmentSeconds: parseInt(process.env.RECORD_SEGMENT_SECONDS || '300', 10),
  retentionDays: parseFloat(process.env.RECORD_RETENTION_DAYS || '7'),
  minFreeGb: parseFloat(process.env.RECORD_MIN_FREE_GB || '20'),
  maxGb: parseFloat(process.env.RECORD_MAX_GB || '80'),
  onEvent(type, d) {
    if (type === 'nas_down') alerter.alert('NAS unavailable — recording to local disk', `The NAS share isn't reachable (or its marker file is missing).\nRecording continues on the Docker host${d.bufferDir ? ` (${d.bufferDir})` : ''}; clips move to the NAS automatically once it's back.\n\nCheck on Proxmox: mount | grep nas-camera`, { key: 'nas' });
    if (type === 'nas_up') alerter.alert('NAS is back', 'Recording to the NAS again; buffered clips are being moved over.', { key: 'nas', force: true });
    if (type === 'recording_down') alerter.alert('Recording stopped', `No new video since ${fmtTime(d.since)}.\nLast error: ${d.lastErr || '—'}\n\nSelf-healing keeps trying. Recordings tab: http://192.168.0.246:8080`, { key: 'rec' });
    if (type === 'recording_up') alerter.alert('Recording resumed', `Video is flowing again (down ${d.minutes} min, since ${fmtTime(d.since)}).`, { key: 'rec', force: true });
  },
}) : null;

// --- camera self-healing: restart the camera's RTSP server if video stops (camera-heal.js) ---
const { createCameraHealer } = require('./camera-heal');
const healer = process.env.CAMERA_HEAL !== '0' && (RECORD_ENABLE || COUNT_ENABLE) ? createCameraHealer({
  camIp: CAM_IP,
  go2rtcUrl: `http://127.0.0.1:${GO2RTC_PORT}`,
  user: process.env.CAMERA_SSH_USER || 'root',
  password: process.env.CAMERA_SSH_PASSWORD || '',
  staleMs: parseInt(process.env.CAMERA_STALE_SECONDS || '120', 10) * 1000,
  cooldownMs: parseInt(process.env.CAMERA_HEAL_COOLDOWN_SECONDS || '600', 10) * 1000,
  onEvent(type, h) {
    if (h.ok) alerter.alert('Camera stream restarted', `Reason: ${h.reason}\nResult: ${h.output}`, { key: 'heal' });
    else alerter.alert('Camera stream restart FAILED', `Reason: ${h.reason}\nOutput: ${h.output}\n\nThe camera may be offline or powered off (ping ${CAM_IP}). Self-healing retries every 10 min.`, { key: 'healfail' });
  },
}) : null;

// daily summary email at ALERT_DAILY_HOUR (default 9:00 local), so silence never hides a dead alerter
const DAILY_HOUR = parseInt(process.env.ALERT_DAILY_HOUR || '9', 10);
let lastDaily = null;
setInterval(() => {
  const now = new Date();
  if (!alerter.enabled || now.getHours() !== DAILY_HOUR || lastDaily === now.toDateString()) return;
  lastDaily = now.toDateString();
  const s = recorder ? recorder.status() : null;
  const h = healer ? healer.status() : null;
  const days = recorder ? recorder.days() : [];
  const gb = (b) => (b / 1e9).toFixed(1);
  const lines = s ? [
    `Recording: ${s.recording ? 'OK' : 'NOT RECORDING'} (writing to ${s.writingTo}), current clip ${s.current || '—'}`,
    `Kept: ${days.length} day(s), ${gb(s.lastCleanup ? s.lastCleanup.totalBytes : 0)} GB of ${s.maxGb} GB; NAS free ${s.freeBytes != null ? gb(s.freeBytes) + ' GB' : '?'}`,
    `Buffered on local disk (waiting for NAS): ${s.bufferedClips}`,
    ...days.slice(0, 8).map((d) => `  ${d.day}: ${d.clips} clips, ${(d.seconds / 3600).toFixed(1)} h, ${gb(d.bytes)} GB`),
  ] : ['Recording is off.'];
  if (h) lines.push(`Camera auto-restarts so far: ${h.heals}${h.lastHeal ? `, last ${fmtTime(h.lastHeal.at)} (${h.lastHeal.ok ? 'ok' : 'failed'})` : ''}`);
  alerter.alert(`Daily summary — ${s && s.recording ? 'all good' : 'NEEDS ATTENTION'}`, lines.join('\n'), { key: 'daily', force: true });
}, 60e3);

// The camera serves only the HD stream (ch0_0). "SD" = HD downscaled by ffmpeg
// (the camera's native low substream is corrupt on this firmware).
const rtspUrl = () => `rtsp://${CAM_IP}:554/ch0_0.h264`;
// Snapshot / Record / MJPEG read go2rtc's local restream instead of the camera: the camera's
// RTSP server only copes with a couple of clients, and go2rtc already holds one for live view,
// the people counter and the continuous recorder.
const RESTREAM_URL = process.env.RESTREAM_URL || 'rtsp://127.0.0.1:8554/nk-camera';
const liveInput = () => ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-i', RESTREAM_URL];
const fileInput = () => ['-rtsp_transport', 'tcp', '-i', RESTREAM_URL];

// The "YI" watermark is burned into the stream by the camera; delogo blurs it out.
// Coords are for the raw 1280x720 frame (applied BEFORE scale/rotate).
const LOGO = 'delogo=x=8:y=636:w=95:h=76';

function buildFilters(o) {
  const f = [];
  if (o.hidelogo) f.push(LOGO);
  // image adjust: brightness (ffmpeg 0=neutral; UI sends 1=neutral), contrast/saturation (1=neutral), hue (deg)
  if (o.b !== 1 || o.c !== 1 || o.s !== 1) f.push(`eq=brightness=${(o.b - 1).toFixed(3)}:contrast=${o.c.toFixed(3)}:saturation=${o.s.toFixed(3)}`);
  if (o.hue) f.push(`hue=h=${o.hue}`);
  if (o.q === 'sd') f.push('scale=640:-2');
  if (o.rot === 90) f.push('transpose=1');
  else if (o.rot === 180) f.push('transpose=1,transpose=1');
  else if (o.rot === 270) f.push('transpose=2');
  if (o.mirror) f.push('hflip');
  return f;
}
const vf = (f) => (f.length ? ['-vf', f.join(',')] : []);

function opts(req) {
  const r = parseInt(req.query.rot || '0', 10);
  const num = (v, d, lo, hi) => { const n = parseFloat(v); return isNaN(n) ? d : Math.min(Math.max(n, lo), hi); };
  return {
    q: req.query.q === 'sd' ? 'sd' : 'hd',
    rot: [0, 90, 180, 270].includes(r) ? r : 0,
    mirror: req.query.mirror === '1',
    hidelogo: req.query.hidelogo === '1',
    b: num(req.query.b, 1, 0.2, 2),   // brightness (UI 1 = neutral)
    c: num(req.query.c, 1, 0.2, 2),   // contrast
    s: num(req.query.s, 1, 0, 3),     // saturation
    hue: num(req.query.hue, 0, -180, 180),
  };
}

const app = express();

// --- LIVE MJPEG (fallback / "clean" mode: supports hide-logo, SD, server rotate) ---
app.get('/stream.mjpeg', (req, res) => {
  const f = buildFilters(opts(req));
  const args = [...liveInput(), ...vf(f), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-r', '15', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const B = 'lcsframe';
  res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${B}`, 'Cache-Control': 'no-cache, no-store', 'Connection': 'close' });
  const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    let s = buf.indexOf(SOI), e = s === -1 ? -1 : buf.indexOf(EOI, s + 2);
    while (s !== -1 && e !== -1) {
      const fr = buf.slice(s, e + 2);
      res.write(`--${B}\r\nContent-Type: image/jpeg\r\nContent-Length: ${fr.length}\r\n\r\n`);
      res.write(fr); res.write('\r\n');
      buf = buf.slice(e + 2);
      s = buf.indexOf(SOI); e = s === -1 ? -1 : buf.indexOf(EOI, s + 2);
    }
    if (buf.length > 5_000_000) buf = Buffer.alloc(0);
  });
  const kill = () => { try { ff.kill('SIGKILL'); } catch (e) { /* */ } };
  req.on('close', kill);
  ff.on('exit', () => { try { res.end(); } catch (e) { /* */ } });
});

// --- SNAPSHOT ---
app.get('/snapshot.jpg', (req, res) => {
  const f = buildFilters(opts(req));
  const args = [...liveInput(), ...vf(f), '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  if (req.query.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="snapshot.jpg"');
  ff.stdout.pipe(res);
  ff.on('error', () => { try { res.status(500).end(); } catch (e) { /* */ } });
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) { /* */ } });
});

// --- RECORD (N seconds -> MP4) ---
app.get('/record', (req, res) => {
  const o = opts(req);
  const secs = Math.min(Math.max(parseInt(req.query.seconds || '15', 10) || 15, 1), 300);
  const f = buildFilters(o);
  const enc = f.length
    ? [...vf(f), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
    : ['-c', 'copy'];
  const args = [...fileInput(), '-t', String(secs), ...enc, '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="recording_${secs}s.mp4"`);
  ff.stdout.pipe(res);
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) { /* */ } });
});

app.get('/api/info', (req, res) => res.json({ camera: CAM_IP, go2rtcPort: GO2RTC_PORT, rtsp: rtspUrl(), counter: COUNT_ENABLE, recorder: RECORD_ENABLE }));

// Health: 200 when video is being recorded, 503 otherwise (Docker HEALTHCHECK + the host watchdog use it).
// Starting up (first 3 min) counts as healthy.
const BOOT = Date.now();
app.get('/api/health', (req, res) => {
  const s = recorder ? recorder.status() : null;
  const h = healer ? healer.status() : null;
  const booting = Date.now() - BOOT < 3 * 60e3;
  const ok = !recorder || booting || s.videoAgeSeconds < 300;
  res.status(ok ? 200 : 503).json({ ok, booting, recording: s, camera: h, alerts: alerter.status() });
});
app.post('/api/alerts/test', (req, res) => {
  if (!alerter.enabled) return res.status(409).json({ error: 'alerts are off: set ALERT_SMTP_USER, ALERT_SMTP_PASS, ALERT_TO' });
  alerter.alert('Test alert', 'If you can read this, camera alerts work.', { key: 'test', force: true }).then((ok) => res.status(ok ? 200 : 502).json({ ok }));
});

// --- recordings API ---
const noRec = (res) => res.status(409).json({ error: 'continuous recording is off (RECORD_ENABLE=0)' });
app.get('/api/recordings/status', (req, res) => (recorder ? res.json({ ...recorder.status(), camera: healer ? healer.status() : null, alerts: alerter.status() }) : noRec(res)));
// restart the camera's RTSP server now (the same thing the self-healing does after 2 min without video)
app.post('/api/camera/restart-stream', (req, res) => {
  if (!healer) return res.status(409).json({ error: 'camera self-healing is off (CAMERA_HEAL=0)' });
  healer.restart('restarted from the Recordings tab').then((r) => res.status(r && r.ok ? 200 : 502).json(r));
});
app.get('/api/recordings/days', (req, res) => (recorder ? res.json(recorder.days()) : noRec(res)));
app.get('/api/recordings/day/:day', (req, res) => {
  if (!recorder) return noRec(res);
  const list = recorder.clips(req.params.day);
  return list ? res.json(list) : res.status(400).json({ error: 'day must look like 02_10_2026 (DD_MM_YYYY)' });
});
// One MP4 for a time range (local time as ISO, e.g. ?from=2026-10-02T14:00&to=2026-10-02T14:45): the clips are
// joined and trimmed without re-encoding, so cuts land on the nearest keyframe (within ~2s).
const MAX_EXPORT_MIN = parseInt(process.env.RECORD_MAX_EXPORT_MINUTES || '240', 10);
app.get('/api/recordings/export', (req, res) => {
  if (!recorder) return noRec(res);
  const from = new Date(req.query.from), to = new Date(req.query.to);
  if (isNaN(from) || isNaN(to) || to <= from) return res.status(400).json({ error: 'give ?from= and ?to= as local times, from before to' });
  if ((to - from) / 60e3 > MAX_EXPORT_MIN) return res.status(400).json({ error: `export up to ${MAX_EXPORT_MIN} minutes at a time` });
  const clips = recorder.clipsBetween(from, to);
  if (!clips.length) return res.status(404).json({ error: 'no recording in that time range' });
  const list = path.join(require('os').tmpdir(), `export-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(list, clips.map((c) => `file '${c.path.replace(/'/g, "'\\''")}'`).join('\n'));
  const first = new Date(clips[0].start);
  const offset = Math.max(0, (from - first) / 1000);
  const dur = (to - Math.max(from, first)) / 1000;
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-ss', offset.toFixed(2), '-t', dur.toFixed(2), '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${p2(d.getDate())}_${p2(d.getMonth() + 1)}_${d.getFullYear()}_${p2(d.getHours())}_${p2(d.getMinutes())}_${p2(d.getSeconds())}`;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="camera_${stamp(from)}_to_${stamp(to)}.mp4"`);
  ff.stdout.pipe(res);
  const done = () => fs.rm(list, () => {});
  ff.on('exit', done);
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) { /* */ } });
});
// the clips themselves (range requests work, so the browser can seek)
if (recorder) {
  app.use('/recordings', express.static(recorder.dir, { acceptRanges: true, maxAge: 0, index: false, dotfiles: 'ignore' }));
  // clips still waiting in the local buffer (NAS was down)
  if (recorder.bufferDir) app.use('/recordings', express.static(recorder.bufferDir, { acceptRanges: true, maxAge: 0, index: false, dotfiles: 'ignore' }));
}

// --- human counter API ---
app.get('/api/occupancy/now', (req, res) => res.json(counter ? counter.now() : { ts: null, count: null }));
app.get('/api/occupancy/status', (req, res) => res.json(counter ? counter.status() : { ready: false, running: false, disabled: true }));
app.get('/api/occupancy', (req, res) => res.json(counter ? counter.series(req.query.range) : { range: 'hour', points: [], disabled: true }));

// switch detection engine at runtime (cocossd | yolo); loads the model on first use
app.post('/api/occupancy/detector/:name', (req, res) => {
  if (!counter) return res.status(409).json({ error: 'counter disabled' });
  counter.setDetector(req.params.name)
    .then(() => res.json(counter.status()))
    .catch((e) => res.status(400).json({ error: e.message }));
});

// Assets for the browser-side detection overlay. Served from this host so the
// viewer keeps working on a LAN with no internet (nothing comes from a CDN).
const staticOpts = { maxAge: '7d', immutable: true };   // runtime + models are version-pinned
app.use('/vendor/mediapipe', express.static(path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision'), staticOpts));
app.use('/models/mediapipe', express.static(path.join(__dirname, 'models', 'mediapipe'), staticOpts));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log('localcamera-service viewer');
  console.log(`  camera : ${CAM_IP}`);
  console.log(`  local  : http://localhost:${PORT}`);
  console.log(`  webrtc : via go2rtc on :${GO2RTC_PORT}`);
  if (healer) {
    healer.start();
    console.log('  heal   : restarts the camera stream if video stops for 2 min');
  }
  console.log(`  alerts : ${alerter.enabled ? 'email to ' + alerter.status().to : 'off (set ALERT_SMTP_USER/PASS/TO)'}`);
  if (recorder) {
    recorder.start();
    console.log(`  record : continuous, ${recorder.status().segmentSeconds / 60}-min clips in ${recorder.dir}, kept ${recorder.status().retentionDays} days`);
  }
  if (counter) {
    counter.start()
      .then(() => { const s = counter.status(); console.log(`  counter: detecting people (${s.detector} / ${s.backend})`); })
      .catch((e) => console.error('  counter: failed to start —', e.message));
  }
});

// let the recorder close its current clip cleanly on container stop
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { if (healer) healer.stop(); if (recorder) recorder.stop(); setTimeout(() => process.exit(0), 3000); });
}

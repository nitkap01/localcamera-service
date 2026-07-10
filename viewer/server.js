'use strict';
// Local web viewer for the yi-hack camera.
// Live view: WebRTC (via go2rtc, sub-second) with MJPEG fallback (this server).
// Also: snapshot, record, rotate/mirror, SD (downscale), hide-watermark.
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

// The camera serves only the HD stream (ch0_0). "SD" = HD downscaled by ffmpeg
// (the camera's native low substream is corrupt on this firmware).
const rtspUrl = () => `rtsp://${CAM_IP}:554/ch0_0.h264`;
const liveInput = () => ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-i', rtspUrl()];
const fileInput = () => ['-rtsp_transport', 'tcp', '-i', rtspUrl()];

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

app.get('/api/info', (req, res) => res.json({ camera: CAM_IP, go2rtcPort: GO2RTC_PORT, rtsp: rtspUrl(), counter: COUNT_ENABLE }));

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

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log('localcamera-service viewer');
  console.log(`  camera : ${CAM_IP}`);
  console.log(`  local  : http://localhost:${PORT}`);
  console.log(`  webrtc : via go2rtc on :${GO2RTC_PORT}`);
  if (counter) {
    counter.start()
      .then(() => { const s = counter.status(); console.log(`  counter: detecting people (${s.detector} / ${s.backend})`); })
      .catch((e) => console.error('  counter: failed to start —', e.message));
  }
});

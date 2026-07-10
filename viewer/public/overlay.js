'use strict';
// Live detection overlay — runs in the BROWSER, on the frame you are looking at.
// Boxes therefore line up with the video and cost the server nothing. The
// server-side people counter is untouched: it keeps its own 4s sampling loop.
//
//   people  ObjectDetector (efficientdet_lite0) -> person boxes + score
//   hands   GestureRecognizer -> hand box + gesture name + score
//   face    FaceLandmarker    -> face box + strongest expression + score
//
// Runtime and models are served from this host (see server.js) — nothing is
// fetched from a CDN, so it works on a LAN with no internet.
import { FilesetResolver, ObjectDetector, GestureRecognizer, FaceLandmarker }
  from '/vendor/mediapipe/vision_bundle.mjs';

const WASM = '/vendor/mediapipe/wasm';
const MODELS = '/models/mediapipe';
const DETECT_HZ = 12;   // inference rate; drawing still follows the display refresh
const COLORS = { people: '#3da2ff', hands: '#ffb020', face: '#38d39f' };

const pretty = (s) => String(s || '').replace(/_/g, ' ');            // Thumb_Up -> "Thumb Up"
const humanize = (s) => String(s || '').replace(/([A-Z])/g, ' $1').trim().toLowerCase();  // mouthSmileLeft -> "mouth smile left"
const pct = (n) => n.toFixed(2);

export function createOverlay({ stage, canvas, getRot, getMirror, getCover, onNote }) {
  const ctx = canvas.getContext('2d');
  const layers = { people: false, hands: false, face: false };
  const tasks = { people: null, hands: null, face: null };
  const last = { people: null, hands: null, face: null };
  let fileset = null, raf = null, lastDetect = 0, lastTs = 0;

  const anyOn = () => layers.people || layers.hands || layers.face;
  const note = (m) => onNote && onNote(m);

  async function vision() {
    if (!fileset) fileset = await FilesetResolver.forVisionTasks(WASM);
    return fileset;
  }

  // GPU where the browser allows it; some drivers refuse, so fall back to CPU.
  async function build(kind) {
    const fs = await vision();
    const make = (delegate) => {
      if (kind === 'people') return ObjectDetector.createFromOptions(fs, {
        baseOptions: { modelAssetPath: `${MODELS}/efficientdet_lite0.tflite`, delegate },
        runningMode: 'VIDEO', scoreThreshold: 0.4, categoryAllowlist: ['person'],
      });
      if (kind === 'hands') return GestureRecognizer.createFromOptions(fs, {
        baseOptions: { modelAssetPath: `${MODELS}/gesture_recognizer.task`, delegate },
        runningMode: 'VIDEO', numHands: 2,
      });
      return FaceLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: `${MODELS}/face_landmarker.task`, delegate },
        runningMode: 'VIDEO', numFaces: 2, outputFaceBlendshapes: true,
      });
    };
    try { return await make('GPU'); } catch (e) { return await make('CPU'); }
  }

  async function setLayer(name, on) {
    if (on && !tasks[name]) tasks[name] = await build(name);   // model downloads once
    layers[name] = on;
    if (!on) last[name] = null;
    if (anyOn()) start(); else stop();
  }

  // --- geometry -------------------------------------------------------------
  const media = () => stage.querySelector('video, img');
  const natural = (m) => (m.tagName === 'VIDEO'
    ? { w: m.videoWidth, h: m.videoHeight }
    : { w: m.naturalWidth, h: m.naturalHeight });
  const ready = (m) => (m.tagName === 'VIDEO' ? m.readyState >= 2 : m.complete && m.naturalWidth > 0);

  // Layout box of the media element relative to the canvas's positioned parent.
  // offsetLeft/Top ignore CSS transforms, which is what we want here.
  function boxOf(m) {
    let x = 0, y = 0, n = m;
    const stop = canvas.offsetParent;
    while (n && n !== stop) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x, y, w: m.offsetWidth, h: m.offsetHeight };
  }

  // Where the picture actually sits inside that box (object-fit: contain/cover).
  function content(box, nat) {
    const s = getCover()
      ? Math.max(box.w / nat.w, box.h / nat.h)
      : Math.min(box.w / nat.w, box.h / nat.h);
    const w = nat.w * s, h = nat.h * s;
    return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
  }

  function wipe() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function sync(box) {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.left = box.x + 'px';
    canvas.style.top = box.y + 'px';
    canvas.style.width = box.w + 'px';
    canvas.style.height = box.h + 'px';
    const bw = Math.round(box.w * dpr), bh = Math.round(box.h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
  }

  // --- drawing --------------------------------------------------------------
  function box(x, y, w, h, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }
  function tag(x, y, text, color) {
    ctx.font = '600 13px ui-sans-serif, system-ui, -apple-system, sans-serif';
    const w = ctx.measureText(text).width + 10, h = 19;
    const ty = y - h < 0 ? y + 2 : y - h - 2;
    ctx.globalAlpha = 0.88; ctx.fillStyle = color;
    ctx.fillRect(x, ty, w, h);
    ctx.globalAlpha = 1; ctx.fillStyle = '#0b0e12';
    ctx.fillText(text, x + 5, ty + 14);
  }
  // normalized (0..1, source space) -> canvas px, honouring the mirror toggle
  function project(c, nx, ny) {
    const mx = getMirror() ? 1 - nx : nx;
    return [c.x + mx * c.w, c.y + ny * c.h];
  }
  function drawNormBox(c, nx, ny, nw, nh, text, color) {
    const [x1] = project(c, getMirror() ? nx + nw : nx, 0);
    const y1 = c.y + ny * c.h;
    box(x1, y1, nw * c.w, nh * c.h, color);
    if (text) tag(x1, y1, text, color);
  }
  const extents = (pts) => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
    return { x0, y0, x1, y1 };
  };

  function drawPeople(c, res) {
    for (const d of res.detections || []) {
      const b = d.boundingBox, cat = d.categories && d.categories[0];
      if (!b || !cat) continue;
      drawNormBox(c, b.originX / c.nw, b.originY / c.nh, b.width / c.nw, b.height / c.nh,
        `person ${pct(cat.score)}`, COLORS.people);
    }
  }
  function drawHands(c, res) {
    (res.landmarks || []).forEach((pts, i) => {
      const e = extents(pts), pad = 0.02;
      const g = res.gestures && res.gestures[i] && res.gestures[i][0];
      const hand = res.handedness && res.handedness[i] && res.handedness[i][0];
      const name = g && g.categoryName && g.categoryName !== 'None' ? pretty(g.categoryName) : 'hand';
      const score = g && g.categoryName !== 'None' ? ` ${pct(g.score)}` : '';
      const who = hand ? `${hand.categoryName} · ` : '';
      drawNormBox(c, Math.max(0, e.x0 - pad), Math.max(0, e.y0 - pad),
        Math.min(1, e.x1 - e.x0 + pad * 2), Math.min(1, e.y1 - e.y0 + pad * 2),
        `${who}${name}${score}`, COLORS.hands);
      ctx.fillStyle = COLORS.hands;
      for (const p of pts) {
        const [px, py] = project(c, p.x, p.y);
        ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
      }
    });
  }
  function drawFace(c, res) {
    (res.faceLandmarks || []).forEach((pts, i) => {
      const e = extents(pts), pad = 0.015;
      let text = 'face';
      const shapes = res.faceBlendshapes && res.faceBlendshapes[i];
      if (shapes && shapes.categories) {
        // strongest expression, ignoring the "neutral" baseline
        const top = shapes.categories
          .filter((b) => b.categoryName && b.categoryName !== '_neutral')
          .reduce((a, b) => (b.score > a.score ? b : a), { score: 0, categoryName: '' });
        if (top.score > 0.25) text = `${humanize(top.categoryName)} ${pct(top.score)}`;
      }
      drawNormBox(c, Math.max(0, e.x0 - pad), Math.max(0, e.y0 - pad),
        Math.min(1, e.x1 - e.x0 + pad * 2), Math.min(1, e.y1 - e.y0 + pad * 2), text, COLORS.face);
    });
  }

  // --- loop -----------------------------------------------------------------
  function detect(m, ts) {
    if (layers.people && tasks.people) last.people = tasks.people.detectForVideo(m, ts);
    if (layers.hands && tasks.hands) last.hands = tasks.hands.recognizeForVideo(m, ts);
    if (layers.face && tasks.face) last.face = tasks.face.detectForVideo(m, ts);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    const m = media();
    if (!m || !ready(m)) { wipe(); return; }   // stream torn down / tab switched
    const nat = natural(m);
    if (!nat.w || !nat.h) { wipe(); return; }

    // CSS rotation moves the picture but not the layout box, so the overlay
    // would sit crooked. Pause it rather than draw boxes in the wrong place.
    if (getRot() !== 0) { canvas.style.display = 'none'; note('overlay paused while rotated'); return; }
    // must be an explicit value: display='' would drop back to the stylesheet's
    // `#overlay { display:none }` and we'd draw into an invisible canvas.
    canvas.style.display = 'block';

    const b = boxOf(m);
    if (!b.w || !b.h) return;
    sync(b);

    const now = performance.now();
    if (now - lastDetect >= 1000 / DETECT_HZ) {
      lastDetect = now;
      const ts = Math.max(now, lastTs + 1);   // MediaPipe needs strictly increasing stamps
      lastTs = ts;
      try { detect(m, ts); } catch (e) { note('detect: ' + e.message); }
    }

    const c = content(b, nat);
    c.nw = nat.w; c.nh = nat.h;
    if (layers.people && last.people) drawPeople(c, last.people);
    if (layers.hands && last.hands) drawHands(c, last.hands);
    if (layers.face && last.face) drawFace(c, last.face);
  }

  function start() {
    canvas.style.display = 'block';
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    wipe();
    canvas.style.display = 'none';
    note('');
  }

  return { setLayer, anyOn, stop };
}

'use strict';
// Human counter: samples a camera frame on an interval, counts the people in it
// with the active detector, and logs {ts, count, detector} to a local SQLite DB.
//
// Two detectors, swappable at runtime (see DETECTOR / setDetector):
//   cocossd  coco-ssd on TensorFlow.js/WASM — light, pure JS, any arch
//   yolo     YOLOv10n on onnxruntime-node   — more accurate, native CPU runtime
const path = require('path');
const fs = require('fs');
const jpeg = require('jpeg-js');
const Database = require('better-sqlite3');

// required lazily: only the engine you pick gets loaded
const DETECTORS = {
  cocossd: (o) => require('./detectors/cocossd').create(o),
  yolo: (o) => require('./detectors/yolo').create(o),
};
const NAMES = Object.keys(DETECTORS);
const ALIASES = { 'coco-ssd': 'cocossd', coco: 'cocossd', yolov10: 'yolo', yolov10n: 'yolo' };
const normalize = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return ALIASES[n] || n;
};

// time buckets per range so the chart payload stays small
const RANGES = {
  hour: { ms: 3600e3,   bucket: 30e3 },    // last hour, 30s buckets  (~120 pts)
  day:  { ms: 864e5,    bucket: 600e3 },   // last day, 10min buckets  (~144 pts)
  week: { ms: 6048e5,   bucket: 7200e3 },  // last week, 2h buckets    (~84 pts)
};

function createCounter(opts) {
  const {
    dbPath,
    frameUrl,
    modelDir,
    yoloModelPath,
    intervalMs = 4000,
    minScore = 0.45,
    threads = 2,
    detector: initialDetector = 'cocossd',
  } = opts;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS occupancy (ts INTEGER PRIMARY KEY, count INTEGER NOT NULL)');
  // DBs written before the YOLO mode have no detector column; two engines now
  // write to this table, so add it once to keep the counts attributable.
  if (!db.prepare('PRAGMA table_info(occupancy)').all().some((c) => c.name === 'detector')) {
    db.exec('ALTER TABLE occupancy ADD COLUMN detector TEXT');
  }
  const insert = db.prepare('INSERT OR REPLACE INTO occupancy (ts, count, detector) VALUES (?, ?, ?)');
  const latestRow = db.prepare('SELECT ts, count, detector FROM occupancy ORDER BY ts DESC LIMIT 1');

  const loaded = new Map();   // name -> detector; a model is only ever built once
  let active = null, ready = false, running = false, timer = null;
  let latest = { ts: null, count: null, detector: null };
  let lastErr = null;

  // Detections and detector swaps share one model/session, so run them one at a
  // time: a swap must never land in the middle of a sample.
  let chain = Promise.resolve();
  function serial(fn) {
    const p = chain.then(fn);
    chain = p.then(() => {}, () => {});   // never leave the chain rejected
    return p;
  }

  const optionsFor = (name) => (name === 'yolo'
    ? { modelPath: yoloModelPath, minScore, threads }
    : { modelDir, minScore });

  async function use(name) {
    const n = normalize(name);
    if (!DETECTORS[n]) throw new Error(`unknown detector "${name}" (have: ${NAMES.join(', ')})`);
    if (!loaded.has(n)) {
      const d = DETECTORS[n](optionsFor(n));
      await d.load();
      loaded.set(n, d);
    }
    active = loaded.get(n);
    ready = true;
    return active.name;
  }
  const setDetector = (name) => serial(() => use(name));

  async function grab() {
    const res = await fetch(frameUrl);
    if (!res.ok) throw new Error('frame http ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const { width, height, data } = jpeg.decode(buf, { useTArray: true }); // RGBA
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2]; }
    return { rgb, width, height };
  }

  async function detectOnce() {
    const { rgb, width, height } = await grab();
    const count = await active.count(rgb, width, height);
    const ts = Date.now();
    insert.run(ts, count, active.name);
    latest = { ts, count, detector: active.name };
    return latest;
  }
  const sample = () => serial(detectOnce);

  function loop() {
    timer = setTimeout(async () => {
      try { await sample(); lastErr = null; }
      catch (e) { lastErr = e.message; }
      if (running) loop();
    }, intervalMs);
  }

  async function start() {
    if (running) return;
    await setDetector(initialDetector);
    running = true;
    // fire one immediately, then on the interval
    try { await sample(); lastErr = null; } catch (e) { lastErr = e.message; }
    loop();
  }

  function stop() { running = false; clearTimeout(timer); }

  function now() {
    if (latest.ts) return latest;
    return latestRow.get() || { ts: null, count: null, detector: null };
  }

  function series(range) {
    const r = RANGES[range] || RANGES.hour;
    const since = Date.now() - r.ms;
    const points = db.prepare(
      `SELECT ts - ts % @b AS t, MAX(count) AS mx, ROUND(AVG(count), 2) AS av, COUNT(*) AS n
         FROM occupancy WHERE ts >= @since
        GROUP BY t ORDER BY t`
    ).all({ b: r.bucket, since });
    const agg = db.prepare(
      'SELECT MAX(count) AS peak, ROUND(AVG(count),2) AS avg, COUNT(*) AS samples FROM occupancy WHERE ts >= ?'
    ).get(since);
    return { range: RANGES[range] ? range : 'hour', bucketMs: r.bucket, since, now: Date.now(), points, ...agg };
  }

  function status() {
    return {
      ready, running,
      detector: active ? active.name : null,
      detectors: NAMES,
      backend: active ? active.backend() : null,
      latest, lastErr, intervalMs, minScore,
    };
  }

  return { start, stop, now, series, status, setDetector };
}

module.exports = { createCounter };

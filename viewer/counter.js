'use strict';
// Human counter: samples a camera frame on an interval, counts "person"
// detections with coco-ssd (TensorFlow.js on the WASM backend — no native deps,
// runs on any CPU / arch), and logs {count, timestamp} to a local SQLite DB.
const path = require('path');
const fs = require('fs');
const tf = require('@tensorflow/tfjs');
const wasm = require('@tensorflow/tfjs-backend-wasm');
const cocoSsd = require('@tensorflow-models/coco-ssd');
const jpeg = require('jpeg-js');
const Database = require('better-sqlite3');

// Load a tfjs GraphModel straight from local files (offline — no HTTP handler).
function fileHandler(dir) {
  return { load: async () => {
    const mj = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
    const specs = [], bufs = [];
    for (const g of mj.weightsManifest) {
      for (const p of g.paths) bufs.push(fs.readFileSync(path.join(dir, p)));
      specs.push(...g.weights);
    }
    const wd = Buffer.concat(bufs);
    return {
      modelTopology: mj.modelTopology, weightSpecs: specs,
      weightData: wd.buffer.slice(wd.byteOffset, wd.byteOffset + wd.byteLength),
      format: mj.format, generatedBy: mj.generatedBy, convertedBy: mj.convertedBy,
    };
  }};
}

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
    intervalMs = 4000,
    minScore = 0.45,
  } = opts;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS occupancy (ts INTEGER PRIMARY KEY, count INTEGER NOT NULL)');
  const insert = db.prepare('INSERT OR REPLACE INTO occupancy (ts, count) VALUES (?, ?)');
  const latestRow = db.prepare('SELECT ts, count FROM occupancy ORDER BY ts DESC LIMIT 1');

  let model = null, ready = false, running = false, timer = null;
  let latest = { ts: null, count: null };
  let lastErr = null;

  async function init() {
    wasm.setWasmPaths(path.join(__dirname, 'node_modules/@tensorflow/tfjs-backend-wasm/dist/'));
    try { await tf.setBackend('wasm'); await tf.ready(); }
    catch (e) { await tf.setBackend('cpu'); await tf.ready(); }
    model = await cocoSsd.load({ modelUrl: fileHandler(modelDir) });
    ready = true;
  }

  async function sample() {
    const res = await fetch(frameUrl);
    if (!res.ok) throw new Error('frame http ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const { width, height, data } = jpeg.decode(buf, { useTArray: true }); // RGBA
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2]; }
    const img = tf.tensor3d(rgb, [height, width, 3], 'int32');
    let preds;
    try { preds = await model.detect(img, 50, minScore); }
    finally { img.dispose(); }
    const count = preds.filter(p => p.class === 'person').length;
    const ts = Date.now();
    insert.run(ts, count);
    latest = { ts, count };
    return latest;
  }

  function loop() {
    timer = setTimeout(async () => {
      try { await sample(); lastErr = null; }
      catch (e) { lastErr = e.message; }
      if (running) loop();
    }, intervalMs);
  }

  async function start() {
    if (running) return;
    await init();
    running = true;
    // fire one immediately, then on the interval
    try { await sample(); lastErr = null; } catch (e) { lastErr = e.message; }
    loop();
  }

  function stop() { running = false; clearTimeout(timer); }

  function now() {
    if (latest.ts) return latest;
    return latestRow.get() || { ts: null, count: null };
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
    return { ready, running, backend: tf.getBackend(), latest, lastErr, intervalMs, minScore };
  }

  return { start, stop, now, series, status };
}

module.exports = { createCounter };

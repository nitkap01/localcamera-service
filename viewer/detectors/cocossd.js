'use strict';
// coco-ssd (ssdlite_mobilenet_v2) on TensorFlow.js / WASM.
// No native deps, so it runs on any CPU and arch. Lighter but less accurate
// than the YOLO detector.
const path = require('path');
const fs = require('fs');

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

function create({ modelDir, minScore }) {
  let tf = null, model = null;

  async function load() {
    // required lazily so picking the other engine doesn't pull tfjs in at all
    tf = require('@tensorflow/tfjs');
    const wasm = require('@tensorflow/tfjs-backend-wasm');
    const cocoSsd = require('@tensorflow-models/coco-ssd');
    wasm.setWasmPaths(path.join(__dirname, '..', 'node_modules/@tensorflow/tfjs-backend-wasm/dist/'));
    try { await tf.setBackend('wasm'); await tf.ready(); }
    catch (e) { await tf.setBackend('cpu'); await tf.ready(); }
    model = await cocoSsd.load({ modelUrl: fileHandler(modelDir) });
  }

  async function count(rgb, width, height) {
    const img = tf.tensor3d(rgb, [height, width, 3], 'int32');
    try {
      const preds = await model.detect(img, 50, minScore);
      return preds.filter((p) => p.class === 'person').length;
    } finally { img.dispose(); }
  }

  const backend = () => (tf ? tf.getBackend() : null);

  return { name: 'cocossd', load, count, backend };
}

module.exports = { create };

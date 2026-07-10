'use strict';
// YOLOv10n on onnxruntime-node (CPU).
//
// YOLOv10 is end-to-end: NMS is baked into the graph, so the model already
// returns de-duplicated boxes and there is no post-processing to get wrong.
//   input   images  float32 [1,3,640,640]  RGB, 0..1, letterboxed
//   output  output0 float32 [1,300,6]      x1,y1,x2,y2,score,class
const SIZE = 640;         // the model's fixed input size
const PERSON = 0;         // COCO class id
const PAD = 114 / 255;    // letterbox grey (matches how the model was trained)

function create({ modelPath, minScore, threads }) {
  let ort = null, session = null, inputName = null, outputName = null;
  // Reused across frames — safe because the counter runs detections one at a time.
  const input = new Float32Array(3 * SIZE * SIZE);

  async function load() {
    // required lazily so picking the other engine doesn't load the native runtime
    ort = require('onnxruntime-node');
    ort.env.logLevel = 'error';
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: threads,
    });
    [inputName] = session.inputNames;
    [outputName] = session.outputNames;
  }

  // Scale the frame to fit 640x640 keeping aspect, centre it, pad the rest grey.
  function letterbox(rgb, w, h) {
    const r = Math.min(SIZE / w, SIZE / h);
    const nw = Math.round(w * r), nh = Math.round(h * r);
    const ox = (SIZE - nw) >> 1, oy = (SIZE - nh) >> 1;
    const plane = SIZE * SIZE;
    input.fill(PAD);
    const sxs = new Int32Array(nw);           // source x per destination x
    for (let x = 0; x < nw; x++) sxs[x] = Math.min(w - 1, (x / r) | 0);
    for (let y = 0; y < nh; y++) {
      const row = Math.min(h - 1, (y / r) | 0) * w;
      const drow = (y + oy) * SIZE + ox;
      for (let x = 0; x < nw; x++) {
        const si = (row + sxs[x]) * 3;
        const di = drow + x;
        input[di] = rgb[si] / 255;
        input[plane + di] = rgb[si + 1] / 255;
        input[2 * plane + di] = rgb[si + 2] / 255;
      }
    }
  }

  async function count(rgb, width, height) {
    letterbox(rgb, width, height);
    const out = await session.run({ [inputName]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    const t = out[outputName];
    const d = t.data, rows = t.dims[1], stride = t.dims[2];
    let n = 0;
    for (let i = 0; i < rows; i++) {
      const o = i * stride;
      if (Math.round(d[o + 5]) === PERSON && d[o + 4] >= minScore) n++;
    }
    return n;
  }

  const backend = () => (session ? 'onnxruntime-cpu' : null);

  return { name: 'yolo', load, count, backend };
}

module.exports = { create };

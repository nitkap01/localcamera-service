# Task — YOLO detection mode (server-side)

_Date: 2026-07-10 · Repo: `localcamera-service`_

## Request

> "i want to have a YOLO detction mode as well , all running on the server"

Add YOLO as a second person-detection engine for the people counter, alongside
the existing coco-ssd. Everything runs on the server (in the Docker container on
Portainer) — no detection in the browser.

## Plan

1. Verify a YOLO ONNX model + a Node runtime that works on **both** `linux/amd64`
   and `linux/arm64` without compiling.
2. Split detection out of `counter.js` into two interchangeable detectors behind
   one small interface.
3. Let the engine be chosen by env var **and** swapped at runtime from the UI.
4. Record which engine produced each sample, so the history stays readable.
5. Package the model + runtime in the image; keep the image from ballooning.
6. Verify end-to-end against the real camera; document; commit.

## Decisions

| Decision | Why |
|---|---|
| **YOLOv10n** (`onnx-community/yolov10n`, 9MB fp32) | End-to-end: NMS is baked into the graph. Output is `[1,300,6]` of `x1,y1,x2,y2,score,class` — already de-duplicated, so **no NMS code to write or get wrong**. |
| **onnxruntime-node** (not tfjs, not onnxruntime-web) | Ships prebuilt CPU binaries for linux x64 + arm64 (verified). No native compile, no CUDA. Faster than the tfjs WASM path. |
| Keep **coco-ssd as the default** | It's the known-good engine already logging data. YOLO is opt-in until it has run for a while. |
| **Runtime swap**, not restart-only | "Mode" implies you can flip it and compare. Both models stay loaded once built. |
| Add `detector` column to `occupancy` | Two engines write to one table; without provenance the history becomes uninterpretable. |
| Serialize detect + swap on one promise chain | A swap must never land mid-sample (shared session/model). |

## Verified up front (before writing code)

- `onnx-community/yolov10n` → HTTP 206 on ranged GET; AGPL-3.0.
- Model IO: input `images` `[1,3,640,640]` f32; output `output0` `[1,300,6]` f32.
- Ran it on a **live frame from the deployed container**: person @ `0.911`,
  plus chair/tv/cup. `PERSONS @0.45 = 1` — matches coco-ssd.
- Inference ~50ms/frame on this Mac (coco-ssd/WASM was ~87ms).
- `onnxruntime-node` linux ELFs need only `libstdc++`, `libgcc_s`, `libc`
  (**no libgomp**) — all present in `node:20-slim`. Would have failed on Alpine/musl.
- Postinstall only fetches optional **CUDA** binaries; `ONNXRUNTIME_NODE_INSTALL=skip`
  suppresses it. CPU binaries are bundled in the npm tarball.
- npm tarball carries every OS/arch (~236MB). Prune to the target arch in the
  build stage (linux/x64 30MB, linux/arm64 17MB).

## Files touched

| File | Change |
|---|---|
| `viewer/detectors/cocossd.js` | new — coco-ssd (tfjs/WASM) behind the detector interface |
| `viewer/detectors/yolo.js` | new — YOLOv10n via onnxruntime-node (letterbox + parse) |
| `viewer/counter.js` | refactor — pluggable detector, runtime swap, `detector` column |
| `viewer/server.js` | `DETECTOR`/`COUNT_THREADS` env, `POST /api/occupancy/detector/:name` |
| `viewer/public/index.html` | engine switch in the People tab |
| `viewer/models/fetch-model.sh` | also fetch `yolo/yolov10n.onnx` |
| `viewer/Dockerfile` | skip CUDA postinstall, prune foreign-arch ORT binaries, copy `detectors/` |
| `viewer/package.json` | + `onnxruntime-node` |
| `.gitignore`, `viewer/.dockerignore` | ignore `viewer/models/yolo/` |
| `viewer/DOCKER.md`, `docs/STATUS.md`, `docs/PROJECT.md` | document the mode |

## Detector interface

```js
{ name, load(): Promise<void>, count(rgb, w, h): Promise<number>, backend(): string|null }
```
`rgb` is a packed `Uint8Array` of `w*h*3`. Returns the number of people in frame.

## Two bugs found by running it (not by reading it)

1. **`ARG TARGETARCH=amd64` shadows buildx's injected value** → every arch gets
   amd64 binaries. Pre-existing: the published `:v2` **arm64** image has an
   **x86-64 go2rtc** inside (`e_machine=0x3e`). Never bit us because the
   Portainer host is amd64. Fixed: no default, and the build now *fails* on an
   unknown arch instead of guessing.
2. **`onnxruntime-node` ≥1.23 dropped `darwin/x64`**, and this Mac's nvm Node 20
   is an x64 (Rosetta) build. `^1.22.0` resolved to 1.27 → local dev broke.
   Pinned to exactly `1.22.0`. Containers unaffected (both linux arches ship in
   every version).

## Verification

| Check | Result |
|---|---|
| Both engines, live camera | agree — 1 person on a person-frame, 0 on empty |
| Median latency (identical frames, 2 threads) | coco-ssd 95ms · yolo 98ms |
| Runtime swap `yolo → cocossd → yolo` | works, no restart, `lastErr: null` |
| Bad engine name | HTTP 400; counter keeps running on the old engine |
| Old-schema DB (no `detector` col) | migrates once; old rows kept (`NULL`); re-open no-op |
| Chart bucketing | still floored (`t % bucketMs === 0`) |
| Container `DETECTOR=yolo` (arm64) | `yolo / onnxruntime-cpu`, counted 2 people |
| Container **amd64** (deploy target, emulated) | model loads 312ms, inference OK |
| Image contents | only `linux/<arch>` ORT binaries; go2rtc arch matches |
| onnxruntime-node size in image | 236MB → **31MB** after prune |
| Syntax | `node --check` on all JS + inline UI script; `sh -n` on scripts |

## Outcome

Done. Both engines run server-side in the container, switchable live from the
People tab, with per-sample provenance in SQLite. Also fixed the latent arm64
go2rtc bug found along the way.

**Not yet published** — the image needs a rebuild + push as `:v3` (bump the tag;
Portainer won't re-pull `:latest`), then redeploy the stack. Awaiting go-ahead.

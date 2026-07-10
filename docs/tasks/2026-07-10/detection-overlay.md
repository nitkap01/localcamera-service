# Task — live detection overlay (boxes, hand gestures, face expressions)

_Date: 2026-07-10 · Repo: `localcamera-service`_

## Request

> "i want bounding boxes with a toggle, with hand gestures and face gestures too,
> with probability scores as well"

Clarified with the user:
- Browser-side overlay is acceptable (the server counter stays as it is).
- **Three** toggles, not one: People / Hands / Face.
- **Live display only — no logging.**
- "Face gestures" → facial **expressions** (they carry probability scores natively).

## The decision that shaped everything

The server counter samples **one frame every 4 seconds**. That cadence cannot see
a gesture (a thumbs-up lasts under a second), and boxes computed server-side
land 300–500ms after the video frame they belong to, so they visibly trail moving
people. Raising the server loop to 10–15fps would mean person+hand+face inference
on every frame — roughly a saturated core or two on the Portainer box.

So the overlay runs **in the browser**, on the exact `<video>` frame being
displayed: boxes are pixel-aligned, and the server pays nothing. MediaPipe Tasks
is browser-only anyway (needs DOM + WebGL); running it in Node is a rewrite from
ONNX parts, not a config flag.

**The server-side people counter is completely untouched.**

## Decisions

| Decision | Why |
|---|---|
| MediaPipe Tasks (`@mediapipe/tasks-vision`, pinned `0.10.35`) | Gives gesture labels *and* face blendshapes with probability scores out of the box. |
| `GestureRecognizer` for the Hands layer | It already includes hand landmarks, so the separate `hand_landmarker` model (7.4MB) is unnecessary. |
| `ObjectDetector` (efficientdet_lite0, float16) for People | Consistent with the same runtime; `categoryAllowlist: ['person']` filters to people. Avoids bundling tfjs into the browser. |
| Assets served from this host | `/vendor/mediapipe` (runtime + wasm) and `/models/mediapipe` (models). No CDN → works on a LAN with no internet, same as the server models. |
| Models load **lazily, per toggle** | Nothing is downloaded until you switch a layer on. |
| GPU delegate, falling back to CPU | Some browsers/drivers refuse WebGL; CPU still works (verified). |
| CSS full-window **only when an overlay is on** | iOS hands a fullscreened `<video>` to its native player, which paints above everything and cannot show an overlay. Existing tap-to-fullscreen behaviour is unchanged when boxes are off. |
| Overlay pauses while rotated | CSS rotation moves the picture but not the layout box, so boxes would sit crooked. Better to pause and say so than to draw lies. Mirror *is* handled (x is flipped). |

## Files touched

| File | Change |
|---|---|
| `viewer/public/overlay.js` | new — the whole overlay engine |
| `viewer/public/index.html` | canvas, three toggles, note line, CSS-fullscreen when active |
| `viewer/server.js` | serve `/vendor/mediapipe` + `/models/mediapipe` locally |
| `viewer/models/fetch-model.sh` | also fetch the 3 MediaPipe models (~18MB) |
| `viewer/package.json` | + `@mediapipe/tasks-vision` (exact `0.10.35`) |
| `.gitignore`, `viewer/.dockerignore` | ignore `viewer/models/mediapipe/` |

No Dockerfile change needed: the runtime rides in `node_modules`, the models are
fetched by the existing build-stage `fetch-model.sh` step.

## Verification

Driven through **real headless Chrome** against the actual `createOverlay`, with
`fillText` intercepted to capture the labels the overlay really draws.

| Image | people | hands | face | labels drawn |
|---|---|---|---|---|
| camera frame (distant person) | ✅ | – | – | `person 0.91` |
| MediaPipe `victory.jpg` | ✅ | ✅ | ✅ | `person 0.82`, `Right · Victory 0.94`, `eye look out left 0.62` |
| MediaPipe `portrait.jpg` | ✅ | – | ✅ | `person 0.95`, `mouth smile left 0.96` |

Also verified:
- Canvas geometry matches the displayed picture (960×540 canvas over a
  1280×720 image letterboxed into a 960×540 box).
- Ran on the **CPU delegate** (headless Chrome, `--disable-gpu`) — the GPU→CPU
  fallback path works.
- Assets serve with correct MIME from the container: `.mjs` →
  `application/javascript` (a wrong type makes the browser refuse the module),
  `.wasm` → `application/wasm`.
- The people counter is unaffected: `detector: cocossd, running: true, lastErr: null`.
- Scratch test files (`_ovtest.html`, `_ov*.jpg`) removed; `public/` ships only
  `index.html`, `overlay.js`, `video-rtc.js`.

## Notes / limits

- First time you enable a layer it downloads its model (7–8MB); after that it's
  cached and instant. All three ≈ 18MB.
- Overlay is paused while the picture is rotated (see table above).
- Hand/face detection needs the subject reasonably close — a distant figure gives
  a person box but no hands/face, as the first test row shows.

## Outcome

Done and verified. Image needs a rebuild + push as **`:v4`** to reach Portainer
(bump the tag; `:latest` is cached there). No new env vars are required.

---

## Follow-up (same day) — overlay was invisible in `:v4`, plus Hide UI

**Reported:** "its deployed, but i dont see bounding boxes, also there should a
option to hide the controls"

### The bug

Driving a real browser against the deployed viewer showed the truth immediately:

```
painted: 3830          <- boxes WERE being drawn
canvas display: none   <- into an invisible canvas
canvas offsetParent: null
```

`canvas.style.display = ''` does **not** mean "visible". It clears the *inline*
style, which lets the stylesheet rule `#overlay { display:none }` apply again. So
the overlay detected, drew, and painted — into a hidden canvas. Because a hidden
element has no `offsetParent`, `boxOf()` also walked the wrong offset chain and
positioned the canvas at `top:96px` instead of over the video.

My headless test passed because its throwaway test page never had the
`display:none` rule. The lesson: the test page must share the production CSS, or
the assertion must be "is it *visible*", not "did we draw".

**Fix:** set an explicit `canvas.style.display = 'block'` (both sites).

**Now asserted:** `display:block`, `offsetParent: stagewrap`, canvas rect
**pixel-identical** to the video rect (`[0,96,1280,720]`), and
`elementFromPoint(centre) === VIDEO` (so the overlay still doesn't eat clicks).

### Hide UI

`🙈 Hide UI` adds `body.bare`, hiding header / tabs / control bar / adjust panel.
A faint `⚙ Controls` button (fixed, above even the CSS-fullscreen layer) restores
it; `H` toggles, `Escape` restores. Verified: `bar: none`, `showui: flex`, stage
still visible, restore returns `bar: flex`, and both keys work.

### Not ours

The console also shows a `favicon.ico` 404 and an `InvalidStateError` about
`SourceBuffer` from go2rtc's own `video-rtc.js` (MSE teardown when WebRTC wins).
Both pre-date this work; left alone.

# tv-fractals

Ambient fractal visualizer for LG webOS TVs. Built for the LG CX (webOS 5.x, Chromium 68).

Every scene is an endless zoom: it falls toward a point on the boundary of its set at a
constant rate and never stops or turns back, however long it runs. Four formulas take
turns: the Mandelbrot set, the cubic Multibrot (z³ + c), the Burning Ship and the Celtic
fold. Scenes only change when you press ◀ ▶. There is no static UI, so it is safe to
leave on an OLED.

## Remote

| Key | Action |
| --- | --- |
| ◀ ▶ | Previous / next scene (scenes never change on their own) |
| ▲ ▼ | Faster / slower |
| Red, Green, Yellow, Blue | Pick a palette |
| Play / Pause | Pause |
| OK | Show or hide the info overlay |
| Back | Exit |

## Develop

```bash
npm install
npm run dev        # desktop preview, same keys via keyboard (Esc, arrows, space, r/g/y/b)
npm test
npm run build      # dist/ ready for webOS
```

`?scene=N&t=SECONDS` on the dev URL jumps straight into a scene for tuning (a dive at
`t` seconds is `0.12 t` doublings deep). `?cx=&cy=&f=burningship` dives toward the
Misiurewicz point of that formula nearest the guess (`&k=&p=` pins its preperiod and
period), for scouting new scenes.
`?work=N` pins the escape-time samples the GPU runs per frame, `?scale=F` pins keyframe
density (fraction of the screen) and `?ss=1|2|4` pins samples per texel; whatever is not
pinned adapts. OK shows the keyframe size and supersampling, rows rendered per frame, the
index of the keyframe on screen and how far the next has faded in, and the frame time.

## Deploy to the TV

One-time, on the TV: install **Developer Mode** from the LG Content Store, sign in,
turn on *Dev Mode Status* and *Key Server*. Then on this machine:

```bash
TV_IP=192.168.1.42 npm run tv:setup
npm run tv:key     # enter the passphrase shown in the Developer Mode app
```

Every deploy after that:

```bash
npm run deploy
```

That builds, packages the `.ipk`, installs it, and launches it. `npm run inspect`
opens remote DevTools against the running app. Developer Mode sessions expire after
50 hours unless you extend them in the app.

## Why it is built this way

- **Chromium 68** means no OffscreenCanvas, no optional chaining, and no `Array.flat`.
  The build targets `chrome68` and TypeScript's lib is pinned to ES2018.
- webOS loads apps from `file://`, which rejects `<script type="module">`. The build
  emits a single classic IIFE and swaps `type="module"` for `defer`.
- Rendering is a WebGL1 fragment shader, but the escape-time pass is decoupled from the
  display. Keyframes are planned along the zoom, one every 0.4 doublings (about 3 s at
  1×), and each is written into an offscreen texture a few rows per frame over the
  seconds before it is due. Rows are stored in a golden-ratio permutation so any run of
  consecutive rows samples the whole image and every frame costs about the same. Each
  displayed frame reprojects the newest complete keyframe through the current camera
  (zoom, pan and spin compose to one affine map, computed in double precision on the
  CPU) and applies palette, vignette and brightness; while a new keyframe arrives it is
  dissolved in over a second on top of the old one. Nothing in a keyframe changes while
  it is on screen except a continuous magnification, so the sampling noise of chaotic
  regions holds still between refreshes instead of re-rolling several times a second.
  With a keyframe every 3 s instead of every 11 frames the GPU can afford full 1080p
  keyframes with 4× rotated-grid supersampling (interior fraction stored alongside the
  averaged count, so set boundaries antialias too) at the same per-frame cost.
- A finished keyframe is baked once into an ordinary RGBA8 colour image (palette lookup,
  far-field fade and interior black happen there), and the present pass then costs one
  hardware-filtered tap per keyframe. That matters: on the CX's Mali-G51 the manual
  four-tap decode of the old present pass was what capped the canvas at about 1040×585,
  not the fractal itself. The keyframe on screen is re-baked a sixteenth per frame so
  palette drift and palette changes still flow through within a quarter of a second.
- A budget controller steers one knob, samples per frame, from frame intervals measured
  relative to a baseline taken under a light fixed load. The baseline matters because the
  TV does not always present at 60 Hz: with the panel in a 50 Hz mode, one frame in five
  is late before any work is done, and a controller aiming at 16.7 ms collapses. Growth
  is a probe with exponential back-off after failures, reset whenever the scene changes;
  shrinking while already at the minimum re-measures the baseline. Each keyframe then
  spends the samples the zoom speed leaves it on resolution first and supersampling
  second; a keyframe that would finish more than one spacing late is skipped so a slow
  GPU falls at most one keyframe behind.
- A CPU fallback exists in case WebGL or render-to-texture is unavailable.

## Measured on the CX

GPU time per displayed frame, drained with a readback, in the Seahorse Valley hold at 300
iterations, the most expensive view. "Before" is the previous single-pass renderer at the
same internal resolution.

| Internal resolution | Before | After (6 tiles) | Frame rate before → after |
| --- | --- | --- | --- |
| 653×367 | 23 ms | ≤ 5 ms | 39 → 60 fps |
| 960×540 | 43 ms | 12 ms | 22 → 60 fps |
| 1440×810 | 88 ms | 18 ms | 11 → 48 fps |
| 1920×1080 | 147 ms | 29 ms (26 ms at 8 tiles) | 7 → 35 fps |

Left to adapt, the old renderer settled at 960×540 and 25 fps. With per-frame keyframes
the amortised renderer held 60 fps at about 1750×980 during a dive's shallow phase and
about 1040×585 once perturbation took over, at any depth (measured identically at
10^37, 10^180 and 10^3600).

With keyframes laid out along the zoom and baked to colour, the deep regime settles at
full 1920×1080 keyframes (2170×1221 texels including the fade-in margin) with 4×
supersampling on the Celtic and Burning Ship dives (about 120k samples per frame) and 2×
on the Mandelbrot dives, whose cycles repel more weakly and so cost more per sample.
Measured with the panel presenting at 50 Hz (the TV's state that day: even a CSS
animation capped at 50 fps), the mean frame interval stayed within 2% of the no-load
baseline, that is, the fractal work added no dropped frames.
- **Zoom depth is unbounded.** Every dive targets a Misiurewicz point: a boundary point
  whose orbit is a short repeating cycle, found exactly by Newton's method at load time.
  For the first 16 doublings the ordinary single-precision shader is exact and cheapest.
  Beyond that the shader renders by perturbation against the reference orbit, which is
  baked in as constants, so no texture or dynamic indexing is needed. While a pixel's
  offset from the reference is tiny it evolves linearly through the cycle's Jacobian,
  which has a closed form over any number of cycles once diagonalised; for holomorphic
  formulas the return map is moreover analytically linearizable, so a short power series
  (the inverse Koenigs function) extends the closed form well past the linear regime.
  Each pixel evaluates that once, landing a few dozen iterations before escape, then
  iterates exactly, rebasing onto the start of the orbit whenever it passes closer to
  the origin than the reference (so no glitches). Per-pixel GPU cost is therefore
  independent of depth, and cameras are kept in log2 space with offsets in view units so
  nothing underflows on the CPU either. The set is asymptotically self-similar around
  such a point, so the picture settles into a structure that rotates as it repeats.
- **Formulas** are plain objects (`src/scene/formula.ts`) with a step, a real Jacobian and
  two GLSL snippets; the Burning Ship and Celtic folds are exact under perturbation via
  the |X + δ| − |X| identity. Adding a formula is adding one such object and surveying
  its boundary with `nearestMisiurewicz` for points whose cycle is comfortably repelling.
- The cost a dive pays per doubling is period · ln 2 / ln |λ| iterations, where λ is the
  multiplier of the landing cycle. Points with |λ| close to 1 (the tightest spirals) are
  left out of the scene list for that reason; the survey that found the current set is
  reproducible with `nearestMisiurewicz`.

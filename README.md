# tv-fractals

Ambient fractal visualizer for LG webOS TVs. Built for the LG CX (webOS 5.x, Chromium 68).

Each Mandelbrot scene is an endless zoom: it falls toward a point on the boundary at a
constant rate and never stops or turns back, however long it runs. Julia scenes morph
their seed and loop. Scenes only change when you press ◀ ▶. There is no static UI, so
it is safe to leave on an OLED.

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
`t` seconds is `0.12 t` doublings deep). `?cx=&cy=` dives toward the Misiurewicz point
nearest that guess, for scouting new scenes.
`?tiles=N` pins how many frames each keyframe is spread over while resolution still
adapts, and `?scale=F` pins keyframe resolution (fraction of the screen) while tiles
adapt; give both to fix the budget entirely. OK shows the current keyframe size, tiles
and frame time. To measure the amortisation on the TV, compare the keyframe size the
app settles on with `?tiles=1` (every frame is a full render, as before) against
`?tiles=6`: the ratio of keyframe pixel counts is the GPU time saved per frame at a
fixed resolution.

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
  display. It writes iteration counts (or orbit-trap distances for Julia interiors) into
  an offscreen keyframe, spread over several frames in interleaved row bands so every
  frame costs the same. Each displayed frame reprojects the newest complete keyframe
  through the current camera (zoom, pan and spin compose to one affine map, computed in
  double precision on the CPU) and applies palette, vignette and brightness. The TV GPU
  manages roughly 2 billion iterations a second; spending them on one keyframe every 5–8
  frames instead of a full render every frame is what lets the display hold 60 fps at a
  far higher internal resolution than before.
- A budget controller steers both knobs. When frames run late it first spreads keyframes
  over more frames, then lowers keyframe resolution; when frames land on time it grows
  back, resolution first. vsync hides headroom, so growth is a probe with exponential
  back-off after failures, reset whenever the scene changes.
- A CPU fallback exists in case WebGL or render-to-texture is unavailable.

## Measured on the CX

GPU time per displayed frame, drained with a readback (`bench=1`), in the Seahorse Valley
hold at 300 iterations, the most expensive view. "Before" is the previous single-pass
renderer at the same internal resolution.

| Internal resolution | Before | After (6 tiles) | Frame rate before → after |
| --- | --- | --- | --- |
| 653×367 | 23 ms | ≤ 5 ms | 39 → 60 fps |
| 960×540 | 43 ms | 12 ms | 22 → 60 fps |
| 1440×810 | 88 ms | 18 ms | 11 → 48 fps |
| 1920×1080 | 147 ms | 29 ms (26 ms at 8 tiles) | 7 → 35 fps |

Left to adapt, the old renderer settled at 960×540 and 25 fps. The new one holds 60 fps
at about 1750×980 during a dive's shallow phase and about 1040×585 once perturbation
takes over, at any depth (measured identically at 10^37, 10^180 and 10^3600). Julia
scenes gain less (17 → 7–11 ms at 960×540) because their per-frame cost was already
low and fixed per-frame costs dominate.
- **Zoom depth is unbounded.** Every dive targets a Misiurewicz point: a boundary point
  whose orbit is a short repeating cycle, found exactly by Newton's method at load time.
  For the first 16 doublings the ordinary single-precision shader is exact and cheapest.
  Beyond that the shader renders by perturbation against the reference orbit, which is
  baked in as constants, so no texture or dynamic indexing is needed. The return map of
  the cycle is analytically linearizable, so a pixel's offset from the reference after
  any number of cycles is a short power series (the inverse Koenigs function) in a
  closed-form linear estimate; each pixel evaluates that once, landing a few dozen
  iterations before escape, then iterates exactly, rebasing onto the start of the orbit
  whenever it passes closer to the origin than the reference (so no glitches). Per-pixel
  GPU cost is therefore independent of depth, and cameras are kept in log2 space with
  offsets in view units so nothing underflows on the CPU either. The set is
  asymptotically self-similar around such a point, so the picture settles into a spiral
  that rotates as it repeats.
- The cost a dive pays per doubling is period · ln 2 / ln |λ| iterations, where λ is the
  multiplier of the landing cycle. Points with |λ| close to 1 (the tightest spirals) are
  left out of the scene list for that reason; the survey that found the current set is
  reproducible with `nearestMisiurewicz`.

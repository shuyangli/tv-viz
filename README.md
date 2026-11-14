# tv-light-show

Ambient psychedelic light show for LG webOS TVs. Built for the LG CX (webOS 5.x, Chromium 68).

Five full-screen scenes in the spirit of a 1960s liquid light show, each a single fragment
shader that never repeats and never holds still:

| Scene | What it is |
| --- | --- |
| Liquid Light | Oil-and-water projector blobs that merge, split and swirl |
| Mandala | A breathing kaleidoscope of counter-rotating petal rings |
| Wormhole | An endless flight down a twisting op-art tunnel |
| Echo Chamber | Analog video feedback: recursive trails of rainbow light |
| Fillmore | A concert poster come alive in flat, vibrating bands of ink |

Scenes only change when you press ◀ ▶. There is no static UI, so it is safe to leave on
an OLED.

## Remote

| Key | Action |
| --- | --- |
| ◀ ▶ | Previous / next scene (scenes never change on their own) |
| ▲ ▼ | Faster / slower |
| Red, Green, Yellow, Blue | Pick a palette: Rainbow, Acid, Sunshine, Blacklight |
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

`?scene=ID|N&t=SECONDS&palette=N` on the dev URL jumps straight into a scene, and `?res=F`
pins the render resolution to a fraction of the viewport instead of letting it adapt
(`window.__pins.res` does the same at runtime). OK shows the render resolution and the
frame time against its baseline.

`npm run shot -- --scene liquid --t 0,30,90 --palette 1 --out shots` screenshots a scene
in headless Chrome with software GL and prints the shader log if it fails to compile.

## Adding a scene

A scene is one object in `src/viz/` (see `src/viz/types.ts`), listed in `src/viz/index.ts`:
a GLSL ES 1.00 fragment that defines `vec3 viz(vec2 p, vec2 uv)`, and a `uniforms(time, dt)`
function that feeds it. The prelude in `src/viz/glsl.ts` supplies `palette(t)`, which
follows the colour keys and drifts slowly on its own. Time reaches a shader only through
uniforms computed in JavaScript, wrapped there so they stay exact however long the show
runs. A scene that sets `feedback` can read its own previous frame through `u_prev`.

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
- Rendering is WebGL1. Each frame the scene shader draws into an offscreen target, and a
  one-tap present pass copies it to a canvas of the same size, dissolving from the last
  frame of the previous scene after a scene change and adding a little noise against
  banding. The canvas is smaller than the panel and the compositor scales it up for
  free; a present pass at 1080p is the dearest per-pixel work there is on the CX's
  Mali-G51.
- A budget controller steers one knob, pixels shaded per frame, from frame intervals
  measured relative to a baseline taken at 640×360. The baseline matters because the TV
  does not always present at 60 Hz: with the panel in a 50 Hz mode, one frame in five is
  late before any work is done, and a controller aiming at 16.7 ms collapses. Growth is a
  probe with exponential back-off after failures, reset whenever the scene changes;
  shrinking while already at the minimum re-measures the baseline. The renderer snaps the
  budget to a few resolution steps between a third of the viewport and all of it, so the
  frame rate holds and a heavier scene is softer rather than slower.
- Scenes are written to a per-pixel cost budget (a few dozen transcendental calls, short
  constant loops, no texture taps outside the feedback scene) and keep everything that
  does not vary per pixel in JavaScript.

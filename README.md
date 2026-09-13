# tv-fractals

Ambient fractal visualizer for LG webOS TVs. Built for the LG CX (webOS 5.x, Chromium 68).

It tours the Mandelbrot set with slow zoom dives and morphing Julia sets, cycling
palettes as it goes. There is no static UI, so it is safe to leave on an OLED.

## Remote

| Key | Action |
| --- | --- |
| ◀ ▶ | Previous / next scene |
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

`?scene=N&t=SECONDS` on the dev URL jumps straight into a scene for tuning.

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
- Rendering is a WebGL1 fragment shader. The TV GPU cannot hold 60 fps at 1080p on
  deep zooms, so the app renders at a fraction of the viewport and adapts that fraction
  to the measured frame time. A CPU fallback exists in case WebGL is unavailable.
- Single-precision floats limit zoom depth to roughly 10 000×. Scenes stop before the
  image turns blocky.

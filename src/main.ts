import { actionForKey, type RemoteAction } from './input/remote'
import { AdaptiveBudget, TV_BUDGET_OPTIONS } from './perf/adaptive'
import { CpuRenderer } from './render/cpu'
import { GlRenderer } from './render/gl'
import type { FrameParams, Renderer } from './render/types'
import type { SceneFrame } from './scene/tour'
import { PaletteMixer } from './scene/palette'
import { nearestMisiurewicz } from './scene/misiurewicz'
import { OVERVIEW_SCALE } from './scene/quality'
import type { Scene } from './scene/scenes'
import { Tour } from './scene/tour'
import { Hud } from './ui/hud'

const SPEED_STEPS = [0.25, 0.5, 1, 1.5, 2, 3, 4]
const DEFAULT_SPEED_INDEX = 2
/** Palette cycles per second at 1× speed. Slow enough to read as a mood shift, not a strobe. */
const COLOR_DRIFT_PER_SECOND = 0.02
/** Iterations per palette cycle. Julia exteriors escape in tight bands, so they get a slower ramp to avoid speckle. */
const MANDELBROT_COLOR_SCALE = 48
const JULIA_COLOR_SCALE = 110
/** The Mandelbrot overview escapes slowly, so it can afford a wide dark far field; Julia views at scale ~1.5 cannot. */
const MANDELBROT_FAR_FIELD = 10
const JULIA_FAR_FIELD = 5
/** rAF gaps longer than this are hitches (backgrounding, GC); the scene must not lurch to catch up. */
const MAX_FRAME_SECONDS = 0.1
const STARTUP_HUD_MS = 6000
/** Smoothing for the frame interval fed to keyframe prediction; hitches must not throw the camera far ahead. */
const FRAME_INTERVAL_SMOOTHING = 0.1
const HELP_TEXT = '◀ ▶ scene   ▲ ▼ speed   ● ● ● ● palette   OK info   BACK exit'

function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = GlRenderer.create(canvas)
  if (gl) return gl
  return new CpuRenderer(canvas)
}

interface DebugParams {
  readonly scene: number | null
  readonly seek: number | null
  /** `?cx=&cy=` dives toward the Misiurewicz point nearest that guess, `?jx=&jy=&s=` shows a custom Julia seed, for scouting new scenes. */
  readonly custom: Scene | null
  /** `?scale=` and `?tiles=` each pin one knob of the render budget while the other adapts, for measuring on the TV. */
  readonly scale: number | null
  readonly tiles: number | null
  /** `?bench=1` waits for the GPU every frame and shows its time in the HUD. */
  readonly bench: boolean
}

function numberParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name)
  if (raw === null) return null
  const value = Number(raw)
  return isNaN(value) ? null : value
}

/** webOS launches from file:// with no query string; `ares-launch --params '{"tiles":6}'` arrives here instead. */
function launchParams(): URLSearchParams {
  const params = new URLSearchParams(window.location.search)
  const palm = (window as unknown as { PalmSystem?: { launchParams?: string } }).PalmSystem
  if (!palm || !palm.launchParams) return params
  try {
    const launched = JSON.parse(palm.launchParams) as Record<string, unknown>
    for (const key of Object.keys(launched)) params.set(key, String(launched[key]))
  } catch {
    // Not JSON: nothing to merge.
  }
  return params
}

function debugParams(): DebugParams {
  const params = launchParams()
  const cx = numberParam(params, 'cx')
  const cy = numberParam(params, 'cy')
  const s = numberParam(params, 's')
  const jx = numberParam(params, 'jx')
  const jy = numberParam(params, 'jy')
  let custom: Scene | null = null
  if (jx !== null && jy !== null) {
    custom = {
      kind: 'julia',
      name: 'Custom Julia ' + jx + ', ' + jy,
      durationSeconds: 1e9,
      seedPath: () => [jx, jy],
      scale: s === null ? 1.45 : s,
      spin: 0,
      iterations: 300,
    }
  } else if (cx !== null && cy !== null) {
    // Dives need a boundary point with a finite orbit, so scout the nearest one.
    const point = nearestMisiurewicz([cx, cy], 40, 6, 0.05)
    if (point) custom = { kind: 'dive', name: 'Custom ' + point.c[0].toFixed(6) + ', ' + point.c[1].toFixed(6), point, spin: 0 }
  }
  return {
    scene: numberParam(params, 'scene'),
    seek: numberParam(params, 't'),
    custom,
    scale: numberParam(params, 'scale'),
    tiles: numberParam(params, 'tiles'),
    bench: params.get('bench') === '1',
  }
}

function budgetFor(debug: DebugParams): AdaptiveBudget {
  let opts = TV_BUDGET_OPTIONS
  if (debug.scale !== null) opts = { ...opts, initialScale: debug.scale, minScale: debug.scale, maxScale: debug.scale }
  if (debug.tiles !== null) opts = { ...opts, initialTiles: debug.tiles, minTiles: debug.tiles, maxTiles: debug.tiles }
  return new AdaptiveBudget(opts)
}

function main(): void {
  const stage = document.getElementById('stage')
  const hudRoot = document.getElementById('hud')
  if (!(stage instanceof HTMLCanvasElement) || !hudRoot) throw new Error('missing #stage or #hud')
  const canvas: HTMLCanvasElement = stage

  const renderer = createRenderer(canvas)
  const hud = new Hud(hudRoot)
  const palettes = new PaletteMixer()
  const debug = debugParams()
  const budget = budgetFor(debug)
  renderer.setQuality(budget)
  renderer.setBenchmark(debug.bench)
  const tour = debug.custom ? new Tour([debug.custom]) : new Tour(undefined, debug.scene === null ? 0 : debug.scene)
  if (debug.custom) tour.seek(5)
  else if (debug.seek !== null) tour.seek(debug.seek)

  let speedIndex = DEFAULT_SPEED_INDEX
  let paused = false
  let colorShift = 0
  let lastTimestamp = performance.now()
  let frameSeconds = 1 / 60
  let averageFrameMs = 1000 / 60
  let renderFailed = false

  function applySize(): void {
    renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight))
  }

  function renderStats(): string {
    const keyframe = renderer instanceof GlRenderer ? renderer.keyframeSize : null
    const size = keyframe ? keyframe[0] + '×' + keyframe[1] : Math.round(budget.scale * 100) + '%'
    return (
      (renderer.kind === 'webgl' ? 'GPU ' : 'CPU ') +
      canvas.width +
      '×' +
      canvas.height +
      '  ·  keyframe ' +
      size +
      ' / ' +
      budget.tiles +
      ' frames  ·  ' +
      averageFrameMs.toFixed(1) +
      ' ms' +
      (renderer.gpuMs === null ? '' : '  ·  gpu ' + renderer.gpuMs.toFixed(1) + ' ms')
    )
  }

  function hudInfo(): void {
    const frame = tour.frame()
    const zoom = (Math.log2(OVERVIEW_SCALE) - frame.log2Scale) * Math.LOG10E * Math.LN2
    const mode = frame.julia ? 'Julia' : 'Mandelbrot ×10^' + zoom.toFixed(1)
    const state = paused ? 'Paused' : SPEED_STEPS[speedIndex] + '×'
    hud.show({
      title: frame.sceneName,
      subtitle: mode + '  ·  ' + palettes.current.name + '  ·  ' + state + '  ·  ' + renderStats(),
      help: HELP_TEXT,
    })
  }

  function sceneChanged(): void {
    palettes.cycle()
    budget.invalidate()
  }

  function handle(action: RemoteAction): void {
    switch (action) {
      case 'back':
        window.close()
        return
      case 'ok':
        if (hud.visible) hud.hide()
        else hudInfo()
        return
      case 'left':
        tour.prev()
        sceneChanged()
        break
      case 'right':
        tour.next()
        sceneChanged()
        break
      case 'up':
        speedIndex = Math.min(SPEED_STEPS.length - 1, speedIndex + 1)
        break
      case 'down':
        speedIndex = Math.max(0, speedIndex - 1)
        break
      case 'playPause':
        paused = !paused
        break
      case 'red':
        palettes.select(0)
        break
      case 'green':
        palettes.select(1)
        break
      case 'yellow':
        palettes.select(2)
        break
      case 'blue':
        palettes.select(3)
        break
    }
    hudInfo()
  }

  document.addEventListener('keydown', (event) => {
    const action = actionForKey(event.keyCode, event.key)
    if (!action) return
    event.preventDefault()
    handle(action)
  })

  window.addEventListener('resize', applySize)
  document.addEventListener('visibilitychange', () => {
    lastTimestamp = performance.now()
  })

  function buildFrame(scene: SceneFrame): FrameParams {
    return {
      anchor: scene.anchor,
      offset: scene.offset,
      log2Scale: scene.log2Scale,
      rotation: scene.rotation,
      maxIter: scene.maxIter,
      julia: scene.julia,
      seed: scene.seed,
      reference: scene.reference,
      sceneId: scene.epoch,
      palette: palettes.blend(),
      colorShift,
      colorScale: scene.julia ? JULIA_COLOR_SCALE : MANDELBROT_COLOR_SCALE,
      brightness: scene.brightness,
      farField: scene.julia ? JULIA_FAR_FIELD : MANDELBROT_FAR_FIELD,
    }
  }

  function predict(aheadSeconds: number): FrameParams {
    return buildFrame(tour.frameAt(paused ? 0 : aheadSeconds * SPEED_STEPS[speedIndex]))
  }

  function loop(timestamp: number): void {
    const frameMs = timestamp - lastTimestamp
    lastTimestamp = timestamp
    const dt = Math.min(frameMs / 1000, MAX_FRAME_SECONDS)
    frameSeconds += (dt - frameSeconds) * FRAME_INTERVAL_SMOOTHING
    averageFrameMs += (Math.min(frameMs, 1000) - averageFrameMs) * FRAME_INTERVAL_SMOOTHING
    if (!paused) {
      const speed = SPEED_STEPS[speedIndex]
      if (tour.update(dt * speed)) palettes.cycle()
      colorShift += dt * speed * COLOR_DRIFT_PER_SECOND
    }
    palettes.update(dt)
    if (budget.record(frameMs, timestamp)) renderer.setQuality(budget)
    try {
      renderer.render(buildFrame(tour.frame()), predict, frameSeconds)
    } catch (error) {
      // A rendering fault must not stop the loop; the next scene may well be fine.
      if (!renderFailed) console.error(String(error))
      renderFailed = true
    }
    window.requestAnimationFrame(loop)
  }

  applySize()
  hud.show(
    { title: 'Fractals', subtitle: renderer.kind === 'webgl' ? 'GPU rendering' : 'CPU fallback', help: HELP_TEXT },
    STARTUP_HUD_MS,
  )
  window.requestAnimationFrame(loop)
}

main()

import { actionForKey, type RemoteAction } from './input/remote'
import { AdaptiveBudget, TV_BUDGET_OPTIONS } from './perf/adaptive'
import { CpuRenderer } from './render/cpu'
import { GlRenderer } from './render/gl'
import type { FrameParams, RenderBudget, Renderer } from './render/types'
import type { SceneFrame } from './scene/tour'
import { PaletteMixer } from './scene/palette'
import { formulaById, MANDELBROT, type Formula } from './scene/formula'
import { nearestMisiurewicz, type MisiurewiczPoint } from './scene/misiurewicz'
import { resolveMisiurewicz, type Scene } from './scene/scenes'
import { Tour, ZOOM_DOUBLINGS_PER_SECOND } from './scene/tour'
import { Hud } from './ui/hud'

const SPEED_STEPS = [0.25, 0.5, 1, 1.5, 2, 3, 4]
const DEFAULT_SPEED_INDEX = 2
/** Palette cycles per second at 1× speed. Slow enough to read as a mood shift, not a strobe. */
const COLOR_DRIFT_PER_SECOND = 0.02
/** Iterations per palette cycle. */
const COLOR_SCALE = 48
/** Escape count below which the flat far field fades to black; only shapes the overview. */
const FAR_FIELD = 10
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
  /** `?cx=&cy=&f=` dives toward the nearest Misiurewicz point of formula `f` to that guess (`&k=&p=` pins its preperiod and period), for scouting new scenes. */
  readonly custom: Scene | null
  /** `?scale=` pins keyframe density, `?ss=` samples per texel and `?work=` samples per frame, for measuring on the TV; the rest adapts. */
  readonly scale: number | null
  readonly samples: number | null
  readonly work: number | null
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

function tryResolve(formula: Formula, guess: [number, number], k: number, p: number): MisiurewiczPoint | null {
  try {
    return resolveMisiurewicz(formula, guess, k, p)
  } catch {
    return null
  }
}

function debugParams(): DebugParams {
  const params = launchParams()
  const cx = numberParam(params, 'cx')
  const cy = numberParam(params, 'cy')
  let custom: Scene | null = null
  if (cx !== null && cy !== null) {
    const formula = formulaById(params.get('f') || 'mandelbrot') || MANDELBROT
    const k = numberParam(params, 'k')
    const p = numberParam(params, 'p')
    const point =
      k !== null && p !== null ? tryResolve(formula, [cx, cy], k, p) : nearestMisiurewicz(formula, [cx, cy], 40, 6, 0.05)
    if (point) {
      custom = { kind: 'dive', name: 'Custom ' + formula.name + ' ' + point.c[0].toFixed(6) + ', ' + point.c[1].toFixed(6), point, spin: 0 }
    }
  }
  return {
    scene: numberParam(params, 'scene'),
    seek: numberParam(params, 't'),
    custom,
    scale: numberParam(params, 'scale'),
    samples: numberParam(params, 'ss'),
    work: numberParam(params, 'work'),
  }
}

/** Runtime overrides reachable from DevTools as window.__pins, so the budget can be varied on the TV without relaunching. */
interface Pins {
  work: number | null
  density: number | null
  samples: number | null
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
  const budget = new AdaptiveBudget(TV_BUDGET_OPTIONS)
  const pins: Pins = { work: debug.work, density: debug.scale, samples: debug.samples }
  ;(window as unknown as { __pins: Pins }).__pins = pins
  const tour = debug.custom ? new Tour([debug.custom]) : new Tour(undefined, debug.scene === null ? 0 : debug.scene)
  if (debug.seek !== null) tour.seek(debug.seek)

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
    const stats = renderer.stats
    const keyframe = stats
      ? stats.width +
        '×' +
        stats.height +
        ' ×' +
        stats.samples +
        ' / ' +
        stats.rowsPerFrame.toFixed(1) +
        ' rows  ·  #' +
        stats.index +
        ' blend ' +
        stats.blend.toFixed(2)
      : '—'
    return (
      (renderer.kind === 'webgl' ? 'GPU ' : 'CPU ') +
      canvas.width +
      '×' +
      canvas.height +
      '  ·  keyframe ' +
      keyframe +
      '  ·  ' +
      Math.round((pins.work !== null ? pins.work : budget.samplesPerFrame) / 1000) +
      'k/frame  ·  ' +
      averageFrameMs.toFixed(1) +
      ' ms' +
      (budget.baselineMs === null ? '' : ' (base ' + budget.baselineMs.toFixed(1) + ')')
    )
  }

  function hudInfo(): void {
    const frame = tour.frame()
    const zoom = frame.depth * Math.LOG10E * Math.LN2
    const mode = frame.reference.formula.name + ' ×10^' + zoom.toFixed(1)
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
      reference: scene.reference,
      sceneId: scene.epoch,
      palette: palettes.blend(),
      colorShift,
      colorScale: COLOR_SCALE,
      brightness: scene.brightness,
      farField: FAR_FIELD,
    }
  }

  function predict(log2Scale: number): FrameParams {
    return buildFrame(tour.frameAtLog2Scale(log2Scale))
  }

  function renderBudget(): RenderBudget {
    const speed = paused ? 0 : SPEED_STEPS[speedIndex]
    return {
      samplesPerFrame: pins.work !== null ? pins.work : budget.samplesPerFrame,
      doublingsPerFrame: ZOOM_DOUBLINGS_PER_SECOND * speed * frameSeconds,
      density: pins.density,
      samples: pins.samples,
    }
  }

  function loop(timestamp: number): void {
    const frameMs = timestamp - lastTimestamp
    lastTimestamp = timestamp
    const dt = Math.min(frameMs / 1000, MAX_FRAME_SECONDS)
    frameSeconds += (dt - frameSeconds) * FRAME_INTERVAL_SMOOTHING
    averageFrameMs += (Math.min(frameMs, 1000) - averageFrameMs) * FRAME_INTERVAL_SMOOTHING
    if (!paused) {
      const speed = SPEED_STEPS[speedIndex]
      tour.update(dt * speed)
      colorShift += dt * speed * COLOR_DRIFT_PER_SECOND
    }
    palettes.update(dt)
    budget.record(frameMs, timestamp)
    try {
      renderer.render(buildFrame(tour.frame()), predict, renderBudget())
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

import { actionForKey, type RemoteAction } from './input/remote'
import { AdaptiveResolution } from './perf/adaptive'
import { CpuRenderer } from './render/cpu'
import { GlRenderer } from './render/gl'
import type { FrameParams, Renderer } from './render/types'
import { PaletteMixer } from './scene/palette'
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
const HELP_TEXT = '◀ ▶ scene   ▲ ▼ speed   ● ● ● ● palette   OK info   BACK exit'

function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = GlRenderer.create(canvas)
  if (gl) return gl
  return new CpuRenderer(canvas)
}

interface DebugParams {
  readonly scene: number | null
  readonly seek: number | null
  /** `?cx=&cy=&s=` pins the camera on a custom Mandelbrot point, `?jx=&jy=` on a custom Julia seed, for scouting new scenes. */
  readonly custom: Scene | null
}

function numberParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name)
  if (raw === null) return null
  const value = Number(raw)
  return isNaN(value) ? null : value
}

function debugParams(): DebugParams {
  const params = new URLSearchParams(window.location.search)
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
    custom = {
      kind: 'dive',
      name: 'Custom ' + cx + ', ' + cy,
      target: [cx, cy],
      targetScale: s === null ? 1e-3 : s,
      zoomInSeconds: 1,
      holdSeconds: 1e9,
      zoomOutSeconds: 0,
      spin: 0,
    }
  }
  return { scene: numberParam(params, 'scene'), seek: numberParam(params, 't'), custom }
}

function main(): void {
  const stage = document.getElementById('stage')
  const hudRoot = document.getElementById('hud')
  if (!(stage instanceof HTMLCanvasElement) || !hudRoot) throw new Error('missing #stage or #hud')
  const canvas: HTMLCanvasElement = stage

  const renderer = createRenderer(canvas)
  const adaptive = new AdaptiveResolution()
  const hud = new Hud(hudRoot)
  const palettes = new PaletteMixer()
  const debug = debugParams()
  const tour = debug.custom ? new Tour([debug.custom]) : new Tour(undefined, debug.scene === null ? 0 : debug.scene)
  if (debug.custom) tour.seek(5)
  else if (debug.seek !== null) tour.seek(debug.seek)

  let speedIndex = DEFAULT_SPEED_INDEX
  let paused = false
  let colorShift = 0
  let lastTimestamp = performance.now()

  function applySize(): void {
    const width = Math.max(1, Math.round(window.innerWidth * adaptive.scale))
    const height = Math.max(1, Math.round(window.innerHeight * adaptive.scale))
    renderer.setSize(width, height)
  }

  function hudInfo(): void {
    const frame = tour.frame()
    const mode = frame.julia ? 'Julia' : 'Mandelbrot'
    const state = paused ? 'Paused' : SPEED_STEPS[speedIndex] + '×'
    const res = canvas.width + '×' + canvas.height + ' ' + (renderer.kind === 'webgl' ? 'GPU' : 'CPU')
    hud.show({
      title: frame.sceneName,
      subtitle: mode + '  ·  ' + palettes.current.name + '  ·  ' + state + '  ·  ' + res,
      help: HELP_TEXT,
    })
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
        palettes.cycle()
        break
      case 'right':
        tour.next()
        palettes.cycle()
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

  function buildFrame(): FrameParams {
    const scene = tour.frame()
    return {
      center: scene.center,
      scale: scene.scale,
      rotation: scene.rotation,
      maxIter: scene.maxIter,
      julia: scene.julia,
      seed: scene.seed,
      palette: palettes.blend(),
      colorShift,
      colorScale: scene.julia ? JULIA_COLOR_SCALE : MANDELBROT_COLOR_SCALE,
      brightness: scene.brightness,
      farField: scene.julia ? JULIA_FAR_FIELD : MANDELBROT_FAR_FIELD,
    }
  }

  function loop(timestamp: number): void {
    const frameMs = timestamp - lastTimestamp
    lastTimestamp = timestamp
    const dt = Math.min(frameMs / 1000, MAX_FRAME_SECONDS)
    if (!paused) {
      const speed = SPEED_STEPS[speedIndex]
      if (tour.update(dt * speed)) palettes.cycle()
      colorShift += dt * speed * COLOR_DRIFT_PER_SECOND
    }
    palettes.update(dt)
    if (adaptive.record(frameMs)) applySize()
    renderer.render(buildFrame())
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

import { actionForKey, type RemoteAction } from './input/remote'
import { AdaptiveBudget, TV_BUDGET_OPTIONS } from './perf/adaptive'
import { Renderer } from './render/renderer'
import { Hud } from './ui/hud'
import { VISUALIZATIONS } from './viz'
import { PaletteMixer } from './viz/palette'

const SPEED_STEPS = [0.25, 0.5, 1, 1.5, 2, 3, 4]
const DEFAULT_SPEED_INDEX = 2
/** Palette cycles per second at 1× speed. Slow enough to read as a mood shift, not a strobe. */
const COLOR_DRIFT_PER_SECOND = 0.02
/** rAF gaps longer than this are hitches (backgrounding, GC); the scene must not lurch to catch up. */
const MAX_FRAME_SECONDS = 0.1
const DISSOLVE_SECONDS = 1.5
const STARTUP_HUD_MS = 6000
const FRAME_INTERVAL_SMOOTHING = 0.1
const HELP_TEXT = '◀ ▶ scene   ▲ ▼ speed   ● ● ● ● palette   OK info   BACK exit'

/** webOS launches from file:// with no query string; `ares-launch --params '{"scene":2}'` arrives here instead. */
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

function numberParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name)
  if (raw === null || raw === '') return null
  const value = Number(raw)
  return isNaN(value) ? null : value
}

/** `?scene=` takes an index or a visualization id. */
function sceneParam(params: URLSearchParams): number {
  const raw = params.get('scene')
  if (raw === null) return 0
  const byId = VISUALIZATIONS.findIndex((v) => v.id === raw)
  if (byId >= 0) return byId
  const index = Number(raw)
  if (isNaN(index)) return 0
  return ((Math.floor(index) % VISUALIZATIONS.length) + VISUALIZATIONS.length) % VISUALIZATIONS.length
}

/** Runtime overrides reachable from DevTools as window.__pins, so the budget can be varied on the TV without relaunching. */
interface Pins {
  /** Render resolution as a fraction of the viewport; null adapts. */
  res: number | null
}

function main(): void {
  const stage = document.getElementById('stage')
  const hudRoot = document.getElementById('hud')
  if (!(stage instanceof HTMLCanvasElement) || !hudRoot) throw new Error('missing #stage or #hud')
  const canvas: HTMLCanvasElement = stage

  const hud = new Hud(hudRoot)
  const created = Renderer.create(canvas)
  if (!created) {
    hud.show({ title: 'Light Show', subtitle: 'WebGL is unavailable on this device', help: '' }, 60000)
    return
  }
  const renderer: Renderer = created
  const params = launchParams()
  const palettes = new PaletteMixer()
  const budget = new AdaptiveBudget(TV_BUDGET_OPTIONS)
  const pins: Pins = { res: numberParam(params, 'res') }
  ;(window as unknown as { __pins: Pins }).__pins = pins
  const paletteIndex = numberParam(params, 'palette')
  if (paletteIndex !== null) palettes.select(paletteIndex)

  let sceneIndex = sceneParam(params)
  let time = numberParam(params, 't') || 0
  let speedIndex = DEFAULT_SPEED_INDEX
  let paused = false
  let colorDrift = 0
  let dissolve = 1
  let lastTimestamp = performance.now()
  let averageFrameMs = 1000 / 60
  let renderFailed = false

  function applySize(): void {
    renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight))
  }

  function pixelBudget(): number {
    if (pins.res === null) return budget.work
    return Math.round(window.innerWidth * pins.res) * Math.round(window.innerHeight * pins.res)
  }

  function hudInfo(): void {
    const stats = renderer.stats
    const state = paused ? 'Paused' : SPEED_STEPS[speedIndex] + '×'
    hud.show({
      title: VISUALIZATIONS[sceneIndex].name,
      subtitle:
        palettes.current.name +
        '  ·  ' +
        state +
        '  ·  ' +
        stats.width +
        '×' +
        stats.height +
        '  ·  ' +
        averageFrameMs.toFixed(1) +
        ' ms' +
        (budget.baselineMs === null ? '' : ' (base ' + budget.baselineMs.toFixed(1) + ')'),
      help: HELP_TEXT,
    })
  }

  function changeScene(step: number): void {
    sceneIndex = (sceneIndex + step + VISUALIZATIONS.length) % VISUALIZATIONS.length
    dissolve = 0
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
        changeScene(-1)
        break
      case 'right':
        changeScene(1)
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

  function loop(timestamp: number): void {
    const frameMs = timestamp - lastTimestamp
    lastTimestamp = timestamp
    const frameSeconds = Math.min(frameMs / 1000, MAX_FRAME_SECONDS)
    averageFrameMs += (Math.min(frameMs, 1000) - averageFrameMs) * FRAME_INTERVAL_SMOOTHING
    const dt = paused ? 0 : frameSeconds * SPEED_STEPS[speedIndex]
    time += dt
    colorDrift = (colorDrift + dt * COLOR_DRIFT_PER_SECOND) % 1
    dissolve = Math.min(1, dissolve + frameSeconds / DISSOLVE_SECONDS)
    palettes.update(frameSeconds)
    budget.record(frameMs, timestamp)
    try {
      renderer.render({
        viz: VISUALIZATIONS[sceneIndex],
        time,
        dt,
        palette: palettes.blend(),
        paletteDrift: colorDrift,
        blend: dissolve * dissolve * (3 - 2 * dissolve),
        brightness: 1,
        pixels: pixelBudget(),
      })
    } catch (error) {
      // A rendering fault must not stop the loop; the next scene may well be fine.
      if (!renderFailed) console.error(String(error))
      renderFailed = true
    }
    window.requestAnimationFrame(loop)
  }

  applySize()
  hud.show({ title: VISUALIZATIONS[sceneIndex].name, subtitle: palettes.current.name, help: HELP_TEXT }, STARTUP_HUD_MS)
  window.requestAnimationFrame(loop)
}

main()

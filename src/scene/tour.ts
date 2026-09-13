import { logLerp, smoothstep, TWO_PI, type Vec2 } from './math'
import { iterationsForScale, MIN_SCALE, OVERVIEW_CENTER, OVERVIEW_SCALE } from './quality'
import { SCENES, type DiveScene, type JuliaScene, type Scene } from './scenes'

export type Phase = 'in' | 'hold' | 'out' | 'roam'

export interface SceneFrame {
  readonly center: Vec2
  readonly scale: number
  readonly rotation: number
  readonly julia: boolean
  readonly seed: Vec2
  readonly maxIter: number
  readonly sceneName: string
  readonly sceneIndex: number
  readonly phase: Phase
  /** 0 = black, 1 = full brightness. Dips at scene boundaries to hide the cut. */
  readonly brightness: number
}

const FADE_SECONDS = 2
const HOLD_BREATHE_AMOUNT = 0.12
const HOLD_BREATHE_PERIOD_SECONDS = 24
const JULIA_BREATHE_AMOUNT = 0.08
const JULIA_DRIFT_AMOUNT = 0.12

function diveDuration(scene: DiveScene): number {
  return scene.zoomInSeconds + scene.holdSeconds + scene.zoomOutSeconds
}

export function sceneDuration(scene: Scene): number {
  return scene.kind === 'dive' ? diveDuration(scene) : scene.durationSeconds
}

/** Drives the camera through the scene list: zoom dives into the Mandelbrot set alternating with morphing Julia sets. */
export class Tour {
  private index: number
  private sceneTime = 0
  private rotation = 0

  constructor(private readonly scenes: readonly Scene[] = SCENES, startIndex = 0) {
    this.index = ((startIndex % scenes.length) + scenes.length) % scenes.length
  }

  get sceneIndex(): number {
    return this.index
  }

  get scene(): Scene {
    return this.scenes[this.index]
  }

  get elapsed(): number {
    return this.sceneTime
  }

  next(): void {
    this.jump(this.index + 1)
  }

  prev(): void {
    this.jump(this.index - 1)
  }

  /** Skips straight to a moment inside the current scene. Used for debugging views. */
  seek(seconds: number): void {
    this.sceneTime = Math.max(0, Math.min(seconds, sceneDuration(this.scene)))
  }

  /** Advances time. Returns true when the tour moved on to a new scene. */
  update(dtSeconds: number): boolean {
    this.rotation = (this.rotation + this.scene.spin * dtSeconds) % TWO_PI
    this.sceneTime += dtSeconds
    if (this.sceneTime < sceneDuration(this.scene)) return false
    this.jump(this.index + 1)
    return true
  }

  frame(): SceneFrame {
    const scene = this.scene
    const duration = sceneDuration(scene)
    const brightness = Math.max(
      0,
      Math.min(1, this.sceneTime / FADE_SECONDS, (duration - this.sceneTime) / FADE_SECONDS),
    )
    const base = scene.kind === 'dive' ? this.diveFrame(scene) : this.juliaFrame(scene)
    return {
      ...base,
      rotation: this.rotation,
      maxIter: scene.kind === 'julia' ? scene.iterations : iterationsForScale(base.scale),
      sceneName: scene.name,
      sceneIndex: this.index,
      brightness,
    }
  }

  private jump(index: number): void {
    const n = this.scenes.length
    this.index = ((index % n) + n) % n
    this.sceneTime = 0
  }

  private diveFrame(scene: DiveScene): Pick<SceneFrame, 'center' | 'scale' | 'julia' | 'seed' | 'phase'> {
    const t = this.sceneTime
    const targetScale = Math.max(scene.targetScale, MIN_SCALE)
    let scale: number
    let phase: Phase
    if (t < scene.zoomInSeconds) {
      phase = 'in'
      scale = logLerp(OVERVIEW_SCALE, targetScale, smoothstep(t / scene.zoomInSeconds))
    } else if (t < scene.zoomInSeconds + scene.holdSeconds) {
      phase = 'hold'
      const holdTime = t - scene.zoomInSeconds
      const breathe = 1 + HOLD_BREATHE_AMOUNT * Math.sin((TWO_PI * holdTime) / HOLD_BREATHE_PERIOD_SECONDS)
      scale = targetScale * breathe
    } else {
      phase = 'out'
      const outTime = t - scene.zoomInSeconds - scene.holdSeconds
      scale = logLerp(targetScale, OVERVIEW_SCALE, smoothstep(outTime / scene.zoomOutSeconds))
    }
    // Shrinking the overview offset in proportion to scale keeps the target pinned to the
    // same screen position for the whole zoom, so the eye never has to chase it.
    const k = scale / OVERVIEW_SCALE
    const center: Vec2 = [
      scene.target[0] + (OVERVIEW_CENTER[0] - scene.target[0]) * k,
      scene.target[1] + (OVERVIEW_CENTER[1] - scene.target[1]) * k,
    ]
    return { center, scale, julia: false, seed: [0, 0], phase }
  }

  private juliaFrame(scene: JuliaScene): Pick<SceneFrame, 'center' | 'scale' | 'julia' | 'seed' | 'phase'> {
    const u = Math.min(1, this.sceneTime / scene.durationSeconds)
    const wobble = TWO_PI * this.sceneTime
    const scale = scene.scale * (1 + JULIA_BREATHE_AMOUNT * Math.sin(wobble / 31))
    const center: Vec2 = [
      JULIA_DRIFT_AMOUNT * Math.sin(wobble / 47),
      JULIA_DRIFT_AMOUNT * Math.cos(wobble / 59),
    ]
    return { center, scale, julia: true, seed: scene.seedPath(u), phase: 'roam' }
  }
}

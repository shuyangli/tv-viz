import { smoothstep, TWO_PI, type Vec2 } from './math'
import type { MisiurewiczPoint } from './misiurewicz'
import { diveIterations, OVERVIEW_CENTER, OVERVIEW_SCALE } from './quality'
import { SCENES, type DiveScene, type JuliaScene, type Scene } from './scenes'

export type Phase = 'in' | 'roam'

export interface SceneFrame {
  /** Point the view is expressed relative to: the dive's Misiurewicz point, or the Julia view centre. */
  readonly anchor: Vec2
  /** Screen centre minus anchor, in view units (half the viewport height = 1). */
  readonly offset: Vec2
  readonly log2Scale: number
  readonly rotation: number
  readonly julia: boolean
  readonly seed: Vec2
  readonly reference: MisiurewiczPoint | null
  readonly maxIter: number
  readonly sceneName: string
  readonly sceneIndex: number
  /** Changes on every scene switch and every loop restart, so a keyframe from before the cut is never shown after it. */
  readonly epoch: number
  readonly phase: Phase
  /** 0 = black, 1 = full brightness. Dips at scene boundaries to hide the cut. */
  readonly brightness: number
}

const FADE_SECONDS = 2
const JULIA_BREATHE_AMOUNT = 0.08
const JULIA_DRIFT_AMOUNT = 0.12
/** Zoom speed of every dive. Constant in log space, so it reads as a steady fall. */
export const ZOOM_DOUBLINGS_PER_SECOND = 0.12
/** The dive starts framed like the overview and slides its point to the screen centre over these first doublings. */
const CENTERING_DOUBLINGS = 8

export function sceneDuration(scene: Scene): number {
  return scene.kind === 'dive' ? Infinity : scene.durationSeconds
}

/** Zoom depth of a dive in doublings below the overview. */
export function diveDepth(seconds: number): number {
  return seconds * ZOOM_DOUBLINGS_PER_SECOND
}

/**
 * Drives the camera for the current scene: a dive falls forever toward its Misiurewicz
 * point at a constant rate; a Julia scene morphs its seed and loops. Scenes only change
 * on request.
 */
export class Tour {
  private index: number
  private sceneTime = 0
  private rotation = 0
  private _epoch = 0

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

  get epoch(): number {
    return this._epoch
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

  /** Advances time. Returns true when a looping scene reached its end and restarted. */
  update(dtSeconds: number): boolean {
    this.rotation = (this.rotation + this.scene.spin * dtSeconds) % TWO_PI
    this.sceneTime += dtSeconds
    const duration = sceneDuration(this.scene)
    if (this.sceneTime < duration) return false
    this.sceneTime = this.sceneTime % duration
    this._epoch += 1
    return true
  }

  frame(): SceneFrame {
    return this.frameAt(0)
  }

  /**
   * The frame `aheadSeconds` from now, without advancing. Clamped to the current run of
   * the scene: a keyframe predicted across a restart would be reprojected through the
   * wrong camera, and the fade to black there means a slightly stale one is invisible.
   */
  frameAt(aheadSeconds: number): SceneFrame {
    const scene = this.scene
    const duration = sceneDuration(scene)
    const t = Math.max(0, Math.min(this.sceneTime + aheadSeconds, duration))
    const brightness = Math.max(0, Math.min(1, t / FADE_SECONDS, (duration - t) / FADE_SECONDS))
    const base = scene.kind === 'dive' ? this.diveFrame(scene, t) : this.juliaFrame(scene, t)
    return {
      ...base,
      rotation: (this.rotation + scene.spin * aheadSeconds) % TWO_PI,
      sceneName: scene.name,
      sceneIndex: this.index,
      epoch: this._epoch,
      brightness,
    }
  }

  private jump(index: number): void {
    const n = this.scenes.length
    this.index = ((index % n) + n) % n
    this.sceneTime = 0
    this._epoch += 1
  }

  private diveFrame(
    scene: DiveScene,
    t: number,
  ): Pick<SceneFrame, 'anchor' | 'offset' | 'log2Scale' | 'julia' | 'seed' | 'reference' | 'maxIter' | 'phase'> {
    const depth = diveDepth(t)
    const c = scene.point.c
    // Start framed exactly like the overview, then ease the point toward the screen centre.
    const framing = 1 - smoothstep(depth / CENTERING_DOUBLINGS)
    const offset: Vec2 = [
      ((OVERVIEW_CENTER[0] - c[0]) / OVERVIEW_SCALE) * framing,
      ((OVERVIEW_CENTER[1] - c[1]) / OVERVIEW_SCALE) * framing,
    ]
    return {
      anchor: c,
      offset,
      log2Scale: Math.log2(OVERVIEW_SCALE) - depth,
      julia: false,
      seed: [0, 0],
      reference: scene.point,
      maxIter: diveIterations(scene.point),
      phase: 'in',
    }
  }

  private juliaFrame(
    scene: JuliaScene,
    t: number,
  ): Pick<SceneFrame, 'anchor' | 'offset' | 'log2Scale' | 'julia' | 'seed' | 'reference' | 'maxIter' | 'phase'> {
    const u = Math.min(1, t / scene.durationSeconds)
    const wobble = TWO_PI * t
    const scale = scene.scale * (1 + JULIA_BREATHE_AMOUNT * Math.sin(wobble / 31))
    const anchor: Vec2 = [JULIA_DRIFT_AMOUNT * Math.sin(wobble / 47), JULIA_DRIFT_AMOUNT * Math.cos(wobble / 59)]
    return {
      anchor,
      offset: [0, 0],
      log2Scale: Math.log2(scale),
      julia: true,
      seed: scene.seedPath(u),
      reference: null,
      maxIter: scene.iterations,
      phase: 'roam',
    }
  }
}

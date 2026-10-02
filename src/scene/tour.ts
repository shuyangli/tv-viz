import { smoothstep, TWO_PI, type Vec2 } from './math'
import type { MisiurewiczPoint } from './misiurewicz'
import { diveIterations } from './quality'
import { SCENES, type DiveScene, type Scene } from './scenes'

export interface SceneFrame {
  /** Point the view is expressed relative to: the dive's Misiurewicz point. */
  readonly anchor: Vec2
  /** Screen centre minus anchor, in view units (half the viewport height = 1). */
  readonly offset: Vec2
  readonly log2Scale: number
  /** Doublings below the formula's overview. */
  readonly depth: number
  readonly rotation: number
  readonly reference: MisiurewiczPoint
  readonly maxIter: number
  readonly sceneName: string
  readonly sceneIndex: number
  /** Changes on every scene switch and every loop restart, so a keyframe from before the cut is never shown after it. */
  readonly epoch: number
  /** 0 = black, 1 = full brightness. Fades in after a cut. */
  readonly brightness: number
}

const FADE_SECONDS = 2
/** Zoom speed of every dive. Constant in log space, so it reads as a steady fall. */
export const ZOOM_DOUBLINGS_PER_SECOND = 0.12
/** The dive starts framed like the overview and slides its point to the screen centre over these first doublings. */
const CENTERING_DOUBLINGS = 8

/** Zoom depth of a dive in doublings below the overview. */
export function diveDepth(seconds: number): number {
  return seconds * ZOOM_DOUBLINGS_PER_SECOND
}

/**
 * Drives the camera for the current scene: every scene is a dive that falls forever
 * toward its Misiurewicz point at a constant rate. Scenes only change on request.
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
    this.sceneTime = Math.max(0, seconds)
  }

  /** Advances time. Dives never end, so this never restarts a scene; it returns false for callers that once relied on that. */
  update(dtSeconds: number): boolean {
    this.rotation = (this.rotation + this.scene.spin * dtSeconds) % TWO_PI
    this.sceneTime += dtSeconds
    return false
  }

  frame(): SceneFrame {
    return this.frameAt(0)
  }

  /** The frame at which the dive reaches `log2Scale`, without advancing. Rotation is tied to depth, so this holds at any speed. */
  frameAtLog2Scale(log2Scale: number): SceneFrame {
    const depth = Math.log2(this.scene.point.formula.overviewScale) - log2Scale
    return this.frameAt(depth / ZOOM_DOUBLINGS_PER_SECOND - this.sceneTime)
  }

  /** The frame `aheadSeconds` from now, without advancing. */
  frameAt(aheadSeconds: number): SceneFrame {
    const scene = this.scene
    const t = Math.max(0, this.sceneTime + aheadSeconds)
    const brightness = Math.max(0, Math.min(1, t / FADE_SECONDS))
    const base = this.diveFrame(scene, t)
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

  private diveFrame(scene: DiveScene, t: number): Pick<SceneFrame, 'anchor' | 'offset' | 'log2Scale' | 'depth' | 'reference' | 'maxIter'> {
    const depth = diveDepth(t)
    const c = scene.point.c
    const { overviewCenter, overviewScale } = scene.point.formula
    // Start framed exactly like the overview, then ease the point toward the screen centre.
    const framing = 1 - smoothstep(depth / CENTERING_DOUBLINGS)
    const offset: Vec2 = [
      ((overviewCenter[0] - c[0]) / overviewScale) * framing,
      ((overviewCenter[1] - c[1]) / overviewScale) * framing,
    ]
    return {
      anchor: c,
      offset,
      log2Scale: Math.log2(overviewScale) - depth,
      depth,
      reference: scene.point,
      maxIter: diveIterations(scene.point),
    }
  }
}

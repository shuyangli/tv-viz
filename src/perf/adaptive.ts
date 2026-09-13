export interface AdaptiveOptions {
  readonly initial: number
  readonly min: number
  readonly max: number
  /** Frame time the controller steers toward. */
  readonly targetMs: number
  /** Frames averaged before each decision. */
  readonly window: number
  /** Frames longer than this are treated as hitches (tab switch, GC) and ignored. */
  readonly hitchMs: number
}

/**
 * Measured on the LG CX: at 60 fps the GPU forces the image below 500 px wide, which
 * upscales to mush on a 4K panel. A steady 30 fps at a third of 1080p looks far better
 * for slow ambient motion, and the panel simply repeats frames.
 */
export const TV_ADAPTIVE_OPTIONS: AdaptiveOptions = {
  initial: 0.5,
  min: 0.34,
  max: 1,
  targetMs: 1000 / 30,
  window: 45,
  hitchMs: 250,
}

const SLOW_RATIO = 1.25
const FAST_RATIO = 0.6
const SHRINK_FACTOR = 0.85
const GROW_FACTOR = 1.1

/**
 * Scales the render resolution so the frame rate stays near target. Grows slowly and
 * shrinks quickly: a dropped frame is more visible than a slightly softer image.
 */
export class AdaptiveResolution {
  private _scale: number
  private sum = 0
  private count = 0

  constructor(private readonly opts: AdaptiveOptions = TV_ADAPTIVE_OPTIONS) {
    this._scale = opts.initial
  }

  get scale(): number {
    return this._scale
  }

  /** Records one frame's duration. Returns true when the scale changed. */
  record(frameMs: number): boolean {
    if (frameMs > this.opts.hitchMs || frameMs <= 0) return false
    this.sum += frameMs
    this.count += 1
    if (this.count < this.opts.window) return false
    const average = this.sum / this.count
    this.sum = 0
    this.count = 0
    const before = this._scale
    if (average > this.opts.targetMs * SLOW_RATIO) {
      this._scale = Math.max(this.opts.min, this._scale * SHRINK_FACTOR)
    } else if (average < this.opts.targetMs * FAST_RATIO) {
      this._scale = Math.min(this.opts.max, this._scale * GROW_FACTOR)
    }
    return this._scale !== before
  }
}

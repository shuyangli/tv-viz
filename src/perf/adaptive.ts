export interface BudgetOptions {
  readonly initialScale: number
  readonly minScale: number
  readonly maxScale: number
  readonly initialTiles: number
  readonly minTiles: number
  readonly maxTiles: number
  /** Frame time the controller steers toward. */
  readonly targetMs: number
  /** Frames averaged before each decision. */
  readonly window: number
  /** Frames longer than this are treated as hitches (tab switch, GC) and ignored. */
  readonly hitchMs: number
  /** Wait after the first failed probe before trying to grow again; doubles on each further failure. */
  readonly probeDelayMs: number
  readonly maxProbeDelayMs: number
}

/**
 * The LG CX refreshes at 60 Hz, so present at 60 fps and spend what is left of each frame
 * on a slice of the next keyframe. Keyframes at full 1080p spread over up to 8 frames
 * still refresh the fractal 7.5 times a second, which slow ambient motion hides
 * completely behind the reprojection.
 */
export const TV_BUDGET_OPTIONS: BudgetOptions = {
  initialScale: 0.5,
  minScale: 0.25,
  maxScale: 1,
  initialTiles: 4,
  minTiles: 1,
  maxTiles: 8,
  targetMs: 1000 / 60,
  window: 60,
  hitchMs: 250,
  probeDelayMs: 4000,
  maxProbeDelayMs: 5 * 60 * 1000,
}

/** With vsync, the window mean is target * (1 + late fraction): shrink past ~5% late frames, grow only when essentially none are. */
const SLOW_RATIO = 1.05
const FAST_RATIO = 1.015
const SHRINK_FACTOR = 0.9
const GROW_FACTOR = 1.06

export interface Budget {
  readonly scale: number
  readonly tiles: number
}

/**
 * Steers keyframe resolution and the number of frames a keyframe is spread over so the
 * display holds its refresh rate. When slow, it first spreads keyframes over more frames
 * (costing only latency) and then lowers resolution. When every frame lands on time it
 * grows again, resolution first. vsync hides how much headroom a fast frame has, so
 * growth is a probe: a probe that pushes frames late is undone and the next one waits
 * exponentially longer, which keeps the resulting stutter rare.
 */
export class AdaptiveBudget implements Budget {
  private _scale: number
  private _tiles: number
  private sum = 0
  private count = 0
  private grewLast = false
  private probeDelay = 0
  private nextProbeAt = 0

  constructor(private readonly opts: BudgetOptions = TV_BUDGET_OPTIONS) {
    this._scale = opts.initialScale
    this._tiles = opts.initialTiles
  }

  get scale(): number {
    return this._scale
  }

  get tiles(): number {
    return this._tiles
  }

  /** The load has changed (new scene), so earlier failed probes say nothing about the new ceiling. */
  invalidate(): void {
    this.probeDelay = 0
    this.nextProbeAt = 0
    this.grewLast = false
    this.sum = 0
    this.count = 0
  }

  /** Records one frame's duration. Returns true when the budget changed. */
  record(frameMs: number, nowMs: number): boolean {
    if (frameMs > this.opts.hitchMs || frameMs <= 0) return false
    this.sum += frameMs
    this.count += 1
    if (this.count < this.opts.window) return false
    const average = this.sum / this.count
    this.sum = 0
    this.count = 0
    if (average > this.opts.targetMs * SLOW_RATIO) {
      if (this.grewLast) {
        this.probeDelay =
          this.probeDelay === 0
            ? this.opts.probeDelayMs
            : Math.min(this.opts.maxProbeDelayMs, this.probeDelay * 2)
      }
      this.grewLast = false
      this.nextProbeAt = nowMs + this.probeDelay
      return this.shrink()
    }
    if (average <= this.opts.targetMs * FAST_RATIO && nowMs >= this.nextProbeAt) {
      const grew = this.grow()
      this.grewLast = grew
      return grew
    }
    return false
  }

  private shrink(): boolean {
    if (this._tiles < this.opts.maxTiles) {
      this._tiles += 1
      return true
    }
    if (this._scale > this.opts.minScale) {
      this._scale = Math.max(this.opts.minScale, this._scale * SHRINK_FACTOR)
      return true
    }
    return false
  }

  private grow(): boolean {
    if (this._scale < this.opts.maxScale) {
      this._scale = Math.min(this.opts.maxScale, this._scale * GROW_FACTOR)
      return true
    }
    if (this._tiles > this.opts.minTiles) {
      this._tiles -= 1
      return true
    }
    return false
  }
}

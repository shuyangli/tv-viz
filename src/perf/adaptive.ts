export interface BudgetOptions {
  /** Work per frame while the baseline is measured, and the starting point after it. */
  readonly initial: number
  readonly min: number
  readonly max: number
  /** Frames over which the baseline frame interval is measured. */
  readonly baselineFrames: number
  /** Frames averaged before each decision. */
  readonly window: number
  /** Frames longer than this are treated as hitches (tab switch, GC) and ignored. */
  readonly hitchMs: number
  /** Wait after the first failed probe before trying to grow again; doubles on each further failure. */
  readonly probeDelayMs: number
  readonly maxProbeDelayMs: number
}

/**
 * The knob is escape-time samples per frame; the renderer turns it into rows per frame
 * and, over a keyframe's lifetime, into resolution and supersampling. The starting work
 * is a third of what the CX managed per frame in earlier builds, so the baseline is
 * measured under a load it is sure to carry.
 */
export const TV_BUDGET_OPTIONS: BudgetOptions = {
  initial: 30000,
  min: 4000,
  max: 4000000,
  baselineFrames: 90,
  window: 60,
  hitchMs: 250,
  probeDelayMs: 4000,
  maxProbeDelayMs: 5 * 60 * 1000,
}

/**
 * Relative to the baseline, whose late-frame pattern is already in it: shrink once the
 * window mean is clearly above it, grow only when it is essentially back at it.
 */
const SLOW_RATIO = 1.04
const FAST_RATIO = 1.015
const SHRINK_FACTOR = 0.75
const GROW_FACTOR = 1.1

/**
 * Steers the work per displayed frame so it does not slow the display down. The display
 * is not assumed to run at 60 Hz: the TV presents at whatever rate the panel is in, and
 * with a 60 Hz animation clock a 50 Hz panel already shows one late frame in five with
 * no work at all. So the controller first measures the frame interval under a light,
 * known load and then steers the mean interval back to that baseline. vsync hides how
 * much headroom a fast frame has, so growth is a probe: a probe that pushes frames late
 * is undone and the next one waits exponentially longer, which keeps the resulting
 * stutter rare. Shrinking while already at the minimum means the baseline itself has
 * moved (the panel changed mode), so it is measured again.
 */
export class AdaptiveBudget {
  private _samplesPerFrame: number
  private _baselineMs: number | null = null
  private sum = 0
  private count = 0
  private grewLast = false
  private probeDelay = 0
  private nextProbeAt = 0

  constructor(private readonly opts: BudgetOptions = TV_BUDGET_OPTIONS) {
    this._samplesPerFrame = opts.initial
  }

  get samplesPerFrame(): number {
    return this._samplesPerFrame
  }

  /** Mean frame interval measured under the initial load, or null while it is being measured. */
  get baselineMs(): number | null {
    return this._baselineMs
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
    if (this._baselineMs === null) {
      if (this.count < this.opts.baselineFrames) return false
      this._baselineMs = this.sum / this.count
      this.sum = 0
      this.count = 0
      return false
    }
    if (this.count < this.opts.window) return false
    const average = this.sum / this.count
    this.sum = 0
    this.count = 0
    if (average > this._baselineMs * SLOW_RATIO) {
      if (this.grewLast) {
        this.probeDelay =
          this.probeDelay === 0
            ? this.opts.probeDelayMs
            : Math.min(this.opts.maxProbeDelayMs, this.probeDelay * 2)
      }
      this.grewLast = false
      this.nextProbeAt = nowMs + this.probeDelay
      if (this._samplesPerFrame <= this.opts.min) {
        this.rebaseline()
        return false
      }
      return this.set(this._samplesPerFrame * SHRINK_FACTOR)
    }
    if (average <= this._baselineMs * FAST_RATIO && nowMs >= this.nextProbeAt) {
      const grew = this.set(this._samplesPerFrame * GROW_FACTOR)
      this.grewLast = grew
      return grew
    }
    return false
  }

  private rebaseline(): void {
    this._baselineMs = null
    this._samplesPerFrame = this.opts.initial
    this.grewLast = false
  }

  private set(value: number): boolean {
    const clamped = Math.max(this.opts.min, Math.min(this.opts.max, value))
    if (clamped === this._samplesPerFrame) return false
    this._samplesPerFrame = clamped
    return true
  }
}

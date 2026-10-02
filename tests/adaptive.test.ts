import { describe, expect, it } from 'vitest'
import { AdaptiveBudget, type BudgetOptions } from '../src/perf/adaptive'

const opts: BudgetOptions = {
  initial: 1000,
  min: 100,
  max: 10000,
  baselineFrames: 4,
  window: 4,
  hitchMs: 200,
  probeDelayMs: 1000,
  maxProbeDelayMs: 4000,
}

let clock = 0

function feed(controller: AdaptiveBudget, frameMs: number, frames: number): boolean {
  let changed = false
  for (let i = 0; i < frames; i++) {
    clock += frameMs
    changed = controller.record(frameMs, clock) || changed
  }
  return changed
}

/** A controller past its baseline phase, measured at 60 Hz. */
function settled(frameMs = 16): AdaptiveBudget {
  const c = new AdaptiveBudget(opts)
  feed(c, frameMs, opts.baselineFrames)
  return c
}

describe('AdaptiveBudget baseline', () => {
  it('measures the frame interval under the initial load before adapting', () => {
    const c = new AdaptiveBudget(opts)
    expect(c.baselineMs).toBeNull()
    expect(feed(c, 20, 3)).toBe(false)
    expect(feed(c, 20, 1)).toBe(false)
    expect(c.baselineMs).toBe(20)
    expect(c.samplesPerFrame).toBe(1000)
  })

  it('treats a 50 Hz panel as normal: frames at the baseline grow the work', () => {
    const c = settled(20)
    expect(feed(c, 20, 4)).toBe(true)
    expect(c.samplesPerFrame).toBeGreaterThan(1000)
  })

  it('measures the baseline again when even the minimum work is slow, since the panel must have changed mode', () => {
    const c = settled(16)
    for (let i = 0; i < 20 && c.samplesPerFrame > 100; i++) feed(c, 30, 4)
    expect(c.samplesPerFrame).toBe(100)
    expect(c.baselineMs).toBe(16)
    feed(c, 30, 4)
    expect(c.baselineMs).toBeNull()
    expect(c.samplesPerFrame).toBe(1000)
    feed(c, 20, 4)
    expect(c.baselineMs).toBe(20)
  })
})

describe('AdaptiveBudget', () => {
  it('shrinks when frames run slower than the baseline', () => {
    const c = settled()
    expect(feed(c, 30, 3)).toBe(false)
    expect(feed(c, 30, 1)).toBe(true)
    expect(c.samplesPerFrame).toBe(750)
    feed(c, 30, 4)
    expect(c.samplesPerFrame).toBeLessThan(750)
  })

  it('grows gradually when frames land on the baseline', () => {
    const c = settled()
    expect(feed(c, 16, 4)).toBe(true)
    expect(c.samplesPerFrame).toBeGreaterThan(1000)
    expect(c.samplesPerFrame).toBeLessThan(1200)
    for (let i = 0; i < 60; i++) feed(c, 16, 4)
    expect(c.samplesPerFrame).toBe(10000)
  })

  it('holds steady when frames are only slightly late', () => {
    const c = settled()
    expect(feed(c, 16.4, 8)).toBe(false)
    expect(c.samplesPerFrame).toBe(1000)
  })

  it('ignores hitches so one tab switch does not tank the budget', () => {
    const c = settled()
    feed(c, 16, 3)
    expect(c.record(5000, clock)).toBe(false)
    expect(c.record(16, clock)).toBe(true)
    expect(c.samplesPerFrame).toBeGreaterThan(1000)
  })

  it('backs off probing after a grow makes frames late, doubling the wait each time', () => {
    const c = settled()
    feed(c, 16, 4)
    expect(c.samplesPerFrame).toBeGreaterThan(1000)
    expect(feed(c, 30, 4)).toBe(true)
    // Within the probe delay, on-time frames do not grow again.
    expect(feed(c, 16, 4)).toBe(false)
    clock += 1000
    expect(feed(c, 16, 4)).toBe(true)
    // A second failure doubles the wait.
    feed(c, 30, 4)
    clock += 1000
    expect(feed(c, 16, 4)).toBe(false)
    clock += 1000
    expect(feed(c, 16, 4)).toBe(true)
  })

  it('does not treat a shrink caused by heavier content as a failed probe', () => {
    const c = settled()
    feed(c, 30, 4)
    feed(c, 30, 4)
    expect(feed(c, 16, 4)).toBe(true)
  })

  it('forgets failed probes when invalidated for a new scene but keeps the baseline', () => {
    const c = settled()
    feed(c, 16, 4)
    feed(c, 30, 4)
    expect(feed(c, 16, 4)).toBe(false)
    c.invalidate()
    expect(c.baselineMs).toBe(16)
    expect(feed(c, 16, 4)).toBe(true)
  })

  it('can be pinned by collapsing its bounds', () => {
    const c = new AdaptiveBudget({ ...opts, initial: 500, min: 500, max: 500 })
    feed(c, 16, 4)
    expect(feed(c, 30, 4)).toBe(false)
    expect(feed(c, 16, 4)).toBe(false)
    expect(c.samplesPerFrame).toBe(500)
  })
})

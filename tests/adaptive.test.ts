import { describe, expect, it } from 'vitest'
import { AdaptiveBudget, type BudgetOptions } from '../src/perf/adaptive'

const opts: BudgetOptions = {
  initialScale: 0.5,
  minScale: 0.25,
  maxScale: 1,
  initialTiles: 4,
  minTiles: 1,
  maxTiles: 6,
  targetMs: 16,
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

describe('AdaptiveBudget', () => {
  it('spreads keyframes over more frames before lowering resolution when frames are slow', () => {
    const c = new AdaptiveBudget(opts)
    expect(feed(c, 30, 3)).toBe(false)
    expect(feed(c, 30, 1)).toBe(true)
    expect(c.tiles).toBe(5)
    expect(c.scale).toBe(0.5)
    feed(c, 30, 4)
    expect(c.tiles).toBe(6)
    feed(c, 30, 4)
    expect(c.tiles).toBe(6)
    expect(c.scale).toBeLessThan(0.5)
  })

  it('grows resolution first, then uses fewer frames per keyframe, when frames land on time', () => {
    const c = new AdaptiveBudget(opts)
    for (let i = 0; i < 40; i++) feed(c, 16, 4)
    expect(c.scale).toBe(1)
    expect(c.tiles).toBe(1)
  })

  it('never leaves its bounds', () => {
    const c = new AdaptiveBudget(opts)
    for (let i = 0; i < 40; i++) feed(c, 100, 4)
    expect(c.scale).toBe(0.25)
    expect(c.tiles).toBe(6)
  })

  it('holds steady when frames are only slightly late', () => {
    const c = new AdaptiveBudget(opts)
    expect(feed(c, 16.5, 8)).toBe(false)
    expect(c.scale).toBe(0.5)
    expect(c.tiles).toBe(4)
  })

  it('ignores hitches so one tab switch does not tank the budget', () => {
    const c = new AdaptiveBudget(opts)
    feed(c, 16, 3)
    expect(c.record(5000, clock)).toBe(false)
    expect(c.record(16, clock)).toBe(true)
    expect(c.scale).toBeGreaterThan(0.5)
  })

  it('backs off probing after a grow makes frames late, doubling the wait each time', () => {
    const c = new AdaptiveBudget(opts)
    feed(c, 16, 4)
    const grown = c.scale
    expect(grown).toBeGreaterThan(0.5)
    expect(feed(c, 30, 4)).toBe(true)
    expect(c.tiles).toBe(5)
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
    const c = new AdaptiveBudget(opts)
    feed(c, 30, 4)
    feed(c, 30, 4)
    expect(feed(c, 16, 4)).toBe(true)
  })

  it('forgets failed probes when invalidated for a new scene', () => {
    const c = new AdaptiveBudget(opts)
    feed(c, 16, 4)
    feed(c, 30, 4)
    expect(feed(c, 16, 4)).toBe(false)
    c.invalidate()
    expect(feed(c, 16, 4)).toBe(true)
  })
})

describe('pinned knobs', () => {
  it('adapts only the free knob when the other is pinned through its bounds', () => {
    const pinnedTiles = new AdaptiveBudget({ ...opts, initialTiles: 6, minTiles: 6, maxTiles: 6 })
    for (let i = 0; i < 10; i++) feed(pinnedTiles, 30, 4)
    expect(pinnedTiles.tiles).toBe(6)
    expect(pinnedTiles.scale).toBeLessThan(0.5)
    const pinnedScale = new AdaptiveBudget({ ...opts, initialScale: 0.34, minScale: 0.34, maxScale: 0.34 })
    for (let i = 0; i < 10; i++) feed(pinnedScale, 16, 4)
    expect(pinnedScale.scale).toBe(0.34)
    expect(pinnedScale.tiles).toBe(1)
  })
})

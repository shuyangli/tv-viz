import { describe, expect, it } from 'vitest'
import { AdaptiveResolution, type AdaptiveOptions } from '../src/perf/adaptive'

const opts: AdaptiveOptions = { initial: 0.5, min: 0.25, max: 1, targetMs: 16, window: 4, hitchMs: 200 }

function feed(controller: AdaptiveResolution, frameMs: number, frames: number): boolean {
  let changed = false
  for (let i = 0; i < frames; i++) changed = controller.record(frameMs) || changed
  return changed
}

describe('AdaptiveResolution', () => {
  it('lowers resolution when frames are slow', () => {
    const c = new AdaptiveResolution(opts)
    expect(feed(c, 30, 3)).toBe(false)
    expect(c.record(30)).toBe(true)
    expect(c.scale).toBeLessThan(0.5)
  })

  it('raises resolution when frames are fast, up to the max', () => {
    const c = new AdaptiveResolution(opts)
    for (let i = 0; i < 20; i++) feed(c, 5, 4)
    expect(c.scale).toBe(1)
  })

  it('never drops below the minimum', () => {
    const c = new AdaptiveResolution(opts)
    for (let i = 0; i < 20; i++) feed(c, 100, 4)
    expect(c.scale).toBe(0.25)
  })

  it('holds steady when frames are near target', () => {
    const c = new AdaptiveResolution(opts)
    expect(feed(c, 16, 8)).toBe(false)
    expect(c.scale).toBe(0.5)
  })

  it('ignores hitches so one tab switch does not tank the resolution', () => {
    const c = new AdaptiveResolution(opts)
    feed(c, 5, 3)
    expect(c.record(5000)).toBe(false)
    expect(c.record(5)).toBe(true)
    expect(c.scale).toBeGreaterThan(0.5)
  })
})

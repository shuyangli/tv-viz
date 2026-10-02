import { describe, expect, it } from 'vitest'
import {
  DISSOLVE,
  dissolveWeight,
  framesUntilDue,
  KEYFRAME_COVER,
  KEYFRAME_SPACING,
  nextKeyframeIndex,
  planQuality,
  scheduleU,
} from '../src/render/schedule'

describe('dissolveWeight', () => {
  it('fades a keyframe in over DISSOLVE units ending exactly at its own scale when it is ready in time', () => {
    expect(dissolveWeight(3 - DISSOLVE - 0.1, 3, 1.5)).toBe(0)
    expect(dissolveWeight(3 - DISSOLVE, 3, 1.5)).toBe(0)
    expect(dissolveWeight(3 - DISSOLVE / 2, 3, 1.5)).toBeCloseTo(0.5)
    expect(dissolveWeight(3, 3, 1.5)).toBeCloseTo(1, 12)
    expect(dissolveWeight(3.7, 3, 1.5)).toBe(1)
  })

  it('starts the fade when a late keyframe becomes ready and still takes the full dissolve', () => {
    const ready = 3.2
    expect(dissolveWeight(3.2, 3, ready)).toBe(0)
    expect(dissolveWeight(3.2 + DISSOLVE / 2, 3, ready)).toBeCloseTo(0.5)
    expect(dissolveWeight(3.2 + DISSOLVE, 3, ready)).toBeCloseTo(1, 12)
  })

  it('is monotonic and continuous in u', () => {
    let last = 0
    for (let u = 0; u <= 6; u += 0.01) {
      const w = dissolveWeight(u, 5, 4.9)
      expect(w).toBeGreaterThanOrEqual(last)
      expect(w - last).toBeLessThan(0.01 / DISSOLVE + 1e-9)
      last = w
    }
  })
})

describe('scheduleU', () => {
  it('counts keyframes from the start scale as the zoom deepens', () => {
    expect(scheduleU(-10, -10)).toBe(0)
    expect(scheduleU(-10, -10 - KEYFRAME_SPACING)).toBeCloseTo(1)
    expect(scheduleU(-5000, -5000 - 2.5 * KEYFRAME_SPACING)).toBeCloseTo(2.5)
  })
})

describe('nextKeyframeIndex', () => {
  it('follows the newest keyframe when renders keep up', () => {
    expect(nextKeyframeIndex(null, 0, 0)).toBe(0)
    // Keyframe 4 was promoted on time at u = 4 - DISSOLVE and the next render takes 0.75 units.
    expect(nextKeyframeIndex(4, 4 - DISSOLVE, 0.75)).toBe(5)
    // Slightly late: keep the sequence, accept the lateness.
    expect(nextKeyframeIndex(4, 4.4, 0.75)).toBe(5)
  })

  it('skips ahead when a render would finish more than a unit past its due point', () => {
    expect(nextKeyframeIndex(4, 4.4, 2)).toBeGreaterThan(5)
    expect(nextKeyframeIndex(4, 4.4, 2) - DISSOLVE).toBeGreaterThanOrEqual(4.4 + 2 - 1)
  })
})

describe('planQuality', () => {
  const screen = 1920 * 1080 * KEYFRAME_COVER * KEYFRAME_COVER

  it('buys 4x supersampling at full density when the budget is ample', () => {
    const q = planQuality(120000, 125, screen)
    expect(q.samples).toBe(4)
    expect(q.density).toBeCloseTo(1)
  })

  it('drops supersampling before resolution as the budget shrinks', () => {
    const q4 = planQuality(100000, 125, screen)
    const q2 = planQuality(50000, 125, screen)
    const q1 = planQuality(15000, 125, screen)
    expect(q4.samples).toBe(4)
    expect(q2.samples).toBe(2)
    expect(q1.samples).toBe(1)
    expect(q2.density).toBeGreaterThanOrEqual(0.85)
    expect(q1.density).toBeGreaterThan(0.5)
    expect(q1.density).toBeLessThan(1)
  })

  it('never goes below the minimum density', () => {
    const q = planQuality(100, 20, screen)
    expect(q.samples).toBe(1)
    expect(q.density).toBe(0.25)
  })

  it('honours pins', () => {
    expect(planQuality(50000, 125, screen, { density: 0.5, samples: null })).toEqual({ density: 0.5, samples: 4 })
    expect(planQuality(50000, 125, screen, { density: null, samples: 1 })).toEqual({ density: 1, samples: 1 })
    expect(planQuality(100, 125, screen, { density: 0.9, samples: 2 })).toEqual({ density: 0.9, samples: 2 })
  })
})

describe('framesUntilDue', () => {
  const perFrame = KEYFRAME_SPACING / 125

  it('gives a whole spacing when the previous keyframe was promoted on time', () => {
    expect(framesUntilDue(5, 4 - DISSOLVE, perFrame)).toBeCloseTo(125)
  })

  it('gives what is left when the previous dissolve had to finish first', () => {
    expect(framesUntilDue(5, 4, perFrame)).toBeCloseTo(125 * (1 - DISSOLVE))
  })

  it('floors at the minimum for a first or overdue keyframe and caps while paused', () => {
    expect(framesUntilDue(0, 0, perFrame)).toBe(20)
    expect(framesUntilDue(5, 5.5, perFrame)).toBe(20)
    expect(framesUntilDue(5, 4, 0)).toBe(600)
    expect(framesUntilDue(5, 4, 1e-9)).toBe(600)
  })
})

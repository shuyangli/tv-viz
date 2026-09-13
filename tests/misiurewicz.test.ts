import { describe, expect, it } from 'vitest'
import { planSkip } from '../src/render/gl'
import {
  classify,
  evaluateKoenigs,
  exactDelta,
  koenigsCoefficients,
  linearCoefficient,
  nearestMisiurewicz,
  perturbationConstants,
  solveMisiurewicz,
} from '../src/scene/misiurewicz'
import { diveIterations, HANDOFF_BITS, KOENIGS_ORDER, MAX_ITERATIONS } from '../src/scene/quality'
import { SCENES } from '../src/scene/scenes'

describe('Misiurewicz solver', () => {
  it('finds c = i, whose orbit 0 → i → −1+i → −i → −1+i has preperiod 2 and period 2', () => {
    const root = solveMisiurewicz([0.1, 1.1], 2, 2)
    expect(root).not.toBeNull()
    const point = classify(root as [number, number])
    expect(point).not.toBeNull()
    expect(point!.c[0]).toBeCloseTo(0, 10)
    expect(point!.c[1]).toBeCloseTo(1, 10)
    expect(point!.preperiod).toBe(2)
    expect(point!.period).toBe(2)
  })

  it('finds the tip of the antenna, c = −2, with preperiod 2 and period 1', () => {
    const root = solveMisiurewicz([-1.9, 0.05], 2, 1)
    const point = classify(root as [number, number])
    expect(point!.c[0]).toBeCloseTo(-2, 10)
    expect(point!.preperiod).toBe(2)
    expect(point!.period).toBe(1)
    expect(Math.hypot(...point!.multiplier)).toBeCloseTo(4)
  })

  it('rejects centres of hyperbolic components, whose orbit is periodic through 0', () => {
    expect(classify([0, 0])).toBeNull()
    expect(classify([-1, 0])).toBeNull()
  })

  it('finds the nearest point to a guess', () => {
    const point = nearestMisiurewicz([-0.1, 0.95], 8, 4, 0.05)
    expect(point).not.toBeNull()
    expect(point!.c[0]).toBeCloseTo(-0.101096363845622, 9)
    expect(point!.c[1]).toBeCloseTo(0.956286510809142, 9)
  })
})

describe('perturbation constants', () => {
  it('reproduce the linear coefficient recurrence over whole cycles in closed form', () => {
    for (const scene of SCENES) {
      if (scene.kind !== 'dive') continue
      const point = scene.point
      const k = perturbationConstants(point)
      const lambda = Math.pow(2, k.log2Lambda)
      for (const j of [1, 2, 5, 9]) {
        const direct = linearCoefficient(point, point.preperiod + j * point.period)
        const mag = Math.pow(lambda, j) * Math.pow(2, k.log2P)
        const phase = j * k.argLambda + k.argP
        const closed = [mag * Math.cos(phase) - k.Q[0], mag * Math.sin(phase) - k.Q[1]]
        const tolerance = 1e-9 * Math.max(1, Math.hypot(direct[0], direct[1]))
        expect(Math.abs(closed[0] - direct[0])).toBeLessThan(tolerance)
        expect(Math.abs(closed[1] - direct[1])).toBeLessThan(tolerance)
      }
    }
  })

  it('has a repelling multiplier for every dive so the skip grows and the cost stays bounded', () => {
    for (const scene of SCENES) {
      if (scene.kind !== 'dive') continue
      expect(perturbationConstants(scene.point).log2Lambda).toBeGreaterThan(0.05)
      const iterations = diveIterations(scene.point)
      expect(iterations).toBeGreaterThan(64)
      expect(iterations).toBeLessThanOrEqual(MAX_ITERATIONS)
    }
  })
})

describe('closed-form handoff', () => {
  it('matches the exact perturbation recurrence to well under a pixel at depth, for every dive', () => {
    const log2Scale = -40
    let worst = 0
    for (const scene of SCENES) {
      if (scene.kind !== 'dive') continue
      const point = scene.point
      const constants = perturbationConstants(point)
      const koenigs = koenigsCoefficients(point, KOENIGS_ORDER)
      const skip = planSkip(log2Scale, constants)
      for (const [vx, vy] of [
        [1, 0],
        [0.3, 0.2],
        [-0.7, 1.1],
        [0.05, -0.9],
        [1.6, -0.4],
      ]) {
        // Mirror of the shader: linear estimate u = λ^j P δc, then δ = φ(u).
        const log2dc = 0.5 * Math.log2(vx * vx + vy * vy)
        const dj = Math.floor((-HANDOFF_BITS - skip.log2Mag0 - log2dc) / constants.log2Lambda)
        const j = skip.j0 + dj
        expect(j).toBeGreaterThanOrEqual(1)
        const mag = Math.pow(2, skip.log2Mag0 + log2dc + dj * constants.log2Lambda)
        const phase = skip.phase0 + dj * constants.argLambda + Math.atan2(vy, vx)
        const u: [number, number] = [mag * Math.cos(phase), mag * Math.sin(phase)]
        const series = evaluateKoenigs(koenigs, u)
        const scale = skip.mant * Math.pow(2, -skip.k0)
        const exact = exactDelta(point, [vx * scale, vy * scale], point.preperiod + j * point.period)
        const relative = Math.hypot(series[0] - exact[0], series[1] - exact[1]) / Math.hypot(exact[0], exact[1])
        worst = Math.max(worst, relative)
        expect(Math.hypot(exact[0], exact[1])).toBeLessThan(Math.pow(2, -HANDOFF_BITS) * 1.01)
        expect(Math.hypot(exact[0], exact[1])).toBeGreaterThan(Math.pow(2, -HANDOFF_BITS - constants.log2Lambda) * 0.5)
      }
    }
    // One part in 10^4 of the offset is a hundredth of a pixel at 1080p.
    expect(worst).toBeLessThan(1e-4)
  })
})

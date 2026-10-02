import { describe, expect, it } from 'vitest'
import { planSkip } from '../src/render/gl'
import { mat2Apply, MANDELBROT } from '../src/scene/formula'
import {
  classify,
  exactDelta,
  koenigsCoefficients,
  linearCoefficient,
  nearestMisiurewicz,
  perturbationConstants,
  skipDelta,
  solveMisiurewicz,
} from '../src/scene/misiurewicz'
import { diveIterations, handoffBits, KOENIGS_ORDER, MAX_ITERATIONS } from '../src/scene/quality'
import { SCENES } from '../src/scene/scenes'

describe('Misiurewicz solver', () => {
  it('finds c = i, whose orbit 0 → i → −1+i → −i → −1+i has preperiod 2 and period 2', () => {
    const root = solveMisiurewicz(MANDELBROT, [0.1, 1.1], 2, 2)
    expect(root).not.toBeNull()
    const point = classify(MANDELBROT, root as [number, number])
    expect(point).not.toBeNull()
    expect(point!.c[0]).toBeCloseTo(0, 10)
    expect(point!.c[1]).toBeCloseTo(1, 10)
    expect(point!.preperiod).toBe(2)
    expect(point!.period).toBe(2)
  })

  it('finds the tip of the antenna, c = −2, with preperiod 2 and period 1', () => {
    const root = solveMisiurewicz(MANDELBROT, [-1.9, 0.05], 2, 1)
    const point = classify(MANDELBROT, root as [number, number])
    expect(point!.c[0]).toBeCloseTo(-2, 10)
    expect(point!.preperiod).toBe(2)
    expect(point!.period).toBe(1)
    expect(point!.growth).toBeCloseTo(4)
  })

  it('rejects centres of hyperbolic components, whose orbit is periodic through 0', () => {
    expect(classify(MANDELBROT, [0, 0])).toBeNull()
    expect(classify(MANDELBROT, [-1, 0])).toBeNull()
  })

  it('finds the nearest point to a guess', () => {
    const point = nearestMisiurewicz(MANDELBROT, [-0.1, 0.95], 8, 4, 0.05)
    expect(point).not.toBeNull()
    expect(point!.c[0]).toBeCloseTo(-0.101096363845622, 9)
    expect(point!.c[1]).toBeCloseTo(0.956286510809142, 9)
  })
})

describe('perturbation constants', () => {
  it('reproduce the linear coefficient recurrence over whole cycles in closed form, for every formula', () => {
    for (const scene of SCENES) {
      const point = scene.point
      const k = perturbationConstants(point)
      for (const j of [1, 2, 5, 9]) {
        const direct = linearCoefficient(point, point.preperiod + j * point.period)
        for (const v of [
          [1, 0],
          [0, 1],
          [0.6, -0.8],
        ] as const) {
          const exact = mat2Apply(direct, v)
          // L^j P v − Q v, via the same eigen-decomposition the shader uses.
          const closed = skipDelta(point, k, null, v, j)
          const q = point.formula.holomorphic ? [k.Q[0] * v[0] - k.Q[1] * v[1], k.Q[0] * v[1] + k.Q[1] * v[0]] : qTerm(point, v)
          const tolerance = 1e-8 * Math.max(1, Math.hypot(exact[0], exact[1]))
          expect(Math.abs(closed[0] - q[0] - exact[0])).toBeLessThan(tolerance)
          expect(Math.abs(closed[1] - q[1] - exact[1])).toBeLessThan(tolerance)
        }
      }
    }
  })

  it('has a repelling cycle for every dive so the skip grows and the cost stays bounded', () => {
    for (const scene of SCENES) {
      expect(perturbationConstants(scene.point).log2Lambda).toBeGreaterThan(0.05)
      const iterations = diveIterations(scene.point)
      expect(iterations).toBeGreaterThan(64)
      expect(iterations).toBeLessThanOrEqual(MAX_ITERATIONS)
    }
  })
})

/** Q v for non-holomorphic formulas, from the definition A_{k+jp} = L^j P − Q. */
function qTerm(point: (typeof SCENES)[number]['point'], v: readonly [number, number]): [number, number] {
  const k = perturbationConstants(point)
  const a0 = mat2Apply(linearCoefficient(point, point.preperiod), v)
  const p = skipDelta(point, k, null, v, 0)
  return [p[0] - a0[0], p[1] - a0[1]]
}

describe('closed-form handoff', () => {
  it('matches the exact orbit to well under a pixel at depth, for every dive', () => {
    const log2Scale = -40
    for (const scene of SCENES) {
      const point = scene.point
      const constants = perturbationConstants(point)
      const bits = handoffBits(point)
      const koenigs = point.formula.holomorphic ? koenigsCoefficients(point, KOENIGS_ORDER) : null
      const skip = planSkip(log2Scale, constants, bits)
      let worst = 0
      for (const [vx, vy] of [
        [1, 0],
        [0.3, 0.2],
        [-0.7, 1.1],
        [0.05, -0.9],
        [1.6, -0.4],
      ]) {
        // Mirror of the shader: v = M δc in the eigenbasis picks the cycle count.
        const v = mat2Apply(constants.M, [vx, vy])
        const log2v = 0.5 * Math.log2(v[0] * v[0] + v[1] * v[1])
        const dj = Math.floor((-bits - skip.log2Mag0 - log2v) / constants.log2Lambda)
        const j = skip.j0 + dj
        expect(j).toBeGreaterThanOrEqual(1)
        const scale = skip.mant * Math.pow(2, -skip.k0)
        const dcAbs: [number, number] = [vx * scale, vy * scale]
        const series = skipDelta(point, constants, koenigs, dcAbs, j)
        const exact = exactDelta(point, dcAbs, point.preperiod + j * point.period)
        const relative = Math.hypot(series[0] - exact[0], series[1] - exact[1]) / Math.hypot(exact[0], exact[1])
        worst = Math.max(worst, relative)
        // The handoff size is set in the eigenbasis; the basis change can stretch it somewhat.
        expect(Math.hypot(exact[0], exact[1])).toBeLessThan(Math.pow(2, -bits) * 64)
      }
      // A part in 10^3 of the offset is a tenth of a pixel at 1080p; the double-precision
      // reference orbit itself is only good to about 1e-4 here. The folded formulas have
      // no series correction and sit a little higher.
      expect(worst, scene.name).toBeLessThan(point.formula.holomorphic ? 1e-3 : 2e-3)
    }
  })
})

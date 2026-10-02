import { describe, expect, it } from 'vitest'
import { escapeTime } from '../src/render/cpu'
import { planSkip } from '../src/render/gl'
import { bakeShaderSource, directShaderSource, diveShaderSource, presentShaderSource } from '../src/render/shaders'
import { BURNING_SHIP, CUBIC, FORMULAS, MANDELBROT } from '../src/scene/formula'
import { perturbationConstants } from '../src/scene/misiurewicz'
import { handoffBits, MAX_ITERATIONS } from '../src/scene/quality'
import { SCENES } from '../src/scene/scenes'

describe('escapeTime', () => {
  it('reports the origin as inside the Mandelbrot set', () => {
    expect(escapeTime(MANDELBROT, [0, 0], 200)).toBe(-1)
  })

  it('escapes quickly far from the set with a smooth fractional count', () => {
    const n = escapeTime(MANDELBROT, [2, 2], 200)
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(4)
    expect(Number.isInteger(n)).toBe(false)
  })

  it('never reports a negative count for points that blow up immediately', () => {
    expect(escapeTime(MANDELBROT, [3, 3], 200)).toBe(0)
  })

  it('is continuous across nearby points outside the set', () => {
    const a = escapeTime(MANDELBROT, [-0.75, 0.3], 300)
    const b = escapeTime(MANDELBROT, [-0.75, 0.3001], 300)
    expect(Math.abs(a - b)).toBeLessThan(1)
  })

  it('handles the other formulas: their main bodies are interior and their far field escapes', () => {
    for (const formula of FORMULAS) {
      expect(escapeTime(formula, [0, 0], 200)).toBe(-1)
      expect(escapeTime(formula, [2, 2], 200)).toBeGreaterThanOrEqual(0)
    }
    // The Burning Ship's fold makes the lower half-plane differ from the upper.
    expect(escapeTime(BURNING_SHIP, [-1.7, -0.03], 500)).not.toBe(escapeTime(MANDELBROT, [-1.7, -0.03], 500))
    expect(escapeTime(CUBIC, [0.9, 0.9], 300)).toBeGreaterThan(0)
  })
})

const dive = SCENES[0]

describe('shader sources', () => {
  it('bakes an even iteration cap in as a compile-time constant for the two-step direct loop', () => {
    expect(MAX_ITERATIONS % 2).toBe(0)
    for (const formula of FORMULAS) {
      const src = directShaderSource(formula)
      expect(src).toContain(`const int MAX_ITER = ${MAX_ITERATIONS};`)
      expect(src).toContain('i += 2')
      expect(src.trim().startsWith('precision highp float;')).toBe(true)
      expect(src.includes('insideMainBody')).toBe(formula === MANDELBROT)
      expect(src).toContain('float escape(vec2 texel)')
      expect(src).toContain('if (s >= u_samples) break;')
      expect(src).toContain('if (u_samples <= 1)')
    }
  })

  it('bakes the reference orbit into the dive shader, one step per orbit entry', () => {
    const src = diveShaderSource(dive.point)
    // Two copies of the loop (with and without the deep-zoom-zero dc term), short cycles
    // repeated so the body has at least four steps.
    const repeats = Math.max(1, Math.ceil(4 / dive.point.period))
    const steps = src.match(/d = vec2\(d\.x \* w\.x/g) || []
    expect(steps.length).toBe(2 * (dive.point.preperiod + repeats * dive.point.period))
    expect(src).toContain(`const int PREPERIOD = ${dive.point.preperiod};`)
    expect(src).toContain(`const int PERIOD = ${dive.point.period};`)
    expect(src).toContain('float escape(vec2 texel)')
  })

  it('presents two baked keyframes with their own reprojection, one filtered tap each, and blends them', () => {
    const src = presentShaderSource()
    for (const k of ['A', 'B']) {
      expect(src).toContain(`uniform highp sampler2D u_col${k};`)
      expect(src).toContain(`uniform mat2 u_map${k};`)
      expect(src).toContain(`vec4 shade${k}()`)
    }
    expect(src).toContain('uniform float u_blend;')
    expect((src.match(/texture2D\(/g) || []).length).toBe(2)
    // Samplers are never passed as function arguments: some ES 1.00 compilers reject that.
    expect(src).not.toMatch(/\(\s*(highp\s+)?sampler2D\s+\w+\s*,/)
  })

  it('bakes colour by undoing the row permutation and weighting by the exterior fraction', () => {
    const src = bakeShaderSource()
    expect(src).toContain('mod(floor(gl_FragCoord.y) * u_rowStrideInv, u_rows)')
    expect(src).toContain('(1.0 - s.a)')
    expect(src).toContain('u_farField')
  })

  it('generates a dive shader for every scene, with a series only for holomorphic formulas', () => {
    for (const scene of SCENES) {
      const src = diveShaderSource(scene.point)
      expect(src).toContain('vec2 zeta')
      expect(src.includes('vec2 u = d;')).toBe(scene.point.formula.holomorphic)
      expect(src).not.toContain('#define')
    }
  })

  it('does not use GLSL ES 3.00 syntax so it compiles on WebGL1', () => {
    for (const src of [...FORMULAS.map(directShaderSource), diveShaderSource(dive.point), presentShaderSource(), bakeShaderSource()]) {
      expect(src).not.toMatch(/\bin\s+vec/)
      expect(src).not.toMatch(/\bout\s+vec/)
      expect(src).not.toContain('#version')
      expect(src).not.toContain('texture(')
    }
  })
})

describe('planSkip', () => {
  it('lands a pixel one view unit from the anchor within one cycle of the handoff magnitude', () => {
    const constants = perturbationConstants(dive.point)
    const bits = handoffBits(dive.point)
    for (const log2Scale of [0.4, -10, -40, -300, -5000]) {
      const skip = planSkip(log2Scale, constants, bits)
      expect(skip.mant).toBeGreaterThanOrEqual(1)
      expect(skip.mant).toBeLessThan(2)
      expect(skip.mant * Math.pow(2, -skip.k0)).toBeCloseTo(Math.pow(2, log2Scale), 12)
      expect(skip.log2Mag0).toBeLessThanOrEqual(-bits)
      expect(skip.log2Mag0).toBeGreaterThan(-bits - constants.log2Lambda)
      expect(skip.phase0).toBeGreaterThanOrEqual(0)
      expect(skip.phase0).toBeLessThan(2 * Math.PI)
    }
    expect(planSkip(0.4, constants, bits).j0).toBeLessThan(1)
    expect(planSkip(-5000, constants, bits).j0).toBeGreaterThan(1000)
  })
})

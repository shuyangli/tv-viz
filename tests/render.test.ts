import { describe, expect, it } from 'vitest'
import { escapeTime } from '../src/render/cpu'
import { fragmentShaderSource } from '../src/render/shaders'
import { MAX_ITERATIONS } from '../src/scene/quality'

describe('escapeTime', () => {
  it('reports the origin as inside the Mandelbrot set', () => {
    expect(escapeTime(0, 0, 0, 0, 200).n).toBe(-1)
  })

  it('escapes quickly far from the set with a smooth fractional count', () => {
    const n = escapeTime(0, 0, 2, 2, 200).n
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(4)
    expect(Number.isInteger(n)).toBe(false)
  })

  it('never reports a negative count for points that blow up immediately', () => {
    expect(escapeTime(0, 0, 3, 3, 200).n).toBe(0)
    expect(escapeTime(2.5, 2.5, 0.3, 0.5, 200).n).toBe(0)
  })

  it('is continuous across nearby points outside the set', () => {
    const a = escapeTime(0, 0, -0.75, 0.3, 300).n
    const b = escapeTime(0, 0, -0.75, 0.3001, 300).n
    expect(Math.abs(a - b)).toBeLessThan(1)
  })

  it('tracks the closest approach to the origin for interior shading', () => {
    // The orbit of z = 0 for c = -1 alternates 0 → -1 → 0, so the trap is exactly 0.
    expect(escapeTime(0, 0, -1, 0, 50).trap).toBe(0)
    // For c = -0.5 the orbit goes -0.5 → -0.25 → -0.4375 → … toward -0.366, so the closest approach is 0.25.
    const fixed = escapeTime(0, 0, -0.5, 0, 200)
    expect(fixed.n).toBe(-1)
    expect(fixed.trap).toBeCloseTo(0.25)
  })
})

describe('fragmentShaderSource', () => {
  it('bakes the iteration cap in as a compile-time constant and honours the requested precision', () => {
    const src = fragmentShaderSource('mediump')
    expect(src).toContain(`const int MAX_ITER = ${MAX_ITERATIONS};`)
    expect(src.trim().startsWith('precision mediump float;')).toBe(true)
    expect(fragmentShaderSource('highp')).toContain('precision highp float;')
  })

  it('does not use GLSL ES 3.00 syntax so it compiles on WebGL1', () => {
    const src = fragmentShaderSource('highp')
    expect(src).not.toMatch(/\bin\s+vec/)
    expect(src).not.toMatch(/\bout\s+vec/)
    expect(src).not.toContain('#version')
    expect(src).not.toContain('texture(')
  })
})

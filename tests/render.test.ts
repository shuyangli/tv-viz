import { describe, expect, it } from 'vitest'
import { escapeTime } from '../src/render/cpu'
import { keyframeShaderSource, presentShaderSource } from '../src/render/shaders'
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

/** Mirrors the shader's unrolled loop: two iterations per bailout test. */
function pairwiseEscape(cx: number, cy: number, maxIter: number): number {
  let zx = 0
  let zy = 0
  for (let i = 0; i < maxIter; i += 2) {
    for (let k = 0; k < 2; k++) {
      const nx = zx * zx - zy * zy + cx
      zy = 2 * zx * zy + cy
      zx = nx
    }
    const m = zx * zx + zy * zy
    if (m > 256) return Math.max(0, i + 3 - Math.log2(Math.log2(m)))
  }
  return -1
}

describe('unrolled escape loop', () => {
  it('matches the per-iteration smooth count closely wherever the point escapes', () => {
    let worst = 0
    for (let i = 0; i < 400; i++) {
      const cx = -2 + (i % 20) * 0.13
      const cy = -1.2 + Math.floor(i / 20) * 0.12
      const exact = escapeTime(0, 0, cx, cy, 300).n
      const paired = pairwiseEscape(cx, cy, 300)
      if (exact < 0 || paired < 0) {
        expect(exact < 0).toBe(paired < 0)
        continue
      }
      worst = Math.max(worst, Math.abs(exact - paired))
    }
    expect(worst).toBeLessThan(0.05)
  })
})

describe('shader sources', () => {
  it('bakes an even iteration cap in as a compile-time constant for the two-step loop', () => {
    expect(MAX_ITERATIONS % 2).toBe(0)
    for (const julia of [false, true]) {
      const src = keyframeShaderSource(julia)
      expect(src).toContain(`const int MAX_ITER = ${MAX_ITERATIONS};`)
      expect(src).toContain('i += 2')
      expect(src.trim().startsWith('precision highp float;')).toBe(true)
    }
  })

  it('only tracks the orbit trap and shades interiors in the Julia variant', () => {
    expect(keyframeShaderSource(true)).toContain('trap = min(trap')
    expect(keyframeShaderSource(false)).not.toContain('trap = min(trap')
    expect(keyframeShaderSource(false)).toContain('insideMainBody')
    expect(keyframeShaderSource(true)).not.toContain('insideMainBody')
  })

  it('does not use GLSL ES 3.00 syntax so it compiles on WebGL1', () => {
    for (const src of [keyframeShaderSource(false), keyframeShaderSource(true), presentShaderSource()]) {
      expect(src).not.toMatch(/\bin\s+vec/)
      expect(src).not.toMatch(/\bout\s+vec/)
      expect(src).not.toContain('#version')
      expect(src).not.toContain('texture(')
    }
  })
})

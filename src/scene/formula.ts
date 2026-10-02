import type { Vec2 } from './math'

/** Row-major 2x2 real matrix [[a, b], [c, d]]. */
export type Mat2 = readonly [number, number, number, number]

/**
 * An escape-time map z → F(z) + c on the plane. Non-holomorphic maps (with abs folds)
 * are supported through their real Jacobian, which is all Newton's method and the
 * linear skip need; holomorphic ones additionally get the series handoff.
 */
export interface Formula {
  readonly id: string
  readonly name: string
  /** Polynomial degree of the escape, for the smooth iteration count. */
  readonly degree: number
  readonly holomorphic: boolean
  /** Framing that shows the whole set: centre and half-height of the viewport. */
  readonly overviewCenter: Vec2
  readonly overviewScale: number
  step(z: Vec2, c: Vec2): Vec2
  /** ∂F/∂z at z, as a real 2x2 matrix. */
  jacobian(z: Vec2): Mat2
  /** GLSL statements that replace `z` by F(z) + c. */
  glslDirectStep(): string
  /**
   * GLSL statements that replace the perturbation `d` by F(Z + d) − F(Z) (+ `dcTerm`),
   * for the baked reference point Z. `lit` formats a literal.
   */
  glslPerturbStep(z: Vec2, lit: (v: number) => string, dcTerm: string): string
}

export const MANDELBROT: Formula = {
  id: 'mandelbrot',
  name: 'Mandelbrot',
  degree: 2,
  holomorphic: true,
  overviewCenter: [-0.6, 0],
  overviewScale: 1.35,
  step: (z, c) => [z[0] * z[0] - z[1] * z[1] + c[0], 2 * z[0] * z[1] + c[1]],
  jacobian: (z) => [2 * z[0], -2 * z[1], 2 * z[1], 2 * z[0]],
  glslDirectStep: () => 'z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;',
  glslPerturbStep: (z, lit, dc) =>
    `w = vec2(${lit(2 * z[0])} + d.x, ${lit(2 * z[1])} + d.y);
        d = vec2(d.x * w.x - d.y * w.y, d.x * w.y + d.y * w.x)${dc};`,
}

/** z³ + c: two-fold symmetric, with tighter, denser spirals than the quadratic set. */
export const CUBIC: Formula = {
  id: 'cubic',
  name: 'Cubic',
  degree: 3,
  holomorphic: true,
  overviewCenter: [0, 0],
  overviewScale: 1.25,
  step: (z, c) => [z[0] * z[0] * z[0] - 3 * z[0] * z[1] * z[1] + c[0], 3 * z[0] * z[0] * z[1] - z[1] * z[1] * z[1] + c[1]],
  jacobian: (z) => {
    // 3z² as a complex number (a + bi) acts as [[a, -b], [b, a]].
    const a = 3 * (z[0] * z[0] - z[1] * z[1])
    const b = 6 * z[0] * z[1]
    return [a, -b, b, a]
  },
  glslDirectStep: () => 'z = vec2(z.x * z.x * z.x - 3.0 * z.x * z.y * z.y, 3.0 * z.x * z.x * z.y - z.y * z.y * z.y) + c;',
  // (Z + d)³ − Z³ = d (3Z² + d (3Z + d)).
  glslPerturbStep: (z, lit, dc) => {
    const zz: Vec2 = [z[0] * z[0] - z[1] * z[1], 2 * z[0] * z[1]]
    return `w = vec2(${lit(3 * z[0])} + d.x, ${lit(3 * z[1])} + d.y);
        w = vec2(d.x * w.x - d.y * w.y + ${lit(3 * zz[0])}, d.x * w.y + d.y * w.x + ${lit(3 * zz[1])});
        d = vec2(d.x * w.x - d.y * w.y, d.x * w.y + d.y * w.x)${dc};`
  },
}

/**
 * |x + δ| − |x| for a baked x, exact in every sign case. Emitted only when x ≠ 0; the
 * critical point Z_0 = 0 is handled by the caller since its Jacobian vanishes anyway.
 */
function glslDiffAbs(x: number, delta: string, lit: (v: number) => string): string {
  return x >= 0
    ? `((${lit(x)} + ${delta} >= 0.0) ? ${delta} : ${lit(-2 * x)} - ${delta})`
    : `((${lit(x)} + ${delta} <= 0.0) ? -${delta} : ${lit(2 * x)} + ${delta})`
}

/** Burning Ship: (|x| + i|y|)² + c. The folds along the axes grow the "ships" and their rigging. */
export const BURNING_SHIP: Formula = {
  id: 'burningship',
  name: 'Burning Ship',
  degree: 2,
  holomorphic: false,
  overviewCenter: [-0.45, -0.55],
  overviewScale: 1.55,
  step: (z, c) => {
    const x = Math.abs(z[0])
    const y = Math.abs(z[1])
    return [x * x - y * y + c[0], 2 * x * y + c[1]]
  },
  jacobian: (z) => {
    const sx = Math.sign(z[0])
    const sy = Math.sign(z[1])
    return [2 * z[0], -2 * z[1], 2 * sx * Math.abs(z[1]), 2 * Math.abs(z[0]) * sy]
  },
  glslDirectStep: () => 'z = abs(z); z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;',
  glslPerturbStep: (z, lit, dc) => {
    if (z[0] === 0 && z[1] === 0) return `d = vec2(d.x * d.x - d.y * d.y, 2.0 * abs(d.x * d.y))${dc};`
    const ax = Math.abs(z[0])
    const ay = Math.abs(z[1])
    return `w = vec2(${glslDiffAbs(z[0], 'd.x', lit)}, ${glslDiffAbs(z[1], 'd.y', lit)});
        d = vec2(${lit(2 * ax)} * w.x + w.x * w.x - ${lit(2 * ay)} * w.y - w.y * w.y, 2.0 * (${lit(ax)} * w.y + ${lit(ay)} * w.x + w.x * w.y))${dc};`
  },
}

/** Celtic: |Re z²| + i Im z² + c. A single fold, giving knotted, braided filaments. */
export const CELTIC: Formula = {
  id: 'celtic',
  name: 'Celtic',
  degree: 2,
  holomorphic: false,
  overviewCenter: [-0.7, 0],
  overviewScale: 1.4,
  step: (z, c) => [Math.abs(z[0] * z[0] - z[1] * z[1]) + c[0], 2 * z[0] * z[1] + c[1]],
  jacobian: (z) => {
    const s = Math.sign(z[0] * z[0] - z[1] * z[1])
    return [2 * s * z[0], -2 * s * z[1], 2 * z[1], 2 * z[0]]
  },
  glslDirectStep: () => 'z = vec2(abs(z.x * z.x - z.y * z.y), 2.0 * z.x * z.y) + c;',
  glslPerturbStep: (z, lit, dc) => {
    const re = z[0] * z[0] - z[1] * z[1]
    // Re((Z + d)²) − Re(Z²) = 2 Z·d-ish term r; the fold then needs |Re Z² + r| − |Re Z²|.
    const r = `(${lit(2 * z[0])} * d.x - ${lit(2 * z[1])} * d.y + d.x * d.x - d.y * d.y)`
    if (re === 0) return `w.x = ${r}; d = vec2(abs(w.x), ${lit(2 * z[0])} * d.y + ${lit(2 * z[1])} * d.x + 2.0 * d.x * d.y)${dc};`
    return `w.x = ${r};
        d = vec2(${glslDiffAbs(re, 'w.x', lit)}, ${lit(2 * z[0])} * d.y + ${lit(2 * z[1])} * d.x + 2.0 * d.x * d.y)${dc};`
  },
}

export const FORMULAS: readonly Formula[] = [MANDELBROT, CUBIC, BURNING_SHIP, CELTIC]

export function formulaById(id: string): Formula | null {
  for (const f of FORMULAS) if (f.id === id) return f
  return null
}

export function mat2Mul(a: Mat2, b: Mat2): Mat2 {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]]
}

export function mat2Apply(a: Mat2, v: Vec2): Vec2 {
  return [a[0] * v[0] + a[1] * v[1], a[2] * v[0] + a[3] * v[1]]
}

export function mat2Add(a: Mat2, b: Mat2): Mat2 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]
}

export function mat2Inverse(a: Mat2): Mat2 | null {
  const det = a[0] * a[3] - a[1] * a[2]
  if (det === 0) return null
  return [a[3] / det, -a[1] / det, -a[2] / det, a[0] / det]
}

export const MAT2_IDENTITY: Mat2 = [1, 0, 0, 1]

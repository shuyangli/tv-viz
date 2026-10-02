import { mat2Add, mat2Apply, mat2Inverse, mat2Mul, MAT2_IDENTITY, type Formula, type Mat2 } from './formula'
import type { Vec2 } from './math'

/**
 * A Misiurewicz point of a formula: c whose critical orbit is strictly preperiodic, so
 * it lies on the boundary of the set and its orbit is a finite repelling cycle. That
 * makes it the ideal anchor for an endless zoom: the reference orbit for perturbation
 * rendering is exact and repeats forever, and the set is asymptotically self-similar
 * around it.
 */
export interface MisiurewiczPoint {
  readonly formula: Formula
  readonly c: Vec2
  readonly preperiod: number
  readonly period: number
  /** Z_0 .. Z_{preperiod+period-1}; from index preperiod on, the orbit repeats with the period. */
  readonly orbit: readonly Vec2[]
  /** Jacobian of the cycle's return map; a complex multiplier for holomorphic formulas. */
  readonly cycleJacobian: Mat2
  /** Spectral radius of the cycle Jacobian: each zoom by this factor repeats the local picture. */
  readonly growth: number
}

const NEWTON_STEPS = 64
const NEWTON_TOLERANCE = 1e-15
const ORBIT_TOLERANCE = 1e-9

function mul(a: Vec2, b: Vec2): Vec2 {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
}

function div(a: Vec2, b: Vec2): Vec2 {
  const d = b[0] * b[0] + b[1] * b[1]
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]
}

function abs2(z: Vec2): number {
  return z[0] * z[0] + z[1] * z[1]
}

function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]]
}

/** Eigenvalues of a real 2x2 matrix: two reals, or a conjugate pair given as (re, im). */
export function eigenvalues(m: Mat2): { readonly real: boolean; readonly a: number; readonly b: number } {
  const half = (m[0] + m[3]) / 2
  const det = m[0] * m[3] - m[1] * m[2]
  const disc = half * half - det
  if (disc >= 0) return { real: true, a: half + Math.sqrt(disc), b: half - Math.sqrt(disc) }
  return { real: false, a: half, b: Math.sqrt(-disc) }
}

export function spectralRadius(m: Mat2): number {
  const e = eigenvalues(m)
  return e.real ? Math.max(Math.abs(e.a), Math.abs(e.b)) : Math.hypot(e.a, e.b)
}

/** Solves f_c^{k+p}(0) = f_c^{k}(0) by Newton's method in the plane from `guess`. */
export function solveMisiurewicz(formula: Formula, guess: Vec2, preperiod: number, period: number): Vec2 | null {
  let c: Vec2 = guess
  for (let step = 0; step < NEWTON_STEPS; step++) {
    let z: Vec2 = [0, 0]
    let dz: Mat2 = [0, 0, 0, 0]
    let zk: Vec2 = [0, 0]
    let dzk: Mat2 = [0, 0, 0, 0]
    for (let i = 0; i < preperiod + period; i++) {
      if (i === preperiod) {
        zk = z
        dzk = dz
      }
      dz = mat2Add(mat2Mul(formula.jacobian(z), dz), MAT2_IDENTITY)
      z = formula.step(z, c)
    }
    const g: Vec2 = [z[0] - zk[0], z[1] - zk[1]]
    const dg = mat2Inverse(mat2Add(dz, [-dzk[0], -dzk[1], -dzk[2], -dzk[3]]))
    if (!dg) return null
    const delta = mat2Apply(dg, g)
    c = [c[0] - delta[0], c[1] - delta[1]]
    if (!isFinite(c[0]) || !isFinite(c[1]) || abs2(c) > 16) return null
    if (abs2(delta) < NEWTON_TOLERANCE * NEWTON_TOLERANCE) break
  }
  return c
}

/**
 * Classifies c's critical orbit as preperiodic, returning the exact point data, or null
 * when it is periodic (a hyperbolic centre, not on the boundary), attracting, or not
 * closing within the search bound. Newton from (k, p) may land on a point with smaller
 * true (k, p), which is why the orbit is inspected rather than trusted.
 */
export function classify(formula: Formula, c: Vec2, maxLength = 64): MisiurewiczPoint | null {
  const orbit: Vec2[] = [[0, 0]]
  // A repelling cycle cannot be followed in double precision for long: once rounding has
  // pushed the orbit off it, it escapes. Stop there rather than comparing against garbage.
  for (let i = 0; i < maxLength && abs2(orbit[i]) < 16; i++) orbit.push(formula.step(orbit[i], c))
  const length = orbit.length - 1
  for (let k = 0; k < length; k++) {
    for (let p = 1; k + p <= length; p++) {
      const a = orbit[k]
      const b = orbit[k + p]
      if (!(abs2([a[0] - b[0], a[1] - b[1]]) < ORBIT_TOLERANCE * ORBIT_TOLERANCE)) continue
      if (k === 0) return null
      let jac: Mat2 = MAT2_IDENTITY
      for (let j = 1; j < k + p; j++) {
        // Orbit points on a fold axis have no Jacobian; such points are not usable anchors.
        if (!formula.holomorphic && (Math.abs(orbit[j][0]) < 1e-9 || Math.abs(orbit[j][1]) < 1e-9)) return null
        if (j >= k) jac = mat2Mul(formula.jacobian(orbit[j]), jac)
      }
      const growth = spectralRadius(jac)
      if (growth <= 1) return null
      // The closed form divides by L − I.
      if (!mat2Inverse(mat2Add(jac, [-1, 0, 0, -1]))) return null
      return { formula, c, preperiod: k, period: p, orbit: orbit.slice(0, k + p), cycleJacobian: jac, growth }
    }
  }
  return null
}

/**
 * The Misiurewicz point nearest to `guess`, trying every preperiod and period up to the
 * bounds. Newton is fast, so the search is exhaustive and deterministic.
 */
export function nearestMisiurewicz(
  formula: Formula,
  guess: Vec2,
  maxPreperiod: number,
  maxPeriod: number,
  radius: number,
): MisiurewiczPoint | null {
  let best: MisiurewiczPoint | null = null
  let bestDistance = radius * radius
  for (let p = 1; p <= maxPeriod; p++) {
    for (let k = 1; k <= maxPreperiod; k++) {
      const root = solveMisiurewicz(formula, guess, k, p)
      if (!root) continue
      const distance = abs2([root[0] - guess[0], root[1] - guess[1]])
      if (distance >= bestDistance) continue
      const point = classify(formula, root)
      if (!point) continue
      best = point
      bestDistance = distance
    }
  }
  return best
}

/**
 * While a pixel's offset from the reference orbit is tiny its evolution is linear:
 * δ_n = A_n δc with A_{n+1} = J_n A_n + I. Over the periodic part of the orbit that
 * recurrence has a closed form, A_{k+jp} = L^j P − Q with L the cycle Jacobian, so a
 * pixel can jump straight to the last few dozen iterations before escape no matter how
 * deep the zoom is. L is diagonalised so the shader can raise it to a large power: in
 * the eigenbasis it is a complex multiplication (spiral) or two real scalings.
 */
export interface PerturbationConstants {
  /** Dominant eigenvalue magnitude, as log2. */
  readonly log2Lambda: number
  /** Rotation per cycle in the eigenbasis (complex case), else 0. */
  readonly argLambda: number
  /** Second eigenvalue (real case) as log2 magnitude and sign; unused in the complex case. */
  readonly log2Lambda2: number
  readonly lambdaSigns: readonly [number, number]
  readonly realEigen: boolean
  /** Basis change L = S · Λ · S⁻¹, and M = S⁻¹ · P so the shader applies one matrix before the power. */
  readonly S: Mat2
  readonly M: Mat2
  /** Holomorphic only: P as a complex number, in log-polar form, for the series handoff. */
  readonly log2P: number
  readonly argP: number
  readonly P: Vec2
  readonly Q: Vec2
}

export function perturbationConstants(point: MisiurewiczPoint): PerturbationConstants {
  const { formula, preperiod: k, period: p, orbit, cycleJacobian: L } = point
  let a: Mat2 = [0, 0, 0, 0]
  for (let i = 0; i < k; i++) a = mat2Add(mat2Mul(formula.jacobian(orbit[i]), a), MAT2_IDENTITY)
  // One cycle from A_k: A_{k+p} = L A_k + C.
  let c: Mat2 = [0, 0, 0, 0]
  for (let i = k; i < k + p; i++) c = mat2Add(mat2Mul(formula.jacobian(orbit[i]), c), MAT2_IDENTITY)
  const lmi = mat2Inverse(mat2Add(L, [-1, 0, 0, -1])) as Mat2
  const q = mat2Mul(lmi, c)
  const bigP = mat2Add(a, q)
  const eig = eigenvalues(L)
  if (formula.holomorphic) {
    const lambda: Vec2 = [L[0], L[2]]
    const pc: Vec2 = [bigP[0], bigP[2]]
    return {
      log2Lambda: Math.log2(Math.hypot(lambda[0], lambda[1])),
      argLambda: Math.atan2(lambda[1], lambda[0]),
      log2Lambda2: 0,
      lambdaSigns: [1, 1],
      realEigen: false,
      S: MAT2_IDENTITY,
      M: bigP,
      log2P: Math.log2(Math.hypot(pc[0], pc[1])),
      argP: Math.atan2(pc[1], pc[0]),
      P: pc,
      Q: [q[0], q[2]],
    }
  }
  let S: Mat2
  if (eig.real) {
    const v1 = eigenvector(L, eig.a)
    const v2 = eigenvector(L, eig.b)
    S = [v1[0], v2[0], v1[1], v2[1]]
  } else {
    // Complex eigenvector v = u + i w; in the real basis (u, w) the map is a similarity.
    const v = complexEigenvector(L, eig.a, eig.b)
    S = [v.u[0], v.w[0], v.u[1], v.w[1]]
  }
  const Sinv = mat2Inverse(S) as Mat2
  const B = mat2Mul(mat2Mul(Sinv, L), S)
  const base = {
    S,
    M: mat2Mul(Sinv, bigP),
    log2P: 0,
    argP: 0,
    P: [1, 0] as Vec2,
    Q: [0, 0] as Vec2,
  }
  if (eig.real) {
    const l1 = B[0]
    const l2 = B[3]
    return {
      ...base,
      realEigen: true,
      log2Lambda: Math.log2(Math.abs(l1)),
      argLambda: 0,
      log2Lambda2: Math.log2(Math.abs(l2)),
      lambdaSigns: [Math.sign(l1), Math.sign(l2)],
    }
  }
  // B = [[α, β], [−β, α]] acts on (a, b) as multiplication of a + ib by (B0 + i B2).
  return {
    ...base,
    realEigen: false,
    log2Lambda: Math.log2(Math.hypot(B[0], B[2])),
    argLambda: Math.atan2(B[2], B[0]),
    log2Lambda2: 0,
    lambdaSigns: [1, 1],
  }
}

function eigenvector(m: Mat2, lambda: number): Vec2 {
  const v: Vec2 = Math.abs(m[1]) > Math.abs(m[2]) ? [m[1], lambda - m[0]] : [lambda - m[3], m[2]]
  const len = Math.hypot(v[0], v[1])
  return len > 0 ? [v[0] / len, v[1] / len] : [1, 0]
}

function complexEigenvector(m: Mat2, re: number, im: number): { u: Vec2; w: Vec2 } {
  // From the first row: (m0 − λ) v0 + m1 v1 = 0 → v = (m1, λ − m0).
  if (m[1] !== 0) return { u: [m[1], re - m[0]], w: [0, im] }
  return { u: [re - m[3], m[2]], w: [im, 0] }
}

/**
 * Coefficients b_1..b_order (b_1 = 1) of the inverse Koenigs function φ of the cycle's
 * return map g around Z_k: φ(λu) = g(φ(u)). Holomorphic formulas only. Deep in a zoom a
 * pixel's offset from the reference after j cycles is exactly φ(λ^j · P · δc), so the
 * shader can hand off at a much larger offset than the linear estimate alone would allow.
 */
export function koenigsCoefficients(point: MisiurewiczPoint, order: number): Vec2[] {
  const { formula, preperiod: k, period: p, orbit } = point
  // Jet of the return map: g(ε) = Σ g_m ε^m, built by composing z → F(z) + c around the cycle,
  // where F(Z + ε) − F(Z) is the polynomial (Z + ε)^d − Z^d.
  let jet: Vec2[] = [[0, 0], [1, 0]]
  for (let m = 2; m <= order; m++) jet.push([0, 0])
  for (let i = k; i < k + p; i++) {
    const withZ = jet.slice()
    withZ[0] = orbit[i]
    let pow = withZ
    for (let e = 1; e < formula.degree; e++) pow = mulSeries(pow, withZ, order)
    pow[0] = [0, 0]
    jet = pow
  }
  const lambda = jet[1]
  const phi: Vec2[] = [[0, 0], [1, 0]]
  for (let m = 2; m <= order; m++) {
    const phiPow: Vec2[][] = []
    phiPow[1] = phi.slice()
    for (let l = 2; l <= m; l++) phiPow[l] = mulSeries(phiPow[l - 1], phi, m)
    let sum: Vec2 = [0, 0]
    for (let l = 2; l <= m; l++) sum = add(sum, mul(jet[l], phiPow[l][m] || [0, 0]))
    const lambdaM = powC(lambda, m)
    phi[m] = div(sum, [lambdaM[0] - lambda[0], lambdaM[1] - lambda[1]])
  }
  return phi.slice(1)
}

function powC(z: Vec2, n: number): Vec2 {
  let r: Vec2 = [1, 0]
  for (let i = 0; i < n; i++) r = mul(r, z)
  return r
}

/** Truncated product of two power series given as coefficient arrays indexed by power. */
function mulSeries(a: Vec2[], b: Vec2[], order: number): Vec2[] {
  const out: Vec2[] = []
  for (let m = 0; m <= order; m++) {
    let sum: Vec2 = [0, 0]
    for (let i = 0; i <= m; i++) {
      const x = a[i]
      const y = b[m - i]
      if (x && y) sum = add(sum, mul(x, y))
    }
    out[m] = sum
  }
  return out
}

/** Evaluates φ(u) with coefficients from koenigsCoefficients, by Horner's rule. */
export function evaluateKoenigs(coefficients: readonly Vec2[], u: Vec2): Vec2 {
  let h: Vec2 = [0, 0]
  for (let m = coefficients.length - 1; m >= 0; m--) h = add(mul(h, u), coefficients[m])
  return mul(h, u)
}

/** A_n by direct recurrence, for tests. */
export function linearCoefficient(point: MisiurewiczPoint, n: number): Mat2 {
  const { formula, preperiod: k, period: p, orbit } = point
  let a: Mat2 = [0, 0, 0, 0]
  for (let i = 0; i < n; i++) a = mat2Add(mat2Mul(formula.jacobian(orbit[i < k ? i : k + ((i - k) % p)]), a), MAT2_IDENTITY)
  return a
}

/** Exact offset z_n(c + δc) − Z_n by direct iteration in double precision, for tests. */
export function exactDelta(point: MisiurewiczPoint, dc: Vec2, n: number): Vec2 {
  const { formula, preperiod: k, period: p, orbit, c } = point
  const cc: Vec2 = [c[0] + dc[0], c[1] + dc[1]]
  let z: Vec2 = [0, 0]
  for (let i = 0; i < n; i++) z = formula.step(z, cc)
  const ref = orbit[n < k ? n : k + ((n - k) % p)]
  return [z[0] - ref[0], z[1] - ref[1]]
}

/**
 * The shader's closed-form handoff, mirrored on the CPU for tests: the linear estimate
 * in the eigenbasis, raised through j cycles, mapped back, and (holomorphic only) fed
 * through the Koenigs series.
 */
export function skipDelta(
  point: MisiurewiczPoint,
  constants: PerturbationConstants,
  koenigs: readonly Vec2[] | null,
  dcAbs: Vec2,
  j: number,
): Vec2 {
  const v = mat2Apply(constants.M, dcAbs)
  let zeta: Vec2
  if (constants.realEigen) {
    zeta = [
      v[0] * Math.pow(Math.abs(Math.pow(2, constants.log2Lambda)), j) * Math.pow(constants.lambdaSigns[0], j),
      v[1] * Math.pow(Math.pow(2, constants.log2Lambda2), j) * Math.pow(constants.lambdaSigns[1], j),
    ]
  } else {
    const mag = Math.pow(2, j * constants.log2Lambda)
    const ang = j * constants.argLambda
    zeta = mul(v, [mag * Math.cos(ang), mag * Math.sin(ang)])
  }
  const d = mat2Apply(constants.S, zeta)
  return koenigs && point.formula.holomorphic ? evaluateKoenigs(koenigs, d) : d
}

import type { Vec2 } from './math'

/**
 * A Misiurewicz point: c whose critical orbit is strictly preperiodic, so it lies on the
 * boundary of the Mandelbrot set and its orbit is a finite cycle. That makes it the ideal
 * anchor for an endless zoom: the reference orbit for perturbation rendering is exact
 * and repeats forever, and the set is asymptotically self-similar around it.
 */
export interface MisiurewiczPoint {
  readonly c: Vec2
  readonly preperiod: number
  readonly period: number
  /** Z_0 .. Z_{preperiod+period-1}; from index preperiod on, the orbit repeats with the period. */
  readonly orbit: readonly Vec2[]
  /** Multiplier of the repelling cycle; each zoom by this factor repeats the local picture. */
  readonly multiplier: Vec2
}

const NEWTON_STEPS = 64
const NEWTON_TOLERANCE = 1e-15
const ORBIT_TOLERANCE = 1e-9

function sq(z: Vec2): Vec2 {
  return [z[0] * z[0] - z[1] * z[1], 2 * z[0] * z[1]]
}

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

/** Solves f_c^{k+p}(0) = f_c^{k}(0) by Newton's method from `guess`. */
export function solveMisiurewicz(guess: Vec2, preperiod: number, period: number): Vec2 | null {
  let c: Vec2 = guess
  for (let step = 0; step < NEWTON_STEPS; step++) {
    let z: Vec2 = [0, 0]
    let dz: Vec2 = [0, 0]
    let zk: Vec2 = [0, 0]
    let dzk: Vec2 = [0, 0]
    for (let i = 0; i < preperiod + period; i++) {
      if (i === preperiod) {
        zk = z
        dzk = dz
      }
      dz = [2 * (z[0] * dz[0] - z[1] * dz[1]) + 1, 2 * (z[0] * dz[1] + z[1] * dz[0])]
      const s = sq(z)
      z = [s[0] + c[0], s[1] + c[1]]
    }
    const g: Vec2 = [z[0] - zk[0], z[1] - zk[1]]
    const dg: Vec2 = [dz[0] - dzk[0], dz[1] - dzk[1]]
    if (abs2(dg) === 0) return null
    const delta = div(g, dg)
    c = [c[0] - delta[0], c[1] - delta[1]]
    if (!isFinite(c[0]) || !isFinite(c[1]) || abs2(c) > 16) return null
    if (abs2(delta) < NEWTON_TOLERANCE * NEWTON_TOLERANCE) break
  }
  return c
}

/**
 * Classifies c's critical orbit as preperiodic, returning the exact point data, or null
 * when it is periodic (a hyperbolic centre, not on the boundary) or not closing within
 * the search bound. Newton from (k, p) may land on a point with smaller true (k, p).
 */
export function classify(c: Vec2, maxLength = 64): MisiurewiczPoint | null {
  const orbit: Vec2[] = [[0, 0]]
  for (let i = 0; i < maxLength; i++) {
    const s = sq(orbit[i])
    orbit.push([s[0] + c[0], s[1] + c[1]])
  }
  for (let k = 0; k < maxLength; k++) {
    for (let p = 1; k + p <= maxLength; p++) {
      const a = orbit[k]
      const b = orbit[k + p]
      if (abs2([a[0] - b[0], a[1] - b[1]]) >= ORBIT_TOLERANCE * ORBIT_TOLERANCE) continue
      if (k === 0) return null
      let multiplier: Vec2 = [1, 0]
      for (let j = k; j < k + p; j++) multiplier = mul(multiplier, [2 * orbit[j][0], 2 * orbit[j][1]])
      if (abs2(multiplier) <= 1) return null
      return { c, preperiod: k, period: p, orbit: orbit.slice(0, k + p), multiplier }
    }
  }
  return null
}

/**
 * The Misiurewicz point nearest to `guess`, trying every preperiod and period up to the
 * bounds. Newton is fast, so the search is exhaustive and deterministic.
 */
export function nearestMisiurewicz(
  guess: Vec2,
  maxPreperiod: number,
  maxPeriod: number,
  radius: number,
): MisiurewiczPoint | null {
  let best: MisiurewiczPoint | null = null
  let bestDistance = radius * radius
  for (let p = 1; p <= maxPeriod; p++) {
    for (let k = 1; k <= maxPreperiod; k++) {
      const root = solveMisiurewicz(guess, k, p)
      if (!root) continue
      const distance = abs2([root[0] - guess[0], root[1] - guess[1]])
      if (distance >= bestDistance) continue
      const point = classify(root)
      if (!point) continue
      best = point
      bestDistance = distance
    }
  }
  return best
}

/**
 * While a pixel's offset from the reference orbit is tiny, its evolution is linear:
 * δ_n = A_n δc with A_{n+1} = 2 Z_n A_n + 1. Over the periodic part of the orbit that
 * recurrence has a closed form, A_{k+jp} = λ^j P − Q, so a pixel can jump straight to the
 * last few dozen iterations before escape no matter how deep the zoom is.
 */
export interface PerturbationConstants {
  readonly log2Lambda: number
  readonly argLambda: number
  readonly P: Vec2
  readonly Q: Vec2
  readonly log2P: number
  readonly argP: number
}

export function perturbationConstants(point: MisiurewiczPoint): PerturbationConstants {
  const { preperiod: k, period: p, orbit } = point
  let a: Vec2 = [0, 0]
  for (let i = 0; i < k; i++) a = [2 * (orbit[i][0] * a[0] - orbit[i][1] * a[1]) + 1, 2 * (orbit[i][0] * a[1] + orbit[i][1] * a[0])]
  // One cycle from A_k: A_{k+p} = λ A_k + C.
  let lambda: Vec2 = [1, 0]
  let c: Vec2 = [0, 0]
  for (let i = k; i < k + p; i++) {
    const twoZ: Vec2 = [2 * orbit[i][0], 2 * orbit[i][1]]
    lambda = mul(lambda, twoZ)
    c = [c[0] * twoZ[0] - c[1] * twoZ[1] + 1, c[0] * twoZ[1] + c[1] * twoZ[0]]
  }
  const q = div(c, [lambda[0] - 1, lambda[1]])
  const bigP: Vec2 = [a[0] + q[0], a[1] + q[1]]
  return {
    log2Lambda: Math.log2(Math.hypot(lambda[0], lambda[1])),
    argLambda: Math.atan2(lambda[1], lambda[0]),
    P: bigP,
    Q: q,
    log2P: Math.log2(Math.hypot(bigP[0], bigP[1])),
    argP: Math.atan2(bigP[1], bigP[0]),
  }
}

/** A_n by direct recurrence, for tests and for the shallow start. */
export function linearCoefficient(point: MisiurewiczPoint, n: number): Vec2 {
  const { preperiod: k, period: p, orbit } = point
  let a: Vec2 = [0, 0]
  for (let i = 0; i < n; i++) {
    const z = orbit[i < k ? i : k + ((i - k) % p)]
    a = [2 * (z[0] * a[0] - z[1] * a[1]) + 1, 2 * (z[0] * a[1] + z[1] * a[0])]
  }
  return a
}

/**
 * Coefficients b_1..b_order (b_1 = 1) of the inverse Koenigs function φ of the cycle's
 * return map g = f^p around Z_k: φ(λu) = g(φ(u)). Deep in a zoom a pixel's offset from
 * the reference after j cycles is exactly φ(λ^j · P · δc), so the shader can hand off at
 * a much larger offset than the linear estimate alone would allow.
 */
export function koenigsCoefficients(point: MisiurewiczPoint, order: number): Vec2[] {
  const { preperiod: k, period: p, orbit } = point
  // Jet of the return map: g(ε) = Σ g_m ε^m, built by composing z → z² + c around the cycle.
  let jet: Vec2[] = [[0, 0], [1, 0]]
  for (let m = 2; m <= order; m++) jet.push([0, 0])
  for (let i = k; i < k + p; i++) {
    const z = orbit[i]
    const next: Vec2[] = jet.map(() => [0, 0])
    for (let m = 1; m <= order; m++) {
      let sum: Vec2 = [2 * (z[0] * jet[m][0] - z[1] * jet[m][1]), 2 * (z[0] * jet[m][1] + z[1] * jet[m][0])]
      for (let a = 1; a < m; a++) sum = add(sum, mul(jet[a], jet[m - a]))
      next[m] = sum
    }
    jet = next
  }
  const lambda = jet[1]
  const phi: Vec2[] = [[0, 0], [1, 0]]
  let phiPow: Vec2[][] = [] // phiPow[l] = coefficients of φ(u)^l
  for (let m = 2; m <= order; m++) {
    phiPow = []
    phiPow[1] = phi.slice()
    for (let l = 2; l <= m; l++) phiPow[l] = mulSeries(phiPow[l - 1], phi, m)
    let sum: Vec2 = [0, 0]
    for (let l = 2; l <= m; l++) sum = add(sum, mul(jet[l], phiPow[l][m] || [0, 0]))
    const lambdaM = powC(lambda, m)
    phi[m] = div(sum, [lambdaM[0] - lambda[0], lambdaM[1] - lambda[1]])
  }
  return phi.slice(1)
}

function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]]
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

/** Exact perturbation recurrence δ_{n+1} = 2 Z_n δ_n + δ_n² + δc from δ_0 = 0, for tests. */
export function exactDelta(point: MisiurewiczPoint, dc: Vec2, n: number): Vec2 {
  const { preperiod: k, period: p, orbit } = point
  let d: Vec2 = [0, 0]
  for (let i = 0; i < n; i++) {
    const z = orbit[i < k ? i : k + ((i - k) % p)]
    d = add([2 * (z[0] * d[0] - z[1] * d[1]) + d[0] * d[0] - d[1] * d[1], 2 * (z[0] * d[1] + z[1] * d[0]) + 2 * d[0] * d[1]], dc)
  }
  return d
}

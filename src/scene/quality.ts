import type { MisiurewiczPoint } from './misiurewicz'
import { clamp } from './math'

/**
 * Hard loop bound compiled into the shaders. For dives it caps the iterations a pixel
 * runs after the closed-form skip, so per-pixel cost is independent of zoom depth; for
 * Julia sets it is the plain iteration cap. Must be even: the Julia loop is unrolled by two.
 */
export const MAX_ITERATIONS = 1024

/** Half-height of the viewport in complex units when showing the whole Mandelbrot set. */
export const OVERVIEW_SCALE = 1.35
export const OVERVIEW_CENTER: readonly [number, number] = [-0.6, 0]

/** Zoom depth in doublings below the formula's overview. */
export function depthOf(point: MisiurewiczPoint, log2Scale: number): number {
  return Math.log2(point.formula.overviewScale) - log2Scale
}

/**
 * Pixels leave the closed-form regime once their orbit offset reaches 2^-HANDOFF_BITS of
 * the reference orbit's scale. The handoff uses a KOENIGS_ORDER-term series, so the
 * truncation error is about (2^-HANDOFF_BITS / r)^(KOENIGS_ORDER+1) with r the series'
 * radius of convergence; the misiurewicz tests check it against the exact recurrence.
 */
export const HANDOFF_BITS = 6
export const KOENIGS_ORDER = 5
/**
 * Non-holomorphic formulas have no series, so their linear-only handoff must happen much
 * earlier; their cycles are strongly repelling, so the extra iterations are few.
 */
export const LINEAR_HANDOFF_BITS = 16

export function handoffBits(point: MisiurewiczPoint): number {
  return point.formula.holomorphic ? HANDOFF_BITS : LINEAR_HANDOFF_BITS
}
/**
 * Above this depth (in doublings) the pixel offset δc is so small that its own terms in
 * the orbit dynamics vanish and the series applies; shallower views iterate from scratch,
 * which is cheap there anyway.
 */
export const MIN_SKIP_DEPTH = 16
/** Iterations allowed beyond the handoff for the visible boundary detail. */
const TAIL_ITERATIONS = 192

/**
 * Iteration cap for the direct shader during a dive's first doublings, before the
 * perturbation path takes over at MIN_SKIP_DEPTH.
 */
export function directIterations(depth: number): number {
  return Math.round(clamp(100 + 32 * Math.max(0, depth), 100, MAX_ITERATIONS))
}

/**
 * Iterations a dive pixel may run after the skip. Growing from the handoff to escape takes
 * about HANDOFF_BITS * period / log2|λ| iterations, so weakly repelling cycles cost more.
 */
export function diveIterations(point: MisiurewiczPoint): number {
  const growth = (handoffBits(point) * point.period) / Math.log2(point.growth)
  return Math.round(clamp(growth + TAIL_ITERATIONS, 64, MAX_ITERATIONS))
}

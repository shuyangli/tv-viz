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

/**
 * Pixels leave the closed-form regime once their orbit offset reaches 2^-HANDOFF_BITS of
 * the reference orbit's scale. The handoff uses a KOENIGS_ORDER-term series, so the
 * truncation error is about (2^-HANDOFF_BITS / r)^(KOENIGS_ORDER+1) with r the series'
 * radius of convergence; the misiurewicz tests check it against the exact recurrence.
 */
export const HANDOFF_BITS = 6
export const KOENIGS_ORDER = 5
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
  const log2Lambda = Math.log2(Math.hypot(point.multiplier[0], point.multiplier[1]))
  const growth = (HANDOFF_BITS * point.period) / log2Lambda
  return Math.round(clamp(growth + TAIL_ITERATIONS, 64, MAX_ITERATIONS))
}

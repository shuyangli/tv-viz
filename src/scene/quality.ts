import { clamp } from './math'

/**
 * Hard loop bound compiled into the shader. The CX's Mali-G51 manages roughly 2 billion
 * iterations per second; at this ceiling a 1080p keyframe of a deep zoom takes about
 * 100 ms, which spread over 6–8 frames leaves the display at 60 fps. Must be even: the
 * shader loop is unrolled by two.
 */
export const MAX_ITERATIONS = 300
export const MIN_ITERATIONS = 80

/** Half-height of the viewport in complex units when showing the whole Mandelbrot set. */
export const OVERVIEW_SCALE = 1.35
export const OVERVIEW_CENTER: readonly [number, number] = [-0.6, 0]

/**
 * Single-precision floats give about 7 significant digits. Below this scale, adjacent
 * pixels near |c| ~ 1 land on the same float and the image turns into blocks.
 */
export const MIN_SCALE = 1e-4

const ITERATIONS_PER_ZOOM_DOUBLING = 32

export function iterationsForScale(scale: number): number {
  const doublings = Math.log2(OVERVIEW_SCALE / Math.max(scale, MIN_SCALE))
  const wanted = MIN_ITERATIONS + ITERATIONS_PER_ZOOM_DOUBLING * Math.max(doublings, 0)
  return Math.round(clamp(wanted, MIN_ITERATIONS, MAX_ITERATIONS))
}

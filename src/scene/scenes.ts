import { TWO_PI, type Vec2 } from './math'
import { OVERVIEW_SCALE } from './quality'

export interface DiveScene {
  readonly kind: 'dive'
  readonly name: string
  readonly target: Vec2
  readonly targetScale: number
  readonly zoomInSeconds: number
  readonly holdSeconds: number
  /** 0 fades to black at depth instead of zooming back out. */
  readonly zoomOutSeconds: number
  /** Radians per second of continuous rotation. */
  readonly spin: number
}

export interface JuliaScene {
  readonly kind: 'julia'
  readonly name: string
  readonly durationSeconds: number
  /** Julia constant c as a function of progress u in [0, 1]. */
  readonly seedPath: (u: number) => Vec2
  readonly scale: number
  readonly spin: number
  /** Points near a Julia set escape slowly, so these views need more iterations than the Mandelbrot overview. */
  readonly iterations: number
}

export type Scene = DiveScene | JuliaScene

const DEFAULT_SPIN = 0.015

function dive(
  name: string,
  target: Vec2,
  targetScale: number,
  timing: { zoomIn?: number; hold?: number; zoomOut?: number; spin?: number } = {},
): DiveScene {
  return {
    kind: 'dive',
    name,
    target,
    targetScale,
    zoomInSeconds: timing.zoomIn === undefined ? 75 : timing.zoomIn,
    holdSeconds: timing.hold === undefined ? 20 : timing.hold,
    zoomOutSeconds: timing.zoomOut === undefined ? 40 : timing.zoomOut,
    spin: timing.spin === undefined ? DEFAULT_SPIN : timing.spin,
  }
}

/**
 * Points on the boundary of the main cardioid: c = μ/2 − μ²/4 with μ = r·e^{iθ}.
 * r slightly below 1 keeps the Julia set connected while staying close to the
 * chaotic boundary where it looks most intricate.
 */
export function cardioidSeed(theta: number, r: number): Vec2 {
  const mx = r * Math.cos(theta)
  const my = r * Math.sin(theta)
  const sqx = mx * mx - my * my
  const sqy = 2 * mx * my
  return [mx / 2 - sqx / 4, my / 2 - sqy / 4]
}

/** Points on the boundary of the period-2 bulb centred at −1 with radius 1/4. */
export function bulbSeed(theta: number, r: number): Vec2 {
  return [-1 + 0.25 * r * Math.cos(theta), 0.25 * r * Math.sin(theta)]
}

function easeInOut(u: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * u)
}

function segment(from: Vec2, to: Vec2): (u: number) => Vec2 {
  return (u) => {
    const e = easeInOut(u)
    return [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]
  }
}

/**
 * Just inside the cardioid boundary the Julia set stays connected, with large
 * interior basins that the orbit-trap shading turns into nested "eyes".
 */
const CARDIOID_RADIUS = 0.99
const JULIA_ITERATIONS = 300

function julia(
  name: string,
  seedPath: (u: number) => Vec2,
  durationSeconds = 90,
  scale = 1.45,
  spin = DEFAULT_SPIN,
): JuliaScene {
  return { kind: 'julia', name, durationSeconds, seedPath, scale, spin, iterations: JULIA_ITERATIONS }
}

export const SCENES: readonly Scene[] = [
  dive('Seahorse Valley', [-0.743643887037151, 0.13182590420533], 3e-4),
  julia('Cardioid Walk', (u) => cardioidSeed(0.15 * TWO_PI + 0.35 * TWO_PI * u, CARDIOID_RADIUS), 120),
  dive('Elephant Valley', [0.2795, 0.0093], 6e-4, { zoomOut: 0 }),
  julia('Dendrite Drift', segment([-0.1, 0.9], [0.05, 1.02]), 80, 1.6),
  dive('Crown Satellite', [-0.1592, 1.0317], 4e-3, { zoomIn: 60, hold: 25 }),
  julia('Spiral Eyes', segment([-0.4, 0.6], [-0.5, 0.56]), 110, 1.5),
  dive('Satellite', [-1.7548776662, 0.0], 8e-3, { zoomIn: 55, hold: 25, zoomOut: 0 }),
  julia('Rabbit to Dragon', segment([-0.123, 0.745], [-0.8, 0.156]), 100, 1.55),
  dive('Quad Spiral', [0.32450464, 0.04855101], 4e-4, { zoomIn: 70 }),
  julia('Siegel Spiral', segment([-0.390541, -0.586788], [-0.4, -0.59]), 70, 1.5, 0.03),
  dive('Double Spiral', [-0.7453, 0.1127], 5e-4, { zoomIn: 65, zoomOut: 0 }),
  julia('Southern Walk', (u) => cardioidSeed(0.55 * TWO_PI + 0.3 * TWO_PI * u, CARDIOID_RADIUS), 110),
  dive('Misiurewicz Spiral', [-0.77568377, 0.13646737], 5e-4, { zoomIn: 70, hold: 25 }),
  julia('Dragon Coast', segment([-0.8, 0.156], [-0.7269, 0.1889]), 90, 1.5),
  dive('Antenna Branches', [-1.25066, 0.02012], 5e-4, { zoomIn: 70, zoomOut: 0 }),
  julia('Lightning', segment([0.0, 1.0], [0.0, 0.94]), 80, 1.6, 0.02),
  dive('Dendrite Coast', [0.001643721971153, -0.822467633298876], 5e-4, { zoomIn: 75 }),
]

export const OVERVIEW: Vec2 = [-0.6, 0]
export { OVERVIEW_SCALE }

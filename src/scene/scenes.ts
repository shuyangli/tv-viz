import { TWO_PI, type Vec2 } from './math'
import { classify, solveMisiurewicz, type MisiurewiczPoint } from './misiurewicz'
import { OVERVIEW_SCALE } from './quality'

/**
 * An endless zoom toward a Misiurewicz point. The point is pinned down exactly at load
 * time from a nearby guess and its preperiod and period, so the scene definition stays
 * readable while the renderer gets the orbit to full double precision.
 */
export interface DiveScene {
  readonly kind: 'dive'
  readonly name: string
  readonly point: MisiurewiczPoint
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

export function resolveMisiurewicz(guess: Vec2, preperiod: number, period: number): MisiurewiczPoint {
  const root = solveMisiurewicz(guess, preperiod, period)
  const point = root && classify(root)
  if (!point) throw new Error('No Misiurewicz point near ' + guess[0] + ', ' + guess[1])
  return point
}

function dive(name: string, guess: Vec2, preperiod: number, period: number, spin = DEFAULT_SPIN): DiveScene {
  return { kind: 'dive', name, point: resolveMisiurewicz(guess, preperiod, period), spin }
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

/**
 * Dive guesses come from the spiral centres of the earlier finite tours plus a survey of
 * the boundary for cycles with a comfortable multiplier; the multiplier sets how many
 * extra iterations every zoom doubling costs, so very tight spirals (|λ| near 1) are
 * left out.
 */
export const SCENES: readonly Scene[] = [
  dive('Seahorse Valley', [-0.74329189085243, 0.131240552308798], 24, 2),
  julia('Cardioid Walk', (u) => cardioidSeed(0.15 * TWO_PI + 0.35 * TWO_PI * u, CARDIOID_RADIUS), 120),
  dive('Misiurewicz Spiral', [-0.775683768009054, 0.13646736829469], 24, 1),
  julia('Dendrite Drift', segment([-0.1, 0.9], [0.05, 1.02]), 80, 1.6),
  dive('Twin Spiral', [-0.13884173834, 1.004163060447], 10, 4),
  julia('Spiral Eyes', segment([-0.4, 0.6], [-0.5, 0.56]), 110, 1.5),
  dive('Double Spiral', [-0.74515806380162, 0.112574916205416], 28, 2),
  julia('Rabbit to Dragon', segment([-0.123, 0.745], [-0.8, 0.156]), 100, 1.55),
  dive('Branch Point', [-0.46230642218, 0.630743988029], 12, 1),
  julia('Siegel Spiral', segment([-0.390541, -0.586788], [-0.4, -0.59]), 70, 1.5, 0.03),
  dive('Top Spiral', [-0.101096363845622, 0.956286510809142], 4, 1),
  julia('Southern Walk', (u) => cardioidSeed(0.55 * TWO_PI + 0.3 * TWO_PI * u, CARDIOID_RADIUS), 110),
  dive('Triple Arm', [0.252103892669, 0.589703407776], 10, 3),
  julia('Dragon Coast', segment([-0.8, 0.156], [-0.7269, 0.1889]), 90, 1.5),
  dive('Dendrite Coast', [0.00164295554715, -0.822466530019091], 7, 1),
  julia('Lightning', segment([0.0, 1.0], [0.0, 0.94]), 80, 1.6, 0.02),
  dive('Fork', [-0.252961547265, 0.849973842324], 11, 3),
]

export const OVERVIEW: Vec2 = [-0.6, 0]
export { OVERVIEW_SCALE }

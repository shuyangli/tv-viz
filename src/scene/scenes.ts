import { BURNING_SHIP, CELTIC, CUBIC, MANDELBROT, type Formula } from './formula'
import type { Vec2 } from './math'
import { classify, solveMisiurewicz, type MisiurewiczPoint } from './misiurewicz'
import { OVERVIEW_SCALE } from './quality'

/**
 * An endless zoom toward a Misiurewicz point of some formula. The point is pinned down
 * exactly at load time from a nearby guess and its preperiod and period, so the scene
 * definition stays readable while the renderer gets the orbit to full double precision.
 */
export interface DiveScene {
  readonly kind: 'dive'
  readonly name: string
  readonly point: MisiurewiczPoint
  /** Radians per second of continuous rotation. */
  readonly spin: number
}

export type Scene = DiveScene

const DEFAULT_SPIN = 0.015

export function resolveMisiurewicz(formula: Formula, guess: Vec2, preperiod: number, period: number): MisiurewiczPoint {
  const root = solveMisiurewicz(formula, guess, preperiod, period)
  const point = root && classify(formula, root)
  if (!point) throw new Error('No ' + formula.name + ' Misiurewicz point near ' + guess[0] + ', ' + guess[1])
  return point
}

function dive(name: string, formula: Formula, guess: Vec2, preperiod: number, period: number, spin = DEFAULT_SPIN): DiveScene {
  return { kind: 'dive', name, point: resolveMisiurewicz(formula, guess, preperiod, period), spin }
}

/**
 * Guesses come from the spiral centres of the earlier finite tours plus surveys of each
 * formula's boundary for cycles with a comfortable multiplier; the multiplier sets how
 * many extra iterations every zoom doubling costs, so very tight spirals (growth near 1)
 * are left out.
 */
export const SCENES: readonly Scene[] = [
  dive('Seahorse Valley', MANDELBROT, [-0.74329189085243, 0.131240552308798], 24, 2),
  dive('Ship Coral', BURNING_SHIP, [-0.981350557423, -0.899635266225], 7, 4),
  dive('Cubic Trefoil', CUBIC, [-0.640537448246, 0.494732056334], 7, 3),
  dive('Celtic Rings', CELTIC, [-1.212433276694, 0.68540320296], 9, 4),
  dive('Misiurewicz Spiral', MANDELBROT, [-0.775683768009054, 0.13646736829469], 24, 1),
  dive('Cubic Lightning', CUBIC, [0.301697899247, 0.980757859548], 6, 2),
  dive('Ship Lattice', BURNING_SHIP, [-0.739629194311, -1.079545453956], 9, 2),
  dive('Twin Spiral', MANDELBROT, [-0.13884173834, 1.004163060447], 10, 4),
  dive('Celtic Arcs', CELTIC, [-0.980686551379, 0.680215367515], 10, 4),
  dive('Cubic Coast', CUBIC, [-0.222124090297, 0.74652017574], 8, 2),
  dive('Double Spiral', MANDELBROT, [-0.74515806380162, 0.112574916205416], 28, 2),
  dive('Rigging', BURNING_SHIP, [-1.102769713136, -0.600400700795], 10, 1),
  dive('Cubic Whorl', CUBIC, [0.552614870636, 0.323421292123], 9, 3),
  dive('Branch Point', MANDELBROT, [-0.46230642218, 0.630743988029], 12, 1),
  dive('Celtic Lattice', CELTIC, [-1.519381643621, 0.079715455064], 10, 4),
  dive('Top Spiral', MANDELBROT, [-0.101096363845622, 0.956286510809142], 4, 1),
  dive('Cubic Dendrite', CUBIC, [-0.265568124701, 0.925543570198], 8, 1),
  dive('Triple Arm', MANDELBROT, [0.252103892669, 0.589703407776], 10, 3),
  dive('Dendrite Coast', MANDELBROT, [0.00164295554715, -0.822466530019091], 7, 1),
  dive('Fork', MANDELBROT, [-0.252961547265, 0.849973842324], 11, 3),
]

export { OVERVIEW_SCALE, BURNING_SHIP, CELTIC, CUBIC, MANDELBROT }

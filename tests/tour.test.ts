import { describe, expect, it } from 'vitest'
import { OVERVIEW_CENTER, OVERVIEW_SCALE, MIN_SCALE, MAX_ITERATIONS, MIN_ITERATIONS, iterationsForScale } from '../src/scene/quality'
import { SCENES, cardioidSeed, type DiveScene, type JuliaScene } from '../src/scene/scenes'
import { sceneDuration, Tour } from '../src/scene/tour'

const dive: DiveScene = {
  kind: 'dive',
  name: 'test dive',
  target: [-0.75, 0.1],
  targetScale: 1e-3,
  zoomInSeconds: 10,
  holdSeconds: 4,
  zoomOutSeconds: 6,
  spin: 0,
}

const julia: JuliaScene = {
  kind: 'julia',
  name: 'test julia',
  durationSeconds: 8,
  seedPath: (u) => [u, 1 - u],
  scale: 1.5,
  spin: 0.1,
  iterations: 250,
}

describe('Tour dive', () => {
  it('starts at the overview and reaches the target scale at the end of the zoom', () => {
    const tour = new Tour([dive])
    const start = tour.frame()
    expect(start.scale).toBeCloseTo(OVERVIEW_SCALE)
    expect(start.center[0]).toBeCloseTo(OVERVIEW_CENTER[0])
    expect(start.center[1]).toBeCloseTo(OVERVIEW_CENTER[1])
    expect(start.phase).toBe('in')

    tour.seek(dive.zoomInSeconds)
    const deep = tour.frame()
    expect(deep.scale).toBeCloseTo(dive.targetScale, 6)
    expect(deep.center[0]).toBeCloseTo(dive.target[0], 3)
    expect(deep.center[1]).toBeCloseTo(dive.target[1], 3)
    expect(deep.phase).toBe('hold')
  })

  it('keeps the target at the same screen position throughout the zoom', () => {
    const tour = new Tour([dive])
    const screenOffset = (t: number): [number, number] => {
      tour.seek(t)
      const f = tour.frame()
      return [(dive.target[0] - f.center[0]) / f.scale, (dive.target[1] - f.center[1]) / f.scale]
    }
    const early = screenOffset(1)
    const late = screenOffset(9)
    expect(early[0]).toBeCloseTo(late[0], 6)
    expect(early[1]).toBeCloseTo(late[1], 6)
  })

  it('zooms back out to the overview', () => {
    const tour = new Tour([dive])
    tour.seek(sceneDuration(dive) - 1e-6)
    expect(tour.frame().phase).toBe('out')
    expect(tour.frame().scale).toBeCloseTo(OVERVIEW_SCALE, 3)
  })

  it('fades to black at the scene boundaries', () => {
    const tour = new Tour([dive])
    expect(tour.frame().brightness).toBe(0)
    tour.seek(1)
    expect(tour.frame().brightness).toBeCloseTo(0.5)
    tour.seek(10)
    expect(tour.frame().brightness).toBe(1)
    tour.seek(sceneDuration(dive) - 0.5)
    expect(tour.frame().brightness).toBeCloseTo(0.25)
  })

  it('never goes below the float precision floor', () => {
    const tour = new Tour([{ ...dive, targetScale: 1e-9 }])
    tour.seek(dive.zoomInSeconds)
    expect(tour.frame().scale).toBeGreaterThanOrEqual(MIN_SCALE * (1 - 0.13))
  })
})

describe('Tour sequencing', () => {
  it('advances to the next scene when the current one ends and wraps around', () => {
    const tour = new Tour([dive, julia])
    expect(tour.update(sceneDuration(dive) - 1)).toBe(false)
    expect(tour.update(1)).toBe(true)
    expect(tour.sceneIndex).toBe(1)
    expect(tour.frame().julia).toBe(true)
    expect(tour.update(sceneDuration(julia))).toBe(true)
    expect(tour.sceneIndex).toBe(0)
  })

  it('walks the Julia seed along its path', () => {
    const tour = new Tour([julia])
    expect(tour.frame().seed).toEqual([0, 1])
    tour.seek(4)
    expect(tour.frame().seed[0]).toBeCloseTo(0.5)
    tour.seek(8)
    expect(tour.frame().seed).toEqual([1, 0])
  })

  it('supports manual next and prev with wraparound', () => {
    const tour = new Tour([dive, julia])
    tour.prev()
    expect(tour.sceneIndex).toBe(1)
    tour.next()
    expect(tour.sceneIndex).toBe(0)
    expect(tour.elapsed).toBe(0)
  })

  it('uses the Julia scene iteration budget instead of the zoom-based one', () => {
    const tour = new Tour([julia])
    expect(tour.frame().maxIter).toBe(250)
  })

  it('accumulates rotation from the scene spin', () => {
    const tour = new Tour([julia])
    tour.update(2)
    expect(tour.frame().rotation).toBeCloseTo(0.2)
  })
})

describe('iterationsForScale', () => {
  it('uses more iterations as the zoom deepens, within bounds', () => {
    expect(iterationsForScale(OVERVIEW_SCALE)).toBe(MIN_ITERATIONS)
    expect(iterationsForScale(OVERVIEW_SCALE / 4)).toBeGreaterThan(MIN_ITERATIONS)
    expect(iterationsForScale(1e-12)).toBe(MAX_ITERATIONS)
  })
})

describe('scene library', () => {
  it('alternates Mandelbrot dives with Julia sets and stays above the precision floor', () => {
    for (let i = 0; i < SCENES.length; i++) {
      const scene = SCENES[i]
      expect(scene.kind).toBe(i % 2 === 0 ? 'dive' : 'julia')
      if (scene.kind === 'dive') expect(scene.targetScale).toBeGreaterThanOrEqual(MIN_SCALE)
      expect(sceneDuration(scene)).toBeGreaterThan(0)
    }
  })

  it('places cardioid seeds on the main cardioid boundary when r = 1', () => {
    // θ = 0 maps to the cusp at c = 1/4; θ = π maps to c = −3/4 where the period-2 bulb attaches.
    expect(cardioidSeed(0, 1)[0]).toBeCloseTo(0.25)
    expect(cardioidSeed(0, 1)[1]).toBeCloseTo(0)
    expect(cardioidSeed(Math.PI, 1)[0]).toBeCloseTo(-0.75)
    expect(cardioidSeed(Math.PI, 1)[1]).toBeCloseTo(0)
  })
})

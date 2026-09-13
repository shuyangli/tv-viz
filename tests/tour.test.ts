import { describe, expect, it } from 'vitest'
import { OVERVIEW_CENTER, OVERVIEW_SCALE } from '../src/scene/quality'
import { cameraCenter } from '../src/render/keyframe'
import { resolveMisiurewicz, SCENES, cardioidSeed, type DiveScene, type JuliaScene } from '../src/scene/scenes'
import { diveDepth, sceneDuration, Tour, ZOOM_DOUBLINGS_PER_SECOND } from '../src/scene/tour'

const dive: DiveScene = {
  kind: 'dive',
  name: 'test dive',
  point: resolveMisiurewicz([-0.1, 0.95], 4, 1),
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
  it('starts framed like the overview', () => {
    const tour = new Tour([dive])
    const start = tour.frame()
    expect(start.log2Scale).toBeCloseTo(Math.log2(OVERVIEW_SCALE))
    const centre = cameraCenter(start)
    expect(centre[0]).toBeCloseTo(OVERVIEW_CENTER[0])
    expect(centre[1]).toBeCloseTo(OVERVIEW_CENTER[1])
    expect(start.anchor).toEqual(dive.point.c)
    expect(start.reference).toBe(dive.point)
    expect(start.phase).toBe('in')
  })

  it('zooms at a constant rate in log space forever', () => {
    const tour = new Tour([dive])
    tour.seek(100)
    expect(tour.frame().log2Scale).toBeCloseTo(Math.log2(OVERVIEW_SCALE) - 100 * ZOOM_DOUBLINGS_PER_SECOND)
    tour.seek(1e5)
    expect(tour.frame().log2Scale).toBeCloseTo(Math.log2(OVERVIEW_SCALE) - diveDepth(1e5))
    expect(sceneDuration(dive)).toBe(Infinity)
  })

  it('slides the point to the screen centre over the first doublings and keeps it there', () => {
    const tour = new Tour([dive])
    expect(Math.hypot(...tour.frame().offset)).toBeGreaterThan(0.1)
    tour.seek(200)
    expect(Math.hypot(...tour.frame().offset)).toBe(0)
  })

  it('fades in from black and never fades out', () => {
    const tour = new Tour([dive])
    expect(tour.frame().brightness).toBe(0)
    tour.seek(1)
    expect(tour.frame().brightness).toBeCloseTo(0.5)
    tour.seek(1e6)
    expect(tour.frame().brightness).toBe(1)
  })

  it('never restarts on its own', () => {
    const tour = new Tour([dive, julia])
    expect(tour.update(1e6)).toBe(false)
    expect(tour.sceneIndex).toBe(0)
  })
})

describe('Tour sequencing', () => {
  it('restarts a looping scene when it ends instead of advancing', () => {
    const tour = new Tour([julia, dive])
    const epoch = tour.epoch
    expect(tour.update(sceneDuration(julia) - 1)).toBe(false)
    expect(tour.update(1.5)).toBe(true)
    expect(tour.sceneIndex).toBe(0)
    expect(tour.elapsed).toBeCloseTo(0.5)
    expect(tour.epoch).toBe(epoch + 1)
  })

  it('changes epoch on manual scene switches so stale keyframes are dropped', () => {
    const tour = new Tour([dive, julia])
    const epoch = tour.epoch
    tour.next()
    expect(tour.epoch).toBe(epoch + 1)
    expect(tour.frame().epoch).toBe(epoch + 1)
    expect(tour.frame().julia).toBe(true)
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

  it('uses the Julia scene iteration budget', () => {
    const tour = new Tour([julia])
    expect(tour.frame().maxIter).toBe(250)
    expect(tour.frame().reference).toBeNull()
  })

  it('accumulates rotation from the scene spin', () => {
    const tour = new Tour([julia])
    tour.update(2)
    expect(tour.frame().rotation).toBeCloseTo(0.2)
  })
})

describe('scene library', () => {
  it('alternates endless dives with Julia sets, every dive on a resolved Misiurewicz point', () => {
    for (let i = 0; i < SCENES.length; i++) {
      const scene = SCENES[i]
      expect(scene.kind).toBe(i % 2 === 0 ? 'dive' : 'julia')
      if (scene.kind === 'dive') {
        expect(scene.point.preperiod).toBeGreaterThan(0)
        expect(Math.hypot(...scene.point.multiplier)).toBeGreaterThan(1)
      } else {
        expect(sceneDuration(scene)).toBeGreaterThan(0)
      }
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

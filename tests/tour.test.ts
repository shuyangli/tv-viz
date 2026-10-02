import { describe, expect, it } from 'vitest'
import { cameraCenter } from '../src/render/keyframe'
import { MANDELBROT } from '../src/scene/formula'
import { resolveMisiurewicz, SCENES, type DiveScene } from '../src/scene/scenes'
import { diveDepth, Tour, ZOOM_DOUBLINGS_PER_SECOND } from '../src/scene/tour'

const dive: DiveScene = {
  kind: 'dive',
  name: 'test dive',
  point: resolveMisiurewicz(MANDELBROT, [-0.1, 0.95], 4, 1),
  spin: 0,
}

const other: DiveScene = { ...dive, name: 'other', spin: 0.1 }

describe('Tour dive', () => {
  it('starts framed like the overview', () => {
    const tour = new Tour([dive])
    const start = tour.frame()
    expect(start.log2Scale).toBeCloseTo(Math.log2(MANDELBROT.overviewScale))
    expect(start.depth).toBe(0)
    const centre = cameraCenter(start)
    expect(centre[0]).toBeCloseTo(MANDELBROT.overviewCenter[0])
    expect(centre[1]).toBeCloseTo(MANDELBROT.overviewCenter[1])
    expect(start.anchor).toEqual(dive.point.c)
    expect(start.reference).toBe(dive.point)
  })

  it('zooms at a constant rate in log space forever', () => {
    const tour = new Tour([dive])
    tour.seek(100)
    expect(tour.frame().log2Scale).toBeCloseTo(Math.log2(MANDELBROT.overviewScale) - 100 * ZOOM_DOUBLINGS_PER_SECOND)
    tour.seek(1e5)
    expect(tour.frame().depth).toBeCloseTo(diveDepth(1e5))
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

  it('never restarts or advances on its own', () => {
    const tour = new Tour([dive, other])
    const epoch = tour.epoch
    expect(tour.update(1e6)).toBe(false)
    expect(tour.sceneIndex).toBe(0)
    expect(tour.epoch).toBe(epoch)
  })
})

describe('Tour sequencing', () => {
  it('changes epoch on manual scene switches so stale keyframes are dropped', () => {
    const tour = new Tour([dive, other])
    const epoch = tour.epoch
    tour.next()
    expect(tour.epoch).toBe(epoch + 1)
    expect(tour.frame().epoch).toBe(epoch + 1)
    expect(tour.frame().sceneName).toBe('other')
    expect(tour.elapsed).toBe(0)
  })

  it('supports manual next and prev with wraparound', () => {
    const tour = new Tour([dive, other])
    tour.prev()
    expect(tour.sceneIndex).toBe(1)
    tour.next()
    expect(tour.sceneIndex).toBe(0)
  })

  it('accumulates rotation from the scene spin', () => {
    const tour = new Tour([other])
    tour.update(2)
    expect(tour.frame().rotation).toBeCloseTo(0.2)
  })
})

describe('scene library', () => {
  it('is all endless dives on resolved repelling Misiurewicz points, with more than one formula', () => {
    const formulas = new Set<string>()
    for (const scene of SCENES) {
      expect(scene.kind).toBe('dive')
      expect(scene.point.preperiod).toBeGreaterThan(0)
      expect(scene.point.growth).toBeGreaterThan(1)
      formulas.add(scene.point.formula.id)
    }
    expect(formulas.size).toBeGreaterThan(1)
  })
})

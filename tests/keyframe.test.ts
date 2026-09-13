import { describe, expect, it } from 'vitest'
import {
  applyReprojection,
  fractalRow,
  planKeyframe,
  reproject,
  storedRow,
  type Camera,
  type KeyframeLayout,
} from '../src/render/keyframe'
import { Tour } from '../src/scene/tour'
import { SCENES } from '../src/scene/scenes'

const W = 1920
const H = 1080

describe('planKeyframe', () => {
  it('matches screen texel density at scale 1 and pads the height to a tile multiple', () => {
    const layout = planKeyframe(W, H, 1, 0.01, 0.01, 7, 4096, 4096)
    expect(layout.width).toBe(W)
    expect(layout.height % 7).toBe(0)
    expect(layout.height).toBeGreaterThanOrEqual(H)
    expect(layout.rowsPerTile * 7).toBe(layout.height)
    expect(layout.unitsPerTexel).toBeCloseTo(0.02 / H)
  })

  it('covers a larger view with more texels at the same density', () => {
    const tight = planKeyframe(W, H, 0.5, 1, 1, 4, 4096, 4096)
    const wide = planKeyframe(W, H, 0.5, 1, 1.1, 4, 4096, 4096)
    expect(wide.unitsPerTexel).toBe(tight.unitsPerTexel)
    expect(wide.width).toBeGreaterThan(tight.width)
    expect(wide.height).toBeGreaterThan(tight.height)
  })

  it('never exceeds the allocated texture', () => {
    const layout = planKeyframe(W, H, 1, 1, 2, 8, 2000, 1100)
    expect(layout.width).toBeLessThanOrEqual(2000)
    expect(layout.height).toBeLessThanOrEqual(1100)
  })
})

describe('row interleaving', () => {
  it('is a bijection between fractal rows and stored rows', () => {
    const layout: KeyframeLayout = { width: 1, height: 35, tiles: 5, rowsPerTile: 7, unitsPerTexel: 1 }
    const seen = new Set<number>()
    for (let row = 0; row < layout.height; row++) {
      const stored = storedRow(row, layout)
      expect(stored).toBeGreaterThanOrEqual(0)
      expect(stored).toBeLessThan(layout.height)
      expect(fractalRow(stored, layout)).toBe(row)
      seen.add(stored)
    }
    expect(seen.size).toBe(layout.height)
  })

  it('gives every tile rows spread across the whole image', () => {
    const layout: KeyframeLayout = { width: 1, height: 40, tiles: 4, rowsPerTile: 10, unitsPerTexel: 1 }
    const tileRows = (tile: number) =>
      Array.from({ length: layout.rowsPerTile }, (_, i) => fractalRow(tile * layout.rowsPerTile + i, layout))
    expect(tileRows(0)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36])
    expect(tileRows(3)).toEqual([3, 7, 11, 15, 19, 23, 27, 31, 35, 39])
  })
})

describe('reproject', () => {
  const key: Camera = { center: [-0.7436, 0.1318], scale: 3e-4, rotation: 0.4 }

  function pointOnScreen(camera: Camera, x: number, y: number): [number, number] {
    const u = (2 * camera.scale) / H
    const dx = (x - W / 2) * u
    const dy = (y - H / 2) * u
    const cs = Math.cos(camera.rotation)
    const sn = Math.sin(camera.rotation)
    return [camera.center[0] + dx * cs - dy * sn, camera.center[1] + dx * sn + dy * cs]
  }

  function pointInKeyframe(layout: KeyframeLayout, camera: Camera, tx: number, ty: number): [number, number] {
    const dx = (tx - layout.width / 2) * layout.unitsPerTexel
    const dy = (ty - layout.height / 2) * layout.unitsPerTexel
    const cs = Math.cos(camera.rotation)
    const sn = Math.sin(camera.rotation)
    return [camera.center[0] + dx * cs - dy * sn, camera.center[1] + dx * sn + dy * cs]
  }

  it('is the identity when the camera has not moved and the keyframe is at screen density', () => {
    const layout = planKeyframe(W, H, 1, key.scale, key.scale, 1, 4096, 4096)
    const r = reproject(W, H, key, key, layout)
    const p = applyReprojection(r, 100.5, 700.5)
    expect(p[0]).toBeCloseTo(100.5 + (layout.width - W) / 2, 6)
    expect(p[1]).toBeCloseTo(700.5 + (layout.height - H) / 2, 6)
  })

  it('sends a screen pixel to the keyframe texel that samples the same complex point', () => {
    const current: Camera = { center: [key.center[0] + 2e-5, key.center[1] - 1e-5], scale: 2.7e-4, rotation: 0.41 }
    const layout = planKeyframe(W, H, 0.6, key.scale, key.scale * 1.05, 6, 4096, 4096)
    const r = reproject(W, H, current, key, layout)
    for (const [x, y] of [
      [0.5, 0.5],
      [W - 0.5, H - 0.5],
      [W / 2, H / 2],
      [333.5, 1000.5],
    ]) {
      const [tx, ty] = applyReprojection(r, x, y)
      const viaScreen = pointOnScreen(current, x, y)
      const viaKey = pointInKeyframe(layout, key, tx, ty)
      // Agreement to a small fraction of a texel: unitsPerTexel * 1e-3.
      expect(Math.abs(viaScreen[0] - viaKey[0])).toBeLessThan(layout.unitsPerTexel * 1e-3)
      expect(Math.abs(viaScreen[1] - viaKey[1])).toBeLessThan(layout.unitsPerTexel * 1e-3)
    }
  })
})

describe('Tour.frameAt', () => {
  it('looks ahead without advancing and clamps to the current scene', () => {
    const tour = new Tour(SCENES)
    tour.seek(10)
    const now = tour.frame()
    const ahead = tour.frameAt(0.5)
    expect(tour.frame()).toEqual(now)
    expect(ahead.scale).toBeLessThan(now.scale)
    expect(ahead.sceneIndex).toBe(now.sceneIndex)
    const far = tour.frameAt(1e6)
    expect(far.sceneIndex).toBe(now.sceneIndex)
    expect(Number.isFinite(far.scale)).toBe(true)
    expect(far.brightness).toBe(0)
  })

  it('stays finite at the end of a dive that fades out instead of zooming out', () => {
    const tour = new Tour([SCENES[2]])
    const end = tour.frameAt(1e6)
    expect(Number.isFinite(end.scale)).toBe(true)
    expect(Number.isFinite(end.center[0])).toBe(true)
  })
})

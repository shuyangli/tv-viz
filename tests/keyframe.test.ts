import { describe, expect, it } from 'vitest'
import {
  applyReprojection,
  cameraCenter,
  fractalRow,
  planKeyframe,
  reproject,
  rowPermutation,
  storedRow,
  type Camera,
  type KeyframeLayout,
} from '../src/render/keyframe'
import { SCENES } from '../src/scene/scenes'
import { Tour } from '../src/scene/tour'

const W = 1920
const H = 1080

describe('planKeyframe', () => {
  it('matches screen texel density at density 1', () => {
    const layout = planKeyframe(W, H, 1, 1, 4096, 4096)
    expect(layout.width).toBe(W)
    expect(layout.height).toBe(H)
    expect(layout.texelToView).toBeCloseTo(2 / H)
  })

  it('covers a larger view with more texels at the same density', () => {
    const tight = planKeyframe(W, H, 0.5, 1, 4096, 4096)
    const wide = planKeyframe(W, H, 0.5, 1.1, 4096, 4096)
    expect(wide.texelToView).toBe(tight.texelToView)
    expect(wide.width).toBeGreaterThan(tight.width)
    expect(wide.height).toBeGreaterThan(tight.height)
  })

  it('never exceeds the allocated texture', () => {
    const layout = planKeyframe(W, H, 1, 2, 2000, 1100)
    expect(layout.width).toBeLessThanOrEqual(2000)
    expect(layout.height).toBeLessThanOrEqual(1100)
  })
})

describe('row permutation', () => {
  it('is a bijection between fractal rows and stored rows for any height', () => {
    for (const height of [1, 2, 3, 7, 35, 64, 1080, 1221]) {
      const layout = planKeyframe(1, height, 1, 1, 4096, 4096)
      const seen = new Set<number>()
      for (let row = 0; row < layout.height; row++) {
        const stored = storedRow(row, layout)
        expect(stored).toBeGreaterThanOrEqual(0)
        expect(stored).toBeLessThan(layout.height)
        expect(fractalRow(stored, layout)).toBe(row)
        seen.add(stored)
      }
      expect(seen.size).toBe(layout.height)
    }
  })

  it('spreads any run of consecutive stored rows across the whole image', () => {
    const layout = planKeyframe(1, 1000, 1, 1, 4096, 4096)
    const { stride, inverse } = rowPermutation(1000)
    expect(layout.rowStride).toBe(stride)
    expect(layout.rowStrideInv).toBe(inverse)
    expect(stride).toBeGreaterThan(550)
    expect(stride).toBeLessThan(700)
    // Ten consecutive stored rows: no two fractal rows closer than 5% of the height.
    const rows = Array.from({ length: 10 }, (_, s) => fractalRow(400 + s, layout)).sort((a, b) => a - b)
    for (let i = 1; i < rows.length; i++) expect(rows[i] - rows[i - 1]).toBeGreaterThan(50)
  })

  it('keeps the shader arithmetic exact in single precision at the largest keyframe', () => {
    const layout = planKeyframe(2400, 1400, 1, 1, 4096, 4096)
    expect(layout.height * layout.rowStride).toBeLessThan(Math.pow(2, 24))
    expect(layout.height * layout.rowStrideInv).toBeLessThan(Math.pow(2, 24))
  })
})

describe('reproject', () => {
  const anchor: [number, number] = [-0.7436, 0.1318]
  const key: Camera = { anchor, offset: [0.05, -0.02], log2Scale: Math.log2(3e-4), rotation: 0.4 }

  /** Offset from the anchor, in absolute units, of a screen pixel under a camera. */
  function fromScreen(camera: Camera, x: number, y: number): [number, number] {
    const scale = Math.pow(2, camera.log2Scale)
    const vx = camera.offset[0] + ((x - W / 2) * 2) / H
    const vy = camera.offset[1] + ((y - H / 2) * 2) / H
    const cs = Math.cos(camera.rotation)
    const sn = Math.sin(camera.rotation)
    const ux = (x - W / 2) * (2 / H)
    const uy = (y - H / 2) * (2 / H)
    return [(camera.offset[0] + ux * cs - uy * sn) * scale, (camera.offset[1] + ux * sn + uy * cs) * scale, vx, vy].slice(0, 2) as [number, number]
  }

  function fromKeyframe(layout: KeyframeLayout, camera: Camera, tx: number, ty: number): [number, number] {
    const scale = Math.pow(2, camera.log2Scale)
    const dx = (tx - layout.width / 2) * layout.texelToView
    const dy = (ty - layout.height / 2) * layout.texelToView
    const cs = Math.cos(camera.rotation)
    const sn = Math.sin(camera.rotation)
    return [(camera.offset[0] + dx * cs - dy * sn) * scale, (camera.offset[1] + dx * sn + dy * cs) * scale]
  }

  it('is the identity when the camera has not moved and the keyframe is at screen density', () => {
    const layout = planKeyframe(W, H, 1, 1, 4096, 4096)
    const r = reproject(W, H, key, key, layout)
    const p = applyReprojection(r, 100.5, 700.5)
    expect(p[0]).toBeCloseTo(100.5 + (layout.width - W) / 2, 6)
    expect(p[1]).toBeCloseTo(700.5 + (layout.height - H) / 2, 6)
  })

  it('sends a screen pixel to the keyframe texel that samples the same point', () => {
    const current: Camera = { anchor, offset: [0.04, -0.03], log2Scale: Math.log2(2.7e-4), rotation: 0.41 }
    const layout = planKeyframe(W, H, 0.6, 1.05, 4096, 4096)
    const r = reproject(W, H, current, key, layout)
    const texelUnits = layout.texelToView * Math.pow(2, key.log2Scale)
    for (const [x, y] of [
      [0.5, 0.5],
      [W - 0.5, H - 0.5],
      [W / 2, H / 2],
      [333.5, 1000.5],
    ]) {
      const [tx, ty] = applyReprojection(r, x, y)
      const viaScreen = fromScreen(current, x, y)
      const viaKey = fromKeyframe(layout, key, tx, ty)
      expect(Math.abs(viaScreen[0] - viaKey[0])).toBeLessThan(texelUnits * 1e-3)
      expect(Math.abs(viaScreen[1] - viaKey[1])).toBeLessThan(texelUnits * 1e-3)
    }
  })

  it('stays finite and exact at depths far beyond double precision', () => {
    const deep: Camera = { anchor, offset: [0, 0], log2Scale: -5000, rotation: 1 }
    const deeper: Camera = { anchor, offset: [0, 0], log2Scale: -5000.3, rotation: 1.001 }
    const layout = planKeyframe(W, H, 1, 1, 4096, 4096)
    const r = reproject(W, H, deeper, deep, layout)
    const centre = applyReprojection(r, W / 2, H / 2)
    expect(centre[0]).toBeCloseTo(layout.width / 2, 6)
    expect(centre[1]).toBeCloseTo(layout.height / 2, 6)
    const corner = applyReprojection(r, W, H)
    expect(Number.isFinite(corner[0]) && Number.isFinite(corner[1])).toBe(true)
    // 0.3 doublings shallower: the screen maps to a smaller region of the keyframe.
    expect(Math.abs(corner[0] - layout.width / 2)).toBeLessThan(W / 2)
  })

  it('reconstructs the absolute centre for the CPU fallback', () => {
    const c = cameraCenter({ anchor: [1, 2], offset: [0.5, -0.5], log2Scale: 1, rotation: 0 })
    expect(c).toEqual([2, 1])
  })
})

describe('Tour.frameAt', () => {
  it('looks ahead without advancing and stays in the current scene', () => {
    const tour = new Tour(SCENES)
    tour.seek(10)
    const now = tour.frame()
    const ahead = tour.frameAt(0.5)
    expect(tour.frame()).toEqual(now)
    expect(ahead.log2Scale).toBeLessThan(now.log2Scale)
    expect(ahead.sceneIndex).toBe(now.sceneIndex)
    const far = tour.frameAt(1e6)
    expect(far.sceneIndex).toBe(now.sceneIndex)
    expect(Number.isFinite(far.log2Scale)).toBe(true)
    expect(far.brightness).toBe(1)
  })

  it('predicts the frame at a given scale consistently with time-based lookahead', () => {
    const tour = new Tour(SCENES)
    tour.seek(10)
    const ahead = tour.frameAt(3)
    const atScale = tour.frameAtLog2Scale(ahead.log2Scale)
    expect(atScale.log2Scale).toBeCloseTo(ahead.log2Scale, 9)
    expect(atScale.rotation).toBeCloseTo(ahead.rotation, 9)
    expect(atScale.offset[0]).toBeCloseTo(ahead.offset[0], 9)
    expect(atScale.offset[1]).toBeCloseTo(ahead.offset[1], 9)
    expect(atScale.maxIter).toBe(ahead.maxIter)
  })
})

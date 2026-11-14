import { describe, expect, it } from 'vitest'
import { resolutionStep } from '../src/render/renderer'
import { VISUALIZATIONS } from '../src/viz'
import { evalPalette, PaletteMixer, PALETTES } from '../src/viz/palette'

describe('visualizations', () => {
  it('have unique ids', () => {
    const ids = VISUALIZATIONS.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const viz of VISUALIZATIONS) {
    describe(viz.id, () => {
      it('defines the viz entry point and leaves main and precision to the prelude', () => {
        expect(viz.fragment).toMatch(/vec3\s+viz\s*\(\s*vec2\s+\w+\s*,\s*vec2\s+\w+\s*\)/)
        expect(viz.fragment).not.toMatch(/void\s+main\s*\(/)
        expect(viz.fragment).not.toMatch(/precision\s+\w+\s+float/)
      })

      it('declares every uniform it sets', () => {
        for (const name of Object.keys(viz.uniforms(1.5, 1 / 60))) {
          expect(viz.fragment).toMatch(new RegExp('uniform\\s+\\w+\\s+' + name + '\\s*;'))
        }
      })

      it('keeps uniforms bounded and finite after weeks of running', () => {
        for (const time of [0, 12.34, 3600, 86400 * 30 + 0.123]) {
          const values = viz.uniforms(time, 1 / 60)
          for (const name of Object.keys(values)) {
            const value = values[name]
            const list = typeof value === 'number' ? [value] : value
            expect(list.length).toBeGreaterThan(0)
            expect(list.length).toBeLessThanOrEqual(4)
            for (const x of list) {
              expect(Number.isFinite(x)).toBe(true)
              expect(Math.abs(x)).toBeLessThanOrEqual(1024)
            }
          }
        }
      })

      it('only samples the previous frame when it says so', () => {
        expect(/u_prev/.test(viz.fragment)).toBe(viz.feedback === true)
      })
    })
  }
})

describe('palettes', () => {
  it('are periodic with period 1 and stay in gamut', () => {
    for (const palette of PALETTES) {
      for (let i = 0; i < 50; i++) {
        const t = i / 50
        const a = evalPalette(palette, t)
        const b = evalPalette(palette, t + 1)
        for (let k = 0; k < 3; k++) {
          expect(a[k]).toBeCloseTo(b[k], 9)
          expect(a[k]).toBeGreaterThanOrEqual(-1e-9)
          expect(a[k]).toBeLessThanOrEqual(1 + 1e-9)
        }
      }
    }
  })

  it('crossfade to the selected palette', () => {
    const mixer = new PaletteMixer(PALETTES, 0, 2)
    mixer.select(2)
    expect(mixer.blend().mix).toBe(0)
    mixer.update(1)
    expect(mixer.blend().mix).toBeCloseTo(0.5)
    mixer.update(5)
    expect(mixer.blend()).toEqual({ from: PALETTES[0], to: PALETTES[2], mix: 1 })
  })
})

describe('resolutionStep', () => {
  it('picks the largest step the pixel budget covers', () => {
    expect(resolutionStep(1920, 1080, 1920 * 1080)).toBe(1)
    expect(resolutionStep(1920, 1080, 960 * 540)).toBe(0.5)
    expect(resolutionStep(1920, 1080, 960 * 540 - 1)).toBe(0.4)
    expect(resolutionStep(1920, 1080, 10)).toBeCloseTo(1 / 3)
  })
})

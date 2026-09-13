import { describe, expect, it } from 'vitest'
import { bakePaletteLut, evalPalette, mixVec3, palettePeriod, PALETTES, PaletteMixer } from '../src/scene/palette'

describe('evalPalette', () => {
  it('stays within displayable range across a full cycle for every palette', () => {
    for (const palette of PALETTES) {
      for (let t = 0; t <= 1; t += 0.01) {
        for (const channel of evalPalette(palette, t)) {
          expect(channel).toBeGreaterThanOrEqual(-1e-9)
          expect(channel).toBeLessThanOrEqual(1 + 1e-9)
        }
      }
    }
  })

  it('is periodic in t', () => {
    const a = evalPalette(PALETTES[0], 0.3)
    const b = evalPalette(PALETTES[0], 1.3)
    expect(a[0]).toBeCloseTo(b[0])
    expect(a[1]).toBeCloseTo(b[1])
    expect(a[2]).toBeCloseTo(b[2])
  })
})

describe('PaletteMixer', () => {
  it('crossfades from the old palette to the new one over the fade duration', () => {
    const mixer = new PaletteMixer(PALETTES, 0, 2)
    mixer.select(3)
    expect(mixer.blend()).toMatchObject({ from: PALETTES[0], to: PALETTES[3], mix: 0 })
    mixer.update(1)
    expect(mixer.blend().mix).toBeCloseTo(0.5)
    mixer.update(5)
    expect(mixer.blend().mix).toBe(1)
  })

  it('wraps when cycling past the end', () => {
    const mixer = new PaletteMixer(PALETTES, PALETTES.length - 1)
    mixer.cycle()
    expect(mixer.index).toBe(0)
    mixer.select(-1)
    expect(mixer.index).toBe(PALETTES.length - 1)
  })

  it('ignores reselecting the current palette so the fade is not restarted', () => {
    const mixer = new PaletteMixer(PALETTES, 2)
    mixer.select(2)
    expect(mixer.blend().mix).toBe(1)
  })
})

describe('palette lookup table', () => {
  it('finds the shared period of every cosine frequency in a blend', () => {
    const neon = PALETTES[3]
    const ember = PALETTES[0]
    expect(palettePeriod({ from: ember, to: ember, mix: 1 })).toBe(1)
    expect(palettePeriod({ from: ember, to: neon, mix: 0.5 })).toBe(10)
  })

  it('bakes the blend so the table wraps seamlessly and matches direct evaluation', () => {
    const blend = { from: PALETTES[0], to: PALETTES[3], mix: 0.3 }
    const period = palettePeriod(blend)
    const size = 4096
    const bytes = new Uint8Array(size * 4)
    bakePaletteLut(blend, period, size, bytes)
    for (const i of [0, 1, 777, size - 1]) {
      const t = (i * period) / size
      const rgb = mixVec3(evalPalette(blend.from, t), evalPalette(blend.to, t), blend.mix)
      for (let ch = 0; ch < 3; ch++) expect(Math.abs(bytes[i * 4 + ch] / 255 - rgb[ch])).toBeLessThan(1 / 255 + 1e-9)
      expect(bytes[i * 4 + 3]).toBe(255)
    }
    // The entry after the last one is entry 0 again: one full period exactly.
    const wrapped = mixVec3(evalPalette(blend.from, period), evalPalette(blend.to, period), blend.mix)
    for (let ch = 0; ch < 3; ch++) expect(Math.abs(bytes[ch] / 255 - wrapped[ch])).toBeLessThan(1 / 255 + 1e-9)
  })
})

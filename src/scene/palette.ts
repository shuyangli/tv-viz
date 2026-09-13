import { TWO_PI, type Vec2 } from './math'

export type Vec3 = readonly [number, number, number]

/** Cosine gradient palette (Inigo Quilez): color(t) = a + b * cos(2π (c t + d)). */
export interface Palette {
  readonly name: string
  readonly a: Vec3
  readonly b: Vec3
  readonly c: Vec3
  readonly d: Vec3
}

export const PALETTES: readonly Palette[] = [
  { name: 'Ember', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.1, 0.2] },
  { name: 'Spectrum', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.33, 0.67] },
  { name: 'Lagoon', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 0.5], d: [0.8, 0.9, 0.3] },
  { name: 'Neon', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 0.7, 0.4], d: [0, 0.15, 0.2] },
  { name: 'Glacier', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [2, 1, 0], d: [0.5, 0.2, 0.25] },
  { name: 'Candy', a: [0.8, 0.5, 0.4], b: [0.2, 0.4, 0.2], c: [2, 1, 1], d: [0, 0.25, 0.25] },
]

export function evalPalette(palette: Palette, t: number): Vec3 {
  const channel = (i: 0 | 1 | 2): number =>
    palette.a[i] + palette.b[i] * Math.cos(TWO_PI * (palette.c[i] * t + palette.d[i]))
  return [channel(0), channel(1), channel(2)]
}

export function mixVec3(x: Vec3, y: Vec3, t: number): Vec3 {
  return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]
}

export interface PaletteBlend {
  readonly from: Palette
  readonly to: Palette
  /** 0 shows `from`, 1 shows `to`. */
  readonly mix: number
}

const DEFAULT_CROSSFADE_SECONDS = 4

/** Holds the active palette and crossfades to a new one over a few seconds. */
export class PaletteMixer {
  private fromIndex: number
  private toIndex: number
  private mix = 1

  constructor(
    private readonly palettes: readonly Palette[] = PALETTES,
    startIndex = 0,
    private readonly crossfadeSeconds = DEFAULT_CROSSFADE_SECONDS,
  ) {
    this.fromIndex = startIndex
    this.toIndex = startIndex
  }

  get index(): number {
    return this.toIndex
  }

  get current(): Palette {
    return this.palettes[this.toIndex]
  }

  select(index: number): void {
    const wrapped = ((index % this.palettes.length) + this.palettes.length) % this.palettes.length
    if (wrapped === this.toIndex) return
    this.fromIndex = this.toIndex
    this.toIndex = wrapped
    this.mix = 0
  }

  cycle(): void {
    this.select(this.toIndex + 1)
  }

  update(dtSeconds: number): void {
    if (this.mix >= 1) return
    this.mix = Math.min(1, this.mix + dtSeconds / this.crossfadeSeconds)
  }

  blend(): PaletteBlend {
    return { from: this.palettes[this.fromIndex], to: this.palettes[this.toIndex], mix: this.mix }
  }
}

/**
 * Smallest integer period (in t) shared by every cosine frequency in the blend, so a
 * lookup table over one period tiles seamlessly. Frequencies here are multiples of 0.1,
 * so the search always succeeds; the fallback of 1 only matters for palettes added later.
 */
export function palettePeriod(blend: PaletteBlend, maxPeriod = 100): number {
  const freqs = [...blend.from.c, ...blend.to.c]
  for (let p = 1; p <= maxPeriod; p++) {
    if (freqs.every((c) => Math.abs(c * p - Math.round(c * p)) < 1e-6)) return p
  }
  return 1
}

/** Samples the blended palette over one period into RGBA bytes, for a 1-D lookup texture. */
export function bakePaletteLut(blend: PaletteBlend, period: number, size: number, out: Uint8Array): void {
  for (let i = 0; i < size; i++) {
    const t = (i * period) / size
    const rgb = mixVec3(evalPalette(blend.from, t), evalPalette(blend.to, t), blend.mix)
    out[i * 4] = toByte(rgb[0])
    out[i * 4 + 1] = toByte(rgb[1])
    out[i * 4 + 2] = toByte(rgb[2])
    out[i * 4 + 3] = 255
  }
}

function toByte(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
}

export type { Vec2 }

export type Vec3 = readonly [number, number, number]

/** Cosine gradient palette (Inigo Quilez): color(t) = a + b * cos(2π (c t + d)). */
export interface Palette {
  readonly name: string
  readonly a: Vec3
  readonly b: Vec3
  readonly c: Vec3
  readonly d: Vec3
}

/** One per colour key, in remote order: red, green, yellow, blue. Frequencies are integers so every palette has period 1. */
export const PALETTES: readonly Palette[] = [
  { name: 'Rainbow', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.33, 0.67] },
  { name: 'Acid', a: [0.5, 0.55, 0.5], b: [0.5, 0.45, 0.5], c: [2, 1, 1], d: [0.5, 0.2, 0.75] },
  { name: 'Sunshine', a: [0.85, 0.45, 0.35], b: [0.15, 0.45, 0.35], c: [1, 1, 2], d: [0, 0.15, 0.55] },
  { name: 'Blacklight', a: [0.45, 0.2, 0.6], b: [0.45, 0.2, 0.4], c: [1, 2, 1], d: [0.75, 0.1, 0.45] },
]

export function evalPalette(palette: Palette, t: number): Vec3 {
  const channel = (i: 0 | 1 | 2): number =>
    palette.a[i] + palette.b[i] * Math.cos(2 * Math.PI * (palette.c[i] * t + palette.d[i]))
  return [channel(0), channel(1), channel(2)]
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

  update(dtSeconds: number): void {
    if (this.mix >= 1) return
    this.mix = Math.min(1, this.mix + dtSeconds / this.crossfadeSeconds)
  }

  blend(): PaletteBlend {
    const s = this.mix * this.mix * (3 - 2 * this.mix)
    return { from: this.palettes[this.fromIndex], to: this.palettes[this.toIndex], mix: s }
  }
}

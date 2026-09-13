import type { Vec2 } from '../scene/math'
import type { PaletteBlend } from '../scene/palette'

export interface FrameParams {
  readonly center: Vec2
  readonly scale: number
  readonly rotation: number
  readonly maxIter: number
  readonly julia: boolean
  readonly seed: Vec2
  readonly palette: PaletteBlend
  /** Phase offset applied to the palette so colours drift over time. */
  readonly colorShift: number
  /** Iterations per full palette cycle. */
  readonly colorScale: number
  readonly brightness: number
  /** Escape count below which pixels fade to black, hiding the flat far field. */
  readonly farField: number
}

export interface Renderer {
  readonly kind: 'webgl' | 'cpu'
  setSize(width: number, height: number): void
  render(frame: FrameParams): void
}

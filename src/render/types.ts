import type { MisiurewiczPoint } from '../scene/misiurewicz'
import type { PaletteBlend } from '../scene/palette'
import type { Camera } from './keyframe'

export interface FrameParams extends Camera {
  readonly maxIter: number
  /** The dive's anchor point, whose orbit is the perturbation reference. */
  readonly reference: MisiurewiczPoint
  /** Identifies the scene run so a keyframe from before a cut is never shown after it. */
  readonly sceneId: number
  readonly palette: PaletteBlend
  /** Phase offset applied to the palette so colours drift over time. */
  readonly colorShift: number
  /** Iterations per full palette cycle. */
  readonly colorScale: number
  readonly brightness: number
  /** Escape count below which pixels fade to black, hiding the flat far field. */
  readonly farField: number
}

/** The camera at the moment the zoom reaches `log2Scale`, so a keyframe can be rendered for where it will be shown. */
export type Predict = (log2Scale: number) => FrameParams

export interface RenderBudget {
  /** Escape-time samples (texels times subsamples) the GPU may run per displayed frame. */
  readonly samplesPerFrame: number
  /** Doublings the zoom advances per displayed frame at the current speed; 0 while paused. */
  readonly doublingsPerFrame: number
  /** Pins keyframe density (relative to the screen) for measurement; null adapts. */
  readonly density: number | null
  /** Pins samples per texel for measurement; null adapts. */
  readonly samples: number | null
}

export interface RenderStats {
  readonly width: number
  readonly height: number
  readonly density: number
  readonly samples: number
  readonly rowsPerFrame: number
  /** Schedule index of the keyframe on screen and how far the newest one has faded in (1 = fully). */
  readonly index: number
  readonly blend: number
}

export interface Renderer {
  readonly kind: 'webgl' | 'cpu'
  setSize(width: number, height: number): void
  render(frame: FrameParams, predict: Predict, budget: RenderBudget): void
  readonly stats: RenderStats | null
}

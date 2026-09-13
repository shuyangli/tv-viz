import type { Vec2 } from '../scene/math'
import type { PaletteBlend } from '../scene/palette'

export interface FrameParams {
  readonly center: Vec2
  readonly scale: number
  readonly rotation: number
  readonly maxIter: number
  readonly julia: boolean
  readonly seed: Vec2
  /** Identifies the scene so a keyframe from a previous scene is never shown through a new camera. */
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

/** Where the camera will be `aheadSeconds` from now, so a keyframe can be rendered for the moment it will be shown. */
export type Predict = (aheadSeconds: number) => FrameParams

export interface RenderQuality {
  /** Keyframe texel density relative to the screen. */
  readonly scale: number
  /** Frames over which one keyframe is spread. */
  readonly tiles: number
}

export interface Renderer {
  readonly kind: 'webgl' | 'cpu'
  setSize(width: number, height: number): void
  setQuality(quality: RenderQuality): void
  render(frame: FrameParams, predict: Predict, frameSeconds: number): void
  /** Waits for the GPU after each frame and reports the time it took, for benchmarking; costs throughput. */
  setBenchmark(enabled: boolean): void
  readonly gpuMs: number | null
}

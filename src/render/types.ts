import type { MisiurewiczPoint } from '../scene/misiurewicz'
import type { Vec2 } from '../scene/math'
import type { PaletteBlend } from '../scene/palette'
import type { Camera } from './keyframe'

export interface FrameParams extends Camera {
  readonly maxIter: number
  readonly julia: boolean
  readonly seed: Vec2
  /** Reference orbit for a perturbation dive; null for Julia sets. */
  readonly reference: MisiurewiczPoint | null
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

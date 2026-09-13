import type { Vec2 } from '../scene/math'

export interface Camera {
  readonly center: Vec2
  readonly scale: number
  readonly rotation: number
}

/**
 * Texel grid of one keyframe. Rows are stored interleaved: fractal row y lives at
 * stored row (y mod tiles) * rowsPerTile + floor(y / tiles), so each tile (a contiguous
 * band of stored rows) samples the whole image and every tile costs about the same.
 */
export interface KeyframeLayout {
  readonly width: number
  readonly height: number
  readonly tiles: number
  readonly rowsPerTile: number
  /** Complex-plane distance between adjacent texel centres. */
  readonly unitsPerTexel: number
}

export interface Reprojection {
  /** Column-major 2x2 that maps screen pixel coordinates into keyframe texel coordinates. */
  readonly matrix: readonly [number, number, number, number]
  readonly offset: Vec2
}

/**
 * Plans a keyframe whose texel density is `resolutionScale` times the screen's at the
 * keyframe camera, and which covers a view of half-height `coverScale` (at least the
 * camera's scale, so zoom-outs and rotation have pixels to sample from).
 */
export function planKeyframe(
  screenWidth: number,
  screenHeight: number,
  resolutionScale: number,
  cameraScale: number,
  coverScale: number,
  tiles: number,
  maxWidth: number,
  maxHeight: number,
): KeyframeLayout {
  const unitsPerTexel = (2 * cameraScale) / (resolutionScale * screenHeight)
  const cover = Math.max(1, coverScale / cameraScale)
  const width = Math.max(1, Math.min(maxWidth, Math.ceil(resolutionScale * screenWidth * cover)))
  const rows = Math.ceil(resolutionScale * screenHeight * cover)
  const rowsPerTile = Math.max(1, Math.min(Math.floor(maxHeight / tiles), Math.ceil(rows / tiles)))
  return { width, height: rowsPerTile * tiles, tiles, rowsPerTile, unitsPerTexel }
}

export function storedRow(row: number, layout: KeyframeLayout): number {
  return (row % layout.tiles) * layout.rowsPerTile + Math.floor(row / layout.tiles)
}

export function fractalRow(stored: number, layout: KeyframeLayout): number {
  const tile = Math.floor(stored / layout.rowsPerTile)
  return (stored - tile * layout.rowsPerTile) * layout.tiles + tile
}

/**
 * Maps a screen pixel (gl_FragCoord, origin bottom-left) through the current camera into
 * the complex plane and back through the keyframe camera into keyframe texel coordinates.
 * Both cameras are similarity transforms, so the composition is affine and can be
 * evaluated exactly in the shader without touching complex-plane magnitudes, where
 * single precision would smear deep zooms.
 */
export function reproject(
  screenWidth: number,
  screenHeight: number,
  current: Camera,
  key: Camera,
  layout: KeyframeLayout,
): Reprojection {
  const unitsPerPixel = (2 * current.scale) / screenHeight
  const s = unitsPerPixel / layout.unitsPerTexel
  const theta = current.rotation - key.rotation
  const cs = Math.cos(theta) * s
  const sn = Math.sin(theta) * s
  const dx = current.center[0] - key.center[0]
  const dy = current.center[1] - key.center[1]
  const ck = Math.cos(key.rotation)
  const sk = Math.sin(key.rotation)
  const tx = (ck * dx + sk * dy) / layout.unitsPerTexel
  const ty = (-sk * dx + ck * dy) / layout.unitsPerTexel
  const halfW = screenWidth / 2
  const halfH = screenHeight / 2
  return {
    matrix: [cs, sn, -sn, cs],
    offset: [
      tx + layout.width / 2 - (cs * halfW - sn * halfH),
      ty + layout.height / 2 - (sn * halfW + cs * halfH),
    ],
  }
}

/** Screen pixel to keyframe texel, for tests and debugging. */
export function applyReprojection(r: Reprojection, x: number, y: number): Vec2 {
  const [a, b, c, d] = r.matrix
  return [a * x + c * y + r.offset[0], b * x + d * y + r.offset[1]]
}

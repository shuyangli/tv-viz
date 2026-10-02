import type { Vec2 } from '../scene/math'

/**
 * A camera is a similarity transform of the plane. Scale is kept as log2 so a zoom can
 * run for hours without underflowing, and the screen centre is expressed as an offset
 * from an anchor point in view units (half the viewport height = 1) so deep zooms never
 * subtract two nearly equal absolute coordinates.
 */
export interface Camera {
  readonly anchor: Vec2
  readonly offset: Vec2
  readonly log2Scale: number
  readonly rotation: number
}

/**
 * Texel grid of one keyframe. Rows are stored permuted: fractal row y lives at stored row
 * (y * rowStrideInv) mod height, so any run of consecutive stored rows is spread almost
 * evenly over the whole image and every slice of the render costs about the same.
 */
export interface KeyframeLayout {
  readonly width: number
  readonly height: number
  /** View units (of the keyframe camera) between adjacent texel centres. */
  readonly texelToView: number
  /** Stored row s holds fractal row (s * rowStride) mod height. */
  readonly rowStride: number
  readonly rowStrideInv: number
}

export interface Reprojection {
  /** Column-major 2x2 that maps screen pixel coordinates into keyframe texel coordinates. */
  readonly matrix: readonly [number, number, number, number]
  readonly offset: Vec2
}

const GOLDEN = (Math.sqrt(5) - 1) / 2

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

function modularInverse(a: number, m: number): number {
  let [oldR, r] = [a, m]
  let [oldS, s] = [1, 0]
  while (r !== 0) {
    const q = Math.floor(oldR / r)
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  return ((oldS % m) + m) % m
}

/**
 * Multiplier near height / golden ratio that is coprime with the height, so stored rows
 * taken in order visit fractal rows as a low-discrepancy sequence, and its inverse.
 */
export function rowPermutation(height: number): { stride: number; inverse: number } {
  if (height <= 2) return { stride: 1, inverse: 1 }
  const target = Math.round(height * GOLDEN)
  for (let delta = 0; delta < height; delta++) {
    for (const stride of [target - delta, target + delta]) {
      if (stride > 1 && stride < height && gcd(stride, height) === 1) {
        return { stride, inverse: modularInverse(stride, height) }
      }
    }
  }
  return { stride: 1, inverse: 1 }
}

/**
 * Plans a keyframe whose texel density is `density` times the screen's at the keyframe
 * camera and whose extent is `cover` times the screen, so the zoom can show it minified
 * a little while it fades in and rotation or drift have pixels to sample.
 */
export function planKeyframe(
  screenWidth: number,
  screenHeight: number,
  density: number,
  cover: number,
  maxWidth: number,
  maxHeight: number,
): KeyframeLayout {
  const texelToView = 2 / (density * screenHeight)
  const width = Math.max(1, Math.min(maxWidth, Math.ceil(density * screenWidth * cover)))
  const height = Math.max(1, Math.min(maxHeight, Math.ceil(density * screenHeight * cover)))
  const { stride, inverse } = rowPermutation(height)
  return { width, height, texelToView, rowStride: stride, rowStrideInv: inverse }
}

export function storedRow(row: number, layout: KeyframeLayout): number {
  return (row * layout.rowStrideInv) % layout.height
}

export function fractalRow(stored: number, layout: KeyframeLayout): number {
  return (stored * layout.rowStride) % layout.height
}

/**
 * Maps a screen pixel (gl_FragCoord, origin bottom-left) through the current camera into
 * the plane and back through the keyframe camera into keyframe texel coordinates. Both
 * cameras are similarities, so the composition is affine. Everything is computed in view
 * units and log2 ratios, so it stays exact at any depth as long as both cameras share
 * an anchor; keyframes from a different anchor are never presented.
 */
export function reproject(
  screenWidth: number,
  screenHeight: number,
  current: Camera,
  key: Camera,
  layout: KeyframeLayout,
): Reprojection {
  const ratio = Math.pow(2, current.log2Scale - key.log2Scale)
  const s = ((2 / screenHeight) * ratio) / layout.texelToView
  const theta = current.rotation - key.rotation
  const cs = Math.cos(theta) * s
  const sn = Math.sin(theta) * s
  const ck = Math.cos(key.rotation)
  const sk = Math.sin(key.rotation)
  // Screen-centre offset from the anchor, in keyframe view units, then into texels.
  let dx = current.offset[0] * ratio - key.offset[0]
  let dy = current.offset[1] * ratio - key.offset[1]
  if (current.anchor[0] !== key.anchor[0] || current.anchor[1] !== key.anchor[1]) {
    const keyScale = Math.pow(2, key.log2Scale)
    dx += (current.anchor[0] - key.anchor[0]) / keyScale
    dy += (current.anchor[1] - key.anchor[1]) / keyScale
  }
  const tx = (ck * dx + sk * dy) / layout.texelToView
  const ty = (-sk * dx + ck * dy) / layout.texelToView
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

/** Absolute plane coordinates of a camera's screen centre; loses precision at depth and is for the CPU fallback and tests only. */
export function cameraCenter(camera: Camera): Vec2 {
  const scale = Math.pow(2, camera.log2Scale)
  return [camera.anchor[0] + camera.offset[0] * scale, camera.anchor[1] + camera.offset[1] * scale]
}

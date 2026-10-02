import type { Formula } from '../scene/formula'
import { smoothstep, type Vec2 } from '../scene/math'
import { evalPalette, mixVec3 } from '../scene/palette'
import { cameraCenter } from './keyframe'
import type { FrameParams, Renderer } from './types'

/** Escape-time rendering in JavaScript is slow, so the fallback works at a small fixed size and lets the canvas upscale it. */
const CPU_WIDTH = 320
const BAILOUT_SQ = 256

/**
 * Last-resort renderer when WebGL is unavailable. Same maths as the direct shader, minus
 * the vignette, iterating from absolute coordinates; dives therefore lose detail once
 * they pass double-precision depth.
 */
export class CpuRenderer implements Renderer {
  readonly kind = 'cpu'
  private readonly ctx: CanvasRenderingContext2D
  private readonly buffer: HTMLCanvasElement
  private readonly bufferCtx: CanvasRenderingContext2D
  private image: ImageData

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.buffer = document.createElement('canvas')
    const bufferCtx = this.buffer.getContext('2d')
    if (!bufferCtx) throw new Error('2d context unavailable')
    this.bufferCtx = bufferCtx
    this.image = bufferCtx.createImageData(1, 1)
    this.setSize(canvas.width || CPU_WIDTH, canvas.height || CPU_WIDTH)
  }

  readonly stats = null

  setSize(width: number, height: number): void {
    this.canvas.width = width
    this.canvas.height = height
    const bufferHeight = Math.max(1, Math.round((CPU_WIDTH * height) / Math.max(width, 1)))
    this.buffer.width = CPU_WIDTH
    this.buffer.height = bufferHeight
    this.image = this.bufferCtx.createImageData(CPU_WIDTH, bufferHeight)
  }

  render(frame: FrameParams): void {
    const { width, height } = this.buffer
    const data = this.image.data
    const cs = Math.cos(frame.rotation)
    const sn = Math.sin(frame.rotation)
    const scale = Math.pow(2, frame.log2Scale)
    const center = cameraCenter(frame)
    const formula = frame.reference.formula
    let offset = 0
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const ux = ((px + 0.5 - width / 2) / height) * 2 * scale
        const uy = ((height / 2 - (py + 0.5)) / height) * 2 * scale
        const c: [number, number] = [center[0] + ux * cs - uy * sn, center[1] + ux * sn + uy * cs]
        const n = escapeTime(formula, c, frame.maxIter)
        if (n < 0) {
          data[offset++] = 0
          data[offset++] = 0
          data[offset++] = 0
          data[offset++] = 255
          continue
        }
        const t = n / frame.colorScale + frame.colorShift
        const fade = Math.pow(smoothstep(n / frame.farField), 1.6) * frame.brightness
        const rgb = mixVec3(
          evalPalette(frame.palette.from, t),
          evalPalette(frame.palette.to, t),
          frame.palette.mix,
        )
        data[offset++] = clampByte(rgb[0] * fade)
        data[offset++] = clampByte(rgb[1] * fade)
        data[offset++] = clampByte(rgb[2] * fade)
        data[offset++] = 255
      }
    }
    this.bufferCtx.putImageData(this.image, 0, 0)
    this.ctx.imageSmoothingEnabled = true
    this.ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height)
  }
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
}

/** Smoothed escape iteration of c under the formula from z = 0, or -1 for points that never escape. */
export function escapeTime(formula: Formula, c: Vec2, maxIter: number): number {
  let z: Vec2 = [0, 0]
  for (let i = 0; i < maxIter; i++) {
    z = formula.step(z, c)
    const m = z[0] * z[0] + z[1] * z[1]
    if (m > BAILOUT_SQ) return Math.max(0, i + 2 - Math.log2(Math.log2(m)) / Math.log2(formula.degree))
  }
  return -1
}

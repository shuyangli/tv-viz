import { smoothstep } from '../scene/math'
import { evalPalette, mixVec3 } from '../scene/palette'
import type { FrameParams, Renderer } from './types'

/** Escape-time rendering in JavaScript is slow, so the fallback works at a small fixed size and lets the canvas upscale it. */
const CPU_WIDTH = 320
const BAILOUT_SQ = 256
const TRAP_COLOR_SCALE = 1.5
const INTERIOR_BRIGHTNESS = 0.7

/** Last-resort renderer when WebGL is unavailable. Same maths as the shader, minus the vignette. */
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
    let offset = 0
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const ux = ((px + 0.5 - width / 2) / height) * 2 * frame.scale
        const uy = ((height / 2 - (py + 0.5)) / height) * 2 * frame.scale
        const x = frame.center[0] + ux * cs - uy * sn
        const y = frame.center[1] + ux * sn + uy * cs
        const orbit = frame.julia
          ? escapeTime(x, y, frame.seed[0], frame.seed[1], frame.maxIter)
          : escapeTime(0, 0, x, y, frame.maxIter)
        const n = orbit.n
        let t: number
        let fade: number
        if (n < 0 && !frame.julia) {
          data[offset++] = 0
          data[offset++] = 0
          data[offset++] = 0
          data[offset++] = 255
          continue
        } else if (n < 0) {
          t = orbit.trap * TRAP_COLOR_SCALE + frame.colorShift
          fade = INTERIOR_BRIGHTNESS * smoothstep(orbit.trap / 0.3) * frame.brightness
        } else {
          t = n / frame.colorScale + frame.colorShift
          fade = Math.pow(smoothstep(n / frame.farField), 1.6) * frame.brightness
        }
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

export interface Orbit {
  /** Smoothed escape iteration, or -1 for points that never escape. */
  readonly n: number
  /** Closest the orbit came to the origin, used to shade Julia interiors. */
  readonly trap: number
}

export function escapeTime(zx0: number, zy0: number, cx: number, cy: number, maxIter: number): Orbit {
  let zx = zx0
  let zy = zy0
  let trap = Infinity
  for (let i = 0; i < maxIter; i++) {
    const nextX = zx * zx - zy * zy + cx
    const nextY = 2 * zx * zy + cy
    zx = nextX
    zy = nextY
    const xx = zx * zx
    const yy = zy * zy
    trap = Math.min(trap, xx + yy)
    if (xx + yy > BAILOUT_SQ) {
      return { n: Math.max(0, i + 2 - Math.log2(Math.log2(xx + yy))), trap: Math.sqrt(trap) }
    }
  }
  return { n: -1, trap: Math.sqrt(trap) }
}

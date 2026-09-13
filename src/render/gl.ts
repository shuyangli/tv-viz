import type { Vec2 } from '../scene/math'
import { bakePaletteLut, palettePeriod, type PaletteBlend } from '../scene/palette'
import { planKeyframe, reproject, type Camera, type KeyframeLayout } from './keyframe'
import { keyframeShaderSource, presentShaderSource, VERTEX_SHADER } from './shaders'
import type { FrameParams, Predict, Renderer, RenderQuality } from './types'

const KEYFRAME_UNIFORMS = [
  'u_center',
  'u_rot',
  'u_unitsPerTexel',
  'u_texCenter',
  'u_maxIter',
  'u_seed',
  'u_tile',
  'u_rowsPerTile',
  'u_tiles',
] as const

const PRESENT_UNIFORMS = [
  'u_key',
  'u_lut',
  'u_texSizeInv',
  'u_keyMax',
  'u_rowsPerTile',
  'u_tiles',
  'u_map',
  'u_offset',
  'u_resolutionInv',
  'u_julia',
  'u_colorShift',
  'u_colorScaleInv',
  'u_lutPeriodInv',
  'u_brightness',
  'u_farField',
] as const

type Uniforms<Names extends readonly string[]> = Record<Names[number], WebGLUniformLocation | null>

interface Program<Names extends readonly string[]> {
  readonly program: WebGLProgram
  readonly uniforms: Uniforms<Names>
}

interface Programs {
  readonly mandelbrot: Program<typeof KEYFRAME_UNIFORMS>
  readonly julia: Program<typeof KEYFRAME_UNIFORMS>
  readonly present: Program<typeof PRESENT_UNIFORMS>
}

interface Target {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  readonly width: number
  readonly height: number
}

interface Keyframe {
  readonly camera: Camera
  readonly layout: KeyframeLayout
  readonly sceneId: number
  readonly julia: boolean
  readonly maxIter: number
  readonly seed: Vec2
  readonly target: Target
  /** Next tile to render; equals layout.tiles once complete. */
  tile: number
}

/** Two triangles' worth of clip space from a single oversized triangle. */
const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3])

/**
 * Keyframes are allocated once at this multiple of the canvas so a zooming-out camera has
 * pixels beyond the screen edge to sample. Per-keyframe cover beyond this is clamped.
 */
const MAX_COVER = 1.1
/** Extra half-extent, on top of the predicted zoom range, for rotation and drift. */
const COVER_MARGIN = 0.02
const MAX_TILES_ALLOCATED = 16
/**
 * Entries in the palette lookup texture, spanning one full period of the blend. A cosine
 * of frequency 2 over a 10-unit period still gets ~200 samples per cycle.
 */
const LUT_SIZE = 4096

export const DEFAULT_QUALITY: RenderQuality = { scale: 0.5, tiles: 4 }
const BENCH_PIXEL = new Uint8Array(4)

interface PaletteLut {
  readonly texture: WebGLTexture
  readonly bytes: Uint8Array
  from: string
  to: string
  mix: number
  period: number
}

/**
 * WebGL1 renderer that decouples escape-time computation from display. The expensive
 * fractal pass renders into an offscreen keyframe spread over several frames; every
 * displayed frame reprojects the newest complete keyframe through the current camera
 * and applies the palette, so motion stays at the display rate while the GPU spends
 * only a fraction of a fractal per frame.
 */
export class GlRenderer implements Renderer {
  readonly kind = 'webgl'
  private programs: Programs | null = null
  private targets: readonly [Target, Target] | null = null
  private front: Keyframe | null = null
  private back: Keyframe | null = null
  private lut: PaletteLut | null = null
  private quality: RenderQuality = DEFAULT_QUALITY
  private viewportWidth = 1
  private viewportHeight = 1
  private contextLost = false
  private benchmark = false
  private _gpuMs: number | null = null

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
  ) {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.contextLost = true
      this.programs = null
      this.targets = null
      this.lut = null
      this.front = null
      this.back = null
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false
      this.programs = this.buildPrograms()
      this.lut = this.createLut()
      this.allocateTargets()
    })
    this.programs = this.buildPrograms()
    this.lut = this.createLut()
    this.probeRenderToTexture()
  }

  static create(canvas: HTMLCanvasElement): GlRenderer | null {
    const attrs: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }
    const gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs)
    if (!gl || !(gl instanceof WebGLRenderingContext)) return null
    try {
      return new GlRenderer(canvas, gl)
    } catch {
      return null
    }
  }

  /** Viewport size. Keyframes are planned against it; the canvas itself follows the keyframe density. */
  setSize(width: number, height: number): void {
    this.viewportWidth = width
    this.viewportHeight = height
    this.applyCanvasSize()
    this.allocateTargets()
  }

  setQuality(quality: RenderQuality): void {
    this.quality = {
      scale: Math.max(0.05, Math.min(1, quality.scale)),
      tiles: Math.max(1, Math.min(MAX_TILES_ALLOCATED, Math.round(quality.tiles))),
    }
    this.applyCanvasSize()
  }

  /**
   * Presenting at more than the keyframe's density would only bilinearly magnify the
   * same data, at a per-pixel cost the TV GPU cannot spare; the compositor's upscale of
   * the canvas does the same job for free.
   */
  private applyCanvasSize(): void {
    const width = Math.max(1, Math.round(this.viewportWidth * this.quality.scale))
    const height = Math.max(1, Math.round(this.viewportHeight * this.quality.scale))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
  }

  /** Size of the keyframe currently on screen, for diagnostics. */
  get keyframeSize(): Vec2 | null {
    return this.front ? [this.front.layout.width, this.front.layout.height] : null
  }

  setBenchmark(enabled: boolean): void {
    this.benchmark = enabled
    if (!enabled) this._gpuMs = null
  }

  /** Smoothed GPU time per frame, only while benchmarking. */
  get gpuMs(): number | null {
    return this._gpuMs
  }

  render(frame: FrameParams, predict: Predict, frameSeconds: number): void {
    if (this.contextLost || !this.programs || !this.targets || !this.lut) return
    const start = this.benchmark ? performance.now() : 0
    this.advanceKeyframe(frame, predict, frameSeconds)
    this.updateLut(frame.palette)
    this.present(frame)
    if (this.benchmark) {
      // finish() returns before the GPU is done on webOS Chromium, and a readback of the
      // default framebuffer waits for the swap chain as well; reading a texel of the
      // offscreen target drains the in-order queue without either.
      const { gl } = this
      gl.bindFramebuffer(gl.FRAMEBUFFER, (this.front || (this.back as Keyframe)).target.framebuffer)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, BENCH_PIXEL)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const elapsed = performance.now() - start
      this._gpuMs = this._gpuMs === null ? elapsed : this._gpuMs + (elapsed - this._gpuMs) * 0.1
    }
  }

  private advanceKeyframe(frame: FrameParams, predict: Predict, frameSeconds: number): void {
    let back = this.back
    if (back && back.sceneId !== frame.sceneId) back = null
    if (!back) back = this.beginKeyframe(predict, frameSeconds)
    this.renderTile(back)
    back.tile += 1
    if (back.tile >= back.layout.tiles) {
      this.front = back
      this.back = null
    } else {
      this.back = back
    }
  }

  private beginKeyframe(predict: Predict, frameSeconds: number): Keyframe {
    const targets = this.targets as readonly [Target, Target]
    const { tiles, scale } = this.quality
    // Tiles render over frames t .. t+k-1 and the result is shown from t+k to t+2k-1.
    const first = predict(tiles * frameSeconds)
    const mid = predict((1.5 * tiles - 0.5) * frameSeconds)
    const last = predict((2 * tiles - 1) * frameSeconds)
    const coverScale = Math.max(first.scale, mid.scale, last.scale) * (1 + COVER_MARGIN)
    const target = this.front && this.front.target === targets[0] ? targets[1] : targets[0]
    const layout = planKeyframe(
      this.viewportWidth,
      this.viewportHeight,
      scale,
      mid.scale,
      coverScale,
      tiles,
      target.width,
      target.height,
    )
    return {
      camera: { center: mid.center, scale: mid.scale, rotation: mid.rotation },
      layout,
      sceneId: mid.sceneId,
      julia: mid.julia,
      maxIter: mid.maxIter,
      seed: mid.seed,
      target,
      tile: 0,
    }
  }

  private renderTile(key: Keyframe): void {
    const { gl } = this
    const programs = this.programs as Programs
    const prog = key.julia ? programs.julia : programs.mandelbrot
    const u = prog.uniforms
    const { layout } = key
    gl.bindFramebuffer(gl.FRAMEBUFFER, key.target.framebuffer)
    gl.viewport(0, 0, layout.width, layout.height)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(0, key.tile * layout.rowsPerTile, layout.width, layout.rowsPerTile)
    gl.useProgram(prog.program)
    gl.uniform2f(u.u_center, key.camera.center[0], key.camera.center[1])
    gl.uniform2f(u.u_rot, Math.cos(key.camera.rotation), Math.sin(key.camera.rotation))
    gl.uniform1f(u.u_unitsPerTexel, layout.unitsPerTexel)
    gl.uniform2f(u.u_texCenter, layout.width / 2, layout.height / 2)
    gl.uniform1i(u.u_maxIter, key.maxIter)
    gl.uniform2f(u.u_seed, key.seed[0], key.seed[1])
    gl.uniform1f(u.u_tile, key.tile)
    gl.uniform1f(u.u_rowsPerTile, layout.rowsPerTile)
    gl.uniform1f(u.u_tiles, layout.tiles)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disable(gl.SCISSOR_TEST)
  }

  private present(frame: FrameParams): void {
    const { gl, canvas } = this
    const programs = this.programs as Programs
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    const key = this.front
    if (!key || key.sceneId !== frame.sceneId) {
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      return
    }
    const u = programs.present.uniforms
    const lut = this.lut as PaletteLut
    const { layout } = key
    const map = reproject(canvas.width, canvas.height, frame, key.camera, layout)
    gl.useProgram(programs.present.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, key.target.texture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, lut.texture)
    gl.uniform1i(u.u_key, 0)
    gl.uniform1i(u.u_lut, 1)
    gl.uniform2f(u.u_texSizeInv, 1 / key.target.width, 1 / key.target.height)
    gl.uniform2f(u.u_keyMax, layout.width - 1, layout.height - 1)
    gl.uniform1f(u.u_rowsPerTile, layout.rowsPerTile)
    gl.uniform1f(u.u_tiles, layout.tiles)
    gl.uniformMatrix2fv(u.u_map, false, map.matrix as unknown as Float32List)
    gl.uniform2f(u.u_offset, map.offset[0], map.offset[1])
    gl.uniform2f(u.u_resolutionInv, 1 / canvas.width, 1 / canvas.height)
    gl.uniform1i(u.u_julia, frame.julia ? 1 : 0)
    // The shift only ever enters the periodic table, so wrapping it keeps precision as it grows.
    gl.uniform1f(u.u_colorShift, frame.colorShift % lut.period)
    gl.uniform1f(u.u_colorScaleInv, 1 / frame.colorScale)
    gl.uniform1f(u.u_lutPeriodInv, 1 / lut.period)
    gl.uniform1f(u.u_brightness, frame.brightness)
    gl.uniform1f(u.u_farField, frame.farField)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private createLut(): PaletteLut {
    const { gl } = this
    const texture = gl.createTexture()
    if (!texture) throw new Error('createTexture failed')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    return { texture, bytes: new Uint8Array(LUT_SIZE * 4), from: '', to: '', mix: -1, period: 1 }
  }

  /** Re-bakes the table only while a crossfade is changing it; colour drift is a shift applied at lookup. */
  private updateLut(blend: PaletteBlend): void {
    const lut = this.lut as PaletteLut
    if (lut.from === blend.from.name && lut.to === blend.to.name && lut.mix === blend.mix) return
    lut.from = blend.from.name
    lut.to = blend.to.name
    lut.mix = blend.mix
    lut.period = palettePeriod(blend)
    bakePaletteLut(blend, lut.period, LUT_SIZE, lut.bytes)
    const { gl } = this
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, lut.texture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut.bytes)
  }

  private allocateTargets(): void {
    if (this.contextLost) return
    if (this.targets) {
      for (const t of this.targets) {
        this.gl.deleteFramebuffer(t.framebuffer)
        this.gl.deleteTexture(t.texture)
      }
    }
    const width = Math.ceil(this.viewportWidth * MAX_COVER)
    const height = Math.ceil(this.viewportHeight * MAX_COVER) + MAX_TILES_ALLOCATED
    this.targets = [this.createTarget(width, height), this.createTarget(width, height)]
    this.front = null
    this.back = null
  }

  /** Fails construction, and so falls back to the CPU renderer, where RGBA8 render-to-texture is unsupported. */
  private probeRenderToTexture(): void {
    const probe = this.createTarget(1, 1)
    this.gl.deleteFramebuffer(probe.framebuffer)
    this.gl.deleteTexture(probe.texture)
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
  }

  private createTarget(width: number, height: number): Target {
    const { gl } = this
    const texture = gl.createTexture()
    const framebuffer = gl.createFramebuffer()
    if (!texture || !framebuffer) throw new Error('createTexture/createFramebuffer failed')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: ' + status)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { texture, framebuffer, width, height }
  }

  private buildPrograms(): Programs {
    const { gl } = this
    const vertex = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER)
    const programs: Programs = {
      mandelbrot: this.link(vertex, keyframeShaderSource(false), KEYFRAME_UNIFORMS),
      julia: this.link(vertex, keyframeShaderSource(true), KEYFRAME_UNIFORMS),
      present: this.link(vertex, presentShaderSource(), PRESENT_UNIFORMS),
    }

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW)
    // All programs declare the same single attribute, so it is bound once for all of them.
    const position = gl.getAttribLocation(programs.present.program, 'a_position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    return programs
  }

  private link<Names extends readonly string[]>(
    vertex: WebGLShader,
    fragmentSource: string,
    names: Names,
  ): Program<Names> {
    const { gl } = this
    const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource)
    const program = gl.createProgram()
    if (!program) throw new Error('createProgram failed')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.bindAttribLocation(program, 0, 'a_position')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(program))
    }
    const uniforms = {} as Uniforms<Names>
    for (const name of names) {
      uniforms[name as Names[number]] = gl.getUniformLocation(program, name)
    }
    return { program, uniforms }
  }

  private compile(type: number, source: string): WebGLShader {
    const { gl } = this
    const shader = gl.createShader(type)
    if (!shader) throw new Error('createShader failed')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader))
    }
    return shader
  }
}

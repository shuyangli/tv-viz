import { TWO_PI, type Vec2 } from '../scene/math'
import { perturbationConstants, type MisiurewiczPoint, type PerturbationConstants } from '../scene/misiurewicz'
import { bakePaletteLut, palettePeriod, type PaletteBlend } from '../scene/palette'
import { directIterations, HANDOFF_BITS, MAX_ITERATIONS, MIN_SKIP_DEPTH, OVERVIEW_SCALE } from '../scene/quality'
import { cameraCenter, planKeyframe, reproject, type Camera, type KeyframeLayout } from './keyframe'
import { directShaderSource, diveShaderSource, presentShaderSource, VERTEX_SHADER } from './shaders'
import type { FrameParams, Predict, Renderer, RenderQuality } from './types'

const TILE_UNIFORMS = ['u_tile', 'u_rowsPerTile', 'u_tiles', 'u_texCenter', 'u_rot'] as const

const DIRECT_UNIFORMS = [...TILE_UNIFORMS, 'u_center', 'u_unitsPerTexel', 'u_maxIter', 'u_seed', 'u_nRange'] as const

const DIVE_UNIFORMS = [
  ...TILE_UNIFORMS,
  'u_offset',
  'u_texelToView',
  'u_k0',
  'u_mant',
  'u_j0',
  'u_log2Mag0',
  'u_phase0',
  'u_nBase',
  'u_nRange',
  'u_maxIter',
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
  'u_nRange',
  'u_nBase',
  'u_nBaseWrapped',
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
  readonly vertex: WebGLShader
  readonly julia: Program<typeof DIRECT_UNIFORMS>
  readonly mandelbrot: Program<typeof DIRECT_UNIFORMS>
  readonly present: Program<typeof PRESENT_UNIFORMS>
}

interface DiveProgram {
  readonly program: Program<typeof DIVE_UNIFORMS>
  readonly constants: PerturbationConstants
}

interface Target {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  readonly width: number
  readonly height: number
}

/** Per-keyframe inputs to the closed-form skip in the dive shader. */
interface Skip {
  readonly k0: number
  readonly mant: number
  readonly j0: number
  readonly log2Mag0: number
  readonly phase0: number
}

interface Keyframe {
  readonly camera: Camera
  readonly layout: KeyframeLayout
  readonly sceneId: number
  readonly julia: boolean
  /** Perturbation only pays off deep in a dive; shallower views use the direct shader. */
  readonly perturbed: boolean
  readonly maxIter: number
  readonly seed: Vec2
  readonly reference: MisiurewiczPoint | null
  readonly skip: Skip | null
  /** Iteration count the stored values are relative to, and their half-range. */
  readonly nBase: number
  readonly nRange: number
  readonly target: Target
  /** Next tile to render; equals layout.tiles once complete. */
  tile: number
}

/** Two triangles' worth of clip space from a single oversized triangle. */
const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3])

/**
 * Keyframes are allocated once at this multiple of the viewport so a zooming-out camera
 * has pixels beyond the screen edge to sample. Per-keyframe cover beyond this is clamped.
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
 * only a fraction of a fractal per frame. Dives use a perturbation shader compiled per
 * Misiurewicz point, so zoom depth is unbounded.
 */
export class GlRenderer implements Renderer {
  readonly kind = 'webgl'
  private programs: Programs | null = null
  /** null marks a point whose shader this GPU's compiler rejected; such dives present black instead of crashing the loop. */
  private readonly divePrograms = new Map<MisiurewiczPoint, DiveProgram | null>()
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
      this.divePrograms.clear()
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
    const coverLog2 = Math.max(first.log2Scale, mid.log2Scale, last.log2Scale) + Math.log2(1 + COVER_MARGIN)
    const target = this.front && this.front.target === targets[0] ? targets[1] : targets[0]
    const layout = planKeyframe(
      this.viewportWidth,
      this.viewportHeight,
      scale,
      mid.log2Scale,
      coverLog2,
      tiles,
      target.width,
      target.height,
    )
    const camera: Camera = { anchor: mid.anchor, offset: mid.offset, log2Scale: mid.log2Scale, rotation: mid.rotation }
    let skip: Skip | null = null
    let nBase = 0
    let nRange = MAX_ITERATIONS
    let maxIter = mid.maxIter
    const depth = Math.log2(OVERVIEW_SCALE) - camera.log2Scale
    const perturbed = mid.reference !== null && depth >= MIN_SKIP_DEPTH
    const dive = perturbed && mid.reference ? this.diveProgram(mid.reference) : null
    if (mid.reference && dive) {
      const { constants } = dive
      skip = planSkip(camera.log2Scale, constants)
      const point = mid.reference
      nBase = skip.j0 >= 1 ? point.preperiod + skip.j0 * point.period : 0
      nRange = point.preperiod + mid.maxIter + point.period * (12 / constants.log2Lambda + 2)
    } else if (mid.reference) {
      maxIter = directIterations(depth)
    }
    return {
      camera,
      layout,
      sceneId: mid.sceneId,
      julia: mid.julia,
      perturbed,
      maxIter,
      seed: mid.seed,
      reference: mid.reference,
      skip,
      nBase,
      nRange,
      target,
      tile: 0,
    }
  }

  private renderTile(key: Keyframe): void {
    const { gl } = this
    const programs = this.programs as Programs
    const { layout, camera } = key
    gl.bindFramebuffer(gl.FRAMEBUFFER, key.target.framebuffer)
    gl.viewport(0, 0, layout.width, layout.height)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(0, key.tile * layout.rowsPerTile, layout.width, layout.rowsPerTile)
    const setTile = (u: Uniforms<typeof TILE_UNIFORMS>): void => {
      gl.uniform1f(u.u_tile, key.tile)
      gl.uniform1f(u.u_rowsPerTile, layout.rowsPerTile)
      gl.uniform1f(u.u_tiles, layout.tiles)
      gl.uniform2f(u.u_texCenter, layout.width / 2, layout.height / 2)
      gl.uniform2f(u.u_rot, Math.cos(camera.rotation), Math.sin(camera.rotation))
    }
    const dive = key.perturbed && key.reference ? this.diveProgram(key.reference) : null
    if (key.perturbed && !dive) {
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.disable(gl.SCISSOR_TEST)
      return
    }
    if (dive && key.skip) {
      const { program } = dive
      const u = program.uniforms
      gl.useProgram(program.program)
      setTile(u)
      gl.uniform2f(u.u_offset, camera.offset[0], camera.offset[1])
      gl.uniform1f(u.u_texelToView, layout.texelToView)
      gl.uniform1i(u.u_k0, key.skip.k0)
      gl.uniform1f(u.u_mant, key.skip.mant)
      gl.uniform1f(u.u_j0, key.skip.j0)
      gl.uniform1f(u.u_log2Mag0, key.skip.log2Mag0)
      gl.uniform1f(u.u_phase0, key.skip.phase0)
      gl.uniform1f(u.u_nBase, key.nBase)
      gl.uniform1f(u.u_nRange, key.nRange)
      gl.uniform1i(u.u_maxIter, key.maxIter)
    } else {
      const direct = key.julia ? programs.julia : programs.mandelbrot
      const u = direct.uniforms
      gl.useProgram(direct.program)
      setTile(u)
      const center = cameraCenter(camera)
      gl.uniform2f(u.u_center, center[0], center[1])
      gl.uniform1f(u.u_unitsPerTexel, layout.texelToView * Math.pow(2, camera.log2Scale))
      gl.uniform1i(u.u_maxIter, key.maxIter)
      gl.uniform2f(u.u_seed, key.seed[0], key.seed[1])
      gl.uniform1f(u.u_nRange, key.nRange)
    }
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
    gl.uniform1f(u.u_nRange, key.nRange)
    gl.uniform1f(u.u_nBase, key.nBase)
    // The palette is periodic in n, so only the base count modulo that period matters.
    gl.uniform1f(u.u_nBaseWrapped, key.nBase % (frame.colorScale * lut.period))
    // The shift only ever enters the periodic table, so wrapping it keeps precision as it grows.
    gl.uniform1f(u.u_colorShift, frame.colorShift % lut.period)
    gl.uniform1f(u.u_colorScaleInv, 1 / frame.colorScale)
    gl.uniform1f(u.u_lutPeriodInv, 1 / lut.period)
    gl.uniform1f(u.u_brightness, frame.brightness)
    gl.uniform1f(u.u_farField, frame.farField)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** Dive programs are compiled on first use of a point (hidden by the fade-in) and kept for the session. */
  private diveProgram(point: MisiurewiczPoint): DiveProgram | null {
    const cached = this.divePrograms.get(point)
    if (cached !== undefined) return cached
    const programs = this.programs as Programs
    let built: DiveProgram | null = null
    try {
      built = {
        program: this.link(programs.vertex, diveShaderSource(point), DIVE_UNIFORMS),
        constants: perturbationConstants(point),
      }
    } catch (error) {
      console.error('Dive shader rejected for ' + point.c[0] + ', ' + point.c[1] + ': ' + String(error))
    }
    this.divePrograms.set(point, built)
    return built
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
      vertex,
      julia: this.link(vertex, directShaderSource(true), DIRECT_UNIFORMS),
      mandelbrot: this.link(vertex, directShaderSource(false), DIRECT_UNIFORMS),
      present: this.link(vertex, presentShaderSource(), PRESENT_UNIFORMS),
    }
    this.divePrograms.clear()

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW)
    // All programs bind the same single attribute to location 0, so it is set up once.
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
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

/**
 * Splits the keyframe scale into mantissa and power-of-two exponent and picks the number
 * of reference cycles a pixel one view unit from the anchor can skip before its offset
 * reaches 2^-HANDOFF_BITS. The shader adjusts per pixel from there using only the
 * pixel's log2 distance, so no absolute magnitude ever leaves single precision.
 */
export function planSkip(log2Scale: number, constants: PerturbationConstants): Skip {
  const k0 = -Math.floor(log2Scale)
  const mant = Math.pow(2, log2Scale + k0)
  const base = constants.log2P + Math.log2(mant) - k0
  const j0 = Math.floor((-HANDOFF_BITS - base) / constants.log2Lambda)
  const phase = (j0 * constants.argLambda + constants.argP) % TWO_PI
  return { k0, mant, j0, log2Mag0: j0 * constants.log2Lambda + base, phase0: phase < 0 ? phase + TWO_PI : phase }
}

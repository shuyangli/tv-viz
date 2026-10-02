import type { Formula } from '../scene/formula'
import { TWO_PI } from '../scene/math'
import { perturbationConstants, type MisiurewiczPoint, type PerturbationConstants } from '../scene/misiurewicz'
import { bakePaletteLut, palettePeriod, type PaletteBlend } from '../scene/palette'
import { depthOf, directIterations, handoffBits, MAX_ITERATIONS, MIN_SKIP_DEPTH } from '../scene/quality'
import { cameraCenter, planKeyframe, reproject, type Camera, type KeyframeLayout } from './keyframe'
import {
  dissolveWeight,
  framesUntilDue,
  KEYFRAME_COVER,
  KEYFRAME_SPACING,
  MAX_DENSITY,
  nextKeyframeIndex,
  planQuality,
  scheduleU,
} from './schedule'
import { bakeShaderSource, directShaderSource, diveShaderSource, presentShaderSource, VERTEX_SHADER } from './shaders'
import type { FrameParams, Predict, RenderBudget, Renderer, RenderStats } from './types'

const SAMPLING_UNIFORMS = ['u_rowStride', 'u_rows', 'u_texCenter', 'u_rot', 'u_samples'] as const

const DIRECT_UNIFORMS = [...SAMPLING_UNIFORMS, 'u_center', 'u_unitsPerTexel', 'u_maxIter', 'u_nRange'] as const

const DIVE_UNIFORMS = [
  ...SAMPLING_UNIFORMS,
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

const BAKE_UNIFORMS = [
  'u_key',
  'u_lut',
  'u_texSizeInv',
  'u_rows',
  'u_rowStrideInv',
  'u_n',
  'u_colorShift',
  'u_colorScaleInv',
  'u_lutPeriodInv',
  'u_farField',
] as const

const KEYFRAME_UNIFORM_NAMES = ['u_col', 'u_size', 'u_map', 'u_offset'] as const

const PRESENT_UNIFORMS = [
  'u_texSizeInv',
  'u_resolutionInv',
  'u_brightness',
  'u_blend',
  ...KEYFRAME_UNIFORM_NAMES.map((n) => n + 'A'),
  ...KEYFRAME_UNIFORM_NAMES.map((n) => n + 'B'),
] as const

type Uniforms<Names extends readonly string[]> = Record<Names[number], WebGLUniformLocation | null>

interface Program<Names extends readonly string[]> {
  readonly program: WebGLProgram
  readonly uniforms: Uniforms<Names>
}

interface Programs {
  readonly vertex: WebGLShader
  readonly bake: Program<typeof BAKE_UNIFORMS>
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
  /** Position in the schedule; the camera scale is the first keyframe's minus index * KEYFRAME_SPACING. */
  readonly index: number
  readonly camera: Camera
  readonly layout: KeyframeLayout
  readonly density: number
  readonly samples: number
  readonly sceneId: number
  /** Perturbation only pays off deep in a dive; shallower views use the direct shader. */
  readonly perturbed: boolean
  readonly maxIter: number
  readonly reference: MisiurewiczPoint
  readonly skip: Skip | null
  /** Iteration count the stored values are relative to, and their half-range. */
  readonly nBase: number
  readonly nRange: number
  /** Packed escape data; released once the keyframe is no longer the newest. */
  data: Target | null
  /** Baked colour, in natural row order; assigned when the render completes. */
  colour: Target | null
  /** Stored rows rendered so far; equals layout.height once complete. */
  rows: number
  /** Fractional rows carried between frames. */
  rowDebt: number
  /** Colour rows baked since the render completed, or the next row of the rolling re-bake. */
  bakedRows: number
  /** Schedule position at which the keyframe started fading in. */
  readyU: number
}

/** Two triangles' worth of clip space from a single oversized triangle. */
const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3])

/** Escape data lives for the keyframe being rendered and the newest shown one; colour for the two on screen. */
const DATA_TARGETS = 2
const COLOUR_TARGETS = 2
/** Frames over which a finished keyframe is baked to colour before it can be shown. */
const BAKE_FRAMES = 4
/** Fraction of the newest keyframe re-baked every frame so palette drift and palette changes keep flowing. */
const REBAKE_FRACTION = 1 / 16
/**
 * Entries in the palette lookup texture, spanning one full period of the blend. A cosine
 * of frequency 2 over a 10-unit period still gets ~200 samples per cycle.
 */
const LUT_SIZE = 4096
/** The first keyframe of a scene is planned slightly ahead of the camera so it is at about screen density when it lands. */
const FIRST_KEYFRAME_LEAD = 0.02

interface PaletteLut {
  readonly texture: WebGLTexture
  readonly bytes: Uint8Array
  from: string
  to: string
  mix: number
  period: number
}

/**
 * WebGL1 renderer that decouples escape-time computation from display. Keyframes are
 * planned along the zoom, one every KEYFRAME_SPACING doublings, and each is rendered
 * offscreen a few rows per frame over the seconds before it is due, then baked to colour.
 * Every displayed frame reprojects the newest keyframe through the current camera (and,
 * while a new one fades in, the one before it) with a single filtered tap each, so motion
 * stays at the display rate, the GPU spends a bounded slice of each frame on the fractal,
 * and the sampling noise of chaotic regions holds still between refreshes instead of
 * re-rolling. Dives use a perturbation shader compiled per Misiurewicz point, so zoom
 * depth is unbounded.
 */
export class GlRenderer implements Renderer {
  readonly kind = 'webgl'
  private programs: Programs | null = null
  /** null marks a point whose shader this GPU's compiler rejected; such dives present black instead of crashing the loop. */
  private readonly divePrograms = new Map<MisiurewiczPoint, DiveProgram | null>()
  private readonly directPrograms = new Map<Formula, Program<typeof DIRECT_UNIFORMS>>()
  private dataTargets: readonly Target[] | null = null
  private colourTargets: readonly Target[] | null = null
  /** Camera scale of keyframe 0 of the current scene. */
  private log2Start: number | null = null
  /** Fading out; released once the newest keyframe reaches full weight. */
  private previous: Keyframe | null = null
  /** Fading in or fully shown; re-baked continuously. */
  private newest: Keyframe | null = null
  /** Rendered, waiting for a colour target (the previous dissolve must end first) or being baked. */
  private pending: Keyframe | null = null
  private rendering: Keyframe | null = null
  private lut: PaletteLut | null = null
  private viewportWidth = 1
  private viewportHeight = 1
  private canvasDensity = 0
  private rowsPerFrame = 0
  private lastBlend = 1
  private contextLost = false

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
  ) {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.contextLost = true
      this.programs = null
      this.divePrograms.clear()
      this.directPrograms.clear()
      this.dataTargets = null
      this.colourTargets = null
      this.lut = null
      this.dropKeyframes()
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
    this.allocateTargets()
  }

  /**
   * Presenting at more than the keyframe's density would only magnify the same data at a
   * per-pixel cost the TV GPU cannot spare; the compositor's upscale of the canvas does
   * the same job for free.
   */
  private applyCanvasSize(density: number): void {
    const d = Math.min(1, density)
    if (d === this.canvasDensity) return
    this.canvasDensity = d
    const width = Math.max(1, Math.round(this.viewportWidth * d))
    const height = Math.max(1, Math.round(this.viewportHeight * d))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
  }

  get stats(): RenderStats | null {
    const key = this.rendering || this.pending || this.newest
    if (!key) return null
    return {
      width: key.layout.width,
      height: key.layout.height,
      density: key.density,
      samples: key.samples,
      rowsPerFrame: this.rowsPerFrame,
      index: this.newest ? this.newest.index : -1,
      blend: this.lastBlend,
    }
  }

  render(frame: FrameParams, predict: Predict, budget: RenderBudget): void {
    if (this.contextLost || !this.programs || !this.dataTargets || !this.colourTargets || !this.lut) return
    if (this.newest && this.newest.sceneId !== frame.sceneId) this.dropKeyframes()
    if (this.rendering && this.rendering.sceneId !== frame.sceneId) this.rendering = null
    if (this.pending && this.pending.sceneId !== frame.sceneId) this.pending = null
    if (this.log2Start === null) this.log2Start = frame.log2Scale - FIRST_KEYFRAME_LEAD
    const u = scheduleU(this.log2Start, frame.log2Scale)
    this.updateLut(frame.palette)
    this.advance(u, frame, predict, budget)
    this.present(frame, u)
  }

  private dropKeyframes(): void {
    this.previous = null
    this.newest = null
    this.pending = null
    this.rendering = null
    this.log2Start = null
  }

  /** Moves the keyframe pipeline along by one frame: retire, bake, promote, plan, render a slice. */
  private advance(u: number, frame: FrameParams, predict: Predict, budget: RenderBudget): void {
    if (this.previous && this.newest && dissolveWeight(u, this.newest.index, this.newest.readyU) >= 1) {
      this.previous = null
    }
    const pending = this.pending
    if (pending) {
      if (!pending.colour) pending.colour = this.freeTarget(this.colourTargets as readonly Target[], (k) => k.colour)
      if (pending.colour) {
        const rows = Math.ceil(pending.layout.height / BAKE_FRAMES)
        this.bake(pending, pending.bakedRows, rows, frame)
        pending.bakedRows += rows
        if (pending.bakedRows >= pending.layout.height) this.promote(pending, u)
      }
    }
    if (this.newest && this.newest.data && this.newest.colour) {
      // Rolling re-bake: the palette drifts and may be switched, and this keeps the shown
      // keyframe within a fraction of a second of it without ever re-rendering.
      const key = this.newest
      const rows = Math.ceil(key.layout.height * REBAKE_FRACTION)
      const from = key.bakedRows % key.layout.height
      this.bake(key, from, rows, frame)
      key.bakedRows = from + rows
    }
    if (!this.rendering && !this.pending) this.rendering = this.beginKeyframe(u, frame, predict, budget)
    const key = this.rendering
    if (!key) return
    this.renderSlice(key, budget)
    if (key.rows >= key.layout.height) {
      this.rendering = null
      key.bakedRows = 0
      this.pending = key
    }
  }

  private freeTarget(targets: readonly Target[], pick: (k: Keyframe) => Target | null): Target | null {
    const busy: (Target | null)[] = []
    for (const k of [this.previous, this.newest, this.pending, this.rendering]) if (k) busy.push(pick(k))
    for (const t of targets) if (busy.indexOf(t) < 0) return t
    return null
  }

  private promote(key: Keyframe, u: number): void {
    this.pending = null
    if (this.newest) this.newest.data = null
    this.previous = this.newest
    this.newest = key
    key.readyU = u
    key.bakedRows = 0
  }

  /** Plans the next keyframe into a free data target, or returns null while both are still in use. */
  private beginKeyframe(u: number, frame: FrameParams, predict: Predict, budget: RenderBudget): Keyframe | null {
    const data = this.freeTarget(this.dataTargets as readonly Target[], (k) => k.data)
    if (!data) return null
    const first = this.newest === null
    const sequential = this.newest ? this.newest.index + 1 : 0
    const frames = framesUntilDue(sequential, u, budget.doublingsPerFrame)
    const screenTexels = this.viewportWidth * this.viewportHeight * KEYFRAME_COVER * KEYFRAME_COVER
    const quality = planQuality(budget.samplesPerFrame, frames, screenTexels, {
      density: budget.density,
      samples: budget.samples,
    })
    const density = Math.min(MAX_DENSITY, quality.density)
    const layout = planKeyframe(this.viewportWidth, this.viewportHeight, density, KEYFRAME_COVER, data.width, data.height)
    const renderUnits =
      ((layout.width * layout.height * quality.samples) / budget.samplesPerFrame) *
      (budget.doublingsPerFrame / KEYFRAME_SPACING)
    const index = nextKeyframeIndex(this.newest ? this.newest.index : null, u, renderUnits)
    const log2Scale = (this.log2Start as number) - index * KEYFRAME_SPACING
    const at = first ? frame : predict(log2Scale)
    const camera: Camera = { anchor: at.anchor, offset: at.offset, log2Scale, rotation: at.rotation }
    let skip: Skip | null = null
    let nBase = 0
    let nRange = MAX_ITERATIONS
    let maxIter = at.maxIter
    const depth = depthOf(at.reference, camera.log2Scale)
    const perturbed = depth >= MIN_SKIP_DEPTH
    const dive = perturbed ? this.diveProgram(at.reference) : null
    if (dive) {
      const { constants } = dive
      const point = at.reference
      skip = planSkip(camera.log2Scale, constants, handoffBits(point))
      nBase = skip.j0 >= 1 ? point.preperiod + skip.j0 * point.period : 0
      nRange = point.preperiod + at.maxIter + point.period * (12 / constants.log2Lambda + 2)
    } else {
      maxIter = directIterations(depth)
    }
    return {
      index,
      camera,
      layout,
      density,
      samples: quality.samples,
      sceneId: frame.sceneId,
      perturbed,
      maxIter,
      reference: at.reference,
      skip,
      nBase,
      nRange,
      data,
      colour: null,
      rows: 0,
      rowDebt: 0,
      bakedRows: 0,
      readyU: 0,
    }
  }

  /** Renders the next run of stored rows, sized so the frame spends about the budgeted number of samples. */
  private renderSlice(key: Keyframe, budget: RenderBudget): void {
    const { gl } = this
    const { layout, camera } = key
    const data = key.data as Target
    this.rowsPerFrame = Math.max(1, budget.samplesPerFrame / (layout.width * key.samples))
    key.rowDebt += this.rowsPerFrame
    const rows = Math.min(layout.height - key.rows, Math.max(1, Math.floor(key.rowDebt)))
    key.rowDebt -= rows
    gl.bindFramebuffer(gl.FRAMEBUFFER, data.framebuffer)
    gl.viewport(0, 0, layout.width, layout.height)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(0, key.rows, layout.width, rows)
    key.rows += rows
    const setSampling = (u: Uniforms<typeof SAMPLING_UNIFORMS>): void => {
      gl.uniform1f(u.u_rowStride, layout.rowStride)
      gl.uniform1f(u.u_rows, layout.height)
      gl.uniform2f(u.u_texCenter, layout.width / 2, layout.height / 2)
      gl.uniform2f(u.u_rot, Math.cos(camera.rotation), Math.sin(camera.rotation))
      gl.uniform1i(u.u_samples, key.samples)
    }
    const dive = key.perturbed ? this.diveProgram(key.reference) : null
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
      setSampling(u)
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
      const direct = this.directProgram(key.reference.formula)
      const u = direct.uniforms
      gl.useProgram(direct.program)
      setSampling(u)
      const center = cameraCenter(camera)
      gl.uniform2f(u.u_center, center[0], center[1])
      gl.uniform1f(u.u_unitsPerTexel, layout.texelToView * Math.pow(2, camera.log2Scale))
      gl.uniform1i(u.u_maxIter, key.maxIter)
      gl.uniform1f(u.u_nRange, key.nRange)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disable(gl.SCISSOR_TEST)
  }

  /** Bakes colour rows [from, from + count) of a keyframe from its escape data with the current palette. */
  private bake(key: Keyframe, from: number, count: number, frame: FrameParams): void {
    const { gl } = this
    const programs = this.programs as Programs
    const lut = this.lut as PaletteLut
    const data = key.data as Target
    const colour = key.colour as Target
    const { layout } = key
    const rows = Math.min(count, layout.height - from)
    if (rows <= 0) return
    const u = programs.bake.uniforms
    gl.bindFramebuffer(gl.FRAMEBUFFER, colour.framebuffer)
    gl.viewport(0, 0, layout.width, layout.height)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(0, from, layout.width, rows)
    gl.useProgram(programs.bake.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, data.texture)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, lut.texture)
    gl.uniform1i(u.u_key, 0)
    gl.uniform1i(u.u_lut, 2)
    gl.uniform2f(u.u_texSizeInv, 1 / data.width, 1 / data.height)
    gl.uniform1f(u.u_rows, layout.height)
    gl.uniform1f(u.u_rowStrideInv, layout.rowStrideInv)
    // The palette is periodic in n, so only the base count modulo that period matters.
    gl.uniform3f(u.u_n, key.nRange, key.nBase, key.nBase % (frame.colorScale * lut.period))
    // The shift only ever enters the periodic table, so wrapping it keeps precision as it grows.
    gl.uniform1f(u.u_colorShift, frame.colorShift % lut.period)
    gl.uniform1f(u.u_colorScaleInv, 1 / frame.colorScale)
    gl.uniform1f(u.u_lutPeriodInv, 1 / lut.period)
    gl.uniform1f(u.u_farField, frame.farField)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disable(gl.SCISSOR_TEST)
  }

  private present(frame: FrameParams, u: number): void {
    const { gl, canvas } = this
    const programs = this.programs as Programs
    const key = this.newest
    if (key) this.applyCanvasSize(key.density)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    if (!key || !key.colour) {
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      return
    }
    const uni = programs.present.uniforms
    const targets = this.colourTargets as readonly Target[]
    gl.useProgram(programs.present.program)
    gl.uniform2f(uni.u_texSizeInv, 1 / targets[0].width, 1 / targets[0].height)
    gl.uniform2f(uni.u_resolutionInv, 1 / canvas.width, 1 / canvas.height)
    gl.uniform1f(uni.u_brightness, frame.brightness)
    const previous = this.previous && this.previous.colour ? this.previous : null
    const blend = previous ? dissolveWeight(u, key.index, key.readyU) : 1
    this.lastBlend = blend
    gl.uniform1f(uni.u_blend, blend)
    this.bindKeyframe(key, 'A', 0, frame)
    this.bindKeyframe(previous && blend < 1 ? previous : key, 'B', 1, frame)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private bindKeyframe(key: Keyframe, suffix: 'A' | 'B', unit: number, frame: FrameParams): void {
    const { gl, canvas } = this
    const u = (this.programs as Programs).present.uniforms as Record<string, WebGLUniformLocation | null>
    const { layout } = key
    const map = reproject(canvas.width, canvas.height, frame, key.camera, layout)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, (key.colour as Target).texture)
    gl.uniform1i(u['u_col' + suffix], unit)
    gl.uniform2f(u['u_size' + suffix], layout.width, layout.height)
    gl.uniformMatrix2fv(u['u_map' + suffix], false, map.matrix as unknown as Float32List)
    gl.uniform2f(u['u_offset' + suffix], map.offset[0], map.offset[1])
  }

  private directProgram(formula: Formula): Program<typeof DIRECT_UNIFORMS> {
    const cached = this.directPrograms.get(formula)
    if (cached) return cached
    const programs = this.programs as Programs
    const built = this.link(programs.vertex, directShaderSource(formula), DIRECT_UNIFORMS)
    this.directPrograms.set(formula, built)
    return built
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
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, lut.texture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut.bytes)
  }

  private allocateTargets(): void {
    if (this.contextLost) return
    for (const list of [this.dataTargets, this.colourTargets]) {
      if (!list) continue
      for (const t of list) {
        this.gl.deleteFramebuffer(t.framebuffer)
        this.gl.deleteTexture(t.texture)
      }
    }
    const width = Math.ceil(this.viewportWidth * MAX_DENSITY * KEYFRAME_COVER)
    const height = Math.ceil(this.viewportHeight * MAX_DENSITY * KEYFRAME_COVER)
    const data: Target[] = []
    for (let i = 0; i < DATA_TARGETS; i++) data.push(this.createTarget(width, height, false))
    const colour: Target[] = []
    for (let i = 0; i < COLOUR_TARGETS; i++) colour.push(this.createTarget(width, height, true))
    this.dataTargets = data
    this.colourTargets = colour
    this.dropKeyframes()
    this.canvasDensity = 0
  }

  /** Fails construction, and so falls back to the CPU renderer, where RGBA8 render-to-texture is unsupported. */
  private probeRenderToTexture(): void {
    const probe = this.createTarget(1, 1, false)
    this.gl.deleteFramebuffer(probe.framebuffer)
    this.gl.deleteTexture(probe.texture)
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
  }

  /** Packed escape data must be fetched exactly; baked colour is filtered by the hardware. */
  private createTarget(width: number, height: number, filtered: boolean): Target {
    const { gl } = this
    const texture = gl.createTexture()
    const framebuffer = gl.createFramebuffer()
    if (!texture || !framebuffer) throw new Error('createTexture/createFramebuffer failed')
    const filter = filtered ? gl.LINEAR : gl.NEAREST
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
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
      bake: this.link(vertex, bakeShaderSource(), BAKE_UNIFORMS),
      present: this.link(vertex, presentShaderSource(), PRESENT_UNIFORMS),
    }
    this.divePrograms.clear()
    this.directPrograms.clear()

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
 * reaches 2^-handoff. The shader adjusts per pixel from there using only the
 * pixel's log2 distance, so no absolute magnitude ever leaves single precision.
 */
export function planSkip(log2Scale: number, constants: PerturbationConstants, handoff: number): Skip {
  const k0 = -Math.floor(log2Scale)
  const mant = Math.pow(2, log2Scale + k0)
  const base = constants.log2P + Math.log2(mant) - k0
  const j0 = Math.floor((-handoff - base) / constants.log2Lambda)
  const phase = (j0 * constants.argLambda + constants.argP) % TWO_PI
  return { k0, mant, j0, log2Mag0: j0 * constants.log2Lambda + base, phase0: phase < 0 ? phase + TWO_PI : phase }
}

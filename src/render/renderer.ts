import { fragmentSource, PRESENT_SHADER, VERTEX_SHADER } from '../viz/glsl'
import type { PaletteBlend } from '../viz/palette'
import type { UniformValue, Visualization } from '../viz/types'

export interface Frame {
  readonly viz: Visualization
  /** Scene seconds at the current speed, and their advance since the last frame. */
  readonly time: number
  readonly dt: number
  readonly palette: PaletteBlend
  /** Added to every palette phase so colours rotate slowly; wrapped by the caller. */
  readonly paletteDrift: number
  /** Weight of the live scene over the frozen last frame of the one before it. */
  readonly blend: number
  readonly brightness: number
  /** Pixels the scene shader may shade this frame. */
  readonly pixels: number
}

export interface RenderStats {
  readonly width: number
  readonly height: number
}

/**
 * Render heights as fractions of the viewport. Coarse steps keep reallocation rare, and
 * the soft gradients these scenes are made of survive the compositor's upscale well.
 */
const RESOLUTION_STEPS = [1 / 3, 0.4, 0.5, 0.6, 2 / 3, 0.8, 1]

export function resolutionStep(viewportWidth: number, viewportHeight: number, pixels: number): number {
  let best = RESOLUTION_STEPS[0]
  for (const step of RESOLUTION_STEPS) {
    if (Math.round(viewportWidth * step) * Math.round(viewportHeight * step) <= pixels) best = step
  }
  return best
}

const FRAMEWORK_UNIFORMS = [
  'u_resolution',
  'u_aspect',
  'u_prev',
  'u_palA',
  'u_palB',
  'u_palC',
  'u_palD',
  'u_pal2A',
  'u_pal2B',
  'u_pal2C',
  'u_pal2D',
  'u_palMix',
] as const

const PRESENT_UNIFORMS = ['u_from', 'u_to', 'u_blend', 'u_brightness', 'u_noise'] as const

type Locations = Record<string, WebGLUniformLocation | null>

interface Program {
  readonly program: WebGLProgram
  readonly uniforms: Locations
}

interface Target {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  width: number
  height: number
}

/** Two triangles' worth of clip space from a single oversized triangle. */
const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3])

/** The live frame, the one before it (read by feedback scenes), and the outgoing scene's last frame. */
const TARGETS = 3

/**
 * Draws the scene into an offscreen target at whatever resolution the budget affords,
 * then presents it to a canvas of the same size; the compositor's upscale to the panel
 * costs nothing, whereas a 1080p present pass is the dearest per-pixel work on the TV.
 */
export class Renderer {
  private vertex: WebGLShader | null = null
  private present: Program | null = null
  /** null marks a scene whose shader this GPU's compiler rejected; it presents black instead of stopping the loop. */
  private readonly programs = new Map<Visualization, Program | null>()
  private targets: Target[] = []
  /** Indices into `targets`. */
  private front = 0
  private back = 1
  private frozen = 2
  private current: Visualization | null = null
  private viewportWidth = 1
  private viewportHeight = 1
  private contextLost = false
  private frameCount = 0

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
  ) {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.contextLost = true
      this.programs.clear()
      this.targets = []
      this.present = null
      this.vertex = null
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false
      this.init()
    })
    this.init()
  }

  static create(canvas: HTMLCanvasElement): Renderer | null {
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
      return new Renderer(canvas, gl)
    } catch (error) {
      console.error(String(error))
      return null
    }
  }

  setSize(width: number, height: number): void {
    this.viewportWidth = width
    this.viewportHeight = height
  }

  get stats(): RenderStats {
    return { width: this.canvas.width, height: this.canvas.height }
  }

  /** Compiles a scene ahead of its first frame; returns false if the GPU rejects it. */
  prepare(viz: Visualization): boolean {
    return this.programFor(viz) !== null
  }

  render(frame: Frame): void {
    if (this.contextLost || !this.present) return
    const gl = this.gl
    const step = resolutionStep(this.viewportWidth, this.viewportHeight, frame.pixels)
    const width = Math.max(1, Math.round(this.viewportWidth * step))
    const height = Math.max(1, Math.round(this.viewportHeight * step))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height

    if (frame.viz !== this.current) {
      if (this.current !== null) {
        const outgoing = this.front
        this.front = this.frozen
        this.frozen = outgoing
      }
      this.clear(this.targets[this.front])
      this.current = frame.viz
    }

    const target = this.targets[this.back]
    this.resize(target, width, height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, width, height)
    const scene = this.programFor(frame.viz)
    if (scene) {
      gl.useProgram(scene.program)
      this.setFrameworkUniforms(scene.uniforms, frame, width, height)
      const values = frame.viz.uniforms(frame.time, frame.dt)
      for (const name of Object.keys(values)) this.setUniform(scene, name, values[name])
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.targets[this.front].texture)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    } else {
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    const shown = this.back
    this.back = this.front
    this.front = shown

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.present.program)
    const u = this.present.uniforms
    const dissolving = frame.blend < 1
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.targets[dissolving ? this.frozen : this.front].texture)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.front].texture)
    gl.uniform1i(u.u_to, 0)
    gl.uniform1i(u.u_from, 1)
    gl.uniform1f(u.u_blend, frame.blend)
    gl.uniform1f(u.u_brightness, frame.brightness)
    this.frameCount = (this.frameCount + 1) % 64
    gl.uniform2f(u.u_noise, this.frameCount * 17, this.frameCount * 29)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private init(): void {
    const gl = this.gl
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    this.vertex = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER)
    this.present = this.link(PRESENT_SHADER, PRESENT_UNIFORMS)
    this.targets = []
    for (let i = 0; i < TARGETS; i++) this.targets.push(this.createTarget())
    this.front = 0
    this.back = 1
    this.frozen = 2
    this.current = null
  }

  private createTarget(): Target {
    const gl = this.gl
    const texture = gl.createTexture()
    const framebuffer = gl.createFramebuffer()
    if (!texture || !framebuffer) throw new Error('could not allocate a render target')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('render-to-texture is unavailable')
    }
    const target = { texture, framebuffer, width: 1, height: 1 }
    this.clear(target)
    return target
  }

  private resize(target: Target, width: number, height: number): void {
    if (target.width === width && target.height === height) return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, target.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    target.width = width
    target.height = height
  }

  private clear(target: Target): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  private setFrameworkUniforms(u: Locations, frame: Frame, width: number, height: number): void {
    const gl = this.gl
    const { from, to, mix } = frame.palette
    const k = frame.paletteDrift
    gl.uniform2f(u.u_resolution, width, height)
    gl.uniform1f(u.u_aspect, width / height)
    gl.uniform1i(u.u_prev, 0)
    gl.uniform3f(u.u_palA, to.a[0], to.a[1], to.a[2])
    gl.uniform3f(u.u_palB, to.b[0], to.b[1], to.b[2])
    gl.uniform3f(u.u_palC, to.c[0], to.c[1], to.c[2])
    gl.uniform3f(u.u_palD, to.d[0] + k, to.d[1] + k, to.d[2] + k)
    gl.uniform3f(u.u_pal2A, from.a[0], from.a[1], from.a[2])
    gl.uniform3f(u.u_pal2B, from.b[0], from.b[1], from.b[2])
    gl.uniform3f(u.u_pal2C, from.c[0], from.c[1], from.c[2])
    gl.uniform3f(u.u_pal2D, from.d[0] + k, from.d[1] + k, from.d[2] + k)
    gl.uniform1f(u.u_palMix, 1 - mix)
  }

  private setUniform(scene: Program, name: string, value: UniformValue): void {
    const gl = this.gl
    let location = scene.uniforms[name]
    if (location === undefined) {
      location = gl.getUniformLocation(scene.program, name)
      scene.uniforms[name] = location
    }
    if (location === null) return
    if (typeof value === 'number') gl.uniform1f(location, value)
    else if (value.length === 2) gl.uniform2f(location, value[0], value[1])
    else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2])
    else if (value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3])
  }

  private programFor(viz: Visualization): Program | null {
    const cached = this.programs.get(viz)
    if (cached !== undefined) return cached
    let program: Program | null = null
    try {
      program = this.link(fragmentSource(viz.fragment), FRAMEWORK_UNIFORMS)
    } catch (error) {
      console.error('[' + viz.id + '] ' + String(error))
    }
    this.programs.set(viz, program)
    return program
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl
    const shader = gl.createShader(type)
    if (!shader) throw new Error('could not create a shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error('shader compile failed: ' + log)
    }
    return shader
  }

  private link(fragment: string, uniformNames: readonly string[]): Program {
    const gl = this.gl
    if (!this.vertex) throw new Error('renderer is not initialised')
    const shader = this.compile(gl.FRAGMENT_SHADER, fragment)
    const program = gl.createProgram()
    if (!program) throw new Error('could not create a program')
    gl.attachShader(program, this.vertex)
    gl.attachShader(program, shader)
    gl.bindAttribLocation(program, 0, 'a_position')
    gl.linkProgram(program)
    gl.deleteShader(shader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error('program link failed: ' + log)
    }
    const uniforms: Locations = {}
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name)
    return { program, uniforms }
  }
}

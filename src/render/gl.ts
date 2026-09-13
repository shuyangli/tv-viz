import type { Vec3 } from '../scene/palette'
import { fragmentShaderSource, VERTEX_SHADER, type FloatPrecision } from './shaders'
import type { FrameParams, Renderer } from './types'

const UNIFORM_NAMES = [
  'u_resolution',
  'u_center',
  'u_scale',
  'u_rotation',
  'u_maxIter',
  'u_julia',
  'u_seed',
  'u_palA',
  'u_palB',
  'u_palC',
  'u_palD',
  'u_pal2A',
  'u_pal2B',
  'u_pal2C',
  'u_pal2D',
  'u_palMix',
  'u_colorShift',
  'u_colorScale',
  'u_brightness',
  'u_farField',
] as const

type UniformName = (typeof UNIFORM_NAMES)[number]
type Uniforms = Record<UniformName, WebGLUniformLocation | null>

interface Program {
  readonly program: WebGLProgram
  readonly uniforms: Uniforms
}

/** Two triangles' worth of clip space from a single oversized triangle. */
const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3])

export class GlRenderer implements Renderer {
  readonly kind = 'webgl'
  private program: Program | null = null
  private contextLost = false

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
  ) {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.contextLost = true
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false
      this.program = this.buildProgram()
    })
    this.program = this.buildProgram()
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

  setSize(width: number, height: number): void {
    this.canvas.width = width
    this.canvas.height = height
    this.gl.viewport(0, 0, width, height)
  }

  render(frame: FrameParams): void {
    const { gl, program } = this
    if (this.contextLost || !program) return
    const u = program.uniforms
    gl.useProgram(program.program)
    gl.uniform2f(u.u_resolution, this.canvas.width, this.canvas.height)
    gl.uniform2f(u.u_center, frame.center[0], frame.center[1])
    gl.uniform1f(u.u_scale, frame.scale)
    gl.uniform1f(u.u_rotation, frame.rotation)
    gl.uniform1f(u.u_maxIter, frame.maxIter)
    gl.uniform1i(u.u_julia, frame.julia ? 1 : 0)
    gl.uniform2f(u.u_seed, frame.seed[0], frame.seed[1])
    this.setVec3(u.u_palA, frame.palette.from.a)
    this.setVec3(u.u_palB, frame.palette.from.b)
    this.setVec3(u.u_palC, frame.palette.from.c)
    this.setVec3(u.u_palD, frame.palette.from.d)
    this.setVec3(u.u_pal2A, frame.palette.to.a)
    this.setVec3(u.u_pal2B, frame.palette.to.b)
    this.setVec3(u.u_pal2C, frame.palette.to.c)
    this.setVec3(u.u_pal2D, frame.palette.to.d)
    gl.uniform1f(u.u_palMix, frame.palette.mix)
    gl.uniform1f(u.u_colorShift, frame.colorShift)
    gl.uniform1f(u.u_colorScale, frame.colorScale)
    gl.uniform1f(u.u_brightness, frame.brightness)
    gl.uniform1f(u.u_farField, frame.farField)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private setVec3(location: WebGLUniformLocation | null, v: Vec3): void {
    this.gl.uniform3f(location, v[0], v[1], v[2])
  }

  private fragmentPrecision(): FloatPrecision {
    const format = this.gl.getShaderPrecisionFormat(this.gl.FRAGMENT_SHADER, this.gl.HIGH_FLOAT)
    return format && format.precision > 0 ? 'highp' : 'mediump'
  }

  private buildProgram(): Program {
    const { gl } = this
    const vertex = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentShaderSource(this.fragmentPrecision()))
    const program = gl.createProgram()
    if (!program) throw new Error('createProgram failed')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(program))
    }
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const uniforms = {} as Uniforms
    for (const name of UNIFORM_NAMES) {
      uniforms[name] = gl.getUniformLocation(program, name)
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

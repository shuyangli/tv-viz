export type UniformValue = number | readonly number[]

export type UniformValues = Readonly<Record<string, UniformValue>>

/**
 * One full-screen fragment-shader scene.
 *
 * `fragment` is GLSL ES 1.00 appended to the prelude in `glsl.ts`. It declares its own
 * uniforms and defines `vec3 viz(vec2 p, vec2 uv)`, where `p` is aspect-corrected with
 * y in [-1, 1] and `uv` is in [0, 1].
 */
export interface Visualization {
  readonly id: string
  readonly name: string
  readonly fragment: string
  /** The shader reads the previous frame through `u_prev`; the first frame after a cut sees black. */
  readonly feedback?: boolean
  /**
   * Values for the uniforms `fragment` declares: a number for a float, 2 to 4 numbers
   * for a vector. `time` is scene seconds at the current speed, unbounded and in double
   * precision; `dt` is its advance since the last frame (0 while paused). Shaders run
   * in single precision, so every value returned must stay bounded: wrap phases here.
   */
  uniforms(time: number, dt: number): UniformValues
}

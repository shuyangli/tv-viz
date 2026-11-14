export const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`

/** Shared by every visualization: framework uniforms and a few cheap helpers. */
export const PRELUDE = `${PRECISION}
varying vec2 v_uv;
uniform vec2 u_resolution;
uniform float u_aspect;
uniform sampler2D u_prev;
uniform vec3 u_palA;
uniform vec3 u_palB;
uniform vec3 u_palC;
uniform vec3 u_palD;
uniform vec3 u_pal2A;
uniform vec3 u_pal2B;
uniform vec3 u_pal2C;
uniform vec3 u_pal2D;
uniform float u_palMix;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

/** The active colour-key palette; periodic in t with period 1. */
vec3 palette(float t) {
  vec3 c = u_palA + u_palB * cos(TAU * (u_palC * t + u_palD));
  if (u_palMix > 0.0) c = mix(c, u_pal2A + u_pal2B * cos(TAU * (u_pal2C * t + u_pal2D)), u_palMix);
  return c;
}

/** Pure spectral rainbow, independent of the selected palette; periodic in t with period 1. */
vec3 rainbow(float t) {
  return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.3333, 0.6667)));
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`

export const MAIN = `
void main() {
  vec2 p = (v_uv * 2.0 - 1.0) * vec2(u_aspect, 1.0);
  gl_FragColor = vec4(clamp(viz(p, v_uv), 0.0, 1.0), 1.0);
}
`

export function fragmentSource(body: string): string {
  return PRELUDE + body + MAIN
}

/** Dissolves the outgoing scene's last frame into the live one; the noise breaks up banding in slow gradients. */
export const PRESENT_SHADER = `${PRECISION}
varying vec2 v_uv;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_blend;
uniform float u_brightness;
uniform vec2 u_noise;
void main() {
  vec3 to = texture2D(u_to, v_uv).rgb;
  vec3 from = texture2D(u_from, v_uv).rgb;
  vec2 q = fract((gl_FragCoord.xy + u_noise) * vec2(0.1031, 0.1030));
  q += dot(q, q.yx + 33.33);
  float n = fract((q.x + q.y) * q.x) - 0.5;
  gl_FragColor = vec4(mix(from, to, u_blend) * u_brightness + n / 255.0, 1.0);
}
`

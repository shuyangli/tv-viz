import { MAX_ITERATIONS } from '../scene/quality'

export type FloatPrecision = 'highp' | 'mediump'

export const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/**
 * GLSL ES 1.00 so it runs on WebGL1. Loop bounds must be compile-time constants, so
 * the runtime iteration cap is applied with a break inside a fixed-size loop.
 */
export function fragmentShaderSource(precision: FloatPrecision): string {
  return `
precision ${precision} float;

uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_scale;
uniform float u_rotation;
uniform float u_maxIter;
uniform int u_julia;
uniform vec2 u_seed;
uniform vec3 u_palA;
uniform vec3 u_palB;
uniform vec3 u_palC;
uniform vec3 u_palD;
uniform vec3 u_pal2A;
uniform vec3 u_pal2B;
uniform vec3 u_pal2C;
uniform vec3 u_pal2D;
uniform float u_palMix;
uniform float u_colorShift;
uniform float u_colorScale;
uniform float u_brightness;
uniform float u_farField;

const int MAX_ITER = ${MAX_ITERATIONS};
const float BAILOUT_SQ = 256.0;
const float TAU = 6.28318530718;
const float VIGNETTE = 0.55;
const float TRAP_COLOR_SCALE = 1.5;
const float INTERIOR_BRIGHTNESS = 0.7;

vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(TAU * (c * t + d));
}

bool insideMainBody(vec2 c) {
  float x = c.x - 0.25;
  float q = x * x + c.y * c.y;
  if (q * (q + x) < 0.25 * c.y * c.y) return true;
  float bx = c.x + 1.0;
  return bx * bx + c.y * c.y < 0.0625;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y * (2.0 * u_scale);
  float cs = cos(u_rotation);
  float sn = sin(u_rotation);
  vec2 p = u_center + vec2(uv.x * cs - uv.y * sn, uv.x * sn + uv.y * cs);

  vec2 z;
  vec2 c;
  if (u_julia == 1) {
    z = p;
    c = u_seed;
  } else {
    if (insideMainBody(p)) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    z = vec2(0.0);
    c = p;
  }

  float n = -1.0;
  float trap = 1e9;
  for (int i = 0; i < MAX_ITER; i++) {
    if (float(i) >= u_maxIter) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    float m = dot(z, z);
    trap = min(trap, m);
    if (m > BAILOUT_SQ) {
      // Points that blow up within a couple of iterations can produce a negative
      // smooth count; clamp so they are not mistaken for interior.
      n = max(0.0, float(i) + 2.0 - log2(log2(m)));
      break;
    }
  }

  vec2 q = gl_FragCoord.xy / u_resolution - 0.5;
  float vignette = 1.0 - VIGNETTE * dot(q, q);

  if (n < 0.0) {
    if (u_julia == 0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    // Julia interiors are large, so shade them by how close the orbit passed to the
    // origin. That traces the basin structure instead of leaving a black hole.
    float ti = sqrt(trap) * TRAP_COLOR_SCALE + u_colorShift;
    vec3 inner = mix(
      palette(ti, u_palA, u_palB, u_palC, u_palD),
      palette(ti, u_pal2A, u_pal2B, u_pal2C, u_pal2D),
      u_palMix
    );
    inner *= INTERIOR_BRIGHTNESS * smoothstep(0.0, 0.3, sqrt(trap));
    gl_FragColor = vec4(inner * vignette * u_brightness, 1.0);
    return;
  }

  float t = n / u_colorScale + u_colorShift;
  vec3 col = mix(
    palette(t, u_palA, u_palB, u_palC, u_palD),
    palette(t, u_pal2A, u_pal2B, u_pal2C, u_pal2D),
    u_palMix
  );
  // Pixels that escape almost immediately are the flat far field; keep them dark so the
  // set itself carries the light. Deep zooms have n >> u_farField everywhere, so this
  // only shapes the overview.
  col *= pow(smoothstep(0.0, u_farField, n), 1.6);
  gl_FragColor = vec4(col * vignette * u_brightness, 1.0);
}
`
}

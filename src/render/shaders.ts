import { MAX_ITERATIONS } from '../scene/quality'

export const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/** Smooth iteration counts are stored as n / N_RANGE in 16 bits; interior trap distances as sqrt(trap) / TRAP_RANGE. */
const ENCODING = `
const float N_RANGE = 512.0;
const float TRAP_RANGE = 2.0;
`

/**
 * Escape-time pass. Writes the orbit data for one interleaved tile of a keyframe:
 * RG = 16-bit value, B = 1 for interior points. Colour is applied later by the present
 * pass, so this shader does nothing per pixel but iterate.
 *
 * GLSL ES 1.00 so it runs on WebGL1. Loop bounds must be compile-time constants, so the
 * runtime iteration cap is applied with a break inside a fixed-size loop. The loop is
 * unrolled by two with a single bailout test per pair: after crossing |z|^2 = 256 one
 * extra iteration keeps |z|^2 below 2^33, safely inside single precision, and the smooth
 * count formula is invariant to when the escape is detected.
 */
export function keyframeShaderSource(julia: boolean): string {
  const step = 'z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;'
  return `
precision highp float;

uniform vec2 u_center;
uniform vec2 u_rot;
uniform float u_unitsPerTexel;
uniform vec2 u_texCenter;
uniform int u_maxIter;
uniform vec2 u_seed;
uniform float u_tile;
uniform float u_rowsPerTile;
uniform float u_tiles;

const int MAX_ITER = ${MAX_ITERATIONS};
const float BAILOUT_SQ = 256.0;
${ENCODING}

vec4 encode(float value, float interior) {
  float v = floor(clamp(value, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(v / 256.0);
  float lo = v - hi * 256.0;
  return vec4(hi / 255.0, lo / 255.0, interior, 1.0);
}

${
  julia
    ? ''
    : `
bool insideMainBody(vec2 c) {
  float x = c.x - 0.25;
  float q = x * x + c.y * c.y;
  if (q * (q + x) < 0.25 * c.y * c.y) return true;
  float bx = c.x + 1.0;
  return bx * bx + c.y * c.y < 0.0625;
}
`
}

void main() {
  float storedRow = floor(gl_FragCoord.y);
  float row = (storedRow - u_tile * u_rowsPerTile) * u_tiles + u_tile;
  vec2 d = (vec2(gl_FragCoord.x, row + 0.5) - u_texCenter) * u_unitsPerTexel;
  vec2 p = u_center + vec2(d.x * u_rot.x - d.y * u_rot.y, d.x * u_rot.y + d.y * u_rot.x);

${
  julia
    ? `
  vec2 z = p;
  vec2 c = u_seed;
  float trap = 1e9;
`
    : `
  if (insideMainBody(p)) {
    gl_FragColor = encode(0.0, 1.0);
    return;
  }
  vec2 z = vec2(0.0);
  vec2 c = p;
`
}
  float n = -1.0;
  for (int i = 0; i < MAX_ITER; i += 2) {
    if (i >= u_maxIter) break;
    ${step}
${julia ? '    trap = min(trap, dot(z, z));' : ''}
    ${step}
    float m = dot(z, z);
${julia ? '    trap = min(trap, m);' : ''}
    if (m > BAILOUT_SQ) {
      // Points that blow up within a couple of iterations can produce a negative
      // smooth count; clamp so they are not mistaken for interior.
      n = max(0.0, float(i) + 3.0 - log2(log2(m)));
      break;
    }
  }

  if (n < 0.0) {
    gl_FragColor = encode(${julia ? 'sqrt(trap) / TRAP_RANGE' : '0.0'}, 1.0);
    return;
  }
  gl_FragColor = encode(n / N_RANGE, 0.0);
}
`
}

/**
 * Present pass. Reprojects the newest complete keyframe through the current camera with
 * a manual bilinear fetch (the packed texels cannot be filtered by hardware), then looks
 * the colour up in a palette table and applies far-field fade, vignette and brightness.
 * Taps whose interior flag disagrees with the nearest tap are dropped so set boundaries
 * stay crisp. Everything touching texel coordinates or the 16-bit decode stays highp;
 * only the final shading is mediump.
 */
export function presentShaderSource(): string {
  return `
precision highp float;

uniform highp sampler2D u_key;
uniform mediump sampler2D u_lut;
uniform vec2 u_texSizeInv;
uniform vec2 u_keyMax;
uniform float u_rowsPerTile;
uniform float u_tiles;
uniform mat2 u_map;
uniform vec2 u_offset;
uniform vec2 u_resolutionInv;
uniform int u_julia;
uniform float u_colorShift;
uniform float u_colorScaleInv;
uniform float u_lutPeriodInv;
uniform mediump float u_brightness;
uniform float u_farField;

const mediump float VIGNETTE = 0.55;
const float TRAP_COLOR_SCALE = 1.5;
const mediump float INTERIOR_BRIGHTNESS = 0.7;
${ENCODING}

float storedRow(float row) {
  float tile = mod(row, u_tiles);
  return tile * u_rowsPerTile + floor((row - tile) / u_tiles + 0.5);
}

vec2 fetch(float x, float storedY) {
  vec4 s = texture2D(u_key, vec2(x + 0.5, storedY + 0.5) * u_texSizeInv);
  float v = (floor(s.r * 255.0 + 0.5) * 256.0 + floor(s.g * 255.0 + 0.5)) / 65535.0;
  return vec2(v, s.b);
}

void main() {
  vec2 f = u_map * gl_FragCoord.xy + u_offset - 0.5;
  vec2 base = floor(f);
  vec2 w = f - base;
  vec2 lo = clamp(base, vec2(0.0), u_keyMax);
  vec2 hi = clamp(base + 1.0, vec2(0.0), u_keyMax);
  float row0 = storedRow(lo.y);
  float row1 = storedRow(hi.y);
  vec2 s00 = fetch(lo.x, row0);
  vec2 s10 = fetch(hi.x, row0);
  vec2 s01 = fetch(lo.x, row1);
  vec2 s11 = fetch(hi.x, row1);

  float flag = w.x < 0.5 ? (w.y < 0.5 ? s00.y : s01.y) : (w.y < 0.5 ? s10.y : s11.y);
  float w00 = (1.0 - w.x) * (1.0 - w.y) * (1.0 - abs(s00.y - flag));
  float w10 = w.x * (1.0 - w.y) * (1.0 - abs(s10.y - flag));
  float w01 = (1.0 - w.x) * w.y * (1.0 - abs(s01.y - flag));
  float w11 = w.x * w.y * (1.0 - abs(s11.y - flag));
  float value = (w00 * s00.x + w10 * s10.x + w01 * s01.x + w11 * s11.x) / (w00 + w10 + w01 + w11);

  float t;
  mediump float fade;
  if (flag > 0.5) {
    if (u_julia == 0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    // Julia interiors are large, so shade them by how close the orbit passed to the
    // origin. That traces the basin structure instead of leaving a black hole.
    float trap = value * TRAP_RANGE;
    t = trap * TRAP_COLOR_SCALE + u_colorShift;
    fade = INTERIOR_BRIGHTNESS * smoothstep(0.0, 0.3, trap);
  } else {
    float n = value * N_RANGE;
    t = n * u_colorScaleInv + u_colorShift;
    // Pixels that escape almost immediately are the flat far field; keep them dark so the
    // set itself carries the light. Deep zooms have n >> u_farField everywhere, so this
    // only shapes the overview.
    fade = n >= u_farField ? 1.0 : pow(smoothstep(0.0, u_farField, n), 1.6);
  }
  mediump vec3 col = texture2D(u_lut, vec2(t * u_lutPeriodInv, 0.5)).rgb;
  mediump vec2 q = gl_FragCoord.xy * u_resolutionInv - 0.5;
  mediump float vignette = 1.0 - VIGNETTE * dot(q, q);
  gl_FragColor = vec4(col * (fade * vignette * u_brightness), 1.0);
}
`
}

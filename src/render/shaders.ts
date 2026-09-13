import { koenigsCoefficients, perturbationConstants, type MisiurewiczPoint } from '../scene/misiurewicz'
import { HANDOFF_BITS, KOENIGS_ORDER, MAX_ITERATIONS, MIN_SKIP_DEPTH } from '../scene/quality'

export const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/**
 * Orbit data is stored as a 24-bit value in RGB with the interior flag in A. Exterior
 * pixels store (n - nBase + nRange) / (2 nRange); Julia interiors store sqrt(trap) / TRAP_RANGE.
 */
const ENCODING = `
const float TRAP_RANGE = 2.0;

vec4 encode(float value, float interior) {
  float v = floor(clamp(value, 0.0, 1.0) * 16777215.0 + 0.5);
  float b2 = floor(v / 65536.0);
  float r = v - b2 * 65536.0;
  float b1 = floor(r / 256.0);
  float b0 = r - b1 * 256.0;
  return vec4(b2, b1, b0, interior * 255.0) / 255.0;
}
`

const TILE_ROW = `
uniform float u_tile;
uniform float u_rowsPerTile;
uniform float u_tiles;
uniform vec2 u_texCenter;
uniform vec2 u_rot;

/** Texel position of this fragment in the interleaved layout, centred on the keyframe. */
vec2 texelOffset() {
  float storedRow = floor(gl_FragCoord.y);
  float row = (storedRow - u_tile * u_rowsPerTile) * u_tiles + u_tile;
  vec2 d = vec2(gl_FragCoord.x, row + 0.5) - u_texCenter;
  return vec2(d.x * u_rot.x - d.y * u_rot.y, d.x * u_rot.y + d.y * u_rot.x);
}
`

function lit(v: number): string {
  const s = v.toPrecision(9)
  return s.indexOf('.') < 0 && s.indexOf('e') < 0 ? s + '.0' : s
}

/**
 * Direct escape-time pass in absolute single precision, for Julia sets and for the first
 * doublings of a dive, where it is exact and about half the cost of perturbation. GLSL
 * ES 1.00 so it runs on WebGL1; the loop is unrolled by two with a single bailout test
 * per pair, which is safe because one extra iteration past |z|^2 = 256 keeps |z|^2 below
 * 2^33 and the smooth count is invariant to when escape is detected.
 */
export function directShaderSource(julia: boolean): string {
  const step = 'z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;'
  return `
precision highp float;

uniform vec2 u_center;
uniform float u_unitsPerTexel;
uniform int u_maxIter;
uniform vec2 u_seed;
uniform float u_nRange;
${TILE_ROW}

const int MAX_ITER = ${MAX_ITERATIONS};
const float BAILOUT_SQ = 256.0;
${ENCODING}
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
  vec2 p = u_center + texelOffset() * u_unitsPerTexel;
${
  julia
    ? `  vec2 z = p;
  vec2 c = u_seed;
  float trap = 1e9;`
    : `  if (insideMainBody(p)) {
    gl_FragColor = encode(0.0, 1.0);
    return;
  }
  vec2 z = vec2(0.0);
  vec2 c = p;`
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
      n = max(0.0, float(i) + 3.0 - log2(log2(m)));
      break;
    }
  }
  if (n < 0.0) {
    gl_FragColor = encode(${julia ? 'sqrt(trap) / TRAP_RANGE' : '0.0'}, 1.0);
    return;
  }
  gl_FragColor = encode((n + u_nRange) / (2.0 * u_nRange), 0.0);
}
`
}

/**
 * Perturbation pass for an endless zoom toward a Misiurewicz point. The reference orbit
 * is a finite cycle baked in as constants. Each pixel first jumps, in closed form, to
 * the iteration where its offset from the reference reaches 2^-HANDOFF_BITS, then runs
 * the remaining iterations exactly, rebasing onto the start of the orbit whenever it
 * passes closer to the origin than to the reference (so no glitches). Per-pixel cost is
 * therefore independent of zoom depth. Everything is expressed in view units and log2
 * exponents so nothing underflows single precision however deep the zoom goes.
 */
export function diveShaderSource(point: MisiurewiczPoint): string {
  const k = perturbationConstants(point)
  const koenigs = koenigsCoefficients(point, KOENIGS_ORDER)
  const { preperiod, period, orbit } = point
  // Short cycles are repeated so the loop body has at least four steps and tests fall
  // every second step.
  const repeats = Math.max(1, Math.ceil(4 / period))
  const cycle: (readonly [number, number])[] = []
  for (let r = 0; r < repeats; r++) cycle.push(...orbit.slice(preperiod))
  const maxCycles = Math.ceil(MAX_ITERATIONS / cycle.length) + 2
  const horner = koenigs
    .slice(1)
    .reverse()
    .map((b) => `vec2(${lit(b[0])}, ${lit(b[1])})`)
  // Steps are emitted in groups of up to two: plain perturbed iterations, then one
  // escape/rebase test on the last iterate. One iteration past |z|^2 = 256 keeps |z|^2
  // below 2^33 and the smooth count is invariant to when escape is detected, as in the
  // Julia loop. The step is d(2Z + d) + dc; deep in the zoom dc is exactly zero in single
  // precision, so a second copy of the loop omits it. Expanded inline because GLSL ES 1.00
  // has no multi-line macros.
  const advance = (z: readonly [number, number], withDc: boolean): string => {
    const dc = withDc ? ' + dcAbs' : ''
    return `        w = vec2(${lit(2 * z[0])} + d.x, ${lit(2 * z[1])} + d.y);
        d = vec2(d.x * w.x - d.y * w.y, d.x * w.y + d.y * w.x)${dc};
`
  }
  const group = (zs: readonly (readonly [number, number])[], withDc: boolean): string => {
    const last = zs[zs.length - 1]
    const before = lit(zs.length - 1)
    return `      if (!halt && !rebase) {
${zs
  .slice(0, -1)
  .map((z) => advance(z, withDc))
  .join('')}        z = vec2(${lit(last[0])}, ${lit(last[1])}) + d;
        m = dot(z, z);
        if (m > BAILOUT_SQ) { escaped = max(0.0, n + ${before} + 1.0 - log2(log2(m))); halt = true; }
        else if (m < dot(d, d)) { d = z; n += ${before}; rebase = true; }
        else {
${advance(last, withDc)}          n += ${lit(zs.length)};
          if (n >= maxIter) halt = true;
        }
      }
`
  }
  const groups = (zs: readonly (readonly [number, number])[], withDc: boolean): string => {
    let out = ''
    for (let i = 0; i < zs.length; i += 2) out += group(zs.slice(i, i + 2), withDc)
    return out
  }
  const iterate = (withDc: boolean): string => `
  for (int pass = 0; pass < MAX_PASSES; pass++) {
    bool rebase = false;
    if (pre) {
${groups(orbit.slice(0, preperiod), withDc)}    }
    for (int cyc = 0; cyc < MAX_CYCLES; cyc++) {
      if (halt || rebase) break;
${groups(cycle, withDc)}    }
    if (!rebase) break;
    pre = true;
  }
`
  return `
precision highp float;

uniform vec2 u_offset;
uniform float u_texelToView;
uniform int u_k0;
uniform float u_mant;
uniform float u_j0;
uniform float u_log2Mag0;
uniform float u_phase0;
uniform float u_nBase;
uniform float u_nRange;
uniform int u_maxIter;
${TILE_ROW}

const int MAX_ITER = ${MAX_ITERATIONS};
const int MAX_CYCLES = ${maxCycles};
const int MAX_PASSES = 16;
const float BAILOUT_SQ = 256.0;
const float LOG2_T = ${lit(-HANDOFF_BITS)};
const float LOG2_LAMBDA = ${lit(k.log2Lambda)};
const float ARG_LAMBDA = ${lit(k.argLambda)};
const int MIN_SKIP_DEPTH = ${MIN_SKIP_DEPTH};
const vec2 ANCHOR = vec2(${lit(point.c[0])}, ${lit(point.c[1])});
const int PREPERIOD = ${preperiod};
const int PERIOD = ${period};
${ENCODING}

bool insideMainBody(vec2 c) {
  float x = c.x - 0.25;
  float q = x * x + c.y * c.y;
  if (q * (q + x) < 0.25 * c.y * c.y) return true;
  float bx = c.x + 1.0;
  return bx * bx + c.y * c.y < 0.0625;
}

void main() {
  vec2 dcView = u_offset + texelOffset() * u_texelToView;
  float k0 = float(u_k0);
  bool shallow = u_k0 <= 100;
  vec2 dcAbs = shallow ? dcView * (u_mant * exp2(-k0)) : vec2(0.0);
  if (shallow && insideMainBody(ANCHOR + dcAbs)) {
    gl_FragColor = encode(0.0, 1.0);
    return;
  }

  float log2dc = 0.5 * log2(max(dot(dcView, dcView), 1e-30));
  float dj = floor((LOG2_T - u_log2Mag0 - log2dc) / LOG2_LAMBDA);
  float j = u_j0 + dj;

  vec2 d = vec2(0.0);
  float n = 0.0;
  bool pre = true;
  if (j >= 1.0 && u_k0 >= MIN_SKIP_DEPTH) {
    // Linear estimate u = λ^j P δc, then the inverse Koenigs series δ = φ(u) by Horner's rule.
    float mag = exp2(u_log2Mag0 + log2dc + dj * LOG2_LAMBDA);
    float phase = u_phase0 + dj * ARG_LAMBDA + atan(dcView.y, dcView.x);
    vec2 u = mag * vec2(cos(phase), sin(phase));
    vec2 h = ${horner[0]};
${horner
  .slice(1)
  .map((b) => `    h = vec2(h.x * u.x - h.y * u.y, h.x * u.y + h.y * u.x) + ${b};\n`)
  .join('')}    h = vec2(h.x * u.x - h.y * u.y + 1.0, h.x * u.y + h.y * u.x);
    d = vec2(h.x * u.x - h.y * u.y, h.x * u.y + h.y * u.x);
    n = float(PREPERIOD) + j * float(PERIOD);
    pre = false;
  }

  float maxIter = n + float(u_maxIter);
  float escaped = -1.0;
  bool halt = false;
  vec2 w;
  vec2 z;
  float m;
  if (shallow) {${iterate(true)}  } else {${iterate(false)}  }

  if (escaped < 0.0) {
    gl_FragColor = encode(0.0, 1.0);
    return;
  }
  gl_FragColor = encode((escaped - u_nBase + u_nRange) / (2.0 * u_nRange), 0.0);
}
`
}

/**
 * Present pass. Reprojects the newest complete keyframe through the current camera with
 * a manual bilinear fetch (the packed texels cannot be filtered by hardware), then looks
 * the colour up in a palette table and applies far-field fade, vignette and brightness.
 * Taps whose interior flag disagrees with the nearest tap are dropped so set boundaries
 * stay crisp. Everything touching texel coordinates or the decode stays highp; only the
 * final shading is mediump.
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
uniform float u_nRange;
uniform float u_nBase;
uniform float u_nBaseWrapped;
uniform float u_colorShift;
uniform float u_colorScaleInv;
uniform float u_lutPeriodInv;
uniform mediump float u_brightness;
uniform float u_farField;

const mediump float VIGNETTE = 0.55;
const float TRAP_COLOR_SCALE = 1.5;
const mediump float INTERIOR_BRIGHTNESS = 0.7;
const float TRAP_RANGE = 2.0;

float storedRow(float row) {
  float tile = mod(row, u_tiles);
  return tile * u_rowsPerTile + floor((row - tile) / u_tiles + 0.5);
}

vec2 fetch(float x, float storedY) {
  vec4 s = texture2D(u_key, vec2(x + 0.5, storedY + 0.5) * u_texSizeInv);
  float v = (floor(s.r * 255.0 + 0.5) * 65536.0 + floor(s.g * 255.0 + 0.5) * 256.0 + floor(s.b * 255.0 + 0.5)) / 16777215.0;
  return vec2(v, s.a);
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
    // n relative to the keyframe's base count; the base is folded in modulo the palette
    // period on the CPU so t stays small however many iterations deep the zoom is.
    float nRel = value * 2.0 * u_nRange - u_nRange;
    t = (u_nBaseWrapped + nRel) * u_colorScaleInv + u_colorShift;
    float n = u_nBase + nRel;
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

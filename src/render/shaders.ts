import type { Formula, Mat2 } from '../scene/formula'
import { koenigsCoefficients, perturbationConstants, type MisiurewiczPoint } from '../scene/misiurewicz'
import { handoffBits, KOENIGS_ORDER, MAX_ITERATIONS, MIN_SKIP_DEPTH } from '../scene/quality'

export const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/**
 * Orbit data is stored as a 24-bit value in RGB with the interior fraction in A. Exterior
 * samples store (n - nBase + nRange) / (2 nRange), averaged over the texel's subsamples.
 */
const ENCODING = `
vec4 encode(float value, float interior) {
  float v = floor(clamp(value, 0.0, 1.0) * 16777215.0 + 0.5);
  float b2 = floor(v / 65536.0);
  float r = v - b2 * 65536.0;
  float b1 = floor(r / 256.0);
  float b0 = r - b1 * 256.0;
  return vec4(b2, b1, b0, floor(interior * 255.0 + 0.5)) / 255.0;
}
`

/**
 * Shared by both escape passes: the fragment's texel position in the permuted row layout,
 * centred on the keyframe and rotated by the camera, and the supersampling loop that
 * averages the escape count over a rotated-grid pattern (interior subsamples counted
 * separately so set boundaries antialias too).
 */
const SAMPLING = `
uniform float u_rowStride;
uniform float u_rows;
uniform vec2 u_texCenter;
uniform vec2 u_rot;
uniform int u_samples;

vec2 texelOffset(vec2 jitter) {
  float row = mod(floor(gl_FragCoord.y) * u_rowStride, u_rows);
  vec2 d = vec2(gl_FragCoord.x, row + 0.5) + jitter - u_texCenter;
  return vec2(d.x * u_rot.x - d.y * u_rot.y, d.x * u_rot.y + d.y * u_rot.x);
}

vec2 jitter(int s) {
  if (u_samples == 1) return vec2(0.0);
  if (u_samples == 2) return s == 0 ? vec2(-0.25, -0.25) : vec2(0.25, 0.25);
  if (s == 0) return vec2(-0.375, -0.125);
  if (s == 1) return vec2(0.125, -0.375);
  if (s == 2) return vec2(0.375, 0.125);
  return vec2(-0.125, 0.375);
}
`

/**
 * Runs escape() once per subsample and packs the averaged exterior count with the interior
 * fraction. The loop bound is deliberately far above the sample count so no compiler is
 * tempted to unroll the enormous body four times; the break ends it.
 */
const SUPERSAMPLE_MAIN = `
void main() {
  float sum = 0.0;
  float outside = 0.0;
  float inside = 0.0;
  if (u_samples <= 1) {
    float n = escape(texelOffset(vec2(0.0)));
    if (n < 0.0) inside = 1.0;
    else { sum = n; outside = 1.0; }
  } else {
    for (int s = 0; s < 1024; s++) {
      if (s >= u_samples) break;
      float n = escape(texelOffset(jitter(s)));
      if (n < 0.0) inside += 1.0;
      else { sum += n; outside += 1.0; }
    }
  }
  float value = outside > 0.0 ? sum / outside : 0.0;
  gl_FragColor = encode((value + u_nRange) / (2.0 * u_nRange), inside / (inside + outside));
}
`

function lit(v: number): string {
  const s = v.toPrecision(9)
  return s.indexOf('.') < 0 && s.indexOf('e') < 0 ? s + '.0' : s
}

/**
 * Direct escape-time pass in absolute single precision, for the first doublings of a
 * dive, where it is exact and about half the cost of perturbation. GLSL ES 1.00 so it
 * runs on WebGL1; the loop is unrolled by two with a single bailout test per pair, which
 * is safe because one extra iteration past |z|^2 = 256 keeps |z|^2 below 2^33 (2^49 for
 * cubics) and the smooth count is invariant to when escape is detected.
 */
export function directShaderSource(formula: Formula): string {
  const step = formula.glslDirectStep()
  return `
precision highp float;

uniform vec2 u_center;
uniform float u_unitsPerTexel;
uniform int u_maxIter;
uniform float u_nRange;
${SAMPLING}

const int MAX_ITER = ${MAX_ITERATIONS};
const float BAILOUT_SQ = 256.0;
const float INV_LOG2_DEGREE = ${lit(1 / Math.log2(formula.degree))};
${ENCODING}
${
  formula.id === 'mandelbrot'
    ? `
bool insideMainBody(vec2 c) {
  float x = c.x - 0.25;
  float q = x * x + c.y * c.y;
  if (q * (q + x) < 0.25 * c.y * c.y) return true;
  float bx = c.x + 1.0;
  return bx * bx + c.y * c.y < 0.0625;
}
`
    : ''
}

/** Smooth escape count of the texel offset, or -1.0 for the interior. */
float escape(vec2 texel) {
  vec2 c = u_center + texel * u_unitsPerTexel;
${
  formula.id === 'mandelbrot'
    ? `  if (insideMainBody(c)) return -1.0;
`
    : ''
}  vec2 z = vec2(0.0);
  float n = -1.0;
  for (int i = 0; i < MAX_ITER; i += 2) {
    if (i >= u_maxIter) break;
    ${step}
    ${step}
    float m = dot(z, z);
    if (m > BAILOUT_SQ) {
      n = max(0.0, float(i) + 3.0 - log2(log2(m)) * INV_LOG2_DEGREE);
      break;
    }
  }
  return n;
}
${SUPERSAMPLE_MAIN}
`
}

/**
 * Perturbation pass for an endless zoom toward a Misiurewicz point. The reference orbit
 * is a finite cycle baked in as constants. Each pixel first jumps, in closed form, to
 * the iteration where its offset from the reference reaches the handoff size (a linear
 * estimate raised through the cycle Jacobian's eigen-decomposition, refined by the
 * inverse Koenigs series for holomorphic formulas), then runs the remaining iterations
 * exactly, rebasing onto the start of the orbit whenever it passes closer to the origin
 * than the reference (so no glitches). Per-pixel cost is therefore independent of zoom
 * depth. Everything is expressed in view units and log2 exponents so nothing underflows
 * single precision however deep the zoom goes.
 */
export function diveShaderSource(point: MisiurewiczPoint): string {
  const { formula, preperiod, period, orbit } = point
  const k = perturbationConstants(point)
  const koenigs = formula.holomorphic ? koenigsCoefficients(point, KOENIGS_ORDER) : null
  // Short cycles are repeated so the loop body has at least four steps and tests fall
  // every second step.
  const repeats = Math.max(1, Math.ceil(4 / period))
  const cycle: (readonly [number, number])[] = []
  for (let r = 0; r < repeats; r++) cycle.push(...orbit.slice(preperiod))
  const maxCycles = Math.ceil(MAX_ITERATIONS / cycle.length) + 2

  // Steps are emitted in groups of up to two: plain perturbed iterations, then one
  // escape/rebase test on the last iterate (safe for the same reason as the direct
  // loop). Deep in the zoom dc is exactly zero in single precision, so a second copy of
  // the loop omits it. Expanded inline because GLSL ES 1.00 has no multi-line macros.
  const advance = (z: readonly [number, number], withDc: boolean): string =>
    `        ${formula.glslPerturbStep(z, lit, withDc ? ' + dcAbs' : '')}\n`
  const group = (zs: readonly (readonly [number, number])[], withDc: boolean): string => {
    const last = zs[zs.length - 1]
    const before = lit(zs.length - 1)
    return `      if (!halt && !rebase) {
${zs
  .slice(0, -1)
  .map((z) => advance(z, withDc))
  .join('')}        z = vec2(${lit(last[0])}, ${lit(last[1])}) + d;
        m = dot(z, z);
        if (m > BAILOUT_SQ) { escaped = max(0.0, n + ${before} + 1.0 - log2(log2(m)) * INV_LOG2_DEGREE); halt = true; }
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

  // Closed-form skip. v = M δc in the eigenbasis (view units); its log2 size picks the
  // number of cycles dj relative to the CPU's j0, then the power is applied as a complex
  // multiplication or two real scalings, mapped back through S.
  const mat = (m: Mat2, v: string): string =>
    `vec2(${lit(m[0])} * ${v}.x + ${lit(m[1])} * ${v}.y, ${lit(m[2])} * ${v}.x + ${lit(m[3])} * ${v}.y)`
  let power: string
  if (k.realEigen) {
    power = `    float j = u_j0 + dj;
    float odd = mod(j, 2.0);
    float s1 = ${k.lambdaSigns[0] < 0 ? 'odd > 0.5 ? -1.0 : 1.0' : '1.0'};
    float s2 = ${k.lambdaSigns[1] < 0 ? 'odd > 0.5 ? -1.0 : 1.0' : '1.0'};
    float log2Mag2 = u_log2Mag0 + u_j0 * ${lit(k.log2Lambda2 - k.log2Lambda)} + dj * ${lit(k.log2Lambda2)};
    vec2 zeta = vec2(
      s1 * sign(v.x) * exp2(u_log2Mag0 + log2(max(abs(v.x), 1e-30)) + dj * LOG2_LAMBDA),
      s2 * sign(v.y) * exp2(log2Mag2 + log2(max(abs(v.y), 1e-30))));
`
  } else {
    power = `    float mag = exp2(u_log2Mag0 + log2v + dj * LOG2_LAMBDA);
    float phase = u_phase0 + dj * ARG_LAMBDA + atan(v.y, v.x);
    vec2 zeta = mag * vec2(cos(phase), sin(phase));
`
  }
  let series = ''
  if (koenigs) {
    const horner = koenigs
      .slice(1)
      .reverse()
      .map((b) => `vec2(${lit(b[0])}, ${lit(b[1])})`)
    series = `    vec2 u = d;
    vec2 h = ${horner[0]};
${horner
  .slice(1)
  .map((b) => `    h = vec2(h.x * u.x - h.y * u.y, h.x * u.y + h.y * u.x) + ${b};\n`)
  .join('')}    h = vec2(h.x * u.x - h.y * u.y + 1.0, h.x * u.y + h.y * u.x);
    d = vec2(h.x * u.x - h.y * u.y, h.x * u.y + h.y * u.x);
`
  }

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
${SAMPLING}

const int MAX_ITER = ${MAX_ITERATIONS};
const int MAX_CYCLES = ${maxCycles};
const int MAX_PASSES = 16;
const float BAILOUT_SQ = 256.0;
const float INV_LOG2_DEGREE = ${lit(1 / Math.log2(formula.degree))};
const float LOG2_T = ${lit(-handoffBits(point))};
const float LOG2_LAMBDA = ${lit(k.log2Lambda)};
const float ARG_LAMBDA = ${lit(k.argLambda)};
const int MIN_SKIP_DEPTH = ${MIN_SKIP_DEPTH};
const int PREPERIOD = ${preperiod};
const int PERIOD = ${period};
${ENCODING}

/** Smooth escape count of the texel offset relative to the keyframe's base count, or -1.0 for the interior. */
float escape(vec2 texel) {
  vec2 dcView = u_offset + texel * u_texelToView;
  float k0 = float(u_k0);
  bool shallow = u_k0 <= 100;
  vec2 dcAbs = shallow ? dcView * (u_mant * exp2(-k0)) : vec2(0.0);

  vec2 v = ${mat(k.M, 'dcView')};
  float log2v = 0.5 * log2(max(dot(v, v), 1e-30));
  float dj = floor((LOG2_T - u_log2Mag0 - log2v) / LOG2_LAMBDA);

  vec2 d = vec2(0.0);
  float n = 0.0;
  bool pre = true;
  if (u_j0 + dj >= 1.0 && u_k0 >= MIN_SKIP_DEPTH) {
${power}    d = ${mat(k.S, 'zeta')};
${series}    n = float(PREPERIOD) + (u_j0 + dj) * float(PERIOD);
    pre = false;
  }

  float maxIter = n + float(u_maxIter);
  float escaped = -1.0;
  bool halt = false;
  vec2 w;
  vec2 z;
  float m;
  if (shallow) {${iterate(true)}  } else {${iterate(false)}  }

  if (escaped < 0.0) return -1.0;
  return escaped - u_nBase;
}
${SUPERSAMPLE_MAIN}
`
}

/**
 * Bake pass. Turns one complete keyframe's packed escape data into plain colour, one texel
 * to one texel, undoing the row permutation so the result is an ordinary image that the
 * hardware can filter. The palette lookup, far-field fade and interior black happen here,
 * once per keyframe, rather than per displayed pixel. u_n is (nRange, nBase, nBase modulo
 * the palette period): the base is folded on the CPU so t stays small however many
 * iterations deep the zoom is, while the unwrapped base still drives the far field.
 */
export function bakeShaderSource(): string {
  return `
precision highp float;

uniform highp sampler2D u_key;
uniform mediump sampler2D u_lut;
uniform vec2 u_texSizeInv;
uniform float u_rows;
uniform float u_rowStrideInv;
uniform vec3 u_n;
uniform float u_colorShift;
uniform float u_colorScaleInv;
uniform float u_lutPeriodInv;
uniform float u_farField;

void main() {
  float stored = mod(floor(gl_FragCoord.y) * u_rowStrideInv, u_rows);
  vec4 s = texture2D(u_key, vec2(gl_FragCoord.x, stored + 0.5) * u_texSizeInv);
  float value = (floor(s.r * 255.0 + 0.5) * 65536.0 + floor(s.g * 255.0 + 0.5) * 256.0 + floor(s.b * 255.0 + 0.5)) / 16777215.0;
  float nRel = value * 2.0 * u_n.x - u_n.x;
  float t = (u_n.z + nRel) * u_colorScaleInv + u_colorShift;
  float n = u_n.y + nRel;
  // Pixels that escape almost immediately are the flat far field; keep them dark so the
  // set itself carries the light. Deep zooms have n >> u_farField everywhere, so this
  // only shapes the overview.
  mediump float fade = n >= u_farField ? 1.0 : pow(smoothstep(0.0, u_farField, n), 1.6);
  mediump vec3 col = texture2D(u_lut, vec2(t * u_lutPeriodInv, 0.5)).rgb;
  gl_FragColor = vec4(col * (fade * (1.0 - s.a)), 1.0);
}
`
}

/**
 * Present pass. Reprojects the two newest baked keyframes through the current camera with
 * one hardware-filtered tap each and crossfades them by the dissolve weight; where one
 * keyframe runs out of texels its share falls to the other over a soft margin. Vignette
 * and brightness follow. Texel coordinates stay highp; shading is mediump.
 */
export function presentShaderSource(): string {
  const keyframeUniforms = (k: string): string => `
uniform highp sampler2D u_col${k};
uniform vec2 u_size${k};
uniform mat2 u_map${k};
uniform vec2 u_offset${k};
`
  const shade = (k: string): string => `
vec4 shade${k}() {
  vec2 f = u_map${k} * gl_FragCoord.xy + u_offset${k};
  vec2 clamped = clamp(f, vec2(0.5), u_size${k} - 0.5);
  mediump vec3 col = texture2D(u_col${k}, clamped * u_texSizeInv).rgb;
  vec2 edge = min(f, u_size${k} - f);
  float cover = clamp(1.0 + min(edge.x, edge.y) / EDGE_SOFT, 0.0, 1.0);
  return vec4(col, cover);
}
`
  return `
precision highp float;

uniform vec2 u_texSizeInv;
uniform vec2 u_resolutionInv;
uniform mediump float u_brightness;
/** Weight of keyframe A; B is the one it is replacing. */
uniform float u_blend;
${keyframeUniforms('A')}${keyframeUniforms('B')}
const mediump float VIGNETTE = 0.55;
/** Texels over which a keyframe's share fades out beyond its edge. */
const float EDGE_SOFT = 24.0;
${shade('A')}${shade('B')}
void main() {
  vec4 a = shadeA();
  mediump vec3 col = a.rgb;
  if (u_blend < 1.0) {
    vec4 b = shadeB();
    float wa = u_blend * a.a;
    float wb = (1.0 - u_blend) * b.a;
    float total = wa + wb;
    col = total > 0.0 ? (wa * a.rgb + wb * b.rgb) / total : mix(b.rgb, a.rgb, u_blend);
  }
  mediump vec2 q = gl_FragCoord.xy * u_resolutionInv - 0.5;
  mediump float vignette = 1.0 - VIGNETTE * dot(q, q);
  gl_FragColor = vec4(col * (vignette * u_brightness), 1.0);
}
`
}

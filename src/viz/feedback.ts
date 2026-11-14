import type { Visualization } from './types'

const TAU = Math.PI * 2
const SQRT3 = Math.sqrt(3)
const MAX_DT = 0.05
const HALF_WIDTH = 1.6
const GOLDEN = 0.6180339887

/** Steps by the golden ratio each frame so a pixel's rounding dither averages out instead of random-walking. */
let ditherPhase = 0

/** Three incommensurate sines averaged into a slow wander in [-1, 1]. */
function wander(time: number, a: number, b: number, c: number, offset: number): number {
  return (
    (Math.sin(time * a + offset) + Math.sin(time * b + offset * 2.3 + 1.3) + Math.sin(time * c + offset * 0.7 + 4.1)) / 3
  )
}

function smooth(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

function lissajous(time: number, a: number, b: number, offset: number, reach: number): [number, number] {
  return [
    HALF_WIDTH * reach * Math.sin(time * a + offset),
    0.85 * reach * Math.sin(time * b + offset * 1.7 + 0.5 * Math.sin(time * a * 0.37)),
  ]
}

export const feedback: Visualization = {
  id: 'feedback',
  name: 'Echo Chamber',
  feedback: true,
  fragment: `
uniform vec4 u_xf;
uniform vec2 u_ctr;
uniform vec3 u_hueM;
uniform vec4 u_rates;
uniform vec4 u_swirl;
uniform vec2 u_sym;
uniform vec3 u_gain;
uniform vec3 u_field;
uniform vec2 u_pulse;
uniform float u_dither;
uniform float u_hue;
uniform vec3 u_o1;
uniform vec3 u_o2;
uniform vec3 u_o3;
uniform vec3 u_o4;
uniform vec3 u_e1;
uniform vec3 u_e2;
uniform vec4 u_r1;
uniform vec4 u_r2;
uniform vec4 u_rib;
uniform float u_ribW;

vec3 echo(vec2 q) {
  vec2 u = q / vec2(u_aspect, 1.0) * 0.5 + 0.5;
  return texture2D(u_prev, 1.0 - abs(1.0 - 2.0 * fract(u * 0.5))).rgb;
}

vec3 brighter(vec3 a, vec3 b) {
  return mix(a, b, smoothstep(-0.1, 0.1, max(b.r, max(b.g, b.b)) - max(a.r, max(a.g, a.b))));
}

float orb(vec2 p, vec3 o) {
  vec2 e = p - o.xy;
  float k = min(1.0, 2.0 * max(0.0, 1.0 - dot(e, e) * o.z));
  return k * k;
}

float ring(vec2 p, vec4 r) {
  float l = (length(p - r.xy) - r.z) * r.w;
  float k = max(0.0, 1.0 - l * l);
  return k * k;
}

vec3 viz(vec2 p, vec2 uv) {
  vec2 d = p - u_ctr;
  vec2 q = u_ctr + vec2(dot(u_xf.xy, d), dot(u_xf.zw, d));
  vec2 w1 = sin(p.yx * vec2(2.3, 1.9) + u_swirl.xy);
  vec2 w2 = sin(vec2(p.y * 4.1 + p.x * 1.3, p.x * 3.7 - p.y * 1.1) + u_swirl.zw);
  q += u_rates.x * (w1 + 0.5 * w2);

  vec3 c = echo(q);
  c = brighter(c, echo(vec2(-q.x, q.y)) * u_sym.x);
  c = brighter(c, echo(-q) * u_sym.y);

  c = u_hueM.x * c + u_hueM.y * c.gbr + u_hueM.z * c.brg;
  float m = max(c.r, max(c.g, c.b));
  float f = u_field.z + dot(p, u_field.xy) + 0.11 * (w1.x + w1.y) + 0.07 * (w2.x - w2.y);
  vec3 tone = palette(f + 0.4 * m);
  c = mix(c, tone * m, u_rates.y);
  c = max(c * (1.0 + u_gain.x * (1.0 - m) * (m - u_gain.y - 0.3 * w1.x * w2.y - 0.15 * w1.y)), 0.0) + tone * (u_gain.z * (1.0 - m));

  float k1 = orb(p, u_o1);
  float k2 = orb(p, u_o2);
  float k3 = orb(p, u_o3);
  float k4 = orb(p, u_o4);
  float k5 = ring(p, u_r1) * u_pulse.x;
  float k6 = ring(p, u_r2) * u_pulse.y;
  vec2 pa = p - u_rib.xy;
  vec2 ba = u_rib.zw - u_rib.xy;
  float h = clamp(dot(pa, ba) / (dot(ba, ba) + 0.0001), 0.0, 1.0);
  vec2 e = pa - ba * h;
  float k7 = max(0.0, 1.0 - dot(e, e) * u_ribW);
  k7 *= k7;

  float s = k1 + k2 + k3 + k4 + k5 + k6 + k7;
  float tint = k2 * 0.17 + k3 * 0.36 + k4 * 0.55 + k5 * 0.72 + k6 * 0.88 + k7 * (0.25 + 0.5 * h);
  vec3 seed = palette(u_hue + tint / (s + 0.001) + 0.1 * s);
  c = mix(c, seed, min(s, 1.0) * u_rates.z);
  vec2 px = vec2(-p.x, p.y);
  float erase = orb(p, u_e1) + orb(p, u_e2)
              + u_sym.x * (orb(px, u_e1) + orb(px, u_e2))
              + u_sym.y * (orb(-p, u_e1) + orb(-p, u_e2));
  c *= 1.0 - min(erase, 1.0) * u_rates.z;

  float n = fract(52.9829189 * fract(dot(uv * u_resolution, vec2(0.06711056, 0.00583715))) + u_dither);
  return c + (n - 0.5) * u_rates.w;
}
`,
  uniforms(time, dtRaw) {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_DT)
    if (dt > 0) ditherPhase = (ditherPhase + GOLDEN) % 1

    const mirror = smooth(0.25, 0.6, wander(time, 0.031, 0.047, 0.0113, 2.0))
    const pinwheel = smooth(0.2, 0.55, wander(time, 0.027, 0.0391, 0.0143, 5.0))
    const live = dt > 0 ? 1 : 0

    const zoom = 0.15 + 1.0 * wander(time, 0.043, 0.0271, 0.0179, 0.0)
    const spin = 2.0 * wander(time, 0.037, 0.0233, 0.0611, 1.0) * (1 - mirror)
    const scale = Math.exp(-zoom * dt)
    const cs = Math.cos(spin * dt) * scale
    const sn = Math.sin(spin * dt) * scale

    const free = (1 - mirror) * (1 - pinwheel)
    const ctrX = 0.75 * wander(time, 0.053, 0.0317, 0.0197, 3.0) * free
    const ctrY = 0.45 * wander(time, 0.041, 0.0289, 0.0223, 4.0) * (1 - pinwheel)

    const hueAngle = TAU * 0.09 * wander(time, 0.029, 0.0437, 0.0151, 6.0) * dt
    const decay = Math.exp(-(0.26 + 0.06 * wander(time, 0.033, 0.019, 0.071, 7.0)) * dt)
    const hc = Math.cos(hueAngle)
    const hs = Math.sin(hueAngle) / SQRT3
    const grey = (1 - hc) / 3

    const swirl = (0.07 + 0.06 * wander(time, 0.045, 0.0261, 0.0137, 8.0)) * dt
    const threshold = 0.4 + 0.24 * wander(time, 0.057, 0.0331, 0.0207, 9.0)
    const fieldAngle = time * 0.05
    const fieldScale = 0.2 + 0.08 * Math.sin(time * 0.037)

    const o1 = lissajous(time, 0.31, 0.43, 0.0, 0.9)
    const o2 = lissajous(time, 0.23, 0.37, 2.1, 0.8)
    const o3 = lissajous(time, 0.41, 0.29, 4.2, 0.7)
    const o4 = lissajous(time, 0.19, 0.53, 5.5, 0.95)
    const e1 = lissajous(time, 0.27, 0.35, 3.0, 0.85)
    const e2 = lissajous(time, 0.37, 0.25, 0.9, 0.75)
    const r1 = lissajous(time, 0.17, 0.21, 1.0, 0.6)
    const r2 = lissajous(time, 0.13, 0.27, 3.3, 0.75)
    const ra = lissajous(time, 0.29, 0.33, 0.7, 0.85)
    const rb = lissajous(time, 0.29, 0.33, 1.6, 0.85)
    const orbR = (i: number): number =>
      (0.14 + 0.05 * Math.sin(time * (0.5 + 0.13 * i) + i * 1.9)) * (1 + 0.25 * Math.sin(time * (4.1 + 0.7 * i)))
    const pulse = (hz: number, offset: number): number => smooth(0.2, 0.8, Math.sin(time * TAU * hz + offset))
    const invSq = (r: number): number => 1 / (r * r)
    const ringR1 = 0.3 + 0.12 * Math.sin(time * 0.23)
    const ringR2 = 0.2 + 0.08 * Math.sin(time * 0.31 + 2.0)

    return {
      u_xf: [cs, -sn, sn, cs],
      u_ctr: [ctrX, ctrY],
      u_hueM: [(hc + grey) * decay, (grey - hs) * decay, (grey + hs) * decay],
      u_rates: [swirl, 1 - Math.exp(-0.5 * dt), 1 - Math.exp(-30 * dt), dt > 0 ? 1 / 255 : 0],
      u_swirl: [(time * 0.21) % TAU, (time * 0.17) % TAU, (time * 0.29) % TAU, (time * 0.13) % TAU],
      u_sym: [mirror * live, pinwheel * live],
      u_gain: [5 * dt, threshold, 0.4 * dt],
      u_field: [fieldScale * Math.cos(fieldAngle), fieldScale * Math.sin(fieldAngle), (time * 0.045) % 1],
      u_pulse: [pulse(0.83, 0.0), pulse(1.07, 2.0)],
      u_dither: ditherPhase,
      u_hue: (time * 0.23) % 1,
      u_o1: [o1[0], o1[1], invSq(orbR(1))],
      u_o2: [o2[0], o2[1], invSq(orbR(2))],
      u_o3: [o3[0], o3[1], invSq(orbR(3))],
      u_o4: [o4[0], o4[1], invSq(orbR(4))],
      u_e1: [e1[0], e1[1], invSq(orbR(5))],
      u_e2: [e2[0], e2[1], invSq(orbR(6))],
      u_r1: [r1[0], r1[1], ringR1, 1 / 0.05],
      u_r2: [r2[0], r2[1], ringR2, 1 / 0.04],
      u_rib: [ra[0], ra[1], rb[0], rb[1]],
      u_ribW: invSq(0.05),
    }
  },
}

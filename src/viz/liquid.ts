import type { UniformValues, Visualization } from './types'

const TAU = Math.PI * 2
const BLOBS = 6

/** Golden-ratio spread keeps the per-blob rates and offsets incommensurate. */
function spread(i: number, k: number): number {
  return (i * 0.6180339887 + k * 0.3819660113 + i * k * 0.2360679775) % 1
}

/** Blob centre and squared radius on a slow two-term Lissajous path covering the 16:9 frame. */
function blob(time: number, layer: number, i: number): readonly [number, number, number] {
  const s = (k: number): number => spread(i + layer * 7, k)
  const dir = layer === 0 ? 1 : -1
  const x =
    1.45 * Math.sin(dir * time * (0.016 + 0.017 * s(1)) + TAU * s(2)) +
    0.45 * Math.sin(time * (0.037 + 0.03 * s(3)) + TAU * s(4))
  const y =
    0.78 * Math.sin(dir * time * (0.014 + 0.02 * s(5)) + TAU * s(6)) +
    0.3 * Math.sin(time * (0.034 + 0.037 * s(7)) + TAU * s(8))
  const r = 0.4 + 0.1 * layer + 0.15 * Math.sin(time * (0.06 + 0.07 * s(9)) + TAU * s(10))
  return [x, y, r * r]
}

/** Two wave vectors that slowly turn, so the whole warp field swirls. */
function waves(angle: number, f1: number, f2: number): readonly [number, number, number, number] {
  return [Math.cos(angle) * f1, Math.sin(angle) * f1, -Math.sin(angle + 0.6) * f2, Math.cos(angle + 0.6) * f2]
}

const FRAGMENT = `
uniform vec3 u_a0;
uniform vec3 u_a1;
uniform vec3 u_a2;
uniform vec3 u_a3;
uniform vec3 u_a4;
uniform vec3 u_a5;
uniform vec3 u_b0;
uniform vec3 u_b1;
uniform vec3 u_b2;
uniform vec3 u_b3;
uniform vec3 u_b4;
uniform vec3 u_b5;
uniform vec4 u_wa1;
uniform vec4 u_wa2;
uniform vec4 u_wb1;
uniform vec4 u_wb2;
uniform vec4 u_pa;
uniform vec4 u_pb;
uniform vec4 u_wg;
uniform vec2 u_pg;
uniform vec3 u_flow;
uniform vec2 u_light;

/** Accumulates one metaball into (gradient.xy, field). */
vec3 ball(vec2 q, vec3 c) {
  vec2 d = q - c.xy;
  float inv = 1.0 / (dot(d, d) + c.z);
  float w = c.z * inv;
  w *= w;
  return vec3(-4.0 * w * inv * d, w);
}

/** Soft staircase with period 1: turns a smooth ramp into nested bands. */
float bands(float t) {
  return t - 0.125 * sin(TAU * t);
}

/** Signed distance estimate to the blob edge (xy: unit gradient, z: distance, w: field). */
vec4 edge(vec3 f) {
  float g = sqrt(dot(f.xy, f.xy) + 1e-4);
  return vec4(f.xy / g, (f.z - 0.25) / g, f.z);
}

vec3 viz(vec2 p, vec2 uv) {
  float px = 2.0 / u_resolution.y;

  vec2 qa = p + 0.30 * sin(vec2(dot(p, u_wa1.xy), dot(p, u_wa1.zw)) + u_pa.xy);
  qa += 0.16 * sin(vec2(dot(qa, u_wa2.xy), dot(qa, u_wa2.zw)) + u_pa.zw);
  vec2 qb = p + 0.34 * sin(vec2(dot(p, u_wb1.xy), dot(p, u_wb1.zw)) + u_pb.xy);
  qb += 0.14 * sin(vec2(dot(qb, u_wb2.xy), dot(qb, u_wb2.zw)) + u_pb.zw);

  vec4 a = edge(ball(qa, u_a0) + ball(qa, u_a1) + ball(qa, u_a2) + ball(qa, u_a3) + ball(qa, u_a4) + ball(qa, u_a5));
  vec4 b = edge(ball(qb, u_b0) + ball(qb, u_b1) + ball(qb, u_b2) + ball(qb, u_b3) + ball(qb, u_b4) + ball(qb, u_b5));

  vec2 qg = qa + qb - p;
  float g = sin(dot(qg, u_wg.xy) + u_pg.x);
  g += sin(dot(qg, u_wg.zw) + u_pg.y + 1.4 * g);

  float aa = 1.5 * px;
  float ma = smoothstep(-aa, aa, a.z);
  float mb = smoothstep(-aa, aa, b.z);

  vec3 bg = palette(bands(1.7 * g + 1.6 * (a.w + b.w) + u_flow.z));
  bg *= 0.7 + 0.1 * g;

  vec3 ca = palette(bands(2.2 * a.w + 0.18 * g - u_flow.x) + 0.33);
  vec3 cb = palette(bands(1.9 * b.w - 0.22 * g + ma * (1.5 * a.w + 0.15) + u_flow.y) + 0.71);

  float la = 0.5 + 0.5 * dot(a.xy, u_light);
  float lb = 0.5 + 0.5 * dot(b.xy, u_light);

  float ia = smoothstep(0.0, 0.14, a.z);
  float ib = smoothstep(0.0, 0.14, b.z);
  ca *= 0.72 + 0.28 * ia;
  cb *= 0.72 + 0.28 * ib;

  float glossA = smoothstep(0.02, 0.06, a.z) * (1.0 - smoothstep(0.06, 0.2, a.z)) * la * la;
  float glossB = smoothstep(0.02, 0.06, b.z) * (1.0 - smoothstep(0.06, 0.2, b.z)) * lb * lb;
  ca += 0.3 * glossA * glossA;
  cb += 0.3 * glossB * glossB;

  vec3 col = bg * (1.0 - (0.15 + 0.4 * la) * smoothstep(-0.14, 0.0, a.z));
  col = mix(col, ca, ma);
  col *= 1.0 - (0.15 + 0.4 * lb) * smoothstep(-0.14, 0.0, b.z) * (1.0 - mb);
  col = mix(col, cb, mb);

  float rw = 0.022;
  float ra = 1.0 - smoothstep(0.0, rw, abs(a.z - 0.012));
  float rb = 1.0 - smoothstep(0.0, rw, abs(b.z - 0.012));
  col += ra * ra * (0.25 + 0.75 * la * la) * mix(ca, vec3(1.0), 0.55);
  col += rb * rb * (0.25 + 0.75 * lb * lb) * mix(cb, vec3(1.0), 0.55);

  return col;
}
`

export const liquid: Visualization = {
  id: 'liquid',
  name: 'Liquid Light',
  fragment: FRAGMENT,
  uniforms(time) {
    const values: Record<string, readonly number[]> = {}
    for (let i = 0; i < BLOBS; i++) {
      values['u_a' + i] = blob(time, 0, i)
      values['u_b' + i] = blob(time, 1, i)
    }
    const swirl = (time * 0.013) % TAU
    const lightAngle = (time * 0.031) % TAU
    const out: UniformValues = {
      ...values,
      u_wa1: waves(swirl, 1.9, 1.5),
      u_wa2: waves(swirl * 2 + 1.3, 3.4, 2.9),
      u_wb1: waves(-swirl + 2.1, 1.6, 2.1),
      u_wb2: waves(-swirl * 3 + 0.4, 3.1, 3.7),
      u_wg: waves(swirl + 4.0, 1.3, 1.7),
      u_pa: [(time * 0.11) % TAU, (time * 0.083) % TAU, (time * 0.171) % TAU, (time * 0.139) % TAU],
      u_pb: [(time * 0.097) % TAU, (time * 0.123) % TAU, (time * 0.153) % TAU, (time * 0.187) % TAU],
      u_pg: [(time * 0.071) % TAU, (time * 0.059) % TAU],
      u_flow: [(time * 0.043) % 1, (time * 0.037) % 1, (time * 0.017) % 1],
      u_light: [Math.cos(lightAngle), Math.sin(lightAngle)],
    }
    return out
  },
}

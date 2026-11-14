import type { Visualization } from './types'

const TAU = Math.PI * 2

/** Forward speed in depth units per second. */
const SPEED = 0.25
const RING_DENSITY = 2
const WOBBLE_DENSITY = 1.3
const COLOUR_DENSITY = 0.22

const TWIST_BASE = 1.15
const TWIST_A = 0.8
const TWIST_A_RATE = TAU / 151
const TWIST_B = 0.3
const TWIST_B_RATE = TAU / 67

const MORPH_RATE = TAU / 173
const ARM_COUNTS = [8, 6, 10, 5, 12, 7]

function wrap(x: number, period: number): number {
  return ((x % period) + period) % period
}

function saturate(x: number): number {
  return Math.min(1, Math.max(0, x))
}

export const wormhole: Visualization = {
  id: 'wormhole',
  name: 'Wormhole',
  fragment: `
uniform vec4 u_axis;
uniform vec4 u_lobe;
uniform vec4 u_spiral;
uniform vec4 u_flow;
uniform vec4 u_morph;
uniform vec4 u_tint;

const float DEPTH = 0.8;
const float RING_DENSITY = ${RING_DENSITY.toFixed(1)};
const float WOBBLE_DENSITY = ${WOBBLE_DENSITY.toFixed(1)};
const float COLOUR_DENSITY = ${COLOUR_DENSITY.toFixed(2)};

// Antialiased pulse wave in [-1, 1] with period 1; w is the change of x per pixel.
// gone = 0 is a square wave; as gone rises the -1 slits narrow and fade out, leaving solid +1.
// Fades to its mean once too fine to resolve. edge is the distance in x to the nearest band edge.
float bands(float x, float w, float gone, out float edge) {
  float thr = 0.25 - 0.3 * gone;
  float t = abs(fract(x) - 0.5);
  edge = abs(t - thr) + 0.5 * smoothstep(0.05, 0.45, gone);
  float s = clamp((t - thr) / w, -1.0, 1.0);
  s = mix(s, clamp(1.0 - 4.0 * thr, -1.0, 1.0), smoothstep(0.12, 0.4, w));
  return mix(s, 1.0, smoothstep(0.45, 0.85, gone));
}

// Cheap upper estimate of length(vec2(a, b)) for a, b >= 0.
float aniso(float a, float b) {
  return max(a, b) + 0.42 * min(a, b);
}

vec3 viz(vec2 p, vec2 uv) {
  vec2 q = p - u_axis.xy;
  q -= u_axis.zw / (1.0 + 3.0 * dot(q, q));
  float d2 = max(dot(q, q), 1e-6);
  float inv = 1.0 / d2;
  float c2 = (q.x * q.x - q.y * q.y) * inv;
  float s2 = 2.0 * q.x * q.y * inv;
  float lobes = dot(u_lobe, vec4(c2, s2, c2 * c2 - s2 * s2, 2.0 * c2 * s2));
  float r = sqrt(d2) * (1.0 + lobes);
  float z = DEPTH / r;
  float ang = atan(q.y, abs(q.x) < 1e-6 ? 1e-6 : q.x) / TAU;

  float px = 2.0 / u_resolution.y;
  float dAng = px / (TAU * r);
  float dz = px * DEPTH / (r * r);

  float arms = u_spiral.x;
  float wobble = u_spiral.w * sin(WOBBLE_DENSITY * z + u_flow.y);
  float xs = arms * (ang + wobble) + u_spiral.y * z + u_spiral.z;
  float ws = aniso(arms * dAng, (abs(u_spiral.y) + arms * u_spiral.w * WOBBLE_DENSITY) * dz);
  float xr = RING_DENSITY * z + u_flow.x + u_morph.w * sin(TAU * 3.0 * ang + u_flow.w);
  float wr = aniso(RING_DENSITY * dz, u_morph.w * 3.0 * TAU * dAng);

  ws = max(ws, 1e-4);
  wr = max(wr, 1e-4);
  float es;
  float er;
  float spiral = bands(xs, ws, u_morph.x, es);
  float rings = bands(xr, wr, u_morph.y, er);
  float mask = 0.5 + 0.5 * spiral * rings;

  float e = min(es, er);
  float we = es < er ? ws : wr;
  float inset = clamp((e - 0.055) / we + 0.5, 0.0, 1.0) * clamp((0.115 - e) / we + 0.5, 0.0, 1.0);
  inset *= u_morph.z * (1.0 - smoothstep(0.009, 0.028, we));

  float tg = ang + wobble + COLOUR_DENSITY * z + u_flow.z;
  vec3 warm = palette(tg);
  vec3 cool = palette(tg + u_tint.x);
  vec3 shade = mix(cool * cool * 0.22, cool, u_tint.y);
  vec3 col = mix(shade, warm, mask);
  col = mix(col, mix(warm, cool, mask), inset);

  float h = fract(xr);
  float rib = 1.0 - u_tint.w * (1.0 - 4.0 * h * (1.0 - h)) * (1.0 - smoothstep(0.1, 0.35, wr));
  col *= rib;

  float haze = smoothstep(0.14, 0.4, max(ws * (1.0 - u_morph.x), wr * (1.0 - u_morph.y)));
  float fog = 1.0 - (1.0 - 0.03 / (0.03 + r * r)) * (1.0 - 0.65 * haze);
  vec3 glow = mix(palette(u_tint.z + 0.7 * r), vec3(1.0), 0.3);
  col = mix(col, glow, fog);
  col += glow * 0.12 * fog;
  return col;
}
`,
  uniforms(time) {
    const twist = TWIST_BASE + TWIST_A * Math.sin(time * TWIST_A_RATE) + TWIST_B * Math.sin(time * TWIST_B_RATE + 1.7)
    const travelled =
      SPEED * TWIST_BASE * time -
      SPEED *
      ((TWIST_A / TWIST_A_RATE) * Math.cos(time * TWIST_A_RATE) +
        (TWIST_B / TWIST_B_RATE) * Math.cos(time * TWIST_B_RATE + 1.7))

    const morph = time * MORPH_RATE - 0.5
    const ringsOnly = saturate(2.5 * (Math.sin(morph) - 0.62))
    const spiralOnly = Math.min(saturate(2.5 * (Math.sin(time * (TAU / 109) + 3.4) - 0.5)), 1 - ringsOnly)
    const dark = 0.5 + 0.5 * Math.sin(time * 0.027 + 3.6)
    const insetAmount = saturate(0.5 + 1.4 * Math.sin(time * 0.033 + 0.4))
    const cycle = Math.floor((morph - Math.PI / 2) / TAU)
    const arms = ARM_COUNTS[wrap(cycle, ARM_COUNTS.length)]

    const ellipse = 0.13 * (0.5 + 0.5 * Math.sin(time * 0.031))
    const ellipseAngle = time * 0.05
    const square = 0.1 * Math.max(0, Math.sin(time * 0.023 + 1))
    const squareAngle = -time * 0.037

    return {
      u_axis: [
        0.36 * Math.sin(time * 0.071),
        0.2 * Math.sin(time * 0.093 + 1),
        0.24 * Math.sin(time * 0.053 + 2),
        0.17 * Math.cos(time * 0.067),
      ],
      u_lobe: [
        ellipse * Math.cos(ellipseAngle),
        ellipse * Math.sin(ellipseAngle),
        square * Math.cos(squareAngle),
        square * Math.sin(squareAngle),
      ],
      u_spiral: [arms, twist, wrap(travelled + time * 0.017, 1), 0.012 + 0.035 * (0.5 + 0.5 * Math.sin(time * 0.043))],
      u_flow: [
        wrap(RING_DENSITY * SPEED * time, 1),
        wrap(WOBBLE_DENSITY * SPEED * time, TAU),
        wrap(COLOUR_DENSITY * SPEED * time + time * 0.013, 1),
        wrap(time * 0.11, TAU),
      ],
      u_morph: [ringsOnly, spiralOnly, insetAmount, 0.12 * Math.max(0, Math.sin(time * 0.029 + 4))],
      u_tint: [
        0.5 + 0.17 * Math.sin(time * 0.019),
        dark * dark * dark * (dark * (6 * dark - 15) + 10),
        wrap(time * 0.021, 1),
        0.45 * (1 - spiralOnly) * (0.5 + 0.5 * Math.sin(time * 0.037 + 2)),
      ],
    }
  },
}

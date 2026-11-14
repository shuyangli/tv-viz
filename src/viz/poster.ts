import type { Visualization } from './types'

const TAU = Math.PI * 2
const INKS = 7

const wrap = (time: number, rate: number, period: number): number => (time * rate) % period

export const poster: Visualization = {
  id: 'poster',
  name: 'Fillmore',
  fragment: `
uniform vec4 u_warp;
uniform vec4 u_sun;
uniform vec4 u_ph;
uniform vec4 u_fl;
uniform vec4 u_dr;
uniform float u_halo;

const float RAYS = 18.0;
const float RAY_STEP = 4.0 / 9.0;
const float INK_STEP = 3.0 / 7.0;
const vec3 KEYLINE = vec3(0.07, 0.0, 0.13);

// x is a position in band units and w a pixel in the same units:
// (band index, nearest neighbour index, blend towards the neighbour, distance to the nearest edge).
vec4 bands(float x, float w) {
  float i = floor(x);
  float f = x - i;
  float e = min(f, 1.0 - f);
  return vec4(i, i + step(0.5, f) * 2.0 - 1.0, 0.5 - 0.5 * clamp(e / w, 0.0, 1.0), e);
}

float stroke(float d, float halfWidth, float aa) {
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(d));
}

vec3 viz(vec2 p, vec2 uv) {
  float px = 2.4 / u_resolution.y;

  vec2 q = p;
  q.x += 0.11 * sin(p.y * 2.1 + u_warp.x) + 0.06 * sin(p.y * 4.3 + p.x * 1.7 - u_warp.y);
  q.y += 0.11 * sin(p.x * 1.8 + u_warp.z) + 0.06 * sin(p.x * 3.9 - p.y * 2.2 + u_warp.w);

  vec2 v = q - u_sun.xy;
  v.x += 1e-4 * step(abs(v.x), 0.0);
  float r = length(v);
  float a = atan(v.y, v.x);

  float wob = 0.35 * sin(r * 3.2 - u_ph.x);
  vec4 ray = bands(a * (RAYS / TAU) + u_sun.w + wob, px * RAYS / (TAU * max(r, 0.05)));
  vec4 halo = bands(r * 1.3 - u_halo + 0.25 * wob, px * 1.3);
  float flip = 0.5 * mod(halo.x, 2.0);
  float tA = ray.x * RAY_STEP + flip;
  float tB = ray.y * RAY_STEP + flip;
  float blend = ray.z;
  float line = max(stroke(halo.w, 0.012, px * 1.3), stroke(ray.w * r, 0.02, px * RAYS / TAU));
  float trim = 0.0;

  float ds = r - u_sun.z - 0.045 * sin(a * 6.0 + u_ph.y);
  vec4 ring = bands(r * 8.0 - u_ph.z, px * 8.0);
  float inSun = step(ds, 0.0);
  tA = mix(tA, ring.x * INK_STEP + 0.19, inSun);
  tB = mix(tB, ring.y * INK_STEP + 0.19, inSun);
  blend = mix(blend, ring.z, inSun);
  line = max(line * (1.0 - inSun), stroke(ds, 0.013, px));
  trim = stroke(ds + 0.038, 0.008, px);

  float xf = q.x + (0.04 + 0.09 * (p.y + 1.0)) * sin(p.y * 4.4 + u_fl.x);
  float sf = sin(xf * 3.7 + u_fl.y);
  float rf = sqrt(sf * sf + 0.03);
  float af = u_fl.w + 0.34 * sin(xf * 1.3 + u_fl.z);
  float gf = af * 3.7;
  float lf = af * (1.0 - rf) - 1.1 - p.y;
  float df = lf * inversesqrt(1.0 + gf * gf * sf * sf * (1.0 - sf * sf) / (rf * rf));
  vec4 fl = bands(lf * 2.6 + u_ph.w, px * 6.5);
  float inFlame = step(0.0, df);
  tA = mix(tA, fl.x * INK_STEP + 0.62, inFlame);
  tB = mix(tB, fl.y * INK_STEP + 0.62, inFlame);
  blend = mix(blend, fl.z, inFlame);
  line = max(line * (1.0 - inFlame), max(stroke(df, 0.013, px), inFlame * stroke(fl.w, 0.04, px * 5.0)));
  trim = max(trim * (1.0 - inFlame), stroke(df - 0.038, 0.008, px));

  float xd = q.x + 0.06 * sin(p.y * 2.6 + u_dr.x);
  float sd = abs(sin(xd * 3.1 + u_dr.y));
  float ad = 0.45 + 0.3 * sin(xd * 1.9 + u_dr.z);
  float gd = ad * 3.1 * (2.0 - 2.0 * sd);
  float dd = (p.y - 1.08 + ad * sd * (2.0 - sd)) * inversesqrt(1.0 + gd * gd * (1.0 - sd * sd));
  vec4 dr = bands(dd * 7.5 + u_dr.w, px * 7.5);
  float inDrip = step(0.0, dd);
  tA = mix(tA, dr.x * INK_STEP + 0.4, inDrip);
  tB = mix(tB, dr.y * INK_STEP + 0.4, inDrip);
  blend = mix(blend, dr.z, inDrip);
  line = max(line * (1.0 - inDrip), max(stroke(dd, 0.013, px), inDrip * stroke(dr.w, 0.04, px * 7.5)));
  trim = max(trim * (1.0 - inDrip), stroke(dd - 0.038, 0.008, px));

  vec3 col = mix(palette(tA), palette(tB), blend);
  col = mix(col, 1.0 - col, trim * (1.0 - line));
  return mix(col, KEYLINE, line);
}
`,
  uniforms(time) {
    return {
      u_warp: [wrap(time, 0.23, TAU), wrap(time, 0.17, TAU), wrap(time, 0.19, TAU), wrap(time, 0.29, TAU)],
      u_sun: [
        0.7 * Math.sin(time * 0.043),
        0.12 + 0.3 * Math.sin(time * 0.031 + 1.3),
        0.46 + 0.1 * Math.sin(time * 0.071),
        wrap(time, 0.15, 9),
      ],
      u_ph: [wrap(time, 0.41, TAU), wrap(time, -0.13, TAU), wrap(time, 0.3, INKS), wrap(time, 0.26, INKS)],
      u_fl: [
        wrap(time, 0.67, TAU),
        wrap(time, 0.058, TAU),
        wrap(time, 0.093, TAU),
        0.72 + 0.2 * Math.sin(time * 0.047),
      ],
      u_halo: wrap(time, 0.11, 2),
      u_dr: [wrap(time, 0.37, TAU), wrap(time, -0.041, TAU), wrap(time, 0.077, TAU), wrap(time, 0.21, INKS)],
    }
  },
}

import type { Visualization } from './types'

const TAU = Math.PI * 2

/** Petal-tip radius of each ring, outermost first; the first keeps its valleys beyond the screen corners. */
const RADII = [3.0, 2.3, 1.78, 1.38, 1.07, 0.83, 0.63, 0.46, 0.32, 0.19]

/** Petals per ring; the shader's ring() calls use the same counts. */
const PETALS = [24, 24, 18, 18, 12, 18, 12, 12, 6, 6]

const wrap = (time: number, rate: number, period = 1): number => (time * rate) % period

export const mandala: Visualization = {
  id: 'mandala',
  name: 'Mandala',
  fragment: `
uniform vec4 u_r0;
uniform vec4 u_r1;
uniform vec4 u_r2;
uniform vec4 u_r3;
uniform vec4 u_r4;
uniform vec4 u_r5;
uniform vec4 u_r6;
uniform vec4 u_r7;
uniform vec4 u_r8;
uniform vec4 u_r9;
uniform vec4 u_c0;
uniform vec4 u_c1;
uniform vec4 u_c2;
uniform vec4 u_c3;
uniform vec4 u_c4;
uniform vec4 u_c5;
uniform vec4 u_c6;
uniform vec4 u_c7;
uniform vec4 u_c8;
uniform vec4 u_c9;
uniform vec4 u_th;
uniform vec4 u_hue;

// Tests one ring of mirrored petals; x is the petal coordinate.
// s = (tip radius, shortening of every other petal, tip sharpness, hue),
// c = petal outline and gradient coefficients.
// The topmost ring containing the pixel ends up in sel = (depth inside the
// petal as a fraction of its radius, across-petal coordinate, hue, radius) and
// sw; aux = (distance to the nearest visible outline, the same relative to
// ring radius, radial gap to the nearest petal above).
void ring(inout vec4 sel, inout vec3 aux, inout float sw, float r, float x, vec4 s, vec4 c) {
  if (r < s.x * 1.1) {
    float f = abs(fract(x) - 0.5) * 2.0;
    float e = abs(fract(x * 0.5 + 0.25) - 0.5) * 2.0;
    float rl = s.x - s.y * e * e * (3.0 - 2.0 * e);
    float f2 = f * f;
    float body = 1.0 - f * (c.x + c.y * f2);
    float gap = r - rl * body;
    float inv = 1.0 / rl;
    float dn = gap * body / (body + c.z + c.w * f2);
    vec3 d = vec3(dn, dn * inv, gap * inv);
    if (gap < 0.0) {
      sel = vec4(-d.y, f, s.w, rl);
      aux = vec3(-d.xy, 9.0);
      sw = s.z;
    } else {
      aux = min(aux, d);
    }
  }
}

vec3 viz(vec2 p, vec2 uv) {
  float r = length(p);
  float a = atan(p.y, p.x) / TAU;
  vec4 sel = vec4(1.0, 0.0, 0.0, 1.0);
  vec3 aux = vec3(9.0);
  float sw = 0.5;

  ring(sel, aux, sw, r, (a + u_th.x) * 24.0, u_r0, u_c0);
  ring(sel, aux, sw, r, (a - u_th.y) * 24.0, u_r1, u_c1);
  ring(sel, aux, sw, r, (a + u_th.z) * 18.0, u_r2, u_c2);
  ring(sel, aux, sw, r, (a - u_th.x - u_th.z) * 18.0, u_r3, u_c3);
  ring(sel, aux, sw, r, (a + u_th.y) * 12.0, u_r4, u_c4);
  ring(sel, aux, sw, r, (a - u_th.w) * 18.0, u_r5, u_c5);
  ring(sel, aux, sw, r, (a + u_th.w + u_th.x) * 12.0, u_r6, u_c6);
  ring(sel, aux, sw, r, (a - u_th.y - u_th.w) * 12.0, u_r7, u_c7);
  ring(sel, aux, sw, r, (a + u_th.z + u_th.w) * 6.0, u_r8, u_c8);
  ring(sel, aux, sw, r, (a - u_th.x - u_th.w) * 6.0, u_r9, u_c9);

  float u = sel.x;
  float f = sel.y;
  float px = 3.0 / u_resolution.y;
  float lw = max(px / sel.w, 0.012);
  float rimW = 0.045 + 0.025 * sw;
  float coreW = rimW + 0.11 + 0.06 * sw;
  float inner = step(rimW, u);
  float core = step(coreW, u);
  float deep = smoothstep(coreW, coreW + 0.3, u);

  float t = sel.z + inner * (0.3 + u_hue.z * u + 0.12 * f * (1.0 - deep)) + core * 0.22;
  float v = 1.0 - inner * (0.3 - 0.3 * core) - 0.25 * deep;
  v *= 1.12 - 0.3 * f * f * inner;
  v *= mix(0.15, 1.0, smoothstep(0.0, lw, abs(u - rimW)));
  v *= mix(0.3, 1.0, smoothstep(0.0, lw, abs(u - coreW)));
  v *= mix(0.45, 1.0, smoothstep(0.0, 0.1, aux.z));
  float line = clamp(min(aux.x / px, aux.y / 0.012), 0.0, 1.0);
  v *= mix(0.03, 1.0, line * line * (3.0 - 2.0 * line));

  // Central seed: a two-band disc of radius u_hue.x over the innermost petals.
  float j = r / u_hue.x - 1.0;
  float seed = step(j, 0.0);
  float eye = step(j, -0.5);
  t = mix(t, u_hue.y + 0.35 * eye - 0.2 * j, seed);
  v = mix(v * mix(0.45, 1.0, smoothstep(0.0, 0.7, j)), 1.0, seed);
  float jw = px / u_hue.x;
  v *= mix(0.03, 1.0, smoothstep(0.0, jw, abs(j)));
  v *= mix(0.2, 1.0, smoothstep(0.0, jw, abs(j + 0.5)));

  vec3 col = palette(t + u_hue.w);
  float grey = dot(col, vec3(0.3333));
  return mix(vec3(grey), col, 2.0 - min(v, 1.0)) * v;
}
`,
  uniforms(time) {
    const breath = wrap(time, 0.19, TAU)
    const swell = wrap(time, 0.071, TAU)
    const depth = wrap(time, 0.113, TAU)
    const split = wrap(time, 0.047, TAU)
    const sharp = wrap(time, 0.061, TAU)
    const hueA = wrap(time, 0.0137)
    const hueB = wrap(time, -0.0091)

    const rings: Record<string, number[]> = {}
    for (let i = 0; i < RADII.length; i++) {
      const outer = i === 0 ? 0.4 : 1
      const radius =
        RADII[i] * (1 + outer * (0.05 * Math.sin(breath + i * 0.85) + 0.03 * Math.sin(swell - i * 1.9)))
      const petal = i === 0 ? 0.2 + 0.04 * Math.sin(depth) : 0.34 + 0.13 * Math.sin(depth + i * 2.3)
      const s = 0.5 + 0.5 * Math.sin(split + i * 1.7)
      const alt = i === 0 ? 0 : 0.3 * s * s * (3 - 2 * s)
      const point = 0.5 + 0.42 * Math.sin(sharp + i * 2.9)
      const hue = ((i % 2 === 0 ? hueA : hueB) + i * 0.17) % 1
      const slope = (0.6 * PETALS[i]) / Math.PI
      rings['u_r' + i] = [radius, radius * alt, point, hue]
      rings['u_c' + i] = [petal * point, petal * (1 - point), slope * petal * point, slope * 3 * petal * (1 - point)]
    }

    return {
      ...rings,
      u_th: [wrap(time, 1 / 173), wrap(time, 1 / 107), wrap(time, 1 / 71), wrap(time, 1 / 43)],
      u_hue: [0.05 + 0.012 * Math.sin(wrap(time, 0.27, TAU)), wrap(time, 0.021), 0.45 + 0.3 * Math.sin(wrap(time, 0.083, TAU)), wrap(time, 0.052)],
    }
  },
}

export type Vec2 = readonly [number, number]

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Interpolates in log space so zooms feel constant-rate instead of front-loaded. */
export function logLerp(a: number, b: number, t: number): number {
  return Math.exp(lerp(Math.log(a), Math.log(b), t))
}

export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

export const TWO_PI = Math.PI * 2

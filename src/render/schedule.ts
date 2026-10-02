import { clamp } from '../scene/math'

/**
 * Keyframes are laid out along the zoom, not along time: keyframe k is rendered for the
 * camera at KEYFRAME_SPACING doublings below keyframe k-1, and is on screen from
 * DISSOLVE units before that scale (fading in over the previous keyframe) until the next
 * one has faded in. Nothing in a keyframe changes while it is shown except a continuous
 * magnification, so the sampling noise of chaotic regions holds still instead of
 * re-rolling with every refresh, and the refresh itself is a slow crossfade.
 */
export const KEYFRAME_SPACING = 0.4
/** Fraction of the spacing over which an incoming keyframe fades in. */
export const DISSOLVE = 0.3
/** Extra extent around the screen for camera drift and spin while a keyframe is shown. */
const COVER_MARGIN = 0.04
/** Keyframe extent relative to the screen at its own scale: it must cover the screen from the start of its fade-in. */
export const KEYFRAME_COVER = Math.pow(2, DISSOLVE * KEYFRAME_SPACING) * (1 + COVER_MARGIN)
/** Fraction of the time until a keyframe is due that its render is planned to take. */
const SAFETY = 0.75
/** Fewest frames a keyframe is planned over: a first keyframe after a cut, or one already overdue. */
export const MIN_KEYFRAME_FRAMES = 20
/** Planning horizon while paused, when a keyframe has forever. */
const MAX_KEYFRAME_FRAMES = 600
/** Supersampling is only worth its cost once the keyframe is close to screen density. */
const SUPERSAMPLE_MIN_DENSITY = 0.85
const MIN_DENSITY = 0.25
export const MAX_DENSITY = 1

/** Zoom position in keyframe units: 0 at the first keyframe's camera scale, growing as the zoom deepens. */
export function scheduleU(log2Start: number, log2Scale: number): number {
  return (log2Start - log2Scale) / KEYFRAME_SPACING
}

/**
 * Weight of keyframe `index` while it fades in. The fade starts DISSOLVE units before its
 * camera scale, or when it became ready if that is later, and always lasts DISSOLVE units
 * so a late keyframe still arrives smoothly.
 */
export function dissolveWeight(u: number, index: number, readyU: number): number {
  const start = Math.max(index - DISSOLVE, readyU)
  return clamp((u - start) / DISSOLVE, 0, 1)
}

/**
 * Index of the next keyframe to render. Normally the one after the newest, but when the
 * render would finish more than a unit after that keyframe is due, indices are skipped
 * so a too-slow GPU falls at most one keyframe behind instead of ever further.
 */
export function nextKeyframeIndex(newestIndex: number | null, u: number, renderUnits: number): number {
  const sequential = newestIndex === null ? 0 : newestIndex + 1
  return Math.max(sequential, Math.ceil(u + renderUnits + DISSOLVE - 1))
}

export interface KeyframeQuality {
  /** Texel density relative to the screen at the keyframe camera. */
  readonly density: number
  /** Escape-time samples per texel. */
  readonly samples: number
}

export interface QualityPins {
  readonly density: number | null
  readonly samples: number | null
}

const NO_PINS: QualityPins = { density: null, samples: null }

/** Frames until keyframe `index` is due to start fading in, from schedule position `u`; the horizon when paused. */
export function framesUntilDue(index: number, u: number, doublingsPerFrame: number): number {
  if (doublingsPerFrame <= 0) return MAX_KEYFRAME_FRAMES
  const frames = ((index - DISSOLVE - u) * KEYFRAME_SPACING) / doublingsPerFrame
  return clamp(frames, MIN_KEYFRAME_FRAMES, MAX_KEYFRAME_FRAMES)
}

/**
 * Chooses density and supersampling for a keyframe of `screenTexels` texels at density 1
 * from the samples the GPU can spend on it. Resolution comes first: supersampling is only
 * bought once the keyframe would be near screen density anyway.
 */
export function planQuality(
  samplesPerFrame: number,
  frames: number,
  screenTexels: number,
  pins: QualityPins = NO_PINS,
): KeyframeQuality {
  const available = samplesPerFrame * frames * SAFETY
  const densityFor = (samples: number): number => Math.sqrt(available / (samples * screenTexels))
  if (pins.density !== null && pins.samples !== null) return { density: pins.density, samples: pins.samples }
  if (pins.samples !== null) {
    return { density: clamp(densityFor(pins.samples), MIN_DENSITY, MAX_DENSITY), samples: pins.samples }
  }
  const density = pins.density
  for (const samples of [4, 2]) {
    const d = densityFor(samples)
    if (density !== null ? d >= density : d >= SUPERSAMPLE_MIN_DENSITY) {
      return { density: density !== null ? density : Math.min(MAX_DENSITY, d), samples }
    }
  }
  return { density: density !== null ? density : clamp(densityFor(1), MIN_DENSITY, MAX_DENSITY), samples: 1 }
}

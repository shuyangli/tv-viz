import { feedback } from './feedback'
import { liquid } from './liquid'
import { mandala } from './mandala'
import { poster } from './poster'
import type { Visualization } from './types'
import { wormhole } from './wormhole'

/** In ◀ ▶ order. */
export const VISUALIZATIONS: readonly Visualization[] = [liquid, mandala, wormhole, feedback, poster]

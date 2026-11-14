import type { Visualization } from './types'

export const wormhole: Visualization = {
  id: 'wormhole',
  name: 'Wormhole',
  fragment: `
uniform float u_phase;
vec3 viz(vec2 p, vec2 uv) {
  return palette(length(p) - u_phase);
}
`,
  uniforms(time) {
    return { u_phase: (time * 0.2) % 1 }
  },
}

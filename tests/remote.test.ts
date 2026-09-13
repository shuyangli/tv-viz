import { describe, expect, it } from 'vitest'
import { actionForKey } from '../src/input/remote'

describe('actionForKey', () => {
  it('maps LG remote key codes', () => {
    expect(actionForKey(461, 'Unidentified')).toBe('back')
    expect(actionForKey(13, 'Enter')).toBe('ok')
    expect(actionForKey(403, 'Unidentified')).toBe('red')
    expect(actionForKey(406, 'Unidentified')).toBe('blue')
    expect(actionForKey(415, 'Unidentified')).toBe('playPause')
  })

  it('falls back to desktop keys for development', () => {
    expect(actionForKey(27, 'Escape')).toBe('back')
    expect(actionForKey(32, ' ')).toBe('playPause')
    expect(actionForKey(82, 'r')).toBe('red')
  })

  it('returns null for unmapped keys', () => {
    expect(actionForKey(65, 'a')).toBeNull()
  })
})

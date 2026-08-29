import { describe, expect, it } from 'vitest'
import { normalizeSystemAccentColor } from './systemAccentColor'

describe('normalizeSystemAccentColor', () => {
  it('drops the alpha byte Electron appends to the OS accent', () => {
    // macOS/Windows report RGBA hex with no leading '#'. Carrying the alpha
    // through would compound with the alpha every consumer mixes in itself.
    expect(normalizeSystemAccentColor('1e90ffff')).toBe('#1E90FF')
    expect(normalizeSystemAccentColor('007AFF80')).toBe('#007AFF')
  })

  it('accepts the shapes a hand-written or shorthand value can arrive in', () => {
    expect(normalizeSystemAccentColor('#5a8cff')).toBe('#5A8CFF')
    expect(normalizeSystemAccentColor('  5a8cff  ')).toBe('#5A8CFF')
    expect(normalizeSystemAccentColor('#f0c')).toBe('#FF00CC')
    expect(normalizeSystemAccentColor('f0c8')).toBe('#FF00CC')
  })

  it('answers null when the platform has no accent to report', () => {
    // Not a failure — null means "leave --accent alone so the active theme's
    // own accent wins", which is what a Linux host should get.
    expect(normalizeSystemAccentColor('')).toBeNull()
    expect(normalizeSystemAccentColor(undefined)).toBeNull()
    expect(normalizeSystemAccentColor(null)).toBeNull()
    expect(normalizeSystemAccentColor(true)).toBeNull()
  })

  it('rejects lengths and characters that are not a colour', () => {
    expect(normalizeSystemAccentColor('12345')).toBeNull()
    expect(normalizeSystemAccentColor('1e90ffffff')).toBeNull()
    expect(normalizeSystemAccentColor('rgb(1,2,3)')).toBeNull()
    expect(normalizeSystemAccentColor('#nothex')).toBeNull()
  })
})

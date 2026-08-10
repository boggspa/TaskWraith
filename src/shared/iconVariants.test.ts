import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_VARIANTS,
  DEFAULT_APP_ICON_VARIANT,
  availableIconVariants,
  isAppIconVariant
} from './iconVariants'

describe('iconVariants', () => {
  it('exposes the four variants with monoline as the default', () => {
    expect(APP_ICON_VARIANTS.map((v) => v.id)).toEqual([
      'monoline',
      'regular',
      'glass',
      'lightMonoline'
    ])
    expect(DEFAULT_APP_ICON_VARIANT).toBe('monoline')
  })

  it('validates variant ids and rejects the retired wwdc26', () => {
    expect(isAppIconVariant('regular')).toBe(true)
    expect(isAppIconVariant('monoline')).toBe(true)
    expect(isAppIconVariant('glass')).toBe(true)
    expect(isAppIconVariant('lightMonoline')).toBe(true)
    expect(isAppIconVariant('wwdc26')).toBe(false)
    expect(isAppIconVariant('nope')).toBe(false)
    expect(isAppIconVariant(undefined)).toBe(false)
    expect(isAppIconVariant(null)).toBe(false)
  })

  it('offers every variant unconditionally (no limited-time gate remains)', () => {
    expect(availableIconVariants().map((v) => v.id)).toEqual([
      'monoline',
      'regular',
      'glass',
      'lightMonoline'
    ])
  })

  it('keeps the Swift twin in sync (drift guard)', () => {
    // iOS cannot import this module, so the variant set is duplicated in
    // AppIconVariant.swift. This guard fails CI if the two diverge.
    const swift = readFileSync(
      join(process.cwd(), 'ios/TaskWraithKit/Sources/TaskWraithUI/AppIconVariant.swift'),
      'utf8'
    )
    const cases = [...swift.matchAll(/^\s*case (\w+)$/gm)].map((m) => m[1])
    expect(cases.sort()).toEqual([...APP_ICON_VARIANTS.map((v) => v.id)].sort())
    expect(cases).not.toContain('wwdc26')
    // Monoline is the primary appiconset on iOS (nil = no alternate icon), and
    // the retired-variant fallback resolves to it.
    expect(swift).toMatch(/case \.monoline: return nil/)
    expect(swift).toMatch(/\?\? \.monoline/)
  })
})

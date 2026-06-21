import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_VARIANTS,
  DEFAULT_APP_ICON_VARIANT,
  WWDC26_AVAILABLE_UNTIL_MS,
  availableIconVariants,
  isAppIconVariant,
  isWwdc26IconAvailable
} from './iconVariants'

describe('iconVariants', () => {
  it('exposes the three variants with regular as the default', () => {
    expect(APP_ICON_VARIANTS.map((v) => v.id)).toEqual(['regular', 'wwdc26', 'monoline'])
    expect(DEFAULT_APP_ICON_VARIANT).toBe('regular')
    expect(APP_ICON_VARIANTS.find((v) => v.id === 'wwdc26')?.limitedTime).toBe(true)
  })

  it('validates variant ids', () => {
    expect(isAppIconVariant('regular')).toBe(true)
    expect(isAppIconVariant('wwdc26')).toBe(true)
    expect(isAppIconVariant('monoline')).toBe(true)
    expect(isAppIconVariant('nope')).toBe(false)
    expect(isAppIconVariant(undefined)).toBe(false)
    expect(isAppIconVariant(null)).toBe(false)
  })

  it('pins the WWDC26 cutoff to 2026-09-01T00:00:00Z', () => {
    expect(WWDC26_AVAILABLE_UNTIL_MS).toBe(Date.UTC(2026, 8, 1))
    expect(new Date(WWDC26_AVAILABLE_UNTIL_MS).toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('offers WWDC26 before the cutoff and hides it after (auto mode)', () => {
    const before = Date.UTC(2026, 7, 31) // Aug 31 2026
    const after = Date.UTC(2026, 8, 2) // Sep 2 2026
    expect(isWwdc26IconAvailable(before)).toBe(true)
    expect(isWwdc26IconAvailable(after)).toBe(false)
    expect(availableIconVariants(before).map((v) => v.id)).toEqual(['regular', 'wwdc26', 'monoline'])
    expect(availableIconVariants(after).map((v) => v.id)).toEqual(['regular', 'monoline'])
  })

  it('keeps the Swift twin cutoff in sync (drift guard)', () => {
    // The iOS gate has no way to import this module, so the cutoff is duplicated
    // in AppIconAvailability.swift. This guard fails CI if the two diverge.
    const swift = readFileSync(
      join(process.cwd(), 'ios/TaskWraithKit/Sources/TaskWraithUI/AppIconAvailability.swift'),
      'utf8'
    )
    const match = swift.match(/timeIntervalSince1970:\s*([0-9_]+)/)
    expect(match, 'AppIconAvailability.swift must declare wwdc26AvailableUntil').toBeTruthy()
    const swiftSeconds = Number(match![1].replace(/_/g, ''))
    expect(swiftSeconds * 1000).toBe(WWDC26_AVAILABLE_UNTIL_MS)
  })
})

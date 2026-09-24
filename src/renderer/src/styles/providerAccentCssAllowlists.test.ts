import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'

/**
 * Every Pi sub-provider hue is threaded through SEVEN hand-maintained CSS
 * allowlists. Nothing compiles or type-checks them: `hueClass` is a plain
 * string, so a brand added to `PI_UPSTREAM_BRANDS` without its matching rules
 * renders, passes every other test, and silently falls back to the Pi seat
 * slate or the notification group hue.
 *
 * That has already happened twice — `provider-xiaomi` was missing from the New
 * Additions block, and `provider-tencent` was missing from it until 2026-09-16.
 * This sweep is the gate those misses needed.
 */
const css = (name: string): string =>
  readFileSync(new URL(`../assets/css/${name}`, import.meta.url), 'utf8')

const TRANSCRIPT = css('02-transcript-messages-fx.css')
const WELCOME = css('03-composer-welcome-activity.css')
const ENSEMBLE = css('09-ensemble-work-session.css')

// Selectors are matched ANCHORED TO A LINE START, never as a bare substring:
// `.message-group:has(.message-meta.provider-x)` contains
// `.message-meta.provider-x`, so a plain `includes` reports the meta rule as
// present when only the :has() rule exists. Verified by deleting each rule in
// turn and confirming this test reds for that rule alone.
const BLOCKS: ReadonlyArray<readonly [string, string, (hue: string) => RegExp]> = [
  [
    'transcript message meta',
    TRANSCRIPT,
    (hue) => new RegExp(`^\\.message-meta\\.provider-${hue}\\s*\\{`, 'm')
  ],
  [
    'transcript working accent',
    TRANSCRIPT,
    (hue) => new RegExp(`^\\.message-group:has\\(\\.message-meta\\.provider-${hue}\\)\\s*\\{`, 'm')
  ],
  [
    'participant health chip',
    TRANSCRIPT,
    (hue) => new RegExp(`^\\.participant-health-chip\\.provider-${hue}\\s*\\{`, 'm')
  ],
  [
    'ensemble above-chip role',
    ENSEMBLE,
    (hue) =>
      new RegExp(
        `^\\.ensemble-above-chip\\.provider-${hue} \\.ensemble-above-chip-role\\s*\\{`,
        'm'
      )
  ],
  [
    'ensemble above-chip tooltip',
    ENSEMBLE,
    (hue) =>
      new RegExp(
        `^\\.ensemble-above-chip-tooltip\\.provider-${hue} \\.ensemble-above-chip-tooltip-title\\s*\\{`,
        'm'
      )
  ],
  [
    'New Additions card',
    WELCOME,
    (hue) => new RegExp(`^\\.notification-newadditions-model\\.provider-${hue}\\s*\\{`, 'm')
  ],
  [
    'welcome usage swatch',
    WELCOME,
    (hue) => new RegExp(`^\\.welcome-usage-model-dot\\.provider-${hue},`, 'm')
  ]
]

const HUE_CLASSES = [...new Set(Object.values(PI_UPSTREAM_BRANDS).map((brand) => brand.hueClass))]

describe('provider accent CSS allowlists', () => {
  it('carries every Pi upstream hue in all seven hand-maintained blocks', () => {
    const missing: string[] = []
    for (const hue of HUE_CLASSES) {
      for (const [label, source, selector] of BLOCKS) {
        if (!selector(hue).test(source)) missing.push(`${hue} -> ${label}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('backs each of those rules with a real theme token', () => {
    const theme = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
    for (const hue of HUE_CLASSES) {
      expect(theme, hue).toContain(`--provider-${hue}-color:`)
    }
  })

  // Guards the guard: HUE_CLASSES must be non-empty, or both sweeps above pass
  // over nothing and report green while every block is empty.
  it('sweeps a non-trivial roster', () => {
    expect(HUE_CLASSES.length).toBeGreaterThan(10)
    expect(HUE_CLASSES).toContain('stealth')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REVEAL_PARAMS, fadeOpacity, smoothstep, type RevealParams } from './revealParams'

describe('revealParams (TS source of truth)', () => {
  it('pins the cross-platform param values', () => {
    expect(REVEAL_PARAMS).toEqual<RevealParams>({
      baseCharsPerSec: 55,
      catchUpPerSec: 3.0,
      maxCharsPerSec: 900,
      maxCharsPerFrame: 96,
      settleCharsPerSec: 170,
      fadeTailChars: 26,
      completeDrainMs: 250,
      clearCeilingMs: 300,
      coldSnapChars: 220
    })
  })

  it('smoothstep + fadeOpacity behave at the boundaries', () => {
    expect(smoothstep(0)).toBe(0)
    expect(smoothstep(1)).toBe(1)
    expect(smoothstep(-9)).toBe(0)
    expect(smoothstep(9)).toBe(1)
    expect(fadeOpacity(0)).toBe(0)
    expect(fadeOpacity(REVEAL_PARAMS.fadeTailChars)).toBe(1)
  })
})

describe('revealParams Swift twin (drift guard)', () => {
  // iOS cannot import the TS module, so RevealParams.swift duplicates the
  // values. This guard fails CI if the two diverge — same pattern as
  // iconVariants.test.ts / AppIconAvailability.swift.
  const swift = readFileSync(
    join(process.cwd(), 'ios/TaskWraithKit/Sources/TaskWraithKit/RevealParams.swift'),
    'utf8'
  )

  // Parse the `static let shared = RevealParams( ... )` literal.
  const sharedBlock = swift.match(/static let shared = RevealParams\(([\s\S]*?)\)/)
  it('declares the shared RevealParams literal', () => {
    expect(sharedBlock, 'RevealParams.swift must declare `static let shared`').toBeTruthy()
  })

  const body = sharedBlock?.[1] ?? ''
  const swiftValue = (key: string): number => {
    const m = body.match(new RegExp(`${key}:\\s*([0-9]+(?:\\.[0-9]+)?)`))
    expect(m, `RevealParams.swift must declare ${key}`).toBeTruthy()
    return Number(m![1])
  }

  it.each(Object.keys(REVEAL_PARAMS) as (keyof RevealParams)[])(
    'Swift twin matches REVEAL_PARAMS.%s',
    (key) => {
      expect(swiftValue(key)).toBe(REVEAL_PARAMS[key])
    }
  )

  it('keeps the smoothstep + advanceReveal algorithm present in the twin', () => {
    expect(swift).toMatch(/func revealSmoothstep/)
    expect(swift).toMatch(/func revealFadeOpacity/)
    expect(swift).toMatch(/func advanceReveal/)
  })
})

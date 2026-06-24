import { describe, expect, it } from 'vitest'
import { resolveRefractionEnabled } from './useAppearance'

/**
 * Pure-fn coverage for the refractive "liquid glass" gate. Node-env (no jsdom): we
 * assert the boolean truth table only, mirroring resolveWindowMaterialAttribute's style.
 * Refraction is an INDEPENDENT material toggle (NOT coupled to the fun-FX system), gated
 * only on Reduce Transparency (NOT Reduce Motion — the refraction is static).
 */
describe('resolveRefractionEnabled', () => {
  it('is true when refraction is on and Reduce Transparency is off', () => {
    expect(resolveRefractionEnabled({ reduceTransparency: false, refraction: true })).toBe(true)
  })

  it('is false when Reduce Transparency is on (material effect is suppressed)', () => {
    expect(resolveRefractionEnabled({ reduceTransparency: true, refraction: true })).toBe(false)
  })

  it('is false when the refraction toggle itself is off', () => {
    expect(resolveRefractionEnabled({ reduceTransparency: false, refraction: false })).toBe(false)
  })

  it('does NOT depend on the fun-FX system (independent material toggle)', () => {
    // Both inputs favourable → true regardless of any FX state, which is no longer an input.
    expect(resolveRefractionEnabled({ reduceTransparency: false, refraction: true })).toBe(true)
  })
})

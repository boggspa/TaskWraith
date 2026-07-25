import { describe, expect, it } from 'vitest'
import { API_KEY_MODEL_INDICATOR_LABEL, modelRequiresApiKey } from './apiKeyModelIndicator'
import { LIVE_SELECTABLE_PROVIDER_IDS } from './retiredProviders'

describe('modelRequiresApiKey', () => {
  it('marks every Pi model — the provider is BYOK-only', () => {
    expect(modelRequiresApiKey('pi', 'groq/moonshotai/kimi-k2')).toBe(true)
    expect(modelRequiresApiKey('pi', 'anything')).toBe(true)
    expect(modelRequiresApiKey('pi', '')).toBe(true)
    expect(modelRequiresApiKey('pi', null)).toBe(true)
  })

  // AntiGravity is the one mixed-lane provider: the key lane runs through the
  // official SDK, every other id runs `agy` on the user's subscription login.
  it('marks only the gemini-api lane for AntiGravity', () => {
    expect(modelRequiresApiKey('antigravity', 'gemini-api:gemini-2.5-flash')).toBe(true)
    expect(modelRequiresApiKey('antigravity', 'GEMINI-API:Gemini-3.1-Pro')).toBe(true)
    expect(modelRequiresApiKey('antigravity', '  gemini-api:gemini-2.5-pro  ')).toBe(true)
  })

  it('leaves the agy CLI lane unmarked — it rides the subscription, not a key', () => {
    for (const agyModel of [
      'gemini-3.6-flash-high',
      'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
      'cli-default'
    ]) {
      expect(modelRequiresApiKey('antigravity', agyModel)).toBe(false)
    }
  })

  // `gemini-apix` is an ordinary agy id, matching the token-bounded rule in
  // AntigravityCombinedModeDispatch — the glyph must not disagree with dispatch.
  it('does not treat a longer token as the gemini-api namespace', () => {
    expect(modelRequiresApiKey('antigravity', 'gemini-apix-flash')).toBe(false)
  })

  // The whole point of the glyph is that it means something. If it appeared on
  // subscription/CLI rows it would mark nearly everything and say nothing.
  it('never marks a subscription or CLI-login provider', () => {
    const subscriptionProviders = LIVE_SELECTABLE_PROVIDER_IDS.filter((id) => id !== 'pi')
    expect(subscriptionProviders.length).toBeGreaterThan(0)
    for (const provider of subscriptionProviders) {
      expect(modelRequiresApiKey(provider, 'gemini-api:gemini-2.5-flash')).toBe(false)
      expect(modelRequiresApiKey(provider, 'some-model')).toBe(false)
    }
  })

  it('is blank- and case-tolerant on the provider', () => {
    expect(modelRequiresApiKey('  PI  ', 'x')).toBe(true)
    expect(modelRequiresApiKey('', 'gemini-api:gemini-2.5-flash')).toBe(false)
    expect(modelRequiresApiKey(null, 'gemini-api:gemini-2.5-flash')).toBe(false)
    expect(modelRequiresApiKey(undefined, undefined)).toBe(false)
  })

  it('states the billing caveat once, for every surface', () => {
    expect(API_KEY_MODEL_INDICATOR_LABEL).toMatch(/API key/i)
    expect(API_KEY_MODEL_INDICATOR_LABEL).toMatch(/per token/i)
  })
})

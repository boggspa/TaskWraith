import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER,
  RETIRED_PROVIDER_IDS,
  coerceLiveProvider,
  isRetiredProvider
} from './retiredProviders'

describe('retiredProviders', () => {
  it('retires gemini and nothing else (yet)', () => {
    expect([...RETIRED_PROVIDER_IDS]).toEqual(['gemini'])
  })

  it('uses claude as the structural default', () => {
    expect(DEFAULT_PROVIDER).toBe('claude')
    // The default must never itself be a retired provider.
    expect(isRetiredProvider(DEFAULT_PROVIDER)).toBe(false)
  })

  it('isRetiredProvider only flags retired ids', () => {
    expect(isRetiredProvider('gemini')).toBe(true)
    expect(isRetiredProvider('claude')).toBe(false)
    expect(isRetiredProvider('codex')).toBe(false)
    expect(isRetiredProvider(null)).toBe(false)
    expect(isRetiredProvider(undefined)).toBe(false)
    expect(isRetiredProvider('')).toBe(false)
  })

  it('coerceLiveProvider passes through live providers unchanged', () => {
    expect(coerceLiveProvider('codex')).toBe('codex')
    expect(coerceLiveProvider('claude')).toBe('claude')
    expect(coerceLiveProvider('kimi')).toBe('kimi')
  })

  it('coerceLiveProvider migrates retired/empty/missing to the default', () => {
    expect(coerceLiveProvider('gemini')).toBe(DEFAULT_PROVIDER)
    expect(coerceLiveProvider(null)).toBe(DEFAULT_PROVIDER)
    expect(coerceLiveProvider(undefined)).toBe(DEFAULT_PROVIDER)
    expect(coerceLiveProvider('')).toBe(DEFAULT_PROVIDER)
  })
})

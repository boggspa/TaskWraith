import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER,
  RETIRED_PROVIDER_IDS,
  coerceLiveProvider,
  isEnsembleSeatProvider,
  isLiveSelectableProvider,
  LIVE_SELECTABLE_PROVIDER_IDS,
  isRetiredProvider,
  ANTIGRAVITY_PROVIDER_ID,
  isAntigravityOptInEnabled
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
    expect(coerceLiveProvider('cursor')).toBe('cursor')
  })

  it('keeps one canonical live-selection set including Cursor', () => {
    expect(LIVE_SELECTABLE_PROVIDER_IDS).toEqual([
      'codex',
      'claude',
      'kimi',
      'cursor',
      'grok',
      'ollama',
      'pi',
      'mistral'
    ])
    expect(isLiveSelectableProvider('pi')).toBe(true)
    expect(isLiveSelectableProvider('mistral')).toBe(true)
    expect(isLiveSelectableProvider('codex')).toBe(true)
    expect(isLiveSelectableProvider('cursor')).toBe(true)
    expect(isLiveSelectableProvider('gemini')).toBe(false)
  })

  it('coerceLiveProvider migrates retired/empty/missing to the default', () => {
    expect(coerceLiveProvider('gemini')).toBe(DEFAULT_PROVIDER)
    expect(coerceLiveProvider('cursor')).toBe('cursor')
    expect(coerceLiveProvider(null)).toBe(DEFAULT_PROVIDER)
    expect(coerceLiveProvider(undefined)).toBe(DEFAULT_PROVIDER)
    expect(coerceLiveProvider('')).toBe(DEFAULT_PROVIDER)
  })
})

describe('AntiGravity opt-in gate (isAntigravityOptInEnabled)', () => {
  it('uses a distinct id that is neither retired nor a static live-selectable', () => {
    expect(ANTIGRAVITY_PROVIDER_ID).toBe('antigravity')
    // Not a Gemini revival, and not silently offered before opt-in.
    expect(isRetiredProvider(ANTIGRAVITY_PROVIDER_ID)).toBe(false)
    expect(isLiveSelectableProvider(ANTIGRAVITY_PROVIDER_ID)).toBe(false)
    expect([...LIVE_SELECTABLE_PROVIDER_IDS]).not.toContain('antigravity')
  })

  it('is CLOSED by default (no settings / empty settings)', () => {
    expect(isAntigravityOptInEnabled(undefined)).toBe(false)
    expect(isAntigravityOptInEnabled(null)).toBe(false)
    expect(isAntigravityOptInEnabled({})).toBe(false)
  })

  it('stays CLOSED when enabled but consent is not recorded', () => {
    expect(isAntigravityOptInEnabled({ antigravityEnabled: true })).toBe(false)
    expect(
      isAntigravityOptInEnabled({ antigravityEnabled: true, antigravityOptInAcceptedAt: null })
    ).toBe(false)
    expect(
      isAntigravityOptInEnabled({ antigravityEnabled: true, antigravityOptInAcceptedAt: 0 })
    ).toBe(false)
  })

  it('stays CLOSED when consent is recorded but the provider is disabled', () => {
    expect(
      isAntigravityOptInEnabled({ antigravityEnabled: false, antigravityOptInAcceptedAt: 1_700_000_000_000 })
    ).toBe(false)
    expect(
      isAntigravityOptInEnabled({ antigravityOptInAcceptedAt: 1_700_000_000_000 })
    ).toBe(false)
  })

  it('OPENS only when enabled AND consent timestamp is set', () => {
    expect(
      isAntigravityOptInEnabled({ antigravityEnabled: true, antigravityOptInAcceptedAt: 1_700_000_000_000 })
    ).toBe(true)
  })
})

describe('isEnsembleSeatProvider', () => {
  it('admits every static live provider', () => {
    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
      expect(isEnsembleSeatProvider(provider)).toBe(true)
    }
  })

  it('admits dynamically-gated antigravity seats', () => {
    expect(isEnsembleSeatProvider('antigravity')).toBe(true)
  })

  it('still rejects retired and unknown providers', () => {
    expect(isEnsembleSeatProvider('gemini')).toBe(false)
    expect(isEnsembleSeatProvider('made-up')).toBe(false)
    expect(isEnsembleSeatProvider(null)).toBe(false)
    expect(isEnsembleSeatProvider(undefined)).toBe(false)
  })
})

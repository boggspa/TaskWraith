import { describe, expect, it } from 'vitest'
import {
  normalizeBrokerParentProvider,
  resolveBrokerParentProvider
} from './McpBridgeRuntime'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../shared/retiredProviders'

describe('normalizeBrokerParentProvider', () => {
  it('preserves managed provider stamps for broker-routed calls', () => {
    expect(normalizeBrokerParentProvider('cursor')).toBe('cursor')
    expect(normalizeBrokerParentProvider('grok')).toBe('grok')
    expect(normalizeBrokerParentProvider('pi')).toBe('pi')
  })

  it('falls back to Gemini for unknown provider stamps', () => {
    expect(normalizeBrokerParentProvider('unknown')).toBe('gemini')
  })
})

describe('resolveBrokerParentProvider', () => {
  it('prefers the run-session provider over a wrong stamped parent when appRunId is present', () => {
    expect(resolveBrokerParentProvider('cursor', 'grok')).toBe('grok')
    expect(resolveBrokerParentProvider('gemini', 'codex')).toBe('codex')
  })

  it('keeps a Cursor stamp as Cursor when no run-session provider is available', () => {
    expect(resolveBrokerParentProvider('cursor')).toBe('cursor')
    expect(resolveBrokerParentProvider('cursor', null)).toBe('cursor')
  })

  it('keeps Pi ownership when its contained coordination extension calls the broker', () => {
    expect(resolveBrokerParentProvider('pi')).toBe('pi')
    expect(resolveBrokerParentProvider('gemini', 'pi')).toBe('pi')
  })

  it('ignores invalid run-session providers and falls back to stamp normalization', () => {
    expect(resolveBrokerParentProvider('grok', 'not-a-provider' as never)).toBe('grok')
    expect(resolveBrokerParentProvider('unknown', undefined)).toBe('gemini')
  })

  it('keeps Ollama ownership for its in-main tool loop (2026-07-28 QA regression)', () => {
    // Without set membership every ollama write/shell tool was coerced to
    // 'gemini', missed the run context, and failed — while read tools (which
    // bind the context directly) kept working.
    expect(resolveBrokerParentProvider('ollama')).toBe('ollama')
    expect(resolveBrokerParentProvider('gemini', 'ollama')).toBe('ollama')
  })

  // LOCKSTEP: every live selectable provider must survive the broker parent
  // resolution un-coerced, both as a stamp and as a run-session provider. A
  // provider missing from VALID_BROKER_PARENT_PROVIDERS silently loses its
  // MCP-routed tools to a 'gemini' context miss — reads work, writes fail —
  // and no per-provider suite notices because the dispatcher is mocked there.
  it('never coerces a live selectable provider back to gemini', () => {
    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
      expect(normalizeBrokerParentProvider(provider)).toBe(provider)
      expect(resolveBrokerParentProvider('gemini', provider)).toBe(provider)
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  normalizeBrokerParentProvider,
  resolveBrokerParentProvider
} from './McpBridgeRuntime'

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
})

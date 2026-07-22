import { describe, expect, it } from 'vitest'
import { sanitizeConfiguredProviderSnapshot } from './useConfiguredProviderSnapshot'

describe('sanitizeConfiguredProviderSnapshot', () => {
  it('keeps unique live providers in discovery order', () => {
    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['claude', 'gemini', 'claude', 'cursor', 'unknown']
      })
    ).toEqual({ ready: true, providerIds: ['claude', 'cursor'] })
  })

  it('returns a pending empty snapshot for malformed input', () => {
    expect(sanitizeConfiguredProviderSnapshot(null)).toEqual({
      ready: false,
      providerIds: []
    })
    expect(sanitizeConfiguredProviderSnapshot({ ready: 'yes', providerIds: 'codex' })).toEqual({
      ready: false,
      providerIds: []
    })
  })
})

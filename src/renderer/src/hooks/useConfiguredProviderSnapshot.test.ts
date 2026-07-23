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

  it('admits AntiGravity only with a nonempty validated cached model list', () => {
    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['antigravity']
      })
    ).toEqual({ ready: true, providerIds: [] })

    expect(
      sanitizeConfiguredProviderSnapshot({
        ready: true,
        providerIds: ['antigravity'],
        modelsByProvider: {
          antigravity: [
            { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
            { id: 'gemini-3.5-pro', label: 'Duplicate is ignored' },
            { id: '', label: 'Ignored' }
          ]
        }
      })
    ).toEqual({
      ready: true,
      providerIds: ['antigravity'],
      modelsByProvider: {
        antigravity: [{ id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }]
      }
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS,
  createAntigravityGeminiApiSecretBridge
} from './antigravityGeminiApiSecretContract'

describe('Antigravity Gemini API preload contract', () => {
  it('exposes exactly four dedicated invokes and no generic settings/secret channel', async () => {
    const invoke = vi.fn((channel: string) => Promise.resolve({ channel }))
    const bridge = createAntigravityGeminiApiSecretBridge({ invoke })

    await bridge.getAntigravityGeminiApiSecretStatus()
    await bridge.setAntigravityGeminiApiSecret('key')
    await bridge.clearAntigravityGeminiApiSecret()
    await bridge.getAntigravityGeminiApiDiscoveryOutcome()

    expect(invoke).toHaveBeenCalledTimes(4)
    expect(invoke.mock.calls).toEqual([
      [ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.status],
      [ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.set, 'key'],
      [ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.clear],
      [ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.discoveryOutcome]
    ])
    expect(invoke.mock.calls.flat()).not.toContain('update-settings')
    expect(invoke.mock.calls.flat()).not.toContain('set-extension-secret')
  })

  it('never passes the API key to the read-only discovery-outcome channel', () => {
    // The outcome answers "what did Google say", not "what is the key". The
    // renderer has no key to send and this channel must never accept one.
    const invoke = vi.fn(() => Promise.resolve(null))
    const bridge = createAntigravityGeminiApiSecretBridge({ invoke })

    void bridge.getAntigravityGeminiApiDiscoveryOutcome()

    expect(invoke).toHaveBeenCalledWith(ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.discoveryOutcome)
    expect(invoke.mock.calls[0]).toHaveLength(1)
  })
})

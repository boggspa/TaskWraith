import { describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS,
  createAntigravityGeminiApiSecretBridge
} from './antigravityGeminiApiSecretContract'

describe('Antigravity Gemini API preload contract', () => {
  it('exposes exactly three dedicated invokes and no generic settings/secret channel', async () => {
    const invoke = vi.fn((channel: string) => Promise.resolve({ channel }))
    const bridge = createAntigravityGeminiApiSecretBridge({ invoke })

    await bridge.getAntigravityGeminiApiSecretStatus()
    await bridge.setAntigravityGeminiApiSecret('key')
    await bridge.clearAntigravityGeminiApiSecret()

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(invoke.mock.calls).toEqual([
      [ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.status],
      [ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.set, 'key'],
      [ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.clear]
    ])
    expect(invoke.mock.calls.flat()).not.toContain('update-settings')
    expect(invoke.mock.calls.flat()).not.toContain('set-extension-secret')
  })
})

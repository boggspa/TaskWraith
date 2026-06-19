import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { grokAcpEnabled } from './grokGate'

// Provider eligibility is no longer gated (Grok is permanently first-class —
// see ProviderId). Only the ACP transport sub-gate remains configurable.
const GROK_ENV_KEYS = ['TASKWRAITH_GROK_ACP'] as const

type GrokEnvKey = (typeof GROK_ENV_KEYS)[number]

const originalEnv = new Map<GrokEnvKey, string | undefined>()

function resetGrokEnv(values: Partial<Record<GrokEnvKey, string>> = {}): void {
  for (const key of GROK_ENV_KEYS) {
    delete process.env[key]
  }
  for (const key of GROK_ENV_KEYS) {
    const value = values[key]
    if (value !== undefined) {
      process.env[key] = value
    }
  }
}

describe('grokAcpEnabled', () => {
  beforeEach(() => {
    originalEnv.clear()
    for (const key of GROK_ENV_KEYS) {
      originalEnv.set(key, process.env[key])
    }
    resetGrokEnv()
  })

  afterEach(() => {
    for (const key of GROK_ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('defaults on', () => {
    expect(grokAcpEnabled()).toBe(true)
  })

  it('stays on for documented enabled or malformed values', () => {
    for (const value of ['', '1', 'true', 'yes', 'TRUE', 'YES', ' yes ', 'random']) {
      resetGrokEnv({ TASKWRAITH_GROK_ACP: value })
      expect(grokAcpEnabled()).toBe(true)
    }
  })

  it('turns off for exact documented opt-out values', () => {
    for (const value of ['0', 'false', 'no']) {
      resetGrokEnv({ TASKWRAITH_GROK_ACP: value })
      expect(grokAcpEnabled()).toBe(false)
    }
  })
})

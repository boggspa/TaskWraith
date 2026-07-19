import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GROK_ACP_REQUIRED_MESSAGE,
  grokAcpEnabled,
  grokSeatSessionsEnabled
} from './grokGate'

// Provider eligibility is no longer gated (Grok is permanently first-class —
// see ProviderId). ACP is also mandatory for managed one-shot runs; the legacy
// environment key remains here only to prove it cannot reopen headless mode.
const GROK_ENV_KEYS = ['TASKWRAITH_GROK_ACP', 'TASKWRAITH_GROK_SEAT_SESSIONS'] as const

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

  it('stays on for enabled or malformed values', () => {
    for (const value of ['', '1', 'true', 'yes', 'TRUE', 'YES', ' yes ', 'random']) {
      resetGrokEnv({ TASKWRAITH_GROK_ACP: value })
      expect(grokAcpEnabled()).toBe(true)
    }
  })

  it('fails closed for former headless opt-outs without reopening that transport', () => {
    for (const value of ['0', 'false', 'no', 'off', 'FALSE', ' No ', ' OFF ']) {
      resetGrokEnv({ TASKWRAITH_GROK_ACP: value })
      expect(grokAcpEnabled()).toBe(false)
    }
    expect(GROK_ACP_REQUIRED_MESSAGE).toContain('legacy headless fallback is retired')
    expect(GROK_ACP_REQUIRED_MESSAGE).toContain('exact process-close evidence')
  })
})

describe('grokSeatSessionsEnabled', () => {
  beforeEach(() => {
    originalEnv.clear()
    for (const key of GROK_ENV_KEYS) originalEnv.set(key, process.env[key])
    resetGrokEnv()
  })

  afterEach(() => {
    for (const key of GROK_ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('keeps persistent ensemble seat processes disabled by default', () => {
    expect(grokSeatSessionsEnabled()).toBe(false)
  })

  it('does not let environment flags reopen the unjoined persistent process lane', () => {
    for (const value of ['0', 'false', 'no', '1', 'true', 'yes']) {
      resetGrokEnv({ TASKWRAITH_GROK_SEAT_SESSIONS: value })
      expect(grokSeatSessionsEnabled()).toBe(false)
    }
  })
})

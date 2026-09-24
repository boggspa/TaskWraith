import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEVIN_ACP_REQUIRED_MESSAGE,
  devinAcpEnabled,
  devinAmbientApiKeyEnabled,
  devinMcpAdvertiseEnabled,
  devinSeatSessionsEnabled
} from './devinGate'

// There is deliberately no provider-eligibility gate: Devin is a first-class
// ProviderId. These keys tune HOW the seat runs, never WHETHER it is valid.
const DEVIN_ENV_KEYS = [
  'TASKWRAITH_DEVIN_ACP',
  'TASKWRAITH_DEVIN_BYOK',
  'TASKWRAITH_DEVIN_MCP',
  'TASKWRAITH_DEVIN_SEAT_SESSIONS'
] as const

type DevinEnvKey = (typeof DEVIN_ENV_KEYS)[number]

const originalEnv = new Map<DevinEnvKey, string | undefined>()

function resetDevinEnv(values: Partial<Record<DevinEnvKey, string>> = {}): void {
  for (const key of DEVIN_ENV_KEYS) {
    delete process.env[key]
  }
  for (const key of DEVIN_ENV_KEYS) {
    const value = values[key]
    if (value !== undefined) {
      process.env[key] = value
    }
  }
}

beforeEach(() => {
  originalEnv.clear()
  for (const key of DEVIN_ENV_KEYS) {
    originalEnv.set(key, process.env[key])
  }
  resetDevinEnv()
})

afterEach(() => {
  for (const key of DEVIN_ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const FALSE_ISH = ['0', 'false', 'no', 'off', 'FALSE', ' No ', ' OFF ', '  0  '] as const
const ON_OR_MALFORMED = ['', '1', 'true', 'yes', 'TRUE', 'YES', ' yes ', 'random'] as const

describe('devinAcpEnabled', () => {
  it('defaults on', () => {
    expect(devinAcpEnabled()).toBe(true)
  })

  it('stays on for enabled or malformed values', () => {
    for (const value of ON_OR_MALFORMED) {
      resetDevinEnv({ TASKWRAITH_DEVIN_ACP: value })
      expect(devinAcpEnabled(), JSON.stringify(value)).toBe(true)
    }
  })

  it('is an emergency stop only for recognized false values, in any case or whitespace', () => {
    for (const value of FALSE_ISH) {
      resetDevinEnv({ TASKWRAITH_DEVIN_ACP: value })
      expect(devinAcpEnabled(), JSON.stringify(value)).toBe(false)
    }
  })

  it('names the transport and rules out a headless fallback in the required message', () => {
    expect(DEVIN_ACP_REQUIRED_MESSAGE).toContain('`devin acp`')
    expect(DEVIN_ACP_REQUIRED_MESSAGE).toContain('There is no headless fallback')
    expect(DEVIN_ACP_REQUIRED_MESSAGE).toContain('TASKWRAITH_DEVIN_ACP')
  })
})

describe('devinAmbientApiKeyEnabled', () => {
  it('defaults on: WINDSURF_API_KEY / DEVIN_API_KEY name exactly one product', () => {
    expect(devinAmbientApiKeyEnabled()).toBe(true)
  })

  it('stays on for enabled or malformed values', () => {
    for (const value of ON_OR_MALFORMED) {
      resetDevinEnv({ TASKWRAITH_DEVIN_BYOK: value })
      expect(devinAmbientApiKeyEnabled(), JSON.stringify(value)).toBe(true)
    }
  })

  it('is off only for recognized false values', () => {
    for (const value of FALSE_ISH) {
      resetDevinEnv({ TASKWRAITH_DEVIN_BYOK: value })
      expect(devinAmbientApiKeyEnabled(), JSON.stringify(value)).toBe(false)
    }
  })
})

describe('devinMcpAdvertiseEnabled', () => {
  it('defaults off until request_permission coverage is live-measured', () => {
    expect(devinMcpAdvertiseEnabled()).toBe(false)
  })

  it('turns on only for an explicit true value, case-insensitively after trim', () => {
    for (const value of ['1', 'true', 'yes', 'TRUE', ' Yes ', '  1  ']) {
      resetDevinEnv({ TASKWRAITH_DEVIN_MCP: value })
      expect(devinMcpAdvertiseEnabled(), JSON.stringify(value)).toBe(true)
    }
  })

  it('stays off for empty, false-ish, or malformed values', () => {
    for (const value of ['', '0', 'false', 'no', 'off', 'random', 'on', 'enabled']) {
      resetDevinEnv({ TASKWRAITH_DEVIN_MCP: value })
      expect(devinMcpAdvertiseEnabled(), JSON.stringify(value)).toBe(false)
    }
  })
})

describe('devinSeatSessionsEnabled', () => {
  it('keeps persistent ensemble seat processes disabled by default', () => {
    expect(devinSeatSessionsEnabled()).toBe(false)
  })

  it('does not let environment flags reopen the unjoined persistent process lane', () => {
    for (const value of ['0', 'false', 'no', '1', 'true', 'yes']) {
      resetDevinEnv({ TASKWRAITH_DEVIN_SEAT_SESSIONS: value })
      expect(devinSeatSessionsEnabled(), JSON.stringify(value)).toBe(false)
    }
  })
})

describe('gate independence', () => {
  it('reads only its own variable per gate', () => {
    resetDevinEnv({
      TASKWRAITH_DEVIN_ACP: '0',
      TASKWRAITH_DEVIN_BYOK: '1',
      TASKWRAITH_DEVIN_MCP: '1',
      TASKWRAITH_DEVIN_SEAT_SESSIONS: '1'
    })
    expect(devinAcpEnabled()).toBe(false)
    expect(devinAmbientApiKeyEnabled()).toBe(true)
    expect(devinMcpAdvertiseEnabled()).toBe(true)
    expect(devinSeatSessionsEnabled()).toBe(false)

    resetDevinEnv({ TASKWRAITH_DEVIN_BYOK: '0', TASKWRAITH_DEVIN_MCP: '0' })
    expect(devinAcpEnabled()).toBe(true)
    expect(devinAmbientApiKeyEnabled()).toBe(false)
    expect(devinMcpAdvertiseEnabled()).toBe(false)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import {
  museMcpAdvertiseEnabled,
  museMspSessionResumeEnabled,
  museMspTransportEnabled
} from './museGate'

const KEYS = ['TASKWRAITH_MUSE_MSP', 'TASKWRAITH_MUSE_MSP_RESUME', 'TASKWRAITH_MUSE_MCP'] as const
const saved = new Map<string, string | undefined>()
for (const key of KEYS) saved.set(key, process.env[key])

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function setEnv(key: (typeof KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('museMspTransportEnabled — default OFF', () => {
  it('is off when unset, so the shipped exec lane stays the default', () => {
    setEnv('TASKWRAITH_MUSE_MSP', undefined)
    expect(museMspTransportEnabled()).toBe(false)
  })

  it('is off for an unrecognised value rather than opting in loosely', () => {
    for (const value of ['', 'maybe', '2', 'off', '0', 'false', 'no']) {
      setEnv('TASKWRAITH_MUSE_MSP', value)
      expect(museMspTransportEnabled(), `value ${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('accepts the affirmative spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
      setEnv('TASKWRAITH_MUSE_MSP', value)
      expect(museMspTransportEnabled(), `value ${JSON.stringify(value)}`).toBe(true)
    }
  })
})

describe('museMspSessionResumeEnabled — rides the transport gate', () => {
  it('is false whenever the MSP transport is off, whatever its own value says', () => {
    // Resume is meaningless on the exec lane: it mints a fresh isolated home
    // per run, so there is no session to resume.
    setEnv('TASKWRAITH_MUSE_MSP', undefined)
    setEnv('TASKWRAITH_MUSE_MSP_RESUME', '1')
    expect(museMspSessionResumeEnabled()).toBe(false)
  })

  it('defaults ON once the transport is selected', () => {
    setEnv('TASKWRAITH_MUSE_MSP', '1')
    setEnv('TASKWRAITH_MUSE_MSP_RESUME', undefined)
    expect(museMspSessionResumeEnabled()).toBe(true)
  })

  it('can be switched off independently for a context-injection A/B', () => {
    setEnv('TASKWRAITH_MUSE_MSP', '1')
    for (const value of ['0', 'false', 'no', 'off']) {
      setEnv('TASKWRAITH_MUSE_MSP_RESUME', value)
      expect(museMspSessionResumeEnabled(), `value ${value}`).toBe(false)
    }
  })
})

describe('museMcpAdvertiseEnabled — default ON', () => {
  it('is on when unset, matching the exec lane it replaces', () => {
    setEnv('TASKWRAITH_MUSE_MCP', undefined)
    expect(museMcpAdvertiseEnabled()).toBe(true)
  })

  it('is an emergency stop, not a loose opt-in', () => {
    for (const value of ['0', 'false', 'no', 'off']) {
      setEnv('TASKWRAITH_MUSE_MCP', value)
      expect(museMcpAdvertiseEnabled(), `value ${value}`).toBe(false)
    }
  })
})

// `museMspHostPostureIsPerHost` deliberately has NO test. Asserting
// `expect(true as const).toBe(true)` can only fail if you edit its own literal,
// so it would prove nothing about the constraint it records. It is executable
// doctrine for a future host-pooling implementation to consult, and it earns a
// real test when something actually branches on it.

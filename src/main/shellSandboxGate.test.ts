import { afterEach, describe, expect, it } from 'vitest'
import { shellSandboxEnabled } from './shellSandboxGate'

const original = process.env.TASKWRAITH_SHELL_SANDBOX

afterEach(() => {
  if (original === undefined) delete process.env.TASKWRAITH_SHELL_SANDBOX
  else process.env.TASKWRAITH_SHELL_SANDBOX = original
})

describe('shellSandboxEnabled', () => {
  // Default OFF is the whole safety argument for landing this: an unset flag
  // must leave the agent shell behaving exactly as it does today.
  it('is off when unset', () => {
    delete process.env.TASKWRAITH_SHELL_SANDBOX
    expect(shellSandboxEnabled()).toBe(false)
  })

  it('stays off for anything that is not an explicit opt-in', () => {
    for (const value of ['', '0', 'false', 'no', 'off', 'maybe', ' ']) {
      process.env.TASKWRAITH_SHELL_SANDBOX = value
      expect(`${value}:${shellSandboxEnabled()}`).toBe(`${value}:false`)
    }
  })

  it('turns on for the accepted spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
      process.env.TASKWRAITH_SHELL_SANDBOX = value
      expect(`${value}:${shellSandboxEnabled()}`).toBe(`${value}:true`)
    }
  })
})

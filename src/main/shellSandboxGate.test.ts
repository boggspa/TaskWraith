import { afterEach, describe, expect, it } from 'vitest'
import { shellSandboxEnabled } from './shellSandboxGate'

const original = process.env.TASKWRAITH_SHELL_SANDBOX

afterEach(() => {
  if (original === undefined) delete process.env.TASKWRAITH_SHELL_SANDBOX
  else process.env.TASKWRAITH_SHELL_SANDBOX = original
})

describe('shellSandboxEnabled', () => {
  // Default ON since the live canary passed. An unset flag must CONTAIN.
  it('is on when unset', () => {
    delete process.env.TASKWRAITH_SHELL_SANDBOX
    expect(shellSandboxEnabled()).toBe(true)
  })

  it('turns off only for an explicit opt-out', () => {
    for (const value of ['0', 'false', 'no', 'off', 'OFF', ' off ']) {
      process.env.TASKWRAITH_SHELL_SANDBOX = value
      expect(`${value}:${shellSandboxEnabled()}`).toBe(`${value}:false`)
    }
  })

  // An unrecognised value must not silently disable containment: the safe
  // reading of a typo is "the operator wanted the sandbox", not "run open".
  it('stays on for an empty or unrecognised value', () => {
    for (const value of ['', ' ', '1', 'true', 'yes', 'on', 'maybe', 'disabled']) {
      process.env.TASKWRAITH_SHELL_SANDBOX = value
      expect(`${value}:${shellSandboxEnabled()}`).toBe(`${value}:true`)
    }
  })
})

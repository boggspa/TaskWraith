import { describe, expect, it } from 'vitest'
import { isCiStatusTerminal, shouldRunCiPoll, type CiPollDecisionInput } from './ciStatusRefresh'

const base: CiPollDecisionInput = {
  msSinceLastPoll: 60_000,
  intervalMs: 75_000,
  inFlight: false,
  windowFocused: true,
  online: true,
  hasOpenPr: true,
  ciTerminal: false
}

describe('shouldRunCiPoll', () => {
  it('fires under normal watching conditions', () => {
    expect(shouldRunCiPoll(base)).toBe(true)
  })

  it('skips when a poll is already in flight', () => {
    expect(shouldRunCiPoll({ ...base, inFlight: true })).toBe(false)
  })

  it('skips when the window is blurred or offline', () => {
    expect(shouldRunCiPoll({ ...base, windowFocused: false })).toBe(false)
    expect(shouldRunCiPoll({ ...base, online: false })).toBe(false)
  })

  it('skips when there is no open PR', () => {
    expect(shouldRunCiPoll({ ...base, hasOpenPr: false })).toBe(false)
  })

  it('stops once CI has settled', () => {
    expect(shouldRunCiPoll({ ...base, ciTerminal: true })).toBe(false)
  })

  it('debounces a poll that just fired', () => {
    expect(shouldRunCiPoll({ ...base, msSinceLastPoll: 500 })).toBe(false)
  })

  it('allows the first poll when there is no prior run', () => {
    expect(shouldRunCiPoll({ ...base, msSinceLastPoll: null })).toBe(true)
  })
})

describe('isCiStatusTerminal', () => {
  it('treats passed/failed as terminal and everything else as live', () => {
    expect(isCiStatusTerminal('passed')).toBe(true)
    expect(isCiStatusTerminal('failed')).toBe(true)
    expect(isCiStatusTerminal('pending')).toBe(false)
    expect(isCiStatusTerminal('blocked')).toBe(false)
    expect(isCiStatusTerminal('unknown')).toBe(false)
    expect(isCiStatusTerminal(undefined)).toBe(false)
  })
})

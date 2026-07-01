import { describe, expect, it } from 'vitest'

import {
  deriveVisibleRunCompleteNotice,
  shouldSuppressRunCompleteSummary,
  type RunCompleteNotice
} from './runCompleteNotice'

const notice: RunCompleteNotice = {
  timestamp: '2026-07-01T20:00:00.000Z',
  exitCode: 0,
  startedAt: '2026-07-01T19:59:00.000Z'
}

describe('shouldSuppressRunCompleteSummary', () => {
  it('only suppresses summaries with the explicit suppression flag', () => {
    expect(shouldSuppressRunCompleteSummary(null)).toBe(false)
    expect(shouldSuppressRunCompleteSummary(notice)).toBe(false)
    expect(shouldSuppressRunCompleteSummary({ ...notice, suppressRunSummary: true })).toBe(true)
  })
})

describe('deriveVisibleRunCompleteNotice', () => {
  it('shows a notice when the chat is idle', () => {
    expect(
      deriveVisibleRunCompleteNotice({
        notice,
        isChatRunning: false
      })
    ).toBe(notice)
  })

  it('hides a stale notice while the focused chat has live run evidence', () => {
    expect(
      deriveVisibleRunCompleteNotice({
        notice,
        isChatRunning: true
      })
    ).toBeNull()
  })

  it('keeps guest-participant running suppression intact', () => {
    expect(
      deriveVisibleRunCompleteNotice({
        notice,
        isChatRunning: false,
        isGuestParticipantRunning: true
      })
    ).toBeNull()
  })
})

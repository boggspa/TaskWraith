import { describe, expect, it } from 'vitest'

import {
  closeoutMatchesRunCompleteNotice,
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
})

describe('closeoutMatchesRunCompleteNotice', () => {
  it('matches Ensemble closeouts by round id, not whichever closeout is newest', () => {
    const roundNotice = { ...notice, roundId: 'round-new' }
    expect(
      closeoutMatchesRunCompleteNotice(
        {
          timestamp: notice.timestamp,
          metadata: { kind: 'taskWraithCloseout', closeoutRoundId: 'round-old' }
        },
        roundNotice
      )
    ).toBe(false)
    expect(
      closeoutMatchesRunCompleteNotice(
        {
          timestamp: 'different',
          metadata: { kind: 'taskWraithCloseout', closeoutRoundId: 'round-new' }
        },
        roundNotice
      )
    ).toBe(true)
  })

  it('matches run closeouts by source run id and legacy closeouts by timestamp', () => {
    expect(
      closeoutMatchesRunCompleteNotice(
        {
          runId: 'run-new',
          timestamp: 'different',
          metadata: { kind: 'taskWraithCloseout', sourceRunId: 'run-new' }
        },
        { ...notice, runId: 'run-new' }
      )
    ).toBe(true)
    expect(
      closeoutMatchesRunCompleteNotice(
        { timestamp: notice.timestamp, metadata: { kind: 'taskWraithCloseout' } },
        notice
      )
    ).toBe(true)
  })
})

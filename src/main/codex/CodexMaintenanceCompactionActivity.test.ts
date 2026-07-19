import { describe, expect, it } from 'vitest'

import {
  CodexAppServerRequestTimeoutError,
  isCodexAppServerRequestTimeout
} from './CodexAppServerRequestError'
import {
  codexCompactionFailureProvesNoLiveTurn,
  updateCodexCompactionLaunchEvidence
} from './CodexMaintenanceCompactionActivity'

describe('Codex maintenance compaction native activity evidence', () => {
  it('unwinds after definitive pre-turn RPC rejection', () => {
    const mayBeLive = updateCodexCompactionLaunchEvidence(false, 'rejected')
    expect(
      codexCompactionFailureProvesNoLiveTurn({ launchMayBeLive: mayBeLive })
    ).toBe(true)
  })

  it('keeps ambiguous timeout activity fail-closed', () => {
    const error = new CodexAppServerRequestTimeoutError('thread/compact/start')
    expect(isCodexAppServerRequestTimeout(error, 'thread/compact/start')).toBe(true)
    expect(isCodexAppServerRequestTimeout(error, 'thread/resume')).toBe(false)
    const mayBeLive = updateCodexCompactionLaunchEvidence(
      false,
      isCodexAppServerRequestTimeout(error, 'thread/compact/start') ? 'timeout' : 'rejected'
    )
    expect(
      codexCompactionFailureProvesNoLiveTurn({ launchMayBeLive: mayBeLive })
    ).toBe(false)
  })

  it('never lets a later rejection erase acceptance or an observed turn', () => {
    const accepted = updateCodexCompactionLaunchEvidence(false, 'accepted')
    expect(updateCodexCompactionLaunchEvidence(accepted, 'rejected')).toBe(true)
    expect(
      codexCompactionFailureProvesNoLiveTurn({
        launchMayBeLive: false,
        observedTurnId: 'turn-a'
      })
    ).toBe(false)
  })
})

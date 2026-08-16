import { describe, expect, it } from 'vitest'
import { planAntigravityFailedExitFinalRecovery } from './AntigravityFailedExitFinalRecovery'

const finalResponse = {
  stepIndex: 431,
  createdAt: '2026-08-16T10:33:32Z',
  content: 'Completed final report.'
}

describe('AntiGravity failed-exit final recovery', () => {
  it('recovers an exact final record after a numeric provider failure', () => {
    expect(
      planAntigravityFailedExitFinalRecovery({
        exitCode: 1,
        assistantText: '',
        terminalClaimed: false,
        finalResponse
      })
    ).toEqual({
      text: 'Completed final report.',
      warning: {
        title: 'Recovered AntiGravity final response after native failure',
        message: expect.stringContaining('provider run remains failed')
      },
      provenance: {
        recoverySource: 'agy-brain-transcript',
        recoveredAfterProviderFailure: true,
        nativeStepIndex: 431,
        nativeCreatedAt: '2026-08-16T10:33:32Z'
      }
    })
  })

  it('does not recover a successful, signalled, or already answered run', () => {
    expect(
      planAntigravityFailedExitFinalRecovery({
        exitCode: 0,
        assistantText: '',
        terminalClaimed: false,
        finalResponse
      })
    ).toBeNull()
    expect(
      planAntigravityFailedExitFinalRecovery({
        exitCode: null,
        assistantText: '',
        terminalClaimed: false,
        finalResponse
      })
    ).toBeNull()
    expect(
      planAntigravityFailedExitFinalRecovery({
        exitCode: 1,
        assistantText: 'Already delivered on stdout.',
        terminalClaimed: false,
        finalResponse
      })
    ).toBeNull()
    expect(
      planAntigravityFailedExitFinalRecovery({
        exitCode: 1,
        assistantText: '',
        terminalClaimed: true,
        finalResponse
      })
    ).toBeNull()
  })

  it('does not invent content when the exact final record is absent or blank', () => {
    expect(
      planAntigravityFailedExitFinalRecovery({
        exitCode: 1,
        assistantText: '',
        terminalClaimed: false,
        finalResponse: null
      })
    ).toBeNull()
    expect(
      planAntigravityFailedExitFinalRecovery({
        exitCode: 1,
        assistantText: '',
        terminalClaimed: false,
        finalResponse: { ...finalResponse, content: '   ' }
      })
    ).toBeNull()
  })
})

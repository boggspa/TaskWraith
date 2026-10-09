import { describe, expect, it } from 'vitest'
import { museApprovalOutcomeRecord } from './MuseApprovalOutcome'
import type { MuseMspApprovalOutcome } from './MuseMspClient'

const outcome: MuseMspApprovalOutcome = {
  approvalId: 'a1',
  requirementId: { approvalId: 'a1', sourceIndex: 0 },
  toolName: 'shell',
  verdict: 'allow',
  choice: null,
  grantScope: null,
  allowApplied: false,
  kind: 'decided'
}

describe('Muse permission outcome audit', () => {
  it.each(['decided', 'rejected', 'noChoice', 'withdrawn'] as const)(
    'never labels a host allow that ended %s without approval as applied',
    (kind) => {
      const record = museApprovalOutcomeRecord({
        appRunId: 'r',
        workspacePath: '/ws',
        outcome: { ...outcome, kind }
      })
      expect(record.status).toBe(kind === 'withdrawn' ? 'cancelled' : 'denied')
      expect(record.metadata).toMatchObject({
        verdict: 'allow',
        allowApplied: false,
        executionObserved: false
      })
    }
  )

  it('records the exact admitted stage and grant scope without claiming execution', () => {
    const record = museApprovalOutcomeRecord({
      appRunId: 'r',
      workspacePath: '/ws',
      outcome: {
        ...outcome,
        allowApplied: true,
        grantScope: 'session',
        choice: { choiceId: 'yes', decision: 'approvedForSession', scope: 'session' }
      }
    })
    expect(record).toMatchObject({ status: 'approved', grantedScope: 'session' })
    expect(record.metadata?.executionObserved).toBe(false)
    expect(record.approvalId).not.toBe(
      museApprovalOutcomeRecord({
        appRunId: 'r',
        workspacePath: '/ws',
        outcome: {
          ...outcome,
          requirementId: { approvalId: 'a1', sourceIndex: 1 }
        }
      }).approvalId
    )
  })
})

import { describe, expect, it } from 'vitest'
import { evaluateEnsembleFanoutWriteAdmission } from './EnsembleFanoutWriteAdmission'

describe('evaluateEnsembleFanoutWriteAdmission', () => {
  it('admits reader lanes and scoped writer lanes', () => {
    expect(
      evaluateEnsembleFanoutWriteAdmission([
        {
          participantId: 'reviewer',
          participantLabel: 'Reviewer',
          intent: 'read',
          approvedWriteScopeCount: 0
        },
        {
          participantId: 'builder',
          participantLabel: 'Builder',
          intent: 'write',
          approvedWriteScopeCount: 2
        }
      ])
    ).toEqual({ ok: true })
  })

  it('rejects unscoped writers before dispatch with the exact remedy', () => {
    const result = evaluateEnsembleFanoutWriteAdmission([
      {
        participantId: 'work-1',
        participantLabel: 'Work1',
        intent: 'write',
        approvedWriteScopeCount: 0
      },
      {
        participantId: 'work-2',
        participantLabel: 'Work2',
        intent: 'write',
        approvedWriteScopeCount: Number.NaN
      }
    ])

    expect(result).toMatchObject({
      ok: false,
      missingParticipantIds: ['work-1', 'work-2']
    })
    if (result.ok) throw new Error('expected rejection')
    expect(result.message).toContain('before provider dispatch')
    expect(result.message).toContain('Seat permission, Full WS Access, or caller seniority')
    expect(result.message).toContain('mode="locked_writers"')
    expect(result.message).toContain('writeScopes keyed by every writer target')
    expect(result.message).toContain('serial rotation')
  })
})

import { describe, expect, it } from 'vitest'
import { agentApprovalEnsembleAttribution } from './agentApprovalAttribution'

describe('agentApprovalEnsembleAttribution', () => {
  it('returns the bounded Ensemble participant context for a complete preview', () => {
    expect(
      agentApprovalEnsembleAttribution({
        ensembleParticipant: {
          participantId: 'claude-solboss',
          role: 'SolBoss',
          stageRole: 'writer',
          laneId: 'lane-9',
          order: 2
        }
      })
    ).toEqual({
      participantId: 'claude-solboss',
      role: 'SolBoss',
      stageRole: 'writer',
      laneId: 'lane-9',
      order: 2
    })
  })

  it('keeps solo and incomplete previews free of attribution', () => {
    expect(agentApprovalEnsembleAttribution(undefined)).toBeNull()
    expect(agentApprovalEnsembleAttribution({ ensembleParticipant: { role: 'Scout' } })).toBeNull()
  })

  it('rejects oversized or malformed descriptive fields', () => {
    expect(
      agentApprovalEnsembleAttribution({
        ensembleParticipant: { participantId: 'p1', role: 'x'.repeat(81) }
      })
    ).toBeNull()
    expect(
      agentApprovalEnsembleAttribution({
        ensembleParticipant: { participantId: 'p1', role: 'Scout', order: 1.5 }
      })
    ).toEqual({ participantId: 'p1', role: 'Scout' })
  })
})

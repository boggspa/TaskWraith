import { describe, expect, it } from 'vitest'
import {
  agentApprovalDisplayTitle,
  agentApprovalEnsembleAttribution
} from './agentApprovalAttribution'

describe('agentApprovalEnsembleAttribution', () => {
  it('returns the bounded Ensemble participant context for a complete preview', () => {
    expect(
      agentApprovalEnsembleAttribution({
        ensembleParticipant: {
          participantId: 'claude-solboss',
          role: 'SolBoss',
          stageRole: 'writer',
          laneId: 'lane-9',
          order: 2,
          effectivePermissionPresetId: 'read_only'
        }
      })
    ).toEqual({
      participantId: 'claude-solboss',
      role: 'SolBoss',
      stageRole: 'writer',
      laneId: 'lane-9',
      order: 2,
      effectivePermissionPresetId: 'read_only'
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
        ensembleParticipant: {
          participantId: 'p1',
          role: 'Scout',
          order: 1.5,
          effectivePermissionPresetId: 'root_access'
        }
      })
    ).toEqual({ participantId: 'p1', role: 'Scout' })
  })
})

/* Both approval authorities bake the seat into the title ("K3Review: …" from
 * main, "Pi / K3Review: …" from the service gate) so the ledger and paired
 * devices stay self-describing. Once the modal renders the @Role chip, that
 * baked prefix is redundant ON SCREEN — strip it for display only, and only
 * on an exact match against the validated attribution. */
describe('agentApprovalDisplayTitle', () => {
  const attribution = { participantId: 'p14', role: 'K3Review' }

  it('strips the exact main-authority role prefix', () => {
    expect(
      agentApprovalDisplayTitle('K3Review: Allow Pi to retry write_file once?', attribution, 'Pi')
    ).toBe('Allow Pi to retry write_file once?')
  })

  it('strips the exact service-gate provider / role prefix', () => {
    expect(
      agentApprovalDisplayTitle('Pi / K3Review: Approve shell command', attribution, 'Pi')
    ).toBe('Approve shell command')
  })

  it('leaves unrelated titles and solo approvals untouched', () => {
    expect(agentApprovalDisplayTitle('Allow once?', attribution, 'Pi')).toBe('Allow once?')
    expect(agentApprovalDisplayTitle('K3Review: Allow once?', null, 'Pi')).toBe(
      'K3Review: Allow once?'
    )
    // A title that IS the prefix must not strip to an empty string.
    expect(agentApprovalDisplayTitle('K3Review: ', attribution, 'Pi')).toBe('K3Review: ')
  })
})

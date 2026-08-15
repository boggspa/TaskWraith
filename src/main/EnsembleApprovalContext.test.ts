import { describe, expect, it } from 'vitest'
import { ensembleApprovalContext } from './EnsembleApprovalContext'
import type { EnsembleRunIdentity } from './store/types'

function identity(): EnsembleRunIdentity {
  return {
    roundId: 'round-1',
    participantId: 'participant-2',
    laneId: 'lane-2',
    provider: 'antigravity',
    role: 'Scout2',
    stageRole: 'scout',
    order: 5
  }
}

describe('ensembleApprovalContext', () => {
  it('carries the signed effective lane preset beside the requesting identity', () => {
    expect(
      ensembleApprovalContext(identity(), 'shellCommands', '/repo', 'read_only')
    ).toMatchObject({
      label: 'AntiGravity / Scout2',
      bodyPrefix: expect.stringContaining('Service: Shell commands'),
      preview: {
        roundId: 'round-1',
        participantId: 'participant-2',
        laneId: 'lane-2',
        provider: 'antigravity',
        role: 'Scout2',
        stageRole: 'scout',
        order: 5,
        service: 'shellCommands',
        workspacePath: '/repo',
        effectivePermissionPresetId: 'read_only'
      }
    })
  })

  it('omits posture when legacy callers cannot prove it and omits solo context', () => {
    expect(
      ensembleApprovalContext(identity(), 'shellCommands', '/repo')?.preview
    ).not.toHaveProperty('effectivePermissionPresetId')
    expect(ensembleApprovalContext(undefined, 'shellCommands', '/repo')).toBeUndefined()
  })
})

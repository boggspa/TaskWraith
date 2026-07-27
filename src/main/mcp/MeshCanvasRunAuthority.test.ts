import { describe, expect, it } from 'vitest'
import type { EffectiveRunPermissions } from '../store/types'
import { meshCanvasParticipantHasPregrantedAuthority } from './MeshCanvasRunAuthority'

function permissions(
  meshCanvas: EffectiveRunPermissions['agenticServices']['meshCanvas'],
  workspaceGrantServiceIds: EffectiveRunPermissions['workspaceGrantServiceIds'] = []
): EffectiveRunPermissions {
  return {
    presetId: 'default',
    approvalMode: 'default',
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'ask',
      externalPublish: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      meshCanvas,
      canvasEval: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny'
    },
    networkAccess: 'allow',
    externalPathGrants: [],
    workspaceGrantServiceIds,
    readOnly: false
  }
}

describe('meshCanvasParticipantHasPregrantedAuthority', () => {
  it('accepts an explicit participant/run allow posture', () => {
    expect(meshCanvasParticipantHasPregrantedAuthority(permissions('allow'))).toBe(true)
  })

  it('requires an actual workspace grant for the workspace policy', () => {
    expect(meshCanvasParticipantHasPregrantedAuthority(permissions('workspace'))).toBe(false)
    expect(
      meshCanvasParticipantHasPregrantedAuthority(permissions('workspace', ['meshCanvas']))
    ).toBe(true)
  })

  it('does not mistake promptable or denied policy for a grant', () => {
    expect(meshCanvasParticipantHasPregrantedAuthority(permissions('ask'))).toBe(false)
    expect(meshCanvasParticipantHasPregrantedAuthority(permissions('deny'))).toBe(false)
  })
})

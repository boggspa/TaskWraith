import { describe, expect, it } from 'vitest'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import type { EffectiveRunPermissions } from '../store/types'
import { meshCanvasParticipantCanRequestAccess } from './MeshCanvasRunAuthority'

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

describe('meshCanvasParticipantCanRequestAccess', () => {
  it('exposes Mesh Canvas directly for Default Approval so the call can prompt', () => {
    const effective = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      presetId: 'default',
      settings: {
        agenticServices: {
          shellCommands: 'ask',
          fileChanges: 'ask',
          externalPublish: 'ask',
          mcpTools: 'ask',
          subThreadDelegation: 'ask',
          canvasInteraction: 'ask',
          meshCanvas: 'ask',
          crossThreadRead: 'ask',
          threadMessage: 'ask',
          mediaEditing: 'ask',
          mediaRecording: 'deny',
          canvasEval: 'ask',
          networkAccess: 'allow'
        },
        agenticWorkspaceGrants: []
      }
    })

    expect(effective.approvalMode).toBe('default')
    expect(effective.agenticServices.meshCanvas).toBe('ask')
    expect(meshCanvasParticipantCanRequestAccess(effective)).toBe(true)
  })

  it('exposes both pregranted and promptable workspace policies', () => {
    expect(meshCanvasParticipantCanRequestAccess(permissions('allow'))).toBe(true)
    expect(meshCanvasParticipantCanRequestAccess(permissions('workspace'))).toBe(true)
    expect(meshCanvasParticipantCanRequestAccess(permissions('workspace', ['meshCanvas']))).toBe(
      true
    )
  })

  it('keeps a denied or missing run posture out of the direct surface', () => {
    expect(meshCanvasParticipantCanRequestAccess(permissions('deny'))).toBe(false)
    expect(meshCanvasParticipantCanRequestAccess(undefined)).toBe(false)
  })
})

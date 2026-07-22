import { describe, expect, it, vi } from 'vitest'
import { canAutoApproveTrustedSessionExternalWrite } from './TrustedSessionExternalWritePolicy'
import type { EffectiveRunPermissions } from './store/types'

function fullAccessPermissions(): EffectiveRunPermissions {
  return {
    presetId: 'full_access',
    approvalMode: 'auto_edit',
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'allow',
      externalPublish: 'allow',
      mcpTools: 'allow',
      subThreadDelegation: 'allow',
      canvasInteraction: 'allow',
      crossThreadRead: 'allow',
      mediaEditing: 'allow',
      mediaRecording: 'deny',
      canvasEval: 'ask'
    },
    networkAccess: 'allow',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: false
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'codex' as const,
    chatId: 'chat-1',
    workspacePath: '/repo',
    runtimeProfileId: 'profile-1',
    externalPathAccess: 'write' as const,
    effectivePermissions: fullAccessPermissions(),
    isTrustedSessionGranted: vi.fn(() => true),
    ...overrides
  }
}

describe('canAutoApproveTrustedSessionExternalWrite', () => {
  it('allows a write requested by the exact trusted chat and runtime profile', () => {
    const candidate = input()

    expect(canAutoApproveTrustedSessionExternalWrite(candidate)).toBe(true)
    expect(candidate.isTrustedSessionGranted).toHaveBeenCalledWith({
      chatId: 'chat-1',
      provider: 'codex',
      workspacePath: '/repo',
      ensembleParticipantId: undefined,
      ensembleLaneId: undefined,
      runtimeProfileId: 'profile-1'
    })
  })

  it('keeps reads, global paths, revoked sessions, and lower postures on their normal path', () => {
    expect(
      canAutoApproveTrustedSessionExternalWrite(input({ externalPathAccess: 'read' }))
    ).toBe(false)
    expect(canAutoApproveTrustedSessionExternalWrite(input({ workspacePath: undefined }))).toBe(false)
    expect(
      canAutoApproveTrustedSessionExternalWrite(
        input({ isTrustedSessionGranted: vi.fn(() => false) })
      )
    ).toBe(false)
    expect(
      canAutoApproveTrustedSessionExternalWrite(
        input({
          effectivePermissions: {
            ...fullAccessPermissions(),
            presetId: 'workspace_write'
          }
        })
      )
    ).toBe(false)
  })

  it('passes the participant and lane identity into the Trusted Session check', () => {
    const candidate = input({
      ensembleRun: {
        roundId: 'round-1',
        participantId: 'writer',
        laneId: 'lane-1',
        provider: 'codex',
        role: 'Writer',
        order: 0
      }
    })

    expect(canAutoApproveTrustedSessionExternalWrite(candidate)).toBe(true)
    expect(candidate.isTrustedSessionGranted).toHaveBeenCalledWith(
      expect.objectContaining({ ensembleParticipantId: 'writer', ensembleLaneId: 'lane-1' })
    )
  })
})

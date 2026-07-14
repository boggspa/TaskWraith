import { describe, expect, it, vi } from 'vitest'
import { signRunPermissionPosture } from '../RunPermissionPosture'
import { buildScheduledTaskPermissionPosture } from './ScheduledTaskPosture'
import type { AppSettings } from '../store/types'

const SECRET = Buffer.from('a'.repeat(64), 'hex')

function settings(): Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'> {
  return {
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'ask',
      externalPublish: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      crossThreadRead: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      canvasEval: 'deny',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: []
  }
}

describe('buildScheduledTaskPermissionPosture', () => {
  it('freezes unattended scheduled work to the plan posture without an elevation ack', () => {
    const signRunPermissionPostureSpy = vi.fn(
      (mode, perms, context) => signRunPermissionPosture(SECRET, mode, perms, context)
    )

    const snapshot = buildScheduledTaskPermissionPosture({
      id: 'task-1',
      provider: 'codex',
      workspacePath: '/repo',
      chatId: 'chat-1',
      prompt: 'Run this later.',
      approvalMode: 'auto_edit',
      workflowMode: 'plan',
      settings: settings(),
      signRunPermissionPosture: signRunPermissionPostureSpy
    })

    expect(snapshot).toMatchObject({
      approvalMode: 'plan',
      workflowMode: 'plan',
      presetId: 'plan',
      readOnly: true,
      signaturePresent: true,
      context: {
        provider: 'codex',
        scope: 'workspace',
        appRunId: 'task-1',
        appChatId: 'chat-1',
        workflowMode: 'plan'
      }
    })
    expect(snapshot.signature).toMatch(/^[a-f0-9]{64}$/)
    expect(signRunPermissionPostureSpy).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ presetId: 'plan', readOnly: true }),
      expect.objectContaining({ appRunId: 'task-1', prompt: 'Run this later.' })
    )
  })

  it('honors a verified default elevation ack while denying unattended network egress', () => {
    const snapshot = buildScheduledTaskPermissionPosture({
      id: 'task-2',
      provider: 'claude',
      workspacePath: '/repo',
      chatId: 'chat-1',
      prompt: 'Run the default workflow.',
      approvalMode: 'default',
      workflowMode: 'normal',
      settings: settings(),
      unattendedElevationAck: {
        level: 'default',
        acknowledgedApprovalMode: 'default',
        authorityDigest: 'a'.repeat(64),
        signature: 'verified-elsewhere',
        acknowledgedAt: '2026-07-02T00:00:00.000Z'
      },
      signRunPermissionPosture: (mode, perms, context) =>
        signRunPermissionPosture(SECRET, mode, perms, context)
    })

    expect(snapshot).toMatchObject({
      approvalMode: 'default',
      workflowMode: 'normal',
      presetId: 'default',
      readOnly: false,
      networkAccess: 'deny',
      signaturePresent: true
    })
  })
})

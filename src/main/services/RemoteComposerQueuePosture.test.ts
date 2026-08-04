import { describe, expect, it, vi } from 'vitest'
import { buildRemoteComposerQueuePermissionPosture } from './RemoteComposerQueuePosture'
import type { AppSettings } from '../store/types'

const settings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'> = {
  agenticServices: {
    shellCommands: 'ask',
    fileChanges: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    canvasEval: 'deny',
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: []
}

describe('buildRemoteComposerQueuePermissionPosture', () => {
  it('freezes a signed plan posture for queued workspace plan prompts', () => {
    const signRunPermissionPosture = vi.fn(() => 'a'.repeat(64))

    const snapshot = buildRemoteComposerQueuePermissionPosture({
      provider: 'codex',
      scope: 'workspace',
      workspacePath: '/repo',
      chatId: 'chat-1',
      runId: 'remote-queue-1',
      text: 'Ship the plan',
      approvalMode: 'default',
      workflowMode: 'plan',
      settings,
      signRunPermissionPosture
    })

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      approvalMode: 'plan',
      workflowMode: 'plan',
      presetId: 'plan',
      readOnly: true,
      signature: 'a'.repeat(64),
      signaturePresent: true,
      context: {
        provider: 'codex',
        scope: 'workspace',
        appRunId: 'remote-queue-1',
        appChatId: 'chat-1',
        workflowMode: 'plan',
        promptHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
    expect(JSON.stringify(snapshot)).not.toContain('Ship the plan')
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ presetId: 'plan', readOnly: true }),
      expect.objectContaining({ prompt: 'Ship the plan' })
    )
  })

  it('signs default queued prompts without inventing a permission preset', () => {
    const signRunPermissionPosture = vi.fn(() => 'b'.repeat(64))

    const snapshot = buildRemoteComposerQueuePermissionPosture({
      provider: 'claude',
      scope: 'workspace',
      workspacePath: '/repo',
      chatId: 'chat-1',
      runId: 'remote-queue-2',
      text: 'Continue',
      approvalMode: 'default',
      workflowMode: 'normal',
      settings,
      signRunPermissionPosture
    })

    expect(snapshot.approvalMode).toBe('default')
    expect(snapshot.workflowMode).toBe('normal')
    expect(snapshot.presetId).toBeUndefined()
    expect(snapshot.readOnly).toBeUndefined()
    expect(snapshot.signaturePresent).toBe(true)
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      'default',
      undefined,
      expect.objectContaining({ workflowMode: 'normal' })
    )
  })

  it('downgrades a queued Full-access composer prompt without Full Access', () => {
    const signRunPermissionPosture = vi.fn(() => 'd'.repeat(64))

    const snapshot = buildRemoteComposerQueuePermissionPosture({
      provider: 'codex',
      scope: 'workspace',
      workspacePath: '/repo',
      chatId: 'chat-1',
      runId: 'remote-queue-fa',
      text: 'Ship it',
      approvalMode: 'auto_edit',
      workflowMode: 'normal',
      permissionPresetId: 'full_access',
      settings,
      signRunPermissionPosture
    })

    expect(snapshot.presetId).toBe('workspace_write')
    expect(snapshot.readOnly).toBe(false)
    expect(snapshot.approvalMode).toBe('auto_edit')
    expect(snapshot.signaturePresent).toBe(true)
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      'auto_edit',
      expect.objectContaining({ presetId: 'workspace_write', readOnly: false }),
      expect.objectContaining({ workflowMode: 'normal' })
    )
  })

  it('freezes a signed full_access posture only with Full Access', () => {
    const signRunPermissionPosture = vi.fn(() => 'd'.repeat(64))

    const snapshot = buildRemoteComposerQueuePermissionPosture({
      provider: 'codex',
      scope: 'workspace',
      workspacePath: '/repo',
      chatId: 'chat-1',
      runId: 'remote-queue-fa',
      text: 'Ship it',
      approvalMode: 'auto_edit',
      workflowMode: 'normal',
      permissionPresetId: 'full_access',
      trustedSessionGranted: true,
      settings,
      signRunPermissionPosture
    })

    expect(snapshot.presetId).toBe('full_access')
    expect(snapshot.readOnly).toBe(false)
    expect(snapshot.approvalMode).toBe('auto_edit')
    expect(snapshot.signaturePresent).toBe(true)
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      'auto_edit',
      expect.objectContaining({ presetId: 'full_access', readOnly: false }),
      expect.objectContaining({ workflowMode: 'normal' })
    )
  })

  it('freezes Full WS Access exactly for queued remote prompts', () => {
    const signRunPermissionPosture = vi.fn(() => 'e'.repeat(64))

    const snapshot = buildRemoteComposerQueuePermissionPosture({
      provider: 'codex',
      scope: 'workspace',
      workspacePath: '/repo',
      chatId: 'chat-1',
      runId: 'remote-queue-ww',
      text: 'x',
      approvalMode: 'default',
      workflowMode: 'normal',
      permissionPresetId: 'workspace_write',
      settings,
      signRunPermissionPosture
    })

    expect(snapshot.presetId).toBe('workspace_write')
    expect(snapshot.approvalMode).toBe('auto_edit')
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      'auto_edit',
      expect.objectContaining({ presetId: 'workspace_write', readOnly: false }),
      expect.objectContaining({ workflowMode: 'normal' })
    )
  })

  it('forces global queued prompts to a signed read-only posture', () => {
    const signRunPermissionPosture = vi.fn(() => 'c'.repeat(64))

    const snapshot = buildRemoteComposerQueuePermissionPosture({
      provider: 'grok',
      scope: 'global',
      chatId: 'global-chat',
      runId: 'remote-queue-global',
      text: 'Discuss only',
      approvalMode: 'auto_edit',
      workflowMode: 'plan',
      settings,
      signRunPermissionPosture
    })

    expect(snapshot).toMatchObject({
      approvalMode: 'plan',
      workflowMode: 'normal',
      presetId: 'read_only',
      readOnly: true,
      signaturePresent: true
    })
    expect(signRunPermissionPosture).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ presetId: 'read_only', readOnly: true }),
      expect.objectContaining({ scope: 'global' })
    )
  })
})

import { describe, expect, it } from 'vitest'
import { signRunPermissionPosture, verifyRunPermissionPosture } from '../RunPermissionPosture'
import type { AppSettings, RunQueueRequestSnapshot } from '../store/types'
import {
  buildExecutionGraphPermissionPosture,
  verifyExecutionGraphPermissionPosture
} from './ExecutionGraphPermissionAuthority'

const secret = 'execution-graph-permission-test-secret'
const settings = {
  agenticServices: {
    shellCommands: 'ask',
    fileChanges: 'ask',
    externalPublish: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    crossThreadRead: 'ask',
    mediaEditing: 'ask',
    mediaRecording: 'deny',
    canvasEval: 'ask',
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: []
} as Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>

function request(overrides: Partial<RunQueueRequestSnapshot> = {}): RunQueueRequestSnapshot {
  return {
    prompt: 'Implement the reviewed change.',
    selectedModelType: 'cli-default',
    customModel: '',
    approvalMode: 'default',
    permissionPresetId: 'workspace_write',
    sessionTrust: false,
    imageAttachments: [],
    ...overrides
  }
}

function build(input = request()) {
  return buildExecutionGraphPermissionPosture({
    provider: 'codex',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    request: input,
    settings,
    sign: (approvalMode, permissions, context) =>
      signRunPermissionPosture(secret, approvalMode, permissions, context)
  })
}

function verify(posture: ReturnType<typeof build>, input = request()) {
  return verifyExecutionGraphPermissionPosture({
    provider: 'codex',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    request: input,
    posture,
    verify: (approvalMode, permissions, signature, context) =>
      verifyRunPermissionPosture(secret, approvalMode, permissions, signature, context)
  })
}

describe('ExecutionGraphPermissionAuthority', () => {
  it('freezes and verifies the exact effective write posture', () => {
    const posture = build()

    expect(posture).toMatchObject({
      presetId: 'workspace_write',
      approvalMode: 'auto_edit',
      readOnly: false,
      signaturePresent: true,
      context: {
        provider: 'codex',
        scope: 'workspace',
        appChatId: 'chat-one'
      }
    })
    expect(verify(posture)).toMatchObject({
      approvalMode: 'auto_edit',
      effectivePermissions: { presetId: 'workspace_write' }
    })
  })

  it('downgrades non-durable Full Access to workspace write', () => {
    const posture = build(request({ permissionPresetId: 'full_access', sessionTrust: true }))
    expect(posture.presetId).toBe('workspace_write')
    expect(posture.agenticServices?.shellCommands).toBe('workspace')
  })

  it('rejects prompt, provider, and grant mutations after signing', () => {
    const posture = build()

    expect(() => verify(posture, request({ prompt: 'A different task.' }))).toThrow(/invalid/i)
    expect(() =>
      verifyExecutionGraphPermissionPosture({
        provider: 'claude',
        workspacePath: '/workspace',
        chatId: 'chat-one',
        request: request(),
        posture,
        verify: (approvalMode, permissions, signature, context) =>
          verifyRunPermissionPosture(secret, approvalMode, permissions, signature, context)
      })
    ).toThrow(/invalid/i)
  })

  it('rejects unsigned or structurally incomplete snapshots', () => {
    const posture = build()
    expect(() => verify({ ...posture, signature: undefined, signaturePresent: false })).toThrow(
      /unsigned/i
    )
    expect(() => verify({ ...posture, agenticServices: undefined })).toThrow(/incomplete/i)
  })
})

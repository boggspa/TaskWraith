import { describe, expect, it } from 'vitest'
import type { AgentRunPayload } from '../../../main/run/AgentRunTypes'
import { buildCodexNativeReviewInvocationParams } from './codexNativeReview'

function composedPayload(): AgentRunPayload {
  return {
    provider: 'codex',
    scope: 'workspace',
    workspace: '/workspace',
    prompt: 'main-composed review prompt',
    resumeFallbackPrompt: 'main-composed fallback',
    appRunId: 'run-review',
    appChatId: 'chat-review',
    approvalMode: 'plan',
    workflowMode: 'normal',
    effectivePermissions: {
      presetId: 'read_only',
      approvalMode: 'plan',
      readOnly: true,
      networkAccess: 'deny',
      agenticServices: {
        fileChanges: 'deny',
        shellCommands: 'deny',
        externalPublish: 'deny',
        mcpTools: 'deny',
        subThreadDelegation: 'deny',
        canvasInteraction: 'deny',
        sketchCanvas: 'deny',
        meshCanvas: 'deny',
        canvasEval: 'deny',
        crossThreadRead: 'deny',
        threadMessage: 'deny',
        mediaEditing: 'deny',
        mediaRecording: 'deny',
        webBrowsing: 'deny'
      },
      externalPathGrants: [],
      workspaceGrantServiceIds: []
    },
    effectivePermissionsSignature: 'main-hmac'
  }
}

describe('buildCodexNativeReviewInvocationParams', () => {
  it('carries the exact main-signed posture and route into review params', () => {
    const payload = composedPayload()
    const params = buildCodexNativeReviewInvocationParams({
      composedPayload: payload,
      cwd: '/workspace',
      model: 'gpt-5.6',
      usagePromptText: '/review current diff'
    })

    expect(params).toMatchObject({
      model: 'gpt-5.6',
      target: { type: 'uncommittedChanges' },
      delivery: 'inline',
      cwd: '/workspace',
      appRunId: 'run-review',
      appChatId: 'chat-review',
      usagePromptText: '/review current diff',
      signedRunPayload: {
        provider: 'codex',
        scope: 'workspace',
        prompt: 'main-composed review prompt',
        resumeFallbackPrompt: 'main-composed fallback',
        appRunId: 'run-review',
        appChatId: 'chat-review',
        approvalMode: 'plan',
        workflowMode: 'normal',
        effectivePermissionsSignature: 'main-hmac',
        effectivePermissions: {
          presetId: 'read_only',
          approvalMode: 'plan',
          readOnly: true
        }
      }
    })
    expect(params.signedRunPayload.effectivePermissions).not.toBe(payload.effectivePermissions)
  })

  it.each([
    ['missing signature', { effectivePermissionsSignature: undefined }],
    ['missing permissions', { effectivePermissions: undefined }],
    [
      'writable permissions',
      {
        effectivePermissions: {
          ...composedPayload().effectivePermissions!,
          readOnly: false
        }
      }
    ],
    ['raised approval mode', { approvalMode: 'auto_edit' }]
  ])('fails closed for %s', (_label, patch) => {
    expect(() =>
      buildCodexNativeReviewInvocationParams({
        composedPayload: { ...composedPayload(), ...patch },
        cwd: '/workspace'
      })
    ).toThrow(/signed|read-only/)
  })
})

import { describe, expect, it } from 'vitest'
import type { JsonObject } from './ExecutionGraphModel'
import {
  executionGraphRunTemplateAuthorityDigest,
  executionGraphRunTemplateAuthorityEnvelope,
  executionGraphRunTemplatePermissionCeilingDigest,
  executionGraphRunTemplatePermissionCeilingEnvelope
} from './ExecutionGraphRunTemplateAuthority'

function template(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: 1,
    provider: 'codex',
    scope: 'workspace',
    workspaceId: 'workspace-one',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    runtimeProfileId: 'runtime-codex-one',
    request: {
      scope: 'workspace',
      prompt: 'Implement the reviewed change.',
      displayPrompt: 'A friendly display-only summary',
      selectedModelType: 'cli-default',
      customModel: '',
      effectiveWorkspacePath: '/workspace/.taskwraith/worktrees/one',
      approvalMode: 'auto_edit',
      permissionPresetId: 'workspace_write',
      workflowMode: 'normal',
      sessionTrust: true,
      externalPathGrants: [
        {
          id: 'grant-one',
          provider: 'codex',
          bindingVersion: 2,
          workspaceId: 'workspace-one',
          chatId: 'chat-one',
          appRunId: 'graph-template-probe-one',
          path: '/approved/reference',
          kind: 'directory',
          access: 'read',
          duration: 'thisRun',
          securityScopedBookmark: 'bookmark-one',
          issuedBy: 'main',
          signature: 'signed-grant',
          createdAt: '2026-07-18T11:00:00.000Z',
          order: 4
        }
      ],
      projectReferenceContextSelection: {
        referenceIds: ['reference-one']
      }
    },
    permissionPosture: {
      schemaVersion: 1,
      approvalMode: 'auto_edit',
      workflowMode: 'normal',
      presetId: 'workspace_write',
      readOnly: false,
      agenticServices: {
        shellCommands: 'workspace',
        fileChanges: 'workspace',
        externalPublish: 'ask',
        mcpTools: 'ask',
        subThreadDelegation: 'ask',
        canvasInteraction: 'ask',
        canvasEval: 'ask',
        crossThreadRead: 'ask',
        mediaEditing: 'workspace',
        mediaRecording: 'deny'
      },
      networkAccess: 'allow',
      workspaceGrantServiceIds: ['fileChanges'],
      externalPathGrantCount: 1,
      externalPathGrantHash: 'd'.repeat(64),
      postureHash: 'c'.repeat(64),
      signature: 'signed-posture',
      signaturePresent: true
    },
    presentation: {
      title: 'Renderer title',
      createdAt: '2026-07-18T12:00:00.000Z'
    },
    ...overrides
  }
}

describe('ExecutionGraphRunTemplateAuthority', () => {
  it('preserves the v1 authority envelope and forces durable session trust off', () => {
    expect(executionGraphRunTemplateAuthorityEnvelope(template())).toEqual({
      schemaVersion: 1,
      provider: 'codex',
      scope: 'workspace',
      workspaceId: 'workspace-one',
      workspacePath: '/workspace',
      chatId: 'chat-one',
      runtimeProfileId: 'runtime-codex-one',
      selectedModelType: 'cli-default',
      customModel: '',
      effectiveWorkspacePath: '/workspace/.taskwraith/worktrees/one',
      approvalMode: 'auto_edit',
      permissionPresetId: 'workspace_write',
      workflowMode: 'normal',
      sessionTrust: false,
      permissionPostureHash: 'c'.repeat(64),
      externalPathGrants: [
        {
          provider: 'codex',
          path: '/approved/reference',
          kind: 'directory',
          access: 'read',
          duration: 'thisRun',
          issuedBy: 'main',
          signature: 'signed-grant'
        }
      ],
      projectReferenceContextSelection: {
        referenceIds: ['reference-one']
      }
    })
  })

  it('matches the pre-extraction SHA-256 authority digest exactly', () => {
    expect(executionGraphRunTemplateAuthorityDigest(template())).toBe(
      'e65428446006308c6371b45b008bb4595b68bd994b10d50cd45ba03d485aa91e'
    )
  })

  it('excludes presentation while binding authority-bearing template fields', () => {
    const original = template()
    const renamed = template({
      presentation: { title: 'Renamed renderer card', createdAt: '2030-01-01T00:00:00.000Z' },
      request: {
        ...(original.request as JsonObject),
        displayPrompt: 'Different display copy'
      }
    })
    const withoutEphemeralTrust = template({
      request: {
        ...(original.request as JsonObject),
        sessionTrust: false
      }
    })
    const otherRuntime = template({ runtimeProfileId: 'runtime-codex-two' })

    expect(executionGraphRunTemplateAuthorityDigest(renamed)).toBe(
      executionGraphRunTemplateAuthorityDigest(original)
    )
    expect(executionGraphRunTemplateAuthorityDigest(withoutEphemeralTrust)).toBe(
      executionGraphRunTemplateAuthorityDigest(original)
    )
    expect(executionGraphRunTemplateAuthorityDigest(otherRuntime)).not.toBe(
      executionGraphRunTemplateAuthorityDigest(original)
    )
  })

  it('builds a reusable permission-only ceiling from normalized authority', () => {
    expect(executionGraphRunTemplatePermissionCeilingEnvelope(template())).toEqual({
      schemaVersion: 1,
      provider: 'codex',
      scope: 'workspace',
      workspaceId: 'workspace-one',
      workspacePath: '/workspace',
      chatId: 'chat-one',
      effectiveWorkspacePath: '/workspace/.taskwraith/worktrees/one',
      runtimeProfileId: 'runtime-codex-one',
      sessionTrust: false,
      approvalMode: 'auto_edit',
      workflowMode: 'normal',
      presetId: 'workspace_write',
      readOnly: false,
      agenticServices: {
        shellCommands: 'workspace',
        fileChanges: 'workspace',
        externalPublish: 'ask',
        mcpTools: 'ask',
        subThreadDelegation: 'ask',
        canvasInteraction: 'ask',
        canvasEval: 'ask',
        crossThreadRead: 'ask',
        mediaEditing: 'workspace',
        mediaRecording: 'deny'
      },
      networkAccess: 'allow',
      workspaceGrantServiceIds: ['fileChanges'],
      externalPathGrantCount: 1,
      externalPathGrantHash: 'd'.repeat(64),
      externalPathGrants: [
        {
          id: 'grant-one',
          provider: 'codex',
          bindingVersion: 2,
          workspaceId: 'workspace-one',
          chatId: 'chat-one',
          appRunId: 'graph-template-probe-one',
          path: '/approved/reference',
          kind: 'directory',
          access: 'read',
          duration: 'thisRun',
          securityScopedBookmark: 'bookmark-one',
          issuedBy: 'main',
          signature: 'signed-grant',
          createdAt: '2026-07-18T11:00:00.000Z'
        }
      ]
    })
  })

  it('shares a ceiling across different prompt, model, and Project-reference data', () => {
    const original = template()
    const otherRequest = template({
      request: {
        ...(original.request as JsonObject),
        prompt: 'A completely different second Stack step.',
        displayPrompt: 'Different presentation',
        selectedModelType: 'gpt-5.6-sol',
        customModel: 'gpt-5.6-sol',
        projectReferenceContextSelection: { referenceIds: ['reference-two'] }
      },
      permissionPosture: {
        ...(original.permissionPosture as JsonObject),
        postureHash: 'e'.repeat(64),
        signature: 'different-prompt-bound-signature',
        context: {
          promptHash: 'f'.repeat(64),
          projectReferenceContextHash: '1'.repeat(64)
        }
      },
      presentation: { title: 'Second Stack card' }
    })

    expect(executionGraphRunTemplatePermissionCeilingDigest(otherRequest)).toBe(
      executionGraphRunTemplatePermissionCeilingDigest(original)
    )
    expect(executionGraphRunTemplateAuthorityDigest(otherRequest)).not.toBe(
      executionGraphRunTemplateAuthorityDigest(original)
    )
  })

  it('canonicalizes absent, empty, and reordered workspace grant service ids', () => {
    const original = template()
    const originalPosture = original.permissionPosture as JsonObject
    const postureWithoutWorkspaceGrantServiceIds = { ...originalPosture }
    delete postureWithoutWorkspaceGrantServiceIds.workspaceGrantServiceIds
    const absent = template({
      permissionPosture: postureWithoutWorkspaceGrantServiceIds
    })
    const empty = template({
      permissionPosture: {
        ...originalPosture,
        workspaceGrantServiceIds: []
      }
    })
    const ordered = template({
      permissionPosture: {
        ...originalPosture,
        workspaceGrantServiceIds: ['fileChanges', 'shellCommands']
      }
    })
    const reordered = template({
      permissionPosture: {
        ...originalPosture,
        workspaceGrantServiceIds: ['shellCommands', 'fileChanges', 'fileChanges']
      }
    })

    expect(executionGraphRunTemplatePermissionCeilingDigest(absent)).toBe(
      executionGraphRunTemplatePermissionCeilingDigest(empty)
    )
    expect(executionGraphRunTemplatePermissionCeilingDigest(reordered)).toBe(
      executionGraphRunTemplatePermissionCeilingDigest(ordered)
    )
  })

  it('changes the ceiling for permission, workspace, runtime, and grant changes', () => {
    const original = template()
    const originalPosture = original.permissionPosture as JsonObject
    const originalRequest = original.request as JsonObject
    const originalGrants = originalRequest.externalPathGrants as JsonObject[]
    const digest = executionGraphRunTemplatePermissionCeilingDigest(original)
    const variants = [
      template({
        permissionPosture: {
          ...originalPosture,
          presetId: 'read_only',
          readOnly: true
        }
      }),
      template({ workspacePath: '/another-workspace' }),
      template({ runtimeProfileId: 'runtime-codex-two' }),
      template({
        request: {
          ...originalRequest,
          externalPathGrants: [{ ...originalGrants[0], access: 'write' }]
        }
      })
    ]

    for (const variant of variants) {
      expect(executionGraphRunTemplatePermissionCeilingDigest(variant)).not.toBe(digest)
    }
  })
})

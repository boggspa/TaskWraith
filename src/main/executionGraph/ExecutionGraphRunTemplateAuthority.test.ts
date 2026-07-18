import { describe, expect, it } from 'vitest'
import type { JsonObject } from './ExecutionGraphModel'
import {
  executionGraphRunTemplateAuthorityDigest,
  executionGraphRunTemplateAuthorityEnvelope
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
          provider: 'codex',
          path: '/approved/reference',
          kind: 'directory',
          access: 'read',
          duration: 'thisRun',
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
})

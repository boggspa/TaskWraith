import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition } from './store/types'
import { workflowAuthorityDigest } from './WorkflowAuthorityDigest'

const now = '2026-07-14T12:00:00.000Z'
const canonicalPath = (value: string) => value.replace(/\/$/, '')

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'workflow-1',
    name: 'Review workflow',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    enabled: true,
    trigger: { kind: 'interval', intervalMs: 120_000, startAt: now },
    template: {
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Review the workspace.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      externalPathGrants: []
    },
    missedRunPolicy: 'coalesce',
    concurrencyPolicy: 'skip',
    limits: { maxRunsPerDay: 4, maxConsecutiveFailures: 3 },
    failureStreak: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

describe('workflowAuthorityDigest', () => {
  it('is stable across projection-only changes and canonical path spelling', () => {
    const base = workflow()
    const expected = workflowAuthorityDigest(base, canonicalPath)
    expect(
      workflowAuthorityDigest(
        {
          ...base,
          name: 'Renamed',
          enabled: false,
          workspacePath: '/workspace/',
          failureStreak: 9,
          history: [
            {
              id: 'execution-1',
              workflowId: base.id,
              plannedFor: now,
              status: 'completed',
              createdAt: now,
              updatedAt: now
            }
          ],
          updatedAt: '2026-07-14T13:00:00.000Z'
        },
        canonicalPath
      )
    ).toBe(expected)
  })

  it('changes for every class of unattended execution authority', () => {
    const base = workflow()
    const expected = workflowAuthorityDigest(base, canonicalPath)
    const variants: WorkflowDefinition[] = [
      { ...base, workspaceId: 'workspace-2' },
      { ...base, workspacePath: '/other' },
      { ...base, template: { ...base.template, chatId: 'chat-2' } },
      { ...base, template: { ...base.template, provider: 'claude' } },
      { ...base, template: { ...base.template, prompt: 'Retargeted prompt.' } },
      { ...base, template: { ...base.template, selectedModelType: 'other-model' } },
      {
        ...base,
        template: {
          ...base.template,
          customModel: 'custom-model',
          runtimeProfileId: 'runtime-2'
        }
      },
      { ...base, template: { ...base.template, approvalMode: 'auto_edit' } },
      {
        ...base,
        template: {
          ...base.template,
          permissionPresetId: 'workspace_write',
          workflowMode: 'plan'
        }
      },
      {
        ...base,
        template: {
          ...base.template,
          imageAttachments: [
            {
              persistenceVersion: 1,
              id: 'image-1',
              path: '/main-owned/image.png',
              name: 'image.png',
              sha256: 'd'.repeat(43),
              mimeType: 'image/png',
              byteLength: 12
            }
          ]
        }
      },
      {
        ...base,
        template: {
          ...base.template,
          externalPathGrants: [
            {
              id: 'grant-1',
              provider: 'codex',
              path: '/external',
              kind: 'directory',
              access: 'write',
              duration: 'workspace',
              createdAt: now
            }
          ]
        }
      },
      {
        ...base,
        template: {
          ...base.template,
          kind: 'ensemble',
          ensembleSnapshot: {
            orchestrationMode: 'turn_bound',
            participants: [],
            capturedAt: now
          }
        }
      },
      { ...base, trigger: { kind: 'manual' } },
      { ...base, missedRunPolicy: 'skip' },
      { ...base, concurrencyPolicy: 'enqueue' },
      { ...base, limits: { ...base.limits, maxRunsPerDay: 5 } },
      {
        ...base,
        loop: {
          acceptance: { maxIterations: 2, verifier: { provider: 'claude' } },
          limits: { maxRuns: 2 }
        }
      }
    ]

    for (const candidate of variants) {
      expect(workflowAuthorityDigest(candidate, canonicalPath)).not.toBe(expected)
    }
  })
})

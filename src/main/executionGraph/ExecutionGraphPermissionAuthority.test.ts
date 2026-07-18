import { describe, expect, it, vi } from 'vitest'
import {
  EXECUTION_GRAPH_ATTEMPT_POSTURE_SIGNATURE_PREFIX,
  EXECUTION_GRAPH_TEMPLATE_POSTURE_SIGNATURE_PREFIX,
  signRunPermissionPosture,
  verifyRunPermissionPosture
} from '../RunPermissionPosture'
import type { AppSettings, RunQueueJob, RunQueueRequestSnapshot } from '../store/types'
import {
  assertExecutionGraphPermissionPostureStillCurrent,
  buildExecutionGraphPermissionPosture,
  mintExecutionGraphAttemptPermissionPosture,
  resolveExecutionGraphQueuePermissionPosture,
  verifyExecutionGraphAttemptPermissionPosture,
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

function build(input = request(), runtimeProfileId?: string) {
  return buildExecutionGraphPermissionPosture({
    provider: 'codex',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    request: input,
    ...(runtimeProfileId ? { runtimeProfileId } : {}),
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

function mint(
  templatePosture: ReturnType<typeof build>,
  input = request(),
  appRunId = 'graph-run-one',
  runtimeProfileId?: string
) {
  return mintExecutionGraphAttemptPermissionPosture({
    appRunId,
    provider: 'codex',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    request: input,
    ...(runtimeProfileId ? { runtimeProfileId } : {}),
    templatePosture,
    sign: (approvalMode, permissions, context) =>
      signRunPermissionPosture(secret, approvalMode, permissions, context),
    verifyTemplate: (approvalMode, permissions, signature, context) =>
      verifyRunPermissionPosture(secret, approvalMode, permissions, signature, context)
  })
}

function verifyAttempt(
  posture: ReturnType<typeof mint>,
  input = request(),
  appRunId = 'graph-run-one',
  runtimeProfileId?: string
) {
  return verifyExecutionGraphAttemptPermissionPosture({
    appRunId,
    provider: 'codex',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    request: input,
    ...(runtimeProfileId ? { runtimeProfileId } : {}),
    posture,
    verify: (approvalMode, permissions, signature, context) =>
      verifyRunPermissionPosture(secret, approvalMode, permissions, signature, context)
  })
}

function graphJob(
  overrides: Partial<RunQueueJob> = {},
  requestOverrides: Partial<RunQueueRequestSnapshot> = {}
): RunQueueJob {
  const storedRequest = request({ scope: 'workspace', ...requestOverrides })
  return {
    id: 'graph-run-one',
    runId: 'graph-run-one',
    provider: 'codex',
    scope: 'workspace',
    workspaceId: 'workspace-one',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    source: 'system',
    status: 'queued',
    priority: 0,
    attempt: 0,
    request: storedRequest,
    permissionPosture: mint(
      build(storedRequest, storedRequest.runtimeProfileId),
      storedRequest,
      'graph-run-one',
      storedRequest.runtimeProfileId
    ),
    executionGraph: {
      schemaVersion: 1,
      executionId: 'execution-one',
      activationId: 'activation-one',
      attemptId: 'attempt-one',
      runTemplateRef: `run-template-${'a'.repeat(64)}`,
      permissionCeilingAuthorityDigest: 'b'.repeat(64)
    },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides
  }
}

const expectedComposerIdentity = {
  appRunId: 'graph-run-one',
  provider: 'codex' as const,
  scope: 'workspace' as const,
  chatId: 'chat-one',
  workspacePath: '/workspace'
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
    expect(posture.signature).toMatch(
      new RegExp(`^${EXECUTION_GRAPH_TEMPLATE_POSTURE_SIGNATURE_PREFIX}`)
    )
    expect(verify(posture)).toMatchObject({
      approvalMode: 'auto_edit',
      effectivePermissions: { presetId: 'workspace_write' }
    })
  })

  it('keeps a reusable template proof outside the generic dispatch signature domain', () => {
    const posture = build()
    const permissions = verify(posture).effectivePermissions
    const genericContext = {
      provider: 'codex',
      scope: 'workspace',
      workspacePath: '/workspace',
      appChatId: 'chat-one',
      prompt: request().prompt,
      workflowMode: 'normal'
    }

    expect(
      verifyRunPermissionPosture(
        secret,
        posture.approvalMode,
        permissions,
        posture.signature,
        genericContext
      )
    ).toBe(false)
    expect(
      verifyRunPermissionPosture(secret, posture.approvalMode, permissions, posture.signature, {
        ...genericContext,
        appRunId: 'graph-run-one'
      })
    ).toBe(false)
  })

  it('mints a fresh permission posture that is valid only for one exact graph attempt', () => {
    const posture = mint(build())

    expect(posture.signature).toMatch(
      new RegExp(`^${EXECUTION_GRAPH_ATTEMPT_POSTURE_SIGNATURE_PREFIX}`)
    )
    expect(posture.context).toMatchObject({
      provider: 'codex',
      scope: 'workspace',
      appRunId: 'graph-run-one',
      appChatId: 'chat-one'
    })
    expect(verifyAttempt(posture)).toMatchObject({
      approvalMode: 'auto_edit',
      effectivePermissions: { presetId: 'workspace_write' }
    })
    expect(() => verifyAttempt(posture, request(), 'graph-run-two')).toThrow(/invalid or stale/i)
    expect(() =>
      verifyExecutionGraphAttemptPermissionPosture({
        appRunId: 'graph-run-one',
        provider: 'codex',
        workspacePath: '/other-workspace',
        chatId: 'chat-one',
        request: request(),
        posture,
        verify: (approvalMode, permissions, signature, context) =>
          verifyRunPermissionPosture(secret, approvalMode, permissions, signature, context)
      })
    ).toThrow(/invalid or stale/i)
  })

  it('downgrades non-durable Full Access to workspace write', () => {
    const posture = build(request({ permissionPresetId: 'full_access', sessionTrust: true }))
    expect(posture.presetId).toBe('workspace_write')
    expect(posture.agenticServices?.shellCommands).toBe('workspace')
  })

  it('requires review when a workspace grant is revoked before a later attempt', () => {
    const grantSettings = {
      ...settings,
      agenticWorkspaceGrants: [
        {
          id: 'workspace-grant-one',
          provider: 'codex' as const,
          workspacePath: '/workspace',
          service: 'shellCommands' as const,
          createdAt: '2026-07-18T00:00:00.000Z',
          updatedAt: '2026-07-18T00:00:00.000Z'
        }
      ]
    }
    const defaultRequest = request({ permissionPresetId: 'default' })
    const buildWith = (
      currentSettings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
    ) =>
      buildExecutionGraphPermissionPosture({
        provider: 'codex',
        workspacePath: '/workspace',
        chatId: 'chat-one',
        request: defaultRequest,
        settings: currentSettings,
        sign: (approvalMode, permissions, context) =>
          signRunPermissionPosture(secret, approvalMode, permissions, context)
      })
    const frozen = buildWith(grantSettings)

    expect(() => assertExecutionGraphPermissionPostureStillCurrent(frozen, buildWith(grantSettings)))
      .not.toThrow()
    expect(() => assertExecutionGraphPermissionPostureStillCurrent(frozen, buildWith(settings)))
      .toThrow(/permission policy changed/i)
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

  it('returns null for queue jobs that are not graph-owned', () => {
    const job = graphJob({ executionGraph: undefined })
    const verifier = vi.fn()

    expect(
      resolveExecutionGraphQueuePermissionPosture({
        job,
        expected: expectedComposerIdentity,
        verify: verifier
      })
    ).toBeNull()
    expect(
      resolveExecutionGraphQueuePermissionPosture({
        job: null,
        expected: expectedComposerIdentity,
        verify: verifier
      })
    ).toBeNull()
    expect(verifier).not.toHaveBeenCalled()
  })

  it('verifies and returns the frozen posture from the main-owned graph job', () => {
    const job = graphJob()
    const verifier = vi.fn((approvalMode, permissions, signature, context) =>
      verifyRunPermissionPosture(secret, approvalMode, permissions, signature, context)
    )

    expect(
      resolveExecutionGraphQueuePermissionPosture({
        job,
        expected: expectedComposerIdentity,
        verify: verifier
      })
    ).toMatchObject({
      approvalMode: 'auto_edit',
      workflowMode: 'normal',
      effectivePermissions: { presetId: 'workspace_write', readOnly: false }
    })
    expect(verifier).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['scope', { scope: 'global' as const }, expectedComposerIdentity],
    ['provider', { provider: 'claude' as const }, expectedComposerIdentity],
    ['chat', { chatId: 'chat-two' }, expectedComposerIdentity],
    ['workspace', { workspacePath: '/other' }, expectedComposerIdentity]
  ])(
    'rejects a graph job whose %s identity differs from the composer',
    (_label, patch, expected) => {
      expect(() =>
        resolveExecutionGraphQueuePermissionPosture({
          job: graphJob(patch),
          expected,
          verify: () => true
        })
      ).toThrow(/does not match the composer/i)
    }
  )

  it('binds both queue and request runtime profiles to the composer identity', () => {
    const runtimeProfileId = 'runtime-codex-one'
    const job = graphJob({ runtimeProfileId }, { runtimeProfileId })
    const expected = { ...expectedComposerIdentity, runtimeProfileId }

    expect(
      resolveExecutionGraphQueuePermissionPosture({
        job,
        expected,
        verify: (approvalMode, permissions, signature, context) =>
          verifyRunPermissionPosture(secret, approvalMode, permissions, signature, context)
      })
    ).toMatchObject({ effectivePermissions: { presetId: 'workspace_write' } })

    expect(() =>
      resolveExecutionGraphQueuePermissionPosture({
        job: { ...job, runtimeProfileId: 'runtime-codex-two' },
        expected,
        verify: () => true
      })
    ).toThrow(/runtime profile/i)
    expect(() =>
      resolveExecutionGraphQueuePermissionPosture({
        job: { ...job, request: { ...job.request!, runtimeProfileId: undefined } },
        expected,
        verify: () => true
      })
    ).toThrow(/runtime profile/i)
  })

  it('rejects missing request, posture, and mismatched posture authority before verification', () => {
    const verifier = vi.fn(() => true)
    const job = graphJob()

    expect(() =>
      resolveExecutionGraphQueuePermissionPosture({
        job: { ...job, request: undefined },
        expected: expectedComposerIdentity,
        verify: verifier
      })
    ).toThrow(/request is unavailable/i)
    expect(() =>
      resolveExecutionGraphQueuePermissionPosture({
        job: { ...job, permissionPosture: undefined },
        expected: expectedComposerIdentity,
        verify: verifier
      })
    ).toThrow(/posture is unavailable/i)
    expect(() =>
      resolveExecutionGraphQueuePermissionPosture({
        job: {
          ...job,
          permissionPosture: {
            ...job.permissionPosture!,
            context: { ...job.permissionPosture!.context, appChatId: 'chat-two' }
          }
        },
        expected: expectedComposerIdentity,
        verify: verifier
      })
    ).toThrow(/authority does not match/i)
    expect(verifier).not.toHaveBeenCalled()
  })
})

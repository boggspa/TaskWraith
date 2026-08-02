import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type {
  WorkspaceLockRuntimeAcquireInput,
  WorkspaceLockRuntimeAcquireResult
} from './WorkspaceLockRuntime'
import {
  WorkspaceLockMcpAdmissionCoordinator,
  type WorkspaceLockMcpAdmissionCoordinatorDependencies,
  type WorkspaceLockMcpAdmissionInput
} from './WorkspaceLockMcpAdmissionCoordinator'
import { mcpToolAlwaysPrompts } from './mcp/McpRouteGuards'
import type {
  CanonicalWorkspaceLockClaim,
  WorkspaceLockClaimRequest,
  WorkspaceLockLease,
  WorkspaceLockOwner
} from './workLocks/WorkspaceLockTypes'

function input(
  overrides: Partial<WorkspaceLockMcpAdmissionInput> = {}
): WorkspaceLockMcpAdmissionInput {
  return {
    context: {
      scope: 'workspace',
      cwd: '/worktree',
      workspacePath: '/worktree',
      appRunId: 'run-1',
      appChatId: 'chat-1'
    },
    provider: 'codex',
    toolName: 'write_file',
    args: { path: '/worktree/file.txt', content: 'body' },
    resourcePath: '/worktree/file.txt',
    ...overrides
  }
}

function dependencies(
  overrides: Partial<WorkspaceLockMcpAdmissionCoordinatorDependencies> = {}
): WorkspaceLockMcpAdmissionCoordinatorDependencies {
  return {
    getRuntime: () => null,
    getRuntimeUnavailableReason: () => null,
    getChat: () => ({ workspacePath: '/primary', title: 'Chat title' }),
    getOpaqueOwnerId: () => 'opaque-owner-1',
    getProviderScopeAdmission: () => null,
    acquireProviderScopeSublease: async () => {
      throw new Error('No provider-scope admission was expected.')
    },
    validateLaneWriteScope: () => undefined,
    markLaneBlocked: vi.fn(),
    encode: (payload) => JSON.stringify(payload),
    providerDisplayName: (provider) => `Provider ${provider}`,
    ...overrides
  }
}

function ensembleContext() {
  return {
    scope: 'workspace' as const,
    cwd: '/worktree',
    workspacePath: '/worktree',
    appRunId: 'run-1',
    appChatId: 'chat-1',
    ensembleRun: {
      roundId: 'round-1',
      participantId: 'participant-1',
      laneId: 'lane-1',
      provider: 'codex' as const,
      role: 'Writer',
      order: 1
    }
  }
}

function successfulAcquisition(
  runtimeInput: WorkspaceLockRuntimeAcquireInput,
  claims: WorkspaceLockClaimRequest[] = [
    {
      workspacePath: '/primary',
      worktreePath: '/worktree',
      kind: 'file',
      targetPath: '/worktree/file.txt'
    }
  ],
  exactOwner?: WorkspaceLockOwner
): WorkspaceLockRuntimeAcquireResult {
  const owner: WorkspaceLockOwner =
    exactOwner ??
    ({
      ...runtimeInput.owner,
      pid: runtimeInput.owner.executionPid || 42,
      processBirthIdentity: 'birth-42'
    } satisfies WorkspaceLockOwner)
  const canonicalClaim: CanonicalWorkspaceLockClaim = {
    workspaceIdentity: 'workspace-id',
    worktreeCanonicalPath: resolve('/worktree'),
    worktreeIdentity: 'worktree-id',
    targetCanonicalPath: resolve('/worktree/file.txt'),
    comparisonTargetPath: resolve('/worktree/file.txt'),
    physicalTargetIdentity: 'physical-target',
    displayWorkspacePath: resolve('/primary'),
    displayWorktreePath: resolve('/worktree'),
    relativeTargetPath: 'file.txt',
    kind: 'file',
    mode: 'write'
  }
  const lease: WorkspaceLockLease = {
    leaseId: 'lease-1',
    acquiredTransitionId: 'transition-1',
    authorityInstanceId: 'instance-1',
    authorityGeneration: 1,
    owner,
    claim: canonicalClaim,
    acquiredAt: '2026-07-29T00:00:00.000Z',
    status: 'held',
    statusChangedAt: '2026-07-29T00:00:00.000Z'
  }
  return {
    ok: true,
    owner,
    claims,
    authority: {
      ok: true,
      transitionId: claims.length ? 'transition-1' : '',
      tokens: [],
      leases: claims.length ? [lease] : []
    }
  }
}

describe('WorkspaceLockMcpAdmissionCoordinator', () => {
  it('returns a no-lock admission without resolving runtime or owner identity', async () => {
    const getRuntime = vi.fn(() => null)
    const getOpaqueOwnerId = vi.fn(() => 'opaque-owner-1')
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({ getRuntime, getOpaqueOwnerId })
    )

    await expect(coordinator.admit(input({ toolName: 'read_file' }))).resolves.toEqual({
      ok: true,
      claims: [],
      canonicalClaims: [],
      claimsHeld: false,
      releaseAfterOperation: false
    })
    expect(getRuntime).not.toHaveBeenCalled()
    expect(getOpaqueOwnerId).not.toHaveBeenCalled()
  })

  it('fails explicitly at the strict taxonomy boundary', async () => {
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(dependencies())

    const result = await coordinator.admit(input({ toolName: 'undeclared_mutation' }))

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no declared catalog metadata')
    })
    if (result.ok) throw new Error('Expected denial.')
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      tool: 'undeclared_mutation',
      code: 'unmapped_catalog_action'
    })
  })

  it('admits global-scope mutations without claims and never reaches the runtime', async () => {
    const getRuntime = vi.fn(() => null)
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(dependencies({ getRuntime }))

    const result = await coordinator.admit(input({ context: { scope: 'global', cwd: '/host' } }))

    // A global chat is host-scoped by design and has no workspace for this
    // authority to protect, so it admits with NO claims rather than denying —
    // denying removed `run_shell_command` from global chats entirely.
    expect(result).toMatchObject({
      ok: true,
      claims: [],
      canonicalClaims: [],
      claimsHeld: false,
      releaseAfterOperation: false
    })
    expect(getRuntime).not.toHaveBeenCalled()
  })

  // The safety half of the decision above: these mutations are unlocked, so the
  // human must see every one. `forcePrompt` is the flag that suppresses
  // session-YOLO, standing grants and bossman auto-approval, and the gateway
  // passes `mcpToolAlwaysPrompts(toolName, context.scope)` into it.
  it('global scope forces an approval prompt for the mutations it now admits', () => {
    expect(mcpToolAlwaysPrompts('write_file', 'global')).toBe(true)
    expect(mcpToolAlwaysPrompts('run_shell_command', 'global')).toBe(true)
    // ...and is not blanket-true, so the assertions above mean something.
    expect(mcpToolAlwaysPrompts('read_file', 'workspace')).toBe(false)
  })

  it('uses the injected runtime-unavailable reason', async () => {
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntimeUnavailableReason: () => 'Authority startup recovery failed.'
      })
    )

    const result = await coordinator.admit(input())

    expect(result).toMatchObject({
      ok: false,
      reason: 'Authority startup recovery failed.'
    })
  })

  it('requires an exact run identity before allocating an owner', async () => {
    const getOpaqueOwnerId = vi.fn()
    const acquire = vi.fn()
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        getOpaqueOwnerId
      })
    )

    const result = await coordinator.admit(
      input({
        context: {
          scope: 'workspace',
          cwd: '/worktree',
          workspacePath: '/worktree'
        }
      })
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'Workspace mutation write_file has no exact run identity.'
    })
    expect(getOpaqueOwnerId).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })

  it('passes every exact derived resource to lane validation without poisoning the lane', async () => {
    const validateLaneWriteScope = vi.fn(() => ({
      ok: false as const,
      reason: 'Resource is outside the approved lane scope.'
    }))
    const markLaneBlocked = vi.fn()
    const acquire = vi.fn()
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        validateLaneWriteScope,
        markLaneBlocked
      })
    )
    const resourcePath = '/worktree/file.txt '

    const result = await coordinator.admit(
      input({
        context: ensembleContext(),
        args: { path: resourcePath, content: 'body' },
        resourcePath
      })
    )

    expect(validateLaneWriteScope).toHaveBeenCalledWith('run-1', {
      toolName: 'write_file',
      workspacePath: resolve('/worktree'),
      resourcePaths: [resourcePath],
      resourcePath
    })
    expect(markLaneBlocked).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      reason: 'Resource is outside the approved lane scope.'
    })
    if (result.ok) throw new Error('Expected denial.')
    expect(JSON.parse(result.text)).toMatchObject({ laneId: 'lane-1' })
    expect(acquire).not.toHaveBeenCalled()
  })

  it('validates a multi-file patch as an atomic set of exact resources', async () => {
    const validateLaneWriteScope = vi.fn(() => ({ ok: true as const }))
    const acquire = vi.fn(async (runtimeInput: WorkspaceLockRuntimeAcquireInput) =>
      successfulAcquisition(runtimeInput)
    )
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        validateLaneWriteScope
      })
    )
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-b',
      '+B',
      ''
    ].join('\n')

    await expect(
      coordinator.admit(
        input({
          context: ensembleContext(),
          toolName: 'apply_patch',
          args: { patch },
          resourcePath: undefined
        })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(validateLaneWriteScope).toHaveBeenCalledWith('run-1', {
      toolName: 'apply_patch',
      workspacePath: resolve('/worktree'),
      resourcePaths: [resolve('/worktree/a.ts'), resolve('/worktree/b.ts')],
      resourcePath: undefined
    })
  })

  it('never falls back to the run id when opaque owner allocation fails', async () => {
    const acquire = vi.fn()
    const markLaneBlocked = vi.fn()
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        getOpaqueOwnerId: () => undefined,
        markLaneBlocked
      })
    )

    const result = await coordinator.admit(input({ context: ensembleContext() }))

    expect(result).toMatchObject({
      ok: false,
      reason: 'Workspace mutation write_file has no exact opaque lock-owner identity.'
    })
    if (result.ok) throw new Error('Expected denial.')
    expect(JSON.parse(result.text)).toMatchObject({
      code: 'owner_identity_unavailable',
      laneId: 'lane-1'
    })
    expect(markLaneBlocked).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })

  it('rejects malformed opaque owner identities before runtime acquisition', async () => {
    const acquire = vi.fn()
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        getOpaqueOwnerId: () => ' run-1'
      })
    )

    const result = await coordinator.admit(input())

    expect(result).toMatchObject({
      ok: false,
      reason: 'Workspace-lock opaque owner identity is malformed.'
    })
    expect(acquire).not.toHaveBeenCalled()
  })

  it('rejects the run id when a callback tries to reuse it as owner identity', async () => {
    const acquire = vi.fn()
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        getOpaqueOwnerId: ({ runId }) => runId
      })
    )

    const result = await coordinator.admit(input())

    expect(result).toMatchObject({
      ok: false,
      reason: 'Workspace-lock opaque owner identity is malformed.'
    })
    expect(acquire).not.toHaveBeenCalled()
  })

  it('acquires with exact owner, chat, workspace and external authority inputs', async () => {
    const getOpaqueOwnerId = vi.fn(() => 'opaque-owner-9')
    const providerDisplayName = vi.fn(() => 'Codex')
    const validateLaneWriteScope = vi.fn(() => ({ ok: true as const }))
    const externalMutationAuthority = {
      kind: 'validated-external-path-grant' as const,
      provider: 'codex' as const,
      runId: 'run-1',
      targetPath: resolve('/external/file.txt'),
      operationFingerprint: 'fingerprint',
      grantId: 'grant-1',
      grantSignature: 'a'.repeat(64)
    }
    const acquire = vi.fn(async (runtimeInput: WorkspaceLockRuntimeAcquireInput) =>
      successfulAcquisition(runtimeInput)
    )
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        getOpaqueOwnerId,
        providerDisplayName,
        validateLaneWriteScope
      })
    )

    const result = await coordinator.admit(
      input({
        externalMutationAuthority,
        executionPid: 91
      })
    )

    expect(getOpaqueOwnerId).toHaveBeenCalledWith({
      runId: 'run-1',
      provider: 'codex',
      chatId: 'chat-1'
    })
    expect(validateLaneWriteScope).toHaveBeenCalledWith('run-1', {
      toolName: 'write_file',
      workspacePath: resolve('/worktree'),
      resourcePaths: ['/worktree/file.txt'],
      resourcePath: '/worktree/file.txt'
    })
    expect(acquire).toHaveBeenCalledWith({
      owner: {
        lockOwnerId: 'opaque-owner-9',
        runId: 'run-1',
        chatId: 'chat-1',
        provider: 'codex',
        displayName: 'Codex',
        chatTitle: 'Chat title',
        executionPid: 91
      },
      mutation: {
        source: 'taskwraith-catalog',
        provider: 'codex',
        workspacePath: resolve('/primary'),
        worktreePath: resolve('/worktree'),
        action: 'write_file',
        args: { path: '/worktree/file.txt', content: 'body' }
      },
      externalMutationAuthority
    })
    expect(result).toMatchObject({
      ok: true,
      claimsHeld: true,
      acquiredTransitionId: 'transition-1',
      releaseAfterOperation: true,
      owner: {
        lockOwnerId: 'opaque-owner-9',
        pid: 91,
        processBirthIdentity: 'birth-42'
      }
    })
    if (!result.ok) throw new Error('Expected admission.')
    expect(result.claims).toHaveLength(1)
    expect(result.canonicalClaims).toHaveLength(1)
    expect(result.runtimeInput?.externalMutationAuthority).toBe(externalMutationAuthority)
  })

  it('persists a launching-child owner before a subprocess-capable raw spawn', async () => {
    const acquire = vi.fn(async (runtimeInput: WorkspaceLockRuntimeAcquireInput) =>
      successfulAcquisition(runtimeInput)
    )
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire })
      })
    )

    const result = await coordinator.admit(
      input({
        toolName: 'run_shell_command',
        args: { command: 'touch generated.txt' },
        resourcePath: undefined,
        ownerLifecycle: 'launching-child'
      })
    )

    expect(result.ok).toBe(true)
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: expect.objectContaining({
          lockOwnerId: 'opaque-owner-1',
          runId: 'run-1',
          lifecycle: 'launching-child'
        })
      })
    )
  })

  it('uses ensemble role and exact lane coordinates in the owner', async () => {
    const acquire = vi.fn(async (runtimeInput: WorkspaceLockRuntimeAcquireInput) =>
      successfulAcquisition(runtimeInput)
    )
    const providerDisplayName = vi.fn(() => 'Codex')
    const getOpaqueOwnerId = vi.fn(() => 'opaque-lane-owner')
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        providerDisplayName,
        getOpaqueOwnerId
      })
    )

    await coordinator.admit(input({ context: ensembleContext() }))

    expect(getOpaqueOwnerId).toHaveBeenCalledWith({
      runId: 'run-1',
      provider: 'codex',
      chatId: 'chat-1',
      laneId: 'lane-1',
      participantId: 'participant-1'
    })
    expect(acquire.mock.calls[0]?.[0].owner).toMatchObject({
      lockOwnerId: 'opaque-lane-owner',
      laneId: 'lane-1',
      participantId: 'participant-1',
      displayName: 'Writer'
    })
    expect(providerDisplayName).not.toHaveBeenCalled()
  })

  it('acquires a nested operation sublease from an exact coarse provider owner', async () => {
    const coarseOwner: WorkspaceLockOwner = {
      lockOwnerId: 'opaque-provider-owner',
      runId: 'run-1',
      lifecycle: 'child',
      chatId: 'chat-1',
      provider: 'codex',
      displayName: 'Codex',
      chatTitle: 'Chat title',
      pid: 777,
      processBirthIdentity: 'birth-777'
    }
    const coarseAdmission = {
      runId: 'run-1',
      owner: coarseOwner,
      transitionId: 'coarse-transition',
      workspacePath: resolve('/primary'),
      worktreePath: resolve('/worktree')
    }
    const runtimeAcquire = vi.fn(
      async (): Promise<WorkspaceLockRuntimeAcquireResult> => ({
        ok: false,
        code: 'conflict',
        message: 'The coarse child owner would conflict with a main-process owner.'
      })
    )
    const acquireProviderScopeSublease = vi.fn(
      async ({
        admission,
        runtimeInput
      }: {
        admission: typeof coarseAdmission
        runtimeInput: WorkspaceLockRuntimeAcquireInput
      }) => {
        expect(admission).toBe(coarseAdmission)
        return successfulAcquisition(runtimeInput, undefined, coarseOwner)
      }
    )
    const getOpaqueOwnerId = vi.fn(() => 'unrelated-main-owner')
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire: runtimeAcquire }),
        getOpaqueOwnerId,
        getProviderScopeAdmission: () => coarseAdmission,
        acquireProviderScopeSublease
      })
    )

    const result = await coordinator.admit(input())

    expect(runtimeAcquire).not.toHaveBeenCalled()
    expect(getOpaqueOwnerId).not.toHaveBeenCalled()
    expect(acquireProviderScopeSublease).toHaveBeenCalledWith({
      admission: coarseAdmission,
      runtimeInput: {
        owner: {
          lockOwnerId: 'opaque-provider-owner',
          runId: 'run-1',
          chatId: 'chat-1',
          provider: 'codex',
          displayName: 'Codex',
          chatTitle: 'Chat title',
          executionPid: 777
        },
        mutation: {
          source: 'taskwraith-catalog',
          provider: 'codex',
          workspacePath: resolve('/primary'),
          worktreePath: resolve('/worktree'),
          action: 'write_file',
          args: { path: '/worktree/file.txt', content: 'body' }
        },
        externalMutationAuthority: undefined
      }
    })
    expect(result).toMatchObject({
      ok: true,
      claimsHeld: true,
      acquiredTransitionId: 'transition-1',
      releaseAfterOperation: true,
      owner: {
        lifecycle: 'child',
        lockOwnerId: 'opaque-provider-owner',
        pid: 777,
        processBirthIdentity: 'birth-777'
      }
    })
  })

  it('fails closed instead of using a mismatched provider-scope admission', async () => {
    const acquire = vi.fn()
    const acquireProviderScopeSublease = vi.fn()
    const getOpaqueOwnerId = vi.fn(() => 'main-owner')
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire }),
        getOpaqueOwnerId,
        getProviderScopeAdmission: () => ({
          runId: 'run-1',
          owner: {
            lockOwnerId: 'provider-owner',
            runId: 'run-1',
            lifecycle: 'child',
            chatId: 'chat-1',
            provider: 'codex',
            pid: 777,
            processBirthIdentity: 'birth-777'
          },
          transitionId: 'coarse-transition',
          workspacePath: '/primary',
          worktreePath: '/different-worktree'
        }),
        acquireProviderScopeSublease
      })
    )

    const result = await coordinator.admit(input())

    expect(result).toMatchObject({
      ok: false,
      reason:
        'Workspace mutation write_file does not match its exact provider-scope lock admission.'
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(acquireProviderScopeSublease).not.toHaveBeenCalled()
    expect(getOpaqueOwnerId).not.toHaveBeenCalled()
  })

  it('waits through transient contention without poisoning the participant lane', async () => {
    const markLaneBlocked = vi.fn()
    const acquire = vi
      .fn<
        (
          runtimeInput: WorkspaceLockRuntimeAcquireInput
        ) => Promise<WorkspaceLockRuntimeAcquireResult>
      >()
      .mockResolvedValueOnce({
        ok: false,
        code: 'conflict',
        message: 'Another run holds this file.'
      })
      .mockImplementationOnce(async (runtimeInput) => successfulAcquisition(runtimeInput))
    const subscribe = vi.fn((_query, onChange: () => void) => {
      queueMicrotask(onChange)
      return { unsubscribe: vi.fn() }
    })
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({
        getRuntime: () => ({ acquire, subscribe: subscribe as never }),
        markLaneBlocked
      })
    )

    const result = await coordinator.admit(input({ context: ensembleContext() }))

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(subscribe).toHaveBeenCalledOnce()
    expect(markLaneBlocked).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      claimsHeld: true,
      acquiredTransitionId: 'transition-1'
    })
  })

  it('retains the runtime input but omits owner and transition for empty claims', async () => {
    const acquire = vi.fn(async (runtimeInput: WorkspaceLockRuntimeAcquireInput) =>
      successfulAcquisition(runtimeInput, [])
    )
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      dependencies({ getRuntime: () => ({ acquire }) })
    )

    const result = await coordinator.admit(input())

    expect(result).toMatchObject({
      ok: true,
      claims: [],
      canonicalClaims: [],
      claimsHeld: false,
      releaseAfterOperation: true
    })
    if (!result.ok) throw new Error('Expected admission.')
    expect(result.owner).toBeUndefined()
    expect(result.acquiredTransitionId).toBeUndefined()
    expect(result.runtimeInput).toBe(acquire.mock.calls[0]?.[0])
  })
})

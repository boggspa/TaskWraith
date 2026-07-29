import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  WorkspaceLockMcpExecutionCoordinator,
  type WorkspaceLockMcpExecutionContext,
  type WorkspaceLockMcpExecutionCoordinatorDependencies,
  type WorkspaceLockMcpExecutionRuntime
} from './WorkspaceLockMcpExecutionCoordinator'
import type { WorkspaceLockMcpAdmission } from './WorkspaceLockMcpAdmissionCoordinator'
import {
  createWorkspaceExternalMutationAuthorityReceipt,
  type WorkspaceLockRuntimeAcquireInput
} from './WorkspaceLockRuntime'
import { resolveCanonicalWorkspaceLockPath } from './workLocks/CanonicalWorkspaceLockPath'
import type {
  CanonicalWorkspaceLockClaim,
  WorkspaceLockMutationCapability,
  WorkspaceLockOwner
} from './workLocks/WorkspaceLockTypes'

interface TestContext extends WorkspaceLockMcpExecutionContext {
  marker: string
}

const owner: WorkspaceLockOwner = {
  lockOwnerId: 'opaque-owner-1',
  runId: 'run-1',
  chatId: 'chat-1',
  provider: 'codex',
  pid: 42,
  processBirthIdentity: 'birth-42'
}

const fence = {
  lockOwnerId: owner.lockOwnerId,
  runId: owner.runId,
  pid: owner.pid,
  processBirthIdentity: owner.processBirthIdentity,
  fenceId: 'fence-1',
  acquiredAt: '2026-07-29T00:00:00.000Z'
}

function context(overrides: Partial<TestContext> = {}): TestContext {
  return {
    scope: 'workspace',
    cwd: '/repo',
    workspacePath: '/repo',
    appRunId: 'run-1',
    appChatId: 'chat-1',
    marker: 'preserved',
    ...overrides
  }
}

function runtimeInput(
  toolName = 'write_file',
  args: Record<string, unknown> = { path: 'src/file.txt', content: 'body' }
): WorkspaceLockRuntimeAcquireInput {
  return {
    owner: {
      lockOwnerId: owner.lockOwnerId,
      runId: owner.runId,
      chatId: owner.chatId,
      provider: owner.provider
    },
    mutation: {
      source: 'taskwraith-catalog',
      provider: 'codex',
      workspacePath: '/repo',
      worktreePath: '/repo',
      action: toolName,
      args
    }
  }
}

function admission(
  overrides: Partial<Extract<WorkspaceLockMcpAdmission, { ok: true }>> = {}
): Extract<WorkspaceLockMcpAdmission, { ok: true }> {
  return {
    ok: true,
    owner,
    claims: [
      {
        workspacePath: '/repo',
        worktreePath: '/repo',
        kind: 'file',
        targetPath: '/repo/src/file.txt'
      }
    ],
    canonicalClaims: [],
    claimsHeld: true,
    acquiredTransitionId: 'transition-1',
    releaseAfterOperation: true,
    runtimeInput: runtimeInput(),
    ...overrides
  }
}

function capability(
  input: {
    root?: string
    target?: string
    kind?: WorkspaceLockMutationCapability['kind']
  } = {}
): WorkspaceLockMutationCapability {
  const root = resolve(input.root || '/repo')
  const target = resolve(input.target || join(root, 'src/file.txt'))
  const kind = input.kind || 'file'
  const relativeTargetPath = target === root ? '' : target.slice(root.length + 1)
  const identity = `planned:${relativeTargetPath || '.'}`
  const targetExists = kind === 'workspace'
  const existingIdentity = {
    device: '1',
    inode: '10',
    key: '1:10'
  }
  return {
    token: {
      leaseId: 'lease-1',
      acquiredTransitionId: 'transition-2',
      authorityInstanceId: 'authority-1',
      authorityGeneration: 1,
      ownerRunId: owner.runId
    },
    leaseId: 'lease-1',
    kind,
    executableTargetPath: target,
    verifiedPathEvidence: {
      requestedRootPath: root,
      requestedTargetPath: target,
      lexicalRootPath: root,
      lexicalTargetPath: target,
      pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
      caseSensitive: process.platform !== 'win32',
      targetExists,
      canonicalPath: target,
      comparisonPath: process.platform === 'win32' ? target.toLowerCase() : target,
      physicalIdentity: targetExists ? existingIdentity.key : identity,
      targetIdentity: targetExists
        ? {
            kind: 'existing',
            file: existingIdentity,
            key: existingIdentity.key
          }
        : {
            kind: 'planned',
            existingAncestor: existingIdentity,
            normalizedSuffix: relativeTargetPath,
            key: identity
          },
      containment: {
        canonicalRootPath: root,
        canonicalTargetPath: target,
        comparisonRootPath: process.platform === 'win32' ? root.toLowerCase() : root,
        comparisonTargetPath: process.platform === 'win32' ? target.toLowerCase() : target,
        relativeTargetPath,
        rootIdentity: existingIdentity,
        existingAncestorCanonicalPath: targetExists ? target : root,
        existingAncestorIdentity: existingIdentity
      }
    }
  }
}

function successfulRefresh() {
  return {
    ok: true as const,
    owner,
    claims: [],
    authority: {
      ok: true as const,
      transitionId: 'transition-2',
      tokens: [],
      leases: []
    }
  }
}

function successfulRelease() {
  return {
    ok: true as const,
    transitionId: 'release-1',
    released: []
  }
}

function harness(
  overrides: {
    admitted?: WorkspaceLockMcpAdmission
    capabilities?: WorkspaceLockMutationCapability[]
    runtime?: Partial<WorkspaceLockMcpExecutionRuntime>
    confirmChildMutationTreeStopped?: (input: {
      pid: number
      workspaceLockOwnerId: string
    }) => boolean | Promise<boolean>
    issueExternalAuthority?: WorkspaceLockMcpExecutionCoordinatorDependencies<TestContext>['externalMutationAuthority']['issue']
  } = {}
) {
  const lifecycleFinish = vi.fn()
  const lifecycleBegin = vi.fn(() => ({
    operationId: 'run-1:1',
    finish: lifecycleFinish
  }))
  const admitted = overrides.admitted || admission()
  const admissionCall = vi.fn(async () => admitted)
  const verify = vi.fn(async () => ({
    ok: true as const,
    acquiredTransitionId: 'transition-2',
    capabilities: overrides.capabilities || [capability()]
  }))
  const runtime: WorkspaceLockMcpExecutionRuntime = {
    acquireMutationFence: vi.fn(async () => fence),
    getUnhealthyReason: vi.fn(() => null),
    releaseAcquisition: vi.fn(async () => successfulRelease()),
    releaseMutationFence: vi.fn(),
    replaceAcquisitionForMutation: vi.fn(async () => successfulRefresh()),
    revalidateExternalMutationTarget: vi.fn(async () => '/outside/exact.txt'),
    transferAcquisition: vi.fn(async (_previousOwner, _transitionId, nextOwner) => ({
      ...successfulRefresh(),
      owner: {
        ...owner,
        lifecycle: nextOwner.lifecycle,
        pid: nextOwner.executionPid || owner.pid,
        processBirthIdentity: `birth-${nextOwner.executionPid || owner.pid}`
      }
    })),
    verifyAcquisitionForMutation: verify,
    ...overrides.runtime
  }
  const poison = vi.fn()
  const issue = vi.fn(overrides.issueExternalAuthority || (() => undefined))
  const coordinator = new WorkspaceLockMcpExecutionCoordinator<TestContext>({
    admission: { admit: admissionCall },
    externalMutationAuthority: { issue },
    lifecycle: { begin: lifecycleBegin },
    getRuntime: () => runtime,
    confirmChildMutationTreeStopped: overrides.confirmChildMutationTreeStopped,
    poison,
    encode: (payload) => JSON.stringify(payload)
  })
  return {
    admissionCall,
    coordinator,
    issue,
    lifecycleBegin,
    lifecycleFinish,
    poison,
    runtime,
    verify
  }
}

function prepareInput(
  overrides: Partial<
    Parameters<WorkspaceLockMcpExecutionCoordinator<TestContext>['prepare']>[0]
  > = {}
) {
  return {
    context: context(),
    provider: 'codex' as const,
    toolName: 'write_file',
    args: {
      path: 'src/file.txt',
      file_path: 'raw-alias.txt',
      content: 'body'
    },
    cwd: '/repo',
    executionAuthorityStillLive: () => true,
    historyClearAdmissionBlocked: () => false,
    ...overrides
  }
}

describe('WorkspaceLockMcpExecutionCoordinator', () => {
  it('hands only canonical capability paths to the executor and releases in order', async () => {
    const events: string[] = []
    const target = resolve('/repo/src/file.txt')
    const h = harness({
      capabilities: [capability({ target })],
      runtime: {
        releaseMutationFence: vi.fn(() => {
          events.push('fence')
        }),
        releaseAcquisition: vi.fn(async () => {
          events.push('acquisition')
          return successfulRelease()
        })
      }
    })

    const prepared = await h.coordinator.prepare(prepareInput())

    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.args).toMatchObject({ content: 'body' })
    expect(prepared.args).not.toHaveProperty('file_path')
    expect(prepared.context).toMatchObject({
      cwd: resolve('/repo'),
      workspacePath: resolve('/repo'),
      marker: 'preserved'
    })
    expect(prepared.directMutationAuthority).toEqual({
      rootPath: resolve('/repo'),
      targetPath: target
    })
    expect(prepared.context.assertMutationAuthorized).toEqual(expect.any(Function))

    expect(await prepared.finish()).toEqual({ resolved: true })
    expect(events).toEqual(['fence', 'acquisition'])
    expect(h.lifecycleFinish).toHaveBeenCalledOnce()
    expect(await prepared.finish()).toEqual({ resolved: true })
    expect(events).toEqual(['fence', 'acquisition'])
  })

  it('rejects post-approval cancellation at the final executor boundary', async () => {
    let live = true
    const h = harness()
    const prepared = await h.coordinator.prepare(
      prepareInput({ executionAuthorityStillLive: () => live })
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(h.verify).toHaveBeenCalledOnce()

    live = false
    await expect(prepared.context.assertMutationAuthorized?.()).rejects.toThrow(/authority expired/)
    expect(h.verify).toHaveBeenCalledOnce()
    await prepared.finish()
  })

  it('rechecks history-clear revocation after the final durable verification', async () => {
    let blocked = false
    const h = harness()
    const prepared = await h.coordinator.prepare(
      prepareInput({ historyClearAdmissionBlocked: () => blocked })
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    blocked = true
    await expect(prepared.context.assertMutationAuthorized?.()).rejects.toThrow(
      /concurrent history clear/
    )
    await prepared.finish()
  })

  it('releases an admitted operation that becomes stale before fence entry', async () => {
    const h = harness()

    const prepared = await h.coordinator.prepare(
      prepareInput({ executionAuthorityStillLive: () => false })
    )

    expect(prepared).toMatchObject({ ok: false, kind: 'stale-authority' })
    expect(h.runtime.acquireMutationFence).not.toHaveBeenCalled()
    expect(h.runtime.releaseAcquisition).toHaveBeenCalledWith('run-1', 'transition-1')
    expect(h.lifecycleFinish).toHaveBeenCalledOnce()
  })

  it('cleans up the fence and refreshed acquisition after preparation fails', async () => {
    const h = harness({
      runtime: {
        verifyAcquisitionForMutation: vi.fn(async () => ({
          ok: false as const,
          reason: 'stale_acquisition' as const,
          message: 'stale'
        }))
      }
    })

    const prepared = await h.coordinator.prepare(prepareInput())

    expect(prepared).toMatchObject({
      ok: false,
      kind: 'execution-preparation',
      reason: expect.stringContaining('stale')
    })
    expect(h.runtime.releaseMutationFence).toHaveBeenCalledOnce()
    expect(h.runtime.releaseAcquisition).toHaveBeenCalledWith('run-1', 'transition-2')
    expect(h.lifecycleFinish).toHaveBeenCalledOnce()
  })

  it('retains the acquisition and lifecycle when fence release is unresolved', async () => {
    const h = harness({
      runtime: {
        releaseMutationFence: vi.fn(() => {
          throw new Error('fence ownership unknown')
        })
      }
    })
    const prepared = await h.coordinator.prepare(prepareInput())
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    expect(await prepared.finish()).toEqual({
      resolved: false,
      reason: 'fence ownership unknown'
    })
    expect(h.poison).toHaveBeenCalledWith('fence ownership unknown')
    expect(h.runtime.releaseAcquisition).not.toHaveBeenCalled()
    expect(h.lifecycleFinish).not.toHaveBeenCalled()
  })

  it('retains the lifecycle after an unresolved exact-acquisition release', async () => {
    const h = harness({
      runtime: {
        releaseAcquisition: vi.fn(async () => ({
          ok: false as const,
          reason: 'authority_busy' as const,
          message: 'authority busy'
        }))
      }
    })
    const prepared = await h.coordinator.prepare(prepareInput())
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    expect(await prepared.finish()).toEqual({
      resolved: false,
      reason: 'authority busy'
    })
    expect(h.runtime.releaseMutationFence).toHaveBeenCalledOnce()
    expect(h.poison).toHaveBeenCalledWith('authority busy')
    expect(h.lifecycleFinish).not.toHaveBeenCalled()
  })

  it('rewrites an external mutation to the freshly revalidated exact target', async () => {
    const args = {
      path: '/outside/original.txt',
      file_path: '/outside/ignored.txt',
      content: 'body'
    }
    const input = runtimeInput('write_file', args)
    const receipt = createWorkspaceExternalMutationAuthorityReceipt({
      mutation: input.mutation,
      provider: 'codex',
      runId: 'run-1',
      targetPath: '/outside/exact name .txt',
      grantId: 'grant-1',
      grantSignature: 'a'.repeat(64)
    })
    input.externalMutationAuthority = receipt
    const h = harness({
      admitted: admission({ runtimeInput: input }),
      capabilities: [capability({ kind: 'workspace', target: '/repo' })],
      issueExternalAuthority: () => receipt,
      runtime: {
        revalidateExternalMutationTarget: vi.fn(async () => '/outside/exact name .txt')
      }
    })

    const prepared = await h.coordinator.prepare(prepareInput({ args, cwd: '/repo' }))

    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.args).toEqual({
      path: '/outside/exact name .txt',
      content: 'body'
    })
    expect(prepared.directMutationAuthority).toEqual({
      rootPath: '/outside',
      targetPath: '/outside/exact name .txt'
    })
    await prepared.finish()
  })

  it('persists launching-child admission, transfers exact PID, and releases the fence before child execution', async () => {
    const launchingOwner: WorkspaceLockOwner = {
      ...owner,
      lifecycle: 'launching-child'
    }
    const shellArgs = { command: 'touch generated.txt' }
    const h = harness({
      admitted: admission({
        owner: launchingOwner,
        runtimeInput: {
          ...runtimeInput('run_shell_command', shellArgs),
          owner: {
            ...runtimeInput('run_shell_command', shellArgs).owner,
            lifecycle: 'launching-child'
          }
        }
      }),
      capabilities: [capability({ kind: 'workspace', target: '/repo' })],
      confirmChildMutationTreeStopped: () => true
    })

    const prepared = await h.coordinator.prepare(
      prepareInput({
        toolName: 'run_shell_command',
        args: shellArgs
      })
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(h.admissionCall.mock.calls[0]?.[0]).toMatchObject({
      ownerLifecycle: 'launching-child'
    })
    expect(prepared.context.workspaceLockOwnerId).toBe(owner.lockOwnerId)

    const child = {
      pid: 99,
      workspaceLockOwnerId: owner.lockOwnerId
    }
    await prepared.context.workspaceLockLifecycle?.bind(child)
    expect(h.runtime.transferAcquisition).toHaveBeenCalledWith(
      launchingOwner,
      'transition-2',
      expect.objectContaining({
        lockOwnerId: owner.lockOwnerId,
        lifecycle: 'child',
        executionPid: 99
      })
    )
    // The child now holds the durable path lease; the global commit fence must
    // not serialize its full command lifetime.
    expect(h.runtime.releaseMutationFence).toHaveBeenCalledOnce()

    expect(await prepared.finish()).toEqual({ resolved: true })
    expect(h.runtime.releaseAcquisition).not.toHaveBeenCalled()
    expect(h.lifecycleFinish).not.toHaveBeenCalled()

    await prepared.context.workspaceLockLifecycle?.release(child)
    expect(h.runtime.releaseAcquisition).toHaveBeenCalledWith('run-1', 'transition-2')
    expect(h.lifecycleFinish).toHaveBeenCalledOnce()
  })

  it('retains a child lease without poisoning unrelated authority when whole-tree death is unproven', async () => {
    const launchingOwner: WorkspaceLockOwner = {
      ...owner,
      lifecycle: 'launching-child'
    }
    const shellArgs = { command: 'touch generated.txt' }
    const h = harness({
      admitted: admission({
        owner: launchingOwner,
        runtimeInput: runtimeInput('run_shell_command', shellArgs)
      }),
      capabilities: [capability({ kind: 'workspace', target: '/repo' })]
    })
    const prepared = await h.coordinator.prepare(
      prepareInput({
        toolName: 'run_shell_command',
        args: shellArgs
      })
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const child = {
      pid: 99,
      workspaceLockOwnerId: owner.lockOwnerId
    }
    await prepared.context.workspaceLockLifecycle?.bind(child)
    expect(await prepared.finish()).toEqual({ resolved: true })

    await expect(prepared.context.workspaceLockLifecycle?.release(child)).rejects.toThrow(
      /retained for quarantine/
    )
    expect(h.runtime.releaseAcquisition).not.toHaveBeenCalled()
    expect(h.lifecycleFinish).not.toHaveBeenCalled()
    expect(h.poison).not.toHaveBeenCalled()
  })

  it('refuses a verified workspace capability after its root object is replaced', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'taskwraith-lock-coordinator-swap-'))
    try {
      const physicalRoot = join(tempRoot, 'physical-workspace')
      const displacedRoot = join(tempRoot, 'displaced-workspace')
      const rootAlias = join(tempRoot, 'workspace-alias')
      mkdirSync(join(physicalRoot, 'packages'), { recursive: true })
      symlinkSync(physicalRoot, rootAlias, process.platform === 'win32' ? 'junction' : 'dir')
      const evidence = resolveCanonicalWorkspaceLockPath({
        rootPath: rootAlias,
        targetPath: rootAlias
      })
      const staleCapability: WorkspaceLockMutationCapability = {
        token: {
          leaseId: 'lease-stale',
          acquiredTransitionId: 'transition-2',
          authorityInstanceId: 'authority-1',
          authorityGeneration: 1,
          ownerRunId: owner.runId
        },
        leaseId: 'lease-stale',
        kind: 'workspace',
        executableTargetPath: evidence.canonicalPath,
        verifiedPathEvidence: evidence
      }
      renameSync(physicalRoot, displacedRoot)
      mkdirSync(join(physicalRoot, 'packages'), { recursive: true })
      const runTaskArgs = { task: 'test', cwd: 'packages' }
      const h = harness({
        admitted: admission({
          runtimeInput: runtimeInput('run_task', runTaskArgs)
        }),
        capabilities: [staleCapability]
      })

      const prepared = await h.coordinator.prepare(
        prepareInput({
          context: context({ cwd: rootAlias, workspacePath: rootAlias }),
          toolName: 'run_task',
          args: runTaskArgs,
          cwd: join(rootAlias, 'packages')
        })
      )

      expect(prepared).toMatchObject({
        ok: false,
        kind: 'execution-preparation',
        reason: expect.stringMatching(/handoff failed|cwd/)
      })
      expect(h.runtime.releaseMutationFence).toHaveBeenCalledOnce()
      expect(h.runtime.releaseAcquisition).toHaveBeenCalledOnce()
      expect(h.lifecycleFinish).toHaveBeenCalledOnce()
    } finally {
      rmSync(tempRoot, { force: true, recursive: true })
    }
  })

  it('finishes lifecycle immediately when admission is denied', async () => {
    const h = harness({
      admitted: {
        ok: false,
        text: '{"ok":false}',
        reason: 'blocked'
      }
    })

    expect(await h.coordinator.prepare(prepareInput())).toEqual({
      ok: false,
      kind: 'admission',
      text: '{"ok":false}',
      reason: 'blocked'
    })
    expect(h.lifecycleFinish).toHaveBeenCalledOnce()
  })

  it('does not create a workspace lifecycle for a read-only tool', async () => {
    const h = harness({
      admitted: admission({
        owner: undefined,
        claims: [],
        canonicalClaims: [] as CanonicalWorkspaceLockClaim[],
        claimsHeld: false,
        acquiredTransitionId: undefined,
        releaseAfterOperation: false,
        runtimeInput: undefined
      })
    })

    const prepared = await h.coordinator.prepare(
      prepareInput({
        toolName: 'read_file',
        args: { path: 'README.md' }
      })
    )

    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(h.lifecycleBegin).not.toHaveBeenCalled()
    expect(h.runtime.acquireMutationFence).not.toHaveBeenCalled()
    expect(await prepared.finish()).toEqual({ resolved: true })
  })
})

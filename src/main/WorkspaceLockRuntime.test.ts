import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  WorkspaceLockRuntime,
  createWorkspaceExternalMutationAuthorityReceipt,
  workspaceLockAuthorityRootForHome
} from './WorkspaceLockRuntime'
import type { WorkspaceLockLease, WorkspaceLockSnapshot } from './workLocks/WorkspaceLockTypes'

function emptySnapshot(): WorkspaceLockSnapshot {
  return {
    authority: {
      instanceId: 'instance',
      generation: 1,
      pid: 10,
      processBirthIdentity: 'main-birth',
      fenceId: 'fence',
      acquiredAt: '2026-07-29T00:00:00.000Z'
    },
    sequence: 1,
    lastTransitionId: 'boot',
    leases: [],
    projectionErrors: []
  }
}

function projectedLease(
  leaseId: string,
  status: WorkspaceLockLease['status'],
  statusChangedAt: string
): WorkspaceLockLease {
  return {
    leaseId,
    acquiredTransitionId: `transition-${leaseId}`,
    authorityInstanceId: 'instance',
    authorityGeneration: 1,
    owner: {
      lockOwnerId: `owner-${leaseId}`,
      runId: `run-${leaseId}`,
      pid: 10,
      processBirthIdentity: 'main-birth'
    },
    claim: {
      workspaceIdentity: '/workspace',
      worktreeCanonicalPath: '/workspace',
      worktreeIdentity: '/workspace',
      targetCanonicalPath: '/workspace',
      comparisonTargetPath: '/workspace',
      physicalTargetIdentity: '/workspace',
      displayWorkspacePath: '/workspace',
      displayWorktreePath: '/workspace',
      kind: 'workspace',
      mode: 'write'
    },
    acquiredAt: statusChangedAt,
    status,
    statusChangedAt,
    ...(status === 'recovered' ? { recoveryReason: 'owner_dead' as const } : {})
  }
}

function harness() {
  let listener: ((snapshot: WorkspaceLockSnapshot) => void) | undefined
  const authority = {
    acquireMany: vi.fn(async (_owner, claims, _options?: { transitionId?: string }) => ({
      ok: true as const,
      transitionId: 'acquire',
      tokens: [],
      leases: [],
      claims
    })),
    replaceAcquisition: vi.fn(
      async (_owner, _previous, claims, _options?: { transitionId?: string }) => ({
        ok: true as const,
        transitionId: 'replace',
        tokens: [],
        leases: [],
        claims
      })
    ),
    verifyAcquisitionForMutation: vi.fn(async (_owner, acquiredTransitionId) => ({
      ok: true as const,
      acquiredTransitionId,
      capabilities: []
    })),
    transferAcquisition: vi.fn(
      async (_previousOwner, _transitionId, nextOwner, _options?: { transitionId?: string }) => ({
        ok: true as const,
        transitionId: 'transfer',
        tokens: [],
        leases: [
          {
            leaseId: 'lease-transferred',
            acquiredTransitionId: 'transfer',
            authorityInstanceId: 'instance',
            authorityGeneration: 1,
            owner: { ...nextOwner, lifecycle: 'child' as const },
            claim: {
              workspaceIdentity: '/workspace',
              worktreeCanonicalPath: '/workspace',
              worktreeIdentity: '/workspace',
              targetCanonicalPath: '/workspace',
              comparisonTargetPath: '/workspace',
              physicalTargetIdentity: '/workspace',
              displayWorkspacePath: '/workspace',
              displayWorktreePath: '/workspace',
              kind: 'workspace' as const,
              mode: 'write' as const
            },
            acquiredAt: '2026-07-29T00:00:00.000Z',
            status: 'held' as const,
            statusChangedAt: '2026-07-29T00:00:00.000Z'
          }
        ]
      })
    ),
    releaseAllForRun: vi.fn(async (_runId?: string, _options?: { transitionId?: string }) => ({
      ok: true as const,
      transitionId: 'release',
      released: []
    })),
    releaseAcquisition: vi.fn(
      async (
        _runId?: string,
        _acquiredTransitionId?: string,
        _options?: { transitionId?: string }
      ) => ({
        ok: true as const,
        transitionId: 'release-acquisition',
        released: []
      })
    ),
    forceReleaseRecoveryBlockedAcquisition: vi.fn(
      async (
        _ownerRunId: string,
        _acquiredTransitionId: string,
        _leaseIds: readonly string[],
        _approvalReceiptId: string,
        _options?: { transitionId?: string }
      ) => ({
        ok: true as const,
        transitionId: 'force-release-recovery',
        released: []
      })
    ),
    quarantineChildOwnerAcquisitions: vi.fn(async () => ({
      transitionId: 'quarantine-child',
      decisions: []
    })),
    snapshot: vi.fn(() => emptySnapshot()),
    onChange: vi.fn((next) => {
      listener = next
      return vi.fn()
    }),
    dispose: vi.fn()
  }
  const mutationFence = {
    acquire: vi.fn(),
    release: vi.fn(() => true)
  }
  const processIdentity = {
    currentProcessIdentity: vi.fn(() => 'main-birth'),
    observe: vi.fn(async () => ({
      state: 'live' as const,
      processBirthIdentity: 'main-birth'
    })),
    dispose: vi.fn()
  }
  return {
    runtime: new WorkspaceLockRuntime(authority, mutationFence, processIdentity, 10),
    authority,
    mutationFence,
    processIdentity,
    emitAuthoritySnapshot: (snapshot: WorkspaceLockSnapshot) => listener?.(snapshot)
  }
}

describe('WorkspaceLockRuntime', () => {
  it('uses one profile-independent authority root for a local OS user', () => {
    const homePath = '/Users/example'
    const releaseUserData = '/Users/example/Library/Application Support/TaskWraith'
    const devUserData = '/Users/example/Library/Application Support/TaskWraith Dev'

    const root = workspaceLockAuthorityRootForHome(homePath)
    expect(root).toBe(join(resolve(homePath), '.taskwraith', 'workspace-lock-authority-v1'))
    expect(root).not.toBe(releaseUserData)
    expect(root).not.toBe(devUserData)
  })

  it('shares one durable projection poll across every renderer subscriber', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const firstUpdate = vi.fn()
      const secondUpdate = vi.fn()
      const first = h.runtime.subscribe({}, firstUpdate)
      const second = h.runtime.subscribe({}, secondUpdate)
      const callsAfterSubscribe = h.authority.snapshot.mock.calls.length

      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.authority.snapshot).toHaveBeenCalledTimes(callsAfterSubscribe + 1)
      expect(firstUpdate).not.toHaveBeenCalled()
      expect(secondUpdate).not.toHaveBeenCalled()

      h.authority.snapshot.mockReturnValue({
        ...emptySnapshot(),
        sequence: 2,
        leases: [projectedLease('new-lock', 'held', '2026-07-29T00:00:00.000Z')]
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(firstUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'acquired' })
      )
      expect(secondUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'acquired' })
      )

      first.unsubscribe()
      const callsWithOneSubscriber = h.authority.snapshot.mock.calls.length
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.authority.snapshot).toHaveBeenCalledTimes(callsWithOneSubscriber + 1)

      second.unsubscribe()
      const callsAfterUnsubscribe = h.authority.snapshot.mock.calls.length
      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.authority.snapshot).toHaveBeenCalledTimes(callsAfterUnsubscribe)
      h.runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('derives and atomically acquires catalog workspace claims for every run', async () => {
    const { runtime, authority } = harness()

    const result = await runtime.acquire({
      owner: {
        lockOwnerId: 'run-1',
        runId: 'run-1',
        provider: 'codex'
      },
      mutation: {
        workspacePath: '/workspace',
        action: 'write_file',
        args: { path: 'src/new.ts', content: 'x' }
      }
    })

    expect(result.ok).toBe(true)
    expect(authority.acquireMany).toHaveBeenCalledTimes(1)
    const [ownerArg, claimsArg, optionsArg] = authority.acquireMany.mock.calls[0]!
    expect(ownerArg).toMatchObject({
      lockOwnerId: 'run-1',
      runId: 'run-1',
      pid: 10,
      processBirthIdentity: 'main-birth'
    })
    expect(claimsArg).toEqual([
      expect.objectContaining({ kind: 'file', targetPath: resolve('/workspace', 'src') }),
      expect.objectContaining({ kind: 'file', targetPath: resolve('/workspace', 'src/new.ts') })
    ])
    expect(optionsArg).toMatchObject({ transitionId: expect.any(String) })
  })

  it('waits and retries refresh contention without poisoning the transaction', async () => {
    const h = harness()
    const owner = {
      lockOwnerId: 'refresh-owner',
      runId: 'refresh-run',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }
    const claims = [
      { workspacePath: '/workspace', kind: 'file' as const, targetPath: '/workspace/file.ts' }
    ]
    h.authority.replaceAcquisition
      .mockResolvedValueOnce({
        ok: false,
        reason: 'conflict',
        message: 'another exact edit is finishing'
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        transitionId: 'refresh-after-wait',
        tokens: [],
        leases: [],
        claims: []
      } as never)

    const replacement = h.runtime.replaceClaims(owner, 'acquire', claims)
    setTimeout(() => h.emitAuthoritySnapshot(emptySnapshot()), 0)
    await expect(replacement).resolves.toMatchObject({
      ok: true,
      authority: { transitionId: 'refresh-after-wait' }
    })
    expect(h.authority.replaceAcquisition).toHaveBeenCalledTimes(2)
    expect(h.authority.replaceAcquisition.mock.calls[0]?.[3]?.transitionId).toBe(
      h.authority.replaceAcquisition.mock.calls[1]?.[3]?.transitionId
    )
    expect(h.runtime.getUnhealthyReason()).toBeNull()
  })

  it('cancels a contended refresh without poisoning future mutation admission', async () => {
    const h = harness()
    h.authority.replaceAcquisition.mockResolvedValue({
      ok: false,
      reason: 'conflict',
      message: 'another exact edit is finishing'
    } as never)

    await expect(
      h.runtime.replaceClaims(
        {
          lockOwnerId: 'cancel-owner',
          runId: 'cancel-run',
          pid: 10,
          processBirthIdentity: 'main-birth'
        },
        'acquire',
        [
          {
            workspacePath: '/workspace',
            kind: 'file',
            targetPath: '/workspace/file.ts'
          }
        ],
        () => false
      )
    ).resolves.toMatchObject({ ok: false, code: 'cancelled' })
    expect(h.authority.replaceAcquisition).toHaveBeenCalledOnce()
    expect(h.runtime.getUnhealthyReason()).toBeNull()
  })

  it('normalizes untrusted owner presentation before durable lock admission', async () => {
    const { runtime, authority } = harness()

    const result = await runtime.acquire({
      owner: {
        lockOwnerId: 'run-display',
        runId: 'run-display',
        provider: 'codex',
        displayName: 'Sol\n\0Boss',
        chatTitle: '# 1.9.3 bounded work program\n\n...'
      },
      mutation: {
        workspacePath: '/workspace',
        action: 'write_file',
        args: { path: 'src/new.ts', content: 'x' }
      }
    })

    expect(result).toMatchObject({
      ok: true,
      owner: {
        lockOwnerId: 'run-display',
        runId: 'run-display',
        provider: 'codex',
        displayName: 'Sol Boss',
        chatTitle: '# 1.9.3 bounded work program ...'
      }
    })
    expect(authority.acquireMany).toHaveBeenCalledWith(
      expect.objectContaining({
        lockOwnerId: 'run-display',
        runId: 'run-display',
        displayName: 'Sol Boss',
        chatTitle: '# 1.9.3 bounded work program ...'
      }),
      expect.any(Array),
      expect.any(Object)
    )
  })

  it('atomically acquires and replaces an explicit combined claim set', async () => {
    const { runtime, authority } = harness()
    const claims = [
      {
        workspacePath: '/workspace',
        kind: 'file' as const,
        mode: 'write' as const,
        targetPath: '/workspace/file.ts'
      },
      {
        workspacePath: '/workspace',
        kind: 'file' as const,
        mode: 'write' as const,
        targetPath: '/workspace/other.ts'
      }
    ]

    const acquired = await runtime.acquireClaims(
      { lockOwnerId: 'promotion', runId: 'run-promotion' },
      claims
    )
    expect(acquired.ok).toBe(true)
    expect(authority.acquireMany).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-promotion' }),
      claims,
      { transitionId: expect.any(String) }
    )

    if (!acquired.ok) throw new Error(acquired.message)
    const replaced = await runtime.replaceClaims(acquired.owner, 'acquire', claims.slice(1))
    expect(replaced.ok).toBe(true)
    expect(authority.replaceAcquisition).toHaveBeenCalledWith(
      acquired.owner,
      'acquire',
      claims.slice(1),
      { transitionId: expect.any(String) }
    )
  })

  it('transfers a long-lived acquisition to one exact child incarnation', async () => {
    const { runtime, authority, processIdentity } = harness()
    processIdentity.observe.mockResolvedValueOnce({
      state: 'live',
      processBirthIdentity: 'child-birth'
    } as never)
    const previousOwner = {
      lockOwnerId: 'background:1',
      runId: 'run-background',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }

    const transferred = await runtime.transferAcquisition(previousOwner, 'acquire-1', {
      lockOwnerId: 'background:1',
      runId: 'run-background',
      executionPid: 44
    })

    expect(transferred).toMatchObject({
      ok: true,
      owner: { lifecycle: 'child', pid: 44, processBirthIdentity: 'child-birth' }
    })
    expect(authority.transferAcquisition).toHaveBeenCalledWith(
      previousOwner,
      'acquire-1',
      expect.objectContaining({
        lockOwnerId: 'background:1',
        runId: 'run-background',
        pid: 44,
        processBirthIdentity: 'child-birth'
      }),
      { transitionId: expect.any(String) }
    )
  })

  it('fails closed when an exact owner identity cannot be observed', async () => {
    const { runtime, processIdentity, authority } = harness()
    processIdentity.observe.mockResolvedValueOnce({ state: 'identity_unavailable' } as never)

    const result = await runtime.acquire({
      owner: { lockOwnerId: 'run-1', runId: 'run-1' },
      mutation: {
        workspacePath: '/workspace',
        action: 'write_file',
        args: { path: 'file.txt', content: 'next' }
      }
    })

    expect(result).toMatchObject({ ok: false, code: 'owner_identity_unavailable' })
    expect(authority.acquireMany).not.toHaveBeenCalled()
  })

  it('never broadens an unobservable write surface into a workspace claim', async () => {
    const { runtime, authority } = harness()

    const result = await runtime.acquire({
      owner: { lockOwnerId: 'opaque-run', runId: 'opaque-run', provider: 'pi' },
      mutation: {
        source: 'provider-native',
        provider: 'pi',
        workspacePath: '/workspace',
        action: 'opaque-write'
      },
      coarseWorkspaceFallback: true
    })

    expect(result).toMatchObject({ ok: false, code: 'unmapped_action' })
    expect(authority.acquireMany).not.toHaveBeenCalled()
  })

  it('rejects broad canonical claims again at the mutation-fence boundary', async () => {
    const { runtime, mutationFence } = harness()
    const owner = {
      lockOwnerId: 'exact-owner',
      runId: 'exact-run',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }

    await expect(
      runtime.acquireMutationFence(owner, [
        projectedLease('broad-fence', 'held', '2026-07-29T00:00:00.000Z').claim
      ])
    ).rejects.toThrow(/only exact file\/hunk claims/)
    expect(mutationFence.acquire).not.toHaveBeenCalled()
  })

  it('claims every exact parent entry an external write may create', async () => {
    const { runtime, authority } = harness()
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-external-write-lock-'))
    const workspacePath = join(root, 'workspace')
    const grantedRoot = join(root, 'granted')
    await Promise.all([mkdir(workspacePath), mkdir(grantedRoot)])
    const canonicalGrantedRoot = await realpath(grantedRoot)
    const lexicalTargetPath = join(grantedRoot, 'nested', 'deep', 'granted.txt')
    const targetPath = join(canonicalGrantedRoot, 'nested', 'deep', 'granted.txt')
    const mutation = {
      workspacePath,
      action: 'write_file',
      args: { path: lexicalTargetPath }
    }

    try {
      const result = await runtime.acquire({
        owner: { lockOwnerId: 'external-run', runId: 'external-run', provider: 'codex' },
        mutation,
        externalMutationAuthority: createWorkspaceExternalMutationAuthorityReceipt({
          mutation,
          provider: 'codex',
          runId: 'external-run',
          targetPath,
          grantId: 'grant-1',
          grantSignature: 'a'.repeat(64)
        })
      })
      if (!result.ok) throw new Error(result.message)

      expect(result).toMatchObject({
        ok: true,
        claims: [
          expect.objectContaining({
            kind: 'file',
            targetPath: join(canonicalGrantedRoot, 'nested')
          }),
          expect.objectContaining({
            kind: 'file',
            targetPath: join(canonicalGrantedRoot, 'nested/deep')
          }),
          expect.objectContaining({ kind: 'file', targetPath })
        ]
      })
      expect(authority.acquireMany).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a receipt bound to a different escaped target', async () => {
    const { runtime, authority } = harness()
    const mutation = {
      workspacePath: '/workspace',
      action: 'write_file',
      args: { path: '/outside/actual.txt' }
    }

    const result = await runtime.acquire({
      owner: { lockOwnerId: 'external-run', runId: 'external-run', provider: 'codex' },
      mutation,
      externalMutationAuthority: createWorkspaceExternalMutationAuthorityReceipt({
        mutation,
        provider: 'codex',
        runId: 'external-run',
        targetPath: '/outside/different.txt',
        grantId: 'grant-1',
        grantSignature: 'a'.repeat(64)
      })
    })

    expect(result).toMatchObject({ ok: false, code: 'invalid_claim' })
    expect(authority.acquireMany).not.toHaveBeenCalled()
  })

  it('preserves trailing-space bytes in an exact external target receipt', async () => {
    const { runtime, authority } = harness()
    const targetPath = '/outside/granted.txt '
    const mutation = {
      workspacePath: '/workspace',
      action: 'write_file',
      args: { path: targetPath }
    }

    await expect(
      runtime.acquire({
        owner: { lockOwnerId: 'external-run', runId: 'external-run', provider: 'codex' },
        mutation,
        externalMutationAuthority: createWorkspaceExternalMutationAuthorityReceipt({
          mutation,
          provider: 'codex',
          runId: 'external-run',
          targetPath,
          grantId: 'grant-1',
          grantSignature: 'a'.repeat(64)
        })
      })
    ).resolves.toMatchObject({ ok: true })
    expect(authority.acquireMany).toHaveBeenCalledOnce()
  })

  it('pins external grant ancestors and rejects directory symlink replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-external-lock-'))
    const workspacePath = join(root, 'workspace')
    const grantedPath = join(root, 'granted')
    const attackerPath = join(root, 'attacker')
    await Promise.all([mkdir(workspacePath), mkdir(grantedPath), mkdir(attackerPath)])
    const canonicalGrantedPath = await realpath(grantedPath)
    const lexicalTargetPath = join(grantedPath, 'nested', 'file.txt ')
    const targetPath = join(canonicalGrantedPath, 'nested', 'file.txt ')
    const mutation = {
      workspacePath,
      action: 'write_file',
      args: { path: lexicalTargetPath }
    }
    const runtimeInput = {
      owner: {
        lockOwnerId: 'external-run',
        runId: 'external-run',
        provider: 'codex' as const
      },
      mutation,
      externalMutationAuthority: createWorkspaceExternalMutationAuthorityReceipt({
        mutation,
        provider: 'codex',
        runId: 'external-run',
        targetPath,
        grantId: 'grant-1',
        grantSignature: 'a'.repeat(64)
      })
    }
    const { runtime } = harness()

    try {
      await expect(runtime.revalidateExternalMutationAuthority(runtimeInput)).resolves.toEqual({
        rootPath: canonicalGrantedPath,
        targetPath
      })
      await writeFile(join(attackerPath, 'file.txt '), 'attacker')
      await rename(grantedPath, `${grantedPath}-original`)
      await symlink(attackerPath, grantedPath, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(runtime.revalidateExternalMutationAuthority(runtimeInput)).rejects.toThrow(
        /no longer matches/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never broadens invalid arguments or path escapes through coarse fallback', async () => {
    const { runtime, authority } = harness()

    for (const mutation of [
      { workspacePath: '/workspace', action: 'write_file', args: {} },
      {
        workspacePath: '/workspace',
        action: 'write_file',
        args: { path: '../escape.txt' }
      }
    ]) {
      await expect(
        runtime.acquire({
          owner: { lockOwnerId: 'opaque-run', runId: 'opaque-run', provider: 'pi' },
          mutation,
          coarseWorkspaceFallback: true
        })
      ).resolves.toMatchObject({ ok: false, code: 'invalid_claim' })
    }
    expect(authority.acquireMany).not.toHaveBeenCalled()
  })

  it('replays acquire, replace, and transfer with one stable transition id', async () => {
    const acquireHarness = harness()
    acquireHarness.authority.acquireMany.mockRejectedValueOnce(
      new Error('projection failed after WAL commit')
    )
    await expect(
      acquireHarness.runtime.acquireClaims({ lockOwnerId: 'owner-a', runId: 'run-a' }, [
        { workspacePath: '/workspace', kind: 'file', targetPath: '/workspace/a.ts' }
      ])
    ).resolves.toMatchObject({ ok: true })
    expect(acquireHarness.authority.acquireMany).toHaveBeenCalledTimes(2)
    expect(acquireHarness.authority.acquireMany.mock.calls[0]?.[2]?.transitionId).toBe(
      acquireHarness.authority.acquireMany.mock.calls[1]?.[2]?.transitionId
    )
    expect(acquireHarness.runtime.getUnhealthyReason()).toBeNull()

    const replaceHarness = harness()
    replaceHarness.authority.replaceAcquisition.mockRejectedValueOnce(
      new Error('replacement projection failed after WAL commit')
    )
    const owner = {
      lockOwnerId: 'owner-r',
      runId: 'run-r',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }
    await expect(
      replaceHarness.runtime.replaceClaims(owner, 'acquire-r', [
        { workspacePath: '/workspace', kind: 'file', targetPath: '/workspace/a.ts' }
      ])
    ).resolves.toMatchObject({ ok: true })
    expect(replaceHarness.authority.replaceAcquisition).toHaveBeenCalledTimes(2)
    expect(replaceHarness.authority.replaceAcquisition.mock.calls[0]?.[3]?.transitionId).toBe(
      replaceHarness.authority.replaceAcquisition.mock.calls[1]?.[3]?.transitionId
    )
    expect(replaceHarness.runtime.getUnhealthyReason()).toBeNull()

    const transferHarness = harness()
    transferHarness.processIdentity.observe.mockResolvedValueOnce({
      state: 'live',
      processBirthIdentity: 'child-birth'
    } as never)
    transferHarness.authority.transferAcquisition.mockRejectedValueOnce(
      new Error('transfer projection failed after WAL commit')
    )
    await expect(
      transferHarness.runtime.transferAcquisition(owner, 'acquire-r', {
        lockOwnerId: owner.lockOwnerId,
        runId: owner.runId,
        executionPid: 44
      })
    ).resolves.toMatchObject({ ok: true })
    expect(transferHarness.authority.transferAcquisition).toHaveBeenCalledTimes(2)
    expect(transferHarness.authority.transferAcquisition.mock.calls[0]?.[3]?.transitionId).toBe(
      transferHarness.authority.transferAcquisition.mock.calls[1]?.[3]?.transitionId
    )
    expect(transferHarness.runtime.getUnhealthyReason()).toBeNull()
  })

  it('poisons future mutation admission after a fence or exact-release failure', async () => {
    const fenceHarness = harness()
    fenceHarness.mutationFence.release.mockReturnValue(false)
    expect(() =>
      fenceHarness.runtime.releaseMutationFence({
        owners: [
          {
            lockOwnerId: 'owner',
            runId: 'run',
            pid: 10,
            processBirthIdentity: 'main-birth',
            partitionKey: 'file:a',
            fenceId: 'fence',
            acquiredAt: '2026-07-29T00:00:00.000Z'
          }
        ]
      })
    ).toThrow(/not owned/)
    await expect(
      fenceHarness.runtime.acquireClaims({ lockOwnerId: 'next', runId: 'next' }, [
        { workspacePath: '/workspace', kind: 'file', targetPath: '/workspace/next.ts' }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'runtime_unavailable' })

    const releaseHarness = harness()
    releaseHarness.authority.releaseAcquisition.mockResolvedValue({
      ok: false,
      reason: 'authority_busy',
      message: 'busy'
    } as never)
    await expect(
      releaseHarness.runtime.releaseAcquisition('run', 'transition')
    ).resolves.toMatchObject({ ok: false, reason: 'authority_busy' })
    expect(releaseHarness.runtime.getUnhealthyReason()).toMatch(/busy/)
  })

  it('poisons admission when a partial fence acquisition cannot clean up its ownership', async () => {
    const h = harness()
    const owner = {
      lockOwnerId: 'partial-owner',
      runId: 'partial-run',
      pid: 10,
      processBirthIdentity: 'main-birth'
    }
    h.mutationFence.acquire
      .mockResolvedValueOnce({
        ...owner,
        partitionKey: 'first-partition',
        fenceId: 'first-fence',
        acquiredAt: '2026-07-29T00:00:00.000Z'
      })
      .mockRejectedValueOnce(new Error('second partition acquisition failed'))
    h.mutationFence.release.mockReturnValue(false)
    const firstClaim = {
      ...projectedLease('first-exact', 'held', '2026-07-29T00:00:00.000Z').claim,
      kind: 'file' as const,
      targetCanonicalPath: '/workspace/a.ts',
      comparisonTargetPath: '/workspace/a.ts',
      physicalTargetIdentity: '/workspace/a.ts'
    }
    const secondClaim = {
      ...projectedLease('second-exact', 'held', '2026-07-29T00:00:00.000Z').claim,
      kind: 'file' as const,
      targetCanonicalPath: '/workspace/b.ts',
      comparisonTargetPath: '/workspace/b.ts',
      physicalTargetIdentity: '/workspace/b.ts'
    }

    await expect(h.runtime.acquireMutationFence(owner, [firstClaim, secondClaim])).rejects.toThrow(
      /partial partition cleanup failed/
    )
    expect(h.mutationFence.release).toHaveBeenCalledOnce()
    expect(h.runtime.getUnhealthyReason()).toMatch(/partial partition cleanup failed/)
    await expect(
      h.runtime.acquireClaims({ lockOwnerId: 'next', runId: 'next' }, [
        { workspacePath: '/workspace', kind: 'file', targetPath: '/workspace/next.ts' }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'runtime_unavailable' })
  })

  it('retries transient authority contention before poisoning release health', async () => {
    const { runtime, authority } = harness()
    authority.releaseAcquisition
      .mockResolvedValueOnce({
        ok: false,
        reason: 'authority_busy',
        message: 'busy'
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        transitionId: 'release-after-retry',
        released: []
      } as never)

    await expect(runtime.releaseAcquisition('run', 'transition')).resolves.toMatchObject({
      ok: true,
      transitionId: 'release-after-retry'
    })
    expect(authority.releaseAcquisition).toHaveBeenCalledTimes(2)
    expect(runtime.getUnhealthyReason()).toBeNull()
  })

  it('reconciles an exact child quarantine without poisoning healthy admission', async () => {
    const { runtime, authority } = harness()
    authority.quarantineChildOwnerAcquisitions
      .mockRejectedValueOnce(new Error('marker projection failed after quarantine commit'))
      .mockResolvedValueOnce({
        transitionId: 'quarantine-after-retry',
        decisions: []
      })

    const childOwner = {
      lockOwnerId: 'owner-child',
      runId: 'run-child',
      lifecycle: 'child' as const,
      pid: 44,
      processBirthIdentity: 'birth-44'
    }
    await expect(runtime.quarantineChildOwnerAcquisitions(childOwner)).resolves.toBe(undefined)
    expect(authority.quarantineChildOwnerAcquisitions).toHaveBeenCalledTimes(2)
    expect(authority.quarantineChildOwnerAcquisitions).toHaveBeenCalledWith(childOwner)
    expect(runtime.getUnhealthyReason()).toBeNull()
  })

  it('reconciles post-commit release failures with stable transition ids', async () => {
    const acquisitionHarness = harness()
    acquisitionHarness.authority.releaseAcquisition.mockRejectedValueOnce(
      new Error('marker unlink failed after release commit')
    )
    await expect(
      acquisitionHarness.runtime.releaseAcquisition('run', 'acquired-transition')
    ).resolves.toMatchObject({ ok: true })
    expect(acquisitionHarness.authority.releaseAcquisition).toHaveBeenCalledTimes(2)
    expect(acquisitionHarness.authority.releaseAcquisition.mock.calls[0]?.[2]?.transitionId).toBe(
      acquisitionHarness.authority.releaseAcquisition.mock.calls[1]?.[2]?.transitionId
    )
    expect(acquisitionHarness.runtime.getUnhealthyReason()).toBeNull()

    const runHarness = harness()
    runHarness.authority.releaseAllForRun.mockRejectedValueOnce(
      new Error('marker reconciliation failed after terminal commit')
    )
    await expect(runHarness.runtime.releaseRun('run')).resolves.toMatchObject({ ok: true })
    expect(runHarness.authority.releaseAllForRun).toHaveBeenCalledTimes(2)
    expect(runHarness.authority.releaseAllForRun.mock.calls[0]?.[1]?.transitionId).toBe(
      runHarness.authority.releaseAllForRun.mock.calls[1]?.[1]?.transitionId
    )
    expect(runHarness.runtime.getUnhealthyReason()).toBeNull()
  })

  it('counts only durable active leases owned by the exact recovered run', () => {
    const { runtime, authority } = harness()
    const first = projectedLease('first', 'recovery_blocked', '2026-07-29T00:00:00.000Z')
    const second = projectedLease('second', 'held', '2026-07-29T00:00:01.000Z')
    const foreign = projectedLease('foreign', 'held', '2026-07-29T00:00:02.000Z')
    const recovered = projectedLease('recovered', 'recovered', '2026-07-29T00:00:03.000Z')
    first.owner.runId = 'run-recovery'
    second.owner.runId = 'run-recovery'
    recovered.owner.runId = 'run-recovery'
    authority.snapshot.mockReturnValue({
      ...emptySnapshot(),
      leases: [first, foreign, second, recovered]
    })

    expect(runtime.activeLeaseCountForRun('run-recovery')).toBe(2)
    expect(runtime.activeLeaseCountForRun('run-foreign')).toBe(1)
    expect(runtime.activeLeaseCountForRun('   ')).toBe(0)
  })

  it('clears only the matching unresolved-operation poison after exact run quiescence', () => {
    const { runtime } = harness()
    const reason =
      'Workspace-lock mutation admission is fail-closed: Workspace-lock operation run-leaked:7 did not settle before its terminal deadline.'
    runtime.markUnhealthy(reason)

    expect(
      runtime.reconcileUnresolvedRunOperation({
        runId: 'run-leaked',
        expectedUnhealthyReason: reason,
        processTreeStopped: true
      })
    ).toEqual({ ok: true, runId: 'run-leaked', clearedReason: reason })
    expect(runtime.getUnhealthyReason()).toBeNull()
  })

  it('retains fail-closed health without process death, zero leases, and an exact reason', () => {
    const reason = 'Workspace-lock mutation admission is fail-closed: leaked operation'

    const liveProcess = harness()
    liveProcess.runtime.markUnhealthy(reason)
    expect(
      liveProcess.runtime.reconcileUnresolvedRunOperation({
        runId: 'run-leaked',
        expectedUnhealthyReason: reason,
        processTreeStopped: false
      })
    ).toMatchObject({ ok: false, reason: 'process_tree_live' })
    expect(liveProcess.runtime.getUnhealthyReason()).toBe(reason)

    const leased = harness()
    const active = projectedLease('active-leak', 'held', '2026-07-29T00:00:00.000Z')
    active.owner.runId = 'run-leaked'
    leased.authority.snapshot.mockReturnValue({ ...emptySnapshot(), leases: [active] })
    leased.runtime.markUnhealthy(reason)
    expect(
      leased.runtime.reconcileUnresolvedRunOperation({
        runId: 'run-leaked',
        expectedUnhealthyReason: reason,
        processTreeStopped: true
      })
    ).toMatchObject({ ok: false, reason: 'active_leases', activeLeaseCount: 1 })
    expect(leased.runtime.getUnhealthyReason()).toBe(reason)

    const mismatch = harness()
    mismatch.runtime.markUnhealthy(reason)
    expect(
      mismatch.runtime.reconcileUnresolvedRunOperation({
        runId: 'run-leaked',
        expectedUnhealthyReason: `${reason} changed`,
        processTreeStopped: true
      })
    ).toMatchObject({ ok: false, reason: 'reason_mismatch' })
    expect(mismatch.runtime.getUnhealthyReason()).toBe(reason)
  })

  it('bounds recovered projection history while preserving every active lease', () => {
    const { runtime, authority } = harness()
    const now = Date.now()
    const active = projectedLease('active', 'held', new Date(now - 60_000).toISOString())
    const recentRecovered = Array.from({ length: 25 }, (_, index) =>
      projectedLease(`recent-${index}`, 'recovered', new Date(now - index * 1_000).toISOString())
    )
    const oldRecovered = projectedLease(
      'old',
      'recovered',
      new Date(now - 16 * 60_000).toISOString()
    )
    authority.snapshot.mockReturnValueOnce({
      ...emptySnapshot(),
      leases: [oldRecovered, ...recentRecovered, active]
    })

    const projected = runtime.list()

    expect(projected.locks).toHaveLength(21)
    expect(projected.locks.some((lock) => lock.lockId === 'active')).toBe(true)
    expect(projected.locks.some((lock) => lock.lockId === 'old')).toBe(false)
    expect(projected.locks.filter((lock) => lock.status === 'recovered')).toHaveLength(20)
  })
})

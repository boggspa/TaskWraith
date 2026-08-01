import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type {
  WorkspaceLockRuntimeAcquireResult,
  WorkspaceLockRuntimeOwnerInput
} from '../WorkspaceLockRuntime'
import type {
  WorkspaceLockClaimRequest,
  WorkspaceLockMutationVerificationResult,
  WorkspaceLockOwner,
  WorkspaceLockReleaseResult
} from '../workLocks/WorkspaceLockTypes'
import {
  DurableFanoutCandidatePromotionLock,
  type FanoutCandidatePromotionLockRuntime
} from './FanoutCandidatePromotionLock'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  ''
].join('\n')

function ownerFor(input: WorkspaceLockRuntimeOwnerInput): WorkspaceLockOwner {
  return {
    ...input,
    pid: 41,
    processBirthIdentity: 'main-birth'
  }
}

function acquired(
  input: WorkspaceLockRuntimeOwnerInput,
  claims: readonly WorkspaceLockClaimRequest[],
  transitionId: string
): Extract<WorkspaceLockRuntimeAcquireResult, { ok: true }> {
  return {
    ok: true,
    owner: ownerFor(input),
    claims: [...claims],
    authority: { ok: true, transitionId, tokens: [], leases: [] }
  }
}

function released(transitionId: string): WorkspaceLockReleaseResult {
  return { ok: true, transitionId, released: [] }
}

function capability(
  transitionId: string,
  kind: 'workspace' | 'file',
  executableTargetPath: string,
  index: number
): Extract<WorkspaceLockMutationVerificationResult, { ok: true }>['capabilities'][number] {
  return {
    token: {
      leaseId: `lease-${index}`,
      acquiredTransitionId: transitionId,
      authorityInstanceId: 'authority',
      authorityGeneration: 1,
      ownerRunId: 'run'
    },
    leaseId: `lease-${index}`,
    kind,
    executableTargetPath,
    verifiedPathEvidence: {
      requestedRootPath: '/base',
      requestedTargetPath: executableTargetPath,
      lexicalRootPath: '/base',
      lexicalTargetPath: executableTargetPath,
      pathFlavor: 'posix',
      caseSensitive: true,
      targetExists: true,
      canonicalPath: executableTargetPath,
      comparisonPath: executableTargetPath,
      physicalIdentity: `object-${index}`,
      targetIdentity: {
        kind: 'existing',
        file: {
          device: '1',
          inode: String(index + 1),
          key: `object-${index}`
        },
        key: `object-${index}`
      },
      containment: {
        canonicalRootPath: '/canonical/base',
        canonicalTargetPath: executableTargetPath,
        comparisonRootPath: '/canonical/base',
        comparisonTargetPath: executableTargetPath,
        relativeTargetPath:
          executableTargetPath === '/canonical/base'
            ? '.'
            : executableTargetPath.slice('/canonical/base/'.length),
        rootIdentity: {
          device: '1',
          inode: '1',
          key: 'root-object'
        },
        existingAncestorCanonicalPath: executableTargetPath,
        existingAncestorIdentity: {
          device: '1',
          inode: String(index + 1),
          key: `object-${index}`
        }
      }
    }
  }
}

function verified(transitionId: string): WorkspaceLockMutationVerificationResult {
  return {
    ok: true,
    acquiredTransitionId: transitionId,
    capabilities: [
      capability(transitionId, 'workspace', '/canonical/base', 1),
      capability(transitionId, 'file', '/canonical/base/src/a.ts', 2)
    ]
  }
}

function harness() {
  const events: string[] = []
  const runtime: FanoutCandidatePromotionLockRuntime = {
    acquireClaims: vi.fn(async (owner, claims) => {
      events.push(`acquire:${claims.map((claim) => claim.kind).join(',')}`)
      return acquired(owner, claims, 'acquire')
    }),
    replaceClaims: vi.fn(async (owner, previous, claims) => {
      events.push(`replace:${previous}:${claims.map((claim) => claim.kind).join(',')}`)
      return acquired(owner, claims, 'refresh')
    }),
    verifyAcquisitionForMutation: vi.fn(async (_owner, transitionId) => {
      events.push(`verify:${transitionId}`)
      return verified(transitionId)
    }),
    acquireMutationFence: vi.fn(async (owner) => {
      events.push(`fence:acquire:${owner.runId}`)
      return {
        lockOwnerId: owner.lockOwnerId,
        runId: owner.runId,
        pid: owner.pid,
        processBirthIdentity: owner.processBirthIdentity,
        fenceId: 'fence',
        acquiredAt: 'T1'
      }
    }),
    releaseMutationFence: vi.fn((fence) => {
      events.push(`fence:release:${fence.runId}`)
    }),
    releaseAcquisition: vi.fn(async (_runId, transitionId) => {
      events.push(`release:${transitionId}`)
      return released(`release-${transitionId}`)
    })
  }
  return { runtime, events }
}

describe('DurableFanoutCandidatePromotionLock', () => {
  it('atomically claims the base and whole patch files, refreshes under the fence, and verifies execution capabilities', async () => {
    const { runtime, events } = harness()
    const lock = new DurableFanoutCandidatePromotionLock({
      runtime,
      nextOperationId: () => 'operation-1'
    })
    const operation = vi.fn(async (execution) => {
      events.push('apply')
      return execution
    })

    const result = await lock.withPromotionLock(
      {
        chatId: 'chat-a',
        candidateId: 'candidate-a',
        baseWorkspacePath: '/base',
        patch: PATCH
      },
      operation
    )

    expect(result).toEqual({
      value: {
        baseWorkspacePath: '/canonical/base',
        targetPaths: ['/canonical/base/src/a.ts']
      }
    })
    const firstClaims = vi.mocked(runtime.acquireClaims).mock.calls[0][1]
    expect(firstClaims).toEqual([
      expect.objectContaining({ kind: 'workspace', worktreePath: resolve('/base') }),
      expect.objectContaining({ kind: 'file', targetPath: resolve('/base', 'src/a.ts') })
    ])
    expect(firstClaims.some((claim) => claim.kind === 'hunk')).toBe(false)
    expect(vi.mocked(runtime.acquireClaims).mock.calls[0][0]).toMatchObject({
      lockOwnerId: 'fanout-candidate-promotion-owner:operation-1',
      runId: 'fanout-candidate-promotion:operation-1',
      chatId: 'chat-a'
    })
    expect(events).toEqual([
      'acquire:workspace,file',
      'fence:acquire:fanout-candidate-promotion:operation-1',
      'replace:acquire:workspace,file',
      'verify:refresh',
      'apply',
      'fence:release:fanout-candidate-promotion:operation-1',
      'release:refresh'
    ])
  })

  it('releases the exact refreshed acquisition and fence when execution fails', async () => {
    const { runtime, events } = harness()
    const lock = new DurableFanoutCandidatePromotionLock({
      runtime,
      nextOperationId: () => 'operation-failure'
    })

    await expect(
      lock.withPromotionLock(
        {
          chatId: 'chat-a',
          candidateId: 'candidate-a',
          baseWorkspacePath: '/base',
          patch: PATCH
        },
        async () => {
          throw new Error('git apply failed')
        }
      )
    ).rejects.toThrow('git apply failed')

    expect(events.slice(-2)).toEqual([
      'fence:release:fanout-candidate-promotion:operation-failure',
      'release:refresh'
    ])
  })

  it('preserves a committed result and queues exact cleanup retry on authority failure', async () => {
    const { runtime } = harness()
    vi.mocked(runtime.releaseAcquisition)
      .mockResolvedValueOnce({
        ok: false,
        reason: 'authority_busy',
        message: 'transition busy'
      })
      .mockResolvedValueOnce(released('retry-release'))
    const queued: Array<() => void> = []
    const lock = new DurableFanoutCandidatePromotionLock({
      runtime,
      nextOperationId: () => 'operation-cleanup',
      scheduleCleanupRetry: (operation) => queued.push(operation),
      cleanupRetryDelaysMs: [1]
    })

    const result = await lock.withPromotionLock(
      {
        chatId: 'chat-a',
        candidateId: 'candidate-a',
        baseWorkspacePath: '/base',
        patch: PATCH
      },
      async () => 'committed'
    )

    expect(result).toEqual({
      value: 'committed',
      cleanupError: expect.stringContaining('cleanup is retrying')
    })
    expect(queued).toHaveLength(1)
    queued[0]()
    await vi.waitFor(() => expect(runtime.releaseAcquisition).toHaveBeenCalledTimes(2))
    expect(runtime.releaseAcquisition).toHaveBeenLastCalledWith(
      'fanout-candidate-promotion:operation-cleanup',
      'refresh'
    )
  })

  it('fails closed before execution when a refreshed target cannot be verified', async () => {
    const { runtime } = harness()
    vi.mocked(runtime.verifyAcquisitionForMutation).mockResolvedValue({
      ok: false,
      reason: 'path_changed',
      message: 'src/a.ts was replaced'
    })
    const lock = new DurableFanoutCandidatePromotionLock({
      runtime,
      nextOperationId: () => 'operation-drift'
    })
    const operation = vi.fn()

    await expect(
      lock.withPromotionLock(
        {
          chatId: 'chat-a',
          candidateId: 'candidate-a',
          baseWorkspacePath: '/base',
          patch: PATCH
        },
        operation
      )
    ).rejects.toMatchObject({
      name: 'FanoutCandidatePromotionLockError',
      code: 'verification-failed'
    })
    expect(operation).not.toHaveBeenCalled()
    expect(runtime.releaseAcquisition).toHaveBeenCalledOnce()
  })

  it('contends across chats on one base while a different linked worktree remains independent', async () => {
    const heldDomains = new Map<string, string>()
    const ownerDomains = new Map<string, string>()
    const runtime: FanoutCandidatePromotionLockRuntime = {
      acquireClaims: vi.fn(async (ownerInput, claims) => {
        const owner = ownerFor(ownerInput)
        const domain = claims[0].worktreePath || claims[0].workspacePath
        const holder = heldDomains.get(domain)
        if (holder && holder !== owner.runId) {
          const conflict: Extract<WorkspaceLockRuntimeAcquireResult, { ok: false }> = {
            ok: false,
            code: 'conflict',
            message: `held by ${holder}`,
            authority: {
              ok: false,
              reason: 'conflict',
              message: `held by ${holder}`
            }
          }
          return conflict
        }
        heldDomains.set(domain, owner.runId)
        ownerDomains.set(owner.runId, domain)
        return acquired(ownerInput, claims, `acquire:${domain}`)
      }),
      replaceClaims: vi.fn(async (owner, _previous, claims) =>
        acquired(owner, claims, `refresh:${ownerDomains.get(owner.runId)}`)
      ),
      verifyAcquisitionForMutation: vi.fn(async (_owner, transitionId) => {
        const domain = transitionId.slice('refresh:'.length)
        return {
          ok: true as const,
          acquiredTransitionId: transitionId,
          capabilities: [capability(transitionId, 'workspace', domain, 1)]
        }
      }),
      acquireMutationFence: vi.fn(async (owner) => ({
        lockOwnerId: owner.lockOwnerId,
        runId: owner.runId,
        pid: owner.pid,
        processBirthIdentity: owner.processBirthIdentity,
        fenceId: `fence:${owner.runId}`,
        acquiredAt: 'T1'
      })),
      releaseMutationFence: vi.fn(),
      releaseAcquisition: vi.fn(async (runId, transitionId) => {
        const domain = ownerDomains.get(runId)
        if (domain && heldDomains.get(domain) === runId) heldDomains.delete(domain)
        return released(`release:${transitionId}`)
      })
    }
    let sequence = 0
    const makeLock = () =>
      new DurableFanoutCandidatePromotionLock({
        runtime,
        nextOperationId: () => `operation-${++sequence}`
      })
    let releaseBase: (() => void) | undefined
    let releaseOther: (() => void) | undefined
    const holdBase = new Promise<void>((resolve) => {
      releaseBase = resolve
    })
    const holdOther = new Promise<void>((resolve) => {
      releaseOther = resolve
    })
    const baseEntered = vi.fn()
    const otherEntered = vi.fn()

    const first = makeLock().withPromotionLock(
      {
        chatId: 'chat-a',
        candidateId: 'candidate-a',
        baseWorkspacePath: '/base',
        patch: PATCH
      },
      async () => {
        baseEntered()
        await holdBase
      }
    )
    await vi.waitFor(() => expect(baseEntered).toHaveBeenCalledOnce())

    await expect(
      makeLock().withPromotionLock(
        {
          chatId: 'chat-b',
          candidateId: 'candidate-b',
          baseWorkspacePath: '/base',
          patch: PATCH
        },
        vi.fn()
      )
    ).rejects.toMatchObject({ code: 'lock-conflict' })

    const isolated = makeLock().withPromotionLock(
      {
        chatId: 'chat-c',
        candidateId: 'candidate-c',
        baseWorkspacePath: '/linked-worktree',
        patch: PATCH
      },
      async () => {
        otherEntered()
        await holdOther
      }
    )
    await vi.waitFor(() => expect(otherEntered).toHaveBeenCalledOnce())

    releaseOther?.()
    releaseBase?.()
    await Promise.all([first, isolated])
    expect(heldDomains.size).toBe(0)
  })
})
